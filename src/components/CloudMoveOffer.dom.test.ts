// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudSendNotice } from "../../electron/cloud-send.mjs";

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, tracked: [] as Array<[string, unknown]> }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: fixture.state, dispatch: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ track: (name: string, props: unknown) => { fixture.tracked.push([name, props]); } }));
vi.mock("./Avatar", () => ({ MausAvatar: () => null }));

const { CloudMoveOffer } = await import("./CloudMoveOffer");
const { CloudMoveRow } = await import("./CloudMoveSettings");
const { t } = await import("@/lib/i18n");
const { botsAcross, moveProgress } = await import("@/lib/cloud-move-offer");
const { setLocale } = await import("@/lib/i18n");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: CloudSendNotice = { ready: false, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null };
const DONE: CloudSendNotice = { ...BASE, move: { phase: "done", phone: false, counts: { bots: 12, skills: 4, logins: 0, onePassword: false, chats: 48, routines: 2 } } };
const JARGON = /\b(pause|passes|pass|verify|verified|automations?|freeze|check)\b/iu;
let host: HTMLDivElement, root: Root;
let current: CloudSendNotice;
let listener: ((notice: CloudSendNotice) => void) | null;
const calls: string[] = [];
const bridge = {
  notice: vi.fn(async () => current),
  onNotice: (cb: (notice: CloudSendNotice) => void) => { listener = cb; return () => { listener = null; }; },
  dismiss: vi.fn(async (signature: string) => { calls.push(`dismiss:${signature}`); current = { ...current, move: undefined }; return current; }),
  moveRetry: vi.fn(async () => { calls.push("retry"); current = { ...BASE, move: { phase: "copy" } }; return current; }),
  moveOpen: vi.fn(async () => { calls.push("open"); return current; }),
  moveOfferAccept: vi.fn(async (from: string) => { calls.push(`accept:${from}`); current = { ...BASE, move: { phase: "copy" } }; return current; }),
  moveOfferDismiss: vi.fn(async (which: string) => {
    calls.push(`dismiss-offer:${which}`);
    current = { ...BASE, offer: { stage: which === "prompt" ? "banner" : "settings", bots: 12 } };
    return current;
  }),
};
const workspaces = { state: vi.fn(async () => ({ local: true, name: "This computer" })), menu: vi.fn(async () => { calls.push("menu"); }), onChanged: () => () => {} };

const settle = async () => { await act(async () => {}); await act(async () => {}); };
const render = async (node: ReturnType<typeof createElement>) => { await act(async () => root.render(node)); await settle(); };
const push = async (next: CloudSendNotice) => { current = next; await act(async () => listener?.(next)); await settle(); };
const press = async (label: string) => { await act(async () => button(label)!.click()); await settle(); };
const button = (text: string) => [...document.querySelectorAll("button")].find((found) => found.textContent?.trim() === text) as HTMLButtonElement | undefined;
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const across = () => Number(document.querySelector("[data-cloud-move-scene]")?.getAttribute("data-cloud-move-scene"));

beforeEach(() => {
  setLocale("en");
  fixture.state = { connected: true, config: {}, appSettingsOpen: false, settingsOpen: false, pluginsOpen: false, shortcutsOpen: false };
  fixture.tracked = [];
  calls.length = 0;
  listener = null;
  current = { ...BASE, offer: { stage: "prompt", bots: 12 } };
  bridge.moveOfferAccept.mockClear();
  (window as unknown as { duskDesktop: unknown }).duskDesktop = { cloudSendPage: bridge, workspaces };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

it("asks in one line with Move and Later, then the same sheet follows the bots hopping across, and ends with All moved and Open dusk cloud", async () => {
  await render(createElement(CloudMoveOffer));
  expect(sheet()?.getAttribute("data-cloud-move")).toBe("ask");
  expect(sheet()?.querySelector("#" + CSS.escape(sheet()!.getAttribute("aria-labelledby")!))?.textContent).toBe("Move your bots to dusk cloud? They'll keep working when this computer is off.");
  expect([...sheet()!.querySelectorAll("button")].map((found) => found.textContent)).toEqual(["What moves", "Later", "Move"]);
  expect(across()).toBe(0);
  expect(fixture.tracked).toEqual([["cloud_move_prompt", { action: "shown" }]]);
  await press("Move");
  expect(calls).toEqual(["accept:prompt"]);
  expect(sheet()?.getAttribute("data-cloud-move")).toBe("moving");
  expect(sheet()?.textContent).toBe("Moving your bots to dusk cloud…Hide");
  await push({ ...BASE, move: { phase: "copy", chats: { done: 60, total: 120 } } });
  expect(across()).toBe(1);
  await push({ ...BASE, move: { phase: "finishing" } });
  expect(across()).toBe(2);
  await push({ ...BASE, move: { phase: "copy" } });
  expect(across(), "the bots never hop back").toBe(2);
  await push(DONE);
  expect(sheet()?.getAttribute("data-cloud-move")).toBe("done");
  expect(sheet()?.textContent).toBe("All movedYour bots are working on dusk cloud.Open dusk cloud");
  expect(across()).toBe(3);
  await press("Open dusk cloud");
  expect(calls).toEqual(["accept:prompt", "open"]);
});

it("says in one line what moves and that this computer keeps a copy, and What moves opens the whole list", async () => {
  (window as unknown as { duskDesktop: { platform?: string } }).duskDesktop.platform = "darwin";
  await render(createElement(CloudMoveOffer));
  const list = document.querySelector<HTMLElement>("[data-what-moves]")!;
  expect(list.firstElementChild?.textContent).toBe("Your bots move with their chats, memory, routines and logins. This Mac keeps a copy. What moves");
  const toggle = button("What moves")!;
  const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);
  await press("What moves");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(panel.hidden).toBe(false);
  expect([...panel.querySelectorAll("li")].map((item) => item.textContent)).toEqual(
    ["Bots and their chats", "Memory and files", "Routines", "Saved logins and passwords", "Connected apps and AI keys"]);
  expect(panel.textContent).toContain("This Mac keeps working until the move is done, then keeps a copy.");
  expect(panel.textContent).not.toMatch(/sign in|minutes/iu);
});

it("Later closes the sheet for good, then a slim line with Move asks; its close leaves only Settings", async () => {
  await render(createElement(CloudMoveOffer));
  await press("Later");
  expect(calls).toEqual(["dismiss-offer:prompt"]);
  expect(sheet()).toBeNull();
  expect(document.querySelector("[data-cloud-move-banner]")?.textContent).toBe("Move your bots to dusk cloudMove");
  expect(fixture.tracked).toContainEqual(["cloud_move_banner", { action: "shown" }]);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  await settle();
  expect(calls).toEqual(["dismiss-offer:prompt", "dismiss-offer:banner"]);
  expect(document.querySelector("[data-cloud-move-banner]")).toBeNull();
  expect(sheet()).toBeNull();
});

it("Escape on the ask is Later", async () => {
  await render(createElement(CloudMoveOffer));
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  expect(calls).toEqual(["dismiss-offer:prompt"]);
});

it("the line's Move starts the move and opens the sheet on its way", async () => {
  current = { ...BASE, offer: { stage: "banner", bots: 2 } };
  await render(createElement(CloudMoveOffer));
  expect(sheet()).toBeNull();
  await press("Move");
  expect(calls).toEqual(["accept:banner"]);
  expect(sheet()?.getAttribute("data-cloud-move")).toBe("moving");
});

it("waits while Settings or another sheet is open", async () => {
  fixture.state = { ...fixture.state, appSettingsOpen: true };
  await render(createElement(CloudMoveOffer));
  expect(sheet()).toBeNull();
  expect(fixture.tracked).toEqual([]);
});

it("a start that fails is one friendly line and Try again, which starts it again", async () => {
  bridge.moveOfferAccept.mockRejectedValueOnce(new Error("Error invoking remote method 'cloud-send:move-offer-accept': Error: My Cloud did not answer."));
  await render(createElement(CloudMoveOffer));
  await press("Move");
  expect(sheet()?.getAttribute("data-cloud-move")).toBe("failed");
  expect(sheet()?.textContent).toBe("Something got in the way. Your bots are safe here.HideTry again");
  await press("Try again");
  expect(calls).toEqual(["accept:prompt"]);
  expect(bridge.moveOfferAccept).toHaveBeenCalledTimes(2);
  expect(sheet()?.getAttribute("data-cloud-move")).toBe("moving");
});

it("a move stuck on its way is the same friendly line, and Try again runs the move's own retry", async () => {
  current = { ...BASE, move: { phase: "copy" } };
  await render(createElement(CloudMoveOffer));
  expect(sheet(), "the sheet never opens by itself on a move under way").toBeNull();
  current = { ...BASE, offer: { stage: "prompt", bots: 3 } };
  root.unmount(); root = createRoot(host);
  await render(createElement(CloudMoveOffer));
  await press("Move");
  await push({ ...BASE, move: { phase: "copy", failing: { error: "My Cloud refused the pass because the freeze could not verify automations." } } });
  expect(sheet()?.textContent).toBe("Something got in the way. Your bots are safe here.HideTry again");
  await press("Try again");
  expect(calls.at(-1)).toBe("retry");
});

it("on My Cloud's page, All moved is a slim line, never a sheet over the cloud's chat, and Close ends it for good", async () => {
  current = DONE;
  await render(createElement(CloudMoveOffer, { cloudHome: true }));
  expect(sheet()).toBeNull();
  const line = document.querySelector("[data-cloud-move-done]");
  expect(line?.textContent).toBe("All moved · Your bots are working on dusk cloud.");
  (document.querySelector('[data-cloud-move-done] button[aria-label="Close"]') as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual(["dismiss:one-home"]);
});

it("a fresh first run's move (Metal and its welcome chat, nothing of the person's own) says no All moved, here or on the cloud's page", async () => {
  current = { ...BASE, move: { phase: "done", phone: false, counts: { bots: 1, skills: 0, logins: 0, onePassword: false, chats: 1, routines: 0 } } };
  await render(createElement(CloudMoveOffer, { cloudHome: true }));
  expect(sheet()).toBeNull();
  expect(document.querySelector("[data-cloud-move-done]")).toBeNull();
  await render(createElement(CloudMoveOffer));
  expect(sheet()).toBeNull();
  expect(document.body.textContent).not.toContain("All moved");
});

it("never says how the move works: no pauses, passes, checks or automations", async () => {
  const seen: string[] = [];
  await render(createElement(CloudMoveOffer));
  seen.push(sheet()!.textContent!);
  await press("Move");
  for (const move of [{ phase: "wait" }, { phase: "finishing" }, { phase: "copy", failing: { error: "check failed after three passes" } }] as const) {
    await push({ ...BASE, move });
    seen.push(sheet()!.textContent!);
  }
  await push(DONE);
  seen.push(sheet()!.textContent!);
  for (const text of seen) expect(text).not.toMatch(JARGON);
});

it("Settings → Computer offers the move as one row under the workspaces, then how it goes and Try again", async () => {
  current = { ...BASE, offer: { stage: "settings", bots: 12 } };
  await render(createElement(CloudMoveRow, { otherwise: createElement("p", { "data-otherwise": "" }) }));
  const row = () => host.querySelector('[data-panel-row="workspace-move"]')!;
  const accept = () => host.querySelector<HTMLButtonElement>("[data-cloud-move-accept]")!;
  expect(host.querySelector("[data-otherwise]")).toBeNull();
  expect(row().textContent).toBe(`${t("cloudMoveOffer.banner")}${t("settings.docs.ws.moveHint")}${t("cloudMoveOffer.move")}`);
  await act(async () => accept().click()); await settle();
  expect(calls).toEqual(["accept:settings"]);
  expect(row().textContent).toBe(`${t("cloudMoveOffer.banner")}${t("cloudMoveOffer.moving")}`);
  await push({ ...BASE, move: { phase: "copy", failing: { error: "My Cloud did not answer." } } });
  expect(row().textContent).toBe(`${t("cloudMoveOffer.banner")}${t("cloudMoveOffer.failed")}${t("cloudMoveOffer.tryAgain")}`);
  await press(t("cloudMoveOffer.tryAgain"));
  expect(calls.at(-1)).toBe("retry");
});

it("Settings → Computer shows what it was given instead while no move is offered", async () => {
  current = BASE;
  await render(createElement(CloudMoveRow, { otherwise: createElement("p", { "data-otherwise": "" }) }));
  expect(host.querySelector("[data-otherwise]")).not.toBeNull();
  expect(host.querySelector('[data-panel-row="workspace-move"]')).toBeNull();
});

it("progress only moves forward in the scene's terms: the last bot hops once everything arrived", () => {
  expect(botsAcross(moveProgress({ phase: "copy" }), 3)).toBe(0);
  expect(botsAcross(moveProgress({ phase: "copy", chats: { done: 120, total: 120 } }), 3)).toBe(2);
  expect(botsAcross(moveProgress({ phase: "finishing" }), 3)).toBe(2);
  expect(botsAcross(moveProgress({ phase: "done", phone: false }), 3)).toBe(3);
});
