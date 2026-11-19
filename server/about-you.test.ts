import { describe, expect, it } from "vitest";
import { aboutYouPrompt, type AboutYouFacts } from "./about-you.ts";

const base: AboutYouFacts = {
  name: "Dusk", home: "mac", computer: null, browser: false, routines: false, apps: false,
  memory: { enabled: true, file: "/data/bots/b1/workspace/MEMORY.md", topicDir: "/data/bots/b1/workspace/memory", managedWrites: true },
};

describe("aboutYouPrompt", () => {
  it("names the bot, its home and its own memory", () => {
    const text = aboutYouPrompt(base);
    expect(text).toContain("you are Dusk, a Metal");
    expect(text).toContain("the person's Mac");
    expect(text).toContain("/data/bots/b1/workspace/MEMORY.md");
    expect(text).toContain("memory_update");
    expect(text).toContain("never from the underlying model vendor");
  });
  it("claims only what it has", () => {
    const bare = aboutYouPrompt(base);
    expect(bare).not.toMatch(/browser|routines|Computer:/);
    expect(bare).toContain("No connected apps");
    const full = aboutYouPrompt({ ...base, home: "cloud", computer: "vps", browser: true, routines: true, apps: true, memory: { enabled: false, managedWrites: true } });
    expect(full).toContain("dusk cloud");
    expect(full).toContain("Linux desktop on the person's VPS");
    expect(full).toContain("built-in browser");
    expect(full).toContain("routines");
    expect(full).toContain("memory is turned off");
    expect(full).not.toContain("MEMORY.md");
  });
  it("stays compact", () => {
    const words = aboutYouPrompt({ ...base, computer: "local", browser: true, routines: true, apps: true }).split(/\s+/).length;
    expect(words).toBeLessThan(250);
  });
});
