import { describe, expect, it } from "vitest";

import { MAUS_COLORS } from "./mascot";
import { CLASSIC_ROLE_IDS, READY_BOT_CATEGORIES, READY_BOTS, matchesReadyBot, readyBot, readyBotTemplate } from "./ready-bots";
import { DUSK_BODY_IDS, DUSK_BODY_NAMES } from "../../shared/body-migration";
import type { NewBotDefaults } from "../../shared/new-bot-defaults";

const defaults = (): NewBotDefaults => ({
  profile: {
    name: "Suggested", modelSelection: { instanceId: "claude", model: "opus" }, approvalMode: "ask",
    computer: "local", cwd: "/work/site", composio: true, color: "green",
  },
  memory: { "MEMORY.md": "- The person's own default note" },
  skills: [],
  routines: [{ name: "Mine", prompt: "Mine", schedule: { type: "daily", time: "07:00", weekdays: [1] }, enabled: true }],
});

describe("ready-made bots", () => {
  it("have unique ids and keep the six classic roles", () => {
    const ids = READY_BOTS.map((bot) => bot.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of CLASSIC_ROLE_IDS) expect(readyBot(id)).toBeDefined();
  });

  it("each has a look the app can draw, a category, and something to try", () => {
    for (const bot of READY_BOTS) {
      expect(Object.keys(MAUS_COLORS)).toContain(bot.look.color);
      expect(DUSK_BODY_IDS).toContain(bot.look.mascotBody);
      expect(READY_BOT_CATEGORIES).toContain(bot.category);
      expect(bot.tryAsking.length).toBeGreaterThanOrEqual(2);
      expect(bot.description.length).toBeLessThanOrEqual(120);
    }
  });

  it("fit the standing-instructions limit", () => {
    for (const bot of READY_BOTS) {
      expect(new TextEncoder().encode(bot.soul).length).toBeLessThan(24_000);
      expect(bot.soul.length).toBeGreaterThan(200);
    }
  });

  it("keep souls focused: a real working method, not a wall of text, in the brand's own words", () => {
    for (const bot of READY_BOTS) {
      expect(bot.soul.length, bot.id).toBeGreaterThan(1_500);
      expect(bot.soul.length, bot.id).toBeLessThanOrEqual(4_500);
      for (const text of [bot.soul, bot.description, ...bot.tryAsking, ...Object.values(bot.notes ?? {})]) {
        expect(text, bot.id).not.toMatch(/\u2014|\bDusk\b/);
      }
    }
  });

  it("have their own names, never a mascot body's, the helper's or another template's", () => {
    const names = READY_BOTS.map((bot) => bot.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const taken = [...Object.values(DUSK_BODY_NAMES), "dusk", "Metal", "mausbot"].map((name) => name.toLowerCase());
    for (const name of names) expect(taken, name).not.toContain(name);
  });

  it("tell the bot what to do unasked, when to ask, what never to do, and how to open", () => {
    for (const bot of READY_BOTS) {
      for (const heading of ["## Your job", "## On your own", "## Tools", "## Ask or act", "## How you reply", "## Never", "## First message"]) expect(bot.soul, bot.id).toContain(heading);
    }
  });

  it("only ever bring paused routines and notes under the memory folder", () => {
    for (const bot of READY_BOTS) {
      for (const routine of bot.routines ?? []) expect(routine.enabled).toBe(false);
      for (const path of Object.keys(bot.notes ?? {})) expect(path).toMatch(/^(MEMORY\.md|memory\/[a-z0-9-]+\.md)$/);
    }
  });
});

describe("readyBotTemplate", () => {
  const books = readyBot("bookkeeper")!;

  it("sets who the bot is and how it looks", () => {
    const { profile } = readyBotTemplate(defaults(), books);
    expect(profile).toMatchObject({ name: "Penny", title: "Bookkeeper", soul: books.soul, color: "brown", mascotBody: "tofu" });
  });

  it("never changes the person's model, approval level, computer, folder or apps", () => {
    const { profile } = readyBotTemplate(defaults(), books);
    expect(profile).toMatchObject({
      modelSelection: { instanceId: "claude", model: "opus" }, approvalMode: "ask", computer: "local", cwd: "/work/site", composio: true,
    });
  });

  it("adds notes beside the person's own and appends its routines paused", () => {
    const template = readyBotTemplate(defaults(), books);
    expect(template.memory["MEMORY.md"]).toContain("The person's own default note");
    expect(template.memory["MEMORY.md"]).toContain("memory/books.md");
    expect(template.memory["memory/books.md"]).toContain("title: Books");
    expect(template.routines.map((routine) => [routine.name, routine.enabled])).toEqual([["Mine", true], ["Weekly reconcile", false]]);
  });

  it("leaves the defaults it was given untouched", () => {
    const given = defaults();
    readyBotTemplate(given, books);
    expect(given).toEqual(defaults());
  });
});

describe("matchesReadyBot", () => {
  it("finds a bot by name, title, description or category, ignoring case", () => {
    const edie = readyBot("writer")!;
    expect(["edie", "EDITOR", "in your voice", "writing", ""].every((query) => matchesReadyBot(edie, query))).toBe(true);
    expect(matchesReadyBot(edie, "spreadsheet")).toBe(false);
  });
});

describe("the social media manager", () => {
  const social = readyBot("social")!;

  it("previews posts and publishes only when asked", () => {
    expect(social).toMatchObject({ title: "Social media manager", category: "work", apps: ["linkedin", "twitter"] });
    expect(social.soul).toContain("When you write a post, show a preview of it with show_html first.");
    expect(social.soul).toContain("Never publish a post unless the user asks for that post to go out.");
    expect(social.routines).toEqual([expect.objectContaining({ name: "Weekly post plan", enabled: false })]);
    expect(social.routines![0]!.prompt).toContain("as drafts");
  });

  it("brings its notes and leaves the person's approval level, so publishing asks as their other bots do", () => {
    const template = readyBotTemplate(defaults(), social);
    expect(template.profile.approvalMode).toBe("ask");
    expect(template.memory["memory/social.md"]).toContain("title: Social media");
    expect(template.memory["MEMORY.md"]).toContain("memory/social.md");
  });
});
