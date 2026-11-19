// "Add your VPS": the app opens a one-time setup session at the link service, shows the one command, follows the install
// step by step, opens the sealed result, signs this app in to the new server, saves it as a server, then signs the AI in
// from this mac and moves everything there (backup first, own-home move, check, switch, then this mac emptied).
// every secret is kept protected (safeStorage in main); the link service only ever sees verifiers and sealed blobs.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { APP_LINK_PROTOCOL, agentInfo, linkCompat, missingCap } from "./vps-link-compat.mjs";
import { orderedConnect } from "./vps-link-direct.mjs";
import { createRelayClient, createTunnelProxy, newLinkKeys, openResult } from "./vps-link-protocol.mjs";
import { shortHash, trail } from "./trail.mjs";
import { WELCOME_VERSION } from "./onboarding-record.mjs";
import { createMoveBack } from "./move-back.mjs";

/** the one line to paste on the server. it tries the download five times, every other try over IPv4 (a flaky IPv6
 * path to the link service drops TLS handshakes), 2 s apart: a shell loop, since curl's --retry-all-errors is newer
 * than Ubuntu 20.04's curl. the script goes to sh only once it arrived whole, so a cut-off try runs nothing; when every
 * try fails, sh gets a plain message and exit 1 (a bare `curl … | sh` runs nothing and exits 0). PlaceSetup's wayLine
 * adds the way after the closing `| sh`. (`sh -c "$(curl …)"` is out: the installer is near Linux's 128 KB limit for
 * one argument; printf is a builtin, so it has no such limit.) */
export function installLine(base, token) {
  return `(for f in "" -4 "" -4 ""; do s=$(curl -fsSL $f ${base}/i/${token}) && { printf '%s\\n' "$s"; exit; }; sleep 2; done; echo 'echo "Metal could not be downloaded. check the internet and paste the line again." >&2; exit 1') | sh`;
}

/** a short line's address as the link service gave it (`https://dusk.bot/s/<code>`), or null for anything else */
export const SHORT_URL = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/s\/[a-km-np-z2-9]{7}$/;
/** the short line: the link service serves a tiny script there that runs installLine's loop itself (bootstrapScript in
 * apps/link-service/src/app.mjs), so the retries and the IPv4 fallback stay; PlaceSetup's wayLine adds the way to the
 * address (`…/s/<code>/tailscale`). an older link service without short codes gets installLine */
export function shortInstallLine(url) {
  return `curl -fsSL ${url} | sh`;
}

export const STEP_IDS = Object.freeze(["check", "basics", "docker", "user", "node", "app", "engines", "service", "address", "desktop", "link"]);
const STATUSES = new Set(["running", "done", "failed", "skipped"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SKILL_KINDS = new Set(["skill", "imported-skill", "library-skill"]);
const ROUTINE_KINDS = new Set(["routine", "call", "webhook", "app-event"]);
const CLAUDE_TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
/** a server's long-term identity key as it signs its sealing keys: P-256, `x.y` in base64url */
export const SEAL_IDENTITY = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

function installProgress(value) {
  if (!record(value)) return null;
  const label = typeof value.label === "string" ? value.label.slice(0, 120) : undefined;
  if (value.kind === "download" && Number.isFinite(value.receivedBytes) && value.receivedBytes >= 0) {
    return { kind: value.kind, receivedBytes: value.receivedBytes,
      ...(Number.isFinite(value.totalBytes) && value.totalBytes > 0 ? { totalBytes: value.totalBytes } : {}), ...(label ? { label } : {}) };
  }
  if (["layers", "build"].includes(value.kind) && Number.isFinite(value.completed) && value.completed >= 0 && Number.isFinite(value.total) && value.total > 0) {
    return { kind: value.kind, completed: value.completed, total: value.total,
      ...(Number.isFinite(value.receivedBytes) && value.receivedBytes >= 0 ? { receivedBytes: value.receivedBytes } : {}),
      ...(Number.isFinite(value.totalBytes) && value.totalBytes > 0 ? { totalBytes: value.totalBytes } : {}), ...(label ? { label } : {}) };
  }
  return null;
}

/** the ways a linked server is reached (install.sh `use_address`) */
export const ADDRESS_VIAS = new Set(["relay", "ssh", "direct", "tailscale", "cloudflare"]);
const ASK_LINK_HOSTS = { "tailscale-login": "login.tailscale.com", "tailscale-https": "login.tailscale.com" };
const ASK_NAME = /^[a-z0-9.-]{1,253}$/;
const ASK_IP = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** what the installer asks the person to do, as the link service let it through: null clears it, undefined is ignored.
 * links open only on the provider's own host, since the page opens them outside the app */
export function installAsk(value) {
  if (!record(value)) return undefined;
  if (value.kind === "none") return null;
  const state = ["waiting", "found", "done"].includes(value.state) ? value.state : "waiting";
  if (Object.hasOwn(ASK_LINK_HOSTS, value.kind)) {
    try {
      const url = new URL(value.url);
      return url.protocol === "https:" && url.hostname === ASK_LINK_HOSTS[value.kind] ? { kind: value.kind, url: url.href, state } : undefined;
    } catch { return undefined; }
  }
  if (value.kind === "ssh") return /^[a-z_][a-z0-9_-]{0,31}$/.test(value.user ?? "") && (ASK_IP.test(value.host ?? "") || ASK_NAME.test(value.host ?? "")) ? { kind: "ssh", user: value.user, host: value.host, state } : undefined;
  return undefined;
}

/** a plain sentence for a person, never a stack or a status code alone */
const plain = (error, fallback) => {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (!message || message.length >= 300 || /^\w*Error\b|ECONN|fetch failed|ENOTFOUND/.test(message)) return fallback;
  // the app reads in sentence case; lower-level messages start lowercase ("the server's ssh key is not the one it said")
  return /^[a-z][a-z]/.test(message) && !/^dusk (bot|cloud)\b/.test(message) ? message[0].toUpperCase() + message.slice(1) : message;
};

/**
 * @param {{
 *   base: string,
 *   fetch?: typeof fetch,
 *   serverFetch: typeof fetch,
 *   store: { read(): unknown, write(value: unknown): void },
 *   protect(text: string): Promise<string>,
 *   unprotect(text: string): Promise<string>,
 *   label(): string,
 *   saveServer(server: { origin: string, name: string }): string,
 *   forgetServer(id: string, how?: { replaced?: boolean }): void,
 *   retarget?(from: string, to: string): void,
 *   switchTo(id: string): Promise<void> | void,
 *   pin?(host: string, spki: string): void,
 *   ownHome: { start(id: string): Promise<unknown>, view(): any, away(): boolean, home(): any, chosen(): any, active?(): boolean, retry?(): Promise<void>, trouble?(): { error: string, retryAt: number } | null },
 *   places?(): any[],
 *   who?(place: { origin: string }): Promise<{ signedIn: boolean, own: boolean, environmentId: string | null }>,
 *   ownHomeReset(): void,
 *   localRequest(route: string, init?: RequestInit): Promise<Response>,
 *   backups: { save(name: string, bytes: AsyncIterable<Uint8Array> | Uint8Array): Promise<{ file: string, bytes: number }>, open(file: string): Promise<{ body: any, size: number }>, remove?(file: string): void },
 *   localCredentials: { codexAuth(): Promise<string | null>, claudeCli(): Promise<string | null>, claudeToken(cli: string, signal: AbortSignal): Promise<string> },
 *   relaunch(): void,
 *   dataSize?(): Promise<number | null>,
 *   proxyFactory?: typeof createTunnelProxy,
 *   direct?: { newKey(): { privateKey: string, publicKey: string }, connector(config: { host: string, port: number, user: string, privateKey: string, hostKeys: string[] }): () => Promise<any>, wssConnector?(config: { url: string, spki: string }): () => Promise<any>,
 *     rtc?: { connector(config: { signal(offer: { type: string, sdp: string }): Promise<any> }): () => Promise<any> } | null,
 *     cloud?: { url: string | null, connector(config: { url: string, id: string, key: string }): () => Promise<any>, register(config: { url: string, id: string, key: string, grant: string | null }): Promise<void> } },
 *   egress?: Parameters<typeof createTunnelProxy>[0]["egress"],
 *   appVersion?: string,
 *   linkGrant?(): Promise<string | null>,
 *   signIn?(): Promise<unknown>,
 *   screenIce?(): Promise<Array<{ urls: string[], username?: string, credential?: string }> | null>,
 *   now?(): number,
 *   onChange?(view: any): void,
 *   log?(line: string): void,
 *   pollMs?: number,
 *   addressCheckMs?: number,
 * }} deps
 */
/** The welcome record a server gets when this Mac moves everything to it, or null when it needs none. The person met
 *  Metal here: a finished welcome is kept as it was, and one still under way (they chose their own server from the
 *  welcome itself) counts as met, so the server never starts over at "meet Metal" and asks where the bots live. */
export function welcomeForServer(mine, theirs, now) {
  if (theirs?.completedAt) return null;
  const hints = Array.isArray(mine?.hintsSeen) ? { hintsSeen: mine.hintsSeen } : {};
  if (mine?.completedAt) return { completedAt: mine.completedAt, version: mine.version, ...hints };
  return { completedAt: now.toISOString(), version: WELCOME_VERSION, ...hints };
}

export function createVpsLink(deps) {
  const { base, serverFetch, store, protect, unprotect, ownHome, localRequest, now = Date.now, onChange = () => {}, log = () => {}, pollMs = 1000 } = deps;
  const relay = createRelayClient({ base, fetch: deps.fetch ?? fetch });
  const makeProxy = deps.proxyFactory ?? createTunnelProxy;
  const proxies = new Map();
  const proxyStarts = new Map();
  const sessionChecks = new Map();
  const signIns = new Map();
  // what each linked server's agent said in the handshake (vps-link-compat.mjs agentInfo), in memory only
  const peers = new Map();
  let state = read();
  let watching = null, moveTimer = null, closed = false, lastError = null;
  let setupGeneration = 0, setupAbort = null;

  function read() {
    const value = (() => {
      try { return store.read(); } catch (error) {
        if (error instanceof SyntaxError && store.setAside) {
          try { log(`vps link: the saved links could not be read; kept them as ${store.setAside()}`); }
          catch (asideError) { log(`vps link: could not keep the unreadable saved links (${asideError?.message ?? asideError})`); }
        }
        return null;
      }
    })();
    return {
      v: 1,
      pending: record(value?.pending) ? value.pending : null,
      links: Array.isArray(value?.links) ? value.links.filter(record) : [],
      current: typeof value?.current === "string" ? value.current : null,
      move: record(value?.move) ? value.move : null,
      backups: Array.isArray(value?.backups) ? value.backups.filter(record) : [],
    };
  }
  function write() { store.write(state); onChange(view()); }
  const back = createMoveBack({
    link: () => currentLink(), away: () => ownHome.away(), home: () => ownHome.home(), moving: () => !ownHome.away() && ownHome.active?.() === true,
    places: () => deps.places?.() ?? [], who: (place) => deps.who(place), serverCall, local, label: deps.label, log,
    viaLink: async (link) => { const proxy = await signedIn(link); return { freeze: (place) => proxy.control("freeze", { place }), thaw: () => proxy.control("thaw") }; },
    backupHere: () => backupNow("before-restore"), backupFrom: (from, onBytes) => backupNow("from-server", from, onBytes), restoreFile,
    finish: () => { deps.ownHomeReset(); state.move = null; write(); deps.relaunch(); }, onChange: () => onChange(view()), now,
  });

  const currentLink = () => state.links.find((link) => link.id === state.current) ?? null;

  // the install's live terminal: lines each step streams while it runs. kept in memory only, never in the store
  const emptyLive = (id) => ({ id, steps: {}, feed: [], updatedAt: 0, progressAt: 0, error: null, ask: null, fallback: null });
  let live = emptyLive(null);
  const LIVE_STEP_LINES = 200;
  const LIVE_FEED = 400;
  function liveFor(id) { if (live.id !== id) live = emptyLive(id); return live; }
  function steps() {
    const seen = state.pending?.steps ?? (currentLink() ? Object.fromEntries(STEP_IDS.map((id) => [id, { status: "done" }])) : {});
    const lines = state.pending && live.id === state.pending.id ? live.steps : {};
    return STEP_IDS.map((id) => ({
      id, status: seen[id]?.status ?? "waiting", ...(seen[id]?.log ? { log: seen[id].log } : {}),
      ...(lines[id]?.cmd ? { cmd: lines[id].cmd } : {}), ...(lines[id]?.lines?.length ? { lines: lines[id].lines } : {}),
      ...(lines[id]?.progress ? { progress: lines[id].progress } : {}),
      ...(lines[id]?.activity ? { activity: lines[id].activity } : {}),
    }));
  }
  let signInWaiting = false;
  function view() {
    const link = currentLink();
    const pending = state.pending;
    const move = state.move && state.move.linkId === link?.id ? state.move : null;
    let stage = "idle";
    if (move) stage = move.step === "done" ? "moved" : "moving";
    else if (pending) stage = pending.state === "installing" || pending.state === "linking" ? "installing" : "command";
    else if (link) stage = "linked";
    if (lastError && stage === "idle") stage = "error";
    return {
      stage,
      command: pending ? pending.command : null,
      expiresAt: pending?.expiresAt ?? null,
      steps: steps(),
      terminal: state.pending && live.id === state.pending.id ? live.feed : [],
      ask: pending && live.id === pending.id ? live.ask : null,
      ...(pending && live.id === pending.id && live.updatedAt ? { activity: { updatedAt: live.updatedAt, progressAt: live.progressAt, ...(live.error ? { error: live.error } : {}) } }
        : move ? { activity: { updatedAt: move.updatedAt ?? move.startedAt, progressAt: move.progressAt ?? move.startedAt } } : {}),
      server: link ? { id: link.envId, name: link.name, origin: link.origin } : null,
      mode: link?.mode ?? null,
      via: link ? link.via ?? link.mode : null,
      fallback: link?.fallback ?? null,
      compat: link ? compatView(link) : null,
      error: lastError,
      ...(signInWaiting && !pending ? { signIn: true } : {}),
      move: move ? { step: move.step, status: move.status, ...(move.chats ? { chats: move.chats } : {}), ...(move.bytes ? { bytes: move.bytes } : {}), ...(move.waitingFor ? { waitingFor: move.waitingFor } : {}), ...(move.error ? { error: move.error } : {}), ...(move.retryAt ? { retryAt: move.retryAt } : {}), ...(move.backupId ? { backupId: move.backupId } : {}), ...(move.kept ? { kept: true } : {}) } : null,
      ...(back.view() ? { back: back.view() } : {}),
    };
  }

  /** whether the app, the agent and the server agree: null until the agent answered */
  function compatView(link) {
    const info = peers.get(link.id);
    if (!info) return null;
    const { update, message } = linkCompat(info, link.name);
    return { update, message, agent: info.agent, server: info.server?.version ?? null, protocol: info.protocol, legacy: info.legacy, ...(info.update?.staged ? { staged: info.update.staged } : {}) };
  }

  /** asks the agent what it speaks, over the sealed relay; an agent from before the handshake says "unknown request" */
  async function handshake(link, proxy) {
    let said;
    try { said = await proxy.control("hello", { protocol: APP_LINK_PROTOCOL, app: deps.appVersion ?? null }, 15_000); }
    catch (error) {
      if (!/unknown request/.test(String(error?.message))) {
        const direct = proxy.agentHello?.();
        if (direct) said = direct;
        else { log(`vps link: ${link.name} did not say what it speaks (${error?.message ?? error})`); return; }
      } else said = null;
    }
    if (closed || proxies.get(link.id) !== proxy) return;
    readdress(link, said?.address);
    const info = agentInfo(said);
    const before = JSON.stringify(compatView(link));
    peers.set(link.id, info);
    const after = compatView(link);
    if (after.update) log(`vps link: ${after.message} (app protocol ${APP_LINK_PROTOCOL}, agent ${info.agent ?? "older"} protocol ${info.protocol}, server ${info.server?.version ?? "unknown"})`);
    // an agent too old for this app or its server that can update itself looks for a release now, not in six hours
    if (after.update === "agent" && info.caps.includes("self-update")) void proxy.control("update", {}, 180_000).catch((error) => log(`vps link: ${link.name} did not update its link (${error?.message ?? error})`));
    if (JSON.stringify(after) !== before) onChange(view());
  }

  /** the agent's word, inside the sealed tunnel, on where its server is now: a quick tunnel's new name after a restart,
   * or another way chosen when the install ran again. the app follows it and signs in there again */
  function readdress(link, address) {
    if (!record(address) || address.mode !== "direct" || !ADDRESS_VIAS.has(address.via)) return;
    let origin;
    try { origin = new URL(address.origin); } catch { return; }
    if (origin.protocol !== "https:" || origin.origin !== address.origin || origin.port) return;
    const spki = typeof address.spki === "string" && /^[A-Za-z0-9+/]{43}=$/.test(address.spki) ? address.spki : null;
    if (address.spki != null && !spki) return;
    if (!spki && address.via !== "tailscale" && address.via !== "cloudflare") return;
    if (link.mode === "direct" && link.origin === origin.origin && (link.spki ?? null) === spki && (link.via ?? "direct") === address.via) return;
    // the same address the relay stands in for: the address check moves back once it answers
    if (link.away && link.away.origin === origin.origin && (link.away.spki ?? null) === spki) return;
    const from = link.origin;
    log(`vps link: ${link.name} is now at ${origin.origin} (${address.via})`);
    Object.assign(link, { mode: "direct", via: address.via, origin: origin.origin, spki });
    delete link.away;
    delete link.fallback;
    deps.pin?.(origin.host, spki);
    if (from && from !== origin.origin) deps.retarget?.(from, origin.origin);
    write();
    if (state.links.includes(link)) void signedIn(link).catch((error) => log(`vps link: ${link.name} sign-in at its new address failed (${error?.message ?? error})`));
  }

  // ---- setup ----

  function invalidateSetup() {
    setupGeneration += 1;
    setupAbort?.abort();
    setupAbort = null;
  }

  function revokeUnused(made) {
    void relay.cancel(made.id, made.watch).catch((error) => log(`vps link: unused command could not be cancelled (${error?.message ?? error})`));
  }

  async function start() {
    if (closed) return view();
    invalidateSetup();
    const generation = setupGeneration;
    const abort = new AbortController();
    setupAbort = abort;
    const active = () => !closed && !abort.signal.aborted && generation === setupGeneration;
    if (state.pending) await cancelPending();
    if (!active()) return view();
    lastError = null;
    const keys = newLinkKeys();
    let made;
    try {
      // the link service opens a setup session only for a signed-in dusk account (apps/link-service/src/grant.mjs)
      const grant = deps.linkGrant ? await deps.linkGrant().catch(() => null) : null;
      if (deps.linkGrant && !active()) return view();
      made = await relay.create({ verifier: keys.verifier, appPub: keys.pub, label: deps.label().slice(0, 60), ...(grant ? { grant } : {}) }, abort.signal);
      if (!active()) { revokeUnused(made); return view(); }
      const [watchP, privP] = await Promise.all([protect(made.watch), protect(keys.priv)]);
      if (!active()) { revokeUnused(made); return view(); }
      const token = `${made.id}-${keys.secret}`;
      const short = relay.short ? await relay.short(made.id, made.watch, keys.secret, abort.signal).catch(() => null) : null;
      if (!active()) { revokeUnused(made); return view(); }
      state.pending = {
        id: made.id, state: "waiting", after: 0, steps: {}, createdAt: now(), expiresAt: made.expiresAt,
        command: SHORT_URL.test(short?.url ?? "") ? shortInstallLine(short.url) : installLine(made.base, token), watchP, privP, pub: keys.pub,
      };
      state.current = null;
      write();
      follow();
      return view();
    } catch (error) {
      if (made) revokeUnused(made);
      if (!active()) return view();
      // not signed in to an account: the sign-in continues in the browser, and the line is made by itself once it is done
      if (error?.code === "account_required" && deps.signIn) {
        signInWaiting = true; lastError = null;
        void Promise.resolve().then(() => deps.signIn()).catch(() => {});
        onChange(view());
        return view();
      }
      lastError = plain(error, "The link service did not answer. Check your internet and try again.");
      onChange(view());
      throw new Error(lastError);
    } finally {
      if (setupAbort === abort) setupAbort = null;
    }
  }

  async function cancelPending() {
    const pending = state.pending;
    stopFollowing();
    if (pending) {
      state.pending = null;
      write();
      void unprotect(pending.watchP).then((watch) => relay.cancel(pending.id, watch)).catch((error) => log(`vps link: cancel did not reach the link service (${error?.message ?? error})`));
      await proxyStarts.get(pending.id)?.catch(() => {});
      if (!state.links.some((link) => link.id === pending.id)) {
        await proxies.get(pending.id)?.close();
        proxies.delete(pending.id);
      }
    }
  }

  /** the account is signed in now: a line that waited on that is made at once */
  async function accountReady() {
    if (!signInWaiting || closed) return view();
    signInWaiting = false;
    try { return await start(); } catch { return view(); }
  }
  async function cancel() {
    signInWaiting = false;
    invalidateSetup();
    await cancelPending();
    return view();
  }

  function stopFollowing() { watching?.abort(); watching = null; }

  /** follows the install as it reports, through sleeps and lost connections, until linked, cancelled or expired */
  function follow() {
    if (watching || !state.pending) return;
    const abort = new AbortController();
    watching = abort;
    void (async () => {
      let failures = 0;
      while (!abort.signal.aborted && state.pending) {
        const pending = state.pending;
        try {
          const got = await relay.watch(pending.id, await unprotect(pending.watchP), pending.after, AbortSignal.any([abort.signal, AbortSignal.timeout(40_000)]));
          if (abort.signal.aborted || state.pending !== pending || closed) break;
          failures = 0;
          let changed = false;
          let streamed = false;
          const contact = liveFor(pending.id);
          const recovered = Boolean(contact.error);
          contact.updatedAt = now();
          contact.error = null;
          for (const event of got.events ?? []) {
            pending.after = Math.max(pending.after, event.seq);
            if (!STATUSES.has(event.status) || typeof event.step !== "string") continue;
            const at = Number.isFinite(event.at) ? Math.min(now(), event.at) : now();
            const quietMs = Number.isFinite(event.activity?.quietMs) && event.activity.quietMs >= 0 ? event.activity.quietMs : 0;
            if (record(event.activity) || event.heartbeat !== true) contact.progressAt = Math.max(contact.progressAt, at - quietMs);
            const progress = installProgress(event.progress);
            if (Number.isFinite(event.activity?.elapsedMs) && event.activity.elapsedMs >= 0) {
              (contact.steps[event.step] ??= { lines: [] }).activity = { elapsedMs: event.activity.elapsedMs, quietMs, at };
            }
            if (progress) {
              (contact.steps[event.step] ??= { lines: [] }).progress = progress;
              streamed = true;
            }
            if (record(event.activity) || event.heartbeat === true) streamed = true;
            if (event.heartbeat === true) continue;
            if (record(event.ask)) {
              const ask = installAsk(event.ask);
              if (ask !== undefined) { contact.ask = ask; streamed = true; }
              continue;
            }
            if (Array.isArray(event.lines) || typeof event.cmd === "string") {
              const mirror = liveFor(pending.id);
              const lines = (Array.isArray(event.lines) ? event.lines : []).filter((line) => typeof line === "string").map((line) => line.slice(0, 400));
              const own = (mirror.steps[event.step] ??= { lines: [] });
              if (typeof event.cmd === "string") own.cmd = event.cmd.slice(0, 300);
              own.lines = own.lines.concat(lines).slice(-LIVE_STEP_LINES);
              mirror.feed = mirror.feed.concat(lines.map((text) => ({ step: event.step, text }))).slice(-LIVE_FEED);
              // the way asked for could not finish (install.sh relay_address): why, kept for the done screen
              if (event.step === "address") for (const line of lines) if (/; using the private relay/.test(line)) mirror.fallback = line.trim().slice(0, 200);
              streamed = true;
              // a late batch never takes a finished step back to running
              if (event.status === "running" && pending.steps[event.step]) continue;
            }
            if (!STEP_IDS.includes(event.step)) continue;
            if (event.status === "running" && (progress || record(event.activity)) && ["done", "skipped", "failed"].includes(pending.steps[event.step]?.status)) continue;
            const previous = pending.steps[event.step];
            const nextLog = event.status === "failed" && typeof event.log === "string" ? event.log.slice(-4000) : undefined;
            if (previous?.status === event.status && previous?.log === nextLog) continue;
            if (event.status === "running" && previous && previous.status !== "running") contact.steps[event.step] = { lines: [] };
            pending.steps[event.step] = { status: event.status, ...(nextLog ? { log: nextLog } : {}) };
            if (event.step === "address" && event.status !== "running" && contact.ask?.state !== "done") contact.ask = null;
            changed = true;
          }
          if (got.state === "installing" && pending.state === "waiting") { pending.state = "installing"; changed = true; }
          if (got.state === "linked") { pending.state = "linking"; write(); await finish(pending, got, abort.signal); continue; }
          if (got.state === "expired" || got.state === "cancelled") {
            state.pending = null;
            lastError = got.state === "expired" ? "This command expired before your server used it. Make a new one." : null;
            write();
            break;
          }
          if (changed) write();
          else if (streamed || recovered) onChange(view());
        } catch (error) {
          if (abort.signal.aborted) break;
          if (error?.status === 404) { state.pending = null; lastError = "This command expired. Make a new one."; write(); break; }
          failures += 1;
          const contact = liveFor(pending.id);
          contact.error = "Setup updates paused. Reconnecting to your server.";
          if (!contact.updatedAt) contact.updatedAt = now();
          onChange(view());
          await sleep(Math.min(15_000, 500 * 2 ** Math.min(failures, 5)), undefined, { signal: abort.signal }).catch(() => {});
        }
      }
      if (watching === abort) watching = null;
    })();
  }

  async function signInTo(origin, code, signal) {
    const response = await serverFetch(`${origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "include", cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json", origin },
      body: JSON.stringify({ code, cookie: true, label: deps.label().slice(0, 60) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(typeof body?.error === "string" ? body.error : `your server answered ${response.status}.`), { status: response.status });
    return body;
  }

  async function proxyFor(link) {
    if (closed) throw new Error("The app is closing.");
    if (proxyStarts.has(link.id)) return proxyStarts.get(link.id);
    if (proxies.has(link.id)) return proxies.get(link.id);
    const starting = (async () => {
      const [key, token] = await Promise.all([unprotect(link.keyP), unprotect(link.tokenP)]);
      if (closed) throw new Error("The app is closing.");
      const hello = { protocol: APP_LINK_PROTOCOL, app: deps.appVersion ?? null };
      let proxy = makeProxy({ base: link.base ?? base, id: link.id, key, token, port: link.port ?? 0, log, egress: deps.egress, hello, follow: true, screenIce: deps.screenIce, proxy: deps.proxy, report: true });
      proxies.set(link.id, proxy);
      let origin;
      try {
        try { origin = await proxy.start(); }
        catch (error) {
          if (error?.code !== "EADDRINUSE" || closed) throw error;
          await proxy.close();
          proxy = makeProxy({ base: link.base ?? base, id: link.id, key, token, port: 0, log, egress: deps.egress, hello, follow: true, screenIce: deps.screenIce, proxy: deps.proxy, report: true });
          proxies.set(link.id, proxy);
          origin = await proxy.start();
        }
        if (closed) throw new Error("The app is closing.");
        const port = Number(new URL(origin).port);
        relayOrigins.set(link.id, origin);
        if (link.mode === "relay" && link.origin !== origin) {
          if (link.origin) deps.retarget?.(link.origin, origin);
          link.origin = origin;
          link.port = port;
          write();
        }
        void handshake(link, proxy).finally(() => directFor(link, proxy));
        watchAddress(link, proxy);
        return proxy;
      } catch (error) {
        if (proxies.get(link.id) === proxy) proxies.delete(link.id);
        await proxy.close();
        throw error;
      }
    })();
    proxyStarts.set(link.id, starting);
    try { return await starting; }
    finally { if (proxyStarts.get(link.id) === starting) proxyStarts.delete(link.id); }
  }

  // ---- an https address (tailscale, cloudflare, a domain, the server's IP) that stops answering ----
  // checked every minute while its tunnel is open: on a miss the agent is asked where its server is now (a quick tunnel
  // gets a new name when it restarts); still no answer, and the window goes through the relay (link.away keeps the
  // address) until the address answers again

  const ADDRESS_CHECK_MS = deps.addressCheckMs ?? 60_000;
  const relayOrigins = new Map();
  const addressTimers = new Map();

  /** where the server is now: its agent over the relay, or, when that cannot answer, the address it sealed into the directory */
  async function relearn(link, proxy) {
    const before = link.away?.origin ?? link.origin;
    await handshake(link, proxy);
    if ((link.away?.origin ?? link.origin) !== before || closed || proxies.get(link.id) !== proxy) return;
    const sealed = await proxy.sealedAddress?.().catch(() => null);
    if (sealed && !closed && proxies.get(link.id) === proxy) readdress(link, sealed);
  }

  async function answers(origin) {
    try {
      const response = await serverFetch(`${origin}/api/health`, { cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      return response.ok;
    } catch { return false; }
  }

  /** the window goes through the relay while the address does not answer; null when there is no relay to use */
  function standIn(link) {
    const relayOrigin = relayOrigins.get(link.id);
    if (!relayOrigin || link.mode !== "direct" || !link.origin) return null;
    log(`vps link: ${link.name} does not answer at ${link.origin}; using the relay until it does`);
    const from = link.origin;
    link.away = { via: link.via ?? "direct", origin: link.origin, spki: link.spki ?? null };
    Object.assign(link, { mode: "relay", via: "relay", origin: relayOrigin, port: Number(new URL(relayOrigin).port), spki: null });
    trail("link.path", { link: shortHash(link.id), from: link.away.via, to: "relay", reason: "address-not-answering" });
    if (from !== relayOrigin) deps.retarget?.(from, relayOrigin);
    return link;
  }

  function comeBack(link) {
    const { away } = link;
    delete link.away;
    log(`vps link: ${link.name} answers at ${away.origin} again`);
    const from = link.origin;
    Object.assign(link, { mode: "direct", via: away.via, origin: away.origin, spki: away.spki });
    trail("link.path", { link: shortHash(link.id), from: "relay", to: away.via, reason: "address-answers" });
    if (away.spki) deps.pin?.(new URL(away.origin).host, away.spki);
    if (from && from !== away.origin) deps.retarget?.(from, away.origin);
    write();
    void signedIn(link).catch((error) => log(`vps link: ${link.name} sign-in at ${away.origin} failed (${error?.message ?? error})`));
  }

  function watchAddress(link, proxy) {
    if (addressTimers.has(link.id)) return;
    let misses = 0;
    const tick = async () => {
      if (closed || proxies.get(link.id) !== proxy) { addressTimers.delete(link.id); return; }
      try {
        if (!state.links.includes(link)) { /* still linking */ }
        else if (link.away) {
          if (await answers(link.away.origin)) comeBack(link);
          else await relearn(link, proxy);
        }
        else if (link.mode === "direct" && link.origin) {
          if (await answers(link.origin)) misses = 0;
          else if (++misses === 1) await relearn(link, proxy);
          else {
            misses = 0;
            if (!closed && proxies.get(link.id) === proxy && link.mode === "direct" && standIn(link)) {
              write();
              void signedIn(link).catch((error) => log(`vps link: ${link.name} sign-in through the relay failed (${error?.message ?? error})`));
            }
          }
        }
      } catch (error) { log(`vps link: checking ${link.name}'s address failed (${error?.message ?? error})`); }
      if (!closed && addressTimers.has(link.id)) addressTimers.set(link.id, setTimeout(tick, ADDRESS_CHECK_MS));
    };
    addressTimers.set(link.id, setTimeout(tick, ADDRESS_CHECK_MS));
  }

  // ---- the direct path: this app's own ssh key on the server, restricted to the agent's direct command ----

  const DIRECT_RETRY_MS = 6 * 60 * 60_000;
  const REPROVISION_MS = 60 * 60_000;
  const directValid = (value) => record(value) && value.v === 1 && typeof value.host === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(value.host)
    && Number.isInteger(value.port) && value.port > 0 && value.port < 65536 && typeof value.user === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(value.user)
    && Array.isArray(value.hostKeys) && value.hostKeys.length > 0 && value.hostKeys.length <= 6
    && value.hostKeys.every((entry) => typeof entry === "string" && /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/.test(entry));

  const WSS_RETRY_MS = 60 * 60_000;
  const wssValid = (value) => record(value) && value.v === 1 && typeof value.url === "string" && /^wss:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]*$/i.test(value.url)
    && typeof value.spki === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value.spki);

  /** asks the agent (over the sealed relay) to accept a new key, once; an older agent says no and is asked again later */
  async function sshFor(link, proxy) {
    if (directValid(link.direct)) return;
    if (link.directRefusedAt && now() - link.directRefusedAt < DIRECT_RETRY_MS) return;
    try {
      const pair = deps.direct.newKey();
      const answer = await proxy.control("direct-key", { pub: pair.publicKey });
      if (closed || !state.links.includes(link)) return;
      const config = { v: 1, host: answer?.host, port: answer?.port, user: answer?.user, hostKeys: answer?.hostKeys };
      if (!directValid(config)) throw new Error("the server's direct link details were not usable");
      link.direct = { ...config, keyP: await protect(pair.privateKey), at: now() };
      delete link.directRefusedAt;
      write();
    } catch (error) {
      if (/unknown request/.test(String(error?.message))) { link.directRefusedAt = now(); write(); return; }
      log(`vps link: ${link.name} has no direct path over ssh (${error?.message ?? error})`);
    }
  }

  /** the server's https address for the direct path and its pinned key, asked over the sealed relay; again an hour later when it had none */
  async function wssFor(link, proxy) {
    if (!deps.direct.wssConnector || wssValid(link.wss)) return;
    const lacking = missingCap(peers.get(link.id), "direct-wss", link.name);
    if (lacking) { log(`vps link: ${lacking}`); return; }
    if (link.wssCheckedAt && now() - link.wssCheckedAt < WSS_RETRY_MS) return;
    try {
      const answer = await proxy.control("direct-wss", {});
      if (closed || !state.links.includes(link)) return;
      const config = { v: 1, url: answer?.url, spki: answer?.spki };
      if (!wssValid(config)) throw new Error("the server's https details were not usable");
      link.wss = { ...config, at: now() };
      delete link.wssCheckedAt;
      write();
    } catch (error) {
      link.wssCheckedAt = now();
      write();
      log(`vps link: ${link.name} has no direct path over https (${error?.message ?? error})`);
    }
  }

  const CLOUD_RETRY_MS = 60 * 60_000;
  /**
   * the cloud relay for this link: registered once with a link grant (which binds the tunnel to this dusk account), again
   * when the relay forgot it, at most hourly after a refusal. null where the agent or the account cannot use it
   */
  async function cloudFor(link, proxy) {
    const cloud = deps.direct.cloud;
    if (!cloud?.url || !peers.get(link.id)?.caps?.includes("cloud-relay")) return null;
    const key = await unprotect(link.keyP);
    if (closed || proxies.get(link.id) !== proxy) return null;
    if (link.cloud?.url !== cloud.url) {
      if (link.cloudCheckedAt && now() - link.cloudCheckedAt < CLOUD_RETRY_MS) return null;
      try {
        const grant = deps.linkGrant ? await deps.linkGrant().catch(() => null) : null;
        await cloud.register({ url: cloud.url, id: link.id, key, grant });
        link.cloud = { url: cloud.url, at: now() };
        delete link.cloudCheckedAt;
      } catch (error) {
        link.cloudCheckedAt = now();
        log(`vps link: ${link.name} stays on the link service relay (${error?.message ?? error})`);
      }
      write();
      if (!link.cloud || closed || proxies.get(link.id) !== proxy) return null;
    }
    return { name: "cloud", connect: cloud.connector({ url: cloud.url, id: link.id, key }) };
  }

  /** webrtc (vps-link-rtc.mjs): udp straight to the server where hole punching works, cloudflare's turn where it does not;
   * signalled over the sealed tunnel. null where this app has no node-datachannel or the agent is older */
  function rtcFor(link, proxy) {
    const rtc = deps.direct?.rtc;
    if (!rtc || link.directOff || !peers.get(link.id)?.caps?.includes("direct-rtc")) return null;
    const connect = rtc.connector({ signal: (offer) => proxy.control("direct-rtc", { offer }, 15_000) });
    return { name: "rtc", connect: async () => {
      const opened = await connect();
      log(`vps link: ${link.name} direct over webrtc (${opened.path}, ${opened.pair})`);
      return opened;
    } };
  }

  /**
   * the server's cloudflare backup path (a quick tunnel to its direct listener; the frames on it are sealed like on every
   * path): asked over the sealed tunnel, or read from the address it sealed into the directory when that cannot answer
   */
  const CF_ASK_MS = 10 * 60_000;
  async function cfFor(link, proxy) {
    if (!peers.get(link.id)?.caps?.includes("direct-cf") || !deps.direct?.wssConnector) return null;
    if (!link.cf || now() - (link.cf.at ?? 0) > CF_ASK_MS) {
      let url = await proxy.control("direct-cf", {}, 10_000).then((answer) => answer?.url, () => null);
      url ??= (await proxy.sealedAddress?.().catch(() => null))?.backup ?? null;
      if (typeof url === "string" && /^wss:\/\/[a-z0-9-]+\.trycloudflare\.com\/[A-Za-z0-9._~/-]*$/.test(url)) { link.cf = { url, at: now() }; write(); }
    }
    if (!link.cf?.url) return null;
    return { name: "cf", connect: deps.direct.wssConnector({ url: link.cf.url, spki: null, via: "cf" }) };
  }

  const SETUP_AGAIN_MS = deps.setupAgainMs ?? [15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000];
  const setupTries = new Map();
  /** setup that came back short is asked again (SETUP_AGAIN_MS): with no ways yet, all of it; with ways up already, only
   * the hello and the cloudflare address, which join the running list (orderedConnect reads it on every dial) so the
   * live direct path is not dropped for it */
  function setupAgain(link, proxy, ways = null) {
    const was = setupTries.get(link.id);
    if (was?.timer || closed) return;
    const tries = was?.tries ?? 0;
    const timer = setTimeout(async () => {
      setupTries.set(link.id, { tries: tries + 1 });
      if (closed || proxies.get(link.id) !== proxy) return;
      if (!peers.has(link.id)) await handshake(link, proxy).catch(() => {});
      if (closed || proxies.get(link.id) !== proxy) return;
      if (!ways?.length) { void directFor(link, proxy); return; }
      const cf = ways.some((one) => one.name === "cf") ? null : await cfFor(link, proxy);
      if (closed || proxies.get(link.id) !== proxy) return;
      if (cf) {
        const at = ways.findIndex((one) => one.name === "cloud");
        ways.splice(at < 0 ? ways.length : at, 0, cf);
      }
      if (cfPending(link, ways)) setupAgain(link, proxy, ways);
      else setupTries.delete(link.id);
    }, SETUP_AGAIN_MS[Math.min(tries, SETUP_AGAIN_MS.length - 1)]);
    timer.unref?.();
    setupTries.set(link.id, { tries, timer });
  }
  /** a server that has (or may have, its hello not heard yet) a cloudflare backup whose address is not known yet */
  const cfPending = (link, ways) => !ways.some((one) => one.name === "cf") && Boolean(deps.direct?.wssConnector) && (!peers.has(link.id) || Boolean(peers.get(link.id)?.caps?.includes("direct-cf")));

  /** the ways to the server: ssh, https on 443, webrtc, then the cloudflare backup, then the cloud relay; the link service relay stays underneath them */
  async function directFor(link, proxy) {
    if (!deps.direct || closed || proxy.useDirect === undefined) return;
    if (link.directOff && link.directRevoke) await revokeDirect(link, proxy);
    if (!link.directOff) await Promise.all([sshFor(link, proxy), wssFor(link, proxy)]);
    if (closed || proxies.get(link.id) !== proxy) return;
    const ssh = !link.directOff && directValid(link.direct) ? link.direct : null, wss = !link.directOff && wssValid(link.wss) ? link.wss : null;
    const ways = [];
    if (ssh) {
      const privateKey = await unprotect(ssh.keyP);
      if (closed || proxies.get(link.id) !== proxy) return;
      ways.push({ name: "ssh", connect: deps.direct.connector({ host: ssh.host, port: ssh.port, user: ssh.user, privateKey, hostKeys: ssh.hostKeys }) });
    }
    if (wss) ways.push({ name: "wss", connect: deps.direct.wssConnector({ url: wss.url, spki: wss.spki }) });
    const rtc = rtcFor(link, proxy);
    if (rtc) ways.push(rtc);
    const cf = await cfFor(link, proxy);
    if (closed || proxies.get(link.id) !== proxy) return;
    if (cf) ways.push(cf);
    const cloud = await cloudFor(link, proxy);
    if (closed || proxies.get(link.id) !== proxy) return;
    if (cloud) ways.push(cloud);
    // nothing to dial yet (the hello or the key exchange failed, say behind a captive portal), or no cloudflare address
    // yet (a tunnel still starting): asked again soon
    const pending = cfPending(link, ways);
    if (!ways.length ? !link.directOff || !peers.has(link.id) : pending) setupAgain(link, proxy, ways.length ? ways : null);
    else setupTries.delete(link.id);
    if (!ways.length) return;
    const registered = link.cloud;
    proxy.useDirect({
      connect: ways.length === 1 && !pending ? ways[0].connect : orderedConnect(ways, { log }),
      pingMs: (via) => (via === "cloud" || via === "cf" ? 20_000 : 5000),
      // the key was removed, the server was reinstalled or its https key changed: ask again over the sealed tunnel, at most once an hour
      onFailure: (error) => {
        let again = false;
        for (const one of error?.errors ?? [error]) {
          if ((one?.level === "client-authentication" || one?.code === "HOSTKEY") && ssh && link.direct === ssh && !(ssh.at && now() - ssh.at < REPROVISION_MS)) {
            log(`vps link: ${link.name}'s direct path needs a new key (${one?.message ?? one})`);
            delete link.direct;
            again = true;
          }
          if (one?.via === "cloud" || (ways.length === 1 && cloud)) {
            if (one?.status === 404 && registered && link.cloud === registered && !(registered.at && now() - registered.at < REPROVISION_MS)) {
              log(`vps link: the cloud relay forgot ${link.name}; registering it again`);
              delete link.cloud;
              again = true;
            }
            continue;
          }
          // a quick tunnel's name changes when cloudflared restarts: a failed one is asked for again (at most every minute)
          if ((one?.via === "cf" || (ways.length === 1 && cf)) && link.cf && now() - (link.cf.at ?? 0) > 60_000) {
            delete link.cf;
            again = true;
            continue;
          }
          if (one?.code === "PIN" && wss && link.wss === wss && !(wss.at && now() - wss.at < REPROVISION_MS)) {
            log(`vps link: ${link.name}'s https key changed; asking the server for it again`);
            delete link.wss;
            again = true;
          }
        }
        if (!again) return;
        write();
        void directFor(link, proxy);
      },
    });
  }

  /** takes this app's key off the server; a server that does not answer is asked again when its tunnel next opens */
  async function revokeDirect(link, proxy, timeoutMs = 30_000) {
    try {
      await proxy.control("direct-off", {}, timeoutMs);
      if (link.directRevoke) { delete link.directRevoke; write(); }
      return true;
    } catch (error) {
      log(`vps link: ${link.name} did not take the direct key off yet (${error?.message ?? error})`);
      return false;
    }
  }

  const linkAt = (origin) => {
    let wanted;
    try { wanted = new URL(origin).origin; } catch { return null; }
    return state.links.find((entry) => { try { return Boolean(entry.origin) && new URL(entry.origin).origin === wanted; } catch { return false; } }) ?? null;
  };

  /** which way this app reaches the linked server at `origin` right now, for the trail; null where none is linked there */
  function pathAt(origin) {
    const link = linkAt(origin);
    if (!link) return null;
    const proxy = proxies.get(link.id);
    const directVia = proxy?.directVia?.() ?? null;
    // a link whose address is https (tailscale, cloudflare, a domain) goes there itself; a relay link may ride a direct path
    const via = link.mode === "direct" ? link.via ?? "direct" : proxy?.transport?.() === "direct" && directVia ? directVia : "relay";
    return { place: "linked", link: shortHash(link.id), path: via === "relay" || via === "cloud" ? "relay" : "direct", via, ...(link.away ? { away: link.away.via } : {}), ...(link.directOff ? { directOff: true } : {}) };
  }

  /** Settings > Computer "Fast direct connection" for the linked server at `origin`: null where it does not apply */
  function directSetting(origin) {
    const link = linkAt(origin);
    if (!link || link.mode !== "relay" || !deps.direct) return null;
    const proxy = proxies.get(link.id);
    // the cloud relay is a relay; the server's cloudflare tunnel is its own
    const via = proxy?.transport?.() === "direct" ? proxy.directVia?.() : null;
    const path = !via || via === "cloud" ? "relay" : via === "cf" ? "cloudflare" : "direct";
    return { on: !link.directOff, path, ...(path === "direct" && proxy?.directVia?.() ? { via: proxy.directVia() } : {}) };
  }

  /** turned off: the direct path closes and the server drops this app's key (direct-off); turned on: a new key is set up */
  async function setDirect(origin, on) {
    const link = linkAt(origin);
    if (!link || link.mode !== "relay" || !deps.direct) return null;
    const proxy = proxies.get(link.id) ?? null;
    if (on) {
      if (link.directOff || link.directRevoke) { delete link.directOff; delete link.directRevoke; delete link.directRefusedAt; delete link.wssCheckedAt; write(); }
      if (proxy) void directFor(link, proxy);
      return directSetting(origin);
    }
    if (!link.directOff) {
      link.directOff = true;
      link.directRevoke = true;
      delete link.direct;
      delete link.wss;
      write();
    }
    proxy?.useDirect?.(null);
    if (proxy && link.directRevoke) await revokeDirect(link, proxy);
    // the cloud relay is a relay, not a direct path: it stays on
    if (proxy) void directFor(link, proxy);
    return directSetting(origin);
  }

  /**
   * the link on the current server looks for a newer release and restarts into it now (the person asked, so it does
   * not wait for the link to fall idle); a link without self-update says how to update it instead
   */
  async function updateLink() {
    const link = needLink();
    const proxy = await proxyFor(link);
    const lacking = missingCap(peers.get(link.id) ?? agentInfo(null), "self-update", link.name);
    if (lacking) throw new Error(lacking);
    const answer = await proxy.control("update", { apply: "now" }, 180_000);
    return { running: answer?.running ?? null, staged: answer?.staged ?? null, restarting: answer?.restarting === true, ...(typeof answer?.error === "string" ? { error: answer.error } : {}) };
  }

  /** after a wake or a network change; a server whose agent did not answer the handshake yet is asked again */
  function nudge() {
    for (const [id, proxy] of proxies) {
      proxy.nudge?.();
      const link = state.links.find((entry) => entry.id === id);
      if (link && !peers.has(id)) void handshake(link, proxy).finally(() => directFor(link, proxy));
    }
  }

  async function finish(pending, got, signal) {
    const active = () => !closed && !signal.aborted && state.pending === pending;
    let link = null;
    try {
      const priv = await unprotect(pending.privP);
      if (!active()) return;
      const result = openResult({ id: pending.id, priv, pub: pending.pub, vpsPub: got.vpsPub, sealed: got.sealed });
      const [keyP, tokenP] = await Promise.all([protect(result.tunnel.key), protect(result.tunnel.token)]);
      if (!active()) return;
      link = {
        id: pending.id, base, name: result.name, mode: result.mode, via: ADDRESS_VIAS.has(result.via) ? result.via : result.mode, origin: result.mode === "direct" ? result.origin : null, port: null,
        spki: result.spki ?? null, environmentId: result.environmentId ?? null, envId: null, at: now(), keyP, tokenP,
        // pinned here when the agent sent it inside the sealed result; an older agent's link pins it on first use instead
        sealIdentity: typeof result.sealIdentity === "string" && SEAL_IDENTITY.test(result.sealIdentity) ? result.sealIdentity : null,
        ...(result.mode !== "direct" && live.id === pending.id && live.fallback ? { fallback: live.fallback } : {}),
      };
      if (link.mode === "direct") deps.pin?.(new URL(link.origin).host, link.spki);
      const proxy = await proxyFor(link);
      if (!active()) return;
      // an address this computer cannot reach (not on the tailnet yet, a name still spreading): the relay until it can
      if (link.mode === "direct" && !(await answers(link.origin))) {
        if (!active()) return;
        standIn(link);
      }
      let paired;
      try { paired = await signInTo(link.origin, result.pairing.code, signal); }
      catch {
        if (!active()) return;
        const minted = await proxy.control("pair", { label: deps.label() });
        if (!active()) return;
        paired = await signInTo(link.origin, minted.code, signal);
      }
      if (!active()) return;
      const environmentId = paired?.environment?.environmentId;
      if (link.environmentId && environmentId && environmentId !== link.environmentId) throw new Error("A different server answered at that address, so this app did not link to it.");
      link.envId = deps.saveServer({ origin: link.origin, name: link.name });
      // the same server linked again (its setup line run once more): its agent ended the tunnel before, so that record goes
      const replaced = link.environmentId ? state.links.filter((entry) => entry.id !== link.id && entry.environmentId === link.environmentId) : [];
      for (const old of replaced) {
        await proxies.get(old.id)?.close();
        proxies.delete(old.id);
        peers.delete(old.id);
        if (old.envId && old.envId !== link.envId) deps.forgetServer(old.envId, { replaced: true });
        if (state.move?.linkId === old.id) state.move.linkId = link.id;
      }
      state.links = [...state.links.filter((entry) => entry.id !== link.id && !replaced.includes(entry)), link];
      state.pending = null;
      state.current = link.id;
      lastError = null;
      write();
    } catch (error) {
      if (!active()) return;
      log(`vps link: linking failed (${error?.message ?? error})`);
      state.pending = null;
      lastError = plain(error, "Your server finished installing, but this app could not link to it. Make a new command and run it again.");
      write();
    } finally {
      if (link && !state.links.some((saved) => saved.id === link.id)) {
        const proxy = proxies.get(link.id);
        proxies.delete(link.id);
        await proxy?.close();
      }
    }
  }

  /** this app's sign-in at the server, made again through the agent when it lapsed */
  async function signedIn(link) {
    if (sessionChecks.has(link.id)) return sessionChecks.get(link.id);
    const checking = (async () => {
      const proxy = await proxyFor(link);
      const response = await serverFetch(`${link.origin}/api/auth/session`, { credentials: "include", cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
      const body = response?.ok ? await response.json().catch(() => null) : null;
      if (body?.kind === "session") return proxy;
      const minted = await proxy.control("pair", { label: deps.label() });
      await signInTo(link.origin, minted.code);
      return proxy;
    })();
    sessionChecks.set(link.id, checking);
    try { return await checking; }
    finally { if (sessionChecks.get(link.id) === checking) sessionChecks.delete(link.id); }
  }

  async function serverCall(link, method, route, body) {
    const response = await serverFetch(`${link.origin}${route}`, {
      method, redirect: "error", credentials: "include", cache: "no-store",
      headers: { accept: "application/json", origin: link.origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(typeof parsed?.error === "string" ? parsed.error : `your server answered ${response.status}.`), { status: response.status });
    return parsed;
  }
  function needLink() {
    const link = currentLink();
    if (!link?.origin) throw new Error("Link a server first.");
    return link;
  }

  // ---- ai sign-in: on this mac, then sent to the server over the sealed tunnel ----

  async function engines() {
    const link = needLink();
    await signedIn(link);
    return readEngines(link);
  }

  async function readEngines(link) {
    const { instances = [] } = await serverCall(link, "GET", "/api/instances?fresh=1");
    // the server names the engine in driverKind (claudeAgent, codex); older servers used driver
    const kindOf = (instance) => {
      const driver = instance?.driverKind ?? instance?.driver;
      if (instance?.instanceId === "claude" && (driver === "claudeAgent" || driver === "claude")) return "claude";
      if (instance?.instanceId === "codex" && driver === "codex") return "codex";
      return null;
    };
    return instances.filter((instance) => kindOf(instance) !== null).map((instance) => ({
      instanceId: instance.instanceId, kind: kindOf(instance), name: instance.displayName || (kindOf(instance) === "claude" ? "Claude" : "ChatGPT"),
      signedIn: instance.snapshot?.authenticated === true,
    }));
  }

  const signInView = (flow) => ({ flowId: flow.flowId, phase: flow.phase, authorizationUrl: flow.authorizationUrl ?? null, ...(flow.userCode ? { userCode: flow.userCode } : {}), needsCode: flow.needsCode === true, ...(flow.message ? { message: flow.message } : {}) });

  async function signIn(instanceId) {
    const link = needLink();
    const proxy = await signedIn(link);
    const all = await readEngines(link);
    const engine = all.find((entry) => entry.instanceId === instanceId);
    if (!engine) throw new Error("That AI is not on your server.");
    if (engine.kind === "codex") {
      const auth = await deps.localCredentials.codexAuth().catch(() => null);
      if (auth) {
        await proxy.control("codex-auth", { auth });
        return signInView({ flowId: null, phase: "succeeded" });
      }
    }
    if (engine.kind === "claude") {
      const cli = await deps.localCredentials.claudeCli().catch(() => null);
      if (cli) {
        const abort = new AbortController();
        const flowId = `local-${randomBytes(9).toString("base64url")}`;
        const flow = { flowId, phase: "waiting", authorizationUrl: null, abort, message: "Finish signing in to Claude in your browser." };
        signIns.set(flowId, flow);
        deps.localCredentials.claudeToken(cli, abort.signal).then(async (token) => {
          if (!CLAUDE_TOKEN.test(token)) throw new Error("Claude did not give this app a sign-in.");
          await proxy.control("claude-token", { token: CLAUDE_TOKEN.exec(token)[0] }, 60_000);
          flow.phase = "succeeded"; flow.message = undefined;
        }).catch(async (error) => {
          if (flow.phase === "cancelled") return;
          log(`vps link: claude setup-token on this mac did not finish (${error?.message ?? error})`);
          // the sign-in on the server instead: a link to open and a code to paste back here
          try {
            const { auth } = await serverCall(link, "POST", `/api/instances/${encodeURIComponent(instanceId)}/auth/start`, {});
            Object.assign(flow, { server: auth.flowId, authorizationUrl: auth.authorizationUrl, needsCode: auth.phase === "waiting", phase: auth.phase === "succeeded" ? "succeeded" : "waiting", message: "Open the link, sign in, then paste the code here." });
          } catch (fallback) {
            flow.phase = "failed"; flow.message = plain(fallback, "Claude could not sign in. Try again.");
          }
        }).finally(() => onChange(view()));
        return signInView(flow);
      }
    }
    // nothing to bring from this mac: the engine's own sign-in, run on the server (a link to open, and a code for claude)
    const { auth } = await serverCall(link, "POST", `/api/instances/${encodeURIComponent(instanceId)}/auth/start`, {});
    return signInView({ ...auth, needsCode: engine.kind === "claude" && auth.phase === "waiting" && !auth.userCode });
  }

  async function signInStatus(instanceId, flowId) {
    const local = signIns.get(flowId);
    if (local && !local.server) return signInView(local);
    const link = needLink();
    if (local) {
      const { auth } = await serverCall(link, "GET", `/api/instances/${encodeURIComponent(instanceId)}/auth/status?flowId=${encodeURIComponent(local.server)}`);
      if (auth.phase !== "waiting") Object.assign(local, { phase: auth.phase, needsCode: false, message: auth.message });
      return signInView(local);
    }
    const { auth } = await serverCall(link, "GET", `/api/instances/${encodeURIComponent(instanceId)}/auth/status?flowId=${encodeURIComponent(flowId)}`);
    return signInView({ ...auth, needsCode: false });
  }
  async function signInCode(instanceId, flowId, code) {
    const serverFlow = signIns.get(flowId)?.server ?? flowId;
    await serverCall(needLink(), "POST", `/api/instances/${encodeURIComponent(instanceId)}/auth/complete`, { flowId: serverFlow, code: String(code).trim().slice(0, 2000) });
    return { ok: true };
  }
  async function signInCancel(instanceId, flowId) {
    const local = signIns.get(flowId);
    if (local) {
      local.phase = "cancelled"; local.abort.abort(); signIns.delete(flowId);
      if (local.server) await serverCall(needLink(), "POST", `/api/instances/${encodeURIComponent(instanceId)}/auth/cancel`, { flowId: local.server }).catch(() => {});
      return { ok: true };
    }
    await serverCall(needLink(), "POST", `/api/instances/${encodeURIComponent(instanceId)}/auth/cancel`, { flowId });
    return { ok: true };
  }

  // ---- what moves, backups, the move ----

  async function local(method, route, body) {
    const response = await localRequest(route, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(typeof parsed?.error === "string" ? parsed.error : "Metal on this Mac did not answer."), { status: response.status });
    return parsed;
  }

  async function preview() {
    const [bots, summary, bytes] = await Promise.all([
      local("GET", "/api/bots?messages=0"),
      local("GET", "/api/cloud-send").catch(() => ({ items: [] })),
      deps.dataSize ? deps.dataSize().catch(() => null) : Promise.resolve(null),
    ]);
    const list = Array.isArray(bots?.bots) ? bots.bots : [];
    const items = Array.isArray(summary?.items) ? summary.items : [];
    const count = (kinds) => items.filter((item) => kinds.has(item?.kind)).length;
    return {
      bots: list.map((bot) => ({ id: String(bot.id), name: String(bot.name ?? ""), ...(typeof bot.avatarUrl === "string" ? { avatarUrl: bot.avatarUrl } : {}) })),
      chats: list.reduce((sum, bot) => sum + (Array.isArray(bot.tasks) ? bot.tasks.length : 0), 0),
      messages: null,
      skills: count(SKILL_KINDS),
      memories: null,
      routines: count(ROUTINE_KINDS),
      apps: null,
      bytes,
    };
  }

  /** a full, encrypted backup of this mac's workspace, kept in this app's folder with its own random password */
  async function backupNow(reason = "manual", from = null, onBytes = null) {
    const password = randomBytes(24).toString("base64url");
    const call = from ? (method, route, body) => serverCall(from, method, route, body) : local;
    const made = await call("POST", "/api/workspace-backup/export", { password, clientState: {} });
    const response = from
      ? await serverFetch(`${from.origin}/api/workspace-backup/download/${encodeURIComponent(made.id)}`, { credentials: "include", headers: { origin: from.origin }, signal: AbortSignal.timeout(30 * 60_000) })
      : await localRequest(`/api/workspace-backup/download/${encodeURIComponent(made.id)}`, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error("The backup could not be saved.");
    const at = now();
    const moving = reason === "before-move" && state.move?.step === "backup" ? state.move : null;
    let received = 0, reportedAt = 0;
    const report = (force = false) => {
      if (!moving || state.move !== moving) return;
      moving.bytes = { done: received, ...(Number.isFinite(made.bytes) && made.bytes >= 0 ? { total: made.bytes } : {}) };
      if (received > 0) moving.progressAt = now();
      moving.updatedAt = now();
      if (force || now() - reportedAt >= 200) { reportedAt = now(); onChange(view()); }
    };
    report(true);
    const body = moving ? response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { received += chunk.byteLength; report(); controller.enqueue(chunk); },
    })) : onBytes ? response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { received += chunk.byteLength; onBytes(received, Number.isFinite(made.bytes) ? made.bytes : null); controller.enqueue(chunk); },
    })) : response.body;
    const saved = await deps.backups.save(`${at}-${made.id}.duskbackup`, body);
    report(true);
    if (typeof made.bytes === "number" && saved.bytes !== made.bytes) throw new Error("The backup was cut off while saving. Nothing was changed.");
    const entry = {
      id: made.id, at, bytes: saved.bytes, file: saved.file, reason, passwordP: await protect(password), ...(from ? { from: from.name } : {}),
      summary: made.summary ? { bots: made.summary.bots ?? 0, chats: made.summary.threads ?? 0, messages: made.summary.messages ?? 0, skills: 0, routines: 0 } : null,
    };
    state.backups = [entry, ...state.backups].slice(0, 20);
    write();
    return entry;
  }

  function backups() {
    return state.backups.map(({ id, at, bytes, summary, reason, from }) => ({ id, at, bytes, summary, reason, ...(from ? { from } : {}) }));
  }

  async function restoreFile(entry) {
    const opened = await deps.backups.open(entry.file);
    const upload = await localRequest("/api/workspace-backup/upload", { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(opened.size) }, body: opened.body, duplex: "half", signal: AbortSignal.timeout(30 * 60_000) });
    const uploaded = await upload.json().catch(() => ({}));
    if (!upload.ok) throw new Error(typeof uploaded?.error === "string" ? uploaded.error : "the backup could not be read.");
    const staged = await local("POST", "/api/workspace-backup/preview", { id: uploaded.id, password: await unprotect(entry.passwordP) });
    await local("POST", "/api/workspace-backup/restore", { id: staged.id, confirmation: "REPLACE" });
  }

  async function restore(id) {
    const entry = state.backups.find((backup) => backup.id === id);
    if (!entry) throw new Error("That backup is gone.");
    const frozen = await local("GET", "/api/move/freeze").then((got) => got.frozen === true).catch(() => false);
    if (frozen) await local("DELETE", "/api/move/freeze", {}).catch(() => {});
    try { await restoreFile(entry); }
    catch (error) { if (frozen) await local("POST", "/api/move/freeze", {}).catch(() => {}); throw error; }
    deps.ownHomeReset();
    state.move = null;
    write();
    deps.relaunch();
    return { ok: true, restart: true };
  }

  /** a running step keeps an error and its next try only when they are said again with it */
  function moveTo(step, status, extra = {}) {
    const progressed = step !== state.move?.step || (extra.chats && JSON.stringify(extra.chats) !== JSON.stringify(state.move?.chats));
    state.move = { ...state.move, step, status, ...extra };
    state.move.updatedAt = now();
    if (progressed) state.move.progressAt = now();
    if (step !== "backup") delete state.move.bytes;
    if (!("error" in extra) && status !== "failed") delete state.move.error;
    if (!("retryAt" in extra)) delete state.move.retryAt;
    write();
  }

  async function move() {
    const link = needLink();
    if (state.move && state.move.status === "running") return view();
    await signedIn(link);
    state.move = { linkId: link.id, step: "backup", status: "running", startedAt: now() };
    write();
    try {
      const backup = await backupNow("before-move");
      moveTo("copy", "running", { backupId: backup.id });
      await carryWelcome(link);
      await ownHome.start(link.envId);
    } catch (error) {
      moveTo(state.move.step, "failed", { error: plain(error, "The move could not start. Nothing on this Mac changed.") });
      return view();
    }
    watchMove();
    return view();
  }

  /** the person met Metal on this Mac: the server keeps that, so it never opens on the welcome a second time */
  async function carryWelcome(link) {
    try {
      const mine = (await local("GET", "/api/config"))?.onboarding;
      const theirs = (await serverCall(link, "GET", "/api/config"))?.onboarding;
      const record = welcomeForServer(mine, theirs, new Date());
      if (record) await serverCall(link, "PUT", "/api/config", { onboarding: record });
    } catch (error) { log(`vps link: the server may show the welcome again (${error?.message ?? error})`); }
  }

  /** the own-home move does the copy, the check and the switch; this follows it and empties this mac only at the end */
  function watchMove() {
    if (moveTimer || closed) return;
    const tick = async () => {
      moveTimer = null;
      const kept = state.move;
      if (!kept || kept.status === "failed" || kept.step === "done") return;
      const seen = ownHome.view();
      try {
        if (!seen || seen.phase === "copy" || seen.phase === "wait") {
          const trouble = ownHome.trouble?.() ?? null;
          const said = trouble?.error ?? seen?.failing?.error;
          const extra = { ...(seen?.chats ? { chats: seen.chats } : {}), ...(seen?.phase === "wait" && seen.waitingFor ? { waitingFor: seen.waitingFor } : {}),
            ...(said ? { error: plain({ message: said }, "Your server didn't answer.") } : {}), ...(trouble ? { retryAt: trouble.retryAt } : {}) };
          if (kept.step !== "copy" || JSON.stringify(extra.chats) !== JSON.stringify(kept.chats) || extra.waitingFor !== kept.waitingFor
            || extra.error !== kept.error || extra.retryAt !== kept.retryAt) moveTo("copy", "running", extra);
        } else if (seen.phase === "finishing") {
          if (kept.step !== "verify") moveTo("verify", "running");
        } else if (seen.phase === "done") {
          if (Array.isArray(seen.left) && seen.left.length) {
            // something did not arrive: this mac keeps everything, as the move left it
            moveTo("done", "done", { kept: true });
            return;
          }
          if (kept.step !== "empty") moveTo("empty", "running");
          const forgot = await local("POST", "/api/move/forget", {}).then(() => true, (error) => { log(`vps link: this mac kept its copy (${error?.message ?? error})`); return false; });
          moveTo("done", "done", forgot ? {} : { kept: true });
          return;
        } else if (seen.phase === "home-again" || seen.phase === "back" || seen.phase === "keeping") {
          moveTo(kept.step, "failed", { error: "The move stopped and your bots stayed on this Mac." });
          return;
        }
      } catch (error) {
        log(`vps link: move check failed (${error?.message ?? error})`);
      }
      moveTimer = setTimeout(() => void tick(), pollMs);
      moveTimer.unref?.();
    };
    moveTimer = setTimeout(() => void tick(), 0);
    moveTimer.unref?.();
  }

  /** the move's next try, now rather than at its time */
  function retryMove() {
    if (!state.move || state.move.status !== "running") return view();
    if (state.move.retryAt) moveTo(state.move.step, "running", {});
    void ownHome.retry?.().catch((error) => log(`vps link: trying the move again failed (${error?.message ?? error})`));
    return view();
  }

  const forget = () => forgetLink(currentLink());
  /** Start fresh: the linked server this saved place is, forgotten as Forget does (after its data was deleted, so there is
   * no session left there to sign out of: `quiet`); false when no link is that place. */
  async function forgetServer(envId) {
    const link = state.links.find((entry) => entry.envId === envId);
    if (!link) return false;
    await forgetLink(link, { quiet: true });
    return true;
  }

  async function forgetLink(link, how = {}) {
    if (!link) return view();
    // the server drops this app's ssh key now; its agent also does once the link service says the tunnel is gone
    const proxy = proxies.get(link.id);
    if (proxy) await revokeDirect(link, proxy, 5000);
    try { await relay.forget(link.id, await unprotect(link.tokenP)); } catch (error) { log(`vps link: the link service did not forget the tunnel (${error?.message ?? error})`); }
    await proxyStarts.get(link.id)?.catch(() => {});
    await proxies.get(link.id)?.close();
    proxies.delete(link.id);
    const leaving = link.envId ? deps.forgetServer(link.envId, how.quiet ? { quiet: true } : undefined) : null;
    if (how.quiet) await leaving;
    peers.delete(link.id);
    state.links = state.links.filter((entry) => entry.id !== link.id);
    state.current = state.links.at(-1)?.id ?? null;
    if (state.move?.linkId === link.id) state.move = null;
    write();
    return view();
  }

  /** the line that takes Metal off the server again (apps/link-service/uninstall.sh), from the service it was linked through */
  function uninstallLine() { return `curl -fsSL ${currentLink()?.base ?? base}/uninstall | sh`; }

  function where() {
    if (ownHome.away()) { const home = ownHome.home(); return { place: "vps", server: home ? { id: home.id, name: home.name, origin: home.origin } : null, uninstall: uninstallLine() }; }
    return { place: "mac", server: null };
  }

  /** at launch: every linked server's tunnel opens again, a setup in progress is followed, a move in progress watched */
  async function resume() {
    await Promise.all(state.links.map(async (link) => {
      if (link.mode === "direct" && link.spki && link.origin) deps.pin?.(new URL(link.origin).host, link.spki);
      if (link.away?.spki) deps.pin?.(new URL(link.away.origin).host, link.away.spki);
      await proxyFor(link).catch((error) => log(`vps link: ${link.name} tunnel did not open (${error?.message ?? error})`));
    }));
    if (state.pending) follow();
    if (state.move && state.move.status === "running" && state.move.step !== "backup") watchMove();
    if (state.move && state.move.status === "running" && state.move.step === "backup") moveTo("backup", "failed", { error: "The app closed while saving the backup. Nothing on this Mac changed." });
  }

  /** whether `identity` is the one pinned for the linked server at `origin`: null for an origin no link has. A link made
   * before the agent sent one pins the first it sees, which reaches this app through the same sealed tunnel */
  function sealTrust(origin, identity) {
    const link = linkAt(origin);
    if (!link) return null;
    if (typeof identity !== "string" || !SEAL_IDENTITY.test(identity)) return { ok: false, pinned: true };
    if (!link.sealIdentity) {
      link.sealIdentity = identity;
      link.sealPinnedAt = now();
      write();
      log(`vps link: pinned ${link.name}'s identity on first use`);
      return { ok: true, pinned: true };
    }
    if (link.sealIdentity !== identity) log(`vps link: ${link.name} offered an identity other than the one pinned for it; nothing is sealed for it`);
    return { ok: link.sealIdentity === identity, pinned: true };
  }

  return {
    view, start, cancel, resume, accountReady, sealTrust, nudge, directSetting, setDirect, updateLink, pathAt,
    reset() { lastError = null; if (!state.pending && state.move?.step === "done") state.move = null; write(); return view(); },
    engines, signIn, signInStatus, signInCode, signInCancel,
    preview, move, retryMove, moveBack: (placeId) => back.run(placeId), bringSources: () => back.sources(), backups, backupNow: async () => ({ id: (await backupNow("manual")).id }), restore, forget, forgetServer, where,
    open: async () => { const link = needLink(); await deps.switchTo(link.envId); },
    /** the servers linked here with the install line, by their saved place; `key` is the server's own id when it sent one */
    servers: () => state.links.filter((link) => link.envId).map((link) => ({ id: link.envId, key: link.environmentId ?? link.envId, name: link.name, uninstall: `curl -fsSL ${link.base ?? base}/uninstall | sh` })),
    /** a request at a linked server as this app, its owner, signing in again through its agent when that lapsed */
    async ownerCall(envId, method, route, body) {
      const link = state.links.find((entry) => entry.envId === envId);
      if (!link || closed) throw new Error("That server isn't linked here any more.");
      await signedIn(link);
      return serverCall(link, method, route, body);
    },
    readyServer: async (envId) => {
      const link = state.links.find(entry => entry.envId === envId);
      if (!link || closed) return null;
      if (link.mode === "direct" && link.spki && link.origin) deps.pin?.(new URL(link.origin).host, link.spki);
      await proxyFor(link);
      return !closed && state.links.includes(link) ? { id: envId, origin: link.origin } : null;
    },
    async close() { closed = true; invalidateSetup(); for (const one of setupTries.values()) clearTimeout(one.timer); stopFollowing(); clearTimeout(moveTimer); for (const timer of addressTimers.values()) clearTimeout(timer); addressTimers.clear(); for (const flow of signIns.values()) flow.abort?.abort(); await Promise.allSettled(proxyStarts.values()); await Promise.all([...proxies.values()].map((proxy) => proxy.close())); },
  };
}
