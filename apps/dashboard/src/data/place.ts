import type { Freshness } from "../../../../shared/dashboard-protocol.ts";
import { ago } from "../lib/format.ts";
import type { CloudDesktop } from "./contracts.ts";

export type PlaceTone = "good" | "warn" | "quiet" | "accent" | "bad";
export interface PlaceState { label: string; tone: PlaceTone; live: boolean }

/** how a workspace reads to its owner. a dusk cloud follows the cloud itself: one we put to sleep to save cost
 *  reads online (any use wakes it), and only its owner's own pause reads stopped. a mac or server that went
 *  quiet just says when it was last seen, never an alarming "offline" */
export function placeState(freshness: Freshness, at: number | null, now: number, cloud?: CloudDesktop | null): PlaceState {
  if (cloud) {
    if (cloud.awaitingPayment) return { label: "waiting for payment", tone: "quiet", live: false };
    if (cloud.status === "running") return { label: "online", tone: "good", live: true };
    if (cloud.status === "waking") return { label: "waking up", tone: "warn", live: true };
    if (cloud.status === "provisioning") return { label: "setting up", tone: "accent", live: true };
    if (cloud.status === "error") return { label: "needs attention", tone: "bad", live: false };
    return { label: "stopped", tone: "quiet", live: false };
  }
  if (freshness === "live") return { label: "online", tone: "good", live: true };
  if (freshness === "recent") return { label: `updated ${ago(at, now)}`, tone: "warn", live: false };
  if (freshness === "offline") return { label: `last seen ${ago(at, now)}`, tone: "quiet", live: false };
  return { label: "waiting for its first report", tone: "quiet", live: false };
}

export const TONE_TEXT: Record<PlaceTone, string> = { good: "text-good", warn: "text-warn", quiet: "text-ink-4", accent: "text-accent", bad: "text-bad" };

/** the freshness bots should wake or sleep by: a running cloud's bots are awake even before its first report lands */
export const botFreshness = (freshness: Freshness, cloud?: CloudDesktop | null): Freshness | undefined => (cloud?.status === "running" ? undefined : freshness);

/** whether an action for a workspace can go now: "ready"; "wake" for a dusk cloud we put to sleep (the action wakes it
 *  first, as any use does); "away" only for a cloud its owner stopped, or a mac or server that went quiet */
export type Reach = "ready" | "wake" | "away";
export function reachOf(freshness: Freshness, cloud?: CloudDesktop | null): Reach {
  if (cloud) {
    if (cloud.resting || cloud.status === "waking") return "wake";
    return cloud.status === "running" ? "ready" : "away";
  }
  return freshness === "offline" || freshness === "waiting" ? "away" : "ready";
}

/** what to say when an action can't go now, in the place's own terms */
export function awayLine(ws: { name: string; kind: string }, cloud?: CloudDesktop | null): string {
  if (cloud) {
    if (cloud.awaitingPayment) return `${ws.name} is waiting for payment. finish it in dusk cloud, then try again.`;
    if (cloud.status === "provisioning") return `${ws.name} is still being set up. try again in a few minutes.`;
    if (cloud.status === "error") return `${ws.name} needs attention. open dusk cloud to see why.`;
    return `${ws.name} is turned off. turn it on in dusk cloud, then try again.`;
  }
  return ws.kind === "vps" ? `${ws.name} is not answering. check that Metal is running there, then try again.` : `${ws.name} is asleep. open Metal on it, then try again.`;
}
