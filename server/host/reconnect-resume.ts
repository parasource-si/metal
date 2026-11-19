// A one-on-one turn that stopped because an app needs reconnecting is carried on by itself once the person reconnects it:
// the person should never have to type "reconnected". A turn waits on an app when a tool call came back refused for its
// sign-in ("reconnect Notion in Connect apps"), or when its last words say the app needs reconnecting while the app's
// sign-in is in fact one to redo. Each wait carries on once, within a day, and only while the chat is idle.
import type { RuntimeEvent } from "../contracts.ts";

export const RECONNECT_WAIT_MS = 24 * 60 * 60_000;
const START_DELAY_MS = 400;
const REFUSED = /reconnect (.{1,80}?) in Connect apps/giu;

/** An app the bot's servers include whose sign-in is one to redo: its server's name and the name a person reads. */
export interface NeedsReconnect { server: string; label: string }

export interface ReconnectResumeDeps {
  /** The bot of a one-on-one chat this may carry on, or null. */
  botOf(threadId: string): string | null;
  /** The bot's apps whose sign-in has to be redone right now. */
  needing(botId: string): readonly NeedsReconnect[];
  /** Something waits on the person, a message of theirs is queued, or the chat is busy. */
  held(threadId: string): boolean;
  /** Starts the next turn with a note only the bot reads. */
  carryOn(botId: string, threadId: string, note: string): Promise<unknown>;
  /** The quiet line the person sees, "Reconnected, carrying on". */
  line(threadId: string): void;
  now?(): number;
  later?: (run: () => void, ms: number) => void;
}

/** The app names a tool's refusal asks the person to reconnect. */
export function refusedApps(output: string): string[] {
  return [...output.matchAll(REFUSED)].map((match) => match[1]!.trim().toLowerCase());
}

export function reconnectNote(labels: readonly string[]): string {
  return `[Metal: the person reconnected ${labels.join(" and ")}, so ${labels.length === 1 ? "its" : "their"} tools work again. Carry on with the task that stopped for it, from where it stopped, without asking them to reconnect or repeating what you already said.]`;
}

interface Turn { refused: Set<string>; text: string }
interface Wait { botId: string; servers: Map<string, string>; at: number }

export function createReconnectResume(deps: ReconnectResumeDeps) {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  const turns = new Map<string, Turn>();
  const waits = new Map<string, Wait>();
  /** Threads whose next turn is the carry-on this started, so its start keeps nothing else. */
  const ours = new Set<string>();

  function settle(threadId: string, turn: Turn): void {
    const botId = deps.botOf(threadId);
    if (!botId) return;
    const said = turn.text.toLowerCase();
    const mentions = /reconnect/u.test(said);
    if (!turn.refused.size && !mentions) return;
    const servers = new Map<string, string>();
    for (const app of deps.needing(botId)) {
      const label = app.label.toLowerCase();
      if (turn.refused.has(label) || (mentions && said.includes(label))) servers.set(app.server, app.label);
    }
    if (servers.size) waits.set(threadId, { botId, servers, at: now() });
  }

  return {
    onEvent(event: RuntimeEvent): void {
      const { threadId } = event;
      if (event.type === "turn.started") {
        // the person wrote again (or anything else started): the chat moved on from the wait
        if (ours.has(threadId)) ours.delete(threadId);
        else waits.delete(threadId);
        turns.set(threadId, { refused: new Set(), text: "" });
        return;
      }
      const turn = turns.get(threadId);
      if (!turn) return;
      if (event.type === "item.completed" && event.itemType === "tool" && event.output) {
        for (const app of refusedApps(event.output)) turn.refused.add(app);
      } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
        turn.text = event.text;
      } else if (event.type === "turn.completed" || event.type === "session.exited") {
        turns.delete(threadId);
        if (event.type === "turn.completed" && (event.stopReason === "cancelled" || event.stopReason === "interrupted")) return;
        settle(threadId, turn);
      }
    },

    /** The person finished reconnecting this server: every chat waiting on it carries on, once. */
    reconnected(server: string): void {
      for (const [threadId, wait] of waits) {
        if (!wait.servers.has(server)) continue;
        waits.delete(threadId);
        if (now() - wait.at > RECONNECT_WAIT_MS) continue;
        const labels = [...wait.servers.values()];
        later(() => {
          if (deps.held(threadId) || deps.botOf(threadId) !== wait.botId) return;
          ours.add(threadId);
          deps.line(threadId);
          deps.carryOn(wait.botId, threadId, reconnectNote(labels)).catch(() => ours.delete(threadId));
        }, START_DELAY_MS);
      }
    },

    /** The chats waiting on a reconnect, for tests and diagnostics. */
    waiting(): string[] {
      return [...waits.keys()];
    },
  };
}

export type ReconnectResume = ReturnType<typeof createReconnectResume>;
