import assert from "node:assert/strict";
import test from "node:test";
import { createSlackOAuthLinks, slackOAuthLinkFrom, slackOAuthLinkFromCommandLine } from "./slack-link.mjs";

const STATE = "a1".repeat(32);
const CODE_LINK = `duskbot://slack/oauth?code=test.code_-123&state=${STATE}`;
const ERROR_LINK = `duskbot://slack/oauth?error=access_denied&state=${STATE}`;

test("accepts strict code and error links and trims surrounding whitespace", () => {
  for (const link of [CODE_LINK, ERROR_LINK, `duskbot://slack/oauth?state=${STATE}&code=abcdefgh`]) {
    assert.equal(slackOAuthLinkFrom(link), link);
    assert.equal(slackOAuthLinkFrom(` \n${link}\t`), link);
  }
});

test("rejects other handlers, wrong case, unknown keys, duplicates and fragments", () => {
  for (const link of [
    "duskbot://bot/scout", "duskbot://thread/abc?bot=scout", "duskbot://cloud",
    "duskbot://organization", CODE_LINK.replace("duskbot", "Metal"),
    CODE_LINK.replace("slack", "Slack"), CODE_LINK.replace("oauth", "OAuth"),
    `${CODE_LINK}&extra=1`, `${CODE_LINK}&state=${STATE}`, `${CODE_LINK}&code=abcdefgh`,
    `${ERROR_LINK}&error=other`, `${CODE_LINK}&error=access_denied`, `${CODE_LINK}#fragment`,
    `https://example.com/${CODE_LINK}`, CODE_LINK.replace("oauth?", "oauth/?"),
    null, undefined, 42,
  ]) assert.equal(slackOAuthLinkFrom(link), null);
});

test("rejects invalid values, missing fields and oversized links", () => {
  for (const query of [
    "", `state=${STATE}`, "code=abcdefgh", `code=short&state=${STATE}`,
    `code=${"a".repeat(257)}&state=${STATE}`, `code=abc%22%3Cdefgh&state=${STATE}`,
    `code=abcdefgh&state=${STATE.toUpperCase()}`, "code=abcdefgh&state=abc",
    `error=&state=${STATE}`, `error=Access_denied&state=${STATE}`, `error=${"a".repeat(65)}&state=${STATE}`,
    `code=abcdefgh&state=${STATE}&${"x".repeat(2048)}`,
  ]) assert.equal(slackOAuthLinkFrom(`duskbot://slack/oauth?${query}`), null);
});

test("picks up a valid command line argument", () => {
  assert.equal(slackOAuthLinkFromCommandLine(["/bin/app", "--flag", "duskbot://cloud", CODE_LINK]), CODE_LINK);
  assert.equal(slackOAuthLinkFromCommandLine(["/bin/app", "duskbot://bot/scout"]), null);
});

test("keeps the newest pending link until send succeeds, then clears it", () => {
  const sent = [];
  const calls = [];
  let ready = false;
  const links = createSlackOAuthLinks({ reveal: () => calls.push("reveal"), send: (link) => { calls.push("send"); sent.push(link); return ready; } });
  assert.equal(links.queue(CODE_LINK), true);
  assert.deepEqual(calls, ["reveal", "send"]);
  assert.equal(links.queue(ERROR_LINK), true);
  assert.equal(links.queue("duskbot://cloud"), false);
  ready = true;
  links.deliver();
  links.deliver();
  assert.deepEqual(sent, [CODE_LINK, ERROR_LINK, ERROR_LINK]);
});

test("queues command line links and ignores unrelated launches", () => {
  const sent = [];
  let revealed = 0;
  const links = createSlackOAuthLinks({ reveal: () => revealed++, send: (link) => { sent.push(link); return true; } });
  assert.equal(links.fromCommandLine(["/bin/app", ERROR_LINK]), true);
  assert.equal(links.fromCommandLine(["/bin/app", "duskbot://cloud"]), false);
  links.deliver();
  assert.equal(revealed, 1);
  assert.deepEqual(sent, [ERROR_LINK]);
});
