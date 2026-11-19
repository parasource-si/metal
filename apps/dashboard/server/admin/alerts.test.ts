import { describe, expect, it } from "vitest";
import { memorySink } from "../analytics/sink.ts";
import { memoryMailer } from "../auth/mail.ts";
import { churnThreshold, createAlerts, isSpike, parseAlerts } from "./alerts.ts";
import { draft, ledgerId } from "../billing/ledger.ts";

const HOUR = 3_600_000, DAY = 86_400_000;
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

describe("admin alerts", () => {
  function setup(kinds: string, time: { now: number }) {
    const mailer = memoryMailer(), sink = memorySink(() => time.now);
    const alerts = createAlerts({ kinds: parseAlerts(kinds), emails: () => ["owner@example.test"], mailer, sink, now: () => time.now, panelUrl: "https://preview.dusk.bot/app/admin",
      totals: () => ({ signups: 3, paid: 1, waitlist: null, accounts: 40 }) });
    return { mailer, sink, alerts };
  }
  it("reads which alerts are on", () => {
    expect([...parseAlerts("all")]).toEqual(["paid", "spike", "digest"]);
    expect([...parseAlerts("signup, digest, nonsense")]).toEqual(["digest"]);
    expect(parseAlerts(undefined).size).toBe(0);
  });
  it("calls a spike only at four times a usual hour and at least 20 visitors", () => {
    expect(isSpike(19, [1, 1, 1])).toBe(false);
    expect(isSpike(20, [1, 2, 5])).toBe(true);
    expect(isSpike(40, [10, 12, 11])).toBe(false);
    expect(isSpike(44, [10, 11, 12])).toBe(true);
  });
  it("mails a first payment once, and sends nothing that is off", async () => {
    const time = { now: Date.parse("2026-11-12T06:00:00Z") };
    const { mailer, alerts } = setup("all", time);
    alerts.paid("acct_1", "new@example.test", 2000); alerts.paid("acct_1", "new@example.test", 2000);
    await settle();
    await alerts.tick();
    expect(mailer.outbox.map(mail => mail.subject)).toEqual(["first payment ever: new@example.test"]);
    expect(mailer.outbox[0]!.text).toContain("$20.00");
    alerts.close();
    const off = setup("", time);
    off.alerts.paid("acct_2", "x@example.test", 2000);
    await settle();
    await off.alerts.tick();
    expect(off.mailer.outbox).toEqual([]);
  });
  it("sends one digest a day after 08:00 UTC and one spike mail per six hours", async () => {
    const time = { now: Date.parse("2026-11-12T08:05:00Z") };
    const { mailer, sink, alerts } = setup("digest,spike", time);
    for (let v = 0; v < 25; v++) await sink.insert({ id: `e${v}`, name: "site_view", at: time.now - 10 * 60_000, accountId: null, props: { path: "/" }, ctx: { visitor: `visitor-${v}`, session: `session-${v}`, pv: `pv-${v}` } });
    await alerts.tick(); await alerts.tick();
    expect(mailer.outbox.map(mail => mail.subject)).toEqual(["traffic spike: 25 visitors in the last hour", "Metal yesterday: 0 visitors, 3 signups"]);
    time.now += DAY + HOUR;
    await alerts.tick();
    expect(mailer.outbox.filter(mail => mail.subject.startsWith("Metal yesterday"))).toHaveLength(2);
    alerts.close();
  });
  it("sends one email per money incident: failures, disputes, refunds, big churn and each MRR milestone once", async () => {
    const time = { now: Date.parse("2026-11-12T06:00:00Z") };
    const { mailer, alerts } = setup("paid", time);
    const row = (type: string, extra: Record<string, unknown> = {}) => ({ ...draft({ key: `${type}:${JSON.stringify(extra)}`, type, at: time.now, via: "fixture", accountId: "acct_1", subscriptionId: "sub_1", ...extra }), id: ledgerId(type), recordedAt: time.now });
    const facts = { email: "pay@example.test", paidBefore: true, mrr: 0 };
    alerts.money(row("payment.failed", { amountCents: 2000, reason: "insufficient_funds" }), facts);
    alerts.money(row("subscription.on_hold"), facts);
    alerts.money(row("payment.failed"), { ...facts, paidBefore: false, email: "new@example.test" });
    alerts.money(row("dispute.opened", { providerRef: "dsp_1", amountCents: 2000 }), facts); alerts.money(row("dispute.opened", { providerRef: "dsp_1" }), facts);
    alerts.money(row("refund.succeeded", { providerRef: "ref_1", amountCents: 500 }), facts); alerts.money(row("refund.succeeded", { providerRef: "ref_1", amountCents: 500 }), facts);
    alerts.money(row("subscription.cancelled", { mrrCents: 1000, subscriptionId: "small" }), facts);
    alerts.money(row("subscription.cancelled", { mrrCents: 9000, subscriptionId: "big" }), facts); alerts.money(row("subscription.expired", { mrrCents: 9000, subscriptionId: "big" }), facts);
    alerts.money(row("payment.succeeded"), { ...facts, mrr: 60_000 }); alerts.money(row("payment.succeeded"), { ...facts, mrr: 60_000 });
    await settle(); await settle();
    expect(mailer.outbox.map(mail => mail.subject).sort()).toEqual(["customer lost: pay@example.test ($90.00/mo)", "dispute opened: pay@example.test", "mrr passed $500 a month",
      "payment failed: pay@example.test", "refund: $5.00 to pay@example.test"]);
    expect(mailer.outbox.find(mail => mail.subject.startsWith("payment failed"))!.text).toContain("insufficient funds");
    expect(churnThreshold(undefined)).toBe(5000); expect(churnThreshold("20000")).toBe(20000); expect(churnThreshold("x")).toBe(5000);
    alerts.close();
  });
  it("puts new paying customers, MRR and money trouble in the digest", async () => {
    const time = { now: Date.parse("2026-11-12T08:05:00Z") };
    const mailer = memoryMailer(), sink = memorySink(() => time.now);
    const alerts = createAlerts({ kinds: parseAlerts("digest"), emails: () => ["owner@example.test"], mailer, sink, now: () => time.now, panelUrl: "https://preview.dusk.bot/app/admin",
      totals: () => ({ signups: 3, paid: 2, waitlist: null, accounts: 40, money: { newCustomers: [{ email: "a@example.test", cents: 2000 }, { email: null, cents: 900 }], mrr: 12_000, netNew: 2900, failed: 1, recovered: 0, churned: 0, refunds: 0 } }) });
    await alerts.tick();
    expect(mailer.outbox[0]!.text).toContain("new paying customers: 2:\n\na@example.test: $20.00\nan account: $9.00");
    expect(mailer.outbox[0]!.text).toContain("mrr: $120.00 (+$29.00 yesterday)");
    expect(mailer.outbox[0]!.text).toContain("failed: 1");
    expect(mailer.outbox[0]!.html).toContain("here&#39;s yesterday");
    alerts.close();
  });
});
