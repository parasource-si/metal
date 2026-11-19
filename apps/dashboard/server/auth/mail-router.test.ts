import { afterEach, describe, expect, it, vi } from "vitest";
import { codeMessage, MailDeliveryError, mailerFromEnv, type Mailer, type MailMessage } from "./mail.ts";
import { createMailRouter, DEFAULT_MAIL_CAPS, mailCapsFromEnv, memoryMailUsage, type MailCaps, type MailProviderId } from "./mail-router.ts";

afterEach(() => vi.restoreAllMocks());

const AT = Date.UTC(2026, 10, 14, 12);
const code = (to = "person@example.test") => codeMessage(to, "01234567");
const notice = (to = "person@example.test"): MailMessage => ({ to, subject: "a note about your cloud", text: "t", html: "<p>t</p>" });
function outbox(fail?: () => Error) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = { async send(message) { const error = fail?.(); if (error) throw error; sent.push(message); } };
  return { sent, mailer };
}
function setup(options: { caps?: Partial<Record<MailProviderId, MailCaps>>; resendFails?: () => Error; brevoFails?: () => Error; only?: MailProviderId; now?: () => number } = {}) {
  const resend = outbox(options.resendFails), brevo = outbox(options.brevoFails), usage = memoryMailUsage(), log = vi.fn();
  const router = createMailRouter({ providers: { resend: options.only === "brevo" ? null : resend.mailer, brevo: options.only === "resend" ? null : brevo.mailer },
    caps: { ...DEFAULT_MAIL_CAPS, ...options.caps }, usage, now: options.now ?? (() => AT), log });
  const counts = async () => Object.fromEntries((await router.usage()).providers.map(p => [p.provider, p]));
  return { router, resend: resend.sent, brevo: brevo.sent, log, counts };
}

describe("mail router", () => {
  it("sends codes, receipts and cloud ready through resend, and everything else through brevo", async () => {
    const t = setup();
    await t.router.send(code());
    await t.router.send(notice());
    expect(t.resend.map(m => m.subject)).toEqual(["01234567 is your Metal code"]);
    expect(t.brevo.map(m => m.subject)).toEqual(["a note about your cloud"]);
    // styled: the html goes out with the text part
    expect(t.resend[0]!.html).toContain('class="kit"');
    expect(t.resend[0]!.text).toContain("01234567");
    const c = await t.counts();
    expect(c.resend!.today).toEqual({ sent: 1, fallbacks: 0 });
    expect(c.brevo!.month).toEqual({ sent: 1, fallbacks: 0 });
  });

  it("falls back to brevo at resend's daily cap, counts it and logs it without the code", async () => {
    const t = setup({ caps: { resend: { daily: 2, monthly: 3_000 } } });
    for (let i = 0; i < 3; i++) await t.router.send(code());
    expect(t.resend).toHaveLength(2);
    expect(t.brevo).toHaveLength(1);
    expect(t.brevo[0]!.html).toContain('class="kit"');
    const c = await t.counts();
    expect(c.resend!.today).toEqual({ sent: 2, fallbacks: 1 });
    expect(c.brevo!.today.sent).toBe(1);
    expect(t.log).toHaveBeenCalledWith('mail: resend is at its cap, so "<code> is your Metal code" went through brevo');
  });

  it("falls back at resend's monthly cap, and the day's count starts again tomorrow", async () => {
    let at = AT;
    const t = setup({ caps: { resend: { daily: 2, monthly: 3 } }, now: () => at });
    await t.router.send(code()); await t.router.send(code()); await t.router.send(code());
    at += 86_400_000;
    await t.router.send(code()); await t.router.send(code());
    expect(t.resend).toHaveLength(3);
    expect(t.brevo).toHaveLength(2);
    expect((await t.counts()).resend!.month).toEqual({ sent: 3, fallbacks: 2 });
  });

  it.each([429, 500, 503, 401, 403, null])("falls back to brevo when resend fails with %s and records the error", async status => {
    const t = setup({ resendFails: () => new MailDeliveryError(status, status ? `http ${status}` : "no answer (TimeoutError)") });
    await t.router.send(code());
    expect(t.brevo).toHaveLength(1);
    const c = await t.counts();
    // the refused send is not counted against resend's cap
    expect(c.resend!.today).toEqual({ sent: 0, fallbacks: 1 });
    expect(c.resend!.lastError).toEqual({ at: AT, reason: status ? `http ${status}` : "no answer (TimeoutError)" });
    expect(t.log.mock.calls[0]![0]).toMatch(/^mail: resend failed \((http \d+|no answer \(TimeoutError\))\), so "<code> is your Metal code" went through brevo$/);
  });

  it("does not retry a message resend calls invalid (422) elsewhere", async () => {
    const t = setup({ resendFails: () => new MailDeliveryError(422, "http 422 validation_error") });
    await expect(t.router.send(code())).rejects.toThrow("Email delivery failed.");
    expect(t.brevo).toHaveLength(0);
  });

  it("fails when both providers are at their caps", async () => {
    const t = setup({ caps: { resend: { daily: 1, monthly: 3_000 }, brevo: { daily: 1, monthly: 10_000 } } });
    await t.router.send(code()); await t.router.send(code());
    await expect(t.router.send(code())).rejects.toThrow("Email delivery failed.");
    expect(t.resend.length + t.brevo.length).toBe(2);
  });

  it("passes other mail from brevo to resend only at brevo's cap, never on a brevo error", async () => {
    const capped = setup({ caps: { brevo: { daily: 1, monthly: 10_000 } } });
    await capped.router.send(notice()); await capped.router.send(notice());
    expect(capped.brevo).toHaveLength(1);
    expect(capped.resend).toHaveLength(1);
    expect((await capped.counts()).brevo!.today.fallbacks).toBe(1);
    const failing = setup({ brevoFails: () => new MailDeliveryError(500, "http 500") });
    await expect(failing.router.send(notice())).rejects.toThrow("Email delivery failed.");
    expect(failing.resend).toHaveLength(0);
  });

  it("sends everything through the one provider configured, within its caps", async () => {
    const t = setup({ only: "brevo", caps: { brevo: { daily: 1, monthly: 10_000 } } });
    await t.router.send(code());
    await expect(t.router.send(code())).rejects.toThrow("Email delivery failed.");
    expect(t.brevo).toHaveLength(1);
    expect((await t.counts()).resend!.configured).toBe(false);
  });

  it("never sends test accounts through either provider", async () => {
    const t = setup();
    for (const to of ["harness@qa.dusk.test", "qa@dusk.bot", "qa-run1@dusk.bot", "QA+x@dusk.bot"]) { await t.router.send(code(to)); await t.router.send(notice(to)); }
    await t.router.only("resend")!.send(notice("harness@qa.dusk.test"));
    expect(t.resend).toHaveLength(0);
    expect(t.brevo).toHaveLength(0);
    expect((await t.counts()).resend!.today.sent).toBe(0);
  });

  it("lets mail through when the counts can't be read or written", async () => {
    const sent: MailMessage[] = [];
    const broken = { reserve: () => Promise.reject(new Error("down")), release: () => Promise.reject(new Error("down")), fallback: () => Promise.reject(new Error("down")),
      error: () => Promise.reject(new Error("down")), read: () => Promise.reject(new Error("down")) };
    const router = createMailRouter({ providers: { resend: { async send(m) { sent.push(m); } } }, caps: DEFAULT_MAIL_CAPS, usage: broken, log: () => {} });
    await router.send(code());
    expect(sent).toHaveLength(1);
  });

  it("reads the caps from the env, defaulting to resend's free tier and brevo's 10,000 a month", () => {
    expect(mailCapsFromEnv({})).toEqual({ resend: { daily: 100, monthly: 3_000 }, brevo: { daily: 300, monthly: 10_000 } });
    expect(mailCapsFromEnv({ DUSK_RESEND_DAILY_LIMIT: "20", DUSK_RESEND_MONTHLY_LIMIT: "300", DUSK_BREVO_DAILY_LIMIT: "10000", DUSK_BREVO_MONTHLY_LIMIT: "x" }))
      .toEqual({ resend: { daily: 20, monthly: 300 }, brevo: { daily: 10_000, monthly: 10_000 } });
  });

  it("builds the router from the env with both providers, and posts a code to resend with its html", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const mailer = mailerFromEnv({ DUSK_MAIL_PROVIDER: "brevo", DUSK_BREVO_API_KEY: "fixture-brevo", DUSK_RESEND_API_KEY: "fixture-resend", DUSK_MAIL_FROM: "Metal <account@dusk.bot>" }, { dev: false });
    await mailer.send(code());
    expect(request.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(request.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ from: "Metal <account@dusk.bot>", reply_to: "hello@dusk.bot" });
    expect(body.html).toContain('class="kit"');
    expect(body.text).toContain("01234567");
    await mailer.send(notice());
    expect(request.mock.calls[1]![0]).toBe("https://api.brevo.com/v3/smtp/email");
  });
});
