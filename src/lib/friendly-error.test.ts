import { describe, expect, it } from "vitest";
import { friendlyError } from "./plain-error";

const GENERIC = "Something went wrong. Try again.";

describe("friendlyError", () => {
  it.each<[string, unknown, string]>([
    ["a stale lazy chunk", new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1:5199/node_modules/.vite/deps/@hpke_core.js?v=1"), "The app updated. Reload to continue."],
    ["Safari's stale chunk", new TypeError("Importing a module script failed."), "The app updated. Reload to continue."],
    ["Firefox's stale chunk", "error loading dynamically imported module: https://app.dusk.bot/assets/x-1.js", "The app updated. Reload to continue."],
    ["a fetch that never answered", new TypeError("Failed to fetch"), "Couldn't reach Metal. Check that it's running, then try again."],
    ["Firefox's fetch failure", new TypeError("NetworkError when attempting to fetch resource."), "Couldn't reach Metal. Check that it's running, then try again."],
    ["a refused connection", new Error("connect ECONNREFUSED 127.0.0.1:8799"), "The connection dropped. Try again."],
    ["a timeout", new DOMException("signal timed out", "TimeoutError"), "That took too long. Try again."],
    ["an abort", new DOMException("The operation was aborted.", "AbortError"), "That took too long. Try again."],
    ["a 502", "502 Bad Gateway", "Something went wrong on the other end. Try again."],
    ["an HTTP 500 with JSON", 'HTTP 500 {"error":"boom"}', "Something went wrong on the other end. Try again."],
    ["HTML read as JSON", new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"), GENERIC],
    ["Chrome's undefined read", new TypeError("Cannot read properties of undefined (reading 'id')"), GENERIC],
    ["Firefox's undefined read", new TypeError("e.foo is undefined"), GENERIC],
    ["a missing function", new TypeError("desktop.shown is not a function"), GENERIC],
    ["Safari's undefined read", new TypeError("undefined is not an object (evaluating 'a.b')"), GENERIC],
    ["a stack", "TypeError: boom\n    at run (file:///app/main.js:1:1)", GENERIC],
    ["a sentence carrying its stack", "Error: My Cloud is full.\n    at add (main.js:1:1)", "My Cloud is full."],
    ["an Electron call's wrapper", new Error("Error invoking remote method 'files:share': Error: EACCES: permission denied, open '/Users/sam/a'"), "This computer didn't allow that. Check the file or folder permissions, then try again."],
    ["an address in the words", new Error("could not load https://example.com/x.json"), GENERIC],
    ["a code file path", new Error("cannot open /app/dist/assets/index-abc.js"), GENERIC],
    ["nothing at all", undefined, GENERIC],
    ["an empty Error", new Error(""), GENERIC],
    ["an object with a server error", { error: { message: "502 Bad Gateway" } }, "Something went wrong on the other end. Try again."],
  ])("turns %s into plain words", (_, reason, line) => {
    expect(friendlyError(reason)).toBe(line);
  });

  it.each([
    "That name is taken. Pick another.",
    "Your Pro plan includes 2 cloud computers at once. Delete one to start another.",
    "Couldn't undo that change.",
    "Add your key in Settings → API keys",
  ])("keeps a plain sentence as it is: %j", (sentence) => {
    expect(friendlyError(new Error(sentence))).toBe(sentence);
    expect(friendlyError(sentence)).toBe(sentence);
  });

  it("uses the caller's words when the failure says nothing a person can use", () => {
    expect(friendlyError(new TypeError("x.y is not a function"), "Could not save the skill.")).toBe("Could not save the skill.");
    expect(friendlyError(null, "Could not save the skill.")).toBe("Could not save the skill.");
    // a kind with its own advice beats the generic stand-in
    expect(friendlyError(new TypeError("Failed to fetch"), "Could not save the skill.")).toBe("Couldn't reach Metal. Check that it's running, then try again.");
  });

  it("never lets an address, a code file or a stack through", () => {
    const raw = [
      new TypeError("Failed to fetch dynamically imported module: http://localhost/src/x.tsx"),
      new Error("Loading chunk 42 failed."),
      new Error("ChunkLoadError: Loading chunk vendors failed"),
      "TypeError: x is undefined",
      new RangeError("Maximum call stack size exceeded"),
      "ReferenceError: foo is not defined",
      'API Error: 529 {"type":"error"}',
      "see node_modules/react-dom/cjs/react-dom.development.js",
    ];
    for (const reason of raw) {
      const line = friendlyError(reason);
      expect(line, String(reason)).not.toMatch(/https?:\/\/|\.m?[jt]sx?\b|node_modules|\n\s+at |\{"|Error:/);
    }
  });
});
