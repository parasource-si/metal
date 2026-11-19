import { describe, expect, it } from "vitest";

import { introFallback, introMoment, introName, introPrompt, toneSamples, writingHabits, type IntroFacts } from "./bot-intro.ts";

const base = (more: Partial<IntroFacts> = {}): IntroFacts => ({
  name: "Edie", apps: [], place: "this Mac", teammates: [], style: "warm", origin: { kind: "scratch" }, samples: [],
  moment: introMoment(Date.parse("2026-11-16T09:05:00Z"), "Europe/Lisbon"), ...more,
});

describe("a new bot's intro words", () => {
  it("capitalises a name typed in lower case and keeps one already cased", () => {
    expect(introName("writer")).toBe("Writer");
    expect(introName("McBot")).toBe("McBot");
    expect(introFallback(undefined, { name: "writer" })).toBe("Hi, I'm Writer. Tell me what you'd like to start with and I'll take it from there.");
  });

  it("reads the person's local time and day", () => {
    expect(introMoment(Date.parse("2026-11-16T09:05:00Z"), "Europe/Lisbon")).toMatchObject({ weekday: "Monday", partOfDay: "morning", hour: 9 });
    expect(introMoment(Date.parse("2026-11-14T02:10:00Z"), "Europe/Lisbon")).toMatchObject({ weekday: "Saturday", partOfDay: "night", hour: 2 });
    expect(introMoment(Date.parse("2026-11-16T09:05:00Z"), "Asia/Kolkata")).toMatchObject({ weekday: "Monday", partOfDay: "afternoon", hour: 14 });
  });

  it("keeps three short lines of the person's own for their tone", () => {
    const to = (text: string) => ({ to: "Penny", text });
    expect(toneSamples(["hey can u check this", "/compact", "", "ok", "thx", "later"].map(to)).map((line) => line.text)).toEqual(["hey can u check this", "ok", "thx"]);
    expect(toneSamples([to("x".repeat(400))])[0]!.text).toHaveLength(161);
  });

  it("reads how the person writes, for the hello to mirror", () => {
    expect(writingHabits([{ text: "hey can u check this" }, { text: "ok thx" }])).toBe("short, with no emoji");
    expect(writingHabits([{ text: "Could you look at the October numbers? 🙏" }])).toBe("short, with emoji");
    expect(writingHabits([])).toBeNull();
  });

  it("grounds the hello in the moment, the template, apps, place, style and team it is given", () => {
    const prompt = introPrompt(base({
      template: { category: "writing", title: "Writer and editor", tryAsking: ["Tighten this email"], apps: ["gmail"], routines: [] },
      origin: { kind: "template" }, person: "Sam", teammates: [{ name: "Ledger", title: "Bookkeeper" }],
      lastSeen: { bot: "Ledger", minutesAgo: 3 }, samples: [{ to: "Ledger", text: "can u check the vat thing" }], style: "casual",
    }));
    expect(prompt).toContain("Your name, as you write it: Edie.");
    expect(prompt).toContain('A plain "yes" should answer every offer');
    expect(prompt).toContain("It is Monday morning for them.");
    expect(prompt).toContain("Europe/Lisbon");
    expect(prompt).toContain("You run on this Mac.");
    expect(prompt).toContain("picked you from the ready-made bots: \"Writer and editor\" (writing)");
    expect(prompt).toContain("Before this they were talking to Ledger, 3 minutes ago.");
    expect(prompt).toContain("to Ledger: \"can u check the vat thing\"");
    expect(prompt).toContain("They write short, with no emoji");
    expect(prompt).toContain("in Sentence case (capital letters where they belong, your name included) whatever case they type in");
    expect(prompt).toContain("chosen style (casual)");
    expect(prompt).toContain("not a list");
    expect(prompt).toContain("No connected apps are available to you yet; you work best with gmail");
    expect(prompt).toContain("Their other bots: Ledger (Bookkeeper).");
    expect(prompt).toContain("never an em dash");
  });

  it("names a bot made by another bot, and a from-scratch bot with nothing else to go on", () => {
    expect(introPrompt(base({ origin: { kind: "bot", by: "Metal" } }))).toContain("Metal made you just now because the person asked it to");
    const prompt = introPrompt(base({ apps: null, language: "de" }));
    expect(prompt).not.toContain("Connected apps you can use now");
    expect(prompt).toContain("made you from scratch");
    expect(prompt).toContain("With no lines to go on, use no emoji");
    expect(prompt).toContain("Write it in German.");
  });

  it("keeps the nod to their day to one short clause", () => {
    const prompt = introPrompt(base());
    expect(prompt).toContain("let it color one short clause of your first line the way a friend's would");
    expect(prompt).toContain("never a whole sentence about their day");
  });
});
