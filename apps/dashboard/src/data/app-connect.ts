import { useSyncExternalStore } from "react";
import type { CommandKind, CommandView, ConnectFinishAnswer as FinishAnswer, ConnectorsAnswer, WorkspaceSummary } from "../../../../shared/dashboard-protocol";
import { api } from "../lib/api";
import { cheer } from "../lib/cheer";
import { toast } from "../lib/toast";
import { useCloud } from "./cloud";
import { dropPending, isAwake, wakeCloud, type WakeDeps } from "./cloud-wake";
import type { CloudDesktop } from "./contracts";

/** waiting: the workspace is making the sign-in; redirecting: this tab is going to it; sign-in: it opens in its own tab
 *  (a workspace whose sign-in can't come back here); finishing: back from it, waiting for the workspace to see the app */
export type AppFlowPhase = "waking" | "waiting" | "redirecting" | "sign-in" | "finishing" | "done" | "failed";
export interface AppFlow {
  key: string;
  action: "connect" | "disconnect";
  workspaceId: string;
  workspaceName: string;
  slug: string;
  label: string;
  phase: AppFlowPhase;
  url: string | null;
  message: string | null;
}

/** a command the workspace has not taken by now is not going to be: it is asleep, offline or not polling */
export const PICKUP_MS = 15_000;
/** taken but no link back by now: the sign-in is stuck on the workspace */
export const ANSWER_MS = 30_000;
/** back from the sign-in, how long the page waits for the workspace to report the app connected */
export const FINISH_MS = 90_000;
const COMMAND_POLL_MS = 700;
const SIGN_IN_WAIT_MS = 5 * 60_000;
const SIGN_IN_POLL_MS = 3_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const flowKey = (workspaceId: string, slug: string) => `${workspaceId}:${slug}`;

export interface FlowDeps extends WakeDeps {
  command(id: string, kind: CommandKind, target: string, options?: { returnHere?: boolean }): Promise<{ command: CommandView }>;
  connections(): Promise<ConnectorsAnswer | null>;
  /** this tab goes to the app's sign-in, which sends it back to the apps page */
  go(url: string): void;
}
const browserDeps = (reload: () => Promise<ConnectorsAnswer | null>): FlowDeps => ({
  workspace: (id) => api.workspace(id), command: api.command, power: api.power, connections: reload, now: Date.now, sleep,
  go: (url) => window.location.assign(url),
});

/** what to do next when a workspace never took the command, in its own terms */
export function notAnswering(ws: Pick<WorkspaceSummary, "name" | "kind">): string {
  return ws.kind === "vps"
    ? `${ws.name} is not answering right now. try again in a minute.`
    : `${ws.name} is not answering. open Metal on it, then try again.`;
}

/** queues the command and follows it: not taken in PICKUP_MS or not answered in ANSWER_MS ends it with what to do next */
export async function followCommand(ws: Pick<WorkspaceSummary, "id" | "name" | "kind">, kind: CommandKind, slug: string, deps: FlowDeps, onTaken?: () => void):
  Promise<{ ok: true; command: CommandView } | { ok: false; message: string }> {
  let id: string;
  try { id = (await deps.command(ws.id, kind, slug, kind === "app.connect" ? { returnHere: true } : undefined)).command.id; }
  catch (e) { return { ok: false, message: (e as Error).message }; }
  const started = deps.now();
  let taken = false;
  while (true) {
    await deps.sleep(COMMAND_POLL_MS);
    const command = (await deps.workspace(ws.id).catch(() => null))?.commands.find((c) => c.id === id);
    if (command?.status === "done") return { ok: true, command };
    if (command && command.status !== "queued" && command.status !== "sent") {
      return { ok: false, message: command.status === "failed" && command.message ? command.message : notAnswering(ws) };
    }
    if (command?.status === "sent" && !taken) { taken = true; onTaken?.(); }
    const waited = deps.now() - started;
    if (!taken && waited >= PICKUP_MS) return { ok: false, message: notAnswering(ws) };
    if (waited >= ANSWER_MS) return { ok: false, message: `${ws.name} did not hand back a sign-in page. try again.` };
  }
}

const store = { flows: {} as Record<string, AppFlow>, listeners: new Set<() => void>() };
function setFlows(next: Record<string, AppFlow>) { store.flows = next; store.listeners.forEach((fn) => fn()); }
const running = (key: string) => ["waking", "waiting", "redirecting", "finishing"].includes(store.flows[key]?.phase ?? "");
const patch = (key: string, change: Partial<AppFlow>) => { if (store.flows[key]) setFlows({ ...store.flows, [key]: { ...store.flows[key]!, ...change } }); };
const isConnected = (answer: ConnectorsAnswer | null, workspaceId: string, slug: string) => Boolean(answer?.byWorkspace[workspaceId]?.some((s) => s.toLowerCase() === slug));

/** one sign-in from the click to the app's own page: this tab goes there and comes back to finishSignIn; a workspace
 *  whose sign-in can't come back hands a link to open instead, and the page waits for the app */
export async function runAppFlow(action: AppFlow["action"], ws: WorkspaceSummary, slug: string, label: string, deps: FlowDeps) {
  const key = flowKey(ws.id, slug);
  if (running(key)) return;
  setFlows({ ...store.flows, [key]: { key, action, workspaceId: ws.id, workspaceName: ws.name, slug, label, phase: "waiting", url: null, message: null } });
  // a failed connect stays in the corner pill; a disconnect has none, so it is told in a toast
  const failed = (message: string) => { patch(key, { phase: "failed", message }); if (action === "disconnect") toast(message, "bad"); };
  const answer = await followCommand(ws, action === "connect" ? "app.connect" : "app.disconnect", slug, deps);
  if (!answer.ok) return failed(answer.message);
  if (action === "disconnect") {
    await deps.connections();
    patch(key, { phase: "done" });
    toast(`${label} is disconnected from ${ws.name}.`);
    return;
  }
  const url = answer.command.url;
  if (!url) return failed(`${label} did not return a sign-in page.`);
  if (answer.command.returnsHere) {
    patch(key, { phase: "redirecting", url });
    deps.go(url);
    return;
  }
  patch(key, { phase: "sign-in", url });
  const until = deps.now() + SIGN_IN_WAIT_MS;
  while (deps.now() < until) {
    await deps.sleep(SIGN_IN_POLL_MS);
    if (isConnected(await deps.connections().catch(() => null), ws.id, slug)) {
      patch(key, { phase: "done", url: null });
      cheer(`${label} is connected. your bots can use it now.`);
      return;
    }
  }
  patch(key, { phase: "failed", message: `${label} is not connected yet. finish signing in, then reload this page.` });
}

/** back on the apps page from a sign-in this page started: the state is taken once, then the page waits for the
 *  workspace to report the app; a sign-in called off at the app says so */
export async function finishSignIn(state: string, status: string | null, deps: FlowDeps & { finish(state: string, status: string | null): Promise<FinishAnswer> },
  names: { workspace(id: string): string; app(slug: string): string }) {
  let found: FinishAnswer;
  try { found = await deps.finish(state, status); }
  catch (e) { toast((e as Error).message, "bad"); return; }
  const key = flowKey(found.workspaceId, found.slug), label = names.app(found.slug), workspaceName = names.workspace(found.workspaceId);
  const base: AppFlow = { key, action: "connect", workspaceId: found.workspaceId, workspaceName, slug: found.slug, label, phase: "finishing", url: null, message: null };
  if (found.outcome === "cancelled") {
    setFlows({ ...store.flows, [key]: { ...base, phase: "failed", message: "the sign-in was called off before it finished. try again when you're ready." } });
    return;
  }
  setFlows({ ...store.flows, [key]: base });
  const until = deps.now() + FINISH_MS;
  while (deps.now() < until) {
    if (isConnected(await deps.connections().catch(() => null), found.workspaceId, found.slug)) {
      patch(key, { phase: "done" });
      cheer(`${label} is connected on ${workspaceName}. your bots can use it now.`);
      return;
    }
    await deps.sleep(SIGN_IN_POLL_MS);
  }
  patch(key, { phase: "failed", message: `${label} signed in, but ${workspaceName} hasn't seen it yet. reload in a minute, or open Metal there.` });
}

const dropFlow = (key: string) => { const { [key]: _, ...rest } = store.flows; setFlows(rest); };

/** a cloud we put to sleep wakes first: a connect waits as a button in the corner pill, a disconnect goes on its own */
export async function startAppFlow(action: AppFlow["action"], ws: WorkspaceSummary, slug: string, label: string, wake: CloudDesktop | undefined, deps: FlowDeps) {
  const key = flowKey(ws.id, slug);
  if (running(key)) return;
  if (!wake || isAwake(wake.id, deps.now())) {
    dropPending(key);
    return runAppFlow(action, ws, slug, label, deps);
  }
  setFlows({ ...store.flows, [key]: { key, action, workspaceId: ws.id, workspaceName: ws.name, slug, label, phase: "waking", url: null, message: null } });
  const pending = action === "connect"
    ? { key, label: `connect ${label} now`, run: () => { dropFlow(key); void runAppFlow(action, ws, slug, label, deps); }, cancel: () => dropFlow(key) }
    : undefined;
  const awake = await wakeCloud(wake, ws.name, { pending, deps });
  if (store.flows[key]?.phase !== "waking") return;
  if (!awake) {
    const message = `${ws.name} did not wake up. try again in a minute.`;
    patch(key, { phase: "failed", message });
    toast(message, "bad");
    return;
  }
  dropFlow(key);
  if (action === "disconnect") return runAppFlow(action, ws, slug, label, deps);
}

export function useAppFlows(): Record<string, AppFlow> {
  return useSyncExternalStore((fn) => { store.listeners.add(fn); return () => void store.listeners.delete(fn); }, () => store.flows, () => store.flows);
}

export function useAppCommands() {
  const { reloadConnections } = useCloud();
  const flows = useAppFlows();
  const deps = () => browserDeps(reloadConnections);
  const start = (action: AppFlow["action"]) => (ws: WorkspaceSummary, slug: string, label: string, wake?: CloudDesktop) => {
    void startAppFlow(action, ws, slug, label, wake, deps());
  };
  return {
    flows,
    /** `wake`: the dusk cloud we put to sleep that runs this workspace; it wakes first */
    connect: start("connect"),
    disconnect: start("disconnect"),
    finish: (state: string, status: string | null, names: Parameters<typeof finishSignIn>[3]) =>
      finishSignIn(state, status, { ...deps(), finish: api.finishConnect }, names),
    dismiss: dropFlow,
  };
}

/** for tests */
export const resetAppFlows = () => setFlows({});
export const appFlowsNow = () => store.flows;
