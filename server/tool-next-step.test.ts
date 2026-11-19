import { describe, expect, it } from "vitest";
import { NEXT_STEP_LEAD, nextStepHint, toolFailureKind, withNextStep, withNextStepLine, withNextStepResult } from "./tool-next-step.ts";

describe("tool failure next steps", () => {
  it("names the common failures", () => {
    expect(toolFailureKind("HTTP 429 Too Many Requests")).toBe("rate-limited");
    expect(toolFailureKind("Error: rate limit exceeded, retry later")).toBe("rate-limited");
    expect(toolFailureKind("401 Unauthorized: token has expired")).toBe("auth-expired");
    expect(toolFailureKind("invalid_grant: refresh token revoked")).toBe("auth-expired");
    expect(toolFailureKind("403 Forbidden")).toBe("permission-denied");
    expect(toolFailureKind("EACCES: permission denied, open '/etc/x'")).toBe("permission-denied");
    expect(toolFailureKind("The request timed out after 30s")).toBe("timeout");
    expect(toolFailureKind("ENOENT: no such file or directory, open 'notes.md'")).toBe("not-found");
    expect(toolFailureKind("Channel not found")).toBe("not-found");
    expect(toolFailureKind("Invalid tool call: bot_ids is required")).toBeNull();
  });

  it("puts the rate limit ahead of a timeout and an expired sign-in ahead of a refusal", () => {
    expect(toolFailureKind("429: too many requests, request timed out")).toBe("rate-limited");
    expect(toolFailureKind("401 Unauthorized, access denied")).toBe("auth-expired");
  });

  it("appends one hint, never to a failure that already says what to do", () => {
    const hinted = withNextStep("ENOENT: no such file");
    expect(hinted).toMatch(new RegExp(`^ENOENT: no such file\\n\\n${NEXT_STEP_LEAD}`));
    expect(withNextStep(hinted)).toBe(hinted);
    expect(nextStepHint("Metal note: Gmail is signed out. 401")).toBe("");
    expect(withNextStep("Invalid arguments")).toBe("Invalid arguments");
  });

  it("adds a text block to an MCP error result only", () => {
    const failed = { content: [{ type: "text", text: "403 Forbidden" }], isError: true };
    const hinted = withNextStepResult(failed);
    expect(hinted.content).toHaveLength(2);
    expect(hinted.content[1]).toMatchObject({ type: "text", text: expect.stringContaining(NEXT_STEP_LEAD) });
    const ok = { content: [{ type: "text", text: "Found: 404 is the page count" }] };
    expect(withNextStepResult(ok)).toBe(ok);
  });

  it("rewrites a stdio frame only when it is a failed call it can help", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "request timed out" }], isError: true } });
    expect(withNextStepLine(line)).toContain(NEXT_STEP_LEAD);
    const fine = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "timed out yesterday" }] } });
    expect(withNextStepLine(fine)).toBe(fine);
    expect(withNextStepLine('{"isError":true, not json')).toBe('{"isError":true, not json');
  });

  it("keeps every hint free of em dashes", () => {
    for (const text of ["429", "401 Unauthorized", "403", "timed out", "not found"]) expect(nextStepHint(text)).not.toContain("\u2014");
  });
});
