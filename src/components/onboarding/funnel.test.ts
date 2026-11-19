import { describe, expect, it } from "vitest";
import { aiName, aiTiles, freeModel, funnelSteps, nextStep, previousStep } from "./funnel";

const ai = (instanceId: string, driverKind: string, ready = false, extra: Record<string, unknown> = {}) => ({
  instanceId, driverKind, displayName: instanceId, access: "subscription", snapshot: { state: ready ? "available" : "unavailable", ...extra },
});
const ready = (instance: { snapshot: { state: string } }) => instance.snapshot.state === "available";

describe("the funnel's steps", () => {
  it("opens on the hello and the AI everywhere, then the account where there is none yet, then on the desktop app where bots live", () => {
    expect(funnelSteps({ account: true, desktop: true })).toEqual(["welcome", "account", "place", "ai"]);
    expect(funnelSteps({ account: false, desktop: false })).toEqual(["welcome", "ai"]);
  });

  it("skips the hello on a server opened from the desktop app, where the person already met Metal", () => {
    expect(funnelSteps({ account: false, desktop: false, hello: false })).toEqual(["ai"]);
  });

  it("on a cloud the desktop app set up: the hello and that computer's bots when it has some, never a second AI step", () => {
    expect(funnelSteps({ account: false, desktop: false, aiAsked: true })).toEqual(["welcome"]);
    expect(funnelSteps({ account: false, desktop: false, cloudBring: true, phone: true, permissions: true, aiAsked: true })).toEqual(["welcome", "bring"]);
  });

  it("asks for an AI once in a whole journey: the desktop's dusk cloud path has the only one", () => {
    const desktop = funnelSteps({ account: true, desktop: true, bring: true, path: "cloud" });
    const onCloud = funnelSteps({ account: false, desktop: false, cloudBring: true, aiAsked: true });
    expect([...desktop, ...onCloud].filter((step) => step === "ai")).toHaveLength(1);
  });

  it("offers bringing things in on this computer's own window, after the place", () => {
    expect(funnelSteps({ account: false, desktop: true, bring: true })).toEqual(["welcome", "place", "ai", "bring"]);
    expect(funnelSteps({ account: false, desktop: true, bring: false })).not.toContain("bring");
    expect(funnelSteps({ account: false, desktop: true, bring: true, path: "cloud" }), "on dusk cloud too, before the cloud is made")
      .toEqual(["welcome", "place", "checkout", "ai", "bring", "making"]);
  });

  it("shows the phone only while the phone app is offered, on this computer's own window", () => {
    expect(funnelSteps({ account: false, desktop: true, bring: true, phone: true })).toEqual(["welcome", "place", "ai", "bring", "phone"]);
    expect(funnelSteps({ account: false, desktop: false, phone: true })).toEqual(["welcome", "ai"]);
    expect(funnelSteps({ account: false, desktop: true, path: "cloud", phone: true })).not.toContain("phone");
  });

  it("on dusk cloud goes from the place straight to the browser's checkout, then the cloud being made", () => {
    const steps = funnelSteps({ account: true, desktop: true, bring: true, path: "cloud", phone: true });
    expect(steps, "the account and the place come before the AI").toEqual(["welcome", "account", "place", "checkout", "ai", "bring", "making"]);
    expect(nextStep(steps, "place")).toBe("checkout");
    expect(nextStep(steps, "checkout")).toBe("ai");
    expect(nextStep(steps, "ai")).toBe("bring");
    expect(nextStep(steps, "bring")).toBe("making");
    expect(nextStep(steps, "making"), "the chat comes after the last").toBeNull();
    expect(previousStep(steps, "checkout"), "an easy way back before paying").toBe("place");
    expect(previousStep(steps, "ai", { paid: true }), "never back to a purchase that is done").toBeNull();
  });

  it("on this Mac goes from the welcome to the account, the place, the AI and what to bring", () => {
    const steps = funnelSteps({ account: true, desktop: true, bring: true, path: "mac" });
    expect(steps).toEqual(["welcome", "account", "place", "ai", "bring"]);
    expect(nextStep(steps, "welcome")).toBe("account");
    expect(nextStep(steps, "account")).toBe("place");
    expect(nextStep(steps, "place")).toBe("ai");
    expect(nextStep(steps, "ai")).toBe("bring");
    expect(previousStep(steps, "ai")).toBe("place");
  });

  it("never passes over the AI step, so a connected AI still shows and more can be added", () => {
    const steps = funnelSteps({ account: false, desktop: true, phone: true });
    expect(nextStep(steps, "welcome")).toBe("place");
    expect(nextStep(steps, "place")).toBe("ai");
    expect(previousStep(steps, "phone")).toBe("ai");
    expect(nextStep(steps, "phone")).toBeNull();
    expect(nextStep(funnelSteps({ account: false, desktop: true }), "ai"), "without the phone the AI is the last screen").toBeNull();
  });
});

describe("the Mac's permissions step", () => {
  it("comes last on this Mac, after what to bring and the phone, only while a permission is missing", () => {
    const steps = funnelSteps({ account: false, desktop: true, bring: true, phone: true, path: "mac", permissions: true });
    expect(steps).toEqual(["welcome", "place", "ai", "bring", "phone", "permissions"]);
    expect(nextStep(steps, "phone")).toBe("permissions");
    expect(nextStep(steps, "permissions"), "the app comes after it").toBeNull();
    expect(funnelSteps({ account: false, desktop: true, bring: true, path: "mac", permissions: false })).not.toContain("permissions");
  });

  it("shows before a place is picked (a resumed run) but never on dusk cloud or a window that isn't this Mac's own", () => {
    expect(funnelSteps({ account: false, desktop: true, permissions: true })).toEqual(["welcome", "place", "ai", "permissions"]);
    expect(funnelSteps({ account: false, desktop: true, path: "cloud", permissions: true })).not.toContain("permissions");
    expect(funnelSteps({ account: false, desktop: false, permissions: true })).not.toContain("permissions");
  });
});

describe("the AI grid", () => {
  it("names each AI as people know it, in a fixed order, with only the ones this app can connect", () => {
    const tiles = aiTiles([ai("claude", "claudeAgent"), ai("chatgpt", "codex"), ai("antigravity", "antigravityAgent"), ai("openrouter", "openai-compat")], ready);
    expect(tiles.map((tile) => [tile.id, tile.label, tile.instance.instanceId])).toEqual([
      ["chatgpt", "ChatGPT", "chatgpt"], ["claude", "Claude", "claude"], ["gemini", "Gemini", "antigravity"], ["openrouter", "OpenRouter", "openrouter"],
    ]);
    expect(aiName({ instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan" })).toBe("ChatGPT");
    expect(aiName({ instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi" })).toBe("Kimi");
  });

  it("lets a signed-in one stand for its tile", () => {
    const tiles = aiTiles([ai("chatgpt", "codex"), ai("codex", "codex", true)], ready);
    expect(tiles[0]!.instance.instanceId).toBe("codex");
  });

  it("offers the free model only when it is ready", () => {
    expect(freeModel([ai("opencodeGo", "opencodeGo", true, { freeFallback: true })], ready)?.instanceId).toBe("opencodeGo");
    expect(freeModel([ai("opencodeGo", "opencodeGo", false, { freeFallback: true })], ready)).toBeUndefined();
  });
});
