import { render } from "./layout.ts";
import type { Block, EmailConfig, Rendered } from "./layout.ts";

export type { EmailConfig, Rendered } from "./layout.ts";

const DAY = 86_400_000;
const ACCOUNT_REASON = "you got this because you have a Metal account. it's about your account, so it can't be turned off.";

export function emailConfig(env: NodeJS.ProcessEnv, { publicUrl, pageBase = "" }: { publicUrl: string; pageBase?: string }): EmailConfig {
  const origin = new URL(publicUrl).origin, trim = (value: string) => value.replace(/\/+$/, "");
  return {
    assets: trim(env.DUSK_EMAIL_ASSET_BASE || "https://dusk.bot/email"),
    site: trim(env.DUSK_EMAIL_SITE_URL || (pageBase ? origin : "https://dusk.bot")),
    app: `${origin}${pageBase}`,
    address: env.DUSK_MAIL_POSTAL_ADDRESS?.trim() || null,
  };
}

export function formatDate(at: number) {
  return new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).toLowerCase();
}
export function formatMoney(cents: number, currency = "USD") {
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  return currency.toUpperCase() === "USD" ? amount : `${amount} ${currency.toUpperCase()}`;
}
const joinOr = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items.at(-1)}` : items[0] ?? "";

/** every image the emails use, relative to the asset base; the site build must ship each one */
export const EMAIL_ASSETS = ["cloud-day.png", "tip-jobs.png", "tip-routines.png", "tip-rooms.png"];

const SAY = {
  code: { say: "psst, your code", accent: "lemon" },
  recover: { say: "let's get you back in", accent: "lemon" },
  nobody: { say: "hmm, no account here", accent: "lav" },
  welcome: { say: "hi! welcome!", accent: "sky" },
  ready: { say: "special delivery!", accent: "lime" },
  back: { say: "it's back!", accent: "sky" },
  receipt: { say: "paid. thank you!", accent: "lime" },
  revived: { say: "welcome back!", accent: "lime" },
  payment: { say: "uh oh, card trouble", accent: "pink" },
  napping: { say: "no hard feelings", accent: "lav" },
  headsUp: { say: "heads up!", accent: "lemon" },
  lastDay: { say: "last call!", accent: "pink" },
  confirm: { say: "is this you?", accent: "pink" },
  cloudGone: { say: "bye, little cloud!", accent: "lav" },
  bye: { say: "bye for now!", accent: "lav" },
  promo: { say: "Something new!", accent: "lime" },
  invite: { say: "you're invited!", accent: "sky" },
} as const;
/** the plain way to the billing page: no plan buttons in email, and nothing that opens the payment provider */
const billingLink = (cfg: EmailConfig, before: string): Block => ({ t: "link", before, label: "billing page", href: `${cfg.app}/billing` });

/** the sign-in or sign-up code */
/** the subject both sign-in code emails end with */
export const CODE_SUBJECT = / is your Metal code$/;
export function codeEmail(cfg: EmailConfig, { code }: { code: string }): Rendered {
  return render(cfg, {
    subject: `${code} is your Metal code`, preheader: `your Metal code is ${code}. it works for 10 minutes.`, tag: "sign in", ...SAY.code, transactional: true,
    blocks: [
      { t: "h1", text: "here's your code" },
      { t: "p", text: "pop it in where you signed in. it works for 10 minutes." },
      { t: "code", code },
      { t: "p", small: true, text: "didn't ask for this? you can ignore it. nobody gets in without the code." },
    ],
    reason: "you got this because someone typed this address into Metal.",
  });
}

/** the desktop app's sign-in or sign-up by email: one button that opens the website signed in, and the app follows */
export function magicLinkEmail(cfg: EmailConfig, { link }: { link: string }): Rendered {
  return render(cfg, {
    subject: "your Metal sign-in link", preheader: "open it to finish signing in. it works for 10 minutes.", tag: "sign in", ...SAY.code, transactional: true,
    blocks: [
      { t: "h1", text: "here's your sign-in link" },
      { t: "button", label: "continue to Metal", href: link },
      { t: "p", text: "it signs you in (or makes your account), and the app signs itself in too. it works for 10 minutes." },
      { t: "p", small: true, text: "didn't ask for this? you can ignore it. nobody gets in without the link." },
    ],
    reason: "you got this because someone typed this address into Metal.",
  });
}

const WAYS: Record<string, string> = { email: "an emailed code", google: "google", apple: "apple" };
/** "can't sign in?": the code, a one-time link for the website, and the ways this address signs in. `ways` null: no
 *  account uses the address, so no code goes out */
export function recoveryEmail(cfg: EmailConfig, { code, link = null, ways }: { code: string; link?: string | null; ways: string[] | null }): Rendered {
  const reason = "you got this because someone asked to sign in to Metal with this address.";
  if (!ways) return render(cfg, {
    subject: "signing in to Metal", preheader: "no Metal account uses this address.", tag: "sign in", ...SAY.nobody, transactional: true,
    blocks: [
      { t: "h1", text: "no account uses this address" },
      { t: "p", text: "someone asked to sign in to Metal with this address, but no account uses it. try another address you use." },
      { t: "p", small: true, text: "didn't ask? you can ignore this email." },
    ], reason,
  });
  const list = joinOr(ways.map(way => WAYS[way] ?? way)) || WAYS.email;
  return render(cfg, {
    subject: `${code} is your Metal code`, preheader: `your Metal code is ${code}. here's how you get back in.`, tag: "sign in", ...SAY.recover, transactional: true,
    blocks: [
      { t: "h1", text: "here's how you get back in" },
      { t: "p", text: "use this code where you asked. it works for 10 minutes." },
      { t: "code", code },
      ...(link ? [{ t: "button", label: "sign in", href: link } as Block] : []),
      { t: "note", text: `this account signs in with **${list}**.` },
      { t: "p", small: true, text: "didn't ask? you can ignore this email. nothing changes." },
    ], reason,
  });
}

/** after the first sign-up */
export function welcomeEmail(cfg: EmailConfig, { cloudFromCents }: { cloudFromCents: number }): Rendered {
  return render(cfg, {
    subject: "welcome to Metal", preheader: "a team of ai bots you text like teammates. here's how to get going.", tag: "welcome", ...SAY.welcome,
    blocks: [
      { t: "h1", text: "welcome to Metal" },
      { t: "p", text: "Metal is a chat app for a team of ai bots. you text them like teammates, and they get real work done on your computer." },
      { t: "button", label: "get the app", href: `${cfg.site}/download` },
      { t: "cloud", eyebrow: "dusk cloud", title: "keep your bots awake 24/7",
        text: "your laptop sleeps. your bots don't have to. dusk cloud gives them their own always-on computer, so routines run on time and replies land while your lid is shut.",
        points: ["runs when your computer is off", "your desktop and phone reach it from anywhere", "set up and looked after for you, with backups"],
        price: `from ${formatMoney(cloudFromCents).replace(/\.00$/, "")}/mo`, fine: "cancel any time", cta: { label: "get dusk cloud", href: `${cfg.app}/cloud` },
        image: "cloud-day.png", alt: "three pixel bots wide awake on a cloud in a blue sky." },
      { t: "h2", text: "3 pro tips to start" },
      { t: "tips", items: [
        { image: "tip-jobs.png", alt: "two pixel bots, each with its own badge.", title: "give each bot a job", text: "one for your inbox, one for research, one for code. a clear job makes a sharper bot." },
        { image: "tip-routines.png", alt: "a pixel bot beside a small clock.", title: "set up routines", text: "ask a bot to do something on a schedule, like a news brief every morning at 8. it just shows up." },
        { image: "tip-rooms.png", alt: "three pixel bots chatting together.", title: "put bots in a room", text: "add a few bots to one group chat and let them pass work along. jump in whenever you want." },
      ] },
      { t: "p", small: true, text: "stuck on something? reply to this email. a person reads it." },
    ],
    reason: ACCOUNT_REASON,
  });
}

export interface CloudFacts { name: string; plan: string; machine: string | null; region: string | null }
const cloudRows = (cloud: CloudFacts, status: [string, "ok" | "warn" | "off"]): Array<[string, string, ("ok" | "warn" | "off")?]> => [
  ["cloud", cloud.name], ["status", status[0], status[1]], ["plan", cloud.plan],
  ...(cloud.machine ? [["machine", cloud.machine] as [string, string]] : []), ...(cloud.region ? [["region", cloud.region] as [string, string]] : []),
];

/** a cloud's first time up */
export function cloudReadyEmail(cfg: EmailConfig, cloud: CloudFacts): Rendered {
  return render(cfg, {
    subject: `your dusk cloud is ready`, preheader: `${cloud.name} is up and running. pair the app and give it something to do.`, tag: "dusk cloud", ...SAY.ready, transactional: true,
    blocks: [
      { t: "h1", text: "your dusk cloud is ready" },
      { t: "p", text: `**${cloud.name}** is up and running. from now on your bots can work around the clock, even with your computer off.` },
      { t: "facts", rows: cloudRows(cloud, ["running", "ok"]) },
      { t: "h2", text: "what now" },
      { t: "steps", items: [
        { title: "open the app and sign in", text: "use this email in Metal on your computer or phone. it finds your cloud by itself." },
        { title: "move a bot over", text: "pick a bot that should never sleep and move it to your cloud." },
        { title: "give it a first routine", text: "try: **\"every morning at 8, send me the top ai news.\"**" },
      ] },
      { t: "button", label: "open your cloud", href: `${cfg.app}/cloud` },
    ],
    reason: ACCOUNT_REASON,
  });
}

export interface ReceiptInput {
  amountCents: number; currency: string; description: string; paidAt: number; receiptId: string;
  periodStart: number | null; periodEnd: number | null; renews: boolean; first: boolean;
  /** a dusk cloud plan: the button opens the cloud, otherwise the app */
  cloud: boolean;
  /** the first payment of a plan that brought back a paused cloud with its data */
  revived?: boolean;
}
/** a payment that went through: a new plan, a renewal or credits */
export function receiptEmail(cfg: EmailConfig, input: ReceiptInput): Rendered {
  const amount = formatMoney(input.amountCents, input.currency);
  const rows: Array<[string, string]> = [["paid", amount], ["for", input.description], ["paid on", formatDate(input.paidAt)]];
  if (input.periodStart !== null && input.periodEnd !== null) rows.push(["period", `${formatDate(input.periodStart)} to ${formatDate(input.periodEnd)}`]);
  if (input.periodEnd !== null) rows.push(["next charge", input.renews ? formatDate(input.periodEnd) : "none, the plan ends then"]);
  rows.push(["receipt", input.receiptId]);
  return render(cfg, {
    subject: `receipt for ${amount}: ${input.description}`, preheader: `thanks! ${amount} for ${input.description}.`, tag: "receipt", ...(input.revived ? SAY.revived : SAY.receipt), transactional: true,
    blocks: [
      { t: "h1", text: input.revived ? "welcome back" : input.first ? "thanks, you're all set" : "thanks, payment received" },
      { t: "p", text: input.revived ? `your plan is active again, and your cloud and bots are restored where they stopped. here's your receipt for **${input.description}**.`
        : input.first ? `your plan is active. here's your receipt for **${input.description}**.` : `here's your receipt for **${input.description}**. nothing else to do.` },
      { t: "facts", rows },
      input.cloud ? { t: "button", label: "open dusk cloud", href: `${cfg.app}/cloud` } : { t: "button", label: "open the app", href: `${cfg.site}/download` },
    ],
    reason: ACCOUNT_REASON,
  });
}

export interface PaymentFailedInput { amountCents: number | null; currency: string; description: string; cloudName: string | null; fixBy: number | null }
export function paymentFailedEmail(cfg: EmailConfig, input: PaymentFailedInput): Rendered {
  const amount = input.amountCents === null ? null : formatMoney(input.amountCents, input.currency);
  return render(cfg, {
    subject: "your payment didn't go through", preheader: `a new card keeps ${input.cloudName ?? "your plan"} running.`, tag: "billing", ...SAY.payment,
    blocks: [
      { t: "h1", text: "your card needs a look" },
      { t: "p", text: `we couldn't charge ${amount ? `**${amount}** ` : ""}for **${input.description}**. usually it's an expired card, a new card number or the bank saying no.` },
      ...(input.fixBy !== null ? [{ t: "note", tone: "alert", text: input.cloudName
        ? `**${input.cloudName}** keeps running for now. fix the card by **${formatDate(input.fixBy)}** so it doesn't stop.`
        : `fix the card by **${formatDate(input.fixBy)}** to keep your plan.` } as Block] : []),
      billingLink(cfg, "the card on file lives on your"),
      input.cloudName ? { t: "button", label: "open dusk cloud", href: `${cfg.app}/cloud` } : { t: "button", label: "open the app", href: `${cfg.site}/download` },
      { t: "p", small: true, text: "already fixed it? then you're good, there's nothing else to do." },
    ],
    reason: ACCOUNT_REASON,
  });
}

/** `keptPaused`: the cloud pauses at the end and is kept `keepDays` with warnings first (a managed cloud); otherwise it is
 *  removed `keepDays` after the end */
export interface CancelledInput { description: string; cloudName: string | null; endsAt: number | null; keepDays: number; keptPaused: boolean }
export function cancelledEmail(cfg: EmailConfig, input: CancelledInput): Rendered {
  const ends = input.endsAt === null ? null : formatDate(input.endsAt);
  const keepUntil = input.endsAt === null ? null : formatDate(input.endsAt + input.keepDays * DAY);
  const what = input.cloudName ? `**${input.cloudName}**` : "your plan";
  return render(cfg, {
    subject: `your ${input.description} plan is cancelled`, preheader: ends ? `everything keeps working until ${ends}.` : "no more charges.", tag: "billing", ...SAY.napping,
    blocks: [
      { t: "h1", text: ends ? `you keep everything until ${ends}` : "your plan is cancelled" },
      { t: "p", text: ends ? `your plan is cancelled, but nothing changes today. ${what} keeps working until **${ends}**, the end of what you paid for, and there are no more charges after that.` : "no more charges. thanks for giving it a go." },
      ...(input.cloudName && input.keptPaused ? [{ t: "p", text: `after that, ${input.cloudName} takes a nap, it isn't deleted. its bots, chats, files and sign-ins stay put for ${input.keepDays} days, and we email you a week before anything goes.` } as Block] : []),
      { t: "facts", rows: [
        ...(ends ? [["works until", ends, "ok"] as [string, string, "ok"]] : []),
        ...(input.cloudName ? [["data kept", keepUntil ? `${input.keptPaused ? "at least " : ""}until ${keepUntil}` : `${input.keptPaused ? "at least " : ""}${input.keepDays} days`, "warn"] as [string, string, "warn"]] : []),
        ["plan", input.description],
      ] },
      ...(input.cloudName && !input.keptPaused ? [{ t: "note", tone: "warn", text: `after ${keepUntil ?? "that"}, ${input.cloudName} and what's on it are deleted. move anything you want to keep before then.` } as Block] : []),
      { t: "p", text: "whenever you want your bots running around the clock again, it's one step away." },
      { t: "button", label: "come back to dusk cloud", href: `${cfg.app}/cloud` },
    ],
    reason: ACCOUNT_REASON,
  });
}

/** a cloud that was taken down and its data removed */
export function cloudDeletedEmail(cfg: EmailConfig, { name, at }: { name: string; at: number }): Rendered {
  return render(cfg, {
    subject: `${name} was deleted`, preheader: `${name} and its data are gone. your account and the app on your computer are untouched.`, tag: "dusk cloud", ...SAY.cloudGone,
    blocks: [
      { t: "h1", text: `${name} is deleted` },
      { t: "p", text: `we deleted **${name}** on ${formatDate(at)}. this can't be undone.` },
      { t: "h2", text: "what was removed" },
      { t: "list", items: ["the cloud computer itself", "the bots, chats, files and sign-ins that lived on it", "its backups, cleared out soon after if any are left"] },
      { t: "note", tone: "info", text: "**what stays:** your Metal account, and the app and bots on your own computer." },
      { t: "button", label: "start a new cloud", href: `${cfg.app}/cloud` },
    ],
    reason: ACCOUNT_REASON,
  });
}

export function accountDeletedEmail(cfg: EmailConfig, { email }: { email: string }): Rendered {
  return render(cfg, {
    subject: "your Metal account is deleted", preheader: `everything tied to ${email} is gone.`, tag: "account", ...SAY.bye,
    blocks: [
      { t: "h1", text: "your account is deleted" },
      { t: "p", text: `thanks for trying Metal. the account for **${email}** is gone, and here's what went with it:` },
      { t: "list", items: ["your account, sign-ins and sessions", "your plans, so no more charges", "your clouds: each one stops (at once, or when its paid time ends), is kept 30 days, then deleted with everything on it"] },
      { t: "note", tone: "info", text: "**what stays:** the Metal app and your bots on your own computer are yours. uninstall the app to remove them. payment records we have to keep by law stay, without your details." },
      { t: "p", text: "if you ever want back in, signing up again takes a minute." },
      { t: "p", small: true, text: "didn't delete your account? reply to this email right away." },
    ],
    reason: "you got this because your Metal account was just deleted. this is the last email we send to this address.",
  });
}

export interface PromoInput {
  subject: string; preheader: string; eyebrow: string; title: string; intro: string;
  features: Array<{ image?: string; alt?: string; title: string; text: string }>;
  cta: { label: string; href: string }; unsubscribe: string;
}
/** a launch or feature announcement; marketing, so it always carries an unsubscribe link */
export function promoEmail(cfg: EmailConfig, input: PromoInput): Rendered {
  if (!input.unsubscribe.startsWith("https://")) throw new Error("A promo email needs an https unsubscribe link.");
  return render(cfg, {
    subject: input.subject, preheader: input.preheader, tag: input.eyebrow, ...SAY.promo,
    blocks: [
      { t: "h1", text: input.title },
      { t: "p", text: input.intro },
      { t: "button", label: input.cta.label, href: input.cta.href },
      ...input.features.map(feature => ({ t: "feature", image: feature.image ?? null, alt: feature.alt ?? "", title: feature.title, text: feature.text }) as Block),
    ],
    reason: "You got this because you signed up for Metal news.", unsubscribe: input.unsubscribe,
  });
}

export type CloudNoticeKind = "ended" | "left_30" | "left_7" | "left_1" | "deleted" | "recovered" | "delete_requested" | "delete_scheduled" | "delete_cancelled" | "resumed";
/** the managed cloud backend's notices, folded into the emails that matter; null: not worth an email (the owner just did
 *  it, or another email already said it) */
export function cloudNoticeEmail(cfg: EmailConfig, { kind, name, at, link }: { kind: CloudNoticeKind; name: string; at: number | null; link?: string }): Rendered | null {
  switch (kind) {
    case "left_30": case "left_7": case "left_1": return cloudDeletionEmail(cfg, { kind: "warning", name, at, daysLeft: Number(kind.slice(5)) });
    case "delete_requested": return cloudDeletionEmail(cfg, { kind: "confirm", name, at, link });
    case "delete_scheduled": return cloudDeletionEmail(cfg, { kind: "scheduled", name, at });
    case "deleted": return cloudDeletedEmail(cfg, { name, at: at ?? Date.now() });
    case "recovered": return cloudBackEmail(cfg, { name, at });
    case "ended": case "delete_cancelled": case "resumed": return null;
  }
}

/** a cloud's machine stopped and was set up again, from its latest backup (`at`) or empty (null) */
export function cloudBackEmail(cfg: EmailConfig, { name, at }: { name: string; at: number | null }): Rendered {
  return render(cfg, { tag: "dusk cloud", reason: ACCOUNT_REASON, subject: `${name} is back`, preheader: "its computer stopped, so we set it up again. your app reconnects by itself.", ...SAY.back,
    blocks: [{ t: "h1", text: `${name} is back` },
      { t: "p", text: at === null ? `${name}'s computer stopped before its first backup, so we set it up again, empty. bots you moved there can be moved again from your computer.`
        : `${name}'s computer stopped, so we set it up again from its latest backup, taken **${formatDate(at)}**. anything after that backup may be missing.` },
      { t: "p", text: "your app reconnects by itself." }, { t: "button", label: "open your cloud", href: `${cfg.app}/cloud` }] });
}

/** a heads-up before a cloud's data goes: the retention warning, and the owner's own deletion (confirm, then scheduled) */
export function cloudDeletionEmail(cfg: EmailConfig, { kind, name, at, link, daysLeft = 7 }: { kind: "warning" | "confirm" | "scheduled"; name: string; at: number | null; link?: string; daysLeft?: number }): Rendered {
  const date = at === null ? null : formatDate(at), cloud = `${cfg.app}/cloud`, days = `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  const base = { tag: "dusk cloud", reason: ACCOUNT_REASON, ...SAY.headsUp };
  if (kind === "confirm") return render(cfg, { ...base, ...SAY.confirm, tag: "security", subject: `confirm deleting ${name}`, preheader: "nothing happens unless you confirm within an hour.",
    blocks: [{ t: "h1", text: `delete ${name}?` }, { t: "p", text: `someone signed in to your account asked to delete **${name}** and all of its data. nothing happens unless you confirm within an hour. you may be asked to sign in again.` },
      { t: "button", label: "confirm deletion", href: link ?? cloud },
      { t: "note", tone: "info", text: "after you confirm, it's deleted 7 days later, and its page can stop it any time before then." },
      { t: "p", small: true, text: "wasn't you? ignore this email and sign out your other sessions." }] });
  if (kind === "scheduled") return render(cfg, { ...base, subject: `${name} will be deleted on ${date ?? "schedule"}`, preheader: "changed your mind? its page can stop it until then.",
    blocks: [{ t: "h1", text: `${name} is set to be deleted` }, { t: "p", text: `you confirmed deleting **${name}**. it and its data, backups included, will be deleted${date ? ` on **${date}**` : ""}.` },
      { t: "note", tone: "warn", text: "changed your mind? until then, your cloud's page can stop the deletion and keep everything." }, { t: "button", label: "open your cloud", href: cloud }] });
  return render(cfg, { ...base, ...(daysLeft === 1 ? SAY.lastDay : {}), subject: `${name} will be deleted in ${days}`, preheader: date ? `on ${date}, unless its plan starts again.` : "unless its plan starts again.",
    blocks: [{ t: "h1", text: `${days} left for ${name}` }, { t: "p", text: `**${name}** has been napping since its plan ended.` },
      { t: "note", tone: daysLeft === 1 ? "alert" : "warn", text: `${date ? `on **${date}**` : "soon"}, ${name} and everything on it will be deleted for good.` },
      { t: "p", text: "start a plan for it again and it wakes up right where it stopped." },
      { t: "button", label: "keep my cloud", href: cloud }] });
}

/** an owner's invite to their team; the link carries the token in its fragment, so it never reaches a server log */
export function teamInviteEmail(cfg: EmailConfig, { team, from, link, expiresAt }: { team: string; from: string; link: string; expiresAt: number }): Rendered {
  return render(cfg, {
    subject: `${from} invited you to ${team} on Metal`, preheader: `join ${team} and use its bots and its dusk cloud. the link works until ${formatDate(expiresAt)}.`, tag: "team", ...SAY.invite, transactional: true,
    blocks: [
      { t: "h1", text: `join ${team}` },
      { t: "p", text: `**${from}** invited you to their team on Metal. once you're in, you open the team's dusk cloud from the Metal app and use the bots they share with you.` },
      { t: "button", label: "join the team", href: link },
      { t: "p", small: true, text: `sign in with this email address to join. the link works once, until ${formatDate(expiresAt)}. weren't expecting this? ignore it and nothing happens.` },
    ],
    reason: "you got this because someone with a Metal team plan invited this address.",
  });
}

/** someone opened their invite while every paid seat was taken: once per invite */
export function teamSeatFullEmail(cfg: EmailConfig, { team, email, seats }: { team: string; email: string; seats: number }): Rendered {
  return render(cfg, {
    subject: `${email} couldn't join ${team}: no free seat`, preheader: `all ${seats} seats are taken. add a seat and their link works again.`, tag: "team", ...SAY.headsUp, transactional: true,
    blocks: [
      { t: "h1", text: "a seat is missing" },
      { t: "p", text: `**${email}** opened your invite to ${team}, but all ${seats} paid seats are taken, so they couldn't join yet.` },
      { t: "p", text: "add a seat, or remove someone, and the same link works for them again." },
      { t: "button", label: "open your team", href: `${cfg.app}/team` },
    ],
    reason: ACCOUNT_REASON,
  });
}
