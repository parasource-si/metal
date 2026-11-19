import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyPendingDesktopStartFresh, CONFIRM_PHRASE, confirmed, createStartFresh, DESKTOP_MARKER, markDesktopStartFresh } from "./start-fresh.mjs";
import { SERVER_LEASE_NAME } from "./legacy-names.mjs";

function harness({ signedIn = true, fail = {} } = {}) {
  const calls = [];
  const failing = { ...fail };
  const maybe = (name) => {
    if (failing[name] > 0) { failing[name]--; throw Object.assign(new Error(`${name} is offline`), { code: "offline" }); }
  };
  let account = signedIn ? { email: "tester@qa.dusk.test" } : null;
  const views = [];
  const fresh = createStartFresh({
    account: () => account,
    signOut: async () => { calls.push("signout"); maybe("signout"); account = null; },
    removeAiKeys: async () => { calls.push("ai"); maybe("ai"); },
    markLocal: () => calls.push("mark"),
    relaunch: () => calls.push("relaunch"),
    changed: (view) => views.push(view),
  });
  return { fresh, calls, views };
}

test("nothing is reset until the confirm words are typed, whatever the page sends", async () => {
  assert.equal(CONFIRM_PHRASE, "start fresh");
  assert.equal(confirmed(CONFIRM_PHRASE), true);
  assert.equal(confirmed("  Start Fresh "), true);
  // the old phrase no longer runs anything
  for (const typed of ["", "start", "delete everything", "start fresh now", null, undefined, 1]) assert.equal(confirmed(typed), false);
  const { fresh, calls } = harness();
  await assert.rejects(fresh.run("start"), { code: "not_confirmed" });
  assert.deepEqual(calls, []);
  assert.equal(fresh.view().phase, "idle");
});

test("the preview lists only this computer's parts, without touching anything", () => {
  const { fresh, calls } = harness();
  assert.deepEqual(fresh.preview().steps.map((step) => [step.id, step.kind, step.status]), [["signout", "signout", "pending"], ["ai", "ai", "pending"], ["local", "local", "pending"]]);
  assert.deepEqual(calls, []);
});

test("it never deletes the account, cancels a plan or touches a server or cloud: it signs this computer out and clears it", async () => {
  // the deps have no way to reach the account's plan, clouds or servers at all; a run only signs out and clears keys
  const { fresh, calls } = harness();
  const view = await fresh.run(CONFIRM_PHRASE);
  assert.equal(view.phase, "done");
  assert.deepEqual(calls, ["mark", "signout", "ai"]);
  assert.ok(!view.steps.some((step) => ["account", "plan", "server"].includes(step.kind)));
  await fresh.finish();
  assert.equal(calls.at(-1), "relaunch");
  assert.equal(fresh.view().phase, "restarting");
});

test("a failed sign-out doesn't stop the rest; a retry runs only it", async () => {
  const { fresh, calls } = harness({ fail: { signout: 1 } });
  const view = await fresh.run(CONFIRM_PHRASE);
  assert.equal(view.phase, "partial");
  assert.deepEqual(view.steps.filter((step) => step.status === "failed").map((step) => [step.id, step.error]), [["signout", "signout is offline"]]);
  assert.ok(calls.includes("ai"));
  calls.length = 0;
  const again = await fresh.retry();
  assert.equal(again.phase, "done");
  assert.deepEqual(calls, ["signout"]);
});

test("signed out: no sign-out step, the rest still goes", async () => {
  const { fresh } = harness({ signedIn: false });
  assert.deepEqual(fresh.preview().steps.map((step) => step.id), ["ai", "local"]);
  assert.equal((await fresh.run(CONFIRM_PHRASE)).phase, "done");
});

test("a second run while one is going is the same run", async () => {
  const { fresh, calls } = harness();
  const [a, b] = await Promise.all([fresh.run(CONFIRM_PHRASE), fresh.run(CONFIRM_PHRASE)]);
  assert.deepEqual(a, b);
  assert.equal(calls.filter((call) => call === "signout").length, 1);
});

test("finish is refused before a run", async () => {
  const { fresh, calls } = harness();
  await fresh.finish();
  assert.deepEqual(calls, []);
});

test("the next start deletes this computer's data, named local folders and Metal's own files, keeping tools, the lease and Chromium's", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-fresh-desktop-"));
  try {
    const userData = path.join(root, "userData"), dataDir = path.join(root, ".duskbot"), named = path.join(root, ".duskbot-work"), stranger = path.join(root, "Documents");
    for (const dir of [userData, dataDir, named, stranger, `${dataDir}-clean`, path.join(userData, "cloud-sync"), path.join(userData, "Local Storage"), path.join(dataDir, "tools"), path.join(dataDir, "workspaces")]) fs.mkdirSync(dir, { recursive: true });
    for (const file of ["bots.json", "messages.db", "config.json", SERVER_LEASE_NAME]) fs.writeFileSync(path.join(dataDir, file), "x");
    for (const file of ["credentials.bin", "cloud-account-custom.bin", "vps-link.json", "window-state.json", "Cookies", "Preferences"]) fs.writeFileSync(path.join(userData, file), "x");
    fs.writeFileSync(path.join(userData, "environments.json"), JSON.stringify({ environments: [{ kind: "local", dataDir: named }, { kind: "local", dataDir: stranger }, { kind: "remote", origin: "https://x.test" }] }));
    assert.equal(applyPendingDesktopStartFresh({ userData, dataDir }), false);
    assert.ok(fs.existsSync(path.join(dataDir, "bots.json")));
    markDesktopStartFresh(userData);
    assert.equal(applyPendingDesktopStartFresh({ userData, dataDir }), true);
    assert.deepEqual(fs.readdirSync(dataDir).sort(), [SERVER_LEASE_NAME, "tools"].sort());
    assert.equal(fs.existsSync(named), false);
    assert.equal(fs.existsSync(`${dataDir}-clean`), false);
    // a folder not named like a data folder is never deleted, whatever environments.json says
    assert.equal(fs.existsSync(stranger), true);
    assert.deepEqual(fs.readdirSync(userData).sort(), ["Cookies", "Local Storage", "Preferences", "window-state.json"].sort());
    assert.equal(fs.existsSync(path.join(userData, DESKTOP_MARKER)), false);
    assert.equal(applyPendingDesktopStartFresh({ userData, dataDir }), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
