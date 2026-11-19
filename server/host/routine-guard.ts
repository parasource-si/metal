// Keeps routines from spending on work that cannot pay off: a weekly cap holds a bot's or routine's unattended runs back
// with one notice, three runs failing the same way pause the routine with one alert, and a run whose input has not
// arrived ("Not yet") is checked again with backoff before its next scheduled time instead of reported as failed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RoutinePause } from "../../shared/routines.ts";
import { writeFileAtomic } from "../atomic.ts";
import { outcomesNewestFirst } from "../routine-outcomes.ts";
import type { Routine, RoutineRun } from "../routines.ts";
import { serverLine } from "../server-lines.ts";
import type { CapHit } from "../spend.ts";
import { hostTimeZone } from "../turn-clock.ts";

export const FATIGUE_RUNS = 3;
/** Minutes before each recheck of a run whose input has not arrived; after the last, the regular schedule takes over. */
export const RECHECK_MINUTES = [15, 30, 60, 120, 240] as const;
const NOT_YET = /^\s*\**\s*not yet\b/i;

export const DRY_RUN_REFUSAL = "This is a test run: nothing leaves this computer, so this was not sent or done. " +
  "Write exactly what you would send or do in your reply as a draft instead, then carry on.";

export interface RoutineGuardDeps {
  dataDir: string;
  now?: () => number;
  routine(id: string): Routine | undefined;
  runs(): RoutineRun[];
  pause(id: string): void;
  /** Moves a routine's next run earlier; a time after its next scheduled one changes nothing. */
  recheck(id: string, at: number): void;
  /** One notice the person sees: a line in the chat (the bot's main one by default) and, unless quiet, a notification. */
  tell(botId: string, threadId: string | undefined, text: string, quiet?: boolean): void;
  language(threadId: string | undefined): string | undefined;
  spendOver(botId: string, routineId: string): CapHit | null;
  /** Why no run may start while the account's weekly allowance is used up (server/allowance.ts), or null. */
  allowanceHeld?(run: RoutineRun, language: string | undefined): string | null;
}

export const isNotYet = (output: string | undefined): boolean => Boolean(output && NOT_YET.test(output));


function clock(at: number, language: string | undefined): string {
  const options = { hour: "numeric", minute: "2-digit", timeZone: hostTimeZone() } as const;
  try {
    return new Date(at).toLocaleTimeString(language ?? "en-US", options);
  } catch {
    return new Date(at).toLocaleTimeString("en-US", options);
  }
}

/** The three newest outcomes failed with the same words, none of them a test run. */
export function failedAlike(runs: readonly RoutineRun[], routineId: string): string | null {
  const recent = outcomesNewestFirst(runs.filter((run) => !run.dryRun), routineId).slice(0, FATIGUE_RUNS);
  if (recent.length < FATIGUE_RUNS || recent.some((run) => run.status !== "failed" || !run.error)) return null;
  return recent.every((run) => run.error === recent[0]!.error) ? recent[0]!.error! : null;
}

export function createRoutineGuard(deps: RoutineGuardDeps) {
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, "routine-pauses.json");
  const rechecks = new Map<string, number>();
  const seen = new Set<string>();
  let pauses: Record<string, RoutinePause> = load();

  function load(): Record<string, RoutinePause> {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, RoutinePause>;
      return Object.fromEntries(Object.entries(value).filter(([, pause]) => pause && (pause.by === "cap" || pause.by === "failures")));
    } catch {
      return {};
    }
  }

  function save(): void {
    try {
      writeFileAtomic(file, JSON.stringify(pauses), { mode: 0o600 });
    } catch (error) {
      console.error(`routine-guard: could not save pauses: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function pause(routine: Routine, why: RoutinePause): void {
    if (!routine.enabled) return;
    pauses[routine.id] = why;
    save();
    deps.pause(routine.id);
  }

  const resultsThread = (routine: Routine) => routine.resultsThreadId ?? routine.sourceThreadId;

  return {
    /** Why a run may not start now, or null. Past a cap, a run someone started, or a test, still may. */
    held(run: RoutineRun): string | null {
      // a used-up allowance holds every new run, a person's included: they wait for the reset or a top-up
      const waiting = deps.allowanceHeld?.(run, deps.language(run.resultsThreadId ?? run.sourceThreadId));
      if (waiting) return waiting;
      if (run.manual || run.dryRun || run.target !== "bot") return null;
      const hit = deps.spendOver(run.botId, run.routineId);
      if (!hit) return null;
      const routine = deps.routine(run.routineId);
      if (hit.kind === "routine" && routine) pause(routine, { by: "cap", capUsd: hit.capUsd, at: now() });
      return `Not started: ${hit.kind === "routine" ? "this routine" : "its bot"} reached its weekly cap`;
    },

    capHit(hit: CapHit): void {
      if (hit.kind === "routine") {
        const routine = deps.routine(hit.id);
        if (!routine) return;
        const thread = resultsThread(routine);
        pause(routine, { by: "cap", capUsd: hit.capUsd, at: now() });
        deps.tell(routine.botId, thread, serverLine(deps.language(thread), "server.spend.routineCap", { routine: routine.name }));
        return;
      }
      deps.tell(hit.botId, undefined, serverLine(deps.language(undefined), "server.spend.botCap", { bot: hit.name }));
    },

    /** After a run failed: the third identical failure in a row pauses its routine, with one alert. */
    failed(run: RoutineRun): void {
      if (run.dryRun) return;
      const routine = deps.routine(run.routineId);
      const error = routine?.enabled ? failedAlike(deps.runs(), run.routineId) : null;
      if (!routine || !error) return;
      pause(routine, { by: "failures", error: error.slice(0, 300), at: now() });
      const thread = resultsThread(routine);
      deps.tell(routine.botId, thread, serverLine(deps.language(thread), "server.routine.fatigue", { routine: routine.name, count: FATIGUE_RUNS, error: error.slice(0, 300) }));
    },

    /** A finished run whose input had not arrived is checked again before its next scheduled time, with backoff. */
    changed(run: RoutineRun): void {
      if (run.status !== "completed" || run.dryRun || seen.has(run.id)) return;
      seen.add(run.id);
      if (seen.size > 2_000) seen.delete(seen.values().next().value!);
      const routine = deps.routine(run.routineId);
      if (!routine?.enabled || routine.checks || run.triggerSource === "webhook") return;
      if (!isNotYet(run.output)) {
        rechecks.delete(routine.id);
        return;
      }
      const tries = rechecks.get(routine.id) ?? 0;
      const minutes = RECHECK_MINUTES[tries];
      if (minutes === undefined) {
        rechecks.delete(routine.id);
        return;
      }
      const at = now() + minutes * 60_000;
      if (routine.nextRunAt !== null && routine.nextRunAt <= at) return;
      rechecks.set(routine.id, tries + 1);
      deps.recheck(routine.id, at);
      const language = deps.language(run.threadId);
      deps.tell(routine.botId, run.threadId, serverLine(language, "server.routine.recheck", { time: clock(at, language) }), true);
    },

    /** Why Metal paused it, on the routine a client reads; nothing once it is back on. */
    pausedFor(routine: Pick<Routine, "id" | "enabled">): { pausedFor: RoutinePause } | Record<string, never> {
      const why = pauses[routine.id];
      if (why && routine.enabled) {
        delete pauses[routine.id];
        save();
        return {};
      }
      return why ? { pausedFor: why } : {};
    },

    /** One notice the person sees (see RoutineGuardDeps.tell). */
    tell: deps.tell,

    dryRun(run: RoutineRun | null): boolean {
      return run?.dryRun === true && (run.status === "running" || run.status === "waiting");
    },
  };
}

export type RoutineGuard = ReturnType<typeof createRoutineGuard>;
