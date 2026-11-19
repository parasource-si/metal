import { parseBotPackage, type BotPackageDefinition, type BotPackagePlaybook, type BotPackageSkill, type ParsedBotPackage } from "./bot-package.ts";
import type { DefaultsPreset, PublishedLibrary } from "./presets.ts";
import type { Routine } from "./routines.ts";
import type { BotRecord, GroupRecord, InstalledPlaybook } from "./store.ts";
import {
  AVATAR_MAX_BYTES,
  decodeBase64,
  PACKAGE_FORMAT,
  PACKAGE_MAX_SKILLS,
  PACKAGE_VERSION,
  PackageFormatError,
  parsePackageDocument,
  pictureMatchesMime,
  RELEASE_NOTES_MAX,
  redactPackageSecrets,
  type PackageDefinition,
  type PackageDocument,
  type PackagePreset,
  type PackageRoutineSchedule,
} from "../shared/package-format.ts";

function portableKey(value: string, fallback: string, used: Set<string>): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || fallback;
  let key = stem;
  for (let suffix = 2; used.has(key); suffix++) key = `${stem}-${suffix}`;
  used.add(key);
  return key;
}

/** An Auto room is written as its lead: older apps refuse a package with an `auto` kind. */
function packageRoomResponder(
  responder: GroupRecord["defaultResponder"],
  keys: ReadonlyMap<string, string>,
  members: readonly string[],
): { kind: "agent"; agent: string } | { kind: "everyone" } | { kind: "mentions" } {
  if (responder.kind === "member" && keys.has(responder.botId)) return { kind: "agent", agent: keys.get(responder.botId)! };
  if (responder.kind === "everyone") return { kind: "everyone" };
  if (responder.kind === "auto") {
    const lead = responder.fallbackBotId ? keys.get(responder.fallbackBotId) : undefined;
    return { kind: "agent", agent: lead ?? members[0]! };
  }
  return { kind: "mentions" };
}

function samePlaybook(a: InstalledPlaybook, b: BotPackagePlaybook): boolean {
  return a.name === b.name && a.summary === b.summary && a.instructions === b.instructions &&
    a.triggers.join("\n") === b.triggers.join("\n");
}

export interface ExportablePackageSkill extends Omit<BotPackageSkill, "name" | "description"> {
  name: string;
  description: string;
  enabled?: boolean;
}

function sameSkill(a: ExportablePackageSkill, b: ExportablePackageSkill): boolean {
  return a.instructions === b.instructions && a.description === b.description &&
    a.source === b.source && a.license === b.license && a.compatibility === b.compatibility;
}

function assignPlaybooks(bots: readonly BotRecord[], idToKey: ReadonlyMap<string, string>) {
  const playbooks: BotPackagePlaybook[] = [];
  const playbookKeys = new Set<string>();
  const agentPlaybooks = new Map<string, string[]>();
  for (const bot of bots) {
    const agentKey = idToKey.get(bot.id)!;
    const assigned: string[] = [];
    for (const playbook of bot.playbooks ?? []) {
      const existing = playbooks.find((candidate) => candidate.key === playbook.key);
      if (existing && samePlaybook(playbook, existing)) {
        assigned.push(existing.key);
        continue;
      }
      let key = playbook.key;
      if (existing) key = `${agentKey}-${playbook.key}`;
      key = portableKey(key, `${agentKey}-playbook`, playbookKeys);
      if (!playbooks.some((candidate) => candidate.key === key)) playbooks.push({ ...playbook, key });
      assigned.push(key);
    }
    agentPlaybooks.set(bot.id, assigned);
  }
  return { playbooks, agentPlaybooks };
}

function assignSkills(bots: readonly BotRecord[], skillsByBot?: ReadonlyMap<string, readonly ExportablePackageSkill[]>) {
  const packageSkills = new Map<string, ExportablePackageSkill>();
  const agentSkills = new Map<string, string[]>();
  for (const bot of bots) {
    const assignedSkills: string[] = [];
    for (const skill of skillsByBot?.get(bot.id) ?? []) {
      const existing = packageSkills.get(skill.name);
      if (existing && !sameSkill(existing, skill)) {
        throw new Error(`Skill "${skill.name}" has conflicting content across selected bots`);
      }
      if (!existing) {
        const { enabled: _enabled, ...entry } = skill;
        packageSkills.set(skill.name, entry);
      }
      if (!assignedSkills.includes(skill.name)) assignedSkills.push(skill.name);
    }
    agentSkills.set(bot.id, assignedSkills);
  }
  return { packageSkills, agentSkills };
}

function requiredApps(bots: readonly BotRecord[]) {
  const requirements = new Map<string, { slug: string; label: string; reason: string; optional?: boolean }>();
  for (const bot of bots) {
    for (const app of bot.installedPackage?.requiredApps ?? []) {
      if (!requirements.has(app.slug)) requirements.set(app.slug, { ...app });
    }
  }
  return requirements;
}

/** A limit-reset schedule waits for this computer's engine sign-in, so it never travels in a package. */
const portable = (routine: Routine) => routine.schedule.type !== "limit_reset";

function portableSchedule(schedule: Routine["schedule"]): PackageRoutineSchedule {
  if (schedule.type === "limit_reset") throw new Error("A limit-reset schedule is not portable");
  if (schedule.type === "once") return { type: "once", at: schedule.at };
  if (schedule.type === "cron") return { ...schedule };
  if (schedule.type === "interval") {
    return {
      type: "interval",
      everyMinutes: schedule.everyMinutes,
      anchorAt: schedule.anchorAt,
      ...(schedule.weekdays === undefined ? {} : { weekdays: [...schedule.weekdays] }),
      ...(schedule.window === undefined ? {} : { window: { ...schedule.window } }),
      ...(schedule.endsAt === undefined ? {} : { endsAt: schedule.endsAt }),
    };
  }
  return { type: "daily", time: schedule.time, weekdays: [...schedule.weekdays] };
}

/** A workspace definition, never runtime state: no grants, credentials, approvals, transcripts, memory, paths or engines. */
export function createBotPackageExport(input: {
  name: string;
  authorName?: string;
  bots: BotRecord[];
  groups: GroupRecord[];
  routines: Routine[];
  skillsByBot?: ReadonlyMap<string, readonly ExportablePackageSkill[]>;
}): ParsedBotPackage {
  const bots = input.bots.filter((bot) => !bot.hidden);
  if (!bots.length) throw new Error("Create a bot before exporting your package");

  const packageKeys = new Set<string>();
  const idToKey = new Map<string, string>();
  for (const [index, bot] of bots.entries()) {
    idToKey.set(bot.id, portableKey(bot.name, `bot-${index + 1}`, packageKeys));
  }

  const { playbooks, agentPlaybooks } = assignPlaybooks(bots, idToKey);
  const { packageSkills, agentSkills } = assignSkills(bots, input.skillsByBot);
  const requirements = requiredApps(bots);

  const roomKeys = new Set<string>();
  const rooms: NonNullable<BotPackageDefinition["rooms"]> = [];
  for (const [index, group] of input.groups.filter((group) => !group.dm).entries()) {
    const members = group.memberIds.flatMap((id) => idToKey.has(id) ? [idToKey.get(id)!] : []);
    if (!members.length) continue;
    const defaultResponder = packageRoomResponder(group.defaultResponder, idToKey, members);
    rooms.push({
      key: portableKey(group.name, `room-${index + 1}`, roomKeys),
      name: group.name,
      members,
      bulletin: group.bulletin,
      defaultResponder,
    });
  }

  const routineKeys = new Set<string>();
  const routines: NonNullable<BotPackageDefinition["routines"]> = input.routines.flatMap((routine, index) => {
    if (routine.target === "room-goal" || !portable(routine)) return [];
    const agent = idToKey.get(routine.botId);
    if (!agent) return [];
    return [{
      key: portableKey(routine.name, `routine-${index + 1}`, routineKeys),
      name: routine.name,
      agent,
      prompt: routine.prompt,
      runOn: routine.runOn,
      schedule: portableSchedule(routine.schedule),
      durationMinutes: routine.durationMinutes,
      ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
      ...(routine.overlap === "queue" ? { overlap: "queue" as const } : {}),
      enabledAfterInstall: false as const,
    }];
  });

  const id = portableKey(input.name, "dusk-package", new Set());
  const agents: BotPackageDefinition["agents"] = bots.map((bot) => {
    const appearance: BotPackageDefinition["agents"][number]["appearance"] = { color: bot.color };
    if (bot.mascotExpression) appearance.mascotExpression = bot.mascotExpression;
    if (bot.mascotBody) appearance.mascotBody = bot.mascotBody;
    const agent: BotPackageDefinition["agents"][number] = {
      key: idToKey.get(bot.id)!,
      name: bot.name,
      title: bot.title,
      description: bot.description,
      ...(bot.soul !== undefined ? { soul: bot.soul } : {}),
      appearance,
    };
    const assigned = agentPlaybooks.get(bot.id);
    if (assigned?.length) agent.playbooks = assigned;
    const assignedSkills = agentSkills.get(bot.id);
    if (assignedSkills?.length) agent.skills = assignedSkills;
    return agent;
  });
  const definition: BotPackageDefinition = {
    id,
    release: "1.0.0",
    name: input.name,
    tagline: `A portable Metal setup with ${bots.length} ${bots.length === 1 ? "bot" : "bots"}.`,
    summary: "Exported from Metal. Review the roles, rooms, playbooks, connector requirements, and paused routines before sharing or publishing.",
    category: "Community",
    author: { name: input.authorName?.trim() || "Metal user" },
    license: "Unspecified",
    outcomes: ["Recreate this bot setup without copying private runtime state."],
    setupMinutes: Math.min(240, Math.max(2, bots.length + requirements.size * 2)),
    requirements: { apps: [...requirements.values()], capabilities: [] },
    agents,
  };
  const chief = bots.find((bot) => bot.chiefOfStaff);
  if (chief) definition.chiefOfStaff = idToKey.get(chief.id)!;
  if (rooms.length) definition.rooms = rooms;
  if (routines.length) definition.routines = routines;
  if (playbooks.length) definition.playbooks = playbooks;
  if (packageSkills.size) {
    definition.skills = {
      version: 1,
      entries: [...packageSkills.values()].map((skill) => ({ ...skill })),
    };
  }
  return parseBotPackage({
    format: "openmaus.package",
    version: 1,
    package: definition,
  });
}

export type TeamExportSkipReason =
  | "picture_too_large"
  | "picture_invalid"
  | "stdio_server"
  | "insecure_address"
  | "files_not_shared"
  | "lead_not_in_group_chat"
  | "notes_too_large"
  | "skill_changed"
  | "skill_conflict"
  | "bot_skill_limit"
  | "team_skill_limit"
  | "preset_empty"
  | "preset_skill_conflict";

export interface TeamExportSkip { part: string; reason: TeamExportSkipReason }

export class TeamExportError extends Error {
  readonly status = 400;
}

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export function picture(value: unknown): { mime: "image/png" | "image/jpeg" | "image/webp"; data: string } | "picture_invalid" | "picture_too_large" {
  const match = typeof value === "string" ? DATA_URL.exec(value) : null;
  if (!match) return "picture_invalid";
  const bytes = decodeBase64(match[2]!);
  if (!bytes) return "picture_invalid";
  if (bytes.length > AVATAR_MAX_BYTES) return "picture_too_large";
  if (!pictureMatchesMime(bytes, match[1]!)) return "picture_invalid";
  return { mime: match[1] as "image/png" | "image/jpeg" | "image/webp", data: match[2]! };
}

/** Skill entries never carry their switched-on state: whoever adds the file decides by where it came from. */
function withPresetSkills(
  value: DefaultsPreset,
  packageSkills: Map<string, ExportablePackageSkill>,
  skipped: TeamExportSkip[],
): PackagePreset {
  const kept: string[] = [];
  for (const skill of value.skills) {
    const part = `presets[${value.preset.key}].skills[${skill.name}]`;
    const existing = packageSkills.get(skill.name);
    if (existing) {
      if (sameSkill(existing, skill)) kept.push(skill.name);
      else skipped.push({ part, reason: "preset_skill_conflict" });
      continue;
    }
    if (packageSkills.size >= PACKAGE_MAX_SKILLS) {
      skipped.push({ part, reason: "team_skill_limit" });
      continue;
    }
    const { enabled: _enabled, ...entry } = skill;
    packageSkills.set(skill.name, entry);
    kept.push(skill.name);
  }
  const { skills: _skills, ...preset } = value.preset;
  return { ...preset, ...(kept.length ? { skills: kept } : {}) };
}

function nextPatchRelease(release: string | undefined): string {
  const match = release?.match(/^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/);
  if (!match) return "1.0.0";
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return patch < 999_999 ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}

export const PRESET_TOO_LARGE_MESSAGE = "This preset is too large to share (4 MB). Leave out starter notes or some skills and try again.";

export interface LibraryExportInput {
  name?: string;
  tagline?: string;
  summary?: string;
  release?: string;
  notes?: string;
  authorName?: string;
  published: PublishedLibrary | null;
  preset: DefaultsPreset | null;
  skipped?: readonly TeamExportSkip[];
}

export interface LibraryExportResult {
  document: PackageDocument;
  filename: string;
  redacted: string[];
  skipped: TeamExportSkip[];
  published: PublishedLibrary;
}

export function createLibraryPackageExport(input: LibraryExportInput): LibraryExportResult {
  if (!input.preset) throw new TeamExportError("Your New bot defaults are empty. Give them a name, instructions, skills or starter notes first.");
  const skipped: TeamExportSkip[] = [...(input.skipped ?? [])];
  const release = input.release?.trim() || nextPatchRelease(input.published?.lastRelease);
  if (!SEMVER.test(release)) throw new TeamExportError("Use a version like 1.2.3.");
  const notes = input.notes?.trim();
  if (notes && notes.length > RELEASE_NOTES_MAX) throw new TeamExportError(`Release notes must be at most ${RELEASE_NOTES_MAX} characters.`);
  const displayName = (input.name?.trim() || input.preset.preset.name).slice(0, 100).trim();
  const packageId = input.published?.packageId ?? portableKey(displayName, "preset", new Set());
  const packageSkills = new Map<string, ExportablePackageSkill>();
  const preset = withPresetSkills(input.preset, packageSkills, skipped);
  const definition: PackageDefinition = {
    id: packageId,
    release,
    name: displayName,
    tagline: input.tagline?.trim() || "A preset bot for Metal's New bot dialog.",
    summary: input.summary?.trim() ||
      "Shared from Metal. Adds a preset bot to New bot. Its skills arrive switched off; model choices, computers, approval levels and connected apps never travel.",
    ...(notes ? { notes } : {}),
    category: "Community",
    author: { name: input.authorName?.trim() || "Metal user" },
    license: "Unspecified",
    outcomes: ["Start new bots from a shared preset."],
    setupMinutes: 2,
    requirements: { apps: [], capabilities: [] },
    agents: [],
    presets: [preset],
  };
  if (packageSkills.size) definition.skills = { version: 1, entries: [...packageSkills.values()].map((skill) => ({ ...skill })) };
  const { document: redactedDocument, redacted } = redactPackageSecrets({
    format: PACKAGE_FORMAT, version: PACKAGE_VERSION, package: definition,
  } as PackageDocument);
  let document: PackageDocument;
  try {
    document = parsePackageDocument(redactedDocument, { trust: "file" });
  } catch (error) {
    if (error instanceof PackageFormatError && error.code === "too_large") throw new TeamExportError(PRESET_TOO_LARGE_MESSAGE);
    throw new TeamExportError(error instanceof Error ? error.message : "This preset could not be shared.");
  }
  return {
    document,
    filename: `${document.package.id}-${document.package.release}.dusk.json`,
    redacted,
    skipped,
    published: { packageId, lastRelease: release },
  };
}
