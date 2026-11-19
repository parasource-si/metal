// What Metal does by itself when a page shows a bot check or a bot block, before anyone is asked: wait it out (most
// "Verifying..." pages clear in a normal browser), reload once, then send that one site through the person's own
// connection when their computer is linked and online. One ladder for every site and every kind of wall; it only reads
// and reloads, and never clicks, answers or hides anything (no captcha solving, no stealth).
import { classifyChallenge } from "../browser/cdp/settle.ts";
import { humanCheckState, type HumanCheckPage } from "./human-check-watch.ts";

/** An interstitial that clears by itself does so within this; past it a person or another route is needed. */
export const LADDER_WAIT_MS = 45_000;
/** The one reload of an interstitial, partway through the wait. */
export const LADDER_RELOAD_AT_MS = 20_000;
/** A hard block (403, "access denied", a captcha) does not clear by waiting: one reload and a short look. */
export const HARD_BLOCK_WAIT_MS = 8_000;
/** Chromium rereads its policy folder a few seconds after it changes, so the new route applies to the next load. */
export const HOME_SETTLE_MS = 7_000;
export const HOME_WAIT_MS = 25_000;
const HOME_RELOAD_AT_MS = 12_000;
export const LADDER_POLL_MS = 2_500;
/** Two clear reads in a row, so the gap while the site swaps documents is not taken for the end of the wall. */
const CLEAR_READS = 2;

/** clear; checking: an interstitial still working by itself; check: a person must answer it; blocked: refused outright. */
export type WallState = "clear" | "checking" | "check" | "blocked";

export function wallState(page: HumanCheckPage): WallState {
  if (classifyChallenge(page)?.state === "checking") return "checking";
  return humanCheckState(page);
}

export interface LadderDeps {
  /** The page as it is now, or null when it cannot be read (between documents, or a place Metal cannot read). */
  read(): Promise<HumanCheckPage | null>;
  reload(): Promise<unknown>;
  /** Sends this site out through the person's own connection; false when that cannot happen now (off, offline, no link). */
  homeRoute?(): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export type LadderResult =
  | { outcome: "cleared"; via: "wait" | "home"; waitedMs: number }
  /** Metal sees no check or block on the page. */
  | { outcome: "none" }
  | { outcome: "unreadable" }
  | { outcome: "check" | "blocked"; homeTried: boolean; waitedMs: number };

/** `quick`: the ladder already ran for this site in this task, so only look once more. */
export async function runSiteBlockLadder(deps: LadderDeps, { quick = false }: { quick?: boolean } = {}): Promise<LadderResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const first = await deps.read().catch(() => null);
  if (!first) return { outcome: "unreadable" };
  let last = wallState(first);
  if (last === "clear") return quick ? { outcome: "cleared", via: "wait", waitedMs: 0 } : { outcome: "none" };
  if (quick) return { outcome: last === "blocked" ? "blocked" : "check", homeTried: true, waitedMs: 0 };

  /** Polls for `limitMs`, reloading once at `reloadAtMs`; true once the wall is gone. */
  async function watch(limitMs: number, reloadAtMs: number): Promise<boolean> {
    const from = now();
    let reloaded = false;
    let clearReads = 0;
    while (now() - from < limitMs) {
      await sleep(LADDER_POLL_MS);
      if (!reloaded && now() - from >= reloadAtMs) {
        reloaded = true;
        clearReads = 0;
        await deps.reload().catch(() => undefined);
        continue;
      }
      const page = await deps.read().catch(() => null);
      if (!page) { clearReads = 0; continue; }
      const state = wallState(page);
      if (state === "clear") {
        if (++clearReads >= CLEAR_READS) return true;
        continue;
      }
      clearReads = 0;
      last = state;
    }
    return false;
  }

  const interstitial = last === "checking";
  if (await watch(interstitial ? LADDER_WAIT_MS : HARD_BLOCK_WAIT_MS, interstitial ? LADDER_RELOAD_AT_MS : 0)) {
    return { outcome: "cleared", via: "wait", waitedMs: now() - started };
  }
  let homeTried = false;
  if (deps.homeRoute && await deps.homeRoute().catch(() => false)) {
    homeTried = true;
    await sleep(HOME_SETTLE_MS);
    await deps.reload().catch(() => undefined);
    if (await watch(HOME_WAIT_MS, HOME_RELOAD_AT_MS)) return { outcome: "cleared", via: "home", waitedMs: now() - started };
  }
  return { outcome: last === "blocked" ? "blocked" : "check", homeTried, waitedMs: now() - started };
}

/** Common sites that offer a better route than their web form; a hint, not a rule: anything else gets the general advice. */
const SITE_ROUTES: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)pastebin\.com$/u, "Pastebin has an API (POST https://pastebin.com/api/api_post.php with an api_dev_key the person can give through request_credential); a GitHub gist (gh, or the GitHub connected app) or another paste site such as dpaste.org or paste.rs (curl) also does the job"],
  [/(^|\.)github\.com$/u, "use gh or the GitHub connected app, or api.github.com"],
  [/(^|\.)(google\.[a-z.]+)$/u, "use your web search tool rather than Google's page"],
  [/(^|\.)(youtube\.com|youtu\.be)$/u, "use the YouTube connected app, or read the video's details with your web or read tools"],
  [/(^|\.)(x\.com|twitter\.com)$/u, "use the X connected app"],
  [/(^|\.)linkedin\.com$/u, "use the LinkedIn connected app"],
  [/(^|\.)reddit\.com$/u, "use the Reddit connected app"],
  [/(^|\.)(instagram\.com|facebook\.com|threads\.net)$/u, "use the matching connected app"],
  [/(^|\.)(wikipedia\.org)$/u, "use the Wikipedia API (https://en.wikipedia.org/w/api.php) with curl"],
];

/** Other ways to the same goal, for a site that keeps a bot out: the site's own hint first, then the general ones. */
export function otherRoutesHint(site: string): string {
  const own = SITE_ROUTES.find(([pattern]) => pattern.test(site))?.[1];
  return [
    ...(own ? [`For ${site}: ${own}.`] : []),
    "In general: the site's official API (curl, or vm_exec on your computer); a connected app that does the same job; another site or service that does it; " +
    "and, when you have the mac_ tools and the person's Mac is online, the same request from their Mac (mac_exec with curl), which leaves through their home connection.",
  ].join(" ");
}
