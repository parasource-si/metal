// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { AccountGate, mobileAccountOrigin, providersFor, useMobileAccount } from "./AccountGate";
import { MobileSignIn } from "./MobileSignIn";
import { PlatformContext, webPlatform, type MobilePlatform } from "../platform";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => createElement("span") }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null;
let platform: MobilePlatform, secrets: Map<string, string>, prefs: Map<string, string>, listener: ((url: string) => boolean) | undefined, resume: (() => void) | undefined;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const origin = "https://dusk.bot";
const account = { id: "person", email: "person@example.com" };
const token = `omc_${"t".repeat(43)}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = null;
  setLocale("en"); window.history.replaceState({}, "", "/"); vi.stubEnv("VITE_DUSK_ALLOW_SIGNED_OUT", ""); vi.stubEnv("VITE_DUSK_ACCOUNT_ORIGIN", "");
  secrets = new Map(); prefs = new Map(); listener = undefined; resume = undefined;
  platform = { ...webPlatform(), native: true, kind: "ios", secrets: {
    get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async key => { secrets.delete(key); },
  }, prefs: { get: async key => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async key => { prefs.delete(key); } },
    onAppUrl: cb => { listener = cb; return vi.fn(); }, onResume: cb => { resume = cb; return vi.fn(); }, openExternal: vi.fn(async () => {}) };
  fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await act(async () => root?.unmount()); host.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
/** what the app shows: the workspace once signed in, else the sign-in a person can choose to open */
function Probe() {
  const value = useMobileAccount();
  return value?.account ? createElement("p", null, `workspace ${value.account.email}`) : createElement(MobileSignIn, { onSignedIn: () => {} });
}
const gate = (children: ReactNode = createElement(Probe)) => createElement(PlatformContext, { value: platform }, createElement(AccountGate, { children }));
const mount = (children?: ReactNode, strict = false) => act(async () => {
  root = createRoot(host); root.render(strict ? createElement(StrictMode, null, gate(children)) : gate(children));
});
const heading = () => expect(host.querySelector("h1")?.textContent).toBe("Log in to Metal");
const type = (selector: string, value: string) => act(async () => {
  const field = host.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const typeEmail = () => type("input[type=email]", account.email);
const submit = () => act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

const save = () => secrets.set("dusk.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
const signedIn = `workspace ${account.email}`;

it("never blocks the native app: signed out, the app shows and the sign-in is something to open", async () => {
  fetcher.mockResolvedValue(response({ v: 1, providers: [], signupOpen: true }));
  function Plain() { const value = useMobileAccount(); return createElement("p", null, `app ${value?.offered} ${value?.account === null}`); }
  await mount(createElement(Plain)); expect(host.textContent).toBe("app true true");
});
it("passes through browser children and offers no account unless the development query asks for one", async () => {
  platform.native = false; platform.kind = "web";
  expect(renderToStaticMarkup(gate(createElement("p", null, "workspace")))).toBe("<p>workspace</p>");
  function Offered() { return createElement("p", null, String(useMobileAccount()?.offered)); }
  await mount(createElement(Offered)); expect(host.textContent).toBe("false");
});
it("honors the native signed-out development override", () => {
  vi.stubEnv("VITE_DUSK_ALLOW_SIGNED_OUT", "1"); expect(renderToStaticMarkup(gate(createElement("p", null, "workspace")))).toBe("<p>workspace</p>");
});
it("restores an account and provides its identity through context", async () => {
  save(); fetcher.mockResolvedValue(response({}));
  await mount(); expect(host.textContent).toBe(signedIn); expect(host.querySelector("h1")).toBeNull();
});
it("shows the saved sign-in before the service answers, and stays signed in when the check fails", async () => {
  save();
  let answer: (value: Response) => void = () => {};
  fetcher.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
  await mount(); expect(host.textContent).toBe(signedIn);
  await act(async () => { answer(response({ error: "failed" }, 503)); });
  expect(host.textContent).toBe(signedIn);
});
it("stays signed in when the app comes back and the service is down", async () => {
  save(); fetcher.mockResolvedValue(response({}));
  await mount(); expect(host.textContent).toBe(signedIn);
  fetcher.mockResolvedValue(response({ error: "failed" }, 500));
  await act(async () => { resume?.(); });
  expect(host.textContent).toBe(signedIn);
  fetcher.mockResolvedValue(response({ error: "invalid_token" }, 401));
  await act(async () => { resume?.(); });
  expect(host.textContent).not.toBe(signedIn);
});
it("signs out back to signed-out", async () => {
  save(); fetcher.mockResolvedValue(response({}));
  function Child() { const value = useMobileAccount(); return value?.account ? createElement("button", { onClick: () => void value?.signOut() }, "leave") : createElement("p", null, "signed out"); }
  await mount(createElement(Child));
  expect(host.querySelector("button")?.textContent).toBe("leave");
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toBe("signed out"); expect(secrets.has("dusk.account")).toBe(false);
});
it("handles auth links, leaves pairing links to ConnectionGate and says why a sign-in failed", async () => {
  fetcher.mockResolvedValue(response({ v: 1, providers: [], signupOpen: true }));
  const closeBrowser = vi.fn(); platform.closeBrowser = closeBrowser;
  await mount(); heading(); expect(listener?.("duskbot://pair?code=abc")).toBe(false); expect(closeBrowser).not.toHaveBeenCalled();
  await act(async () => { expect(listener?.("duskbot://auth?code=abc&state=bad")).toBe(true); });
  expect(closeBrowser).toHaveBeenCalledOnce();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("This sign-in expired. Please start again.");
});
it("signs in with an emailed code typed into one field", async () => {
  fetcher.mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith("/v1/auth/providers")) return response({ v: 1, providers: [], signupOpen: true });
    if (url.endsWith("/sign-in/start")) return response({ cloudContractVersion: 1, attempt: "a".repeat(43), expiresIn: 600, resendAfter: 30, signupOpen: true });
    return response({ cloudContractVersion: 1, accessToken: token, expiresAt: Date.now() + 60_000, device: { id: "phone" }, account });
  });
  await mount(); await typeEmail(); await submit();
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  await type("input[autocomplete=one-time-code]", "1234 5678");
  expect(host.textContent).toBe(signedIn);
});
it("says a wrong code next to the code field, in the danger colour", async () => {
  fetcher.mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith("/v1/auth/providers")) return response({ v: 1, providers: [], signupOpen: true });
    if (url.endsWith("/sign-in/start")) return response({ cloudContractVersion: 1, attempt: "a".repeat(43), expiresIn: 600, resendAfter: 30, signupOpen: true });
    return response({ error: "invalid_code" }, 400);
  });
  await mount(); await typeEmail(); await submit();
  await type("input[autocomplete=one-time-code]", "11111111");
  const alert = host.querySelector("[role=alert]")!;
  expect(alert.textContent).toContain("That code isn't right");
  expect(alert.className).toContain("text-danger");
  expect(host.querySelector("input[autocomplete=one-time-code]")?.getAttribute("aria-invalid")).toBe("true");
});
const providers = (...enabled: string[]) => response({ v: 1, signupOpen: true, providers: ["google", "apple", "x"].map(id => ({ id, enabled: enabled.includes(id), comingSoon: false })) });
const buttons = () => [...host.querySelectorAll("button")].map(button => button.textContent ?? "");

it("an iPhone offers another company's sign-in only beside Sign in with Apple, and Apple leads", () => {
  expect(providersFor("ios", ["google", "apple"])).toEqual(["apple", "google"]);
  expect(providersFor("ios", ["google"])).toEqual([]);
  expect(providersFor("ios", [])).toEqual([]);
  expect(providersFor("android", ["google"])).toEqual(["google"]);
});
it("shows only the sign-in buttons the service has switched on, all with the same weight", async () => {
  fetcher.mockResolvedValue(providers("google", "apple"));
  await mount();
  const shown = [...host.querySelectorAll("button")].filter(button => button.textContent?.startsWith("Continue with"));
  expect(shown.map(button => button.textContent)).toEqual(["Continue with Apple", "Continue with Google"]);
  expect(new Set(shown.map(button => button.className)).size).toBe(1);
});
it("shows no provider button the service cannot vouch for, so none leads nowhere", async () => {
  fetcher.mockRejectedValue(new TypeError("offline"));
  await mount(); heading();
  expect(buttons().some(text => text.startsWith("Continue with"))).toBe(false);
  expect(host.querySelector("input[type=email]")).not.toBeNull();
});
it("the sign-in screen links the terms and the privacy policy", async () => {
  fetcher.mockResolvedValue(providers());
  await mount();
  expect(buttons()).toEqual(expect.arrayContaining(["Terms of use", "Privacy policy"]));
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Privacy policy")!.click(); });
  expect(platform.openExternal).toHaveBeenCalledWith("https://dusk.bot/privacy");
});
it("an account signed out or deleted elsewhere is dropped when the app comes back", async () => {
  save(); fetcher.mockResolvedValue(response({}));
  await mount(); expect(host.textContent).toBe(signedIn);
  fetcher.mockResolvedValue(response({ error: "invalid_token" }, 401));
  await act(async () => { resume?.(); await new Promise(resolve => setTimeout(resolve, 0)); });
  heading(); expect(secrets.has("dusk.account")).toBe(false);
});
it("a resume while the service cannot be reached keeps the account", async () => {
  save(); fetcher.mockResolvedValue(response({}));
  await mount();
  fetcher.mockRejectedValue(new TypeError("offline"));
  await act(async () => { resume?.(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.textContent).toBe(signedIn); expect(secrets.has("dusk.account")).toBe(true);
});

it("allows only bare safe origins in the development query", () => {
  for (const value of ["http://127.0.0.1:9000", "http://localhost:3000", "http://[::1]:9000", "https://fixture.example"]) expect(mobileAccountOrigin(false, new URLSearchParams({ accountOrigin: value }))).toBe(value);
  for (const value of ["http://example.com", "https://example.com/path", "https://u:p@example.com", "file:///tmp/a", "https://example.com?x=1"]) expect(mobileAccountOrigin(false, new URLSearchParams({ accountOrigin: value }))).toBe(origin);
  expect(mobileAccountOrigin(true, new URLSearchParams({ accountOrigin: "https://fixture.example" }))).toBe(origin);
  vi.stubEnv("VITE_DUSK_ACCOUNT_ORIGIN", "https://configured.example"); expect(mobileAccountOrigin(true, new URLSearchParams())).toBe("https://configured.example");
});

it("finishes a cold-launch auth link through StrictMode effect replay", async () => {
  secrets.set("dusk.account.pending", JSON.stringify({ verifier: "v".repeat(43), state: "state", provider: "google", at: Date.now(), origin }));
  let launch: string | null = "duskbot://auth?code=abc&state=state";
  platform.onAppUrl = cb => { if (launch && cb(launch)) launch = null; return () => {}; };
  const closeBrowser = vi.fn(); platform.closeBrowser = closeBrowser;
  fetcher.mockResolvedValue(response({ cloudContractVersion: 1, accessToken: token, expiresAt: Date.now() + 60_000, device: { id: "phone" }, account }));
  await mount(createElement(function Child() { return createElement("p", null, useMobileAccount()?.account?.email ?? "none"); }), true);
  expect(host.textContent).toBe(account.email); expect(fetcher).toHaveBeenCalledOnce(); expect(closeBrowser).toHaveBeenCalled();
});

it("says every Sign in with Apple problem in its own words", async () => {
  const { appleProblemLine } = await import("./AccountGate");
  const lines = (["failed", "unavailable", "signup-closed", "taken", "rate-limited", "offline"] as const).map(appleProblemLine);
  expect(new Set(lines).size).toBe(lines.length);
  // full sentences on the phone read in sentence case (src/locales/sentence-case.test.ts)
  for (const line of lines) expect(line).toMatch(/^[A-Z]/);
});
