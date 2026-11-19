import { useState } from "react";
import { cx } from "../ui/kit";
import { useAdmin } from "./api";
import { RangePicker, rangeOf, type Range } from "./kit";
import { AdminHeader, DayBars, Failed, Loading, Section, Tile, n, stamp } from "./ui";

type Family = "bad" | "confusing" | "done";
interface CountRow { key: string; count: number }
interface Recent { who: string; last: number; bad: number; confusing: number; done: number; version: string | null; platform: string | null; signedIn: boolean }
interface ExperienceAnswer {
  from: number; to: number; days: string[]; series: Record<Family, number[]>; totals: Record<Family, number>; installs: number;
  top: Record<Family, CountRow[]>; recent: Recent[];
}
interface TimelineAnswer { who: string; items: Array<{ at: number; name: string; family: Family | null; label: string }> }

const FAMILY: Record<Family, { title: string; wash: string }> = {
  bad: { title: "bad experiences", wash: "bg-wash-pink" },
  confusing: { title: "confusing moments", wash: "bg-wash-lilac" },
  done: { title: "things that got done", wash: "bg-wash-sky" },
};
const FAMILIES = Object.keys(FAMILY) as Family[];

function Top({ family, rows }: { family: Family; rows: CountRow[] }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <Section title={`top ${FAMILY[family].title}`} className="!mt-0 min-w-0">
      {rows.length ? (
        <ol>
          {rows.map((row) => (
            <li key={row.key} className="relative flex min-h-11 items-center justify-between gap-3 py-2.5 text-14">
              <span className="truncate text-ink-2" title={row.key}>{row.key}</span>
              <span className="shrink-0 font-mono text-ink num">{n(row.count)}</span>
              <span className="absolute bottom-1 left-0 h-1 rounded-full bg-accent/10" style={{ width: `${(row.count / max) * 100}%` }} aria-hidden />
            </li>
          ))}
        </ol>
      ) : <p className="text-14 text-ink-3">nothing yet.</p>}
    </Section>
  );
}

const shortId = (who: string) => who.startsWith("ws:") ? `workspace ${who.slice(3, 11)}` : `install ${who.slice(0, 8)}`;

function Timeline({ who }: { who: string }) {
  const { data, error, loading, reload } = useAdmin<TimelineAnswer>(`/experience/timeline?who=${encodeURIComponent(who)}`);
  return (
    <Section title={`${shortId(who)}: last 30 days`} className="min-w-0">
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading rows={4} />}
      {data && (data.items.length ? (
        <ol className="space-y-0.5">
          {data.items.map((item, index) => (
            <li key={`${item.at}-${index}`} className="flex min-h-10 items-center gap-3 py-2 text-14">
              <span className="w-[132px] shrink-0 font-mono text-12 text-ink-3 num">{stamp(item.at)}</span>
              <span className={cx("inline-flex h-6 w-[88px] shrink-0 items-center justify-center rounded-full text-12", item.family ? `${FAMILY[item.family].wash} text-ink` : "bg-card-2 text-ink-3")}>
                {item.family ?? "activity"}
              </span>
              <span className={cx("min-w-0 truncate", item.family ? "text-ink" : "text-ink-3")} title={item.label}>{item.label}</span>
            </li>
          ))}
        </ol>
      ) : <p className="text-14 text-ink-3">nothing from this install in the last 30 days.</p>)}
    </Section>
  );
}

/** how Metal went for people: what went wrong, where they got stuck and what got done, never what was said */
export function ExperiencePage() {
  const [range, setRange] = useState<Range>(() => rangeOf("30d"));
  const { data, error, loading, reload } = useAdmin<ExperienceAnswer>(`/experience?from=${range.from}&to=${range.to}`);
  const [who, setWho] = useState<string | null>(null);
  return (
    <>
      <AdminHeader title="experience" sub="bad experiences, confusing moments and things that got done, from the apps and their workspaces" action={<RangePicker value={range} onChange={setRange} />} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Tile label="bad experiences" value={n(data.totals.bad)} tone={data.totals.bad > 0 ? "bad" : undefined} />
            <Tile label="confusing moments" value={n(data.totals.confusing)} tone={data.totals.confusing > 0 ? "warn" : undefined} />
            <Tile label="things done" value={n(data.totals.done)} />
            <Tile label="installs heard from" value={n(data.installs)} />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4 max-lg:grid-cols-1">
            {FAMILIES.map((family) => (
              <div key={family} className="min-w-0 rounded-[18px] bg-card p-5">
                <DayBars title={FAMILY[family].title} days={data.days} values={data.series[family]} tone={family === "done" ? "accent" : "ink"} />
              </div>
            ))}
          </div>
          <div className="mt-10 grid grid-cols-3 gap-x-8 gap-y-10 max-xl:grid-cols-2 max-md:grid-cols-1">
            {FAMILIES.map((family) => <Top key={family} family={family} rows={data.top[family]} />)}
          </div>
          <Section title="installs, most recent first" className="min-w-0">
            {data.recent.length ? (
              <ol className="space-y-0.5">
                {data.recent.map((row) => (
                  <li key={row.who}>
                    <button type="button" onClick={() => setWho(row.who === who ? null : row.who)} aria-expanded={row.who === who}
                      className={cx("flex min-h-12 w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left text-14 hover:bg-card-2", row.who === who && "bg-card-2")}>
                      <span className="w-[150px] shrink-0 truncate font-mono text-13 text-ink">{shortId(row.who)}</span>
                      <span className="w-[132px] shrink-0 font-mono text-12 text-ink-3 num">{stamp(row.last)}</span>
                      <span className="min-w-0 flex-1 truncate text-13 text-ink-3">{[row.platform, row.version && `v${row.version}`, row.signedIn ? "signed in" : "anonymous"].filter(Boolean).join(" · ")}</span>
                      <span className="shrink-0 text-13 num"><span className="text-bad">{n(row.bad)} bad</span><span className="text-ink-4">{" \u00b7 "}</span><span className="text-warn">{n(row.confusing)} confusing</span><span className="text-ink-4">{" \u00b7 "}</span><span className="text-ink-2">{n(row.done)} done</span></span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="text-14 text-ink-3">no install has reported anything in this range.</p>}
          </Section>
          {who && <Timeline who={who} />}
          <p className="mt-6 text-12 text-ink-4">words, codes and counts only. message text, file names and anything typed never leave the app for this.</p>
        </>
      )}
    </>
  );
}
