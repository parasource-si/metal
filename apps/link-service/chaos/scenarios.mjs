// what breaks, one at a time. each `run(world)` injects a fault, holds it, clears it (or not, when the point is that
// things route around it) and answers { clearedAt, pass, note, sees }. run.mjs measures the rest.
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { createTunnelAgent } from "../agent.mjs";
import { createRelayClient, createTunnelProxy, newLinkKeys, seal, sha256hex, vpsTokenOf } from "../../../electron/vps-link-protocol.mjs";
import { createConnectProxy, patternBytes, randomBytes, sleep } from "./harness.mjs";

const at = () => Date.now();
const homeNode = async (world) => (await world.homeOf()) ?? "contabo";
const other = (world, id) => world.ids.find((one) => one !== id);

/** node A dies and stays dead: its servers and apps must end up on node B */
async function failover(world, { kill = true } = {}) {
  const home = await homeNode(world);
  if (kill) await world.nodes[home].kill();
  else await world.net[home].set("blackhole");
  const started = at();
  while (at() - started < 200_000 && (await world.homeOf()) === home) await sleep(500);
  const moved = await world.homeOf();
  // stay on the fault until the app works on the new node, then bring the old one back
  while (at() - started < 200_000 && !world.probe.okNow()) await sleep(500);
  const workedAt = at();
  await world.reset();
  return { pass: moved !== home && moved !== null, note: `moved ${home} -> ${moved} in ${Math.round((workedAt - started) / 1000)} s`, clearedAt: started };
}

/** `count` more servers and apps on the default node, in this process: the agent's and the app's relay code each */
async function crowd(world, count) {
  const base = world.url("contabo"), relay = createRelayClient({ base }), out = [];
  for (let i = 0; i < count; i += 1) {
    const keys = newLinkKeys();
    const made = await relay.create({ verifier: keys.verifier, appPub: keys.pub });
    const vps = vpsTokenOf(keys.secret);
    const post = (path, body) => fetch(`${base}/v1/sessions/${made.id}/${path}`, { method: "POST", headers: { authorization: `Bearer ${vps}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("claim", {});
    const tunnel = { key: randomBytes(32).toString("base64url"), vps: randomBytes(32).toString("base64url"), app: randomBytes(32).toString("base64url") };
    const done = await post("result", { sealed: seal(Buffer.alloc(32), made.id, Buffer.from("{}")), vpsPub: keys.pub, tunnel: { vps: sha256hex(tunnel.vps), app: sha256hex(tunnel.app) } });
    if (!done.ok) throw new Error(`crowd link ${i} answered ${done.status}`);
    const agent = createTunnelAgent({ base, id: made.id, key: tunnel.key, token: tunnel.vps, server: { host: "127.0.0.1", port: world.bot.port }, log: () => {} });
    const running = agent.run();
    const proxy = createTunnelProxy({ base, id: made.id, key: tunnel.key, token: tunnel.app, follow: true });
    await proxy.start();
    out.push({ agent, running, proxy });
  }
  return { list: out, async close() { for (const one of out) { one.agent.stop(); await one.proxy.close(); await one.running.catch(() => {}); } } };
}

export const SCENARIOS = [
  {
    name: "reconnect-storm", title: "60 servers and apps on a node that restarts (down 5 s)", quick: true, budgetMs: 30_000,
    async run(world) {
      const many = await crowd(world, 60);
      try {
        const pingAll = async () => (await Promise.all(many.list.map((one) => one.proxy.control("ping", null, 4000).then(() => 1, () => 0)))).reduce((a, b) => a + b, 0);
        await sleep(3000);
        const before = await pingAll();
        world.fronts.contabo.perSecond.clear();
        await world.nodes.contabo.kill();
        await sleep(5000);
        await world.nodes.contabo.start();
        const back = at();
        let all = null;
        while (at() - back < 60_000) { if ((await pingAll()) === many.list.length) { all = at() - back; break; } await sleep(500); }
        // requests the node's proxy saw per second from the restart until all answered again
        const seconds = [...world.fronts.contabo.perSecond].filter(([second]) => second * 1000 >= back - 1000).map(([, count]) => count);
        const peak = Math.max(0, ...seconds);
        return { clearedAt: back, pass: before === many.list.length && all !== null, note: `${before}/${many.list.length} answered before; all again ${all === null ? "never" : `${(all / 1000).toFixed(1)} s`} after the node came back; peak ${peak} requests in one second at the node` };
      } finally { await many.close(); }
    },
  },
  {
    name: "cross-node", title: "a new server lives on the node the app did not link through", quick: true, budgetMs: 0,
    async run(world) {
      const other = await world.linkServer({ name: "far", placeOn: "oracle-in" });
      const started = at();
      let firstOk = null, failed = 0;
      try {
        for (let i = 0; i < 20; i += 1) {
          const port = Number(new URL(other.app.origin()).port);
          const answer = await world.probe.call("/api/ping", { port, host: other.app.host() });
          if (answer.status === 200) firstOk ??= at() - started; else failed += 1;
          await sleep(250);
        }
      } finally { await other.app.close(); await other.agent.stop(); }
      // the app may ask the node it linked through before the server's first read lands on the other one; it asks
      // again after 4 s of silence
      return { pass: firstOk !== null && firstOk < 10_000 && failed <= 1, note: firstOk === null ? "the app never reached it" : `first answer after ${firstOk} ms, ${failed} of 20 failed` };
    },
  },
  {
    name: "baseline", title: "nothing wrong (30 s)", quick: true, budgetMs: 0,
    async run() { await sleep(30_000); },
  },
  {
    name: "node-restart", title: "home node restarted (down 3 s)", quick: true, budgetMs: 20_000,
    async run(world) {
      const home = await homeNode(world);
      await world.nodes[home].kill();
      await sleep(3000);
      await world.nodes[home].start();
      return { clearedAt: at() };
    },
  },
  {
    name: "node-graceful-restart", title: "home node redeployed (SIGTERM, back in 8 s)", budgetMs: 20_000,
    async run(world) {
      const home = await homeNode(world);
      await world.nodes[home].kill("SIGTERM");
      await sleep(8000);
      await world.nodes[home].start();
      return { clearedAt: at() };
    },
  },
  {
    name: "node-dies", title: "home node dies for good: failover", quick: true, budgetMs: 120_000, recoverLimitMs: 300_000,
    run: (world) => failover(world),
  },
  {
    name: "node-blackhole", title: "home node unreachable, packets dropped (no refusal): failover", budgetMs: 120_000, recoverLimitMs: 300_000,
    run: (world) => failover(world, { kill: false }),
  },
  {
    name: "node-5xx", title: "home node's proxy answers 502 for 20 s", quick: true, budgetMs: 20_000,
    async run(world) {
      const home = await homeNode(world);
      world.fronts[home].setFault("5xx");
      await sleep(20_000);
      world.fronts[home].setFault(null);
      return { clearedAt: at() };
    },
  },
  {
    name: "node-frozen", title: "home node process frozen 20 s (accepts, never answers)", budgetMs: 30_000,
    async run(world) {
      const home = await homeNode(world);
      world.nodes[home].pause();
      await sleep(20_000);
      world.nodes[home].resume();
      return { clearedAt: at() };
    },
  },
  {
    name: "node-slow", title: "home node far away: +300 ms each way, jitter 150 ms (40 s)", budgetMs: 15_000,
    async run(world) {
      const home = await homeNode(world);
      await world.net[home].set("pass", { latencyMs: 300, jitterMs: 150 });
      await sleep(40_000);
      await world.net[home].set("pass");
      return { clearedAt: at() };
    },
  },
  {
    name: "node-paused", title: "home node paused by ops (relay_busy), server restarts", budgetMs: 120_000, recoverLimitMs: 300_000,
    async run(world) {
      const home = await homeNode(world);
      await world.limits(home, { paused: true });
      // a paused node keeps tunnels that are active; a server that restarts meets relay_busy
      await world.agent.restart();
      const started = at();
      while (at() - started < 150_000 && (await world.homeOf()) === home) await sleep(500);
      const moved = await world.homeOf();
      while (at() - started < 150_000 && !world.probe.okNow()) await sleep(500);
      await world.limits(home, { paused: false });
      return { pass: moved !== home, note: `${home} -> ${moved}`, clearedAt: started };
    },
  },
  {
    name: "both-down-one-back", title: "both nodes down 20 s, then only the other one back", budgetMs: 120_000, recoverLimitMs: 300_000,
    async run(world) {
      const home = await homeNode(world);
      const second = other(world, home);
      await Promise.all(world.ids.map((id) => world.nodes[id].kill()));
      await sleep(20_000);
      await world.nodes[second].start();
      const started = at();
      while (at() - started < 200_000 && !world.probe.okNow()) await sleep(500);
      const moved = await world.homeOf();
      await world.nodes[home].start();
      return { clearedAt: started, pass: moved === second, note: `on ${moved} with ${home} still down` };
    },
  },
  {
    name: "sync-lag", title: "copy between nodes fails 40 s, then home dies", budgetMs: 150_000, recoverLimitMs: 300_000,
    async run(world) {
      for (const id of world.ids) world.fronts[id].setFault("sync");
      await sleep(40_000);
      for (const id of world.ids) world.fronts[id].setFault(null);
      return failover(world);
    },
  },
  {
    name: "flapping", title: "home node flaps: 25 s down, 25 s up, three times", budgetMs: 120_000, recoverLimitMs: 300_000,
    async run(world) {
      const starts = world.agent.starts();
      for (let i = 0; i < 3; i += 1) {
        const home = await homeNode(world);
        await world.nodes[home].kill();
        await sleep(25_000);
        await world.nodes[home].start();
        await sleep(25_000);
      }
      const restarts = world.agent.starts() - starts;
      return { clearedAt: at(), pass: restarts <= 4, note: `agent restarted ${restarts} times` };
    },
  },
  {
    name: "server-restart", title: "Metal on the server restarts (down 6 s)", quick: true, budgetMs: 10_000,
    async run(world) {
      await world.bot.stop();
      await sleep(6000);
      await world.bot.start();
      return { clearedAt: at() };
    },
  },
  {
    name: "agent-upgrade", title: "link agent replaced mid-session (killed, systemd restarts it)", quick: true, budgetMs: 20_000,
    async run(world) {
      await world.agent.restart();
      return { clearedAt: at() };
    },
  },
  {
    name: "server-clock", title: "server clock 12 minutes fast", budgetMs: 20_000,
    async run(world) {
      world.agent.setSkew(12 * 60_000);
      await world.agent.restart();
      await sleep(25_000);
      world.agent.setSkew(0);
      await world.agent.restart();
      return { clearedAt: at() };
    },
  },
  {
    name: "server-disk-full", title: "server's agent folder not writable, agent restarts", budgetMs: 20_000,
    async run(world) {
      const folder = join(world.dir, "server-home", ".config", "duskbot-link");
      chmodSync(folder, 0o500);
      try {
        await world.agent.restart();
        await sleep(20_000);
      } finally { chmodSync(folder, 0o700); }
      return { clearedAt: at() };
    },
  },
  {
    name: "laptop-sleep", title: "laptop asleep 3 minutes, wakes (wake event)", budgetMs: 15_000,
    async run(world) {
      world.probe.hold();
      world.app.pause();
      await sleep(180_000);
      world.app.resume();
      const woke = at();
      world.probe.release();
      await world.app.nudge();
      return { clearedAt: woke, from: woke };
    },
  },
  {
    name: "laptop-sleep-no-event", title: "laptop asleep 2 minutes, no wake event", budgetMs: 30_000,
    async run(world) {
      world.probe.hold();
      world.app.pause();
      await sleep(120_000);
      world.app.resume();
      world.probe.release();
      return { clearedAt: at(), from: at() };
    },
  },
  {
    // the desktop app notices its own addresses change (network-switch-watched); this is the path without that help
    name: "network-switch", title: "wifi to hotspot, nothing tells the relay code: open connections go silent", budgetMs: 25_000,
    async run(world) {
      for (const id of world.ids) world.appNet[id].strand();
      return { clearedAt: at() };
    },
  },
  {
    name: "network-switch-watched", title: "wifi to hotspot, the app notices its addresses changed", quick: true, budgetMs: 10_000,
    async run(world) {
      for (const id of world.ids) world.appNet[id].strand();
      // electron/network-change.mjs looks every 3 s and waits for one more look
      await sleep(6000);
      await world.app.nudge();
      return { clearedAt: at() - 6000 };
    },
  },
  {
    name: "network-reset", title: "network drops every connection (reset)", budgetMs: 10_000,
    async run(world) {
      for (const id of world.ids) world.appNet[id].cut();
      return { clearedAt: at() };
    },
  },
  {
    name: "offline", title: "laptop offline 30 s, then online", quick: true, budgetMs: 15_000,
    async run(world) {
      for (const id of world.ids) await world.appNet[id].set("down");
      await sleep(30_000);
      for (const id of world.ids) await world.appNet[id].set("pass");
      return { clearedAt: at() };
    },
  },
  {
    name: "server-offline", title: "server's network down 40 s", budgetMs: 25_000,
    async run(world) {
      for (const id of world.ids) await world.agentNet[id].set("blackhole");
      await sleep(40_000);
      for (const id of world.ids) await world.agentNet[id].set("pass");
      return { clearedAt: at() };
    },
  },
  {
    name: "dns-fail", title: "laptop's dns fails 30 s (open connections stay)", budgetMs: 15_000,
    async run(world) {
      world.app.send({ chaos: "dns", mode: "fail" });
      for (const id of world.ids) world.appNet[id].cut();
      await sleep(30_000);
      world.app.send({ chaos: "dns", mode: null });
      return { clearedAt: at() };
    },
  },
  {
    name: "ipv4-only", title: "laptop on an ipv4-only network", budgetMs: 10_000,
    async run(world) {
      world.app.send({ chaos: "dns", mode: "v4" });
      for (const id of world.ids) world.appNet[id].cut();
      await sleep(15_000);
      return { clearedAt: at() };
    },
  },
  {
    name: "ipv6-only", title: "laptop on an ipv6-only network", budgetMs: 10_000,
    async run(world) {
      world.app.send({ chaos: "dns", mode: "v6" });
      for (const id of world.ids) world.appNet[id].cut();
      await sleep(15_000);
      return { clearedAt: at() };
    },
  },
  {
    name: "corporate-proxy", title: "laptop on a corporate network: nothing goes out but an https proxy (60 s)", quick: true, budgetMs: 15_000,
    async run(world) {
      const proxy = await createConnectProxy();
      try {
        await world.app.call("useProxy", { host: "127.0.0.1", port: proxy.port });
        for (const id of world.ids) await world.appNet[id].set("down");
        const started = at();
        // every connection made from here on is one through the proxy: the direct ones are gone
        await sleep(3000);
        while (at() - started < 45_000 && !world.probe.okNow()) await sleep(500);
        const reached = world.probe.okNow() ? at() - started : null;
        await sleep(15_000);
        const ok = world.probe.okNow();
        return { clearedAt: started, pass: reached !== null && ok && proxy.tunnels() > 0, note: `${reached === null ? "never worked" : `worked through the proxy after ${(reached / 1000).toFixed(1)} s`}, ${proxy.tunnels()} tunnels through it` };
      } finally {
        await world.app.call("useProxy", null);
        for (const id of world.ids) await world.appNet[id].set("pass");
        await proxy.close();
      }
    },
  },
  {
    name: "captive-portal", title: "captive portal intercepts https 30 s", budgetMs: 15_000,
    async run(world) {
      for (const id of world.ids) { await world.appNet[id].set("impostor"); world.appNet[id].cut(); }
      await sleep(30_000);
      for (const id of world.ids) await world.appNet[id].set("pass");
      return { clearedAt: at() };
    },
  },
  {
    name: "bad-network", title: "laptop on a bad network: 600 ms +/- 300 ms, 150 KB/s (60 s)", budgetMs: 15_000,
    async run(world) {
      for (const id of world.ids) await world.appNet[id].set("pass", { latencyMs: 600, jitterMs: 300, bytesPerSec: 150_000 });
      const started = at();
      const answer = await world.probe.call("/api/big?bytes=1000000", { timeoutMs: 60_000 });
      const ms = at() - started;
      const ok = answer.status === 200 && answer.body.equals(patternBytes(1_000_000));
      await sleep(Math.max(0, 60_000 - ms));
      for (const id of world.ids) await world.appNet[id].set("pass");
      return { clearedAt: at(), pass: ok, note: `1 MB download ${ok ? `ok in ${(ms / 1000).toFixed(1)} s` : `failed (${answer.status} ${answer.error ?? ""})`}` };
    },
  },
  {
    name: "big-transfers", title: "100 MB download and 40 MB upload through the relay", quick: true, budgetMs: 0,
    async run(world) {
      const size = 100 * 1024 * 1024;
      let started = at();
      const down = await world.probe.call(`/api/big?bytes=${size}`, { timeoutMs: 300_000 });
      const downMs = at() - started;
      const downOk = down.status === 200 && down.body.length === size && createHash("sha256").update(down.body).digest("hex") === createHash("sha256").update(patternBytes(size)).digest("hex");
      const body = patternBytes(40 * 1024 * 1024);
      started = at();
      const up = await world.probe.call("/api/upload", { method: "POST", body, timeoutMs: 300_000 });
      const upMs = at() - started;
      let upOk = false;
      try { const parsed = JSON.parse(up.body.toString("utf8")); upOk = parsed.length === body.length && parsed.sha256 === createHash("sha256").update(body).digest("hex"); } catch {}
      const rate = (bytes, ms) => `${((bytes / 1024 / 1024) / (ms / 1000)).toFixed(1)} MB/s`;
      return { pass: downOk && upOk, note: `down ${downOk ? rate(size, downMs) : `failed ${down.status} ${down.error ?? ""}`}, up ${upOk ? rate(body.length, upMs) : `failed ${up.status} ${up.error ?? up.body?.toString("utf8").slice(0, 80)}`}` };
    },
  },
  {
    name: "download-node-restart", title: "50 MB download while the home node restarts", budgetMs: 40_000,
    async run(world) {
      const size = 50 * 1024 * 1024;
      const home = await homeNode(world);
      const pending = world.probe.call(`/api/big?bytes=${size}`, { timeoutMs: 120_000 });
      await sleep(300);
      await world.nodes[home].kill();
      await sleep(3000);
      await world.nodes[home].start();
      const clearedAt = at();
      const answer = await pending;
      const whole = answer.status === 200 && answer.body.length === size;
      const intact = whole && answer.body.equals(patternBytes(size));
      if (whole && !intact) return { clearedAt, pass: false, note: "the first try finished with the wrong bytes" };
      const again = await world.probe.call(`/api/big?bytes=${size}`, { timeoutMs: 120_000 });
      const retried = again.status === 200 && again.body.length === size;
      return { clearedAt, pass: intact && retried, note: `first try ${whole ? "finished whole" : `cut (${answer.status || answer.error})`}, the retry ${retried ? "finished" : "failed"}`, sees: whole ? null : "the download fails and has to be started again" };
    },
  },
];
