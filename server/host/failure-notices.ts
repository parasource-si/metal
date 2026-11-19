// A failed run is the person's to hear about: one notification, never a Chief's thread or turn. A run stopped to free
// memory starts once more by itself first. A Chief's retry_thread resumes a teammate's stopped thread here too.
import { memoryStopped } from "../engine-memory.ts";
import { IncidentLedger, incidentChip, RETRY_BLOCKED, RETRY_LEAD, type Incident, type IncidentKind } from "../incidents.ts";
import { buildNotification, type Notification } from "../notify.ts";
import { quoteInNote } from "../peer-provenance.ts";
import { peerName } from "../peer-roster.ts";
import { redactSecretsInText } from "../redact.ts";
import type { BotRecord, Message, Store } from "../store.ts";

type PeerAsk = NonNullable<Message["peerAsk"]>;

export interface FailureNoticeDeps {
  store: Pick<Store, "bot" | "taskByThread" | "groupByThread" | "activePath">;
  assignerOf(threadId: string): unknown;
  notify(notification: Notification | null): void;
  threadBusy(botId: string, threadId: string): boolean;
  startTurn(botId: string, text: string, opts: { threadId: string; unattended?: boolean; peerAsk: PeerAsk }): Promise<unknown>;
  /** The thread's last run has ended but is still shutting down. */
  threadSettling?(threadId: string): boolean;
  /** The thread waits for a free slot and starts on its own. */
  threadQueued?(botId: string, threadId: string): boolean;
  /** Starts this thread's request again where it stopped: a continuation of the request the harness recorded, never a line
   * of the person's. Absent: a run stopped for memory is only reported. */
  continueRequest?(botId: string, threadId: string, text: string): Promise<unknown>;
  /** Runs a retry after a run stopped for memory, MEMORY_RETRY_MS later by default, so the machine settles first. */
  later?(run: () => void, ms: number): void;
  /** Security invariant: a read-and-draft run's prompt and reply carry mail and invite text, so its failures stay quiet. */
  quietThread?(botId: string, threadId: string): boolean;
  /** The language a line about this conversation is written in for its person (server/server-lines.ts). */
  threadLanguage?(threadId: string): string | undefined;
}

/** How long a run stopped for memory waits before it starts again; the memory gate then holds it until there is room. */
export const MEMORY_RETRY_MS = 30_000;
export const MEMORY_RETRY_TEXT = "[Metal started this again by itself, once: the last run was stopped to free memory on this Cloud. "
  + "Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]";

export function createFailureNotices(deps: FailureNoticeDeps) {
  const { store } = deps;
  const ledger = new IncidentLedger();
  const later = deps.later ?? ((run: () => void, ms: number) => { setTimeout(run, ms).unref?.(); });
  /** Each thread's last request a run stopped for memory was started again for: once a request. */
  const roomRetries = new Map<string, string>();

  /** A run stopped for memory starts once more by itself; the person hears only if that one fails too, or can't start.
   * Never a run whose thread someone wrote in since, or that is running or queued again. */
  function retryForRoom(bot: BotRecord, threadId: string, tell: () => void): boolean {
    const continueRequest = deps.continueRequest;
    if (!continueRequest) return false;
    const asked = store.activePath(threadId).findLast((line) => line.role === "user")?.id ?? "";
    if (roomRetries.get(threadId) === asked) { tell(); return true; }
    roomRetries.set(threadId, asked);
    if (roomRetries.size > 500) roomRetries.delete(roomRetries.keys().next().value!);
    const failedAt = Date.now();
    later(() => {
      if (!store.bot(bot.id) || !store.taskByThread(bot.id, threadId)) return;
      if (store.activePath(threadId).some((line) => line.role === "user" && line.at > failedAt)) return;
      if (deps.threadBusy(bot.id, threadId) || deps.threadQueued?.(bot.id, threadId)) return;
      continueRequest(bot.id, threadId, MEMORY_RETRY_TEXT).catch(tell);
    }, MEMORY_RETRY_MS);
    return true;
  }

  /** Why a teammate's stopped thread cannot be retried now, in words a Chief can act on, or null. */
  function retryRefusal(botId: string, threadId: string): string | null {
    const blocked = deps.threadBusy(botId, threadId) ? (deps.threadSettling?.(threadId) ? "settling" : "running")
      : deps.threadQueued?.(botId, threadId) ? "queued" : null;
    if (blocked) return RETRY_BLOCKED[blocked];
    // A thread that finished a run since it last failed has nothing to resume: resuming would redo finished work.
    const failedAt = ledger.lastAt(threadId);
    if (failedAt !== undefined && store.activePath(threadId).some((line) => line.turnSucceeded === true && line.at > failedAt)) {
      return "that thread has finished a run since it failed, so there is nothing to retry; read what it did before deciding anything else";
    }
    return null;
  }

  /** A Chief's retry_thread: starts a teammate's stopped thread again after the refusal checks. Throws the refusal, or why
   * the start failed. */
  async function retryThread(input: { chief: BotRecord; bot: BotRecord; threadId: string; unattended: boolean; note?: string }): Promise<void> {
    const refused = retryRefusal(input.bot.id, input.threadId);
    if (refused) throw new Error(refused);
    const chief = peerName(input.chief.name);
    const lead = `${RETRY_LEAD}${chief}, your Chief of Staff, after this thread's last run stopped.${input.note ? ` Note from ${chief}: ${quoteInNote(input.note, 300)}` : ""}`;
    await deps.startTurn(input.bot.id, `${lead} Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]`,
      { threadId: input.threadId, unattended: input.unattended, peerAsk: { botId: input.chief.id, name: input.chief.name, ...(input.unattended ? { unattended: true } : {}) } });
  }

  /** `notified`: the person already heard of it another way (a usage limit's own notice), so nothing more is sent. */
  function reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string; notified?: boolean }): void {
    const { bot, threadId } = input;
    if (deps.quietThread?.(bot.id, threadId)) return;
    if (deps.assignerOf(threadId)) return;
    const task = store.taskByThread(bot.id, threadId);
    const group = store.groupByThread(threadId);
    const incident: Incident = { kind: input.kind, bot, threadId, title: task?.title ?? null, room: group?.name ?? null, detail: redactSecretsInText(input.detail) };
    if (ledger.note(threadId).muted) return;
    const tell = (): void => {
      if (input.notified || input.kind === "could-not-start" || input.kind === "routine-failed") return;
      deps.notify(buildNotification("incident", bot, threadId, incidentChip(incident, deps.threadLanguage?.(threadId)), {
        avatarUrl: bot.avatarUrl,
        ...(group ? { group: { id: group.id, name: group.name } } : {}),
      }));
    };
    if (input.kind === "failed" && !group && memoryStopped(input.detail) && retryForRoom(bot, threadId, tell)) return;
    tell();
  }

  return { reportIncident, retryRefusal, retryThread };
}
