import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserRuntime, type BrowserSpawnSpec } from "../browser-runtime.ts";
import { planAgentBrowserBatch } from "./agent-browser-batch.ts";

const selector = { type: "string", description: "Element @ref from snapshot, or a CSS selector." };
/** agent-browser 0.37.0's schemas for the tools these tests use, as Metal lists them. */
const TOOLS = [
  { name: "agent_browser_open", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "agent_browser_click", inputSchema: { type: "object", properties: { newTab: { type: "boolean", default: false }, selector }, required: ["selector"] } },
  { name: "agent_browser_fill", inputSchema: { type: "object", properties: { selector, text: { type: "string" } }, required: ["selector", "text"] } },
  { name: "agent_browser_press", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "agent_browser_snapshot", inputSchema: { type: "object", properties: { compact: { type: "boolean" }, selector: { type: "string" } } } },
  { name: "agent_browser_read", inputSchema: { type: "object", properties: { filter: { type: "string" } } } },
  { name: "agent_browser_screenshot", inputSchema: { type: "object", properties: { fullPage: { type: "boolean" } } } },
  { name: "agent_browser_eval", inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] } },
];

// PROBES: a file of page probes, one per settle read, the last repeated. HOLD: a file whose presence makes a fill wait.
const FAKE = String.raw`
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const log = (entry) => fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(entry) + '\n');
let probes = 0;
const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
lines.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'initialize') return answer(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  if (m.method === 'tools/list') return answer(m.id, { tools: JSON.parse(process.env.TOOLS) });
  const { name, arguments: args = {} } = m.params;
  const text = (value) => ({ content: [{ type: 'text', text: value }] });
  if (name === 'agent_browser_eval' && String(args.script).includes('getBoundingClientRect')) {
    log({ name: 'probe' });
    const list = process.env.PROBES ? JSON.parse(fs.readFileSync(process.env.PROBES, 'utf8')) : [];
    const probe = list[Math.min(probes++, list.length - 1)];
    return answer(m.id, probe ? text(JSON.stringify(JSON.stringify(probe))) : { isError: true, content: [] });
  }
  log({ name, args });
  if (name === 'agent_browser_eval') return answer(m.id, text(JSON.stringify(JSON.stringify({ url: 'http://fixture.test/', title: 'Fixture', text: 'Ready' }))));
  if (name === 'agent_browser_click' && args.selector === '#missing') return answer(m.id, { isError: true, content: [{ type: 'text', text: 'Element not found: #missing' }] });
  if (name === 'agent_browser_fill' && process.env.HOLD && fs.existsSync(process.env.HOLD)) {
    const wait = () => fs.existsSync(process.env.HOLD) ? setTimeout(wait, 10) : answer(m.id, text('filled ' + args.selector));
    return wait();
  }
  if (name === 'agent_browser_snapshot') return answer(m.id, text('- button "Pay" [ref=e1]'));
  if (name === 'agent_browser_screenshot') return answer(m.id, { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
  return answer(m.id, text(name.replace('agent_browser_', '') + ' ' + JSON.stringify(args)));
});
`;

const page = (over: Record<string, unknown> = {}) => ({ title: "Shop", text: "Welcome", textLength: 2_500, nodes: 120, controls: 14, busy: false, scripts: [], iframes: [], selectors: [], ...over });

const dirs: string[] = [];
const runtimes: BrowserRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeAll()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function engine(probes?: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "dusk-ab-batch-"));
  dirs.push(dir);
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const spec: BrowserSpawnSpec = { command: process.execPath, args: ["-e", FAKE], env: { PATH: process.env.PATH, CALL_LOG: log, TOOLS: JSON.stringify(TOOLS), HOLD: join(dir, "hold") } };
  if (probes) { spec.env.PROBES = join(dir, "probes"); writeFileSync(spec.env.PROBES, JSON.stringify(probes)); }
  const runtime = new BrowserRuntime({ requestTimeoutMs: 5_000, takeoverTimeoutMs: 2_000, idleMs: 5_000 });
  runtimes.push(runtime);
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { name: string; args?: Record<string, unknown> });
  const call = (name: string, args: Record<string, unknown> = {}) => runtime.agentRpc("s", spec, "tools/call", { name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
  return { runtime, spec, calls, call, hold: join(dir, "hold") };
}

const texts = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.type === "text" ? part.text : `[${part.type}]`);

describe("a batch on the agent-browser engine", () => {
  it("is checked step by step against the engine's own schemas before anything runs", () => {
    const tools = { tools: TOOLS };
    expect(planAgentBrowserBatch({ steps: [{ do: "open", url: "example.com" }, { do: "fill", selector: "#q", text: "hi" }] }, tools)).toMatchObject({ ok: true, limitMs: 60_000 });
    for (const [steps, error] of [
      [[{ do: "open" }, { do: "fill", selector: "#q" }], /step 2 fill got arguments it cannot use \(text:/],
      [[{ do: "click", selector: "#a", session: "other-bot" }], /step 1 click got arguments it cannot use/],
      [[{ do: "read", url: "http://127.0.0.1:8799/api/config" }], /step 1 read got arguments it cannot use/],
      [[{ do: "eval", script: "1" }], /got arguments it cannot use \(steps\.0\.do/],
      [[{ do: "upload", selector: "#f", files: ["/etc/passwd"] }], /steps\.0\.do/],
      [[{ do: "tab_close" }], /steps\.0\.do/],
      [[{ do: "hover", selector: "#menu" }], /step 1 hover is not a tool this browser offers/],
      [Array.from({ length: 4 }, () => ({ do: "screenshot" })), /3 pictures at most, and these steps take 4/],
    ] as const) {
      const plan = planAgentBrowserBatch({ steps }, tools);
      expect(plan.ok, JSON.stringify(steps)).toBe(false);
      expect(!plan.ok && plan.error, JSON.stringify(steps)).toMatch(error);
    }
    expect(planAgentBrowserBatch({ steps: [] }, tools).ok).toBe(false);
  });

  it("is listed with the engine's tools", async () => {
    const { runtime, spec } = engine();
    const listed = await runtime.agentRpc("s", spec, "tools/list", {}) as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
    const batch = listed.tools.find((tool) => tool.name === "agent_browser_batch");
    expect(Object.keys(batch?.inputSchema.properties ?? {})).toEqual(["steps", "timeoutMs"]);
  });

  it("runs a form in one call, each step through the single-call path, and refuses a bad batch whole", async () => {
    const { call, calls } = engine();
    const refused = await call("agent_browser_batch", { steps: [{ do: "fill", selector: "#q", text: "hi" }, { do: "click" }] });
    expect(refused.isError).toBe(true);
    expect(texts(refused)[0]).toMatch(/^agent_browser_batch ran nothing: step 2 click got arguments it cannot use/);
    expect(calls()).toEqual([]);

    const result = await call("agent_browser_batch", { steps: [
      { do: "fill", selector: "#email", text: "ada@example.com" }, { do: "click", selector: "#send" }, { do: "screenshot" },
    ] });
    expect(result.isError).toBeUndefined();
    const lines = texts(result);
    expect(lines[0]).toMatch(/^Ran all 3 steps in \d+\.\d s\.$/);
    expect(lines[1]).toMatch(/^1\. fill: fill \{"selector":"#email","text":"ada@example.com"\}/);
    expect(lines[2]).toMatch(/^2\. click: click \{"selector":"#send"\}/);
    expect(lines.slice(3)).toEqual([expect.stringMatching(/^3\. screenshot: shot/), "[image]"]);
    // a page action reads the page with eval before and after it, as a single call does
    expect(calls().map((entry) => entry.name)).toEqual([
      "agent_browser_eval", "agent_browser_fill", "agent_browser_eval", "agent_browser_eval", "agent_browser_click", "agent_browser_eval", "agent_browser_screenshot",
    ]);
  });

  it("stops at the first failing step and ends with the page's snapshot", async () => {
    const { call, calls } = engine();
    const result = await call("agent_browser_batch", { steps: [{ do: "press", key: "Tab" }, { do: "click", selector: "#missing" }, { do: "press", key: "Enter" }] });
    expect(result.isError).toBe(true);
    expect(texts(result)).toEqual([
      "Step 2 of 3 failed, so the 1 after it did not run. The 1 before it ran.",
      expect.stringMatching(/^1\. press: press \{"key":"Tab"\}/),
      "2. click failed: Element not found: #missing",
      `The page now:\n- button "Pay" [ref=e1]`,
    ]);
    expect(calls().filter((entry) => entry.name === "agent_browser_press")).toHaveLength(1);
  });

  it("stops when a person takes the browser, and does not read the page they hold", async () => {
    const { runtime, call, calls, hold } = engine();
    writeFileSync(hold, "");
    const running = call("agent_browser_batch", { steps: [{ do: "fill", selector: "#q", text: "x" }, { do: "press", key: "Enter" }, { do: "snapshot" }] });
    while (!calls().some((entry) => entry.name === "agent_browser_fill")) await new Promise((resolve) => setTimeout(resolve, 10));
    const taking = runtime.take("s", "person");
    rmSync(hold);
    await taking;
    const result = await running;
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toBe("A person took control of the browser at step 1 of 3, so the steps after it did not run. Step 1 may already have taken effect: check the page before repeating it.");
    expect(texts(result).at(-1)).toMatch(/^The person took control of the browser while this call ran/);
    expect(calls().map((entry) => entry.name)).not.toContain("agent_browser_press");
    expect(calls().map((entry) => entry.name)).not.toContain("agent_browser_snapshot");
    const next = call("agent_browser_batch", { steps: [{ do: "press", key: "Enter" }] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runtime.release("s", "person");
    await expect(next).resolves.toMatchObject({ isError: true, content: expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/^The person used the browser while this call waited/) })]) });
    expect(calls().map((entry) => entry.name)).not.toContain("agent_browser_press");
  });
});

describe("settled reads on the agent-browser engine", () => {
  it("waits out a check that clears by itself before the snapshot, with eval so refs stay put", async () => {
    const check = page({ title: "Just a moment...", textLength: 60, controls: 0, selectors: ["#challenge-running"] });
    const { call, calls } = engine([check, check, page()]);
    const started = Date.now();
    const result = await call("agent_browser_snapshot");
    expect(texts(result)[0]).toMatch(/^Bot check: cleared \(Cloudflare\)\. The site ran a Cloudflare bot check first; it cleared by itself after [12] s\.$/);
    expect(texts(result)[1]).toBe(`- button "Pay" [ref=e1]`);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls().map((entry) => entry.name)).toEqual(["probe", "probe", "probe", "agent_browser_wait_for_load", "probe", "agent_browser_snapshot"]);
  });

  it("names a check a person must answer at once, and adds nothing to an ordinary page", async () => {
    const held = engine([page({ selectors: ["#px-captcha"] })]);
    const result = await held.call("agent_browser_snapshot");
    expect(texts(result)[0]).toMatch(/still shows a PerimeterX bot check after 0 s\. Never click it, solve it or try to hide that you are a bot\. Do not wait or reload yourself: call request_sign_in/);
    expect(held.calls().filter((entry) => entry.name === "probe")).toHaveLength(1);
    const plain = engine([page()]);
    expect(texts(await plain.call("agent_browser_read"))).toEqual(["read {}"]);
  });

  it("gives placeholders up to 2 s after open, and says when they stayed", async () => {
    const { call } = engine([page({ busy: true })]);
    const result = await call("agent_browser_open", { url: "https://shop.test" });
    expect(texts(result)[0]).toMatch(/Parts of the page were still loading after 2 s/);
    expect(texts(result)).toContain(`- button "Pay" [ref=e1]`);
  });

  it("stops waiting on a check as soon as a person takes the browser", async () => {
    const check = page({ title: "Just a moment...", textLength: 60, controls: 0 });
    const { runtime, call, calls } = engine([check]);
    const reading = call("agent_browser_snapshot");
    while (!calls().some((entry) => entry.name === "probe")) await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    await runtime.take("s", "person");
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(reading).resolves.toMatchObject({ isError: true, content: expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/^The person took control of the browser while this call ran/) })]) });
    expect(calls().map((entry) => entry.name)).not.toContain("agent_browser_snapshot");
  });
});
