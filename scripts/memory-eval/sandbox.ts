// A throwaway Metal server for the memory eval: its own data dir and home, one engine instance pointed at an
// OpenAI-compatible gateway, nothing from this machine's real bots. The key is read here and written only into the
// sandbox's own config.json (0600), never printed.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface Gateway {
  url: string;
  key: string;
  model: string;
}

/** DUSK_EVAL_URL / DUSK_EVAL_KEY, else the local mchat gateway's .env (MCHAT_BASE_URL / MCHAT_API_KEY). */
export function gatewayFromEnv(model: string): Gateway {
  let url = process.env.DUSK_EVAL_URL ?? "";
  let key = process.env.DUSK_EVAL_KEY ?? "";
  if (!key) {
    const file = process.env.DUSK_EVAL_ENV_FILE ?? join(homedir(), "Desktop", "code", "mchat", ".env");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(MCHAT_BASE_URL|MCHAT_API_KEY)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
      if (m?.[1] === "MCHAT_API_KEY") key = m[2]!;
      if (m?.[1] === "MCHAT_BASE_URL" && !url) url = m[2]!;
    }
  }
  if (!key) throw new Error("no gateway key: set DUSK_EVAL_KEY or DUSK_EVAL_ENV_FILE");
  url = (url || "http://127.0.0.1:8317").replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url = `${url}/v1`;
  return { url, key, model };
}

const AVOID = new Set([5199, 8799, 5299, 8899, 9335, 8317, 8888, 8890, 9999, 4545, 5433, 6379, 27017, 29017]);

async function free(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer().once("error", () => resolve(false)).once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function freePair(): Promise<number> {
  for (let port = 7400 + Math.floor(Math.random() * 400); port < 7990; port += 2) {
    if (AVOID.has(port) || AVOID.has(port + 1)) continue;
    if ((await free(port)) && (await free(port + 1))) return port;
  }
  throw new Error("no free port pair in 7400-7990");
}

export interface Sandbox {
  url: string;
  dataDir: string;
  logPath: string;
  child: ChildProcess;
  /** Stops the server and keeps its data, runs `between` (to write files as an older install left them), starts again. */
  restart(between?: () => void | Promise<void>): Promise<void>;
  close(keep?: boolean): Promise<void>;
}

export interface SandboxOptions {
  /** More of config.json, merged over the eval's own. */
  config?: Record<string, unknown>;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((r) => { child.once("exit", r); setTimeout(r, 8_000); });
}

/** `repo` is the checkout whose server/index.ts runs: the eval compares two checkouts with the same script. */
export async function launchSandbox(repo: string, gateway: Gateway, memory: { captureQuietMs: number }, options: SandboxOptions = {}): Promise<Sandbox> {
  const port = await freePair();
  const root = mkdtempSync(join(process.env.DUSK_EVAL_TMP ?? tmpdir(), "dusk-memory-eval-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    features: { smartSetupChoices: false },
    memory,
    instances: { gw: { driver: "openai-compat", displayName: "Eval gateway", config: { url: gateway.url, key: gateway.key, model: gateway.model } } },
    ...options.config,
  }, null, 2), { mode: 0o600 });
  const logPath = join(root, "server.log");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dataDir,
    TMPDIR: join(dataDir, "tmp"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TZ: process.env.TZ,
    DUSK_DATA_DIR: dataDir,
    DUSK_PORT: String(port),
    DUSK_WEBHOOK_PORT: String(port + 1),
    // a shared copy of the local embedding model, so each run does not download it again
    ...(process.env.DUSK_MODEL_DIR ? { DUSK_MODEL_DIR: process.env.DUSK_MODEL_DIR } : {}),
    ...(process.env.DUSK_MEMORY_EMBED ? { DUSK_MEMORY_EMBED: process.env.DUSK_MEMORY_EMBED } : {}),
    ...(process.env.DUSK_NO_TEST_BOTS ? { DUSK_NO_TEST_BOTS: process.env.DUSK_NO_TEST_BOTS } : {}),
  };
  const url = `http://127.0.0.1:${port}`;
  const start = async (): Promise<ChildProcess> => {
    const log = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, ["--experimental-strip-types", join(repo, "server", "index.ts")], { cwd: repo, env, stdio: ["ignore", log, log] });
    closeSync(log);
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`sandbox server exited; see ${logPath}`);
      const ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok ? r.json() : null).catch(() => null) as { app?: string } | null;
      if (ok?.app === "duskbot") return child;
      if (Date.now() > deadline) throw new Error(`sandbox server did not start; see ${logPath}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const box: Sandbox = {
    url, dataDir, logPath, child: await start(),
    async restart(between) {
      await stop(box.child);
      await between?.();
      box.child = await start();
    },
    async close(keep = false) {
      await stop(box.child);
      if (!keep) rmSync(root, { recursive: true, force: true });
    },
  };
  return box;
}
