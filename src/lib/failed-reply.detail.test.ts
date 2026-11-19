import { describe, expect, it } from "vitest";
import { failedReplyDetail } from "./failed-reply";

describe("a failed reply's line", () => {
  it("names the AI that couldn't be reached, never Metal", () => {
    for (const cause of ["fetch failed", "TypeError: fetch failed", "connect ECONNREFUSED 127.0.0.1:11434"]) {
      const line = failedReplyDetail("other", "My server", true, cause);
      expect(line).toBe("Couldn't reach My server. Check its address and that it's running where your bot runs, then try again.");
      expect(line).not.toMatch(/dusk bot/i);
    }
  });

  it("keeps other causes as they were", () => {
    expect(failedReplyDetail("other", "My server", true, "502 Bad Gateway")).toBe("Something went wrong on the other end. Try again.");
    expect(failedReplyDetail("other", "My server", true, "The model refused this request.")).toBe("The model refused this request.");
  });

  it("says why in plain words when the engine's own words are technical", () => {
    expect(failedReplyDetail("cli_exit", "GitHub Copilot", false, "GitHub Copilot exited 1 before the prompt result"))
      .toBe("GitHub Copilot stopped before it could reply. Try again.");
    expect(failedReplyDetail("model_not_found", "DeepSeek", false, "upstream HTTP 400: Model Not Exist")).toBe("DeepSeek doesn't offer this model. Pick another model for this bot.");
    expect(failedReplyDetail("provider_down", "GLM", true, "upstream HTTP 500: {\"error\":{\"type\":\"server_error\"}}")).toBe("GLM is having trouble right now. Try again in a few minutes.");
    expect(failedReplyDetail("context", "Codex", false, "")).toBe("This chat is too long for the model. Start a new chat, or pick a model with more room.");
    expect(failedReplyDetail("session_lost", "Claude", false, "No conversation found with session ID: e8b9f01e-97e3-4be6-a55c-be988595628a"))
      .toBe("Your AI lost this chat's memory. Start a new chat to keep going.");
  });

  it("keeps the engine's own sentence when it says more", () => {
    expect(failedReplyDetail("bad_request", "My server", true, "upstream HTTP 400: Invalid value for temperature, it must be below 2.")).toBe("Invalid value for temperature, it must be below 2.");
    expect(failedReplyDetail("cli_missing", "Copilot", false, "`copilot` isn't installed, or isn't on this app's PATH")).toBe("`copilot` isn't installed, or isn't on this app's PATH");
  });
});
