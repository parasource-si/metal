// A one-on-one turn that ends with its checklist still open is carried on by itself with the rest of the list, as long
// as each turn closes at least one item: an engine's step limit, a long run that ended early, or a bot that stopped to
// ask whether to go on never leaves 84 of 94 people unmessaged. A paused list (a site's rate limit) waits out the pause
// first. The person's Stop, a sign-in or setup the engine needs, a turn waiting on the person and a turn that closed
// nothing all leave it alone.
import type { RuntimeEvent } from "../contracts.ts";
import { closed, counts, openItems, progressLine, type Checklist } from "../batch-checklist.ts";

/** Each carry-on has closed at least one item, so a list ends; this bounds a list whose items keep coming back. */
export const MAX_BATCH_CONTINUES = 200;
export const MAX_PAUSES_IN_A_ROW = 6;
const NOTE_ITEMS_MAX = 40;
const START_DELAY_MS = 400;
const NO_CARRY_ON = new Set(["cancelled", "interrupted", "auth_required", "setup_required"]);

export type BatchLine = { kind: "continuing" | "paused"; progress: string; minutes?: number };

export interface BatchContinueDeps {
  /** The bot of a one-on-one chat this may carry on, or null. */
  botOf(threadId: string): string | null;
  read(botId: string, threadId: string): Checklist | null;
  /** Something waits on the person, a message of theirs is queued, or the thread is busy again. */
  held(threadId: string): boolean;
  /** The turn that just ended was refused by its AI's usage limit: the wait for the reset carries the list on. */
  limited?(threadId: string, turnId?: string): boolean;
  carryOn(botId: string, threadId: string, note: string): Promise<unknown>;
  /** The quiet line the person sees: "12 of 94 sent, continuing with the rest". */
  line(threadId: string, line: BatchLine): void;
  later?: (run: () => void, ms: number) => void;
  now?: () => number;
}

export function batchNote(list: Checklist): string {
  const open = openItems(list);
  const shown = open.slice(0, NOTE_ITEMS_MAX);
  const more = open.length > shown.length ? `; and ${open.length - shown.length} more (checklist status lists them)` : "";
  return `[Metal: your checklist "${list.title}" is not finished: ${progressLine(list)}, ${open.length} still open. This carries on the person's own request for this list and adds no approval for anything else. Work through the open items now, in order, ticking each with the checklist tool right after it is finished. Every ticked item is done: never repeat it. Open: ${shown.join("; ")}${more}. If a site rate-limits you, call checklist pause. If only the person can unblock you (signed out, the site blocks you), say exactly what you need in one line and stop.]`;
}

interface Thread { botId: string; closedAtStart: number; ours: boolean; continues: number; pauses: number; pausedUntil: number }

export function createBatchContinue(deps: BatchContinueDeps) {
  const later = deps.later ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  const now = deps.now ?? Date.now;
  const threads = new Map<string, Thread>();
  const pauses = new Map<string, number>();

  const openList = (botId: string, threadId: string): Checklist | null => {
    const list = deps.read(botId, threadId);
    return list && counts(list).open > 0 ? list : null;
  };

  return {
    /** The list is open and this guard carries it: the finish guard leaves the thread to it. */
    active(threadId: string): boolean {
      const botId = deps.botOf(threadId);
      return botId !== null && openList(botId, threadId) !== null;
    },

    pause(threadId: string, untilMs: number): void {
      pauses.set(threadId, untilMs);
    },

    onEvent(event: RuntimeEvent): void {
      const { threadId } = event;
      if (event.type === "turn.started") {
        const botId = deps.botOf(threadId);
        const previous = threads.get(threadId);
        if (!botId) { threads.delete(threadId); return; }
        const list = deps.read(botId, threadId);
        // a turn the person started begins a new chain; ours keeps counting
        const chain = previous?.ours ? previous : { continues: 0, pauses: 0 };
        threads.set(threadId, { botId, closedAtStart: closed(list), ours: false, continues: chain.continues, pauses: chain.pauses, pausedUntil: 0 });
        pauses.delete(threadId);
        return;
      }
      if (event.type !== "turn.completed" && event.type !== "session.exited") return;
      const state = threads.get(threadId);
      if (!state) return;
      const pausedUntil = pauses.get(threadId) ?? 0;
      pauses.delete(threadId);
      if (event.type === "session.exited" || NO_CARRY_ON.has(event.stopReason ?? "") || (!event.ok && deps.limited?.(threadId, event.turnId))) { threads.delete(threadId); return; }
      const list = openList(state.botId, threadId);
      if (!list) { threads.delete(threadId); return; }
      const progressed = closed(list) > state.closedAtStart;
      const paused = pausedUntil > now();
      if (!progressed && !paused) { threads.delete(threadId); return; }
      if (state.continues >= MAX_BATCH_CONTINUES || (paused && state.pauses >= MAX_PAUSES_IN_A_ROW)) { threads.delete(threadId); return; }
      const wait = paused ? pausedUntil - now() : START_DELAY_MS;
      if (paused) deps.line(threadId, { kind: "paused", progress: progressLine(list), minutes: Math.max(1, Math.round(wait / 60_000)) });
      later(() => {
        if (deps.held(threadId) || threads.get(threadId) !== state) return;
        const current = openList(state.botId, threadId);
        if (!current) { threads.delete(threadId); return; }
        state.ours = true;
        state.continues += 1;
        state.pauses = paused ? state.pauses + 1 : 0;
        deps.line(threadId, { kind: "continuing", progress: progressLine(current) });
        deps.carryOn(state.botId, threadId, batchNote(current)).catch(() => threads.delete(threadId));
      }, wait);
    },
  };
}

export type BatchContinue = ReturnType<typeof createBatchContinue>;
