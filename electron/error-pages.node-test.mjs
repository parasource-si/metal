import assert from "node:assert/strict";
import test from "node:test";

import { buildErrorPage, SERVER_FAILURES, SERVER_PAGE_ACTIONS, serverPageAction, serverProblemReportUrl } from "./error-pages.mjs";

const html = (url) => decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));

test("server fails: the page says so in plain words with Try again and a way to report it", () => {
  for (const reason of Object.keys(SERVER_FAILURES)) {
    const page = html(buildErrorPage({ reason, logDir: "/Users/me/Library/Logs/dusk bot" }));
    assert.match(page, /<h1>Metal couldn't start<\/h1>/);
    assert.ok(page.includes(SERVER_FAILURES[reason].replace(/'/g, "&#39;")), reason);
    assert.ok(page.includes(`<a href="${SERVER_PAGE_ACTIONS.retry}">Try again</a>`));
    assert.ok(page.includes(`<a href="${SERVER_PAGE_ACTIONS.report}">Report the problem</a>`));
    assert.ok(page.includes("/Users/me/Library/Logs/dusk bot/server.log"));
    assert.doesNotMatch(page, /health checks|8799|—/, "no internals, no em dash");
  }
});

test("an unknown reason reads as the timeout, and Try again shows a starting page", () => {
  assert.ok(html(buildErrorPage({ reason: "nope", logDir: "/l" })).includes(SERVER_FAILURES.timeout.replace(/'/g, "&#39;")));
  const starting = html(buildErrorPage({ starting: true, logDir: "/l" }));
  assert.match(starting, /Starting Metal again…/);
  assert.doesNotMatch(starting, /Try again/);
});

test("only the page's own two addresses are actions", () => {
  assert.equal(serverPageAction(SERVER_PAGE_ACTIONS.retry), "retry");
  assert.equal(serverPageAction(SERVER_PAGE_ACTIONS.report), "report");
  assert.equal(serverPageAction(`${SERVER_PAGE_ACTIONS.retry}?x=1`), null);
  assert.equal(serverPageAction("http://127.0.0.1:8799/"), null);
});

test("the report opens a new issue with the reason, version and platform, and no paths", () => {
  const url = new URL(serverProblemReportUrl({ reason: "timeout", version: "0.2.18", platform: "darwin", arch: "arm64" }));
  assert.equal(url.origin + url.pathname, "https://github.com/parasource-si/metal/issues/new");
  const body = url.searchParams.get("body");
  assert.ok(body.includes(SERVER_FAILURES.timeout));
  assert.ok(body.includes("0.2.18") && body.includes("darwin arm64"));
  assert.doesNotMatch(body, /\/Users\//);
});
