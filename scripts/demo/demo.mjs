// `pnpm demo`: a separate Metal seeded with the test bots (scripts/demo/content.mjs), in its own data folder, harness port and UI port.
// It never reads or writes ~/.duskbot and never talks to the 8799 harness or the 5199 UI.
//
//   pnpm demo            start (seeding on first run) and open it in the browser
//   pnpm demo --reset    stop, wipe the demo folder, reseed, start
//   pnpm demo stop       stop the demo's harness and UI
//   pnpm demo status     say whether it is running and where
//   --no-open            start without opening a browser
//
// DUSK_DEMO_DIR (default ~/.duskbot-demo), DUSK_DEMO_PORT (8899; webhooks on +1), DUSK_DEMO_UI_PORT (5299) and
// DUSK_DEMO_MODEL (claude/claude-sonnet-5, as INSTANCE/MODEL) change the defaults.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, seedBots } from "./seed-live.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const REAL_DATA = resolve(homedir(), ".duskbot");
const DEMO_DIR = resolve(process.env.DUSK_DEMO_DIR || join(homedir(), ".duskbot-demo"));
const RUN = join(DEMO_DIR, ".demo");
const LOGS = join(RUN, "logs");
const PORT = Number(process.env.DUSK_DEMO_PORT || 8899);
const UI_PORT = Number(process.env.DUSK_DEMO_UI_PORT || 5299);
const MODEL = process.env.DUSK_DEMO_MODEL || "claude/claude-sonnet-5";
const URL_UI = `http://127.0.0.1:${UI_PORT}`;
const API = `http://127.0.0.1:${PORT}`;
const OWNER_MARK = join(RUN, "owner.json");
const MARKERS = { harness: "server/dev-server.ts", vite: "scripts/demo/vite-demo.mjs" };

function refuseUnsafeConfig() {
  const problems = [];
  if (DEMO_DIR === REAL_DATA || DEMO_DIR === resolve(homedir()) || REAL_DATA.startsWith(`${DEMO_DIR}/`)) problems.push(`DUSK_DEMO_DIR may not be ${DEMO_DIR}`);
  if (!basename(DEMO_DIR).includes("demo")) problems.push("the demo folder's name must contain \"demo\"");
  for (const port of [PORT, PORT + 1, UI_PORT]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) problems.push(`port ${port} is not usable`);
    if ([8799, 8800, 5199, 9333].includes(port)) problems.push(`port ${port} belongs to the regular dev setup`);
  }
  if (problems.length) {
    console.error(`pnpm demo: ${problems.join("; ")}`);
    process.exit(2);
  }
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const writeJson = (file, value, mode = 0o600) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The pid is still ours: alive and still running the command we started (not a reused pid). */
function ours(pid, marker) {
  if (!pid || !alive(pid)) return false;
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(marker); } catch { return false; }
}

async function answers(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

async function portTaken(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch (error) {
    return error?.cause?.code !== "ECONNREFUSED";
  }
}

async function waitFor(url, label, timeoutMs, child) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) throw new Error(`${label} exited (code ${child.exitCode}); see ${LOGS}`);
    if (await answers(url)) return;
    await sleep(400);
  }
  throw new Error(`${label} did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s; see ${LOGS}`);
}

/** The user's shell environment (HOME and PATH, so engine CLIs and their sign-ins work), minus every DUSK_ setting that
 * could point this child at another workspace. */
function childEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(DUSK_|DUSK_|DUSK_|FAKE_CLAUDE_|ELECTRON_)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

const harnessEnv = () => childEnv({
  DUSK_DATA_DIR: DEMO_DIR, DUSK_PORT: String(PORT), DUSK_WEBHOOK_PORT: String(PORT + 1), DUSK_DEV_TRUST_LOCAL_BROWSER: "1",
  // the demo seeds its own test bots; the first-run seeding would add a second set beside them
  DUSK_NO_TEST_BOTS: "1",
});

function startProcess(name, args, env, detached) {
  mkdirSync(LOGS, { recursive: true });
  const log = openSync(join(LOGS, `${name}.log`), "a");
  const child = spawn(process.execPath, args, { cwd: REPO, env, detached, stdio: ["ignore", log, log] });
  closeSync(log);
  if (detached) child.unref();
  return child;
}

async function stopPid(pid, marker) {
  if (!ours(pid, marker)) return false;
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(200);
  if (alive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
  return true;
}

async function stop({ quiet = false } = {}) {
  const run = readJson(join(RUN, "run.json"));
  let stopped = 0;
  if (run) {
    if (await stopPid(run.vitePid, MARKERS.vite)) stopped++;
    if (await stopPid(run.harnessPid, MARKERS.harness)) stopped++;
    rmSync(join(RUN, "run.json"), { force: true });
  }
  if (!quiet) console.log(stopped ? "Demo stopped." : "The demo was not running.");
}

async function running() {
  const run = readJson(join(RUN, "run.json"));
  return Boolean(run && ours(run.harnessPid, MARKERS.harness) && ours(run.vitePid, MARKERS.vite) && await answers(`${API}/api/health`));
}

function wipe() {
  if (!existsSync(DEMO_DIR)) return;
  if (!existsSync(OWNER_MARK)) {
    console.error(`pnpm demo: ${DEMO_DIR} exists but was not made by pnpm demo; refusing to delete it. Pick another DUSK_DEMO_DIR.`);
    process.exit(2);
  }
  rmSync(DEMO_DIR, { recursive: true, force: true });
}

function prepareFolder() {
  if (existsSync(DEMO_DIR) && !existsSync(OWNER_MARK)) {
    console.error(`pnpm demo: ${DEMO_DIR} exists but was not made by pnpm demo; refusing to use it. Pick another DUSK_DEMO_DIR.`);
    process.exit(2);
  }
  mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  if (!existsSync(OWNER_MARK)) writeJson(OWNER_MARK, { createdBy: "pnpm demo", createdAt: new Date().toISOString() });
}

async function seed() {
  const [instanceId, ...rest] = MODEL.split("/");
  const model = rest.join("/");
  if (!instanceId || !model) throw new Error(`DUSK_DEMO_MODEL must be INSTANCE/MODEL, got ${MODEL}`);
  writeJson(join(DEMO_DIR, "config.json"), {
    onboarding: {
      completedAt: new Date().toISOString(), version: 1, reelSeen: true,
      hintsSeen: ["met-chief-v1", "grok-move-2026-11"],
    },
    defaultModelSelection: { instanceId, model },
  });
  console.log(`Seeding the demo in ${DEMO_DIR} (model ${MODEL})`);
  const harness = startProcess("harness", ["--experimental-strip-types", "server/dev-server.ts"], harnessEnv(), false);
  try {
    await waitFor(`${API}/api/health`, "the demo harness", 120_000, harness);
    const now = Date.now();
    const { state, credentials } = await seedBots(API, now, (line) => console.log(line));
    // What the "Meet Dusk" card's Add button saves, so the fresh demo opens without it. Demo only.
    const helper = (await call(API, "GET", "/api/bots?messages=0")).bots.find((bot) => bot.defaultBot);
    if (helper) await call(API, "PATCH", `/api/bots/${helper.id}`, { welcomed: true, sidebarHidden: false, pinned: true });
    writeJson(join(RUN, "seed-state.json"), state);
    writeJson(join(RUN, "webhooks.json"), credentials);
  } finally {
    harness.kill("SIGTERM");
    for (let i = 0; i < 100 && harness.exitCode === null && harness.signalCode === null; i++) await sleep(200);
    if (harness.exitCode === null && harness.signalCode === null) harness.kill("SIGKILL");
  }
  const offline = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/demo/seed-offline.ts", join(RUN, "seed-state.json")], {
    cwd: REPO, stdio: "inherit", env: childEnv({ DUSK_DATA_DIR: DEMO_DIR, DUSK_DEMO_EXPECTED_DIR: DEMO_DIR }),
  });
  const code = await new Promise((done) => offline.on("exit", done));
  if (code !== 0) throw new Error(`the offline seed step failed (exit ${code})`);
  writeJson(join(RUN, "seeded.json"), { seededAt: new Date().toISOString(), model: MODEL });
}

function openBrowser() {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try { spawn(opener, [URL_UI], { stdio: "ignore", detached: true }).unref(); } catch {}
}

function summary() {
  console.log(`
Metal demo is running
  open      ${URL_UI}
  harness   ${API} (webhooks on ${PORT + 1})
  data      ${DEMO_DIR}
  logs      ${LOGS}
  webhooks  ${join(RUN, "webhooks.json")} (demo-only addresses and secrets)
  stop      pnpm demo stop      reset   pnpm demo --reset`);
}

async function start({ reset, open }) {
  if (reset) {
    await stop({ quiet: true });
    wipe();
  } else if (await running()) {
    summary();
    if (open) openBrowser();
    return;
  } else {
    await stop({ quiet: true });
  }
  for (const port of [PORT, PORT + 1, UI_PORT]) {
    if (await portTaken(port)) throw new Error(`port ${port} is already in use; set DUSK_DEMO_PORT / DUSK_DEMO_UI_PORT`);
  }
  prepareFolder();
  if (!existsSync(join(RUN, "seeded.json"))) await seed();
  const harness = startProcess("harness", ["--experimental-strip-types", "server/dev-server.ts"], harnessEnv(), true);
  const vite = startProcess("vite", ["scripts/demo/vite-demo.mjs"], childEnv({ DUSK_PORT: String(PORT), DUSK_UI_PORT: String(UI_PORT) }), true);
  writeJson(join(RUN, "run.json"), { harnessPid: harness.pid, vitePid: vite.pid, port: PORT, uiPort: UI_PORT, startedAt: new Date().toISOString() });
  try {
    await waitFor(`${API}/api/health`, "the demo harness", 120_000, harness);
    await waitFor(URL_UI, "the demo UI", 60_000, vite);
  } catch (error) {
    await stop({ quiet: true });
    throw error;
  }
  summary();
  if (open) openBrowser();
}

refuseUnsafeConfig();
const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("-")) ?? "start";
const reset = args.includes("--reset") || command === "reset";
const open = !args.includes("--no-open");
try {
  if (command === "stop") await stop();
  else if (command === "status") {
    if (await running()) summary();
    else console.log(`The demo is not running. Data: ${DEMO_DIR}${existsSync(join(RUN, "seeded.json")) ? " (seeded)" : " (not seeded yet)"}`);
  } else if (command === "start" || command === "reset") await start({ reset, open });
  else {
    console.error(`pnpm demo: unknown command ${command}; use start, stop, status or --reset`);
    process.exit(2);
  }
} catch (error) {
  console.error(`pnpm demo: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
