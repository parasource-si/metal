import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { pollServerIdentity } from "./server-boot-probe.mjs";
import { freePort, installRoot, pickServerPort, portTaken, reapServer, strandedServer, strandedServerOn } from "./server-port.mjs";

const APP = "/Applications/dusk bot.app/Contents/MacOS/dusk bot";
const HELPER = "/Applications/dusk bot.app/Contents/Frameworks/dusk bot Helper.app/Contents/MacOS/dusk bot Helper --type=utility --utility-sub-type=node.mojom.NodeService";

function listen(server) {
  return new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(server.address().port)));
}
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

test("a port another program answers on is taken; a free one is not", async (t) => {
  const other = net.createServer();
  const port = await listen(other);
  t.after(() => close(other));
  assert.equal(await portTaken(port), true);
  assert.equal(await portTaken(await freePort()), false);
});

test("port taken by another program: the server starts on the next port and the app connects to it", async (t) => {
  // another app's server on the first desktop port, answering health checks as if it were Metal
  const other = http.createServer((_req, res) => res.end(JSON.stringify({ app: "duskbot" })));
  const first = await listen(other);
  t.after(() => close(other));
  const second = await freePort();
  const lines = [];
  const { port, busy } = await pickServerPort([first, second], { log: (line) => lines.push(line) });
  assert.equal(port, second);
  assert.deepEqual(busy, [first]);
  assert.match(lines.join("\n"), new RegExp(`port ${first} is in use by another program`));

  const ours = http.createServer((_req, res) => res.end(JSON.stringify({ app: "duskbot", pid: process.pid, static: true })));
  await new Promise((resolve) => ours.listen({ host: "127.0.0.1", port }, resolve));
  t.after(() => close(ours));
  const identity = await pollServerIdentity({ port, pid: () => process.pid, bootTimeoutMs: 5_000 });
  assert.equal(identity.outcome, "ready");
});

test("every desktop port taken: the system picks a free one instead of giving up", async (t) => {
  const servers = [net.createServer(), net.createServer()];
  const ports = await Promise.all(servers.map(listen));
  t.after(() => Promise.all(servers.map(close)));
  const { port, busy } = await pickServerPort(ports);
  assert.deepEqual(busy, ports);
  assert.ok(port > 0 && !ports.includes(port));
  assert.equal(await portTaken(port), false);
});

test("a server an earlier launch left behind is stopped and its port reused", async () => {
  const reaped = [];
  const result = await pickServerPort([8799, 18799], {
    taken: async (port) => port === 8799 && reaped.length === 0,
    stranded: async (port) => (port === 8799 ? 4321 : null),
    reap: async (pid, port) => { reaped.push([pid, port]); return true; },
  });
  assert.deepEqual(result, { port: 8799, busy: [], reaped: 4321 });
  assert.deepEqual(reaped, [[4321, 8799]]);
});

test("a stranded server that won't stop leaves its port skipped", async () => {
  const result = await pickServerPort([8799, 18799], {
    taken: async (port) => port === 8799,
    stranded: async () => 4321,
    reap: async () => false,
  });
  assert.deepEqual(result, { port: 18799, busy: [8799] });
});

test("only an orphaned utility process of this same install counts as stranded", () => {
  const root = installRoot(APP, "darwin");
  assert.equal(root, "/Applications/dusk bot.app/");
  assert.equal(installRoot("/opt/dusk bot/duskbot", "linux"), "/opt/dusk bot/");
  assert.equal(strandedServer({ command: HELPER, parentCommand: "" }, root), true, "parent gone");
  assert.equal(strandedServer({ command: HELPER, parentCommand: "/sbin/launchd" }, root), true, "adopted by launchd");
  assert.equal(strandedServer({ command: HELPER, parentCommand: APP }, root), false, "a running copy of the app keeps its server");
  assert.equal(strandedServer({ command: HELPER.replace("/Applications/dusk bot.app", "/Applications/Other.app"), parentCommand: "" }, root), false, "another install");
  assert.equal(strandedServer({ command: `${APP} --type=gpu-process`, parentCommand: "" }, root), false, "not a utility process");
  assert.equal(strandedServer({ command: "/usr/local/bin/node server.js", parentCommand: "" }, root), false, "someone else's server");
});

test("strandedServerOn reads the listener and its parent from lsof and ps", async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "lsof") return "777\n";
    if (args.includes("ppid=")) return ` 1 ${HELPER}\n`;
    return "";
  };
  assert.equal(await strandedServerOn(8799, { execPath: APP, platform: "darwin", exec }), 777);
  assert.match(calls[0], /^lsof -nP -iTCP:8799 -sTCP:LISTEN -t$/);
  const running = async (file, args) => (file === "lsof" ? "777" : args.includes("ppid=") ? ` 555 ${HELPER}` : APP);
  assert.equal(await strandedServerOn(8799, { execPath: APP, platform: "darwin", exec: running }), null);
  assert.equal(await strandedServerOn(8799, { execPath: APP, platform: "win32", exec }), null, "never on Windows");
});

test("reapServer stops a real process holding the port and waits for the port to free", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1", () => console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  assert.equal(await portTaken(port), true);
  assert.equal(await reapServer(child.pid, port), true);
  assert.equal(await portTaken(port), false);
});
