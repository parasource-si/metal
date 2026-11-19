// @vitest-environment happy-dom
import { createElement, Fragment, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/components/Avatar", () => ({
  MausAvatar: (props: { state?: string }) => createElement("span", { "data-mascot": props.state ?? "idle" }),
  BotAvatar: () => createElement("span", { "data-bot-avatar": "" }),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: [], config: {} }, dispatch: vi.fn() }),
}));
import { closeAddVps, openAddVps, EMPTY_VIEW, useAddVpsOpen, useVpsLink, VPS_STEP_IDS, type VpsEngine, type VpsLinkBridge, type VpsLinkView, type VpsMovePreview, type VpsSignIn } from "@/lib/vps-link";
import { AddVpsFlow } from "./AddVpsFlow";
import { MoveScreen, retryClock } from "./MoveStage";
import { TransferSettings } from "./TransferSettings";
import { SignInScreen } from "./SignInStage";
import { InstallScreen } from "./CommandStage";

const COMMAND = "curl -fsSL https://link.dusk.bot/i/ab3d7fgh2k-q4mxw7e2r5t6y7u8i9o2p3a4s5 | sh";
const SERVER = { id: "vps-1", name: "My VPS", origin: "http://vps-ab3d7fgh2k.localhost:47811" };
const steps = (done: number, failed?: { at: number; log: string }) => VPS_STEP_IDS.map((id, index) => ({
  id, status: index < done ? "done" as const : failed && index === failed.at ? "failed" as const : "waiting" as const,
  ...(failed && index === failed.at ? { log: failed.log } : {}),
}));

/** A fake main: the relay's states arrive through onChange as the real one sends them. */
function fakeBridge() {
  let view: VpsLinkView = EMPTY_VIEW;
  const listeners = new Set<(view: VpsLinkView) => void>();
  const bridge = {
    state: vi.fn(async (): Promise<VpsLinkView> => view),
    start: vi.fn(async () => (view = { ...EMPTY_VIEW, stage: "command", command: COMMAND, expiresAt: Date.now() + 25 * 60_000 })),
    cancel: vi.fn(async () => (view = EMPTY_VIEW)),
    reset: vi.fn(async () => (view = EMPTY_VIEW)),
    engines: vi.fn(async (): Promise<VpsEngine[]> => [
      { instanceId: "claude", kind: "claude" as const, name: "Claude Code", signedIn: false },
      { instanceId: "codex", kind: "codex" as const, name: "Codex", signedIn: false },
    ]),
    // claude setup-token on this computer opens the browser itself; a later answer falls back to the server's own page
    signIn: vi.fn(async (): Promise<VpsSignIn> => ({ flowId: "f1", phase: "waiting", authorizationUrl: null, needsCode: false, message: "Your browser opened. Approve there." })),
    signInStatus: vi.fn(async (): Promise<VpsSignIn> => ({ flowId: "f1", phase: "waiting", authorizationUrl: "https://claude.ai/oauth", needsCode: true })),
    signInCode: vi.fn(async () => ({ ok: true as const })),
    signInCancel: vi.fn(async () => ({ ok: true as const })),
    openUrl: vi.fn(async () => {}),
    preview: vi.fn(async (): Promise<VpsMovePreview> => ({ bots: [{ id: "b1", name: "Pixel" }, { id: "b2", name: "Scout" }], chats: 14, messages: 420, skills: 3, memories: 12, routines: 2, apps: 1, bytes: 52_428_800 })),
    move: vi.fn(async (): Promise<VpsLinkView> => (view = { ...view, stage: "moving", move: { step: "copy", status: "running", chats: { done: 3, total: 14 } } })),
    retryMove: vi.fn(async () => view),
    open: vi.fn(async () => {}),
    where: vi.fn(async () => ({ place: "vps" as const, server: SERVER })),
    backups: vi.fn(async () => [{ id: "k1", at: Date.UTC(2026, 10, 7, 9), bytes: 1_048_576, reason: "before-move" as const, summary: { bots: 2, chats: 14, skills: 3, routines: 2 } }]),
    backupNow: vi.fn(async () => ({ id: "k2" })),
    restore: vi.fn(async () => ({ ok: true as const, restart: true as const })),
    moveBack: vi.fn(async () => ({ ok: true as const })),
    forget: vi.fn(async () => (view = EMPTY_VIEW)),
    onChange: vi.fn((callback: (view: VpsLinkView) => void) => { listeners.add(callback); return () => listeners.delete(callback); }),
  } satisfies VpsLinkBridge;
  const emit = async (next: VpsLinkView) => { view = next; await act(async () => { for (const listen of listeners) listen(next); }); await settle(); };
  return { bridge, emit, view: () => view };
}

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); closeAddVps(); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const text = () => document.body.textContent ?? "";
const button = (label: string) => {
  const all = [...document.querySelectorAll("button")];
  return all.find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label) ?? all.find((item) => item.textContent?.trim().startsWith(label));
};
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); await settle(); };
/** The stage the sheet shows once its slide between screens has finished. */
const stageShown = async (stage: number) => {
  for (let i = 0; i < 60 && document.querySelector("[data-vps-stage]")?.getAttribute("data-vps-stage") !== String(stage); i++) await settle();
  expect(document.querySelector("[data-vps-stage]")?.getAttribute("data-vps-stage")).toBe(String(stage));
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};

function StateProbe() {
  const { view } = useVpsLink();
  return createElement("span", { "data-fixture-vps-state": view.stage });
}

describe("add your VPS", () => {
  it("shares one state read and subscription through the app's strict-mode mount probe", async () => {
    const fake = fakeBridge();
    fake.bridge.state.mockResolvedValue({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(StrictMode, null, createElement(StateProbe))); });
    await settle();
    expect(fake.bridge.state).toHaveBeenCalledTimes(1);
    expect(fake.bridge.onChange).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-fixture-vps-state]")?.getAttribute("data-fixture-vps-state")).toBe("linked");
  });

  it("keeps one live subscription while setup reopens the same journey", async () => {
    const fake = fakeBridge();
    fake.bridge.state.mockResolvedValue({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    function Host() {
      const open = useAddVpsOpen();
      return createElement(Fragment, null, createElement(StateProbe), open && createElement(AddVpsFlow, { onClose: closeAddVps }));
    }
    await act(async () => { root.render(createElement(Host)); });
    await settle();
    await act(async () => { openAddVps(); }); await settle();
    await click(button("Skip for now"));
    expect(document.querySelector("[data-vps-screen]")?.getAttribute("data-vps-screen")).toBe("preview");
    await click(button("Close"));
    expect(document.querySelector("[data-vps-screen]")).toBeNull();
    await act(async () => { openAddVps(); }); await settle();
    expect(document.querySelector("[data-vps-screen]")?.getAttribute("data-vps-screen")).toBe("preview");
    expect(fake.bridge.state).toHaveBeenCalledTimes(1);
    expect(fake.bridge.onChange).toHaveBeenCalledTimes(1);
    expect(fake.bridge.engines).toHaveBeenCalledTimes(1);
    expect(fake.bridge.start).not.toHaveBeenCalled();
    expect(fake.bridge.cancel).not.toHaveBeenCalled();
  });



  it("reads the initial state once and keeps progress that arrives before that snapshot", async () => {
    const fake = fakeBridge();
    let snapshot!: (view: VpsLinkView) => void;
    fake.bridge.state.mockImplementation(() => new Promise((resolve) => { snapshot = resolve; }));
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    expect(fake.bridge.state).toHaveBeenCalledTimes(1);
    await fake.emit({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    await act(async () => { snapshot(EMPTY_VIEW); });
    await settle();
    expect(document.querySelector("[data-vps-stage]")?.getAttribute("data-vps-stage")).toBe("3");
    expect(fake.bridge.start).not.toHaveBeenCalled();
  });

  it("counts the move during sign-in and shares that request with the move screen", async () => {
    const fake = fakeBridge();
    fake.bridge.state.mockResolvedValue({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    let finish!: (value: Awaited<ReturnType<VpsLinkBridge["preview"]>>) => void;
    fake.bridge.preview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    await settle();
    expect(document.querySelector("[data-vps-screen]")?.getAttribute("data-vps-screen")).toBe("signin");
    expect(fake.bridge.preview).toHaveBeenCalledTimes(1);
    await click(button("Skip for now"));
    expect(fake.bridge.preview).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ bots: [], chats: 7, messages: 20, skills: 1, memories: 0, routines: 0, apps: 0, bytes: 1024 }); });
    expect(text()).toContain("7Chats");
    expect(button("Move everything here")?.disabled).toBe(false);
  });

  it("refreshes a preview after a long sign-in before enabling the move", async () => {
    const fake = fakeBridge();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    fake.bridge.state.mockResolvedValue({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    await settle();
    expect(fake.bridge.preview).toHaveBeenCalledTimes(1);
    let finish!: (value: Awaited<ReturnType<VpsLinkBridge["preview"]>>) => void;
    fake.bridge.preview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    clock.mockReturnValue(now + 6000);
    await click(button("Skip for now"));
    expect(fake.bridge.preview).toHaveBeenCalledTimes(2);
    expect(button("Move everything here")?.disabled).toBe(true);
    await act(async () => { finish({ bots: [], chats: 15, messages: 20, skills: 1, memories: 0, routines: 0, apps: 0, bytes: 1024 }); });
    expect(text()).toContain("15Chats");
    expect(button("Move everything here")?.disabled).toBe(false);
  });

  it("ignores the previous server's preview after the linked server changes", async () => {
    const fake = fakeBridge();
    fake.bridge.state.mockResolvedValue({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    let oldPreview!: (value: Awaited<ReturnType<VpsLinkBridge["preview"]>>) => void;
    fake.bridge.preview.mockImplementationOnce(() => new Promise((resolve) => { oldPreview = resolve; }));
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    await settle();
    await fake.emit({ ...EMPTY_VIEW, stage: "linked", server: { id: "vps-2", name: "New VPS", origin: "http://vps-2.localhost:47811" } });
    expect(fake.bridge.preview).toHaveBeenCalledTimes(2);
    await act(async () => { oldPreview({ bots: [], chats: 999, messages: 999, skills: 0, memories: 0, routines: 0, apps: 0, bytes: 0 }); });
    await click(button("Skip for now"));
    expect(text()).toContain("Move everything to New VPS");
    expect(text()).toContain("14Chats");
    expect(text()).not.toContain("999Chats");
  });

  it("keeps a reopened flow independent of the closed flow's pending preview", async () => {
    const first = fakeBridge();
    first.bridge.state.mockResolvedValue({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    let finishOld!: (value: Awaited<ReturnType<VpsLinkBridge["preview"]>>) => void;
    first.bridge.preview.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: first.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    await settle();
    await act(async () => { root.render(null); });
    const second = fakeBridge();
    second.bridge.state.mockResolvedValue({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: second.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    await settle();
    await act(async () => { finishOld({ bots: [], chats: 999, messages: 999, skills: 0, memories: 0, routines: 0, apps: 0, bytes: 0 }); });
    await click(button("Skip for now"));
    expect(second.bridge.preview).toHaveBeenCalledTimes(1);
    expect(text()).toContain("14Chats");
    expect(text()).not.toContain("999Chats");
  });

  it("keeps the completed move when an older move response arrives after its progress event", async () => {
    const fake = fakeBridge();
    fake.bridge.state.mockResolvedValue({ ...EMPTY_VIEW, stage: "linked", server: SERVER });
    let finish!: (view: VpsLinkView) => void;
    fake.bridge.move.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    await settle();
    await click(button("Skip for now"));
    await click(button("Move everything here"));
    await fake.emit({ ...EMPTY_VIEW, stage: "moved", server: SERVER, move: { step: "done", status: "done" } });
    await act(async () => { finish({ ...EMPTY_VIEW, stage: "moving", server: SERVER, move: { step: "copy", status: "running" } }); });
    expect(document.querySelector("[data-vps-screen]")?.getAttribute("data-vps-screen")).toBe("moved");
  });

  it("goes from the one line to paste, through the install and a failed step, sign-in and the move, to done", async () => {
    const fake = fakeBridge();
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    await settle();

    // 1: a fresh window asks main for a line once and shows it in one pill, with no stepper
    await stageShown(1);
    expect(fake.bridge.start).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-vps-command]")?.textContent).toBe(COMMAND);
    expect(text()).toContain("Paste one line on your server");
    expect(text()).toContain("Open your server's terminal");
    expect(text()).not.toContain("Sign in");
    expect(document.querySelector("[data-vps-scene]")?.getAttribute("data-vps-scene")).toBe("waiting");

    // 2: the steps arrive in the live mirror; a failed one says so in words, shows its log tail and the same line again
    await fake.emit({ ...fake.view(), stage: "installing", steps: steps(1, { at: 1, log: "E: Unable to locate package curl" }) });
    await stageShown(2);
    expect(document.querySelectorAll("[data-vps-term] [data-vps-line]").length).toBeLessThanOrEqual(6);
    expect(document.querySelector("[data-vps-term]")?.textContent).not.toContain("[ok]");
    expect(text()).toContain("Something got stuck");
    expect(document.querySelector("[data-vps-term]")?.textContent).toContain("Unable to locate package curl");
    expect(document.querySelectorAll("[data-vps-command]").length).toBe(1);
    expect(text()).toContain("Getting the basics didn't work");
    expect(document.querySelector("[data-vps-scene]")?.getAttribute("data-vps-scene")).toBe("stuck");
    expect(button("Copy log")).toBeTruthy();

    // 3: linked while watching: a small cheer first, then sign in to the AI on this Mac; a pasted code goes back through main
    await fake.emit({ ...fake.view(), stage: "linked", steps: steps(VPS_STEP_IDS.length), server: SERVER });
    await stageShown(3);
    expect(text()).toContain("Connected!");
    expect(document.querySelector("[data-vps-scene]")?.getAttribute("data-vps-scene")).toBe("linked");
    await click(button("Sign in to your AI"));
    expect(document.querySelector("[data-vps-screen]")?.getAttribute("data-vps-screen")).toBe("signin");
    expect(text()).toContain("Sign in to your AI");
    expect(text()).toContain("on this Mac");
    expect(text()).toContain("My VPS");
    await click(document.querySelector("[data-vps-engine='claude'] button"));
    expect(fake.bridge.signIn).toHaveBeenCalledWith("claude");
    expect(text()).toContain("Your browser opened. Approve there.");
    expect(fake.bridge.openUrl).not.toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
    await settle();
    expect(fake.bridge.signInStatus).toHaveBeenCalledWith("claude", "f1");
    expect(fake.bridge.openUrl).toHaveBeenCalledWith("https://claude.ai/oauth");
    expect(text()).toContain("Paste the code from the page");
    await click(button("Skip for now"));

    // 4: what moves, then the bots travelling with the current step, then done
    await stageShown(4);
    expect(text()).toContain("Move everything to My VPS");
    expect(text()).toContain("Pixel");
    expect(text()).toContain("14Chats");
    expect(text()).not.toContain("Messages");
    expect(text()).toContain("50 MB");
    await click(button("Move everything here"));
    expect(fake.bridge.move).toHaveBeenCalledTimes(1);
    await settle();
    expect(text()).toContain("Copying your bots");
    expect(text()).toContain("3 of 14 chats");
    expect(document.querySelector("[data-vps-scene]")?.getAttribute("data-vps-scene")).toBe("moving");
    expect(document.querySelector("[data-vps-traveler]")?.getAttribute("data-vps-traveler")).toBe("b1");
    await fake.emit({ ...fake.view(), move: { step: "verify", status: "failed", error: "Two chats did not arrive." } });
    expect(text()).toContain("Two chats did not arrive.");
    expect(text()).toContain("Nothing was removed from this Mac");
    await fake.emit({ ...fake.view(), stage: "moved", move: { step: "done", status: "done", kept: true } });
    expect(text()).toContain("All moved!");
    expect(text()).toContain("A backup stays on this Mac");
    expect(text()).toContain("this Mac kept its copy too");
    await click(button("Open My VPS"));
    expect(fake.bridge.open).toHaveBeenCalledTimes(1);
  });

  it("picks up an install already under way instead of making a new line", async () => {
    const fake = fakeBridge();
    await fake.bridge.start();
    fake.bridge.start.mockClear();
    await fake.emit({ ...fake.view(), stage: "installing", steps: steps(4) });
    vi.stubGlobal("duskDesktop", { platform: "linux", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(AddVpsFlow, { onClose: () => {} })); });
    await stageShown(2);
    expect(fake.bridge.start).not.toHaveBeenCalled();
    expect(text()).toContain("Installing Node");
  });
});

describe("VPS AI sign-in recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("continues polling after a transient failure and stops once signed in", async () => {
    const fake = fakeBridge();
    fake.bridge.signInStatus.mockRejectedValueOnce(new Error("The server is reconnecting."));
    fake.bridge.signInStatus.mockResolvedValue({ flowId: "f1", phase: "succeeded", authorizationUrl: null, needsCode: false });
    await act(async () => { root.render(createElement(SignInScreen, { bridge: fake.bridge, server: SERVER, autoSkip: false, onDone: () => {} })); });
    await act(async () => { (document.querySelector("[data-vps-engine='claude'] button") as HTMLButtonElement).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(text()).toContain("The server is reconnecting.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fake.bridge.signInStatus).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-vps-engine='claude']")?.hasAttribute("data-signed-in")).toBe(true);
    expect(text()).not.toContain("The server is reconnecting.");
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(fake.bridge.signInStatus).toHaveBeenCalledTimes(2);
  });

  it("does not reopen the browser for a poll that finishes after the sign-in screen closes", async () => {
    const fake = fakeBridge();
    let finish!: (value: Awaited<ReturnType<VpsLinkBridge["signInStatus"]>>) => void;
    fake.bridge.signInStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { root.render(createElement(SignInScreen, { bridge: fake.bridge, server: SERVER, autoSkip: false, onDone: () => {} })); });
    await act(async () => { (document.querySelector("[data-vps-engine='claude'] button") as HTMLButtonElement).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { root.render(null); });
    await act(async () => { finish({ flowId: "f1", phase: "waiting", authorizationUrl: "https://claude.ai/oauth", needsCode: false }); });
    expect(fake.bridge.openUrl).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(fake.bridge.signInStatus).toHaveBeenCalledTimes(1);
  });

  it("ignores a replaced server's engine list and does not auto-skip a closed screen", async () => {
    const fake = fakeBridge();
    let finish!: (value: Awaited<ReturnType<VpsLinkBridge["engines"]>>) => void;
    fake.bridge.engines.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const done = vi.fn();
    await act(async () => { root.render(createElement(SignInScreen, { bridge: fake.bridge, server: SERVER, autoSkip: true, onDone: done })); });
    await act(async () => { root.render(createElement(SignInScreen, { bridge: fake.bridge, server: { ...SERVER, id: "vps-2" }, autoSkip: true, onDone: done })); });
    await act(async () => { finish([{ instanceId: "claude", kind: "claude", name: "Claude", signedIn: true }]); });
    expect(fake.bridge.engines).toHaveBeenCalledTimes(2);
    expect(done).not.toHaveBeenCalled();
    expect(document.querySelectorAll("[data-vps-engine]")).toHaveLength(2);

    let finishClosed!: (value: Awaited<ReturnType<VpsLinkBridge["engines"]>>) => void;
    fake.bridge.engines.mockImplementationOnce(() => new Promise((resolve) => { finishClosed = resolve; }));
    await act(async () => { root.render(createElement(SignInScreen, { bridge: fake.bridge, server: { ...SERVER, id: "vps-3" }, autoSkip: true, onDone: done })); });
    await act(async () => { root.render(null); });
    await act(async () => { finishClosed([{ instanceId: "claude", kind: "claude", name: "Claude", signedIn: true }]); });
    expect(done).not.toHaveBeenCalled();
  });
});

describe("VPS install output", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows step-only progress without inventing commands or package output", async () => {
    const view: VpsLinkView = { ...EMPTY_VIEW, stage: "installing", steps: [{ id: "app", status: "running" }] };
    await act(async () => { root.render(createElement(InstallScreen, { view, onRetry: () => {} })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.querySelector("[data-vps-term]")?.textContent).toBe("Installing Metal · Working…");
    expect(text()).not.toContain("duskbot@latest");
    expect(text()).not.toContain("reading package lists");
  });

  it("shows the newest real terminal lines immediately and supports older command snapshots", async () => {
    const view: VpsLinkView = { ...EMPTY_VIEW, stage: "installing", steps: [{ id: "app", status: "running" }],
      terminal: Array.from({ length: 10 }, (_, index) => ({ step: "app", text: `verified package output ${index}` })) };
    await act(async () => { root.render(createElement(InstallScreen, { view, onRetry: () => {} })); });
    expect(document.querySelectorAll("[data-vps-line]")).toHaveLength(6);
    expect(document.querySelector("[data-vps-term]")?.textContent).toContain("verified package output 9");
    expect(document.querySelector("[data-vps-term]")?.textContent).not.toContain("verified package output 0");
    const older: VpsLinkView = { ...EMPTY_VIEW, stage: "installing", steps: [{ id: "app", status: "done", cmd: "install /tmp/verified-build", lines: ["SHA256 verified"] }] };
    await act(async () => { root.render(createElement(InstallScreen, { view: older, onRetry: () => {} })); });
    expect(document.querySelector("[data-vps-term]")?.textContent).toContain("$ install /tmp/verified-build");
    expect(document.querySelector("[data-vps-term]")?.textContent).toContain("SHA256 verified");
    expect(document.querySelector("[data-vps-term]")?.textContent).toContain("Installing Metal · Done");
  });

  // since e35ca4cf3 the install is one percentage of the whole, never bytes; the move keeps an indeterminate bar
  it("shows the install as one percentage, never bytes, and keeps the move's unknown progress indeterminate", async () => {
    const now = Date.now();
    const view: VpsLinkView = { ...EMPTY_VIEW, stage: "installing", steps: [{ id: "app", status: "running", progress: { kind: "download", receivedBytes: 20 } }], activity: { updatedAt: now, progressAt: now - 45_000 } };
    await act(async () => { root.render(createElement(InstallScreen, { view, onRetry: () => {} })); });
    expect(document.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("0");
    expect(document.querySelector("[role=progressbar]")?.getAttribute("aria-valuetext")).toBe("0%");
    expect(document.body.textContent).not.toContain("20 B");
    const moved = { ...EMPTY_VIEW, stage: "moving" as const, server: SERVER, activity: view.activity, move: { step: "backup" as const, status: "running" as const } };
    const fake = fakeBridge();
    await act(async () => { root.render(createElement(MoveScreen, { view: moved, preview: null, previewError: "", onReload: () => {}, bridge: fake.bridge, onMove: () => {}, onBack: () => {} })); });
    expect(document.querySelector("[role='progressbar']")?.hasAttribute("aria-valuenow")).toBe(false);
  });


});

describe("Settings > Transfer", () => {
  it("does not reread location and backup files for every installer log line", async () => {
    const fake = fakeBridge();
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(TransferSettings)); });
    await settle();
    for (let index = 0; index < 20; index++) {
      await fake.emit({ ...EMPTY_VIEW, stage: "installing", steps: [{ id: "app", status: "running", log: `Installing ${index}` }] });
    }
    expect(fake.bridge.where).toHaveBeenCalledTimes(2);
    expect(fake.bridge.backups).toHaveBeenCalledTimes(2);
    await fake.emit({ ...EMPTY_VIEW, stage: "moved", server: SERVER, move: { step: "done", status: "done", backupId: "before-move" } });
    expect(fake.bridge.where).toHaveBeenCalledTimes(3);
    expect(fake.bridge.backups).toHaveBeenCalledTimes(3);
  });

  it("says where the bots live, moves them back after a confirm and lists the backups", async () => {
    const fake = fakeBridge();
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge });
    await act(async () => { root.render(createElement(TransferSettings)); });
    await settle();
    expect(text()).toContain("My VPS");
    expect(text()).toContain("2 bots, 14 chats, 3 skills, 2 routines · 1.0 MB");
    expect(text()).toContain("Before a move");
    await click(button("Move to this Mac"));
    const ask = document.querySelector("[role=alertdialog]");
    expect(ask?.querySelector("h2")?.textContent).toBe("Bring your bots back to this Mac?");
    expect(ask?.textContent).toContain("A backup is saved first");
    expect(ask?.querySelector("[data-confirm-art] [data-place-art=direct]")).toBeTruthy();
    expect(fake.bridge.moveBack).not.toHaveBeenCalled();
    await click(button("Bring them back"));
    expect(fake.bridge.moveBack).toHaveBeenCalledTimes(1);
  });

  it("shows the line that takes Metal off the server, only when asked", async () => {
    const fake = fakeBridge();
    const UNINSTALL = "curl -fsSL https://link.dusk.bot/uninstall | sh";
    fake.bridge.where.mockImplementation(async () => ({ place: "vps" as const, server: SERVER, uninstall: UNINSTALL }));
    vi.stubGlobal("duskDesktop", { platform: "darwin", vpsLink: fake.bridge, confirm: vi.fn(async () => true) });
    await act(async () => { root.render(createElement(TransferSettings)); });
    await settle();
    expect(text()).not.toContain(UNINSTALL);
    const row = button("Remove from this server");
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    await click(row);
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-copy-row="uninstall"] code')?.textContent).toBe(UNINSTALL);
    expect(text()).toContain("Paste this on My VPS");
    expect(text()).toContain("Forget My VPS");
    expect(fake.bridge.forget).not.toHaveBeenCalled();
  });
});

describe("the move waiting to try again", () => {
  it("shows a copy error without a retry deadline and reports a failed manual retry", async () => {
    const fake = fakeBridge();
    fake.bridge.retryMove.mockRejectedValueOnce(new Error("The desktop connection is unavailable."));
    const view: VpsLinkView = { ...EMPTY_VIEW, stage: "moving", server: SERVER, move: { step: "copy", status: "running", error: "The destination stopped answering." } };
    await act(async () => { root.render(createElement(MoveScreen, { view, preview: null, previewError: "", onReload: () => {}, bridge: fake.bridge, onMove: () => {}, onBack: () => {} })); });
    expect(text()).toContain("The destination stopped answering.");
    await click(button("Try now"));
    expect(text()).toContain("The desktop connection is unavailable.");
  });

  it("says what went wrong and when it tries again, counting down, and Try now asks main to go again", async () => {
    const fake = fakeBridge();
    const view: VpsLinkView = { ...EMPTY_VIEW, stage: "moving", server: SERVER,
      move: { step: "copy", status: "running", chats: { done: 18, total: 18 }, error: "My VPS isn't answering yet.", retryAt: Date.now() + 222_000 } };
    await act(async () => { root.render(createElement(MoveScreen, { view, preview: null, previewError: "", onReload: () => {}, bridge: fake.bridge, onMove: () => {}, onBack: () => {} })); });
    await settle();
    expect(text()).toContain("Copying your bots");
    expect(text()).toContain("My VPS isn't answering yet.");
    expect(document.querySelector("[data-vps-retry]")?.textContent).toMatch(/^Trying again in 3:4[12]$/);
    expect(text()).not.toContain("Keep this app open");
    await click(button("Try now"));
    expect(fake.bridge.retryMove).toHaveBeenCalledTimes(1);

    await act(async () => { root.render(createElement(MoveScreen, { view: { ...view, move: { ...view.move!, retryAt: Date.now() - 1 } }, preview: null, previewError: "", onReload: () => {}, bridge: fake.bridge, onMove: () => {}, onBack: () => {} })); });
    expect(document.querySelector("[data-vps-retry]")?.textContent).toBe("Trying again…");
    await act(async () => { root.render(createElement(MoveScreen, { view: { ...view, move: { step: "copy", status: "running", chats: { done: 18, total: 18 } } }, preview: null, previewError: "", onReload: () => {}, bridge: fake.bridge, onMove: () => {}, onBack: () => {} })); });
    expect(document.querySelector("[data-vps-retry]")).toBeNull();
    expect(text()).toContain("Keep this app open");
  });

  it("reads the wait as minutes and seconds", () => {
    expect(retryClock(222_000)).toBe("3:42");
    expect(retryClock(9_100)).toBe("0:10");
    expect(retryClock(-5)).toBe("0:00");
    expect(retryClock(3_600_000)).toBe("60:00");
  });
});
