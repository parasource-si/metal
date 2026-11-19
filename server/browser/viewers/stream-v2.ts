// The v2 live view the desktop panel and the web UI speak: T3 Code's stream protocol over a WebSocket. Every JPEG frame
// is one binary message and everything else JSON; the client acknowledges each frame as it arrives, and Chromium's own
// acknowledgement waits for that, so a slow viewer slows its screencast instead of queueing stale frames.
// A client that can decode H.264 asks for it (codec=h264): the server answers with an `encoding` message, and when it
// has an encoder (h264-encoder.ts) each binary message is then an access unit instead, acknowledged the same way.
//
// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/preview/ServerBrowserStream.ts, MIT License, Copyright (c)
// 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: written on ws without Effect, the viewer is
// the browser service's (it follows the tab in front of the bot's one browser), the socket opens before the browser
// has started, and Metal's own messages are added.
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { BrowserHostError, SETUP_COMMAND } from "../chrome/host-setup.ts";
import type { BrowserService, BrowserTarget } from "../service.ts";
import { FRAME_CAP_LIMITS, type Viewer, type ViewerOptions, type ViewerOutput } from "./core.ts";
import { H264Stream, h264Encoder, VIDEO_LIMITS, type H264Config } from "./h264-encoder.ts";

/** A screencast cap at most VIDEO_LIMITS wide, its height scaled with it. */
function videoCap(maxWidth: number, maxHeight: number): { maxWidth: number; maxHeight: number } {
  const fit = Math.min(1, VIDEO_LIMITS.maxWidth / maxWidth);
  return { maxWidth: Math.round(maxWidth * fit), maxHeight: Math.max(1, Math.round(maxHeight * fit)) };
}
import { requestedSize } from "./viewport.ts";
import { displayUrl } from "./live-v1.ts";

/** Close codes the stream client acts on. */
export const STREAM_CLOSE = {
  /** The browser this view showed is gone for good (another profile, the browser turned off): the client stops. */
  gone: 4404,
  /** The host cannot run Chrome until it is set up; the reason says how. */
  hostSetup: 4503,
  /** The browser closed or restarted while the view stays valid: the client reconnects. */
  reconnect: 1012,
  /** Too many views are open; the client tries again later. */
  busy: 1013,
  /** The browser could not start. */
  failed: 1011,
} as const;

const DEFAULT_QUALITY = 70;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_UNACKNOWLEDGED_FRAMES = 64;
const MAX_MESSAGE_BYTES = 64 * 1024;
const VIEWERS_PER_PROFILE = 4;
const VIEWERS_TOTAL = 16;
const RECHECK_MS = 5_000;
/** A client that does not answer the server's close frame is cut off this long after it was sent. */
const CLOSE_GRACE_MS = 2_000;
const GONE = "This browser view is no longer available.";
const PING_MS = 15_000;
/** The close code of a connection that broke without a close frame. */
const ABNORMAL_CLOSE = 1006;
/** Input that arrives while the viewer is still attaching (its control state is already on the wire) waits for it. */
const EARLY_INPUT_LIMIT = 64;
/** Access units a video client may have unacknowledged before the encoder waits for it. */
const VIDEO_WINDOW = 3;

export interface StreamRequest {
  target: BrowserTarget;
  botId: string;
  /** A session id, or local-owner. */
  owner: string;
  /** The person watching, whose hold this view shares on any device; the owner when unset. */
  person?: string;
  /** False for a passive view (picture in picture): it never takes control. */
  canOperate: boolean;
  params: URLSearchParams;
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
  /** False once this view no longer shows the bot's current browser to a live sign-in. */
  isCurrent(): boolean;
}

const intParam = (params: URLSearchParams, name: string, fallback: number, max: number) => {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : fallback;
};

const typeOf = (message: unknown) => (typeof message === "object" && message !== null ? (message as { type?: unknown }).type : undefined);
const isAck = (message: unknown) => typeOf(message) === "ack";

const parseMessage = (data: RawData): unknown => {
  try {
    return JSON.parse(Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8"));
  } catch {
    return null;
  }
};

/** A viewer's output as the client reads it: frames go as bytes, the rest as `{type, ...}`. */
export function wireMessage(output: Exclude<ViewerOutput, { type: "frame" | "gone" }>): Record<string, unknown> | null {
  switch (output.type) {
    case "tabs":
      return { type: "tabs", tabs: output.tabs.map((tab) => ({ ...tab, url: displayUrl(tab.url) })) };
    case "url":
    case "nav":
      return { ...output, url: displayUrl(output.url) };
    case "status":
      return null;
    default:
      return { ...output };
  }
}

class StreamSession {
  readonly request: StreamRequest;
  readonly ws: WebSocket;
  readonly unacknowledged: Array<() => void> = [];
  viewer: Viewer | null = null;
  closed = false;
  /** Its connection broke, rather than the panel closing it. */
  lost = false;
  /** The server is closing this view: nothing the client sends reaches the browser any more. */
  closing = false;
  #early: unknown[] = [];
  #restarting = false;
  #video: H264Stream | null = null;
  get hasVideo(): boolean { return this.#video !== null; }
  /** The encoding the client was last told, once it asked for video. */
  #encoding: "jpeg" | "h264" | null = null;

  constructor(request: StreamRequest, ws: WebSocket) {
    this.request = request;
    this.ws = ws;
  }

  /** A viewer that stops reading is cut off rather than buffered for. */
  kill(): void {
    this.request.socket.destroy();
  }

  #fits(bytes: number): boolean {
    // Include the WebSocket frame header in the budget.
    return this.ws.bufferedAmount + bytes + 14 <= MAX_SOCKET_BUFFER_BYTES;
  }

  /** Video for a client that asked for it: an encoder when this server has one, else it is told its frames stay JPEG. */
  video(encoder: Awaited<ReturnType<typeof h264Encoder>>): void {
    if (this.closed || this.closing) return;
    this.#video = encoder && H264Stream.open(encoder, {
      config: (config) => this.#tell(config),
      unit: (data, ack) => this.#frame(data, ack),
      failed: () => { const video = this.#video; this.#video = null; video?.close(); this.#tell(null); },
    }, { canSend: () => this.unacknowledged.length < VIDEO_WINDOW });
    if (!this.#video) this.#tell(null);
  }

  /** Tells the client how the next binary messages are encoded: H.264 of `config`, or JPEG when null. */
  #tell(config: H264Config | null): void {
    if (!config && this.#encoding === "jpeg") return;
    this.#encoding = config ? "h264" : "jpeg";
    this.#json(config ? { type: "encoding", encoding: "h264", ...config } : { type: "encoding", encoding: "jpeg" });
  }

  #frame(data: Buffer, ack: () => void): void {
    if (this.closed || this.closing) {
      ack();
      return;
    }
    if (this.unacknowledged.length >= MAX_UNACKNOWLEDGED_FRAMES || !this.#fits(data.byteLength)) {
      ack();
      this.kill();
      return;
    }
    this.unacknowledged.push(ack);
    this.ws.send(data, { binary: true });
  }

  #json(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    if (!this.#fits(Buffer.byteLength(text))) {
      this.kill();
      return;
    }
    this.ws.send(text);
  }

  push(output: ViewerOutput): void {
    if (this.closed || this.closing) {
      if (output.type === "frame") output.ack();
      return;
    }
    if (output.type === "frame") {
      if (this.#video?.push(output.data, output.ack)) return;
      if (this.#encoding === "h264") this.#tell(null);
      this.#frame(output.data, output.ack);
      return;
    }
    if (output.type === "gone") {
      this.close(STREAM_CLOSE.reconnect, "reconnect", { dropped: true });
      return;
    }
    const message = wireMessage(output);
    if (message) this.#json(message);
  }

  /** A notice the person should read, such as why a restart was refused. */
  notice(message: string): void {
    if (!this.closed && !this.closing) this.ws.send(JSON.stringify({ type: "notice", message }));
  }

  receive(data: RawData, binary: boolean, service: BrowserService): void {
    if (binary) return;
    const message = parseMessage(data);
    if (isAck(message)) {
      // Chromium's acknowledgement is paced by the viewer, and never holds up input.
      this.unacknowledged.shift()?.();
      this.#video?.pump();
      return;
    }
    // the client's decoder lost its place; any view may ask, at most once a second
    if (typeOf(message) === "keyframe") {
      this.#video?.keyframe();
      return;
    }
    // Ownership serializes actions in the service. Keep reading so dialog replies and takeover can unblock an action
    // already waiting on the page.
    if (!this.request.canOperate || this.closing) return;
    // Security: every message is checked as every v1 action is, so a person signed out or no longer allowed to see the
    // bot never acts on its browser again.
    if (!this.request.isCurrent()) {
      this.close(STREAM_CLOSE.gone, GONE);
      return;
    }
    if (!this.viewer) {
      if (this.#early.length < EARLY_INPUT_LIMIT) this.#early.push(message);
      return;
    }
    this.#input(message, service);
  }

  attached(viewer: Viewer, service: BrowserService): void {
    this.viewer = viewer;
    for (const message of this.#early.splice(0)) this.#input(message, service);
  }

  #input(message: unknown, service: BrowserService): void {
    if ((message as { type?: unknown } | null)?.type === "restart") {
      void this.#restart(service);
      return;
    }
    // a video view stays at 1x, even when the app asks for a sharper picture later (h264-encoder.ts VIDEO_LIMITS)
    const cap = message as { type?: unknown; maxWidth?: unknown; maxHeight?: unknown } | null;
    if (this.#video && cap?.type === "frameCap" && typeof cap.maxWidth === "number" && typeof cap.maxHeight === "number") {
      void this.viewer?.input({ ...cap, ...videoCap(cap.maxWidth, cap.maxHeight) });
      return;
    }
    void this.viewer?.input(message);
  }

  async #restart(service: BrowserService): Promise<void> {
    if (this.#restarting || !this.viewer || this.closing) return;
    this.#restarting = true;
    try {
      await service.restart(this.request.target.session, this.viewer.options.person);
    } catch {
      this.notice("The browser could not restart. Try again.");
    } finally {
      this.#restarting = false;
    }
  }

  /** Lets the viewer go at once, and its held input, then tells the client why and cuts it off. `dropped`: the client comes
   * straight back, so a hold of its person waits for it. */
  close(code: number, reason: string, { dropped = false }: { dropped?: boolean } = {}): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.#video?.close();
    void this.viewer?.close({ dropped }).catch(() => undefined);
    try { this.ws.close(code, reason.slice(0, 120)); } catch { this.kill(); return; }
    setTimeout(() => this.kill(), CLOSE_GRACE_MS).unref();
  }

  /** Releases Chromium from every frame still in flight and lets the viewer go. `lost`: the connection broke rather
   * than the panel closing it, so a hold of its person waits the grace for their next view. */
  ended(lost: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.lost = lost;
    this.#video?.close();
    for (const ack of this.unacknowledged.splice(0)) ack();
    void this.viewer?.close({ dropped: lost && this.theirs() }).catch(() => undefined);
  }

  /** Still the view of a person allowed to see this browser: its stream went, not its sign-in. */
  theirs(): boolean {
    try { return this.request.isCurrent(); } catch { return false; }
  }
}

/** Every v2 view of the bots' browsers on this server. */
export class StreamV2 {
  readonly #service: BrowserService;
  readonly #sessions = new Set<StreamSession>();
  readonly #server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });

  constructor({ service }: { service: BrowserService }) {
    this.#service = service;
  }

  /** Answers the handshake and streams. Frames are JPEGs or H.264 already, so no deflate, which also keeps every pending write in the socket buffer bounded here. */
  open(request: StreamRequest): void {
    const perProfile = [...this.#sessions].filter((session) => session.request.target.key === request.target.key).length;
    const busy = this.#sessions.size >= VIEWERS_TOTAL || perProfile >= VIEWERS_PER_PROFILE;
    this.#server.handleUpgrade(request.req, request.socket, request.head, (ws) => {
      const session = new StreamSession(request, ws);
      if (busy) {
        session.closed = true;
        ws.close(STREAM_CLOSE.busy, "Too many browser views are open. Close another browser panel first.");
        return;
      }
      this.#sessions.add(session);
      void this.#serve(session);
    });
  }

  async #serve(session: StreamSession): Promise<void> {
    const { request, ws } = session;
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) { session.kill(); return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, PING_MS);
    ping.unref();
    const recheck = setInterval(() => {
      if (!request.isCurrent()) session.close(STREAM_CLOSE.gone, GONE);
    }, RECHECK_MS);
    recheck.unref();
    ws.on("pong", () => { alive = true; });
    ws.on("message", (data, binary) => session.receive(data, binary, this.#service));
    ws.on("error", () => session.kill());
    // 1006: no close frame came, as when a phone goes to the background or the network drops; a panel that closes says so.
    ws.once("close", (code) => {
      clearInterval(ping);
      clearInterval(recheck);
      this.#sessions.delete(session);
      session.ended(code === ABNORMAL_CLOSE);
    });
    const params = request.params;
    const size = requestedSize(Number(params.get("width")), Number(params.get("height")));
    const options: ViewerOptions = {
      owner: request.owner,
      ...(request.person ? { person: request.person } : {}),
      canOperate: request.canOperate,
      maxWidth: intParam(params, "maxWidth", 1280, FRAME_CAP_LIMITS.maxWidth),
      maxHeight: intParam(params, "maxHeight", 800, FRAME_CAP_LIMITS.maxHeight),
      quality: intParam(params, "quality", DEFAULT_QUALITY, 100),
      pace: "hi",
      authPrompts: true,
      pagePopups: true,
      ...(params.get("together") === "1" ? { together: true } : {}),
      ...(size && request.canOperate ? { size } : {}),
    };
    try {
      if (params.get("codec") === "h264") session.video(await h264Encoder());
      // video is encoded at 1x: the screencast is asked for no more, so a 2x screen costs no 2x JPEG decode either
      if (session.hasVideo) Object.assign(options, videoCap(options.maxWidth, options.maxHeight));
      const viewer = await this.#service.attachViewer(request.target, options, (output) => session.push(output));
      if (session.closed || session.closing) await viewer.close({ dropped: session.lost && session.theirs() });
      else session.attached(viewer, this.#service);
    } catch (error) {
      if (error instanceof BrowserHostError) session.close(STREAM_CLOSE.hostSetup, JSON.stringify({ need: error.kind, command: SETUP_COMMAND }));
      else session.close(STREAM_CLOSE.failed, "The browser could not start.");
    }
  }

  get size(): number {
    return this.#sessions.size;
  }

  closeForSession(session: string): void { this.#closeWhere((request) => request.target.session === session); }
  closeForOwner(owner: string): void { this.#closeWhere((request) => request.owner === owner); }
  closeForBot(botId: string): void { this.#closeWhere((request) => request.botId === botId); }
  closeAll(): void { this.#closeWhere(() => true); }
  /** Closes now every view the 5 s recheck would close. */
  recheck(): void { for (const session of this.#sessions) if (!session.request.isCurrent()) session.close(STREAM_CLOSE.gone, GONE); }

  #closeWhere(match: (request: StreamRequest) => boolean): void {
    for (const session of this.#sessions) if (match(session.request)) session.close(STREAM_CLOSE.gone, "This browser view closed.");
  }
}
