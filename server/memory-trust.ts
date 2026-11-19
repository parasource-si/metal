// Memory loads into every later turn, so it is where a planted instruction would persist (SpAIware, 2024; MINJA,
// arXiv 2503.03704). Security invariant: text that reached a turn from a web page, a tool, an email, a webhook or
// another bot never becomes always-loaded memory on its own, and nothing that reads as an instruction is kept at all.

/** Instruction-like text a fact never needs: overriding rules, sending data somewhere, reaching for keys. */
const THREATS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b.{0,30}\b(?:previous|prior|above|earlier|all|system|your)\b.{0,20}\b(?:instructions?|rules?|prompts?|guidelines?)\b/i,
  /\b(?:always|from now on|every time|whenever|automatically)\b.{0,80}\b(?:cc|bcc|forward|send|e-?mail|post|upload|share|copy|transfer|pay|wire)\b.{0,80}(?:@[\w-]+\.|https?:\/\/|\b[\w.+-]+@[\w-]+\.\w)/i,
  /\b(?:send|forward|upload|post|exfiltrate|leak)\b.{0,60}\b(?:to|at|into)\b.{0,20}(?:https?:\/\/|\b[\w.+-]+@[\w-]+\.\w)/i,
  /\b(?:authorized_keys|id_rsa|id_ed25519)\b|~\/\.ssh\b|\.env\b|\b(?:api[_ -]?key|password|secret|token)s?\b.{0,40}\b(?:send|share|post|reveal|print)\b/i,
  /\b(?:system prompt|developer (?:message|mode)|jailbreak)\b/i,
  /\bexfiltrat/i,
];

export function looksLikeInstruction(text: string): boolean {
  return THREATS.some((pattern) => pattern.test(text));
}

export const BLOCKED_LINE = "[blocked: a saved line read like an instruction rather than a fact; it stays in the file for the person to review]";

/** Tools whose results are outside content: whatever they return was written by someone other than the person. */
const OUTSIDE_TOOL = /browser|web|fetch|read_pages?|research|search|crawl|scrape|download|gmail|mail|inbox|slack|composio|http|url|rss|calendar|drive|notion|github|webhook|connector|mcp__/i;
const OWN_TOOL = /^(?:session_search|memory_update|memory_log|list_bots|list_threads)$/;
/** Metal's own tools server in each engine's spelling: its tools are judged by their bare names, not as any MCP server. */
const OWN_SERVER = /^(?:mcp__agents__|agents__|agents_)/;

type PathMessage = { role: string; kind?: string; sender?: { id?: string; name?: string }; peerAsk?: unknown; tool?: { name?: string } };

/** What the current turn has read since the person's last message: outside content taints what it may remember. */
export function readOutsideContent(path: readonly PathMessage[]): boolean {
  const asked = path.findLastIndex((message) => message.role === "user" && message.kind === "text");
  for (const message of path.slice(asked + 1)) {
    const name = (message.tool?.name ?? "").replace(OWN_SERVER, "");
    if (message.kind === "activity" && name && !OWN_TOOL.test(name) && OUTSIDE_TOOL.test(name)) return true;
  }
  return false;
}

type PersonLine = PathMessage & {
  text?: string; webhookPost?: unknown; via?: unknown; relayed?: unknown; relay?: unknown; comm?: unknown; inbox?: unknown; peerPost?: unknown; from?: unknown;
};

const PERSON_LINES = 60;

/** What the person who asked this turn typed into this conversation themselves, newest last: never a webhook, an API
 * caller, a relay, another bot or another person. Empty when the latest ask is not theirs. */
export function personsOwnWords(path: readonly PersonLine[]): string[] {
  const own = (message: PersonLine) => message.role === "user" && message.kind === "text" && typeof message.text === "string"
    && !message.peerAsk && !message.webhookPost && message.via !== "api" && !message.relayed && !message.relay && !message.comm
    && !message.inbox && !message.peerPost && !message.from;
  const at = path.findLastIndex((message) => message.role === "user" && message.kind === "text");
  const asked = path[at];
  if (!asked || !own(asked)) return [];
  const who = asked.sender?.id ?? asked.sender?.name;
  const lines = path.filter((message) => own(message) && (message.sender?.id ?? message.sender?.name) === who).slice(-PERSON_LINES).map((message) => message.text!);
  const confirmed = isYes(asked.text!) ? questionBefore(path, at) : null;
  return confirmed ? [...lines, confirmed] : lines;
}

const YES = new Set(["y", "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "correct", "please", "save", "do", "go"]);
const NOT = new Set(["no", "not", "don", "dont", "never", "nope", "stop", "cancel", "wait", "don't"]);

/** A short reply that opens with a yes and says no "not". */
function isYes(text: string): boolean {
  const said = text.toLowerCase().replace(/’/g, "'").split(/[^\p{L}']+/u).filter(Boolean);
  return said.length > 0 && said.length <= 6 && YES.has(said[0]!) && !said.some((word) => NOT.has(word) || word.endsWith("n't"));
}

const QUESTION_CHARS = 500;

/** Security invariant: the bot's short question the person's yes answers, and only one that came after their previous message,
 * so their yes to a quoted line confirms exactly that line. */
function questionBefore(path: readonly PersonLine[], at: number): string | null {
  for (let i = at - 1; i >= 0; i -= 1) {
    const message = path[i]!;
    if (message.role === "user" && message.kind === "text") return null;
    if (message.role === "bot" && (message.kind === "text" || message.kind === "options") && typeof message.text === "string" && message.text.trim()) {
      return message.text.includes("?") && message.text.length <= QUESTION_CHARS ? message.text : null;
    }
  }
  return null;
}

/** Words a saved line may use that the person need not have typed: how a note names the person, and glue. */
const FILLER = new Set(("the a an and or of to in on at for by with from as is are was were be been it its this that these those " +
  "person persons user users they them their theirs he him his she her hers me my mine we us our you your " +
  "wants want wanted prefers prefer preferred likes like should must always never every all any each also please " +
  "make sure remember note keep save going goes go will would can could do does did not no yes so just").split(" "));

const words = (text: string) => text.toLowerCase().replace(/’/g, "'").split(/[^\p{L}\p{N}@._'-]+/u)
  .map((word) => word.replace(/^[._'-]+|[._'-]+$/g, "").replace(/'s$/, "")).filter(Boolean);
const stem = (word: string) => word.replace(/(?:ies|es|s|ed|ing)$/, "").slice(0, 6);
const DISTINCT = /\d|@|\.\w/;

/** Security invariant: a line is the person's own only when one message they typed carries every name with a digit, address
 * and link in it, and at least three in five of its other words. Anything else (a page's, a mail's, a tool's or another bot's
 * words) stays outside content however the person pointed at it. */
export function saidByPerson(text: string, said: readonly string[]): boolean {
  const line = words(text);
  const distinct = line.filter((word) => DISTINCT.test(word));
  const content = [...new Set(line.filter((word) => !DISTINCT.test(word) && word.length > 2 && !FILLER.has(word)).map(stem))];
  if (!content.length) return false;
  return said.some((message) => {
    const theirs = words(message);
    if (!distinct.every((word) => theirs.includes(word))) return false;
    const stems = new Set(theirs.map(stem));
    const found = content.filter((word) => stems.has(word)).length;
    return found >= Math.min(2, content.length) && found * 5 >= content.length * 3;
  });
}
