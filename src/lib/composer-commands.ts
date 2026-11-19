import { blankCode, offersSkillCommand } from "../../shared/skill-command";

export type ComposerSlashCommandId = "goal" | "learn" | "setup";

export type ComposerSlashCommand =
  | { kind: "command"; id: ComposerSlashCommandId; label: `/${ComposerSlashCommandId}`; description: string }
  | { kind: "skill"; id: string; label: `/${string}`; description: string; fromTools?: true }
  /** The closed row that shows the skills from the person's other AI tools. */
  | { kind: "more"; id: "more"; label: string; description: string; count: number };

export interface SlashSkill {
  name: string;
  description: string;
  /** Found in another AI tool's own skills folder (the engine's, or brought in from Claude Code, Codex and the rest),
   * not made in Metal by the person or a bot. */
  fromTools?: true;
}

export function skillSlashCommands(skills: readonly SlashSkill[]): ComposerSlashCommand[] {
  return skills
    .filter((skill) => offersSkillCommand(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({ kind: "skill", id: skill.name, label: `/${skill.name}`, description: skill.description, ...(skill.fromTools ? { fromTools: true as const } : {}) }));
}

/** The / list: Metal's commands, then the skills made in Metal, then the other tools' skills behind one More row
 * until it is opened. A typed search looks through all of them. */
export function slashMenuRows(
  commands: readonly ComposerSlashCommand[],
  skills: readonly ComposerSlashCommand[],
  query: string,
  moreOpen: boolean,
  moreLabel: (count: number) => { label: string; description: string },
): ComposerSlashCommand[] {
  const own = skills.filter((skill) => !(skill.kind === "skill" && skill.fromTools));
  const tools = skills.filter((skill) => skill.kind === "skill" && skill.fromTools);
  const matching = (rows: readonly ComposerSlashCommand[]) => rows.filter((row) => slashCommandMatches(row, query));
  if (query || moreOpen || !tools.length) return [...matching(commands), ...matching(own), ...matching(tools)];
  return [...commands, ...own, { kind: "more", id: "more", count: tools.length, ...moreLabel(tools.length) }];
}

export function slashCommandMatches(command: ComposerSlashCommand, query: string): boolean {
  const needle = query.toLowerCase();
  return !needle || command.id.startsWith(needle) || command.description.toLowerCase().includes(needle);
}

export interface ComposerSlashTrigger {
  query: string;
  start: number;
  end: number;
}

export function composerSlashTrigger(text: string, caretInput: number): ComposerSlashTrigger | null {
  const caret = Math.max(0, Math.min(text.length, Math.floor(caretInput)));
  const prefix = text.slice(0, caret);
  const match = /(?:^|\s)\/([a-z0-9-]*)$/i.exec(prefix);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  return blankCode(text)[start] === "/" ? { query, start, end: caret } : null;
}

export function goalTextFromComposer(text: string): string | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text);
  return match ? (match[1] ?? "").trimStart() : null;
}

export function replaceComposerSlashTrigger(
  text: string,
  trigger: ComposerSlashTrigger,
  replacement: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return { text: next, caret: trigger.start + replacement.length };
}
