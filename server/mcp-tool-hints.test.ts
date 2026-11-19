import { describe, expect, it, vi } from "vitest";

import { autoVerdict } from "./auto-approve.ts";
import { appActionCard, McpToolHints, toolActionPhrase, toolCallFacts, toolCallFactsFromSummary } from "./mcp-tool-hints.ts";

const notion = { type: "http" as const, url: "https://mcp.notion.com/mcp", headers: {} };
const tools = [
  { name: "notion-search", annotations: { title: "Search Notion", readOnlyHint: true } },
  { name: "notion-fetch", annotations: { readOnlyHint: true } },
  { name: "notion-create-pages", annotations: { title: "Create pages", readOnlyHint: false } },
  { name: "notion-delete-pages", annotations: { readOnlyHint: true, destructiveHint: true } },
  // a server that calls a write read-only is not believed
  { name: "notion-update-page", annotations: { readOnlyHint: true } },
  { name: "notion-send-message", annotations: { readOnlyHint: true } },
];

function hints() {
  const list = vi.fn(async () => tools);
  return { list, hints: new McpToolHints({ list }) };
}

describe("McpToolHints", () => {
  it("lets a tool the server marks read-only skip the ask, and keeps asking for writes, deletes and sends", async () => {
    const { hints: h } = hints();
    await h.warm("notion", notion);
    const reads = (tool: string) => h.readsOnly({ server: "notion", tool, spec: notion });
    expect(reads("notion-search")).toBe(true);
    expect(reads("notion-fetch")).toBe(true);
    expect(reads("notion-create-pages")).toBe(false);
    expect(reads("notion-delete-pages")).toBe(false);
    expect(reads("notion-update-page")).toBe(false);
    expect(reads("notion-send-message")).toBe(false);
    expect(reads("notion-unknown")).toBe(false);
  });

  it("asks while it doesn't know a server's tools, and forgets them when the server's address changes", async () => {
    const { hints: h, list } = hints();
    expect(h.readsOnly({ server: "notion", tool: "notion-search", spec: notion })).toBe(false);
    await Promise.all([h.warm("notion", notion), h.warm("notion", notion)]);
    expect(list).toHaveBeenCalledTimes(1);
    // a refreshed token in the headers is the same server
    expect(h.readsOnly({ server: "notion", tool: "notion-search", spec: { ...notion, headers: { Authorization: "Bearer new" } } })).toBe(true);
    expect(h.readsOnly({ server: "notion", tool: "notion-search", spec: { ...notion, url: "https://evil.example/mcp" } })).toBe(false);
  });

  it("waits a while before listing again after a failed list", async () => {
    let now = 0;
    const list = vi.fn(async () => { throw new Error("down"); });
    const h = new McpToolHints({ list, now: () => now });
    await h.warm("notion", notion);
    await h.warm("notion", notion);
    expect(list).toHaveBeenCalledTimes(1);
    now += 3 * 60_000;
    await h.warm("notion", notion);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("reads Metal's own api_request by its method, and its own app servers by their known reads", () => {
    const h = new McpToolHints({ list: async () => [] });
    const api = { type: "http" as const, url: "http://127.0.0.1:1/api/app-tokens/mcp/0123456789abcdef", headers: {} };
    expect(h.readsOnly({ server: "stripe", tool: "api_request", spec: api, apiServer: true, facts: { method: "GET" } })).toBe(true);
    expect(h.readsOnly({ server: "stripe", tool: "api_request", spec: api, apiServer: true, facts: { method: "POST" } })).toBe(false);
    expect(h.readsOnly({ server: "stripe", tool: "api_request", spec: api, apiServer: true })).toBe(false);
    expect(h.readsOnly({ server: "composio", tool: "GMAIL_FETCH_EMAILS", spec: {} })).toBe(true);
    expect(h.readsOnly({ server: "composio", tool: "GMAIL_SEND_EMAIL", spec: {} })).toBe(false);
  });
});

describe("autoVerdict read-only", () => {
  it("answers a read in ask, edits and auto, never in custom, and never over the outbound guard", () => {
    for (const mode of ["ask", "edits", "auto"] as const) {
      expect(autoVerdict(mode, "mcp__notion__notion-search", { readOnly: true })).toEqual({ approve: "approved mcp__notion__notion-search (reads only)", source: "read-only" });
    }
    expect(autoVerdict("custom", "mcp__notion__notion-search", { readOnly: true }).approve).toBeNull();
    expect(autoVerdict("ask", "mcp__notion__notion-search").approve).toBeNull();
    expect(autoVerdict("ask", "mcp__gmail__send_email", { readOnly: true }).source).toBe("outbound-guard");
  });
});

describe("approval card words", () => {
  it("names the thing a call works on", () => {
    expect(toolCallFacts({ parent: { page_id: "x" }, pages: [{ properties: { title: "Launch checklist" }, content: "# Steps" }] }))
      .toEqual({ target: "Launch checklist", single: true });
    expect(toolCallFacts({ title: "Fix login", teamId: "t" })).toEqual({ target: "Fix login" });
    expect(toolCallFacts({ tasks: [{ content: "Buy milk" }, { content: "Call mum" }] })).toEqual({ target: "Buy milk" });
    expect(toolCallFacts({ method: "get", path: "/v1/customers" })).toEqual({ method: "GET", target: "/v1/customers" });
    expect(toolCallFacts({ id: "abc" })).toEqual({});
    expect(toolCallFacts({ title: "x".repeat(200) }).target).toHaveLength(80);
  });

  it("reads a target from a cut-short summary", () => {
    expect(toolCallFactsFromSummary('{"pages":[{"properties":{"title":"Launch checklist"},"content":"long')).toEqual({ target: "Launch checklist" });
    expect(toolCallFactsFromSummary("not json")).toEqual({});
  });

  it("says the action in plain words, without the app's prefix", () => {
    const app = { id: "notion", label: "Notion" };
    expect(toolActionPhrase("notion-create-pages", undefined, app)).toBe("Create pages");
    expect(toolActionPhrase("notion-create-pages", undefined, app, true)).toBe("Create a page");
    expect(toolActionPhrase("notion-create-pages", { title: "Create Pages", readOnly: false, destructive: false }, app, true)).toBe("Create a page");
    expect(toolActionPhrase("create_issue", undefined, { id: "linear", label: "Linear" })).toBe("Create issue");
    expect(toolActionPhrase("x", { title: "Search Notion", readOnly: true, destructive: false }, app)).toBe("Search Notion");
  });

  it("builds the card's words", () => {
    expect(appActionCard("notion-create-pages", { id: "notion", label: "Notion", domain: "notion.so" }, undefined, { target: "Launch checklist", single: true }))
      .toEqual({ app: "Notion", domain: "notion.so", action: "Create a page", target: "Launch checklist" });
    expect(appActionCard("api_request", { label: "Stripe" }, undefined, { method: "POST", target: "/v1/refunds" }))
      .toEqual({ app: "Stripe", action: "Make a change", target: "/v1/refunds" });
  });
});
