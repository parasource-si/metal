import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudCheckoutResult } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudTeam, CloudTrial } from "../../electron/cloud-home.mjs";
import { parseCloudOffer } from "../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

// useState by call order; useEffect as React runs it: again only when its dependencies change, after the last one's cleanup.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as Array<{ effect: EffectCallback; deps?: readonly unknown[] }>,
  ran: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void } | undefined>, state: {} as any, dispatch: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback, deps?: readonly unknown[]) => { f.effects.push({ effect, deps }); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./cloud-buy/AddCloudFlow", () => ({ AddCloudFlow: ({ source }: { source?: string }) => createElement("div", { "data-add-cloud-flow": source ?? "" }) }));
import { CloudAddDialog, CloudAddPanel, CloudAddSheet, type CloudAddActions, type CloudAddUi } from "./CloudAddDialog";
import { ChooseScreen } from "./cloud-buy/ChooseScreen";
import { cloudAddView, type CloudAddView } from "@/lib/cloud-plan";
import { track } from "@/lib/analytics";
import { showWelcome } from "@/lib/onboarding";

const DAY = 86_400_000, NOW = new Date(2026, 9, 8, 12).getTime();
const allowances = (cpus: number, maxDiskGb: number, computers: number, computerHours: number, voiceCharacters: number) =>
  ({ cpus, cpuKind: "shared" as const, memoryMb: cpus * 1024, swapMb: cpus === 2 ? 3072 : 4096, diskGb: 10, maxDiskGb, computers, computerHours, voiceCharacters, snapshotDays: 14 });
const PLANS = [
  { tier: "starter", label: "Starter", amount: 1500, allowances: allowances(2, 20, 15, 100, 30_000), trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, allowances: allowances(4, 100, 15, 300, 60_000), trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, allowances: allowances(8, 100, 15, 800, 180_000), trialDays: 7 },
];
const TRIAL: CloudOffer = { plans: PLANS, recommended: "pro", reminderDays: 2, refundDays: 14 };
const PLAIN: CloudOffer = { plans: PLANS.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const EMAIL = "person@example.test";
const free: CloudAccountState = { status: "connected", account: { id: "a", email: EMAIL }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const trial = (extra: Partial<CloudTrial> = {}): CloudTrial => ({ state: "active", tier: "pro", endsAt: NOW + 7 * DAY, amount: 4900, chargeAt: NOW + 7 * DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });
const ready = { status: "ready" as const, origin: "https://dusk-u-1.fly.dev" };
const acme = (machine: CloudTeam["machine"] = { status: "ready", origin: "https://dusk-t-2.fly.dev" }): CloudTeam => ({ id: "team-acme", name: "Acme", role: "owner", machine });
const onTeam = (machine?: CloudTeam["machine"]): CloudAccountState => paid({ entitlement: { plan: "pro", tier: "team", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, teams: [acme(machine)] });

type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const label = (node: Node) => text(renderToStaticMarkup(node));
const button = (tree: Node[], name: string) => tree.find(node => node.type === "button" && (label(node) === name || label(node).startsWith(name) || node.props["aria-label"] === name));
const actions = (): CloudAddActions => Object.fromEntries(["start", "signIn", "back", "email", "sendCode", "changeEmail", "code", "resend", "browser", "reopenBrowser",
  "cancelSignIn", "reopenCheckout", "resume", "copyLink", "changePlan", "retry", "name", "color", "openCloud", "openTeam", "notNow", "interest", "close"].map(name => [name, vi.fn()])) as unknown as CloudAddActions;
const baseUi = (extra: Partial<CloudAddUi> = {}): CloudAddUi => ({ chosen: null, current: null, offerShown: TRIAL, now: NOW, busy: false, openFailed: false, email: EMAIL, code: "", profileEmail: EMAIL,
  look: { typed: "Studio", name: "Studio", color: "teal" }, counting: null, copied: false, payFailed: false, interest: null, ...extra });
const panel = (view: CloudAddView, extra: Partial<CloudAddUi> = {}) => {
  const handlers = actions(), props = { view, ui: baseUi(extra), actions: handlers };
  return { html: renderToStaticMarkup(createElement(CloudAddPanel, props)), tree: nodes(CloudAddPanel(props)), handlers };
};
/** Each word appears, each after the one before it. */
const inOrder = (plain: string, words: string[]) => {
  let at = 0;
  for (const word of words) {
    const found = plain.indexOf(word, at);
    expect(found, `"${word}" after "${plain.slice(Math.max(0, at - 40), at)}"`).toBeGreaterThanOrEqual(0);
    at = found + word.length;
  }
};

beforeEach(() => { vi.clearAllMocks(); setLocale("en"); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("each screen of the sheet says one thing and offers one next step", () => {
  it("choose: the one reason, the plans side by side as cards with what each is for, its price and its machine, one button that names the picked one; the money once, under it", () => {
    const { html, tree, handlers } = panel({ kind: "offer", offer: TRIAL, signedOut: true, notice: null });
    inOrder(text(html), ["dusk cloud", "Keep your bots working when this computer is off", "Plus", "Your bots keep working with the laptop shut", "$15", "a month after 7 days free",
      "Pro", "For heavy workloads, and for work", "$49", "a month after 7 days free", "4 vCPU, 4 GB RAM", "10 GB disk, grows to 100 GB", "Priority wake", "Work license for one person",
      "Max", "The biggest machine, for heavy work", "$99", "Try Pro free for 7 days", "7 days free, then $49/month + tax where applicable. Nothing charged until then. Cancel any time.", "14-day money-back.", "Already have a plan? Sign in"]);
    expect(html, "the name and the reason head the sheet").toMatch(/<header[^>]*><p[^>]*>dusk cloud<\/p><h2 id="cloud-add-title"/);
    const radios = tree.filter(node => node.type === "input" && node.props.type === "radio");
    expect(radios.map(node => [node.props["data-plan-pick"], node.props.name, node.props.checked, node.props.tabIndex]),
      "one radio per card, the Admin's recommended one picked and the only one in the tab order").toEqual([["starter", "cloud-plan", false, -1], ["pro", "cloud-plan", true, 0], ["max", "cloud-plan", false, -1]]);
    expect(tree.find(node => node.props.role === "radiogroup")!.props["aria-label"]).toBe("Choose your plan");
    expect(radios.map(node => node.props["aria-label"]), "each card's name and price said once to a screen reader").toEqual(["Plus, $15 a month", "Pro, $49 a month", "Max, $99 a month"]);
    expect(html.match(/data-plan-line=/g), "four lines on every card").toHaveLength(12);
    expect(html.match(/<img /g), "a landscape on each card and the cat on Pro's").toHaveLength(4);
    const buy = tree.filter(node => node.props["data-plan-buy"]);
    expect(buy.map(node => [node.props["data-plan-buy"], node.props.className.includes("ui-button-primary")]), "one primary button, for the picked plan").toEqual([["pro", true]]);
    expect(html.match(/data-plan-terms/g), "the money said once").toHaveLength(1);
    expect(html).not.toContain("data-plan-mine");
    for (const gone of ["Compare plans", "Most popular", "Every plan includes", "Apple Pay", "G Pay", "Secure checkout", "Cancel in two clicks", "aria-expanded", "Trial starts",
      "of swap", "launch", "$89", "Recommended", "AI credit", "This Mac", "A day", "computers at once", "hours a month", "shared", "24/7", "always on", "Personal", "$29",
      "Sleeps", "Everything in", "What Pro gives you", "Due today", "Gmail", "custom", "Customize", "Configure", "Daily backups, kept", "Routines run on time, day and night"]) {
      expect(text(html)).not.toContain(gone);
    }
    buy[0]!.props.onClick(); expect(handlers.start).toHaveBeenCalledExactlyOnceWith("pro");
    button(tree, "Already have a plan? Sign in")!.props.onClick(); expect(handlers.signIn).toHaveBeenCalledOnce();
    const maxFirst = panel({ kind: "offer", offer: { ...TRIAL, recommended: "max" }, signedOut: false, notice: null });
    expect(maxFirst.tree.filter(node => node.props["data-plan-buy"]).map(node => node.props["data-plan-buy"]), "the Admin's recommended plan, not Pro by itself").toEqual(["max"]);
    inOrder(text(maxFirst.html), ["The biggest machine, for heavy work", "8 vCPU, 8 GB RAM", "10 GB disk, grows to 100 GB"]);
  });

  it("choose: a card picks its plan, and a person's own plan cannot be picked", () => {
    const radios = (current: string | null = null) => { f.values = []; f.index = 0;
      return nodes(createElement(ChooseScreen, { offer: TRIAL, current, now: NOW, busy: false, signedOut: false, notice: null, onStart: vi.fn(), onSignIn: vi.fn() }))
        .filter(node => node.props["data-plan-pick"]); };
    radios().find(node => node.props["data-plan-pick"] === "max")!.props.onChange(); expect(f.values[0]).toBe("max");
    const mine = radios("pro").find(node => node.props["data-plan-pick"] === "pro")!;
    expect(mine.props.disabled).toBe(true);
    mine.props.onChange(); expect(f.values[0], "their own plan picks nothing").toBeNull();
  });

  it("Choose for someone on a plan: their card says Your plan and cannot be picked, and a Personal subscriber's own card is theirs alone", () => {
    const { html, tree } = panel({ kind: "offer", offer: TRIAL, signedOut: false, notice: null }, { current: "pro" });
    expect(html.match(/data-plan-mine/g)).toHaveLength(1);
    expect(html.indexOf("data-plan-mine")).toBeGreaterThan(html.indexOf('data-plan="pro"'));
    expect(html.indexOf("data-plan-mine")).toBeLessThan(html.indexOf('data-plan="max"'));
    expect(tree.find(node => node.props["data-plan-pick"] === "pro")!.props.disabled, "their own plan").toBe(true);
    expect(tree.filter(node => node.props["data-plan-buy"]).map(node => node.props["data-plan-buy"]), "the first plan they can buy").toEqual(["starter"]);
    inOrder(text(html), ["Pro", "Your plan", "Max", "Try Plus free for 7 days"]);
    const personal = { ...PLANS[0]!, tier: "personal", label: "Personal", amount: 2900 };
    const mine = renderToStaticMarkup(createElement(ChooseScreen, { offer: TRIAL, current: "personal", own: personal, now: NOW, busy: false, signedOut: false, notice: null,
      onStart: vi.fn(), onSignIn: vi.fn() }));
    inOrder(text(mine), ["Plus", "Personal", "Your plan", "Pro", "Max", "Try Pro free for 7 days"]);
    expect(mine.match(/data-plan-mine/g)).toHaveLength(1);
    expect(mine.match(/data-plan-buy=/g)).toHaveLength(1);
    const theirs = renderToStaticMarkup(createElement(ChooseScreen, { offer: TRIAL, current: null, own: personal, now: NOW, busy: false, signedOut: false, notice: null,
      onStart: vi.fn(), onSignIn: vi.fn() }));
    for (const gone of ["Personal", "$29"]) expect(theirs).not.toContain(gone);
    expect(text(theirs)).not.toMatch(/(?<!Choose )[Yy]our plan/);
  });

  it("Choose from an Admin that still sells Personal: no Personal card, Pro picked", () => {
    const wire = ({ tier, label, amount, allowances }: (typeof PLANS)[number]) => ({ tier, label, price: { currency: "USD", amount, interval: "month" }, allowances });
    const personal = { ...PLANS[0]!, tier: "personal", label: "Personal", amount: 2900 };
    for (const recommended of ["pro", "personal"]) {
      const older = parseCloudOffer({ plans: [wire(PLANS[0]!), wire(personal), wire(PLANS[1]!), wire(PLANS[2]!)], recommended, trialDays: 7, refundDays: 14 })!;
      const { html, tree } = panel({ kind: "offer", offer: older, signedOut: true, notice: null }, { offerShown: older });
      const why = `recommended ${recommended}`;
      for (const gone of ["Personal", "$29", 'data-plan="personal"']) expect(html, why).not.toContain(gone);
      expect(html.match(/data-plan-pick="[a-z]+"/g), why).toEqual(['data-plan-pick="starter"', 'data-plan-pick="pro"', 'data-plan-pick="max"']);
      expect(tree.filter(node => node.props["data-plan-buy"]).map(node => node.props["data-plan-buy"]), why).toEqual(["pro"]);
      expect(html, why).toContain('aria-label="Pro, $49 a month"');
      inOrder(text(html), ["Plus", "Pro", "4 vCPU, 4 GB RAM", "Max"]);
    }
  });

  it("Choose: Plus and Team read true to the Admin's allowances, and an older Admin that says nothing of sleeping or seats still gets them right", () => {
    const wire = (tier: string, label: string, amount: number, allowances: Record<string, unknown>) => ({ tier, label, price: { currency: "USD", interval: "month", amount },
      allowances: { computers: 0, computerHours: 720, voiceCharacters: 0, ...allowances } });
    const plus = { cpus: 2, memoryMb: 4096, diskGb: 20, maxDiskGb: 20 }, team = { cpus: 8, memoryMb: 16384, diskGb: 160, maxDiskGb: 200 };
    const shown = (plans: unknown[], recommended: string) => text(renderToStaticMarkup(createElement(ChooseScreen, { offer: parseCloudOffer({ plans, recommended })!, now: NOW, busy: false,
      signedOut: false, notice: null, onStart: vi.fn(), onSignIn: vi.fn() })));
    const card = (plans: unknown[], tier: string) => text(renderToStaticMarkup(createElement(ChooseScreen, { offer: parseCloudOffer({ plans, recommended: tier })!, now: NOW, busy: false,
      signedOut: false, notice: null, onStart: vi.fn(), onSignIn: vi.fn() })).match(new RegExp(`<label data-plan="${tier}"[\\s\\S]*?</label>`))![0]);
    const now = [wire("starter", "Plus", 2000, { ...plus, sleeps: true }), wire("team", "Team", 11900, { ...team, seats: 50, includedSeats: 2, extraSeatCents: 2000 })];
    inOrder(shown(now, "team"), ["Plus", "Your bots keep working with the laptop shut", "$20", "a month", "2 vCPU, 4 GB RAM", "20 GB disk", "Wakes in seconds", "No work license",
      "Team", "A dedicated machine for your team", "$119", "a month", "Dedicated 8 vCPU, 16 GB RAM", "160 GB disk, grows to 200 GB", "Priority wake",
      "2 seats, more at $20/month each, up to 50", "Get Team for $119/month"]);
    expect(card(now, "starter")).not.toContain("Priority wake");
    expect(shown([wire("starter", "Plus", 2000, plus), wire("team", "Team", 11900, { ...team, seats: 50, includedSeats: 3, extraSeatCents: 2500 })], "team"),
      "the seats are the Admin's").toContain("3 seats, more at $25/month each, up to 50");
    const old = [wire("starter", "Plus", 2000, plus), wire("pro", "Pro", 5000, { cpus: 4, memoryMb: 8192, diskGb: 60, maxDiskGb: 60 }), wire("team", "Team", 11900, team)];
    expect(card(old, "starter"), "an older Admin: Plus still wakes in seconds").toContain("Wakes in seconds");
    expect(card(old, "starter")).not.toContain("Priority wake");
    expect(card(old, "pro")).toContain("Priority wake");
    inOrder(card(old, "team"), ["Dedicated 8 vCPU, 16 GB RAM", "Priority wake", "2 seats, more at $20/month each, up to 50"]);
    const html = renderToStaticMarkup(createElement(ChooseScreen, { offer: parseCloudOffer({ plans: now, recommended: "team" })!, now: NOW, busy: false, signedOut: false, notice: null,
      onStart: vi.fn(), onSignIn: vi.fn() }));
    expect(html).toContain('aria-label="Team, $119 a month"');
    const odd = renderToStaticMarkup(createElement(ChooseScreen, { offer: { plans: [{ tier: "starter", label: "Plus", amount: 2000 }], recommended: "starter" }, now: NOW, busy: false, signedOut: false,
      notice: null, onStart: vi.fn(), onSignIn: vi.fn() }));
    expect(odd, "no allowances, no lines").not.toContain("data-plan-line");
    expect(text(odd)).toContain("Your bots keep working with the laptop shut");
  });

  it("Choose without a trial: the button names the plan and its price, the money said once under it; no Sign in once signed in", () => {
    const { html, tree, handlers } = panel({ kind: "offer", offer: PLAIN, signedOut: false, notice: null }, { offerShown: PLAIN });
    const plain = text(html);
    inOrder(plain, ["Plus", "Pro", "Max", "a month", "Get Pro for $49/month", "Monthly, plus tax where applicable. Cancel any time.", "14-day money-back."]);
    for (const gone of ["Card needed", "days free", "Trial starts", "Reminder email", "First payment", "Already have a plan", "Claude credit", "Start free trial", "today, then each month"]) expect(plain).not.toContain(gone);
    button(tree, "Get Pro")!.props.onClick(); expect(handlers.start).toHaveBeenCalledExactlyOnceWith("pro");
    expect(text(panel({ kind: "offer", offer: { ...PLAIN, refundDays: undefined }, signedOut: false, notice: null }).html)).not.toContain("money-back");
    expect(text(panel({ kind: "offer", offer: TRIAL, signedOut: true, notice: "code-expired" }).html)).toContain("The sign-in code expired, so nothing changed.");
    expect(panel({ kind: "offer", offer: TRIAL, signedOut: true, notice: null }, { busy: true }).tree.filter(node => node.props["data-plan-buy"]).every(node => node.props.disabled),
      "busy, the button starts nothing").toBe(true);
  });

  it("Choose to move bots: what moves after paying, between the plans and the button; any other way in shows the plans alone", () => {
    const moving = text(panel({ kind: "offer", offer: PLAIN, signedOut: false, notice: null }, { offerShown: PLAIN, moving: true }).html);
    inOrder(moving, ["Max", "After you pay, this moves to dusk cloud", "Bots and their chats", "Memory and files", "Routines", "Saved logins and passwords",
      "Connected apps and AI keys", "This computer keeps working until the move is done, then keeps a copy.", "Get Pro for $49/month"]);
    expect(moving).not.toMatch(/Claude or ChatGPT|minutes/u);
    expect(text(panel({ kind: "offer", offer: PLAIN, signedOut: false, notice: null }, { offerShown: PLAIN }).html)).not.toContain("this moves");
  });

  it("checking, Cloud out of reach and a checkout that did not open each say so, with Try again", () => {
    expect(text(panel({ kind: "checking" }).html)).toContain("Checking with dusk cloud…");
    const unreachable = panel({ kind: "unreachable" });
    expect(text(unreachable.html)).toContain("Can't reach dusk cloud right now. Check your connection and try again.");
    button(unreachable.tree, "Try again")!.props.onClick(); expect(unreachable.handlers.retry).toHaveBeenCalledOnce();
    expect(text(panel({ kind: "error", reason: "failed" }).html)).toContain("Checkout couldn't open. Nothing was charged. Try again.");
    expect(text(panel({ kind: "error", reason: "rate-limited" }).html)).toContain("You've opened several checkouts in the last hour.");
  });

  it("Sign in, email: create the account with a code, the profile's email filled in, and single sign-on in the browser", () => {
    const { html, tree, handlers } = panel({ kind: "sign-in", phase: { step: "email", intent: true, problem: null } });
    inOrder(text(html), ["Plans", "Create your Dusk account", "We'll email you a code. No password to remember.", "Email", "Send code",
      "Uses the email from your profile. You can change it.", "Work account with single sign-on? Continue in browser"]);
    const field = tree.find(node => node.props.id === "cloud-add-email")!;
    expect([field.props.value, field.props.type, field.props.autoComplete]).toEqual([EMAIL, "email", "email"]);
    field.props.onChange({ target: { value: "other@example.test" } }); expect(handlers.email).toHaveBeenCalledWith("other@example.test");
    tree.find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); expect(handlers.sendCode).toHaveBeenCalledOnce();
    button(tree, "Plans")!.props.onClick(); expect(handlers.back).toHaveBeenCalledOnce();
    button(tree, "Continue in browser")!.props.onClick(); expect(handlers.browser).toHaveBeenCalledOnce();
    expect(text(panel({ kind: "sign-in", phase: { step: "email", intent: false, problem: null } }, { email: "else@example.test" }).html))
      .toMatch(/^Plans Sign in to dusk cloud(?!.*from your profile)/);
    expect(text(panel({ kind: "sign-in", phase: { step: "email", intent: true, problem: null } }, { profileEmail: null }).html)).not.toContain("from your profile");
  });

  it("Sign in, code: eight boxes, the address with Change, resend after 30 s; typing, pasting and backspace move along the boxes", () => {
    const view: CloudAddView = { kind: "sign-in", phase: { step: "code", intent: true, email: EMAIL, resendAt: NOW + 21_000, problem: null, triesLeft: null } };
    const { html, tree, handlers } = panel(view, { code: "4820" });
    inOrder(text(html), [`Enter the 8-digit code sent to ${EMAIL} · Change`, "Resend code in 0:21"]);
    const boxes = tree.filter(node => node.type === "input");
    expect(boxes.map(box => box.props["aria-label"])).toEqual(Array.from({ length: 8 }, (_, i) => `Digit ${i + 1} of 8`));
    expect(boxes.map(box => box.props.value)).toEqual(["4", "8", "2", "0", "", "", "", ""]);
    expect([boxes[0]!.props.autoComplete, boxes[0]!.props.inputMode]).toEqual(["one-time-code", "numeric"]);
    expect(boxes.findIndex(box => box.props["data-autofocus"]), "the next empty box takes focus").toBe(4);
    const focus = vi.fn(), parent = { querySelectorAll: () => Array.from({ length: 8 }, () => ({ focus })) };
    boxes[4]!.props.onChange({ target: { value: "1" }, currentTarget: { parentElement: parent } });
    expect(handlers.code).toHaveBeenLastCalledWith("48201"); expect(focus).toHaveBeenCalledOnce();
    boxes[0]!.props.onPaste({ clipboardData: { getData: () => " 4820-1937 " }, preventDefault() {}, currentTarget: { parentElement: parent } });
    expect(handlers.code).toHaveBeenLastCalledWith("48201937");
    const prevent = vi.fn();
    boxes[4]!.props.onKeyDown({ key: "Backspace", preventDefault: prevent, currentTarget: { parentElement: parent } });
    expect(handlers.code).toHaveBeenLastCalledWith("482"); expect(prevent).toHaveBeenCalledOnce();
    button(tree, "Change")!.props.onClick(); expect(handlers.changeEmail).toHaveBeenCalledOnce();
    const later = panel(view, { now: NOW + 21_000 });
    button(later.tree, "Didn't get it? Resend code")!.props.onClick(); expect(later.handlers.resend).toHaveBeenCalledOnce();
    expect(text(panel(view, { busy: true }).html)).toContain("Checking the code…");
  });

  it("Sign in, code: with new accounts closed it says a code comes only to an email that already has one", () => {
    const phase = { step: "code" as const, intent: true, email: EMAIL, resendAt: NOW + 21_000, problem: null, triesLeft: null };
    expect(text(panel({ kind: "sign-in", phase: { ...phase, signupOpen: false } }).html)).toContain("New Dusk accounts aren't open yet: a code comes only if this email already has one.");
    expect(text(panel({ kind: "sign-in", phase }).html)).not.toContain("aren't open yet");
  });

  it("Sign in: the Admin's answers in plain words, with the one way on", () => {
    const code = (problem: any, triesLeft: number | null = null): CloudAddView => ({ kind: "sign-in", phase: { step: "code", intent: true, email: EMAIL, resendAt: NOW - 1, problem, triesLeft } });
    expect(text(panel(code("wrong-code", 3)).html)).toContain("That code isn't right. 3 tries left.");
    expect(text(panel(code("wrong-code", 1)).html)).toContain("That code isn't right. 1 try left.");
    const expired = panel(code("expired"));
    expect(text(expired.html)).toContain("That code can't be used any more. Send a new one.");
    button(expired.tree, "Send a new code")!.props.onClick(); expect(expired.handlers.resend).toHaveBeenCalledOnce();
    for (const [problem, line] of [["signup-closed", "New cloud accounts aren't available yet."], ["device-limit", "Sign one out on your plan page"],
      ["rate-limited", "Too many codes were asked for just now."], ["failed", "Couldn't reach dusk cloud."]] as const) expect(text(panel(code(problem)).html)).toContain(line);
    const sso = panel({ kind: "sign-in", phase: { step: "email", intent: true, problem: "sso" } });
    expect(text(sso.html)).toContain("Your organization uses single sign-on. Continue in browser");
    expect(text(sso.html)).not.toContain("Work account with single sign-on?");
    expect(sso.tree.find(node => node.type === "button" && label(node) === "Continue in browser")!.props.className).toContain("ui-button-primary");
    expect(text(panel(code("two-factor")).html)).toContain("This account uses two-step verification, so it signs in through your browser. Continue in browser");
    expect(text(panel({ kind: "sign-in", phase: { step: "email", intent: true, problem: "invalid-email" } }).html)).toContain("Enter an email address like name@example.com.");
    expect(text(panel({ kind: "sign-in", phase: { step: "done", intent: true } }).html)).toContain("Signed in. Opening secure checkout…");
  });

  it("the browser approval (single sign-on): the code to check, Reopen browser and Cancel", () => {
    const { html, tree, handlers } = panel({ kind: "signing-in", code: "ABCDE-FGHJK", checkout: true });
    expect(text(html)).toContain("Finish in your browser Sign in with your email. Check that your browser shows this code: ABCDE-FGHJK Connect this app, then start your free trial.");
    button(tree, "Reopen browser")!.props.onClick(); expect(handlers.reopenBrowser).toHaveBeenCalledOnce();
    button(tree, "Cancel")!.props.onClick(); expect(handlers.cancelSignIn).toHaveBeenCalledOnce();
  });

  it("Pay: the checklist (Signed in, waiting for the payment, setup next), Reopen checkout, Copy link and Change plan; late after 30 minutes", () => {
    const waiting: CloudAddView = { kind: "waiting", plan: "pro", browser: "checkout", late: false, link: true, email: EMAIL };
    const { html, tree, handlers } = panel(waiting);
    inOrder(text(html), ["Finish in your browser", "Checkout opened in your browser. Pay there and this window moves on by itself.",
      "Signed in", EMAIL, "Waiting for your payment", "Pro · free for 7 days · $0.00 today", "Set up your new cloud", "About 2 minutes, all automatic",
      "Reopen checkout", "Copy link", "Change plan"]);
    expect(html).toContain('aria-current="step"');
    button(tree, "Reopen checkout")!.props.onClick(); expect(handlers.reopenCheckout).toHaveBeenCalledOnce();
    button(tree, "Copy link")!.props.onClick(); expect(handlers.copyLink).toHaveBeenCalledOnce();
    button(tree, "Change plan")!.props.onClick(); expect(handlers.changePlan).toHaveBeenCalledOnce();
    expect(text(panel(waiting, { copied: true }).html)).toContain("Link copied");
    expect(text(panel(waiting, { payFailed: true }).html)).toContain("Checkout couldn't open again. Nothing was charged.");
    expect(text(panel({ ...waiting, link: false }).html)).not.toContain("Copy link");
    expect(text(panel({ ...waiting, plan: "max" }, { offerShown: PLAIN }).html)).toContain("Max · $99/month + tax where applicable");
    const late = text(panel({ ...waiting, late: true }).html);
    inOrder(late, ["We haven't seen a payment yet.", "If you paid, it shows up here within a few minutes.", "Reopen checkout", "Change plan"]);
    expect(text(panel({ ...waiting, browser: "signin", link: false }).html)).toContain("Your browser shows the next step.");
  });

  it("Setting up: the badge (trial or paid), the Admin's steps, a name, a colour and the switcher preview; Open waits for ready", () => {
    const starting: CloudAddView = { kind: "starting", tier: "pro", trial: trial(), step: "storage", slow: false, received: false };
    const { html, tree, handlers } = panel(starting);
    inOrder(text(html), ["Pro trial started", "Setting up your new cloud", "About 2 minutes. Keep working if you like, it opens when it's ready.",
      "Reserving your machine", "Preparing storage", "Starting Studio", "Checking it's ready", "Name it", "Pick a colour", "In your switcher", "Studio", "Pro · always available", "Open Studio"]);
    expect(html).toContain('aria-valuenow="25"');
    expect(button(tree, "Open Studio")!.props.disabled).toBe(true);
    const name = tree.find(node => node.props.id === "cloud-add-name")!;
    expect([name.props.value, name.props.maxLength, name.props.placeholder]).toEqual(["Studio", 28, "My cloud"]);
    name.props.onChange({ target: { value: "Work" } }); expect(handlers.name).toHaveBeenCalledWith("Work");
    const swatches = tree.filter(node => node.props.role === "radio" && node.props["data-color"]);
    expect(swatches.map(node => [node.props["data-color"], node.props["aria-label"], node.props["aria-checked"]])).toEqual([
      ["blue", "Blue", false], ["teal", "Teal", true], ["purple", "Purple", false], ["orange", "Orange", false], ["red", "Red", false], ["yellow", "Yellow", false]]);
    swatches[4]!.props.onClick(); expect(handlers.color).toHaveBeenCalledWith("red");
    expect(swatches[0]!.props.style.background).toBe("var(--identity-blue)");
    expect(text(panel({ ...starting, trial: null }).html)).toContain("Pro started");
    const received = text(panel({ ...starting, trial: null, received: true, step: null }).html);
    inOrder(received, ["Payment received", "Setting up your new cloud", "We're linking your payment to this account"]);
    expect(text(panel({ ...starting, slow: true }).html)).toContain("This is taking longer than usual.");
  });

  it("Ready: it opens by itself in 3 seconds unless Not now; otherwise Open {name}", () => {
    const view: CloudAddView = { kind: "ready", tier: "pro", trial: trial() };
    const { html, tree, handlers } = panel(view, { counting: 3 });
    inOrder(text(html), ["Studio is ready", "It keeps your bots running, even when this computer is off.", "Opening in 3…", "Not now", "Open Studio"]);
    expect(html).toContain('aria-valuenow="100"');
    button(tree, "Not now")!.props.onClick(); expect(handlers.notNow).toHaveBeenCalledOnce();
    button(tree, "Open Studio")!.props.onClick(); expect(handlers.openCloud).toHaveBeenCalledOnce();
    const still = text(panel(view).html);
    expect(still).toContain("Switch between this computer and Studio from the left edge of the window."); expect(still).not.toContain("Opening in");
    expect(text(panel(view, { openFailed: true }).html)).toContain("Studio didn't open. Try again in a minute.");
  });

  it("Add a Cloud… with a Cloud: one Cloud per account for now, Email me and Open {name}, never an error", () => {
    const { html, tree, handlers } = panel({ kind: "has-cloud" });
    inOrder(text(html), ["One cloud per account for now", "You have Studio. More than one cloud per account is coming.", "Email me when I can add another", "Open Studio"]);
    button(tree, "Email me when I can add another")!.props.onClick(); expect(handlers.interest).toHaveBeenCalledOnce();
    button(tree, "Open Studio")!.props.onClick(); expect(handlers.openCloud).toHaveBeenCalledOnce();
    const sent = text(panel({ kind: "has-cloud" }, { interest: "sent" }).html);
    expect(sent).toContain("Thanks. We'll email you when you can add another cloud."); expect(sent).not.toContain("Email me");
    expect(text(panel({ kind: "has-cloud" }, { interest: "failed" }).html)).toContain("Couldn't reach dusk cloud, so nothing was saved.");
    for (const word of ["error", "Error", "Already have"]) expect(text(html)).not.toContain(word);
  });

  it("a Team plan's Cloud: the team's own setup steps, then ready to open under the team's name, with no name or colour to choose", () => {
    const starting = text(panel({ kind: "team-starting", team: "Acme", step: "storage", slow: false }).html);
    inOrder(starting, ["Setting up your team's cloud", "About 2 minutes.", "Reserving your machine", "Preparing storage", "Starting Acme", "Checking it's ready"]);
    expect(panel({ kind: "team-starting", team: "Acme", step: "storage", slow: false }).html).toContain('aria-valuenow="25"');
    for (const word of ["Name it", "Pick a colour", "Open Acme", "My Cloud"]) expect(starting).not.toContain(word);
    const unnamed = text(panel({ kind: "team-starting", team: null, step: null, slow: true }).html);
    inOrder(unnamed, ["Reserving your machine", "Starting your team's cloud", "This is taking longer than usual."]);
    const { html, tree, handlers } = panel({ kind: "team-ready", team: { id: "team-acme", name: "Acme" } });
    inOrder(text(html), ["Your team's cloud is ready", "Acme keeps your team's bots running, even when this computer is off.",
      "Switch between this computer and Acme from the left edge of the window.", "Open Acme"]);
    button(tree, "Open Acme")!.props.onClick();
    expect(handlers.openTeam).toHaveBeenCalledExactlyOnceWith("team-acme"); expect(handlers.openCloud).not.toHaveBeenCalled();
    expect(text(panel({ kind: "team-ready", team: { id: "team-acme", name: "Acme" } }, { openFailed: true }).html)).toContain("Acme didn't open. Try again in a minute.");
  });

  it("the sheet's frame: one width per screen, Close, and a Staging mark only on the staging Admin", () => {
    const sheet = (kind: CloudAddView["kind"], staging = false) => renderToStaticMarkup(createElement(CloudAddSheet, { kind, staging, onClose: vi.fn(), children: "x" }));
    expect(sheet("offer")).toContain("max-w-[800px]"); expect(sheet("starting")).toContain("max-w-[720px]"); expect(sheet("waiting")).toContain("max-w-[540px]");
    expect(sheet("offer")).toContain('aria-label="Close"');
    expect(sheet("offer"), "above Settings, the welcome flow (z-50) and the full-screen places picker (z-60), which it opens over").toContain("fixed inset-0 z-[61]");
    expect(sheet("offer")).not.toContain("data-cloud-staging");
    expect(text(sheet("offer", true))).toMatch(/Staging ?: This app uses the staging dusk cloud: test payments and test clouds, not real ones\./);
  });

  it("a click beside the sheet closes it while choosing, never mid sign-in, checkout or setup", () => {
    const outside = (kind: CloudAddView["kind"]) => {
      const onClose = vi.fn(), backdrop = CloudAddSheet({ kind, staging: false, onClose, children: "x" });
      const event = { target: "backdrop", currentTarget: "backdrop" };
      (backdrop.props as { onMouseDown: (event: unknown) => void }).onMouseDown(event);
      (backdrop.props as { onMouseDown: (event: unknown) => void }).onMouseDown({ target: "sheet", currentTarget: "backdrop" });
      return onClose.mock.calls.length;
    };
    for (const kind of ["offer", "has-cloud", "ready", "team-ready", "error", "unreachable", "checking"] as const) expect(outside(kind), kind).toBe(1);
    for (const kind of ["sign-in", "signing-in", "waiting", "starting", "team-starting"] as const) expect(outside(kind), kind).toBe(0);
  });
});

describe("the sheet", () => {
  let account: CloudAccountState;
  let offer: CloudOffer | null;
  let bridge: Record<string, ReturnType<typeof vi.fn>>;
  let focused = true, push: (state: CloudAccountState) => void = () => {};
  const opener = { focus: vi.fn(), isConnected: true };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const runEffects = () => f.effects.forEach(({ effect, deps }, i) => {
    const before = f.ran[i];
    if (before && deps && before.deps && deps.length === before.deps.length && deps.every((dep, k) => Object.is(dep, before.deps![k]))) return;
    before?.cleanup?.();
    const cleanup = effect();
    f.ran[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  });
  const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(CloudAddDialog, { now: () => NOW })); };
  async function settle() { for (let i = 0; i < 5; i++) { render(); runEffects(); await flush(); } return text(render()); }
  const tree = () => { f.index = 0; f.effects = []; return nodes(CloudAddDialog({ now: () => NOW })); };
  const press = async (name: string) => { button(tree(), name)!.props.onClick(); await flush(); return settle(); };
  const buy = async (tier: string) => {
    tree().find(node => node.props["data-plan-pick"] === tier)!.props.onChange();
    tree().find(node => node.props["data-plan-buy"] === tier)!.props.onClick(); await flush(); return settle();
  };
  beforeEach(() => {
    f.values = []; f.index = 0; f.effects = []; f.ran = []; f.dispatch = vi.fn(); f.state = { cloudAdd: { source: "app_menu" }, config: { profile: { email: EMAIL } } };
    account = { status: "signed-out" }; offer = TRIAL; focused = true; opener.focus.mockClear();
    bridge = { state: vi.fn(async () => account), onState: vi.fn((callback: (state: CloudAccountState) => void) => { push = callback; return () => {}; }), offer: vi.fn(async () => offer),
      checkout: vi.fn(async (plan: string): Promise<CloudCheckoutResult> => ({ outcome: "opened", state: { ...free, checkout: { plan, startedAt: NOW, link: true } } })),
      begin: vi.fn(async () => ({ status: "connecting" })), reopen: vi.fn(async () => account), cancel: vi.fn(async () => ({ status: "signed-out" })),
      signInStart: vi.fn(async (email: string) => ({ outcome: "sent", email: email.trim().toLowerCase(), expiresAt: NOW + 600_000, resendAt: NOW + 30_000 })),
      signInVerify: vi.fn(async () => ({ outcome: "signed-in", state: { ...free, offer: TRIAL } })), signInCancel: vi.fn(async () => {}),
      reopenCheckout: vi.fn(async () => ({ outcome: "opened", state: account })), copyCheckoutLink: vi.fn(async () => true), interest: vi.fn(async () => {}),
      look: vi.fn(async () => ({ name: "My Cloud", color: "blue" })), setLook: vi.fn(async (name: string, color: string) => ({ name, color })), sheet: vi.fn(async () => {}),
      readySeen: vi.fn(async () => {}),
      connectHome: vi.fn(async () => account), openTeam: vi.fn(async () => {}) };
    vi.stubGlobal("window", { duskDesktop: { cloudAccount: bridge }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { querySelector: () => null, activeElement: opener, body: {}, hasFocus: () => focused });
  });

  it("signed out, Start free trial signs in inside the sheet: the code, then straight to checkout, with no browser until payment", async () => {
    expect(await settle()).toContain("Keep your bots working when this computer is off");
    expect(track).toHaveBeenCalledWith("cloud_dialog_shown", { source: "app_menu", view: "offer" });
    expect(bridge.sheet).toHaveBeenCalledWith(true);
    expect(await buy("max")).toContain("Create your Dusk account");
    expect(bridge.checkout).not.toHaveBeenCalled(); expect(bridge.begin).not.toHaveBeenCalled();
    expect(tree().find(node => node.props.id === "cloud-add-email")!.props.value, "the profile's email").toBe(EMAIL);
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush();
    expect(bridge.signInStart).toHaveBeenCalledExactlyOnceWith(EMAIL);
    expect(await settle()).toContain(`Enter the 8-digit code sent to ${EMAIL}`);
    const parent = { querySelectorAll: () => [] };
    tree().filter(node => node.type === "input")[0]!.props.onChange({ target: { value: "48201937" }, currentTarget: { parentElement: parent } });
    await flush(); await flush();
    expect(bridge.signInVerify).toHaveBeenCalledExactlyOnceWith("48201937");
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("max", "app_menu");
    account = { ...free, checkout: { plan: "max", startedAt: NOW, link: true } };
    expect(await settle()).toContain("Waiting for your payment");
    expect(track).toHaveBeenCalledWith("cloud_signin", { step: "signed_in", source: "app_menu" });
    expect(track).toHaveBeenCalledWith("cloud_checkout_opened", { plan: "max", trial: true, source: "app_menu" });
  });

  it("someone with a Cloud buys another in the same sheet, which sends where they started with its checkout", async () => {
    f.state = { ...f.state, cloudAdd: { source: "app_whats_new_team" } };
    account = { ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 86_400_000, version: 2 },
      machine: { status: "ready", origin: "https://dusk-c1.fly.dev" } as CloudAccountState["machine"],
      clouds: [{ id: "c1", name: "My Cloud", color: null, role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: "https://dusk-c1.fly.dev", teamId: null, primary: true, managed: true }] };
    vi.stubGlobal("window", { duskDesktop: { cloudAccount: bridge, cloudAdd: { state: vi.fn(), start: vi.fn() } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await settle();
    expect(render()).toContain('data-add-cloud-flow="app_whats_new_team"');
  });

  it("the Admin's word that new accounts are closed reaches the code step", async () => {
    bridge.signInStart.mockResolvedValueOnce({ outcome: "sent", email: EMAIL, expiresAt: NOW + 600_000, resendAt: NOW + 30_000, signupOpen: false });
    await settle(); await buy("pro");
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush();
    expect(await settle()).toContain("New Dusk accounts aren't open yet");
  });

  it("signed in to an account whose own terms differ (a trial already used): back to Choose with its terms, never a checkout said to be $0.00", async () => {
    await settle(); await buy("pro");
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush(); await settle();
    const own = { ...PLAIN, recommended: "pro" };
    bridge.signInVerify.mockResolvedValueOnce({ outcome: "signed-in", state: { ...free, offer: own } });
    offer = own;
    tree().filter(node => node.type === "input")[0]!.props.onChange({ target: { value: "48201937" }, currentTarget: { parentElement: { querySelectorAll: () => [] } } });
    await flush(); await flush();
    expect(bridge.checkout).not.toHaveBeenCalled();
    push({ ...free, offer: own });
    const html = await settle();
    expect(html).toContain("You're signed in. These are the plans for your account");
    expect(html).toContain("Monthly, plus tax where applicable."); expect(html).not.toContain("days free");
    await press("Get Pro");
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu");
  });

  it("a wrong code says the tries left and empties the boxes; single sign-on continues in the browser with the plan", async () => {
    await settle(); await buy("pro");
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush(); await settle();
    bridge.signInVerify.mockResolvedValueOnce({ outcome: "wrong-code", triesLeft: 4 });
    tree().filter(node => node.type === "input")[0]!.props.onPaste({ clipboardData: { getData: () => "11111111" }, preventDefault() {}, currentTarget: { parentElement: { querySelectorAll: () => [] } } });
    await flush(); await flush();
    expect(await settle()).toContain("That code isn't right. 4 tries left.");
    expect(tree().filter(node => node.type === "input").map(box => box.props.value).join("")).toBe("");
    expect(bridge.checkout).not.toHaveBeenCalled();
    bridge.signInStart.mockResolvedValueOnce({ outcome: "sso" });
    await press("Change");
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush();
    expect(await settle()).toContain("Your organization uses single sign-on.");
    await press("Continue in browser");
    expect(bridge.signInCancel).toHaveBeenCalled();
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu");
  });

  it("Signed in, a card's button is the checkout of that plan; Reopen uses main's kept page and Copy link copies it there", async () => {
    account = free;
    await settle();
    await buy("pro");
    expect(bridge.checkout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu");
    expect(bridge.signInStart).not.toHaveBeenCalled();
    account = { ...free, checkout: { plan: "pro", startedAt: NOW, link: true } };
    expect(await settle()).toContain("Finish in your browser");
    await press("Reopen checkout");
    expect(bridge.reopenCheckout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu"); expect(bridge.checkout).toHaveBeenCalledOnce();
    expect(await press("Copy link")).toContain("Link copied");
    expect(bridge.copyCheckoutLink).toHaveBeenCalledOnce();
    expect(await press("Change plan")).toContain("Keep your bots working when this computer is off");
    await buy("starter");
    expect(bridge.checkout).toHaveBeenLastCalledWith("starter", "app_menu");
  });

  it("the countdown stops when the window loses focus: nothing switches while the person is elsewhere", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", { duskDesktop: { cloudAccount: bridge }, addEventListener: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)) });
    account = paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true } });
    expect(await settle()).toContain("Opening in 3…");
    listeners.get("blur")!();
    const away = await settle();
    expect(away).not.toContain("Opening in"); expect(away).toContain("Open My Cloud");
    vi.advanceTimersByTime(5000); await settle();
    expect(bridge.connectHome).not.toHaveBeenCalled();
    expect(listeners.has("blur"), "not listening once it stopped").toBe(false);
  });

  it("ready shown ends the purchase for main; a later Add a Cloud… (bought, opened or told) is one Cloud for now, with no countdown", async () => {
    vi.useFakeTimers();
    account = paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true } });
    expect(await settle()).toContain("Opening in 3…");
    expect(bridge.readySeen).toHaveBeenCalledOnce();
    await press("Not now");
    f.values = []; f.ran = []; bridge.readySeen.mockClear();
    account = paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true, done: true } });
    const again = await settle();
    expect(again).toContain("One cloud per account for now"); expect(again).not.toContain("Opening in");
    vi.advanceTimersByTime(5000); await settle();
    expect(bridge.connectHome).not.toHaveBeenCalled();
  });

  it("ready while open in the focused window: opening in 3…, then the Cloud opens; Not now stops it; unfocused, Open {name}", async () => {
    vi.useFakeTimers();
    account = paid({ trial: trial(), machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true } });
    expect(await settle()).toContain("Opening in 3…");
    expect(bridge.look).toHaveBeenCalled();
    expect(await settle()).toContain("Open My Cloud");
    vi.advanceTimersByTime(1000); expect(await settle()).toContain("Opening in 2…");
    vi.advanceTimersByTime(1000); await settle(); vi.advanceTimersByTime(1000); await settle();
    expect(bridge.connectHome).toHaveBeenCalledOnce();
    f.values = []; f.ran = []; bridge.connectHome.mockClear();
    await settle();
    expect(await press("Not now")).not.toContain("Opening in");
    vi.advanceTimersByTime(5000); await settle();
    expect(bridge.connectHome).not.toHaveBeenCalled();
    f.values = []; f.ran = []; focused = false;
    const away = await settle();
    expect(away).not.toContain("Opening in"); expect(away).toContain("Switch between this computer and My Cloud");
    vi.advanceTimersByTime(5000); await settle();
    expect(bridge.connectHome).not.toHaveBeenCalled();
  });

  it("a checkout left open (found after a restart, or older than half an hour) never takes over: the plans, with Finish your checkout", async () => {
    account = { ...free, checkout: { plan: "pro", startedAt: NOW, found: true } }; offer = { ...TRIAL, checkout: { plan: "pro", openUntil: NOW + 20 * 60_000 } };
    let html = await settle();
    expect(html).toContain("Keep your bots working when this computer is off"); expect(html).not.toContain("Waiting for your payment"); expect(html).toContain("Finish your Pro checkout");
    push({ ...free, checkout: { plan: "max", startedAt: NOW - 3 * 3600_000, link: true } });
    html = await settle();
    expect(html).toContain("Keep your bots working when this computer is off"); expect(html).toContain("Finish your Max checkout");
    html = await buy("starter");
    expect(bridge.checkout, "a plan picked here opens its own checkout").toHaveBeenCalledExactlyOnceWith("starter", "app_menu");
    expect(html).toContain("Waiting for your payment");
  });

  it("after a restart mid-checkout: Finish your checkout, then setup, then ready is theirs to open, not one Cloud for now", async () => {
    focused = false;
    account = free; offer = { ...TRIAL, checkout: { plan: "pro", openUntil: NOW + 3600_000 } };
    expect(await settle()).toContain("Finish your Pro checkout");
    expect(await press("Finish your Pro checkout")).toContain("Waiting for your payment");
    expect(bridge.reopenCheckout).toHaveBeenCalledExactlyOnceWith("pro", "app_menu");
    push(paid({ trial: trial(), machine: { status: "provisioning", setup: { step: "storage" } } }));
    expect(await settle()).toContain("Setting up your new cloud");
    push(paid({ trial: trial(), machine: ready }));
    const html = await settle();
    expect(html).toContain("My Cloud is ready"); expect(html).not.toContain("One cloud per account");
  });

  it("over the welcome flow a ready Cloud never switches the window: no countdown, main hears no sheet in front, Open {name} stays", async () => {
    vi.useFakeTimers();
    const hide = showWelcome();
    try {
      f.state = { cloudAdd: { source: "app_onboarding" }, config: {} };
      account = paid({ trial: trial(), machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000, link: true } });
      const html = await settle();
      expect(html).toContain("My Cloud is ready"); expect(html).toContain("Open My Cloud"); expect(html).not.toContain("Opening in");
      vi.advanceTimersByTime(10_000); await settle();
      expect(bridge.connectHome).not.toHaveBeenCalled();
      expect(bridge.sheet, "main notifies instead, as for a closed sheet").not.toHaveBeenCalledWith(true);
      await press("Open My Cloud");
      expect(bridge.connectHome, "only when the person asks").toHaveBeenCalledOnce();
    } finally { hide(); }
  });

  it("the name and colour go to main as they are chosen (after a pause), and the last ones before the Cloud opens", async () => {
    vi.useFakeTimers();
    account = paid({ machine: { status: "provisioning", setup: { step: "starting" } } });
    expect(await settle()).toContain("Setting up your new cloud");
    vi.advanceTimersByTime(400); await flush();
    expect(bridge.setLook).toHaveBeenCalledExactlyOnceWith("My Cloud", "blue");
    bridge.setLook.mockClear();
    tree().find(node => node.props.id === "cloud-add-name")!.props.onChange({ target: { value: "Studio" } });
    tree().find(node => node.props["data-color"] === "purple")!.props.onClick();
    expect(await settle()).toContain("Starting Studio");
    expect(bridge.setLook).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400); await flush();
    expect(bridge.setLook).toHaveBeenCalledWith("Studio", "purple");
    tree().find(node => node.props.id === "cloud-add-name")!.props.onChange({ target: { value: "   " } });
    expect(await settle()).toContain("Starting My cloud");
    account = paid({ machine: ready, checkout: { plan: "pro", startedAt: NOW - 120_000 } }); focused = false;
    await settle();
    tree().find(node => node.props.id === "cloud-add-name")!.props.onChange({ target: { value: "Lab" } }); await settle();
    await press("Open Lab");
    expect(bridge.setLook).toHaveBeenLastCalledWith("Lab", "purple");
    expect(bridge.connectHome).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "closeCloudAdd" });
  });

  it("Add a Cloud… with a Cloud: one Cloud for now, Email me and Open; during setup, the setup", async () => {
    vi.useFakeTimers();
    account = paid({ machine: ready });
    bridge.look.mockResolvedValue({ name: "Studio", color: "teal" });
    expect(await settle()).toContain("One cloud per account for now");
    expect(await settle()).toContain("You have Studio.");
    vi.advanceTimersByTime(1000); await flush();
    expect(bridge.setLook, "an existing Cloud is never recoloured by opening the sheet").not.toHaveBeenCalled();
    expect(await press("Email me when I can add another")).toContain("Thanks. We'll email you");
    expect(bridge.interest).toHaveBeenCalledOnce();
    await press("Open Studio"); expect(bridge.connectHome).toHaveBeenCalledOnce();
    f.values = []; f.ran = [];
    account = paid({ machine: { status: "provisioning" } });
    expect(await settle()).toContain("Setting up your new cloud");
  });

  it("closing gives focus back to what opened it, and tells main the sheet is closed", async () => {
    await settle();
    await press("Close");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "closeCloudAdd" });
    f.state = { cloudAdd: null };
    expect(await settle()).toBe("");
    expect(opener.focus).toHaveBeenCalledOnce();
    expect(bridge.sheet).toHaveBeenLastCalledWith(false);
  });

  it("opened at Sign in (the card, Settings): the sign-in first, without a plan; signed in, a ready Cloud is theirs to open", async () => {
    f.state = { cloudAdd: { source: "app_settings", signIn: true }, config: {} };
    expect(await settle()).toContain("Sign in to dusk cloud");
    bridge.signInVerify.mockResolvedValueOnce({ outcome: "signed-in", state: paid({ machine: ready }) });
    tree().find(node => node.props.id === "cloud-add-email")!.props.onChange({ target: { value: "me@example.test" } });
    await settle();
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush(); await settle();
    tree().filter(node => node.type === "input")[0]!.props.onChange({ target: { value: "48201937" }, currentTarget: { parentElement: { querySelectorAll: () => [] } } });
    await flush(); await flush();
    account = paid({ machine: ready }); focused = false;
    expect(await settle()).toContain("My Cloud is ready");
    expect(bridge.checkout).not.toHaveBeenCalled();
  });

  it("signed in here to a Team plan: the team's Cloud is ready to open, never a My Cloud being set up; Open opens the team and closes", async () => {
    f.state = { cloudAdd: { source: "app_settings", signIn: true }, config: {} };
    expect(await settle()).toContain("Sign in to dusk cloud");
    bridge.signInVerify.mockResolvedValueOnce({ outcome: "signed-in", state: onTeam() });
    tree().find(node => node.props.id === "cloud-add-email")!.props.onChange({ target: { value: "me@example.test" } });
    await settle();
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush(); await settle();
    tree().filter(node => node.type === "input")[0]!.props.onChange({ target: { value: "48201937" }, currentTarget: { parentElement: { querySelectorAll: () => [] } } });
    await flush(); await flush();
    account = onTeam();
    const shown = await settle();
    inOrder(shown, ["Your team's cloud is ready", "Open Acme"]);
    for (const word of ["Reserving your machine", "Setting up your new cloud", "My Cloud"]) expect(shown).not.toContain(word);
    expect(bridge.readySeen, "the purchase is over for main").toHaveBeenCalled();
    await press("Open Acme");
    expect(bridge.openTeam).toHaveBeenCalledExactlyOnceWith("team-acme");
    expect(bridge.connectHome).not.toHaveBeenCalled(); expect(bridge.checkout).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "closeCloudAdd" });
  });

  it("a Team plan whose Cloud is still being set up shows the team's steps, then the team's Cloud once it is ready", async () => {
    account = onTeam({ status: "provisioning", setup: { step: "starting" } });
    inOrder(await settle(), ["Setting up your team's cloud", "Reserving your machine", "Preparing storage", "Starting Acme"]);
    push(onTeam());
    expect(await settle()).toContain("Your team's cloud is ready");
    bridge.openTeam.mockRejectedValueOnce(new Error("Acme isn't running right now."));
    expect(await press("Open Acme")).toContain("Acme didn't open. Try again in a minute.");
    expect(f.dispatch).not.toHaveBeenCalledWith({ type: "closeCloudAdd" });
  });

  it("Settings' Sign in after a saved sign-in was removed signs in here, instead of handing back to Settings at once", async () => {
    f.state = { cloudAdd: { source: "app_settings", signIn: true }, config: {} };
    account = { status: "signed-out", message: "restore-removed" }; offer = null;
    expect(await settle()).toContain("Sign in to dusk cloud");
    expect(f.dispatch).not.toHaveBeenCalledWith({ type: "closeCloudAdd" });
    tree().find(node => node.props.id === "cloud-add-email")!.props.onChange({ target: { value: EMAIL } }); await settle();
    tree().find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }); await flush();
    expect(bridge.signInStart).toHaveBeenCalledExactlyOnceWith(EMAIL);
  });

  it("a refused checkout says why and changes nothing; a conflict shows what the account is now", async () => {
    account = free;
    await settle();
    bridge.checkout.mockResolvedValueOnce({ outcome: "rate-limited", state: account });
    expect(await buy("pro")).toContain("You've opened several checkouts in the last hour.");
    expect(await press("Try again")).toContain("Try Pro free for 7 days");
    bridge.checkout.mockRejectedValueOnce(new Error("Choose a plan to continue."));
    expect(await buy("pro")).toContain("Checkout couldn't open. Nothing was charged.");
    await press("Try again");
    bridge.checkout.mockResolvedValueOnce({ outcome: "conflict", state: free });
    expect(await buy("pro")).toContain("A checkout is already being prepared. Try again in a moment.");
  });

  it("payment problems and ended sign-ins are Settings' to say: the sheet hands over and closes", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } };
    expect(await settle()).toBe("");
    expect(f.dispatch).toHaveBeenCalledWith({ type: "closeCloudAdd" });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
  });

  it("is only on This computer's page, and only while asked for", async () => {
    f.state = { cloudAdd: null }; expect(await settle()).toBe("");
    f.state = { cloudAdd: { source: "app_card" } };
    vi.stubGlobal("window", { duskDesktop: { remoteClient: { active: true }, cloudAccount: bridge } }); expect(await settle()).toBe("");
    vi.stubGlobal("window", {}); expect(await settle()).toBe("");
  });

  it("the view comes from the one state → view function", () => {
    expect(cloudAddView({ status: "signed-out" }, TRIAL, { now: NOW }).kind).toBe("offer");
  });
});
