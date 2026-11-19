// the link service end to end on loopback: a setup session as the app and the install script use it, the agent's real
// `link` command sealing a result only the app opens, and the sealed relay tunnel carrying requests, streams and control.
import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLinkService, publicIp } from "../src/app.mjs";
import { SERVER_RELEASE_KEYS, createServerUpdater, createTunnelAgent, serverReleaseSigned, open as agentOpen, openFrame as agentOpenFrame, sealBytes as agentSealBytes } from "../agent.mjs";
import { PINNED_RELEASE_KEYS, signRelease } from "../../cloud-service/src/release-signing.ts";
import { createRelayClient, createTunnelProxy, frameGuard, newLinkKeys, openFrame, openResult, seal, sealBytes, sealFrame, sha256hex, vpsTokenOf } from "../../../electron/vps-link-protocol.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

let dir, relayServer, service, base, fakeServer, fakePort, seen, largestPost = 0;
const binaryReply = Buffer.alloc(1024 * 1024 + 37, 0x5a);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-link-"));
  service = createLinkService({ base: "http://link.test", dataDir: join(dir, "data"), scriptPath: join(root, "install.sh"), agentPath: join(root, "agent.mjs"), trustProxy: false });
  relayServer = createServer((req, res) => { largestPost = Math.max(largestPost, Number(req.headers["content-length"] ?? 0)); void service.handler(req, res); });
  base = `http://127.0.0.1:${await listen(relayServer)}`;
  seen = [];
  // stands in for Metal on the vps
  fakeServer = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url === "/api/auth/pairing") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: "RR8Y-BLR6-H939", expiresAt: 123 })); }
      if (req.url === "/.well-known/duskbot/environment") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ environmentId: "6f1c2d3e-0000-4000-8000-000000000001" })); }
      if (req.url === "/binary") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(binaryReply); }
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 150);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "omb_session=abc; HttpOnly" });
      res.end(JSON.stringify({ echo: Buffer.concat(chunks).length, url: req.url }));
    });
  });
  // the server's desktop viewer stands in as a websocket that echoes, or refuses with a json answer
  fakeServer.on("upgrade", (req, socket, head) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    if (!req.url.startsWith("/ws/echo")) {
      const body = JSON.stringify({ error: "Take control of this computer first" });
      socket.end(`HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
      return;
    }
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  fakePort = await listen(fakeServer);
});

afterAll(async () => {
  service.close();
  await new Promise((resolve) => relayServer.close(resolve));
  await new Promise((resolve) => fakeServer.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

async function openTunnel({ onAgentPost } = {}) {
  const relay = createRelayClient({ base });
  const keys = newLinkKeys();
  const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
  const vpsToken = vpsTokenOf(keys.secret);
  await post(`/v1/sessions/${made.id}/claim`, vpsToken, {});
  const tunnel = { key: Buffer.alloc(32, 9).toString("base64url"), vps: "w".repeat(43), app: "b".repeat(43) };
  await post(`/v1/sessions/${made.id}/result`, vpsToken, { sealed: seal(Buffer.alloc(32), made.id, Buffer.from("{}")), vpsPub: keys.pub, tunnel: { vps: sha256hex(tunnel.vps), app: sha256hex(tunnel.app) } });
  const agent = createTunnelAgent({ base, id: made.id, key: tunnel.key, token: tunnel.vps, server: { host: "127.0.0.1", port: fakePort }, log: () => {}, fetchImpl: (url, init) => {
    if (init?.method === "POST") onAgentPost?.(JSON.parse(init.body).frames, made.id, Buffer.from(tunnel.key, "base64url"));
    return fetch(url, init);
  } });
  const running = agent.run();
  const proxy = createTunnelProxy({ base, id: made.id, key: tunnel.key, token: tunnel.app });
  const port = new URL(await proxy.start()).port;
  return { id: made.id, port, proxy, close: async () => { await relay.forget(made.id, tunnel.app); await running; await proxy.close(); } };
}

/** a websocket handshake as a browser makes it, to the app's proxy with the vps host name */
function upgrade({ id, port }, path, host = `vps-${id}.localhost:${port}`) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host, origin: `http://${host}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") } });
    req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode, headers: res.headers, socket, head }));
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const post = (route, token, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe("setup sessions", () => {
  it("serves the script with the base and token baked in, and refuses a malformed token", async () => {
    const token = "abcdefghij-abcdefghijklmnopqrstuvwxyz";
    const script = await (await fetch(`${base}/i/${token}`)).text();
    if (script.includes("__LINK_TOKEN__") || script.includes("__LINK_BASE__")) throw new Error("placeholders left in the served script");
    expect(script).toContain("http://link.test");
    expect(script).toContain(token);
    expect((await fetch(`${base}/i/ABCDEFGHIJ-abcdefghijklmnopqrstuvwxyz`)).status).toBe(404);
  });

  it("serves the uninstall script to anyone, with the base baked in, and it parses", async () => {
    for (const path of ["/uninstall", "/uninstall.sh"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      const script = await response.text();
      expect(script.startsWith("#!/bin/sh")).toBe(true);
      if (script.includes("__LINK_BASE__")) throw new Error("placeholder left in the served uninstall script");
      expect(script).toContain('BAKED_BASE="http://link.test"');
    }
    const file = join(dir, "uninstall.sh");
    writeFileSync(file, await (await fetch(`${base}/uninstall`)).text());
    await run("sh", ["-n", file]);
  });

  it("serves the docker gate beside the agent, as install.sh fetches it", async () => {
    const response = await fetch(`${base}/docker-gate.mjs`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toBe(readFileSync(join(root, "docker-gate.mjs"), "utf8"));
  });

  it("runs a whole setup: claim, steps, result; the relay keeps only verifiers and the command is one-time", async () => {
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub, label: "Sid's MacBook" });
    expect(made.id).toMatch(/^[a-z2-7]{10}$/);
    const vpsToken = vpsTokenOf(keys.secret);

    expect((await post(`/v1/sessions/${made.id}/claim`, "x".repeat(64), {})).status).toBe(401);
    const claim = await post(`/v1/sessions/${made.id}/claim`, vpsToken, { host: { arch: "aarch64", os: "Ubuntu 24.04" } });
    expect(claim.status).toBe(200);
    expect((await claim.json()).appPub).toBe(keys.pub);

    expect((await post(`/v1/sessions/${made.id}/events`, vpsToken, { step: "node", status: "running" })).status).toBe(200);
    // a long poll wakes on the next step
    const waiting = relay.watch(made.id, made.watch, 2);
    await post(`/v1/sessions/${made.id}/events`, vpsToken, { step: "node", status: "failed", log: "E: Unable to locate package nodejs" });
    const watched = await waiting;
    expect(watched.state).toBe("installing");
    expect(watched.events.map((event) => [event.step, event.status])).toEqual([["node", "failed"]]);
    expect(watched.events[0].log).toContain("nodejs");

    // live terminal lines: kept with their command, capped, and a bad shape refused
    const many = Array.from({ length: 60 }, (_, i) => `Get:${i} ${"x".repeat(500)}`);
    expect((await post(`/v1/sessions/${made.id}/events`, vpsToken, { step: "node", status: "running", cmd: "apt-get -y install nodejs", lines: many })).status).toBe(200);
    expect((await post(`/v1/sessions/${made.id}/events`, vpsToken, { step: "node", status: "running", lines: "nope" })).status).toBe(400);
    expect((await post(`/v1/sessions/${made.id}/events`, vpsToken, { step: "node", status: "running", lines: many.concat("one too many") })).status).toBe(400);
    const streamed = (await relay.watch(made.id, made.watch, watched.events[0].seq)).events[0];
    expect(streamed.cmd).toBe("apt-get -y install nodejs");
    expect(streamed.lines.length).toBeGreaterThan(10);
    expect(streamed.lines.every((line) => line.length <= 400)).toBe(true);
    expect(streamed.lines.join("").length).toBeLessThanOrEqual(16 * 1024);
    expect(streamed.lines.at(-1)).toMatch(/^Get:59 /);

    // the agent's own `link` command, with this suite's fake Metal as the server
    const home = mkdtempSync(join(dir, "home-"));
    await run(process.execPath, [join(root, "agent.mjs"), "link"], {
      env: { ...process.env, HOME: home, LINK_BASE: base, LINK_ID: made.id, LINK_TOKEN: vpsToken, LINK_MODE: "relay", LINK_NAME: "oracle-arm", LINK_SERVER_PORT: String(fakePort) },
    });
    const pairingAsk = seen.find((entry) => entry.url === "/api/auth/pairing");
    expect(JSON.parse(pairingAsk.body)).toEqual({ label: "Sid's MacBook" });
    const tunnelFile = join(home, ".config", "duskbot-link", "tunnel.json");
    expect(statSync(tunnelFile).mode & 0o777).toBe(0o600);

    const done = await relay.watch(made.id, made.watch, 0);
    expect(done.state).toBe("linked");
    const result = openResult({ id: made.id, priv: keys.priv, pub: keys.pub, vpsPub: done.vpsPub, sealed: done.sealed });
    expect(result).toMatchObject({ mode: "relay", name: "oracle-arm", pairing: { code: "RR8Y-BLR6-H939" }, environmentId: "6f1c2d3e-0000-4000-8000-000000000001" });

    // nothing the relay wrote down opens the result or carries a token
    service.store.flush();
    const state = readFileSync(join(dir, "data", "state.json"), "utf8");
    expect(state).not.toContain(keys.secret);
    expect(state).not.toContain(vpsToken);
    expect(state).not.toContain(result.tunnel.token);
    expect(state).not.toContain("RR8Y");
    expect(state).toContain(sha256hex(result.tunnel.token));
    // the relay alone (it knows appPub, vpsPub and the sealed blob) cannot open it
    expect(() => agentOpen(Buffer.alloc(32), made.id, done.sealed)).toThrow();

    // the same command again is refused as used
    const again = await post(`/v1/sessions/${made.id}/claim`, vpsToken, {});
    expect(again.status).toBe(410);
    expect((await again.json()).code).toBe("used");
    // and the agent says "already linked" (exit 4) on a server that has its tunnel
    const rerun = await run(process.execPath, [join(root, "agent.mjs"), "link"], { env: { ...process.env, HOME: home, LINK_BASE: base, LINK_ID: made.id, LINK_TOKEN: vpsToken, LINK_SERVER_PORT: String(fakePort) } }).catch((error) => error);
    expect(rerun.code).toBe(4);
  });

  it("a cancelled session takes no more steps, and an unknown one reads as expired", async () => {
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    await relay.cancel(made.id, made.watch);
    const cancelled = await post(`/v1/sessions/${made.id}/claim`, vpsTokenOf(keys.secret), {});
    expect(cancelled.status).toBe(410);
    expect((await cancelled.json()).code).toBe("cancelled");
    const unknown = await post("/v1/sessions/aaaaaaaaaa/claim", vpsTokenOf(keys.secret), {});
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("expired");
    // the watch token of one session reads no other
    expect((await fetch(`${base}/v1/sessions/aaaaaaaaaa/events`, { headers: { authorization: `Bearer ${made.watch}` } })).status).toBe(404);
  });

  it("keeps bounded real progress and quiet heartbeats without evicting completed steps", async () => {
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    const token = vpsTokenOf(keys.secret);
    const route = `/v1/sessions/${made.id}/events`;
    await post(`/v1/sessions/${made.id}/claim`, token, {});
    await post(route, token, { step: "node", status: "done" });
    const progress = { kind: "download", receivedBytes: 123, totalBytes: 1000, label: "archive\nname" };
    const activity = { elapsedMs: 5000, quietMs: 3000 };
    expect((await post(route, token, { step: "app", status: "running", progress, activity })).status).toBe(200);
    const first = (await relay.watch(made.id, made.watch, 0)).events.at(-1);
    expect(first.progress).toEqual({ ...progress, label: "archivename" });
    expect(first.activity).toEqual(activity);
    expect(first.at).toBeTypeOf("number");
    for (const bad of [
      { progress: { kind: "download", receivedBytes: -1 } },
      { progress: { kind: "layers", completed: 4, total: 3 } },
      { progress: { kind: "build", completed: 0.5, total: 3 } },
      { progress: { kind: "download", receivedBytes: Number.MAX_SAFE_INTEGER + 1 } },
      { activity: { elapsedMs: 5, quietMs: 6 } },
      { heartbeat: "yes" },
    ]) expect((await post(route, token, { step: "app", status: "running", ...bad })).status).toBe(400);
    for (let i = 0; i < 152; i += 1) {
      expect((await post(route, token, { step: "app", status: "running", heartbeat: true, activity: { elapsedMs: 5000 + i, quietMs: 3000 + i } })).status).toBe(200);
    }
    const events = (await relay.watch(made.id, made.watch, 0)).events;
    expect(events.filter((event) => event.heartbeat || event.progress || event.activity)).toHaveLength(150);
    expect(events.find((event) => event.step === "node")).toMatchObject({ status: "done" });
    expect(events.at(-1)).toMatchObject({ heartbeat: true, activity: { elapsedMs: 5151, quietMs: 3151 } });
  });

  it("probes only a public address: a private one is never fetched", async () => {
    expect(publicIp("10.0.0.5")).toBe(false);
    expect(publicIp("127.0.0.1")).toBe(false);
    expect(publicIp("100.70.1.1")).toBe(false);
    expect(publicIp("203.0.113.10")).toBe(true);
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    await post(`/v1/sessions/${made.id}/claim`, vpsTokenOf(keys.secret), {});
    const probe = await post(`/v1/sessions/${made.id}/probe`, vpsTokenOf(keys.secret), { nonce: "0123456789abcdef0123" });
    expect(await probe.json()).toEqual({ ip: "127.0.0.1", reachable: false });
  });
});

describe("the private server build", () => {
  it("resumes authenticated downloads using exact open byte ranges", async () => {
    const bytes = Buffer.from("range fixture ".repeat(100));
    const sha = sha256hex(bytes);
    const packages = join(dir, "data", "packages");
    mkdirSync(packages, { recursive: true });
    writeFileSync(join(packages, `${sha}.tgz`), bytes);
    writeFileSync(join(packages, "current.json"), JSON.stringify({ sha256: sha, version: "fixture" }));
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    const token = vpsTokenOf(keys.secret);
    const url = `${base}/pkg/${made.id}/${sha}.tgz`;
    const get = (range, authorized = true) => fetch(url, { headers: { range, ...(authorized ? { authorization: `Bearer ${token}` } : {}) } });
    expect((await get("bytes=100-")).status).toBe(409);
    await post(`/v1/sessions/${made.id}/claim`, token, {});
    expect((await get("bytes=100-", false)).status).toBe(401);
    const resumed = await get("bytes=100-");
    expect(resumed.status).toBe(206);
    expect(resumed.headers.get("content-range")).toBe(`bytes 100-${bytes.length - 1}/${bytes.length}`);
    expect(resumed.headers.get("content-length")).toBe(String(bytes.length - 100));
    expect(resumed.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await resumed.arrayBuffer())).toEqual(bytes.subarray(100));
    for (const range of [`bytes=${bytes.length}-`, "bytes=-5", "bytes=0-5", "bytes=00-", "bytes=9007199254740992-"]) {
      const invalid = await get(range);
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    }
    await relay.cancel(made.id, made.watch);
    expect((await get("bytes=100-")).status).toBe(410);
  });

  it("is handed only to a claimed session with its own token, by sha256, a few times, and never after linking", async () => {
    const tgz = Buffer.from("pretend tarball ".repeat(4096));
    const sha = sha256hex(tgz);
    const packages = join(dir, "data", "packages");
    mkdirSync(packages, { recursive: true });
    writeFileSync(join(packages, `${sha}.tgz`), tgz);
    const kit = Buffer.from("pretend desktop kit");
    writeFileSync(join(packages, `${sha256hex(kit)}.tgz`), kit);
    writeFileSync(join(packages, "current.json"), JSON.stringify({ sha256: sha, version: "0.1.141", desktop: { sha256: sha256hex(kit), image: "ghcr.io/sidddevz/omb-bot-desktop:v1" } }));

    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    const vpsToken = vpsTokenOf(keys.secret);
    const get = (route, token) => fetch(`${base}${route}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const route = `/pkg/${made.id}/${sha}.tgz`;

    expect((await get(route, vpsToken)).status).toBe(409);
    const claim = await (await post(`/v1/sessions/${made.id}/claim`, vpsToken, {})).json();
    expect(claim.package).toEqual({ sha256: sha, size: tgz.length, version: "0.1.141", path: route });
    expect(claim.desktop).toEqual({ sha256: sha256hex(kit), size: kit.length, image: "ghcr.io/sidddevz/omb-bot-desktop:v1", path: `/pkg/${made.id}/${sha256hex(kit)}.tgz` });
    expect(Buffer.from(await (await get(claim.desktop.path, vpsToken)).arrayBuffer()).equals(kit)).toBe(true);

    expect((await get(route)).status).toBe(401);
    expect((await get(route, "x".repeat(64))).status).toBe(401);
    expect((await get(`/pkg/${made.id}/${"0".repeat(64)}.tgz`, vpsToken)).status).toBe(404);
    // another session's token reads nothing of this one
    const other = newLinkKeys();
    const otherMade = await relay.create({ verifier: other.verifier, appPub: other.pub });
    await post(`/v1/sessions/${otherMade.id}/claim`, vpsTokenOf(other.secret), {});
    expect((await get(route, vpsTokenOf(other.secret))).status).toBe(401);

    const got = await get(route, vpsToken);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toContain("no-store");
    const body = Buffer.from(await got.arrayBuffer());
    expect(sha256hex(body)).toBe(sha);

    // twenty downloads a session (the server build and the desktop kit, with retries), then 429
    for (let i = 0; i < 18; i += 1) await (await get(route, vpsToken)).arrayBuffer();
    expect((await get(route, vpsToken)).status).toBe(429);

    await post(`/v1/sessions/${otherMade.id}/result`, vpsTokenOf(other.secret), { sealed: "abc", vpsPub: other.pub });
    expect((await get(`/pkg/${otherMade.id}/${sha}.tgz`, vpsTokenOf(other.secret))).status).toBe(410);
    // the script and the public routes never name the build
    expect(await (await fetch(`${base}/i`)).text()).not.toContain(sha);
  });

  it("advertises nothing when no build is published", async () => {
    rmSync(join(dir, "data", "packages"), { recursive: true, force: true });
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    const claim = await (await post(`/v1/sessions/${made.id}/claim`, vpsTokenOf(keys.secret), {})).json();
    expect(claim.package).toBeUndefined();
  });
});

describe("a linked server's own update", () => {
  async function linked() {
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    const vpsToken = vpsTokenOf(keys.secret);
    await post(`/v1/sessions/${made.id}/claim`, vpsToken, {});
    const token = randomBytes(24).toString("base64url"), app = randomBytes(24).toString("base64url");
    await post(`/v1/sessions/${made.id}/result`, vpsToken, { sealed: seal(Buffer.alloc(32), made.id, Buffer.from("{}")), vpsPub: keys.pub, tunnel: { vps: sha256hex(token), app: sha256hex(app) } });
    return { id: made.id, token, app };
  }
  function publish(bytes, extra = {}) {
    const packages = join(dir, "data", "packages");
    rmSync(packages, { recursive: true, force: true });
    mkdirSync(packages, { recursive: true });
    writeFileSync(join(packages, `${sha256hex(bytes)}.tgz`), bytes);
    writeFileSync(join(packages, "current.json"), JSON.stringify({ sha256: sha256hex(bytes), version: "1.2.0", ...extra }));
    return sha256hex(bytes);
  }
  const get = (route, token, headers = {}) => fetch(`${base}${route}`, { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

  it("names and hands the current build only to the tunnel's own server token, and only the current one", async () => {
    const bytes = Buffer.from("server build ".repeat(500));
    const sha = publish(bytes);
    const { id, token, app } = await linked();
    for (const who of [null, app, "x".repeat(43)]) expect((await get(`/v1/tunnels/${id}/server`, who)).status).toBe(404);
    const offer = await (await get(`/v1/tunnels/${id}/server`, token)).json();
    expect(offer).toEqual({ v: 1, package: { sha256: sha, size: bytes.length, version: "1.2.0" } });
    expect((await get(`/v1/tunnels/${id}/server/${sha}.tgz`, app)).status).toBe(404);
    expect((await get(`/v1/tunnels/${id}/server/${"0".repeat(64)}.tgz`, token)).status).toBe(404);
    const part = await get(`/v1/tunnels/${id}/server/${sha}.tgz`, token, { range: "bytes=13-" });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(13));
  });

  it("the agent pins the same release keys as the service and the installer, and only those", () => {
    expect([...SERVER_RELEASE_KEYS]).toEqual(PINNED_RELEASE_KEYS.map(k => `${k.kid}:${k.x}`));
    const { privateKey } = generateKeyPairSync("ed25519");
    const sha = "a".repeat(64);
    const stranger = signRelease({ kind: "vps-package", name: "duskbot", version: "1.2.0", sha256: sha, signedAt: 1 }, `${PINNED_RELEASE_KEYS[0].kid}:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`);
    expect(serverReleaseSigned(stranger, sha)).toBeNull();
  });

  it("limits update checks and downloads per server", async () => {
    const sha = publish(Buffer.from("rate limited build"));
    const { id, token } = await linked();
    for (let i = 0; i < 12; i += 1) await (await get(`/v1/tunnels/${id}/server`, token)).arrayBuffer();
    expect((await get(`/v1/tunnels/${id}/server`, token)).status).toBe(429);
    for (let i = 0; i < 12; i += 1) await (await get(`/v1/tunnels/${id}/server/${sha}.tgz`, token)).arrayBuffer();
    expect((await get(`/v1/tunnels/${id}/server/${sha}.tgz`, token)).status).toBe(429);
  });

  it("the agent stages a newer signed build with its policy, and refuses a forged one or one that is not newer", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signing = `test-vps:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
    const keys = [`test-vps:${createPublicKey(privateKey).export({ format: "jwk" }).x}`];
    const bytes = Buffer.from("signed server build ".repeat(300));
    const sha = sha256hex(bytes);
    publish(bytes, { signature: signRelease({ kind: "vps-package", name: "duskbot", version: "1.2.0", sha256: sha, signedAt: 1 }, signing) });
    const { id, token } = await linked();
    const staged = join(dir, `server-release-${id}`);
    const updater = (current, k = keys) => createServerUpdater({ base, id, token, dir: staged, keys: k, current: async () => current });

    expect(await updater("1.2.0").check()).toBeNull();
    expect(await updater("1.1.0", ["test-vps:" + "A".repeat(43)]).check()).toBeNull();
    expect(() => readFileSync(join(staged, "ready.json"))).toThrow();

    expect(await updater("1.1.0").check()).toBe("1.2.0");
    const ready = JSON.parse(readFileSync(join(staged, "ready.json"), "utf8"));
    expect(ready).toMatchObject({ v: 1, sha256: sha, size: bytes.length, version: "1.2.0" });
    expect(readFileSync(join(staged, `${sha}.tgz`)).equals(bytes)).toBe(true);
    expect(statSync(join(staged, "ready.json")).mode & 0o777).toBe(0o600);
  });

  it("the agent logs what each check found, once each time it changes", async () => {
    const lines = [];
    const quiet = await linked();
    rmSync(join(dir, "data", "packages"), { recursive: true, force: true });
    const none = createServerUpdater({ base, id: quiet.id, token: quiet.token, dir: join(dir, `server-release-${quiet.id}`), current: async () => "1.1.0", log: (line) => lines.push(line) });
    expect(await none.check()).toBeNull();
    expect(await none.check()).toBeNull();
    expect(lines).toEqual(["link: no server build is published on the link service (it answered 404); the server stays as it is"]);

    const { privateKey } = generateKeyPairSync("ed25519");
    const signing = `test-vps:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
    const keys = [`test-vps:${createPublicKey(privateKey).export({ format: "jwk" }).x}`];
    const bytes = Buffer.from("current server build ".repeat(300));
    publish(bytes, { signature: signRelease({ kind: "vps-package", name: "duskbot", version: "1.2.0", sha256: sha256hex(bytes), signedAt: 1 }, signing) });
    const { id, token } = await linked();
    lines.length = 0;
    const current = createServerUpdater({ base, id, token, dir: join(dir, `server-release-${id}`), keys, current: async () => "1.2.0", log: (line) => lines.push(line) });
    expect(await current.check()).toBeNull();
    expect(await current.check()).toBeNull();
    expect(lines).toEqual(["link: server 1.2.0 is up to date (the link service offers 1.2.0)"]);
  });
});

describe("relay tunnel", () => {
  it("streams HTTP downloads as raw sealed bytes with one base64 layer", async () => {
    const frames = [];
    const tunnel = await openTunnel({ onAgentPost: (sealed, id, key) => {
      for (const value of sealed) frames.push({ value, frame: openFrame(key, id, "to-app", value) });
    } });
    try {
      const reply = await new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: tunnel.port, path: "/binary", headers: { host: `vps-${tunnel.id}.localhost:${tunnel.port}` } }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });
      expect(Buffer.compare(reply, binaryReply)).toBe(0);
      expect(frames.some(({ frame }) => frame.t === "data")).toBe(false);
      const body = frames.filter(({ frame }) => frame.t === "bytes");
      expect(Buffer.compare(Buffer.concat(body.map(({ frame }) => frame.b)), binaryReply)).toBe(0);
      const rawSize = body.reduce((sum, { value }) => sum + value.length, 0);
      const nestedSize = body.reduce((sum, { frame }) => sum + sealFrame(Buffer.alloc(32), tunnel.id, "to-app", { t: "data", r: frame.r, d: frame.b.toString("base64") }).length, 0);
      expect(rawSize).toBeLessThan(binaryReply.length * 1.4);
      expect(rawSize).toBeLessThan(nestedSize * 0.76);
    } finally {
      await tunnel.close();
    }
  }, 20_000);

  it("carries requests, bodies, streams and control end to end, marks them remote, and stops when forgotten", async () => {
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    const vpsToken = vpsTokenOf(keys.secret);
    await post(`/v1/sessions/${made.id}/claim`, vpsToken, {});
    const tunnel = { key: Buffer.alloc(32, 7).toString("base64url"), vps: "v".repeat(43), app: "a".repeat(43) };
    const sealedResult = seal(Buffer.alloc(32), made.id, Buffer.from("{}"));
    expect((await post(`/v1/sessions/${made.id}/result`, vpsToken, { sealed: sealedResult, vpsPub: keys.pub, tunnel: { vps: sha256hex(tunnel.vps), app: sha256hex(tunnel.app) } })).status).toBe(200);

    const agent = createTunnelAgent({ base, id: made.id, key: tunnel.key, token: tunnel.vps, server: { host: "127.0.0.1", port: fakePort }, log: () => {} });
    const running = agent.run();
    const proxy = createTunnelProxy({ base, id: made.id, key: tunnel.key, token: tunnel.app });
    const origin = await proxy.start();
    expect(origin).toMatch(new RegExp(`^http://vps-${made.id}\\.localhost:\\d+$`));
    const port = new URL(origin).port;
    // fetch cannot send a *.localhost host to 127.0.0.1 by name everywhere, so set the host header the browser would
    const call = (path, init = {}) => new Promise((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: `vps-${made.id}.localhost:${port}`, ...init.headers } }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => { chunks.push(chunk); init.onChunk?.(chunk.toString()); });
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.end(init.body);
      });
    });

    const got = await call("/api/bots?x=1", { headers: { origin: `http://vps-${made.id}.localhost:${port}` } });
    expect(got.status).toBe(200);
    expect(JSON.parse(got.text).url).toBe("/api/bots?x=1");
    expect(got.headers["set-cookie"]?.[0]).toContain("omb_session=abc");
    const arrived = seen.find((entry) => entry.url === "/api/bots?x=1");
    expect(arrived.headers["x-forwarded-for"]).toBe("192.0.2.10");
    expect(arrived.headers.host).toBe(`vps-${made.id}.localhost:${port}`);

    const big = "z".repeat(3 * 1024 * 1024);
    const posted = await call("/api/upload", { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(big.length) }, body: big });
    expect(JSON.parse(posted.text).echo).toBe(big.length);
    // a proxy in front of the link service (nginx: 1 MB by default) never sees a bigger body
    expect(largestPost).toBeLessThan(1_000_000);

    const pieces = [];
    const stream = await call("/events", { onChunk: (text) => pieces.push(text) });
    expect(stream.text).toBe("data: one\n\ndata: two\n\n");
    expect(pieces.length).toBeGreaterThanOrEqual(2);

    expect(await proxy.control("ping")).toEqual({ ok: true });
    await expect(proxy.control("nope")).rejects.toThrow("unknown request");

    expect((await call("/x", { headers: { host: "evil.example:1" } })).status).toBe(421);

    await relay.forget(made.id, tunnel.app);
    expect(await running).toBe("unlinked");
    await proxy.close();
  }, 20_000);

  it("can be ended from the server too (uninstall.sh), with its own token and nothing else", async () => {
    const relay = createRelayClient({ base });
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    const vpsToken = vpsTokenOf(keys.secret);
    await post(`/v1/sessions/${made.id}/claim`, vpsToken, {});
    const tunnel = { vps: "w".repeat(43), app: "b".repeat(43) };
    await post(`/v1/sessions/${made.id}/result`, vpsToken, { sealed: seal(Buffer.alloc(32), made.id, Buffer.from("{}")), vpsPub: keys.pub, tunnel: { vps: sha256hex(tunnel.vps), app: sha256hex(tunnel.app) } });
    const drop = (token) => fetch(`${base}/v1/tunnels/${made.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect((await drop("x".repeat(43))).status).toBe(404);
    expect((await drop(vpsToken)).status).toBe(404);
    expect((await drop(tunnel.vps)).status).toBe(200);
    // gone for the app too: its reads say unlinked
    expect((await fetch(`${base}/v1/tunnels/${made.id}/to-app`, { headers: { authorization: `Bearer ${tunnel.app}` } })).status).toBe(404);
    expect((await drop(tunnel.vps)).status).toBe(404);
  });
});

describe("relay tunnel websockets (the live desktop)", () => {
  it("seals a stream's bytes raw, and both ends open each other's", () => {
    const key = randomBytes(32);
    const bytes = randomBytes(5000);
    const fromApp = agentOpenFrame(key, "abcdefghij", "to-vps", sealBytes(key, "abcdefghij", "to-vps", "r".repeat(12), bytes), frameGuard());
    expect(fromApp.t).toBe("bytes");
    expect(fromApp.r).toBe("r".repeat(12));
    expect(Buffer.compare(fromApp.b, bytes)).toBe(0);
    const sealed = agentSealBytes(key, "abcdefghij", "to-app", "s".repeat(12), bytes);
    // raw, not base64 in json: about a third over the bytes for base64url, not two thirds
    expect(sealed.length).toBeLessThan(bytes.length * 1.4);
    const guard = frameGuard();
    expect(Buffer.compare(openFrame(key, "abcdefghij", "to-app", sealed, guard).b, bytes)).toBe(0);
    expect(openFrame(key, "abcdefghij", "to-app", sealed, guard)).toBeNull();
    expect(() => openFrame(key, "abcdefghij", "to-vps", sealed)).toThrow();
  });

  it("carries a websocket both ways, binary-safe and in order, under the relay's post limit, and closes it from either end", async () => {
    const tunnel = await openTunnel();
    largestPost = 0;
    const ws = await upgrade(tunnel, "/ws/echo?botId=b1");
    expect(ws.status).toBe(101);
    expect(ws.headers.upgrade).toBe("websocket");
    expect(ws.headers["sec-websocket-accept"]).toBeTruthy();
    const arrived = seen.find((entry) => entry.upgrade && entry.url === "/ws/echo?botId=b1");
    expect(arrived.headers["x-forwarded-for"]).toBe("192.0.2.10");
    expect(arrived.headers.origin).toBe(`http://vps-${tunnel.id}.localhost:${tunnel.port}`);

    // small writes (pointer and keys) come back quickly; then a few megabytes (a desktop's frames) come back whole
    const small = Buffer.from([0x05, 0x00, 0x01, 0x02]);
    const echoed = [];
    ws.socket.on("data", (chunk) => echoed.push(chunk));
    const started = Date.now();
    ws.socket.write(small);
    await expect.poll(() => Buffer.concat(echoed).length, { timeout: 5000 }).toBe(small.length);
    expect(Date.now() - started).toBeLessThan(1000);
    const big = randomBytes(3 * 1024 * 1024 + 17);
    for (let at = 0; at < big.length; at += 60_000) ws.socket.write(big.subarray(at, at + 60_000));
    await expect.poll(() => Buffer.concat(echoed).length, { timeout: 15_000 }).toBe(small.length + big.length);
    expect(Buffer.compare(Buffer.concat(echoed).subarray(small.length), big)).toBe(0);
    expect(largestPost).toBeLessThan(1_000_000);

    const closed = new Promise((resolve) => ws.socket.once("close", resolve));
    ws.socket.destroy();
    await closed;
    await tunnel.close();
  }, 30_000);

  it("passes a refused handshake on as the server's answer, and refuses a wrong host", async () => {
    const tunnel = await openTunnel();
    const refused = await upgrade(tunnel, "/ws/not-yours");
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text).error).toContain("Take control");
    expect((await upgrade(tunnel, "/ws/echo", "evil.example:1")).status).toBe(421);
    await tunnel.close();
  }, 20_000);
});
