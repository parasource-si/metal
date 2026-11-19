// Metal's browser tools as a stdio MCP server over the real BrowserService and a headless Chrome, so an engine CLI
// plays a benchmark task through the same code a bot uses. Every call is appended to BENCH_LOG.
// Run: DUSK_CDP_E2E=1 node --experimental-strip-types server/browser-bench/mcp-browser.ts
import "./stdout-guard.ts";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { startService, type RealService } from "../browser/testing/real-service.ts";
import { TOOL_LIST } from "../browser/tools.ts";

const log = process.env.BENCH_LOG;
const target = { session: "bench", key: "bot:bench" };
let real: Promise<RealService> | null = null;
const service = () => (real ??= startService());

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });

async function toolCall(id: unknown, name: string, args: Record<string, unknown>): Promise<void> {
  const started = Date.now();
  let result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
  try {
    result = await (await service()).call(target, name, args);
  } catch (error) {
    result = { content: [{ type: "text", text: `bench: the call threw ${(error as Error).message}` }], isError: true };
  }
  const text = result.content.map((part) => part.text ?? `[${part.type}]`).join("\n");
  if (log) appendFileSync(log, `${JSON.stringify({ at: started, ms: Date.now() - started, name, args, isError: result.isError === true, chars: text.length, images: result.content.filter((part) => part.type === "image").length, text: text.slice(0, 4_000) })}\n`);
  reply(id, result);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "browser", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: TOOL_LIST });
  else if (message.method === "tools/call") void toolCall(message.id, String(message.params?.name ?? ""), message.params?.arguments ?? {});
  else reply(message.id, {});
}).on("close", async () => {
  if (real) await (await real).close().catch(() => undefined);
  process.exit(0);
});
