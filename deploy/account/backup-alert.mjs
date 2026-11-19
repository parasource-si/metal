#!/usr/bin/env node
// one email when a backup set starts failing and one when it works again, nothing in between; an email that fails to
// send is retried on the next run for up to three days. run by dusk-backup@<set>.service as ExecStopPost, which
// gets SERVICE_RESULT from systemd.
//   argv[2]                 the set name (dusk, make)
//   DUSK_BACKUP_ALERT_ENV   file with DUSK_BREVO_API_KEY (DUSK_RESEND_API_KEY), DUSK_ALERT_TO, DUSK_ALERT_FROM
//                           (default /etc/dusk-backup/alert.env), read here so the backup itself never holds the key
//   DUSK_BACKUP_STATE       state folder (default /var/lib/dusk-backup)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DAY = 86_400_000;

/** the email (if any) one finished run calls for; pure, so the no-repeat rule is tested */
export function decide(state, ok, time) {
  if (!ok && state.failingSince == null) return { state: { failingSince: time, alerted: true }, mail: "failed" };
  if (ok && state.failingSince != null) return { state: {}, mail: state.alerted ? "recovered" : null, downFor: time - state.failingSince };
  return { state, mail: null };
}

const days = ms => { const h = Math.round(ms / 3_600_000); return h < 48 ? `${h}h` : `${Math.round(h / 24)} days`; };

const EMAIL_CFG = { assets: "https://dusk.bot/email", site: "https://dusk.bot", app: "https://dusk.bot/dashboard", address: null };

/** `render` is the shared email layout when it loads; without it the email is the plain text in a pre */
export function message(kind, set, { log = "", downFor = 0, host = "the contabo vps", render = null } = {}) {
  const failed = kind === "failed";
  const subject = failed ? `backup failed: ${set}` : `backups work again: ${set}`;
  const intro = failed ? `the daily ${set} backup on ${host} failed. this is the only email until it works again; then you get one more.`
    : `the ${set} backup on ${host} works again after ${days(downFor)}.`;
  const command = `journalctl -u dusk-backup@${set} -n 50`;
  if (render) return render(EMAIL_CFG, { subject, preheader: intro.slice(0, 120), tag: "backup", say: failed ? "uh oh, a backup failed" : "phew, backups work again",
    accent: failed ? "pink" : "lime", status: failed ? ["failed", "bad"] : ["working", "ok"],
    blocks: [{ t: "h1", text: subject }, { t: "p", text: intro }, { t: "facts", rows: [["set", set], ["host", host]] },
      ...(failed ? [{ t: "label", text: "see what happened" }, { t: "cmd", text: command }, ...(log ? [{ t: "label", text: "last lines" }, { t: "log", text: log }] : [])] : [])],
    reason: "owner alert for Metal backups. one email per incident." });
  const text = (failed ? [intro, `see: ${command}`, ...(log ? ["last lines:", log] : [])] : [intro]).join("\n\n");
  return { subject, text, html: `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${text.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch])}</pre>` };
}

function lastLog() {
  if (!process.env.INVOCATION_ID) return "";
  try {
    return execFileSync("journalctl", [`_SYSTEMD_INVOCATION_ID=${process.env.INVOCATION_ID}`, "-o", "cat", "-n", "15", "--no-pager"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch { return ""; }
}

async function main() {
  const set = process.argv[2];
  if (!/^[a-z0-9-]+$/.test(set ?? "")) throw new Error("usage: backup-alert.mjs <set>");
  const envFile = process.env.DUSK_BACKUP_ALERT_ENV || "/etc/dusk-backup/alert.env";
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { settings, deliver, layout } = await import(new URL("./uptime-check.mjs", import.meta.url).href);
  const cfg = settings();
  const render = await layout();

  const dir = process.env.DUSK_BACKUP_STATE || "/var/lib/dusk-backup";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${dir}/alert-${set}.json`;
  let saved;
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { saved = {}; }
  const time = Date.now();
  const ok = process.env.SERVICE_RESULT === "success";
  const { state, mail, downFor } = decide(saved.state ?? {}, ok, time);
  const outbox = (saved.outbox ?? []).filter(job => job.until > time);
  if (mail) outbox.push({ message: message(mail, set, { log: mail === "failed" ? lastLog() : "", downFor, render }), until: time + 3 * DAY });

  const left = [];
  for (const job of outbox) {
    if (!cfg.to.length || (!cfg.brevo && !cfg.resend)) { console.log(`alert (not mailed, no sender): ${job.message.subject}`); continue; }
    if (await deliver(cfg, job.message)) console.log(`mailed: ${job.message.subject}`);
    else { console.log(`mail failed, kept for the next run: ${job.message.subject}`); left.push(job); }
  }
  writeFileSync(`${file}.tmp`, JSON.stringify({ state, outbox: left }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(`backup alert failed: ${error?.message ?? error}`); process.exit(1); });
}
