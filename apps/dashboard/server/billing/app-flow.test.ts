import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCloudAccountClient } from "../../../../electron/cloud-account.mjs";
import { parseCloudOffer, parseCloudSummary, parsePairingGrant, parsePublicOffer } from "../../../../electron/cloud-home.mjs";
import { otherOwnClouds, parseCloudList, parseCloudRenewal } from "../../../../electron/cloud-list.mjs";
import { oneHomeCloud } from "../../../../electron/one-home-main.mjs";
import { createBilling } from "./index.ts";
import { CHECKOUT_BURST } from "./service.ts";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import { signedPayload } from "../../../../shared/dashboard-protocol.ts";
import { BILLING_CONFIG } from "./plans.ts";
import type { AccountRef } from "./types.ts";
import type { BillingState } from "./store.ts";
import type { CloudDesktopView } from "../../../../shared/billing-api.ts";

vi.mock("./index.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./index.ts")>();
  return { ...actual, createBilling: vi.fn(actual.createBilling) };
});
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  for (const key of ["DUSK_BILLING_PROVIDER", "DUSK_CLOUD_PROVIDER", "DUSK_POOL_DRIVER", "DUSK_CLOUD_SEAL_KEY", "DUSK_DODO_PRODUCTS"]) vi.stubEnv(key, undefined);
  const dir = mkdtempSync(join(tmpdir(), "dusk-billing-app-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let time = Date.now();
  const now = () => time, mailer = memoryMailer();
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture address.");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const app = createDashboardApp({ dataDir: dir, publicUrl: origin, mailer, staticDir: null, now });
  cleanup.push(() => app.close());
  server.on("request", app.handle);
  const billing = vi.mocked(createBilling).mock.results.at(-1)!.value as ReturnType<typeof createBilling>;
  const dashboard = vi.mocked(createBilling).mock.calls.at(-1)![0].dashboard;
  const browsers: string[] = [];
  function desktop() {
    let saved: unknown = null;
    const timers = { setTimer: () => 1, clearTimer: () => {} };
    const client = createCloudAccountClient({ origin, fixture: true, platform: "darwin", deviceName: "Fixture Mac", appVersion: "0.1.fixture", now,
      store: { read: async () => saved, write: async value => { saved = value; } }, openBrowser: async url => { browsers.push(url); },
      ...timers });
    cleanup.push(() => client.close());
    return { client, credential: () => saved as { token: string; account: AccountRef } };
  }
  const main = desktop(), client = main.client;
  const snapshot = () => JSON.parse(readFileSync(join(dir, "billing.json"), "utf8")) as BillingState;
  async function request(path: string, data?: unknown, token = main.credential()?.token, method = data === undefined ? "GET" : "POST") {
    const response = await fetch(`${origin}${path.startsWith("/") ? path : `/api/cloud/desktop/${path}`}`, { method,
      headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  async function signIn(email = "owner@example.test") {
    const device = email === "owner@example.test" ? main : desktop();
    expect((await device.client.emailStart(email)).outcome).toBe("sent");
    const code = mailer.outbox.findLast(item => item.to === email && /\b\d{8}\b/.test(item.text))?.text.match(/\b\d{8}\b/)?.[0];
    expect(code).toMatch(/^\d{8}$/);
    expect((await device.client.emailVerify(code!)).outcome).toBe("signed-in");
    return device.credential();
  }
  async function session() {
    const result = await request("session"); expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ cloudContractVersion: 1, account: main.credential().account, device: { id: expect.any(String) }, expiresAt: expect.any(Number) });
    return result.data;
  }
  async function complete(index = 0) {
    const checkout = snapshot().checkouts[index], deliveries = billing.fake!.complete(checkout.providerSessionId!);
    for (const delivery of deliveries) {
      const response = await fetch(`${origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...delivery.headers }, body: new Uint8Array(delivery.body) });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    }
    return checkout;
  }
  async function reconcile() { for (let n = 0; n < 8; n++) await billing.clouds.reconcile(); }
  return { dir, mailer, dashboard, billing, client, origin, browsers, signIn, session, request, complete, reconcile, snapshot, now, setTime: (at: number) => { time = at; }, owner: () => main.credential().account, token: () => main.credential().token };
}

it("keeps the app identity available without exposing failed or disabled billing", async () => {
  const f = await fixture(); await f.signIn();
  const before = await f.session();
  const fields = vi.spyOn(f.billing, "sessionFields").mockImplementation(() => { throw { status: 409, code: "private-provider-detail" }; });
  const expected = { cloudContractVersion: 1, account: before.account, device: before.device, expiresAt: before.expiresAt, handoffUrl: `${f.origin}/handoff`,
    entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } };
  expect(await f.request("session")).toEqual({ status: 200, data: expected });
  expect(fields).toHaveBeenCalledOnce();
  fields.mockClear(); f.billing.appRoutes = false;
  expect(await f.request("session")).toEqual({ status: 200, data: expected });
  expect(fields).not.toHaveBeenCalled();
});

it("rejects expired app sessions on every Admin billing route", async () => {
  const f = await fixture(); await f.signIn();
  const session = await f.session(), token = f.token();
  f.setTime(Number(session.expiresAt));
  for (const [path, method] of [
    ["license", "GET"], ["checkout", "POST"], ["clouds", "POST"], ["clouds/missing", "PATCH"],
    ...["hide", "cancel", "keep"].map(action => [`clouds/missing/${action}`, "POST"]),
    ...["feedback", "upgrade", "upgrade/preview", "pairing", "wake", "resize-now", "moved-to", "backup"].map(path => [path, "POST"]),
  ]) {
    expect(await f.request(path, method === "GET" ? undefined : {}, token, method), path).toEqual({ status: 401, data: { error: "invalid_token" } });
  }
});

it("runs the real desktop client through checkout, setup, pairing, upgrade, another Cloud and Cancel/Keep", async () => {
  const f = await fixture(); await f.client.start(); await f.signIn();
  expect(f.client.state()).toMatchObject({ status: "connected", entitlement: { plan: "free", status: "inactive" }, offer: { plans: [{ tier: "starter" }, { tier: "pro" }, { tier: "team" }] } });
  const publicConfig = await f.request("/api/public/config");
  expect(parsePublicOffer(publicConfig.data)?.plans.map(p => p.tier)).toEqual(["starter", "pro", "team"]);
  expect(parsePublicOffer(publicConfig.data)?.plans.map(p => [p.tier, p.allowances?.sleeps, p.allowances?.seats, p.allowances?.includedSeats, p.allowances?.extraSeatCents]),
    "Plus wakes in seconds, Pro and Team wake first; Team's seats are its license's").toEqual([["starter", true, undefined, undefined, undefined], ["pro", undefined, undefined, undefined, undefined],
    ["team", undefined, BILLING_CONFIG.licenses.team.maxMembers, BILLING_CONFIG.licenses.team.includedMembers, BILLING_CONFIG.licenses.team.extraMemberCents]]);
  expect(parseCloudOffer((await f.session()).offer)?.recommended).toBe("pro");
  expect((await f.session()).license).toMatchObject({ v: 1, license: null, checkedAt: f.now() });
  const authorize = await f.request("authorize", { deviceName: "Another Mac", platform: "darwin" }, "");
  expect(authorize).toMatchObject({ status: 200, data: { cloudContractVersion: 1, deviceCode: expect.any(String), userCode: expect.stringMatching(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/), verificationUri: `${f.origin}/cloud/desktop`, expiresIn: 900, interval: 5 } });
  expect(await f.request("token", { deviceCode: authorize.data.deviceCode }, "")).toMatchObject({ status: 400, data: { error: "authorization_pending" } });
  expect((await f.client.checkout("starter", "app_card")).outcome).toBe("opened");
  expect(f.browsers[0]).toMatch(/^https:\/\/test.checkout.dodopayments.com\//);
  let fields = await f.session();
  expect(fields).toMatchObject({ canAdd: true, offer: { checkout: { plan: "starter" } } }); expect(fields.addBlocked).toBeUndefined();
  const checkout = await f.complete();
  await f.client.refresh();
  expect(f.client.state()).toMatchObject({ status: "connected", entitlement: { plan: "pro", tier: "starter", status: "active" }, machine: { status: "provisioning" } });
  // a cloud still setting up takes no move yet
  expect(oneHomeCloud(f.client.state())).toMatchObject({ ready: false, moves: false });
  await f.reconcile(); await f.client.refresh();
  expect(f.client.state()).toMatchObject({ machine: { status: "ready", origin: expect.stringMatching(/^https:\/\//) }, clouds: [{ id: checkout.cloudId, primary: true }] });
  // once ready, the app's move (this computer's, or a server's bought from its page) starts by itself
  expect(oneHomeCloud(f.client.state())).toMatchObject({ ready: true, moves: true, origin: f.client.state().machine?.origin });
  fields = await f.session();
  expect(parseCloudSummary(fields.cloud)).toMatchObject({ status: "ready", disk: { gb: 20, maxGb: 20 } });
  expect(parseCloudList(fields.clouds)).toHaveLength(1); expect(parseCloudRenewal(fields.clouds)).toMatchObject({ cancelled: false, trial: false, keptDays: 30 });
  expect(fields.offer).toBeUndefined();
  expect(fields.license).toMatchObject({ work: f.now() < BILLING_CONFIG.freeWorkUntil! ? "free_until" : "unlicensed", license: null });
  const cloud = f.billing.clouds.get(checkout.cloudId!)!;
  expect(f.dashboard.state.workspaces).toHaveLength(1);
  expect(f.dashboard.state.workspaces[0]).toMatchObject({ id: cloud.workspaceId, ownerAccountId: f.owner().id, claimHash: null });
  expect(JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8")).workspaces[0]).toMatchObject({ id: cloud.workspaceId, ownerAccountId: f.owner().id });
  const call = f.billing.fakePool!.calls.find(c => c.method === "createSlot")!;
  const bootstrap = JSON.parse((call.input as { bootstrap: string }).bootstrap) as { files: Array<{ path: string; content: string; mode: number }> };
  const link = JSON.parse(bootstrap.files[0].content) as { workspaceId: string; privateKey: string };
  expect(link.workspaceId).toBe(cloud.workspaceId); expect(bootstrap.files[0].mode).toBe(0o600);
  const raw = JSON.stringify({ v: 1, seq: 1, at: f.now(), workspace: { name: "Paid fixture", kind: "vps", version: "1.0.0", platform: "linux" } });
  const signature = sign(null, Buffer.from(signedPayload("POST", "/v1/report", f.now(), createHash("sha256").update(raw).digest("hex"))), createPrivateKey({ key: Buffer.from(link.privateKey, "base64"), format: "der", type: "pkcs8" })).toString("base64");
  const report = await fetch(`${f.origin}/v1/report`, { method: "POST", headers: { "content-type": "application/json", "x-dusk-workspace": link.workspaceId, "x-dusk-time": String(f.now()), "x-dusk-signature": signature }, body: raw });
  expect(report.status).toBe(200); expect(await report.json()).toMatchObject({ v: 1, commands: [] });
  expect(f.dashboard.state.workspaces[0].lastReportAt).toBe(f.now());
  expect(f.billing.clouds.view(cloud).lastReportAt).toBe(f.now());
  expect(fields.cloud).not.toHaveProperty("power");
  const grant = await f.client.pairHome(); expect(parsePairingGrant({ ...grant, cloudContractVersion: 1 }, grant.origin, f.now())).toEqual(grant);
  expect((await f.client.pairHome()).code).not.toBe(grant.code);
  expect(await f.client.upgradePreview("pro", "app_usage")).toMatchObject({ outcome: "preview", preview: { plan: "pro", from: "starter", price: 5000, tax: 0, trial: false } });
  expect(await f.client.upgrade("pro", "app_usage")).toEqual({ outcome: "upgraded", tier: "pro" });
  expect(await f.client.restartNow()).toBe("current");
  await f.reconcile(); expect(f.billing.clouds.get(checkout.cloudId!)!.spec).toEqual(BILLING_CONFIG.desktops.shared_m.machine);
  expect(f.billing.fakePool!.calls.find(c => c.method === "setQuota")?.input).toMatchObject({ ...BILLING_CONFIG.desktops.shared_m.machine, botComputers: 5, netMbps: 250 });
  expect((await f.client.addCloud({ tier: "pro", interval: "month", name: "Client B", color: "green" })).outcome).toBe("opened");
  expect(f.snapshot().checkouts[1].cart).toMatchObject({ license: { kind: "none" }, desktop: { kind: "shared_m" } });
  expect(f.snapshot().checkouts[1].amountCents).toBe(BILLING_CONFIG.desktops.shared_m.monthlyCents);
  await f.client.refresh();
  fields = await f.session();
  // an unpaid checkout lists nothing: the cloud only shows once paid
  expect(parseCloudList(fields.clouds)).toHaveLength(1); expect(otherOwnClouds(parseCloudList(fields.clouds))).toEqual([]);
  const cancelled = await f.client.cancelPlan({ answer: "price", improve: "cheaper" });
  expect(cancelled).toMatchObject({ outcome: "cancelled", renewal: { cancelled: true, trial: false, keptDays: 30 }, surveyed: true });
  expect(f.snapshot().feedback[0]).toMatchObject({ cloudId: checkout.cloudId, answer: "price", improve: "cheaper" });
  expect(await f.client.keepPlan()).toMatchObject({ outcome: "kept" });
  expect(f.snapshot().subscriptions[0].cancelAtPeriodEnd).toBe(false);
  const subjects = f.mailer.outbox.filter(mail => mail.to === "owner@example.test" && !/code/.test(mail.subject)).map(mail => mail.subject);
  expect(subjects.slice(0, 3)).toEqual(["welcome to Metal", expect.stringMatching(/^receipt for \$\d+\.\d\d: /), "your dusk cloud is ready"]);
  expect(subjects.filter(subject => subject === "your dusk cloud is ready")).toHaveLength(1);
  expect(subjects.filter(subject => subject.endsWith("plan is cancelled"))).toHaveLength(1);
  for (const mail of f.mailer.outbox) expect(mail.html).toContain("class=\"kit\"");
  const token = f.token();
  expect(await f.request("session", {}, token, "DELETE")).toEqual({ status: 200, data: { ok: true } });
  for (const [path, data] of [["license", undefined], ["checkout", { plan: "starter", source: "app_card" }]] as const) {
    expect(await f.request(path, data, token)).toEqual({ status: 401, data: { error: "invalid_token" } });
  }
  expect(await f.request("session", undefined, token)).toMatchObject({ status: 401, data: { error: "invalid_token" } });
  expect((await f.client.refresh()).status).toBe("reauth-required");
});

it("takes a handoff token the app made, once, and names the handoff page in the session", async () => {
  const f = await fixture(); await f.signIn();
  expect((await f.session()).handoffUrl).toBe(`${f.origin}/handoff`);
  const token = "A".repeat(43);
  expect(await f.request("/v1/app/web-handoff", { next: "cloud", token })).toMatchObject({ status: 200, data: { v: 1, url: `${f.origin}/handoff#t=${token}` } });
  expect((await f.request("/v1/app/web-handoff", { next: "cloud", token })).status).toBe(400);
  expect((await f.request("/v1/app/web-handoff", { next: "cloud", token: "short" })).status).toBe(400);
});

it("shows nothing for a checkout left unpaid, lets a new one open, and makes the cloud only once that one is paid", async () => {
  const f = await fixture(); await f.client.start(); await f.signIn();
  expect((await f.client.checkout("starter", "app_card")).outcome).toBe("opened");
  const first = f.snapshot().checkouts[0];
  expect(f.billing.clouds.get(first.cloudId!)?.status).toBe("checkout");
  // the person closes the checkout page: no cloud anywhere, nothing setting up
  await f.client.refresh();
  expect(parseCloudList((await f.session()).clouds)).toEqual([]);
  expect(f.client.state().clouds ?? []).toEqual([]);
  expect(f.billing.fakePool?.calls ?? []).toEqual([]);
  // a new checkout always opens once the first minute is over, and retires the old one with its reserved cloud
  f.setTime(f.now() + 61_000);
  expect((await f.client.checkout("starter", "app_card")).outcome).toBe("opened");
  expect(f.snapshot().checkouts[0].status).toBe("expired");
  expect(f.billing.clouds.get(first.cloudId!)?.status).toBe("destroyed");
  expect(parseCloudList((await f.session()).clouds)).toEqual([]);
  // left past its window, the sweep expires it with its pending cloud too
  const second = f.snapshot().checkouts[1];
  f.setTime(f.now() + (BILLING_CONFIG.checkoutOpenMinutes + 1) * 60_000);
  expect(f.billing.service.expireLapsed()).toBe(1);
  expect(f.snapshot().checkouts[1].status).toBe("expired");
  expect(f.billing.clouds.get(second.cloudId!)?.status).toBe("destroyed");
  // a late payment on it still lands: exactly one fresh cloud, setting up
  await f.complete(1);
  const listed = parseCloudList((await f.session()).clouds);
  expect(listed).toMatchObject([{ status: "setting_up" }]);
  expect(listed?.[0]?.id).not.toBe(second.cloudId);
});

it("enforces Admin ownership, one-time confirmations, typed bodies, and the desktop error codes", async () => {
  const f = await fixture(); await f.signIn();
  const refused = async (path: string, data: unknown, status: number, error: string, token?: string) => {
    const result = await f.request(path, data, token); expect(result).toMatchObject({ status, data: { error } }); return result;
  };
  await refused("upgrade/preview", { plan: "pro", source: "app_usage" }, 409, "not_subscribed");
  for (const plan of ["personal", "max"]) await refused("upgrade/preview", { plan }, 409, "plan_change_unavailable");
  for (const data of [{ plan: "free" }, { plan: 1 }, { plan: "starter", source: 2 }]) await refused("checkout", data, 400, "invalid_request");
  const checkout = await f.request("checkout", { plan: "starter", source: "app_card", ignored: true, color: 12 }); expect(checkout.status).toBe(200);
  const twice = await f.request("checkout", { plan: "starter", source: "app_card" }); expect(twice.status).toBe(200); expect(twice.data.url).toBe(checkout.data.url);
  f.setTime(f.now() + 61_000);
  const again = await f.request("checkout", { plan: "starter", source: "app_card" }); expect(again.status).toBe(200); expect(again.data.url).not.toBe(checkout.data.url);
  const purchase = await f.complete(1), id = purchase.cloudId!;
  await refused("checkout", { plan: "pro", source: "app_card" }, 409, "already_subscribed");
  await refused("pairing", { cloudId: id }, 409, "not_running");
  await f.reconcile();
  const { token: stranger, account } = await f.signIn("stranger@example.test");
  expect(account.id).not.toBe(f.owner().id);
  expect(await f.request("session", undefined, stranger)).toMatchObject({ status: 200, data: { account, entitlement: { status: "inactive" }, clouds: [] } });
  for (const [route, data, method] of [[`clouds/${id}`, { color: "green" }, "PATCH"], [`clouds/${id}/hide`, {}, "POST"], [`clouds/${id}/cancel`, {}, "POST"], [`clouds/${id}/keep`, {}, "POST"], ["pairing", { cloudId: id }, "POST"], ["feedback", { cloudId: id, answer: "price" }, "POST"]] as const) {
    expect(await f.request(route, data, stranger, method)).toMatchObject({ status: 404, data: { error: "not_found" } });
  }
  await refused(`clouds/${id}/hide`, {}, 409, "not_removable");
  expect(await f.request(`clouds/${id}`, { color: null }, undefined, "PATCH")).toMatchObject({ status: 200, data: { cloudContractVersion: 1, ok: true } });
  expect(await f.request(`clouds/${id}`, { color: 12 }, undefined, "PATCH")).toMatchObject({ status: 400, data: { error: "invalid_request" } });
  await refused("upgrade/preview", { plan: "starter", source: "app_usage" }, 409, "already_on_plan");
  const preview = await f.request("upgrade/preview", { plan: "pro", source: "app_usage" }); expect(preview.status).toBe(200);
  await refused("upgrade", { plan: "starter", confirmation: preview.data.confirmation, source: "app_usage" }, 409, "confirmation_required");
  expect((await f.request("upgrade", { plan: "pro", confirmation: preview.data.confirmation, source: "app_usage" })).status).toBe(200);
  await refused("upgrade", { plan: "pro", confirmation: preview.data.confirmation, source: "app_usage" }, 409, "confirmation_required");
  const cloud = f.billing.clouds.get(id)!;
  expect(await f.request("moved-to", { origin: cloud.origin }, stranger)).toMatchObject({ data: { state: "unknown" } });
  expect(await f.request("moved-to", { origin: cloud.origin })).toMatchObject({ data: { state: "live", cloudContractVersion: 1 } });
  // a backup after a move: only of the asker's own Cloud, and only one the managed backend backs up
  expect(await f.request("backup", { origin: cloud.origin }, stranger)).toMatchObject({ status: 404, data: { error: "not_found" } });
  expect(await f.request("backup", { origin: cloud.origin })).toMatchObject({ status: 200, data: { state: "not_managed", cloudContractVersion: 1 } });
  expect(await f.client.requestBackup(cloud.origin!)).toBe("not_managed");
  expect(await f.request("wake", {})).toMatchObject({ data: { state: "awake", cloudContractVersion: 1 } });
  // only real intent wakes a sleeping desktop: opening the app or viewing chats leaves it asleep
  await f.billing.clouds.power(cloud.accountId, id, "off");
  expect(cloud.status).toBe("stopped");
  expect(await f.request("wake", { intent: "open" })).toMatchObject({ data: { state: "asleep", wakesOn: "intent" } });
  expect(await f.request("wake", { intent: "view" })).toMatchObject({ data: { state: "asleep" } });
  expect(cloud.status).toBe("stopped");
  expect((await f.request("wake", { intent: "send" })).data.state).toMatch(/^(?:awake|waking)$/);
  await f.reconcile();
  expect(cloud.status).toBe("running");
  expect(await f.request("resize-now", {})).toMatchObject({ data: { state: "current", cloudContractVersion: 1 } });
  expect(await f.request("license")).toMatchObject({ data: { v: 1, cloudContractVersion: 1, work: "licensed" } });
  const view = f.billing.clouds.view(cloud) as CloudDesktopView; expect(view.machine).toEqual(BILLING_CONFIG.desktops.shared_m.machine);
  const previousOrigin = cloud.origin;
  f.billing.clouds.end(id, f.now()); await f.reconcile();
  expect(await f.request("moved-to", { origin: previousOrigin })).toMatchObject({ data: { state: "deleted" } });
  expect(await f.request(`clouds/${id}/hide`, {})).toMatchObject({ status: 200, data: { cloudContractVersion: 1, ok: true } });
  expect(parseCloudList((await f.session()).clouds)).toHaveLength(0);
});

it("reports Add a Cloud cap and rate blocks in the desktop shape", async () => {
  const f = await fixture(); await f.signIn();
  const plan = BILLING_CONFIG.desktops.shared_s;
  for (let n = 0; n < BILLING_CONFIG.maxCloudsPerAccount; n++) f.billing.clouds.order({ accountId: f.owner().id, name: `Cloud ${n}`, color: null, region: "fsn1", kind: plan.kind, placement: plan.placement, spec: plan.machine, botComputers: plan.botComputers });
  expect(await f.request("clouds", { tier: "pro", interval: "month", name: "One too many" })).toMatchObject({ status: 409, data: { error: "cap", addBlocked: "cap" } });
  expect(await f.session()).toMatchObject({ canAdd: false, addBlocked: "cap" });
  // checkouts the provider refused still count toward the burst limit
  const refused = vi.spyOn(f.billing.fake!, "createCheckout").mockRejectedValue(new Error("down"));
  for (let n = 0; n < CHECKOUT_BURST.count; n++) await expect(f.billing.service.checkout(f.owner(), { kind: "cart", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } } })).rejects.toMatchObject({ code: "unavailable" });
  refused.mockRestore();
  expect(await f.request("clouds", { tier: "pro", interval: "month", name: "Rate limited" })).toMatchObject({ status: 429, data: { error: "rate_limited", addBlocked: "rate" } });
});

it("refuses an older desktop's Start fresh account delete, so a local reset never ends a plan or trial", async () => {
  const f = await fixture(); await f.client.start(); await f.signIn();
  expect((await f.client.checkout("starter", "app_card")).outcome).toBe("opened");
  const checkout = await f.complete();
  await f.reconcile(); await f.client.refresh();
  const owner = f.owner(), cloudId = checkout.cloudId!;

  // someone else signed in on another computer can't cancel this cloud's plan or delete this account, even by its email
  const { token: stranger } = await f.signIn("stranger@example.test");
  expect(await f.request(`clouds/${cloudId}/cancel`, {}, stranger)).toMatchObject({ status: 404 });
  expect((await f.request("/v1/app/delete-account", { email: owner.email }, stranger)).status).toBe(400);

  // what an older desktop's Start fresh sent: refused, the account, its plan and its cloud all stay
  const token = f.token();
  expect(await f.request("/v1/app/delete-account", { email: owner.email, destroyDesktopsNow: true }, token)).toMatchObject({ status: 409, data: { code: "delete_on_account_page" } });
  expect(await f.request("/v1/app/delete-account", { email: owner.email, destroyDesktopsNow: false }, token)).toMatchObject({ status: 409 });
  expect((await f.session()).account).toMatchObject({ id: owner.id });
  expect(f.billing.fake!.cancelCalls).toEqual([]);
  expect(f.billing.clouds.get(cloudId)).not.toMatchObject({ ended: true });
});

it("offers no trial without DUSK_TRIAL_DAYS", async () => {
  const f = await fixture(); await f.signIn();
  const publicConfig = await f.request("/api/public/config");
  expect((publicConfig.data.plans as Array<Record<string, unknown>>).some(plan => "trialDays" in plan)).toBe(false);
  expect(parseCloudOffer((await f.session()).offer)?.plans.some(plan => plan.trialDays)).toBe(false);
  expect((await f.request("/v1/billing/catalog")).data.trialDays).toBeUndefined();
  expect((await f.client.checkout("starter", "app_card")).outcome).toBe("opened");
  expect(f.snapshot().checkouts[0].trialDays).toBeUndefined();
});

it("with DUSK_TRIAL_DAYS a first plan starts free, runs its cloud through the trial, and the trial is used once", async () => {
  vi.stubEnv("DUSK_TRIAL_DAYS", "3");
  const f = await fixture(); await f.client.start(); await f.signIn();
  const publicConfig = await f.request("/api/public/config");
  expect(parsePublicOffer(publicConfig.data)?.plans.map(plan => plan.trialDays)).toEqual([3, 3, 3]);
  expect(parseCloudOffer((await f.session()).offer)?.plans.map(plan => plan.trialDays)).toEqual([3, 3, 3]);
  expect((await f.request("/v1/billing/catalog")).data.trialDays).toBe(3);
  expect((await f.client.checkout("starter", "app_card")).outcome).toBe("opened");
  expect(f.snapshot().checkouts[0].trialDays).toBe(3);
  expect(f.billing.fake!.sessions.get(f.snapshot().checkouts[0].providerSessionId!)?.trialDays).toBe(3);
  const checkout = await f.complete();
  const sub = f.snapshot().subscriptions[0];
  expect(sub).toMatchObject({ status: "active", trialEndsAt: f.now() + 3 * 86_400_000, currentPeriodEnd: f.now() + 3 * 86_400_000, currentPeriodStart: f.now() });
  expect(f.snapshot().invoices[0]).toMatchObject({ amountCents: 0, status: "paid" });
  expect(f.mailer.outbox.some(mail => /receipt/i.test(mail.subject ?? ""))).toBe(false);
  await f.reconcile(); await f.client.refresh();
  expect(f.client.state()).toMatchObject({ entitlement: { plan: "pro", tier: "starter", status: "active" }, machine: { status: "ready" } });
  const fields = await f.session();
  expect(parseCloudRenewal(fields.clouds)).toMatchObject({ trial: true, cancelled: false, renewsAt: sub.trialEndsAt });
  expect(fields.offer).toBeUndefined();
  // the same account never gets a second trial, and the trial's state survives the billing service starting again
  expect(f.billing.service.trialDays({ id: checkout.accountId, email: "owner@example.test" })).toBeNull();
  expect(f.billing.service.trialDays({ id: "someone-else", email: "OWNER@example.test" })).toBeNull();
  expect(f.billing.service.trialDays({ id: "someone-else", email: "new@example.test" })).toBe(3);
});
