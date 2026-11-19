/** Completes "Metal wants to …" in the OS prompt. */
export const PAIRING_PRESENCE_REASON = "show a code that links a phone";

type PresenceBridge = {
  requireUserPresence?: (reason: string) => Promise<boolean>;
  confirm?: (message: string) => Promise<boolean>;
};

function currentBridge(): PresenceBridge | undefined {
  return typeof window === "undefined" ? undefined : (window.duskDesktop as PresenceBridge | undefined);
}

/**
 * Asks the desktop app to check that a person is at this computer before a pairing code is shown. Outside the desktop
 * app (a browser tab, the phone app) there is no OS check to ask for, so it answers true. An older desktop build without
 * the check gets a plain confirm. A check that errors answers false.
 */
export async function requireUserPresence(
  reason: string = PAIRING_PRESENCE_REASON,
  bridge: PresenceBridge | undefined = currentBridge(),
  pageConfirm: (message: string) => boolean = (message) => window.confirm(message),
): Promise<boolean> {
  if (!bridge) return true;
  try {
    if (typeof bridge.requireUserPresence === "function") return (await bridge.requireUserPresence(reason)) === true;
    const message = `Metal wants to ${reason}. Continue?`;
    if (typeof bridge.confirm === "function") return (await bridge.confirm(message)) === true;
    return pageConfirm(message) === true;
  } catch {
    return false;
  }
}
