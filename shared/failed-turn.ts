// A failed turn is stored as an activity row named "error: <what went wrong>",
// in a 1:1 chat and a room alike. A place that could not be used also stores
// its state, so the app words it again in the reader's language; the words
// stay English and whole for the phones, which read only them.
import { plainComputerFailure } from "./computer-unreachable.ts";
import type { PlaceRow } from "./place-view.ts";
import { shortenHomePaths } from "./raw-detail.ts";

const MARKER = "error:";

/** What stopped a reply, read by the server from the engine's own words, so the app says it in plain words. `no_ai`: only
 * OpenCode's free backup could answer and it didn't, so connecting an AI is the way on. `cli_exit`: the engine's program
 * quit or crashed before it replied; `cli_missing`: it could not be started at all. */
export type FailedReplyReason = "signed_out" | "credits" | "usage_limit" | "rate_limit" | "overloaded" | "timeout" | "no_ai"
  | "model_not_found" | "bad_request" | "context" | "session_lost" | "provider_down" | "cli_missing" | "cli_exit";

/** Why Metal stopped a browser run itself: `loop`, the same step did nothing three times; the others, a page said
 * so in words a retry cannot change. */
export interface BrowserBlocker { kind: "loop" | "credentials" | "credit" | "blocked"; site?: string }

/** The longest cause a row keeps. Clients wrap the row and show it whole, so
 * this only bounds a pathological message (a provider's HTML body, a stack
 * trace); a sentence a person acts on fits, its next action included. */
export const FAILED_TURN_MAX_CHARS = 600;

export interface FailedTurnTool {
  name: string;
  ok: false;
  /** fixed by installing or signing in, not by retrying */
  setup?: boolean;
  terminal?: boolean;
  /** the installed Claude Code is too old for the model */
  claudeUpdate?: boolean;
  /** the place this turn could not use, and where that place came from */
  place?: PlaceRow;
  /** epoch ms when the usage limit that stopped this turn resets, when the engine said */
  limitResetsAt?: number;
  /** the turn's reply came back; only a step it ran failed or wasn't allowed */
  partial?: boolean;
  /** with `partial`: the reply itself says what failed */
  owned?: boolean;
  /** what stopped it, when the server could tell */
  reason?: FailedReplyReason;
  blocker?: BrowserBlocker;
}

/** What an echoed prompt reads as once it is taken out of an error. */
export const ECHOED_PROMPT = "[…]";

/** A long quoted value of several lines in an error is input the engine or its provider repeated back (a Python
 * KeyError's repr, a validator's "'<value>' is too long"), never a cause; the quote may be cut off at the end. */
const LONG_QUOTED = /(?<!\w)'(?:[^'\\]|\\.){300,}(?:'|$)|(?<!\w)"(?:[^"\\]|\\.){300,}(?:"|$)/gs;
const SEVERAL_LINES = /\n|\\n/;
/** The opening line of every bot's system prompt (server/system-prompt.ts), wherever an echo of it starts. */
const SYSTEM_PROMPT_OPENING = /\bYou are [^\n]{1,120}?, a personal bot in (?:Metal|dusk bot)\.|\bAbout you: you are [^\n]{1,120}?, a (?:Metal bot|dusk bot)\./;

/** Security invariant: an error must never carry the bot's system prompt, its memory or its file paths. An engine that
 * echoes the prompt it was sent loses that span, and the rest of its words stay. */
export function withoutEchoedPrompt(text: string): string {
  const out = text.replace(LONG_QUOTED, (span) => (SEVERAL_LINES.test(span) ? ECHOED_PROMPT : span));
  const opening = SYSTEM_PROMPT_OPENING.exec(out);
  return opening ? `${out.slice(0, opening.index)}${ECHOED_PROMPT}` : out;
}

/** Metal's own words for a failed turn, an engine's internal error, or a bot's private folder. */
const ERROR_DUMP = /\bBot failed to respond\b|\bInternal error: ['"]|[\\/]\.duskbot[\\/](?:workspaces|bots)[\\/]/i;

/** Security invariant: text bound for a conversation outside Metal (another app's chat, a mail, a caller) is never a
 * failure report, an engine error or the bot's system prompt; a send carrying one is dropped. */
export function isErrorDump(text: string): boolean {
  return ERROR_DUMP.test(text) || SYSTEM_PROMPT_OPENING.test(text);
}

export const ERROR_DUMP_REFUSAL = "Not sent: this text is an error report or Metal's own instructions, never a message for anyone outside Metal. "
  + "Write the message itself, or tell the person in this chat what went wrong.";

/** Whether any outbound call's arguments carry an error dump. */
export function sendsErrorDump(calls: readonly { arguments?: unknown }[]): boolean {
  return calls.some((call) => argumentTexts(call.arguments).some(isErrorDump));
}

/** Every string inside a tool call's arguments, as far as `depth` levels down. */
export function argumentTexts(value: unknown, depth = 6): string[] {
  if (typeof value === "string") return [value];
  if (depth <= 0 || !value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap((item) => argumentTexts(item, depth - 1));
}

/** The activity row a failed turn is stored as. */
export function failedTurnTool(
  cause: string,
  flags: { setup?: boolean; terminal?: boolean; claudeUpdate?: boolean; place?: PlaceRow; limitResetsAt?: number; partial?: boolean; owned?: boolean; reason?: FailedReplyReason; blocker?: BrowserBlocker } = {},
): FailedTurnTool {
  const clean = shortenHomePaths(plainComputerFailure(withoutEchoedPrompt(cause)));
  const words = clean.length > FAILED_TURN_MAX_CHARS ? `${clean.slice(0, FAILED_TURN_MAX_CHARS - 1)}…` : clean;
  return {
    name: `${MARKER} ${words}`,
    ok: false,
    ...(flags.setup ? { setup: true } : {}),
    ...(flags.terminal ? { terminal: true } : {}),
    ...(flags.claudeUpdate ? { claudeUpdate: true } : {}),
    ...(flags.place ? { place: flags.place } : {}),
    ...(flags.limitResetsAt ? { limitResetsAt: flags.limitResetsAt } : {}),
    ...(flags.partial ? { partial: true } : {}),
    ...(flags.partial && flags.owned ? { owned: true } : {}),
    ...(flags.reason ? { reason: flags.reason } : {}),
    ...(flags.blocker ? { blocker: flags.blocker } : {}),
  };
}

/** The cause a failed-turn row carries, without its marker; null for any
 * other activity row. */
export function failedTurnCause(name: string): string | null {
  return name.startsWith(MARKER) ? name.slice(MARKER.length).trim() : null;
}
