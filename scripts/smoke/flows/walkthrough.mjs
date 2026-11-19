// The visual walkthrough: every user flow of the desktop app and its browser pages, step by step, as a brand-new person
// meets them, on the current checkout. Each section is one of the flow smokes run with the recorder on (recorder.mjs):
// a screenshot at every visible state change of the app's window (its normal size, light) and of each browser page, the
// person's action and the time between steps under each, and a short video per surface. Then every test account it made
// is deleted (its clouds with it), every throwaway server is gone, and index.html (plus index.pdf) is written.
//
// Sink addresses only (*@qa.dusk.test), Dodo TEST mode only, throwaway InstaBox machines (deleted), the smoke app only
// through the never-visible shim, headless Chrome with a mock keychain. The owner's own app is checked untouched after.
//
//   node scripts/smoke/flows/walkthrough.mjs [--out DIR] [--only 1,3] [--parallel 3] [--report-only]
//
// ⚠ captions: what the recorder spots by itself (error words, off-brand names, sideways scrolling), every friction and
// failed step of the flows, and the reviewed notes in walkthrough-notes.json (matched to a screen by its words, so a
// note goes away once its screen changes).
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PREVIEW_ORIGIN, smokeAccount } from "../account.mjs";
import { compare, snapshot } from "../owner-guard.mjs";
import { launchBrowser } from "./browser.mjs";
import { leftoverVms, removeVm } from "./instabox-vm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const option = (key, fallback = null) => { const at = args.indexOf(key); return at === -1 ? fallback : args[at + 1] ?? fallback; };
const out = resolve(option("--out", join(root, ".dusk-scratch", "walkthrough")));
const only = option("--only") ? new Set(option("--only").split(",").map((id) => id.trim())) : null;
const parallel = Math.max(1, Number(option("--parallel", "3")) || 3);
const reportOnly = args.includes("--report-only");
const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(4, 12);
const log = (line) => console.log(`[walkthrough ${new Date().toISOString().slice(11, 19)}] ${line}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** the flows, in the order a person meets them; `account`: it makes a Metal account (deleted after) */
const SECTIONS = [
  { id: "1", slug: "first-run", title: "Fresh install, first launch", script: "onboarding.mjs", args: ["--path", "mac", "--tour"], account: false,
    blurb: "A new person opens the app: where the bots live, this Mac's sheet, connecting an AI (the cards and the full list), bringing notes from another AI, then the first chat with Metal, its working row and first reply (with no AI connected, the Connect your AI card)." },
  { id: "2", slug: "account", title: "Sign in and your account", script: "account-entry.mjs", args: [], account: true,
    blurb: "The account menu signed out, sign-in continuing in the browser (the website's sign-up, the approve page, the app signing itself in), billing, the signed-in account card and menu, and signing in again from the menu." },
  { id: "3", slug: "own-server", title: "Your own server (VPS)", script: "add-server.mjs", args: ["--signed-out"], account: true, vm: true,
    blurb: "Use your own server: the account in the browser, the short install line, the install's steps in the app while it runs on a throwaway Linux server, linked, the bots moved there, and a chat on the server." },
  { id: "4", slug: "server-to-cloud", title: "Getting dusk cloud from a server-linked app", script: "server-to-cloud.mjs", args: ["--move-first"], account: true, vm: true,
    blurb: "A server linked and the bots moved onto it, the app signed out: Get dusk cloud from the server's chat (the Server menu, the bot panel's Computer tab if that fails), continue in the browser, the website's plans, Dodo's TEST-mode checkout with the test card, you're all set, the app picking it up, the move (buying, copying, finishing, done), then the bots in the cloud's chat." },
  { id: "5", slug: "cloud-onboarding", title: "Getting dusk cloud from the first run", script: "onboarding.mjs", args: ["--path", "cloud", "--tour"], account: true,
    blurb: "The welcome's dusk cloud: straight to the browser (sign-up, approve, plans, TEST-mode checkout), the app noticing the payment, connecting an AI while the cloud is made, the cloud's chat and a reply (with no AI connected, the Connect your AI card)." },
  { id: "6", slug: "connect-later", title: "Connect apps and an AI later", script: "connect-later.mjs", args: [], account: false,
    blurb: "After the first run: the sidebar's connect apps sheet and Gmail on it (stopping before Google's own sign-in), then Settings > Models with one AI opened." },
];
const sectionDir = (section) => join(out, "sections", `${section.id}-${section.slug}`);
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const chosen = SECTIONS.filter((section) => !only || only.has(section.id));

/** one flow, recorded: its own folder, log and sink address */
function runSection(section) {
  const dir = sectionDir(section);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const email = `wt${section.id}-${stamp}@qa.dusk.test`;
  const logFile = createWriteStream(join(dir, "run.log"));
  const started = Date.now();
  log(`${section.id} ${section.title}: started (${email})`);
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(here, section.script), ...section.args, "--out", join(dir, "flow"), "--email", email], {
      cwd: root, env: { ...process.env, DUSK_WALKTHROUGH_DIR: dir, DUSK_WALKTHROUGH_SECTION: section.id }, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      logFile.write(chunk);
      for (const line of String(chunk).split("\n").filter(Boolean)) if (/PASS|FAIL|SKIP|friction|stopped|deleted|pass:|FAIL:/.test(line)) console.log(`  ${section.id}| ${line.slice(0, 220)}`);
    });
    // a flow that hangs past an hour is stopped; its own handlers delete its machine
    const limit = setTimeout(() => { log(`${section.id}: over an hour, stopping it`); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 60_000).unref(); }, 60 * 60_000);
    child.once("exit", (code) => {
      clearTimeout(limit); logFile.end();
      log(`${section.id} ${section.title}: ${code === 0 ? "pass" : `exit ${code}`} in ${Math.round((Date.now() - started) / 60_000)} min`);
      done({ section, code, email });
    });
  });
}

async function runAll() {
  // the long ones first, so the short ones fill in beside them
  const order = ["4", "3", "5", "2", "1", "6"];
  const queue = [...chosen].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const results = [];
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) results.push(await runSection(queue.shift()));
  }));
  return results;
}

/** the test account deleted through the app's own account route (its billing cancelled and its clouds ended with it) */
async function deleteTestAccount(email, dir) {
  const profile = join(dir, "cleanup");
  mkdirSync(profile, { recursive: true });
  let signed = null, lastError = null;
  // a session the flow kept (the cloud onboarding signs in to cancel the trial), else a fresh code from the sink
  for (const given of [join(dir, "flow", "account"), profile]) {
    if (!existsSync(join(given, "account-session.json")) && given !== profile) continue;
    for (let tries = 0; tries < 3 && !signed; tries++) {
      try { signed = { ...(await smokeAccount({ root, profile: given, email })), profile: given }; }
      catch (error) { lastError = error; if (given !== profile) break; await sleep(65_000); }
    }
    if (signed) break;
  }
  if (!signed) return { outcome: `could not sign in to delete it: ${lastError?.message ?? "unknown"}`, clouds: [] };
  const state = (await signed.client.refresh?.().catch(() => null)) ?? signed.client.state();
  const clouds = (state?.clouds ?? []).map((cloud) => ({ id: cloud.id, name: cloud.name, status: cloud.status, origin: cloud.origin ?? null }));
  const token = readJson(join(signed.profile, "account-session.json"))?.value?.token;
  if (!token) return { outcome: "no session token to delete with", clouds };
  const remove = () => fetch(`${PREVIEW_ORIGIN}/v1/app/delete-account`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ email }) });
  let answer = await remove();
  if (answer.status === 409) { await signed.client.cancelPlan(null).catch(() => {}); await sleep(3000); answer = await remove(); }
  const text = answer.ok ? "" : (await answer.text()).slice(0, 160);
  return { outcome: answer.ok ? "deleted" : `delete answered ${answer.status} ${text}`, clouds };
}

async function cleanup(sections) {
  const items = [];
  for (const section of sections) {
    const dir = sectionDir(section);
    const manifest = readJson(join(dir, "manifest.json"));
    const report = readJson(join(dir, "flow", "report.json"));
    if (report?.facts?.vm) items.push({ kind: "server (InstaBox)", id: report.facts.vm, section: section.id, outcome: "made and deleted by the flow" });
    if (!section.account || !manifest?.email) continue;
    log(`cleanup: ${manifest.email}`);
    const result = await deleteTestAccount(manifest.email, dir).catch((error) => ({ outcome: `failed: ${error.message}`, clouds: [] }));
    items.push({ kind: "test account", id: manifest.email, section: section.id, outcome: result.outcome });
    for (const cloud of result.clouds) items.push({ kind: "dusk cloud (preview, test mode)", id: `${cloud.name ?? "cloud"} ${cloud.id}`, section: section.id, origin: cloud.origin, outcome: result.outcome === "deleted" ? `ended with the account (was ${cloud.status})` : `still there (${cloud.status})` });
  }
  // a machine a killed flow left behind
  let left = [];
  try { left = await leftoverVms(); } catch (error) { items.push({ kind: "server (InstaBox)", id: "sweep", outcome: `could not list machines: ${error.message}` }); }
  for (const vm of left) {
    const outcome = await removeVm(vm.id).then(() => "left over; deleted now", (error) => `left over; delete failed: ${error.message}`);
    items.push({ kind: "server (InstaBox)", id: `${vm.name ?? ""} ${vm.id}`.trim(), outcome });
  }
  const after = await leftoverVms().catch(() => null);
  items.push({ kind: "check", id: "InstaBox machines from the flows", outcome: after === null ? "could not list" : after.length ? `${after.length} still there` : "none left" });
  // the clouds stop answering once the account's deletion ended them (checked for a few minutes)
  for (const item of items.filter((entry) => entry.origin)) {
    let gone = false;
    for (let tries = 0; tries < 12 && !gone; tries++) {
      const status = await fetch(item.origin, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => 0);
      gone = status === 0 || status === 404 || status === 410 || status >= 500;
      if (!gone) await sleep(15_000);
    }
    item.outcome += gone ? "; no longer answers" : "; still answers after 3 minutes (ended, its machine is removed by the cloud service)";
  }
  // the flows' own app profiles
  const kept = profilesNow().filter((name) => !profilesBefore.has(name));
  items.push({ kind: "check", id: "smoke app profiles", outcome: kept.length ? `kept: ${kept.join(", ")}` : "removed by the flows" });
  return items;
}

// --- the page ---------------------------------------------------------------------------------------------------------
/** one-time codes and tokens never reach the page */
const scrub = (text) => String(text ?? "").replace(/\b(code|token|key|session)=[^&\s)]+/gi, "$1=…");
const esc = (text) => scrub(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const secs = (ms) => (ms < 1000 ? `${ms} ms` : ms < 90_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const clock = (ms) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

function applyNotes(sectionId, captures) {
  const notes = readJson(join(here, "walkthrough-notes.json")) ?? [];
  const used = [];
  for (const note of notes.filter((entry) => entry.section === sectionId)) {
    const pattern = new RegExp(note.match, "i");
    const hits = captures.filter((capture) => (!note.surface || capture.surface === note.surface) && pattern.test(`${capture.headline}\n${capture.url}\n${capture.text}`));
    for (const capture of note.every ? hits : hits.slice(0, 1)) capture.notes.push(note.note);
    if (hits.length) used.push(note);
  }
  return used;
}

function buildPage(cleanupItems, ownerProblems) {
  const commit = spawnSync("git", ["-C", root, "log", "-1", "--format=%h %s"], { encoding: "utf8" }).stdout.trim();
  const sections = SECTIONS.map((section) => {
    const dir = sectionDir(section);
    const manifest = readJson(join(dir, "manifest.json"));
    const report = readJson(join(dir, "flow", "report.json"));
    if (!manifest) return { section, missing: true };
    const captures = manifest.captures ?? [];
    applyNotes(section.id, captures);
    return { section, dir, manifest, report, captures };
  });
  const issues = [];
  for (const entry of sections.filter((item) => !item.missing)) {
    const { section, captures, manifest } = entry;
    const seen = new Set();
    for (const capture of captures) {
      for (const note of capture.notes) issues.push({ section, capture, text: note, kind: "review" });
      for (const warning of capture.warnings) { const key = warning.replace(/"[^"]*"/, ""); if (seen.has(key + warning)) continue; seen.add(key + warning); issues.push({ section, capture, text: warning, kind: "spotted" }); }
    }
    for (const warning of manifest.warnings ?? []) issues.push({ section, capture: captures.find((capture) => capture.n === warning.near) ?? null, text: `${warning.where}: ${warning.note}`, kind: warning.kind });
  }
  const anchor = (section, capture) => `s${section.id}-${capture.n}`;
  const issueLine = (issue) => `<li><b>${esc(issue.section.id)}.</b> ${issue.capture ? `<a href="#${anchor(issue.section, issue.capture)}">${esc(issue.capture.surface)} #${issue.capture.n}</a> ` : ""}<span class="kind">${esc(issue.kind)}</span> ${esc(issue.text)}</li>`;

  const body = sections.map((entry) => {
    const { section } = entry;
    if (entry.missing) return `<section id="s${section.id}"><h2>${section.id}. ${esc(section.title)}</h2><p class="blurb">${esc(section.blurb)}</p><p class="warn">⚠ not recorded in this run.</p></section>`;
    const { manifest, report, captures, dir } = entry;
    const rel = (file) => relative(out, join(dir, file));
    const videos = (manifest.videos ?? []).map((video) => `<figure class="video"><video controls preload="metadata" src="${esc(rel(video.file))}"></video><figcaption>${video.surface === "app" ? "the app's window" : "the browser"} (${video.frames} frames, waits shortened)</figcaption><a class="print-only" href="${esc(rel(video.file))}">${esc(rel(video.file))}</a></figure>`).join("");
    const steps = (manifest.steps ?? []).map((step) => {
      const shots = captures.filter((capture) => capture.step === step.id && capture.stepTitle === step.title);
      const status = step.status === "pass" ? "ok" : step.status === "skip" ? "skipped" : step.status === "running" ? "did not finish" : "⚠ failed";
      return `<div class="step"><h3><span class="st ${esc(step.status)}">${esc(status)}</span> ${esc(step.title)}${step.endedMs != null ? ` <span class="dim">(${secs(step.endedMs - step.startedMs)})</span>` : ""}</h3>
        ${step.note ? `<p class="note">${esc(step.note)}</p>` : ""}
        ${shots.map((capture) => {
          const warn = [...capture.notes, ...capture.warnings];
          return `<figure id="${anchor(section, capture)}" class="shot ${capture.kind}">
            <img loading="lazy" src="${esc(rel(capture.file))}" alt="${esc(capture.headline)}">
            <figcaption><span class="tag ${capture.kind}">${capture.kind === "app" ? "app" : "browser"}</span> <span class="num">#${capture.n}</span>
              <b>${esc(capture.action ? capture.action.replace(/^./, (c) => c.toUpperCase()) : "By itself")}</b>, and sees: ${esc(capture.headline || "(no heading)")}
              <span class="time">+${secs(capture.sincePrevMs)} · at ${clock(capture.atMs)}</span>
              ${capture.kind === "browser" ? `<span class="url">${esc(capture.url)}</span>` : ""}
              ${warn.map((line) => `<span class="warn">⚠ ${esc(line)}</span>`).join("")}
            </figcaption></figure>`;
        }).join("")}</div>`;
    }).join("");
    const counts = report?.counts ?? {};
    return `<section id="s${section.id}"><h2>${section.id}. ${esc(section.title)}</h2>
      <p class="blurb">${esc(section.blurb)}</p>
      <p class="meta">${captures.length} screens in ${secs((manifest.seconds ?? 0) * 1000)} · steps: ${counts.pass ?? 0} ok, ${counts.fail ?? 0} failed, ${counts.skip ?? 0} skipped · account ${esc(manifest.email ?? "none")}</p>
      <div class="videos">${videos || "<p class=\"dim\">no video</p>"}</div>${steps}</section>`;
  }).join("\n");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Metal walkthrough</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { color-scheme: light; --ink: #1d1d1f; --dim: #6e6e73; --line: #e5e5ea; --warn: #b25000; --bg: #fafafa; }
* { box-sizing: border-box; } body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 80px; }
h1 { font-size: 28px; margin: 0 0 4px; } h2 { font-size: 22px; margin: 56px 0 4px; padding-top: 16px; border-top: 1px solid var(--line); }
h3 { font-size: 15px; margin: 28px 0 8px; } .dim, .meta { color: var(--dim); } .blurb { max-width: 820px; }
nav ol { padding-left: 20px; } .toc a { color: inherit; }
.issues { background: #fff; border-radius: 12px; padding: 12px 20px; } .issues li { margin: 4px 0; } .kind { color: var(--dim); font-size: 12px; text-transform: lowercase; }
.videos { display: flex; gap: 16px; flex-wrap: wrap; margin: 12px 0; } .video { margin: 0; } .video video { width: 520px; max-width: 100%; border-radius: 8px; background: #000; }
.video figcaption { color: var(--dim); font-size: 12px; } .print-only { display: none; }
.st { font-size: 12px; font-weight: 500; padding: 1px 8px; border-radius: 99px; background: #e8f5e9; color: #1b5e20; } .st.fail, .st.running { background: #fff3e0; color: var(--warn); } .st.skip { background: #eee; color: var(--dim); }
.note { color: var(--dim); font-size: 12px; margin: -4px 0 8px; }
.shot { margin: 0 0 22px; background: #fff; border-radius: 12px; padding: 10px; box-shadow: 0 1px 2px rgba(0,0,0,.06); break-inside: avoid; }
.shot img { display: block; width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--line); } .shot.app img { max-width: 1040px; }
.shot figcaption { padding: 8px 4px 0; } .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #eef; color: #335; } .tag.browser { background: #efe; color: #353; }
.num { color: var(--dim); font-size: 12px; } .time { color: var(--dim); font-size: 12px; margin-left: 6px; white-space: nowrap; }
.url { display: block; color: var(--dim); font-size: 12px; word-break: break-all; } .warn { display: block; color: var(--warn); margin-top: 2px; }
table { border-collapse: collapse; background: #fff; } td, th { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
@media print { body { background: #fff; } main { max-width: none; padding: 0; } .video video { display: none; } .print-only { display: inline; font-size: 11px; } .shot { box-shadow: none; border: 1px solid var(--line); padding: 6px; margin-bottom: 10px; } .shot img { width: auto; max-width: 100%; max-height: 4.3in; margin: 0 auto; } h2 { break-before: page; } }
</style></head><body><main>
<h1>Metal, every flow as a new person sees it</h1>
<p class="dim">Generated ${esc(new Date().toISOString().replace("T", " ").slice(0, 16))} UTC from <code>${esc(commit)}</code> by <code>node scripts/smoke/flows/walkthrough.mjs</code>. App window at its normal size (1040x760, light), browser pages at 1280x860. Accounts are *@qa.dusk.test sink addresses on preview; payments are Dodo TEST mode with the test card.</p>
<nav class="toc"><ol>${SECTIONS.map((section) => { const entry = sections.find((item) => item.section === section); return `<li><a href="#s${section.id}">${esc(section.title)}</a> <span class="dim">${entry.missing ? "not recorded" : `${entry.captures.length} screens`}</span></li>`; }).join("")}</ol></nav>
<h2 id="issues">⚠ What looks broken, confusing or off-brand (${issues.length})</h2>
<div class="issues"><ul>${issues.map(issueLine).join("") || "<li>none</li>"}</ul></div>
<h2 id="cleanup">Cleanup</h2>
<table><tr><th>what</th><th>which</th><th>section</th><th>outcome</th></tr>${cleanupItems.map((item) => `<tr><td>${esc(item.kind)}</td><td>${esc(item.id)}</td><td>${esc(item.section ?? "")}</td><td>${esc(item.outcome)}</td></tr>`).join("")}
<tr><td>check</td><td>the owner's own app and config</td><td></td><td>${ownerProblems === null ? "not checked (report only)" : ownerProblems.length ? esc(`⚠ ${ownerProblems.join("; ")}`) : "untouched"}</td></tr></table>
${body}
</main></body></html>`;
  writeFileSync(join(out, "index.html"), html);
  writeFileSync(join(out, "issues.json"), `${JSON.stringify(issues.map((issue) => ({ section: issue.section.id, shot: issue.capture?.n ?? null, surface: issue.capture?.surface ?? null, file: issue.capture ? relative(out, join(sectionDir(issue.section), issue.capture.file)) : null, kind: issue.kind, text: scrub(issue.text) })), null, 2)}\n`);
  return { issues, sections };
}

async function printPdf() {
  const browser = await launchBrowser({ width: 1240, height: 1754 });
  try {
    await browser.goto(pathToFileURL(join(out, "index.html")).href);
    // every lazy image in before printing
    await browser.evaluate(`Promise.all([...document.images].map((img) => { img.loading = "eager"; return img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; }); })).then(() => true)`);
    const pdf = await browser.send("Page.printToPDF", { printBackground: true, paperWidth: 8.27, paperHeight: 11.69, marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4, transferMode: "ReturnAsBase64" });
    writeFileSync(join(out, "index.pdf"), Buffer.from(pdf.data, "base64"));
    return join(out, "index.pdf");
  } finally { await browser.close(); }
}

const PROFILES = join(process.env.HOME ?? "", ".cache", "dusk-smoke", "flows");
const profilesNow = () => (existsSync(PROFILES) ? readdirSync(PROFILES) : []);
const profilesBefore = new Set(profilesNow());

mkdirSync(out, { recursive: true });
let cleanupItems = readJson(join(out, "cleanup.json")) ?? [], ownerProblems = null;
if (!reportOnly) {
  const before = snapshot();
  log(`out: ${out}; sections ${chosen.map((section) => section.id).join(", ")}; ${parallel} at a time`);
  const results = await runAll();
  log("cleanup: test accounts, clouds, servers");
  const fresh = await cleanup(chosen);
  cleanupItems = [...cleanupItems.filter((item) => !chosen.some((section) => section.id === item.section) && item.kind !== "check"), ...fresh];
  writeFileSync(join(out, "cleanup.json"), `${JSON.stringify(cleanupItems, null, 2)}\n`);
  ownerProblems = compare(before, [...results.map((result) => result.email), "dusk-smoke-srv", "dusk-smoke-s2c"]);
}
const { issues } = buildPage(cleanupItems, ownerProblems);
log(`page: ${join(out, "index.html")} (${issues.length} ⚠)`);
const pdf = await printPdf().catch((error) => { log(`pdf failed: ${error.message}`); return null; });
if (pdf) log(`pdf: ${pdf}`);
for (const item of cleanupItems) log(`cleanup: ${item.kind} ${item.id}: ${item.outcome}`);
if (ownerProblems?.length) log(`⚠ owner's setup: ${ownerProblems.join("; ")}`);
process.exit(0);
