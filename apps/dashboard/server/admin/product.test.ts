import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../analytics/sink.ts";
import { appFirstRun, featureRows, productReport } from "./product.ts";

const DAY = 86_400_000;
const to = 30 * DAY;
let seq = 0;
const ev = (name: string, at: number, who: string, props: StoredEvent["props"] = {}): StoredEvent => ({ id: `e${seq++}`, name, at, accountId: who, props });

describe("featureRows", () => {
  it("ranks features by people and finds the ones tried once", () => {
    const events: StoredEvent[] = [];
    for (const who of ["a", "b", "c", "d"]) {
      events.push(ev("app_open", 2 * DAY, who), ev("app_feature", 2 * DAY, who, { feature: "routine_created" }));
      if (who !== "d") events.push(ev("app_open", 27 * DAY, who), ev("app_feature", 27 * DAY, who, { feature: "routine_created" }));
    }
    events.push(ev("app_feature", 3 * DAY, "a", { feature: "voice_used" }));
    const rows = featureRows(events, 0, to);
    expect(rows[0]).toMatchObject({ feature: "routine_created", people: 4, adoption: 1, repeat: 0.75, triedOnce: 1 });
    expect(rows[1]).toMatchObject({ feature: "voice_used", people: 1, triedOnce: 1, lift: null });
  });
});

describe("productReport", () => {
  it("names the biggest funnel drop and the lowest rated moment", () => {
    const events = [
      ...[5, 4, 2].map((score, i) => ev("app_feedback", DAY, `p${i}`, { score, moment: "after_routine" })),
      ...[5, 5, 5].map((score, i) => ev("app_feedback", DAY, `q${i}`, { score, moment: "after_replies" })),
      ev("app_action", DAY, "a", { name: "reply_reaction", emoji: "yes", on: true }),
      ev("app_action", DAY, "b", { name: "reply_reaction", emoji: "no", on: true }),
      ev("app_action", DAY, "a", { name: "cloud_card_action", action: "not_now" }),
    ];
    const report = productReport({ from: 0, to, events, funnel: [{ id: "visit", label: "visited the site", count: 100 }, { id: "signup", label: "signed up", count: 10 }, { id: "paid", label: "paid", count: 5 }] });
    expect(report.improve[0]).toMatchObject({ area: "funnel" });
    expect(report.improve[0]!.title).toContain("90%");
    expect(report.improve.find(item => item.area === "rating")?.title).toContain("after routine");
    expect(report.likes.reactions).toEqual({ positive: 1, negative: 1, total: 2 });
    expect(report.likes.feedback.scores).toEqual([0, 1, 0, 1, 4]);
    expect(report.moments.find(row => row.name === "cloud_card_action")?.outcomes).toEqual([{ key: "not_now", count: 1 }]);
  });
});

describe("fix first, from what the site and apps show now", () => {
  const app = (name: string, at: number, install: string, version: string, props: StoredEvent["props"] = {}): StoredEvent =>
    ({ id: `e${seq++}`, name, at, accountId: null, props, ctx: { install, app: { platform: "darwin", version } } } as unknown as StoredEvent);
  const site = (at: number, visitor: string, page: string, props: StoredEvent["props"]): StoredEvent =>
    ({ id: `e${seq++}`, name: "site_goal", at, accountId: null, props, ctx: { visitor, page } } as unknown as StoredEvent);
  const funnel = [{ id: "visit", label: "visited the site", count: 10 }, { id: "signup", label: "signed up", count: 10 }];

  it("ranks an error the newest app still throws over a bigger one only older apps had, and says which", () => {
    const events = [
      ...Array.from({ length: 6 }, (_, i) => app("app_error", DAY, `old${i}`, "0.1.141", { kind: "window", code: "rejection" })),
      ...Array.from({ length: 3 }, (_, i) => app("app_error", 2 * DAY, `new${i}`, "0.2.14", { kind: "window", code: "error" })),
      app("app_open", 2 * DAY, "new0", "0.2.14"),
    ];
    const report = productReport({ from: 0, to, events, funnel });
    const item = report.improve.find(row => row.area === "errors")!;
    expect(item.title).toContain("window: error");
    expect(item.detail).toContain("still seen on 0.2.14");
    expect(report.errors.app.find(row => row.key === "window: rejection")).toMatchObject({ lastVersion: "0.1.141", latestVersion: "0.2.14" });
  });

  it("names rage clicks by what was clicked and where, and drops a section the site no longer shows", () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => site(DAY, `w${i}`, "/", { goal: "rage_click", section: "wl" })),
      site(20 * DAY, "h0", "/", { goal: "rage_click", section: "hero", label: "meet_dusk_bot" }),
      site(20 * DAY, "h1", "/", { goal: "rage_click", section: "hero", label: "meet_dusk_bot" }),
    ];
    const report = productReport({ from: 0, to, events, funnel });
    expect(report.site.rage).toEqual([{ key: "meet Metal in the hero section of /", count: 2, people: 2 }]);
    expect(report.improve.find(row => row.area === "site")?.title).toBe('rage clicks on "meet Metal in the hero section of /"');
  });

  it("counts an account that set up in the desktop app as onboarded, not lost at the web welcome", () => {
    const events = [ev("onboarding_step", DAY, "a", { step: "name" }), ev("app_paired", DAY + 60_000, "a"), ev("onboarding_step", DAY, "b", { step: "name" })];
    const report = productReport({ from: 0, to, events, funnel });
    expect(report.onboarding.find(row => row.step === "name")).toMatchObject({ reached: 2, leftHere: 1 });
  });
});

describe("appFirstRun", () => {
  it("counts the desktop first run's screens per path, so the drop at each one shows", () => {
    const step = (who: string, name: string, extra: StoredEvent["props"] = {}) => ev("app_action", DAY, who, { name: "onboarding_step", step: name, ...extra });
    const events = [
      step("a", "place"), step("b", "place"), step("c", "place"), step("r", "place", { replay: true }),
      step("a", "checkout", { path: "cloud", ms: 4000 }), step("a", "ai", { path: "cloud" }), step("a", "making", { path: "cloud" }),
      step("b", "checkout", { path: "cloud", ms: 6000 }),
      step("c", "ai", { path: "mac", ms: 2000 }), step("c", "bring", { path: "mac" }),
      ev("app_action", DAY, "c", { name: "onboarding_completed", reason: "completed", path: "mac" }),
    ];
    const rows = appFirstRun(events);
    const at = (path: string, name: string) => rows.find((row) => row.path === path && row.step === name);
    expect(at("all", "place")).toMatchObject({ reached: 3 });
    expect(at("cloud", "checkout")).toMatchObject({ reached: 2, medianMsBefore: 5000 });
    expect(at("cloud", "making")).toMatchObject({ reached: 1 });
    expect(at("cloud", "done")).toMatchObject({ reached: 0 });
    expect(at("mac", "done")).toMatchObject({ reached: 1 });
    expect(at("mac", "phone"), "the hidden phone step only once someone reaches it").toBeUndefined();
  });
});
