// Buying dusk cloud as a new person, for real in Dodo's TEST mode (nothing is charged): a fresh account at the app's gate,
// the welcome's dusk cloud, a plan, the checkout the app opens in the browser paid with the test card in a headless
// Chrome (../dodo-test-pay.mjs), then the app by itself: payment seen, the cloud set up, the bots moved, the bots
// working on it. Leaves the account and its cloud in place unless --delete is given (the stress account is kept).
//
//   node scripts/smoke/flows/buy-cloud.mjs [--out DIR] [--profile DIR] [--email ADDRESS] [--delete]
import { join } from "node:path";
import { createFlow, flowArgs, runFlow, sleep } from "./lib.mjs";
import { payDodoTestCheckout } from "../dodo-test-pay.mjs";

const { root, out, profile, email } = flowArgs("buy");
// the app works signed out now; this flow starts from a signed-in account, at the sign-in an install can still require
const flow = createFlow({ name: "buy-cloud", title: "buy dusk cloud (test mode)", root, out, profile, email, env: { DUSK_REQUIRE_ACCOUNT: "1" } });
const headings = () => flow.evaluate(`[...document.querySelectorAll("h1,h2,[role=dialog] h2,[data-add-cloud-flow],[data-cloud-move]")].filter((e) => e.getClientRects().length)
  .map((e) => e.getAttribute("data-add-cloud-flow") ? "flow:" + e.getAttribute("data-add-cloud-flow") : e.getAttribute("data-cloud-move") ? "move:" + e.getAttribute("data-cloud-move") : e.innerText.trim()).join(" / ")`);
const myCloud = () => flow.evaluate(`window.duskDesktop.cloudAccount.state().then((s) => (s.clouds ?? [])[0] ?? null)`);

await runFlow(flow, async () => {
  await flow.step("launch", "a fresh app starts at the account gate", async () => {
    await flow.launch();
    await flow.waitText(/sign in to Metal/i, "the account gate", { timeout: 120_000 });
  }, { critical: true });

  await flow.step("sign-in", "signs in with an emailed code", () => flow.signInAtGate(), { critical: true });

  await flow.step("plans", "dusk cloud opens the plans", async () => {
    await flow.waitText(/meet Metal|where should your bots live/i, "the welcome", { timeout: 60_000 });
    await flow.click("get started", { timeout: 10_000 }).catch(() => {});
    await flow.waitText(/where should your bots live/i, "where should your bots live");
    await flow.click("dusk cloud", { contains: true });
    await flow.waitFor(`Boolean(document.querySelector("[data-plan-buy]"))`, "a plan to buy", 30_000);
    flow.facts.plans = await flow.evaluate(`[...document.querySelectorAll("[data-plan]")].map((p) => p.getAttribute("data-plan") + ": " + p.innerText.replace(/\\s+/g, " ").slice(0, 80))`);
    return flow.facts.plans.join(" | ").slice(0, 300);
  }, { critical: true });

  let checkoutUrl = null;
  await flow.step("checkout", "the plan's button opens a secure test-mode checkout in the browser", async () => {
    const since = Date.now();
    const tier = await flow.evaluate(`(document.querySelector('[data-plan-buy="starter"]') ?? document.querySelector("[data-plan-popular]")?.closest("[data-plan]")?.querySelector("[data-plan-buy]") ?? document.querySelector("[data-plan-buy]")).getAttribute("data-plan-buy")`);
    flow.facts.tier = tier;
    await flow.clickSelector(`[data-plan-buy="${tier}"]`);
    for (let tries = 0; tries < 60 && !checkoutUrl; tries++) { await sleep(1000); checkoutUrl = flow.opened(since).find((url) => /checkout\.dodopayments\.com/.test(url)) ?? null; }
    if (!checkoutUrl) throw new Error(`no checkout opened (app opened: ${flow.opened(since).join(", ") || "nothing"}; screen: ${await headings()})`);
    flow.facts.checkoutSeconds = Math.round((Date.now() - since) / 1000);
    if (!checkoutUrl.startsWith("https://test.")) throw new Error("the checkout is not in test mode; refusing to pay");
    flow.facts.payScreen = (await flow.text("[data-add-cloud-flow]").catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    return `opened in ${flow.facts.checkoutSeconds}s on ${new URL(checkoutUrl).host}`;
  }, { critical: true });

  await flow.step("pay", "pays with the test card", async () => {
    const started = Date.now();
    let n = 0;
    const result = await payDodoTestCheckout(checkoutUrl, { log: flow.log, shot: (label) => join(out, `pay-${++n}-${label}.png`) });
    flow.facts.paySeconds = Math.round((Date.now() - started) / 1000);
    return `paid; checkout ended at ${new URL(result.url).pathname}`;
  }, { critical: true });

  await flow.step("payment-seen", "the app sees the payment by itself", async () => {
    const started = Date.now();
    await flow.waitFor(`window.duskDesktop.cloudAccount.state().then((s) => (s.clouds ?? []).length > 0 || (s.entitlement?.plan && s.entitlement.plan !== "free"))`, "the payment in the app", 5 * 60_000);
    flow.facts.paymentSeenSeconds = Math.round((Date.now() - started) / 1000);
    if (flow.facts.paymentSeenSeconds > 30) flow.friction("slow", "after paying", `the app took ${flow.facts.paymentSeenSeconds}s to notice the payment`);
    return `${flow.facts.paymentSeenSeconds}s; screen: ${await headings()}`;
  }, { critical: true });

  await flow.step("cloud-ready", "the cloud is set up", async () => {
    const started = Date.now();
    const seen = new Set();
    for (;;) {
      const cloud = await myCloud();
      const screen = await headings();
      if (!seen.has(screen)) { seen.add(screen); flow.log(`screen: ${screen}`); }
      // the app's words for a cloud (electron/cloud-list.d.mts): checkout, setting_up, ready, stopped, payment_problem, ended, offline
      if (cloud?.status === "ready") break;
      if (cloud?.status === "payment_problem" || cloud?.status === "ended") throw new Error(`the cloud is ${cloud.status}`);
      if (Date.now() - started > 15 * 60_000) throw new Error(`not ready after 15 minutes (${cloud?.status} / ${cloud?.setupStep ?? ""})`);
      await sleep(5000);
    }
    flow.facts.readySeconds = Math.round((Date.now() - started) / 1000);
    flow.facts.screensWhileSettingUp = [...seen];
    if (flow.facts.readySeconds > 180) flow.friction("slow", "setting up", `the cloud took ${Math.round(flow.facts.readySeconds / 60)} minutes; the sheet says about 2`);
    return `ready in ${flow.facts.readySeconds}s`;
  }, { critical: true });

  let bought = null;
  await flow.step("on-cloud", "the app opens the new cloud by itself", async () => {
    const cloud = bought = await myCloud();
    const host = new URL(cloud.origin).host;
    const started = Date.now();
    const seen = new Set();
    for (;;) {
      const screen = await headings();
      if (!seen.has(screen)) { seen.add(screen); flow.log(`screen: ${screen}`); }
      const where = await flow.evaluate(`location.host`);
      const chat = await flow.evaluate(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`);
      const welcome = await flow.evaluate(`/welcome to dusk cloud/i.test(document.body.innerText)`).catch(() => false);
      if (welcome && !flow.facts.cloudWelcome) {
        flow.facts.cloudWelcome = true;
        flow.friction("extra-click", "on the new cloud", "a second welcome (\"welcome to dusk cloud\", start chatting / not now) covers the chat right after the first-run welcome ended");
      }
      // the window is on the cloud, its chat is there and nothing covers it
      if (where === host && chat && !welcome) { await sleep(3000); if (!(await flow.evaluate(`/welcome to dusk cloud/i.test(document.body.innerText)`))) break; }
      // what a person presses to go on: a move offer, then the welcome's ways forward (never "not now")
      const pressed = await flow.evaluate(`(() => {
        const shown = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && !e.disabled);
        const move = shown("[data-cloud-move-accept]")[0];
        if (move) { move.click(); return "move"; }
        const words = ["start chatting", "open dusk cloud", "start with the free model", "skip for now", "skip", "continue"];
        for (const word of words) { const b = shown("button").find((e) => e.innerText.trim().toLowerCase() === word); if (b) { b.click(); return word; } }
        return null;
      })()`).catch(() => null);
      if (pressed) { flow.log(`pressed: ${pressed}`); flow.facts.pressed = [...(flow.facts.pressed ?? []), pressed]; }
      if (Date.now() - started > 10 * 60_000) throw new Error(`not on the cloud after 10 minutes (window at ${where}; screens: ${[...seen].join(" | ")})`);
      await sleep(3000);
    }
    flow.facts.onCloudSeconds = Math.round((Date.now() - started) / 1000);
    flow.facts.screensAfterReady = [...seen];
    return `the window shows ${host} after ${flow.facts.onCloudSeconds}s`;
  }, { critical: true });

  await flow.step("working", "a bot on the cloud answers", async () => {
    const marker = `smoke ${Date.now().toString(36)}`;
    await flow.evaluate(`document.querySelector('textarea[aria-label^="Message"]').focus(); true`);
    await flow.type(`Reply with just the word ok. (${marker})`);
    await flow.press("Enter", "Enter", 13);
    const started = Date.now();
    const outcome = await flow.waitFor(`(() => {
      const rows = document.querySelector("[data-simple-rows]")?.innerText ?? document.body.innerText;
      const at = rows.lastIndexOf(${JSON.stringify(marker)});
      if (at < 0) return false;
      const after = rows.slice(at + ${JSON.stringify(marker).length - 1}).replace(/\\b\\d{1,2}:\\d{2}\\b/g, "").trim();
      // no AI connected: the Connect your AI card is the answer, within ~30 s
      if (/connect your ai to keep chatting/i.test(document.body.innerText)) return "card:connect your AI";
      if (/failed|went wrong|couldn.t/i.test(after)) return "error:" + after.slice(0, 160);
      return /\\bok\\b/i.test(after) ? "reply:" + after.slice(0, 80) : false;
    })()`, "the bot's reply", 180_000);
    flow.facts.replySeconds = Math.round((Date.now() - started) / 1000);
    if (outcome.startsWith("error:")) throw new Error(`the bot answered with an error: ${outcome.slice(6)}`);
    if (outcome.startsWith("card:") && flow.facts.replySeconds > 30) throw new Error(`the Connect your AI card took ${flow.facts.replySeconds}s (expected within ~30 s)`);
    // the cloud's own page has no account bridge: the cloud is the one bought above
    const cloud = bought;
    flow.facts.cloud = { id: cloud?.id, status: cloud?.status, name: cloud?.name, origin: cloud?.origin };
    const said = outcome.startsWith("card:") ? "no AI connected: the Connect your AI card" : `replied "${outcome.slice(6).replace(/\s+/g, " ")}"`;
    return `${said} in ${flow.facts.replySeconds}s, from ${cloud?.name} (${cloud?.status})`;
  });
});
