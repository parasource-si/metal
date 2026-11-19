// The first run's account step handed to the website and back, as a new person does it: a fresh app (signed out) shows
// the account step; Google, X and Apple each open the website's provider start with this app's sign-in code (checked up
// to the provider's own page, never signed in there); an emailed magic link (sink address) signs in on the website, the
// app signs itself in and goes on with its own first run while the website asks a name and a plan. The website never opens
// the app by itself: skipping the plan ends on the pricing page, paying (test-mode checkout) ends on the plan page, and both
// show a quiet "open Metal" (duskbot://open, or duskbot://cloud after paying) that the run presses, delivered to the app
// as the OS would.
//
//   node scripts/smoke/flows/account-handoff.mjs [--plan free|paid] [--out DIR] [--profile DIR] [--email ADDRESS] [--no-providers]
import { join } from "node:path";
import { until } from "../app.mjs";
import { envValue, isTestAddress, PREVIEW_ORIGIN } from "../account.mjs";
import { payDodoTestCheckout } from "../dodo-test-pay.mjs";
import { launchBrowser } from "./browser.mjs";
import { createFlow, flowArgs, runFlow, sleep } from "./lib.mjs";

const { option, flag, root, out, profile, email } = flowArgs("handoff");
const plan = option("--plan", "free");
if (!["free", "paid"].includes(plan)) throw new Error("--plan is free or paid");
const NAME = option("--name", "Robin Fieldtest");
const flow = createFlow({ name: `account-handoff-${plan}`, title: `account step handoff (${plan})`, root, out, profile, email,
  env: { DUSK_ANALYTICS: process.env.DUSK_ANALYTICS ?? "1" } });

const at = () => flow.evaluate(`document.querySelector("[data-welcome]")?.dataset.welcome ?? null`);
const gate = (expression) => flow.evaluate(`window.duskDesktop.accountGate.${expression}`);
const timeline = [];
const mark = (what, where) => { timeline.push({ what, where, at: Date.now() }); flow.log(`${where}: ${what}`); };

/** the newest magic link the account service kept for this test address since `since` */
async function testMailLink(since) {
  if (!isTestAddress(email)) throw new Error("not a test address");
  const token = envValue("DUSK_OPS_TOKEN_PREVIEW");
  const response = await fetch(`${PREVIEW_ORIGIN}/v1/ops/test-mail?to=${encodeURIComponent(email)}&since=${Math.max(0, since - 5_000)}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the test mailbox answered ${response.status}`);
  return (await response.json()).link ?? null;
}

/** the app links a page asks the browser to open (Chrome hands them to the OS; headless, nothing opens) */
function watchAppLinks(browser) {
  const seen = [];
  const socket = new WebSocket(browser.wsUrl);
  socket.onopen = () => { socket.send(JSON.stringify({ id: 1, method: "Page.enable" })); };
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const url = message.params?.url;
    if (typeof url === "string" && url.startsWith("duskbot:") && !seen.includes(url)) seen.push(url);
  };
  return { seen, close: () => socket.close() };
}

await runFlow(flow, async () => {
  await flow.step("launch", "a fresh app shows the welcome, then the account step", async () => {
    await flow.launch();
    await flow.viewport(1040, 760);
    await flow.waitText(/meet Metal|create your/i, "the welcome", { timeout: 120_000 });
    if (await flow.evaluate(`Boolean([...document.querySelectorAll("button")].find((b) => /^get started$/i.test(b.innerText.trim()) && b.getClientRects().length))`)) await flow.click("get started");
    await flow.waitFor(`document.querySelector("[data-welcome]")?.dataset.welcome === "account"`, "the account step", 30_000);
    await sleep(1200);
    mark("account step shown", "app");
    const providers = await flow.evaluate(`[...document.querySelectorAll("[data-funnel-provider]")].map((b) => b.dataset.funnelProvider)`);
    flow.facts.providers = providers;
    return `providers: ${providers.join(", ")}`;
  }, { critical: true });

  if (!flag("--no-providers")) for (const provider of ["google", "apple"]) {
    await flow.step(`provider-${provider}`, `${provider} opens the website's provider start with this app's code`, async (entry) => {
      if (!(await flow.evaluate(`Boolean(document.querySelector('[data-funnel-provider="${provider}"]'))`))) throw flow.skip(`no ${provider} button`);
      const since = Date.now();
      await flow.clickSelector(`[data-funnel-provider="${provider}"]`);
      const opened = await until(() => flow.opened(since).find((url) => url.startsWith("https://")) ?? null, { timeout: 30_000, what: "the browser to open" });
      await flow.waitText(/finish in your browser/i, "the waiting screen");
      entry.shot = await flow.shot(`app-${provider}-waiting`);
      const view = await gate("state()");
      const start = new URL(opened);
      const next = start.searchParams.get("next") ?? "";
      const code = view.enrollment?.userCode ?? null;
      const problems = [];
      if (start.origin !== PREVIEW_ORIGIN) problems.push(`origin ${start.origin}`);
      if (start.pathname !== `/v1/auth/oauth/${provider}/start`) problems.push(`path ${start.pathname}`);
      if (!code || next !== `/cloud/desktop?code=${code}`) problems.push(`next ${next} (app code ${code})`);
      // the provider's page, as the website redirects to it: never followed further than its address
      const redirect = await fetch(opened, { redirect: "manual" });
      const location = redirect.headers.get("location") ?? "";
      let provided = null;
      try { provided = new URL(location); } catch { problems.push(`no provider redirect (${redirect.status})`); }
      const facts = provided ? { host: provided.host, path: provided.pathname, clientId: provided.searchParams.get("client_id"), redirectUri: provided.searchParams.get("redirect_uri"),
        state: Boolean(provided.searchParams.get("state")), responseType: provided.searchParams.get("response_type") } : null;
      if (facts && !facts.clientId) problems.push("no client_id");
      if (facts && !facts.redirectUri?.startsWith(`${PREVIEW_ORIGIN}/`)) problems.push(`redirect_uri ${facts.redirectUri}`);
      if (facts && !facts.state) problems.push("no state");
      flow.facts[provider] = { start: `${start.origin}${start.pathname}?next=${next}`, ...facts };
      if (provided) {
        const browser = await launchBrowser({ width: 1100, height: 800 });
        try { await browser.goto(location).catch(() => {}); await sleep(2500); await browser.screenshot(join(out, `provider-${provider}.png`)); } finally { await browser.close(); }
      }
      await flow.click("cancel");
      await flow.waitFor(`Boolean(document.querySelector('[data-funnel-provider="${provider}"]'))`, "back on the account step", 20_000);
      if (problems.length) throw new Error(problems.join("; "));
      return `${start.pathname}?next=${next} -> ${facts.host}${facts.path} client_id ${facts.clientId?.slice(0, 12)}…, redirect_uri ${facts.redirectUri}`;
    });
  }

  let link = null;
  await flow.step("magic-send", "email: a magic link goes out and the app waits for it", async () => {
    await flow.evaluate(`document.querySelector("input[type=email]").focus(); true`);
    await flow.type(email);
    const since = Date.now();
    mark("magic link asked", "app");
    await flow.click("email me a magic link");
    await flow.waitText(/check your email/i, "the waiting screen");
    link = await until(() => testMailLink(since), { timeout: 60_000, every: 1_000, what: "the magic link" });
    const code = (await gate("state()")).enrollment?.userCode;
    const url = new URL(link);
    const next = url.searchParams.get("next");
    flow.facts.magicLink = `${url.origin}${url.pathname}?attempt=<id>&next=${next}#code=<code>`;
    if (url.origin !== PREVIEW_ORIGIN || next !== `/cloud/desktop?code=${code}`) throw new Error(`the link goes to ${flow.facts.magicLink}, app code ${code}`);
    return flow.facts.magicLink;
  }, { critical: true });

  const browser = await launchBrowser({ width: 1280, height: 860 });
  flow.atClose(() => browser.close());
  const links = watchAppLinks(browser);
  flow.atClose(() => links.close());
  const web = (label) => browser.screenshot(join(out, `web-${label}.png`));

  await flow.step("magic-open", "the link signs in on the website and goes on to its name step", async () => {
    mark("magic link opened", "web");
    await browser.goto(link).catch(() => {});
    // the link fills the code in; one press signs in (a mail scanner opening the link signs nobody in)
    await until(async () => /your link is ready/i.test(await browser.text()), { timeout: 30_000, what: "the link's page" });
    await web("link-ready");
    await browser.click("sign in");
    await until(async () => /what should we call you|what.s your name/i.test(await browser.text()), { timeout: 60_000, what: "the website's name step" })
      .catch(async (error) => { await web("stuck"); throw new Error(`${error.message} (at ${await browser.url()}: ${(await browser.text()).replace(/\s+/g, " ").slice(0, 200)})`); });
    mark("website name step", "web");
    await web("name");
    return new URL(await browser.url()).pathname + new URL(await browser.url()).search;
  }, { critical: true });

  await flow.step("app-signed-in", "the app signs itself in and keeps going with its own first run", async (entry) => {
    await flow.waitFor(`window.duskDesktop.accountGate.state().then((s) => s.status === "connected")`, "the app signed in", 60_000);
    mark("app signed in", "app");
    await flow.waitFor(`document.querySelector("[data-welcome]")?.dataset.welcome !== "account"`, "the app past the account step", 20_000);
    await sleep(1500);
    entry.shot = await flow.shot("app-after-sign-in");
    const step = await at();
    const account = await flow.accountState();
    flow.facts.appAccount = { status: account?.status, email: account?.account?.email };
    return `app on "${step}", signed in as ${account?.account?.email}`;
  }, { critical: true });

  await flow.step("computer-on-account", "this computer appears on the account", async () => {
    const list = await until(() => browser.evaluate(`fetch("/v1/workspaces", { credentials: "same-origin" }).then((r) => r.json()).then((j) => (j.workspaces ?? []).length ? j.workspaces.map((w) => ({ kind: w.kind, name: w.name, status: w.status })) : false)`),
      { timeout: 90_000, every: 2_000, what: "a workspace on the account" });
    mark("computer on the account", "web");
    flow.facts.workspaces = list;
    return JSON.stringify(list).slice(0, 200);
  });

  await flow.step("web-name", "the website takes the name, then the plan step", async () => {
    await browser.evaluate(`(() => { const i = document.querySelector("#onb-name"); i.focus(); i.select(); return true; })()`);
    await browser.send("Input.insertText", { text: NAME });
    await browser.click("continue");
    await until(async () => /where should your bots live/i.test(await browser.text()), { timeout: 30_000, what: "the plan step" });
    mark("website plan step", "web");
    await web("plan");
    return "name saved, on the plan step";
  }, { critical: true });

  if (plan === "free") {
    await flow.step("web-free", "free ends on the pricing page, with a quiet open Metal and no automatic app link", async () => {
      await browser.evaluate(`document.querySelector("#home-free").click(); true`);
      await sleep(400);
      await browser.click("continue with free");
      await until(async () => /plans and billing/i.test(await browser.text()), { timeout: 30_000, what: "the pricing page" });
      mark("website pricing page", "web");
      await sleep(2500);
      await web("pricing");
      const href = await browser.evaluate(`document.querySelector("[data-open-app-link]")?.getAttribute("href") ?? null`);
      flow.facts.appLinksFromWeb = [...links.seen];
      if (links.seen.length) throw new Error(`the website opened the app by itself: ${links.seen.join(", ")}`);
      if (href !== "duskbot://open") throw new Error(`open Metal button: ${href}`);
      await browser.evaluate(`document.querySelector("[data-open-app-link]").click(); true`);
      await sleep(1500);
      return `on ${new URL(await browser.url()).pathname}, button ${href}, nothing opened until pressed (${links.seen.join(", ") || "headless: no handler"})`;
    });
  } else {
    let checkoutUrl = null;
    await flow.step("web-checkout", "a plan opens Dodo's test checkout", async () => {
      await browser.click("continue to checkout");
      checkoutUrl = await until(async () => { const url = await browser.url().catch(() => ""); return /checkout\.dodopayments\.com/.test(url) ? url : false; }, { timeout: 60_000, what: "Dodo's checkout" });
      if (!checkoutUrl.startsWith("https://test.")) throw new Error("not a test-mode checkout; refusing to pay");
      mark("checkout opened", "web");
      await sleep(2000);
      await web("checkout");
      return new URL(checkoutUrl).host;
    }, { critical: true });
    await flow.step("web-pay", "pays with the test card and comes back to the website", async () => {
      const paid = await payDodoTestCheckout(checkoutUrl, { browser, log: flow.log, shot: (label) => join(out, `pay-${label}.png`) });
      mark("paid", "web");
      await until(async () => /preview\.dusk\.bot/.test(await browser.url()), { timeout: 90_000, what: "back on the website" });
      await sleep(6000);
      await web("after-pay");
      flow.facts.afterPay = (await browser.url()).replace(/#.*$/, "");
      flow.facts.appLinksFromWeb = [...links.seen];
      if (links.seen.length) throw new Error(`the website opened the app by itself: ${links.seen.join(", ")}`);
      if (!new URL(flow.facts.afterPay).pathname.endsWith("/billing")) throw new Error(`ended on ${flow.facts.afterPay}, not the plan page`);
      const href = await until(() => browser.evaluate(`document.querySelector("[data-open-app-link]")?.getAttribute("href") ?? false`), { timeout: 30_000, what: "the open Metal button" });
      if (href !== "duskbot://cloud") throw new Error(`open Metal button: ${href}`);
      await browser.evaluate(`document.querySelector("[data-open-app-link]").click(); true`);
      await sleep(1500);
      return `${new URL(paid.url).host}, then ${flow.facts.afterPay} and stopped; button ${href}`;
    });
  }

  await flow.step("back-in-app", "open Metal from the website's button reaches the app, which comes forward where it was", async (entry) => {
    const sent = links.seen.at(-1);
    if (!sent) throw flow.skip("the website sent no app link");
    const before = await at();
    flow.app.openLink(sent);
    mark(`back in app (${sent})`, "app");
    await sleep(4000);
    entry.shot = await flow.shot("app-back");
    const after = await at();
    const sheet = await flow.evaluate(`[...document.querySelectorAll("[role=dialog]")].filter((d) => d.getClientRects().length).map((d) => d.innerText.replace(/\\s+/g, " ").slice(0, 120))`);
    flow.facts.backInApp = { link: sent, before, after, dialogs: sheet };
    if (sent === "duskbot://cloud" && !sheet.length) throw new Error(`no cloud sheet after ${sent} (welcome ${before} -> ${after})`);
    return `welcome ${before} -> ${after}; dialogs: ${sheet.join(" | ") || "none"}`;
  });

  await flow.step("name-in-app", "the name typed on the website shows in the app", async (entry) => {
    const found = await until(async () => {
      const account = await flow.accountState();
      const config = await flow.evaluate(`fetch("/api/config").then((r) => r.json()).then((c) => c.profile?.name ?? null)`);
      return account?.account?.name === NAME && config === NAME ? { account: account.account.name, config } : false;
    }, { timeout: 120_000, every: 2_000, what: `"${NAME}" in the app` }).catch(async () => ({
      account: (await flow.accountState())?.account?.name ?? null, config: await flow.evaluate(`fetch("/api/config").then((r) => r.json()).then((c) => c.profile?.name ?? null)`), missing: true }));
    flow.facts.nameInApp = found;
    entry.shot = await flow.shot("app-name");
    if (found.missing) throw new Error(`account name ${JSON.stringify(found.account)}, app profile name ${JSON.stringify(found.config)}`);
    mark("name in the app", "app");
    return `account ${found.account}, app profile ${found.config}`;
  });

  await flow.step("app-finish", "the app's own first run ends in the chat, the sidebar calling the person by that name", async (entry) => {
    const pressed = [];
    for (let tries = 0; tries < 40; tries++) {
      if (await flow.evaluate(`Boolean(document.querySelector('textarea[aria-label^="Message"]')) && !document.querySelector("[data-welcome]") && ![...document.querySelectorAll("[role=dialog]")].some((d) => d.getClientRects().length && !d.querySelector("[data-welcome]") && !d.matches("[data-welcome]"))`)) break;
      if (await flow.evaluate(`[...document.querySelectorAll("[role=dialog]")].some((d) => d.getClientRects().length && !d.querySelector("[data-welcome]") && !d.matches("[data-welcome]") && !d.closest("[data-welcome]"))`)) { await flow.escape(); pressed.push("escape"); await sleep(1000); continue; }
      const did = await flow.evaluate(`(() => {
        const shown = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && !e.disabled);
        const mac = shown("[data-funnel-place=mac]")[0]; if (mac) { mac.click(); return "this mac"; }
        for (const word of ["start with the free model", "set up later", "skip", "continue", "not now", "done"]) { const b = shown("button").find((e) => e.innerText.trim().toLowerCase() === word); if (b) { b.click(); return word; } }
        return null; })()`).catch(() => null);
      if (did) pressed.push(did);
      await sleep(1500);
    }
    mark("app first run done", "app");
    await sleep(2500);
    // the account button beside "connect apps": its menu names the person
    await flow.evaluate(`(() => { const shown = [...document.querySelectorAll("button")].filter((b) => b.getClientRects().length);
      const apps = shown.find((b) => /^connect apps/i.test(b.innerText.trim())); const box = apps?.getBoundingClientRect(); const account = box ? document.elementFromPoint(Math.max(4, box.left - 16), box.top + box.height / 2)?.closest("button,[role=button]") : null;
      account?.click(); return Boolean(account); })()`);
    await sleep(1500);
    const label = await flow.evaluate(`document.body.innerText.includes(${JSON.stringify(NAME)})`);
    entry.shot = await flow.shot("app-chat-with-name");
    if (!label) throw new Error(`"${NAME}" is not on screen after the first run (pressed ${pressed.join(", ")})`);
    return `pressed ${pressed.join(", ")}; "${NAME}" on screen`;
  });

  // the app sends its usage every 30 s; a run that sends analytics (DUSK_ANALYTICS=1) hands over what is still queued
  if (flow.app && process.env.DUSK_ANALYTICS !== "0") {
    await flow.evaluate(`import("/src/lib/product-analytics.ts").then((m) => m.flush()).then(() => true)`).catch(() => {});
    await sleep(8000);
  }
  flow.facts.timeline = timeline.map((row, i) => ({ ...row, sinceStart: Math.round((row.at - timeline[0].at) / 1000), sincePrev: i ? Math.round((row.at - timeline[i - 1].at) / 1000) : 0 }));
}, { keepProfile: flag("--keep-profile") });
