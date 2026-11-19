import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp, type DashboardAppOptions } from "../app.ts";
import { AUTH_LIMITS, HANDOFF_OUTSTANDING, HANDOFF_TTL_MS, REVIEW_LIMITS, reviewAccountFromEnv } from "./index.ts";
import { memoryMailer } from "./mail.ts";
import { createCloudAccountClient } from "../../../../electron/cloud-account.mjs";
import { verifyLinkGrant } from "../../../link-service/src/grant.mjs";
import { entitlementPublicKey } from "../../../../shared/entitlement.ts";
import { LINK_GRANT_TTL_MS, linkAccountRef, linkGrantSignerFromEnv } from "../link-grant.ts";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type AccountAnswer, type AppGrant, type EmailStartAnswer, type EnrollGrantAnswer, type HandoffAnswer, type WebHandoffAnswer, type WebSignInAnswer } from "../../../../shared/account-api.ts";
import { SIGNATURE_HEADERS, SIGNATURE_SKEW_MS, signedPayload, type EnrollAnswer, type WorkspaceDetail } from "../../../../shared/dashboard-protocol.ts";

const day = 86_400_000;
const device = { deviceName: "Fixture Mac", platform: "darwin", appVersion: "1.2.3" };
const email = "owner@example.test";
type Browser = WebSignInAnswer & { cookie: string };
type Authorization = { deviceCode: string; userCode: string; interval: number; expiresIn: number; verificationUri: string; verificationUriComplete: string };
async function body<T>(response: Response | Promise<Response>): Promise<T> { return (await response).json() as Promise<T>; }

describe("local account service", () => {
  let dataDir: string, url: string, time: number, server: Server;
  let app: ReturnType<typeof createDashboardApp>;
  let mailer: ReturnType<typeof memoryMailer>;
  let options: DashboardAppOptions;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dusk-auth-test-"));
    time = Date.now(); mailer = memoryMailer();
    options = { dataDir, publicUrl: "http://127.0.0.1:7480", mailer, staticDir: null, now: () => time };
    app = createDashboardApp(options);
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not start.");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  function restart(changes: Partial<DashboardAppOptions> = {}) {
    app.close(); options = { ...options, ...changes }; app = createDashboardApp(options);
    server.removeAllListeners("request"); server.on("request", app.handle);
  }
  function call(path: string, data?: unknown, headers: Record<string, string> = {}, method = data === undefined ? "GET" : "POST") {
    return fetch(url + path, { method, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  const code = (address = email) => mailer.outbox.findLast(item => item.to === address && /\b\d{8}\b/.test(item.text))!.text.match(/\b\d{8}\b/)![0];
  const browserHeaders = (browser: Browser) => ({ cookie: browser.cookie, [CSRF_HEADER]: browser.csrfToken });
  const bearer = (grant: AppGrant) => ({ authorization: `Bearer ${grant.accessToken}` });
  async function start(address = email, appSignIn = false, headers = {}) {
    const response = await call(appSignIn ? "/api/cloud/app/sign-in/start" : "/v1/auth/start", { email: address, ...(appSignIn ? device : {}) }, headers);
    expect(response.status).toBe(200);
    return body<EmailStartAnswer>(response);
  }
  async function login(address = email): Promise<Browser> {
    const { attempt } = await start(address);
    const response = await call("/v1/auth/verify", { attempt, code: code(address) });
    expect(response.status).toBe(200);
    return { ...await body<WebSignInAnswer>(response), cookie: response.headers.getSetCookie()[0]!.split(";")[0]! };
  }
  async function appLogin(address = email): Promise<AppGrant> {
    const { attempt } = await start(address, true);
    const response = await call("/api/cloud/app/sign-in/verify", { attempt, code: code(address) });
    expect(response.status).toBe(200);
    return body<AppGrant>(response);
  }
  const authorize = () => body<Authorization>(call("/api/cloud/desktop/authorize", device));
  const poll = (authorization: Authorization) => call("/api/cloud/desktop/token", { deviceCode: authorization.deviceCode });
  function enrollment(enrollToken?: string, settings: { bad?: boolean; at?: number; keys?: { publicKey: KeyObject; privateKey: KeyObject } } = {}) {
    const keys = settings.keys ?? generateKeyPairSync("ed25519");
    const input = { v: 1, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), name: "Fixture", kind: "mac", version: "1.0.0", ...(enrollToken === undefined ? {} : { enrollToken }) };
    const raw = JSON.stringify(input), at = settings.at ?? time;
    const signature = sign(null, Buffer.from(signedPayload("POST", "/v1/enroll", at, createHash("sha256").update(raw).digest("hex"))), keys.privateKey).toString("base64");
    return { keys, input, headers: { [SIGNATURE_HEADERS.time]: String(at), [SIGNATURE_HEADERS.signature]: settings.bad ? Buffer.alloc(64).toString("base64") : signature } };
  }

  it("creates a normalized email account, signs in again and exposes only contract views", async () => {
    const started = await start(" OWNER@EXAMPLE.TEST ");
    expect(started).toMatchObject({ expiresIn: 600, resendAfter: 30, signupOpen: true });
    expect(started.attempt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mailer.outbox[0]).toMatchObject({ to: email, subject: `${code()} is your Metal code` });
    expect(mailer.outbox[0].text).toContain("works for 10 minutes.");
    expect(mailer.outbox[0].html).toContain(code());
    const first = await body<WebSignInAnswer>(call("/v1/auth/verify", { attempt: started.attempt, code: code() }));
    expect(first.created).toBe(true);
    expect(first.account).toEqual({ id: expect.stringMatching(/^acct_/), email, name: null, createdAt: time, providers: ["email"] });
    time += 30_000;
    const second = await login();
    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(await body(call("/v1/me", undefined, browserHeaders(second)))).toEqual({ account: second.account, csrfToken: second.csrfToken });
    const view = await body<AccountAnswer>(call("/v1/account", undefined, browserHeaders(second)));
    expect(view.identities).toEqual([]);
    expect(view.sessions).toHaveLength(2);
    expect(view.sessions[0]).toMatchObject({ current: true, kind: "web", name: "Browser", platform: null, appVersion: null });
    expect(view.sessions[0]).not.toHaveProperty("tokenHash");
    expect(view.sessions[0]).not.toHaveProperty("accountId");
    expect(await body(call("/v1/me"))).toMatchObject({ code: "signed_out" });
    expect((await call("/v1/account")).status).toBe(401);
    expect(await body(call("/v1/auth/start", { email: "bad" }))).toMatchObject({ code: "invalid_email" });
    expect(await body(call("/v1/auth/start", { email, pending: "unknown" }))).toMatchObject({ code: "invalid_request" });
  });

  it("keeps a sent code and its wrong guesses through a restart, and never saves the code itself", async () => {
    const { attempt } = await start();
    const wrong = code() === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 4; i++) expect(await body(call("/v1/auth/verify", { attempt, code: wrong }))).toMatchObject({ code: "wrong_code" });
    restart();
    expect(readFileSync(`${dataDir}/auth.json`, "utf8")).not.toContain(code());
    // the fifth wrong guess still ends it, so a restart never hands out fresh guesses
    const second = await (async () => { time += 30_000; return start(); })();
    restart();
    expect((await call("/v1/auth/verify", { attempt: second.attempt, code: code() })).status).toBe(200);
    expect(await body(call("/v1/auth/verify", { attempt, code: wrong }))).toMatchObject({ code: "wrong_code" });
    expect((await call("/v1/auth/verify", { attempt, code: wrong })).status).toBe(410);
  });

  it("limits each code to five wrong guesses, expires attempts and consumes successful codes", async () => {
    const { attempt } = await start();
    const wrong = code() === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 5; i++) expect(await body(call("/v1/auth/verify", { attempt, code: wrong }))).toMatchObject({ code: "wrong_code" });
    const expired = await call("/v1/auth/verify", { attempt, code: code() });
    expect(expired.status).toBe(410);
    time += 30_000;
    const next = await start(); time += 600_000;
    expect((await call("/v1/auth/verify", { attempt: next.attempt, code: code() })).status).toBe(410);
    const current = await start();
    expect((await call("/v1/auth/verify", { attempt: current.attempt, code: code() })).status).toBe(200);
    expect((await call("/v1/auth/verify", { attempt: current.attempt, code: code() })).status).toBe(410);
  });

  it("a used code ends the resend wait: signing out and in again at once sends a new code, never \"too many tries\"", async () => {
    const { attempt } = await start();
    expect((await call("/v1/auth/verify", { attempt, code: code() })).status).toBe(200);
    const again = await call("/v1/auth/start", { email });
    expect(again.status).toBe(200);
    // an unused code still holds the wait
    expect(await body(call("/v1/auth/start", { email }))).toMatchObject({ code: "rate_limited" });
  });

  it("ends the resend wait after its 30 seconds, not when the once-a-minute sweep next runs", async () => {
    await start();
    time += 29_000;
    expect(await body(call("/v1/auth/start", { email }))).toMatchObject({ code: "rate_limited" });
    time += 1_000;
    expect((await call("/v1/auth/start", { email })).status).toBe(200);
  });

  it("keeps a desktop sign-in through a restart, before and after it is approved, and never saves the device code", async () => {
    const browser = await login(), authorization = await authorize(), later = await authorize();
    restart();
    expect(readFileSync(`${dataDir}/auth.json`, "utf8")).not.toContain(authorization.deviceCode);
    expect(await body(poll(authorization))).toEqual({ error: "authorization_pending" });
    expect((await call(`/v1/auth/device?code=${authorization.userCode}`, undefined, browserHeaders(browser))).status).toBe(200);
    expect((await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser))).status).toBe(200);
    expect((await call("/v1/auth/device/approve", { userCode: later.userCode }, browserHeaders(browser))).status).toBe(200);
    restart(); time += 10_000;
    expect((await body<AppGrant>(poll(authorization))).account.id).toBe(browser.account.id);
    expect((await body<AppGrant>(poll(later))).account.id).toBe(browser.account.id);
    restart();
    expect(await body(poll(authorization))).toEqual({ error: "invalid_grant" });
  });

  it("shares resend, email and IP limits across web and app sign-in", async () => {
    await start();
    expect((await call("/api/cloud/app/sign-in/start", { email, ...device })).status).toBe(429);
    time += 30_000;
    // the resend wait answers before any limit is counted, so a double click never uses up an hour's codes
    for (let i = 0; i < AUTH_LIMITS.startsPerEmail - 1; i++) { await start(email, true); time += 30_000; }
    expect(await body(call("/v1/auth/start", { email }))).toMatchObject({ code: "rate_limited" });
    time += 3_600_000;
    for (let i = 0; i < AUTH_LIMITS.startsPerIp; i++) await start(`ip${i}@example.test`, i % 2 === 0);
    const response = await call("/api/cloud/app/sign-in/start", { email: "over@example.test", ...device });
    expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: "rate_limited" });
    time += 3_600_000;
    expect((await call("/v1/auth/start", { email })).status).toBe(200);
  });

  it("caps codes to one address a day and keeps part of the daily mail for people who already have an account", async () => {
    const existing = await login(); time += 30_000;
    // one stranger's inbox: at most emailsPerAddressPerDay codes, however slowly they are asked for
    const victim = "victim@example.test";
    for (let i = 0; i < AUTH_LIMITS.emailsPerAddressPerDay; i++) { await start(victim); time += 11 * 60_000; }
    expect(mailer.outbox.filter(item => item.to === victim)).toHaveLength(AUTH_LIMITS.emailsPerAddressPerDay);
    expect((await call("/v1/auth/start", { email: victim })).status).toBe(429);
    time += 86_400_000;
    const reports: Array<{ name?: string; key?: string }> = [];
    restart({ mailPerDay: 10, incidents: { report: (input: { name?: string; key?: string }) => { reports.push(input); return "id"; } } as unknown as DashboardAppOptions["incidents"] });
    // a spray of made-up addresses gets the signup share (8 of 10) and then 429; the account holder still gets a code
    for (let i = 0; i < 8; i++) await start(`made-up-${i}@example.test`);
    expect((await call("/v1/auth/start", { email: "made-up-9@example.test" })).status).toBe(429);
    expect(reports.filter(item => item.name === "SignInMailLimit")).toHaveLength(1);
    const again = await start(existing.account.email);
    expect((await call("/v1/auth/verify", { attempt: again.attempt, code: code(existing.account.email) })).status).toBe(200);
    // the whole day's budget (10) then stops everyone, and both limits make one incident between them
    time += 30_000; await start(existing.account.email);
    time += 30_000;
    expect((await call("/v1/auth/start", { email: existing.account.email })).status).toBe(429);
    const limits = reports.filter(item => item.name === "SignInMailLimit");
    expect(limits).toHaveLength(2);
    expect(new Set(limits.map(item => item.key)).size).toBe(1);
  });

  it("limits verifies per IP and trusts forwarded IPs only when configured", async () => {
    for (let i = 0; i < AUTH_LIMITS.verifiesPerIp; i++) expect((await call("/v1/auth/verify", { attempt: "missing", code: "12345678" })).status).toBe(410);
    expect((await call("/api/cloud/app/sign-in/verify", { attempt: "missing", code: "12345678" }, { "x-forwarded-for": "192.0.2.2" })).status).toBe(429);
    restart({ trustProxy: true });
    // the proxy appends the address it saw; whatever the client put first must not pick a fresh bucket
    for (let i = 0; i < AUTH_LIMITS.startsPerIp; i++) await start(`proxy${i}@example.test`, false, { "x-forwarded-for": `198.51.100.${i % 250}, 192.0.2.2` });
    expect((await call("/v1/auth/start", { email: "full@example.test" }, { "x-forwarded-for": "198.51.100.99, 192.0.2.2" })).status).toBe(429);
    expect((await call("/v1/auth/start", { email: "fresh@example.test" }, { "x-forwarded-for": "192.0.2.2, 192.0.2.1" })).status).toBe(200);
  });

  it("hides unknown accounts when signups close and allows existing accounts to sign in", async () => {
    const existing = await login(); time += 30_000;
    restart({ signupOpen: false });
    const known = await start(email, true), unknown = await start("new@example.test", true);
    expect({ ...unknown, attempt: "opaque" }).toEqual({ ...known, attempt: "opaque" });
    expect(unknown.signupOpen).toBe(false);
    expect(mailer.outbox.filter(item => item.to === "new@example.test")).toHaveLength(0);
    const denied = await call("/api/cloud/app/sign-in/verify", { attempt: unknown.attempt, code: "12345678" });
    // no code was sent, so a guess is just a wrong code: nothing says whether the address has an account
    expect(denied.status).toBe(400); expect(await denied.json()).toEqual({ error: "invalid_code" });
    expect((await body<AppGrant>(call("/api/cloud/app/sign-in/verify", { attempt: known.attempt, code: code() }))).account.id).toBe(existing.account.id);
    const web = await start("web-new@example.test");
    expect(await body(call("/v1/auth/verify", { attempt: web.attempt, code: "12345678" }))).toMatchObject({ code: "wrong_code" });
  });

  it.each([false, true])("sets both cookie flags and expires web sessions, https=%s", async secure => {
    restart({ publicUrl: `${secure ? "https" : "http"}://localhost:7480` });
    const { attempt } = await start();
    const response = await call("/v1/auth/verify", { attempt, code: code() });
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`${SESSION_COOKIE}=`); expect(cookies[0]).toContain("HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000");
    expect(cookies[1]).toContain(`${CSRF_COOKIE}=`); expect(cookies[1]).toContain("SameSite=Strict; Path=/; Max-Age=2592000"); expect(cookies[1]).not.toContain("HttpOnly");
    for (const cookie of cookies) expect(cookie.includes("; Secure")).toBe(secure);
    const result = await body<WebSignInAnswer>(response);
    expect(cookies[1]).toContain(`=${result.csrfToken};`);
    const headers = { cookie: cookies[0].split(";")[0] };
    time += 30 * day;
    expect((await call("/v1/me", undefined, headers)).status).toBe(401);
  });

  it("requires CSRF for account, claim, workspace and command mutations", async () => {
    const browser = await login(), headers = browserHeaders(browser);
    const { input } = enrollment();
    const enrolled = await body<EnrollAnswer>(call("/v1/enroll", input));
    const claim = { token: enrolled.claimUrl.split("#")[1] };
    for (const csrf of [undefined, "bad", "a".repeat(43)]) {
      const response = await call("/v1/claim", claim, { cookie: browser.cookie, ...(csrf ? { [CSRF_HEADER]: csrf } : {}) });
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "csrf" });
    }
    expect((await call("/v1/claim", claim, headers)).status).toBe(200);
    const paths = [
      ["PATCH", "/v1/account", { name: " Owner " }], ["PATCH", `/v1/workspaces/${enrolled.workspaceId}`, { name: "New name" }],
      ["POST", `/v1/workspaces/${enrolled.workspaceId}/commands`, { kind: "computer.wake", target: "bot" }],
      ["DELETE", "/v1/account/identities/google", {}], ["DELETE", "/v1/account/sessions/missing", {}],
      ["POST", "/v1/account/signout-everywhere", {}], ["POST", "/v1/account/delete", { email }],
      ["DELETE", `/v1/workspaces/${enrolled.workspaceId}`, {}],
    ] as const;
    for (const [method, path, input] of paths) expect(await body(call(path, input, { cookie: browser.cookie }, method))).toMatchObject({ code: "csrf" });
    for (const [method, path, input] of paths.slice(0, 3)) expect((await call(path, input, headers, method)).status).toBe(200);
    expect((await body<AccountAnswer>(call("/v1/account", undefined, headers))).account.name).toBe("Owner");
    for (const name of ["", " ", "x".repeat(81), "a\nb", 1]) expect((await call("/v1/account", { name }, headers, "PATCH")).status).toBe(400);
    expect((await body<AccountAnswer>(call("/v1/account", { name: null }, headers, "PATCH"))).account.name).toBeNull();
    expect((await call(`/v1/workspaces/${enrolled.workspaceId}`, {}, headers, "DELETE")).status).toBe(200);
  });

  it("issues app grants for desktop and mobile, validates inputs and keeps web attempts separate", async () => {
    for (const invalid of [{ deviceName: "" }, { deviceName: "a\nb" }, { deviceName: "a".repeat(101) }, { platform: "other" }, { appVersion: "1/2" }, { appVersion: "" }, { email: "bad" }]) {
      const response = await call("/api/cloud/app/sign-in/start", { email, ...device, ...invalid });
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    const started = await start(email, true);
    expect((await call("/v1/auth/verify", { attempt: started.attempt, code: code() })).status).toBe(400);
    const wrong = code() === "00000000" ? "11111111" : "00000000";
    expect(await body(call("/api/cloud/app/sign-in/verify", { attempt: started.attempt, code: wrong }))).toEqual({ error: "invalid_code" });
    const grant = await body<AppGrant>(call("/api/cloud/app/sign-in/verify", { attempt: started.attempt, code: code() }));
    expect(grant).toEqual({ cloudContractVersion: 1, accessToken: expect.stringMatching(/^omc_[A-Za-z0-9_-]{43}$/), expiresAt: time + 90 * day, device: { id: expect.stringMatching(/^ses_/) }, account: { id: expect.stringMatching(/^acct_/), email } });
    const session = await call("/api/cloud/desktop/session", undefined, bearer(grant));
    expect(await session.json()).toMatchObject({ cloudContractVersion: 1, expiresAt: grant.expiresAt, device: grant.device, account: grant.account, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } });
    expect(session.headers.get("set-cookie")).toBeNull();
    for (const platform of ["ios", "android", "win32", "linux"]) {
      time += 30_000;
      const attempt = await body<EmailStartAnswer>(call("/api/cloud/app/sign-in/start", { email, ...device, platform }));
      expect((await call("/api/cloud/app/sign-in/verify", { attempt: attempt.attempt, code: code() })).status).toBe(200);
    }
    time += 30_000;
    const browser = await login();
    const sessions = (await body<AccountAnswer>(call("/v1/account", undefined, browserHeaders(browser)))).sessions;
    expect(sessions.filter(item => item.kind === "mobile").map(item => item.platform).sort()).toEqual(["android", "ios"]);
    expect(sessions.find(item => item.id === grant.device.id)).toMatchObject({ kind: "desktop", name: device.deviceName, platform: device.platform, appVersion: device.appVersion });
    expect((await call("/v1/me", undefined, { cookie: `${SESSION_COOKIE}=${grant.accessToken}` })).status).toBe(401);
    expect((await call("/api/cloud/desktop/session", undefined, { authorization: `Bearer omc_${browser.cookie.split("=")[1]}` })).status).toBe(401);
  });

  it("renews app sessions within 30 days, throttles last-seen writes and rejects expired or revoked tokens", async () => {
    const grant = await appLogin();
    time += 20_000;
    await call("/api/cloud/desktop/session", undefined, bearer(grant)); app.close();
    const saved = () => JSON.parse(readFileSync(`${dataDir}/auth.json`, "utf8")) as { sessions: Array<{ lastSeenAt: number; expiresAt: number }> };
    expect(saved().sessions[0].lastSeenAt).toBe(time - 20_000);
    restart(); time += 40_000;
    await call("/api/cloud/desktop/session", undefined, bearer(grant)); app.close();
    expect(saved().sessions[0].lastSeenAt).toBe(time);
    restart(); time += 61 * day;
    expect(await body(call("/api/cloud/desktop/session", undefined, bearer(grant)))).toMatchObject({ expiresAt: time + 90 * day });
    expect((await call("/api/cloud/desktop/session", {}, bearer(grant), "DELETE")).status).toBe(200);
    for (const method of ["GET", "DELETE"]) {
      const response = await call("/api/cloud/desktop/session", method === "GET" ? undefined : {}, bearer(grant), method);
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "invalid_token" });
    }
    const expired = await appLogin(); time += 90 * day;
    expect(await body(call("/api/cloud/desktop/session", undefined, bearer(expired)))).toEqual({ error: "invalid_token" });
  });

  it("allows only specified app CORS routes and formats malformed app requests as Admin errors", async () => {
    for (const path of ["/api/cloud/app/sign-in/start", "/api/cloud/app/sign-in/verify", "/api/cloud/desktop/session", "/v1/app/enroll-grant", "/v1/auth/app/token"]) {
      const response = await call(path, undefined, { origin: "capacitor://localhost", "access-control-request-method": "POST" }, "OPTIONS");
      expect(response.status).toBe(204); expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-headers")).toBe("content-type, authorization, x-dusk-version");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull(); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await call("/v1/auth/providers", undefined, {}, "OPTIONS")).headers.get("access-control-allow-origin")).toBeNull();
    const started = await call("/api/cloud/app/sign-in/start", { email, ...device }, { origin: "capacitor://localhost" });
    expect(started.status).toBe(200); expect(started.headers.get("access-control-allow-origin")).toBe("*");
    const malformed = await fetch(url + "/api/cloud/app/sign-in/start", { method: "POST", body: "{" });
    expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ error: "invalid_request" });
    expect((await call("/v1/auth/start", { email }, { origin: "https://other.test" })).status).toBe(403);
    const failed = await call("/api/cloud/desktop/session");
    expect(failed.headers.get("access-control-allow-origin")).toBe("*");
    expect(failed.headers.get("cache-control")).toBe("no-store");
  });

  it("supports desktop pending, slowdown, lookup, approval and a one-time grant", async () => {
    const browser = await login(), authorization = await authorize();
    expect(authorization.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.userCode).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(authorization).toMatchObject({ cloudContractVersion: 1, expiresIn: 900, interval: 5, verificationUri: `${options.publicUrl}/cloud/desktop`, verificationUriComplete: `${options.publicUrl}/cloud/desktop?code=${authorization.userCode}` });
    expect(await body(poll(authorization))).toEqual({ error: "authorization_pending" });
    expect(await body(poll(authorization))).toEqual({ error: "slow_down", interval: 10 });
    expect((await call(`/v1/auth/device?code=${authorization.userCode}`)).status).toBe(401);
    expect(await body(call(`/v1/auth/device?code=${authorization.userCode}`, undefined, browserHeaders(browser)))).toEqual({ fresh: false, device: { name: device.deviceName, platform: "darwin" }, userCode: authorization.userCode, expiresAt: time + 900_000 });
    expect((await call("/v1/auth/device?code=unknown", undefined, browserHeaders(browser))).status).toBe(404);
    // an account step's context is bound to the sign-in (never the URL): the website reads where to land from here
    const upgrading = await body<Authorization>(call("/api/cloud/desktop/authorize", { ...device, intent: { kind: "upgrade", plan: "pro", source: "app_computer_move", move: "ws_abc" } }));
    expect(await body(call(`/v1/auth/device?code=${upgrading.userCode}`, undefined, browserHeaders(browser)))).toMatchObject({
      intent: { kind: "upgrade", plan: "pro", source: "app_computer_move", move: "ws_abc" }, next: "/billing?plan=pro&src=app_computer_move&from=app" });
    const signingIn = await body<Authorization>(call("/api/cloud/desktop/authorize", { ...device, intent: { kind: "signin", plan: "pro" } }));
    expect(await body(call(`/v1/auth/device?code=${signingIn.userCode}`, undefined, browserHeaders(browser)))).toMatchObject({ intent: { kind: "signin" }, next: "/" });
    expect((await call("/api/cloud/desktop/authorize", { ...device, intent: { kind: "anything" } })).status).toBe(400);
    expect((await call("/v1/auth/device/approve", { userCode: authorization.userCode }, { cookie: browser.cookie })).status).toBe(403);
    expect((await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser))).status).toBe(200);
    expect((await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser))).status).toBe(404);
    time += 10_000;
    const grant = await body<AppGrant>(poll(authorization));
    expect(grant.account.id).toBe(browser.account.id);
    expect(grant.accessToken).toMatch(/^omc_[A-Za-z0-9_-]{43}$/);
    expect((await call("/api/cloud/desktop/session", undefined, bearer(grant))).status).toBe(200);
    expect(await body(poll(authorization))).toEqual({ error: "invalid_grant" });
  });

  it("an account made by the app's browser sign-in stays open for the website's first steps, and the app's session says so until they end", async () => {
    const authorization = await authorize();
    time += 1_000;
    const browser = await login("new@example.test");
    expect((await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser))).status).toBe(200);
    time += 10_000;
    const grant = await body<AppGrant>(poll(authorization));
    const session = () => body<{ websiteSetup?: string }>(call("/api/cloud/desktop/session", undefined, bearer(grant)));
    expect((await session()).websiteSetup).toBe("open");
    expect((await call("/v1/account/onboarded", { home: "anywhere" }, browserHeaders(browser))).status).toBe(400);
    expect((await call("/v1/account/onboarded", { home: "free" }, browserHeaders(browser))).status).toBe(200);
    expect((await session()).websiteSetup).toBe("free");
    // done once: a later finish never rewrites where the bots went
    await call("/v1/account/onboarded", { home: "cloud" }, browserHeaders(browser));
    expect((await session()).websiteSetup).toBe("free");
  });

  it("the app's way back to the browser (a handoff) leaves the website's first steps open for the account it made", async () => {
    const authorization = await authorize();
    time += 1_000;
    const browser = await login("again@example.test");
    await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser));
    time += 10_000;
    const grant = await body<AppGrant>(poll(authorization));
    const answer = await body<WebHandoffAnswer>(call("/v1/app/web-handoff", { next: "home" }, bearer(grant)));
    const redeemed = await call("/v1/auth/handoff", { token: answer.url.split("#t=")[1]!, confirm: true }, { origin: options.publicUrl });
    expect(redeemed.status).toBe(200);
    expect((await body<{ websiteSetup?: string }>(call("/api/cloud/desktop/session", undefined, bearer(grant)))).websiteSetup).toBe("open");
  });

  it("an existing account signing in to the app is never sent through the website's first steps", async () => {
    const browser = await login();
    time += 1_000;
    const authorization = await authorize();
    expect((await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser))).status).toBe(200);
    time += 10_000;
    const grant = await body<AppGrant>(poll(authorization));
    expect(await body(call("/api/cloud/desktop/session", undefined, bearer(grant)))).not.toHaveProperty("websiteSetup");
  });

  it("before launch the website has no first steps, so an app-made account is onboarded at its grant", async () => {
    restart({ waitlistOnly: true, pageBase: "/dashboard" });
    const authorization = await authorize();
    time += 1_000;
    const browser = await login("early@example.test");
    expect((await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser))).status).toBe(200);
    time += 10_000;
    const grant = await body<AppGrant>(poll(authorization));
    expect(await body(call("/api/cloud/desktop/session", undefined, bearer(grant)))).not.toHaveProperty("websiteSetup");
  });

  it("denies and expires authorizations, validates devices and limits authorization requests", async () => {
    const browser = await login(), authorization = await authorize();
    expect((await call("/v1/auth/device/deny", { userCode: authorization.userCode }, { cookie: browser.cookie })).status).toBe(403);
    expect((await call("/v1/auth/device/deny", { userCode: authorization.userCode }, browserHeaders(browser))).status).toBe(200);
    expect(await body(poll(authorization))).toEqual({ error: "access_denied" });
    const expired = await authorize(); time += 900_000;
    expect(await body(poll(expired))).toEqual({ error: "expired_token" });
    expect((await call(`/v1/auth/device?code=${expired.userCode}`, undefined, browserHeaders(browser))).status).toBe(404);
    expect(await body(call("/api/cloud/desktop/authorize", { deviceName: "bad", platform: "other" }))).toEqual({ error: "invalid_request" });
    for (let i = 0; i < AUTH_LIMITS.deviceAuthorizePerIp - 2; i++) expect((await call("/api/cloud/desktop/authorize", { deviceName: "Valid", platform: "linux" })).status).toBe(200);
    expect((await call("/api/cloud/desktop/authorize", device)).status).toBe(429);
  });

  it("lists sessions newest first and revokes only owned sessions", async () => {
    const grant = await appLogin(); time += 30_000;
    const browser = await login(); time += 30_000;
    const other = await login("other@example.test");
    const view = await body<AccountAnswer>(call("/v1/account", undefined, browserHeaders(browser)));
    expect(view.sessions.map(item => item.kind)).toEqual(["web", "desktop"]);
    expect(view.sessions.map(item => item.current)).toEqual([true, false]);
    expect((await call(`/v1/account/sessions/${grant.device.id}`, {}, browserHeaders(other), "DELETE")).status).toBe(404);
    expect((await call(`/v1/account/sessions/${grant.device.id}`, {}, browserHeaders(browser), "DELETE")).status).toBe(200);
    expect((await call("/api/cloud/desktop/session", undefined, bearer(grant))).status).toBe(401);
    expect((await call("/v1/me", undefined, browserHeaders(browser))).status).toBe(200);
    const response = await call("/v1/auth/signout", {}, { cookie: browser.cookie });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().every(cookie => cookie.includes("Max-Age=0"))).toBe(true);
    expect((await call("/v1/me", undefined, browserHeaders(browser))).status).toBe(401);
    expect((await call("/v1/me", undefined, browserHeaders(other))).status).toBe(200);
    expect((await call("/v1/auth/signout", {})).status).toBe(200);
  });

  it("signs out every web and app session and removes pending approvals", async () => {
    const grant = await appLogin(); time += 30_000;
    const browser = await login(); time += 30_000;
    const second = await login();
    const authorization = await authorize();
    await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser));
    const response = await call("/v1/account/signout-everywhere", {}, browserHeaders(browser));
    expect(response.status).toBe(200); expect(response.headers.getSetCookie()).toHaveLength(2);
    for (const session of [browser, second]) expect((await call("/v1/me", undefined, browserHeaders(session))).status).toBe(401);
    expect((await call("/api/cloud/desktop/session", undefined, bearer(grant))).status).toBe(401);
    expect(await body(poll(authorization))).toEqual({ error: "invalid_grant" });
  });

  it("extends session data while keeping identity fields authoritative", async () => {
    const grant = await appLogin();
    app.auth.extendSession(id => ({ account: { id: "spoofed" }, cloudContractVersion: 99, expiresAt: 0, device: {}, teams: [id], entitlement: { plan: "pro", status: "active", expiresAt: time + day, version: 1 } }));
    app.auth.extendSession(async () => ({ cloud: { id: "cloud_fixture" } }));
    expect(await body(call("/api/cloud/desktop/session", undefined, bearer(grant)))).toMatchObject({ cloudContractVersion: 1, account: grant.account, device: grant.device, expiresAt: grant.expiresAt,
      teams: [grant.account.id], cloud: { id: "cloud_fixture" }, entitlement: { plan: "pro", status: "active", expiresAt: time + day, version: 1 } });
  });

  it("keeps the avatar the person picks on the account, for every app session", async () => {
    const grant = await appLogin();
    expect((await call("/v1/app/avatar", { avatar: "g:abc123" })).status).toBe(401);
    expect(await body(call("/v1/app/avatar", { avatar: "g:abc123" }, bearer(grant)))).toEqual({ avatar: "g:abc123" });
    expect(await body<AppGrant>(call("/api/cloud/desktop/session", undefined, bearer(grant)))).toMatchObject({ account: { avatar: "g:abc123" } });
    time += 30_000;
    const other = await appLogin();
    expect(other.account.avatar).toBe("g:abc123");
    // no photo to use, and nothing that isn't an avatar
    for (const avatar of ["photo", "g:", "g:ABC", "g:../x", "https://example.test/a.png", 7]) expect((await call("/v1/app/avatar", { avatar }, bearer(grant))).status).toBe(400);
    expect(await body(call("/v1/app/avatar", { avatar: "drawn" }, bearer(grant)))).toEqual({ avatar: "drawn" });
    expect(await body(call("/v1/app/avatar", { avatar: null }, bearer(grant)))).toEqual({ avatar: null });
    expect((await body<AppGrant>(call("/api/cloud/desktop/session", undefined, bearer(grant)))).account.avatar).toBeUndefined();
  });

  it("enrolls with a signed grant and refuses bad, stale, replayed and reused grants", async () => {
    const grant = await appLogin();
    expect((await call("/v1/app/enroll-grant", {})).status).toBe(401);
    const enrollGrant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(grant)));
    expect(enrollGrant).toEqual({ v: 1, enrollToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: time + 600_000, dashboardUrl: options.publicUrl });
    const request = enrollment(enrollGrant.enrollToken);
    expect((await call("/v1/enroll", request.input)).status).toBe(401);
    expect((await call("/v1/enroll", request.input, { ...request.headers, [SIGNATURE_HEADERS.signature]: Buffer.alloc(64).toString("base64") })).status).toBe(401);
    const stale = enrollment(enrollGrant.enrollToken, { keys: request.keys, at: time - SIGNATURE_SKEW_MS - 1 });
    expect(await body(call("/v1/enroll", stale.input, stale.headers))).toMatchObject({ code: "stale_time" });
    const enrolled = await body<EnrollAnswer>(call("/v1/enroll", request.input, request.headers));
    expect(enrolled.claimExpiresAt).toBe(0); expect(enrolled.claimUrl).toBe(`${options.publicUrl}/?workspace=${enrolled.workspaceId}`);
    expect(await body(call("/v1/enroll", request.input, request.headers))).toMatchObject({ code: "replay" });
    const used = enrollment(enrollGrant.enrollToken, { keys: request.keys, at: ++time });
    expect((await call("/v1/enroll", used.input, used.headers)).status).toBe(403);
    time += 30_000;
    const owner = await login();
    expect(await body(call("/v1/workspaces", undefined, browserHeaders(owner)))).toMatchObject({ workspaces: [{ id: enrolled.workspaceId }] });
    const next = await appLogin("other@example.test");
    const expires = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(next)));
    time += 600_000;
    expect(app.auth.consumeEnrollGrant(expires.enrollToken)).toBeNull();
    expect((await call("/v1/enroll", { ...request.input, enrollToken: "bad" })).status).toBe(400);
    app.close();
    const saved = JSON.parse(readFileSync(`${dataDir}/state.json`, "utf8"));
    expect(saved.workspaces[0].claimHash).toBeNull();
  });

  it("takes a workspace off the dashboard for the app that forgot it, only the account's own", async () => {
    const owner = await appLogin();
    const grant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(owner)));
    const request = enrollment(grant.enrollToken);
    const enrolled = await body<EnrollAnswer>(call("/v1/enroll", request.input, request.headers));
    expect((await call("/v1/app/workspace-unlink", { workspaceId: enrolled.workspaceId })).status).toBe(401);
    expect((await call("/v1/app/workspace-unlink", { workspaceId: "../x" }, bearer(owner))).status).toBe(400);
    const other = await appLogin("other@example.test");
    expect(await body(call("/v1/app/workspace-unlink", { workspaceId: enrolled.workspaceId }, bearer(other)))).toEqual({ ok: true, removed: false });
    time += 30_000;
    const web = await login();
    expect(await body(call("/v1/workspaces", undefined, browserHeaders(web)))).toMatchObject({ workspaces: [{ id: enrolled.workspaceId }] });
    expect(await body(call("/v1/app/workspace-unlink", { workspaceId: enrolled.workspaceId }, bearer(owner)))).toEqual({ ok: true, removed: true });
    expect(await body(call("/v1/workspaces", undefined, browserHeaders(web)))).toEqual({ workspaces: [] });
    expect(await body(call("/v1/app/workspace-unlink", { workspaceId: enrolled.workspaceId }, bearer(owner)))).toEqual({ ok: true, removed: false });
  });

  it("signs a link grant only for a signed-in app, behind the json and origin checks, that the link service accepts", async () => {
    expect((await call("/v1/app/link-grant", {})).status).toBe(401);
    const grant = await appLogin();
    expect((await call("/v1/app/link-grant", {}, { ...bearer(grant), origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(url + "/v1/app/link-grant", { method: "POST", headers: { ...bearer(grant), "content-type": "text/plain" }, body: "{}" })).status).toBe(403);
    expect((await fetch(url + "/v1/app/link-grant", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } })).headers.get("access-control-allow-origin")).toBeNull();
    const answer = await body<{ v: 1; grant: string; expiresAt: number }>(call("/v1/app/link-grant", {}, bearer(grant)));
    expect(answer).toEqual({ v: 1, grant: expect.stringMatching(/^l1\.[a-z0-9-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), expiresAt: time + LINK_GRANT_TTL_MS });
    const keys = [entitlementPublicKey(linkGrantSignerFromEnv(process.env, { dataDir, loopback: true })!)];
    const other = await body<{ grant: string }>(call("/v1/app/link-grant", {}, bearer(await appLogin("other@example.test"))));
    const mine = verifyLinkGrant(answer.grant, { keys, now: time }), theirs = verifyLinkGrant(other.grant, { keys, now: time });
    expect(mine).toEqual({ ok: true, acct: linkAccountRef(grant.account.id) });
    expect(theirs.ok && mine.ok && theirs.acct !== mine.acct).toBe(true);
    expect(answer.grant).not.toContain(grant.account.id);
    expect(verifyLinkGrant(answer.grant, { keys, now: time + LINK_GRANT_TTL_MS + 3 * 60_000 })).toEqual({ ok: false, error: "expired" });
  });

  it("mints screen TURN credentials only for a signed-in app, and says when TURN is off", async () => {
    expect((await call("/v1/app/screen-ice", {})).status).toBe(401);
    const grant = await appLogin();
    expect((await call("/v1/app/screen-ice", {}, { ...bearer(grant), origin: "https://evil.example" })).status).toBe(403);
    expect(await body(call("/v1/app/screen-ice", {}, bearer(grant)))).toMatchObject({ code: "turn_off" });
  });

  it("claims an unclaimed workspace and re-enrolls one the same account owns, but never one another account owns", async () => {
    const owner = await appLogin();
    const firstGrant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(owner)));
    const unsigned = enrollment();
    const pending = await body<EnrollAnswer>(call("/v1/enroll", unsigned.input, unsigned.headers));
    expect(pending.claimExpiresAt).toBeGreaterThan(0);
    const claim = enrollment(firstGrant.enrollToken, { keys: unsigned.keys, at: ++time });
    expect(await body<EnrollAnswer>(call("/v1/enroll", claim.input, claim.headers))).toMatchObject({ workspaceId: pending.workspaceId, claimExpiresAt: 0 });
    const againGrant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(owner)));
    const again = enrollment(againGrant.enrollToken, { keys: unsigned.keys, at: ++time });
    expect(await body<EnrollAnswer>(call("/v1/enroll", again.input, again.headers))).toMatchObject({ workspaceId: pending.workspaceId, claimExpiresAt: 0 });
    time += 30_000;
    const web = await login();
    expect((await call(`/v1/workspaces/${pending.workspaceId}/commands`, { kind: "routine.resume", target: "r1" }, browserHeaders(web))).status).toBe(200);
    time += 30_000;
    const attacker = await appLogin("other@example.test");
    const attackGrant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(attacker)));
    const attack = enrollment(attackGrant.enrollToken, { keys: unsigned.keys, at: ++time });
    const refused = await call("/v1/enroll", attack.input, attack.headers);
    expect(refused.status).toBe(409);
    expect(await body(refused)).toMatchObject({ code: "owned_elsewhere" });
    expect(await body<WorkspaceDetail>(call(`/v1/workspaces/${pending.workspaceId}`, undefined, browserHeaders(web)))).toMatchObject({
      workspace: { id: pending.workspaceId }, commands: [{ kind: "routine.resume", target: "r1" }] });
    time += 30_000;
    const other = await login("other@example.test");
    expect(await body(call("/v1/workspaces", undefined, browserHeaders(other)))).toEqual({ workspaces: [] });
  });

  it("ends grants with their app session and lets another account enroll a workspace only after its owner removes it", async () => {
    const first = await appLogin();
    const firstGrant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(first)));
    const request = enrollment(firstGrant.enrollToken);
    const enrolled = await body<EnrollAnswer>(call("/v1/enroll", request.input, request.headers));
    time += 30_000;
    const owner = await login();
    expect((await call(`/v1/workspaces/${enrolled.workspaceId}/commands`, { kind: "routine.resume", target: "r1" }, browserHeaders(owner))).status).toBe(200);
    time += 30_000;
    const next = await appLogin("other@example.test");
    const revoked = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(next)));
    const kept = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(next)));
    time += 30_000;
    const later = await appLogin("other@example.test");
    expect((await call("/api/cloud/desktop/session", {}, bearer(next), "DELETE")).status).toBe(200);
    // the session that asked for the grant is gone, so neither of its grants enrolls anything
    const stale = enrollment(revoked.enrollToken, { keys: request.keys, at: ++time });
    expect((await call("/v1/enroll", stale.input, stale.headers)).status).toBe(403);
    expect(app.auth.consumeEnrollGrant(kept.enrollToken)).toBeNull();
    const fresh = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(later)));
    const refused = enrollment(fresh.enrollToken, { keys: request.keys, at: ++time });
    expect((await call("/v1/enroll", refused.input, refused.headers)).status).toBe(409);
    expect((await call(`/v1/workspaces/${enrolled.workspaceId}`, {}, browserHeaders(owner), "DELETE")).status).toBe(200);
    const retry = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(later)));
    const move = enrollment(retry.enrollToken, { keys: request.keys, at: ++time });
    const moved = await body<EnrollAnswer>(call("/v1/enroll", move.input, move.headers));
    time += 30_000;
    const nextOwner = await login("other@example.test");
    expect(await body<WorkspaceDetail>(call(`/v1/workspaces/${moved.workspaceId}`, undefined, browserHeaders(nextOwner)))).toMatchObject({ commands: [] });
  });

  it("answers closed-signup starts before mail goes out, so timing never shows an account exists", async () => {
    await login(); time += 30_000;
    restart({ signupOpen: false, mailer: { send: () => new Promise<void>(() => {}) } });
    const known = await call("/v1/auth/start", { email });
    expect(known.status).toBe(200);
    restart({ signupOpen: false, mailer: { send: async () => { throw new Error("down"); } } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    time += 30_000;
    expect((await call("/v1/auth/start", { email })).status).toBe(200);
    expect((await call("/v1/auth/start", { email: "nobody@example.test" })).status).toBe(200);
  });

  it("recovers a sign-in by email: the code, a one-time website link and the ways in, the same answer for no account", async () => {
    const first = await login(); time += 30_000;
    const recovered = await body<EmailStartAnswer>(call("/v1/auth/start", { email, recover: true }));
    const mail = mailer.outbox.at(-1)!;
    expect(mail).toMatchObject({ to: email, subject: expect.stringMatching(/^\d{8} is your Metal code$/) });
    expect(mail.text).toContain("this account signs in with an emailed code.");
    const link = new URL(/^sign in: (\S+)$/m.exec(mail.text)![1]!), secret = new URLSearchParams(link.hash.slice(1));
    // the code in the fragment: never sent to a server, so never in a log. the attempt (nothing without the code) rides in
    // the query, so the page can tell a real link before launch
    expect(`${link.origin}${link.pathname}${link.search}`).toBe(`http://127.0.0.1:7480/sign-in?attempt=${recovered.attempt}`);
    expect([...secret.keys()]).toEqual(["code"]);
    secret.set("attempt", link.searchParams.get("attempt")!);
    const signedIn = await call("/v1/auth/verify", { attempt: secret.get("attempt"), code: secret.get("code") });
    expect(signedIn.status).toBe(200); expect((await body<WebSignInAnswer>(signedIn)).account.id).toBe(first.account.id);
    expect((await call("/v1/auth/verify", { attempt: secret.get("attempt"), code: secret.get("code") })).status).toBe(410);
    // the app gets the code alone: a link would sign in the browser, not this computer
    time += 30_000;
    const app = await body<EmailStartAnswer>(call("/api/cloud/app/sign-in/start", { email, ...device, recover: true }));
    expect(mailer.outbox.at(-1)!.text).not.toContain("/sign-in#");
    const grant = await call("/api/cloud/app/sign-in/verify", { attempt: app.attempt, code: code() });
    expect((await body<AppGrant>(grant)).account.id).toBe(first.account.id);
    // no account: the same answer, a mail that says so, and no code that could create one
    const sent = mailer.outbox.length;
    const nobody = await call("/v1/auth/start", { email: "nobody@example.test", recover: true });
    expect(nobody.status).toBe(200); expect(Object.keys(await nobody.json() as object).sort()).toEqual(Object.keys(recovered as object).sort());
    expect(mailer.outbox).toHaveLength(sent + 1);
    expect(mailer.outbox.at(-1)!.text).toContain("no account uses it"); expect(mailer.outbox.at(-1)!.text).not.toMatch(/\b\d{8}\b/);
    for (const bad of [{ email, recover: "yes" }, { email, recover: false }]) expect((await call("/v1/auth/start", bad)).status).toBe(400);
  });

  it("answers recovery before mail goes out and keeps the resend limit", async () => {
    await login(); time += 30_000;
    restart({ mailer: { send: () => new Promise<void>(() => {}) } });
    expect((await call("/v1/auth/start", { email, recover: true })).status).toBe(200);
    expect((await call("/v1/auth/start", { email, recover: true })).status).toBe(429);
  });

  it("deletes accounts, identities, sessions, attempts, grants and owned workspaces, awaiting hooks", async () => {
    const grant = await appLogin(); time += 30_000;
    const browser = await login();
    const enrollGrant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(grant)));
    const request = enrollment(enrollGrant.enrollToken);
    await call("/v1/enroll", request.input, request.headers);
    const leftover = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(grant)));
    const authorization = await authorize();
    await call("/v1/auth/device/approve", { userCode: authorization.userCode }, browserHeaders(browser));
    time += 30_000; const attempt = await start();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    let hookDone = false;
    app.auth.onAccountDeleted(async id => { expect(id).toBe(browser.account.id); await new Promise(resolve => setTimeout(resolve, 5)); hookDone = true; });
    app.auth.onAccountDeleted(() => { throw new Error("sensitive fixture detail"); });
    expect((await call("/v1/account/delete", { email: "mismatch@example.test" }, browserHeaders(browser))).status).toBe(400);
    const response = await call("/v1/account/delete", { email }, browserHeaders(browser));
    expect(response.status).toBe(200); expect(hookDone).toBe(true);
    expect(logs).toHaveBeenCalledWith("Account deletion cleanup failed.");
    expect(response.headers.getSetCookie().every(cookie => cookie.includes("Max-Age=0"))).toBe(true);
    expect(app.auth.account(browser.account.id)).toBeNull();
    expect(app.auth.consumeEnrollGrant(leftover.enrollToken)).toBeNull();
    expect((await call("/v1/me", undefined, browserHeaders(browser))).status).toBe(401);
    expect((await call("/api/cloud/desktop/session", undefined, bearer(grant))).status).toBe(401);
    expect((await call("/v1/auth/verify", { attempt: attempt.attempt, code: code() })).status).toBe(410);
    expect(await body(poll(authorization))).toEqual({ error: "invalid_grant" });
    app.close();
    expect(JSON.parse(readFileSync(`${dataDir}/auth.json`, "utf8"))).toEqual({ accounts: [], identities: [], sessions: [], codes: [], devices: [] });
    expect(JSON.parse(readFileSync(`${dataDir}/state.json`, "utf8"))).toEqual({ accounts: [], sessions: [], workspaces: [], commands: [] });
  });

  it("deletes the account from the app with its own session: the account's email, a bearer, nothing else", async () => {
    const grant = await appLogin();
    const other = await appLogin("other@example.test");
    const route = "/v1/app/delete-account";
    expect((await call(route, { email })).status).toBe(401);
    expect((await call(route, { email: "other@example.test" }, bearer(grant))).status).toBe(400);
    expect((await call(route, { email }, bearer(other))).status).toBe(400);
    const preflight = await fetch(url + route, { method: "OPTIONS", headers: { origin: "capacitor://localhost", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    const response = await call(route, { email: email.toUpperCase() }, bearer(grant));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(app.auth.account(grant.account.id)).toBeNull();
    expect((await call("/api/cloud/desktop/session", undefined, bearer(grant))).status).toBe(401);
    expect((await call("/api/cloud/desktop/session", undefined, bearer(other))).status).toBe(200);
    expect(mailer.outbox.some(item => item.to === email && /deleted/i.test(item.subject))).toBe(true);
  });

  describe("App Review sign-in", () => {
    const reviewer = "review@example.test", reviewCode = "48213907";
    beforeEach(() => restart({ review: { email: reviewer, code: reviewCode }, signupOpen: false }));
    const appStart = (address: string) => call("/api/cloud/app/sign-in/start", { email: address, ...device });

    it("signs the one review address in to an app with its fixed code and sends it no mail, even with signups closed", async () => {
      const started = await appStart(reviewer);
      expect(started.status).toBe(200);
      const { attempt } = await body<EmailStartAnswer>(started);
      expect(mailer.outbox.filter(item => item.to === reviewer)).toEqual([]);
      const verified = await call("/api/cloud/app/sign-in/verify", { attempt, code: reviewCode });
      expect(verified.status).toBe(200);
      const grant = await body<AppGrant>(verified);
      expect(grant.account.email).toBe(reviewer);
      expect((await call("/api/cloud/desktop/session", undefined, bearer(grant))).status).toBe(200);
    });

    it("never takes the fixed code for any other address, and holds it to the normal tries and limits", async () => {
      const { attempt: mine } = await body<EmailStartAnswer>(await appStart(email));
      expect((await call("/api/cloud/app/sign-in/verify", { attempt: mine, code: reviewCode })).status).toBe(400);
      // the website never uses the fixed code: the address gets an ordinary emailed one
      const web = await body<EmailStartAnswer>(await call("/v1/auth/start", { email: reviewer }));
      expect((await call("/v1/auth/verify", { attempt: web.attempt, code: reviewCode })).status).toBe(400);
      time += 31_000;
      const { attempt } = await body<EmailStartAnswer>(await appStart(reviewer));
      for (let tries = 0; tries < 5; tries++) expect((await call("/api/cloud/app/sign-in/verify", { attempt, code: "00000000" })).status).toBe(400);
      expect((await call("/api/cloud/app/sign-in/verify", { attempt, code: reviewCode })).status).toBe(410);
      // roomier than an ordinary address (several reviewers and devices), still a hard hourly cap; the web start above counts too
      expect(REVIEW_LIMITS.startsPerHour).toBeGreaterThan(AUTH_LIMITS.startsPerEmail);
      for (let starts = 2; starts < REVIEW_LIMITS.startsPerHour; starts++) { time += 31_000; expect((await appStart(reviewer)).status).toBe(200); }
      time += 31_000;
      expect((await appStart(reviewer)).status).toBe(429);
    });

    it("is off without both settings and refuses a malformed one", () => {
      expect(reviewAccountFromEnv({})).toBeNull();
      expect(reviewAccountFromEnv({ DUSK_REVIEW_EMAIL: " Review@Example.test ", DUSK_REVIEW_CODE: "12345678" })).toEqual({ email: "review@example.test", code: "12345678" });
      expect(() => reviewAccountFromEnv({ DUSK_REVIEW_EMAIL: reviewer })).toThrow();
      expect(() => reviewAccountFromEnv({ DUSK_REVIEW_EMAIL: reviewer, DUSK_REVIEW_CODE: "1234" })).toThrow();
      expect(() => reviewAccountFromEnv({ DUSK_REVIEW_EMAIL: "nope", DUSK_REVIEW_CODE: "12345678" })).toThrow();
    });
  });

  it("removes a linked identity while retaining email and does not expose provider subjects", async () => {
    const browser = await login();
    app.close();
    const path = `${dataDir}/auth.json`, saved = JSON.parse(readFileSync(path, "utf8"));
    saved.identities.push({ accountId: browser.account.id, provider: "google", subject: "private-subject", email, label: "Fixture", addedAt: time });
    writeFileSync(path, JSON.stringify(saved));
    app = createDashboardApp(options); server.removeAllListeners("request"); server.on("request", app.handle);
    const linked = await body<AccountAnswer>(call("/v1/account", undefined, browserHeaders(browser)));
    expect(linked.account.providers).toEqual(["email", "google"]);
    expect(linked.identities).toEqual([{ provider: "google", email, label: "Fixture", addedAt: time }]);
    const removed = await body<AccountAnswer>(call("/v1/account/identities/google", {}, browserHeaders(browser), "DELETE"));
    expect(removed.identities).toEqual([]); expect(removed.account.providers).toEqual(["email"]);
    expect((await call("/v1/account/identities/google", {}, browserHeaders(browser), "DELETE")).status).toBe(404);
  });

  it("persists only hashes with private permissions and reuses the generated secret across restarts", async () => {
    const grant = await appLogin(); time += 30_000;
    const browser = await login();
    const enroll = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(grant)));
    const authorization = await authorize();
    app.close();
    const saved = readFileSync(`${dataDir}/auth.json`, "utf8");
    for (const value of [grant.accessToken, browser.cookie.split("=")[1]!, browser.csrfToken, enroll.enrollToken, authorization.deviceCode, ...mailer.outbox.flatMap(item => item.text.match(/\b\d{8}\b/) ?? [])]) expect(saved).not.toContain(value);
    expect(JSON.parse(saved).sessions.every((item: { tokenHash: string }) => /^[a-f0-9]{64}$/.test(item.tokenHash))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(`${dataDir}/auth.json`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dataDir}/auth-secret`).mode & 0o777).toBe(0o600);
    }
    const secret = readFileSync(`${dataDir}/auth-secret`, "utf8");
    restart();
    expect(readFileSync(`${dataDir}/auth-secret`, "utf8")).toBe(secret);
    expect(await body(call("/v1/me", undefined, browserHeaders(browser)))).toMatchObject({ csrfToken: browser.csrfToken });
    expect((await call("/v1/account", { name: "After restart" }, browserHeaders(browser), "PATCH")).status).toBe(200);
    expect((await call("/api/cloud/desktop/session", undefined, bearer(grant))).status).toBe(200);
    expect(app.auth.consumeEnrollGrant(enroll.enrollToken)).toBeNull();
  });

  describe("web handoff", () => {
    const plans = { next: "plans", plan: "pro", source: "app_computer_move" };
    const same = () => ({ origin: options.publicUrl });
    const issue = (grant: AppGrant, input: unknown = plans) => call("/v1/app/web-handoff", input, bearer(grant));
    const tokenOf = (answer: WebHandoffAnswer) => answer.url.split("#t=")[1]!;
    const redeem = (token: string, headers: Record<string, string> = same(), extra: Record<string, unknown> = { confirm: true }) => call("/v1/auth/handoff", { token, ...extra }, headers);
    const sessionCookie = (response: Response) => response.headers.getSetCookie().find(item => item.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];

    it("issues only to a live app session, with the token in the fragment, and validates what it is asked for", async () => {
      expect((await call("/v1/app/web-handoff", plans)).status).toBe(401);
      const grant = await appLogin();
      time += 30_000;
      const browser = await login();
      expect((await call("/v1/app/web-handoff", plans, browserHeaders(browser))).status).toBe(401);
      for (const bad of [{}, { next: "admin" }, { next: "account", plan: "pro" }, { next: "cloud", workspaceId: "ws_abc" }, { next: "workspace" }, { next: "workspace", workspaceId: "../x" },
        { ...plans, plan: "team" }, { ...plans, source: "other" }, { ...plans, source: "https://evil.test" }, { ...plans, next: "//evil.test" }, { next: "toString" }]) {
        expect((await issue(grant, bad)).status).toBe(400);
      }
      const answer = await body<WebHandoffAnswer>(issue(grant));
      expect(answer).toEqual({ v: 1, url: expect.stringMatching(new RegExp(`^${options.publicUrl}/handoff#t=[A-Za-z0-9_-]{43}$`)), expiresAt: time + HANDOFF_TTL_MS });
      expect(new URL(answer.url).search).toBe("");
    });

    it("signs a fresh browser in once, to a server-built page, no fresher than the app sign-in behind it", async () => {
      const grant = await appLogin();
      const appSignedInAt = time;
      time += 60_000;
      const token = tokenOf(await body<WebHandoffAnswer>(issue(grant)));
      const response = await redeem(token, same(), { confirm: true, next: "https://evil.test/" });
      expect(response.status).toBe(200);
      const answer = await body<HandoffAnswer>(response);
      expect(answer).toMatchObject({ account: { email }, csrfToken: expect.any(String), next: "/billing?plan=pro&src=app_computer_move" });
      const cookie = sessionCookie(response)!;
      expect(await body(call("/v1/me", undefined, { cookie }))).toMatchObject({ account: { email } });
      const { sessions, onboarded } = await body<AccountAnswer>(call("/v1/account", undefined, { cookie }));
      expect(sessions.find(item => item.current)).toMatchObject({ kind: "web", createdAt: appSignedInAt });
      // its first run was in the app: the website does not walk it through another
      expect(onboarded).toBe(true);
      expect((await redeem(token)).status).toBe(410);
      const plain = tokenOf(await body<WebHandoffAnswer>(issue(grant, { next: "plans" })));
      expect(await body(redeem(plain))).toMatchObject({ next: "/billing" });
      for (const [input, next] of [[{ next: "cloud" }, "/cloud"], [{ next: "account" }, "/account"], [{ next: "home" }, "/"], [{ next: "workspace", workspaceId: "ws_abc-1" }, "/?workspace=ws_abc-1"]] as const) {
        expect(await body(redeem(tokenOf(await body<WebHandoffAnswer>(issue(grant, input)))))).toMatchObject({ next });
      }
    });

    it("never signs a signed-out browser in without its confirm, and the ask does not spend the link", async () => {
      const grant = await appLogin();
      const token = tokenOf(await body<WebHandoffAnswer>(issue(grant)));
      for (let i = 0; i < 2; i++) {
        const asked = await redeem(token, same(), {});
        expect(asked.status).toBe(409);
        expect(await body(asked)).toMatchObject({ code: "confirm", email });
        expect(asked.headers.getSetCookie()).toEqual([]);
      }
      expect((await redeem(token, same(), { confirm: "yes" })).status).toBe(400);
      const confirmed = await redeem(token);
      expect(confirmed.status).toBe(200);
      expect(sessionCookie(confirmed)).toBeDefined();
      expect((await redeem(token)).status).toBe(410);
      expect((await redeem(token, same(), {})).status).toBe(410);
    });

    it("ends the handoff web session with its app session, by every way that session goes", async () => {
      const handoffBrowser = async (grant: AppGrant) => {
        const response = await redeem(tokenOf(await body<WebHandoffAnswer>(issue(grant))));
        expect(response.status).toBe(200);
        return { cookie: sessionCookie(response)!, csrf: (await body<HandoffAnswer>(response)).csrfToken };
      };
      const alive = async (cookie: string) => (await call("/v1/me", undefined, { cookie })).status;
      const appSessionId = async (grant: AppGrant) => (await body<{ device: { id: string } }>(call("/api/cloud/desktop/session", undefined, bearer(grant)))).device.id;

      let grant = await appLogin();
      let child = await handoffBrowser(grant);
      expect(await alive(child.cookie)).toBe(200);
      const listed = await body<AccountAnswer>(call("/v1/account", undefined, { cookie: child.cookie }));
      expect(JSON.stringify(listed)).not.toContain("parentId");
      expect(JSON.stringify(app.auth.exportAccount(app.auth.directory().accounts[0]!))).not.toContain("parentId");
      expect((await call("/api/cloud/desktop/session", {}, bearer(grant), "DELETE")).status).toBe(200);
      expect(await alive(child.cookie)).toBe(401);

      time += 30_000; grant = await appLogin();
      child = await handoffBrowser(grant);
      const id = await appSessionId(grant);
      expect((await call(`/v1/account/sessions/${encodeURIComponent(id)}`, {}, { ...same(), cookie: child.cookie, [CSRF_HEADER]: child.csrf }, "DELETE")).status).toBe(200);
      expect(await alive(child.cookie)).toBe(401);

      time += 30_000; grant = await appLogin();
      child = await handoffBrowser(grant);
      const parent = app.auth.directory().sessions.find(item => item.kind !== "web" && item.accountId === app.auth.directory().accounts[0]!.id)!;
      (parent as { expiresAt: number }).expiresAt = time - 1;
      expect(await alive(child.cookie)).toBe(401);
      expect(app.auth.directory().sessions.some(item => item.kind === "web")).toBe(false);

      time += 30_000; grant = await appLogin();
      child = await handoffBrowser(grant);
      time += 30_000;
      const other = await login();
      expect((await call("/v1/account/signout-everywhere", {}, { ...same(), ...browserHeaders(other) })).status).toBe(200);
      expect(await alive(child.cookie)).toBe(401);
    });

    it("refuses a missing or foreign Origin and a cross-site fetch without using the link up", async () => {
      const grant = await appLogin();
      const token = tokenOf(await body<WebHandoffAnswer>(issue(grant)));
      expect((await redeem(token, {})).status).toBe(403);
      expect((await redeem(token, { origin: "https://evil.test" })).status).toBe(403);
      expect((await redeem(token, { origin: "null" })).status).toBe(403);
      expect((await redeem(token, { ...same(), "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await redeem(token, { ...same(), "sec-fetch-site": "same-origin" })).status).toBe(200);
    });

    it("expires after its TTL and dies with the app session that asked for it", async () => {
      const grant = await appLogin();
      const late = tokenOf(await body<WebHandoffAnswer>(issue(grant)));
      time += HANDOFF_TTL_MS;
      expect(await body(redeem(late))).toMatchObject({ code: "expired" });
      const revoked = tokenOf(await body<WebHandoffAnswer>(issue(grant)));
      expect((await call("/api/cloud/desktop/session", {}, bearer(grant), "DELETE")).status).toBe(200);
      expect((await redeem(revoked)).status).toBe(410);
      expect((await redeem("x".repeat(43))).status).toBe(410);
      expect((await redeem("not a token")).status).toBe(410);
    });

    it("keeps enroll and handoff tokens apart", async () => {
      const grant = await appLogin();
      const enroll = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(grant)));
      expect((await redeem(enroll.enrollToken)).status).toBe(410);
      expect(app.auth.consumeEnrollGrant(enroll.enrollToken)).toBe(app.auth.directory().accounts[0]!.id);
      const token = tokenOf(await body<WebHandoffAnswer>(issue(grant)));
      expect(app.auth.consumeEnrollGrant(token)).toBeNull();
      expect((await redeem(token)).status).toBe(200);
    });

    it("asks before switching a browser signed in to another account, then switches on replace", async () => {
      const grant = await appLogin();
      time += 30_000;
      const other = await login("other@example.test");
      const token = tokenOf(await body<WebHandoffAnswer>(issue(grant)));
      const headers = { ...same(), cookie: other.cookie };
      const asked = await redeem(token, headers);
      expect(asked.status).toBe(409);
      expect(await body(asked)).toMatchObject({ code: "other_account", email });
      expect(asked.headers.getSetCookie()).toEqual([]);
      expect(await body(call("/v1/me", undefined, { cookie: other.cookie }))).toMatchObject({ account: { email: "other@example.test" } });
      expect((await redeem(token, headers, { replace: "yes" })).status).toBe(400);
      const switched = await redeem(token, headers, { replace: true });
      expect(switched.status).toBe(200);
      expect(await body(switched)).toMatchObject({ account: { email } });
      expect((await call("/v1/me", undefined, { cookie: other.cookie })).status).toBe(401);
      expect((await redeem(token, headers, { replace: true })).status).toBe(410);
    });

    it("uses the link up without a new session when the browser is already that account", async () => {
      const grant = await appLogin();
      time += 30_000;
      const browser = await login();
      const response = await redeem(tokenOf(await body<WebHandoffAnswer>(issue(grant))), { ...same(), cookie: browser.cookie }, {});
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await body(response)).toMatchObject({ csrfToken: browser.csrfToken, next: "/billing?plan=pro&src=app_computer_move" });
      expect((await body<AccountAnswer>(call("/v1/account", undefined, { cookie: browser.cookie }))).sessions.filter(item => item.kind === "web")).toHaveLength(1);
    });

    it("works end to end with the desktop client under a page base", async () => {
      restart({ publicUrl: url, pageBase: "/dashboard" });
      let saved: unknown = null;
      const opened: string[] = [];
      const client = createCloudAccountClient({ origin: url, fixture: true, ...device, now: () => time,
        store: { async read() { return saved; }, async write(value: unknown) { saved = value; } },
        async openBrowser(target: string) { opened.push(target); }, setTimer: () => 1, clearTimer() {} });
      try {
        await client.start();
        expect(await client.webHandoff({ plan: "pro" })).toEqual({ signedOut: true });
        expect(await client.linkGrant()).toBeNull();
        await client.emailStart(email);
        expect((await client.emailVerify(code())).outcome).toBe("signed-in");
        expect(await client.linkGrant()).toMatch(/^l1\./);
        // this service has no TURN key: the screen tries direct, then the link relay
        expect(await client.screenIce()).toBeNull();
        expect(await client.webHandoff({ plan: "plus", source: "app_card" })).toEqual({ opened: true });
        expect(opened.at(-1)).toMatch(new RegExp(`^${url}/dashboard/handoff#t=[A-Za-z0-9_-]{43}$`));
        expect(await body(redeem(opened.at(-1)!.split("#t=")[1]!, { origin: url }))).toMatchObject({ account: { email }, next: "/billing?plan=plus&src=app_card" });
      } finally { client.close(); }
    });

    it("limits issuing per app session, keeps a few links per account and drops them with the account", async () => {
      const grant = await appLogin();
      const tokens: string[] = [];
      for (let i = 0; i < AUTH_LIMITS.handoffsPerSession; i++) tokens.push(tokenOf(await body<WebHandoffAnswer>(issue(grant))));
      expect((await issue(grant)).status).toBe(429);
      const kept = tokens.slice(-HANDOFF_OUTSTANDING);
      expect((await redeem(tokens.at(-HANDOFF_OUTSTANDING - 1)!)).status).toBe(410);
      const response = await redeem(kept[0]!);
      expect(response.status).toBe(200);
      const cookie = sessionCookie(response)!, csrf = (await body<HandoffAnswer>(response)).csrfToken;
      expect((await call("/v1/account/delete", { email }, { ...same(), cookie, [CSRF_HEADER]: csrf })).status).toBe(200);
      expect((await redeem(kept[1]!)).status).toBe(410);
    });
  });

  it("reuses a legacy account id and clears old proxy sessions", async () => {
    app.close();
    const path = `${dataDir}/state.json`;
    writeFileSync(path, JSON.stringify({ accounts: [{ id: "legacy_account", email }], sessions: [{ hash: "old", accountId: "legacy_account", expiresAt: time + day }], workspaces: [] }));
    app = createDashboardApp(options); server.removeAllListeners("request"); server.on("request", app.handle);
    const browser = await login();
    expect(browser.account.id).toBe("legacy_account");
    app.close(); expect(JSON.parse(readFileSync(path, "utf8")).sessions).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).accounts).toEqual([{ id: "legacy_account", email }]);
  });

  it("advertises an empty provider registry, with coming soon only in development", async () => {
    expect(await body(call("/v1/auth/providers"))).toEqual({ v: 1, signupOpen: true, recovery: true, providers: ["google", "apple"].map(id => ({ id, enabled: false, comingSoon: true })) });
    restart({ dev: false });
    expect(await body(call("/v1/auth/providers"))).toEqual({ v: 1, signupOpen: true, recovery: true, providers: ["google", "apple"].map(id => ({ id, enabled: false, comingSoon: false })) });
  });

  it("works with the desktop client's email flow, browser flow, identity parser and revoke", async () => {
    restart({ publicUrl: url });
    const browser = await login(); time += 30_000;
    let saved: unknown = null, tick: (() => void) | undefined;
    const opened: string[] = [];
    const settings = { origin: url, fixture: true, ...device, now: () => time,
      store: { async read() { return saved; }, async write(value: unknown) { saved = value; } },
      async openBrowser(target: string) { opened.push(target); },
      setTimer(callback: () => void) { tick = callback; return 1; }, clearTimer() { tick = undefined; } };
    const client = createCloudAccountClient(settings);
    try {
      expect((await client.start()).status).toBe("signed-out");
      expect((await client.emailStart(email)).outcome).toBe("sent");
      expect((await client.emailVerify(code() === "00000000" ? "11111111" : "00000000")).outcome).toBe("wrong-code");
      expect((await client.emailVerify(code())).outcome).toBe("signed-in");
      expect(client.state()).toMatchObject({ status: "connected", account: { id: browser.account.id, email }, entitlement: { plan: "free", status: "inactive" } });
      const token = (saved as { token: string }).token;
      expect((await client.signOut()).status).toBe("signed-out");
      expect((await call("/api/cloud/desktop/session", undefined, { authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await client.begin()).status).toBe("connecting");
      expect(opened[0]).toBe(`${url}/cloud/desktop?code=${client.state().enrollment!.userCode}`);
      await call("/v1/auth/device/approve", { userCode: client.state().enrollment!.userCode }, browserHeaders(browser));
      time += 5000; tick!();
      await vi.waitFor(() => expect(client.state().status).toBe("connected"));
      expect((await client.signOut()).status).toBe("signed-out");
    } finally { client.close(); }
  });

  it("fails mail delivery generically without exposing mailer errors", async () => {
    restart({ mailer: { async send() { throw new Error("private provider details"); } } });
    const response = await call("/v1/auth/start", { email });
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "Request failed.", code: "failed" });
  });
});
