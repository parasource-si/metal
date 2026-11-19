// The home page's app window draws its first frame with no script at all: the site served as it ships
// (apps/site/server.js), opened in Chrome with JavaScript turned off, must show the window's bot list, chat and panel.
// A browser that blocks or never runs the demo's script (a content blocker, an old engine) still sees the app.
//
//   DUSK_UI_E2E=1 pnpm exec vitest run scripts/testing/home-window.e2e.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { connect } from "./chat-gallery/cdp.ts";
import { ensureUiBrowser } from "./control-dusk-ui.ts";
import { REPO_ROOT } from "./preview-fixture.ts";

const enabled = process.env.DUSK_UI_E2E === "1";
if (!enabled) console.log("skipping the home window check: set DUSK_UI_E2E=1 for isolated browser qualification");

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

(enabled ? it : it.skip)("shows the home page's app window with JavaScript turned off, on desktop and phone widths", async () => {
  const site = join(REPO_ROOT, "apps", "site");
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "dusk-home-window-"));
  let server: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    server = spawn(process.execPath, ["server.js", "landing"], { cwd: site, env: { PATH: process.env.PATH, PORT: String(port) }, stdio: "ignore" });
    await expect.poll(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false), { timeout: 20_000 }).toBe(true);
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("the check needs a Chrome");
    chrome = spawn(tools.chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    await expect.poll(() => existsSync(portFile), { timeout: 30_000 }).toBe(true);
    const [debugPort, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
    cdp = await connect(`ws://127.0.0.1:${debugPort}${endpoint}`);
    const target = await cdp.request("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const request = (method: string, params: unknown = {}) => cdp!.request(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const response = await request("Runtime.evaluate", { expression, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    await request("Page.enable");
    await request("Emulation.setScriptExecutionDisabled", { value: true });
    for (const viewport of [{ width: 1440, height: 1000, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      await request("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
      await request("Page.navigate", { url: `http://127.0.0.1:${port}/` });
      await expect.poll(() => evaluate("document.readyState"), { timeout: 20_000 }).toBe("complete");
      await evaluate("document.querySelector('[data-dw]').scrollIntoView({ block: 'center' }); true");
      await new Promise((done) => setTimeout(done, 1200));
      const seen = await evaluate(`(() => {
        const win = document.querySelector('[data-dw]'), host = document.querySelector('[data-dw-host]');
        const root = host && host.shadowRoot;
        const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { w: r.width, h: r.height, shown: s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 }; };
        return {
          win: box(win), host: box(host), shadow: Boolean(root),
          pill: root && root.querySelector('[data-chathead-pill]')?.textContent.trim(),
          pillBox: box(root && root.querySelector('[data-chathead-pill]')),
          bubble: box(root && root.querySelector('[data-chat-bubble]')),
          composer: box(root && root.querySelector('[data-composer-row]')),
          sheet: Boolean(root && [...root.querySelectorAll('link[rel=stylesheet]')].some((l) => l.sheet && l.sheet.cssRules.length > 50)),
        };
      })()`);
      expect(seen.shadow, `${viewport.width}px: the window's markup is in place`).toBe(true);
      expect(seen.sheet, `${viewport.width}px: the app's styles applied`).toBe(true);
      expect(seen.pill).toBe("Metal");
      for (const part of ["win", "host", "pillBox", "bubble", "composer"] as const) {
        expect(seen[part]?.shown, `${viewport.width}px: ${part} is shown`).toBe(true);
        expect(seen[part]?.w, `${viewport.width}px: ${part} has width`).toBeGreaterThan(20);
        expect(seen[part]?.h, `${viewport.width}px: ${part} has height`).toBeGreaterThan(10);
      }
      expect(seen.win.h).toBeGreaterThan(300);
    }
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    if (server && server.exitCode === null) { server.kill(); await waitForExit(server).catch(() => undefined); }
    rmSync(profile, { recursive: true, force: true });
  }
}, 180_000);
