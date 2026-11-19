// What a person's MCP servers say about their own tools (title, read-only, destructive), learned from tools/list and
// kept per server configuration, so an approval can read "Create a page in Notion" and a plain read need not ask.
// Security: annotations are the server's own claims. A read-only claim only skips the ask when the tool's name has no
// write word in it and the server doesn't also call it destructive; anything unsure keeps asking.
import { isReadOnlyTool, isOutboundTool } from "../shared/outbound.ts";
import { isConnectedAppsServer } from "../shared/own-apps.ts";
import type { McpServerSpec } from "./contracts.ts";
import { mcpServerConfigHash } from "./mcp-app-catalog.ts";
import { redactSecretsInText } from "./redact.ts";

export interface McpToolHint {
  title?: string;
  readOnly: boolean;
  destructive: boolean;
}

/** The parts of a tool call an approval card names: the thing it works on, and an HTTP method for api_request. */
export interface ToolCallFacts {
  target?: string;
  /** The target came from a list holding one item ("create pages" with one page reads "create a page"). */
  single?: boolean;
  method?: string;
}

const HINTS_TTL_MS = 6 * 60 * 60_000;
const FAILED_RETRY_MS = 2 * 60_000;
const LIST_MS = 15_000;
const MAX_TOOLS = 500;
const TARGET_MAX = 80;
const TARGET_KEYS = ["title", "name", "subject", "summary", "query", "content", "text", "message", "description"];
const WRITE_WORDS = new Set([
  "create", "update", "delete", "remove", "send", "post", "write", "edit", "move", "archive", "add", "set", "insert", "upsert",
  "patch", "put", "publish", "share", "invite", "cancel", "complete", "close", "assign", "upload", "merge", "duplicate",
  "restore", "rename", "reply", "forward", "pay", "transfer", "run", "execute", "trash", "submit", "approve", "reject",
]);

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function toolHint(tool: unknown): [string, McpToolHint] | null {
  if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name) return null;
  const annotations = isRecord(tool.annotations) ? tool.annotations : {};
  const title = typeof annotations.title === "string" ? annotations.title : typeof tool.title === "string" ? tool.title : undefined;
  return [tool.name, {
    ...(title?.trim() ? { title: title.trim().slice(0, 120) } : {}),
    readOnly: annotations.readOnlyHint === true,
    destructive: annotations.destructiveHint === true,
  }];
}

const nameWords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export class McpToolHints {
  private readonly entries = new Map<string, { at: number; tools: Map<string, McpToolHint> }>();
  private readonly loading = new Map<string, { at: number; done: Promise<void>; failed?: true }>();
  private readonly now: () => number;
  private readonly deps: { list(name: string, server: McpServerSpec, signal: AbortSignal): Promise<unknown[]>; now?(): number };

  constructor(deps: McpToolHints["deps"]) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private key(name: string, server: McpServerSpec | Json): string {
    return `${name}\u0000${mcpServerConfigHash(server)}`;
  }

  record(name: string, server: McpServerSpec | Json, tools: readonly unknown[]): void {
    const map = new Map<string, McpToolHint>();
    for (const tool of tools.slice(0, MAX_TOOLS)) {
      const hint = toolHint(tool);
      if (hint) map.set(hint[0], hint[1]);
    }
    this.entries.set(this.key(name, server), { at: this.now(), tools: map });
  }

  get(name: string, server: McpServerSpec | Json, tool: string): McpToolHint | undefined {
    return this.entries.get(this.key(name, server))?.tools.get(tool);
  }

  /** Learns a server's tools in the background; at most one list at a time, and a failed one waits before the next. */
  warm(name: string, server: McpServerSpec): Promise<void> {
    const key = this.key(name, server);
    const known = this.entries.get(key);
    if (known && this.now() - known.at < HINTS_TTL_MS) return Promise.resolve();
    const running = this.loading.get(key);
    if (running && (!running.failed || this.now() - running.at < FAILED_RETRY_MS)) return running.done;
    const entry: { at: number; done: Promise<void>; failed?: true } = { at: this.now(), done: Promise.resolve() };
    entry.done = this.deps.list(name, server, AbortSignal.timeout(LIST_MS))
      .then((tools) => { this.record(name, server, tools); this.loading.delete(key); })
      .catch(() => { entry.at = this.now(); entry.failed = true; });
    this.loading.set(key, entry);
    return entry.done;
  }

  /** Whether a call only reads, so no mode below Full needs to ask: the server marks it read-only (and its name agrees),
   * Metal's own api_request is a GET, or it is a known read of Metal's own app servers. */
  readsOnly(input: { server: string; tool: string; spec: McpServerSpec | Json; facts?: ToolCallFacts; apiServer?: boolean }): boolean {
    const full = `mcp__${input.server}__${input.tool}`;
    if (isOutboundTool(full)) return false;
    if (input.apiServer) return input.tool === "api_request" && input.facts?.method?.toUpperCase() === "GET";
    if (isConnectedAppsServer(input.server)) return isReadOnlyTool(full);
    const hint = this.get(input.server, input.spec, input.tool);
    if (!hint?.readOnly || hint.destructive) return false;
    return !nameWords(input.tool).some((word) => WRITE_WORDS.has(word));
  }
}

function clean(text: string): string {
  const line = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return line.length > TARGET_MAX ? `${line.slice(0, TARGET_MAX - 1)}…` : line;
}

function findTarget(input: unknown, keys: readonly string[]): { target: string; single?: true } | undefined {
  let level: Array<{ value: unknown; single: boolean }> = [{ value: input, single: false }];
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next: typeof level = [];
    for (const { value, single } of level) {
      if (Array.isArray(value)) { for (const item of value.slice(0, 20)) next.push({ value: item, single: value.length === 1 }); continue; }
      if (!isRecord(value)) continue;
      for (const key of keys) {
        const found = value[key];
        if (typeof found === "string" && found.trim()) return { target: clean(found), ...(single ? { single: true as const } : {}) };
      }
      // Notion-style rich text, {"title": [{"text": {"content": "…"}}]}, is looked into like any other value
      for (const inner of Object.values(value)) if (isRecord(inner) || Array.isArray(inner)) next.push({ value: inner, single });
    }
    level = next.slice(0, 200);
  }
  return undefined;
}

/** The thing a call works on: the first title-like string in its input, looked for breadth first. */
export function toolCallFacts(input: unknown): ToolCallFacts {
  const facts: ToolCallFacts = {};
  if (isRecord(input) && typeof input.method === "string" && /^[A-Za-z]{3,7}$/.test(input.method)) {
    facts.method = input.method.toUpperCase();
    if (typeof input.path === "string" && input.path.trim()) return { ...facts, target: clean(input.path) };
  }
  // a name-like key anywhere wins over body text nearer the top
  for (const keys of [TARGET_KEYS.slice(0, 4), TARGET_KEYS.slice(4)]) {
    const found = findTarget(input, keys);
    if (found) return { ...facts, ...found };
  }
  return facts;
}

/** The same facts from a driver's display summary (its input as JSON, maybe cut short), for engines that send no more. */
export function toolCallFactsFromSummary(summary: string): ToolCallFacts {
  try { return toolCallFacts(JSON.parse(summary)); } catch {}
  for (const key of TARGET_KEYS) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,400})"`).exec(summary);
    if (!match) continue;
    try { return { target: clean(JSON.parse(`"${match[1]}"`) as string) }; } catch {}
  }
  return {};
}

/** The action a tool takes, in a few plain words: its title, else its name without the app's own prefix. */
export function toolActionPhrase(tool: string, hint: McpToolHint | undefined, app: { id?: string; label: string }, single = false): string {
  const appWords = new Set([app.id, app.label].filter((word): word is string => Boolean(word)).map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, "")));
  let words = hint?.title ? hint.title.split(/\s+/) : nameWords(tool);
  while (words.length > 1 && appWords.has(words[0]!.toLowerCase().replace(/[^a-z0-9]/g, ""))) words = words.slice(1);
  words = words.map((word, index) => (index > 0 && /^[A-Z][a-z]+$/.test(word) && !appWords.has(word.toLowerCase()) ? word.toLowerCase() : word));
  if (single && words.length === 2 && /[^s]s$/i.test(words[1]!)) words = [words[0]!, "a", words[1]!.slice(0, -1)];
  const phrase = words.join(" ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** A connected app's tool call as an approval card shows it (shared/wire.ts OptionCardData.appAction). */
export function appActionCard(tool: string, app: { id?: string; label: string; domain?: string | null }, hint: McpToolHint | undefined, facts: ToolCallFacts): { app: string; domain?: string; action: string; target?: string } {
  const action = tool === "api_request" && facts.method
    ? facts.method === "GET" ? "Read" : facts.method === "DELETE" ? "Delete something" : "Make a change"
    : toolActionPhrase(tool, hint, app, facts.single);
  return { app: app.label, ...(app.domain ? { domain: app.domain } : {}), action, ...(facts.target ? { target: facts.target } : {}) };
}
