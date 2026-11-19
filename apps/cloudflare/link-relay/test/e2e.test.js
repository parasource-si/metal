// a fake Metal server and a fake app talk through the relay under `wrangler dev` (the real workerd runtime), using
// the real clients: agent.mjs createCloudRelay + createDirectHub on the server end, the app's tunnel proxy with the
// cloud connector on the other. RELAY_E2E=1 runs it (it starts wrangler and takes about two minutes).
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCloudRelay, createDirectHub, frameGuard } from "../../../link-service/agent.mjs";
import { cloudConnector, cloudRegister } from "../../../../electron/vps-link-direct.mjs";
import { createTunnelProxy } from "../../../../electron/vps-link-protocol.mjs";
import { CAP_BYTES_PER_S } from "../src/fair-use.js";
import { REPORT_BYTES } from "../src/protocol.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const pair = generateKeyPairSync("ed25519");
const GRANT_KEY = `e2e-1:${pair.publicKey.export({ format: "jwk" }).x}`;
const OPS_TOKEN = randomBytes(24).toString("hex");
const ACCT = randomBytes(16).toString("hex");

export function testGrant(acct = ACCT, privateKey = pair.privateKey, kid = "e2e-1") {
  const t = Date.now();
  const signed = `l1.${kid}.${Buffer.from(JSON.stringify({ v: 1, aud: "link", acct, iat: t, exp: t + 10 * 60_000 })).toString("base64url")}`;
  return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
}

export const freePort = () => new Promise((resolve) => { const server = createNetServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b32 = (n) => Array.from(randomBytes(n), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31]).join("");

/** wrangler dev on a free port with state kept in `persist`, resolved once /health answers */
export async function startRelay({ port, persist, vars = {} }) {
  const inspector = await freePort();
  const args = ["dev", "--config", CONFIG, "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector), "--persist-to", persist,
    ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])];
  const child = spawn(join(ROOT, "node_modules/.bin/wrangler"), args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited: ${output.slice(-2000)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch { /* not yet */ }
    await sleep(500);
  }
  child.kill();
  throw new Error(`wrangler dev did not start: ${output.slice(-2000)}`);
}
export const stopRelay = (child) => new Promise((resolve) => { if (child.exitCode !== null) { resolve(); return; } child.once("exit", resolve); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); });

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
}

/** a request through the app's local proxy, as the app's pages make them */
function viaProxy(proxy, path, { method = "GET", body = null } = {}) {
  const origin = new URL(proxy.origin());
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: origin.port, path, method, headers: { host: origin.host, ...(body ? { "content-length": body.length } : {}) } }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); });
      res.on("end", () => resolve({ status: res.statusCode, bytes, text: Buffer.concat(chunks).toString("utf8").slice(0, 2000) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

const run = process.env.RELAY_E2E ? describe : describe.skip;

run("the cloud relay end to end under wrangler dev", () => {
  let relay, port, persist, url, server, hub, cloud, proxy;
  const id = b32(10), key = randomBytes(32).toString("base64url");
  const BIG = 110 * 1000 * 1000;

  beforeAll(async () => {
    port = await freePort();
    persist = mkdtempSync(join(tmpdir(), "dusk-relay-e2e-"));
    url = `http://127.0.0.1:${port}`;
    relay = await startRelay({ port, persist, vars: { GRANT_KEYS: GRANT_KEY, OPS_TOKEN } });
    // the fake Metal server the agent forwards to
    server = createServer((req, res) => {
      if (req.url === "/hello") { res.writeHead(200, { "content-type": "text/plain" }); res.end(`hi ${req.headers["x-forwarded-for"] ? "remote" : "local"}`); return; }
      if (req.url === "/echo") { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => { res.writeHead(200); res.end(`got ${Buffer.concat(parts).length}`); }); return; }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(BIG) });
        const piece = randomBytes(64 * 1024);
        let left = BIG;
        const pump = () => { while (left > 0) { const n = Math.min(piece.length, left); left -= n; if (!res.write(n === piece.length ? piece : piece.subarray(0, n))) { res.once("drain", pump); return; } } res.end(); };
        pump();
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    hub = createDirectHub({ id, key, server: { host: "127.0.0.1", port: server.address().port }, guard: frameGuard(), log: () => {} });
  }, 120_000);

  afterAll(async () => {
    await proxy?.close();
    cloud?.stop();
    hub?.stop();
    server?.close();
    if (relay) await stopRelay(relay);
    if (persist) rmSync(persist, { recursive: true, force: true });
  }, 60_000);

  it("refuses to register without a good grant, then binds the tunnel to the grant's account", async () => {
    await expect(cloudRegister({ url, id, key, grant: null })).rejects.toMatchObject({ code: "NO_GRANT" });
    const stranger = generateKeyPairSync("ed25519").privateKey;
    await expect(cloudRegister({ url, id, key, grant: testGrant(ACCT, stranger) })).rejects.toMatchObject({ status: 401 });
    await cloudRegister({ url, id, key, grant: testGrant() });
    await cloudRegister({ url, id, key, grant: testGrant() });
    await expect(cloudRegister({ url, id, key, grant: testGrant(randomBytes(16).toString("hex")) })).rejects.toMatchObject({ status: 409 });
  });

  it("tells the app its server is offline until the server connects, then carries requests both ways", async () => {
    await expect(cloudConnector({ url, id, key })()).rejects.toMatchObject({ status: 503 });
    cloud = createCloudRelay({ url, id, key, hub, log: () => {}, backoff: [300, 600, 1000, 2000] });
    cloud.start();
    await until(() => cloud.stats().up, 20_000, "the server's standing socket");
    proxy = createTunnelProxy({ base: "http://127.0.0.1:1", id, key, token: "e2e-unused-token-0000", log: () => {},
      direct: { connect: cloudConnector({ url, id, key }), pingMs: (via) => (via === "cloud" ? 20_000 : 5000) } });
    await proxy.start();
    await until(() => proxy.transport() === "direct", 30_000, "the app's cloud session");
    expect(proxy.directVia()).toBe("cloud");
    const hello = await viaProxy(proxy, "/hello");
    expect(hello).toMatchObject({ status: 200, text: "hi remote" });
    const upload = randomBytes(3 * 1024 * 1024);
    expect(await viaProxy(proxy, "/echo", { method: "POST", body: upload })).toMatchObject({ status: 200, text: `got ${upload.length}` });
  }, 90_000);

  it("keeps out a client without the tunnel key", async () => {
    await expect(cloudConnector({ url, id, key: randomBytes(32).toString("base64url") })()).rejects.toMatchObject({ status: 404 });
  });

  it("streams a file over the 100 MB request cap, held to the fair-use rate", async () => {
    const started = Date.now();
    const got = await viaProxy(proxy, "/big");
    const seconds = (Date.now() - started) / 1000;
    expect(got).toMatchObject({ status: 200, bytes: BIG });
    // the burst goes at once, the rest at about 25 Mbit/s (the 2 s report cadence lets a little more through)
    expect(seconds).toBeGreaterThan(((BIG - 40 * 1024 * 1024) / CAP_BYTES_PER_S) * 0.8);
    console.log(`relay e2e: ${BIG / 1e6} MB in ${seconds.toFixed(1)} s = ${((BIG * 8) / seconds / 1e6).toFixed(1)} Mbit/s`);
  }, 120_000);

  it("counts the account's bytes where the ops page reads them", async () => {
    await sleep(2500);
    const auth = { authorization: `Bearer ${OPS_TOKEN}` };
    expect((await fetch(`${url}/v1/ops/usage`)).status).toBe(404);
    const account = await (await fetch(`${url}/v1/ops/usage/${ACCT}`, { headers: auth })).json();
    // a remainder under REPORT_BYTES waits for the next report or the session's end
    expect(account.bytes).toBeGreaterThan(BIG - REPORT_BYTES);
    const top = await (await fetch(`${url}/v1/ops/usage`, { headers: auth })).json();
    expect(top.accounts.find((one) => one.acct === ACCT)?.bytes).toBeGreaterThan(0);
    const tunnel = await (await fetch(`${url}/v1/ops/tunnel/${id}`, { headers: auth })).json();
    expect(tunnel).toMatchObject({ registered: true, server: true, sessions: 1 });
    const stats = await (await fetch(`${url}/ops/relay/stats`, { headers: auth })).json();
    expect(stats).toMatchObject({ relay: "cloudflare", now: { tunnels: 1, accounts: 1 }, busy: false });
    // the roll-up into the ops object runs every 10 s while bytes move, so it may trail the account by that much
    expect(stats.today.bytesOut).toBeGreaterThan(0);
    expect(stats.top[0]).toMatchObject({ account: ACCT, tunnels: 1 });
    const put = (body) => fetch(`${url}/ops/relay/limits`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ maxTunnels: -1 })).status).toBe(400);
    expect(await (await put({ maxTunnels: 50 })).json()).toMatchObject({ ok: true, limits: { maxTunnels: 50 } });
    expect((await fetch(`${url}/ops/relay/stats`)).status).toBe(404);
  });

  it("comes back by itself on both ends after the relay restarts (as a deploy drops sockets)", async () => {
    await stopRelay(relay);
    await until(() => proxy.transport() !== "direct", 30_000, "the app to notice");
    relay = await startRelay({ port, persist, vars: { GRANT_KEYS: GRANT_KEY, OPS_TOKEN } });
    await until(() => proxy.transport() === "direct", 60_000, "the app's cloud session after the restart");
    expect(await viaProxy(proxy, "/hello")).toMatchObject({ status: 200, text: "hi remote" });
  }, 150_000);
});
