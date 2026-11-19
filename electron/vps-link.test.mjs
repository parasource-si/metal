// "Add your VPS" end to end on loopback, with the real link service, the real agent (its `link` and `tunnel` commands in
// their own processes and home folder) and a fake Metal on each side: command, live steps, the sealed result, the
// app signed in through the tunnel, AI sign-ins sent from this mac, and the move with its backup first.
import { execFile, execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLinkService } from "../apps/link-service/src/app.mjs";
import { STEP_IDS, createVpsLink, installLine, welcomeForServer } from "./vps-link.mjs";
import { vpsTokenOf } from "./vps-link-protocol.mjs";

const run = promisify(execFile);
const SEAL_ID = `${"a".repeat(43)}.${"b".repeat(43)}`;
const agentPath = fileURLToPath(new URL("../apps/link-service/agent.mjs", import.meta.url));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

let dir, relayServer, service, base, vpsServer, vpsPort, home, tunnelChild;
// the link service opens setup sessions only with the account service's signed grant (apps/link-service/src/grant.mjs)
const grantKey = generateKeyPairSync("ed25519");
const grantKeys = [{ kid: "test-1", x: grantKey.publicKey.export({ format: "jwk" }).x }];
function linkGrant() {
  const head = `l1.test-1.${Buffer.from(JSON.stringify({ v: 1, aud: "link", acct: "a".repeat(32), iat: Date.now(), exp: Date.now() + 300_000 })).toString("base64url")}`;
  return `${head}.${sign(null, Buffer.from(head), grantKey.privateKey).toString("base64url")}`;
}
const vpsSeen = [];

/** fetch over node:http that keeps a host's cookies, as the app's session does, and reaches *.localhost on loopback */
function cookieFetch() {
  const jar = new Map();
  return (url, init = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = { ...init.headers, host: target.host, ...(jar.get(target.hostname) ? { cookie: jar.get(target.hostname) } : {}) };
    const req = httpRequest({ host: "127.0.0.1", port: target.port, path: `${target.pathname}${target.search}`, method: init.method ?? "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const cookie = res.headers["set-cookie"]?.[0];
        if (cookie) jar.set(target.hostname, cookie.split(";")[0]);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.entries(res.headers).filter(([, value]) => typeof value === "string") }));
      });
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dusk-vps-link-"));
  home = join(dir, "vps-home");
  mkdirSync(home);
  service = createLinkService({ base: "http://placeholder", dataDir: null, scriptPath: fileURLToPath(new URL("../apps/link-service/install.sh", import.meta.url)), agentPath, trustProxy: false, grantKeys });
  relayServer = createServer((req, res) => void service.handler(req, res));
  base = `http://127.0.0.1:${await listen(relayServer)}`;
  // Metal on the vps
  vpsServer = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      vpsSeen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = (status, value, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
      const signedIn = /dusk_session=good/.test(String(req.headers.cookie ?? ""));
      if (req.url === "/api/auth/pairing") return req.headers["x-forwarded-for"] ? reply(403, { error: "remote" }) : reply(200, { code: "RR8Y-BLR6-H939", expiresAt: 1 });
      if (req.url === "/.well-known/duskbot/environment") return reply(200, { environmentId: "6f1c2d3e-0000-4000-8000-000000000001", sealIdentity: SEAL_ID });
      if (req.url === "/api/auth/pair") return JSON.parse(body).code === "RR8Y-BLR6-H939" ? reply(200, { session: {}, environment: { environmentId: "6f1c2d3e-0000-4000-8000-000000000001" } }, { "set-cookie": "dusk_session=good; HttpOnly; Path=/" }) : reply(401, { error: "bad code" });
      if (req.url === "/api/auth/session") return reply(200, signedIn ? { kind: "session" } : { kind: "none" });
      if (!signedIn) return reply(403, { error: "pair this device" });
      if (req.url === "/api/config") return reply(200, { onboarding: req.method === "PUT" ? JSON.parse(body).onboarding : { completedAt: "", version: 0 } });
      if (req.url === "/api/instances?fresh=1") return reply(200, { instances: [
        { instanceId: "claude", driverKind: "claudeAgent", snapshot: { authenticated: false } },
        { instanceId: "codex", driverKind: "codex", snapshot: { authenticated: false } },
        { instanceId: "chatgpt", driverKind: "codex", snapshot: { authenticated: false } },
        { instanceId: "claudeApi", driverKind: "claudeAgent", snapshot: { authenticated: false } },
        { instanceId: "grok", driver: "grok", snapshot: {} },
      ] });
      return reply(404, { error: "not here" });
    });
  });
  vpsPort = await listen(vpsServer);
});

afterAll(async () => {
  tunnelChild?.kill();
  service.close();
  await new Promise((resolve) => relayServer.close(resolve));
  await new Promise((resolve) => vpsServer.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

function localServer({ exportFails = false } = {}) {
  const calls = [];
  const backupBytes = Buffer.from("encrypted-backup-bytes");
  const localRequest = async (route, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${route}`);
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (route === "/api/bots?messages=0") return json(200, { bots: [{ id: "b1", name: "Pixel", avatarUrl: "/api/attachments/p.png", tasks: [{}, {}] }, { id: "b2", name: "Mira", tasks: [{}] }] });
    if (route === "/api/cloud-send") return json(200, { items: [{ kind: "bot" }, { kind: "skill" }, { kind: "library-skill" }, { kind: "routine" }, { kind: "webhook" }, { kind: "login" }] });
    if (route === "/api/workspace-backup/export") return exportFails ? json(409, { error: "A backup is already running." }) : json(200, { id: "11111111-2222-4333-8444-555555555555", bytes: backupBytes.length, summary: { bots: 2, threads: 3, messages: 40 } });
    if (route.startsWith("/api/workspace-backup/download/")) return new Response(backupBytes, { status: 200 });
    if (route === "/api/move/forget") return json(200, { forgot: true });
    if (route === "/api/config") return json(200, { onboarding: { completedAt: "2026-11-14T06:00:00.000Z", version: 1, hintsSeen: ["met-chief-v1"] } });
    return json(404, { error: "not here" });
  };
  return { calls, localRequest };
}

function controller({ local, ownHome, store, onChange = () => {}, grant = async () => linkGrant() }) {
  const saved = [];
  const link = createVpsLink({
    base,
    linkGrant: grant,
    serverFetch: cookieFetch(),
    store,
    protect: async (text) => `p:${text}`,
    unprotect: async (text) => text.slice(2),
    label: () => "Sid's MacBook",
    saveServer: ({ origin, name }) => { saved.push({ origin, name }); return `env-${saved.filter((entry) => entry.origin).length}`; },
    forgetServer: (id) => saved.push({ forgot: id }),
    switchTo: () => {},
    ownHome,
    ownHomeReset: () => {},
    localRequest: local.localRequest,
    backups: {
      async save(name, body) {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        const file = join(dir, name);
        writeFileSync(file, Buffer.concat(chunks));
        return { file, bytes: Buffer.concat(chunks).length };
      },
      async open(file) { return { body: readFileSync(file), size: readFileSync(file).length }; },
    },
    localCredentials: {
      codexAuth: async () => JSON.stringify({ tokens: { access_token: "codex-on-the-mac" } }),
      claudeCli: async () => "/usr/local/bin/claude",
      claudeToken: async () => `Your token: sk-ant-oat01-${"a".repeat(40)}\n`,
    },
    relaunch: () => {},
    pollMs: 10,
    onChange,
  });
  return { link, saved };
}

const memoryStore = () => { let value = null; return { read: () => value, write: (next) => { value = JSON.parse(JSON.stringify(next)); } }; };
const post = (route, token, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

describe("Add your VPS", () => {
  it("needs this computer signed in to a dusk account to make a command", async () => {
    const { link } = controller({ local: localServer(), ownHome: { start: async () => {}, view: () => null, away: () => false, home: () => null, chosen: () => null }, store: memoryStore(), grant: async () => null });
    await expect(link.start()).rejects.toThrow("Sign in to your Dusk account in the app to link a server.");
    expect(link.view().stage).not.toBe("command");
    await link.close();
  });

  it("links a server, signs its AI in from this mac, and moves everything with a backup first", async () => {
    const local = localServer();
    let phase = null;
    const started = [];
    const ownHome = { start: async (id) => { started.push(id); phase = { phase: "copy", chats: { done: 1, total: 3 } }; }, view: () => phase, away: () => phase?.phase === "done", home: () => null, chosen: () => null };
    const progressViews = [];
    const linkStore = memoryStore();
    const { link, saved } = controller({ local, ownHome, store: linkStore, onChange: (view) => progressViews.push(view) });

    const first = await link.start();
    expect(first.stage).toBe("command");
    const command = first.command;
    const token = /\/i\/([a-z2-7]{10}-[a-z2-7]{26})\)/.exec(command)?.[1];
    expect(command).toContain("$(curl -fsSL $f http://placeholder/i/");
    expect(command.endsWith(") | sh")).toBe(true);
    expect(token).toBeTruthy();
    expect(first.steps.map((step) => step.id)).toEqual(STEP_IDS);
    const [id, secret] = token.split("-");

    // the install script's reports, as they arrive
    const vpsToken = vpsTokenOf(secret);
    await post(`/v1/sessions/${id}/claim`, vpsToken, {});
    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "check", status: "done" });
    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "node", status: "failed", log: "curl: (6) Could not resolve host" });
    const failed = await until(() => { const seen = link.view(); return seen.steps.find((step) => step.id === "node").status === "failed" && seen; });
    expect(failed.stage).toBe("installing");
    expect(failed.steps.find((step) => step.id === "node").log).toContain("resolve host");
    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "node", status: "done" });
    // a late batch of terminal lines reaches the view without taking the finished step back to running
    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "node", status: "running", cmd: "apt-get -y install nodejs", lines: ["$ apt-get -y install nodejs", "Setting up nodejs (24.11.0) ..."] });
    const mirrored = await until(() => { const seen = link.view(); return seen.terminal.length === 2 && seen; });
    expect(mirrored.terminal[1]).toEqual({ step: "node", text: "Setting up nodejs (24.11.0) ..." });
    expect(mirrored.steps.find((step) => step.id === "node")).toMatchObject({ status: "done", cmd: "apt-get -y install nodejs", lines: ["$ apt-get -y install nodejs", "Setting up nodejs (24.11.0) ..."] });

    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "app", status: "running", progress: { kind: "download", receivedBytes: 25, totalBytes: 100 }, activity: { elapsedMs: 1000, quietMs: 0 } });
    const downloading = await until(() => { const seen = link.view(); return seen.steps.find((step) => step.id === "app").progress?.receivedBytes === 25 && seen; });
    const lastProgress = downloading.activity.progressAt;
    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "app", status: "running", heartbeat: true, activity: { elapsedMs: 46_000, quietMs: 45_000 } });
    const heartbeat = await until(() => { const seen = link.view(); return seen.activity.updatedAt > downloading.activity.updatedAt && seen; });
    expect(heartbeat.activity.progressAt).toBe(lastProgress);
    expect(heartbeat.steps.find((step) => step.id === "app").progress).toEqual({ kind: "download", receivedBytes: 25, totalBytes: 100 });

    // the agent finishes the setup on the server and keeps the tunnel open
    await run(process.execPath, [agentPath, "link"], { env: { ...process.env, HOME: home, LINK_BASE: base, LINK_ID: id, LINK_TOKEN: vpsToken, LINK_MODE: "relay", LINK_NAME: "oracle-arm", LINK_SERVER_PORT: String(vpsPort) } });
    tunnelChild = spawn(process.execPath, [agentPath, "tunnel"], { env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), LINK_SERVER_PORT: String(vpsPort) }, stdio: "ignore" });

    const linked = await until(() => link.view().stage === "linked" && link.view());
    expect(linked.server).toMatchObject({ id: "env-1", name: "oracle-arm" });
    expect(linked.server.origin).toMatch(new RegExp(`^http://vps-${id}\\.localhost:\\d+$`));
    expect(linked.mode).toBe("relay");
    expect(saved[0]).toEqual({ origin: linked.server.origin, name: "oracle-arm" });
    // the server's identity came inside the sealed result and is pinned: a key signed by any other is refused
    expect(linkStore.read().links[0].sealIdentity).toBe(SEAL_ID);
    expect(link.sealTrust(linked.server.origin, SEAL_ID)).toEqual({ ok: true, pinned: true });
    expect(link.sealTrust(linked.server.origin, `${"c".repeat(43)}.${"d".repeat(43)}`)).toEqual({ ok: false, pinned: true });
    expect(link.sealTrust("http://elsewhere.localhost:1", SEAL_ID)).toBeNull();
    // the pairing went through the tunnel, as a remote request the server checks
    const pair = vpsSeen.find((entry) => entry.url === "/api/auth/pair");
    expect(pair.headers["x-forwarded-for"]).toBeTruthy();
    expect(JSON.parse(pair.body)).toMatchObject({ code: "RR8Y-BLR6-H939", cookie: true, label: "Sid's MacBook" });

    const engines = await link.engines();
    expect(engines.map((engine) => engine.kind)).toEqual(["claude", "codex"]);
    expect(await link.signIn("codex")).toMatchObject({ phase: "succeeded" });
    expect(JSON.parse(readFileSync(join(home, ".codex", "auth.json"), "utf8")).tokens.access_token).toBe("codex-on-the-mac");
    const claude = await link.signIn("claude");
    expect(claude.phase).toBe("waiting");
    await until(async () => (await link.signInStatus("claude", claude.flowId)).phase === "succeeded");
    expect(readFileSync(join(home, ".config", "duskbot", "engines.env"), "utf8")).toBe(`CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-${"a".repeat(40)}\n`);
    // no credential ever reached Metal's own http api on the server
    expect(vpsSeen.some((entry) => entry.body.includes("codex-on-the-mac") || entry.body.includes("sk-ant-oat01"))).toBe(false);

    expect(await link.preview()).toEqual({
      bots: [{ id: "b1", name: "Pixel", avatarUrl: "/api/attachments/p.png" }, { id: "b2", name: "Mira" }],
      chats: 3, messages: null, skills: 2, memories: null, routines: 2, apps: null, bytes: null,
    });

    await link.move();
    expect(progressViews.some((view) => view.move?.step === "backup" && view.move.bytes?.done === 22 && view.move.bytes?.total === 22)).toBe(true);
    expect(started).toEqual(["env-1"]);
    expect(local.calls.indexOf("POST /api/workspace-backup/export")).toBeLessThan(local.calls.length);
    expect(link.backups()).toEqual([expect.objectContaining({ reason: "before-move", bytes: 22, summary: expect.objectContaining({ bots: 2, chats: 3 }) })]);
    await until(() => link.view().move?.step === "copy" && link.view().move.chats?.done === 1);
    expect(local.calls).not.toContain("POST /api/move/forget");
    phase = { phase: "finishing" };
    await until(() => link.view().move?.step === "verify");
    phase = { phase: "done", phone: false };
    const moved = await until(() => link.view().stage === "moved" && link.view());
    expect(moved.move).toMatchObject({ step: "done", status: "done" });
    expect(local.calls.filter((call) => call === "POST /api/move/forget")).toHaveLength(1);
    // the person met Metal on this mac: the server does not open on the welcome again
    expect(vpsSeen.filter((seen) => seen.url === "/api/config" && seen.method === "PUT").map((seen) => JSON.parse(seen.body)))
      .toEqual([{ onboarding: { completedAt: "2026-11-14T06:00:00.000Z", version: 1, hintsSeen: ["met-chief-v1"] } }]);

    await link.forget();
    expect(saved.at(-1)).toEqual({ forgot: "env-1" });
    await link.close();
  }, 30_000);

  it("the same server linked again replaces its record, and its old tunnel is ended", async () => {
    const ownHome = { start: async () => {}, view: () => null, away: () => false, home: () => null, chosen: () => null };
    const store = memoryStore();
    const { link, saved } = controller({ local: localServer(), ownHome, store });
    const linkOnce = async () => {
      const token = /\/i\/([a-z2-7]{10}-[a-z2-7]{26})\)/.exec((await link.start()).command)[1];
      const [id, secret] = token.split("-");
      await post(`/v1/sessions/${id}/claim`, vpsTokenOf(secret), {});
      await run(process.execPath, [agentPath, "link"], { env: { ...process.env, HOME: home, LINK_BASE: base, LINK_ID: id, LINK_TOKEN: vpsTokenOf(secret), LINK_MODE: "relay", LINK_NAME: "oracle-arm", LINK_SERVER_PORT: String(vpsPort) } });
      tunnelChild?.kill();
      tunnelChild = spawn(process.execPath, [agentPath, "tunnel"], { env: { ...process.env, HOME: home, LINK_SERVER_PORT: String(vpsPort) }, stdio: "ignore" });
      await until(() => store.read()?.links?.some((entry) => entry.id === id));
      return id;
    };
    const first = await linkOnce();
    const second = await linkOnce();
    expect(store.read().links.map((entry) => entry.id)).toEqual([second]);
    expect(store.read().current).toBe(second);
    expect(saved).toContainEqual({ forgot: "env-1" });
    expect(service.store.tunnels.has(first)).toBe(false);
    expect(service.store.tunnels.has(second)).toBe(true);
    await link.forget();
    await link.close();
  }, 30_000);

  it("removes nothing on this mac when the backup fails, and keeps the copy when something did not arrive", async () => {
    const failing = localServer({ exportFails: true });
    const ownHome = { start: async () => { throw new Error("should not start"); }, view: () => null, away: () => false, home: () => null, chosen: () => null };
    const store = memoryStore();
    store.write({ v: 1, current: "aaaaaaaaaa", links: [{ id: "aaaaaaaaaa", name: "box", mode: "direct", origin: "https://203-0-113-5.sslip.io", envId: "env-9", keyP: `p:${Buffer.alloc(32).toString("base64url")}`, tokenP: "p:token-token-token-token" }] });
    const proxyFactory = () => ({ start: async () => "http://vps-aaaaaaaaaa.localhost:1", control: async () => ({ ok: true }), close: async () => {} });
    const pins = [];
    const { link } = controller({ local: failing, ownHome, store });
    // a controller with a stub tunnel and a signed-in server, so only the move itself is under test
    const stubbed = createVpsLink({ ...linkDeps(failing, ownHome, store), proxyFactory, pin: (host, spki) => pins.push([host, spki]) });
    await link.close();
    await stubbed.move();
    const seen = stubbed.view();
    expect(seen.move).toMatchObject({ step: "backup", status: "failed", error: "A backup is already running." });
    expect(failing.calls).not.toContain("POST /api/move/forget");

    let phase = null;
    const fine = localServer();
    const leaving = { start: async () => { phase = { phase: "done", left: [{ label: "Pixel", error: "too big" }] }; }, view: () => phase, away: () => true, home: () => ({ id: "env-9", name: "box", origin: "https://203-0-113-5.sslip.io" }), chosen: () => null };
    const store2 = memoryStore();
    store2.write(store.read());
    const second = createVpsLink({ ...linkDeps(fine, leaving, store2), proxyFactory });
    store2.write({ ...store2.read(), move: null });
    await second.move();
    await until(() => second.view().stage === "moved");
    expect(fine.calls).not.toContain("POST /api/move/forget");
    expect(second.where()).toEqual({ place: "vps", server: { id: "env-9", name: "box", origin: "https://203-0-113-5.sslip.io" }, uninstall: expect.stringMatching(/^curl -fsSL https?:\/\/\S+\/uninstall \| sh$/) });
    await stubbed.close();
    await second.close();
  });

  it("pins a link made before the agent sent an identity the first time it is seen, then holds to it", async () => {
    const store = memoryStore();
    store.write({ v: 1, current: "bbbbbbbbbb", links: [{ id: "bbbbbbbbbb", name: "old box", mode: "direct", origin: "https://203-0-113-6.sslip.io", envId: "env-8", keyP: "p:k", tokenP: "p:t" }] });
    const old = createVpsLink({ ...linkDeps(localServer(), { start: async () => {}, view: () => null, away: () => false, home: () => null, chosen: () => null }, store), proxyFactory: () => ({ start: async () => "", control: async () => ({}), close: async () => {} }) });
    expect(old.sealTrust("https://203-0-113-6.sslip.io", "not-an-identity")).toEqual({ ok: false, pinned: true });
    expect(store.read().links[0].sealIdentity).toBeUndefined();
    expect(old.sealTrust("https://203-0-113-6.sslip.io/", SEAL_ID)).toEqual({ ok: true, pinned: true });
    expect(store.read().links[0]).toMatchObject({ sealIdentity: SEAL_ID, sealPinnedAt: expect.any(Number) });
    // a relay that swaps in a key of its own signs it with another identity: refused, and the pin stays
    expect(old.sealTrust("https://203-0-113-6.sslip.io", `${"e".repeat(43)}.${"f".repeat(43)}`)).toEqual({ ok: false, pinned: true });
    expect(store.read().links[0].sealIdentity).toBe(SEAL_ID);
    await old.close();
  });

  it("shows what the installer asks of the person live, and clears it when that step ends", async () => {
    const { link } = controller({ local: localServer(), ownHome: { start: async () => {}, view: () => null, away: () => false, home: () => null, chosen: () => null }, store: memoryStore() });
    const made = await link.start();
    const [id, secret] = /\/i\/([a-z2-7]{10}-[a-z2-7]{26})\)/.exec(made.command)[1].split("-");
    const vpsToken = vpsTokenOf(secret);
    await post(`/v1/sessions/${id}/claim`, vpsToken, {});
    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "address", status: "running" });
    const ask = { kind: "tailscale-login", url: "https://login.tailscale.com/a/abc123", state: "waiting" };
    expect((await post(`/v1/sessions/${id}/events`, vpsToken, { step: "address", status: "running", ask })).status).toBe(200);
    expect((await until(() => link.view().ask)).url).toBe("https://login.tailscale.com/a/abc123");
    // a link to anywhere but the provider's own sign-in host never reaches the app
    expect((await post(`/v1/sessions/${id}/events`, vpsToken, { step: "address", status: "running", ask: { kind: "tailscale-login", url: "https://evil.example/a/1" } })).status).toBe(400);
    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "address", status: "running", ask: { ...ask, state: "found" } });
    await until(() => link.view().ask?.state === "found");
    await post(`/v1/sessions/${id}/events`, vpsToken, { step: "address", status: "done" });
    await until(() => link.view().ask === null);
    await link.close();
  });

  it("follows the agent to a new address it names inside the sealed tunnel, and signs in there", async () => {
    const store = memoryStore();
    store.write({ v: 1, current: "cccccccccc", links: [{ id: "cccccccccc", name: "quick box", mode: "direct", via: "cloudflare", origin: "https://old-name.trycloudflare.com", spki: null, envId: "env-3", keyP: "p:k", tokenP: "p:t" }] });
    const retargeted = [], pinned = [];
    const address = { mode: "direct", via: "cloudflare", origin: "https://new-name.trycloudflare.com", spki: null };
    const linked = createVpsLink({
      ...linkDeps(localServer(), { start: async () => {}, view: () => null, away: () => false, home: () => null, chosen: () => null }, store),
      retarget: (from, to) => retargeted.push([from, to]), pin: (host, spki) => pinned.push([host, spki]),
      proxyFactory: () => ({ start: async () => "http://vps-cccccccccc.localhost:1", control: async (op) => (op === "hello" ? { protocol: 3, address } : {}), close: async () => {} }),
    });
    await linked.resume();
    await until(() => store.read().links[0].origin === "https://new-name.trycloudflare.com");
    expect(retargeted).toEqual([["https://old-name.trycloudflare.com", "https://new-name.trycloudflare.com"]]);
    expect(pinned).toContainEqual(["new-name.trycloudflare.com", null]);
    expect(linked.view()).toMatchObject({ via: "cloudflare", server: { origin: "https://new-name.trycloudflare.com" } });
    await linked.close();
  });
});

function linkDeps(local, ownHome, store) {
  return {
    base,
    serverFetch: async (url) => new Response(JSON.stringify(String(url).endsWith("/api/auth/session") ? { kind: "session" } : {}), { status: 200 }),
    store, protect: async (text) => `p:${text}`, unprotect: async (text) => text.slice(2), label: () => "Mac",
    saveServer: () => "env-9", forgetServer: () => {}, switchTo: () => {}, ownHome, ownHomeReset: () => {}, localRequest: local.localRequest,
    backups: { async save(name, body) { let bytes = 0; for await (const chunk of body) bytes += chunk.length; return { file: join(dir, name), bytes }; }, async open() { throw new Error("no"); } },
    localCredentials: { codexAuth: async () => null, claudeCli: async () => null, claudeToken: async () => "" },
    relaunch: () => {}, pollMs: 10,
  };
}

describe("the welcome a server gets when everything moves there", () => {
  const now = new Date("2026-11-14T07:00:00.000Z");
  it("keeps a finished welcome as it was", () => {
    expect(welcomeForServer({ completedAt: "2026-11-14T06:00:00.000Z", version: 1, hintsSeen: ["met-chief-v1"] }, undefined, now))
      .toEqual({ completedAt: "2026-11-14T06:00:00.000Z", version: 1, hintsSeen: ["met-chief-v1"] });
  });
  it("counts a welcome still under way as met: the person chose their own server from it, so the server never starts over", () => {
    expect(welcomeForServer(undefined, undefined, now)).toEqual({ completedAt: "2026-11-14T07:00:00.000Z", version: 1 });
    expect(welcomeForServer({ hintsSeen: ["onboarding-cloud-v1"] }, {}, now)).toEqual({ completedAt: "2026-11-14T07:00:00.000Z", version: 1, hintsSeen: ["onboarding-cloud-v1"] });
  });
  it("leaves a server that already met the person alone", () => {
    expect(welcomeForServer({ completedAt: "2026-11-14T06:00:00.000Z", version: 1 }, { completedAt: "2026-11-01T00:00:00.000Z" }, now)).toBeNull();
  });
});

describe("the install line", () => {
  const sh = (shell, line) => new Promise((resolve) => execFile(shell, ["-c", line], { timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  const shells = ["sh", "bash", "zsh"].filter((shell) => { try { execFileSync("which", [shell]); return true; } catch { return false; } });

  it("tries five times, then exits 1 with a plain message instead of running nothing and exiting 0", async () => {
    for (const shell of shells) {
      const started = Date.now();
      const result = await sh(shell, `${installLine("http://127.0.0.1:9", "abcdefghij-abcdefghijklmnopqrstuvwxyz")} -s -- --cloudflare`);
      expect(result.code, shell).toBe(1);
      expect(result.stderr, shell).toContain("Metal could not be downloaded. check the internet and paste the line again.");
      expect(result.stderr.match(/curl: \(7\)/g), shell).toHaveLength(5);
      expect(Date.now() - started, shell).toBeGreaterThanOrEqual(8000);
    }
  }, 120_000);

  it("runs the installer only once it arrived whole, with the way after it, and passes on its exit code", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      if (req.url.endsWith("-fail")) { res.end("echo nope; exit 3\n"); return; }
      const body = 'main() { echo "ran $*"; }\nmain "$@"\n';
      // the first try is cut off half way: what it got must never reach sh
      if (hits === 1) { res.writeHead(200, { "content-length": body.length }); res.write(body.slice(0, 12)); setTimeout(() => res.destroy(), 20); return; }
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const shell of shells) {
        hits = 0;
        const ok = await sh(shell, `${installLine(base, "abcdefghij-abcdefghijklmnopqrstuvwxyz")} -s -- --cloudflare`);
        expect(ok, shell).toMatchObject({ code: 0, stdout: "ran --cloudflare\n" });
        expect(hits, shell).toBe(2);
      }
      expect(await sh("bash", installLine(base, "abcdefghij-fail"))).toMatchObject({ code: 3, stdout: "nope\n" });
    } finally { server.closeAllConnections(); server.close(); }
  }, 60_000);
});
