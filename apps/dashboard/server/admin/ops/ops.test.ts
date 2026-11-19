import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../../app.ts";
import { memoryMailer } from "../../auth/mail.ts";
import { memorySink } from "../../analytics/sink.ts";
import { CSRF_HEADER } from "../../../../../shared/account-api.ts";
import { costOf, memoryInfraStore, type InfraDay } from "../infra.ts";
import { createErrorCounter } from "../health.ts";
import { backupRun, collectBrevo, collectCloudflare, collectComposio, collectRelay, CollectorError, netCounters, parseReport, vnstatMonth, vnstatToday } from "./collectors.ts";
import { median, ratioOf, robustZ, step, suspects } from "./math.ts";
import { createOps, r2Overage, SIGNALS, workersOverage } from "./index.ts";
import { memoryOpsStore, type OpsRuleState } from "./store.ts";
import type { OpsAnswer } from "../../../src/admin/ops-types.ts";
import { createMailRouter, memoryMailUsage, type MailUsage } from "../../auth/mail-router.ts";

const DAY = 86_400_000, MINUTE = 60_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("outlier math", () => {
  it("takes the median of odd, even and empty lists", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it("scores distance from the median in robust deviations, and gives none for a flat fleet", () => {
    expect(robustZ(100, [10, 11, 12, 13, 100])).toBeGreaterThan(20);
    expect(robustZ(12, [10, 11, 12, 13, 100])).toBe(0);
    expect(robustZ(9, [5, 5, 5, 9])).toBeNull();
  });
  it("never divides by a median under the floor", () => {
    expect(ratioOf(40, 2, 10)).toBe(4);
    expect(ratioOf(40, 20, 10)).toBe(2);
    expect(ratioOf(1, 0, 0)).toBeNull();
  });
  it("ranks people by how far past the median their signals are, with a why line", () => {
    const base = Array.from({ length: 8 }, (_, i) => ({ key: `a${i}`, accountId: `a${i}`, email: null, ip: null, values: { egress: 10 + i, awake: 100 } }));
    const ranked = suspects([...base,
      { key: "heavy", accountId: "heavy", email: "heavy@example.test", ip: null, values: { egress: 400, awake: 700 } },
      { key: "ip:203.0.113.9", accountId: null, email: null, ip: "203.0.113.9", values: { signups_ip: 12 } },
      { key: "mild", accountId: "mild", email: null, ip: null, values: { egress: 30 } }], SIGNALS);
    expect(ranked.map(row => row.key)).toEqual(["heavy", "ip:203.0.113.9"]);
    expect(ranked[0]!.why).toMatch(/^400 gb egress \(27\.6x the median\), 700 h awake \(7x the median\)$/);
    expect(ranked[1]!.signals[0]).toMatchObject({ kind: "signups_ip", value: 12 });
  });
});

describe("alert rules", () => {
  const ok: OpsRuleState = { id: "r", state: "ok", since: null, value: null, incidentId: null, lastFiredAt: null, updatedAt: 0 };
  it("fires once per breach and once more when it ends, nothing in between", () => {
    let state = ok, events: Array<string | null> = [];
    for (const [breach, at] of [[true, 0], [true, 5], [true, 10], [false, 15], [false, 20], [true, 25]] as const) {
      const out = step(state, { breach, value: String(at) }, 0, at * MINUTE);
      state = out.next; events.push(out.event);
    }
    expect(events).toEqual(["fire", null, null, "recover", null, "fire"]);
  });
  it("waits out the for-period before firing and forgets a breach that clears first", () => {
    let out = step(ok, { breach: true, value: "95%" }, 10 * MINUTE, 0);
    expect(out).toMatchObject({ event: null, next: { state: "pending", since: 0 } });
    out = step(out.next, { breach: true, value: "95%" }, 10 * MINUTE, 5 * MINUTE);
    expect(out.event).toBeNull();
    out = step(out.next, { breach: true, value: "96%" }, 10 * MINUTE, 10 * MINUTE);
    expect(out).toMatchObject({ event: "fire", next: { state: "firing", since: 0 } });
    const cleared = step(step(ok, { breach: true, value: "x" }, 10 * MINUTE, 0).next, { breach: false, value: "y" }, 10 * MINUTE, MINUTE);
    expect(cleared).toMatchObject({ event: null, next: { state: "ok" } });
  });
  it("keeps its state when the reading is missing", () => {
    const firing = { ...ok, state: "firing" as const, since: 1 };
    expect(step(firing, { breach: null, value: null }, 0, 99)).toEqual({ next: firing, event: null });
  });
});

describe("prices", () => {
  it("charges workers only past the included quota and r2 only past 10 gb", () => {
    expect(workersOverage(9_000_000, 29_000_000)).toBe(0);
    expect(workersOverage(12_000_000, 40_000_000)).toBe(60 + 20);
    expect(r2Overage(9e9)).toBe(0);
    expect(r2Overage(30e9)).toBe(30);
  });
});

describe("collectors", () => {
  it("reads cloudflare workers per script and day, and each bucket's newest size", async () => {
    let sent: { auth: string | null; body: any } | null = null;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = { auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) };
      return json({ data: { viewer: { accounts: [{
        w: [{ dimensions: { scriptName: "dusk-edge", date: "2026-11-12" }, sum: { requests: 100, errors: 2, cpuTimeUs: 5_500 } }],
        r: [{ dimensions: { bucketName: "makedesign", date: "2026-11-12" }, max: { payloadSize: 3_000, metadataSize: 10, objectCount: 7 } },
          { dimensions: { bucketName: "makedesign", date: "2026-11-11" }, max: { payloadSize: 1, metadataSize: 0, objectCount: 1 } }],
      }] } }, errors: null });
    }) as unknown as typeof fetch;
    const data = await collectCloudflare({ token: "cf-token", accountId: "acc", now: NOW, fetch: fake });
    expect(sent!.auth).toBe("Bearer cf-token");
    expect(sent!.body.variables).toMatchObject({ a: "acc", s: "2026-11-01T00:00:00.000Z" });
    expect(data).toEqual({ days: [{ day: "2026-11-12", script: "dusk-edge", requests: 100, cpuMs: 6, errors: 2 }], buckets: [{ name: "makedesign", bytes: 3_010, objects: 7 }] });
  });
  it("turns a refused token into a short reason without the token", async () => {
    const refused = (async () => json({ errors: [{ message: "no" }] }, 403)) as unknown as typeof fetch;
    const error = await collectCloudflare({ token: "secret-token", accountId: "acc", now: NOW, fetch: refused }).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(CollectorError);
    expect(error!.message).toBe("cloudflare analytics refused the token (403)");
    const graph = (async () => json({ data: null, errors: [{ message: "not authorized for account" }] })) as unknown as typeof fetch;
    await expect(collectCloudflare({ token: "t", accountId: "acc", now: NOW, fetch: graph })).rejects.toThrow("cloudflare analytics: not authorized for account");
  });
  it("reads brevo's day and month and copes without the account read", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/account")) return json({ code: "permission_denied" }, 401);
      return url.includes("startDate=2026-11-12&endDate=2026-11-12") ? json({ requests: 41, delivered: 40, hardBounces: 1, softBounces: 0, blocked: 0 }) : json({ requests: 612 });
    }) as unknown as typeof fetch;
    expect(await collectBrevo({ apiKey: "k", now: NOW, fetch: fake })).toEqual({ today: { sent: 41, delivered: 40, bounced: 1, blocked: 0 }, month: { sent: 612 }, plan: null });
    expect(urls.some(url => url.includes("startDate=2026-11-01&endDate=2026-11-12"))).toBe(true);
  });
  it("reads the broker's and the link service's counters", async () => {
    const broker = (async () => json({ days: [{ day: "2026-11-12", calls: 9 }], installations: [{ id: "i1", machine: "c1", days: { "2026-11-12": 9 } }], registrations: [{ ip: "203.0.113.9", day: "2026-11-12", count: 3 }], queue: { events: 2, bytes: 10 } })) as unknown as typeof fetch;
    expect(await collectComposio({ url: "https://broker.test/", token: "t", fetch: broker })).toMatchObject({ installations: [{ id: "i1", machine: "c1", days: { "2026-11-12": 9 } }], queue: { events: 2, bytes: 10 } });
    const link = (async () => json({ limitBytes: 5, tunnels: [{ id: "t1", acct: "a1", days: { "2026-11-12": { bytes: 7, limited: 1 } } }] })) as unknown as typeof fetch;
    expect(await collectRelay({ url: "https://link.test", token: "t", fetch: link })).toEqual({ limitBytes: 5, tunnels: [{ id: "t1", accountId: "a1", days: { "2026-11-12": { bytes: 7, limited: 1 } } }] });
  });
  it("parses the host's own counters", () => {
    expect(netCounters("Inter-|\n face |\n    lo: 100 0 0 0 0 0 0 0 200 0\n  eth0: 1000 5 0 0 0 0 0 0 2000 4\n")).toEqual({ rx: 1000, tx: 2000 });
    expect(vnstatToday(JSON.stringify({ interfaces: [{ traffic: { day: [{ date: { year: 2026, month: 11, day: 12 }, rx: 5, tx: 6 }, { date: { year: 2026, month: 11, day: 11 }, rx: 1, tx: 1 }] } }] }), "2026-11-12")).toEqual({ rx: 5, tx: 6 });
    // container bridges repeat the box's own bytes, so only its own interfaces count
    const vn = JSON.stringify({ interfaces: [
      { name: "eth0", traffic: { day: [{ date: { year: 2026, month: 11, day: 12 }, rx: 5, tx: 6 }], month: [{ date: { year: 2026, month: 11 }, rx: 50, tx: 60 }, { date: { year: 2026, month: 10 }, rx: 1, tx: 1 }] } },
      { name: "br-277ab3b2dd91", traffic: { day: [{ date: { year: 2026, month: 11, day: 12 }, rx: 9, tx: 9 }], month: [{ date: { year: 2026, month: 11 }, rx: 90, tx: 90 }] } },
    ] });
    expect(vnstatToday(vn, "2026-11-12")).toEqual({ rx: 5, tx: 6 });
    expect(vnstatMonth(vn, "2026-11")).toEqual({ rx: 50, tx: 60 });
    expect(vnstatMonth(vn, "2026-09")).toBeNull();
    expect(backupRun("Result=success\nExecMainExitTimestamp=Fri 2026-11-13 02:31:54 IST\n").result).toBe("success");
    expect(backupRun("Result=exit-code\nExecMainExitTimestamp=\n")).toEqual({ result: "exit-code", exitedAt: null });
  });
  it("accepts a host report field by field", () => {
    expect(parseReport({ host: "oracle", cpu: 3, mem: 18, disk: 61, load: [0.1, 0.1, 0.1], cores: 2, backups: [{ set: "dusk", at: 5 }, { set: "../x", at: 1 }], extra: "dropped" }))
      .toEqual({ host: "oracle", cpu: 3, mem: 18, disk: 61, load: [0.1, 0.1, 0.1], cores: 2, memTotalBytes: null, diskTotalBytes: null, backups: [{ set: "dusk", at: 5 }] });
    expect(parseReport({ host: "Oracle Box" })).toBeNull();
    expect(parseReport({ host: "oracle", cpu: 400 })?.cpu).toBeNull();
  });
});

describe("ops alerts into incidents", () => {
  function infraRow(accountId: string, cloudId: string, day: string, egressGb: number, hours: number): InfraDay {
    const usage = { runningSeconds: hours * 3600, vcpuSeconds: hours * 7200, memGiBSeconds: hours * 14_400, diskGiBSeconds: 40 * 86_400, egressBytes: egressGb * 1e9 };
    return { day, cloudId, accountId, serverId: `s-${cloudId}`, ...usage, ...costOf(usage), collectedAt: NOW };
  }
  function fixture(env: NodeJS.ProcessEnv = {}, mailUsage: (() => Promise<MailUsage>) | null = null) {
    let time = NOW;
    const store = memoryOpsStore(), infra = memoryInfraStore();
    const reports: Array<{ key: string; name: string; message: string }> = [], recoveries: string[] = [];
    const ops = createOps({ store, env: { DUSK_OPS_CERT_HOSTS: " ", DUSK_OPS_PROBES: "x=x=https://x.test/", ...env }, now: () => time, fetch: (async () => json({ ok: true })) as unknown as typeof fetch,
      db: null, infra, clouds: () => [], egress: () => null, emails: () => new Map([["heavy", "heavy@example.test"]]), customers: () => [], ledger: () => [], invoices: () => [],
      errors: createErrorCounter(() => time), selfUrl: null, environment: "production", host: false, mailUsage,
      incidents: { report: input => { reports.push(input); return `inc-${reports.length}`; }, recovered: async id => { recoveries.push(id); return true; } } });
    return { ops, store, infra, reports, recoveries, at: (t: number) => { time = t; } };
  }

  it("mails an outlier once, never again while it lasts, and once when it ends", async () => {
    const f = fixture();
    await f.infra.put([...Array.from({ length: 6 }, (_, i) => infraRow(`a${i}`, `c${i}`, "2026-11-12", 5, 8)), infraRow("heavy", "cheavy", "2026-11-12", 900, 24)]);
    await f.ops.evaluate();
    await f.ops.evaluate();
    f.at(NOW + 5 * MINUTE);
    await f.ops.evaluate();
    expect(f.reports.map(r => r.key)).toEqual([`ops-outlier-heavy-${NOW}`]);
    expect(f.reports[0]!.message).toMatch(/900 gb egress/);
    await f.infra.put([infraRow("heavy", "cheavy", "2026-11-12", 5, 8)]);
    await f.ops.evaluate();
    await f.ops.evaluate();
    expect(f.recoveries).toEqual(["inc-1"]);
    const answer = await f.ops.answer();
    expect(answer.alerts.find(rule => rule.id === "outlier-heavy")).toMatchObject({ state: "ok", lastFiredAt: NOW });
  });

  it("mails once when brevo's day passes 80% of its limit", async () => {
    const f = fixture({ DUSK_BREVO_API_KEY: "k", DUSK_BREVO_DAILY_LIMIT: "300" });
    const brevo = (sent: number) => f.store.setLatest({ source: "brevo", at: NOW, ok: true, error: null, data: { today: { sent, delivered: sent, bounced: 0, blocked: 0 }, month: { sent }, plan: null } });
    await brevo(200); await f.ops.evaluate();
    expect(f.reports).toHaveLength(0);
    await brevo(250); await f.ops.evaluate(); await f.ops.evaluate();
    expect(f.reports.map(r => r.name)).toEqual(["brevo emails today"]);
    expect(f.reports[0]!.message).toMatch(/250 of 300/);
  });

  it("shows each mail provider against its caps, and mails once when resend nears its cap or mail passes to the other provider", async () => {
    let time = NOW;
    const usage = memoryMailUsage(), log: string[] = [];
    const router = createMailRouter({ providers: { resend: { async send() {} }, brevo: { async send() {} } }, caps: { resend: { daily: 5, monthly: 3_000 }, brevo: { daily: 300, monthly: 10_000 } },
      usage, now: () => time, log: line => log.push(line) });
    const f = fixture({}, () => router.usage());
    const code = { to: "person@example.test", subject: "01234567 is your Metal code", text: "t", html: "<p>t</p>", transactional: true };
    for (let i = 0; i < 4; i++) await router.send(code);
    await router.send({ ...code, transactional: false });
    await f.ops.evaluate();
    expect(f.reports).toHaveLength(0);
    let mail = (await f.ops.answer()).spend.mail!;
    expect(mail.providers.map(p => [p.provider, p.daily.used, p.daily.limit, p.monthly.limit, p.fallbacks.today])).toEqual([["resend", 4, 5, 3_000, 0], ["brevo", 1, 300, 10_000, 0]]);
    await router.send(code); await router.send(code);
    await f.ops.evaluate(); await f.ops.evaluate();
    expect(f.reports.map(r => r.name)).toEqual(["resend emails today", "emails sent through the other provider"]);
    expect(f.reports[1]!.message).toMatch(/1 passed over by resend/);
    mail = (await f.ops.answer()).spend.mail!;
    expect(mail.providers[0]).toMatchObject({ provider: "resend", daily: { used: 5, level: "bad" }, fallbacks: { today: 1, month: 1 } });
    expect(mail.providers[1]!.daily.used).toBe(2);
    // a new day: the counts reset and both rules recover, no new mail
    time = NOW + DAY; f.at(NOW + DAY);
    await f.ops.evaluate();
    expect(f.reports).toHaveLength(2);
    expect(f.recoveries).toEqual(["inc-1", "inc-2"]);
  });

  it("mails once when contabo's upload stays past 70% for 15 minutes or the month is on course past the allowance", async () => {
    const f = fixture();
    const host = (outRate: number, outMonth: number) => f.store.setLatest({ source: "host", at: NOW, ok: true, error: null,
      data: { cpu: 5, mem: 20, disk: 40, load: [0, 0, 0], cores: 12, memTotalBytes: 1, diskTotalBytes: 1, backups: [], net: { inToday: 0, outToday: 0, inRate: 0, outRate, rx: 0, tx: 0, outMonth } } });
    // 90 mbit/s is past 70% of the default 120; 1 tb by the 13th is nowhere near 32 tb
    await host(90e6 / 8, 1e12);
    await f.ops.evaluate();
    f.at(NOW + 10 * MINUTE); await f.ops.evaluate();
    expect(f.reports).toHaveLength(0);
    f.at(NOW + 15 * MINUTE); await f.ops.evaluate();
    f.at(NOW + 20 * MINUTE); await f.ops.evaluate();
    expect(f.reports.map(r => r.name)).toEqual(["contabo upload"]);
    expect(f.reports[0]!.message).toMatch(/90 mbit\/s/);
    // back under: one recovery; then 16 tb by the 13th is on course for ~37 tb: one more incident, not repeated
    await host(20e6 / 8, 16e12);
    f.at(NOW + 25 * MINUTE); await f.ops.evaluate();
    f.at(NOW + 30 * MINUTE); await f.ops.evaluate();
    expect(f.recoveries).toEqual(["inc-1"]);
    expect(f.reports.map(r => r.name)).toEqual(["contabo upload", "contabo monthly upload"]);
    expect(f.reports[1]!.message).toMatch(/on course past 32 tb/);
  });

  it("keeps a firing rule quiet across a restart, because the state is stored", async () => {
    const f = fixture();
    await f.ops.report({ host: "oracle", cpu: 1, mem: 10, disk: 95, load: [0, 0, 0], cores: 2, backups: [] });
    await f.ops.evaluate();
    const again = createOps({ store: f.store, env: { DUSK_OPS_CERT_HOSTS: " " }, now: () => NOW + MINUTE, db: null, infra: f.infra, clouds: () => [], egress: () => null, emails: () => new Map(),
      customers: () => [], ledger: () => [], invoices: () => [], errors: createErrorCounter(), selfUrl: null, environment: "production", host: false,
      incidents: { report: input => { f.reports.push(input); return "dup"; }, recovered: async () => true } });
    await again.evaluate();
    expect(f.reports.filter(r => r.key.startsWith("ops-oracle-disk"))).toHaveLength(1);
  });

  it("records rules but mails nothing outside production unless DUSK_OPS_ALERTS=on", async () => {
    const f = fixture();
    const quiet = createOps({ store: memoryOpsStore(), env: { DUSK_OPS_CERT_HOSTS: " " }, now: () => NOW, db: null, infra: f.infra, clouds: () => [], egress: () => null, emails: () => new Map(),
      customers: () => [], ledger: () => [], invoices: () => [], errors: createErrorCounter(), selfUrl: null, environment: "preview", host: false,
      incidents: { report: input => { f.reports.push(input); return "x"; }, recovered: async () => true } });
    await quiet.report({ host: "oracle", disk: 99 });
    await quiet.evaluate();
    expect(f.reports).toHaveLength(0);
    expect((await quiet.answer()).alerts.find(rule => rule.id === "oracle-disk")?.state).toBe("firing");
  });

  it("counts emails and sign-in codes per account into the top accounts table", async () => {
    const f = fixture();
    f.ops.noteMail("heavy", true); f.ops.noteMail("heavy", true); f.ops.noteMail("heavy", false);
    await f.ops.collectHealth();
    await f.infra.put([infraRow("heavy", "cheavy", "2026-11-12", 5, 8)]);
    const answer = await f.ops.accounts([]);
    expect(answer.rows.find(row => row.accountId === "heavy")).toMatchObject({ email: "heavy@example.test", emails: 3, codes: 2, relay: null });
    expect(answer.reported).toEqual({ relay: false, cloud: true, mail: true });
  });

  it("keeps the people to look at in ops_latest after each collection, for another service's admin", async () => {
    const f = fixture();
    await f.infra.put([...Array.from({ length: 6 }, (_, i) => infraRow(`a${i}`, `c${i}`, "2026-11-12", 5, 8)), infraRow("heavy", "cheavy", "2026-11-12", 900, 24)]);
    await f.ops.collectHealth();
    const notes = (await f.store.latest()).find(entry => entry.source === "account-notes")?.data as { plans: Record<string, string>; suspects: Array<{ accountId: string | null }> };
    expect(notes.plans).toEqual({});
    expect(notes.suspects.map(s => s.accountId)).toContain("heavy");
  });

  it("collects on demand and builds the page from what was stored", async () => {
    const f = fixture({ DUSK_CF_ANALYTICS_TOKEN: "t", DUSK_CF_ACCOUNT_ID: "a" });
    const answer0 = await f.ops.answer();
    expect(answer0.spend.workers).toBeNull();
    const ran = await f.ops.collect();
    expect(ran.ran).toEqual(expect.arrayContaining(["probes", "certs"]));
    const answer = await f.ops.answer();
    expect(answer.sources.find(s => s.id === "cloudflare")).toMatchObject({ configured: true, ok: false });
    expect(answer.health.checks.find(check => check.id === "probe-x")).toMatchObject({ level: "ok", value: "up" });
  });
});

describe("ops routes", () => {
  const ADMIN = "owner@example.test", OTHER = "someone@example.test", TOKEN = "r".repeat(32);
  let server: Server, url: string, dataDir: string, app: ReturnType<typeof createDashboardApp>, mailer: ReturnType<typeof memoryMailer>;
  const csrf = new Map<string, string>();
  const origin = "http://127.0.0.1:7999";
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dusk-ops-test-"));
    mailer = memoryMailer();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => NOW, analytics: { sink: memorySink(() => NOW), infra: memoryInfraStore() },
      admin: { emails: [ADMIN], env: { DUSK_OPS_REPORT_TOKEN: TOKEN, DUSK_OPS_CERT_HOSTS: " ", DUSK_OPS_PROBES: "x=x=http://127.0.0.1:9/" } } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; csrf?: boolean; headers?: Record<string, string> } = {}) =>
    fetch(`${url}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers: { origin, ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie, ...(init.csrf === false ? {} : { [CSRF_HEADER]: csrf.get(init.cookie) ?? "" }) } : {}), ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  async function login(email: string) {
    const { attempt } = await (await call("/v1/auth/start", { body: { email } })).json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
    const verify = await call("/v1/auth/verify", { body: { attempt, code } });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }

  it("shows the ops page only to the admin and needs the csrf header to collect", async () => {
    const admin = await login(ADMIN), other = await login(OTHER);
    expect((await call("/v1/admin/ops")).status).toBe(401);
    expect((await call("/v1/admin/ops", { cookie: other })).status).toBe(403);
    const page = await call("/v1/admin/ops", { cookie: admin });
    expect(page.status).toBe(200);
    const body = await page.json() as OpsAnswer;
    expect(body).toMatchObject({ fixture: false, month: "2026-11" });
    expect((await call("/v1/admin/ops/collect", { cookie: other, body: {} })).status).toBe(403);
    expect((await call("/v1/admin/ops/collect", { cookie: admin, body: {}, csrf: false })).status).toBe(403);
    const collected = await call("/v1/admin/ops/collect", { cookie: admin, body: {} });
    expect(collected.status).toBe(200);
    expect((await collected.json() as { ran: string[] }).ran).toContain("probes");
  });

  it("takes a host report only with the report token", async () => {
    const report = { host: "oracle", cpu: 3, mem: 18, disk: 61, load: [0.1, 0.1, 0.1], cores: 2, backups: [{ set: "dusk", at: NOW - 3_600_000 }] };
    expect((await call("/v1/ops/report", { body: report })).status).toBe(401);
    expect((await call("/v1/ops/report", { body: report, headers: { authorization: `Bearer ${"w".repeat(32)}` } })).status).toBe(401);
    expect((await call("/v1/ops/report", { body: { host: "../x" }, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(400);
    expect((await call("/v1/ops/report", { body: report, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    const admin = await login(ADMIN);
    const body = await (await call("/v1/admin/ops", { cookie: admin })).json() as OpsAnswer;
    expect(body.health.boxes.find(box => box.name === "oracle")).toMatchObject({ disk: 61, cores: 2 });
    expect(body.health.checks.find(check => check.id === "backup-oracle-dusk")).toMatchObject({ level: "ok", value: "1h ago" });
  });

  it("hides the report route when no token is set", async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => NOW, analytics: { sink: memorySink(() => NOW) }, admin: { emails: [ADMIN], env: {} } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await call("/v1/ops/report", { body: { host: "oracle" }, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });
});

describe("day keys", () => {
  it("counts the month's elapsed share from its first day", async () => {
    const { elapsedOf } = await import("./index.ts");
    expect(elapsedOf(Date.parse("2026-11-16T00:00:00Z"))).toBeCloseTo(0.5, 2);
    expect(elapsedOf(Date.parse("2026-11-01T01:00:00Z"))).toBeCloseTo(1 / 30, 3);
    expect(DAY).toBe(86_400_000);
  });
});
