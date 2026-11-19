// the account dashboard protocol, version 1: what a workspace reports to the hosted dashboard service and the
// commands it takes back. transport-agnostic (plain https today, any relay that forwards it later), owner-only,
// never message contents or secrets. docs: apps/dashboard/README.md

import { cleanUsageReport, type UsageReport } from "./usage-signals.ts";
import { cleanSignal } from "./product-signals.ts";
import { parsePulse, type PulseSample } from "./machine-pulse.ts";

export const DASHBOARD_PROTOCOL = 1;

// the default hosted instance, overridable by workspace configuration.
export const DEFAULT_DASHBOARD_URL = "https://dusk.bot";

/** where a relay or a dashboard service says which dashboard it belongs to: `{ v: 1, url }` */
export const DASHBOARD_DISCOVERY_PATH = "/.well-known/duskbot/dashboard";

/** reports come every 5 s while someone has the dashboard open, every 3 minutes otherwise */
export const FAST_REPORT_MS = 5_000;
export const SLOW_REPORT_MS = 180_000;
/** a workspace whose last report is older than this shows as offline */
export const OFFLINE_AFTER_MS = 6 * 60_000;
/** a signed request whose time is further than this from the service's clock is refused */
export const SIGNATURE_SKEW_MS = 60_000;
/** a claim link lasts this long */
export const CLAIM_TTL_MS = 30 * 60_000;
/** a queued command a workspace has not picked up by then is dropped as expired */
export const COMMAND_TTL_MS = 10 * 60_000;
export const MAX_REPORT_BYTES = 512 * 1024;

export const SIGNATURE_HEADERS = { workspace: "x-dusk-workspace", time: "x-dusk-time", signature: "x-dusk-signature" } as const;

/** the exact bytes a workspace signs with its ed25519 key: method, path with query, time and the body's sha256 (of
 * the empty string for a GET) */
export function signedPayload(method: string, path: string, time: number, bodySha256Hex: string): string {
  return `dusk-dashboard-v${DASHBOARD_PROTOCOL}\n${method.toUpperCase()}\n${path}\n${time}\n${bodySha256Hex}`;
}

export type WorkspaceKind = "vps" | "mac" | "linux" | "windows";

export interface MachineReport {
  host: { hostname: string; platform: string; arch: string; cpus: number; cpuModel: string | null };
  cpu: { percent: number; load: [number, number, number] };
  memory: { usedBytes: number; totalBytes: number };
  disk: { usedBytes: number; totalBytes: number; path: string } | null;
  network: { rxBytesPerSec: number; txBytesPerSec: number } | null;
  uptimeSec: number;
  processUptimeSec: number;
  app: { version: string; node: string };
  update: { available: boolean; latest: string | null; how: string | null } | null;
  services: Array<{ id: string; name: string; state: "running" | "stopped" | "unknown"; detail: string | null }>;
}

export interface ComputerReport {
  id: string;
  botId: string | null;
  botName: string | null;
  kind: "vps" | "local-vm" | "team";
  name: string;
  state: "running" | "asleep" | "starting" | "missing" | "unknown";
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  cpuPercent: number | null;
  lastUsedAt: number | null;
  alias: string | null;
}

/** `running`: a run of it is under way now; older workspaces leave it out */
export interface RoutineReport { id: string; name: string; schedule: string; paused: boolean; nextRunAt: number | null; lastRunAt: number | null; running?: boolean }

export interface BotReport {
  id: string;
  name: string;
  /** a MausColor name; the dashboard falls back to blue for one it does not know */
  color: string;
  /** a BotBodyId; null is the default body */
  body: string | null;
  model: string | null;
  engine: string | null;
  computer: "vps" | "local-vm" | "team" | null;
  busy: boolean;
  lastActiveAt: number | null;
  routines: RoutineReport[];
}

/**
 * `tokens` is everything; the split (input without cache, output, cache read, cache write) adds up to it.
 * workspaces from before the split leave those four out.
 */
export interface ActivityTotals { turns: number; tokens: number; costUsd: number | null; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

export interface ActivityReport {
  from: string;
  to: string;
  timeZone: string;
  /** only days with activity, YYYY-MM-DD in the workspace's time zone */
  days: Array<{ date: string } & ActivityTotals>;
  byBot: Array<{ botId: string; botName: string } & ActivityTotals>;
  byModel: Array<{ model: string } & ActivityTotals>;
  totals: ActivityTotals;
}

export interface DevicesReport {
  thisDevice: { label: string; kind: "mac" | "linux" | "windows" | "server" };
  link: { mode: "direct" | "relay" | "off"; connected: boolean; url: string | null; since: number | null; detail: string | null } | null;
  phones: Array<{ id: string; label: string; platform: string | null; pairedAt: number | null; lastSeenAt: number | null }>;
  sessions: Array<{ id: string; label: string; createdAt: number | null; lastSeenAt: number | null; scopes: string[] }>;
}

/** the AI subscriptions the workspace's engines report (GET /api/plan-usage), windows as percent used */
export interface PlansReport {
  providers: Array<{ id: string; name: string; plan: string | null; ok: boolean; windows: Array<{ label: string; usedPercent: number; resetsAt: number | null }> }>;
}

/** one connected app; `via: "app"` is one connected in the app itself (an MCP server, a token app, a mailbox), which only
 * the app can change, so the website never sends app.* commands for it. Older workspaces leave `via` out (Composio) */
export interface AppsReportService { slug: string; connected: boolean; pending: boolean; via?: "composio" | "app" }

/** the connected apps on a workspace; `available` is false when Composio is not set up there, so the website can't
 * connect one itself; apps connected in the app are listed either way */
export interface AppsReport {
  available: boolean;
  /** false when the workspace could read the apps but not every account behind them */
  complete: boolean;
  services: AppsReportService[];
}

export type CommandKind = "computer.wake" | "computer.sleep" | "phone.revoke" | "session.revoke" | "routine.pause" | "routine.resume" | "app.connect" | "app.disconnect" | "phone.pair";
/** what the website's dashboard may queue; phone.pair is queued only by the account service for a signed-in phone */
export const COMMAND_KINDS: readonly CommandKind[] = ["computer.wake", "computer.sleep", "phone.revoke", "session.revoke", "routine.pause", "routine.resume", "app.connect", "app.disconnect"];
/** a phone.pair command is picked up within this long or dropped, so a computer waking later never mints a grant no one waits for */
export const PHONE_PAIR_COMMAND_TTL_MS = 60_000;
/** app.* commands only queue for a workspace seen this recently; anything older reads as asleep */
export const APP_COMMAND_ONLINE_MS = 45_000;
/** after an app command a workspace reports its apps on every report for this long, so a finished sign-in shows */
export const APP_WATCH_MS = 5 * 60_000;

const APP_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;
/** a Composio toolkit slug as an app.* target */
export function appSlug(input: unknown): string | null {
  return typeof input === "string" && APP_SLUG.test(input.toLowerCase()) ? input.toLowerCase() : null;
}

/** `target` is a bot id for computer.*, a phone or session id for *.revoke, a routine id for routine.*, a toolkit slug for app.*,
 * the phone's own name for phone.pair. `callback`: app.connect only, the website's page the app's sign-in sends the browser
 * back to (connectCallback); a workspace that can't send it there leaves `returnsHere` out of its result */
export interface DashboardCommand { id: string; kind: CommandKind; target: string; issuedAt: number; expiresAt: number; callback?: string }
/** `url` is app.connect's sign-in page: https only, shown only to the workspace's owner, never stored. `returnsHere`: that
 * sign-in ends on the command's `callback`, so the website may send its own tab there. `link` is
 * phone.pair's one-time pairing link (duskbot://pair?m=..., shared/mobile-link.ts): handed to the waiting phone only, never
 * stored. `reason` says why a phone.pair failed: no route a phone could use, or refused (policy, too many phones) */
export interface CommandResult { id: string; ok: boolean; message: string | null; at: number; url?: string | null; returnsHere?: true; link?: string; reason?: "unreachable" | "refused" }

/** where a sign-in started from the website comes back: the website's apps page carrying the connect's one-time state */
export const CONNECT_CALLBACK_PATH = "/connectors";
/** POST /v1/connect/finish answer: which sign-in the state was for, and whether the app said it went through */
export interface ConnectFinishAnswer { workspaceId: string; slug: string; outcome: "signed-in" | "cancelled" }
const CONNECT_STATE = /^[A-Za-z0-9_-]{32,64}$/;
/** a command's callback a workspace hands to the app's sign-in: https (http only on a loopback host, for local testing),
 *  no credentials or fragment, the apps page with just its `connect` state; anything else is dropped */
export function connectCallback(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 512) return null;
  try {
    const url = new URL(input);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) return null;
    if (!url.pathname.endsWith(CONNECT_CALLBACK_PATH) || [...url.searchParams.keys()].join() !== "connect" || !CONNECT_STATE.test(url.searchParams.get("connect") ?? "")) return null;
    return url.toString();
  } catch { return null; }
}

/** a phone pairing link a workspace may hand back for phone.pair; anything else is dropped */
export function commandPairLink(input: unknown): string | null {
  return typeof input === "string" && input.length <= 8192 && /^duskbot:\/\/pair\?m=[A-Za-z0-9_-]+$/.test(input) ? input : null;
}

/** a sign-in link a workspace may hand back; anything else is dropped */
export function commandUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 2048) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

/** sections are optional: a workspace sends what changed or what it could read; the service keeps the last of each */
export interface WorkspaceReport {
  v: 1;
  seq: number;
  at: number;
  /** `environmentId`: the workspace's own id, the one its phone links carry, so a phone can tell a computer it already
   * links to; older workspaces leave it out */
  workspace: { name: string; kind: WorkspaceKind; version: string; platform: string; environmentId?: string };
  machine?: MachineReport;
  computers?: { provider: "vps" | "local" | "none"; computers: ComputerReport[] };
  bots?: BotReport[];
  activity?: ActivityReport;
  devices?: DevicesReport;
  plans?: PlansReport;
  apps?: AppsReport;
  /** structured usage since the last report (usage-signals.ts); the service rolls it up and never keeps it on the workspace */
  usage?: UsageReport;
  /** the person changed "help improve Metal" in the app: true is off. The service sets the account's switch to match
   * (off also deletes what it stored); sent until a report gets through */
  usageOptOut?: boolean;
  /** cpu and memory samples newer than the last report's, sent only while someone watches (machine-pulse.ts) */
  pulse?: PulseSample[];
  results?: CommandResult[];
}

/** answer to POST /v1/report and GET /v1/wait */
export interface ReportAnswer {
  v: 1; watching: boolean; nextReportMs: number; commands: DashboardCommand[];
  /** the account's "help improve Metal" switch (true is off), so the app follows a change made on the account */
  usageOptOut?: boolean;
}

/** POST /v1/enroll: a workspace introduces its ed25519 public key (spki der, base64) and gets a one-time claim link */
export interface EnrollRequest { v: 1; publicKey: string; name: string; kind: WorkspaceKind; version: string }
export interface EnrollAnswer { v: 1; workspaceId: string; claimUrl: string; claimExpiresAt: number; dashboardUrl: string }

/** GET /v1/connectors: each owned workspace's connected app slugs, the ones waiting on a sign-in, and when they were read;
 * `inApp`: those of them connected in the app itself, which only the app can change (older services leave it out) */
export interface ConnectorsAnswer {
  byWorkspace: Record<string, string[]>;
  inApp?: Record<string, string[]>;
  pending: Record<string, string[]>;
  available: Record<string, boolean>;
  at: Record<string, number | null>;
}

/** what the dashboard page reads: GET /v1/workspaces */
export type Freshness = "live" | "recent" | "offline" | "waiting";
export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: WorkspaceKind;
  version: string;
  connectedAt: number;
  lastReportAt: number | null;
  freshness: Freshness;
}

export interface MachineSample { t: number; cpu: number; mem: number; rx: number; tx: number }
export type CommandStatus = "queued" | "sent" | "done" | "failed" | "expired";
export interface CommandView extends DashboardCommand { status: CommandStatus; message: string | null; doneAt: number | null; url?: string | null; returnsHere?: true }

/** GET /v1/workspaces/:id: the newest of each section, when it came, recent machine samples and recent commands */
export interface WorkspaceDetail {
  workspace: WorkspaceSummary;
  report: Omit<WorkspaceReport, "v" | "seq" | "results"> | null;
  sectionAt: Partial<Record<"machine" | "computers" | "bots" | "activity" | "devices" | "plans" | "apps", number>>;
  history: MachineSample[];
  commands: CommandView[];
}

export function freshnessOf(lastReportAt: number | null, now: number): Freshness {
  if (lastReportAt === null) return "waiting";
  const age = now - lastReportAt;
  return age <= 3 * FAST_REPORT_MS ? "live" : age <= OFFLINE_AFTER_MS ? "recent" : "offline";
}

type DashboardParser = (input: unknown) => unknown;
const dashboardInvalid = Symbol("invalid");
const dashboardText = (max = 200): DashboardParser => input => typeof input === "string" ? input.slice(0, max) : dashboardInvalid;
const dashboardName = dashboardText(120);
const dashboardId: DashboardParser = input => typeof input === "string" && input.length > 0 ? input.slice(0, 200) : dashboardInvalid;
const dashboardNumber: DashboardParser = input => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : dashboardInvalid;
const dashboardBoolean: DashboardParser = input => typeof input === "boolean" ? input : dashboardInvalid;
const dashboardEnum = (...values: string[]): DashboardParser => input => values.includes(input as string) ? input : dashboardInvalid;
const dashboardNullable = (parse: DashboardParser): DashboardParser => input => input === null ? null : parse(input);
const dashboardOptional = (parse: DashboardParser): DashboardParser => input => input === undefined ? undefined : parse(input);
const dashboardArray = (parse: DashboardParser, max: number): DashboardParser => input => {
  if (!Array.isArray(input)) return dashboardInvalid;
  const result = input.slice(0, max).map(parse);
  return result.includes(dashboardInvalid) ? dashboardInvalid : result;
};
const dashboardObject = (shape: Record<string, DashboardParser>): DashboardParser => input => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return dashboardInvalid;
  const result: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(shape)) {
    const value = parse((input as Record<string, unknown>)[key]);
    if (value === dashboardInvalid) return dashboardInvalid;
    result[key] = value;
  }
  return result;
};
const dashboardKind = dashboardEnum("vps", "mac", "linux", "windows");
const dashboardEnvironment: DashboardParser = input => input === undefined ? undefined : typeof input === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(input) ? input : dashboardInvalid;
const dashboardWorkspace: DashboardParser = input => {
  const value = dashboardObject({ name: dashboardName, kind: dashboardKind, version: dashboardText(), platform: dashboardText() })(input);
  if (value === dashboardInvalid) return value;
  const environmentId = dashboardEnvironment((input as Record<string, unknown>).environmentId);
  return environmentId === dashboardInvalid || environmentId === undefined ? value : { ...(value as object), environmentId };
};
const dashboardTotals = { turns: dashboardNumber, tokens: dashboardNumber, costUsd: dashboardNullable(dashboardNumber),
  input: dashboardOptional(dashboardNumber), output: dashboardOptional(dashboardNumber), cacheRead: dashboardOptional(dashboardNumber), cacheWrite: dashboardOptional(dashboardNumber) };
const dashboardSections: Record<string, DashboardParser> = {
  machine: dashboardObject({
    host: dashboardObject({ hostname: dashboardName, platform: dashboardText(), arch: dashboardText(), cpus: dashboardNumber, cpuModel: dashboardNullable(dashboardName) }),
    cpu: dashboardObject({ percent: dashboardNumber, load: input => Array.isArray(input) && input.length === 3 ? dashboardArray(dashboardNumber, 3)(input) : dashboardInvalid }),
    memory: dashboardObject({ usedBytes: dashboardNumber, totalBytes: dashboardNumber }),
    disk: dashboardNullable(dashboardObject({ usedBytes: dashboardNumber, totalBytes: dashboardNumber, path: dashboardText() })),
    network: dashboardNullable(dashboardObject({ rxBytesPerSec: dashboardNumber, txBytesPerSec: dashboardNumber })),
    uptimeSec: dashboardNumber, processUptimeSec: dashboardNumber,
    app: dashboardObject({ version: dashboardText(), node: dashboardText() }),
    update: dashboardNullable(dashboardObject({ available: dashboardBoolean, latest: dashboardNullable(dashboardText()), how: dashboardNullable(dashboardText()) })),
    services: dashboardArray(dashboardObject({ id: dashboardId, name: dashboardName, state: dashboardEnum("running", "stopped", "unknown"), detail: dashboardNullable(dashboardText()) }), 20),
  }),
  computers: dashboardObject({ provider: dashboardEnum("vps", "local", "none"), computers: dashboardArray(dashboardObject({
    id: dashboardId, botId: dashboardNullable(dashboardId), botName: dashboardNullable(dashboardName), kind: dashboardEnum("vps", "local-vm", "team"),
    name: dashboardName, state: dashboardEnum("running", "asleep", "starting", "missing", "unknown"), memoryBytes: dashboardNullable(dashboardNumber),
    memoryLimitBytes: dashboardNullable(dashboardNumber), cpuPercent: dashboardNullable(dashboardNumber), lastUsedAt: dashboardNullable(dashboardNumber), alias: dashboardNullable(dashboardName),
  }), 200) }),
  bots: dashboardArray(dashboardObject({
    id: dashboardId, name: dashboardName, color: dashboardText(), body: dashboardNullable(dashboardText()), model: dashboardNullable(dashboardText()),
    engine: dashboardNullable(dashboardText()), computer: dashboardNullable(dashboardEnum("vps", "local-vm", "team")), busy: dashboardBoolean,
    lastActiveAt: dashboardNullable(dashboardNumber), routines: dashboardArray(dashboardObject({ id: dashboardId, name: dashboardName, schedule: dashboardText(),
      paused: dashboardBoolean, nextRunAt: dashboardNullable(dashboardNumber), lastRunAt: dashboardNullable(dashboardNumber), running: dashboardOptional(dashboardBoolean) }), 50),
  }), 200),
  activity: dashboardObject({ from: dashboardText(), to: dashboardText(), timeZone: dashboardText(),
    days: dashboardArray(dashboardObject({ date: dashboardText(), ...dashboardTotals }), 400),
    byBot: dashboardArray(dashboardObject({ botId: dashboardId, botName: dashboardName, ...dashboardTotals }), 200),
    byModel: dashboardArray(dashboardObject({ model: dashboardText(), ...dashboardTotals }), 100), totals: dashboardObject(dashboardTotals),
  }),
  devices: dashboardObject({ thisDevice: dashboardObject({ label: dashboardName, kind: dashboardEnum("mac", "linux", "windows", "server") }),
    link: dashboardNullable(dashboardObject({ mode: dashboardEnum("direct", "relay", "off"), connected: dashboardBoolean, url: dashboardNullable(dashboardText()),
      since: dashboardNullable(dashboardNumber), detail: dashboardNullable(dashboardText()) })),
    phones: dashboardArray(dashboardObject({ id: dashboardId, label: dashboardName, platform: dashboardNullable(dashboardText()), pairedAt: dashboardNullable(dashboardNumber), lastSeenAt: dashboardNullable(dashboardNumber) }), 50),
    sessions: dashboardArray(dashboardObject({ id: dashboardId, label: dashboardName, createdAt: dashboardNullable(dashboardNumber), lastSeenAt: dashboardNullable(dashboardNumber), scopes: dashboardArray(dashboardText(), 50) }), 100),
  }),
  plans: dashboardObject({ providers: dashboardArray(dashboardObject({ id: dashboardId, name: dashboardName, plan: dashboardNullable(dashboardText()), ok: dashboardBoolean,
    windows: dashboardArray(dashboardObject({ label: dashboardName, usedPercent: dashboardNumber, resetsAt: dashboardNullable(dashboardNumber) }), 20) }), 20) }),
  apps: dashboardObject({ available: dashboardBoolean, complete: dashboardBoolean,
    services: dashboardArray(dashboardObject({ slug: input => appSlug(input) ?? dashboardInvalid, connected: dashboardBoolean, pending: dashboardBoolean,
      via: dashboardOptional(dashboardEnum("composio", "app")) }), 500) }),
  pulse: input => parsePulse(input) ?? dashboardInvalid,
  usageOptOut: dashboardBoolean,
  usage: input => cleanUsageReport(input, Date.now(), (name, props) => cleanSignal(name, props, "workspace")) ?? dashboardInvalid,
  results: dashboardArray(input => {
    const result = dashboardObject({ id: dashboardId, ok: dashboardBoolean, message: dashboardNullable(dashboardText()), at: dashboardNumber })(input);
    if (result === dashboardInvalid) return result;
    const raw = input as Record<string, unknown>;
    const url = commandUrl(raw.url), link = commandPairLink(raw.link);
    const reason = raw.reason === "unreachable" || raw.reason === "refused" ? raw.reason : undefined;
    return { ...(result as object), ...(url ? { url } : {}), ...(url && raw.returnsHere === true ? { returnsHere: true } : {}), ...(link ? { link } : {}), ...(reason ? { reason } : {}) };
  }, 50),
};

/** bounded version 1 report; malformed optional sections are omitted independently. */
export function parseWorkspaceReport(input: unknown): WorkspaceReport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const workspace = dashboardWorkspace(value.workspace);
  if (value.v !== 1 || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1 || dashboardNumber(value.at) === dashboardInvalid || workspace === dashboardInvalid) return null;
  const report: Record<string, unknown> = { v: 1, seq: value.seq, at: value.at, workspace };
  for (const [key, parse] of Object.entries(dashboardSections)) {
    if (value[key] === undefined) continue;
    const section = parse(value[key]);
    if (section !== dashboardInvalid) report[key] = section;
  }
  return report as unknown as WorkspaceReport;
}

/** bounded enrollment fields; the service verifies that the key is ed25519 spki der. */
export function parseEnrollRequest(input: unknown): EnrollRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.v !== 1 || typeof value.publicKey !== "string" || value.publicKey.length > 2000 || !value.publicKey.length) return null;
  const parsed = dashboardObject({ name: dashboardName, kind: dashboardKind, version: dashboardText() })(input);
  if (parsed === dashboardInvalid) return null;
  return { v: 1, publicKey: value.publicKey, ...(parsed as Omit<EnrollRequest, "v" | "publicKey">) };
}
