import type { Mailer } from "../auth/mail.ts";
import type { AnalyticsSink } from "../analytics/sink.ts";
import { DAY, HOUR, visitsOf } from "../analytics/web.ts";
import type { LedgerEntry } from "../billing/ledger.ts";
import { render } from "../email/layout.ts";
import type { Accent, Block, Email, EmailConfig } from "../email/layout.ts";
import { emailConfig } from "../email/templates.ts";

/** DUSK_ADMIN_ALERTS: which emails the admins get; "all", or any of these, comma-separated; unset sends none.
 *  "paid" is the first payment ever and money trouble: a paying customer's failed payment, a dispute, a refund, a big
 *  customer's churn and MRR milestones. signups, waitlist joins and cloud lifecycle never email: they are in the admin
 *  panel and the daily digest (admin-mail.test.ts holds this list) */
export const ALERT_KINDS = ["paid", "spike", "digest"] as const;
/** MRR milestones in cents: $100, $500, $1k, $2.5k, $5k, $10k, $25k, $50k, $100k a month */
export const MRR_MILESTONES = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
/** DUSK_ALERT_CHURN_CENTS: a churned customer worth at least this much MRR gets its own email; $50 unless set */
export function churnThreshold(value: string | undefined) { const cents = Number(value); return Number.isSafeInteger(cents) && cents >= 0 && value !== "" && value !== undefined ? cents : 5_000; }
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export interface MoneyDigest { newCustomers: Array<{ email: string | null; cents: number }>; mrr: number; netNew: number; failed: number; recovered: number; churned: number; refunds: number }
export type AlertKind = (typeof ALERT_KINDS)[number];
export function parseAlerts(value: string | undefined): Set<AlertKind> {
  const parts = (value ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  return new Set(parts.includes("all") ? ALERT_KINDS : ALERT_KINDS.filter(kind => parts.includes(kind)));
}

/** the visitors of the last hour against the median hour of the week before: a spike is 4x and at least 20 */
export function isSpike(lastHour: number, hours: number[]): boolean {
  const sorted = [...hours].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  return lastHour >= 20 && lastHour >= 4 * Math.max(1, median);
}

const MAX_PER_HOUR = 30;
const REASON = "you got this because your address is in DUSK_ADMIN_EMAILS and DUSK_ADMIN_ALERTS turns this kind on.";
interface AlertMail { say: string; accent: Accent; status?: Email["status"]; heading: string; blocks: Block[] }

export interface AlertsOptions {
  kinds: Set<AlertKind>;
  emails: () => string[];
  mailer: Mailer;
  sink: AnalyticsSink;
  now: () => number;
  /** the admin panel's address, for links in the emails */
  panelUrl: string;
  /** yesterday's numbers for the digest: signups, payments, waitlist joins, clouds that came up and were deleted */
  totals(from: number, to: number): { signups: number; paid: number; waitlist: number | null; accounts: number; money?: MoneyDigest; clouds?: { ready: number; deleted: number } };
  churnCents?: number;
  email?: EmailConfig;
}

/**
 * Emails to the admins: a first payment and money trouble, a traffic spike (at most every six hours) and a daily digest at
 * 08:00 UTC, only when the day had news. Marks in the sink keep a restart from sending one twice.
 */
export function createAlerts(options: AlertsOptions) {
  const { kinds, sink, now } = options;
  const sent: number[] = [];
  const cfg = options.email ?? emailConfig({}, { publicUrl: options.panelUrl });
  async function send(subject: string, mail: AlertMail) {
    const to = options.emails();
    if (!to.length) return;
    const time = now();
    while (sent.length && sent[0]! < time - HOUR) sent.shift();
    if (sent.length >= MAX_PER_HOUR) return;
    sent.push(time);
    const first = mail.blocks.find(block => block.t === "p");
    const { html, text } = render(cfg, { subject, preheader: first?.t === "p" ? first.text.replace(/\*\*/g, "").slice(0, 120) : subject, tag: "admin", say: mail.say, accent: mail.accent,
      status: mail.status, blocks: [{ t: "h1", text: mail.heading }, ...mail.blocks, { t: "button", label: "open admin", href: options.panelUrl }], reason: REASON });
    for (const address of to) await options.mailer.send({ to: address, subject, text, html }).catch(() => console.warn("alerts: an admin email failed"));
  }
  /** the first payment ever; each later new customer is in the daily digest instead */
  function paid(accountId: string, email: string | null, amountCents: number) {
    if (!kinds.has("paid") || amountCents <= 0) return;
    void sink.once("alert|paid|first-ever", null).then(first => {
      if (first) void send(`first payment ever: ${email ?? "an account"}`, { say: "first money in!", accent: "lime", heading: "first payment ever",
        blocks: [{ t: "total", label: "paid", value: usd(amountCents) }, { t: "p", text: `**${email ?? accountId}** just paid. that's Metal's first money in.` }] });
    }, () => {});
  }
  /** one email per incident, each behind a mark so a retry, a replay or a restart never sends it twice */
  async function money(entry: LedgerEntry, facts: { email: string | null; paidBefore: boolean; mrr: number }) {
    if (!kinds.has("paid")) return;
    const who = facts.email ?? entry.accountId ?? "a customer", time = now();
    const failure = entry.type === "payment.failed" || entry.type === "subscription.on_hold" || entry.type === "subscription.failed";
    if (failure && facts.paidBefore && await sink.once(`alert|failed|${entry.subscriptionId ?? entry.accountId ?? entry.providerPaymentId}`, time + 30 * DAY)) {
      await send(`payment failed: ${who}`, { say: "uh oh, a payment bounced", accent: "pink", status: ["failed", "bad"], heading: "a payment didn't go through", blocks: [
        { t: "p", text: `a payment from **${who}** didn't go through${entry.amountCents ? ` (${usd(entry.amountCents)})` : ""}${entry.reason ? `: ${entry.reason.replace(/_/g, " ")}` : ""}.` },
        { t: "p", small: true, text: "dodo retries it on its own. you'll hear again only if it fails again after a month." }] });
    }
    if (entry.type === "dispute.opened" && await sink.once(`alert|dispute|${entry.providerRef ?? entry.id}`, null)) {
      await send(`dispute opened: ${who}`, { say: "heads up, a dispute", accent: "pink", status: ["dispute", "bad"], heading: "a payment is disputed", blocks: [
        { t: "p", text: `**${who}** disputed a payment${entry.amountCents ? ` of ${usd(entry.amountCents)}` : ""}. answer it in the dodo dashboard before its deadline.` }] });
    }
    if (entry.type === "refund.succeeded" && await sink.once(`alert|refund|${entry.providerRef ?? entry.id}`, null)) {
      await send(`refund: ${usd(entry.amountCents ?? 0)} to ${who}`, { say: "money went back", accent: "lemon", heading: "a refund went out", blocks: [
        { t: "total", label: "refunded", value: usd(entry.amountCents ?? 0) }, { t: "p", text: `it went back to **${who}**${entry.reason ? ` (${entry.reason})` : ""}.` }] });
    }
    const churn = entry.type === "subscription.cancelled" || entry.type === "subscription.expired";
    if (churn && (entry.mrrCents ?? 0) >= (options.churnCents ?? 5_000) && await sink.once(`alert|churn|${entry.subscriptionId ?? entry.id}`, null)) {
      await send(`customer lost: ${who} (${usd(entry.mrrCents ?? 0)}/mo)`, { say: "aw, someone left", accent: "pink", heading: "a big customer stopped paying", blocks: [
        { t: "p", text: `**${who}** stopped paying for ${entry.plan ?? "their plan"}, worth ${usd(entry.mrrCents ?? 0)} a month.` }] });
    }
    const reached = MRR_MILESTONES.filter(cents => facts.mrr >= cents);
    const fresh: number[] = [];
    for (const cents of reached) if (await sink.once(`alert|mrr|${cents}`, null)) fresh.push(cents);
    if (fresh.length) await send(`mrr passed ${usd(fresh.at(-1)!).replace(/\.00$/, "")} a month`, { say: "a new milestone!", accent: "lime", heading: `mrr passed ${usd(fresh.at(-1)!).replace(/\.00$/, "")} a month`, blocks: [
      { t: "total", label: "mrr", value: usd(facts.mrr) }, { t: "p", text: `Metal now makes ${usd(facts.mrr)} a month in recurring revenue.` }] });
  }
  async function tick() {
    const time = now();
    if (kinds.has("spike")) {
      const events = await sink.scan(time - 7 * DAY - HOUR, time, ["site_view"]);
      const hours = Array.from({ length: 7 * 24 }, () => new Set<string>());
      const last = new Set<string>();
      for (const visit of visitsOf(events)) {
        if (visit.start >= time - HOUR) last.add(visit.visitor);
        else { const index = Math.floor((time - HOUR - visit.start) / HOUR); hours[index]?.add(visit.visitor); }
      }
      if (isSpike(last.size, hours.map(set => set.size)) && await sink.once(`alert|spike|${Math.floor(time / (6 * HOUR))}`, time + 7 * DAY)) {
        await send(`traffic spike: ${last.size} visitors in the last hour`, { say: "whoa, lots of visitors", accent: "lemon", heading: "a traffic spike", blocks: [
          { t: "total", label: "last hour", value: `${last.size} visitors` }, { t: "p", text: "at least 4 times a usual hour this week." }] });
      }
    }
    const today = Math.floor(time / DAY) * DAY;
    if (kinds.has("digest") && time >= today + 8 * HOUR && await sink.once(`alert|digest|${today}`, time + 7 * DAY)) {
      const from = today - DAY, events = await sink.scan(from, today, ["site_view", "site_goal", "site_leave"]);
      const visits = visitsOf(events), visitors = new Set(visits.map(visit => visit.visitor)).size;
      const channels = new Map<string, number>();
      for (const visit of visits) channels.set(visit.channel, (channels.get(visit.channel) ?? 0) + 1);
      const top = [...channels].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([channel, count]) => `${channel} ${count}`).join(", ");
      const totals = options.totals(from, today);
      const joined = totals.waitlist ?? events.filter(event => event.name === "site_goal" && event.props?.goal === "waitlist_join").length;
      const money = totals.money, more = money ? money.newCustomers.length - 10 : 0, clouds = totals.clouds;
      // a quiet day sends nothing: the mark above still keeps it to one look a day
      const news = visitors + totals.signups + totals.paid + joined + (clouds ? clouds.ready + clouds.deleted : 0)
        + (money ? money.newCustomers.length + money.failed + money.recovered + money.churned + money.refunds : 0);
      if (!news) return;
      const day = new Date(from).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).toLowerCase();
      await send(`Metal yesterday: ${visitors} visitors, ${totals.signups} signups`, { say: "here's yesterday", accent: "lav", heading: `yesterday, ${day}`, blocks: [
        { t: "stats", items: [["visitors", String(visitors), top || undefined], ["signups", String(totals.signups), `${totals.accounts.toLocaleString("en-US")} accounts in all`],
          ...(money ? [["mrr", usd(money.mrr), `${money.netNew >= 0 ? "+" : "-"}${usd(Math.abs(money.netNew))} yesterday`] as [string, string, string]] : []),
          ["paid", String(totals.paid), `${joined} joined the waitlist`],
          ...(clouds ? [["clouds", `${clouds.ready} up`, `${clouds.deleted} deleted`] as [string, string, string]] : [])] },
        ...(money?.newCustomers.length ? [{ t: "label", text: `new paying customers: ${money.newCustomers.length}` } as Block,
          { t: "facts", rows: [...money.newCustomers.slice(0, 10).map(row => [row.email ?? "an account", usd(row.cents)] as [string, string]), ...(more > 0 ? [["and more", `${more}`] as [string, string]] : [])] } as Block] : []),
        ...(money && (money.failed || money.recovered || money.churned || money.refunds) ? [{ t: "label", text: "payments" } as Block,
          { t: "facts", rows: [["failed", String(money.failed)], ["recovered", String(money.recovered)], ["cancelled", String(money.churned)], ["refunds", String(money.refunds)]] } as Block] : []),
      ] });
    }
  }
  const timer = kinds.size ? setInterval(() => { void tick().catch(() => console.warn("alerts: a check failed")); }, 10 * 60_000) : null;
  timer?.unref();
  return { paid, money: (entry: LedgerEntry, facts: { email: string | null; paidBefore: boolean; mrr: number }) => { void money(entry, facts).catch(() => console.warn("alerts: a money alert failed")); }, tick, close() { if (timer) clearInterval(timer); } };
}
