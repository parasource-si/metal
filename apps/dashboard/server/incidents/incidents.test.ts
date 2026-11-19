import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import type { Mailer } from "../auth/mail.ts";
import { emailConfig } from "../email/templates.ts";
import { CSRF_HEADER } from "../../../../shared/account-api.ts";
import { fingerprint, maskText, clientText, routeOf, stackFrames, topFrame } from "./fingerprint.ts";
import { createIncidents, RULES } from "./index.ts";
import { memoryIncidentStore, recordUpdate } from "./store.ts";
import { tapConsole } from "./process.ts";
import { ERRORS_PER_HOUR, MAX_ERROR_BYTES } from "./routes.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const OWNER = "siddz.dev@gmail.com";
const stackAt = (line: number, file = "/srv/omb/apps/dashboard/server/billing/routes.ts") => `TypeError: x is undefined\n    at charge (${file}:${line}:9)\n    at node:internal/process/task_queues:95:5`;

function setup(options: { mailers?: Mailer[]; time?: { now: number } } = {}) {
  const time = options.time ?? { now: Date.parse("2026-11-12T12:00:00Z") };
  const mailer = memoryMailer(), store = memoryIncidentStore(), lines: string[] = [];
  const incidents = createIncidents({ env: "production", store, to: () => [OWNER], mailers: options.mailers ?? [mailer], email: emailConfig({}, { publicUrl: "https://dusk.bot" }),
    panelUrl: "https://dusk.bot/admin/health", mail: true, now: () => time.now, timers: false, log: line => lines.push(line) });
  return { time, mailer, store, incidents, lines };
}

describe("incident fingerprints", () => {
  it("keeps one problem one fingerprint across deploys and splits by route and name", () => {
    const at = (stack: string, route = "/v1/billing/checkout", name = "TypeError") => fingerprint({ source: "server", name, message: "whatever", frames: stackFrames(stack), route: routeOf(route) });
    expect(at(stackAt(10))).toBe(at(stackAt(99)));
    expect(at(stackAt(10))).not.toBe(at(stackAt(10), "/v1/billing/portal"));
    expect(at(stackAt(10))).not.toBe(at(stackAt(10), undefined, "RangeError"));
    const bundle = (hash: string) => topFrame(stackFrames(`Error: x\n    at Ab (https://dusk.bot/assets/index-${hash}.js:1:2)`));
    expect(bundle("Bx81kQ2a")).toBe(bundle("Zz09PqLm"));
    expect(topFrame(stackFrames(stackAt(3)))).toBe("charge (apps/dashboard/server/billing/routes.ts)");
  });
  it("normalizes routes and falls back to the line's text without numbers when there is no stack", () => {
    expect(routeOf("/v1/workspaces/ws_8f2kQ9aLm3/commands?x=1")).toBe("/v1/workspaces/:id/commands");
    expect(routeOf("/v1/admin/clouds/c0123456789abcdef01234567/usage")).toBe("/v1/admin/clouds/:id/usage");
    const line = (text: string) => fingerprint({ source: "log", name: "managed alert", message: text, frames: [], route: null });
    expect(line("ALERT cloud c1f2: its setup failed 3 times")).toBe(line("ALERT cloud c9a8: its setup failed 4 times"));
    expect(line("ALERT cloud c1f2: its setup failed 3 times")).not.toBe(line("ALERT cloud c1f2: no backup of it restores"));
  });
});

describe("masking", () => {
  it("masks secrets, codes, query strings, connection strings and email addresses in service text", () => {
    const text = maskText("mail to siddz.dev@gmail.com failed: Bearer abc.def token=s3cr3t xkeysib-0123456789abcdef code 12345678 https://dusk.bot/v1/auth/link?token=zzz mongodb://u:p@db:27017/dusk");
    expect(text).toContain("si***@gmail.com");
    for (const leak of ["siddz.dev", "abc.def", "s3cr3t", "0123456789abcdef", "12345678", "zzz", "u:p@db"]) expect(text).not.toContain(leak);
  });
  it("scrubs client text harder: no quoted words, urls, long ids or addresses", () => {
    const text = clientText(`Cannot read "my secret plan" at https://dusk.bot/x for a@b.co id 9f8e7d6c5b4a39281706f5e4d3c2b1a0`);
    for (const leak of ["my secret plan", "https://dusk.bot", "a@b.co", "9f8e7d6c5b4a39281706f5e4d3c2b1a0"]) expect(text).not.toContain(leak);
  });
});

describe("incident store", () => {
  it("never names one field in two update operators, whatever the caller passes", () => {
    const incident = { id: "a".repeat(20), env: "production", source: "server", name: "Boom", message: "x", route: null, status: null, stack: [], version: null, os: null, path: null,
      requestId: null, lastSeen: 2, count: 5, firstSeen: 1, notifiedAt: 1, mutedUntil: null };
    const update = recordUpdate(incident, 3, 1);
    const paths = [update.$inc, update.$set, update.$setOnInsert].flatMap(part => Object.keys(part));
    expect(new Set(paths).size).toBe(paths.length);
    expect(update.$inc).toEqual({ count: 3 });
  });
});

describe("alert throttling", () => {
  it("mails a new problem once and never again while it is open; repeats only count", async () => {
    const { time, mailer, incidents, store } = setup();
    for (let n = 0; n < 5; n++) incidents.report({ source: "server", name: "TypeError", message: `x is undefined for siddz.dev@gmail.com`, stack: stackAt(10 + n), route: "/v1/billing/checkout", requestId: "req_1234" });
    await incidents.flushNew();
    expect(mailer.outbox).toHaveLength(1);
    const first = mailer.outbox[0]!;
    expect(first.to).toBe(OWNER);
    expect(first.subject).toBe("something's wrong: TypeError on /v1/billing/checkout");
    expect(first.text).toContain("req_1234");
    expect(first.text).toContain("si***@gmail.com");
    expect(first.text).not.toContain("siddz.dev@gmail.com is");
    expect(first.text).toContain("https://dusk.bot/admin/health");
    expect(first.html + first.text).not.toContain("—");

    for (let hour = 0; hour < 6 * 24; hour++) {
      incidents.report({ source: "server", name: "TypeError", message: "x", stack: stackAt(10), route: "/v1/billing/checkout" });
      time.now += HOUR; await incidents.flushNew(); await incidents.tick();
    }
    expect(mailer.outbox).toHaveLength(1);
    const [saved] = await store.list({ limit: 5 });
    expect(saved!.count).toBe(5 + 6 * 24);
    expect(saved!.notifiedAt).not.toBeNull();

    time.now += 8 * 24 * HOUR;
    incidents.report({ source: "server", name: "TypeError", message: "x", stack: stackAt(10), route: "/v1/billing/checkout" });
    await incidents.flushNew();
    expect(mailer.outbox).toHaveLength(2);
  });

  it("sends at most 10 alert emails a day; the rest go in one daily email, skipped when there is nothing", async () => {
    const { time, mailer, incidents } = setup();
    for (let n = 0; n < RULES.mailsPerDay + 5; n++) { incidents.report({ source: "server", name: `Err${n}`, message: "boom", key: `k${n}` }); await incidents.flushNew(); }
    expect(mailer.outbox).toHaveLength(RULES.mailsPerDay);
    time.now = Date.parse("2026-11-13T08:01:00Z"); await incidents.tick(); await incidents.tick();
    const daily = mailer.outbox.slice(RULES.mailsPerDay);
    expect(daily).toHaveLength(1);
    expect(daily[0]!.subject).toBe("5 problems not emailed yet on Metal");
    expect(daily[0]!.text).toContain("more issues than the daily email limit");
    time.now = Date.parse("2026-11-14T08:01:00Z"); await incidents.tick();
    expect(mailer.outbox).toHaveLength(RULES.mailsPerDay + 1);

    const client = setup();
    for (let n = 0; n < 6; n++) {
      client.incidents.report({ source: "web", name: "TypeError", message: "boom", stack: `TypeError: boom\n    at f${n} (https://dusk.bot/assets/a.js:1:1)` });
      await client.incidents.flushNew();
    }
    // page and app errors stay in the admin panel: only the server failing emails, and new problem groups never do
    expect(client.mailer.outbox).toHaveLength(0);
    client.incidents.report({ source: "server", name: "NewProblemGroup", message: "a new kind of frustration", key: "problem-x" });
    await client.incidents.flushNew();
    client.time.now = Date.parse("2026-11-13T08:01:00Z"); await client.incidents.tick();
    expect(client.mailer.outbox).toHaveLength(0);
  });

  it("folds a client flood into one incident", async () => {
    const { mailer, incidents } = setup();
    for (let n = 0; n < RULES.newClientPerHour + 50; n++) incidents.report({ source: "web", name: "TypeError", message: "boom", stack: `TypeError: boom\n    at f${n} (https://dusk.bot/assets/a.js:1:1)` });
    await incidents.flushNew();
    expect(mailer.outbox).toHaveLength(0);
    const listed = await incidents.list({ limit: 200 });
    expect(listed).toHaveLength(RULES.newClientPerHour + 1);
    expect(listed.find(item => item.name === "TooManyClientErrors")!.count).toBe(50);
  });

  it("a save that fails says why, masked, and keeps the counts for the next try", async () => {
    const { incidents, store, lines } = setup();
    const record = store.record;
    store.record = async () => { throw Object.assign(new Error("connection to mongodb://dusk:hunter2@127.0.0.1:27017 timed out"), { name: "MongoNetworkError" }); };
    incidents.report({ source: "server", name: "TypeError", message: "x", stack: stackAt(1) });
    await incidents.flushNew();
    const said = lines.find(line => line.startsWith("incidents could not be saved"));
    expect(said).toMatch(/^incidents could not be saved \(MongoNetworkError: connection to .*timed out\); they are kept/);
    expect(said).not.toMatch(/hunter2/);
    store.record = record;
    await incidents.flushNew();
    await incidents.tick();
    expect([...store.all.values()].map(item => item.count)).toEqual([1]);
  });

  it("does not mail a muted problem, and does not re-mail open problems after a restart", async () => {
    const { time, mailer, incidents, store } = setup();
    const id = incidents.report({ source: "server", name: "Muted", message: "x", key: "m" })!;
    await incidents.mute(id, time.now + HOUR);
    await incidents.flushNew();
    expect(mailer.outbox).toHaveLength(0);
    incidents.report({ source: "server", name: "TypeError", message: "x", stack: stackAt(1) });
    await incidents.flushNew();
    expect(mailer.outbox).toHaveLength(1);
    await incidents.tick();

    const again = createIncidents({ env: "production", store, to: () => [OWNER], mailers: [mailer], email: emailConfig({}, { publicUrl: "https://dusk.bot" }), panelUrl: "x", mail: true, now: () => time.now, timers: false });
    await again.load();
    time.now += 2 * 24 * HOUR;
    again.report({ source: "server", name: "TypeError", message: "x", stack: stackAt(1) });
    await again.flushNew();
    expect(mailer.outbox).toHaveLength(1);
  });

  it("falls back to the second mailer, and retries when both refuse", async () => {
    const broken: Mailer = { async send() { throw new Error("down"); } };
    const fallback = memoryMailer();
    const one = setup({ mailers: [broken, fallback] });
    one.incidents.report({ source: "server", name: "Boom", message: "x", key: "a" });
    await one.incidents.flushNew();
    expect(fallback.outbox).toHaveLength(1);

    let up = false;
    const flaky: Mailer = { async send(message) { if (!up) throw new Error("down"); fallback.outbox.push(message); } };
    const two = setup({ mailers: [flaky] });
    two.incidents.report({ source: "server", name: "Boom", message: "x", key: "b" });
    await two.incidents.flushNew();
    expect(two.lines.some(line => line.includes("retried"))).toBe(true);
    up = true;
    two.time.now += MINUTE; await two.incidents.tick();
    expect(fallback.outbox).toHaveLength(2);
  });

  it("turns console errors and ALERT or failure warnings into incidents, and nothing else", () => {
    const seen: string[] = [];
    const target = { error: () => {}, warn: () => {} } as unknown as Console;
    const restore = tapConsole({ report: input => { seen.push(`${input.name}|${input.message}`); return "id"; } }, target);
    target.warn("managed: ALERT cloud c1: its setup failed 3 times");
    target.warn("persistence: writer lease renewal failed; retrying");
    target.warn("admin: 2 allowed accounts");
    target.warn("incidents: an alert email failed");
    target.error("Email delivery failed.");
    restore();
    target.error("after restore");
    expect(seen).toEqual(["managed alert|ALERT cloud c1: its setup failed 3 times", "persistence warn|writer lease renewal failed; retrying", "service error|Email delivery failed."]);
  });
});

describe("error endpoints", () => {
  const origin = "http://127.0.0.1:7998";
  let dataDir: string, server: Server, url: string, app: ReturnType<typeof createDashboardApp>;
  let alerts: ReturnType<typeof setup>, mailer: ReturnType<typeof memoryMailer>;
  const csrf = new Map<string, string>();
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dusk-incidents-test-"));
    mailer = memoryMailer();
    alerts = setup();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, incidents: alerts.incidents, admin: { emails: [OWNER], env: {} } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture failed to start.");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  async function login(email: string) {
    const start = await post("/v1/auth/start", { email });
    const { attempt } = await start.json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
    const verify = await post("/v1/auth/verify", { attempt, code });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }

  it("takes a client error into the incident pipeline, capped in size, rate and origin", async () => {
    const sent = await post("/v1/errors", { source: "desktop", type: "TypeError", message: "x is undefined", stack: "at a (app://bundle/assets/i.js:1:2)", path: "/chat/42", version: "0.1.141", os: "darwin 25" });
    expect(sent.status).toBe(204);
    const [incident] = await alerts.incidents.list({ limit: 5 });
    expect(incident).toMatchObject({ source: "desktop", name: "TypeError", version: "0.1.141", os: "darwin 25", path: "/chat/42" });
    expect((await post("/v1/errors", { message: "x".repeat(MAX_ERROR_BYTES) })).status).toBe(413);
    expect((await post("/v1/errors", {}, { origin: "https://evil.example" })).status).toBe(403);
    let last = 0;
    for (let n = 0; n < ERRORS_PER_HOUR; n++) last = (await post("/v1/client-error", { message: `m${n}` })).status;
    expect(last).toBe(429);
  });

  it("lists incidents and fires a test alert only for an admin", async () => {
    alerts.incidents.report({ source: "server", name: "Boom", message: "x", key: "a" });
    expect((await fetch(`${url}/v1/admin/incidents`)).status).toBe(401);
    const other = await login("someone@example.test");
    expect((await fetch(`${url}/v1/admin/incidents`, { headers: { cookie: other } })).status).toBe(403);
    expect((await post("/v1/admin/incidents/test", {}, { cookie: other, [CSRF_HEADER]: csrf.get(other)! })).status).toBe(403);
    const owner = await login(OWNER);
    const list = await fetch(`${url}/v1/admin/incidents?limit=10`, { headers: { cookie: owner } });
    expect(list.status).toBe(200);
    const body = await list.json() as { incidents: Array<{ id: string; name: string; count: number; lastSeen: number }>; next: number | null };
    expect(body.incidents.map(item => item.name)).toEqual(["Boom"]);
    expect(body.next).toBeNull();
    expect((await post("/v1/admin/incidents/test", {}, { cookie: owner })).status).toBe(403);
    const test = await post("/v1/admin/incidents/test", {}, { cookie: owner, [CSRF_HEADER]: csrf.get(owner)! });
    expect(await test.json()).toMatchObject({ ok: true });
    expect(alerts.mailer.outbox.at(-1)!.subject).toBe("test alert: this is what a problem looks like");
    const mute = await post(`/v1/admin/incidents/${body.incidents[0]!.id}/mute`, { hours: 24 }, { cookie: owner, [CSRF_HEADER]: csrf.get(owner)! });
    expect(mute.status).toBe(200);
  });

  it("reports a failing site upstream once, with the request id the client saw", async () => {
    app.close();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, incidents: alerts.incidents, pageBase: "/dashboard", siteUpstream: "http://127.0.0.1:9" });
    server.removeAllListeners("request");
    server.on("request", app.handle);
    const answer = await fetch(`${url}/pricing`);
    expect(answer.status).toBe(502);
    expect(answer.headers.get("x-request-id")).toMatch(/^[\w-]{12}$/);
    const list = await alerts.incidents.list({ limit: 5 });
    expect(list.map(item => item.name)).toEqual(["SiteUpstreamDown"]);
  });
});

describe("an ops alert's end", () => {
  it("sends one back-to-normal email for a mailed problem, and never a second", async () => {
    const { time, mailer, incidents } = setup();
    const id = incidents.report({ source: "ops", name: "contabo disk", message: "91% (alert when > 85%)", key: "ops-contabo-disk-1" })!;
    await incidents.flushNew();
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.subject).toBe("something's wrong: contabo disk (ops monitor)");
    time.now += HOUR;
    expect(await incidents.recovered(id, "contabo disk is back to normal: 60%.")).toBe(true);
    expect(await incidents.recovered(id, "contabo disk is back to normal: 60%.")).toBe(false);
    expect(mailer.outbox).toHaveLength(2);
    expect(mailer.outbox[1]!.subject).toBe("back to normal: contabo disk");
    expect(mailer.outbox[1]!.text).toContain("contabo disk is back to normal: 60%.");
  });
  it("mails a node's second outage on the same day as its own incident, down and back", async () => {
    const { time, mailer, incidents } = setup();
    const first = incidents.report({ source: "ops", name: "link node oracle-in down", message: "no answer", key: "ops-relay-node-oracle-in-down-1794579000000" })!;
    await incidents.flushNew();
    time.now += 10 * 60_000;
    expect(await incidents.recovered(first, "back")).toBe(true);
    time.now += 2 * HOUR;
    const second = incidents.report({ source: "ops", name: "link node oracle-in down", message: "no answer", key: "ops-relay-node-oracle-in-down-1794586870000" })!;
    expect(second).not.toBe(first);
    await incidents.flushNew();
    time.now += 5 * 60_000;
    expect(await incidents.recovered(second, "back")).toBe(true);
    expect(mailer.outbox.map((mail) => mail.subject.split(":")[0])).toEqual(["something's wrong", "back to normal", "something's wrong", "back to normal"]);
  });
  it("sends nothing for a problem that was never mailed", async () => {
    const { mailer, incidents } = setup();
    const id = incidents.report({ source: "ops", name: "r2 storage", message: "9 gb", key: "ops-r2-1" })!;
    expect(await incidents.recovered(id, "fine")).toBe(false);
    expect(mailer.outbox).toHaveLength(0);
  });
});
