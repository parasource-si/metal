// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ api, ApiError: class ApiError extends Error { status = 0; } }));
vi.mock("@/lib/user-presence", () => ({ requireUserPresence: vi.fn(async () => true) }));
vi.mock("@/lib/companion-bridge", () => ({ companionBridge: () => null }));
vi.mock("../lib/session", async (original) => ({ ...await original<typeof import("../lib/session")>(), readSessionState: async () => ({ kind: "loopback" }) }));
vi.mock("motion/react", async (original) => {
  const actual = await original<typeof import("motion/react")>();
  const strip = ({ initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown>) => rest;
  const motion = new Proxy({}, { get: (_, tag: string) => (props: Record<string, unknown>) => createElement(tag, strip(props)) });
  return { ...actual, motion, AnimatePresence: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children), useReducedMotion: () => true };
});

import { AUTO_RENEWALS, MINT_RETRY_MS, MobilePairingCard, RENEW_BEFORE_MS } from "./MobilePairingCard";
import { ServerPairingCard } from "./ServerPairingCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, minted: number;

beforeEach(() => {
  setLocale("en");
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), clear: () => saved.clear() });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  host = document.createElement("div"); document.body.append(host);
  minted = 0;
  api.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/mobile/devices") return { devices: [], current: null };
    if (path === "/api/auth/sessions") return { sessions: [], current: null };
    if (path === "/api/config") return { computerName: "Studio" };
    if (path === "/api/mobile/pairing") {
      minted += 1;
      return { payload: {}, link: `duskbot://pair?m=offer${minted}`, code: `ABCD-EFGH-000${minted}`, expiresAt: Date.now() + 10 * 60_000 };
    }
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(async () => { await act(async () => root?.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

const click = (selector: string) => act(async () => { host.querySelector<HTMLElement>(selector)!.click(); });
/** mounts the card; most tests then pick the iPhone on the picker it always opens on */
const mount = async (props: Parameters<typeof MobilePairingCard>[0], pickIphone = true) => {
  await act(async () => { root = createRoot(host); root.render(createElement(MobilePairingCard, props)); });
  await flush();
  if (pickIphone && host.querySelector("[data-phone-flow=platform]")) {
    await click("[data-phone-platform=ios]");
    await flush();
  }
};
const qrs = () => host.querySelectorAll("[aria-label*=\"QR code\"]").length;

it("opens Android's link page with the APK download beside the same qr", async () => {
  await mount({ remote: false }, false);
  const android = host.querySelector<HTMLButtonElement>("[data-phone-platform=android]")!;
  expect(android.getAttribute("aria-disabled")).toBeNull();
  expect(android.textContent).not.toContain("Coming soon");
  expect(android.textContent).not.toContain("Google Play");
  expect(minted, "no code before a phone is picked").toBe(0);
  await click("[data-phone-platform=android]");
  await flush();
  expect(host.textContent).toContain("Link your Android phone");
  expect(minted).toBe(1);
  const steps = host.querySelector("[data-phone-steps=android]")!;
  expect(steps.querySelectorAll(":scope > li")).toHaveLength(2);
  expect(steps.textContent).toContain("Get the Metal app");
  const apk = steps.querySelector("[data-phone-apk]")!;
  expect(apk.getAttribute("href")).toBe("https://dusk.bot/download#android");
  expect(apk.textContent).toBe("Download");
  expect(apk.getAttribute("aria-label")).toBe("Download Metal for Android");
  expect(host.querySelector("[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe("https://dusk.bot/m/pair#m=offer1&c=ABCDEFGH0001");
});

it("always opens on the phone picker, then shows the iPhone's two numbered steps beside one qr", async () => {
  window.localStorage.setItem("dusk.settings.phoneKind", "ios");
  await mount({ remote: false }, false);
  expect(host.textContent, "never straight to a remembered phone").toContain("Which phone do you have?");
  expect(host.querySelector("[data-phone-platform=ios] [data-store-mark=apple]")).not.toBeNull();
  expect(minted, "no code before a phone is picked").toBe(0);
  await click("[data-phone-platform=ios]");
  await flush();
  expect(host.textContent).toContain("Link your iPhone");
  expect(minted).toBe(1);
  expect(qrs()).toBe(1);
  expect(host.querySelector("[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe("https://dusk.bot/m/pair#m=offer1&c=ABCDEFGH0001");
  const steps = host.querySelector("[data-phone-steps=ios]")!;
  expect(steps.querySelectorAll(":scope > li")).toHaveLength(2);
  expect(steps.textContent).toContain("Get the Metal app");
  expect(steps.textContent).toContain("Open it and scan the QR code, or type the code");
  expect(host.querySelector("[data-phone-card] [data-phone-code]"), "the code sits in the card under the qr").not.toBeNull();
  expect(host.querySelector("[data-phone-code]")?.textContent).toBe("ABCD EFGH 0001");
  const store = host.querySelector("[data-phone-app-store]")!;
  expect(store.getAttribute("href")).toBe("https://apps.apple.com/app/id6834725640");
  expect(store.textContent).toBe("App Store");
  expect(store.getAttribute("aria-label")).toBe("Get Metal on the App Store");
  expect(store.querySelector("[data-store-mark]"), "a plain Apple glyph, not the pixel art").toBeNull();
  expect(host.textContent).toContain("Waiting for your phone");
  await click("[data-pairing-back]");
  expect(host.textContent).toContain("Which phone do you have?");
  // the next visit starts at the picker again
  await act(async () => root.unmount());
  await mount({ remote: false }, false);
  expect(host.querySelector("[data-phone-flow=platform]")).not.toBeNull();
  expect(window.localStorage.getItem("dusk.settings.phoneKind"), "the pick is not written down").toBe("ios");
});

it("slides the picker and the link page past each other, the old page inert until the slide ends", async () => {
  await mount({ remote: false }, false);
  await click("[data-phone-platform=ios]");
  const layers = host.querySelectorAll(".phone-wipe-layer");
  expect(layers).toHaveLength(2);
  expect(layers[0]!.getAttribute("data-wipe")).toBe("push");
  expect(layers[1]!.hasAttribute("inert")).toBe(true);
  expect(layers[1]!.querySelector("h3")?.id, "only the live page names the section").toBeFalsy();
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(host.querySelectorAll(".phone-wipe-layer")).toHaveLength(1);
  await click("[data-pairing-back]");
  expect(host.querySelector(".phone-wipe-layer")?.getAttribute("data-wipe")).toBe("pop");
});

it("says when the phone links, then folds into the linked phones with a way to link another", async () => {
  let phones: { id: string; name: string; platform: string; lastSeenAt: number }[] = [];
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, init?: unknown) => path === "/api/mobile/devices" ? { devices: phones, current: null } : base(path, init));
  await mount({ remote: false });
  await flush();
  phones = [{ id: "p1", name: "Ada's iPhone", platform: "ios", lastSeenAt: Date.now() }];
  await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
  expect(host.querySelector("[data-phone-linked]")?.textContent).toContain("Ada's iPhone linked");
  await click("[data-phone-linked] [data-primary]");
  expect(host.querySelector("[data-phone-flow]")).toBeNull();
  expect(host.textContent).toContain("Linked phones");
  expect(host.textContent).toContain("Ada's iPhone");
  await click("[data-phone-link-another]");
  await flush();
  expect(host.querySelector("[data-phone-flow=platform]"), "linking another starts at the picker").not.toBeNull();
  await click("[data-phone-platform=ios]");
  await flush();
  expect(host.querySelector("[data-phone-flow=link]")).not.toBeNull();
  expect(minted, "linking another makes a fresh code").toBe(2);
  await click("[data-pairing-back]");
  expect(host.querySelector("[data-phone-flow=platform]")).not.toBeNull();
  await click("[data-pairing-back]");
  expect(host.querySelector("[data-phone-flow]"), "back again returns to the linked phones").toBeNull();
});

it("on a dusk cloud shows one qr that opens the app's log in with the account's email, never a pairing code the cloud refuses", async () => {
  let sessions: { id: string; label: string; scopes: string[] }[] = [{ id: "me", label: "This window", scopes: ["admin"] }];
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, init?: unknown) => path === "/api/auth/sessions" ? { sessions, current: "me" } : base(path, init));
  await mount({ remote: false, cloudHome: true, email: "owner@example.test" }, false);
  expect(host.querySelector("[data-phone-flow=platform]"), "this window's own sign-in is not a phone").not.toBeNull();
  await click("[data-phone-platform=ios]");
  expect(host.querySelector("[data-phone-cloud]")).not.toBeNull();
  expect(host.textContent).toContain("Log in on your iPhone");
  expect(host.querySelector("[data-phone-steps=ios]")?.textContent).toContain("Open Metal and log in");
  expect(host.querySelector("[data-phone-cloud-sign-in]")?.textContent).toContain("Log in with");
  expect(host.querySelector("[data-phone-cloud-sign-in]")?.textContent).toContain("owner@example.test");
  expect(host.querySelector("[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe("https://dusk.bot/m/signin#email=owner%40example.test");
  expect(host.querySelector("[data-phone-code]")).toBeNull();
  expect(minted).toBe(0);
  expect(qrs()).toBe(1);
  sessions = [...sessions, { id: "phone", label: "iPhone", scopes: ["admin", "client"] }];
  await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
  expect(host.querySelector("[data-phone-linked]")?.textContent).toContain("Your phone is in");
  await click("[data-phone-linked] [data-primary]");
  expect(host.textContent).toContain("Logs in with owner@example.test");
});

it("swaps the code for a new one a minute before it ends, so the screen never shows a dead code", async () => {
  await mount({ remote: false });
  await flush();
  expect(host.querySelector("[data-phone-code]")?.textContent).toBe("ABCD EFGH 0001");
  expect(host.textContent).toContain("A new code appears in 9 min");
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000 - RENEW_BEFORE_MS - 1_000); });
  expect(minted).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(minted).toBe(2);
  expect(host.querySelector("[data-phone-code]")?.textContent).toBe("ABCD EFGH 0002");
  expect(host.querySelector("[data-phone-qr]")?.getAttribute("data-phone-qr")).toContain("m=offer2&c=ABCDEFGH0002");
  expect(host.textContent).not.toContain("This code expired");
});

it("stops renewing after an hour or so and then says the code ended, with a new code one press away", async () => {
  await mount({ remote: false });
  await flush();
  for (let i = 0; i < AUTO_RENEWALS + 1; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
  expect(minted).toBe(1 + AUTO_RENEWALS);
  expect(host.querySelector("[data-phone-expired]")?.textContent).toContain("This code expired");
  expect(host.querySelector("[data-phone-qr]"), "the ended code fills the card in place of the qr").toBeNull();
  await click("[data-phone-new-code]");
  await flush();
  expect(minted).toBe(2 + AUTO_RENEWALS);
  expect(host.querySelector("[data-phone-code]")).not.toBeNull();
});

const retries = () => act(async () => { await vi.advanceTimersByTimeAsync(MINT_RETRY_MS.reduce((sum, ms) => sum + ms, 0) + 100); });

it("when no code can be made, says why with one way to try again, and shows no empty code to copy", async () => {
  const base = api.getMockImplementation()!;
  let refuse = true;
  api.mockImplementation(async (path: string, init?: unknown) => {
    if (path === "/api/mobile/pairing" && refuse) throw new Error("A phone cannot reach this workspace yet");
    return base(path, init);
  });
  await mount({ remote: false });
  await flush();
  expect(host.querySelector("[data-pairing-failed]"), "it asks again before it says anything").toBeNull();
  await retries();
  expect(host.querySelector("[data-pairing-failed] [role=alert]")?.textContent).toContain("cannot reach");
  expect(host.querySelector("[data-phone-qr]")).toBeNull();
  expect(host.querySelector("[data-phone-copy]")).toBeNull();
  expect(host.textContent).not.toContain("Scan with your phone's camera");
  refuse = false;
  await click("[data-pairing-failed] [data-phone-new-code]");
  await flush();
  expect(host.querySelector("[data-phone-code]")?.textContent).toBe("ABCD EFGH 0001");
});

it("a cloud's phone page has no browser code to type into the app, and Connect your phone never opens one", async () => {
  const phone = { top: createElement("div", { "data-phone-top": "" }), stepping: false, phones: null };
  await act(async () => { root = createRoot(host); root.render(createElement(ServerPairingCard, { initialSession: { kind: "loopback" }, cloudHome: true, simple: true, phone, focusRequest: 2 })); });
  await flush();
  expect(host.querySelector("[data-phone-top]")).not.toBeNull();
  expect(host.querySelector("[data-pair-computer]")).toBeNull();
  expect(host.textContent).not.toContain("Create code");
  // this computer keeps the browser code, folded, and asking for the phone does not unfold it
  await act(async () => root.unmount());
  await act(async () => { root = createRoot(host); root.render(createElement(ServerPairingCard, { initialSession: { kind: "loopback" }, simple: true, phone, focusRequest: 3 })); });
  await flush();
  expect(host.querySelector("[data-pair-computer]")).not.toBeNull();
  expect(host.querySelector<HTMLElement>("#server-pairing-code")?.hidden).toBe(true);
});

describe("a dusk cloud in the desktop app", () => {
  type Answer = Awaited<ReturnType<NonNullable<NonNullable<NonNullable<Window["duskDesktop"]>["cloudPlan"]>["phoneSignIn"]>>>;
  let signIns: Array<boolean | undefined>, answer: () => Answer, sessions: { id: string; label: string; scopes: string[] }[];
  beforeEach(() => {
    signIns = []; let n = 0;
    answer = () => ({ outcome: "code", code: `ABCD-EFG${"HJK"[n++ % 3]}`, expiresAt: Date.now() + 10 * 60_000, email: "owner@example.test" });
    vi.stubGlobal("duskDesktop", { cloudPlan: { phoneSignIn: async (renew?: boolean) => { signIns.push(renew); return answer(); } } });
    sessions = [{ id: "me", label: "This window", scopes: ["admin"] }];
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, init?: unknown) => path === "/api/auth/sessions" ? { sessions, current: "me" } : base(path, init));
  });

  it("shows one qr and a letters-only code that log the phone in, with the account it logs into, and sees the phone arrive", async () => {
    await mount({ remote: false, cloudHome: true });
    await flush();
    expect(host.querySelector("[data-phone-cloud-code]")).not.toBeNull();
    expect(host.textContent).toContain("Log in on your iPhone");
    expect(signIns, "made once, as a fresh code").toEqual([false]);
    expect(minted, "never a workspace pairing code").toBe(0);
    expect(qrs()).toBe(1);
    expect(host.querySelector("[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe("https://dusk.bot/m/signin#c=ABCDEFGH&email=owner%40example.test");
    expect(host.querySelector("[data-phone-code]")?.textContent).toBe("ABCD EFGH");
    expect(host.querySelector("[data-phone-steps=ios]")?.textContent).toContain("Open it and scan the QR code");
    expect(host.querySelector("[data-phone-cloud-as]")?.textContent).toBe("Logs in as owner@example.test");
    expect(host.textContent).toContain("Waiting for your phone to log in");
    expect(host.textContent).toContain("A new code appears in 9 min");
    sessions = [...sessions, { id: "phone", label: "iPhone", scopes: ["admin", "client"] }];
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(host.querySelector("[data-phone-linked]")?.textContent).toContain("Your phone is in");
    await click("[data-phone-linked] [data-primary]");
    expect(host.textContent, "the account's email even though the workspace profile has none").toContain("Logs in with owner@example.test");
  });

  it("renews silently before the code ends, and New code asks for a fresh one", async () => {
    await mount({ remote: false, cloudHome: true });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000 - RENEW_BEFORE_MS + 1_000); });
    expect(signIns).toEqual([false, true]);
    expect(host.querySelector("[data-phone-code]")?.textContent).toBe("ABCD EFGJ");
    await click("[data-phone-new-code]");
    await flush();
    expect(signIns).toEqual([false, true, false]);
  });

  it("a cancelled presence check shows nothing and says nothing; a signed-out desktop says how to fix it", async () => {
    answer = () => ({ outcome: "canceled" });
    await mount({ remote: false, cloudHome: true });
    await flush();
    expect(host.querySelector("[data-phone-code]")).toBeNull();
    expect(host.querySelector("[role=alert]")).toBeNull();
    answer = () => ({ outcome: "signed-out" });
    await act(async () => root.unmount());
    await mount({ remote: false, cloudHome: true });
    await flush();
    expect(host.querySelector("[data-pairing-failed] [role=alert]")?.textContent).toBe("Sign in to dusk cloud on this computer first, then try again.");
  });

  it("asks again by itself while the account service does not answer, and shows the code once it does", async () => {
    const real = answer;
    let fails = 1;
    answer = () => (fails-- > 0 ? { outcome: "failed" } : real());
    await mount({ remote: false, cloudHome: true });
    await flush();
    expect(host.querySelector("[data-pairing-failed]")).toBeNull();
    await retries();
    expect(signIns, "the retry renews the checked code, so the person is not asked twice").toEqual([false, true]);
    expect(host.querySelector("[data-phone-code]")?.textContent).toBe("ABCD EFGH");
  });

  it("when no account code can be made, the qr opens the app's email log in instead of an error", async () => {
    answer = () => ({ outcome: "failed" });
    await mount({ remote: false, cloudHome: true, email: "owner@example.test" });
    await flush();
    await retries();
    expect(signIns).toEqual([false, true, true]);
    expect(host.querySelector("[data-pairing-failed]")).toBeNull();
    expect(host.querySelector("[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe("https://dusk.bot/m/signin#email=owner%40example.test");
    expect(host.querySelector("[data-phone-cloud-sign-in]")?.textContent).toContain("owner@example.test");
  });

  it("an account service without phone codes goes straight to the email log in, without retrying", async () => {
    answer = () => ({ outcome: "unsupported" });
    await mount({ remote: false, cloudHome: true, email: "owner@example.test" });
    await flush();
    expect(signIns).toEqual([false]);
    expect(host.querySelector("[data-pairing-failed]")).toBeNull();
    expect(host.querySelector("[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe("https://dusk.bot/m/signin#email=owner%40example.test");
  });

  it("a signed-out desktop offers Sign in, not Try again", async () => {
    const signIn = vi.fn(async () => {});
    vi.stubGlobal("duskDesktop", { cloudPlan: { phoneSignIn: async () => ({ outcome: "signed-out" }), signIn } });
    await mount({ remote: false, cloudHome: true });
    await flush();
    expect(host.querySelector("[data-pairing-failed] [role=alert]")?.textContent).toBe("Sign in to dusk cloud on this computer first, then try again.");
    expect(host.querySelector("[data-pairing-failed] [data-phone-new-code]")?.textContent).toBe("Sign in");
    await click("[data-pairing-failed] [data-phone-new-code]");
    await flush();
    expect(signIn).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-pairing-failed] [data-phone-new-code]")?.textContent).toBe("Try again");
  });

  it("the local computer's pairing never asks the account for a phone code", async () => {
    await mount({ remote: false });
    await flush();
    expect(signIns).toEqual([]);
    expect(minted).toBe(1);
    expect(host.querySelector("[data-phone-qr]")?.getAttribute("data-phone-qr")).toBe("https://dusk.bot/m/pair#m=offer1&c=ABCDEFGH0001");
  });
});
