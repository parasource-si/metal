// The first-run funnel's frame (back, progress, a step that arrives piece by piece) and its simpler steps:
// the welcome, where bots live, the phone, and the help-improve line on the last screen.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { ChevronLeft, Check } from "../../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useHelpImprove } from "@/lib/help-improve";
import { minutesLeft } from "@/lib/pairing-time";
import { companionBridge } from "@/lib/companion-bridge";
import { requireUserPresence } from "@/lib/user-presence";
import { api } from "@/state/store";
import type { MobileDevice, MobilePairingRequest, MobilePairingResponse } from "../../../shared/mobile-link";
import { MausAvatar } from "../Avatar";
import { usePrefersReducedMotion } from "../mascot-clock";
import { Art, type ArtName } from "../ui/Art";
import { PlaceArt, type PlaceArtName } from "../ui/PlaceArt";
import { Toggle } from "../ui/Toggle";
import { DEFAULT_BOT_NAME } from "@/lib/default-bot";
import { MAC_TRAFFIC_LIGHT_CLEAR_X, useDesktopCapabilities } from "../DesktopCapabilities";
import phoneHome from "../../assets/onboarding/phone-home.webp";
import { friendlyError } from "@/lib/plain-error";

export const PRIMARY = "ui-button ui-button-pill ui-button-lg ui-button-primary w-[288px] max-w-full font-normal tracking-[0.14px]";
/** The quiet way past a step that still reads as a button: a soft fill, no outline. */
export const SECONDARY = "ui-button ui-button-pill ui-button-lg w-[288px] max-w-full font-normal tracking-[0.14px]";
export const QUIET = "min-h-11 rounded-full px-3 text-[13px] leading-[18px] text-ink-secondary transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";
/** A tonal choice: a soft fill, no outline, a deeper fill on hover and while chosen. */
export const TILE = "rounded-2xl bg-ink/[0.035] transition-[background-color,transform] duration-150 ease-[ease] hover:bg-ink/[0.06] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none motion-reduce:active:scale-100";

// the brand's lilac, a shade deeper than the pastel so the mark reads on the light canvas
export const BRAND_LILAC: [string, string, string] = ["#d0cefb", "#b99af2", "#d0cefb"];

/** Back, and how far along the setup is, over every step but the first. */
export function FunnelBar({ at, count, onBack }: { at: number; count: number; onBack: (() => void) | null }) {
  // on macOS Back starts clear of the traffic lights, which sit over the window's top left corner (the rail beside the
  // page, when there is one, already holds them)
  const lights = useDesktopCapabilities().capabilities.windowChrome === "mac-inset";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-center px-4">
      {onBack && (
        <button type="button" data-funnel-back={lights ? "clear-of-traffic-lights" : ""} onClick={onBack}
          style={lights ? { left: `max(16px, calc(${MAC_TRAFFIC_LIGHT_CLEAR_X}px - var(--rail-beside, 0px)))` } : undefined}
          className="pointer-events-auto absolute start-4 inline-flex min-h-11 items-center gap-0.5 rounded-full py-1 pe-3 ps-1.5 text-[13px] leading-[18px] text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
          <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" className="rtl:-scale-x-100" />{t("funnel.back")}
        </button>
      )}
      <div role="progressbar" aria-label={t("funnel.progress")} aria-valuemin={1} aria-valuemax={count} aria-valuenow={at + 1}
        aria-valuetext={t("funnel.progressAt", { at: String(at + 1), count: String(count) })} data-funnel-progress={`${at + 1}/${count}`}
        className="relative flex items-center gap-1.5">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} aria-hidden="true" className={cn("h-1 rounded-full bg-ink/12", index === at ? "w-6" : "w-3")} />
        ))}
        <ProgressInk at={at} />
      </div>
    </div>
  );
}

// the funnel's own springs (motion brief 2026-11): the stretchy pill's two edges, the done fill, the page cascade
const LEAD = { type: "spring", stiffness: 620, damping: 36 } as const;
const TRAIL = { type: "spring", stiffness: 190, damping: 19 } as const;
const SOFT = { type: "spring", stiffness: 260, damping: 24 } as const;
const DOT = 12, GAP = 6, WIDE = 24;

/** The progress drawn over the dots: the steps behind fill in, and the current one is an ink pill that stretches to its
 * new dot, the edge facing the move quick and the other catching up. Logical offsets, so it runs the right way in RTL. */
export function ProgressInk({ at }: { at: number }) {
  const reduced = useReducedMotion() === true;
  const start = at * (DOT + GAP);
  const from = useMotionValue(start), to = useMotionValue(start + WIDE), done = useMotionValue(Math.max(0, start - GAP));
  const first = useRef(true);
  useLayoutEffect(() => {
    const end = start + WIDE, fill = Math.max(0, start - GAP);
    if (first.current || reduced) { from.set(start); to.set(end); done.set(fill); first.current = false; return; }
    const forward = start >= from.get();
    const moves = [animate(from, start, forward ? TRAIL : LEAD), animate(to, end, forward ? LEAD : TRAIL), animate(done, fill, SOFT)];
    return () => moves.forEach((move) => move.stop());
  }, [start, reduced, from, to, done]);
  const inset = useTransform(from, (v) => `${v}px`);
  const width = useTransform(() => `${Math.max(0, to.get() - from.get())}px`);
  const doneWidth = useTransform(done, (v) => `${v}px`);
  return <>
    <motion.span aria-hidden="true" className="absolute inset-y-0 start-0 rounded-full bg-ink/45" style={{ width: doneWidth }} />
    <motion.span aria-hidden="true" className="absolute inset-y-0 rounded-full bg-ink" style={{ insetInlineStart: inset, width }} />
  </>;
}

/** One piece of a step arriving: the art first, then the title, the line, what to do and the way on, 45ms apart, each
 * rising 12px out of a 4px blur on the enter spring. Under reduced motion they only fade. */
function useCascade() {
  const reduced = useReducedMotion() === true;
  return (index: number) => {
    if (reduced) return { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const } };
    if (index === 0) return { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { type: "spring" as const, stiffness: 520, damping: 26 } };
    return {
      initial: { opacity: 0, y: 12, filter: "blur(4px)" },
      animate: { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } },
      transition: { type: "spring" as const, stiffness: 300, damping: 22, delay: 0.06 + index * 0.045 },
    };
  };
}

/** One step's page: a picture that explains it, the title, a short line, what to do, and the way on. */
export function StepFrame({ art, title, sub, children, footer, wide = false }: {
  art?: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const rise = useCascade();
  return (
    <div data-step-cascade="" className={cn("mx-auto my-auto flex w-full flex-col items-center px-6 pt-20 text-center", footer ? "pb-6" : "pb-12", wide ? "max-w-[640px]" : "max-w-[520px]")}>
      {art && <motion.div aria-hidden="true" className="mb-6 flex h-16 items-end justify-center" {...rise(0)}>{art}</motion.div>}
      <motion.h1 id="welcome-title" tabIndex={-1} className="text-balance text-[28px] font-normal leading-[34px] tracking-[-0.02em] text-ink outline-none" {...rise(1)}>{title}</motion.h1>
      {sub && <motion.p className="mt-2 max-w-[420px] text-pretty text-[15px] leading-[22px] text-ink-secondary" {...rise(2)}>{sub}</motion.p>}
      {children && <motion.div className="mt-8 flex w-full flex-col items-center" {...rise(3)}>{children}</motion.div>}
      {/* a step taller than the window keeps its way on in view, over the content scrolling under it */}
      {footer && <motion.div data-step-footer="" className="sticky bottom-0 z-[1] mt-4 flex w-full flex-col items-center gap-2 bg-app pb-6 pt-4" {...rise(4)}>{footer}</motion.div>}
    </div>
  );
}

/** Pixel art from either set, at the step's size. */
export function StepArt({ art, place }: { art?: ArtName; place?: PlaceArtName }) {
  if (place) return <PlaceArt name={place} size={60} className="place-mark" />;
  return art ? <Art name={art} size="xl" className="place-mark h-16" /> : null;
}

/** "help improve Metal": on by default (an opt-out), small and muted, saved the moment it is switched. Shown at the foot
 * of the place step, a quick screen, never on one people wait on. */
export function ImproveSwitch() {
  const improve = useHelpImprove("first_run");
  const id = useId();
  if (typeof improve.on !== "boolean") return null;
  return (
    <div data-help-improve="" className="flex max-w-[420px] items-start gap-2.5 text-start text-[12px] leading-4 text-ink-tertiary">
      <Toggle checked={improve.on} aria-labelledby={id} onClick={() => void improve.set(!improve.on)} className="mt-px" />
      <span id={id}>{t("helperIntro.improve")}</span>
      {improve.failed && <span role="alert" className="sr-only">{t("settings.dataSharing.error")}</span>}
    </div>
  );
}

/** The hello. On a cloud the desktop app set up it greets the person by the name and picture that computer knows. */
export function WelcomeStep({ onStart, cloud }: { onStart: () => void; cloud?: { name: string; picture?: string } }) {
  const reduced = usePrefersReducedMotion();
  const art = cloud?.picture
    ? <img src={cloud.picture} alt="" data-welcome-picture="" className="size-[72px] rounded-full object-cover" />
    : <MausAvatar color="purple" gradient={BRAND_LILAC} size={72} state="excited" animated={!reduced} label={DEFAULT_BOT_NAME} />;
  return (
    <div className="flex min-h-full w-full flex-col">
      <StepFrame
        art={art}
        title={cloud ? (cloud.name ? t("funnel.welcome.cloudNamed", { name: cloud.name }) : t("funnel.welcome.cloud")) : t("funnel.welcome.title")}
        sub={cloud ? t("funnel.welcome.cloudSub") : t("funnel.welcome.sub")}
        footer={<button type="button" data-primary="" data-funnel-start="" autoFocus onClick={onStart} className={PRIMARY}>{t("funnel.welcome.start")}</button>}
      />
    </div>
  );
}

function PlaceChoice({ kind, art, title, sub, tag, note, onClick }: { kind: string; art: PlaceArtName; title: string; sub: string; tag: string; note?: string | null; onClick: () => void }) {
  return (
    <button type="button" data-funnel-place={kind} onClick={onClick} className={cn(TILE, "flex min-w-0 flex-1 flex-col items-start gap-3 p-5 text-start")}>
      <span className="flex w-full items-start justify-between gap-2">
        <PlaceArt name={art} size={44} />
        <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[12px] leading-4 text-ink-secondary">{tag}</span>
      </span>
      <span className="text-[15px] font-semibold leading-5 text-ink">{title}</span>
      <span className="text-[13px] leading-[18px] text-ink-secondary">{sub}</span>
      {note && <span data-funnel-place-note="" className="text-[12px] leading-4 text-ink-tertiary">{note}</span>}
    </button>
  );
}

/** The desktop app's first screen: Metal says hello and asks the one question that shapes the rest, where the bots
 * live. dusk cloud's tile says its trial and price before anything is asked for. */
export function PlaceStep({ onMac, onCloud, onServer, cloudTag, cloudNote }: {
  onMac: () => void; onCloud: () => void; onServer: () => void;
  /** "7 days free" or "From $15/month" once the offer is known */
  cloudTag?: string | null;
  /** the price after the trial, in full */
  cloudNote?: string | null;
}) {
  const reduced = usePrefersReducedMotion();
  return (
    <StepFrame title={t("funnel.place.title")} sub={t("funnel.place.hello")} wide
      art={<MausAvatar color="purple" gradient={BRAND_LILAC} size={64} state="excited" animated={!reduced} label={DEFAULT_BOT_NAME} />}
      footer={<>
        <button type="button" data-funnel-place="server" onClick={onServer} className={QUIET}>{t("funnel.place.server")}</button>
        {/* help improve: one quiet line on the quick first screen, never on a screen people wait on */}
      </>}>
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        <PlaceChoice kind="mac" art="mac" title={t("funnel.place.mac")} sub={t("funnel.place.macSub")} tag={t("funnel.place.macTag")} onClick={onMac} />
        <PlaceChoice kind="cloud" art="cloud" title={t("funnel.place.cloud")} sub={t("funnel.place.cloudSub")} tag={cloudTag ?? t("funnel.place.cloudTag")} note={cloudNote} onClick={onCloud} />
      </div>
    </StepFrame>
  );
}

type Pairing = { kind: "idle" } | { kind: "busy" } | { kind: "offer"; offer: MobilePairingResponse; before: string[] } | { kind: "linked"; name: string };

/** The phone: one press shows a QR code (after the desktop app checks someone is here), and it says when the phone joins. */
export function PhoneStep({ onNext }: { onNext: () => void }) {
  const [pairing, setPairing] = useState<Pairing>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const show = useCallback(async () => {
    setPairing({ kind: "busy" });
    setError(null);
    try {
      const { devices } = await api<{ devices: MobileDevice[] }>("/api/mobile/devices");
      if (!(await requireUserPresence())) { if (live.current) setPairing({ kind: "idle" }); return; }
      const request: MobilePairingRequest = {};
      const companion = companionBridge();
      if (companion) {
        try { request.companion = (await companion.start()).endpoints; } catch {}
      }
      const offer = await api<MobilePairingResponse>("/api/mobile/pairing", { method: "POST", body: JSON.stringify(request) });
      if (live.current) { setPairing({ kind: "offer", offer, before: devices.map((device) => device.id) }); setNow(Date.now()); }
    } catch (cause) {
      if (!live.current) return;
      setError(friendlyError(cause, t("settings.mobile.error")));
      setPairing({ kind: "idle" });
    }
  }, []);

  const waiting = pairing.kind === "offer" ? pairing : null;
  useEffect(() => {
    if (!waiting) return;
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    const poll = setInterval(() => {
      void api<{ devices: MobileDevice[] }>("/api/mobile/devices").then(({ devices }) => {
        const added = devices.find((device) => !waiting.before.includes(device.id));
        if (added && live.current) setPairing({ kind: "linked", name: added.name });
      }, () => {});
    }, 2_000);
    return () => { clearInterval(clock); clearInterval(poll); };
  }, [waiting]);

  const expired = waiting ? waiting.offer.expiresAt <= now : false;
  const code = waiting?.offer.code?.replace(/[^a-z0-9]/gi, "").match(/.{1,4}/g)?.join(" ");
  const showing = pairing.kind === "offer" && !expired;
  return (
    <div className="mx-auto my-auto flex w-full max-w-[760px] flex-col items-center gap-10 px-6 pb-12 pt-20 sm:flex-row sm:items-center sm:gap-14">
      <PhoneFrame />
      <div className="flex min-w-0 flex-1 flex-col items-center text-center sm:items-start sm:text-start">
        <h1 id="welcome-title" tabIndex={-1} className="text-balance text-[28px] font-normal leading-[34px] tracking-[-0.02em] text-ink outline-none">
          {pairing.kind === "linked" ? t("mobile.desktop.linked", { name: pairing.name }) : t("funnel.phone.title")}
        </h1>
        <p className="mt-2 max-w-[360px] text-pretty text-[15px] leading-[22px] text-ink-secondary">
          {pairing.kind === "linked" ? t("mobile.desktop.linkedHint") : showing ? t("funnel.phone.scan") : t("funnel.phone.sub")}
        </p>
        {showing && (
          <div data-phone-offer="" className="place-reveal mt-6 flex flex-col items-center gap-3 sm:items-start">
            <div role="img" aria-label={t("settings.mobile.qr")} className="rounded-[18px] bg-white p-2.5">
              <QRCodeSVG value={pairing.offer.link} size={152} level="M" includeMargin={false} bgColor="#ffffff" fgColor="#1b1b1f" aria-hidden="true" />
            </div>
            {code && <code aria-label={t("settings.mobile.code")} className="select-all whitespace-nowrap font-mono text-[17px] leading-7 tracking-[0.1em] text-ink">{code}</code>}
            <p role="status" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
              <span aria-hidden="true" className="funnel-wait inline-block size-1.5 rounded-full bg-ink" />
              {t("mobile.desktop.waiting")}
              <span className="text-ink-tertiary">· {t("settings.mobile.expires", { minutes: minutesLeft(pairing.offer.expiresAt, now) })}</span>
            </p>
          </div>
        )}
        {pairing.kind === "linked" && <span className="place-mark mt-6 grid size-12 place-items-center rounded-full bg-success/10 text-success"><Check size={24} aria-hidden="true" /></span>}
        {expired && <p role="status" className="mt-4 text-[13px] text-ink-secondary">{t("settings.mobile.expired")}</p>}
        {error && <p role="alert" className="mt-4 text-[13px] leading-[18px] text-danger">{error}</p>}
        <div className="mt-8 flex w-full flex-col items-center gap-2 sm:items-start">
          {pairing.kind === "linked" || showing
            ? <button type="button" data-primary="" data-funnel-done="" onClick={onNext} className={PRIMARY}>{pairing.kind === "linked" ? t("funnel.next") : t("funnel.phone.later")}</button>
            : <>
              <button type="button" data-primary="" data-funnel-phone="" disabled={pairing.kind === "busy"} onClick={() => void show()} className={PRIMARY}>
                {expired ? t("settings.mobile.newCode") : t("funnel.phone.show")}
              </button>
              <button type="button" data-funnel-skip="" onClick={onNext} className={SECONDARY}>{t("funnel.skip")}</button>
            </>}
        </div>
      </div>
    </div>
  );
}

/** The phone app's own home screen (a real capture of its bots list, demo bots), in a plain phone outline. */
function PhoneFrame() {
  return (
    <div aria-hidden="true" className="phone-frame w-[208px] shrink-0 rounded-[38px] bg-[#1b1b1f] p-[6px] shadow-[0_24px_48px_-24px_rgba(27,27,31,0.45)]">
      <div className="relative overflow-hidden rounded-[32px] bg-white">
        <img src={phoneHome} alt="" width={196} height={426} draggable={false} className="block h-auto w-full select-none" />
        <span className="absolute left-1/2 top-[7px] h-[18px] w-[64px] -translate-x-1/2 rounded-full bg-[#1b1b1f]" />
      </div>
    </div>
  );
}
