// What a browser tells a bot's call it does not run, by design: the bot reads these as the call's result.

export const BROWSER_RESTART_TOOL = "restart_browser";
export const BROWSER_CONTROL_REFUSAL = "Browser tools are paused while a person controls this browser. Wait for them to hand control back; do not try another browser or execution tool.";
export const BROWSER_INTERRUPTED = `The browser engine is stuck. Press Restart in the Browser panel, or call ${BROWSER_RESTART_TOOL}, before using browser tools again.`;
export const BROWSER_CLOSING = "The browser is closing. Try again shortly.";
export const RESTART_BUSY = "The browser is busy. Wait for current work to finish before restarting.";
export const LAUNCH_CHANGED = "Browser launch settings changed. Close the browser before reconnecting.";
export const AGENT_CLOSE_FAILED = "The browser could not be closed. Ask the person to press Restart in the Browser panel of Metal on their computer, or to restart Metal.";
export const LANE_BUSY = "Your previous browser call is still running; wait for it to finish, then call again.";
export const PERSON_RESTART_STOPPED = "The person restarted your browser from the Browser panel while this call ran, so it stopped. Pages you had open are gone: open the page you need again, and check whether this action already happened before repeating it.";

/** A call not run by design: the bot reads its words as the call's result. */
export class RefusedCall extends Error {}

/** A by-design answer about a person's hold on a tab: the bot reads its words as the call's result. */
export class PersonHoldAnswer extends RefusedCall {}

/** `where` is "tab t2", or "the browser" where the engine has no tabs of its own. */
export function personUsedTab(where: string): string {
  return `The person used ${where} while this call waited, and has handed it back. The page may have changed, so this call did not run: take a fresh snapshot of ${where} before acting on it, and do not undo what they did.`;
}

export function personStillHolds(where: string, waitedMs: number): string {
  return `The person still holds ${where} after ${Math.max(1, Math.round(waitedMs / 1_000))} s, so this call did not run.${where.startsWith("tab ") ? " Other tabs still work meanwhile." : ""} Call again to keep waiting for them to hand it back.`;
}

export function personTookTab(where: string): string {
  return `The person took control of ${where} while this call ran, so it stopped; it may already have taken effect. Your next call on ${where} waits until they hand it back${where.startsWith("tab ") ? "; other tabs still work" : ""}.`;
}

const KNOWN = new Set([BROWSER_CONTROL_REFUSAL, BROWSER_INTERRUPTED, BROWSER_CLOSING, RESTART_BUSY, LAUNCH_CHANGED, AGENT_CLOSE_FAILED, LANE_BUSY]);

/** The words of a refusal by design, or null for a fault, which stays an error (a 500 with its reason in the trail). */
export function browserRefusal(error: unknown): string | null {
  if (!(error instanceof Error) || typeof (error as { status?: unknown }).status === "number") return null;
  return error instanceof RefusedCall || KNOWN.has(error.message) || error.message.startsWith("This browser cannot ") ? error.message : null;
}
