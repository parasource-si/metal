// the handshake between this app, the link agent and the server: who is too old for whom, and what the person is told
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AGENT_CAPS, AGENT_VERSION, LINK_MIN_APP, LINK_PROTOCOL, control, serveDirect, serverLink } from "../apps/link-service/agent.mjs";
import { APP_LINK_PROTOCOL, MIN_AGENT_PROTOCOL, agentInfo, linkCompat, missingCap } from "./vps-link-compat.mjs";
import { createTunnelProxy } from "./vps-link-protocol.mjs";
import { createVpsLink } from "./vps-link.mjs";

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("this app and the agent shipped with it work together, and each names what to update when one is too old", () => {
  assert.ok(APP_LINK_PROTOCOL >= LINK_MIN_APP && LINK_PROTOCOL >= MIN_AGENT_PROTOCOL);
  const fine = agentInfo({ protocol: LINK_PROTOCOL, minApp: LINK_MIN_APP, minServer: 1, agent: AGENT_VERSION, caps: [...AGENT_CAPS], server: { version: "9.0.0", protocol: 1, minAgent: 1 } });
  assert.deepEqual(linkCompat(fine, "box"), { update: null, message: null });
  assert.deepEqual(linkCompat({ ...fine, minApp: APP_LINK_PROTOCOL + 1 }, "box"), { update: "app", message: "Update Metal on this Mac to keep using box." });
  assert.equal(linkCompat({ ...fine, protocol: MIN_AGENT_PROTOCOL - 1 }, "box").update, "agent");
  assert.match(linkCompat({ ...fine, caps: [], server: { version: "10.0.0", protocol: 3, minAgent: LINK_PROTOCOL + 1 } }, "box").message, /Run its setup line on the server again\.$/, "an agent that cannot update itself says how");
  assert.deepEqual(linkCompat({ ...fine, server: { version: "10.0.0", protocol: 3, minAgent: LINK_PROTOCOL + 1 } }, "box"), { update: "agent", message: "Update the link on box: Metal there needs a newer one. It updates itself when nobody is using it." });
  assert.deepEqual(linkCompat({ ...fine, minServer: 2 }, "box"), { update: "server", message: "Update Metal on box: its link is newer than it works with." });
  const old = agentInfo(null);
  assert.equal(old.legacy, true);
  assert.deepEqual(linkCompat(old, "box").update, null, "an agent from before the handshake still works");
  assert.equal(missingCap(old, "direct-wss", "box"), "Update the link on box to connect over port 443 when your network blocks ssh.");
  assert.equal(missingCap(fine, "direct-wss", "box"), null);
  assert.equal(missingCap(null, "direct-wss", "box"), null, "nothing is said before the agent answered");
});

test("the agent answers hello with what it speaks and what its server says", async () => {
  const said = await control("hello", { protocol: APP_LINK_PROTOCOL, app: "1.0.0" }, { id: "aaaaaaaaaa", serverLink: async () => ({ version: "4.5.6", protocol: 1, minAgent: 1 }) });
  assert.deepEqual(said, { protocol: LINK_PROTOCOL, minApp: LINK_MIN_APP, minServer: 1, agent: AGENT_VERSION, caps: [...AGENT_CAPS], server: { version: "4.5.6", protocol: 1, minAgent: 1 } });
  assert.ok(said.caps.includes("direct-wss"));
  assert.deepEqual(await serverLink(async () => ({ status: 200, body: { version: "3.0.0", link: { protocol: 2, minAgent: 2 } } })), { version: "3.0.0", protocol: 2, minAgent: 2 });
  assert.deepEqual(await serverLink(async () => ({ status: 200, body: { version: "2.0.0" } })), { version: "2.0.0", protocol: 1, minAgent: 1 }, "a server from before the field counts as protocol 1");
  assert.equal(await serverLink(async () => { throw new Error("down"); }), null);
});

test("the direct hello carries the same, both ways", async () => {
  const KEY = Buffer.alloc(32, 7).toString("base64url"), ID = "aaaaaaaaaa";
  const links = [];
  const proxy = createTunnelProxy({ base: "https://relay.test", id: ID, key: KEY, token: "t", fetch: async () => new Promise(() => {}), hello: { protocol: APP_LINK_PROTOCOL, app: "7.7.7" }, direct: { connect: async () => {
    const up = new PassThrough(), down = new PassThrough();
    serveDirect({ input: up, output: down, id: ID, key: KEY, server: { host: "127.0.0.1", port: 9 }, log: () => {} });
    links.push(up, down);
    return { readable: down, writable: up, close: () => { up.destroy(); down.destroy(); } };
  } } });
  try {
    await proxy.start();
    await until(() => proxy.transport() === "direct");
    const info = agentInfo(proxy.agentHello());
    assert.equal(info.protocol, LINK_PROTOCOL);
    assert.equal(info.agent, AGENT_VERSION);
    assert.deepEqual(info.caps, [...AGENT_CAPS]);
  } finally { await proxy.close(); for (const one of links) one.destroy(); }
});

test("the app shows one sentence for a server that needs updating, and nothing for one from before the handshake", async () => {
  const make = (hello) => {
    let value = { v: 1, current: "cccccccccc", links: [{ id: "cccccccccc", base: "http://relay.invalid", name: "box", mode: "relay", origin: "http://vps-cccccccccc.localhost:5555", port: 5555, envId: "env-1", keyP: "p:k", tokenP: "p:t" }] };
    const views = [];
    const link = createVpsLink({
      base: "http://relay.invalid", appVersion: "1.2.3", serverFetch: async () => { throw new Error("offline"); },
      store: { read: () => value, write: (next) => { value = JSON.parse(JSON.stringify(next)); } }, protect: async (text) => `p:${text}`, unprotect: async (text) => text.slice(2), label: () => "Mac",
      saveServer: () => "env-1", forgetServer: () => {}, switchTo: () => {}, ownHome: { away: () => false, view: () => null, home: () => null, chosen: () => null, start: async () => {} },
      ownHomeReset: () => {}, localRequest: async () => new Response("{}"), backups: { save: async () => ({}), open: async () => ({}) },
      localCredentials: { codexAuth: async () => null, claudeCli: async () => null, claudeToken: async () => "" }, relaunch: () => {},
      onChange: (view) => views.push(view),
      proxyFactory: () => ({ start: async () => "http://vps-cccccccccc.localhost:5555", close: async () => {}, transport: () => "relay",
        control: async (op, data) => { if (op !== "hello") throw new Error("unknown request"); assert.deepEqual(data, { protocol: APP_LINK_PROTOCOL, app: "1.2.3" }); if (hello instanceof Error) throw hello; return hello; } }),
    });
    return { link, views };
  };
  const newer = make({ protocol: 9, minApp: APP_LINK_PROTOCOL + 1, agent: "9.0.0", caps: [], server: { version: "9.9.9", protocol: 9, minAgent: 9 } });
  await newer.link.resume();
  await until(() => newer.link.view().compat);
  assert.deepEqual(newer.link.view().compat, { update: "app", message: "Update Metal on this Mac to keep using box.", agent: "9.0.0", server: "9.9.9", protocol: 9, legacy: false });
  assert.ok(newer.views.some((view) => view.compat?.update === "app"), "the page heard about it");
  await newer.link.close();
  const older = make(new Error("unknown request"));
  await older.link.resume();
  await until(() => older.link.view().compat);
  assert.equal(older.link.view().compat.update, null);
  assert.equal(older.link.view().compat.legacy, true);
  await older.link.close();
});
