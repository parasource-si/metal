// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { AccountGate } from "../account/AccountGate";
import { SignInOffer, SIGN_IN_OFFER_KEY } from "../account/SignInOffer";
import { PlatformContext, webPlatform, type MobilePlatform } from "../platform";
import { firstStep, Onboarding, typedCodeComplete } from "./Onboarding";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => createElement("span"), BotAvatar: () => createElement("span") }));
// steps swap without waiting on exit animations, so each choice lands on its screen at once
vi.mock("motion/react", async (original) => {
  const actual = await original<typeof import("motion/react")>();
  const strip = ({ initial: _i, animate: _a, exit: _e, transition: _t, whileTap: _w, variants: _v, layout: _l, ...rest }: Record<string, unknown>) => rest;
  const motion = new Proxy({}, { get: (_, tag: string) => (props: Record<string, unknown>) => createElement(tag, strip(props)) });
  return { ...actual, motion, AnimatePresence: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children), useReducedMotion: () => true };
});
vi.mock("../connection/pair", async (original) => ({
  ...await original<typeof import("../connection/pair")>(),
  redeemPairing: vi.fn(async (payload: { name?: string }) => ({ record: { id: "linked", label: payload.name ?? "" }, token: "session" })),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const origin = "https://dusk.bot";
const account = { id: "person", email: "person@example.com" };
const token = `omc_${"t".repeat(43)}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let host: HTMLDivElement, root: Root, platform: MobilePlatform, prefs: Map<string, string>, secrets: Map<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  setLocale("en"); window.history.replaceState({}, "", "/");
  vi.stubEnv("VITE_DUSK_ALLOW_SIGNED_OUT", ""); vi.stubEnv("VITE_DUSK_ACCOUNT_ORIGIN", "");
  host = document.createElement("div"); document.body.append(host);
  prefs = new Map(); secrets = new Map();
  platform = { ...webPlatform(), native: true, kind: "android",
    prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } },
    secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } },
    onAppUrl: () => () => {}, onResume: () => () => {}, openExternal: vi.fn(async () => {}), camera: undefined };
  fetcher = vi.fn<typeof fetch>(async () => response({ v: 1, providers: [], signupOpen: true })); vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await act(async () => root?.unmount()); host.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const mount = (child: ReactNode) => act(async () => {
  root = createRoot(host);
  root.render(createElement(PlatformContext, { value: platform }, createElement(AccountGate, null, child)));
});
const onboarding = (props: Partial<Parameters<typeof Onboarding>[0]> = {}) => createElement(Onboarding, { onLinked: vi.fn(), ...props });
const entries = () => [...host.querySelectorAll<HTMLButtonElement>("[data-entry]")];
const press = (selector: string) => act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); });
const heading = () => host.querySelector("h1")?.textContent;

it("log in opens the account sign-in straight away", async () => {
  await mount(onboarding());
  await press("[data-entry=signin]");
  expect(heading()).toBe("Log in to Metal");
  expect(host.querySelector("input[type=email]")).not.toBeNull();
});

it("enter a code opens the code field straight away, with no intro in between", async () => {
  await mount(onboarding());
  await press("[data-entry=code]");
  expect(heading()).toBe("Enter the code");
  expect(host.querySelector("input[autocomplete=one-time-code]")).not.toBeNull();
});

it("android back steps back through onboarding and leaves the app from the first screen", async () => {
  let back: (() => boolean) | undefined;
  platform = { ...platform, onBack: (listener) => { back = listener; return () => { back = undefined; }; } };
  await mount(onboarding());
  expect(back?.(), "the first screen hands back to android, which minimizes").toBe(false);
  await press("[data-entry=code]");
  expect(heading()).toBe("Enter the code");
  let handled: boolean | undefined;
  await act(async () => { handled = back?.(); });
  expect(handled).toBe(true);
  expect(entries().map((button) => button.dataset.entry)).toEqual(["scan", "signin", "code"]);
});

it("scan without a camera falls back to the code field", async () => {
  await mount(onboarding());
  await press("[data-entry=scan]");
  expect(heading()).toBe("Enter the code");
});

it("picks the first screen from what the phone already has", () => {
  expect(firstStep({ incoming: false, signedIn: false, adding: false })).toBe("welcome");
  expect(firstStep({ incoming: false, signedIn: true, adding: false })).toBe("clouds");
  expect(firstStep({ incoming: true, signedIn: true, adding: false })).toBe("confirm");
  expect(firstStep({ incoming: false, signedIn: true, adding: true })).toBe("welcome");
  // a sign-in asked for from Settings goes to it, or straight to the clouds once signed in
  expect(firstStep({ incoming: false, signedIn: false, adding: true, startAt: "signin" })).toBe("signin");
  expect(firstStep({ incoming: false, signedIn: true, adding: true, startAt: "signin" })).toBe("clouds");
  expect(firstStep({ incoming: true, signedIn: false, adding: true, startAt: "signin" })).toBe("confirm");
});

it("leads with scanning your own computer, logging in to a dusk cloud next to it, and typing a code as the quiet way", async () => {
  await mount(onboarding());
  const [scan, signIn, code] = entries();
  expect(scan?.dataset.entry).toBe("scan");
  expect(signIn?.dataset.entry).toBe("signin");
  expect(code?.dataset.entry).toBe("code");
  expect(scan?.className).toContain("bg-ink ");
  expect(signIn?.className, "a real choice, never outranking the scan").toContain("bg-ink/[0.05]");
  expect(code?.className).not.toContain("bg-ink");
  expect(entries().map((button) => button.textContent)).toEqual(["Scan a QR code", "Log in to dusk cloud", "Enter a code"]);
  expect(host.textContent).not.toContain("demo");
});

it("a typed code the relay never had says so, not expired, and offers logging in", async () => {
  // a browser's /pair code from a cloud's settings was typed here and read as "That code expired"
  fetcher.mockImplementation(async (input) => String(input).includes("/v1/lookups/") ? response({ error: "not found", code: "not_found" }, 404) : response({ v: 1, providers: [], signupOpen: true }));
  await mount(onboarding());
  await press("[data-entry=code]");
  const field = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "ABCD-EFGH-2345");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector<HTMLFormElement>("form")!.requestSubmit(); });
  for (let i = 0; i < 100 && !host.querySelector("[role=alert]"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const alert = host.querySelector("[role=alert]")?.textContent ?? "";
  expect(alert).toContain("We couldn't find that code");
  expect(alert).not.toMatch(/expired/i);
  await press("[data-failure-sign-in]");
  expect(host.querySelector("[data-step]")?.getAttribute("data-step")).toBe("signin");
});

it("a signed-in phone pairs with its only cloud by itself, never saying it is asleep", async () => {
  secrets.set("dusk.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
  const cloud = { id: "home", name: "Home cloud", role: "owner", teamId: null, managed: true, status: "ready", origin: "https://home.example.com", primary: true, power: { state: "asleep" } };
  const onLinked = vi.fn();
  let pairs = 0;
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cloud/desktop/session")) return response({ ok: true, clouds: [cloud] });
    if (url.endsWith("/api/cloud/desktop/pairing")) { pairs++; return response({ cloudContractVersion: 1, origin: cloud.origin, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 }); }
    return response({ error: "unreachable" }, 503);
  });
  await mount(onboarding({ onLinked }));
  expect(heading()).toBe("Pick a cloud");
  expect(host.textContent).not.toMatch(/asleep/i);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(pairs).toBe(1);
  expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "linked" }), "session", "Home cloud");
});

it("a signed-in account with no cloud is pointed at linking a computer", async () => {
  secrets.set("dusk.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
  fetcher.mockImplementation(async (input) => String(input).endsWith("/api/cloud/desktop/session") ? response({ ok: true, clouds: [] }) : response({}));
  await mount(onboarding());
  expect(heading()).toBe("No cloud yet");
  expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(expect.arrayContaining(["Scan a QR code", "Enter a code"]));
});

it("the store apps never offer an account to a phone paired with its own computer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.documentElement.dataset.mobileApp = "ios";
  try {
    await mount(createElement(SignInOffer));
    await act(async () => { vi.advanceTimersByTime(3000); });
    await act(async () => {});
    expect(host.querySelector("[data-sign-in-offer]")).toBeNull();
  } finally { delete document.documentElement.dataset.mobileApp; }
});

it("after a QR or code link, offers the account sign-in once, quietly, and remembers not now", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mount(createElement(SignInOffer));
  expect(host.querySelector("[data-sign-in-offer]")).toBeNull();
  await act(async () => { vi.advanceTimersByTime(3000); });
  await act(async () => {});
  expect(host.querySelector("[data-sign-in-offer]")).not.toBeNull();
  await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Not now")!.click(); });
  expect(host.querySelector("[data-sign-in-offer]")).toBeNull();
  expect(prefs.get(SIGN_IN_OFFER_KEY)).toBe("dismissed");
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => { root.render(createElement(PlatformContext, { value: platform }, createElement(AccountGate, null, createElement(SignInOffer)))); });
  await act(async () => { vi.advanceTimersByTime(3000); });
  await act(async () => {});
  expect(host.querySelector("[data-sign-in-offer]")).toBeNull();
});

it("the sign-in offer opens the sign-in without leaving the app", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mount(createElement(SignInOffer));
  await act(async () => { vi.advanceTimersByTime(3000); });
  await act(async () => {});
  await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Log in")!.click(); });
  expect(host.querySelector("[role=dialog] h1")?.textContent).toBe("Log in to Metal");
});

it("a scan of the desktop's App Store qr says so, and the screen after a failed scan offers scanning again", async () => {
  platform = { ...platform, camera: {
    permission: async () => "granted", request: async () => "granted",
    start: async ({ onCode }: { onCode: (text: string) => void }) => { setTimeout(() => onCode("https://apps.apple.com/app/id6834725640"), 0); return { stop: async () => {} }; },
  } as unknown as MobilePlatform["camera"] };
  await mount(onboarding());
  await press("[data-entry=scan]");
  for (let i = 0; i < 100 && !host.querySelector("[role=alert]"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.querySelector("[data-step]")?.getAttribute("data-step")).toBe("code");
  expect(host.querySelector("[role=alert]")?.textContent).toContain("That's the App Store code");
  const again = host.querySelector<HTMLButtonElement>("[data-scan-again]");
  expect(again?.disabled, "never a disabled Try again over an empty field").toBe(false);
  expect(host.querySelector("button[type=submit]")).toBeNull();
});

describe("a dusk cloud's code from the desktop", () => {
  const phoneGrant = { cloudContractVersion: 1, accessToken: token, expiresAt: Date.now() + 86_400_000, device: { id: "phone" }, account };
  const route = (phone: () => Response) => fetcher.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cloud/app/sign-in/phone")) return phone();
    if (url.endsWith("/api/cloud/desktop/session")) return response({ ...phoneGrant, clouds: [] });
    return response({ v: 1, providers: [], signupOpen: true });
  });
  const type = (text: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = () => press("button[type=submit]");
  const phoneCalls = () => fetcher.mock.calls.filter(([input]) => String(input).endsWith("/api/cloud/app/sign-in/phone"));

  it("typing its 8 letters logs the phone in with no email step and goes on to the clouds", async () => {
    route(() => response(phoneGrant));
    await mount(onboarding());
    await press("[data-entry=code]");
    await type("abcdefgh");
    expect(host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")!.value).toBe("ABCD-EFGH");
    expect(host.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(false);
    await submit();
    expect(phoneCalls()).toHaveLength(1);
    expect(JSON.parse(String(phoneCalls()[0]![1]?.body))).toMatchObject({ code: "ABCDEFGH" });
    expect(host.querySelector("input[type=email]"), "never the email sign-in").toBeNull();
    expect(heading()).not.toBe("Enter the code");
    expect(secrets.has("dusk.account")).toBe(true);
  });

  it.each([
    [410, "expired", "That code expired"], [409, "used", "That code was already used"], [400, "invalid_code", "We couldn't find that code"],
  ])("says what went wrong, next to the code (%s %s)", async (status, error, words) => {
    route(() => response({ error }, status));
    await mount(onboarding());
    await press("[data-entry=code]");
    await type("ABCDEFGH");
    await submit();
    expect(heading()).toBe("Enter the code");
    expect(host.textContent).toContain(words);
    expect(secrets.has("dusk.account")).toBe(false);
  });

  it("the qr's link carries the code: it is redeemed at once", async () => {
    route(() => response(phoneGrant));
    await mount(onboarding({ signInCode: "ABCDEFGH", email: "person@example.com", startAt: "signin" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(phoneCalls()).toHaveLength(1);
    expect(secrets.has("dusk.account")).toBe(true);
    expect(host.querySelector("input[type=email]")).toBeNull();
  });

  it("a computer's code still needs all 12", () => {
    expect(typedCodeComplete("ABCD-EFGH")).toBe(true);
    expect(typedCodeComplete("ABCD-EFG2")).toBe(false);
    expect(typedCodeComplete("ABCD-EFGH-JK")).toBe(false);
    expect(typedCodeComplete("ABCD-EFGH-JK23")).toBe(true);
  });
});
