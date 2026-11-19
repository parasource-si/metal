// Settings follow the person across every place of their own: this computer, My Cloud and servers of their own. Like
// connector sync (connector-sync.ts), the desktop app's main process reads each place's settings here, by digest and
// time, and brings them level (electron/settings-sync.mjs): the last change wins, wherever it was made.
//
// What follows the person is listed below (SYNCED): appearance and the rest of the app's own preferences (kept here for
// the page, `ui.*`), language, voice, default model and new-bot defaults, data sharing, each app's default account,
// and the person's API keys. What belongs to one computer (MACHINE) stays: paths, its engines, its browser, its
// computers, addresses only it reaches. A bot's own settings move with the bot and are not here.
//
// Each place keeps, per setting, a digest of its value and when it last changed (settings-sync.json). A value first seen
// here counts as changed at 0, so a new place never outranks the ones the person has used. Secrets leave this
// computer's server only over the desktop's private port (login-handoff.ts); a Cloud or a server of the person's own
// hands them only to its owner's session. Nothing here logs a value.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { CONFIG_SECRET_PATHS } from "../shared/saved-secrets.ts";
import { SYNCED_UI_PREFS } from "../shared/synced-prefs.ts";
import { writeFileAtomic } from "./atomic.ts";
import { addressHere } from "./cloud-connections.ts";
import type { AppConfig } from "./config.ts";
import type { RequestAuth } from "./request-auth.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

const FILE = "settings-sync.json";
const KEY = /^[\w.:-]{1,160}$/u;
const MAX_VALUE = 64 * 1024;

/** Whole settings, as one. */
const WHOLE = ["language", "talkingStyle", "defaultModelSelection", "automaticRecovery", "cacheKeepWarm", "newBotDefaults", "newBots", "rooms", "mcp", "context", "memory", "loopGuard", "safetyFloor"] as const;
/** One field of a section, the rest of which may belong to this computer or hold a secret. In order: a voice provider
 * goes before its voice, which a change of provider clears. */
const FIELDS = [
  "profile.name", "profile.aboutMe", "profile.avatarUrl",
  ...["skillAuthoring", "skillReview", "skillReviewSteps", "showToolCalls", "browser", "llmThreadTitles", "quickUpdates", "smartSetupChoices", "autoRecall",
    "skillsLibrary", "shareLearnedSkills", "roomMemoryCapture", "parallelRoomJobs", "acpPlanLines", "agentsToolBridge"].map((name) => `features.${name}`),
  "onboarding.hintsSeen", "onboarding.reelSeen",
  "anthropic.everyClaudeBot",
  "tts.provider", "tts.voice", "tts.model", "tts.fishModel",
  "decider.enabled", "decider.provider", "decider.gatewayModel", "decider.gatewayApi", "decider.gatewayBaseUrl", "decider.workersAiAccountId", "decider.workersAiBaseUrl",
  "live.provider", "live.azureEndpoint", "live.azureDeployment", "live.voice", "live.readTypedReplies", "live.idleMinutes",
  "imageGen.provider", "imageGen.customUrl", "imageGen.customModel",
  "openaiCompat.model", "openaiCompat.provider",
] as const;
/** An address: it follows the person unless one of their places reaches it only there (a gateway on this computer). */
const ENDPOINTS = ["anthropic.url", "groq.url", "xai.url", "meta.url", "openaiCompat.url"] as const;
/** The person's keys. Composio's goes with Connect apps (connector-sync.ts, cloud-connections.ts). */
export const SYNCED_SECRETS = [
  ...CONFIG_SECRET_PATHS.filter((path) => path !== "composio.apiKey"),
  "tts.deepgramKey", "tts.cartesiaKey", "tts.assemblyAiKey", "opencodeGo.providerKeys",
] as const;
/** What stays on one computer, for the inventory and Settings' "This computer only". */
export const MACHINE_SETTINGS = [
  "customDomain", "signIn", "cliStartup", "vps", "localVm", "browserEngine", "browserProfiles", "instances", "computerName", "helper",
  "tts.baseUrl", "features.claudeUserMcp", "features.claudeUserSkills", "threads", "decisions",
  "onboarding.completedAt", "onboarding.version", "onboarding.firstTurnAt", "mcpServers", "composio",
] as const;

export type SettingKind = "plain" | "secret";
/** `set`: this place has a value of its own for it, not the default. */
export interface SettingEntry { digest: string; at: number; kind: SettingKind; set: boolean }
export interface SettingsListing { place: { id: string; label: string }; settings: Record<string, SettingEntry> }
export type Applied = { ok: true } | { ok: false; status: number; error: string };

const seenSchema = z.object({
  seen: z.record(z.string(), z.object({ digest: z.string(), at: z.number() })).default({}),
  ui: z.record(z.string(), z.string()).default({}),
});
type Seen = z.infer<typeof seenSchema>;

export const settingDigest = (key: string, value: unknown) =>
  createHash("sha256").update(`omb-setting:${key}:${JSON.stringify(value ?? null)}`).digest("hex");

const at = (root: unknown, path: string): unknown => path.split(".").reduce<unknown>((node, part) =>
  node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)[part] : undefined, root);

const kindOf = (key: string): SettingKind => (SYNCED_SECRETS as readonly string[]).includes(key) ? "secret" : "plain";

export interface SettingsSyncDeps {
  dataDir: string;
  config(): AppConfig;
  /** Saves a settings patch as Settings would, with every check and effect a save has. */
  saveConfig(patch: Record<string, unknown>): Promise<Applied>;
  /** "Help improve Metal". */
  usageSignals?: { get(): boolean; set(enabled: boolean): void };
  /** Which account each app uses by default, when it has more than one. */
  appAccounts?: { defaults(): Record<string, string>; set(slug: string, accountId: string | null): void };
  place: { id: string; label: string };
  /** A setting changed here, by hand or from another place. */
  changed?(): void;
  now?(): number;
}

export function createSettingsSync(deps: SettingsSyncDeps) {
  const file = join(deps.dataDir, FILE);
  const now = deps.now ?? Date.now;
  const read = (): Seen => {
    try { return seenSchema.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { return seenSchema.parse({}); }
  };
  const write = (state: Seen) => { try { writeFileAtomic(file, JSON.stringify(state), { mode: 0o600 }); } catch {} };

  const local = (value: unknown) => typeof value === "string" && value.trim() !== "" && addressHere(value);
  const SLUG = /^[a-z0-9_-]{1,80}$/u;

  /** Every setting this place has an opinion on, by key, read now. */
  function current(state: Seen): Map<string, unknown> {
    const cfg = deps.config();
    const out = new Map<string, unknown>();
    for (const key of [...WHOLE, ...FIELDS, ...SYNCED_SECRETS]) out.set(key, at(cfg, key));
    for (const key of ENDPOINTS) if (!local(at(cfg, key))) out.set(key, at(cfg, key));
    for (const name of SYNCED_UI_PREFS) out.set(`ui.${name}`, state.ui[name]);
    if (deps.usageSignals) out.set("usageSignals.enabled", deps.usageSignals.get());
    if (deps.appAccounts) {
      const defaults = deps.appAccounts.defaults();
      const slugs = new Set([...Object.keys(defaults), ...Object.keys(state.seen).filter((key) => key.startsWith("app.")).map((key) => key.slice(4, -8))]);
      for (const slug of slugs) if (SLUG.test(slug)) out.set(`app.${slug}.account`, defaults[slug]);
    }
    return out;
  }

  /** Brings the digests up to date; a value that changed since it was last read changed now. True when one did. */
  function settle(state: Seen): boolean {
    let moved = false;
    for (const [key, value] of current(state)) {
      const digest = settingDigest(key, value);
      const seen = state.seen[key];
      if (!seen) { state.seen[key] = { digest, at: 0 }; continue; }
      if (seen.digest !== digest) { state.seen[key] = { digest, at: now() }; moved = true; }
    }
    return moved;
  }

  function touch(): void {
    const state = read();
    const before = JSON.stringify(state);
    const moved = settle(state);
    if (JSON.stringify(state) !== before) write(state);
    if (moved) deps.changed?.();
  }

  function list(): SettingsListing {
    const state = read();
    const before = JSON.stringify(state);
    const moved = settle(state);
    if (JSON.stringify(state) !== before) write(state);
    if (moved) deps.changed?.();
    const values = current(state);
    const settings: Record<string, SettingEntry> = {};
    for (const [key, value] of values) settings[key] = { ...state.seen[key]!, kind: kindOf(key), set: value !== undefined && value !== null && value !== "" };
    return { place: deps.place, settings };
  }

  /** The values of `keys`, as this place has them; `secrets` false leaves out every key. */
  function values(keys: readonly string[], secrets: boolean): Record<string, unknown> {
    const state = read();
    const now = current(state);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (!now.has(key) || (!secrets && kindOf(key) === "secret")) continue;
      out[key] = now.get(key) ?? null;
    }
    return out;
  }

  /** One setting as another place has it, changed there at `when`. */
  async function put(key: string, value: unknown, when: number): Promise<Applied> {
    const refuse = (status: number, error: string): Applied => ({ ok: false, status, error });
    if (!KEY.test(key)) return refuse(400, "bad key");
    if (JSON.stringify(value ?? null).length > MAX_VALUE) return refuse(413, "too large");
    const state = read();
    settle(state);
    const known = current(state);
    const seen = state.seen[key];
    // already so here (a change of voice provider clears the voice, say): only the time is taken
    if (known.has(key) && seen?.digest === settingDigest(key, value)) {
      state.seen[key] = { digest: seen.digest, at: Math.max(seen.at, when) };
      write(state);
      return { ok: true };
    }
    if (seen && seen.at > when && known.has(key)) return refuse(409, "This place changed it later.");
    let done: Applied = { ok: true };
    if (key.startsWith("ui.")) {
      const name = key.slice(3);
      if (!(SYNCED_UI_PREFS as readonly string[]).includes(name)) return refuse(400, "not a setting that follows the person");
      if (value !== null && value !== undefined && typeof value !== "string") return refuse(400, "a preference is text");
      if (typeof value === "string") state.ui[name] = value; else delete state.ui[name];
    } else if (key === "usageSignals.enabled") {
      if (!deps.usageSignals || typeof value !== "boolean") return refuse(400, "send true or false");
      deps.usageSignals.set(value);
    } else if (/^app\.[a-z0-9_-]{1,80}\.account$/u.test(key)) {
      if (!deps.appAccounts || (value !== null && value !== undefined && typeof value !== "string")) return refuse(400, "send an account id");
      try { deps.appAccounts.set(key.slice(4, -8), typeof value === "string" ? value : null); } catch (error) { return refuse(400, (error as Error).message); }
    } else if ((ENDPOINTS as readonly string[]).includes(key)) {
      if (local(at(deps.config(), key))) return refuse(409, "This place reaches its own address.");
      if (local(value)) return refuse(400, "An address only one place reaches stays there.");
      done = await deps.saveConfig(patchFor(key, value));
    } else if (([...WHOLE, ...FIELDS, ...SYNCED_SECRETS] as readonly string[]).includes(key)) {
      // unset there: text is cleared here; a switch or a choice that cannot be unset keeps this place's
      const here = at(deps.config(), key);
      if ((value === null || value === undefined) && here !== undefined && typeof here !== "string") done = { ok: true };
      else done = await deps.saveConfig(patchFor(key, value));
    } else return refuse(400, "not a setting that follows the person");
    if (!done.ok) return done;
    // the change made here is the one made there, at the time it was made there
    const after = read();
    after.ui = state.ui;
    settle(after);
    after.seen[key] = { digest: settingDigest(key, current(after).get(key)), at: when };
    write(after);
    deps.changed?.();
    return done;
  }

  /** Marks a setting as changed at `when`: after this computer's app saved it its own way (a key it keeps encrypted). */
  function stamp(key: string, when: number): void {
    const state = read();
    settle(state);
    if (!state.seen[key]) return;
    state.seen[key] = { ...state.seen[key]!, at: when };
    write(state);
  }

  /** The app's own preferences, for the page: the value and when it changed. */
  function ui(): Record<string, { value: string | null; at: number }> {
    const state = read();
    settle(state);
    return Object.fromEntries(SYNCED_UI_PREFS.map((name) => [name, { value: state.ui[name] ?? null, at: state.seen[`ui.${name}`]?.at ?? 0 }]));
  }

  /** The page changed one of its preferences at `when` (its clock); an older change than the one kept is refused. */
  function setUi(name: string, value: string | null, when: number): { ok: boolean; at: number } {
    const state = read();
    settle(state);
    const key = `ui.${name}`;
    const kept = state.seen[key]?.at ?? 0;
    if (when < kept) return { ok: false, at: kept };
    if (value === null) delete state.ui[name]; else state.ui[name] = value;
    const stamped = Math.min(when, now() + 60_000);
    state.seen[key] = { digest: settingDigest(key, value), at: stamped };
    write(state);
    deps.changed?.();
    return { ok: true, at: stamped };
  }

  return { list, touch, values, put, stamp, ui, setUi };
}

export type SettingsSync = ReturnType<typeof createSettingsSync>;

/** A one-setting patch; an unset one is "", which a save clears. */
export function patchFor(key: string, value: unknown): Record<string, unknown> {
  return key.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value ?? "") as Record<string, unknown>;
}

/** What the desktop asks this computer's server over its private port: values, secrets with them. */
export type SettingsHandoffWhat = { kind: "settings"; op: "values"; keys: string[] };

export function parseSettingsHandoff(what: Record<string, unknown> | null): SettingsHandoffWhat | null {
  if (what?.kind !== "settings" || what.op !== "values" || !Array.isArray(what.keys) || what.keys.length > 500) return null;
  const keys = what.keys.filter((key): key is string => typeof key === "string" && KEY.test(key));
  return keys.length === what.keys.length ? { kind: "settings", op: "values", keys } : null;
}

export function answerSettingsHandoff(sync: SettingsSync, what: SettingsHandoffWhat): { ok: true; settings: Record<string, unknown> } {
  return { ok: true, settings: { values: sync.values(what.keys, true) } };
}

/**
 * The person's settings, at this place:
 *   GET  /api/settings-sync                       every setting by digest and when it changed
 *   POST /api/settings-sync/values  {keys}        their values (secrets only to the owner's session on a Cloud or a
 *                                                 server of their own; this computer hands those over its private port)
 *   PUT  /api/settings-sync/values  {key, value, at}   take one as another place has it
 *   POST /api/settings-sync/stamp   {key, at}     mark one this computer's app saved itself
 *   GET  /api/settings-sync/ui, PUT {name, value, at}  the page's own preferences
 * Only the person's own session, or this computer's own app. A Team Cloud has none of these.
 */
export function createSettingsSyncRoutes(deps: {
  sync: SettingsSync;
  /** The person's own place, answering the person: a Cloud home, or a server of one person's own from their session. */
  owners(auth: RequestAuth): boolean;
  /** A Team Cloud keeps no person's settings. */
  team?: boolean;
  /** The page's preferences changed: tell its other windows. */
  uiChanged?(): void;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/settings-sync" && !path.startsWith("/api/settings-sync/")) return PASS;
    res.setHeader("cache-control", "no-store");
    const loopback = auth.kind === "loopback" && auth.scopes.includes("admin");
    if (deps.team) { req.resume(); return json(res, 404, { error: "not found" }); }
    if (!loopback && !deps.owners(auth)) { req.resume(); return json(res, 403, { error: "Only your own app can read your settings here." }); }
    const body = async () => {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return undefined;
      return readBody(req, MAX_VALUE + 4096) as Promise<Record<string, unknown> | undefined>;
    };
    const when = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

    if (path === "/api/settings-sync") return method === "GET" ? json(res, 200, deps.sync.list()) : json(res, 405, { error: "method not allowed" });
    if (path === "/api/settings-sync/values") {
      const sent = await body();
      if (method === "POST") {
        const keys = Array.isArray(sent?.keys) ? sent.keys.filter((key): key is string => typeof key === "string" && KEY.test(key)).slice(0, 500) : null;
        if (!keys) return json(res, 400, { error: "send {keys}" });
        // secrets out: only the person's own session on their own place
        return json(res, 200, { values: deps.sync.values(keys, !loopback && deps.owners(auth)) });
      }
      if (method === "PUT") {
        const changed = when(sent?.at);
        if (!sent || typeof sent.key !== "string" || changed === null || !("value" in sent)) return json(res, 400, { error: "send {key, value, at}" });
        const done = await deps.sync.put(sent.key, sent.value, changed);
        if (done.ok && sent.key.startsWith("ui.")) deps.uiChanged?.();
        return done.ok ? json(res, 200, { ok: true }) : json(res, done.status, { error: done.error });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    if (path === "/api/settings-sync/stamp" && method === "POST") {
      const sent = await body();
      const changed = when(sent?.at);
      if (typeof sent?.key !== "string" || !KEY.test(sent.key) || changed === null) return json(res, 400, { error: "send {key, at}" });
      deps.sync.stamp(sent.key, changed);
      return json(res, 200, { ok: true });
    }
    if (path === "/api/settings-sync/ui") {
      if (method === "GET") return json(res, 200, { prefs: deps.sync.ui() });
      if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
      const sent = await body();
      const changed = when(sent?.at);
      if (typeof sent?.name !== "string" || !(SYNCED_UI_PREFS as readonly string[]).includes(sent.name) || changed === null
        || (sent.value !== null && (typeof sent.value !== "string" || sent.value.length > 16_384))) return json(res, 400, { error: "send {name, value, at}" });
      const done = deps.sync.setUi(sent.name, sent.value as string | null, changed);
      if (done.ok) deps.uiChanged?.();
      return json(res, 200, done);
    }
    return json(res, 404, { error: "not found" });
  };
}
