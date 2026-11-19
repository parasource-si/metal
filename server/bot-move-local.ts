// Security: reads only the named files of another agent app's own folder (its config, persona and memory files, skill
// folders' SKILL.md and its routine list), always without following a link and within a size limit. Login, key, session,
// transcript and history files (.env, auth*.json, credentials/, sessions/, state.db, messages.db) are never listed or
// opened, and nothing is written to or removed from the app's folder. Token-shaped text in what is read is redacted.
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml } from "yaml";

import type { BotLook, BotMoveSource, FoundApp } from "../shared/bot-move.ts";
import type { GrokApp, GrokBot, GrokRoutine, GrokSkill } from "../shared/grok-import.ts";
import type { PackageRoutineSchedule } from "../shared/package-format.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { parseSkillMd, SKILL_FILE_MAX_BYTES } from "../shared/skill-md.ts";
import { withoutJsonComments, withoutTrailingCommas, type SetupMachine } from "./setup-import.ts";

const TEXT_MAX = 256 * 1024;
const CONFIG_MAX = 1024 * 1024;
const MAX_BOTS = 30;
const MAX_SKILL_FOLDERS = 300;
const MAX_DAILY_NOTES = 30;
/** Folders a skill list never descends into: an app's own bundled skills, and installed dependencies. */
const SKIP_FOLDERS = new Set(["node_modules", "__pycache__", "venv"]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const decoder = new TextDecoder("utf-8", { fatal: true });

function utf8(bytes: Buffer | null): string | null {
  if (!bytes) return null;
  try {
    const out = decoder.decode(bytes);
    return out.includes("\u0000") ? null : out.replace(/^﻿/, "");
  } catch {
    return null;
  }
}

class Reader {
  readonly unreadable: string[] = [];
  readonly machine: SetupMachine;
  readonly root: string;
  constructor(machine: SetupMachine, root: string) {
    this.machine = machine;
    this.root = root;
  }

  /** A real folder (never a link), or false. */
  isDir(path: string): boolean {
    return this.machine.fs.lstat(path)?.isDirectory() === true;
  }

  /** A real file's text; null when it is absent. One that is there but can't be read is noted by name. */
  read(path: string, max = TEXT_MAX): string | null {
    const info = this.machine.fs.lstat(path);
    if (!info) return null;
    const out = info.isFile() && info.size <= max ? utf8(this.machine.fs.read(path, max, false)) : null;
    if (out === null) this.note(path);
    return out === null ? null : redactSecretsInText(out);
  }

  /** A JSON (or JSON5-ish) or YAML file as an object; null when absent, noted when unreadable. */
  readObject(path: string, format: "json" | "yaml", max = CONFIG_MAX): Record<string, unknown> | null {
    const raw = this.read(path, max);
    if (raw === null) return null;
    const parsed = format === "yaml" ? loose(() => parseYaml(raw, { maxAliasCount: 50 })) : looseJson(raw);
    if (isRecord(parsed)) return parsed;
    this.note(path);
    return null;
  }

  folders(path: string): string[] {
    return (this.machine.fs.readdir(path) ?? []).filter((name) => !name.startsWith(".")).sort().filter((name) => this.isDir(join(path, name)));
  }

  files(path: string): string[] {
    return (this.machine.fs.readdir(path) ?? []).filter((name) => !name.startsWith(".")).sort()
      .filter((name) => this.machine.fs.lstat(join(path, name))?.isFile() === true);
  }

  note(path: string): void {
    const rel = relative(this.root, path) || path;
    if (!this.unreadable.includes(rel)) this.unreadable.push(rel);
  }
}

function loose(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** OpenClaw's config is JSON5: comments and trailing commas, and in a hand-edited file bare keys, which YAML's flow
 * style also reads. */
function looseJson(raw: string): unknown {
  const plain = withoutTrailingCommas(withoutJsonComments(raw));
  return loose(() => JSON.parse(plain)) ?? loose(() => parseYaml(plain, { maxAliasCount: 50 }));
}

function tilde(machine: SetupMachine, path: string): string {
  const rel = relative(machine.home, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `~/${rel.replaceAll("\\", "/")}` : path;
}

/** A path from another app's config: ~ is the home folder, a relative one is inside `base`. */
function configPath(machine: SetupMachine, value: string, base: string): string {
  if (value === "~" || value.startsWith("~/")) return join(machine.home, value.slice(2));
  return isAbsolute(value) ? value : resolve(base, value);
}

const hasContent = (body: string) => body.split(/\r?\n/).some((line) => {
  const trimmed = line.trim();
  return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("<!--") && !trimmed.startsWith("```") && !/^[-*]\s*$/.test(trimmed);
});

// OpenClaw writes every workspace file from a template on first run ("# AGENTS.md - Your Workspace", …); one still as
// written says nothing about the person or the bot, so it is never brought over as if it did.
const OPENCLAW_STOCK: Record<string, RegExp> = {
  "AGENTS.md": /^#\s*AGENTS\.md\s*[-:]\s*Your Workspace/im,
  "TOOLS.md": /^#\s*TOOLS\.md\s*[-:]\s*Local Notes[\s\S]*^##\s*What Goes Here/im,
  "SOUL.md": /^#\s*SOUL\.md\s*[-:]\s*Who You Are/im,
  "BOOTSTRAP.md": /^#\s*BOOTSTRAP\.md/im,
};
const SOUL_STOCK_LINES = ["Be genuinely helpful, not performatively helpful", "Have opinions", "Be resourceful before asking", "You're not a chatbot"];

/** A workspace file still as OpenClaw wrote it. A SOUL.md counts as written by the person once they changed it. */
function openClawStock(file: string, body: string): boolean {
  if (file === "SOUL.md") return OPENCLAW_STOCK["SOUL.md"]!.test(body) && SOUL_STOCK_LINES.filter((line) => body.includes(line)).length >= 3;
  // the template's "## Related" links to OpenClaw's docs are not tasks
  if (file === "HEARTBEAT.md") return !body.replace(/^##\s*Related\b[\s\S]*$/im, "").split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```") && !trimmed.startsWith("<!--") && !/^[-*]\s*\[[^\]]*\]\([^)]*\)$/.test(trimmed);
  });
  return OPENCLAW_STOCK[file]?.test(body) ?? false;
}

/** A persona file's own name for the bot, from its first heading ("# Ananya"), never the file's template title. */
function headingName(body: string | null): string {
  const heading = /^#\s+(.{1,40})$/m.exec(body ?? "")?.[1]?.trim() ?? "";
  return !heading || /\.md\b|who (?:you are|am i)|^soul\b/i.test(heading) ? "" : heading.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

/** The filled fields of a key-value file (USER.md, IDENTITY.md): "Name: Sam". A field left empty, a placeholder in
 * brackets or italics, headings and the template's guidance prose are not facts. */
function filledFields(body: string): string[] {
  return body.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*[-*]\s*\*{0,2}([\p{L}][\p{L}\s/'-]{0,40}?)\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/u.exec(line);
    const value = match?.[2]?.replace(/\*\*|__|`/g, "").trim() ?? "";
    if (!match || !value || /^_?\(.*\)_?$|^_.*_$|^\[.*\]$|^(?:tbd|todo|n\/a|-)$/i.test(value)) return [];
    return [`${match[1]!.trim()}: ${value}`];
  });
}

/** Each SKILL.md in a folder of skill folders, `depth` deep (Hermes groups its skills in category folders). */
function readSkills(reader: Reader, root: string, depth = 1, skip: (path: string) => boolean = () => false): GrokSkill[] {
  const out: GrokSkill[] = [];
  const walk = (folder: string, level: number) => {
    for (const name of reader.folders(folder)) {
      if (out.length >= MAX_SKILL_FOLDERS || SKIP_FOLDERS.has(name.toLowerCase())) continue;
      const path = join(folder, name);
      if (skip(path)) continue;
      const skillMd = join(path, "SKILL.md");
      if (reader.machine.fs.lstat(skillMd)) {
        const body = reader.read(skillMd, SKILL_FILE_MAX_BYTES);
        if (body === null || !body.trim()) continue;
        const parsed = parseSkillMd(body);
        const named = "error" in parsed ? null : parsed;
        out.push({ name: named?.name || name, description: named?.description ?? "", instructions: body });
      } else if (level < depth) {
        walk(path, level + 1);
      }
    }
  };
  if (reader.isDir(root)) walk(root, 1);
  return out;
}

const blankBot = (name: string): GrokBot => ({
  name, title: "", description: "", instructions: "", memories: [], userFacts: [], skills: [], routines: [], apps: [], memoryFiles: {},
});

/** A model setting as it is written: a name, or an object naming it. */
function modelName(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  return text(value.primary) || text(value.default) || text(value.model) || text(value.name);
}

/** How the bot was set up there, as a topic of its memory: the model, where it answered and its tools, by name. */
function setupTopic(app: string, parts: { model?: string; provider?: string; channels?: string[]; tools?: string[]; extra?: string[] }): string | null {
  const lines = [
    ...(parts.model ? [`- Model: ${parts.model}${parts.provider ? ` (through ${parts.provider})` : ""}. Here you pick the AI in the bot's settings.`] : []),
    ...(parts.channels?.length ? [`- Answered on: ${parts.channels.join(", ")}. Those connections and their logins stay in ${app}; connect chat apps again here to answer there.`] : []),
    ...(parts.tools?.length ? [`- Tools (MCP servers): ${parts.tools.join(", ")}. Connect them again in apps.`] : []),
    ...(parts.extra ?? []),
  ];
  return lines.length ? `# How I was set up in ${app}\n\n${lines.join("\n")}\n` : null;
}

const CHANNEL_LABELS: Record<string, string> = {
  telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp", slack: "Slack", signal: "Signal", imessage: "iMessage", msteams: "Microsoft Teams",
  email: "email", matrix: "Matrix", mattermost: "Mattermost", sms: "SMS", homeassistant: "Home Assistant", googlechat: "Google Chat",
};
const channelLabel = (key: string) => CHANNEL_LABELS[key] ?? key;

/** An app's MCP servers as apps to connect again: a remote one keeps its address, a local one only its name. Values of
 * headers and env are never read, only header names. */
function mcpApps(servers: unknown): GrokApp[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).slice(0, 50).flatMap(([name, raw]) => {
    if (!isRecord(raw) || raw.enabled === false || raw.disabled === true) return [];
    const url = text(raw.url) || text(raw.httpUrl) || text(raw.serverUrl);
    return [{ name: name.slice(0, 100), mcpUrl: url, transport: url ? (text(raw.transport) || text(raw.type)).toLowerCase() : "stdio", headerNames: isRecord(raw.headers) ? Object.keys(raw.headers) : [] }];
  });
}

const PICTURE_TYPES: Record<string, NonNullable<GrokBot["avatar"]>["mime"]> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/** A picture kept in the bot's own folder, at most 64 KB; never one outside it, a link, or a web address. */
function folderPicture(reader: Reader, folder: string, value: string): GrokBot["avatar"] | undefined {
  const mime = PICTURE_TYPES[value.toLowerCase().split(".").pop() ?? ""];
  if (!mime || /^[a-z]+:/i.test(value) || isAbsolute(value)) return undefined;
  const path = resolve(folder, value);
  const rel = relative(folder, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const bytes = reader.machine.fs.lstat(path)?.isFile() ? reader.machine.fs.read(path, 64 * 1024, false) : null;
  return bytes?.length ? { mime, data: bytes.toString("base64") } : undefined;
}

const routine = (fields: Partial<GrokRoutine> & Pick<GrokRoutine, "name" | "instruction">): GrokRoutine => ({
  trigger: "schedule", cron: "", when: "", timeZone: "", paused: false, skills: [], details: "", ...fields,
});

const MINUTE = 60_000;

/** An "every N" schedule as a repeating one from now; outside Metal's 5 minutes to a day, null. */
function everySchedule(ms: number, now: number): PackageRoutineSchedule | null {
  const minutes = Math.round(ms / MINUTE);
  return Number.isFinite(minutes) && minutes >= 5 && minutes <= 1_440 ? { type: "interval", everyMinutes: minutes, anchorAt: now } : null;
}

function onceSchedule(value: unknown, now: number): PackageRoutineSchedule | null {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > now ? { type: "once", at: Math.round(at) } : null;
}

function titled(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}

// OpenClaw (and Clawdbot, Moltbot, "moldbot" before it), as of 2026.3 through 2026.11: a JSON5 config whose agents are
// `agents.list[]` (older) or `agents.entries.<id>` (newer); one workspace per agent holding its persona (SOUL.md,
// IDENTITY.md), operating notes (AGENTS.md, USER.md, older TOOLS.md and HEARTBEAT.md), memory (MEMORY.md, daily
// memory/YYYY-MM-DD.md) and skills/; shared skills in <state>/skills; cron jobs in cron/jobs.json (older) or the
// cron_jobs table of state/openclaw.sqlite (newer).
const OPENCLAW_HOMES = [
  { dir: ".openclaw", app: "OpenClaw" },
  { dir: ".clawdbot", app: "Clawdbot" },
  { dir: ".moltbot", app: "Moltbot" },
  { dir: ".moldbot", app: "Moltbot" },
] as const;
const OPENCLAW_CONFIGS = ["openclaw.json", "clawdbot.json", "moltbot.json", "moldbot.json"];
const NOT_CHANNELS = new Set(["defaults", "modelByChannel"]);
const OLD_CHANNELS = ["whatsapp", "telegram", "discord", "slack", "signal", "imessage", "msteams"];

function identityField(identity: string, field: string): string {
  const match = new RegExp(`^\\s*[-*]?\\s*[*_\`]{0,2}${field}[*_\`]{0,2}\\s*:\\s*(.+?)\\s*$`, "im").exec(identity);
  const value = match?.[1]?.replace(/^[*_`\s]+|[*_`\s]+$/g, "").trim() ?? "";
  return /^\(.*\)$|^pick something/i.test(value) ? "" : value;
}

interface OpenClawAgent { id: string; entry: Record<string, unknown> }

function openClawAgents(config: Record<string, unknown>): { agents: OpenClawAgent[]; defaultId: string } {
  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const list: OpenClawAgent[] = isRecord(agents.entries)
    ? Object.entries(agents.entries).flatMap(([id, entry]) => (isRecord(entry) ? [{ id, entry }] : []))
    : Array.isArray(agents.list) ? agents.list.filter(isRecord).map((entry) => ({ id: text(entry.id) || "main", entry })) : [];
  const system = isRecord(defaults.systemAgent) ? text(defaults.systemAgent.agentId) : "";
  const defaultId = system || text(list.find((one) => one.entry.default === true)?.id) || list[0]?.id || "main";
  const all = list.length ? list : [{ id: defaultId, entry: {} }];
  // an older config keeps the default agent's identity at the top level
  return { defaultId, agents: all.map((one) => (one.id === defaultId && !isRecord(one.entry.identity) && isRecord(config.identity) ? { ...one, entry: { ...one.entry, identity: config.identity } } : one)) };
}

function readOpenClaw(machine: SetupMachine, now: number): FoundApp[] {
  const found: FoundApp[] = [];
  const seen = new Set<string>();
  const env = machine.env;
  const absolute = (value: unknown) => (typeof value === "string" && isAbsolute(value.trim()) ? value.trim() : "");
  const home = absolute(env.OPENCLAW_HOME) || machine.home;
  const profile = text(env.OPENCLAW_PROFILE);
  const homes = [
    ...(absolute(env.OPENCLAW_STATE_DIR) ? [{ root: absolute(env.OPENCLAW_STATE_DIR), app: "OpenClaw" }] : []),
    ...(profile && profile !== "default" && /^[\w-]{1,64}$/.test(profile) ? [{ root: join(home, `.openclaw-${profile}`), app: "OpenClaw" }] : []),
    ...OPENCLAW_HOMES.map((one) => ({ root: join(home, one.dir), app: one.app })),
  ];
  for (const place of homes) {
    // after a move OpenClaw leaves a link from an old name to its folder: that is the same app, read once
    if (!machine.fs.lstat(place.root)?.isDirectory() || seen.has(place.root)) continue;
    seen.add(place.root);
    const reader = new Reader(machine, place.root);
    const configFile = [absolute(env.OPENCLAW_CONFIG_PATH), ...OPENCLAW_CONFIGS.map((name) => join(place.root, name))]
      .find((path) => path && machine.fs.lstat(path)?.isFile());
    const config = configFile ? reader.readObject(configFile, "json") ?? {} : {};
    const { agents, defaultId } = openClawAgents(config);
    const defaults = isRecord(config.agents) && isRecord(config.agents.defaults) ? config.agents.defaults : {};
    const defaultsWorkspace = text(defaults.workspace) ? configPath(machine, text(defaults.workspace), place.root) : "";
    const shared = readSkills(reader, join(place.root, "skills"));
    const jobs = openClawJobs(reader, place.root, defaultId, now);
    const bots: GrokBot[] = [];
    for (const { id, entry } of agents.slice(0, MAX_BOTS)) {
      const own = text(entry.workspace) ? configPath(machine, text(entry.workspace), place.root) : "";
      const candidates = own ? [own]
        : id === defaultId ? [absolute(env.OPENCLAW_WORKSPACE_DIR), defaultsWorkspace, join(place.root, "workspace")]
          : [defaultsWorkspace && join(defaultsWorkspace, id), join(place.root, `workspace-${id}`)];
      const workspace = candidates.find((path) => path && reader.isDir(path)) ?? "";
      const bot = workspace ? openClawBot(reader, workspace, entry, id, place.app, now) : null;
      if (!bot) continue;
      const main = id === defaultId;
      if (main) bot.apps.push(...mcpApps(isRecord(config.mcp) ? config.mcp.servers : undefined));
      const setup = setupTopic(place.app, {
        model: modelName(entry.model) || modelName(defaults.model),
        ...(main ? { channels: openClawChannels(config).map(channelLabel), tools: bot.apps.map((app) => app.name) } : {}),
      });
      if (setup) bot.memoryFiles = { ...bot.memoryFiles, [`memory/${place.app.toLowerCase()}-setup.md`]: setup };
      bot.skills = [...bot.skills, ...shared.filter((skill) => !bot.skills.some((mine) => mine.name === skill.name))];
      bot.routines.push(...(jobs.get(id) ?? []));
      bots.push(bot);
    }
    const channels = openClawChannels(config);
    if (bots.length) found.push({ source: "openclaw", app: place.app, where: tilde(machine, place.root), bots, channels, unreadable: reader.unreadable });
  }
  return found;
}

function openClawChannels(config: Record<string, unknown>): string[] {
  return isRecord(config.channels)
    ? Object.entries(config.channels).filter(([name, value]) => !NOT_CHANNELS.has(name) && isRecord(value) && value.enabled !== false).map(([name]) => name)
    : OLD_CHANNELS.filter((name) => isRecord(config[name]) && config[name].enabled !== false);
}

function openClawBot(reader: Reader, workspace: string, entry: Record<string, unknown>, id: string, app: string, now: number): GrokBot | null {
  const at = (name: string) => (reader.machine.fs.lstat(join(workspace, name)) ? reader.read(join(workspace, name)) : null);
  const identityText = at("IDENTITY.md") ?? "";
  const identity = isRecord(entry.identity) ? entry.identity : {};
  const rawSoul = at("SOUL.md");
  const soul = rawSoul && hasContent(rawSoul) && !openClawStock("SOUL.md", rawSoul) ? rawSoul : null;
  // a name it chose for itself (IDENTITY.md, its persona's heading) is a sign of a bot; a name in the config alone is not
  const named = text(identity.name) || identityField(identityText, "Name") || headingName(soul);
  const name = named || text(entry.name) || (id === "main" ? app : titled(id));
  const bot = blankBot(name.slice(0, 100));
  bot.title = identityField(identityText, "Creature") || text(identity.theme) || identityField(identityText, "Theme");
  bot.description = text(entry.description) || identityField(identityText, "Vibe");
  bot.instructions = soul ? soul.trim() : "";
  const files: Record<string, string> = {};
  const memory = at("MEMORY.md") ?? at("memory.md");
  if (memory && hasContent(memory)) files["MEMORY.md"] = memory;
  const slug = app.toLowerCase();
  const keep = (file: string, topic: string, heading: string) => {
    const body = at(file);
    if (body && hasContent(body) && !openClawStock(file, body)) files[`memory/${topic}.md`] = `# ${heading}\n\n${body.trim()}\n`;
  };
  // what it knew about the person goes to About me, every bot's, rather than this bot's notebook: only fields filled in
  // the rest of a USER.md the person filled in (its notes, its context) goes to the engine; one never filled in is
  // still OpenClaw's template, and says nothing
  const user = at("USER.md");
  if (user) bot.userFacts = filledFields(user);
  const userNotes = user && bot.userFacts.length ? user.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#") && !/^\s*[-*]\s*\*{0,2}[\p{L}][\p{L}\s/'-]{0,40}?\*{0,2}\s*:/u.test(line) && !/^_?\(.*\)_?$|^_.*_$/.test(trimmed);
  }) : [];
  const picture = text(identity.avatar) || identityField(identityText, "Avatar");
  const avatar = picture ? folderPicture(reader, workspace, picture) : undefined;
  if (avatar) bot.avatar = avatar;
  keep("AGENTS.md", `${slug}-agents`, `How I worked in ${app} (AGENTS.md)`);
  keep("TOOLS.md", `${slug}-tools`, `Notes on tools from ${app} (TOOLS.md)`);
  // daily logs are history, not memory: the bot's engine condenses them into dated notes after the move
  const daily = dailyNotes(reader, join(workspace, "memory"), app);
  bot.distill = [...(userNotes.length ? [`About me, from ${app}'s USER.md:\n${userNotes.join("\n")}`] : []), ...(daily ? [daily] : [])];
  bot.memoryFiles = files;
  const mine = readSkills(reader, join(workspace, "skills"));
  bot.skills = [...mine, ...readSkills(reader, join(workspace, ".agents", "skills")).filter((skill) => !mine.some((one) => one.name === skill.name))];
  const heartbeat = at("HEARTBEAT.md");
  if (heartbeat && hasContent(heartbeat) && !openClawStock("HEARTBEAT.md", heartbeat)) {
    bot.routines.push(routine({ name: "Heartbeat", instruction: heartbeat.trim(), paused: true, schedule: { type: "interval", everyMinutes: 30, anchorAt: now } }));
  }
  // a bot only when the workspace really defines one: a persona, a name it was given, memory, its own skills or
  // routines. One never set up (BOOTSTRAP.md still waiting) or holding only OpenClaw's templates is not a bot.
  const real = Boolean(bot.instructions || named || Object.keys(files).length || bot.distill?.length || bot.skills.length || bot.routines.length);
  return real ? bot : null;
}

/** The newest daily notes, newest first, in one topic; older ones stay in the app. */
function dailyNotes(reader: Reader, folder: string, app: string): string | null {
  if (!reader.isDir(folder)) return null;
  const days = reader.files(folder).filter((name) => /^\d{4}-\d{2}-\d{2}.*\.md$/i.test(name)).reverse().slice(0, MAX_DAILY_NOTES);
  const parts = days.flatMap((name) => {
    const body = reader.read(join(folder, name), 64 * 1024);
    return body && hasContent(body) ? [`## ${name.replace(/\.md$/i, "")}\n\n${body.replace(/^#\s.*\r?\n/, "").trim()}`] : [];
  });
  if (!parts.length) return null;
  let out = `# Daily notes from ${app}\n\nThe latest ${parts.length} days, newest first.\n`;
  for (const part of parts) {
    if (out.length + part.length > 200 * 1024) break;
    out += `\n${part}\n`;
  }
  return out;
}

/** Security: the cron table only, read-only; the same file keeps sessions, which are never queried. */
function sqliteJobs(reader: Reader, path: string): unknown[] {
  const info = reader.machine.fs.lstat(path);
  if (!info?.isFile()) return [];
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return (db.prepare("SELECT job_json FROM cron_jobs LIMIT 500").all() as Array<{ job_json?: unknown }>)
        .flatMap((row) => (typeof row.job_json === "string" ? [loose(() => JSON.parse(redactSecretsInText(row.job_json as string)))] : []));
    } finally {
      db.close();
    }
  } catch {
    reader.note(path);
    return [];
  }
}

function openClawJobs(reader: Reader, root: string, defaultId: string, now: number): Map<string, GrokRoutine[]> {
  const out = new Map<string, GrokRoutine[]>();
  const file = join(root, "cron", "jobs.json");
  const doc = reader.machine.fs.lstat(file) ? reader.readObject(file, "json") : null;
  const jobs = (Array.isArray(doc?.jobs) ? doc.jobs : sqliteJobs(reader, join(root, "state", "openclaw.sqlite"))).filter(isRecord);
  for (const job of jobs) {
    const payload = isRecord(job.payload) ? job.payload : {};
    if (payload.kind === "command" || payload.kind === "script") continue;
    const instruction = text(payload.message) || text(payload.text) || text(job.message) || text(job.text);
    if (!instruction) continue;
    const schedule = isRecord(job.schedule) ? job.schedule : {};
    const kind = text(schedule.kind) || (text(schedule.cron) || text(schedule.expr) ? "cron" : "");
    const own = kind === "every" ? everySchedule(Number(schedule.everyMs), now)
      : kind === "at" ? onceSchedule(schedule.atMs ?? schedule.at, now) : null;
    const expression = text(schedule.expr) || text(schedule.cron);
    const delivery = isRecord(job.delivery) ? text(job.delivery.channel) : "";
    const agent = text(job.agentId) || defaultId;
    const list = out.get(agent) ?? [];
    list.push(routine({
      name: text(job.name) || text(job.id) || "Routine",
      instruction,
      trigger: kind === "cron" || own ? "schedule" : kind || "other",
      cron: kind === "cron" ? expression : "",
      when: expression || text(schedule.at) || (kind === "every" ? `every ${Math.round(Number(schedule.everyMs) / MINUTE)} minutes` : ""),
      timeZone: text(schedule.tz),
      paused: job.enabled === false,
      details: [kind === "cron" || own ? "" : kind, delivery ? `sent to ${delivery}` : ""].filter(Boolean).join(", "),
      ...(own ? { schedule: own } : {}),
    }));
    out.set(agent, list);
  }
  return out;
}

// Hermes Agent (Nous Research): ~/.hermes (or $HERMES_HOME) is one agent, and each ~/.hermes/profiles/<name> holding
// one of PROFILE_MARKERS another, each with SOUL.md, a personality in config.yaml, memories/MEMORY.md and
// memories/USER.md (entries split by §), skills/[category/]<skill>/SKILL.md (bundled ones named in
// skills/.bundled_manifest, one name:hash a line) and cron/jobs.json; logins sit in .env and auth.json.
const PROFILE_MARKERS = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];
const HERMES_PLATFORMS = ["telegram", "discord", "whatsapp", "slack", "signal", "email", "matrix", "mattermost", "sms", "homeassistant", "dingtalk", "feishu", "wecom"];

function hermesEntries(body: string): string[] {
  if (body.includes("§")) return body.split(/\n?\s*§\s*\n?/).map((entry) => entry.trim()).filter((entry) => entry && hasContent(entry));
  // written by hand as a markdown page rather than by Hermes's memory tool: one entry per line, led by its section
  const out: string[] = [];
  let section = "";
  for (const raw of body.split(/\r?\n/)) {
    const heading = /^#{2,6}\s+(.+?)\s*#*$/.exec(raw.trim());
    if (heading) { section = heading[1]!.replace(/[*_`]/g, "").trim(); continue; }
    const line = raw.replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--") || /^[-*_=]{3,}$/.test(line)) continue;
    out.push(section && !line.toLowerCase().startsWith(section.toLowerCase()) ? `${section}: ${line}` : line);
  }
  return out;
}

function bundledSkills(reader: Reader, skills: string): Set<string> {
  const names = new Set<string>();
  for (const file of [".bundled_manifest", ".bundled_manifest.json"]) {
    const body = reader.machine.fs.lstat(join(skills, file)) ? reader.read(join(skills, file), CONFIG_MAX) : null;
    if (!body) continue;
    const parsed = looseJson(body);
    const items = Array.isArray(parsed) ? parsed : isRecord(parsed) ? Object.keys(isRecord(parsed.skills) ? parsed.skills : parsed) : body.split(/\r?\n/);
    for (const item of items) {
      const name = typeof item === "string" ? item.split(/[:=\s]/)[0]!.trim() : isRecord(item) ? text(item.name) : "";
      if (name) names.add(name.split("/").pop()!.toLowerCase());
    }
  }
  return names;
}

function readHermes(machine: SetupMachine, now: number): FoundApp[] {
  const override = text(machine.env.HERMES_HOME);
  const root = override && isAbsolute(override) ? override : join(machine.home, ".hermes");
  if (!machine.fs.lstat(root)?.isDirectory()) return [];
  const reader = new Reader(machine, root);
  const homes = [{ dir: root, profile: "" }, ...reader.folders(join(root, "profiles"))
    .filter((name) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) && PROFILE_MARKERS.some((marker) => machine.fs.lstat(join(root, "profiles", name, marker))))
    .map((name) => ({ dir: join(root, "profiles", name), profile: name }))];
  const bots: GrokBot[] = [];
  const channels = new Set<string>();
  for (const home of homes.slice(0, MAX_BOTS)) {
    const config = machine.fs.lstat(join(home.dir, "config.yaml")) ? reader.readObject(join(home.dir, "config.yaml"), "yaml") ?? {} : {};
    const own = hermesChannels(config);
    for (const name of own) channels.add(name);
    const bot = hermesBot(reader, home.dir, home.profile, config, now);
    if (!bot) continue;
    bot.apps = mcpApps(config.mcp_servers);
    const model = isRecord(config.model) ? config.model : {};
    const others = hermesOtherPersonalities(config);
    const setup = setupTopic("Hermes Agent", {
      model: modelName(config.model), provider: text(model.provider) === "auto" ? "" : text(model.provider),
      channels: own.map(channelLabel), tools: bot.apps.map((app) => app.name),
      extra: others.length ? ["", "## Other personalities you kept", "", ...others.map(([name, body]) => `- ${name}: ${body}`)] : [],
    });
    if (setup) bot.memoryFiles = { ...bot.memoryFiles, "memory/hermes-agent-setup.md": setup };
    bots.push(bot);
  }
  return bots.length ? [{ source: "hermes", app: "Hermes Agent", where: tilde(machine, root), bots, channels: [...channels], unreadable: reader.unreadable }] : [];
}

function hermesChannels(config: Record<string, unknown>): string[] {
  const places = [config, config.gateway, config.platforms, isRecord(config.gateway) ? config.gateway.platforms : undefined].filter(isRecord);
  return HERMES_PLATFORMS.filter((name) => places.some((place) => isRecord(place[name]) && place[name].enabled !== false));
}

function hermesBot(reader: Reader, dir: string, profile: string, config: Record<string, unknown>, now: number): GrokBot | null {
  const soul = reader.read(join(dir, "SOUL.md"));
  const memory = reader.read(join(dir, "memories", "MEMORY.md"));
  const user = reader.read(join(dir, "memories", "USER.md"));
  const skillsRoot = join(dir, "skills");
  const bundled = bundledSkills(reader, skillsRoot);
  const skills = readSkills(reader, skillsRoot, 3, (path) => bundled.has(path.split(/[\\/]/).pop()!.toLowerCase()));
  const routines = hermesJobs(reader, dir, now);
  const persona = hermesPersona(config);
  const meta = profile && reader.machine.fs.lstat(join(dir, "profile.yaml")) ? reader.readObject(join(dir, "profile.yaml"), "yaml") ?? {} : {};
  const hasAnything = Boolean((soul && hasContent(soul)) || persona || memory || user || skills.length || routines.length);
  if (!hasAnything) return null;
  const bot = blankBot((text(meta.display_name) || headingName(soul) || (profile ? titled(profile) : "Hermes")).slice(0, 100));
  bot.description = text(meta.description);
  bot.instructions = [soul && hasContent(soul) ? soul.trim() : "", persona].filter(Boolean).join("\n\n");
  bot.memories = memory ? hermesEntries(memory) : [];
  bot.userFacts = user ? hermesEntries(user) : [];
  bot.skills = skills;
  bot.routines = routines;
  return bot;
}

/** The personalities it kept but wasn't using, by name, each on one line. */
function hermesOtherPersonalities(config: Record<string, unknown>): Array<[string, string]> {
  const agent = isRecord(config.agent) ? config.agent : {};
  const chosen = isRecord(config.display) ? text(config.display.personality) : "";
  const all = { ...(isRecord(config.personalities) ? config.personalities : {}), ...(isRecord(agent.personalities) ? agent.personalities : {}) };
  return Object.entries(all).filter(([name]) => name !== chosen).slice(0, 20).flatMap(([name, value]) => {
    const body = typeof value === "string" ? value : isRecord(value) ? [text(value.system_prompt), text(value.tone), text(value.style)].filter(Boolean).join(" ") : "";
    return body.trim() ? [[name, body.replace(/\s+/g, " ").trim().slice(0, 600)] as [string, string]] : [];
  });
}

/** The chosen personality (display.personality, from agent.personalities or personalities), else agent.system_prompt. */
function hermesPersona(config: Record<string, unknown>): string {
  const agent = isRecord(config.agent) ? config.agent : {};
  const chosen = isRecord(config.display) ? text(config.display.personality) : "";
  const preset = chosen ? [agent.personalities, config.personalities].filter(isRecord).map((all) => all[chosen]).find((one) => one !== undefined) : undefined;
  const fromPreset = typeof preset === "string" ? preset.trim() : isRecord(preset) ? [text(preset.system_prompt), text(preset.tone), text(preset.style)].filter(Boolean).join("\n\n") : "";
  return fromPreset || text(agent.system_prompt) || text(config.system_prompt);
}

function hermesJobs(reader: Reader, dir: string, now: number): GrokRoutine[] {
  const file = join(dir, "cron", "jobs.json");
  if (!reader.machine.fs.lstat(file)) return [];
  const doc = reader.readObject(file, "json");
  const jobs = Array.isArray(doc?.jobs) ? doc.jobs.filter(isRecord) : [];
  return jobs.flatMap((job) => {
    const instruction = text(job.prompt) || text(job.message);
    if (!instruction) return [];
    const schedule = isRecord(job.schedule) ? job.schedule : {};
    const kind = text(schedule.kind);
    const own = kind === "interval" ? everySchedule(Number(schedule.minutes) * MINUTE, now)
      : kind === "once" ? onceSchedule(schedule.run_at, now) : null;
    const display = text(job.schedule_display) || text(schedule.display);
    // where it sent its results, by app only: chat ids stay there
    const deliver = text(job.deliver).split(",").map((one) => one.split(":")[0]!.trim()).filter((one) => one && one !== "origin" && one !== "local").map(channelLabel);
    return [routine({
      name: text(job.name) || text(job.id) || "Routine",
      instruction,
      trigger: kind === "cron" || own || !kind ? "schedule" : "other",
      cron: kind === "cron" ? text(schedule.expr) : "",
      when: display || text(schedule.expr),
      timeZone: text(job.timezone),
      paused: job.enabled === false || text(job.state) === "paused",
      skills: Array.isArray(job.skills) ? job.skills.filter((skill): skill is string => typeof skill === "string") : text(job.skill) ? [text(job.skill)] : [],
      details: [own || kind === "cron" ? "" : display, deliver.length ? `sent to ${deliver.join(", ")}` : ""].filter(Boolean).join(", "),
      ...(own ? { schedule: own } : {}),
    })];
  });
}

// Metal's own earlier builds: ~/.openmausbot and ~/.opengrokbot, the same layout as Metal's folder (bots.json,
// workspaces/<id>/ with MEMORY.md, memory/ and skills/, routines.json). A first start moves an old folder in; one is
// left behind only when the new folder already had bots.
const OWN_OLD_HOMES = [{ dir: ".openmausbot", app: "your earlier Metal" }, { dir: ".opengrokbot", app: "your earlier Metal" }] as const;

function readOwnOld(machine: SetupMachine, dataDir: string | undefined): FoundApp[] {
  const current = dataDir ? machine.fs.realpath(dataDir) ?? dataDir : null;
  return OWN_OLD_HOMES.flatMap(({ dir, app }) => {
    const root = join(machine.home, dir);
    const info = machine.fs.lstat(root);
    if (!info?.isDirectory() || (current && (machine.fs.realpath(root) ?? root) === current)) return [];
    const reader = new Reader(machine, root);
    const registry = reader.machine.fs.lstat(join(root, "bots.json")) ? reader.read(join(root, "bots.json"), 16 * 1024 * 1024) : null;
    const records = registry === null ? [] : loose(() => JSON.parse(registry));
    if (registry !== null && !Array.isArray(records)) reader.note(join(root, "bots.json"));
    const routineDoc = machine.fs.lstat(join(root, "routines.json")) ? reader.readObject(join(root, "routines.json"), "json", 8 * 1024 * 1024) : null;
    const routines = Array.isArray(routineDoc?.routines) ? routineDoc.routines.filter(isRecord) : [];
    const bots = (Array.isArray(records) ? records : []).filter(isRecord)
      .filter((record) => !record.hidden && !record.defaultBot && text(record.name) && typeof record.id === "string" && /^[\w-]{1,128}$/.test(record.id))
      .slice(0, MAX_BOTS)
      .map((record) => ownOldBot(reader, root, record, routines));
    return bots.length ? [{ source: "openmausbot" as BotMoveSource, app, where: tilde(machine, root), bots, channels: [], unreadable: reader.unreadable }] : [];
  });
}

function ownOldBot(reader: Reader, root: string, record: Record<string, unknown>, routines: Array<Record<string, unknown>>): GrokBot {
  const id = record.id as string;
  const bot = blankBot(text(record.name).slice(0, 100));
  bot.title = text(record.title);
  bot.description = text(record.description);
  bot.instructions = redactSecretsInText(text(record.soul));
  if (typeof record.color === "string") bot.color = record.color;
  const workspace = join(root, "workspaces", id);
  const files: Record<string, string> = {};
  const memory = reader.read(join(workspace, "MEMORY.md"));
  if (memory && memory.split(/\r?\n/).some((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line))) files["MEMORY.md"] = memory;
  const topics = join(workspace, "memory");
  for (const name of reader.isDir(topics) ? reader.files(topics).filter((file) => /\.md$/i.test(file)) : []) {
    const body = reader.read(join(topics, name));
    if (body && hasContent(body)) files[`memory/${name}`] = body;
  }
  bot.memoryFiles = files;
  bot.skills = readSkills(reader, join(workspace, "skills"));
  bot.routines = routines.filter((one) => one.botId === id && !one.groupId).flatMap((one) => {
    const prompt = text(one.prompt);
    const schedule = isRecord(one.schedule) ? one.schedule as PackageRoutineSchedule : undefined;
    return prompt ? [routine({ name: text(one.name) || "Routine", instruction: prompt, paused: one.enabled === false, ...(schedule ? { schedule } : {}) })] : [];
  });
  return bot;
}

// Claude Code's subagents (~/.claude/agents/*.md) and Gemini CLI's (~/.gemini/agents/*.md): Markdown with YAML
// frontmatter (name, description, and for Claude Code a colour; tools, model and MCP servers), the body its system
// prompt. Each becomes a bot of its own.
const AGENT_FOLDERS = [
  { source: "claudeCode", app: "Claude Code", dir: [".claude", "agents"] },
  { source: "gemini", app: "Gemini CLI", dir: [".gemini", "agents"] },
] as const;
const AGENT_COLORS = new Set(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]);

function readAgentFolders(machine: SetupMachine): FoundApp[] {
  return AGENT_FOLDERS.flatMap(({ source, app, dir }) => {
    const root = join(machine.home, ...dir);
    if (!machine.fs.lstat(root)?.isDirectory()) return [];
    const reader = new Reader(machine, root);
    const bots = reader.files(root).filter((name) => /\.md$/i.test(name)).slice(0, MAX_BOTS).flatMap((file) => {
      const raw = reader.read(join(root, file));
      return raw === null ? [] : agentFileBot(raw, file, app);
    });
    return bots.length ? [{ source, app, where: tilde(machine, root), bots, channels: [], unreadable: reader.unreadable }] : [];
  });
}

function agentFileBot(raw: string, file: string, app: string): GrokBot[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const meta = front ? loose(() => parseYaml(front[1]!, { maxAliasCount: 50 })) : {};
  // Claude Code reads its frontmatter leniently: a description with "user: …" examples in it is not valid YAML
  const fields: Record<string, unknown> = isRecord(meta) ? meta : Object.fromEntries((front?.[1] ?? "").split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    return match ? [[match[1]!, match[2]!.trim()]] : [];
  }));
  const body = (front ? front[2]! : raw).trim();
  const id = text(fields.name) || file.replace(/\.md$/i, "");
  if (!body && !text(fields.description)) return [];
  const bot = blankBot(titled(id).slice(0, 100));
  // Claude Code's descriptions say when to hand work to it, sometimes with long examples: the first lines are enough
  bot.description = text(fields.description).replace(/\\n/g, "\n").split(/\n\s*\n|<example>/i)[0]!.trim().slice(0, 1_000);
  bot.instructions = body;
  const color = text(fields.color).toLowerCase();
  if (AGENT_COLORS.has(color)) bot.color = color;
  bot.apps = mcpApps(Array.isArray(fields.mcpServers) ? Object.fromEntries(fields.mcpServers.filter((one): one is string => typeof one === "string").map((name) => [name, {}])) : fields.mcpServers);
  const tools = typeof fields.tools === "string" ? fields.tools : Array.isArray(fields.tools) ? fields.tools.filter((one) => typeof one === "string").join(", ") : "";
  const model = text(fields.model);
  const setup = setupTopic(app, {
    ...(model && model !== "inherit" ? { model } : {}),
    tools: bot.apps.map((one) => one.name),
    extra: tools ? [`- Tools it could use there: ${tools}.`] : [],
  });
  if (setup) bot.memoryFiles = { [`memory/${app.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-setup.md`]: setup };
  return [bot];
}

/** Every other agent app's bots on this computer. One app that can't be read costs the others nothing. */
export function lookForBots(machine: SetupMachine, options: { dataDir?: string; now?: number } = {}): BotLook {
  const now = options.now ?? Date.now();
  const tries: Array<() => FoundApp[]> = [
    () => readOpenClaw(machine, now), () => readHermes(machine, now), () => readAgentFolders(machine), () => readOwnOld(machine, options.dataDir),
  ];
  return { apps: tries.flatMap((look) => loose(look) as FoundApp[] | undefined ?? []) };
}
