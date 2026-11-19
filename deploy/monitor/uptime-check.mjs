#!/usr/bin/env node
// uptime checks for dusk.bot from a box other than the one it watches (the Oracle VPS watches the Contabo one), run every
// minute by dusk-uptime.timer. per outage one "down" email (after DUSK_UPTIME_FAILS misses in a row) and one "back up"
// email with how long it was down, nothing in between; one TLS warning per certificate with under DUSK_UPTIME_TLS_DAYS
// left, until it is renewed; at most DUSK_UPTIME_MAILS_PER_DAY emails a day. a failed email is retried each run.
//   DUSK_ALERT_TO          comma-separated addresses; DUSK_ALERT_FROM the sender ("Name <address>")
//   DUSK_BREVO_API_KEY     Brevo transactional key; DUSK_RESEND_API_KEY a fallback sender when set
//   DUSK_UPTIME_TARGETS    space-separated name=url or name=url=text-the-body-must-contain (default below)
//   DUSK_UPTIME_TLS        space-separated hosts whose certificates are checked hourly
//   DUSK_UPTIME_STATE      state folder (default /var/lib/dusk-uptime)
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { connect } from "node:tls";
import { pathToFileURL } from "node:url";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const DEFAULT_TARGETS = [
  "waitlist=https://dusk.bot/", "dashboard=https://dusk.bot/dashboard/", "api=https://dusk.bot/v1/health=\"ok\":true",
  "waitlist-count=https://dusk.bot/api/waitlist/count=\"count\"", "preview-api=https://preview.dusk.bot/v1/health=\"ok\":true",
  "installer=https://dusk.bot/install.sh", "link=https://link.dusk.bot/healthz",
].join(" ");

export function settings(env = process.env) {
  const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  return {
    targets: (env.DUSK_UPTIME_TARGETS || DEFAULT_TARGETS).split(/\s+/).filter(Boolean).map(pair => {
      const [name, ...rest] = pair.split("="), joined = rest.join("=");
      const at = joined.search(/=(?=[^/]*$)/);
      return at > 8 ? { name, url: joined.slice(0, at), expect: joined.slice(at + 1) } : { name, url: joined, expect: null };
    }),
    tls: (env.DUSK_UPTIME_TLS ?? "dusk.bot preview.dusk.bot link.dusk.bot").split(/\s+/).filter(Boolean),
    control: env.DUSK_UPTIME_CONTROL || "https://www.cloudflare.com/cdn-cgi/trace",
    fails: number(env.DUSK_UPTIME_FAILS, 2),
    mailsPerDay: number(env.DUSK_UPTIME_MAILS_PER_DAY, 10),
    tlsDays: number(env.DUSK_UPTIME_TLS_DAYS, 14),
    state: env.DUSK_UPTIME_STATE || "/var/lib/dusk-uptime",
    to: (env.DUSK_ALERT_TO || "").split(",").map(item => item.trim()).filter(item => /^[^\s@]+@[^\s@]+$/.test(item)),
    from: env.DUSK_ALERT_FROM || "alerts@dusk.bot",
    brevo: env.DUSK_BREVO_API_KEY || null,
    resend: env.DUSK_RESEND_API_KEY || null,
  };
}

export const duration = ms => {
  const s = Math.max(0, Math.round(ms / 1000)), d = Math.floor(s / 86_400), h = Math.floor(s % 86_400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const when = at => `${new Date(at).toISOString().slice(11, 16)} utc`;

export async function probe(target, fetcher = fetch) {
  try {
    const response = await fetcher(target.url, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "dusk-uptime/2" } });
    const body = target.expect ? (await response.text()).slice(0, 65_536) : (await response.body?.cancel(), "");
    if (response.status < 200 || response.status >= 400) return { ok: false, detail: `http ${response.status}` };
    if (target.expect && !body.includes(target.expect)) return { ok: false, detail: `http ${response.status} without ${target.expect}` };
    return { ok: true, detail: `http ${response.status}` };
  } catch (error) {
    const cause = error?.cause?.code || error?.name || "error";
    return { ok: false, detail: String(cause).toLowerCase().replace(/error$/, "") || "error" };
  }
}

export function certificateExpiry(host) {
  return new Promise(resolve => {
    const socket = connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert?.valid_to ? Date.parse(cert.valid_to) : null);
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

/** the decisions of one run, from the state before it and what the probes saw; pure, so the rules are tested */
export function decide(state, results, cfg, time) {
  const down = [], recovered = [];
  for (const { name, url, ok, detail } of results) {
    const was = state.targets[name] ?? { fails: 0, downSince: null, alertedAt: null };
    if (ok) {
      if (was.alertedAt) recovered.push({ name, url, detail, downFor: time - (was.downSince ?? was.alertedAt) });
      state.targets[name] = { fails: 0, downSince: null, alertedAt: null };
      continue;
    }
    const now = { ...was, fails: was.fails + 1, downSince: was.downSince ?? time, last: detail };
    if (!now.alertedAt && now.fails >= cfg.fails) { now.alertedAt = time; down.push({ name, url, detail, since: now.downSince }); }
    state.targets[name] = now;
  }
  return { down, recovered };
}

const EMAIL_CFG = { assets: "https://dusk.bot/email", site: "https://dusk.bot", app: "https://dusk.bot/dashboard", address: null };
const REASON = "you got this because your address is in DUSK_ALERT_TO on the oracle uptime checker.";
const PANEL = "https://dusk.bot/admin/health";

export async function layout() {
  for (const candidate of [new URL("./layout.ts", import.meta.url), new URL("../../apps/dashboard/server/email/layout.ts", import.meta.url)]) {
    try { return (await import(candidate.href)).render; } catch {}
  }
  return null;
}

export async function emailFor(kind, items) {
  const names = items.map(item => item.name).join(", ");
  const email = kind === "down" ? {
    subject: `something's wrong: ${names} ${items.length === 1 ? "is" : "are"} down`, heading: "something's wrong", say: "uh oh, a site is down", accent: "pink", status: ["down", "bad"],
    intro: `checks from the oracle box failed in a row. this is the only email until it's back up; then you get one more.`,
    rows: items.map(item => [item.name, `${item.detail} · down since ${when(item.since)}`, "off"]),
  } : kind === "recovered" ? {
    subject: `back up: ${names}`, heading: "back up", intro: "these answer again.", say: "phew, it's back up", accent: "lime", status: ["up", "ok"],
    rows: items.map(item => [item.name, `${item.detail} · was down for ${duration(item.downFor)}`, "ok"]),
  } : {
    subject: `certificate expiring: ${names}`, heading: "a certificate is about to expire", say: "heads up, a cert", accent: "lemon", status: ["expiring", "warn"], intro: "renew it before it runs out, or browsers will refuse the site.",
    rows: items.map(item => [item.name, `expires ${new Date(item.expiresAt).toISOString().slice(0, 10)} (${duration(item.expiresAt - Date.now())} left)`, "warn"]),
  };
  const urls = items.map(item => item.url).filter(Boolean);
  const render = await layout();
  if (render) {
    const blocks = [{ t: "h1", text: email.heading }, { t: "p", text: email.intro }, { t: "facts", rows: email.rows }, ...(urls.length ? [{ t: "list", items: urls }] : []),
      { t: "button", label: "open admin health", href: PANEL }];
    return render(EMAIL_CFG, { subject: email.subject, preheader: email.rows.map(row => `${row[0]}: ${row[1]}`).join("; ").slice(0, 120), tag: "uptime", say: email.say, accent: email.accent, status: email.status, blocks, reason: REASON });
  }
  const text = [email.heading, email.intro, ...email.rows.map(row => `${row[0]}: ${row[1]}`), ...urls, PANEL, "--", REASON].join("\n\n");
  return { subject: email.subject, text, html: `<pre style="font-family:ui-monospace,monospace">${text.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch])}</pre>` };
}

export async function deliver(cfg, message, fetcher = fetch) {
  const address = (cfg.from.match(/<([^>]+)>\s*$/)?.[1] ?? cfg.from).trim();
  const senders = [];
  if (cfg.brevo) senders.push(() => fetcher("https://api.brevo.com/v3/smtp/email", { method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { "api-key": cfg.brevo, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: "Metal", email: address }, to: cfg.to.map(email => ({ email })), subject: message.subject, textContent: message.text, htmlContent: message.html }) }));
  if (cfg.resend) senders.push(() => fetcher("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${cfg.resend}`, "content-type": "application/json" }, body: JSON.stringify({ from: `Metal <${address}>`, to: cfg.to, subject: message.subject, text: message.text, html: message.html }) }));
  for (const [index, send] of senders.entries()) {
    try {
      const response = await send();
      await response.body?.cancel();
      if (response.ok) return true;
      console.log(`mail: sender ${index + 1} answered ${response.status}`);
    } catch (error) { console.log(`mail: sender ${index + 1} failed (${error?.name ?? "error"})`); }
  }
  return false;
}

export async function run(cfg = settings(), { fetcher = fetch, now = Date.now, expiry = certificateExpiry } = {}) {
  mkdirSync(cfg.state, { recursive: true });
  const file = `${cfg.state}/state.json`;
  let state;
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch { state = {}; }
  state.targets ??= {}; state.tls ??= {}; state.outbox ??= [];
  const time = now();

  const results = await Promise.all(cfg.targets.map(async target => ({ ...target, ...await probe(target, fetcher) })));
  const failing = results.filter(result => !result.ok);
  let decisions = { down: [], recovered: [] };
  if (failing.length && !(await probe({ url: cfg.control, expect: null }, fetcher)).ok) console.log(`skipped: this box is offline too (${failing.map(item => item.name).join(", ")} failed)`);
  else decisions = decide(state, results, cfg, time);
  for (const item of failing) console.log(`fail ${item.name} ${item.detail}`);

  const expiring = [];
  for (const host of cfg.tls) {
    const seen = state.tls[host] ?? { checkedAt: 0, expiresAt: null, alertedAt: null };
    if (time - seen.checkedAt < HOUR) continue;
    const expiresAt = await expiry(host);
    state.tls[host] = { ...seen, checkedAt: time, expiresAt: expiresAt ?? seen.expiresAt };
    if (expiresAt === null) continue;
    if (expiresAt - time < cfg.tlsDays * DAY) {
      if (!seen.alertedAt) { state.tls[host].alertedAt = time; expiring.push({ name: host, url: `https://${host}/`, expiresAt }); }
    } else state.tls[host].alertedAt = null;
  }

  const mails = [];
  if (decisions.down.length) mails.push(await emailFor("down", decisions.down));
  if (decisions.recovered.length) mails.push(await emailFor("recovered", decisions.recovered));
  if (expiring.length) mails.push(await emailFor("tls", expiring));

  const day = Math.floor(time / DAY);
  state.sent = state.sent?.day === day ? state.sent : { day, count: 0 };
  const allowed = mails.slice(0, Math.max(0, cfg.mailsPerDay - state.sent.count));
  for (const message of mails.slice(allowed.length)) console.log(`over the daily email limit, not mailed: ${message.subject}`);
  state.sent.count += allowed.length;
  const pending = [...state.outbox.filter(job => job.until > time), ...allowed.map(message => ({ message, until: time + DAY }))];
  state.outbox = [];
  for (const job of pending) {
    if (!cfg.to.length || (!cfg.brevo && !cfg.resend)) { console.log(`alert (not mailed, no sender): ${job.message.subject}`); continue; }
    if (await deliver(cfg, job.message, fetcher)) console.log(`mailed: ${job.message.subject}`);
    else { console.log(`mail failed, kept for the next run: ${job.message.subject}`); state.outbox.push(job); }
  }
  state.outbox = state.outbox.slice(-20);
  writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return { results, ...decisions, expiring, mailed: mails.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().then(result => { if (!result.results.some(item => !item.ok)) console.log(`ok ${result.results.length} checks`); }, error => { console.error(`uptime check failed: ${error?.stack ?? error}`); process.exit(1); });
}
