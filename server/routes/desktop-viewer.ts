// Only the RFB WebSocket crosses the container boundary: container-controlled JavaScript on the app's origin would reach the person's workspace.
import { createHash, randomBytes } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isSameOrigin, type RequestAuth } from "../request-auth.ts";
import { isMobileOrigin, mobileBearer } from "../mobile/request.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { joinViewer, openDesktop, readFrame, writeFrame } from "./rfb-handshake.ts";
import { createUpgrades, type Upgrades } from "./upgrades.ts";
import { isScreenFallbackReason, SCREEN_DIRECT_CONNECT_MS } from "../../shared/screen-direct.ts";
import { bridgeScreen, DirectRefused, type ScreenChannel, type ScreenDirect } from "../screen-direct.ts";

const ROUTE = /^\/api\/desktop-viewer\/(local\/(?:shared|bot-[a-f0-9]{64}|pool-\d+)|vps\/[\w-]+)(\/websockify|\/direct)?$/;
/** How screens connected, direct or over the relay, as counters (server/screen-direct.ts). */
const TRANSPORT = "/api/desktop-viewer/transport";
/** The RFB opening a viewer sends that the server already gave the desktop: version, security choice, ClientInit. */
const VIEWER_OPENING = 12 + 1 + 1;
const HANDSHAKE_MS = 10_000;
const RECHECK_MS = 5_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** a person's input on a screen counts at most this often; an open screen is a presence hint this often */
const INPUT_NOTE_MS = 15_000, WATCH_NOTE_MS = 60_000;

/** Whether the viewer's bytes (whole RFB client messages, as the app sends them) hold a key or pointer event: a person
 * using the screen. Update requests, encodings and pixel formats alone are a screen being watched; anything that does
 * not parse as client messages is not counted. */
export function rfbInput(bytes: Buffer): boolean {
  let at = 0;
  while (at < bytes.length) {
    const type = bytes[at]!;
    if (type === 4 || type === 5) return at + (type === 4 ? 8 : 6) <= bytes.length;
    const size = type === 0 ? 20 : type === 3 ? 10 : type === 2 && at + 4 <= bytes.length ? 4 + 4 * bytes.readUInt16BE(at + 2)
      : type === 6 && at + 8 <= bytes.length ? 8 + bytes.readUInt32BE(at + 4) : 0;
    if (!size) return false;
    at += size;
  }
  return false;
}

/** A screen's presence for a Cloud home's power (server/cloud-power.ts): input is someone using it, an open screen a hint. */
function screenPresence(presence: { input(): void; watching(): void } | undefined, now: () => number = Date.now) {
  let inputAt = -Infinity, watchAt = -Infinity;
  return {
    bytes(bytes: Buffer) {
      if (!presence || now() - inputAt < INPUT_NOTE_MS || !rfbInput(bytes)) return;
      inputAt = now(); presence.input();
    },
    tick() {
      if (!presence || now() - watchAt < WATCH_NOTE_MS) return;
      watchAt = now(); presence.watching();
    },
  };
}

/** Reads a viewer's masked WebSocket frames off its socket, alongside the pipe, for `screenPresence`. */
function watchFrames(socket: Duplex, head: Buffer, onPayload: (payload: Buffer) => void) {
  let raw: Buffer = Buffer.from(head);
  socket.on("data", (chunk: Buffer) => {
    raw = raw.length ? Buffer.concat([raw, chunk]) : chunk;
    try {
      for (let next; (next = readFrame(raw));) { raw = raw.subarray(next.size); if (next.frame.opcode < 8 && next.frame.payload.length) onPayload(next.frame.payload); }
    } catch { raw = Buffer.alloc(0); }
    if (raw.length > 1024 * 1024) raw = Buffer.alloc(0);
  });
}
/** A desktop that just woke answers its viewer port a moment after the container runs: dial again until it does. */
const REDIAL_MS = 100;
const BOT_ID = /^[\w-]+$/;
const CONTROL_LEASE = /^[A-Za-z0-9_-]{16,120}$/;

/** Providers resolve a managed loopback endpoint, never a browser-supplied URL. */
export interface DesktopConnection {
  port: number;
  password: string | null;
  live?: () => boolean;
  touch?: () => void;
  /** Acquired only by WebSockets; release must not close other viewers. */
  retain?: () => () => void;
}
export interface DesktopTarget {
  key: string;
  resolve: () => Promise<DesktopConnection>;
}

export function desktopViewerUrl(target: string, threadId?: string): string {
  const params = new URLSearchParams({ target, ...(threadId ? { threadId } : {}) });
  return `/desktop-viewer#${params}`;
}

interface Viewer { socket?: Socket; ended?: () => boolean; close: () => void; owner?: string; botId?: string; valid?: () => boolean }
const viewerEnded = (viewer: Viewer) => viewer.socket?.destroyed ?? viewer.ended?.() ?? false;

interface Dialled { remote: Duplex; head: Buffer; opening?: Buffer[]; rest?: { payload: Buffer; raw: Buffer } }

/**
 * Dials the desktop's websockify on its loopback port until it answers (a desktop that just woke answers a moment
 * after its container runs) and, with `serverHandshake`, answers the desktop's VNC handshake. `ok` is asked before
 * every redial and before handing the connection over. Fixed host and path, port from an inspected managed container:
 * never forwards cookies, bearer tokens, query parameters or forwarded headers.
 */
function dialDesktop(connection: DesktopConnection, serverHandshake: boolean, ok: () => boolean, viewerKey?: string): { opened: Promise<Dialled>; cancel: () => void } {
  let upstream: ReturnType<typeof request> | undefined;
  let redial: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveOpened!: (value: Dialled) => void, rejectOpened!: (error: Error) => void;
  const opened = new Promise<Dialled>((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject; });
  opened.catch(() => {});
  const fail = (final = false) => {
    if (settled) return;
    upstream?.destroy();
    if (!final && ok()) { redial = setTimeout(dial, REDIAL_MS); return; }
    settled = true;
    rejectOpened(new Error("Could not connect to the desktop viewer"));
  };
  const done = (value: Dialled) => {
    if (settled || !ok()) { value.remote.destroy(); fail(true); return; }
    settled = true;
    resolveOpened(value);
  };
  const dial = () => {
    if (settled) return;
    const upstreamKey = serverHandshake || !viewerKey ? randomBytes(16).toString("base64") : viewerKey;
    const next = request({
      hostname: "127.0.0.1", port: connection.port, path: "/websockify",
      headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": upstreamKey, "Sec-WebSocket-Version": "13" },
    });
    upstream = next;
    next.once("error", () => { if (upstream === next) fail(); });
    next.once("response", (answer) => { answer.resume(); if (upstream === next) fail(true); });
    next.once("upgrade", (answer, remote, remoteHead) => {
      const expected = createHash("sha1").update(upstreamKey + WS_GUID).digest("base64");
      if (upstream !== next || settled || !ok() || answer.headers["sec-websocket-accept"] !== expected
        || answer.headers.upgrade?.toLowerCase() !== "websocket") {
        remote.destroy(); fail(true); return;
      }
      if ("setNoDelay" in remote && typeof remote.setNoDelay === "function") remote.setNoDelay(true);
      if (!serverHandshake) { done({ remote, head: remoteHead }); return; }
      const lost = () => fail(true);
      remote.once("error", lost);
      openDesktop(remote, remoteHead, connection.password).then(({ opening, rest }) => {
        remote.off("error", lost);
        done({ remote, head: Buffer.alloc(0), opening, rest });
      }, () => { remote.destroy(); fail(); });
    });
    next.end();
  };
  dial();
  return {
    opened,
    cancel: () => {
      clearTimeout(redial);
      if (settled) return;
      settled = true;
      upstream?.destroy();
      rejectOpened(new Error("cancelled"));
    },
  };
}

export function createDesktopViewer(deps: {
  target: (id: string, threadId?: string) => DesktopTarget | undefined;
  live: (auth: RequestAuth) => boolean;
  /** Binds a viewer to a control lease: answers only while `controlLeaseId` holds `botId`'s computer and the target is
   * that computer. Shared and pool targets are refused: a bot hold cannot reserve their desktop. */
  lease?: (id: string, botId: string, controlLeaseId: string, threadId?: string) => (() => boolean) | undefined;
  /** The server's shared upgrade gate; a viewer made without one keeps its own. */
  upgrades?: Upgrades;
  /** The direct screen path (WebRTC); without it every screen rides the relay and `/direct` says so. */
  direct?: ScreenDirect;
  /** A Cloud home's power: a person's key or pointer input on any screen path (relay or direct) is someone using the
   * home; an open screen is a hint like the app's focus. */
  presence?: { input(): void; watching(): void };
}) {
  const upgrades = deps.upgrades ?? createUpgrades();
  const ownGate = deps.upgrades === undefined;
  upgrades.route((path) => ROUTE.exec(path)?.[2] === "/websockify");
  const viewers = new Map<IncomingMessage, Viewer>();
  let stopped = false;

  const route: RouteHandler = async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path === TRANSPORT) {
      res.setHeader("cache-control", "private, no-store");
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!auth.scopes.includes("admin")) return json(res, 403, { error: "forbidden" });
      return json(res, 200, deps.direct?.stats() ?? { available: false });
    }
    const match = ROUTE.exec(path);
    if (!match) return PASS;
    res.setHeader("cache-control", "private, no-store");
    const direct = match[2] === "/direct";
    if (method !== (direct ? "POST" : "GET")) return json(res, 405, { error: "method not allowed" });
    if (!auth.scopes.includes("admin") || (isMobileOrigin(req.headers.origin) ? !mobileBearer(req, auth) : !isSameOrigin(req))) return json(res, 403, { error: "forbidden" });
    // A lease-bound viewer: both names or neither, holding before anything is inspected, rechecked on every liveness pass.
    const botId = url.searchParams.get("botId");
    const controlLeaseId = url.searchParams.get("controlLeaseId");
    const threadId = url.searchParams.get("threadId") ?? undefined;
    if ((botId === null) !== (controlLeaseId === null)) {
      return json(res, 400, { error: "botId and controlLeaseId go together" });
    }
    if ((threadId !== undefined && !BOT_ID.test(threadId)) ||
        (botId !== null && (!BOT_ID.test(botId) || !CONTROL_LEASE.test(controlLeaseId!) || !deps.lease))) {
      return json(res, 400, { error: "botId, threadId or controlLeaseId is not valid" });
    }
    if (botId === null && threadId !== undefined && !match[1].startsWith("vps/")) return json(res, 400, { error: "threadId needs botId and controlLeaseId" });
    // A saved or constructed socket URL must not bypass the join refusal: a bot's lease does not exclude other users of a shared desktop.
    if (botId !== null && (match[1] === "local/shared" || match[1].startsWith("local/pool-"))) {
      return json(res, 409, { error: "Phone control requires a per-bot Local VM. Select per-bot mode in Settings → Computers." });
    }
    // the direct path answers only where it can: a server with the native module, for a viewer on another machine
    if (direct && (!deps.direct?.available() || stopped)) return json(res, 503, { error: "direct path is off", reason: "server-off" });
    if (direct && auth.kind === "loopback") return json(res, 409, { error: "direct path is for another machine", reason: "unsupported" });
    let offer: unknown;
    if (direct) {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "send the offer as JSON" });
      try { offer = await readBody(req, 128 * 1024); }
      catch { return json(res, 400, { error: "not a screen offer" }); }
    }
    const bound = botId === null ? undefined : deps.lease!(match[1], botId, controlLeaseId!, threadId);
    if (botId !== null && !bound) return json(res, 409, { error: "Take control of this computer first" });
    const holds = () => bound?.() ?? true;
    const target = deps.target(match[1], threadId);
    if (!target) return json(res, 404, { error: "Desktop not found" });
    let connection: DesktopConnection;
    const live = () => {
      try { return deps.live(auth) && deps.target(match[1], threadId)?.key === target.key && (connection?.live?.() ?? true); }
      catch { return false; }
    };
    const pending = upgrades.pending(req);
    if (pending && stopped) { pending.socket.destroy(); return; }
    let upgrade: Viewer | undefined;
    const register = (viewer: Viewer, key: IncomingMessage) => {
      if (auth.kind === "session") viewer.owner = auth.session.id;
      if (botId !== null) viewer.botId = botId;
      else if (match[1].startsWith("vps/")) viewer.botId = match[1].slice(4);
      viewers.set(key, viewer);
    };
    if (pending) {
      const viewer: Viewer = { socket: pending.socket, close: () => pending.socket.destroy(), valid: () => live() && holds() };
      register(viewer, req);
      pending.socket.once("close", () => viewers.delete(req));
      upgrade = viewer;
    }
    try { connection = await target.resolve(); }
    catch (error) {
      const status = error && typeof error === "object" && "status" in error ? error.status : 502;
      return json(res, typeof status === "number" && status >= 400 && status < 600 ? status : 502,
        { error: "The desktop is not available. Open it again from Metal." });
    }
    // Inspection may outlive a closed tab or the handshake deadline.
    if (res.destroyed || upgrade?.socket?.destroyed) return;
    if (!live()) return json(res, 401, { error: "Viewer access expired" });
    if (!holds()) return json(res, 409, { error: "Take control of this computer first" });
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) {
      return json(res, 409, { error: "The desktop viewer is not available." });
    }
    if (!match[2]) return json(res, 200, { password: connection.password });
    // the viewer may ask the server to answer the desktop's handshake (see rfb-handshake.ts): VPS desktops only
    const serverHandshake = url.searchParams.get("rfb") === "server" && match[1].startsWith("vps/");
    if (direct) return answerDirect(deps.direct!, offer, connection, serverHandshake, () => live() && holds(), register, req, res, json);
    if (!upgrade || !pending) return json(res, 426, { error: "WebSocket upgrade required" });
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13"
      || typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      return json(res, 400, { error: "Invalid WebSocket handshake" });
    }
    const socket = upgrade.socket!;
    socket.setNoDelay(true);
    let peer: Duplex | undefined;
    let recheck: ReturnType<typeof setInterval> | undefined;
    const release = connection.retain?.();
    let closed = false;
    let counted = false;
    const dialing = dialDesktop(connection, serverHandshake, () => !closed && !socket.destroyed && live() && holds(), key);
    const timeout = setTimeout(() => fail(), HANDSHAKE_MS);
    timeout.unref();
    upgrade.close = () => {
      if (closed) return;
      closed = true;
      release?.();
      clearTimeout(timeout);
      clearInterval(recheck);
      dialing.cancel();
      peer?.destroy();
      socket.destroy();
      if (counted) deps.direct?.relayClosed(socket.bytesWritten, socket.bytesRead);
    };
    const fail = () => {
      if (closed) return;
      if (peer || socket.destroyed) { upgrade.close(); return; }
      dialing.cancel();
      if (!res.headersSent && !socket.destroyed) json(res, 502, { error: "Could not connect to the desktop viewer" });
    };
    socket.once("close", upgrade.close);
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    dialing.opened.then(({ remote, head: remoteHead, opening, rest }) => {
      if (closed || socket.destroyed) { remote.destroy(); return; }
      clearTimeout(timeout);
      peer = remote;
      remote.once("error", upgrade.close);
      remote.once("close", upgrade.close);
      pending.release();
      res.detachSocket(socket);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      // why this screen is not direct, as the app said; counted, never logged with anything about the person
      const reason = url.searchParams.get("direct");
      deps.direct?.relayOpened(isScreenFallbackReason(reason) ? reason : null);
      counted = true;
      const head = pending.head;
      pending.head = Buffer.alloc(0);
      if (opening && rest) {
        for (const message of opening) socket.write(writeFrame(message, false));
        joinViewer(socket, head, remote, rest, upgrade.close);
      } else {
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        socket.pipe(remote).pipe(socket);
      }
      connection.touch?.();
      const seen = screenPresence(deps.presence);
      watchFrames(socket, head, (payload) => seen.bytes(payload));
      seen.tick();
      recheck = setInterval(() => {
        if (!live() || !holds()) upgrade.close();
        else { connection.touch?.(); seen.tick(); }
      }, RECHECK_MS);
      recheck.unref();
    }, () => fail());
  };

  /** Answers the app's offer and dials the desktop while ICE connects, so the first picture follows the channel at once;
   * the channel is joined to the desktop when both are up, then checked like a socket. */
  async function answerDirect(direct: ScreenDirect, offer: unknown, connection: DesktopConnection, serverHandshake: boolean, valid: () => boolean,
    register: (viewer: Viewer, key: IncomingMessage) => void, req: IncomingMessage, res: Parameters<RouteHandler>[0]["res"], json: Parameters<RouteHandler>[0]["json"]) {
    let ended = false;
    let release: (() => void) | undefined;
    let recheck: ReturnType<typeof setInterval> | undefined;
    let dialing: ReturnType<typeof dialDesktop> | undefined;
    let remote: Duplex | undefined;
    let channel: ScreenChannel | undefined;
    const viewer: Viewer = { ended: () => ended, close: () => close(), valid };
    const close = () => {
      if (ended) return;
      ended = true;
      viewers.delete(req);
      clearInterval(recheck);
      dialing?.cancel();
      remote?.destroy();
      release?.();
      peer?.close();
    };
    const join = () => {
      if (ended || !channel || !dialing) return;
      const open = channel;
      dialing.opened.then((dialled) => {
        if (ended) { dialled.remote.destroy(); return; }
        if (!valid()) { dialled.remote.destroy(); close(); return; }
        remote = dialled.remote;
        const seen = screenPresence(deps.presence);
        bridgeScreen(open, dialled.remote, {
          head: dialled.rest?.raw ?? dialled.head, opening: dialled.opening, payload: dialled.rest?.payload, skip: dialled.opening ? VIEWER_OPENING : 0,
          input: (bytes) => seen.bytes(bytes),
        }, close);
        connection.touch?.();
        seen.tick();
        recheck = setInterval(() => {
          if (!valid()) close();
          else { connection.touch?.(); seen.tick(); }
        }, RECHECK_MS);
        recheck.unref();
      }, close);
    };
    let peer: Awaited<ReturnType<ScreenDirect["answer"]>> | undefined;
    register(viewer, req);
    try {
      peer = await direct.answer(offer, (opened) => {
        if (ended || !valid()) { opened.close(); close(); return; }
        opened.onClose(close);
        channel = opened;
        join();
      });
    } catch (error) {
      close();
      const refused = error instanceof DirectRefused ? error : new DirectRefused(503, "direct path is off");
      return json(res, refused.status, { error: refused.message, reason: refused.status === 400 ? "signal-failed" : "server-off" });
    }
    if (!ended && !stopped) {
      release = connection.retain?.();
      dialing = dialDesktop(connection, serverHandshake, () => !ended && valid());
      // a desktop that never answers ends the attempt like a socket's handshake deadline; the peer's own deadline covers ICE
      const timeout = setTimeout(() => { if (!remote) close(); }, HANDSHAKE_MS + SCREEN_DIRECT_CONNECT_MS);
      timeout.unref();
      dialing.opened.then(() => clearTimeout(timeout), () => { clearTimeout(timeout); close(); });
      join();
    }
    if (ended || stopped) { close(); return json(res, 410, { error: "Viewer access expired", reason: "signal-failed" }); }
    return json(res, 200, peer.answer);
  }

  return {
    route,
    attach: upgrades.attach,
    closeForOwner: (owner: string, botId?: string) => {
      let closed = 0;
      for (const viewer of viewers.values()) {
        if (viewer.owner !== owner || (botId !== undefined && viewer.botId !== botId)) continue;
        // A closed viewer stays listed until its socket's close event, which arrives later on Windows.
        if (viewerEnded(viewer)) continue;
        viewer.close();
        closed++;
      }
      return closed;
    },
    recheck: () => {
      let closed = 0;
      for (const viewer of viewers.values()) {
        if (viewerEnded(viewer)) continue;
        let valid = false;
        try { valid = viewer.valid?.() ?? false; } catch { }
        if (valid) continue;
        viewer.close();
        closed++;
      }
      return closed;
    },
    closeAll: () => {
      stopped = true;
      if (ownGate) upgrades.close();
      for (const viewer of viewers.values()) viewer.close();
      deps.direct?.closeAll();
    },
  };
}
