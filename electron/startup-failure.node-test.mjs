import assert from "node:assert/strict";
import test from "node:test";
import { STARTUP_TRY_AGAIN, startupFailureWords } from "./startup-screen.mjs";

test("the startup card says a plain sentence of ours as it is", () => {
  assert.equal(startupFailureWords(new Error("Another copy of Metal is already open.")), "Another copy of Metal is already open.");
});

test("the startup card says one line of what to do for a raw error, which stays in the log", () => {
  for (const raw of [
    new Error("listen EADDRINUSE: address already in use 127.0.0.1:8799"),
    new Error("EACCES: permission denied, open '/Users/sam/Library/Application Support/duskbot/lease'"),
    new Error("TypeError: Cannot read properties of undefined (reading 'port')"),
    "the server exited",
    "",
  ]) assert.equal(startupFailureWords(raw), STARTUP_TRY_AGAIN);
});
