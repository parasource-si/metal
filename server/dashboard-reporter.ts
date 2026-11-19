import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_WATCH_MS, SIGNATURE_HEADERS, signedPayload } from "../shared/dashboard-protocol.ts";
import type { CommandResult, DashboardCommand, EnrollAnswer, EnrollRequest, ReportAnswer, WorkspaceReport } from "../shared/dashboard-protocol.ts";
import type { createDashboardCollector } from "./dashboard-report.ts";
import type { UsageReport } from "../shared/usage-signals.ts";
import type { PulseSample } from "../shared/machine-pulse.ts";

interface LinkState {
  v: 1;
  url: string;
  workspaceId: string;
  publicKey: string;
  privateKey: string;
  enrolledAt: number;
  claimed?: boolean;
}
export interface DashboardReporterDeps {
  dataDir: string;
  collect: ReturnType<typeof createDashboardCollector>;
  /** usage signals waiting for the next report (usage-signals.ts) */
  usage?: { take(): UsageReport | null; requeue(report: UsageReport): void };
  /** the "help improve Metal" switch, which is the account's switch too (usage-signals-switch.ts) */
  choice?: { pending(): boolean | null; pushed(value: boolean): void; fromAccount(optOut: boolean): unknown };
  /** recent cpu and memory samples; only those not yet sent ride a report, and only while someone watches */
  pulse?: { since(after: number): PulseSample[] };
  execute(command: DashboardCommand): Promise<CommandResult>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  /** how often the clock is read to notice a resume; tests shorten it */
  tickMs?: number;
  /** how long the dashboard may call this workspace unknown before it is checked and, if really gone, given up on */
  goneGraceMs?: number;
}
let sequence = Date.now();
const REMOVED = "This workspace was removed from the dashboard. Connect it again from the app.";
/** a wall clock this far past the tick means the machine was suspended (a dusk cloud sleeps when idle): requests open
 *  across a suspend never answer, so they are dropped and sent again at once */
const RESUME_JUMP_MS = 15_000;
/** "unknown workspace" can be a dashboard mid-restart; only after this long is it checked by enrolling again */
const GONE_GRACE_MS = 2 * 60_000;
class GoneError extends Error {}

/** the account service said no for a reason the person can act on (owned by another account, a limit): its words are kept */
export class EnrollRefusedError extends Error {}

export function createDashboardReporter(deps: DashboardReporterDeps) {
  const file = join(deps.dataDir, "dashboard-link.json"), fetcher = deps.fetch ?? fetch, now = deps.now ?? Date.now;
  let state: LinkState | null = null;
  let lastReportAt: number | null = null, lastError: string | null = null, watching = false;
  let running = false, generation = 0, removed = false, goneSince: number | null = null, goneCheck: Promise<void> | null = null;
  const goneGraceMs = deps.goneGraceMs ?? GONE_GRACE_MS;
  let wakeReport: (() => void) | undefined, urgent = false;
  const tickMs = deps.tickMs ?? 5_000;
  let clock: ReturnType<typeof setInterval> | undefined, lastTick = 0, resumes = 0;
  // a command changes devices or routines: the next report carries them at once
  let changed = false, appsWatchUntil = 0;
  const requests = new Set<AbortController>(), sleepers = new Set<() => void>();
  const results = new Map<string, CommandResult>(), executed = new Set<string>();
  let commands = Promise.resolve();
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as LinkState;
    if (saved.v === 1 && saved.url && saved.workspaceId && saved.publicKey && saved.privateKey) {
      createPrivateKey({ key: Buffer.from(saved.privateKey, "base64"), format: "der", type: "pkcs8" });
      state = saved;
      chmodSync(file, 0o600);
    }
  } catch {}

  function save(value: LinkState) {
    mkdirSync(deps.dataDir, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    } finally { try { unlinkSync(temporary); } catch {} }
  }
  function stop() {
    running = false;
    generation++;
    clearInterval(clock); clock = undefined;
    for (const request of requests) request.abort();
    for (const finish of Array.from(sleepers)) finish();
    wakeReport = undefined;
  }
  function requestReport() { urgent = true; wakeReport?.(); }
  function tick() {
    const at = now();
    if (at - lastTick > tickMs + RESUME_JUMP_MS) {
      resumes++;
      for (const request of requests) request.abort();
      requestReport();
    }
    lastTick = at;
  }
  function pause(ms: number, report = false): Promise<void> {
    if (report && urgent) { urgent = false; return Promise.resolve(); }
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); sleepers.delete(finish); if (wakeReport === finish) wakeReport = undefined; if (report) urgent = false; resolve(); };
      const timer = setTimeout(finish, ms);
      sleepers.add(finish);
      if (report) wakeReport = finish;
    });
  }
  async function request(method: string, path: string, body?: WorkspaceReport): Promise<ReportAnswer> {
    const linked = state!;
    const bytes = body ? JSON.stringify(body) : "", time = now();
    const target = new URL(`${linked.url}${path}`);
    const signature = sign(null, Buffer.from(signedPayload(method, `${target.pathname}${target.search}`, time, createHash("sha256").update(bytes).digest("hex"))),
      createPrivateKey({ key: Buffer.from(linked.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64");
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 35_000);
    requests.add(controller);
    try {
      const response = await fetcher(target.toString(), { method, redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", [SIGNATURE_HEADERS.workspace]: linked.workspaceId, [SIGNATURE_HEADERS.time]: String(time), [SIGNATURE_HEADERS.signature]: signature },
        ...(method === "GET" ? {} : { body: bytes }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { code?: string };
        if (response.status === 401 && /(?:workspace.*(?:unknown|removed|not_found|deleted)|(?:unknown|removed|deleted).*workspace)/i.test(error.code ?? ""))
          throw new GoneError(`Dashboard does not know this workspace (${response.status}).`);
        throw new Error(`Dashboard request failed (${response.status}).`);
      }
      goneSince = null;
      return await response.json() as ReportAnswer;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  function accept(answer: ReportAnswer, run: number) {
    const beganWatching = !watching && answer.watching;
    watching = answer.watching;
    if (beganWatching) requestReport();
    for (const command of answer.commands ?? []) {
      if (executed.has(command.id)) continue;
      executed.add(command.id);
      commands = commands.then(async () => {
        if (!running || generation !== run) return;
        let result: CommandResult;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (command.expiresAt <= now()) throw new Error("This command expired before it could run.");
          result = await Promise.race([deps.execute(command), new Promise<CommandResult>((_, reject) => {
            timer = setTimeout(() => reject(new Error("This command took too long to finish.")), 60_000);
          })]);
        } catch {
          result = { id: command.id, ok: false, message: command.expiresAt <= now() ? "This command expired before it could run." : "This command could not finish in time.", at: now() };
        } finally { clearTimeout(timer); }
        if (!running || generation !== run) return;
        results.set(command.id, { ...result, id: command.id });
        changed = true;
        if (command.kind.startsWith("app.")) appsWatchUntil = now() + APP_WATCH_MS;
        requestReport();
      });
    }
  }
  /** the dashboard called this workspace unknown. a restarting one can, so it is retried for a while; then enrolling
   *  again with the same key settles it: the same workspace means carry on, any other means it really was removed */
  function gone(run: number): Promise<void> {
    goneSince ??= now();
    if (now() - goneSince < goneGraceMs || !state) return Promise.resolve();
    goneCheck ??= (async () => {
      const linked = state!;
      try {
        const answer = await enroll(linked.url, linked);
        if (!running || generation !== run || state !== linked) return;
        if (answer.workspaceId === linked.workspaceId) { goneSince = null; deps.log?.("Dashboard knows this workspace again; reporting."); return; }
        removed = true; watching = false; lastError = REMOVED; stop();
      } catch { deps.log?.("Dashboard check failed; retrying."); }
    })().finally(() => { goneCheck = null; });
    return goneCheck;
  }
  function failure(loop: string) {
    if (!removed) lastError = "Could not reach the dashboard. Retrying shortly.";
    deps.log?.(`Dashboard ${loop} failed; retrying.`);
  }
  async function reports(run: number) {
    let backoff = 5000;
    let devicesAt: number | null = null, activityAt: number | null = null, plansAt: number | null = null, appsAt: number | null = null;
    let lastPlans: WorkspaceReport["plans"] | null;
    let pulseSent = 0, seen = resumes;
    while (running && generation === run) {
      try {
        const at = now(), pending = [...results.values()].slice(0, 50);
        const [machine, computers] = await Promise.all([deps.collect.machine(), deps.collect.computers()]);
        const report: WorkspaceReport = { v: 1, seq: ++sequence, at, workspace: deps.collect.workspace(), machine, computers, bots: deps.collect.bots(), results: pending };
        const fresh = changed; changed = false;
        if (fresh || devicesAt === null || at - devicesAt >= 30_000) report.devices = await deps.collect.devices();
        if (activityAt === null || at - activityAt >= 60_000) report.activity = await deps.collect.activity();
        const plans = await deps.collect.plans();
        const plansDue = plansAt === null || at - plansAt >= 300_000 || plans !== lastPlans;
        if (plansDue && plans) report.plans = plans;
        if (appsAt === null || at - appsAt >= 300_000 || at < appsWatchUntil) {
          const apps = await deps.collect.apps();
          if (apps) report.apps = apps;
        }
        if (!running || generation !== run) return;
        const usage = deps.usage?.take() ?? null;
        if (usage) report.usage = usage;
        const optOut = deps.choice?.pending() ?? null;
        if (optOut !== null) report.usageOptOut = optOut;
        const pulse = watching ? deps.pulse?.since(pulseSent) ?? [] : [];
        if (pulse.length) report.pulse = pulse;
        let answer: ReportAnswer;
        try { answer = await request("POST", "/v1/report", report); } catch (error) { if (usage) deps.usage?.requeue(usage); throw error; }
        if (!running || generation !== run) return;
        for (const result of pending) results.delete(result.id);
        if (report.devices) devicesAt = at;
        if (report.activity) activityAt = at;
        if (plansDue) { plansAt = at; lastPlans = plans; }
        if (report.apps) appsAt = at;
        if (pulse.length) pulseSent = pulse.at(-1)!.t;
        lastReportAt = now(); lastError = null; backoff = 5000;
        if (optOut !== null) deps.choice?.pushed(optOut);
        if (typeof answer.usageOptOut === "boolean") deps.choice?.fromAccount(answer.usageOptOut);
        accept(answer, run);
        await pause(Math.max(2000, Math.min(600_000, Number(answer.nextReportMs) || 180_000)), true);
      } catch (error) {
        if (!running || generation !== run) return;
        if (seen !== resumes) { seen = resumes; continue; }
        if (error instanceof GoneError) { await gone(run); if (!running || generation !== run) return; }
        failure("report"); await pause(backoff); backoff = Math.min(60_000, backoff * 2);
      }
    }
  }
  async function wait(run: number) {
    let backoff = 5000, seen = resumes;
    while (running && generation === run) {
      try {
        const answer = await request("GET", "/v1/wait?wait=25");
        if (!running || generation !== run) return;
        accept(answer, run); backoff = 5000;
        await pause(100);
      } catch (error) {
        if (!running || generation !== run) return;
        if (seen !== resumes) { seen = resumes; await pause(100); continue; }
        if (error instanceof GoneError) { await gone(run); if (!running || generation !== run) return; }
        failure("wait"); await pause(backoff); backoff = Math.min(60_000, backoff * 2);
      }
    }
  }
  function start() {
    if (running || !state || removed) return;
    running = true;
    const run = ++generation;
    lastTick = now();
    clock = setInterval(tick, tickMs);
    clock.unref?.();
    void reports(run); void wait(run);
  }
  /** a signed enrollment: with a grant it claims the workspace for that account; without one, a key the dashboard
   *  already knows gets its own workspace back */
  async function enroll(normalized: string, keys: { publicKey: string; privateKey: string }, enrollToken?: string): Promise<EnrollAnswer> {
    const workspace = deps.collect.workspace();
    const body: EnrollRequest = { v: 1, publicKey: keys.publicKey, name: workspace.name, kind: workspace.kind, version: workspace.version, ...(enrollToken === undefined ? {} : { enrollToken }) };
    const bytes = JSON.stringify(body), time = now();
    const headers: Record<string, string> = { "content-type": "application/json", [SIGNATURE_HEADERS.time]: String(time),
      [SIGNATURE_HEADERS.signature]: sign(null, Buffer.from(signedPayload("POST", new URL(`${normalized}/v1/enroll`).pathname, time, createHash("sha256").update(bytes).digest("hex"))),
        createPrivateKey({ key: Buffer.from(keys.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64") };
    const response = await fetcher(`${normalized}/v1/enroll`, { method: "POST", redirect: "error", headers, body: bytes, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: unknown; error?: unknown };
      // the service's own words for its limits (too many computers on the account, too many joining at once)
      if ((error.code === "too_many_workspaces" || error.code === "busy") && typeof error.error === "string") throw new EnrollRefusedError(error.error.slice(0, 200));
      if (response.status === 409) throw new EnrollRefusedError("This workspace belongs to another Dusk account. Remove it from that account's dashboard first.");
      throw new Error(`Dashboard enrollment failed (${response.status}).`);
    }
    const answer = await response.json() as EnrollAnswer;
    if (answer.v !== 1 || !answer.workspaceId || !answer.claimUrl || typeof answer.claimExpiresAt !== "number") throw new Error("The dashboard returned an invalid enrollment.");
    return answer;
  }
  async function link(url: string, { enrollToken }: { enrollToken?: string } = {}): Promise<EnrollAnswer> {
    const normalized = url.replace(/\/+$/, "");
    const keys = state?.url === normalized ? state : (() => {
      const pair = generateKeyPairSync("ed25519");
      return { publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") };
    })();
    const answer = await enroll(normalized, keys, enrollToken);
    const next: LinkState = { v: 1, url: normalized, workspaceId: answer.workspaceId, publicKey: keys.publicKey, privateKey: keys.privateKey, enrolledAt: now(), claimed: answer.claimExpiresAt === 0 };
    save(next); stop(); state = next; removed = false; goneSince = null; lastError = null; watching = false;
    results.clear(); executed.clear(); commands = Promise.resolve(); start();
    return answer;
  }
  async function forget() {
    stop(); state = null; removed = false; goneSince = null; watching = false; lastError = null; lastReportAt = null;
    results.clear(); executed.clear();
    try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return {
    status: () => ({ connected: state !== null && !removed, url: state?.url ?? null, workspaceId: state?.workspaceId ?? null, lastReportAt, lastError, watching }),
    link, forget, start, stop,
    /** the person changed the switch: tell the account now, not at the next report */
    syncChoice: requestReport,
  };
}
