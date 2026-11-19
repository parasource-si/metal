import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bootShellHtml } from "./startup-mascot.mjs";
import { ARRIVE_AT, CREW, PACE, STEPS, crewArrivals, expectedLoadMs, progressAt, rememberLoad, startupDark, startupScreenHtml } from "./startup-screen.mjs";

test("the splash is the crew on their line, one empty spot per step, in the theme it was asked for", () => {
  const light = startupScreenHtml(), dark = startupScreenHtml({ dark: true });
  assert.deepEqual(CREW, ["goo", "kit", "pip", "mochi", "boxo"]);
  assert.equal(CREW.length, STEPS.length, "one mascot per startup step");
  assert.match(light, /<canvas class="scene" width="480" height="300" aria-hidden="true">/);
  assert.match(light, /<p class="brand">Metal<\/p>/);
  assert.match(light, /role="status">Opening Metal</);
  assert.match(light, /role="progressbar" aria-valuenow="0"[^>]*aria-valuetext="0 of 5 here" aria-label="Opening Metal"><b class="here">0 of 5<\/b> here/);
  assert.match(light, /"name":"kit","color":"#1b1b1f","eyeColor":"#ffffff"/, "kit in ink on light");
  assert.match(dark, /"name":"kit","color":"#f2f3f5","eyeColor":"#1b1b1f"/);
  assert.match(light, /"name":"goo","color":"#f75e51"/);
  assert.match(light, /--bg:#fafbfc;/); assert.match(light, /content="light"/);
  assert.match(dark, /--bg:#141418;/); assert.match(dark, /content="dark"/);
  assert.doesNotMatch(light, /prefers-color-scheme/);
  assert.match(light, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(light, /@media\(prefers-reduced-motion:reduce\)\{\.scene,\.txt\{transition:none\}\}/);
  assert.match(light, /font-src data:;/); assert.match(light, /url\("data:font\/woff2;base64,[^"]+"\)/);
  assert.match(light, /data-act="retry">Try again</);
  assert.match(light, /data-act="quit">Quit</);
  assert.match(light, /aria-label="Close" data-act="close"/);
  assert.match(light, /Everyone's here/);
  assert.doesNotMatch(light, /\u2014|border:\s*1px|transition:all/);
});

test("every mascot has the poses the screen draws: idle, arriving, cheering, stuck and worried", () => {
  const sprites = JSON.parse(readFileSync(new URL("./resources/startup-crew.json", import.meta.url), "utf8"));
  for (const name of CREW) {
    assert.match(sprites[name].body, /^(M\d+ \d+h\d+v1h-\d+z)+$/, name);
    for (const pose of ["idle", "working", "happy", "thinking"]) assert.match(sprites[name].eyes[pose], /^(M\d+ \d+h\d+v1h-\d+z)+$/, `${name} ${pose}`);
  }
});

test("the card is dark for a dark system, unless the last skin went against the system on purpose", () => {
  assert.equal(startupDark({ systemDark: true, saved: null }), true);
  assert.equal(startupDark({ systemDark: false, saved: { light: false } }), false);
  assert.equal(startupDark({ systemDark: false, saved: { light: false, systemDark: true } }), false, "followed the system then, follows it now");
  assert.equal(startupDark({ systemDark: true, saved: { light: true, systemDark: false } }), true);
  assert.equal(startupDark({ systemDark: true, saved: { light: true, systemDark: true } }), false, "a light pick on a dark system stays light");
  assert.equal(startupDark({ systemDark: false, saved: { light: false, systemDark: false } }), true);
});

test("the boot shell hides itself once the app renders into #root", () => {
  const html = bootShellHtml();
  assert.match(html, /#root:not\(:empty\)\+#boot-shell\{display:none\}/);
  assert.match(html, /<div id="boot-shell" aria-hidden="true"><svg/);
});

const arrivals = (expectedMs, loadedAt = null) => crewArrivals({ expectedMs, loadedAt, pace: PACE, arriveAt: ARRIVE_AT, count: CREW.length });

test("marks that land together then a long page load still bring the crew in one by one, spread over the wait", () => {
  // the real trace: credentials, server and window within a few hundred ms, then the page takes seconds to load
  const expectedMs = expectedLoadMs([6_800, 7_400, 7_100]);
  assert.equal(expectedMs, 7_100);
  const before = arrivals(expectedMs);
  assert.equal(before.at(-1), null, "the last mascot waits for the page to load");
  const landed = before.filter(at => at !== null);
  assert.equal(landed.length, 4);
  for (let k = 1; k < landed.length; k++) assert.ok(landed[k] - landed[k - 1] >= PACE.gapMs, `gap before mascot ${k}`);
  assert.ok(landed.at(-1) >= expectedMs * 0.6, "the fourth arrives late in the wait, not with its mark");
  const done = arrivals(expectedMs, 7_300);
  assert.deepEqual(done.slice(0, 4), landed);
  assert.equal(done.at(-1), 7_300);
  // percent eases out, stays below 100 even when the load runs long, and never goes back
  let last = 0;
  for (let t = 0; t <= 60_000; t += 250) { const p = progressAt(t, expectedMs); assert.ok(p >= last && p < 99, `${t}ms ${p}`); last = p; }
  assert.ok(progressAt(expectedMs / 2, expectedMs) > 50, "ease-out: more than half by halfway");
  assert.ok(progressAt(expectedMs, expectedMs) <= 90);
});

test("a load that beats the plan brings the rest in a short stagger, not all at once", () => {
  const out = arrivals(7_000, 2_000);
  assert.deepEqual(out.slice(0, 2), [0, 0.22 * 7_000]);
  assert.equal(out[2], 2_000);
  for (let k = 3; k < out.length; k++) assert.equal(out[k] - out[k - 1], PACE.burstGapMs);
});

test("the plan is the median of the last few launches, clamped, with a first-run guess", () => {
  assert.equal(expectedLoadMs(null), PACE.firstRunMs);
  assert.equal(expectedLoadMs([1_000]), PACE.minMs);
  assert.equal(expectedLoadMs([90_000, 60_000]), PACE.maxMs);
  assert.equal(expectedLoadMs([5_000, 40_000, 6_000]), 6_000, "one slow cold start does not drag the plan");
  assert.deepEqual(rememberLoad([1, 2, 3, 4, 5], 6_000.4), [2, 3, 4, 5, 6_000]);
  assert.deepEqual(rememberLoad([5_000], -1), [5_000]);
  assert.deepEqual(rememberLoad("junk", 4_000), [4_000]);
});

test("the card script parses and carries the plan it was given", () => {
  const html = startupScreenHtml({ expectedMs: 9_000 });
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /EXPECTED = 9000/);
  assert.match(script, /Waking your bots/);
  assert.doesNotMatch(script, /\u2014/);
});
