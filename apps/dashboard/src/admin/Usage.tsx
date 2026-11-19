import { useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Bot, Calendar, ChartColumn, Code, Compass, Cpu, FileText, Globe, Image, Lightbulb, Mail, MessageSquare, MessagesSquare, Monitor, Plug, Repeat, Smartphone,
  Sparkles, SquareTerminal, Table2, Target, Users } from "@/icons";
import { cx } from "../ui/kit";
import { Modal } from "../ui/controls";
import { m } from "../ui/motion";
import { Figure } from "../ui/Figure";
import { Table, Td, Th } from "../ui/table";
import { useAdmin } from "./api";
import { duration, percent, type Range } from "./kit";
import { Failed, Loading, n } from "./ui";
import { MORE_TITLE, MoreCards, MoreTable, type MoreAnswer, type MoreDetail } from "./UsageMore";

interface Row { key: string; turns: number; failed: number; share: number; previous: number; trend: number[]; p50Ms?: number | null }
interface FailureRow { kind: "engine" | "tool" | "app"; key: string; turns: number; failed: number; rate: number; reason: string; reasonWords: string }
interface ProblemGroup { key: string; engine: string; category: string; touch: string; count: number; previous: number; trend: number[]; examples: string[] }
interface Theme { key: string; label: string; count: number; examples: string[]; pain: boolean }
export interface UsageAnswer {
  from: string; to: string; days: string[]; tracked: boolean;
  totals: { turns: number; people: number; perPersonDay: number | null; success: number | null; failRate: number | null; cancelRate: number | null; p50Ms: number | null; p90Ms: number | null;
    runs: number; runSuccess: number | null; frustrations: number; digests: number };
  previous: { turns: number; people: number; failRate: number | null };
  series: number[];
  categories: Row[]; tools: Row[]; apps: Row[]; engines: Row[]; sources: Row[]; places: Row[];
  failures: FailureRow[];
  reasons: Array<{ key: string; count: number; words: string }>;
  routines: { made: { routines: number; webhooks: number; appEvents: number }; peopleWithRoutines: number; peopleRan: number; peopleRanTwice: number; runs: number; failed: number; byTrigger: Row[] };
  people: { total: number; buckets: Array<{ key: string; label: string; count: number }>; activeDays: Array<{ key: string; label: string; count: number }>; topShare: number | null; medianTurns: number | null };
  adoption: Array<{ id: string; label: string; count: number }>;
  frustration: { total: number; previous: number; groups: ProblemGroup[]; signals: Array<{ key: string; count: number }> };
  themes: Theme[];
  focus: Array<{ id: string; text: string; target: string; weight: number }>;
  more?: MoreAnswer;
}

const I = { size: 14, strokeWidth: 1.75 } as const;
const words = (key: string) => key.replace(/_/g, " ");
const CATEGORY: Record<string, { label: string; icon: ReactNode; wash: string }> = {
  email: { label: "email", icon: <Mail {...I} />, wash: "bg-wash-sky" }, calendar: { label: "calendar", icon: <Calendar {...I} />, wash: "bg-wash-lime" },
  messaging: { label: "messaging", icon: <MessagesSquare {...I} />, wash: "bg-wash-lilac" }, social: { label: "social", icon: <Users {...I} />, wash: "bg-wash-pink" },
  docs: { label: "docs and notes", icon: <FileText {...I} />, wash: "bg-wash-lemon" }, coding: { label: "coding", icon: <Code {...I} />, wash: "bg-wash-lilac" },
  data: { label: "data and analysis", icon: <Table2 {...I} />, wash: "bg-wash-lime" }, research: { label: "research and browsing", icon: <Globe {...I} />, wash: "bg-wash-sky" },
  computer: { label: "using the computer", icon: <Monitor {...I} />, wash: "bg-wash-pink" }, files: { label: "files", icon: <FileText {...I} />, wash: "bg-wash-lemon" },
  image: { label: "images", icon: <Image {...I} />, wash: "bg-wash-pink" }, chat: { label: "just chatting", icon: <MessageSquare {...I} />, wash: "bg-wash-sky" },
  other: { label: "other", icon: <Sparkles {...I} />, wash: "bg-wash-lemon" },
};
const TOOL: Record<string, string> = { browser: "browser", computer: "computer use", terminal: "terminal", files: "files", web: "web search", memory: "memory", routine: "routine tools",
  page: "pages", widget: "widgets", bots: "other bots", phone: "phone control", image: "images", data: "data tools", app: "connected apps", mcp: "mcp tools", other: "other tools" };
const SOURCE: Record<string, string> = { app: "in the app", remote: "phone or another device", routine: "routines", bot: "another bot", helper: "helper" };
const PLACE: Record<string, string> = { desktop: "desktop", cloud: "cloud", server: "own server" };
const TRIGGER: Record<string, string> = { schedule: "on a schedule", event: "on an app event", webhook: "by webhook", manual: "run by hand", api: "by api" };
const SIGNAL: Record<string, string> = { thumbs_down: "thumbs down", stopped: "stopped a reply", retried: "asked again", failed: "turns failed", corrective: "said it was wrong", shouting: "all caps", swearing: "swore" };
const ENGINE_COLOR = ["var(--accent)", "var(--viz-renewal)", "var(--viz-new)", "var(--viz-visitors)", "var(--warn)", "var(--viz-refund)", "var(--ink-4)"];
const label = (kind: string, key: string) => kind === "categories" ? CATEGORY[key]?.label ?? words(key) : kind === "tools" ? TOOL[key] ?? words(key) : kind === "sources" ? SOURCE[key] ?? words(key)
  : kind === "places" ? PLACE[key] ?? key : kind === "runs" ? TRIGGER[key] ?? words(key) : key === "other_app" ? "other apps" : words(key);

function Trend({ values, tone = "var(--accent)" }: { values: number[]; tone?: string }) {
  const max = Math.max(1, ...values), w = Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${(i / w) * 60},${18 - (v / max) * 16}`).join(" ");
  return <svg viewBox="0 0 60 20" className="h-4 w-14 shrink-0 overflow-visible" aria-hidden><polyline points={points} fill="none" stroke={tone} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>;
}
function Change({ now, before }: { now: number; before: number }) {
  if (!before) return now ? <span className="text-12 text-good">new</span> : null;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.05) return <span className="text-12 text-ink-4">flat</span>;
  return <span className={cx("text-12 num", change > 0 ? "text-good" : "text-ink-3")}>{change > 0 ? "+" : ""}{Math.round(change * 100)}%</span>;
}

/** a ranked list: a soft bar for the share, the failure rate when it matters, and a tap for the full table */
function Ranked({ rows, kind, onOpen, limit = 6 }: { rows: Row[]; kind: string; onOpen(): void; limit?: number }) {
  const max = Math.max(1, ...rows.map((row) => row.turns));
  if (!rows.length) return <p className="px-2 py-3 text-13 text-ink-3">nothing yet.</p>;
  return (
    <ol className="flex flex-col gap-0.5">
      {rows.slice(0, limit).map((row, i) => {
        const fail = row.turns ? row.failed / row.turns : 0;
        return (
          <li key={row.key}>
            <button type="button" onClick={onOpen} className="hover-row relative flex h-9 w-full items-center gap-3 overflow-hidden rounded-[10px] px-2.5 text-start text-13">
              <m.span className="absolute inset-y-0 left-0 rounded-[10px] bg-accent/10" initial={{ width: 0 }} animate={{ width: `${(row.turns / max) * 100}%` }} transition={{ type: "spring", visualDuration: 0.4, bounce: 0, delay: i * 0.03 }} aria-hidden />
              <span className="relative min-w-0 flex-1 truncate text-ink">{label(kind, row.key)}</span>
              {fail >= 0.1 && row.turns >= 5 && <span className="relative rounded-full bg-wash-pink px-2 text-[11.5px] leading-5 text-ink-2 num">{Math.round(fail * 100)}% fail</span>}
              <span className="relative w-12 text-end font-mono text-ink num">{n(row.turns)}</span>
              <span className="relative w-10 text-end text-12 text-ink-3 num max-sm:hidden">{percent(row.share)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Card({ title, icon, wash = "bg-card", action, children, className }: { title: string; icon: ReactNode; wash?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cx("min-w-0 rounded-[24px] p-4", wash, className)}>
      <div className="mb-2 flex items-center gap-2 px-1"><span aria-hidden className="text-ink-3">{icon}</span><h3 className="text-14 font-medium text-ink">{title}</h3><span className="ms-auto">{action}</span></div>
      {children}
    </section>
  );
}
const More = ({ onClick }: { onClick(): void }) => <button type="button" onClick={onClick} className="hover-link inline-flex items-center gap-1 text-12 text-ink-3">all <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden /></button>;

type Detail = "categories" | "apps" | "tools" | "engines" | "failures" | "routines" | "people" | "adoption" | "frustration" | "themes" | "sources" | MoreDetail;
const DETAIL_TITLE: Record<Detail, string> = { ...MORE_TITLE, categories: "what people use it for", apps: "connected apps", tools: "tools", engines: "engines", failures: "what fails", routines: "routines",
  people: "power users and casual", adoption: "how far people get", frustration: "what's frustrating people", themes: "themes from weekly notes", sources: "where people chat from" };

function DetailTable({ detail, data }: { detail: Detail; data: UsageAnswer }) {
  if (detail in MORE_TITLE) return data.more ? <MoreTable detail={detail as MoreDetail} more={data.more} /> : <p className="py-6 text-center text-13 text-ink-3">nothing yet.</p>;
  const rowsTable = (rows: Row[], kind: string, extra?: (row: Row) => ReactNode, extraHead?: string) => (
    <Table label={DETAIL_TITLE[detail]}>
      <thead><tr><Th>{kind === "runs" ? "trigger" : "name"}</Th><Th className="!text-end">turns</Th><Th className="!text-end">share</Th><Th className="!text-end">failed</Th><Th className="!text-end">trend</Th>{extraHead && <Th className="!text-end">{extraHead}</Th>}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key} className="hover-row"><Td className="text-ink">{label(kind, row.key)}</Td><Td className="text-end font-mono num">{n(row.turns)}</Td><Td className="text-end font-mono num">{percent(row.share)}</Td>
        <Td className="text-end font-mono num">{row.turns ? percent(row.failed / row.turns) : "-"}</Td><Td><span className="flex items-center justify-end gap-2"><Trend values={row.trend} /><Change now={row.turns} before={row.previous} /></span></Td>{extra && <Td className="text-end font-mono num">{extra(row)}</Td>}</tr>)}
        {!rows.length && <tr><Td colSpan={6} className="py-8 text-center text-ink-3">nothing in this window.</Td></tr>}</tbody>
    </Table>
  );
  if (detail === "categories") return rowsTable(data.categories, "categories");
  if (detail === "apps") return rowsTable(data.apps, "apps");
  if (detail === "tools") return rowsTable(data.tools, "tools");
  if (detail === "sources") return <div className="flex flex-col gap-4">{rowsTable(data.sources, "sources")}{rowsTable(data.places, "places")}</div>;
  if (detail === "engines") return rowsTable(data.engines, "engines", (row) => duration(row.p50Ms ?? null), "median time");
  if (detail === "routines") return (
    <div className="flex flex-col gap-4">
      {rowsTable(data.routines.byTrigger, "runs")}
      {data.more && <Table label="how often routines run"><thead><tr><Th>set to run</Th><Th className="!text-end">runs</Th><Th className="!text-end">worked</Th></tr></thead>
        <tbody>{data.more.routines.every.map((row) => <tr key={row.key}><Td>{words(row.key)}</Td><Td className="text-end font-mono num">{n(row.total)}</Td><Td className="text-end font-mono num">{percent(row.rate)}</Td></tr>)}</tbody></Table>}
      {data.more && <p className="text-13 text-ink-3">half of runs take {duration(data.more.routines.runP50)}. of {n(data.more.routines.survival.eligible)} routines that first ran over a week ago, {percent(data.more.routines.survival.share)} were still running a week later.</p>}
    </div>
  );
  if (detail === "failures") return (
    <Table label="what fails">
      <thead><tr><Th>what</Th><Th className="!text-end">turns</Th><Th className="!text-end">failed</Th><Th className="!text-end">rate</Th><Th>mostly</Th></tr></thead>
      <tbody>{data.failures.map((row) => <tr key={`${row.kind}:${row.key}`} className="hover-row"><Td className="text-ink">{label(row.kind === "tool" ? "tools" : row.kind, row.key)} <span className="text-ink-4">{row.kind}</span></Td>
        <Td className="text-end font-mono num">{n(row.turns)}</Td><Td className="text-end font-mono num">{n(row.failed)}</Td><Td className="text-end font-mono num">{percent(row.rate)}</Td><Td className="text-ink-3">{row.reasonWords}</Td></tr>)}
        {!data.failures.length && <tr><Td colSpan={5} className="py-8 text-center text-ink-3">nothing failed. nice.</Td></tr>}</tbody>
    </Table>
  );
  if (detail === "people") return (
    <Table label="people by use">
      <thead><tr><Th>turns in the window</Th><Th className="!text-end">people</Th><Th>active days</Th><Th className="!text-end">people</Th></tr></thead>
      <tbody>{data.people.buckets.map((bucket, i) => <tr key={bucket.key}><Td>{bucket.label}</Td><Td className="text-end font-mono num">{n(bucket.count)}</Td><Td>{data.people.activeDays[i]?.label}</Td><Td className="text-end font-mono num">{n(data.people.activeDays[i]?.count ?? 0)}</Td></tr>)}</tbody>
    </Table>
  );
  if (detail === "adoption") return (
    <Table label="adoption">
      <thead><tr><Th>reached</Th><Th className="!text-end">people</Th><Th className="!text-end">of signups</Th></tr></thead>
      <tbody>{data.adoption.map((step) => <tr key={step.id}><Td>{step.label}</Td><Td className="text-end font-mono num">{n(step.count)}</Td><Td className="text-end font-mono num">{percent(data.adoption[0]!.count ? step.count / data.adoption[0]!.count : null)}</Td></tr>)}</tbody>
    </Table>
  );
  if (detail === "frustration") return (
    <div className="flex flex-col gap-2">
      {data.frustration.groups.map((group) => (
        <div key={group.key} className="rounded-[16px] bg-card px-4 py-3">
          <div className="flex items-center gap-3 text-13"><span className="min-w-0 flex-1 truncate text-ink">{words(group.category)} with {label("tools", group.touch)} on {group.engine}</span><Trend values={group.trend} tone="var(--viz-refund)" /><span className="font-mono num">{n(group.count)}</span><Change now={group.count} before={group.previous} /></div>
          {group.examples.map((example) => <p key={example} className="mt-1.5 text-13 leading-5 text-ink-3">"{example}"</p>)}
        </div>
      ))}
      {!data.frustration.groups.length && <p className="py-6 text-center text-13 text-ink-3">no frustration reported in this window.</p>}
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      {data.themes.map((theme) => (
        <div key={theme.key} className={cx("rounded-[16px] px-4 py-3", theme.pain ? "bg-wash-pink" : "bg-card")}>
          <div className="flex items-center gap-2 text-13"><span className="flex-1 text-ink">{theme.label}{theme.pain && <span className="ms-2 text-12 text-ink-3">pain</span>}</span><span className="font-mono num">{n(theme.count)}</span></div>
          {theme.examples.map((example) => <p key={example} className="mt-1.5 text-13 leading-5 text-ink-3">"{example}"</p>)}
        </div>
      ))}
      {!data.themes.length && <p className="py-6 text-center text-13 text-ink-3">no weekly notes yet. they come from people who use it a few days a week. every note is on the feedback page.</p>}
    </div>
  );
}

function FocusBox({ items, open }: { items: UsageAnswer["focus"]; open(detail: Detail): void }) {
  return (
    <section aria-label="where to focus" className="rounded-[24px] bg-wash-lemon p-5">
      <div className="mb-3 flex items-center gap-2"><Lightbulb size={16} strokeWidth={1.75} className="text-ink-2" aria-hidden /><h3 className="text-15 font-medium text-ink">where to focus</h3></div>
      {items.length ? (
        <ol className="flex flex-col gap-1">
          {items.map((item, i) => (
            <m.li key={item.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", visualDuration: 0.32, bounce: 0, delay: i * 0.05 }}>
              <button type="button" onClick={() => open(item.target as Detail)} className="hover-row flex w-full items-start gap-3 rounded-[12px] px-2 py-2 text-start">
                <span className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-pop font-mono text-12 text-ink num">{i + 1}</span>
                <span className="text-14 leading-6 text-ink">{item.text}</span>
              </button>
            </m.li>
          ))}
        </ol>
      ) : <p className="text-14 leading-6 text-ink-2">nothing stands out yet. once a few people have used their bots for a while, the strongest signals show up here.</p>}
    </section>
  );
}

function EngineShare({ rows, onOpen }: { rows: Row[]; onOpen(): void }) {
  const top = rows.slice(0, 6), rest = rows.slice(6).reduce((sum, row) => sum + row.turns, 0), total = Math.max(1, rows.reduce((sum, row) => sum + row.turns, 0));
  const parts = [...top.map((row) => ({ key: row.key, turns: row.turns })), ...(rest ? [{ key: "rest", turns: rest }] : [])];
  return (
    <button type="button" onClick={onOpen} className="block w-full text-start">
      <div className="flex h-3 overflow-hidden rounded-full bg-track" aria-hidden>
        {parts.map((part, i) => <m.span key={part.key} className="h-full" style={{ background: ENGINE_COLOR[i % ENGINE_COLOR.length] }} initial={{ width: 0 }} animate={{ width: `${(part.turns / total) * 100}%` }} transition={{ type: "spring", visualDuration: 0.5, bounce: 0 }} />)}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-13">
        {parts.map((part, i) => <li key={part.key} className="inline-flex items-center gap-1.5 text-ink-2"><span className="size-2.5 rounded-[3px]" style={{ background: ENGINE_COLOR[i % ENGINE_COLOR.length] }} aria-hidden />{part.key === "rest" ? "the rest" : part.key}<span className="font-mono text-ink-3 num">{percent(part.turns / total)}</span></li>)}
      </ul>
    </button>
  );
}

function Stat({ label: title, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-[18px] bg-pop px-4 py-3">
      <div className="truncate text-12 text-ink-3">{title}</div>
      <div className="mt-0.5 truncate font-mono text-[22px] font-medium leading-8 tracking-[-0.04em] text-ink num"><Figure value={value} className="!font-mono !text-[22px] !leading-8 !tracking-[-0.04em]" /></div>
      {note && <div className="line-clamp-2 text-12 text-ink-3">{note}</div>}
    </div>
  );
}

/** what people use Metal for: categories, apps, engines, routines, failures, frustration and where to look first */
export function UsageSection({ range }: { range: Range }) {
  const { data, error, loading, reload } = useAdmin<UsageAnswer>(`/usage?from=${range.from}&to=${range.to}`, 120_000);
  const [detail, setDetail] = useState<Detail | null>(null);
  const open = (next: Detail) => setDetail(next);
  if (error) return <Failed error={error} retry={reload} />;
  if (!data) return loading ? <Loading rows={6} /> : null;
  const t = data.totals, r = data.routines;
  const madeTotal = r.made.routines + r.made.webhooks + r.made.appEvents;
  return (
    <section aria-labelledby="usage-title" className={cx("rounded-[28px] bg-card p-2 transition-opacity duration-150", loading && "opacity-80")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pb-3 pt-3">
        <h2 id="usage-title" className="text-17 font-medium tracking-[-0.02em] text-ink">what people use it for</h2>
        <span className="text-12 text-ink-4">counts from bots' turns, never what was said</span>
      </div>
      {!data.tracked ? (
        <div className="mx-1 mb-1 flex items-center gap-4 rounded-[22px] bg-wash-sky px-5 py-6">
          <Bot size={28} strokeWidth={1.5} className="shrink-0 text-ink-2" aria-hidden />
          <div><p className="text-15 font-medium text-ink">no bot turns reported yet.</p><p className="mt-0.5 text-13 leading-5 text-ink-3">once people's desktops and clouds are connected and their bots get to work, what they use them for shows up here: categories, apps, engines, routines and what breaks.</p></div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-2 max-lg:grid-cols-1">
            <FocusBox items={data.focus} open={open} />
            <div className="grid grid-cols-2 gap-2 rounded-[24px] bg-wash-sky p-2">
              <Stat label="bot turns" value={n(t.turns)} note={<Change now={t.turns} before={data.previous.turns} />} />
              <Stat label="people using bots" value={n(t.people)} note={t.perPersonDay !== null ? `${Math.round(t.perPersonDay * 10) / 10} turns a day each` : undefined} />
              <Stat label="worked" value={percent(t.success)} note={`${percent(t.failRate)} failed, ${percent(t.cancelRate)} stopped`} />
              <Stat label="reply time" value={duration(t.p50Ms)} note={t.p90Ms !== null ? `slowest 10% over ${duration(t.p90Ms)}` : undefined} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 max-lg:grid-cols-1">
            <Card title="top tasks" icon={<Target {...I} />} action={<More onClick={() => open("categories")} />} className="col-span-1 max-lg:col-span-1">
              <ul className="grid grid-cols-1 gap-1.5">
                {data.categories.slice(0, 5).map((row, i) => {
                  const look = CATEGORY[row.key] ?? CATEGORY.other!;
                  return (
                    <m.li key={row.key} layout="position" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ type: "spring", visualDuration: 0.3, bounce: 0, delay: i * 0.04 }}>
                      <button type="button" onClick={() => open("categories")} className={cx("flex w-full items-center gap-3 rounded-[14px] px-3 py-2 text-start transition-[filter] duration-150 hover:brightness-[0.98]", look.wash)}>
                        <span aria-hidden className="text-ink-2">{look.icon}</span>
                        <span className="min-w-0 flex-1 truncate text-13 text-ink">{look.label}</span>
                        <Trend values={row.trend} />
                        <span className="w-10 text-end font-mono text-13 text-ink num">{percent(row.share)}</span>
                      </button>
                    </m.li>
                  );
                })}
              </ul>
            </Card>
            <Card title="top connected apps" icon={<Plug {...I} />} action={<More onClick={() => open("apps")} />}><Ranked rows={data.apps} kind="apps" onOpen={() => open("apps")} />
              {data.more && <button type="button" onClick={() => open("connects")} className="hover-link mt-1 px-2.5 text-12 text-ink-3">connecting and top actions</button>}</Card>
            <Card title="top tools" icon={<SquareTerminal {...I} />} action={<More onClick={() => open("tools")} />}><Ranked rows={data.tools.filter((row) => row.key !== "other" && row.key !== "memory")} kind="tools" onOpen={() => open("tools")} /></Card>
          </div>

          <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
            <Card title="which ai does the work" icon={<Cpu {...I} />} action={<More onClick={() => open("engines")} />}><EngineShare rows={data.engines} onOpen={() => open("engines")} /></Card>
            <Card title="where people chat from" icon={<Smartphone {...I} />} action={<More onClick={() => open("sources")} />}><Ranked rows={data.sources} kind="sources" onOpen={() => open("sources")} limit={5} /></Card>
          </div>

          <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
            <Card title="routines" icon={<Repeat {...I} />} wash="bg-wash-lime" action={<More onClick={() => open("routines")} />}>
              <button type="button" onClick={() => open("routines")} className="grid w-full grid-cols-3 gap-2 text-start">
                <Stat label="made" value={n(madeTotal)} note={`by ${n(r.peopleWithRoutines)} people`} />
                <Stat label="ran" value={n(r.runs)} note={`${percent(r.runs ? (r.runs - r.failed) / r.runs : null)} worked`} />
                <Stat label="ran twice" value={percent(r.peopleWithRoutines ? r.peopleRanTwice / r.peopleWithRoutines : null)} note="of people who made one" />
              </button>
              <p className="mt-2 px-1 text-12 text-ink-3">{n(r.made.routines)} scheduled, {n(r.made.appEvents)} on app events, {n(r.made.webhooks)} webhooks.{data.more?.routines.survival.share != null ? ` ${percent(data.more.routines.survival.share)} still run a week later.` : ""}</p>
            </Card>
            <Card title="what fails most" icon={<AlertTriangle {...I} />} wash="bg-wash-pink" action={<More onClick={() => open("failures")} />}>
              {data.failures.length ? (
                <ol className="flex flex-col gap-0.5">
                  {data.failures.slice(0, 4).map((row) => (
                    <li key={`${row.kind}:${row.key}`}><button type="button" onClick={() => open("failures")} className="hover-row flex w-full items-center gap-3 rounded-[10px] px-2.5 py-1.5 text-start text-13">
                      <span className="min-w-0 flex-1"><span className="text-ink">{label(row.kind === "tool" ? "tools" : row.kind, row.key)}</span> <span className="text-ink-3">{row.reasonWords}</span></span>
                      <span className="font-mono text-ink num">{percent(row.rate)}</span>
                    </button></li>
                  ))}
                </ol>
              ) : <p className="px-2 py-3 text-13 text-ink-2">nothing failed in this window.</p>}
            </Card>
          </div>

          <div className="grid grid-cols-3 gap-2 max-lg:grid-cols-1">
            <Card title="power users and casual" icon={<Users {...I} />} action={<More onClick={() => open("people")} />}>
              <button type="button" onClick={() => open("people")} className="block w-full text-start">
                <div className="flex h-24 items-end gap-1.5">
                  {data.people.buckets.map((bucket, i) => {
                    const max = Math.max(1, ...data.people.buckets.map((b) => b.count));
                    return <div key={bucket.key} className="flex flex-1 flex-col items-center gap-1"><span className="font-mono text-[11.5px] text-ink-3 num">{n(bucket.count)}</span>
                      <m.span className="w-full rounded-[6px] bg-accent/70" initial={{ height: 0 }} animate={{ height: `${Math.max(4, (bucket.count / max) * 64)}px` }} transition={{ type: "spring", visualDuration: 0.4, bounce: 0, delay: i * 0.04 }} /></div>;
                  })}
                </div>
                <div className="mt-1.5 flex gap-1.5">{data.people.buckets.map((bucket) => <span key={bucket.key} className="flex-1 truncate text-center text-[11.5px] text-ink-4">{bucket.label}</span>)}</div>
                <p className="mt-2 text-12 text-ink-3">{data.people.topShare !== null ? `top 10% do ${percent(data.people.topShare)} of turns. ` : ""}{data.people.medianTurns !== null ? `the middle person did ${n(data.people.medianTurns)}.` : ""}</p>
              </button>
              {data.more && <button type="button" onClick={() => open("bots")} className="hover-link mt-1 text-12 text-ink-3">their bots</button>}
            </Card>
            <Card title="how far people get" icon={<Compass {...I} />} action={<More onClick={() => open("adoption")} />} className="col-span-2 max-lg:col-span-1">
              <button type="button" onClick={() => open("adoption")} className="flex w-full flex-col gap-1.5 text-start">
                {data.adoption.map((step, i) => {
                  const first = Math.max(1, data.adoption[0]!.count);
                  return (
                    <div key={step.id} className="flex items-center gap-3 text-13">
                      <span className="w-36 shrink-0 truncate text-ink-2">{step.label}</span>
                      <span className="relative h-6 flex-1 overflow-hidden rounded-[8px] bg-track"><m.span className="absolute inset-y-0 left-0 rounded-[8px] bg-wash-lilac" initial={{ width: 0 }} animate={{ width: `${(step.count / first) * 100}%` }} transition={{ type: "spring", visualDuration: 0.45, bounce: 0, delay: i * 0.05 }} /></span>
                      <span className="w-10 text-end font-mono text-ink num">{n(step.count)}</span>
                      <span className="w-12 text-end text-12 text-ink-3 num">{i ? percent(step.count / first) : ""}</span>
                    </div>
                  );
                })}
              </button>
            </Card>
          </div>

          <div className="grid grid-cols-2 gap-2 max-lg:grid-cols-1">
            <Card title="what's frustrating people" icon={<MessageSquare {...I} />} wash="bg-wash-pink" action={<More onClick={() => open("frustration")} />}>
              {data.frustration.groups.length ? (
                <ol className="flex flex-col gap-1.5">
                  {data.frustration.groups.slice(0, 3).map((group) => (
                    <li key={group.key}><button type="button" onClick={() => open("frustration")} className="w-full rounded-[14px] bg-pop/70 px-3 py-2 text-start">
                      <span className="flex items-center gap-2 text-13"><span className="min-w-0 flex-1 truncate text-ink">{words(group.category)} with {label("tools", group.touch)} on {group.engine}</span><Trend values={group.trend} tone="var(--viz-refund)" /><span className="font-mono num">{n(group.count)}</span></span>
                      {group.examples[0] && <span className="mt-1 line-clamp-2 block text-12 leading-[18px] text-ink-3">"{group.examples[0]}"</span>}
                    </button></li>
                  ))}
                </ol>
              ) : <p className="px-2 py-3 text-13 text-ink-2">no one's been frustrated in this window.</p>}
              {data.frustration.signals.length > 0 && <p className="mt-2 px-1 text-12 text-ink-3">{data.frustration.signals.slice(0, 4).map((s) => `${SIGNAL[s.key] ?? words(s.key)} ${n(s.count)}`).join(", ")}</p>}
            </Card>
            <Card title="themes from weekly notes" icon={<ChartColumn {...I} />} wash="bg-wash-lilac" action={<More onClick={() => open("themes")} />}>
              {data.themes.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {data.themes.slice(0, 10).map((theme) => (
                    <li key={theme.key}><button type="button" onClick={() => open("themes")} className={cx("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-13", theme.pain ? "bg-wash-pink text-ink" : "bg-pop/70 text-ink")}>{theme.label}<span className="font-mono text-12 text-ink-3 num">{n(theme.count)}</span></button></li>
                  ))}
                </ul>
              ) : <p className="px-2 py-3 text-13 text-ink-2">no weekly notes yet. they come from people who use it a few days a week. every note is on the feedback page.</p>}
            </Card>
          </div>
          {data.more && <MoreCards more={data.more} open={open} />}
        </div>
      )}
      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail ? DETAIL_TITLE[detail] : ""} wide>
        {detail && <div className="mt-2 max-h-[65vh] overflow-y-auto">{data && <DetailTable detail={detail} data={data} />}</div>}
      </Modal>
    </section>
  );
}
