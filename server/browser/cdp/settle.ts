// Before a page is read: a bot-check interstitial that clears by itself is waited out, and loading skeletons and spinners
// get a moment to turn into content, so a read does not come back as a placeholder.
import { isUnanswered } from "./errors.ts";
import { valueInWorld } from "./evaluate.ts";
import type { FrameTree } from "./frames.ts";

export const CHALLENGE_WAIT_MS = 15_000;
/** A site whose check already cleared in this browser: its cookie usually lets the next page straight through. */
export const CHALLENGE_REPEAT_WAIT_MS = 3_000;
export const BUSY_WAIT_MS = 2_000;
/** A fresh document with no controls yet is usually an app still drawing itself. */
export const EMPTY_WAIT_MS = 1_000;
const CHALLENGE_POLL_MS = 1_000;
const BUSY_POLL_MS = 100;
const QUIET_MS = 150;

/** "Site" is a block with no vendor's markers: a 403 or 429 page, an "unusual traffic" or "are you a robot" page. */
export type ChallengeVendor = "Cloudflare" | "DataDome" | "PerimeterX" | "Imperva" | "Akamai" | "AWS WAF" | "Vercel" | "DDoS-Guard" | "Site";
export type ChallengeState = "checking" | "needs-user" | "blocked";
export interface Challenge { vendor: ChallengeVendor; state: ChallengeState }

/** What the isolated world sees of the document, enough to tell an interstitial and a loading page apart. */
export interface PageProbe {
  title: string;
  text: string;
  textLength: number;
  nodes: number;
  controls: number;
  busy: boolean;
  scripts: string[];
  iframes: string[];
  selectors: string[];
  /** The document's HTTP status, 0 when unknown. */
  status?: number;
  host?: string;
  /** A check widget on the page already holds its answer token. */
  answered?: boolean;
}

const MARKERS = ["#challenge-running", "#challenge-stage", "#challenge-form", "#cf-challenge-running", ".cf-browser-verification", "#cf-error-details",
  "#px-captcha", "#sec-if-cpt-container", "#sec-cpt-if", "awswaf-captcha", "#captcha-container"] as const;
export const BUSY = `[aria-busy="true"],[class*="skeleton" i],[class*="shimmer" i],[class*="spinner" i],[role="progressbar"]:not([aria-valuenow])`;
const CONTROLS = `a[href],button,input,select,textarea,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]`;

export const PROBE_EXPRESSION = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0; };
  const body = document.body;
  const text = body ? body.innerText : "";
  return {
    title: document.title.slice(0, 200),
    text: text.slice(0, 1500),
    textLength: text.length,
    nodes: document.getElementsByTagName("*").length,
    controls: document.querySelectorAll(${JSON.stringify(CONTROLS)}).length,
    // behind a modal (a consent wall, a dialog) the page waits on the person, so only what loads inside the modal counts
    busy: (() => { const modal = [...document.querySelectorAll('[aria-modal="true"],dialog[open]')].find(visible); return [...document.querySelectorAll(${JSON.stringify(BUSY)})].slice(0, 50).some((el) => visible(el) && (!modal || modal.contains(el))); })(),
    scripts: [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 60).map((src) => src.slice(0, 300)),
    iframes: [...document.querySelectorAll("iframe")].map((f) => f.src).filter(Boolean).slice(0, 30).map((src) => src.slice(0, 300)),
    selectors: ${JSON.stringify(MARKERS)}.filter((selector) => document.querySelector(selector) !== null),
    status: (() => { try { return performance.getEntriesByType("navigation")[0]?.responseStatus || 0; } catch { return 0; } })(),
    host: location.hostname.slice(0, 253),
    answered: [...document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]')]
      .some((field) => typeof field.value === "string" && field.value.length > 0),
  };
})()`;

const has = (probe: PageProbe, selector: (typeof MARKERS)[number]) => probe.selectors.includes(selector);
const anyUrl = (urls: readonly string[], pattern: RegExp) => urls.some((url) => pattern.test(url));
/** A check widget a person answers: Turnstile, reCAPTCHA or hCaptcha, not an invisible one. */
const CHECK_WIDGET = /^https:\/\/(?:challenges\.cloudflare\.com\/|(?:www\.google\.com|www\.recaptcha\.net)\/recaptcha\/|(?:[\w-]+\.)?hcaptcha\.com\/)/u;
export const widgetShown = (frames: readonly string[]) => frames.some((url) => CHECK_WIDGET.test(url) && !/[?&]size=invisible\b/u.test(url));

/** The widget whose frame is the checkbox a person ticks ("verify you are human"), or null for any other frame. */
export function checkboxVendor(url: string): string | null {
  if (/[?&]size=invisible\b/u.test(url)) return null;
  if (url.startsWith("https://challenges.cloudflare.com/")) return "Cloudflare Turnstile";
  if (/^https:\/\/(?:www\.google\.com|www\.recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/anchor\b/u.test(url)) return "reCAPTCHA";
  if (/^https:\/\/(?:[\w-]+\.)?hcaptcha\.com\/.*[#&?]frame=checkbox\b/u.test(url)) return "hCaptcha";
  return null;
}
/** What a bot wall says, in any vendor's or site's words; only read on a short page, where it is the page's point. */
const BOT_WALL = new RegExp([
  "unusual traffic", "automated (?:queries|requests|traffic|access)", "are you a (?:robot|human)", "(?:i'm|i am|you're|you are) not a robot",
  "verify (?:that )?you(?:'re| are) (?:a )?human", "prove you(?:'re| are) (?:a )?human", "confirm you(?:'re| are) not a bot", "press (?:&|and) hold",
  "blocked by (?:network|our) security", "(?:request|access) (?:was |has been )?(?:blocked|denied)", "bot (?:detection|protection|traffic)",
  "suspicious (?:activity|traffic)", "too many requests", "you have been (?:rate[- ]limited|blocked)",
].join("|").replace(/'/gu, "['\u2019]?"), "iu");

/** Which vendor's interstitial the page is, and whether it clears by itself; null for an ordinary page. */
export function classifyChallenge(probe: PageProbe, frameUrls: readonly string[] = []): Challenge | null {
  const { title, text } = probe;
  const frames = [...probe.iframes, ...frameUrls];
  const short = probe.textLength < 2_000;

  if (/Attention Required! \| Cloudflare/iu.test(title) || (has(probe, "#cf-error-details") && /Sorry, you have been blocked|Error 10\d\d/iu.test(text))) return { vendor: "Cloudflare", state: "blocked" };
  // Cloudflare loads its challenge-platform script on ordinary pages too (x.com does), so the script alone counts only on a
  // page with nothing on it yet
  const cloudflare = /^Just a moment/iu.test(title) || has(probe, "#challenge-running") || has(probe, "#challenge-stage") || has(probe, "#challenge-form") ||
    has(probe, "#cf-challenge-running") || has(probe, ".cf-browser-verification") ||
    (probe.textLength < 300 && probe.controls === 0 && anyUrl(probe.scripts, /\/cdn-cgi\/challenge-platform\//u));
  if (cloudflare && short) return { vendor: "Cloudflare", state: "checking" };

  const datadome = frames.find((url) => /^https:\/\/(?:geo\.)?captcha-delivery\.com\//u.test(url));
  if (datadome) return { vendor: "DataDome", state: /[?&]t=bv(?:&|$)/u.test(datadome) ? "blocked" : "needs-user" };

  if (has(probe, "#px-captcha")) return { vendor: "PerimeterX", state: "needs-user" };

  if (/Incapsula incident ID/iu.test(text)) return { vendor: "Imperva", state: "blocked" };
  if (short && probe.textLength < 300 && (anyUrl(probe.scripts, /\/_Incapsula_Resource\b/u) || anyUrl(frames, /\/_Incapsula_Resource\b/u))) return { vendor: "Imperva", state: "checking" };

  if (/^Access Denied$/iu.test(title.trim()) && /You don't have permission to access|Reference #\d/iu.test(text)) return { vendor: "Akamai", state: "blocked" };
  if (has(probe, "#sec-if-cpt-container") || has(probe, "#sec-cpt-if")) return { vendor: "Akamai", state: "checking" };

  if (has(probe, "awswaf-captcha") || (has(probe, "#captcha-container") && anyUrl(probe.scripts, /awswaf\.com\//u))) return { vendor: "AWS WAF", state: "needs-user" };
  if (short && probe.textLength < 300 && anyUrl(probe.scripts, /\.awswaf\.com\/.*challenge\.js/u)) return { vendor: "AWS WAF", state: "checking" };

  if (/^Vercel Security Checkpoint/iu.test(title)) return { vendor: "Vercel", state: "checking" };
  if (/^DDoS-Guard/iu.test(title) || (short && anyUrl(probe.scripts, /ddos-guard\.net\//u) && /Checking your browser/iu.test(text))) return { vendor: "DDoS-Guard", state: "checking" };

  // no vendor's markers: a bot wall by its words or its status. a check widget on it is a person's; without one it is a block
  const status = probe.status ?? 0;
  const wall = short && BOT_WALL.test(`${title}\n${text}`);
  if (wall && /press (?:&|and) hold/iu.test(`${title}\n${text}`)) return { vendor: "PerimeterX", state: "needs-user" };
  if (wall || (short && probe.textLength < 600 && (status === 403 || status === 429))) return { vendor: "Site", state: widgetShown(frames) ? "needs-user" : "blocked" };
  return null;
}

export interface SettleTarget {
  readonly frames: FrameTree;
  /** Resolves once the current document reached load, or rejects after `timeoutMs`. */
  loaded(timeoutMs: number): Promise<void>;
}

/** Any engine's page, as the settle loop reads it. */
export interface PageReader {
  /** Null while the page is between documents, as it is the moment a check clears and the site loads. */
  probe(): Promise<PageProbe | null>;
  frameUrls(): readonly string[];
  loaded(timeoutMs: number): Promise<void>;
  /** True once the call may no longer act, such as when a person took the browser: the wait ends at once. */
  stopped?(): boolean;
}

export interface SettleReport {
  /** The interstitial met first, how it ended, and how long it was waited out. */
  challenge?: Challenge & { cleared: boolean; waitedMs: number };
  /** Skeletons or spinners were still showing when the wait ran out. */
  stillBusy?: boolean;
  /** A "verify you are human" checkbox on the page, and whether it holds its answer token now. */
  checkbox?: { vendor: string; answered: boolean };
}

export interface SettleOptions {
  deadline: number;
  fresh?: boolean;
  now?: () => number;
  cleared?: Set<string>;
}

/** Turnstile often ticks itself within a few seconds of showing. */
export const CHECKBOX_TOKEN_WAIT_MS = 3_000;
const TOKEN_POLL_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cdpReader(target: SettleTarget): PageReader {
  return {
    probe: async () => {
      try {
        return await valueInWorld<PageProbe>(target.frames, target.frames.mainFrameId, PROBE_EXPRESSION);
      } catch (error) {
        if (isUnanswered(error)) throw error;
        return null;
      }
    },
    frameUrls: () => target.frames.all().map((frame) => frame.url),
    loaded: (timeoutMs) => target.loaded(timeoutMs),
  };
}

const turnstileShown = (reader: PageReader, probe: PageProbe | null) => [...reader.frameUrls(), ...probe?.iframes ?? []].some((url) => url.startsWith("https://challenges.cloudflare.com/"));
/** A nearly empty document with nothing to act on: an app that has not drawn itself yet. */
const unpainted = (probe: PageProbe) => probe.controls === 0 && probe.textLength < 200;

/**
 * Waits out a self-clearing check, then loading placeholders, never past `deadline`. A "verify you are human" checkbox
 * still waiting on someone gets a moment to answer itself. `cleared`: the hosts whose check already cleared in this
 * browser; a check there is waited out briefly, then reported.
 */
export async function settlePage(target: SettleTarget | PageReader, options: SettleOptions): Promise<SettleReport> {
  const reader = "probe" in target ? target : cdpReader(target);
  const { report, probe } = await waitOut(reader, options);
  const check = report.challenge;
  if (!probe || reader.stopped?.() === true || (check && (check.cleared || check.state !== "needs-user"))) return report;
  const checkbox = await tokenWait(reader, probe, options);
  if (checkbox) report.checkbox = checkbox;
  return report;
}

async function tokenWait(reader: PageReader, first: PageProbe, { deadline, now = Date.now }: SettleOptions): Promise<SettleReport["checkbox"]> {
  const vendor = [...first.iframes, ...reader.frameUrls()].map(checkboxVendor).find((found) => found !== null) ?? null;
  if (!vendor) return undefined;
  const until = Math.min(deadline, now() + CHECKBOX_TOKEN_WAIT_MS);
  let probe = first;
  while (probe.answered !== true && now() + TOKEN_POLL_MS <= until && reader.stopped?.() !== true) {
    await sleep(TOKEN_POLL_MS);
    probe = await reader.probe() ?? probe;
  }
  return { vendor, answered: probe.answered === true };
}

async function waitOut(reader: PageReader, { deadline, fresh = false, now = Date.now, cleared }: SettleOptions): Promise<{ report: SettleReport; probe: PageProbe | null }> {
  const stopped = () => reader.stopped?.() === true;
  const report: SettleReport = {};
  let probe = await reader.probe();
  const met = probe ? classifyChallenge(probe, reader.frameUrls()) : null;
  if (met) {
    const started = now();
    const host = probe?.host;
    const until = Math.min(deadline, started + (host && cleared?.has(host) ? CHALLENGE_REPEAT_WAIT_MS : CHALLENGE_WAIT_MS));
    let current: Challenge | null = met;
    while (current?.state === "checking" && now() + CHALLENGE_POLL_MS <= until && !stopped()) {
      await sleep(CHALLENGE_POLL_MS);
      if (stopped()) break;
      const next = await reader.probe();
      if (!next) continue;
      probe = next;
      current = classifyChallenge(next, reader.frameUrls());
    }
    if (current) {
      const state = current.vendor === "Cloudflare" && current.state === "checking" && turnstileShown(reader, probe) ? "needs-user" : current.state;
      report.challenge = { ...current, state, cleared: false, waitedMs: now() - started };
      return { report, probe };
    }
    report.challenge = { ...met, cleared: true, waitedMs: now() - started };
    if (host) cleared?.add(host);
    await reader.loaded(Math.max(0, Math.min(5_000, deadline - now()))).catch(() => undefined);
    probe = await reader.probe();
  }
  if (!probe || stopped() || !(probe.busy || (fresh && unpainted(probe)))) return { report, probe };
  const busyUntil = Math.min(deadline, now() + BUSY_WAIT_MS);
  const emptyUntil = Math.min(deadline, now() + EMPTY_WAIT_MS);
  let signature = `${probe.nodes}:${probe.textLength}`;
  let quietSince = now();
  while (now() + BUSY_POLL_MS <= busyUntil) {
    await sleep(BUSY_POLL_MS);
    if (stopped()) return { report, probe };
    const next = await reader.probe();
    if (!next) continue;
    const nextSignature = `${next.nodes}:${next.textLength}`;
    if (nextSignature !== signature) { signature = nextSignature; quietSince = now(); }
    probe = next;
    const waiting = next.busy || now() - quietSince < QUIET_MS || (fresh && unpainted(next) && now() < emptyUntil);
    if (!waiting) return { report, probe };
  }
  if (probe.busy) report.stillBusy = true;
  return { report, probe };
}

/** What a bot does about a check or block that did not clear: never solve it, let Metal's recovery run, ask last. */
export const BLOCKED_NEXT = "Never click it, solve it or try to hide that you are a bot. Do not wait or reload yourself: call request_sign_in with the site and human_check true now. " +
  "Metal waits it out, reloads once and tries the person's own connection before anyone is asked, and tells you what to do next.";

/** Where a page's bot check stands, as every page read reports it. */
export type CheckStatus = "cleared" | "checking" | "needs one click" | "needs you" | "blocked";

/** The centre of a "verify you are human" checkbox in the page's viewport, in the CSS pixels the click tool takes. */
export interface CheckboxPoint {
  x: number;
  y: number;
}

/** The page's bot check, or null on a page that showed none. `point`: the one checkbox click offered, if any. */
export function checkStatus(report: SettleReport, point: CheckboxPoint | null = null): { status: CheckStatus; vendor: string | null } | null {
  const check = report.challenge;
  const box = report.checkbox;
  const named = (vendor: string | undefined) => (vendor && vendor !== "Site" ? vendor : box?.vendor ?? null);
  if (check?.cleared) return { status: "cleared", vendor: named(check.vendor) };
  if (check && check.state !== "needs-user") return { status: check.state, vendor: named(check.vendor) };
  if (!check && !box) return null;
  if (box?.answered) return { status: check ? "checking" : "cleared", vendor: named(check?.vendor) };
  return { status: point ? "needs one click" : "needs you", vendor: named(check?.vendor) };
}

/** What a bot may do about a checkbox it was offered: one click on it, and nothing more. */
function oneClick(point: CheckboxPoint): string {
  return `The checkbox is at ${Math.round(point.x)},${Math.round(point.y)}. You may click that point once with agent_browser_click (x and y), then read the page again. ` +
    "Never click it a second time, answer a puzzle it shows or try to hide that you are a bot: if the check is still there after that one click, call request_sign_in with the site and human_check true.";
}

/** The report as one line of a tool's answer, or null when there is nothing to say. `point`: the checkbox click offered. */
export function settleNote(report: SettleReport, point: CheckboxPoint | null = null): string | null {
  const lines: string[] = [];
  const status = checkStatus(report, point);
  if (status) lines.push(`Bot check: ${status.status}${status.vendor ? ` (${status.vendor})` : ""}.`);
  const check = report.challenge;
  if (check) {
    const waited = `${Math.round(check.waitedMs / 1_000)} s`;
    const what = check.vendor === "Site" ? "bot check" : `${check.vendor} bot check`;
    if (check.cleared) lines.push(`The site ran a ${what} first; it cleared by itself after ${waited}.`);
    else if (status?.status === "checking" && report.checkbox?.answered) lines.push("Its checkbox ticked itself and the site is letting the browser through: read the page again in a moment.");
    else lines.push(`The site still shows a ${check.state === "blocked" ? "bot block" : what} after ${waited}. ${status?.status === "needs one click" && point ? oneClick(point) : BLOCKED_NEXT}`);
  } else if (status?.status === "cleared") {
    lines.push("The page's checkbox ticked itself.");
  } else if (status) {
    // a checkbox beside the page's own content, such as on a sign-up form: it stands only between the bot and submitting
    lines.push(`The page has a "verify you are human" checkbox, which matters only to submit its form. ${point && status.status === "needs one click"
      ? oneClick(point) : "If you must submit it, call request_sign_in with the site and human_check true; never solve it or try to hide that you are a bot."}`);
  }
  if (report.stillBusy) lines.push(`Parts of the page were still loading after ${BUSY_WAIT_MS / 1_000} s (placeholders or spinners). If what you need is missing, wait for it and read again.`);
  return lines.length ? lines.join(" ") : null;
}
