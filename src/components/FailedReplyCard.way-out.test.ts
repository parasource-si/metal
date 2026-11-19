// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  return { dispatch: vi.fn(), bots: [] as Bot[], instances: [] as InstanceInfo[] };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: {}, instances: fixture.instances, bots: fixture.bots }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { FailedReplyCard } = await import("./FailedReplyCard");
const { trailingRows } = await import("@/lib/failed-reply");

// failures older than a day leave the card, so these rows are recent
const T0 = Date.now();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

fixture.instances = [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available", authenticated: true } } as InstanceInfo];
fixture.bots = [{ id: "echo", name: "Echo", modelSelection: { instanceId: "claude", model: "sonnet" } } as Bot];

const ask: Message = { id: "ask", role: "user", kind: "text", at: T0 + 1, text: "hi" };
let seq = 0;
const failed = (cause: string, patch: Partial<NonNullable<Message["tool"]>> = {}): Message => ({
  id: `failed-${++seq}`, role: "bot", kind: "activity", at: T0 + 2, tool: { name: `error: ${cause}`, ok: false, ...patch },
});

let root: ReturnType<typeof createRoot> | null = null;
const show = async (message: Message, onRetry?: () => void) => {
  document.body.innerHTML = "";
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(createElement(FailedReplyCard, { rows: trailingRows([ask, message]), botId: "echo", threadId: "main", onRetry })); });
  return [...document.querySelectorAll<HTMLButtonElement>("[data-chat-error] button:not([aria-label])")];
};
const labels = (buttons: HTMLButtonElement[]) => buttons.map((button) => button.textContent);

beforeEach(() => fixture.dispatch.mockClear());
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

describe("a failure card always offers a way on", () => {
  it("out of credits: Switch AI, which opens the bot's AI settings", async () => {
    const buttons = await show(failed("Your credit balance is too low: insufficient credits"), vi.fn());
    expect(labels(buttons)).toEqual(["Switch AI"]);
    await act(async () => buttons[0]!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleSettings", open: true, section: "model", botId: "echo" }));
  });

  it("a folder that was moved or deleted: Working folder, which opens the bot's folder setting", async () => {
    const buttons = await show(failed("This bot's folder client-site was moved or deleted. Pick a folder in the bot's settings."), vi.fn());
    expect(labels(buttons)).toEqual(["Working folder", "Try again"]);
    await act(async () => buttons[0]!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleSettings", open: true, section: "access", botId: "echo" }));
  });

  it("a usage limit with no known reset: switch AI", async () => {
    expect(labels(await show(failed("You've hit your usage limit")))).toEqual(["Switch AI"]);
  });

  it("a usage limit with a known reset keeps its continue action", async () => {
    const buttons = labels(await show(failed("You've hit your usage limit", { limitResetsAt: Date.now() + 3_600_000 })));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).not.toBe("Switch AI");
  });

  it("a failure nothing can retry: Switch AI instead of nothing", async () => {
    expect(labels(await show(failed("API Error: 529 Overloaded")))).toEqual(["Switch AI"]);
  });

  it("a failure that can be retried keeps Try again alone", async () => {
    expect(labels(await show(failed("API Error: 529 Overloaded"), vi.fn()))).toEqual(["Try again"]);
  });
});

describe("the card says what really stopped the reply", () => {
  const text = () => document.querySelector("[data-chat-error]")?.textContent ?? "";

  it("a plain server cause is said as it is, not as Something went wrong", async () => {
    await show(failed("The workspace was restored from a backup before this finished."), vi.fn());
    expect(text()).toContain("The workspace was restored from a backup before this finished.");
    expect(text()).not.toContain("Something went wrong");
  });

  it("a turn a restart cut says so, and Try again warns before it can repeat what already ran", async () => {
    const onRetry = vi.fn();
    const buttons = await show(failed("Interrupted by another Metal restart after resuming once; not resumed again. Some of its steps may already have taken effect."), onRetry);
    expect(text()).toContain("Metal restarted while this was running");
    expect(labels(buttons)).toEqual(["Try again"]);
    await act(async () => buttons[0]!.click());
    expect(onRetry).not.toHaveBeenCalled();
    expect(text()).toContain("could happen twice");
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("[data-chat-error] button:not([aria-label])")];
    expect(labels(confirm)).toEqual(["Try again anyway", "Don't retry"]);
    await act(async () => confirm[0]!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("names what a cut turn had already done outside", async () => {
    await show(failed("Interrupted by a Metal restart after it already sent an email (gmail_send); not resumed, so nothing is done twice."), vi.fn());
    expect(text()).toContain("Already done: sent an email (gmail_send)");
  });
});

describe("a notice that asks for an AI", () => {
  it("is the card above the composer, short, with Sign in that opens the connect flow", async () => {
    const notice: Message = { id: "paused", role: "bot", kind: "activity", at: T0 + 2, tool: { name: "notice: Routines are paused. Sign in to your AI to turn them back on.", ok: true, signIn: true } };
    const buttons = await show(notice);
    expect(document.querySelector("[data-chat-error]")!.textContent).toContain("Routines are paused. Sign in to your AI to turn them back on.");
    expect(labels(buttons)).toEqual(["Sign in"]);
    await act(async () => { buttons[0]!.click(); });
    expect(fixture.dispatch, "the connect flow, not Settings").not.toHaveBeenCalled();
    expect(document.querySelector("[role='dialog']"), "the connect flow").not.toBeNull();
  });
});
