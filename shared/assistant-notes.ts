// Notes from an assistant whose files this computer can't read (ChatGPT, Claude, Gemini, Grok, a bot in another app):
// the person pastes NOTES_PROMPT there, and that assistant writes everything it knows into one markdown file whose front
// matter names NOTES_FORMAT (shared/notes-markdown.ts; the older JSON block is still read). Pasted or dropped into any
// chat here, or saved to Downloads, it is split into About me, the first bot's memory, skills and routines, and a bot
// each for its custom assistants. One combined block, not a file per bot: one copy and one paste whatever the
// assistant holds, and the importer, not the person, does the sorting. Pure text: the renderer and tests both read it.
import { markdownNotes, NOTES_END, NOTES_SETUP } from "./notes-markdown.ts";
import {
  bracedObjects, credentialKeys, GrokImportError, looseJson, mergeGrokBots, readBot, redactStrings, type GrokBot, type GrokSkill, type MoveFrom,
} from "./grok-import.ts";

export const NOTES_FORMAT = "dusk-bot-notes";
export const NOTES_MAX_CHARS = 4 * 1024 * 1024;
/** 3 is a markdown file with front matter, a setup block for Metal, contacts, skills and per-bot personality; 2 (JSON)
 * is still read. */
export const NOTES_VERSION = 3;
export const NOTES_FILE_NAME = "metal-notes.md";
const TEMPLATE_FROM = "<name of this app";
const OLD_TEMPLATE_FROM = "your app's name";

export { NOTES_END };

export const NOTES_PROMPT = `I'm moving to a new assistant called Metal and want it to pick up where you and I are, so I don't start over. Please make me one complete export of everything you know about me and everything I've set up with you. Don't change or delete anything on your side.

Go through all of it: your saved memories, my custom instructions and personalization, every custom GPT, Project, Gem, companion, agent or bot I made (its instructions, personality and attached files), my scheduled tasks, my connected apps, and what you've learned about me from our chats.

Deliver it as ONE file named ${NOTES_FILE_NAME}:
- If you can write files on my computer, save it straight to ~/Downloads/${NOTES_FILE_NAME}.
- Otherwise, if you can make files, give me ${NOTES_FILE_NAME} to download.
- Otherwise, reply with the whole file inside one code block that starts with \`\`\`\`markdown and ends with \`\`\`\`, so I can copy it.

Use exactly this layout. Keep every heading and the front matter in English as written, even if we usually talk in another language; what you write under them can be in any language. Leave out any section you have nothing for. Replace every <...> with the real thing and never leave a placeholder.

---
format: ${NOTES_FORMAT}
version: ${NOTES_VERSION}
from: ${TEMPLATE_FROM}, e.g. Grok, ChatGPT, Claude or Gemini>
exported: <today's date, YYYY-MM-DD>
---

# ${NOTES_SETUP}

<Write this part yourself, to Metal, in 3 to 6 sentences: which app this export comes from and who I am in one line; how many bots are listed under Bots, and that each is an assistant I built here which Metal should recreate as its own bot with the instructions, personality, memories, skills and routines given; that About me, Contacts and Memories are facts about me for the memory all my bots share; that Skills are mine for every bot; and that Routines are things you did for me on a schedule, to set up again.>

# About me
## Basics
- <my name, where I live, my time zone, languages I speak>
## Work
- <my job, company, role, what I'm responsible for>
## Projects
- <each project: what it is, its status, who's involved, key dates>
## Goals
- <what I'm working toward, short and long term>
## Preferences
- <likes, dislikes, food, travel, health, money, anything I prefer>
## Writing style
- <how I write: tone, length, words I use or avoid, formatting I like>
## Tools
- <apps, software, devices and services I use>
## Schedule
- <when I work, sleep and exercise; regular meetings; weekly patterns>

# Contacts
- <a person's name>: <who they are to me, how I reach them if I told you, what to remember>

# How I like answers
~~~text
<my custom instructions and how I've asked you to answer, word for word>
~~~

# Memories
- <each saved memory, word for word, one per line, with its date if you know it>

# Open threads
- <a to-do, open question, or decision I haven't made yet>

# Routines
## <routine name>
- Schedule: <when, in words>
- Cron: <5-field cron, or leave this line out>
- Time zone: <IANA time zone, e.g. Europe/London>
~~~text
<what it does, word for word>
~~~

# Connected apps
- <each app or service connected for me, e.g. Gmail>

# Skills
## <skill name>
- When to use: <one line>
~~~text
<the skill's full text>
~~~

# Bots
## Bot: <its name>
- Kind: <Custom GPT, Project, Gem, companion, agent or bot>
- Description: <what it's for, in one line>
### Instructions
~~~text
<its full instructions, word for word, never summarized>
~~~
### Personality
- <its tone, voice or character, one trait per line>
### Memories
- <something it knows that matters for its job, one per line>
### Knowledge files
- <the name of each file attached to it>
### Skills
#### <skill name>
- When to use: <one line>
~~~text
<the skill's full text>
~~~
### Routines
#### <routine name>
- Schedule: <when, in words>
- Cron: <5-field cron, or leave this line out>
- Time zone: <IANA time zone>
~~~text
<what it does, word for word>
~~~
### Apps
- <app or tool it uses, with its remote MCP address if it has one>

${NOTES_END}

Rules:
- One "## Bot:" section for each custom GPT, Project, Gem, companion, agent or bot I made with its own instructions, each filled in completely before the next. No bots: leave out the Bots section.
- Facts about me go under About me or Contacts, even when a bot learned them. A bot's own Memories are only what matters for its job.
- If you are yourself one of my bots or agents (for example a bot in Grok Bot), you are the one "## Bot:" section: your own instructions, personality, memories, skills, routines and apps go only there, never in the sections above it, which are for me and my whole account.
- Copy saved memories, my custom instructions and each bot's instructions word for word; never summarize them. For everything else be thorough and specific: names, numbers, dates.
- Write only what you actually know. Never guess or invent anything.
- Leave out passwords, API keys, tokens, account numbers and card numbers.
- Keep verbatim text between the ~~~text and ~~~ lines, so headings inside it stay part of it.
- The file's last line is ${NOTES_END}. If it doesn't all fit, stop after a whole section or bot, tell me to say "continue", and give the rest as metal-notes-2.md (then -3 and so on), each part starting with the same front matter. Only the last part ends with ${NOTES_END}.
`;

/** Something the other AI did on a schedule for the person; `cron` and `timeZone` when it gave them. */
export interface NotesRoutine { name: string; instruction: string; when: string; cron?: string; timeZone?: string }

export interface AssistantNotes {
  /** The app the notes come from, as it named itself, and a slug for file names. */
  from: MoveFrom;
  aboutMe: string[];
  instructions: string;
  memories: string[];
  bots: GrokBot[];
  /** To-dos, open questions and things to come back to. */
  openThreads: string[];
  /** Things it did on a schedule for the person, to set up again here. */
  recurring: NotesRoutine[];
  /** The person's own skills, for every bot: kept on the first bot. */
  skills: GrokSkill[];
  /** What the other AI wrote to Metal about the file (SETUP INSTRUCTIONS FOR METAL). */
  setup: string;
  /** Apps it was connected to for the person, by name. */
  apps: string[];
  /** The block was cut off: what was whole before the cut is here, the rest is missing. */
  partial: boolean;
}

/** Cheap enough to run on every paste: the marker and an opening brace. Whether it really is notes is parseNotes's call. */
export function looksLikeNotes(text: string): boolean {
  return text.length <= NOTES_MAX_CHARS && text.includes(NOTES_FORMAT) && (text.includes("{") || /^\s*format\s*:\s*dusk-bot-notes\s*$/m.test(text));
}

/** The prompt itself, pasted here instead of into the other AI: its example block must never be read as notes. */
export function isNotesPrompt(text: string): boolean {
  return text.includes(`from: ${TEMPLATE_FROM}`) || text.includes(`"from": "${OLD_TEMPLATE_FROM}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNotes = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.format === NOTES_FORMAT && !(typeof value.from === "string" && (value.from.startsWith(TEMPLATE_FROM) || value.from.startsWith(OLD_TEMPLATE_FROM)));
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** A list of strings, or one string with a fact per line, as assistants sometimes write it. */
function lines(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  return items.map((item) => (isRecord(item) ? text(item.text ?? item.content ?? item.fact ?? item.name) : text(item)).replace(BULLET, "").trim()).filter(Boolean);
}

/** About me's sections, each fact led by its section so it still reads right on its own line ("Work: …"). An older
 * block's flat list is read as it is. */
const ABOUT_SECTIONS: Record<string, string> = {
  basics: "", identity: "", work: "Work", projects: "Project", goals: "Goal", people: "Person", preferences: "Preference",
  writing_style: "Writing style", writingStyle: "Writing style", tools: "Uses", schedule: "Schedule",
};

function aboutLines(value: unknown): string[] {
  if (!isRecord(value)) return lines(value);
  return Object.entries(value).flatMap(([key, items]) => {
    const label = ABOUT_SECTIONS[key] ?? key.replace(/[_-]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
    return lines(items).map((line) => (!label || line.toLowerCase().startsWith(label.toLowerCase()) ? line : `${label}: ${line}`));
  });
}

function tasks(value: unknown): NotesRoutine[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [{ name: "", instruction: item.trim(), when: "" }] : [];
    if (!isRecord(item)) return [];
    const instruction = text(item.instruction ?? item.prompt ?? item.task);
    const cron = text(item.schedule_cron ?? item.cron);
    const timeZone = text(item.timezone ?? item.timeZone);
    const when = [text(item.schedule_text ?? item.when ?? item.schedule), cron && `(${cron}${timeZone ? `, ${timeZone}` : ""})`].filter(Boolean).join(" ");
    return instruction ? [{ name: text(item.name).slice(0, 100), instruction, when, ...(cron ? { cron } : {}), ...(timeZone ? { timeZone } : {}) }] : [];
  });
}

function ownSkills(value: unknown): GrokSkill[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!isRecord(item)) return [];
    const skill = { name: text(item.name).slice(0, 100), description: text(item.description ?? item.when_to_use), instructions: text(item.instructions ?? item.text ?? item.body) };
    return skill.name && skill.instructions ? [skill] : [];
  });
}

const uniqueTasks = (items: AssistantNotes["recurring"]) => [...new Map(items.map((item) => [`${item.name}\n${item.instruction}`.toLowerCase(), item])).values()];

/** Each bot's attached files, by name, as a topic of its memory: the files themselves stay in the other app. */
function withKnowledgeFiles(bots: GrokBot[], raw: ReadonlyArray<Record<string, unknown>>): GrokBot[] {
  return bots.map((bot) => {
    const files = union(raw.filter((one) => text(one.name).toLowerCase() === bot.name.toLowerCase()).flatMap((one) => lines(one.knowledge_files ?? one.knowledgeFiles ?? one.files)));
    if (!files.length) return bot;
    return { ...bot, memoryFiles: { ...bot.memoryFiles, "memory/knowledge-files.md": `# Files I had\n\nFiles attached to me in the other app. Only their names came over: ask the person for any you need, or to add them to my folder.\n\n${files.map((file) => `- ${file}`).join("\n")}\n` } };
  });
}

/** A block that stops mid-way, closed at the last whole item: the brackets still open are closed and the half-written
 * item is dropped. Null when nothing whole came before the cut. */
export function closeCutOff(source: string): string | null {
  const open: string[] = [];
  let quoted = false, escaped = false;
  let safe: { at: number; open: string[] } | null = null;
  for (let at = 0; at < source.length; at += 1) {
    const ch = source[at]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") {
      open.pop();
      if (!open.length) return source.slice(0, at + 1);
      safe = { at: at + 1, open: [...open] };
    } else if (ch === "," && open.length) safe = { at, open: [...open] };
  }
  if (!safe) return null;
  return source.slice(0, safe.at).replace(/,\s*$/, "") + safe.open.reverse().map((ch) => (ch === "{" ? "}" : "]")).join("");
}

function documentsIn(source: string): { documents: Array<Record<string, unknown>>; partial: boolean } {
  const written = markdownNotes(source, NOTES_FORMAT);
  if (written) {
    const documents = written.documents.filter(isNotes);
    if (documents.length) return { documents, partial: written.partial };
  }
  const repaired = source.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  for (const version of repaired === source ? [source] : [source, repaired]) {
    const whole = looseJson(version.trim());
    if (isNotes(whole)) return { documents: [whole], partial: false };
    const documents = bracedObjects(version).map(looseJson).filter(isNotes);
    if (documents.length) return { documents, partial: false };
  }
  // cut off: the last block's opening brace is the one before its marker
  const marker = repaired.lastIndexOf(NOTES_FORMAT);
  const start = marker < 0 ? -1 : repaired.lastIndexOf("{", marker);
  const closed = start < 0 ? null : closeCutOff(repaired.slice(start));
  const salvaged = closed === null ? undefined : looseJson(closed);
  return isNotes(salvaged) ? { documents: [salvaged], partial: true } : { documents: [], partial: false };
}

const slug = (value: string) => value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const union = (items: string[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The notes in a reply or file: one block, several (a reply split in parts), chat text around them, a cut-off end.
 * Credential-looking keys refuse the whole paste and token-shaped text is redacted, before anything uses it. */
export function parseNotes(source: string): AssistantNotes {
  if (source.length > NOTES_MAX_CHARS) throw new GrokImportError("tooLarge");
  const { documents, partial } = documentsIn(source.replace(/^﻿/, ""));
  if (!documents.length) throw new GrokImportError(source.includes(NOTES_FORMAT) ? "cutOff" : "notExport");
  const refused = documents.flatMap((document) => credentialKeys(document));
  if (refused.length) throw new GrokImportError("credentials", refused.slice(0, 5));
  if (documents.some((document) => typeof document.version === "number" && document.version > NOTES_VERSION)) throw new GrokImportError("newerVersion");
  const rawBots = documents.flatMap((document) => (Array.isArray(document.bots) ? document.bots.filter(isRecord) : []));
  const name = documents.map((document) => text(document.from)).find(Boolean)?.replace(/\s+/g, " ").slice(0, 60) || "another AI";
  const notes: AssistantNotes = redactStrings({
    from: { name, key: slug(name) || "another-ai" },
    aboutMe: union(documents.flatMap((document) => aboutLines(document.about_me ?? document.aboutMe))),
    instructions: union(documents.map((document) => text(document.instructions)).filter(Boolean)).join("\n\n"),
    memories: union(documents.flatMap((document) => lines(document.memories))),
    bots: withKnowledgeFiles(mergeGrokBots(rawBots.map(readBot).filter((bot) => bot.name)), rawBots),
    openThreads: union(documents.flatMap((document) => lines(document.open_threads ?? document.openThreads ?? document.todos))),
    recurring: uniqueTasks(documents.flatMap((document) => tasks(document.recurring_tasks ?? document.recurringTasks ?? document.routines))),
    apps: union(documents.flatMap((document) => lines(document.connected_apps ?? document.connectedApps ?? document.apps).map((app) => app.slice(0, 100)))),
    skills: [...new Map(documents.flatMap((document) => ownSkills(document.skills)).map((skill) => [skill.name.toLowerCase(), skill])).values()],
    setup: union(documents.map((document) => text(document.setup)).filter(Boolean)).join("\n\n"),
    partial,
  });
  dropBotsOwn(notes);
  if (!notes.aboutMe.length && !notes.instructions && !notes.memories.length && !notes.bots.length && !notes.openThreads.length && !notes.recurring.length && !notes.skills.length) {
    throw new GrokImportError(partial ? "cutOff" : "notExport");
  }
  return notes;
}

/** A bot answering for itself (a Grok bot) may write its own instructions, memories, skills and routines at the top as
 * well as in its own section: they are that bot's, so the top's copies go, and nothing is made twice. */
function dropBotsOwn(notes: AssistantNotes): void {
  const flat = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const bots = notes.bots;
  if (!bots.length) return;
  const routineNames = new Set(bots.flatMap((bot) => bot.routines.flatMap((one) => [flat(one.name), flat(one.instruction)])).filter(Boolean));
  const skillNames = new Set(bots.flatMap((bot) => bot.skills.map((one) => flat(one.name))));
  const memories = new Set(bots.flatMap((bot) => bot.memories.map(flat)));
  notes.recurring = notes.recurring.filter((one) => !(one.name && routineNames.has(flat(one.name))) && !routineNames.has(flat(one.instruction)));
  notes.skills = notes.skills.filter((one) => !skillNames.has(flat(one.name)));
  notes.memories = notes.memories.filter((one) => !memories.has(flat(one)));
  if (notes.instructions && bots.some((bot) => flat(bot.instructions).includes(flat(notes.instructions)))) notes.instructions = "";
}

/** The first bot's memory topic for what the assistant remembered: projects and ongoing work, by the app it came from. */
export function notesMemoryFile(notes: Pick<AssistantNotes, "from">): string {
  return `memory/notes-from-${notes.from.key}.md`;
}

/** The memory topic's text, merged with what an earlier paste from the same app left there, each line once. */
export function notesMemoryText(notes: Pick<AssistantNotes, "from" | "memories">, before = ""): string | null {
  const earlier = before.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
  const all = union([...earlier, ...notes.memories.map((line) => line.replace(/\s*\n\s*/g, " "))]);
  if (!all.length) return null;
  return `# Notes from ${notes.from.name}\n\nWhat ${notes.from.name} remembered, brought over when you moved.\n\n${all.map((line) => `- ${line}`).join("\n")}\n`;
}

/** The first bot's topic for what is still open, things done on a schedule and connected apps. */
export function notesThreadsFile(notes: Pick<AssistantNotes, "from">): string {
  return `memory/open-threads-from-${notes.from.key}.md`;
}

/** That topic's text, merged with an earlier paste's, each line once; null when there is nothing in it. */
export function notesThreadsText(notes: Pick<AssistantNotes, "from" | "openThreads" | "recurring" | "apps">, before = ""): string | null {
  const earlier = (heading: string) => {
    const at = before.indexOf(`## ${heading}\n`);
    if (at < 0) return [];
    const end = before.indexOf("\n## ", at + 3);
    return before.slice(at, end < 0 ? undefined : end).split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
  };
  const flat = (line: string) => line.replace(/\s*\n\s*/g, " ");
  const open = union([...earlier("Still open"), ...notes.openThreads.map(flat)]);
  const recurring = union([...earlier("Done on a schedule"), ...notes.recurring.map((task) => flat(`${task.name ? `${task.name}: ` : ""}${task.instruction}${task.when ? ` (${task.when})` : ""}`))]);
  const apps = union([...earlier("Connected there"), ...notes.apps.map(flat)]);
  if (!open.length && !recurring.length && !apps.length) return null;
  const part = (heading: string, items: string[], lead: string) => (items.length ? [`## ${heading}`, lead, "", ...items.map((item) => `- ${item}`), ""] : []);
  return [`# Open threads from ${notes.from.name}`, "",
    ...part("Still open", open, "To-dos, open questions and things to come back to."),
    ...part("Done on a schedule", recurring, "Ask the person before setting any of these up as a routine here."),
    ...part("Connected there", apps, "Connect these in apps to use them here."),
  ].join("\n");
}

export const ABOUT_ME_LIMIT = 24_000;

/** About me with the person's facts and their standing instructions added under a heading for the app, lines it already
 * has left out; null when nothing is new. What doesn't fit the limit is left out from the end. */
const LEARNED_PREFIX = /^\s*-\s*\d{4}-\d{2}-\d{2} · learned by [^·\n]* · /;

function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Imported facts join the general memory as learned lines (`- date · learned by ChatGPT · fact`), so the nightly
 * consolidation merges them with what bots learn, lets a newer fact replace one, and keeps them within its budget;
 * the custom instructions stay the person's own words. */
export function aboutMeWithNotes(current: string, notes: Pick<AssistantNotes, "from" | "aboutMe" | "instructions">, today = localDay()): { text: string; added: number } | null {
  const fold = (line: string) => line.replace(LEARNED_PREFIX, "").replace(BULLET, "").replace(/\s+/g, " ").trim().toLowerCase();
  const have = new Set(current.split("\n").map(fold).filter(Boolean));
  const facts = notes.aboutMe.map((line) => line.replace(/\s*\n\s*/g, " ").trim()).filter((line) => line && !have.has(fold(line)));
  const instructions = notes.instructions && !current.includes(notes.instructions.trim()) ? notes.instructions.trim() : "";
  if (!facts.length && !instructions) return null;
  const source = notes.from.name.replace(/·/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "import";
  const parts = [
    ...(facts.length ? [facts.map((line) => `- ${today} · learned by ${source} · ${line}`).join("\n")] : []),
    ...(instructions ? [`How I like answers (from ${notes.from.name}):\n${instructions}`] : []),
  ];
  const lead = current.trimEnd();
  const text = `${lead}${lead ? "\n\n" : ""}${parts.join("\n\n")}`.slice(0, ABOUT_ME_LIMIT);
  return { text, added: facts.length + (instructions ? 1 : 0) };
}
