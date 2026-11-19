// "This computer" is the desktop app's own computer, and only the server the app launched may drive it. The app proves
// that by handing the driver connection to that one child over Electron's private utility-process port, which only the
// app's main process can write to and which plain Node never has. No file, environment variable or HTTP route supplies
// it, so a second Metal server on the same computer (a copy run from source, a demo, a test) never finds this
// computer, even with the app's own record of its driver in reach.
import { COMPUTER_HELPER_APP, permissionHolder, THIS_COMPUTER_NOT_GRANTED, THIS_COMPUTER_NOT_READY } from "../shared/your-computer.ts";
import { cuaUnavailableReason, decodeCuaConnection, type LocalComputerConnection } from "./local-computer.ts";

export const DESKTOP_COMPUTER_GRANT = "duskbot:local-computer";

export interface DesktopComputer {
  /** Only ever called with a message from the parent port; true when it was this grant. */
  receive(message: unknown): boolean;
  connection(): LocalComputerConnection | null;
  /** Waits only for the parent's initial pending grant, never a terminal failure or an unowned server. */
  waitForConnection(options?: { signal?: AbortSignal; timeoutMs?: number; isCurrent?: () => boolean }): Promise<LocalComputerConnection | null>;
  /** Whether the desktop app has spoken: false on any server it did not launch. */
  granted(): boolean;
  unavailableReason(): string | null;
}

export function createDesktopComputer({
  platform = process.platform,
  decode = decodeCuaConnection,
}: {
  platform?: NodeJS.Platform;
  decode?: typeof decodeCuaConnection;
} = {}): DesktopComputer {
  let record: unknown = null;
  let heard = false;
  const changed = new Set<() => void>();
  const connection = () => (record ? decode(record, { platform }) : null);
  return {
    receive(message) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return false;
      const grant = message as Record<string, unknown>;
      if (grant.type !== DESKTOP_COMPUTER_GRANT) return false;
      const connection = grant.connection;
      if (connection !== null && (typeof connection !== "object" || Array.isArray(connection))) {
        throw new Error("invalid local computer grant");
      }
      record = connection;
      heard = true;
      for (const notify of changed) notify();
      return true;
    },
    // Decoded on every use: a Linux driver is checked again (same binary, live processes) each time, as the file was.
    connection,
    waitForConnection({ signal, timeoutMs = 15_000, isCurrent = () => true } = {}) {
      signal?.throwIfAborted();
      if (!isCurrent()) return Promise.reject(new DOMException("Computer setup cancelled", "AbortError"));
      if (!heard || record !== null) return Promise.resolve(connection());
      return new Promise((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timeout);
          clearInterval(cancelled);
          changed.delete(update);
          signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(connection());
        };
        const abort = () => finish(signal?.reason ?? new DOMException("Computer setup cancelled", "AbortError"));
        const update = () => {
          if (!isCurrent()) finish(new DOMException("Computer setup cancelled", "AbortError"));
          else if (record !== null) finish();
        };
        const timeout = setTimeout(() => finish(), timeoutMs);
        const cancelled = setInterval(update, 100);
        timeout.unref?.();
        cancelled.unref?.();
        changed.add(update);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
    granted: () => heard,
    unavailableReason: () => (record ? cuaUnavailableReason(record, platform) : null),
  };
}

/** The one this server hears from, if it was launched by the desktop app. */
export const desktopComputer = createDesktopComputer();

/** The macOS grants this Mac's driver waits for, by name: empty when it is ready, not this app's, or waits on anything else. */
export function missingScreenPermissions(desktop: DesktopComputer = desktopComputer, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin" || !desktop.granted() || desktop.connection()) return [];
  const reason = desktop.unavailableReason() ?? "";
  if (!/(?:Screen Recording|Accessibility).*required/i.test(reason)) return [];
  return ["Screen Recording", "Accessibility"].filter((name) => reason.includes(name));
}

/** Why a turn cannot use this computer, in words for the person and the bot alike. */
export function thisComputerNotReady(desktop: DesktopComputer = desktopComputer, platform: NodeJS.Platform = process.platform): string {
  if (!desktop.granted()) return THIS_COMPUTER_NOT_GRANTED;
  const reason = desktop.unavailableReason();
  if (!reason) return `${THIS_COMPUTER_NOT_READY}make sure Metal has the permissions it asks for, then restart it`;
  const permission = platform === "darwin" && /(?:Screen Recording|Accessibility).*required/i.test(reason);
  if (permission) {
    const missing = [reason.includes("Screen Recording") && "Screen Recording", reason.includes("Accessibility") && "Accessibility"].filter(Boolean) as string[];
    const holder = permissionHolder(reason);
    // "<grant> required" first: the app reads it to offer the right System Settings pane
    const where = missing.map((name) => `Privacy & Security > ${name}`).join(" and ");
    const after = holder === COMPUTER_HELPER_APP ? "Metal notices by itself, no restart needed." : "then quit and reopen Metal.";
    return `${THIS_COMPUTER_NOT_READY}${missing.join(" and ")} required. Turn on ${holder} in System Settings > ${where}; ${after}`;
  }
  if (platform === "darwin") return `${THIS_COMPUTER_NOT_READY}the computer helper did not answer. Press Retry in Settings > Computer; if it still fails, quit and reopen Metal.`;
  return `${THIS_COMPUTER_NOT_READY}${reason}`;
}
