import { cleanSignal, localeOf, screenBucket } from "../../shared/product-signals";
import { activeLocale } from "./i18n";
import { readSkinChoice, resolveSkin } from "./skins";
export const APP_FEATURES = ["bot_created", "bot_edited", "bot_deleted", "routine_created", "routine_edited", "routine_deleted", "routine_ran", "room_created", "computer_used",
  "voice_used", "call_started", "file_uploaded", "app_connected", "cloud_opened", "chat_opened", "memory_edited", "skill_added", "webhook_created", "phone_paired",
  "search_used", "settings_opened", "settings_changed", "reaction_added", "team_imported"] as const;
type Feature = typeof APP_FEATURES[number];
type Platform = "darwin" | "win32" | "linux" | "ios" | "android";
type Props = Record<string, string | number | boolean>;
type Event = { name: string; at: number; props: Props };
/** a transport that posts for this page (the desktop's main process), in place of `origin` and `token` */
type Batch = { install: string; session: string; events: Event[] };
type Relay = { send(batch: Batch): Promise<unknown>; clear(): Promise<unknown>; last?(batch: Batch): Promise<unknown> };
type Options = { origin: string | null; token: string | null; platform: Platform; version: string; kind: "desktop" | "mobile"; force?: boolean; relay?: Relay };
type Pending = { event: Event; retried: boolean };
const ID = /^[A-Za-z0-9_-]{16,40}$/;
const WORD = /^[a-z0-9_]{1,40}$/;
const EXTRA_KEY = /^[a-z][a-z_]{0,19}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const PLATFORMS: readonly string[] = ["darwin", "win32", "linux", "ios", "android"];
const started = Date.now();
let options: Options | null = null;
let forced = false;
let optedOut = false;
let opened = false;
let closed = false;
let listening = false;
let install = "";
let session = "";
let lastScreen = "";
let queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sent = 0;
let replies = 0;
let latencies: number[] = [];
let revision = 0;
const sends = new Map<string, { at: number; message?: string }>();
const firstReplies = new Map<string, number>();
const routineRuns = new Set<string>();

function clear(): void {
  queue = [];
  sent = replies = 0;
  latencies = [];
  sends.clear();
  firstReplies.clear();
  routineRuns.clear();
  lastScreen = "";
  clearTimeout(timer);
  timer = undefined;
  ++revision;
}

/** on by default in the desktop app (an opt-out): "help improve Metal" off stops everything. The phone app (and a page
 * that hasn't said which app it is yet) sends nothing unless the switch was turned on there. */
export function usageAnalyticsEnabled(): boolean {
  try {
    const saved = localStorage.getItem("dusk-usage-analytics");
    optedOut = saved === "off" || (options?.kind !== "desktop" && saved !== "on");
  } catch {
    // no storage: the choice made in this session stands; the phone app stays off
    if (options?.kind !== "desktop") optedOut = true;
  }
  const enabled = !optedOut && (import.meta.env?.MODE !== "test" || forced);
  if (!enabled) clear();
  return enabled;
}

export function setUsageAnalytics(enabled: boolean): void {
  optedOut = !enabled;
  try { localStorage.setItem("dusk-usage-analytics", enabled ? "on" : "off"); } catch {}
  if (!enabled) { clear(); options?.relay?.clear().catch(() => {}); }
}

function randomId(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function identity(): void {
  if (!install) {
    try { install = localStorage.getItem("dusk-install-id") ?? ""; } catch {}
    if (!ID.test(install)) {
      install = randomId();
      try { localStorage.setItem("dusk-install-id", install); } catch {}
    }
  }
  session ||= randomId();
}

function schedule(): void {
  if (!queue.length && !sent && !replies) { clearTimeout(timer); timer = undefined; return; }
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; void flush(); }, 30_000);
}

function route(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
  try {
    const clean = decodeURIComponent(path.split(/[?#]/)[0]).toLowerCase().replace(/\/+$/, "") || "/";
    const folded = clean.split("/").map(part => /\d/.test(part) || part.length > 24 || /^(?:ws_|acct_|bot_)/.test(part) || /^c[0-9a-f]+$/.test(part) ? ":id" : part).join("/");
    return /^\/[a-z0-9/:_-]{0,119}$/.test(folded) ? folded : null;
  } catch { return null; }
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 1e12;
const word = (value: unknown): value is string => typeof value === "string" && WORD.test(value);

function cleanProps(name: string, props: Record<string, unknown>): Props | null {
  switch (name) {
    case "app_open": return (props.kind === "desktop" || props.kind === "mobile") && PLATFORMS.includes(String(props.platform)) && typeof props.appVersion === "string" && VERSION.test(props.appVersion)
      ? { kind: props.kind, platform: String(props.platform), appVersion: props.appVersion } : null;
    case "app_close": return count(props.ms) ? { ms: props.ms } : null;
    case "app_screen": { const screen = typeof props.screen === "string" ? route(props.screen) : null; return screen ? { screen } : null; }
    case "app_feature": return APP_FEATURES.includes(props.feature as Feature) ? { feature: props.feature as Feature } : null;
    case "app_messages": return count(props.sent) && count(props.replies) && count(props.latencyMs) ? { sent: props.sent, replies: props.replies, latencyMs: props.latencyMs } : null;
    case "app_error": return word(props.kind) && word(props.code) ? { kind: props.kind, code: props.code } : null;
    case "app_pair_failed": return word(props.reason) ? { reason: props.reason } : null;
    case "app_action": {
      if (!word(props.name)) return null;
      const clean: Props = { name: props.name };
      let extras = 0;
      for (const [key, value] of Object.entries(props)) {
        if (extras >= 8) break;
        if (key === "name" || !EXTRA_KEY.test(key)) continue;
        if (word(value) || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 1e12) || typeof value === "boolean") {
          clean[key] = value as string | number | boolean;
          ++extras;
        }
      }
      return clean;
    }
    case "app_feedback": return Number.isInteger(props.score) && (props.score as number) >= 1 && (props.score as number) <= 5 && word(props.moment)
      ? { score: props.score as number, moment: props.moment } : null;
    default: return null;
  }
}

export function track(name: string, props: Record<string, unknown> = {}): void {
  try {
    if (!usageAnalyticsEnabled()) return;
    const clean = cleanProps(name, props);
    if (!clean) return;
    queue.push({ event: { name, at: Date.now(), props: clean }, retried: false });
    if (queue.length > 200) queue.splice(0, queue.length - 200);
    listen();
    schedule();
  } catch {}
}

export function screen(path: string): void {
  if (!usageAnalyticsEnabled()) return;
  const folded = route(path);
  if (!folded || folded === lastScreen) return;
  lastScreen = folded;
  track("app_screen", { screen: folded });
}

export type SharingPlace = "settings" | "first_run";
/** the "help improve Metal" switch moved in `where`. On is an ordinary event. Off drops everything still queued and
 * sends this one event, once and without retries; nothing follows it. */
export function usageSharingChanged(on: boolean, where: SharingPlace): void {
  try {
    const props = cleanProps("app_action", { name: "usage_sharing", on, where });
    if (on) { setUsageAnalytics(true); track("app_action", props ?? {}); void flush(); return; }
    const wasOn = usageAnalyticsEnabled();
    const current = options;
    setUsageAnalytics(false);
    if (!wasOn || !props || !current || !(current.origin || current.relay)) return;
    identity();
    const batch: Batch = { install, session, events: [{ name: "app_action", at: Date.now(), props }] };
    if (current.relay) { void current.relay.last?.(batch)?.catch(() => {}); return; }
    void fetch(`${current.origin}/v1/app/events`, {
      method: "POST", keepalive: true, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json", ...(current.token ? { Authorization: `Bearer ${current.token}` } : {}) },
      body: JSON.stringify({ ...batch, platform: current.platform, version: current.version }),
    }).catch(() => {});
  } catch {}
}

export function feature(name: Feature): void { track("app_feature", { feature: name }); }

let settingsOpenedAt = 0, settingsChangedSince = false;
export function settingsOpened(): void { settingsOpenedAt = Date.now(); settingsChangedSince = false; feature("settings_opened"); }
/** a change the person asked for while Settings was open */
export function settingsChange(): void { if (settingsOpenedAt) settingsChangedSince = true; }
export function settingsClosed(): void {
  if (!settingsOpenedAt) return;
  action("settings_closed", { changed: settingsChangedSince, ms: Math.max(0, Date.now() - settingsOpenedAt) });
  settingsOpenedAt = 0;
}
const REFUSED_STATUSES = new Set([403, 409, 423, 429]);
/** the API path of a request as one word with its ids folded: ".../api/bots/<id>/messages?x" is "bots_id_messages" */
export function apiRouteWord(url: string): string | null {
  let pathname: string;
  try { pathname = new URL(url, "http://local").pathname; } catch { return null; }
  const at = pathname.indexOf("/api/");
  const folded = at < 0 ? null : route(pathname.slice(at + 4));
  if (!folded || folded === "/") return null;
  const word = folded.slice(1).replace(/:id/g, "id").replace(/[/-]+/g, "_").slice(0, 40).replace(/_+$/, "");
  return /^[a-z][a-z0-9_]{0,39}$/.test(word) ? word : null;
}
/** the workspace said no to a request (busy, a limit, a permission): its status, fixed code and folded route, never its message */
export function requestRefused(status: number, body: unknown, url = ""): void {
  if (!REFUSED_STATUSES.has(status)) return;
  const answer = body && typeof body === "object" ? body as { code?: unknown; error?: unknown } : {};
  const raw = typeof answer.code === "string" ? answer.code : typeof answer.error === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(answer.error) ? answer.error : "none";
  const code = raw.replace(/-/g, "_").toLowerCase();
  const at = apiRouteWord(url);
  action("refused", { by: "request", status, code: /^[a-z][a-z0-9_]{0,39}$/.test(code) ? code : "other", ...(at ? { route: at } : {}) });
}
export function action(name: string, props?: Record<string, unknown>): void { track("app_action", { ...props, name }); }
export function feedback(score: number, moment: string): void { track("app_feedback", { score, moment }); }
export function error(kind: string, code: string): void { track("app_error", { kind, code }); }
export function pairFailed(reason: string): void { track("app_pair_failed", { reason }); }
export function messageSent(): void { if (usageAnalyticsEnabled()) { ++sent; schedule(); } }
export function replyReceived(latencyMs: number): void {
  if (!usageAnalyticsEnabled() || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs >= 1e12) return;
  ++replies;
  latencies.push(Math.round(latencyMs));
  schedule();
}

export async function flush(): Promise<void> {
  try {
    clearTimeout(timer);
    timer = undefined;
    if (!usageAnalyticsEnabled() || !(options?.origin || options?.relay)) { schedule(); return; }
    identity();
    if (sent || replies) {
      latencies.sort((a, b) => a - b);
      const middle = Math.floor(latencies.length / 2);
      const latencyMs = latencies.length ? Math.round(latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2) : 0;
      track("app_messages", { sent, replies, latencyMs });
      sent = replies = 0;
      latencies = [];
    }
    const pending = queue.splice(0);
    const stamp = revision;
    const current = options;
    const failed = await Promise.all(Array.from({ length: Math.ceil(pending.length / 50) }, async (_, index): Promise<Pending[]> => {
      const batch = pending.slice(index * 50, (index + 1) * 50);
      try {
        if (current.relay) { await current.relay.send({ install, session, events: batch.map(item => item.event) }); return []; }
        await fetch(`${current.origin}/v1/app/events`, {
          method: "POST", keepalive: true, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
          headers: { "content-type": "application/json", ...(current.token ? { Authorization: `Bearer ${current.token}` } : {}) },
          body: JSON.stringify({ install, session, platform: current.platform, version: current.version, events: batch.map(item => item.event) }),
        });
        return [];
      } catch {
        return batch.filter(item => !item.retried).map(item => ({ ...item, retried: true }));
      }
    }));
    if (stamp === revision && usageAnalyticsEnabled()) queue = [...failed.flat(), ...queue].slice(-200);
    schedule();
  } catch {}
}

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flush(); });
  window.addEventListener("pagehide", () => {
    if (!closed) { closed = true; track("app_close", { ms: Math.max(0, Date.now() - started) }); }
    void flush();
  });
  window.addEventListener("pageshow", () => { closed = false; });
  // the browser's ResizeObserver loop notice is not a failure: nothing broke and nothing is lost
  window.addEventListener("error", event => { if (!/ResizeObserver loop/.test(event.message ?? "")) error("window", "error"); });
  window.addEventListener("unhandledrejection", () => error("window", "rejection"));
  window.addEventListener("storage", event => { if (event.key === "dusk-usage-analytics") usageAnalyticsEnabled(); });
}

export function configure(next: Options): void {
  try {
    forced = next.force === true;
    let origin: string | null = null;
    if (next.origin) {
      const url = new URL(next.origin);
      if (url.origin === next.origin.replace(/\/$/, "") && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) origin = url.origin;
    }
    options = { ...next, origin, version: VERSION.test(next.version) ? next.version : "0.0.0" };
    if (!usageAnalyticsEnabled()) return;
    listen();
    if ((origin || next.relay) && !opened) {
      opened = true;
      track("app_open", { kind: next.kind, platform: next.platform, appVersion: options.version });
      const env = environment(next.platform, typeof window === "undefined" ? undefined : window.duskDesktop?.arch);
      if (env) action("env", env);
    }
    schedule();
  } catch {}
}

export function noteMessageSent(sendId: string): void {
  if (!usageAnalyticsEnabled() || sends.has(sendId)) return;
  messageSent();
  sends.set(sendId, { at: Date.now() });
  if (sends.size > 200) sends.delete(sends.keys().next().value!);
}

export function noteAcceptedMessage(sendId?: string, messageId?: string): void {
  if (!sendId || !messageId) return;
  const send = sends.get(sendId);
  if (send) send.message = messageId;
}

export function noteReplyTurn(turnId?: string, requestMessageId?: string): void {
  if (!usageAnalyticsEnabled()) return;
  const now = Date.now();
  if (turnId && !firstReplies.has(turnId)) {
    firstReplies.set(turnId, now);
    if (firstReplies.size > 200) firstReplies.delete(firstReplies.keys().next().value!);
  }
  if (!requestMessageId) return;
  for (const [id, send] of sends) {
    if (send.message !== requestMessageId) continue;
    sends.delete(id);
    replyReceived((turnId ? firstReplies.get(turnId) ?? now : now) - send.at);
    break;
  }
}

export function pairingFailure(code: string): void {
  const reason = ({ expired: "expired_code", unreachable: "network", "relay-unavailable": "network", refused: "refused", used: "used_code", mismatch: "mismatch", invalid: "invalid_code", unsupported: "unsupported" } as Record<string, string>)[code] ?? "unknown";
  pairFailed(reason);
}

export async function observePairing<T>(task: () => Promise<T>): Promise<T> {
  try { return await task(); }
  catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    pairingFailure(typeof code === "string" ? code : "unknown");
    throw cause;
  }
}

export function noteRoutineRun(id: string, status: string): void {
  if (!usageAnalyticsEnabled() || !["running", "waiting", "completed"].includes(status) || routineRuns.has(id)) return;
  routineRuns.add(id);
  if (routineRuns.size > 200) routineRuns.delete(routineRuns.values().next().value!);
  feature("routine_ran");
}

/** the setup this app runs in, as words and counts only (shared/product-signals.ts env) */
export function environment(platform: Platform, arch?: string): Record<string, string | number> | null {
  try {
    const now = new Date();
    const scheme = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).colorScheme;
    const dark = scheme.includes("dark") || (!scheme && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
    const notifications = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
    const props = { os: platform, arch: arch === "x64" || arch === "arm64" ? arch : "other", locale: localeOf(activeLocale()), screen: screenBucket(typeof window === "undefined" ? 0 : window.innerWidth),
      theme: dark ? "dark" : "light", skin: resolveSkin(readSkinChoice()).replace(/-/g, "_"), notifications, hour: now.getHours() };
    return cleanSignal("env", props, "app") as Record<string, string | number> | null;
  } catch { return null; }
}
