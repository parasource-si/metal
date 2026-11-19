// Adapted from pingdotgg/t3code@00cdceb1 apps/web/src/components/preview/AgentBrowserCursor.tsx (AgentCursorMark) and
// agentBrowserCursorLogic.ts, MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE);
// modified: Metal's colours; glides on springs (x softer than y, so a long move arcs a little), one ring per click.
import { MousePointer2 } from "../../icons";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { EASE_OUT, SPRING } from "@/lib/motion-presets";
import { useMotionReduced } from "../ui/SheetMotion";

const CURSOR_ACTIVE_MS = 700;

export type CursorController = "human" | "agent" | "none";

export function agentCursorOpacity(active: boolean, controller: CursorController): number {
  if (active) return 1;
  return controller === "human" ? 0.18 : 0.35;
}

/** The bot's pointer at a surface position; it fades once the bot stops acting. */
export function AgentCursor({ phase, sequence, left, top, controller }: {
  phase: "move" | "click";
  sequence: number;
  left: number;
  top: number;
  controller: CursorController;
}) {
  const [inactiveSequence, setInactiveSequence] = useState<number | null>(null);
  const active = inactiveSequence !== sequence;
  useEffect(() => {
    const timeout = window.setTimeout(() => setInactiveSequence(sequence), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [sequence]);
  const reduced = useMotionReduced();
  return (
    <motion.div
      className="pointer-events-none absolute left-0 top-0 z-30"
      initial={false}
      animate={{ x: left, y: top, opacity: agentCursorOpacity(active, controller) }}
      transition={reduced
        ? { x: { duration: 0 }, y: { duration: 0 }, opacity: { duration: 0.15, ease: EASE_OUT } }
        : { x: SPRING.soft, y: SPRING.settle, opacity: { duration: 0.15, ease: EASE_OUT } }}
      aria-hidden="true"
      data-agent-cursor
    >
      {phase === "click" && !reduced ? (
        <motion.span key={sequence} className="absolute -left-2.5 -top-2.5 size-6 rounded-full border-2 border-accent/50"
          initial={{ opacity: 1, scale: 0.5 }} animate={{ opacity: 0, scale: 1.8 }} transition={{ duration: 0.4, ease: EASE_OUT }} />
      ) : null}
      <motion.span key={phase === "click" ? `press${sequence}` : "pointer"} className="relative block origin-top-left"
        initial={phase === "click" && !reduced ? { scale: 0.86 } : false} animate={{ scale: 1 }} transition={SPRING.pop}>
        <MousePointer2 className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-card text-accent drop-shadow-sm" strokeWidth={2} />
      </motion.span>
    </motion.div>
  );
}
