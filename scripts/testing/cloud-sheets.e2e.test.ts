// The cloud and server sheets for the gallery: the move offer (asked, as a banner, in Settings), the move on its way,
// failing and done, and a new Cloud's welcome, in the real app on a fake-engine server with the desktop bridge played in
// the page (cloud-move-preview.tsx, cloud-welcome-preview.tsx), light and dark, desktop and the smallest window. Each
// open modal also gets the cover check. Screenshots go to DUSK_GALLERY_DIR beside the other galleries'.
//
//   DUSK_UI_E2E=1 pnpm exec vitest run scripts/testing/cloud-sheets.e2e.test.ts   (DUSK_CLOUD_SKIP=move=done leaves states out)
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk, type VerificationServer } from "../control-dusk.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-dusk-ui.ts";
import { fixtureApi, mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";
import { connect } from "./chat-gallery/cdp.ts";
import { NOTICES } from "../../src/lib/notices.ts";

const enabled = process.env.DUSK_UI_E2E === "1";
const VIEWPORTS = [
  { id: "desktop", width: 1280, height: 860 },
  { id: "min", width: 768, height: 520 },
] as const;
const SKINS = (process.env.DUSK_SURFACES_SKINS ?? "grok,grok-dark").split(",");
const SKIP = process.env.DUSK_CLOUD_SKIP?.split(",") ?? [];
const MOVE = ["offer=prompt", "offer=banner", "offer=settings", "move=copy", "move=failing", "move=done"].filter((query) => !SKIP.includes(query));
const WELCOME = ["", "desktop=1&move=copy", "desktop=1&move=done"];

(enabled ? it : it.skip)("draws the cloud and server sheets, each modal covering the whole window", async () => {
  const evidence = process.env.DUSK_GALLERY_DIR || join(REPO_ROOT, ".dusk-scratch", "verify-evidence", "chat-gallery");
  mkdirSync(evidence, { recursive: true });
  let fixture: VerificationServer | undefined;
  const previews: MountedPreview[] = [];
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const problems: string[] = [];
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("the gallery needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer(process.env);
    const base = fixture.info.url;
    // a set-up install, as the surfaces gallery has: welcomed, English, a bot of the person's own beside the starter
    const api = fixtureApi(base);
    await api("PATCH", "/api/config", { language: "en" });
    for (const bot of (await api("GET", "/api/bots")).bots.filter((one: { defaultBot?: unknown }) => one.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    await runControlDusk(["new-bot", "--name", "Pepper", "--url", base]);
    for (const one of (await api("GET", "/api/bots")).bots) await api("PATCH", `/api/bots/${one.id}`, { color: one.name === "Pepper" ? "orange" : "silver" });
    const relay = (change: (body: Record<string, unknown>) => Record<string, unknown>) => async (req: IncomingMessage, res: ServerResponse) => {
      const response = await fetch(`${base}${req.url}`, { headers: { accept: "application/json", cookie: req.headers.cookie ?? "" } });
      const body = await response.json() as Record<string, unknown>;
      res.statusCode = response.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response.ok ? change(body) : body));
    };
    const cloudHome = relay((body) => ({ ...body, cloudHome: true }));
    const move = await mountPreview(fixture, { entry: "/scripts/testing/cloud-move-preview.tsx", route: "/__cloud-move.html", title: "Cloud move", logLevel: "warn", hmr: false });
    const welcome = await mountPreview(fixture, { entry: "/scripts/testing/cloud-welcome-preview.tsx", route: "/__cloud-welcome.html", title: "Cloud welcome", logLevel: "warn", hmr: false,
      extraRoutes: [{ path: "/api/auth/session", method: "GET", handler: cloudHome }, { path: "/api/config", method: "GET", handler: cloudHome }] });
    previews.push(move, welcome);
    const profile = join(fixture.info.dataDir, "chrome");
    mkdirSync(profile, { recursive: true });
    chrome = spawn(tools.chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
      env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: "ignore",
    });
    const portFile = join(profile, "DevToolsActivePort");
    await expect.poll(() => existsSync(portFile), { timeout: 30_000 }).toBe(true);
    const [port, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
    cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const target = await cdp.request("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const request = (method: string, params: unknown = {}) => cdp!.request(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const response = await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    await request("Page.enable");
    await request("Runtime.enable");
    await request("Page.addScriptToEvaluateOnNewDocument", { source: `try { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); } catch {}` });
    await request("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const shots = [...MOVE.map((query) => ({ id: `move-${query.replace(/[=&]/g, "-")}`, url: `${move.previewUrl}?${query}` })),
      ...WELCOME.map((query) => ({ id: `welcome${query ? `-${query.replace("desktop=1&", "").replace(/[=&]/g, "-")}` : ""}`, url: `${welcome.previewUrl}?${query}` }))];
    for (const viewport of VIEWPORTS) for (const skin of SKINS) for (const shot of shots) {
      await request("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      await evaluate(`try { localStorage.clear(); sessionStorage.clear(); } catch {} true`).catch(() => undefined);
      await request("Page.navigate", { url: `${shot.url}${shot.url.includes("?") ? "&" : "?"}skin=${skin}` });
      // settled: the boot cover gone, fonts in
      // and the app itself in: the bot list loaded, neither the connecting screen nor the first-run welcome showing
      const name = `cloud-${shot.id}-${viewport.id}${skin === "grok" ? "" : `-${skin}`}`;
      await expect.poll(() => evaluate(`!document.querySelector("[data-boot-cover]:not([data-boot-cover=closing])") && document.readyState === "complete"
        && document.body.textContent.includes("Pepper") && !/Connecting to your bots|Meet Metal/.test(document.body.innerText)`), { timeout: 30_000 }).toBe(true)
        .catch(() => { problems.push(`${name}: the app never finished loading (still connecting, or the first-run welcome)`); });
      await evaluate(`document.fonts.ready.then(() => new Promise((done) => setTimeout(done, 1200)))`);
      writeFileSync(join(evidence, `${name}.png`), Buffer.from((await request("Page.captureScreenshot", { format: "png" })).data, "base64"));
      // any open modal's scrim covers the whole window (the same check as the surfaces gallery)
      const uncovered: string[] = await evaluate(`(() => {
        const modal = [...document.querySelectorAll('[aria-modal="true"], [role="alertdialog"], dialog[open]')].filter((one) => one.getClientRects().length).at(-1);
        if (!modal) return [];
        const w = innerWidth, h = innerHeight, box = modal.getBoundingClientRect(), out = [];
        for (const [x, y] of [[3, 3], [w - 4, 3], [3, h - 4], [w - 4, h - 4], [w * 0.2, 28], [w * 0.62, 30], [120, h - 30], [w * 0.62, h - 40]]) {
          if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit && !(hit === modal || modal.contains(hit) || hit.contains(modal) || /scrim|backdrop/.test(String(hit.className)))) out.push(x + "," + y);
        }
        return out;
      })()`);
      if (uncovered.length) problems.push(`${name}: the open modal leaves ${uncovered.join(" ")} uncovered`);
    }
    expect(problems).toEqual([]);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    for (const preview of previews) await preview.close();
    await fixture?.close();
  }
}, 900_000);
