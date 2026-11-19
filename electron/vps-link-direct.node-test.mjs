// the direct path: the app's half (vps-link-direct.mjs, vps-link-protocol.mjs) against the agent's real half
// (apps/link-service/agent.mjs serveDirect), with an in-memory pipe for the ssh channel and a small fake relay beside it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { control, createServing, directKeyLine, refreshDirectKey, serveDirect, setDirectKey } from "../apps/link-service/agent.mjs";
import { DIRECT_MAGIC, createDirectWriter, directReader, loadSsh2, newDirectKey, sshConnector } from "./vps-link-direct.mjs";
import { createTunnelProxy, openFrame, sealFrame } from "./vps-link-protocol.mjs";
import { createVpsLink } from "./vps-link.mjs";

const ID = "aaaaaaaaaa";
const KEY = Buffer.alloc(32, 7).toString("base64url");
const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** the plain records a writer wrote, for tests that look at the order on the wire */
function wire() {
  const records = [];
  const read = directReader((type, payload) => records.push({ type, text: payload.toString("latin1") }));
  read(DIRECT_MAGIC);
  return { records, write: (record) => { read(record); return true; } };
}
const plainWriter = (out, extra = {}) => createDirectWriter({
  sealFrame: (frame) => Buffer.from(`F:${frame.r ?? ""}:${frame.t}`), sealBytes: (r, bytes) => Buffer.from(`B:${r}:${bytes.length}`), write: out.write, ...extra,
});
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("fairness: an api frame goes out ahead of a desktop backlog, and the backlog waits for acks", async () => {
  const out = wire();
  const writer = plainWriter(out, { inflight: 64 * 1024 });
  writer.push({ t: "head", r: "desk" });
  writer.bytes("desk", Buffer.alloc(2 * 1024 * 1024));
  await turn();
  const sentBytes = () => out.records.filter((rec) => rec.text.startsWith("B:desk")).reduce((sum, rec) => sum + Number(rec.text.split(":")[2]), 0);
  assert.equal(sentBytes(), 64 * 1024, "only the in-flight allowance went out");
  writer.push({ t: "req", r: "api" });
  await turn();
  assert.equal(out.records.at(-1).text, "F:api:req", "the request did not wait behind the desktop");
  writer.acked(32 * 1024);
  await turn();
  assert.equal(sentBytes(), 96 * 1024);
});

test("fairness: streams take turns, and a stream's end never overtakes its own bytes", async () => {
  const out = wire();
  const writer = plainWriter(out);
  writer.bytes("one", Buffer.alloc(48 * 1024));
  writer.bytes("two", Buffer.alloc(48 * 1024));
  writer.push({ t: "end", r: "one" });
  await turn();
  const order = out.records.map((rec) => rec.text.split(":").slice(0, 2).join(":"));
  assert.deepEqual(order.slice(0, 4), ["B:one", "B:two", "B:one", "B:two"]);
  assert.equal(order.lastIndexOf("B:one") < order.indexOf("F:one"), true);
  assert.equal(order.filter((entry) => entry === "F:one").length, 1);
});

test("a reply's records go out as one write (sshd does not set nodelay for a channel without a pty)", async () => {
  const writes = [];
  const writer = createDirectWriter({ sealFrame: (frame) => Buffer.from(frame.t), sealBytes: (r, bytes) => bytes, write: (record) => { writes.push(record); return true; } });
  writer.push({ t: "head", r: "x" });
  writer.bytes("x", Buffer.from("hello"));
  writer.push({ t: "end", r: "x" });
  await turn();
  assert.equal(writes.length, 1);
});

/** a fake Metal, an in-memory ssh channel to the real agent half, and a fake relay that serves the same frames */
async function rig({ agentKey = KEY } = {}) {
  const seen = [];
  const slow = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, remote: req.headers["x-forwarded-for"], body: Buffer.concat(chunks).toString() });
      if (req.url === "/slow") { slow.push(res); return; }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
    });
  });
  const port = await listen(server);
  const target = { host: "127.0.0.1", port };

  // the relay: frames posted to-vps are served by the agent's own serving code; its replies wait for the app's poll
  const replies = [];
  let wake = null;
  const relayServing = createServing({ server: target, sink: {
    push: (frame) => { replies.push(sealFrame(Buffer.from(KEY, "base64url"), ID, "to-app", frame)); wake?.(); },
    bytes: (r, chunk) => { replies.push(sealFrame(Buffer.from(KEY, "base64url"), ID, "to-app", { t: "data", r, d: chunk.toString("base64") })); wake?.(); return true; },
    onDrain: (resume) => resume(), discard: () => {},
  } });
  const relayed = [];
  const fakeFetch = async (url, init = {}) => {
    if (init.method === "POST") {
      const { frames } = JSON.parse(init.body);
      for (const sealed of frames) { const frame = openFrame(Buffer.from(KEY, "base64url"), ID, "to-vps", sealed); relayed.push(frame); void relayServing.handle(frame); }
      return new Response('{"ok":true,"ordered":true}', { status: 200 });
    }
    if (!replies.length) await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 200); init.signal?.addEventListener("abort", resolve, { once: true }); });
    if (init.signal?.aborted) throw new Error("aborted");
    return new Response(JSON.stringify({ frames: replies.splice(0) }), { status: 200, headers: { "content-type": "application/json" } });
  };

  // the ssh channel: two pipes, tapped so the test can read what crossed
  const channels = [];
  const tapped = { up: [], down: [] };
  const connect = async () => {
    const up = new PassThrough(), down = new PassThrough();
    // tapped at write, so neither side's first bytes are read away before it listens (as an ssh channel buffers them)
    for (const [stream, into] of [[up, tapped.up], [down, tapped.down]]) {
      const write = stream.write.bind(stream);
      stream.write = (chunk, ...rest) => { into.push(Buffer.from(chunk)); return write(chunk, ...rest); };
    }
    const agent = serveDirect({ input: up, output: down, id: ID, key: agentKey, server: target, log: () => {} });
    const channel = { up, down, agent, close: () => { up.destroy(); down.destroy(); } };
    channels.push(channel);
    return { readable: down, writable: up, close: channel.close };
  };
  const proxy = createTunnelProxy({ base: "https://relay.test", id: ID, key: KEY, token: "t", fetch: fakeFetch, direct: { connect } });
  const origin = await proxy.start();
  const get = (path, method = "GET", body) => new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = request({ host: "127.0.0.1", port: url.port, path: url.pathname, method, headers: { host: url.host, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
  const close = async () => { await proxy.close(); for (const channel of channels) channel.close(); await new Promise((resolve) => server.close(resolve)); };
  return { proxy, get, seen, slow, relayed, channels, tapped, close };
}

test("transport selection: the relay until the direct path says hello, then direct; requests stay remote", async () => {
  const r = await rig();
  try {
    await until(() => r.proxy.transport() === "direct");
    const answer = await r.get("/api/thing");
    assert.equal(answer.status, 200);
    assert.equal(answer.text, "GET /api/thing ");
    assert.equal(r.relayed.filter((frame) => frame.t === "req").length, 0, "nothing went over the relay");
    assert.equal(r.seen.at(-1).remote, "192.0.2.10", "a direct request is still marked remote, never loopback trust");
    const posted = await r.get("/api/post", "POST", "payload-1234");
    assert.equal(posted.text, "POST /api/post payload-1234");
  } finally { await r.close(); }
});

test("sealing preserved: nothing readable crosses the direct channel, and only the tunnel key opens it", async () => {
  const r = await rig();
  try {
    await until(() => r.proxy.transport() === "direct");
    await r.get("/api/secret-path-xyz", "POST", "secret-body-xyz");
    const up = Buffer.concat(r.tapped.up), down = Buffer.concat(r.tapped.down);
    for (const needle of ["secret-path-xyz", "secret-body-xyz", "x-forwarded"]) {
      assert.equal(up.includes(needle), false);
      assert.equal(down.includes(needle), false);
    }
    const frames = [];
    directReader((type, payload) => { if (type === 1) frames.push(openFrame(Buffer.from(KEY, "base64url"), ID, "to-vps", payload)); })(up);
    assert.ok(frames.some((frame) => frame.t === "req" && frame.path === "/api/secret-path-xyz"));
    const wrong = Buffer.alloc(32, 9);
    directReader((type, payload) => { if (type === 1) assert.throws(() => openFrame(wrong, ID, "to-vps", payload)); })(up);
  } finally { await r.close(); }
});

test("identity: an agent without the tunnel key is never used, so requests keep the relay", async () => {
  const r = await rig({ agentKey: Buffer.alloc(32, 1).toString("base64url") });
  try {
    const answer = await r.get("/api/thing");
    assert.equal(answer.status, 200);
    assert.equal(r.proxy.transport(), "relay");
    assert.equal(r.relayed.filter((frame) => frame.t === "req").length, 1);
  } finally { await r.close(); }
});

test("a replayed record on the direct channel is refused by the agent", async () => {
  const r = await rig();
  try {
    await until(() => r.proxy.transport() === "direct");
    await r.get("/api/once", "POST", "x");
    const count = r.seen.filter((entry) => entry.url === "/api/once").length;
    // the same bytes again, as someone able to write into the channel would send them
    const channel = r.channels.at(-1);
    channel.up.write(Buffer.concat(r.tapped.up).subarray(DIRECT_MAGIC.length));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(r.seen.filter((entry) => entry.url === "/api/once").length, count);
  } finally { await r.close(); }
});

test("fallback: a lost direct path sends an unanswered GET again over the relay, and fails a POST", async () => {
  const r = await rig();
  try {
    await until(() => r.proxy.transport() === "direct");
    const pendingGet = r.get("/slow");
    const pendingPost = r.get("/slow", "POST", "not-twice");
    await until(() => r.slow.length === 2);
    r.channels.at(-1).close();
    const post = await pendingPost;
    assert.equal(post.status, 502, "a POST is never sent twice");
    await until(() => r.slow.length === 3);
    r.slow.at(-1).end("from the relay");
    const got = await pendingGet;
    assert.equal(got.status, 200);
    assert.equal(got.text, "from the relay");
    assert.equal(r.relayed.filter((frame) => frame.t === "req" && frame.method === "GET").length, 1);
    assert.equal(r.relayed.filter((frame) => frame.t === "req" && frame.method === "POST").length, 0);
    // and the direct path comes back by itself
    await until(() => r.proxy.transport() === "direct", 5000);
  } finally { await r.close(); }
});

test("identity pinned: sshd's host key must be one the agent sent, and the app's own key signs in", async () => {
  const { Server, utils } = loadSsh2();
  const hostKey = utils.generateKeyPairSync("ed25519");
  const otherHost = utils.generateKeyPairSync("ed25519");
  const appKey = newDirectKey();
  const allowed = utils.parseKey(appKey.publicKey);
  const sshd = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "publickey" && ctx.username === "maus" && ctx.key.algo === "ssh-ed25519" && ctx.key.data.equals(allowed.getPublicSSH())) {
        if (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      ctx.reject(["publickey"]);
    });
    client.on("ready", () => client.on("session", (accept) => accept().on("exec", (acceptExec) => { const stream = acceptExec(); stream.pipe(stream); })));
    client.on("error", () => {});
  });
  const port = await listen(sshd);
  try {
    const good = await sshConnector({ host: "127.0.0.1", port, user: "maus", privateKey: appKey.privateKey, hostKeys: [hostKey.public] })();
    good.writable.write("ping");
    const echo = await new Promise((resolve) => good.readable.once("data", resolve));
    assert.equal(echo.toString(), "ping");
    good.close();
    await assert.rejects(sshConnector({ host: "127.0.0.1", port, user: "maus", privateKey: appKey.privateKey, hostKeys: [otherHost.public] })(), (error) => error.code === "HOSTKEY");
    const stranger = newDirectKey();
    await assert.rejects(sshConnector({ host: "127.0.0.1", port, user: "maus", privateKey: stranger.privateKey, hostKeys: [hostKey.public] })(), (error) => error.level === "client-authentication");
  } finally { await new Promise((resolve) => sshd.close(resolve)); }
});

test("a direct ssh path that ends says why: the server's command exiting, what it said, or the connection going", async () => {
  const { Server, utils } = loadSsh2();
  const hostKey = utils.generateKeyPairSync("ed25519");
  const appKey = newDirectKey();
  let ending = null;
  const sshd = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("authentication", (ctx) => (ctx.method === "publickey" ? ctx.accept() : ctx.reject(["publickey"])));
    client.on("ready", () => client.on("session", (accept) => accept().on("exec", (acceptExec) => {
      const stream = acceptExec();
      ending = () => { stream.stderr.write("link direct: something broke\n"); stream.exit(3); stream.end(); };
    })));
    client.on("error", () => {});
  });
  const port = await listen(sshd);
  try {
    const link = await sshConnector({ host: "127.0.0.1", port, user: "maus", privateKey: appKey.privateKey, hostKeys: [hostKey.public] })();
    const closed = new Promise((resolve) => link.readable.once("close", resolve));
    link.readable.resume();
    await until(() => ending);
    ending();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(link.why(), /the server's direct command exited \(code 3\)/);
    assert.match(link.why(), /it said: link direct: something broke/);
    link.close();
  } finally { await new Promise((resolve) => sshd.close(resolve)); }
});

test("DUSK_LINK_DIRECT=off on the server refuses a key before touching anything", async () => {
  const before = process.env.DUSK_LINK_DIRECT;
  process.env.DUSK_LINK_DIRECT = "off";
  try { await assert.rejects(control("direct-key", { pub: newDirectKey().publicKey }, { id: ID }), /direct links are off/); }
  finally { if (before === undefined) delete process.env.DUSK_LINK_DIRECT; else process.env.DUSK_LINK_DIRECT = before; }
});

test("the agent's key line allows one forced command and nothing else, and leaves other keys alone", () => {
  const { publicKey } = newDirectKey();
  const line = directKeyLine({ pub: publicKey, id: ID, node: "/usr/bin/node", agent: "/opt/duskbot-link/agent.mjs" });
  assert.equal(line, `restrict,command="/usr/bin/node /opt/duskbot-link/agent.mjs direct" ${publicKey} omb-link-${ID}`);
  assert.throws(() => directKeyLine({ pub: `${publicKey}\nssh-ed25519 AAAA evil`, id: ID }));
  assert.throws(() => directKeyLine({ pub: "ssh-rsa AAAAB3NzaC1yc2E", id: ID }));
  assert.throws(() => directKeyLine({ pub: publicKey, id: ID, node: "/usr/bin/node\" evil" }));
  const dir = mkdtempSync(join(tmpdir(), "dusk-direct-key-"));
  try {
    const file = join(dir, ".ssh", "authorized_keys");
    setDirectKey(ID, null, file);
    setDirectKey(ID, line, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOWNERS person@laptop\n${readFileSync(file, "utf8")}`);
    setDirectKey(ID, line.replace(publicKey, newDirectKey().publicKey), file);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOWNERS person@laptop");
    // node moved (an upgrade): the line follows it at the agent's next start, the key itself unchanged
    const moved = { node: "/usr/local/bin/node", agent: "/opt/duskbot-link/agent.mjs" };
    assert.equal(refreshDirectKey(ID, file, moved), true);
    assert.match(readFileSync(file, "utf8"), /command="\/usr\/local\/bin\/node \/opt\/duskbot-link\/agent.mjs direct"/);
    assert.equal(refreshDirectKey(ID, file, moved), false);
    setDirectKey(ID, null, file);
    assert.equal(readFileSync(file, "utf8"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOWNERS person@laptop\n");
    assert.equal(refreshDirectKey(ID, file, moved), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the app asks a linked server for a direct key once, keeps it protected, and an older agent is asked later", async () => {
  const store = () => {
    let value = { v: 1, links: [{ id: ID, base: "https://relay.test", name: "box", mode: "relay", origin: null, port: null, keyP: `p:${KEY}`, tokenP: "p:t" }], current: ID };
    return { read: () => value, write: (next) => { value = JSON.parse(JSON.stringify(next)); }, get: () => value };
  };
  const make = (answer, saved) => {
    const used = [];
    const asked = [];
    const proxyFactory = () => ({
      start: async () => "http://vps-aaaaaaaaaa.localhost:1", close: async () => {}, nudge: () => {},
      control: async (op, data) => { asked.push({ op, data }); if (answer instanceof Error) throw answer; return answer; },
      useDirect: (spec) => used.push(spec),
    });
    const link = createVpsLink({
      base: "https://relay.test", serverFetch: async () => new Response("{}"), store: saved, protect: async (text) => `p:${text}`, unprotect: async (text) => text.slice(2),
      label: () => "Mac", saveServer: () => "env", forgetServer: () => {}, switchTo: () => {}, ownHome: { start: async () => {}, view: () => null, away: () => false, home: () => null, chosen: () => null },
      ownHomeReset: () => {}, localRequest: async () => new Response("{}"), backups: { save: async () => ({}), open: async () => ({}) },
      localCredentials: { codexAuth: async () => null, claudeCli: async () => null, claudeToken: async () => "" }, relaunch: () => {},
      proxyFactory, direct: { newKey: () => ({ privateKey: "PRIVATE-KEY", publicKey: "ssh-ed25519 PUB" }), connector: (config) => Object.assign(async () => ({}), { config }) },
    });
    return { link, used, asked };
  };
  const config = { v: 1, host: "203.0.113.10", port: 22, user: "maus", hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHOST"] };
  const saved = store();
  const first = make(config, saved);
  await first.link.resume();
  await until(() => first.used.length === 1);
  assert.deepEqual(first.asked.filter((one) => one.op !== "hello"), [{ op: "direct-key", data: { pub: "ssh-ed25519 PUB" } }]);
  const kept = saved.get().links[0].direct;
  assert.equal(kept.keyP, "p:PRIVATE-KEY", "the private key is stored only protected");
  assert.equal(kept.host, "203.0.113.10");
  assert.deepEqual(first.used[0].connect.config, { host: "203.0.113.10", port: 22, user: "maus", privateKey: "PRIVATE-KEY", hostKeys: config.hostKeys });
  await first.link.close();

  const again = make(config, saved);
  await again.link.resume();
  await until(() => again.used.length === 1);
  assert.deepEqual(again.asked.map((one) => one.op), ["hello"], "a saved direct path is used without asking again");
  await again.link.close();

  const old = store();
  const older = make(new Error("unknown request"), old);
  await older.link.resume();
  await until(() => old.get().links[0].directRefusedAt);
  assert.equal(older.used.length, 0);
  await older.link.close();
  const bad = store();
  const lying = make({ ...config, hostKeys: ["not a key"] }, bad);
  await lying.link.resume();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(lying.used.length, 0, "a reply that is not a usable config is never trusted");
  assert.equal(bad.get().links[0].direct, undefined);
  await lying.link.close();
});

test("the blocks shared with the agent are the same text on both sides", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const agent = read("../apps/link-service/agent.mjs");
  const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));
  for (const [file, from, to] of [
    ["./vps-link-direct.mjs", "/** each end writes this first", "// ---- end direct transport ----"],
    ["./vps-link-protocol.mjs", "export const sha256hex", "// ---- end shared crypto ----"],
    ["./vps-link-protocol.mjs", "/** how long a streamed read", "// ---- end relay transport ----"],
  ]) {
    const mine = between(read(file), from, to);
    assert.ok(mine.length > 200, `${from} found`);
    assert.equal(mine, between(agent, from, to), `${file} and the agent differ in "${from}"`);
  }
});

test("a wake abandons a relay poll stuck on a dead socket at once, instead of after its 40 s timeout", async () => {
  let polls = 0, resets = 0;
  const fakeFetch = Object.assign(async (url, init = {}) => {
    if (init.method === "POST") return new Response('{"ok":true}');
    polls += 1;
    await new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }, { reset: () => { resets += 1; } });
  const proxy = createTunnelProxy({ base: "https://relay.test", id: ID, key: KEY, token: "t", fetch: fakeFetch });
  await proxy.start();
  try {
    await until(() => polls === 1);
    proxy.nudge();
    await until(() => polls === 2, 500);
    assert.equal(resets, 1, "the keep-alive sockets are dropped too");
  } finally { await proxy.close(); }
});
