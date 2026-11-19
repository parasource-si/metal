import { describe, expect, it } from "vitest";

import { ECHOED_PROMPT } from "../../../shared/failed-turn.ts";
import { acpRpcError } from "./rpc-error.ts";

describe("an ACP error that repeats the prompt back", () => {
  it("names the failure without the system prompt or the bot's folder", () => {
    // The Python ACP SDK answers an unexpected exception with {code: -32603, message: "Internal error", data: {details: str(exc)}};
    // a KeyError keyed by the prompt text makes str(exc) the prompt's repr.
    const prompt = "You are Campaign Manager, a personal bot in Metal.\n\nAbout you: you are Campaign Manager, a Metal bot. "
      + "Notes are kept in \"/Users/someone/.duskbot/workspaces/0f6c2a4e/MEMORY.md\".\n\n".repeat(6) + "Reply to the group.";
    const error = acpRpcError({ code: -32603, message: "Internal error", data: { details: `'${prompt.replace(/\n/g, "\\n")}'` } }, "session/prompt");
    expect(error.message).toBe(`Internal error: ${ECHOED_PROMPT} (session/prompt)`);
    expect(error.message).not.toMatch(/Campaign Manager|\.duskbot/);
    expect((error as { acpSessionFailure?: boolean }).acpSessionFailure).toBe(true);
  });

  it("keeps an ordinary internal error's words", () => {
    expect(acpRpcError({ code: -32603, message: "Internal error", data: { details: "Unauthorized (401) from api.x.ai" } }, "session/prompt").message)
      .toBe("Internal error: Unauthorized (401) from api.x.ai (session/prompt)");
  });
});
