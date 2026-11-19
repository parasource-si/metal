// Settings → general → bring in from other apps: what this computer holds (bots from OpenClaw, Hermes Agent and Grok
// bot's saved files, and the AI tools' memory, skills, tools and instructions), each with its own Bring in, then the
// first run's one prompt for AIs online, and what comes in when its answer is pasted or dropped here.
import { useEffect, useMemo, useState } from "react";

import { track } from "@/lib/analytics";
import { myDefaultBot, useViewerEmail } from "@/lib/default-bot";
import { bringChosen, forgetBringRun, localFinds, useBringRun, type LocalFind } from "@/lib/first-run-import";
import { t } from "@/lib/i18n";
import { detectSetupWithin, localSetupImport, setupImportApi, type SetupImportClient } from "@/lib/setup-import";
import { useStore } from "@/state/store";
import type { SetupDetection } from "../../shared/setup-import";
import { useBotMove } from "./BringBots";
import { BringIn, useBringChoice } from "./BringIn";

const LOOK_MS = 4_000;

export function ImportSettings({ client = setupImportApi }: { client?: SetupImportClient }) {
  const { state, dispatch } = useStore();
  const first = myDefaultBot(state.bots, useViewerEmail());
  // only the desktop app on the computer running Metal can read what that computer holds
  const local = localSetupImport(state.config?.cloudHome === true);
  const move = useBotMove({ look: local });
  const [detection, setDetection] = useState<SetupDetection | null | undefined>(local ? undefined : null);
  useEffect(() => {
    if (!local) return;
    const look = detectSetupWithin(client, LOOK_MS);
    void look.found.then(setDetection);
    return look.cancel;
  }, [client, local]);
  const finds = useMemo<LocalFind[] | null>(() => {
    if (!local) return [];
    return move.plan && detection !== undefined ? localFinds(move.plan, detection, { grokExports: true }) : null;
  }, [local, move.plan, detection]);
  // a bringing in that finished before this page opened is not this visit's: what is still here is looked at afresh
  useEffect(() => forgetBringRun(), []);
  const run = useBringRun();
  const choice = useBringChoice(finds);

  const bring = (chosen: readonly LocalFind[]) => {
    track("settings_bring", { apps: chosen.length });
    void bringChosen(chosen, { client, dispatch, firstBotId: first?.id ?? null, aboutMe: state.config?.profile?.aboutMe ?? "", team: Boolean(state.config?.team) });
  };

  return (
    <section data-import-section="bring" className="flex flex-col gap-4 px-1 pt-1">
      <p className="m-0 text-pretty text-[13px] leading-[18px] text-ink-secondary">{choice.found ? t("bring.sub") : t("bring.subNone")}</p>
      <BringIn finds={finds} choice={choice} grokWaiting={move.plan?.grokWaiting ?? []} run={run} onImport={(find) => bring([find])} />
    </section>
  );
}
