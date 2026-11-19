import { afterEach, expect, test, vi } from "vitest";
import type { CommandView, ConnectFinishAnswer, WorkspaceDetail, WorkspaceSummary } from "../../../../shared/dashboard-protocol";
import { ANSWER_MS, appFlowsNow, FINISH_MS, PICKUP_MS, finishSignIn, flowKey, followCommand, resetAppFlows, runAppFlow, startAppFlow, type FlowDeps } from "./app-connect";
import { resetWakes, wakeActions, wakeState } from "./cloud-wake";
import type { CloudDesktop } from "./contracts";

const seen = vi.hoisted(() => ({ toasts: [] as string[], cheers: [] as string[] }));
vi.mock("../lib/api", () => ({ api: {} }));
vi.mock("../lib/toast", () => ({ toast: (text: string) => seen.toasts.push(text) }));
vi.mock("../lib/cheer", () => ({ cheer: (text: string) => seen.cheers.push(text) }));
afterEach(() => { resetAppFlows(); resetWakes(); seen.toasts.length = 0; seen.cheers.length = 0; });

const cloudWs: WorkspaceSummary = { id: "ws", name: "My Cloud", kind: "vps", version: "1", connectedAt: 0, lastReportAt: 1, freshness: "live" };
const mac: WorkspaceSummary = { ...cloudWs, name: "studio", kind: "mac" };

/** a workspace on a virtual clock: `take` and `answer` say when (in ms after the command) it takes and answers it */
function world(script: { take?: number; answer?: number; result?: Partial<CommandView>; reportsAfterWake?: number; connectedAfter?: number } = {}) {
  let time = 0, queuedAt = -1, powered = -1, lastReportAt = 1;
  const command: CommandView = { id: "cmd", kind: "app.connect", target: "gmail", issuedAt: 0, expiresAt: 600_000, status: "queued", message: null, doneAt: null };
  const went: string[] = [], asked: Array<{ returnHere?: boolean } | undefined> = [];
  const deps: FlowDeps = {
    now: () => time,
    sleep: async (ms) => { time += ms; },
    power: async () => { powered = time; },
    command: async (_id, _kind, _target, options) => { queuedAt = time; asked.push(options); return { command: { ...command } }; },
    connections: async () => ({ byWorkspace: { ws: time >= (script.connectedAfter ?? 40_000) ? ["gmail"] : [] }, pending: {}, available: {}, at: {} }),
    go: (url) => { went.push(url); },
    workspace: async () => {
      if (powered >= 0 && script.reportsAfterWake !== undefined && time - powered >= script.reportsAfterWake) lastReportAt = time;
      const since = queuedAt < 0 ? -1 : time - queuedAt;
      const view = { ...command };
      if (since >= 0 && script.take !== undefined && since >= script.take) view.status = "sent";
      if (since >= 0 && script.answer !== undefined && since >= script.answer) Object.assign(view, { status: "done", url: "https://connect.composio.dev/link/x", returnsHere: true }, script.result);
      return { workspace: { ...cloudWs, lastReportAt, freshness: "live" }, report: null, sectionAt: {}, history: [], commands: queuedAt < 0 ? [] : [view] } as WorkspaceDetail;
    },
  };
  return { deps, went, asked, time: () => time };
}

test("a sign-in that comes back here sends this tab to it, asking the workspace for the way back", async () => {
  const w = world({ take: 700, answer: 2100 });
  await runAppFlow("connect", cloudWs, "gmail", "Gmail", w.deps);
  expect(w.asked).toEqual([{ returnHere: true }]);
  expect(w.went).toEqual(["https://connect.composio.dev/link/x"]);
});

test("a workspace whose sign-in can't come back hands a link, never moves the tab, and waits for the app", async () => {
  const w = world({ take: 700, answer: 2100, result: { returnsHere: undefined }, connectedAfter: 12_000 });
  await runAppFlow("connect", cloudWs, "gmail", "Gmail", w.deps);
  expect(w.went).toEqual([]);
  expect(seen.cheers).toEqual(["Gmail is connected. your bots can use it now."]);
});

test("a workspace that never takes the command ends in PICKUP_MS with what to do next", async () => {
  const cloud = world();
  expect(await followCommand(cloudWs, "app.connect", "gmail", cloud.deps)).toEqual({ ok: false, message: "My Cloud is not answering right now. try again in a minute." });
  expect(cloud.time()).toBeLessThanOrEqual(PICKUP_MS + 1000);
  const quiet = world();
  await runAppFlow("connect", mac, "gmail", "Gmail", quiet.deps);
  expect(appFlowsNow()["ws:gmail"]).toMatchObject({ phase: "failed", message: "studio is not answering. open Metal on it, then try again." });
  expect(quiet.went).toEqual([]);
});

test("taken but never answered ends in ANSWER_MS; a failure the workspace sends is shown as it is", async () => {
  const stuck = world({ take: 700 });
  expect(await followCommand(cloudWs, "app.connect", "gmail", stuck.deps)).toMatchObject({ ok: false, message: "My Cloud did not hand back a sign-in page. try again." });
  expect(stuck.time()).toBeLessThanOrEqual(ANSWER_MS + 1000);
  const refused = world({ take: 700, answer: 1400, result: { status: "failed", message: "Apps are not set up on this workspace." } });
  expect(await followCommand(cloudWs, "app.connect", "gmail", refused.deps)).toEqual({ ok: false, message: "Apps are not set up on this workspace." });
});

const names = { workspace: () => "My Cloud", app: () => "Gmail" };
const finishing = (answer: ConnectFinishAnswer | Error, script: Parameters<typeof world>[0] = {}) => {
  const w = world(script);
  return { ...w, deps: { ...w.deps, finish: async () => { if (answer instanceof Error) throw answer; return answer; } } };
};

test("back from the sign-in, the page waits for the workspace to see the app, then says so", async () => {
  const w = finishing({ workspaceId: "ws", slug: "gmail", outcome: "signed-in" }, { connectedAfter: 6_000 });
  await finishSignIn("state", "success", w.deps, names);
  expect(seen.cheers).toEqual(["Gmail is connected on My Cloud. your bots can use it now."]);
});

test("a sign-in called off at the app, a stale link and a workspace that never sees it each say what happened", async () => {
  await finishSignIn("state", "failed", finishing({ workspaceId: "ws", slug: "gmail", outcome: "cancelled" }).deps, names);
  expect(appFlowsNow()["ws:gmail"]).toMatchObject({ phase: "failed", message: "the sign-in was called off before it finished. try again when you're ready." });
  await finishSignIn("state", "success", finishing(new Error("This sign-in link expired. Connect the app again.")).deps, names);
  expect(seen.toasts.at(-1)).toBe("This sign-in link expired. Connect the app again.");
  const never = finishing({ workspaceId: "ws", slug: "gmail", outcome: "signed-in" }, { connectedAfter: Infinity });
  await finishSignIn("state", "success", never.deps, names);
  expect(never.time()).toBeGreaterThanOrEqual(FINISH_MS);
  expect(appFlowsNow()["ws:gmail"]?.message).toBe("Gmail signed in, but My Cloud hasn't seen it yet. reload in a minute, or open Metal there.");
});

test("a sleeping cloud wakes first; the connect waits as the pill's button and runs from it", async () => {
  const w = world({ reportsAfterWake: 9_000, take: 700, answer: 3000 });
  await startAppFlow("connect", cloudWs, "gmail", "Gmail", { id: "c", workspaceId: "ws" } as CloudDesktop, w.deps);
  const wake = wakeState().wakes.c!;
  expect(wake.phase).toBe("ready");
  expect(wake.pending.map((p) => p.label)).toEqual(["connect Gmail now"]);
  expect(w.went).toEqual([]);
  wakeActions.run("c", flowKey("ws", "gmail"));
  await vi.waitFor(() => expect(w.went).toEqual(["https://connect.composio.dev/link/x"]));
});

test("a cloud that does not wake says so and queues nothing", async () => {
  const w = world();
  await startAppFlow("connect", cloudWs, "gmail", "Gmail", { id: "c", workspaceId: "ws" } as CloudDesktop, w.deps);
  expect(w.asked).toEqual([]);
  expect(wakeState().wakes.c).toBeUndefined();
});

test("a second click while one runs queues nothing new", async () => {
  const w = world({ take: 700, answer: 2100 });
  const first = runAppFlow("connect", cloudWs, "gmail", "Gmail", w.deps);
  await runAppFlow("connect", cloudWs, "gmail", "Gmail", w.deps);
  await first;
  expect(w.asked).toHaveLength(1);
});
