import type { CloudSendNotice, CloudSendPageBridge } from "../../electron/cloud-send.mjs";
import type { OneHomeView } from "../../electron/one-home.mjs";

/** The move's page bridge, in the desktop app only: never in a browser. */
export function moveOfferBridge(): CloudSendPageBridge | undefined {
  return typeof window !== "undefined" && !window.duskDesktop?.remoteClient?.active ? window.duskDesktop?.cloudSendPage : undefined;
}

/** Which ask the window shows by itself now: the sheet, the line at the top, or none (Settings keeps it either way). */
export function offerAsk(notice: CloudSendNotice | null | undefined): "prompt" | "banner" | null {
  const stage = notice?.offer?.stage;
  return stage === "prompt" || stage === "banner" ? stage : null;
}

export type MoveSheetState = "ask" | "moving" | "failed" | "done";

/** A fresh first run's move: Metal and its one welcome chat went, and nothing of the person's own, so there is no
 * All moved to say. Counts the move didn't report never read as nothing. */
export function movedNothing(move: Extract<OneHomeView, { phase: "done" }>): boolean {
  const counts = move.counts;
  if (!counts) return false;
  return counts.bots <= 1 && counts.chats <= 1 && !counts.skills && !counts.logins && !counts.routines && !counts.onePassword
    && !move.left?.length && !move.stayed?.length && !move.phone;
}

/** What the move sheet shows for the move's own view: on its way, stuck (one friendly line and Try again), or all moved.
 * A move to a server of the person's own has a line of its own instead. */
export function moveSheetState(move: OneHomeView | undefined): Exclude<MoveSheetState, "ask"> | null {
  if (!move || move.place) return null;
  if (move.phase === "done") return movedNothing(move) ? null : "done";
  if ("failing" in move && move.failing) return "failed";
  return ["copy", "wait", "finishing"].includes(move.phase) ? "moving" : null;
}

/** How far along the move looks, 0 to 1, from its phase and, while it copies, its chats: never a step or a count. */
export function moveProgress(move: OneHomeView | undefined): number {
  if (!move) return 0.04;
  if (move.phase === "done") return 1;
  if (move.phase === "finishing") return 0.9;
  if (move.phase === "wait") return 0.8;
  if (move.phase === "copy") {
    const chats = "chats" in move ? move.chats : undefined;
    return chats && chats.total > 0 ? 0.12 + 0.62 * Math.min(1, chats.done / chats.total) : 0.12;
  }
  return 0.04;
}

/** How many of the scene's `of` bots have hopped onto the cloud: the last one only once everything arrived. */
export function botsAcross(progress: number, of: number): number {
  if (progress >= 1) return of;
  return Math.max(0, Math.min(of - 1, Math.floor(progress * of)));
}
