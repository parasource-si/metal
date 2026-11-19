// Only the desktop app's own server may use this computer. A second Metal server on the same computer (a copy run
// from source, a demo) finds the app's driver record on disk, in the folder the app keeps it in, and still never mounts
// this computer or drives it; the app's own server, which hears the record over its parent port, still can.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOT_THE_APP = "Only the Metal app on this computer can let a bot use it.";

describe("this computer belongs to the desktop app's own server", () => {
  let home = "";
  let data = "";
  let ui = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";
  const record = { mode: "embedded", status: "ready", socketPath: "", mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} };

  const resetTurn = () => {
    writeFileAtomic(stateFile, JSON.stringify({ noContainers: true }));
    rmSync(dumpFile, { force: true });
    rmSync(finishFile, { force: true });
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const dump = (): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
  }, Boolean);
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const idle = (botId: string, threadId: string) => until(() => threadState(botId, threadId), task => Boolean(task) && !task.busy);
  const rows = async (threadId: string) =>
    ((await apiOk("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[])
      .map((message) => String(message.tool?.name ?? message.text ?? ""));

  /** `desktop`: launched as the app launches its own server, hearing the driver record over the parent port. */
  async function start(desktop: boolean, env: Record<string, string> = {}) {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const hooks = ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
      ...(desktop ? ["--import", pathToFileURL(join(ROOT, "server/testing/desktop-parent.mjs")).href] : [])];
    const proc = spawn(process.execPath, [...hooks, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, DUSK_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        DUSK_PORT: String(port), DUSK_WEBHOOK_PORT: String(port + 1), DUSK_STATIC_DIR: ui, DUSK_TEST_VM_STATE: stateFile,
        // The app's record, where the app keeps it and where this server is pointed: neither lets it in.
        DUSK_USER_DATA: join(home, "user-data"),
        ...(desktop ? { DUSK_TEST_DESKTOP_CUA_CONNECTION: join(home, "user-data", "cua-connection.json") } : {}),
        ...env,
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    writeFileSync(finishFile, "finish");
    await waitForExit(proc, { signal: "SIGTERM" });
  }
  const itHost = process.platform === "linux" ? it.skip : it;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "dusk-desktop-computer-"));
    data = join(home, "data");
    ui = join(home, "static");
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    record.socketPath = join(home, "cua.sock");
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Desktop computer</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    for (const folder of [join(home, "user-data"), join(home, "Library", "Application Support", "Dusk Bot")]) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, "cua-connection.json"), JSON.stringify(record), { mode: 0o600 });
    }
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    } } }));
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(async () => {
    await stop(); resetTurn();
    writeFileAtomic(join(home, "user-data", "cua-connection.json"), JSON.stringify(record));
  });

  it("a server the app did not launch mounts no computer on Auto, though the app's record is on disk", async () => {
    await start(false);
    const { bot } = await apiOk("POST", "/api/bots", { name: "Second Server Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Plan my week using my calendar.", threadId: task.threadId });
    const sent = await dump();
    expect(sent.mcpConfig?.mcpServers?.computer).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("/fixture/cua-driver");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
  });

  it("a server the app did not launch refuses this computer even when the person picks it, in plain words", async () => {
    await start(false);
    const { bot } = await apiOk("POST", "/api/bots", { name: "Second Server Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on this computer.", threadId: task.threadId });
    const failed = await until(() => rows(task.threadId), (lines) => lines.some((line) => line.includes(NOT_THE_APP)));
    expect(failed.join("\n")).not.toMatch(/CUA|Cua Driver|DevTools|descriptor/);
    expect(existsSync(dumpFile)).toBe(false);
    await idle(bot.id, task.threadId);
  });

  itHost("the app's own server still uses this computer, from the record the app hands it", async () => {
    await start(true);
    const { bot } = await apiOk("POST", "/api/bots", { name: "Desktop Server Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on this computer.", threadId: task.threadId });
    const sent = await dump();
    expect(sent.mcpConfig.mcpServers.computer.env.DUSK_CUA_COMMAND).toBe("/fixture/cua-driver");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
  });

  itHost("the first local turn waits for helper startup and mounts it without replaying the turn", async () => {
    const grantFile = join(home, "user-data", "cua-connection.json");
    writeFileAtomic(grantFile, "null");
    await start(true);
    const { bot } = await apiOk("POST", "/api/bots", { name: "Starting Desktop Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on this computer.", threadId: task.threadId });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(existsSync(dumpFile)).toBe(false);
    expect((await rows(task.threadId)).join("\n")).not.toContain("can't use this computer yet");
    writeFileAtomic(grantFile, JSON.stringify(record));
    const sent = await dump();
    expect(sent.mcpConfig.mcpServers.computer.env.DUSK_CUA_COMMAND).toBe("/fixture/cua-driver");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    expect((await rows(task.threadId)).filter(line => line === "Open Chrome on this computer.")).toHaveLength(1);
  });

  itHost("a bot on this computer without screen permission still replies, with its browser and no screen tools", async () => {
    writeFileAtomic(join(home, "user-data", "cua-connection.json"), JSON.stringify({
      mode: "unavailable", reason: "Screen Recording required for CuaDriver; turn on CuaDriver in System Settings > Privacy & Security",
    }));
    const browser = join(home, "agent-browser");
    writeFileSync(browser, "#!/bin/sh\necho '{\"success\":true,\"data\":{\"sessions\":[]}}'\n", { mode: 0o755 });
    await start(true, { DUSK_AGENT_BROWSER_PATH: browser });
    const { bot } = await apiOk("POST", "/api/bots", { name: "No Permission Bot" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "hi", threadId: task.threadId });
    const sent = await dump();
    expect(sent.mcpConfig?.mcpServers?.computer).toBeUndefined();
    expect(sent.mcpConfig?.mcpServers?.browser).toBeDefined();
    const prompt = JSON.stringify(sent);
    expect(prompt).toContain("go straight to your built-in browser and do it; never say you cannot open a website");
    expect(prompt).toContain("controlling a computer's apps also comes with dusk cloud plans");
    expect(prompt).not.toMatch(/notice above the message box, and the person|allow it from the notice/);
    expect(prompt).toContain("macOS has not given Metal Screen Recording on this Mac yet");
    expect(prompt).toContain("Never call it for web work");
    const agents = sent.mcpConfig.mcpServers.agents;
    expect(agents.env.DUSK_SCREEN_ACCESS).toBe("1");
    const asked = await fetch(`${base}/api/internal/request-screen-access`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agents.env.DUSK_COMMS_TOKEN}` },
      body: JSON.stringify({ reason: "Open Keynote" }),
    });
    expect(await asked.json()).toEqual({ shown: true, missing: ["Screen Recording"] });
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    const lines = (await rows(task.threadId)).join("\n");
    expect(lines).not.toMatch(/can't use this computer yet|failed/i);
  });

  itHost("Stop during helper startup prevents a late ready grant from starting the turn", async () => {
    const grantFile = join(home, "user-data", "cua-connection.json");
    writeFileAtomic(grantFile, "null");
    await start(true);
    const { bot } = await apiOk("POST", "/api/bots", { name: "Stopped Desktop Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on this computer.", threadId: task.threadId });
    await new Promise(resolve => setTimeout(resolve, 200));
    await apiOk("POST", `/api/bots/${bot.id}/interrupt`, { threadId: task.threadId });
    await idle(bot.id, task.threadId);
    writeFileAtomic(grantFile, JSON.stringify(record));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(existsSync(dumpFile)).toBe(false);
    expect((await rows(task.threadId)).join("\n")).not.toMatch(/Computer setup cancelled|can't use this computer yet/);
  });
});
