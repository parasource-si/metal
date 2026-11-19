// What the chat-completions loop does about a model's reply habits: an announced step with no tool call, a claimed
// change no tool made, and a provider hiccup in the middle of a turn that already ran tools.
import { computeBackoff, RETRY_MAX_ATTEMPTS, type ErrorClassification } from "./retry.ts";

export const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Use your tools for only the remaining work, or reply with verified results if nothing is left to do. Never repeat an operation that succeeded, was denied, or may already have taken effect; inspect its state instead. Do not retry a destructive operation.";

export const NUDGE_CLAIMED_CHANGE = "Your reply says something was done (sent, posted, saved, created, changed or cancelled), but no tool call in this turn did it, so nothing outside this chat changed. Do it now with your tools if you have one for it; otherwise rewrite the reply to say plainly what you did not do and what is ready instead (a draft, the steps), without claiming it is done.";

const STEP_VERB = "execute|send|type|press|launch|open|check|inspect|read|fetch|run|create|write|verify|start|begin|proceed|set up|build|draft|make|put together|prepare|pull|search|look|work|get started|gather|compile|go ahead";
const ACK_OPENER = /^(?:on it|sure(?: thing)?|ok(?:ay)?|alright|all right|got it|will do|absolutely|of course|no problem|right away|certainly|understood|perfect|great)\b[\s,.!:\u2014\u2013-]*/i;
const ANNOUNCE_START = /^(?:checking|let me(?! know\b)|i'll|i will|i'm going to|i am going to|opening|pulling|looking|searching|navigating|reading|fetching|loading|now (?:i'll|let me|opening|checking|pulling|reading))\b/i;
const ANNOUNCE_PROGRESSIVE = /^i(?:['\u2019]m| am) (?:now )?(?:setting|putting|pulling|checking|creating|drafting|making|preparing|building|writing|working|getting|looking|searching|starting|adding|saving|scheduling|opening|gathering|compiling|reading|fetching)\b/i;
const ANNOUNCE_BARE = /^(?:working on it|starting now|setting|putting|creating|drafting|making|preparing|building|writing|getting|adding|saving|scheduling|gathering|compiling)\b/i;
const ANNOUNCE_TAIL = new RegExp(`^(?:let me|i['\u2019]ll|i will|i(?:['\u2019]m| am) going to)\\s+(?:now\\s+)?(?:${STEP_VERB})\\b`, "i");

/** a reply that only says which step comes next, with no question and no result, from a model that called no tool.
 * Before anything effectful ran in the turn (`acted` false), an ack that only names the work ("On it, setting that
 * up.") counts too. */
export function announcesAction(text: string, acted = true): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 4_000 || reply.includes("?")) return false;
  if (reply.length > 400) {
    const tail = reply.split(/\n\s*\n/).at(-1)!.trim();
    return tail.length <= 400 && ANNOUNCE_TAIL.test(tail);
  }
  const opened = reply.replace(ACK_OPENER, "");
  if (!acted && opened !== reply && (!opened || ANNOUNCE_START.test(opened) || ANNOUNCE_TAIL.test(opened) || ANNOUNCE_PROGRESSIVE.test(opened) || ANNOUNCE_BARE.test(opened))) return true;
  if (!acted && ANNOUNCE_PROGRESSIVE.test(reply)) return true;
  return /(?:[:\u2014\u2013]|\.\.\.|\u2026)$/.test(reply) || ANNOUNCE_START.test(reply) ||
    /^i(?:['\u2019]m| am)\b[^.!?\n]*\band (?:i )?will\s+(?:launch|open|check|pull|look|search|navigate|read|fetch|load|run|inspect)\b/i.test(reply);
}

const DONE_VERB = "sent|emailed|posted|published|renamed|moved|deleted|removed|cancell?ed|canceled|paused|scheduled|booked|created(?! (?:a |the |this |your )?drafts?\\b)|saved|set up|uploaded|shared|messaged|turned off|turned on";
const CLAIMED_CHANGE = new RegExp([
  `\\b(?:i(?:['\u2019]ve| have)|i just|i(?:['\u2019]ve| have) now|i)\\s+(?:already\\s+|successfully\\s+)?(?:${DONE_VERB})\\b`,
  `\\b(?:has|have|was|were) (?:now |already |successfully )?been (?:now |already |successfully )?(?:${DONE_VERB})\\b`,
  `\\b(?:is|are) now (?:live|posted|set up|scheduled|renamed|cancell?ed|paused|deleted|saved)\\b`,
  `^(?:sent|posted|cancell?ed|it['\u2019]s live)\\s*[.!]`,
].join("|"), "im");
const NOT_DONE = /\b(?:not|n['\u2019]t|never|nothing|no longer|could not|cannot|can['\u2019]t|unable|once you|after you|when you|if you|want me to|shall i|should i)\b[^.!?\n]{0,40}$/i;

/** a reply that says it changed something outside the chat; `effectful` counts the turn's tool calls that succeeded
 * and were not lookups, so only a reply with none of those is held to it */
export function claimsUnmadeChange(text: string, effectful: number): boolean {
  if (effectful > 0) return false;
  for (const line of text.split(/\n+/)) {
    const match = CLAIMED_CHANGE.exec(line);
    if (match && !NOT_DONE.test(line.slice(0, match.index + match[0].length))) return true;
  }
  return false;
}

// tools that only report: they never change anything a person would call done
const LOOKUP_TOOL = /(?:^|_)(?:set_status|find_tool|tool_result_read|ask_user|list_[a-z_]+|[a-z_]+_info|search[a-z_]*|read[a-z_]*|get[a-z_]*|describe|show|load|sql|recall)$/;

/** a tool call (its name and raw JSON arguments) that can have changed something; a bridged call counts by the tool it ran */
export function effectfulCall(name: string, rawArgs: string): boolean {
  let args: unknown;
  try { args = JSON.parse(rawArgs); } catch { args = null; }
  const bridged = /(?:^|_)use_tool$/.test(name) && args && typeof args === "object" && typeof (args as { name?: unknown }).name === "string" ? (args as { name: string }).name : name;
  return !LOOKUP_TOOL.test(bridged);
}

/** longest wait a mid-turn retry may take; a provider asking for more than this is a limit, not a hiccup */
export const MAX_RETRY_WAIT_MS = 60_000;

/** an HTTP failure carrying the provider's Retry-After, in ms, for the turn loop's next attempt */
export function withRetryAfter<T extends Error>(error: T, headers: Pick<Headers, "get">, now = Date.now()): T {
  const raw = headers.get("retry-after-ms") ?? headers.get("retry-after");
  if (!raw) return error;
  const value = raw.trim();
  const ms = headers.get("retry-after-ms") ? Number(value) : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Object.assign(error, { retryAfterMs: Math.round(ms) }) : error;
}

/** how long to wait before sending a failed completion request again, or null when it must not go again: only a
 * transient failure, within the attempts, and never past MAX_RETRY_WAIT_MS. The request ran nothing, so tool calls
 * that already ran in this turn stay in its messages and are not repeated. */
export function retryDelay(error: unknown, verdict: ErrorClassification, attempt: number): number | null {
  if (!verdict.transient || attempt >= RETRY_MAX_ATTEMPTS - 1) return null;
  const asked = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  if (typeof asked === "number" && asked > MAX_RETRY_WAIT_MS) return null;
  return Math.max(computeBackoff(attempt), typeof asked === "number" ? asked : 0);
}

// gpt-oss's harmony tokens (`<|channel|>commentary to=functions.x <|constrain|>json<|message|>{...}<|call|>`), which a
// provider whose parser missed them passes on as the reply's text
const HARMONY_CALL = /<\|(?:start|channel|constrain|message|call)\|>[\s\S]*\bto=functions\.|\bto=functions\.[\w.-]+[\s\S]*<\|(?:message|call)\|>/;

/** a reply that is a tool call in a model's raw chat-format tokens: it ran nothing and is no answer, so it is asked for
 * again and never shown */
export function leakedToolSyntax(text: string): boolean {
  return HARMONY_CALL.test(text);
}

export const CORRECTIVE_ROUND = "[Metal: a tool call in this turn failed (its result is marked ok:false). Re-run the failed operations with corrected inputs where possible, check the results, then give your one final answer: what worked, what did not and what the person can do about it. Do not report results you did not get.]";
/** rounds a local model gets to fix a failed tool call before its answer stands */
export const LOCAL_CORRECTIVE_ROUNDS = 2;

export const REASONING_AGAIN = "[Metal: your last reply was your own working notes about the request, not an answer, so the person did not see it. Do the work with your tools if it needs them, then answer the person directly in plain words.]";

// gpt-oss's analysis channel passed on as the reply: it talks about "the user" and its instructions in the third person
const REASONING_OPENER = /^(?:we need to|we should|we must|we have to|we can(?:not|'t)?|let's (?:respond|answer|reply|craft|produce|check|see)|the user (?:wants|asks|is asking|said|says|requests|asked)|user (?:wants|asks|says)|according to (?:the )?(?:guidelines|instructions|system|developer|policy)|the (?:system|developer) (?:prompt|message|instructions))\b/i;
const REASONING_MARKS = /\b(?:the user|guidelines|system prompt|developer message|instructions say|we should|we need to|we must|according to)\b/gi;

/** a reply that is the model's private reasoning about the request rather than words for the person */
export function leakedReasoning(text: string): boolean {
  const reply = text.trim();
  return REASONING_OPENER.test(reply) && (reply.match(REASONING_MARKS)?.length ?? 0) >= 3;
}

const DECIDE_AT = 24;
const NOTES_START = /^\s*(?:we |the user|user |according to|let's |the system|the developer)/i;

/** The live stream of one reply, held where it may be a leak: its first few words until they show it is not working
 * notes (a reply that opens like notes is held to its end), and everything from a chat-format token on. What is held
 * reaches the person through `flush` once the whole reply is known not to be a leak. */
export class LeakHoldback {
  private seen = "";
  private held = "";
  private holding: "start" | "all" | null;

  /** `whole`: hold the entire reply, for one that may not be shown at all */
  constructor(whole = false) {
    this.holding = whole ? "all" : "start";
  }

  feed(text: string): string {
    if (this.holding === "all") { this.held += text; return ""; }
    const at = text.indexOf("<|");
    const before = at < 0 ? text : text.slice(0, at);
    let out = "";
    if (this.holding === "start") {
      this.held += before;
      this.seen += before;
      if (this.seen.trimStart().length >= DECIDE_AT) {
        if (NOTES_START.test(this.seen)) this.holding = "all";
        else { out = this.held; this.held = ""; this.holding = null; }
      }
    } else out = before;
    if (at >= 0) { this.held += text.slice(at); this.holding = "all"; }
    return out;
  }

  /** what was held for a reply cut short by an error, unless it already looked like a leak */
  kept(): string {
    return this.holding === "all" ? "" : this.flush();
  }

  /** what was held, with `rest` after it, for a reply that turned out not to be a leak */
  flush(rest = ""): string {
    const out = this.held + rest;
    this.held = "";
    this.holding = null;
    return out;
  }
}

const FAILURE_WORDS = /\b(?:could(?:n['’]t| not)|can(?:['’]t|not)|did(?:n['’]t| not)|was(?:n['’]t| not)|is(?:n['’]t| not) (?:connected|available|set up)|failed|unable|not connected|nothing (?:was|went|got)|no (?:access|connection)|blocked|refused|went wrong)\b/i;

/** a reply that tells the person a step failed and does not claim it worked: a failure card under it would say it twice */
export function ownsFailure(reply: string): boolean {
  return FAILURE_WORDS.test(reply) && !claimsUnmadeChange(reply, 0);
}

