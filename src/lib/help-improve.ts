import { useEffect, useState } from "react";
import { api } from "@/state/api";
import { setUsageAnalytics, usageSharingChanged, type SharingPlace } from "@/lib/product-analytics";

const ROUTE = "/api/dashboard/usage-signals";

/** The one "help improve Metal" switch, on by default: anonymous usage info, the scrubbed notes about how sessions
 * went, and crash reports. The workspace's server keeps the choice; the app's own analytics and the desktop's crash
 * reports follow it. `on` is null until it is read; `failed` when reading or saving it did not work. */
export function useHelpImprove(where: SharingPlace) {
  const [on, setOn] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ enabled: boolean }>(ROUTE).then((answer) => { if (live) setOn(answer.enabled); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  const set = async (next: boolean) => {
    const before = on;
    setOn(next);
    setFailed(false);
    try {
      const answer = await api<{ enabled: boolean }>(ROUTE, { method: "PUT", body: JSON.stringify({ enabled: next }) });
      setOn(answer.enabled);
      if (before !== null && answer.enabled !== before) usageSharingChanged(answer.enabled, where);
      else setUsageAnalytics(answer.enabled);
      void window.duskDesktop?.desktopAnalytics?.set?.(answer.enabled)?.catch(() => {});
    } catch {
      setOn(before);
      setFailed(true);
    }
  };
  return { on, failed, set };
}

let lastSynced: boolean | null = null;
/** the account can turn the switch off (or on again) from its own page, and the server follows on its next report: the
 * app's own analytics and the desktop's crash reports follow the server's answer, now and every few minutes */
export async function syncHelpImprove(): Promise<void> {
  try {
    const answer = await api<{ enabled: boolean }>(ROUTE);
    if (typeof answer.enabled !== "boolean" || answer.enabled === lastSynced) return;
    lastSynced = answer.enabled;
    setUsageAnalytics(answer.enabled);
    void window.duskDesktop?.desktopAnalytics?.set?.(answer.enabled)?.catch(() => {});
  } catch {}
}
