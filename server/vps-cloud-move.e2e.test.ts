// A VPS's bots moved straight to My Cloud, end to end: a server of the person's own and a Cloud home
// (scripts/testing/vps-cloud-fixture.ts), with main's own wiring for the move (electron/vps-cloud-move.mjs). Disposable
// homes; no network.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVpsCloudFixture, type VpsCloudFixture } from "../scripts/testing/vps-cloud-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { MOVED_REFUSAL } from "./move-freeze.ts";

type Side = VpsCloudFixture["vps"];
type Row = { id: string; role: string; text?: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = async (side: Side, threadId: string): Promise<Row[]> => ((await side("GET", `/api/threads/${threadId}/messages?limit=500`)).body?.messages ?? []) as Row[];
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
async function turn(side: Side, bot: { id: string; threadId: string }, text: string) {
  const before = (await rows(side, bot.threadId)).length;
  expect((await side("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await expect.poll(async () => await idle(side) && (await rows(side, bot.threadId)).length >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}
const journalOf = (fx: VpsCloudFixture) => { try { return JSON.parse(readFileSync(fx.journalFile, "utf8")); } catch { return null; } };
async function until(fx: VpsCloudFixture, done: () => boolean | Promise<boolean>, rounds = 240) {
  for (let round = 0; round < rounds && !(await done()); round++) {
    await fx.main.kick().catch(() => {});
    await sleep(250);
  }
}

describe("straight from the VPS", () => {
  let fx: VpsCloudFixture;
  let scout: { id: string; threadId: string };
  let morning = "";
  beforeAll(async () => { fx = await launchVpsCloudFixture(); }, hostTimeout(120_000));
  afterAll(async () => { await fx?.close(); });

  it("the VPS says its owner may pause it for the move, and only its owner may", async () => {
    const described = await (await fetch(`${fx.vpsBase}/.well-known/duskbot/environment`)).json() as { capabilities: { move?: number; moveOut?: number } };
    expect(described.capabilities).toMatchObject({ move: 1, moveOut: 1 });
    expect((await fx.vps("GET", "/api/move/freeze")).body).toMatchObject({ frozen: false });
    const remote = { "x-forwarded-for": "203.0.113.7", "content-type": "application/json" };
    expect((await fetch(`${fx.vpsBase}/api/move/freeze`, { headers: remote })).status, "nobody signed in").toBeOneOf([401, 403]);
    expect((await fetch(`${fx.vpsBase}/api/move/freeze`, { method: "POST", headers: remote, body: "{}" })).status).toBeOneOf([401, 403]);
    expect((await fx.vps("POST", "/api/move/forget")).status, "deleting the copy stays the machine's own").toBe(403);
  }, hostTimeout(30_000));

  it("with no Cloud yet, choosing the move opens the checkout and waits; nothing moves until the Cloud is ready", async () => {
    scout = (await fx.vps("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
    expect((await fx.vps("PATCH", `/api/bots/${scout.id}`, { soul: "You are Scout." })).status).toBe(200);
    await turn(fx.vps, scout, "Plan the week.");
    expect((await fx.vps("PUT", `/api/bots/${scout.id}/memory/file`, { path: "MEMORY.md", text: "# Memory\n\n- Likes short answers.\n" })).status).toBeLessThan(300);
    const made = (await fx.vps("POST", "/api/routines", { name: "Morning report", prompt: "Report.", botId: scout.id, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15 })).body;
    morning = (made.routine ?? made).id;
    // saved on the VPS itself, as its own page there saves one (a remote sign-in must seal it first)
    const login = await (async () => { const response = await fetch(`${fx.vpsBase}/api/logins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ site: "https://shop.example.test", username: "scout", password: "correct horse battery staple", bots: [scout.id] }) }); return { status: response.status, body: await response.json().catch(() => null) }; })();
    expect(login.status, JSON.stringify(login.body)).toBeLessThan(300);
    await expect.poll(() => idle(fx.vps), { timeout: 60_000, interval: 200 }).toBe(true);

    const machine = fx.account.state.machine;
    fx.account.state = { ...fx.account.state, machine: undefined, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
    expect((await fx.main.start(fx.place.id, { buying: true, plan: "pro" })).stage).toBe("buying");
    expect(fx.spies.bought).toEqual(["pro"]);
    await fx.main.kick();
    expect(journalOf(fx), "no move without a Cloud").toBeNull();

    fx.account.state = { ...fx.account.state, machine: { ...machine, status: "starting" }, entitlement: { plan: "pro", status: "active", expiresAt: null, version: 2 } };
    expect(fx.main.view().stage).toBe("waiting");
    await fx.main.kick();
    expect(journalOf(fx)).toBeNull();
    fx.account.state = { ...fx.account.state, machine };
    expect(fx.spies.tracked.map((entry) => entry.props.step)).toContain("buy");
  }, hostTimeout(120_000));

  it("a failure after the pause lifts it and the VPS works again; Try again finishes, through an app killed mid-way", async () => {
    // My Cloud doesn't answer the check while the VPS is paused: the move can't finish, so the VPS must not stay paused.
    let refusals = 0;
    fx.intercept = (url) => (url.startsWith(`${fx.cloudBase}/api/cloud-send/manifest`) ? (refusals++, new Response(JSON.stringify({ error: "busy" }), { status: 503 })) : null);
    await until(fx, async () => refusals > 0 && Boolean(journalOf(fx)?.failure) && (await fx.vps("GET", "/api/move/freeze")).body.frozen === false, 400);
    expect(refusals, `${JSON.stringify(journalOf(fx))}\n${JSON.stringify(fx.main.view())}\n${fx.logs().split("\n").filter((line) => line.startsWith("[main]")).join("\n")}`).toBeGreaterThan(0);
    expect((await fx.vps("GET", "/api/move/freeze")).body.frozen, "rolled back").toBe(false);
    expect(fx.main.view().stage).toMatch(/moving|failed/u);
    await turn(fx.vps, scout, "Still here?");

    fx.intercept = null;
    let killed = false;
    const killAt = new Set(["freeze", "switch"]);
    fx.beforeJournalWrite = (value) => { if (value?.phase && killAt.delete(value.phase)) { killed = true; throw new Error("the app was killed"); } };
    await fx.main.retry().catch(() => {});
    for (let round = 0; round < 400 && journalOf(fx)?.phase !== "done"; round++) {
      await fx.main.kick().catch(() => {});
      if (killed) { killed = false; await fx.relaunch(); continue; }
      if (journalOf(fx)?.phase !== "done") await sleep(250);
    }
    fx.beforeJournalWrite = null;
    expect(journalOf(fx)?.phase, `${JSON.stringify(journalOf(fx))}\n${fx.logs().split("\n").filter((line) => line.startsWith("[main]")).join("\n")}`).toBe("done");
    expect(killAt.size, "killed once at each").toBe(0);
  }, hostTimeout(240_000));

  it("everything is on My Cloud, on as it was; the VPS keeps its copy, paused for good, and nothing ran on this computer", async () => {
    const there = (await fx.cloud("GET", "/api/bots")).body.bots as Array<{ id: string; name: string; soul?: string }>;
    expect(there.find((bot) => bot.id === scout.id)).toMatchObject({ name: "Scout", soul: "You are Scout." });
    const chat = await rows(fx.cloud, scout.threadId);
    expect(chat.some((row) => row.role === "user" && row.text === "Plan the week.")).toBe(true);
    expect(chat.some((row) => row.role === "user" && row.text === "Still here?"), "what was said after the failure came too").toBe(true);
    expect((await fx.cloud("GET", `/api/bots/${scout.id}/memory/file?path=MEMORY.md`)).body?.text).toContain("Likes short answers.");
    const routines = (await fx.cloud("GET", "/api/routines")).body as { routines: Array<{ id: string; enabled: boolean }> };
    expect(routines.routines.find((routine) => routine.id === morning)?.enabled).toBe(true);

    expect((await fx.vps("GET", "/api/move/freeze")).body).toMatchObject({ frozen: true, cloud: fx.cloudBase });
    expect(await fx.vps("POST", `/api/bots/${scout.id}/messages`, { text: "Hello?", threadId: scout.threadId })).toMatchObject({ status: 409, body: { error: MOVED_REFUSAL } });
    expect((await fx.vps("GET", "/api/bots")).body.bots.some((bot: { id: string }) => bot.id === scout.id), "never deleted at the source").toBe(true);
    expect((await rows(fx.vps, scout.threadId)).length).toBeGreaterThan(0);

    const logins = async (side: Side) => JSON.stringify((await side("GET", "/api/logins")).body ?? {});
    expect(await logins(fx.vps), "a saved login stays on the VPS").toContain("shop.example.test");
    expect(await logins(fx.cloud), "and never travels this way").not.toContain("shop.example.test");

    expect(fx.main.away()).toBe(true);
    expect(fx.main.homeJournal()).toMatchObject({ phase: "done" });
    const seen = fx.main.view();
    expect(seen).toMatchObject({ stage: "done", route: "direct", place: "Hetzner box" });
    expect(seen.stays).toContain("Hetzner box");
    expect(fx.spies.opened).toBe(1);
    expect(fx.spies.viaMac).toBe(0);
    const steps = fx.spies.tracked.filter((entry) => entry.name === "vps_cloud_move").map((entry) => entry.props.step);
    expect(steps).toEqual(expect.arrayContaining(["buy", "started", "failed", "retry", "succeeded"]));
    expect(JSON.stringify(fx.spies.tracked), "events carry no names or ids").not.toMatch(/Scout|Hetzner|Plan the week/u);
  }, hostTimeout(60_000));
});

describe("a VPS that can't be paused by its owner yet", () => {
  let fx: VpsCloudFixture;
  beforeAll(async () => { fx = await launchVpsCloudFixture(); }, hostTimeout(120_000));
  afterAll(async () => { await fx?.close(); });

  it("goes via this computer by itself when that applies, with the VPS left running", async () => {
    const bot = (await fx.vps("POST", "/api/bots", { name: "Echo", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
    await turn(fx.vps, bot, "Hi.");
    // an older server answers its owner's freeze as only its own computer may
    fx.intercept = (url, init) => (url === `${fx.vpsBase}/api/move/freeze` && init.method === "POST" ? new Response(JSON.stringify({ error: "Only Metal on this computer can do this." }), { status: 403 }) : null);
    fx.viaMacAvailable = true;
    await fx.main.start(fx.place.id);
    await until(fx, () => fx.main.chosen()?.route === "via-mac", 400);
    expect(fx.main.chosen()?.route, fx.logs().split("\n").filter((line) => line.startsWith("[main]")).join("\n")).toBe("via-mac");
    expect(fx.spies.viaMac).toBe(1);
    expect(fx.main.view()).toMatchObject({ stage: "fallback", route: "via-mac", why: "outdated" });
    expect((await fx.vps("GET", "/api/move/freeze")).body.frozen).toBe(false);
    expect(journalOf(fx)).toBeNull();
    expect(fx.spies.tracked.some((entry) => entry.props.step === "fallback" && entry.props.reason === "outdated")).toBe(true);
  }, hostTimeout(240_000));

  it("without that way, it says to update the VPS, and nothing is left paused", async () => {
    fx.viaMacAvailable = false;
    // a fresh choice on the same VPS, with the way via this computer off
    const choiceFile = fx.journalFile.replace("vps-cloud-move.json", "vps-cloud-choice.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(choiceFile, "null");
    await fx.main.start(fx.place.id);
    await until(fx, () => fx.main.view().stage === "failed", 400);
    expect(fx.main.view()).toMatchObject({ stage: "failed", route: "direct" });
    expect(fx.main.view().error).toMatch(/Update Metal on Hetzner box/u);
    expect((await fx.vps("GET", "/api/move/freeze")).body.frozen).toBe(false);
  }, hostTimeout(240_000));
});
