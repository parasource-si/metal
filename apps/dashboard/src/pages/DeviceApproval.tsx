import { useEffect, useRef, useState } from "react";
import { Monitor } from "@/icons";
import { useCloud } from "../data/cloud";
import { useSession } from "../data/session";
import { api, ApiError } from "../lib/api";
import { navigate, useLocation } from "../lib/router";
import { PRELAUNCH } from "../lib/prelaunch";
import { Button, ButtonLink, Card } from "../ui/kit";
import { Mascot } from "../ui/Mascot";
import { SkyEmpty } from "../ui/Sky";
import { FROM_APP_KEY } from "../lib/from-app";
import { setFlowNote } from "../lib/flow-note";

/** the app's sign-in from linking its own server (electron/vps-link-main) */
export const SERVER_LINK_SOURCE = "server_link";

type Device = { fresh?: boolean; created?: true; device: { name: string; platform: string }; userCode: string; expiresAt: number; intent?: { kind: string; source?: string }; next?: string };

/** the app's own link: it brings Metal forward (the app already signed itself in, so coming back is optional) */
export const APP_LINK = "duskbot://open";
/** tries the app's link once; a browser without the app installed simply stays here */
/** opens the app straight away, with no click: a top-level navigation to its link, which browsers hand to the app and
 *  leave this page as it was (a hidden frame, the old way, is blocked for app links in Chrome and ignored by Safari).
 *  the page's own button stays as the way back when the browser asks first or the app is not there */
export function tryAppLink(link: string) { try { window.location.assign(link); } catch {} }

/** the desktop app's browser sign-in lands here: show which device asks, then approve or deny */
export function DeviceApprovalPage() {
  const { query } = useLocation();
  const { account, toast } = useSession();
  const cloud = useCloud();
  const code = query.get("code") ?? "";
  const [found, setFound] = useState<Device | null>(null);
  const [state, setState] = useState<"loading" | "ask" | "approved" | "denied" | "missing">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // signed in (or up) after the app asked, through the page it opened (the server says): that was the approval
  const fresh = found?.fresh === true;
  const auto = useRef(false);

  useEffect(() => {
    if (!code) { setState("missing"); return; }
    api.deviceLookup(code).then((d) => { setFound(d); setState("ask"); }, (e) => { setState("missing"); setError(e instanceof ApiError && e.status !== 404 ? e.message : null); });
  }, [code]);

  // the app asked from its own server's setup: the server is being linked, so the sidebar says that rather than "no workspace"
  const linking = found?.intent?.source === SERVER_LINK_SOURCE;
  useEffect(() => {
    if (!linking) return;
    setFlowNote({ title: "linking your server…", sub: "it shows here once it's linked" });
    return () => setFlowNote(null);
  }, [linking]);

  useEffect(() => {
    if (!fresh || auto.current || state !== "ask" || !found) return;
    auto.current = true;
    void answer(true);
  });

  const answer = async (yes: boolean) => {
    if (!found) return;
    setBusy(true); setError(null);
    try {
      if (yes) {
        await api.deviceApprove(found.userCode); toast(`${found.device.name} is signed in`);
        // the app's account step said where to go: the plan checkout or billing; a plain sign-in stays here, with the way back
        if (found.next && found.next !== "/" && found.next.startsWith("/") && !found.next.startsWith("//")) {
          try { sessionStorage.setItem(FROM_APP_KEY, "1"); } catch {}
          // the app's own first run is this account's first run: the plans come next, not a second one here
          if (cloud.account && !cloud.account.profile.onboarded) await cloud.finishOnboarding().catch(() => {});
          navigate(found.next, { replace: true }); return;
        }
        // the app notices the sign-in on its own (it polls). a new account goes on with the usual first steps (name, plan)
        // minus getting the app, which they are in; anyone else gets a clear "you're signed in" with the way back to the app
        // instead of the dashboard, which they did not come for
        if (found.created && !PRELAUNCH) { try { sessionStorage.setItem(FROM_APP_KEY, "1"); } catch {} navigate("/", { replace: true }); return; }
        setState("approved");
      }
      else { await api.deviceDeny(found.userCode); setState("denied"); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (state === "missing") {
    return <SkyEmpty title="that sign-in link has expired" action={<ButtonLink to="/" variant="primary">go home</ButtonLink>}>{error ?? "codes last 10 minutes. start the sign-in again from the app and it opens a fresh one."}</SkyEmpty>;
  }
  return (
    <div className="mx-auto max-w-[460px] pt-10 max-sm:pt-4">
      <div className="flex justify-center"><span className="peek inline-flex"><Mascot color="blue" size={64} state={state === "approved" ? "happy" : "curious"} track /></span></div>
      <Card className="enter relative -mt-4">
        {state === "loading" || !found || (fresh && state === "ask" && !error) ? (
          <p className="text-14 text-ink-3" aria-busy="true">{fresh ? "signing in the app" : "looking up the device"}</p>
        ) : state === "approved" ? (
          <>
            <h1 className="text-20 font-medium text-ink">you're signed in</h1>
            <p className="mt-1.5 text-14 leading-[1.55] text-ink-3">{found.device.name} signs itself in, there's nothing else to do here. open Metal when you like, or close this tab.</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <a href={APP_LINK} data-back-to-app="" className="press hover-btn inline-flex h-10 items-center rounded-full bg-ink px-4.5 text-14 font-medium text-bg">open Metal</a>
            </div>
          </>
        ) : state === "denied" ? (
          <>
            <h1 className="text-20 font-medium text-ink">sign-in denied</h1>
            <p className="mt-1.5 text-14 leading-[1.55] text-ink-3">{found.device.name} was not signed in. if that was not you, nothing else is needed.</p>
          </>
        ) : (
          <>
            <h1 className="text-20 font-medium text-ink">sign in the app on this device?</h1>
            <div className="mt-4 flex items-center gap-3 rounded-[16px] bg-btn px-4 py-3">
              <Monitor size={18} strokeWidth={1.5} className="shrink-0 text-ink-2" aria-hidden />
              <div className="min-w-0">
                <div className="truncate text-14 text-ink">{found.device.name}</div>
                <div className="truncate text-13 text-ink-3">{found.device.platform} · code <span className="num">{found.userCode}</span></div>
              </div>
            </div>
            <p className="mt-3 text-13 leading-[1.5] text-ink-3">it signs in as <span className="text-ink-2">{account?.email}</span>. only approve if you started this from the app just now and the code matches.</p>
            {error && <p role="alert" className="mt-3 text-13 text-bad">{error}</p>}
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <Button variant="primary" onClick={() => void answer(true)} disabled={busy}>{busy ? "approving" : "approve"}</Button>
              <button type="button" data-deny="" onClick={() => void answer(false)} disabled={busy}
                className="rounded-[6px] text-13 text-ink-3 underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50">that wasn't me, deny</button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
