// @vitest-environment happy-dom
// Start fresh in a real DOM: the button shows only where main says it may, nothing runs until the confirm words are typed,
// a step that failed is listed with a retry while the dialog can't just be closed, and it only ever resets this computer:
// the account, its plan and its clouds stay, and deleting the account is a separate link to the account page.
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartFreshView } from "../../../electron/start-fresh.mjs";

const { StartFreshHost, StartFreshDialog, openStartFresh, startFreshTyped } = await import("./StartFresh");

const pending: StartFreshView = { phase: "idle", steps: [
  { id: "signout", kind: "signout", label: "tester@qa.dusk.test", status: "pending" },
  { id: "ai", kind: "ai", label: "", status: "pending" },
  { id: "local", kind: "local", label: "", status: "pending" },
] };
const partial: StartFreshView = { phase: "partial", steps: pending.steps.map((step) => step.id === "signout"
  ? { ...step, status: "failed", error: "The account service answered 502." }
  : { ...step, status: "done" }) };
const done: StartFreshView = { phase: "done", steps: pending.steps.map((step) => ({ ...step, status: "done" })) };

function fakeBridge(runs: StartFreshView = partial) {
  const listeners: Array<(view: StartFreshView) => void> = [];
  return {
    available: vi.fn(async () => true),
    preview: vi.fn(async () => pending),
    run: vi.fn(async (_typed: string) => runs),
    retry: vi.fn(async () => done),
    finish: vi.fn(async () => ({ ...done, phase: "restarting" as const })),
    onChanged: vi.fn((cb: (view: StartFreshView) => void) => { listeners.push(cb); return () => {}; }),
    emit: (view: StartFreshView) => listeners.forEach((cb) => cb(view)),
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  delete (window as { duskDesktop?: unknown }).duskDesktop;
});

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T & HTMLElement>(selector);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
function type(text: string) {
  const input = $<HTMLInputElement>("[data-start-fresh-input]")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Start fresh", () => {
  it("accepts only the confirm words, any case or spacing around them", () => {
    expect(startFreshTyped("start fresh")).toBe(true);
    expect(startFreshTyped("  START fresh ")).toBe(true);
    for (const typed of ["", "start", "start fresh!", "start  fresh", "delete everything"]) expect(startFreshTyped(typed)).toBe(false);
  });

  it("opens the reset dialog from the dev menu's event, and only in the desktop app", async () => {
    (window as { duskDesktop?: unknown }).duskDesktop = { startFresh: fakeBridge() };
    act(() => root.render(createElement(StartFreshHost)));
    await settle();
    expect($("[role=alertdialog]")).toBeNull();
    act(() => openStartFresh());
    await settle();
    expect($("[role=alertdialog]")?.textContent).toContain("This resets Metal on this computer and can't be undone");
    act(() => root.unmount());
    root = createRoot(host);
    (window as { duskDesktop?: unknown }).duskDesktop = {};
    act(() => root.render(createElement(StartFreshHost)));
    act(() => openStartFresh());
    await settle();
    expect($("[role=alertdialog]")).toBeNull();
  });

  it("keeps the red button disabled until the words match, and sends exactly what was typed", async () => {
    const bridge = fakeBridge();
    act(() => root.render(createElement(StartFreshDialog, { bridge: bridge as never, onClose: vi.fn() })));
    await settle();
    expect($("[role=alertdialog]")?.textContent).toContain("This resets Metal on this computer and can't be undone");
    const confirm = () => $<HTMLButtonElement>("[data-start-fresh-confirm]")!;
    expect(confirm().disabled).toBe(true);
    type("start fres");
    expect(confirm().disabled).toBe(true);
    act(() => confirm().click());
    expect(bridge.run).not.toHaveBeenCalled();
    type("Start fresh");
    expect(confirm().disabled).toBe(false);
    await act(async () => { confirm().click(); });
    await settle();
    expect(bridge.run).toHaveBeenCalledWith("Start fresh");
  });

  it("says the account, plan and dusk cloud stay, and sends account deletion to the account page instead", async () => {
    const openPage = vi.fn(async () => ({ outcome: "opened" }));
    (window as { duskDesktop?: unknown }).duskDesktop = { cloudAccount: { openPage } };
    act(() => root.render(createElement(StartFreshDialog, { bridge: fakeBridge() as never, onClose: vi.fn() })));
    await settle();
    const text = $("[role=alertdialog]")!.textContent!;
    expect(text).toContain("Your Dusk account, your plan or trial, your dusk cloud and your servers stay as they are");
    expect(text).not.toMatch(/cancel(s|led)? (your|the|its) plan|destroy/i);
    act(() => $<HTMLButtonElement>("[data-start-fresh-delete-account]")!.click());
    expect(openPage).toHaveBeenCalledWith("account");
  });

  it("lists what failed with a retry, and can't be closed halfway", async () => {
    const bridge = fakeBridge();
    const onClose = vi.fn();
    act(() => root.render(createElement(StartFreshDialog, { bridge: bridge as never, onClose })));
    await settle();
    type("start fresh");
    await act(async () => { $<HTMLButtonElement>("[data-start-fresh-confirm]")!.click(); });
    await settle();
    expect($("[data-start-fresh-dialog]")?.getAttribute("data-start-fresh-dialog")).toBe("partial");
    const failed = $("[data-start-fresh-step=signout]")!;
    expect(failed.dataset.status).toBe("failed");
    expect(failed.textContent).toContain("The account service answered 502.");
    expect($("[data-start-fresh-step=ai]")?.dataset.status).toBe("done");
    // no close button, Escape and the scrim do nothing
    expect($("[aria-label=Close]")).toBeNull();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    act(() => { $("[data-modal-scrim]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { $<HTMLButtonElement>("[data-start-fresh-retry]")!.click(); });
    await settle();
    expect(bridge.retry).toHaveBeenCalledOnce();
    expect($("[data-start-fresh-dialog]")?.getAttribute("data-start-fresh-dialog")).toBe("done");
    await act(async () => { $<HTMLButtonElement>("[data-start-fresh-restart]")!.click(); });
    await settle();
    expect(bridge.finish).toHaveBeenCalledOnce();
  });

  it("shows each step's progress as main reports it", async () => {
    const bridge = fakeBridge();
    act(() => root.render(createElement(StartFreshDialog, { bridge: bridge as never, onClose: vi.fn() })));
    await settle();
    act(() => bridge.emit({ phase: "running", steps: pending.steps.map((step, index) => ({ ...step, status: index === 0 ? "done" : index === 1 ? "running" : "pending" })) }));
    expect($("[data-start-fresh-dialog]")?.getAttribute("data-start-fresh-dialog")).toBe("running");
    expect($("[data-start-fresh-step=ai]")?.dataset.status).toBe("running");
    expect($("[data-start-fresh-step=signout]")?.textContent).toContain("Sign out of tester@qa.dusk.test");
  });

  it("closes from Cancel before anything is deleted", async () => {
    const onClose = vi.fn();
    act(() => root.render(createElement(StartFreshDialog, { bridge: fakeBridge() as never, onClose })));
    await settle();
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!.click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
