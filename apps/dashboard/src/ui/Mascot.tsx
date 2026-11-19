import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { BotReport } from "../../../../shared/dashboard-protocol";
import { botMood, type BotMood } from "../data/mood";
import { createPixel, type PixelBot } from "@/pixel/engine";
import { pixelReaction, pixelState, pointerGaze, type MarkReaction, type MarkState } from "@/components/mascot-engine";
import { MASCOT_INK } from "@/lib/mascot";
import { cx } from "./kit";
import { duskBody } from "../../../../shared/body-migration";
import type { PixelBodyId } from "../../../../shared/pixel-bodies";

const query = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
export const useReducedMotion = () =>
  useSyncExternalStore((fn) => { query?.addEventListener("change", fn); return () => query?.removeEventListener("change", fn); }, () => query?.matches ?? false, () => false);

/** the bot colours, painted as the app paints its mascots; every colour a bot was ever saved with has one */
export const BOT_COLOURS = MASCOT_INK;
export type BotColour = keyof typeof BOT_COLOURS;
export const colorOf = (c: string | null | undefined): BotColour => (c && Object.hasOwn(BOT_COLOURS, c) ? (c as BotColour) : "blue");

export type BotState = MarkState | BotMood;
export type BotReaction = MarkReaction | "bounce" | "perk" | "shake" | "squish" | "dizzy" | "celebrate" | "blink";

export const bodyOf = (b: string | null | undefined): PixelBodyId => duskBody(b);

export interface MascotHandle { react(kind: BotReaction): void; lookAt(x: number | null, y?: number): void }

interface MascotProps {
  color?: BotColour | string;
  /** a pixel body, or any body id a bot was saved with */
  body?: string | null;
  size?: number;
  state?: BotState;
  label?: string;
  /** hold the rest pose: no motion, no blinking */
  still?: boolean;
  /** watch the pointer from up to this many px away (true is 260) */
  track?: boolean | number;
  /** look this way (-1..1, x right, y down) instead of at the pointer */
  gaze?: { x: number; y: number } | null;
  /** taps play a reaction */
  tappable?: boolean;
  className?: string;
}

// one pointer listener for every watching bot on the page
const watchers = new Map<Element, { bot: PixelBot; reach: number }>();
let pointerOn = false, moveFrame = 0, px = 0, py = 0;
function onPointer(e: PointerEvent) {
  px = e.clientX; py = e.clientY;
  if (moveFrame) return;
  moveFrame = requestAnimationFrame(() => {
    moveFrame = 0;
    for (const [el, w] of watchers) w.bot.look(pointerGaze(el.getBoundingClientRect(), px, py, w.reach));
  });
}
function watch(el: Element, bot: PixelBot, reach: number) {
  watchers.set(el, { bot, reach });
  if (!pointerOn) { pointerOn = true; window.addEventListener("pointermove", onPointer, { passive: true }); }
  return () => {
    watchers.delete(el);
    if (!watchers.size && pointerOn) { pointerOn = false; window.removeEventListener("pointermove", onPointer); }
  };
}

/** a pixel Metal: still at rest with blinks, lively while busy; it stops off screen and rests under reduced motion */
export const Mascot = forwardRef<MascotHandle, MascotProps>(function Mascot({ color = "blue", body, size = 28, state = "idle", label, still = false, track = false, gaze = null, tappable = false, className }, ref) {
  const el = useRef<HTMLSpanElement>(null);
  const bot = useRef<PixelBot | null>(null);
  const hovered = useRef(-Infinity);
  const name = bodyOf(body);
  const fill = Object.hasOwn(BOT_COLOURS, color) ? BOT_COLOURS[color as BotColour] : color;
  const latest = useRef({ fill, state });
  latest.current = { fill, state };
  useLayoutEffect(() => {
    if (!el.current) return;
    const made = createPixel(el.current, { body: name, size, colour: latest.current.fill, state: pixelState(latest.current.state), animated: !still });
    bot.current = made;
    return () => { made.destroy(); bot.current = null; };
  }, [name, still, size]);
  useLayoutEffect(() => { bot.current?.setState(pixelState(state)); }, [state, name, still, size]);
  useLayoutEffect(() => { bot.current?.setColour(fill); }, [fill]);
  const gx = gaze?.x, gy = gaze?.y;
  useEffect(() => {
    const made = bot.current;
    if (still || !el.current || !made) return;
    if (gx !== undefined && gy !== undefined) { made.look({ x: gx, y: gy }); return () => made.look(null); }
    if (track) return watch(el.current, made, track === true ? 260 : track);
  }, [track, still, name, size, gx, gy]);
  useImperativeHandle(ref, () => ({
    react: (kind) => {
      if (kind === "blink") return bot.current?.blink();
      const r = pixelReaction(kind);
      if (r === "poke") bot.current?.poke(); else if (r) bot.current?.react(r);
    },
    lookAt: (x, y) => bot.current?.look(x == null ? null : { x, y: y ?? 0 }),
  }), []);
  return (
    <span
      ref={el}
      className={cx("mascot relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      onPointerDown={tappable ? (e) => bot.current?.poke(e.clientX) : undefined}
      onPointerEnter={tappable && !still ? (e) => {
        // a mouse passing over says hello; at most every couple of seconds, and never under reduced motion
        if (e.pointerType !== "mouse" || query?.matches || e.timeStamp - hovered.current < 2000) return;
        hovered.current = e.timeStamp;
        const r = pixelReaction("perk");
        if (r && r !== "poke") bot.current?.react(r);
      } : undefined}
    />
  );
});

export function BotMascot({ bot, size = 28, mood, track = false, tappable = false }: { bot: Pick<BotReport, "color" | "body" | "busy" | "lastActiveAt">; size?: number; mood?: BotMood; track?: boolean | number; tappable?: boolean }) {
  return <Mascot color={colorOf(bot.color)} body={bot.body} size={size} state={mood ?? botMood(bot)} track={track} tappable={tappable} />;
}
