// The browser benchmark: 25 local pages that reproduce hard real-world UI (server/browser-bench/tasks*.ts), each with
// a check of what the page saw. A real Claude Code CLI plays each task through Metal's browser tools on the real
// BrowserService and a headless Chrome; nothing leaves this computer.
//   --engine claude    the real Claude Code CLI, built-in tools off, the browser tools as its one MCP server
//   --engine scripted  each task's known way through, no model: checks the fixtures and their checks
// Run: node --experimental-strip-types scripts/browser-bench.ts --engine claude --runs 3 --label before --out <dir>
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHROME_BROWSER_SYSTEM_PROMPT } from "../server/browser/prompt.ts";
import { scorePlay, scorecard, type LoggedCall, type Play } from "../server/browser-bench/score.ts";
import { BenchSite } from "../server/browser-bench/site.ts";
import type { BenchTask, TaskContext } from "../server/browser-bench/task.ts";
import { TASKS } from "../server/browser-bench/tasks.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1]! : fallback; };
const engine = opt("engine", "scripted");
const label = opt("label", "run");
const out = opt("out", "");
const only = opt("only", "").split(",").filter(Boolean);
const runs = Number(opt("runs", "1"));
const parallel = Number(opt("parallel", "4"));
const model = opt("model", process.env.BENCH_CLAUDE_MODEL ?? "sonnet");
const tasks = TASKS.filter((task) => !only.length || only.includes(task.id));
const PLAY_MS = 6 * 60_000;
const MCP_SERVER = fileURLToPath(new URL("../server/browser-bench/mcp-browser.ts", import.meta.url));

process.env.DUSK_CDP_E2E ??= "1";
const site = await BenchSite.start(TASKS);

function prepare(task: BenchTask): { context: TaskContext; run: ReturnType<BenchSite["newRun"]>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "browser-bench-"));
  const files = join(dir, "files");
  mkdirSync(files);
  for (const [name, contents] of Object.entries(task.files ?? {})) writeFileSync(join(files, name), contents);
  const run = site.newRun(task.id);
  return { context: { base: site.base(run), cross: site.cross(run), files }, run, dir };
}

function claude(cwd: string, argv: string[]): Promise<{ answer: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const texts: string[] = [];
    let result = "", buffer = "", errors = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), PLAY_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line) as { type?: string; result?: string; message?: { content?: Array<{ type: string; text?: string }> } };
          if (event.type === "assistant") for (const block of event.message?.content ?? []) if (block.type === "text" && block.text?.trim()) texts.push(block.text.trim());
          if (event.type === "result" && typeof event.result === "string") result = event.result;
        } catch { /* a partial line waits for the rest */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.on("error", (error) => resolve({ answer: texts.join("\n"), error: error.message }));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const answer = [...texts, result].join("\n");
      resolve(code === 0 ? { answer } : { answer, error: signal === "SIGTERM" ? `timed out after ${PLAY_MS / 60_000} min` : `claude exited ${code}: ${errors.slice(0, 200)}` });
    });
  });
}

async function playClaude(task: BenchTask): Promise<Play> {
  const { context, run, dir } = prepare(task);
  const log = join(dir, "calls.jsonl");
  const config = join(dir, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { browser: { command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", MCP_SERVER], env: { BENCH_LOG: log, DUSK_CDP_E2E: "1", ...(process.env.DUSK_CDP_CHROME ? { DUSK_CDP_CHROME: process.env.DUSK_CDP_CHROME } : {}) } } } }));
  const started = Date.now();
  try {
    const { answer, error } = await claude(dir, ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--tools", "", "--strict-mcp-config", "--mcp-config", config,
      "--setting-sources", "project", "--allowedTools", "mcp__browser", "--append-system-prompt", CHROME_BROWSER_SYSTEM_PROMPT, task.request(context)]);
    const ms = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LoggedCall) : [];
    return { ...scorePlay({ taskId: task.id, group: task.group, verdict: task.check(run, answer), calls, ms, answer, ...(error ? { runError: error } : {}) }), events: [...run.events, ...run.requests] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function playScripted(task: BenchTask): Promise<Play> {
  const { startService } = await import("../server/browser/testing/real-service.ts");
  const real = await startService();
  const { context, run, dir } = prepare(task);
  const calls: LoggedCall[] = [];
  const started = Date.now();
  try {
    const call = async (name: string, input: Record<string, unknown> = {}) => {
      const at = Date.now();
      const result = await real.call({ session: "bench", key: "bot:bench" }, name, input);
      const text = real.text(result);
      calls.push({ at, ms: Date.now() - at, name, args: input, isError: result.isError === true, chars: text.length, images: 0, text: text.slice(0, 4_000) });
      if (result.isError) throw new Error(text);
      return text;
    };
    let answer = "", runError: string | undefined;
    try { answer = await task.solve(call, context); } catch (error) { runError = (error as Error).message; }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return scorePlay({ taskId: task.id, group: task.group, verdict: task.check(run, answer), calls, ms: Date.now() - started, answer, ...(runError ? { runError } : {}) });
  } finally {
    await real.close();
    rmSync(dir, { recursive: true, force: true });
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

const play = engine === "claude" ? playClaude : engine === "scripted" ? playScripted : null;
if (!play) throw new Error(`unknown --engine ${engine}`);
const plays = await pool(tasks.flatMap((task) => Array.from({ length: runs }, () => task)), parallel, async (task) => {
  const result = await play(task);
  process.stderr.write(`${result.pass ? "PASS" : "FAIL"} ${task.id.padEnd(18)} steps ${String(result.steps).padStart(2)} errors ${result.errors} ${Math.round(result.ms / 1_000)}s${result.failure ? `  ${result.failure.slice(0, 140)}` : ""}\n`);
  return result;
});
const card = scorecard(plays);
const row = (name: string, l: { passed: number; plays: number; successPct: number; meanSteps: number; meanSeconds: number; meanErrors: number; meanKChars: number }) =>
  `${name.padEnd(18)} ${`${l.passed}/${l.plays}`.padStart(6)} ${`${l.successPct}%`.padStart(5)}  steps ${String(l.meanSteps).padStart(5)}  ${String(l.meanSeconds).padStart(6)}s  errors ${l.meanErrors}  read ${l.meanKChars}k`;
console.log(`\n${label} (${engine === "claude" ? `claude code ${model}` : "scripted"}, ${runs} run${runs > 1 ? "s" : ""} per task)`);
console.log(row("all", card.all));
for (const [group, l] of Object.entries(card.groups)) if (l.plays) console.log(row(group, l));
console.log(`errors by kind: ${JSON.stringify(card.errorKinds)}`);
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.json`), JSON.stringify({ label, engine, model: engine === "claude" ? model : null, runs, at: new Date().toISOString(), card, plays }, null, 2));
}
await site.close();
process.exit(0);
