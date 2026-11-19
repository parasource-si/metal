// Experience signals: how turns went for the person, where they got stuck, and what got done. Security: every signal
// passes cleanSignal (shared/product-signals.ts) before it is queued, so only fixed words, counts and flags can leave.
// A message's text is read here only to classify a follow-up, kept in memory for at most one ask per chat, and never sent.
import { randomBytes } from "node:crypto";

import { CONFUSION_KINDS, DOWNLOAD_FAIL_REASONS, cleanSignal } from "../shared/product-signals.ts";
import { isCorrective, sameRequest } from "./usage-signals.ts";

export interface ExperienceSignal { id: string; at: number; name: string; props: Record<string, string | number | boolean> }
const MAX_QUEUE = 500, MAX_TAKE = 200;

/** experience signals waiting for the desktop app to take them (GET /api/dashboard/experience); memory only, oldest dropped
 * past the cap, nothing kept while "help improve Metal" is off */
export function createExperienceOutbox(options: { enabled: () => boolean; now?: () => number }) {
  const now = options.now ?? Date.now;
  let queue: ExperienceSignal[] = [];
  return {
    /** false when the switch is off or the catalogue refused it */
    note(name: string, props: Record<string, unknown> = {}): boolean {
      if (!options.enabled()) { queue = []; return false; }
      const kept = cleanSignal(name, props, "app");
      if (!kept) return false;
      queue.push({ id: randomBytes(9).toString("base64url"), at: now(), name, props: kept });
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      return true;
    },
    take(max = MAX_TAKE): ExperienceSignal[] {
      if (!options.enabled()) { queue = []; return []; }
      const out = queue.slice(0, Math.max(0, Math.min(MAX_TAKE, max)));
      queue = queue.slice(out.length);
      return out;
    },
    size: () => queue.length,
  };
}
export type ExperienceOutbox = ReturnType<typeof createExperienceOutbox>;

type Confusion = (typeof CONFUSION_KINDS)[number];
const WHAT_MEAN = /^(?:what do you mean|what does (?:that|this|it) mean|what\?+$|huh\??$|i (?:don'?t|do not) (?:understand|get it)|meaning\?|sorry,? what|what are you (?:talking about|saying))/iu;
const WHY = /^why\b/iu;
const HOW_DO_I = /^how (?:do|can|should|would) i\b|^where (?:do|can) i (?:find|see|change|turn)\b/iu;
/** a follow-up's kind from its first words, or null; the text is only read here */
export function followUpKind(text: string): "what_mean" | "why" | "how_do_i" | null {
  const line = text.trim().slice(0, 200);
  if (!line) return null;
  if (WHAT_MEAN.test(line)) return "what_mean";
  if (WHY.test(line)) return "why";
  if (HOW_DO_I.test(line)) return "how_do_i";
  return null;
}

/** a follow-up counts only this soon after the reply it answers */
export const FOLLOW_UP_MS = 10 * 60_000;
interface Chat { ask?: { text: string; at: number }; replyAt?: number; failed?: boolean }

/** watches each chat for a person's message right after a bot's reply that reads as confusion or a retry */
export function createConfusionWatch(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const chats = new Map<string, Chat>();
  const chat = (threadId: string) => {
    let state = chats.get(threadId);
    if (!state) {
      state = {};
      chats.set(threadId, state);
      if (chats.size > 500) chats.delete(chats.keys().next().value!);
    }
    return state;
  };
  return {
    /** a turn of this chat ended: a reply (or a failure) the person may answer next */
    replied(threadId: string, failed: boolean) {
      const state = chat(threadId);
      state.replyAt = now();
      state.failed = failed;
    },
    /** the person wrote in this chat: the kind of confusion it shows right after a reply, or null */
    message(threadId: string, text: string): { kind: Confusion; after: "reply" | "failed" } | null {
      const state = chat(threadId), time = now();
      const previous = state.ask, replyAt = state.replyAt, failed = state.failed === true;
      state.ask = { text: text.slice(0, 2000), at: time };
      state.replyAt = undefined;
      if (replyAt === undefined || time - replyAt > FOLLOW_UP_MS) return null;
      const after = failed ? "failed" as const : "reply" as const;
      if (previous && sameRequest(previous.text, text)) {
        const same = previous.text.trim().toLowerCase() === text.trim().toLowerCase();
        return { kind: failed ? "retried" : same ? "repeat" : "rephrase", after };
      }
      const kind = followUpKind(text);
      if (kind) return { kind, after };
      return isCorrective(text) ? { kind: "corrective", after } : null;
    },
    forget(threadId: string) { chats.delete(threadId); },
  };
}

/** the category of a browser download's error message */
export function downloadFailReason(message: string): (typeof DOWNLOAD_FAIL_REASONS)[number] {
  if (/sha-?256|checksum|digest|pinned size|did not match/i.test(message)) return "checksum";
  if (/\bHTTP \d{3}\b/.test(message)) return "http";
  if (/ENOSPC|EACCES|EPERM|EROFS|disk|space/i.test(message)) return "disk";
  if (/publishes no build|unsupported/i.test(message)) return "unsupported";
  if (/fetch failed|network|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|abort|timed? ?out|socket/i.test(message)) return "network";
  return "other";
}
