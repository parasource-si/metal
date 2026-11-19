// Per-turn MCP transport for the Chat Completions runtime: approval is the caller's, and only
// registered, schema-validated calls arrive here.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { stripControlPlaneEnv } from "../config.ts";
import type { SendTurnInput } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import { MESSAGE_FILE_MAX_BYTES } from "../message-file.ts";
import { augmentedPath } from "../env-path.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { AGENTS_TOOL_ALIASES } from "../../shared/agents-tool-names.ts";
import { bridgedCallTarget, unbridgedServer } from "./agents-bridge.ts";
import { chatImage, type ChatImagePart } from "./chat-images.ts";
import { CALL_TOOL, DESCRIBE_TOOL, SEARCH_TOOL, ToolDirectory, catalogExceedsSize, directoryCallTarget, isDirectoryTool, type CatalogTool, type DirectoryResult } from "../mcp-directory.ts";
import { AppObserver, modelVisible, withUiExtension } from "../mcp-app-observer.ts";
import { appMountFor, mcpStdioServer } from "../mcp-gate-config.ts";
import { REMOTE_MCP_STARTUP_MS, remoteMcpSpec } from "../mcp-http.ts";
import { compileServerToolSchema, schemaProblems } from "../mcp-schema-validator.ts";
import { argumentOutline, repairToolArguments } from "../tool-argument-repair.ts";
import { fitToolList } from "../mcp-tool-schema.ts";
import { listsComputerTool } from "../computer-tool-list.ts";
import { capToolList, shareToolBudget, toolLimitFromEnv } from "../tool-count-limit.ts";
import { harnessMcpRequest, parseHarnessMcpKind } from "../harness-mcp-request.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { agentsMcp } from "./agents-mcp.ts";
import type { Json } from "./agents-client.ts";
import type { ToolSchemaProfile } from "../tool-schema-profile.ts";
import { allowsTool, canUseMcpServer, parseToolScope, type ToolScope } from "../../shared/tool-scope.ts";
import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";
import { CHAT_TOOL_LIMIT, type ToolBudget } from "../../shared/tool-budget.ts";

export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ChatToolResult { text: string; ok: boolean; images?: ChatImagePart[] }
/** How a call is shown and granted. A grant names the exact tool on the server as launched; the
 * person's own computer never gets a session-wide one. */
export interface ChatToolCallView { title: string; input: Record<string, unknown>; ask: boolean; grant?: string }
/** A dispatched operation may already have taken effect: never retry it through a new round. */
export class ChatToolSessionError extends Error {}
export interface SkippedChatMcpServer { server: string; reason: string }
/** A built-in server that listed only its first `listed` of `of` tools, so the turn fits the model's tool limit. */
export interface TrimmedChatMcpServer { server: string; listed: number; of: number }
export interface ChatToolSession {
  definitions: ChatToolDefinition[];
  skipped: SkippedChatMcpServer[];
  trimmed: TrimmedChatMcpServer[];
  budget: ToolBudget;
  validate(name: string, args: unknown): void;
  /** Directory reads and Metal's own agents server need no card; call_tool shows the tool it runs. */
  view(name: string, args: Record<string, unknown>): ChatToolCallView;
  /** Scheduling only: explicitly read-only calls may overlap. This never changes approval or scope checks. */
  parallel(name: string, args: Record<string, unknown>): boolean;
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatToolResult>;
  close(): Promise<void>;
}

type Server = { command: string; args: string[]; env: Record<string, string> };
type RegisteredTool = { client: McpPeer; server: string; launch: string; builtInBrowser: boolean; agents: boolean; computer: boolean; hostComputer: boolean; name: string; schema: ValidateFunction; searched: boolean; parallel: boolean };
function chatToolName(server: string, tool: string): string {
  return `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "mcp_tool";
}
const STARTUP_MS = 8_000;
const DEFAULT_CALL_MS = 10 * 60_000;
const FRAME_BYTES = 2 * 1024 * 1024;
const OUTPUT_BYTES = 50 * 1024;
const TOOL_COUNT = CHAT_TOOL_LIMIT;
/** ask_user, which the runtime lists after the MCP tools. */
const RUNTIME_TOOLS = 1;
const MCP_TOOL_COUNT = TOOL_COUNT - RUNTIME_TOOLS;
/** Past the limit a server is searched, not listed, so this only bounds what one server may offer. */
const SERVER_TOOLS_MAX = 2_000;
const DIRECTORY_SERVER = "mcp";
const DIRECTORY_TOOL_COUNT = 3;
const MAX_PAGES = 100;
const SCHEMA_BYTES = 64 * 1024;
const CATALOG_BYTES = 1024 * 1024;
const MAX_FRAMES = 10_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function aborted(): Error { return new Error("MCP operation cancelled"); }
class McpRequestRefused extends Error {}

/** A chat-runtime bot's tools never get the operator's control-plane secrets; the entry's own env is applied last. */
export function chatMcpEnvironment(serverEnv: Record<string, string>, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath() };
  stripControlPlaneEnv(env);
  return { ...env, ...serverEnv };
}

/** One mounted MCP server, as the turn talks to it. */
abstract class McpPeer {
  abstract call(method: string, params: unknown, signal: AbortSignal, timeout: number, keepOnRefusal?: boolean): Promise<unknown>;
  protected abstract notify(method: string): void;
  abstract close(): Promise<void>;

  async tools(signal: AbortSignal, include: (tool: unknown) => boolean = () => true, startupMs = STARTUP_MS, observer?: AppObserver): Promise<unknown[]> {
    const deadline = Date.now() + startupMs;
    const remaining = () => {
      if (Date.now() >= deadline) throw new Error("MCP startup timed out");
      return deadline - Date.now();
    };
    const handshake = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "duskbot-chat", version: "1" } };
    let initialized: unknown;
    if (observer?.mount.extension) {
      try { initialized = await this.call("initialize", withUiExtension(handshake), signal, remaining(), true); }
      catch (error) {
        if (!(error instanceof McpRequestRefused)) throw error;
        initialized = await this.call("initialize", handshake, signal, remaining());
      }
    } else {
      initialized = await this.call("initialize", handshake, signal, remaining());
    }
    if (!object(initialized)) throw new Error("MCP initialization returned an invalid result");
    observer?.initialized(initialized);
    if (signal.aborted) throw aborted();
    this.notify("notifications/initialized");
    const tools: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.call("tools/list", cursor ? { cursor } : {}, signal, remaining());
      if (!object(result) || !Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid result");
      observer?.listed(result);
      tools.push(...result.tools.filter((tool) => modelVisible(tool) && include(tool)));
      if (tools.length > SERVER_TOOLS_MAX) throw new Error(`MCP server offers more than ${SERVER_TOOLS_MAX} tools`);
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("MCP tools/list returned an invalid pagination cursor");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("MCP tools/list exceeded the pagination limit");
  }
}

export class ChatMcpClient extends McpPeer {
  private readonly frameBytes: number;
  private child: ReturnType<typeof spawnCli>;
  private buffer = "";
  private nextId = 1;
  private frames = 0;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  /** `configured`: a server the person set up, whose own environment passes the bot box as theirs. */
  constructor(server: Server, computerUse = false, configured = false) {
    super();
    this.frameBytes = frameLimit(computerUse);
    try {
      // The desktop shell inherits Finder's bare PATH, where `npx`-style servers cannot find `node`.
      this.child = spawnCli(server.command, server.args, {
        stdio: ["pipe", "pipe", "pipe"], env: chatMcpEnvironment(server.env),
        ...(configured ? { box: { allowEnv: Object.keys(server.env) } } : {}),
      }, "bot");
    } catch { throw new Error("MCP server could not start; check its command and installation"); }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Stderr may contain credentials; drain without recording or returning it.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.fail(new Error("MCP server could not start; check its command and installation")));
    this.child.on("exit", () => this.fail(new Error("MCP server exited before the session closed")));
    this.child.stdin.on("error", () => this.fail(new Error("MCP server input closed")));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    void this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Read before the pending rejections below: only a call still in flight at entry is genuinely uncertain.
    const inFlight = this.pending.size > 0;
    for (const entry of this.pending.values()) entry.reject(new Error("MCP session closed"));
    this.pending.clear();
    this.buffer = "";
    // Windows reaps the tree via taskkill /T, which can exceed shorter budgets on a loaded machine;
    // elsewhere the budget is the TERM grace before KILL, not a verdict race, so it stays short.
    this.closing = killCliTree(this.child, process.platform === "win32" ? 15_000 : 5_000).then((stopped) => {
      if (stopped) return;
      if (!inFlight) {
        console.warn("chat-mcp: shutdown could not be confirmed within its budget; no call was in flight, so the turn outcome is unaffected");
        return;
      }
      throw new Error("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
    });
    return this.closing;
  }

  private write(frame: unknown): void {
    if (this.closed || !this.child.stdin.writable || this.child.stdin.destroyed) throw new Error("MCP session closed");
    const encoded = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(encoded) > this.frameBytes) throw new Error("MCP request exceeds the frame limit");
    this.child.stdin.write(encoded);
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (++this.frames > MAX_FRAMES) return this.fail(new Error("MCP session exceeded the response frame count limit"));
      if (Buffer.byteLength(line) > this.frameBytes) return this.fail(new Error("MCP response exceeds the frame limit"));
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); }
      catch { return this.fail(new Error("MCP server returned invalid JSON")); }
      if (!object(message) || message.jsonrpc !== "2.0") return this.fail(new Error("MCP server returned an invalid RPC envelope"));
      if (typeof message.method === "string") {
        if (typeof message.id === "number" || typeof message.id === "string") {
          try { this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client method not supported" } }); }
          catch { return this.fail(new Error("MCP server input closed")); }
        }
        continue;
      }
      if (typeof message.id !== "number") return this.fail(new Error("MCP server returned an invalid response ID"));
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      if ("error" in message) entry.reject(new McpRequestRefused("MCP request failed; inspect the configured integration"));
      else if (!("result" in message)) entry.reject(new Error("MCP response has no result"));
      else entry.resolve(message.result);
    }
    if (Buffer.byteLength(this.buffer) > this.frameBytes) this.fail(new Error("MCP response exceeds the frame limit"));
  }

  async call(method: string, params: unknown, signal: AbortSignal, timeout: number, keepOnRefusal = false): Promise<unknown> {
    if (signal.aborted) { await this.close(); throw aborted(); }
    if (this.closed) throw new Error("MCP session closed");
    const id = this.nextId++;
    try {
      return await new Promise((resolve, reject) => {
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          this.pending.delete(id);
          if (error) reject(error); else resolve(value);
        };
        const cancel = () => {
          try { this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled" } }); }
          catch {}
          finish(aborted());
        };
        const timer = setTimeout(() => finish(new Error("MCP request timed out; execution outcome may be uncertain")), timeout);
        timer.unref();
        signal.addEventListener("abort", cancel, { once: true });
        this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
        try { this.write({ jsonrpc: "2.0", id, method, params }); }
        catch { finish(new Error("MCP request could not be sent")); }
      });
    } catch (error) {
      if (!(keepOnRefusal && error instanceof McpRequestRefused)) await this.close();
      throw error;
    }
  }

  protected notify(method: string): void {
    this.write({ jsonrpc: "2.0", method });
  }
}

type Answer = (frame: Record<string, unknown>) => Promise<unknown>;

/** Metal's own agents or harness server for a built-in mount, answered in this process by the code its stdio proxy
 * runs, with the environment that proxy would get; the endpoints behind it check the turn's token as they do the proxy's.
 * `stop` ends the harness requests still in flight, as ending the proxy's process does. */
export function ownServerAnswer(server: Server): ((stop: AbortSignal) => Answer) | undefined {
  if (server.command !== process.execPath) return undefined;
  const env = chatMcpEnvironment(server.env);
  const harness = env.DUSK_HARNESS_URL;
  if (!harness || !/^http:\/\/127\.0\.0\.1:\d+$/.test(harness)) return undefined;
  if (server.args.length === 1 && server.args[0] === SPAWNED_PROXIES.agents) {
    if (!env.DUSK_COMMS_TOKEN) return undefined;
    return (stop) => {
      const answer = agentsMcp(env, stop);
      return (frame) => answer(frame as Json);
    };
  }
  const kind = server.args.length === 2 && server.args[0] === SPAWNED_PROXIES.harnessMcp ? parseHarnessMcpKind(server.args[1]) : undefined;
  const token = kind ? env[harnessMcpTokenEnv(kind)] : undefined;
  if (!kind || !token) return undefined;
  const connection = { url: harness, token, kind, toolLimit: toolLimitFromEnv(env) };
  return (stop) => (frame) => harnessMcpRequest(frame, { ...connection, stop });
}

/** A built-in server answered in this process: no child to start, and the same envelope, size and timeout checks. */
export class InProcessMcpClient extends McpPeer {
  private readonly stop = new AbortController();
  private readonly answer: Answer;
  private readonly frameBytes: number;
  private nextId = 1;
  private closed = false;

  constructor(answer: (stop: AbortSignal) => Answer, frameBytes: number) {
    super();
    this.answer = answer(this.stop.signal);
    this.frameBytes = frameBytes;
  }

  close(): Promise<void> {
    this.closed = true;
    this.stop.abort();
    return Promise.resolve();
  }

  protected notify(method: string): void {
    if (!this.closed) void this.answer({ jsonrpc: "2.0", method }).catch(() => {});
  }

  async call(method: string, params: unknown, signal: AbortSignal, timeout: number, keepOnRefusal = false): Promise<unknown> {
    if (signal.aborted) { await this.close(); throw aborted(); }
    if (this.closed) throw new Error("MCP session closed");
    const id = this.nextId++;
    try {
      const reply = await new Promise<unknown>((resolve, reject) => {
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          this.stop.signal.removeEventListener("abort", closed);
          if (error) reject(error); else resolve(value);
        };
        const cancel = () => finish(aborted());
        const closed = () => finish(new Error("MCP session closed"));
        const timer = setTimeout(() => finish(new Error("MCP request timed out; execution outcome may be uncertain")), timeout);
        timer.unref();
        signal.addEventListener("abort", cancel, { once: true });
        this.stop.signal.addEventListener("abort", closed, { once: true });
        this.answer({ jsonrpc: "2.0", id, method, params }).then((value) => finish(undefined, value),
          () => finish(new Error("MCP server failed; execution outcome may be uncertain")));
      });
      if (!object(reply) || reply.jsonrpc !== "2.0" || reply.id !== id) throw new Error("MCP server returned an invalid RPC envelope");
      if (Buffer.byteLength(JSON.stringify(reply)) > this.frameBytes) throw new Error("MCP response exceeds the frame limit");
      if ("error" in reply) throw new McpRequestRefused("MCP request failed; inspect the configured integration");
      if (!("result" in reply)) throw new Error("MCP response has no result");
      return reply.result;
    } catch (error) {
      if (!(keepOnRefusal && error instanceof McpRequestRefused)) await this.close();
      throw error;
    }
  }
}

function frameLimit(computerUse: boolean): number {
  return computerUse ? 32 * 1024 * 1024 : FRAME_BYTES;
}

/** A built-in mount of Metal's own server is answered in this process; anything else runs as its own child. */
function openPeer(server: Server, computerUse: boolean, builtIn: boolean): McpPeer {
  const own = builtIn ? ownServerAnswer(server) : undefined;
  if (own) return new InProcessMcpClient(own, frameLimit(computerUse));
  return new ChatMcpClient(server, computerUse, !builtIn);
}

export function trimmedToolsNotice(trimmed: readonly TrimmedChatMcpServer[]): string | undefined {
  if (!trimmed.length) return undefined;
  const names = trimmed.map(({ server }) => server);
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Left out some of ${listed} this time to fit the model's limit.`;
}

/** What the person hears about a turn's MCP servers before the model runs, one line each. */
export function chatToolNotices(session: Pick<ChatToolSession, "skipped" | "trimmed">): string[] {
  return [
    // the reason stays in the log; searched servers still work, so they say nothing
    ...session.skipped.map(({ server }) => `Couldn't connect ${server} this time, so the bot went on without it.`),
    trimmedToolsNotice(session.trimmed),
  ].filter((line): line is string => line !== undefined);
}

function preview(bytes: Buffer): string {
  let end = OUTPUT_BYTES;
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString();
}

function boundedText(value: string, bytes = Buffer.from(value)): string {
  if (bytes.length <= OUTPUT_BYTES) return value;
  return `${preview(bytes)}\n[MCP result truncated at 50KB; request less output.]`;
}

/** Folder, inside the bot's working folder, that keeps tool results too big to show the model whole. */
export const SAVED_RESULTS_FOLDER = "mcp-results";
/** Only the newest saved results are kept, so repeated big results cannot fill the disk. */
export const SAVED_RESULTS_KEPT = 20;
const SAVED_RESULT_NAME = /^result-.+-(\d+)-[0-9a-f]{6}\.txt$/;

/** The file just written (`keep`) is never removed, even if the clock went back. */
async function pruneSavedResults(dir: string, keep: string): Promise<void> {
  const saved = (await readdir(dir)).flatMap((name) => {
    const match = name === keep ? null : SAVED_RESULT_NAME.exec(name);
    return match ? [{ name, at: Number(match[1]) }] : [];
  }).sort((a, b) => b.at - a.at);
  await Promise.all(saved.slice(SAVED_RESULTS_KEPT - 1).map(({ name }) => unlink(join(dir, name))));
}

/** A result over the limit is kept whole (secrets masked by `scrub`) in `folder`/mcp-results and the model reads its start and the file's path.
 * Without a folder, when the file cannot be written, or when it is over the attach limit, it is cut as before. */
async function savedOrBounded(value: string, tool: string, folder: string | undefined, scrub: (text: string) => string): Promise<string> {
  const bytes = Buffer.from(value);
  if (bytes.length <= OUTPUT_BYTES || !folder) return boundedText(value, bytes);
  try {
    const dir = join(folder, SAVED_RESULTS_FOLDER);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Security: never follow a link the folder's contents put here to write outside the working folder.
    if (!(await lstat(dir)).isDirectory()) throw new Error("not a folder");
    const name = `result-${tool}-${Date.now()}-${randomBytes(3).toString("hex")}.txt`, file = join(dir, name);
    // Key-shaped values are masked before the result reaches disk, as for every other kept tool result.
    const kept = scrub(value);
    // A file over the attach limit could not be attached, so it is cut as before.
    if (Buffer.byteLength(kept) > MESSAGE_FILE_MAX_BYTES) return boundedText(value, bytes);
    await writeFile(file, kept, { flag: "wx", mode: 0o600 });
    await pruneSavedResults(dir, name).catch(() => {});
    const kb = Math.ceil(bytes.length / 1024), masked = kept === value ? "" : " (secret-looking values in it are masked)";
    return `${preview(bytes)}\n[MCP result is ${kb}KB; only the first 50KB is shown above. The full result is saved in ${file}${masked}]`;
  } catch {
    return boundedText(value, bytes);
  }
}

/** Smaller models fill optional fields with "" instead of omitting them; for these a blank means omitted. */
const BUILT_IN_BROWSER_BLANK_MEANS_OMITTED: Record<string, readonly string[]> = {
  agent_browser_read: ["url"],
};

function omitBlankDefaults(builtInBrowser: boolean, tool: string, args: unknown) {
  if (!builtInBrowser || !object(args)) return;
  for (const field of BUILT_IN_BROWSER_BLANK_MEANS_OMITTED[tool] ?? []) {
    const value = args[field];
    if (typeof value === "string" && !value.trim()) delete args[field];
  }
}

type CheckedTool = { tool: Record<string, unknown> & { name: string; inputSchema: Record<string, unknown> }; schema: ValidateFunction };
type ToolOrigin = Omit<RegisteredTool, "name" | "schema" | "parallel">;
const parallelRead = (origin: ToolOrigin, tool: Record<string, unknown>): boolean =>
  !origin.builtInBrowser && !origin.computer && object(tool.annotations)
  && tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint !== true;
const ARGUMENTS_MISFIT = "Tool arguments do not match the advertised input schema; use its required fields and types";

/** Holds `args` to the tool's schema. A call that misses only by a meaning-keeping shape is repaired in place and runs;
 * any other misfit is refused with what is wrong and what the tool takes. */
function fitArguments(schema: ValidateFunction, args: Record<string, unknown>): void {
  if (schema(args)) return;
  const problems = schemaProblems(schema.errors, 4);
  const repaired = repairToolArguments(schema.schema, args);
  if (repaired?.repairs.length && schema(repaired.args)) {
    for (const key of Object.keys(args)) delete args[key];
    Object.assign(args, repaired.args);
    return;
  }
  const outline = argumentOutline(schema.schema);
  throw new Error(`${ARGUMENTS_MISFIT}. Nothing ran. ${problems.length ? `Wrong: ${problems.join("; ")}. ` : ""}${outline ? `${outline} ` : ""}Fix the arguments and call it again.`);
}

function checkedTools(tools: readonly unknown[]): CheckedTool[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (!object(tool) || typeof tool.name !== "string" || !tool.name.trim() || names.has(tool.name)) throw new Error("MCP server advertised an invalid or duplicate tool name");
    names.add(tool.name);
    if (!object(tool.inputSchema) || tool.inputSchema.type !== "object") throw new Error("MCP tools require an object input schema");
    if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > SCHEMA_BYTES) throw new Error("MCP tool schema exceeds the 64KB limit");
    return { tool: tool as CheckedTool["tool"], schema: compileServerToolSchema(tool.inputSchema) };
  });
}

function uniqueName(base: string, taken: (name: string) => boolean): string {
  let name = base;
  for (let index = 2; taken(name); index += 1) { const suffix = `_${index}`; name = base.slice(0, 64 - suffix.length) + suffix; }
  return name;
}

/** The configured servers a turn lists whole within `room` tools, in turn order. When not all fit, the tool search's own
 * tools take their place in the room first, and the rest are reached through it. */
export function directServers(servers: ReadonlyArray<{ name: string; tools: number; searchOnly?: boolean }>, room: number): Set<string> {
  if (!servers.some(server => server.searchOnly) && servers.reduce((sum, server) => sum + server.tools, 0) <= room) return new Set(servers.map((server) => server.name));
  let left = room - DIRECTORY_TOOL_COUNT;
  const direct = new Set<string>();
  for (const server of servers) {
    if (server.searchOnly || server.tools > left) continue;
    direct.add(server.name);
    left -= server.tools;
  }
  return direct;
}

/** Under `schemaProfile` the model reads each tool's schema fitted to its provider; calls are still checked against the full one.
 * A tool result over 50KB is saved whole in `resultFolder`, the bot's working folder, after `scrub` masks secrets (see savedOrBounded). */
export async function mountChatTools(integrations: SendTurnInput["integrations"], signal: AbortSignal, computerUse = false, toolScope?: ToolScope, callTimeoutMs: number = DEFAULT_CALL_MS,
  schemaProfile?: ToolSchemaProfile, resultFolder?: string, scrub: (text: string) => string = redactSecretsInText): Promise<ChatToolSession> {
  const parsed = parseToolScope(toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const scope = parsed.scope;
  const servers: Array<[string, Server]> = [];
  const observers = new Map<string, AppObserver>();
  const searchable = new Set<string>();
  const eligible = (server: string) => scope === undefined || canUseMcpServer(scope, server);
  if (computerUse && integrations?.localComputer && eligible("computer")) servers.push(["computer", integrations.localComputer]);
  if (computerUse && integrations?.browser && eligible("browser")) servers.push(["browser", integrations.browser]);
  // Security: a selection matches the name in the call, so with one the agents server is never bridged.
  const agentsServer = integrations?.agents && scope !== undefined ? unbridgedServer(integrations.agents) : integrations?.agents;
  if (agentsServer && eligible("agents")) servers.push(["agents", agentsServer]);
  if (integrations?.composio && eligible("composio")) servers.push(["composio", integrations.composio]);
  if (integrations?.composioOwn && eligible(OWN_APPS_SERVER)) servers.push([OWN_APPS_SERVER, integrations.composioOwn]);
  if (integrations?.data && eligible("data")) servers.push(["data", integrations.data]);
  if (integrations?.email && eligible("email")) servers.push(["email", integrations.email]);
  if (integrations?.device && eligible("device")) servers.push(["device", integrations.device]);
  const builtIns = servers.length;
  const besideBrowser = servers.some(([, descriptor]) => descriptor === integrations?.browser);
  for (const [name, server] of Object.entries(integrations?.custom ?? {})) {
    if (!eligible(name)) continue;
    const remote = remoteMcpSpec(server) !== undefined;
    const apps = appMountFor(name, { integrations });
    if (apps && !remote) observers.set(name, new AppObserver(apps));
    const stdio = mcpStdioServer(server, { nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, ...(remote ? { directory: { name, ...(scope ? { toolScope: scope } : {}) } } : {}), ...(apps && remote ? { apps } : {}) });
    if (!stdio) throw new Error("MCP server configuration is invalid");
    if (remote) searchable.add(name);
    servers.push([name, { command: stdio.command, args: stdio.args ?? [], env: stdio.env ?? {} }]);
  }
  if (servers.length > 32) throw new Error("MCP server count exceeds the 32-server limit");
  const clients: McpPeer[] = [];
  const skipped: SkippedChatMcpServer[] = [];
  const trimmed: TrimmedChatMcpServer[] = [];
  const started = new Map<string, McpPeer>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener("abort", cancel);
    closing = Promise.allSettled(clients.map((client) => client.close())).then((results) => {
      if (results.some((result) => result.status === "rejected")) throw new ChatToolSessionError("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
    });
    return closing;
  };
  const cancel = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const definitions: ChatToolDefinition[] = [];
  const registered = new Map<string, RegisteredTool>();
  const catalog = new Map<string, RegisteredTool>();
  const directoryNames = new Map<string, string>();
  let directory: ToolDirectory | undefined;
  const budget: ToolBudget = { limit: TOOL_COUNT, listed: 0, servers: [] };
  const register = (origin: ToolOrigin, tools: readonly CheckedTool[]) => {
    const staged: Array<{ tool: RegisteredTool; definition: ChatToolDefinition }> = [];
    for (const { tool, schema } of tools) {
      const [listed] = schemaProfile ? fitToolList([tool], schemaProfile, (line) => console.warn(`chat-mcp: ${origin.server}: ${line}`)) : [tool];
      if (!object(listed) || !object(listed.inputSchema)) continue;
      const parameters = { ...listed.inputSchema };
      const constraints: Record<string, unknown> = {};
      if (computerUse) {
        for (const key of ["anyOf", "oneOf", "allOf", "not"]) {
          if (key in parameters) { constraints[key] = parameters[key]; delete parameters[key]; }
        }
      }
      const description = (typeof listed.description === "string" ? listed.description : "Configured MCP tool") +
        (Object.keys(constraints).length ? " Additional argument constraints (validated before execution): " + JSON.stringify(constraints) : "");
      const name = uniqueName(chatToolName(origin.server, tool.name), (candidate) => registered.has(candidate) || staged.some((entry) => entry.definition.function.name === candidate));
      staged.push({ tool: { ...origin, name: tool.name, schema, parallel: parallelRead(origin, tool) }, definition: { type: "function", function: { name, description, parameters } } });
    }
    if (Buffer.byteLength(JSON.stringify([...definitions, ...staged.map((entry) => entry.definition)])) > CATALOG_BYTES) throw new Error("MCP tool catalog exceeds the 1MB limit");
    for (const { tool, definition } of staged) {
      registered.set(definition.function.name, tool);
      definitions.push(definition);
    }
    // Unlisted, so a call by an alias in an earlier tool call reaches the agents server, which runs it as its action
    // tool; the server holds it to that tool's full schema.
    if (origin.agents) {
      for (const [alias, { tools: targets }] of Object.entries(AGENTS_TOOL_ALIASES)) {
        const listed = staged.find((entry) => targets.includes(entry.tool.name));
        const name = chatToolName(origin.server, alias);
        if (listed && !registered.has(name)) registered.set(name, { ...listed.tool, name: alias, parallel: false, schema: compileServerToolSchema({ type: "object" }) });
      }
    }
  };
  try {
    if (signal.aborted) throw aborted();
    // Concurrent starts, consumed in config order so names and collision suffixes stay stable.
    const mounts = await Promise.allSettled(servers.map(async ([name, descriptor], index) => {
      if (signal.aborted || closed) throw aborted();
      const client = openPeer(descriptor, computerUse, index < builtIns);
      clients.push(client);
      started.set(name, client);
      const computer = descriptor === integrations?.localComputer;
      const keeps = (tool: unknown) => !computer || !object(tool) || typeof tool.name !== "string" || listsComputerTool(tool.name, besideBrowser);
      const include = (tool: unknown) => keeps(tool) && (scope === undefined || (object(tool) && typeof tool.name === "string"
        && ((searchable.has(name) && isDirectoryTool(tool.name)) || allowsTool(scope, { kind: "mcp", server: name, name: tool.name }))));
      const tools = await client.tools(signal, include, searchable.has(name) ? REMOTE_MCP_STARTUP_MS : STARTUP_MS, observers.get(name));
      if (!tools.length && scope === undefined && descriptor === integrations?.localComputer) throw new Error("The Local VM listed no tools");
      // Harness mounts are known by descriptor, never by a name a configured server could claim. A grant
      // hashes the descriptor (no credential kept); machine bridges mint a bearer per turn, so theirs last a turn.
      const launch = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
      const origin: ToolOrigin = { client, server: name, launch, builtInBrowser: descriptor === integrations?.browser, agents: descriptor === agentsServer,
        computer: descriptor === integrations?.localComputer,
        hostComputer: descriptor === integrations?.localComputer && integrations?.localComputer?.scope === "local-computer", searched: searchable.has(name) };
      return { origin, tools };
    }));
    const skip = async (server: string, error: unknown) => {
      const reason = error instanceof Error ? error.message : "MCP server failed to start";
      skipped.push({ server, reason });
      console.warn(`chat-mcp: skipping MCP server "${server}" for this turn: ${reason}`);
      await started.get(server)?.close();
    };
    const offered: Array<{ origin: ToolOrigin; tools: unknown[] }> = [];
    const configured: Array<{ origin: ToolOrigin; tools: CheckedTool[] }> = [];
    for (const [index, mount] of mounts.entries()) {
      if (signal.aborted || closed) throw aborted();
      if (index < builtIns) {
        if (mount.status === "rejected") throw mount.reason;
        offered.push(mount.value);
        continue;
      }
      if (mount.status === "rejected") { await skip(servers[index]![0], mount.reason); continue; }
      try { configured.push({ origin: mount.value.origin, tools: checkedTools(mount.value.tools) }); }
      catch (error) { await skip(mount.value.origin.server, error); }
    }
    const wanted = [...offered, ...configured].reduce((sum, server) => sum + server.tools.length, 0);
    const configuredCatalogs = configured.map(({ origin, tools }) => ({ name: origin.server, tools: tools.length,
      searchOnly: catalogExceedsSize(tools.map(({ tool }) => tool)) }));
    const searchRoom = configured.some((server) => server.tools.length) && (wanted > MCP_TOOL_COUNT || configuredCatalogs.some(server => server.searchOnly)) ? DIRECTORY_TOOL_COUNT : 0;
    // The agents server keeps its whole list first; configured servers fit in what the built-ins leave.
    const shares = shareToolBudget(offered.map(({ origin, tools }, index) => ({ name: String(index), tools: tools.length, agents: origin.agents }))
      .sort((a, b) => Number(b.agents) - Number(a.agents)), MCP_TOOL_COUNT - searchRoom);
    for (const [index, { origin, tools: listed }] of offered.entries()) {
      const tools = capToolList(listed, shares.get(String(index)));
      if (tools.length < listed.length) {
        trimmed.push({ server: origin.server, listed: tools.length, of: listed.length });
        console.warn(`chat-mcp: "${origin.server}" listed ${tools.length} of ${listed.length} tools to fit the model's ${TOOL_COUNT}-tool limit`);
      }
      register(origin, checkedTools(tools));
    }
    const direct = directServers(configuredCatalogs, MCP_TOOL_COUNT - definitions.length);
    const searched: typeof configured = [];
    for (const server of configured) {
      if (signal.aborted || closed) throw aborted();
      if (!direct.has(server.origin.server)) searched.push(server);
      else {
        try { register(server.origin, server.tools); }
        catch (error) { await skip(server.origin.server, error); continue; }
      }
      budget.servers.push({ name: server.origin.server, tools: server.tools.length, direct: direct.has(server.origin.server) });
    }
    if (searched.length) {
      const entries: CatalogTool[] = [];
      for (const { origin, tools } of searched) {
        for (const { tool, schema } of tools) {
          const name = uniqueName(chatToolName(origin.server, tool.name), (candidate) => catalog.has(candidate));
          catalog.set(name, { ...origin, name: tool.name, schema, parallel: parallelRead(origin, tool) });
          entries.push({ ...tool, name });
        }
      }
      directory = new ToolDirectory(entries, { check: (tool, args) => {
        const validate = catalog.get(tool.name)!.schema;
        return validate(args) ? undefined : schemaProblems(validate.errors);
      } });
      for (const tool of directory.listed({ server: DIRECTORY_SERVER, servers: searched.map(({ origin }) => origin.server) })) {
        const name = uniqueName(chatToolName(DIRECTORY_SERVER, tool.name as string), (candidate) => registered.has(candidate) || directoryNames.has(candidate));
        directoryNames.set(name, tool.name as string);
        definitions.push({ type: "function", function: { name, description: tool.description as string, parameters: tool.inputSchema as Record<string, unknown> } });
      }
    }
    budget.listed = definitions.length;
    if (signal.aborted || closed) throw aborted();
  } catch (error) { await close(); throw error; }
  const target = (tool: { name: string; searched: boolean }, args: unknown) => tool.searched ? directoryCallTarget(tool.name, args) : tool.name;
  const excludes = (server: string, runs: string | undefined, runArgs: unknown) => scope !== undefined && runs !== undefined
    && !allowsTool(scope, { kind: "mcp", server, name: runs }, runArgs);
  const selectionExcludes = (tool: RegisteredTool, args: unknown) => {
    const inner = object(args) ? args.arguments ?? {} : {};
    // A directory mistake ran nothing and must not end the turn as a failed call.
    const directoryTool = tool.searched && isDirectoryTool(tool.name);
    // Security: should a bridged agents server answer here, use_tool is also judged by the tool it names.
    if (!directoryTool && (excludes(tool.server, tool.name, args ?? {}) || (tool.agents && excludes(tool.server, bridgedCallTarget(tool.name, args), inner)))) return true;
    return tool.searched && excludes(tool.server, target(tool, args), inner);
  };
  const searchedCall = (args: unknown) => {
    const call = directory && object(args) ? directory.call(args) : undefined;
    return call && !("answer" in call) ? { tool: catalog.get(call.name)!, args: call.arguments } : undefined;
  };
  const validate = (name: string, args: unknown) => {
    if (closed || signal.aborted) throw new ChatToolSessionError("MCP session closed");
    const listedAs = directoryNames.get(name);
    if (listedAs) {
      const call = listedAs === CALL_TOOL ? searchedCall(args) : undefined;
      if (call && selectionExcludes(call.tool, call.args)) throw new Error("Tool selection excludes this tool");
      if (!object(args)) throw new Error(ARGUMENTS_MISFIT);
      return;
    }
    const tool = registered.get(name);
    if (!tool) throw new Error("The requested tool was not advertised for this turn");
    if (selectionExcludes(tool, args)) throw new Error("Tool selection excludes this tool");
    omitBlankDefaults(tool.builtInBrowser, tool.name, args);
    if (!object(args)) throw new Error(ARGUMENTS_MISFIT);
    if (!(tool.searched && isDirectoryTool(tool.name))) fitArguments(tool.schema, args);
  };
  const viewOf = (tool: RegisteredTool, args: Record<string, unknown>, title: string): ChatToolCallView => {
    const runs = target(tool, args);
    if (runs === undefined || tool.agents) return { title, input: args, ask: false };
    const grant = !tool.hostComputer ? JSON.stringify([tool.server, tool.launch, runs]) : undefined;
    if (!tool.searched || tool.name !== CALL_TOOL) return { title, input: args, ask: true, ...(grant ? { grant } : {}) };
    return { title: chatToolName(tool.server, runs), input: object(args.arguments) ? args.arguments : {}, ask: true, ...(grant ? { grant } : {}) };
  };
  const view = (name: string, args: Record<string, unknown>): ChatToolCallView => {
    if (directoryNames.has(name)) {
      const call = directoryNames.get(name) === CALL_TOOL ? searchedCall(args) : undefined;
      return call ? viewOf(call.tool, call.args, chatToolName(call.tool.server, call.tool.name)) : { title: name, input: args, ask: false };
    }
    const tool = registered.get(name);
    return tool ? viewOf(tool, args, name) : { title: name, input: args, ask: true };
  };
  const run = async (tool: RegisteredTool, args: Record<string, unknown>, callSignal: AbortSignal): Promise<ChatToolResult> => {
    try {
      const result = await tool.client.call("tools/call", { name: tool.name, arguments: args }, AbortSignal.any([signal, callSignal]), callTimeoutMs);
      if (signal.aborted || callSignal.aborted) throw aborted();
      if (!object(result) || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new Error("MCP tool returned an invalid result; execution outcome may be uncertain");
      observers.get(tool.server)?.returned({ name: tool.name, arguments: args }, result);
      const parts: string[] = [];
      const images: ChatImagePart[] = [];
      let unsupported = 0;
      for (const item of result.content) {
        if (!object(item) || typeof item.type !== "string" || (item.type === "text" && typeof item.text !== "string")) throw new Error("MCP tool returned invalid content; execution outcome may be uncertain");
        if (item.type === "text") parts.push(item.text as string);
        else if (computerUse && item.type === "image") images.push(chatImage(item));
        else unsupported += 1;
      }
      if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
      if (unsupported) parts.unshift(`[${unsupported} unsupported MCP content item(s) omitted. The operation may have taken effect, but its full result cannot be represented; inspect its state before retrying.]`);
      return { text: await savedOrBounded(parts.join("\n") || (images.length ? "Screenshot captured." : "(empty result)"), chatToolName(tool.server, tool.name), resultFolder, scrub), ok: result.isError !== true && unsupported === 0,
        ...(images.length ? { images } : {}) };
    } catch (error) {
      await close();
      throw new ChatToolSessionError(error instanceof Error ? error.message : "MCP transport failed; execution outcome may be uncertain");
    }
  };
  const answer = (result: DirectoryResult): ChatToolResult => ({ text: boundedText(result.content.map((part) => part.text).join("\n")), ok: result.isError !== true });
  return {
    definitions, skipped, trimmed, budget, validate, view, close,
    parallel(name, args) {
      const listedAs = directoryNames.get(name);
      // Search and describe only read the catalog in memory; a call is as parallel as the tool it runs.
      if (listedAs && listedAs !== CALL_TOOL) return true;
      if (listedAs) {
        const call = searchedCall(args);
        return call?.tool.parallel === true && !selectionExcludes(call.tool, call.args);
      }
      const tool = registered.get(name);
      return tool?.parallel === true && !selectionExcludes(tool, args);
    },
    async execute(name, args, callSignal) {
      validate(name, args);
      if (callSignal.aborted) { await close(); throw aborted(); }
      const listedAs = directoryNames.get(name);
      if (!listedAs) return run(registered.get(name)!, args, callSignal);
      if (listedAs === SEARCH_TOOL) return answer(await directory!.search(args));
      if (listedAs === DESCRIBE_TOOL) return answer(directory!.describe(args));
      const call = directory!.call(args);
      return "answer" in call ? answer(call.answer) : run(catalog.get(call.name)!, call.arguments, callSignal);
    },
  };
}
