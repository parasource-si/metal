// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  return { dispatch: vi.fn(), bots: [] as Bot[], instances: [] as InstanceInfo[], localMessage: "" };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: {}, instances: fixture.instances, bots: fixture.bots }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ ready: true, capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" },
    localComputer: fixture.localMessage ? { available: false, message: fixture.localMessage } : { available: true } } }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { ScreenAccessNotice, noteScreenAccessAsked } = await import("./ScreenAccessNotice");
const ask = async (threadId: string, at?: number) => { await act(async () => noteScreenAccessAsked(threadId, at)); };
const { FailedReplyCard } = await import("./FailedReplyCard");
const { trailingRows } = await import("@/lib/failed-reply");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MISSING = "Screen Recording required for CuaDriver; turn on CuaDriver in System Settings > Privacy & Security";
const status = vi.fn(async () => ({ supported: true as const, accessibility: "granted" as const, screen: "missing" as const }));
const retry = vi.fn(async () => ({}));
const onMac: Bot = { id: "dusk", name: "Metal", computer: "local", modelSelection: { instanceId: "claude", model: "sonnet" } } as Bot;
fixture.bots = [onMac];
fixture.instances = [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available", authenticated: true } } as InstanceInfo];

let root: ReturnType<typeof createRoot> | null = null;
const render = async (element: ReturnType<typeof createElement>) => {
  document.body.innerHTML = "";
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(element); });
};
const actions = () => [...document.querySelectorAll<HTMLButtonElement>("[data-chat-error] button:not([aria-label])")].map((b) => b.textContent);

beforeEach(() => {
  fixture.localMessage = MISSING;
  (window as unknown as { duskDesktop: unknown }).duskDesktop = {
    platform: "darwin", macPermissions: { status, request: status }, localControl: { retry },
  };
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

describe("screen access for a bot on this Mac", () => {
  it("shows nothing on a plain turn, only once the bot asks for screen control here", async () => {
    await render(createElement(ScreenAccessNotice, { bot: { ...onMac, threadId: "plain" } }));
    expect(document.querySelector("[data-screen-access]")).toBeNull();
    await ask("other-thread");
    expect(document.querySelector("[data-screen-access]")).toBeNull();
    await ask("plain");
    expect(document.querySelector("[data-screen-access]")).not.toBeNull();
  });

  it("says it plainly with one Allow access that opens the permissions modal, and a close", async () => {
    await render(createElement(ScreenAccessNotice, { bot: { ...onMac, threadId: "modal" } }));
    await ask("modal");
    expect(document.body.textContent).toContain("Metal needs screen access to use this Mac");
    expect(document.body.textContent).not.toMatch(/CuaDriver|Open screen/);
    expect(actions()).toEqual(["Allow access"]);
    expect(document.querySelector("[data-chat-error] button[aria-label]")).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>("[data-screen-access-allow]")!.click());
    expect(document.querySelector("[data-mac-permissions-dialog]")).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>("[data-mac-permissions-done]")!.click());
    expect(document.querySelector("[data-mac-permissions-dialog]")).toBeNull();
    expect(retry).toHaveBeenCalled();
  });

  it("goes away as soon as access is on", async () => {
    await render(createElement(ScreenAccessNotice, { bot: { ...onMac, threadId: "granted" } }));
    await ask("granted");
    expect(document.querySelector("[data-screen-access]")).not.toBeNull();
    fixture.localMessage = "";
    await render(createElement(ScreenAccessNotice, { bot: { ...onMac, threadId: "granted" } }));
    expect(document.querySelector("[data-screen-access]")).toBeNull();
  });

  it("closed, it stays closed until the bot asks again", async () => {
    await render(createElement(ScreenAccessNotice, { bot: { ...onMac, threadId: "closer" } }));
    await ask("closer", 1);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-chat-error] button[aria-label]")!.click());
    expect(document.querySelector("[data-screen-access]")).toBeNull();
    await ask("closer", 2);
    expect(document.querySelector("[data-screen-access]")).not.toBeNull();
  });

  it("a turn lost to screen access before the fix shows the same card, not Open screen", async () => {
    const at = Date.now();
    const ask: Message = { id: "ask", role: "user", kind: "text", at, text: "hi" };
    const failed: Message = { id: "failed", role: "bot", kind: "activity", at: at + 1, tool: {
      name: "error: Metal can't use this computer yet: Screen Recording required.", ok: false,
      place: { state: "place-failed", source: "works-on", params: { bot: "Metal", cause: "Metal can't use this computer yet: Screen Recording required. Turn on CuaDriver in System Settings > Privacy & Security > Screen Recording; Metal notices by itself, no restart needed." } },
    } } as Message;
    await render(createElement(FailedReplyCard, { rows: trailingRows([ask, failed]), botId: "dusk", threadId: "main" }));
    expect(document.body.textContent).toContain("Metal needs screen access to use this Mac");
    expect(actions()).toEqual(["Allow access"]);
  });
});
