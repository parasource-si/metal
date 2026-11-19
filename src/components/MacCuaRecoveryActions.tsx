import { useEffect, useState } from "react";
import { macCuaPermissionHelper, missingMacCuaPermissions, type MacCuaPermission } from "@/lib/mac-cua-permissions";
import { t } from "@/lib/i18n";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { friendlyError } from "@/lib/plain-error";

const paneName: Record<MacCuaPermission, "computer.mac.permission.screenSettings" | "computer.mac.permission.accessibilitySettings"> = {
  screen: "computer.mac.permission.screenSettings",
  accessibility: "computer.mac.permission.accessibilitySettings",
};

/** `ownRetry`: the surface already has a Retry button, so a helper's grant gets no second "Check again". */
export function MacCuaRecoveryActions({ reason, ownRetry = false }: { reason: string; ownRetry?: boolean }) {
  const { capabilities, ready } = useDesktopCapabilities();
  const permissions = missingMacCuaPermissions(reason);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  // CuaDriver picks a grant up by itself and the app watches for it; Metal's own grant needs a relaunch
  const helper = macCuaPermissionHelper(capabilities.localComputer.message);
  const [error, setError] = useState<string | null>(null);
  const [awaitingGrant, setAwaitingGrant] = useState(false);
  const checkAgain = async () => {
    try {
      await window.duskDesktop?.localControl?.retry();
      setError(null);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  };
  useEffect(() => {
    if (!awaitingGrant || !helper) return;
    const back = () => {
      if (document.visibilityState !== "visible") return;
      setAwaitingGrant(false);
      void checkAgain();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [awaitingGrant, helper]);
  if (!permissions.length || permissions.join(",") !== currentPermissions.join(",") ||
      !ready || capabilities.host.platform !== "darwin" ||
      capabilities.localComputer.available !== false || capabilities.localComputer.reasonCode === "remote-server" ||
      typeof window.duskDesktop?.permOpenSettings !== "function") return null;

  const openSettings = async (permission: MacCuaPermission) => {
    try {
      await window.duskDesktop?.permOpenSettings(permission);
      setError(null);
      setAwaitingGrant(true);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  };

  const relaunch = async () => {
    try {
      await window.duskDesktop?.relaunch?.();
      setError(null);
    } catch (cause) {
      setError(friendlyError(cause));
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {permissions.map((permission) => (
        <button key={permission} type="button" onClick={() => void openSettings(permission)}
          className="ui-button h-6! min-h-6! px-2.5! text-[12px]! leading-4!">
          {t(paneName[permission])}
        </button>
      ))}
      {helper ? !ownRetry && typeof window.duskDesktop.localControl?.retry === "function" && (
        <button type="button" onClick={() => void checkAgain()}
          className="ui-button h-6! min-h-6! px-2.5! text-[12px]! leading-4!">
          {t("computer.mac.permission.checkAgain")}
        </button>
      ) : typeof window.duskDesktop.relaunch === "function" && (
        <button type="button" onClick={() => void relaunch()}
          className="ui-button h-6! min-h-6! px-2.5! text-[12px]! leading-4!">
          {t("computer.mac.permission.relaunch")}
        </button>
      )}
      {error && <span role="alert" className="w-full text-[12px]">{error}</span>}
    </div>
  );
}
