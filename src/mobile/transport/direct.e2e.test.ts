// the phone's whole way to its server, in node: the real link service as the relay, the real link agent (its tunnel and
// its phone hub) in front of a stand-in Metal server, and the phone's own transport (relay.ts + direct.ts) with
// node-datachannel's RTCPeerConnection standing in for the webview's. signaling rides the phone's sealed relay channel,
// requests ride the data channel, and a cut channel sends what is safe to send again over the relay.
// DUSK_PHONE_CHAOS=<seconds> runs a longer chaos run; it prints the split either way.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withDirect } from "./direct";
import type { DirectConn } from "./direct-rtc";
import { frameGuard, open } from "./relay";

const agentPath = "../../../apps/link-service/agent.mjs";
const servicePath = "../../../apps/link-service/src/app.mjs";
const agent = await import(agentPath);
const { createLinkService } = await import(servicePath);
const { RTCPeerConnection } = await import("node-datachannel/polyfill");
const root = fileURLToPath(new URL("../../../apps/link-service/", import.meta.url));
const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");
const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const until = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function fixture() {
  const id = "abcdefghij", cid = "phoneaaaaa", vps = "v".repeat(43), appToken = "a".repeat(43);
  const service = createLinkService({ base: "http://fixture.invalid", scriptPath: `${root}install.sh`, agentPath: `${root}agent.mjs`, trustProxy: false });
  service.store.tunnels.set(id, { id, createdAt: Date.now(), vpsVerifier: sha256hex(vps), appVerifier: sha256hex(appToken), seenAt: null });
  const relay = createServer((req, res) => void service.handler(req, res));
  const base = `http://127.0.0.1:${await listen(relay)}`;
  const big = randomBytes(1024 * 1024);
  const app = createServer((req, res) => {
    let body = 0;
    req.on("data", (chunk: Buffer) => { body += chunk.length; });
    req.on("end", () => {
      if (req.url === "/api/big") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(big); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, method: req.method, body, phone: req.headers["x-forwarded-for"] }));
    });
  });
  const server = { host: "127.0.0.1", port: await listen(app) };
  // the phone's channel, as pairing leaves it: its own x25519 key with the agent's phone key, and its own token
  const keys = agent.x25519Pair(), phoneKeys = agent.x25519Pair(), token = randomBytes(32).toString("base64url");
  const key = new Uint8Array(agent.sealKeyOf(phoneKeys.priv, phoneKeys.pub, keys.pub, cid));
  const spec = { id: cid, kind: "device", pub: phoneKeys.pub, verifier: sha256hex(token) };
  // what the relay carries for the phone: request frames and every byte posted either way
  const seen = { reqs: 0, bytes: 0 };
  let registered = false, reading = false;
  const agentFetch = agent.relayFetch();
  const tunnel = agent.createTunnelAgent({ base, id, key: Buffer.alloc(32, 3).toString("base64url"), token: vps, server, fetchImpl: agentFetch, log: () => {} });
  const tunnelRun = tunnel.run();
  const hub = agent.createPhoneHub({ base, id, token: vps, keys, server, log: () => {},
    sync: async ({ wait, signal }: { wait: number; signal: AbortSignal }) => wait === 0 ? { rev: 1, channels: [spec] } : new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
    fetchImpl: async (url: string, init: RequestInit & { body?: string }) => {
      if (init.method === "POST") seen.bytes += Buffer.byteLength(init.body ?? "");
      if (!init.method && url.includes("/channels/to-vps")) reading = true;
      const response = await agentFetch(url, init);
      if (init.method === "PUT" && response.status === 200) registered = true;
      return response;
    },
  });
  const hubRun = hub.run();
  await until(() => registered && reading);
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).endsWith("/to-vps") && typeof init.body === "string") {
      seen.bytes += Buffer.byteLength(init.body);
      for (const sealed of JSON.parse(init.body).frames as string[]) if (agent.openFrame(Buffer.from(key), cid, "to-vps", sealed)?.t === "req") seen.reqs += 1;
    }
    return realFetch(input, init);
  });
  const conns: DirectConn[] = [];
  const guard = frameGuard();
  const phone = withDirect(open(base, cid, token, key, guard), {
    channel: cid, key, guard, Peer: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
    rtc: { stun: [], turn: async () => [], gatherMs: 500 }, tap: (conn) => conns.push(conn), linkOptions: { backoff: [300, 1000] },
  });
  const get = async (path: string, method = "GET", body: Uint8Array | null = null) => {
    const started = performance.now();
    const response = await phone.request(method, path, { authorization: "Bearer session" }, body);
    return { status: response.status, body: new Uint8Array(await response.arrayBuffer()), ms: performance.now() - started };
  };
  closers.push(async () => {
    phone.close();
    hub.stop();
    tunnel.stop();
    await Promise.all([hubRun, tunnelRun]);
    agentFetch.close();
    service.close();
    for (const listener of [relay, app]) { listener.closeAllConnections(); await new Promise((resolve) => listener.close(resolve)); }
  });
  return { phone, conns, seen, get, big };
}

describe("the phone reaches its server direct first (link service, link agent, node webrtc)", () => {
  it("signals over its relay channel, then requests, a 1 MB download and an upload ride the data channel", { timeout: 60_000 }, async () => {
    const f = await fixture();
    // the first request goes over the relay while the direct link comes up
    expect(JSON.parse(new TextDecoder().decode((await f.get("/api/session")).body))).toMatchObject({ path: "/api/session" });
    await until(() => f.phone.direct!.ready());
    expect(f.conns[0].path).toBe("direct");
    const before = { ...f.seen };
    for (let i = 0; i < 20; i++) expect((await f.get(`/api/x?i=${i}`)).status).toBe(200);
    const echoed = JSON.parse(new TextDecoder().decode((await f.get("/api/echo", "POST", new Uint8Array(200_000))).body));
    // the agent serves the data channel with the phone's own limits: its channel's remote address, never loopback trust
    expect(echoed).toMatchObject({ method: "POST", body: 200_000, phone: expect.stringMatching(/^198\.51\.100\.\d+$/) });
    expect(Buffer.from((await f.get("/api/big")).body).equals(f.big)).toBe(true);
    expect(f.seen.reqs - before.reqs).toBe(0);
    expect(f.seen.bytes - before.bytes).toBeLessThan(4096);
  });

  it("chaos: a cut channel moves requests to the relay at once and the link comes back direct", { timeout: 180_000 }, async () => {
    const seconds = Number(process.env.DUSK_PHONE_CHAOS) || 8;
    const every = Number(process.env.DUSK_PHONE_CHAOS_CUT_MS) || 2000;
    const f = await fixture();
    await until(() => f.phone.direct!.ready());
    const tally = { direct: { n: 0, ms: [] as number[] }, relay: { n: 0, ms: [] as number[] }, failed: 0, failedSmall: 0, bytes: 0 };
    const relayBefore = f.seen.bytes;
    const end = Date.now() + seconds * 1000;
    const chaos = setInterval(() => { for (const conn of f.conns) conn.close(); }, every);
    let i = 0;
    try {
      while (Date.now() < end) {
        const big = i % 10 === 9;
        const reqsBefore = f.seen.reqs;
        try {
          const answer = await f.get(big ? "/api/big" : `/api/x?i=${i}`);
          // a download cut part way is not sent again (only an unanswered GET is): the app's own retry takes it
          if (answer.status !== 200 || (big && answer.body.length !== f.big.length)) { tally.failed += 1; if (!big) { tally.failedSmall += 1; console.log(`small failed: status ${answer.status}`); } }
          else {
            const via = f.seen.reqs > reqsBefore ? "relay" : "direct";
            tally[via].n += 1;
            tally[via].ms.push(answer.ms);
            tally.bytes += answer.body.length;
          }
        } catch (error) { tally.failed += 1; if (!big) { tally.failedSmall += 1; console.log(`small failed: ${error instanceof Error ? error.message : error}`); } }
        i += 1;
      }
    } finally { clearInterval(chaos); }
    const median = (list: number[]) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)].toFixed(1) : "-");
    const total = tally.direct.n + tally.relay.n;
    const relayBytes = f.seen.bytes - relayBefore;
    console.log(`phone chaos ${seconds}s: ${total} requests, ${(tally.direct.n * 100 / total).toFixed(1)}% direct (median ${median(tally.direct.ms)} ms), `
      + `${(tally.relay.n * 100 / total).toFixed(1)}% relay (median ${median(tally.relay.ms)} ms), ${tally.failed} failed (${tally.failedSmall} small); cut every ${every} ms; `
      + `${f.conns.length} channels; relay carried ${relayBytes} B of ${tally.bytes} B served; stats ${JSON.stringify(f.phone.stats)}`);
    // a reply already under way when its channel is cut is not sent again (the rule for every request once answered);
    // a small one rarely is, so a busy machine may see one in a run
    expect(tally.failedSmall).toBeLessThanOrEqual(Math.ceil(total / 500));
    expect(tally.direct.n).toBeGreaterThan(tally.relay.n);
    await until(() => f.phone.direct!.ready());
  });

  it("a server with direct links off answers the offer with a refusal, and the phone stays on the relay", { timeout: 30_000 }, async () => {
    vi.stubEnv("DUSK_LINK_DIRECT", "off");
    const f = await fixture();
    expect((await f.get("/api/one")).status).toBe(200);
    await until(() => f.phone.direct!.state() === "waiting");
    for (let i = 0; i < 5; i++) expect((await f.get(`/api/x?i=${i}`)).status).toBe(200);
    expect(f.conns).toHaveLength(0);
    expect(f.phone.stats.direct).toBe(0);
  });
});
