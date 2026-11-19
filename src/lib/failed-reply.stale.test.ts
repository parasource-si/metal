import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { currentFailureWords, FAILED_REPLY_STALE_MS, trailingRows } from "./failed-reply";

const NOW = Date.UTC(2026, 10, 13);
const user = (at: number): Message => ({ id: `u${at}`, role: "user", kind: "text", text: "hi", at } as Message);
const failed = (at: number, tool: Partial<NonNullable<Message["tool"]>> = {}): Message => ({
  id: `f${at}`, role: "bot", kind: "activity", at,
  tool: { name: "error: The VPS container uses an incompatible or untrusted OpenMausBot image. Check it in the Screen panel.", ok: false, ...tool },
} as Message);

describe("stale failed replies", () => {
  it("shows a fresh failure", () => {
    expect(trailingRows([user(NOW - 60_000), failed(NOW - 30_000)], 200, NOW).failures).toHaveLength(1);
  });

  it("drops a failure a day old, though nothing came after it", () => {
    expect(trailingRows([user(NOW - FAILED_REPLY_STALE_MS - 2), failed(NOW - FAILED_REPLY_STALE_MS - 1)], 200, NOW).failures).toEqual([]);
  });

  it("drops a failure the server marked fixed", () => {
    expect(trailingRows([user(NOW - 60_000), failed(NOW - 30_000, { resolvedAt: NOW - 1_000 })], 200, NOW).failures).toEqual([]);
  });
});

describe("old error words", () => {
  it("says the old incompatible image error in plain current words", () => {
    const line = currentFailureWords("The VPS container uses an incompatible or untrusted OpenMausBot image. This conversation is back on Auto.");
    expect(line).toBe("This bot's computer was on an older version. Waking it brings it up to date.");
  });

  it("never shows an old app name", () => {
    const line = currentFailureWords("OpenMausBot can't use this computer yet: no running desktop. MausBot and Maus Bot too.");
    expect(line).not.toMatch(/maus/i);
    expect(line).toContain("Metal can't use this computer yet");
  });

  it("leaves current words alone", () => {
    expect(currentFailureWords("The reply timed out")).toBe("The reply timed out");
  });
});
