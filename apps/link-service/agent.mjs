// the duskbot link agent on a person's vps. the install script runs it as:
//   node agent.mjs probe    (root)  can the link service reach this server directly on port 80? exit 0 yes, 3 no
//   node agent.mjs link     (omb-link)  mint a pairing code, seal it for the app, report the result, write tunnel.json
//   node agent.mjs tunnel   (omb-link)  the steady-state relay: requests from the app, sealed end to end, to 127.0.0.1:8799
//   node agent.mjs direct   (omb-link)  the same frames on stdin/stdout: what the app's own ssh key may run, and nothing else
//   node agent.mjs selftest (anyone)    prints this agent's version and protocol: how a staged update proves it loads
// omb-link is its own account, never the server's: tunnel.json and the app's ssh key stay out of the bots' reach.
// standalone on purpose: node's own modules only, one file the link service serves at /agent.mjs.
// it also lends the bot computers on this server the app's own internet connection when the person turns on "route
// traffic through this computer": a socks5 and http connect proxy on the bot computers' bridge (see createEgressProxy).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { X509Certificate, createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, verify as verifySignature } from "node:crypto";
import { createSocket } from "node:dgram";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { BlockList, createConnection, createServer as createTcpServer } from "node:net";
import { Agent as HttpAgent, createServer, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, Socket } from "node:net";
import { Duplex, Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { connect as http2Connect, constants as h2Constants } from "node:http2";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// names from before the rename, kept here because this file stands alone: an install made then still sets OMB_*,
// keeps its files in ~/.config/openmausbot-link, and runs a server that knows only the old header and path names.
const OLD_ENV = ["OMB_", "OPENMAUSBOT_"];
const OLD_HEADER = "x-openmausbot-";
const OLD_WELL_KNOWN = "/.well-known/openmausbot";
const OLD_CONFIG = "openmausbot-link";
for (const key of Object.keys(process.env)) {
  const prefix = OLD_ENV.find((p) => key.toUpperCase().startsWith(p));
  if (!prefix) continue;
  if (process.env[`DUSK_${key.slice(prefix.length)}`] === undefined) process.env[`DUSK_${key.slice(prefix.length)}`] = process.env[key];
  delete process.env[key];
}
const isOwnHeader = (lower) => lower.startsWith("x-dusk-") || lower.startsWith(OLD_HEADER);
const withLegacyHeaders = (headers) => Object.fromEntries(Object.entries(headers).flatMap(([key, value]) =>
  key.startsWith("x-dusk-") ? [[key, value], [OLD_HEADER + key.slice(7), value]] : [[key, value]]));
const fromLegacyPath = (path) => path === OLD_WELL_KNOWN || path.startsWith(`${OLD_WELL_KNOWN}/`) ? `/.well-known/duskbot${path.slice(OLD_WELL_KNOWN.length)}` : path;
const toLegacyPath = (path) => path.startsWith("/.well-known/duskbot") ? OLD_WELL_KNOWN + path.slice("/.well-known/duskbot".length) : path;

export const SERVER = { host: "127.0.0.1", port: Number(process.env.LINK_SERVER_PORT) || 8799 };
/**
 * the link protocol this agent speaks with the app, and the oldest app and server (server/link-protocol.ts) it works
 * with. a change an older peer cannot work with raises the protocol and that peer's minimum; an optional feature is a
 * capability instead, which the app checks for before it uses the feature
 */
export const LINK_PROTOCOL = 2;
export const LINK_MIN_APP = 1;
export const LINK_MIN_SERVER = 1;
export const AGENT_VERSION = "2.4.5";
export const AGENT_CAPS = Object.freeze(["direct-ssh", "direct-wss", "direct-rtc", "direct-cf", "egress", "egress-lane", "self-update", "cloud-relay"]);
/** what this agent says about itself, in its direct hello and its answer to the app's `hello` */
export const agentHello = () => ({ protocol: LINK_PROTOCOL, minApp: LINK_MIN_APP, minServer: LINK_MIN_SERVER, agent: AGENT_VERSION, caps: [...AGENT_CAPS] });
const FRAME_SKEW_MS = 5 * 60_000;
/**
 * frames are stamped and checked in the link service's time (its Date header), so an app and a server whose own clocks
 * disagree by more than FRAME_SKEW_MS still take each other's frames; a peer on its own clock still matches when that
 * clock is right. differences under RELAY_CLOCK_SLACK_MS are the header's one-second grain and the trip, not drift.
 */
const RELAY_CLOCK_SLACK_MS = 3000;
let relayOffsetMs = 0;
export function noteRelayDate(value, now = Date.now()) {
  const at = Date.parse(value ?? "");
  if (!Number.isFinite(at)) return;
  const offset = at + 500 - now;
  relayOffsetMs = Math.abs(offset) < RELAY_CLOCK_SLACK_MS ? 0 : offset;
}
export const relayNow = () => Date.now() + relayOffsetMs;
const CHUNK = 128 * 1024;
/** one post stays well under a proxy's usual 1 MB body limit (nginx's default) */
const BATCH_BYTES = 700 * 1024;

/** a websocket's bytes wait here at most this much before its socket is paused (the link service queues 16 MB a side) */
const STREAM_HIGH = 2 * 1024 * 1024;
const STREAM_LOW = 512 * 1024;
const RECEIVE_HIGH = 8 * 1024 * 1024;
/** posts out at once once the relay says it puts them back in order (one before it does) */
const POSTS_IN_FLIGHT = 3;
/** how long a frame that comes while posts are out waits for more, per post out, and at most */
const GATHER_MS = 2;
const GATHER_MAX_MS = 16;
/** over http/1.1 (three posts out) every post waits this long for company first, as it always did */
const H1_POST_DELAY_MS = 5;
/**
 * frames waiting for the one post in flight (kept in step with the other end of the tunnel). a stream's bytes join its
 * last waiting piece and are sealed only when sent, so a busy websocket costs a few frames per post, not one per chunk.
 */
export function createOutbox({ seal: sealRaw, post, delayMs, signal, onError = () => {}, parallel = () => 1 }) {
  const streams = new Map();
  const drains = new Set();
  let flushing = null, queued = 0, seq = 0, nudge = null;
  const release = () => { const waiting = [...drains]; drains.clear(); for (const resume of waiting) resume(); };
  const clear = () => { streams.clear(); queued = 0; };
  /**
   * with nothing out, frames pushed in the same turn share a post that leaves at once (delay 0). frames that come while
   * posts are out wait a little for company, longer the more are out, so a burst spread over a few milliseconds (a page's
   * twenty requests) fills a few posts instead of taking every slot and waiting a round trip for the rest. `delayMs` may
   * be a function: with only three posts out at once (http/1.1) a fixed wait before every post keeps more slots free
   */
  const gather = (outstanding) => {
    const fixed = typeof delayMs === "function" ? delayMs() : delayMs;
    if (fixed > 0) return delay(fixed, undefined, { signal });
    return outstanding ? delay(Math.min(GATHER_MAX_MS, GATHER_MS * outstanding), undefined, { signal }) : new Promise((resolve) => setImmediate(resolve));
  };
  signal?.addEventListener("abort", () => { clear(); release(); }, { once: true });
  function stream(r) {
    let items = streams.get(r);
    if (!items) streams.set(r, (items = []));
    return items;
  }
  function batch() {
    const frames = [];
    let size = 0;
    for (;;) {
      let progressed = false;
      const round = [...streams];
      for (const [r, items] of round) {
        const item = items[0];
        if (!item.sealed) {
          item.sealed = sealRaw(r, item.parts.length === 1 ? item.parts[0] : Buffer.concat(item.parts));
          queued += item.sealed.length - item.size;
          item.size = item.sealed.length;
          delete item.parts;
        }
        if (frames.length && size + item.size > BATCH_BYTES) continue;
        frames.push(item.sealed);
        size += item.size;
        queued -= item.size;
        items.shift();
        streams.delete(r);
        if (items.length) streams.set(r, items);
        progressed = true;
        if (frames.length === 64) return frames;
      }
      if (!progressed || !streams.size) return frames;
    }
  }
  /** posts carry a sequence number, so a relay that orders them lets several be in flight at once */
  function kick() {
    if (flushing) nudge?.();
    if (flushing || signal?.aborted) return;
    flushing = (async () => {
      try {
        await gather(0);
        const out = new Set();
        let failed = null;
        while ((streams.size || out.size) && !signal?.aborted) {
          while (streams.size && out.size < parallel() && !signal?.aborted) {
            const frames = batch(), at = seq++;
            const sending = Promise.resolve().then(() => post(frames, at))
              .then((ok) => { if (ok === false) clear(); if (drains.size && queued < STREAM_LOW) release(); }, (error) => { failed ??= error; })
              .finally(() => out.delete(sending));
            out.add(sending);
          }
          if (out.size) {
            // new frames while posts are out go in a free slot without waiting for one of them to come back
            const nudged = await new Promise((resolve) => { nudge = () => resolve(true); for (const sending of out) void sending.then(() => resolve(false)); });
            nudge = null;
            if (nudged) await gather(out.size);
          }
          if (failed) throw failed;
        }
      } catch (error) {
        clear();
        if (!signal?.aborted) onError(error);
      } finally {
        flushing = null;
        release();
      }
    })();
  }
  return {
    discard(r) {
      const items = streams.get(r);
      if (!items) return;
      for (const item of items) queued -= item.size;
      streams.delete(r);
      if (queued < STREAM_LOW) release();
    },
    push(sealed, r = "") {
      if (signal?.aborted) return;
      stream(r).push({ sealed, size: sealed.length });
      queued += sealed.length;
      kick();
    },
    /** false: stop reading this stream until `onDrain` calls back */
    bytes(r, chunk) {
      if (signal?.aborted) return true;
      const items = stream(r);
      const last = items[items.length - 1];
      if (last?.parts && last.size + chunk.length <= CHUNK) { last.parts.push(chunk); last.size += chunk.length; }
      else for (let at = 0; at < chunk.length; at += CHUNK) {
        const part = chunk.subarray(at, at + CHUNK);
        items.push({ parts: [part], size: part.length });
      }
      queued += chunk.length;
      kick();
      return queued < STREAM_HIGH;
    },
    onDrain(resume) { if (signal?.aborted || queued < STREAM_LOW) resume(); else drains.add(resume); },
    get size() { return queued; },
  };
}
/** hop-by-hop headers never cross the tunnel */
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded"]);

// ---- crypto shared with electron/vps-link-protocol.mjs (keep both in step; a test checks they interoperate) ----
export const sha256hex = (value) => createHash("sha256").update(value).digest("hex");
export const vpsTokenOf = (secret) => sha256hex(`omb-link-v1|vps|${secret}`);
export function x25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { pub: publicKey.export({ format: "jwk" }).x, priv: privateKey.export({ format: "jwk" }).d };
}
export function sealKeyOf(myPriv, myPub, theirPub, id) {
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: myPriv, x: myPub }, format: "jwk" });
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: theirPub }, format: "jwk" });
  return Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey, publicKey }), `omb-link-v1|${id}`, "seal", 32));
}
/** iv, ciphertext, tag: as bytes for the direct link, as base64url for the relay's json */
export function sealRaw(key, aad, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}
export const seal = (key, aad, plaintext) => sealRaw(key, aad, plaintext).toString("base64url");
export function open(key, aad, sealed) {
  const raw = typeof sealed === "string" ? Buffer.from(sealed, "base64url") : sealed;
  if (raw.length < 29) throw new Error("sealed value too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
}
/** frames carry their time and are refused twice or when stale, so a relay cannot replay an old request */
export function frameGuard(now = relayNow) {
  const seen = new Map();
  return (iv, ts) => {
    const t = now();
    if (typeof ts !== "number" || Math.abs(t - ts) > FRAME_SKEW_MS) return false;
    if (seen.has(iv)) return false;
    seen.set(iv, t);
    // oldest first, so a busy stream prunes a few entries per frame instead of walking them all
    for (const [key, at] of seen) { if (t - at <= 2 * FRAME_SKEW_MS) break; seen.delete(key); }
    return true;
  };
}
export function sealFrame(key, id, dir, frame, raw = false) {
  return (raw ? sealRaw : seal)(key, `${id}|${dir}`, Buffer.from(JSON.stringify({ ...frame, ts: relayNow() })));
}
/** a websocket's bytes travel raw, not as base64 in json: 0x01, the 12-letter stream id, the time, then the bytes */
export function sealBytes(key, id, dir, r, bytes, raw = false) {
  const head = Buffer.alloc(21);
  head[0] = 1;
  head.write(r, 1, 12, "latin1");
  head.writeDoubleBE(relayNow(), 13);
  return (raw ? sealRaw : seal)(key, `${id}|${dir}`, Buffer.concat([head, bytes]));
}
/**
 * `sealed` is base64url (relay) or bytes (direct); the guard keys on the iv either way. each end keeps one guard for
 * every path: on the vps the tunnel process serves the relay and every direct connection with the same one (only a
 * direct command that found no tunnel to hand its connection to keeps its own)
 */
export function openFrame(key, id, dir, sealed, guard) {
  const plain = open(key, `${id}|${dir}`, sealed);
  const value = plain[0] === 1 && plain.length >= 21
    ? { t: "bytes", r: plain.toString("latin1", 1, 13), ts: plain.readDoubleBE(13), b: plain.subarray(21) }
    : JSON.parse(plain.toString("utf8"));
  if (guard && !guard(typeof sealed === "string" ? sealed.slice(0, 16) : sealed.subarray(0, 12).toString("base64url"), value.ts)) return null;
  return value;
}
// ---- end shared crypto ----

// ---- relay transport shared with electron/vps-link-protocol.mjs ----
/** how long a streamed read may stay silent before this end decides a proxy holds the lines back and polls instead */
export const STREAM_STALL_MS = 5000;
const STREAM_OFF_MS = 10 * 60_000;
/**
 * a streamed read lasts 25 s (wait=25). the next one goes out this long into it, so it reaches the relay first and takes
 * over (the relay ends the older reader then): a frame never waits through a gap of a round trip between two reads
 */
const STREAM_AHEAD_MS = 21_000;
const WARM_MS = 40_000;

/**
 * fetch over node's own http(s) with its sockets kept open. the global fetch closes an idle socket after 4 s (undici's
 * default), so every reply after a pause paid a new tcp and tls handshake to the link service, and a cold tcp window.
 */
export function keepAliveFetch({ maxSockets = 8, tls = {}, proxy = null } = {}) {
  const agents = new Map();
  let lastUsed = 0;
  const agentFor = (protocol) => {
    let found = agents.get(protocol);
    if (!found) {
      agents.set(protocol, (found = new (protocol === "https:" ? HttpsAgent : HttpAgent)({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets, scheduling: "lifo", ...(protocol === "https:" ? tls : {}) })));
      // through the network's https proxy when it has one: tls inside the proxy's CONNECT tunnel
      if (proxy && protocol === "https:") {
        found.createConnection = (options, callback) => {
          Promise.resolve(proxy(new URL(`https://${options.host}:${options.port}`))).catch(() => null).then((via) => {
            if (!via) return tlsConnect(options);
            return throughProxy(via, options.host, options.port).then((raw) => tlsConnect({ ...options, socket: raw }));
          }).then((socket) => callback(null, socket), (error) => callback(error));
        };
      }
    }
    return found;
  };
  const go = (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(input);
    const { signal } = init;
    if (signal?.aborted) { reject(signal.reason); return; }
    lastUsed = Date.now();
    const body = init.body == null ? null : Buffer.from(init.body);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const stop = () => req.destroy(signal.reason);
    const req = send(url, { method: init.method ?? "GET", headers: { ...init.headers, ...(body ? { "content-length": body.length } : {}) }, agent: agentFor(url.protocol) }, (res) => {
      res.once("close", () => signal?.removeEventListener("abort", stop));
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
      noteRelayDate(headers.get("date"));
      const empty = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304 || init.method === "HEAD";
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    signal?.addEventListener("abort", stop, { once: true });
    req.once("error", (error) => { signal?.removeEventListener("abort", stop); reject(error); });
    // a new connection's handshake can take seconds (a vpn); `onConnected` says when the request is really on its way
    if (init.onConnected) req.once("socket", (socket) => { if (req.reusedSocket || !socket.connecting) init.onConnected(); else socket.once(url.protocol === "https:" ? "secureConnect" : "connect", init.onConnected); });
    req.end(body);
  });
  go.connectAware = true;
  /** a spare socket stays open: nginx closes one idle for 75 s, and the long poll holds the other */
  go.warm = (base, wanted = () => true) => {
    const timer = setInterval(() => {
      if (!wanted() || Date.now() - lastUsed < WARM_MS - 5000) return;
      void go(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.text()).catch(() => {});
    }, WARM_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };
  go.close = () => { for (const agent of agents.values()) agent.destroy(); agents.clear(); };
  /**
   * after a sleep or a network change: every socket may be dead, so the next requests open fresh ones. the agents stay
   * with their tls sessions, so those connections resume instead of a full handshake (no certificate flight: behind a
   * vpn that drops full-size packets a full handshake to the relay took 5.5 s and a resumed one 0.8 s)
   */
  go.reset = () => { for (const agent of agents.values()) agent.destroy(); };
  return go;
}

/**
 * a tcp connection to host:port through an http proxy's CONNECT (`proxy`: { host, port, auth? }), for networks that
 * allow nothing else; resolves once the proxy said 200, paused, for tls to take over
 */
export function throughProxy(proxy, host, port, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(Number(proxy.port), proxy.host);
    let got = Buffer.alloc(0);
    const done = (error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", done);
      socket.off("close", closed);
      if (error) { socket.destroy(); reject(error); return; }
      socket.pause();
      resolve(socket);
    };
    const timer = setTimeout(() => done(Object.assign(new Error("the proxy did not answer"), { code: "ETIMEDOUT" })), timeoutMs);
    const closed = () => done(new Error("the proxy closed the connection"));
    const onData = (chunk) => {
      got = Buffer.concat([got, chunk]);
      const end = got.indexOf("\r\n\r\n");
      if (end < 0) { if (got.length > 16_384) done(new Error("the proxy's answer was too long")); return; }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(got.toString("latin1", 0, end))?.[1];
      if (status !== "200") { done(new Error(`the proxy answered ${status ?? "something else"}`)); return; }
      const rest = got.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      done(null);
    };
    socket.on("data", onData);
    socket.once("error", done);
    socket.once("close", closed);
    const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString("base64")}\r\n` : "";
    socket.once("connect", () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`));
  });
}

/**
 * resolves the socket once it is connected; rejects (and destroys it) on an error, a close or `timeoutMs` without one.
 * node 24.22 (electron 43) and 26.7: tls.connect({ socket }) over a socket still resolving or trying addresses
 * (autoSelectFamily, on by default) stays on the first attempt's handle, and the process segfaults in TLSWrap::EncOut
 * when a later address connects. tls goes on a dialled socket only once it is connected.
 */
export function connectedSocket(socket, { timeoutMs }) {
  if (socket.destroyed) return Promise.reject(Object.assign(new Error("the connection closed before it opened"), { code: "ECONNRESET" }));
  if (!socket.connecting) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      socket.off("connect", opened);
      socket.off("error", done);
      socket.off("close", closed);
      if (!error) { resolve(socket); return; }
      socket.destroy();
      reject(error);
    };
    const opened = () => done(null);
    const closed = () => done(Object.assign(new Error("the connection closed before it opened"), { code: "ECONNRESET" }));
    const timer = setTimeout(() => done(Object.assign(new Error("the connection did not open in time"), { code: "ETIMEDOUT" })), timeoutMs);
    timer.unref?.();
    socket.once("connect", opened);
    socket.once("error", done);
    socket.once("close", closed);
  });
}

/** an http/2 stream's own window and the connection's: a whole desktop frame or download in flight at a long round trip */
const H2_STREAM_WINDOW = 4 * 1024 * 1024;
const H2_SESSION_WINDOW = 8 * 1024 * 1024;
/** a request that never reached the relay: the connection was closing (goaway), gone, or refused the stream */
const H2_UNSENT = new Set(["ERR_HTTP2_GOAWAY_SESSION", "ERR_HTTP2_INVALID_SESSION", "ERR_HTTP2_REFUSED_STREAM"]);
/** posts out at once over http/2: as many as the relay holds while an earlier one is still on its way (HELD_POSTS) */
const H2_POSTS_IN_FLIGHT = 8;
const H2_DIAL_MS = 20_000;
/**
 * a request with no answer this long has its connection prove itself with a ping, and one that does not answer the ping
 * in H2_PING_MS is dropped so the next request dials afresh. a connection can die without a word (a phone hotspot or
 * vpn that changed under it): the app sat 20 minutes on one with every post and read timing out (2026-11-08)
 */
const H2_CHECK_MS = 10_000;
const H2_PING_MS = 10_000;
const until = (promise, signal) => (!signal ? promise : new Promise((resolve, reject) => {
  const stop = () => reject(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  promise.then((value) => { signal.removeEventListener("abort", stop); resolve(value); }, (error) => { signal.removeEventListener("abort", stop); reject(error); });
}));

/**
 * keepAliveFetch's api over one http/2 connection when the relay offers h2 (nginx does): the streamed read and every
 * post share one warm tls connection, so a post never waits on a new handshake (5.5 s behind a lossy vpn, 0.3 s from a
 * vps) and many can be out at once (`multiplexed()`). plain http, or an origin that answers without h2, goes through
 * keepAliveFetch. `tls` is extra tls.connect options (a test's ca); `dial(host, port)` makes the tcp socket under it.
 */
export function relayFetch({ tls: tlsOptions = {}, maxSockets = 8, dial = null, checkMs = H2_CHECK_MS, pingMs = H2_PING_MS, proxy = null } = {}) {
  const h1 = keepAliveFetch({ maxSockets, tls: tlsOptions, proxy });
  const h1Origins = new Set();
  let session = null, opening = null, tlsSession = null, lastUsed = 0, checking = null;
  // the one h2 connection belongs to one origin: the one warmed (a link service node). other origins (asking another
  // node where a tunnel lives) take http/1.1, and warming a different origin (the tunnel moved) replaces the connection
  let sessionOrigin = null, homeOrigin = null;
  const live = (one) => Boolean(one && !one.closed && !one.destroyed);
  /** a ping answered keeps the connection; none in time drops it, failing what is on it so the callers ask again */
  const check = (one) => {
    if (checking === one || !live(one)) return;
    checking = one;
    const dead = () => { if (checking === one) checking = null; if (session === one) session = null; one.destroy(); };
    const timer = setTimeout(dead, pingMs);
    timer.unref?.();
    try { one.ping((error) => { clearTimeout(timer); if (checking === one) checking = null; if (error && live(one)) dead(); }); }
    catch { clearTimeout(timer); dead(); }
  };
  const open = async (url) => {
    // an ipv6 literal comes in brackets from URL; tls wants the bare address (and no server name for it)
    const host = url.hostname.replace(/^\[|\]$/g, ""), port = Number(url.port) || 443;
    const via = proxy ? await Promise.resolve(proxy(url)).catch(() => null) : null;
    if (via) return throughProxy(via, host, port).then((raw) => secure(url, host, port, raw), () => null);
    if (!dial) return secure(url, host, port, undefined);
    return connectedSocket(dial(host, port), { timeoutMs: H2_DIAL_MS }).then((raw) => secure(url, host, port, raw), () => null);
  };
  const secure = (url, host, port, raw) => new Promise((resolve) => {
    const socket = tlsConnect({ host, port, ...(raw ? { socket: raw } : {}), ...(isIP(host) ? {} : { servername: host }), ALPNProtocols: ["h2", "http/1.1"], ...(tlsSession ? { session: tlsSession } : {}), ...tlsOptions });
    socket.on("session", (value) => { tlsSession = value; });
    const failed = () => { socket.destroy(); resolve(null); };
    socket.once("error", failed);
    socket.setTimeout(H2_DIAL_MS, failed);
    socket.once("secureConnect", () => {
      socket.off("error", failed);
      socket.setTimeout(0);
      socket.setNoDelay(true);
      if (socket.alpnProtocol !== "h2") { h1Origins.add(url.origin); socket.destroy(); resolve(null); return; }
      const next = http2Connect(url.origin, { createConnection: () => socket, settings: { initialWindowSize: H2_STREAM_WINDOW } });
      // a server that never sends its settings would hold every request waiting for this connection
      const settle = setTimeout(() => { next.destroy(); resolve(null); }, H2_DIAL_MS);
      next.on("error", () => {});
      next.on("goaway", () => { if (session === next) session = null; });
      next.on("close", () => { clearTimeout(settle); if (session === next) session = null; resolve(null); });
      next.once("connect", () => { clearTimeout(settle); next.setLocalWindowSize(H2_SESSION_WINDOW); resolve(next); });
    });
  });
  async function sessionFor(url) {
    if (live(session)) return session;
    opening ??= open(url).then((next) => { if (next) { session = next; sessionOrigin = url.origin; } return next; }).finally(() => { opening = null; });
    return opening;
  }
  const request = (one, url, init) => new Promise((resolve, reject) => {
    const { signal } = init;
    const body = init.body == null ? null : Buffer.from(init.body);
    const headers = { ":method": init.method ?? "GET", ":path": `${url.pathname}${url.search}` };
    for (const [name, value] of Object.entries(init.headers ?? {})) headers[name.toLowerCase()] = value;
    if (body) headers["content-length"] = body.length;
    let stream;
    try { stream = one.request(headers, { endStream: !body }); } catch (error) { reject(error); return; }
    let answered = false;
    // a body that could not even be sent in that time: the connection's flow window is held (a proxy that answered
    // without reading an earlier body), and a ping would still pass, so the connection goes
    const quiet = setTimeout(() => {
      if (answered) return;
      if (body && !stream.writableFinished && one.state?.remoteWindowSize === 0) { if (session === one) session = null; one.destroy(); return; }
      check(one);
    }, checkMs);
    quiet.unref?.();
    const stop = () => { stream.close(h2Constants.NGHTTP2_CANCEL); if (!answered) reject(signal.reason); };
    signal?.addEventListener("abort", stop, { once: true });
    const unanswered = (error) => {
      if (answered) return;
      answered = true;
      reject(stream.rstCode === h2Constants.NGHTTP2_REFUSED_STREAM ? Object.assign(new Error("the relay refused the stream"), { code: "ERR_HTTP2_REFUSED_STREAM" }) : error ?? new Error("the relay closed the stream"));
    };
    stream.once("error", unanswered);
    stream.once("close", () => { clearTimeout(quiet); signal?.removeEventListener("abort", stop); unanswered(null); });
    stream.once("response", (head) => {
      clearTimeout(quiet);
      if (answered) return;
      answered = true;
      const status = head[":status"];
      const out = new Headers();
      for (const [name, value] of Object.entries(head)) if (!name.startsWith(":")) for (const each of Array.isArray(value) ? value : [value]) out.append(name, String(each));
      noteRelayDate(out.get("date"));
      const empty = status === 204 || status === 205 || status === 304 || init.method === "HEAD";
      if (empty) stream.resume();
      resolve(new Response(empty ? null : Readable.toWeb(stream), { status, headers: out }));
    });
    if (body) stream.end(body);
  });
  const go = async (input, init = {}) => {
    const url = new URL(input);
    if (init.signal?.aborted) throw init.signal.reason;
    if (url.protocol !== "https:" || h1Origins.has(url.origin) || (homeOrigin && url.origin !== homeOrigin) || (live(session) && sessionOrigin !== url.origin)) return h1(input, init);
    lastUsed = Date.now();
    // a connection the relay is closing (goaway) or that died refuses a request unprocessed: once more on a fresh one
    for (let attempt = 0; ; attempt += 1) {
      const one = await until(sessionFor(url), init.signal);
      if (!one || sessionOrigin !== url.origin) return h1(input, init);
      init.onConnected?.();
      try { return await request(one, url, init); }
      catch (error) {
        if (attempt > 0 || init.signal?.aborted || !H2_UNSENT.has(error?.code)) throw error;
        if (session === one) { session = null; one.destroy(); }
      }
    }
  };
  go.connectAware = true;
  /** posts may share the connection with each other and the streamed read */
  go.multiplexed = () => live(session);
  go.postsInFlight = () => (live(session) ? H2_POSTS_IN_FLIGHT : POSTS_IN_FLIGHT);
  go.warm = (base) => {
    const origin = new URL(base).origin;
    if (homeOrigin !== origin) { homeOrigin = origin; if (session && sessionOrigin !== origin) { session.destroy(); session = null; } }
    const stopH1 = h1.warm(base, () => h1Origins.has(new URL(base).origin) || !base.startsWith("https:"));
    // nginx closes an h2 connection idle for its keepalive timeout; the streamed read usually keeps it busy anyway
    const timer = setInterval(() => { if (live(session) && Date.now() - lastUsed >= WARM_MS - 5000) check(session); }, WARM_MS);
    timer.unref?.();
    return () => { stopH1(); clearInterval(timer); };
  };
  go.close = () => { session?.close(); session = null; h1.close(); };
  /** after a sleep or a network change: a fresh connection, resuming the tls session */
  go.reset = () => { session?.destroy(); session = null; h1.reset(); };
  return go;
}

/**
 * a relay read: one json document, or, from a relay that streams (`stream=1`), one {"frames":[...]} per line as frames
 * arrive, so a reply never waits for the next poll to reach the relay. true when the answer streamed.
 */
export async function readFrameBatches(response, onFrames) {
  if (!/^application\/x-ndjson\b/i.test(response.headers.get("content-type") ?? "")) {
    const { frames = [] } = await response.json();
    onFrames(frames);
    return false;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", from = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    for (let at = text.indexOf("\n", from); at >= 0; at = text.indexOf("\n")) {
      const line = text.slice(0, at);
      text = text.slice(at + 1);
      if (line) onFrames(JSON.parse(line).frames ?? []);
    }
    from = text.length;
  }
  return true;
}

/**
 * a streamed read from a node that says it beats (x-link-beat, seconds) and then says nothing for two beats and a bit is
 * on a dead connection: `silent` rejects and `lost()` runs (drop the connection). a node without the header is never
 * judged
 */
export function beatWatch(response, lost) {
  const beatMs = Number(response.headers?.get?.("x-link-beat")) * 1000;
  let last = Date.now(), timer = null;
  const silent = new Promise((_resolve, reject) => {
    if (!(beatMs > 0)) return;
    timer = setInterval(() => { if (Date.now() - last > beatMs * 2 + 3000) { clearInterval(timer); lost(); reject(new Error("the streamed read went silent")); } }, Math.min(1000, beatMs));
    timer.unref?.();
  });
  silent.catch(() => {});
  return { silent, heard: () => { last = Date.now(); }, stop: () => clearInterval(timer) };
}

/** when to ask for a streamed read: always, except for a while after a proxy was seen holding the lines back */
export function streamChoice(now = Date.now) {
  let offUntil = 0;
  return { wanted: () => now() >= offUntil, stalled: () => { offUntil = now() + STREAM_OFF_MS; } };
}
// ---- end relay transport ----

// ---- direct transport shared with electron/vps-link-direct.mjs (keep both in step; a test checks they interoperate) ----
/** each end writes this first; a login shell's greeting before it is skipped */
export const DIRECT_MAGIC = Buffer.from("\0OMBD1\n", "latin1");
export const REC_SEALED = 1;
export const REC_ACK = 2;
/** a stream's bytes go out in pieces this size, taking turns with the other streams */
const DIRECT_PIECE = 16 * 1024;
/**
 * stream bytes sent and not yet acknowledged: what the path delivers in its round trip plus DIRECT_QUEUE_MS, measured
 * from the acks, so a transfer fills the path and an api frame still waits at most about that long behind it
 */
export const DIRECT_INFLIGHT = 384 * 1024;
const DIRECT_INFLIGHT_MIN = 384 * 1024;
const DIRECT_INFLIGHT_MAX = 8 * 1024 * 1024;
const DIRECT_QUEUE_MS = 250;
const DIRECT_ACK_EVERY = 32 * 1024;
const DIRECT_MAX_RECORD = 1024 * 1024;
const DIRECT_HIGH = 2 * 1024 * 1024;
const DIRECT_LOW = 512 * 1024;
/**
 * a lane's streams (egress: a bot's tls handshakes and pages) have their own allowance of unacknowledged bytes and go
 * first in each round, so a full desktop window never holds a page's first bytes back for an ack
 */
const DIRECT_LANE_INFLIGHT = 256 * 1024;

export function directRecord(type, payload) {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}

/** records out of a byte stream: [u32 length][type][payload]. throws on anything malformed */
export function directReader(onRecord) {
  let buf = Buffer.alloc(0), synced = false;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!synced) {
      const at = buf.indexOf(DIRECT_MAGIC);
      if (at < 0) {
        if (buf.length > 64 * 1024) throw new Error("no direct link here");
        return;
      }
      buf = buf.subarray(at + DIRECT_MAGIC.length);
      synced = true;
    }
    while (buf.length >= 5) {
      const length = buf.readUInt32BE(0);
      if (length < 1 || length > DIRECT_MAX_RECORD) throw new Error("malformed record");
      if (buf.length < 4 + length) break;
      const type = buf[4], payload = buf.subarray(5, 4 + length);
      buf = buf.subarray(4 + length);
      onRecord(type, payload);
    }
  };
}

/**
 * the sending half of a direct link. a frame for a stream with bytes still queued waits behind them (its order is kept);
 * every other frame goes first. queued bytes take turns, a piece per stream, with at most DIRECT_INFLIGHT unacknowledged,
 * so a busy desktop or a download never holds an api call back for long. `bytes(r, chunk, true)` puts a stream in the
 * lane (DIRECT_LANE_INFLIGHT).
 */
export function createDirectWriter({ sealFrame: sealOne, sealBytes: sealPiece, write, inflight: fixed = null, now = () => performance.now() }) {
  const urgent = [];
  // the path, from the acks: the smallest round trip lately and the best delivery rate lately
  const sent = [];
  let sentTotal = 0, ackedTotal = 0, minRtt = null, minAt = 0, rateFrom = null, rates = [];
  let inflight = fixed ?? DIRECT_INFLIGHT;
  function learn(count) {
    const t = now();
    ackedTotal += count;
    let at = null;
    while (sent.length && sent[0].end <= ackedTotal) at = sent.shift().at;
    if (at !== null) {
      const sample = t - at;
      if (minRtt === null || sample <= minRtt || t - minAt > 10_000) { minRtt = sample; minAt = t; }
    }
    if (rateFrom === null) rateFrom = { t, bytes: ackedTotal - count };
    // acks arrive in bunches: rates over a couple of round trips, averaged, and the window grows by half at most per step
    if (minRtt !== null && t - rateFrom.t >= Math.max(2 * minRtt, 300)) {
      rates = [...rates.slice(-3), ((ackedTotal - rateFrom.bytes) * 1000) / (t - rateFrom.t)];
      rateFrom = { t, bytes: ackedTotal };
      const rate = rates.reduce((sum, one) => sum + one, 0) / rates.length;
      if (fixed === null) inflight = Math.min(DIRECT_INFLIGHT_MAX, inflight * 1.5, Math.max(DIRECT_INFLIGHT_MIN, (rate * (minRtt + DIRECT_QUEUE_MS)) / 1000));
    }
  }
  const streams = new Map();
  const drains = new Set();
  // what is unacknowledged, oldest first, by lane: the other end acks bytes in the order they left
  const flight = [];
  let queued = 0, unacked = 0, laneUnacked = 0, received = 0, blocked = false, closed = false, scheduled = false;
  const release = () => { const waiting = [...drains]; drains.clear(); for (const resume of waiting) resume(); };
  function piece(r, items) {
    const item = items[0];
    let need = Math.min(DIRECT_PIECE, item.size);
    const pieces = [];
    while (need > 0) {
      const part = item.parts[0];
      if (part.length <= need) { pieces.push(part); item.parts.shift(); need -= part.length; }
      else { pieces.push(part.subarray(0, need)); item.parts[0] = part.subarray(need); need = 0; }
    }
    const one = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    item.size -= one.length;
    queued -= one.length;
    if (items.lane) laneUnacked += one.length; else unacked += one.length;
    const last = flight[flight.length - 1];
    if (last && last.lane === Boolean(items.lane)) last.size += one.length; else flight.push({ lane: Boolean(items.lane), size: one.length });
    sentTotal += one.length;
    sent.push({ end: sentTotal, at: now() });
    if (sent.length > 4096) sent.shift();
    if (!item.size) items.shift();
    streams.delete(r);
    if (items.length) streams.set(r, items);
    return directRecord(REC_SEALED, sealPiece(r, one));
  }
  function next() {
    if (urgent.length) return urgent.shift();
    for (const lane of [true, false]) {
      for (const [r, items] of streams) {
        if (Boolean(items.lane) !== lane) continue;
        const item = items[0];
        if (!item.record) {
          if (lane ? laneUnacked >= DIRECT_LANE_INFLIGHT : unacked >= inflight) continue;
          return piece(r, items);
        }
        // a frame that waited behind its stream's bytes; the stream goes to the back of the line
        items.shift();
        streams.delete(r);
        if (items.length) streams.set(r, items);
        return item.record;
      }
    }
    return null;
  }
  /**
   * what is ready goes out as one write, a turn after the first of it: sshd does not set nodelay for a session without a
   * pty, so a reply's head, bytes and end written apart would each wait for an ack (a round trip, or a delayed ack)
   */
  function pump() {
    scheduled = false;
    const out = [];
    let size = 0;
    while (!blocked && !closed) {
      const record = next();
      if (!record) break;
      out.push(record);
      size += record.length;
      if (size >= 256 * 1024) { if (write(out.length === 1 ? out[0] : Buffer.concat(out)) === false) blocked = true; out.length = 0; size = 0; }
    }
    if (out.length && !closed && write(out.length === 1 ? out[0] : Buffer.concat(out)) === false) blocked = true;
    if (drains.size && queued < DIRECT_LOW) release();
  }
  const kick = () => { if (!scheduled && !closed) { scheduled = true; setImmediate(pump); } };
  return {
    push(frame) {
      if (closed) return;
      const record = directRecord(REC_SEALED, sealOne(frame));
      const items = frame.r ? streams.get(frame.r) : undefined;
      if (items) items.push({ record }); else urgent.push(record);
      kick();
    },
    /** false: stop reading this stream until `onDrain` calls back */
    bytes(r, chunk, lane = false) {
      if (closed) return true;
      let items = streams.get(r);
      if (!items) { streams.set(r, (items = [])); items.lane = lane; }
      const last = items[items.length - 1];
      if (last && !last.record) { last.parts.push(chunk); last.size += chunk.length; }
      else items.push({ parts: [chunk], size: chunk.length });
      queued += chunk.length;
      kick();
      return queued < DIRECT_HIGH;
    },
    onDrain(resume) { if (closed || queued < DIRECT_LOW) resume(); else drains.add(resume); },
    discard(r) {
      const items = streams.get(r);
      if (!items) return;
      for (const item of items) if (!item.record) queued -= item.size;
      streams.delete(r);
      if (queued < DIRECT_LOW) release();
    },
    /** the other end got this many stream bytes */
    acked(count) {
      for (let left = count; left > 0 && flight.length;) {
        const head = flight[0], used = Math.min(left, head.size);
        head.size -= used;
        left -= used;
        if (head.lane) laneUnacked -= used; else unacked -= used;
        if (!head.size) flight.shift();
      }
      learn(count);
      kick();
    },
    /** stream bytes that arrived here: acknowledged every so often, ahead of everything else */
    received(count) {
      received += count;
      if (received < DIRECT_ACK_EVERY || closed) return;
      const payload = Buffer.alloc(4);
      payload.writeUInt32BE(received, 0);
      received = 0;
      urgent.unshift(directRecord(REC_ACK, payload));
      kick();
    },
    drained() { blocked = false; kick(); },
    close() { closed = true; urgent.length = 0; streams.clear(); queued = 0; release(); },
    get size() { return queued; },
    get unacked() { return unacked + laneUnacked; },
    get inflight() { return inflight; },
  };
}

/** the direct path over https: one websocket (rfc 6455) of binary messages that carry the same byte stream as ssh */
export const WS_PATH = "/omb-direct";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_FRAME = 4 * 1024 * 1024;
export const wsAccept = (key) => createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");

/** one websocket frame; the client masks what it sends (the rfc requires it), the server never does */
export function wsFrame(opcode, payload, masked) {
  const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  head[0] = 0x80 | opcode;
  head[1] = (masked ? 0x80 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) head.writeUInt16BE(length, 2);
  else if (extra === 8) head.writeBigUInt64BE(BigInt(length), 2);
  if (!masked) return Buffer.concat([head, payload]);
  const mask = randomBytes(4);
  mask.copy(head, 2 + extra);
  const body = Buffer.allocUnsafe(length);
  for (let at = 0; at < length; at += 1) body[at] = payload[at] ^ mask[at & 3];
  return Buffer.concat([head, body]);
}

/** frames out of a byte stream: data to `onData`, pings answered by the caller, a close ends it. text only with `onText`; throws on anything else */
export function wsReader({ masked, onData, onPing = () => {}, onClose = () => {}, onText = null }) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f, hasMask = (buf[1] & 0x80) !== 0;
      if (hasMask !== masked) throw new Error("websocket masking is wrong");
      let length = buf[1] & 0x7f, at = 2;
      if (length === 126) { if (buf.length < 4) return; length = buf.readUInt16BE(2); at = 4; }
      else if (length === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(WS_MAX_FRAME)) throw new Error("websocket frame too large");
        length = Number(big);
        at = 10;
      }
      if (length > WS_MAX_FRAME) throw new Error("websocket frame too large");
      const start = at + (hasMask ? 4 : 0), end = start + length;
      if (buf.length < end) return;
      let payload = buf.subarray(start, end);
      if (hasMask) {
        const mask = buf.subarray(at, start), open = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i += 1) open[i] = payload[i] ^ mask[i & 3];
        payload = open;
      }
      buf = buf.subarray(end);
      if (opcode === 0 || opcode === 2) { if (payload.length) onData(payload); }
      else if (opcode === 8) { onClose(); return; }
      else if (opcode === 9) onPing(payload);
      else if (opcode === 1 && onText) onText(payload.toString("utf8"));
      else if (opcode !== 10) throw new Error("not a binary websocket");
    }
  };
}

/**
 * a websocket over `socket` as a plain duplex byte stream; `head` is what arrived after the handshake. `heartbeatMs`
 * sends the text "ping" that often (the cloud relay answers "pong" without waking) and ends a socket silent for 3 beats
 */
export function wsDuplex(socket, { client, head = null, onText = null, heartbeatMs = 0 }) {
  let ended = false, heardAt = Date.now();
  const duplex = new Duplex({
    writableHighWaterMark: 1024 * 1024,
    write(chunk, _encoding, callback) { if (socket.destroyed) callback(new Error("closed")); else socket.write(wsFrame(2, chunk, client), callback); },
    final(callback) { if (!socket.destroyed) socket.end(wsFrame(8, Buffer.alloc(0), client)); callback(); },
    read() { socket.resume(); },
    destroy(error, callback) { socket.destroy(); callback(error); },
  });
  const finish = () => { if (!ended) { ended = true; duplex.push(null); } };
  const read = wsReader({
    masked: !client,
    onData: (data) => { if (!ended && !duplex.push(data)) socket.pause(); },
    onPing: (data) => { if (!socket.destroyed) socket.write(wsFrame(10, data, client)); },
    onClose: () => { finish(); socket.end(); },
    onText: onText ?? (heartbeatMs ? () => {} : null),
  });
  const take = (chunk) => { heardAt = Date.now(); try { read(chunk); } catch (error) { duplex.destroy(error); } };
  const beat = heartbeatMs ? setInterval(() => {
    if (Date.now() - heardAt > heartbeatMs * 3) { socket.destroy(); return; }
    if (!socket.destroyed) socket.write(wsFrame(1, Buffer.from("ping"), client));
  }, heartbeatMs) : null;
  beat?.unref?.();
  socket.on("data", take);
  socket.once("end", finish);
  socket.once("close", () => { clearInterval(beat); finish(); duplex.destroy(); });
  socket.on("error", (error) => duplex.destroy(error));
  if (head?.length) take(head);
  return duplex;
}
// ---- end direct transport ----

/** an install from before the rename keeps its folder until the installer runs again and moves it */
const configDir = () => {
  const next = join(homedir(), ".config", "duskbot-link"), old = join(homedir(), ".config", OLD_CONFIG);
  return !existsSync(next) && existsSync(old) ? old : next;
};
const tunnelFile = () => join(configDir(), "tunnel.json");
// on an install where this agent has its own account, its unit names a hand-off folder for these two: a root unit takes
// them from there to the server (the token into its environment, the sign-in into its engine home)
const enginesFile = () => process.env.DUSK_LINK_ENGINES_FILE || join(homedir(), ".config", "duskbot", "engines.env");
const codexAuthFile = () => process.env.DUSK_LINK_CODEX_AUTH_FILE || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");

function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function relay(base, route, token, init = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${base}${route}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        signal: init.signal ?? AbortSignal.timeout(40_000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status >= 500 && attempt < 3) throw new Error(`link service answered ${response.status}`);
      return { status: response.status, body };
    } catch (error) {
      if (init.signal?.aborted || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/** this server's own api; a server from before the rename knows only the old header and well-known names */
async function local(method, path, body) {
  const first = await localOnce(method, path, body);
  return first.status === 404 && toLegacyPath(path) !== path ? localOnce(method, toLegacyPath(path), body) : first;
}

function localOnce(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest({ ...SERVER, method, path, headers: withLegacyHeaders({ accept: "application/json", "x-dusk-cli": "1", ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}) }), timeout: 15_000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("timeout", () => req.destroy(new Error("The Metal server here did not answer")));
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

/**
 * the leaf certificate's public key as the app pins it: sha256 of the spki der, base64. node's `cert.pubkey` is not that
 * (for an ec key it is the bare point), so the der comes from the certificate itself
 */
export function spkiOf(host, port = 443, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: true, timeout: 10_000, ...tlsOptions }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.raw) return reject(new Error("no certificate"));
      resolve(createHash("sha256").update(new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" })).digest("base64"));
    });
    socket.on("timeout", () => socket.destroy(new Error("timed out")));
    socket.on("error", reject);
  });
}

const ADDRESS_HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const ADDRESS_VIAS = new Set(["relay", "ssh", "direct", "domain", "tailscale", "cloudflare"]);
export const addressFile = () => process.env.DUSK_LINK_ADDRESS_FILE || "/etc/duskbot-address.json";

/** a quick tunnel's current name, from cloudflared's own metrics on this machine */
export async function quickTunnelHost(url, fetchImpl = fetch) {
  const at = new URL(url);
  if (at.hostname !== "127.0.0.1" || at.protocol !== "http:") return null;
  const answer = await fetchImpl(at, { signal: AbortSignal.timeout(3_000) });
  const host = answer.ok ? (await answer.json())?.hostname : null;
  return typeof host === "string" && /^[a-z0-9-]+\.trycloudflare\.com$/.test(host) ? host : null;
}

/**
 * where the app reaches this server, as install.sh set it up ($ADDRESS there): the relay, or an https address, with the
 * certificate's key the app pins when this server's own Caddy holds it. null when unknown or unreadable, so the app
 * keeps what it has; a pinned address whose key cannot be read now is unknown too, never sent without its pin
 */
export async function currentAddress({ read = () => readFileSync(addressFile(), "utf8"), quick = quickTunnelHost, spki = spkiOf } = {}) {
  let saved;
  try { saved = JSON.parse(read()); } catch { return null; }
  if (saved?.v !== 1 || !ADDRESS_VIAS.has(saved.via)) return null;
  if (saved.mode !== "direct") return saved.mode === "relay" ? { mode: "relay", via: saved.via, origin: null, spki: null } : null;
  let host = saved.host;
  if (typeof saved.quick === "string") host = (await quick(saved.quick).catch(() => null)) ?? host;
  if (typeof host !== "string" || !ADDRESS_HOST.test(host)) return null;
  let key = null;
  if (saved.pin === true) { key = await spki(host).catch(() => null); if (!key) return null; }
  return { mode: "direct", via: saved.via, origin: `https://${host}`, spki: key };
}

async function probe() {
  const base = env("LINK_BASE"), id = env("LINK_ID"), token = env("LINK_TOKEN");
  const nonce = randomBytes(16).toString("hex");
  let server = null;
  try {
    server = await new Promise((resolve, reject) => {
      const listening = createServer((req, res) => {
        if (req.url === `/.well-known/omb-link/${nonce}`) { res.writeHead(200, { "content-type": "text/plain" }); res.end(nonce); }
        else { res.writeHead(404); res.end(); }
      });
      listening.once("error", reject);
      listening.listen(80, "0.0.0.0", () => resolve(listening));
    });
  } catch (error) {
    console.error(`port 80 is busy here (${error.code ?? error.message}), so the app will reach this server through the link service`);
  }
  const answer = await relay(base, `/v1/sessions/${id}/probe`, token, { method: "POST", body: JSON.stringify({ nonce }) });
  server?.close();
  if (answer.body?.ip) console.log(`ip=${answer.body.ip}`);
  return server && answer.status === 200 && answer.body?.reachable === true ? 0 : 3;
}

async function link() {
  const base = env("LINK_BASE"), id = env("LINK_ID"), token = env("LINK_TOKEN");
  const mode = process.env.LINK_MODE === "direct" ? "direct" : "relay";
  const name = (process.env.LINK_NAME || hostname()).slice(0, 60);
  let saved = null;
  try { saved = JSON.parse(readFileSync(tunnelFile(), "utf8")); } catch { /* not linked yet */ }
  const claimed = await relay(base, `/v1/sessions/${id}/claim`, token, { method: "POST", body: JSON.stringify({}) });
  if (claimed.status === 410 && saved?.id) return 4;
  if (claimed.status !== 200) throw new Error(claimed.body?.error ?? `the link service answered ${claimed.status}`);
  const appPub = claimed.body.appPub;
  const [pairing, environment] = await Promise.all([
    local("POST", "/api/auth/pairing", { label: claimed.body.label || "Metal app" }),
    local("GET", "/.well-known/duskbot/environment"),
  ]);
  if (pairing.status !== 200 || typeof pairing.body?.code !== "string") throw new Error(`The Metal server here would not make a pairing code (${pairing.status})`);
  const via = ADDRESS_VIAS.has(process.env.LINK_VIA ?? "") ? process.env.LINK_VIA : mode;
  const origin = mode === "direct" ? `https://${env("LINK_HOST")}` : null;
  // tailscale and cloudflare hold their own certificates and change their keys, so those addresses go unpinned
  const spki = mode === "direct" && process.env.LINK_PIN !== "0" ? await spkiOf(env("LINK_HOST")) : null;
  const tunnel = { key: randomBytes(32).toString("base64url"), vps: randomBytes(32).toString("base64url"), app: randomBytes(32).toString("base64url") };
  const mine = x25519Pair();
  const payload = {
    v: 1, mode, via, origin, spki, name,
    environmentId: typeof environment.body?.environmentId === "string" ? environment.body.environmentId : null,
    // the server's long-term identity, which signs each key the app seals secrets for: the app pins it from here
    sealIdentity: typeof environment.body?.sealIdentity === "string" ? environment.body.sealIdentity : null,
    pairing: { code: pairing.body.code, expiresAt: pairing.body.expiresAt ?? null },
    tunnel: { id, key: tunnel.key, token: tunnel.app },
  };
  const sealed = seal(sealKeyOf(mine.priv, mine.pub, appPub, id), id, Buffer.from(JSON.stringify(payload)));
  // tunnels this server held before stay listed until the new one is confirmed, so an interrupted link still retires them
  const before = [saved, ...(Array.isArray(saved?.before) ? saved.before : [])]
    .filter((one) => one?.id && one.id !== id && typeof one.token === "string").map(({ id: oldId, base: oldBase, token: oldToken }) => ({ id: oldId, base: oldBase, token: oldToken })).slice(0, 4);
  const record = { v: 1, base, id, key: tunnel.key, token: tunnel.vps, mode, origin };
  writePrivate(tunnelFile(), JSON.stringify(before.length ? { ...record, before } : record));
  const result = await relay(base, `/v1/sessions/${id}/result`, token, {
    method: "POST", body: JSON.stringify({ sealed, vpsPub: mine.pub, tunnel: { vps: sha256hex(tunnel.vps), app: sha256hex(tunnel.app) } }),
  });
  if (result.status !== 200) throw new Error(result.body?.error ?? `the link service answered ${result.status}`);
  if (before.length) {
    for (const one of before) await retireTunnel(one);
    writePrivate(tunnelFile(), JSON.stringify(record));
  }
  return 0;
}

/**
 * a server linked again (a new app, a second mac, a reinstalled app) has one tunnel: the one it replaced is ended at the
 * service, so the app that held it reads "unlinked" instead of waiting on a tunnel nobody serves, and that app's direct
 * key stops opening this agent
 */
export async function retireTunnel(saved, { removeKey = setDirectKey } = {}) {
  if (typeof saved?.token === "string" && /^[a-z2-7]{10}$/.test(saved.id ?? "") && typeof saved.base === "string") {
    try {
      const answer = await relay(saved.base, `/v1/tunnels/${saved.id}`, saved.token, { method: "DELETE" });
      if (answer.status !== 200 && answer.status !== 404) console.error(`the tunnel this server had before was not ended (${answer.status})`);
    } catch (error) {
      console.error(`the tunnel this server had before was not ended (${error?.message ?? error})`);
    }
  }
  try { removeKey(saved.id, null); } catch (error) { console.error(`the direct key of the tunnel before was not removed (${error?.message ?? error})`); }
}

// ---- tunnel ----

function setEnvLine(text, key, value) {
  const lines = text.split("\n").filter((line) => line && !line.startsWith(`${key}=`));
  if (value !== null) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

/** what the app may ask of this agent directly, never of the server: credentials it signed in for on the mac */
// ---- the direct link: the app's own ssh key, which may only start `agent.mjs direct` ----
const authorizedKeysFile = () => join(homedir(), ".ssh", "authorized_keys");
const directTag = (id) => `omb-link-${id}`;
const SAFE_PATH = /^\/[\w./+-]+$/;

/** the authorized_keys line for the app's key: restrict (no shell, pty, agent or port forwarding) and one forced command */
export function directKeyLine({ pub, id, node = process.execPath, agent = installedAgent() }) {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]{68})$/.exec(typeof pub === "string" ? pub.trim() : "");
  const blob = match ? Buffer.from(match[1], "base64") : null;
  if (!blob || blob.length !== 51 || blob.readUInt32BE(0) !== 11 || blob.toString("latin1", 4, 15) !== "ssh-ed25519" || blob.readUInt32BE(15) !== 32) throw new Error("that is not an ed25519 key");
  if (!/^[a-z2-7]{10}$/.test(id ?? "")) throw new Error("this agent has no tunnel");
  if (!SAFE_PATH.test(node) || !SAFE_PATH.test(agent)) throw new Error("this server's paths cannot carry a direct link");
  return `restrict,command="${node} ${agent} direct" ssh-ed25519 ${match[1]} ${directTag(id)}`;
}

/** replaces this tunnel's line (or removes it with `line` null); every other line stays as it was */
export function setDirectKey(id, line, file = authorizedKeysFile()) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; if (line === null) return; }
  const tag = directTag(id);
  const kept = text.split("\n").filter((entry) => entry && !entry.trimEnd().endsWith(` ${tag}`));
  if (line !== null) kept.push(line);
  writePrivate(file, kept.length ? `${kept.join("\n")}\n` : "");
}

/** at start: a key line written by an older node or agent path is pointed at this one (node moves on upgrades) */
export function refreshDirectKey(id, file = authorizedKeysFile(), paths = {}) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return false; }
  const old = text.split("\n").find((entry) => entry.trimEnd().endsWith(` ${directTag(id)}`));
  const pub = old && /(ssh-ed25519 [A-Za-z0-9+/]{68}) /.exec(old)?.[1];
  if (!pub) return false;
  const line = directKeyLine({ pub, id, ...paths });
  if (line === old.trimEnd()) return false;
  setDirectKey(id, line, file);
  return true;
}

const HOST_KEYS = ["ed25519", "ecdsa", "rsa"].map((type) => `/etc/ssh/ssh_host_${type}_key.pub`);
/** sshd's own public keys, which the app pins: they reach it inside the sealed tunnel, so nobody on the way can swap them */
export function hostKeys(files = HOST_KEYS) {
  const keys = [];
  for (const file of files) {
    try {
      const [type, body] = readFileSync(file, "utf8").trim().split(/\s+/);
      if (/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa)$/.test(type) && /^[A-Za-z0-9+/]+={0,2}$/.test(body ?? "")) keys.push(`${type} ${body}`);
    } catch { /* not this type */ }
  }
  return keys;
}

const STUN = [["stun.l.google.com", 19302], ["stun.cloudflare.com", 3478]];
/** this server's public ipv4, as a stun server sees it (outbound udp: no port needs opening) */
export function publicAddress({ servers = STUN, timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const tid = randomBytes(12);
    const done = (error, address) => { clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(address); };
    const timer = setTimeout(() => done(new Error("no stun server answered")), timeoutMs);
    socket.on("error", (error) => done(error));
    socket.on("message", (message) => {
      if (message.length < 20 || !message.subarray(8, 20).equals(tid)) return;
      for (let at = 20; at + 4 <= message.length;) {
        const type = message.readUInt16BE(at), length = message.readUInt16BE(at + 2);
        if (type === 0x20 && length >= 8 && message[at + 5] === 1) return done(null, [0, 1, 2, 3].map((i) => message[at + 8 + i] ^ [0x21, 0x12, 0xa4, 0x42][i]).join("."));
        at += 4 + length + ((4 - (length % 4)) % 4);
      }
    });
    const request = Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), tid]);
    for (const [host, port] of servers) socket.send(request, port, host, () => {});
  });
}

async function directKey(data, context) {
  if (process.env.DUSK_LINK_DIRECT === "off") throw new Error("direct links are off on this server");
  const line = directKeyLine({ pub: data?.pub, id: context.id });
  const keys = hostKeys();
  if (!keys.length) throw new Error("this server's ssh keys could not be read");
  const host = process.env.DUSK_LINK_DIRECT_HOST || await publicAddress();
  const port = Number(process.env.DUSK_LINK_DIRECT_PORT) || 22;
  setDirectKey(context.id, line);
  return { v: 1, host, port, user: userInfo().username, hostKeys: keys };
}

/**
 * the address of this server's direct path over https: DUSK_LINK_WSS_URL when its operator put the agent's websocket
 * behind their own https (any reverse proxy to 127.0.0.1:DUSK_LINK_WSS_PORT), else the https address this install set up
 */
export function wssUrl({ origin = null } = {}, env = process.env) {
  const given = env.DUSK_LINK_WSS_URL?.trim();
  if (given) {
    if (!/^wss:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]*$/i.test(given)) throw new Error("DUSK_LINK_WSS_URL is not a wss:// address");
    return given;
  }
  return typeof origin === "string" && /^https:\/\/[a-z0-9.-]+$/i.test(origin) ? `wss://${new URL(origin).host}${WS_PATH}` : null;
}

async function directWss(context, readSpki = spkiOf) {
  if (process.env.DUSK_LINK_DIRECT === "off") throw new Error("direct links are off on this server");
  const url = wssUrl(context);
  if (!url) throw new Error("this server has no https address for a direct link");
  const target = new URL(url);
  return { v: 1, url, spki: await readSpki(target.hostname, Number(target.port) || 443) };
}

// ---- the cloudflare backup path ----
/**
 * cloudflared the agent fetches for itself when the installer's apt package is not there: pinned release and sha256
 * (github's own digests), never run unchecked
 */
export const CLOUDFLARED = Object.freeze({
  version: "2026.11.0",
  x64: { asset: "cloudflared-linux-amd64", sha256: "51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd" },
  arm64: { asset: "cloudflared-linux-arm64", sha256: "abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f" },
});
const BACKUP_RESTART_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

/** a cloudflared to run: the installer's, one on PATH, or the pinned one this agent fetched into its own folder */
export async function cloudflaredBinary({ dir = join(configDir(), "bin"), fetchImpl = fetch, arch = process.arch, platform = process.platform, log = () => {} } = {}) {
  for (const candidate of ["/usr/bin/cloudflared", "/usr/local/bin/cloudflared", ...String(process.env.PATH ?? "").split(":").filter(Boolean).map((one) => join(one, "cloudflared"))]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }
  const pin = CLOUDFLARED[arch], file = join(dir, `cloudflared-${CLOUDFLARED.version}`);
  if (!pin || platform !== "linux") return null;
  try { if (createHash("sha256").update(readFileSync(file)).digest("hex") === pin.sha256) return file; } catch { /* not fetched yet */ }
  const answer = await fetchImpl(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED.version}/${pin.asset}`, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!answer.ok) throw new Error(`cloudflared download answered ${answer.status}`);
  const bytes = Buffer.from(await answer.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error("cloudflared download did not match its pinned hash");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, bytes, { mode: 0o700 });
  renameSync(`${file}.tmp`, file);
  log(`link: fetched cloudflared ${CLOUDFLARED.version} for the backup path`);
  return file;
}

/**
 * every server keeps a cloudflare quick tunnel (no account, no login) to its own direct listener as a backup path: the
 * app reaches it as wss://<name>.trycloudflare.com/omb-direct when its direct ways fail and before the link relay.
 * frames on it are sealed with the tunnel key like on every path, so cloudflare carries only ciphertext. best effort: no
 * cloudflared, no backup, and everything else goes on. `url()` is the current address or null
 */
export function createBackupTunnel({ wssPort, binary = cloudflaredBinary, run = spawn, fetchImpl = fetch, log = () => {}, everyMs = 10_000 }) {
  let child = null, host = null, stopped = false, timer = null, restarts = 0, metrics = null;
  const freePort = () => new Promise((resolve, reject) => { const probe = createTcpServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  async function start() {
    if (stopped) return;
    let file;
    try { file = await binary({ log }); } catch (error) { log(`link: no backup path (${error?.message ?? error})`); }
    if (!file || stopped) { if (!stopped) again(); return; }
    metrics = await freePort();
    child = run(file, ["tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${metrics}`, "--url", `http://127.0.0.1:${wssPort}`], { stdio: "ignore" });
    child.once("error", () => {});
    child.once("exit", () => { child = null; host = null; if (!stopped) again(); });
  }
  function again() { const wait = BACKUP_RESTART_MS[Math.min(restarts++, BACKUP_RESTART_MS.length - 1)]; setTimeout(() => void start(), wait).unref?.(); }
  async function look() {
    if (!child || !metrics) return;
    const found = await quickTunnelHost(`http://127.0.0.1:${metrics}/quicktunnel`, fetchImpl).catch(() => null);
    if (found && found !== host) { host = found; restarts = 0; log(`link: backup path at ${host}`); }
  }
  return {
    start() { if (stopped || child) return; void start(); timer = setInterval(() => void look(), everyMs); timer.unref?.(); },
    stop() { stopped = true; clearInterval(timer); child?.kill(); child = null; },
    url: () => (host ? `wss://${host}${WS_PATH}` : null),
  };
}
let backupTunnel = null;

// ---- the direct path over webrtc: electron/vps-link-rtc.mjs is the app's end ----
// ---- shared with electron/vps-link-rtc.mjs (keep both in step; a test checks they interoperate) ----
export const RTC_LABEL = "dusk-link";
export const RTC_PIECE = 64 * 1024;
const RTC_HIGH = 4 * 1024 * 1024;
const RTC_LOW = 1024 * 1024;

/** a node-datachannel data channel as a byte stream; writes wait while more than RTC_HIGH is queued */
export function channelDuplex(dc) {
  let waiting = null;
  const duplex = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      try {
        for (let at = 0; at < chunk.length; at += RTC_PIECE) dc.sendMessageBinary(chunk.subarray(at, at + RTC_PIECE));
      } catch (error) { callback(error); return; }
      if (dc.bufferedAmount() > RTC_HIGH) waiting = callback;
      else callback();
    },
    destroy(error, callback) {
      try { dc.close(); } catch { /* closed */ }
      callback(error);
    },
  });
  dc.setBufferedAmountLowThreshold(RTC_LOW);
  dc.onBufferedAmountLow(() => { const go = waiting; waiting = null; go?.(); });
  dc.onMessage((message) => {
    if (typeof message === "string") { duplex.destroy(new Error("text on a byte channel")); return; }
    duplex.push(Buffer.isBuffer(message) ? message : Buffer.from(message));
  });
  dc.onClosed(() => { duplex.push(null); duplex.destroy(); });
  dc.onError((error) => duplex.destroy(new Error(String(error))));
  return duplex;
}
// ---- end of the shared part ----

/** node-datachannel the installer put beside this file (/opt/duskbot-link/node_modules), or the one this agent fetched
 * into its own folder (ensureRtc); null when neither is there */
let rtcLoaded;
export function rtcLibrary(dirs = [process.env.DUSK_LINK_NDC_DIR, dirname(fileURLToPath(import.meta.url)), configDir()].filter(Boolean)) {
  if (rtcLoaded !== undefined) return rtcLoaded;
  rtcLoaded = null;
  for (const dir of dirs) {
    try {
      const loaded = createRequire(join(dir, "node_modules", "anchor.js"))("node-datachannel");
      if (typeof loaded?.PeerConnection === "function") { rtcLoaded = loaded; break; }
    } catch { /* not there */ }
  }
  return rtcLoaded;
}

/** the node-datachannel the app and server pin (package.json; install.sh AGENT_RTC_VERSION; a test checks all three) */
export const RTC_VERSION = "0.33.6";
const RTC_RETRY_MS = 6 * 60 * 60_000;
let rtcFetching = null, rtcTriedAt = 0;
/**
 * a server installed before webrtc, or whose install could not add it, gets node-datachannel here: npm puts the pinned
 * version (its registry integrity checked) into this agent's own folder, at most once every 6 hours, in the background.
 * best effort: without it the link keeps ssh, https and the relays. DUSK_LINK_RTC_FETCH=off leaves it alone
 */
export function ensureRtc({ dir = configDir(), run = spawn, now = Date.now, log = (line) => console.error(line), has = () => Boolean(rtcLibrary()) } = {}) {
  if (has() || rtcFetching || process.env.DUSK_LINK_RTC_FETCH === "off" || process.env.DUSK_LINK_DIRECT === "off") return rtcFetching;
  if (rtcTriedAt && now() - rtcTriedAt < RTC_RETRY_MS) return null;
  rtcTriedAt = now();
  const npm = existsSync(join(dirname(process.execPath), "npm")) ? join(dirname(process.execPath), "npm") : "npm";
  rtcFetching = new Promise((resolve) => {
    let child;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      child = run(npm, ["install", "--no-save", "--no-fund", "--no-audit", "--no-package-lock", "--omit=dev", "--ignore-scripts", "--prefix", dir, `node-datachannel@${RTC_VERSION}`], { stdio: "ignore", timeout: 10 * 60_000 });
    } catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  }).then((done) => {
    rtcFetching = null;
    if (done) rtcLoaded = undefined;
    const ok = has();
    log(ok ? "link: webrtc for the app's link is ready" : "link: webrtc for the app's link could not be fetched; ssh, https and the relays stay");
    return ok;
  });
  return rtcFetching;
}

const RTC_MAX = 8;
let rtcPeers = 0;
/** an offer for one link-wide data channel, as the app's webrtc stack makes it: bounded, with a fingerprint, no media */
export const rtcOffer = (value) => (value?.type === "offer" && typeof value.sdp === "string" && value.sdp.length <= 64 * 1024 && value.sdp.startsWith("v=0")
  && /^a=fingerprint:sha-256 [0-9A-F:]{95}\r?$/im.test(value.sdp) && /^m=application /m.test(value.sdp) && !/^m=(?:audio|video) /m.test(value.sdp) ? value.sdp : null);

/** answers the app's offer; the channel, once open, is one more direct session of the tunnel's hub (sealed frames only) */
/** the stun servers webrtc asks for this server's public address; DUSK_LINK_STUN (stun:host:port,...) replaces them */
export const rtcStun = (env = process.env) => (env.DUSK_LINK_STUN ? env.DUSK_LINK_STUN.split(",").map((item) => item.trim()).filter((item) => /^stun:[^\s,]+$/.test(item)) : ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]);

export async function directRtc(data, context, lib = rtcLibrary()) {
  if (process.env.DUSK_LINK_DIRECT === "off") throw new Error("direct links are off on this server");
  if (!lib) {
    void ensureRtc();
    throw new Error("webrtc is not installed on this server");
  }
  const sdp = rtcOffer(data?.offer);
  if (!sdp) throw new Error("that is not a link offer");
  if (!context.hub) throw new Error("no tunnel here");
  if (rtcPeers >= RTC_MAX) throw new Error("too many webrtc links");
  const range = /^(\d{4,5})-(\d{4,5})$/.exec(process.env.DUSK_SCREEN_DIRECT_PORTS ?? "");
  const pc = new lib.PeerConnection("dusk-link", { iceServers: rtcStun(), maxMessageSize: 256 * 1024,
    ...(range ? { portRangeBegin: Number(range[1]), portRangeEnd: Number(range[2]) } : {}) });
  rtcPeers += 1;
  let ended = false, accepted = false;
  const end = () => { if (ended) return; ended = true; rtcPeers -= 1; clearTimeout(deadline); try { pc.close(); } catch { /* closed */ } };
  const deadline = setTimeout(() => { if (!accepted) end(); }, 30_000);
  deadline.unref?.();
  pc.onStateChange((state) => { if (state === "failed" || state === "closed") end(); });
  pc.onDataChannel((dc) => {
    if (accepted || ended || dc.getLabel() !== RTC_LABEL) { dc.close(); return; }
    const go = () => {
      if (accepted || ended) return;
      accepted = true;
      clearTimeout(deadline);
      const duplex = channelDuplex(dc);
      duplex.on("error", () => {});
      duplex.once("close", end);
      if (!context.hub.accept(duplex, duplex)) duplex.destroy();
    };
    if (dc.isOpen()) go(); else dc.onOpen(go);
  });
  try {
    pc.setRemoteDescription(sdp, "offer");
    await new Promise((resolve) => {
      if (pc.gatheringState() === "complete") { resolve(); return; }
      const timer = setTimeout(resolve, 1500);
      pc.onGatheringStateChange((state) => { if (state === "complete") { clearTimeout(timer); resolve(); } });
    });
    const local = pc.localDescription();
    if (!local || local.type !== "answer" || ended) throw new Error("no answer");
    return { type: "answer", sdp: local.sdp };
  } catch (error) {
    end();
    throw error;
  }
}

/** the server's version and link protocol, from its public descriptor; a server from before it counts as protocol 1 */
export async function serverLink(read = () => local("GET", "/.well-known/duskbot/environment")) {
  try {
    const answer = await read();
    if (answer.status !== 200 || !answer.body || typeof answer.body !== "object") return null;
    const { version, link } = answer.body;
    const whole = (value) => (Number.isInteger(value) && value > 0 ? value : 1);
    return { version: typeof version === "string" ? version.slice(0, 40) : null, protocol: whole(link?.protocol), minAgent: whole(link?.minAgent) };
  } catch { return null; }
}

export async function control(op, data, context = {}) {
  if (op === "ping") return { ok: true };
  if (op === "hello") {
    const [server, address] = await Promise.all([(context.serverLink ?? serverLink)(), (context.address ?? currentAddress)().catch(() => null)]);
    return { ...agentHello(), server, ...(address ? { address } : {}), ...(context.updater ? { update: context.updater.status() } : {}) };
  }
  if (op === "update") {
    if (!context.updater) throw new Error("this agent does not update itself here");
    await context.updater.check();
    const restarting = data?.apply === "now" ? context.updater.maybeApply(true) : context.updater.maybeApply();
    return { ...context.updater.status(), restarting };
  }
  if (op === "direct-key") return directKey(data, context);
  if (op === "direct-wss") return directWss(context, context.spkiOf);
  if (op === "direct-cf") {
    const url = (context.backup ?? backupTunnel)?.url() ?? null;
    if (!url) throw new Error("this server has no backup path right now");
    return { v: 1, url };
  }
  if (op === "direct-rtc") return directRtc(data, context);
  if (op === "direct-off") { if (context.id) setDirectKey(context.id, null); return { ok: true }; }
  if (op === "pair") {
    // a fresh one-time code for the app's own sign-in here, when its session lapsed (sessions end after 180 days)
    const answer = await local("POST", "/api/auth/pairing", { label: typeof data?.label === "string" ? data.label.slice(0, 60) : "Metal app" });
    if (answer.status !== 200 || typeof answer.body?.code !== "string") throw new Error("The Metal server here would not make a pairing code");
    return { code: answer.body.code };
  }
  if (op === "claude-token") {
    const value = typeof data?.token === "string" ? data.token.trim() : "";
    if (!/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(value)) throw new Error("that is not a Claude token");
    let current = "";
    try { current = readFileSync(enginesFile(), "utf8"); } catch { /* none yet */ }
    // the path unit restarts duskbot when this file changes, so the server's engines see the token
    writePrivate(enginesFile(), setEnvLine(current, "CLAUDE_CODE_OAUTH_TOKEN", value));
    return { ok: true };
  }
  if (op === "codex-auth") {
    const text = typeof data?.auth === "string" ? data.auth : "";
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("that is not a ChatGPT sign-in"); }
    if (!parsed || typeof parsed !== "object" || text.length > 64 * 1024) throw new Error("that is not a ChatGPT sign-in");
    writePrivate(codexAuthFile(), text);
    return { ok: true };
  }
  if (op === "freeze" || op === "thaw") {
    const answer = op === "freeze"
      ? await local("POST", "/api/move/freeze", typeof data?.place === "string" ? { place: data.place.slice(0, 120) } : {})
      : await local("DELETE", "/api/move/freeze", undefined);
    if (answer.status !== 200) throw new Error(answer.body?.error ?? `The Metal server here answered ${answer.status}`);
    return { ok: true };
  }
  throw new Error("unknown request");
}

// ---- self-update ----

/**
 * the file the install put here (root's, read-only to this account). a staged update runs from this account's own
 * folder, launched by that file, which ssh's forced command keeps naming
 */
export const installedAgent = () => process.env.DUSK_LINK_LAUNCHER || fileURLToPath(import.meta.url);
const releasesDir = () => join(configDir(), "releases");
/** ed25519 public keys (base64, raw 32 bytes) a release must be signed by; with none, the link service's tls and hash vouch, as for the install */
export const RELEASE_KEYS = Object.freeze(["beeDw16fb1PcswmcgHOGG4Dic9r/6Vpnvbwc9+v5m6E="]);
const UPDATE_EVERY_MS = 6 * 60 * 60_000;
const UPDATE_FIRST_MS = 5 * 60_000;
/** no request, stream byte or egress stream from the app for this long, and nothing open on egress: an update may restart the tunnel */
export const UPDATE_IDLE_MS = 5 * 60_000;
/** a staged agent that did not stay up this long, this many starts in a row, is never launched again */
const TRIAL_GOOD_MS = 2 * 60_000;
const TRIAL_STARTS = 3;

/** a.b.c compared as numbers; anything else sorts below every version */
export function compareVersions(a, b) {
  const parts = (value) => (/^\d+\.\d+\.\d+$/.test(String(value)) ? String(value).split(".").map(Number) : null);
  const left = parts(a), right = parts(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let at = 0; at < 3; at += 1) if (left[at] !== right[at]) return left[at] < right[at] ? -1 : 1;
  return 0;
}

/** what a release file says it is, read from its own text */
export function releaseOf(text) {
  const version = /^export const AGENT_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(text)?.[1] ?? null;
  const protocol = Number(/^export const LINK_PROTOCOL = (\d+);$/m.exec(text)?.[1] ?? NaN);
  return { version, protocol: Number.isInteger(protocol) ? protocol : null };
}

/** the line a release key signs: the version, the protocol and the file's sha256 */
export const releaseMessage = ({ version, protocol, sha256 }) => Buffer.from(`omb-link-release-v1\n${version}\n${protocol}\n${sha256}`);
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
export function releaseSigned(manifest, keys) {
  if (typeof manifest.sig !== "string") return false;
  const signature = Buffer.from(manifest.sig, "base64");
  return keys.some((key) => {
    try { return verifySignature(null, releaseMessage(manifest), createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(key, "base64")]), format: "der", type: "spki" }), signature); }
    catch { return false; }
  });
}

/** runs `node --check` and `selftest` on a staged file: it must parse and say the version it claims */
function proveRelease(file, version) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, "selftest"], { stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
    let out = "";
    child.stdout.on("data", (chunk) => { out = (out + chunk).slice(-4096); });
    child.once("error", () => resolve(false));
    child.once("close", (code) => {
      try { resolve(code === 0 && JSON.parse(out).version === version); } catch { resolve(false); }
    });
  });
}

/**
 * keeps this agent current: every 6 hours it reads the link service's release manifest, and stages a newer release
 * (never an older one, never a lower protocol) only once its hash, its own version line, a signature when release keys
 * are pinned, and a trial run all check out; `ready.json` is written last. it applies only after UPDATE_IDLE_MS idle,
 * by ending the tunnel so systemd starts it again, and the installed file launches the staged one (launchRelease).
 */
export function createUpdater({ base, dir = releasesDir(), current = AGENT_VERSION, protocol = LINK_PROTOCOL, keys = [...RELEASE_KEYS, ...(process.env.DUSK_LINK_RELEASE_KEYS ?? "").split(",").map((key) => key.trim()).filter(Boolean)], fetchImpl = fetch, prove = proveRelease, idle = () => false, apply = () => {}, now = Date.now, log = () => {}, everyMs = UPDATE_EVERY_MS, firstMs = UPDATE_FIRST_MS }) {
  let staged = null, checkedAt = null, error = null, timer = null, checking = null, applying = false;
  try {
    const ready = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8"));
    if (compareVersions(ready.version, current) > 0) staged = ready.version;
  } catch { /* nothing staged */ }

  async function stage() {
    checkedAt = now();
    const answer = await fetchImpl(`${base}/v1/release`, { signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) throw new Error(`the link service answered ${answer.status} for the release`);
    const manifest = await answer.json();
    const release = { version: manifest?.agent?.version, protocol: manifest?.agent?.protocol, sha256: manifest?.agent?.sha256, sig: manifest?.sig };
    if (compareVersions(release.version, current) <= 0 || !Number.isInteger(release.protocol) || release.protocol < protocol) return null;
    if (staged === release.version) return staged;
    if (!/^[0-9a-f]{64}$/.test(String(release.sha256))) throw new Error("the release has no usable hash");
    if (keys.length && !releaseSigned(release, keys)) throw new Error(`release ${release.version} is not signed by a pinned key`);
    const download = await fetchImpl(`${base}/agent.mjs`, { signal: AbortSignal.timeout(120_000) });
    if (!download.ok) throw new Error(`the link service answered ${download.status} for the agent`);
    const bytes = Buffer.from(await download.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error(`release ${release.version} does not match its hash`);
    const said = releaseOf(bytes.toString("utf8"));
    if (said.version !== release.version || said.protocol !== release.protocol) throw new Error(`release ${release.version} says it is ${said.version ?? "something else"}`);
    const folder = join(dir, release.version), file = join(folder, "agent.mjs");
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writePrivate(file, bytes);
    if (!await prove(file, release.version)) { rmSync(folder, { recursive: true, force: true }); throw new Error(`release ${release.version} did not start`); }
    writePrivate(join(dir, "ready.json"), JSON.stringify({ v: 1, version: release.version, sha256: release.sha256, at: now() }));
    for (const old of readdirSync(dir)) if (/^\d+\.\d+\.\d+$/.test(old) && old !== release.version && old !== current) rmSync(join(dir, old), { recursive: true, force: true });
    staged = release.version;
    log(`link: agent ${release.version} is staged; it starts once nobody uses this link for a while`);
    return staged;
  }

  async function check() {
    checking ??= stage().then((found) => { error = null; return found; }, (failed) => { error = failed?.message ?? String(failed); log(`link: no update (${error})`); return staged; }).finally(() => { checking = null; });
    return checking;
  }

  function maybeApply(force = false) {
    if (!staged || applying || (!force && !idle())) return false;
    applying = true;
    log(`link: restarting into agent ${staged}`);
    apply(staged);
    return true;
  }

  let idleTimer = null;
  return {
    check, maybeApply,
    status: () => ({ running: current, staged, checkedAt, ...(error ? { error } : {}) }),
    start() {
      if (timer) return;
      const again = () => { void check().then(() => maybeApply()); timer = setTimeout(again, everyMs); timer.unref?.(); };
      timer = setTimeout(again, firstMs);
      timer.unref?.();
      // a staged release waits for the link to fall idle; this looks every minute
      idleTimer = setInterval(() => maybeApply(), 60_000);
      idleTimer.unref?.();
    },
    stop() { clearTimeout(timer); clearInterval(idleTimer); timer = null; idleTimer = null; },
  };
}

// ---- the server's own updates ----

/**
 * CI's release keys for the server build (apps/cloud-service/src/release-signing.ts PINNED_RELEASE_KEYS, as kid:x), the
 * same install.sh pins. this check only saves a wasted download: root's updater checks everything again
 */
export const SERVER_RELEASE_KEYS = Object.freeze(["rel-2026-11:wtwZypDwVPBXZ25XsZOVpd0PZPBbVMhugheUj5_NLIM"]);
const SERVER_UPDATE_EVERY_MS = 60 * 60_000;
const SERVER_UPDATE_FIRST_MS = 10 * 60_000;
/** each check lands somewhere in this much more, so servers that started together do not ask the link service together */
const SERVER_UPDATE_JITTER_MS = 20 * 60_000;
const SIGNATURE = /^r1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]{1,4000}\.[A-Za-z0-9_-]{40,200}$/;
export const serverReleaseDir = () => join(configDir(), "server-release");

/** the signed manifest of a vps-package signature over `sha256`, or null */
export function serverReleaseSigned(signature, sha256, keys = SERVER_RELEASE_KEYS) {
  const parts = String(signature ?? "").trim().split(".");
  if (parts.length !== 4 || parts[0] !== "r1") return null;
  const key = keys.map((item) => item.split(":")).find(([kid, x]) => kid === parts[1] && x);
  if (!key) return null;
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key[1] }, format: "jwk" });
    if (!verifySignature(null, Buffer.from(parts.slice(0, 3).join(".")), pub, Buffer.from(parts[3], "base64url"))) return null;
    const manifest = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
    return manifest?.v === 1 && manifest.kind === "vps-package" && manifest.sha256 === sha256 && /^\d+\.\d+\.\d+$/.test(manifest.version ?? "") ? manifest : null;
  } catch { return null; }
}

/**
 * stages the server build the link service hands out for root's updater (install.sh --update-server, run by
 * duskbot-server-update.timer): `<sha256>.tgz` once it matches its hash and, when signed, a pinned key; `ready.json`
 * last. it never installs anything: the server is root's, and root's updater takes signed builds only, so an unsigned
 * offer or a bad signature is never downloaded
 */
export function createServerUpdater({ base, id, token, dir = serverReleaseDir(), keys = [...SERVER_RELEASE_KEYS, ...(process.env.DUSK_RELEASE_PUBLIC_KEYS ?? "").split(",").map((key) => key.trim()).filter(Boolean)], fetchImpl = fetch, current = async () => (await serverLink())?.version ?? null, now = Date.now, log = () => {}, everyMs = SERVER_UPDATE_EVERY_MS, firstMs = SERVER_UPDATE_FIRST_MS, jitterMs = SERVER_UPDATE_JITTER_MS, random = Math.random }) {
  let checking = null, timer = null, last = { checkedAt: null, staged: null, error: null }, said = null;
  const auth = { authorization: `Bearer ${token}` };
  // what a check found, once each time it changes: an hourly "nothing new" line would bury the journal
  const tell = (line) => { if (line !== said) { said = line; log(line); } };

  async function download(sha256, size) {
    const file = join(dir, `${sha256}.tgz`), part = `${file}.part`;
    let offset = 0;
    try { offset = statSync(part).size; } catch { /* fresh */ }
    if (offset >= size) { rmSync(part, { force: true }); offset = 0; }
    const answer = await fetchImpl(`${base}/v1/tunnels/${id}/server/${sha256}.tgz`, { headers: { ...auth, ...(offset ? { range: `bytes=${offset}-` } : {}) }, signal: AbortSignal.timeout(30 * 60_000) });
    if (answer.status !== 200 && answer.status !== 206) { await answer.body?.cancel().catch(() => {}); throw new Error(`the link service answered ${answer.status} for the build`); }
    await pipeline(Readable.fromWeb(answer.body), createWriteStream(part, { flags: answer.status === 206 ? "a" : "w", mode: 0o600 }));
    if (createHash("sha256").update(readFileSync(part)).digest("hex") !== sha256) { rmSync(part, { force: true }); throw new Error("the build did not match its hash"); }
    renameSync(part, file);
  }

  async function stage() {
    const answer = await fetchImpl(`${base}/v1/tunnels/${id}/server`, { headers: auth, signal: AbortSignal.timeout(30_000) });
    if (answer.status === 404) {
      await answer.body?.cancel().catch(() => {});
      tell("link: no server build is published on the link service (it answered 404); the server stays as it is");
      return null;
    }
    if (!answer.ok) throw new Error(`the link service answered ${answer.status} for the server release`);
    const offer = await answer.json();
    const pkg = offer?.package, sha256 = String(pkg?.sha256 ?? ""), size = pkg?.size;
    if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3) throw new Error("the server release is not usable");
    const signature = typeof pkg.signature === "string" ? pkg.signature : null;
    const signed = signature ? serverReleaseSigned(signature, sha256, keys) : null;
    if (!signed) throw new Error("the server release is not signed by a pinned key");
    const version = signed.version;
    const running = await current().catch(() => null);
    if (running && compareVersions(version, running) <= 0) {
      tell(`link: server ${running} is up to date (the link service offers ${version})`);
      return null;
    }
    let ready = null;
    try { ready = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8")); } catch { /* nothing staged */ }
    if (ready?.sha256 === sha256 && existsSync(join(dir, `${sha256}.tgz`))) {
      tell(`link: server build ${version} is staged; it installs once no bot is working`);
      return version;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await download(sha256, size);
    const policy = offer.policy && typeof offer.policy.body === "string" && /^[A-Za-z0-9_-]{1,32000}$/.test(offer.policy.body) && SIGNATURE.test(offer.policy.signature ?? "")
      ? { body: offer.policy.body, signature: offer.policy.signature } : null;
    writePrivate(join(dir, "ready.json"), JSON.stringify({ v: 1, sha256, size, version, signature, ...(policy ? { policy } : {}), at: now() }));
    for (const name of readdirSync(dir)) if (/^[0-9a-f]{64}\.tgz(\.part)?$/.test(name) && !name.startsWith(sha256)) rmSync(join(dir, name), { force: true });
    tell(`link: server build ${version} is staged; it installs once no bot is working`);
    return version;
  }

  function check() {
    checking ??= stage().then((staged) => { last = { checkedAt: now(), staged, error: null }; return staged; },
      (failed) => { last = { checkedAt: now(), staged: null, error: failed?.message ?? String(failed) }; tell(`link: no server update (${last.error})`); return null; })
      .finally(() => { checking = null; });
    return checking;
  }

  return {
    check,
    status: () => ({ ...last }),
    start() {
      if (timer) return;
      const spread = (ms) => ms + Math.floor(random() * jitterMs);
      const again = () => { void check(); timer = setTimeout(again, spread(everyMs)); timer.unref?.(); };
      timer = setTimeout(again, spread(firstMs));
      timer.unref?.();
    },
    stop() { clearTimeout(timer); timer = null; },
  };
}

/**
 * at start: the staged release this installed file should run instead of itself, or null. a release is launched only
 * when newer than this file and still matching its hash; one that did not stay up for TRIAL_GOOD_MS on TRIAL_STARTS
 * starts in a row is skipped for good, so a bad release leaves this one running
 */
export function stagedRelease({ dir = releasesDir(), current = AGENT_VERSION, log = () => {} } = {}) {
  let ready;
  try { ready = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8")); } catch { return null; }
  if (compareVersions(ready.version, current) <= 0) return null;
  const file = join(dir, ready.version, "agent.mjs");
  let bytes;
  try { bytes = readFileSync(file); } catch { return null; }
  if (createHash("sha256").update(bytes).digest("hex") !== ready.sha256) { log(`link: staged agent ${ready.version} changed on disk; staying on ${current}`); return null; }
  let trial = {};
  try { trial = JSON.parse(readFileSync(join(dir, "trial.json"), "utf8")); } catch { /* first start */ }
  if (trial.version !== ready.version) trial = { version: ready.version, starts: 0, good: false };
  if (!trial.good && trial.starts >= TRIAL_STARTS) { log(`link: staged agent ${ready.version} did not stay up; staying on ${current}`); return null; }
  return { version: ready.version, file, trial };
}

/** runs a staged release in place of this file, as long as it runs; the exit code is the release's */
export function launchRelease(release, { dir = releasesDir(), argv = ["tunnel"], log = (line) => console.error(line) } = {}) {
  const trial = { ...release.trial, starts: (release.trial.starts ?? 0) + (release.trial.good ? 0 : 1) };
  writePrivate(join(dir, "trial.json"), JSON.stringify(trial));
  log(`link: running agent ${release.version}`);
  const child = spawn(process.execPath, [release.file, ...argv], { stdio: "inherit", env: { ...process.env, DUSK_LINK_LAUNCHER: installedAgent() } });
  const healthy = setTimeout(() => { if (!trial.good) writePrivate(join(dir, "trial.json"), JSON.stringify({ ...trial, good: true })); }, TRIAL_GOOD_MS);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => {
    child.once("error", () => { clearTimeout(healthy); resolve(1); });
    child.once("exit", (code) => { clearTimeout(healthy); resolve(code ?? 1); });
  });
}

// ---- egress ----

/** the bridge every bot computer joins (shared/bot-desktop.ts BOT_DESKTOP_BRIDGE) and the proxy's port on it */
export const EGRESS_BRIDGE = "omb-desk0";
export const EGRESS_PORT = Number(process.env.LINK_EGRESS_PORT) || 3129;
/** the app says hello every 15 s while it takes streams; three missed and this server uses its own network again */
const EGRESS_SEEN_MS = 40_000;
/**
 * how long a bot computer's connection waits for the app to open its stream before it goes out direct instead. the route
 * runs through the app only while its dials take about 200 ms, so a dial this slow means the path went bad: waiting 5 s
 * here held every connection of a page that long while the relay faltered (2026-11-08)
 */
export const EGRESS_DIAL_MS = 2000;
/** how long the app takes to open a stream, from the last few dials: the server routes through the app only while it is fast */
const DIAL_SAMPLES = 7;
const DIAL_SAMPLE_MAX_AGE_MS = 120_000;
/** with no recent dial, one probe stream (opened and dropped at once) measures the path again */
const DIAL_PROBE_EVERY_MS = 60_000;
export const EGRESS_PROBE = { host: "www.gstatic.com", port: 443 };
const EGRESS_QUEUE_HIGH = 1024 * 1024;
const EGRESS_HEAD_MAX = 8 * 1024;
/**
 * socks5 replies. a failure reply means "this computer cannot take it now" (off, offline, busy, slow): the policy's
 * direct fallback then opens that request from this server instead. a destination this computer refuses or cannot
 * reach gets a success reply and an immediate close, which fails only that request the same way an unreachable site
 * would.
 */
const SOCKS = { ok: 0, failure: 1, notAllowed: 2, unreachable: 4, refused: 5, command: 7, address: 8 };

/** the bridge's own ipv4 address and subnet, or null while docker has not made it */
export function bridgeAddress(name = EGRESS_BRIDGE, interfaces = networkInterfaces()) {
  const entry = (interfaces[name] ?? []).find((one) => one.family === "IPv4" || one.family === 4);
  if (!entry) return null;
  const [network, bits] = String(entry.cidr ?? `${entry.address}/24`).split("/");
  const subnet = new BlockList();
  subnet.addSubnet(network, Number(bits), "ipv4");
  return { host: entry.address, subnet };
}

function socksReply(code) { return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]); }

/** reads a socks5 connect or an http connect off `socket`: `{ host, port, rest, reply(ok, code) }`, or null */
function readProxyHandshake(socket) {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0), stage = "first", done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", gone);
      socket.off("close", gone);
      socket.pause();
      resolve(value);
    };
    const gone = () => finish(null);
    const timer = setTimeout(() => { socket.destroy(); finish(null); }, 10_000);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > EGRESS_HEAD_MAX) { socket.destroy(); return finish(null); }
      if (stage === "first") {
        if (buffered[0] === 5) stage = "socks-hello";
        else if (buffered[0] === 0x43) stage = "http";
        else { socket.destroy(); return finish(null); }
      }
      if (stage === "socks-hello") {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
        const methods = buffered.subarray(2, 2 + buffered[1]);
        buffered = buffered.subarray(2 + methods.length);
        if (!methods.includes(0)) { socket.end(Buffer.from([5, 0xff])); return finish(null); }
        socket.write(Buffer.from([5, 0]));
        stage = "socks-request";
      }
      if (stage === "socks-request") {
        if (buffered.length < 5) return;
        const [version, command, , type] = buffered;
        let host, at;
        if (type === 1) { if (buffered.length < 10) return; host = [...buffered.subarray(4, 8)].join("."); at = 8; }
        else if (type === 3) { const size = buffered[4]; if (buffered.length < 5 + size + 2) return; host = buffered.toString("latin1", 5, 5 + size); at = 5 + size; }
        else if (type === 4) {
          if (buffered.length < 22) return;
          const groups = [];
          for (let i = 4; i < 20; i += 2) groups.push(buffered.readUInt16BE(i).toString(16));
          host = groups.join(":"); at = 20;
        } else { socket.end(socksReply(SOCKS.address)); return finish(null); }
        if (version !== 5 || command !== 1) { socket.end(socksReply(SOCKS.command)); return finish(null); }
        const port = buffered.readUInt16BE(at);
        return finish({ host, port, rest: buffered.subarray(at + 2), reply: (ok, code) => socket.write(socksReply(ok ? SOCKS.ok : code ?? SOCKS.failure)), fail: () => socket.end(socksReply(SOCKS.ok)) });
      }
      if (stage === "http") {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        const line = buffered.toString("latin1", 0, buffered.indexOf("\r\n"));
        const match = /^CONNECT (\[[0-9a-f:.]+\]|[^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/i.exec(line);
        if (!match) { socket.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"); return finish(null); }
        return finish({
          host: match[1].replace(/^\[|\]$/g, ""), port: Number(match[2]), rest: buffered.subarray(end + 4),
          reply: (ok, code) => socket.write(ok ? "HTTP/1.1 200 Connection Established\r\n\r\n"
            : `HTTP/1.1 ${code === SOCKS.notAllowed ? "403 Forbidden" : "502 Bad Gateway"}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`),
          fail: (code) => socket.end(`HTTP/1.1 ${code === SOCKS.notAllowed ? "403 Forbidden" : "502 Bad Gateway"}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`),
        });
      }
    };
    socket.on("data", onData);
    socket.once("end", gone);
    socket.once("close", gone);
  });
}

const egressCode = (code) => (code === "port" || code === "home-network" || code === "loopback" || code === "metadata" || code === "link-local" || code === "reserved"
  ? SOCKS.notAllowed : code === "refused" ? SOCKS.refused : code === "unreachable" ? SOCKS.unreachable : SOCKS.failure);

/**
 * the server's half of "route traffic through this computer": a proxy the bot computers reach on their bridge, whose
 * connections the app opens from the person's own computer. it rides any tunnel with the stream api `send(frame)`,
 * `bytes(r, chunk)`, `queued()` and `onDrain(fn)` (the relay), and takes the app's frames through `handle(frame)`.
 * `path()` names a faster way with the same api while there is one (a direct session): each stream keeps the path it
 * was dialled on, and `dropPath(path)` ends the streams of one that is gone.
 * Security: it never connects anywhere itself (a box reaching this host must not get past the host fence), only
 * answers on the bridge, and refuses the bridge's own address so processes on this host cannot use it. the app checks
 * every destination again on its side.
 */
export function createEgressProxy({
  send, bytes, queued, onDrain, path = () => null, log = () => {}, now = Date.now,
  bind = () => bridgeAddress(), port = EGRESS_PORT, report = null, reportMs = 5000, dialMs = EGRESS_DIAL_MS,
  probe = EGRESS_PROBE, probeEveryMs = DIAL_PROBE_EVERY_MS,
}) {
  const relay = { send, bytes, queued, onDrain };
  const pick = () => path() ?? relay;
  const streams = new Map();
  const probes = new Map();
  let samples = [];
  const sample = (ms) => { samples = [...samples, { at: now(), ms }].slice(-DIAL_SAMPLES); };
  /** the median dial time of recent streams, or null when there is none */
  const dialLatency = () => {
    const recent = samples.filter((one) => now() - one.at < DIAL_SAMPLE_MAX_AGE_MS).map((one) => one.ms).sort((a, b) => a - b);
    return recent.length ? recent[Math.floor(recent.length / 2)] : null;
  };
  let seenAt = 0, ready = false, enabled = report === null, server = null, listening = null, timer = null, stopped = false;
  const stats = { relayed: 0, refused: 0, fallbacks: 0 };
  const online = () => ready && now() - seenAt < EGRESS_SEEN_MS;
  const randomId = () => Array.from(randomBytes(12), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31]).join("");

  function forget(r, tell, over = null) {
    const entry = streams.get(r);
    if (!entry) return;
    streams.delete(r);
    clearTimeout(entry.timer);
    entry.settle?.({ ok: false, code: "closed" });
    entry.socket.destroy();
    if (tell) (over ?? entry.via).send({ t: "cancel", r });
  }

  /**
   * new connections go direct until the app answers again. `dead` (the app said goodbye, or has been silent past
   * EGRESS_SEEN_MS) also closes the streams it carries, so their browsers see the close now instead of waiting. a slow
   * dial alone leaves them: one page's css and scripts ride a few long-lived connections, and closing them mid-load left
   * pages as unstyled html (2026-11-09)
   */
  function gone(dead = true) {
    ready = false;
    for (const [r, entry] of streams) {
      if (entry.settle) { const settle = entry.settle; entry.settle = null; clearTimeout(entry.timer); settle({ ok: false, code: "closed" }); }
      else if (dead && entry.relaying) forget(r, false);
    }
  }

  async function accept(socket, allowed) {
    socket.on("error", () => {});
    const remote = String(socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!allowed(remote)) { socket.destroy(); return; }
    const asked = await readProxyHandshake(socket);
    if (!asked || stopped) { socket.destroy(); return; }
    const fallBack = () => { stats.refused += 1; stats.fallbacks += 1; asked.reply(false, SOCKS.failure); socket.end(); };
    if (!enabled || !online()) return fallBack();
    const r = randomId();
    const dialedAt = now();
    const via = pick();
    const answer = await new Promise((settle) => {
      const entry = { socket, settle, via, endSent: false, timer: setTimeout(() => {
        sample(dialMs);
        // the app did not answer in time: it is asleep or gone, so new connections go direct until it says hello again
        log("egress: the app did not answer; bot computers use this server's own network until it is back");
        entry.settle = null;
        settle({ ok: false, code: "timeout" });
        gone(false);
        void tick();
      }, dialMs) };
      streams.set(r, entry);
      via.send({ t: "dial", r, host: asked.host, port: asked.port });
    });
    const entry = streams.get(r);
    if (!answer.ok || !entry) {
      if (entry) { streams.delete(r); clearTimeout(entry.timer); if (answer.code === "timeout") via.send({ t: "cancel", r }); }
      if (answer.code === "timeout" || answer.code === "busy" || answer.code === "closed") return fallBack();
      stats.refused += 1;
      return asked.fail(egressCode(answer.code));
    }
    sample(now() - dialedAt);
    stats.relayed += 1;
    entry.relaying = true;
    asked.reply(true);
    if (asked.rest.length) via.bytes(r, asked.rest);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (streams.get(r) !== entry) return;
      via.bytes(r, chunk);
      if (via.queued() >= EGRESS_QUEUE_HIGH) { socket.pause(); via.onDrain(() => { if (streams.get(r) === entry) socket.resume(); }); }
    });
    socket.on("end", () => { if (streams.get(r) === entry) { entry.endSent = true; via.send({ t: "end", r }); } });
    socket.on("close", () => { if (streams.get(r) === entry) forget(r, !entry.endSent); });
    socket.resume();
  }

  async function relisten() {
    if (stopped) return;
    const want = bind();
    if (listening && want && listening.host === want.host) return;
    if (server) { const old = server; server = null; listening = null; await new Promise((resolve) => old.close(() => resolve())); }
    if (!want) return;
    const allowed = want.allow ?? ((address) => address !== want.host && want.subnet.check(address, "ipv4"));
    const next = createTcpServer((socket) => void accept(socket, allowed));
    try {
      await new Promise((resolve, reject) => { next.once("error", reject); next.listen(want.port ?? port, want.host, () => resolve()); });
      server = next;
      listening = { host: want.host, port: next.address().port };
      log(`egress: bot computers can route through the app at ${listening.host}:${listening.port}`);
    } catch (error) {
      log(`egress: could not listen on ${want.host}:${port} (${error?.code ?? error?.message ?? error})`);
    }
  }

  /** a dial nobody uses, answered by the app like any other: only its timing is kept */
  function measure() {
    const last = samples.at(-1)?.at ?? -Infinity;
    if (!probe || !enabled || !online() || probes.size || now() - last < probeEveryMs) return;
    const r = randomId(), at = now(), via = pick();
    probes.set(r, { at, via, timer: setTimeout(() => { if (probes.delete(r)) { sample(dialMs); via.send({ t: "cancel", r }); } }, dialMs) });
    via.send({ t: "dial", r, host: probe.host, port: probe.port });
  }

  async function tick() {
    if (streams.size && now() - seenAt >= EGRESS_SEEN_MS) gone();
    await relisten();
    if (report && !stopped) {
      try {
        const said = await report({ online: online(), proxy: listening, active: streams.size, dialMs: dialLatency(), ...stats });
        if (typeof said?.enabled === "boolean") enabled = said.enabled;
      } catch { /* the server is restarting; the last answer stands */ }
    }
    if (!stopped) measure();
  }

  return {
    get listening() { return listening; },
    get enabled() { return enabled; },
    online,
    stats: () => ({ ...stats, active: streams.size }),
    dialLatency,
    async start() {
      await tick();
      timer = setInterval(() => void tick(), reportMs);
      timer.unref?.();
    },
    /** the app's frames: hello, dial answers and the bytes of streams this proxy opened */
    handle(frame) {
      if (frame?.t === "egress") {
        const was = online();
        if (frame.ready === true) { ready = true; seenAt = now(); }
        else { gone(); seenAt = 0; }
        if (was !== online()) { log(online() ? "egress: the app takes streams again" : "egress: the app stopped taking streams"); void tick(); }
        return true;
      }
      const probed = typeof frame?.r === "string" ? probes.get(frame.r) : undefined;
      if (probed) {
        if (frame.t === "dialed") {
          probes.delete(frame.r);
          clearTimeout(probed.timer);
          seenAt = now();
          ready = true;
          sample(now() - probed.at);
          if (frame.ok === true) probed.via.send({ t: "cancel", r: frame.r });
        }
        return true;
      }
      const entry = typeof frame?.r === "string" ? streams.get(frame.r) : undefined;
      if (!entry) return frame?.t === "dialed";
      if (frame.t === "dialed") {
        clearTimeout(entry.timer);
        seenAt = now();
        ready = true;
        entry.settle?.(frame.ok === true ? { ok: true } : { ok: false, code: typeof frame.code === "string" ? frame.code : "unreachable" });
        entry.settle = null;
      } else if (frame.t === "bytes") {
        if (entry.socket.writableLength + frame.b.length > 8 * 1024 * 1024) forget(frame.r, true);
        else entry.socket.write(frame.b);
      } else if (frame.t === "end") entry.socket.end();
      else if (frame.t === "cancel") forget(frame.r, false);
      else return false;
      return true;
    },
    /** a path that is gone: its streams end, and the app hears it over the relay */
    dropPath(gone) {
      for (const [r, probed] of probes) if (probed.via === gone) { probes.delete(r); clearTimeout(probed.timer); }
      for (const [r, entry] of Array.from(streams)) {
        if (entry.via !== gone) continue;
        if (entry.settle) { const settle = entry.settle; entry.settle = null; clearTimeout(entry.timer); streams.delete(r); settle({ ok: false, code: "closed" }); relay.send({ t: "cancel", r }); }
        else forget(r, true, relay);
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const probed of probes.values()) clearTimeout(probed.timer);
      probes.clear();
      for (const r of streams.keys()) forget(r, false);
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      server = null;
      listening = null;
    },
  };
}

// ---- end egress ----

/**
 * what the app's frames ask of this server, over either path: requests and websockets to Metal, control ops to this
 * agent. `sink` takes the replies: push(frame), bytes(r, chunk) (false: pause), onDrain(resume), discard(r).
 */
/** a stream's sender says how many bytes it sent so far after this many more, or this long, so a gap shows */
export const MARK_BYTES = 256 * 1024;
export const MARK_MS = 2000;

export function createServing({ server = SERVER, sink, stopped = () => false, context = {}, controls = true, forwardedFor = "192.0.2.10", allow = null, log = () => {}, since = null }) {
  const pending = new Map();
  const emit = (frame) => { if (!stopped()) sink.push(frame); };
  // replies count what they send (marks, and `n` on the end) so the app can tell one that lost bytes on the way; an
  // older app ignores both
  const sent = new Map();
  const sendBytes = (r, chunk) => {
    let count = sent.get(r);
    if (!count) sent.set(r, (count = { n: 0, marked: 0, at: Date.now() }));
    count.n += chunk.length;
    const more = sink.bytes(r, chunk);
    if (count.n - count.marked >= MARK_BYTES || Date.now() - count.at >= MARK_MS) { count.marked = count.n; count.at = Date.now(); emit({ t: "mark", r, n: count.n }); }
    return more;
  };
  const endOf = (r) => { const n = sent.get(r)?.n ?? 0; sent.delete(r); return { t: "end", r, n }; };
  /** the app's count of a body or websocket it sent against what arrived: short means bytes were lost, so it fails */
  function short(r, n) {
    const entry = pending.get(r);
    if (!entry || !Number.isSafeInteger(n) || n === entry.got) return false;
    log(`link: a request body lost ${n - entry.got} bytes on the way; it is ended`);
    pending.delete(r);
    sent.delete(r);
    entry.destroy();
    sink.discard(r);
    emit({ t: "err", r, message: "Part of this request was lost on the way. Try again." });
    return true;
  }

  function overflow(r) {
    const entry = pending.get(r);
    if (!entry) return;
    pending.delete(r);
    sent.delete(r);
    entry.destroy();
    sink.discard(r);
    emit({ t: "err", r, message: "The destination could not keep up with this transfer. Try again." });
  }

  function writeTo(r, destination, chunk) {
    if (!pending.has(r)) return;
    if (destination.writableLength + chunk.length > RECEIVE_HIGH) { overflow(r); return; }
    destination.write(chunk);
  }

  /** a websocket the app opened: the server answers its handshake, then the socket's bytes cross both ways */
  function upgraded(frame, early, res, socket, head) {
    const out = {};
    for (const [name, value] of Object.entries(res.headers)) if (!HOP.has(name)) out[name] = value;
    emit({ t: "head", r: frame.r, status: 101, headers: out, up: true });
    socket.setNoDelay(true);
    const was = pending.get(frame.r);
    pending.set(frame.r, { got: was?.got ?? 0, write: (chunk) => writeTo(frame.r, socket, chunk), end: () => socket.end(), destroy: () => socket.destroy() });
    for (const chunk of early) writeTo(frame.r, socket, chunk);
    const read = (chunk) => { if (pending.has(frame.r) && !sendBytes(frame.r, chunk)) { socket.pause(); sink.onDrain(() => socket.resume()); } };
    if (head.length) read(head);
    socket.on("data", read);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { if (pending.delete(frame.r)) emit(endOf(frame.r)); else sent.delete(frame.r); });
  }

  function startRequest(frame) {
    const headers = {};
    for (const [name, value] of Object.entries(frame.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!HOP.has(lower) && (controls || (lower !== "cookie" && !isOwnHeader(lower)))) headers[name] = value;
    }
    if (frame.up === true) { headers.connection = "Upgrade"; headers.upgrade = "websocket"; }
    // marks every tunnelled request as remote (server/request-auth.ts isProxied): it needs a paired session, never loopback trust
    headers["x-forwarded-for"] = forwardedFor;
    headers["x-forwarded-proto"] = "http";
    if (headers.host) headers["x-forwarded-host"] = headers.host;
    let reply = null, req;
    // a frame's method, path and headers come from the other end: one node refuses (a bad header name) fails that request only
    try { req = httpRequest({ ...server, method: frame.method, path: frame.path, headers }, (res) => {
      reply = res;
      if (!pending.has(frame.r) || stopped()) { res.destroy(); return; }
      const out = {};
      for (const [name, value] of Object.entries(res.headers)) if (!HOP.has(name)) out[name] = value;
      // the length travels apart (content-length is per hop): the app needs it to pick a broken download up again
      if (/^\d+$/.test(String(res.headers["content-length"] ?? ""))) out["x-dusk-length"] = res.headers["content-length"];
      // `since`: when this process started, so a phone sees the agent restarted and ends what went through the one before
      emit({ t: "head", r: frame.r, status: res.statusCode ?? 502, headers: out, ...(since ? { since } : {}) });
      res.on("data", (chunk) => {
        if (!pending.has(frame.r) || stopped()) return;
        if (!sendBytes(frame.r, chunk)) {
          res.pause();
          sink.onDrain(() => { if (pending.has(frame.r)) res.resume(); });
        }
      });
      res.on("end", () => { if (pending.delete(frame.r)) emit(endOf(frame.r)); else sent.delete(frame.r); });
      res.on("error", () => { sent.delete(frame.r); if (pending.delete(frame.r)) emit({ t: "err", r: frame.r, message: "reply cut off" }); });
    }); } catch { emit({ t: "err", r: frame.r, message: "That request could not be sent." }); return; }
    req.on("error", () => { if (pending.delete(frame.r)) emit({ t: "err", r: frame.r, message: "The Metal server did not answer" }); });
    // bytes the app sent before the handshake was answered wait for the socket
    const early = [];
    let earlyBytes = 0;
    if (frame.up === true) req.on("upgrade", (res, socket, head) => { if (pending.has(frame.r)) upgraded(frame, early, res, socket, head); else socket.destroy(); });
    sent.delete(frame.r);
    pending.set(frame.r, frame.up === true
      ? { got: 0, write: (chunk) => {
        if (earlyBytes + chunk.length > RECEIVE_HIGH) { overflow(frame.r); return; }
        early.push(chunk);
        earlyBytes += chunk.length;
      }, end: () => {}, destroy: () => req.destroy() }
      : { got: 0, write: (chunk) => writeTo(frame.r, req, chunk), end: () => req.end(), destroy: () => { reply?.destroy(); req.destroy(); } });
    if (frame.end) req.end();
  }

  async function handle(frame) {
    if (frame.t === "req" && typeof frame.r === "string" && typeof frame.path === "string" && frame.path.startsWith("/")) {
      if (allow && !allow(frame.method, frame.path.split("?", 1)[0])) return emit({ t: "err", r: frame.r, message: "This pairing channel only redeems its grant." });
      // the app sends an unanswered GET again when it fears the first was lost; one that did arrive is not run twice
      if (pending.has(frame.r)) return;
      return startRequest(frame);
    }
    if (frame.t === "body") {
      const req = pending.get(frame.r);
      if (!req) return;
      if (frame.d) { const bytes = Buffer.from(frame.d, "base64"); req.got += bytes.length; req.write(bytes); }
      if (frame.end && !short(frame.r, frame.n)) req.end();
      return;
    }
    if (frame.t === "bytes") { const req = pending.get(frame.r); if (req) { req.got += frame.b.length; req.write(frame.b); } return; }
    if (frame.t === "mark") { short(frame.r, frame.n); return; }
    if (frame.t === "cancel") { pending.get(frame.r)?.destroy(); pending.delete(frame.r); sent.delete(frame.r); sink.discard(frame.r); return; }
    if (frame.t === "ctl") {
      if (!controls) return emit({ t: "ctl", r: frame.r, ok: false, error: "not allowed" });
      try { emit({ t: "ctl", r: frame.r, ok: true, data: await control(frame.op, frame.data, context) }); }
      catch (error) { emit({ t: "ctl", r: frame.r, ok: false, error: error?.message ?? String(error) }); }
    }
  }

  return {
    handle,
    destroyAll() { for (const req of pending.values()) req.destroy(); pending.clear(); sent.clear(); },
  };
}

/** `egress`: options for createEgressProxy, which then rides this tunnel; without it the app's hellos are ignored */
/** `update`: options for createUpdater, which then keeps this agent current and restarts the tunnel only when idle */
/** a retry wait between half and all of `ms`: servers that lost the same node do not all come back in the same second */
export const spread = (ms, random = Math.random) => Math.round(ms * (0.5 + random() / 2));

/**
 * HTTPS_PROXY (or https_proxy, then the http ones) as relayFetch's proxy: a server whose network lets it out only through
 * a proxy still reaches the relay. NO_PROXY lists hosts that go direct
 */
export function envProxy(env = process.env) {
  const value = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!value) return null;
  let url;
  try { url = new URL(value.includes("://") ? value : `http://${value}`); } catch { return null; }
  if (url.protocol !== "http:") return null;
  const proxy = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 80, ...(url.username ? { auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` } : {}) };
  const skip = String(env.NO_PROXY || env.no_proxy || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return (target) => (skip.some((item) => item === "*" || target.hostname === item.replace(/^\./, "") || target.hostname.endsWith(item.startsWith(".") ? item : `.${item}`)) ? null : proxy);
}

/** the agent's standby read on the relay: as long as the node allows (55 s), the next one 4 s before it ends */
export const STANDBY_WAIT_S = 55;
const STANDBY_AHEAD_MS = 51_000;

export function createTunnelAgent({ base, id, key: keyText, token, origin = null, server = SERVER, fetchImpl: given, log = (line) => console.error(line), stallMs = STREAM_STALL_MS, egress: egressOptions = null, update: updateOptions = null, waitS = STANDBY_WAIT_S, aheadMs = STANDBY_AHEAD_MS, othersUsedAt = () => 0 }) {
  const context = { id, origin };
  // the app's last use of this link: anything but liveness, the handshake and the update op itself
  let lastUse = Date.now();
  const used = (frame) => { if (frame.t !== "egress" && !(frame.t === "ctl" && ["ping", "hello", "update"].includes(frame.op))) lastUse = Date.now(); };
  const fetchImpl = given ?? relayFetch({ proxy: envProxy() });
  const stream = streamChoice();
  const key = Buffer.from(keyText, "base64url");
  const guard = frameGuard();
  let stopped = false;
  let terminal = "stopped";
  let successfulPosts = 0, pollRetry = null;
  // when the link service last answered, and last said it is full: the node watch moves the tunnel on either (tunnel())
  let lastOkAt = Date.now(), busyAt = null;
  const abort = new AbortController();

  function stop(reason = "stopped") {
    if (stopped) return;
    stopped = true;
    terminal = reason;
    abort.abort();
    void egress?.stop();
    updater?.stop();
    hub.stop();
    if (!given) fetchImpl.close();
    serving.destroyAll();
  }

  const wait = (ms) => delay(ms, undefined, { signal: abort.signal }).catch(() => {});

  const epoch = Array.from(randomBytes(12), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31]).join("");
  let ordered = false;
  // the egress lane's posts carry no sequence: they never wait in the relay behind the main queue's held posts
  const post = async (frames, at, lane = false) => {
    let fullSince = null;
    for (let attempt = 0; !stopped; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/v1/tunnels/${id}/to-app`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(lane ? { frames, lane: true } : { frames, epoch, seq: at }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]) });
        // read, not cancelled: a cancelled body closes the socket the next post would reuse
        const said = await response.text().catch(() => "");
        if (response.ok && !ordered && !lane) ordered = /"ordered":true/.test(said);
        if (response.ok) { successfulPosts += 1; lastOkAt = Date.now(); pollRetry?.abort(); return true; }
        if (response.status === 404) { stop("unlinked"); return false; }
        if (response.status === 503 && /"relay_busy"/.test(said)) busyAt = Date.now();
        // the relay holds later posts for this one, or the app reads a moment behind: soon, not after a growing backoff
        if (response.status === 429 && /"queue_full"/.test(said) && Date.now() - (fullSince ??= Date.now()) < 10_000) { await wait(spread(400)); continue; }
      } catch { /* retried below */ }
      if (stopped) break;
      await wait(spread(Math.min(5000, 200 * 2 ** attempt)));
    }
    return false;
  };
  // over http/2 what arrives in one turn goes in one post at once, and more gather while posts are out
  const outbox = createOutbox({ seal: (r, bytes) => sealBytes(key, id, "to-app", r, bytes), post, delayMs: () => (fetchImpl.multiplexed?.() ? 0 : H1_POST_DELAY_MS), signal: abort.signal, parallel: () => (ordered ? fetchImpl.postsInFlight?.() ?? POSTS_IN_FLIGHT : 1), onError: () => { log("link: reply queue failed; restarting the tunnel"); stop(); } });
  const emit = (frame) => { if (!stopped) outbox.push(sealFrame(key, id, "to-app", frame), frame.r); };
  const serving = createServing({
    server, stopped: () => stopped, context,
    sink: { push: emit, bytes: outbox.bytes, onDrain: outbox.onDrain, discard: outbox.discard },
  });
  // egress over the relay: its own queue and posts, so a bot's tls handshake never waits behind a batch of desktop frames
  const lane = createOutbox({ seal: (r, bytes) => sealBytes(key, id, "to-app", r, bytes), post: (frames, at) => post(frames, at, true), delayMs: 0, signal: abort.signal, onError: () => log("link: an egress post failed") });
  const laneSend = (frame) => { if (stopped) return; if (frame.t === "cancel") lane.discard(frame.r); lane.push(sealFrame(key, id, "to-app", frame), frame.r); };
  const egress = egressOptions ? createEgressProxy({ send: laneSend, bytes: (r, chunk) => lane.bytes(r, chunk), queued: () => lane.size, onDrain: (resume) => lane.onDrain(resume), path: () => hub.best(), log, ...egressOptions }) : null;
  const hub = createDirectHub({ id, key: keyText, server, guard, egress, log, context, onFrame: used });
  context.hub = hub;
  const handle = (frame) => { used(frame); return egress?.handle(frame) ? undefined : serving.handle(frame); };
  const idle = () => Date.now() - Math.max(lastUse, othersUsedAt()) >= UPDATE_IDLE_MS && (egress?.stats().active ?? 0) === 0;
  const updater = updateOptions ? createUpdater({ base, idle, apply: () => stop("update"), log, ...updateOptions }) : null;
  if (updater) context.updater = updater;

  let failures = 0;
  async function run() {
    let ahead = null;
    failures = 0;
    const unwarm = given ? () => {} : fetchImpl.warm(base);
    void egress?.start();
    updater?.start();
    // what the app had open through a tunnel process that ended died with it: the app ends those at once (an older app
    // ignores this)
    emit({ t: "boot", r: "" });
    while (!stopped) {
      const postsBefore = successfulPosts;
      const next = ahead;
      ahead = null;
      const streaming = next !== null || stream.wanted();
      const stall = new AbortController();
      let heard = false;
      let stallTimer = null, aheadTimer = null;
      const armStall = () => { if (streaming && !stallTimer) stallTimer = setTimeout(() => { if (!heard) stall.abort(); }, stallMs); };
      if (!next && !fetchImpl.connectAware) armStall();
      const read = (signal, onConnected) => fetchImpl(`${base}/v1/tunnels/${id}/to-vps?wait=${waitS}${streaming ? "&stream=1" : ""}`, { headers: { authorization: `Bearer ${token}` }, signal, onConnected });
      // no read may hold the loop longer than this, whatever the connection under it does
      let hangTimer = null, beatStop = () => {};
      const hung = new Promise((_resolve, reject) => { hangTimer = setTimeout(() => { log("link: a read hung; starting over on a fresh connection"); fetchImpl.reset?.(); reject(new Error("a read hung")); }, waitS * 1000 + READ_HANG_MS); });
      hung.catch(() => {});
      try {
        const response = await Promise.race([next ?? read(AbortSignal.any([abort.signal, stall.signal, AbortSignal.timeout(waitS * 1000 + 15_000)]), armStall), hung]);
        if (streaming) aheadTimer = setTimeout(() => { ahead = read(AbortSignal.any([abort.signal, AbortSignal.timeout(aheadMs + 40_000)])); ahead.catch(() => {}); }, aheadMs);
        if (response.status === 404) {
          log("link: this server was unlinked in the app; the tunnel stops");
          stop("unlinked");
          unwarm();
          return "unlinked";
        }
        if (!response.ok) throw new Error(`link service answered ${response.status}`);
        lastOkAt = Date.now();
        const beat = beatWatch(response, () => { log("link: the streamed read went silent; reconnecting"); fetchImpl.reset?.(); });
        beatStop = beat.stop;
        await Promise.race([readFrameBatches(response, (frames) => {
          beat.heard();
          heard = true;
          failures = 0;
          lastOkAt = Date.now();
          for (const sealed of frames) {
            let frame = null;
            try { frame = openFrame(key, id, "to-vps", sealed, guard); } catch { log("link: dropped a frame that did not open"); }
            if (frame) void handle(frame);
          }
        }), hung, beat.silent]);
      } catch (error) {
        if (stopped) break;
        if (stall.signal.aborted && !heard) {
          stream.stalled();
          log("link: the link service's streamed requests were held back; polling instead");
          continue;
        }
        failures += 1;
        if (failures === 1 || failures % 20 === 0) log(`link: tunnel retrying (${error?.message ?? error})`);
        if (postsBefore === successfulPosts) {
          pollRetry = new AbortController();
          await delay(spread(Math.min(15_000, 500 * 2 ** Math.min(failures, 5))), undefined, { signal: AbortSignal.any([abort.signal, pollRetry.signal]) }).catch(() => {});
          pollRetry = null;
        }
      } finally { clearTimeout(stallTimer); clearTimeout(aheadTimer); clearTimeout(hangTimer); beatStop(); }
    }
    unwarm();
    return terminal;
  }
  return { run, stop, egress, direct: hub, updater, lastOkAt: () => lastOkAt, busyAt: () => busyAt, failures: () => failures };
}

export function harnessSync(server = SERVER) {
  return ({ base, tunnel, pub, origin = null, spki = null, applied, failed, wait, signal }) => new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ base, tunnel, pub, origin, spki, applied, failed, wait }));
    const req = httpRequest({ ...server, method: "POST", path: "/api/mobile/relay/sync", headers: withLegacyHeaders({ "x-dusk-cli": "1", "content-type": "application/json", "content-length": String(payload.length) }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout((wait + 15) * 1000)]) }, (res) => {
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

async function readChannelBatches(response, onBatch) {
  if (!/^application\/x-ndjson\b/i.test(response.headers.get("content-type") ?? "")) {
    const { batches = [] } = await response.json();
    onBatch({ frames: [] });
    for (const batch of batches) onBatch(batch);
    return;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let at;
    while ((at = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, at);
      text = text.slice(at + 1);
      if (line) onBatch(JSON.parse(line));
    }
  }
  if (text.trim()) onBatch(JSON.parse(text));
}

const PHONES_AGAIN_MS = 30_000;

/** Runs the phone hub for as long as the tunnel does: a hub the relay refused (a 404 while the tunnel still works) is
 * made again after `againMs`, so phones are not off until the agent next restarts. */
export function keepHubRunning(make, { againMs = PHONES_AGAIN_MS, log = () => {} } = {}) {
  let stopped = false, hub = null, pause = null;
  const done = (async () => {
    while (!stopped) {
      hub = make();
      await hub.run();
      if (stopped) return;
      log("link: the phone relay stopped while the tunnel runs; starting it again shortly");
      await new Promise((resolve) => { pause = resolve; setTimeout(resolve, againMs).unref?.(); });
    }
  })();
  return { done, usedAt: () => hub?.usedAt?.() ?? 0, stop() { stopped = true; hub?.stop(); pause?.(); } };
}

export function createPhoneHub({ base, id, token, keys, server = SERVER, sync = harnessSync(server), origin = null, spki = null, where = null, proxy = envProxy(), fetchImpl: given, log = (line) => console.error(line), waitS = 25, aheadMs = STREAM_AHEAD_MS }) {
  const fetchImpl = given ?? relayFetch({ proxy }), stream = streamChoice(), startedAt = relayNow();
  const abort = new AbortController(), channels = new Map();
  let usedAt = 0;
  // a channel the relay dropped and the sync brought back keeps its replay guard, or the relay could replay its frames
  const guards = new Map();
  const guardFor = (cid, key) => {
    const t = Date.now();
    for (const [one, kept] of guards) if (!channels.has(one) && t - kept.at > 2 * FRAME_SKEW_MS) guards.delete(one);
    const known = guards.get(cid);
    if (known && known.key.equals(key)) { known.at = t; return known.guard; }
    const guard = frameGuard();
    guards.set(cid, { key, guard, at: t });
    return guard;
  };
  const route = `${base}/v1/tunnels/${id}/channels`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let stopped = false, successfulPosts = 0, pollRetry = null;
  const wait = (ms, signal = abort.signal) => delay(ms, undefined, { signal }).catch(() => {});
  function drop(cid) {
    const channel = channels.get(cid);
    if (!channel) return;
    channels.delete(cid);
    const kept = guards.get(cid);
    if (kept) kept.at = Date.now();
    channel.abort.abort();
    channel.serving?.destroyAll();
    for (const session of channel.direct ?? []) session.stop();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    abort.abort();
    for (const cid of channels.keys()) drop(cid);
    if (!given) fetchImpl.close();
  }
  function serving(channel) {
    if (channel.serving) return channel.serving;
    const { key, id: cid, abort: closed } = channel;
    const epoch = Array.from(randomBytes(12), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31]).join("");
    let ordered = false;
    const post = async (frames, at) => {
      for (let attempt = 0; !closed.signal.aborted; attempt += 1) {
        try {
          const response = await fetchImpl(`${route}/${cid}/to-app`, { method: "POST", headers, body: JSON.stringify({ frames, epoch, seq: at }), signal: AbortSignal.any([closed.signal, AbortSignal.timeout(60_000)]) });
          const said = await response.text().catch(() => "");
          if (response.ok && !ordered) ordered = /"ordered":true/.test(said);
          if (response.ok) { successfulPosts += 1; pollRetry?.abort(); return true; }
          if (response.status === 404) { if (channels.get(cid) === channel) drop(cid); return false; }
        } catch { if (closed.signal.aborted) return false; }
        if (closed.signal.aborted) break;
        await wait(Math.min(5000, 200 * 2 ** Math.min(attempt, 6)), closed.signal);
      }
      return false;
    };
    const outbox = createOutbox({ seal: (r, bytes) => sealBytes(key, cid, "to-app", r, bytes), post, delayMs: () => (fetchImpl.multiplexed?.() ? 0 : H1_POST_DELAY_MS), signal: closed.signal, parallel: () => (ordered ? fetchImpl.postsInFlight?.() ?? POSTS_IN_FLIGHT : 1), onError: () => { if (channels.get(cid) === channel) drop(cid); } });
    channel.limits = { controls: false, since: startedAt,
      forwardedFor: `198.51.100.${1 + (createHash("sha256").update(cid).digest()[0] % 254)}`,
      allow: channel.kind === "grant" ? (method, path) => (method === "POST" && path === "/api/mobile/redeem") || (method === "GET" && ["/.well-known/duskbot/environment", "/api/health"].includes(fromLegacyPath(path))) : null };
    channel.emit = (frame) => { if (!closed.signal.aborted) outbox.push(sealFrame(key, cid, "to-app", frame), frame.r); };
    channel.serving = createServing({ server, stopped: () => closed.signal.aborted, ...channel.limits,
      sink: { push: channel.emit, bytes: outbox.bytes, onDrain: outbox.onDrain, discard: outbox.discard },
    });
    return channel.serving;
  }
  // ---- the phone's direct path over webrtc (src/mobile/transport/direct.ts is the phone's end) ----
  // a device channel may ask for one control op, "direct-rtc": its offer is answered as the app's is (directRtc), and the
  // data channel is served like any direct connection, but with this channel's key, its replay guard (shared with its
  // relay frames) and its phone limits. every other control op stays refused; a grant channel gets none.
  const PHONE_DIRECT_MAX = 2;
  function phoneDirect(channel) {
    channel.direct ??= new Set();
    return {
      accept(input, output) {
        if (channels.get(channel.id) !== channel || channel.abort.signal.aborted) return null;
        // a phone keeps one peer; a newer one (a network change) replaces the oldest
        for (const old of channel.direct) { if (channel.direct.size < PHONE_DIRECT_MAX) break; channel.direct.delete(old); old.stop(); }
        const session = serveDirect({ input, output, id: channel.id, key: channel.key.toString("base64url"), server, log, guard: channel.guard, context: { id: channel.id }, serving: channel.limits, onFrame: () => { usedAt = Date.now(); } });
        channel.direct.add(session);
        void session.done.then(() => channel.direct.delete(session));
        return session;
      },
    };
  }
  function handle(channel, frame) {
    usedAt = Date.now();
    const served = serving(channel);
    if (frame.t === "ctl" && frame.op === "direct-rtc" && channel.kind === "device") {
      void directRtc(frame.data, { hub: phoneDirect(channel) })
        .then((data) => channel.emit({ t: "ctl", r: frame.r, ok: true, data }), (error) => channel.emit({ t: "ctl", r: frame.r, ok: false, error: error?.message ?? String(error) }));
      return Promise.resolve();
    }
    return served.handle(frame);
  }
  // ---- end of the phone's direct path ----
  async function synchronize() {
    let applied = 0, failed = [], first = true, failures = 0;
    while (!stopped) {
      try {
        const address = where ? await where().catch(() => null) : null;
        if (address) ({ origin, spki } = address.mode === "direct" ? address : { origin: null, spki: null });
        const answer = await sync({ base, tunnel: id, pub: keys.pub, origin, spki, applied, failed, wait: first ? 0 : waitS, signal: abort.signal });
        if (stopped) break;
        first = false;
        const unusable = [];
        let wanted = answer.channels.flatMap((channel) => {
          try { return [{ ...channel, key: channel.kind === "grant" ? Buffer.from(channel.key, "base64url") : sealKeyOf(keys.priv, keys.pub, channel.pub, channel.id) }]; }
          catch { unusable.push(channel.id); return []; }
        });
        const register = () => fetchImpl(route, { method: "PUT", headers, body: JSON.stringify({ channels: wanted.map(({ id, verifier, kind, expiresAt }) => ({ id, verifier, kind, ...(kind === "grant" ? { expiresAt } : {}) })) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(40_000)]) });
        let response = await register();
        const refused = [...unusable];
        // each taken id (still held by a tunnel this computer made before) is left out in turn, so the rest still register
        while (response.status === 409) {
          const conflict = await response.json().catch(() => null);
          if (conflict?.code !== "taken" || !wanted.some((channel) => channel.id === conflict.id)) throw new Error("phone channel registration failed");
          refused.push(conflict.id);
          wanted = wanted.filter((channel) => channel.id !== conflict.id);
          response = await register();
        }
        if (response.status === 404) { await response.body?.cancel(); stop(); break; }
        await response.text();
        if (response.status !== 200) throw new Error("phone channel registration failed");
        if (stopped) break;
        const live = new Set(wanted.map((channel) => channel.id));
        for (const cid of channels.keys()) if (!live.has(cid)) drop(cid);
        for (const channel of wanted) {
          const old = channels.get(channel.id);
          if (old && (old.kind !== channel.kind || old.verifier !== channel.verifier || !old.key.equals(channel.key))) drop(channel.id);
          if (!channels.has(channel.id)) channels.set(channel.id, { ...channel, guard: guardFor(channel.id, channel.key), abort: new AbortController() });
        }
        applied = answer.rev;
        failed = refused;
        if (failures) log(`link: phone channel sync is back after ${failures} ${failures === 1 ? "retry" : "retries"}`);
        failures = 0;
      } catch (error) {
        if (stopped) break;
        if (!failures) log(`link: phone channel sync retrying (${error?.message ?? error})`);
        await wait(Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)));
      }
    }
  }
  async function read() {
    let failures = 0, ahead = null, down = 0;
    while (!stopped) {
      const postsBefore = successfulPosts, next = ahead;
      ahead = null;
      const streaming = next !== null || stream.wanted(), stall = new AbortController();
      let heard = false, stallTimer = null, aheadTimer = null, beatStop = () => {};
      const armStall = () => { if (streaming && !stallTimer) stallTimer = setTimeout(() => { if (!heard) stall.abort(); }, STREAM_STALL_MS); };
      if (!next && !fetchImpl.connectAware) armStall();
      const get = (signal, onConnected) => fetchImpl(`${route}/to-vps?wait=${waitS}${streaming ? "&stream=1" : ""}`, { headers: { authorization: headers.authorization }, signal, onConnected });
      try {
        const response = await (next ?? get(AbortSignal.any([abort.signal, stall.signal, AbortSignal.timeout(waitS * 1000 + 15_000)]), armStall));
        if (streaming) aheadTimer = setTimeout(() => { ahead = get(AbortSignal.any([abort.signal, AbortSignal.timeout(aheadMs + 40_000)])); ahead.catch(() => {}); }, aheadMs);
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 404) { stop(); break; }
          throw new Error("phone channel read failed");
        }
        if (down) { log(`link: phone channel read is back after ${down} ${down === 1 ? "retry" : "retries"}`); down = 0; }
        const beat = beatWatch(response, () => { log("link: the phone channel read went silent; reconnecting"); fetchImpl.reset?.(); });
        beatStop = beat.stop;
        await Promise.race([readChannelBatches(response, ({ channel: cid, frames = [] }) => {
          beat.heard();
          heard = true;
          failures = 0;
          const channel = channels.get(cid);
          if (!channel) return;
          for (const sealed of frames) {
            let frame = null;
            try { frame = openFrame(channel.key, cid, "to-vps", sealed, channel.guard); } catch { log("link: dropped a phone frame that did not open"); }
            if (frame) handle(channel, frame).catch(() => log("link: a phone frame failed"));
          }
        }), beat.silent]);
      } catch {
        if (stopped) break;
        if (stall.signal.aborted && !heard) { stream.stalled(); continue; }
        failures += 1;
        down += 1;
        if (down === 1 || down % 20 === 0) log("link: phone channel read retrying");
        if (postsBefore === successfulPosts) {
          pollRetry = new AbortController();
          await delay(spread(Math.min(15_000, 500 * 2 ** Math.min(failures, 5))), undefined, { signal: AbortSignal.any([abort.signal, pollRetry.signal]) }).catch(() => {});
          pollRetry = null;
        }
      } finally { clearTimeout(stallTimer); clearTimeout(aheadTimer); beatStop(); }
    }
  }
  return {
    async run() {
      const unwarm = given ? () => {} : fetchImpl.warm(base);
      try { await Promise.all([synchronize(), read()]); }
      finally { unwarm(); stop(); }
    },
    stop,
    /** when a phone last sent anything through this hub, relayed or direct */
    usedAt: () => usedAt,
  };
}

/**
 * the direct link's server half, one per connection: frames in on `input`, replies out on `output`. it says hello
 * first (sealed, so the app knows it holds the key), answers pings, and ends with the connection. `egress` takes the
 * app's egress frames; `path` is this connection as a way for egress streams to the app, usable once `onHello` said so.
 */
export function serveDirect({ input, output, id, key: keyText, server = SERVER, log = (line) => console.error(line), idleMs = 20_000, guard = frameGuard(), egress = null, onHello = () => {}, onFrame = () => {}, context = { id }, serving: servingOptions = {} }) {
  const key = Buffer.from(keyText, "base64url");
  let ended = false, heard = false, greeted = false, finish;
  const done = new Promise((resolve) => { finish = (why) => {
    if (ended) return;
    ended = true;
    clearTimeout(idle);
    writer.close();
    serving.destroyAll();
    output.end?.();
    resolve(why);
  }; });
  const writer = createDirectWriter({
    sealFrame: (frame) => sealFrame(key, id, "to-app", frame, true),
    sealBytes: (r, bytes) => sealBytes(key, id, "to-app", r, bytes, true),
    write: (record) => !ended && output.write(record),
  });
  // `servingOptions`: a phone's channel serves with its own limits (no controls, its own remote address)
  const serving = createServing({ server, sink: writer, stopped: () => ended, context, ...servingOptions });
  // nothing that opens within a while: not the app, so this process does not linger
  const idle = setTimeout(() => { if (!heard) finish("idle"); }, idleMs);
  const read = directReader((type, payload) => {
    if (type === REC_ACK && payload.length === 4) { writer.acked(payload.readUInt32BE(0)); return; }
    if (type !== REC_SEALED) return;
    let frame = null;
    try { frame = openFrame(key, id, "to-vps", payload, guard); } catch { log("link direct: dropped a frame that did not open"); }
    if (!frame) return;
    heard = true;
    if (frame.t === "bytes") writer.received(frame.b.length);
    if (frame.t === "ping") { writer.push({ t: "pong", n: frame.n }); return; }
    onFrame(frame);
    if (frame.t === "hello") { if (!greeted) { greeted = true; onHello(session); } return; }
    if (egress?.handle(frame)) return;
    void serving.handle(frame);
  });
  output.on("drain", () => writer.drained());
  output.on("error", () => finish("closed"));
  input.on("data", (chunk) => { if (ended) return; try { read(chunk); } catch (error) { log(`link direct: ${error.message}`); finish("malformed"); } });
  input.on("end", () => finish("closed"));
  input.on("close", () => finish("closed"));
  output.write(DIRECT_MAGIC);
  writer.push({ t: "hello", v: 1, ...agentHello() });
  const session = {
    done, stop: () => finish("stopped"), live: () => !ended && greeted, heard: () => heard,
    path: { send: (frame) => writer.push(frame), bytes: (r, chunk) => writer.bytes(r, chunk, true), queued: () => writer.size, onDrain: (resume) => writer.onDrain(resume) },
  };
  return session;
}

/**
 * every direct connection of this tunnel, served in the tunnel's own process (ssh sessions arrive through
 * `agent.mjs direct`, which only pipes them here), so egress streams can ride the newest one the app said hello on.
 * one replay guard covers them all and the relay.
 */
export function createDirectHub({ id, key, server = SERVER, guard, egress = null, log = () => {}, max = 16, context = { id }, onFrame = () => {} }) {
  const all = new Set();
  const greeted = [];
  return {
    accept(input, output) {
      // full: the oldest connection that never sent a frame the tunnel key opens makes room (anyone may connect on 443)
      if (all.size >= max) {
        const stranger = [...all].find((one) => !one.heard());
        if (!stranger) { input.destroy?.(); output.destroy?.(); return null; }
        stranger.stop();
        all.delete(stranger);
      }
      const session = serveDirect({ input, output, id, key, server, log, guard, egress, context, onFrame, onHello: (one) => greeted.push(one) });
      all.add(session);
      void session.done.then(() => {
        all.delete(session);
        const at = greeted.indexOf(session);
        if (at >= 0) greeted.splice(at, 1);
        egress?.dropPath(session.path);
      });
      return session;
    },
    /** the newest live session's path, or null */
    best() {
      for (let at = greeted.length - 1; at >= 0; at -= 1) if (greeted[at].live()) return greeted[at].path;
      return null;
    },
    get size() { return all.size; },
    stop() { for (const session of Array.from(all)) session.stop(); },
  };
}

/** the cloud relay (apps/cloudflare/link-relay): DUSK_RELAY_URL moves it, `off` turns it off */
export const CLOUD_RELAY_URL = "https://relay.dusk.bot";
export function cloudRelayUrl(env = process.env) {
  const value = (env.DUSK_RELAY_URL ?? "").trim();
  if (value === "off") return null;
  try {
    const url = new URL(value || CLOUD_RELAY_URL);
    return ["https:", "http:"].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}
/** the relay's bearer for a tunnel, from the tunnel key both ends hold: the relay keeps only its sha256 */
export const relayTokenOf = (key, id) => createHmac("sha256", Buffer.from(key, "base64url")).update(`dusk-relay-v1|${id}`).digest("base64url");
export const RELAY_HEARTBEAT_MS = 25_000;
const RELAY_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000, 60_000, 120_000];
/** the relay does not know this tunnel yet (the app registers it): asked again this often */
const RELAY_UNKNOWN_MS = 5 * 60_000;
const RELAY_UNKNOWN_FIRST_MS = 10_000;

/** a websocket handshake to `url` (http(s) origin + path); resolves the raw socket and what came after the 101 */
export function wsConnect(url, { headers = {}, timeoutMs = 15_000, tls: tlsOptions = {} } = {}) {
  const target = new URL(url);
  const secure = target.protocol === "https:" || target.protocol === "wss:";
  const port = Number(target.port) || (secure ? 443 : 80);
  return new Promise((resolve, reject) => {
    const socket = secure ? tlsConnect({ host: target.hostname, port, servername: target.hostname, ALPNProtocols: ["http/1.1"], ...tlsOptions }) : createConnection({ host: target.hostname, port });
    let settled = false, buffered = Buffer.alloc(0);
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(error); };
    const timer = setTimeout(() => fail(Object.assign(new Error("the relay did not answer"), { code: "ETIMEDOUT" })), timeoutMs);
    socket.on("error", fail);
    socket.once("close", () => fail(new Error("the relay closed the connection")));
    const nonce = randomBytes(16).toString("base64");
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15_000);
      socket.write([`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${nonce}`, "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n"));
    });
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) { if (buffered.length > 16 * 1024) fail(new Error("the relay's answer was not a websocket")); return; }
      socket.off("data", onData);
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0])?.[1] ?? 0);
      const accept = lines.slice(1).find((line) => /^sec-websocket-accept:/i.test(line))?.split(":")[1]?.trim();
      if (status !== 101 || accept !== wsAccept(nonce)) { fail(Object.assign(new Error(`the relay answered ${status || "something else"}`), { status })); return; }
      settled = true;
      clearTimeout(timer);
      socket.off("error", fail);
      socket.removeAllListeners("close");
      resolve({ socket, head: buffered.subarray(end + 4) });
    };
    socket.on("data", onData);
  });
}

/**
 * the server's end of the cloud relay: a standing socket the relay tells about each app that arrives, and per app a
 * socket of its own that carries the direct path's byte stream into `hub` (createDirectHub), so the frames, sealing,
 * replay guard and flow control are exactly the direct path's. it reconnects with backoff (a relay deploy drops sockets).
 */
export function createCloudRelay({ url, id, key, hub, log = (line) => console.error(line), connect = wsConnect, heartbeatMs = RELAY_HEARTBEAT_MS, backoff = RELAY_BACKOFF_MS, unknownMs = RELAY_UNKNOWN_MS, unknownFirstMs = RELAY_UNKNOWN_FIRST_MS }) {
  const headers = { authorization: `Bearer ${relayTokenOf(key, id)}` };
  const abort = new AbortController();
  let ctl = null, up = false, sessions = 0;
  async function openSession(sid) {
    try {
      const { socket, head } = await connect(`${url}/v1/t/${id}/vps?s=${sid}`, { headers });
      if (abort.signal.aborted) { socket.destroy(); return; }
      const duplex = wsDuplex(socket, { client: true, head, heartbeatMs });
      duplex.on("error", () => {});
      const session = hub.accept(duplex, duplex);
      if (!session) { duplex.destroy(); return; }
      sessions += 1;
      void session.done.then(() => { sessions -= 1; duplex.destroy(); });
    } catch (error) { log(`link: an app's cloud relay session did not open (${error?.message ?? error})`); }
  }
  async function run() {
    let attempt = 0, unknown = 0, quietUnknown = false;
    while (!abort.signal.aborted) {
      const started = Date.now();
      let wait;
      try {
        const { socket, head } = await connect(`${url}/v1/t/${id}/vps`, { headers });
        if (abort.signal.aborted) { socket.destroy(); break; }
        ctl = wsDuplex(socket, { client: true, head, heartbeatMs, onText: (text) => {
          let said = null;
          try { said = JSON.parse(text); } catch { return; }
          if (said?.t === "open" && /^[a-z2-7]{12}$/.test(said.s ?? "")) void openSession(said.s);
        } });
        ctl.on("error", () => {});
        ctl.resume();
        up = true;
        quietUnknown = false;
        unknown = 0;
        log("link: the cloud relay is connected");
        await new Promise((resolve) => { ctl.once("close", resolve); abort.signal.addEventListener("abort", resolve, { once: true }); });
        up = false;
        ctl = null;
        if (!abort.signal.aborted) log("link: the cloud relay connection closed; connecting again");
      } catch (error) {
        if (error?.status === 404) {
          if (!quietUnknown) log("link: the cloud relay does not know this link yet; the app sets it up");
          quietUnknown = true;
          // the app registers the link moments after linking: ask again soon at first, then rarely
          wait = Math.min(unknownMs, unknownFirstMs * 2 ** unknown++);
        } else if (attempt === 0 || attempt % 10 === 0) log(`link: the cloud relay is not reachable (${error?.message ?? error})`);
      }
      if (Date.now() - started > 60_000) attempt = 0;
      wait ??= backoff[Math.min(attempt, backoff.length - 1)] * (0.75 + Math.random() / 2);
      attempt += 1;
      await delay(wait, undefined, { signal: abort.signal }).catch(() => {});
    }
  }
  return {
    start() { void run(); },
    stop() { abort.abort(); ctl?.destroy(); },
    stats: () => ({ up, sessions }),
  };
}

/** where `agent.mjs direct` finds the tunnel's process: in this account's own private folder */
export const directSocketPath = () => join(configDir(), "direct.sock");

/** the tunnel's end of that socket; null when it could not listen (the direct command then serves in its own process) */
export async function listenDirectSocket(hub, file = directSocketPath(), log = (line) => console.error(line)) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try { unlinkSync(file); } catch { /* none left over */ }
  const listening = createTcpServer((socket) => { socket.on("error", () => {}); hub.accept(socket, socket); });
  try {
    await new Promise((resolve, reject) => { listening.once("error", reject); listening.listen(file, () => resolve()); });
    chmodSync(file, 0o600);
    return listening;
  } catch (error) {
    log(`link: direct sessions stay in their own processes (${error?.code ?? error?.message ?? error})`);
    return null;
  }
}

/**
 * the direct path over https: a websocket on loopback (DUSK_LINK_WSS_PORT, 8797) that this server's https front passes
 * WS_PATH to (caddy in a direct install, or an operator's own reverse proxy). anyone may connect; only frames sealed
 * with the tunnel key are ever opened, as on every other path. null when the port is taken
 */
export async function listenDirectWss(hub, { host = "127.0.0.1", port = Number(process.env.DUSK_LINK_WSS_PORT) || 8797, log = (line) => console.error(line) } = {}) {
  const refuse = (socket) => socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  const listening = createServer((_req, res) => { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); });
  listening.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const nonce = String(req.headers["sec-websocket-key"] ?? "");
    let path = "";
    try { path = new URL(req.url ?? "/", "http://localhost").pathname; } catch { /* not a path */ }
    if (path !== WS_PATH || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || !/^[A-Za-z0-9+/]{22}==$/.test(nonce)) { refuse(socket); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(nonce)}\r\n\r\n`);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
    const duplex = wsDuplex(socket, { client: false, head });
    duplex.on("error", () => {});
    hub.accept(duplex, duplex);
  });
  try {
    await new Promise((resolve, reject) => { listening.once("error", reject); listening.listen(port, host, () => resolve()); });
    return listening;
  } catch (error) {
    log(`link: the direct path over https is off here (${error?.code ?? error?.message ?? error} on ${host}:${port})`);
    return null;
  }
}

/** `agent.mjs direct` hands its connection to the tunnel's process: the exit code, or null when nobody listens there */
export function pipeToTunnel(file, input, output) {
  return new Promise((resolve) => {
    const socket = createConnection(file);
    let piped = false;
    socket.once("error", () => { if (!piped) resolve(null); });
    socket.once("connect", () => {
      piped = true;
      socket.on("error", () => {});
      input.pipe(socket);
      socket.pipe(output);
      socket.once("close", () => resolve(0));
      input.once("end", () => socket.end());
    });
  });
}

async function direct() {
  let saved;
  try { saved = JSON.parse(readFileSync(tunnelFile(), "utf8")); } catch { console.error("link: not linked yet"); return 1; }
  // a socket on the pipe, not process.stdout: on linux a piped stdout writes synchronously and would stall the reads
  const output = new Socket({ fd: 1, readable: false, writable: true });
  const piped = await pipeToTunnel(directSocketPath(), process.stdin, output);
  if (piped !== null) return piped;
  const why = await serveDirect({ input: process.stdin, output, id: saved.id, key: saved.key }).done;
  return why === "closed" || why === "stopped" ? 0 : 1;
}

// ---- link service nodes ----
/**
 * a tunnel that heard nothing from its node this long, or was told the node is full, asks where to go. a healthy idle
 * tunnel hears from its node at least every streamed read (25 s); its peers call a node down after 30 s (PEER_DOWN_MS)
 */
export const NODE_SILENT_MS = 35_000;
/** past a read's own wait, how long it may take before the loop gives up on it */
export const READ_HANG_MS = 45_000;
export const NODE_WATCH_MS = 5_000;
const NODE_ASK_MS = 15_000;
/** reads that fail outright (refused, a 502 from the node's proxy) ask sooner: the server measures every node itself */
const NODE_FAILING_MS = 20_000;
const nodesFile = () => join(configDir(), "nodes.json");
const origin = (value) => { try { const url = new URL(value); return /^https?:$/.test(url.protocol) && url.pathname === "/" ? url.origin : null; } catch { return null; } };

/** the server's round trip to each node's /healthz, the best of three, in ms (missing: no answer) */
export async function measureNodes(list, fetchImpl = fetch) {
  const out = {};
  await Promise.all(list.map(async (node) => {
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      try {
        const response = await fetchImpl(`${node.url}/healthz`, { signal: AbortSignal.timeout(3000) });
        await response.arrayBuffer();
        if (response.ok) best = Math.min(best, performance.now() - started);
      } catch { break; }
    }
    if (Number.isFinite(best)) out[node.id] = Math.round(best);
  }));
  return out;
}

/**
 * asks where this tunnel should live: the node it was linked through first, then every node it learned of before.
 * answers { url, node, nodes } or null when no node answered (the caller keeps the last home)
 */
export async function placeTunnel({ base, id, token, known = [], fetchImpl = fetch, log = () => {} }) {
  const urls = [...new Set([base, ...known.map((node) => node.url)].map(origin).filter(Boolean))];
  let rtt = {};
  if (known.length > 1) rtt = await measureNodes(known.filter((node) => origin(node.url)), fetchImpl).catch(() => ({}));
  for (const url of urls) {
    try {
      const response = await fetchImpl(`${url}/v1/tunnels/${id}/place`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ rtt }), signal: AbortSignal.timeout(10_000) });
      if (response.status === 404 && url === origin(base)) return { unlinked: true };
      if (!response.ok) continue;
      const answer = await response.json();
      const nodes = Array.isArray(answer?.nodes) ? answer.nodes.filter((node) => typeof node?.id === "string" && origin(node.url)).map((node) => ({ id: node.id, url: origin(node.url), region: node.region ?? null })).slice(0, 16) : [];
      const target = origin(answer?.url);
      // one node: nothing to choose, the tunnel stays where it was linked
      if (nodes.length < 2) return null;
      if (!target || !nodes.some((node) => node.url === target)) continue;
      log(`link: this server lives on node ${answer.node} (${answer.reason ?? "placed"})`);
      return { url: target, node: answer.node, nodes };
    } catch { /* the next node */ }
  }
  return null;
}

export const ADDRESS_EVERY_MS = 30_000;
/**
 * keeps this server's address in the link service directory, sealed with the tunnel key (only the app opens it): an app
 * that cannot reach the server any other way (a quick tunnel that came back under a new name while the relay path
 * failed) still learns where it is from any node. published on start and whenever it changes
 */
export function createAddressBook({ base, id, key: keyText, token, read = currentAddress, fetchImpl = fetch, everyMs = ADDRESS_EVERY_MS, now = relayNow }) {
  const key = Buffer.from(keyText, "base64url");
  let last = null, timer = null, stopped = false;
  async function publish() {
    const address = await read().catch(() => null);
    if (!address) return false;
    const text = JSON.stringify(address);
    if (text === last) return false;
    const sealed = seal(key, `${id}|address`, Buffer.from(JSON.stringify({ v: 1, address, ts: now() })));
    try {
      const response = await fetchImpl(`${base}/v1/tunnels/${id}/address`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sealed }), signal: AbortSignal.timeout(10_000) });
      await response.arrayBuffer().catch(() => {});
      if (response.ok) { last = text; return true; }
    } catch {}
    return false;
  }
  return {
    publish,
    start() { const tick = () => { if (stopped) return; void publish().finally(() => { if (!stopped) { timer = setTimeout(tick, everyMs); timer.unref?.(); } }); }; tick(); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}

/** whether the tunnel still exists, asked of the node it was linked through: true, false (gone), or null (no answer) */
async function stillLinked({ base, id, token, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(`${base}/v1/tunnels/${id}/node`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    return response.ok ? true : response.status === 404 ? false : null;
  } catch { return null; }
}
// ---- end link service nodes ----

async function tunnel() {
  let saved;
  try { saved = JSON.parse(readFileSync(tunnelFile(), "utf8")); } catch { console.error("link: not linked yet; nothing to do"); return 0; }
  // the installed file hands over to a newer staged release; a staged release (DUSK_LINK_LAUNCHER set) never looks further
  // self-update runs downloaded code as this agent, so it waits for a pinned release key
  const releaseKeys = [...RELEASE_KEYS, ...(process.env.DUSK_LINK_RELEASE_KEYS ?? "").split(",").map((key) => key.trim()).filter(Boolean)];
  const updates = process.env.DUSK_LINK_UPDATES !== "off" && releaseKeys.length > 0;
  if (updates && !process.env.DUSK_LINK_LAUNCHER) {
    const release = stagedRelease({ log: (line) => console.error(line) });
    if (release) return launchRelease(release);
  }
  try { if (refreshDirectKey(saved.id)) console.error("link: the app's direct key now runs this agent"); } catch (error) { console.error(`link: the app's direct key was not refreshed (${error?.message ?? error})`); }
  // the node this tunnel lives on: placed by the link service on every start, the last one kept when none answers.
  // the node it was linked through stays its origin: updates, server builds and "is it really unlinked" ask there
  let cache = null;
  try { cache = JSON.parse(readFileSync(nodesFile(), "utf8")); } catch {}
  const known = Array.isArray(cache?.nodes) ? cache.nodes : [];
  const placed = process.env.DUSK_LINK_NODES === "off" ? null : await placeTunnel({ base: saved.base, id: saved.id, token: saved.token, known, log: (line) => console.error(line) });
  if (placed?.url) { try { writePrivate(nodesFile(), JSON.stringify({ v: 1, home: placed.url, nodes: placed.nodes })); } catch {} }
  const home = placed?.url ?? (origin(cache?.home) && known.some((node) => node.url === cache.home) ? cache.home : saved.base);
  const nodesKnown = placed?.nodes ?? known;
  let phoneHub = null, phoneRun = null;
  const agent = createTunnelAgent({ ...saved, base: home, ...(updates ? { update: { base: saved.base } } : {}), othersUsedAt: () => phoneRun?.usedAt() ?? 0, egress: {
    report: async (state) => { const answer = await local("POST", "/api/computer/egress/agent", state); return answer.status === 200 ? answer.body : null; },
  } });
  if (process.env.DUSK_LINK_PHONES !== "off") {
    const file = join(configDir(), "phone-keys.json");
    let keys = null;
    try { keys = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      // a broken phone key file turns phones off; it must never stop the app's own tunnel
      if (error.code === "ENOENT") { keys = { v: 1, ...x25519Pair() }; writePrivate(file, JSON.stringify(keys)); }
      else console.error("link: phone keys could not be read; phones are off until the file is fixed or removed");
    }
    if (keys && (typeof keys.pub !== "string" || typeof keys.priv !== "string")) { console.error("link: phone keys are not valid; phones are off"); keys = null; }
    if (keys) phoneHub = () => createPhoneHub({ base: home, id: saved.id, token: saved.token, keys, origin: saved.mode === "direct" ? saved.origin : null, spki: null, where: currentAddress, sync: harnessSync(SERVER) });
  }
  const serverUpdates = process.env.DUSK_LINK_SERVER_UPDATES === "off" ? null : createServerUpdater({ base: saved.base, id: saved.id, token: saved.token, log: (line) => console.error(line) });
  serverUpdates?.start();
  const [directSocket, directWs] = await Promise.all([listenDirectSocket(agent.direct), process.env.DUSK_LINK_DIRECT === "off" ? null : listenDirectWss(agent.direct)]);
  // a server from before webrtc fetches node-datachannel for the app's link a minute after start (best effort)
  setTimeout(() => void ensureRtc(), 60_000).unref();
  // the cloudflare backup path to the direct listener, whatever way this server was linked (DUSK_LINK_BACKUP=off: none)
  backupTunnel = directWs && process.env.DUSK_LINK_BACKUP !== "off" ? createBackupTunnel({ wssPort: Number(process.env.DUSK_LINK_WSS_PORT) || 8797, log: (line) => console.error(line) }) : null;
  backupTunnel?.start();
  process.on("exit", () => backupTunnel?.stop());
  // the sealed address in the directory carries the backup too, so an app whose relay path fails still finds it
  const addressBook = createAddressBook({ base: home, id: saved.id, key: saved.key, token: saved.token, read: async () => {
    const address = await currentAddress().catch(() => null), backup = backupTunnel?.url() ?? null;
    if (!address && !backup) return null;
    return { ...(address ?? { mode: "relay", via: "relay", origin: null, spki: null }), ...(backup ? { backup } : {}) };
  } });
  addressBook.start();
  const relayUrl = cloudRelayUrl();
  const cloud = relayUrl ? createCloudRelay({ url: relayUrl, id: saved.id, key: saved.key, hub: agent.direct }) : null;
  cloud?.start();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { backupTunnel?.stop(); addressBook.stop(); cloud?.stop(); serverUpdates?.stop(); phoneRun?.stop(); agent.stop(); directSocket?.close(); directWs?.close(); process.exit(0); });
  // the node watch: silent, or full, and another node is known: ask where to go (at most every NODE_ASK_MS); a
  // different answer restarts the agent (systemd brings it back in seconds) so everything reconnects there at once
  let moving = false, askedAt = 0;
  const watch = nodesKnown.length > 1 ? setInterval(async () => {
    const quiet = Date.now() - agent.lastOkAt();
    const silent = quiet > NODE_SILENT_MS || (agent.failures() >= 3 && quiet > NODE_FAILING_MS), busy = agent.busyAt() !== null && Date.now() - agent.busyAt() < NODE_WATCH_MS * 2;
    if (moving || (!silent && !busy) || Date.now() - askedAt < NODE_ASK_MS) return;
    moving = true;
    askedAt = Date.now();
    try {
      const next = await placeTunnel({ base: saved.base, id: saved.id, token: saved.token, known: nodesKnown, log: (line) => console.error(line) });
      if (next?.url && next.url !== home) {
        try { writePrivate(nodesFile(), JSON.stringify({ v: 1, home: next.url, nodes: next.nodes })); } catch {}
        console.error(`link: moving to node ${next.node} (${silent ? "this node went quiet" : "this node is full"})`);
        process.exit(75);
      }
    } finally { moving = false; }
  }, NODE_WATCH_MS) : null;
  watch?.unref();
  phoneRun = phoneHub ? keepHubRunning(phoneHub, { log: (line) => console.error(line) }) : null;
  let how = await agent.run();
  phoneRun?.stop();
  // a node it moved to says unlinked: only the node it was linked through decides that
  if (how === "unlinked" && origin(home) !== origin(saved.base)) {
    const linked = await stillLinked({ base: saved.base, id: saved.id, token: saved.token });
    if (linked !== false) {
      try { writePrivate(nodesFile(), JSON.stringify({ v: 1, home: saved.base, nodes: nodesKnown })); } catch {}
      console.error("link: the node it moved to does not know this server; trying again");
      process.exit(75);
    }
  }
  clearInterval(watch);
  backupTunnel?.stop();
  addressBook.stop();
  cloud?.stop();
  phoneRun?.stop();
  await phoneRun?.done;
  // unlinked: stay quiet instead of letting systemd restart a tunnel that no longer exists
  if (how === "unlinked") {
    directSocket?.close();
    directWs?.close();
    try { setDirectKey(saved.id, null); } catch (error) { console.error(`link: the app's ssh key could not be removed (${error?.message ?? error})`); }
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  }
  return 0;
}

async function selftest() {
  console.log(JSON.stringify({ version: AGENT_VERSION, protocol: LINK_PROTOCOL }));
  return 0;
}

const main = { probe, link, tunnel, direct, selftest };
const runAs = (file) => { try { return realpathSync(file); } catch { return file; } };
if (process.argv[1] && runAs(fileURLToPath(import.meta.url)) === runAs(process.argv[1])) {
  const command = main[process.argv[2]];
  if (!command) { console.error("usage: node agent.mjs probe|link|tunnel|direct|selftest"); process.exit(2); }
  command().then((code) => process.exit(code ?? 0), (error) => { console.error(error?.message ?? String(error)); process.exit(1); });
}
