// A server's bots to dusk cloud from an app that is not signed in to its Metal account (the owner's report: the
// checkout sheet said "sign in on this Mac's own page first"). A fresh app that skips the account, its own server (a
// throwaway InstaBox machine, always deleted), the server's page, Get dusk cloud: the sign-in must open right there (the
// accounts sheet in the rail's view), and after it the checkout opens by itself, is paid in Dodo TEST mode, and the move
// follows. Sink addresses only.
//
//   node scripts/smoke/flows/server-to-cloud.mjs [--out DIR] [--profile DIR] [--email ADDRESS] [--no-pay] [--move-first]
import { join } from "node:path";
import { until } from "../app.mjs";
import { walkthrough } from "./recorder.mjs";
import { accountLinkFrom, webAccountStep } from "./web-account.mjs";
import { createFlow, flowArgs, runFlow, sleep, INSTALL_LINE, shellQuote } from "./lib.mjs";
import { createVm, leftoverVms, removeVm } from "./instabox-vm.mjs";

const { root, out, profile, email, stamp, flag } = flowArgs("s2c");
const moveFirst = flag("--move-first");
const flow = createFlow({ name: "server-to-cloud", title: "server to dusk cloud, signed out", root, out, profile, email, env: { DUSK_ALLOW_SIGNED_OUT: "1", DUSK_SMOKE_MENU_PICK: "workspace-cloud-move" } });

/** in the main window, as a person's click (user activation), awaiting the answer */
const act = async (expression) => {
  const r = await flow.app.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? "failed");
  return r.result?.value;
};

/** as a person does it on the server's page: the bot's name in the chat header opens its panel, the Computer tab's
 *  dusk cloud card opens "Move to dusk cloud", and its "Get dusk cloud" starts the buy */
async function getCloudFromPanel() {
  await flow.app.reattach(serverOrigin).catch(() => {});
  await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the server's chat", 60_000);
  await sleep(1500);
  await flow.clickSelector("[data-chathead-identity] button", 15_000);
  await flow.waitFor(`Boolean(document.querySelector("[data-panel-tabs]"))`, "the bot's panel", 15_000);
  await sleep(1200);
  await flow.clickSelector('[data-panel-tab="computer"]', 10_000);
  await flow.waitFor(`Boolean(document.querySelector('[data-panel-action="move-cloud"]'))`, "the panel's dusk cloud card", 15_000);
  await sleep(1500);
  await flow.clickSelector('[data-panel-action="move-cloud"]', 10_000);
  return buyFromSheet();
}

/** The Server menu (the sidebar's place button) with the rail gone: its Move "<server>" to dusk cloud row opens the move
 * sheet. The native popup can't be clicked headless, so the dev app picks that row by itself (DUSK_SMOKE_MENU_PICK). */
async function getCloudFromServerMenu() {
  await flow.app.reattach(serverOrigin).catch(() => {});
  await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the server's chat", 60_000);
  await sleep(1500);
  await flow.clickSelector('[data-tour="server-switcher"]', 15_000);
  walkthrough.did('opens the Server menu and picks Move to dusk cloud');
  return buyFromSheet();
}

async function buyFromSheet() {
  await flow.waitFor(`Boolean(document.querySelector('[data-cloud-move-action="buy"]'))`, "the move sheet's Get dusk cloud", 30_000);
  await sleep(2000);
  const label = await act(`(() => { const b = document.querySelector('[data-cloud-move-action="buy"]'); b.click(); return b.innerText.trim(); })()`);
  walkthrough.did(`clicks "${label}"`);
  // "buying" comes first; signed out, the sign-in in the browser (signingIn) follows it a moment later
  let last = null;
  return until(async () => { const v = last = await flow.evaluate(`window.duskDesktop.vpsCloudMove.view()`).catch(() => null); return v && (v.signingIn === true || !["none", "buying"].includes(v.stage)) ? v : false; }, { timeout: 20_000, what: "the move to start" })
    .catch(() => last);
}

let vm = null, serverOrigin = null;
await runFlow(flow, async () => {
  await flow.step("launch", "a fresh app, not signed in to an account", async () => {
    await flow.launch();
    await flow.waitText(/meet Metal|where should your bots live|sign in to Metal/i, "the welcome", { timeout: 120_000 });
    const state = await flow.accountState().catch(() => null);
    return `account: ${state?.status ?? "none"}`;
  }, { critical: true });

  let line = null;
  await flow.step("install-line", "skips the account, picks its own server; linking signs in in the browser, then the line comes", async () => {
    await flow.click("get started", { timeout: 10_000 }).catch(() => {});
    await sleep(1000);
    await flow.clickSelector("[data-funnel-account-skip]", 8_000).catch(() => {});
    await flow.waitText(/where should your bots live/i, "where should your bots live", { timeout: 30_000 });
    const since = Date.now();
    await flow.click("use your own server", { contains: true });
    // signed out: linking needs the account, so the sign-in continues in the browser and the line comes by itself after
    const signIn = await flow.waitFor(`Boolean(document.querySelector('[data-install-phase="sign-in"]'))`, "the sign-in state", 20_000).catch(() => false);
    if (signIn) {
      flow.facts.linkSignIn = (await flow.text('[data-install-phase="sign-in"]')).replace(/\s+/g, " ").slice(0, 200);
      await flow.shot("link-continue-in-browser");
      const link = await until(() => accountLinkFrom(flow.opened(since)), { timeout: 30_000, what: "the browser sign-in for linking" });
      const web = await webAccountStep(link, { email, log: flow.log, shot: (label) => join(out, `link-${label}.png`) });
      flow.facts.linkWeb = web.steps;
    } else flow.friction("confusing", "own server", "signed out, linking did not ask for the account in the browser");
    line = await flow.waitText(INSTALL_LINE, "the install line", { timeout: 90_000 });
    return signIn ? "continued in the browser, then the line came by itself" : "the line";
  }, { critical: true });

  await flow.step("server", "a throwaway server runs the line, and the app links it", async () => {
    for (const old of await leftoverVms()) if (Date.parse(old.createdAt ?? 0) < Date.now() - 60 * 60_000) await removeVm(old.id).catch(() => {});
    vm = await createVm(`dusk-smoke-s2c-${stamp.slice(5).replace(/[^0-9]/g, "")}`);
    flow.facts.vm = vm.id;
    const made = vm; flow.atClose(async () => { await made.remove(); flow.log(`deleted ${made.id}`); });
    await vm.exec(`cd ~ && setsid nohup bash -c ${shellQuote(`${line}; echo "exit $?" >> ~/dusk-install.log`)} > ~/dusk-install.log 2>&1 < /dev/null & echo started`, 30);
    const started = Date.now();
    for (;;) {
      const v = await flow.evaluate(`window.duskDesktop?.vpsLink?.state()`).catch(() => null);
      if (v && ["linked", "moving", "moved"].includes(v.stage)) break;
      const tail = (await vm.exec("tail -c 400 ~/dusk-install.log", 20).catch(() => ({ stdout: "" }))).stdout;
      if (/exit [1-9]/.test(tail) || /^curl: \(\d+\)/m.test(tail) && /exit 0\s*$/.test(tail)) throw new Error(`the install line failed: ${tail.replace(/\s+/g, " ").slice(-200)}`);
      if (Date.now() - started > 20 * 60_000) throw new Error(`the app never saw the server (stage ${v?.stage ?? "?"}; install log: ${tail.replace(/\s+/g, " ").slice(-300)})`);
      await sleep(10_000);
    }
    return `linked after ${Math.round((Date.now() - started) / 1000)}s`;
  }, { critical: true });

  await flow.step("sign-out", "signs out of the account (a server linked, the app signed out: the owner's case)", async () => {
    await flow.evaluate(`window.duskDesktop.cloudAccount.signOut()`);
    await flow.waitFor(`window.duskDesktop.cloudAccount.state().then((s) => !s.account)`, "signed out", 30_000);
  }, { critical: true });

  // --move-first: the bots go to the server first ("move everything here", as in add-server.mjs), so its page opens on
  // their chat, where a person who later wants dusk cloud finds it
  await flow.step("server-page", moveFirst ? "moves the bots to the server, which opens on their chat" : "opens the server's own page", async () => {
    await flow.waitText(/is connected/i, "the connected screen", { timeout: 60_000 });
    if (moveFirst) {
      await flow.click("sign in to your AI");
      await flow.waitFor(`Boolean(document.querySelector("[data-vps-screen]"))`, "the server sheet", 60_000);
      if (await flow.evaluate(`document.querySelector("[data-vps-screen]")?.getAttribute("data-vps-screen")`) === "signin") { await flow.click("skip for now"); await sleep(1500); }
      await flow.waitFor(`(() => { const b = [...document.querySelectorAll("button")].find((e) => /^move everything/i.test(e.innerText.trim())); return Boolean(b && !b.disabled); })()`, "the move button", 120_000);
      await sleep(1000);
      await flow.click("move everything here", { contains: true });
      await flow.waitFor(`(() => { const link = window.duskDesktop?.vpsLink; if (!link) return "on-server";
        return link.state().then((v) => v.stage === "moved" || (v.move?.status === "failed" ? "failed: " + (v.move?.error ?? v.move?.step) : false)); })()`, "the move to the server", 15 * 60_000);
    } else await until(() => flow.evaluate(`(() => { const b = [...document.querySelectorAll("[role=dialog] button, button")].filter((e) => e.getClientRects().length).find((e) => /^open \\S/i.test(e.innerText.trim())); if (!b) return false; b.click(); return true; })()`), { what: "open <server>" });
    const url = await until(async () => { const page = (await flow.app.targets()).find((t) => t.type === "page" && t.url.startsWith("https:") && !/\/rail/.test(t.url)); return page?.url; }, { timeout: 60_000, what: "the server's page" });
    serverOrigin = new URL(url).origin;
    await flow.app.reattach(serverOrigin);
    await flow.waitFor(`Boolean(window.duskDesktop?.vpsCloudMove)`, "the server page's move bridge", 60_000);
    return serverOrigin;
  }, { critical: true });

  let since = 0, web = null;
  await flow.step("get-cloud", "Get dusk cloud while signed out continues in the browser (no 'sign in on this Mac's page first')", async () => {
    since = Date.now();
    let answer;
    // the Server menu and the sheet, as a person does it with no rail; the bot panel's card next; the move's own call last
    try { answer = await getCloudFromServerMenu(); flow.facts.getCloudVia = "Server menu, move sheet"; }
    catch (menuError) {
      flow.friction("confusing", "get dusk cloud", `the walkthrough could not reach "Get dusk cloud" through the Server menu: ${menuError.message.slice(0, 160)}`);
      try { answer = await getCloudFromPanel(); flow.facts.getCloudVia = "bot panel, Computer tab, move sheet"; }
      catch (error) {
      flow.facts.getCloudVia = `the bridge (${error.message.slice(0, 120)})`;
      flow.friction("confusing", "get dusk cloud", `the walkthrough could not reach "Get dusk cloud" through the bot panel and the sheet: ${error.message.slice(0, 160)}`);
      try { answer = await act(`window.duskDesktop.vpsCloudMove.buy("plus")`); }
      catch (failed) { throw new Error(`the buy refused: ${failed.message}`); }
      }
    }
    flow.facts.afterBuy = answer;
    if (answer?.signingIn !== true) throw new Error(`the move did not wait in the browser: ${JSON.stringify(answer).slice(0, 160)}`);
    await sleep(1500);
    if (/own page|first, then come back/i.test(await flow.text())) throw new Error("the old 'sign in elsewhere first' error is back");
    return "continue in your browser";
  }, { critical: true });

  await flow.step("browser", "in the browser: sign up, approve, the plan's checkout, paid in test mode, you're all set", async () => {
    const link = await until(() => accountLinkFrom(flow.opened(since)), { timeout: 30_000, what: "the browser sign-in the app opened" });
    flow.facts.opened = link.replace(/code=[^&]+/, "code=<code>");
    web = await webAccountStep(link, { email, pay: !flag("--no-pay"), log: flow.log, shot: (label) => join(out, `${label}.png`) });
    if (!flag("--no-pay") && !web.allSet) flow.friction("confusing", "after paying", "the website did not show \"you're all set\" with the way back to the app");
    return web.steps.join("; ");
  }, { critical: true });

  await flow.step("app-signed-in", "the app signed itself in, without coming back to it", async () => {
    const view = await until(async () => { const v = await flow.evaluate(`window.duskDesktop.vpsCloudMove.view()`); return v && !v.signingIn ? v : false; }, { timeout: 60_000, what: "the app to pick up the sign-in" });
    return `move: ${view.stage}`;
  });

  if (flag("--no-pay")) return;
  await flow.step("move", "the server's bots move to the new cloud by themselves", async () => {
    const started = Date.now(), seen = new Set();
    for (;;) {
      const view = await flow.evaluate(`window.duskDesktop?.vpsCloudMove?.view()`).catch(() => null);
      const label = view ? `${view.stage}${view.phase ? `:${view.phase}` : ""}` : "page changed";
      if (!seen.has(label)) { seen.add(label); flow.log(`move: ${label}`); }
      if (view?.stage === "done" || label === "page changed" && seen.has("moving:copy")) break;
      if (view?.stage === "failed") throw new Error(`the move failed: ${view.error}`);
      if (Date.now() - started > 15 * 60_000) throw new Error(`no move after 15 minutes (${[...seen].join(" > ")})`);
      await sleep(5000);
    }
    flow.facts.moveSteps = [...seen];
    return `${Math.round((Date.now() - started) / 1000)}s: ${[...seen].join(" > ")}`;
  });

  await flow.step("cloud-chat", "opens dusk cloud: the moved bots and a chat there", async () => {
    const started = Date.now();
    for (;;) {
      const where = await flow.evaluate(`location.origin`).catch(() => "");
      if (!where) await flow.app.reattach().catch(() => {});
      const chat = await flow.evaluate(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`).catch(() => false);
      const welcome = await flow.evaluate(`/welcome to dusk cloud/i.test(document.body.innerText)`).catch(() => false);
      if (where && where !== serverOrigin && where.startsWith("https://") && chat && !welcome) break;
      const pressed = await flow.evaluate(`(() => {
        const shown = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && !e.disabled);
        for (const word of ["open dusk cloud", "start chatting", "open chat", "continue"]) { const b = shown("button").find((e) => e.innerText.trim().toLowerCase() === word); if (b) { b.click(); return b.innerText.trim(); } }
        return null; })()`).catch(() => null);
      if (pressed) { walkthrough.did(`clicks "${pressed}"`); flow.facts.pressedForCloud = [...(flow.facts.pressedForCloud ?? []), pressed]; }
      if (Date.now() - started > 6 * 60_000) throw new Error(`not on the cloud's chat after 6 minutes (window at ${where})`);
      await sleep(3000);
      if (where === serverOrigin || !where) await flow.app.reattach().catch(() => {});
    }
    flow.facts.cloudOrigin = await flow.evaluate(`location.origin`);
    await walkthrough.capture("app", "looks at the moved bots on dusk cloud");
    const asked = Date.now();
    const outcome = await flow.chatOk();
    if (outcome.startsWith("said:")) flow.friction("confusing", "the cloud's chat", `the first message on the cloud got: ${outcome.slice(5).replace(/\s+/g, " ").slice(0, 160)}`);
    return `${new URL(flow.facts.cloudOrigin).host}: ${outcome.replace(/\s+/g, " ")} in ${Math.round((Date.now() - asked) / 1000)}s`;
  });
});
