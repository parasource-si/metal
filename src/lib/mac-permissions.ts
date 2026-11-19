export type MacPermission = "accessibility" | "screen";

/** "asked": macOS showed its own prompt already, so only System Settings can grant it now. */
export type MacPermissionState = "granted" | "asked" | "missing";

export type MacPermissionStatus =
  | { supported: false }
  | { supported: true; accessibility: MacPermissionState; screen: MacPermissionState };

export interface MacPermissionsBridge {
  status(): Promise<MacPermissionStatus>;
  /** Asks for one: macOS's prompt the first time, its System Settings pane after that. */
  request(kind: MacPermission): Promise<MacPermissionStatus>;
}

export const MAC_PERMISSIONS: readonly MacPermission[] = ["accessibility", "screen"];

/** This computer's own desktop app on macOS, where bots can use the Mac. */
export function macPermissionsBridge(): MacPermissionsBridge | null {
  const desktop = typeof window === "undefined" ? undefined : window.duskDesktop;
  if (!desktop || desktop.platform !== "darwin" || desktop.remoteClient?.active === true) return null;
  return desktop.macPermissions ?? null;
}

const PANES: Record<MacPermission, string> = { accessibility: "Privacy_Accessibility", screen: "Privacy_ScreenCapture" };

/** System Settings at this permission's own list, where any app (Metal or its helper) is turned on. */
export async function openMacPermissionPane(kind: MacPermission): Promise<void> {
  const desktop = typeof window === "undefined" ? undefined : window.duskDesktop;
  try {
    if (desktop?.permOpenSettings) { await desktop.permOpenSettings(kind); return; }
  } catch {}
  await desktop?.openExternal?.(`x-apple.systempreferences:com.apple.preference.security?${PANES[kind]}`).catch(() => {});
}

export function permissionsMissing(status: MacPermissionStatus | null): boolean {
  if (!status?.supported) return false;
  return MAC_PERMISSIONS.some((kind) => status[kind] !== "granted");
}

/** Screen Recording granted in System Settings only takes effect once Metal reopens. */
export function screenNeedsReopen(status: MacPermissionStatus | null): boolean {
  return status?.supported === true && status.screen === "asked";
}
