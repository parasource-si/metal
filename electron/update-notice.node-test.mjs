import assert from "node:assert/strict";
import test from "node:test";

import { createUpdateNotice } from "./update-notice.mjs";

function setup(answer) {
  const notes = [], opened = [];
  let saved = null;
  const notice = createUpdateNotice({
    request: async () => new Response(JSON.stringify(answer), { status: 200 }),
    notify: note => notes.push(note),
    open: url => opened.push(url),
    memory: { read: () => saved, write: value => { saved = value; } },
  });
  return { notice, notes, opened };
}

test("a newer release is told once, and clicking opens the download page", async () => {
  const { notice, notes, opened } = setup({ current: "0.1.141", install: "desktop", available: true, latest: "0.1.150", releaseUrl: "https://github.com/parasource-si/metal/releases/latest" });
  assert.equal(await notice.check(), "0.1.150");
  assert.equal(await notice.check(), null);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Metal 0.1.150 is available");
  notes[0].click();
  assert.deepEqual(opened, ["https://github.com/parasource-si/metal/releases/latest"]);
});

test("nothing is told for an up-to-date app, another install kind or a link outside the Metal releases page", async () => {
  for (const answer of [
    { install: "desktop", available: false },
    { install: "docker", available: true, latest: "0.1.150", releaseUrl: "https://github.com/parasource-si/metal/releases/latest" },
    { install: "desktop", available: true, latest: "0.1.150", releaseUrl: "https://evil.example/download" },
  ]) {
    const { notice, notes } = setup(answer);
    assert.equal(await notice.check(), null);
    assert.equal(notes.length, 0);
  }
});

test("a failing server is logged, never thrown", async () => {
  const lines = [];
  const notice = createUpdateNotice({ request: async () => { throw new Error("down"); }, notify: () => assert.fail(), open: () => {}, memory: { read: () => null, write: () => {} }, log: line => lines.push(line) });
  assert.equal(await notice.check(), null);
  assert.match(lines[0], /down/);
});
