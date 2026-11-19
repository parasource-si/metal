import { useEffect, type ReactNode, type Ref } from "react";
import mark from "../../favicon.svg";
import { siteUrl } from "../lib/site";
import { cx } from "./kit";
import { Scene, useMedia, type SceneHandle, type SceneMood } from "./Scene";

const TOWARD_FORM: SceneMood[] = ["typing", "thinking", "waiting", "oops"];

/** the screens before the dashboard: a tall pixel scene on the left, one calm column on the right. on a phone the scene is a
 * short band on top. `step` changes what kit says in the scene */
export function SplitFrame({ mood, step, scene, card, snug = false, aside, children, foot }: { mood: SceneMood; step?: number; scene?: Ref<SceneHandle>; card?: ReactNode; snug?: boolean; aside?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  const wide = useMedia("(min-width: 1024px)");
  // inputs count as focus-visible however they were focused, so the page itself tells keyboard use from pointer use
  useEffect(() => {
    const root = document.documentElement;
    const keys = (e: KeyboardEvent) => { if (e.key === "Tab") root.dataset.keys = ""; };
    const pointer = () => { delete root.dataset.keys; };
    document.addEventListener("keydown", keys, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => { document.removeEventListener("keydown", keys, true); document.removeEventListener("pointerdown", pointer, true); delete root.dataset.keys; };
  }, []);
  const look = TOWARD_FORM.includes(mood) ? (wide ? { x: 0.95, y: -0.1 } : { x: 0, y: 0.9 }) : null;
  return (
    <div className="min-h-[100dvh] bg-bg lg:grid lg:grid-cols-[minmax(0,0.94fr)_minmax(0,1fr)] lg:gap-3 lg:p-3">
      <Scene ref={scene} mood={mood} step={step} look={look} compact={!wide} friends={card && !snug ? "low" : "top"} className="h-[168px] lg:sticky lg:top-3 lg:h-[calc(100dvh-24px)] lg:min-h-[620px] lg:rounded-[28px]">
        {card && (
          <div className={cx("px-lift enter absolute top-[9%] max-lg:hidden", snug ? "left-[9%] xl:left-[11%]" : "inset-x-[9%] xl:inset-x-[12%]")}>
            <div className={cx("px-steps bg-pop", snug ? "px-6 pb-5 pt-6" : "p-8")}>{card}</div>
          </div>
        )}
      </Scene>
      <div className="flex min-h-[calc(100dvh-168px)] flex-col px-5 lg:min-h-[calc(100dvh-24px)] lg:px-10">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4">
          <a href={siteUrl()} className="-ms-2 flex items-center gap-2 rounded-full px-2 py-1" aria-label="Metal, back to the site">
            <img src={mark} alt="" width={28} height={28} className="size-7" />
            <span className="text-[17px] font-[550] tracking-[-0.02em] text-ink">Metal</span>
          </a>
          {aside}
        </header>
        <main className="grid flex-1 place-items-center py-8 max-lg:place-items-start max-lg:pt-6">
          <div className="w-full max-w-[400px] max-lg:mx-auto">{children}</div>
        </main>
        {foot && <footer className="t-meta shrink-0 pb-6 text-center">{foot}</footer>}
      </div>
    </div>
  );
}
