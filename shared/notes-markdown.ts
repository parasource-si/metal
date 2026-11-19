// The notes file NOTES_PROMPT asks for (shared/assistant-notes.ts), read back: front matter naming the format, a setup
// block the other AI wrote for Metal, then sections by heading. Verbatim text sits between ~~~ (or ```) fences so a
// heading inside someone's instructions stays part of them. Each file (or part of a split one) becomes one document in
// the same shape as the JSON notes, so everything after reading is shared. Pure text: the renderer and tests read it.

/** The last line of a whole file; a file without it was cut off. */
export const NOTES_END = "END OF METAL NOTES";
export const NOTES_SETUP = "SETUP INSTRUCTIONS FOR METAL";
const LEGACY_NOTES_END = "END OF DUSK BOT NOTES";
const SETUP_HEADINGS = [NOTES_SETUP.toLowerCase(), "setup instructions for dusk bot"];

interface Section { level: number; title: string; body: string[]; children: Section[] }

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*(?:[-*•+]|\d+[.)])\s+/;
const FIELD = /^\s*(?:[-*•+]\s+)?\**([A-Za-z][A-Za-z ]{0,30}?)\**\s*:\s*(?:\*\*\s*)?(.*)$/;

const key = (title: string) => title.toLowerCase().replace(/^(?:bot|skill|routine)\s*:\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const own = (title: string) => title.replace(/^\s*(?:bot|skill|routine)\s*:\s*/i, "").replace(/^[*_`<]+|[*_`>]+$/g, "").trim();
/** A line the AI copied from the template instead of filling in. */
const placeholder = (line: string) => /^(?:\.{3}|…|<[^>]*>|\[[^\]]*\]|n\/?a|none|tbd|unknown|-)$/i.test(line.trim());

/** Headings outside fences, as a tree; a fence's lines (and its own fence lines) stay in their section's body. */
function sections(lines: string[]): Section {
  const root: Section = { level: 0, title: "", body: [], children: [] };
  const stack = [root];
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const fenced = FENCE.exec(line);
    if (fence) {
      if (fenced && fenced[1]![0] === fence.char && fenced[1]!.length >= fence.length && !fenced[2]!.trim()) fence = null;
      stack.at(-1)!.body.push(line);
      continue;
    }
    if (fenced) {
      fence = { char: fenced[1]![0]!, length: fenced[1]!.length };
      stack.at(-1)!.body.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const section: Section = { level: heading[1]!.length, title: heading[2]!.trim(), body: [], children: [] };
      while (stack.length > 1 && stack.at(-1)!.level >= section.level) stack.pop();
      stack.at(-1)!.children.push(section);
      stack.push(section);
      continue;
    }
    stack.at(-1)!.body.push(line);
  }
  return root;
}

/** The body split into what is fenced (each fence's inside) and what is not. */
function split(body: string[]): { fenced: string[]; plain: string[] } {
  const fenced: string[] = [];
  const plain: string[] = [];
  let open: { char: string; length: number; lines: string[] } | null = null;
  for (const line of body) {
    const fence = FENCE.exec(line);
    if (open) {
      if (fence && fence[1]![0] === open.char && fence[1]!.length >= open.length && !fence[2]!.trim()) {
        fenced.push(open.lines.join("\n"));
        open = null;
      } else open.lines.push(line);
    } else if (fence) open = { char: fence[1]![0]!, length: fence[1]!.length, lines: [] };
    else plain.push(line);
  }
  if (open) fenced.push(open.lines.join("\n"));
  return { fenced, plain };
}

const FIELD_NAMES = new Set(["kind", "description", "what it s for", "purpose", "when to use", "schedule", "when", "cron", "time zone", "timezone", "bot", "for bot", "instruction", "what it does", "mcp", "mcp url", "address"]);

/** `- Key: value` lines of known keys, by lowercased key. */
function fields(body: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of split(body).plain) {
    const match = FIELD.exec(line);
    const name = match ? key(match[1]!) : "";
    if (match && FIELD_NAMES.has(name) && !(name in out) && !placeholder(match[2]!)) out[name] = match[2]!.trim();
  }
  return out;
}

const isField = (line: string) => {
  const match = FIELD.exec(line);
  return Boolean(match && FIELD_NAMES.has(key(match[1]!)));
};

/** List items outside fences; a line that isn't a bullet continues the item before it. Template leftovers are dropped. */
function items(body: string[]): string[] {
  const out: string[] = [];
  let open = false;
  for (const line of split(body).plain) {
    if (!line.trim()) { open = false; continue; }
    if (BULLET.test(line)) {
      out.push(line.replace(BULLET, "").trim());
      open = true;
    } else if (open && out.length) out[out.length - 1] += ` ${line.trim()}`;
    else {
      out.push(line.trim());
      open = true;
    }
  }
  return out.map((item) => item.replace(/^\*\*(.+?)\*\*/, "$1")).filter((item) => item && !placeholder(item));
}

/** A section's verbatim text: its fences when it has any, else its body without the field lines. */
function verbatim(body: string[]): string {
  const { fenced, plain } = split(body);
  const text = fenced.length ? fenced.join("\n\n") : plain.filter((line) => !isField(line)).join("\n");
  const trimmed = text.trim();
  return placeholder(trimmed) ? "" : trimmed;
}

const find = (parent: Section, ...names: string[]) => parent.children.find((child) => names.includes(key(child.title)));

/** A section and every section under it, as one body, for a part whose heading levels came out uneven. */
const whole = (section: Section): string[] => [...section.body, ...section.children.flatMap((child) => [`${"#".repeat(child.level)} ${child.title}`, ...whole(child)])];
/** Its list items and those of every section under it, each led by its sub-heading ("Work: ...") when it has one. */
const listed = (section: Section | undefined): string[] => !section ? [] : [
  ...items(section.body),
  ...section.children.flatMap((child) => listed(child).map((line) => (line.toLowerCase().startsWith(own(child.title).toLowerCase()) ? line : `${own(child.title)}: ${line}`))),
];

function routine(section: Section): Record<string, unknown> | null {
  const given = fields(section.body);
  const instruction = verbatim(section.body) || given["instruction"] || given["what it does"] || "";
  const name = own(section.title);
  if (!instruction && !name) return null;
  return {
    name, instruction: instruction || name,
    schedule_text: given["schedule"] ?? given["when"] ?? "", schedule_cron: (given["cron"] ?? "").replace(/^`|`$/g, ""),
    timezone: given["time zone"] ?? given["timezone"] ?? "", bot: given["bot"] ?? given["for bot"] ?? "",
  };
}

function skill(section: Section): Record<string, unknown> | null {
  const given = fields(section.body);
  const name = own(section.title);
  const instructions = verbatim(section.body);
  return name && instructions ? { name, description: given["when to use"] ?? given["description"] ?? "", instructions } : null;
}

function app(line: string): Record<string, unknown> {
  const url = /https:\/\/[^\s)>\]]+/.exec(line)?.[0] ?? "";
  const name = line.replace(/\(?\s*https:\/\/[^\s)>\]]+\s*\)?/, "").replace(/[\s:,-]+$/, "").trim();
  return { name: name || url, mcp_url: url };
}

function bot(section: Section): Record<string, unknown> | null {
  const name = own(section.title);
  if (!name) return null;
  const given = fields(section.body);
  const instructions = find(section, "instructions", "system prompt", "prompt");
  const personality = find(section, "personality", "tone", "voice");
  const traits = personality ? items(personality.body) : [];
  const text = [instructions ? verbatim(whole(instructions)) : verbatim(section.body), traits.length ? `## Personality\n\n${traits.map((line) => `- ${line}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  const list = (...names: string[]) => { const at = find(section, ...names); return at ? items(at.body) : []; };
  const skills = find(section, "skills", "tools and skills");
  const routines = find(section, "routines", "recurring tasks", "scheduled tasks");
  return {
    name, title: given["kind"] ?? "", description: given["description"] ?? given["what it s for"] ?? given["purpose"] ?? "",
    instructions: text,
    memories: list("memories", "memory", "what it knows"),
    knowledge_files: list("knowledge files", "files", "knowledge"),
    skills: skills ? skills.children.map(skill).filter(Boolean) : [],
    routines: routines ? routines.children.map(routine).filter(Boolean) : [],
    apps: list("apps", "connected apps", "tools").map(app),
  };
}

const ABOUT_KEYS: Record<string, string> = {
  basics: "basics", identity: "basics", work: "work", projects: "projects", goals: "goals", people: "people", preferences: "preferences",
  "writing style": "writing_style", tools: "tools", schedule: "schedule",
};

/** One file's (or part's) text after its front matter, as a JSON-shaped notes document. */
function document(front: Record<string, string>, lines: string[]): Record<string, unknown> {
  const root = sections(lines);
  // a heading the AI added around everything ("# My notes") is looked through
  const top = root.children.flatMap((child) => (KNOWN_TOP.has(key(child.title)) ? [child] : child.children));
  const at = (...names: string[]) => top.find((child) => names.includes(key(child.title)));
  const about: Record<string, string[]> = {};
  const aboutMe = at("about me", "about the user", "about you");
  if (aboutMe) {
    if (items(aboutMe.body).length) about.basics = items(aboutMe.body);
    for (const child of aboutMe.children) {
      const name = ABOUT_KEYS[key(child.title)] ?? key(child.title).replace(/ /g, "_");
      about[name] = [...(about[name] ?? []), ...items(child.body), ...child.children.flatMap(listed)];
    }
  }
  const contacts = at("contacts", "people");
  if (contacts) about.people = [...(about.people ?? []), ...listed(contacts)];
  const instructions = at("how i like answers", "custom instructions", "instructions", "personalization");
  const bots = (at("bots", "assistants", "custom gpts", "agents")?.children ?? []).map(bot).filter((one): one is Record<string, unknown> => Boolean(one));
  const routines = (at("routines", "recurring tasks", "scheduled tasks")?.children ?? []).map(routine).filter((one): one is Record<string, unknown> => Boolean(one));
  // a routine naming one of the bots is that bot's; the rest are the person's own
  const general = routines.filter((one) => {
    const owner = bots.find((candidate) => String(one.bot).trim() && String(candidate.name).toLowerCase() === String(one.bot).trim().toLowerCase());
    if (owner) (owner.routines as unknown[]).push(one);
    return !owner;
  });
  const setup = at(...SETUP_HEADINGS);
  return {
    format: front.format, version: Number(front.version) || undefined, from: front.from ?? "",
    about_me: about,
    instructions: instructions ? verbatim(whole(instructions)) : "",
    memories: listed(at("memories", "saved memories")),
    open_threads: listed(at("open threads", "to dos", "todos")),
    recurring_tasks: general,
    connected_apps: listed(at("connected apps", "apps")),
    skills: (at("skills", "skills and tools")?.children ?? []).map(skill).filter(Boolean),
    bots,
    setup: setup ? split(whole(setup)).plain.join("\n").trim() : "",
  };
}

const KNOWN_TOP = new Set([
  ...SETUP_HEADINGS, "about me", "about the user", "about you", "contacts", "people", "how i like answers", "custom instructions",
  "instructions", "personalization", "memories", "saved memories", "open threads", "to dos", "todos", "routines", "recurring tasks",
  "scheduled tasks", "connected apps", "apps", "skills", "skills and tools", "bots", "assistants", "custom gpts", "agents",
]);

/** Front matter naming `format`: its keys, and where the text after it starts. */
function frontMatterAt(lines: string[], from: number, format: string): { front: Record<string, string>; start: number; body: number } | null {
  for (let at = from; at < lines.length; at += 1) {
    if (lines[at]!.trim() !== "---") continue;
    const front: Record<string, string> = {};
    let end = at + 1;
    for (; end < lines.length && end < at + 20 && lines[end]!.trim() !== "---"; end += 1) {
      const pair = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(lines[end]!);
      if (pair) front[pair[1]!.toLowerCase()] = pair[2]!.replace(/^["']|["']$/g, "");
    }
    if (end < lines.length && lines[end]!.trim() === "---" && front.format === format) return { front, start: at, body: end + 1 };
  }
  return null;
}

/** Every notes document in a reply or file: one per front matter, so a split answer's parts read as one. `partial` when
 * no part ends with NOTES_END. Null when there is no front matter naming the format. */
export function markdownNotes(source: string, format: string): { documents: Array<Record<string, unknown>>; partial: boolean } | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const found: Array<{ front: Record<string, string>; start: number; body: number }> = [];
  for (let next = frontMatterAt(lines, 0, format); next; next = frontMatterAt(lines, next.body, format)) found.push(next);
  if (!found.length) return null;
  let ended = false;
  const documents = found.map((part, index) => {
    const end = found[index + 1]?.start ?? lines.length;
    let body = lines.slice(part.body, end);
    const last = body.findIndex((line) => {
      const marker = line.trim().replace(/[*_`]/g, "");
      return marker === NOTES_END || marker === LEGACY_NOTES_END;
    });
    if (last >= 0) {
      ended = true;
      body = body.slice(0, last);
    }
    return document(part.front, body);
  });
  return { documents, partial: !ended };
}
