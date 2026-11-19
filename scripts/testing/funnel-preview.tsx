// The first-run funnel's corner cards and dialogs, the real components with fake desktop bridges.
// ?view=asleep|late|late-missed|plans|start-fresh|settings picks one. Served by scripts/verify-funnel-preview.ts.
import { createRoot } from "react-dom/client";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { StartFreshView } from "../../electron/start-fresh.mjs";
import { CloudAccountSettings } from "../../src/components/CloudAccountSettings";
import { CloudAddSheet } from "../../src/components/CloudAddDialog";
import { ChooseScreen } from "../../src/components/cloud-buy/ChooseScreen";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { AsleepWorkCard, LateRoutineCard } from "../../src/components/LateRoutineCard";
import { StartFreshDialog } from "../../src/components/bot-panel/StartFresh";
import { setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import { applySkinChoice } from "../../src/lib/skins";
import { StoreProvider } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

setLocale("en");
setEmailGateDone("skipped");
applySkinChoice("system");
const view = new URLSearchParams(location.search).get("view") ?? "asleep";
const NOW = Date.now();
const HOUR = 3_600_000;

const account: CloudAccountState = {
  status: "connected", account: { id: "a", email: "sam@example.test", name: "Sam Rivera" },
  entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 },
} as CloudAccountState;
const idle: StartFreshView = { phase: "idle", steps: [
  { id: "signout", kind: "signout", label: "Sign this computer out of sam@example.test", status: "pending" },
  { id: "ai", kind: "ai", label: "Remove the saved AI keys", status: "pending" },
  { id: "local", kind: "local", label: "Wipe this computer's Metal data on restart", status: "pending" },
] };
window.duskDesktop = {
  platform: "darwin",
  getCapabilities: async () => ({ ...initialDesktopCapabilities(), windowChrome: "mac-inset" }),
  cloudAccount: { state: async () => account, onState: () => () => {} },
  startFresh: {
    available: async () => true, preview: async () => idle, run: async () => idle, retry: async () => idle, finish: async () => idle,
    onChanged: () => () => {},
  },
} as unknown as typeof window.duskDesktop;

const plans = [
  { tier: "starter", label: "Plus", amount: 1500, trialDays: 3 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 3 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 3 },
];

function View() {
  switch (view) {
    case "asleep": return <AsleepWorkCard slept={{ botId: "quill", name: "Quill", wokeAt: NOW }} onStart={() => {}} onNotNow={() => {}} />;
    case "late": return <LateRoutineCard now={NOW} late={{ runId: "r", routineId: "x", name: "Morning brief", dueAt: NOW - 3 * HOUR, ranAt: NOW - HOUR }} onStart={() => {}} onNotNow={() => {}} />;
    case "late-missed": return <LateRoutineCard now={NOW} late={{ runId: "r", routineId: "x", name: "Morning brief", dueAt: NOW - 3 * HOUR, ranAt: null }} onStart={() => {}} onNotNow={() => {}} />;
    case "plans": return <CloudAddSheet kind="offer" staging={false} onClose={() => {}}>
      <ChooseScreen offer={{ plans, recommended: "pro", refundDays: 14 }} busy={false} signedOut={false} notice={null} onStart={() => {}} onSignIn={() => {}} />
    </CloudAddSheet>;
    case "start-fresh": return <StartFreshDialog bridge={window.duskDesktop!.startFresh!} onClose={() => {}} />;
    case "settings": return <div className="mx-auto max-w-[640px] p-8"><CloudAccountSettings /></div>;
    default: return null;
  }
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider><DesktopCapabilitiesProvider>
    <div data-funnel-preview={view} className="min-h-[100dvh] bg-app text-ink"><View /></div>
  </DesktopCapabilitiesProvider></StoreProvider>,
);
