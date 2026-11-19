import { useState, type ReactNode } from "react";
import { LoaderCircle, Minus, Plus } from "@/icons";
import { useCloud } from "../data/cloud";
import type { BillingInterval, BundleId, ChangeOffer, CheckoutSource, LicenseId, PlanCatalog, Selection } from "../data/contracts";
import { bundleOf, desktopOf, dollars, planSpecLine, licenseMonthly, licenseOf, perMonthOn, yearlyPerk } from "../data/pricing";
import { useCart } from "../data/quote";
import { useSession } from "../data/session";
import { longDate, shortDate } from "../lib/format";
import { navigate } from "../lib/router";
import { Choice, Field, Select, Sheet, Toggle } from "../ui/controls";
import { track } from "../lib/analytics";
import { Button, cx, Skeleton } from "../ui/kit";
import { CHECKOUT_SOON, checkoutDone, trialAction } from "./cloud-offer";
import { EASE_OUT, m } from "../ui/motion";

/** a submit in flight: the button keeps its color and shows a quiet spinner */
export const Working = ({ children }: { children: ReactNode }) => <><LoaderCircle size={17} strokeWidth={2} className="spin" aria-hidden />{children}</>;
export const BUSY = "disabled:!opacity-100 disabled:cursor-progress";

export const money = (n: number) => dollars(n, !Number.isInteger(Math.round(n * 100) / 100));

/** a monthly list price on the chosen period: per month, or the whole year (two months free reads as $200, not $16.67) */
export const per = (monthly: number, interval: BillingInterval, c: Pick<PlanCatalog, "yearlyDiscount">) => (interval === "year" ? { amount: money(perMonthOn(monthly, interval, c) * 12), unit: "/yr" } : { amount: money(monthly), unit: "/mo" });
export const priceText = (monthly: number, interval: BillingInterval, c: Pick<PlanCatalog, "yearlyDiscount">) => { const p = per(monthly, interval, c); return `${p.amount}${p.unit}`; };

/** what a cart charges per period, as one line */
export const cartText = (cart: { perMonth: number; dueNow: number }, interval: BillingInterval) => (interval === "year" ? `${money(cart.dueNow)}/yr` : `${money(cart.perMonth)}/mo`);

const INTERVAL_KEY = "dusk-dash-interval";
/** the plan someone left for the payment page with, so coming back unpaid can offer it again */
export const CHECKOUT_PLAN_KEY = "dusk-dash-checkout-plan";
/** Plus and Pro are shared desktops: only the pool regions can take them. */
export function sharedRegions(catalog: PlanCatalog) {
  return catalog.poolRegions ? catalog.regions.filter((r) => catalog.poolRegions!.includes(r.id)) : catalog.regions;
}

export function useInterval(): [BillingInterval, (v: BillingInterval) => void] {
  const [v, set] = useState<BillingInterval>(() => (sessionStorage.getItem(INTERVAL_KEY) === "year" ? "year" : "month"));
  return [v, (next) => { sessionStorage.setItem(INTERVAL_KEY, next); set(next); }];
}

export function IntervalToggle({ value, onChange, catalog }: { value: BillingInterval; onChange(v: BillingInterval): void; catalog: PlanCatalog }) {
  return (
    <Toggle<BillingInterval>
      label="billing period"
      value={value}
      onChange={onChange}
      options={[
        { value: "month", label: "monthly" },
        // the perk nudges once as yearly is picked
        { value: "year", label: <>yearly <m.span className="inline-block origin-right text-ink-4" initial={false} animate={value === "year" ? { scale: [1, 1.08, 1] } : { scale: 1 }}
          transition={{ duration: 0.32, ease: EASE_OUT }}>{yearlyPerk(catalog)}</m.span></> },
      ]}
      stretch
    />
  );
}

/** Every plan change stops once to show what it does (today's charge, the next one and when) and applies only at that
 * charge; a change of selection asks again. `apply` is true once applied, false when it stopped to show the offer. */
export function useChangeCharge(selection: Selection | null) {
  const { changeCharge, changePlan } = useCloud();
  const key = selection ? JSON.stringify(selection) : "";
  const [held, setHeld] = useState<{ key: string; offer: ChangeOffer } | null>(null);
  const shown = held?.key === key ? held.offer : null;
  const apply = async (next: Selection): Promise<boolean> => {
    if (shown === null) { setHeld({ key, offer: await changeCharge(next) }); return false; }
    try { await changePlan(next, shown.todayUsd); return true; } catch (e) { setHeld(null); throw e; }
  };
  return { offer: shown, apply };
}

const each = (interval: BillingInterval) => (interval === "year" ? "/yr" : "/mo");
/** what a switch does, in one or two sentences: the confirmation the person agrees to */
export function offerText(offer: ChangeOffer, plans: { from: string; to: string; fromInterval: BillingInterval; toInterval: BillingInterval }): string {
  const next = `${money(offer.nextUsd)}${each(plans.toInterval)}`;
  if (offer.timing === "undo") return `you stay on ${plans.from}. the switch to the smaller plan is called off and nothing is charged.`;
  if (offer.timing === "trial") return `$0 today. your free trial still ends ${offer.nextAt ? longDate(offer.nextAt) : "on the same day"}, then ${next}.`;
  if (offer.timing === "scheduled") return `$0 today. you keep ${plans.from} until ${longDate(offer.effectiveAt)}, then ${plans.to} at ${next}.`;
  const today = `${money(offer.todayUsd)} today${offer.taxUsd > 0 ? ", tax included" : ""}`;
  const why = plans.fromInterval === plans.toInterval ? `for the rest of this billing ${plans.fromInterval}` : `for the ${plans.toInterval} ahead, less the unused part of this ${plans.fromInterval}`;
  return `${today}, ${why}. then ${next} from ${offer.nextAt ? longDate(offer.nextAt) : "your next billing date"}.`;
}
export function OfferLine({ offer, ...plans }: { offer: ChangeOffer; from: string; to: string; fromInterval: BillingInterval; toInterval: BillingInterval }) {
  return <p role="status" className="num mt-2 text-13 text-ink-2">{offerText(offer, plans)}</p>;
}
/** the confirm button once the offer is shown */
export function offerAction(offer: ChangeOffer, to: string, from: string): string {
  if (offer.timing === "undo") return `keep ${from}`;
  if (offer.timing === "scheduled") return `switch on ${shortDate(offer.effectiveAt)}`;
  if (offer.timing === "trial" || offer.todayUsd === 0) return `switch to ${to}`;
  return `pay ${money(offer.todayUsd)} and switch`;
}

/** the plan's name as people know it */
export const planName = (catalog: PlanCatalog, bundle: BundleId | null | undefined) => (bundle ? bundleOf(catalog, bundle)?.name : null) ?? "your plan";
/** what the toast says once a confirmed switch went through */
export function switchedToast(offer: ChangeOffer | null, to: string): string {
  if (offer?.timing === "scheduled") return `you switch to ${to} on ${shortDate(offer.effectiveAt)}`;
  if (offer?.timing === "undo") return "your plan stays as it is";
  return `you are on ${to}. your dusk cloud restarts once into the new size.`;
}

/** the paid plans a sheet can sell: plus is the starter bundle */
export type PaidPlan = Extract<BundleId, "starter" | "pro">;

/** a plan's full selection; plus can carry a work license, pro always has one */
export function planSelection(catalog: PlanCatalog, plan: PaidPlan, opts: { interval: BillingInterval; region?: string; work: boolean; keep?: Selection | null }): Selection {
  const b = bundleOf(catalog, plan)!;
  const keepLicense = opts.keep && opts.keep.license !== "personal" ? opts.keep : null;
  const license: LicenseId = keepLicense ? keepLicense.license : b.license !== "personal" ? b.license : opts.work ? "starter" : "personal";
  return { license, members: keepLicense?.members ?? 1, desktop: b.desktop, size: null, region: opts.region ?? catalog.regions[0]?.id ?? "", interval: opts.interval };
}

/** one place to buy plus or pro: the plan, the billing period, the region and an optional work license */
export function PlanSheet({ start, source, work = false, onClose }: { source: CheckoutSource; start: PaidPlan; work?: boolean; onClose(): void }) {
  const { catalog, billing, checkout } = useCloud();
  const { toast } = useSession();
  const owned = billing?.subscription?.selection ?? null;
  const [interval, setInterval] = useState<BillingInterval>(owned?.interval ?? (sessionStorage.getItem(INTERVAL_KEY) === "year" ? "year" : "month"));
  const [plan, setPlan] = useState<PaidPlan>(start);
  const [withLicense, setWithLicense] = useState(work);
  const regions = catalog ? sharedRegions(catalog) : [];
  const [region, setRegion] = useState(owned && owned.desktop !== "none" && regions.some((r) => r.id === owned.region) ? owned.region : regions[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sel = catalog ? planSelection(catalog, plan, { interval, region, work: withLicense, keep: owned }) : null;
  const { cart, error: quoteError } = useCart(sel, catalog);
  const { offer, apply } = useChangeCharge(sel);
  if (!catalog || !sel) return <Sheet open onClose={onClose} title="get dusk cloud"><Skeleton className="mt-4 h-40" /></Sheet>;
  const b = bundleOf(catalog, plan);
  const ownsLicense = Boolean(owned && owned.license !== "personal");
  const work1 = licenseOf(catalog, "starter");
  const unchanged = owned !== null && JSON.stringify(owned) === JSON.stringify(sel);
  const scheduled = Boolean(billing?.subscription?.scheduled);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      if (owned) { if (await apply(sel)) { toast(switchedToast(offer, b?.name ?? "your new plan")); onClose(); } }
      else {
        track({ name: "plan_chosen", props: { plan, period: interval } });
        if (catalog.checkoutOpen === false) { setError(CHECKOUT_SOON); return; }
        try { sessionStorage.setItem(CHECKOUT_PLAN_KEY, plan); } catch {}
        if (await checkout({ source, kind: "plan", selection: sel, bundle: null })) { toast(checkoutDone(catalog)); onClose(); navigate("/cloud"); }
        else setError("checkout didn't open. try again.");
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const line = (id: PaidPlan): ReactNode => {
    const x = bundleOf(catalog, id);
    const d = x ? desktopOf(catalog, x.desktop) : null;
    return d ? planSpecLine(d, x?.license !== "personal") : "";
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={owned ? `switch to ${b?.name}` : `get ${b?.name}`}
      footer={
        <div>
          {cart && cart.discount > 0 && <p className="num flex justify-between text-13 text-ink-3"><span>two months free</span><span>-{money(cart.discount * 12)}</span></p>}
          <div className="mt-1 flex items-baseline justify-between gap-4">
            <span className="text-14 text-ink-3">total</span>
            <span className="num"><span className="text-24 font-medium tracking-[-0.035em] text-ink">{cart ? money(interval === "year" ? cart.dueNow : cart.perMonth) : "..."}</span><span className="text-14 text-ink-3">{interval === "year" ? "/yr" : "/mo"}</span></span>
          </div>
          <p className="num mt-0.5 text-end text-13 text-ink-4">{!owned && catalog.trialDays ? `free for ${catalog.trialDays} days, then ` : ""}{interval === "year" ? "billed yearly, + tax where applicable" : "billed monthly, + tax where applicable"}</p>
          {offer !== null && owned && <OfferLine offer={offer} from={planName(catalog, billing?.subscription?.bundle)} to={b?.name ?? "the new plan"} fromInterval={owned.interval} toInterval={interval} />}
          {(error ?? quoteError) && <p role="alert" className="mt-3 text-13 text-bad">{error ?? quoteError}</p>}
          <Button variant="primary" className={cx("mt-4 w-full !h-11", busy && BUSY)} onClick={() => void go()} disabled={busy || (unchanged && !scheduled)} aria-busy={busy}>{busy ? <Working>{owned ? "switching" : "opening checkout"}</Working> : offer !== null ? offerAction(offer, b?.name ?? "it", planName(catalog, billing?.subscription?.bundle)) : unchanged ? (scheduled ? `keep ${b?.name}` : "your plan") : owned ? "review switch" : trialAction(catalog) ?? "checkout"}</Button>
          <p className="mt-3 text-center text-12 text-ink-4">set up in about a minute.</p>
        </div>
      }
    >
      <div className="mt-2"><IntervalToggle value={interval} onChange={setInterval} catalog={catalog} /></div>
      <fieldset className="mt-6 min-w-0">
        <legend className="mb-2 text-13 text-ink-3">plan</legend>
        <div className="flex flex-col gap-1">
          {(["starter", "pro"] as const).map((id) => {
            const x = bundleOf(catalog, id);
            if (!x) return null;
            return <Choice key={id} name="plan" value={id} checked={plan === id} onChange={() => setPlan(id)} title={x.name} detail={line(id)} aside={<>{per(x.monthly, interval, catalog).amount}<span className="text-ink-3">{per(x.monthly, interval, catalog).unit}</span></>} />;
          })}
        </div>
      </fieldset>
      {plan === "starter" && !ownsLicense && work1 && (
        <label className="hover-row mt-3 flex min-h-14 cursor-pointer items-center gap-3 rounded-[16px] px-3.5 py-2.5">
          <input type="checkbox" checked={withLicense} onChange={(e) => setWithLicense(e.target.checked)} className="size-4 shrink-0 accent-[var(--ink)]" />
          <span className="min-w-0 flex-1">
            <span className="block text-14 text-ink">add a work license</span>
            <span className="block truncate text-13 text-ink-3">to use it at work, one person</span>
          </span>
          <span className="num shrink-0 text-14 text-ink-2">+{priceText(work1.monthly, interval, catalog)}</span>
        </label>
      )}
      <div className="mt-6">
        {regions.length === 1 ? (
          <p className="text-13 text-ink-3">region: {regions[0]!.city}, {regions[0]!.name}</p>
        ) : (
          <Field label="region" htmlFor="plan-region" hint="pick the one closest to you.">
            <Select id="plan-region" value={region} onChange={(e) => setRegion(e.target.value)}>
              {regions.map((r) => <option key={r.id} value={r.id}>{r.city}, {r.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Sheet>
  );
}

/** a cloud plan moved to team: a dedicated machine and a team license, on the same billing period */
export function TeamSheet({ onClose }: { onClose(): void }) {
  const { catalog, billing } = useCloud();
  const { toast } = useSession();
  const owned = billing?.subscription?.selection ?? null;
  const team = catalog ? bundleOf(catalog, "team") : null;
  const sel: Selection | null = owned && team ? { license: "team", members: Math.max(team.members, owned.members), desktop: team.desktop, size: null, region: owned.region, interval: owned.interval } : null;
  const { cart, error: quoteError } = useCart(sel, catalog);
  const { offer, apply } = useChangeCharge(sel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!catalog || !sel || !team) return <Sheet open onClose={onClose} title="switch to team"><Skeleton className="mt-4 h-40" /></Sheet>;
  const desk = desktopOf(catalog, team.desktop);
  const go = async () => {
    setBusy(true); setError(null);
    try { if (await apply(sel)) { toast(switchedToast(offer, team.name)); onClose(); } }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={`switch to ${team.name}`}
      footer={
        <div>
          <div className="mt-1 flex items-baseline justify-between gap-4">
            <span className="text-14 text-ink-3">total</span>
            <span className="num"><span className="text-24 font-medium tracking-[-0.035em] text-ink">{cart ? money(sel.interval === "year" ? cart.dueNow : cart.perMonth) : "..."}</span><span className="text-14 text-ink-3">{sel.interval === "year" ? "/yr" : "/mo"}</span></span>
          </div>
          <p className="num mt-0.5 text-end text-13 text-ink-4">{sel.interval === "year" ? "billed yearly, + tax where applicable" : "billed monthly, + tax where applicable"}</p>
          {offer !== null && owned && <OfferLine offer={offer} from={planName(catalog, billing?.subscription?.bundle)} to={team.name} fromInterval={owned.interval} toInterval={sel.interval} />}
          {(error ?? quoteError) && <p role="alert" className="mt-3 text-13 text-bad">{error ?? quoteError}</p>}
          <Button variant="primary" className={cx("mt-4 w-full !h-11", busy && BUSY)} onClick={() => void go()} disabled={busy} aria-busy={busy}>{busy ? <Working>switching</Working> : offer !== null ? offerAction(offer, team.name, planName(catalog, billing?.subscription?.bundle)) : "review switch"}</Button>
        </div>
      }
    >
      <p className="text-14 leading-[1.55] text-ink-3">your dusk cloud grows into the team size with its files and bots. it restarts once, for about a minute.</p>
      <ul className="mt-5 flex flex-col gap-2 text-14 text-ink-2">
        {desk && <li>{planSpecLine(desk)}, dedicated</li>}
        <li>team license, {sel.members} members</li>
      </ul>
    </Sheet>
  );
}

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange(v: number): void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2">
      <span className="text-14 text-ink-2" id="members-label">members</span>
      <div className="flex items-center gap-1" role="group" aria-labelledby="members-label">
        <button type="button" aria-label="one member fewer" disabled={value <= min} onClick={() => onChange(value - 1)} className="press hover-btn grid size-9 place-items-center rounded-full bg-card-2 text-ink-2 disabled:opacity-40 max-sm:size-11"><Minus size={15} strokeWidth={1.5} /></button>
        <output className="num w-9 text-center text-15 font-medium text-ink" aria-live="polite">{value}</output>
        <button type="button" aria-label="one member more" disabled={value >= max} onClick={() => onChange(value + 1)} className="press hover-btn grid size-9 place-items-center rounded-full bg-card-2 text-ink-2 disabled:opacity-40 max-sm:size-11"><Plus size={15} strokeWidth={1.5} /></button>
      </div>
    </div>
  );
}

/** the work license on its own: personal, one person, or a team with seats */
export function LicenseSheet({ start, source, onClose, onNothingLeft }: { source: CheckoutSource; start: { license: LicenseId; members: number }; onClose(): void; onNothingLeft(): void }) {
  const { catalog, billing, checkout } = useCloud();
  const { toast } = useSession();
  const owned = billing?.subscription?.selection ?? null;
  const [sel, setSel] = useState<Selection>(() => ({ ...(owned ?? { desktop: "none", size: null, region: catalog?.regions[0]?.id ?? "" }), license: start.license, members: start.members, interval: owned?.interval ?? "month" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { cart, error: quoteError } = useCart(sel, catalog);
  const { offer, apply } = useChangeCharge(sel);
  if (!catalog) return null;
  const set = (patch: Partial<Selection>) => { setSel((s) => ({ ...s, ...patch })); setError(null); };
  const lic = licenseOf(catalog, sel.license);
  const unchanged = owned ? JSON.stringify(owned) === JSON.stringify(sel) : sel.license === "personal";
  const go = async () => {
    if (sel.license === "personal" && sel.desktop === "none") { onClose(); onNothingLeft(); return; }
    setBusy(true); setError(null);
    try {
      if (owned) { if (await apply(sel)) { toast(offer?.timing === "scheduled" ? `changes on ${shortDate(offer.effectiveAt)}` : sel.license === "personal" ? "license removed" : "license updated"); onClose(); } }
      else if (await checkout({ source, kind: "plan", selection: sel, bundle: null })) { toast("license active. thanks for backing Metal."); onClose(); }
      else setError("checkout didn't open. try again.");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const free = catalog.workFreeUntil && catalog.workFreeUntil > Date.now() ? catalog.workFreeUntil : null;
  return (
    <Sheet
      open
      onClose={onClose}
      title="work license"
      footer={
        <div>
          {cart && cart.discount > 0 && <p className="num flex justify-between text-13 text-ink-3"><span>two months free</span><span>-{money(cart.discount * 12)}</span></p>}
          <div className="mt-1 flex items-baseline justify-between gap-4">
            <span className="text-14 text-ink-3">{owned ? "your plan in total" : "total"}</span>
            <span className="num"><span className="text-24 font-medium tracking-[-0.035em] text-ink">{cart ? money(sel.interval === "year" ? cart.dueNow : cart.perMonth) : "..."}</span><span className="text-14 text-ink-3">{sel.interval === "year" ? "/yr" : "/mo"}</span></span>
          </div>
          <p className="num mt-0.5 text-end text-13 text-ink-4">{cart?.free ? "nothing to pay" : sel.interval === "year" ? "billed yearly, + tax where applicable" : "billed monthly, + tax where applicable"}</p>
          {offer !== null && owned && <OfferLine offer={offer} from="your plan now" to="the new one" fromInterval={owned.interval} toInterval={sel.interval} />}
          {(error ?? quoteError) && <p role="alert" className="mt-3 text-13 text-bad">{error ?? quoteError}</p>}
          <Button variant="primary" className={cx("mt-4 w-full !h-11", busy && BUSY)} onClick={() => void go()} disabled={busy || unchanged} aria-busy={busy}>{busy ? <Working>{owned ? "updating" : "opening checkout"}</Working> : offer !== null ? (offer.todayUsd > 0 ? `pay ${money(offer.todayUsd)} and update` : offer.timing === "scheduled" ? `update on ${shortDate(offer.effectiveAt)}` : "confirm") : owned ? (sel.license === "personal" ? "remove license" : "update license") : sel.license === "personal" ? "personal use is free" : `buy ${lic?.name} license`}</Button>
        </div>
      }
    >
      <p className="text-14 leading-[1.55] text-ink-3">personal use is free forever. using it at work needs a license.{free ? ` work use is free until ${longDate(free)}.` : ""}</p>
      <div className="mt-5"><IntervalToggle value={sel.interval} onChange={(interval) => set({ interval })} catalog={catalog} /></div>
      <fieldset className="mt-6 min-w-0">
        <legend className="sr-only">license</legend>
        <div className="flex flex-col gap-1">
          {catalog.licenses.map((l) => (
            <Choice
              key={l.id}
              name="sheet-license"
              value={l.id}
              checked={sel.license === l.id}
              onChange={() => set({ license: l.id, members: l.perExtraMember ? Math.max(l.includedMembers, sel.members) : l.includedMembers })}
              title={l.work ? l.name : "personal"}
              detail={!l.work ? "personal and noncommercial use" : l.perExtraMember ? `${l.includedMembers} members, +${priceText(l.perExtraMember, sel.interval, catalog)} each more` : "one person, for work"}
              aside={l.monthly === 0 ? "$0" : priceText(l.id === sel.license ? licenseMonthly(l, sel.members) : l.monthly, sel.interval, catalog)}
            />
          ))}
        </div>
        {lic && lic.perExtraMember > 0 && <Stepper value={sel.members} min={lic.includedMembers} max={lic.maxMembers} onChange={(n) => set({ members: n })} />}
      </fieldset>
    </Sheet>
  );
}
