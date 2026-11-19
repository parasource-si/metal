import type { StdioMcpSpec } from "../contracts.ts";
import { tomlInlineTable } from "./codex-process.ts";
import { parseVersionTriple, versionAtLeast, type VersionTriple } from "./acp/version-probe.ts";
import { ownMcpOverHttp } from "./turn-mcp.ts";
import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";

/** Codex's default for one MCP server's tools (openai/codex#17843): "auto"
 * runs without asking only tools the server marks read-only, "approve" runs
 * every tool without asking, "prompt" asks for each call. */
export type McpApprovalMode = "approve" | "auto" | "prompt";

export function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpSpec,
  approval: McpApprovalMode = "auto",
  /** Written into the mount's own `env` table: its process gets them, Codex's command shell does not. */
  literalEnv: Record<string, string> = {},
  written: Set<string> = new Set(),
  /** The built-in this mount is, when it may go over HTTP; set only on a Codex that takes the endpoint. */
  ownServer?: string,
): void {
  const endpoint = ownServer && OWN_SERVERS.has(ownServer) ? ownMcpOverHttp({ name: ownServer, ...server }) : null;
  if (endpoint) return mountOwnMcpOverHttp(appServerArgs, env, name, endpoint, approval, written);
  const prefix = `mcp_servers.${name}`;
  Object.assign(env, server.env);
  for (const name of Object.keys(server.env)) written.add(name);
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // argv carries names only, so credentials never appear in process listings.
    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
  );
  if (Object.keys(literalEnv).length) appServerArgs.push("-c", `${prefix}.env=${tomlInlineTable(literalEnv)}`);
  if (approval !== "prompt") appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="${approval}"`);
}

/** The built-in mounts that may be Metal's own proxies; a person's server of the same shape stays a process. */
const OWN_SERVERS = new Set(["agents", "browser", "data", "email", "device"]);

/** The env family holding own-server endpoint tokens and headers; it never reaches Codex's command shell. */
export const OWN_MCP_ENV_FAMILY = "DUSK_OWN_MCP_";
/** The oldest codex-cli this mount was checked against: 0.167.0 lists and calls the agents endpoint, with
 * bearer_token_env_var and env_http_headers, and holds a 75-second call open. */
export const OWN_MCP_HTTP_MIN_CODEX: VersionTriple = [0, 167, 0];

export function codexMountsOwnMcpOverHttp(version: string | null): boolean {
  const parsed = version === null ? null : parseVersionTriple(version);
  return parsed !== null && versionAtLeast(parsed, OWN_MCP_HTTP_MIN_CODEX);
}

/** Metal's own server as an endpoint of this server, so Codex starts no proxy process for it. The token and
 * every header ride environment variables: argv carries names only. */
export function mountOwnMcpOverHttp(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  endpoint: { url: string; headers: Record<string, string> },
  approval: McpApprovalMode,
  written: Set<string>,
): void {
  const token = /^Bearer (\S+)$/.exec(endpoint.headers.authorization ?? "")?.[1];
  if (!token) throw new Error("own MCP endpoint has no bearer token");
  const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const tokenEnv = `${OWN_MCP_ENV_FAMILY}TOKEN_${key}`;
  env[tokenEnv] = token;
  written.add(tokenEnv);
  const headers: Record<string, string> = {};
  Object.entries(endpoint.headers).filter(([header]) => header.toLowerCase() !== "authorization").forEach(([header, value], index) => {
    const variable = `${OWN_MCP_ENV_FAMILY}HEADER_${key}_${index}`;
    env[variable] = value;
    written.add(variable);
    headers[header] = variable;
  });
  const prefix = `mcp_servers.${name}`;
  appServerArgs.push("-c", `${prefix}.url=${JSON.stringify(endpoint.url)}`, "-c", `${prefix}.bearer_token_env_var=${JSON.stringify(tokenEnv)}`);
  if (Object.keys(headers).length) appServerArgs.push("-c", `${prefix}.env_http_headers=${tomlInlineTable(headers)}`);
  if (approval !== "prompt") appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="${approval}"`);
}

/** Built-in servers whose calls are independent requests, so one model step's calls to them may run at once. The
 * computer and the browser drive one screen and a person's own server is unknown: those stay one call at a time. */
const PARALLEL_SERVERS = new Set(["agents", "data", "email", "device", "composio", OWN_APPS_SERVER]);
/** codex-cli 0.167.0 runs one server's calls one after another unless `supports_parallel_tool_calls` is set. */
export const PARALLEL_MCP_MIN_CODEX: VersionTriple = [0, 167, 0];

export function codexParallelMcpArgs(name: string, mountName: string, version: string | null): string[] {
  const parsed = version === null ? null : parseVersionTriple(version);
  if (!PARALLEL_SERVERS.has(name) || parsed === null || !versionAtLeast(parsed, PARALLEL_MCP_MIN_CODEX)) return [];
  return ["-c", `mcp_servers.${mountName}.supports_parallel_tool_calls=true`];
}
