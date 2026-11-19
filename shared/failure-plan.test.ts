import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { failedTurnCause, failedTurnTool, type FailedReplyReason } from "./failed-turn";
import { FAILURE_PLANS, failurePlan, type FailureKind } from "./failure-plan";
import { hasRawDetail, rawDetailIn } from "./raw-detail";

const REASONS: FailedReplyReason[] = ["signed_out", "credits", "usage_limit", "rate_limit", "overloaded", "timeout", "no_ai", "model_not_found",
  "bad_request", "context", "session_lost", "provider_down", "cli_missing", "cli_exit"];
const KINDS: FailureKind[] = [...REASONS, "claude_update", "place", "restart_interrupted", "no_answer", "blocker", "other"];

/** What engines and the system really say when they fail, as people must never read it. */
const RAW_CAUSES = [
  "spawn claude ENOENT: /Users/sam/.duskbot/workspaces/0f6c/chats/main does not exist",
  "Error: boom\n    at runTurn (/Applications/Dusk Bot.app/Contents/Resources/server.js:12:4)\n    at process.tick (node:internal/process:1:1)",
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.3.custom.input_schema: bad"}}',
  "request to https://api.anthropic.com/v1/messages failed, reason: socket hang up",
  "codex exited with code 137",
  "connect ECONNREFUSED 127.0.0.1:8317",
  "C:\\Users\\sam\\AppData\\Local\\dusk bot\\server.log has the details",
  "Traceback (most recent call last):\n  File \"agent.py\", line 3",
];

describe("every way a reply can be lost", () => {
  it("has a plan: what heals it, and a button", () => {
    expect(Object.keys(FAILURE_PLANS).sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      const plan = FAILURE_PLANS[kind];
      expect(plan.action, kind).toBeTruthy();
      expect(plan.instead, `${kind}: its fallback is another button`).not.toBe(plan.action);
    }
    expect(failurePlan(undefined)).toBe(FAILURE_PLANS.other);
  });

  it("says one or two plain sentences, with no path, address, stack, JSON or code", () => {
    for (const kind of KINDS) {
      const { line } = FAILURE_PLANS[kind];
      expect(rawDetailIn(line), `${kind}: ${line}`).toBeNull();
      expect(line, kind).toMatch(/^(?:Metal|[A-Z])[^\n]{10,120}\.$/);
      expect(line.split(/(?<=\.) /).length, kind).toBeLessThanOrEqual(2);
    }
  });
});

describe("developer detail", () => {
  it("is found in each kind of raw failure", () => {
    for (const cause of RAW_CAUSES) expect(hasRawDetail(cause), cause).toBe(true);
  });

  it("is never found in plain words, numbers and times included", () => {
    for (const text of [
      "Your Pro plan includes 2 cloud computers at once. Delete one to start another.",
      "Claude has reached its usage limit, which resets 3:40 PM.",
      "Sent the report to the team at 9 and filed it under reports/2026.",
      "The flyers are printed: exit 3 on the left side of the hall.",
    ]) expect(rawDetailIn(text), text).toBeNull();
  });

});

describe("a failed turn's stored row", () => {
  it("keeps the real cause, whatever its reason, with home folders written as ~", () => {
    for (const reason of REASONS) {
      for (const cause of RAW_CAUSES.filter((text) => !text.includes("Users"))) {
        expect(failedTurnCause(failedTurnTool(cause, { reason }).name), `${reason}: ${cause}`).toBe(cause);
      }
    }
    expect(failedTurnCause(failedTurnTool(RAW_CAUSES[0]!, { reason: "cli_missing" }).name))
      .toBe("spawn claude ENOENT: ~/.duskbot/workspaces/0f6c/chats/main does not exist");
    expect(failedTurnCause(failedTurnTool("C:\\Users\\sam\\AppData\\Local\\dusk bot\\server.log has the details").name))
      .toBe("~\\AppData\\Local\\dusk bot\\server.log has the details");
  });

  it("keeps the engine's own plain words, and any words with no known reason", () => {
    expect(failedTurnCause(failedTurnTool("Claude has reached its usage limit, which resets 3:40 PM.", { reason: "usage_limit" }).name))
      .toBe("Claude has reached its usage limit, which resets 3:40 PM.");
    expect(failedTurnCause(failedTurnTool("codex exited with code 137").name)).toBe("codex exited with code 137");
  });
});

describe("the copy a failure card shows", () => {
  it("never carries developer detail in any language", () => {
    const dir = new URL("../src/locales/", import.meta.url);
    const card = /^(?:failedReply|error\.plain|chat\.rescue|chat\.blocker|chat\.error|liveConnection|cloudAsleep)\./;
    for (const file of ["en.json", "de.json", "ja.json", "es.json"]) {
      const pack = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, string>;
      const leaks = Object.entries(pack).filter(([key, value]) => card.test(key) && hasRawDetail(value)).map(([key]) => `${file}: ${key}`);
      expect(leaks).toEqual([]);
    }
  });
});
