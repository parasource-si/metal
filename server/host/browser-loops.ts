// Stops a browser run that is spending without getting anywhere: the same action on a page that did not change, three
// times, ends the turn with a blocker card (Take over, Skip, Stop). A page that says the sign-in details are wrong, the
// account has no credit, or the site blocks automated visitors is told to the bot once as final; any further action
// on that site in the same turn ends the turn the same way, so none of the three is ever retried.
import type { BrowserBlocker } from "../../shared/failed-turn.ts";

export const SAME_STEP_LIMIT = 3;

const ACTIONS = new Set(["agent_browser_click", "agent_browser_fill", "agent_browser_type", "agent_browser_press", "agent_browser_select",
  "agent_browser_check", "agent_browser_hover", "agent_browser_drag", "agent_browser_scroll", "agent_browser_upload"]);
const UNCHANGED = "The visible text of the page did not change.";
const NAVIGATED = /The page is now (\S+)/;

const TERMINAL: ReadonlyArray<[BrowserBlocker["kind"], RegExp]> = [
  ["credentials", /\b(?:incorrect|wrong|invalid)\s+(?:password|username|user name|e-?mail or password|login|credentials)\b|\bpassword (?:is|was) (?:incorrect|wrong)\b|\bcouldn'?t sign you in\b/i],
  ["credit", /\binsufficient (?:funds|credits?|balance)\b|\b(?:card|payment) (?:was )?declined\b|\bout of credits?\b|\bno credits? (?:left|remaining)\b/i],
  ["blocked", /\baccess denied\b|\byou have been blocked\b|\bunusual traffic\b|\bare you a robot\b|\bautomated (?:access|queries|requests)\b|\brequest (?:was )?blocked\b/i],
];

const NOTE: Record<BrowserBlocker["kind"], string> = {
  loop: "",
  credentials: "the sign-in details were refused",
  credit: "the account has no credit or the payment was declined",
  blocked: "the site is blocking automated visitors",
};

export interface BrowserStop { threadId: string; blocker: BrowserBlocker; cause: string }

interface Thread { lastKey: string | null; unchanged: number; site: string | null; final: Map<string, BrowserBlocker["kind"]>; slowed: Set<string> }

type Result = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

const textOf = (result: Result): string => (result.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

function hostOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try { return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname || null; } catch { return null; }
}

/** A block page is short; the same words inside a long page are more likely an article about them. */
const BLOCK_PAGE_MAX = 4_000;

export function terminalKind(text: string): BrowserBlocker["kind"] | null {
  const kind = TERMINAL.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  return kind === "blocked" && text.length > BLOCK_PAGE_MAX ? null : kind;
}

const RATE_LIMITED = /\brate[- ]limit(?:ed|s)?\b|\btoo many requests\b|\btry again later\b|\bover the (?:daily )?limit\b|\b(?:sending|posting) (?:messages )?too (?:fast|quickly)\b|\bslow down\b/i;

/** A site saying "too fast, try later": the action result names it, or a short page does. */
export function rateLimited(name: string, text: string): boolean {
  return RATE_LIMITED.test(text) && (ACTIONS.has(name) || text.length <= BLOCK_PAGE_MAX);
}

const rateNote = (site: string) =>
  `Metal note: ${site} says to slow down or try again later. Do not retry this right away. If you are working through a checklist, call checklist pause with the minutes the site asked for (15 if it does not say) and end your turn: Metal carries on with the rest after the pause. Otherwise tell the person in one line.`;

export function createBrowserLoops(deps: { stop(stop: BrowserStop): void }) {
  const threads = new Map<string, Thread>();
  const thread = (id: string): Thread => {
    let current = threads.get(id);
    if (!current) threads.set(id, current = { lastKey: null, unchanged: 0, site: null, final: new Map(), slowed: new Set() });
    if (threads.size > 500) threads.delete(threads.keys().next().value!);
    return current;
  };
  const halt = (threadId: string, blocker: BrowserBlocker, cause: string): Result => {
    threads.delete(threadId);
    deps.stop({ threadId, blocker, cause });
    return { isError: true, content: [{ type: "text", text: `Metal stopped this run: ${cause}. Do not try again; the person decides what happens next.` }] };
  };

  return {
    /** What the bot is answered for one browser call: the result as it came, with a final note, or a stop. */
    answer(threadId: string, name: string, args: Record<string, unknown> | undefined, result: Result): Result {
      const state = thread(threadId);
      const target = name === "agent_browser_open" || name === "agent_browser_navigate" ? hostOf(args?.url) : null;
      if (target && state.final.has(target)) {
        const kind = state.final.get(target)!;
        return halt(threadId, { kind, site: target }, `${target} was tried again after ${NOTE[kind]}`);
      }
      const text = textOf(result);
      state.site = target ?? hostOf(NAVIGATED.exec(text)?.[1]) ?? state.site;
      const told = state.site ? state.final.get(state.site) : undefined;
      if (told && ACTIONS.has(name)) return halt(threadId, { kind: told, site: state.site! }, `${state.site} was tried again after ${NOTE[told]}`);
      if (ACTIONS.has(name)) {
        const key = `${name}:${JSON.stringify(args ?? {})}`;
        const stuck = result.isError === true || (text.includes(UNCHANGED) && !NAVIGATED.test(text));
        state.unchanged = stuck ? (key === state.lastKey ? state.unchanged + 1 : 1) : 0;
        state.lastKey = key;
        if (state.unchanged >= SAME_STEP_LIMIT) {
          return halt(threadId, { kind: "loop", ...(state.site ? { site: state.site } : {}) },
            `the same browser step did nothing ${SAME_STEP_LIMIT} times${state.site ? ` on ${state.site}` : ""}`);
        }
      } else if (name !== "agent_browser_snapshot" && name !== "agent_browser_screenshot" && name !== "agent_browser_status" && name !== "agent_browser_read") {
        state.lastKey = null;
        state.unchanged = 0;
      }
      const kind = terminalKind(text);
      if (!kind && state.site && !state.slowed.has(state.site) && rateLimited(name, text)) {
        state.slowed.add(state.site);
        return { ...result, content: [...(result.content ?? []), { type: "text", text: rateNote(state.site) }] };
      }
      if (!kind || !state.site || told) return result;
      state.final.set(state.site, kind);
      return { ...result, content: [...(result.content ?? []), { type: "text", text: `Metal note: on ${state.site}, ${NOTE[kind]}. That is final: do not retry it, a variation of it, or this site in this turn. Tell the person what happened and what they can do.` }] };
    },

    /** A turn's end forgets what its calls saw. */
    settle(threadId: string): void {
      threads.delete(threadId);
    },
  };
}

export type BrowserLoops = ReturnType<typeof createBrowserLoops>;
