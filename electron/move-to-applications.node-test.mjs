import assert from "node:assert/strict";
import test from "node:test";
import { bundleOf, inApplications, offerMoveToApplications } from "./move-to-applications.mjs";

const DMG = "/Volumes/dusk bot/Dusk Bot.app/Contents/MacOS/Dusk Bot";
const fakeApp = ({ packaged = true, inFolder = false, moves = true } = {}) => {
  const calls = [];
  return { calls, isPackaged: packaged, isInApplicationsFolder: () => inFolder, moveToApplicationsFolder: () => { calls.push("move"); return moves; } };
};
const memoryOf = (value = null) => { const box = { value }; return { box, read: () => box.value, write: (next) => { box.value = next; } }; };
const offer = (over = {}) => {
  const asked = [];
  const app = over.app ?? fakeApp();
  const memory = over.memory ?? memoryOf();
  const answer = over.answer ?? { response: 0, checkboxChecked: false };
  const result = offerMoveToApplications({ app, memory, home: "/Users/a", execPath: DMG, platform: "darwin", ask: async (options) => { asked.push(options); return answer; }, ...over, ...(over.app ? {} : { app }) });
  return { result, asked, app, memory };
};

test("the .app folder and whether it sits in either Applications folder", () => {
  assert.equal(bundleOf(DMG), "/Volumes/dusk bot/Dusk Bot.app");
  assert.equal(bundleOf("/usr/local/bin/node"), null);
  assert.ok(inApplications("/Applications/Dusk Bot.app", "/Users/a"));
  assert.ok(inApplications("/Users/a/Applications/Dusk Bot.app", "/Users/a"));
  assert.ok(!inApplications("/Volumes/dusk bot/Dusk Bot.app", "/Users/a"));
  assert.ok(!inApplications("/Applications Old/Dusk Bot.app", "/Users/a"));
});

test("opened from the disk image: asks, without a don't-ask box, and moves on yes", async () => {
  const { result, asked, app } = offer();
  assert.equal(await result, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, "Move Metal to Applications?");
  assert.deepEqual(asked[0].buttons, ["Move to Applications", "Not now"]);
  assert.equal(asked[0].checkboxLabel, undefined);
  assert.deepEqual(app.calls, ["move"]);
});

test("not now leaves the app where it is; the disk image asks again even after don't ask again", async () => {
  const { result, app } = offer({ answer: { response: 1, checkboxChecked: false } });
  assert.equal(await result, false);
  assert.deepEqual(app.calls, []);
  const declined = offer({ memory: memoryOf({ declined: true }) });
  assert.equal(await declined.result, true);
});

test("elsewhere outside Applications: don't ask again is kept", async () => {
  const execPath = "/Users/a/Downloads/Dusk Bot.app/Contents/MacOS/Dusk Bot";
  const first = offer({ execPath, answer: { response: 1, checkboxChecked: true } });
  assert.equal(await first.result, false);
  assert.equal(first.asked[0].checkboxLabel, "Don't ask again");
  assert.deepEqual(first.memory.box.value, { declined: true });
  const again = offer({ execPath, memory: first.memory });
  assert.equal(await again.result, false);
  assert.equal(again.asked.length, 0);
});

test("never asks in Applications, in dev, off macOS, at login or in an automated run", async () => {
  for (const over of [
    { execPath: "/Applications/Dusk Bot.app/Contents/MacOS/Dusk Bot" },
    { execPath: "/Users/a/Applications/Dusk Bot.app/Contents/MacOS/Dusk Bot" },
    { app: fakeApp({ inFolder: true }) },
    { app: fakeApp({ packaged: false }) },
    { platform: "win32" },
    { atLogin: true },
    { automated: true },
  ]) {
    const { result, asked } = offer(over);
    assert.equal(await result, false, JSON.stringify(over));
    assert.equal(asked.length, 0, JSON.stringify(over));
  }
});

test("a move electron refuses is logged, and the app carries on", async () => {
  const lines = [];
  const app = { ...fakeApp(), moveToApplicationsFolder: () => { throw new Error("denied"); } };
  const { result } = offer({ app, log: (line) => lines.push(line) });
  assert.equal(await result, false);
  assert.match(lines.at(-1), /denied/);
});
