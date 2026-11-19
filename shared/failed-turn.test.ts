import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ECHOED_PROMPT, FAILED_TURN_MAX_CHARS, failedTurnCause, failedTurnTool, isErrorDump, sendsErrorDump, withoutEchoedPrompt } from "./failed-turn";

describe("a failed turn's row", () => {
  it("reads back exactly what was written", () => {
    const limit = "Your Pro plan includes 2 cloud computers at once. Delete one to start another.";
    expect(failedTurnTool(limit)).toEqual({ name: `error: ${limit}`, ok: false });
    expect(failedTurnCause(failedTurnTool(limit).name)).toBe(limit);
    expect(failedTurnCause("Bash")).toBeNull();
    expect(failedTurnCause("notice: retrying")).toBeNull();
  });

  it("keeps a long cause's next action, whichever path wrote it", () => {
    const cause = `Automatic recovery unavailable: ${"the backup engine cannot run this thread here. ".repeat(5)}Original error: Your Pro plan includes 2 cloud computers at once. Delete one to start another.`;
    expect(cause.length).toBeGreaterThan(320);
    expect(failedTurnCause(failedTurnTool(cause).name)).toBe(cause);
  });

  it("bounds only a pathological message, and says it was cut", () => {
    const words = failedTurnCause(failedTurnTool("x".repeat(30_000)).name)!;
    expect(words).toHaveLength(FAILED_TURN_MAX_CHARS);
    expect(words.endsWith("…")).toBe(true);
  });

  it("carries the flags a client acts on, and only when set", () => {
    expect(failedTurnTool("Not logged in", { setup: true, terminal: true, claudeUpdate: true }))
      .toEqual({ name: "error: Not logged in", ok: false, setup: true, terminal: true, claudeUpdate: true });
    expect(Object.keys(failedTurnTool("rate limited", { setup: false }))).toEqual(["name", "ok"]);
  });

  it("is the only way the server writes one", () => {
    const dir = new URL("../server/", import.meta.url);
    const handWritten = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .map((file) => file.replaceAll("\\", "/"))
      // server/headless is the metal command line: it prints errors to a terminal and never writes a turn row
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("testing") && !file.replaceAll("\\", "/").startsWith("headless/"))
      .flatMap((file) => readFileSync(new URL(file, dir), "utf8").split("\n")
        .filter((line) => /["'`]error: /.test(line))
        .map((line) => `${file}: ${line.trim()}`));
    expect(handWritten).toEqual([]);
  });
});

// A Python engine's KeyError on the prompt, through the ACP SDK's -32603 and acpRpcError, as a desktop user's group got it.
const PROMPT = "You are Campaign Manager, a personal bot in Metal.\n\nAbout you: you are Campaign Manager, a Metal bot. Metal is the app you live in; you are not ChatGPT, Claude, Codex or any vendor's assistant. "
  + "Your memory is kept in \"/Users/someone/.duskbot/workspaces/0f6c2a4e-1111-4222-8333-944455556666/MEMORY.md\" with topic notes beside it.\n\n".repeat(4);
const ECHO = `Internal error: '${PROMPT.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}' (session/prompt)`;

describe("an error that repeats the prompt back", () => {
  it("keeps the engine's words and loses the system prompt and the bot's folder", () => {
    const cause = failedTurnCause(failedTurnTool(ECHO).name)!;
    expect(cause).toBe(`Internal error: ${ECHOED_PROMPT} (session/prompt)`);
    expect(withoutEchoedPrompt(ECHO.slice(0, 600))).toBe(`Internal error: ${ECHOED_PROMPT}`);
    expect(withoutEchoedPrompt(`provider said: ${PROMPT}`)).toBe(`provider said: ${ECHOED_PROMPT}`);
  });

  it("leaves an ordinary error alone, quotes and apostrophes included", () => {
    for (const text of [
      "You've hit your limit · resets 3pm (Europe/Berlin)",
      "Invalid schema for function 'browser_click': 'ref' is required",
      `API Error: 400 {"type":"error","error":{"message":"prompt is too long: ${"9".repeat(6)} tokens > 200000 maximum. ${"Shorten the conversation or start a new one. ".repeat(8)}"}}`,
      `Automatic recovery unavailable: ${"the backup engine cannot run this thread here. ".repeat(8)}`,
    ]) expect(withoutEchoedPrompt(text)).toBe(text);
  });
});

describe("text bound for someone outside Metal", () => {
  it("is a dump when it is a failure report, an internal error, the system prompt or a bot's folder", () => {
    expect(isErrorDump(`Bot failed to respond\n${ECHO.slice(0, 600)}…`)).toBe(true);
    expect(isErrorDump("Internal error: 'anything'")).toBe(true);
    expect(isErrorDump(PROMPT)).toBe(true);
    const legacy = PROMPT.replace("in Metal.", "in dusk bot.").replace("a Metal bot.", "a dusk bot.");
    expect(isErrorDump(legacy)).toBe(true);
    expect(withoutEchoedPrompt(legacy)).toBe(ECHOED_PROMPT);
    expect(isErrorDump("see C:\\Users\\a\\.duskbot\\workspaces\\x\\MEMORY.md")).toBe(true);
    expect(isErrorDump("The flyers are printed. Internal review is on Friday, I'll error on the side of early.")).toBe(false);
  });

  it("finds a dump anywhere in a send's arguments", () => {
    expect(sendsErrorDump([{ arguments: { to: "Launch group", body: { parts: [{ text: ECHO }] } } }])).toBe(true);
    expect(sendsErrorDump([{ arguments: { to: "Launch group", text: "Posters go up at 6." } }, {}])).toBe(false);
  });
});
