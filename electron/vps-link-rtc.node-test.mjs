// the whole link over webrtc: the real link service as the relay, the real tunnel agent and the app's real proxy, with
// node-datachannel on both ends. signaling rides the sealed tunnel; requests ride the data channel; a dropped channel
// sends the next requests over the relay at once and comes back direct. DUSK_LINK_CHAOS=<seconds> runs a longer chaos
// run and prints the split, latency and relay bytes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTunnelAgent, directRtc, openFrame, rtcLibrary, rtcOffer } from "../apps/link-service/agent.mjs";
import { createLinkService, sha256hex } from "../apps/link-service/src/app.mjs";
import { createTunnelProxy, relayFetch } from "./vps-link-protocol.mjs";
import { iceServers, loadDataChannel, rtcConnector } from "./vps-link-rtc.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("the app's and the agent's channel code are the same", () => {
  const shared = (file) => {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    return text.slice(text.indexOf("export const RTC_LABEL"), text.indexOf("// ---- end of the shared part ----")).replace(/\/\*\*[^]*?\*\/\n/g, "");
  };
  const app = shared("./vps-link-rtc.mjs");
  assert.ok(app.includes("export function channelDuplex"));
  assert.equal(app, shared("../apps/link-service/agent.mjs"));
});

test("ice servers: stun as urls, turn with its credential and transport", () => {
  assert.deepEqual(iceServers([
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
    { urls: ["turn:turn.example:3478"] },
  ]), [
    "stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53",
    { hostname: "turn.cloudflare.com", port: 3478, username: "u", password: "c", relayType: "TurnUdp" },
    { hostname: "turn.cloudflare.com", port: 3478, username: "u", password: "c", relayType: "TurnTcp" },
    { hostname: "turn.cloudflare.com", port: 443, username: "u", password: "c", relayType: "TurnTls" },
  ]);
});

test("the agent takes only a link offer, and says so where webrtc is missing", async () => {
  assert.equal(rtcOffer({ type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" }), null, "no fingerprint");
  await assert.rejects(directRtc({ offer: { type: "offer", sdp: "v=0" } }, { hub: {} }, null), /not installed/);
  await assert.rejects(directRtc({ offer: { type: "offer", sdp: "v=0" } }, { hub: {} }, rtcLibrary()), /not a link offer/);
});

async function fixture() {
  const ndc = loadDataChannel([]);
  assert.ok(ndc, "node-datachannel loads in the test");
  assert.ok(rtcLibrary([fileURLToPath(new URL("..", import.meta.url))]), "the agent finds node-datachannel");
  const root = fileURLToPath(new URL("../apps/link-service/", import.meta.url));
  const service = createLinkService({ base: "http://fixture.invalid", scriptPath: `${root}install.sh`, agentPath: `${root}agent.mjs`, trustProxy: false });
  const credentials = { id: "abcdefghij", key: Buffer.alloc(32, 3).toString("base64url"), token: "a".repeat(43) };
  const vpsToken = "v".repeat(43);
  service.store.tunnels.set(credentials.id, { id: credentials.id, vpsVerifier: sha256hex(vpsToken), appVerifier: sha256hex(credentials.token) });
  const relay = createServer((req, res) => void service.handler(req, res));
  // what crosses the relay: request heads and every byte posted, so a test can tell which path a request took
  const seen = { reqs: 0, bytes: 0 };
  const spied = (dir) => {
    const inner = relayFetch();
    const go = async (url, init = {}) => {
      if (init.method === "POST") {
        seen.bytes += Buffer.byteLength(init.body);
        for (const sealed of JSON.parse(init.body).frames) {
          const frame = openFrame(Buffer.from(credentials.key, "base64url"), credentials.id, dir, sealed);
          if (frame?.t === "req") seen.reqs += 1;
        }
      }
      const response = await inner(url, init);
      return response;
    };
    return Object.assign(go, { connectAware: true, multiplexed: inner.multiplexed, postsInFlight: inner.postsInFlight, close: inner.close, reset: inner.reset });
  };
  const vpsFetch = spied("to-app"), appFetch = spied("to-vps");
  const base = `http://127.0.0.1:${await listen(relay)}`;
  // the Metal server behind the agent
  const big = Buffer.alloc(1024 * 1024, 7);
  const app = createServer((req, res) => {
    if (req.url === "/big") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(big); return; }
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ path: req.url, method: req.method, body: body.length })); });
  });
  const appPort = await listen(app);
  const agent = createTunnelAgent({ ...credentials, base, token: vpsToken, server: { host: "127.0.0.1", port: appPort }, fetchImpl: vpsFetch, log: () => {} });
  const running = agent.run();
  const channels = [];
  let proxy;
  const rtc = rtcConnector({ ndc, stun: [], signal: (offer) => proxy.control("direct-rtc", { offer }, 15_000) });
  const connect = async () => { const link = await rtc(); channels.push(link); return link; };
  proxy = createTunnelProxy({ ...credentials, base, fetch: appFetch, log: () => {}, direct: { connect } });
  const origin = new URL(await proxy.start());
  const get = (path, method = "GET", body = null) => new Promise((resolve, reject) => {
    const started = performance.now();
    const req = request({ host: "127.0.0.1", port: origin.port, path, method, headers: { host: origin.host, ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts), ms: performance.now() - started }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
  return {
    proxy, agent, channels, seen, get, big,
    async close() {
      agent.stop();
      await running;
      await proxy.close();
      vpsFetch.close();
      appFetch.close();
      service.close();
      relay.closeAllConnections();
      app.closeAllConnections();
      await Promise.all([new Promise((resolve) => relay.close(resolve)), new Promise((resolve) => app.close(resolve))]);
    },
  };
}

test("the link goes direct over webrtc: requests and a 1 MB download ride the data channel, not the relay", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await until(() => f.proxy.transport() === "direct");
    const before = { ...f.seen };
    for (let i = 0; i < 20; i++) assert.equal((await f.get(`/api/x?i=${i}`)).status, 200);
    assert.equal((await f.get("/api/echo", "POST", JSON.stringify({ a: 1 }))).status, 200);
    const download = await f.get("/big");
    assert.deepEqual(download.body, f.big);
    assert.equal(f.seen.reqs - before.reqs, 0, "no request crossed the relay");
    assert.ok(f.seen.bytes - before.bytes < 4096, `the relay carried ${f.seen.bytes - before.bytes} bytes`);
    assert.equal(f.channels[0].path, "direct");
  } finally { await f.close(); }
});

test("chaos: a dropped channel moves requests to the relay at once and the link comes back direct", { timeout: 120_000 }, async () => {
  const seconds = Number(process.env.DUSK_LINK_CHAOS) || 8;
  const f = await fixture();
  try {
    await until(() => f.proxy.transport() === "direct");
    const tally = { direct: { n: 0, ms: [] }, relay: { n: 0, ms: [] }, failed: 0, failedSmall: 0, bytes: 0 };
    const every = Number(process.env.DUSK_LINK_CHAOS_CUT_MS) || 2000;
    const relayBefore = f.seen.bytes;
    const end = Date.now() + seconds * 1000;
    // every 2 s the live channel is cut, as a network change or a dropped path would
    const chaos = setInterval(() => { for (const link of f.channels) link.close(); }, every);
    let i = 0;
    try {
      while (Date.now() < end) {
        const path = f.proxy.transport() === "direct" ? "direct" : "relay";
        const reqsBefore = f.seen.reqs;
        try {
          const big = i % 10 === 9;
          const answer = await f.get(big ? "/big" : `/api/x?i=${i}`);
          // a download cut part way is not sent again (only an unanswered GET is): the app's own retry takes it
          if (answer.status !== 200 || (big && answer.body.length !== f.big.length)) { tally.failed += 1; if (!big) tally.failedSmall += 1; }
          else {
            const via = f.seen.reqs > reqsBefore ? "relay" : path;
            tally[via].n += 1;
            tally[via].ms.push(answer.ms);
            tally.bytes += answer.body.length;
          }
        } catch { tally.failed += 1; if (i % 10 !== 9) tally.failedSmall += 1; }
        i += 1;
      }
    } finally { clearInterval(chaos); }
    const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)].toFixed(1) : "-");
    const total = tally.direct.n + tally.relay.n;
    const relayBytes = f.seen.bytes - relayBefore;
    console.log(`chaos ${seconds}s: ${total} requests, ${(tally.direct.n * 100 / total).toFixed(1)}% direct (median ${median(tally.direct.ms)} ms), ` +
      `${(tally.relay.n * 100 / total).toFixed(1)}% relay (median ${median(tally.relay.ms)} ms), ${tally.failed} failed (${tally.failedSmall} small); cut every ${every} ms; ` +
      `relay carried ${relayBytes} B of ${tally.bytes} B served (${(100 - relayBytes * 100 / Math.max(1, tally.bytes)).toFixed(1)}% saved)`);
    assert.equal(tally.failedSmall, 0, "no small GET failed while the channel was cut");
    assert.ok(tally.direct.n > tally.relay.n, "most requests went direct");
    await until(() => f.proxy.transport() === "direct", 10_000);
  } finally { await f.close(); }
});
