// grok's failed-reply card: what stopped the newest replies, one card above the composer, never a row in the chat.
import { offersSignIn } from "@/components/EngineSetup";
import { statusActivity } from "@/lib/activity-runs";
import { t } from "@/lib/i18n";
import { peerLine } from "@/lib/peer-message";
import { isTechnicalError, plainErrorKind, plainErrorLine, providerSentence } from "@/lib/plain-error";
import { isReceipt } from "@/lib/receipts";
import type { LocaleKey } from "@/locales";
import type { InstanceInfo, Message } from "@/state/store";
import { failedTurnCause, type BrowserBlocker } from "../../shared/failed-turn";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { freeFallback } from "../../shared/ai-ranking";
import { hasRawDetail } from "../../shared/raw-detail";
import { failurePlan, type FailureKind } from "../../shared/failure-plan";

export type FailedReplyKind = FailureKind;

/** A failed turn's row: a reply that never came, not one that came back with a step that failed. */
export function isFailedReply(message: Message): boolean {
  const tool = message.tool;
  return message.kind === "activity" && Boolean(tool) && failedTurnCause(tool!.name) !== null && !tool!.partial && !isCancelledTranscriptRow(message);
}

/** A turn that ended without a word from its AI: no error row says it, so the card does. */
export function isUnansweredTurn(message: Message): boolean {
  return Boolean(message.tool?.rescue?.over);
}

/** A notice line a bot's turn left (a sign-out, a limit, a switch to another AI); never a live rescue or a stop. */
export function isFoldableNotice(message: Message): boolean {
  const status = statusActivity(message);
  return status !== null && status.kind !== "stopped" && !message.tool?.rescue;
}

/** A failure stops being news after a day: by then it says nothing about how the bot is now. */
export const FAILED_REPLY_STALE_MS = 24 * 60 * 60 * 1000;

/** A failed reply the card no longer shows: its cause was fixed since (the server marks it), or it is a day old. */
export function isStaleFailure(message: Message, now = Date.now()): boolean {
  return Boolean(message.tool?.resolvedAt) || now - message.at > FAILED_REPLY_STALE_MS;
}

/** The rows nothing has followed, since the person last wrote: per bot, its newest failed reply, and the notices after
 * its newest other row. A reply, a new message or a stop clears them, and so does fixing the cause or a day passing. */
export function trailingRows(messages: readonly Message[], scan = 200, now = Date.now()): { failures: Message[]; notices: Message[] } {
  const settled = new Set<string>();
  const failures: Message[] = [];
  const notices: Message[] = [];
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - scan; i -= 1) {
    const m = messages[i]!;
    if (m.role === "user" && !peerLine(m)) break;
    // what the turn's end leaves around its outcome (receipts, a digest, a call's record) is no newer reply
    if (isReceipt(m) || m.kind === "digest" || m.kind === "compaction" || m.kind === "call") continue;
    const who = m.from?.botId ?? "";
    if (settled.has(who)) continue;
    if (isFoldableNotice(m)) { notices.push(m); continue; }
    settled.add(who);
    if ((isFailedReply(m) || isUnansweredTurn(m)) && !isStaleFailure(m, now)) failures.push(m);
  }
  return { failures: failures.reverse(), notices: notices.reverse() };
}

// the runtime's own words for a turn a restart cut (server/runtime/tree.ts CUT_TWICE, INTERRUPTED_OUTWARD)
const RESTART_CUT = /^Interrupted by (?:another |an? )?(?:dusk bot|Metal) restart\b/i;
const RESTART_DID = /\bafter it already (.+?); not resumed\b/;

// the app's names before it became dusk bot, as older stored errors still say them
const OLD_NAMES = /\b(?:OpenMausBot|OpenMaus|Open Maus Bot|MausBot|Maus Bot|Dusk Bot)\b/gi;
const OLD_IMAGE = /^The VPS container uses an incompatible or untrusted (?:OpenMausBot|OpenMaus|MausBot|dusk bot|Metal) image\b/i;

/** A stored error in today's words: a known old computer error becomes its plain line, old app names become Metal. */
export function currentFailureWords(text: string): string {
  if (OLD_IMAGE.test(text.trim())) return t("failedReply.computerOutdated");
  return text.replace(OLD_NAMES, "Metal");
}

/** What a turn a restart cut had already done outside, in the server's words: "sent an email (gmail_send)". */
export function restartAlreadyDid(cause: string): string | null {
  return RESTART_DID.exec(cause)?.[1]?.trim() || null;
}


const SIGNED_OUT_WORDS = /not logged in|logged out|\/login|not signed in|sign in again|authentication required|unauthori[sz]ed|invalid api key|\b401\b/i;
const USAGE_WORDS = /usage limit|limit reached|hit your [\w' -]{0,30}limit/i;
const SESSION_LOST_WORDS = /\bNo conversation found with session ID\b/i;
const CREDIT_WORDS = /out of credits?|payment required|insufficient (?:funds|balance|credits?)/i;

/** What stopped a failed row: the server's own reading when it stored one, its flags and words for an older row.
 * `ownAi`: an AI the person connected is ready now, so connecting one is no longer the fix. */
/** What the free backup running out, being rate limited or not answering reads as: with no AI of the person's own none
 * of these is a failure they can fix by trying harder, only by connecting one. */
const FREE_BACKUP_DOWN: ReadonlySet<FailedReplyKind> = new Set(["credits", "usage_limit", "rate_limit", "overloaded", "timeout", "no_answer", "other",
  "model_not_found", "bad_request", "provider_down", "cli_missing", "cli_exit"]);

export function failedReplyKind(tool: NonNullable<Message["tool"]>, engine: InstanceInfo | undefined, ownAi = false): FailedReplyKind {
  const kind = failedKind(tool, engine, ownAi);
  return !ownAi && FREE_BACKUP_DOWN.has(kind) && (!engine || freeFallback(engine)) ? "no_ai" : kind;
}

function failedKind(tool: NonNullable<Message["tool"]>, engine: InstanceInfo | undefined, ownAi: boolean): FailedReplyKind {
  if (tool.rescue) return "no_answer";
  if (tool.blocker) return "blocker";
  const cause = failedTurnCause(tool.name) ?? tool.name;
  if (tool.place) return "place";
  if (tool.claudeUpdate) return "claude_update";
  if (RESTART_CUT.test(cause)) return "restart_interrupted";
  let kind: FailedReplyKind = tool.reason ?? (
    CREDIT_WORDS.test(cause) ? "credits"
    : tool.limitResetsAt || USAGE_WORDS.test(cause) ? "usage_limit"
    : tool.setup && SIGNED_OUT_WORDS.test(cause) ? "signed_out"
    : SESSION_LOST_WORDS.test(cause) ? "session_lost"
    : PLAIN_KIND[plainErrorKind(cause) ?? ""] ?? "other");
  // signed in again since: signing in is no longer the fix
  if (kind === "signed_out" && engine?.snapshot?.state === "available" && engine.snapshot.authenticated !== false) kind = "other";
  if (kind === "no_ai" && ownAi) kind = "other";
  return kind;
}

const PLAIN_KIND: Partial<Record<string, FailedReplyKind>> = {
  "error.plain.rateLimited": "rate_limit",
  "error.plain.busy": "overloaded",
  "error.plain.timeout": "timeout",
};

/** What stopped a reply, in the card's plain words, when its engine words say a reason; null for any other failure. */
export function plainFailureWords(cause: string): string | null {
  const kind = PLAIN_KIND[plainErrorKind(cause) ?? ""];
  return kind && kind !== "other" && kind in DETAIL ? t(DETAIL[kind as keyof typeof DETAIL]) : null;
}

/** Most actionable first: when bots fail for different reasons, the card says the one a person can fix. */
const PRIORITY: FailedReplyKind[] = ["blocker", "no_ai", "signed_out", "cli_missing", "claude_update", "credits", "usage_limit", "model_not_found", "context", "session_lost", "place",
  "restart_interrupted", "rate_limit", "overloaded", "provider_down", "timeout", "cli_exit", "bad_request", "no_answer", "other"];

export function mostActionable<T extends { kind: FailedReplyKind }>(items: readonly T[]): T | undefined {
  return [...items].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))[0];
}

/** the kinds whose line names the engine; a plain sentence from the engine itself says more, so it wins */
const ENGINE_DETAIL: Record<"model_not_found" | "bad_request" | "context" | "provider_down" | "cli_missing" | "cli_exit", LocaleKey> = {
  model_not_found: "failedReply.modelNotFound",
  bad_request: "failedReply.badRequest",
  context: "failedReply.context",
  provider_down: "failedReply.providerDown",
  cli_missing: "failedReply.cliMissing",
  cli_exit: "failedReply.cliExit",
};

const hasEngineDetail = (kind: FailedReplyKind): kind is keyof typeof ENGINE_DETAIL => Object.hasOwn(ENGINE_DETAIL, kind);

const DETAIL: Record<Exclude<FailedReplyKind, "signed_out" | "credits" | "claude_update" | "place" | "blocker" | keyof typeof ENGINE_DETAIL>, LocaleKey> = {
  usage_limit: "failedReply.usageLimit",
  rate_limit: "failedReply.rateLimited",
  overloaded: "failedReply.overloaded",
  timeout: "failedReply.timeout",
  no_ai: "failedReply.noAi",
  restart_interrupted: "failedReply.restarted",
  session_lost: "failedReply.sessionLost",
  no_answer: "error.plain.generic",
  other: "error.plain.generic",
};

const AI_UNREACHABLE: ReadonlySet<string> = new Set(["error.plain.unreachable", "error.plain.connection"]);

/** The card's one plain line for a kind; place, trial and update failures bring their own words. Any other failure says
 * the server's own cause, as the sidebar does, unless it is technical. */
export function failedReplyDetail(kind: FailedReplyKind, engineName: string, onServer: boolean, cause = ""): string {
  // the server's English line for a known reason reads better in the reader's own language
  const said = cause.trim() === failurePlan(kind).line ? "" : cause;
  const words = detailWords(kind, engineName, onServer, said);
  return said && hasRawDetail(words) ? detailWords(kind, engineName, onServer, "") : words;
}

function detailWords(kind: FailedReplyKind, engineName: string, onServer: boolean, cause: string): string {
  if (kind === "signed_out") return t(onServer ? "failedReply.signedOutServer" : "failedReply.signedOutHere", { engine: engineName });
  if (kind === "credits") return t("failedReply.credits", { engine: engineName });
  if (kind === "claude_update") return t("chat.claudeUpdate.offer");
  if (kind === "place" || kind === "blocker") return t("error.plain.generic");
  // an engine's own words for a full context are token counts, never what to do next
  if (kind === "context") return t(ENGINE_DETAIL.context, { engine: engineName });
  if (kind === "session_lost") return t(DETAIL.session_lost);
  if (hasEngineDetail(kind)) {
    const text = cause.trim();
    if (text && !isTechnicalError(text)) return currentFailureWords(text);
    return (text && providerSentence(text)) || t(ENGINE_DETAIL[kind], { engine: engineName });
  }
  // a turn's own network failure is its AI's server not answering, never the app: "fetch failed" from a model call
  if (kind === "other" && AI_UNREACHABLE.has(plainErrorKind(cause.trim()) ?? "")) return t("failedReply.unreachable", { engine: engineName });
  if (kind === "other" && cause.trim()) return plainErrorLine(cause) ?? currentFailureWords(cause.trim());
  return t(DETAIL[kind]);
}

/** Why Metal stopped a browser run itself, in one line. */
/** A failed row as a list previews it: the plain line its failure card leads with, never the engine's raw words. */
export function failurePreviewLine(tool: NonNullable<Message["tool"]>, engine: InstanceInfo | undefined): string {
  const kind = failedReplyKind(tool, engine, true);
  if (kind === "blocker" && tool.blocker) return blockerDetail(tool.blocker);
  return failedReplyDetail(kind, engine?.displayName ?? t("failedReply.yourAi"), false, failedTurnCause(tool.name) ?? "");
}

export function blockerDetail(blocker: BrowserBlocker): string {
  const site = blocker.site ?? "";
  if (blocker.kind === "loop") return site ? t("chat.blocker.loopOn", { site }) : t("chat.blocker.loop");
  return t(blocker.kind === "credentials" ? "chat.blocker.credentials" : blocker.kind === "credit" ? "chat.blocker.credit" : "chat.blocker.blocked", { site: site || t("chat.blocker.theSite") });
}

/** "Bot failed to respond" in a direct chat; in a group, who: "Echo couldn't respond", "Echo, Quill and 2 more couldn't respond". */
export function failedReplyTitle(names: readonly string[], group: boolean): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (!group || unique.length === 0) return t("failedReply.title");
  if (unique.length === 1) return t("failedReply.titleOne", { name: unique[0]! });
  if (unique.length === 2) return t("failedReply.titleTwo", { first: unique[0]!, second: unique[1]! });
  return t("failedReply.titleMore", { first: unique[0]!, second: unique[1]!, count: unique.length - 2 });
}

/** A sign-in the app can open for this engine. */
export function canOfferSignIn(kind: FailedReplyKind, engine: InstanceInfo | undefined): boolean {
  return kind === "signed_out" && offersSignIn(engine);
}
