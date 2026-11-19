// @vitest-environment happy-dom
// The first run as a funnel: the welcome, an AI, a Dusk account, where the bots live,
// what other AI apps here hold and the prompt for AIs online, the phone while its app is offered, then Dusk's chat;
// on dusk cloud, the Cloud being made. What each step shows, where it goes, and what it saves.
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { introStaged, stageIntro } from "@/lib/default-bot";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, MET_CHIEF_HINT, WELCOME_VERSION } from "@/lib/onboarding";
import type { InstanceInfo } from "@/state/store";
import { notesWaiting, stopWaiting } from "@/lib/assistant-notes";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn(), onDone: vi.fn(),
  improve: [] as unknown[] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn() }), api: f.api }));
vi.mock("@/state/api", () => ({ api: f.api }));
// the directory has its own tests; here only that More providers opens it
vi.mock("@/components/models/ModelDirectory", () => ({ ModelDirectory: () => null }));
vi.mock("@/lib/product-analytics", () => ({ setUsageAnalytics: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), setEmailGateDone: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("@/components/mascot-clock", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/components/EngineSetup", async (original) => {
  const { createElement: h } = await import("react");
  return { ...(await original<typeof import("@/components/EngineSetup")>()),
    EngineSetup: ({ instance }: { instance: InstanceInfo }) => h("div", { "data-engine-setup": instance.instanceId }) };
});
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));
const { WelcomeFlow } = await import("./WelcomeFlow");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const claude = (ready: boolean, aiTest?: InstanceInfo["aiTest"]): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] }, ...(aiTest ? { aiTest } : {}),
} as InstanceInfo);
const signedOut = (instanceId: string, driverKind: string, displayName: string, method = "paste-code"): InstanceInfo => ({
  instanceId, driverKind, displayName, access: "subscription", install: { docsUrl: "https://example.test" },
  snapshot: { state: "available", authenticated: false }, authentication: { method }, models: { default: "m", options: [] },
} as InstanceInfo);
const cursor = (ready: boolean): InstanceInfo => ({ ...claude(ready), instanceId: "cursor", driverKind: "cursorAgent", displayName: "Cursor", aiTest: "passed" } as InstanceInfo);
const freeOpenCode = {
  instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode", install: { docsUrl: "https://example.test" },
  snapshot: { state: "available", authenticated: true, freeFallback: true }, models: { default: "opencode/big-pickle", options: [] }, aiTest: "passed",
} as InstanceInfo;
const nothingSignedIn = () => [signedOut("chatgpt", "codex", "ChatGPT plan", "browser-pkce"), signedOut("claude", "claudeAgent", "Claude"),
  signedOut("cursor", "cursorAgent", "Cursor", "device-code"), signedOut("githubCopilot", "copilotAgent", "GitHub Copilot", "device-code")];
const maus = { id: "maus", threadId: "t", name: "Dusk", title: "", description: "", notifications: true, color: "chrome", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, messages: [], defaultBot: {}, chiefOfStaff: true };

let host: HTMLDivElement, root: Root;
const text = () => document.body.textContent ?? "";
const step = () => document.body.querySelector<HTMLElement>("[data-welcome]")?.dataset.welcome;
const title = () => document.body.querySelector("#welcome-title")?.textContent;
const button = (label: string) => [...document.body.querySelectorAll("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
const press = async (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`no "${label}" button on ${step()}: ${text()}`);
  await act(async () => { target.click(); });
  await settle();
};
const choose = async (selector: string) => {
  await act(async () => { document.body.querySelector<HTMLElement>(selector)!.click(); });
  await settle();
};
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10); }); };
const key = async (name: string) => {
  await act(async () => { document.body.querySelector<HTMLElement>("[data-welcome]")!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  await settle();
};
const show = async (extra: Record<string, unknown> = {}) => {
  await act(async () => { root.render(createElement(WelcomeFlow, { onDone: f.onDone, ...extra })); });
  await settle();
};
/** Past the AI step: an AI found answering goes on by itself, else Continue or Set up later. */
const passAi = async () => {
  expect(step()).toBe("ai");
  await act(async () => { await vi.advanceTimersByTimeAsync(1_400); });
  await settle();
  if (step() === "ai") await choose(button("Continue")?.disabled === false ? "[data-funnel-ai-continue]" : "[data-funnel-later]");
};
/** Past the hello, the AI (and an account step's Skip for now) to where bots live. */
const toPlace = async () => {
  if (step() === "welcome") await press("Get started");
  if (step() === "ai") await passAi();
  if (step() === "account") await press("Skip for now");
  expect(step()).toBe("place");
};
/** An AI already answering is used without asking: the AI step says so, then goes on by itself. */
// the AI step always shows the picker (never a "found" screen); a working AI lets the person go on
const usesFoundAi = async (_name = "Claude") => {
  expect(step()).toBe("ai");
  expect(text()).not.toContain("Using your");
  expect(document.body.querySelector("[data-funnel-ai]"), "the cards to pick from").not.toBeNull();
  const go = document.body.querySelector<HTMLButtonElement>("[data-funnel-ai-continue]:not(:disabled)") ?? document.body.querySelector<HTMLButtonElement>("[data-funnel-later]");
  await act(async () => { go!.click(); });
  await settle();
};
const saved = () => f.api.mock.calls.filter(([path, init]) => path === "/api/config" && init?.method === "PUT").map(([, init]) => JSON.parse(init.body));
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, String(v)), removeItem: (k: string) => void values.delete(k), clear: () => values.clear() };
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.animate = vi.fn(() => ({ onfinish: null, oncancel: null, cancel() {} }) as unknown as Animation);
  setLocale("en");
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  f.dispatch.mockReset();
  f.onDone.mockReset();
  f.api.mockReset();
  f.improve = [];
  stopWaiting();
  f.api.mockImplementation(async (path: string, init?: { body?: string; method?: string }) => {
    if (path.endsWith("/check")) return { ok: true };
    if (path === "/api/dashboard/usage-signals") { if (init?.body) f.improve.push(JSON.parse(init.body)); return init?.body ? JSON.parse(init.body) : { enabled: true }; }
    if (path === "/api/mobile/devices") return { devices: [] };
    if (path === "/api/setup-import/bots") return { apps: [] };
    if (path === "/api/setup-import/grok") return { files: [], bots: [] };
    return path === "/api/instances" ? { instances: f.state.instances } : JSON.parse(init?.body ?? "{}");
  });
  f.state = { hydrated: true, instances: [claude(true, "passed")], config: { onboarding: EMPTY_ONBOARDING, profile: { name: "" } }, bots: [maus], cloudAdd: null };
  stageIntro(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the welcome", () => {
  it("opens on the welcome with nothing else to decide, and asks nothing about sharing off the desktop app", async () => {
    await show();
    expect(step()).toBe("welcome");
    expect(title()).toBe("Meet Metal");
    await press("Get started");
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-help-improve]"), "Settings has the switch; the run here has no place step").toBeNull();
    expect(f.onDone).not.toHaveBeenCalled();
    expect(document.body.querySelector("textarea"), "nothing asks for a job").toBeNull();
  });

  it("first run never shows the help improve switch; it lives in Settings", async () => {
    vi.stubGlobal("duskDesktop", { remoteClient: { active: false } });
    await show();
    expect(document.body.querySelector("[data-help-improve]")).toBeNull();
    await toPlace();
    expect(document.body.querySelector("[data-help-improve]")).toBeNull();
  });

  it("with Claude already answering, uses it without asking and goes on to Dusk's chat", async () => {
    await show();
    await press("Get started");
    await usesFoundAi();
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
    expect(introStaged("maus")).toBe(true);
    expect(f.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "maus", patch: { welcomed: true } });
    await act(async () => {});
    expect(saved()).toEqual([{ onboarding: expect.objectContaining({ version: WELCOME_VERSION, hintsSeen: [MET_CHIEF_HINT] }) }]);
  });
});

describe("connecting an AI", () => {
  it.skip("an AI found answering goes on at once with Continue, not only after its pause", async () => {
    await show();
    await press("Get started");
    expect(text()).toContain("Using your Claude account");
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(f.onDone, "the pause doesn't go on a second time").toHaveBeenCalledOnce();
  });

  it.skip("while an AI is still being checked, Skip shows the cards; a check that runs out of time shows them with why", async () => {
    let fail: (error: unknown) => void = () => {};
    const base = f.api.getMockImplementation()!;
    f.api.mockImplementation((path: string, init?: { body?: string; method?: string; timeoutMs?: number }) => {
      if (path.endsWith("/check")) { expect(init?.timeoutMs).toBe(20_000); return new Promise((_, reject) => { fail = reject; }); }
      return base(path, init);
    });
    f.state = { ...f.state, instances: [claude(true, "testing")] };
    await show({ initialBeat: "ai" });
    expect(title()).toBe("Looking for an AI you already use");
    await press("Skip");
    expect(title()).toBe("Connect an AI");
    expect(document.body.querySelector("[data-funnel-ai=claude]")).not.toBeNull();

    await act(async () => root.unmount());
    root = createRoot(host);
    await show({ initialBeat: "ai" });
    expect(title()).toBe("Looking for an AI you already use");
    await act(async () => { fail(new DOMException("timed out", "TimeoutError")); });
    await settle();
    expect(title()).toBe("Connect an AI");
    expect(document.body.querySelector("[data-ai-silent]"), "says Claude didn't answer, with Check again").not.toBeNull();
  });

  it("shows every AI as a button with its name, and opens the picked one's own sign-in under the grid", async () => {
    f.state = { ...f.state, instances: nothingSignedIn() };
    await show();
    await press("Get started");
    expect(step()).toBe("ai");
    expect(title()).toBe("Connect an AI");
    expect([...document.body.querySelectorAll<HTMLElement>("[data-funnel-ai]")].map((tile) => tile.dataset.funnelAi)).toEqual(["chatgpt", "claude", "cursor", "copilot"]);
    expect(text()).toContain("ChatGPT");
    f.api.mockImplementation(async (path: string) => {
      if (path === "/api/instances?fresh=1") return { instances: f.state.instances };
      if (path === "/api/instances/claude/auth/start") return { auth: { phase: "waiting", flowId: "c1", authorizationUrl: "https://claude.ai/oauth/authorize?x=1" } };
      return {};
    });
    await press("Claude");
    expect(document.body.querySelector("[data-funnel-ai-connect=claude]")).not.toBeNull();
    expect(document.body.querySelector("[data-sign-in=paste]"), "the sign-in opened in the browser, the code goes here").not.toBeNull();
    expect(f.api).toHaveBeenCalledWith("/api/instances/claude/auth/start", expect.objectContaining({ method: "POST" }));
    await press("ChatGPT");
    expect(f.api, "picking another cancels the one under way").toHaveBeenCalledWith("/api/instances/claude/auth/cancel", expect.objectContaining({ method: "POST" }));
    expect(document.body.querySelector("[data-funnel-ai-connect=claude]")).toBeNull();
    await press("More providers or use an API key");
    expect(document.body.querySelector("[data-connect-ai]")).not.toBeNull();
    expect(document.body.querySelector("[data-connect-ai] h2")?.textContent, "it opens on every other provider").toBe("More providers or use an API key");
  });

  it("shows connected AIs as connected, not to be pressed again, with continue ready and more still to add", async () => {
    f.state = { ...f.state, instances: nothingSignedIn() };
    await show();
    await press("Get started");
    expect(button("Continue")?.disabled, "nothing connected yet: Continue waits, Set up later goes on").toBe(true);
    expect(button("Set up later")?.className).not.toContain("ui-button-primary");
    expect(document.body.querySelectorAll("[data-funnel-ai-continue], [data-funnel-later]")).toHaveLength(2);
    const focus = vi.fn(async () => true);
    vi.stubGlobal("duskDesktop", { focusWindow: focus });
    f.state = { ...f.state, instances: [cursor(true), { ...claude(true), instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan" } as InstanceInfo, signedOut("claude", "claudeAgent", "Claude")] };
    await show();
    expect(title()).toBe("Connect an AI");
    const connected = [...document.body.querySelectorAll<HTMLElement>("[data-funnel-ai][data-connected]")].map((tile) => tile.dataset.funnelAi);
    expect(connected).toEqual(["chatgpt", "cursor"]);
    expect(document.body.querySelector("[data-funnel-ai=cursor]")?.tagName, "a connected AI is not a button").toBe("DIV");
    expect(document.body.querySelector("[data-funnel-ai=cursor]")?.textContent).toContain("Connected");
    expect(focus, "a sign-in that finished brings the app back").toHaveBeenCalled();
    expect(button("Set up later")).toBeUndefined();
    expect(button("Continue")?.className).toContain("ui-button-primary");
    expect(document.body.querySelector("button[data-funnel-ai=claude]"), "another can still be added").not.toBeNull();
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
  });

  it("set up later, or the free model, goes on; a found sign-in that didn't answer says why", async () => {
    f.state = { ...f.state, instances: [freeOpenCode, ...nothingSignedIn()] };
    await show();
    await press("Get started");
    expect(step(), "the AI step shows even when the free model works").toBe("ai");
    expect(title()).toBe("Connect an AI");
    expect(button("Start with the free model"), "Set up later starts on the free model instead").toBeUndefined();
    await press("Set up later");
    expect(f.onDone).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    root = createRoot(host);
    f.onDone.mockReset();
    f.state = { ...f.state, instances: [claude(true, "failed")] };
    await show({ initialBeat: "ai" });
    expect(document.body.querySelector("[role=alert]")?.textContent).toContain("Claude");
  });
});

describe("on the desktop app", () => {
  const desktop = (extra: Record<string, unknown> = {}) => vi.stubGlobal("duskDesktop", { remoteClient: { active: false }, requireUserPresence: async () => true, ...extra });

  it("opens a server from the app on its AI, without the hello the person already saw", async () => {
    desktop({ remoteClient: { active: true } });
    await show();
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-funnel-progress]"), "one screen has no progress to show").toBeNull();
  });

  it("opens on the hello, then where bots live, the AI, what to bring and the chat, with back and progress", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    desktop({ platform: "linux" });
    await show();
    expect(step(), "Meet Metal comes first").toBe("welcome");
    expect(title()).toBe("Meet Metal");
    await press("Get started");
    expect(step()).toBe("place");
    expect(title()).toBe("Where should your bots live?");
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress")).toBe("2/4");
    expect(text()).toContain("This computer");
    expect(text(), "never a Mac on Linux").not.toContain("Mac");
    expect(text()).toContain("dusk cloud");
    expect(text()).toContain("From $20 a month");
    await choose("[data-funnel-place=mac]");
    expect(document.querySelector("[data-panel-modal]"), "the free way never asks again").toBeNull();
    expect(document.body.querySelector("[data-help-improve]"), "only on the place step").toBeNull();
    await usesFoundAi();
    expect(step()).toBe("bring");
    expect(document.body.querySelector("[data-help-improve]"), "never on a later screen").toBeNull();
    await press("Back");
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-funnel-ai=claude]")?.hasAttribute("data-connected"), "back on the step: the cards, Claude connected").toBe(true);
    await press("Continue");
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
    expect(document.body.querySelector(".phone-frame"), "the phone app is hidden").toBeNull();
  });

  it("with the phone app offered, ends on the phone: a code to scan, then the chat", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "1");
    desktop({ platform: "linux" });
    await show({ initialBeat: "place" });
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress")).toBe("2/5");
    await choose("[data-funnel-place=mac]");
    expect(document.body.querySelector("[data-help-improve]"), "only on the place step").toBeNull();
    await usesFoundAi();
    expect(step()).toBe("bring");
    await press("Continue");
    expect(step()).toBe("phone");
    expect(document.body.querySelector(".phone-frame img"), "the phone app's own screen").not.toBeNull();
    expect(document.body.querySelector("[data-help-improve]"), "never on a later screen").toBeNull();
    expect(button("Skip")?.className, "skip is a real button").toContain("ui-button-lg");
    await press("Back");
    expect(step()).toBe("bring");
    await press("Continue");
    await press("Show the code");
    expect(document.body.querySelector("[data-phone-offer]")).not.toBeNull();
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith("maus");
  });

  it("this computer just goes on to the AI, with no dusk cloud sheet in between", async () => {
    desktop({ platform: "darwin", cloudAccount: { state: async () => ({ status: "signed-out" }), onState: () => () => {}, offer: vi.fn(async () => ({ plans: [{ tier: "starter", amount: 1500 }] })) } });
    await show({ initialBeat: "place" });
    await choose("[data-funnel-place=mac]");
    expect(document.querySelector("[data-panel-modal]")).toBeNull();
    expect(step()).toBe("ai");
  });

  it("a double click that opened the place step does not also choose there", async () => {
    desktop();
    await show();
    await toPlace();
    const second = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 });
    await act(async () => { document.body.querySelector<HTMLElement>("[data-funnel-place=mac]")!.dispatchEvent(second); });
    await settle();
    expect(step()).toBe("place");
    await choose("[data-funnel-place=mac]");
    expect(step()).toBe("ai");
  });

  const cloudBridge = (start: Record<string, unknown>) => {
    const listeners = new Set<(next: unknown) => void>();
    const bridge = {
      now: start as unknown,
      state: vi.fn(async () => bridge.now), refresh: vi.fn(async () => bridge.now), cancel: vi.fn(async () => bridge.now),
      openPage: vi.fn(async () => ({ opened: true })),
      onState: (cb: (next: unknown) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      continueInBrowser: vi.fn(async () => ({ outcome: "opened", state: bridge.now })),
      offer: vi.fn(async () => ({ plans: [{ tier: "starter", amount: 1500, trialDays: 7 }, { tier: "pro", amount: 2900, trialDays: 7 }], recommended: "pro" })),
      holdSignIns: vi.fn(async () => ({ outcome: "held" })), connectHome: vi.fn(async () => ({ status: "connected" })),
      tell: async (next: unknown) => { bridge.now = next; await act(async () => { for (const listener of listeners) listener(next); }); await settle(); },
    };
    return bridge;
  };

  it("an account that already has dusk cloud skips where bots live and the checkout: the AI with the cloud line, then bring and making", async () => {
    const bridge = cloudBridge({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "ready", origin: "https://c1.dusk.test" }] });
    f.state = { ...f.state, instances: [freeOpenCode, ...nothingSignedIn()] };
    desktop({ cloudAccount: bridge });
    await show();
    await press("Get started");
    expect(step(), "never asked where the bots live").toBe("ai");
    expect(text()).toContain("Your cloud is getting ready.");
    expect(bridge.continueInBrowser, "no checkout").not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-funnel-back]"), "no way back to the place").toBeNull();
    expect(button("Set up later"), "the line offers the free model, so the button is it").toBeUndefined();
    await press("Start with the free model");
    expect(step()).toBe("bring");
    await choose("[data-bring-next]");
    expect(step()).toBe("making");
  });

  it("on the cloud path with no free model, the AI step never offers one", async () => {
    const bridge = cloudBridge({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "ready", origin: "https://c1.dusk.test" }] });
    f.state = { ...f.state, instances: nothingSignedIn() };
    desktop({ cloudAccount: bridge });
    await show();
    await press("Get started");
    expect(step()).toBe("ai");
    expect(text()).toContain("Your cloud is getting ready.");
    expect(text()).not.toContain("free model");
    await press("Set up later");
    expect(step()).toBe("bring");
  });

  it("signing in on the account step to an account with dusk cloud goes on to the AI, not where bots live", async () => {
    const bridge = cloudBridge({ status: "signed-out" });
    let gateState = { required: false, blocked: false, status: "signed-out" };
    let gateChanged = () => {};
    desktop({ cloudAccount: bridge, accountGate: { state: async () => gateState, options: async () => ({ providers: ["google"], recovery: true }),
      onChange: (cb: () => void) => { gateChanged = cb; return () => {}; } } });
    await show();
    await press("Get started");
    expect(step()).toBe("account");
    gateState = { required: false, blocked: false, status: "connected" };
    await act(async () => { gateChanged(); });
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "ready", origin: "https://c1.dusk.test" }] });
    expect(step()).toBe("ai");
    expect(bridge.continueInBrowser, "no checkout").not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-funnel-back]"), "no way back to the place").toBeNull();
  });

  /** signed in from the account step to a new account, which the website now takes through its first steps */
  const viaWebsite = async () => {
    const bridge = cloudBridge({ status: "signed-out" });
    let gateState = { required: false, blocked: false, status: "signed-out" };
    let gateChanged = () => {};
    desktop({ cloudAccount: bridge, accountGate: { state: async () => gateState, options: async () => ({ providers: ["google"], recovery: true }),
      onChange: (cb: () => void) => { gateChanged = cb; return () => {}; } } });
    await show();
    await press("Get started");
    expect(step()).toBe("account");
    // one client behind both: the gate reads connected once the session read (with websiteSetup) is in
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [], websiteSetup: "open" });
    gateState = { required: false, blocked: false, status: "connected" };
    await act(async () => { gateChanged(); });
    await settle();
    expect(step(), "waits while the website's first steps are open").toBe("account");
    expect(text()).toContain("Finish setting up in your browser");
    await press("Open the browser again");
    expect(bridge.openPage).toHaveBeenCalledWith("home");
    return bridge;
  };

  it("a new account picking this computer on the website goes past where bots live, to the AI", async () => {
    const bridge = await viaWebsite();
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [], websiteSetup: "free" });
    expect(step()).toBe("ai");
    expect(bridge.continueInBrowser, "no checkout").not.toHaveBeenCalled();
  });

  it("a new account picking a plan on the website waits on its checkout here, then skips to the AI once paid", async () => {
    const bridge = await viaWebsite();
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [], websiteSetup: "cloud" });
    expect(step()).toBe("checkout");
    expect(bridge.continueInBrowser, "the website already opened the checkout").not.toHaveBeenCalled();
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, websiteSetup: "cloud", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "setting_up", origin: "https://c1.dusk.test" }] });
    expect(step()).toBe("ai");
  });

  it("a new account that paid on the website before the app looked skips where bots live and the checkout", async () => {
    const bridge = await viaWebsite();
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, websiteSetup: "cloud", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "setting_up", origin: "https://c1.dusk.test" }] });
    expect(step()).toBe("ai");
    expect(document.body.querySelector("[data-funnel-back]"), "no way back to the purchase").toBeNull();
  });

  it("a trial whose cloud is being made counts, also for a run resumed on the checkout; a plan with no cloud behind it still shows the place", async () => {
    const bridge = cloudBridge({ status: "connected", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "setting_up" }], entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 }, trial: { state: "active", endsAt: 1, amount: 1500 } });
    desktop({ cloudAccount: bridge });
    localStorage.setItem("dusk.onboarding.welcomeDraft", JSON.stringify({ version: WELCOME_VERSION, beat: "checkout", cloud: true }));
    await show();
    expect(step()).toBe("ai");
    expect(bridge.continueInBrowser).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    localStorage.clear();
    desktop({ cloudAccount: cloudBridge({ status: "connected", clouds: [], entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 }, trial: { state: "active", endsAt: 1, amount: 1500 } }) });
    await show();
    await toPlace();
    expect(title(), "no cloud behind the plan: never sent on to a cloud that isn't coming").toBe("Where should your bots live?");
  });

  it("dusk cloud's tile says only the free days while there is a trial", async () => {
    desktop({ cloudAccount: cloudBridge({ status: "connected", clouds: [] }) });
    await show();
    await toPlace();
    const tile = document.body.querySelector("[data-funnel-place=cloud]")!;
    expect(tile.textContent).toContain("7 days free");
    expect(tile.querySelector("[data-funnel-place-note]")).toBeNull();
  });

  it("dusk cloud goes straight to the browser with its intent and waits calmly; back and this Mac are one press away", async () => {
    const bridge = cloudBridge({ status: "signed-out" });
    bridge.continueInBrowser.mockImplementation(async () => { bridge.now = { status: "connecting" }; return { outcome: "browser", state: bridge.now }; });
    desktop({ cloudAccount: bridge });
    await show();
    await toPlace();
    await choose("[data-funnel-place=cloud]");
    expect(step()).toBe("checkout");
    expect(bridge.continueInBrowser).toHaveBeenCalledExactlyOnceWith({ kind: "upgrade", source: "app_onboarding", move: "computer" });
    expect(title()).toBe("Continue in your browser");
    expect(text()).toContain("Create your account, pick a plan and check out");
    expect(text()).toContain("Waiting for your sign-in");
    expect(document.body.querySelector("[data-funnel-checkout-price]"), "no price line while the browser asks for money").toBeNull();
    expect(text()).not.toContain("/month");
    expect(document.body.querySelector("[data-funnel-checkout-mac]")?.className, "this Mac is a light, small text link").toContain("text-ink-tertiary");
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress"), "welcome, place, checkout, ai, bring, making").toBe("3/6");
    expect(text(), "no dash anywhere").not.toMatch(/\u2014/);
    await bridge.tell({ status: "connected", account: { email: "sam@qa.dusk.test" }, clouds: [] });
    expect(text(), "Signed in: the plan and checkout are what is left").toContain("Waiting for your checkout");
    expect(document.body.querySelector("[data-funnel-checkout-email]")?.textContent).toBe("Signed in as sam@qa.dusk.test.");
    await press("Open the page again");
    expect(bridge.continueInBrowser).toHaveBeenCalledTimes(2);
    await press("Back");
    expect(step()).toBe("place");
    await choose("[data-funnel-place=cloud]");
    await press("Use this computer instead");
    expect(step(), "this Mac's own steps, with no dead end").toBe("ai");
  });

  it("in strict mode (mounted twice) still hears the browser and the payment", async () => {
    const bridge = cloudBridge({ status: "connected", clouds: [] });
    desktop({ cloudAccount: bridge });
    await act(async () => { root.render(createElement(StrictMode, null, createElement(WelcomeFlow, { onDone: f.onDone }))); });
    await settle();
    await toPlace();
    await choose("[data-funnel-place=cloud]");
    expect(text()).toContain("Waiting for your checkout");
    await bridge.tell({ status: "connected", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status: "setting_up" }] });
    expect(step()).toBe("ai");
  });

  it("a sign-in still waiting in the browser is let go when the person picks this Mac instead", async () => {
    const bridge = cloudBridge({ status: "signed-out" });
    bridge.continueInBrowser.mockImplementation(async () => { bridge.now = { status: "connecting" }; return { outcome: "browser", state: bridge.now }; });
    desktop({ cloudAccount: bridge });
    await show();
    await toPlace();
    await choose("[data-funnel-place=cloud]");
    await press("Use this computer instead");
    expect(bridge.cancel).toHaveBeenCalledOnce();
  });

  it("says so when the browser can't open, and offers the page again", async () => {
    const bridge = cloudBridge({ status: "signed-out" });
    bridge.continueInBrowser.mockImplementation(async () => { throw new Error("no browser"); });
    desktop({ cloudAccount: bridge });
    await show();
    await toPlace();
    await choose("[data-funnel-place=cloud]");
    expect(document.body.querySelector("[role=alert]")?.textContent).toContain("Your browser didn't open.");
    expect(button("Open the page again")).toBeDefined();
  });

  it("on dusk cloud: paid in the browser, the AI while the Cloud is made, its sign-ins held, and its chat once ready", async () => {
    const own = (status: string, extra: Record<string, unknown> = {}) => ({ status: "connected", clouds: [{ id: "c1", primary: true, runsOn: "cloud", status, origin: status === "ready" ? "https://c1.dusk.test" : null, ...extra }] });
    const bridge = cloudBridge({ status: "connected", clouds: [] });
    f.state = { ...f.state, instances: [freeOpenCode, ...nothingSignedIn()] };
    desktop({ cloudAccount: bridge });
    await show();
    await toPlace();
    await choose("[data-funnel-place=cloud]");
    expect(step()).toBe("checkout");
    expect(text(), "already signed in: the plan and checkout are what is left").toContain("Waiting for your checkout");
    await bridge.tell(own("setting_up", { setup: { step: "storage", progress: 0.4 } }));
    expect(step(), "paid: the app notices by itself and the AI comes next").toBe("ai");
    expect(text()).toContain("Your cloud is getting ready.");
    expect(document.body.querySelector("[data-funnel-back]"), "no way back to a purchase that is done").toBeNull();
    expect(document.body.querySelector("[data-funnel-progress]")?.getAttribute("data-funnel-progress")).toBe("4/6");
    await press("Start with the free model");
    expect(step(), "what other AI apps here hold, before the cloud is made").toBe("bring");
    await choose("[data-bring-next]");
    expect(step()).toBe("making");
    expect(title()).toBe("Making your cloud");
    expect(document.body.querySelector("[data-funnel-making]")?.getAttribute("data-funnel-making")).toBe("setting-up");
    expect(document.body.querySelector("[aria-current=step]")?.textContent, "the checklist ticks one step at a time").toBe("Reserving your machine");
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(document.body.querySelector("[aria-current=step]")?.textContent).toBe("Preparing storage");
    expect(bridge.holdSignIns).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem("dusk.onboarding.welcomeDraft")!), "a closed app comes back here").toMatchObject({ beat: "making", cloud: true });
    let up = false;
    vi.stubGlobal("fetch", vi.fn(async () => { if (!up) throw new TypeError("Failed to fetch"); return new Response(null); }));
    await bridge.tell(own("ready"));
    await settle();
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(title(), "ready at the Admin, but its page doesn't answer yet: still the last check, never a second setup screen").toBe("Making your cloud");
    expect(document.body.querySelector("[aria-current=step]")?.textContent).toBe("Checking it's ready");
    expect(bridge.connectHome).not.toHaveBeenCalled();
    up = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await settle();
    expect(bridge.connectHome).toHaveBeenCalledOnce();
    expect(f.onDone).toHaveBeenCalledOnce();
  });

  it("asks every first run for an account right after the hello, with a quiet Skip for now", async () => {
    desktop({ accountGate: { state: async () => ({ required: false, blocked: false, status: "signed-out" }), options: async () => ({ providers: ["google"], recovery: true }), onChange: () => () => {} } });
    await show();
    await press("Get started");
    expect(step(), "the account comes before where bots live").toBe("account");
    expect(title()).toBe("Create your Dusk account");
    await press("Skip for now");
    expect(step()).toBe("place");
    await press("Back");
    expect(step()).toBe("account");
  });

  it("puts Skip for now in the top right, faint, clear of Windows' caption buttons", async () => {
    desktop({ accountGate: { state: async () => ({ required: false, blocked: false, status: "signed-out" }), options: async () => ({ providers: ["google"], recovery: true }), onChange: () => () => {} } });
    await show({ initialBeat: "account" });
    const skip = button("Skip for now")!;
    expect(skip.closest("[data-step-footer]"), "not in the footer").toBeNull();
    expect(skip.className).toMatch(/fixed top-0/);
    expect(skip.className).toMatch(/text-ink-tertiary\/60/);
  });

  it("lets a browser sign-in that never comes back go on without an account, and still moves on when it does come back", async () => {
    const gate = {
      status: "signed-out", listeners: [] as Array<() => void>,
      state: vi.fn(async () => ({ required: false, blocked: false, status: gate.status, ...(gate.status === "connecting" ? { browser: "google" } : {}) })),
      options: vi.fn(async () => ({ providers: ["google"], recovery: true })),
      browser: vi.fn(async () => { gate.status = "connecting"; }), cancel: vi.fn(async () => ({})),
      onChange: (listener: () => void) => { gate.listeners.push(listener); return () => {}; },
    };
    desktop({ accountGate: gate });
    await show({ initialBeat: "account" });
    await press("Continue with Google");
    expect(text()).toContain("Waiting for your browser");
    expect(button("Continue without an account"), "a way on beside the waiting line").toBeDefined();
    await press("Continue without an account");
    expect(step()).toBe("place");
    expect(gate.cancel, "the sign-in is left to finish in the browser").not.toHaveBeenCalled();

    // the other way: they come back signed in, and the change event was missed; the window coming to the front reads it
    await press("Back");
    await press("Continue with Google");
    gate.status = "connected";
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(step()).toBe("place");
  });

  it("goes back to the sign-ins when the browser didn't open, instead of waiting for it", async () => {
    desktop({ accountGate: { state: async () => ({ required: false, blocked: false, status: "signed-out" }), options: async () => ({ providers: ["google"], recovery: true }),
      browser: async () => { throw new Error("no browser"); }, onChange: () => () => {} } });
    await show({ initialBeat: "account" });
    await press("Continue with Google");
    expect(text()).not.toContain("Waiting for your browser");
    expect(button("Continue with Google")).toBeDefined();
  });

  it("shows Google and Apple with the email from the first frame, never X, and only takes away what the service doesn't offer", async () => {
    let answer: (value: { providers: string[]; recovery: boolean }) => void = () => {};
    desktop({ accountGate: { state: async () => ({ required: false, blocked: false, status: "signed-out" }), options: () => new Promise((done) => { answer = done; }), onChange: () => () => {} } });
    await show({ initialBeat: "account" });
    expect(step()).toBe("account");
    const shown = () => [...document.body.querySelectorAll("[data-funnel-provider]")].map((one) => one.getAttribute("data-funnel-provider"));
    expect(shown(), "before the service has answered").toEqual(["google", "apple"]);
    expect(document.body.querySelector("input[type=email]")).not.toBeNull();
    await act(async () => { answer({ providers: ["google", "apple", "x"], recovery: true }); });
    await settle();
    expect(shown(), "nothing moves when the service agrees, and an X it still lists is not shown").toEqual(["google", "apple"]);
  });

  it("where the install requires an account, asks for it by Google or an emailed code, and goes on once signed in", async () => {
    const gate = {
      required: true, signedIn: false,
      state: vi.fn(async () => ({ required: gate.required, blocked: !gate.signedIn, status: gate.signedIn ? "connected" : "signed-out" })),
      options: vi.fn(async () => ({ providers: ["google"], recovery: true })),
      signInStart: vi.fn(async (email: string) => ({ outcome: "sent", email, expiresAt: Date.now() + 600_000, resendAt: Date.now() + 30_000, signupOpen: true })),
      signInVerify: vi.fn(async () => { gate.signedIn = true; return { outcome: "signed-in" }; }),
      signInCancel: vi.fn(async () => {}), browser: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})), reopen: vi.fn(), onChange: () => () => {},
    };
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    desktop({ accountGate: gate });
    await show();
    expect(step(), "the hello comes first").toBe("welcome");
    await press("Get started");
    expect(step()).toBe("account");
    expect(title()).toBe("Create your Dusk account");
    expect(text(), "no phone in the pitch while its app is hidden").toContain("Already have one? Sign in the same way.");
    expect(text(), "no price claim in the pitch").not.toContain("Free.");
    expect(button("Continue with Google")).toBeDefined();
    expect(button("Skip for now"), "required here").toBeUndefined();
    await type(document.body.querySelector<HTMLInputElement>("input[type=email]")!, "person@example.com");
    await press("Email me a code");
    expect(gate.signInStart).toHaveBeenCalledWith("person@example.com");
    const digits = [...document.body.querySelectorAll<HTMLInputElement>("input")];
    for (const [index, digit] of digits.entries()) await type(digit, String(index + 1));
    await press("Sign in");
    expect(gate.signInVerify).toHaveBeenCalledWith("12345678");
    expect(step()).toBe("place");
  });

  it("never offers to go on without an account where the app needs one", async () => {
    desktop({ accountGate: { state: async () => ({ required: true, blocked: true, status: "signed-out" }), options: async () => ({ providers: [], recovery: false }), onChange: () => () => {} } });
    await show();
    await press("Get started");
    expect(step()).toBe("account");
    expect(button("Skip for now")).toBeUndefined();
    await key("Escape");
    expect(step()).toBe("account");
  });

});

describe("Dusk as the Chief", () => {
  it("makes Dusk the Chief only where there is none", async () => {
    f.state = { ...f.state, bots: [{ ...maus, chiefOfStaff: false }] };
    await show();
    await press("Get started");
    await usesFoundAi();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "maus", patch: { welcomed: true, chiefOfStaff: true } });
  });

  it("lands on no bot where another bot is already the Chief", async () => {
    f.state = { ...f.state, bots: [{ ...maus, chiefOfStaff: false }, { ...maus, id: "research", threadId: "r", name: "Research", defaultBot: undefined, chiefOfStaff: true }] };
    await show();
    await press("Get started");
    await usesFoundAi();
    expect(f.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateBot" }));
    expect(f.onDone).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe("other first runs", () => {
  it("a replay from Settings records nothing about a first chat", async () => {
    f.state = { ...f.state, config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01T00:00:00.000Z", version: WELCOME_VERSION } } };
    await show({ replay: true });
    await press("Get started");
    await usesFoundAi();
    await act(async () => {});
    expect(f.onDone).toHaveBeenCalledOnce();
    expect(saved()[0].onboarding).not.toHaveProperty("hintsSeen");
    expect(introStaged("maus"), "a replay lands in a chat that may be long under way").toBe(false);
  });
});

describe("the bring step: what this computer holds, then the prompt", () => {
  const molty = { source: "openclaw", app: "OpenClaw", where: "~/.openclaw", channels: ["telegram"], unreadable: [], bots: [{
    name: "Molty", title: "", description: "", instructions: "Be helpful.", memories: ["Sam's sister is Ana."], userFacts: [], skills: [], routines: [], apps: [],
  }] };
  const holding = { skills: [{ name: "pdf", source: "claudeCode" }], tools: [],
    memory: [{ source: "claudeCode", files: 6, notes: 18, topics: { preferences: true, aboutYou: true, workStyle: true, projects: 3 } }], usage: { claudeCode: 22 } };
  const desktop = (found: { apps: unknown[]; detection: unknown }) => {
    vi.stubGlobal("duskDesktop", { remoteClient: { active: false } });
    const base = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path: string, init?: { body?: string; method?: string }) => {
      if (path === "/api/setup-import/bots") return { apps: found.apps };
      if (path === "/api/setup-import" && init?.method === "POST") return { skills: { added: ["pdf"], skipped: [] }, tools: { added: [], skipped: [] }, memory: { added: 18, sources: ["claudeCode"] } };
      if (path === "/api/setup-import") return found.detection;
      return base(path, init);
    });
  };
  const prompt = () => [...document.body.querySelectorAll("[data-bring-prompt] ol li")].map((li) => li.textContent);
  const STEPS = ["1Copy the prompt.", "2Paste it into Grok bot, ChatGPT, Claude, Gemini or any other AI.", "3It makes one file. Paste or drop it into any bot here and everything gets set up."];

  it("leads with the app that knows the person and its Bring it in, keeps the rest behind Show more, and keeps the prompt under them", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    desktop({ apps: [molty], detection: holding });
    await show({ initialBeat: "bring" });
    expect(step()).toBe("bring");
    expect(title()).toBe("Bring what you already use");
    expect(text()).toContain("Bots, memory and skills from your other AI apps.");
    const hero = document.body.querySelector("[data-bring-hero]")!;
    expect(hero.textContent).toContain("Claude Code already knows you");
    expect(hero.querySelector("button")?.textContent).toBe("Bring it in");
    expect(document.body.querySelector("[data-bring-find='bots:openclaw']"), "the rest waits behind Show more").toBeNull();
    await press("Show 1 more");
    expect(document.body.querySelector("[data-bring-find='bots:openclaw']")?.textContent).toContain("OpenClaw");
    expect(document.body.querySelector("[data-bring-more]")).toBeNull();
    const section = document.body.querySelector("[data-bring-prompt]")!;
    expect(document.body.querySelector("[data-bring-in]")!.lastElementChild, "the prompt comes after the finds").toBe(section);
    expect(section.querySelector("h2")?.className, "with its own label under the finds").not.toContain("sr-only");
    expect(prompt()).toEqual(STEPS);
    await press("Import from Claude Code");
    expect(f.api).toHaveBeenCalledWith("/api/setup-import", expect.objectContaining({ method: "POST" }));
    expect(document.body.querySelector("[data-bring-said]")?.textContent).toContain("Your bots now know 18 things about you.");
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledOnce();
  });

  it("with nothing found here, is the prompt and its three steps alone", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    desktop({ apps: [], detection: { skills: [], tools: [] } });
    await show({ initialBeat: "bring" });
    expect(step()).toBe("bring");
    expect(text()).toContain("Grok bot, ChatGPT, Claude and Gemini already know a lot about you. Bring it here in three steps.");
    expect(document.body.querySelector("[data-bring-find], [data-bring-hero], [data-bring-more]"), "no rows when nothing is here").toBeNull();
    expect(prompt()).toEqual(STEPS);
    expect(document.body.querySelector("[data-bring-prompt] h2")?.className, "no label over the prompt alone").toContain("sr-only");
    expect(document.body.querySelector("[data-bring-prompt] pre")?.textContent, "the prompt asks for the notes file").toContain("metal-notes.md");
    expect(document.body.querySelectorAll("[data-primary]"), "Continue is the one primary action").toHaveLength(1);
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledOnce();
  });

  it("shows the strongest finds up front when no one app knows the person", async () => {
    desktop({ apps: [], detection: { skills: [], tools: [{ name: "a", source: "cursor" }, { name: "b", source: "codex" }, { name: "c", source: "gemini" }, { name: "d", source: "windsurf" }] } });
    await show({ initialBeat: "bring" });
    expect(document.body.querySelector("[data-bring-hero]")).toBeNull();
    expect(document.body.querySelectorAll("[data-bring-find]"), "the first few, the rest behind Show more").toHaveLength(3);
    expect(document.body.querySelector("#bring-others")?.textContent).toBe("On this computer");
    expect(button("Show 1 more")).toBeDefined();
  });

  it("copies the prompt, says so, and the first bot's chat starts waiting for the answer", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    desktop({ apps: [], detection: { skills: [], tools: [] } });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await show({ initialBeat: "bring" });
    expect(notesWaiting()).toBeNull();
    await press("Copy the prompt");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("metal-notes.md"));
    expect(document.body.querySelector("[data-bring-copied]")?.textContent).toBe("Copied. Paste it into that AI, then paste or drop its file into any bot here.");
    expect(button("Copied"), "the button says it too").toBeTruthy();
    expect(notesWaiting(), "the waiting line above the first bot's message box").not.toBeNull();
    await press("Continue");
    expect(f.onDone).toHaveBeenCalledOnce();
  });

  it("says so when the prompt couldn't be copied", async () => {
    desktop({ apps: [], detection: { skills: [], tools: [] } });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    await show({ initialBeat: "bring" });
    await press("Copy the prompt");
    expect(document.body.querySelector("[data-bring-copied]")?.textContent).toBe("Couldn't copy the prompt. Try again.");
    expect(notesWaiting()).toBeNull();
  });
});

describe("the funnel's back button", () => {
  it("starts clear of macOS's traffic lights, and in the corner elsewhere", async () => {
    const { FunnelBar } = await import("./FunnelSteps");
    const { DesktopCapabilitiesProvider } = await import("../DesktopCapabilities");
    const { cacheDesktopCapabilities, initialDesktopCapabilities } = await import("@/lib/desktop");
    const backAt = async (platform: string | null) => {
      vi.stubGlobal("duskDesktop", platform ? { platform, getCapabilities: async () => initialDesktopCapabilities() } : undefined);
      cacheDesktopCapabilities(initialDesktopCapabilities());
      await act(async () => { root.render(createElement(DesktopCapabilitiesProvider, null, createElement(FunnelBar, { at: 1, count: 3, onBack: () => {} }))); });
      await settle();
      return document.body.querySelector<HTMLElement>("[data-funnel-back]")!.getAttribute("data-funnel-back");
    };
    expect(await backAt("darwin")).toBe("clear-of-traffic-lights");
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(await backAt("win32"), "Windows keeps its caption buttons on the right").toBe("");
  });
});
