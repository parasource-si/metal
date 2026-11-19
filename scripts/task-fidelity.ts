// The task-fidelity eval: everyday requests (server/task-fidelity/cases.ts) in a scripted workspace where every app,
// browser and screen tool is mocked, so nothing reaches a real person or workspace.
//   --engine prompt   no model: checks that the prompt and tool descriptions each case gets carry the rules it needs
//   --engine claude   the real Claude Code CLI, with the case's mocked tools as its only tools
//   --engine model    a real model over an Anthropic Messages endpoint plays each case, and the run is scored on
//                     destination, route, steps, asking when the request leaves it open, staying on task, drafting first
// Run: node --experimental-strip-types scripts/task-fidelity.ts --engine model --label after --out <dir>
// The model run needs TASK_EVAL_KEY; TASK_EVAL_URL (default http://127.0.0.1:8317) and TASK_EVAL_MODEL are optional.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, type Case } from "../server/task-fidelity/cases.ts";
import { probeCase } from "../server/task-fidelity/probes.ts";
import { METRICS, scoreCase, scorecard, type Step, type Trace } from "../server/task-fidelity/score.ts";
import { answer, worldPrompt, worldTools, type Call } from "../server/task-fidelity/world.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1]! : fallback; };
const engine = opt("engine", "prompt");
const label = opt("label", "run");
const out = opt("out", "");
const only = opt("only", "").split(",").filter(Boolean);
const runs = Number(opt("runs", "1"));
const parallel = Number(opt("parallel", "4"));
const cases = CASES.filter((c) => !only.length || only.includes(c.id));

const URL_BASE = process.env.TASK_EVAL_URL ?? "http://127.0.0.1:8317";
const MODEL = process.env.TASK_EVAL_MODEL ?? "claude-sonnet-5";
const MAX_CALLS_PER_TURN = 25;

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "tool_result"; tool_use_id: string; content: string };
type Message = { role: "user" | "assistant"; content: string | Block[] };

async function complete(system: string, tools: ReturnType<typeof worldTools>, messages: Message[]): Promise<{ content: Block[]; stop_reason: string }> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${URL_BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": process.env.TASK_EVAL_KEY ?? "", authorization: `Bearer ${process.env.TASK_EVAL_KEY ?? ""}` },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, tools, messages }),
    });
    if (response.ok) return await response.json() as { content: Block[]; stop_reason: string };
    if (attempt >= 3 || (response.status < 500 && response.status !== 429)) throw new Error(`model ${response.status}: ${(await response.text()).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
  }
}

function needsAnotherTurn(c: Case, steps: Step[], turn: number): boolean {
  const sent = steps.some((s) => s.kind === "call" && ["slack_post", "slack_dm", "slack_reply", "gmail_create_draft"].includes(s.call.name)
    || s.kind === "call" && s.call.name === "COMPOSIO_MULTI_EXECUTE_TOOL" && /SEND|REPLY|DRAFT|INSERT|CREATE/i.test(JSON.stringify(s.call.input)));
  const lastText = steps.filter((s) => s.kind === "text" && s.turn === turn).map((s) => (s as { text: string }).text).join("\n");
  if (c.expect.destination === "none") return false;
  if (c.expect.destination === "any") return /\?/.test(lastText);
  return !sent;
}

async function playModel(c: Case): Promise<Trace> {
  const system = worldPrompt(c.world), tools = worldTools(c.world);
  const messages: Message[] = (c.world.history ?? []).map((m) => ({ role: m.role, content: m.text }));
  const steps: Step[] = [];
  const followUps = [...(c.followUps ?? [])];
  const page: { url?: string } = {};
  let turn = 1;
  messages.push({ role: "user", content: c.request });
  steps.push({ turn, kind: "user", text: c.request });
  try {
    for (;;) {
      let calls = 0;
      for (;;) {
        const reply = await complete(system, tools, messages);
        messages.push({ role: "assistant", content: reply.content });
        const results: Block[] = [];
        for (const block of reply.content) {
          if (block.type === "text" && block.text.trim()) steps.push({ turn, kind: "text", text: block.text.trim() });
          if (block.type === "tool_use") {
            const call: Call = { name: block.name, input: block.input ?? {} };
            const result = answer(c.world, call, page);
            steps.push({ turn, kind: "call", call, result });
            results.push({ type: "tool_result", tool_use_id: block.id, content: result });
            calls++;
          }
        }
        if (!results.length || reply.stop_reason !== "tool_use") break;
        messages.push({ role: "user", content: results });
        if (calls >= MAX_CALLS_PER_TURN) break;
      }
      const next = followUps.shift();
      if (!next || !needsAnotherTurn(c, steps, turn)) break;
      turn++;
      // a turn cut off mid-tool-use still needs its results answered before the person speaks
      const last = messages.at(-1)!;
      if (last.role === "user" && Array.isArray(last.content)) messages.push({ role: "assistant", content: "(stopped)" });
      messages.push({ role: "user", content: next });
      steps.push({ turn, kind: "user", text: next });
    }
    return { caseId: c.id, steps, turns: turn };
  } catch (error) {
    return { caseId: c.id, steps, turns: turn, error: (error as Error).message };
  }
}

const CLAUDE_MODEL = process.env.TASK_EVAL_CLAUDE_MODEL ?? "sonnet";
const TURN_MS = 5 * 60_000;
const WORLD_SERVER = fileURLToPath(new URL("../server/task-fidelity/mcp-world.ts", import.meta.url));

function claudeTurn(cwd: string, argv: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const texts: string[] = [];
    let buffer = "", errors = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TURN_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
          if (event.type === "assistant") for (const block of event.message?.content ?? []) if (block.type === "text" && block.text?.trim()) texts.push(block.text.trim());
        } catch { /* a partial line waits for the rest */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer);
      if (code === 0 || texts.length) resolve(texts);
      else reject(new Error(`claude exited ${code}: ${errors.slice(0, 300)}`));
    });
  });
}

/** The real Claude Code CLI, launched the way Metal launches it (project settings only, only the given MCP servers),
 * with its built-in tools off and the case's mocked tools, its own Bash and file tools included, as its one MCP server. */
async function playClaude(c: Case): Promise<Trace> {
  const cwd = mkdtempSync(join(tmpdir(), "task-fidelity-"));
  const log = join(cwd, "calls.jsonl");
  const config = join(cwd, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { world: { command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", WORLD_SERVER, c.id], env: { TASK_WORLD_LOG: log } } } }));
  const session = randomUUID();
  const base = ["-p", "--output-format", "stream-json", "--verbose", "--model", CLAUDE_MODEL, "--tools", "", "--strict-mcp-config", "--mcp-config", config,
    "--setting-sources", "project", "--allowedTools", "mcp__world", "--append-system-prompt", worldPrompt(c.world)];
  const history = (c.world.history ?? []).map((m) => `${m.role === "user" ? "Me" : "You"}: ${m.text}`).join("\n");
  const steps: Step[] = [];
  const followUps = [...(c.followUps ?? [])];
  let turn = 1, message = history ? `(Earlier in this chat)\n${history}\n\n${c.request}` : c.request, seen = 0;
  try {
    for (;;) {
      steps.push({ turn, kind: "user", text: turn === 1 ? c.request : message });
      const texts = await claudeTurn(cwd, [...base, ...(turn === 1 ? ["--session-id", session] : ["--resume", session]), message]);
      const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      for (const line of lines.slice(seen)) {
        const { call, result } = JSON.parse(line) as { call: Call; result: string };
        steps.push({ turn, kind: "call", call, result });
      }
      seen = lines.length;
      for (const text of texts) steps.push({ turn, kind: "text", text });
      const next = followUps.shift();
      if (!next || !needsAnotherTurn(c, steps, turn)) break;
      turn++;
      message = next;
    }
    return { caseId: c.id, steps, turns: turn };
  } catch (error) {
    return { caseId: c.id, steps, turns: turn, error: (error as Error).message };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const at = next++; results[at] = await work(items[at]!); }
  }));
  return results;
}

const pct = (pass: number, of: number) => of ? `${Math.round((pass / of) * 100)}%` : "n/a";

if (engine === "prompt") {
  const results = cases.map(probeCase);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.caseId.padEnd(26)} ${r.probes.map((p) => `${p.pass ? "+" : "-"}${p.id}`).join(" ")}`);
  const probes = results.flatMap((r) => r.probes);
  console.log(`\n${label}: cases ${results.filter((r) => r.pass).length}/${results.length}, rules ${probes.filter((p) => p.pass).length}/${probes.length}`);
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${label}-prompt.json`), JSON.stringify(results, null, 2)); }
} else if (engine === "model" || engine === "claude") {
  if (engine === "model" && !process.env.TASK_EVAL_KEY) throw new Error("TASK_EVAL_KEY is not set");
  const play = engine === "claude" ? playClaude : playModel;
  const modelName = engine === "claude" ? `claude code ${CLAUDE_MODEL}` : MODEL;
  const plays = cases.flatMap((c) => Array.from({ length: runs }, () => c));
  const traces = await pool(plays, parallel, async (c) => { const t = await play(c); process.stderr.write(`${c.id} done${t.error ? ` (error: ${t.error})` : ""}\n`); return t; });
  const scored = traces.map((trace) => ({ trace, score: scoreCase(CASES.find((c) => c.id === trace.caseId)!, trace) }));
  for (const { trace, score } of scored) {
    console.log(`${score.pass ? "PASS" : "FAIL"} ${trace.caseId.padEnd(26)} ${METRICS.map((m) => `${m}:${score[m] === null ? "-" : score[m] ? "y" : "N"}`).join(" ")} calls:${score.calls} to:${score.sends.map((s) => s.to).join(",") || "-"}${trace.error ? " ERROR" : ""}`);
  }
  const card = scorecard(scored.map((s) => s.score));
  console.log(`\n${label} (${modelName}, ${runs} run${runs > 1 ? "s" : ""} per case): ${card.passed}/${card.cases} cases fully right; ${METRICS.map((m) => `${m} ${pct(card.metrics[m].pass, card.metrics[m].of)}`).join(", ")}; mean tool calls ${card.meanCalls}`);
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${label}-model.json`), JSON.stringify({ model: modelName, runs, card, results: scored }, null, 2)); }
} else {
  throw new Error(`unknown --engine ${engine}`);
}
