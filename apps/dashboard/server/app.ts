import { isIP } from "node:net";
import { request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { APP_COMMAND_ONLINE_MS, CLAIM_TTL_MS, COMMAND_KINDS, PHONE_PAIR_COMMAND_TTL_MS, appSlug, COMMAND_TTL_MS, DASHBOARD_DISCOVERY_PATH, FAST_REPORT_MS, MAX_REPORT_BYTES, SIGNATURE_SKEW_MS, SLOW_REPORT_MS,
  freshnessOf, parseEnrollRequest, parseWorkspaceReport, signedPayload } from "../../../shared/dashboard-protocol.ts";
import type { CommandKind, CommandResult, CommandView, ConnectorsAnswer, MachineSample, ReportAnswer, WorkspaceDetail, WorkspaceReport, WorkspaceSummary } from "../../../shared/dashboard-protocol.ts";
import { PULSE_INTERVAL_MS, PULSE_WINDOW_MS, PulseRing, type PulseAnswer } from "../../../shared/machine-pulse.ts";
import type { NotificationPrefs } from "../../../shared/account-api.ts";
import { MCP_CLIENT_METADATA, MCP_CLIENT_METADATA_PATH } from "../../../shared/mcp-client-metadata.ts";
import { AuthError, createAuth, isAppCorsRoute, reviewAccountFromEnv, type ReviewAccount } from "./auth/index.ts";
import type { ProviderConfigs } from "./auth/providers.ts";
import { createTestMailbox, isTestAccount, isTestAddress, sinkTestMail } from "./auth/mail.ts";
import { isOpsMade, withoutOps } from "./admin/money-mode.ts";
import type { Mailer, MailMessage, TestMailbox } from "./auth/mail.ts";
import type { RoutedMailer } from "./auth/mail-router.ts";
import { createStore } from "./store.ts";
import { createConnectStates } from "./connect-states.ts";
import { appComputer, COMPUTER_ID, COMPUTER_PAIR_LIMITS, COMPUTER_PAIR_WAIT_MS, pairAnswer } from "./app-computers.ts";
import type { Account, StoredCommand, StoredWorkspace } from "./store.ts";
import { createBilling } from "./billing/index.ts";
import type { BillingNotice } from "./billing/service.ts";
import { BILLING_CONFIG, MANAGED_REGION, regionLabel } from "./billing/plans.ts";
import type { StoredCloud } from "./clouds/types.ts";
import { DEFAULT_RETENTION_DAYS } from "../../cloud-service/src/retention.ts";
import { CODE_SUBJECT, accountDeletedEmail, cancelledEmail, cloudDeletedEmail, cloudNoticeEmail, cloudReadyEmail, emailConfig, paymentFailedEmail, receiptEmail, teamInviteEmail, teamSeatFullEmail, welcomeEmail } from "./email/templates.ts";
import type { Rendered } from "./email/templates.ts";
import { render } from "./email/layout.ts";
import { BillingError } from "./billing/service.ts";
import { createSlackEdgeHost } from "./slack-edge/index.ts";
import { createManagedRoutes } from "./clouds/managed-routes.ts";
import { pagesRoutesFromEnv } from "./pages/routes.ts";
import { clientIp, rateIp } from "./client-ip.ts";
import { stateBackend } from "./persistence/backend.ts";
import type { ErrorReporter } from "../../../electron/error-report.mjs";
import type { EdgeSocketFactory } from "./slack-edge/service.ts";
import { createAnalytics, readLimited } from "./analytics/index.ts";
import { APP_EVENTS_PATH, APP_NOTES_PATH, TRACK_PATH, handleAppNotes } from "./analytics/ingest.ts";
import { memorySink, type AnalyticsSink } from "./analytics/sink.ts";
import { createUsage, memoryUsageStore, type UsageStore } from "./analytics/usage.ts";
import { createInfraCollector, memoryInfraStore, type InfraStore } from "./admin/infra.ts";
import { opsFixture } from "./admin/ops/fixture.ts";
import { createOps } from "./admin/ops/index.ts";
import { memoryOpsStore, type OpsStore } from "./admin/ops/store.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { mongoAiStashStore } from "./clouds/ai-stash.ts";
import type { Db } from "mongodb";
import { AdminError, createAdmin, parseAdminEmails } from "./admin/index.ts";
import { createErrorCounter } from "./admin/health.ts";
import { churnThreshold, createAlerts, parseAlerts } from "./admin/alerts.ts";
import { moneyDigestOf, mrrAtTime } from "./analytics/subscriptions.ts";
import type { LedgerEntry } from "./billing/ledger.ts";
import type { WaitlistSource } from "./admin/waitlist.ts";
import type { LiveData } from "./admin/live.ts";
import { workspaceTurns } from "./admin/metrics.ts";
import { createIncidents, type Incidents } from "./incidents/index.ts";
import { memoryIncidentStore } from "./incidents/store.ts";
import { createIncidentRoutes, IncidentRouteError } from "./incidents/routes.ts";
import { BUG_REPORT_PATH, createBugReports } from "./bug-reports/index.ts";
import { memoryBugReportStore, type BugReportStore } from "./bug-reports/store.ts";
import { createSealer, parseSealKey } from "./clouds/seal.ts";
import { aliasLegacyCookies, aliasLegacyHeaders } from "../../../electron/legacy-names.mjs";
import { LINK_GRANT_PATH, linkGrantSignerFromEnv, signLinkGrant } from "./link-grant.ts";
import { screenIceMinterFromEnv } from "./screen-ice.ts";
import { ACCOUNT_ROUTES, type AppComputersAnswer } from "../../../shared/account-api.ts";

export interface DashboardAppOptions {
  dataDir: string;
  publicUrl: string;
  mailer: Mailer;
  /** where mail to test addresses (@qa.dusk.test) goes; readable only on preview and in development */
  testMail?: TestMailbox;
  oauth?: ProviderConfigs;
  dev?: boolean;
  signupOpen?: boolean;
  /** App Review's fixed app sign-in; read from DUSK_REVIEW_EMAIL and DUSK_REVIEW_CODE when not given */
  review?: ReviewAccount | null;
  trustProxy?: boolean;
  staticDir: string | null;
  /** the page's path on publicUrl: "/dashboard" when the site shares the origin, "" (the default) at the root */
  pageBase?: string;
  /** before launch (DUSK_PRELAUNCH_WAITLIST_ONLY=1): the page's routes go home (the waitlist) except the few the apps,
   *  emailed links and the admin sign-in open; the API, webhooks, admin and site are untouched. needs a page base */
  waitlistOnly?: boolean;
  mailPerHour?: number;
  mailPerDay?: number;
  /** the site served beside the page on a shared origin (loopback http): every path that is not the page's, an API or
   *  a well-known address is proxied there */
  siteUpstream?: string | null;
  /** the link service beside this one (loopback): dusk.bot/s/<code>, the own-server short line, is its, behind Cloudflare */
  linkUpstream?: string | null;
  now?: () => number;
  fetch?: typeof fetch;
  /** errors worth an operator's look: the service's own failures, and the page's (sent to POST /v1/client-error) */
  errors?: { service: ErrorReporter; page: ErrorReporter };
  version?: string;
  /** the slack wake edge: DUSK_SLACK_EDGE and DUSK_CLOUD_SEAL_KEY from env; tests pass a fake socket */
  slackEdge?: { env?: NodeJS.ProcessEnv; socket?: EdgeSocketFactory };
  /** product analytics: MongoDB in production (main.ts), memory otherwise; the waitlist is dusk.waitlist when connected */
  analytics?: { sink?: AnalyticsSink; waitlist?: WaitlistSource | null; trackOrigins?: string[]; usage?: UsageStore; infra?: InfraStore; ops?: OpsStore; db?: Db | null };
  /** the owner's panel at /admin: DUSK_ADMIN_EMAILS by default */
  admin?: { emails?: string[]; growthEmails?: string[]; backupDir?: string | null; environment?: string; env?: NodeJS.ProcessEnv; opsFixture?: boolean; live?: LiveData | null;
    /** how long the admin keeps an analytics answer (main.ts: 30 s); none by default, so a fixture shows each event at once */
    readCacheMs?: number };
  /** the owner's alert emails (main.ts); without it incidents are kept in memory and nothing is mailed */
  incidents?: Incidents;
  /** @devs reports from the apps: MongoDB in production (main.ts), memory otherwise; mail goes where the alert emails go */
  bugReports?: { store?: BugReportStore; mail?: { on: boolean; to: () => string[]; mailers: Mailer[] } };
}
class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const hourMs = 60 * 60_000;
const sections = ["machine", "computers", "bots", "activity", "devices", "plans", "apps"] as const;
const COMMAND_REDELIVER_MS = 10_000;
const MUTATIONS = ["POST", "PUT", "PATCH", "DELETE"];

/** the page's content security policy: its own scripts plus the hashes of its inline ones (the theme bootstrap) */
export function pagePolicy(html: string): string {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => `'sha256-${createHash("sha256").update(match[1]!).digest("base64")}'`);
  return ["default-src 'self'", `script-src 'self'${inline.length ? ` ${inline.join(" ")}` : ""}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
    "font-src 'self' data:", "connect-src 'self'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");
}

/** the page's own top-level routes (apps/dashboard/src/main.tsx): on a shared origin a link to one without the page base,
 *  as the desktop and phone apps build them, is sent to it */
const PAGE_ROUTES = ["/sign-in", "/signin", "/signup", "/welcome", "/claim", "/cloud", "/clouds", "/billing", "/usage", "/account", "/workspaces", "/bots", "/connectors", "/settings", "/devices", "/connect"];

/** what the service answers itself on a shared origin; everything else outside the page base is the site's */
const ACCOUNT_PREFIXES = ["/v1/", "/api/cloud/", "/api/public", "/api/bots", BUG_REPORT_PATH, DASHBOARD_DISCOVERY_PATH];
/** the owner's panel: the same page bundle at its own top-level path, served only to an admin's session */
export const ADMIN_PATH = "/admin";
/** where the page lived before /dashboard; old links (and /app/admin) are sent on */
const LEGACY_PAGE_BASES = ["/app"];
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);
/** what the server can check about a flow before launch: a desktop sign-in code it handed out, an emailed link's attempt */
export interface PrelaunchLive { device(code: string): boolean; attempt(attempt: string): boolean }
const NO_FLOW: PrelaunchLive = { device: () => false, attempt: () => false };
/** a path within the page (base removed) that opens before launch, only from a real flow: the desktop app's sign-in
 *  (/cloud/desktop?code= a live code), sign-in from an emailed link (?attempt= a live one) or carrying one of these flows
 *  on in `next` (an oauth error, a provider without an email). the admin panel lives on preview then. /handoff, /claim and a cloud's delete
 *  link keep their token in the fragment, which never reaches us: the page itself sends a visit without one home. the
 *  page's built files (assets, icons) stay too */
export function prelaunchOpen(path: string, query: URLSearchParams = new URLSearchParams(), live: PrelaunchLive = NO_FLOW, depth = 0): boolean {
  const is = (page: string) => path === page || path === `${page}/`;
  if (is("/cloud/desktop")) return live.device(query.get("code") ?? "");
  if (is("/handoff") || is("/app-signed-in") || is("/claim") || is("/team/join") || /^\/clouds\/[^/]+\/delete\/?$/.test(path)) return true;
  if (is("/sign-in") || is("/signin")) {
    if (live.attempt(query.get("attempt") ?? "")) return true;
    const next = query.get("next");
    if (depth > 0 || !next?.startsWith("/") || next.startsWith("//") || next.includes("\\")) return false;
    const target = new URL(next, "http://x");
    return prelaunchOpen(target.pathname, target.searchParams, live, depth + 1);
  }
  return depth === 0 && (under(path, "/assets") || /^\/[^/]+\.(?:svg|png|ico|webmanifest|json|webp|jpg|woff2)$/.test(path));
}

/** the service's origin and its www twin (hostRedirect sends www here), so a dusk.bot visit counts whichever one the page
 *  was on, whatever DUSK_TRACK_ORIGINS says */
export function ownOrigins(publicUrl: string) {
  const own = new URL(publicUrl);
  const named = own.hostname.includes(".") && !own.hostname.startsWith("www.") && !/^[\d.]+$|:/.test(own.hostname);
  return named ? [own.origin, `${own.protocol}//www.${own.host}`] : [own.origin];
}

function pageBaseOf(value: string | undefined) {
  const base = (value ?? "").replace(/\/+$/, "");
  if (base && !/^\/[a-z0-9-]+$/.test(base)) throw new Error("The page base must look like /dashboard.");
  if (base === ADMIN_PATH) throw new Error("The page base cannot be the admin path.");
  return base;
}

/** forwards a request to the site beside the page; the client's address goes on as the proxy's own entry */
function siteProxy(upstream: string, onError: (error: Error, res: ServerResponse) => void = () => {}) {
  const target = new URL(upstream);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)) throw new Error("The site upstream must be a loopback http address.");
  return (req: IncomingMessage, res: ServerResponse) => new Promise<void>(resolve => {
    const headers = { ...req.headers };
    delete headers.connection; delete headers["keep-alive"]; delete headers.upgrade;
    const out = request({ host: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers, timeout: 20_000 }, answer => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
      answer.on("end", () => resolve());
      answer.on("error", () => { res.destroy(); resolve(); });
    });
    out.on("timeout", () => out.destroy(new Error("timeout")));
    out.on("error", error => {
      onError(error, res);
      if (!res.headersSent) { res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end("Bad gateway"); } else res.destroy();
      resolve();
    });
    req.pipe(out);
  });
}

/** unclaimed workspaces at once (each lives a day unless claimed), computers one account holds, reports one workspace sends an hour */
export const WORKSPACE_LIMITS = { unclaimed: 5000, perAccount: 50, reportsPerHour: 2400 };
/** a dusk cloud's own reports above this cpu share for this long open an incident */
/** the digest's cloud line: clouds first up, and clouds deleted, in [from, to); harness accounts left out */
export function cloudDigest(clouds: StoredCloud[], from: number, to: number, test: (accountId: string) => boolean) {
  const within = (at: number | undefined) => at !== undefined && at >= from && at < to;
  const real = clouds.filter(cloud => !test(cloud.accountId));
  return { ready: real.filter(cloud => within(cloud.mailed?.ready)).length, deleted: real.filter(cloud => cloud.status === "destroyed" && within(cloud.updatedAt)).length };
}
export const CLOUD_CPU_ALERT = { percent: 90, hours: 6 };
/** every sample of the last CLOUD_CPU_ALERT.hours above its share, with the window covered (at least 20 samples, the first within half an hour of its start) */
export function cpuPinned(samples: Array<{ t: number; cpu: number }>, at: number): boolean {
  const since = at - CLOUD_CPU_ALERT.hours * 3_600_000, recent = samples.filter(sample => sample.t >= since);
  return recent.length >= 20 && recent[0]!.t <= since + 1_800_000 && recent.every(sample => sample.cpu >= CLOUD_CPU_ALERT.percent);
}

export function createDashboardApp(options: DashboardAppOptions) {
  const now = options.now ?? Date.now;
  const publicUrl = new URL(options.publicUrl).origin;
  const pageBase = pageBaseOf(options.pageBase), pagesUrl = `${publicUrl}${pageBase}`;
  if (options.waitlistOnly && !pageBase) throw new Error("Waitlist-only needs the page base (DUSK_DASHBOARD_PAGE_BASE).");
  const reported = new WeakSet<ServerResponse>();
  const site = options.siteUpstream ? siteProxy(options.siteUpstream, (error, res) => reported.add(res) && incidents.report({ source: "upstream", name: "SiteUpstreamDown", key: "site-upstream",
    message: `the site behind ${publicUrl} did not answer (${error.message.slice(0, 60)})`, status: 502 })) : null;
  const link = options.linkUpstream ? siteProxy(options.linkUpstream) : null;
  const store = createStore(options.dataDir);
  const state = store.state;
  const startedAt = now();
  const analytics = createAnalytics({ sink: options.analytics?.sink ?? memorySink(now), dataDir: options.dataDir, now, trustProxy: options.trustProxy,
    trackOrigins: [...ownOrigins(options.publicUrl), ...(options.analytics?.trackOrigins ?? [])] });
  const errorsSeen = createErrorCounter(now);
  const dev = options.dev ?? (new URL(publicUrl).protocol === "http:" && ["127.0.0.1", "localhost"].includes(new URL(publicUrl).hostname));
  const mailLimitSay = { hour: "the hourly", day: "the daily", new: "the daily signup share of the" } as const;
  // every email to an account's address counts toward its row in admin ops, sign-in codes on their own
  let noteMail: (message: MailMessage) => void = () => {};
  const testMail = options.testMail ?? createTestMailbox({ readable: dev });
  const outbound = sinkTestMail(options.mailer, testMail);
  const mailer: Mailer = { send: message => { try { if (!isTestAddress(message.to)) noteMail(message); } catch { /* counting never stops an email */ } return outbound.send(message); } };
  const auth = createAuth({ dataDir: options.dataDir, publicUrl, pageBase, mailPerHour: options.mailPerHour, mailPerDay: options.mailPerDay, mailer: mailer,
    // one incident a day, whichever limit it was: someone (or a bot) is asking for sign-in codes faster than we will send them
    onMailLimit: kind => incidents.report({ source: "server", name: "SignInMailLimit", key: `auth-mail-${new Date(now()).toISOString().slice(0, 10)}`,
      message: `sign-in emails reached ${mailLimitSay[kind]} limit, so more codes are refused until it resets. a spike of signups or someone spraying addresses; check admin > health for rate-limited ips` }), now, fetch: options.fetch, oauth: options.oauth,
    dev, signupOpen: options.signupOpen ?? true, trustProxy: options.trustProxy ?? false, legacyAccounts: () => state.accounts, websiteFirstSteps: !options.waitlistOnly,
    review: options.review === undefined ? reviewAccountFromEnv(process.env) : options.review });
  state.sessions = [];
  store.changed();
  const linkGrants = linkGrantSignerFromEnv(process.env, { dataDir: options.dataDir, loopback: dev });
  const screenIce = screenIceMinterFromEnv(process.env, options.fetch ?? fetch);
  auth.onSignedIn(owner => {
    const existing = state.accounts.find(item => item.id === owner.id);
    if (existing) existing.email = owner.email; else state.accounts.push({ id: owner.id, email: owner.email });
    store.changed();
  });
  auth.onAccountDeleted(id => {
    state.accounts = state.accounts.filter(item => item.id !== id);
    for (const ws of state.workspaces) if (ws.ownerAccountId === id) forget(ws);
    state.workspaces = state.workspaces.filter(ws => ws.ownerAccountId !== id);
    watching.delete(id);
    store.changed(); store.close();
  });
  let slackEdge: ReturnType<typeof createSlackEdgeHost> | null = null;
  const emailCfg = emailConfig(process.env, { publicUrl, pageBase });
  const mail = (to: string | null | undefined, subject: string, text: string) => {
    if (!to) return;
    const message = render(emailCfg, { subject, preheader: text.slice(0, 120), tag: "dusk cloud", say: "a note about your cloud",
      accent: "sky", blocks: [{ t: "h1", text: subject.toLowerCase() }, { t: "p", text }],
      reason: "you got this because you have a Metal account. it's about your account, so it can't be turned off." });
    void mailer.send({ to, ...message }).catch(() => console.warn("clouds: a notice email failed"));
  };
  const ownIncidents = options.incidents ? null : createIncidents({ env: options.admin?.environment ?? "development", store: memoryIncidentStore(), to: () => [], mailers: [],
    email: emailCfg, panelUrl: `${publicUrl}${ADMIN_PATH}/health`, mail: false, timers: false, now });
  const incidents = options.incidents ?? ownIncidents!;
  const usage = createUsage({ store: options.analytics?.usage ?? memoryUsageStore(now), now, optedOut: id => analytics.optedOut(id),
    newProblem: group => {
      const [engine, category, touch] = group.key.split("|");
      incidents.report({ source: "server", name: "NewProblemGroup", key: `problem-${group.key}`, route: "/admin",
        message: `a new kind of frustration: ${category?.replace(/_/g, " ")} with ${touch} on ${engine}${group.example ? `. example: ${group.example}` : ""}` });
    } });
  analytics.onForget(id => void usage.forget(id));
  const send = (to: string | null | undefined, message: Rendered) => {
    if (to) void mailer.send({ to, ...message }).catch(() => console.warn("account: an email failed"));
  };
  const emailOf = (accountId: string) => auth.account(accountId)?.email;
  const sendTo = (accountId: string, kind: "required" | keyof NotificationPrefs, message: Rendered) => {
    if (kind === "required" || auth.wantsEmail(accountId, kind)) send(emailOf(accountId), message);
  };
  /** a harness's account (isTestAccount) gets no account mail at all: welcome, cloud ready, receipts, billing, goodbye. only the
   *  sign-in codes it needs, and those to @qa.dusk.test never leave the service */
  const courtesy = (email: string | null | undefined) => !!email && !isTestAccount(email);
  const retentionDays = Number(process.env.DUSK_MANAGED_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
  const cloudFacts = (cloud: StoredCloud) => ({ name: cloud.name, plan: (BILLING_CONFIG.desktops[cloud.kind]?.label ?? cloud.kind).toLowerCase(),
    machine: `${cloud.spec.vcpu} vcpu, ${cloud.spec.ramGb} gb memory, ${cloud.spec.diskGb} gb disk`, region: (regionLabel(cloud.backend ? MANAGED_REGION.id : cloud.region) ?? cloud.region).toLowerCase() });
  const cloudFromCents = Math.min(...Object.values(BILLING_CONFIG.desktops).flatMap(desktop => desktop.monthlyCents === null ? [] : [desktop.monthlyCents]));
  auth.onAccountCreated(owner => courtesy(owner.email) && send(owner.email, welcomeEmail(emailCfg, { cloudFromCents })));
  auth.onAccountCreated(owner => !isTestAddress(owner.email) && analytics.track("signup", { accountId: owner.id, props: { method: auth.directory().identities.find(item => item.accountId === owner.id)?.provider ?? "email" } }));
  auth.onSessionCreated(session => {
    analytics.track("sign_in", { accountId: session.accountId, props: { kind: session.kind, ...(session.platform ? { platform: session.platform } : {}), ...(session.appVersion ? { appVersion: session.appVersion } : {}) } });
    if (session.kind !== "web") analytics.track("app_paired", { accountId: session.accountId, props: { via: "app", ...(session.platform ? { platform: session.platform } : {}) } });
  });
  auth.onAppSeen(session => analytics.appActive(session));
  auth.onAccountDeleted(id => analytics.forget(id));
  auth.onAccountDeleted(id => void usage.forget(id));
  auth.onAccountDeleted((_id, email) => { if (courtesy(email)) send(email, accountDeletedEmail(emailCfg, { email: email ?? "" })); });
  function billingNotice(notice: BillingNotice) {
    const cloud = notice.kind !== "receipt" && notice.cloudId ? billing.clouds.get(notice.cloudId) : null;
    if (notice.kind === "receipt" && !opsPayment(notice.invoiceId)) analytics.track("checkout_paid", { accountId: notice.accountId, props: { amountCents: notice.amountCents } });
    if (notice.kind === "receipt") { if (courtesy(emailOf(notice.accountId))) sendTo(notice.accountId, "required", receiptEmail(emailCfg, { ...notice, receiptId: notice.invoiceId, cloud: notice.cloudId !== null })); }
    else if (!courtesy(emailOf(notice.accountId))) return;
    else if (notice.kind === "payment_failed") sendTo(notice.accountId, "required", paymentFailedEmail(emailCfg, { ...notice, cloudName: cloud?.name ?? null }));
    else sendTo(notice.accountId, "required", cancelledEmail(emailCfg, { description: notice.description, cloudName: cloud?.name ?? null, endsAt: notice.endsAt,
      keptPaused: cloud?.backend === "managed", keepDays: cloud?.backend === "managed" ? retentionDays : notice.graceDays }));
  }
  // what the operator gave (a grant, a comp, App Review's cloud) is never a payment or a subscription in the analytics log
  const opsSubscription = (id: string | null) => !!id && billing.store.state.subscriptions.some(sub => sub.id === id && isOpsMade(sub));
  function opsInvoice(invoice: { subscriptionId: string | null; checkoutId: string | null } | undefined) {
    return !!invoice && (opsSubscription(invoice.subscriptionId) || billing.store.state.checkouts.some(row => row.id === invoice.checkoutId && isOpsMade(row)));
  }
  const opsPayment = (invoiceId: string) => opsInvoice(billing.store.state.invoices.find(row => row.id === invoiceId));
  const opsLedger = (entry: LedgerEntry) => opsSubscription(entry.subscriptionId) || (!!entry.providerPaymentId && opsInvoice(billing.store.state.invoices.find(row => row.providerPaymentId === entry.providerPaymentId)));
  /** the money records without what the operator gave, so an alert's mrr and "paid before" are customers' money only */
  const ledgerState = () => withoutOps({ subscriptions: billing.store.state.subscriptions, invoices: billing.store.state.invoices, checkouts: billing.store.state.checkouts, ledger: billing.store.state.ledger ?? [] });
  function ledgerRow(entry: LedgerEntry) {
    const accountId = entry.accountId;
    const paidBefore = !!accountId && ledgerState().invoices.some(invoice => invoice.accountId === accountId && invoice.status !== "failed" && invoice.amountCents > 0);
    const email = accountId ? auth.account(accountId)?.email ?? null : null;
    // a payment's row is written before its invoice and subscription link it to a grant: judge it once the webhook settles.
    // a grant, a comp or App Review's plan is our own action: no analytics event and no money alert
    queueMicrotask(() => {
      if (opsLedger(entry)) return;
      if (accountId) {
        const props = { type: entry.type, ...(entry.amountCents !== null ? { amountCents: Math.abs(entry.amountCents) } : {}), ...(entry.mrrCents !== null ? { mrrCents: entry.mrrCents } : {}),
          ...(entry.previousMrrCents !== null ? { previousMrrCents: entry.previousMrrCents } : {}), ...(entry.plan ? { plan: entry.plan } : {}), ...(entry.interval ? { interval: entry.interval } : {}) };
        analytics.track("billing", { accountId, at: entry.at, props });
      }
      if (entry.via === "sync" || isTestAccount(email)) return;
      alerts.money(entry, { email, paidBefore, mrr: mrrAtTime(ledgerState(), now()) });
    });
  }
  const billing = createBilling({ ...(options.analytics?.db ? { aiStash: mongoAiStashStore(options.analytics.db, now) } : {}), accountExists: id => auth.account(id) !== null,
    findAccount: email => { const found = auth.accountByEmail(email); return found ? { id: found.id, email: found.email } : null; },
    mail: (cloud, letter) => {
      if (!courtesy(emailOf(cloud.accountId))) return;
      if (!letter.notice) return mail(emailOf(cloud.accountId), letter.subject, letter.text);
      const email = cloudNoticeEmail(emailCfg, { ...letter.notice, name: cloud.name });
      if (email) sendTo(cloud.accountId, letter.notice.kind === "recovered" ? "cloudStatus" : "required", email);
    },
    notify: notice => billingNotice(notice),
    accountName: id => auth.account(id)?.name ?? null, accountEmail: id => auth.account(id)?.email ?? null,
    // the invite link keeps its token in the fragment: no server, proxy or referer sees it
    teamMail: message => send(message.to, message.kind === "invite"
      ? teamInviteEmail(emailCfg, { team: message.team, from: message.from, expiresAt: message.expiresAt, link: `${emailCfg.app}/team/join#t=${message.token}` })
      : teamSeatFullEmail(emailCfg, { team: message.team, email: message.email, seats: message.seats })),
    onLedger: entry => ledgerRow(entry),
    onRetention: entry => analytics.track("cancel_flow", { accountId: entry.accountId, props: { reason: entry.reason, step: entry.step, outcome: entry.outcome } }),
    cloudStatus: (cloud, from) => analytics.track("cloud_state", { accountId: cloud.accountId, props: { cloudId: cloud.id, kind: cloud.kind, region: cloud.region, from: from ?? "new", to: cloud.status } }),
    // once per cloud, ever: clouds/service.ts keeps cloud.mailed.ready, so a restart, a wake or a rebuild never sends it again
    cloudEvent: (kind, cloud) => !courtesy(emailOf(cloud.accountId)) ? undefined : kind === "ready" ? sendTo(cloud.accountId, "cloudStatus", cloudReadyEmail(emailCfg, cloudFacts(cloud)))
      : sendTo(cloud.accountId, "required", cloudDeletedEmail(emailCfg, { name: cloud.name, at: now() })),
    // cloud lifecycle (deletions, reconciler steps, backups) never emails the operator: it is in the managed audit, admin and
    // the daily digest. a real cloud problem prints a "managed: ALERT" line, which the console tap makes an incident
    alert: entry => { if (entry.action === "starts_alert") incidents.report({ source: "log", name: "managed alert", message: `${entry.action} ${entry.cloudId}: ${entry.reason}` }); }, dataDir: options.dataDir, publicUrl, dashboard: store, now, fetch: options.fetch, wakeStats: () => slackEdge?.edge.wakeStats() ?? {}, accounts: {
    fromCookie: req => { try { return account(req); } catch (error) { if (error instanceof AuthError && error.code === "signed_out") return null; throw error; } },
    fromBearer: req => auth.appSession(req)?.account ?? null } });
  const pagesRoutes = pagesRoutesFromEnv({ dataDir: options.dataDir, publicUrl, clouds: billing.clouds, now, fetch: options.fetch });
  auth.beforeAccountDelete(async (owner, body) => {
    try { await billing.beforeAccountDelete(owner, body); } catch (error) { if (error instanceof BillingError && error.code === "billing_active") throw new AuthError(409, "billing_active", { blockers: error.blockers }); throw error; }
  });
  slackEdge = createSlackEdgeHost({ dataDir: options.dataDir, clouds: billing.clouds, env: options.slackEdge?.env ?? process.env, now, socket: options.slackEdge?.socket,
    loopback: new URL(publicUrl).protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(publicUrl).hostname) });
  const edgeHost = slackEdge;
  auth.onAccountDeleted(id => edgeHost.edge.accountDeleted(billing.clouds.list(id, true).map(cloud => cloud.id)));
  auth.onAccountDeleted(id => billing.accountDeleted(id));
  auth.extendSession(async accountId => {
    const owner = auth.account(accountId);
    // the app session must survive a billing failure; it then reads as the free plan
    try { return owner && billing.appRoutes ? await billing.sessionFields(owner) : {}; } catch { console.warn("billing: session fields failed"); return {}; }
  });
  const managedRoutes = createManagedRoutes({ clouds: billing.clouds, publicUrl: pagesUrl, now, json, readJson: async req => bodyObject(await readBody(req)),
    owner: req => {
      const owner = auth.requireWeb(req, { mutation: true }), found = auth.webSession(req);
      if (!found || found.account.id !== owner.id) throw new AuthError(401, "signed_out");
      return { id: owner.id, signedInAt: found.session.createdAt };
    } });
  const adminEmails = options.admin?.emails ?? parseAdminEmails(process.env.DUSK_ADMIN_EMAILS);
  const managedUsage = billing.clouds.managed?.usage ? billing.clouds.managed.usage.bind(billing.clouds.managed) : null;
  const infraStore = options.analytics?.infra ?? memoryInfraStore();
  const infra = createInfraCollector({ store: infraStore, clouds: () => billing.clouds.all?.() ?? [], usage: managedUsage ? (c, from) => managedUsage(c, from) : null, now });
  infra.start();
  const admin = createAdmin({ emails: adminEmails, growthEmails: options.admin?.growthEmails ?? parseAdminEmails(process.env.DUSK_GROWTH_ADMIN_EMAILS), auth, billing, workspaces: () => state.workspaces, analytics, usage, infra: { store: infraStore },
    ops: { answer: () => ops.answer(), collect: () => ops.collect(), accounts: (relays, query) => ops.accounts(relays, query) }, wakeStats: () => slackEdge?.edge.wakeStats() ?? {},
    waitlist: options.analytics?.waitlist ?? null, live: options.admin?.live ?? null, now, fetch: options.fetch, env: options.admin?.env, errors: errorsSeen, readBody, bodyObject, json, relayFixture: options.admin?.opsFixture, readCacheMs: options.admin?.readCacheMs ?? 0,
    service: { version: options.version ?? null, startedAt, environment: options.admin?.environment ?? (dev ? "development" : "production"), dataDir: options.dataDir,
      backupDir: options.admin?.backupDir ?? null, database: () => stateBackend()?.health() ?? null } });
  // only production's numbers are news: preview and development share the env but never email the admins
  const alertsEnv = options.admin?.environment ?? (dev ? "development" : "production");
  const alerts = createAlerts({ kinds: alertsEnv === "production" ? parseAlerts((options.admin?.env ?? process.env).DUSK_ADMIN_ALERTS) : new Set(), emails: () => adminEmails, mailer: outbound, sink: analytics.sink, now, email: emailCfg,
    panelUrl: `${publicUrl}${ADMIN_PATH}`, totals: (from, to) => ({ accounts: auth.directory().accounts.length, signups: auth.directory().accounts.filter(account => account.createdAt >= from && account.createdAt < to).length,
      paid: billing.store.state.invoices.filter(invoice => invoice.status === "paid" && invoice.createdAt >= from && invoice.createdAt < to).length, waitlist: null,
      money: moneyDigestOf({ ...ledgerState(), accounts: new Map(auth.directory().accounts.map(account => [account.id, { email: account.email, createdAt: account.createdAt }])) }, from, to),
      clouds: cloudDigest(billing.clouds.all?.() ?? [], from, to, id => isTestAccount(emailOf(id))) }),
    churnCents: churnThreshold((options.admin?.env ?? process.env).DUSK_ALERT_CHURN_CENTS) });
  const adminEnv = options.admin?.env ?? process.env;
  const ops = createOps({ store: options.analytics?.ops ?? memoryOpsStore(), env: adminEnv, now, fetch: options.fetch, db: options.analytics?.db ?? null, infra: infraStore,
    clouds: () => billing.clouds.all?.() ?? [],
    egress: c => { const state = c.managed ? billing.clouds.view(c).egress?.state : undefined; return state === "slowed" || state === "paused" ? state : null; },
    emails: () => new Map(auth.directory().accounts.map(account => [account.id, account.email])), customers: () => admin.customers(),
    ledger: () => billing.store.state.ledger ?? [], invoices: () => billing.store.state.invoices, errors: errorsSeen,
    incidents: options.incidents ? { report: input => incidents.report(input), recovered: (id, note) => incidents.recovered(id, note) } : null,
    selfUrl: dev ? null : new URL(publicUrl).origin, environment: options.admin?.environment ?? (dev ? "development" : "production"),
    fixture: options.admin?.opsFixture ? () => opsFixture(now()) : undefined, host: !options.admin?.opsFixture && !!options.analytics?.ops,
    mailUsage: "usage" in options.mailer && typeof options.mailer.usage === "function" ? () => (options.mailer as RoutedMailer).usage() : null });
  if (options.analytics?.ops) ops.start();
  noteMail = message => {
    const to = message.to.trim().toLowerCase(), account = auth.directory().accounts.find(item => item.email.toLowerCase() === to);
    if (account) ops.noteMail(account.id, CODE_SUBJECT.test(message.subject));
  };
  auth.onAccountCreated(owner => !isTestAddress(owner.email) && ops.noteSignup(requestIp.getStore() ?? null, owner.id));
  analytics.onTrack((name, input = {}) => {
    if (name === "checkout_paid" && input.accountId && !isTestAccount(auth.account(input.accountId)?.email)) alerts.paid(input.accountId, auth.account(input.accountId)?.email ?? null, Number(input.props?.amountCents) || 0);
  });
  const incidentRoutes = createIncidentRoutes({ incidents, json, readBody, bodyObject, rate, onClientError: (error, page) => { errorsSeen.note("page"); options.errors?.page.capture(error, { tags: { page } }); },
    admin: (req, mutation) => { const owner = auth.requireWeb(req, { mutation }); if (!admin.isAdmin(owner.email)) throw new AdminError(403, "not_admin", "This account is not an admin."); } });
  const reportMail = options.bugReports?.mail;
  const cloudSealer = createSealer((options.admin?.env ?? process.env).DUSK_CLOUD_SEAL_KEY ? parseSealKey((options.admin?.env ?? process.env).DUSK_CLOUD_SEAL_KEY!) : null);
  const bugReports = createBugReports({ store: options.bugReports?.store ?? memoryBugReportStore(), now, json, bodyObject, ip: req => rateIp(clientIp(req, options.trustProxy ?? false)),
    admin: (req, mutation) => { const owner = auth.requireWeb(req, { mutation }); if (!admin.isAdmin(owner.email)) throw new AdminError(403, "not_admin", "This account is not an admin."); return owner.id; },
    audit: (actor, action, target, detail) => { void analytics.sink.audit({ id: `aud_${random(12)}`, at: now(), actor, action, target, detail }).catch(() => {}); },
    clouds: { get: id => billing.clouds.get(id), unseal: sealed => cloudSealer.unseal(sealed) },
    // test addresses (@qa.dusk.test) never leave this service, whichever mailer is first
    mail: reportMail ? { on: reportMail.on, to: reportMail.to, mailers: reportMail.mailers.map(mailer => sinkTestMail(mailer, testMail)), email: emailCfg, panelUrl: `${publicUrl}${ADMIN_PATH}/bug-reports` } : undefined });
  const requestIp = new AsyncLocalStorage<string>();
  const limits = new Map<string, { count: number; until: number }>();
  const watching = new Map<string, number>();
  const lastWatching = new Map<string, boolean>();
  const replays = new Map<string, number>();
  // pending commands and recent results live in the store (mongodb in production), so a restart loses neither; they
  // go COMMAND_TTL_MS after they expire. a sent one with no result goes out again from a fresh process at once
  if (!Array.isArray(state.commands)) state.commands = [];
  const commands = new Map<string, StoredCommand[]>();
  for (const command of state.commands) if (command.purgeAt > now() && state.workspaces.some(ws => ws.id === command.workspaceId))
    commands.set(command.workspaceId, [...(commands.get(command.workspaceId) ?? []), command]);
  const deliveredAt = new Map<string, number>();
  const connectStates = createConnectStates(pagesUrl, now);
  // a workspace that reported shortly before a restart still counts as awake for app sign-ins
  const seen = new Map<string, number>(state.workspaces.filter(ws => ws.lastReportAt !== null).map(ws => [ws.id, ws.lastReportAt!]));
  const history = new Map<string, MachineSample[]>();
  const pulses = new Map<string, PulseRing>();
  const pulseSenders = new Set<string>();
  const waits = new Map<string, { finish: () => void; cancel: () => void }>();
  // security: a phone.pair answer carries a one-time grant secret; it lives only here, until the waiting phone takes it
  const pairWaits = new Map<string, (result: CommandResult | null) => void>();
  let closed = false;

  function json(res: ServerResponse, status: number, data: unknown) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  }
  function fail(status: number, code: string, message: string): never { throw new RequestError(status, code, message); }
  function saveCommands() { state.commands = [...commands.values()].flat(); store.changed(); }
  const commandView = ({ workspaceId: _workspace, purgeAt: _purge, ...view }: StoredCommand): CommandView => view;
  function cleanup() {
    const time = now();
    for (const [key, limit] of limits) if (limit.until <= time) limits.delete(key);
    for (const [signature, expiry] of replays) if (expiry < time) replays.delete(signature);
    for (const [id, until] of watching) if (until <= time) watching.delete(id);
    for (const [id, ring] of pulses) if ((ring.last()?.t ?? 0) < time - 5 * PULSE_WINDOW_MS) pulses.delete(id);
    const workspaces = state.workspaces.filter(ws => ws.ownerAccountId !== null || time - ws.connectedAt < 24 * hourMs);
    if (workspaces.length !== state.workspaces.length) {
      for (const ws of state.workspaces) if (!workspaces.includes(ws)) forget(ws);
      state.workspaces = workspaces;
      store.changed();
    }
    let expired = false, purged = false;
    for (const [id, queue] of commands) {
      for (const command of queue) {
        if ((command.status === "queued" || command.status === "sent") && command.expiresAt <= time) { command.status = "expired"; command.doneAt = time; expired = true; }
        if (command.status !== "sent") deliveredAt.delete(command.id);
      }
      const kept = queue.filter(command => command.purgeAt > time);
      if (kept.length !== queue.length) { purged = true; if (kept.length) commands.set(id, kept); else commands.delete(id); }
    }
    if (purged) saveCommands(); else if (expired) store.changed();
  }
  function rate(req: IncomingMessage, kind: string, max: number) {
    const key = `${kind}:${rateIp(clientIp(req, options.trustProxy ?? false))}`;
    const current = limits.get(key) ?? { count: 0, until: now() + hourMs };
    if (++current.count > max) fail(429, "rate_limited", "Try again later.");
    limits.set(key, current);
  }
  /** the owner has the dashboard open on their dusk cloud: its power policy keeps it up a while (a hint, never a wake) */
  function viewed(ws: StoredWorkspace) {
    if (ws.kind !== "vps" || !billing.clouds.managed?.noteView) return;
    const cloud = billing.clouds.all?.().find(item => item.workspaceId === ws.id && item.status === "running");
    if (cloud) billing.clouds.managed.noteView(cloud);
  }
  /** a dusk cloud at full cpu for hours on end is mining or a runaway loop: one incident a day, before instabox flags our account */
  function pinned(ws: StoredWorkspace, samples: Array<{ t: number; cpu: number }>) {
    if (!cpuPinned(samples, now())) return;
    const cloud = billing.clouds.all?.().find(item => item.workspaceId === ws.id && item.status !== "destroyed");
    if (!cloud) return;
    incidents.report({ source: "server", name: "CloudCpuPinned", key: `cloud-cpu-${cloud.id}-${new Date(now()).toISOString().slice(0, 10)}`,
      message: `dusk cloud ${cloud.id} (account ${cloud.accountId}) has used over ${CLOUD_CPU_ALERT.percent}% cpu for ${CLOUD_CPU_ALERT.hours} hours. mining or a runaway loop? look at it in admin before instabox does` });
  }
  /** a limit on a key of its own (a workspace, not an address) */
  function limitKey(key: string, max: number, message = "Try again later.") {
    const current = limits.get(key) ?? { count: 0, until: now() + hourMs };
    if (++current.count > max) fail(429, "rate_limited", message);
    limits.set(key, current);
  }
  function isAdminRequest(req: IncomingMessage) {
    const found = auth.webSession(req);
    return !!found && admin.roleOf(found.account) !== null;
  }
  /** one public origin: www sends to it, app (where the page used to live) to the page, dev home; the API still answers on
   *  app so an old build's calls keep working */
  function hostRedirect(req: IncomingMessage, url: URL) {
    const own = new URL(publicUrl).hostname, host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!host.endsWith(`.${own}`)) return null;
    const sub = host.slice(0, -own.length - 1), method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return null;
    if (sub === "www") return `${publicUrl}${url.pathname}${url.search}`;
    if (sub === "dev") return `${publicUrl}/`;
    if (sub === "app" && !ACCOUNT_PREFIXES.some(prefix => url.pathname.startsWith(prefix)) && !url.pathname.startsWith("/.well-known/"))
      return `${publicUrl}${under(url.pathname, ADMIN_PATH) ? "" : pageBase}${url.pathname === "/" && pageBase ? "" : url.pathname}${url.search}`;
    return null;
  }
  function moved(res: ServerResponse, status: 301 | 302, location: string) {
    res.writeHead(status, { location, "cache-control": status === 301 ? "public, max-age=3600" : "no-store" }); res.end();
  }
  function account(req: IncomingMessage): Account {
    return auth.requireWeb(req, { mutation: MUTATIONS.includes(req.method ?? "GET") });
  }
  function summary(ws: StoredWorkspace): WorkspaceSummary {
    return { id: ws.id, name: ws.name, kind: ws.kind, version: ws.version, connectedAt: ws.connectedAt, lastReportAt: ws.lastReportAt, freshness: freshnessOf(ws.lastReportAt, now()) };
  }
  /** a sent command with no result yet goes out again: an answer can land on a connection the workspace already lost
   *  (a cloud suspended mid long-poll), and the workspace runs each command id once */
  function due(command: CommandView) {
    return command.status === "queued" || (command.status === "sent" && now() - (deliveredAt.get(command.id) ?? 0) >= COMMAND_REDELIVER_MS);
  }
  function isWatching(ws: StoredWorkspace) { return ws.ownerAccountId !== null && (watching.get(ws.ownerAccountId) ?? -Infinity) > now(); }
  function answer(ws: StoredWorkspace): ReportAnswer {
    cleanup();
    const watched = isWatching(ws);
    lastWatching.set(ws.id, watched);
    const queued = (commands.get(ws.id) ?? []).filter(command => due(command) && command.expiresAt > now());
    const delivery = queued.map(({ id, kind, target, issuedAt, expiresAt, callback }) => ({ id, kind, target, issuedAt, expiresAt, ...(callback ? { callback } : {}) }));
    for (const command of queued) { command.status = "sent"; deliveredAt.set(command.id, now()); }
    if (queued.length) store.changed();
    return { v: 1, watching: watched, nextReportMs: watched ? FAST_REPORT_MS : SLOW_REPORT_MS, commands: delivery, ...(ws.ownerAccountId ? { usageOptOut: analytics.optedOut(ws.ownerAccountId) } : {}) };
  }
  function watch(owner: Account) {
    const wasWatching = (watching.get(owner.id) ?? -Infinity) > now();
    watching.set(owner.id, now() + 20_000);
    for (const ws of state.workspaces) if (ws.ownerAccountId === owner.id && (!wasWatching || !lastWatching.get(ws.id))) waits.get(ws.id)?.finish();
  }
  function forget(ws: StoredWorkspace) {
    waits.get(ws.id)?.cancel();
    for (const command of commands.get(ws.id) ?? []) deliveredAt.delete(command.id);
    if (commands.delete(ws.id)) saveCommands();
    seen.delete(ws.id);
    history.delete(ws.id);
    pulses.delete(ws.id);
    pulseSenders.delete(ws.id);
    lastWatching.delete(ws.id);
  }
  /** a workspace's own samples once it sends any; until then (an older version) one per report from its machine section,
   *  which would otherwise land ahead of samples taken earlier and delivered later */
  function notePulse(id: string, report: WorkspaceReport) {
    if (report.pulse && !pulseSenders.has(id)) { pulseSenders.add(id); pulses.get(id)?.clear(); }
    const fresh = (report.pulse ?? []).filter(sample => sample.t <= now() + SIGNATURE_SKEW_MS);
    const machine = pulseSenders.has(id) ? undefined : report.machine;
    if (!fresh.length && !machine) return;
    const ring = pulses.get(id) ?? new PulseRing();
    pulses.set(id, ring);
    for (const sample of fresh) ring.push(sample);
    if (machine) ring.push({ t: report.at, cpu: Math.round(machine.cpu.percent * 10) / 10,
      mem: machine.memory.totalBytes > 0 ? Math.round(Math.min(100, machine.memory.usedBytes / machine.memory.totalBytes * 100) * 10) / 10 : 0 });
  }
  function owned(id: string, owner: Account): StoredWorkspace {
    const ws = state.workspaces.find(item => item.id === id && item.ownerAccountId === owner.id);
    if (!ws) fail(404, "not_found", "Workspace not found.");
    return ws;
  }
  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_REPORT_BYTES) { req.resume(); fail(413, "too_large", "Request is too large."); }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  function bodyObject(body: Buffer): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(body.toString("utf8")); } catch { fail(400, "invalid_request", "Invalid JSON."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid_request", "Invalid request.");
    return value as Record<string, unknown>;
  }
  function verifySignature(req: IncomingMessage, body: Buffer, publicKey: string) {
    const timeHeader = req.headers["x-dusk-time"];
    const signature = req.headers["x-dusk-signature"];
    const time = typeof timeHeader === "string" && /^\d{1,16}$/.test(timeHeader) ? Number(timeHeader) : NaN;
    if (!Number.isSafeInteger(time) || Math.abs(now() - time) > SIGNATURE_SKEW_MS) fail(401, "stale_time", "Request time is invalid.");
    if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) fail(401, "bad_signature", "Signature is invalid.");
    if (replays.has(signature)) fail(401, "replay", "Request was already received.");
    let valid = false;
    try {
      valid = verify(null, Buffer.from(signedPayload(req.method ?? "GET", req.url ?? "/", time, hash(body))),
        createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));
    } catch { valid = false; }
    if (!valid) fail(401, "bad_signature", "Signature is invalid.");
    replays.set(signature, time + SIGNATURE_SKEW_MS);
  }
  function signed(req: IncomingMessage, body: Buffer): StoredWorkspace {
    const id = req.headers["x-dusk-workspace"];
    const ws = typeof id === "string" ? state.workspaces.find(item => item.id === id) : undefined;
    if (!ws) fail(401, "unknown_workspace", "Workspace is unknown.");
    verifySignature(req, body, ws.publicKey);
    seen.set(ws.id, now());
    return ws;
  }
  /** the page's files; `shell` serves its index.html whatever the path (the admin panel at /admin) */
  function staticPage(req: IncomingMessage, res: ServerResponse, shell = false) {
    if (!options.staticDir) fail(404, "not_found", "Page not found.");
    let path: string;
    try { path = decodeURIComponent((req.url ?? "/").split("?")[0]!); } catch { fail(400, "invalid_path", "Invalid path."); }
    if (shell) path = "/index.html";
    else if (pageBase) path = path === pageBase ? "/" : path.slice(pageBase.length);
    // the admin panel's own chunks (vite.config.ts puts them in assets/admin) load only for an admin
    if (under(path, "/assets/admin") && !isAdminRequest(req)) fail(404, "not_found", "Page not found.");
    if (!path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some(part => part.startsWith("."))) fail(404, "not_found", "Page not found.");
    try {
      const root = realpathSync(options.staticDir).replaceAll("\\", "/").replace(/\/$/, "");
      let file = `${root}${path}`;
      try { if (!statSync(file).isFile()) file = `${root}/index.html`; } catch { file = `${root}/index.html`; }
      file = realpathSync(file).replaceAll("\\", "/");
      if (!file.startsWith(`${root}/`) || file.slice(root.length + 1).split("/").some(part => part.startsWith("."))) fail(404, "not_found", "Page not found.");
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      let content = readFileSync(file);
      // before launch the page itself sends in-page moves outside a flow home (src/lib/prelaunch.ts)
      if (options.waitlistOnly && ext === ".html") {
        const html = content.toString("utf8"), marker = '<meta name="dusk-prelaunch" content="1">';
        content = Buffer.from(/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, tag => `${tag}${marker}`) : `${marker}${html}`);
      }
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".json": "application/json" };
      res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "cache-control": ext === ".json" ? "no-store" : ext !== ".html" && path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        "content-security-policy": ext === ".html" ? pagePolicy(content.toString("utf8")) : "frame-ancestors 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()", "cross-origin-opener-policy": "same-origin", "x-robots-tag": "noindex, nofollow" });
      res.end(content);
    } catch (error) {
      if (error instanceof RequestError) throw error;
      fail(404, "not_found", "Page not found.");
    }
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    if (closed) fail(503, "closed", "Service is closed.");
    cleanup();
    aliasLegacyHeaders(req.headers); aliasLegacyCookies(req.headers);
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", publicUrl);
    if (await pagesRoutes.handle(req, res, url)) return;
    const path = url.pathname;
    const elsewhere = hostRedirect(req, url);
    if (elsewhere) return moved(res, 301, elsewhere);
    if (link && method === "GET" && /^\/s\/[a-z0-9]{1,16}(?:\/[a-z]{1,16})?$/.test(path)) {
      // behind Cloudflare the hop before nginx is Cloudflare's: the link service counts misses by the visitor's address
      const visitor = String(req.headers["cf-connecting-ip"] ?? "").trim();
      if (isIP(visitor)) req.headers["x-real-ip"] = visitor;
      return link(req, res);
    }
    if (method === "GET" || method === "HEAD") {
      const legacy = pageBase ? LEGACY_PAGE_BASES.find(base => base !== pageBase && under(path, base)) : undefined;
      if (legacy) {
        const rest = path.slice(legacy.length);
        return moved(res, 301, `${under(rest, ADMIN_PATH) ? rest : `${pageBase}${rest}`}${url.search}`);
      }
      if (pageBase && under(path, `${pageBase}${ADMIN_PATH}`)) return moved(res, 302, `${path.slice(pageBase.length)}${url.search}`);
      if (options.waitlistOnly) {
        // the admin panel and its sign-in are used from preview before launch; /v1/admin (the API) stays
        if (under(path, ADMIN_PATH)) return moved(res, 302, "/");
        const page = under(path, pageBase) ? path.slice(pageBase.length) || "/" : PAGE_ROUTES.some(route => under(path, route)) ? path : null;
        // the app stores link to the account page for deleting an account; before launch the site's page says how
        if (page === "/account" || page === "/account/") return moved(res, 302, "/delete-account");
        if (page !== null && !prelaunchOpen(page, url.searchParams, auth.prelaunchLive)) return moved(res, 302, "/");
      }
      if (under(path, ADMIN_PATH)) {
        // only an admin's session sees the panel; signed out goes to sign-in, anyone else gets what any unknown path gets
        if (isAdminRequest(req)) return staticPage(req, res, true);
        if (!auth.webSession(req)) return moved(res, 302, `${pageBase}/sign-in?${new URLSearchParams({ next: `${path}${url.search}` })}`);
        if (site) return site(req, res);
        fail(404, "not_found", "Route not found.");
      }
    }
    // someone signed in lands on their dashboard, not the marketing home; /?home still shows the home page
    if (site && pageBase && (method === "GET" || method === "HEAD") && path === "/" && !url.searchParams.has("home") && auth.webSession(req)) return moved(res, 302, `${pageBase}/`);
    if (site && !ACCOUNT_PREFIXES.some(prefix => path.startsWith(prefix)) && !(path === pageBase || path.startsWith(`${pageBase}/`))
      && !(method === "GET" && PAGE_ROUTES.some(route => path === route || path.startsWith(`${route}/`)))) { analytics.crawlerVisit(req, new URL(publicUrl).hostname); return site(req, res); }
    if ((method === "GET" || method === "HEAD") && path === MCP_CLIENT_METADATA_PATH) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" });
      res.end(method === "HEAD" ? undefined : JSON.stringify(MCP_CLIENT_METADATA));
      return;
    }
    if ((method === "GET" || method === "HEAD") && path === "/v1/health") {
      try { accessSync(options.dataDir, constants.W_OK); } catch { return json(res, 503, { ok: false, error: "data folder is not writable" }); }
      const database = stateBackend()?.health();
      if (database && !database.ok) return json(res, 503, { ok: false, error: "database writes are failing" });
      return json(res, 200, { ok: true, version: options.version ?? null });
    }
    const mutation = MUTATIONS.includes(method);
    const appleCallback = method === "POST" && path === "/v1/auth/oauth/apple/callback" && req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
    const computersRoute = path === ACCOUNT_ROUTES.appComputers || /^\/v1\/app\/computers\/[^/]+\/pair$/.test(path);
    if (computersRoute) {
      // bearer only, never a cookie: any origin may call it, as the session and enroll-grant routes allow
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type, authorization, x-dusk-version");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    }
    // the app sends feedback here itself when its server can't: no cookie is read, and the route keeps its own hourly limits
    const reportRoute = path === BUG_REPORT_PATH;
    if (reportRoute) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "POST, OPTIONS");
      if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    }
    if (mutation && !isAppCorsRoute(path) && !computersRoute && !reportRoute && !appleCallback && path !== TRACK_PATH && path !== APP_EVENTS_PATH) {
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") fail(403, "forbidden", "JSON is required.");
      if (req.headers.origin !== undefined && req.headers.origin !== publicUrl) fail(403, "forbidden", "Origin is not allowed.");
    }
    if (await auth.handle(req, res, url, { readBody, bodyObject })) return;
    // a link grant is only ever made for the signed-in app's own account; the json and origin checks above apply
    if (method === "POST" && path === LINK_GRANT_PATH) {
      rate(req, "link-grant", 600);
      const found = auth.appSession(req);
      if (!found) fail(401, "invalid_token", "Session is invalid.");
      if (!linkGrants) fail(503, "link_grants_off", "Linking a server is not available right now.");
      return json(res, 200, signLinkGrant(found.account.id, linkGrants, now()));
    }
    // the app forgot a server it linked to this account: its workspace leaves the dashboard. only the account's own, and
    // never a dusk cloud's (that goes with the cloud itself); one already gone is not an error
    if (method === "POST" && path === ACCOUNT_ROUTES.workspaceUnlink) {
      rate(req, "workspace-unlink", 120);
      const found = auth.appSession(req);
      if (!found) fail(401, "invalid_token", "Session is invalid.");
      const data = bodyObject(await readBody(req));
      if (typeof data.workspaceId !== "string" || !/^ws_[A-Za-z0-9_-]{1,64}$/.test(data.workspaceId)) fail(400, "invalid_request", "Invalid workspace.");
      const ws = state.workspaces.find(item => item.id === data.workspaceId && item.ownerAccountId === found.account.id);
      if (!ws) return json(res, 200, { ok: true, removed: false });
      if (billing.clouds.list(found.account.id, true).some(cloud => billing.clouds.view(cloud).workspaceId === ws.id)) fail(409, "cloud_workspace", "A dusk cloud's workspace goes with the cloud.");
      forget(ws);
      void usage.forgetWorkspace(ws.id);
      state.workspaces = state.workspaces.filter(item => item !== ws);
      store.changed();
      return json(res, 200, { ok: true, removed: true });
    }
    // the phone's list of the account's computers: only its own, never a dusk cloud's workspace (the cloud row covers it)
    if (method === "GET" && path === ACCOUNT_ROUTES.appComputers) {
      rate(req, "app-computers", 1200);
      const found = auth.appSession(req);
      if (!found) fail(401, "invalid_token", "Session is invalid.");
      const clouds = new Set(billing.clouds.list(found.account.id, true).map(cloud => billing.clouds.view(cloud).workspaceId));
      const answer: AppComputersAnswer = { v: 1, computers: state.workspaces.filter(ws => ws.ownerAccountId === found.account.id && !clouds.has(ws.id))
        .map(ws => appComputer(ws, seen.get(ws.id), now())) };
      return json(res, 200, answer);
    }
    const pairPath = method === "POST" ? /^\/v1\/app\/computers\/([^/]+)\/pair$/.exec(path) : null;
    if (pairPath) {
      rate(req, "computer-pair", COMPUTER_PAIR_LIMITS.perIp);
      const found = auth.appSession(req);
      if (!found) fail(401, "invalid_token", "Session is invalid.");
      const id = decodeURIComponent(pairPath[1]!);
      // security: another account's computer reads as missing, the same as one that does not exist
      const ws = COMPUTER_ID.test(id) ? state.workspaces.find(item => item.id === id && item.ownerAccountId === found.account.id) : undefined;
      if (!ws || billing.clouds.list(found.account.id, true).some(cloud => billing.clouds.view(cloud).workspaceId === ws.id)) fail(404, "not_found", "Computer not found.");
      limitKey(`computer-pair:${found.account.id}`, COMPUTER_PAIR_LIMITS.perAccount);
      if (now() - (seen.get(ws.id) ?? -Infinity) > APP_COMMAND_ONLINE_MS) fail(409, "computer_offline", "This computer is asleep or offline.");
      const queue = commands.get(ws.id) ?? [];
      if (queue.filter(item => item.kind === "phone.pair" && (item.status === "queued" || item.status === "sent")).length >= COMPUTER_PAIR_LIMITS.pendingPerComputer) fail(429, "rate_limited", "Try again in a minute.");
      const label = [...found.session.name].filter(char => char >= " ").join("").trim().slice(0, 60) || "Phone";
      const command: StoredCommand = { id: `cmd_${random(16)}`, workspaceId: ws.id, kind: "phone.pair", target: label, issuedAt: now(), expiresAt: now() + PHONE_PAIR_COMMAND_TTL_MS,
        purgeAt: now() + 2 * COMMAND_TTL_MS, status: "queued", message: null, doneAt: null };
      queue.push(command);
      commands.set(ws.id, queue);
      saveCommands();
      const result = await new Promise<CommandResult | null>(resolve => {
        const timer = setTimeout(() => done(null), COMPUTER_PAIR_WAIT_MS);
        const done = (value: CommandResult | null) => { clearTimeout(timer); pairWaits.delete(command.id); res.off("close", gone); resolve(value); };
        const gone = () => done(null);
        pairWaits.set(command.id, done);
        res.on("close", gone);
        waits.get(ws.id)?.finish();
      });
      if (!result) fail(409, "computer_offline", "This computer did not answer.");
      const answer = result.ok && result.link ? pairAnswer(result.link, now()) : null;
      if (answer) return json(res, 200, answer);
      if (result.reason === "unreachable") fail(409, "computer_unreachable", "A phone cannot reach this computer yet.");
      fail(409, "pair_refused", "This computer did not make a pairing.");
    }
    // TURN credentials for the direct screen path, minted per signed-in app; the TURN key never leaves this service
    if (method === "POST" && path === ACCOUNT_ROUTES.screenIce) {
      rate(req, "screen-ice", 120);
      if (!auth.appSession(req)) fail(401, "invalid_token", "Session is invalid.");
      const minted = screenIce ? await screenIce.mint(now()).catch(() => null) : null;
      if (!minted) fail(503, "turn_off", "TURN is not available right now.");
      return json(res, 200, minted);
    }
    if (path === APP_NOTES_PATH) return handleAppNotes(req, res, { now, readBody: readLimited, rate, appAccount: request => auth.appSession(request)?.account.id ?? null,
      save: (accountId, workspaceId, notes, ran) => usage.ingestNotes(accountId, workspaceId, notes, ran) });
    if (await analytics.handle(req, res, url, { readBody, bodyObject, json, rate, appAccount: request => auth.appSession(request)?.account.id ?? null,
      isOwner: isAdminRequest, account: (request, strict) => {
      try { return auth.requireWeb(request, { mutation: strict }); } catch (error) { if (error instanceof AuthError && error.code === "signed_out") return null; throw error; }
    } })) return;
    if (await incidentRoutes.handle(req, res, url)) return;
    if (await bugReports.handle(req, res, url)) return;
    // preview and development only: the latest code and link mailed to a test address, for test harnesses
    if (path === "/v1/ops/test-mail" && method === "GET") {
      const token = adminEnv.DUSK_OPS_TOKEN, given = String(req.headers.authorization ?? "");
      if (!testMail.readable || !token || given.length !== token.length + 7 || !timingSafeEqual(Buffer.from(given), Buffer.from(`Bearer ${token}`))) {
        rate(req, "test-mail-denied", 20); fail(404, "not_found", "Route not found.");
      }
      const to = url.searchParams.get("to") ?? "";
      if (!isTestAddress(to)) fail(400, "invalid_request", "Only test addresses have a test mailbox.");
      const found = testMail.latest(to, Number(url.searchParams.get("since")) || 0);
      return found ? json(res, 200, found) : fail(404, "not_found", "No mail yet.");
    }
    if (path === "/v1/ops/report" && method === "POST") {
      const verdict = ops.authorizeReport(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined);
      if (verdict === "off") fail(404, "not_found", "Route not found.");
      if (verdict === "denied") { rate(req, "ops-report-denied", 20); fail(401, "unauthorized", "Not allowed."); }
      if (!await ops.report(bodyObject(await readBody(req)))) fail(400, "invalid_request", "Invalid report.");
      return json(res, 200, { ok: true });
    }
    if (await admin.handle(req, res, url)) return;
    if (method === "GET" && path === DASHBOARD_DISCOVERY_PATH) return json(res, 200, { v: 1, url: publicUrl });
    if (await edgeHost.handle(req, res, url, { readBody, bodyObject, json, signed: (request, body) => signed(request, body),
      account: (request, mutation) => auth.requireWeb(request, { mutation }) })) return;
    if (await managedRoutes.handle(req, res, url)) return;
    if (billing.clouds.managed?.handle && await billing.clouds.managed.handle(req, res, url, { publicUrl, json, readJson: async request => bodyObject(await readBody(request)),
      clientIp: request => clientIp(request, options.trustProxy ?? false) })) return;
    if (await billing.handle(req, res, url)) return;
    if (!path.startsWith("/v1/") && !path.startsWith("/.well-known/") && !path.startsWith("/api/")) {
      const page = !pageBase || path === pageBase || path.startsWith(`${pageBase}/`);
      if (page && (method === "GET" || method === "HEAD")) return staticPage(req, res);
      if (!page && method === "GET" && PAGE_ROUTES.some(route => path === route || path.startsWith(`${route}/`))) {
        res.writeHead(302, { location: `${pageBase}${req.url}`, "cache-control": "no-store" }); res.end(); return;
      }
      fail(404, "not_found", "Route not found.");
    }
    if (method === "POST" && path === "/v1/enroll") {
      rate(req, "enroll", 120);
      const body = await readBody(req), input = bodyObject(body);
      const data = parseEnrollRequest(input);
      if (input.enrollToken !== undefined && (typeof input.enrollToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.enrollToken))) fail(400, "invalid_request", "Invalid enrollment grant.");
      if (!data) fail(400, "invalid_request", "Invalid enrollment.");
      let publicKey: string;
      try {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data.publicKey)) throw new Error();
        const der = Buffer.from(data.publicKey, "base64");
        const key = createPublicKey({ key: der, format: "der", type: "spki" });
        if (key.asymmetricKeyType !== "ed25519" || !key.export({ type: "spki", format: "der" }).equals(der)) throw new Error();
        publicKey = der.toString("base64");
      } catch { fail(400, "invalid_key", "Public key is invalid."); }
      let ownerAccountId: string | null = null;
      const proven = typeof input.enrollToken === "string" || req.headers["x-dusk-signature"] !== undefined;
      if (proven) verifySignature(req, body, publicKey);
      if (typeof input.enrollToken === "string") {
        ownerAccountId = auth.consumeEnrollGrant(input.enrollToken);
        if (!ownerAccountId) fail(403, "invalid_grant", "Enrollment grant is invalid.");
        analytics.track("app_paired", { accountId: ownerAccountId, props: { via: "workspace", kind: data.kind } });
      }
      let ws = state.workspaces.find(item => item.publicKey === publicKey);
      if (ws?.ownerAccountId && !ownerAccountId) return json(res, 200, { v: 1, workspaceId: ws.id, claimUrl: `${pagesUrl}/?workspace=${ws.id}`, claimExpiresAt: 0, dashboardUrl: publicUrl });
      // a public key is not a secret: only its holder may replace an existing workspace's claim link
      if (ws && !proven) fail(401, "bad_signature", "Signature is required.");
      const token = random(24);
      if (!ws) {
        // made-up workspaces from many addresses: each is a row until it is claimed or a day passes, so their number is bounded
        if (state.workspaces.filter(item => item.ownerAccountId === null).length >= WORKSPACE_LIMITS.unclaimed) fail(503, "busy", "Too many new computers are joining right now. Try again in a few minutes.");
        ws = { id: `ws_${random(16)}`, publicKey, ownerAccountId: null, claimHash: null, claimExpiresAt: 0, name: data.name, kind: data.kind,
          version: data.version, connectedAt: now(), lastReportAt: null, lastSeq: 0, lastSeqAt: 0, report: null, sectionAt: {} };
        state.workspaces.push(ws);
      }
      if (ownerAccountId) {
        // security invariant: a grant claims only an unclaimed workspace or one its own account already owns
        if (ws.ownerAccountId !== ownerAccountId && state.workspaces.filter(item => item.ownerAccountId === ownerAccountId).length >= WORKSPACE_LIMITS.perAccount)
          fail(409, "too_many_workspaces", `An account holds at most ${WORKSPACE_LIMITS.perAccount} computers. Remove one from the dashboard first.`);
        if (ws.ownerAccountId && ws.ownerAccountId !== ownerAccountId) fail(409, "owned_elsewhere", "This workspace belongs to another Dusk account. Remove it from that account's dashboard first.");
        ws.ownerAccountId = ownerAccountId;
        ws.claimHash = null;
        ws.claimExpiresAt = 0;
        store.changed();
        return json(res, 200, { v: 1, workspaceId: ws.id, claimUrl: `${pagesUrl}/?workspace=${ws.id}`, claimExpiresAt: 0, dashboardUrl: publicUrl });
      }
      ws.claimHash = hash(token);
      ws.claimExpiresAt = now() + CLAIM_TTL_MS;
      store.changed();
      return json(res, 200, { v: 1, workspaceId: ws.id, claimUrl: `${pagesUrl}/claim#${token}`, claimExpiresAt: ws.claimExpiresAt, dashboardUrl: publicUrl });
    }
    if ((method === "POST" && path === "/v1/report") || (method === "GET" && path === "/v1/wait")) {
      const body = await readBody(req);
      if (method === "GET" && body.length) fail(400, "invalid_request", "GET body must be empty.");
      const ws = signed(req, body);
      if (method === "POST") {
        // the app reports every 3 minutes, every 5 s while someone watches; each report is a database write
        limitKey(`report:${ws.id}`, WORKSPACE_LIMITS.reportsPerHour, "Reports are too frequent.");
        const report = parseWorkspaceReport(bodyObject(body));
        if (!report) fail(400, "invalid_report", "Report is invalid.");
        if (report.seq <= ws.lastSeq && report.at - ws.lastSeqAt <= 10 * 60_000) fail(409, "old_sequence", "Report sequence is old.");
        ws.lastSeq = report.seq;
        ws.lastSeqAt = report.at;
        ws.lastReportAt = now();
        ws.kind = report.workspace.kind;
        ws.version = report.workspace.version;
        const previous = ws.report ?? { at: report.at, workspace: report.workspace };
        ws.report = { ...previous, at: report.at, workspace: report.workspace };
        for (const section of sections) if (report[section] !== undefined) {
          Object.assign(ws.report, { [section]: report[section] });
          ws.sectionAt[section] = report.at;
        }
        if (report.machine) {
          const machine = report.machine;
          const samples = history.get(ws.id) ?? [];
          samples.push({ t: report.at, cpu: machine.cpu.percent, mem: machine.memory.totalBytes > 0 ? Math.min(100, machine.memory.usedBytes / machine.memory.totalBytes * 100) : 0,
            rx: machine.network?.rxBytesPerSec ?? 0, tx: machine.network?.txBytesPerSec ?? 0 });
          history.set(ws.id, samples.slice(-240));
          pinned(ws, samples);
        }
        notePulse(ws.id, report);
        let commandsChanged = false;
        for (const result of report.results ?? []) {
          const command = commands.get(ws.id)?.find(item => item.id === result.id && (item.status === "queued" || item.status === "sent"));
          if (command) {
            commandsChanged = true;
            command.status = result.ok ? "done" : "failed"; command.message = result.message; command.doneAt = result.at;
            if (command.kind === "app.connect" && result.ok && result.url) { command.url = result.url; if (result.returnsHere && command.callback) command.returnsHere = true; }
            if (command.kind === "phone.pair") pairWaits.get(command.id)?.(result);
          }
        }
        if (ws.ownerAccountId && workspaceTurns(ws) > 0) analytics.botReplied(ws.ownerAccountId);
        // the app's switch is the account's switch: off here deletes what was stored, on again lets it flow
        if (ws.ownerAccountId && report.usageOptOut !== undefined && report.usageOptOut !== analytics.optedOut(ws.ownerAccountId)) await analytics.setOptOut(ws.ownerAccountId, report.usageOptOut);
        if (report.usage) void usage.ingest(ws.ownerAccountId, ws.id, report.usage, { kind: ws.kind, version: ws.version });
        // a plain report changes only its own workspace row: with 2000 computers reporting, diffing every row per
        // report held the whole service (measured 2026-11-14 on the contabo box)
        if (commandsChanged) store.changed(); else store.changedRow("workspaces", ws);
        return json(res, 200, answer(ws));
      }
      const seconds = Number(url.searchParams.get("wait") ?? "25");
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) fail(400, "invalid_wait", "Wait must be 1 to 30 seconds.");
      waits.get(ws.id)?.finish();
      if ((commands.get(ws.id) ?? []).some(due) || (isWatching(ws) && !lastWatching.get(ws.id))) return json(res, 200, answer(ws));
      let timer: ReturnType<typeof setTimeout>;
      const clear = () => { clearTimeout(timer); waits.delete(ws.id); res.off("close", clear); };
      const finish = () => { clear(); json(res, 200, answer(ws)); };
      // a workspace that was removed hears it is unknown; one cut off by a restart hears only that the service is closing
      const cancel = () => { clear(); if (closed) json(res, 503, { error: "Service is closed.", code: "closed" }); else json(res, 401, { error: "Workspace is unknown.", code: "unknown_workspace" }); };
      timer = setTimeout(finish, seconds * 1000);
      waits.set(ws.id, { finish, cancel });
      res.on("close", clear);
      return;
    }
    if (method === "GET" && path === "/v1/account/export") {
      const owner = auth.requireWeb(req, { mutation: false });
      const answer = auth.exportAccount(owner);
      const data = { v: 1, exportedAt: new Date(now()).toISOString(), ...answer,
        workspaces: state.workspaces.filter(ws => ws.ownerAccountId === owner.id).map(ws => ({ ...summary(ws), report: ws.report })),
        ...billing.exportAccount(owner.id) };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "content-disposition": `attachment; filename="metal-account-${new Date(now()).toISOString().slice(0, 10)}.json"` });
      res.end(JSON.stringify(data, null, 2));
      return;
    }
    if (method === "GET" && path === "/v1/workspaces") {
      const owner = account(req);
      watch(owner);
      return json(res, 200, { workspaces: state.workspaces.filter(ws => ws.ownerAccountId === owner.id).map(summary) });
    }
    if (method === "GET" && path === "/v1/connectors") {
      const owner = account(req);
      watch(owner);
      const inApp: Record<string, string[]> = {};
      const answer: ConnectorsAnswer = { byWorkspace: {}, inApp, pending: {}, available: {}, at: {} };
      for (const ws of state.workspaces) if (ws.ownerAccountId === owner.id) {
        const apps = ws.report?.apps;
        inApp[ws.id] = apps?.services.filter(service => service.via === "app" && (service.connected || service.pending)).map(service => service.slug) ?? [];
        answer.byWorkspace[ws.id] = apps?.services.filter(service => service.connected).map(service => service.slug) ?? [];
        answer.pending[ws.id] = apps?.services.filter(service => !service.connected && service.pending).map(service => service.slug) ?? [];
        answer.available[ws.id] = apps?.available ?? false;
        answer.at[ws.id] = ws.sectionAt.apps ?? null;
      }
      return json(res, 200, answer);
    }
    if (method === "POST" && path === "/v1/connect/finish") {
      const owner = account(req);
      watch(owner);
      const data = bodyObject(await readBody(req));
      const found = typeof data.state === "string" ? connectStates.take(data.state, owner.id) : null;
      if (!found || !owned(found.workspaceId, owner)) fail(404, "connect_expired", "This sign-in link expired. Connect the app again.");
      return json(res, 200, { workspaceId: found.workspaceId, slug: found.slug, outcome: data.status === "success" ? "signed-in" : "cancelled" });
    }
    if (method === "POST" && path === "/v1/claim") {
      const owner = account(req);
      const data = bodyObject(await readBody(req));
      if (typeof data.token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(data.token)) fail(404, "invalid_claim", "Claim link is invalid or expired.");
      const digest = Buffer.from(hash(data.token), "hex");
      const ws = state.workspaces.find(item => item.ownerAccountId === null && item.claimHash !== null && item.claimExpiresAt > now() && timingSafeEqual(Buffer.from(item.claimHash, "hex"), digest));
      if (!ws) fail(404, "invalid_claim", "Claim link is invalid or expired.");
      if (state.workspaces.filter(item => item.ownerAccountId === owner.id).length >= WORKSPACE_LIMITS.perAccount)
        fail(409, "too_many_workspaces", `An account holds at most ${WORKSPACE_LIMITS.perAccount} computers. Remove one from the dashboard first.`);
      ws.ownerAccountId = owner.id;
      ws.claimHash = null;
      ws.claimExpiresAt = 0;
      store.changed();
      analytics.track("app_paired", { accountId: owner.id, props: { via: "workspace", kind: ws.kind } });
      return json(res, 200, { workspace: summary(ws) });
    }
    const pulse = method === "GET" ? /^\/v1\/workspaces\/([^/]+)\/pulse$/.exec(path) : null;
    if (pulse) {
      const owner = account(req);
      const ws = owned(pulse[1]!, owner);
      watch(owner); viewed(ws);
      const after = Number(url.searchParams.get("after") ?? "0");
      const answer: PulseAnswer = { v: 1, intervalMs: PULSE_INTERVAL_MS, samples: pulses.get(ws.id)?.since(Number.isFinite(after) ? after : 0) ?? [] };
      return json(res, 200, answer);
    }
    const match = /^\/v1\/workspaces\/([^/]+)(\/commands)?$/.exec(path);
    if (match) {
      const owner = account(req);
      const ws = owned(match[1]!, owner);
      if (!match[2] && method === "GET") {
        watch(owner); viewed(ws);
        const detail: WorkspaceDetail = { workspace: summary(ws), report: ws.report, sectionAt: ws.sectionAt, history: history.get(ws.id) ?? [], commands: (commands.get(ws.id) ?? []).map(commandView) };
        return json(res, 200, detail);
      }
      if (match[2] && method === "POST") {
        const data = bodyObject(await readBody(req));
        if (!COMMAND_KINDS.includes(data.kind as CommandKind) || typeof data.target !== "string" || !data.target.length || data.target.length > 200) fail(400, "invalid_command", "Command is invalid.");
        const kind = data.kind as CommandKind, app = kind === "app.connect" || kind === "app.disconnect";
        const target = app ? appSlug(data.target) : data.target;
        if (target === null) fail(400, "invalid_command", "Command is invalid.");
        const queue = commands.get(ws.id) ?? [];
        if (queue.filter(item => item.status === "queued" || item.status === "sent").length >= 200) fail(429, "rate_limited", "Too many pending commands.");
        if (app) {
          rate(req, "app-command", 300);
          if (queue.filter(item => item.kind.startsWith("app.") && (item.status === "queued" || item.status === "sent")).length >= 5) fail(429, "rate_limited", "Too many app sign-ins at once. Try again in a minute.");
          if (now() - (seen.get(ws.id) ?? -Infinity) > APP_COMMAND_ONLINE_MS) fail(409, "workspace_offline", ws.kind === "vps"
            ? "This cloud is asleep or not answering. Wake it from clouds, then try again."
            : "Your computer is asleep. Connect from the Metal app on it, or use dusk cloud.");
        }
        const command: StoredCommand = { id: `cmd_${random(16)}`, workspaceId: ws.id, kind, target, issuedAt: now(), expiresAt: now() + COMMAND_TTL_MS,
          purgeAt: now() + 2 * COMMAND_TTL_MS, status: "queued", message: null, doneAt: null };
        if (kind === "app.connect" && data.returnHere === true) command.callback = connectStates.open(owner.id, ws.id, target!);
        queue.push(command);
        commands.set(ws.id, queue.filter(item => item.status === "queued" || item.status === "sent" || queue.indexOf(item) >= queue.length - 100));
        saveCommands();
        const view = commandView(command);
        waits.get(ws.id)?.finish();
        return json(res, 200, { command: view });
      }
      if (!match[2] && method === "PATCH") {
        const data = bodyObject(await readBody(req));
        if (typeof data.name !== "string" || !data.name.trim().length || data.name.length > 60) fail(400, "invalid_name", "Name must be 1 to 60 characters.");
        ws.name = data.name.trim();
        store.changed();
        return json(res, 200, { workspace: summary(ws) });
      }
      if (!match[2] && method === "DELETE") {
        forget(ws);
        void usage.forgetWorkspace(ws.id);
        state.workspaces = state.workspaces.filter(item => item !== ws);
        store.changed();
        return json(res, 200, { ok: true });
      }
    }
    fail(404, "not_found", "Route not found.");
  }
  return {
    auth,
    billing,
    slackEdge: edgeHost,
    analytics,
    usage,
    infra,
    handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const requestId = random(9);
      res.setHeader("x-request-id", requestId);
      res.once("finish", () => {
        if (res.statusCode === 429) ops.noteLimited(clientIp(req, options.trustProxy ?? false));
        if (res.statusCode >= 500 && !reported.has(res) && !(res.statusCode === 503 && closed))
          incidents.report({ source: "server", name: `Http${res.statusCode}`, message: `${req.method ?? "GET"} answered ${res.statusCode}`, key: `http-${res.statusCode}`, route: req.url, status: res.statusCode, requestId });
      });
      return requestIp.run(clientIp(req, options.trustProxy ?? false), () => route(req, res)).catch(error => {
        if (error instanceof RequestError || error instanceof AuthError || error instanceof AdminError || error instanceof IncidentRouteError) json(res, error.status, req.url?.startsWith("/api/cloud/") ? { error: error.code } : { error: error.message, code: error.code });
        else {
          reported.add(res);
          errorsSeen.note("service");
          options.errors?.service.capture(error, { tags: { route: (req.url ?? "/").split("?")[0]!.split("/").slice(0, 3).join("/") } });
          const err = error instanceof Error ? error : new Error(String(error));
          incidents.report({ source: "server", name: err.name, message: err.message, stack: (err.stack ?? "").split("\n").slice(1).join("\n"), route: req.url, status: 500, requestId });
          json(res, 500, req.url?.startsWith("/api/cloud/") ? { error: "failed" } : { error: "Request failed.", code: "failed" });
        }
      });
    },
    close() {
      infra.close();
      ops.close();
      edgeHost.close();
      billing.close();
      closed = true;
      for (const wait of Array.from(waits.values())) wait.cancel();
      auth.close();
      analytics.close();
      alerts.close();
      void ownIncidents?.close();
      store.close();
    },
  };
}
