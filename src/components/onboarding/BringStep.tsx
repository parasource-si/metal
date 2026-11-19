// The first run's "bring what you already use": what this computer holds from other AI apps, each with its own Bring in,
// then the prompt for AIs online, with a still scene above and Continue below. Bringing in goes on while the run does,
// and the prompt's answer comes in later, into any chat or from Downloads; Continue never waits.
import { type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { MausAvatar } from "../Avatar";
import { BringIn, useBringChoice } from "../BringIn";
import type { BringRun, LocalFind } from "@/lib/first-run-import";
import { ClaudeMark, CodexMark, GeminiMark, GrokMark } from "../ProviderIcons";
import { cn } from "@/lib/cn";
import { BRAND_LILAC, PRIMARY, StepFrame } from "./FunnelSteps";

/** The AI apps the prompt is for, as their own app icons: each logo in its colours on its own tile. */
const ONLINE: { key: string; tile: string; mark: (size: number) => ReactNode }[] = [
  { key: "chatgpt", tile: "bg-[#10a37f]", mark: (size) => <CodexMark size={size} className="fill-[#fafafa]" /> },
  { key: "claude", tile: "bg-[#f5efe6]", mark: (size) => <ClaudeMark size={size} /> },
  { key: "gemini", tile: "bg-[#eef3fd]", mark: (size) => <GeminiMark size={size} /> },
  { key: "grok", tile: "bg-[#141416]", mark: (size) => <GrokMark size={size} className="fill-[#fafafa]" /> },
];

/** Your other AI apps on the left, in their own colours, Metal's mascot on the right as the welcome shows it. */
function BringScene() {
  return (
    <div data-bring-scene="" className="relative flex h-16 w-[248px] items-center justify-between">
      <span className="grid h-[52px] w-[52px] shrink-0 grid-cols-2 gap-1">
        {ONLINE.map((app) => (
          <span key={app.key} data-bring-logo={app.key} className={cn("grid size-6 place-items-center rounded-[7px]", app.tile)}>{app.mark(14)}</span>
        ))}
      </span>
      <span className="relative mx-2 h-6 flex-1">
        <span className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-between px-1">
          {Array.from({ length: 9 }, (_, index) => <span key={index} className="size-[3px] bg-ink/15" />)}
        </span>
      </span>
      <span className="shrink-0"><MausAvatar color="purple" gradient={BRAND_LILAC} size={52} state="happy" trackPointer={false} animated={false} label="" /></span>
    </div>
  );
}

export function BringStep({ finds, grokWaiting, run, onBring, onNext }: {
  /** What this computer holds; null while still looking. */
  finds: readonly LocalFind[] | null;
  /** Grok bot's bots on this computer, by name: they move through the prompt, like an AI online. */
  grokWaiting: readonly string[];
  run: BringRun;
  onBring: (find: LocalFind) => void;
  onNext: () => void;
}) {
  const choice = useBringChoice(finds);
  return (
    <StepFrame art={<BringScene />} title={t("bring.title")} sub={choice.found ? t("bring.sub") : t("bring.subNone")}
      footer={<button type="button" data-primary="" data-bring-next="" onClick={onNext} className={PRIMARY}>{t("funnel.next")}</button>}>
      <div className="w-full max-w-[440px]">
        <BringIn step finds={finds} choice={choice} grokWaiting={grokWaiting} run={run} onImport={onBring} />
      </div>
    </StepFrame>
  );
}

/** The run's one quiet line at the foot of every step after the bring step: bringing in, then what came in, and notes
 * from another AI pasted on a step. */
export function BringStatus({ line, working = false }: { line: string | null; working?: boolean }) {
  if (!line && !working) return null;
  return (
    <p role="status" aria-live="polite" data-bring-status={working ? "working" : "done"}
      className="pointer-events-none fixed right-0 bottom-4 left-[var(--rail-beside,0px)] z-10 mx-auto flex w-fit max-w-[min(520px,calc(100%-32px))] items-center gap-2 rounded-[14px] bg-ink/[0.05] px-3 py-1.5 text-[12px] leading-4 text-ink-secondary">
      {working && <span aria-hidden="true" className="funnel-wait inline-block size-1.5 shrink-0 rounded-full bg-ink/60" />}
      <span className="text-pretty">{working ? t("bring.working") : line}</span>
    </p>
  );
}
