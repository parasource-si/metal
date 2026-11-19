// Drives the real <App/> through `control-dusk ui` and reads outcomes from the
// accessibility tree. Needs the pinned agent-browser binary: runs when one
// resolves (tools directory, DUSK_AGENT_BROWSER_PATH or PATH) or DUSK_UI_E2E=1
// asks for the verified download; otherwise skipped.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlDusk } from "../control-dusk.ts";
import { UI_TOOLS_DIR } from "./control-dusk-ui.ts";
import { clickByName, openSettings } from "./grok-nav.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "scripts", "control-dusk.ts");
const forced = process.env.DUSK_UI_E2E === "1";
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = forced || Boolean(binary);
if (!enabled) {
  console.log(`skipping control-dusk ui e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, DUSK_AGENT_BROWSER_PATH and PATH); set DUSK_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;
// A forced run may still have Chrome for Testing to download even when
// agent-browser is cached.
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;

// Synthetic provider outcomes exercise the UI, not the commands themselves.
const TOOL_CALLS = JSON.stringify([
  { name: "Bash", input: { command: "pnpm control:dusk doctor" }, ok: true },
  { name: "Bash", input: { command: "pnpm control:dusk ui click --name Missing" }, ok: false },
  { name: "Bash", input: { command: "pnpm control:dusk ui flag --set features.showToolCalls=true --dry-run" }, ok: true },
]);
const REPLY = "hello from fake claude"; // the fake engine's default reply text
const COMPOSER = `document.querySelector('textarea[aria-label="Message Pepper"]')`;
// DUSK_UI_EVIDENCE_DIR keeps the screenshot (CI uploads it); otherwise it is temporary.
const evidenceDir = process.env.DUSK_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.DUSK_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "dusk-ui-evidence-"));
const ownsEvidenceDir = !process.env.DUSK_UI_EVIDENCE_DIR;

interface Launched {
  child: ReturnType<typeof spawn>;
  info: { ui: string; url: string; previewUrl: string; botId: string; dataDir: string; logPath: string };
  stderr: () => string;
}

function launch(args: string[]): Promise<Launched> {
  return new Promise((done, fail) => {
    // Own process group: a timeout must also take down whatever it is running.
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "ui", "launch", ...args], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); return; } catch { /* group already gone */ }
      }
      child.kill(signal);
    };
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup("SIGINT");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
      fail(new Error(`ui launch printed no handle within ${LAUNCH_TIMEOUT_MS}ms\nstderr:\n${stderr}`));
    }, LAUNCH_TIMEOUT_MS);
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
      if (settled) return;
      // A tool printing on stdout before the handle still parses from the
      // first line that starts the object.
      const start = stdout.startsWith("{") ? 0 : stdout.indexOf("\n{") + 1;
      if (start <= 0 && !stdout.startsWith("{")) return;
      try {
        const info = JSON.parse(stdout.slice(start));
        settled = true;
        clearTimeout(timer);
        done({ child, info, stderr: () => stderr });
      } catch {
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(new Error(`ui launch exited ${code} before printing a handle\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

const ui = (verb: string, handle: string, ...args: string[]) =>
  runControlDusk(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;

/** Interactive refs by accessible name, from a snapshot's `refs` table. */
const refsNamed = (snapshot: Record<string, any>, name: string, role?: string) =>
  Object.entries(snapshot.refs as Record<string, { name: string; role: string }>)
    .filter(([, element]) => element.name === name && (!role || element.role === role))
    .map(([id]) => `@${id}`);

describe("control-dusk ui drives the real renderer", () => {
  let launched: Launched | undefined;

  afterAll(async () => {
    if (launched && launched.child.exitCode === null && launched.child.signalCode === null) {
      await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    }
    if (ownsEvidenceDir) await removeTempDir(evidenceDir);
  });

  run("shows the matched text inside a searched message", async () => {
    launched = await launch([]);
    const { info } = launched;
    await ui("type", info.ui, "--name", "Message Pepper", "--text", "Find the striped zebra");
    await ui("press", info.ui, "--keys", "Enter");
    await ui("wait-settle", info.ui, "--timeout", "60");
    // The simple chat header is the pill alone; find in a conversation is its shortcut.
    await ui("press", info.ui, "--keys", "Control+f");
    await ui("type", info.ui, "--name", "Find in this conversation", "--text", "zebra");
    const highlighted = async () => (await ui("eval", info.ui, "--js", "[...CSS.highlights.get('search-result-text') ?? []][0]?.toString() ?? null")).result;
    await expect.poll(async () => (await ui("snapshot", info.ui)).snapshot, { timeout: 10_000 }).toContain("1 of 1");
    expect((await ui("snapshot", info.ui)).snapshot).not.toContain("Show less");
    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "search-result.png"));
    await expect.poll(async () => (await ui("eval", info.ui, "--js", "(() => { const row = [...document.querySelectorAll('[data-mid]')].find(el => el.textContent.includes('Find the striped zebra')); const bubble = row?.querySelector('[data-chat-bubble]'); return !!bubble && row.querySelector('.ring-2') === bubble && bubble.getBoundingClientRect().width < row.lastElementChild.getBoundingClientRect().width; })()")).result, { timeout: 10_000 }).toBe(true);
    await expect.poll(highlighted, { timeout: 10_000 }).toBe("zebra");
    await ui("type", info.ui, "--name", "Message Pepper", "--text", `${"hay ".repeat(160)}saffron`);
    await ui("press", info.ui, "--keys", "Enter");
    await ui("wait-settle", info.ui, "--timeout", "60");
    await ui("click", info.ui, "--name", "Find in this conversation");
    await ui("eval", info.ui, "--js", "document.querySelector('input[aria-label=\"Find in this conversation\"]').select(); true");
    await ui("press", info.ui, "--keys", "Backspace");
    await ui("type", info.ui, "--name", "Find in this conversation", "--text", "saffron");
    await expect.poll(highlighted, { timeout: 10_000 }).toBe("saffron");
    expect((await ui("eval", info.ui, "--js", "[...document.querySelectorAll('.chat-text')].find(el => el.textContent.includes('saffron'))?.classList.contains('max-h-40')")).result).toBe(false);
    await expect.poll(async () => (await ui("eval", info.ui, "--js", "(() => { const range = [...CSS.highlights.get('search-result-text')][0]; const bounds = range.startContainer.parentElement.closest('.overflow-y-auto').getBoundingClientRect(); const match = range.getBoundingClientRect(); return match.top >= bounds.top && match.bottom <= bounds.bottom; })()")).result).toBe(true);
    await ui("click", info.ui, "--name", "Find in this conversation");
    await ui("eval", info.ui, "--js", "document.querySelector('input[aria-label=\"Find in this conversation\"]').select(); true");
    await ui("press", info.ui, "--keys", "Backspace");
    await ui("type", info.ui, "--name", "Find in this conversation", "--text", "fake claude");
    await expect.poll(highlighted, { timeout: 10_000 }).toBe("fake claude");
    await ui("press", info.ui, "--keys", "Escape");
    // The sidebar's Search opens the search palette, whose message results land on the match.
    const sidebarSearch = refsNamed(await ui("snapshot", info.ui), "Search", "button");
    expect(sidebarSearch).toHaveLength(1);
    await ui("click", info.ui, "--ref", sidebarSearch[0]!);
    let palette: string[] = [];
    await expect.poll(async () => (palette = refsNamed(await ui("snapshot", info.ui), "Search", "combobox")).length, { timeout: 10_000 }).toBe(1);
    await ui("type", info.ui, "--ref", palette[0]!, "--text", "zebra");
    let hit: string | undefined;
    await expect.poll(async () => {
      const refs = (await ui("snapshot", info.ui)).refs as Record<string, { name: string; role: string }>;
      hit = Object.entries(refs).find(([, element]) => element.role === "option" && element.name.includes("Find the striped zebra") && element.name.endsWith("Message"))?.[0];
      return Boolean(hit);
    }, { timeout: 10_000 }).toBe(true);
    expect(await ui("eval", info.ui, "--js", "[...document.querySelectorAll('[role=option] .font-semibold')].some(match => match.textContent === 'zebra')")).toMatchObject({ result: true });
    await ui("click", info.ui, "--ref", `@${hit}`);
    await expect.poll(highlighted, { timeout: 10_000 }).toBe("zebra");
    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
  }, LAUNCH_TIMEOUT_MS + 90_000);

  run("saves a key on Enter, checks it once saved, shows it masked, and keeps a refused or failed draft", async () => {
    launched = await launch([]);
    const { info } = launched;
    await fixtureApi(info.url)("PUT", "/api/config", {
      openaiCompat: { key: "fixture-saved-key", url: "http://127.0.0.1:1/v1" },
    });
    const evaluate = async (js: string) => (await ui("eval", info.ui, "--js", js)).result;
    const row = `document.querySelector('[data-api-key-row="openaiCompat"]')`;
    // the row's Change opens a compact dialog with the field, drawn over Settings from the body
    const dialog = `document.querySelector('[data-key-dialog="openaiCompat"]')`;
    const input = `${dialog}?.querySelector('[data-key-input]')`;
    const verdict = () => evaluate(`(${dialog} ?? ${row}).querySelector('[role="status"]')?.textContent`);
    const rowText = () => evaluate(`${row}.textContent + (${dialog}?.textContent ?? '')`);
    const masked = () => evaluate(`${row}.querySelector('[data-key-masked]')?.textContent ?? null`);
    const replace = async () => {
      await evaluate(`${row}.querySelector('[data-key-replace]').click(); true`);
      await expect.poll(() => evaluate(`Boolean(${input})`), { timeout: 10_000 }).toBe(true);
    };
    const focusField = () => evaluate(`${input}.focus(); ${input}.select(); true`);
    const type = async (text: string) => {
      await focusField();
      await ui("press", info.ui, "--keys", "Backspace");
      if (!text) return;
      const [field] = refsNamed(await ui("snapshot", info.ui), "OpenAI-compatible API key", "textbox");
      expect(field).toBeDefined();
      await ui("type", info.ui, "--ref", field!, "--text", text);
    };
    const enter = () => ui("press", info.ui, "--keys", "Enter");
    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.keyTests = [];
      window.keySaves = 0;
      window.rejectKeySave = false;
      window.fetch = (url, init = {}) => {
        if (String(url) === '/api/keys/test') {
          window.keyTests.push(JSON.parse(init.body));
          return Promise.resolve(Response.json({ ok: true, check: 'models', models: ['fixture-model'] }));
        }
        if (String(url) === '/api/config' && init.method === 'PUT' && String(init.body).includes('"openaiCompat"')) {
          window.keySaves++;
          if (window.rejectKeySave) return Promise.resolve(Response.json({ error: 'Fixture save rejected' }, { status: 503 }));
        }
        return original(url, init);
      };
      return true;
    })()`);
    // API keys sit in Settings > Models, under the model providers.
    await openSettings((verb, ...args) => ui(verb, info.ui, ...args), "Models");
    await clickByName((verb, ...args) => ui(verb, info.ui, ...args), "API keys", "button");
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[data-settings-block="connections"]'))`), { timeout: 10_000 }).toBe(true);
    // The servers section opens on its own, because a key is saved there.
    await expect.poll(masked, { timeout: 10_000 }).toContain("••••••••-key");

    await replace();
    await expect.poll(() => evaluate(`${dialog}.querySelector('[data-key-check]')?.disabled ?? null`), { timeout: 10_000 }).toBe(false);
    await evaluate(`${dialog}.querySelector('[data-key-check]').click(); true`);
    await expect.poll(() => evaluate("window.keyTests")).toEqual([{ provider: "openaiCompat" }]);
    await expect.poll(verdict).toBe("Saved key: Model catalog reachable: fixture-model. Authentication and chat not verified.");

    await type("  fixture-draft-key  ");
    await enter();
    await expect.poll(() => evaluate(`${input} ?? null`), { timeout: 10_000 }).toBe(null);
    await expect.poll(masked, { timeout: 10_000 }).toContain("••••••••-key");
    await expect.poll(() => evaluate("window.keyTests")).toEqual([{ provider: "openaiCompat" }, { provider: "openaiCompat" }]);
    expect(await evaluate("window.keySaves")).toBe(1);

    await replace();
    await type("not a key at all");
    await enter();
    await expect.poll(rowText, { timeout: 10_000 }).toContain("That doesn't look like an API key");
    expect(await evaluate("window.keySaves")).toBe(1);
    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "provider-key-refused.png"));

    await type("fixture-replacement-key");
    await evaluate("window.rejectKeySave = true");
    await enter();
    await expect.poll(rowText, { timeout: 10_000 }).toContain("Didn't work: Fixture save rejected");
    await expect.poll(() => evaluate(`${input}?.value ?? null`), { timeout: 10_000 }).toBe("fixture-replacement-key");
    await evaluate("window.rejectKeySave = false");
    await focusField();
    await enter();
    await expect.poll(() => evaluate(`${input} ?? null`), { timeout: 10_000 }).toBe(null);
    await expect.poll(() => evaluate("window.keyTests.length")).toBe(3);
    await expect.poll(verdict).toBe("Saved key: Model catalog reachable: fixture-model. Authentication and chat not verified.");
    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 180_000);

  run("sends a turn from the composer and shows the reply, never the tool steps", async () => {
    launched = await launch(["--tool-calls", TOOL_CALLS]);
    const { info } = launched;
    expect(info.ui).toBe(join(info.dataDir, "ui.json"));
    expect(existsSync(info.ui)).toBe(true);
    const handle = JSON.parse(readFileSync(info.ui, "utf8"));
    expect(handle).toMatchObject({ url: info.url, previewUrl: info.previewUrl, botId: info.botId, home: info.dataDir, session: `dusk-ui-${new URL(info.url).port}` });
    expect(existsSync(handle.binary)).toBe(true);

    const dry = await ui("flag", info.ui, "--set", "features.showToolCalls=true", "--dry-run");
    expect(dry).toMatchObject({ ok: true, dryRun: true, patch: { features: { showToolCalls: true } } });
    const flagged = await ui("flag", info.ui, "--set", "features.showToolCalls=true");
    expect(flagged).toMatchObject({ ok: true, features: { showToolCalls: false } }); // saved, but the app never turns it on
    expect(flagged.features).toMatchObject({ skillAuthoring: true });

    const savedBot = async () => (await fetch(`${info.url}/api/bots`).then((response) => response.json())).bots.find((bot: any) => bot.id === info.botId);
    const originalBot = await savedBot();
    const originalModel = originalBot.modelSelection.model;
    const models = await runControlDusk(["models", "--url", info.url]) as any;
    const options = models.instances.find((instance: any) => instance.instanceId === originalBot.modelSelection.instanceId).models.options;
    const originalLabel = options.find((option: any) => option.id === originalModel).label;
    const nextModel = options.find((option: any) => option.id !== originalModel);
    // The chat header is the pill alone: the model is picked in the bot's panel, and an owner's pick there is the
    // thread's and the bot's default at once.
    await ui("click", info.ui, "--name", "Open Pepper's profile");
    // the panel slides in: wait until its model button is there and has stopped moving, then press it
    const modelAt = `(() => { const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === ${JSON.stringify(originalLabel)}); const r = b?.getBoundingClientRect(); return r ? r.left + ',' + r.top : ''; })()`;
    let lastAt = "";
    await expect.poll(async () => {
      const at = (await ui("eval", info.ui, "--js", modelAt)).result as string;
      const still = at !== "" && at === lastAt;
      lastAt = at;
      return still;
    }, { timeout: 10_000, interval: 150 }).toBe(true);
    await ui("click", info.ui, "--name", originalLabel);
    await expect.poll(async () => (await ui("eval", info.ui, "--js", "String(Boolean(document.querySelector('[data-model-picker-content]')))")).result,
      { timeout: 10_000 }).toBe("true");
    const scopeShot = join(evidenceDir, "model-scope.png");
    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", scopeShot);
    await ui("click", info.ui, "--name", nextModel.label);
    await expect.poll(async () => (await savedBot()).modelSelection.model, { timeout: 10_000 }).toBe(nextModel.id);
    expect((await savedBot()).tasks.find((task: any) => task.threadId === originalBot.threadId).modelSelection.model).toBe(nextModel.id);
    expect((await savedBot()).approvalMode).toBe(originalBot.approvalMode);
    await ui("press", info.ui, "--keys", "Escape");
    await expect.poll(async () => (await ui("eval", info.ui, "--js", "String(Boolean(document.querySelector('[data-model-picker-content]')))")).result,
      { timeout: 10_000 }).toBe("false");

    const before = await ui("snapshot", info.ui, "--interactive");
    expect(before.ok).toBe(true);
    const [composer, ...moreComposers] = refsNamed(before, "Message Pepper", "textbox");
    expect(composer).toMatch(/^@e\d+$/);
    expect(moreComposers).toEqual([]);
    expect(before.snapshot).not.toContain(REPLY);

    const typed = await ui("type", info.ui, "--ref", composer, "--text", "hello");
    expect(typed).toMatchObject({ ok: true, target: composer, typed: "hello" });
    const pressed = await ui("press", info.ui, "--keys", "Enter");
    expect(pressed).toMatchObject({ ok: true, pressed: "Enter" });

    const settled = await ui("wait-settle", info.ui, "--timeout", "60");
    expect(settled).toMatchObject({ ok: true, status: "settled", browser: { state: "networkidle" }, renderer: { rendered: true } });
    expect((settled.bots as Array<{ busy: boolean }>).every((bot) => !bot.busy)).toBe(true);

    const after = await ui("snapshot", info.ui);
    expect(after.ok).toBe(true);
    const tree = after.snapshot as string;
    // The sidebar row previews the reply too; read the transcript landmark.
    const transcriptStart = tree.indexOf('log "Conversation with Pepper"');
    expect(transcriptStart).toBeGreaterThan(-1);
    const transcript = tree.slice(transcriptStart);
    expect(transcript).toContain('StaticText "hello"'); // the sent turn
    expect(transcript).toContain(`StaticText "${REPLY}"`);
    expect(tree).not.toContain("Not logged in");
    expect(tree).not.toContain("Execution timeline");
    // chat is chat only: even with the old flag on, no "Worked" fold, tool chips or run receipt show
    const shown = Object.values((await ui("snapshot", info.ui)).refs as Record<string, { name: string; role: string }>).map((element) => element.name);
    expect(shown.some((name) => /^Worked\b|^Run a command · |View trace/.test(name))).toBe(false);

    const composerHit = await ui("eval", info.ui, "--js", `(() => {
      const composer = ${COMPOSER};
      const input = composer.getBoundingClientRect();
      return document.elementFromPoint(input.left + input.width / 2, input.top + input.height / 2) === composer;
    })()`);
    expect(composerHit).toMatchObject({ result: true });

    expect(await runControlDusk(["doctor", "--url", info.url])).toMatchObject({ ok: true });
    await expect(ui("click", info.ui, "--name", "Deliberately missing QA control")).rejects.toThrow("no element is named");

    // Planted with the same delay the real control has: a --name lookup that
    // lands a tick early must still click it.
    await ui("eval", info.ui, "--js", `(() => {
      const late = document.createElement("button");
      late.textContent = "Late QA control";
      late.setAttribute("aria-label", "Late QA control");
      // Keep this synthetic target inside the viewport: appending a normal
      // flow sibling below the full-height app makes click scroll the app
      // out of view, interfering with the real controls exercised next.
      late.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647';
      setTimeout(() => document.body.appendChild(late), 1500);
      return "planted";
    })()`);
    expect(await ui("click", info.ui, "--name", "Late QA control")).toMatchObject({ ok: true });
    await ui("eval", info.ui, "--js", `document.querySelector('[aria-label="Late QA control"]').remove()`);

    mkdirSync(evidenceDir, { recursive: true });
    const shotPath = join(evidenceDir, "chat-ui.png");
    const shot = await ui("screenshot", info.ui, "--out", shotPath);
    expect(shot).toMatchObject({ ok: true, path: shotPath });
    const png = readFileSync(shotPath);
    expect(png.length).toBeGreaterThan(1_000);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const logs = await ui("console", info.ui);
    expect(logs.ok).toBe(true);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);
    const title = await ui("eval", info.ui, "--js", "document.title");
    expect(title).toMatchObject({ ok: true, result: "Isolated Metal Chat" });

    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
    expect(existsSync(info.logPath)).toBe(true);
    await expect(ui("snapshot", info.ui)).rejects.toThrow("could not read the ui handle");
  }, LAUNCH_TIMEOUT_MS + 120_000);
});
