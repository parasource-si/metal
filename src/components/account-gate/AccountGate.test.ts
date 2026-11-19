// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceWord, setLocale } from "@/lib/i18n";
import { AccountGate, reloadWhenSignedOut } from "./AccountGate";
import type { AccountGateBridge, GateState } from "./bridge";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => createElement("span") }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let state: GateState, bridge: AccountGateBridge, change: (next: GateState) => void;
let host: HTMLDivElement, root: Root | null;
const mount = () => act(async () => { root = createRoot(host); root.render(createElement(AccountGate, { bridge })); });
const button = (name: string) => [...host.querySelectorAll("button")].find(node => node.textContent === name)!;
const email = () => host.querySelector<HTMLInputElement>("input[type=email]")!;
const digit = (n: number) => host.querySelector<HTMLInputElement>(`input[aria-label="Digit ${n} of 8"]`)!;
const type = (field: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const submit = () => act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const paste = (field: HTMLInputElement, value: string) => act(async () => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => value } });
  field.dispatchEvent(event);
});
const key = (field: HTMLInputElement, value: string) => act(async () => {
  field.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
});

beforeEach(() => {
  setLocale("en");
  state = { required: true, blocked: true, status: "signed-out" };
  bridge = {
    state: vi.fn(async () => state), signInStart: vi.fn(async email => ({ outcome: "sent" as const, email, expiresAt: Date.now() + 600_000, resendAt: Date.now() + 30_000, signupOpen: true })),
    signInVerify: vi.fn(async () => ({ outcome: "signed-in" as const })), signInCancel: vi.fn(async () => {}),
    browser: vi.fn(async () => state), cancel: vi.fn(async () => ({ ...state, status: "signed-out" as const })), reopen: vi.fn(async () => state),
    onChange: vi.fn(cb => { change = cb; return vi.fn(); }),
  };
  host = document.createElement("div"); document.body.append(host); root = null;
});
afterEach(async () => { await act(async () => root?.unmount()); host.remove(); vi.restoreAllMocks(); });

it("renders the title, providers and email step, and focuses the email field", async () => {
  const html = renderToStaticMarkup(createElement(AccountGate, { bridge }));
  expect(html).toContain("Sign in to your Dusk account");
  expect(html).toContain(`One account for your bots, your ${deviceWord()} and your cloud desktop.`);
  for (const name of ["Google", "Apple"]) expect(html).toContain(`Continue with ${name}`);
  expect(html).not.toContain("Continue with X");
  expect(html).toContain('type="email"'); expect(html).toContain("Send code");
  await mount();
  expect(host.querySelector("h1")?.textContent).toBe("Sign in to your Dusk account");
  expect(document.activeElement).toBe(email());
});

it.each([["Google", "google"], ["Apple", "apple"]] as const)("starts %s browser sign-in", async (name, provider) => {
  await mount();
  await act(async () => button(`Continue with ${name}`).click());
  expect(bridge.browser).toHaveBeenCalledExactlyOnceWith(provider);
});

it("submits email, accepts an eight-digit paste and verifies the code", async () => {
  await mount(); await type(email(), "person@example.com"); await submit();
  expect(bridge.signInStart).toHaveBeenCalledExactlyOnceWith("person@example.com");
  expect(document.activeElement).toBe(digit(1));
  await paste(digit(1), "1234-5678");
  expect(digit(8).value).toBe("8");
  expect(bridge.signInVerify, "the eighth digit signs in by itself").toHaveBeenCalledExactlyOnceWith("12345678");
});

it("says so when there is no keyring, and keeps the code when the sign-in can't be saved", async () => {
  state = { ...state, plainStorage: true };
  bridge.signInVerify = vi.fn(async () => ({ outcome: "storage" as const }));
  await mount();
  expect(host.textContent).toContain("No keyring on this computer");
  await type(email(), "person@example.com"); await submit();
  await paste(digit(1), "12345678");
  expect(host.querySelector("[role=alert]")?.textContent).toBe("This computer can't save your sign-in right now. Restart the app and try again.");
  expect(host.textContent).not.toContain("Couldn't reach dusk cloud");
});

it("goes back to the sign-in when the person signs out in the app, but not for a moment's switch of accounts", async () => {
  vi.useFakeTimers();
  try {
    const reload = vi.fn();
    const stop = reloadWhenSignedOut(bridge, reload, 1000);
    state = { required: true, blocked: false, status: "connected" };
    change({ required: true, blocked: true, status: "signed-out" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload, "signed in again meanwhile").not.toHaveBeenCalled();
    state = { required: true, blocked: true, status: "signed-out" };
    change(state);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledOnce();
    stop();
  } finally { vi.useRealTimers(); }
});

it("keeps the code boxes' arrow and backspace behavior", async () => {
  await mount(); await type(email(), "person@example.com"); await submit();
  await type(digit(1), "1"); expect(document.activeElement).toBe(digit(2));
  await key(digit(2), "Backspace");
  expect(document.activeElement).toBe(digit(1)); expect(digit(1).value).toBe("");
  await key(digit(1), "ArrowRight"); expect(document.activeElement).toBe(digit(2));
});

it("shows the browser enrollment code and cancels", async () => {
  state = { ...state, status: "connecting", enrollment: { userCode: "HELLO-WORLD", expiresAt: Date.now() + 60_000 } };
  await mount();
  expect(host.querySelector("h1")?.textContent).toBe("Finish signing in in your browser");
  expect(host.querySelector("code")?.textContent).toBe("HELLO-WORLD");
  await act(async () => button("Cancel").click());
  expect(bridge.cancel).toHaveBeenCalledOnce(); expect(email()).toBeTruthy();
});

it.each(["access-ended", "expired"])("explains an ended session: %s", async message => {
  state = { ...state, status: "reauth-required", message };
  await mount();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Your session ended. Sign in again.");
});

it("reloads when the gate stops blocking and removes its listener on unmount", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const stop = vi.fn(); vi.mocked(bridge.onChange).mockImplementation(cb => { change = cb; return stop; });
  await mount();
  await act(async () => change({ required: true, blocked: false, status: "connected" }));
  expect(reload).toHaveBeenCalledOnce();
  await act(async () => root?.unmount()); root = null;
  expect(stop).toHaveBeenCalledOnce();
});

it("shows only the providers the account service says sign in, and none when it can't be asked", async () => {
  bridge.options = vi.fn(async () => ({ providers: ["google" as const, "apple" as const], recovery: true }));
  await mount();
  expect(button("Continue with Google")).toBeTruthy(); expect(button("Continue with Apple")).toBeTruthy();
  expect(button("Continue with X")).toBeUndefined();
  await act(async () => root?.unmount()); root = null; host.innerHTML = "";
  bridge.options = vi.fn(async () => { throw new Error("offline"); });
  await mount();
  expect([...host.querySelectorAll("button")].some(node => node.textContent?.startsWith("continue with"))).toBe(false);
  expect([...host.querySelectorAll("div")].some(node => node.textContent === "or")).toBe(false); expect(email()).toBeTruthy();
});

it("Can't sign in? sends a recovery code, says what comes, and gives plain help when the address is lost", async () => {
  bridge.options = vi.fn(async () => ({ providers: ["google" as const], recovery: true }));
  await mount();
  await act(async () => button("Can't sign in?").click());
  expect(host.querySelector("h1")?.textContent).toBe("Can't sign in?");
  expect(button("Continue with Google")).toBeUndefined();
  expect(host.querySelector("h2")?.textContent).toBe("Lost access to that email?");
  expect(host.textContent).toContain("write to hello@dusk.bot from any email with your receipt");
  await type(email(), "person@example.com"); await submit();
  expect(bridge.signInStart).toHaveBeenCalledExactlyOnceWith("person@example.com", { recover: true });
  expect(host.textContent).toContain("If an account uses this email, the code is on its way");
  await paste(digit(1), "12345678");
  expect(bridge.signInVerify).toHaveBeenCalledExactlyOnceWith("12345678");
});

it("back to sign in returns to the providers and a plain code", async () => {
  bridge.options = vi.fn(async () => ({ providers: ["apple" as const], recovery: true }));
  await mount();
  await act(async () => button("Can't sign in?").click());
  await act(async () => button("Back to sign in").click());
  expect(host.querySelector("h1")?.textContent).toBe("Sign in to your Dusk account");
  await type(email(), "person@example.com"); await submit();
  expect(bridge.signInStart).toHaveBeenCalledExactlyOnceWith("person@example.com");
});

it("waits for the browser to come back from a provider, reopens it and cancels", async () => {
  state = { ...state, status: "connecting", browser: "google" };
  await mount();
  expect(host.querySelector("h1")?.textContent).toBe("Finish signing in in your browser");
  expect(host.querySelector("code")).toBeNull();
  await act(async () => button("Open the browser again").click());
  expect(bridge.reopen).toHaveBeenCalledOnce();
  await act(async () => button("Cancel").click());
  expect(bridge.cancel).toHaveBeenCalledOnce(); expect(email()).toBeTruthy();
});

it.each([
  ["signin-cancelled", "Sign-in was canceled. Try again when you are ready."],
  ["enrollment-expired", "This sign-in expired. Please start again."],
  ["signin-failed", "Browser sign-in failed. Please try again."],
])("says why a browser sign-in came back without one: %s", async (message, line) => {
  state = { ...state, status: "signed-out", message };
  await mount();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(line);
});
