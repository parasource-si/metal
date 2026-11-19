// Onboarding as a brand-new person: a fresh profile and a fresh Metal account on preview (a *@qa.dusk.test sink
// address), the app's account gate, then the welcome funnel down one path, end to end:
//   mac:    this Mac's sheet, an AI (the free model), notes from another AI, then the first bot's first reply
//   cloud:  dusk cloud goes straight to the browser (the account intent's one-time handoff to the plans page), a plan,
//           Dodo's TEST-mode checkout paid with the test card, the app noticing by itself, the AI while the cloud is
//           made, the cloud's chat and a bot's reply on it. The trial's renewal is cancelled at the end (--keep skips it).
//   server: the install line (add-server.mjs runs a real server)
// Every funnel screen is shot at the app's normal window (1040x760) and its minimum (768x520) into <out>/steps/.
// With --root pointing at an older checkout the same script shoots that checkout's funnel ("before" shots); a path the
// older funnel doesn't have stops with a note.
//
// --tour (the walkthrough) also opens an AI's card and the full list of AIs on the way, as a curious person would.
//
//   node scripts/smoke/flows/onboarding.mjs [--path mac|cloud|server] [--out DIR] [--profile DIR] [--email ADDRESS] [--keep] [--no-pay] [--tour]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "../app.mjs";
import { smokeAccount, testMailCode } from "../account.mjs";
import { payDodoTestCheckout } from "../dodo-test-pay.mjs";
import { launchBrowser } from "./browser.mjs";
import { createFlow, flowArgs, runFlow, sleep, INSTALL_LINE } from "./lib.mjs";
import { walkthrough } from "./recorder.mjs";

const { option, flag, root, out, profile, email } = flowArgs("onb");
const path = option("--path", "mac");
if (!["mac", "cloud", "server"].includes(path)) throw new Error("--path is mac, cloud or server");
// signed out, as the installed app starts now; --gate starts at the sign-in an install can still require (DUSK_REQUIRE_ACCOUNT)
const gate = flag("--gate");
const flow = createFlow({ name: `onboarding-${path}`, title: `onboarding (${path === "mac" ? "this Mac" : path === "cloud" ? "dusk cloud" : "own server"}, ${gate ? "signed in at the gate" : "signed out"})`,
  root, out, profile, email, env: gate ? { DUSK_REQUIRE_ACCOUNT: "1" } : {} });

/** the app's main window sizes (electron/window-state.cjs): the default and the smallest it can be */
const SIZES = walkthrough.enabled ? [["normal", 1040, 760]] : [["normal", 1040, 760], ["min", 768, 520]];
const stepsDir = join(out, "steps");
mkdirSync(stepsDir, { recursive: true });
let shotCount = 0;
/** the screen at both window sizes, as steps/NN-<label>-<size>.png; back at the normal size after */
async function shots(label) {
  const n = String(++shotCount).padStart(2, "0"), files = [];
  // the app's own "connecting to your bots" cover fades out after a sign-in; the screen under it is the one to shoot
  await flow.waitFor(`!/connecting to your bots/i.test(document.body.innerText)`, "the connecting cover to go", 20_000).catch(() => {});
  await sleep(400);
  for (const [size, width, height] of SIZES) {
    await flow.viewport(width, height);
    await sleep(450);
    const file = join(stepsDir, `${n}-${label}-${size}.png`);
    try { await flow.app.screenshot(file); files.push(file); } catch {}
    const overflow = await flow.evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`).catch(() => false);
    if (overflow) flow.friction("broken", label, `the page scrolls sideways at ${width}x${height}`);
  }
  await flow.viewport(SIZES[0][1], SIZES[0][2]);
  flow.facts.shots = [...(flow.facts.shots ?? []), ...files.map((file) => file.split("/").pop())];
  return files;
}
const at = () => flow.evaluate(`document.querySelector("[data-welcome]")?.dataset.welcome ?? null`);
const funnelText = () => flow.evaluate(`(() => { const all = [...document.querySelectorAll("h1,h2")].filter((h) => h.getClientRects().length).map((h) => h.innerText.trim()); return all.join(" / "); })()`);

/** the notes another AI writes when the funnel's prompt is pasted there, as dusk-bot-notes.json in Downloads */
const NOTES = {
  format: "dusk-bot-notes", version: 2, from: "ChatGPT",
  about_me: { basics: ["Sam Rivera, lives in Lisbon, time zone Europe/Lisbon"], work: ["Runs a two-person bakery called Forno"], projects: ["A second shop in Porto, March 2027"],
    goals: ["Wholesale to 40 cafes"], people: ["Ana, business partner"], preferences: ["Short answers"], writing_style: ["Plain and friendly"], tools: ["Gmail", "Google Sheets"], schedule: ["Starts at 5am"] },
  instructions: "Keep it short. Use euros.", memories: ["Sam sends invoices on Fridays"], open_threads: ["Pick a Porto landlord"], recurring_tasks: [], connected_apps: ["Gmail"],
  bots: [{ name: "Ledger", description: "Tracks wholesale invoices", instructions: "You track Forno's wholesale invoices. Remind Sam on Fridays to send them.", knowledge_files: [], memories: ["40 cafe goal"], skills: [], routines: [], apps: [] }],
};

/** sends a line in the open chat and waits for a bot's "ok" after it: the first useful reply */
async function firstReply(where) {
  const marker = `smoke ${Date.now().toString(36)}`;
  await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the chat box", 60_000);
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
  if (outcome.startsWith("error:")) throw new Error(`the bot answered with an error on ${where}: ${outcome.slice(6)}`);
  if (outcome.startsWith("card:")) {
    if (flow.facts.replySeconds > 30) throw new Error(`the Connect your AI card took ${flow.facts.replySeconds}s on ${where} (expected within ~30 s)`);
    return `no AI connected: the Connect your AI card in ${flow.facts.replySeconds}s`;
  }
  return `replied "${outcome.slice(6).replace(/\s+/g, " ")}" in ${flow.facts.replySeconds}s`;
}

await runFlow(flow, async () => {
  const funnelStarted = { at: 0 };
  await flow.step("launch", gate ? "a fresh app starts at the account gate" : "a fresh app starts on where the bots live, with no account", async () => {
    await flow.launch();
    await flow.viewport(SIZES[0][1], SIZES[0][2]);
    if (!gate) {
      await flow.waitText(/where should your bots live|meet Metal|sign in to Metal/i, "the first screen", { timeout: 120_000 });
      if (/sign in to Metal/i.test(await flow.text())) throw new Error("the app asked for an account before anything else");
      return `account: ${(await flow.accountState().catch(() => null))?.status ?? "none"}`;
    }
    await flow.waitText(/sign in to Metal/i, "the account gate", { timeout: 120_000 });
    await shots("account-gate");
    const providers = await flow.evaluate(`[...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /^continue with/i.test(t))`);
    flow.facts.gateProviders = providers;
    return providers.join(", ");
  }, { critical: true });

  if (gate) await flow.step("sign-in", "signs in with an emailed code (sink address)", () => flow.signInAtGate(), { critical: true });

  await flow.step("place", "the first screen asks where the bots live", async () => {
    await flow.waitText(/meet Metal|where should your bots live/i, "the welcome", { timeout: 60_000 });
    funnelStarted.at = Date.now();
    if (await flow.evaluate(`Boolean([...document.querySelectorAll("button")].find((b) => /^get started$/i.test(b.innerText.trim()) && b.getClientRects().length))`)) {
      flow.facts.helloScreen = true;
      await shots("welcome");
      await flow.click("get started");
    }
    await flow.waitText(/where should your bots live/i, "where should your bots live");
    await shots("place");
    const tile = await flow.evaluate(`document.querySelector("[data-funnel-place=cloud]")?.innerText.replace(/\\s+/g, " ") ?? ""`);
    flow.facts.cloudTile = tile;
    if (!/\$|free/i.test(tile)) flow.friction("confusing", "place", "dusk cloud's tile says no price or trial");
    return `${await funnelText()} | cloud tile: ${tile}`;
  }, { critical: true });

  if (path === "server") {
    await flow.step("pick-server", "your own server shows the install line", async () => {
      await flow.click("use your own server", { contains: true });
      const line = await flow.waitText(INSTALL_LINE, "the install line", { timeout: 45_000 });
      flow.facts.installLine = line.replace(/\/i\/[a-z0-9-]+/, "/i/<code>");
      await shots("server-line");
      return "the one line is ready";
    });
    return;
  }

  if (path === "cloud") {
    let handoff = null;
    await flow.step("pick-cloud", "dusk cloud goes straight to the browser and waits calmly beside it", async () => {
      const since = Date.now();
      await flow.clickSelector("[data-funnel-place=cloud]");
      await sleep(2500);
      if ((await at()) !== "checkout") {
        // an older funnel: its own buying sheet over the funnel
        await shots("cloud-sheet");
        flow.facts.cloudSheet = (await flow.text("[role=dialog]")).replace(/\s+/g, " ").slice(0, 300);
        throw flow.skip(`this checkout's funnel opens a sheet instead of the browser: ${flow.facts.cloudSheet.slice(0, 120)}`);
      }
      handoff = await until(() => flow.opened(since).find((url) => url.startsWith("https://")) ?? null, { timeout: 30_000, what: "the browser to open" });
      flow.facts.browserOpened = handoff.replace(/#.*$/, "#<token>");
      await shots("checkout-waiting");
      flow.facts.waitingScreen = (await flow.text("[data-welcome]")).replace(/\s+/g, " ").slice(0, 300);
      return `opened ${new URL(handoff).host}${new URL(handoff).pathname}; the app says: ${flow.facts.waitingScreen.slice(0, 140)}`;
    }, { critical: true });
    if (!handoff) return;

    let checkoutUrl = null;
    await flow.step("plans", "the browser lands on the plans signed in; a plan opens Dodo's test checkout", async () => {
      const browser = await launchBrowser({ width: 1280, height: 860 });
      try {
        await browser.goto(handoff).catch(() => {});
        // signed out, the app opened its browser sign-in: the website signs up with the emailed code (sink), the person
        // approves this app, and the page goes on to the plans by itself
        if (/\/cloud\/desktop/.test(handoff)) {
          await until(() => browser.evaluate(`Boolean(document.querySelector("input[type=email]"))`), { timeout: 30_000, what: "the website's sign-in" });
          await browser.screenshot(join(out, "browser-0-sign-up.png"));
          await browser.evaluate(`document.querySelector("input[type=email]").focus(); true`);
          await browser.send("Input.insertText", { text: email });
          const asked = Date.now();
          // the email form's own submit ("continue"; the provider buttons also start with "continue with")
          await browser.evaluate(`document.querySelector("input[type=email]").form.requestSubmit(); true`);
          const code = await until(() => testMailCode(email, asked), { timeout: 60_000, every: 1_000, what: "the website's sign-in code" });
          await until(() => browser.evaluate(`Boolean(document.querySelector("input[inputmode=numeric]"))`), { what: "the code field" });
          await browser.evaluate(`document.querySelector("input[inputmode=numeric]").focus(); true`);
          await browser.send("Input.insertText", { text: code });
          await browser.evaluate(`document.querySelector("form")?.requestSubmit(); true`).catch(() => {});
          await until(async () => /approve/i.test(await browser.text()), { timeout: 30_000, what: "the app's approval" });
          await browser.screenshot(join(out, "browser-0-approve.png"));
          await browser.click("approve");
        }
        // a browser that isn't signed in yet confirms the account the app opened the page for
        const confirm = await until(async () => /continue as/i.test(await browser.text()) ? "confirm" : /\/billing/.test(await browser.url()) ? "billing" : false, { timeout: 30_000, what: "the handoff page" }).catch(() => null);
        if (confirm === "confirm") {
          await browser.screenshot(join(out, "browser-0-confirm.png"));
          flow.friction("extra-click", "browser handoff", "a fresh browser asks \"continue as <email>?\" before the plans");
          await browser.click("continue");
        }
        await until(async () => /\/billing/.test(await browser.url()) && /get |checkout|plan/i.test(await browser.text()), { timeout: 60_000, what: "the plans page" })
          .catch(async (error) => {
            await browser.screenshot(join(out, "browser-0-stuck.png")).catch(() => {});
            throw new Error(`${error.message} (at ${(await browser.url().catch(() => "?")).replace(/#.*$/, "")}: ${(await browser.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160)})`);
          });
        await browser.screenshot(join(out, "browser-1-plans.png"));
        flow.facts.landedOn = new URL(await browser.url()).pathname + new URL(await browser.url()).search;
        // the plan the page itself recommends first, else the first one to get
        await browser.click("get ");
        await until(() => browser.evaluate(`Boolean([...document.querySelectorAll("button")].find((b) => /^checkout$/i.test(b.innerText.trim()) && !b.disabled))`), { timeout: 30_000, what: "the plan sheet's checkout" });
        await browser.screenshot(join(out, "browser-2-plan-sheet.png"));
        await browser.click("checkout");
        checkoutUrl = await until(async () => { const url = await browser.url().catch(() => ""); return /checkout\.dodopayments\.com/.test(url) ? url : false; }, { timeout: 60_000, what: "Dodo's checkout" });
      } finally { await browser.close(); }
      if (!checkoutUrl.startsWith("https://test.")) throw new Error("the checkout is not in test mode; refusing to pay");
      return `landed on ${flow.facts.landedOn}; checkout on ${new URL(checkoutUrl).host}`;
    }, { critical: true });

    if (flag("--no-pay")) return;
    await flow.step("pay", "pays with the test card", async () => {
      let n = 0;
      const result = await payDodoTestCheckout(checkoutUrl, { log: flow.log, shot: (label) => join(out, `pay-${++n}-${label}.png`) });
      flow.atClose(async () => {
        if (flag("--keep")) return;
        // the trial's renewal off, so the test cloud ends with its trial (the window is on the cloud by now, so the
        // account is asked directly, signed in again with a code from the sink)
        mkdirSync(join(out, "account"), { recursive: true });
        const { client } = await smokeAccount({ root, profile: join(out, "account"), email, force: true });
        await client.refresh();
        flow.log(`cancel the trial's renewal: ${(await client.cancelPlan(null)).outcome}`);
      });
      return `paid; ended at ${new URL(result.url).pathname}`;
    }, { critical: true });

    await flow.step("noticed", "the app notices the payment by itself and goes on to the AI", async () => {
      const started = Date.now();
      await flow.waitFor(`document.querySelector("[data-welcome]")?.dataset.welcome === "ai"`, "the AI step after paying", 5 * 60_000);
      flow.facts.noticedSeconds = Math.round((Date.now() - started) / 1000);
      if (flow.facts.noticedSeconds > 30) flow.friction("slow", "after paying", `the app took ${flow.facts.noticedSeconds}s to notice the payment`);
      await shots("ai-while-cloud");
      await flow.click("start with the free model", { timeout: 10_000 }).catch(() => flow.click("set up later"));
      return `${flow.facts.noticedSeconds}s after paying`;
    }, { critical: true });

    await flow.step("making", "the cloud being made, then its chat by itself", async () => {
      await flow.waitFor(`document.querySelector("[data-welcome]")?.dataset.welcome === "making" || !document.querySelector("[data-welcome]")`, "the cloud being made", 30_000);
      if (await at()) await shots("making");
      const cloud = await until(() => flow.evaluate(`window.duskDesktop?.cloudAccount?.state().then((s) => (s.clouds ?? []).find((c) => c.status === "ready") ?? false)`).catch(() => false), { timeout: 15 * 60_000, every: 5000, what: "the cloud to be ready" });
      const host = new URL(cloud.origin).host;
      const started = Date.now();
      for (;;) {
        const where = await flow.evaluate(`location.host`).catch(() => "");
        if (where === host) { await flow.app.reattach(`https://${host}`).catch(() => {}); }
        const chat = await flow.evaluate(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`).catch(() => false);
        const welcome = await flow.evaluate(`/welcome to dusk cloud/i.test(document.body.innerText)`).catch(() => false);
        if (where === host && chat && !welcome) break;
        const pressed = await flow.evaluate(`(() => {
          const shown = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && !e.disabled);
          const move = shown("[data-cloud-move-accept]")[0]; if (move) { move.click(); return "move"; }
          for (const word of ["start chatting", "open dusk cloud", "open chat", "start with the free model", "continue"]) { const b = shown("button").find((e) => e.innerText.trim().toLowerCase() === word); if (b) { b.click(); return word; } }
          return null; })()`).catch(() => null);
        if (pressed) flow.facts.pressedOnCloud = [...(flow.facts.pressedOnCloud ?? []), pressed];
        if (Date.now() - started > 10 * 60_000) throw new Error(`not on the cloud's chat after 10 minutes (window at ${where})`);
        await sleep(3000);
      }
      flow.facts.funnelSeconds = Math.round((Date.now() - funnelStarted.at) / 1000);
      await shots("cloud-chat");
      return `on ${host}; pressed ${JSON.stringify(flow.facts.pressedOnCloud ?? [])}`;
    }, { critical: true });

    await flow.step("first-reply", "a bot on the new cloud answers", () => firstReply("the cloud"));
    return;
  }

  await flow.step("pick-mac", "this Mac goes straight on to connect an AI", async () => {
    await flow.clickSelector("[data-funnel-place=mac]");
    await flow.waitText(/connect an AI/i, "connect an AI");
    await shots("ai");
    return await funnelText();
  }, { critical: true });

  if (flag("--tour")) await flow.step("ai-cards", "looks at an AI's card and the full list of AIs, then comes back", async () => {
    const card = await flow.evaluate(`(() => { const b = [...document.querySelectorAll("button[data-funnel-ai]")].find((e) => e.getClientRects().length); if (!b) return null; b.click(); return b.getAttribute("data-funnel-ai"); })()`);
    if (!card) throw flow.skip("no AI cards on this screen");
    walkthrough.did(`clicks the ${card} card`);
    await sleep(2000);
    await walkthrough.capture("app");
    const more = await flow.clickSelector("[data-ai-more]", 5_000).then(() => true, () => false);
    if (more) {
      await flow.waitFor(`Boolean(document.querySelector("[data-connect-ai]"))`, "the list of AIs", 10_000).catch(() => {});
      await sleep(1500);
      await walkthrough.capture("app");
      await flow.escape();
      await sleep(1000);
    }
    // back to no card picked, as before
    await flow.evaluate(`document.querySelector('button[data-funnel-ai][aria-pressed="true"]')?.click(); true`);
    await sleep(800);
    return `opened ${card}${more ? " and the full list" : ""}`;
  });

  await flow.step("ai-free", "starts with the free model", async () => {
    await flow.click("start with the free model", { timeout: 10_000 }).catch(() => flow.click("set up later"));
    await flow.waitText(/bring what you already use|bring your bots/i, "the import step", { timeout: 30_000 });
    await shots("bring");
    return await funnelText();
  });

  await flow.step("import", "brings notes from another AI in by itself", async () => {
    const since = Date.now();
    await flow.click("copy the prompt");
    await sleep(800);
    // what the other AI does with the prompt: a file in Downloads
    mkdirSync(join(profile, "home", "Downloads"), { recursive: true });
    await sleep(1500);
    writeFileSync(join(profile, "home", "Downloads", "dusk-bot-notes.json"), JSON.stringify(NOTES, null, 2));
    flow.facts.notesWrittenAfterMs = Date.now() - since;
    await flow.click("continue");
    return "prompt copied, notes saved to Downloads";
  });

  await flow.step("phone", "the phone step (skipped) or straight on", async () => {
    await sleep(1500);
    if (/Metal on your phone/i.test(await flow.text())) {
      flow.friction("extra-click", "phone step", "a phone QR step in the first run before the person has used a bot");
      await flow.click("skip");
      return "skipped";
    }
    return "no phone step";
  });

  await flow.step("first-bot", "lands in the app with the imported bot", async () => {
    await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the chat", 60_000);
    flow.facts.funnelSeconds = Math.round((Date.now() - funnelStarted.at) / 1000);
    await shots("chat");
    const started = Date.now();
    // the dev app's server is not the desktop's own child, so it refuses to read Downloads (a packaged build does);
    // there the person pastes the other AI's answer into the chat instead, which is what happens here
    const look = await flow.evaluate(`fetch("/api/setup-import/notes?since=1").then((r) => r.status)`);
    if (look === 403) {
      flow.facts.notesVia = "paste (the dev app cannot read Downloads)";
      await sleep(6000);
      await flow.evaluate(`(() => { const box = document.querySelector('textarea[aria-label^="Message"]'); box.focus();
        const data = new DataTransfer(); data.setData("text/plain", ${JSON.stringify(JSON.stringify(NOTES, null, 2))});
        box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); return true; })()`);
    } else flow.facts.notesVia = "Downloads";
    const names = await flow.waitFor(`fetch("/api/bots").then((r) => r.json()).then((j) => { const names = (j.bots ?? j).map((b) => b.name); return names.includes("Ledger") ? names : false; })`, "the imported bot Ledger", 120_000)
      .catch(async () => {
        throw new Error(`no imported bot after 2 minutes (bots: ${JSON.stringify(await flow.evaluate(`fetch("/api/bots").then((r) => r.json()).then((j) => (j.bots ?? j).map((b) => b.name))`))})`);
      });
    flow.facts.importSeconds = Math.round((Date.now() - started) / 1000);
    if (flow.facts.importSeconds > 20) flow.friction("slow", "import", `the notes took ${flow.facts.importSeconds}s to show up after the funnel ended`);
    return `bots: ${names.join(", ")}`;
  });

  await flow.step("first-reply", "the first bot answers on this Mac", async () => {
    await flow.click("Dusk", { contains: true, scope: "nav, aside, body" }).catch(() => {});
    await sleep(1000);
    return firstReply("this Mac");
  });

  await flow.step("account-menu", gate ? "the account menu knows who is signed in" : "nothing asked for an account on this Mac", async () => {
    const state = await flow.accountState();
    flow.facts.account = { status: state?.status, email: state?.account?.email, plan: state?.entitlement?.plan };
    if (gate && state?.status !== "connected") throw new Error(`the app's account is ${state?.status}`);
    if (!gate && state?.status === "connected") throw new Error("the app signed in although nothing needed an account");
    return gate ? `${state.account.email}, ${state.entitlement?.plan ?? "no"} plan` : `account: ${state?.status ?? "none"}; the bots worked without one`;
  });
});
