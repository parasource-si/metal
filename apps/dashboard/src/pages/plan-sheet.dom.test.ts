// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { BillingOverview, Selection } from "../data/contracts";
import { fixtureCatalog } from "../data/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the server quote never answers: nothing on these pages may wait for it
const state = vi.hoisted(() => ({ cloud: {} as Record<string, unknown>, quote: vi.fn(() => new Promise<never>(() => {})) }));
vi.mock("../lib/api", async (real) => ({ ...(await real<typeof import("../lib/api")>()), FIXTURE: null, api: { quote: state.quote } }));
vi.mock("../data/cloud", () => ({ useCloud: () => state.cloud }));
vi.mock("../data/session", () => ({ useSession: () => ({ toast: () => {} }) }));
vi.mock("../lib/analytics", () => ({ track: () => {} }));

const plus: Selection = { license: "personal", members: 1, desktop: "shared-s", size: null, region: "eu-central", interval: "month" };
const billingFor = (selection: Selection | null): BillingOverview => ({
  subscription: selection ? { id: "sub", bundle: null, selection, status: "active", amountUsd: 20, currentPeriodEnd: Date.UTC(2026, 11, 13), cancelAt: null } : null,
  paymentMethod: null, invoices: [], retention: { offer: null, applied: null },
});
const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; });
async function mount(el: ReturnType<typeof createElement>) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(el));
}
const button = (text: RegExp) => [...document.querySelectorAll("button")].find((b) => text.test(b.textContent ?? "")) ?? null;

test("the license sheet's button enables the moment the selection changes, before any server quote", async () => {
  state.cloud = { catalog: fixtureCatalog, billing: billingFor(plus), changeCharge: vi.fn(), changePlan: vi.fn(), checkout: vi.fn() };
  const { LicenseSheet } = await import("./plan-sheet");
  await mount(createElement(LicenseSheet, { source: "dash_license", start: { license: "personal", members: 1 }, onClose: () => {}, onNothingLeft: () => {} }));
  const work = [...document.querySelectorAll<HTMLInputElement>("input[name=sheet-license]")].find((i) => i.value === "starter")!;
  const started = performance.now();
  await act(async () => work.click());
  const update = button(/^update license$/);
  expect(update).not.toBeNull();
  expect(update!.disabled).toBe(false);
  expect(performance.now() - started).toBeLessThan(100);
  // the total is the local price straight away: plus $20 and work $12
  expect(document.body.textContent).toContain("$32");
});

test("switch to pro on the plans page goes straight to checkout, with no sheet", async () => {
  const checkout = vi.fn((_req: object) => new Promise<boolean>(() => {}));
  state.cloud = { catalog: fixtureCatalog, billing: billingFor(null), clouds: [], refresh: () => {}, error: null, checkout, changeCharge: vi.fn(), changePlan: vi.fn() };
  const { BillingPage } = await import("./Billing");
  await mount(createElement(BillingPage));
  await act(async () => button(/^get pro$/)!.click());
  expect(checkout).toHaveBeenCalledTimes(1);
  expect(checkout.mock.calls[0]![0]).toMatchObject({ kind: "plan", source: "dash_billing", selection: { desktop: "shared-m", license: "starter" } });
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(button(/opening checkout/)?.getAttribute("aria-busy")).toBe("true");
});

test("a running plan switches in place, and stops on the card to show a charge", async () => {
  const changeCharge = vi.fn(async () => ({ timing: "now" as const, todayUsd: 15, taxUsd: 0, effectiveAt: 1, nextUsd: 50, nextAt: Date.UTC(2026, 11, 8) }));
  const changePlan = vi.fn(async () => {});
  state.cloud = { catalog: fixtureCatalog, billing: billingFor(plus), clouds: [], refresh: () => {}, error: null, checkout: vi.fn(), changeCharge, changePlan };
  const { BillingPage } = await import("./Billing");
  await mount(createElement(BillingPage));
  await act(async () => button(/^switch to pro$/)!.click());
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(changePlan).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("$15 today, for the rest of this billing month. then $50/mo from 8 Dec 2026.");
  await act(async () => button(/^pay \$15 and switch$/)!.click());
  expect(changePlan).toHaveBeenCalledWith(expect.objectContaining({ desktop: "shared-m" }), 15);
});

test("a switch during the trial and a smaller plan both stop once to say $0 today and when the new price starts", async () => {
  const trialEnd = Date.UTC(2026, 10, 20), periodEnd = Date.UTC(2026, 11, 8);
  const changeCharge = vi.fn(async (sel: { desktop: string }) => sel.desktop === "shared-m"
    ? { timing: "trial" as const, todayUsd: 0, taxUsd: 0, effectiveAt: 1, nextUsd: 50, nextAt: trialEnd }
    : { timing: "scheduled" as const, todayUsd: 0, taxUsd: 0, effectiveAt: periodEnd, nextUsd: 20, nextAt: periodEnd });
  const changePlan = vi.fn(async () => {});
  state.cloud = { catalog: fixtureCatalog, billing: billingFor(plus), clouds: [], refresh: () => {}, error: null, checkout: vi.fn(), changeCharge, changePlan };
  const { BillingPage } = await import("./Billing");
  await mount(createElement(BillingPage));
  await act(async () => button(/^switch to pro$/)!.click());
  expect(changePlan).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("$0 today. your free trial still ends 20 Nov 2026, then $50/mo.");
  expect(document.body.textContent).not.toMatch(/hello@dusk\.bot/);
  await act(async () => button(/^switch to pro$/)!.click());
  expect(changePlan).toHaveBeenCalledWith(expect.objectContaining({ desktop: "shared-m" }), 0);
});

test("buying a work license on its own: one click asks once, the button holds while the page opens, and says so if it can't", async () => {
  let fail = (_ok: boolean) => {};
  const checkout = vi.fn((_req: object) => new Promise<boolean>((done) => { fail = done; }));
  state.cloud = { catalog: fixtureCatalog, billing: billingFor(null), changeCharge: vi.fn(), changePlan: vi.fn(), checkout };
  const { LicenseSheet } = await import("./plan-sheet");
  await mount(createElement(LicenseSheet, { source: "dash_license", start: { license: "starter", members: 1 }, onClose: () => {}, onNothingLeft: () => {} }));
  const buy = button(/^buy .* license$/)!;
  // separate clicks, as a browser delivers them: the first one disables the button
  for (let i = 0; i < 3; i++) await act(async () => buy.click());
  expect(checkout).toHaveBeenCalledTimes(1);
  expect(checkout.mock.calls[0]![0]).toMatchObject({ kind: "plan", source: "dash_license", selection: { desktop: "none", license: "starter" } });
  const busy = button(/opening checkout/)!;
  expect([busy.disabled, busy.getAttribute("aria-busy")]).toEqual([true, "true"]);
  await act(async () => busy.click());
  expect(checkout).toHaveBeenCalledTimes(1);
  // the payment page didn't open: the button comes back and the sheet says why
  await act(async () => fail(false));
  expect(document.querySelector("[role=alert]")?.textContent).toBe("checkout didn't open. try again.");
  expect(button(/^buy .* license$/)?.disabled).toBe(false);
});

test("back from paying, having come from the app: the page says you're all set and points back to the app, before the plans load", async () => {
  sessionStorage.setItem("dusk.fromApp", "1");
  history.replaceState(null, "", "/billing?subscription_id=sub_1&status=active");
  state.cloud = { catalog: null, billing: null, clouds: [], refresh: () => {}, error: null, checkout: vi.fn(), changeCharge: vi.fn(), changePlan: vi.fn() };
  const { BillingPage } = await import("./Billing");
  await mount(createElement(BillingPage));
  expect(document.querySelector("[data-all-set] h1")?.textContent).toBe("you're all set");
  expect(document.body.textContent).toContain("go back to Metal.");
  expect(document.querySelector<HTMLAnchorElement>("[data-open-app-link]")?.getAttribute("href")).toBe("duskbot://cloud");
  await act(async () => button(/^see your plan$/)!.click());
  expect(document.querySelector("[data-all-set]")).toBeNull();
  expect(document.querySelector("[data-plans-skeleton]"), "the plans' own shape while they load, never a blank page").not.toBeNull();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

test("a payment still confirming keeps the plans page, its skeleton while it loads", async () => {
  sessionStorage.setItem("dusk.fromApp", "1");
  history.replaceState(null, "", "/billing?subscription_id=sub_1&status=processing");
  state.cloud = { catalog: null, billing: null, clouds: [], refresh: () => {}, error: null, checkout: vi.fn(), changeCharge: vi.fn(), changePlan: vi.fn() };
  const { BillingPage } = await import("./Billing");
  await mount(createElement(BillingPage));
  expect(document.querySelector("[data-all-set]")).toBeNull();
  expect(document.querySelector("[data-plans-skeleton]")).not.toBeNull();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});
