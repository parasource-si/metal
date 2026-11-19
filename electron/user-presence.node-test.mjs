import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DEFAULT_PRESENCE_REASON, createUserPresence, installUserPresence, linuxPkexecCheck, presenceReason } from "./user-presence.mjs";
import { helloOutcome } from "./windows-hello.mjs";

function setup(platform, overrides = {}) {
  const calls = { confirm: [], touch: [], hello: [], linux: 0, log: [] };
  const presence = createUserPresence({
    platform,
    helloOutcome,
    confirm: async (reason) => { calls.confirm.push(reason); return overrides.confirmAnswer ?? true; },
    systemPreferences: overrides.systemPreferences ?? {
      canPromptTouchID: () => overrides.touch !== false,
      promptTouchID: (reason) => { calls.touch.push(reason); return overrides.touchResult ?? Promise.resolve(); },
    },
    windowsHello: async (input) => { calls.hello.push(input); return overrides.hello ?? { availability: 0, result: 0 }; },
    linuxCheck: async () => { calls.linux += 1; return overrides.linux ?? "pass"; },
    log: (line) => calls.log.push(line),
    timeoutMs: overrides.timeoutMs ?? 1_000,
  });
  return { presence, calls };
}

test("macOS: Touch ID passes with the reason, and the app asks nothing else", async () => {
  const { presence, calls } = setup("darwin");
  assert.equal(await presence("show a code"), true);
  assert.deepEqual(calls.touch, ["show a code"]);
  assert.deepEqual(calls.confirm, []);
  assert.deepEqual(calls.log, ["user presence: touch-id pass"]);
});

test("macOS: a cancelled or failed Touch ID is a no, never the weaker confirm", async () => {
  const { presence, calls } = setup("darwin", { touchResult: Promise.reject(new Error("User canceled")) });
  assert.equal(await presence("show a code"), false);
  assert.deepEqual(calls.confirm, []);
  assert.deepEqual(calls.log, ["user presence: touch-id fail"]);
});

test("macOS: an ignored Touch ID prompt times out as a no", async () => {
  const { presence } = setup("darwin", { touchResult: new Promise(() => {}), timeoutMs: 20 });
  assert.equal(await presence("show a code"), false);
});

test("macOS without Touch ID (or a closed lid) confirms in the app", async () => {
  for (const systemPreferences of [{ canPromptTouchID: () => false }, {}, { canPromptTouchID: () => { throw new Error("x"); } }]) {
    const { presence, calls } = setup("darwin", { systemPreferences, confirmAnswer: false });
    assert.equal(await presence("show a code"), false);
    assert.deepEqual(calls.confirm, ["show a code"]);
  }
  const { presence } = setup("darwin", { touch: false });
  assert.equal(await presence("show a code"), true);
});

test("Windows: Hello verifies, parented to the window, with a full sentence", async () => {
  const { presence, calls } = setup("win32");
  assert.equal(await presence("show a code", { hwnd: "4242" }), true);
  assert.equal(calls.hello[0].hwnd, "4242");
  assert.equal(calls.hello[0].reason, "Metal wants to show a code.");
  assert.deepEqual(calls.confirm, []);
});

test("Windows: Hello offered and cancelled is a no", async () => {
  for (const hello of [{ availability: 0, result: 6 }, { availability: 0, result: null }, { availability: 4, result: null }]) {
    const { presence, calls } = setup("win32", { hello });
    assert.equal(await presence("show a code"), false);
    assert.deepEqual(calls.confirm, []);
  }
});

test("Windows: no Hello set up, or a helper that cannot run, confirms in the app", async () => {
  for (const hello of [{ availability: 2, result: null }, { availability: 1, result: null }, { availability: null, result: null, error: true }]) {
    const { presence, calls } = setup("win32", { hello });
    assert.equal(await presence("show a code"), true);
    assert.deepEqual(calls.confirm, ["show a code"]);
  }
});

test("Linux: polkit's answer stands; no polkit agent confirms in the app", async () => {
  assert.equal(await setup("linux", { linux: "pass" }).presence("x"), true);
  const failed = setup("linux", { linux: "fail" });
  assert.equal(await failed.presence("x"), false);
  assert.deepEqual(failed.calls.confirm, []);
  const missing = setup("linux", { linux: "unavailable" });
  assert.equal(await missing.presence("x"), true);
  assert.deepEqual(missing.calls.confirm, ["x"]);
});

test("a second request while one is open shares its answer instead of stacking prompts", async () => {
  let release;
  const { presence, calls } = setup("darwin", { touchResult: new Promise((resolve) => { release = resolve; }) });
  const both = Promise.all([presence("a"), presence("b")]);
  release();
  assert.deepEqual(await both, [true, true]);
  assert.equal(calls.touch.length, 1);
  await presence("c");
  assert.equal(calls.touch.length, 2);
});

test("an in-app confirm that never closes is a no", async () => {
  const presence = createUserPresence({ platform: "linux", linuxCheck: async () => "unavailable", confirm: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(await presence("x"), false);
});

test("a page's reason is cleaned; pages from elsewhere get the fixed reason", () => {
  assert.equal(presenceReason("  show\n a\u0000 code ‮ ", true), "show a code");
  assert.equal(presenceReason("x".repeat(500), true).length, 120);
  assert.equal(presenceReason("pay $100", false), DEFAULT_PRESENCE_REASON);
  assert.equal(presenceReason(42, true), DEFAULT_PRESENCE_REASON);
  assert.equal(presenceReason(" \t ", true), DEFAULT_PRESENCE_REASON);
});

function pkexecSpawn(code, stderr = "") {
  const calls = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => { child.killed = true; };
    calls.push({ file, args, child });
    if (code !== undefined) queueMicrotask(() => { if (stderr) child.stderr.emit("data", stderr); child.emit("close", code); });
    return child;
  };
  return { spawn, calls };
}
const linuxEnv = { DISPLAY: ":0" };
const allExist = () => true;

test("pkexec: the system password passes; a dismissed or failed prompt fails", async () => {
  const ok = pkexecSpawn(0);
  assert.equal(await linuxPkexecCheck({ spawn: ok.spawn, exists: allExist, env: linuxEnv }), "pass");
  assert.deepEqual(ok.calls[0].args, ["--disable-internal-agent", "/usr/bin/true"]);
  assert.equal(ok.calls[0].file, "/usr/bin/pkexec");
  assert.equal(await linuxPkexecCheck({ spawn: pkexecSpawn(126).spawn, exists: allExist, env: linuxEnv }), "fail");
  assert.equal(await linuxPkexecCheck({ spawn: pkexecSpawn(127, "Error executing command as another user: Not authorized").spawn, exists: allExist, env: linuxEnv }), "fail");
});

test("pkexec: no agent, no pkexec, or no graphical session is unavailable", async () => {
  assert.equal(await linuxPkexecCheck({ spawn: pkexecSpawn(127, "Error executing command as another user: No authentication agent found.").spawn, exists: allExist, env: linuxEnv }), "unavailable");
  assert.equal(await linuxPkexecCheck({ spawn: pkexecSpawn(0).spawn, exists: (file) => !file.includes("pkexec"), env: linuxEnv }), "unavailable");
  assert.equal(await linuxPkexecCheck({ spawn: pkexecSpawn(0).spawn, exists: allExist, env: {} }), "unavailable");
  assert.equal(await linuxPkexecCheck({ spawn: () => { throw new Error("ENOENT"); }, exists: allExist, env: linuxEnv }), "unavailable");
});

test("pkexec: a prompt nobody answers is killed and fails", async () => {
  const hung = pkexecSpawn(undefined);
  assert.equal(await linuxPkexecCheck({ spawn: hung.spawn, exists: allExist, env: { WAYLAND_DISPLAY: "wayland-0" }, timeoutMs: 20 }), "fail");
  assert.equal(hung.calls[0].child.killed, true);
});

test("the IPC handler goes through the guard, words the reason by sender and parents the confirm to the app window", async () => {
  const handlers = new Map(), dialogs = [], guarded = [];
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(99n);
  const win = { isDestroyed: () => false, getNativeWindowHandle: () => handle };
  installUserPresence({
    platform: "darwin",
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    guard: (handler) => (event, ...args) => { guarded.push(event); return handler(event, ...args); },
    dialog: { showMessageBox: async (parent, options) => { dialogs.push([parent, options]); return { response: 0 }; } },
    systemPreferences: { canPromptTouchID: () => false },
    window: () => win,
    trusted: (event) => event.local === true,
  });
  const handler = handlers.get("presence:require");
  assert.equal(await handler({ local: true }, "open settings"), true);
  assert.equal(await handler({ local: false }, "pay $100"), true);
  assert.equal(guarded.length, 2);
  assert.equal(dialogs[0][0], win);
  assert.deepEqual(dialogs.map(([, options]) => options.detail), ["Metal wants to open settings.", `Metal wants to ${DEFAULT_PRESENCE_REASON}.`]);
  assert.equal(dialogs[0][1].cancelId, 1);
  assert.equal(dialogs[0][1].defaultId, 1, "Enter alone never confirms");
});

test("with no app window the in-app confirm is a no", async () => {
  const handlers = new Map();
  installUserPresence({
    platform: "linux", ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, guard: (handler) => handler,
    dialog: { showMessageBox: async () => ({ response: 0 }) }, systemPreferences: {}, window: () => null, trusted: () => true,
  });
  // linux with no DISPLAY in this fake falls straight to the confirm, which has no window to sit on
  const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
  try { assert.equal(await handlers.get("presence:require")({}, "x"), false); }
  finally { for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value; }
});
