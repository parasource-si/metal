// Runs one browser tool call: picks the tab, runs the action under the profile's control, and words the answer.
//
// Adapted from pingdotgg/t3code@00cdceb1 apps/server/src/preview/ServerBrowser.ts (runOperation, executeTabOperation,
// navigate, status) and apps/server/src/mcp/PreviewAutomationBroker.ts, MIT License, Copyright (c) 2026 T3 Tools Inc.
// (full text in third_party/t3-code/LICENSE); modified: one in-process host instead of a broker, tabs that belong to
// the profile, the CDP driver instead of Playwright, and Metal's page-change and page-health lines.
import { describePageChange, sanitizeUrl, type PageState } from "../browser-tool-shape.ts";
import type { CdpBrowser } from "./cdp/browser.ts";
import type { Download } from "./cdp/downloads.ts";
import { DriverError, isUnanswered } from "./cdp/errors.ts";
import { callOnNode, valueInWorld } from "./cdp/evaluate.ts";
import type { PointerReporter } from "./cdp/actions.ts";
import { navigable } from "./cdp/page.ts";
import type { Screenshot } from "./cdp/screencast.ts";
import { resolveElement } from "./cdp/selectors.ts";
import { checkboxPoint } from "./cdp/checkbox.ts";
import { CONSENT_LOOK_MS, consentNote, rejectConsent } from "./cdp/consent.ts";
import { checkStatus, settleNote, settlePage, type CheckboxPoint } from "./cdp/settle.ts";
import { MAX_VISIBLE_TEXT_LENGTH } from "./cdp/snapshot.ts";
import { around, newElements, newElementsNote, settleAfterAction } from "./after-action.ts";
import { errorishLines, errorsNote, shownErrors, SUBMIT_NAME } from "./page-errors.ts";
import { runBatch } from "./batch.ts";
import { PersonHoldAnswer } from "../browser-refusals.ts";
import { BROWSER_CONTROL_REFUSAL, type HoldWait, type ProfileControl, type Scope } from "./control.ts";
import { BrowserControlInterrupted } from "./session-control.ts";
import { errorResult, pageLabel, snapshotText, textResult, withParts, type ToolResult } from "./shape.ts";
import type { Tab, TabRegistry } from "./tabs.ts";
import { targetOf, type ToolCall, type ToolInput } from "./tools.ts";

/** The hosts whose bot check cleared in each browser. */
const clearedChecks = new WeakMap<object, Set<string>>();

export const DEFAULT_ACTION_MS = 15_000;
/** Kept back from a call's budget for the reads after its action. */
const FOLLOW_UP_MS = 5_000;
const OBSERVE_TEXT_CHARS = 200_000;
/** The longest an action's answer waits for a navigation the page asked for to show its next page. */
const NAVIGATION_FOLLOW_MS = 10_000;
const OBSERVE_PAGE = `({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, ${OBSERVE_TEXT_CHARS}) })`;
const ELEMENT_TEXT = "function () { return String(this.innerText ?? this.textContent ?? this.value ?? ''); }";

export const SECRET_ON_PAGE_EVAL = "A saved password was just filled on this page, so agent_browser_eval is refused here for now. Submit the form or open another page first; to read this page, use agent_browser_snapshot or agent_browser_read.";

export interface BrowserStatus {
  tab: string | null;
  url: string | null;
  title: string;
  loading: boolean;
  tabs: Array<{ tab: string; url: string; title: string; active: boolean; openedBy?: string }>;
  heldByPerson: boolean;
  /** The tabs a person holds: calls on them wait for the hand-back, other tabs still work. */
  heldTabs: string[];
  dialog: { type: string; message: string; defaultPrompt?: string } | null;
  fileChooser: { multiple: boolean } | null;
  signInPrompt: { origin: string; realm: string } | null;
  downloads: Array<{ fileName: string; path: string | null; sizeBytes: number; url: string; state: string }>;
}

export interface ToolContext {
  readonly control: ProfileControl<Tab>;
  readonly tabs: TabRegistry;
  readonly browser: CdpBrowser;
  readonly deadline: number;
  active(): Tab | null;
  openTab(url?: string): Promise<Tab>;
  closeTab(tab: Tab): Promise<void>;
  closeBrowser(): Promise<void>;
  pointer(tab: Tab): PointerReporter | undefined;
  /** Viewers' screencasts stop while a scaled capture renders, or they would show it. */
  paused<T>(tab: Tab, work: () => Promise<T>): Promise<T>;
  health(tab: Tab): string | null;
  secretOnPage(tab: Tab): Promise<boolean>;
  /** What the bot is told when `secretOnPage` says yes, when it is not a saved password. */
  secretNote?(): string | null;
  saveScreenshot(data: Buffer, pageUrl: string): string;
  downloads(): Download[];
  /** Whether cookie banners on `tab` are answered for the bot: a tab it opened, never one a person opened or holds. */
  answersConsent?(tab: Tab): boolean;
  /** A step of a batch: what the page brought up is reported once, after the batch. */
  readonly inBatch?: boolean;
  /** Throws once the call may no longer act, such as when its turn ended; a batch checks it between steps. */
  checkpoint?(): void;
}

/** A typed address with its scheme: a bare host means https, loopback http. */
const withScheme = (text: string) => /^[a-z][a-z\d+.-]*:\/\//iu.test(text) ? text : `${/^(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)/iu.test(text) ? "http" : "https"}://${text}`;

/** What a bot passed as an address. */
export function agentUrl(raw: string): string {
  const text = raw.trim();
  if (text === "about:blank" || /^data:/iu.test(text)) return text;
  let url: URL;
  try { url = new URL(withScheme(text)); } catch { throw new DriverError("refused", `${text.slice(0, 200)} is not an address the browser can open.`); }
  if (!navigable(url.href)) throw new DriverError("refused", `Only http(s), about:blank and data: addresses open here, not ${url.protocol}.`);
  return url.href;
}

/** An address a person typed in the panel: http(s) only, never credentials, and null rather than an error. */
export function personUrl(raw: string): string | null {
  const text = raw.trim().slice(0, 8_192);
  if (!text || [...text].some((char) => char <= " " || char === "\u007f" || char === "\\")) return null;
  try {
    const url = new URL(withScheme(text));
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function remaining(context: ToolContext, preferred = DEFAULT_ACTION_MS): number {
  return Math.max(1_000, Math.min(preferred, context.deadline - Date.now() - FOLLOW_UP_MS));
}

function tabOf(context: ToolContext, id: string | undefined): Tab {
  if (id) {
    const tab = context.tabs.get(id);
    if (!tab) throw new DriverError("not-found", `There is no tab ${id}. agent_browser_tabs lists the open ones.`);
    return tab;
  }
  const active = context.active();
  if (!active) throw new DriverError("not-found", "No tab is open. Call agent_browser_open.");
  return active;
}

async function observe(tab: Tab): Promise<PageState | null> {
  try {
    const value = await valueInWorld<PageState>(tab.page.frames, tab.page.frames.mainFrameId, OBSERVE_PAGE);
    return value && typeof value.url === "string" ? value : null;
  } catch {
    return null;
  }
}

function describe(tab: Tab): { url: string; title: string; tab: string } {
  return { url: tab.page.url(), title: tab.page.title(), tab: tab.id };
}

/** A tab's state for agent_browser_status, the title left out while a dialog is open, as T3 Code does. */
export function statusOf(context: Pick<ToolContext, "tabs" | "control" | "active" | "downloads">, tab: Tab | null = null): BrowserStatus {
  const front = context.active();
  const active = tab ?? front;
  const dialog = active?.page.dialogs.pending ?? null;
  const chooser = active?.page.fileChoosers.open ?? null;
  const auth = active?.page.auth.pending ?? null;
  return {
    tab: active?.id ?? null,
    url: active && active.page.url() !== "about:blank" ? sanitizeUrl(active.page.url()) || active.page.url() : null,
    title: dialog ? "" : active?.page.title() ?? "",
    loading: active ? !active.page.lifecycle.reached("load") : false,
    tabs: context.tabs.list().map((listed) => ({
      tab: listed.id, url: sanitizeUrl(listed.page.url()) || listed.page.url(), title: listed.page.title(), active: listed === front,
      ...(listed.openerTabId ? { openedBy: listed.openerTabId } : {}),
    })),
    heldByPerson: context.control.owner !== null,
    heldTabs: context.control.heldTabs().map((held) => held.id),
    dialog: dialog ? { type: dialog.type, message: dialog.message, ...(dialog.type === "prompt" ? { defaultPrompt: dialog.defaultPrompt } : {}) } : null,
    fileChooser: chooser ? { multiple: chooser.multiple } : null,
    signInPrompt: auth ? { origin: auth.origin, realm: auth.realm } : null,
    downloads: context.downloads().filter((download) => download.state !== "inProgress").slice(-20).map((download) => ({
      fileName: download.fileName, path: download.path, sizeBytes: download.receivedBytes, url: sanitizeUrl(download.url), state: download.state,
    })),
  };
}

function signInWait(tab: Tab, url: string, prompt: { origin: string; realm: string }): string {
  return `${tab.id} is waiting at ${sanitizeUrl(url) || url}: the site asks for a user name and password (HTTP sign-in for ${prompt.origin}${prompt.realm ? `, "${prompt.realm.slice(0, 100)}"` : ""}). The person watching this browser can answer it, and the page loads once they do; agent_browser_status shows the prompt until then. Do not try to answer it yourself.`;
}

/** A dialog the action opened ends its answer: nothing else runs on the tab until it is answered. */
function dialogNote(tab: Tab): string | null {
  const dialog = tab.page.dialogs.pending;
  return dialog ? `The page opened a ${dialog.type} dialog: ${JSON.stringify(dialog.message.slice(0, 300))}. Answer it with agent_browser_dialog before anything else on ${tab.id}.` : null;
}

const POPUP_WAIT_MS = 2_000;

/** A tab the action made the page open, such as a sign-in popup: it is set up, then named. */
async function openedNote(context: ToolContext, tab: Tab, known: ReadonlySet<string>): Promise<string | null> {
  for (const page of context.browser.settingUp()) {
    if (page.openerId === tab.page.targetId) await context.browser.waitForPage((candidate) => candidate === page, POPUP_WAIT_MS).catch(() => undefined);
  }
  const opened = context.tabs.list().filter((candidate) => !known.has(candidate.id) && candidate.openerTabId === tab.id);
  if (!opened.length) return null;
  await context.browser.refreshTargets().catch(() => undefined);
  const front = context.active();
  return opened.map((candidate) => `The page opened a new tab ${candidate.id} at ${sanitizeUrl(candidate.page.url()) || candidate.page.url()}${candidate === front ? ", now in front" : ""}; take a snapshot to act on it.`).join(" ");
}

/** Where a tab the bot opened is: in front, or beside the one a person holds, which stays in front. */
function frontNote(context: ToolContext): string {
  return context.control.owner === null ? "It is in front;" : `It opened beside ${context.control.heldTabs().map((held) => held.id).join(", ")}, which the person holds and which stays in front;`;
}

/** A call waits on a held tab until its reads after would no longer fit, and stops with its turn. */
function holdWait(context: ToolContext): HoldWait {
  return { until: context.deadline - FOLLOW_UP_MS, ...(context.checkpoint ? { checkpoint: context.checkpoint } : {}) };
}

/** Bot work on `scope`, waiting out a person's hold on it within the call. */
function bot<R>(context: ToolContext, scope: Scope<Tab>, run: () => Promise<R>): Promise<R> {
  return context.control.agent(scope, run, holdWait(context));
}

/** Runs `run` as bot work on `tab` (or the whole browser), with what the page did and reported after it. */
async function act(context: ToolContext, tab: Tab | null, run: () => Promise<ToolResult>, { observeChange = false, expectsChange = false, submits = false } = {}): Promise<ToolResult> {
  return bot(context, tab, async () => {
    const known = new Set(context.tabs.list().map((candidate) => candidate.id));
    const before = observeChange && tab ? await observe(tab) : null;
    const errorsBefore = before && tab ? await shownErrors(tab) : [];
    const mark = before && tab ? tab.page.navigations.mark() : null;
    const refMark = tab?.page.refs.mark ?? 0;
    const result = await run();
    if (!tab || result.isError) return result;
    // An open dialog blocks the page's scripts, so the page is read again only once it is answered.
    if (mark && !tab.page.dialogs.pending) await tab.page.navigations.follow(mark, Math.min(NAVIGATION_FOLLOW_MS, remaining(context)));
    const reports = before !== null && !context.inBatch && !tab.page.dialogs.pending;
    if (reports) await settleAfterAction(tab, context.deadline - FOLLOW_UP_MS, { textBefore: expectsChange && before ? before.text.length : null });
    const after = before && !tab.page.dialogs.pending ? await observe(tab) : null;
    const opened = observeChange ? await openedNote(context, tab, known) : null;
    const shown = after ? await shownErrors(tab) : [];
    const plain = before && after && after.url === before.url ? errorishLines(before.text, after.text).filter((line) => !shown.some((text) => text.includes(line) || line.includes(text))) : [];
    const errors = after ? errorsNote(errorsBefore, [...shown, ...plain]) : null;
    const still = expectsChange && before !== null && after !== null && after.url === before.url && after.title === before.title && after.text === before.text && !opened;
    const change = still ? NOTHING_CHANGED : before && after ? (reports ? await pageNews(context, tab, before, after, refMark) : describePageChange(before, after)) : null;
    const answer = withParts(result, errors, change, opened, dialogNote(tab), context.health(tab));
    if (!still || errors || !submits || context.inBatch) return answer;
    const picture = await stuckPicture(context, tab);
    return picture ? { ...answer, content: [...answer.content, ...picture] } : answer;
  });
}

/** The name a click's target goes by: its ref's accessible name, or the selector as written. */
function targetName(tab: Tab, target: { ref: string } | { selector: string } | { x: number; y: number }): string {
  if ("ref" in target) return tab.page.refs.locator(target.ref)?.name ?? "";
  return "selector" in target ? target.selector : "";
}

const NOTHING_CHANGED = "Nothing changed on the page: the same address and the same text. Do not repeat the action as it was; look at what the page needs first (a screenshot shows what its text does not), or try another way.";

/** Documents that already got their one picture for a submit that changed nothing. */
const pictured = new WeakMap<Tab, string | null>();

/** A small look at a page a submit left unchanged, once per document, so red text the page's tree does not carry is seen. */
async function stuckPicture(context: ToolContext, tab: Tab): Promise<ToolResult["content"] | null> {
  const loaderId = tab.page.lifecycle.loaderId;
  if (pictured.get(tab) === loaderId || await context.secretOnPage(tab).catch(() => true)) return null;
  pictured.set(tab, loaderId);
  try {
    const shot = await context.paused(tab, () => tab.page.screenshot());
    return [{ type: "text", text: `A look at the page after it did not change: ${pictureNote(shot)}` }, { type: "image", data: shot.data.toString("base64"), mimeType: "image/png" }];
  } catch {
    return null;
  }
}

/** What the action changed and what to act on next: a page it moved to comes with its snapshot, new controls with refs. */
async function pageNews(context: ToolContext, tab: Tab, before: PageState, after: PageState, refMark: number): Promise<string> {
  const change = describePageChange(before, after);
  try {
    if (after.url !== before.url) {
      const snapshot = await snapshotResult(context, tab, { fresh: true });
      const text = snapshot.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      return `The page is now ${sanitizeUrl(after.url) || "a new address"}. Its snapshot, with current refs to act on:\n${text}`;
    }
    if (change.startsWith("The visible text of the page did not change")) return change;
    const snapshot = await tab.page.snapshot();
    return [change, newElementsNote(newElements(snapshot.tree, refMark))].filter(Boolean).join("\n");
  } catch {
    return change;
  }
}

const ACTING_STEPS: ReadonlySet<string> = new Set(["open", "navigate", "click", "fill", "type", "press", "select", "check", "hover", "scroll", "upload", "drag", "eval"]);

/** The page a batch left: its snapshot when the batch moved to another page, else the controls it brought up. */
async function batchNews(context: ToolContext, tab: Tab, moved: boolean, refMark: number): Promise<string | null> {
  try {
    await settleAfterAction(tab, context.deadline - FOLLOW_UP_MS);
    if (moved) {
      const snapshot = await snapshotResult(context, tab);
      return `The page now, with current refs to act on:\n${snapshot.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")}`;
    }
    return newElementsNote(newElements((await tab.page.snapshot()).tree, refMark));
  } catch {
    return null;
  }
}

/** How a picture's pixels map to the CSS pixels the point tools take, so a point read off it lands where it was seen. */
export function pictureNote(shot: Pick<Screenshot, "width" | "height" | "scale" | "region">, of: "viewport" | "page" | "element" = "viewport"): string {
  const pixels = `${shot.width}x${shot.height} pixels`;
  const region = `${Math.round(shot.region.width)}x${Math.round(shot.region.height)} CSS-pixel`;
  if (of !== "viewport") return `${pixels}: the ${region} ${of === "page" ? "page" : "element"}${shot.scale === 1 ? "" : ` drawn at ${shot.scale}`}.`;
  return shot.scale === 1
    ? `${pixels}, one per CSS pixel of the viewport, so x and y read off it are the point the click, hover and drag tools take.`
    : `${pixels}: the ${region} viewport drawn at ${shot.scale}, so divide x and y read off it by ${shot.scale} for the point the click, hover and drag tools take.`;
}

/** Waits out what a read would only catch half done: a bot check that clears by itself, loading placeholders. */
async function settled(context: ToolContext, tab: Tab, fresh: boolean): Promise<string | null> {
  let cleared = clearedChecks.get(context.browser);
  if (!cleared) clearedChecks.set(context.browser, cleared = new Set());
  const report = await settlePage({ frames: tab.page.frames, loaded: (timeoutMs) => tab.page.lifecycle.waitFor("load", { timeoutMs }) }, { deadline: context.deadline - FOLLOW_UP_MS, fresh, cleared });
  const point = checkStatus(report)?.status === "needs you" && report.checkbox ? await offeredClick(context, tab) : null;
  const consent = context.answersConsent?.(tab) ? await answeredConsent(tab) : null;
  return [settleNote(report, point), consent].filter(Boolean).join(" ") || null;
}

/** The sites in each browser whose checkbox click was offered: a bot gets one, and after it the person is asked. */
const offeredClicks = new WeakMap<object, Set<string>>();

async function offeredClick(context: ToolContext, tab: Tab): Promise<CheckboxPoint | null> {
  let offered = offeredClicks.get(context.browser);
  if (!offered) offeredClicks.set(context.browser, offered = new Set());
  let host = "";
  try { host = new URL(tab.page.url()).hostname; } catch {}
  if (!host || offered.has(host)) return null;
  const point = await checkboxPoint(tab.page.frames);
  if (point) offered.add(host);
  return point;
}

/** Each document's cookie banner is looked for on reads in its first seconds, and answered once. */
const consentLooks = new WeakMap<Tab, { loaderId: string | null; since: number; done: boolean }>();

async function answeredConsent(tab: Tab): Promise<string | null> {
  const loaderId = tab.page.lifecycle.loaderId;
  let look = consentLooks.get(tab);
  if (!look || look.loaderId !== loaderId) consentLooks.set(tab, look = { loaderId, since: Date.now(), done: false });
  if (look.done || Date.now() - look.since > CONSENT_LOOK_MS || tab.page.url() === "about:blank") return null;
  const pressed = await rejectConsent(tab.page.frames);
  if (!pressed) return null;
  look.done = true;
  return consentNote(pressed);
}

async function snapshotResult(context: ToolContext, tab: Tab, { includeImage = false, save = false, fresh = false }: { includeImage?: boolean; save?: boolean; fresh?: boolean } = {}): Promise<ToolResult> {
  const note = await settled(context, tab, fresh);
  const snapshot = await tab.page.snapshot();
  await context.browser.refreshTargets().catch(() => undefined);
  const text = [note, snapshotText({ ...describe(tab), tree: snapshot.tree, truncated: snapshot.truncated, frames: snapshot.frames, health: context.health(tab) })].filter(Boolean).join("\n");
  if (!includeImage && !save) return textResult(text);
  const shot = await context.paused(tab, () => tab.page.screenshot());
  const saved = save ? context.saveScreenshot(shot.data, tab.page.url()) : null;
  const shown = includeImage || !save;
  return {
    content: [
      { type: "text", text: `${text}${saved ? `\nScreenshot saved at ${saved}` : ""}${shown ? `\nThe screenshot is ${pictureNote(shot)}` : ""}` },
      ...(shown ? [{ type: "image" as const, data: shot.data.toString("base64"), mimeType: "image/png" }] : []),
    ],
  };
}

async function readText(tab: Tab, input: ToolInput<"agent_browser_read">): Promise<string> {
  const limit = Math.min(input.maxChars ?? MAX_VISIBLE_TEXT_LENGTH, 40_000);
  const offset = input.offset ?? 0;
  let text: string;
  if (input.ref !== undefined || input.selector !== undefined) {
    const handle = await resolveElement(tab.page.frames, tab.page.refs, input.ref !== undefined ? { ref: input.ref } : { selector: input.selector! });
    text = await callOnNode<string>(tab.page.frames, handle, ELEMENT_TEXT);
  } else {
    text = await tab.page.visibleText(offset + limit);
  }
  const part = text.slice(offset, offset + limit);
  const more = text.length > offset + limit || (input.ref === undefined && input.selector === undefined && part.length === limit);
  return `${part}${more ? `\n… (more text: call again with offset ${offset + part.length})` : ""}`;
}

function element(input: { ref?: string; selector?: string; x?: number; y?: number }, point = true) {
  const target = targetOf(input, { point });
  if (typeof target === "string") throw new DriverError("invalid-selector", target);
  return target;
}

export async function executeTool(context: ToolContext, call: ToolCall): Promise<ToolResult> {
  switch (call.name) {
    case "agent_browser_status": {
      const tab = call.input.tab ? tabOf(context, call.input.tab) : null;
      return bot(context, tab, async () => {
        await context.browser.refreshTargets().catch(() => undefined);
        const status = statusOf(context, tab);
        if (call.as === "url") return textResult(status.url ?? "about:blank");
        if (call.as === "title") return textResult(status.title);
        return textResult(JSON.stringify(status));
      });
    }
    case "agent_browser_open": {
      const { url, tab: which } = call.input;
      const address = url !== undefined && url.trim() !== "" ? agentUrl(url) : null;
      const existing = which === "new" ? null : which ? tabOf(context, which) : context.active();
      const tab = existing ?? await bot(context, null, () => context.openTab());
      return bot(context, tab, async () => {
        await tab.page.bringToFront();
        const opened = address ? await tab.page.navigate(address, { readiness: "load", timeoutMs: remaining(context) }) : null;
        if (opened?.signInPrompt) return textResult(signInWait(tab, opened.url, opened.signInPrompt));
        const lead = opened
          ? `Opened ${sanitizeUrl(opened.url) || opened.url} in ${tab.id}${opened.status && opened.status >= 400 ? `; the site answered HTTP ${opened.status}` : ""}.`
          : `${tab.id} is open at ${sanitizeUrl(tab.page.url()) || tab.page.url()}.`;
        const snapshot = await snapshotResult(context, tab, { fresh: opened !== null });
        return withParts(textResult(lead, "Page observed after navigation. Its refs are current, so act on them without another snapshot. Check this result for redirects, sign-in requirements or page errors before reporting task success:"), ...snapshot.content.map((part) => (part.type === "text" ? part.text : null)), dialogNote(tab));
      });
    }
    case "agent_browser_navigate": {
      const tab = tabOf(context, call.input.tab);
      const { url, action, readiness = "load" } = call.input;
      if ((url === undefined) === (action === undefined)) return errorResult("Pass url or action (back, forward or reload), not both.");
      return act(context, tab, async () => {
        const options = { readiness, timeoutMs: remaining(context) };
        const result = url !== undefined
          ? await tab.page.navigate(agentUrl(url), options)
          : action === "back" ? await tab.page.back(options) : action === "forward" ? await tab.page.forward(options) : await tab.page.reload(options);
        if (result.signInPrompt) return textResult(signInWait(tab, result.url, result.signInPrompt));
        const lead = `${tab.id} is now at ${sanitizeUrl(result.url) || result.url}${result.status && result.status >= 400 ? ` (HTTP ${result.status})` : ""}. Refs from earlier snapshots do not apply to it${context.inBatch ? "." : "; its snapshot, with current refs:"}`;
        if (context.inBatch) return textResult(lead);
        return withParts(textResult(lead), ...(await snapshotResult(context, tab, { fresh: true })).content.map((part) => (part.type === "text" ? part.text : null)));
      });
    }
    case "agent_browser_snapshot": {
      const tab = tabOf(context, call.input.tab);
      return bot(context, tab, async () => {
        await tab.page.bringToFront();
        return withParts(await snapshotResult(context, tab, call.input), dialogNote(tab));
      });
    }
    case "agent_browser_read": {
      const tab = tabOf(context, call.input.tab);
      return act(context, tab, async () => {
        await tab.page.bringToFront();
        const opens = call.input.url !== undefined && call.input.url.trim() !== "";
        if (opens) await tab.page.navigate(agentUrl(call.input.url!), { readiness: "load", timeoutMs: remaining(context) });
        const note = await settled(context, tab, opens);
        return textResult(note, `${pageLabel(describe(tab))}\n${await readText(tab, call.input)}`);
      });
    }
    case "agent_browser_screenshot": {
      const tab = tabOf(context, call.input.tab);
      const target = call.input.ref !== undefined || call.input.selector !== undefined ? element(call.input, false) : undefined;
      return act(context, tab, async () => {
        await tab.page.bringToFront();
        const shot = await context.paused(tab, () => tab.page.screenshot({ fullPage: call.input.fullPage === true, ...(target && !("x" in target) ? { target } : {}) }));
        const note = pictureNote(shot, target ? "element" : call.input.fullPage === true ? "page" : "viewport");
        return { content: [{ type: "text", text: `Screenshot of ${pageLabel(describe(tab))}, ${note}` }, { type: "image", data: shot.data.toString("base64"), mimeType: "image/png" }] };
      });
    }
    case "agent_browser_click": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input);
      return act(context, tab, async () => {
        const clicked = await tab.page.click(target, { button: call.input.button ?? "left", clickCount: call.input.clickCount ?? 1, timeoutMs: remaining(context), pointer: context.pointer(tab) });
        return textResult(`Clicked ${"ref" in target ? target.ref : "selector" in target ? JSON.stringify(target.selector) : `${Math.round(clicked.x)},${Math.round(clicked.y)}`}${clicked.dialog ? "; it opened a dialog" : ""}.`);
      }, { observeChange: true, expectsChange: true, submits: SUBMIT_NAME.test(targetName(tab, target)) });
    }
    case "agent_browser_fill": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input, false) as { ref: string } | { selector: string };
      return act(context, tab, async () => {
        await tab.page.fill(target, call.input.text);
        if (call.input.submit) await tab.page.press("Enter");
        return textResult(`Filled the field${call.input.submit ? " and pressed Enter" : ""}.`);
      }, { observeChange: true, expectsChange: call.input.submit === true, submits: call.input.submit === true });
    }
    case "agent_browser_type": {
      const tab = tabOf(context, call.input.tab);
      const target = call.input.ref !== undefined || call.input.selector !== undefined ? element(call.input, false) as { ref: string } | { selector: string } : null;
      return act(context, tab, async () => {
        if (call.input.clear && target) await tab.page.fill(target, "");
        await tab.page.type(target, call.input.text);
        return textResult(`Typed ${[...call.input.text].length} characters.`);
      }, { observeChange: true });
    }
    case "agent_browser_press": {
      const tab = tabOf(context, call.input.tab);
      const chord = [...(call.input.modifiers ?? []), call.input.key].join("+");
      return act(context, tab, async () => {
        const pressed = await tab.page.press(chord);
        return textResult(`Pressed ${chord}${pressed.dialog ? "; it opened a dialog" : ""}.`);
      }, { observeChange: true, expectsChange: true, submits: /^(?:Enter|NumpadEnter)$/u.test(call.input.key) });
    }
    case "agent_browser_select": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input, false) as { ref: string } | { selector: string };
      return act(context, tab, async () => {
        const { selected } = await tab.page.select(target, call.input.values);
        return textResult(`Selected ${selected.map((value) => JSON.stringify(value)).join(", ") || "nothing"}.`);
      }, { observeChange: true });
    }
    case "agent_browser_check": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input, false) as { ref: string } | { selector: string };
      const checked = call.input.checked ?? true;
      return act(context, tab, async () => {
        const result = await tab.page.check(target, checked, { timeoutMs: remaining(context) });
        return textResult(`${result.changed ? (checked ? "Checked" : "Unchecked") : `Already ${checked ? "checked" : "unchecked"}`}.`);
      }, { observeChange: true });
    }
    case "agent_browser_hover": {
      const tab = tabOf(context, call.input.tab);
      const target = element(call.input);
      return act(context, tab, async () => {
        const point = await tab.page.hover(target, { timeoutMs: remaining(context), pointer: context.pointer(tab) });
        return textResult(`The mouse is over ${Math.round(point.x)},${Math.round(point.y)}.`);
      }, { observeChange: true });
    }
    case "agent_browser_drag": {
      const tab = tabOf(context, call.input.tab);
      const from = element(call.input.from);
      const to = element(call.input.to);
      return act(context, tab, async () => {
        const dragged = await tab.page.drag(from, to, { timeoutMs: remaining(context), pointer: context.pointer(tab) });
        return textResult(`Dragged from ${Math.round(dragged.from.x)},${Math.round(dragged.from.y)} to ${Math.round(dragged.to.x)},${Math.round(dragged.to.y)}${dragged.dropped === "html5" ? " (a drag-and-drop)" : ""}.`);
      }, { observeChange: true });
    }
    case "agent_browser_scroll": {
      const tab = tabOf(context, call.input.tab);
      const target = call.input.ref !== undefined || call.input.selector !== undefined ? element(call.input, false) : null;
      const dx = call.input.dx ?? 0;
      const dy = call.input.dy ?? (call.input.dx === undefined ? 600 : 0);
      const wanted = call.input.toText;
      return act(context, tab, async () => {
        if (wanted !== undefined) {
          const found = await tab.page.scrollUntil(target, dx, dy, wanted, context.deadline - FOLLOW_UP_MS);
          const times = `${found.scrolls} time${found.scrolls === 1 ? "" : "s"}`;
          const near = found.found ? around((await tab.page.snapshot()).tree, wanted) : null;
          if (near) return textResult(`${found.scrolls ? `Scrolled ${times}; ` : ""}${JSON.stringify(wanted)} shows on the page now, scrolled into view, here with refs to act on:\n${near}`);
          return textResult(found.found ? `${found.scrolls ? `Scrolled ${times}; ` : ""}${JSON.stringify(wanted)} shows on the page now, scrolled into view.`
            : found.atEnd ? `Scrolled ${times} to the end; ${JSON.stringify(wanted)} is not there. Check the spelling, or look elsewhere (a search box, another tab or page).`
            : `Scrolled ${times}; ${JSON.stringify(wanted)} has not shown yet. Call again to keep looking.`);
        }
        await tab.page.scroll(target, dx, dy, { timeoutMs: remaining(context) });
        const position = await valueInWorld<[number, number, number]>(tab.page.frames, tab.page.frames.mainFrameId, "[Math.round(scrollX), Math.round(scrollY), Math.round(document.documentElement.scrollHeight)]").catch(() => null);
        return textResult(`Scrolled by ${dx},${dy}.${position ? ` The page is at ${position[0]},${position[1]} of ${position[2]} pixels high.` : ""}`);
      }, { observeChange: wanted === undefined });
    }
    case "agent_browser_upload": {
      const tab = tabOf(context, call.input.tab);
      const target = call.input.ref !== undefined || call.input.selector !== undefined ? element(call.input, false) as { ref: string } | { selector: string } : undefined;
      return act(context, tab, async () => {
        await tab.page.upload(call.input.files, target);
        return textResult(`Put ${call.input.files.length} file${call.input.files.length === 1 ? "" : "s"} into the page. Submit its form as usual.`);
      }, { observeChange: true });
    }
    case "agent_browser_wait": {
      const tab = tabOf(context, call.input.tab);
      const { ms, text, ref, selector, gone, urlIncludes, load, timeoutMs } = call.input;
      return act(context, tab, async () => {
        await tab.page.waitFor({
          ...(ms !== undefined ? { ms } : {}), ...(text !== undefined ? { text } : {}),
          ...(ref !== undefined || selector !== undefined ? { target: { ...(ref !== undefined ? { ref } : {}), ...(selector !== undefined ? { selector } : {}) }, gone: gone === true } : {}),
          ...(urlIncludes !== undefined ? { urlIncludes } : {}), ...(load !== undefined ? { load } : {}),
          timeoutMs: Math.min(timeoutMs ?? DEFAULT_ACTION_MS, Math.max(0, context.deadline - Date.now() - FOLLOW_UP_MS)),
        });
        return textResult(`Done waiting; ${pageLabel(describe(tab))}.`);
      });
    }
    case "agent_browser_eval": {
      const tab = tabOf(context, call.input.tab);
      return act(context, tab, async () => {
        if (await context.secretOnPage(tab)) return errorResult(context.secretNote?.() ?? SECRET_ON_PAGE_EVAL);
        const value = await tab.page.evaluate(call.input.expression, { world: call.input.world ?? "isolated", timeoutMs: remaining(context) });
        return textResult(value === undefined ? "undefined" : JSON.stringify(value));
      });
    }
    case "agent_browser_dialog": {
      const tab = tabOf(context, call.input.tab);
      await context.control.heldBack(tab, holdWait(context));
      const answered = await tab.page.answerDialog({ accept: call.input.accept, ...(call.input.promptText === undefined ? {} : { promptText: call.input.promptText }) });
      return textResult(`${call.input.accept ? "Accepted" : "Dismissed"} the ${answered.type} dialog.`);
    }
    case "agent_browser_tabs": {
      const { action, url, tab: which } = call.input;
      if (action === "list") {
        return bot(context, null, async () => {
          await context.browser.refreshTargets().catch(() => undefined);
          return textResult(JSON.stringify(statusOf(context).tabs));
        });
      }
      if (action === "new") {
        const address = url !== undefined && url.trim() !== "" ? agentUrl(url) : null;
        const tab = await bot(context, null, () => context.openTab());
        return act(context, tab, async () => {
          await tab.page.bringToFront();
          if (address) await tab.page.navigate(address, { readiness: "load", timeoutMs: remaining(context) });
          return textResult(`Opened ${tab.id} at ${sanitizeUrl(tab.page.url()) || tab.page.url()}. ${frontNote(context)} take a snapshot to act on it.`);
        });
      }
      if (!which) return errorResult(`Pass tab for ${action}.`);
      const tab = tabOf(context, which);
      if (action === "close") return bot(context, tab, async () => { await context.closeTab(tab); return textResult(`Closed ${tab.id}.`); });
      return bot(context, tab, async () => {
        await tab.page.bringToFront();
        return withParts(textResult(`${context.control.owner === null ? `${tab.id} is in front` : `You work in ${tab.id}`}; its snapshot, with current refs:`), ...(await snapshotResult(context, tab)).content.map((part) => (part.type === "text" ? part.text : null)));
      });
    }
    case "agent_browser_close": {
      if (call.input.tab) {
        const tab = tabOf(context, call.input.tab);
        return bot(context, tab, async () => { await context.closeTab(tab); return textResult(`Closed ${tab.id}.`); });
      }
      return bot(context, "every", async () => { await context.closeBrowser(); return textResult("Closed the browser. Saved sign-ins are kept; agent_browser_open starts it again."); });
    }
    case "agent_browser_batch": {
      const tab = context.active();
      const start = tab ? { url: tab.page.url(), refMark: tab.page.refs.mark, errors: await bot(context, tab, () => shownErrors(tab)) } : null;
      const result = await runBatch(context, call.input, { execute: executeTool, failure: toolFailure });
      const front = context.active();
      const last = call.input.steps.at(-1)?.do ?? "";
      if (result.isError || !front || !start || ["snapshot", "read", "screenshot"].includes(last) || !call.input.steps.some((step) => ACTING_STEPS.has(step.do))) return result;
      const moved = front !== tab || front.page.url() !== start.url;
      return withParts(result, ...await bot(context, front, async () => {
        const news = await batchNews(context, front, moved, start.refMark);
        return [moved ? null : errorsNote(start.errors, await shownErrors(front)), news];
      }));
    }
    case "restart_browser":
      return errorResult("restart_browser is handled before a call reaches its tab.");
  }
}

/** A tool's failure as the bot reads it; null for one the service must handle itself. */
export function toolFailure(error: unknown): ToolResult | null {
  if (isUnanswered(error)) return null;
  if (error instanceof PersonHoldAnswer || (error instanceof Error && error.message === BROWSER_CONTROL_REFUSAL)) return null;
  if (error instanceof DriverError) return errorResult(error.message);
  if (error instanceof BrowserControlInterrupted) return errorResult(error.message);
  return errorResult(error instanceof Error ? error.message : String(error));
}
