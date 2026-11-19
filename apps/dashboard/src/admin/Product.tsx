import { useState, type ReactNode } from "react";
import { cx } from "../ui/kit";
import { Table, Td, Th } from "../ui/table";
import { useAdmin } from "./api";
import { RangePicker, duration, percent, rangeOf, type Range } from "./kit";
import { AdminHeader, Failed, Loading, Section, Tabs, Tile, n } from "./ui";
import { AppUsagePage } from "./AppUsage";

interface Count { key: string; count: number; people: number }
interface Feature { feature: string; people: number; uses: number; adoption: number | null; repeat: number | null; triedOnce: number; lift: number | null }
interface Improvement { area: string; title: string; detail: string; weight: number }
export interface ProductAnswer {
  from: number; to: number; appPeople: number; features: Feature[];
  moments: Array<{ name: string; count: number; people: number; outcomes: Array<{ key: string; count: number }> }>;
  likes: {
    reactions: { positive: number; negative: number; total: number };
    feedback: { count: number; average: number | null; scores: number[]; byMoment: Array<{ moment: string; count: number; average: number }> };
    bots: { created: number; deletedSoon: number };
    messages: { sent: number; replies: number; perPerson: number | null; days: number };
    sessionMedianMs: number | null;
  };
  onboarding: Array<{ step: string; reached: number; medianMsBefore: number | null; leftHere: number }>;
  appFirstRun?: Array<{ path: "all" | "mac" | "cloud"; step: string; reached: number; medianMsBefore: number | null }>;
  site: {
    sections: Array<{ path: string; section: string; seen: number; share: number | null; medianMs: number | null }>;
    clicks: Count[]; rage: Count[]; downloads: Count[]; errors: Count[];
    forms: { started: number; abandoned: number; joined: number };
  };
  errors: { app: Count[]; pairing: Count[] };
  account: { actions: Count[]; choices: Count[]; downloads: Count[] };
  improve: Improvement[];
}

export const TABS = [
  { to: "/admin/product", label: "what to improve" },
  { to: "/admin/product/apps", label: "in the apps" },
  { to: "/admin/product/website", label: "website" },
  { to: "/admin/product/account", label: "account pages" },
];
const AREA: Record<string, string> = { funnel: "funnel", errors: "errors", rating: "ratings", features: "features", onboarding: "onboarding", site: "website", bots: "bots" };
const words = (value: string) => value.replace(/_/g, " ");

function useProduct(range: Range) {
  return useAdmin<ProductAnswer>(`/product?from=${range.from}&to=${range.to}`, 120_000);
}

/** a ranked list with a light bar for the count and the number of people behind it */
export function Counts({ rows, empty = "nothing yet.", label = words }: { rows: Count[]; empty?: string; label?(key: string): string }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  if (!rows.length) return <p className="text-14 text-ink-3">{empty}</p>;
  return (
    <ol className="flex flex-col gap-px">
      {rows.map((row) => (
        <li key={row.key} className="relative flex h-9 items-center gap-3 overflow-hidden rounded-[10px] px-2.5 text-13">
          <span className="absolute inset-y-0 left-0 rounded-[10px] bg-accent/10" style={{ width: `${(row.count / max) * 100}%` }} aria-hidden />
          <span className="relative min-w-0 flex-1 truncate text-ink" title={row.key}>{label(row.key)}</span>
          <span className="relative w-14 text-end font-mono text-ink num">{n(row.count)}</span>
          <span className="relative w-20 text-end text-12 text-ink-3 num max-sm:hidden">{n(row.people)} {row.people === 1 ? "person" : "people"}</span>
        </li>
      ))}
    </ol>
  );
}

function Frame({ title, sub, range, setRange, children }: { title: string; sub: string; range: Range; setRange(range: Range): void; children(data: ProductAnswer): ReactNode }) {
  const { data, error, loading, reload } = useProduct(range);
  return (
    <>
      <AdminHeader title={title} sub={sub} action={<RangePicker value={range} onChange={setRange} />} tabs={<Tabs label="product views" items={TABS} />} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading rows={8} />}
      {data && <div className={cx(loading && "opacity-70")}>{children(data)}</div>}
    </>
  );
}

const lift = (value: number | null) => value === null ? <span className="text-ink-4">too few</span>
  : <span className={value > 0.02 ? "text-good" : value < -0.02 ? "text-bad" : "text-ink-3"}>{value > 0 ? "+" : ""}{Math.round(value * 100)} pts</span>;

/** the list of fixes, numbered, each with the number behind it */
export function ImproveList({ items, limit }: { items: Improvement[]; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  if (!shown.length) return <p className="rounded-[18px] bg-card px-4 py-6 text-center text-14 text-ink-3">nothing stands out yet. this fills in as more people use Metal.</p>;
  return (
    <ol className="flex flex-col gap-1.5 overflow-hidden rounded-[20px]">
      {shown.map((item, i) => (
        <li key={item.title} className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-baseline gap-3 bg-card px-4 py-3.5">
          <span className="font-mono text-14 text-ink-4">{i + 1}</span>
          <span className="min-w-0"><span className="block text-15 font-medium text-ink">{item.title}</span><span className="mt-0.5 block text-13 text-ink-3">{item.detail}</span></span>
          <span className="tag !h-[22px] !px-2">{AREA[item.area] ?? item.area}</span>
        </li>
      ))}
    </ol>
  );
}

function ImproveView({ data }: { data: ProductAnswer }) {
  const { likes } = data;
  const top = Math.max(1, ...likes.feedback.scores);
  return (
    <>
      <Section title="fix first" action={<span className="t-meta">ranked by how many people it touches</span>}><ImproveList items={data.improve} /></Section>

      <Section title="what people like">
        <div className="grid grid-cols-4 gap-2.5 max-lg:grid-cols-2">
          <Tile label="rating" value={likes.feedback.average === null ? "-" : `${likes.feedback.average} / 5`} note={`${n(likes.feedback.count)} answers to "how's it going?"`} />
          <Tile label="reactions to replies" value={n(likes.reactions.total)} note={`${n(likes.reactions.positive)} good, ${n(likes.reactions.negative)} thumbs down`} tone={likes.reactions.negative > likes.reactions.positive ? "warn" : undefined} />
          <Tile label="messages per person" value={n(likes.messages.perPerson)} note={`${n(likes.messages.sent)} sent in ${likes.messages.days} days`} />
          <Tile label="time in the app" value={duration(likes.sessionMedianMs)} note="median session" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 max-md:grid-cols-1">
          <div className="rounded-[18px] bg-card p-5">
            <h3 className="text-13 text-ink-2">ratings</h3>
            <ol className="mt-3 flex flex-col gap-1.5" aria-label="ratings from 5 down to 1">
              {[5, 4, 3, 2, 1].map((score) => (
                <li key={score} className="grid grid-cols-[48px_minmax(0,1fr)_40px] items-center gap-3 text-13">
                  <span className="text-ink-3">{score} of 5</span>
                  <span className="h-2 overflow-hidden rounded-full bg-track" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${(likes.feedback.scores[score - 1]! / top) * 100}%` }} /></span>
                  <span className="text-end font-mono num">{n(likes.feedback.scores[score - 1]!)}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="rounded-[18px] bg-card p-5">
            <h3 className="text-13 text-ink-2">rating by moment, lowest first</h3>
            {likes.feedback.byMoment.length ? (
              <ul className="mt-2">
                {likes.feedback.byMoment.map((row) => <li key={row.moment} className="flex h-10 items-center justify-between gap-3 text-14"><span className="truncate text-ink-2">{words(row.moment)}</span><span className="font-mono num">{row.average} <span className="text-12 text-ink-4">({n(row.count)})</span></span></li>)}
              </ul>
            ) : <p className="mt-2 text-14 text-ink-3">no answers yet. the apps ask after a good stretch of replies, at most once a month.</p>}
            <p className="mt-3 text-12 text-ink-4">{n(likes.bots.deletedSoon)} of {n(likes.bots.created)} new bots were deleted within a day.</p>
          </div>
        </div>
      </Section>

      <Section title="features" action={<span className="t-meta">{n(data.appPeople)} people used an app in this window</span>}>
        {data.features.length ? (
          <Table label="features by use">
            <thead><tr><Th>feature</Th><Th className="!text-end">people</Th><Th className="!text-end">of app users</Th><Th className="!text-end">came back to it</Th><Th className="!text-end">tried once</Th><Th className="!text-end" title="share of its users still active in the last week, against everyone else">stay rate</Th></tr></thead>
            <tbody>
              {data.features.map((row) => (
                <tr key={row.feature} className="hover-row">
                  <Td className="text-ink">{words(row.feature)}</Td>
                  <Td className="text-end font-mono num">{n(row.people)}</Td>
                  <Td className="text-end font-mono num">{percent(row.adoption)}</Td>
                  <Td className="text-end font-mono num">{percent(row.repeat)}</Td>
                  <Td className="text-end font-mono num">{n(row.triedOnce)}</Td>
                  <Td className="text-end font-mono text-13 num">{lift(row.lift)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="text-14 text-ink-3">no feature use yet.</p>}
        <p className="mt-3 text-12 text-ink-4">stay rate: how much more likely a feature's users were active in the window's last week than people who never used it. tried once: used on one day only, and not in the last week.</p>
      </Section>

      <Section title="desktop first run" action={<span className="t-meta">people who reached each screen, by where they put their bots</span>}>
        {data.appFirstRun?.some((row) => row.reached > 0) ? (
          <Table label="desktop first run">
            <thead><tr><Th>path</Th><Th>screen</Th><Th className="!text-end">reached</Th><Th className="!text-end">of the first screen</Th><Th className="!text-end">time on the screen before</Th></tr></thead>
            <tbody>
              {data.appFirstRun.map((row) => {
                const first = Math.max(1, ...data.appFirstRun!.filter((one) => one.path === "all").map((one) => one.reached));
                return (
                  <tr key={`${row.path}:${row.step}`} className="hover-row">
                    <Td className="text-ink-3">{row.path === "all" ? "everyone" : row.path === "mac" ? "this computer" : "dusk cloud"}</Td>
                    <Td className="text-ink">{words(row.step)}</Td>
                    <Td className="text-end font-mono num">{n(row.reached)}</Td>
                    <Td className="text-end font-mono num">{Math.round((row.reached / first) * 100)}%</Td>
                    <Td className="text-end font-mono num">{duration(row.medianMsBefore)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : <p className="text-14 text-ink-3">no first runs from people who share usage yet.</p>}
      </Section>

      <Section title="cards, prompts and steps in the apps">
        {data.moments.length ? (
          <Table label="app moments">
            <thead><tr><Th>moment</Th><Th className="!text-end">times</Th><Th className="!text-end">people</Th><Th>how it went</Th></tr></thead>
            <tbody>
              {data.moments.map((row) => (
                <tr key={row.name} className="hover-row">
                  <Td className="text-ink">{words(row.name)}</Td>
                  <Td className="text-end font-mono num">{n(row.count)}</Td>
                  <Td className="text-end font-mono num">{n(row.people)}</Td>
                  <Td><span className="flex flex-wrap gap-1.5">{row.outcomes.map((o) => <span key={o.key} className="inline-flex h-6 items-center rounded-full bg-card px-2.5 text-12 text-ink-2">{words(o.key)} <span className="ms-1 font-mono text-ink-4">{n(o.count)}</span></span>)}</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="text-14 text-ink-3">nothing yet.</p>}
      </Section>

      <div className="mt-10 grid grid-cols-2 gap-8 max-md:grid-cols-1">
        <Section className="!mt-0" title="app errors"><Counts rows={data.errors.app} empty="no app errors." label={(key) => key} /></Section>
        <Section className="!mt-0" title="pairing failures"><Counts rows={data.errors.pairing} empty="no failed pairings." /></Section>
      </div>
    </>
  );
}

function WebsiteView({ data }: { data: ProductAnswer }) {
  const { site } = data;
  const paths = [...new Set(site.sections.map((row) => row.path))];
  return (
    <>
      <div className="grid grid-cols-4 gap-2.5 max-lg:grid-cols-2">
        <Tile label="waitlist form started" value={n(site.forms.started)} />
        <Tile label="started and left" value={n(site.forms.abandoned)} note={site.forms.started ? `${percent(site.forms.abandoned / site.forms.started)} of starts` : undefined} tone={site.forms.started && site.forms.abandoned / site.forms.started > 0.5 ? "warn" : undefined} />
        <Tile label="joined the waitlist" value={n(site.forms.joined)} />
        <Tile label="rage clicks" value={n(site.rage.reduce((sum, row) => sum + row.count, 0))} tone={site.rage.length ? "warn" : undefined} />
      </div>
      <Section title="which sections get seen" action={<span className="t-meta">half on screen, share of that page's views</span>}>
        {paths.length ? paths.map((path) => (
          <div key={path} className="mb-6 last:mb-0">
            <h3 className="mb-2 font-mono text-13 text-ink-3">{path}</h3>
            <ol className="flex flex-col gap-px">
              {site.sections.filter((row) => row.path === path).map((row) => (
                <li key={row.section} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_64px_72px] items-center gap-3 text-13 max-sm:grid-cols-[minmax(0,1fr)_56px_64px]">
                  <span className="truncate text-ink">{words(row.section)}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-track max-sm:hidden" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(1, row.share ?? 0) * 100}%` }} /></span>
                  <span className="text-end font-mono num">{percent(row.share === null ? null : Math.min(1, row.share))}</span>
                  <span className="text-end font-mono text-ink-3 num">{duration(row.medianMs)}</span>
                </li>
              ))}
            </ol>
          </div>
        )) : <p className="text-14 text-ink-3">no section views yet. the site sends them with the next tracker release.</p>}
      </Section>
      <div className="mt-10 grid grid-cols-2 gap-8 max-md:grid-cols-1">
        <Section className="!mt-0" title="what gets clicked"><Counts rows={site.clicks} /></Section>
        <div className="flex flex-col gap-10">
          <Section className="!mt-0" title="download clicks by platform"><Counts rows={site.downloads} /></Section>
          <Section className="!mt-0" title="rage clicks"><Counts rows={site.rage} empty="no rage clicks." /></Section>
          <Section className="!mt-0" title="page errors"><Counts rows={site.errors} empty="no errors on the site." label={(key) => key} /></Section>
        </div>
      </div>
    </>
  );
}

function AccountView({ data }: { data: ProductAnswer }) {
  return (
    <>
      <Section title="onboarding">
        <Table label="onboarding steps">
          <thead><tr><Th>step</Th><Th className="!text-end">reached</Th><Th className="!text-end">time on the step before</Th><Th className="!text-end">stopped here</Th></tr></thead>
          <tbody>
            {data.onboarding.map((row) => (
              <tr key={row.step} className="hover-row">
                <Td className="text-ink">{row.step}</Td>
                <Td className="text-end font-mono num">{n(row.reached)}</Td>
                <Td className="text-end font-mono num">{duration(row.medianMsBefore)}</Td>
                <Td className={cx("text-end font-mono num", row.leftHere > 0 && "text-warn")}>{n(row.leftHere)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="mt-3 text-12 text-ink-4">stopped here: the account's last onboarding step, more than an hour ago, without finishing.</p>
      </Section>
      <div className="mt-10 grid grid-cols-2 gap-8 max-md:grid-cols-1">
        <Section className="!mt-0" title="choices people make"><Counts rows={data.account.choices} empty="no plan or setting picks yet." /></Section>
        <Section className="!mt-0" title="downloads by platform"><Counts rows={data.account.downloads} /></Section>
      </div>
      <Section title="buttons and links"><Counts rows={data.account.actions} /></Section>
    </>
  );
}

export function ProductPage({ path }: { path: string }) {
  const [range, setRange] = useState<Range>(() => rangeOf("30d"));
  const tabs = <Tabs label="product views" items={TABS} />;
  if (path === "/admin/product/apps") return <AppUsagePage tabs={tabs} />;
  if (path === "/admin/product/website") return <Frame title="product" sub="the site: what gets seen, clicked and skipped" range={range} setRange={setRange}>{(data) => <WebsiteView data={data} />}</Frame>;
  if (path === "/admin/product/account") return <Frame title="product" sub="the account pages: onboarding, picks and clicks" range={range} setRange={setRange}>{(data) => <AccountView data={data} />}</Frame>;
  return <Frame title="product" sub="what people use, what they like, and what to fix" range={range} setRange={setRange}>{(data) => <ImproveView data={data} />}</Frame>;
}
