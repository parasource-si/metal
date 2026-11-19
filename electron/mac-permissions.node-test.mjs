import assert from "node:assert/strict";
import test from "node:test";
import { createMacPermissions, installMacPermissions } from "./mac-permissions.mjs";

function fakeMac({ trusted = false, screen = "denied", saved = {} } = {}) {
  const calls = { prompt: 0, capture: 0, settings: [], notes: [], computerUse: 0, writes: [] };
  const mac = { trusted, screen };
  let file = saved;
  const deps = {
    platform: "darwin",
    systemPreferences: {
      isTrustedAccessibilityClient: (prompt) => { if (prompt) calls.prompt++; return mac.trusted; },
      getMediaAccessStatus: (type) => (type === "screen" ? mac.screen : "unknown"),
    },
    desktopCapturer: { getSources: async () => { calls.capture++; return []; } },
    Notification: class { constructor(options) { this.options = options; } show() { calls.notes.push(this.options); } static isSupported() { return true; } },
    store: { read: () => file, write: (value) => { file = value; calls.writes.push(value); } },
    openSettings: async (pane) => { calls.settings.push(pane); },
    computerUse: async () => { calls.computerUse++; },
  };
  return { deps, calls, mac };
}

test("reading never prompts, and says what is missing", () => {
  const { deps, calls } = fakeMac();
  const permissions = createMacPermissions(deps);
  assert.deepEqual(permissions.status(), { supported: true, accessibility: "missing", screen: "missing" });
  assert.equal(calls.prompt, 0);
  assert.equal(calls.capture, 0);
});

test("off macOS there is nothing to ask", async () => {
  const { deps, calls } = fakeMac();
  const permissions = createMacPermissions({ ...deps, platform: "win32" });
  assert.deepEqual(permissions.status(), { supported: false });
  assert.deepEqual(await permissions.request("accessibility"), { supported: false });
  assert.equal(calls.prompt, 0);
});

test("accessibility: macOS's prompt first, then its System Settings pane", async () => {
  const { deps, calls } = fakeMac();
  const permissions = createMacPermissions(deps);
  assert.equal((await permissions.request("accessibility")).accessibility, "asked");
  assert.equal(calls.prompt, 1);
  assert.deepEqual(calls.settings, []);
  await permissions.request("accessibility");
  assert.equal(calls.prompt, 1);
  assert.deepEqual(calls.settings, ["accessibility"]);
});

test("screen recording: a real capture asks first, then the pane; it stays asked until the app reopens", async () => {
  const { deps, calls } = fakeMac();
  const permissions = createMacPermissions(deps);
  assert.equal((await permissions.request("screen")).screen, "asked");
  assert.equal(calls.capture, 1);
  await permissions.request("screen");
  assert.equal(calls.capture, 1);
  assert.deepEqual(calls.settings, ["screen"]);
});

test("a granted permission is never asked again", async () => {
  const { deps, calls } = fakeMac({ trusted: true, screen: "granted" });
  const permissions = createMacPermissions(deps);
  await permissions.request("accessibility");
  await permissions.request("screen");
  assert.equal(calls.prompt + calls.capture + calls.settings.length, 0);
});

test("notifications are never asked for on a Mac: asking posts nothing and saves nothing", async () => {
  const { deps, calls } = fakeMac({ saved: { other: 1 } });
  const permissions = createMacPermissions(deps);
  const after = await permissions.request("notifications", { title: "Metal", body: "hello" });
  assert.equal("notifications" in after, false);
  assert.deepEqual(calls.notes, []);
  assert.deepEqual(calls.writes, []);
});

test("once both are granted after being asked here, the computer helper restarts once to pick them up", async () => {
  const { deps, calls, mac } = fakeMac();
  const permissions = createMacPermissions(deps);
  await permissions.request("accessibility");
  mac.trusted = true;
  permissions.status();
  assert.equal(calls.computerUse, 0, "screen recording still missing");
  mac.screen = "granted";
  permissions.status();
  permissions.status();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.computerUse, 1);
});

test("an app that already had both never restarts the helper just for reading", async () => {
  const { deps, calls } = fakeMac({ trusted: true, screen: "granted" });
  createMacPermissions(deps).status();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.computerUse, 0);
});

test("an unknown permission asks for nothing", async () => {
  const { deps, calls } = fakeMac();
  await createMacPermissions(deps).request("microphone");
  assert.equal(calls.prompt + calls.capture + calls.settings.length + calls.notes.length, 0);
});

test("registers both channels behind this computer's own-page guard", async () => {
  const { deps, calls } = fakeMac();
  const handlers = new Map(), guarded = [];
  const guard = (channel, handler) => { guarded.push(channel); return handler; };
  installMacPermissions({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard, ...deps });
  assert.deepEqual(guarded, ["mac-permissions:status", "mac-permissions:request"]);
  assert.equal((await handlers.get("mac-permissions:request")({}, "accessibility")).accessibility, "asked");
  assert.equal(calls.prompt, 1);
});
