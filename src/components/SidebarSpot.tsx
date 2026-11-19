import { useEffect, useRef, useState, type ReactNode } from "react";
import { GROK_HOVER_TINT } from "./SidebarSimpleTop";
import { Check } from "lucide-react";
import { X } from "../icons";

import { openExternalLink } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { openFeedback } from "@/lib/feedback-sheet";
import { t } from "@/lib/i18n";

import type { AppUpdateBridge, AppUpdateState } from "../../electron/app-update.mjs";
import { Art, type ArtName } from "./ui/Art";
import { MausAvatar } from "./Avatar";
import { mdPrimaryCls } from "./ui/GrokDialog";

const DOWNLOAD_PAGE = "https://github.com/parasource-si/metal/releases";

function ownBridge() {
  return window.duskDesktop?.remoteClient?.active === true ? undefined : window.duskDesktop?.appUpdate;
}

function restartInto(bridge: AppUpdateBridge, setRestarting: (on: boolean) => void) {
  setRestarting(true);
  void bridge.restart().then(ok => { if (!ok) setRestarting(false); }, () => setRestarting(false));
}

export type SpotState =
  | { kind: "feedback" }
  | { kind: "checking"; version: null }
  | { kind: "restart"; version: string; restarting: boolean }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "retrying"; version: string; percent: number | null }
  | { kind: "failed"; version: string }
  | { kind: "move"; version: string }
  | { kind: "manual"; version: string };

/** what the spot shows for main's update state; `asked`: the person pressed it, and the download it started has not failed */
export function spotFor(update: AppUpdateState, asked: boolean, restarting: boolean): SpotState {
  const ready = update.ready;
  if (ready) return { kind: "restart", version: ready, restarting };
  const version = update.available ?? null;
  const percent = update.progress == null ? null : Math.round(update.progress * 100);
  if (version && update.blocked === "move") return { kind: "move", version };
  if (update.manual) return { kind: "manual", version: update.manual.version };
  if (version) {
    if (update.retrying) return { kind: "retrying", version, percent };
    if (percent !== null || asked) return { kind: "downloading", version, percent };
    if (update.failed && !update.checking) return { kind: "failed", version };
    return { kind: "available", version };
  }
  if (asked) return { kind: "checking", version: null };
  return { kind: "feedback" };
}

/**
 * The sidebar's one spot above the account row: Give feedback, until this computer's app has an update. A mac that installs
 * or a Windows install or Linux AppImage that installs its own (electron/app-update.mjs) downloads it on a press and restarts into it once
 * ready; one that can't says what to do (move to Applications, or download from dusk.bot), and a .deb downloads its installer.
 */
export function useSidebarSpot(bridge: AppUpdateBridge | undefined = ownBridge()) {
  const [update, setUpdate] = useState<AppUpdateState>({ ready: null });
  const [asked, setAsked] = useState(false);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let heard = false;
    const unsubscribe = bridge.onState(state => { if (active) { heard = true; setUpdate(state); } });
    void bridge.state().then(state => { if (active && !heard) setUpdate(state); }, () => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  const ready = update.ready;
  useEffect(() => {
    if (!bridge || !asked || !ready) return;
    setAsked(false);
    restartInto(bridge, setRestarting);
  }, [bridge, asked, ready]);

  const spot: SpotState = bridge ? spotFor(update, asked, restarting) : { kind: "feedback" };

  const act = () => {
    if (spot.kind === "feedback") return openFeedback();
    if (!bridge) return;
    if (spot.kind === "restart") return restartInto(bridge, setRestarting);
    if (spot.kind === "failed" || spot.kind === "manual") return void (bridge.open ? bridge.open() : openExternalLink(DOWNLOAD_PAGE));
    if (spot.kind === "move") return void bridge.move?.();
    if (spot.kind !== "available") return;
    setAsked(true);
    void bridge.download?.().then(found => { if (!found) setAsked(false); }, () => setAsked(false));
  };
  return { spot, act, updated: bridge ? update.updated ?? null : null, seen: () => void bridge?.seen?.(), bridge };
}

const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const PRESS = "transition-[background-color,transform] duration-150 ease-[ease] active:scale-[0.98] motion-reduce:active:scale-100";
// the same pill as Connect apps below it: a hairline, the composer fill, and a tint laid over it on hover
const TONAL = `border border-ink/[0.08] bg-composer ${GROK_HOVER_TINT}`;
const BLUE = "bg-accent text-accent-ink hover:bg-[color-mix(in_srgb,var(--color-accent)_90%,black)] disabled:cursor-progress";

function spotWords(spot: Exclude<SpotState, { kind: "feedback" }>): { title: string; end: ReactNode; hint?: string } {
  if (spot.kind === "restart") return { title: t("appUpdate.restart"), end: spot.version, hint: t("appUpdate.title", { version: spot.version }) };
  if (spot.kind === "checking") return { title: t("appUpdate.checking"), end: null };
  if (spot.kind === "downloading") return { title: t("appUpdate.downloadingShort"), end: spot.percent === null ? spot.version : t("appUpdate.percent", { percent: spot.percent }) };
  if (spot.kind === "retrying") return { title: t("appUpdate.retrying"), end: spot.percent === null ? spot.version : t("appUpdate.percent", { percent: spot.percent }), hint: t("appUpdate.retryingHint") };
  if (spot.kind === "failed") return { title: t("appUpdate.failed"), end: spot.version, hint: t("appUpdate.failedHint", { version: spot.version }) };
  if (spot.kind === "move") return { title: t("appUpdate.move"), end: spot.version, hint: t("appUpdate.moveHint", { app: productName() }) };
  if (spot.kind === "manual") return { title: t("appUpdate.manual", { version: spot.version }), end: null, hint: t("appUpdate.manualHint", { version: spot.version }) };
  return { title: t("appUpdate.available", { version: spot.version }), end: null };
}

/** Something worth a press that takes Give feedback's place while it applies (the dusk cloud nudge, lib/cloud-nudge.ts).
 * Its own close ends it, and Give feedback comes back. An update always goes first. */
export interface SpotCta {
  /** names the offer on the card, `data-spot-cta` */
  id: string;
  title: string;
  hint?: string;
  art: ArtName;
  closeLabel: string;
  /** drawn as the website sidebar's dusk cloud card instead of the one-line card; `title` only for the invested pitch */
  card?: { title?: string; body: string; action: string; invested: boolean };
  onStart: () => void;
  onClose: () => void;
}

/** The website sidebar's dusk cloud card in the spot: a mascot beside one line (or the person's own numbers), the action
 * under them, and a close that brings Give feedback back. */
export function SpotCloudCard({ cta, card }: { cta: SpotCta; card: NonNullable<SpotCta["card"]> }) {
  return (
    <div data-sidebar-spot="cta" data-spot-cta={cta.id} data-spot-card="" data-invested={card.invested ? "" : undefined}
      className="relative rounded-[20px] border border-ink/[0.08] bg-composer p-4 transition-[opacity,transform] duration-200 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:starting:translate-y-0">
      <div className="flex items-center gap-3 pe-5">
        <span aria-hidden="true" className="flex shrink-0">
          {card.invested
            ? <MausAvatar color="blue" bodyId="kit" size={34} state="celebrate" animated={false} trackPointer={false} />
            : <MausAvatar color="purple" bodyId="wisp" size={34} state="sleeping" animated={false} trackPointer={false} />}
        </span>
        <div className="min-w-0">
          {card.title && <p className="m-0 text-[14px] font-semibold leading-[1.3] text-ink">{card.title}</p>}
          <p className={cn("m-0 text-[13px] font-medium leading-[1.4] text-ink-secondary", card.title && "mt-0.5")}>{card.body}</p>
        </div>
      </div>
      <button type="button" data-spot-cta-start="" onClick={cta.onStart} className={cn(mdPrimaryCls, "mt-3.5 w-full")}>{card.action}</button>
      <button type="button" data-spot-cta-close="" aria-label={cta.closeLabel} title={cta.closeLabel} onClick={cta.onClose}
        className="absolute end-2 top-2 flex size-7 cursor-pointer items-center justify-center rounded-full text-ink/56 transition-[background-color,color] duration-[120ms] ease-[ease] hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

const CARD = cn("flex h-9 w-full items-center gap-2.5 rounded-full ps-[15px] pe-3.5 text-start", PRESS, FOCUS);

/** Give feedback, the update, or an offer: the same one-line card each time, so the spot only changes state. */
export function SidebarSpot({ className, bridge, cta = null }: { className?: string; bridge?: AppUpdateBridge; cta?: SpotCta | null }) {
  return <SpotView className={className} state={useSidebarSpot(bridge ?? ownBridge())} cta={cta} />;
}

export function SpotView({ className, state, cta = null }: { className?: string; state: ReturnType<typeof useSidebarSpot>; cta?: SpotCta | null }) {
  const { spot, act, updated, seen } = state;
  return (
    <div className={className}>
      {updated && spot.kind === "feedback" && <UpdatedNote version={updated} seen={seen} />}
      {spot.kind !== "feedback" ? <UpdateCard spot={spot} act={act} className={CARD} />
        : cta ? (cta.card ? <SpotCloudCard cta={cta} card={cta.card} /> : <SpotCtaCard cta={cta} />)
        : (
          <button type="button" data-sidebar-spot="feedback" data-art-hover="" onClick={act} className={cn(CARD, TONAL)}>
            <Art name="bubbles" className="h-[18px] w-[18px] shrink-0 object-contain" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-ink">{t("giveFeedback.card")}</span>
          </button>
        )}
    </div>
  );
}

/** the offer as the feedback card's twin, with a close at its end; the close sits beside the card's button, never in it */
export function SpotCtaCard({ cta }: { cta: SpotCta }) {
  return (
    <div data-sidebar-spot="cta" data-spot-cta={cta.id} className="relative">
      <button type="button" data-spot-cta-start="" data-art-hover="" title={cta.hint} onClick={cta.onStart} className={cn(CARD, TONAL, "pe-10")}>
        <Art name={cta.art} className="h-5 w-5 shrink-0 object-contain" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-ink">{cta.title}</span>
      </button>
      <button type="button" data-spot-cta-close="" aria-label={cta.closeLabel} title={cta.closeLabel} onClick={cta.onClose}
        className="absolute end-1.5 top-1/2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-ink/56 transition-[background-color,color] duration-[120ms] ease-[ease] hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function UpdateCard({ spot, act, className }: { spot: Exclude<SpotState, { kind: "feedback" }>; act: () => void; className: string }) {
  const { title, end, hint } = spotWords(spot);
  const busy = spot.kind === "downloading" || spot.kind === "retrying" || spot.kind === "checking" || (spot.kind === "restart" && spot.restarting);
  return (
    <button
      type="button"
      data-sidebar-spot="update"
      data-app-update={spot.version ?? undefined}
      data-app-update-state={spot.kind}
      title={hint}
      aria-busy={busy || undefined}
      disabled={spot.kind === "restart" && spot.restarting}
      onClick={act}
      className={cn(className, "@container relative isolate overflow-hidden", BLUE)}
    >
      {(spot.kind === "downloading" || spot.kind === "retrying") && spot.percent !== null && (
        <span aria-hidden="true" data-app-update-progress="" className="absolute inset-0 -z-10 origin-left bg-[color-mix(in_srgb,var(--color-accent)_80%,black)] transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleX(${spot.percent / 100})` }} />
      )}
      <Art name="parcel" className="h-5 w-5 shrink-0 object-contain" />
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5">{title}</span>
      {end !== null && <span className="hidden shrink-0 text-[12px] tabular-nums leading-4 text-accent-ink/75 @min-[13.5rem]:inline">{end}</span>}
    </button>
  );
}

/** The collapsed sidebar's form of the same spot: one round button over the account's. */
export function RailSpot({ bridge }: { bridge?: AppUpdateBridge }) {
  const { spot, act } = useSidebarSpot(bridge ?? ownBridge());
  // the collapsed rail keeps no Give feedback: only an update takes this spot
  if (spot.kind === "feedback") return null;
  const label = spotWords(spot).title;
  return (
    <button
      type="button"
      data-sidebar-spot="update"
      data-art-hover=""
      aria-label={spot.version ? `${label}, ${spot.version}` : label}
      title={label}
      aria-busy={spot.kind === "downloading" || spot.kind === "retrying" || spot.kind === "checking" || undefined}
      onClick={act}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", PRESS, FOCUS, BLUE)}
    >
      <Art name="parcel" className="h-[18px] object-contain" />
    </button>
  );
}

const NOTE_MS = 20_000;

export function UpdatedNote({ version, seen }: { version: string; seen: () => void }) {
  const said = useRef(seen);
  said.current = seen;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => { if (!timer && document.visibilityState === "visible") timer = setTimeout(() => said.current(), NOTE_MS); };
    look();
    document.addEventListener("visibilitychange", look);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", look); };
  }, [version]);
  return (
    <button
      type="button"
      data-app-updated={version}
      onClick={seen}
      className="mb-1 flex items-center gap-1.5 rounded-full px-3 py-[5px] text-[13px] leading-4 text-ink-secondary transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <Check size={13} aria-hidden="true" />
      {t("updates.updated", { version })}
    </button>
  );
}
