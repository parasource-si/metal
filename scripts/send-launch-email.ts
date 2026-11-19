// sends the launch email to the dusk.bot waitlist through brevo, one recipient per message.
//   node scripts/send-launch-email.ts            DRY_RUN=1 counts only; ONLY_TO=<email> sends to that one address
// env: MONGODB_URI, MONGODB_DB, DUSK_UNSUBSCRIBE_SECRET, DUSK_BREVO_API_KEY, DUSK_MAIL_FROM (DUSK_MAIL_POSTAL_ADDRESS optional).
// prints counts only, never addresses. each entry is claimed (launchEmailClaimAt) before its send and marked
// launchEmailSentAt after, so a rerun or a crash never sends twice; a crash can leave a claim, which is skipped and counted.
import { MongoClient } from "mongodb";
import { emailConfig, promoEmail } from "../apps/dashboard/server/email/templates.ts";
import { REPLY_TO, SENDER_NAME, senderAddress } from "../apps/dashboard/server/auth/mail.ts";
import { unsubscribeToken } from "../apps/site/unsubscribe.js";

const env = process.env;
const DRY = env.DRY_RUN === "1";
const ONLY = env.ONLY_TO?.trim().toLowerCase() || null;
const PER_SECOND = 10, MAX_ERROR_RATE = 0.05;
for (const name of ["MONGODB_URI", "DUSK_UNSUBSCRIBE_SECRET", ...(DRY ? [] : ["DUSK_BREVO_API_KEY", "DUSK_MAIL_FROM"])]) if (!env[name]) throw new Error(`${name} is not set`);

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TEST_DOMAINS = new Set(["dusk.bot", "example.com", "example.org", "example.net", "test.com", "mailinator.com", "yopmail.com", "guerrillamail.com",
  "sharklasers.com", "10minutemail.com", "temp-mail.org", "tempmail.com", "maildrop.cc", "trashmail.com", "getnada.com"]);
const isTest = (email: string) => { const domain = email.split("@")[1]!; return TEST_DOMAINS.has(domain) || /\.(test|invalid|example|localhost|local)$/.test(domain); };

const cfg = emailConfig(env, { publicUrl: "https://dusk.bot", pageBase: "/dashboard" });
const mailFor = (unsubscribe: string) => promoEmail(cfg, {
  subject: "Metal is here",
  preheader: "You joined the waitlist. It's open now: download it free.",
  eyebrow: "Launch",
  title: "Metal is here",
  intro: "Thanks for waiting. Metal is an open source Grok bot alternative that works on your existing ChatGPT, Claude or Grok subscription: a team of bots that remember you and get things done on a computer of their own. Free for personal use, on Mac, Windows and Linux.",
  features: [
    { image: `${cfg.assets}/tip-jobs.png`, alt: "two bots at work", title: "Text them like contacts", text: "Give a bot a job in plain words. It browses, clicks and gets it done on a computer of its own, and asks before anything risky." },
    { title: "Routines that run on time", text: "A morning brief, a weekly price check, an inbox sweep. Set it once and the bot does it every time." },
    { image: `${cfg.assets}/tip-rooms.png`, alt: "three bots in a room", title: "Bots that work together", text: "Put a few bots in a room and they pass work along while you watch, or don't." },
    { image: `${cfg.assets}/cloud-day.png`, alt: "dusk cloud", title: "dusk cloud, when you want it", text: "Keep your bots working with your laptop shut. Plans start at $20 a month." },
  ],
  cta: { label: "Download Metal", href: "https://dusk.bot/download" },
  unsubscribe,
});
const unsubscribeUrl = (email: string) => `https://dusk.bot/unsubscribe?t=${unsubscribeToken(env.DUSK_UNSUBSCRIBE_SECRET, email)}`;

type Sent = { ok: true; messageId: string } | { ok: false; status: number; transient: boolean; fatal: boolean };
async function sendOne(to: string): Promise<Sent> {
  const unsubscribe = unsubscribeUrl(to), mail = mailFor(unsubscribe);
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "api-key": env.DUSK_BREVO_API_KEY!, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: senderAddress(env.DUSK_MAIL_FROM!) }, replyTo: { email: REPLY_TO }, to: [{ email: to }],
        subject: mail.subject, htmlContent: mail.html, textContent: mail.text, tags: ["launch"],
        headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
    });
    const data = await res.json().catch(() => null) as { messageId?: string } | null;
    if (res.ok && data?.messageId) return { ok: true, messageId: data.messageId };
    return { ok: false, status: res.status, transient: res.status === 429 || res.status >= 500, fatal: [401, 402, 403].includes(res.status) };
  } catch {
    return { ok: false, status: 0, transient: true, fatal: false };
  }
}

const client = new MongoClient(env.MONGODB_URI!, { appName: "dusk-launch-email", serverSelectionTimeoutMS: 8000 });
await client.connect();
try {
  const list = client.db(env.MONGODB_DB || "dusk").collection<{ email: string; unsubscribedAt?: Date; launchEmailSentAt?: Date; launchEmailClaimAt?: Date }>("waitlist");
  const docs = await list.find({}, { projection: { _id: 0, email: 1, unsubscribedAt: 1, launchEmailSentAt: 1, launchEmailClaimAt: 1 } }).toArray();
  const counts = { entries: docs.length, invalid: 0, duplicate: 0, unsubscribed: 0, test: 0, alreadySent: 0, claimedEarlier: 0, eligible: 0 };
  const seen = new Set<string>(), queue: Array<{ key: string; to: string }> = [];
  for (const doc of docs) {
    const to = String(doc.email ?? "").trim().toLowerCase();
    if (to.length > 254 || !EMAIL.test(to)) { counts.invalid++; continue; }
    if (seen.has(to)) { counts.duplicate++; continue; }
    seen.add(to);
    if (doc.unsubscribedAt) { counts.unsubscribed++; continue; }
    if (isTest(to)) { counts.test++; continue; }
    if (doc.launchEmailSentAt) { counts.alreadySent++; continue; }
    if (doc.launchEmailClaimAt) { counts.claimedEarlier++; continue; }
    queue.push({ key: doc.email, to });
  }
  counts.eligible = queue.length;
  const targets = ONLY ? queue.filter(item => item.to === ONLY) : queue;
  if (ONLY && !targets.length) {
    // the owner's copy may go to an address that is not on the list; nothing is recorded for it then
    if (!EMAIL.test(ONLY)) throw new Error("ONLY_TO is not an email");
    if (seen.has(ONLY)) { console.log(JSON.stringify({ ...counts, only: "on the list but not eligible (sent, unsubscribed or test)" })); process.exit(0); }
    targets.push({ key: "", to: ONLY });
  }
  console.log(JSON.stringify({ ...counts, toSend: targets.length, dryRun: DRY }));
  if (DRY) process.exit(0);

  const result = { sent: 0, failed: 0, skippedRace: 0, retried: 0, stopped: null as string | null, lastMessageId: null as string | null };
  const gap = 1000 / PER_SECOND;
  for (const item of targets) {
    const started = Date.now();
    if (item.key) {
      const claim = await list.updateOne({ email: item.key, launchEmailSentAt: { $exists: false }, launchEmailClaimAt: { $exists: false }, unsubscribedAt: { $exists: false } }, { $set: { launchEmailClaimAt: new Date() } });
      if (!claim.modifiedCount) { result.skippedRace++; continue; }
    }
    let sent = await sendOne(item.to);
    if (!sent.ok && sent.transient) { result.retried++; await new Promise(ok => setTimeout(ok, 2000)); sent = await sendOne(item.to); }
    if (sent.ok) {
      result.sent++; result.lastMessageId = sent.messageId;
      if (item.key) await list.updateOne({ email: item.key }, { $set: { launchEmailSentAt: new Date(), launchEmailMessageId: sent.messageId }, $unset: { launchEmailClaimAt: "" } });
    } else {
      result.failed++;
      if (item.key) await list.updateOne({ email: item.key }, { $set: { launchEmailFailedAt: new Date(), launchEmailFailStatus: sent.status }, $unset: { launchEmailClaimAt: "" } });
      console.log(`failed: status ${sent.status}`);
      if (sent.fatal) { result.stopped = `brevo answered ${sent.status}`; break; }
    }
    const tried = result.sent + result.failed;
    if (tried >= 20 && result.failed / tried > MAX_ERROR_RATE) { result.stopped = `error rate ${(100 * result.failed / tried).toFixed(1)}%`; break; }
    if (tried % 50 === 0) console.log(JSON.stringify({ progress: tried, sent: result.sent, failed: result.failed }));
    const wait = gap - (Date.now() - started);
    if (wait > 0) await new Promise(ok => setTimeout(ok, wait));
  }
  console.log(JSON.stringify(result));
  if (result.stopped) process.exitCode = 1;
} finally {
  await client.close();
}
