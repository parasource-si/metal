import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  USAGE_DIGEST_KEYS, USAGE_FRUSTRATION_KEYS, USAGE_SESSION_KEYS, SESSION_NOTE_MAX, cleanUsageSession, USAGE_RUN_KEYS, USAGE_TURN_KEYS, categorize, cleanUsageDigest, cleanUsageFrustration, cleanUsageReport, cleanUsageTurn, failureReason, scrubSummary, toolSignals,
  type UsageFrustration, type UsageSession,
} from "../shared/usage-signals.ts";
import { parseWorkspaceReport } from "../shared/dashboard-protocol.ts";
import { toolFailureMessage } from "./drivers/tool-failure.ts";
import {
  BIG_PER_DAY, BIG_SESSION_TURNS, SESSION_GAP_MS, MIN_WORKSPACE_TURNS, createFrustrationWatch, sessionPrompt, summaryPrompt, createUsageOutbox, digestPrompt, isCorrective, isShouting, isSwearing, sameRequest, turnRecord, weeklyAllowance, type FrustrationTurn,
} from "./usage-signals.ts";

const NOW = Date.now();
const SECRET = "Email jane.doe@acme.com the Q3 numbers from /Users/jane/Secret Plan.xlsx at https://acme.com/x";
const allStrings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(allStrings) : value && typeof value === "object" ? Object.values(value).flatMap(allStrings) : [];

describe("note prompts", () => {
  it("ask for complete sentences that name the bot", () => {
    const lines = [{ role: "user" as const, text: "open the sheet" }];
    for (const prompt of [summaryPrompt(lines, ["failed"]), sessionPrompt(lines, { turns: 3, minutes: 2, failed: 0, category: "chat", tools: [], apps: [] } as never)]) {
      expect(prompt).toContain("complete sentences");
      expect(prompt).toContain("the bot could not open the sheet");
    }
  });
});

describe("categorize", () => {
  it("lets a connected app decide, then the tools, then plain chat", () => {
    expect(categorize({ tools: ["app", "browser"], apps: ["gmail"] })).toBe("email");
    expect(categorize({ tools: ["app"], apps: ["googlecalendar", "slack"] })).toBe("calendar");
    expect(categorize({ tools: ["terminal", "files"], apps: [] })).toBe("coding");
    expect(categorize({ tools: ["browser", "web"], apps: [] })).toBe("research");
    expect(categorize({ tools: ["files"], apps: [] })).toBe("files");
    expect(categorize({ tools: ["data"], apps: [] })).toBe("data");
    expect(categorize({ tools: ["memory"], apps: [] })).toBe("chat");
    expect(categorize({ tools: [], apps: [] })).toBe("chat");
  });

  it("folds tool names into kinds and only curated app slugs", () => {
    expect(toolSignals(["Bash", "mcp__composio__GMAIL_SEND_EMAIL", "mcp__composio__ACMECRM_LIST", "WebSearch", "mcp__browser__navigate"])).toEqual({
      tools: ["app", "browser", "terminal", "web"], apps: ["gmail", "other_app"],
    });
  });

  it("turns an error line into a code and never keeps the line", () => {
    expect(failureReason("429 Too Many Requests for org acme")).toBe("rate_limit");
    expect(failureReason("You've hit your usage limit")).toBe("quota");
    expect(failureReason("This Claude account has reached its 5-hour limit, which resets Jan 1")).toBe("quota");
    expect(failureReason("OAuth token expired for jane@acme.com")).toBe("auth");
    expect(failureReason("request timed out after 600s")).toBe("timeout");
    expect(failureReason("something odd")).toBe("unknown");
  });
});

describe("what leaves the workspace", () => {
  it("a turn record carries only its fixed keys, and no text from the turn", () => {
    const record = turnRecord({ driverKind: "claudeAgent", status: "error", reason: SECRET, startedAt: NOW - 5000, endedAt: NOW, toolNames: ["mcp__composio__GMAIL_SEND_EMAIL", `Read ${SECRET}`],
      trigger: { kind: "user" }, room: false }, "desktop", NOW)!;
    expect(Object.keys(record).every(key => (USAGE_TURN_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(record).toMatchObject({ engine: "claude", outcome: "failed", reason: "unknown", ms: 5000, category: "email", from: "remote", place: "desktop", apps: ["gmail"] });
    for (const text of allStrings(record)) expect(text).toMatch(/^[a-z0-9_-]+$/i);
  });

  it("drops unknown keys and bad values on both sides", () => {
    const turn = cleanUsageTurn({ id: "abcdefgh12", at: NOW, engine: "claude", outcome: "ok", ms: 10, tools: ["browser", "evil"], apps: ["gmail", "acme.com"], category: "research", from: "app",
      place: "cloud", room: false, prompt: SECRET, text: SECRET }, NOW)!;
    expect(Object.keys(turn).sort()).toEqual(["apps", "at", "category", "engine", "from", "id", "ms", "outcome", "place", "room", "tools"]);
    expect(turn.apps).toEqual(["gmail"]);
    expect(cleanUsageTurn({ ...turn, engine: "my-secret-instance" }, NOW)).toBeNull();
  });

  it("the report section passes the dashboard parser with nothing but allowed keys", () => {
    const outbox = createUsageOutbox({ now: () => NOW, snapshot: () => ({ bots: 3, rooms: 1, routines: 2, webhooks: 0, appEvents: 1, skills: 4 }) });
    outbox.turn(turnRecord({ driverKind: "codex", status: "ok", toolNames: ["shell"], trigger: { kind: "owner" }, room: true, startedAt: NOW - 100, endedAt: NOW }, "desktop", NOW));
    outbox.run({ id: "run_1", status: "failed", triggerSource: "webhook", eventSource: "app", error: SECRET, finishedAt: NOW });
    outbox.frustration(cleanUsageFrustration({ id: "frustrate1", at: NOW, engine: "claude", category: "email", tools: ["app"], apps: ["gmail"], signals: ["retried"], retries: 2,
      summary: "bot kept failing to draft a reply in the email app; the person retried and gave up." }, NOW));
    const usage = outbox.take()!;
    const parsed = parseWorkspaceReport({ v: 1, seq: 1, at: NOW, workspace: { name: "w", kind: "mac", version: "1", platform: "darwin" }, usage })!;
    expect(parsed.usage).toEqual(usage);
    for (const turn of usage.turns) expect(Object.keys(turn).every(key => (USAGE_TURN_KEYS as readonly string[]).includes(key))).toBe(true);
    for (const run of usage.runs) expect(Object.keys(run).every(key => (USAGE_RUN_KEYS as readonly string[]).includes(key))).toBe(true);
    for (const f of usage.frustrations ?? []) expect(Object.keys(f).every(key => (USAGE_FRUSTRATION_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(usage.runs[0]).toMatchObject({ trigger: "event", outcome: "failed", reason: "unknown" });
    expect(JSON.stringify(usage)).not.toMatch(/jane|acme|xlsx|https/i);
    expect(outbox.take()).toMatchObject({ turns: [], runs: [] });
  });

  it("puts a failed report back and sends nothing while switched off", () => {
    let on = true;
    const outbox = createUsageOutbox({ now: () => NOW, enabled: () => on });
    outbox.turn(turnRecord({ driverKind: "codex", status: "ok", toolNames: [], trigger: { kind: "owner" }, room: false }, "desktop", NOW));
    const taken = outbox.take()!;
    outbox.requeue(taken);
    expect(outbox.size().turns).toBe(1);
    on = false;
    expect(outbox.take()).toBeNull();
    outbox.turn(turnRecord({ driverKind: "codex", status: "ok", toolNames: [], trigger: { kind: "owner" }, room: false }, "desktop", NOW));
    expect(outbox.size().turns).toBe(0);
  });
});

describe("scrubSummary", () => {
  it("keeps an abstract line and lowercases it", () => {
    expect(scrubSummary("Bot kept failing to draft a reply in the email app; user retried and gave up.")).toBe("bot kept failing to draft a reply in the email app; user retried and gave up.");
    expect(scrubSummary("user asked the bot to reconcile last month's receipts into a spreadsheet; it couldn't open the sheet.")).toContain("last month's receipts");
  });
  it("takes out addresses, links, handles, numbers, quotes, files and names", () => {
    const out = scrubSummary("The bot could not send the weekly summary to the team lead even after retrying, and the person was annoyed; it failed with Gmail at https://x.io for @sam on 12/3 in plan.xlsx")!;
    expect(out).not.toMatch(/https|x\.io|@sam|12|xlsx/);
    expect(out).toContain("gmail");
  });
  it("drops a summary that was mostly personal details", () => {
    expect(scrubSummary("Jane Doe jane@acme.com +1 415 555 0100 Acme Corp")).toBeNull();
    expect(scrubSummary('he said "send the contract to Bob at Acme now please" twice')).toBeNull();
  });
  it("drops the writer saying it could not write a note", () => {
    expect(scrubSummary("i can't summarize this chat because the conversation itself isn't in what been given, only your instruction. if you paste the exchange here, write the two lowercase sentences.")).toBeNull();
    expect(scrubSummary("the bot was given only setup rules and no record of the work this person asked for, so the summary cannot say what went wrong.")).toBeNull();
    expect(scrubSummary("I'm unable to see the chat, please share the transcript.")).toBeNull();
    expect(scrubSummary("the bot can't open the sheet and the user retried 3 times.")).toBe("the bot can't open the sheet and the user retried 3 times.");
  });
  it("is stable: a scrubbed line passes the server's check unchanged", () => {
    const once = scrubSummary("The bot kept timing out while reading a long document, and the person stopped it twice.")!;
    expect(scrubSummary(once)).toBe(once);
    const record = cleanUsageFrustration({ id: "frustrate1", at: NOW, engine: "claude", category: "files", tools: [], apps: [], signals: ["stopped"], retries: 0, summary: once }, NOW)!;
    expect(record.summary).toBe(once);
    expect(cleanUsageFrustration({ ...record, summary: "Sent to Bob" }, NOW)!.summary).toBeUndefined();
  });
});

describe("anonymous notes", () => {
  const PRIVATE = [
    "jane.doe@acme.com", "acme", "jane", "/users/jane", "secret plan", "plan.xlsx", "https", "acme.com", "415", "0100", "4111", "acct_9f8e7d6c5b4a", "priya", "quill",
    "kitchen remodel", "c:", "@sam", "#launch",
  ];
  const leaks = (note: string | null) => PRIVATE.filter(bit => note?.toLowerCase().includes(bit));
  it("keeps feature use, small counts, outcomes and plain friction", () => {
    expect(scrubSummary("Connecting Gmail took 3 tries; after that the bot sorted the inbox and drafted 12 replies without trouble.", SESSION_NOTE_MAX))
      .toBe("connecting gmail took 3 tries; after that the bot sorted the inbox and drafted 12 replies without trouble.");
    expect(scrubSummary("A long coding session in the terminal with GitHub; tests ran fine but 2 replies timed out.", SESSION_NOTE_MAX))
      .toBe("a long coding session in the terminal with github; tests ran fine but 2 replies timed out.");
  });
  it("takes out addresses, links, paths, files, phone and account numbers, ids, handles and names", () => {
    const bits = ["jane.doe@acme.com", "the Secret Plan", "/Users/jane/Docs", "plan.xlsx", "C:\\Users\\jane", "+1 415 555 0100", "card 4111 1111 1111 1111", "acct_9f8e7d6c5b4a",
      "@sam", "#launch", "https://acme.com/x", "acme.com"];
    for (const bit of bits) {
      const note = scrubSummary(`a long session with the browser and gmail went well overall, replies were quick, and one step touched ${bit} before the bot finished the job.`, SESSION_NOTE_MAX);
      expect(note, bit).not.toBeNull();
      expect(leaks(note), bit).toEqual([]);
    }
  });
  it("drops a note that copies the person's own words", () => {
    const sources = ["please book a table for four at the little italian place near my office on friday"];
    expect(scrubSummary("they asked to book a table for four at the little italian place, which worked on the second try.", SESSION_NOTE_MAX, { sources })).toBeNull();
    expect(scrubSummary("they asked the bot to book a restaurant table through the browser, which worked on the second try.", SESSION_NOTE_MAX, { sources })).not.toBeNull();
  });
  it("takes out names the chat used, and bot names, even written in lowercase", () => {
    const sources = ["can you help me plan the kitchen remodel with Priya next month", "ok so ask Quill for the numbers"];
    const note = scrubSummary("they planned a home project with priya over a long chat; the bot quill was asked for numbers and replies were quick and helpful overall.", SESSION_NOTE_MAX,
      { sources, avoid: ["Quill"] })!;
    expect(note).not.toBeNull();
    expect(leaks(note)).toEqual([]);
  });
  it("keeps the product's own words when the chat or a bot's name uses them, and still takes out names", () => {
    const sources = ["Hi Metal, post this in Slack and email it via Gmail for Priya", "Sure! Opening Slack in the Browser now, then the Chat with Quill."];
    const note = scrubSummary("the user wanted the bot to post a message in slack and send an email to priya, but the bot could not open the browser or the chat with quill.",
      SESSION_NOTE_MAX, { sources, avoid: ["Metal", "Quill"] })!;
    expect(note).toContain("the user wanted the bot to post a message in slack");
    expect(note).toContain("could not open the browser or the chat");
    expect(leaks(note)).toEqual([]);
    expect(scrubSummary("The bot in Metal could not reach LinkedIn from the Browser.", SESSION_NOTE_MAX)).toBe("the bot in Metal could not reach linkedin from the browser.");
  });
  it("is stable, so a scrubbed note passes the account service's check unchanged", () => {
    const once = scrubSummary("Connecting Gmail took 3 tries, then the session went smoothly with the browser and calendar.", SESSION_NOTE_MAX)!;
    expect(scrubSummary(once, SESSION_NOTE_MAX)).toBe(once);
    const record = cleanUsageSession({ id: "session0001", at: NOW, engine: "claude", category: "email", tools: ["app", "browser"], apps: ["gmail"], turns: 18, minutes: 40, failed: 1, summary: once }, NOW)!;
    expect(Object.keys(record).sort()).toEqual([...USAGE_SESSION_KEYS].sort());
    expect(record.summary).toBe(once);
    expect(cleanUsageSession({ ...record, summary: "Sent to Bob at bob@acme.com" }, NOW)!.summary).toBeUndefined();
    expect(cleanUsageSession({ ...record, failed: 30 }, NOW)).toBeNull();
    expect(cleanUsageReport({ turns: [], runs: [], sessions: [record, { ...record, id: "x" }] }, NOW)!.sessions).toEqual([record]);
  });
});

describe("big sessions", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const turn = (outcome: FrustrationTurn["outcome"] = "ok", ms = 20_000): FrustrationTurn => ({ engine: "claude", category: "coding", tools: ["terminal"], apps: ["github"], outcome, ms });
  function setup(note: string | null = "a long coding session in the terminal with github; tests ran fine but signing in took 2 tries.") {
    let now = NOW;
    const sessions: UsageSession[] = [], prompts: string[] = [];
    const dataDir = mkdtempSync(join(tmpdir(), "sessions-")); dirs.push(dataDir);
    const watch = createFrustrationWatch({ dataDir, now: () => now, report: () => {}, reportSession: record => sessions.push(record),
      describe: async ({ stats }) => { prompts.push(sessionPrompt([{ role: "user", text: "fix the tests" }], stats)); return note; } });
    const chat = (threadId: string, turns: number, gapMs = 60_000) => { for (let i = 0; i < turns; i++) { watch.turn(threadId, "bot_1", turn(i === 2 ? "failed" : "ok")); now += gapMs; } };
    return { watch, sessions, prompts, chat, tick: (ms: number) => { now += ms; } };
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it("writes one note once a big session goes quiet, with its counts", async () => {
    const { watch, sessions, prompts, chat, tick } = setup();
    chat("c1", BIG_SESSION_TURNS);
    watch.sweep(); await flush();
    expect(sessions).toHaveLength(0);
    tick(SESSION_GAP_MS); watch.sweep(); await flush();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ engine: "claude", category: "coding", tools: ["terminal"], apps: ["github"], turns: BIG_SESSION_TURNS, failed: 1 });
    expect(sessions[0]!.summary).toContain("signing in took 2 tries");
    expect(prompts[0]).toContain(`${BIG_SESSION_TURNS} turns`);
    watch.sweep(); await flush();
    expect(sessions).toHaveLength(1);
  });
  it("leaves short sessions alone, and a long gap starts a new session", async () => {
    const { watch, sessions, chat, tick } = setup();
    chat("c1", 8); tick(SESSION_GAP_MS); chat("c1", 8); tick(SESSION_GAP_MS);
    watch.sweep(); await flush();
    expect(sessions).toHaveLength(0);
  });
  it("counts a few very long turns as big", async () => {
    const { watch, sessions, tick } = setup();
    for (let i = 0; i < 5; i++) { watch.turn("c1", "bot_1", turn("ok", 5 * 60_000)); tick(5 * 60_000); }
    tick(SESSION_GAP_MS); watch.sweep(); await flush();
    expect(sessions).toHaveLength(1);
  });
  it("is rate limited per day, and sends the counts without a note the scrubber refuses", async () => {
    const { watch, sessions, chat, tick } = setup("Emailed Jane Doe at jane@acme.com");
    chat("c1", BIG_SESSION_TURNS); chat("c2", BIG_SESSION_TURNS, 1000);
    tick(SESSION_GAP_MS); watch.sweep(); await flush();
    expect(sessions).toHaveLength(BIG_PER_DAY);
    expect(sessions[0]!.summary).toBeUndefined();
  });
});

describe("frustration watch", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const turn = (outcome: FrustrationTurn["outcome"] = "ok"): FrustrationTurn => ({ engine: "claude", category: "email", tools: ["app"], apps: ["gmail"], outcome });
  function setup(options: { summary?: string } = {}) {
    let now = NOW;
    const reports: UsageFrustration[] = [], prompts: string[] = [];
    const dataDir = mkdtempSync(join(tmpdir(), "frustration-")); dirs.push(dataDir);
    const watch = createFrustrationWatch({ dataDir, now: () => now, report: record => reports.push(record), summarize: async input => { prompts.push(input.signals.join(",")); return options.summary ?? null; } });
    const warm = (turns = MIN_WORKSPACE_TURNS) => { for (let i = 0; i < turns; i++) watch.turn("warmup", "bot_1", turn()); };
    return { watch, reports, prompts, warm, tick: (ms: number) => { now += ms; }, dataDir };
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it("spots corrections, swearing, shouting and repeats in a few languages", () => {
    expect(isCorrective("no, that's wrong")).toBe(true);
    expect(isCorrective("nein")).toBe(true);
    expect(isCorrective("not what i asked")).toBe(true);
    expect(isCorrective("no worries, thanks a lot for the help with everything today")).toBe(false);
    expect(isSwearing("this is fucking stupid")).toBe(true);
    expect(isSwearing("are you dumb")).toBe(true);
    expect(isSwearing("please summarise the article")).toBe(false);
    expect(isShouting("WHY DOES THIS NEVER WORK")).toBe(true);
    expect(isShouting("check the AWS bill")).toBe(false);
    expect(sameRequest("draft a reply to the landlord about the leak", "please draft the reply to my landlord about that leak")).toBe(true);
    expect(sameRequest("draft a reply to the landlord", "what's the weather tomorrow")).toBe(false);
  });

  it("needs several signals: one swear alone is not enough", async () => {
    const { watch, reports, warm } = setup();
    warm();
    for (let i = 0; i < 3; i++) watch.turn("chat", "bot_1", turn());
    watch.message("chat", "this is stupid");
    await flush();
    expect(reports).toHaveLength(0);
    watch.thumbsDown("chat");
    await flush();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.signals).toEqual(expect.arrayContaining(["thumbs_down", "swearing"]));
  });

  it("fires on three failed turns in a row without anything the person said, but not on two", async () => {
    const { watch, reports, warm, tick } = setup();
    warm();
    for (let i = 0; i < 2; i++) watch.turn("chat", "bot_1", turn("failed"));
    await flush();
    expect(reports).toHaveLength(0);
    tick(11 * 60_000);
    for (let i = 0; i < 2; i++) watch.turn("chat", "bot_1", turn("failed"));
    await flush();
    expect(reports, "failures older than the window do not add up").toHaveLength(0);
    watch.turn("chat", "bot_1", turn("failed"));
    await flush();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.signals).toEqual(["failed"]);
  });

  it("counts a turn the tool-failure guard stopped as a failure, not the person's stop", async () => {
    const stop = toolFailureMessage(["agents_manage_room"], []);
    const facts = { driverKind: "openaiChat", toolNames: ["agents_manage_room"], failedNames: ["agents_manage_room"], trigger: { kind: "owner" }, room: true, startedAt: NOW - 2000, endedAt: NOW };
    const guarded = turnRecord({ ...facts, status: "interrupted", reason: stop }, "desktop", NOW)!;
    expect(guarded).toMatchObject({ outcome: "failed", reason: "tool" });
    expect(turnRecord({ ...facts, status: "interrupted", reason: "turn interrupted by the person" }, "desktop", NOW)).toMatchObject({ outcome: "cancelled", reason: "unknown" });
    const { watch, reports, warm } = setup();
    warm();
    for (let i = 0; i < 3; i++) watch.turn("chat", "bot_1", { engine: guarded.engine, category: guarded.category, tools: guarded.tools, apps: guarded.apps, outcome: guarded.outcome });
    await flush();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.signals).toContain("failed");
  });

  it("waits for a second turn before it fires", async () => {
    const { watch, reports } = setup();
    watch.turn("chat", "bot_1", turn("cancelled"));
    watch.thumbsDown("chat");
    await flush();
    expect(reports).toHaveLength(0);
  });

  it("hears a new person pushing back on their second turn", async () => {
    const { watch, reports } = setup();
    watch.turn("chat", "bot_1", turn());
    expect(isCorrective("but i fucking connected chatgpt")).toBe(true);
    expect(isCorrective("chatgpt connection aint working bro")).toBe(true);
    expect(isCorrective("it's not working")).toBe(true);
    watch.message("chat", "but i fucking connected chatgpt");
    watch.turn("chat", "bot_1", turn());
    await flush();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.signals).toEqual(expect.arrayContaining(["corrective", "swearing"]));
  });

  it("fires on retries and stops, once per chat per cooldown, with a scrubbed summary and no raw text", async () => {
    const { watch, reports, warm, tick } = setup({ summary: "Bot kept failing to send a reply in the email app; user retried and gave up. Contact jane@acme.com" });
    warm(80);
    for (let i = 0; i < 3; i++) watch.turn("chat", "bot_1", turn(i === 1 ? "ok" : "failed"));
    watch.message("chat", "send the reply to my landlord about the leak");
    watch.message("chat", "please send that reply to my landlord about the leak");
    watch.message("chat", "SEND THE REPLY TO MY LANDLORD ABOUT THE LEAK");
    await flush();
    expect(reports).toHaveLength(1);
    const record = reports[0]!;
    expect(Object.keys(record).every(key => (USAGE_FRUSTRATION_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(record.retries).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(record)).not.toMatch(/landlord|leak|jane|acme/i);
    watch.thumbsDown("chat"); watch.turn("chat", "bot_1", turn("cancelled"));
    await flush();
    expect(reports).toHaveLength(1);
    tick(7 * 3_600_000);
    watch.thumbsDown("chat"); watch.turn("chat", "bot_1", turn("cancelled"));
    await flush();
    expect(reports).toHaveLength(2);
  });

  it("scales the weekly allowance with use", async () => {
    expect(weeklyAllowance(10)).toBe(3);
    expect(weeklyAllowance(200)).toBe(5);
    const { watch, reports, warm, tick } = setup();
    warm();
    for (let chat = 0; chat < 4; chat++) {
      for (let i = 0; i < 3; i++) watch.turn(`chat${chat}`, "bot_1", turn());
      watch.thumbsDown(`chat${chat}`); watch.turn(`chat${chat}`, "bot_1", turn("cancelled"));
      tick(60_000);
    }
    await flush();
    expect(reports).toHaveLength(3);
  });

  it("asks for a digest once a week from people who use it enough", () => {
    const { watch, tick } = setup();
    expect(watch.digestDue()).toBe(false);
    for (let day = 0; day < 4; day++) { for (let i = 0; i < 10; i++) watch.turn("chat", "bot_1", turn()); tick(86_400_000); }
    expect(watch.digestDue()).toBe(true);
    watch.digestSent();
    expect(watch.digestDue()).toBe(false);
    expect(digestPrompt([{ lines: [{ role: "user", text: "hi" }] }], { turns: 40, days: 4, categories: ["email"], tools: ["app"] })).toContain("at most 90 words");
  });

  it("a digest passes only when scrubbed, with its fixed keys", () => {
    const summary = scrubSummary("they mostly use it for email triage and drafting replies; slow replies and sign-in problems are painful; they want better calendar help.", 700)!;
    const parsed = cleanUsageReport({ turns: [], runs: [], digests: [{ id: "digest0001", at: NOW, turns: 40, days: 4, summary }, { id: "digest0002", at: NOW, turns: 40, days: 4, summary: "Mail Bob" }] }, NOW)!;
    expect(parsed.digests).toHaveLength(1);
    expect(Object.keys(parsed.digests![0]!).sort()).toEqual([...USAGE_DIGEST_KEYS].sort());
  });
});

describe("notes survive quitting the app", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const folder = () => { const dir = mkdtempSync(join(tmpdir(), "quit-")); dirs.push(dir); return dir; };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const frustration = () => cleanUsageFrustration({ id: "frustrate1", at: NOW, engine: "claude", category: "email", tools: ["app"], apps: ["gmail"], signals: ["retried"], retries: 2,
    summary: "bot kept failing to draft a reply in the email app; the person retried and gave up." }, NOW);
  const session = () => cleanUsageSession({ id: "session0001", at: NOW, engine: "claude", category: "coding", tools: ["terminal"], apps: [], turns: 18, minutes: 40, failed: 1,
    summary: "a long coding session in the terminal; tests ran fine." }, NOW);
  const digest = () => cleanUsageDigest({ id: "digest00001", at: NOW, turns: 40, days: 4, summary: "uses it mostly for research and file work with a few routines." }, NOW);

  it("keeps the notes a report has not carried yet, and gives them to the next launch's first report", () => {
    const file = join(folder(), "usage-outbox.json");
    const first = createUsageOutbox({ now: () => NOW, file });
    first.frustration(frustration()); first.session(session()); first.digest(digest());
    // the app quits here; the next launch reads the file
    const second = createUsageOutbox({ now: () => NOW, file });
    expect(second.size()).toMatchObject({ frustrations: 1, sessions: 1, digests: 1 });
    const report = second.take()!;
    expect(report.frustrations).toEqual([frustration()]); expect(report.sessions).toEqual([session()]); expect(report.digests).toEqual([digest()]);
    // taken for a report: a launch after that does not send them again
    expect(createUsageOutbox({ now: () => NOW, file }).size()).toMatchObject({ frustrations: 0, sessions: 0, digests: 0 });
    // a report that failed puts them back, on disk too
    second.requeue(report);
    expect(createUsageOutbox({ now: () => NOW, file }).size()).toMatchObject({ frustrations: 1, sessions: 1, digests: 1 });
  });
  it("sends nothing from the file while switched off, and forgets it", () => {
    const file = join(folder(), "usage-outbox.json");
    createUsageOutbox({ now: () => NOW, file }).frustration(frustration());
    let on = false;
    const off = createUsageOutbox({ now: () => NOW, file, enabled: () => on });
    expect(off.take()).toBeNull();
    on = true;
    expect(createUsageOutbox({ now: () => NOW, file }).size().frustrations).toBe(0);
  });
  it("reads only what a report would accept from the file", () => {
    const file = join(folder(), "usage-outbox.json");
    writeFileSync(file, JSON.stringify({ frustrations: [{ ...frustration(), summary: "Email jane.doe@acme.com about the plan", signals: ["evil"] }, { nonsense: true }], sessions: "no", digests: [digest()] }));
    expect(createUsageOutbox({ now: () => NOW, file }).size()).toMatchObject({ frustrations: 0, sessions: 0, digests: 1 });
    writeFileSync(file, "{broken");
    expect(createUsageOutbox({ now: () => NOW, file }).size().frustrations).toBe(0);
  });
  it("ends a session left open by a quit after the next start, and writes its note", async () => {
    const dataDir = folder();
    let now = NOW;
    const turn: FrustrationTurn = { engine: "claude", category: "coding", tools: ["terminal"], apps: ["github"], outcome: "ok", ms: 20_000 };
    const before = createFrustrationWatch({ dataDir, now: () => now, report: () => {} });
    for (let i = 0; i < BIG_SESSION_TURNS; i++) { before.turn("c1", "bot_1", turn); now += 60_000; }
    // the app quits with the session still open; the next launch is 3 hours later
    now += 3 * 3_600_000;
    const sessions: UsageSession[] = [];
    const after = createFrustrationWatch({ dataDir, now: () => now, report: () => {}, reportSession: record => sessions.push(record),
      describe: async () => "a long coding session in the terminal with github; tests ran fine but signing in took 2 tries." });
    after.sweep(); await flush();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ engine: "claude", category: "coding", tools: ["terminal"], apps: ["github"], turns: BIG_SESSION_TURNS, failed: 0 });
    expect(sessions[0]!.summary).toContain("signing in took 2 tries");
    // it is ended once: a third launch has nothing open
    const third = createFrustrationWatch({ dataDir, now: () => now + 1000, report: () => {}, reportSession: record => sessions.push(record) });
    third.sweep(); await flush();
    expect(sessions).toHaveLength(1);
  });
  it("keeps a session that is still within its gap open across the restart", async () => {
    const dataDir = folder();
    let now = NOW;
    const turn: FrustrationTurn = { engine: "claude", category: "coding", tools: [], apps: [], outcome: "ok", ms: 20_000 };
    const before = createFrustrationWatch({ dataDir, now: () => now, report: () => {} });
    for (let i = 0; i < BIG_SESSION_TURNS - 1; i++) { before.turn("c1", "bot_1", turn); now += 1000; }
    const sessions: UsageSession[] = [];
    const after = createFrustrationWatch({ dataDir, now: () => now, report: () => {}, reportSession: record => sessions.push(record) });
    after.turn("c1", "bot_1", turn); now += SESSION_GAP_MS + 1; after.sweep(); await flush();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.turns).toBe(BIG_SESSION_TURNS);
  });
});

describe("usage outbox notes for an app with no dashboard", () => {
  it("lists waiting notes without taking them and drops only the ones sent", () => {
    let on = true;
    const outbox = createUsageOutbox({ now: () => Date.now(), enabled: () => on });
    const at = Date.now();
    outbox.digest({ id: "digest0001", at, turns: 40, days: 4, summary: "mostly email." });
    outbox.digest({ id: "digest0002", at, turns: 41, days: 4, summary: "mostly research." });
    expect(outbox.notes()?.digests?.map(note => note.id)).toEqual(["digest0001", "digest0002"]);
    outbox.sent(["digest0001"]);
    expect(outbox.notes()?.digests?.map(note => note.id)).toEqual(["digest0002"]);
    on = false;
    expect(outbox.notes()).toBeNull();
  });
});
