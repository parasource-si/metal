// GET /v1/admin/ops: everything that costs money or can go down, read from what the ops collectors stored (never a live
// third-party call on page load). money is in us cents, bytes are bytes, times are epoch ms. null means "not collected".
// the server (apps/dashboard/server/admin/ops) builds this shape; keep the two in step.

export type OpsLevel = "ok" | "watch" | "bad" | "unknown";

/** one quota bar: what was used so far this period, the plan's included amount, where the period ends at this pace */
export interface OpsMeter { used: number; limit: number | null; projected: number | null; level: OpsLevel }

/** one collector: when it last ran, whether it worked, and whether it has what it needs (a token, a url) */
export interface OpsSource { id: OpsSourceId; label: string; configured: boolean; at: number | null; ok: boolean; error: string | null; every: "5m" | "1h" }
export type OpsSourceId = "host" | "probes" | "mongo" | "certs" | "cloudflare" | "brevo" | "composio" | "relay" | "oracle";

export interface OpsInstaboxMachine {
  cloudId: string; accountId: string; email: string | null; serverId: string;
  awakeHours: number; vcpuHours: number; memGiBHours: number; diskGiB: number; egressGb: number;
  costCents: number; todayCents: number; egressState: "slowed" | "paused" | null;
}
export interface OpsInstaboxCustomer {
  accountId: string; email: string | null; plan: string; machines: number;
  awakeHours: number; vcpuHours: number; memGiBHours: number; egressGb: number; costCents: number; projectedCents: number; egressState: "slowed" | "paused" | null;
}
export interface OpsOutlier { accountId: string; email: string | null; metric: OpsSignalKind; value: number; median: number; ratio: number | null; z: number | null }

export interface OpsInstabox {
  totals: { machines: number; customers: number; awakeHours: number; vcpuHours: number; memGiBHours: number; egressGb: number; costCents: number; todayCents: number; projectedCents: number };
  days: Array<{ day: string; costCents: number; egressGb: number; awakeHours: number }>;
  machines: OpsInstaboxMachine[];
  customers: OpsInstaboxCustomer[];
  /** the ten furthest from the fleet's median, by any of awake hours, egress and cost */
  outliers: OpsOutlier[];
  /** customers whose cloud sits at a slowed or paused egress step right now */
  limited: Array<{ accountId: string; email: string | null; cloudId: string; state: "slowed" | "paused"; egressGb: number }>;
}

export interface OpsWorkers {
  plan: { label: string; baseCents: number; includedRequests: number; includedCpuMs: number; requestCentsPerMillion: number; cpuCentsPerMillionMs: number };
  requests: OpsMeter; cpuMs: OpsMeter;
  /** what this month ends up costing over the base at this pace */
  overageCents: number;
  scripts: Array<{ name: string; requests: number; cpuMs: number; errors: number; todayRequests: number; todayCpuMs: number }>;
  days: Array<{ day: string; requests: number; cpuMs: number }>;
}
export interface OpsR2 { freeBytes: number; total: OpsMeter; overageCents: number; buckets: Array<{ name: string; bytes: number; objects: number }> }
export interface OpsComposio {
  limits: { installation: number; account: number };
  today: { calls: number; installations: number }; week: { calls: number };
  days: Array<{ day: string; calls: number }>;
  top: Array<{ installationId: string; accountId: string | null; email: string | null; today: number; week: number; share: number }>;
  /** installations past 80% of their daily limit today */
  nearLimit: number;
  queue: { events: number; bytes: number } | null;
  registrationsTopIp: Array<{ ip: string; today: number }>;
}
export interface OpsBrevo { today: { sent: number; delivered: number; bounced: number; blocked: number }; month: { sent: number }; daily: OpsMeter; monthly: OpsMeter; plan: string | null }
/** one mail provider as this service counted it (auth/mail-router.ts): sends against its caps, the emails it passed to the
 *  other provider (at a cap or failing) and its last refusal */
export interface OpsMailProvider {
  provider: "resend" | "brevo"; configured: boolean;
  /** what it sends first: resend the codes, receipts and cloud ready; brevo everything else */
  sends: string;
  daily: OpsMeter; monthly: OpsMeter;
  fallbacks: { today: number; month: number };
  lastError: { at: number; reason: string } | null;
}
export interface OpsMail { providers: OpsMailProvider[] }
export interface OpsDodo { monthCents: number; todayCents: number; payments: number; grossCents: number; rate: { rate: number; fixedCents: number }; estimated: boolean; lastWebhookAt: number | null }
export interface OpsRelay {
  dailyLimitBytes: number;
  today: { bytes: number; tunnels: number; limited: number }; month: { bytes: number };
  days: Array<{ day: string; bytes: number }>;
  top: Array<{ tunnelId: string; accountId: string | null; email: string | null; todayBytes: number; monthBytes: number; limited: number }>;
}

export interface OpsSpend {
  /** every provider's month to date, in cents, and where the month ends at this pace */
  totals: { monthCents: number; projectedCents: number; todayCents: number };
  lines: Array<{ provider: "instabox" | "workers" | "r2" | "dodo" | "brevo" | "composio" | "relay"; label: string; monthCents: number; projectedCents: number; note: string }>;
  instabox: OpsInstabox;
  workers: OpsWorkers | null;
  r2: OpsR2 | null;
  composio: OpsComposio | null;
  brevo: OpsBrevo | null;
  /** null when this service has no counting mail router (console mail in development) */
  mail: OpsMail | null;
  dodo: OpsDodo;
  relay: OpsRelay | null;
}

export type OpsCheckGroup = "boxes" | "services" | "data" | "providers" | "backups" | "certs";
export interface OpsCheck { id: string; group: OpsCheckGroup; name: string; level: OpsLevel; value: string; detail: string | null; at: number | null; latencyMs: number | null }
export interface OpsBox {
  name: "contabo" | "oracle"; at: number | null;
  cpu: number | null; mem: number | null; disk: number | null; load: [number, number, number] | null; cores: number | null;
  memTotalBytes: number | null; diskTotalBytes: number | null;
  /** bytes since 00:00 utc, and the last sample's rate in bytes a second */
  net: { inToday: number; outToday: number; inRate: number; outRate: number } | null;
  /** the last 24 hours, one point per sample */
  series: Array<{ at: number; cpu: number | null; mem: number | null; disk: number | null }>;
}
export interface OpsHealth { checks: OpsCheck[]; boxes: OpsBox[] }

export type OpsSignalKind = "egress" | "awake" | "cost" | "relay" | "tool_calls" | "signups_ip" | "failed_payments" | "rate_limited";
export interface OpsSignal { kind: OpsSignalKind; value: number; median: number; ratio: number | null; label: string }
export interface OpsSuspect { key: string; accountId: string | null; email: string | null; ip: string | null; score: number; signals: OpsSignal[]; why: string }

export interface OpsRule { id: string; label: string; threshold: string; state: "ok" | "pending" | "firing"; since: number | null; value: string | null; lastFiredAt: number | null }

export interface OpsAnswer {
  now: number; month: string;
  /** how much of the month has passed, 0 to 1 */
  elapsed: number;
  fixture: boolean;
  sources: OpsSource[];
  spend: OpsSpend;
  health: OpsHealth;
  abuse: OpsSuspect[];
  alerts: OpsRule[];
}

/** the link relays' live cards at the top of ops: GET /v1/admin/ops/relays, from each relay's GET /ops/relay/stats */
/** "contabo", "cloudflare", or another link node's id ("oracle-in") */
export type OpsRelayId = string;
/** rates in bytes per second, sizes in bytes; null turns a limit off. a relay may add keys of its own */
export interface OpsRelayLimits {
  perTunnelBytesPerSec?: number | null; burstBytes?: number | null; perTunnelDailyBytes?: number | null; tunnelsPerAccount?: number | null;
  globalCeilingBytesPerSec?: number | null; maxTunnels?: number | null; maxConnected?: number | null; maxServers?: number | null; paused?: boolean;
  [key: string]: number | boolean | null | undefined;
}
export interface OpsRelayStats {
  relay: string;
  /** tunnels: busy ones; connected: in use (an open desktop); servers: linked servers whose agent reads here */
  now: { tunnels: number; connected?: number; servers?: number; accounts: number; bytesPerSecOut: number; bytesPerSecIn: number; cpu: number | null; rssMb: number | null };
  today: { bytesOut: number; bytesIn: number };
  month: { bytesOut: number; bytesIn: number; projectedBytesOut: number; allowanceBytes: number | null };
  limits: OpsRelayLimits;
  /** account: the relay's account ref, null for a tunnel no account owns; accountId and email are filled in by the account service when it knows them */
  top: Array<{ account: string | null; tunnels: number; bytesToday: number; accountId?: string | null; email?: string | null }>;
  busy: boolean | { reason?: string; [key: string]: unknown };
  /** a link service node: each account's relay bytes this month on every node together, and the rate that gives it now */
  fairUse?: { month: string; accounts: Array<{ account: string | null; tunnel: string | null; monthBytes: number; hereBytes: number; bytesPerSec: number; accountId?: string | null; email?: string | null }> };
  /** cloudflare: an estimate from durable object awake time and messages */
  cost?: { estimated: boolean; monthCents: number; projectedCents: number; awakeHours?: number; messages?: number };
  paused?: boolean;
  /** a link service node: which one, and how full it is for placing new servers */
  node?: { id: string; region: string | null; url: string; default: boolean; homed: number; accepting: boolean; refuses: string | null; load: { active: number; bandwidth: number; budget: number; spent: number; box: number } };
  /** every link node as this one sees it */
  nodes?: Array<{ id: string; url: string; region: string | null; self: boolean; up: boolean; lastOkAt: number | null; lastError: string | null; homed: number | null; tunnels: number | null; accepting: boolean | null }>;
  /** the whole box: cpu and memory in %, the main interface's traffic (everything the box sends counts against the allowance) */
  box?: { iface: string | null; cpu: number | null; mem: number | null; cores: number; bytesPerSecOut: number | null; bytesPerSecIn: number | null; monthBytesOut: number | null; monthBytesIn: number | null; projectedBytesOut: number | null; countingSince: number | null } | null;
  /** the node's own turn server (the webrtc fallback's second tier) */
  turn?: { ok: boolean | null; at: number | null; rttMs: number | null; downSince: number | null; urls: string[] } | null;
  /** how app sessions reached their server this month, counted by the link service when the apps report it: straight
   *  (webrtc), through the person's own cloudflare tunnel, or through our relay. absent until a node reports it */
  paths?: { direct: number; cloudflare: number; relay: number; since?: number | null } | null;
}
export interface OpsRelayCard { id: OpsRelayId; label: string; url: string; at: number; configured: boolean; ok: boolean; error: string | null; stats: OpsRelayStats | null }

/** GET /v1/admin/ops/accounts: who uses the most this month, one row per account. null means "not reported yet" */
export type OpsAccountsRange = "month" | "last-month" | "7d";
export type OpsFairStage = "full" | "slowing" | "chat";
export interface OpsAccountFlag { kind: "check" | "throttled" | "abuse"; why: string }
export interface OpsAccountRow {
  /** null when the relay knows the account only by its link ref and the account service has no such account */
  accountId: string | null; ref: string | null; email: string | null;
  /** the account's plan ("none" without one); null when the service can't see plans (the live site's accounts) */
  plan: string | null;
  /** relay bytes this month on every node together, its share of all relay traffic (0 to 1), the fair use step and the rate it gives now */
  relay: { monthBytes: number; share: number; stage: OpsFairStage; bytesPerSec: number } | null;
  cloud: { awakeHours: number; costCents: number; egressState: "slowed" | "paused" | null } | null;
  /** every email the service sent the account this month, and how many were sign-in codes */
  emails: number | null; codes: number | null;
  flags: OpsAccountFlag[];
}
export interface OpsAccountsAnswer {
  now: number; month: string;
  /** the days the cloud and email columns cover; the relay is always this month (the link nodes keep a month) */
  range: OpsAccountsRange; from: string; to: string;
  /** every account that used something, past the top ones */
  total: number;
  /** "own", or the live site's label ("dusk.bot") when preview's admin reads it */
  data: string; fixture: boolean;
  fairUse: { fullSpeedBytes: number; floorAtBytes: number };
  reported: { relay: boolean; cloud: boolean; mail: boolean };
  rows: OpsAccountRow[];
}

// GET /v1/admin/ops/sharing: the desktop app's "help improve Metal" switch (server/admin/sharing.ts)
export type SharingPlace = "settings" | "first_run";
export interface OpsSharingWindow { days: 7 | 30; enables: number; disables: number; byPlace: Record<SharingPlace, { enables: number; disables: number }> }
export interface OpsSharingAnswer { v: 1; now: number; optedIn: number; optedOut: number; outShare: number | null; windows: OpsSharingWindow[] }
