import assert from "node:assert/strict";
import test from "node:test";
import { loadWithOneRetry, offerRestart } from "./recovery-prompts.mjs";

function fakeWindow() {
  const loads = [];
  let failed = null;
  return {
    loads,
    fail: (url) => failed?.({}, -102, "ERR_CONNECTION_REFUSED", url, true),
    isDestroyed: () => false,
    loadURL: (url) => { loads.push(url); return Promise.resolve(); },
    webContents: { on: (name, handler) => { if (name === "did-fail-load") failed = handler; } },
  };
}

test("a page that fails to load tries once more by itself, then shows what to press", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const win = fakeWindow();
  loadWithOneRetry(win, "http://127.0.0.1:7000/viewer", (url) => `data:failed,${url}`);
  assert.deepEqual(win.loads, ["http://127.0.0.1:7000/viewer"]);
  win.fail("http://127.0.0.1:7000/viewer");
  assert.equal(win.loads.length, 1, "no failure page on the first miss");
  t.mock.timers.tick(2000);
  assert.deepEqual(win.loads, ["http://127.0.0.1:7000/viewer", "http://127.0.0.1:7000/viewer"]);
  win.fail("http://127.0.0.1:7000/viewer");
  assert.equal(win.loads.at(-1), "data:failed,http://127.0.0.1:7000/viewer");
});

test("a server that can't come back says so in one sentence and offers Restart Metal", async () => {
  const calls = [];
  const app = { relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit") };
  let shown;
  await offerRestart({ dialog: { showMessageBox: async (options) => { shown = options; return { response: 0 }; } }, app });
  assert.equal(shown.buttons[0], "Restart Metal");
  assert.equal(shown.message, "The bot server stopped");
  assert.equal(shown.detail, "Restart Metal to bring it back.");
  assert.deepEqual(calls, ["relaunch", "quit"]);
});
