// "Let my cloud bots use this Mac" against a fake cloudMac bridge: ?view=settings (on, auto, no folder limit),
// ?view=restricted (on, ask before every action, two folders), ?view=approval (a mac_exec card). Served only by cloud-mac-shots.ts.
import { createRoot } from "react-dom/client";
import type { CloudMacState } from "../../shared/cloud-mac";
import { CloudMacCard } from "../../src/components/CloudMacCard";
import { Card as RowsCard } from "../../src/components/ListRows";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "../../src/components/PendingApproval";
import { SIMPLE_BUTTONS } from "../../src/components/SettingsPrimitives";
import { ELEVATED_CARD } from "../../src/components/elevated";
import { cn } from "../../src/lib/cn";
import { t } from "../../src/lib/i18n";
import { applySkin } from "../../src/lib/skins";
import { StoreProvider, type Bot, type Message } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";
import "../../src/styles/settings.css";

const view = new URLSearchParams(location.search).get("view") ?? "settings";
applySkin("grok");

let state: CloudMacState = {
  enabled: true,
  mode: view === "restricted" ? "ask" : "auto",
  limitFolders: view === "restricted",
  folders: ["~/Downloads", "~/Metal"],
  cloud: "connected",
  problem: null,
  busy: [],
};
const listeners = new Set<(next: CloudMacState) => void>();
const set = (next: Partial<CloudMacState>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener(state)); return state; };
window.duskDesktop = {
  platform: "darwin",
  remoteClient: { active: false },
  getCapabilities: async () => ({}),
  onCapabilitiesChanged: () => () => {},
  cloudMac: {
    state: async () => state,
    setEnabled: async (on: boolean) => set({ enabled: on }),
    addFolder: async () => set({ folders: [...state.folders, "~/Documents"] }),
    setMode: async (mode: CloudMacState["mode"]) => set({ mode }),
    setLimitFolders: async (on: boolean) => set({ limitFolders: on }),
    removeFolder: async (path: string) => set({ folders: state.folders.filter((folder) => folder !== path) }),
    openLog: async () => {},
    onChange: (listener: (next: CloudMacState) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  },
} as unknown as typeof window.duskDesktop;

const nova = { id: "nova", name: "Nova", avatar: { kind: "preset", id: "nova" } } as unknown as Bot;
const card: Message = {
  id: "m1", at: Date.now(), role: "bot", kind: "options",
  card: {
    title: "Nova wants to run a command on your Mac", subtitle: "rm -rf build node_modules\nin ~/code/site\nAsking because it deletes many files.", options: ["Allow", "Deny", "Always allow"],
    requestId: "r1", requestType: "permission", tool: "mac_exec", allowKey: "mac_exec:~/code/site:rm -rf build node_modules",
  } as Message["card"],
};

function Settings() {
  return (
    <div className={cn("settings-pane mx-auto w-full max-w-[640px]", SIMPLE_BUTTONS)}>
      <RowsCard label={t("settings.grok.group.yourComputer")} data-settings-block="cloud-home-connection">
        <CloudMacCard />
      </RowsCard>
    </div>
  );
}

function Approval() {
  const pending = pendingApprovals([card])[0]!;
  return (
    <div className="mx-auto w-full max-w-[720px] px-6 pt-10">
      <div className={cn("overflow-hidden rounded-[24px]", ELEVATED_CARD)}>
        <PendingApprovalPanel pending={pending} botName="Nova" count={1} index={0}
          actions={<PendingApprovalActions part="primary" pending={pending} threadId="t1" bot={nova} onCancelTurn={() => {}} />} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <main data-preview={view} className="min-h-[100dvh] bg-app text-ink">
      {view === "approval" ? <Approval /> : <Settings />}
    </main>
  </StoreProvider>,
);
