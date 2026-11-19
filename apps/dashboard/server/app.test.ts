import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { KeyObject } from "node:crypto";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { CLAIM_TTL_MS, COMMAND_TTL_MS, FAST_REPORT_MS, MAX_REPORT_BYTES, SIGNATURE_SKEW_MS, SLOW_REPORT_MS, parseEnrollRequest, parseWorkspaceReport, signedPayload } from "../../../shared/dashboard-protocol.ts";
import type { CommandView, EnrollAnswer, MachineReport, ReportAnswer, WorkspaceDetail, WorkspaceReport, WorkspaceSummary } from "../../../shared/dashboard-protocol.ts";
import { cpuPinned, createDashboardApp, pagePolicy, WORKSPACE_LIMITS } from "./app.ts";
import { PULSE_INTERVAL_MS, PULSE_SIZE, type PulseAnswer } from "../../../shared/machine-pulse.ts";
import { memoryMailer } from "./auth/mail.ts";
import { AUTH_LIMITS } from "./auth/index.ts";
import { CSRF_HEADER } from "../../../shared/account-api.ts";
import type { Account } from "./store.ts";

async function readJson<T>(response: Response | Promise<Response>): Promise<T> { return (await response).json() as Promise<T>; }

const workspace = { name: "Fixture VPS", kind: "vps" as const, version: "1.0.0", platform: "linux" };
const machine: MachineReport = {
  host: { hostname: "fixture", platform: "linux", arch: "x64", cpus: 4, cpuModel: null }, cpu: { percent: 25, load: [1, 2, 3] },
  memory: { usedBytes: 50, totalBytes: 100 }, disk: null, network: { rxBytesPerSec: 10, txBytesPerSec: 20 }, uptimeSec: 60, processUptimeSec: 30,
  app: { version: "1.0.0", node: "24" }, update: null, services: [],
};
const bot = { id: "bot1", name: "Fixture bot", color: "blue", body: null, model: null, engine: null, computer: null, busy: false, lastActiveAt: null, routines: [] };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("hosted dashboard service", () => {
  let mailer: ReturnType<typeof memoryMailer>;
  const csrf = new Map<string, string>();
  const code = (email: string) => mailer.outbox.findLast(item => item.to === email && /\b\d{8}\b/.test(item.text))?.text.match(/\b\d{8}\b/)?.[0];
  let app: ReturnType<typeof createDashboardApp>;
  let server: Server;
  let dataDir: string;
  let staticDir: string;
  let url: string;
  let time: number;
  let nonce: number;
  const origin = "http://dashboard.test";
  let keys: { publicKey: KeyObject; privateKey: KeyObject };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dusk-dashboard-test-"));
    staticDir = mkdtempSync(join(tmpdir(), "dusk-dashboard-static-"));
    writeFileSync(`${staticDir}/index.html`, "<!doctype html><title>dashboard fixture</title>");
    writeFileSync(`${staticDir}/.env`, "fixture-only");
    time = Date.now();
    nonce = 0;
    keys = generateKeyPairSync("ed25519");
    mailer = memoryMailer();
    csrf.clear();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir, now: () => time });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture failed to start.");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(staticDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  function page(path: string, body?: unknown, cookie?: string, method = body === undefined ? "GET" : "POST") {
    return fetch(`${url}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie, [CSRF_HEADER]: csrf.get(cookie) ?? "" } : {}), origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login(email = "owner@example.com") {
    const start = await page("/v1/auth/start", { email });
    expect(start.status).toBe(200);
    const { attempt } = await readJson<{ attempt: string }>(start);
    const verify = await page("/v1/auth/verify", { attempt, code: code(email) });
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  function enrollRequest(withSignature = true) {
    const raw = JSON.stringify({ v: 1, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), ...workspace });
    const at = time + ++nonce;
    const signature = sign(null, Buffer.from(signedPayload("POST", "/v1/enroll", at, createHash("sha256").update(raw).digest("hex"))), keys.privateKey).toString("base64");
    return fetch(`${url}/v1/enroll`, { method: "POST", body: raw, headers: { "content-type": "application/json", origin, ...(withSignature ? { "x-dusk-time": String(at), "x-dusk-signature": signature } : {}) } });
  }
  async function enroll() {
    const response = await enrollRequest();
    expect(response.status).toBe(200);
    return readJson<EnrollAnswer>(response);
  }
  async function claim(cookie: string) {
    const enrollment = await enroll();
    const response = await page("/v1/claim", { token: enrollment.claimUrl.split("#")[1] }, cookie);
    expect(response.status).toBe(200);
    return enrollment.workspaceId as string;
  }
  function signed(path: string, id: string, report?: unknown, settings: { time?: number; bad?: boolean; raw?: string } = {}) {
    const raw = settings.raw ?? (report === undefined ? "" : JSON.stringify(report));
    const method = report === undefined && settings.raw === undefined ? "GET" : "POST";
    const at = settings.time ?? time + ++nonce;
    const payload = signedPayload(method, path, at, createHash("sha256").update(raw).digest("hex"));
    const signature = sign(null, Buffer.from(payload), keys.privateKey).toString("base64");
    const headers = { "content-type": "application/json", "x-dusk-workspace": id, "x-dusk-time": String(at), "x-dusk-signature": settings.bad ? Buffer.alloc(64).toString("base64") : signature };
    return { raw, method, headers, send: () => fetch(`${url}${path}`, { method, headers, ...(method === "POST" ? { body: raw } : {}) }) };
  }
  function report(seq = 1): WorkspaceReport { return { v: 1, seq, at: time, workspace }; }

  it("signs in, persists only a web token hash, and signs out", async () => {
    const cookie = await login();
    expect((await readJson<{ account: Account; code: string }>(page("/v1/me", undefined, cookie))).account.email).toBe("owner@example.com");
    app.close();
    const saved = readFileSync(`${dataDir}/auth.json`, "utf8");
    expect(saved).not.toContain(cookie.split("=")[1]);
    expect(saved).not.toContain("omc_");
    expect(JSON.parse(saved).sessions[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== "win32") expect(statSync(`${dataDir}/auth.json`).mode & 0o777).toBe(0o600);
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir });
    server.removeAllListeners("request");
    server.on("request", app.handle);
    expect((await page("/v1/me", undefined, cookie)).status).toBe(200);
    expect((await page("/v1/auth/signout", {}, cookie)).headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await readJson<{ account: Account; code: string }>(page("/v1/me", undefined, cookie))).code).toBe("signed_out");
  });

  it("maps a wrong code and enforces JSON, Origin and sign-in limits", async () => {
    const start = await readJson<{ attempt: string }>(page("/v1/auth/start", { email: "owner@example.com" }));
    const wrong = code("owner@example.com") === "00000000" ? "11111111" : "00000000";
    const response = await page("/v1/auth/verify", { attempt: start.attempt, code: wrong });
    expect(response.status).toBe(400);
    expect((await readJson<{ code: string }>(response)).code).toBe("wrong_code");
    expect((await fetch(`${url}/v1/auth/start`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(`${url}/v1/auth/start`, { method: "POST", headers: { "content-type": "application/json", origin: "https://elsewhere.test" }, body: "{}" })).status).toBe(403);
    for (let i = 0; i < AUTH_LIMITS.startsPerIp - 1; i++) expect((await page("/v1/auth/start", { email: `owner${i}@example.com` })).status).toBe(200);
    expect((await page("/v1/auth/start", { email: "owner@example.com" })).status).toBe(429);
  });

  it("holds a PUT to the same JSON and Origin rule as every other change", async () => {
    const cookie = await login();
    const put = (headers: Record<string, string>) => fetch(`${url}/v1/account/analytics`, { method: "PUT", headers: { cookie, [CSRF_HEADER]: csrf.get(cookie) ?? "", ...headers }, body: JSON.stringify({ optOut: true }) });
    const foreign = await put({ "content-type": "application/json", origin: "https://elsewhere.test" });
    expect(foreign.status).toBe(403);
    expect((await readJson<{ code: string }>(foreign)).code).toBe("forbidden");
    expect((await put({ "content-type": "text/plain", origin })).status).toBe(403);
  });
  it("sets secure cookie attributes for https and expires web sessions after 30 days", async () => {
    app.close();
    app = createDashboardApp({ dataDir, publicUrl: "https://dashboard.test", mailer, staticDir, now: () => time });
    server.removeAllListeners("request");
    server.on("request", app.handle);
    const start = await readJson<{ attempt: string }>(fetch(`${url}/v1/auth/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.com" }) }));
    const verified = await fetch(`${url}/v1/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attempt: start.attempt, code: code("owner@example.com") }) });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get("set-cookie")!;
    expect(cookie).toContain("; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure");
    time += 30 * 24 * 60 * 60_000 + 1;
    expect((await fetch(`${url}/v1/me`, { headers: { cookie: cookie.split(";")[0]! } })).status).toBe(401);
  });

  it("claims once, rotates a lost claim, expires claims and preserves claimed enrollment", async () => {
    const cookie = await login();
    const first = await enroll();
    const second = await enroll();
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.claimUrl).not.toBe(first.claimUrl);
    expect((await page("/v1/claim", { token: first.claimUrl.split("#")[1] }, cookie)).status).toBe(404);
    time += CLAIM_TTL_MS + 1;
    expect((await page("/v1/claim", { token: second.claimUrl.split("#")[1] }, cookie)).status).toBe(404);
    const third = await enroll();
    const claimBody = { token: third.claimUrl.split("#")[1] };
    expect((await page("/v1/claim", claimBody, cookie)).status).toBe(200);
    expect((await page("/v1/claim", claimBody, cookie)).status).toBe(404);
    const claimed = await enroll();
    expect(claimed.workspaceId).toBe(first.workspaceId);
    expect(claimed.claimExpiresAt).toBe(0);
    expect(claimed.claimUrl).toBe(`${origin}/?workspace=${first.workspaceId}`);
  });

  it("lets only the key's holder replace a workspace's claim link", async () => {
    const cookie = await login();
    expect((await enrollRequest(false)).status).toBe(200);
    const first = await enroll();
    expect((await enrollRequest(false)).status).toBe(401);
    expect((await page("/v1/claim", { token: first.claimUrl.split("#")[1] }, cookie)).status).toBe(200);
  });

  it("rejects other key types and removes unclaimed enrollments after 24 hours", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect((await page("/v1/enroll", { v: 1, ...workspace, publicKey: rsa.publicKey.export({ type: "spki", format: "der" }).toString("base64") })).status).toBe(400);
    const first = await enroll();
    time += 24 * 60 * 60_000 + 1;
    expect((await signed("/v1/report", first.workspaceId, report()).send()).status).toBe(401);
    expect((await enroll()).workspaceId).not.toBe(first.workspaceId);
  });

  it("calls a cloud pinned only when six covered hours are all past 90% cpu", () => {
    const at = 10 * 3_600_000, every = (cpu: (i: number) => number, from = 0) => Array.from({ length: 121 }, (_, i) => ({ t: at - 6 * 3_600_000 + from + i * 180_000, cpu: cpu(i) }));
    expect(cpuPinned(every(() => 97), at)).toBe(true);
    expect(cpuPinned(every(i => i === 60 ? 40 : 97), at)).toBe(false);
    // a cloud that woke an hour ago has not been watched long enough
    expect(cpuPinned(every(() => 97, 3_600_000).filter(s => s.t <= at), at)).toBe(false);
    expect(cpuPinned([], at)).toBe(false);
  });

  it("bounds unclaimed workspaces, computers per account and reports per workspace", async () => {
    const saved = { ...WORKSPACE_LIMITS };
    try {
      Object.assign(WORKSPACE_LIMITS, { unclaimed: 2, perAccount: 1, reportsPerHour: 3 });
      const cookie = await login();
      const id = await claim(cookie), own = keys;
      // the second computer for the same account is refused, and its claim link stays usable once one is removed
      keys = generateKeyPairSync("ed25519");
      const second = await enroll();
      const refused = await page("/v1/claim", { token: second.claimUrl.split("#")[1] }, cookie);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "too_many_workspaces" });
      keys = generateKeyPairSync("ed25519");
      await enroll();
      // two unclaimed already: a third new key waits
      keys = generateKeyPairSync("ed25519");
      const busy = await enrollRequest();
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({ code: "busy" });
      // a workspace that reports too often hears 429 and nothing is written
      keys = own;
      for (let seq = 1; seq <= 3; seq++) expect((await signed("/v1/report", id, report(seq)).send()).status).toBe(200);
      expect((await signed("/v1/report", id, report(4)).send()).status).toBe(429);
      time += 3_600_000;
      expect((await signed("/v1/report", id, report(5)).send()).status).toBe(200);
    } finally { Object.assign(WORKSPACE_LIMITS, saved); }
  });

  it("keeps the app's help-improve switch and the account's one setting, both ways", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    const answer = async (seq: number, extra: object = {}) => readJson<{ usageOptOut?: boolean }>(signed("/v1/report", id, { ...report(seq), ...extra }).send());
    expect((await answer(1)).usageOptOut).toBe(false);
    // the app turned it off: the account's switch follows, and the answer says so
    expect((await answer(2, { usageOptOut: true })).usageOptOut).toBe(true);
    const sharing = async () => (await readJson<{ optOut: boolean }>(fetch(`${url}/v1/account/analytics`, { headers: { cookie } }))).optOut;
    expect(await sharing()).toBe(true);
    // a report that says nothing leaves it off; the app turned it back on
    expect((await answer(3)).usageOptOut).toBe(true);
    expect((await answer(4, { usageOptOut: false })).usageOptOut).toBe(false);
    expect(await sharing()).toBe(false);
    // the account's own page turns it off: the next answer tells the app
    const put = await fetch(`${url}/v1/account/analytics`, { method: "PUT", headers: { cookie, [CSRF_HEADER]: csrf.get(cookie) ?? "", "content-type": "application/json", origin }, body: JSON.stringify({ optOut: true }) });
    expect(put.status).toBe(200);
    expect((await answer(5)).usageOptOut).toBe(true);
    // a malformed value is dropped like any bad section
    expect((await answer(6, { usageOptOut: "yes" })).usageOptOut).toBe(true);
  });

  it("stores sections independently, reports live freshness, and restores sections from disk", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    expect((await signed("/v1/report", id, { ...report(), machine, bots: [bot] }).send()).status).toBe(200);
    time += 5000;
    expect((await signed("/v1/report", id, { ...report(2), machine: { bad: true }, activity: { bad: true } }).send()).status).toBe(200);
    let detail = await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie));
    expect(detail.workspace.freshness).toBe("live");
    expect(detail.report!.machine).toEqual(machine);
    expect(detail.report!.bots).toEqual([bot]);
    expect(detail.sectionAt.machine).toBe(time - 5000);
    expect(detail.report!.activity).toBeUndefined();
    expect(detail.history).toEqual([{ t: time - 5000, cpu: 25, mem: 50, rx: 10, tx: 20 }]);
    app.close();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir, now: () => time });
    server.removeAllListeners("request");
    server.on("request", app.handle);
    detail = await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie));
    expect(detail.report!.machine).toEqual(machine);
    expect(detail.sectionAt.machine).toBe(time - 5000);
    expect(detail.history).toEqual([]);
  });

  it("keeps a two-minute pulse per workspace and answers only the owner with samples after a time", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    expect(await readJson(page(`/v1/workspaces/${id}/pulse`, undefined, cookie))).toEqual({ v: 1, intervalMs: PULSE_INTERVAL_MS, samples: [] });
    expect((await signed("/v1/report", id, { ...report(), machine }).send()).status).toBe(200);
    expect((await readJson<PulseAnswer>(page(`/v1/workspaces/${id}/pulse`, undefined, cookie))).samples).toEqual([{ t: time, cpu: 25, mem: 50 }]);
    time += 5000;
    const samples = Array.from({ length: PULSE_SIZE + 5 }, (_, i) => ({ t: time - (PULSE_SIZE + 5 - i) * PULSE_INTERVAL_MS, cpu: i, mem: 40 }));
    expect((await signed("/v1/report", id, { ...report(2), machine, pulse: [...samples, { t: time, cpu: 400, mem: -3 }, { t: "x", cpu: 1, mem: 1 }] }).send()).status).toBe(200);
    const all = await readJson<PulseAnswer>(page(`/v1/workspaces/${id}/pulse`, undefined, cookie));
    expect(all.samples).toHaveLength(PULSE_SIZE);
    expect(all.samples.at(-1)).toEqual({ t: time, cpu: 100, mem: 0 });
    expect(all.samples[0]!.t).toBe(samples[6]!.t);
    const after = all.samples.at(-3)!.t;
    expect((await readJson<PulseAnswer>(page(`/v1/workspaces/${id}/pulse?after=${after}`, undefined, cookie))).samples.map(s => s.t)).toEqual(all.samples.slice(-2).map(s => s.t));
    time += 5000;
    expect((await signed("/v1/report", id, { ...report(3), machine, pulse: [samples[0]] }).send()).status).toBe(200);
    time += 5000;
    expect((await signed("/v1/report", id, { ...report(4), machine }).send()).status).toBe(200);
    expect((await readJson<PulseAnswer>(page(`/v1/workspaces/${id}/pulse?after=${time - 10_000}`, undefined, cookie))).samples).toEqual([]);
    expect((await page(`/v1/workspaces/${id}/pulse`, undefined, await login("other@example.com"))).status).toBe(404);
    expect((await page(`/v1/workspaces/${id}/pulse`)).status).toBe(401);
  });

  it("refuses bad signatures, stale times, replays, old sequences and oversized reports", async () => {
    const { workspaceId: id } = await enroll();
    expect((await signed("/v1/report", id, report(), { bad: true }).send()).status).toBe(401);
    const stale = await signed("/v1/report", id, report(), { time: time - SIGNATURE_SKEW_MS - 1 }).send();
    expect(stale.status).toBe(401);
    expect((await readJson<{ code: string }>(stale)).code).toBe("stale_time");
    const valid = signed("/v1/report", id, report());
    expect((await valid.send()).status).toBe(200);
    expect((await readJson<{ code: string }>(valid.send())).code).toBe("replay");
    expect((await signed("/v1/report", id, report()).send()).status).toBe(409);
    time += 10 * 60_000 + 1;
    expect((await signed("/v1/report", id, report()).send()).status).toBe(200);
    const oversized = await signed("/v1/report", id, undefined, { raw: "x".repeat(MAX_REPORT_BYTES + 1) }).send();
    expect(oversized.status).toBe(413);
    const chunked = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${url}/v1/report`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, response => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.on("error", reject);
      request.write("x".repeat(MAX_REPORT_BYTES + 1));
      request.end();
    });
    expect(chunked).toBe(413);
    const wait = signed("/v1/wait?wait=1", id);
    const tampered = await fetch(`${url}/v1/wait?wait=2`, { headers: wait.headers });
    expect(tampered.status).toBe(401);
  });

  it("hides workspaces from other accounts and forgets their keys", async () => {
    const owner = await login();
    const id = await claim(owner);
    const other = await login("other@example.com");
    expect((await readJson<{ workspaces: WorkspaceSummary[] }>(page("/v1/workspaces", undefined, other))).workspaces).toEqual([]);
    expect((await page(`/v1/workspaces/${id}`, undefined, other)).status).toBe(404);
    expect((await page(`/v1/workspaces/${id}/commands`, { kind: "computer.wake", target: "bot1" }, other)).status).toBe(404);
    expect((await page(`/v1/workspaces/${id}`, { name: "My Mac" }, owner, "PATCH")).status).toBe(200);
    expect((await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, owner))).workspace.name).toBe("My Mac");
    expect((await page(`/v1/workspaces/${id}`, {}, owner, "DELETE")).status).toBe(200);
    expect((await signed("/v1/report", id, report()).send()).status).toBe(401);
  });

  it("delivers commands through reports, confirms results and expires unanswered commands", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    const queued = await readJson<{ command: CommandView }>(page(`/v1/workspaces/${id}/commands`, { kind: "computer.wake", target: "bot1" }, cookie));
    expect(queued.command.status).toBe("queued");
    const delivered = await readJson<ReportAnswer>(signed("/v1/report", id, report()).send());
    expect(delivered.commands[0].id).toBe(queued.command.id);
    expect(delivered.commands[0]).not.toHaveProperty("status");
    expect((await readJson<ReportAnswer>(signed("/v1/report", id, report(2)).send())).commands).toEqual([]);
    // an answer can be lost on a connection the workspace dropped: unanswered, it goes out again
    time += 10_000;
    expect((await readJson<ReportAnswer>(signed("/v1/wait?wait=25", id).send())).commands.map(command => command.id)).toEqual([queued.command.id]);
    expect((await readJson<ReportAnswer>(signed("/v1/wait?wait=1", id).send())).commands).toEqual([]);
    expect((await readJson<ReportAnswer>(signed("/v1/report", id, { ...report(3), results: [{ id: queued.command.id, ok: true, message: "Awake.", at: time }] }).send())).commands).toEqual([]);
    let detail = await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie));
    expect(detail.commands[0]).toMatchObject({ status: "done", message: "Awake.", doneAt: time });
    await page(`/v1/workspaces/${id}/commands`, { kind: "phone.revoke", target: "phone1" }, cookie);
    await signed("/v1/report", id, report(4)).send();
    time += COMMAND_TTL_MS + 1;
    detail = await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie));
    expect(detail.commands[1].status).toBe("expired");
  });

  it("keeps a workspace and its pending commands through a restart, and tells a cut-off wait only that it is closing", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    expect((await signed("/v1/report", id, report()).send()).status).toBe(200);
    const sent = await readJson<{ command: CommandView }>(page(`/v1/workspaces/${id}/commands`, { kind: "app.connect", target: "gmail" }, cookie));
    expect((await readJson<ReportAnswer>(signed("/v1/report", id, report(2)).send())).commands.map(command => command.id)).toEqual([sent.command.id]);
    const queued = await readJson<{ command: CommandView }>(page(`/v1/workspaces/${id}/commands`, { kind: "computer.wake", target: "bot1" }, cookie));
    expect(queued.command).not.toHaveProperty("workspaceId");
    const waiting = signed("/v1/wait?wait=25", id);
    // the wait is answered at once (a command is queued); open a second one to be cut off by the restart
    expect((await waiting.send()).status).toBe(200);
    const cut = signed("/v1/wait?wait=25", id).send();
    await pause(25);
    app.close();
    const answer = await cut;
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ code: "closed" });
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir, now: () => time });
    server.removeAllListeners("request");
    server.on("request", app.handle);
    // the fresh process knows the workspace, and sends again both what was queued and what was sent but never answered
    const resent = await readJson<ReportAnswer>(signed("/v1/wait?wait=25", id).send());
    expect(resent.commands.map(command => command.id).sort()).toEqual([sent.command.id, queued.command.id].sort());
    expect((await signed("/v1/report", id, { ...report(3), results: [{ id: sent.command.id, ok: true, message: "Sign-in is ready.", at: time, url: "https://connect.composio.dev/link/fixture" }] }).send()).status).toBe(200);
    const detail = await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie));
    expect(detail.commands.find(command => command.id === sent.command.id)).toEqual(expect.objectContaining({ status: "done", url: "https://connect.composio.dev/link/fixture" }));
    expect(detail.commands.every(command => !("workspaceId" in command) && !("purgeAt" in command))).toBe(true);
    // it reported moments ago, so it still counts as awake for a sign-in
    expect((await page(`/v1/workspaces/${id}/commands`, { kind: "app.connect", target: "slack" }, cookie)).status).toBe(200);
    // finished results go once they are stale, from memory and from the store
    time += 2 * COMMAND_TTL_MS + 1;
    expect((await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie))).commands).toEqual([]);
    app.close();
    expect(JSON.parse(readFileSync(`${dataDir}/state.json`, "utf8")).commands).toEqual([]);
  });

  it("starts app sign-ins only for the owner of a workspace that is awake, and shows its apps", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    const connect = (body: object, who = cookie) => page(`/v1/workspaces/${id}/commands`, body, who);
    const asleep = await connect({ kind: "app.connect", target: "gmail" });
    expect(asleep.status).toBe(409);
    expect(await readJson(asleep)).toMatchObject({ code: "workspace_offline", error: expect.stringContaining("not answering") });
    await signed("/v1/report", id, { ...report(), apps: { available: true, complete: true, services: [{ slug: "github", connected: true, pending: false }, { slug: "linear", connected: false, pending: true }, { slug: "notion", connected: true, pending: false, via: "app" }] } }).send();
    expect(await readJson(page("/v1/connectors", undefined, cookie))).toEqual({ byWorkspace: { [id]: ["github", "notion"] }, inApp: { [id]: ["notion"] }, pending: { [id]: ["linear"] }, available: { [id]: true }, at: { [id]: time } });
    expect((await connect({ kind: "app.connect", target: "../admin" })).status).toBe(400);
    const stranger = await login("stranger@example.com");
    expect((await connect({ kind: "app.connect", target: "gmail" }, stranger)).status).toBe(404);
    expect(await readJson(page("/v1/connectors", undefined, stranger))).toEqual({ byWorkspace: {}, inApp: {}, pending: {}, available: {}, at: {} });
    const forged = await fetch(`${url}/v1/workspaces/${id}/commands`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ kind: "app.connect", target: "gmail" }) });
    expect(forged.status).toBe(403);
    const queued = await readJson<{ command: CommandView }>(connect({ kind: "app.connect", target: "Gmail" }));
    expect(queued.command).toMatchObject({ kind: "app.connect", target: "gmail", status: "queued" });
    const delivered = await readJson<ReportAnswer>(signed("/v1/report", id, report(2)).send());
    expect(delivered.commands.map(command => command.target)).toEqual(["gmail"]);
    const link = "https://connect.composio.dev/link/fixture";
    await signed("/v1/report", id, { ...report(3), results: [{ id: queued.command.id, ok: true, message: "Sign-in is ready.", at: time, url: link }],
      apps: { available: true, complete: true, services: [{ slug: "gmail", connected: true, pending: false }] } }).send();
    const detail = await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie));
    expect(detail.commands.find(command => command.id === queued.command.id)).toMatchObject({ status: "done", url: link });
    expect((await readJson<{ byWorkspace: Record<string, string[]> }>(page("/v1/connectors", undefined, cookie))).byWorkspace[id]).toEqual(["gmail"]);
    const unsafe = await readJson<{ command: CommandView }>(connect({ kind: "app.connect", target: "slack" }));
    await signed("/v1/report", id, { ...report(4), results: [{ id: unsafe.command.id, ok: true, message: "Sign-in is ready.", at: time, url: "javascript:alert(1)" }] }).send();
    expect((await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie))).commands.find(command => command.id === unsafe.command.id)?.url).toBeUndefined();
    time += 46_000;
    expect((await connect({ kind: "app.disconnect", target: "gmail" })).status).toBe(409);
  });

  it("sends a website sign-in back to the apps page with a one-time state only its account can take", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    await signed("/v1/report", id, report()).send();
    const queued = await readJson<{ command: CommandView }>(page(`/v1/workspaces/${id}/commands`, { kind: "app.connect", target: "gmail", returnHere: true }, cookie));
    const delivered = await readJson<ReportAnswer>(signed("/v1/report", id, report(2)).send());
    const callback = new URL(delivered.commands[0]!.callback!);
    expect(`${callback.origin}${callback.pathname}`).toBe(`${origin}/connectors`);
    const state = callback.searchParams.get("connect")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // a plain connect carries no callback
    await readJson(page(`/v1/workspaces/${id}/commands`, { kind: "app.connect", target: "slack" }, cookie));
    expect((await readJson<ReportAnswer>(signed("/v1/report", id, report(3)).send())).commands.map((command) => command.callback)).toEqual([undefined]);
    await signed("/v1/report", id, { ...report(4), results: [{ id: queued.command.id, ok: true, message: "Sign-in is ready.", at: time, url: "https://connect.composio.dev/link/x", returnsHere: true }] }).send();
    expect((await readJson<WorkspaceDetail>(page(`/v1/workspaces/${id}`, undefined, cookie))).commands.find((command) => command.id === queued.command.id))
      .toMatchObject({ status: "done", url: "https://connect.composio.dev/link/x", returnsHere: true });

    const stranger = await login("stranger@example.com");
    expect((await page("/v1/connect/finish", { state, status: "success" }, stranger)).status).toBe(404);
    expect(await readJson(page("/v1/connect/finish", { state, status: "success" }, cookie))).toEqual({ workspaceId: id, slug: "gmail", outcome: "signed-in" });
    expect((await page("/v1/connect/finish", { state, status: "success" }, cookie)).status).toBe(404);
    const forged = await fetch(`${url}/v1/connect/finish`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: "https://evil.example" }, body: JSON.stringify({ state }) });
    expect(forged.status).toBe(403);

    const cancelled = await readJson<{ command: CommandView }>(page(`/v1/workspaces/${id}/commands`, { kind: "app.connect", target: "notion", returnHere: true }, cookie));
    const later = (await readJson<ReportAnswer>(signed("/v1/report", id, report(5)).send())).commands.find((command) => command.id === cancelled.command.id)!;
    const laterState = new URL(later.callback!).searchParams.get("connect");
    expect(await readJson(page("/v1/connect/finish", { state: laterState, status: "failed" }, cookie))).toMatchObject({ slug: "notion", outcome: "cancelled" });
    const stale = await readJson<{ command: CommandView }>(page(`/v1/workspaces/${id}/commands`, { kind: "app.connect", target: "linear", returnHere: true }, cookie));
    const staleState = new URL((await readJson<ReportAnswer>(signed("/v1/report", id, report(6)).send())).commands.find((command) => command.id === stale.command.id)!.callback!).searchParams.get("connect");
    time += 10 * 60_000 + 1;
    expect(await readJson(page("/v1/connect/finish", { state: staleState, status: "success" }, cookie))).toMatchObject({ code: "connect_expired" });
  });

  it("wakes a pending signed wait immediately for a command and for watching", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    const pending = signed("/v1/wait?wait=25", id).send();
    await pause(25);
    const queued = await readJson<{ command: CommandView }>(page(`/v1/workspaces/${id}/commands`, { kind: "computer.sleep", target: "bot1" }, cookie));
    const response = await Promise.race([pending, pause(1000).then(() => { throw new Error("Command did not wake wait."); })]);
    expect((await readJson<ReportAnswer>(response)).commands[0].id).toBe(queued.command.id);
    await signed("/v1/report", id, { ...report(), results: [{ id: queued.command.id, ok: true, message: "Asleep.", at: time }] }).send();
    const waiting = signed("/v1/wait?wait=25", id).send();
    await pause(25);
    await page("/v1/workspaces", undefined, cookie);
    const watched = await Promise.race([waiting, pause(1000).then(() => { throw new Error("Watching did not wake wait."); })]);
    expect((await readJson<ReportAnswer>(watched)).nextReportMs).toBe(FAST_REPORT_MS);
    const replacement = signed("/v1/wait?wait=25", id).send();
    await pause(25);
    const newest = signed("/v1/wait?wait=1", id).send();
    expect((await replacement).status).toBe(200);
    expect((await newest).status).toBe(200);
    time += 20_001;
    const rewatch = signed("/v1/wait?wait=25", id).send();
    await pause(25);
    await page("/v1/workspaces", undefined, cookie);
    const resumed = await Promise.race([rewatch, pause(1000).then(() => { throw new Error("Watching did not resume wait."); })]);
    expect((await readJson<ReportAnswer>(resumed)).watching).toBe(true);
  });

  it("switches report cadence as watching starts and expires", async () => {
    const cookie = await login();
    const id = await claim(cookie);
    expect((await readJson<ReportAnswer>(signed("/v1/report", id, report()).send())).nextReportMs).toBe(SLOW_REPORT_MS);
    await page("/v1/workspaces", undefined, cookie);
    expect((await readJson<ReportAnswer>(signed("/v1/report", id, report(2)).send())).watching).toBe(true);
    time += 20_001;
    expect((await readJson<ReportAnswer>(signed("/v1/report", id, report(3)).send())).nextReportMs).toBe(SLOW_REPORT_MS);
  });

  it("allows the page's own inline theme script by hash and nothing else inline", () => {
    const html = "<head><script>document.documentElement.dataset.theme = 'light';</script><script type=\"module\" src=\"/assets/a.js\"></script></head>";
    const policy = pagePolicy(html);
    const hash = createHash("sha256").update("document.documentElement.dataset.theme = 'light';").digest("base64");
    expect(policy).toContain(`script-src 'self' 'sha256-${hash}';`);
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self'");
  });

  it("answers a health check while its data folder is writable", async () => {
    const health = await page("/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: null });
    expect(health.headers.get("cache-control")).toBe("no-store");
  });

  it("serves Metal's MCP client metadata document under the address it names as its client id", async () => {
    const answer = await page("/v1/oauth/mcp-client.json");
    expect(answer.status).toBe(200);
    const body = await answer.json();
    expect(body).toMatchObject({ client_id: "https://dusk.bot/v1/oauth/mcp-client.json", redirect_uris: ["http://127.0.0.1:47615/mcp-oauth/callback"], token_endpoint_auth_method: "none" });
    expect(answer.headers.get("content-type")).toContain("application/json");
  });

  it("exports the signed-in account's own data with no tokens or keys", async () => {
    expect((await page("/v1/account/export")).status).toBe(401);
    const cookie = await login();
    const id = await claim(cookie);
    const other = await login("other@example.com");
    const answer = await page("/v1/account/export", undefined, cookie);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-disposition")).toMatch(/^attachment; filename="metal-account-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await answer.text(), data = JSON.parse(text);
    expect(data.account.email).toBe("owner@example.com");
    expect(data.workspaces.map((ws: { id: string }) => ws.id)).toEqual([id]);
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(Object.keys(data).sort()).toEqual(["account", "cloudDesktops", "exportedAt", "identities", "notifications", "onboarded", "payments", "sessions", "subscriptions", "v", "workspaces"]);
    for (const secret of ["tokenHash", "publicKey", "claimHash", "bootstrapSecret", cookie.split("=")[1]!, "other@example.com"]) expect(text).not.toContain(secret);
    expect(other).toBeTruthy();
  });

  it("forwards a page error through the scrubbing reporter, only from its own origin", async () => {
    const captured: Error[] = [];
    const reporter = { enabled: true, capture: (error: unknown) => { captured.push(error as Error); return "id"; }, flush: () => 0 };
    app.close();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir, now: () => time, errors: { service: reporter, page: reporter } });
    server.removeAllListeners("request");
    server.on("request", app.handle);
    const sent = await page("/v1/client-error", { type: "TypeError", message: "x is undefined", stack: "at a (https://dusk.bot/assets/i.js:1:2)", page: "/billing" });
    expect(sent.status).toBe(204);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.name).toBe("TypeError");
    const foreign = await fetch(`${url}/v1/client-error`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    expect(foreign.status).toBe(403);
    expect(captured).toHaveLength(1);
  });

  it("serves discovery and html fallback, blocks traversal and dotfiles, and disables pages without staticDir", async () => {
    const discovery = await page("/.well-known/duskbot/dashboard");
    expect(await discovery.json()).toEqual({ v: 1, url: origin });
    expect(discovery.headers.get("cache-control")).toBe("no-store");
    const fallback = await page("/claim");
    expect(await fallback.text()).toContain("dashboard fixture");
    expect(fallback.headers.get("content-security-policy")).toBe(pagePolicy("<!doctype html><title>dashboard fixture</title>"));
    expect(fallback.headers.get("content-security-policy")).toContain("script-src 'self'; ");
    expect(fallback.headers.get("x-frame-options")).toBe("DENY");
    expect(fallback.headers.get("referrer-policy")).toBe("no-referrer");
    expect(fallback.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const head = await page("/claim", undefined, undefined, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(fallback.headers.get("cache-control")).toBe("no-cache");
    mkdirSync(`${staticDir}/assets`);
    writeFileSync(`${staticDir}/assets/app.js`, "document.title = 'fixture';");
    expect((await page("/assets/app.js")).headers.get("cache-control")).toContain("immutable");
    expect((await page("/.env")).status).toBe(404);
    const traversal = await new Promise<number>(resolve => {
      const request = httpRequest(`${url}/`, { path: "/assets/../.env" }, response => { response.resume(); resolve(response.statusCode!); });
      request.end();
    });
    expect(traversal).toBe(404);
    app.close();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null });
    server.removeAllListeners("request");
    server.on("request", app.handle);
    expect((await page("/claim")).status).toBe(404);
  });
});

it("bounds every report collection and drops malformed optional sections and unknown fields", () => {
  const many = <T>(entry: T, count: number) => Array.from({ length: count }, () => entry);
  const totals = { turns: 1, tokens: 2, costUsd: null };
  const parsed = parseWorkspaceReport({ v: 1, seq: 1, at: 100, workspace: { ...workspace, name: "n".repeat(500) }, secret: "dropped",
    machine: { ...machine, services: many({ id: "id", name: "service", state: "running", detail: null }, 30) },
    bots: many({ ...bot, id: "i".repeat(300), routines: many({ id: "r", name: "routine", schedule: "daily", paused: false, nextRunAt: null, lastRunAt: null }, 70) }, 220),
    computers: { provider: "none", computers: many({ id: "c", botId: null, botName: null, kind: "vps", name: "computer", state: "unknown", memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, lastUsedAt: null, alias: null }, 210) },
    activity: { from: "2026-01-01", to: "2026-12-31", timeZone: "UTC", days: many({ date: "2026-01-01", ...totals }, 500), byBot: many({ botId: "b", botName: "bot", ...totals }, 250), byModel: many({ model: "m", ...totals }, 110), totals },
    devices: { thisDevice: { label: "Fixture", kind: "server" }, link: null, phones: many({ id: "p", label: "phone", platform: null, pairedAt: null, lastSeenAt: null }, 60),
      sessions: many({ id: "s", label: "session", createdAt: null, lastSeenAt: null, scopes: ["read"] }, 120) },
    plans: { providers: many({ id: "plan", name: "plan", plan: null, ok: true, windows: many({ label: "week", usedPercent: 0, resetsAt: null }, 30) }, 30) },
    results: many({ id: "c", ok: false, message: null, at: 100 }, 60),
  })!;
  expect(parsed.workspace.name.length).toBe(120);
  expect(parsed.bots).toHaveLength(200);
  expect(parsed.bots![0]!.id.length).toBe(200);
  expect(parsed.bots![0]!.routines).toHaveLength(50);
  expect(parsed.computers!.computers).toHaveLength(200);
  expect(parsed.machine!.services).toHaveLength(20);
  expect(parsed.activity!.days).toHaveLength(400);
  expect(parsed.activity!.byBot).toHaveLength(200);
  expect(parsed.activity!.byModel).toHaveLength(100);
  expect(parsed.activity!.totals).toEqual({ turns: 1, tokens: 2, costUsd: null });
  expect(parsed.devices!.phones).toHaveLength(50);
  expect(parsed.devices!.sessions).toHaveLength(100);
  expect(parsed.results).toHaveLength(50);
  expect(parsed.plans!.providers).toHaveLength(20);
  expect(parsed.plans!.providers[0]!.windows).toHaveLength(20);
  expect(parsed).not.toHaveProperty("secret");
  expect(parseWorkspaceReport({ ...parsed, v: 2 })).toBeNull();
  expect(parseWorkspaceReport({ ...parsed, seq: -1 })).toBeNull();
  expect(parseWorkspaceReport({ ...parsed, at: Infinity })).toBeNull();
  expect(parseWorkspaceReport({ ...parsed, machine: { ...machine, memory: { usedBytes: -1, totalBytes: 100 } } })!.machine).toBeUndefined();
  expect(parseWorkspaceReport({ ...parsed, machine: { ...machine, cpu: { percent: NaN, load: [0, 0, 0] } } })!.machine).toBeUndefined();
  expect(parseWorkspaceReport({ ...parsed, bots: [null] })!.bots).toBeUndefined();
  expect(parseEnrollRequest({ v: 2 })).toBeNull();
});

it("keeps the token split on activity reports that carry one", () => {
  const split = { turns: 2, tokens: 100, costUsd: null, input: 30, output: 20, cacheRead: 45, cacheWrite: 5 };
  const activity = { from: "2026-01-01", to: "2026-01-02", timeZone: "UTC", days: [{ date: "2026-01-02", ...split }], byBot: [], byModel: [], totals: split };
  expect(parseWorkspaceReport({ v: 1, seq: 1, at: 100, workspace, activity })!.activity).toEqual(activity);
  expect(parseWorkspaceReport({ v: 1, seq: 1, at: 100, workspace, activity: { ...activity, totals: { ...split, cacheRead: -1 } } })!.activity).toBeUndefined();
});
