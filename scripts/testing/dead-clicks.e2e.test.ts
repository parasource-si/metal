// The dead-click guard: every control a person can press, in every chat card the gallery draws
// (chat-gallery/fixtures.ts) and across the real app (its chat, the bot panel and its tabs, menus, sheets, settings
// sections and dialogs, found by following what each press opens), pressed once from the same state. A press after
// which nothing observable happens within a second (no change on the page, no navigation or window, no request, no
// message to the desktop app, no focus move, scroll, copy or sound) fails the run, as a "take over" that did nothing
// once did. Presses that would reach outside the test (the OS, a real browser, money, ending the session) are skipped
// by name (dead-clicks/crawl.ts). Evidence: DUSK_DEAD_CLICKS_DIR (default .dusk-scratch/verify-evidence/dead-clicks).
//
//   DUSK_UI_E2E=1 pnpm exec vitest run scripts/testing/dead-clicks.e2e.test.ts
//   DUSK_DEAD_CLICKS_ONLY=gallery (or app) and DUSK_DEAD_CLICKS_SCENARIOS=cards-pending narrow the run.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlDusk, type VerificationServer } from "../control-dusk.ts";
import { ensureUiBrowser } from "./control-dusk-ui.ts";
import { encodePng } from "./png.ts";
import { fixtureApi, mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";
import { GALLERY_IMAGE, GALLERY_WIDE_IMAGE, SCENARIOS } from "./chat-gallery/fixtures.ts";
import { crawlDeadClicks, type CrawlReport, type DeadClick } from "./dead-clicks/crawl.ts";
import { openChrome, type ChromeTab } from "./dead-clicks/chrome.ts";
import { NOTICES } from "../../src/lib/notices.ts";

const enabled = process.env.DUSK_UI_E2E === "1";
if (!enabled) console.log("skipping the dead-click guard: set DUSK_UI_E2E=1 for isolated browser qualification");
const ONLY = process.env.DUSK_DEAD_CLICKS_ONLY;
const started = Date.now();
const log = (line: string) => console.log(`[dead-clicks ${Math.round((Date.now() - started) / 1000)}s] ${line}`);

/** Controls that rightly show nothing within a second in this fixture, each with the reason. Keep it short. */
const ALLOWED: Record<string, string> = {
  // the connector card's Manage opens the Connect apps window, which the gallery page does not mount; the app crawl
  // presses it where the window exists
  "gallery cards-settled button:Manage#": "opens the Connect apps window, not mounted in the gallery",
  "gallery cards-settled button:manage#": "opens the Connect apps window, not mounted in the gallery",
};
const allowed = (dead: DeadClick) => Object.keys(ALLOWED).some((pattern) => `${dead.surface} ${dead.key}`.includes(pattern));

const photo = encodePng(240, 160, (x, y) => [80 + (x % 120), 120 + (y % 80), 200]);
const wide = encodePng(480, 120, (x, y) => [200, 100 + (x % 100), 80 + (y % 40)]);

(enabled ? it : it.skip)("every control in the chat cards and the app does something when pressed", async () => {
  let fixture: VerificationServer | undefined;
  let gallery: MountedPreview | undefined;
  let app: MountedPreview | undefined;
  let tab: ChromeTab | undefined;
  const evidence = process.env.DUSK_DEAD_CLICKS_DIR || join(process.env.DUSK_UI_EVIDENCE_DIR || join(REPO_ROOT, ".dusk-scratch", "verify-evidence"), "dead-clicks");
  mkdirSync(evidence, { recursive: true });
  const reports: CrawlReport[] = [];
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("the dead-click guard needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer(process.env);
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en", onboarding: { completedAt: new Date().toISOString(), version: 999 } });
    const { bots } = await api("GET", "/api/bots");
    for (const bot of bots.filter((bot: { defaultBot?: unknown }) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    await runControlDusk(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
    tab = await openChrome(tools.chrome, fixture.info.dataDir);
    await tab.viewport(1100, 900);
    const page = tab;
    const quiet = `try { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); localStorage.setItem("dusk-email-gate", "skipped"); } catch {}`;

    if (!ONLY || ONLY === "gallery") {
      gallery = await mountPreview(fixture, {
        entry: "/scripts/testing/chat-gallery-preview.tsx", route: "/__chat-gallery.html", title: "Chat gallery", logLevel: "warn", hmr: false,
        extraRoutes: [{ path: /^\/api\/attachments\/([^/?]+)/, method: "GET", handler: (_req, res, match) => {
          const name = decodeURIComponent(match![1]!);
          if (name !== GALLERY_IMAGE && name !== GALLERY_WIDE_IMAGE) { res.statusCode = 404; res.end(); return; }
          res.setHeader("content-type", "image/png");
          res.end(name === GALLERY_IMAGE ? photo : wide);
        } }],
      });
      const only = process.env.DUSK_DEAD_CLICKS_SCENARIOS?.split(",");
      for (const scenario of SCENARIOS.filter((one) => !only || only.includes(one.id))) {
        const url = `${gallery.previewUrl}?scenario=${scenario.id}&skin=grok`;
        reports.push(await crawlDeadClicks({
          evaluate: (expression) => page.evaluate(expression),
          open: async () => { await page.evaluate(quiet).catch(() => undefined); await page.navigate(url, `[data-gallery-ready="${scenario.id}"] [data-simple-rows]`, 120_000); },
        }, { name: `gallery ${scenario.id}`, scope: "[data-gallery-ready]", budget: 6, depth: 1, states: false, log }));
      }
    }

    if (!ONLY || ONLY === "app") {
      app = await mountPreview(fixture, { entry: "/src/main.tsx", route: "/__app.html", title: "Metal", logLevel: "warn", hmr: false });
      const url = `${app.previewUrl}`;
      reports.push(await crawlDeadClicks({
        evaluate: (expression) => page.evaluate(expression),
        open: async () => { await page.evaluate(quiet).catch(() => undefined); await page.navigate(url, "[data-tour=composer] textarea", 120_000); },
      }, { name: "app", budget: Number(process.env.DUSK_DEAD_CLICKS_BUDGET) || 25, log }));
    }

    writeFileSync(join(evidence, "report.json"), JSON.stringify(reports, null, 2));
    const dead = reports.flatMap((report) => report.dead).filter((one) => !allowed(one)).map((one) => `${one.surface}: ${one.key} ${one.html}`);
    expect(reports.reduce((sum, report) => sum + report.pressed, 0)).toBeGreaterThan(0);
    expect(dead).toEqual([]);
  } finally {
    await tab?.close();
    await gallery?.close();
    await app?.close();
    await fixture?.close();
  }
}, 1_800_000);
