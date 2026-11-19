import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";

import { killCliTree } from "../procs.ts";
import { armIdleClose, sessionIdlePolicy, stopIdleClose } from "./session-idle.ts";

/** How long a native thread stays loaded in a warm app-server after its last turn, and an idle app-server stays up. */
export const CODEX_IDLE_MS = 5 * 60_000;
const UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/** DUSK_CODEX_SESSION_IDLE_MS (or DUSK_SESSION_IDLE_MS) when set, else five minutes or the box's shorter default. */
export function codexIdleMs(env: Record<string, string | undefined> = process.env): number {
  const policy = sessionIdlePolicy("CODEX", env);
  return env.DUSK_CODEX_SESSION_IDLE_MS || env.DUSK_SESSION_IDLE_MS ? policy.idleMs : Math.min(CODEX_IDLE_MS, policy.idleMs);
}

/** DUSK_CODEX_WARM=0 starts one app-server per turn, as before warm reuse. */
export function codexWarmEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DUSK_CODEX_WARM !== "0";
}

/** What one app-server was launched with. Two turns with the same key may share a process. */
export function codexSpawnKey(parts: { cli: string; args: readonly string[]; env: Record<string, string | undefined>; cwd: string; login: string | null }): string {
  const env = Object.entries(parts.env).filter(([, value]) => value !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([parts.cli, parts.args, env, parts.cwd, parts.login])).digest("hex");
}

export interface CodexUsageTotal { input: number; output: number; cachedInput: number }

/** A native thread this process has loaded, and what it was loaded with. */
export interface LoadedThread {
  /** The thread-level overrides it was started or resumed with: Codex rejoins a loaded thread without applying new ones. */
  contract: string;
  /** The approval parameters as the start or resume reply resolved them. */
  approval: unknown;
  rolloutPath?: string;
  /** The thread's running token total after its last turn, the next turn's baseline. */
  usage?: CodexUsageTotal;
  lastUsed: number;
}

/** What the turn holding the process hears from it. */
export interface AppServerSink {
  message(message: any): void;
  stderr(chunk: string): void;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
  close(code: number | null, signal: NodeJS.Signals | null): void;
  error(error: Error): void;
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class CodexAppServer {
  readonly threads = new Map<string, LoadedThread>();
  /** The initialize reply, once the process answered it. */
  initialized: unknown = undefined;
  leased = false;
  /** Closes when released: it may hold a thread another process now runs. */
  retiring = false;
  private sink: AppServerSink | null = null;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  idleTimer: ReturnType<typeof setTimeout> | null = null;

  readonly key: string;
  readonly child: ChildProcessWithoutNullStreams;
  private readonly gone: (server: CodexAppServer) => void;

  constructor(key: string, child: ChildProcessWithoutNullStreams, gone: (server: CodexAppServer) => void) {
    this.key = key;
    this.child = child;
    this.gone = gone;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.on("data", (chunk) => this.sink?.stderr(String(chunk)));
    child.on("error", (error) => {
      this.gone(this);
      this.sink?.error(error);
    });
    child.on("exit", (code, signal) => {
      this.gone(this);
      for (const waiter of this.pending.values()) waiter.reject(new Error("codex app-server exited"));
      this.pending.clear();
      this.sink?.exit(code, signal);
    });
    child.on("close", (code, signal) => this.sink?.close(code, signal));
  }

  id(): number {
    return this.nextId++;
  }

  alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  attach(sink: AppServerSink): void {
    this.sink = sink;
  }

  detach(sink: AppServerSink): void {
    if (this.sink === sink) this.sink = null;
  }

  /** A request of the pool's own while no turn holds the process. */
  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.id();
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  write(message: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {}
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const own = message?.id !== undefined && (message.result !== undefined || message.error !== undefined) ? this.pending.get(message.id) : undefined;
      if (own) {
        this.pending.delete(message.id);
        if (message.error) own.reject(new Error(String(message.error?.message ?? "codex request failed")));
        else own.resolve(message.result);
      } else if (this.sink) {
        this.sink.message(message);
      } else if (message?.id !== undefined && message.method) {
        // A server request with no turn to answer it: refuse it rather than leave the app-server waiting.
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "No Metal turn is running on this thread." } });
      }
    }
  }
}

/** One Codex account's warm app-servers. A native thread is loaded in at most one of them, so a turn never runs on a
 * process holding an older copy of its history. */
export class CodexAppServerPool {
  private readonly servers = new Set<CodexAppServer>();
  private readonly label: string;
  private readonly now: () => number;
  private readonly idleMs: () => number;

  constructor(options: { label: string; now?: () => number; idleMs?: () => number }) {
    this.label = options.label;
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? (() => codexIdleMs());
  }

  /** Wraps a freshly spawned app-server; the caller holds it until `release` or `close`. */
  adopt(key: string, child: ChildProcessWithoutNullStreams): CodexAppServer {
    const server = new CodexAppServer(key, child, (gone) => this.forget(gone));
    server.leased = true;
    this.servers.add(server);
    return server;
  }

  /** An idle process launched with `key`, preferring the one that already has `nativeThreadId` loaded. Any other process
   * holding that thread closes (or closes once released). Null when the caller must spawn one. */
  take(key: string, nativeThreadId: string | null): CodexAppServer | null {
    let chosen: CodexAppServer | null = null;
    for (const server of this.servers) {
      if (server.leased || server.retiring || server.key !== key || !server.alive()) continue;
      if (nativeThreadId && server.threads.has(nativeThreadId)) { chosen = server; break; }
      if (!chosen || server.threads.size < chosen.threads.size) chosen = server;
    }
    if (nativeThreadId) this.unloadElsewhere(nativeThreadId, chosen);
    if (!chosen) return null;
    if (chosen.idleTimer) stopIdleClose(this.idleKey(chosen), chosen.idleTimer);
    chosen.idleTimer = null;
    chosen.leased = true;
    return chosen;
  }

  /** The turn ended cleanly: the process stays up for the next one, threads idle past the limit are unloaded, and the
   * process itself closes after the idle limit. */
  release(server: CodexAppServer): void {
    server.leased = false;
    if (server.retiring || !server.alive()) {
      this.close(server);
      return;
    }
    const idleMs = this.idleMs();
    const cutoff = this.now() - idleMs;
    for (const [threadId, thread] of server.threads) {
      if (thread.lastUsed >= cutoff) continue;
      server.threads.delete(threadId);
      // Codex unloads a thread once no client is subscribed to it.
      server.request("thread/unsubscribe", { threadId }, UNSUBSCRIBE_TIMEOUT_MS).catch(() => { server.retiring = true; });
    }
    server.idleTimer = armIdleClose(this.idleKey(server), idleMs, {
      idle: () => !server.leased,
      close: () => { if (!server.leased) this.close(server); },
    });
  }

  /** Stops the process and drops it. */
  close(server: CodexAppServer): Promise<boolean> {
    this.forget(server);
    if (!server.alive()) return Promise.resolve(true);
    return killCliTree(server.child);
  }

  /** Every idle process; a leased one closes when its turn releases it. */
  async closeIdle(): Promise<boolean> {
    const idle = [...this.servers].filter((server) => !server.leased);
    for (const server of this.servers) if (server.leased) server.retiring = true;
    return (await Promise.all(idle.map((server) => this.close(server)))).every(Boolean);
  }

  size(): number {
    return this.servers.size;
  }

  idleCount(): number {
    return [...this.servers].filter((server) => !server.leased).length;
  }

  private unloadElsewhere(nativeThreadId: string, keep: CodexAppServer | null): void {
    for (const server of this.servers) {
      if (server === keep || !server.threads.has(nativeThreadId)) continue;
      server.threads.delete(nativeThreadId);
      if (server.leased) server.retiring = true;
      else void this.close(server);
    }
  }

  private forget(server: CodexAppServer): void {
    if (!this.servers.delete(server)) return;
    stopIdleClose(this.idleKey(server), server.idleTimer);
    server.idleTimer = null;
  }

  private idleKey(server: CodexAppServer): string {
    return `codex\0${this.label}\0${server.child.pid ?? server.key}`;
  }
}
