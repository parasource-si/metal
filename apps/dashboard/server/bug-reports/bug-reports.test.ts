import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../app.ts";
import { createTestMailbox, memoryMailer } from "../auth/mail.ts";
import { memorySink } from "../analytics/sink.ts";
import { CSRF_HEADER } from "../../../../shared/account-api.ts";
import { askReportStatus, bugReportsHomeSignature as desktopSignature, sendDevsReport } from "../../../../server/devs-report-send.ts";
import type { DevsReportPayload, FeedbackPayload } from "../../../../server/devs-report.ts";
import { bugReportsHomeSignature, RATES } from "./index.ts";
import { memoryBugReportStore } from "./store.ts";

const ADMIN = "owner@example.test", OTHER = "someone@example.test", ALERT = "owner@qa.dusk.test";
const INSTALL = "test-install-0001";
const payload = (over: Partial<DevsReportPayload> = {}): DevsReportPayload => ({ installId: INSTALL, source: "bot", description: "pictures never load\n\nWhere: Scout's chat",
  appVersion: "0.1.150", platform: "darwin arm64, desktop app", diagnostics: "Metal @devs report\nApp version: 0.1.150", contactEmail: "ada@example.com", contact: "ada@example.com", ...over });

describe("bug reports", () => {
  let mailer: ReturnType<typeof memoryMailer>;
  let app: ReturnType<typeof createDashboardApp>;
  let store: ReturnType<typeof memoryBugReportStore>;
  let testMail: ReturnType<typeof createTestMailbox>;
  let server: Server;
  let dataDir: string;
  let url: string;
  let time: number;
  const origin = "http://127.0.0.1:7999";
  const csrf = new Map<string, string>();
  const endpoint = () => `${url}/api/bug-reports`;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dusk-bug-reports-test-"));
    time = Date.parse("2026-11-16T12:00:00Z");
    mailer = memoryMailer();
    store = memoryBugReportStore();
    testMail = createTestMailbox({ readable: true, now: () => time });
    csrf.clear();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, testMail, staticDir: null, now: () => time, analytics: { sink: memorySink(() => time) }, admin: { emails: [ADMIN], env: {} },
      bugReports: { store, mail: { on: true, to: () => [ALERT], mailers: [mailer] } } });
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
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  async function signIn(email: string) {
    const start = await post("/v1/auth/start", { email }, { origin });
    const { attempt } = await start.json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
    const verify = await post("/v1/auth/verify", { attempt, code }, { origin });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it("takes the desktop's exact report, answers the id it shows, and mails the owner once", async () => {
    const sent = await sendDevsReport(endpoint(), payload());
    expect(sent).toMatchObject({ ok: true, id: expect.stringMatching(/^dr-[a-z2-9]{10}$/) });
    const id = (sent as { id: string }).id;
    expect(store.all.get(id)).toMatchObject({ installId: INSTALL, source: "bot", contact: "ada@example.com", status: "new", appVersion: "0.1.150" });
    await settle();
    expect(testMail.latest(ALERT)?.subject).toBe(`bug report ${id}: pictures never load`);
    expect(mailer.outbox.filter(item => item.to === ALERT)).toHaveLength(0);
    // the same bytes again (an answer lost on the way back): the same id, no second email
    const again = await sendDevsReport(endpoint(), payload());
    expect(again).toEqual({ ok: true, id });
    expect(store.all.size).toBe(1);
    const first = testMail.latest(ALERT)!.at;
    time += 1000;
    await settle();
    expect(testMail.latest(ALERT, first + 1)).toBeNull();
  });

  it("takes feedback the app sends itself from its own page, with no cookie", async () => {
    const appPage = "http://127.0.0.1:5199";
    const preflight = await fetch(endpoint(), { method: "OPTIONS", headers: { origin: appPage, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
    const sent = await post("/api/bug-reports", { ...payload({ diagnostics: "" }), source: "feedback", images: [] }, { origin: appPage });
    expect(sent.status).toBe(201);
    expect(sent.headers.get("access-control-allow-origin")).toBe("*");
    expect(sent.headers.get("access-control-allow-credentials")).toBeNull();
    const { id } = await sent.json() as { id: string };
    expect(store.all.get(id)).toMatchObject({ source: "feedback", installId: INSTALL });
  });

  it("refuses what the desktop must not resend, and a bad address only costs the address", async () => {
    expect(await sendDevsReport(endpoint(), payload({ installId: "x" }))).toMatchObject({ ok: false, retry: false, why: "refused" });
    expect(await sendDevsReport(endpoint(), payload({ description: " " }))).toMatchObject({ ok: false, retry: false });
    expect(await sendDevsReport(endpoint(), payload({ appVersion: "9".repeat(41) }))).toMatchObject({ ok: false, retry: false });
    expect((await post("/api/bug-reports", { ...payload(), diagnostics: "d".repeat(262_145) })).status).toBe(400);
    const tooBig = await fetch(endpoint(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload(), diagnostics: "d".repeat(700 * 1024) }) });
    expect(tooBig.status).toBe(413);
    const noContact = await sendDevsReport(endpoint(), payload({ contactEmail: "not an address", contact: "not an address" }));
    expect(noContact).toMatchObject({ ok: true });
    expect(store.all.get((noContact as { id: string }).id)!.contact).toBeNull();
    expect((await fetch(endpoint())).status).toBe(405);
  });

  it("limits each install per hour and says when to come back", async () => {
    for (let n = 0; n < RATES.reportsPerInstallHour; n++) expect((await sendDevsReport(endpoint(), payload({ description: `bug ${n}` }))).ok).toBe(true);
    const limited = await post("/api/bug-reports", payload({ description: "one more" }));
    expect(limited.status).toBe(429);
    const body = await limited.json() as { retryAfter: number };
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(limited.headers.get("retry-after")).toBe(String(body.retryAfter));
    expect(await sendDevsReport(endpoint(), payload({ description: "again" }))).toMatchObject({ ok: false, retry: true, why: "limited", retryAfterMs: body.retryAfter * 1000 });
    expect((await sendDevsReport(endpoint(), payload({ installId: "other-install-02", description: "another install" }))).ok).toBe(true);
    time += 3_600_001;
    expect((await sendDevsReport(endpoint(), payload({ description: "an hour later" }))).ok).toBe(true);
  });

  it("lists reports newest first for an admin only, and the status set there reaches the desktop", async () => {
    const a = await sendDevsReport(endpoint(), payload({ description: "older" })) as { id: string };
    time += 60_000;
    const b = await sendDevsReport(endpoint(), payload({ description: "newer" })) as { id: string };
    const owner = await signIn(ADMIN), other = await signIn(OTHER);
    expect((await fetch(`${url}/v1/admin/bug-reports`)).status).toBe(401);
    expect((await fetch(`${url}/v1/admin/bug-reports`, { headers: { cookie: other } })).status).toBe(403);
    const list = await (await fetch(`${url}/v1/admin/bug-reports`, { headers: { cookie: owner } })).json() as { reports: Array<{ id: string; status: string; diagnostics?: string }>; counts: Record<string, number> };
    expect(list.reports.map(report => report.id)).toEqual([b.id, a.id]);
    expect(list.reports[0]).not.toHaveProperty("diagnostics");
    expect(list.counts).toEqual({ new: 2, looking: 0, fixed: 0, "wont-fix": 0 });
    const one = await (await fetch(`${url}/v1/admin/bug-reports/${a.id}`, { headers: { cookie: owner } })).json() as { report: { diagnostics: string } };
    expect(one.report.diagnostics).toContain("App version: 0.1.150");

    const patch = (id: string, body: unknown, cookie = owner, withCsrf = true) => fetch(`${url}/v1/admin/bug-reports/${id}`, { method: "PATCH",
      headers: { "content-type": "application/json", origin, cookie, ...(withCsrf ? { [CSRF_HEADER]: csrf.get(cookie)! } : {}) }, body: JSON.stringify(body) });
    expect((await patch(a.id, { status: "fixed" }, other)).status).toBe(403);
    expect((await patch(a.id, { status: "fixed" }, owner, false)).status).toBe(403);
    expect((await patch(a.id, { status: "done" })).status).toBe(400);
    expect((await patch(a.id, { status: "fixed", fixedIn: "soon" })).status).toBe(400);
    expect((await patch("dr-nosuchreport", { status: "looking" })).status).toBe(404);
    expect((await patch(a.id, { status: "fixed", fixedIn: "0.1.151" })).status).toBe(200);
    expect((await patch(b.id, { status: "wont-fix" })).status).toBe(200);

    const answer = await askReportStatus(`${url}/api/bug-reports/status`, { installId: INSTALL, ids: [a.id, b.id, "dr-unknown"] }, null);
    expect(answer).toEqual({ notify: true, reports: [{ id: a.id, status: "fixed", fixedIn: "0.1.151" }, { id: b.id, status: "received", fixedIn: null }, { id: "dr-unknown", status: "unknown", fixedIn: null }] });
    // another install never learns about these reports
    const stranger = await askReportStatus(`${url}/api/bug-reports/status`, { installId: "someone-else-01", ids: [a.id] }, null);
    expect(stranger?.reports).toEqual([{ id: a.id, status: "unknown", fixedIn: null }]);
    const filtered = await (await fetch(`${url}/v1/admin/bug-reports?status=fixed`, { headers: { cookie: owner } })).json() as { reports: Array<{ id: string }> };
    expect(filtered.reports.map(report => report.id)).toEqual([a.id]);
  });

  it("takes feedback with pictures, signed out or not, keeps them for an admin only, and mails it as feedback", async () => {
    const jpeg = readFileSync(new URL("../../../../server/testing/fixtures/banner-metadata.jpg", import.meta.url));
    const png = readFileSync(new URL("../../../../server/testing/fixtures/banner-metadata.png", import.meta.url));
    const feedback = (over: Partial<FeedbackPayload> = {}): FeedbackPayload => ({ installId: INSTALL, source: "feedback", description: "the Connect apps window opened behind the chat",
      appVersion: "0.2.14", platform: "darwin arm64, desktop app", diagnostics: "", ...over });
    const sent = await sendDevsReport(endpoint(), feedback({ images: [{ type: "image/jpeg", data: jpeg.toString("base64") }, { type: "image/png", data: png.toString("base64") }] })) as { id: string };
    expect(sent.id).toMatch(/^dr-/);
    expect(store.all.get(sent.id)).toMatchObject({ source: "feedback", contact: null, images: 2 });
    await settle();
    expect(testMail.latest(ALERT)?.subject).toBe(`feedback ${sent.id}: the Connect apps window opened behind the chat`);

    const owner = await signIn(ADMIN), other = await signIn(OTHER);
    const list = await (await fetch(`${url}/v1/admin/bug-reports`, { headers: { cookie: owner } })).json() as { reports: Array<{ id: string; source: string; images: number }> };
    expect(list.reports[0]).toMatchObject({ id: sent.id, source: "feedback", images: 2 });
    const image = (n: number, cookie?: string) => fetch(`${url}/v1/admin/bug-reports/${sent.id}/images/${n}`, { headers: cookie ? { cookie } : {} });
    expect((await image(0)).status).toBe(401);
    expect((await image(0, other)).status).toBe(403);
    const first = await image(0, owner);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await first.arrayBuffer());
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(bytes.includes(Buffer.from("Secret"))).toBe(false);
    expect((await image(1, owner)).headers.get("content-type")).toBe("image/png");
    expect((await image(2, owner)).status).toBe(404);

    const signedIn = await sendDevsReport(endpoint(), feedback({ description: "signed in", contactEmail: "ada@example.com", contact: "ada@example.com" })) as { id: string };
    expect(store.all.get(signedIn.id)).toMatchObject({ contact: "ada@example.com", images: 0 });
  });

  it("refuses too many pictures, one that isn't a picture, and a big body without pictures", async () => {
    const png = readFileSync(new URL("../../../../server/testing/fixtures/banner-metadata.png", import.meta.url)).toString("base64");
    const body = (images: unknown, extra: Record<string, unknown> = {}) => ({ ...payload({ source: "feedback" as "bot", diagnostics: "" }), images, ...extra });
    expect((await post("/api/bug-reports", body(Array.from({ length: 4 }, () => ({ type: "image/png", data: png }))))).status).toBe(400);
    const notPicture = await post("/api/bug-reports", body([{ type: "image/png", data: Buffer.from("<html>").toString("base64") }]));
    expect(notPicture.status).toBe(400);
    expect((await notPicture.json() as { code: string }).code).toBe("invalid_image");
    expect((await post("/api/bug-reports", body([], { description: "x".repeat(9_000), diagnostics: "d".repeat(250_000), filler: "f".repeat(400 * 1024) }))).status).toBe(413);
    expect((await post("/api/bug-reports", body([{ type: "image/png", data: png }], { filler: "f".repeat(400 * 1024) }))).status).toBe(201);
    expect((await post("/api/bug-reports", body([{ type: "image/png", data: "A".repeat(2_600 * 1024) }]))).status).toBe(413);
  });

  it("refuses a signed status question from an unknown machine, and signs the way the desktop does", async () => {
    const answer = await askReportStatus(`${url}/api/bug-reports/status`, { installId: INSTALL, ids: [] }, { machineId: "cl_unknown", bootstrapSecret: "secret" }, fetch, () => time);
    expect(answer).toBeNull();
    expect(bugReportsHomeSignature("s3cret", "cl_1", "1763294400", "nonce-nonce-nonce-1", "{}")).toBe(desktopSignature("s3cret", "cl_1", "1763294400", "nonce-nonce-nonce-1", "{}"));
  });
});
