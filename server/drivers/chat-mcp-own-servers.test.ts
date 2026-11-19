import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { ChatToolSessionError, mountChatTools, ownServerAnswer, type ChatToolSession } from "./chat-mcp-tools.ts";

const spawned = vi.hoisted(() => [] as string[][]);
vi.mock("../procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../procs.ts")>();
  return {
    ...actual,
    spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
      spawned.push(args[1] ?? []);
      return actual.spawnCli(...args);
    },
  };
});

type Seen = { url: string; authorization?: string; body: string; closed: boolean };
const cleanups: Array<() => Promise<void>> = [];
const sessions: ChatToolSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  spawned.length = 0;
});

async function harness(answer: (request: IncomingMessage, body: string, response: ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const entry: Seen = { url: request.url ?? "", authorization: request.headers.authorization, body, closed: false };
      response.on("close", () => { entry.closed = !response.writableEnded; });
      seen.push(entry);
      answer(request, body, response, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

const json = (response: ServerResponse, body: unknown) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};

const agentsServer = (url: string) => ({
  command: process.execPath, args: [SPAWNED_PROXIES.agents],
  env: { DUSK_HARNESS_URL: url, DUSK_BOT_ID: "bot-a", DUSK_THREAD_ID: "thread-a", DUSK_COMMS_TOKEN: "turn-token", DUSK_TURN_DEPTH: "0" },
});

async function mount(integrations: Parameters<typeof mountChatTools>[0], computerUse = false) {
  const session = await mountChatTools(integrations, new AbortController().signal, computerUse);
  sessions.push(session);
  return session;
}

describe("Metal's own servers on the chat runtime", () => {
  it("answers the agents server in this process with the turn's token, starting no child", async () => {
    const stub = await harness((_request, _body, response) => json(response, { bots: [{ id: "b2", name: "Quill", model: "fake" }] }));
    const session = await mount({ agents: agentsServer(stub.url) });
    expect(spawned).toEqual([]);
    expect(session.definitions.some((tool) => tool.function.name === "agents_list_bots")).toBe(true);
    const result = await session.execute("agents_list_bots", {}, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining("Quill") });
    expect(stub.seen.map((entry) => entry.authorization)).toEqual(["Bearer turn-token", "Bearer turn-token"]);
    expect(stub.seen.map((entry) => entry.url.split("?")[0])).toEqual(["/api/internal/agents", "/api/internal/tool-timing"]);
  });

  it("answers a harness server in this process through its own endpoint and token", async () => {
    const stub = await harness((_request, body, response) => {
      const { method } = JSON.parse(body) as { method: string };
      json(response, method === "tools/list"
        ? { result: { tools: [{ name: "query", description: "Run a read", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } }
        : { result: { content: [{ type: "text", text: "3 rows" }] } });
    });
    const data = { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "data"], env: { DUSK_HARNESS_URL: stub.url, [harnessMcpTokenEnv("data")]: "data-token" } };
    const session = await mount({ data });
    expect(spawned).toEqual([]);
    expect(session.parallel("data_query", {})).toBe(true);
    expect(await session.execute("data_query", {}, new AbortController().signal)).toMatchObject({ ok: true, text: "3 rows" });
    expect(stub.seen.every((entry) => entry.url === "/api/internal/data/mcp" && entry.authorization === "Bearer data-token")).toBe(true);
  });

  it("ends a call still running at the harness when the session closes, as ending the proxy did", async () => {
    let release: (() => void) | undefined;
    const stub = await harness((request, _body, response) => {
      if (request.url?.startsWith("/api/internal/agents")) release = () => json(response, { bots: [] });
      else json(response, {});
    });
    const session = await mount({ agents: agentsServer(stub.url) });
    const pending = session.execute("agents_list_bots", {}, new AbortController().signal);
    await vi.waitFor(() => expect(release).toBeDefined());
    await session.close();
    await expect(pending).rejects.toBeInstanceOf(ChatToolSessionError);
    await vi.waitFor(() => expect(stub.seen[0]!.closed).toBe(true));
    expect(() => session.validate("agents_list_bots", {})).toThrow(ChatToolSessionError);
  });

  it("times a call out without waiting on the harness", async () => {
    const stub = await harness(() => {});
    const session = await mountChatTools({ agents: agentsServer(stub.url) }, new AbortController().signal, false, undefined, 50);
    sessions.push(session);
    await expect(session.execute("agents_list_bots", {}, new AbortController().signal)).rejects.toThrow(/timed out/);
  });

  it("still starts a child for a configured server, a non-loopback harness or a server without its token", () => {
    expect(ownServerAnswer(agentsServer("http://127.0.0.1:9"))).toBeTypeOf("function");
    expect(ownServerAnswer({ ...agentsServer("http://10.0.0.2:9") })).toBeUndefined();
    expect(ownServerAnswer({ ...agentsServer("http://127.0.0.1:9"), command: "/usr/bin/node" })).toBeUndefined();
    expect(ownServerAnswer({ command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "data"], env: { DUSK_HARNESS_URL: "http://127.0.0.1:9" } })).toBeUndefined();
    expect(ownServerAnswer({ command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "nope"], env: { DUSK_HARNESS_URL: "http://127.0.0.1:9", DUSK_DATA_MCP_TOKEN: "x" } })).toBeUndefined();
  });

  it("spawns a configured entry that names the agents proxy", async () => {
    const stub = await harness((_request, _body, response) => json(response, {}));
    await mount({ custom: { mine: agentsServer(stub.url) } });
    expect(spawned).toEqual([[SPAWNED_PROXIES.agents]]);
  });
});

describe("tool search scheduling", () => {
  it("lets catalog searches and calls of read-only tools overlap, and keeps other calls ordered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-chat-directory-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const tools = Array.from({ length: 130 }, (_, index) => ({ name: `tool_${index}`, description: `Fixture tool ${index}`,
      inputSchema: { type: "object", properties: {} }, ...(index % 2 ? {} : { annotations: { readOnlyHint: true } }) }));
    writeFileSync(join(dir, "tools.json"), JSON.stringify(tools));
    const fake = { command: process.execPath, args: [join(import.meta.dirname, "../testing/fake-mcp-server.ts")], env: { FAKE_MCP_TOOLS_FILE: join(dir, "tools.json") } };
    const session = await mount({ custom: { big: fake } });
    expect(session.definitions.map((tool) => tool.function.name)).toEqual(["mcp_search_tools", "mcp_describe_tool", "mcp_call_tool"]);
    expect(session.parallel("mcp_search_tools", { query: "fixture" })).toBe(true);
    expect(session.parallel("mcp_describe_tool", { name: "big_tool_0" })).toBe(true);
    expect(session.parallel("mcp_call_tool", { name: "big_tool_0", arguments: {} })).toBe(true);
    expect(session.parallel("mcp_call_tool", { name: "big_tool_1", arguments: {} })).toBe(false);
    expect(session.parallel("mcp_call_tool", { name: "missing", arguments: {} })).toBe(false);
    expect(session.view("mcp_call_tool", { name: "big_tool_0", arguments: {} })).toMatchObject({ ask: true });
  });
});
