// `pnpm test:main`: what CI's required jobs check on main (lint, typecheck, locales, every vitest project, the node --test
// suites; not the production builds, packaging or e2e smokes), locally and in one command, for while GitHub Actions is off.
// Each step's output goes to .dusk-scratch/test-main/<step>.log; the end prints one line a step and the tail of each
// failure. Every step runs even after one fails, so one run names everything that is red.
//   --only=lint,vitest   run these steps     --skip=vitest   leave these out     --list   print the steps
// DUSK_VITEST_WORKERS sets the root suite's parallel files (default: half the cores, at most 6).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOGS = join(ROOT, ".dusk-scratch", "test-main");
const workers = process.env.DUSK_VITEST_WORKERS || String(Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2))));
// the dashboard's node --test files, which its vitest run leaves out (ci.yml, static job)
const DASHBOARD_NODE = ["connector-rows", "live", "place", "plan-total", "usage-math"].map((name) => `apps/dashboard/src/data/${name}.test.ts`);

const STEPS = [
  { name: "i18n", cmd: "pnpm", args: ["i18n:check"] },
  { name: "lint", cmd: "pnpm", args: ["lint"] },
  { name: "typecheck", cmd: "pnpm", args: ["typecheck"] },
  { name: "check-electron", cmd: "pnpm", args: ["check:electron"] },
  { name: "typecheck-dashboard", cmd: "pnpm", args: ["typecheck:dashboard"] },
  { name: "typecheck-mobile", cmd: "pnpm", args: ["--filter", "@metal/mobile", "typecheck"] },
  { name: "vitest-dashboard", cmd: "pnpm", args: ["exec", "vitest", "run", "--config", "apps/dashboard/vite.config.ts", "--root", ".", "--exclude", "apps/dashboard/src/data/{connector-rows,live,place,plan-total,usage-math}.test.ts", "apps/dashboard/src"] },
  { name: "node-test-dashboard", cmd: "node", args: ["--test", ...DASHBOARD_NODE] },
  { name: "vitest", cmd: "pnpm", args: ["exec", "vitest", "run"], env: { DUSK_VITEST_WORKERS: workers } },
  { name: "vitest-broker", cmd: "pnpm", args: ["broker:test"] },
  { name: "node-test-electron", cmd: "pnpm", args: ["test:electron"] },
  // the deploy scripts' own node tests (backup, uptime and host report), which no CI job runs
  { name: "node-test-deploy", cmd: "node", args: ["--test", "deploy/account/*.node-test.mjs", "deploy/monitor/*.node-test.mjs"] },
];

const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1].split(",").filter(Boolean);
if (process.argv.includes("--list")) {
  for (const step of STEPS) console.log(`${step.name.padEnd(20)} ${step.cmd} ${step.args.join(" ")}`);
  process.exit(0);
}
const only = flag("only");
const skip = flag("skip") ?? [];
const unknown = [...(only ?? []), ...skip].filter((name) => !STEPS.some((step) => step.name === name));
if (unknown.length) {
  console.error(`unknown step: ${unknown.join(", ")} (see --list)`);
  process.exit(2);
}
const chosen = STEPS.filter((step) => (!only || only.includes(step.name)) && !skip.includes(step.name));

mkdirSync(LOGS, { recursive: true });

function run(step) {
  const log = join(LOGS, `${step.name}.log`);
  const out = createWriteStream(log);
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(step.cmd, step.args, { cwd: ROOT, env: { ...process.env, CI: "", FORCE_COLOR: "0", ...step.env }, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("close", (code, signal) => out.end(() => done({ ...step, log, ok: code === 0, code: code ?? signal, seconds: Math.round((Date.now() - started) / 1000) })));
    child.on("error", (error) => out.end(`\n${error.message}\n`, () => done({ ...step, log, ok: false, code: error.message, seconds: 0 })));
  });
}

const results = [];
for (const step of chosen) {
  process.stdout.write(`${step.name} ... `);
  const result = await run(step);
  console.log(result.ok ? `ok (${result.seconds}s)` : `FAILED (${result.seconds}s, exit ${result.code})`);
  results.push(result);
}

const failed = results.filter((result) => !result.ok);
for (const result of failed) {
  const lines = readFileSync(result.log, "utf8").split("\n");
  // vitest names each failure on a FAIL line and node --test on a ✖ line; otherwise the log's tail
  const named = [...new Set(lines.filter((line) => /^ FAIL |^✖ (?!failing tests)/.test(line)))];
  const shown = (named.length ? named : lines.filter((line) => line.trim()).slice(-30)).slice(0, 40).map((line) => line.slice(0, 240));
  console.log(`\n--- ${result.name} (${result.log})\n${shown.join("\n")}`);
}
console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? `; failed: ${failed.map((result) => result.name).join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
