import { describe, expect, it } from "vitest";
import { signInResumePrompt } from "../../shared/sign-in-request.ts";
import { createSignInRequests, type SignInRequestDeps } from "./sign-in-requests.ts";
import type { LadderResult } from "./site-block-ladder.ts";
import type { BotRecord, Message } from "../store.ts";

const bot = { id: "b1", name: "Pepper", color: "green" } as BotRecord;

function harness(recover: LadderResult[] = [{ outcome: "check", homeTried: false, waitedMs: 45_000 }]) {
  const messages: Message[] = [];
  const pleas: Array<{ key: string; reason: unknown; ref: Record<string, unknown> }> = [];
  const watched: unknown[] = [];
  const recoveries: Array<{ site: string; quick: boolean }> = [];
  let t = 0;
  const deps: SignInRequestDeps = {
    store: {
      appendMessage: ((_threadId: string, row: Partial<Message>) => {
        const message = { id: `m${messages.length + 1}`, at: Date.now(), ...row } as Message;
        messages.push(message);
        return message;
      }) as SignInRequestDeps["store"]["appendMessage"],
      activePath: () => messages,
      patchMessage: ((_threadId: string, id: string, patch: Partial<Message>) => {
        const message = messages.find((one) => one.id === id)!;
        Object.assign(message, patch);
        return message;
      }) as SignInRequestDeps["store"]["patchMessage"],
    },
    connectorThread: () => ({ bot, group: undefined }),
    signInPlace: () => "browser",
    threadLanguage: () => undefined,
    followCard: () => undefined,
    computerControl: {
      requestHelp: (key, reason, ref) => { pleas.push({ key, reason, ref: { ...ref } }); return { held: false, helpReason: null, heldSinceMs: null }; },
      settleHelp: () => [],
    },
    signInControlKey: () => "b1",
    watchCheck: (ref) => { watched.push(ref); },
    recoverCheck: async (ref, { quick }) => { recoveries.push({ site: ref.site, quick }); return recover.length > 1 ? recover.shift()! : recover[0]!; },
    now: () => t,
  };
  const person = (text: string) => messages.push({ id: `u${messages.length + 1}`, at: 0, role: "user", kind: "text", text } as Message);
  return { ...createSignInRequests(deps), messages, pleas, watched, recoveries, person, later: (ms: number) => { t += ms; } };
}

const cards = (messages: Message[]) => messages.filter((message) => message.kind === "signin");

describe("a human check or bot block, before anyone is asked", () => {
  it("waits first: a check that clears by itself ends with no card, no plea and nothing said", async () => {
    const run = harness([{ outcome: "cleared", via: "wait", waitedMs: 9_000 }]);
    expect(await run.requestSignIn(bot, "t1", "https://pastebin.com/", "", true)).toEqual({ site: "pastebin.com", place: "browser", outcome: "cleared", via: "wait" });
    expect(run.recoveries).toEqual([{ site: "pastebin.com", quick: false }]);
    expect(cards(run.messages)).toEqual([]);
    expect(run.pleas).toEqual([]);
  });

  it("clears through the person's own connection without a card", async () => {
    const run = harness([{ outcome: "cleared", via: "home", waitedMs: 70_000 }]);
    expect(await run.requestSignIn(bot, "t1", "pastebin.com", "", true)).toMatchObject({ outcome: "cleared", via: "home" });
    expect(cards(run.messages)).toEqual([]);
  });

  it("sends the bot to other routes before any card, then asks once when the bot says none fits", async () => {
    const run = harness();
    const first = await run.requestSignIn(bot, "t1", "pastebin.com", "", true);
    expect(first).toMatchObject({ outcome: "other-routes", homeTried: false });
    expect((first as { hint: string }).hint).toMatch(/Pastebin has an API[\s\S]*GitHub gist[\s\S]*official API[\s\S]*connected app[\s\S]*mac_exec/);
    expect(cards(run.messages)).toEqual([]);
    // the second call only looks once more: the wait already ran for this site in this task
    const made = await run.requestSignIn(bot, "t1", "pastebin.com", "", true, "the person asked for pastebin itself and has no API key");
    expect(run.recoveries).toEqual([{ site: "pastebin.com", quick: false }, { site: "pastebin.com", quick: true }]);
    expect(made).toMatchObject({ site: "pastebin.com", place: "browser", messageId: "m1" });
    expect(cards(run.messages)).toHaveLength(1);
    expect(run.pleas).toHaveLength(1);
  });

  it("never posts a card for a hard block nobody can tick past, and says which other routes there are", async () => {
    const run = harness([{ outcome: "blocked", homeTried: true, waitedMs: 40_000 }]);
    expect(await run.requestSignIn(bot, "t1", "shop.example", "", true, "tried everything")).toMatchObject({ outcome: "blocked", homeTried: true, hint: expect.stringContaining("official API") });
    expect(cards(run.messages)).toEqual([]);
  });

  it("does not ask about a page where Metal sees no check, so a card can never settle itself in a loop", async () => {
    const run = harness([{ outcome: "none" }]);
    expect(await run.requestSignIn(bot, "t1", "shop.example", "", true, "none")).toMatchObject({ outcome: "no-check" });
    expect(cards(run.messages)).toEqual([]);
  });

  it("asks where the page cannot be read (the Local VM), still after the other routes", async () => {
    const run = harness([{ outcome: "unreadable" }]);
    expect(await run.requestSignIn(bot, "t1", "shop.example", "", true)).toMatchObject({ outcome: "other-routes" });
    expect(await run.requestSignIn(bot, "t1", "shop.example", "", true, "no API")).toMatchObject({ messageId: "m1" });
  });
});

describe("one ask per site per task", () => {
  it("hands back the open card instead of a second one, with no new message or plea", async () => {
    const run = harness();
    await run.requestSignIn(bot, "t1", "pastebin.com", "", true, "none fits");
    expect(await run.requestSignIn(bot, "t1", "https://pastebin.com/login", "", true, "none fits")).toEqual({ messageId: "m1", site: "pastebin.com", place: "browser", reused: true });
    expect(run.messages).toHaveLength(1);
    expect(run.pleas).toHaveLength(1);
    expect(run.messages[0]!.signIn?.superseded).toBeUndefined();
  });

  it("does not ask again after the person already did the check in this task, and asks anew in the next task", async () => {
    const run = harness();
    run.person("post this on pastebin");
    await run.requestSignIn(bot, "t1", "pastebin.com", "", true, "none fits");
    run.messages.find((message) => message.kind === "signin")!.signIn!.done = true;
    expect(await run.requestSignIn(bot, "t1", "pastebin.com", "", true, "none fits")).toMatchObject({ outcome: "asked-before" });
    expect(cards(run.messages)).toHaveLength(1);
    // a check on another site in the same task is its own ask
    expect(await run.requestSignIn(bot, "t1", "dpaste.org", "", true, "none fits")).toMatchObject({ site: "dpaste.org", messageId: expect.any(String) });
    run.person("and another one");
    run.later(11 * 60_000);
    expect(await run.requestSignIn(bot, "t1", "pastebin.com", "", true, "none fits")).toMatchObject({ site: "pastebin.com", messageId: expect.any(String) });
    expect(cards(run.messages)).toHaveLength(3);
  });
});

describe("one ask on screen, whatever the bot wrote", () => {
  it("turns the bot's own line that only asked into the card, and trims the ask out of a line with news", async () => {
    const run = harness();
    run.person("post my notes on pastebin");
    const say = (text: string) => run.messages.push({ id: `t${run.messages.length + 1}`, at: 0, role: "bot", kind: "text", text } as Message);
    say("Pastebin is showing a Cloudflare check. I drafted the paste with your notes, 214 lines.");
    say("Please complete this check on the cloud computer. I'll carry on from there.");
    const made = await run.requestSignIn(bot, "t1", "pastebin.com", "", true, "the person asked for pastebin");
    const texts = run.messages.filter((message) => message.kind === "text" && message.role === "bot").map((message) => message.text);
    expect(texts).toEqual(["I drafted the paste with your notes, 214 lines."]);
    const cards = run.messages.filter((message) => message.kind === "signin");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe("t3");
    expect(made).toMatchObject({ messageId: "t3", site: "pastebin.com" });
    expect(cards[0]!.text).toMatch(/^pastebin\.com wants a quick human check/);
    expect(run.pleas[0]!.ref).toMatchObject({ messageId: "t3", check: true });
  });

  it("leaves the bot's lines from before the person's latest message alone", async () => {
    const run = harness();
    run.messages.push({ id: "old", at: 0, role: "bot", kind: "text", text: "Please complete the captcha on the cloud computer." } as Message);
    run.person("try again");
    await run.requestSignIn(bot, "t1", "pastebin.com", "", true, "none fits");
    expect(run.messages.find((message) => message.id === "old")!.kind).toBe("text");
  });
});

describe("a human check card", () => {
  it("says what to do in one line, drops the bot's reason, marks the plea a check and starts watching the page", async () => {
    const run = harness();
    const made = await run.requestSignIn(bot, "t1", "https://pastebin.com/", "Pastebin is asking me to verify I'm human, please take over", true, "no API key");
    expect(made).toMatchObject({ site: "pastebin.com", place: "browser" });
    const card = run.messages[0]!;
    expect(card.signIn).toEqual({ url: "https://pastebin.com/", site: "pastebin.com", place: "browser", check: true });
    expect(card.text).toBe("pastebin.com wants a quick human check. Open this conversation in Metal and tap Take over, and Pepper carries on from there.");
    expect(card.text).not.toMatch(/please|complete this check/i);
    expect(run.pleas).toEqual([{ key: "b1", reason: "human check on pastebin.com", ref: { botId: "b1", threadId: "t1", messageId: "m1", site: "pastebin.com", place: "browser", check: true } }]);
    expect(run.watched).toEqual([{ botId: "b1", threadId: "t1", messageId: "m1", site: "pastebin.com", place: "browser" }]);
  });

  it("leaves an ordinary sign-in card as it was, unwatched and with no recovery", async () => {
    const run = harness();
    await run.requestSignIn(bot, "t1", "example.com", "to open your orders");
    expect(run.messages[0]!.signIn).toEqual({ url: "https://example.com/", site: "example.com", place: "browser", reason: "to open your orders" });
    expect(run.pleas[0]!.reason).toBe("sign in to example.com");
    expect(run.watched).toEqual([]);
    expect(run.recoveries).toEqual([]);
  });

  it("resumes the bot without a sign-in to check, and points a skipped check at another route", () => {
    expect(signInResumePrompt("pastebin.com", "done", true)).toMatch(/human check on pastebin\.com is cleared\. Look at the page again and carry on/);
    expect(signInResumePrompt("pastebin.com", "done", true)).not.toMatch(/signed in/);
    expect(signInResumePrompt("pastebin.com", "cancelled", true)).toMatch(/another site that does the same job or the site's API/);
    expect(signInResumePrompt("pastebin.com", "done")).toMatch(/finished signing in/);
  });
});
