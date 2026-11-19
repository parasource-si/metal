import { useEffect, useState } from "react";
import { appReturn } from "../data/app-return";
import { Card } from "../ui/kit";
import { Mascot } from "../ui/Mascot";
import { APP_LINK, tryAppLink } from "./DeviceApproval";

/** where the desktop app's browser sign-in (or sign-up) ends: the app is handed its one-time link right away and this
 *  page only says to head back, never the dashboard */
export function AppSignedInPage() {
  const link = appReturn() ?? APP_LINK;
  // the end of the website's first steps for someone the app sent: the app carries on with what they picked
  const [set] = useState(() => new URLSearchParams(window.location.search).get("set") === "1");
  useEffect(() => { tryAppLink(link); }, [link]);
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-bg px-6">
      <div className="w-full max-w-[460px]">
        <div className="flex justify-center"><span className="peek inline-flex"><Mascot color="blue" size={64} state="happy" track /></span></div>
        <Card className="enter relative -mt-4">
          <h1 className="text-20 font-medium text-ink">{set ? "you're all set" : "you're signed in"}</h1>
          <p className="mt-1.5 text-14 leading-[1.55] text-ink-3">{set ? "head back to the app. Metal carries on from here, nothing else to do in the browser." : "head back to the app. Metal signs itself in, nothing else to do here."}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            <a href={link} data-back-to-app="" className="press hover-btn inline-flex h-10 items-center rounded-full bg-ink px-4.5 text-14 font-medium text-bg">open Metal</a>
          </div>
        </Card>
      </div>
    </main>
  );
}
