import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createJsonStore } from "../billing/json-store.ts";
import { clientIp } from "../client-ip.ts";
import { DAY_MS, EVENTS, cleanProps, dayOf, isEventName, routeOf, type EventName, type Props } from "./events.ts";
import type { AnalyticsSink } from "./sink.ts";
import { cookieless, requestContext, type EventContext } from "./context.ts";
import { APP_EVENTS_PATH, TRACK_PATH, handleAppEvents, handleTrack } from "./ingest.ts";
import { createPresence } from "./presence.ts";
import { createRollups, memoryRollupStore } from "./rollup.ts";
import { DIGESTS } from "./digests.ts";
import { isAiCrawler } from "./sources.ts";

export interface AnalyticsOptions {
  sink: AnalyticsSink; dataDir: string; now?: () => number; trustProxy?: boolean;
  /** origins whose pages send site events to /v1/t: the service's own and DUSK_TRACK_ORIGINS */
  trackOrigins?: string[];
}
interface RouteHelpers {
  readBody(req: IncomingMessage): Promise<Buffer>;
  bodyObject(body: Buffer): Record<string, unknown>;
  json(res: ServerResponse, status: number, data: unknown): void;
  rate(req: IncomingMessage, kind: string, max: number): void;
  /** the signed-in account of a web request, or null; `strict` also checks the CSRF header */
  account(req: IncomingMessage, strict: boolean): { id: string } | null;
  /** the account of an app's bearer session, or null */
  appAccount(req: IncomingMessage): string | null;
  /** a signed-in admin's browser */
  isOwner(req: IncomingMessage): boolean;
}
/** `optOut`: accounts that turned "help improve Metal" off: no usage counts, notes or events from them are kept */
interface OptOutState { v: 1; optOut: string[] }

export const MAX_BATCH = 20;
export const VISIT_IDLE_MS = 30 * 60_000;
const MAX_DAILY_VISITS = 200_000;
function safeUrl(value: string, origin: string) { try { const url = new URL(value.slice(0, 1000), origin); return url.origin === origin ? url : undefined; } catch { return undefined; } }
const VISITOR = /^[A-Za-z0-9_-]{22}$/;
/** the site tracker's visitor cookie, readable here when the account page shares the site's domain */
export const visitorCookie = (req: IncomingMessage) => {
  const value = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("dusk_vid="))?.slice(9);
  return value && VISITOR.test(value) ? value : null;
};
export async function readLimited(req: IncomingMessage, max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > max) { req.resume(); throw Object.assign(new Error("Request is too large."), { status: 413, code: "too_large" }); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** a browser that asked not to be tracked (Global Privacy Control or Do Not Track) */
export const declined = (req: IncomingMessage) => req.headers["sec-gpc"] === "1" || req.headers.dnt === "1";

export function createAnalytics(options: AnalyticsOptions) {
  const { sink } = options, now = options.now ?? Date.now;
  const trackOrigins = new Set((options.trackOrigins ?? []).map(origin => { try { return new URL(origin).origin; } catch { return ""; } }).filter(Boolean));
  const store = createJsonStore<OptOutState>(join(options.dataDir, "analytics.json"), () => ({ v: 1, optOut: [] }),
    (value): value is OptOutState => !!value && typeof value === "object" && Array.isArray((value as OptOutState).optOut));
  const optOut = new Set(store.state.optOut);
  const forgetters: Array<(accountId: string) => void> = [];
  const stats = { written: 0, failed: 0, dropped: 0, lastFailureAt: null as number | null };
  // a visitor's daily id is an HMAC under a key that lives only in memory and changes every day: it counts unique
  // visitors per day and cannot link a visitor across days or back to an address
  let salt = { day: "", key: randomBytes(32) };
  let today = "";
  const seen = new Set<string>();
  const replied = new Set<string>();
  function seenOnce(key: string) {
    const day = dayOf(now());
    if (day !== today) { today = day; seen.clear(); }
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }
  const markUntil = (at: number) => Math.max(at, now()) + 3 * DAY_MS;
  const presence = createPresence(now);
  // the admin's views read digests of closed hours and days; with a database a timer keeps them built ahead of the reads
  const rollups = createRollups({ store: sink.rollups ?? memoryRollupStore(), digests: DIGESTS, now });
  if (sink.rollups) rollups.start();

  async function record(name: EventName, input: { accountId?: string | null; props?: Props; at?: number; visitor?: string | null; ctx?: EventContext } = {}) {
    const accountId = input.accountId ?? null, at = input.at ?? now(), day = dayOf(at);
    if (accountId && optOut.has(accountId)) { stats.dropped++; return; }
    try {
      await sink.insert({ id: `ev_${randomBytes(12).toString("base64url")}`, name, at, accountId, props: cleanProps(name, input.props), ...(input.ctx || input.visitor ? { ctx: { ...input.ctx, ...(input.visitor ? { visitor: input.visitor } : {}) } } : {}) });
      await sink.bump(day, name);
      if (accountId && "active" in EVENTS[name] && await sink.once(`${day}|active|${accountId}`, markUntil(at))) await sink.bump(day, "active_accounts");
      if (input.visitor && await sink.once(`${day}|visitor|${input.visitor}`, markUntil(at))) await sink.bump(day, "site_visitors");
      stats.written++;
    } catch {
      stats.failed++; stats.lastFailureAt = now();
    }
  }
  const listeners: Array<(name: EventName, input: Parameters<typeof record>[1]) => void> = [];
  /** never throws and never delays the request it describes */
  const track = (name: EventName, input?: Parameters<typeof record>[1]) => {
    void record(name, input);
    for (const listen of listeners) try { listen(name, input ?? {}); } catch { stats.failed++; }
  };

  function visitorOf(req: IncomingMessage) {
    const day = dayOf(now());
    if (salt.day !== day) salt = { day, key: randomBytes(32) };
    return createHmac("sha256", salt.key).update(`${clientIp(req, options.trustProxy ?? false)}|${req.headers["user-agent"] ?? ""}`).digest("base64url").slice(0, 22);
  }
  // a cookieless visitor's visits, by daily id: memory only, emptied with the salt
  let visitsDay = "";
  const visits = new Map<string, { session: string; last: number }>();
  function dailyVisit(req: IncomingMessage) {
    const visitor = visitorOf(req), at = now();
    if (visitsDay !== salt.day || visits.size >= MAX_DAILY_VISITS) { visitsDay = salt.day; visits.clear(); }
    let visit = visits.get(visitor);
    if (!visit || at - visit.last > VISIT_IDLE_MS) { visit = { session: randomBytes(16).toString("base64url"), last: at }; visits.set(visitor, visit); }
    visit.last = at;
    return { visitor, session: visit.session };
  }
  const anonymous = (req: IncomingMessage) => cookieless(req, options.trustProxy ?? false);
  function appActive(session: { id: string; accountId: string; platform: string | null; appVersion: string | null }) {
    if (!seenOnce(`app|${session.id}`)) return;
    const day = dayOf(now());
    void sink.once(`${day}|app|${session.id}`, markUntil(now())).then(fresh => {
      if (!fresh) return;
      const app = { ...(session.platform ? { platform: session.platform } : {}), ...(session.appVersion ? { version: session.appVersion } : {}) };
      track("app_active", { accountId: session.accountId, props: { ...(app.platform ? { platform: app.platform } : {}), ...(app.version ? { appVersion: app.version } : {}) }, ctx: { session: session.id, app } });
    }, () => { stats.failed++; });
  }
  function botReplied(accountId: string) {
    if (replied.has(accountId)) return;
    replied.add(accountId);
    void sink.once(`first_bot_reply|${accountId}`, null).then(fresh => { if (fresh) track("first_bot_reply", { accountId }); }, () => { replied.delete(accountId); stats.failed++; });
  }
  function setOptOut(accountId: string, value: boolean) {
    if (value) optOut.add(accountId); else optOut.delete(accountId);
    store.state.optOut = [...optOut];
    store.commit();
    if (value) { for (const fn of forgetters) try { fn(accountId); } catch { stats.failed++; } return sink.forget(accountId).catch(() => { stats.failed++; }); }
  }
  /** an AI assistant's crawler asking the site for a page (robots.txt and llms.txt included) */
  function crawlerVisit(req: IncomingMessage, host: string | null) {
    const bot = isAiCrawler(String(req.headers["user-agent"] ?? ""));
    if (!bot || req.method !== "GET") return;
    const raw = (req.url ?? "/").split("?")[0]!;
    const path = /^\/(robots\.txt|llms(-full)?\.txt|sitemap\.xml)$/.test(raw) ? raw : routeOf(raw) ?? "/";
    void sink.crawl({ at: now(), bot: bot.bot, kind: bot.kind, path, host }).catch(() => { stats.failed++; });
  }
  function identify(accountId: string, ctx: { visitor?: string; install?: string }, via: "page" | "app") {
    const id = ctx.visitor ?? ctx.install;
    if (!id || optOut.has(accountId) || !seenOnce(`identify|${id}|${accountId}`)) return;
    void sink.once(`identify|${id}|${accountId}`, null).then(fresh => { if (fresh) track("identify", { accountId, props: { via }, ctx }); }, () => { stats.failed++; });
  }
  async function forget(accountId: string) {
    replied.delete(accountId);
    if (optOut.delete(accountId)) { store.state.optOut = [...optOut]; store.commit(); }
    await sink.forget(accountId).catch(() => { stats.failed++; });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, helpers: RouteHelpers): Promise<boolean> {
    const path = url.pathname, method = req.method ?? "GET";
    if (path === TRACK_PATH || path === APP_EVENTS_PATH) {
      const deps = { track, now, trustProxy: options.trustProxy ?? false, origins: trackOrigins, readBody: readLimited, rate: helpers.rate, isOwner: helpers.isOwner,
        appAccount: helpers.appAccount, identify, declined, cookieless: anonymous, dailyVisit, present: presence.touch };
      await (path === TRACK_PATH ? handleTrack(req, res, deps) : handleAppEvents(req, res, deps));
      return true;
    }
    if (path === "/v1/events" && method === "POST") {
      const publicOrigin = `${url.protocol}//${url.host}`;
      helpers.rate(req, "events", 3000);
      const input = helpers.bodyObject(await helpers.readBody(req));
      const list = Array.isArray(input.events) ? input.events : null;
      if (!list || list.length < 1 || list.length > MAX_BATCH) { helpers.json(res, 400, { error: "Invalid request.", code: "invalid_request" }); return true; }
      if (declined(req)) { res.writeHead(204, { "cache-control": "no-store" }); res.end(); return true; }
      let owner: { id: string } | null = null;
      try { owner = helpers.account(req, true); } catch { owner = null; }
      if (owner) helpers.rate(req, `events:${owner.id}`, 1500);
      const session = typeof input.session === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(input.session) ? input.session : undefined;
      const referrer = typeof input.referrer === "string" ? input.referrer.slice(0, 500) : undefined;
      const visitor = anonymous(req) ? visitorOf(req) : visitorCookie(req) ?? (typeof input.visitor === "string" && VISITOR.test(input.visitor) ? input.visitor : null);
      if (owner && visitor) identify(owner.id, { visitor }, "page");
      const base = requestContext(req, { publicOrigin, trustProxy: options.trustProxy ?? false, referrer, url: typeof input.landing === "string" ? safeUrl(input.landing, publicOrigin) : undefined });
      for (const item of list as unknown[]) {
        const event = item && typeof item === "object" ? item as Record<string, unknown> : {};
        if (!isEventName(event.name) || EVENTS[event.name].source !== "page") continue;
        const view = event.name === "page_view" || event.name === "page_leave";
        if (!owner && !view) continue;
        const raw = event.props && typeof event.props === "object" ? event.props as Record<string, unknown> : {};
        const props = view ? { ...raw, path: routeOf(String(raw.path ?? "")) ?? "" } : event.props;
        const ctx: EventContext = { ...base, ...(session ? { session } : {}), ...(visitor && owner ? { visitor } : {}), ...(view && typeof (props as Props).path === "string" ? { page: (props as Props).path as string } : {}) };
        track(event.name, { accountId: owner?.id ?? null, props: props as Props, ctx, visitor: owner ? null : visitor ?? visitorOf(req) });
      }
      res.writeHead(204, { "cache-control": "no-store" }); res.end();
      return true;
    }
    if (path === "/v1/account/analytics" && (method === "GET" || method === "PUT")) {
      const owner = helpers.account(req, method === "PUT");
      if (!owner) { helpers.json(res, 401, { error: "Sign in to continue.", code: "signed_out" }); return true; }
      if (method === "PUT") {
        const input = helpers.bodyObject(await helpers.readBody(req));
        if (typeof input.optOut !== "boolean") { helpers.json(res, 400, { error: "Invalid request.", code: "invalid_request" }); return true; }
        await setOptOut(owner.id, input.optOut);
      }
      helpers.json(res, 200, { optOut: optOut.has(owner.id) });
      return true;
    }
    return false;
  }

  return { sink, presence, track, record, identify, crawlerVisit, onTrack: (fn: (name: EventName, input: Parameters<typeof record>[1]) => void) => { listeners.push(fn); }, appActive, botReplied, setOptOut, forget, handle, stats, optedOut: (accountId: string) => optOut.has(accountId),
    onForget: (fn: (accountId: string) => void) => { forgetters.push(fn); }, rollups, close: () => { rollups.stop(); return store.close(); } };
}
export type Analytics = ReturnType<typeof createAnalytics>;
