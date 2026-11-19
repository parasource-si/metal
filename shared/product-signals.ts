// the named product signals beyond bot turns: what each may carry, key by key. Security: every value is a word from a
// fixed list, a short code-defined name, a count or a flag; a signal with any other key or value is dropped whole, so
// text a person typed, file names, urls and ids can never pass.
import { USAGE_APPS, USAGE_CATEGORIES, USAGE_ENGINES, USAGE_FROM, USAGE_REASONS, USAGE_RUN_TRIGGERS, USAGE_TOOLS } from "./usage-signals.ts";

type Check = (value: unknown) => boolean;
const oneOf = (...values: readonly string[]): Check => value => typeof value === "string" && values.includes(value);
const between = (min: number, max: number): Check => value => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
/** a name the code defines (a config field, a skin id with "_" for "-"): never anything a person types */
const codeName: Check = value => typeof value === "string" && /^[a-z][a-zA-Z0-9_]{0,31}$/.test(value);
const flag: Check = value => typeof value === "boolean";
const count: Check = value => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 1e12;
/** a short lowercase code the program defines (a refusal's code), never text a person typed */
const code: Check = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value);
const appSlug: Check = value => typeof value === "string" && USAGE_APPS.includes(value);

/** the app's languages, with "_" for "-" so they pass as app event words */
export const LOCALES = ["en", "de", "es", "fr", "hi", "ja", "pt_br", "zh", "zh_tw", "uk", "vi", "tr", "pl", "ru", "it", "ko", "other"] as const;
export const ATTACHMENT_KINDS = ["image", "pdf", "doc", "sheet", "slides", "text", "audio", "video", "archive", "other"] as const;
export const SIZE_BUCKETS = ["lt100k", "lt1m", "lt10m", "gte10m"] as const;
export const SCREEN_BUCKETS = ["xs", "s", "m", "l", "xl"] as const;

/** the in-app account sign-in funnel's steps, how a person signed in, and why an attempt failed (a fixed code, never an
 * email, a token or a message) */
export const ACCOUNT_SIGN_IN_STEPS = ["shown", "method", "handoff", "returned", "cancelled", "skipped", "error", "back"] as const;
export const ACCOUNT_SIGN_IN_METHODS = ["google", "apple", "email"] as const;
export const ACCOUNT_SIGN_IN_ERRORS = ["invalid_email", "rate_limited", "failed", "wrong_code", "expired", "signup_closed", "device_limit", "sso", "two_factor",
  "browser", "storage", "other"] as const;

/** how a person's follow-up right after a reply reads, classified on their computer; the words never leave it */
export const CONFUSION_KINDS = ["repeat", "rephrase", "retried", "what_mean", "why", "how_do_i", "corrective"] as const;
export const CRASH_KINDS = ["page", "gpu", "utility", "server", "other"] as const;
export const UPDATE_FAIL_STAGES = ["manifest", "checksum", "download", "install", "other"] as const;
export const DOWNLOAD_FAIL_REASONS = ["network", "checksum", "http", "disk", "unsupported", "other"] as const;

/** where a signal may come from: the apps (as an app_action), the workspace (in its usage report), or either ("any": the
 * experience signals, which a desktop's workspace hands to its app and a cloud's rides its report) */
export const SIGNALS = {
  /** once per app start: the setup a person runs Metal in, and the local hour; at most 8 keys, the app action limit */
  env: { source: "app", props: { os: oneOf("darwin", "win32", "linux", "ios", "android", "other"), arch: oneOf("x64", "arm64", "other"), locale: oneOf(...LOCALES),
    screen: oneOf(...SCREEN_BUCKETS), theme: oneOf("light", "dark"), skin: codeName, notifications: oneOf("granted", "denied", "default", "unsupported"), hour: between(0, 23) } },
  /** a step of the first run's Dusk account sign-in: via is the browser handoff, an emailed code or a magic link;
   * "back" is the website sending the person back to the app (link: the app as it was, or the cloud sheet) */
  account_sign_in: { source: "app", props: { step: oneOf(...ACCOUNT_SIGN_IN_STEPS), method: oneOf(...ACCOUNT_SIGN_IN_METHODS), via: oneOf("browser", "code", "link"),
    code: oneOf(...ACCOUNT_SIGN_IN_ERRORS), link: oneOf("open", "cloud") } },
  /** an AI sign-in started, finished or failed, by engine family */
  engine_sign_in: { source: "workspace", props: { engine: oneOf(...USAGE_ENGINES), outcome: oneOf("started", "succeeded", "failed", "expired", "cancelled"), reason: oneOf(...USAGE_REASONS) } },
  /** a file attached to a chat: its kind and size bucket, never its name */
  attachment: { source: "workspace", props: { kind: oneOf(...ATTACHMENT_KINDS), size: oneOf(...SIZE_BUCKETS) } },
  /** which setting changed: the config field's name, never its value */
  setting_changed: { source: "workspace", props: { key: codeName } },
  chat_deleted: { source: "workspace", props: {} },
  // experience signals: how turns went, where people got stuck, and what got done (shared/experience-signals.ts groups them)
  /** a turn that ended in an error: the engine family and the error's category, never its text (timeouts and rate limits are reasons) */
  turn_failed: { source: "any", props: { engine: oneOf(...USAGE_ENGINES), reason: oneOf(...USAGE_REASONS), from: oneOf(...USAGE_FROM), room: flag } },
  /** the person stopped a turn before it ended */
  turn_stopped: { source: "any", props: { engine: oneOf(...USAGE_ENGINES), from: oneOf(...USAGE_FROM), ms: count } },
  /** a tool call that failed inside a turn: the tool's family and, for an app, its slug */
  tool_failed: { source: "any", props: { tool: oneOf(...USAGE_TOOLS), app: appSlug, engine: oneOf(...USAGE_ENGINES), reason: oneOf(...USAGE_REASONS) } },
  /** a turn that finished and used tools: how many tool families, and what it was about */
  turn_done: { source: "any", props: { engine: oneOf(...USAGE_ENGINES), tools: count, category: oneOf(...USAGE_CATEGORIES), from: oneOf(...USAGE_FROM), room: flag } },
  /** a routine run ended */
  routine_done: { source: "any", props: { outcome: oneOf("ok", "failed", "cancelled"), trigger: oneOf(...USAGE_RUN_TRIGGERS), reason: oneOf(...USAGE_REASONS) } },
  /** a person answered an approval card */
  approval: { source: "any", props: { decision: oneOf("granted", "denied"), about: code } },
  /** a bot changed its own setup because the person asked it to in chat (a profile, model, skill or access level), applied
   * with or without a card */
  talk_change: { source: "any", props: { about: oneOf("profile", "model", "skill", "level", "self", "routine") } },
  /** something the person or a bot asked for was refused: by a policy (permission), or a request the workspace answered no
   * to (busy, a limit, a permission), with its fixed code and status; `route` is the request's API path as one word with
   * its ids folded ("bots_id_messages"), never an id */
  refused: { source: "any", props: { by: oneOf("policy", "request"), code, status: between(400, 599), route: code } },
  /** the person's next message right after a reply read as confusion or a retry (classified locally, never sent as text) */
  confused: { source: "any", props: { kind: oneOf(...CONFUSION_KINDS), after: oneOf("reply", "failed") } },
  /** an AI engine's sign-in failed */
  engine_sign_in_failed: { source: "any", props: { engine: oneOf(...USAGE_ENGINES), reason: oneOf(...USAGE_REASONS) } },
  /** an @devs report left the workspace, or could not */
  devs_report: { source: "any", props: { outcome: oneOf("sent", "failed") } },
  /** a bot or a room came to be, from the app or by talking */
  created: { source: "any", props: { what: oneOf("bot", "room") } },
  /** a bot's reply carried a file it made: its kind, never its name */
  file_made: { source: "any", props: { kind: oneOf(...ATTACHMENT_KINDS) } },
  /** the built-in browser's download failed */
  browser_download_failed: { source: "any", props: { reason: oneOf(...DOWNLOAD_FAIL_REASONS) } },
  /** a process of the desktop app went away: which, and Electron's reason word */
  crash: { source: "app", props: { kind: oneOf(...CRASH_KINDS), reason: code } },
  /** the app's own update failed at this stage, and why as a short code word (an http status, "stalled", "translocated") */
  update_failed: { source: "app", props: { stage: oneOf(...UPDATE_FAIL_STAGES), reason: code } },
  /** the first start of a newer version of the app: installed by its own updater, or by hand (a download, a reinstall) */
  app_updated: { source: "app", props: { how: oneOf("self", "manual") } },
  /** Settings closed: whether anything changed while it was open, and for how long it was open */
  settings_closed: { source: "app", props: { changed: flag, ms: count } },
} as const satisfies Record<string, { source: "app" | "workspace" | "any"; props: Record<string, Check> }>;
export type SignalName = keyof typeof SIGNALS;
export type SignalProps = Record<string, string | number | boolean>;
export const isSignalName = (value: unknown): value is SignalName => typeof value === "string" && Object.hasOwn(SIGNALS, value);

/** a signal's props exactly as allowed, or null when any key or value is not; an app action's own `name` stays out */
export function cleanSignal(name: unknown, props: unknown, source?: "app" | "workspace"): SignalProps | null {
  const from: string = isSignalName(name) ? SIGNALS[name].source : "";
  if (!isSignalName(name) || (source && from !== "any" && from !== source) || !props || typeof props !== "object" || Array.isArray(props)) return null;
  const allowed: Record<string, Check> = SIGNALS[name].props, out: SignalProps = {};
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (key === "name" && value === name) continue;
    const check = allowed[key];
    if (!check || !check(value)) return null;
    out[key] = value as string | number | boolean;
  }
  return out;
}

export const sizeBucket = (bytes: number): (typeof SIZE_BUCKETS)[number] => bytes < 100_000 ? "lt100k" : bytes < 1_000_000 ? "lt1m" : bytes < 10_000_000 ? "lt10m" : "gte10m";
export const screenBucket = (width: number): (typeof SCREEN_BUCKETS)[number] => width < 480 ? "xs" : width < 900 ? "s" : width < 1400 ? "m" : width < 2000 ? "l" : "xl";
export function attachmentKind(mime: string): (typeof ATTACHMENT_KINDS)[number] {
  const type = mime.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (/wordprocessingml|msword|opendocument\.text|rtf/.test(type)) return "doc";
  if (/spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv/.test(type)) return "sheet";
  if (/presentationml|ms-powerpoint|opendocument\.presentation/.test(type)) return "slides";
  if (type.startsWith("text/") || type === "application/json") return "text";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (/zip|tar|gzip|7z|rar/.test(type)) return "archive";
  return "other";
}
export const localeOf = (tag: string): (typeof LOCALES)[number] => {
  const lower = tag.toLowerCase();
  const exact = LOCALES.find(locale => locale === lower);
  if (exact) return exact;
  if (lower.startsWith("pt")) return "pt_br";
  if (lower === "zh-hant" || lower.startsWith("zh-tw") || lower.startsWith("zh-hk") || lower === "zh_tw") return "zh_tw";
  return LOCALES.find(locale => locale === lower.split("-")[0]) ?? "other";
};
