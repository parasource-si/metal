import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { RefreshCw } from "@/icons";
import { Button, cx, Segmented } from "../ui/kit";
import { SkyEmpty } from "../ui/Sky";
import { AnimatePresence, m, Pill, usePill, useSlots } from "../ui/motion";
import { Figure } from "../ui/Figure";
import { ago } from "../lib/format";
import { useNow } from "../lib/now";
import { toast } from "../lib/toast";
import { AdminApiError, adminCall, adminMoney, MONEY_KEY, useAdmin, useAdminRole } from "./api";
import { countryName } from "./geo";
import { flagOf } from "./person";
import { Avatar, CHANNEL, duration, percent, personName, usd } from "./kit";
import { BarRow, ChartCard, StackedBars } from "./charts";
import { CohortHeat, LineChart, MoneyDelta, MovementChart, Sparkline, monthName } from "./RevenueCharts";
import { AdminHeader, Failed, Loading, n, SearchBox } from "./ui";
import { STATUS } from "./PersonBilling";
import { InfraMargin } from "./InfraMargin";
import { Fold } from "./Fold";
import { CustomerLink, ModeChip } from "./CustomerSheet";
import type { BreakdownRow, CustomerRow, FeedItem, FeedKind, Health, MoneyMode, RevenueFunnelStep, RiskRow, SubscriptionReport } from "./revenue-types";

const DAY = 86_400_000;
const words = (value: string) => value.replace(/_/g, " ");

/** which money the revenue numbers count: live (the default), test (dodo test mode) or both; kept per browser, shared by every view */
type MoneyView = MoneyMode | "all";
const moneyListeners = new Set<() => void>();
const readMoney = (): MoneyView => adminMoney();
export function useMoneyView(): [MoneyView, (next: MoneyView) => void] {
  const value = useSyncExternalStore((fn) => { moneyListeners.add(fn); return () => void moneyListeners.delete(fn); }, readMoney, () => "live" as const);
  const set = (next: MoneyView) => { try { if (next === "live") localStorage.removeItem(MONEY_KEY); else localStorage.setItem(MONEY_KEY, next); } catch { /* private mode keeps live */ } moneyListeners.forEach((fn) => fn()); };
  return [value, set];
}
const MONEY_OPTIONS: Array<{ value: MoneyView; label: string }> = [{ value: "live", label: "live" }, { value: "test", label: "test" }, { value: "all", label: "all" }];
function MoneySwitch() {
  const [view, setView] = useMoneyView();
  return <Segmented<MoneyView> label="which money" value={view} onChange={setView} options={MONEY_OPTIONS} />;
}
/** live and test totals side by side, so test money is visible without ever joining the live numbers */
function MoneyTotals({ report }: { report: SubscriptionReport }) {
  const [, setView] = useMoneyView();
  if (!report.modes) return null;
  const { live, test } = report.modes;
  const line = (label: string, t: typeof live) => `${label}: ${usd(t.mrr, true)} mrr, ${n(t.customers)} paying, ${usd(t.gross, true)} charged`;
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-12 text-ink-3">
      <span>{line("live", live)}</span>
      <span className="inline-flex items-center gap-1.5"><ModeChip mode="test" />{line("test", test)}</span>
      {report.mode === "live" && report.serverMode === "test" && !live.payments && test.payments > 0 && <button type="button" onClick={() => setView("test")} className="text-link h-8 text-12">this server takes test payments. show them</button>}
    </p>
  );
}
const shortDay = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
const signed = (cents: number) => `${cents > 0 ? "+" : ""}${usd(cents, true)}`;
const rate = (v: number | null) => v === null ? "-" : percent(v);

function Chip({ children, wash = "bg-card" }: { children: ReactNode; wash?: string }) {
  return <span className={cx("inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[11.5px] text-ink-2", wash)}>{children}</span>;
}

/** a card with its title row and a light inner panel, like ChartCard, with room for a meta line on the right */
function Card({ title, meta, action, children, className, flush }: { title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx("flex min-w-0 flex-col rounded-[24px] bg-card p-2", className)}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 px-2 pb-1.5 pt-1">
        <h2 id={id} className="text-14 font-medium text-ink">{title}</h2>
        {action ?? (meta && <span className="t-meta">{meta}</span>)}
      </div>
      <div className={cx("flex-1 rounded-[18px] bg-pop", flush ? "p-1.5" : "p-3")}>{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-7 text-center text-13 text-ink-3">{children}</p>;
}

/** one headline number and its change on last month */
function Metric({ label, value, delta, money, hint }: { label: string; value: string; delta: ReactNode; money?: boolean; hint?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col rounded-[16px] px-4 pb-3 pt-3.5", money ? "bg-wash-lime" : "bg-pop")} title={hint}>
      <div className="truncate text-13 font-medium text-ink-3">{label}</div>
      <div className={cx("mt-1 truncate font-mono text-[26px] font-medium leading-9 tracking-[-0.045em] num", money ? "text-money" : "text-ink")}>
        <Figure value={value} className="!font-mono !text-[26px] !leading-9 !tracking-[-0.045em] ![color:inherit]" />
      </div>
      <div className="mt-1 h-5 truncate leading-5">{delta}</div>
    </div>
  );
}

function Small({ label, value, note, money }: { label: string; value: string; note?: string; money?: boolean }) {
  return (
    <div className="min-w-0 px-3 py-2" title={note}>
      <div className="truncate text-12 text-ink-3">{label}</div>
      <div className={cx("mt-0.5 truncate font-mono text-15 font-medium num", money ? "text-money" : "text-ink")}>{value}</div>
    </div>
  );
}

function Headline({ report }: { report: SubscriptionReport }) {
  const h = report.headline, p = h.previous;
  return (
    <section className="grid grid-cols-4 gap-1.5 rounded-[24px] bg-card p-2 max-lg:grid-cols-2" aria-label="headline numbers">
      <Metric label="mrr" value={usd(h.mrr, true)} money delta={<MoneyDelta now={h.mrr} before={p.mrr} />} />
      <Metric label="net new this month" value={signed(h.netNewMrr)} delta={<MoneyDelta now={h.netNewMrr} before={p.netNewMrr} mode="usd" />} hint="new, expansion and comebacks, less contraction and churn, this month" />
      <Metric label="active customers" value={n(h.customers)} delta={<MoneyDelta now={h.customers} before={p.customers} />} />
      <Metric label="churn" value={rate(h.customerChurn)} delta={<MoneyDelta now={h.customerChurn} before={p.customerChurn} mode="points" invert />} hint="customers lost per month, over the last three full months" />
    </section>
  );
}

/** mrr over the year, or what moved it each month */
function Growth({ report }: { report: SubscriptionReport }) {
  const [view, setView] = useState<"mrr" | "movement">("mrr");
  return (
    <ChartCard title="mrr over time" action={<Segmented<"mrr" | "movement"> label="show" value={view} onChange={setView} options={[{ value: "mrr", label: "mrr" }, { value: "movement", label: "movement" }]} />}>
      {view === "mrr"
        ? <LineChart starts={report.months.map((row) => row.start)} height={260} format={(v) => usd(v, true)} series={[{ key: "mrr", label: "mrr", color: "var(--viz-new)", values: report.months.map((row) => row.mrr) }]} />
        : <MovementChart months={report.months} />}
    </ChartCard>
  );
}

function OtherNumbers({ report }: { report: SubscriptionReport }) {
  const h = report.headline;
  return (
    <ChartCard title="other numbers">
      <div className="-m-1.5 grid grid-cols-4 max-lg:grid-cols-2">
        <Small label="arr" value={usd(h.arr, true)} money />
        <Small label="ltv" value={h.ltv === null ? "-" : usd(h.ltv, true)} money note="arpu divided by monthly customer churn" />
        <Small label="arpu" value={h.arpu === null ? "-" : usd(h.arpu)} money note="mrr per paying customer" />
        <Small label="paid so far, per customer" value={h.ltvRealised === null ? "-" : usd(h.ltvRealised, true)} money note="what the average customer has actually paid, after refunds" />
        <Small label="net revenue retention" value={rate(h.nrr)} note="mrr kept from last quarter's customers, counting upgrades" />
        <Small label="gross revenue retention" value={rate(h.grr)} note="mrr kept from last quarter's customers, upgrades left out" />
        <Small label="revenue churn" value={rate(h.revenueChurn)} note="mrr lost to churn and downgrades per month" />
        <Small label="net revenue churn" value={rate(h.netRevenueChurn)} note="revenue churn less expansion; below zero means growth from existing customers" />
      </div>
    </ChartCard>
  );
}

function SyncButton({ sync, onDone }: { sync: SubscriptionReport["sync"]; onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const now = useNow(60_000);
  if (!sync.available) return null;
  const run = async () => {
    setBusy(true);
    try {
      const answer = await adminCall<{ scanned: number; added: number }>("/revenue/sync", { method: "POST", body: {} });
      toast(answer.added ? `synced. ${n(answer.added)} new of ${n(answer.scanned)} checked.` : `synced. all ${n(answer.scanned)} already here.`);
      onDone();
    } catch (err) {
      toast(err instanceof AdminApiError && err.status === 409 ? "billing isn't on dodo, so there's nothing to sync." : (err as Error).message, "bad");
    } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      {sync.last && <span className="text-12 text-ink-3">last synced {ago(sync.last.at, now)}, {n(sync.last.added)} added</span>}
      <Button size="sm" disabled={busy} aria-busy={busy} onClick={() => void run()}>
        <m.span className="inline-flex" aria-hidden animate={busy ? { rotate: 360 } : { rotate: 0 }} transition={busy ? { repeat: Infinity, duration: 0.9, ease: "linear" } : { duration: 0 }}><RefreshCw size={14} strokeWidth={1.75} /></m.span>
        {busy ? "syncing" : "sync from dodo"}
      </Button>
    </div>
  );
}

function Churn({ report }: { report: SubscriptionReport }) {
  const starts = report.months.map((row) => row.start);
  return (
    <ChartCard title="churn">
      <LineChart starts={starts} format={(v) => `${Math.round(v * 1000) / 10}%`} series={[
        { key: "customers", label: "customer churn", color: "var(--viz-renewal)", values: report.months.map((row) => row.customerChurn) },
        { key: "revenue", label: "revenue churn", color: "var(--viz-refund)", values: report.months.map((row) => row.grossRevenueChurn) },
        { key: "net", label: "net revenue churn", color: "var(--ink-4)", values: report.months.map((row) => row.netRevenueChurn), dashed: true },
      ]} />
    </ChartCard>
  );
}

function Dunning({ report }: { report: SubscriptionReport }) {
  const d = report.dunning, starts = report.months.map((row) => row.start);
  const at = (t: number) => d.months.find((row) => row.start === t);
  return (
    <ChartCard title="failed payments and recovery">
      <div className="mb-3 grid grid-cols-4 gap-1 rounded-[14px] bg-card max-sm:grid-cols-2">
        <Small label="recovered" value={rate(d.rate)} note={`${n(d.recovered)} of ${n(d.failed)} failed payments came back`} />
        <Small label="mrr saved" value={usd(d.recoveredMrr, true)} money />
        <Small label="still retrying" value={n(d.open)} />
        <Small label="lost" value={n(d.lost)} />
      </div>
      {d.failed ? (
        <StackedBars starts={starts} size={30 * DAY} height={140} format={(v) => n(v)} label={(t, long) => monthName(t, long)} stacks={[
          { key: "recovered", label: "recovered", color: "var(--viz-new)", values: starts.map((t) => at(t)?.recovered ?? 0) },
          { key: "lost", label: "not recovered", color: "color-mix(in oklab, var(--viz-renewal) 40%, var(--pop))", values: starts.map((t) => { const row = at(t); return row ? row.failed - row.recovered : 0; }) },
        ]} />
      ) : <Empty>no failed payments. every card has gone through.</Empty>}
    </ChartCard>
  );
}

type BreakdownTab = keyof SubscriptionReport["breakdown"];
const BREAKDOWN_TABS: Array<[BreakdownTab, string]> = [["plan", "plan"], ["interval", "billing"], ["channel", "channel"], ["source", "source"], ["country", "country"], ["cohort", "first paid"]];
function breakdownLabel(tab: BreakdownTab, key: string) {
  if (tab === "channel") return CHANNEL[key] ?? key;
  if (tab === "country") return key === "unknown" ? "unknown" : `${flagOf(key)} ${countryName(key)}`.trim();
  if (tab === "interval") return key === "month" ? "monthly" : key === "year" ? "yearly" : key;
  if (tab === "cohort" && /^\d{4}-\d{2}$/.test(key)) { const [y, mo] = key.split("-").map(Number); return monthName(Date.UTC(y!, mo! - 1, 1), true); }
  return key;
}
function Breakdown({ breakdown }: { breakdown: SubscriptionReport["breakdown"] }) {
  const [tab, setTab] = useState<BreakdownTab>("plan");
  const [by, setBy] = useState<"mrr" | "revenue">("mrr");
  const pill = usePill();
  const rows = [...breakdown[tab]].sort((a, b) => b[by] - a[by]).slice(0, 10);
  const max = Math.max(1, ...rows.map((row) => row[by]));
  const slots = useSlots(rows.map((row) => `${tab}:${row.key}`));
  return (
    <section aria-label="where the mrr comes from" className="flex min-w-0 flex-col rounded-[24px] bg-card p-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1.5 pt-1">
        <div role="tablist" aria-label="split mrr by" className="scroll-x flex max-w-full gap-0.5">
          {BREAKDOWN_TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={cx("relative inline-flex h-8 shrink-0 items-center rounded-full px-3 text-13", tab === id ? "font-medium text-ink" : "text-ink-3 hover-link")}>{tab === id && <Pill id={pill} />}<span className="relative">{label}</span></button>
          ))}
        </div>
        <Segmented<"mrr" | "revenue"> label="measure" value={by} onChange={setBy} options={[{ value: "mrr", label: "mrr" }, { value: "revenue", label: "all time" }]} />
      </div>
      <div role="tabpanel" className="flex-1 rounded-[18px] bg-pop p-1.5">
        {rows.length ? (
          <ul className="flex flex-col gap-px">
            <AnimatePresence initial={false} mode="popLayout">
              {rows.map((row: BreakdownRow, i) => <BarRow key={slots[i]} label={breakdownLabel(tab, row.key)} muted={row.key === "unknown"} value={usd(row[by], true)} share={row[by] / max} color="bg-wash-lime"
                note={`${n(row.customers)} paying`} />)}
            </AnimatePresence>
          </ul>
        ) : <Empty>no paying customers to split yet.</Empty>}
      </div>
    </section>
  );
}

function Line({ label, value, tone, strong }: { label: string; value: string; tone?: "money" | "quiet"; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-13">
      <span className={strong ? "text-ink" : "text-ink-2"}>{label}</span>
      <span className={cx("font-mono num", strong && "font-medium", tone === "money" ? "text-money" : tone === "quiet" ? "text-ink-3" : "text-ink")}>{value}</span>
    </div>
  );
}

function Cash({ report }: { report: SubscriptionReport }) {
  const c = report.cash, r = report.refunds;
  return (
    <Card title="cash" meta={`${n(c.payments)} payments, all time`}>
      <Line label="charged" value={usd(c.gross)} tone="money" />
      <Line label="refunded" value={c.refunds ? `-${usd(c.refunds)}` : usd(0)} tone="quiet" />
      <Line label="tax and fees" value={c.tax ? `-${usd(c.tax)}` : usd(0)} tone="quiet" />
      <div className="my-1 h-px bg-line" aria-hidden />
      <Line label="kept, after tax and refunds" value={usd(c.afterTax)} tone="money" strong />
      {c.settled < c.payments && <p className="mt-2 rounded-[12px] bg-wash-lemon px-3 py-2 text-12 text-ink-2">tax figures come from {n(c.settled)} of {n(c.payments)} payments; the rest count at what was charged until they settle.</p>}
      <h3 className="mt-4 text-13 font-medium text-ink">refunds and disputes</h3>
      <div className="mt-1 grid grid-cols-3 gap-1 rounded-[14px] bg-card">
        <Small label="refund rate" value={rate(r.rate)} note={`${n(r.count)} refunds, ${usd(r.cents)}`} />
        <Small label="last 30 days" value={rate(r.rate30)} note={`${n(r.count30)} refunds, ${usd(r.cents30)}`} />
        <Small label="disputes" value={n(r.disputes)} note={`${rate(r.disputeRate)} of payments, ${n(r.disputesOpen)} open`} />
      </div>
      <p className="mt-2 text-12 text-ink-4">{n(r.count)} refund{r.count === 1 ? "" : "s"} ({usd(r.cents)}) and {n(r.disputes)} dispute{r.disputes === 1 ? "" : "s"}, {r.disputesOpen ? `${n(r.disputesOpen)} still open` : "none open"}.</p>
    </Card>
  );
}

const STAGE: Record<string, string> = { visit: "bg-wash-sky", signup: "bg-wash-lilac", checkout: "bg-wash-lemon", paid: "bg-wash-lime", retained: "bg-wash-lime" };
/** visitor to paying customer to still paying a month later, for people first seen in the window */
export function RevenueFunnel({ steps, compact }: { steps: RevenueFunnelStep[]; compact?: boolean }) {
  const first = Math.max(1, steps[0]?.count ?? 1);
  return (
    <ol className="flex flex-col gap-1" aria-label="revenue funnel">
      {steps.map((step, i) => {
        const prev = steps[i - 1], share = step.count / first;
        const base = step.of ?? prev?.count ?? 0, kept = prev ? (base ? step.count / base : null) : null;
        return (
          <li key={step.id} className={cx("grid items-center gap-3", compact ? "grid-cols-[minmax(0,156px)_minmax(0,1fr)_64px] max-sm:grid-cols-[minmax(0,1fr)_60px]" : "grid-cols-[minmax(0,168px)_minmax(0,1fr)_76px] max-sm:grid-cols-[minmax(0,1fr)_72px]")}>
            <span className="truncate text-13 text-ink-2 max-sm:col-span-2 max-sm:-mb-1 max-sm:text-12" title={step.label}>{step.label}</span>
            <span className={cx("relative flex items-center overflow-hidden rounded-[10px] px-3", compact ? "h-8" : "h-9")}>
              <m.span className={cx("absolute inset-0", STAGE[step.id] ?? "bg-wash-sky")} initial={{ clipPath: "inset(0% 100% 0% 0% round 10px)" }}
                animate={{ clipPath: `inset(0% ${(100 - Math.max(1.5, share * 100)).toFixed(2)}% 0% 0% round 10px)` }} transition={{ type: "spring", visualDuration: 0.45, bounce: 0, delay: Math.min(0.3, i * 0.04) }} aria-hidden />
              <span className="relative flex items-baseline gap-2">
                <Figure value={n(step.count)} className="!font-mono !text-15 !leading-6 !tracking-[-0.02em]" />
                {step.of !== undefined && <span className="font-mono text-12 text-ink-3">of {n(step.of)} due</span>}
              </span>
            </span>
            <span className="flex justify-end">
              {prev && <span className="inline-flex h-6 items-center whitespace-nowrap rounded-full bg-card px-2 font-mono text-12 text-ink-3 num" title={step.of !== undefined ? `${n(step.count)} of the ${n(step.of)} who paid at least a month ago` : `${n(step.count)} of ${n(prev.count)}`}>{kept === null ? "-" : percent(kept)}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Checkout({ checkout }: { checkout: SubscriptionReport["checkout"] }) {
  const rows = checkout.bySource.filter((row) => row.started > 0).slice(0, 8);
  const slots = useSlots(rows.map((row) => row.source));
  return (
    <Card title="checkout" meta="last 90 days">
      <div className="grid grid-cols-4 gap-1 rounded-[14px] bg-card max-sm:grid-cols-2">
        <Small label="started" value={n(checkout.started)} />
        <Small label="paid" value={n(checkout.paid)} />
        <Small label="left without paying" value={n(checkout.abandoned)} note={checkout.open ? `${n(checkout.open)} still open` : undefined} />
        <Small label="conversion" value={rate(checkout.conversion)} />
      </div>
      {(checkout.detectedAbandoned > 0 || checkout.recovered > 0) && <p className="mt-2 text-12 text-ink-3">{n(checkout.detectedAbandoned)} flagged as abandoned by the provider, {n(checkout.recovered)} came back and paid.</p>}
      <h3 className="mt-4 text-13 font-medium text-ink">by where checkout started</h3>
      {rows.length ? (
        <ul className="mt-1 flex flex-col gap-px">
          <AnimatePresence initial={false}>
            {rows.map((row, i) => <BarRow key={slots[i]} label={words(row.source)} muted={row.source === "unknown"} value={percent(row.paid / row.started)} share={row.paid / row.started} color="bg-wash-lime" note={`${n(row.paid)} of ${n(row.started)}`} />)}
          </AnimatePresence>
        </ul>
      ) : <Empty>no checkouts in the last 90 days.</Empty>}
    </Card>
  );
}

const REASONS: Record<string, string> = { price: "too expensive", unused: "not using it", broken: "something broke", feature: "missing a feature", switching: "switching to something else",
  setup: "too hard to set up", later: "coming back later", other: "something else" };

/** who is leaving or might, and who was kept: the cancel flow, failed cards that came back, and the people worth a look */
function Saves({ report }: { report: SubscriptionReport }) {
  const flow = report.cancelFlow, d = report.dunning, risk = report.risk;
  const top = flow ? Math.max(1, ...flow.reasons.map((row) => row.started || row.saved + row.cancelled)) : 1;
  const atStake = risk.reduce((s, row) => s + row.mrr, 0);
  return (
    <Card title="cancellations and saves" meta="last 90 days">
      <div className="grid grid-cols-2 gap-6 max-lg:grid-cols-1">
        <div className="min-w-0">
          <div className="grid grid-cols-4 gap-1 rounded-[14px] bg-card max-sm:grid-cols-2">
            <Small label="opened cancel" value={flow ? n(flow.started) : "-"} />
            <Small label="saved" value={flow ? n(flow.saved) : "-"} note={flow ? `${n(flow.discounts)} took the discount` : undefined} />
            <Small label="cancelled" value={flow ? n(flow.cancelled) : "-"} />
            <Small label="cards recovered" value={rate(d.rate)} note={`${n(d.recovered)} of ${n(d.failed)} failed payments came back, ${n(d.open)} still retrying`} />
          </div>
          {flow && flow.reasons.length ? (
            <ul className="mt-3 flex flex-col gap-px">
              {flow.reasons.map((row) => <BarRow key={row.reason} label={REASONS[row.reason] ?? words(row.reason)} value={n(row.started)} share={(row.started || row.saved + row.cancelled) / top} color="bg-wash-lilac" note={`${n(row.saved)} saved, ${n(row.cancelled)} cancelled`} />)}
            </ul>
          ) : <Empty>no one has opened the cancel flow yet.</Empty>}
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 px-1 pb-1">
            <h3 className="text-13 font-medium text-ink">needs a look</h3>
            {risk.length > 0 && <span className="t-meta">{usd(atStake, true)} mrr at stake</span>}
          </div>
          <RiskList risk={risk} />
        </div>
      </div>
    </Card>
  );
}

function TimeToPay({ data }: { data: SubscriptionReport["timeToPay"] }) {
  const max = Math.max(1, ...data.buckets.map((b) => b.count)), total = data.buckets.reduce((s, b) => s + b.count, 0);
  return (
    <Card title="signup to first payment" meta={data.median === null ? undefined : `median ${duration(data.median)}`} flush>
      {total ? (
        <ul className="flex flex-col gap-px">
          {data.buckets.map((b) => <BarRow key={b.label} label={b.label} value={n(b.count)} share={b.count / max} color="bg-wash-sky" note={percent(b.count / total)} />)}
        </ul>
      ) : <Empty>no one has paid yet. this fills in with the first customer.</Empty>}
    </Card>
  );
}

function PersonCell({ accountId, email, name, sub }: { accountId: string; email: string | null; name?: string | null; sub?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar seed={accountId} size={24} customer account={{ id: accountId }} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-2"><span className="truncate text-14 font-medium text-ink" title={email ?? undefined}>{personName(accountId, email)}</span>{name && <span className="shrink-0 truncate text-13 text-ink-3 max-sm:hidden">{name}</span>}</span>
        {sub && <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-12 text-ink-3">{sub}</span>}
      </span>
    </span>
  );
}

function Renewals({ report }: { report: SubscriptionReport }) {
  const now = useNow(60_000);
  const [all, setAll] = useState(false);
  const list = all ? report.upcoming : report.upcoming.slice(0, 7);
  const total = report.upcoming.reduce((s, row) => s + row.amountCents, 0);
  return (
    <Card title="renewing in the next 30 days" meta={report.upcoming.length ? `${n(report.upcoming.length)} · ${usd(total, true)} due` : undefined} flush>
      {list.length ? (
        <ul>
          {list.map((row) => (
            <li key={`${row.accountId}:${row.at}`}>
              <CustomerLink accountId={row.accountId} className="hover-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-2.5 py-2">
                <PersonCell accountId={row.accountId} email={row.email} sub={<>{row.plan}{row.interval === "year" ? ", yearly" : ""}{row.activeDays !== null && <span className="text-ink-4">· active {n(row.activeDays)} of 14 days</span>}</>} />
                <span className="text-end">
                  <span className="block font-mono text-14 font-medium text-money num">{usd(row.amountCents)}</span>
                  <span className="block text-12 text-ink-4">{Math.max(0, Math.round((row.at - now) / DAY)) === 0 ? "today" : `in ${Math.round((row.at - now) / DAY)} days`}</span>
                </span>
              </CustomerLink>
            </li>
          ))}
        </ul>
      ) : <Empty>nothing renews in the next 30 days.</Empty>}
      {report.upcoming.length > 7 && <button type="button" onClick={() => setAll((v) => !v)} className="text-link mx-auto mt-1 block h-8 px-3 text-12">{all ? "show fewer" : `show all ${report.upcoming.length}`}</button>}
    </Card>
  );
}

const REASON: Record<RiskRow["reason"], { label: string; wash: string }> = {
  payment_failed: { label: "payment failed", wash: "bg-wash-pink" },
  cancel_scheduled: { label: "set to cancel", wash: "bg-wash-lilac" },
  low_usage: { label: "barely using it", wash: "bg-wash-lemon" },
};
function RiskList({ risk }: { risk: RiskRow[] }) {
  if (!risk.length) return <Empty>everyone looks fine. no failed cards, no cancellations, no one going quiet.</Empty>;
  return (
    <>
      <ul className="-mx-1.5">
        {risk.slice(0, 6).map((row) => (
          <li key={`${row.accountId}:${row.reason}`}>
            <CustomerLink accountId={row.accountId} className="hover-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-2.5 py-2">
              <PersonCell accountId={row.accountId} email={row.email} sub={<><Chip wash={REASON[row.reason].wash}>{REASON[row.reason].label}</Chip>{row.plan}{row.renewsAt && <span className="text-ink-4">· renews {shortDay(row.renewsAt)}</span>}</>} />
              <span className="text-end">
                <span className="block font-mono text-14 text-ink-2 num">{usd(row.mrr)}<span className="text-12 text-ink-4">/mo</span></span>
                <span className="block text-12 text-ink-4">{row.activeDays === null ? "no app use seen" : `active ${n(row.activeDays)} of 14 days`}</span>
              </span>
            </CustomerLink>
          </li>
        ))}
      </ul>
      {risk.length > 6 && <p className="px-1 pt-1 text-12 text-ink-4">{n(risk.length - 6)} more in the customer list below.</p>}
    </>
  );
}

const FEED: Record<FeedKind, { emoji: string; label: string; wash: string }> = {
  new: { emoji: "💰", label: "new customer", wash: "bg-wash-lime" },
  renewal: { emoji: "🔁", label: "renewed", wash: "bg-wash-lilac" },
  payment: { emoji: "💳", label: "paid", wash: "bg-wash-lemon" },
  failed: { emoji: "⚠️", label: "payment failed", wash: "bg-wash-pink" },
  refund: { emoji: "↩️", label: "refunded", wash: "bg-wash-pink" },
  dispute: { emoji: "🚩", label: "dispute opened", wash: "bg-wash-pink" },
  dispute_closed: { emoji: "🏁", label: "dispute closed", wash: "bg-card" },
  cancel_scheduled: { emoji: "👋", label: "set to cancel", wash: "bg-wash-lilac" },
  kept: { emoji: "🤝", label: "decided to stay", wash: "bg-wash-lime" },
  churned: { emoji: "👋", label: "churned", wash: "bg-card" },
  upgrade: { emoji: "📈", label: "upgraded", wash: "bg-wash-lime" },
  downgrade: { emoji: "📉", label: "downgraded", wash: "bg-wash-lilac" },
  recovered: { emoji: "💪", label: "recovered", wash: "bg-wash-lime" },
  abandoned: { emoji: "🛒", label: "left checkout", wash: "bg-wash-lemon" },
};
const feedDetail = (item: FeedItem) => !item.detail ? null : /^[A-Z]{2}$/.test(item.detail) ? `${flagOf(item.detail)} ${countryName(item.detail)}` : words(item.detail);
const PAID: ReadonlySet<FeedKind> = new Set(["new", "renewal", "payment"]);

function Feed({ feed }: { feed: FeedItem[] }) {
  const now = useNow(30_000);
  const [filter, setFilter] = useState<"all" | "money" | "trouble">("all");
  const [all, setAll] = useState(false);
  const shown = feed.filter((item) => filter === "all" || (filter === "money" ? PAID.has(item.kind) || item.kind === "upgrade" || item.kind === "recovered" : !PAID.has(item.kind) && item.kind !== "upgrade" && item.kind !== "recovered" && item.kind !== "kept"));
  const list = all ? shown : shown.slice(0, 10);
  return (
    <Card title="money moments" action={<Segmented<"all" | "money" | "trouble"> label="show" value={filter} onChange={(v) => { setFilter(v); setAll(false); }} options={[{ value: "all", label: "all" }, { value: "money", label: "money in" }, { value: "trouble", label: "trouble" }]} />} flush>
      {list.length ? (
        <ul>
          <AnimatePresence initial={false}>
            {list.map((item) => {
              const k = FEED[item.kind], detail = feedDetail(item);
              const body = (
                <>
                  <span className="flex min-w-0 items-center gap-3">
                    <span aria-hidden className={cx("grid size-8 shrink-0 place-items-center rounded-full text-[15px]", k.wash)}>{k.emoji}</span>
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2"><span className="truncate text-14 font-medium text-ink">{item.accountId ? personName(item.accountId, item.email) : "someone"}</span></span>
                      <span className="mt-0.5 block truncate text-12 text-ink-3">{k.label}{item.plan ? ` · ${item.plan}` : ""}{detail ? ` · ${detail}` : ""}</span>
                    </span>
                  </span>
                  <span className="text-end">
                    {item.mrrDelta !== null && item.mrrDelta !== 0 ? <span className={cx("block font-mono text-14 num", item.mrrDelta > 0 ? "font-medium text-money" : "text-ink-3")}>{signed(item.mrrDelta)}<span className="text-12 text-ink-4">/mo</span></span>
                      : item.amountCents !== null ? <span className={cx("block font-mono text-14 num", PAID.has(item.kind) && item.amountCents > 0 ? "font-medium text-money" : "text-ink-3")}>{PAID.has(item.kind) && item.amountCents > 0 ? `+${usd(item.amountCents)}` : item.amountCents < 0 ? `-${usd(-item.amountCents)}` : usd(item.amountCents)}</span>
                      : <span className="block font-mono text-14 text-ink-4">-</span>}
                    <span className="block text-12 text-ink-4">{ago(item.at, now)}</span>
                  </span>
                </>
              );
              return (
                <m.li key={item.id} layout="position" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ type: "spring", visualDuration: 0.28, bounce: 0 }}>
                  {item.accountId ? <CustomerLink accountId={item.accountId} className="hover-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-2.5 py-2">{body}</CustomerLink>
                    : <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2.5 py-2">{body}</div>}
                </m.li>
              );
            })}
          </AnimatePresence>
        </ul>
      ) : <Empty>{filter === "trouble" ? "no trouble. nothing failed, refunded or cancelled." : "no money moments yet. the first payment shows up here."}</Empty>}
      {shown.length > 10 && <button type="button" onClick={() => setAll((v) => !v)} className="text-link mx-auto mt-1 block h-8 px-3 text-12">{all ? "show fewer" : `show all ${shown.length}`}</button>}
    </Card>
  );
}

const HEALTH: Record<Health, { label: string; wash: string }> = {
  good: { label: "healthy", wash: "bg-wash-lime" }, watch: { label: "gone quiet", wash: "bg-wash-lemon" }, risk: { label: "at risk", wash: "bg-wash-pink" }, gone: { label: "gone", wash: "bg-card" },
};

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange(v: string): void; options: Array<[string, string]> }) {
  const id = useId();
  return (
    <span>
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="field !h-9 !w-auto !rounded-full !px-3.5 !text-13">
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </span>
  );
}

const COLS = "grid-cols-[minmax(0,2.2fr)_minmax(0,0.9fr)_84px_84px_minmax(0,0.9fr)_minmax(0,1fr)] max-md:grid-cols-[minmax(0,1fr)_auto]";
function Customers({ customers }: { customers: CustomerRow[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all"), [plan, setPlan] = useState("all"), [channel, setChannel] = useState("all"), [health, setHealth] = useState("all");
  const [sort, setSort] = useState<"mrr" | "ltv" | "newest">("mrr");
  const [all, setAll] = useState(false);
  const plans = useMemo(() => [...new Set(customers.map((c) => c.plan))].sort(), [customers]);
  const channels = useMemo(() => [...new Set(customers.map((c) => c.channel))].sort(), [customers]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return customers.filter((c) => (status === "all" || c.status === status) && (plan === "all" || c.plan === plan) && (channel === "all" || c.channel === channel) && (health === "all" || c.health === health)
      && (!needle || [c.email ?? "", c.name ?? "", c.accountId, c.plan, c.source, c.country ? countryName(c.country) : ""].some((v) => v.toLowerCase().includes(needle))))
      .sort((a, b) => sort === "mrr" ? b.mrr - a.mrr || b.ltv - a.ltv : sort === "ltv" ? b.ltv - a.ltv : (b.firstPaidAt ?? 0) - (a.firstPaidAt ?? 0));
  }, [customers, q, status, plan, channel, health, sort]);
  useEffect(() => setAll(false), [q, status, plan, channel, health]);
  const list = all ? rows : rows.slice(0, 10);
  const slots = useSlots(list.map((c) => c.accountId));
  const filtered = q || status !== "all" || plan !== "all" || channel !== "all" || health !== "all";
  return (
    <section aria-labelledby="customers-title" className="rounded-[24px] bg-card p-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2 pt-1">
        <h2 id="customers-title" className="text-14 font-medium text-ink">customers <span className="ms-1 font-mono text-12 font-normal text-ink-4">{filtered ? `${n(rows.length)} of ${n(customers.length)}` : n(customers.length)}</span></h2>
        <Segmented<"mrr" | "ltv" | "newest"> label="sort by" value={sort} onChange={setSort} options={[{ value: "mrr", label: "mrr" }, { value: "ltv", label: "lifetime" }, { value: "newest", label: "newest" }]} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-1 pb-2">
        <SearchBox value={q} onChange={setQ} label="search customers" placeholder="email, name, plan, source or country" />
        <Filter label="status" value={status} onChange={setStatus} options={[["all", "any status"], ...Object.entries(STATUS).map(([k, v]) => [k, v.label] as [string, string])]} />
        <Filter label="plan" value={plan} onChange={setPlan} options={[["all", "any plan"], ...plans.map((p) => [p, p] as [string, string])]} />
        <Filter label="channel" value={channel} onChange={setChannel} options={[["all", "any channel"], ...channels.map((c) => [c, CHANNEL[c] ?? c] as [string, string])]} />
        <Filter label="health" value={health} onChange={setHealth} options={[["all", "any health"], ...Object.entries(HEALTH).map(([k, v]) => [k, v.label] as [string, string])]} />
      </div>
      <div className="rounded-[18px] bg-pop p-1.5">
        {list.length ? (
          <>
            <div className={cx("grid gap-4 px-2.5 py-2 t-meta max-md:hidden", COLS)}><span>customer</span><span>plan</span><span className="text-end">mrr</span><span className="text-end">lifetime</span><span>health</span><span>came from</span></div>
            <ul>
              <AnimatePresence initial={false} mode="popLayout">
                {list.map((c, i) => (
                  <m.li key={slots[i]} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ layout: { type: "spring", visualDuration: 0.3, bounce: 0 }, opacity: { duration: 0.16 } }}>
                    <CustomerLink accountId={c.accountId} className={cx("hover-row grid items-center gap-4 rounded-[12px] px-2.5 py-2.5", COLS)}>
                      <PersonCell accountId={c.accountId} email={c.email} name={c.name} sub={<>
                        <Chip wash={STATUS[c.status].wash}>{STATUS[c.status].label}</Chip>
                        <ModeChip mode={c.mode} />
                        <span className="text-ink-4">{c.status === "churned" && c.churnedAt ? `left ${shortDay(c.churnedAt)}` : c.renewsAt ? `renews ${shortDay(c.renewsAt)}` : c.firstPaidAt ? `since ${shortDay(c.firstPaidAt)}` : ""}</span>
                        <span className="md:hidden">· {c.plan}</span>
                        {c.failed > 0 && <span className="text-ink-4">· {n(c.failed)} failed</span>}
                      </>} />
                      <span className="min-w-0 truncate text-13 text-ink-2 max-md:hidden">{c.plan}{c.interval === "year" ? <span className="text-ink-4">, yearly</span> : null}</span>
                      <span className={cx("text-end font-mono text-14 num", c.mrr > 0 ? "font-medium text-money" : "text-ink-4")}>{c.mrr > 0 ? usd(c.mrr) : "-"}<span className="block text-12 font-normal text-ink-4 md:hidden">{usd(c.ltv, true)} lifetime</span></span>
                      <span className="text-end font-mono text-13 text-money num max-md:hidden">{usd(c.ltv, true)}</span>
                      <span className="max-md:hidden"><Chip wash={HEALTH[c.health].wash}>{HEALTH[c.health].label}</Chip></span>
                      <span className="min-w-0 max-md:hidden"><span className="block truncate text-13 text-ink-2">{c.source === "unknown" ? <span className="text-ink-4">unknown</span> : c.source}</span><span className="block truncate text-12 text-ink-4">{CHANNEL[c.channel] ?? c.channel}{c.country ? ` · ${flagOf(c.country)} ${countryName(c.country)}` : ""}</span></span>
                    </CustomerLink>
                  </m.li>
                ))}
              </AnimatePresence>
            </ul>
          </>
        ) : <Empty>{filtered ? "no customers match these filters." : "no customers yet. the first one lands here the moment they pay."}</Empty>}
      </div>
      {rows.length > 10 && <button type="button" onClick={() => setAll((v) => !v)} className="text-link mx-auto mt-1.5 block h-8 px-3 text-12">{all ? "show fewer" : `show all ${n(rows.length)}`}</button>}
      <p className="px-3 pt-1 text-12 text-ink-4">lifetime is what they paid, after refunds. gone quiet means they used Metal on one day or fewer in the last two weeks.</p>
    </section>
  );
}

const DAYS: Array<[string, string]> = [["30", "30 days"], ["90", "90 days"], ["365", "a year"]];
export function RevenuePage() {
  const [days, setDays] = useState("90");
  const [money] = useMoneyView();
  const { data, error, loading, reload } = useAdmin<SubscriptionReport>(`/revenue?days=${days}&mode=${money}`, 60_000);
  const empty = data !== null && data.customers.length === 0 && data.cash.payments === 0;
  const owner = useAdminRole() === "owner";
  return (
    <>
      <AdminHeader title="revenue" sub="mrr, churn and every customer, straight from the billing records." action={<div className="flex flex-wrap items-center gap-3"><MoneySwitch />{owner && data && <SyncButton sync={data.sync} onDone={reload} />}</div>} />
      {error && <Failed error={error} retry={reload} />}
      {!data && loading && <Loading rows={8} />}
      {data && (
        <div className={cx("flex flex-col gap-4 transition-opacity duration-150", loading && "opacity-80")}>
          <MoneyTotals report={data} />
          {empty ? (
            <section className="rounded-[24px] bg-card"><SkyEmpty art="notebook" title={money === "live" ? "no live subscriptions yet." : money === "test" ? "no test subscriptions." : "no subscriptions yet."}>{money === "live" ? "test-mode payments never count here. switch to test to see them." : "the first paid plan lands here with mrr, churn, cohorts and every customer."}</SkyEmpty></section>
          ) : (
            <>
              <Headline report={data} />
              <Growth report={data} />
              <Saves report={data} />
              {owner && <Customers customers={data.customers} />}
              <Fold title="cohorts" meta="who keeps paying, month by month"><div className="rounded-[18px] bg-pop p-3"><CohortHeat cohorts={data.cohorts} /></div></Fold>
            </>
          )}
          <Fold plain title="more" meta={owner ? "churn, cash, funnel, margin, renewals and the feed" : "churn, cash, funnel and the feed"}>
            <div className="flex flex-col gap-4">
              {!empty && <OtherNumbers report={data} />}
              {!empty && <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1"><Churn report={data} /><Dunning report={data} /><Breakdown breakdown={data.breakdown} /><Cash report={data} /></div>}
              <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
                <Card title="revenue funnel" action={<Segmented label="people first seen in" value={days} onChange={setDays} options={DAYS.map(([value, label]) => ({ value, label }))} />}>
                  <RevenueFunnel steps={data.funnel.steps} />
                  <p className="mt-3 text-12 text-ink-4">people first seen in the last {days === "365" ? "year" : `${days} days`}; month 2 counts those who paid at least a month ago.</p>
                </Card>
                <Checkout checkout={data.checkout} />
              </div>
              {owner && <InfraMargin />}
              {!empty && (
                <div className="grid grid-cols-2 items-start gap-4 max-lg:grid-cols-1">
                  <div className="flex min-w-0 flex-col gap-4">{owner && <Renewals report={data} />}<TimeToPay data={data.timeToPay} /></div>
                  <Feed feed={data.feed} />
                </div>
              )}
            </div>
          </Fold>
        </div>
      )}
    </>
  );
}

const BUYER_COLS = "grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)_88px_96px] max-md:grid-cols-[minmax(0,1fr)_auto]";
const paidAt = (c: CustomerRow) => c.lastPaidAt ?? c.firstPaidAt ?? 0;

/** who bought: the newest payers first, and the whole list with search and filters one tap away */
function Buyers({ customers }: { customers: CustomerRow[] }) {
  const now = useNow(60_000);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState(""), [plan, setPlan] = useState("all"), [status, setStatus] = useState("all");
  const plans = useMemo(() => [...new Set(customers.map((c) => c.plan))].sort(), [customers]);
  const sorted = useMemo(() => [...customers].filter((c) => c.payments > 0 || c.lastPaidAt !== null).sort((a, b) => paidAt(b) - paidAt(a)), [customers]);
  const rows = useMemo(() => {
    if (!all) return sorted.slice(0, 5);
    const needle = q.trim().toLowerCase();
    return sorted.filter((c) => (plan === "all" || c.plan === plan) && (status === "all" || c.status === status)
      && (!needle || [c.email ?? "", c.name ?? "", personName(c.accountId, c.email)].some((v) => v.toLowerCase().includes(needle))));
  }, [sorted, all, q, plan, status]);
  const slots = useSlots(rows.map((c) => c.accountId));
  const filtered = all && (q.trim() !== "" || plan !== "all" || status !== "all");
  const toggle = () => { setAll((v) => !v); setQ(""); setPlan("all"); setStatus("all"); };
  return (
    <div className="rounded-[18px] bg-pop p-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1.5 pb-1 pt-0.5">
        <h3 id="buyers-title" className="text-13 font-medium text-ink">who bought <span className="ms-1 font-mono text-12 font-normal text-ink-4">{filtered ? `${n(rows.length)} of ${n(sorted.length)}` : n(sorted.length)}</span></h3>
        {sorted.length > 5 && <button type="button" onClick={toggle} aria-expanded={all} aria-controls="buyers-list" className="text-link inline-flex h-8 items-center px-1.5 text-12">{all ? "show latest" : `show all ${n(sorted.length)}`}</button>}
      </div>
      {all && (
        <div className="flex flex-wrap items-center gap-2 px-1 pb-2 pt-1">
          <SearchBox value={q} onChange={setQ} label="search customers by email or name" placeholder="search by email or name" />
          <Filter label="plan" value={plan} onChange={setPlan} options={[["all", "any plan"], ...plans.map((p) => [p, p] as [string, string])]} />
          <Filter label="status" value={status} onChange={setStatus} options={[["all", "any status"], ...Object.entries(STATUS).map(([k, v]) => [k, v.label] as [string, string])]} />
        </div>
      )}
      {rows.length ? (
        <ul id="buyers-list" aria-labelledby="buyers-title">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((c, i) => (
              <m.li key={slots[i]} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }} transition={{ layout: { type: "spring", visualDuration: 0.25, bounce: 0 }, opacity: { duration: 0.16 } }}>
                <CustomerLink accountId={c.accountId} className={cx("hover-row grid items-center gap-4 rounded-[12px] px-2 py-2", BUYER_COLS)}>
                  <PersonCell accountId={c.accountId} email={c.email} name={c.name} sub={<>
                    <Chip wash={STATUS[c.status].wash}>{STATUS[c.status].label}</Chip>
                    <ModeChip mode={c.mode} />
                    {c.country && <span title={countryName(c.country)}><span aria-hidden>{flagOf(c.country)}</span><span className="sr-only">{countryName(c.country)}</span></span>}
                    <span className="truncate md:hidden">{c.plan}{c.interval ? `, ${c.interval === "year" ? "yearly" : "monthly"}` : ""}</span>
                  </>} />
                  <span className="min-w-0 truncate text-13 text-ink-2 max-md:hidden">{c.plan}{c.interval && <span className="text-ink-4">, {c.interval === "year" ? "yearly" : "monthly"}</span>}</span>
                  <span className="text-end font-mono text-14 num">
                    <span className={c.lastPaidCents ? "font-medium text-money" : "text-ink-4"}>{c.lastPaidCents ? usd(c.lastPaidCents) : "-"}</span>
                    <span className="block font-sans text-12 text-ink-4 md:hidden">{ago(paidAt(c) || null, now).toLowerCase()}</span>
                  </span>
                  <span className="truncate text-end text-12 text-ink-3 max-md:hidden">{ago(paidAt(c) || null, now).toLowerCase()}</span>
                </CustomerLink>
              </m.li>
            ))}
          </AnimatePresence>
        </ul>
      ) : <Empty>{filtered ? "no one matches these filters." : "no one has paid yet. the first customer shows up here."}</Empty>}
      {rows.length > 0 && <p className="px-2 pb-1 pt-1 text-12 text-ink-4">amounts are their latest payment, before tax.</p>}
    </div>
  );
}

/** the overview's money line: mrr, net new and customers, the path from visitor to a second month's payment, and who bought */
export function RevenueStrip({ days }: { days: number }) {
  const [money] = useMoneyView();
  const { data } = useAdmin<SubscriptionReport>(`/revenue?days=${Math.min(400, Math.max(7, days))}&mode=${money}`, 120_000);
  if (!data) return <div className="h-[120px] rounded-[24px] bg-card" aria-busy="true" />;
  const h = data.headline;
  return (
    <section aria-labelledby="revenue-strip" className="flex flex-col gap-1.5 rounded-[24px] bg-card p-2">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-1.5 max-lg:grid-cols-1">
        <div className="flex flex-col rounded-[18px] bg-pop p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="revenue-strip" className="text-14 font-medium text-ink">subscriptions</h2><MoneySwitch /></div>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <div className="min-w-0"><div className="truncate text-12 text-ink-3">mrr</div><div className="truncate font-mono text-[22px] font-medium leading-8 tracking-[-0.04em] text-money num"><Figure value={usd(h.mrr, true)} className="!font-mono !text-[22px] !leading-8 !tracking-[-0.04em] ![color:inherit]" /></div><MoneyDelta now={h.mrr} before={h.previous.mrr} /></div>
            <div className="min-w-0"><div className="truncate text-12 text-ink-3">net new</div><div className={cx("truncate font-mono text-[22px] font-medium leading-8 tracking-[-0.04em] num", h.netNewMrr >= 0 ? "text-money" : "text-ink-2")}>{signed(h.netNewMrr)}</div><span className="text-12 text-ink-4">this month</span></div>
            <div className="min-w-0"><div className="truncate text-12 text-ink-3">customers</div><div className="truncate font-mono text-[22px] font-medium leading-8 tracking-[-0.04em] text-ink num"><Figure value={n(h.customers)} className="!font-mono !text-[22px] !leading-8 !tracking-[-0.04em]" /></div><MoneyDelta now={h.customers} before={h.previous.customers} /></div>
          </div>
          <div className="mt-auto pt-4"><Sparkline values={data.months.map((row) => row.mrr)} color="var(--ink-4)" height={40} label="mrr over the last 12 months" /></div>
        </div>
        <div className="rounded-[18px] bg-pop p-3">
          <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-13 font-medium text-ink">visitor to paying</h3><span className="t-meta">first seen in the last {data.funnel.days} days</span></div>
          <RevenueFunnel steps={data.funnel.steps} compact />
        </div>
      </div>
      <Buyers customers={data.customers} />
      <MoneyTotals report={data} />
    </section>
  );
}
