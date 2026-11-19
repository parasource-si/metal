// Shared harness of the flow smokes (scripts/smoke/flows/*.mjs): the isolated, invisible smoke app (../app.mjs) on a
// profile of its own, steps that pass, fail or skip with a screenshot and a note, a friction list (what a new person
// would trip on), and report.md / report.json. A flow signs in like a new person: the app's own account gate, with a
// code read from the account service's test mailbox (../account.mjs), to a fresh <flow>-<time>@qa.dusk.test account on
// preview. No real mail is ever sent.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchSmokeApp, until } from "../app.mjs";
import { PREVIEW_ORIGIN, TEST_MAIL_DOMAIN, testMailCode } from "../account.mjs";
import { APP_SIZE, typedWords, walkthrough } from "./recorder.mjs";
export { typedWords };

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const js = (value) => JSON.stringify(value);

export function flowArgs(name) {
  const args = process.argv.slice(2);
  const option = (key, fallback = null) => { const at = args.indexOf(key); return at === -1 ? fallback : args[at + 1] ?? fallback; };
  const root = resolve(option("--root", join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = resolve(option("--out", join(root, ".dusk-scratch", "flows", `${stamp}-${name}`)));
  // a new person each run unless told otherwise: a fresh profile and a fresh account
  const profile = resolve(option("--profile", join(homedir(), ".cache", "dusk-smoke", "flows", `${name}-${stamp}`)));
  const email = option("--email", `${name}-${stamp.slice(5, 16).replace(/[-T]/g, "")}@${TEST_MAIL_DOMAIN}`);
  return { args, option, flag: (key) => args.includes(key), root, stamp, out, profile, email };
}

/**
 * The run: `step()` records, `friction()` notes, `report()` writes. `env` reaches the app (DUSK_CLOUD_ORIGIN is preview by
 * default, so the dev app shows the account gate and account features the installed app has).
 */
export function createFlow({ name, title, root, out, profile, email, env = {} }) {
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const results = [], frictions = [], facts = {}, closers = [];
  let shots = 0;
  walkthrough.setEmail(email);
  const flow = {
    name, root, out, profile, email, facts, app: null,
    log: (line) => console.log(`[${name} ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line}`),
    async launch(extra = {}) {
      flow.app = await launchSmokeApp({ root, profile, log: flow.log, env: { DUSK_CLOUD_ORIGIN: PREVIEW_ORIGIN, ...(walkthrough.enabled ? { DUSK_SMOKE_THEME: "light" } : {}), ...env, ...extra } });
      await flow.viewport(1280, 820);
      walkthrough.attachApp(flow.app);
      return flow.app;
    },
    async shot(label) {
      if (!flow.app) return null;
      const file = join(out, `${String(++shots).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
      try { await flow.app.screenshot(file); return file; } catch { return null; }
    },
    /** what a new person would trip on: `kind` is confusing, extra-click, wording, slow or broken */
    friction(kind, where, note) { frictions.push({ kind, where, note }); walkthrough.warn(kind, where, note); flow.log(`friction (${kind}) ${where}: ${note}`); },
    async step(id, label, fn, { critical = false } = {}) {
      const started = Date.now();
      walkthrough.step(id, label);
      const entry = { id, title: label, status: "pass", note: "", ms: 0, shot: null };
      try { const result = await fn(entry); if (typeof result === "string") entry.note = result; }
      catch (error) { entry.status = error?.skip ? "skip" : "fail"; entry.note = String(error?.message ?? error).split("\n")[0].slice(0, 400); }
      if (flow.app && entry.status !== "skip" && flow.app.onScreen().length) { entry.status = "fail"; entry.note = `a smoke window was on a display; ${entry.note}`; }
      entry.ms = Date.now() - started;
      entry.shot ??= await flow.shot(id);
      results.push(entry);
      walkthrough.stepDone(id, entry.status, entry.note);
      flow.log(`${entry.status.toUpperCase().padEnd(4)} ${label} (${(entry.ms / 1000).toFixed(1)}s)${entry.note ? `: ${entry.note}` : ""}`);
      if (critical && entry.status === "fail") throw Object.assign(new Error(`stopped: ${label} failed`), { stopped: true });
      return entry;
    },
    skip: (why) => Object.assign(new Error(why), { skip: true }),
    // page helpers, in the app's main window
    evaluate: (expression) => flow.app.evaluate(expression),
    text: (scope = "body") => flow.app.evaluate(`(document.querySelector(${js(scope)})?.innerText ?? "")`),
    waitFor: (expression, what, timeout = 20_000) => until(() => flow.app.evaluate(expression), { timeout, what }),
    waitText: (pattern, what, { scope = "body", timeout = 20_000 } = {}) =>
      until(() => flow.app.evaluate(`(() => { const m = new RegExp(${js(pattern.source)}, ${js(pattern.flags)}).exec(document.querySelector(${js(scope)})?.innerText ?? ""); return m ? m[0] : false; })()`), { timeout, what }),
    /** clicks the visible control whose label is `text` (exact, or `contains`) */
    click: (text, { contains = false, scope = "body", timeout = 15_000 } = {}) => until(() => flow.app.evaluate(`(() => {
      const want = ${js(text.toLowerCase())}, scope = document.querySelector(${js(scope)}) ?? document;
      const match = (s) => { s = (s || "").trim().replace(/\\s+/g, " ").toLowerCase(); return ${contains ? "s.includes(want)" : "s === want"}; };
      const el = [...scope.querySelectorAll("button,a,[role=button],[role=menuitem],[role=tab],[role=option],[role=radio],[role=switch]")]
        .filter((e) => e.getClientRects().length && !e.disabled).find((e) => match(e.getAttribute("aria-label")) || match(e.innerText));
      if (!el) return false;
      el.click();
      return (el.getAttribute("aria-label") || el.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 60) || true;
    })()`), { timeout, what: `"${text}" to click` }).then((label) => { walkthrough.did(`clicks "${typeof label === "string" ? label : text}"`); return true; }),
    clickSelector: (selector, timeout = 15_000) => until(() => flow.app.evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el || !el.getClientRects().length) return false; el.click(); return (el.getAttribute("aria-label") || el.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 60) || true; })()`), { timeout, what: selector })
      .then((label) => { walkthrough.did(`clicks "${typeof label === "string" ? label.split(" ").slice(0, 8).join(" ") : selector}"`); return true; }),
    type: (text) => { walkthrough.did(typedWords(text)); return flow.app.send("Input.insertText", { text }); },
    async press(key, code = key, keyCode = 0) {
      walkthrough.did(`presses ${key}`);
      await flow.app.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
      await flow.app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    },
    escape: () => flow.press("Escape", "Escape", 27),
    // the walkthrough keeps the app's normal window for every shot
    viewport: (width, height = 820) => flow.app.send("Emulation.setDeviceMetricsOverride", { ...(walkthrough.enabled ? APP_SIZE : { width, height }), deviceScaleFactor: 1, mobile: false }),
    /** the system-browser links the app asked to open since `since` (recorded by the shim, never opened) */
    opened(since = 0) { return flow.app.events().filter((event) => event.kind === "open-external" && event.at >= since).map((event) => event.url); },
    /** the account gate, as a new person meets it: email, the emailed code, in */
    async signInAtGate() {
      await flow.waitText(/sign in to Metal/i, "the account gate", { timeout: 120_000 });
      await flow.evaluate(`document.querySelector("input[type=email], input")?.focus(); true`);
      await flow.type(email);
      const since = Date.now();
      await flow.click("send code");
      await flow.waitText(/8-digit code/i, "the code step");
      let code = null;
      for (let tries = 0; tries < 30 && !code; tries++) { await sleep(1_000); code = await testMailCode(email, since); }
      if (!code) throw new Error("no sign-in code in the test mailbox within 30 seconds");
      facts.codeSeconds = Math.round((Date.now() - since) / 1000);
      await flow.evaluate(`document.querySelector("input")?.focus(); true`);
      await flow.type(code);
      await flow.waitFor(`!/sign in to Metal/i.test(document.body.innerText)`, "the gate to let the person in", 30_000);
      return `${email}, code arrived in ${facts.codeSeconds}s`;
    },
    /** sends "reply with just ok" in the open chat; "reply:<text>", or "said:<text>" when the bot answered with a problem */
    async chatOk(timeout = 180_000) {
      const marker = `walk ${Date.now().toString(36)}`;
      await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the chat box", 60_000);
      await flow.evaluate(`document.querySelector('textarea[aria-label^="Message"]').focus(); true`);
      await flow.type(`Reply with just the word ok. (${marker})`);
      await flow.press("Enter", "Enter", 13);
      return flow.waitFor(`(() => {
        const rows = document.querySelector("[data-simple-rows]")?.innerText ?? document.body.innerText;
        const at = rows.lastIndexOf(${js(marker)});
        if (at < 0) return false;
        const after = rows.slice(at + ${marker.length + 1}).replace(/\\b\\d{1,2}:\\d{2}\\b/g, "").trim();
        if (/failed|went wrong|couldn.t|sign in|connect an ai/i.test(after)) return "said:" + after.slice(0, 160);
        return /\\bok\\b/i.test(after) ? "reply:" + after.slice(0, 80) : false;
      })()`, "the bot's reply", timeout);
    },
    accountState: () => flow.evaluate(`window.duskDesktop?.cloudAccount?.state()`),
    async openSettings(section) {
      await flow.escape().catch(() => {});
      await sleep(300);
      const open = await flow.evaluate(`Boolean([...document.querySelectorAll("[role=dialog]")].find((d) => d.getClientRects().length && /general/i.test(d.innerText)))`);
      if (!open) {
        await until(() => flow.evaluate(`(() => {
          const shown = [...document.querySelectorAll("button")].filter((b) => b.getClientRects().length);
          const apps = shown.find((b) => /^connect apps/i.test(b.innerText.trim()));
          const account = apps?.parentElement?.querySelector("button:not(:last-child)") ?? shown.find((b) => /^[a-z]$/i.test(b.innerText.trim()));
          if (!account) return false; account.click(); return true;
        })()`), { what: "the account button" });
        await flow.click("settings");
      }
      if (section) await flow.click(section, { scope: "[role=dialog]" });
      await sleep(800);
    },
    report() {
      const counts = { pass: 0, fail: 0, skip: 0 };
      for (const entry of results) counts[entry.status]++;
      const ok = counts.fail === 0 && results.length > 0;
      const seconds = Math.round((Date.now() - t0) / 1000);
      const json = { flow: name, ok, startedAt: new Date(t0).toISOString(), seconds, counts, facts, steps: results, frictions };
      writeFileSync(join(out, "report.json"), `${JSON.stringify(json, null, 2)}\n`);
      const lines = [
        `# ${title}: ${ok ? "pass" : "FAIL"}`, "",
        `${seconds}s, ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped. Account ${email}.`, "",
        "| step | result | time | note | screenshot |", "| --- | --- | --- | --- | --- |",
        ...results.map((entry) => `| ${entry.title} | ${entry.status} | ${(entry.ms / 1000).toFixed(1)}s | ${entry.note.replace(/\|/g, "/")} | ${entry.shot ? entry.shot.split("/").pop() : ""} |`),
        "", "## friction", "", ...(frictions.length ? frictions.map((item) => `- (${item.kind}) ${item.where}: ${item.note}`) : ["- none noted"]),
        "", "## facts", "", ...Object.entries(facts).map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
      ];
      writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
      return ok;
    },
    /** run when the flow closes, also after Ctrl-C or a kill (a paid machine is never left behind) */
    atClose(fn) { closers.push(fn); },
    async close({ keepProfile = false } = {}) {
      await walkthrough.finish().catch((error) => flow.log(`walkthrough: ${error?.message ?? error}`));
      walkthrough.detachApp();
      for (const fn of closers.splice(0)) await Promise.resolve().then(fn).catch((error) => flow.log(`cleanup failed: ${error?.message ?? error}`));
      await flow.app?.close().catch(() => {});
      flow.app = null;
      if (!keepProfile && profile.includes(`${join(".cache", "dusk-smoke", "flows")}`)) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (error) { flow.log(`could not remove the profile: ${error.message}`); } }
    },
  };
  return flow;
}

/** runs a flow's body, always writes its report and closes the app; the exit code is the report's */
export async function runFlow(flow, body, { keepProfile = false } = {}) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { flow.report(); void flow.close({ keepProfile: true }).finally(() => process.exit(130)); });
  try { await body(flow); }
  catch (error) { if (!error?.stopped) flow.log(`stopped: ${error?.stack ?? error}`); }
  finally {
    const ok = flow.report();
    await flow.close({ keepProfile });
    flow.log(`${ok ? "pass" : "FAIL"}: ${join(flow.out, "report.md")}`);
    process.exitCode = ok ? 0 : 1;
  }
}

/** the own-server line as the app shows it: the short one (`curl -fsSL https://dusk.bot/s/<code>[/<way>] | sh`) or the
 *  long one an older link service gets (`(for f in … curl -fsSL $f https://link.dusk.bot/i/<token> … | sh -s -- --way`) */
export const INSTALL_LINE = /curl -fsSL https:\/\/[a-z0-9.-]+\/s\/[a-z0-9]{7}(?:\/[a-z]+)? \| sh|\(for f in [^\n]*?curl -fsSL \$f https:\/\/link\.dusk\.bot\/i\/[a-z0-9-]+[^\n]*?\| sh(?: -s -- --[a-z]+)?/;
/** one argument for a remote shell, exactly as written: nothing in it ($, quotes, backticks) is read by that shell */
export const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
