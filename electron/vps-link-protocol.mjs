// the app's half of linking a vps (apps/link-service/agent.mjs is the server's half; the crypto block is the same in both and
// a test proves they interoperate). the link service only ever sees verifiers, public keys and sealed blobs.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { Agent as HttpAgent, STATUS_CODES, createServer, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as http2Connect, constants as h2Constants } from "node:http2";
import { connect as netConnect, isIP } from "node:net";
import { lookup as lookupDns, setDefaultResultOrder } from "node:dns";
import { Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";

import { createDirectLink } from "./vps-link-direct.mjs";
import { clampMss } from "./tcp-clamp.mjs";
import { TRAIL_HEADER, shortHash, trail, validTrailId } from "./trail.mjs";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
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
    if (fixed > 0) return sleep(fixed, undefined, { signal });
    return outstanding ? sleep(Math.min(GATHER_MAX_MS, GATHER_MS * outstanding), undefined, { signal }) : new Promise((resolve) => setImmediate(resolve));
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

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded"]);

export function randomB32(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += B32[bytes[i] & 31];
  return out;
}

// ---- crypto shared with apps/link-service/agent.mjs ----
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

// ---- relay transport shared with apps/link-service/agent.mjs ----
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

/** what the app keeps to start a link: the secret goes in the command, the private key never leaves this computer */
export function newLinkKeys() {
  const secret = randomB32(26);
  const pair = x25519Pair();
  return { secret, ...pair, verifier: sha256hex(vpsTokenOf(secret)) };
}

const UNPINNED_VIAS = new Set(["tailscale", "cloudflare"]);

/** the sealed result, opened and checked; throws on anything that is not exactly what a vps agent makes */
export function openResult({ id, priv, pub, vpsPub, sealed }) {
  const value = JSON.parse(open(sealKeyOf(priv, pub, vpsPub, id), id, sealed).toString("utf8"));
  const ok = value && value.v === 1 && (value.mode === "relay" || value.mode === "direct")
    && typeof value.pairing?.code === "string" && /^[A-Z0-9-]{4,40}$/.test(value.pairing.code)
    && typeof value.tunnel?.key === "string" && typeof value.tunnel?.token === "string" && value.tunnel.id === id
    && (value.mode === "relay" || (typeof value.origin === "string" && /^https:\/\/[a-z0-9.-]+$/.test(value.origin)
      // tailscale and cloudflare hold their own certificates and change their keys: those addresses alone go unpinned
      && (typeof value.spki === "string" || (value.spki === null && UNPINNED_VIAS.has(value.via)))));
  if (!ok) throw new Error("The server's answer was not one this app understands. Update Metal and try again.");
  return { ...value, name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 60) : "My server" };
}

export function createRelayClient({ base, fetch: fetchImpl = fetch }) {
  async function call(method, route, token, body, signal) {
    const response = await fetchImpl(`${base}${route}`, {
      method,
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(40_000),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(typeof parsed?.error === "string" ? parsed.error : `The link service answered ${response.status}.`), { status: response.status, code: parsed?.code });
    return parsed;
  }
  return {
    base,
    create: (body, signal) => call("POST", "/v1/sessions", null, body, signal),
    watch: (id, watch, after, signal) => call("GET", `/v1/sessions/${id}/events?after=${after}&wait=25`, watch, undefined, signal ?? AbortSignal.timeout(40_000)),
    cancel: (id, watch) => call("DELETE", `/v1/sessions/${id}`, watch),
    short: (id, watch, secret, signal) => call("POST", `/v1/sessions/${id}/short`, watch, { secret }, signal),
    forget: (id, token) => call("DELETE", `/v1/tunnels/${id}`, token),
    status: (id, token) => call("GET", `/v1/tunnels/${id}/status`, token),
  };
}

/** a relay stream still open this long after the direct path came up moves over (an event stream reconnects by itself) */
const MOVE_AFTER_MS = 3000;
/**
 * a websocket (the live desktop) opened while the direct path is dialling waits this long for it before taking the relay;
 * once a dial failed on this network it waits for nothing
 */
export const UPGRADE_HOLD_MS = 700;
/** a request over the relay with no answer at all this long sends the app to ask which node its server reads on */
const SILENT_ASK_MS = 4000;
/** an app tells its link service its way every minute when it changed, and every 10 minutes anyway */
const REPORT_EVERY_MS = 60_000;
const REPORT_AGAIN_MS = 10 * 60_000;
/** a chat message sent (a bot's or a room's) */
const CHAT_SEND = /^\/api\/(?:bots|groups)\/[^/?]+\/messages(?:\?|$)/;
/** past a read's own wait, how long it may take before the poll gives up on it */
const READ_HANG_MS = 45_000;
/** how long a post waits out a relay that says the server is behind before it gives up */
const BEHIND_PATIENCE_MS = 60_000;
/** how many times one download picks up again after the relay lost part of it */
const MAX_RESUMES = 5;
/** a request sent this recently when the relay moves may still be on its way there, so it is left to finish */
const RESEND_AFTER_MS = 2000;
/** a stream's sender says how many bytes it sent so far after this many more, or this long, so a gap shows */
export const MARK_BYTES = 256 * 1024;
/** a retry wait between half and all of `ms`: apps that lost the same node do not all come back in the same second */
const spread = (ms) => Math.round(ms * (0.5 + Math.random() / 2));
export const MARK_MS = 2000;

// the same for every other request this process makes (the relay client, pairing, the vps checks)
setDefaultResultOrder("ipv4first");

/** the relay's tcp socket, with what this computer sends kept under a lossy vpn's real mtu once it connects */
function clampedDial(host, port) {
  // ipv4 first: a nat64 network (64:ff9b::/96) can hand back an ipv6 route that connects and then stalls, seen on jio
  const socket = netConnect({ host, port, autoSelectFamily: true, lookup: (name, options, done) => lookupDns(name, { ...options, all: true, order: "ipv4first" }, done) });
  socket.once("connect", () => void clampMss(socket));
  return socket;
}

/**
 * the app's end of the tunnel: a loopback http server at http://vps-<id>.localhost:<port> whose requests travel to the
 * vps sealed, and whose replies stream back the same way. only that host name is served. two paths carry the frames:
 * the relay, always there, and the direct path (vps-link-direct.mjs) once `useDirect` gave it a way to connect. each
 * request takes the best path when it starts and keeps it; a lost direct path sends a request that had no answer yet
 * and can safely be sent again over the relay, and fails the rest.
 * `egress`: makes this app's end of "route traffic through this computer" (vps-link-egress.mjs createEgressEndpoint) from
 * the tunnel's stream api; without it the vps's stream requests go unanswered. on the relay it has a queue and posts of
 * its own; while the direct path is up the agent dials over that instead, in the direct writer's lane.
 */
/** Answered by the app's own proxy, never sent to the server: { iceServers } for src/lib/screen-direct.ts. */
export const SCREEN_ICE_PATH = "/__dusk/screen-ice";

async function answerScreenIce(res, screenIce, link) {
  const iceServers = await Promise.resolve(screenIce?.()).catch(() => null);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  // `link`: whether this whole link already goes direct (ssh, 443 or webrtc), so the page's own screen peer is not needed
  res.end(JSON.stringify({ iceServers: Array.isArray(iceServers) ? iceServers : [], link }));
}

/**
 * the proxy chromium would use for `url` (`session.resolveProxy`'s answer: "PROXY host:port; DIRECT"), as { host, port }
 * for an http proxy that tunnels with CONNECT; null for DIRECT and for kinds this code does not speak (HTTPS, SOCKS)
 */
export function proxyFromPac(answer) {
  for (const part of String(answer ?? "").split(";").map((item) => item.trim())) {
    if (/^DIRECT$/i.test(part)) return null;
    const match = /^PROXY\s+\[?([^\]\s]+?)\]?:(\d{1,5})$/i.exec(part);
    if (match) return { host: match[1], port: Number(match[2]) };
  }
  return null;
}

export function createTunnelProxy({ base, id, route: givenRoute = null, key: keyText, token, port = 0, fetch: given, log = () => {}, replyTimeoutMs = 90_000, stallMs = STREAM_STALL_MS, direct: directSpec = null, directFactory = createDirectLink, egress: makeEgress = null, waitS = 25, aheadMs = STREAM_AHEAD_MS, hello = {}, follow = false, screenIce = null, proxy = null, report = false, reportMs = { first: 20_000, every: REPORT_EVERY_MS } }) {
  const fetchImpl = given ?? relayFetch({ dial: clampedDial, proxy });
  const stream = streamChoice();
  let unwarm = () => {};
  const key = Buffer.from(keyText, "base64url");
  const guard = frameGuard();
  const host = `vps-${id}.localhost`;
  const waiting = new Map();
  let server = null, server6 = null, polling = false, closed = false, listeningPort = port;
  let successfulPosts = 0, pollRetry = null, pollNudge = null;
  const abort = new AbortController();
  // the link service may run on several nodes: the server's tunnel lives on one of them, and the node it was linked
  // through (`base`) says which (GET /v1/tunnels/<id>/node, any node answers it). a node that stops answering, says it
  // is full (relay_busy) or does not know the tunnel sends the app to ask again
  let node = base, route = givenRoute ?? `${base}/v1/tunnels/${id}`, known = [], locating = null, lastLocate = 0, addressSeen = 0;
  const originOf = (value) => { try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin : null; } catch { return null; } };
  /** a node's answer about where the tunnel lives (GET .../node, or a 409 "moved"): { url, node, up } or null */
  function readWhere(body) {
    // one node: nothing to follow, the relay stays where it was linked
    if (!body || !Array.isArray(body.nodes) || body.nodes.length < 2) return null;
    known = body.nodes.map((item) => ({ id: item?.id, url: originOf(item?.url) })).filter((item) => typeof item.id === "string" && item.url).slice(0, 16);
    const url = originOf(body.url);
    return url && (url === originOf(base) || known.some((item) => item.url === url)) ? { url, node: body.node, up: body.up !== false } : null;
  }
  async function askWhere(at) {
    const response = await fetchImpl(`${at}/v1/tunnels/${id}/node`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]) });
    const body = await response.json().catch(() => null);
    if (response.status === 404) return { gone: true };
    if (!response.ok || !body) return null;
    return readWhere(body);
  }
  function moveTo(answer) {
    if (!answer || answer.url === node) return false;
    log(`vps link: this server is on node ${answer.node ?? answer.url}; the relay follows it`);
    node = answer.url;
    route = `${node}/v1/tunnels/${id}`;
    if (!given && polling) { unwarm(); unwarm = fetchImpl.warm(node); }
    pollNudge?.abort();
    pollRetry?.abort();
    resend();
    return true;
  }
  /**
   * after a move, what the old node took and nobody answered may never arrive: a GET goes again to the new node, and
   * anything else that waited a while fails now instead of after the reply timeout (a POST is never sent twice)
   */
  function resend() {
    const cutoff = Date.now() - RESEND_AFTER_MS;
    for (const [r, at] of Array.from(unanswered)) {
      const entry = waiting.get(r);
      if (!entry || entry.via !== "relay") { unanswered.delete(r); continue; }
      if (entry.replay?.()) { unanswered.set(r, Date.now()); continue; }
      if (at > cutoff) continue;
      unanswered.delete(r);
      waiting.delete(r);
      entry.fail("The connection to your server changed. Try again.");
    }
  }
  /**
   * a node that is not the tunnel's home refuses with 409 "moved" and where it lives: the relay goes there at once. two
   * nodes whose copies of the directory disagree can send it back and forth; then it waits like any failed request
   */
  let movedAt = 0;
  function movedBy(status, text) {
    if (status !== 409 || !follow || givenRoute || closed) return false;
    let body = null;
    try { body = JSON.parse(text); } catch { return false; }
    if (body?.code !== "moved" || Date.now() - movedAt < 1000) return false;
    const moved = moveTo(readWhere(body));
    if (moved) movedAt = Date.now();
    return moved;
  }
  /** where the tunnel lives now: moves the relay there when it changed; { gone: true } when the origin no longer knows it */
  function locate({ force = false } = {}) {
    if (!follow || givenRoute || closed) return Promise.resolve(null);
    if (locating) return locating;
    if (!force && Date.now() - lastLocate < 10_000) return Promise.resolve(null);
    lastLocate = Date.now();
    locating = (async () => {
      for (const at of [...new Set([originOf(base), ...known.map((item) => item.url)])].filter(Boolean)) {
        let answer = null;
        try { answer = await askWhere(at); } catch { continue; }
        if (answer?.gone) { if (at === originOf(base)) return answer; continue; }
        if (!answer) continue;
        return { moved: moveTo(answer), url: node };
      }
      return null;
    })().finally(() => { locating = null; });
    return locating;
  }
  /** a 404 from a node the tunnel moved to is not "unlinked" until the node it was linked through says so too */
  async function reallyGone() {
    if (!follow || givenRoute || originOf(node) === originOf(base)) return true;
    const answer = await locate({ force: true }).catch(() => null);
    return answer?.gone === true;
  }

  // a post given up leaves a hole in the numbering the relay would wait out before every later post: a new epoch
  // starts the order afresh where the outbox is (the relay takes the first post of an unknown epoch as its start)
  let epoch = randomB32(12);
  let ordered = false;
  // the egress lane's posts carry no sequence: they never wait in the relay behind the main queue's held posts
  async function post(frames, at, lane = false) {
    let busy = false;
    // a post keeps the epoch it was numbered in; one still out when a new epoch starts lands in the old one, retired
    const started = Date.now(), mine = epoch;
    for (let attempt = 0; !closed; attempt += 1) {
      // its epoch was given up (what it carried was failed with it): one arriving late would make the relay switch back
      // to that epoch and drop every post of the new one as retired
      if (!lane && mine !== epoch) return true;
      try {
        const response = await fetchImpl(`${route}/to-vps`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(lane ? { frames, lane: true } : { frames, epoch: mine, seq: at }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]) });
        // read, not cancelled: a cancelled body closes the socket the next post would reuse
        const said = await response.text().catch(() => "");
        if (response.ok && !ordered && !lane) ordered = /"ordered":true/.test(said);
        if (response.ok) { successfulPosts += 1; pollRetry?.abort(); return true; }
        if (movedBy(response.status, said)) continue;
        // a node it moved to may not know the tunnel yet: that waits and tries again like any failed post
        if (response.status === 404 && await reallyGone()) { closed = true; abort.abort(); fail("This server was unlinked."); return false; }
        if (response.status === 429 && /"code":"daily_limit"/.test(said)) { if (!lane) { epoch = randomB32(12); fail(JSON.parse(said).error); } return false; }
        // the server reads slower than this computer sends (a big upload): that is waiting, not failing, for a minute
        if (response.status === 429 && /"code":"queue_full"/.test(said) && Date.now() - started < BEHIND_PATIENCE_MS) attempt = Math.min(attempt, 1);
        else if (response.status === 503 && /"code":"relay_busy"/.test(said)) {
          // full: the server moves to a node with room on its own; follow it, and the direct path carries on meanwhile
          busy = true;
          const where = await locate({ force: attempt === 0 }).catch(() => null);
          if (where?.moved) continue;
        } else if (attempt >= 1 && response.status !== 404) void locate();
      } catch { if (closed) return false; if (attempt >= 1) void locate(); }
      if (attempt >= 6) {
        if (!lane) epoch = randomB32(12);
        if (!lane) fail(busy ? "The relay is full right now. Your server will connect another way, or try again in a minute." : "Your server could not be reached just now. It reconnects by itself; try again in a moment.");
        return false;
      }
      await sleep(spread(Math.min(5000, 200 * 2 ** attempt)), undefined, { signal: abort.signal }).catch(() => {});
    }
    return false;
  }
  const outbox = createOutbox({ seal: (r, bytes) => sealBytes(key, id, "to-vps", r, bytes), post, delayMs: () => (fetchImpl.multiplexed?.() ? 0 : H1_POST_DELAY_MS), signal: abort.signal, parallel: () => (ordered ? fetchImpl.postsInFlight?.() ?? POSTS_IN_FLIGHT : 1), onError: () => fail("Your server could not be reached just now. It reconnects by itself; try again in a moment.") });
  const relayPath = {
    push: (frame) => { if (frame.t === "cancel") outbox.discard(frame.r); outbox.push(sealFrame(key, id, "to-vps", frame), frame.r); },
    bytes: outbox.bytes, onDrain: outbox.onDrain, discard: outbox.discard,
  };
  let direct = null, moveTimer = null;
  // a stream keeps its path while that connection lasts (a suspect one included); only new requests avoid it
  const pathOf = (r) => (waiting.get(r)?.via === "direct" && direct?.state() === "up" ? direct : relayPath);
  // requests sent over the relay and not answered at all yet: a node that queues them while the server reads elsewhere
  // (an older node, or one whose copy of the directory lags) shows up as silence, so a long one asks where the tunnel is
  const unanswered = new Map();
  // every request on the relay and when it went out, until it ends: a node that restarted lost what it held of them
  const onRelay = new Map();
  const emit = (frame) => {
    const path = pathOf(frame.r);
    if (frame.t === "cancel") { path.discard(frame.r); unanswered.delete(frame.r); onRelay.delete(frame.r); }
    else if (path === relayPath && (frame.t === "req" || frame.t === "ctl")) { unanswered.set(frame.r, Date.now()); onRelay.set(frame.r, Date.now()); }
    path.push(frame);
  };
  /**
   * the node restarted (its boot changed) while these were on it: what it held is gone. an unanswered GET goes again,
   * the rest fail now with a short message (a stream reconnects) instead of hanging or arriving with a hole
   */
  function lostOnRestart(before) {
    for (const [r, at] of Array.from(onRelay)) {
      const entry = waiting.get(r);
      if (!entry || entry.via !== "relay") { onRelay.delete(r); continue; }
      if (at > before) continue;
      if (unanswered.has(r) && entry.replay?.()) { unanswered.set(r, Date.now()); onRelay.set(r, Date.now()); continue; }
      onRelay.delete(r);
      unanswered.delete(r);
      waiting.delete(r);
      emit({ t: "cancel", r });
      entry.fail("The connection to your server dropped. Try again.");
    }
  }
  let silenceTimer = null, silenceAskedAt = 0;
  // the way this app reaches its server now, and when its person last sent a message, told to the link service now and
  // then (`report`): the ops page's split of direct, cloudflare and relay, and how many people chat right now
  let chatAt = null, reportTimer = null;
  const reported = { path: null, at: 0, chatAt: null };
  const pathNow = () => { if (!direct?.ready()) return "relay"; const via = direct.via?.(); return via === "cf" ? "cloudflare" : via === "cloud" ? "relay" : "direct"; };
  async function sendReport() {
    if (closed) return;
    const path = pathNow(), t = Date.now();
    if (path === reported.path && chatAt === reported.chatAt && t - reported.at < REPORT_AGAIN_MS) return;
    try {
      const response = await fetchImpl(`${route}/report`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ path, ...(chatAt ? { chatAgoMs: t - chatAt } : {}) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
      await response.text().catch(() => "");
      // a link service from before these reports: nobody to tell
      if (response.status === 404 || response.status === 405) { clearInterval(reportTimer); return; }
      if (response.ok) Object.assign(reported, { path, at: t, chatAt });
    } catch { /* told next time */ }
  }
  const watchSilence = () => {
    silenceTimer = setInterval(() => {
      const cutoff = Date.now() - SILENT_ASK_MS;
      for (const r of sentCount.keys()) if (!waiting.has(r)) sentCount.delete(r);
      for (const r of onRelay.keys()) if (!waiting.has(r)) onRelay.delete(r);
      for (const [r, at] of unanswered) {
        if (!waiting.has(r)) { unanswered.delete(r); continue; }
        // the regular throttle (10 s) would hold back the first ask after the one at start
        if (at < cutoff) { const force = Date.now() - silenceAskedAt > SILENT_ASK_MS; if (force) silenceAskedAt = Date.now(); void locate({ force }); break; }
      }
    }, 2000);
    silenceTimer.unref?.();
  };
  // what went out per stream, so the agent can tell a body that lost bytes on the way (it ignores marks if it is older)
  const sentCount = new Map();
  const sendBytes = (r, chunk) => {
    let count = sentCount.get(r);
    if (!count) sentCount.set(r, (count = { n: 0, marked: 0, at: Date.now() }));
    count.n += chunk.length;
    const more = pathOf(r).bytes(r, chunk);
    if (count.n - count.marked >= MARK_BYTES || Date.now() - count.at >= MARK_MS) { count.marked = count.n; count.at = Date.now(); emit({ t: "mark", r, n: count.n }); }
    return more;
  };
  const sentOf = (r) => { const n = sentCount.get(r)?.n ?? 0; sentCount.delete(r); return n; };
  const onDrain = (r, resume) => pathOf(r).onDrain(resume);
  /** the path a new request takes */
  const pick = () => (direct?.ready() ? "direct" : "relay");
  function fail(message) {
    for (const entry of waiting.values()) entry.fail(message);
    waiting.clear();
  }
  const lane = createOutbox({ seal: (r, bytes) => sealBytes(key, id, "to-vps", r, bytes), post: (frames, at) => post(frames, at, true), delayMs: 0, signal: abort.signal, onError: () => log("vps link: an egress post failed") });
  const egressDirect = {
    live: () => Boolean(direct?.ready()),
    send: (frame) => direct?.push(frame),
    bytes: (r, chunk) => (direct ? direct.bytes(r, chunk, true) : true),
    queued: () => direct?.queued?.() ?? 0,
    onDrain: (resume) => (direct ? direct.onDrain(resume) : resume()),
  };
  const egress = makeEgress?.({
    send: (frame) => { if (frame.t === "cancel") lane.discard(frame.r); lane.push(sealFrame(key, id, "to-vps", frame), frame.r); },
    bytes: (r, chunk) => lane.bytes(r, chunk), queued: () => lane.size, onDrain: (resume) => lane.onDrain(resume), direct: egressDirect, log,
    // the public address the tunnel's own node sees, asked over the relay's own connection: a bare fetch to the first
    // node timed out for days on a network where the relay itself worked (nat64, a lossy vpn's mtu)
    seenAs: async () => (await (await fetchImpl(`${node}/v1/ip`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) })).json())?.ip,
  }) ?? null;

  /** "direct" as the path a request took, named by how the direct path is connected (ssh, wss, rtc, cf, cloud) */
  function viaName(via) { return via === "direct" ? direct?.via?.() ?? "direct" : via; }

  let trailPath = "relay";
  function directChanged({ state, lost }) {
    const nowPath = state === "up" && direct?.ready() ? direct.via?.() ?? "direct" : "relay";
    if (nowPath !== trailPath && (lost || state === "up")) {
      trail("link.path", { link: shortHash(id), from: trailPath, to: nowPath, reason: lost ? "direct-lost" : "direct-up" });
      trailPath = nowPath;
    }
    if (lost) egress?.pathLost?.("direct");
    if (lost) {
      // what was on the direct path: sent again over the relay when that is safe, failed otherwise
      for (const [r, entry] of Array.from(waiting)) {
        if (entry.via !== "direct") continue;
        if (entry.replay?.()) { entry.via = "relay"; log("vps link: a request moved to the relay"); trail("link.moved", { link: shortHash(id), to: "relay" }); continue; }
        waiting.delete(r);
        entry.fail("The connection to your server changed. Try again.");
      }
    }
    clearTimeout(moveTimer);
    if (state === "up" && direct?.ready()) {
      moveTimer = setTimeout(() => {
        if (!direct?.ready()) return;
        for (const [r, entry] of Array.from(waiting)) if (entry.via === "relay" && entry.movable?.()) { waiting.delete(r); relayPath.push({ t: "cancel", r }); entry.move(); }
      }, MOVE_AFTER_MS);
      moveTimer.unref?.();
    }
  }
  function useDirect(spec) {
    direct?.close();
    direct = null;
    if (!spec || closed) return;
    // a better way that comes back is taken when nothing rides the direct path (createDirectLink's upgrade)
    const idle = () => ![...waiting.values()].some((entry) => entry.via === "direct");
    direct = directFactory({ id, key: keyText, guard, connect: spec.connect, onFrame: (frame) => deliver(frame, "direct"), onChange: directChanged, onFailure: spec.onFailure ?? (() => {}), log, hello, ...(spec.pingMs ? { pingMs: spec.pingMs } : {}), ...(spec.connect?.better ? { better: spec.connect.better, idle } : {}) });
    direct.start();
  }

  function deliver(frame, via = "relay") {
    // the server's tunnel process started (an update, a crash): whatever went through the one before is gone with it
    if (frame.t === "boot" && via === "relay") {
      const startedAt = Date.now() - Math.max(0, relayNow() - (Number(frame.ts) || relayNow()));
      log("vps link: the server's link restarted; what it held is sent again or failed");
      lostOnRestart(startedAt);
      return;
    }
    if (frame.r) unanswered.delete(frame.r);
    if (egress?.handle(frame, via)) return;
    const entry = waiting.get(frame.r);
    if (!entry) return;
    entry.touch();
    // the server counts what it sent (`n` on marks and the end): a reply that lost bytes on the way fails, never ends short
    const short = (n) => {
      if (!Number.isSafeInteger(n) || n === (entry.got ?? 0)) return false;
      waiting.delete(frame.r);
      emit({ t: "cancel", r: frame.r });
      log(`vps link: a reply lost ${n - (entry.got ?? 0)} bytes on the way; it is ended`);
      entry.fail("Part of this reply was lost on the way. Try again.");
      return true;
    };
    if (frame.t === "head") entry.head(frame.status, frame.headers ?? {});
    else if (frame.t === "data") { const bytes = Buffer.from(frame.d ?? "", "base64"); entry.got = (entry.got ?? 0) + bytes.length; entry.data(bytes); }
    else if (frame.t === "bytes") { entry.got = (entry.got ?? 0) + frame.b.length; entry.data(frame.b); }
    else if (frame.t === "mark") short(frame.n);
    else if (frame.t === "end") { onRelay.delete(frame.r); if (short(frame.n)) return; waiting.delete(frame.r); entry.end(); }
    else if (frame.t === "err") { waiting.delete(frame.r); entry.fail(frame.message ?? "The server did not answer."); }
    else if (frame.t === "ctl") { waiting.delete(frame.r); entry.ctl(frame); }
  }

  const nodeBoot = { id: null, node: null, okAt: 0 };
  async function poll() {
    if (polling) return;
    polling = true;
    let failures = 0, ahead = null;
    while (!closed) {
      const postsBefore = successfulPosts;
      const next = ahead;
      ahead = null;
      const streaming = next !== null || stream.wanted();
      const stall = new AbortController();
      let heard = false;
      let stallTimer = null, aheadTimer = null;
      const armStall = () => { if (streaming && !stallTimer) stallTimer = setTimeout(() => { if (!heard) stall.abort(); }, stallMs); };
      if (!next && !fetchImpl.connectAware) armStall();
      // a nudge ends the read in hand and the one asked for ahead of it
      const nudged = (pollNudge = next?.nudge ?? new AbortController());
      const read = (signal, onConnected) => fetchImpl(`${route}/to-app?wait=${waitS}${streaming ? "&stream=1" : ""}`, { headers: { authorization: `Bearer ${token}` }, signal, onConnected });
      // no read may hold the loop longer than this, whatever the connection under it does
      let hangTimer = null, beatStop = () => {};
      const hung = new Promise((_resolve, reject) => { hangTimer = setTimeout(() => { log("vps link: a read hung; starting over on a fresh connection"); trail("link.keepalive.drop", { link: shortHash(id), path: "relay", reason: "read-hung" }); fetchImpl.reset?.(); reject(new Error("a read hung")); }, waitS * 1000 + READ_HANG_MS); });
      hung.catch(() => {});
      try {
        const response = await Promise.race([next?.response ?? read(AbortSignal.any([abort.signal, stall.signal, nudged.signal, AbortSignal.timeout(40_000)]), armStall), hung]);
        const boot = response.headers?.get?.("x-link-boot") ?? null;
        if (boot && boot !== nodeBoot.id) {
          if (nodeBoot.id && nodeBoot.node === node) { log("vps link: the link service restarted; what it held is sent again or failed"); lostOnRestart(Math.max(nodeBoot.okAt, nodeBoot.failAt ?? 0)); }
          Object.assign(nodeBoot, { id: boot, node });
        }
        if (response.ok) Object.assign(nodeBoot, { okAt: Date.now(), failAt: null });
        if (streaming) {
          aheadTimer = setTimeout(() => {
            const own = new AbortController();
            ahead = { nudge: own, response: read(AbortSignal.any([abort.signal, nudged.signal, own.signal, AbortSignal.timeout(aheadMs + 40_000)])) };
            ahead.response.catch(() => {});
          }, aheadMs);
        }
        if (!response.ok) {
          const said = response.status === 409 ? await response.text().catch(() => "") : (await response.body?.cancel(), "");
          if (movedBy(response.status, said)) continue;
          if (response.status === 404 && await reallyGone()) { closed = true; abort.abort(); fail("This server was unlinked."); break; }
          throw new Error(`link service answered ${response.status}`);
        }
        const beat = beatWatch(response, () => { log("vps link: the streamed read went silent; reconnecting"); trail("link.keepalive.drop", { link: shortHash(id), path: "relay", reason: "silent" }); fetchImpl.reset?.(); });
        beatStop = beat.stop;
        await Promise.race([readFrameBatches(response, (frames) => {
          beat.heard();
          heard = true;
          failures = 0;
          nodeBoot.okAt = Date.now();
          for (const sealed of frames) {
            let frame = null;
            try { frame = openFrame(key, id, "to-app", sealed, guard); } catch { log("vps link: dropped a frame that did not open"); }
            // one request's broken answer must not end the read that carries every other request's
            if (frame) try { deliver(frame); } catch (error) { log(`vps link: a reply could not be handed on (${error?.message ?? error})`); }
          }
        }), hung, beat.silent]);
      } catch (error) {
        if (closed) break;
        if (nudged.signal.aborted) { ahead = null; continue; }
        if (stall.signal.aborted && !heard) {
          stream.stalled();
          log("vps link: the link service's streamed replies were held back; polling instead");
          continue;
        }
        failures += 1;
        nodeBoot.failAt ??= Date.now();
        if (failures === 1 || failures % 20 === 0) { log(`vps link: tunnel retrying (${error?.message ?? error})`); trail("link.relay.retry", { link: shortHash(id), failures, msg: error?.message }); }
        // the node may be gone: its servers move to another within about a minute, so keep asking where
        if (failures >= 2) void locate();
        if (postsBefore === successfulPosts) {
          pollRetry = new AbortController();
          await sleep(spread(Math.min(15_000, 300 * 2 ** Math.min(failures, 6))), undefined, { signal: AbortSignal.any([abort.signal, pollRetry.signal]) }).catch(() => {});
          pollRetry = null;
        }
      } finally { clearTimeout(stallTimer); clearTimeout(aheadTimer); clearTimeout(hangTimer); beatStop(); }
    }
    polling = false;
  }

  function onRequest(req, res) {
    const hostHeader = String(req.headers.host ?? "");
    if (hostHeader !== `${host}:${listeningPort}`) { res.writeHead(421, { "content-type": "text/plain" }); res.end("wrong host"); return; }
    if (closed) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "This server is not connected." })); return; }
    // the app itself answers this one: TURN servers for the direct screen path, from the signed-in account (never the server)
    if (req.method === "GET" && req.url === SCREEN_ICE_PATH) { void answerScreenIce(res, screenIce, direct?.ready() && direct.via?.() !== "cloud" ? "direct" : "relay"); return; }
    let r = randomB32(12);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name)) headers[name] = value;
    let timer = null, eventStream = false;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => { emit({ t: "cancel", r }); waiting.delete(r); answer(504, "The server took too long to answer."); }, replyTimeoutMs); };
    const answer = (status, message) => {
      clearTimeout(timer);
      if (!res.headersSent) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify({ error: message })); }
      else res.destroy();
    };
    const bodyless = req.method === "GET" || req.method === "HEAD" || req.headers["content-length"] === "0";
    if (req.method === "POST" && CHAT_SEND.test(req.url ?? "")) chatAt = Date.now();
    const request = { t: "req", r, method: req.method, path: req.url, headers, end: bodyless };
    const idempotent = bodyless && (req.method === "GET" || req.method === "HEAD");
    // a whole download the server can serve in ranges (a file with a validator) picks up where it broke, on a new
    // request, when the relay loses part of it: the browser sees one download that never stopped
    let written = 0, resumable = null, resumes = 0;
    const resume = () => {
      if (!resumable || resumes >= MAX_RESUMES || written >= resumable.total || closed) return false;
      resumes += 1;
      r = randomB32(12);
      log(`vps link: a download broke at ${written} of ${resumable.total} bytes; it goes on from there`);
      const at = written, mine = r;
      waiting.set(r, entry(at));
      touch();
      // a moment first: what broke it (a node restarting) is usually still going on
      setTimeout(() => { if (waiting.has(mine)) emit({ t: "req", r: mine, method: "GET", path: req.url, headers: { ...headers, range: `bytes=${at}-`, "if-range": resumable.validator }, end: true }); }, Math.min(8000, 1000 * 2 ** (resumes - 1))).unref?.();
      return true;
    };
    const entry = (from) => ({
      via: pick(),
      touch,
      head: (status, out) => {
        if (from !== null) {
          // the rest of the same file, or nothing: anything else would splice two different files together
          const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(String(out["content-range"] ?? ""));
          if (status !== 206 || !range || Number(range[1]) !== from || Number(range[2]) !== resumable.total) { waiting.delete(r); emit({ t: "cancel", r }); res.destroy(); }
          return;
        }
        // a GET sent again may be answered twice; the first answer stands
        if (res.headersSent) return;
        eventStream = /^text\/event-stream\b/i.test(String(out["content-type"] ?? ""));
        const validator = typeof out.etag === "string" && !out.etag.startsWith("W/") ? out.etag : typeof out["last-modified"] === "string" ? out["last-modified"] : null;
        const total = Number(out["x-dusk-length"] ?? out["content-length"]);
        if (req.method === "GET" && status === 200 && !headers.range && /\bbytes\b/i.test(String(out["accept-ranges"] ?? "")) && validator && Number.isSafeInteger(total) && total > 0) resumable = { validator, total };
        res.writeHead(status, out);
        res.flushHeaders?.();
      },
      data: (chunk) => {
        if (res.writableLength + chunk.length > RECEIVE_HIGH) {
          emit({ t: "cancel", r });
          waiting.delete(r);
          answer(502, "The response exceeded this connection's buffer limit.");
          return;
        }
        written += chunk.length;
        res.write(chunk);
      },
      end: () => { clearTimeout(timer); res.end(); },
      fail: (message) => { if (res.headersSent && resume()) return; answer(502, message); },
      ctl: () => {},
      // nothing came back yet and asking again changes nothing: the same request goes out over the relay
      replay: () => { if (!idempotent || res.headersSent) return false; relayPath.push(request); return true; },
      // an event stream reconnects when it ends, and then takes the direct path
      movable: () => eventStream,
      move: () => { clearTimeout(timer); res.end(); },
    });
    waiting.set(r, entry(null));
    touch();
    // the trail: which way a request that names itself (x-dusk-trail), a chat stream, a download or an upload went
    const first = waiting.get(r), startedAt = Date.now(), firstVia = viaName(first.via), cid = validTrailId(req.headers[TRAIL_HEADER]) ? req.headers[TRAIL_HEADER] : undefined;
    const upload = Number(req.headers["content-length"]) > 1_000_000;
    res.on("close", () => {
      clearTimeout(timer);
      if (waiting.has(r)) { emit({ t: "cancel", r }); waiting.delete(r); }
      if (cid || eventStream || resumable || upload) {
        trail("link.req", { link: shortHash(id), cid, kind: eventStream ? "chat-stream" : resumable ? "download" : upload ? "upload" : "request", method: req.method, path: req.url,
          via: firstVia, ...(viaName(first.via) !== firstVia ? { endVia: viaName(first.via) } : {}), status: res.statusCode, ms: Date.now() - startedAt, bytes: written, ...(resumes ? { resumes } : {}) });
      }
    });
    emit(request);
    if (bodyless) return;
    req.on("data", (chunk) => { if (waiting.has(r) && !sendBytes(r, chunk)) { req.pause(); onDrain(r, () => req.resume()); } });
    req.on("end", () => { if (waiting.has(r)) emit({ t: "body", r, end: true, n: sentOf(r) }); });
  }

  /** a websocket (the live desktop): the handshake travels like a request, then its bytes both ways, raw and sealed */
  function onUpgrade(req, socket, head) {
    socket.on("error", () => socket.destroy());
    if (String(req.headers.host ?? "") !== `${host}:${listeningPort}`) { socket.end("HTTP/1.1 421 Misdirected Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"); return; }
    if (closed) { socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"); return; }
    socket.setNoDelay(true);
    // the live desktop is long-lived and moving it means a reconnect: worth a short wait for the direct path
    const dialling = direct && !direct.ready() && !direct.failing?.() && ["connecting", "up"].includes(direct.state());
    if (!dialling) { upgradeVia(req, socket, head, pick()); return; }
    socket.pause();
    void direct.whenUp(UPGRADE_HOLD_MS).then(() => { if (!socket.destroyed && !closed) upgradeVia(req, socket, head, pick()); else socket.destroy(); });
  }

  function upgradeVia(req, socket, head, via) {
    const r = randomB32(12);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name)) headers[name] = value;
    let timer = null, answered = false, open = false;
    const refuse = (status, message) => {
      clearTimeout(timer);
      if (answered) { socket.destroy(); return; }
      answered = true;
      const body = JSON.stringify({ error: message });
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    };
    // only the handshake has a deadline: an idle desktop may say nothing for a long while
    const touch = () => { if (open) return; clearTimeout(timer); timer = setTimeout(() => { if (waiting.has(r)) { emit({ t: "cancel", r }); waiting.delete(r); } refuse(504, "The server took too long to answer."); }, replyTimeoutMs); };
    let bytesIn = 0, bytesOut = 0, openedAt = 0, endedBy = "app";
    const read = (chunk) => { bytesOut += chunk.length; if (waiting.has(r) && !sendBytes(r, chunk)) { socket.pause(); onDrain(r, () => socket.resume()); } };
    const streamFields = () => ({ link: shortHash(id), kind: /\/desktop-viewer\//.test(req.url ?? "") ? "desktop" : /\/browser\/stream/.test(req.url ?? "") ? "browser" : "socket", path: req.url, via: viaName(via) });
    waiting.set(r, {
      via,
      touch,
      head: (status, out) => {
        answered = true;
        open = status === 101;
        if (open) clearTimeout(timer);
        if (open) { openedAt = Date.now(); trail("link.stream.open", streamFields()); } else trail("link.stream.refused", { ...streamFields(), status });
        const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`, ...(open ? ["Upgrade: websocket", "Connection: Upgrade"] : ["Connection: close"])];
        for (const [name, value] of Object.entries(out)) {
          for (const one of Array.isArray(value) ? value : [value]) if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[\r\n]/.test(String(one))) lines.push(`${name}: ${one}`);
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        // a socket held for the direct path was paused, and what it buffered meanwhile is read only from here on
        if (open) { socket.on("data", read); socket.resume(); }
      },
      data: (chunk) => {
        if (socket.writableLength + chunk.length > RECEIVE_HIGH) {
          emit({ t: "cancel", r });
          waiting.delete(r);
          endedBy = "buffer-limit";
          refuse(502, "The desktop exceeded this connection's buffer limit.");
          return;
        }
        bytesIn += chunk.length;
        socket.write(chunk);
      },
      end: () => { clearTimeout(timer); endedBy = "server"; socket.end(); },
      fail: (message) => { endedBy = `failed: ${message}`; refuse(502, message); },
      ctl: () => {},
    });
    touch();
    socket.on("close", () => {
      clearTimeout(timer);
      if (waiting.has(r)) { emit({ t: "cancel", r }); waiting.delete(r); }
      if (openedAt) trail("link.stream.close", { ...streamFields(), ms: Date.now() - openedAt, bytesIn, bytesOut, reason: endedBy });
    });
    emit({ t: "req", r, method: req.method, path: req.url, headers, end: true, up: true });
    if (head?.length) sendBytes(r, head);
  }

  return {
    host,
    origin: () => `http://${host}:${listeningPort}`,
    async start() {
      if (closed) throw new Error("This server is not connected.");
      if (server) return `http://${host}:${listeningPort}`;
      server = createServer(onRequest);
      server.on("upgrade", onUpgrade);
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
      listeningPort = server.address().port;
      // *.localhost resolves to ::1 first for node's fetch, so the same port answers on ipv6 loopback too
      const v6 = createServer(onRequest);
      v6.on("upgrade", onUpgrade);
      await new Promise((resolve) => { v6.once("error", () => resolve()); v6.listen(listeningPort, "::1", () => { server6 = v6; resolve(); }); });
      // where the tunnel lives before the first request goes out (a few seconds at most; the node it was linked through otherwise)
      if (follow && !givenRoute) await Promise.race([locate({ force: true }).catch(() => null), sleep(4000)]);
      if (!given) unwarm = fetchImpl.warm(node);
      void poll();
      watchSilence();
      if (report) {
        setTimeout(() => void sendReport(), reportMs.first).unref?.();
        reportTimer = setInterval(() => void sendReport(), reportMs.every);
        reportTimer.unref?.();
      }
      if (directSpec) useDirect(directSpec);
      egress?.start();
      return `http://${host}:${listeningPort}`;
    },
    /** gives the direct path a way to connect (null: relay only); it dials in the background */
    useDirect,
    /** the link service node the relay talks to now */
    node: () => node,
    /**
     * the server's own address as its agent last sealed it into the link service directory (any node answers), for
     * when the relay path cannot carry the handshake; null when no node has one this app can open
     */
    async sealedAddress() {
      let best = null;
      for (const at of [...new Set([originOf(base), originOf(node), ...known.map((item) => item.url)])].filter(Boolean)) {
        try {
          const response = await fetchImpl(`${at}/v1/tunnels/${id}/node`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]) });
          const body = await response.json().catch(() => null);
          if (!response.ok || typeof body?.address !== "string") continue;
          const value = JSON.parse(open(key, `${id}|address`, body.address).toString("utf8"));
          if (value?.v === 1 && Number.isFinite(value.ts) && value.address && typeof value.address === "object" && (!best || value.ts > best.ts)) best = value;
        } catch { /* the next node */ }
      }
      if (!best || best.ts <= addressSeen) return null;
      addressSeen = best.ts;
      return best.address;
    },
    /** the path a request started now would take */
    transport: () => (direct?.ready() ? "direct" : "relay"),
    /** what the agent said in its last direct hello, or null */
    agentHello: () => direct?.peer?.() ?? null,
    /** how the direct path is connected while it is up: "ssh", "wss" or "cloud" (the cloud relay) */
    directVia: () => (direct?.ready() ? direct.via?.() ?? "ssh" : null),
    /** after a sleep or a network change: the relay reconnects at once on fresh sockets, the direct path proves itself */
    nudge() {
      if (closed) return;
      fetchImpl.reset?.();
      pollNudge?.abort();
      direct?.nudge();
    },
    /** a request for the agent itself (credentials, pausing the server), answered over the same sealed tunnel */
    control(op, data, timeoutMs = 30_000) {
      if (closed) return Promise.reject(new Error("This server is not connected."));
      void poll();
      const r = randomB32(12);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(r); reject(new Error("Your server did not answer. Is it on?")); }, timeoutMs);
        const frame = { t: "ctl", r, op, data };
        waiting.set(r, { via: pick(), touch: () => {}, head: () => {}, data: () => {}, end: () => {}, fail: (message) => { clearTimeout(timer); reject(new Error(message)); },
          ctl: (answer) => { clearTimeout(timer); if (answer.ok) resolve(answer.data ?? { ok: true }); else reject(new Error(answer.error ?? "Your server said no.")); },
          replay: () => { relayPath.push(frame); return true; } });
        emit(frame);
      });
    },
    async close() {
      // the goodbye gets a moment to leave, so the vps stops routing through this computer at once
      if (egress && !closed) { egress.close(); await sleep(300); }
      closed = true;
      clearTimeout(moveTimer);
      clearInterval(silenceTimer);
      clearInterval(reportTimer);
      direct?.close();
      direct = null;
      abort.abort();
      unwarm();
      if (!given) fetchImpl.close();
      fail("closed");
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      if (server6) await new Promise((resolve) => server6.close(() => resolve()));
      server = null;
      server6 = null;
    },
  };
}
