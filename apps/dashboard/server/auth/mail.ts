import { codeEmail, emailConfig, magicLinkEmail, recoveryEmail } from "../email/templates.ts";
import type { EmailConfig } from "../email/templates.ts";
import { createMailRouter, mailCapsFromEnv, memoryMailUsage, type MailUsageStore, type RoutedMailer } from "./mail-router.ts";
/** transactional: a code, a receipt or "cloud ready" (templates.ts); it goes through resend first (auth/mail-router.ts) */
export interface MailMessage { to: string; subject: string; text: string; html: string; transactional?: boolean }
export interface Mailer { send(message: MailMessage): Promise<void> }
/** a provider refused or never answered. `status` is its http status (null: no answer); `reason` is a short, secret-free
 *  label for admin ops ("http 429 rate_limit_exceeded"); the message stays the same for every caller */
export class MailDeliveryError extends Error {
  readonly status: number | null;
  readonly reason: string;
  constructor(status: number | null, reason: string) { super("Email delivery failed."); this.status = status; this.reason = reason; }
}
// the provider's error name or code, never its message (which can echo the address or the key's name)
async function failure(response: Response): Promise<MailDeliveryError> {
  let code = "";
  try { const body = await response.json() as { name?: unknown; code?: unknown }; code = String(body?.name ?? body?.code ?? "").replace(/[^a-z0-9_.-]/gi, "").slice(0, 40); } catch { /* not json */ }
  return new MailDeliveryError(response.status, `http ${response.status}${code ? ` ${code}` : ""}`);
}
const noAnswer = (error: unknown) => error instanceof MailDeliveryError ? error : new MailDeliveryError(null, `no answer (${error instanceof Error ? error.name : "error"})`);

export function memoryMailer() {
  const outbox: MailMessage[] = [];
  return { outbox, async send(message: MailMessage) { outbox.push(message); } };
}
export function consoleMailer(): Mailer {
  return { async send(message) { console.log(`code for ${message.to}: ${message.text.match(/\b\d{8}\b/)?.[0] ?? ""}`); } };
}
/** test harnesses sign up at <anything>@qa.dusk.test (.test is reserved, RFC 2606): their mail never reaches a provider */
export const TEST_MAIL_DOMAIN = "qa.dusk.test";
// qa@dusk.bot, qa-<x>@dusk.bot and qa+<x>@dusk.bot: older harnesses signed up there, and dusk.bot's catch-all lands in the owner's inbox
const OWN_QA = /^qa(?:[-+._][^@]*)?@dusk\.bot$/;
export const isTestAddress = (email: unknown) => {
  if (typeof email !== "string") return false;
  const address = email.trim().toLowerCase();
  return address.endsWith(`@${TEST_MAIL_DOMAIN}`) || OWN_QA.test(address);
};
// the preview end-to-end runs sign up at a real throwaway inbox (apps/cloud-service/scripts/preview-e2e.ts) to prove a code arrives
const E2E_LOCAL = /^dusk-(?:e2e|appconn)-[a-z0-9]+@/;
/** a harness's account: it gets sign-in codes and links it acts on, never the courtesy mail (welcome, cloud ready, receipts) */
export const isTestAccount = (email: unknown) => isTestAddress(email) || (typeof email === "string" && E2E_LOCAL.test(email.trim().toLowerCase()));
export interface TestMail { to: string; subject: string; code: string | null; link: string | null; at: number }
export interface TestMailbox { readonly readable: boolean; keep(message: MailMessage): void; latest(to: string, since?: number): TestMail | null }
/** where mail to test addresses goes instead. `readable` (preview and dev only) keeps the code and link for a while so
 *  a harness can read them (GET /v1/ops/test-mail); otherwise it is dropped */
export function createTestMailbox({ readable, now = Date.now, ttlMs = 30 * 60_000, max = 500 }: { readable: boolean; now?: () => number; ttlMs?: number; max?: number }): TestMailbox {
  let kept: TestMail[] = [];
  return {
    readable,
    keep(message) {
      if (!readable) return;
      const link = /https:\/\/[^\s"'<>)]+/.exec(message.text)?.[0] ?? null;
      kept = [...kept.filter(item => item.at > now() - ttlMs).slice(-(max - 1)),
        { to: message.to.trim().toLowerCase(), subject: message.subject, code: /\b\d{8}\b/.exec(message.text)?.[0] ?? null, link, at: now() }];
    },
    latest(to, since = 0) {
      const want = to.trim().toLowerCase();
      return [...kept].reverse().find(item => item.to === want && item.at >= since && item.at > now() - ttlMs) ?? null;
    },
  };
}
/** mail to a test address goes to the mailbox, everything else to `inner` */
export function sinkTestMail(inner: Mailer, box: TestMailbox): Mailer {
  return { async send(message) { if (isTestAddress(message.to)) { box.keep(message); return; } return inner.send(message); } };
}
export const REPLY_TO = "hello@dusk.bot";
export const SENDER_NAME = "Metal";
/** the address out of "Name <address>" or a bare address; every email goes out under the name "Metal" */
export const senderAddress = (from: string) => (from.match(/<([^>]+)>\s*$/)?.[1] ?? from).trim();
export function resendMailer(options: { apiKey: string; from: string; fetch?: typeof fetch }): Mailer {
  const request = options.fetch ?? fetch;
  return { async send(message) {
    try {
      const response = await request("https://api.resend.com/emails", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        // the dusk.bot domain has open and click tracking off in resend, and no list-unsubscribe header is added
        body: JSON.stringify({ from: `${SENDER_NAME} <${senderAddress(options.from)}>`, reply_to: REPLY_TO, to: message.to, subject: message.subject, html: message.html, text: message.text }) });
      if (!response.ok) throw await failure(response);
      await response.body?.cancel();
    } catch (error) { throw noAnswer(error); }
  } };
}
export function brevoMailer(options: { apiKey: string; from: string; fetch?: typeof fetch }): Mailer {
  const request = options.fetch ?? fetch;
  const sender = { name: SENDER_NAME, email: senderAddress(options.from) };
  return { async send(message) {
    try {
      // brevo adds an open pixel and wrapped links to every html part (no way off below enterprise): transactional mail
      // comes here only when resend is capped or failing (auth/mail-router.ts)
      const response = await request("https://api.brevo.com/v3/smtp/email", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "api-key": options.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sender, replyTo: { email: REPLY_TO }, to: [{ email: message.to }], subject: message.subject, htmlContent: message.html, textContent: message.text }) });
      if (!response.ok) throw await failure(response);
      await response.body?.cancel();
    } catch (error) { throw noAnswer(error); }
  } };
}
/** the providers the env configures, behind the router (auth/mail-router.ts): transactional mail goes through resend and
 *  everything else through brevo, each within its caps, falling back to the other. DUSK_MAIL_PROVIDER names the one that
 *  must be there (brevo or resend); console prints codes, development only */
export function mailerFromEnv(env: NodeJS.ProcessEnv, { dev, usage, now }: { dev: boolean; usage?: MailUsageStore; now?: () => number }): RoutedMailer | Mailer {
  const provider = env.DUSK_MAIL_PROVIDER ?? (dev ? "console" : "");
  if (provider === "console" && dev) return consoleMailer();
  if (provider !== "resend" && provider !== "brevo") throw new Error("Configure DUSK_MAIL_PROVIDER=brevo or resend for email delivery; console mail is allowed only in development.");
  const key = provider === "resend" ? env.DUSK_RESEND_API_KEY : env.DUSK_BREVO_API_KEY;
  if (!key || !env.DUSK_MAIL_FROM) throw new Error(`DUSK_MAIL_PROVIDER=${provider} requires DUSK_${provider.toUpperCase()}_API_KEY and DUSK_MAIL_FROM.`);
  const from = env.DUSK_MAIL_FROM;
  return createMailRouter({
    providers: {
      resend: env.DUSK_RESEND_API_KEY ? resendMailer({ apiKey: env.DUSK_RESEND_API_KEY, from }) : null,
      brevo: env.DUSK_BREVO_API_KEY ? brevoMailer({ apiKey: env.DUSK_BREVO_API_KEY, from }) : null,
    },
    caps: mailCapsFromEnv(env), usage: usage ?? memoryMailUsage(), now,
  });
}
export function codeMessage(to: string, code: string, cfg: EmailConfig = emailConfig(process.env, { publicUrl: "https://dusk.bot" })): MailMessage {
  return { to, ...codeEmail(cfg, { code }) };
}
/** "Can't sign in?": the code (and, for the website, a one-time link), plus the ways this address signs in. `ways` null: no
 * account uses the address, so no code goes out, only that answer. */
export function magicLinkMessage(to: string, link: string, cfg: EmailConfig = emailConfig(process.env, { publicUrl: "https://dusk.bot" })): MailMessage {
  return { to, ...magicLinkEmail(cfg, { link }) };
}
export function recoveryMessage(to: string, input: { code: string; link?: string | null; ways: string[] | null },
  cfg: EmailConfig = emailConfig(process.env, { publicUrl: "https://dusk.bot" })): MailMessage {
  return { to, ...recoveryEmail(cfg, input) };
}
