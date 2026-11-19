// Which config.json MCP servers each bot's turns start: every bot's and the bot's own, minus any that does not start or,
// for a URL server with no sign-in, does not answer.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import type { AppConfig } from "../config.ts";
import { launcherOf } from "../cloud-connections.ts";
import { customMcpServers } from "../config.ts";
import { readAccountChoices } from "../connector-account-choice.ts";
import type { McpServerSpec, RemoteMcpSpec, StdioMcpSpec } from "../contracts.ts";
import { addBotMcpServer, claimBotMcpServers, keepForBot, withoutBotMcpServers, type BotKept, type BotMcpServerAdd } from "../mcp-bot-servers.ts";
import { withChosenAppAccounts } from "../mcp-app-accounts.ts";
import { MCP_RESTART_ENV } from "../mcp-app-catalog.ts";
import { createMcpHealth, nameList, toolLabel, type McpHealthDeps } from "../mcp-health.ts";
import { MAX_REMOTE_MCP_BYTES, McpHttpError, McpRpcError, REMOTE_MCP_STARTUP_MS, RemoteMcpClient } from "../mcp-http.ts";
import { probeMcpServer } from "../mcp-probe.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type StoredStdioMcpServer } from "../mcp-registry.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";

type Bot = { id: string; name: string; mcpServers?: string[]; toolScope?: unknown };

export interface McpServersHostDeps {
  dataDir: string;
  cfg(): AppConfig;
  persist(next: Record<string, unknown>): void;
  bots(): readonly Bot[];
  /** The organisation's MCP policy over a bot's servers. */
  policy<T extends object>(servers: Record<string, T>): Record<string, T>;
  /** One plain line for the person about `bot`. */
  tell(text: string, bot: { id: string; name: string }): void;
  /** Whether this bot's AI starts config.json servers at all. */
  startsServers(botId: string): boolean;
  /** Whether bots' turns run boxed here, each seeing only its own folders. */
  boxed(): boolean;
  /** Whether a URL server is checked like a command server: true only when nothing but its address and saved headers
   * reach it (no sign-in, no person's own key), so a failed check means it is down, not that someone is signed out. */
  checksUrl?(name: string, server: RemoteMcpSpec): boolean;
  start?: McpHealthDeps["start"];
}

const CLAIMED_FILE = (dataDir: string) => join(dataDir, "mcp-bot-servers.json");

/** A package runner fetches its program the first time it starts, and later starts are quick: its check waits for that. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["uvx", "npx", "bunx", "pipx", "pnpm", "uv"]);
const PACKAGE_START_MS = 120_000;
export const startCheckTimeout = (command: string): number | undefined => (PACKAGE_RUNNERS.has(launcherOf(command)) ? PACKAGE_START_MS : undefined);

/** What the person hears once when servers in one bot's folder became that bot's own. */
export function claimedNotice(botName: string, names: readonly string[]): string {
  const tools = names.toSorted().map(toolLabel);
  return tools.length === 1
    ? `The ${tools[0]} tool only works for ${botName}, so it's off for your other bots.`
    : `The ${nameList(tools)} tools only work for ${botName}, so they're off for your other bots.`;
}

/** The enabled command servers this computer starts, by name, with the bot each is for. */
export function enabledCommandServers(cfg: AppConfig): Record<string, StdioMcpSpec & { bot?: string }> {
  const out: Record<string, StdioMcpSpec & { bot?: string }> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok || isRemoteMcpServer(parsed.server) || !parsed.server.enabled || parsed.server.runsOn) continue;
    const { command, args, env, bot } = parsed.server;
    out[name] = { command, args, env, ...(bot ? { bot } : {}) };
  }
  return out;
}

/** An engine keeps a command server's process across turns and starts a new one only when its spec changes (Claude Code,
 * for its warm session), so a restart has to show in the spec. Counted since this server started: its processes go with it. */
function withRestarts(servers: Record<string, McpServerSpec>, restarts: ReadonlyMap<string, number>): Record<string, McpServerSpec> {
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const count = restarts.get(name);
    return [name, count && "command" in server ? { ...server, env: { ...server.env, [MCP_RESTART_ENV]: String(count) } } : server];
  }));
}

/** The enabled URL servers turns reach directly, by name: every bot's, never another computer's. */
export function enabledUrlServers(cfg: AppConfig, checks: (name: string, server: RemoteMcpSpec) => boolean): Record<string, RemoteMcpSpec> {
  const out: Record<string, RemoteMcpSpec> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok || !isRemoteMcpServer(parsed.server) || !parsed.server.enabled || parsed.server.runsOn || parsed.server.oauth) continue;
    const { type, url, headers } = parsed.server;
    if (checks(name, { type, url, headers })) out[name] = { type, url, headers };
  }
  return out;
}

/** A URL server that answers the MCP handshake, even to refuse its keys or ask for a sign-in, is up: the proxy says why a
 * call fails. Only an address that cannot be reached, a timeout or an HTTP error leaves it out. The handshake alone, so
 * the check never lists tools on top of the app catalog's own probe. */
export async function urlServerAnswers(server: RemoteMcpSpec, timeoutMs: number = REMOTE_MCP_STARTUP_MS): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new RemoteMcpClient(server, { maxBytes: MAX_REMOTE_MCP_BYTES });
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    await client.initialize("Metal", deadline);
    return { ok: true };
  } catch (error) {
    if (error instanceof McpRpcError) return { ok: true };
    if (error instanceof McpHttpError && error.kind === "status") {
      return error.status === 401 || error.status === 403 ? { ok: true } : { ok: false, error: `The server answered HTTP ${error.status}. Check the address and headers.` };
    }
    if (deadline.aborted) return { ok: false, error: "The server did not answer in time." };
    if (error instanceof McpHttpError && error.kind === "protocol") return { ok: false, error: "The server did not answer as an MCP server." };
    return { ok: false, error: "Could not reach this address. Check the URL and your network." };
  } finally {
    await client.close().catch(() => {});
  }
}

export function createMcpServersHost(deps: McpServersHostDeps) {
  const configured = (bot: Bot): Record<string, McpServerSpec> =>
    withChosenAppAccounts(deps.policy(customMcpServers(deps.cfg(), bot.mcpServers, bot.id)), bot.id, readAccountChoices(deps.dataDir));
  /** None on an AI that starts no servers, and only those its tool selection reaches. */
  const started = (bot: Bot): string[] => (deps.startsServers(bot.id) ? Object.keys(configured(bot)).filter((name) => canUseMcpServer(bot.toolScope, name)) : []);
  const asBot = (botId: string) => {
    const own = join(deps.dataDir, "workspaces", botId);
    return { id: botId, cwd: existsSync(own) ? own : deps.dataDir };
  };
  const start: McpHealthDeps["start"] = deps.start ?? (async (_name, server, botId) => {
    if ("url" in server) return urlServerAnswers(server);
    const result = await probeMcpServer({ ...server, enabled: true }, startCheckTimeout(server.command), undefined, { asBot: asBot(botId) });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });
  const checks = createMcpHealth({
    file: join(deps.dataDir, "mcp-health.json"),
    servers: () => ({ ...(deps.checksUrl ? enabledUrlServers(deps.cfg(), deps.checksUrl) : {}), ...enabledCommandServers(deps.cfg()) }),
    users: (name) => deps.bots().filter((bot) => started(bot).includes(name)),
    start,
    tell: deps.tell,
  });
  const restarts = new Map<string, number>();
  const health = { ...checks, changed(name: string): void { restarts.set(name, (restarts.get(name) ?? 0) + 1); checks.changed(name); } };

  return {
    health,
    /** How Test starts a command server: as the turns of its bot, or of any bot. */
    probeAs: (server: { bot?: string }) => (server.bot ? asBot(server.bot) : {}),
    mounted: (bot: Bot): Record<string, McpServerSpec> => withRestarts(health.usable(bot.id, configured(bot)), restarts),
    prepare: (bot: Bot): Promise<void> => health.prepare(bot.id, started(bot)),
    off: (bot: Bot) => health.off(bot.id, started(bot)),
    listing: <T extends { name: string }>(server: T): T & { offFor?: string[] } => {
      const offFor = health.offFor(server.name);
      return offFor.length ? { ...server, offFor } : server;
    },
    botAdd: (current: Record<string, unknown>, body: unknown, botId: string): BotMcpServerAdd => addBotMcpServer(current, body, botId, deps.dataDir, deps.boxed()),
    botKeep: (server: StoredStdioMcpServer, botId: string): BotKept => keepForBot(server, botId, deps.dataDir, deps.boxed()),
    botDeleted(botId: string): void {
      const next = withoutBotMcpServers(deps.cfg().mcpServers, botId);
      if (next) deps.persist(next);
    },
    /** At start: the first time bots run boxed here, servers in one existing bot's folders become its own (said once);
     * then every server is checked. A server added after that stays as it was added. */
    boot(): void {
      if (deps.boxed() && !existsSync(CLAIMED_FILE(deps.dataDir))) {
        const bots = deps.bots();
        const claimed = claimBotMcpServers(deps.cfg().mcpServers, deps.dataDir, (botId) => bots.some((bot) => bot.id === botId));
        if (claimed) deps.persist(claimed.next);
        writeFileAtomic(CLAIMED_FILE(deps.dataDir), JSON.stringify({ claimedAt: Date.now() }), { mode: 0o600 });
        for (const [botId, names] of Object.entries(claimed?.claimed ?? {})) {
          const bot = bots.find((candidate) => candidate.id === botId);
          if (bot && bots.length > 1) deps.tell(claimedNotice(bot.name, names), bot);
        }
      }
      health.checkAll();
    },
  };
}

export type McpServersHost = ReturnType<typeof createMcpServersHost>;
