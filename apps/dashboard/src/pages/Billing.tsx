import { useEffect, useState, type ReactNode } from "react";
import { APP_CLOUD_LINK, fromApp, markFromApp } from "../lib/from-app";
import { setFlowNote } from "../lib/flow-note";
import { Check, ChevronDown, Download } from "@/icons";
import { useCloud } from "../data/cloud";
import { LoadError } from "./common";
import type { BillingInterval, ChangeOffer, LicenseId, PlanCatalog, Selection } from "../data/contracts";
import { bundleOf, desktopOf, gb, licenseMonthly, licenseOf, perMonthOn } from "../data/pricing";
import { useSession } from "../data/session";
import { track } from "../lib/analytics";
import { useCart } from "../data/quote";
import { longDate, shortDate, usd } from "../lib/format";
import { navigate, useLocation } from "../lib/router";
import { planIntent } from "../lib/site";
import { Badge, Card, cx, PageHeader } from "../ui/kit";
import { Mascot } from "../ui/Mascot";
import { PlansSkeleton } from "../ui/plans-skeleton";
import meadow from "../art/p-meadow.webp";
import peaks from "../art/p-peaks.webp";
import sky from "../art/p-sky.webp";
import layers from "../art/wide-layers-plain.webp";
import { SectionHead } from "../ui/table";
import { regionName } from "./cloud-bits";
import { AnimatePresence, EASE_OUT, m } from "../ui/motion";
import { Digits } from "../ui/Digits";
import { CancelFlow, CONTACT } from "./cancel-flow";
import { BUSY, cartText, CHECKOUT_PLAN_KEY, IntervalToggle, LicenseSheet, money, OfferLine, offerAction, PlanSheet, planName, planSelection, priceText, sharedRegions, switchedToast, useInterval, Working, type PaidPlan } from "./plan-sheet";
import { CHECKOUT_SOON, checkoutDone, trialAction } from "./cloud-offer";

export { IntervalToggle, useInterval };

const members = (n: number) => `${n} ${n === 1 ? "member" : "members"}`;
export type Tier = "free" | PaidPlan | "team";
/** the cards the plans page shows: free next to the cloud plans until someone is on one, then team in its place */
export const tiersFor = (onCloud: boolean): Tier[] => (onCloud ? ["starter", "pro", "team"] : ["free", "starter", "pro"]);

/** three rows, the machine first; every number comes from the catalog */
export function points(id: Exclude<Tier, "free">, catalog: PlanCatalog): string[] {
  const b = bundleOf(catalog, id);
  const d = b ? desktopOf(catalog, b.desktop) : null;
  if (!d) return [];
  const machine = `${d.vcpu} vcpu, ${gb(d.ramGb)} ram, ${gb(d.diskGb)} disk`;
  if (id === "team") return [`dedicated ${machine}`, "always available 24/7", `team license, ${members(b!.members)}`];
  return id === "pro" ? [machine, "always available 24/7", "work license for one person"] : [machine, "always available 24/7", "set up in one click"];
}
const ART = { free: sky, starter: meadow, pro: layers, team: peaks } as const;
const FREE_POINTS = ["your bots on this computer", "they work while it's awake", "every bot, chat and connector, for personal use"];

// the motion brief's (2026-11) enter spring: a card rising into place
const ENTER = { type: "spring" as const, stiffness: 300, damping: 22 };

function PlanCard({ id, catalog, interval, current, onChoose, href, action, disabled, busy = false, note, trial, i }: { id: Tier; catalog: PlanCatalog; interval: BillingInterval; current: boolean; onChoose: (() => void) | null; href?: string; action: string; disabled: boolean; busy?: boolean; note?: ReactNode; trial?: number; i: number }) {
  const b = bundleOf(catalog, id);
  const paid = id !== "free";
  const monthly = b?.monthly ?? 0;
  const perMonth = interval === "year" ? Math.round(perMonthOn(monthly, interval, catalog)) : monthly;
  const sub = !paid ? "on your own computer" : (trial ? `free for ${trial} ${trial === 1 ? "day" : "days"}, then ` : "") + (interval === "year" ? `per month · ${priceText(monthly, interval, catalog).replace("/yr", "")} billed yearly, + tax where applicable` : "per month, + tax where applicable");
  return (
    <m.article className={cx("surface flex min-w-0 flex-col rounded-card bg-card p-2.5 pb-7", !paid && "max-lg:order-last")} aria-labelledby={`plan-card-${id}`}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...ENTER, delay: i * 0.045 }}>
      <img src={ART[id]} alt="" width={800} height={354} className="aspect-[800/300] w-full rounded-[16px] object-cover object-bottom" draggable={false} />
      <div className="flex flex-1 flex-col px-4 pt-5 max-sm:px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 id={`plan-card-${id}`} className="text-24 font-medium tracking-[-0.035em] text-ink">{b?.name ?? id}</h2>
          {paid && <span className="text-14 text-ink-3">dusk cloud</span>}
          {current && <Badge>current</Badge>}
        </div>
        <p className="num mt-4 text-[48px] font-medium leading-none tracking-[-0.05em] text-ink"><Digits text={`$${perMonth}`} /></p>
        <p className="num mt-2 grid text-13 text-ink-3">
          <AnimatePresence initial={false}>
            <m.span key={sub} className="[grid-area:1/1]" initial={{ opacity: 0, y: 8, filter: "blur(3px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
              exit={{ opacity: 0, y: -6, filter: "blur(2px)", transition: { duration: 0.12, ease: EASE_OUT } }} transition={{ duration: 0.2, ease: EASE_OUT }}>{sub}</m.span>
          </AnimatePresence>
        </p>
        {href ? (
          <a href={href} className="press hover-btn mt-6 grid h-12 w-full place-items-center rounded-full bg-btn text-15 font-medium text-ink">{action}</a>
        ) : onChoose ? (
          <button type="button" onClick={onChoose} disabled={disabled || busy} aria-busy={busy} className={cx("press hover-btn mt-6 inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-full bg-btn text-15 font-medium text-ink disabled:cursor-default disabled:opacity-50", busy && BUSY)}>{busy ? <Working>{action}</Working> : action}</button>
        ) : <p className="mt-6 grid h-12 place-items-center rounded-full text-14 text-ink-3">{action}</p>}
        {note}
        <h3 className="sr-only">what you get</h3>
        <ul className="mt-6 flex flex-col gap-3">
          {(paid ? points(id, catalog) : FREE_POINTS).map((pt) => <li key={pt} className={cx("flex gap-2.5 text-14", paid ? "text-ink-2" : "text-ink-3")}><Check size={17} strokeWidth={1.75} className={cx("mt-0.5 shrink-0", paid ? "text-good" : "text-ink-4")} aria-hidden />{pt}</li>)}
        </ul>
      </div>
    </m.article>
  );
}

/** back from the payment page (dodo adds subscription_id or payment_id and a status) without a plan to show yet */
type Back = "pending" | "failed";
export function backFromCheckout(query: URLSearchParams): Back | null {
  if (!query.has("subscription_id") && !query.has("payment_id")) return null;
  const status = query.get("status");
  return status === "pending" || status === "processing" ? "pending" : status === "failed" || status === "cancelled" || status === "expired" ? "failed" : null;
}
const BACK_POLL_MS = 10_000, BACK_POLLS = 18;

/** having come from the app: the website stops here and never opens the app by itself; this is the quiet way back.
 * after paying the app picks the purchase up on its own (its link opens the cloud sheet), so there is nothing to do first */
function OpenApp() {
  return (
    <div role="status" data-open-app="" className="surface mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-card bg-card px-6 py-4">
      <div className="min-w-0">
        <p className="text-14 text-ink">you're all set</p>
        <p className="mt-0.5 text-13 text-ink-3">your cloud is getting ready. Metal picks it up by itself, so open it now or later.</p>
      </div>
      <a href={APP_CLOUD_LINK} data-open-app-link="" className="press hover-btn inline-flex h-10 shrink-0 items-center rounded-full bg-btn px-4.5 text-14 font-medium text-ink">open Metal</a>
    </div>
  );
}

/** back from paying, having come from the app: one clear end to the browser's part, with the way back */
function AllSet({ onStay }: { onStay(): void }) {
  return (
    <div role="status" data-all-set="" className="mx-auto max-w-[460px] pt-10 max-sm:pt-4">
      <div className="flex justify-center"><span className="peek inline-flex"><Mascot color="blue" size={64} state="happy" track /></span></div>
      <Card className="enter relative -mt-4">
        <h1 className="text-20 font-medium text-ink">you're all set</h1>
        <p className="mt-1.5 text-14 leading-[1.55] text-ink-3">go back to Metal. your cloud is getting ready, and Metal picks it up by itself.</p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <a href={APP_CLOUD_LINK} data-open-app-link="" className="press hover-btn inline-flex h-10 items-center rounded-full bg-ink px-4.5 text-14 font-medium text-bg">open Metal</a>
          <button type="button" onClick={onStay} className={quiet}>see your plan</button>
        </div>
      </Card>
    </div>
  );
}

function CheckoutBack({ back, onCheck, onRetry }: { back: Back; onCheck(): void; onRetry(): void }) {
  const pending = back === "pending";
  return (
    <div role="status" className="surface mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-card bg-card px-6 py-4">
      <div className="min-w-0">
        <p className="text-14 text-ink">{pending ? "your payment is still going through" : "the payment didn't go through"}</p>
        <p className="mt-0.5 text-13 text-ink-3">{pending ? "your bank is still confirming it. your plan shows up here the moment it does, usually within a few minutes." : "nothing was charged. try again, or use another card."}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {pending && <button type="button" className="press hover-btn h-10 rounded-full bg-btn px-4.5 text-14 font-medium text-ink" onClick={onCheck}>check again</button>}
        <button type="button" className={pending ? quiet : "press hover-btn h-10 rounded-full bg-btn px-4.5 text-14 font-medium text-ink"} onClick={onRetry}>try again</button>
      </div>
    </div>
  );
}

const FAQ = [
  { q: "do i need it if i have a mac?", a: "no. free runs everything on your mac; your bots just pause while it sleeps. add dusk cloud when you want them working while your mac sleeps." },
  { q: "what counts as work use?", a: "anything you do for a company, for a client or to earn money. personal projects, learning and hobbies are personal use, which is free forever." },
];

function Faq() {
  return (
    <section className="mt-16" aria-labelledby="faq-title">
      <SectionHead id="faq-title">questions</SectionHead>
      <div className="">
        {FAQ.map((f) => (
          <details key={f.q} className="group">
            <summary className="hover-link flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3 text-14 text-ink [&::-webkit-details-marker]:hidden">{f.q}<ChevronDown size={16} strokeWidth={1.5} className="shrink-0 text-ink-3 group-open:rotate-180" aria-hidden /></summary>
            <p className="max-w-[64ch] pb-4 text-14 leading-[1.6] text-ink-3">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Row({ k, children, action }: { k: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid min-h-14 grid-cols-[160px_minmax(0,1fr)_auto] items-center gap-4 py-2.5 text-14 max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-y-0.5">
      <dt className="text-ink-3 max-sm:col-span-2 max-sm:text-13">{k}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
      {action ? <dd className="justify-self-end">{action}</dd> : <dd aria-hidden />}
    </div>
  );
}

const quiet = "text-link inline-flex h-9 items-center rounded-full px-1 text-14 disabled:opacity-45 max-sm:h-11";

function YourBilling({ catalog, onLicense, onManage }: { catalog: PlanCatalog; onLicense(): void; onManage(): void }) {
  const { billing, clouds, updateCard, changePlan } = useCloud();
  const { toast } = useSession();
  const [keeping, setKeeping] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);
  const sub = billing?.subscription ?? null;
  const sel = sub?.selection ?? null;
  const { cart } = useCart(sel, catalog);
  const pm = billing?.paymentMethod;
  const invoices = billing?.invoices ?? [];
  const files = invoices.some((inv) => inv.url);
  const lic = sel ? licenseOf(catalog, sel.license) : null;
  const desk = sel && sel.desktop !== "none" ? desktopOf(catalog, sel.desktop) : null;
  const plan = sel && desk ? catalog.bundles.find((b) => b.desktop === sel.desktop && b.id !== "team")?.name ?? desk.name : "free";
  const renews = sub ? (sub.cancelAt ? `ends ${longDate(sub.cancelAt)}` : `renews ${longDate(sub.currentPeriodEnd)}`) : null;
  const applied = billing?.retention?.applied ?? null;
  return (
    <>
      <section className="mt-16" aria-labelledby="billing-title">
        <SectionHead id="billing-title">your billing</SectionHead>
        <dl className="">
          <Row k="plan" action={sub && !sub.cancelAt ? <button type="button" className={quiet} onClick={onManage}>manage subscription</button> : undefined}>
            <span className="block truncate max-sm:whitespace-normal">{plan}{desk && sel ? <span className="text-ink-3">, {clouds?.[0]?.name ?? desk.name} in {regionName(catalog, sel.region)}</span> : <span className="text-ink-3">, your bots run on your mac</span>}</span>
            {sub && <span className="num block truncate text-13 text-ink-3 max-sm:whitespace-normal">{cart ? `${cartText(cart, sub.selection.interval)} · ` : ""}{renews}{applied && !sub.cancelAt ? ` · ${applied.percent}% off for ${applied.cycles} months` : ""}</span>}
          </Row>
          {sub?.scheduled && (
            <Row k="next plan" action={<button type="button" className={quiet} disabled={keeping} onClick={() => {
              setKeeping(true); setKeepError(null);
              changePlan(sub.selection, 0).then(() => toast(`you stay on ${planName(catalog, sub.bundle)}`), (e: Error) => setKeepError(e.message)).finally(() => setKeeping(false));
            }}>{keeping ? "keeping" : `keep ${planName(catalog, sub.bundle)}`}</button>}>
              <span className="num block truncate max-sm:whitespace-normal">{planName(catalog, sub.scheduled.bundle)}<span className="text-ink-3">, from {longDate(sub.scheduled.at)} at {money(sub.scheduled.amountUsd)}{sub.scheduled.selection.interval === "year" ? "/yr" : "/mo"}</span></span>
              <span className="block text-13 text-ink-3">{keepError ? <span role="alert" className="text-bad">{keepError}</span> : `you keep ${planName(catalog, sub.bundle)} and its machine until then. nothing more is charged.`}</span>
            </Row>
          )}
          <Row k="license" action={<button type="button" className={quiet} onClick={onLicense}>{lic?.work ? "change" : "add"}</button>}>
            {lic?.work && sel ? <span className="block truncate max-sm:whitespace-normal">{lic.name} license<span className="num text-ink-3">, {members(sel.members)} · {bundleOf(catalog, "pro")?.license === sel.license && bundleOf(catalog, "pro")?.desktop === sel.desktop ? "included with pro" : priceText(licenseMonthly(lic, sel.members), sel.interval, catalog)}</span></span> : <span className="text-ink-3">personal use, free</span>}
          </Row>
          <Row k="payment method" action={sub && sub.status !== "canceled" ? <button type="button" className={quiet} onClick={() => void updateCard()}>update</button> : undefined}>
            {pm ? <span className="num">{pm.brand.toLowerCase()} •••• {pm.last4}<span className="text-ink-3">, expires {String(pm.expMonth).padStart(2, "0")}/{String(pm.expYear).slice(-2)}</span></span> : sub ? <span className="text-ink-3">the card you paid with</span> : <span className="text-ink-3">none yet. you add one at checkout.</span>}
          </Row>
        </dl>
      </section>
      <section className="mt-12" aria-labelledby="invoices-title">
        <SectionHead id="invoices-title">invoices</SectionHead>
        {invoices.length ? (
          <ul className="">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex min-h-12 items-center gap-4 text-14">
                <span className="num w-16 shrink-0 text-ink-3">{shortDate(inv.date)}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{inv.description}</span>
                {inv.status !== "paid" && <span className={cx("text-13", inv.status === "open" ? "text-warn" : "text-ink-3")}>{inv.status === "open" ? "due" : "refunded"}</span>}
                <span className="num text-ink-2">{usd(inv.amountUsd)}</span>
                {inv.url ? (
                  <a href={inv.url} target="_blank" rel="noreferrer" aria-label={`download invoice ${inv.number}`} className="hover-ghost -me-2 grid size-9 shrink-0 place-items-center rounded-full text-ink-3 max-sm:size-11"><Download size={15} strokeWidth={1.5} /></a>
                ) : files ? <span className="-me-2 size-9 shrink-0 max-sm:size-11" aria-hidden /> : null}
              </li>
            ))}
          </ul>
        ) : <p className="py-5 text-14 text-ink-3">invoices show up here after your first payment.</p>}
      </section>
    </>
  );
}

/** a cloud plan from its card, with no sheet: no plan yet goes straight to checkout; a running plan stops once on the
 * card to show what the switch does (today's charge, the next one and when), then changes in place */
function useDirectPlan(catalog: PlanCatalog | null, interval: BillingInterval) {
  const { billing, checkout, changeCharge, changePlan } = useCloud();
  const { toast } = useSession();
  const owned = billing?.subscription?.selection ?? null;
  const [busy, setBusy] = useState<Tier | null>(null);
  const [error, setError] = useState<{ id: Tier; text: string } | null>(null);
  const [charge, setCharge] = useState<{ id: Tier; key: string; offer: ChangeOffer } | null>(null);
  const selectionFor = (id: Exclude<Tier, "free">): Selection | null => {
    if (!catalog) return null;
    if (id === "team") {
      const team = bundleOf(catalog, "team");
      return owned && team ? { license: "team", members: Math.max(team.members, owned.members), desktop: team.desktop, size: null, region: owned.region, interval: owned.interval } : null;
    }
    const regions = sharedRegions(catalog);
    const region = owned && owned.desktop !== "none" && regions.some((r) => r.id === owned.region) ? owned.region : regions[0]?.id;
    return planSelection(catalog, id, { interval, region, work: Boolean(owned && owned.license !== "personal"), keep: owned });
  };
  const choose = async (id: Exclude<Tier, "free">) => {
    const sel = selectionFor(id);
    if (!catalog || !sel || busy) return;
    const key = JSON.stringify(sel);
    const shown = charge?.id === id && charge.key === key ? charge.offer : null;
    setBusy(id); setError(null);
    try {
      if (owned) {
        if (shown === null) { setCharge({ id, key, offer: await changeCharge(sel) }); return; }
        await changePlan(sel, shown.todayUsd);
        setCharge(null);
        toast(switchedToast(shown, bundleOf(catalog, id)?.name ?? id));
      } else {
        track({ name: "plan_chosen", props: { plan: id, period: interval } });
        if (catalog.checkoutOpen === false) { setError({ id, text: CHECKOUT_SOON }); return; }
        try { sessionStorage.setItem(CHECKOUT_PLAN_KEY, id); } catch {}
        if (await checkout({ source: "dash_billing", kind: "plan", selection: sel, bundle: null })) { toast(checkoutDone(catalog)); navigate("/cloud"); }
        else setError({ id, text: "checkout didn't open. try again." });
      }
    } catch (e) { setCharge(null); setError({ id, text: (e as Error).message }); } finally { setBusy(null); }
  };
  /** what a card shows under its button: the charge to confirm, or what went wrong */
  const note = (id: Tier): ReactNode => {
    if (error?.id === id) return <p role="alert" className="mt-3 text-13 text-bad">{error.text}</p>;
    if (charge?.id !== id || !catalog || id === "free") return null;
    const sel = selectionFor(id);
    return sel && owned && charge.key === JSON.stringify(sel)
      ? <OfferLine offer={charge.offer} from={planName(catalog, billing?.subscription?.bundle)} to={bundleOf(catalog, id)?.name ?? "the new plan"} fromInterval={owned.interval} toInterval={sel.interval} />
      : null;
  };
  const label = (id: Tier, fallback: string) => {
    if (busy === id) return owned ? "switching" : "opening checkout";
    const sel = id !== "free" && charge?.id === id ? selectionFor(id) : null;
    return sel && charge && charge.key === JSON.stringify(sel) ? offerAction(charge.offer, bundleOf(catalog!, id)?.name ?? id, planName(catalog!, billing?.subscription?.bundle)) : fallback;
  };
  return { busy, choose, note, label, retry: (plan: PaidPlan) => void choose(plan) };
}

export function BillingPage() {
  const { catalog, billing, clouds, error, refresh } = useCloud();
  const { query } = useLocation();
  const [interval, setIv] = useInterval();
  const owned = billing?.subscription?.selection ?? null;
  const [planSheet, setPlanSheet] = useState<PaidPlan | null>(null);
  const [licenseSheet, setLicenseSheet] = useState<{ license: LicenseId; members: number } | null>(null);
  const [managing, setManaging] = useState(0);
  const [flowOpen, setFlowOpen] = useState(false);
  const direct = useDirectPlan(catalog, interval);
  const manage = () => { setManaging((n) => n + 1); setFlowOpen(true); };
  // back from the payment page unpaid or still confirming: say so, keep looking for a while, and offer the plan again
  const [back, setBack] = useState<Back | null>(() => backFromCheckout(query));
  // back from the payment page at all (paid or not), and whether the app sent the person here
  const [returned] = useState(() => query.has("subscription_id") || query.has("payment_id"));
  const [stayed, setStayed] = useState(false);
  useEffect(() => {
    markFromApp(query);
    // buying from the app: the cloud is what comes next, not a workspace to connect
    if (!fromApp()) return;
    setFlowNote({ title: "no workspace yet", sub: "dusk cloud shows here once it's ready" });
    return () => setFlowNote(null);
  }, []);
  useEffect(() => { if (query.has("subscription_id") || query.has("payment_id")) navigate("/billing", { replace: true }); }, []);
  const paid = Boolean(billing?.subscription);
  useEffect(() => {
    if (back !== "pending" || paid) return;
    let n = 0;
    const timer = window.setInterval(() => { if (++n > BACK_POLLS) window.clearInterval(timer); else refresh(); }, BACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [back, paid, refresh]);
  const retry = () => {
    let last: string | null = null;
    try { last = sessionStorage.getItem(CHECKOUT_PLAN_KEY); } catch {}
    setBack(null);
    direct.retry(last === "starter" || last === "pro" ? last : "starter");
  };
  // a running plan shows its own billing period and use
  useEffect(() => { if (owned) setIv(owned.interval); }, [owned?.interval]);

  // a plan picked on the site (/billing?plan=pro&period=year, or the older ?bundle=pro) opens its sheet on that plan and period
  const want = query.get("plan") ?? query.get("bundle");
  const period = planIntent(query)?.interval ?? null;
  useEffect(() => {
    if (!catalog || billing === null || !want) return;
    const intent = planIntent(new URLSearchParams({ plan: want }));
    navigate("/billing", { replace: true });
    if (intent) { if (period && !owned) setIv(period); setPlanSheet(intent.plan); }
    else if (want === "team") setLicenseSheet({ license: "team", members: licenseOf(catalog, "team")?.includedMembers ?? 2 });
  }, [catalog, billing, want]);

  if (error && (!catalog || !billing)) return <div><PageHeader title="plans and billing" /><LoadError error={error} retry={refresh} /></div>;
  // paid from the app: the browser's part is over, so it says so and points back, before the plans have even loaded
  if (fromApp() && returned && back === null && !stayed) return <AllSet onStay={() => setStayed(true)} />;
  if (!catalog || billing === null) return <PlansSkeleton />;

  const ownDesk = owned?.desktop ?? "none";
  const current = (id: Tier) => (id === "free" ? ownDesk === "none" : bundleOf(catalog, id)?.desktop === ownDesk);
  const ownsLicense = Boolean(owned && owned.license !== "personal");
  const work = licenseOf(catalog, "starter");
  const free = catalog.workFreeUntil && catalog.workFreeUntil > Date.now() ? catalog.workFreeUntil : null;
  const openLicense = (license: LicenseId = owned && owned.license !== "personal" ? owned.license : "starter", n = owned?.members ?? 1) => setLicenseSheet({ license, members: n });
  const onCloud = ownDesk !== "none";
  const movable = Boolean(clouds?.length && clouds.every((c) => c.provider === "managed"));
  const waiting = billing.subscription?.scheduled ?? null;
  const card = (id: Tier, i: number) => {
    const name = bundleOf(catalog, id)?.name ?? id;
    if (id === "free") return <PlanCard key={id} id={id} i={i} catalog={catalog} interval={interval} current={current(id)} action="your plan" onChoose={null} disabled={false} />;
    if (waiting && waiting.bundle === id) return <PlanCard key={id} id={id} i={i} catalog={catalog} interval={interval} current={false} action={`yours from ${shortDate(waiting.at)}`} onChoose={null} disabled />;
    // a running plan switches to team itself, its cloud resized in place
    if (id === "team" && !current(id) && (movable || owned)) return <PlanCard key={id} id={id} i={i} catalog={catalog} interval={interval} current={false} action={direct.label(id, `switch to ${name}`)} onChoose={() => void direct.choose("team")} disabled={direct.busy !== null} busy={direct.busy === id} note={direct.note(id)} />;
    if (id === "team" && !current(id)) return <PlanCard key={id} id={id} i={i} catalog={catalog} interval={interval} current={false} action="talk to us" href={`${CONTACT}?subject=${encodeURIComponent("move to team")}`} onChoose={null} disabled={false} />;
    const label = current(id) ? "your plan" : !owned && trialAction(catalog) || `${onCloud ? "switch to" : "get"} ${name}`;
    return <PlanCard key={id} id={id} i={i} catalog={catalog} interval={interval} current={current(id)} action={current(id) ? label : direct.label(id, label)} onChoose={id === "team" ? null : () => void direct.choose(id)} disabled={current(id) || direct.busy !== null} busy={direct.busy === id} note={current(id) ? null : direct.note(id)} trial={!current(id) && !owned ? catalog.trialDays : undefined} />;
  };

  return (
    <div>
      <PageHeader title="plans and billing" sub="keep your bots working, laptop open or shut." action={<IntervalToggle value={interval} onChange={setIv} catalog={catalog} />} />
      {fromApp() && back !== "failed" && (paid || returned) && <OpenApp />}
      {back && !paid && <CheckoutBack back={back} onCheck={refresh} onRetry={retry} />}
      <div className="grid gap-3 lg:grid-cols-3">
        {tiersFor(onCloud).map(card)}
      </div>
      <p className="mt-3 text-13 text-ink-4">{interval === "year" ? "billed yearly, two months free." : "billed monthly."} personal use is free.{free ? ` work use is free until ${longDate(free)}.` : ""} need a custom size? <a href={`${CONTACT}?subject=${encodeURIComponent("a custom size")}`} className="text-link">talk to us</a>.</p>

      {work && (
        <div className="surface mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-card bg-card px-6 py-4">
          <div className="min-w-0">
            <p className="text-14 text-ink">{ownsLicense ? "you have a work license" : "using it for work?"}</p>
            <p className="num mt-0.5 text-13 text-ink-3">{ownsLicense ? "covers work use on every plan." : `${priceText(work.monthly, "month", catalog).replace("/mo", "")} a month per person. pro includes one.`}</p>
          </div>
          <button type="button" className="press hover-btn h-10 shrink-0 rounded-full bg-btn px-4.5 text-14 font-medium text-ink" onClick={() => openLicense()}>{ownsLicense ? "manage" : "add a license"}</button>
        </div>
      )}


      <Faq />
      <YourBilling catalog={catalog} onLicense={() => openLicense()} onManage={manage} />

      <AnimatePresence>{planSheet && <PlanSheet key="plan" source="dash_billing" start={planSheet} work={ownsLicense} onClose={() => setPlanSheet(null)} />}</AnimatePresence>
      <AnimatePresence>{licenseSheet && <LicenseSheet key="license" source="dash_license" start={licenseSheet} onClose={() => setLicenseSheet(null)} onNothingLeft={manage} />}</AnimatePresence>
      <CancelFlow key={managing} open={flowOpen} onClose={() => setFlowOpen(false)} catalog={catalog} />
    </div>
  );
}
