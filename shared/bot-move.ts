// "Bring your bots": the bots a person kept in another agent app on this computer (OpenClaw and its old names Clawdbot
// and Moltbot, Hermes Agent, Claude Code's and Gemini CLI's own agents, and Metal's own earlier builds), as the
// desktop app's server reads them, before they move in as packages.
import type { GrokBot, MoveFrom } from "./grok-import.ts";

export type BotMoveSource = "openclaw" | "hermes" | "openmausbot" | "claudeCode" | "gemini";
const SOURCES: readonly string[] = ["openclaw", "hermes", "openmausbot", "claudeCode", "gemini"] satisfies BotMoveSource[];

export interface FoundApp {
  source: BotMoveSource;
  /** The name it was installed under (OpenClaw, Clawdbot, Moltbot, Hermes Agent), or "your earlier Metal" for Metal's own old data folders. */
  app: string;
  /** The folder it was read from, written with ~. */
  where: string;
  bots: GrokBot[];
  /** Chat apps it answered on (telegram, discord, …), by name only: their tokens are never read. */
  channels: string[];
  /** Parts that were there but could not be read, by name (a file, a bot): what was readable still comes over. */
  unreadable: string[];
}

export interface BotLook {
  apps: FoundApp[];
}

export const EMPTY_LOOK: BotLook = { apps: [] };

/** The slug a moved bot's files and package id are named after. */
export function moveFrom(app: Pick<FoundApp, "app">): MoveFrom {
  return { name: app.app, key: app.app.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other-app" };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** A look as the renderer receives it: anything malformed is dropped rather than trusted. */
export function readBotLook(value: unknown): BotLook {
  if (!isRecord(value) || !Array.isArray(value.apps)) return EMPTY_LOOK;
  const apps = value.apps.flatMap((app): FoundApp[] => {
    if (!isRecord(app) || typeof app.app !== "string" || !Array.isArray(app.bots)) return [];
    if (typeof app.source !== "string" || !SOURCES.includes(app.source)) return [];
    const bots = app.bots.filter((bot): bot is GrokBot => isRecord(bot) && typeof bot.name === "string" && Array.isArray(bot.skills) && Array.isArray(bot.routines));
    return [{ source: app.source as BotMoveSource, app: app.app, where: typeof app.where === "string" ? app.where : "", bots, channels: strings(app.channels), unreadable: strings(app.unreadable) }];
  });
  return { apps };
}
