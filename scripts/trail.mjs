#!/usr/bin/env node
// Reads the debug trail (electron/trail.mjs) as one timeline: main's and the renderer's trail.jsonl, the server's
// trail-server.jsonl and anything rotated beside them.
//
//   node scripts/trail.mjs --since 10m --grep takeover        what path did take-overs use
//   node scripts/trail.mjs --since 1d --grep takeover --last 1 the last take-over only, with its path
//   node scripts/trail.mjs --cid 3fa9c0d1e2b34a5f             one action on every machine whose trail you point at
//   node scripts/trail.mjs --ev link. --since 2h               every connection path change, attempt and drop
//   node scripts/trail.mjs --follow                            live, as it is written
//
// --dir picks the folder (repeatable: a server's copied trail beside this computer's); default is the app's logs folder.
// --json prints the events themselves; --until bounds the window; --last N keeps the last N matches.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTrail, trailFiles } from "../electron/trail.mjs";

const HELP = `usage: node scripts/trail.mjs [--since 10m|2h|1d|<iso>] [--until <iso>] [--grep <regex>] [--ev <prefix>] [--cid <id>] [--last N] [--dir <folder>]... [--json] [--follow]`;

export function parseArgs(argv) {
  const out = { dirs: [], since: null, until: null, grep: null, ev: null, cid: null, last: 0, json: false, follow: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = () => argv[++i];
    if (arg === "--since") out.since = next();
    else if (arg === "--until") out.until = next();
    else if (arg === "--grep") out.grep = next();
    else if (arg === "--ev") out.ev = next();
    else if (arg === "--cid") out.cid = next();
    else if (arg === "--last") out.last = Number(next()) || 0;
    else if (arg === "--dir") out.dirs.push(next());
    else if (arg === "--json") out.json = true;
    else if (arg === "--follow" || arg === "-f") out.follow = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument ${arg}\n${HELP}`);
  }
  return out;
}

/** "10m", "2h", "1d", "30s" ago, or an ISO time */
export function parseWhen(value, now = Date.now()) {
  if (!value) return null;
  const rel = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value);
  if (rel) return now - Number(rel[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[rel[2]];
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`not a time: ${value}`);
  return at;
}

export function defaultLogDirs(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.DUSK_TRAIL_DIR) return [env.DUSK_TRAIL_DIR];
  if (env.DUSK_LOG_DIR) return [env.DUSK_LOG_DIR];
  const names = ["duskbot", "Metal", "Metal", "dusk-bot"];
  const bases = platform === "darwin" ? [path.join(home, "Library", "Logs")]
    : platform === "win32" ? [path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"))].flatMap((base) => [base])
      : [path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"))];
  const found = [];
  for (const base of bases) for (const name of names) {
    const dir = platform === "darwin" ? path.join(base, name) : path.join(base, name, "logs");
    if (fs.existsSync(dir)) found.push(dir);
  }
  // a server with no desktop app writes beside its data
  const data = path.join(env.DUSK_DATA_DIR ?? path.join(home, ".duskbot"), "logs");
  if (fs.existsSync(data)) found.push(data);
  return found;
}

const has = (event, needle) => Object.values(event).some((value) => value === needle || (value && typeof value === "object" && Object.values(value).includes(needle)));

export function matches(event, { grep, ev, cid }) {
  if (ev && !String(event.ev).startsWith(ev)) return false;
  if (cid && !has(event, cid)) return false;
  if (grep) {
    const re = new RegExp(grep, "i");
    if (!re.test(event.ev) && !re.test(JSON.stringify(event))) return false;
  }
  return true;
}

const FIXED = new Set(["ts", "ev", "src", "run"]);
const flat = (value) => (value && typeof value === "object" ? `{${Object.entries(value).map(([k, v]) => `${k}=${flat(v)}`).join(" ")}}` : String(value));

/** one event as one readable line: time, where it came from, what, and its fields with the path first */
export function formatEvent(event) {
  const time = String(event.ts).replace("T", " ").replace(/Z$/, "").slice(5, 23);
  const order = ["path", "via", "link", "screen", "from", "to", "reason", "ok", "status", "ms", "cid", "bot"];
  const keys = Object.keys(event).filter((key) => !FIXED.has(key)).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const fields = keys.map((key) => `${key}=${flat(event[key])}`).join(" ");
  return `${time}  ${String(event.src ?? "?").padEnd(8)} ${String(event.ev).padEnd(24)} ${fields}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const dirs = args.dirs.length ? args.dirs : defaultLogDirs();
  if (!dirs.length) { console.error("no trail found: pass --dir <the app's logs folder>"); process.exitCode = 1; return; }
  const sinceMs = parseWhen(args.since) ?? (args.follow ? Date.now() - 60_000 : Date.now() - 24 * 3.6e6);
  const untilMs = parseWhen(args.until) ?? Infinity;
  const print = (event) => console.log(args.json ? JSON.stringify(event) : formatEvent(event));

  let events = [];
  for (const dir of dirs) events.push(...await readTrail(dir, { sinceMs, untilMs }));
  events = events.filter((event) => matches(event, args)).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (args.last > 0) events = events.slice(-args.last);
  if (!events.length && !args.follow) console.error(`no matching events since ${new Date(sinceMs).toISOString()} in ${dirs.join(", ")}`);
  for (const event of events) print(event);
  if (!args.follow) return;

  // follow: read what each active file gains (rotation starts a new one at size 0)
  const offsets = new Map();
  for (const dir of dirs) for (const one of await trailFiles(dir)) if (one.at === Number.MAX_SAFE_INTEGER) offsets.set(one.file, fs.statSync(one.file).size);
  setInterval(async () => {
    for (const dir of dirs) for (const one of await trailFiles(dir)) {
      if (one.at !== Number.MAX_SAFE_INTEGER) continue;
      const size = fs.statSync(one.file).size, from = offsets.get(one.file) ?? 0;
      if (size === from) continue;
      const start = size < from ? 0 : from;
      const text = await fs.promises.readFile(one.file, "utf8").then((all) => Buffer.from(all).subarray(start).toString("utf8"));
      offsets.set(one.file, size);
      for (const line of text.split("\n")) {
        if (!line) continue;
        try { const event = JSON.parse(line); if (matches(event, args)) print(event); } catch {}
      }
    }
  }, 500);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("scripts/trail.mjs")) {
  main().catch((error) => { console.error(error?.message ?? error); process.exitCode = 1; });
}
