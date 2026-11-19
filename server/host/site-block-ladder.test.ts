import { describe, expect, it } from "vitest";
import type { HumanCheckPage } from "./human-check-watch.ts";
import { HARD_BLOCK_WAIT_MS, HOME_SETTLE_MS, LADDER_RELOAD_AT_MS, LADDER_WAIT_MS, otherRoutesHint, runSiteBlockLadder, wallState } from "./site-block-ladder.ts";

const page = (over: Partial<HumanCheckPage> = {}): HumanCheckPage => ({
  title: "Pastebin", text: "New paste", textLength: 2_400, nodes: 300, controls: 40, busy: false, scripts: [], iframes: [], selectors: [], status: 200, ...over,
});
/** Cloudflare's "Performing security verification" interstitial, Turnstile running inside it. */
const verifying = page({ title: "Just a moment...", text: "pastebin.com\nPerforming security verification\nVerifying...", textLength: 90, controls: 0, status: 403,
  selectors: ["#challenge-running"], iframes: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0"] });
const denied = page({ title: "Access denied", text: "Access denied. Your request was blocked.", textLength: 60, controls: 0, status: 403 });
const captcha = page({ title: "Are you a robot?", text: "Please verify you are human", textLength: 40, iframes: ["https://www.google.com/recaptcha/api2/anchor?k=1"] });

/** A page that answers with `pages` in turn (the last one repeats), with a clock that moves only when the ladder sleeps. */
function site(pages: Array<HumanCheckPage | null>, { home = false, afterHome = [] as Array<HumanCheckPage | null>, afterReload = null as Array<HumanCheckPage | null> | null } = {}) {
  let t = 0;
  let queue = [...pages];
  const log: string[] = [];
  return {
    log,
    deps: {
      read: async () => { const next = queue.length > 1 ? queue.shift()! : queue[0]!; log.push(next ? wallState(next) : "between"); return next; },
      reload: async () => { log.push(`reload@${t}`); if (afterReload) { queue = [...afterReload]; afterReload = null; } },
      ...(home ? { homeRoute: async () => { log.push(`home@${t}`); queue = [...afterHome]; return true; } } : {}),
      sleep: async (ms: number) => { t += ms; },
      now: () => t,
    },
  };
}

describe("the general bot-wall states", () => {
  it.each<[string, HumanCheckPage, string]>([
    ["an ordinary page", page(), "clear"],
    ["Cloudflare's \"Verifying...\" interstitial", verifying, "checking"],
    ["a 403 access denied", denied, "blocked"],
    ["a robot page with a reCAPTCHA", captcha, "check"],
    ["a 429", page({ title: "429 Too Many Requests", text: "Too Many Requests", textLength: 20, status: 429 }), "blocked"],
    ["PerimeterX's press and hold", page({ title: "Access to this page has been denied", text: "Press & Hold to confirm you are a human (and not a bot).", textLength: 70, selectors: ["#px-captcha"] }), "check"],
  ])("%s is %s", (_name, probe, state) => {
    expect(wallState(probe)).toBe(state);
  });
});

describe("Metal's own recovery from a bot wall", () => {
  it("waits out a self-clearing interstitial quietly, without reloading or going home", async () => {
    const fixture = site([verifying, verifying, verifying, null, page()], { home: true });
    expect(await runSiteBlockLadder(fixture.deps)).toEqual({ outcome: "cleared", via: "wait", waitedMs: 12_500 });
    expect(fixture.log.some((line) => line.startsWith("reload") || line.startsWith("home"))).toBe(false);
  });

  it("reloads an interstitial once, partway through a wait of about 45 s", async () => {
    const fixture = site([verifying], { afterReload: [null, page()] });
    const result = await runSiteBlockLadder(fixture.deps);
    expect(fixture.log.filter((line) => line.startsWith("reload"))).toEqual([`reload@${LADDER_RELOAD_AT_MS}`]);
    expect(result).toMatchObject({ outcome: "cleared", via: "wait" });
  });

  it("gives an interstitial that never clears the whole wait and one reload, then goes on", async () => {
    const fixture = site([verifying]);
    const result = await runSiteBlockLadder(fixture.deps);
    expect(result).toEqual({ outcome: "check", homeTried: false, waitedMs: LADDER_WAIT_MS });
    expect(fixture.log.filter((line) => line.startsWith("reload"))).toHaveLength(1);
  });

  it("does not wait 45 s on a hard block: one reload, then the person's own connection, where the site lets it through", async () => {
    const fixture = site([denied], { home: true, afterHome: [null, page(), page()] });
    const result = await runSiteBlockLadder(fixture.deps);
    expect(result).toMatchObject({ outcome: "cleared", via: "home" });
    expect(fixture.log[1]).toBe("reload@2500");
    const home = Number(fixture.log.find((line) => line.startsWith("home@"))!.slice(5));
    expect(home).toBeLessThanOrEqual(HARD_BLOCK_WAIT_MS + 2_500);
    // the reload after the route waits for Chromium to pick up its new policy
    expect(fixture.log).toContain(`reload@${home + HOME_SETTLE_MS}`);
  });

  it("says what is left when even the person's connection is blocked", async () => {
    const fixture = site([denied], { home: true, afterHome: [denied] });
    expect(await runSiteBlockLadder(fixture.deps)).toMatchObject({ outcome: "blocked", homeTried: true });
  });

  it("goes on without the home step when it cannot happen (no link, offline, off)", async () => {
    const fixture = site([captcha]);
    const result = await runSiteBlockLadder({ ...fixture.deps, homeRoute: async () => false });
    expect(result).toEqual({ outcome: "check", homeTried: false, waitedMs: expect.any(Number) });
    expect(result.outcome === "check" && result.waitedMs).toBeLessThan(15_000);
  });

  it("reports a page with nothing on it, a page it cannot read, and only looks once on a repeat", async () => {
    expect(await runSiteBlockLadder(site([page()]).deps)).toEqual({ outcome: "none" });
    expect(await runSiteBlockLadder(site([null]).deps)).toEqual({ outcome: "unreadable" });
    const repeat = site([verifying]);
    expect(await runSiteBlockLadder(repeat.deps, { quick: true })).toEqual({ outcome: "check", homeTried: true, waitedMs: 0 });
    expect(repeat.log).toEqual(["checking"]);
    expect(await runSiteBlockLadder(site([page()]).deps, { quick: true })).toMatchObject({ outcome: "cleared" });
  });

  it("only reads and reloads: nothing in it clicks, types or answers", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./site-block-ladder.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/\.click\(|"click"|type_text|Input\.dispatch|cf-turnstile-response|solver/i);
  });
});

describe("other routes to the same goal", () => {
  it("names a known site's API and the general routes, and the general routes alone for any other site", () => {
    expect(otherRoutesHint("pastebin.com")).toMatch(/^For pastebin\.com: Pastebin has an API .*api_post\.php.*request_credential.*GitHub gist.*dpaste\.org/);
    expect(otherRoutesHint("www.pastebin.com")).toMatch(/Pastebin has an API/);
    const general = otherRoutesHint("tickets.example");
    expect(general).toMatch(/^In general: the site's official API .*connected app .*another site .*mac_exec with curl/);
    expect(general).not.toMatch(/For tickets\.example/);
  });
});
