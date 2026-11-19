import { killCliTree, spawnCli } from "./procs.ts";
import { scrubHeldSecrets } from "../shared/redact.ts";
import { DEFAULT_BROWSER_RESULT_BUDGET, describePageChange, OBSERVE_PAGE_SCRIPT, parsePageState, READ_OPEN_PAGE_ONLY, readsAroundBrowser, scrubBrowserResult, shapeBrowserToolResult, slimBrowserToolList, stripHarnessOwnedArguments, type PageState } from "./browser-tool-shape.ts";
import { BrowserLanes } from "./browser-lane.ts";
import { AGENT_CLOSE_FAILED, BROWSER_CLOSING, BROWSER_CONTROL_REFUSAL, BROWSER_INTERRUPTED, BROWSER_RESTART_TOOL, LANE_BUSY, LAUNCH_CHANGED, PERSON_RESTART_STOPPED, PersonHoldAnswer, personStillHolds, personTookTab, personUsedTab, RESTART_BUSY, browserRefusal } from "./browser-refusals.ts";
export { BROWSER_CONTROL_REFUSAL, BROWSER_RESTART_TOOL, browserRefusal };
import { trail } from "./trail.ts";
import { PageSizes, type PageSize } from "./browser-page-size.ts";
import { SECRET_ON_PAGE, SecretHolds, type SecretHold } from "./browser-secret-hold.ts";
import type { BrowserSteps, StepCall, StepContext } from "./browser-steps.ts";
import { HARNESS_CALL_BUDGET_MS } from "./harness-budget.ts";
import { launchSettingsKey } from "./browser-launch-key.ts";
import { AGENT_BROWSER_BATCH_SPEC, agentBrowserStep, planAgentBrowserBatch, PROBE_SCRIPT, probeOfEval, SETTLED_READS, type AgentBrowserCall } from "./browser/agent-browser-batch.ts";
import { runSteps } from "./browser/batch.ts";
import { settleNote, settlePage, type PageReader } from "./browser/cdp/settle.ts";

import { ThreadTabs, type ClosedThreadTab } from "./browser-thread-tabs.ts";
import { agentBrowserTypeInLines, runAgentBrowserTypeInLines } from "./line-break-typing.ts";
import { asToolResult, firstText, lostCallToolError, recoveredResult, stillBusyToolError, stuckBrowserToolError, toolNameOf, type ToolResult } from "./browser-runtime-results.ts";
import { BATCH_TOOL } from "./browser/tools.ts";

/** The hosts whose bot check cleared in each browser. */
const clearedChecks = new WeakMap<object, Set<string>>();

export interface BrowserSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/** Told to the bot when a page script is refused on a page the person typed into beside it. */
export const PERSON_TYPED_ON_PAGE = "The person typed on this page while you worked, maybe a password, so agent_browser_eval is refused here for now. Read the page with agent_browser_snapshot or agent_browser_get_text instead.";
/** The bot's next answer after the person used its browser beside it. */
export const PERSON_ACTED = "The person also used this browser since your last browser call (they can click and type in it while you work), so the page may have changed: check it before relying on earlier @eN refs, and do not undo what they did.";
const BROWSER_RESTART_TOOL_SPEC = {
  name: BROWSER_RESTART_TOOL,
  description: "Close and restart your browser. Use this only when a browser tool says the browser must be restarted, or it stays busy after a call that did not answer. Every open tab is closed and unsaved page state such as form input is lost; sign-ins stay unless it is a temporary browser. Afterwards open the page you need again and check whether the interrupted action already happened before repeating it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
export const BROWSER_UPLOAD_TOOL = "agent_browser_upload";
export const BROWSER_HOVER_TOOL = "agent_browser_hover";
/** agent-browser 0.37.0 offers upload and hover only in its 156-tool "all" profile, so Metal runs these two through the daemon's relay. */
const RELAYED_TOOL_SPECS = [
  {
    name: BROWSER_UPLOAD_TOOL,
    description: "Put files into a file input (<input type=\"file\">), then submit its form as usual. files are absolute paths of files the person attached to this conversation or files in your own working folder; any other path is refused.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["selector", "files"],
      properties: {
        selector: { type: "string", minLength: 1, description: "The file input: an @eN ref from a snapshot, or a CSS selector." },
        files: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 }, description: "Absolute paths of the files to put in the input." },
      },
    },
  },
  {
    name: BROWSER_HOVER_TOOL,
    description: "Move the mouse over an element, for menus and tooltips that open on hover.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["selector"],
      properties: { selector: { type: "string", minLength: 1, description: "An @eN ref from a snapshot, or a CSS selector." } },
    },
  },
];
type RelayedToolSpec = (typeof RELAYED_TOOL_SPECS)[number];
const RELAYED_TOOLS: ReadonlyMap<string, RelayedToolSpec> = new Map(RELAYED_TOOL_SPECS.map((spec) => [spec.name, spec]));
const idleClosedNote = (saves: boolean) => `Your browser sat unused and was closed to free memory; this call opened it again. Pages you had open are gone (${saves ? "saved sign-ins are kept" : "it is a temporary browser, so its sign-ins are gone too"}), so open the page you need again before using earlier @eN refs.`;
const PERSON_RESTARTED = "The person restarted your browser from the Browser panel; this call ran in the fresh browser. Pages you had open are gone, so open the page you need again before using earlier @eN refs, and check whether an interrupted action already happened before repeating it.";
/** One bot call, lane wait included, answers within `callBudgetMs`; the engine's action keeps `followUpReserveMs` of it for the reads after. */
export const BROWSER_CALL_DEFAULTS = { requestTimeoutMs: 120_000, laneWaitMs: 30_000, callBudgetMs: HARNESS_CALL_BUDGET_MS, followUpReserveMs: 15_000 } as const;
const LATE = Symbol("late"), HOLD_POLL_MS = 500;

const PAGE_ACTIONS: ReadonlySet<string> = new Set([
  "agent_browser_click", "agent_browser_fill", "agent_browser_type", "agent_browser_press",
  "agent_browser_check", "agent_browser_uncheck", "agent_browser_select", BROWSER_UPLOAD_TOOL, BROWSER_HOVER_TOOL,
]);
const MAX_REQUEST_BYTES = 1_048_576, MAX_RESPONSE_BYTES = 16_777_216, HANDSHAKE_TIMEOUT_MS = 1_000;
const HOST_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "Path", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"];

/** One env for MCP, viewer and cleanup so they share HOME/socket paths: OS plumbing, never provider credentials. */
export function browserRuntimeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(HOST_ENV.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return { ...env, ...overrides };
}

export function attachesToChrome(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.AGENT_BROWSER_CDP || env.AGENT_BROWSER_AUTO_CONNECT);
}

export function ownsBrowserViewport(env: NodeJS.ProcessEnv): boolean {
  return env.AGENT_BROWSER_HEADLESS === "1" && !attachesToChrome(env);
}

export class TransportError extends Error {}

/** One timed browser action (ms), logged with DUSK_BROWSER_TIMING=1; `inFlight` is this session's work already running. */
export interface BrowserTiming {
  session: string;
  tool: string;
  outcome: "ok" | "error";
  totalMs: number;
  launchMs?: number;
  engineMs?: number;
  observeMs?: number;
  stepsMs?: number;
  chars?: number;
  inFlight: number;
}

export function formatBrowserTiming(timing: BrowserTiming): string {
  const parts = [`browser timing: ${timing.tool} ${timing.outcome}`];
  const phases: Array<[string, number | undefined]> = [
    ["total", timing.totalMs], ["launch", timing.launchMs], ["engine", timing.engineMs], ["observe", timing.observeMs], ["steps", timing.stepsMs],
  ];
  for (const [label, value] of phases) {
    if (value !== undefined) parts.push(`${label}=${Math.round(value)}ms`);
  }
  if (timing.chars !== undefined) parts.push(`chars=${timing.chars}`);
  parts.push(`inflight=${timing.inFlight}`, `session=${timing.session}`);
  return parts.join(" ");
}

function resultChars(result: unknown): number {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const item of content) {
    const text = (item as { text?: unknown } | null)?.text;
    if (typeof text === "string") chars += text.length;
  }
  return chars;
}

/** The engine answered with a failure (marked `settled: true`): nothing is left running, so no restart is needed. */
export function isSettledBrowserFailure(error: unknown): boolean {
  return (error as { settled?: unknown } | null)?.settled === true;
}
type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Neither the child's stderr nor its environment is ever returned to the agent. */
class BrowserClient {
  readonly child: ReturnType<typeof spawnCli>;
  readonly ready: Promise<void>;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stopped = false;
  private idleTimer?: NodeJS.Timeout;
  private stoppedPromise?: Promise<void>;
  private requestTimeoutMs: number;
  private idleMs: number;
  private maxPending: number;
  private onClose: () => void;
  private onRequestTimeout: (params: unknown) => void;

  constructor(
    spec: BrowserSpawnSpec,
    requestTimeoutMs: number,
    idleMs: number,
    maxPending: number,
    onClose: () => void,
    onRequestTimeout: (params: unknown) => void,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.idleMs = idleMs;
    this.maxPending = maxPending;
    this.onClose = onClose;
    this.onRequestTimeout = onRequestTimeout;
    this.child = spawnCli(spec.command, spec.args, {
      env: browserRuntimeEnv(spec.env), stdio: ["pipe", "pipe", "pipe"], shell: false, botWork: true,
    });
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stdin.on("error", () => { void this.stop(new TransportError("Browser connection closed.")); });
    this.child.on("error", () => { void this.stop(new TransportError("Could not start the browser engine.")); });
    this.child.on("close", () => { void this.stop(new TransportError("Browser connection closed.")); });
    this.ready = this.rpc("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "duskbot-browser", version: "1" },
    }, Math.max(this.requestTimeoutMs, HANDSHAKE_TIMEOUT_MS)).then((result) => {
      if (!result || typeof result !== "object" || !("protocolVersion" in result)) {
        throw new TransportError("Browser engine returned an invalid handshake.");
      }
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    }).catch((error: unknown) => {
      void this.stop(error instanceof Error ? error : new TransportError("Browser handshake failed."));
      throw error;
    });
  }

  private read(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > MAX_RESPONSE_BYTES) {
        void this.stop(new TransportError("Browser response exceeded the size limit."));
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch {
        void this.stop(new TransportError("Browser engine returned invalid JSON."));
        return;
      }
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending) continue;
      this.pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Browser request failed."));
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new TransportError("Browser response has no result."));
      this.armIdle();
    }
    if (this.buffer.length > MAX_RESPONSE_BYTES) {
      void this.stop(new TransportError("Browser response exceeded the size limit."));
    }
  }

  private write(message: unknown): void {
    if (this.stopped) throw new TransportError("Browser connection closed.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) void this.stop(new TransportError("Browser connection closed."));
    });
  }

  rpc(method: string, params: unknown, timeoutMs: number = this.requestTimeoutMs): Promise<unknown> {
    if (this.stopped) return Promise.reject(new TransportError("Browser connection closed."));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error("Too many pending browser requests. Try again when the current action finishes."));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST_BYTES) return Promise.reject(new Error("Browser request exceeded the size limit."));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Seal the gate synchronously, before stop(): the rejection can surface through the ready handshake, outside agentRpc's classifier.
        this.onRequestTimeout(params);
        void this.stop(new TransportError("Browser request timed out; restart the browser before taking control."));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(message); }
      catch { void this.stop(new TransportError("Browser connection closed.")); }
    });
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.stopped && this.pending.size === 0) {
      this.idleTimer = setTimeout(() => { void this.stop(undefined, "transport"); }, this.idleMs);
      this.idleTimer.unref();
    }
  }

  /** agent-browser's MCP loop exits on stdin EOF and leaves the daemon; Windows taskkill /T would kill that profile's Chrome too. */
  private retireTransport(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.off("exit", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch {}
        finish();
      }, 1_000);
      this.child.once("exit", finish);
      if (this.child.exitCode !== null || this.child.signalCode !== null) finish();
      else this.child.stdin.end();
    });
  }

  stop(error = new TransportError("Browser connection closed."), scope: "transport" | "tree" = "tree"): Promise<void> {
    if (this.stoppedPromise) return this.stoppedPromise;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose();
    this.stoppedPromise = scope === "transport" ? this.retireTransport() : killCliTree(this.child, 1_000).then((stopped) => {
      if (stopped) return;
      try {
        if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch {}
    });
    return this.stoppedPromise;
  }
}

export type ApplyViewport = (spec: BrowserSpawnSpec, size: PageSize) => Promise<unknown>;

type LaunchSpec = { command: string; env?: Record<string, string | undefined> };
/** The browser the engine starts, prepared by Metal. */
export interface BrowserLaunch {
  /** Before the engine may start the browser; rejects with a message for the bot while it cannot start yet. */
  ready(spec: LaunchSpec): Promise<void>;
  /** Once the engine runs the browser, again after every start. */
  started(session: string, spec: LaunchSpec): Promise<void>;
  stopped(session: string): void;
}

interface Gate {
  owner: string | null;
  ready: boolean;
  releasing: boolean;
  agents: number;
  /** Of `agents`, reads that only check whether a lost call ended. */
  probes: number;
  dispatched: number;
  humans: number;
  uncertain: boolean;
  /** Null when a person left the uncertainty behind: only a restart clears that. */
  lostCall: string | null;
  closing: boolean;
  changed: Set<() => void>;
  watchers: number;
  calls: number;
  lastUsed: number;
  spec?: BrowserSpawnSpec;
  /** An idle close in progress: agent calls and new views wait for it. */
  idleClose?: Promise<void>;
  /** Closed since the bot's last call: its next answer says why its pages are gone. */
  reopened: "idle" | "restart" | null;
  /** The person clicked or typed beside the bot since its last call: its next answer says so. */
  personActed: boolean;
}

type ClientEntry = { key: string; client: BrowserClient };

/** Closes one session's native browser daemon; true only when it is gone. */
export type CloseBrowser = (session: string, spec: BrowserSpawnSpec) => Promise<boolean>;
/** Sends one command to the session's running agent-browser daemon. Throws TransportError when it does not answer in time. */
export type RelayCommand = (spec: BrowserSpawnSpec, session: string, command: Record<string, unknown>, timeoutMs: number) =>
  Promise<{ success: boolean; data: Record<string, unknown> | null; error?: string }>;

export class BrowserRuntime {
  private gates = new Map<string, Gate>();
  private clients = new Map<string, ClientEntry>();
  private recoveries = new Map<string, Promise<string | null>>();
  private toolLists = new Map<string, unknown>();
  private idleCloseListeners = new Set<(session: string) => void>();
  private options: { requestTimeoutMs: number; takeoverTimeoutMs: number; idleMs: number; maxPending: number; resultBudget: number; recoveryCheckMs: number; laneWaitMs: number; callBudgetMs: number; followUpReserveMs: number };
  private closeBrowser: CloseBrowser;
  private applyViewport?: ApplyViewport;
  private launch?: BrowserLaunch;
  private relayCommand?: RelayCommand;
  private steps?: Pick<BrowserSteps, "before" | "after" | "signIn" | "note" | "forget" | "recentFrame" | "personTook">;
  private lanes = new BrowserLanes(({ call, waitedMs, holder }) => trail("browser.lane.busy", { call, waitedMs, holder: holder?.call ?? null, heldMs: holder ? Date.now() - holder.since : null }));
  private threadTabs = new ThreadTabs();
  /** The page size people's views want; the agent-browser live view sets it, and every bot call applies it first. */
  readonly pageSizes = new PageSizes({
    apply: (session, size) => { const spec = this.gates.get(session)?.spec; return spec && this.applyViewport ? this.applyViewport(spec, size) : Promise.resolve(); },
    lane: (session, work) => this.lanes.run(session, work, this.options.laneWaitMs, "page_size"),
    watched: (session) => { const gate = this.gates.get(session); return Boolean(gate && gate.watchers > 0 && !gate.closing); },
  });
  private holds = new SecretHolds((session, clear) => this.lanes.run(session, () => this.agentAction(session, clear, false), this.options.laneWaitMs, "secret_clear").then((ran) => ran !== null));
  /** Strips held secrets (a filled password, a one-time code) from every tool result before the bot reads it. */
  private scrub: (text: string) => string;
  private onTiming?: (timing: BrowserTiming) => void;
  /** A bot of this session asked the person to sign in or pass a check: while they hold its browser, its calls are refused. */
  private signingIn: (session: string) => boolean;

  constructor({ closeBrowser, applyViewport, launch, relayCommand, steps, scrub, onTiming, signingIn, ...options }: Partial<BrowserRuntime["options"]> & { closeBrowser?: CloseBrowser; applyViewport?: ApplyViewport; launch?: BrowserLaunch; relayCommand?: RelayCommand; steps?: BrowserRuntime["steps"]; scrub?: (text: string) => string; onTiming?: (timing: BrowserTiming) => void; signingIn?: (session: string) => boolean } = {}) {
    this.signingIn = signingIn ?? (() => false);
    this.options = { ...BROWSER_CALL_DEFAULTS, takeoverTimeoutMs: 15_000, idleMs: 60_000, maxPending: 16, resultBudget: DEFAULT_BROWSER_RESULT_BUDGET, recoveryCheckMs: 30_000, ...options };
    this.closeBrowser = closeBrowser ?? (async () => false);
    this.applyViewport = applyViewport;
    this.launch = launch;
    this.relayCommand = relayCommand;
    this.steps = steps;
    this.scrub = scrub ?? scrubHeldSecrets;
    this.onTiming = onTiming;
  }

  private timed<T>(session: string, tool: string, phases: Partial<BrowserTiming>, fn: () => Promise<T>): Promise<T> {
    if (!this.onTiming) return fn();
    const onTiming = this.onTiming;
    const started = performance.now();
    const inFlight = this.gate(session).agents;
    const report = (outcome: BrowserTiming["outcome"]) => onTiming({ session, tool, outcome, totalMs: performance.now() - started, ...phases, inFlight });
    return fn().then((result) => {
      report((result as { isError?: unknown } | null)?.isError === true ? "error" : "ok");
      return result;
    }, (error: unknown) => {
      report("error");
      throw error;
    });
  }

  private gate(session: string): Gate {
    let gate = this.gates.get(session);
    if (!gate) {
      gate = { owner: null, ready: false, releasing: false, agents: 0, probes: 0, dispatched: 0, humans: 0, uncertain: false, lostCall: null, closing: false, changed: new Set(), watchers: 0, calls: 0, lastUsed: Date.now(), reopened: null, personActed: false };
      this.gates.set(session, gate);
    }
    return gate;
  }

  private changed(gate: Gate): void {
    if (gate.releasing && gate.humans === 0) {
      gate.owner = null;
      gate.releasing = false;
      gate.ready = false;
    }
    for (const notify of gate.changed) notify();
  }

  /** What a bot call is told when the person took the browser while it ran. */
  private taken(session: string): Error {
    return this.signingIn(session) ? new Error(BROWSER_CONTROL_REFUSAL) : new PersonHoldAnswer(personTookTab("the browser"));
  }

  /**
   * agent-browser drives the tab in front, the one a person's hold is on, so a bot call waits out the whole hold: until
   * the hand-back, its turn's stop (`beforeDispatch` throws), or the call's budget. It never runs after, since the page may
   * have changed under the person's hands. A hold on the bot's own sign-in request is refused outright.
   */
  private async heldBack(session: string, deadline: number, beforeDispatch?: () => void): Promise<void> {
    const gate = this.gate(session);
    if (gate.owner === null) return;
    if (this.signingIn(session)) throw new Error(BROWSER_CONTROL_REFUSAL);
    const started = Date.now();
    const until = deadline - this.options.followUpReserveMs;
    throw await new Promise<Error>((resolve) => {
      const answer = (): Error | null => {
        try { beforeDispatch?.(); } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
        if (gate.owner !== null && this.signingIn(session)) return new Error(BROWSER_CONTROL_REFUSAL);
        if (gate.owner === null && !gate.releasing) return new PersonHoldAnswer(personUsedTab("the browser"));
        if (Date.now() >= until) return new PersonHoldAnswer(personStillHolds("the browser", Date.now() - started));
        return null;
      };
      const check = () => {
        const found = answer();
        if (!found) return;
        gate.changed.delete(check);
        clearInterval(timer);
        resolve(found);
      };
      gate.changed.add(check);
      const timer = setInterval(check, HOLD_POLL_MS);
      timer.unref();
      check();
    });
  }

  async withAgentAction<T>(session: string, fn: () => Promise<T>): Promise<T> {
    return this.agentAction(session, fn, true);
  }

  /** `use`: a bot's own action restarts idle time; a preview frame holds off an idle close but never keeps the browser open. */
  private async agentAction<T>(session: string, fn: () => Promise<T>, use: boolean): Promise<T> {
    const gate = this.gate(session);
    if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    if (gate.uncertain) throw new Error(BROWSER_INTERRUPTED);
    if (gate.closing) throw new Error(BROWSER_CLOSING);
    gate.agents++;
    try {
      const result = await fn();
      if (gate.owner !== null) throw this.taken(session);
      return result;
    } finally {
      gate.agents--;
      if (use) gate.lastUsed = Date.now();
      this.changed(gate);
    }
  }

  /** Runs in the browser's lane, so no capture or read happens while a secret is typed. */
  async withSecretInput<T extends { ok: boolean; text: string; host?: string; filled?: string[]; held?: SecretHold }>(session: string, spec: Pick<BrowserSpawnSpec, "command" | "env">, fn: () => Promise<T>, ctx?: StepContext): Promise<T> {
    const outcome = await this.lanes.run(session, async () => {
      const value = await this.withAgentAction(session, async () => {
        const filled = await fn();
        if (filled.held) this.holds.hold(session, filled.held);
        return filled;
      });
      const step = await this.steps?.signIn({ session, spec, ctx }, value).catch(() => null);
      return step ? { ...value, text: `${value.text} Recorded as step ${step}.` } : value;
    }, this.options.laneWaitMs, "fill_login");
    if (outcome === null) throw new Error(LANE_BUSY);
    return outcome;
  }

  /** agent-browser runs one command at a time, and a frame behind a stuck action stays queued past its own timeout (0.37.0:
   * 27 frames during a 120 s stuck click kept it busy two more minutes), so frames are skipped while an action runs. */
  async previewFrame<T>(session: string, capture: () => Promise<T>): Promise<T> {
    if (this.gate(session).agents > 0 || this.lanes.held(session)) throw new Error("The browser is busy with an agent action.");
    const phases: Partial<BrowserTiming> = {};
    return this.timed(session, "preview_frame", phases, () => this.agentAction(session, async () => {
      const frame = (this.steps?.recentFrame(session) as T | null | undefined) ?? await capture();
      const png = (frame as { png?: unknown } | null)?.png;
      if (typeof png === "string") phases.chars = png.length;
      return frame;
    }, false));
  }

  /** Every tool result, recovery notes included, is scrubbed of held secrets. */
  async agentRpc(session: string, spec: BrowserSpawnSpec, method: "tools/list" | "tools/call", params: unknown, beforeDispatch?: () => void, ctx?: StepContext): Promise<unknown> {
    if (method === "tools/call" && readsAroundBrowser(params)) return { isError: true, content: [{ type: "text", text: READ_OPEN_PAGE_ONLY }] };
    // Counted in the same event-loop turn, so no idle close can start under a call.
    for (let closing = this.gates.get(session)?.idleClose; closing; closing = this.gates.get(session)?.idleClose) await closing;
    const gate = this.gate(session);
    gate.spec = spec;
    gate.calls++;
    const deadline = Date.now() + this.options.callBudgetMs;
    let result: unknown;
    try {
      const request = () => method === "tools/call" && toolNameOf(params) === BATCH_TOOL
        ? this.agentBatch(session, spec, params, deadline, beforeDispatch, ctx)
        : this.agentRequest(session, spec, method, params, deadline, beforeDispatch, ctx);
      const work = method !== "tools/call" || toolNameOf(params) === BROWSER_RESTART_TOOL || gate.uncertain ? request() : this.lanes.run(session, request, this.options.laneWaitMs, toolNameOf(params) ?? "browser");
      result = await this.withinBudget(session, method, toolNameOf(params) ?? "browser", work, deadline);
    } catch (error) {
      const refusal = method === "tools/call" ? browserRefusal(error) : null;
      if (refusal === null) throw error;
      result = { isError: true, content: [{ type: "text", text: refusal }] };
    } finally { gate.calls--; gate.lastUsed = Date.now(); }
    if (method !== "tools/call") return result;
    if (result === null || result === undefined) return scrubBrowserResult({ isError: true, content: [{ type: "text", text: LANE_BUSY }] }, this.scrub);
    if (gate.personActed && !gate.reopened) {
      gate.personActed = false;
      const content = (result as { content?: unknown } | null)?.content;
      return scrubBrowserResult({ ...result as object, content: [{ type: "text", text: PERSON_ACTED }, ...Array.isArray(content) ? content : []] }, this.scrub);
    }
    gate.personActed = false;
    if (!gate.reopened) return scrubBrowserResult(result, this.scrub);
    const note = gate.reopened === "restart" ? PERSON_RESTARTED : idleClosedNote(spec.env.AGENT_BROWSER_RESTORE_SAVE !== "never");
    gate.reopened = null;
    const content = (result as { content?: unknown } | null)?.content;
    return scrubBrowserResult({ ...result as object, content: [{ type: "text", text: note }, ...Array.isArray(content) ? content : []] }, this.scrub);
  }

  /** Work that outlasts the budget goes on, so its outcome is unknown: the call counts as lost until the engine answers again. */
  private async withinBudget(session: string, method: "tools/list" | "tools/call", call: string, work: Promise<unknown>, deadline: number): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof LATE>((resolve) => { timer = setTimeout(() => resolve(LATE), Math.max(0, deadline - Date.now())); timer.unref(); });
    let outcome: unknown;
    try { outcome = await Promise.race([work, late]); } finally { clearTimeout(timer); }
    if (outcome !== LATE) return outcome;
    if (method !== "tools/call") throw new TransportError("The browser did not answer in time.");
    this.latchLostCall(session, call);
    return this.gate(session).lostCall === null ? stuckBrowserToolError() : lostCallToolError(call);
  }

  private async agentRequest(session: string, spec: BrowserSpawnSpec, method: "tools/list" | "tools/call", params: unknown, deadline: number, beforeDispatch?: () => void, ctx?: StepContext): Promise<unknown> {
    if (method !== "tools/list" && method !== "tools/call") throw new Error("Unsupported browser method.");
    // tools/list skips withAgentAction, so it must refuse the closing window itself or its client outlives restart().
    if (method !== "tools/call" && this.gate(session).closing) throw new Error(BROWSER_CLOSING);
    if (method === "tools/call" && params && typeof params === "object" && (params as { name?: unknown }).name === BROWSER_RESTART_TOOL) {
      beforeDispatch?.();
      await this.agentRestart(session, () => this.closeBrowser(session, spec));
      await this.steps?.note(ctx, { tool: BROWSER_RESTART_TOOL, ok: true });
      beforeDispatch?.();
      return { content: [{ type: "text", text: "Browser restarted. Open pages were closed; open the page you need again and check whether the interrupted action already happened before repeating it." }] };
    }
    // Uncertainty survives client replacement: nothing new reaches the engine until it is resolved.
    const toolName = toolNameOf(params);
    const gate = this.gate(session);
    if (method === "tools/call") await this.heldBack(session, deadline, beforeDispatch);
    if (gate.uncertain) {
      if (method === "tools/list") return withDuskTools(this.toolLists.get(session) ?? { tools: [] });
      const lostCall = gate.lostCall;
      if (lostCall === null) return stuckBrowserToolError();
      beforeDispatch?.();
      const url = await this.recoverAfterLoss(session, spec);
      beforeDispatch?.();
      if (gate.owner !== null) throw this.taken(session);
      return url === null ? stillBusyToolError(lostCall) : recoveredResult(lostCall, url);
    }
    const followUpMs = () => Math.min(this.options.requestTimeoutMs, deadline - Date.now());
    const phases: Partial<BrowserTiming> = {};
    const invoke = async () => {
      const launchStarted = performance.now();
      let dispatched = false;
      if (method === "tools/call") await this.launchReady(spec);
      const entry = this.connect(session, spec);
      await entry.client.ready;
      beforeDispatch?.();
      if (method === "tools/call" && this.gate(session).owner !== null) throw this.taken(session);
      if (method === "tools/call" && await this.pageSizes.beforeCall(session)) {
        beforeDispatch?.();
        if (this.gate(session).owner !== null) throw this.taken(session);
      }
      if (method === "tools/call" && this.launch && toolName !== "agent_browser_close") {
        await this.launched(session, spec);
        beforeDispatch?.();
        if (this.gate(session).owner !== null) throw this.taken(session);
      }
      phases.launchMs = performance.now() - launchStarted;
      try {
        if (method === "tools/call" && ctx && toolName !== undefined) {
          await this.threadTabs.front(session, ctx, toolName, (name, args) => entry.client.rpc("tools/call", { name, arguments: args }, Math.max(1, Math.min(followUpMs(), 10_000))));
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw this.taken(session);
        }
        const pageUrl = () => entry.client.rpc("tools/call", { name: "agent_browser_get_url", arguments: {} }, Math.max(1, Math.min(followUpMs(), 5_000)))
          .then((result) => firstText(result).trim(), (error: unknown) => { if (error instanceof TransportError) throw error; return ""; });
        const heldNote = this.holds.note(session);
        if (toolName === "agent_browser_eval" && await this.holds.refuses(session, pageUrl)) return { isError: true, content: [{ type: "text", text: heldNote ?? SECRET_ON_PAGE }] };
        // Launch and session parameters Metal owns never reach the engine from a call.
        const stripped = method === "tools/call" ? stripHarnessOwnedArguments(params) : params;
        const labelled = toolName === "agent_browser_tab_new" && ctx
          ? { ...stripped as object, arguments: this.threadTabs.labelNewTab(ctx.threadId, ((stripped as { arguments?: Record<string, unknown> }).arguments) ?? {}) } : stripped;
        const request = method === "tools/call" ? this.pageSizes.callArguments(session, ctx ? this.threadTabs.refs.carry(session, ctx.threadId, labelled) : labelled) : params;
        const args = (request as { arguments?: unknown } | null)?.arguments;
        const call: StepCall | null = this.steps && method === "tools/call" && toolName !== undefined ? {
          session, spec, tool: toolName, args: args && typeof args === "object" ? args as Record<string, unknown> : {}, ctx,
          stopped: () => gate.owner !== null || gate.uncertain || gate.closing,
          alive: () => { try { beforeDispatch?.(); return true; } catch { return false; } },
          resize: () => this.pageSizes.again(session),
        } : null;
        const stepsStarted = performance.now();
        const stepState = call ? await this.steps!.before(call) : null;
        phases.stepsMs = performance.now() - stepsStarted;
        // Read with eval, not a snapshot: agent-browser's snapshot renumbers every @eN ref the model holds.
        const observePage = async (): Promise<PageState | null> => {
          if (followUpMs() <= 0) return null;
          const observeStarted = performance.now();
          try {
            return parsePageState(await entry.client.rpc("tools/call", {
              name: "agent_browser_eval", arguments: { script: OBSERVE_PAGE_SCRIPT, timeoutMs: 5_000 },
            }, followUpMs()));
          } catch (error) {
            if (error instanceof TransportError) throw error;
            return null;
          } finally {
            phases.observeMs = (phases.observeMs ?? 0) + performance.now() - observeStarted;
          }
        };
        let before: PageState | null = null;
        if (method === "tools/call" && toolName !== undefined && PAGE_ACTIONS.has(toolName)) {
          before = await observePage();
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw this.taken(session);
        }
        let settled: string | null = null;
        if (method === "tools/call" && toolName !== undefined && SETTLED_READS.has(toolName)) {
          settled = await this.settle(entry.client, gate, deadline, false);
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw this.taken(session);
        }
        const engineStarted = performance.now();
        if (method === "tools/call") { dispatched = true; gate.dispatched++; }
        const engineTimeoutMs = Math.max(1, Math.min(this.options.requestTimeoutMs, deadline - Date.now() - this.options.followUpReserveMs));
        const relayed = method === "tools/call" && toolName !== undefined ? RELAYED_TOOLS.get(toolName) : undefined;
        const inLines = method === "tools/call" && toolName !== undefined ? agentBrowserTypeInLines(toolName, args) : null;
        const engineEnd = Date.now() + engineTimeoutMs;
        let result = relayed
          ? await this.relayTool(session, spec, relayed, args, engineTimeoutMs)
          : inLines
            ? await runAgentBrowserTypeInLines(inLines, (step) => {
              beforeDispatch?.();
              if (this.gate(session).owner !== null) throw this.taken(session);
              return entry.client.rpc("tools/call", { ...request as object, name: step.name, arguments: step.arguments }, Math.max(1, engineEnd - Date.now()));
            })
            : await entry.client.rpc(method, request, engineTimeoutMs);
        phases.engineMs = performance.now() - engineStarted;
        beforeDispatch?.();
        if (method === "tools/list") {
          const tools = withDuskTools(slimBrowserToolList(result));
          this.toolLists.set(session, tools);
          return tools;
        }
        if (before && result && typeof result === "object" && (result as { isError?: boolean }).isError !== true &&
            this.gate(session).owner === null) {
          const after = await observePage();
          beforeDispatch?.();
          if (after) {
            const action = result as { content?: unknown[] };
            const change = { type: "text", text: describePageChange(before, after) };
            result = { ...action, content: [...(Array.isArray(action.content) ? action.content : []), change] };
          }
        }
        if (toolName === "agent_browser_open" && result && typeof result === "object" &&
            (result as { isError?: boolean }).isError !== true) {
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw this.taken(session);
          settled = await this.settle(entry.client, gate, deadline, true);
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw this.taken(session);
          let observation: unknown;
          const observeStarted = performance.now();
          try {
            observation = followUpMs() <= 0 ? { isError: true, content: [] } : await entry.client.rpc("tools/call", {
              name: "agent_browser_snapshot", arguments: { compact: true },
            }, followUpMs());
          } catch (error) {
            if (error instanceof TransportError) throw error;
            observation = { isError: true, content: [] };
          } finally {
            phases.observeMs = (phases.observeMs ?? 0) + performance.now() - observeStarted;
          }
          beforeDispatch?.();
          const navigation = result as { content?: unknown[]; structuredContent?: unknown };
          const page = observation as { content?: unknown[]; isError?: boolean } | null;
          const observed = page?.isError !== true && Array.isArray(page?.content) && page.content.some((item) =>
            item && typeof item === "object" && (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string" && (item as { text: string }).text.trim().length > 0);
          result = {
            content: [
              ...(Array.isArray(navigation.content) ? navigation.content : []),
              { type: "text", text: !observed
                ? "Navigation returned, but page verification failed. Do not claim the requested page loaded and do not blindly repeat navigation."
                : "Page observed after navigation. Its refs are current, so act on them without another snapshot. Check this result for redirects, sign-in requirements or page errors before reporting task success:" },
              ...(Array.isArray(page?.content) ? page.content : []),
            ],
            ...(navigation.structuredContent !== undefined ? { structuredContent: navigation.structuredContent } : {}),
            ...(!observed ? { isError: true } : {}),
          };
        }
        if (ctx && toolName !== undefined) this.threadTabs.refs.saw(session, ctx.threadId, toolName, args, result);
        const afterStarted = performance.now();
        const extra = call && stepState ? await this.steps!.after(call, result, stepState, phases.engineMs) : null;
        phases.stepsMs = (phases.stepsMs ?? 0) + performance.now() - afterStarted;
        beforeDispatch?.();
        const shaped = shapeBrowserToolResult(result, { toolName, budget: this.options.resultBudget }) as { content?: unknown[] };
        const withSteps = extra?.parts.length && Array.isArray(shaped?.content) ? { ...shaped, content: [...shaped.content, ...extra.parts] } : shaped;
        const final = settled && Array.isArray(withSteps?.content) && (withSteps as { isError?: unknown }).isError !== true
          ? { ...withSteps, content: [{ type: "text", text: settled }, ...withSteps.content] } : withSteps;
        phases.chars = resultChars(final);
        return final;
      }
      catch (error) {
        // An MCP timeout cannot prove the daemon stopped an accepted action, so nothing reaches the engine until it answers or a restart.
        if (method === "tools/call" && error instanceof TransportError) {
          this.latchLostCall(session, toolName ?? method);
          if (gate.lostCall !== null && toolName) gate.lostCall = toolName;
        }
        throw error;
      }
      finally { if (dispatched) gate.dispatched--; }
    };
    if (method !== "tools/call") return invoke();
    try {
      return await this.timed(session, toolName ?? "unknown", phases, () => this.withAgentAction(session, invoke));
    } catch (error) {
      if ((gate.closing && gate.owner !== null) || gate.reopened === "restart") {
        if (gate.reopened === "restart") gate.reopened = null;
        return { isError: true, content: [{ type: "text", text: PERSON_RESTART_STOPPED }] };
      }
      if (error instanceof Error && error.message === BROWSER_INTERRUPTED) return stuckBrowserToolError();
      if (error instanceof TransportError && gate.uncertain && gate.lostCall !== null) return lostCallToolError(toolName ?? gate.lostCall);
      throw error;
    }
  }

  /** One lane hold for the whole batch; each step goes through agentRequest exactly as a single call would. */
  private async agentBatch(session: string, spec: BrowserSpawnSpec, params: unknown, deadline: number, beforeDispatch?: () => void, ctx?: StepContext): Promise<unknown> {
    const gate = this.gate(session);
    if (gate.uncertain) return this.agentRequest(session, spec, "tools/call", params, deadline, beforeDispatch, ctx);
    await this.heldBack(session, deadline, beforeDispatch);
    const tools = this.toolLists.get(session) ?? await this.agentRequest(session, spec, "tools/list", {}, deadline);
    const plan = planAgentBrowserBatch((params as { arguments?: unknown } | null)?.arguments, tools);
    if (!plan.ok) return { isError: true, content: [{ type: "text", text: plan.error }] };
    const call = async ({ name, arguments: args }: AgentBrowserCall): Promise<ToolResult> =>
      asToolResult(await this.agentRequest(session, spec, "tools/call", { name, arguments: args }, deadline, beforeDispatch, ctx));
    return runSteps<AgentBrowserCall>(plan.steps, {
      deadline: Math.min(deadline, Date.now() + plan.limitMs),
      limitMs: plan.limitMs,
      parse: (step) => agentBrowserStep(step, tools),
      execute: call,
      failure: (error) => {
        if (error instanceof TransportError) return null;
        try { beforeDispatch?.(); } catch { return null; }
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      },
      pageAfter: () => (gate.uncertain || gate.owner !== null ? Promise.resolve(null) : call({ name: "agent_browser_snapshot", arguments: {} })),
      ...(beforeDispatch ? { checkpoint: beforeDispatch } : {}),
    });
  }

  /** Reads the page with eval, never a snapshot, so the bot's refs stay valid. */
  private async settle(client: BrowserClient, gate: Gate, deadline: number, fresh: boolean): Promise<string | null> {
    const rpcMs = () => Math.max(1, Math.min(this.options.requestTimeoutMs, deadline - Date.now()));
    const reader: PageReader = {
      probe: async () => {
        try {
          return probeOfEval(await client.rpc("tools/call", { name: "agent_browser_eval", arguments: { script: PROBE_SCRIPT, timeoutMs: 5_000 } }, rpcMs()));
        } catch (error) {
          if (error instanceof TransportError) throw error;
          return null;
        }
      },
      frameUrls: () => [],
      loaded: async (timeoutMs) => {
        await client.rpc("tools/call", { name: "agent_browser_wait_for_load", arguments: { state: "load", waitTimeoutMs: Math.max(1, timeoutMs) } }, rpcMs());
      },
      stopped: () => gate.owner !== null || gate.uncertain || gate.closing,
    };
    let cleared = clearedChecks.get(gate);
    if (!cleared) clearedChecks.set(gate, cleared = new Set());
    return settleNote(await settlePage(reader, { deadline: deadline - 2 * this.options.followUpReserveMs, fresh, cleared }));
  }

  private async relayTool(session: string, spec: BrowserSpawnSpec, tool: RelayedToolSpec, args: unknown, timeoutMs: number): Promise<unknown> {
    const action = tool.name.replace("agent_browser_", "");
    const given = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const fields = Object.keys(tool.inputSchema.properties).filter((field) => field in given);
    const command = Object.fromEntries([["action", action], ...fields.map((field) => [field, given[field]])]);
    try {
      if (!this.relayCommand) throw new Error(`This browser cannot ${action} here.`);
      const answer = await this.relayCommand(spec, session, command, timeoutMs);
      if (!answer.success) return { isError: true, content: [{ type: "text", text: answer.error ?? `The browser could not ${action} that element.` }] };
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: answer.data }) }] };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  }

  private connect(session: string, spec: BrowserSpawnSpec): ClientEntry {
    const key = launchSettingsKey(spec);
    const existing = this.clients.get(session);
    if (existing && existing.key !== key) throw new Error(LAUNCH_CHANGED);
    if (existing) return existing;
    const client = new BrowserClient(spec, this.options.requestTimeoutMs, this.options.idleMs, this.options.maxPending, () => {
      if (this.clients.get(session)?.client === client) this.clients.delete(session);
    }, (params) => this.latchLostCall(session, toolNameOf(params) ?? "browser"));
    const entry: ClientEntry = { key, client };
    this.clients.set(session, entry);
    this.pageSizes.forget(session);
    return entry;
  }

  private latchLostCall(session: string, call: string): void {
    const gate = this.gate(session);
    if (gate.closing || gate.uncertain) return;
    gate.uncertain = true;
    gate.lostCall = call;
  }

  /** agent-browser runs one command per session even across connections (0.37.0), so a read that answers proves the lost call
   * ended; it is never replayed. Resolves to the page URL, or null while the engine still does not answer. */
  private recoverAfterLoss(session: string, spec: BrowserSpawnSpec): Promise<string | null> {
    let check = this.recoveries.get(session);
    if (!check) {
      check = this.checkEngine(session, spec).finally(() => this.recoveries.delete(session));
      this.recoveries.set(session, check);
    }
    return check;
  }

  private async checkEngine(session: string, spec: BrowserSpawnSpec): Promise<string | null> {
    const gate = this.gate(session);
    gate.agents++;
    gate.probes++;
    try {
      const { client } = this.connect(session, spec);
      await client.ready;
      const result = await client.rpc("tools/call", { name: "agent_browser_get_url", arguments: {} }, this.options.recoveryCheckMs);
      if (gate.closing || !gate.uncertain || gate.lostCall === null) return null;
      gate.uncertain = false;
      gate.lostCall = null;
      return firstText(result).trim().slice(0, 500);
    } catch {
      return null;
    } finally {
      gate.agents--;
      gate.probes--;
      this.changed(gate);
    }
  }

  /** True when the grant waited for a bot command the engine received: the page may have changed since the person aimed. A bot
   * call that never answered is checked once with the engine: if it answers, that call has ended and the person may take over. */
  async take(session: string, owner: string): Promise<boolean> {
    if (!owner) throw new Error("Browser control requires an owner.");
    const gate = this.gate(session);
    if (gate.closing || gate.releasing) throw new Error("Browser control is changing. Try again shortly.");
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner; // synchronous: no agent work slips in while draining
    gate.ready = false;
    this.steps?.personTook(session);
    const waited = gate.dispatched > 0;
    const stillRunning = "A browser action may still be running. Restart this browser before taking control.";
    await new Promise<void>((resolve, reject) => {
      let probe: "none" | "running" | "done" = "none";
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        gate.changed.delete(check);
        if (error) reject(error);
        else { gate.ready = true; resolve(); }
      };
      const check = () => {
        if (gate.owner !== owner || gate.releasing || gate.closing) finish(new Error("Browser control request was cancelled."));
        else if (gate.uncertain && probe === "none" && gate.lostCall !== null && gate.spec) {
          probe = "running";
          void this.recoverAfterLoss(session, gate.spec).finally(() => { probe = "done"; check(); });
        } else if (gate.uncertain) { if (probe !== "running") finish(new Error(stillRunning)); }
        else if (gate.agents === 0) finish();
      };
      const timer = setTimeout(() => finish(new Error(gate.uncertain ? stillRunning : "Browser action is still finishing. Control remains paused; retry taking control or hand it back.")), this.options.takeoverTimeoutMs);
      timer.unref();
      gate.changed.add(check);
      check();
    });
    return waited;
  }

  canControl(session: string, owner: string): boolean {
    const gate = this.gates.get(session);
    return Boolean(owner && gate?.owner === owner && gate.ready && !gate.releasing && !gate.closing && !gate.uncertain && gate.agents === 0);
  }

  heldBy(session: string): string | null { return this.gates.get(session)?.owner ?? null; }

  /** An interrupted action left the browser's state unknown until the engine answers again or the browser restarts. */
  interrupted(session: string): boolean { return this.gates.get(session)?.uncertain === true; }

  interruptedCount(): number { return [...this.gates.values()].filter((gate) => gate.uncertain).length; }

  /** A disconnected viewer may leave a key or button pressed; an agent must never inherit that input state. */
  abandonHumanInput(session: string, owner: string): void {
    const gate = this.gates.get(session);
    if (!owner || !gate || gate.owner !== owner) return;
    gate.uncertain = true;
    gate.lostCall = null;
    gate.ready = false;
    this.changed(gate);
  }

  release(session: string, owner: string): void {
    const gate = this.gates.get(session);
    if (!owner || !gate || gate.owner !== owner) return;
    gate.ready = false;
    gate.releasing = true;
    gate.lastUsed = Date.now();
    this.changed(gate); // don't admit agents until pending human input drains.
  }

  async withHumanAction<T>(session: string, owner: string, fn: () => Promise<T>): Promise<T> {
    if (!this.canControl(session, owner)) throw new Error("Take control of this browser before interacting.");
    const gate = this.gate(session);
    gate.humans++;
    try { return await fn(); }
    catch (error) {
      // A failed accepted command may still be running in the daemon; hand-back must not race its completion.
      if (!isSettledBrowserFailure(error)) {
        gate.uncertain = true;
        gate.lostCall = null;
        gate.ready = false;
      }
      throw error;
    }
    finally { gate.humans--; gate.lastUsed = Date.now(); this.changed(gate); }
  }

  /**
   * A person's input beside the bot, from the Computer tab's view: it takes no hold and never pauses or refuses the bot's
   * tools. The engine runs one command at a time, so it lands between the bot's own; the later of two wins. Refused only
   * while someone holds the browser, it is closing, or an interrupted action left it unknown.
   */
  async withSharedInput<T>(session: string, acted: boolean, fn: () => Promise<T>): Promise<T> {
    const gate = this.gate(session);
    if (gate.owner !== null) throw new Error("Another person controls this browser.");
    if (gate.closing) throw new Error(BROWSER_CLOSING);
    if (gate.uncertain) throw new Error(BROWSER_INTERRUPTED);
    if (acted) { gate.personActed = true; this.steps?.personTook(session); }
    gate.lastUsed = Date.now();
    try { return await fn(); } finally { gate.lastUsed = Date.now(); }
  }

  /** The person typed on `url` beside the bot: page scripts there are refused for a while, as after a saved password. */
  personTyped(session: string, url: string): void {
    this.holds.personTyped(session, url, PERSON_TYPED_ON_PAGE);
  }

  /** A person opened a view, which counts as use; call the returned function when it closes. */
  watch(session: string, spec: { command: string; args?: readonly string[]; env?: Record<string, string | undefined> }): () => void {
    const gate = this.gate(session);
    gate.watchers++;
    gate.lastUsed = Date.now();
    gate.spec = { command: spec.command, args: [...spec.args ?? []], env: { ...spec.env } };
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      gate.watchers--;
    };
  }

  async settled(session: string): Promise<void> { await this.gates.get(session)?.idleClose; }

  /** A bot call, a person's action or hold, or a close is under way in this session's browser. */
  working(session: string): boolean {
    const gate = this.gates.get(session);
    return Boolean(gate && (gate.calls || gate.agents || gate.humans || gate.owner !== null || gate.closing || gate.releasing || this.lanes.held(session)));
  }

  /** Told just before an idle close stops a session's browser. */
  onIdleClose(listener: (session: string) => void): void { this.idleCloseListeners.add(listener); }

  launchReady(spec: LaunchSpec): Promise<void> { return this.launch?.ready(spec) ?? Promise.resolve(); }

  /** A browser without its identity still browses, so a failure here never fails the call. */
  launched(session: string, spec: LaunchSpec): Promise<void> { return this.launch?.started(session, spec).catch(() => undefined) ?? Promise.resolve(); }

  /** The same barrier as a restart. Saved sign-ins stay, and a browser attached to the person's own Chrome is never closed. */
  /** Closes a finished conversation's tabs; the caller checks the browser still runs. Kept while a person watches or holds it. */
  async closeThreadTabs(session: string, threadId: string): Promise<{ outcome: "closed" | "kept" | "none"; tabs: ClosedThreadTab[] }> {
    const gate = this.gates.get(session);
    const spec = gate?.spec;
    if (!gate || !spec || gate.closing || gate.uncertain || gate.idleClose) return { outcome: "none", tabs: [] };
    if (gate.owner !== null || gate.watchers > 0) return { outcome: "kept", tabs: [] };
    // The bot's tool client stops soon after its last call; the browser it drove runs on, so a new client reaches it.
    const outcome = await this.lanes.run(session, async () => {
      const entry = this.connect(session, spec);
      await entry.client.ready;
      return this.threadTabs.close(session, threadId, (name, args) => entry.client.rpc("tools/call", { name, arguments: args }, 10_000));
    }, this.options.laneWaitMs, "close_thread_tabs").catch(() => null);
    if (outcome === null) return { outcome: "kept", tabs: [] };
    return { outcome: outcome.closed.length > 0 ? "closed" : "none", tabs: outcome.closed };
  }

  async closeIfIdle(session: string, idleMs: number, spec?: { command: string; args?: readonly string[]; env: Record<string, string | undefined> }): Promise<boolean> {
    const gate = spec ? this.gate(session) : this.gates.get(session);
    if (gate && !gate.spec && spec) gate.spec = { command: spec.command, args: [...spec.args ?? []], env: { ...spec.env } };
    const launch = gate?.spec;
    if (!gate || !launch || attachesToChrome(launch.env) || !(idleMs > 0) || Date.now() - gate.lastUsed < idleMs) return false;
    if (this.working(session)) return false;
    gate.closing = true;
    gate.ready = false;
    let finished!: () => void;
    gate.idleClose = new Promise((resolve) => { finished = resolve; });
    this.changed(gate);
    try {
      for (const listener of this.idleCloseListeners) listener(session);
      if (!await this.closeBrowser(session, launch)) return false;
      this.steps?.forget(session);
      this.threadTabs.forget(session);
      this.launch?.stopped(session);
      await this.clients.get(session)?.client.stop();
      await this.clients.get(session)?.client.stop();
      gate.uncertain = false;
      gate.lostCall = null;
      gate.reopened = "idle";
      return true;
    } catch {
      return false;
    } finally {
      gate.closing = false;
      gate.idleClose = undefined;
      finished();
      this.changed(gate);
    }
  }

  /** A person's restart comes before a bot's call: one in flight is ended by the close and answers that the person restarted.
   * Never admits human input; a successful native close is its safety barrier. */
  async restart(session: string, owner: string, closeBrowser: () => Promise<void>): Promise<void> {
    if (!owner) throw new Error("Browser recovery requires an owner.");
    const gate = this.gate(session);
    if (gate.closing || gate.releasing || gate.humans) throw new Error(RESTART_BUSY);
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner;
    gate.ready = false;
    gate.closing = true;
    this.changed(gate);
    try {
      await closeBrowser();
      this.steps?.forget(session);
      this.threadTabs.forget(session);
      this.launch?.stopped(session);
      await this.clients.get(session)?.client.stop();
      // A tools/list admitted before closing can register a client during this stop; registration is synchronous, so one re-check suffices.
      await this.clients.get(session)?.client.stop();
      gate.uncertain = false;
      gate.lostCall = null;
      gate.owner = null;
      gate.releasing = false;
      gate.reopened = "restart";
    } catch (error) {
      gate.owner = owner;
      gate.uncertain = true;
      gate.lostCall = null;
      throw error;
    } finally {
      gate.closing = false;
      this.changed(gate);
    }
  }

  /** Never takes a person's hold, and a failed close leaves no owner behind to lock a person out. */
  async agentRestart(session: string, closeBrowser: () => Promise<boolean>): Promise<void> {
    const gate = this.gate(session);
    if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    if (gate.closing || gate.releasing || gate.agents || gate.humans) throw new Error(RESTART_BUSY);
    gate.ready = false;
    gate.closing = true;
    this.changed(gate);
    try {
      if (!await closeBrowser()) throw new Error(AGENT_CLOSE_FAILED);
      this.steps?.forget(session);
      this.threadTabs.forget(session);
      this.launch?.stopped(session);
      await this.clients.get(session)?.client.stop();
      await this.clients.get(session)?.client.stop();
      gate.uncertain = false;
      gate.lostCall = null;
    } catch (error) {
      gate.uncertain = true;
      gate.lostCall = null;
      throw error;
    } finally {
      gate.closing = false;
      this.changed(gate);
    }
  }

  /** Call after the browser is closed; closes the MCP transport, not saved logins or profile files. */
  async close(session: string): Promise<void> {
    this.holds.drop(session);
    const gate = this.gate(session);
    gate.closing = true;
    gate.ready = false;
    this.steps?.forget(session);
    this.threadTabs.forget(session);
    this.launch?.stopped(session);
    // Clear before the awaited stop: any uncertain latch after this point must win.
    gate.uncertain = false;
    gate.lostCall = null;
    this.changed(gate);
    await this.clients.get(session)?.client.stop();
    gate.closing = false;
    this.changed(gate);
    if (!gate.owner && !gate.agents && !gate.humans && !gate.watchers && !gate.calls) { this.gates.delete(session); this.toolLists.delete(session); }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.clients.keys(), ...this.gates.keys(), ...this.holds.sessions()])].map((session) => this.close(session)));
  }
}

function withDuskTools(result: unknown): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) return result;
  const own = [...RELAYED_TOOL_SPECS, AGENT_BROWSER_BATCH_SPEC, BROWSER_RESTART_TOOL_SPEC];
  const tools = ((result as { tools: unknown[] }).tools).filter((tool) => !own.some((spec) => spec.name === (tool as { name?: unknown } | null)?.name));
  return { ...result, tools: [...tools, ...own] };
}
