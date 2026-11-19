// This computer's own phone relay: the link service's phone channels (apps/link-service/README.md "Phone channels"),
// served by the hub a linked VPS runs (apps/link-service/agent.mjs createPhoneHub) against this computer's harness.
//
// Security invariants:
// - every frame is AES-256-GCM sealed with a key only the phone and this computer hold (a grant's key travels only in the
//   QR; a device's comes from X25519 between the phone and `keys` here); the link service keeps token verifiers and
//   queues opaque frames, so it can neither read nor forge a request.
// - phone requests reach the harness marked remote (x-forwarded-for, cookies and x-dusk-* stripped by the hub): each one
//   needs that phone's own workspace session; a grant channel reaches redeem, environment and health only.
// - only this process may set the channel set: the sync carries the desktop owner token, which no phone request can.
// - the tunnel token and phone keys are kept per workspace, encrypted with the OS keychain when it is available.
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import path from "node:path";

import { seal, sealKeyOf, sha256hex, x25519Pair } from "./vps-link-protocol.mjs";

export const PHONE_RELAY_BASE = "https://link.dusk.bot";
const DESKTOP_OWNER_HEADER = "x-dusk-desktop-owner";
const CHECK_MS = 15_000;
const RETRY_MS = [5_000, 30_000, 120_000];
const ID = /^[a-z2-7]{10}$/;

/** One answer of Electron's `session.resolveProxy` ("PROXY host:port; DIRECT", a PAC script's list) as the link hub's
 * proxy: the first plain http proxy, or null to go direct. SOCKS and https proxies are not spoken by the hub. */
export function proxyFromResolved(answer) {
  for (const entry of String(answer ?? "").split(";").map((part) => part.trim())) {
    if (/^DIRECT$/i.test(entry)) return null;
    const match = /^PROXY\s+(\[[^\]]+\]|[^\s:]+):(\d{1,5})$/i.exec(entry);
    if (match) return { host: match[1].replace(/^\[|\]$/g, ""), port: Number(match[2]) };
  }
  return null;
}

/** the computer's own proxy settings (system, PAC or WPAD) for each relay address, as Chromium resolves them */
export const systemProxy = (session) => async (target) => proxyFromResolved(await session.resolveProxy(target.href).catch(() => "DIRECT"));

/** what the link service said, as a reason the pane can show; `code` is the service's own when it gave one */
export class RelaySetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RelaySetupError";
    this.code = code;
  }
}

async function call(fetchImpl, base, route, { token, body, method = "POST" } = {}) {
  const response = await fetchImpl(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const answer = await response.json().catch(() => null);
  if (!response.ok) throw new RelaySetupError(typeof answer?.code === "string" ? answer.code : `http_${response.status}`, typeof answer?.error === "string" ? answer.error : `the link service answered ${response.status}`);
  return answer;
}

/**
 * Makes a tunnel for this computer through the setup session a VPS install uses, with this computer as both ends: the
 * account grant opens the session (so the tunnel counts toward that account), then the session is claimed and linked
 * here. The sealed result is only a well-formed placeholder: no app ever opens it.
 */
export async function createRelayTunnel({ base, grant, label, fetch: fetchImpl = fetch }) {
  const secret = randomBytes(32).toString("base64url");
  const app = x25519Pair();
  const opened = await call(fetchImpl, base, "/v1/sessions", { body: { grant, verifier: sha256hex(secret), appPub: app.pub, label: String(label ?? "").slice(0, 60) } });
  if (!ID.test(opened?.id ?? "")) throw new RelaySetupError("invalid", "the link service answered without a session");
  const id = opened.id;
  await call(fetchImpl, base, `/v1/sessions/${id}/claim`, { token: secret, body: {} });
  const mine = x25519Pair();
  const vps = randomBytes(32).toString("base64url"), appToken = randomBytes(32).toString("base64url");
  const sealed = seal(sealKeyOf(mine.priv, mine.pub, app.pub, id), id, Buffer.from(JSON.stringify({ v: 1, kind: "phones" })));
  await call(fetchImpl, base, `/v1/sessions/${id}/result`, { token: secret, body: { sealed, vpsPub: mine.pub, tunnel: { vps: sha256hex(vps), app: sha256hex(appToken) } } });
  return { base, id, token: vps };
}

/** true while the link service knows the tunnel, false once it dropped it, null when it could not be asked */
export async function tunnelKnown({ base, id, token }, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${base}/v1/tunnels/${id}/node`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel().catch(() => {});
    return response.ok ? true : response.status === 404 ? false : null;
  } catch {
    return null;
  }
}

/** the hub's channel sync with this computer's harness, as the desktop owner (agent.mjs harnessSync is a VPS's loopback) */
export function desktopHarnessSync({ port, ownerToken, request = httpRequest }) {
  return ({ base, tunnel, pub, origin = null, spki = null, applied, failed, wait, signal }) => new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ base, tunnel, pub, origin, spki, applied, failed, wait }));
    const req = request({
      host: "127.0.0.1", port: port(), method: "POST", path: "/api/mobile/relay/sync",
      headers: { "content-type": "application/json", "content-length": String(payload.length), [DESKTOP_OWNER_HEADER]: ownerToken() },
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout((wait + 15) * 1000)]),
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`phone sync answered ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Keeps the hub running while `wanted()` (remote access on, this computer's own workspace). States:
 * `off` (not wanted now, but could start), `signed-out` (no tunnel yet and no dusk account to make one), `starting`,
 * `ready` (the harness has the channels registered at the relay), `error` (the link service refused; `message` says why).
 * @param {{
 *   base: string,
 *   wanted(): boolean,
 *   signedIn(): boolean,
 *   linkGrant(): Promise<string | null>,
 *   label(): string,
 *   store: { read(at: string): Promise<{ keys?: { pub: string, priv: string }, tunnel?: { base: string, id: string, token: string } | null } | null>, write(at: string, value: unknown): Promise<void> },
 *   loadHub(): Promise<{ createPhoneHub: Function }>,
 *   port(): number,
 *   ownerToken(): string,
 *   scope?(): string,
 *   fetch?: typeof fetch,
 *   log?: (line: string) => void,
 *   checkMs?: number,
 *   retryMs?: number[],
 *   now?: () => number,
 * }} deps
 */
export function createPhoneRelay(deps) {
  const log = deps.log ?? (() => {});
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? RETRY_MS;
  let status = { status: "off" };
  let running = null, checking = null, failures = 0, notBefore = 0, lastTry = -Infinity, timer = null, stopped = false;
  const scope = () => deps.scope?.() ?? "";
  const waiters = new Set();

  const set = (next) => {
    status = next;
    for (const waiter of Array.from(waiters)) waiter();
  };
  const backoff = () => { notBefore = now() + retryMs[Math.min(failures, retryMs.length - 1)]; failures += 1; };
  const idle = async () => {
    const saved = await deps.store.read(scope()).catch(() => null);
    return saved?.tunnel || deps.signedIn() ? { status: "off" } : { status: "signed-out" };
  };

  function stopHub() {
    const hub = running;
    running = null;
    hub?.hub.stop();
  }

  async function startHub(saved, at) {
    const { createPhoneHub } = await deps.loadHub();
    if (stopped || running || scope() !== at || !deps.wanted()) return;
    const { tunnel, keys } = saved;
    const one = { scope: at };
    const sync = desktopHarnessSync({ port: deps.port, ownerToken: deps.ownerToken });
    // a sync reporting an applied revision means the relay took this computer's channels
    one.hub = createPhoneHub({
      base: tunnel.base, id: tunnel.id, token: tunnel.token, keys, ...(deps.proxy ? { proxy: deps.proxy } : {}),
      // a phone's request must never reach another workspace's harness, which would answer 401 and unpair it: until the
      // check stops this hub, port 0 fails each one as unreachable
      server: { host: "127.0.0.1", get port() { return one.scope === scope() ? deps.port() : 0; } },
      sync: async (input) => {
        // another workspace's harness must never replace this tunnel's channels: that would cut its phones off
        const moved = () => { if (one.scope === scope()) return; void check(); throw new Error("the workspace changed"); };
        moved();
        if (running === one && input.applied > 0 && status.status !== "ready") { failures = 0; set({ status: "ready" }); }
        const answer = await sync(input);
        moved();
        return answer;
      },
      log: (line) => log(`phone relay: ${line}`),
    });
    running = one;
    set({ status: "starting" });
    one.done = one.hub.run().catch((error) => log(`phone relay: the hub stopped (${error?.message ?? error})`)).then(async () => {
      if (running !== one) return;
      running = null;
      // the hub ends by itself only when the relay refused the tunnel: ask, and make a new one when it is gone
      if ((await tunnelKnown(tunnel, fetchImpl)) === false) {
        log("phone relay: the link service no longer knows this computer's tunnel; making a new one");
        await deps.store.write(one.scope, { ...saved, tunnel: null }).catch(() => {});
      } else backoff();
      set({ status: "starting" });
      schedule(0);
    });
  }

  /** ends a tunnel this computer made but could not keep, so a failed save never holds one of the account's slots */
  async function retire(tunnel) {
    try {
      const response = await fetchImpl(`${tunnel.base}/v1/tunnels/${tunnel.id}`, { method: "DELETE", headers: { authorization: `Bearer ${tunnel.token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      log(`phone relay: an unsaved tunnel was not ended (${error?.message ?? error})`);
    }
  }

  async function checkNow() {
    if (stopped) return;
    // the workspace this check is for: every read, write and hub below belongs to it, and a switch midway ends the check
    const at = scope();
    if (!deps.wanted()) {
      stopHub();
      set(await idle());
      return;
    }
    if (running && running.scope !== at) stopHub();
    if (running || now() < notBefore) return;
    lastTry = now();
    let saved = await deps.store.read(at).catch(() => null);
    if (scope() !== at) return;
    if (!saved?.keys) saved = { keys: x25519Pair(), tunnel: null };
    if (!saved.tunnel) {
      const grant = await deps.linkGrant().catch(() => null);
      if (scope() !== at) return;
      if (!grant) { set({ status: "signed-out" }); return; }
      set({ status: "starting" });
      let tunnel;
      try {
        tunnel = await createRelayTunnel({ base: deps.base, grant, label: deps.label(), fetch: fetchImpl });
      } catch (error) {
        backoff();
        log(`phone relay: no tunnel (${error?.code ?? error?.message ?? error})`);
        set({ status: "error", code: error?.code ?? "unreachable", message: error instanceof RelaySetupError ? error.message : "Metal could not reach its relay." });
        return;
      }
      if (scope() !== at) { await retire(tunnel); return; }
      try {
        await deps.store.write(at, { ...saved, tunnel });
      } catch (error) {
        await retire(tunnel);
        backoff();
        log(`phone relay: the tunnel could not be saved (${error?.message ?? error})`);
        set({ status: "error", code: "save_failed", message: "Metal could not save its relay settings." });
        return;
      }
      saved = { ...saved, tunnel };
    }
    if (stopped || running || scope() !== at) return;
    if (!deps.wanted()) { set(await idle()); return; }
    await startHub(saved, at);
  }

  function check() {
    checking ??= checkNow().catch((error) => log(`phone relay: check failed (${error?.message ?? error})`)).finally(() => { checking = null; });
    return checking;
  }

  function schedule(ms = deps.checkMs ?? CHECK_MS) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => { void check().finally(() => schedule()); }, ms);
    timer.unref?.();
  }

  return {
    start() { stopped = false; schedule(0); },
    stop() {
      stopped = true;
      clearTimeout(timer);
      stopHub();
      set({ status: "off" });
    },
    state: () => ({ ...status }),
    /** the computer woke or its network came back: a relay still waiting out a failure tries again now */
    wake() {
      if (stopped || running) return;
      failures = 0;
      notBefore = 0;
      schedule(0);
    },
    /** asked right before a pairing code is made: start now if wanted and wait for the relay, at most `timeoutMs` */
    async ready(timeoutMs = 8_000) {
      // a person asking skips the wait after a failure, but not more often than the first retry
      if (now() - lastTry >= retryMs[0]) notBefore = Math.min(notBefore, now());
      await check();
      if (status.status !== "starting") return { ...status };
      await new Promise((resolve) => {
        const done = () => { if (status.status === "starting") return; clearTimeout(timeout); waiters.delete(done); resolve(); };
        const timeout = setTimeout(() => { waiters.delete(done); resolve(); }, timeoutMs);
        waiters.add(done);
      });
      return { ...status };
    },
    /** for tests */
    settled: () => Promise.all([checking, running?.done]),
  };
}

/** every workspace's relay, in userData, keyed by the workspace's data folder */
export function phoneRelayStore({ jsonFile, userData, encryption }) {
  const file = jsonFile(path.join(userData, "phone-relay.json"));
  // electron's async safeStorage decrypt answers { result }, not a bare string
  const unprotect = async (value) => {
    if (!value.startsWith("e:")) return value.slice(2);
    const out = await encryption.decrypt(Buffer.from(value.slice(2), "base64"));
    return typeof out === "string" ? out : String(out?.result ?? "");
  };
  const key = (at) => createHash("sha256").update(String(at ?? "")).digest("hex").slice(0, 16);
  /** a missing file is empty; an unreadable one is set aside on write, so the other workspaces' entries are never lost */
  const entries = ({ setAside = false } = {}) => {
    let value;
    try {
      value = file.read();
    } catch (error) {
      if (error?.code !== "ENOENT" && setAside) file.setAside();
      return {};
    }
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  return {
    async read(at) {
      const value = entries()[key(at)];
      if (typeof value !== "string") return null;
      try { return JSON.parse(await unprotect(value)); } catch { return null; }
    },
    async write(at, value) {
      const text = JSON.stringify(value);
      const sealed = (await encryption.available()) ? `e:${(await encryption.encrypt(text)).toString("base64")}` : `p:${text}`;
      file.write({ ...entries({ setAside: true }), [key(at)]: sealed });
    },
  };
}

/**
 * Electron main's wiring: `phone-relay:state` and `phone-relay:ready` for the local page, and a relay kept up while
 * `wanted()`. Returns the relay.
 */
export function installPhoneRelay({ ipcMain, guard, jsonFile, userData, dataDir, encryption, powerMonitor, ...deps }) {
  const relay = createPhoneRelay({
    base: (process.env.DUSK_LINK_BASE || PHONE_RELAY_BASE).replace(/\/+$/, ""),
    store: phoneRelayStore({ jsonFile, userData, encryption }),
    scope: () => String(dataDir() ?? ""),
    loadHub: () => import("../apps/link-service/agent.mjs"),
    ...deps,
  });
  ipcMain.handle("phone-relay:state", guard("phone-relay:state", () => relay.state()));
  ipcMain.handle("phone-relay:ready", guard("phone-relay:ready", () => relay.ready()));
  if (process.env.DUSK_PHONE_RELAY !== "off") {
    relay.start();
    for (const event of ["resume", "unlock-screen"]) powerMonitor?.on(event, () => relay.wake());
  }
  return relay;
}
