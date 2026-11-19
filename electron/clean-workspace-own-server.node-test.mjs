import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanWorkspaceDir, createCleanWorkspace } from "./clean-workspace.mjs";
import { createDevServerChild } from "./dev-server-child.mjs";
import { world } from "./fixtures/home-window-world.mjs";
import { installOwnHome } from "./own-home-main.mjs";

// A computer whose bots moved to a server of the person's own: its own view is a clean workspace with a fresh Metal, the
// frozen copy stays exactly as it was on disk, and moving back runs that copy again.
const SERVER = "https://garage.example.test";
const PLACE = "instance-20261103-1451";
const ownFreeze = { frozen: true, cloud: SERVER, place: PLACE };

function cleanSide({ fails = false } = {}) {
  const side = { on: false, enters: 0, leaves: 0,
    active: () => side.on,
    enter: async () => { side.enters++; if (fails) return false; side.on = true; return true; },
    leave: async () => { side.leaves++; side.on = false; return true; } };
  return side;
}

function tree(dir) {
  const out = {};
  const walk = (at) => {
    for (const name of fs.readdirSync(at).sort()) {
      const full = path.join(at, name), rel = path.relative(dir, full);
      if (fs.statSync(full).isDirectory()) { out[`${rel}/`] = "dir"; walk(full); }
      else out[rel] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** This computer's data folder, frozen by a finished move to PLACE, as the owner's install is. */
function frozenInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dusk-own-clean-"));
  const data = path.join(root, ".duskbot");
  fs.mkdirSync(path.join(data, "bots", "maus"), { recursive: true });
  fs.writeFileSync(path.join(data, "bots.json"), JSON.stringify([{ id: "maus", name: "Dusk" }, { id: "nova", name: "Nova" }]));
  fs.writeFileSync(path.join(data, "bots", "maus", "chat.jsonl"), "{\"text\":\"an old chat\"}\n");
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ language: "de", onboarding: { completedAt: "2026-01-01T00:00:00.000Z" } }));
  fs.writeFileSync(path.join(data, "environment-id"), "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f\n");
  fs.writeFileSync(path.join(data, "moved.json"), JSON.stringify({ v: 1, at: 1, cloud: SERVER, place: PLACE }));
  return { root, data };
}

test("a finished move to a server of the person's own opens the clean workspace and leaves the window on that server", async () => {
  const clean = cleanSide(), w = world({ clean, journal: null, marker: ownFreeze, state: null, url: `${SERVER}/`, deps: { ownAway: () => true } });
  await w.home.show();
  assert.equal(clean.enters, 1);
  assert.deepEqual(w.home.current(), { kind: "computer", clean: true, place: PLACE });
  assert.deepEqual(w.local, [false], "the server stays on screen");
  assert.deepEqual([w.went, w.fetched], [[], []]);
});

test("while that move is still under way, this computer's own copy stays the one that runs", async () => {
  const clean = cleanSide(), w = world({ clean, journal: null, marker: ownFreeze, state: null, deps: { ownAway: () => false } });
  await w.home.show();
  assert.equal(clean.enters, 0);
  assert.equal(w.home.current().clean, undefined);
});

test("a clean workspace that can't start shows this computer as before, never a sign-in screen", async () => {
  const clean = cleanSide({ fails: true }), w = world({ clean, journal: null, marker: ownFreeze, state: null, deps: { ownAway: () => true } });
  await w.home.show();
  assert.equal(clean.enters, 1);
  assert.deepEqual(w.local, [true]);
  assert.equal(w.home.view().screen, "opening");
});

test("an install already frozen switches on its next launch; the frozen copy stays byte for byte, and moving back runs it again", async () => {
  const { root, data } = frozenInstall();
  try {
    const before = tree(data);
    let running = data;
    const swaps = [];
    const clean = createCleanWorkspace({ dataDir: () => data, running: () => running, swap: async (dir) => { swaps.push(dir); running = dir; return { ok: true }; } });
    const askedWhileClean = [];
    // a frozen server answers its own freeze marker
    const server = async (route) => {
      if (clean.active()) askedWhileClean.push(route);
      const marker = fs.existsSync(path.join(data, "moved.json")) ? JSON.parse(fs.readFileSync(path.join(data, "moved.json"), "utf8")) : null;
      return Response.json(marker ? { frozen: true, cloud: marker.cloud, place: marker.place } : { frozen: false });
    };
    const frozen = async () => (await clean.realCopy(server)("/api/move/freeze")).json();
    let away = true;
    const w = world({ clean, journal: null, state: null, url: `${SERVER}/`, deps: { frozen, ownAway: () => away } });

    await w.home.show();
    const fresh = cleanWorkspaceDir(data);
    assert.deepEqual(swaps, [fresh]);
    assert.equal(clean.active(), true);
    assert.equal(w.home.current().place, PLACE);
    const config = JSON.parse(fs.readFileSync(path.join(fresh, "config.json"), "utf8"));
    assert.equal(config.language, "de");
    assert.ok(config.onboarding.completedAt, "never the new-user setup");
    assert.deepEqual(fs.readdirSync(fresh), ["config.json"], "a fresh workspace: its server adds the default Metal");
    assert.deepEqual(tree(data), before, "the frozen copy is untouched");

    // a second launch with the same marker keeps it, and seeds nothing over what the clean workspace made meanwhile
    fs.writeFileSync(path.join(fresh, "bots.json"), "[{\"id\":\"maus\"}]");
    running = data;
    await w.home.show();
    assert.equal(clean.active(), true);
    assert.equal(fs.readFileSync(path.join(fresh, "bots.json"), "utf8"), "[{\"id\":\"maus\"}]");
    assert.deepEqual(tree(data), before);

    // moving back: the freeze is lifted on the frozen copy's own server, never on the clean workspace
    await clean.holding(async () => {
      assert.equal(running, data);
      fs.rmSync(path.join(data, "moved.json"));
    });
    away = false;
    await w.home.changed();
    assert.equal(clean.active(), false);
    assert.equal(w.home.current().clean, undefined);
    const { "moved.json": _marker, ...restored } = before;
    assert.deepEqual(tree(data), restored, "exactly as it was before the move");
    assert.ok(fs.existsSync(path.join(fresh, "bots.json")), "nothing is deleted");
    assert.deepEqual(askedWhileClean, [], "the clean workspace's server is never asked for the frozen copy's word");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a launch after the move starts straight on the clean workspace, so the frozen copy never runs; any other freeze starts on the copy", () => {
  const { root, data } = frozenInstall();
  try {
    const before = tree(data);
    const clean = createCleanWorkspace({ dataDir: () => data, running: () => null, swap: async () => ({ ok: true }) });
    assert.equal(clean.startFolder(), cleanWorkspaceDir(data));
    assert.equal(JSON.parse(fs.readFileSync(path.join(cleanWorkspaceDir(data), "config.json"), "utf8")).language, "de");
    assert.deepEqual(tree(data), before);
    fs.writeFileSync(path.join(data, "moved.json"), JSON.stringify({ v: 1, at: 1, cloud: "https://dusk-t-1.fly.dev" }));
    assert.equal(clean.startFolder(), data, "My Cloud's freeze: the window decides, by who is signed in");
    fs.rmSync(path.join(data, "moved.json"));
    assert.equal(clean.startFolder(), data);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the move to a server of the person's own reads the frozen copy's own files and lifts its freeze there, never on the clean workspace", async () => {
  const { root, data } = frozenInstall();
  try {
    let running = cleanWorkspaceDir(data);
    const clean = createCleanWorkspace({ dataDir: () => data, running: () => running, swap: async (dir) => { running = dir; return { ok: true }; } });
    const asked = [];
    const own = installOwnHome({
      localRequest: async (route, init) => { asked.push([running, init?.method ?? "GET", route]); return Response.json({ frozen: running === data }); },
      clean,
      fetch: async () => new Response("", { status: 502 }),
      environments: () => [],
      handoff: async () => null,
      journal: { read: () => null, write: () => {} },
      choice: { read: () => null, write: () => {} },
      sendState: { read: () => null, write: () => {} },
      cloudJournal: () => null,
    });
    await own.kick();
    own.close();
    assert.deepEqual(asked, [], "nothing of the move reaches the clean workspace's server");
    assert.equal(clean.ownCopy(), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the dev app's own harness restarts on another folder, and a later source restart stays there", async () => {
  const forks = [];
  const child = (env) => {
    const handlers = {};
    const proc = { pid: forks.length + 1, env, once: (event, fn) => { handlers[event] = fn; }, on: () => {}, kill: () => { queueMicrotask(() => handlers.exit?.(0)); } };
    queueMicrotask(() => handlers.spawn?.());
    return proc;
  };
  const dev = createDevServerChild({ fork: (_entry, _args, options) => { const proc = child(options.env); forks.push(proc); return proc; },
    entry: "server/dev-server.ts", env: { DUSK_DATA_DIR: "/home/.duskbot" }, port: 1, grant: () => {}, taken: async () => false });
  assert.equal(await dev.start(), true);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(await dev.retarget({ DUSK_DATA_DIR: "/home/.duskbot-clean", DUSK_NO_TEST_BOTS: "1" }), true);
  assert.deepEqual(forks.map((proc) => proc.env.DUSK_DATA_DIR), ["/home/.duskbot", "/home/.duskbot-clean"]);
  dev.restart();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(forks.at(-1).env.DUSK_DATA_DIR, "/home/.duskbot-clean");
  assert.equal(dev.env().DUSK_NO_TEST_BOTS, "1");
  await dev.stop();
});
