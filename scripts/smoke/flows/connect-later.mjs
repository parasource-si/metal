// Connecting things after the first run, as a new person finds them: the sidebar's "connect apps" sheet and Gmail on it
// (up to the point where Google's own sign-in would take over: nothing is connected for real), then Settings > Models,
// where an AI is connected later, with one AI's card open. A fresh app on this Mac, signed out, past the welcome.
//
//   node scripts/smoke/flows/connect-later.mjs [--out DIR] [--profile DIR]
import { createFlow, flowArgs, runFlow, sleep } from "./lib.mjs";
import { walkthrough } from "./recorder.mjs";

const { root, out, profile, email } = flowArgs("conn");
const flow = createFlow({ name: "connect-later", title: "connect apps and an AI later", root, out, profile, email });
const shownButtons = (scope = "body") => flow.evaluate(`[...(document.querySelector(${JSON.stringify(scope)}) ?? document).querySelectorAll("button,a,[role=button]")].filter((e) => e.getClientRects().length).map((e) => (e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\\s+/g, " ")).filter(Boolean)`);

await runFlow(flow, async () => {
  await flow.step("launch", "a fresh app on this Mac, past the welcome", async () => {
    await flow.launch();
    await flow.waitText(/meet Metal|where should your bots live/i, "the welcome", { timeout: 120_000 });
    // past the welcome the way the first-run walkthrough already shows (section 1)
    await flow.evaluate(`fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarding: { completedAt: new Date().toISOString(), version: 1 } }) }).then((r) => r.status)`);
    await flow.evaluate(`location.reload(); true`).catch(() => {});
    await sleep(4000);
    await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the chat", 60_000);
  }, { critical: true });

  await flow.step("connect-apps", "the sidebar's connect apps opens the apps sheet", async () => {
    await flow.clickSelector('[data-sidebar-nav="apps"]');
    await sleep(2000);
    const heads = await flow.evaluate(`[...document.querySelectorAll("[role=dialog] h1, [role=dialog] h2, h1, h2")].filter((e) => e.getClientRects().length).map((e) => e.innerText.trim()).join(" / ")`);
    flow.facts.appsSheet = heads;
    return heads;
  }, { critical: true });

  await flow.step("gmail", "Gmail on the apps sheet: what connecting it asks for", async () => {
    const since = Date.now();
    const opened = await flow.evaluate(`(() => {
      const shown = [...document.querySelectorAll("button,[role=button],a")].filter((e) => e.getClientRects().length && !e.disabled);
      const row = shown.find((e) => /^gmail\\b/i.test((e.innerText || e.getAttribute("aria-label") || "").trim()));
      if (!row) return null; row.click(); return (row.innerText || row.getAttribute("aria-label")).trim().replace(/\\s+/g, " ").slice(0, 60); })()`);
    if (!opened) throw new Error(`no Gmail on the sheet (buttons: ${(await shownButtons()).slice(0, 20).join(", ")})`);
    walkthrough.did(`clicks "${opened}"`);
    await sleep(2500);
    // one more press when the Gmail card asks to connect: the browser page it opens is recorded, never visited
    const connect = await flow.evaluate(`(() => { const b = [...document.querySelectorAll("button")].filter((e) => e.getClientRects().length && !e.disabled).find((e) => /^(connect|connect gmail|sign in with google|continue)$/i.test(e.innerText.trim())); if (!b) return null; b.click(); return b.innerText.trim(); })()`);
    const pressed = Date.now();
    if (connect) { walkthrough.did(`clicks "${connect}"`); await sleep(8000); }
    const first = flow.app.events().find((event) => event.kind === "open-external" && event.at >= pressed);
    if (connect) flow.facts.gmailOpenMs = first ? first.at - pressed : null;
    const links = flow.opened(since).map((url) => { try { const u = new URL(url); return u.host + u.pathname; } catch { return url; } });
    flow.facts.gmailOpened = links;
    await walkthrough.capture("app");
    const after = connect && first ? ` ${((first.at - pressed) / 1000).toFixed(1)} s after the press` : "";
    return `${connect ? `pressed ${connect}; ` : ""}${links.length ? `the app opened ${links.join(", ")} in the browser${after}` : "nothing opened in the browser"}`;
  });

  await flow.step("models", "Settings > Models: connecting an AI later", async () => {
    await flow.escape().catch(() => {});
    await sleep(600);
    await flow.escape().catch(() => {});
    await flow.openSettings();
    await flow.waitFor(`document.querySelectorAll("[data-settings-page]").length > 0`, "the Settings pages", 20_000);
    const page = await flow.evaluate(`(() => { const b = [...document.querySelectorAll("[data-settings-page]")].find((e) => /model|^ai\\b/i.test(e.innerText.trim()) || /model/i.test(e.getAttribute("data-settings-page"))); if (!b) return null; b.click(); return b.innerText.trim(); })()`);
    if (!page) throw new Error(`no Models page in Settings (pages: ${(await flow.evaluate(`[...document.querySelectorAll("[data-settings-page]")].map((e) => e.innerText.trim()).join(", ")`))})`);
    walkthrough.did(`clicks "${page}" in Settings`);
    await sleep(2000);
    flow.facts.modelsPage = (await flow.text("[role=dialog]")).replace(/\s+/g, " ").slice(0, 300);
    return page;
  });

  await flow.step("model-card", "one AI on the Models page, opened", async () => {
    const picked = await flow.evaluate(`(() => {
      const scope = document.querySelector("[data-settings-scroll]") ?? document.querySelector("[role=dialog]") ?? document;
      const b = [...scope.querySelectorAll("button")].filter((e) => e.getClientRects().length && !e.disabled)
        .find((e) => /chatgpt|claude|openai|anthropic|gemini|connect|sign in/i.test(e.innerText.trim()));
      if (!b) return null; b.click(); return b.innerText.trim().replace(/\\s+/g, " ").slice(0, 60); })()`);
    if (!picked) throw flow.skip("no AI to open on the Models page");
    walkthrough.did(`clicks "${picked}"`);
    await sleep(2500);
    await walkthrough.capture("app");
    const opened = flow.opened(Date.now() - 4000).map((url) => { try { return new URL(url).host; } catch { return url; } });
    return `${picked}${opened.length ? `; opened ${opened.join(", ")} in the browser` : ""}`;
  });
});
