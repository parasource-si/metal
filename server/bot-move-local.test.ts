import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { lookForBots } from "./bot-move-local.ts";
import { thisMachine, type SetupFs, type SetupMachine } from "./setup-import.ts";
import { linkOldName, plantAgentTools, plantHermes, plantOpenClawEntries, plantOpenClawList, plantOpenClawStock, plantOpenMausBot, PNG, putter, SENTINEL } from "./testing/agent-app-fixtures.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function newHome() {
  const home = mkdtempSync(join(tmpdir(), "dusk-bot-move-"));
  homes.push(home);
  return home;
}

/** Records every file opened and every folder listed. */
function machineAt(home: string, env: Record<string, string> = {}): SetupMachine & { opened: string[]; listed: string[] } {
  const real = thisMachine();
  const opened: string[] = [];
  const listed: string[] = [];
  const fs: SetupFs = {
    ...real.fs,
    read: (path, ...rest) => {
      opened.push(path);
      return real.fs.read(path, ...rest);
    },
    readdir: (path) => {
      listed.push(path);
      return real.fs.readdir(path);
    },
  };
  return { ...real, home, platform: "darwin", env, fs, opened, listed };
}

const NOW = Date.UTC(2026, 10, 12);

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const info = statSync(full);
      out.push(`${full}:${info.size}:${info.mtimeMs}`);
      if (info.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

describe("OpenClaw", () => {
  it("reads each agent of a 2026.3 install: persona, memory, skills, heartbeat and cron jobs, by agent", () => {
    const home = newHome();
    const secrets = plantOpenClawList(home);
    const before = snapshot(home);
    const machine = machineAt(home);
    const look = lookForBots(machine, { now: NOW });

    expect(look.apps).toHaveLength(1);
    const app = look.apps[0]!;
    expect(app).toMatchObject({ source: "openclaw", app: "OpenClaw", where: "~/.openclaw", channels: ["telegram"], unreadable: [] });
    const [molty, scout] = app.bots;
    expect(molty).toMatchObject({ name: "Molty", title: "space lobster", description: "warm, a little dry" });
    expect(molty!.instructions).toContain("Have opinions.");
    // AGENTS.md is still OpenClaw's template, and daily logs are history: neither is kept as memory
    expect(Object.keys(molty!.memoryFiles!).sort()).toEqual(["MEMORY.md", "memory/openclaw-setup.md", "memory/openclaw-tools.md"]);
    // what it knew about the person is for About me, only the fields filled in; the rest of USER.md and the daily
    // logs go to the bot's engine to condense
    expect(molty!.userFacts).toEqual(["Name: Sam", "Timezone: Europe/Lisbon"]);
    expect(molty!.distill!.join("\n")).toContain("Prefers short answers.");
    expect(molty!.distill!.join("\n")).toContain("Booked the dentist");
    // its picture, from its own folder; Scout's points out of its folder and is left
    expect(molty!.avatar).toEqual({ mime: "image/png", data: PNG.toString("base64") });
    expect(scout!.avatar).toBeUndefined();
    // the gateway's tools go with the main agent, a remote one with its address, a local one by name; no header or env value
    expect(molty!.apps).toEqual([
      { name: "linear", mcpUrl: "https://mcp.linear.app/mcp", transport: "", headerNames: ["Authorization"] },
      { name: "files", mcpUrl: "", transport: "stdio", headerNames: [] },
    ]);
    expect(scout!.apps).toEqual([]);
    const setup = molty!.memoryFiles!["memory/openclaw-setup.md"]!;
    expect(setup).toContain("- Model: anthropic/claude-sonnet-4-5.");
    expect(setup).toContain("- Answered on: Telegram.");
    expect(setup).toContain("- Tools (MCP servers): linear, files.");
    expect(molty!.distill![1]!.indexOf("2026-03-02")).toBeLessThan(molty!.distill![1]!.indexOf("2026-03-01"));
    expect(molty!.skills.map((skill) => skill.name)).toEqual(["groceries", "weather"]);
    expect(molty!.routines.map((routine) => [routine.name, routine.cron, routine.timeZone, routine.paused])).toEqual([
      ["Heartbeat", "", "", true], ["Morning brief", "0 8 * * 1-5", "Europe/Lisbon", false], ["Wake", "*/5 * * * *", "", false],
    ]);
    expect(molty!.routines[1]!.details).toBe("sent to telegram");
    expect(scout).toMatchObject({ name: "Scout", instructions: "You are Scout. You research things and answer with sources." });
    expect(scout!.skills.map((skill) => skill.name)).toEqual(["sources", "weather"]);
    expect(scout!.routines[0]).toMatchObject({ name: "News sweep", paused: true, schedule: { type: "interval", everyMinutes: 60, anchorAt: NOW } });

    // logins, keys, sessions and transcripts are never opened or listed, and nothing in the folder changes
    for (const secret of secrets) expect(machine.opened).not.toContain(secret);
    expect(machine.listed.some((path) => /credentials|sessions|agents[\\/]main/.test(path))).toBe(false);
    expect(JSON.stringify(look)).not.toContain(SENTINEL);
    expect(snapshot(home)).toEqual(before);
  });

  it("is a bot only where a workspace really defines one: OpenClaw's templates, a never-set-up agent and an empty folder are not", () => {
    const home = newHome();
    plantOpenClawStock(home);
    const look = lookForBots(machineAt(home), { now: NOW });
    expect(look.apps).toHaveLength(1);
    const bots = look.apps[0]!.bots;
    // named by its persona's own heading, since IDENTITY.md was never filled in
    expect(bots.map((bot) => bot.name)).toEqual(["Nova"]);
    const [nova] = bots;
    expect(nova!.instructions).toContain("You are Nova");
    expect(nova!.userFacts, "an empty USER.md template is no fact").toEqual([]);
    expect(nova!.routines, "a heartbeat of only comments is no routine").toEqual([]);
    expect(Object.keys(nova!.memoryFiles!), "stock AGENTS.md and TOOLS.md are not memory").toEqual(["memory/openclaw-setup.md"]);
    expect(nova!.distill).toEqual([]);
  });

  it("reads a 2026.11 install: agents.entries, its system agent and cron jobs kept in SQLite, never its sessions", () => {
    const home = newHome();
    plantOpenClawEntries(home);
    const look = lookForBots(machineAt(home), { now: NOW });
    const bot = look.apps[0]!.bots[0]!;
    expect(bot).toMatchObject({ name: "Opsy", title: "calm engineer", description: "Keeps the servers up" });
    expect(bot.memoryFiles!["MEMORY.md"]).toContain("us-east-2");
    expect(bot.routines.map((routine) => [routine.name, routine.cron])).toEqual([["Disk check", "0 */6 * * *"]]);
    expect(look.apps[0]!.channels).toEqual(["slack"]);
    expect(JSON.stringify(look)).not.toContain(SENTINEL);
  });

  it("reads Clawdbot and Moltbot folders under their own names, and an old name linked to the new folder once", () => {
    const home = newHome();
    plantOpenClawList(home);
    linkOldName(home, ".clawdbot", ".openclaw");
    plantOpenClawList(home, ".moltbot", "moltbot.json");
    const apps = lookForBots(machineAt(home), { now: NOW }).apps;
    expect(apps.map((app) => [app.app, app.where])).toEqual([["OpenClaw", "~/.openclaw"], ["Moltbot", "~/.moltbot"]]);
  });

  it("follows OPENCLAW_STATE_DIR and keeps what it can read from a broken config, naming what it could not", () => {
    const home = newHome();
    const state = join(home, "elsewhere");
    const put = putter(home);
    put("elsewhere/openclaw.json", "{ agents: { list: [ { id: 'main' ");
    put("elsewhere/workspace/SOUL.md", "Still me.");
    put("elsewhere/cron/jobs.json", "not json at all");
    const app = lookForBots(machineAt(home, { OPENCLAW_STATE_DIR: state }), { now: NOW }).apps[0]!;
    expect(app.bots.map((bot) => [bot.name, bot.instructions])).toEqual([["OpenClaw", "Still me."]]);
    expect(app.unreadable.sort()).toEqual(["cron/jobs.json", "openclaw.json"]);
  });

  it("never follows a link out of a workspace, and skips a file it may not read", () => {
    const home = newHome();
    plantOpenClawList(home);
    const put = putter(home);
    const outside = put("outside/secret.md", SENTINEL);
    rmSync(join(home, ".openclaw/workspace/SOUL.md"));
    linkOldName(home, ".openclaw/workspace/SOUL.md", "outside/secret.md");
    chmodSync(join(home, ".openclaw/workspace/USER.md"), 0o000);
    const machine = machineAt(home);
    const app = lookForBots(machine, { now: NOW }).apps[0]!;
    expect(machine.opened).not.toContain(outside);
    expect(JSON.stringify(app)).not.toContain(SENTINEL);
    expect(app.bots[0]!.instructions).toBe("");
    if (process.getuid?.() !== 0) expect(app.unreadable).toContain("workspace/USER.md");
    chmodSync(join(home, ".openclaw/workspace/USER.md"), 0o644);
  });
});

describe("Hermes Agent", () => {
  it("reads the default home and each real profile, its personality, § memories, own skills and cron jobs", () => {
    const home = newHome();
    const secrets = plantHermes(home);
    const machine = machineAt(home);
    const look = lookForBots(machine, { now: NOW });
    const app = look.apps[0]!;
    expect(app).toMatchObject({ source: "hermes", app: "Hermes Agent", where: "~/.hermes", channels: ["telegram", "discord", "whatsapp"] });
    const [hermes, coder] = app.bots;
    expect(hermes!.name).toBe("Hermes");
    expect(hermes!.instructions).toBe("You are Hermes. Curious, patient, and honest about what you don't know.\n\nYou answer in two sentences or fewer.");
    expect(hermes!.memories).toEqual(["The user's server is a Contabo VPS.", "Deploys go through a script called deploy."]);
    expect(hermes!.userFacts).toEqual(["Name: Priya", "Works nights; never message before noon."]);
    expect(hermes!.skills.map((skill) => skill.name)).toEqual(["deploy-check", "standup"]);
    expect(hermes!.routines.map((routine) => [routine.name, routine.cron, routine.timeZone, routine.paused, routine.skills])).toEqual([
      ["Standup", "30 13 * * 1-5", "Asia/Kolkata", false, ["standup"]], ["Ping", "", "", true, []],
    ]);
    expect(hermes!.routines[1]!.schedule).toEqual({ type: "interval", everyMinutes: 30, anchorAt: NOW });
    // where a job sent its results, by app: the chat id stays there
    expect(hermes!.routines[0]!.details).toBe("sent to Telegram");
    expect(hermes!.apps).toEqual([
      { name: "github", mcpUrl: "", transport: "stdio", headerNames: [] },
      { name: "notion", mcpUrl: "https://mcp.notion.com/mcp", transport: "", headerNames: ["Authorization"] },
    ]);
    const setup = hermes!.memoryFiles!["memory/hermes-agent-setup.md"]!;
    expect(setup).toContain("- Model: anthropic/claude-sonnet-4-5 (through openrouter).");
    expect(setup).toContain("- Answered on: Telegram, Discord, WhatsApp.");
    expect(setup).toContain("- pirate: Talk like a pirate.");
    expect(setup).not.toContain("concise:");
    expect(coder).toMatchObject({ name: "Coder", description: "Reviews my pull requests", instructions: "You are a careful senior engineer.", memories: ["Prefers small diffs."] });
    expect(app.bots).toHaveLength(2);
    for (const secret of secrets) expect(machine.opened).not.toContain(secret);
    expect(JSON.stringify(look)).not.toContain(SENTINEL);
  });

  it("reads a USER.md written by hand as a markdown page, not with § entries, one fact a line under its section", () => {
    const home = newHome();
    const put = putter(home);
    put(".hermes/SOUL.md", "# Ananya\n\nWarm and direct.");
    put(".hermes/memories/USER.md", "# Memory: Sam\n\n## Who he is\n- **Sam**, 19. Lives in Jaipur.\n- Plans to move to Bangalore.\n\n## Work\n- Freelance web developer\n\n---\n");
    const bot = lookForBots(machineAt(home)).apps[0]!.bots[0]!;
    expect(bot.userFacts).toEqual(["Who he is: Sam, 19. Lives in Jaipur.", "Who he is: Plans to move to Bangalore.", "Work: Freelance web developer"]);
  });

  it("follows HERMES_HOME", () => {
    const home = newHome();
    putter(home)("custom/SOUL.md", "Elsewhere.");
    expect(lookForBots(machineAt(home, { HERMES_HOME: join(home, "custom") })).apps[0]).toMatchObject({ where: "~/custom", bots: [{ instructions: "Elsewhere." }] });
  });
});

describe("Claude Code's and Gemini CLI's own agents", () => {
  it("each become a bot: name, description, colour, its prompt, its MCP servers and how it was set up", () => {
    const home = newHome();
    const secrets = plantAgentTools(home);
    const machine = machineAt(home);
    const look = lookForBots(machine, { now: NOW });
    expect(look.apps.map((app) => [app.source, app.app, app.where, app.bots.map((bot) => bot.name)])).toEqual([
      ["claudeCode", "Claude Code", "~/.claude/agents", ["Code Reviewer"]],
      ["gemini", "Gemini CLI", "~/.gemini/agents", ["Researcher"]],
    ]);
    const [reviewer] = look.apps[0]!.bots;
    expect(reviewer).toMatchObject({ description: "Expert code review specialist. Use right after writing or changing code.", color: "blue" });
    expect(reviewer!.instructions).toMatch(/^You are a senior code reviewer\./);
    expect(reviewer!.memoryFiles!["memory/claude-code-setup.md"]).toContain("- Model: sonnet.");
    expect(reviewer!.memoryFiles!["memory/claude-code-setup.md"]).toContain("Tools it could use there: Read, Grep, Glob, Bash.");
    const [researcher] = look.apps[1]!.bots;
    expect(researcher!.apps).toEqual([{ name: "search", mcpUrl: "https://search.example.com/mcp", transport: "", headerNames: [] }]);
    for (const secret of secrets) expect(machine.opened).not.toContain(secret);
    expect(JSON.stringify(look)).not.toContain(SENTINEL);
  });
});

describe("Metal's older builds", () => {
  it("reads the bots of a left-behind ~/.openmausbot, not its helper, hidden bots or chats", () => {
    const home = newHome();
    const secrets = plantOpenMausBot(home);
    const machine = machineAt(home);
    const app = lookForBots(machine, { dataDir: join(home, ".duskbot") }).apps[0]!;
    expect(app).toMatchObject({ source: "openmausbot", app: "your earlier Metal", where: "~/.openmausbot" });
    expect(app.bots).toHaveLength(1);
    expect(app.bots[0]).toMatchObject({ name: "Ledger", title: "Bookkeeper", color: "teal", instructions: "You track every expense and flag anything odd." });
    expect(Object.keys(app.bots[0]!.memoryFiles!)).toEqual(["MEMORY.md", "memory/vendors.md"]);
    expect(app.bots[0]!.routines[0]).toMatchObject({ name: "Month end", schedule: { type: "daily", time: "09:00", weekdays: [1] } });
    for (const secret of secrets) expect(machine.opened).not.toContain(secret);
  });

  it("is not offered when it is the folder in use, or a link left by the move", () => {
    const home = newHome();
    plantOpenMausBot(home);
    expect(lookForBots(machineAt(home), { dataDir: join(home, ".openmausbot") }).apps).toEqual([]);
    const moved = newHome();
    plantOpenMausBot(moved);
    linkOldName(moved, ".opengrokbot", ".openmausbot");
    expect(lookForBots(machineAt(moved), { dataDir: join(moved, ".openmausbot") }).apps).toEqual([]);
  });

  it("answers nothing on a computer with none of these apps, and survives a corrupt registry", () => {
    expect(lookForBots(machineAt(newHome())).apps).toEqual([]);
    const home = newHome();
    putter(home)(".openmausbot/bots.json", "[{");
    writeFileSync(join(home, ".openmausbot", "routines.json"), "{");
    expect(lookForBots(machineAt(home), { dataDir: join(home, ".duskbot") }).apps).toEqual([]);
  });
});
