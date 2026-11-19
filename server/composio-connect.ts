// Composio Connect: Composio's own MCP server for people (docs.composio.dev, "Composio Connect"). It signs in with OAuth
// 2.1, dynamic client registration and PKCE, which server/mcp-oauth.ts already runs for any MCP server, so connecting
// apps needs no Composio key. The person adds it as an MCP server and signs in on Composio's page; then its
// COMPOSIO_MANAGE_CONNECTIONS tool checks one app's connection and, when there is none, starts it and returns the
// sign-in link (docs.composio.dev/toolkits/meta-tools/manage_connections).
import { McpHttpError, RemoteMcpClient, MAX_REMOTE_MCP_BYTES } from "./mcp-http.ts";
import { parseStoredMcpServer, type StoredRemoteMcpServer } from "./mcp-registry.ts";
import type { RemoteMcpSpec } from "./contracts.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

export const COMPOSIO_CONNECT_URL = "https://connect.composio.dev/mcp";
const MANAGE_TOOL = "COMPOSIO_MANAGE_CONNECTIONS";
const CALL_MS = 30_000;

/** Composio Connect, when the person has added it: any server at its address, whatever they named it. */
export function composioConnectServer(servers: Record<string, unknown> | undefined): { name: string; server: StoredRemoteMcpServer } | null {
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok || !("url" in parsed.server)) continue;
    try {
      if (new URL(parsed.server.url).host === new URL(COMPOSIO_CONNECT_URL).host) return { name, server: parsed.server };
    } catch { /* not a url */ }
  }
  return null;
}

export type AppConnection =
  | { status: "connected" }
  | { status: "started"; url: string }
  /** a sign-in link is out and not finished yet */
  | { status: "waiting" }
  | { status: "none" }
  | { status: "failed"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parsedText(result: unknown): unknown {
  if (!isRecord(result)) return null;
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("\n")
    : "";
  try { return JSON.parse(text); } catch { return text; }
}

const LINK = /https:\/\/[^\s"')\]]+/;

/** The tool's own answer for one toolkit: `data.results[slug]`, matched without case. */
function toolkitResult(answer: unknown, slug: string): { data: Record<string, unknown>; mine: Record<string, unknown>; found: boolean } {
  const data = isRecord(answer) && isRecord(answer.data) ? answer.data : isRecord(answer) ? answer : {};
  const results = isRecord(data.results) ? data.results : {};
  const key = Object.keys(results).find((name) => name.toLowerCase() === slug.toLowerCase());
  const mine = key && isRecord(results[key]) ? results[key] as Record<string, unknown> : {};
  return { data, mine, found: key !== undefined };
}

function refusalOf(result: unknown, answer: unknown, data: Record<string, unknown>, mine: Record<string, unknown>): string | null {
  const isError = isRecord(result) && result.isError === true;
  const unsuccessful = isRecord(answer) && answer.successful === false;
  if (!isError && !unsuccessful) return null;
  const said = [mine.message, isRecord(answer) ? answer.error : null, data.message].find((value): value is string => typeof value === "string" && value.trim() !== "");
  return (said ?? "Composio refused.").slice(0, 300);
}

const accountsOf = (mine: Record<string, unknown>) => Array.isArray(mine.accounts) ? mine.accounts.filter(isRecord) : [];
const statusOf = (value: unknown) => String(value ?? "").toLowerCase();

/** What `action: "list"` says about one app (read against the live tool on 2026-11-07): `data.results[slug].accounts`,
 * each with its own `status` ("active", "initiated", "initializing", ...). The toolkit's own `status` is not enough:
 * it reads "initiated" for a toolkit with no accounts at all, even a made-up one. */
export function readAppAccounts(result: unknown, slug: string): AppConnection {
  const answer = parsedText(result);
  if (typeof answer === "string") return { status: "failed", message: answer.slice(0, 300) || "Composio did not answer." };
  const { data, mine } = toolkitResult(answer, slug);
  const refused = refusalOf(result, answer, data, mine);
  if (refused) return { status: "failed", message: refused };
  const accounts = accountsOf(mine);
  if (accounts.some((account) => statusOf(account.status) === "active")) return { status: "connected" };
  if (accounts.some((account) => /^(initiated|initializing|pending)$/.test(statusOf(account.status)))) return { status: "waiting" };
  return { status: "none" };
}

/** What `action: "add"` says about one app: it always makes a new sign-in link (`redirect_url`), even when an account
 * is active already, so it is only asked once `list` found none. */
export function readAppConnection(result: unknown, slug: string): AppConnection {
  const answer = parsedText(result);
  const isError = isRecord(result) && result.isError === true;
  if (typeof answer === "string") {
    const link = LINK.exec(answer)?.[0];
    if (link && !isError) return { status: "started", url: link };
    return { status: "failed", message: answer.slice(0, 300) || "Composio did not answer." };
  }
  const { data, mine, found } = toolkitResult(answer, slug);
  const refused = refusalOf(result, answer, data, mine);
  if (refused) return { status: "failed", message: refused };
  const url = [mine.redirect_url, mine.redirectUrl, mine.auth_url, mine.url].find((value): value is string => typeof value === "string" && value.startsWith("https://"))
    ?? LINK.exec(JSON.stringify(found ? mine : ""))?.[0];
  if (url) return { status: "started", url };
  if (/^(active|connected)$/.test(statusOf(mine.status)) || mine.has_active_connection === true) return { status: "connected" };
  const said = typeof mine.message === "string" ? mine.message : typeof data.message === "string" ? data.message : "";
  return { status: "failed", message: said.slice(0, 300) || `Composio did not say how to connect ${slug}.` };
}

type ManageAction = "list" | "add";
const call = (client: RemoteMcpClient, slug: string, action: ManageAction, signal: AbortSignal) =>
  client.request("tools/call", { name: MANAGE_TOOL, arguments: { toolkits: [{ name: slug, action }] } }, signal);

/** Asks Composio Connect about one app. `"list"` only reads; `"add"` reads first and starts a sign-in link only when the
 * app has no active account, since each add makes a new pending account on Composio's side. */
export async function manageAppConnection(spec: RemoteMcpSpec, slug: string, signal?: AbortSignal, action: ManageAction = "add"): Promise<AppConnection> {
  const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]) : AbortSignal.timeout(CALL_MS);
  const client = new RemoteMcpClient(spec, { maxBytes: MAX_REMOTE_MCP_BYTES });
  try {
    await client.initialize("Metal", bound);
    const now = readAppAccounts(await call(client, slug, "list", bound), slug);
    if (action === "list" || now.status === "connected" || now.status === "failed") return now;
    return readAppConnection(await call(client, slug, "add", bound), slug);
  } finally {
    await client.close().catch(() => {});
  }
}

/** A failed call, as the person can act on it: signed out of Composio (authorize again), Composio unreachable, or Composio's own error. */
export function composioCallFailure(error: unknown): { status: number; body: { error: string; code: string } } {
  const status = error instanceof McpHttpError ? error.status : undefined;
  if (status === 401 || status === 403) return { status: 409, body: { error: "Composio sign-in expired. Authorize Composio again.", code: "composio_connect_signed_out" } };
  if (error instanceof McpHttpError && error.kind === "network") return { status: 502, body: { error: "Couldn't reach Composio.", code: "composio_unreachable" } };
  return { status: 502, body: { error: error instanceof Error ? error.message : String(error), code: "composio_failed" } };
}

const APP = /^\/api\/connectors\/composio-connect\/apps\/([a-z0-9_][a-z0-9_-]{0,63})$/;

/** GET /api/connectors/composio-connect: is it added and signed in. GET …/apps/<slug>: is that app connected through it
 * (reads only). POST …/apps/<slug>: connect that app through it. */
export function createComposioConnectRoutes(deps: {
  servers: () => Record<string, unknown> | undefined;
  signedIn: (name: string, server: StoredRemoteMcpServer) => boolean;
  /** The server with its OAuth token on, or null when the sign-in is gone. */
  withToken: (name: string, server: StoredRemoteMcpServer) => Promise<RemoteMcpSpec | null>;
  refusal: (slug: string) => string | null;
  manage?: typeof manageAppConnection;
  /** reads where Composio Connect signs in ahead of the press, so its page opens sooner */
  warm?: (url: string) => void;
  /** each app's answer, so the workspace report can list the apps connected here */
  noted?: (slug: string, status: AppConnection["status"]) => void;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path === "/api/connectors/composio-connect" && method === "GET") {
      const found = composioConnectServer(deps.servers());
      const signedIn = found ? deps.signedIn(found.name, found.server) : false;
      // the apps page asks this when it opens: a person not signed in yet is likely to press Connect next
      if (!signedIn) deps.warm?.(found?.server.url ?? COMPOSIO_CONNECT_URL);
      return json(res, 200, { added: Boolean(found), name: found?.name ?? null, signedIn, enabled: found?.server.enabled ?? false });
    }
    const m = APP.exec(path);
    if (!m || (method !== "POST" && method !== "GET")) return PASS;
    const refused = deps.refusal(m[1]!);
    if (refused) return json(res, 403, { error: refused, code: "managed_policy" });
    const found = composioConnectServer(deps.servers());
    if (!found) return json(res, 409, { error: "Authorize Composio first.", code: "composio_connect_missing" });
    const spec = deps.signedIn(found.name, found.server) ? await deps.withToken(found.name, found.server) : null;
    if (!spec) return json(res, 409, { error: "Composio sign-in expired. Authorize Composio again.", code: "composio_connect_signed_out" });
    try {
      const answer = await (deps.manage ?? manageAppConnection)(spec, m[1]!, undefined, method === "GET" ? "list" : "add");
      try { deps.noted?.(m[1]!, answer.status); } catch {}
      return json(res, 200, answer);
    } catch (error) {
      const failure = composioCallFailure(error);
      return json(res, failure.status, failure.body);
    }
  };
}
