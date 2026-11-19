import { Download } from "@/icons";
import android from "../art/os/android.svg";
import apple from "../art/os/apple.svg";
import linux from "../art/os/linux.svg";
import windows from "../art/os/windows.svg";
import { DOWNLOAD_URL } from "../lib/usage";
import { track } from "../lib/analytics";
import { detectOs, type Platform } from "../lib/downloads";

// os marks: gilbarbara/logos, cc0 1.0
const LOGO: Record<Platform, string> = { macos: apple, windows, linux, android, ios: apple };
const NAME: Record<Platform, string> = { macos: "macos", windows: "windows", linux: "linux", android: "android", ios: "ios" };

function Mark({ platform }: { platform: Platform }) {
  const src = LOGO[platform];
  // apple's mark is one colour, so it takes the ink and stays visible in both themes
  if (src === apple) return <span aria-hidden className="block size-[22px] bg-ink" style={{ maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")`, maskSize: "contain", WebkitMaskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center" }} />;
  return <img src={src} alt="" width={22} height={22} className="size-[22px] object-contain" draggable={false} />;
}

export function Downloads() {
  const detected = detectOs();
  const desktops: Platform[] = detected === "macos" || detected === "windows" || detected === "linux" ? [detected] : ["macos", "windows", "linux"];
  return (
    <ul className="flex flex-col gap-1.5" aria-label="downloads">
      {desktops.map((p) => (
        <li key={p} className="flex min-h-14 items-center gap-3.5 rounded-[16px] bg-card px-4 py-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-pop"><Mark platform={p} /></span>
          <span className="min-w-0 flex-1 text-15 font-medium text-ink">{NAME[p]}</span>
          <a href={DOWNLOAD_URL} onClick={() => track({ name: "download_click", props: { platform: p, detected_os: detected } })}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink px-3.5 py-1.5 text-14 text-pop transition-opacity hover:opacity-90">
            <Download size={15} strokeWidth={1.75} aria-hidden />downloads
          </a>
        </li>
      ))}
      {(["ios", "android"] as const).map((p) => (
        <li key={p} aria-disabled="true" className="flex min-h-14 items-center gap-3.5 rounded-[16px] bg-card px-4 py-2.5 opacity-50">
          <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-pop"><Mark platform={p} /></span>
          <span className="min-w-0 flex-1 text-15 font-medium text-ink">{NAME[p]}</span>
          <span className="shrink-0 text-14 text-ink-3">coming soon</span>
        </li>
      ))}
    </ul>
  );
}
