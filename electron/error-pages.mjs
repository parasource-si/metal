import path from "node:path";

import { handoffPage } from "./pixel-page.mjs";

const dataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Addresses the server-failure page's two buttons navigate to; main runs them and never lets the navigation through. */
export const SERVER_PAGE_ACTIONS = Object.freeze({ retry: "https://duskbot.invalid/start-again", report: "https://duskbot.invalid/report" });

/** The server-failure page's button behind `url`, or null. */
export function serverPageAction(url) {
  return Object.entries(SERVER_PAGE_ACTIONS).find(([, at]) => at === String(url))?.[0] ?? null;
}

/** Why the background server isn't up, in the person's words. */
export const SERVER_FAILURES = Object.freeze({
  ports: "Other apps are using every port Metal can open on.",
  timeout: "Its background server didn't answer within a minute.",
  stopped: "Its background server stopped while it was starting.",
  crashed: "Its background server kept stopping, so Metal paused it.",
});

/** The page the main window shows while the background server isn't up: why, Try again, and a way to report it. */
export function buildErrorPage({ reason = "timeout", logDir, starting = false }) {
  if (starting) {
    return dataUrl(handoffPage({ title: "Metal", mood: "go", content: `<h1 role="status">Starting Metal again…</h1><p>This takes a few seconds.</p>` }));
  }
  const serverLogPath = path.join(logDir, "server.log");
  const why = SERVER_FAILURES[reason] ?? SERVER_FAILURES.timeout;
  return dataUrl(handoffPage({
    title: "Metal couldn't start",
    mood: "oops",
    content: `<h1>Metal couldn't start</h1><p>${escapeHtml(why)} Your bots and chats are safe.</p>`
      + `<p class="go"><a href="${SERVER_PAGE_ACTIONS.retry}">Try again</a></p>`
      + `<p class="hint">Still stuck? <a href="${SERVER_PAGE_ACTIONS.report}">Report the problem</a> and we'll look into it. The details are in <code>${escapeHtml(serverLogPath)}</code></p>`,
  }));
}

/** A new GitHub issue about a server that couldn't start, filled in with what helps and nothing private. */
export function serverProblemReportUrl({ reason, version, platform, arch }) {
  const body = [
    "### What happened", "Metal showed \"Metal couldn't start\".", "",
    `- Reason: ${SERVER_FAILURES[reason] ?? reason}`, `- Version: ${version}`, `- Platform: ${platform} ${arch}`, "",
    "Attach server.log from the folder the page names if you can.",
  ].join("\n");
  const url = new URL("https://github.com/parasource-si/metal/issues/new");
  url.searchParams.set("title", "Metal couldn't start");
  url.searchParams.set("body", body);
  return url.toString();
}

/** The page the live-desktop viewer shows when it cannot open: one plain sentence and what to press; the browser's
 * reason goes to the log. */
export function desktopViewerErrorPage(retryUrl) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return dataUrl(handoffPage({
    title: "Desktop unavailable",
    mood: "oops",
    content: `<h1>Couldn't open the live desktop</h1><p>It may still be starting. Try again in a moment.</p><p class="go"><a href="${escape(retryUrl)}">Try again</a> <a href="${escape(retryUrl)}" target="_blank" rel="noreferrer">Open in browser</a></p>`,
  }));
}

/** Electron's render-process-gone reasons that mean the page died, not that it was closed or killed on purpose. */
export const RENDERER_CRASHES = new Set(["crashed", "oom", "launch-failed", "integrity-failure", "abnormal-exit"]);

/** The page the main window shows after its renderer crashes; the bots run in the server, so they are unaffected. */
export function windowCrashedPage(reopenUrl) {
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return dataUrl(handoffPage({
    title: "Metal",
    mood: "oops",
    content: `<h1>This window tripped</h1><p>The window stopped drawing, but your bots kept running. Reopen it to pick up right where you were.</p><p class="go"><a href="${escape(reopenUrl)}">Reopen window</a></p>`,
  }));
}
