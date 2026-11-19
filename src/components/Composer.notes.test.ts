// @vitest-environment happy-dom
// Notes from another AI pasted or dropped into a chat: nothing about bringing them in is said inside the message box.
// The card above it says they came; the first bot's chat says the rest.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { notesArrival, resetNotesArrivalForTests } from "@/lib/notes-arrival";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  agentsMcp: true,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  liveCall: null as unknown,
  config: undefined as unknown,
  api: vi.fn(async () => ({})),
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, selectedId: "atlas", config: fixture.config ?? original.initialState.config, bots: [bot, { ...peer, defaultBot: {} }], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }), api: fixture.api };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };
const NOTES = "---\nformat: dusk-bot-notes\nversion: 3\nfrom: ChatGPT\n---\n\n# Memories\n- Likes tea\n\nEND OF METAL NOTES\n";

let root: Root;
let container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  setLocale("en");
  resetNotesArrivalForTests();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("notes pasted into a chat", () => {
  it("never say anything inside the message box: the card above says they came, and the box stays empty", async () => {
    flushSync(() => root.render(createElement(Composer, { bot })));
    const box = container.querySelector("textarea")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? NOTES : ""), files: [], items: [], types: ["text/plain"] } });
    flushSync(() => box.dispatchEvent(paste));
    await settle();
    expect(paste.defaultPrevented, "the notes are taken, never typed or sent").toBe(true);
    expect(box.value).toBe("");
    expect(notesArrival()).toMatchObject({ via: "paste", botId: "atlas" });
    const card = container.querySelector("[data-notes-arrived]");
    expect(card?.textContent).toBe("Got your pasted notes. Bringing everything in…");
    expect(card?.contains(box), "the card sits above the message box, not in it").toBe(false);
    const rest = (container.textContent ?? "").replace(card?.textContent ?? "", "");
    expect(rest, "no import words inside the message box").not.toMatch(/bringing|brought|notes/i);
    expect([...container.querySelectorAll("[role=status]")].filter((node) => node !== card && node.textContent), "no status line in the box").toEqual([]);
    // Atlas is not the first bot: it is the chat the notes went into, so it is the one that says it got them
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/atlas/import-note", expect.objectContaining({ body: JSON.stringify({ from: ["ChatGPT"], start: true }) }));
    expect(fixture.api).not.toHaveBeenCalledWith("/api/bots/juniper/import-note", expect.anything());
  });
});
