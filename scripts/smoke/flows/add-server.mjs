// Your own server, as a new person does it: a fresh account at the app's gate, the welcome's "use your own server", the
// one install line pasted into a real Linux server (a throwaway InstaBox machine, deleted at the end whatever happens),
// the app noticing the server by itself, sign-in skipped, "move everything here", and the app working from the server.
//
// --signed-out starts as a new person does now: no account, "use your own server" asks for one in the browser (the
// website's sign-up and approval), and the line comes by itself after. It ends with a chat on the server.
//
//   node scripts/smoke/flows/add-server.mjs [--out DIR] [--profile DIR] [--email ADDRESS] [--keep-vm] [--signed-out]
import { join } from "node:path";
import { until } from "../app.mjs";
import { createFlow, flowArgs, runFlow, sleep, INSTALL_LINE, shellQuote } from "./lib.mjs";
import { createVm, leftoverVms, removeVm } from "./instabox-vm.mjs";
import { walkthrough } from "./recorder.mjs";
import { accountLinkFrom, webAccountStep } from "./web-account.mjs";

const { root, out, profile, email, stamp, flag } = flowArgs("srv");
const signedOut = flag("--signed-out");
// the app works signed out now; without --signed-out this flow starts from a signed-in account, at the sign-in an install can still require
const flow = createFlow({ name: "add-server", title: `add your own server${signedOut ? ", signed out" : ""}`, root, out, profile, email, env: signedOut ? {} : { DUSK_REQUIRE_ACCOUNT: "1" } });
const view = () => flow.evaluate(`window.duskDesktop?.vpsLink?.state()`);
const screen = () => flow.evaluate(`document.querySelector("[data-vps-screen]")?.getAttribute("data-vps-screen") ?? null`);
let vm = null;

await runFlow(flow, async () => {
  try {
    await flow.step("launch", signedOut ? "a fresh app, no account" : "a fresh app starts at the account gate", async () => {
      await flow.launch();
      await flow.waitText(signedOut ? /meet Metal|where should your bots live/i : /sign in to Metal/i, signedOut ? "the welcome" : "the account gate", { timeout: 120_000 });
    }, { critical: true });

    if (!signedOut) await flow.step("sign-in", "signs in with an emailed code", () => flow.signInAtGate(), { critical: true });

    let line = null;
    await flow.step("install-line", "\"use your own server\" shows the one install line", async () => {
      await flow.waitText(/meet Metal|where should your bots live/i, "the welcome", { timeout: 60_000 });
      await flow.click("get started", { timeout: 10_000 }).catch(() => {});
      await flow.waitText(/where should your bots live/i, "where should your bots live");
      const started = Date.now();
      if (signedOut) await flow.clickSelector("[data-funnel-account-skip]", 5_000).catch(() => {});
      await flow.click("use your own server", { contains: true });
      // a chooser of ways to connect comes first; a new person takes the recommended one
      const chooser = await flow.waitText(/how should it connect/i, "the connect chooser", { timeout: 8_000 }).catch(() => null);
      if (chooser) {
        flow.facts.connectChoices = await flow.evaluate(`[...document.querySelectorAll("[role=dialog] button")].map((b) => b.innerText.split("\\n")[0].trim()).filter((t) => t && !/^back$|^close$/i.test(t))`);
        flow.friction("confusing", "own server", `before any line, "how should it connect?" asks a new person to pick among ${flow.facts.connectChoices.length} ways (${flow.facts.connectChoices.join(", ")})`);
        await flow.shot("connect-chooser");
        await flow.click("cloudflare tunnel", { contains: true });
      }
      // signed out: linking needs the account, so the sign-in continues in the browser and the line comes by itself after
      if (signedOut) {
        const signIn = await flow.waitFor(`Boolean(document.querySelector('[data-install-phase="sign-in"]'))`, "the sign-in state", 20_000).catch(() => false);
        if (signIn) {
          const link = await until(() => accountLinkFrom(flow.opened(started)), { timeout: 30_000, what: "the browser sign-in for linking" });
          const web = await webAccountStep(link, { email, log: flow.log, shot: (label) => join(out, `link-${label}.png`) });
          flow.facts.linkWeb = web.steps;
        }
      }
      line = await flow.waitText(INSTALL_LINE, "the install line", { timeout: signedOut ? 90_000 : 45_000 });
      flow.facts.lineSeconds = Math.round((Date.now() - started) / 1000);
      return `ready in ${flow.facts.lineSeconds}s`;
    }, { critical: true });

    await flow.step("server", "a throwaway Linux server (InstaBox)", async () => {
      // a run killed hard can leave its machine behind (the app's own exit beats the cleanup): those go first
      for (const old of await leftoverVms()) if (Date.parse(old.createdAt ?? 0) < Date.now() - 60 * 60_000) { await removeVm(old.id).catch(() => {}); flow.log(`deleted a leftover ${old.id}`); }
      vm = await createVm(`dusk-smoke-srv-${stamp.slice(5).replace(/[^0-9]/g, "")}`);
      if (!flag("--keep-vm")) { const made = vm; flow.atClose(async () => { await made.remove(); flow.log(`deleted ${made.id}`); }); }
      flow.facts.vm = vm.id;
      return vm.id;
    }, { critical: true });

    await flow.step("install", "the line runs on the server and the app sees the server by itself", async () => {
      const started = Date.now();
      // pasted as is, as the person would in their server's terminal
      walkthrough.did("pastes the install line into the server's terminal");
      await vm.exec(`cd ~ && setsid nohup bash -c ${shellQuote(`${line}; echo "exit $?" >> ~/dusk-install.log`)} > ~/dusk-install.log 2>&1 < /dev/null & echo started`, 30);
      let lastLog = "";
      for (;;) {
        const v = await view().catch(() => null);
        if (v && ["linked", "moving", "moved"].includes(v.stage)) break;
        // the app's own view of the install: a failed step or an error stops here, with the step's last words
        const failed = v?.steps?.find((step) => step.status === "failed");
        if (v?.stage === "error" || failed) throw new Error(`the install stopped${failed ? ` at ${failed.id}` : ""}: ${String(failed?.log ?? v?.error ?? "").replace(/\s+/g, " ").slice(-300)}`);
        if (Date.now() - started > 25 * 60_000) throw new Error(`the app never saw the server (stage ${v?.stage}); install log ends: ${lastLog}`);
        const tail = await vm.exec("tail -c 600 ~/dusk-install.log 2>/dev/null", 20).catch(() => ({ stdout: "" }));
        lastLog = tail.stdout.replace(/\s+/g, " ").trim().slice(-300);
        // a failed download exits 1 with its own message (electron/vps-link.mjs installLine)
        if (/exit [1-9]/.test(tail.stdout)) throw new Error(`the install line failed: ${lastLog}`);
        await sleep(10_000);
      }
      flow.facts.installSeconds = Math.round((Date.now() - started) / 1000);
      const log = (await vm.exec("cat ~/dusk-install.log", 30)).stdout;
      flow.facts.installLastLines = log.trim().split("\n").slice(-4).join(" / ").slice(0, 400);
      if (/warn|refus|could not/i.test(log)) flow.friction("confusing", "install line", `the installer warned: ${log.split("\n").filter((row) => /warn|refus|could not/i.test(row)).slice(0, 2).join(" / ").slice(0, 200)}`);
      if (flow.facts.installSeconds > 300) flow.friction("slow", "install", `the install took ${Math.round(flow.facts.installSeconds / 60)} minutes before the app saw the server`);
      return `linked after ${flow.facts.installSeconds}s`;
    }, { critical: true });

    await flow.step("sign-in-skip", "the AI sign-in step can be skipped", async () => {
      // the connected screen: "sign in to your AI" goes on to the sign-in and the move
      await flow.waitText(/is connected/i, "the connected screen", { timeout: 60_000 });
      flow.facts.connectedScreen = (await flow.text("[role=dialog]")).replace(/\s+/g, " ").slice(0, 300);
      await flow.click("sign in to your AI");
      await flow.waitFor(`Boolean(document.querySelector("[data-vps-screen]"))`, "the server sheet", 60_000);
      if (await screen() === "signin") {
        // the AIs on the server, each with its own sign in, before anything is skipped
        await flow.waitFor(`Boolean(document.querySelector('[data-vps-screen] ul:not([aria-busy])') || /no ai is set up/i.test(document.querySelector("[data-vps-screen]")?.innerText ?? ""))`, "the server's AIs to sign in to", 60_000);
        await flow.shot("sign-in");
        flow.facts.signInScreen = (await flow.text("[data-vps-screen]")).replace(/\s+/g, " ").slice(0, 300);
        await flow.click("skip for now");
        await sleep(1500);
      }
      return `now on ${await screen()}`;
    });

    await flow.step("move", "\"move everything here\" moves the bots to the server", async () => {
      await flow.waitFor(`(() => { const b = [...document.querySelectorAll("button")].find((e) => /^move everything/i.test(e.innerText.trim())); return Boolean(b && !b.disabled); })()`, "the move button", 120_000);
      flow.facts.moveScreen = (await flow.text("[data-vps-screen]")).replace(/\s+/g, " ").slice(0, 300);
      await flow.shot("move-preview");
      const started = Date.now();
      await flow.click("move everything here", { contains: true });
      // once moved, the window opens the server's own page, where the link bridge is not offered
      const done = await flow.waitFor(`(() => { const link = window.duskDesktop?.vpsLink; if (!link) return "on-server";
        return link.state().then((v) => v.stage === "moved" || (v.move?.status === "failed" ? "failed: " + (v.move?.error ?? v.move?.step) : false)); })()`, "the move to finish", 15 * 60_000);
      if (typeof done === "string" && done.startsWith("failed")) throw new Error(`the move ${done}`);
      flow.facts.moveSeconds = Math.round((Date.now() - started) / 1000);
      if (flow.facts.moveSeconds > 120) flow.friction("slow", "move", `moving a new person's bots took ${flow.facts.moveSeconds}s`);
      return `moved in ${flow.facts.moveSeconds}s`;
    }, { critical: true });

    await flow.step("on-server", "the app now runs from the server, with the bots there", async () => {
      await sleep(5000);
      flow.facts.windowAt = await flow.evaluate(`location.host`);
      flow.facts.serverScreen = (await flow.text()).replace(/\s+/g, " ").slice(0, 160);
      if (/meet Metal|where should your bots live/i.test(flow.facts.serverScreen)) flow.friction("confusing", "after the move", "the server opens on the welcome from the start (\"meet Metal\", then \"where should your bots live?\" again), though the person already chose this server");
      const running = await vm.exec("systemctl is-active duskbot.service", 30);
      flow.facts.serverService = running.stdout.trim();
      if (!running.stdout.startsWith("active")) throw new Error(`duskbot.service is ${running.stdout.split("\n")[0]}`);
      const bots = await flow.evaluate(`fetch("/api/bots").then((r) => r.json()).then((j) => (j.bots ?? j).map((b) => b.name)).catch((e) => "error " + e.message)`);
      flow.facts.botsOnServer = bots;
      if (!Array.isArray(bots) || !bots.length) throw new Error(`the server lists no bots (${JSON.stringify(bots)})`);
      return `window on ${flow.facts.windowAt}; duskbot.service ${flow.facts.serverService}; bots: ${bots.join(", ")}`;
    });

    if (signedOut || walkthrough.enabled) await flow.step("server-chat", "the server's bots in the sidebar, and a chat on the server", async () => {
      await flow.waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the server's chat", 60_000);
      await walkthrough.capture("app", "looks at the bots on the server");
      const started = Date.now();
      const outcome = await flow.chatOk();
      flow.facts.serverReplySeconds = Math.round((Date.now() - started) / 1000);
      if (outcome.startsWith("said:")) flow.friction("confusing", "the server's chat", `the first message on the server got: ${outcome.slice(5).replace(/\s+/g, " ").slice(0, 160)}`);
      return `${outcome.replace(/\s+/g, " ")} in ${flow.facts.serverReplySeconds}s`;
    });

    // this Mac is online and in use: the server's chat must never say it is offline, also past the notice's checks
    if (signedOut || walkthrough.enabled) await flow.step("mac-online", "the server's chat never says this Mac is offline", async () => {
      await sleep(130_000);
      flow.facts.egress = await flow.evaluate(`fetch("/api/computer/egress", { cache: "no-store" }).then((r) => r.ok ? r.json() : "status " + r.status).catch((e) => "error " + e.message)`);
      const agent = await vm.exec("journalctl -u 'dusk*' --since '-15 min' --no-pager 2>/dev/null | grep -i egress | tail -5", 30).catch(() => ({ stdout: "" }));
      flow.facts.egressAgent = agent.stdout.trim().slice(0, 600);
      await walkthrough.capture("app", "the server's chat after a few minutes");
      if (/your computer is offline/i.test(await flow.text())) throw new Error(`the server's chat says "Your computer is offline" (egress ${JSON.stringify(flow.facts.egress)})`);
      return `no offline note; egress ${JSON.stringify(flow.facts.egress)}`;
    });
  } finally {
    // the machine is deleted when the flow closes (flow.atClose), also after a kill
  }
});
