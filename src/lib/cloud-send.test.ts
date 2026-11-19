import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { moveLine } from "./cloud-send";

beforeEach(() => { setLocale("en"); });
afterEach(() => { setLocale("en"); });

describe("the one-time move's line", () => {
  it("never says everything is here when a connector stayed on this computer, and says why", () => {
    const done = { phase: "done" as const, phone: false, counts: { bots: 13, skills: 0, logins: 0, onePassword: false, chats: 0, routines: 0 } };
    expect(moveLine(done, "cloud")?.text).toContain("Everything from this computer is here");
    const line = moveLine({ ...done, stayed: [{ name: "fetch", needs: "uvx" }, { name: "easy" }] }, "cloud");
    expect(line).toMatchObject({ kind: "done", text: "Everything else from this computer is here. These stayed on it:" });
    expect(line?.extra).toEqual([
      "fetch: it needs uvx, which isn't here, so bots here can't use it.",
      "easy: it only works on that computer, so bots here can't use it.",
    ]);
    expect(moveLine({ ...done, place: "Garage server", stayed: [{ name: "easy" }] }, "cloud")?.extra).toEqual(["easy: it only works on that computer, so bots here can't use it."]);
  });

  it("says the bots are on their way on whichever page is open, with no counts and no names of what holds it", () => {
    expect(moveLine({ phase: "copy" }, "local")).toMatchObject({ kind: "sending", text: "Moving your bots to dusk cloud…" });
    expect(moveLine({ phase: "copy", chats: { done: 34, total: 120 } }, "local")?.text).toBe("Moving your bots to dusk cloud…");
    expect(moveLine({ phase: "copy", chats: { done: 34, total: 120 } }, "cloud")?.text).toBe("Your bots are on their way here…");
    expect(moveLine({ phase: "wait", waitingFor: "Scout" }, "local")?.text).toBe("Moving your bots to dusk cloud…");
    expect(moveLine({ phase: "wait", waitingFor: "Launch room", waitingWhat: "room" }, "cloud")?.text).toBe("Your bots are on their way here…");
    expect(moveLine({ phase: "wait", waitingFor: "", waitingWhat: "sign-in" }, "local")?.text, "no name: what it is").toBe("Moving your bots to dusk cloud…");
    expect(moveLine({ phase: "wait" }, "local")?.text, "a quiet moment, nobody holding it").toBe("Moving your bots to dusk cloud…");
    expect(moveLine({ phase: "finishing" }, "cloud")).toMatchObject({ kind: "sending", text: "Moving your bots to dusk cloud… almost there" });
  });

  it("to a server of the person's own, names it on this computer's page, with Try again after a day of failing, and nowhere else", () => {
    const place = "Garage server";
    expect(moveLine({ phase: "copy", place }, "local")).toEqual({ kind: "sending", text: "Moving your bots to Garage server…", extra: [], place });
    expect(moveLine({ phase: "copy", chats: { done: 3, total: 9 }, place }, "local")?.text).toBe("Moving your bots to Garage server… 3 of 9 chats");
    expect(moveLine({ phase: "wait", waitingFor: "Scout", place }, "local")?.text).toBe("Moving your bots to Garage server… waiting for Scout to finish");
    expect(moveLine({ phase: "wait", waitingFor: "", waitingWhat: "sign-in", place }, "local")?.text).toBe("Moving your bots to Garage server… waiting for a sign-in to finish");
    expect(moveLine({ phase: "wait", waitingFor: "", place }, "local")?.text).toBe("Moving your bots to Garage server… waiting for your bots to finish");
    expect(moveLine({ phase: "finishing", place }, "local")?.text).toBe("Moving to Garage server… almost done");
    expect(moveLine({ phase: "copy", updating: true, place }, "local")?.text).toBe("Update Metal on Garage server. Your bots move there once it's updated.");
    expect(moveLine({ phase: "copy", failing: { error: "Garage server has other people on it now, so your bots can't move there." }, place }, "local"))
      .toMatchObject({ kind: "failed", text: "Your bots couldn't move to Garage server yet: Garage server has other people on it now, so your bots can't move there.", retry: true, place });
    expect(moveLine({ phase: "finishing", failing: { error: null }, place }, "local")).toMatchObject({ kind: "failed", text: "Your bots couldn't move to Garage server yet.", retry: true });
    expect(moveLine({ phase: "copy", place }, "cloud"), "only this computer's page hears of it").toBeNull();
    expect(moveLine({ phase: "done", phone: true, place }, "local"), "once done the window shows Garage server").toBeNull();
    expect(JSON.stringify(moveLine({ phase: "copy", place }, "local"))).not.toContain("My Cloud");
  });

  it("with My Cloud too old to take a move, says it is updating and the move starts after, on either page", () => {
    for (const page of ["local", "cloud"] as const) {
      expect(moveLine({ phase: "copy", updating: true }, page)).toEqual({ kind: "sending", text: "dusk cloud is updating. Your bots move as soon as it's done.", extra: [] });
    }
  });

  it("after a day of failing says one friendly line, with Try again, never what My Cloud said", () => {
    expect(moveLine({ phase: "copy", failing: { error: "My Cloud did not answer." } }, "local")).toEqual({ kind: "failed", text: "Something got in the way. Your bots are safe here.", extra: [], retry: true });
    expect(moveLine({ phase: "finishing", failing: { error: null } }, "local")?.text).toBe("Something got in the way. Your bots are safe here.");
  });

  it("names what did not move and why on the done line, and on a failing line only for a server of the person's own", () => {
    const items = [{ label: "tidy", error: "Metal on this computer did not answer." }, { label: "reply to email", error: "this app automation stays on the computer it came from." }];
    const lines = ["tidy: Metal on this computer did not answer.", "reply to email: this app automation stays on the computer it came from."];
    expect(moveLine({ phase: "copy", failing: { error: "Some of this computer's things did not reach My Cloud.", items } }, "local")).toMatchObject({ kind: "failed", retry: true, extra: [] });
    expect(moveLine({ phase: "copy", failing: { error: null, items }, place: "Garage server" }, "local")).toMatchObject({ kind: "failed", retry: true, extra: lines, place: "Garage server" });
    const left = items.slice(1);
    expect(moveLine({ phase: "done", phone: false, left }, "cloud")).toMatchObject({ kind: "done", text: "Everything else from this computer is here. These stayed on it:", extra: lines.slice(1) });
    expect(moveLine({ phase: "done", phone: false, left, place: "Garage server" }, "cloud")).toMatchObject({ kind: "done", extra: lines.slice(1), place: "Garage server" });
    expect(moveLine({ phase: "done", phone: false, left, place: "Garage server" }, "local")).toBeNull();
  });

  it("says once on My Cloud's page what arrived and the phone to pair; on this computer, coming home", () => {
    const done = moveLine({ phase: "done", counts: { bots: 4, skills: 2, logins: 2, onePassword: true, chats: 148, routines: 2 }, phone: true }, "cloud");
    expect(done).toMatchObject({ kind: "done", text: "Everything from this computer is here: 4 bots, 2 skills, 2 logins, 1Password, 148 chats, and 2 routines.", phone: true,
      extra: [] });
    expect(moveLine({ phase: "done", phone: false }, "cloud")).toMatchObject({ text: "Everything from this computer is here.", extra: [] });
    expect(moveLine({ phase: "done", phone: true }, "local"), "the done line is My Cloud's").toBeNull();
    expect(moveLine({ phase: "home-again" }, "local")?.text).toContain("your bots are back on this computer");
    expect(moveLine({ phase: "back", lost: true }, "local")?.text).toContain("couldn't come back");
    expect(moveLine({ phase: "back" }, "cloud")).toBeNull();
  });

  it("is in every language's own words", () => {
    setLocale("de");
    expect(moveLine({ phase: "copy" }, "local")?.text).toBe("Deine Bots ziehen zu dusk cloud um…");
    expect(moveLine({ phase: "copy", updating: true }, "local")?.text).toBe("dusk cloud wird gerade aktualisiert. Deine Bots ziehen um, sobald das erledigt ist.");
    expect(moveLine({ phase: "wait", waitingFor: "", waitingWhat: "sign-in" }, "local")?.text).toBe("Deine Bots ziehen zu dusk cloud um…");
  });
});

describe("the line on a computer whose bots came home to another one", () => {
  const since = Date.UTC(2026, 9, 21, 12);
  it("names that computer and the date of this computer's own copy, with routines off, and closes like the others", () => {
    expect(moveLine({ phase: "back", elsewhere: { name: "MacBook Air", since } }, "local"))
      .toEqual({ kind: "done", text: "Your bots came back to MacBook Air. This computer keeps its copy from October 21, 2026, with routines off.", extra: [] });
    expect(moveLine({ phase: "back", elsewhere: { name: "MacBook Air" } }, "local")?.text, "a copy already deleted is not offered").toBe("Your bots came back to MacBook Air.");
    expect(moveLine({ phase: "back", elsewhere: { name: "MacBook Air", since } }, "cloud")).toBeNull();
    setLocale("de");
    expect(moveLine({ phase: "back", elsewhere: { name: "MacBook Air", since } }, "local")?.text)
      .toBe("Deine Bots sind zurück auf MacBook Air. Dieser Computer behält seine Kopie vom 21. Oktober 2026, mit ausgeschalteten Automatisierungen.");
  });
});

describe("the line on a computer whose bots come home because the person keeps them here", () => {
  it("says they are on their way on either page (or wait for My Cloud's update), and once home, on this computer only, that they run here", () => {
    for (const page of ["local", "cloud"] as const) {
      expect(moveLine({ phase: "keeping" }, page)).toEqual({ kind: "sending", text: "Bringing this computer's bots back from my cloud…", extra: [] });
      expect(moveLine({ phase: "keeping", updating: true }, page)?.text).toBe("My cloud is updating. This computer's bots come back once it's done.");
    }
    expect(moveLine({ phase: "back", kept: true }, "local"))
      .toEqual({ kind: "done", text: "This computer's bots are back here, and their routines run on this computer. dusk cloud keeps a copy of them with their routines off.", extra: [] });
    expect(moveLine({ phase: "back", kept: true }, "cloud")).toBeNull();
  });
});

describe("the line on a computer whose Cloud is gone while My Cloud is another", () => {
  it("says once, on this computer only, that the bots are back as they were at the move, with their routines off", () => {
    expect(moveLine({ phase: "back", gone: true }, "local")).toEqual({ kind: "done", extra: [],
      text: "The dusk cloud your bots moved to has ended, so they're back on this computer as they were when they moved. Their routines are off: switch on the ones you want." });
    expect(moveLine({ phase: "back", gone: true }, "cloud")).toBeNull();
  });
});
