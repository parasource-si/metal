// @vitest-environment happy-dom
// The Room panel in a real DOM, where effects run and focus moves: each row's value and write, its pages and Escape.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, ConfigStatus, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), find: vi.fn(), api: vi.fn(), config: null as ConfigStatus | null }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: (...args: unknown[]) => fixture.api(...args),
    useStore: () => ({ state: { ...original.initialState, bots: fixtureBots, config: fixture.config } as AppState, dispatch: fixture.dispatch }),
  };
});
vi.mock("../DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../DesktopCapabilities")>(),
  useCaptionChrome: () => ({ dragProps: {}, padClass: "" }),
  useDesktopCapabilities: () => ({ capabilities: { host: { homeDir: "/Users/ada" } }, ready: true }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("../bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => ({}) }));
vi.mock("../bot-panel/ComputerTab", async () => {
  const { createElement: h } = await import("react");
  return { ComputerTab: ({ bot, cloudFor }: { bot: Bot; cloudFor?: readonly Bot[] }) => h("span", { "data-panel-screen-of": "", "data-cloud-for": cloudFor?.map((one) => one.name).join(",") }, `${bot.name}'s screen`) };
});
vi.mock("../native/ModelSelectRow", async () => {
  const { createElement: h } = await import("react");
  return { ModelSelectRow: ({ title }: { title?: string }) => h("span", { "data-model-row": "" }, title) };
});
vi.mock("../native/UsageMeter", () => ({ UsageMeterRow: () => null }));
vi.mock("@/lib/chat-find", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/chat-find")>(), requestChatFind: fixture.find }));

const bot = (id: string, name: string): Bot => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
});
const fixtureBots = [bot("lead", "Desk Manager"), bot("bench", "Vendor Bench"), bot("paper", "Paperwork"), bot("match", "Matcher")];

const { RoomPanel } = await import("./RoomPanel");
const { closeRoomPanel, openRoomPanel, useRoomPanel } = await import("@/lib/room-panel");

const room = (patch: Partial<Group> = {}): Group => ({
  id: "desk", threadId: "desk-thread", name: "Desk HQ", description: "The recruiting desk", memberIds: fixtureBots.map((b) => b.id),
  defaultResponder: { kind: "member", botId: "lead" }, bulletin: "Hand out the work here.\nKeep it short.",
  unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
  ...patch,
});
const jev = (enabled: boolean) => ({ rooms: { turnTimeoutMinutes: 5 }, decider: { provider: "jev", configured: enabled, enabled, jobs: { roomRouting: true } } } as ConfigStatus);

let host: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;
const seen = { open: null as string | null };
function Probe() {
  seen.open = useRoomPanel();
  return null;
}
const render = (group: Group) => flushSync(() => root.render([
  createElement(RoomPanel, { key: "panel", group }),
  createElement(Probe, { key: "probe" }),
]));
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T & HTMLElement>(selector);
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const press = (element: Element | null, key: string, init: KeyboardEventInit = {}) => {
  if (!element) throw new Error("nothing to press");
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  flushSync(() => element.dispatchEvent(event));
  return event;
};
const type = (field: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
};
const rowValue = (selector: string) => $(selector)?.querySelector("span.truncate")?.textContent ?? null;
const page = () => $("[data-panel-page-view]")?.getAttribute("data-panel-page-view") ?? null;
const patches = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "patchGroup");

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.config = jev(true);
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  opener = document.createElement("button");
  document.body.append(opener);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => openRoomPanel("desk", opener));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  opener.remove();
  closeRoomPanel();
  document.body.innerHTML = "";
});

// icon-font glyphs sit in the private use planes; read only the words
const words = (element: Element | null) => element?.textContent?.replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFD}]/gu, "") ?? null;
const modal = (name: string) => $(`[data-panel-modal="${name}"]`);

describe("the Room panel's card", () => {
  it("shows the room's faces and name, then who responds, the folder, the instructions and the members as plain rows", () => {
    render(room());
    expect($("#room-panel-title")?.textContent).toBe("Desk HQ");
    expect($("[data-room-panel]")?.textContent).toContain("The recruiting desk");
    expect(rowValue('[data-panel-page="responder"]')).toBe("Desk Manager");
    expect(rowValue('[data-panel-page="folder"]')).toBe("Its own folder");
    expect(rowValue('[data-panel-page="instructions"]')).toBeNull();
    expect(rowValue('[data-panel-row="members"]')).toBe("4");
    expect($('[data-room-panel] textarea, [data-room-panel] input')).toBeNull();
    expect($('[data-testid="room-more"]')).toBeNull();
  });

  it("names each way a room can answer, and the folder by its last part", () => {
    render(room({ defaultResponder: { kind: "auto", fallbackBotId: "lead" }, cwd: "/Users/ada/code/recruiting/" }));
    expect(rowValue('[data-panel-page="responder"]')).toBe("Jev decides");
    expect(rowValue('[data-panel-page="folder"]')).toBe("recruiting");
    render(room({ defaultResponder: { kind: "auto", fallbackBotId: "lead", by: "dusk" } }));
    expect(rowValue('[data-panel-page="responder"]')).toBe("Let Metal decide");
    render(room({ defaultResponder: { kind: "member", botId: "lead", leader: true } }));
    expect(rowValue('[data-panel-page="responder"]')).toBe("Desk Manager leads");
    render(room({ defaultResponder: { kind: "everyone" } }));
    expect(rowValue('[data-panel-page="responder"]')).toBe("Everyone at once");
    render(room({ defaultResponder: { kind: "mentions" }, bulletin: "" }));
    expect(rowValue('[data-panel-page="responder"]')).toBe("Only who I @mention");
    expect(rowValue('[data-panel-page="instructions"]')).toBe("None");
  });
});

describe("the tabs", () => {
  it("are the bot panel's Details, Computer and Advanced", () => {
    render(room());
    const tabs = [...document.querySelectorAll("[data-panel-tab]")].map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]);
    expect(tabs).toEqual([["Details", "true"], ["Computer", "false"], ["Advanced", "false"]]);
  });

  it("keep each bot's model one level down, with no room-wide picker", async () => {
    render(room());
    expect($("[data-room-panel] [data-model-row]")).toBeNull();
    click($('[data-panel-page="models"]'));
    await settle();
    expect(page()).toBe("models");
    expect($('[data-panel-page-view="models"] p')).toBeNull();
    expect([...document.querySelectorAll("[data-room-model]")].map((row) => row.textContent)).toEqual(["Desk Manager", "Vendor Bench", "Paperwork", "Matcher"]);
  });

  it("show each member's computer on Computer, one after another", () => {
    render(room());
    click($('[data-panel-tab="computer"]'));
    const screens = [...document.querySelectorAll("[data-room-screen]")].map((card) => card.querySelector("[data-panel-screen-of]")?.textContent);
    expect(screens).toEqual(["Desk Manager's screen", "Vendor Bench's screen", "Paperwork's screen", "Matcher's screen"]);
  });

  it("offer the move to the cloud once for the whole group, on the last member", () => {
    render(room());
    click($('[data-panel-tab="computer"]'));
    const cloudFor = [...document.querySelectorAll("[data-room-screen] [data-cloud-for]")].map((card) => card.getAttribute("data-cloud-for"));
    expect(cloudFor).toEqual(["", "", "", "Desk Manager,Vendor Bench,Paperwork,Matcher"]);
  });

  it("keep the turn limit and deleting the room on Advanced, deleting only once confirmed", () => {
    render(room());
    click($('[data-panel-tab="advanced"]'));
    expect($('[data-panel-row="turn-limit"]')).not.toBeNull();
    expect($('[data-panel-page="responder"]')).not.toBeNull();
    click($('[data-panel-row="find"]'));
    expect(fixture.find).toHaveBeenCalledWith("desk-thread");
    click($('[data-panel-row="delete"]'));
    expect(fixture.dispatch.mock.calls.some(([action]) => action.type === "deleteGroup")).toBe(false);
    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete group chat" && !button.hasAttribute("data-panel-row"));
    click(confirm ?? null);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "deleteGroup", groupId: "desk" });
  });
});

const { RoomAboutModal, RoomFolderModal, RoomInstructionsModal, RoomResponderModal } = await import("./RoomModals");
const { useBotTarget } = await import("@/lib/open-settings");
const target = { current: null as ReturnType<typeof useBotTarget> };
function TargetProbe() {
  target.current = useBotTarget();
  return null;
}
// a page of the room's settings, as Settings' Bots page draws it for this group chat
const renderPage = (element: ReturnType<typeof createElement>) => flushSync(() => root.render(element));

describe("the room's settings pages", () => {
  it("open Settings' Bots pane on this group chat, at the row's page", async () => {
    render(room());
    flushSync(() => root.render([createElement(RoomPanel, { key: "panel", group: room() }), createElement(TargetProbe, { key: "target" })]));
    for (const row of ["responder", "folder", "instructions"] as const) {
      fixture.dispatch.mockClear();
      click($(`[data-panel-page="${row}"]`));
      await settle();
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "bots" });
      expect(target.current).toMatchObject({ kind: "group", id: "desk", row });
    }
    click($('[data-panel-tab="advanced"]'));
    click($('[data-panel-page="about"]'));
    await settle();
    expect(target.current).toMatchObject({ kind: "group", id: "desk", row: "about" });
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  });
});

describe("Name and description", () => {
  it("are rows on their page, edited together in one small form", () => {
    renderPage(createElement(RoomAboutModal, { group: room(), onClose: vi.fn() }));
    expect(words(modal("about")!.querySelector('[data-sheet-row="name"]'))).toBe("NameDesk HQ");
    click(modal("about")!.querySelector('[data-sheet-row="name"]'));
    const form = modal("room-about-form")!;
    const [name, description] = [...form.querySelectorAll("input")];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Desk Two");
    flushSync(() => name!.dispatchEvent(new Event("input", { bubbles: true })));
    expect(description!.value).toBe("The recruiting desk");
    flushSync(() => form.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(patches()).toEqual([{ type: "patchGroup", groupId: "desk", patch: { name: "Desk Two", description: "The recruiting desk" } }]);
    expect(modal("room-about-form")).toBeNull();
    expect(modal("about")).not.toBeNull();
  });
});

describe("who responds", () => {
  it("offers a leader, everyone, Dusk deciding and Jev deciding, and who leads under the leader", () => {
    renderPage(createElement(RoomResponderModal, { group: room(), members: fixtureBots, onClose: vi.fn() }));
    expect(modal("responder")).not.toBeNull();
    const choices = [...modal("responder")!.querySelectorAll("[data-panel-choice]")].map((row) => [row.getAttribute("data-panel-choice"), words(row), row.getAttribute("aria-checked")]);
    expect(choices).toEqual([
      ["leader", "LeaderDesk Manager gets your message and hands out the work", "true"],
      ["everyone", "Everyone at onceEvery bot answers, side by side", "false"],
      ["dusk", "Let Metal decideA quick model of your AI picks who answers", "false"],
      ["auto", "Jev decidesPicks the right bot for each message", "false"],
      ["leader:lead", "Desk Manager", "true"],
      ["leader:bench", "Vendor Bench", "false"],
      ["leader:paper", "Paperwork", "false"],
      ["leader:match", "Matcher", "false"],
    ]);
    // one tab stop per group: the chosen row of each
    expect([...document.querySelectorAll('[role="radio"]')].map((row) => row.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1", "0", "-1", "-1", "-1"]);
    expect($('[data-sheet-group="jev"]')).toBeNull();
    // the fixture's room is from before leaders: picking its bot again makes it the leader
    click($('[data-panel-choice="leader"]'));
    click($('[data-panel-choice="dusk"]'));
    click($('[data-panel-choice="auto"]'));
    click($('[data-panel-choice="everyone"]'));
    click($('[data-panel-choice="leader:bench"]'));
    expect(patches()).toEqual([
      { type: "patchGroup", groupId: "desk", patch: { defaultResponder: { kind: "member", botId: "lead", leader: true } } },
      { type: "patchGroup", groupId: "desk", patch: { defaultResponder: { kind: "auto", fallbackBotId: "lead", by: "dusk" } } },
      { type: "patchGroup", groupId: "desk", patch: { defaultResponder: { kind: "auto", fallbackBotId: "lead" } } },
      { type: "patchGroup", groupId: "desk", patch: { defaultResponder: { kind: "everyone" } } },
      { type: "patchGroup", groupId: "desk", patch: { defaultResponder: { kind: "member", botId: "bench", leader: true } } },
    ]);
  });

  it("keeps Only who I @mention for a room already set that way, and hides who leads", () => {
    renderPage(createElement(RoomResponderModal, { group: room({ defaultResponder: { kind: "mentions" } }), members: fixtureBots, onClose: vi.fn() }));
    expect([...modal("responder")!.querySelectorAll("[data-panel-choice]")].map((row) => row.getAttribute("data-panel-choice")))
      .toEqual(["leader", "everyone", "dusk", "auto", "mentions"]);
  });

  it("moves and picks with the arrow keys, wrapping at the ends", () => {
    renderPage(createElement(RoomResponderModal, { group: room({ defaultResponder: { kind: "member", botId: "lead", leader: true } }), members: fixtureBots, onClose: vi.fn() }));
    const first = $('[data-panel-choice="leader:lead"]')!;
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement?.getAttribute("data-panel-choice")).toBe("leader:bench");
    press(document.activeElement, "ArrowUp");
    press(document.activeElement, "ArrowUp");
    expect(document.activeElement?.getAttribute("data-panel-choice")).toBe("leader:match");
    expect(patches().map((action) => action.patch.defaultResponder)).toEqual([
      // landing back on the leader changes nothing
      { kind: "member", botId: "bench", leader: true }, { kind: "member", botId: "match", leader: true },
    ]);
  });

  it("shows one quiet Jev row with Change once it is set up", () => {
    fixture.config = { ...jev(true), decider: { provider: "gateway", model: "typesafe-ai/jev", api: "decisions", configured: true, enabled: true, jobs: { roomRouting: true } } } as ConfigStatus;
    fixture.api.mockResolvedValue({ source: "gateway", models: [{ id: "typesafe-ai/jev", name: "Jev", group: "recommended", api: "decisions" }] });
    renderPage(createElement(RoomResponderModal, { group: room({ defaultResponder: { kind: "auto", fallbackBotId: "paper" } }), members: fixtureBots, onClose: vi.fn() }));
    expect(words($('[data-sheet-row="jev-ready"]'))).toBe("Jev: typesafe-ai/jev via Vercel AI GatewayChange");
    expect($('[data-sheet-row="jev-key"]')).toBeNull();
    click($('[data-jev-action="change"]'));
    expect($('[data-sheet-row="jev-key"]')).not.toBeNull();
    expect($('[data-jev-provider="gateway"]')?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Jev setup in Who responds", () => {
  const setInput = (field: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
  };
  const GATEWAY_MODELS = { source: "gateway", models: [
    { id: "typesafe-ai/jev", name: "Jev", group: "recommended", api: "decisions" },
    { id: "openai/gpt-5-nano", name: "GPT-5 nano", group: "more", api: "chat" },
  ] };

  beforeEach(() => {
    fixture.config = { rooms: { turnTimeoutMinutes: 5 }, decider: { provider: "jev", configured: false, enabled: false, jobs: { roomRouting: true } }, helpers: { own: { jev: false, workersAi: false, openrouter: false }, extraction: { ready: false } } } as unknown as ConfigStatus;
    fixture.api.mockReset();
    fixture.api.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path === "/api/decider/models?provider=gateway") return GATEWAY_MODELS;
      if (path === "/api/decider/models") return { source: "builtin", models: [{ id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", group: "recommended", api: "decisions" }] };
      if (path === "/api/decider/test") return JSON.parse(init!.body!).key === "bad" ? { ok: false, reason: "rejected", status: 401 } : { ok: true, latencyMs: 210 };
      if (path === "/api/config") return { ...fixture.config, decider: { provider: "gateway", model: "openai/gpt-5-nano", configured: true, enabled: true, jobs: { roomRouting: true } } };
      throw new Error(`unexpected ${path}`);
    });
  });

  const openAuto = () => renderPage(createElement(RoomResponderModal, { group: room({ defaultResponder: { kind: "auto", fallbackBotId: "lead" } }), members: fixtureBots, onClose: vi.fn() }));

  it("offers the three providers as pills, Vercel AI Gateway first, with a key field and Test", () => {
    openAuto();
    expect([...document.querySelectorAll("[data-jev-provider]")].map((pill) => [pill.textContent, pill.getAttribute("aria-pressed")]))
      .toEqual([["Vercel AI Gateway", "true"], ["OpenRouter", "false"], ["Jev", "false"]]);
    const field = $<HTMLInputElement>('[data-sheet-row="jev-key"] input')!;
    expect(field.type).toBe("password");
    expect(field.getAttribute("aria-label")).toBe("Vercel AI Gateway key");
    expect($<HTMLButtonElement>('[data-jev-action="test"]')!.disabled).toBe(true);
    expect($('[data-sheet-row="jev-model"]')).toBeNull();
    click($('[data-jev-provider="jev"]'));
    expect($('[data-sheet-row="jev-key"] input')?.getAttribute("aria-label")).toBe("Jev key");
  });

  it("says plainly when a key is refused, and shows no model picker", async () => {
    openAuto();
    setInput($<HTMLInputElement>('[data-sheet-row="jev-key"] input')!, "bad");
    click($('[data-jev-action="test"]'));
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/decider/test", { method: "POST", body: JSON.stringify({ provider: "gateway", key: "bad" }) });
    expect(words($('[data-sheet-group="jev"] [role="status"]'))).toBe("That key was refused. Check it and paste it again.");
    expect($('[data-sheet-row="jev-model"]')).toBeNull();
  });

  it("tests the key, lists the gateway's models with Custom model, and saves the key with the model picked", async () => {
    openAuto();
    setInput($<HTMLInputElement>('[data-sheet-row="jev-key"] input')!, "vck_unit_key");
    click($('[data-jev-action="test"]'));
    await settle();
    expect(words($('[data-sheet-group="jev"] [role="status"]'))).toBe("Works · 210 ms");
    const select = $('[data-settings-select="jev-model"]')!;
    expect(words(select)).toContain("Jev");
    click(select);
    const options = [...document.querySelectorAll('[role="option"]')].map((option) => words(option));
    expect(options).toEqual(["Jev", "GPT-5 nano", "Custom model"]);
    click([...document.querySelectorAll('[role="option"]')][1]!);
    click($('[data-jev-action="save"]'));
    await settle();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { provider: "gateway", gatewayModel: "openai/gpt-5-nano", gatewayApi: "chat", gatewayKey: "vck_unit_key" } }) });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "configStatus" }));
  });

  it("saves a custom OpenRouter model as a chat model, and only once it looks like vendor/model", async () => {
    openAuto();
    click($('[data-jev-provider="openrouter"]'));
    setInput($<HTMLInputElement>('[data-sheet-row="jev-key"] input')!, "sk-or-unit");
    click($('[data-jev-action="test"]'));
    await settle();
    click($('[data-settings-select="jev-model"]'));
    click([...document.querySelectorAll('[role="option"]')].at(-1)!);
    const custom = $<HTMLInputElement>('[data-sheet-row="jev-custom"] input')!;
    setInput(custom, "not a model");
    expect($<HTMLButtonElement>('[data-jev-action="save"]')!.disabled).toBe(true);
    setInput(custom, "mistral/ministral-3b");
    click($('[data-jev-action="save"]'));
    await settle();
    expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ decider: { provider: "openrouter", openrouterModel: "mistral/ministral-3b", openrouterApi: "chat", openrouterKey: "sk-or-unit" } }) });
  });
});

describe("working folder", () => {
  it("offers plain choices, with the lock line only once the folder is fixed", () => {
    renderPage(createElement(RoomFolderModal, { key: "a", group: room(), onClose: vi.fn() }));
    expect(modal("folder")).not.toBeNull();
    expect([...modal("folder")!.querySelectorAll("[data-panel-choice]")].map((row) => [row.getAttribute("data-panel-choice"), row.getAttribute("aria-checked")]))
      .toEqual([["own", "true"], ["pick", "false"]]);
    expect($("[data-folder-locked]")).toBeNull();
    expect(modal("folder")!.querySelector(".font-mono")).toBeNull();
    renderPage(createElement(RoomFolderModal, { key: "b", group: room({ cwd: "/Users/ada/code/recruiting", pinnedCwd: "/Users/ada/code/recruiting" }), onClose: vi.fn() }));
    expect($('[data-panel-choice="pick"]')?.textContent).toContain("~/code/recruiting");
    expect($('[data-panel-choice="pick"]')?.getAttribute("aria-checked")).toBe("true");
    expect($("[data-folder-locked]")?.textContent).toBe("Fixed for this group chat after its first turn.");
  });
});

describe("instructions", () => {
  const field = () => $<HTMLTextAreaElement>('[data-panel-modal="instructions"] textarea');

  it("keep the draft when the page closes, and save with Save", () => {
    renderPage(createElement(RoomInstructionsModal, { key: "a", group: room(), onClose: vi.fn() }));
    expect(field()?.value).toBe("Hand out the work here.\nKeep it short.");
    type(field()!, "Draft brief");
    renderPage(createElement("div", { key: "gone" }));
    expect(patches()).toEqual([]);
    renderPage(createElement(RoomInstructionsModal, { key: "b", group: room(), onClose: vi.fn() }));
    expect(field()?.value).toBe("Draft brief");
    click($('[data-panel-modal="instructions"] [data-modal-action="save"]'));
    expect(patches()).toEqual([{ type: "patchGroup", groupId: "desk", patch: { bulletin: "Draft brief" } }]);
  });
});

describe("members", () => {
  it("opens Manage members", () => {
    render(room());
    click($('[data-panel-row="members"]'));
    const dialog = $('[role="dialog"][data-panel-modal="members"]');
    expect(dialog?.querySelector("h2")?.textContent).toBe("Manage members");
    expect(dialog?.textContent).toContain("Desk HQ");
  });
});

describe("Escape", () => {
  it("leaves a page first, then closes the panel and hands focus back to the room's name", async () => {
    render(room());
    await settle();
    click($('[data-panel-page="models"]'));
    await settle();
    expect(document.activeElement?.hasAttribute("data-panel-back")).toBe(true);
    press(document.activeElement, "Escape");
    await settle();
    expect(page()).toBeNull();
    expect(seen.open).toBe("desk");
    expect(document.activeElement?.getAttribute("data-panel-page")).toBe("models");
    press(document.activeElement, "Escape");
    await settle();
    expect(seen.open).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the ✕ too", () => {
    render(room());
    click($('[data-room-panel] [aria-label="Close"]'));
    expect(seen.open).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
