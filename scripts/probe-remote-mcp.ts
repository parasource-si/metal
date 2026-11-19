// Live check of every vendor MCP row in server/connectors/remote-mcp.ts, with no account: sign-in starts for real
// (discovery, dynamic registration or our metadata document, an authorization address), the vendor's authorize page
// accepts it, and the open servers list tools. What a made-up token gets is shown, not judged: Intercom checks only at
// tool calls (the sign-in check tool covers that) and PayPal answers it 404.
//   node --experimental-strip-types scripts/probe-remote-mcp.ts [id ...]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REMOTE_MCP_APPS } from "../server/connectors/remote-mcp.ts";
import { McpOAuthManager } from "../server/mcp-oauth.ts";

const only = process.argv.slice(2);
const apps = REMOTE_MCP_APPS.filter((app) => !only.length || only.includes(app.id));
const dir = mkdtempSync(join(tmpdir(), "dusk-mcp-probe-"));
const manager = new McpOAuthManager({ file: join(dir, "oauth.json"), lifetimeMs: 60_000 });
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Metal", version: "1" } };
const rpc = (method: string, id: number, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

async function rpcBody(response: Response): Promise<any> {
  const text = await response.text();
  const event = /data: (.*)/u.exec(text);
  try { return JSON.parse(event ? event[1]! : text); } catch { return null; }
}

async function openTools(url: string): Promise<number | string> {
  const init = await fetch(url, { method: "POST", headers: HEADERS, body: rpc("initialize", 1, INIT), signal: AbortSignal.timeout(15_000) });
  if (!init.ok) return `initialize ${init.status}`;
  const session = init.headers.get("mcp-session-id");
  await rpcBody(init);
  const headers = { ...HEADERS, ...(session ? { "mcp-session-id": session } : {}), "mcp-protocol-version": INIT.protocolVersion };
  await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then((r) => r.body?.cancel());
  const list = await rpcBody(await fetch(url, { method: "POST", headers, body: rpc("tools/list", 2), signal: AbortSignal.timeout(15_000) }));
  return Array.isArray(list?.result?.tools) && list.result.tools.length ? list.result.tools.length : "no tools";
}

type Row = { id: string; pass: boolean; detail: string };

async function probe(app: (typeof apps)[number]): Promise<Row> {
  try {
    if (app.auth === "none") {
      const tools = await openTools(app.url!);
      return { id: app.id, pass: typeof tools === "number", detail: typeof tools === "number" ? `${tools} tools, no sign-in` : tools };
    }
    const status = await manager.start(app.id, app.url!);
    manager.cancel(app.id);
    const authorize = new URL(status.authorizationUrl!);
    const page = await fetch(authorize, { redirect: "manual", headers: { accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
    const location = page.headers.get("location") ?? "";
    await page.body?.cancel();
    const pageOk = page.status < 400 && !/[?&#]error=/u.test(location);
    const fake = await fetch(app.url!, { method: "POST", headers: { ...HEADERS, authorization: "Bearer dusk-probe-not-a-token" }, body: rpc("initialize", 1, INIT), signal: AbortSignal.timeout(15_000) });
    await fake.body?.cancel();
    const client = authorize.searchParams.get("client_id")?.startsWith("https://") ? "metadata document" : "registered";
    return { id: app.id, pass: pageOk, detail: `${client}, authorize ${page.status}${pageOk ? "" : ` ${location.slice(0, 80)}`}, fake token ${fake.status}` };
  } catch (error) {
    return { id: app.id, pass: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

const rows: Row[] = [];
for (let at = 0; at < apps.length; at += 6) rows.push(...await Promise.all(apps.slice(at, at + 6).map(probe)));
manager.dispose();
rmSync(dir, { recursive: true, force: true });
for (const row of rows) console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.id.padEnd(16)} ${row.detail}`);
console.log(`${rows.filter((row) => row.pass).length}/${rows.length} pass`);
process.exit(rows.every((row) => row.pass) ? 0 : 1);
