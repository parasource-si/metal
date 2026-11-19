// The account steps of the desktop app, each as a person meets it (the account context redirect): a fresh app that is
// not signed in (DUSK_ALLOW_SIGNED_OUT=1). Settings' "sign in to your cloud plan" and the You menu's "sign in" continue
// in the browser (one calm sheet in the app, the website's sign-up and approval), and the app signs itself in with no
// trip back; signed in, billing opens straight on the website with no second sign-in. Sink addresses only.
//
//   node scripts/smoke/flows/account-entry.mjs [--out DIR] [--profile DIR] [--email ADDRESS]
import { join } from "node:path";
import { until } from "../app.mjs";
import { createFlow, flowArgs, runFlow, sleep } from "./lib.mjs";
import { accountLinkFrom, webAccountStep } from "./web-account.mjs";
import { walkthrough } from "./recorder.mjs";

const { root, out, profile, email } = flowArgs("acct");
const flow = createFlow({ name: "account-entry", title: "account steps continue in the browser", root, out, profile, email, env: { DUSK_ALLOW_SIGNED_OUT: "1" } });
/** the You menu: the account button beside "connect apps" in the sidebar */
const openAccountMenu = () => until(() => flow.evaluate(`(() => {
  const shown = [...document.querySelectorAll("button")].filter((b) => b.getClientRects().length);
  const apps = shown.find((b) => /^connect apps/i.test(b.innerText.trim()));
  const account = apps?.parentElement?.querySelector("button:not(:last-child)") ?? shown.find((b) => /^[a-z]$/i.test(b.innerText.trim()));
  if (!account) return false; account.click(); return true;
})()`), { what: "the account button" }).then(() => walkthrough.did("clicks the account button (bottom left)"));
const signedIn = () => flow.evaluate(`window.duskDesktop.cloudAccount.state().then((s) => Boolean(s.account) && s.status === "connected")`);

async function browserHalf(since, label) {
  const link = await until(() => accountLinkFrom(flow.opened(since)), { timeout: 30_000, what: `the browser page for ${label}` });
  const web = await webAccountStep(link, { email, log: flow.log, shot: (name) => join(out, `${label}-${name}.png`) });
  return { link, web };
}

await runFlow(flow, async () => {
  await flow.step("launch", "a fresh app, not signed in, gets into the app", async () => {
    await flow.launch();
    await flow.waitText(/meet Metal|where should your bots live/i, "the welcome", { timeout: 120_000 });
    // past the welcome without an account: the welcome is not what this flow checks (and it is being redesigned)
    await flow.evaluate(`fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarding: { completedAt: new Date().toISOString(), version: 1 } }) }).then((r) => r.status)`);
    await flow.evaluate(`location.reload(); true`).catch(() => {});
    await sleep(4000);
    await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the chat", 60_000);
    if (await signedIn()) throw new Error("the app is already signed in");
  }, { critical: true });

  await flow.step("menu-signed-out", "the account menu, before signing in", async () => {
    await openAccountMenu();
    await sleep(1500);
    await walkthrough.capture("app");
    const rows = (await flow.evaluate(`[...document.querySelectorAll("[role=menu] [role=menuitem], [role=menu] button, [role=dialog] button")].filter((e) => e.getClientRects().length).map((e) => e.innerText.trim()).filter(Boolean)`)).slice(0, 12);
    await flow.escape();
    await sleep(800);
    return rows.join(", ");
  });

  await flow.step("settings-sign-in", "Settings' sign in continues in the browser; the app signs itself in", async () => {
    const since = Date.now();
    await flow.openSettings();
    await flow.clickSelector('[data-settings-open="sign-in"]');
    const shown = await flow.waitFor(`document.querySelector("[data-continue-in-browser]")?.innerText ?? false`, "the continue-in-browser sheet", 20_000);
    flow.facts.sheet = shown.replace(/\s+/g, " ").slice(0, 200);
    await flow.shot("continue-sheet");
    const { web } = await browserHalf(since, "settings");
    await flow.waitFor(`window.duskDesktop.cloudAccount.state().then((s) => Boolean(s.account) && s.status === "connected")`, "the app signed in", 60_000);
    await flow.waitFor(`!document.querySelector("[data-continue-in-browser]")`, "the sheet to close by itself", 20_000);
    return web.steps.join("; ");
  });

  await flow.step("billing", "signed in, billing opens on the website with no second sign-in", async () => {
    const since = Date.now();
    const answer = await flow.app.send("Runtime.evaluate", { expression: `window.duskDesktop.cloudAccount.continueInBrowser({ kind: "billing" })`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (answer.result?.value?.outcome !== "opened") throw new Error(`billing answered ${JSON.stringify(answer.result?.value).slice(0, 120)}`);
    const opened = await until(() => flow.opened(since).find((url) => /preview\.dusk\.bot/.test(url)), { timeout: 20_000, what: "the billing page" });
    if (/cloud\/desktop\?code=/.test(opened)) throw new Error("signed in, yet the app asked to sign in again");
    const { web } = await browserHalf(since, "billing");
    if (!/\/billing/.test(web.landed)) throw new Error(`landed on ${web.landed}`);
    return web.steps.join("; ");
  });

  await flow.step("account-card", "signed in: Settings shows the account card", async () => {
    await flow.openSettings();
    await sleep(1500);
    await walkthrough.capture("app");
    const card = (await flow.text("[role=dialog]")).replace(/\s+/g, " ").slice(0, 200);
    await flow.escape();
    await sleep(600);
    await openAccountMenu();
    await sleep(1500);
    await walkthrough.capture("app");
    await flow.escape();
    await sleep(600);
    return card;
  });

  await flow.step("menu-sign-in", "signed out again, the You menu's sign in continues in the browser too", async () => {
    await flow.evaluate(`window.duskDesktop.cloudAccount.signOut()`);
    await flow.waitFor(`window.duskDesktop.cloudAccount.state().then((s) => !s.account)`, "signed out", 30_000);
    await flow.escape().catch(() => {});
    const since = Date.now();
    // the You menu: the account button, then its sign in row
    await openAccountMenu();
    await flow.click("sign in", { contains: false });
    await flow.waitFor(`Boolean(document.querySelector("[data-continue-in-browser]"))`, "the continue-in-browser sheet", 20_000);
    const { web } = await browserHalf(since, "menu");
    await flow.waitFor(`window.duskDesktop.cloudAccount.state().then((s) => Boolean(s.account) && s.status === "connected")`, "the app signed in", 60_000);
    return web.steps.join("; ");
  });
});
