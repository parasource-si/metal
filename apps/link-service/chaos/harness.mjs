// the pieces of the chaos run: two real link service nodes behind tls (h2, like nginx) and a fault layer each, a stand-in
// bot server, the real agent (`agent.mjs link` then `tunnel`, restarted like systemd does) and the app's real relay code
// in its own process. everything listens on loopback.
import { execFileSync, fork, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, Agent } from "node:http";
import { createSecureServer } from "node:http2";
import { createServer as createTcpServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const linkRoot = fileURLToPath(new URL("..", import.meta.url));
export const chaosDir = fileURLToPath(new URL(".", import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const PEER_TOKEN = "chaos-peer-token-".padEnd(40, "p");
export const STATS_TOKEN = "chaos-stats-token-".padEnd(40, "s");

/** a free tcp port on loopback */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** a throwaway ca and a certificate for localhost and 127.0.0.1 signed by it; `NODE_EXTRA_CA_CERTS` trusts the ca */
export function makeCerts(dir) {
  const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  const read = (name) => readFileSync(join(dir, name));
  try { return { ca: join(dir, "ca.pem"), key: read("site.key"), cert: read("site.pem"), fakeKey: read("fake.key"), fakeCert: read("fake.pem") }; } catch {}
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=chaos ca", "-keyout", "ca.key", "-out", "ca.pem"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nbasicConstraints=CA:FALSE\n");
  run(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=localhost", "-keyout", "site.key", "-out", "site.csr"]);
  run(["x509", "-req", "-in", "site.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "ext.cnf", "-out", "site.pem"]);
  // a second, untrusted certificate: what a captive portal or an intercepting proxy shows
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-keyout", "fake.key", "-out", "fake.pem"]);
  return { ca: join(dir, "ca.pem"), key: read("site.key"), cert: read("site.pem"), fakeKey: read("fake.key"), fakeCert: read("fake.pem") };
}

/** listens on both loopbacks at one port (`localhost` resolves to ::1 first on some systems) */
async function listenBoth(make, port) {
  const v4 = make();
  await new Promise((resolve, reject) => { v4.once("error", reject); v4.listen(port, "127.0.0.1", resolve); });
  const v6 = make();
  await new Promise((resolve) => { v6.once("error", () => resolve()); v6.listen(v4.address().port, "::1", resolve); });
  return { port: v4.address().port, servers: [v4, v6].filter((one) => one.listening) };
}

/**
 * the network in front of one node: a tcp proxy whose behaviour changes on demand.
 *   pass      forward (optional latencyMs, jitterMs, bytesPerSec)
 *   down      not listening: connection refused
 *   blackhole accepts and never answers; open connections go silent too
 *   impostor  new connections reach a tls server with a certificate nobody trusts (captive portal, intercepting proxy)
 * `cut()` drops every open connection at once (a network switch).
 */
export async function createFaultProxy({ port = 0, target, impostor }) {
  const conns = new Set();
  let mode = "pass", latencyMs = 0, jitterMs = 0, bytesPerSec = 0, listening = null;
  const stats = { accepted: 0, perSecond: new Map() };
  const delayFor = () => latencyMs + Math.random() * jitterMs;
  function pipeSlow(from, to, pair) {
    // latency shifts each chunk by the same delay (plus jitter, never reordering); a rate limit spaces them out. one
    // queue and one timer per direction keep the bytes in order
    let lastDue = 0, held = 0, timer = null, ended = false;
    const queue = [];
    const pump = () => {
      timer = null;
      while (queue.length && queue[0].due <= Date.now()) {
        const { chunk } = queue.shift();
        held -= chunk.length;
        if (!to.destroyed && !pair.stranded && mode !== "blackhole") to.write(chunk);
      }
      if (held <= 256 * 1024) from.resume();
      if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].due - Date.now()));
      else if (ended && !to.destroyed) to.end();
    };
    from.on("data", (chunk) => {
      if (mode === "blackhole" || pair.stranded) return;
      const extra = delayFor(), rate = bytesPerSec ? (chunk.length / bytesPerSec) * 1000 : 0;
      if (!extra && !rate && !queue.length) { if (!to.destroyed) to.write(chunk); return; }
      const due = Math.max(Date.now() + extra, lastDue) + rate;
      lastDue = due;
      queue.push({ chunk, due });
      held += chunk.length;
      if (held > 1024 * 1024) from.pause();
      if (!timer) timer = setTimeout(pump, Math.max(0, queue[0].due - Date.now()));
    });
    from.on("end", () => { ended = true; if (!queue.length && !to.destroyed) to.end(); });
  }
  function onConnection(client) {
    stats.accepted += 1;
    const second = Math.floor(Date.now() / 1000);
    stats.perSecond.set(second, (stats.perSecond.get(second) ?? 0) + 1);
    client.on("error", () => {});
    if (mode === "blackhole") { const held = { destroy: () => client.destroy() }; conns.add(held); client.on("close", () => conns.delete(held)); return; }
    const upstream = tcpConnect(mode === "impostor" ? impostor : target, "127.0.0.1");
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    const pair = { client, upstream, destroy: () => { client.destroy(); upstream.destroy(); } };
    conns.add(pair);
    client.on("close", () => conns.delete(pair));
    pipeSlow(client, upstream, pair);
    pipeSlow(upstream, client, pair);
  }
  async function listen() {
    if (listening) return;
    listening = await listenBoth(() => createTcpServer({ noDelay: true }, onConnection), port);
    port = listening.port;
  }
  function cut() { for (const one of conns) one.destroy(); conns.clear(); }
  // what a network switch does to connections made on the old network: they go silent, nothing is closed
  function strand() { for (const one of conns) one.stranded = true; }
  await listen();
  return {
    get port() { return port; },
    stats,
    async set(next, options = {}) {
      ({ latencyMs = 0, jitterMs = 0, bytesPerSec = 0 } = options);
      if (next === "down") {
        mode = "down";
        if (listening) { for (const server of listening.servers) server.close(); listening = null; }
        cut();
        return;
      }
      if (next === "blackhole") cut();
      mode = next;
      await listen();
    },
    mode: () => mode,
    cut,
    strand,
    async close() { if (listening) for (const server of listening.servers) server.close(); listening = null; cut(); },
  };
}

/** a corporate network's only way out: an http proxy that tunnels with CONNECT and counts the tunnels */
export async function createConnectProxy() {
  let tunnels = 0;
  const open = new Set();
  const server = createHttpServer((req, res) => { res.writeHead(403); res.end("CONNECT only"); });
  server.on("connect", (req, client, head) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    const [host, port] = String(req.url).split(/:(?=\d+$)/);
    const upstream = tcpConnect(Number(port), host === "localhost" ? "127.0.0.1" : host, () => {
      tunnels += 1;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, tunnels: () => tunnels, close: () => new Promise((resolve) => { for (const socket of open) socket.destroy(); server.closeAllConnections?.(); server.close(resolve); }) };
}

/** a tls server with an untrusted certificate that answers every request with a login page */
export async function createImpostor({ key, cert }) {
  const server = createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>sign in to the wifi</body></html>"); });
  server.on("error", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * nginx's part: tls with h2 and http/1.1 in front of a node's plain http port, streaming both ways.
 * `fault`: null, "5xx" (every request answers 502, as nginx does with the node gone), "sync" (the copy between nodes fails)
 */
export async function createFront({ key, cert, target, listen = [["127.0.0.1", 0]] }) {
  let fault = null;
  const agent = new Agent({ keepAlive: true, maxSockets: 4096 });
  const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "http2-settings", "te", "host"]);
  const perSecond = new Map();
  const server = createSecureServer({ key, cert, allowHTTP1: true, settings: { initialWindowSize: 4 * 1024 * 1024 } }, (req, res) => {
    const path = req.url;
    const second = Math.floor(Date.now() / 1000);
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    if (fault === "5xx" || (fault === "sync" && path.startsWith("/internal/"))) {
      // nginx reads and drops the body it will not pass on; an h2 body left unread holds the connection's window
      req.resume();
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html><body>502 Bad Gateway</body></html>");
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!name.startsWith(":") && !HOP.has(name)) headers[name] = value;
    headers.host = req.headers[":authority"] ?? req.headers.host ?? "localhost";
    // one made-up address per client connection: the nodes count requests per address
    const remote = req.socket?.remotePort ?? 0;
    headers["x-forwarded-for"] = `10.${(remote >> 8) & 255}.${remote & 255}.7`;
    const up = httpRequest({ host: "127.0.0.1", port: target, method: req.method, path, headers, agent }, (answer) => {
      const out = {};
      for (const [name, value] of Object.entries(answer.headers)) if (!HOP.has(name)) out[name] = value;
      res.writeHead(answer.statusCode, out);
      answer.pipe(res);
      answer.on("error", () => res.destroy());
    });
    up.on("error", () => {
      if (!res.headersSent) { res.writeHead(502, { "content-type": "text/html" }); res.end("<html><body>502 Bad Gateway</body></html>"); }
      else res.destroy();
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  });
  server.on("error", () => {});
  server.on("sessionError", () => {});
  const extra = [];
  await new Promise((resolve) => server.listen(listen[0][1], listen[0][0], resolve));
  // further addresses (the nat lab's v6) get servers of their own on the same handler
  for (const [host, at] of listen.slice(1)) {
    const more = createSecureServer({ key, cert, allowHTTP1: true, settings: { initialWindowSize: 4 * 1024 * 1024 } }, (req, res) => server.emit("request", req, res));
    more.on("error", () => {});
    await new Promise((resolve) => more.listen({ port: at, host, ipv6Only: true }, resolve));
    extra.push(more);
  }
  return { port: server.address().port, perSecond, setFault: (next) => { fault = next; }, close: () => new Promise((resolve) => { server.close(resolve); agent.destroy(); }) };
}

/** a real link service node (src/server.mjs) as its own process, restartable on the same data folder */
export function createNode({ id, port, dataDir, nodes, base, env = {}, log = () => {} }) {
  let child = null, exits = 0;
  const lines = [];
  function start() {
    child = spawn(process.execPath, ["--import", join(chaosDir, "preload.mjs"), join(linkRoot, "src/server.mjs")], {
      env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1", LINK_DATA_DIR: dataDir, LINK_BASE: base, LINK_NODES: nodes, LINK_NODE_ID: id, LINK_PEER_TOKEN: PEER_TOKEN, LINK_STATS_TOKEN: STATS_TOKEN, DUSK_LINK_OPEN: "1", LINK_TRUST_PROXY: "1", NODE_EXTRA_CA_CERTS: join(dataDir, "..", "ca.pem") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (data) => { for (const line of String(data).split("\n").filter(Boolean)) { lines.push(`${new Date().toISOString().slice(11, 23)} ${line}`); log(`[${id}] ${line}`); } if (lines.length > 4000) lines.splice(0, 1000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const mine = child;
    mine.on("exit", () => { exits += 1; if (child === mine) child = null; });
    return waitHttp(`http://127.0.0.1:${port}/healthz`);
  }
  return {
    id, port, lines,
    start,
    alive: () => child !== null,
    async kill(signal = "SIGKILL") {
      const one = child;
      if (!one) return;
      one.kill("SIGCONT");
      one.kill(signal);
      const exited = new Promise((resolve) => (one.exitCode !== null || one.signalCode ? resolve() : one.once("exit", resolve)));
      // a graceful stop that does not finish in 5 s is not graceful
      const late = setTimeout(() => one.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(late);
    },
    pause() { child?.kill("SIGSTOP"); },
    resume() { child?.kill("SIGCONT"); },
    exits: () => exits,
  };
}

export async function waitHttp(url, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch {}
    if (Date.now() > end) throw new Error(`${url} did not come up`);
    await sleep(100);
  }
}

/** bytes that are the same every time for a given length, so a download can be checked without keeping a copy */
export function patternBytes(length) {
  const block = createHash("sha256").update("chaos").digest();
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += block.length) block.copy(out, i, 0, Math.min(block.length, length - i));
  return out;
}

/**
 * stands in for Metal on the server: what the agent needs to link, a json ping, a live event stream, a big download,
 * an upload that answers its hash, a websocket echo. `restart()` drops it for a moment like a server upgrade does.
 */
export async function createBotServer({ port: wanted = 0 } = {}) {
  let server = null, port = wanted, down = false, phone = null, phoneAgentPub = null;
  const big = new Map();
  const streams = new Set();
  const handler = (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/auth/pairing") return json(res, { code: "CHAO-SXXX-0001", expiresAt: Date.now() + 600_000 });
    if (url.pathname === "/.well-known/duskbot/environment") return json(res, { environmentId: "6f1c2d3e-0000-4000-8000-00000000c4a5", version: "chaos" });
    if (url.pathname === "/api/ping") return json(res, { ok: true, at: Date.now() });
    if (url.pathname === "/api/slow") { const ms = Number(url.searchParams.get("ms") ?? 1000); setTimeout(() => json(res, { ok: true }), ms); return; }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": hello\n\ndata: 0\n\n");
      let n = 0;
      const timer = setInterval(() => res.write(`data: ${++n}\n\n`), 1000);
      streams.add(res);
      res.on("close", () => { clearInterval(timer); streams.delete(res); });
      return;
    }
    if (url.pathname === "/api/big") {
      const length = Number(url.searchParams.get("bytes") ?? 1e6);
      if (!big.has(length)) big.set(length, patternBytes(length));
      // like a file the server serves: a strong validator and byte ranges
      const etag = `"big-${length}"`, range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ""));
      if (range && (!req.headers["if-range"] || req.headers["if-range"] === etag) && Number(range[1]) < length) {
        const from = Number(range[1]);
        res.writeHead(206, { "content-type": "application/octet-stream", "content-length": String(length - from), "content-range": `bytes ${from}-${length - 1}/${length}`, "accept-ranges": "bytes", etag });
        return res.end(big.get(length).subarray(from));
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(length), "accept-ranges": "bytes", etag });
      return res.end(big.get(length));
    }
    if (url.pathname === "/api/upload" && req.method === "POST") {
      const hash = createHash("sha256");
      let length = 0;
      req.on("data", (chunk) => { hash.update(chunk); length += chunk.length; });
      req.on("end", () => json(res, { length, sha256: hash.digest("hex") }));
      return;
    }
    if (url.pathname === "/api/mobile/relay/sync") {
      // the server's side of phone pairing: the channels it hands the agent (one phone, when the run set one)
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if (typeof body.pub === "string") phoneAgentPub = body.pub;
        const answer = () => json(res, { rev: phone ? 1 : 0, channels: phone ? [phone] : [] });
        if ((body.applied ?? 0) >= (phone ? 1 : 0) && body.wait > 0) { const timer = setTimeout(answer, Math.min(body.wait, 20) * 1000); res.on("close", () => clearTimeout(timer)); }
        else answer();
      });
      return;
    }
    return json(res, { error: "not here" }, 404);
  };
  const onUpgrade = (req, socket, head) => {
    if (!req.url.startsWith("/ws/echo")) return socket.destroy();
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.pipe(socket);
  };
  async function start() {
    server = createHttpServer(handler);
    server.on("upgrade", onUpgrade);
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    port = server.address().port;
    down = false;
  }
  await start();
  return {
    get port() { return port; },
    isDown: () => down,
    /** a phone channel to hand the agent ({ id, verifier, kind: "device", pub }), and the agent's key it sent */
    setPhone(channel) { phone = channel; },
    agentPub: () => phoneAgentPub,
    async stop() { down = true; for (const res of streams) res.destroy(); await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }); },
    start,
    close() { server?.closeAllConnections?.(); server?.close(); },
  };
}
const json = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

/**
 * the real agent, `link` once and then `tunnel` under a supervisor that restarts it like systemd (Restart=always,
 * RestartSec=5). `env` adds to the agent's environment; `skewMs` moves its clock.
 */
export function createAgent({ home, serverPort, ca, restartMs = 5000, env = {}, log = () => {} }) {
  const agentPath = join(linkRoot, "agent.mjs");
  const preload = join(chaosDir, "preload.mjs");
  let child = null, stopped = false, starts = 0, skewMs = 0;
  const lines = [];
  const baseEnv = () => ({
    ...process.env, HOME: home, NODE_EXTRA_CA_CERTS: ca, LINK_SERVER_PORT: String(serverPort),
    DUSK_LINK_DIRECT: "off", DUSK_RELAY_URL: "off", DUSK_LINK_SERVER_UPDATES: "off", DUSK_LINK_UPDATES: "off", DUSK_LINK_PHONES: "off",
    DUSK_CHAOS_SKEW_MS: String(skewMs), ...env,
  });
  const keep = (data) => { for (const line of String(data).split("\n").filter(Boolean)) { lines.push(`${new Date().toISOString().slice(11, 23)} ${line}`); log(`[agent] ${line}`); } if (lines.length > 4000) lines.splice(0, 1000); };
  function launch(args, extra = {}) {
    const one = fork(agentPath, args, { env: { ...baseEnv(), ...extra }, execArgv: ["--import", preload], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    one.stdout.on("data", keep);
    one.stderr.on("data", keep);
    return one;
  }
  function run() {
    if (stopped) return;
    starts += 1;
    const one = launch(["tunnel"]);
    child = one;
    one.on("exit", (code, signal) => {
      keep(`(exited ${code ?? signal})`);
      if (child === one) child = null;
      if (!stopped) setTimeout(run, restartMs).unref?.();
    });
  }
  return {
    lines,
    async link(extra) {
      const one = launch(["link"], extra);
      const code = await new Promise((resolve) => one.on("exit", resolve));
      if (code !== 0) throw new Error(`agent link exited ${code}: ${lines.slice(-5).join(" | ")}`);
    },
    start() { stopped = false; run(); },
    async stop() { stopped = true; const one = child; if (one) { one.kill("SIGTERM"); await new Promise((resolve) => (one.exitCode !== null || one.signalCode ? resolve() : one.once("exit", resolve))); } },
    async restart() { const one = child; if (one) { one.kill("SIGKILL"); await new Promise((resolve) => one.once("exit", resolve)); } },
    pause() { child?.kill("SIGSTOP"); },
    resume() { child?.kill("SIGCONT"); },
    send(message) { child?.send?.(message); },
    setSkew(ms) { skewMs = ms; },
    starts: () => starts,
    nodesFile: () => { try { return JSON.parse(readFileSync(join(home, ".config/duskbot-link/nodes.json"), "utf8")); } catch { return null; } },
  };
}

/** the app's real relay code (electron/vps-link-protocol.mjs createTunnelProxy, follow on) in its own process */
export function createApp({ link, ca, log = () => {}, runner = "app-runner.mjs" }) {
  let child = null, origin = null, exited = false;
  const lines = [];
  const pending = new Map();
  let seq = 0;
  function start() {
    exited = false;
    child = fork(join(chaosDir, runner), [], { env: { ...process.env, NODE_EXTRA_CA_CERTS: ca }, execArgv: ["--import", join(chaosDir, "preload.mjs"), "--import", join(chaosDir, "ts-hooks.mjs")], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const keep = (data) => { for (const line of String(data).split("\n").filter(Boolean)) { lines.push(`${new Date().toISOString().slice(11, 23)} ${line}`); log(`[app] ${line}`); } if (lines.length > 4000) lines.splice(0, 1000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("message", (message) => { const done = pending.get(message.seq); if (done) { pending.delete(message.seq); done(message); } });
    child.on("exit", () => { exited = true; });
    return call("start", link).then((answer) => { origin = answer.origin; return origin; });
  }
  function call(op, data) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, (message) => (message.error ? reject(new Error(message.error)) : resolve(message.data)));
      child.send({ seq: id, op, data });
    });
  }
  return {
    lines,
    start,
    origin: () => origin,
    host: () => new URL(origin).host,
    call,
    nudge: () => call("nudge"),
    send(message) { child?.send?.(message); },
    node: () => call("node"),
    pause() { child?.kill("SIGSTOP"); },
    resume() { child?.kill("SIGCONT"); },
    async close() { if (!child || exited) return; await call("close").catch(() => {}); child.kill("SIGTERM"); },
  };
}

/** a fresh scratch folder */
export function scratch(prefix = "dusk-chaos-") { return mkdtempSync(join(tmpdir(), prefix)); }
export function removeScratch(dir) { rmSync(dir, { recursive: true, force: true }); }
export { mkdirSync, randomBytes };
