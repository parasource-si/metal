// a local dashboard service for development and verification: a memory mailer, the service on a temporary
// data folder, an optional signed-in session and an optional demo workspace that reports made-up numbers.
//   node apps/dashboard/scripts/fixture.ts [--port 7480] [--email you@example.test] [--demo] [--team] [--session-file path] [--alerts someone@qa.dusk.test]
// --team buys the team plan for the account (fake payments); mail to @qa.dusk.test (invites, their codes) is printed, never sent
// the demo workspace is fixture data only; real workspaces connect from the app (POST /api/dashboard/link).
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FAST_REPORT_MS, SIGNATURE_HEADERS, signedPayload } from "../../../shared/dashboard-protocol.ts";
import type { BotReport, CommandResult, DashboardCommand, EnrollAnswer, ReportAnswer, WorkspaceReport } from "../../../shared/dashboard-protocol.ts";
import { createDashboardApp } from "../server/app.ts";
import { PULSE_INTERVAL_MS, PulseRing } from "../../../shared/machine-pulse.ts";
import { startFakeProviders } from "../server/auth/fake-providers.ts";
import { isTestAddress, memoryMailer } from "../server/auth/mail.ts";
import { CSRF_HEADER } from "../../../shared/account-api.ts";
import { memorySink } from "../server/analytics/sink.ts";
import { assertFixtureStore, seedAdminAuth, seedAdminData, seedWaitlist } from "./fixture-admin.ts";

// a fixture is local and made up: it never starts with a real database in its environment
assertFixtureStore();

const { values } = parseArgs({ options: { port: { type: "string", default: "7480" }, email: { type: "string", default: "sid@duskbot.test" }, demo: { type: "boolean", default: false }, team: { type: "boolean", default: false }, "session-file": { type: "string" }, alerts: { type: "string" } } });
// --alerts mails each new @devs report to a test address, which stays in this process (printed below)
if (values.alerts && !isTestAddress(values.alerts)) throw new Error("--alerts takes a test address (@qa.dusk.test) only.");
const port = Number(values.port);
const url = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "dusk-dashboard-"));
const providers = await startFakeProviders();
const mailer = memoryMailer();
const send = mailer.send;
mailer.send = async message => {
  await send(message);
  console.log(`code for ${message.to}: ${message.text.match(/\b\d{8}\b/)?.[0] ?? ""}`);
};
let csrfToken = "";
// --demo also makes the fixture's account the admin and fills the admin panel with made-up people, clouds and events
const seeded = values.demo ? seedAdminAuth(dataDir, Date.now()) : [];
const testMail = { readable: true, latest: () => null, keep(message: { to: string; subject: string; text: string }) {
  console.log(`test mail for ${message.to}: ${message.subject}${[message.text.match(/\b\d{8}\b/)?.[0], message.text.match(/https?:\/\/[^\s"'<>)]+/)?.[0]].filter(Boolean).map(v => ` | ${v}`).join("")}`);
} };
const app = createDashboardApp({ dataDir, publicUrl: url, mailer, testMail, oauth: providers.config, staticDir: decodeURIComponent(new URL("../dist", import.meta.url).pathname),
  analytics: { sink: memorySink(), waitlist: values.demo ? seedWaitlist(Date.now()) : null }, admin: { emails: values.demo ? [values.email] : [], env: {}, opsFixture: values.demo },
  bugReports: values.alerts ? { mail: { on: true, to: () => [values.alerts!], mailers: [mailer] } } : undefined });
const server = createServer(app.handle);
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

async function post(path: string, body: unknown, cookie?: string) {
  const res = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", origin: url, ...(cookie ? { cookie, [CSRF_HEADER]: csrfToken } : {}) }, body: JSON.stringify(body) });
  return { res, data: await res.json() as Record<string, unknown> };
}

const start = await post("/v1/auth/start", { email: values.email });
const code = mailer.outbox.at(-1)?.text.match(/\b\d{8}\b/)?.[0];
const verify = await post("/v1/auth/verify", { attempt: start.data.attempt, code });
csrfToken = String(verify.data.csrfToken ?? "");
const cookie = (verify.res.headers.get("set-cookie") ?? "").split(";")[0]!;
if (values["session-file"]) writeFileSync(values["session-file"], cookie, { mode: 0o600 });
console.log(JSON.stringify({ url, dataDir, signedIn: verify.res.ok, sessionFile: values["session-file"] ?? null }));

console.log("Google and Apple sign in instantly as local fake users.");

if (values.team) {
  const catalog = await (await fetch(`${url}/v1/billing/catalog`)).json() as { bundles: Array<{ id: string; cart: Record<string, unknown> }> };
  const cart = { ...catalog.bundles.find(bundle => bundle.id === "team")!.cart, interval: "month" };
  const checkout = await post("/v1/billing/checkout", { kind: "cart", cart, source: "fixture" }, cookie);
  const done = await post("/v1/billing/fake/complete", { checkoutId: checkout.data.checkoutId }, cookie);
  console.log(`team plan: ${done.res.ok ? "active" : `failed ${JSON.stringify(checkout.data)}`}; its cloud starts in about a minute`);
}

if (values.demo) { await seedAdminData(app, seeded, Date.now()); console.log("admin panel: /admin"); void demo(cookie); }

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  await providers.close();
  app.close(); server.close(); server.closeAllConnections();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
});

// a pretend Mac, so the page can be worked on without a real workspace
async function demo(session: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const enroll = await post("/v1/enroll", { v: 1, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), name: "Demo Mac (fixture)", kind: "mac", version: "0.1.141" });
  const answer = enroll.data as unknown as EnrollAnswer;
  await post("/v1/claim", { token: new URL(answer.claimUrl).hash.slice(1) }, session);
  const now = Date.now(), day = 86_400_000;
  const bots: BotReport[] = [
    { id: "nova", name: "Nova", color: "blue", body: null, model: "gpt-5.5", engine: "Codex", computer: "vps", busy: false, lastActiveAt: now - 4 * 60_000, routines: [{ id: "r1", name: "Morning brief", schedule: "Every day at 8:00", paused: false, nextRunAt: now + 9 * 3600_000, lastRunAt: now - 15 * 3600_000 }] },
    { id: "quill", name: "Quill", color: "orange", body: null, model: "claude-opus-4.6", engine: "Claude", computer: null, busy: true, lastActiveAt: now, routines: [] },
    { id: "rivet", name: "Rivet", color: "green", body: null, model: "gpt-5.5", engine: "Codex", computer: "vps", busy: false, lastActiveAt: now - 2 * day, routines: [] },
  ];
  const days: NonNullable<WorkspaceReport["activity"]>["days"] = [];
  for (let i = 0; i < 200; i++) if ((i * 7) % 5 < 3) { const d = new Date(now - i * day); days.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, turns: 1 + ((i * 13) % 17), tokens: 4000 + ((i * 7919) % 90000), costUsd: 0.01 + ((i * 31) % 40) / 100 }); const t = days.at(-1)!.tokens, output = Math.round(t * 0.11), cacheRead = Math.round(t * 0.58), cacheWrite = Math.round(t * 0.03); Object.assign(days.at(-1)!, { input: t - output - cacheRead - cacheWrite, output, cacheRead, cacheWrite }); }
  const computers = new Map([["nova", "running"], ["rivet", "asleep"]] as Array<[string, "running" | "asleep"]>);
  let seq = Date.now();
  let results: CommandResult[] = [];
  const pulse = new PulseRing();
  let pulseSent = 0;
  const sample = () => { const t = Date.now(); pulse.push({ t, cpu: Math.round((22 + 14 * Math.sin(t / 17_000) + 9 * Math.sin(t / 5_300) + 4 * Math.random()) * 10) / 10, mem: Math.round((52 + 3 * Math.sin(t / 40_000)) * 10) / 10 }); };
  sample(); setInterval(sample, PULSE_INTERVAL_MS).unref();
  const signed = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const time = Date.now();
    const sig = sign(null, Buffer.from(signedPayload(method, path, time, createHash("sha256").update(raw).digest("hex"))), privateKey as KeyObject).toString("base64");
    const res = await fetch(url + path, { method, headers: { [SIGNATURE_HEADERS.workspace]: answer.workspaceId, [SIGNATURE_HEADERS.time]: String(time), [SIGNATURE_HEADERS.signature]: sig, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : raw });
    return await res.json() as ReportAnswer;
  };
  const run = (c: DashboardCommand): CommandResult => {
    if (c.kind === "computer.wake" || c.kind === "computer.sleep") {
      computers.set(c.target, c.kind === "computer.wake" ? "running" : "asleep");
      return { id: c.id, ok: true, message: `${bots.find((b) => b.id === c.target)?.name ?? c.target}'s computer is ${c.kind === "computer.wake" ? "waking up" : "asleep"}.`, at: Date.now() };
    }
    return { id: c.id, ok: true, message: "Done.", at: Date.now() };
  };
  const report = async () => {
    const t = Date.now();
    const body: WorkspaceReport = {
      v: 1, seq: seq++, at: t, workspace: { name: "Demo Mac (fixture)", kind: "mac", version: "0.1.141", platform: "darwin" },
      machine: { host: { hostname: "demo-mac", platform: "darwin", arch: "arm64", cpus: 10, cpuModel: "Apple M2 Pro" }, cpu: { percent: 18 + 12 * Math.sin(t / 9000), load: [2.1, 1.8, 1.6] }, memory: { usedBytes: 9.2e9 + 4e8 * Math.sin(t / 20000), totalBytes: 17.18e9 }, disk: { usedBytes: 312e9, totalBytes: 994e9, path: "/" }, network: { rxBytesPerSec: 90_000 + 60_000 * Math.abs(Math.sin(t / 7000)), txBytesPerSec: 24_000 }, uptimeSec: 3.2 * day / 1000, processUptimeSec: 7200, app: { version: "0.1.141", node: "24.11.0" }, update: { available: false, latest: null, how: null }, services: [{ id: "server", name: "Metal server", state: "running", detail: null }, { id: "docker", name: "Bot computers", state: "running", detail: null }] },
      computers: { provider: "vps", computers: [...computers].map(([id, state]) => ({ id: `dusk-${id}`, botId: id, botName: bots.find((b) => b.id === id)!.name, kind: "vps" as const, name: `dusk-${id}`, state, memoryBytes: state === "running" ? 812e6 : null, memoryLimitBytes: state === "running" ? 2147e6 : null, cpuPercent: null, lastUsedAt: t - 300_000, alias: null })) },
      bots,
      activity: { from: "", to: "", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, days, byBot: bots.map((b, i) => ({ botId: b.id, botName: b.name, turns: 120 - i * 40, tokens: 2e6 - i * 6e5, costUsd: 14 - i * 4 })), byModel: [{ model: "gpt-5.5", turns: 160, tokens: 2.6e6, costUsd: 18 }, { model: "claude-opus-4.6", turns: 80, tokens: 1.4e6, costUsd: 12 }], totals: { turns: 240, tokens: 4e6, costUsd: 30, input: 1_120_000, output: 440_000, cacheRead: 2_320_000, cacheWrite: 120_000 } },
      devices: { thisDevice: { label: "Demo Mac", kind: "mac" }, link: { mode: "direct", connected: true, url: null, since: t - 3600_000, detail: null }, phones: [{ id: "phone:demo", label: "iPhone 17", platform: "iOS", pairedAt: t - 20 * day, lastSeenAt: t - 600_000 }], sessions: [] },
      plans: { providers: [{ id: "codex", name: "Codex", plan: "Pro", ok: true, windows: [{ label: "Weekly", usedPercent: 42, resetsAt: t + 3 * day }] }] },
      results,
      ...(watching ? { pulse: pulse.since(pulseSent) } : {}),
    };
    results = [];
    if (body.pulse?.length) pulseSent = body.pulse.at(-1)!.t;
    return await signed("POST", "/v1/report", body);
  };
  let next = FAST_REPORT_MS;
  let watching = false;
  void (async () => { for (;;) { const a = await signed("GET", "/v1/wait?wait=25").catch(() => null); if (a?.commands.length) results.push(...a.commands.map(run)); if (a && (a.commands.length || (a.watching && !watching))) { watching = a.watching; await report().catch(() => {}); } else if (a) watching = a.watching; else await new Promise((r) => setTimeout(r, 2000)); } })();
  for (;;) { const a = await report().catch(() => null); next = a?.nextReportMs ?? 5000; await new Promise((r) => setTimeout(r, Math.min(next, 30_000))); }
}
