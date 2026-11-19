// request_sign_in's card: the person signs in themselves where the bot works, for what no saved login can fill.
// A human check or bot block goes through Metal's own recovery first (site-block-ladder.ts): wait, reload, the
// person's own connection, another route; the card is the last step, and a task asks for a site at most once.
import type { Surface } from "../../shared/wire.ts";
import { isPendingSignInRequest, normalizeSignInSite } from "../../shared/sign-in-request.ts";
import type { ComputerControl } from "../computer-control.ts";
import { humanCheckCardText, signInCardText } from "../connector-card-text.ts";
import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";
import { withoutCheckAsk } from "./check-ask-filter.ts";
import { otherRoutesHint, type LadderResult } from "./site-block-ladder.ts";

export interface CheckRef { botId: string; threadId: string; site: string; place: Surface }

export interface SignInRequestDeps {
  store: Pick<Store, "appendMessage" | "activePath" | "patchMessage">;
  connectorThread(botId: string, threadId: string): { bot: BotRecord; group: GroupRecord | undefined } | null;
  signInPlace(bot: BotRecord, threadId: string): Surface | null;
  threadLanguage(threadId: string): string | undefined;
  followCard(threadId: string, from: string, to: string): void;
  computerControl: Pick<ComputerControl, "settleHelp" | "requestHelp">;
  signInControlKey(bot: BotRecord, threadId: string, place: Surface): string;
  /** Watches a human check's page and settles its card once the check clears. */
  watchCheck?(ref: { botId: string; threadId: string; messageId: string; site: string; place: Surface }): void;
  /** Metal's own recovery on the page behind a check; `quick` once it already ran for this site in this task. */
  recoverCheck?(ref: CheckRef, options: { quick: boolean }): Promise<LadderResult>;
  now?(): number;
}

export type SignInCard = { messageId: string; site: string; place: Surface; reused?: true };
/** A check request that ended without a new card, and what the bot does next. */
export type CheckAnswer = {
  site: string; place: Surface;
  outcome: "cleared" | "no-check" | "other-routes" | "blocked" | "asked-before";
  via?: "wait" | "home"; homeTried?: boolean; hint?: string;
};
export type SignInRefusal = { status: number; error: string };

/** The ladder ran for this site in this conversation lately: a second request only looks again. */
const RECOVERED_MS = 10 * 60_000;

/** The current task: what came after the person's latest message in the conversation. */
function currentTask(path: readonly Message[]): readonly Message[] {
  let from = 0;
  for (let index = path.length - 1; index >= 0; index--) {
    if (path[index]!.role === "user") { from = index + 1; break; }
  }
  return path.slice(from);
}

export function createSignInRequests(deps: SignInRequestDeps) {
  const now = deps.now ?? Date.now;
  const recovered = new Map<string, number>();

  function postCard(from: BotRecord, threadId: string, owner: { group: GroupRecord | undefined }, target: { url: string; site: string }, place: Surface, reason: string, check: boolean): SignInCard {
    const language = deps.threadLanguage(threadId);
    const card = {
      role: "bot" as const,
      kind: "signin" as const,
      text: check ? humanCheckCardText(from.name, target.site, language) : signInCardText(from.name, target.site, language),
      ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      signIn: { url: target.url, site: target.site, place, ...(reason ? { reason } : {}), ...(check ? { check: true as const } : {}) },
    };
    // a check's ask is the card's alone: the bot's own lines this turn that only said it go, and one that said nothing
    // else becomes the card, so the person sees one ask
    const merged = check ? mergeCheckAsk(threadId, from, owner) : null;
    // Appends the new card first, so a failed append leaves the older one actionable.
    const message = (merged && deps.store.patchMessage(threadId, merged.id, card)) || deps.store.appendMessage(threadId, card);
    for (const prior of deps.store.activePath(threadId)) {
      if (prior.id === message.id || !prior.signIn || !isPendingSignInRequest(prior, target.site, from.id, Boolean(owner.group))) continue;
      deps.store.patchMessage(threadId, prior.id, { signIn: { ...prior.signIn, superseded: true } }); deps.followCard(threadId, prior.id, message.id);
      deps.computerControl.settleHelp(prior.id);
    }
    const ref = { botId: from.id, threadId, messageId: message.id, site: target.site, place };
    deps.computerControl.requestHelp(deps.signInControlKey(from, threadId, place), check ? `human check on ${target.site}` : `sign in to ${target.site}`,
      check ? { ...ref, check: true } : ref);
    if (check) deps.watchCheck?.(ref);
    return { messageId: message.id, site: target.site, place };
  }

  /** The bot's text since the person's latest message and its own latest card; the newest one that only asked, if any. */
  function mergeCheckAsk(threadId: string, from: BotRecord, owner: { group: GroupRecord | undefined }): Message | null {
    const said: Message[] = [];
    for (const message of [...currentTask(deps.store.activePath(threadId))].reverse()) {
      if (message.kind === "signin") break;
      if (message.role === "bot" && message.kind === "text" && typeof message.text === "string" && !message.attachments?.length &&
        (!owner.group || message.from?.botId === from.id)) said.push(message);
    }
    let onlyAsked: Message | null = null;
    for (const message of said) {
      const kept = withoutCheckAsk(message.text!);
      if (kept === message.text!.trim()) continue;
      if (kept) deps.store.patchMessage(threadId, message.id, { text: kept });
      else onlyAsked ??= message;
    }
    return onlyAsked;
  }

  /** The order for a check: one ask per site per task, Metal's own recovery, other routes, and only then the card. */
  async function requestCheck(from: BotRecord, threadId: string, owner: { group: GroupRecord | undefined }, target: { url: string; site: string }, place: Surface, otherRoutes: string):
    Promise<SignInCard | CheckAnswer> {
    const site = target.site;
    const asked = currentTask(deps.store.activePath(threadId)).filter((message) => message.kind === "signin" && message.signIn?.check === true &&
      message.signIn.site === site && (!owner.group || message.from?.botId === from.id));
    const open = asked.find((message) => isPendingSignInRequest(message, site, from.id, Boolean(owner.group)));
    if (open) return { messageId: open.id, site, place, reused: true };
    if (asked.length) return { site, place, outcome: "asked-before" };

    const key = `${from.id}\u0000${threadId}\u0000${site}`;
    for (const [entry, at] of recovered) if (now() - at > RECOVERED_MS) recovered.delete(entry);
    const quick = recovered.has(key);
    const result = deps.recoverCheck ? await deps.recoverCheck({ botId: from.id, threadId, site, place }, { quick }) : { outcome: "unreadable" as const };
    if (result.outcome !== "unreadable") recovered.set(key, now());
    if (result.outcome === "cleared") { recovered.delete(key); return { site, place, outcome: "cleared", via: result.via }; }
    if (result.outcome === "none") return { site, place, outcome: "no-check" };
    const homeTried = "homeTried" in result && result.homeTried;
    // a block is no check a person can answer: another route, or the person hears what could not be done
    if (result.outcome === "blocked") return { site, place, outcome: "blocked", homeTried, hint: otherRoutesHint(site) };
    if (!otherRoutes) return { site, place, outcome: "other-routes", homeTried, hint: otherRoutesHint(site) };
    return postCard(from, threadId, owner, target, place, "", true);
  }

  async function requestSignIn(from: BotRecord, threadId: string, rawSite: unknown, rawReason: unknown, check = false, rawOtherRoutes: unknown = ""):
    Promise<SignInCard | CheckAnswer | SignInRefusal> {
    const owner = deps.connectorThread(from.id, threadId);
    if (!owner) return { status: 403, error: "source conversation does not belong to sender" };
    const target = normalizeSignInSite(rawSite);
    if (!target) return { status: 400, error: "site must be a web address or a domain, such as example.com" };
    const place = deps.signInPlace(from, threadId);
    if (!place) return { status: 409, error: "this conversation has no browser or computer for the person to sign in on" };
    if (check) return requestCheck(from, threadId, owner, target, place, typeof rawOtherRoutes === "string" ? rawOtherRoutes.trim().slice(0, 400) : "");
    const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 240) : "";
    return postCard(from, threadId, owner, target, place, reason, false);
  }

  return { requestSignIn };
}
