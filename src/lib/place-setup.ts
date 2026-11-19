// Adding a place: dusk cloud, or a server of the person's own, linked by one line through the relay
// (electron/vps-link.mjs) or reached at an address it serves (main's connectHostedWorkspace).
import { useSyncExternalStore } from "react";
import type { VpsLinkView } from "./vps-link";

export type InstallPhase = "starting" | "waiting" | "found" | "connecting" | "done" | "failed" | "expired";

/** Where a one-line install stands, from main's link view: waiting for the server to check in, found it, setting it up,
 * done; or stopped (an error or a failed step) or out of time. */
export function installPhase(view: VpsLinkView, now: number): InstallPhase {
  if (view.server && (view.stage === "linked" || view.stage === "moving" || view.stage === "moved")) return "done";
  if (view.error || view.stage === "error" || view.steps.some((step) => step.status === "failed")) return "failed";
  if (view.stage === "installing") return view.steps.some((step) => step.status === "done" || step.status === "skipped") ? "connecting" : "found";
  if (view.stage === "command" && view.command) return view.expiresAt !== null && view.expiresAt <= now ? "expired" : "waiting";
  return "starting";
}

/** The four steps the sheet lists, each done, now or next. A stop keeps the step it stopped on as now. */
export function installChecklist(view: VpsLinkView, now: number): Array<{ key: "waiting" | "found" | "connecting" | "done"; state: "done" | "now" | "next" }> {
  const phase = installPhase(view, now);
  const order = ["waiting", "found", "connecting", "done"] as const;
  const reached = phase === "failed" || phase === "expired"
    ? (view.steps.some((step) => step.status === "done" || step.status === "skipped") ? "connecting" : view.steps.some((step) => step.status !== "waiting") ? "found" : "waiting")
    : phase === "starting" ? "waiting" : phase;
  const index = order.indexOf(reached);
  return order.map((key, step) => ({ key, state: phase === "done" || step < index ? "done" : step === index ? "now" : "next" }));
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CODE = /^([A-Z0-9]{4})-?([A-Z0-9]{4})-?([A-Z0-9]{4})$/;

function serverOrigin(typed: string): URL | null {
  let url: URL;
  // a bare loopback address is an SSH tunnel, which speaks plain http
  const scheme = /^(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)/i.test(typed) ? "http" : "https";
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `${scheme}://${typed}`); } catch { return null; }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.username || url.password || url.search || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return null;
  if (!loopback && !url.hostname.includes(".")) return null;
  return url;
}

function withCode(origin: string, code: string): { link: string } | { error: "code" } {
  const parts = CODE.exec(code.replace(/[\s-]+/g, "").toUpperCase());
  return parts ? { link: `${origin}/pair#code=${parts[1]}-${parts[2]}-${parts[3]}` } : { error: "code" };
}

/** The pairing link in what `metal pair` printed, pasted whole or as one line: its public https link before the
 * loopback one it also prints, which on this computer would name this app's own server. */
export function pastedPairingLink(text: string): string | null {
  const found = Array.from(text.matchAll(/https?:\/\/[^\s"'<>`]+?\/pair\/?#code=([A-Za-z0-9]{4}-?[A-Za-z0-9]{4}-?[A-Za-z0-9]{4})/g), (match) => {
    const url = serverOrigin(match[0].slice(0, match[0].indexOf("/pair")));
    const made = url ? withCode(url.origin, match[1]!) : null;
    return made && "link" in made ? { link: made.link, loopback: LOOPBACK.has(url!.hostname) } : null;
  }).filter((one) => one !== null);
  return (found.find((one) => !one.loopback) ?? found[0])?.link ?? null;
}

/** The pairing link main opens, from what the person typed: a pairing link (or the lines `metal pair` printed around
 * it), or an address (https, or plain http on this computer for an SSH tunnel) and an optional code. */
export function pairingLink(address: string, code: string): { link: string } | { error: "address" | "code" } {
  const typed = address.trim();
  if (!typed) return { error: "address" };
  if (/#code=/.test(typed)) {
    const link = pastedPairingLink(typed);
    return link ? { link } : { error: "address" };
  }
  const url = serverOrigin(typed);
  if (!url) return { error: "address" };
  if (!code.trim()) return { link: url.origin };
  return withCode(url.origin, code);
}

/** Where the sheet opens: the first choice, straight at a server's ways to connect, or at the recommended way's line
 *  (the welcome: a new person gets the one line, and the other ways are one "back" away). */
export type PlaceSetupStart = "choose" | "server" | "way:cloudflare";
let open: { start?: PlaceSetupStart } | null = null;
const watchers = new Set<() => void>();
const tell = () => { for (const watch of Array.from(watchers)) watch(); };
export function openPlaceSetup(start?: PlaceSetupStart): void { open = start ? { start } : {}; tell(); }
export function closePlaceSetup(): void { open = null; tell(); }
export function usePlaceSetupOpen(): { start?: PlaceSetupStart } | null {
  return useSyncExternalStore((watch) => { watchers.add(watch); return () => { watchers.delete(watch); }; }, () => open, () => null);
}
