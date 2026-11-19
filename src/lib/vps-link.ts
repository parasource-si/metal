// "Add your VPS" (electron/vps-link.mjs): the one command a person pastes on their server, the install's live steps, the AI
// sign-in sent from this computer, and the move. Only this computer's own page in the desktop app has the bridge.
import { useCallback, useSyncExternalStore } from "react";

export const VPS_STEP_IDS = ["check", "basics", "docker", "user", "node", "app", "engines", "service", "address", "desktop", "link"] as const;
export type VpsStepId = (typeof VPS_STEP_IDS)[number];
export type VpsStepStatus = "waiting" | "running" | "done" | "failed" | "skipped";
export type VpsInstallProgress = { kind: "download"; receivedBytes: number; totalBytes?: number; label?: string }
  | { kind: "layers" | "build"; completed: number; total: number; receivedBytes?: number; totalBytes?: number; label?: string };
export interface VpsLinkStep {
  id: VpsStepId; status: VpsStepStatus; log?: string; cmd?: string; lines?: string[]; progress?: VpsInstallProgress;
  activity?: { elapsedMs: number; quietMs: number; at: number };
}
export type VpsMoveStep = "backup" | "copy" | "verify" | "empty" | "done";
export interface VpsLinkMove {
  step: VpsMoveStep;
  status: "running" | "done" | "failed";
  chats?: { done: number; total: number };
  bytes?: { done: number; total?: number };
  waitingFor?: string;
  error?: string;
  /** The copy failed and goes again by itself at this time (ms since epoch). */
  retryAt?: number;
  backupId?: string;
  /** Something did not arrive, so this computer kept its copy. */
  kept?: boolean;
}
export interface VpsServer { id: string; name: string; origin: string }
export interface VpsLinkView {
  stage: "idle" | "command" | "installing" | "linked" | "moving" | "moved" | "error";
  command: string | null;
  expiresAt: number | null;
  steps: VpsLinkStep[];
  /** Live installer output in arrival order, omitted by older desktop builds. */
  terminal?: Array<{ step: string; text: string }>;
  /** Last relay contact and real installer activity. Heartbeats update contact without implying forward progress. */
  activity?: { updatedAt: number; progressAt: number; error?: string };
  server: VpsServer | null;
  error: string | null;
  /** the link service needs a signed-in account: the sign-in goes on in the browser, and the line comes by itself after */
  signIn?: true;
  move: VpsLinkMove | null;
  mode?: "relay" | "direct" | null;
  /** How the app reaches the linked server (install.sh's way): omitted by older desktop builds. */
  via?: VpsLinkVia | null;
  /** Why the way asked for on the line fell back to the relay (the installer's own words), once linked. */
  fallback?: string | null;
  /** What the installer needs the person to do now (sign in to Tailscale), while a line runs. */
  ask?: VpsLinkAsk | null;
  /** Bots coming back to this computer from a server (moveBack), while it runs and after it failed; older builds omit it. */
  back?: VpsMoveBack;
}
export type VpsMoveBackStep = "check" | "backup-here" | "pause" | "copy" | "restore";
export interface VpsMoveBack {
  step: VpsMoveBackStep;
  status: "running" | "failed" | "done";
  name?: string;
  bytes?: { done: number; total?: number };
  error?: string;
}
export type VpsLinkVia = "relay" | "ssh" | "direct" | "tailscale" | "cloudflare";
export type VpsLinkAsk =
  | { kind: "tailscale-login" | "tailscale-https"; url: string; state: "waiting" | "found" | "done" }
  | { kind: "ssh"; user: string; host: string; state: "waiting" | "found" | "done" };
export interface VpsEngine { instanceId: string; kind: "claude" | "codex"; name: string; signedIn: boolean }
export interface VpsSignIn {
  flowId: string | null;
  phase: "waiting" | "succeeded" | "failed" | "expired" | "cancelled";
  authorizationUrl: string | null;
  userCode?: string;
  needsCode: boolean;
  message?: string;
}
export interface VpsMovePreview {
  bots: Array<{ id: string; name: string; avatarUrl?: string }>;
  chats: number;
  messages: number | null;
  skills: number;
  memories: number | null;
  routines: number;
  apps: number | null;
  bytes: number | null;
}
export interface VpsBackup {
  id: string;
  at: number;
  bytes: number;
  summary: { bots: number; chats: number; skills: number; routines: number } | null;
  reason: "before-move" | "before-restore" | "manual" | "from-server";
}
/** `uninstall`: the line to paste on the server to take Metal off it (older apps leave it out). `bring`: on this
 * computer, the servers saved by hand whose bots may come here (moveBack with the id); `blocked` says why none may now. */
export interface VpsWhere {
  place: "mac" | "vps";
  server: VpsServer | null;
  uninstall?: string;
  bring?: Array<{ id: string; name: string }>;
  blocked?: "own-bots" | "moved" | "moving" | "unknown";
}

export interface VpsLinkBridge {
  state(): Promise<VpsLinkView>;
  start(): Promise<VpsLinkView>;
  cancel(): Promise<VpsLinkView>;
  reset(): Promise<VpsLinkView>;
  engines(): Promise<VpsEngine[]>;
  signIn(instanceId: string): Promise<VpsSignIn>;
  signInStatus(instanceId: string, flowId: string): Promise<VpsSignIn>;
  signInCode(instanceId: string, flowId: string, code: string): Promise<{ ok: true }>;
  signInCancel(instanceId: string, flowId: string): Promise<{ ok: true }>;
  openUrl(url: string): Promise<void>;
  preview(): Promise<VpsMovePreview>;
  move(): Promise<VpsLinkView>;
  /** The move's next try, now. */
  retryMove(): Promise<VpsLinkView>;
  open(): Promise<void>;
  where(): Promise<VpsWhere>;
  backups(): Promise<VpsBackup[]>;
  backupNow(): Promise<{ id: string }>;
  restore(id: string): Promise<{ ok: true; restart: true }>;
  /** `placeId`: a saved server in `where().bring`; the server this computer moved to when left out. */
  moveBack(placeId?: string): Promise<{ ok: true }>;
  forget(): Promise<VpsLinkView>;
  onChange(callback: (view: VpsLinkView) => void): () => void;
}

/** False on a page this app's window shows from elsewhere (dusk cloud, a server) and while it is another computer's remote
 * client: a server of one's own is added only from this computer's own page. */
export function thisComputerPage(): boolean {
  if (typeof window === "undefined" || window.duskDesktop?.remoteClient?.active) return false;
  return !(window.duskDesktop?.app && window.duskDesktop.app.ownPage === false);
}

export function vpsLinkBridge(): VpsLinkBridge | undefined {
  return thisComputerPage() ? window.duskDesktop?.vpsLink : undefined;
}

/** False in a browser, on another place's page, and in desktop builds without the bridge. */
export const vpsLinkAvailable = (): boolean => Boolean(vpsLinkBridge());

export const EMPTY_VIEW: VpsLinkView = {
  stage: "idle", command: null, expiresAt: null, steps: VPS_STEP_IDS.map((id) => ({ id, status: "waiting" })), server: null, error: null, move: null,
};

type LinkSnapshot = { view: VpsLinkView; ready: boolean };
const NO_LINK: LinkSnapshot = { view: EMPTY_VIEW, ready: false };
const linkStores = new WeakMap<VpsLinkBridge, ReturnType<typeof createLinkStore>>();

function createLinkStore(bridge: VpsLinkBridge) {
  let snapshot = NO_LINK;
  let revision = 0;
  let releaseGeneration = 0;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: LinkSnapshot) => { snapshot = next; for (const listen of listeners) listen(); };
  const start = () => {
    let active = true;
    const before = revision;
    const stop = bridge.onChange((view) => { if (active) { revision++; publish({ view, ready: true }); } });
    unsubscribe = () => { active = false; stop(); };
    void bridge.state().then((view) => {
      if (active && before === revision) publish({ view, ready: true });
    }, (cause) => {
      if (active && before === revision) publish({ view: { ...snapshot.view, error: String((cause as Error)?.message ?? cause) }, ready: true });
    });
  };
  return {
    read: () => snapshot,
    subscribe(listen: () => void) {
      releaseGeneration++;
      listeners.add(listen);
      if (!unsubscribe) start();
      return () => {
        listeners.delete(listen);
        if (listeners.size > 0) return;
        const generation = ++releaseGeneration;
        queueMicrotask(() => {
          if (listeners.size > 0 || generation !== releaseGeneration) return;
          revision++;
          unsubscribe?.();
          unsubscribe = null;
          snapshot = { ...snapshot, ready: false };
        });
      };
    },
    async update(work: () => Promise<VpsLinkView>) {
      const before = revision;
      const view = await work();
      if (before === revision && unsubscribe) publish({ view, ready: true });
    },
  };
}

const subscribeToNothing = () => () => {};
const noLink = () => NO_LINK;

/** Main's view is shared by the status strip, Settings and the setup journey. */
export function useVpsLink(): { view: VpsLinkView; bridge: VpsLinkBridge | undefined; ready: boolean; update(work: () => Promise<VpsLinkView>): Promise<void> } {
  const bridge = vpsLinkBridge();
  let store = bridge ? linkStores.get(bridge) : undefined;
  if (bridge && !store) { store = createLinkStore(bridge); linkStores.set(bridge, store); }
  const snapshot = useSyncExternalStore(store?.subscribe ?? subscribeToNothing, store?.read ?? noLink, noLink);
  const update = useCallback(async (work: () => Promise<VpsLinkView>) => { await store?.update(work); }, [store]);
  return { ...snapshot, bridge, update };
}

// whether the flow's sheet is open: one tiny store, so Settings and any other entry point open the same sheet
let open = false;
const watchers = new Set<() => void>();
const tell = () => { for (const watch of Array.from(watchers)) watch(); };
export function openAddVps(): void { open = true; tell(); }
export function closeAddVps(): void { open = false; tell(); }
export function useAddVpsOpen(): boolean {
  return useSyncExternalStore((watch) => { watchers.add(watch); return () => { watchers.delete(watch); }; }, () => open, () => false);
}

/** Which of the four screens the view belongs on. `signedIn`: the person finished or skipped the AI sign-in. */
export function vpsStage(view: VpsLinkView, signedIn: boolean): 1 | 2 | 3 | 4 {
  if (view.stage === "moving" || view.stage === "moved") return 4;
  if (view.stage === "linked") return signedIn ? 4 : 3;
  if (view.stage === "installing") return 2;
  if (view.stage === "error" && view.server) return signedIn ? 4 : 3;
  if (view.stage === "error" && view.steps.some((step) => step.status !== "waiting")) return 2;
  return 1;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
