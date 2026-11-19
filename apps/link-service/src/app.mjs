// the link service: (1) one-time setup sessions the app opens and the vps install script reports into, (2) the install
// and uninstall scripts and the agent, (3) a relay tunnel of frames both ends seal, so it never reads a request, a reply or a credential.
//
// trust: the app holds the secrets. the relay stores only sha256 verifiers of bearer tokens and passes sealed blobs on.
import { fromLegacyPath } from "./legacy.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { verifyLinkGrant } from "./grant.mjs";
import { createPackages } from "./packages.mjs";
import { createPushRelay } from "./push-relay.mjs";
import { SEALED_ADDRESS_MAX, choosePlacement, createCluster, loadOf, refusesNew, sameSecret } from "./nodes.mjs";
import { SMALL_BURST_BYTES, SMALL_BYTES_PER_SEC, SMALL_POST_BYTES, createAccountUsage, createPathCounts, fairRate } from "./fair-use.mjs";
import { ACTIVE_MS, BUSY_BYTES, DEFAULT_LIMITS, MONTH_ALLOWANCE_BYTES, createRelayUsage, loadLimits, saveLimits, validateLimits } from "./relay-limits.mjs";
import { APP_TOKENS_CALLBACK_ROUTE, appTokenCallback } from "./app-token-callback.mjs";
import { slackCallback } from "./slack-callback.mjs";
import { MAX_CHANNELS_PER_TUNNEL, MAX_EVENTS, MAX_SESSIONS, MAX_TUNNELS, SESSION_LIFE_MS, createStore } from "./store.mjs";
import { STUN_PUBLIC, turnCredential, turnUrls } from "./turn.mjs";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const ID = /^[a-z2-7]{10}$/;
export const TOKEN = /^[a-z2-7]{10}-[a-z2-7]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const STEP = /^[a-z][a-z0-9-]{0,31}$/;
const STATUSES = new Set(["running", "done", "failed", "skipped"]);
const NONCE = /^[a-z0-9]{16,64}$/;

const MAX_BODY = 4 * 1024 * 1024;
const MAX_SMALL_BODY = 64 * 1024;
const MAX_LOG = 4000;
// live terminal lines a step streams while it runs: per event, and how many such events a session keeps
const MAX_LINES = 60;
const MAX_LINE = 400;
const MAX_LINES_BYTES = 16 * 1024;
const MAX_CMD = 300;
const KEEP_LINE_EVENTS = 150;
// a waiting server's standby read: 55 s each (the app's own reads ask 25), one request a minute and a beat every 10 s,
// so an idle server costs the node as little as it can
const MAX_WAIT_S = 55;
/** phone apps 1.2 and 1.2.1 wait 15 s on a relay route before their next one: a server not reading its channels this
 * long is answered at once instead */
const SERVER_AWAY_MS = 20_000;
const FRAME_MAX = 1024 * 1024 + 64;
const QUEUE_FRAMES = 1024;
const QUEUE_BYTES = 16 * 1024 * 1024;
/** a streamed line holds at most this much, so a lane frame queued a moment later waits behind one small line, not 4 MB */
const STREAM_LINE_BYTES = 256 * 1024;
/** the egress lane's own room: its frames are small (dials, answers, a page's first bytes) */
const LANE_FRAMES = 512;
const LANE_BYTES = 4 * 1024 * 1024;
// more than the posts a writer has out at once (8 over http/2), so retries landing out of order after a blip are held,
// not refused
const HELD_POSTS = 32;
const GAP_MS = 15_000;
const FRESH_GAP_MS = 300;
// a streamed read's beat: often enough that a dead connection shows within half a minute, rare enough that thousands
// of idle servers cost the node little (each beat is a write per open read)
const BEAT_MS = 10_000;
const EPOCH = /^[a-z2-7]{12}$/;
const CREATE_PER_HOUR = 120;
/** new setup sessions per address or account in any minute, and the unused ones an account may hold */
const CREATE_PER_MINUTE = 10;
const CREATE_PER_MINUTE_IP = 30;
const OPEN_PER_ACCOUNT = 5;
const CHANNEL_GRANT_MS = 24 * 60 * 60_000;
const PHONE_POSTS_PER_SECOND = 50;
const PHONE_POST_BURST = 400;
const PHONE_BYTES_PER_MINUTE = 256 * 1024 * 1024;
const PHONE_READS_PER_MINUTE = 600;
const LOOKUP_ID = /^[0-9a-f]{32}$/;
/** a short line's code (`curl -fsSL https://dusk.bot/s/<code> | sh`): 7 characters with no l, o, 0 or 1, about 3.4e10
 * of them, good for one setup session only while it is waiting or installing, with every miss counted */
export const SHORT_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const SHORT_CODE = /^[a-km-np-z2-9]{7}$/;
const SHORT_WAYS = new Set(["cloudflare", "tailscale", "ssh", "relay"]);
const SHORT_MISSES_PER_HOUR = 30;
const SHORT_MISSES_PER_HOUR_ALL = 2000;
const LOOKUP_CREATE_PER_HOUR = 120;
const LOOKUP_MISSES_PER_HOUR = 240;
const MAX_LOOKUPS = 5000;
/** downloads (server build and desktop kit together) one install session may make; install.sh tries each five times */
const PACKAGE_DOWNLOADS = 20;
/** a linked server's own update reads (apps/link-service/agent.mjs createServerUpdater): checks per hour, downloads (resumes count) per day */
export const SERVER_RELEASE_READS_PER_HOUR = 12;
export const SERVER_DOWNLOADS_PER_DAY = 12;
/** a tunnel's sustained relay rate, the burst it may post at once, and its daily total (both directions together), by
 * default: the live values are the service's limits (relay-limits.mjs), changeable at runtime */
export const TUNNEL_BYTES_PER_SECOND = DEFAULT_LIMITS.perTunnelBytesPerSec;
export const TUNNEL_BURST_BYTES = DEFAULT_LIMITS.burstBytes;
/** a post waits at most this long for its share of the relay; past it the post is refused with a retry-after */
export const MAX_HOLD_MS = 20_000;
/** a tunnel is slowed to its fair share of the ceiling once this many bytes a second or more pass through it */
const DEMANDING_BYTES_PER_SECOND = 64 * 1024;
/** no tunnel's share drops below this, however many are busy (the ceiling still holds the total) */
const MIN_SHARE_BYTES_PER_SECOND = 32 * 1024;
export const RELAY_HISTORY_DAYS = 3;
/** the egress lane (a bot's web traffic routed through the person's computer) while it rides the relay */
export const LANE_BYTES_PER_SECOND = 6 * 1024 * 1024;
export const LANE_BURST_BYTES = 8 * 1024 * 1024;
/** a frame nobody read in this long is dropped: its reader is gone, and it must not hold memory */
export const FRAME_TTL_MS = 60_000;
/** every queued frame across every tunnel and channel; past it new frames are refused, never the process */
export const MAX_QUEUED_BYTES = 1024 ** 3;
/** linked servers one dusk account may have at once, by default */
export const TUNNELS_PER_ACCOUNT = DEFAULT_LIMITS.tunnelsPerAccount;
/** per client address: requests in flight at once, and a request rate (a bucket that refills per second) */
export const IP_CONCURRENT = 512;
export const IP_REQUESTS_PER_SECOND = 200;
const IP_REQUEST_BURST = 2000;
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function installerProgress(value) {
  if (!value || typeof value !== "object") return null;
  const label = typeof value.label === "string" ? [...value.label].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("").slice(0, 100) : undefined;
  if (value.kind === "download") {
    if (!nonnegativeInteger(value.receivedBytes) || (value.totalBytes !== undefined && !nonnegativeInteger(value.totalBytes))) return null;
    return { kind: value.kind, receivedBytes: value.receivedBytes, ...(value.totalBytes !== undefined ? { totalBytes: value.totalBytes } : {}), ...(label ? { label } : {}) };
  }
  if (value.kind !== "layers" && value.kind !== "build") return null;
  if (!nonnegativeInteger(value.completed) || !nonnegativeInteger(value.total) || value.completed > value.total) return null;
  const bytes = value.receivedBytes !== undefined || value.totalBytes !== undefined;
  if (bytes && (!nonnegativeInteger(value.receivedBytes) || !nonnegativeInteger(value.totalBytes))) return null;
  return { kind: value.kind, completed: value.completed, total: value.total,
    ...(bytes ? { receivedBytes: value.receivedBytes, totalBytes: value.totalBytes } : {}), ...(label ? { label } : {}) };
}

const ASK_LINKS = { "tailscale-login": "login.tailscale.com", "tailscale-https": "login.tailscale.com", "cloudflare-login": "dash.cloudflare.com" };
const ASK_HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const ASK_IP = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const ASK_STATES = new Set(["waiting", "found", "done"]);
/**
 * what the installer needs the person to do, shown by the app: open a sign-in link (only on the provider's own host),
 * add a DNS record, open ports, or (ssh) the tunnel command to reach it. `{kind: "none"}` clears it. undefined: invalid
 */
export function installerAsk(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.kind === "none") return { kind: "none" };
  const state = ASK_STATES.has(value.state) ? value.state : "waiting";
  if (Object.hasOwn(ASK_LINKS, value.kind)) {
    let url;
    try { url = new URL(value.url); } catch { return undefined; }
    if (url.protocol !== "https:" || url.hostname !== ASK_LINKS[value.kind] || url.username || url.password || value.url.length > 600) return undefined;
    return { kind: value.kind, url: url.href, state };
  }
  if (value.kind === "dns") {
    if (!ASK_HOST.test(value.host ?? "") || value.type !== "A" || !ASK_IP.test(value.value ?? "")) return undefined;
    return { kind: "dns", host: value.host, type: "A", value: value.value, state };
  }
  if (value.kind === "ports") return { kind: "ports", ...(ASK_IP.test(value.ip ?? "") ? { ip: value.ip } : {}), state };
  if (value.kind === "ssh") {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value.user ?? "") || !(ASK_IP.test(value.host ?? "") || ASK_HOST.test(value.host ?? ""))) return undefined;
    return { kind: "ssh", user: value.user, host: value.host, state };
  }
  return undefined;
}

function installerActivity(value) {
  if (!value || !nonnegativeInteger(value.elapsedMs) || !nonnegativeInteger(value.quietMs) || value.quietMs > value.elapsedMs) return null;
  return { elapsedMs: value.elapsedMs, quietMs: value.quietMs };
}

export const sha256hex = (value) => createHash("sha256").update(value).digest("hex");
export function randomShort() {
  const bytes = randomBytes(7);
  let out = "";
  for (const byte of bytes) out += SHORT_ALPHABET[byte & 31];
  return out;
}

/** what `curl -fsSL <short url> | sh` runs: the long line's loop as a script. every try fetches the whole installer and
 * hands it to sh only once it arrived, five tries 2 s apart, every other one over IPv4; all of it inside a function
 * called on the last line, so a script cut off on its way runs nothing */
export function bootstrapScript(base, token, way) {
  const args = way ? ` -s -- --${way}` : "";
  return `#!/bin/sh
# Metal: gets the installer for this setup, then runs it
dusk_install() {
  for f in "" -4 "" -4 ""; do
    if s=$(curl -fsSL --connect-timeout 15 -m 120 $f ${base}/i/${token}); then printf '%s\\n' "$s" | sh${args}; exit $?; fi
    sleep 2
  done
  echo "Metal could not be downloaded. check the internet and paste the line again." >&2
  exit 1
}
dusk_install
`;
}

export function randomB32(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += B32[bytes[i] & 31];
  return out;
}

function sameHash(token, verifier) {
  if (typeof token !== "string" || !token || typeof verifier !== "string" || !HEX64.test(verifier)) return false;
  return timingSafeEqual(Buffer.from(sha256hex(token), "hex"), Buffer.from(verifier, "hex"));
}

function bearer(req) {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,200})$/.exec(String(req.headers.authorization ?? ""));
  return match ? match[1] : null;
}

/** a public, routable ipv4 or ipv6 address; never loopback, private, link-local or cgnat space */
export function publicIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return !(lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") || lower.startsWith("::ffff:"));
  }
  return false;
}

/**
 * queues of sealed frames, one per direction per tunnel, with long-poll waiters. never persisted. a post marked `lane`
 * (egress: a bot's handshakes) is read out ahead of what waits in the main queue, in its own order.
 */
function frameQueue(onPush = () => {}, memory = { bytes: 0 }, now = Date.now, onLate = () => {}) {
  const frames = [], times = [];
  const lane = [], laneTimes = [];
  let bytes = 0, laneBytes = 0, reader = 0, gap = null, reading = null;
  const sizeOf = (list) => list.reduce((sum, frame) => sum + frame.length, 0);
  const waiters = new Set();
  const order = { epoch: null, next: 0, held: new Map(), retired: [] };
  function unhold(at) { const list = order.held.get(at); if (!list) return; order.held.delete(at); memory.bytes -= sizeOf(list); }
  function dropHeld() { for (const at of order.held.keys()) unhold(at); }
  function drainHeld() {
    while (order.held.has(order.next) && queue.push(order.held.get(order.next))) { unhold(order.next); order.next += 1; order.fresh = false; }
    if (!order.held.size) { clearTimeout(gap); gap = null; }
  }
  function armGap() {
    if (gap) return;
    // a writer's first posts here with numbers past 0: it was writing before this process started, so its first post
    // is whatever comes first, not a gap to wait out
    const ms = order.fresh ? FRESH_GAP_MS : GAP_MS;
    gap = setTimeout(() => {
      gap = null;
      if (!order.held.size) return;
      order.next = Math.min(...order.held.keys());
      drainHeld();
      if (order.held.size) armGap();
    }, ms);
    gap.unref?.();
  }
  const queue = {
    push(list, first = false) {
      queue.expire();
      const size = sizeOf(list), t = now();
      // the lane has room of its own: a main queue full of desktop frames never refuses a handshake
      if (first ? lane.length + list.length > LANE_FRAMES || laneBytes + size > LANE_BYTES : frames.length + list.length > QUEUE_FRAMES || bytes + size > QUEUE_BYTES) return false;
      if (first) { lane.push(...list); laneTimes.push(...list.map(() => t)); laneBytes += size; }
      else { frames.push(...list); times.push(...list.map(() => t)); bytes += size; }
      memory.bytes += size;
      for (const wake of waiters) wake();
      waiters.clear();
      onPush();
      return true;
    },
    take(max = 256, maxBytes = 4 * 1024 * 1024) {
      queue.expire();
      const out = [];
      let size = 0;
      for (const [from, stamps] of [[lane, laneTimes], [frames, times]]) {
        let count = 0, taken = 0;
        while (count < from.length && out.length + count < max && (out.length + count === 0 || size + from[count].length <= maxBytes)) { size += from[count].length; taken += from[count++].length; }
        out.push(...from.splice(0, count));
        stamps.splice(0, count);
        if (from === lane) laneBytes -= taken; else bytes -= taken;
        memory.bytes -= taken;
      }
      return out;
    },
    /** drops frames queued longer than FRAME_TTL_MS ago */
    expire() {
      const cutoff = now() - FRAME_TTL_MS;
      for (const [from, stamps] of [[lane, laneTimes], [frames, times]]) {
        let count = 0;
        while (count < stamps.length && stamps[count] <= cutoff) count += 1;
        if (!count) continue;
        const dropped = sizeOf(from.splice(0, count));
        stamps.splice(0, count);
        if (from === lane) laneBytes -= dropped; else bytes -= dropped;
        memory.bytes -= dropped;
      }
    },
    get length() { return frames.length + lane.length; },
    wait(ms, signal) {
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, ms);
        waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
    wakeAll() { for (const wake of waiters) wake(); waiters.clear(); },
    /**
     * a post numbered by its writer: frames join the queue in the writer's order even when posts overtake each other.
     * a new epoch is the writer restarted; a gap left by a post that never comes is skipped after a while.
     */
    pushInOrder(list, from, at) {
      if (from !== order.epoch) {
        if (order.retired.includes(from)) return true;
        if (order.epoch !== null) order.retired = [...order.retired.slice(-3), order.epoch];
        order.epoch = from;
        order.next = 0;
        order.fresh = true;
        dropHeld();
      }
      // a numbered post that comes after its gap was skipped: what it carried is lost (the ends see it in their counts)
      if (at < order.next) { onLate(at, order.next); return true; }
      if (at > order.next) {
        if (order.held.has(at)) return true;
        if (order.held.size >= HELD_POSTS) return false;
        order.held.set(at, list);
        memory.bytes += sizeOf(list);
        armGap();
        return true;
      }
      if (!queue.push(list)) return false;
      order.fresh = false;
      order.next += 1;
      drainHeld();
      return true;
    },
    /** one streamed reader per queue: a newer one (the same end, reconnected) ends the older */
    claim() { reading?.abort(); reading = new AbortController(); reader += 1; for (const wake of waiters) wake(); waiters.clear(); return reader; },
    get signal() { return reading?.signal; },
    holds: (turn) => turn === reader,
    close() {
      clearTimeout(gap); gap = null; dropHeld();
      memory.bytes -= bytes + laneBytes;
      frames.length = times.length = lane.length = laneTimes.length = 0;
      bytes = laneBytes = 0;
      reading?.abort(); reader += 1; queue.wakeAll();
    },
  };
  return queue;
}

/**
 * @param {{
 *   base: string,
 *   dataDir?: string | null,
 *   scriptPath: string,
 *   uninstallPath?: string,
 *   agentPath: string,
 *   gatePath?: string,
 *   packagesDir?: string | null,
 *   trustProxy?: boolean,
 *   now?: () => number,
 *   fetch?: typeof fetch,
 *   log?: (line: string) => void,
 *   grantKeys?: { kid: string, x: string }[] | null,
 *   maxQueuedBytes?: number,
 *   ipLimits?: { concurrent: number, perSecond: number, burst: number },
 *   limits?: Partial<typeof DEFAULT_LIMITS>,
 *   monthAllowanceBytes?: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   nodes?: ReturnType<typeof import("./nodes.mjs").parseNodes>,
 *   peerToken?: string | null,
 *   turn?: { secret: string, tls?: boolean } | null,
 *   box?: ReturnType<typeof import("./box-meter.mjs").createBoxMeter> | null,
 *   turnWatch?: ReturnType<typeof import("./turn.mjs").createTurnWatch> | null,
 * }} options
 * `nodes`, `peerToken`: this node and its peers (nodes.mjs); null runs alone. `turn`: the turn servers' shared secret,
 * null hides the turn routes. `box`, `turnWatch`: the box's own numbers and its turn server's health, for ops.
 * `limits`: start values under any saved relay-limits.json (tests); `sleep`: how a post waits for its share (tests).
 * `grantKeys`: the account service's public keys a new session's link grant must verify against; null opens sessions to
 * anyone (local development and tests only, server.mjs refuses it unless DUSK_LINK_OPEN=1).
 */
export function createLinkService({ base, dataDir = null, scriptPath, uninstallPath = join(dirname(scriptPath), "uninstall.sh"), agentPath, gatePath = join(dirname(agentPath), "docker-gate.mjs"), packagesDir, trustProxy = true, now = Date.now, fetch: fetchImpl = fetch, log = () => {}, push = createPushRelay({ log }), grantKeys = null, maxQueuedBytes = MAX_QUEUED_BYTES, statsToken = null,
  ipLimits = { concurrent: IP_CONCURRENT, perSecond: IP_REQUESTS_PER_SECOND, burst: IP_REQUEST_BURST }, limits: startLimits = {},
  monthAllowanceBytes = MONTH_ALLOWANCE_BYTES, sleep = (ms) => delay(ms), nodes = null, peerToken = null, turn: turnConfig = null, box = null, turnWatch = null, shortBase = base }) {
  const nodeId = nodes?.self.id ?? "contabo";
  // a tunnel's home node (the default one for tunnels from before nodes) is the one that drops it when idle
  // queues live in memory: a client that sees this change knows what it sent before may never arrive
  const boot = randomBytes(9).toString("base64url");
  const homeOf = (tunnel) => tunnel.home ?? nodes?.defaultId ?? nodeId;
  const store = createStore({ dir: dataDir, now, onChannelDelete: clearChannel, onTunnelDelete: (tunnel) => { dropTunnelState(tunnel.id); cluster?.removed("tunnel", tunnel.id); },
    mayExpire: (tunnel) => !nodes || homeOf(tunnel) === nodeId });
  const memory = { bytes: 0 };
  const tunnelRates = new Map();
  /** per account (or tunnel without one): the fair use bucket; the month's bytes, every node together, in `accountMonths` */
  const accountRates = new Map();
  const paths = createPathCounts({ dir: dataDir, now, key: (tunnel) => (tunnel.acct ? `a:${tunnel.acct}` : `t:${tunnel.id}`) });
  const accountMonths = createAccountUsage({ dir: dataDir, now, log });
  const limits = loadLimits(dataDir, { ...DEFAULT_LIMITS, ...startLimits });
  const usage = createRelayUsage({ dir: dataDir, now });
  const relay = { at: now(), tokens: Math.max(limits.globalCeilingBytesPerSec * 2, limits.burstBytes), shareAt: -Infinity, demanding: new Map(), cpu: { at: Date.now(), usage: process.cpuUsage() } };
  const ipLoad = new Map();
  const packages = createPackages(packagesDir !== undefined ? packagesDir : dataDir ? join(dataDir, "packages") : null);
  const sessionWaiters = new Map();
  const queues = new Map();
  const created = new Map();
  const cache = new Map();
  const channelReaders = new Map();
  const serverReading = new Map();
  const bootedAt = now();
  const channelRates = new Map();
  const channelSeen = new Map();
  const lookups = new Map();
  const lookupCreated = new Map();
  const lookupMisses = new Map();
  const shortMisses = new Map();
  const serverReads = new Map();
  const serverDownloads = new Map();
  const cluster = nodes && peerToken ? createCluster({ config: nodes, store, token: peerToken, dir: dataDir, now, fetch: fetchImpl, log, health: nodeHealth,
    usage: () => accountMonths.own(), onUsage: (peer, value) => accountMonths.merge(peer, value),
    onRemoved: (kind, record) => {
      if (kind === "channel") { clearChannel(record); return; }
      for (const channel of store.channels.values()) if (channel.tunnel === record.id) { store.channels.delete(channel.id); clearChannel(channel); }
      dropTunnelState(record.id);
    } }) : null;
  const sweepStore = store.sweep;
  store.sweep = () => { sweepStore(); sweepLookups(); sweepCreated(); sweepQueues(); usage.save(); cluster?.sweep(); };

  function file(path) {
    const mtime = statSync(path).mtimeMs;
    const known = cache.get(path);
    if (known && known.mtime === mtime) return known.text;
    const text = readFileSync(path, "utf8");
    cache.set(path, { mtime, text });
    return text;
  }

  function clientIp(req) {
    if (trustProxy) {
      const real = String(req.headers["x-real-ip"] ?? "").trim();
      if (isIP(real)) return real;
      // the hop our own proxy added is the last one; earlier entries are whatever the client sent
      const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").pop().trim();
      if (isIP(forwarded)) return forwarded;
    }
    const socket = String(req.socket?.remoteAddress ?? "");
    return socket.startsWith("::ffff:") ? socket.slice(7) : socket;
  }

  function send(res, status, body, headers = {}) {
    const text = body === null ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-link-boot": boot, ...headers });
    res.end(text);
  }
  const fail = (res, status, error, code, extra = {}) => send(res, status, { error, ...(code ? { code } : {}), ...extra });

  async function readJson(req, limit = MAX_SMALL_BODY) {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw Object.assign(new Error("send json"), { status: 415 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error("too large"), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
  }

  function wakeSession(id) {
    const waiters = sessionWaiters.get(id);
    if (!waiters) return;
    sessionWaiters.delete(id);
    for (const wake of waiters) wake();
  }
  function waitSession(id, ms, signal) {
    return new Promise((resolve) => {
      let waiters = sessionWaiters.get(id);
      if (!waiters) sessionWaiters.set(id, (waiters = new Set()));
      const done = () => {
        clearTimeout(timer); waiters.delete(done); signal?.removeEventListener("abort", done);
        if (!waiters.size && sessionWaiters.get(id) === waiters) sessionWaiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  function view(session, after) {
    const state = store.stateOf(session);
    return {
      state,
      expiresAt: session.state === "waiting" ? Math.min(session.createdAt + 30 * 60_000, session.createdAt + SESSION_LIFE_MS) : session.createdAt + SESSION_LIFE_MS,
      events: session.events.filter((event) => event.seq > after),
      ...(session.host ? { host: session.host } : {}),
      ...(state === "linked" ? { sealed: session.sealed, vpsPub: session.vpsPub, tunnel: session.tunnel ?? null } : {}),
    };
  }

  const lateLogged = new Map();
  function queue(tunnelId, dir) {
    const key = `${tunnelId}:${dir}`;
    let found = queues.get(key);
    if (!found) {
      queues.set(key, (found = frameQueue(() => {
        const channel = store.channels.get(tunnelId);
        if (dir === "to-vps" && channel) channelReaders.get(channel.tunnel)?.wakeAll();
      }, memory, now, (at, next) => { const t = now(); if (t - (lateLogged.get(key) ?? 0) > 60_000) { lateLogged.set(key, t); log(`link: ${key} post ${at} came after its gap was skipped (next ${next})`); } })));
      const take = found.take;
      found.take = (...args) => { const out = take(...args); usage.out(out.reduce((sum, frame) => sum + frame.length, 0)); return out; };
    }
    return found;
  }

  function clearQueues(id) {
    for (const dir of ["to-vps", "to-app"]) {
      const key = `${id}:${dir}`, q = queues.get(key);
      if (q) { q.wakeAll(); q.close(); queues.delete(key); }
    }
  }
  function serverAway(tunnelId) {
    const reading = serverReading.get(tunnelId);
    if (reading?.open) return false;
    return now() - Math.max(reading?.endedAt ?? 0, store.tunnels.get(tunnelId)?.seenAt ?? 0, bootedAt) > SERVER_AWAY_MS;
  }
  function dropTunnelState(id) {
    channelReaders.get(id)?.close();
    channelReaders.delete(id);
    serverReading.delete(id);
    tunnelRates.delete(id);
    serverReads.delete(id);
    serverDownloads.delete(id);
    clearQueues(id);
  }
  function sweepQueues() {
    for (const q of queues.values()) q.expire();
    const t = now();
    for (const [ip, load] of ipLoad) if (!load.open && t - load.at > 60_000) ipLoad.delete(ip);
  }
  const refill = (tokens, at, t, perSecond, burst) => Math.min(burst, tokens + Math.max(0, t - at) * perSecond / 1000);
  /** a tunnel moved bytes within ACTIVE_MS: it is in use */
  const isActive = (rate, t) => rate !== undefined && t - rate.usedAt < ACTIVE_MS;
  function activeTunnels(t) {
    let count = 0;
    for (const rate of tunnelRates.values()) if (isActive(rate, t)) count += 1;
    return count;
  }
  /** bytes relayed in the last ACTIVE_MS, in two half windows; BUSY_BYTES or more is busy */
  function relayed(rate, t, bytes) {
    const half = Math.floor(t / (ACTIVE_MS / 2));
    if (rate.half !== half) { rate.before = rate.half === half - 1 ? rate.now ?? 0 : 0; rate.now = 0; rate.half = half; }
    rate.now += bytes;
  }
  const isBusy = (rate, t) => isActive(rate, t) && rate.half >= Math.floor(t / (ACTIVE_MS / 2)) - 1
    && (rate.half === Math.floor(t / (ACTIVE_MS / 2)) ? rate.now + rate.before : rate.now) >= BUSY_BYTES;
  function busyTunnels(t) {
    let count = 0;
    for (const rate of tunnelRates.values()) if (isBusy(rate, t)) count += 1;
    return count;
  }
  /** why a tunnel new to the relay is turned away, or null */
  const full = (t) => limits.paused || activeTunnels(t) >= limits.maxConnected || busyTunnels(t) >= limits.maxTunnels;
  /** each busy tunnel's fair share of the ceiling; who is busy is recounted at most four times a second */
  // the ceiling is shared fairly between accounts, then between an account's own busy tunnels: twenty servers of one
  // account get together what one server of another account gets
  const shareKey = (tunnelId) => { const acct = store.tunnels.get(tunnelId)?.acct; return acct ? `a:${acct}` : `t:${tunnelId}`; };
  function shareAt(t, tunnelId, rate) {
    if (t - relay.shareAt >= 250 || t < relay.shareAt) {
      relay.demanding = new Map();
      for (const [id, other] of tunnelRates) {
        if (t - other.usedAt >= 2000 || Math.max(other.recent, other.prev) < DEMANDING_BYTES_PER_SECOND * 2) continue;
        const key = shareKey(id);
        if (!relay.demanding.has(key)) relay.demanding.set(key, new Set());
        relay.demanding.get(key).add(id);
      }
      relay.shareAt = t;
    }
    const key = shareKey(tunnelId), mine = relay.demanding.get(key);
    const demanding = Math.max(rate.recent, rate.prev) >= DEMANDING_BYTES_PER_SECOND * 2;
    const accounts = relay.demanding.size + (!mine && demanding ? 1 : 0);
    const siblings = (mine?.size ?? 0) + (demanding && !mine?.has(tunnelId) ? 1 : 0);
    return Math.min(limits.perTunnelBytesPerSec, Math.max(MIN_SHARE_BYTES_PER_SECOND, limits.globalCeilingBytesPerSec / Math.max(1, accounts) / Math.max(1, siblings)));
  }
  /**
   * a post's turn on the relay. it is slowed, not refused: past its burst it waits for its tunnel's share (the per tunnel
   * rate, or less while many tunnels are busy, so the total stays under the global ceiling), and is refused only when the
   * wait would pass MAX_HOLD_MS, the daily total is spent, or this one is new and the relay is full (maxConnected in use or
   * maxTunnels busy).
   * sizes are the frames' base64url text, the bytes on the wire. answers { charge, refund } once its turn came, or null
   * after refusing
   */
  async function tunnelBudget(res, tunnelId, frames, lane) {
    const tunnel = store.tunnels.get(tunnelId);
    if (!tunnel) return { charge() {}, refund() {} };
    const size = frames.reduce((sum, frame) => sum + frame.length, 0), t = now(), day = Math.floor(t / 86_400_000);
    if (tunnel.day !== day) { tunnel.day = day; tunnel.dayBytes = 0; }
    let rate = tunnelRates.get(tunnelId);
    if (!isActive(rate, t) && full(t)) {
      count(tunnel, t, 0, 1);
      send(res, 503, { error: "The relay is full right now. Try again in a few minutes, or reach this server through a Cloudflare tunnel, SSH or Tailscale.", code: "relay_busy" }, { "retry-after": "60" });
      return null;
    }
    if (!rate) tunnelRates.set(tunnelId, (rate = { at: t, tokens: limits.burstBytes, lane: LANE_BURST_BYTES, usedAt: -Infinity, recent: 0, prev: 0, recentAt: t }));
    // bytes in this two second window and the one before (this post included), for shareAt
    if (t - rate.recentAt >= 2000) { rate.prev = t - rate.recentAt < 4000 ? rate.recent : 0; rate.recent = 0; rate.recentAt = t; }
    rate.recent += size;
    const share = shareAt(t, tunnelId, rate), ceiling = limits.globalCeilingBytesPerSec;
    rate.tokens = refill(rate.tokens, rate.at, t, share, limits.burstBytes);
    rate.lane = refill(rate.lane, rate.at, t, LANE_BYTES_PER_SECOND, LANE_BURST_BYTES);
    rate.at = t;
    relay.tokens = refill(relay.tokens, relay.at, t, ceiling, Math.max(ceiling * 2, limits.burstBytes));
    relay.at = t;
    // the account's month (every node together) sets its rate; a small post the account's bucket cannot take now
    // takes the small allowance instead, so a slowed account's chat still goes at once
    const key = shareKey(tunnelId), month = fairRate(accountMonths.total(key), limits);
    let fair = accountRates.get(key);
    if (!fair) accountRates.set(key, (fair = { tokens: month * limits.accountBurstSeconds, at: t, small: SMALL_BURST_BYTES }));
    fair.tokens = refill(fair.tokens, fair.at, t, month, Math.max(month * limits.accountBurstSeconds, SMALL_POST_BYTES));
    fair.small = refill(fair.small, fair.at, t, SMALL_BYTES_PER_SEC, SMALL_BURST_BYTES);
    fair.at = t;
    const viaSmall = size <= SMALL_POST_BYTES && fair.tokens < size && fair.small >= size;
    const fairWait = viaSmall ? 0 : (size - fair.tokens) / month;
    const waitMs = Math.ceil(1000 * Math.max(0, (size - rate.tokens) / share, lane ? (size - rate.lane) / LANE_BYTES_PER_SECOND : 0, (size - relay.tokens) / ceiling, fairWait));
    if (waitMs > MAX_HOLD_MS) {
      count(tunnel, t, 0, 1);
      send(res, 429, { error: "This link is sending faster than the relay allows. Try again in a moment.", code: "rate_limited" }, { "retry-after": String(Math.ceil(waitMs / 1000)) });
      return null;
    }
    // taken now, so the posts behind this one wait their own turn after it
    rate.tokens -= size; relay.tokens -= size;
    if (viaSmall) fair.small -= size; else fair.tokens -= size;
    if (lane) rate.lane -= size;
    rate.usedAt = t;
    let settled = false;
    const refund = () => { if (settled) return; settled = true; rate.tokens += size; relay.tokens += size; if (viaSmall) fair.small += size; else fair.tokens += size; if (lane) rate.lane += size; };
    const charge = () => { if (settled) return; settled = true; tunnel.dayBytes += size; count(tunnel, now(), size, 0); usage.in(size); accountMonths.add(key, size); };
    if (waitMs > 0) {
      let gone = false;
      const left = () => { gone = true; };
      res.once("close", left);
      memory.bytes += size;
      try { await sleep(waitMs); } finally { memory.bytes -= size; res.off("close", left); }
      if (gone) { refund(); return null; }
      if (!store.tunnels.has(tunnelId)) { refund(); fail(res, 404, "not found", "not_found"); return null; }
    }
    return { charge, refund };
  }
  /** relay bytes and refusals per utc day on the tunnel, the last RELAY_HISTORY_DAYS of them, for the owner's ops page */
  function count(tunnel, t, bytes, limited) {
    const day = new Date(t).toISOString().slice(0, 10), days = tunnel.relayDays ??= {};
    const entry = days[day] ??= { bytes: 0, limited: 0 };
    entry.bytes += bytes; entry.limited += limited;
    const rate = bytes ? tunnelRates.get(tunnel.id) : undefined;
    if (rate) relayed(rate, t, bytes);
    const keys = Object.keys(days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - RELAY_HISTORY_DAYS))) delete days[old];
  }
  /** every queue together stays under maxQueuedBytes: past it a post is refused, the process keeps its memory */
  function roomFor(res, frames) {
    if (memory.bytes + frames.reduce((sum, frame) => sum + frame.length, 0) <= maxQueuedBytes) return true;
    send(res, 503, { error: "The link service is busy. Try again in a moment.", code: "busy" }, { "retry-after": "2" });
    return false;
  }
  /**
   * the owner's admin panel: what the relay carries now, today and this month, its limits, the busiest accounts. bytes
   * are on the wire (frames' base64url text); out is what readers took, in is what was posted. cpu is this process's
   * share of one core since the previous call (at least the last second), rss its resident memory
   */
  function relayStats() {
    const t = now(), day = new Date(t).toISOString().slice(0, 10);
    const totals = usage.totals(), rates = usage.rate();
    const active = [...tunnelRates].filter(([, rate]) => isActive(rate, t)).map(([id]) => store.tunnels.get(id)).filter(Boolean);
    const cpuNow = { at: Date.now(), usage: process.cpuUsage() };
    const spanMs = cpuNow.at - relay.cpu.at;
    const cpu = spanMs >= 1000 ? Math.round(((cpuNow.usage.user - relay.cpu.usage.user) + (cpuNow.usage.system - relay.cpu.usage.system)) / 10 / spanMs) : relay.lastCpu ?? 0;
    if (spanMs >= 1000) { relay.cpu = cpuNow; relay.lastCpu = cpu; }
    const accounts = new Map();
    for (const tunnel of store.tunnels.values()) {
      const bytes = tunnel.relayDays?.[day]?.bytes ?? 0;
      if (!bytes) continue;
      const key = tunnel.acct ?? null, entry = accounts.get(key) ?? { account: key, tunnels: 0, bytesToday: 0 };
      entry.tunnels += 1; entry.bytesToday += bytes;
      accounts.set(key, entry);
    }
    const busyNow = busyTunnels(t);
    const busy = full(t) || rates.in >= limits.globalCeilingBytesPerSec * 0.9;
    const self = cluster ? cluster.view().find((node) => node.self) : { health: nodeHealth() };
    return {
      relay: nodeId,
      node: { id: nodeId, region: nodes?.self.region ?? null, url: nodes?.self.url ?? base, default: (nodes?.defaultId ?? nodeId) === nodeId, homed: self.health.homed,
        accepting: !refusesNew({ up: true, health: self.health }), refuses: refusesNew({ up: true, health: self.health }), load: loadOf(self.health) },
      nodes: cluster ? cluster.view().map((node) => ({ id: node.id, url: node.url, region: node.region, self: node.self, up: node.up, lastOkAt: node.lastOkAt, lastError: node.lastError ?? null,
        homed: node.health?.homed ?? null, tunnels: node.health?.tunnels ?? null, connected: node.health?.connected ?? null, accepting: node.health ? !refusesNew(node) : null })) : [{ id: nodeId, url: base, region: null, self: true, up: true, lastOkAt: t, lastError: null, homed: self.health.homed, tunnels: busyNow, connected: active.length, accepting: !refusesNew({ up: true, health: self.health }) }],
      box: box?.reading() ?? null,
      turn: turnConfig ? { ...(turnWatch?.state() ?? { ok: null, at: null, rttMs: null, downSince: null }), urls: turnUrls(new URL(nodes?.self.url ?? base).hostname, { tls: !!turnConfig.tls }) } : null,
      now: { tunnels: busyNow, connected: active.length, servers: self.health.servers, accounts: new Set(active.map((tunnel) => tunnel.acct ?? tunnel.id)).size, chatting: paths.chatting(), bytesPerSecOut: rates.out, bytesPerSecIn: rates.in, cpu, rssMb: Math.round(process.memoryUsage().rss / 1024 ** 2) },
      today: { bytesOut: totals.day.out, bytesIn: totals.day.in },
      month: { bytesOut: totals.month.out, bytesIn: totals.month.in, projectedBytesOut: Math.round(totals.month.out / usage.monthElapsed()), allowanceBytes: monthAllowanceBytes },
      limits: { ...limits },
      top: [...accounts.values()].sort((a, b) => b.bytesToday - a.bytesToday).slice(0, 10),
      paths: paths.month(),
      // each account's relay bytes this month, every node together, and the rate the fair use curve gives it now
      fairUse: { month: accountMonths.month(), accounts: accountMonths.top(20).map(({ key, bytes, here }) => ({ account: key.startsWith("a:") ? key.slice(2) : null, tunnel: key.startsWith("t:") ? key.slice(2) : null, monthBytes: bytes, hereBytes: here, bytesPerSec: fairRate(bytes, limits) })) },
      busy,
    };
  }
  /** this node's summary for its peers' placement and the ops page */
  function nodeHealth() {
    const t = now(), month = usage.totals().month, reading = box?.reading() ?? null;
    let homed = 0, servers = 0;
    for (const tunnel of store.tunnels.values()) if (homeOf(tunnel) === nodeId) { homed += 1; if (t - (tunnel.seenAt ?? -Infinity) < ACTIVE_MS) servers += 1; }
    return {
      at: t, id: nodeId, paused: !!limits.paused, tunnels: busyTunnels(t), homed, maxTunnels: limits.maxTunnels, connected: activeTunnels(t), maxConnected: limits.maxConnected, servers, maxServers: limits.maxServers,
      bytesPerSecOut: usage.rate().out, ceilingBytesPerSec: limits.globalCeilingBytesPerSec,
      // the box's own count when it has one: the allowance is for everything the box sends
      monthBytesOut: reading?.monthBytesOut ?? month.out, projectedBytesOut: reading?.projectedBytesOut ?? Math.round(month.out / usage.monthElapsed()),
      allowanceBytes: monthAllowanceBytes, cpu: reading?.cpu ?? null, mem: reading?.mem ?? null, turn: turnWatch ? turnWatch.state().ok : null,
    };
  }
  /** the server polls this node: it lives here now */
  function attach(tunnel) {
    if (!cluster || tunnel.home === nodeId) return;
    const from = tunnel.home ?? null;
    tunnel.home = nodeId;
    cluster.changed(tunnel);
    if (from) log(`link: tunnel ${tunnel.id} moved here from ${from}`);
  }
  /**
   * the app's and phones' traffic for a tunnel whose server reads on another node: nobody would ever read it here, so it
   * is refused with where to go instead of queued (a 409 any client treats as a failed request, and newer ones follow)
   */
  function elsewhere(res, tunnel) {
    if (!cluster || !tunnel || homeOf(tunnel) === nodeId) return false;
    const where = whereIs(tunnel);
    send(res, 409, { error: "This server is reached through another link service node.", code: "moved", ...where }, { "cache-control": "no-store" });
    return true;
  }
  /** where a tunnel lives, as the app and phones ask it */
  function whereIs(tunnel) {
    const home = homeOf(tunnel), view = cluster ? cluster.view() : [{ id: nodeId, url: base, region: null, up: true }];
    const node = view.find((item) => item.id === home) ?? { id: home, url: cluster?.urlOf(home) ?? base, region: null, up: false };
    return { node: node.id, url: node.url, region: node.region ?? null, up: node.up, nodes: view.map((item) => ({ id: item.id, url: item.url, region: item.region ?? null, up: item.up })) };
  }
  /** a server asking where to connect: sticky to its home, or the best node that holds its record */
  async function place(tunnel, body) {
    const rtt = {};
    if (body?.rtt && typeof body.rtt === "object") for (const [id, ms] of Object.entries(body.rtt).slice(0, 16)) if (/^[a-z][a-z0-9-]{1,30}$/.test(id) && Number.isFinite(ms) && ms >= 0 && ms < 60_000) rtt[id] = ms;
    if (!cluster) return { node: nodeId, url: base, reason: "single node", nodes: [{ id: nodeId, url: base, region: null, up: true }] };
    // a server that never polled is new wherever it was linked: it goes to the best node, not stuck to that one
    let choice = choosePlacement({ nodes: cluster.view(tunnel), home: tunnel.polled || tunnel.seenAt ? tunnel.home ?? null : null, rtt, defaultId: nodes.defaultId });
    if (choice.node !== nodeId && !(await cluster.ensureOn(choice.node, tunnel))) choice = { node: nodeId, reason: `${choice.node} is behind` };
    const where = whereIs(tunnel);
    return { node: choice.node, url: cluster.urlOf(choice.node), reason: choice.reason, nodes: where.nodes };
  }
  /** turn credentials and every node's turn urls, the tunnel's home first, in RTCPeerConnection's iceServers shape */
  function turnAnswer(label, tunnel) {
    const credential = turnCredential(turnConfig.secret, label, now());
    const home = homeOf(tunnel), list = nodes ? [...nodes.nodes].sort((a, b) => (a.id === home ? -1 : b.id === home ? 1 : 0)) : [{ url: base }];
    return {
      iceServers: [{ urls: [...STUN_PUBLIC] }, { urls: list.flatMap((node) => turnUrls(new URL(node.url).hostname, { tls: !!turnConfig.tls })), username: credential.username, credential: credential.credential }],
      ttl: credential.ttl, expiresAt: credential.expiresAt,
    };
  }
  /** how many live tunnels a dusk account has */
  function accountTunnels(acct) {
    let count = 0;
    for (const tunnel of store.tunnels.values()) if (tunnel.acct === acct) count += 1;
    return count;
  }
  function touchTunnel(tunnel) {
    const t = now();
    if (!tunnel.seenAt || t - tunnel.seenAt > 60_000) { tunnel.seenAt = t; store.save(); } else tunnel.seenAt = t;
    if (!tunnel.polled && cluster) { tunnel.polled = true; cluster.changed(tunnel); }
  }
  function clearChannel(channel) {
    clearQueues(channel.id);
    channelRates.delete(channel.id);
    channelSeen.delete(channel.id);
    channelReaders.get(channel.tunnel)?.wakeAll();
  }
  function deleteChannel(channel) {
    store.channels.delete(channel.id);
    clearChannel(channel);
    store.save();
    cluster?.removed("channel", channel.id);
  }
  function liveChannel(id) {
    const channel = store.channels.get(id);
    if (channel && ((channel.expiresAt != null && channel.expiresAt <= now()) || !store.tunnels.has(channel.tunnel))) { deleteChannel(channel); return null; }
    return channel;
  }
  function channelFor(req, res, id, tunnel = null) {
    const channel = liveChannel(id);
    if (!channel || (tunnel === null ? !sameHash(bearer(req), channel.verifier) : channel.tunnel !== tunnel)) {
      fail(res, 404, "not found", "not_found"); return null;
    }
    return channel;
  }
  function channelReader(id) {
    let q = channelReaders.get(id);
    if (!q) { q = frameQueue(undefined, memory, now); q.after = null; channelReaders.set(id, q); }
    return q;
  }
  function channelBatch(id, reader) {
    const list = [...store.channels.values()].filter((channel) => channel.tunnel === id);
    const start = (list.findIndex((channel) => channel.id === reader.after) + 1) % (list.length || 1);
    for (let i = 0; i < list.length; i += 1) {
      const channel = list[(start + i) % list.length];
      if (!liveChannel(channel.id)) continue;
      const q = queues.get(`${channel.id}:to-vps`);
      if (q?.length) { reader.after = channel.id; return { channel: channel.id, frames: q.take() }; }
    }
    return null;
  }
  function recent(map, id, ms) {
    const list = (map.get(id) ?? []).filter((at) => now() - at < ms);
    map.set(id, list);
    return list;
  }
  function phoneRate(res, channel, method, size = 0) {
    const t = now();
    let rate = channelRates.get(channel.id);
    if (!rate) { rate = { at: t, tokens: PHONE_POST_BURST, posts: [], reads: [] }; channelRates.set(channel.id, rate); }
    let ok;
    if (method === "POST") {
      rate.tokens = refill(rate.tokens, rate.at, t, PHONE_POSTS_PER_SECOND, PHONE_POST_BURST);
      rate.at = t;
      ok = rate.tokens >= 1;
      if (ok) rate.tokens -= 1;
    } else if (method === "BYTES") {
      rate.posts = rate.posts.filter((post) => t - post.at < 60_000);
      ok = rate.posts.reduce((sum, post) => sum + post.size, 0) + size <= PHONE_BYTES_PER_MINUTE;
      if (ok) rate.posts.push({ at: t, size });
    } else {
      rate.reads = rate.reads.filter((at) => t - at < 60_000);
      ok = rate.reads.length < PHONE_READS_PER_MINUTE;
      if (ok) rate.reads.push(t);
    }
    if (!ok) fail(res, 429, "too many channel requests", "rate_limited");
    return ok;
  }
  function sweepCreated() {
    const t = now();
    for (const [ip, list] of created) {
      const kept = list.filter((at) => t - at < 3_600_000);
      if (kept.length) created.set(ip, kept); else created.delete(ip);
    }
  }
  function sweepLookups() {
    const t = now();
    for (const [id, lookup] of lookups) if (lookup.expiresAt <= t) lookups.delete(id);
    for (const [map, ms] of [[lookupCreated, 3_600_000], [lookupMisses, 3_600_000], [serverReads, 3_600_000], [serverDownloads, 86_400_000]]) {
      for (const [ip, list] of map) {
        const kept = list.filter((at) => t - at < ms);
        if (kept.length) map.set(ip, kept); else map.delete(ip);
      }
    }
  }
  async function postFrames(req, res, id, dir, authorize, phone = false) {
    const body = await readJson(req, MAX_BODY);
    const channel = authorize();
    if (!channel) return;
    const frames = body?.frames;
    if (!Array.isArray(frames) || frames.length === 0 || frames.length > 256 || frames.some((frame) => typeof frame !== "string" || frame.length > FRAME_MAX || !B64URL.test(frame))) {
      return fail(res, 400, "frames must be 1-256 base64url strings");
    }
    if (phone && !phoneRate(res, channel, "BYTES", frames.reduce((sum, frame) => sum + frame.length, 0))) return;
    const turn = roomFor(res, frames) && await tunnelBudget(res, channel.tunnel, frames, false);
    if (!turn) return;
    const ordered = typeof body.epoch === "string" && EPOCH.test(body.epoch) && Number.isSafeInteger(body.seq) && body.seq >= 0;
    const q = queue(id, dir);
    if (!(ordered ? q.pushInOrder(frames, body.epoch, body.seq) : q.push(frames, body.lane === true))) { turn.refund(); return fail(res, 429, "the other side is behind; try again", "queue_full"); }
    turn.charge();
    return send(res, 200, { ok: true, ordered: true });
  }

  function vpsSession(req, res, id) {
    const session = store.sessions.get(id);
    if (!session) { fail(res, 404, "This command expired. Make a new one in the app.", "expired"); return null; }
    if (!sameHash(bearer(req), session.vpsVerifier)) { fail(res, 401, "This command is not valid.", "unauthorized"); return null; }
    const state = store.stateOf(session);
    if (state === "cancelled") { fail(res, 410, "Setup was cancelled in the app. Make a new command to resume.", "cancelled"); return null; }
    if (state === "linked") { fail(res, 410, "This command was already used. Make a new one in the app.", "used"); return null; }
    if (state === "expired") { fail(res, 404, "This command expired. Make a new one in the app.", "expired"); return null; }
    return session;
  }
  /**
   * the vps sending its result again because the first answer was lost: only the sender of the first result knows its
   * sealed blob and tunnel verifier, so the same pair is answered as before and anything else stays "already used"
   */
  async function sameResultAgain(req, res, id) {
    const session = store.sessions.get(id);
    if (!session || session.state !== "linked" || !sameHash(bearer(req), session.vpsVerifier)) return false;
    const body = await readJson(req);
    const tunnel = session.tunnel ? store.tunnels.get(session.tunnel) : null;
    const same = typeof body?.sealed === "string" && body.sealed === session.sealed
      && (tunnel ? body?.tunnel?.vps === tunnel.vpsVerifier && body?.tunnel?.app === tunnel.appVerifier : body?.tunnel === undefined);
    if (same) send(res, 200, { ok: true, repeated: true });
    else fail(res, 410, "This command was already used. Make a new one in the app.", "used");
    return true;
  }
  /** the session a short code names, only while it is waiting or installing (any: also one that ended, for uniqueness) */
  function shortSession(code, any = false) {
    for (const session of store.sessions.values()) {
      if (session.short !== code) continue;
      if (any) return session;
      return session.shortSecret && ["waiting", "installing"].includes(store.stateOf(session)) ? session : null;
    }
    return null;
  }
  function appSession(req, res, id) {
    const session = store.sessions.get(id);
    if (!session || !sameHash(bearer(req), session.watchVerifier)) { fail(res, 404, "not found", "not_found"); return null; }
    return session;
  }
  function tunnelFor(req, res, id, role) {
    const tunnel = ID.test(id) ? store.tunnels.get(id) : null;
    const token = bearer(req);
    const ok = tunnel && (role === "either" ? sameHash(token, tunnel.vpsVerifier) || sameHash(token, tunnel.appVerifier) : sameHash(token, role === "vps" ? tunnel.vpsVerifier : tunnel.appVerifier));
    if (!ok) { fail(res, 404, "not found", "not_found"); return null; }
    return tunnel;
  }

  /** at most `limit` bytes of a body the requester's own server sends, so a huge answer is never buffered */
  async function firstBytes(response, limit) {
    if (!response.body) return "";
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (size < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
  }

  async function probe(ip, nonce) {
    if (!publicIp(ip)) return false;
    const host = isIP(ip) === 6 ? `[${ip}]` : ip;
    try {
      const response = await fetchImpl(`http://${host}/.well-known/omb-link/${nonce}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return false; }
      return (await firstBytes(response, 200)).trim() === nonce;
    } catch { return false; }
  }

  /** a published tgz with open byte ranges; `count` charges the download and says whether it is allowed */
  async function sendPackage(req, res, build, count) {
    if (!build) return fail(res, 404, "not found", "not_found");
    const range = req.headers.range;
    const match = typeof range === "string" ? /^bytes=(0|[1-9][0-9]*)-$/.exec(range) : null;
    const start = range === undefined ? 0 : match ? Number(match[1]) : NaN;
    if (!nonnegativeInteger(start) || start >= build.size) return send(res, 416, { error: "invalid package range" }, { "content-range": `bytes */${build.size}` });
    if (!count()) return fail(res, 429, "too many downloads", "rate_limited");
    res.writeHead(range === undefined ? 200 : 206, { "content-type": "application/gzip", "content-length": String(build.size - start), "accept-ranges": "bytes",
      ...(range === undefined ? {} : { "content-range": `bytes ${start}-${build.size - 1}/${build.size}` }), "cache-control": "no-store, private", "x-content-type-options": "nosniff" });
    await pipeline(createReadStream(build.path, { start }), res).catch((error) => {
      // the server closing mid-download is normal (it resumes); anything else is ours
      if (error?.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://link.invalid");
    const path = fromLegacyPath(url.pathname);
    const method = req.method ?? "GET";
    let parts;

    if (method === "GET" && path === "/.well-known/duskbot/dashboard") {
      const dashboard = process.env.DUSK_LINK_DASHBOARD_URL;
      return dashboard ? send(res, 200, { v: 1, url: dashboard }) : fail(res, 404, "No account dashboard is configured.");
    }
    if (method === "GET" && (path === "/healthz" || path === "/health")) return send(res, 200, { ok: true });
    if (method === "GET" && path === "/v1/ip") return send(res, 200, { ip: clientIp(req) });
    // public: the nodes and whether this one sees them up, so a server or app that lost its node finds another
    if (method === "GET" && path === "/v1/nodes") {
      const view = cluster ? cluster.view() : [{ id: nodeId, url: base, region: null, up: true }];
      return send(res, 200, { self: nodeId, default: nodes?.defaultId ?? nodeId, nodes: view.map((node) => ({ id: node.id, url: node.url, region: node.region ?? null, up: node.up })) });
    }
    // node to node: the directory's copy (nodes.mjs), behind LINK_PEER_TOKEN
    if (path === "/internal/v1/sync") {
      if (!cluster || !sameSecret(bearer(req), peerToken)) return fail(res, 404, "not found");
      if (method !== "POST") return fail(res, 405, "method not allowed");
      const answer = cluster.receive(await readJson(req, 8 * 1024 * 1024));
      return answer ? send(res, 200, answer) : fail(res, 400, "unknown node");
    }
    // the account service's ops page; LINK_STATS_TOKEN unset hides it
    const opsAllowed = () => {
      if (!statsToken) { fail(res, 404, "not found"); return false; }
      const presented = bearer(req);
      if (!presented || !timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(statsToken).digest())) { fail(res, 401, "unauthorized"); return false; }
      return true;
    };
    if (path === "/ops/relay/stats" || path === "/ops/relay/limits") {
      if (!opsAllowed()) return;
      if (method === "GET" && path === "/ops/relay/stats") return send(res, 200, relayStats());
      if (method === "PUT" && path === "/ops/relay/limits") {
        const checked = validateLimits(await readJson(req), limits);
        if (!checked.limits) return fail(res, 400, checked.error, "invalid_limits");
        saveLimits(dataDir, checked.limits);
        Object.assign(limits, checked.limits);
        relay.shareAt = -Infinity;
        relay.tokens = Math.min(relay.tokens, Math.max(limits.globalCeilingBytesPerSec * 2, limits.burstBytes));
        for (const rate of tunnelRates.values()) rate.tokens = Math.min(rate.tokens, limits.burstBytes);
        log("link: relay limits changed");
        return send(res, 200, { limits: { ...limits } });
      }
      return fail(res, 405, "method not allowed");
    }
    if (method === "GET" && path === "/v1/stats/relay") {
      if (!opsAllowed()) return;
      const tunnels = [...store.tunnels.values()].filter((tunnel) => tunnel.relayDays && Object.keys(tunnel.relayDays).length)
        .map((tunnel) => ({ id: tunnel.id, acct: tunnel.acct ?? null, days: tunnel.relayDays }));
      // nothing is cut off by the day: an account is slowed over its month (fair-use.mjs)
      return send(res, 200, { limitBytes: 0, tunnels });
    }
    if (method === "GET" && path === "/slack/callback") return slackCallback(res, url.searchParams);
    if (method === "GET" && path === APP_TOKENS_CALLBACK_ROUTE) return appTokenCallback(res, url.searchParams);
    if (path === "/v1/push") return push.route(req, res, { method, readJson, send, fail, ip: clientIp(req) });
    if (method === "GET" && (path === "/i" || path === "/install.sh" || (parts = /^\/i\/([a-z2-7-]{37})$/.exec(path)))) {
      const token = parts?.[1] ?? null;
      if (token !== null && !TOKEN.test(token)) return fail(res, 404, "not found");
      let script = file(scriptPath).replaceAll("__LINK_BASE__", base);
      if (token) script = script.replaceAll("__LINK_TOKEN__", token);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return res.end(script);
    }
    // the short line's tiny script: it fetches the session's whole installer (the long line's loop, inside) and runs it
    if (method === "GET" && (parts = /^\/s\/([^/]{1,16})(?:\/([a-z]{1,16}))?$/.exec(path))) {
      const [, code, way] = parts;
      // the limit comes first: a guesser past it gets nothing, a right guess included
      const ip = clientIp(req), mine = recent(shortMisses, ip, 3_600_000), all = recent(shortMisses, "*", 3_600_000);
      if (mine.length >= SHORT_MISSES_PER_HOUR || all.length >= SHORT_MISSES_PER_HOUR_ALL) return fail(res, 429, "too many tries", "rate_limited");
      const session = SHORT_CODE.test(code) && (!way || SHORT_WAYS.has(way)) ? shortSession(code) : null;
      if (!session) {
        mine.push(now()); all.push(now());
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return res.end("echo 'This line expired or was already used. Make a new one in the app.' >&2; exit 1\n");
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return res.end(bootstrapScript(base, `${session.id}-${session.shortSecret}`, way));
    }
    // the undo: public like /i (nothing secret in it), no session needed
    if (method === "GET" && (path === "/uninstall" || path === "/uninstall.sh")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return res.end(file(uninstallPath).replaceAll("__LINK_BASE__", base));
    }
    // what a linked server's agent updates itself to (apps/link-service/agent.mjs createUpdater): the agent served at /agent.mjs
    if (method === "GET" && path === "/v1/release") {
      const text = file(agentPath);
      const version = /^export const AGENT_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(text)?.[1];
      const protocol = Number(/^export const LINK_PROTOCOL = (\d+);$/m.exec(text)?.[1]);
      if (!version || !Number.isInteger(protocol)) return fail(res, 404, "no release");
      const sig = existsSync(`${agentPath}.sig`) ? file(`${agentPath}.sig`).trim() : null;
      res.setHeader("cache-control", "no-store");
      return send(res, 200, { v: 1, agent: { version, protocol, sha256: createHash("sha256").update(text).digest("hex") }, ...(sig ? { sig } : {}) });
    }
    if (method === "GET" && (path === "/agent.mjs" || path === "/docker-gate.mjs")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return res.end(file(path === "/agent.mjs" ? agentPath : gatePath));
    }

    if (path === "/v1/lookups" || (parts = /^\/v1\/lookups\/([0-9a-f]{32})$/.exec(path))) {
      sweepLookups();
      const id = parts?.[1], ip = clientIp(req);
      if (!id && method === "POST") {
        if (recent(lookupCreated, ip, 3_600_000).length >= LOOKUP_CREATE_PER_HOUR) return fail(res, 429, "too many lookups", "rate_limited");
        const body = await readJson(req);
        if (typeof body?.id !== "string" || !LOOKUP_ID.test(body.id) || typeof body.sealed !== "string" || !B64URL.test(body.sealed) || body.sealed.length > 16_384
          || !Number.isInteger(body.ttlS) || body.ttlS < 30 || body.ttlS > 900 || (body.deleteVerifier !== undefined && (typeof body.deleteVerifier !== "string" || !HEX64.test(body.deleteVerifier)))) {
          return fail(res, 400, "invalid lookup");
        }
        sweepLookups();
        const list = recent(lookupCreated, ip, 3_600_000);
        if (list.length >= LOOKUP_CREATE_PER_HOUR) return fail(res, 429, "too many lookups", "rate_limited");
        if (lookups.has(body.id)) return fail(res, 409, "lookup id is taken", "taken");
        if (lookups.size >= MAX_LOOKUPS) return fail(res, 503, "The link service is busy. Try again in a minute.", "busy");
        const expiresAt = now() + body.ttlS * 1000;
        lookups.set(body.id, { sealed: body.sealed, expiresAt, deleteVerifier: body.deleteVerifier });
        list.push(now());
        return send(res, 201, { ok: true, expiresAt });
      }
      const lookup = lookups.get(id);
      if (id && method === "GET") {
        if (lookup) return send(res, 200, { sealed: lookup.sealed, expiresAt: lookup.expiresAt });
        const list = recent(lookupMisses, ip, 3_600_000);
        if (list.length >= LOOKUP_MISSES_PER_HOUR) return fail(res, 429, "too many lookup misses", "rate_limited");
        list.push(now());
        return fail(res, 404, "not found", "not_found");
      }
      if (id && method === "DELETE") {
        if (!lookup || !sameHash(bearer(req), lookup.deleteVerifier)) return fail(res, 404, "not found", "not_found");
        lookups.delete(id);
        return send(res, 200, { ok: true });
      }
      return fail(res, 405, "method not allowed");
    }

    if (method === "POST" && path === "/v1/sessions") {
      const ip = clientIp(req);
      const t = now();
      const recent = (created.get(ip) ?? []).filter((at) => t - at < 3_600_000);
      const burst = (list, most) => list.filter((at) => t - at < 60_000).length >= most;
      if (recent.length >= CREATE_PER_HOUR || burst(recent, CREATE_PER_MINUTE_IP)) return fail(res, 429, "Too many new links from here. Try again in a while.", "rate_limited");
      store.sweep();
      if (store.sessions.size >= MAX_SESSIONS) return fail(res, 503, "The link service is busy. Try again in a minute.", "busy");
      const body = await readJson(req);
      let acct = null, byAccount = null;
      if (grantKeys) {
        const verdict = verifyLinkGrant(body?.grant, { keys: grantKeys, now: now() });
        if (!verdict.ok) return fail(res, 401, "Sign in to your Metal account in the app to link a server.", "account_required");
        acct = verdict.acct;
        if (accountTunnels(acct) >= limits.tunnelsPerAccount) return fail(res, 409, `This account already has ${limits.tunnelsPerAccount} linked servers. Remove one in the app to link another.`, "tunnel_limit");
        byAccount = (created.get(`acct:${acct}`) ?? []).filter((at) => t - at < 3_600_000);
        if (byAccount.length >= CREATE_PER_HOUR || burst(byAccount, CREATE_PER_MINUTE)) return fail(res, 429, "Too many new links from this account. Try again in a while.", "rate_limited");
      }
      if (!HEX64.test(body?.verifier ?? "")) return fail(res, 400, "verifier must be 64 hex characters");
      if (typeof body?.appPub !== "string" || !B64URL.test(body.appPub) || body.appPub.length > 64) return fail(res, 400, "appPub must be a base64url x25519 key");
      const label = typeof body?.label === "string" ? body.label.replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 60) : "";
      let id;
      do id = randomB32(10); while (store.sessions.has(id) || store.tunnels.has(id) || store.channels.has(id));
      const watch = randomBytes(32).toString("base64url");
      // an account holds a few unused commands at most: a new one retires its oldest, so no account fills the store
      if (acct) {
        const waiting = [...store.sessions.values()].filter((one) => one.acct === acct && one.state === "waiting").sort((a, b) => a.createdAt - b.createdAt);
        for (const old of waiting.slice(0, Math.max(0, waiting.length - (OPEN_PER_ACCOUNT - 1)))) { store.sessions.delete(old.id); wakeSession(old.id); }
      }
      store.sessions.set(id, { id, createdAt: t, state: "waiting", vpsVerifier: body.verifier, watchVerifier: sha256hex(watch), appPub: body.appPub, label, events: [], seq: 0, ...(acct ? { acct } : {}) });
      recent.push(t);
      created.set(ip, recent);
      if (byAccount) { byAccount.push(t); created.set(`acct:${acct}`, byAccount); }
      store.save();
      return send(res, 201, { id, watch, expiresAt: t + 30 * 60_000, base, install: `curl -fsSL ${base}/i/` });
    }

    if ((parts = /^\/v1\/sessions\/([a-z2-7]{10})(?:\/(claim|events|result|probe|short))?$/.exec(path))) {
      const [, id, action] = parts;
      // the app asks for the short line of a session it made: it hands over the vps secret, checked against the verifier
      if (action === "short" && method === "POST") {
        const session = appSession(req, res, id);
        if (!session) return;
        const body = await readJson(req);
        const secret = typeof body?.secret === "string" && /^[a-z2-7]{26}$/.test(body.secret) ? body.secret : null;
        if (!secret || !sameHash(sha256hex(`omb-link-v1|vps|${secret}`), session.vpsVerifier)) return fail(res, 400, "secret does not match this session");
        if (!["waiting", "installing"].includes(store.stateOf(session))) return fail(res, 410, "This command was already used. Make a new one in the app.", "used");
        if (!session.short) {
          let code;
          do code = randomShort(); while (shortSession(code, true));
          session.short = code;
          session.shortSecret = secret;
          store.save();
        }
        return send(res, 200, { code: session.short, url: `${shortBase}/s/${session.short}` });
      }
      if (action === "claim" && method === "POST") {
        const session = vpsSession(req, res, id);
        if (!session) return;
        const body = await readJson(req);
        if (!vpsSession(req, res, id)) return;
        const host = body?.host && typeof body.host === "object"
          ? { arch: String(body.host.arch ?? "").slice(0, 20), os: String(body.host.os ?? "").slice(0, 60), name: String(body.host.name ?? "").slice(0, 60) } : null;
        if (session.state === "waiting") session.state = "installing";
        session.claimedAt ??= now();
        if (host) session.host = host;
        session.events.push({ seq: ++session.seq, at: now(), step: "claim", status: "done" });
        store.save();
        wakeSession(id);
        const build = packages.current();
        return send(res, 200, {
          ok: true, expiresAt: session.createdAt + SESSION_LIFE_MS, appPub: session.appPub, label: session.label,
          ...(build ? { package: { sha256: build.sha256, size: build.size, version: build.version, ...(build.signature ? { signature: build.signature } : {}), path: `/pkg/${id}/${build.sha256}.tgz` } } : {}),
          ...(packages.policy() ? { policy: packages.policy() } : {}),
          ...(build?.desktop ? { desktop: { sha256: build.desktop.sha256, size: build.desktop.size, image: build.desktop.image, path: `/pkg/${id}/${build.desktop.sha256}.tgz` } } : {}),
        });
      }
      if (action === "events" && method === "POST") {
        const session = vpsSession(req, res, id);
        if (!session) return;
        if (session.state === "waiting") return fail(res, 409, "claim first", "not_claimed");
        const body = await readJson(req);
        if (!vpsSession(req, res, id)) return;
        if (!STEP.test(body?.step ?? "") || !STATUSES.has(body?.status)) return fail(res, 400, "step and status are required");
        const progress = body.progress === undefined ? undefined : installerProgress(body.progress);
        const activity = body.activity === undefined ? undefined : installerActivity(body.activity);
        const ask = body.ask === undefined ? undefined : installerAsk(body.ask);
        if (body.ask !== undefined && !ask) return fail(res, 400, "invalid installer ask");
        if (progress === null || activity === null || (body.heartbeat !== undefined && typeof body.heartbeat !== "boolean")) return fail(res, 400, "invalid installer progress or activity");
        if (body.lines !== undefined && (!Array.isArray(body.lines) || body.lines.length > MAX_LINES || body.lines.some((line) => typeof line !== "string"))) {
          return fail(res, 400, `lines must be up to ${MAX_LINES} strings`);
        }
        const log = typeof body.log === "string" && body.log ? body.log.slice(-MAX_LOG) : undefined;
        const cmd = typeof body.cmd === "string" && body.cmd ? body.cmd.slice(0, MAX_CMD) : undefined;
        let lines;
        if (body.lines?.length) {
          let bytes = 0;
          lines = [];
          for (const line of body.lines.slice().reverse()) {
            const text = line.slice(0, MAX_LINE);
            if ((bytes += text.length) > MAX_LINES_BYTES) break;
            lines.unshift(text);
          }
        }
        // line batches are the many, short-lived events: past KEEP_LINE_EVENTS the oldest go first, status events stay
        if (lines || progress || activity || body.heartbeat) {
          const kept = session.events.filter((event) => event.lines || event.progress || event.activity || event.heartbeat);
          if (kept.length >= KEEP_LINE_EVENTS) { const drop = kept[0]; session.events.splice(session.events.indexOf(drop), 1); }
        }
        if (session.events.length >= MAX_EVENTS) session.events.splice(1, session.events.length - MAX_EVENTS + 1);
        const event = { seq: ++session.seq, at: now(), step: body.step, status: body.status, ...(log ? { log } : {}), ...(cmd ? { cmd } : {}), ...(lines ? { lines } : {}),
          ...(progress ? { progress } : {}), ...(activity ? { activity } : {}), ...(body.heartbeat ? { heartbeat: true } : {}), ...(ask ? { ask } : {}) };
        session.events.push(event);
        store.save();
        wakeSession(id);
        return send(res, 200, { seq: event.seq });
      }
      if (action === "probe" && method === "POST") {
        const session = vpsSession(req, res, id);
        if (!session) return;
        const body = await readJson(req);
        if (!vpsSession(req, res, id)) return;
        if (!NONCE.test(body?.nonce ?? "")) return fail(res, 400, "nonce must be 16-64 lowercase letters or digits");
        const ip = clientIp(req);
        if ((session.probes = (session.probes ?? 0) + 1) > 10) return fail(res, 429, "too many probes", "rate_limited");
        const reachable = await probe(ip, body.nonce);
        if (!vpsSession(req, res, id)) return;
        return send(res, 200, { ip, reachable });
      }
      if (action === "result" && method === "POST") {
        if (await sameResultAgain(req, res, id)) return;
        const session = vpsSession(req, res, id);
        if (!session) return;
        if (session.state === "waiting") return fail(res, 409, "claim first", "not_claimed");
        const body = await readJson(req);
        if (!vpsSession(req, res, id)) return;
        if (typeof body?.sealed !== "string" || !B64URL.test(body.sealed) || body.sealed.length > 16_384) return fail(res, 400, "sealed must be base64url");
        if (typeof body?.vpsPub !== "string" || !B64URL.test(body.vpsPub) || body.vpsPub.length > 64) return fail(res, 400, "vpsPub must be base64url");
        const tunnel = body?.tunnel;
        if (tunnel !== undefined && (!HEX64.test(tunnel?.vps ?? "") || !HEX64.test(tunnel?.app ?? ""))) return fail(res, 400, "tunnel verifiers must be 64 hex characters");
        if (tunnel) {
          if (store.tunnels.size >= MAX_TUNNELS) return fail(res, 503, "The link service is full.", "busy");
          if (session.acct && accountTunnels(session.acct) >= limits.tunnelsPerAccount) {
            return fail(res, 409, `This account already has ${limits.tunnelsPerAccount} linked servers. Remove one in the app to link another.`, "tunnel_limit");
          }
          // home is where it was linked (both ends start there), not the default node: a node other than the default
          // would otherwise send the app away with 409 until the server first polls
          store.tunnels.set(id, { id, createdAt: now(), vpsVerifier: tunnel.vps, appVerifier: tunnel.app, seenAt: null, ...(cluster ? { home: nodeId } : {}), ...(session.acct ? { acct: session.acct } : {}) });
          cluster?.changed(store.tunnels.get(id));
          session.tunnel = id;
        }
        session.state = "linked";
        session.endedAt = now();
        delete session.shortSecret;
        session.sealed = body.sealed;
        session.vpsPub = body.vpsPub;
        session.events.push({ seq: ++session.seq, at: now(), step: "link", status: "done" });
        store.save();
        wakeSession(id);
        return send(res, 200, { ok: true });
      }
      if (!action && method === "DELETE") {
        const session = appSession(req, res, id);
        if (!session) return;
        if (session.state !== "linked") { session.state = "cancelled"; session.endedAt = now(); delete session.shortSecret; store.save(); wakeSession(id); }
        return send(res, 200, { ok: true });
      }
      if (action === "events" && method === "GET") {
        const session = appSession(req, res, id);
        if (!session) return;
        const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        if (/text\/event-stream/.test(String(req.headers.accept ?? ""))) return streamSession(res, session, after, abort.signal);
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number.parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
        const ended = () => ["linked", "cancelled", "expired"].includes(store.stateOf(session));
        if (wait && session.seq <= after && !ended()) await waitSession(id, wait * 1000, abort.signal);
        if (abort.signal.aborted) return;
        return send(res, 200, view(session, after));
      }
      return fail(res, 405, "method not allowed");
    }

    // the private server build and desktop kit: only for a claimed session that is still installing, with its own bearer token
    if (method === "GET" && (parts = /^\/pkg\/([a-z2-7]{10})\/([0-9a-f]{64})\.tgz$/.exec(path))) {
      const [, id, sha] = parts;
      const session = vpsSession(req, res, id);
      if (!session) return;
      if (session.state !== "installing") return fail(res, 409, "claim first", "not_claimed");
      const build = packages.find(sha);
      if (!build) return fail(res, 404, "not found", "not_found");
      return sendPackage(req, res, build, () => {
        if ((session.downloads = (session.downloads ?? 0) + 1) > PACKAGE_DOWNLOADS) return false;
        store.save();
        return true;
      });
    }

    // a linked server updating itself: the build new installs get, to the tunnel's own vps token only, rate limited
    if (method === "GET" && (parts = /^\/v1\/tunnels\/([a-z2-7]{10})\/server(?:\/([0-9a-f]{64})\.tgz)?$/.exec(path))) {
      const [, id, sha] = parts;
      const tunnel = tunnelFor(req, res, id, "vps");
      if (!tunnel) return;
      const build = packages.current();
      if (!sha) {
        const reads = recent(serverReads, id, 3_600_000);
        if (reads.length >= SERVER_RELEASE_READS_PER_HOUR) return fail(res, 429, "too many update checks", "rate_limited");
        reads.push(now());
        res.setHeader("cache-control", "no-store, private");
        if (!build) return fail(res, 404, "no build is published", "no_build");
        const policy = packages.policy();
        return send(res, 200, { v: 1, package: { sha256: build.sha256, size: build.size, version: build.version, ...(build.signature ? { signature: build.signature } : {}) }, ...(policy ? { policy } : {}) });
      }
      // only the current build: an old one is never handed out again this way
      if (!build || build.sha256 !== sha) return fail(res, 404, "not found", "not_found");
      return sendPackage(req, res, packages.find(sha), () => {
        const downloads = recent(serverDownloads, id, 86_400_000);
        if (downloads.length >= SERVER_DOWNLOADS_PER_DAY) return false;
        downloads.push(now());
        return true;
      });
    }

    if ((parts = /^\/v1\/tunnels\/([a-z2-7]{10})\/channels(?:\/(to-vps)|\/([a-z2-7]{10})\/to-app)?$/.exec(path))) {
      const [, id, aggregate, cid] = parts;
      const owner = tunnelFor(req, res, id, "vps");
      if (!owner) return;
      touchTunnel(owner);
      if (method === "GET") attach(owner);
      if (!aggregate && !cid && method === "PUT") {
        const body = await readJson(req);
        if (!tunnelFor(req, res, id, "vps")) return;
        const list = body?.channels, t = now(), ids = new Set();
        if (!Array.isArray(list) || list.length > MAX_CHANNELS_PER_TUNNEL) return fail(res, 400, "invalid channels");
        for (const channel of list) {
          if (typeof channel?.id !== "string" || !ID.test(channel.id) || ids.has(channel.id) || typeof channel.verifier !== "string" || !HEX64.test(channel.verifier)
            || (channel.kind !== "grant" && channel.kind !== "device")
            || (channel.kind === "grant" ? !Number.isSafeInteger(channel.expiresAt) || channel.expiresAt <= t || channel.expiresAt > t + CHANNEL_GRANT_MS : channel.expiresAt != null)) {
            return fail(res, 400, "invalid channel");
          }
          ids.add(channel.id);
        }
        for (const channel of list) {
          if (store.sessions.has(channel.id) || store.tunnels.has(channel.id) || (store.channels.has(channel.id) && store.channels.get(channel.id).tunnel !== id)) {
            return fail(res, 409, "channel id is taken", "taken", { id: channel.id });
          }
        }
        for (const channel of store.channels.values()) if (channel.tunnel === id && !ids.has(channel.id)) deleteChannel(channel);
        for (const channel of list) {
          const kept = store.channels.get(channel.id);
          if (kept) {
            const same = kept.verifier === channel.verifier && kept.kind === channel.kind && (kept.expiresAt ?? null) === (channel.expiresAt ?? null);
            if (kept.verifier !== channel.verifier) clearQueues(channel.id);
            Object.assign(kept, { verifier: channel.verifier, kind: channel.kind, expiresAt: channel.expiresAt ?? null });
            if (!same) cluster?.changed(kept);
          } else {
            store.channels.set(channel.id, { id: channel.id, tunnel: id, verifier: channel.verifier, kind: channel.kind, expiresAt: channel.expiresAt ?? null, createdAt: t, seenAt: null });
            cluster?.changed(store.channels.get(channel.id));
          }
        }
        store.save();
        channelReaders.get(id)?.wakeAll();
        return send(res, 200, { ok: true, channels: list.length });
      }
      if (cid && method === "POST") {
        const authorize = () => tunnelFor(req, res, id, "vps") && channelFor(req, res, cid, id);
        if (!channelFor(req, res, cid, id)) return;
        return postFrames(req, res, cid, "to-app", authorize);
      }
      if (aggregate && method === "GET") {
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number.parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
        const abort = new AbortController();
        const reading = serverReading.get(id) ?? { open: 0, endedAt: now() };
        serverReading.set(id, reading);
        reading.open += 1;
        res.on("close", () => { abort.abort(); reading.open -= 1; reading.endedAt = now(); });
        const reader = channelReader(id), turn = reader.claim();
        if (wait && url.searchParams.get("stream") === "1") return streamChannels(res, id, reader, turn, wait * 1000, abort.signal);
        const until = Date.now() + wait * 1000;
        let batch;
        while (!abort.signal.aborted && reader.holds(turn) && store.tunnels.has(id) && !(batch = channelBatch(id, reader))) {
          const left = until - Date.now();
          if (left <= 0) break;
          await reader.wait(left, abort.signal);
        }
        if (abort.signal.aborted) return;
        if (!store.tunnels.has(id)) return fail(res, 404, "not found", "not_found");
        const batches = [];
        if (batch) {
          batches.push(batch);
          const seen = new Set([batch.channel]);
          for (const channel of store.channels.values()) {
            if (channel.tunnel !== id || seen.has(channel.id) || !liveChannel(channel.id)) continue;
            const q = queues.get(`${channel.id}:to-vps`);
            if (q?.length) batches.push({ channel: channel.id, frames: q.take() });
          }
        }
        return send(res, 200, { batches });
      }
      return fail(res, 405, "method not allowed");
    }

    if ((parts = /^\/v1\/channels\/([a-z2-7]{10})(?:\/(to-vps|to-app))?$/.exec(path))) {
      const [, id, action] = parts;
      const channel = channelFor(req, res, id);
      if (!channel) return;
      if (!action && method === "DELETE") { deleteChannel(channel); return send(res, 200, { ok: true }); }
      if (action && elsewhere(res, store.tunnels.get(channel.tunnel))) return;
      if (action === "to-vps" && method === "POST") {
        if (serverAway(channel.tunnel)) return fail(res, 503, "The computer or server is not reading its relay right now.", "server_away");
        if (!phoneRate(res, channel, "POST")) return;
        return postFrames(req, res, id, action, () => channelFor(req, res, id), true);
      }
      if (action === "to-app" && method === "GET") {
        if (!phoneRate(res, channel, "GET")) return;
        const t = now();
        channel.seenAt = t;
        if (!channelSeen.has(id) || t - channelSeen.get(id) >= 60_000) { channelSeen.set(id, t); store.save(); }
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number.parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
        const ms = Math.min(wait * 1000, channel.expiresAt == null ? Infinity : Math.max(0, channel.expiresAt - t));
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        const q = queue(id, action), verifier = channel.verifier;
        const alive = () => liveChannel(id)?.verifier === verifier;
        if (wait && url.searchParams.get("stream") === "1") return streamFrames(res, id, q, ms, abort.signal, alive);
        if (wait && q.length === 0) await q.wait(ms, abort.signal);
        if (abort.signal.aborted) return;
        if (!alive() || queues.get(`${id}:${action}`) !== q) return fail(res, 404, "not found", "not_found");
        return send(res, 200, { frames: q.take() });
      }
      return fail(res, 405, "method not allowed");
    }

    // where a server lives (the app, either token), where it should go (its agent, on start and after losing its node),
    // and turn credentials for the webrtc path; phones ask the same about their channel
    if ((parts = /^\/v1\/tunnels\/([a-z2-7]{10})\/address$/.exec(path))) {
      if (method !== "PUT") return fail(res, 405, "method not allowed");
      const tunnel = tunnelFor(req, res, parts[1], "vps");
      if (!tunnel) return;
      const sealed = (await readJson(req))?.sealed;
      if (typeof sealed !== "string" || sealed.length > SEALED_ADDRESS_MAX || !B64URL.test(sealed)) return fail(res, 400, "invalid address");
      if (tunnel.addr !== sealed) { tunnel.addr = sealed; if (cluster) cluster.changed(tunnel); else store.save(); }
      return send(res, 200, { ok: true });
    }
    if ((parts = /^\/v1\/(tunnels|channels)\/([a-z2-7]{10})\/(node|place|turn)$/.exec(path))) {
      const [, kind, id, action] = parts;
      if (kind === "channels" && action === "place") return fail(res, 404, "not found");
      if (action === "place" ? method !== "POST" : method !== "GET") return fail(res, 405, "method not allowed");
      const channel = kind === "channels" ? channelFor(req, res, id) : null;
      if (kind === "channels" && !channel) return;
      const tunnel = channel ? store.tunnels.get(channel.tunnel) : tunnelFor(req, res, id, action === "place" ? "vps" : "either");
      if (!tunnel) return channel ? fail(res, 404, "not found", "not_found") : undefined;
      res.setHeader("cache-control", "no-store");
      if (action === "node") return send(res, 200, { ...whereIs(tunnel), ...(!channel && tunnel.addr ? { address: tunnel.addr } : {}) });
      if (action === "place") return send(res, 200, await place(tunnel, await readJson(req)));
      if (!turnConfig) return fail(res, 404, "turn is not set up on this link service", "no_turn");
      return send(res, 200, turnAnswer(id, tunnel));
    }

    // the app says which way it reaches its server now (and when its person last sent a chat message): the split the
    // ops page shows, and how many people chat right now. any node takes it; counts stay on the node that heard them
    if ((parts = /^\/v1\/tunnels\/([a-z2-7]{10})\/report$/.exec(path))) {
      if (method !== "POST") return fail(res, 405, "method not allowed");
      const tunnel = tunnelFor(req, res, parts[1], "app");
      if (!tunnel) return;
      const body = await readJson(req);
      if (!["direct", "cloudflare", "relay"].includes(body?.path)) return fail(res, 400, "path must be direct, cloudflare or relay");
      paths.report(tunnel, body.path, Number.isFinite(body.chatAgoMs) && body.chatAgoMs >= 0 ? now() - body.chatAgoMs : null);
      return send(res, 200, { ok: true });
    }

    if ((parts = /^\/v1\/tunnels\/([a-z2-7]{10})(?:\/(to-vps|to-app|status))?$/.exec(path))) {
      const [, id, action] = parts;
      // either end may end it: the app forgetting the server, or uninstall.sh on the server with the vps token
      if (!action && method === "DELETE") {
        const tunnel = tunnelFor(req, res, id, "either");
        if (!tunnel) return;
        store.tunnels.delete(id);
        for (const channel of store.channels.values()) if (channel.tunnel === id) deleteChannel(channel);
        dropTunnelState(id);
        store.save();
        cluster?.removed("tunnel", id);
        return send(res, 200, { ok: true });
      }
      if (action === "status" && method === "GET") {
        const tunnel = tunnelFor(req, res, id, "app");
        if (!tunnel) return;
        return send(res, 200, { seenAt: tunnel.seenAt ?? null });
      }
      if (action !== "to-vps" && action !== "to-app") return fail(res, 405, "method not allowed");
      // the app writes to-vps and reads to-app; the vps the other way round
      const writer = action === "to-vps" ? "app" : "vps";
      const role = method === "POST" ? writer : writer === "app" ? "vps" : "app";
      const tunnel = tunnelFor(req, res, id, role);
      if (!tunnel) return;
      if (role === "app" && elsewhere(res, tunnel)) return;
      if (role === "vps") touchTunnel(tunnel);
      if (role === "vps" && method === "GET") attach(tunnel);
      if (method === "POST") {
        const body = await readJson(req, MAX_BODY);
        const frames = body?.frames;
        if (!Array.isArray(frames) || frames.length === 0 || frames.length > 256 || frames.some((frame) => typeof frame !== "string" || frame.length > FRAME_MAX || !B64URL.test(frame))) {
          return fail(res, 400, "frames must be 1-256 base64url strings");
        }
        const ordered = typeof body.epoch === "string" && EPOCH.test(body.epoch) && Number.isSafeInteger(body.seq) && body.seq >= 0;
        const turn = roomFor(res, frames) && await tunnelBudget(res, id, frames, !ordered && body.lane === true);
        if (!turn) return;
        const q = queue(id, action);
        if (!(ordered ? q.pushInOrder(frames, body.epoch, body.seq) : q.push(frames, body.lane === true))) { turn.refund(); return fail(res, 429, "the other side is behind; try again", "queue_full"); }
        turn.charge();
        return send(res, 200, { ok: true, ordered: true });
      }
      if (method === "GET") {
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number.parseInt(url.searchParams.get("wait") ?? "0", 10) || 0));
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        const q = queue(id, action);
        if (wait && url.searchParams.get("stream") === "1") return streamFrames(res, id, q, wait * 1000, abort.signal);
        if (wait && q.length === 0) await q.wait(wait * 1000, abort.signal);
        if (abort.signal.aborted || !store.tunnels.has(id)) return abort.signal.aborted ? undefined : fail(res, 404, "not found", "not_found");
        return send(res, 200, { frames: q.take() });
      }
      return fail(res, 405, "method not allowed");
    }

    return fail(res, 404, "not found");
  }

  /** a long poll that stays open: each batch of frames goes out as one json line the moment it is queued */
  async function streamFrames(res, id, q, ms, signal, alive = () => store.tunnels.has(id)) {
    const turn = q.claim();
    signal = AbortSignal.any([signal, q.signal, AbortSignal.timeout(ms)]);
    const until = Date.now() + ms;
    res.writeHead(200, streamHead);
    let first = true, wrote = Date.now();
    try {
      while (!signal.aborted && q.holds(turn) && alive() && Date.now() < until) {
        if (!first && q.length === 0) {
          const left = until - Date.now();
          if (left <= 0) break;
          if (Date.now() - wrote >= BEAT_MS) { await writeLine(res, { frames: [] }, signal); wrote = Date.now(); continue; }
          await q.wait(Math.min(left, BEAT_MS - (Date.now() - wrote)), signal);
          continue;
        }
        first = false;
        await writeLine(res, { frames: q.take(256, STREAM_LINE_BYTES) }, signal);
        wrote = Date.now();
      }
    } finally { res.end(); }
  }

  async function streamChannels(res, id, reader, turn, ms, signal) {
    signal = AbortSignal.any([signal, reader.signal, AbortSignal.timeout(ms)]);
    const until = Date.now() + ms;
    res.writeHead(200, streamHead);
    let wrote = Date.now();
    try {
      await writeLine(res, { frames: [] }, signal);
      while (!signal.aborted && reader.holds(turn) && store.tunnels.has(id) && Date.now() < until) {
        const batch = channelBatch(id, reader);
        if (batch) { await writeLine(res, batch, signal); wrote = Date.now(); }
        else if (Date.now() - wrote >= BEAT_MS) { await writeLine(res, { frames: [] }, signal); wrote = Date.now(); }
        else await reader.wait(Math.max(1, Math.min(until - Date.now(), BEAT_MS - (Date.now() - wrote))), signal);
      }
    } finally { res.end(); }
  }
  // a streamed read says something at least every BEAT_MS (an empty line when idle), and says so in x-link-beat: a
  // client that hears nothing for a few beats knows its connection died (a network switch leaves it silent, not closed)
  const streamHead = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no", "x-link-boot": boot, "x-link-beat": String(BEAT_MS / 1000) };
  async function writeLine(res, body, signal) {
    if (!res.write(`${JSON.stringify(body)}\n`)) {
      await new Promise((resolve) => {
        const done = () => { res.off("drain", done); signal.removeEventListener("abort", done); resolve(); };
        res.once("drain", done);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }

  async function streamSession(res, session, after, signal) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
    let sent = after;
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    beat.unref?.();
    try {
      for (;;) {
        const current = view(session, sent);
        for (const event of current.events) res.write(`id: ${event.seq}\nevent: step\ndata: ${JSON.stringify(event)}\n\n`);
        sent = Math.max(sent, session.seq);
        const { events: _events, ...state } = current;
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        if (["linked", "cancelled", "expired"].includes(current.state) || signal.aborted) break;
        await waitSession(session.id, MAX_WAIT_S * 1000, signal);
        if (signal.aborted) break;
      }
    } finally {
      clearInterval(beat);
      res.end();
    }
  }

  /** per client address: requests in flight and a request rate, so one address cannot hold every socket or flood the service */
  function admit(req, res) {
    const ip = clientIp(req), t = now();
    let load = ipLoad.get(ip);
    if (!load) ipLoad.set(ip, (load = { open: 0, at: t, tokens: ipLimits.burst }));
    load.tokens = refill(load.tokens, load.at, t, ipLimits.perSecond, ipLimits.burst);
    load.at = t;
    if (load.open >= ipLimits.concurrent || load.tokens < 1) {
      send(res, 429, { error: "Too many requests from here. Try again in a moment.", code: "rate_limited" }, { "retry-after": "5" });
      return false;
    }
    load.tokens -= 1;
    load.open += 1;
    let done = false;
    const release = () => { if (!done) { done = true; load.open -= 1; } };
    res.once("close", release);
    res.once("finish", release);
    return true;
  }

  return {
    store,
    /** each account's relay bytes this month, this node's and its peers' (fair-use.mjs) */
    fairUse: accountMonths,
    async handler(req, res) {
      if (!admit(req, res)) return;
      try {
        await handle(req, res);
      } catch (error) {
        const status = typeof error?.status === "number" ? error.status : 500;
        if (status === 500) log(`link: ${error?.stack ?? error}`);
        if (!res.headersSent) fail(res, status, status === 500 ? "something went wrong" : error.message);
        else res.end();
      }
    },
    cluster,
    start() { cluster?.start(); box?.start(); turnWatch?.start(); },
    close() { accountMonths.save(); cluster?.stop(); box?.stop(); turnWatch?.stop(); for (const q of queues.values()) q.close(); for (const q of channelReaders.values()) q.close(); store.close(); usage.save(); },
  };
}
