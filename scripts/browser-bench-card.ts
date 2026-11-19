// Draws the before/after scorecard of two browser-bench runs as HTML and a PNG (headless Chrome's own --screenshot).
// Run: node --experimental-strip-types scripts/browser-bench-card.ts --before <before.json> --after <after.json> --out <dir>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GROUPS } from "../server/browser-bench/task.ts";
import type { Line, Play, Scorecard } from "../server/browser-bench/score.ts";

const args = process.argv.slice(2);
const opt = (name: string) => { const at = args.indexOf(`--${name}`); if (at < 0) throw new Error(`--${name} is required`); return args[at + 1]!; };
type Run = { label: string; model: string | null; runs: number; at: string; card: Scorecard; plays: Play[] };
const before = JSON.parse(readFileSync(opt("before"), "utf8")) as Run;
const after = JSON.parse(readFileSync(opt("after"), "utf8")) as Run;
const out = opt("out");
const title = args.includes("--title") ? opt("title") : "Metal browser: before and after";

const GROUP_NAMES: Record<string, string> = { composers: "Rich-text composers", lists: "Long, virtual and paged lists", widgets: "Custom widgets", frames: "Frames, payment fields, popups", overlays: "Overlays, walls, menus, modals", flows: "Sign-in, slow apps, re-renders", files: "Uploads, downloads, forms" };

const esc = (text: string) => text.replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]!);
const delta = (a: number, b: number, lowerIsBetter: boolean, unit = "") => {
  const change = b - a;
  if (Math.abs(change) < 0.05) return `<span class="flat">no change</span>`;
  const better = lowerIsBetter ? change < 0 : change > 0;
  const pct = a ? ` (${change > 0 ? "+" : ""}${Math.round((change / a) * 100)}%)` : "";
  return `<span class="${better ? "good" : "bad"}">${better ? "▲" : "▼"} ${change > 0 ? "+" : ""}${Math.round(change * 10) / 10}${unit}${pct}</span>`;
};

function tile(name: string, a: string, b: string, change: string): string {
  return `<div class="tile"><div class="tname">${name}</div><div class="tval"><span class="was">${a}</span> → <b>${b}</b></div><div class="tdelta">${change}</div></div>`;
}

/** Paired horizontal bars, before above after, one row per group. */
function bars(name: string, pick: (line: Line) => number, max: number, unit: string, lowerIsBetter: boolean): string {
  const rows = GROUPS.map((group) => {
    const a = pick(before.card.groups[group]), b = pick(after.card.groups[group]);
    const w = (v: number) => Math.max(0.5, (v / max) * 100);
    return `<div class="row"><div class="rname">${GROUP_NAMES[group]}</div><div class="pair">
      <div class="barline"><div class="bar before" style="width:${w(a)}%"></div><span class="v">${a}${unit}</span></div>
      <div class="barline"><div class="bar after" style="width:${w(b)}%"></div><span class="v"><b>${b}${unit}</b></span></div></div></div>`;
  }).join("");
  return `<section class="chart"><h3>${name} <span class="hint">${lowerIsBetter ? "lower is better" : "higher is better"}</span></h3>${rows}</section>`;
}

const ids = Object.keys(after.card.tasks);
const taskRows = ids.map((id) => {
  const a = before.card.tasks[id], b = after.card.tasks[id]!;
  const group = after.plays.find((play) => play.taskId === id)?.group ?? "";
  if (!a) return "";
  return `<tr><td>${esc(id)}</td><td class="muted">${group}</td><td>${a.passed}/${a.plays} → <b>${b.passed}/${b.plays}</b></td><td>${a.meanSteps} → <b>${b.meanSteps}</b></td><td>${a.meanSeconds} → <b>${b.meanSeconds}</b></td><td>${a.meanErrors} → <b>${b.meanErrors}</b></td></tr>`;
}).join("");

const failures = Object.entries(after.card.failures).flatMap(([id, list]) => list.map((why) => `<li><b>${esc(id)}</b>: ${esc(why.slice(0, 160))}</li>`)).join("") || "<li>none</li>";
const kinds = (card: Scorecard) => Object.entries(card.errorKinds).sort((x, y) => y[1] - x[1]).map(([kind, n]) => `${esc(kind)} ${n}`).join(", ") || "none";
const max = (pick: (line: Line) => number) => Math.max(...GROUPS.flatMap((group) => [pick(before.card.groups[group]), pick(after.card.groups[group])]));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
.viz-root{color-scheme:light;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#8a8984;--grid:#e8e7e3;--before:#b9b8b2;--after:#2a78d6;--good:#0a7f3f;--bad:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:14px/1.45 -apple-system,system-ui,sans-serif}
.viz-root{width:1240px;padding:36px 40px}h1{font-size:26px;margin:0 0 4px}h3{font-size:15px;margin:0 0 10px}.sub{color:var(--ink2);margin:0 0 22px}
.tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:26px}.tile{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 0 0 1px var(--grid)}
.tname{color:var(--ink2);font-size:12px}.tval{font-size:22px;margin:4px 0}.was{color:var(--muted)}.tdelta{font-size:12px}.good{color:var(--good)}.bad{color:var(--bad)}.flat{color:var(--muted)}
.legend{display:flex;gap:18px;color:var(--ink2);margin:0 0 12px}.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.charts{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-bottom:26px}.chart{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 0 0 1px var(--grid)}.hint{color:var(--muted);font-weight:400;font-size:11px}
.row{display:grid;grid-template-columns:118px 1fr;gap:8px;align-items:center;padding:5px 0;border-top:1px solid var(--grid)}.rname{font-size:11px;color:var(--ink2)}
.barline{display:flex;align-items:center;gap:6px;height:13px;margin:2px 0}.bar{height:9px;border-radius:0 4px 4px 0}.bar.before{background:var(--before)}.bar.after{background:var(--after)}.v{font-size:11px;color:var(--ink2);white-space:nowrap}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;box-shadow:0 0 0 1px var(--grid);font-size:12.5px}th,td{text-align:left;padding:6px 10px;border-top:1px solid var(--grid)}th{color:var(--ink2);font-weight:500;border-top:0}.muted{color:var(--muted)}
.cols{display:grid;grid-template-columns:1.7fr 1fr;gap:22px}.note{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 0 0 1px var(--grid);font-size:12.5px}.note ul{padding-left:18px;margin:6px 0}
</style></head><body><div class="viz-root">
<h1>${esc(title)}</h1>
<p class="sub">${ids.length} local pages of hard real-world UI, ${after.runs} runs each, played by Claude Code ${esc(after.model ?? "")} through Metal's real browser service and headless Chrome. Before: ${esc(before.label)} (${before.at.slice(0, 16).replace("T", " ")}). After: ${esc(after.label)} (${after.at.slice(0, 16).replace("T", " ")}).</p>
<div class="tiles">
${tile("Tasks done right", `${before.card.all.successPct}%`, `${after.card.all.successPct}%`, delta(before.card.all.successPct, after.card.all.successPct, false, " pts"))}
${tile("Tool calls per task", `${before.card.all.meanSteps}`, `${after.card.all.meanSteps}`, delta(before.card.all.meanSteps, after.card.all.meanSteps, true))}
${tile("Seconds per task", `${before.card.all.meanSeconds}`, `${after.card.all.meanSeconds}`, delta(before.card.all.meanSeconds, after.card.all.meanSeconds, true, " s"))}
${tile("Failed calls per task", `${before.card.all.meanErrors}`, `${after.card.all.meanErrors}`, delta(before.card.all.meanErrors, after.card.all.meanErrors, true))}
${tile("Page text read per task", `${before.card.all.meanKChars}k`, `${after.card.all.meanKChars}k`, delta(before.card.all.meanKChars, after.card.all.meanKChars, true, "k"))}
</div>
<div class="legend"><span><span class="sw" style="background:var(--before)"></span>before</span><span><span class="sw" style="background:var(--after)"></span>after</span></div>
<div class="charts">
${bars("Tasks done right", (line) => line.successPct, 100, "%", false)}
${bars("Tool calls per task", (line) => line.meanSteps, max((line) => line.meanSteps), "", true)}
${bars("Seconds per task", (line) => line.meanSeconds, max((line) => line.meanSeconds), " s", true)}
</div>
<div class="cols"><table><tr><th>Task</th><th>Group</th><th>Done right</th><th>Calls</th><th>Seconds</th><th>Failed calls</th></tr>${taskRows}</table>
<div class="note"><b>Failed calls by kind</b><br>before: ${kinds(before.card)}<br>after: ${kinds(after.card)}<br><br><b>Still failing after</b><ul>${failures}</ul></div></div>
</div></body></html>`;

mkdirSync(out, { recursive: true });
const page = join(out, "scorecard.html");
writeFileSync(page, html);
const chrome = process.env.DUSK_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`no Chrome at ${chrome}; set DUSK_CDP_CHROME`);
const profile = mkdtempSync(join(tmpdir(), "bench-card-"));
try {
  const shot = spawnSync(chrome, ["--headless=new", "--use-mock-keychain", "--password-store=basic", "--no-first-run", `--user-data-dir=${profile}`, "--hide-scrollbars",
    "--force-device-scale-factor=2", "--window-size=1240,1560", `--screenshot=${join(out, "scorecard.png")}`, `file://${page}`], { stdio: "inherit", timeout: 60_000 });
  if (shot.status !== 0) throw new Error(`Chrome exited ${shot.status}`);
} finally {
  rmSync(profile, { recursive: true, force: true });
}
console.log(join(out, "scorecard.png"));
