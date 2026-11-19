import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const killed: unknown[] = [];
vi.mock("../procs.ts", () => ({
  killCliTree: async (child: FakeChild) => {
    killed.push(child);
    child.die();
    return true;
  },
}));

const { CODEX_IDLE_MS, CodexAppServerPool, codexIdleMs, codexSpawnKey } = await import("./codex-app-server-pool.ts");

let nextPid = 1000;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = nextPid++;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly written: any[] = [];

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) this.written.push(JSON.parse(line));
    });
  }

  say(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  die(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

const spawn = () => new FakeChild();
const asChild = (child: FakeChild) => child as unknown as ChildProcessWithoutNullStreams;
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("Codex app-server pool", () => {
  let clock = 0;
  let pool: InstanceType<typeof CodexAppServerPool>;

  beforeEach(() => {
    killed.length = 0;
    clock = 1_000_000;
    pool = new CodexAppServerPool({ label: "test", now: () => clock, idleMs: () => CODEX_IDLE_MS });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands an idle app-server to the next turn with the same launch, and to no other", () => {
    const child = spawn();
    const server = pool.adopt("key-a", asChild(child));
    expect(pool.take("key-a", null)).toBeNull();
    pool.release(server);
    expect(pool.take("key-b", null)).toBeNull();
    expect(pool.take("key-a", null)).toBe(server);
    expect(server.leased).toBe(true);
  });

  it("prefers the app-server that has the thread loaded", () => {
    const a = pool.adopt("key", asChild(spawn()));
    const b = pool.adopt("key", asChild(spawn()));
    b.threads.set("native-1", { contract: "c", approval: {}, lastUsed: clock });
    pool.release(a);
    pool.release(b);
    expect(pool.take("key", "native-1")).toBe(b);
  });

  it("closes another idle app-server that still has the thread loaded, so no turn runs on its older copy", async () => {
    const holder = pool.adopt("old-settings", asChild(spawn()));
    holder.threads.set("native-1", { contract: "c", approval: {}, lastUsed: clock });
    pool.release(holder);
    expect(pool.take("new-settings", "native-1")).toBeNull();
    await flush();
    expect(killed).toEqual([holder.child]);
    expect(pool.size()).toBe(0);
  });

  it("retires a busy app-server holding the thread once its turn ends", () => {
    const busy = pool.adopt("key", asChild(spawn()));
    busy.threads.set("native-1", { contract: "c", approval: {}, lastUsed: clock });
    pool.take("other", "native-1");
    expect(busy.retiring).toBe(true);
    pool.release(busy);
    expect(killed).toEqual([busy.child]);
  });

  it("closes an idle app-server after the idle limit", async () => {
    vi.useFakeTimers();
    const server = pool.adopt("key", asChild(spawn()));
    pool.release(server);
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS - 1_000);
    expect(killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(killed).toEqual([server.child]);
    expect(pool.size()).toBe(0);
  });

  it("unloads threads idle past the limit from an app-server other threads keep busy", async () => {
    const child = spawn();
    const server = pool.adopt("key", asChild(child));
    server.threads.set("stale", { contract: "c", approval: {}, lastUsed: clock - CODEX_IDLE_MS - 1 });
    server.threads.set("fresh", { contract: "c", approval: {}, lastUsed: clock });
    pool.release(server);
    await flush();
    expect(child.written).toEqual([{ jsonrpc: "2.0", id: 1, method: "thread/unsubscribe", params: { threadId: "stale" } }]);
    expect([...server.threads.keys()]).toEqual(["fresh"]);
    child.say({ jsonrpc: "2.0", id: 1, result: { status: "unsubscribed" } });
    await flush();
    expect(server.retiring).toBe(false);
  });

  it("refuses a server request that arrives while no turn holds the app-server", async () => {
    const child = spawn();
    pool.release(pool.adopt("key", asChild(child)));
    child.say({ jsonrpc: "2.0", id: 7, method: "item/commandExecution/requestApproval", params: {} });
    await flush();
    expect(child.written).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "No Metal turn is running on this thread." } }]);
  });

  it("drops an app-server that exits while idle", () => {
    const child = spawn();
    pool.release(pool.adopt("key", asChild(child)));
    child.die();
    expect(pool.size()).toBe(0);
    expect(pool.take("key", null)).toBeNull();
  });

  it("closes every idle app-server and retires the busy ones", async () => {
    const idle = pool.adopt("key", asChild(spawn()));
    const busy = pool.adopt("key", asChild(spawn()));
    pool.release(idle);
    expect(await pool.closeIdle()).toBe(true);
    expect(killed).toEqual([idle.child]);
    expect(busy.retiring).toBe(true);
  });

  it("delivers each message to the turn holding the app-server, whole lines only", async () => {
    const child = spawn();
    const server = pool.adopt("key", asChild(child));
    const seen: unknown[] = [];
    server.attach({ message: (message) => seen.push(message), stderr: () => {}, exit: () => {}, close: () => {}, error: () => {} });
    child.stdout.write('{"method":"a"}\n{"meth');
    child.stdout.write('od":"b"}\n');
    await flush();
    expect(seen).toEqual([{ method: "a" }, { method: "b" }]);
  });
});

describe("Codex warm launch key and idle time", () => {
  it("changes with anything the app-server was launched with", () => {
    const base = { cli: "codex", args: ["app-server"], env: { HOME: "/h", A: "1" }, cwd: "/w", login: null };
    expect(codexSpawnKey(base)).toBe(codexSpawnKey({ ...base, env: { A: "1", HOME: "/h", UNSET: undefined } }));
    for (const changed of [{ args: ["app-server", "-c", "x=1"] }, { env: { HOME: "/h", A: "2" } }, { cwd: "/other" }, { login: "signed-in-again" }]) {
      expect(codexSpawnKey({ ...base, ...changed })).not.toBe(codexSpawnKey(base));
    }
  });

  it("keeps an idle app-server five minutes unless the person configured another time", () => {
    expect(codexIdleMs({})).toBeLessThanOrEqual(CODEX_IDLE_MS);
    expect(codexIdleMs({ DUSK_CODEX_SESSION_IDLE_MS: "900000" })).toBe(900_000);
  });
});
