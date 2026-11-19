import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudTrial } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, MET_CHIEF_HINT, type WelcomeViewer } from "@/lib/onboarding";
import { registerDesktopPrefs } from "../../electron/desktop-prefs.mjs";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, dispatch: null as any,
  viewerEmail: undefined as string | null | undefined }));
const signInSheet = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/sign-in-sheet", () => ({ openSignIn: signInSheet.open, closeSignIn: vi.fn(), useSignInOpen: () => null }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn() }));
// Who Dusk belongs to: unknown (as before the session answers) unless a test says otherwise.
vi.mock("@/lib/default-bot", async original => ({ ...await original<typeof import("@/lib/default-bot")>(), useViewerEmail: () => f.viewerEmail }));
vi.mock("@/lib/brand", () => ({ productName: () => "Metal" }));
vi.mock("./mascot-view", () => ({ DuskMark: () => null }));
vi.mock("./Avatar", async original => ({ ...await original<typeof import("./Avatar")>(), MausAvatar: () => null }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { snapshot: { state: string; authenticated?: boolean } }) =>
  instance.snapshot.state === "available" && instance.snapshot.authenticated !== false }));
const sleep = vi.hoisted(() => ({ found: null as null | { botId: string; name: string; wokeAt: number } }));
vi.mock("@/lib/asleep-work", async original => ({ ...await original<typeof import("@/lib/asleep-work")>(), useAsleepWork: () => sleep.found }));
import { AppNotices } from "./AppNotices";
import { setLateCloudOnScreen } from "./onboarding/late-cloud";
import { TwoPlacesCard } from "./TwoPlacesCard";
import { ASLEEP_NOTICE, CLOUD_INTRO, GROK_MOVE_NOTICE, localDay, WHATS_NEW_NOTICE } from "@/lib/notices";
import { track } from "@/lib/analytics";
import { api } from "@/state/store";

const DAY = 86_400_000, NOW = new Date(2026, 9, 9, 12).getTime();
const plans = [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const INTRO = "Keep your bots working when this computer is off";
const STAR = "Enjoying Metal?";
const signedOut: CloudAccountState = { status: "signed-out" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });

let storage: Map<string, string>;
let account: CloudAccountState;
let snapshot: CloudPlanSnapshot | Error;
let offer: CloudOffer | null;
let viewer: WelcomeViewer | null;
let bridges: { cloud: Record<string, ReturnType<typeof vi.fn>>; plan: Record<string, ReturnType<typeof vi.fn>> };
let accountListeners: Set<(next: CloudAccountState) => void>;
let now: number;

const PRELOAD = readFileSync(join(process.cwd(), "electron", "preload.cjs"), "utf8").replace(/\r\n/g, "\n");
const LOCAL_ORIGIN = "http://127.0.0.1:8799", MY_CLOUD = "https://dusk-u-1.fly.dev", VPS = "https://bots.example.test";
type Page = "local" | "cloud" | "server";
type Handler = (event: { page: Page; returnValue?: unknown }, ...args: unknown[]) => unknown;
interface Desktop {
  handlers: Map<string, Handler>; listeners: Map<string, Handler>; saved: { seen?: string[] } | null; offered: boolean;
  /** This computer's own workspace config.json, as main reads it. */
  config: unknown;
}
let desk: Desktop;

// Main's own record for this one desktop, behind its real IPC.
function desktopMachine(): Desktop {
  const machine: Desktop = { handlers: new Map(), listeners: new Map(), saved: null, offered: true,
    config: { onboarding: { completedAt: "2026-09-01", version: 1, hintsSeen: [] } } };
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => void machine.handlers.set(channel, handler as Handler), on: (channel, listener) => void machine.listeners.set(channel, listener as Handler) },
    read: () => machine.saved, write: value => { machine.saved = JSON.parse(JSON.stringify(value)); }, page: event => (event as { page: Page }).page,
    cloudOffered: async () => machine.offered, localConfig: () => machine.config,
  });
  return machine;
}

// The real preload, as this desktop's window loads it for a page; the Cloud account and plan answer from this file's fakes.
function windowOn(origin: string, { click = true } = {}) {
  const page: Page = origin === LOCAL_ORIGIN ? "local" : origin === MY_CLOUD ? "cloud" : "server";
  let duskDesktop: Record<string, unknown> = {};
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--dusk-local-origin=${LOCAL_ORIGIN}`, "--dusk-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: click } }, TextEncoder,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name: string, value: Record<string, unknown>) => { duskDesktop = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: (channel: string) => { const event = { page, returnValue: undefined as unknown }; desk.listeners.get(channel)?.(event); return event.returnValue; },
        invoke: async (channel: string, ...args: unknown[]) => desk.handlers.get(channel)?.({ page }, ...args) } }),
  });
  const fakes: Record<string, unknown> = { cloudAccount: bridges.cloud, cloudPlan: bridges.plan, openExternal: vi.fn(async () => true), organization: undefined };
  return { ...duskDesktop, ...Object.fromEntries(Object.entries(fakes).filter(([key]) => key in duskDesktop)) };
}
const showWindow = (origin: string, options?: { click?: boolean }) => {
  vi.stubGlobal("window", { duskDesktop: windowOn(origin, options), addEventListener: vi.fn(), removeEventListener: vi.fn() });
};

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices, { viewer, now: () => now })); };
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
const launch = () => { f.values = []; return settle(); };
/** The app opened again: a new window session, so nothing this launch showed holds the next one back. */
const relaunch = () => { session.clear(); return launch(); };
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const tree = () => { f.index = 0; f.effects = []; return nodes(AppNotices({ viewer, now: () => now })); };
const press = (label: string) => {
  const button = tree().find(node => node.type === "button" && (renderToStaticMarkup(node).includes(`>${label}<`) || node.props["aria-label"] === label));
  expect(button, label).toBeTruthy(); button!.props.onClick();
};
/** A bot has answered once, in this launch: what a new install has after its first chat. */
const FIRST_REPLY = [{ tasks: [{ threadId: "first", usage: { turns: 1 } }] }];
let session: Map<string, string>;
// used before this launch, and invested (shared/cloud-upsell.ts INVESTED: 50 messages)
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 50 } }] }]; };
const launchCardsSeen = () => { desk.saved = { seen: [WHATS_NEW_NOTICE] }; storage.set(GROK_MOVE_NOTICE, "1"); };
const hints = () => f.state.config.onboarding.hintsSeen as string[];

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  storage = new Map(); f.values = []; f.index = 0; f.effects = []; f.dispatch = vi.fn(); now = NOW; desk = desktopMachine();
  setLocale("en"); viewer = LOCAL_VIEWER; account = signedOut; snapshot = { status: "none" }; offer = TRIAL_OFFER;
  session = new Map(); f.viewerEmail = undefined;
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
  f.state = { connected: true, hydrated: true, bots: structuredClone(FIRST_REPLY), groups: [], routines: [], instances: [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }],
    config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: [] } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const patch = JSON.parse(String((init as RequestInit).body));
    f.state.config.onboarding.hintsSeen = patch.onboarding.hintsSeen;
    return f.state.config;
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  launchCardsSeen();
  accountListeners = new Set();
  bridges = {
    cloud: { state: vi.fn(async () => account), onState: vi.fn((listener: (next: CloudAccountState) => void) => { accountListeners.add(listener); return () => accountListeners.delete(listener); }),
      offer: vi.fn(async () => offer), begin: vi.fn(async () => account),
      signInAgain: vi.fn(async () => account), connectHome: vi.fn(async () => account), openDashboard: vi.fn(async () => account) },
    plan: { state: vi.fn(async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }), manage: vi.fn(async () => {}), noticeSeen: vi.fn(async () => {}) },
  };
  showWindow(LOCAL_ORIGIN);
  vi.stubGlobal("document", { activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("the card after the update", () => {
  it("offers the free trial to someone signed out who has used the app before, in the Admin's numbers, with Start free trial and Show me how", async () => {
    vi.stubEnv("VITE_DUSK_PHONE_APP", "0");
    returning();
    const html = await launch();
    const words = [INTRO, "Free for 7 days", "dusk cloud runs your bots for you in the cloud, always available.", "Routines run on time, day and night",
      "Then from $15/month + tax where applicable. Cancel any time.",
      "14-day money-back on every plan.", "Start free trial", "Show me how", "Sign in to your cloud plan", "Not now"];
    for (const text of words) expect(html).toContain(text);
    for (let i = 1; i < words.length; i++) expect(html.indexOf(words[i - 1]!), words[i]).toBeLessThan(html.indexOf(words[i]!));
    for (const gone of ["launch price", "first 100", "$89", "New features first", "Get Pro", STAR]) expect(html).not.toContain(gone);
    // the phone app is off until it ships (phoneAppEnabled), so its line stays off the card
    expect(html).not.toContain("Reach your bots from your phone");
    expect(html).not.toContain('aria-modal="true"');
    expect(bridges.cloud.offer).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith("cloud_card_shown", { variant: "signed_out" });
    expect(JSON.parse(storage.get(`${CLOUD_INTRO}:days`)!)).toEqual([localDay(NOW)]);
    expect(hints()).toContain(`${CLOUD_INTRO}:day-1`);
    expect(await settle()).toContain(INTRO);
    expect(await launch()).toBe("");
    now = NOW + 3 * 3600_000; expect(await launch()).toBe("");
    now = NOW + DAY; expect(await launch(), "an ignored card rests the next day").toBe("");
    now = NOW + 2 * DAY; account = free;
    const again = await launch();
    expect(again).toContain(INTRO); expect(again).not.toContain("Sign in to your cloud plan");
    expect(track).toHaveBeenCalledWith("cloud_card_shown", { variant: "free" });
  });

  it("waits until someone is invested: a returning person with a few chats gets no corner cloud card", async () => {
    f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }];
    expect(await launch()).not.toContain(INTRO);
    f.state.routines = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(await relaunch()).toContain(INTRO);
  });

  it("needs a trial: without one it stays quiet, and without money-back from the Admin it says none", async () => {
    returning(); offer = { ...PLAIN_OFFER };
    let html = await launch();
    expect(html).not.toContain(INTRO); expect(html).not.toContain(STAR);
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    offer = null; expect(await relaunch()).not.toContain(INTRO);
    offer = { ...TRIAL_OFFER, refundDays: undefined };
    html = await relaunch();
    expect(html).toContain(INTRO); expect(html).toContain("dusk cloud runs your bots for you in the cloud, always available.");
    expect(html).not.toContain("money-back"); expect(html).not.toContain("Claude credit");
  });

  it("never to someone new this launch, who pays or may pay, or a desktop signed in with an organization", async () => {
    expect(await launch()).toBe("");
    returning();
    for (const state of [paid(), paid({ trial: trial("active") }), { ...free, purchase: { state: "confirming" as const } },
      { status: "reauth-required" as const, lastPlan: { active: true } }, { status: "unavailable" as const }, { status: "connecting" as const }]) {
      account = state; expect(await launch(), JSON.stringify(state)).not.toContain(INTRO);
    }
    account = signedOut;

    (window.duskDesktop as Record<string, unknown>).organization = { state: async () => ({ status: "connected", organization: { id: "o", name: "Acme" } }), onState: () => () => {} };
    const org = await launch();
    expect(org).not.toContain(INTRO); expect(org).not.toContain(STAR);
  });

  it("a bot working when this computer slept: dusk cloud offered once, counted as its own upsell", async () => {
    sleep.found = { botId: "q", name: "Quill", wokeAt: NOW };
    launchCardsSeen();
    expect(await launch()).toContain("Quill paused while this Mac slept");
    expect(track).toHaveBeenCalledWith("upsell_shown", { source: "app_asleep" });
    press("Get dusk cloud"); await flush();
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "openCloudAdd", source: "app_asleep" }));
    expect(track).toHaveBeenCalledWith("upsell_click", expect.objectContaining({ source: "app_asleep" }));
    expect(hints()).toContain(ASLEEP_NOTICE);
    sleep.found = null;
  });

  it("Start free trial opens the Add a Cloud dialog from the card, and the card is done for good", async () => {
    returning(); await launch();
    press("Start free trial"); await flush();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_card" });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "start", ms: expect.any(Number) });
    expect(storage.get(CLOUD_INTRO)).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
    expect(render()).toBe("");
    now = NOW + 5 * DAY; storage.clear(); launchCardsSeen(); expect(await launch()).not.toContain(INTRO);
  });

  it("Show me how starts the one-step tip; Not now, the X and Escape end it for good, then say where Add a Cloud lives", async () => {
    returning(); await launch();
    press("Show me how");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "cloudHowTo", open: true });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "howto", ms: expect.any(Number) });
    expect(storage.get(CLOUD_INTRO)).toBe("1");
    for (const close of ["Not now", "Dismiss for good", "Escape"]) {
      storage.clear(); launchCardsSeen(); f.state.config.onboarding.hintsSeen = []; now += DAY;
      expect(await launch(), close).toContain(INTRO);
      if (close === "Escape") {
        const card = tree().find(node => node.type === "aside")!;
        const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
        card.props.onKeyDown(event); expect(event.preventDefault).toHaveBeenCalled();
      } else press(close);
      expect(storage.get(CLOUD_INTRO), close).toBe("1"); expect(hints()).toContain(CLOUD_INTRO);
      expect(render()).toContain("You can add a cloud any time from the menu on the left of the app.");
    }
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "not_now", ms: expect.any(Number) });
    expect(track).toHaveBeenCalledWith("cloud_card_action", { action: "close", ms: expect.any(Number) });
  });

  it("sign in to your Cloud plan opens the sheet at its own sign-in and only hides the card for now", async () => {
    returning(); await launch();
    press("Sign in to your cloud plan");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_card", signIn: true });
    expect(storage.get(CLOUD_INTRO)).toBeUndefined(); expect(render()).toBe("");
    now = NOW + 2 * DAY; expect(await launch()).toContain(INTRO);
  });

  it("shows on at most three days, or one for someone who closed the earlier Pro card", async () => {
    returning();
    for (let day = 0; day < 3; day++) { now = NOW + day * 2 * DAY; expect(await relaunch(), `day ${day}`).toContain(INTRO); }
    now = NOW + 6 * DAY;
    const after = await relaunch();
    expect(after).not.toContain(INTRO); expect(after).not.toContain(STAR);
    storage.clear(); launchCardsSeen(); f.state.config.onboarding.hintsSeen = ["pro-introduction-dismissed-v3"];
    now = NOW + 10 * DAY; expect(await relaunch()).toContain(INTRO);
    now = NOW + 11 * DAY; expect(await relaunch()).not.toContain(INTRO);
  });

  it("never after the welcome's Cloud step, which was this desktop's Cloud offer however it was answered", async () => {
    returning(); f.state.config.onboarding.hintsSeen = ["onboarding-cloud-v1"];
    for (const state of [signedOut, free]) {
      account = state;
      for (let day = 0; day < 3; day++) {
        now = NOW + day * DAY;
        const html = await launch();
        expect(html, `${state.status} day ${day}`).not.toContain(INTRO); expect(html, `${state.status} day ${day}`).not.toContain(STAR);
      }
    }
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    expect(track).not.toHaveBeenCalledWith("cloud_card_shown", expect.anything());
    expect(bridges.cloud.offer, "nothing to load the offer for").not.toHaveBeenCalled();
  });

  it("never over setup, a dialog, the Add a Cloud dialog or its tip, busy work, or an update being offered", async () => {
    returning();
    const waits: Array<() => void> = [
      () => { f.state.welcomeOpen = true; }, () => { f.state.appSettingsOpen = true; },
      () => { f.state.cloudAdd = { source: "app_menu" }; }, () => { f.state.cloudHowTo = true; },
      () => { f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; }, () => { f.state.connected = false; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).toBe("");
      f.state = saved;
    }
    expect(storage.get(`${CLOUD_INTRO}:days`)).toBeUndefined();
    expect(await launch()).toContain(INTRO);
  });

  it("never over the late plan's making screen: the card waits until it closes", async () => {
    returning();
    setLateCloudOnScreen(true);
    try { expect(await launch()).toBe(""); } finally { setLateCloudOnScreen(false); }
    expect(await launch()).toContain(INTRO);
  });
});

describe("the free trial's notice, here and on My Cloud", () => {
  it("shows the notice main says is due, tells main once, and stays up until it is closed", async () => {
    const running = trial("active", { switchTo: { tier: "starter", amount: 1500 } });
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    offer = { ...PLAIN_OFFER };
    const html = await launch();
    expect(html).toContain("Your free trial ends on"); expect(html).not.toContain("Claude credit");
    expect(html).toContain("Prefer Plus at $15?");
    expect(bridges.cloud.offer, "the trial's notice needs nothing from the offer").not.toHaveBeenCalled();
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    snapshot = { ...snapshot, notice: undefined };
    expect(await settle()).toContain("Your free trial ends on");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    press("Manage subscription"); await flush();
    expect(bridges.plan.manage).toHaveBeenCalledOnce();
    expect(render()).toBe("");
    expect(await launch()).not.toContain("your free trial");
  });

  it("on My Cloud's own page, only the trial's notice, after its sign-in and setup checklist", async () => {
    viewer = { canSave: true, cloudHome: true };
    showWindow(MY_CLOUD);
    returning();
    snapshot = { status: "none", trial: trial("ended", { deleteAt: NOW + 3 * DAY, keep: "checkout" }), notice: "ended" };
    f.state.config.onboarding.hintsSeen = ["cloud-setup-hidden"];
    expect(await launch()).toContain("Your free trial has ended");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: false } }];
    expect(await launch()).toBe("");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }];
    snapshot = { status: "none" };
    expect(await launch()).toBe("");
    expect(bridges.cloud.offer).not.toHaveBeenCalled();
    snapshot = new Error("only available in this app's window");
    expect(await launch()).toBe("");
  });
});

describe("the first conversation after meeting the Chief", () => {
  it("holds every corner notice, an account's own too, until the person has written and had a reply", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.config.onboarding.hintsSeen = [MET_CHIEF_HINT];
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toBe("");
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch()).toContain("Your free trial ends on");
  });

  it("changes nothing for an install whose first run came before: its notices keep their own rules", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toContain("Your free trial ends on");
  });
});

describe("upstream promotional campaigns", () => {
  it("does not advertise retired desktop provider credits, upstream mobile apps or community promotions to returning users", async () => {
    account = { ...free }; offer = { ...PLAIN_OFFER }; returning();
    const html = await launch();
    for (const campaign of ["Enjoying Metal?", "live on Product Hunt", "$50 of \x42oat credit", "\x62oat.dev", "Get Metal updates?"]) expect(html).not.toContain(campaign);
  });

  it("keeps an expired account's sign-in recovery", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }; returning();
    expect(await launch()).toContain("Sign in again to reach the cloud");
    press("Sign in again"); await flush();
    expect(bridges.cloud.signInAgain).toHaveBeenCalledOnce();
  });
});

describe("bots in two places", () => {
  const GARAGE = { key: "server:https://garage.example.test", name: "Garage server", kind: "server" as const };
  const BODY = "Your bots live in two places, so they can&#x27;t work together. Bring them together on Garage server?";
  let suggest: { key: string; name: string; kind: "cloud" | "server" } | null;
  let accepted: string[], dismissed: string[];
  beforeEach(() => {
    suggest = GARAGE; accepted = []; dismissed = [];
    desk.handlers.set("two-places:state", async () => ({ suggest }));
    desk.handlers.set("two-places:accept", async (_event, key) => { accepted.push(String(key)); suggest = null; return { suggest }; });
    desk.handlers.set("two-places:dismiss", async (_event, key) => { dismissed.push(String(key)); suggest = null; return { suggest }; });
  });

  it("one plain card on this computer's page, before any promotion; bots move there only after the person confirms (#4192)", async () => {
    returning();
    const html = await launch();
    expect(html).toContain('data-notice="two-places"');
    expect(html).toContain("Bring your bots together");
    expect(html).toContain(BODY);
    expect(html).not.toContain(STAR);
    press("Bring them together");
    const asking = await settle();
    expect(accepted, "one tap never moves anyone").toEqual([]);
    expect(asking).toContain("Move this computer&#x27;s bots to Garage server?");
    expect(asking, "the undo switch is My Cloud's only").not.toContain("keep this computer&#x27;s bots on this computer");
    press("Move bots");
    await flush();
    expect(accepted).toEqual([GARAGE.key]);
    expect(track).toHaveBeenCalledWith("two_places_card", { action: "bring", kind: "server", ms: expect.any(Number) });
    expect(await settle()).not.toContain('data-notice="two-places"');
  });

  it("Cancel on the confirm step moves nothing and keeps the card (#4192)", async () => {
    returning();
    suggest = { key: "cloud:mine", name: "My Cloud", kind: "cloud" };
    await launch();
    press("Bring them together");
    const asking = await settle();
    expect(asking).toContain("Move this computer&#x27;s bots to My Cloud?");
    expect(asking, "My Cloud names the way back").toContain("keep this computer&#x27;s bots on this computer");
    press("Cancel");
    const after = await settle();
    expect(accepted).toEqual([]);
    expect(dismissed).toEqual([]);
    expect(after).toContain('data-notice="two-places"');
    expect(after).not.toContain("Move bots");
    expect(after).toContain("Bring them together");
    expect(tree().find(node => node.props["data-two-places-bring"])?.props.autoFocus, "focus returns to the button Cancel brought back").toBe(true);
  });

  it("Escape on the confirm step works as Cancel and never dismisses the card", async () => {
    returning();
    await launch();
    press("Bring them together");
    await settle();
    const escape = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tree().find(node => node.props.role === "group")!.props.onKeyDown(escape);
    expect(escape.stopPropagation, "the card's own Escape never sees it").toHaveBeenCalled();
    const after = await settle();
    expect(dismissed).toEqual([]);
    expect(accepted).toEqual([]);
    expect(after).toContain('data-notice="two-places"');
    expect(after).not.toContain("Move bots");
  });

  it("a different suggested place starts a fresh card, so a confirm never carries over to it", async () => {
    returning();
    await launch();
    // Children.toArray would re-key, so walk the elements as rendered.
    const find = (value: unknown): Node | undefined => {
      if (Array.isArray(value)) return value.map(find).find(Boolean);
      if (!isValidElement(value)) return undefined;
      const node = value as Node;
      if (node.type === TwoPlacesCard) return node;
      return typeof node.type === "function" ? find((node.type as (props: unknown) => ReactNode)(node.props)) : find(node.props.children);
    };
    f.index = 0; f.effects = [];
    expect(find(AppNotices({ viewer, now: () => now }))?.key).toBe(GARAGE.key);
  });

  it("Not now hands main the place to remember, and the card goes", async () => {
    returning();
    expect(await launch()).toContain(BODY);
    press("Not now");
    await flush();
    expect(dismissed).toEqual([GARAGE.key]);
    expect(await settle()).not.toContain('data-notice="two-places"');
    expect(await launch(), "main remembers it: never asked again").not.toContain('data-notice="two-places"');
  });

  it("never during the welcome, on a Cloud's or a server's page, or when main suggests nothing", async () => {
    returning();
    f.state.welcomeOpen = true;
    expect(await launch()).not.toContain('data-notice="two-places"');
    f.state.welcomeOpen = false;
    for (const origin of [MY_CLOUD, VPS]) {
      showWindow(origin);
      expect(await launch(), origin).not.toContain('data-notice="two-places"');
    }
    showWindow(LOCAL_ORIGIN);
    suggest = null;
    expect(await launch()).not.toContain('data-notice="two-places"');
  });

  it("is this computer's page's alone: no other page gets the bridge, and none would show it", async () => {
    returning();
    expect(windowOn(LOCAL_ORIGIN).twoPlaces).toBeDefined();
    for (const origin of [MY_CLOUD, VPS]) expect(windowOn(origin).twoPlaces, origin).toBeUndefined();
    const ask = vi.fn(async () => ({ suggest: GARAGE }));
    vi.stubGlobal("window", { duskDesktop: { ...windowOn(MY_CLOUD), twoPlaces: { state: ask, accept: ask, dismiss: ask, onChanged: () => () => {} } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    expect(await launch(), "a Cloud's page handed the bridge anyway").not.toContain('data-notice="two-places"');
  });
});

describe("the invested pitch", () => {
  const bots = (count: number) => Array.from({ length: count }, (_, i) => ({ tasks: [{ threadId: `t${i}`, createdAt: NOW, usage: { turns: 1 } }] }));

  it("is never a corner notice: it lives in the sidebar card (CloudUpsell.test.ts)", async () => {
    f.state.bots = bots(3);
    const html = await launch();
    expect(html).not.toContain("good crew of bots");
    expect(html).not.toContain('data-notice="cloud-invested"');
    expect(track).not.toHaveBeenCalledWith("upsell_shown", { source: "app_invested" });
  });
});
