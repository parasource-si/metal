import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_ROUTES as R, APP_AUTH_REDIRECT, APP_LANDING_PATH, CSRF_COOKIE, CSRF_HEADER, EMAIL_RESEND_SECONDS, SESSION_COOKIE } from "../shared/account-api.ts";
import { createDashboardApp } from "../apps/dashboard/server/app.ts";
import { startFakeProviders } from "../apps/dashboard/server/auth/fake-providers.ts";
import { memoryMailer } from "../apps/dashboard/server/auth/mail.ts";
import { createDashboardReporter } from "../server/dashboard-reporter.ts";
import { createDashboardRoutes } from "../server/routes/dashboard.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { createMobileAccount } from "../src/mobile/account/account-client.ts";
import { cloudTarget, createCloudAccountClient } from "./cloud-account.mjs";
import { installCloudBuy } from "./cloud-buy.mjs";
import { createAccountEnroll } from "./account-enroll.mjs";
import { accountGateRequired, gateBlocks, installAccountGate } from "./account-gate.mjs";

const waitFor = check => vi.waitFor(check, { timeout: 10_000, interval: 10 });
const decodeHtml = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]);
const memoryMap = () => {
  const values = new Map();
  return { values, get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
};
function fakeIpc() {
  const handlers = new Map();
  return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, guard: (_name, handler) => handler,
    call: (name, ...args) => { expect(handlers.has(name)).toBe(true); return handlers.get(name)({}, ...args); } };
}

describe("accounts across the website, desktop, workspace and phone", () => {
  let providers, f;
  beforeAll(async () => { providers = await startFakeProviders(); });
  // a google account at an address google is not authoritative for: it finishes through an email code
  const untrustedGoogle = () => providers.setUser("google", { subject: "google-held", email: "held@company.test", emailVerified: true, label: "held fixture", name: "held fixture" });
  afterAll(async () => { await providers?.close(); });
  beforeEach(async () => {
    f = { dir: mkdtempSync(join(tmpdir(), "dusk-accounts-e2e-")), cleanup: [], secrets: new Set(), offset: 0, mailer: memoryMailer() };
    f.now = () => Date.now() + f.offset;
    f.resend = () => { f.offset += EMAIL_RESEND_SECONDS * 1000; };
    f.server = createServer();
    await new Promise((resolve, reject) => { f.server.once("error", reject); f.server.listen(0, "127.0.0.1", resolve); });
    f.url = `http://127.0.0.1:${f.server.address().port}`;
    f.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (![f.url, providers.url].includes(url.origin)) throw new Error("Fixture attempted an external request.");
      const bearer = new Headers(init.headers).get("authorization");
      if (bearer?.startsWith("Bearer omc_")) f.secrets.add(bearer.slice(7));
      return fetch(input, init);
    };
    for (const provider of ["google", "apple"]) providers.setUser(provider, {
      subject: `${provider}-fixture`, email: `${provider}@accounts.test`, emailVerified: true, ...(provider === "google" ? { hd: "accounts.test" } : {}), label: `${provider} fixture`, name: `${provider} fixture`,
    });
    f.app = createDashboardApp({ dataDir: f.dir, publicUrl: f.url, mailer: f.mailer, oauth: providers.config, staticDir: null, now: f.now, fetch: f.fetch });
    f.server.on("request", f.app.handle);
  });
  afterEach(async () => {
    try {
      for (const close of f.cleanup.reverse()) await close();
      f.app?.close();
      assertPrivateFiles();
    } finally {
      await new Promise(resolve => { f.server.close(resolve); f.server.closeAllConnections(); });
      await removeTempDir(f.dir);
    }
  });

  function assertPrivateFiles() {
    const saved = ["auth.json", "state.json"].map(name => readFileSync(join(f.dir, name), "utf8"));
    // sign-in codes are secrets; the welcome and other notices carry none
    for (const message of f.mailer.outbox) { const code = message.text.match(/\b\d{8}\b/)?.[0]; if (code) f.secrets.add(code); }
    for (const file of saved) {
      expect(file.includes("omc_")).toBe(false);
      for (const secret of f.secrets) expect(file.includes(secret)).toBe(false);
    }
  }
  function codeFor(email) {
    const mail = f.mailer.outbox.findLast(message => message.to === email);
    expect(mail).toBeDefined();
    const code = mail.text.match(/\b\d{8}\b/)?.[0];
    expect(typeof code === "string" && code.length === 8).toBe(true);
    f.secrets.add(code);
    return code;
  }
  function browser() {
    const cookies = new Map();
    const csrf = () => { expect(cookies.has(CSRF_COOKIE)).toBe(true); return { [CSRF_HEADER]: cookies.get(CSRF_COOKIE).value }; };
    async function request(path, init = {}) {
      const url = new URL(path, f.url), headers = new Headers(init.headers);
      if (url.origin === f.url) {
        const matching = [...cookies.values()].filter(cookie => url.pathname.startsWith(cookie.path));
        if (matching.length) headers.set("cookie", matching.map(cookie => `${cookie.name}=${cookie.value}`).join("; "));
      }
      const response = await f.fetch(url, { ...init, headers, redirect: "manual" });
      if (url.origin === f.url) for (const raw of response.headers.getSetCookie()) {
        const [pair, ...flags] = raw.split(";"), at = pair.indexOf("="), name = pair.slice(0, at), value = pair.slice(at + 1);
        if (flags.some(flag => flag.trim() === "Max-Age=0")) cookies.delete(name);
        else cookies.set(name, { name, value, path: flags.find(flag => flag.trim().startsWith("Path="))?.trim().slice(5) ?? "/" });
        if (name === SESSION_COOKIE && value) f.secrets.add(value);
      }
      return response;
    }
    async function json(path, body, { method = body === undefined ? "GET" : "POST", csrf: withCsrf = false } = {}) {
      return request(path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: f.url }), ...(withCsrf ? csrf() : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    function appLink(target) {
      const url = new URL(target, f.url);
      return url.origin === f.url && url.pathname === APP_LANDING_PATH ? new URL(`${APP_AUTH_REDIRECT}?${url.hash.slice(1)}`) : url;
    }
    async function follow(path) {
      let url = new URL(path, f.url), init = {};
      for (let hop = 0; hop < 12; hop++) {
        url = appLink(url);
        if (url.protocol === "duskbot:" || (url.origin === f.url && ["/", "/sign-in", "/cloud/desktop"].includes(url.pathname))) return url;
        const response = await request(url, init);
        if ([302, 303].includes(response.status)) {
          url = new URL(response.headers.get("location"), url); init = {}; await response.body?.cancel();
          continue;
        }
        expect(response.status).toBe(200);
        expect(url.origin).toBe(providers.url);
        expect(url.pathname).toBe("/apple/authorize");
        const html = await response.text(), body = new URLSearchParams();
        const action = /<form method="post" action="([^"]+)">/.exec(html);
        expect(action).not.toBeNull();
        for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(match[1], decodeHtml(match[2]));
        expect(body.has("state") && body.has("code")).toBe(true);
        init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: url.origin }, body: body.toString() };
        url = new URL(decodeHtml(action[1]));
      }
      throw new Error("Too many fixture redirects.");
    }
    return { cookies, json, follow, appLink };
  }
  async function webSignIn(jar, email, pending) {
    const start = await jar.json(R.emailStart, { email, ...(pending ? { pending } : {}) });
    expect(start.status).toBe(200);
    const { attempt } = await start.json();
    const response = await jar.json(R.emailVerify, { attempt, code: codeFor(email) });
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(jar.cookies.get(SESSION_COOKIE)?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jar.cookies.get(CSRF_COOKIE)?.value).toBe(answer.csrfToken);
    return answer;
  }
  async function webAccount(jar) {
    const response = await jar.json(R.account); expect(response.status).toBe(200); return response.json();
  }
  async function workspaces(jar) {
    const response = await jar.json("/v1/workspaces"); expect(response.status).toBe(200); return (await response.json()).workspaces;
  }
  async function desktop() {
    const target = cloudTarget({ DUSK_CLOUD_ORIGIN: f.url });
    expect(target.custom).toBe(true); expect(target.file).toBe("cloud-account-custom.bin");
    const d = { saved: null, opened: [], timers: new Map(), nextTimer: 0 };
    d.client = createCloudAccountClient({ origin: target.origin, custom: target.custom, platform: "darwin", deviceName: "Fixture Mac", appVersion: "1.2.3",
      now: f.now, fetch: f.fetch, store: { read: async () => d.saved, write: async value => { d.saved = structuredClone(value); } },
      openBrowser: async url => { d.opened.push(url); }, setTimer: callback => { d.timers.set(++d.nextTimer, callback); return d.nextTimer; }, clearTimer: id => d.timers.delete(id) });
    f.cleanup.push(() => d.client.close());
    await d.client.start(); expect(d.client.state().status).toBe("signed-out");
    return d;
  }
  async function desktopSignIn(d, email) {
    expect((await d.client.emailStart(email)).outcome).toBe("sent");
    expect((await d.client.emailVerify(codeFor(email))).outcome).toBe("signed-in");
    expect(d.client.state().status).toBe("connected");
  }
  function phone() {
    const secrets = memoryMap(), prefs = memoryMap(), opened = [];
    const client = createMobileAccount({ origin: f.url, fetch: f.fetch, platform: { secrets, prefs, kind: "ios", native: true,
      deviceName: () => "Fixture iPhone", appVersion: "1.2.3", openExternal: async url => { opened.push(url); } } });
    f.cleanup.push(() => client.signOut());
    return { client, secrets, prefs, opened, token: () => JSON.parse(secrets.values.get("dusk.account")).token };
  }
  async function phoneSignIn(p, email) {
    expect((await p.client.emailStart(email)).outcome).toBe("sent");
    expect(await p.client.emailVerify(codeFor(email))).toEqual({ outcome: "signed-in" });
    expect(p.client.account()?.email).toBe(email);
  }
  async function bearer(token, method = "GET") {
    const response = await f.fetch(f.url + R.appSession, { method, headers: { authorization: `Bearer ${token}`, ...(method === "DELETE" ? { "content-type": "application/json" } : {}) },
      ...(method === "DELETE" ? { body: "{}" } : {}) });
    return { status: response.status, data: await response.json() };
  }
  function workspaceLink(getClient) {
    const collect = {
      workspace: () => ({ name: "Fixture Mac", kind: "mac", version: "1.2.3", platform: "darwin" }),
      machine: async () => ({ host: { hostname: "fixture", platform: "darwin", arch: "arm64", cpus: 1, cpuModel: null }, cpu: { percent: 0, load: [0, 0, 0] },
        memory: { usedBytes: 1, totalBytes: 2 }, disk: null, network: null, uptimeSec: 1, processUptimeSec: 1, app: { version: "1.2.3", node: "24" }, update: null, services: [] }),
      computers: async () => ({ provider: "none", computers: [] }), bots: () => [],
      devices: async () => ({ thisDevice: { label: "Fixture Mac", kind: "mac" }, link: null, phones: [], sessions: [] }),
      activity: async () => ({ from: "2026-01-01", to: "2026-11-08", timeZone: "UTC", days: [], byBot: [], byModel: [], totals: { turns: 0, tokens: 0, costUsd: null } }),
      plans: async () => ({ providers: [] }),
      apps: async () => null,
    };
    const reporter = createDashboardReporter({ dataDir: join(f.dir, "workspace"), collect, fetch: f.fetch, now: f.now,
      execute: async command => ({ id: command.id, ok: true, message: "Fixture command.", at: f.now() }) });
    const route = createDashboardRoutes({ reporter, linkAgentBase: () => null, env: {}, fetch: f.fetch });
    const link = { memory: null, answers: [], reporter };
    link.enroll = createAccountEnroll({ client: getClient, readMemory: () => link.memory, writeMemory: value => { link.memory = value; },
      localRequest: async (path, init) => {
        let response;
        await route({ path, method: init.method, req: { headers: init.headers }, res: { setHeader() {} }, auth: { kind: "loopback", scopes: ["admin", "client"] },
          readBody: async () => JSON.parse(init.body), json: (_res, status, body) => { link.answers.push({ status, ...body }); response = Response.json(body, { status }); } });
        expect(response).toBeDefined(); return response;
      } });
    f.cleanup.push(() => { link.enroll.close(); reporter.stop(); });
    return link;
  }

  it("signs up and signs in by website email, preserving identity and enforcing csrf", async () => {
    const jar = browser(), email = "web@accounts.test";
    const signed = await webSignIn(jar, email);
    expect(signed.created).toBe(true);
    const me = await jar.json(R.me); expect(me.status).toBe(200);
    expect((await me.json()).account.id).toBe(signed.account.id);
    const noCsrf = await jar.json(R.account, { name: "Fixture person" }, { method: "PATCH" });
    expect(noCsrf.status).toBe(403); expect((await noCsrf.json()).code).toBe("csrf");
    expect((await jar.json(R.account, { name: "Fixture person" }, { method: "PATCH", csrf: true })).status).toBe(200);
    expect((await webAccount(jar)).account.name).toBe("Fixture person");
    expect((await jar.json(R.signOut, {}, { csrf: true })).status).toBe(200);
    expect(jar.cookies.has(SESSION_COOKIE)).toBe(false); expect((await jar.json(R.me)).status).toBe(401);
    f.resend();
    const again = await webSignIn(jar, email);
    expect(again.created).toBe(false); expect(again.account.id).toBe(signed.account.id);
  }, 30_000);

  it("signs in with fake Google, Apple form_post and email-less X bound to its browser", async () => {
    const google = browser(); expect((await google.follow(R.oauthStart("google"))).pathname).toBe("/");
    const first = await webAccount(google);
    expect(first.account.email).toBe("google@accounts.test"); expect(first.identities.map(item => item.provider)).toEqual(["google"]);
    const apple = browser(); expect((await apple.follow(R.oauthStart("apple"))).pathname).toBe("/");
    const appleAccount = await webAccount(apple);
    expect(appleAccount.account.id).not.toBe(first.account.id); expect(appleAccount.account.name).toBe("apple fixture");
    expect(appleAccount.identities.map(item => item.provider)).toEqual(["apple"]);
    untrustedGoogle();
    const held = browser(), landing = await held.follow(R.oauthStart("google")), pending = landing.searchParams.get("pending");
    expect(landing.pathname).toBe("/sign-in"); expect(pending).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await browser().json(R.emailStart, { email: "held@accounts.test", pending })).status).toBe(400);
    const signed = await webSignIn(held, "held@accounts.test", pending);
    expect(signed.redirect).toBe("/"); expect(signed.account.providers).toEqual(["email", "google"]);
    expect((await webAccount(held)).identities).toMatchObject([{ provider: "google", email: null }]);
    const again = browser(); expect((await again.follow(R.oauthStart("google"))).pathname).toBe("/");
    expect((await webAccount(again)).account.id).toBe(signed.account.id);
  }, 30_000);

  it("drives the desktop sign-in sheet IPC and browser approval into real connected clients", async () => {
    const d = await desktop(), ipc = fakeIpc(), email = "desktop@accounts.test";
    installCloudBuy({ ...ipc, client: () => d.client });
    expect((await ipc.call("cloud-account:signInStart", email)).outcome).toBe("sent");
    expect((await ipc.call("cloud-account:signInVerify", codeFor(email))).outcome).toBe("signed-in");
    expect(d.client.state()).toMatchObject({ status: "connected", account: { id: d.saved.account.id, email }, entitlement: { plan: "free", status: "inactive" } });
    const other = await desktop(), jar = browser();
    await other.client.begin(null, { provider: "google" });
    expect(other.opened).toHaveLength(1);
    const landing = await jar.follow(other.opened[0]), userCode = landing.searchParams.get("code");
    expect(landing.pathname).toBe("/cloud/desktop"); expect(userCode).toBe(other.client.state().enrollment.userCode);
    const lookup = await jar.json(`${R.deviceLookup}?code=${userCode}`); expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ userCode, device: { name: "Fixture Mac", platform: "darwin" } });
    expect((await jar.json(R.deviceApprove, { userCode }, { csrf: true })).status).toBe(200);
    expect(other.timers.size).toBe(1);
    const [id, tick] = other.timers.entries().next().value; other.timers.delete(id); tick();
    await waitFor(() => expect(other.client.state().status).toBe("connected"));
    // the account service sends the name too (b61175e2f), shown on the account card
    expect(other.client.state().account).toEqual({ id: other.saved.account.id, email: "google@accounts.test", name: "google fixture" });
    expect(other.saved.account.id).toBe((await webAccount(jar)).account.id);
    expect(other.client.state().entitlement.plan).toBe("free");
  }, 30_000);

  it("accepts an app bearer session, revokes it and makes the desktop require reauthentication", async () => {
    const d = await desktop(); await desktopSignIn(d, "revoke@accounts.test");
    const token = d.saved.token;
    expect(await bearer(token)).toMatchObject({ status: 200, data: { account: d.saved.account } });
    expect(await bearer(token, "DELETE")).toEqual({ status: 200, data: { ok: true } });
    expect(await bearer(token)).toEqual({ status: 401, data: { error: "invalid_token" } });
    await d.client.refresh(); expect(d.client.state().status).toBe("reauth-required");
  }, 30_000);

  it("automatically enrolls a signed workspace without a claim, and another account cannot take it", async () => {
    const d = await desktop(), first = browser(); await desktopSignIn(d, "owner@accounts.test");
    f.resend(); await webSignIn(first, "owner@accounts.test");
    const link = workspaceLink(() => d.client);
    link.enroll.onState(d.client.state());
    await waitFor(() => expect(link.memory?.accountId).toBe(d.saved.account.id));
    const owner = d.saved.account.id, workspaceId = link.memory.workspaceId;
    expect(link.answers[0]).toMatchObject({ status: 200, claimed: true, workspaceId });
    expect(new URL(link.answers[0].claimUrl).hash).toBe("");
    expect(await workspaces(first)).toMatchObject([{ id: workspaceId, name: "Fixture Mac" }]);
    await waitFor(() => expect(link.reporter.status().lastReportAt).toEqual(expect.any(Number)));
    // security: a grant never claims a computer another account owns; the person hears why, not "try again"
    await d.client.signOut(); await desktopSignIn(d, "second@accounts.test");
    const second = browser(); f.resend(); await webSignIn(second, "second@accounts.test");
    link.enroll.onState(d.client.state());
    await waitFor(() => expect(link.answers).toHaveLength(2));
    expect(link.answers[1]).toMatchObject({ status: 409, error: expect.stringMatching(/belongs to another Dusk account/) });
    expect(link.memory).toMatchObject({ accountId: owner, workspaceId });
    expect(await workspaces(first)).toMatchObject([{ id: workspaceId }]); expect(await workspaces(second)).toEqual([]);
  }, 30_000);

  it("signs the phone in by email and PKCE deep links, rejects tampering and issues an enrollment grant", async () => {
    const p = phone(); await phoneSignIn(p, "phone@accounts.test");
    const emailToken = p.token(); expect((await bearer(emailToken)).status).toBe(200);
    await p.client.signOut(); expect(p.client.account()).toBeNull();
    expect(await bearer(emailToken)).toEqual({ status: 401, data: { error: "invalid_token" } });
    await p.client.oauthStart("google");
    const deep = await browser().follow(p.opened.at(-1));
    expect(deep.protocol).toBe("duskbot:"); expect(deep.host).toBe("auth"); expect(deep.searchParams.has("code")).toBe(true);
    expect(await p.client.handleAuthUrl(deep.href)).toEqual({ outcome: "signed-in" });
    // the same account; the service also sends its name and photo (b61175e2f), which the phone does not keep
    expect((await bearer(p.token())).data.account).toMatchObject(p.client.account());
    const signedToken = p.token(); await p.client.signOut();
    await p.client.oauthStart("google");
    const tampered = await browser().follow(p.opened.at(-1)); tampered.searchParams.set("state", "tampered");
    expect(await p.client.handleAuthUrl(tampered.href)).toEqual({ outcome: "invalid-state" });
    expect(p.client.account()).toBeNull(); expect(p.secrets.values.has("dusk.account")).toBe(false);
    expect((await bearer(signedToken)).status).toBe(401);
    untrustedGoogle(); await p.client.oauthStart("google");
    const jar = browser(), pendingUrl = await jar.follow(p.opened.at(-1)), pending = pendingUrl.searchParams.get("pending");
    expect(pendingUrl.pathname).toBe("/sign-in"); expect(pending).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await browser().json(R.emailStart, { email: "phone-held@accounts.test", pending })).status).toBe(400);
    const verified = await webSignIn(jar, "phone-held@accounts.test", pending);
    const handedBack = jar.appLink(verified.redirect);
    expect(handedBack.protocol).toBe("duskbot:");
    expect(await p.client.handleAuthUrl(handedBack.href)).toEqual({ outcome: "signed-in" });
    expect((await bearer(p.token())).data.account).toMatchObject(p.client.account());
    expect(p.client.account().id).toBe(verified.account.id);
    expect(await p.client.enrollGrant()).toEqual({ enrollToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), dashboardUrl: f.url });
  }, 30_000);

  it("gates a desktop only where the install asks for an account, and signs in through sanitized gate IPC", async () => {
    expect(accountGateRequired({ env: {}, packaged: true, remote: false, custom: false }), "the app works signed out").toBe(false);
    for (const custom of [false, true]) {
      expect(accountGateRequired({ env: { DUSK_REQUIRE_ACCOUNT: "1" }, packaged: true, remote: false, custom })).toBe(true);
      for (const packaged of [false, true]) expect(accountGateRequired({ env: { DUSK_REQUIRE_ACCOUNT: "1" }, packaged, remote: true, custom })).toBe(false);
    }
    const d = await desktop(), ipc = fakeIpc(), sent = [];
    const gate = installAccountGate({ ...ipc, client: () => d.client, required: () => true,
      window: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }) });
    expect(gateBlocks(d.client.state())).toBe(true);
    const before = await ipc.call("account-gate:state"); expect(before.blocked).toBe(true);
    const start = await ipc.call("account-gate:signInStart", "gate@accounts.test"); expect(start.outcome).toBe("sent");
    const verified = await ipc.call("account-gate:signInVerify", codeFor("gate@accounts.test")); expect(verified).toEqual({ outcome: "signed-in" });
    const after = await ipc.call("account-gate:state"); expect(after).toEqual({ required: true, blocked: false, status: "connected" });
    expect(gateBlocks(d.client.state())).toBe(false); gate.changed(d.client.state());
    const published = JSON.stringify([before, start, verified, after, sent]);
    expect(published.includes(d.saved.token)).toBe(false); expect(published.includes("omc_")).toBe(false); expect(published.includes('"token"')).toBe(false);
  }, 30_000);

  it("signs out every web and app session and deletes the account, identities and owned workspaces", async () => {
    const jar = browser(), email = "google@accounts.test";
    expect((await jar.follow(R.oauthStart("google"))).pathname).toBe("/");
    const original = await webAccount(jar); expect(original.identities).toHaveLength(1);
    const d = await desktop(), p = phone(); await desktopSignIn(d, email); f.resend(); await phoneSignIn(p, email);
    expect(d.client.state().account.id).toBe(original.account.id); expect(p.client.account().id).toBe(original.account.id);
    const link = workspaceLink(() => d.client); link.enroll.onState(d.client.state());
    await waitFor(() => expect(link.memory?.accountId).toBe(original.account.id));
    expect(await workspaces(jar)).toHaveLength(1);
    await waitFor(() => {
      expect(JSON.parse(readFileSync(join(f.dir, "auth.json"), "utf8")).sessions).toHaveLength(3);
      expect(JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8")).workspaces).toHaveLength(1);
    });
    assertPrivateFiles();
    const desktopToken = d.saved.token, phoneToken = p.token(), cookie = jar.cookies.get(SESSION_COOKIE).value;
    expect((await jar.json(R.signOutEverywhere, {}, { csrf: true })).status).toBe(200);
    for (const token of [desktopToken, phoneToken]) expect(await bearer(token)).toEqual({ status: 401, data: { error: "invalid_token" } });
    const oldCookie = await f.fetch(f.url + R.me, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }); expect(oldCookie.status).toBe(401);
    expect((await jar.json(R.me)).status).toBe(401);
    await d.client.refresh(); expect(d.client.state().status).toBe("reauth-required");
    expect(await p.client.restore()).toBeNull();
    f.resend(); const again = await webSignIn(jar, email); expect(again.account.id).toBe(original.account.id);
    expect((await webAccount(jar)).identities).toHaveLength(1); expect(await workspaces(jar)).toHaveLength(1);
    expect((await jar.json(R.deleteAccount, { email }, { csrf: true })).status).toBe(200);
    expect((await jar.json(R.me)).status).toBe(401);
    f.resend(); const replacement = await webSignIn(jar, email);
    expect(replacement.created).toBe(true); expect(replacement.account.id).not.toBe(original.account.id);
    expect((await webAccount(jar)).identities).toEqual([]); expect(await workspaces(jar)).toEqual([]);
    link.reporter.stop();
    await waitFor(() => {
      const auth = JSON.parse(readFileSync(join(f.dir, "auth.json"), "utf8")), state = JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8"));
      expect(auth.accounts.some(account => account.id === original.account.id)).toBe(false);
      expect(auth.accounts.some(account => account.id === replacement.account.id)).toBe(true);
      expect(auth.identities).toEqual([]); expect(state.workspaces).toEqual([]);
    });
  }, 30_000);
});
