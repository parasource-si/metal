import { describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import { cloudRefusal, PLACE_ACTIONS, PLACE_EN, PLACE_STATES, PLACE_WORDS, placeRowText, placeRowView, placeState, placeView, placeViewOf, type PlaceFacts, type PlaceSource, type PlaceState } from "./place-view.ts";

const params = { bot: "Scout", engine: "Claude", model: "Claude Fable 5", computer: "Team desk", reason: "Enable screen access.", cause: "The desktop did not answer." };
const facts = (patch: Partial<PlaceFacts> = {}): PlaceFacts => ({
  place: "cloud", server: "my-cloud", bot: "Scout", role: "admin", toolsAllowComputer: true, browserOn: true,
  engine: { name: "Claude", model: "Claude Fable 5", computer: true, browser: true, signedIn: true },
  ...patch,
});

describe("one line and at most one action for every place", () => {
  it("words every current and stored legacy state without unresolved placeholders", () => {
    for (const state of PLACE_STATES) for (const role of ["admin", "user"] as const) {
      const view = placeViewOf(state, params, { role, server: "my-cloud" });
      expect(view.short.trim(), state).not.toBe("");
      expect(view.line.trim(), state).not.toBe("");
      expect(`${view.short} ${view.line} ${view.action?.label ?? ""}`, state).not.toMatch(/\n|\{\w+\}|\x42oat|credits|hours left/i);
    }
    expect(PLACE_ACTIONS).toContain("add-vps");
    expect(PLACE_ACTIONS).not.toContain("add-\x62oat-key");
  });

  it("gives a user no action that changes a setting and says who can change it", () => {
    for (const state of PLACE_STATES) {
      const admin = placeViewOf(state, params, { role: "admin", server: "my-cloud" });
      const user = placeViewOf(state, params, { role: "user", server: "my-cloud" });
      if (!admin.action || ["try-again", "watch", "clear-pin", "open-computer-panel"].includes(admin.action.id)) expect(user, state).toEqual(admin);
      else if (["start", "wake"].includes(admin.action.id)) expect(user, state).toEqual({ ...admin, action: null });
      else {
        expect(user.action, state).toBeNull();
        expect(user.line, state).toBe(`${admin.line} Ask an admin to change it.`);
      }
    }
  });

  it("mirrors the English catalog and keeps transport details out of the wording", () => {
    const catalog = en as Record<string, string>;
    for (const [key, value] of Object.entries(PLACE_EN)) expect(catalog[key], key).toBe(value);
    const mirrored = new Set(Object.keys(PLACE_EN));
    const inCatalog = Object.keys(catalog).filter((key) => /^place\.(view|action)\./.test(key) || key === "place.askAdmin" || key === "place.backOnAuto");
    expect(inCatalog.filter((key) => !mirrored.has(key))).toEqual([]);
    for (const sentence of Object.values(PLACE_WORDS)) expect(sentence).not.toMatch(/\x42oat|\bbox\b|Metal|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
  });

  it("routes stored provider and billing states to VPS setup", () => {
    for (const state of ["cc-no-hours", "cc-at-once", "cc-ended", "cc-provider", "cc-on-my-cloud", "cc-needs-key"] as const) {
      expect(placeViewOf(state, { ...params, words: "Old provider billing", hours: 50 }, { role: "admin", server: "mac" })).toMatchObject({
        short: "Add your own machine", line: "Connect your own machine in settings to give bots their own private desktops.",
        action: { id: "add-vps", label: "Add your own machine" },
      });
    }
    expect(placeViewOf("cc-unavailable", {}, { role: "admin" })).toMatchObject({ action: { id: "try-again" } });
  });
});

describe("VPS place facts", () => {
  it("checks model capability, tool access, sign-in and configured VPS before computer state", () => {
    expect(placeState(facts({ engine: { name: "Llama", computer: false, browser: true, signedIn: true } })).state).toBe("cc-cannot");
    expect(placeState(facts({ toolsAllowComputer: false })).state).toBe("cc-tools-off");
    expect(placeState(facts({ engine: { name: "Claude", computer: true, browser: true, signedIn: false } }))).toEqual({ state: "cc-sign-in", params: { bot: "Scout", engine: "Claude" } });
    expect(placeState(facts({ vpsConfigured: false, computer: "on" })).state).toBe("cc-needs-key");
    for (const [computer, state] of [["none", "cc-new"], ["starting", "cc-starting"], ["waking", "cc-waking"], ["on", "cc-on"], ["asleep", "cc-asleep"]] as const) {
      expect(placeState(facts({ computer })).state).toBe(state);
    }
    expect(placeState(facts()).state).toBe("vps");
    expect(placeState(facts({ backend: "box", plan: true })).state).toBe("vps");
    expect(placeState(facts({ refusal: { state: "cc-no-start", params: {} } })).state).toBe("cc-no-start");
  });

  it("retains Auto, Off, browser, host computer and local VM choices", () => {
    expect(placeState(facts({ place: "auto" })).state).toBe("auto");
    expect(placeState(facts({ place: "auto", teamComputer: "Team desk" }))).toEqual({ state: "auto-team", params: { bot: "Scout", computer: "Team desk" } });
    expect(placeState(facts({ place: "off" })).state).toBe("off");
    expect(placeState(facts({ place: "browser" })).state).toBe("browser");
    expect(placeState(facts({ place: "browser", browserOn: false })).state).toBe("browser-off");
    expect(placeState(facts({ place: "browser", engine: { name: "X", computer: true, browser: false, signedIn: true } })).state).toBe("browser-cannot");
    expect(placeState(facts({ place: "local", local: { ready: false, reason: "Not yet." } }))).toEqual({ state: "local-unavailable", params: { bot: "Scout", reason: "Not yet." } });
    expect(placeState(facts({ place: "vm", engine: { name: "X", computer: false, browser: true, signedIn: true } })).state).toBe("vm-cannot");
  });

  it("describes the available computers on the server where Auto runs", () => {
    expect(placeView(facts({ place: "auto" })).line).toContain("private desktop on your own machine");
    expect(placeView(facts({ place: "auto", server: "pc" })).line).toContain("private desktop on this computer");
    expect(placeView(facts({ place: "auto", server: "linux" })).line).toContain("running private desktop");
  });
});

describe("a failed place and its source", () => {
  const row = (source: PlaceSource, state: PlaceState = "cc-unavailable") => ({ state, params: { bot: "Scout" }, source });
  it("offers retry, clearing a pin or changing a routine at the appropriate source", () => {
    const view = (source: PlaceSource, mode?: "simple" | "advanced") => placeRowView(row(source), { role: "admin", mode, worksOnLabel: "Auto" });
    expect(view("works-on").action?.id).toBe("try-again");
    expect(view("pin", "advanced").action).toEqual({ id: "clear-pin", label: "Clear this conversation's place" });
    expect(view("pin", "simple").action).toEqual({ id: "clear-pin", label: "Use Auto" });
    expect(view("auto-pin").line).toContain("This conversation is back on auto.");
    expect(view("routine").action?.id).toBe("change-routine");
    expect(view("room").action).toBeNull();
  });
  it("keeps a missing VPS fix across every source and gives phones the same action", () => {
    for (const source of ["works-on", "pin", "auto-pin", "routine", "room"] as const) expect(placeRowView(row(source, "cc-needs-key"), { role: "admin" }).action?.id).toBe("add-vps");
    expect(placeRowText(row("works-on", "cc-needs-key"))).toBe("Connect your own machine in settings to give bots their own private desktops. Add your own machine in Settings → Computer.");
    expect(placeRowText(row("routine"))).toContain("Change where this routine runs.");
    expect(placeRowText(row("room"))).not.toContain("Try again.");
  });
});

describe("computer startup refusals", () => {
  it("classifies desktop startup and cleanup failures without exposing retired provider billing", () => {
    expect(cloudRefusal({ message: "this cloud computer is being deleted" }, true).state).toBe("cc-clearing");
    for (const [message, code, status] of [["desktop did not become ready", undefined, 500], ["Old subscription charge", "subscription_inactive", 402], ["Old hours limit", "hours_used", 429]] as const) {
      expect(cloudRefusal({ message, code, status }, true)).toEqual({ state: "cc-no-start", params: {} });
    }
    expect(cloudRefusal({ message: "not answering" }, false)).toEqual({ state: "cc-no-start", params: {} });
  });
});
