// pulls a connected app's real action list from Composio's public toolkit page (docs.composio.dev/toolkits/<slug>), the
// catalog Metal's connected apps come from, into seo/facts/connectors/<slug>.json with where and when it was read.
// integration pages build their action tables from these files, never from typed lists. zero deps.
//   node seo/scripts/fetch-composio.mjs gmail slack ...     (no names: refresh every file already there)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDay } from '../quality.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'facts', 'connectors');
// the same rule Metal uses to tell a read from a write for a bot's per-app read or write access
// (shared/connector-scopes.ts isReadOnlyAction in the Metal repo): the first word of the action is a read verb
const READ_VERBS = new Set(['GET', 'LIST', 'FETCH', 'SEARCH', 'READ', 'FIND', 'RETRIEVE', 'LOOKUP', 'DOWNLOAD', 'VIEW', 'CHECK', 'COUNT']);
// composio reads Metal knows by name, since their names put the noun first (shared/outbound.ts KNOWN_READ_SLUGS)
const KNOWN_READS = new Set(['GMAIL_FETCH_EMAILS', 'GMAIL_GET_PROFILE', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
  'GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_EVENTS_GET', 'GOOGLECALENDAR_FIND_EVENT', 'GOOGLECALENDAR_LIST_CALENDARS']);
const tokens = (slug, toolkit) => slug.slice(toolkit.length + 1).split(/[^A-Z0-9]+/).filter(Boolean);
export const isRead = (slug, toolkit) => KNOWN_READS.has(slug) || READ_VERBS.has(tokens(slug, toolkit)[0]);
// a send reaches a person outside the app or moves money, and asks first (shared/outbound.ts isOutboundTool): a send
// verb anywhere in the name, or creating something people receive (a comment, a message, an invoice), but not a draft
const SEND_VERBS = new Set(['SEND', 'SENDS', 'REPLY', 'RESPOND', 'FORWARD', 'POST', 'PUBLISH', 'TWEET', 'RETWEET', 'BROADCAST', 'INVITE', 'SHARE', 'REFUND', 'CHARGE', 'PAY', 'PAYOUT', 'TRANSFER']);
const CREATE_VERBS = new Set(['CREATE', 'CREATION', 'ADD', 'NEW']);
const SENT_NOUNS = new Set(['MESSAGE', 'COMMENT', 'POST', 'EMAIL', 'MAIL', 'INVOICE', 'PAYMENT', 'REFUND', 'REPLY', 'TWEET', 'DM']);
export function isSend(slug, toolkit) {
  if (isRead(slug, toolkit)) return false;
  const t = tokens(slug, toolkit);
  if (t.some((x) => SEND_VERBS.has(x))) return true;
  if (t.includes('DRAFT')) return false;
  return t.some((x) => CREATE_VERBS.has(x)) && t.some((x) => SENT_NOUNS.has(x));
}
export const kindOf = (slug, toolkit) => (isRead(slug, toolkit) ? 'read' : isSend(slug, toolkit) ? 'send' : 'write');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');

function actionDetails(html, prefix) {
  const out = new Map();
  let stream = '';
  for (const [, chunk] of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) { try { stream += JSON.parse(`"${chunk}"`); } catch {} }
  const re = new RegExp(`\\{"slug":"(${prefix}[A-Z0-9_]+)","name":`, 'g');
  for (const m of stream.matchAll(re)) {
    if (out.has(m[1]) && out.get(m[1]).input_parameters) continue;
    const obj = readObject(stream, m.index);
    if (obj && obj.input_parameters) out.set(m[1], obj);
  }
  return out;
}
// reads one json object starting at i, by matching braces outside strings
function readObject(text, i) {
  let depth = 0, inStr = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } }
  }
  return null;
}

export function parse(html, slug) {
  const lines = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n'))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const at = (label) => lines.indexOf(label);
  const name = lines[at('All Toolkits') + 1];
  const version = lines[at('Latest version') + 1];
  const description = lines[at('Latest version') + 2];
  const authStart = at('Authentication Details'), faq = at('Frequently Asked Questions'), toolsAt = lines.findIndex((l) => l === 'Tools (');
  const authBlock = lines.slice(authStart + 1, faq > authStart ? faq : toolsAt);
  const counts = [];
  lines.forEach((l, i) => { if ((l === 'Tools (' || l === 'Triggers (') && /^\d+$/.test(lines[i + 1])) counts.push([l, Number(lines[i + 1])]); });
  const prefix = slug.toUpperCase() + '_';
  const pairs = [];
  for (let i = 1; i < lines.length; i++) if (lines[i].startsWith(prefix) && /^[A-Z0-9_]+$/.test(lines[i])) pairs.push({ name: lines[i - 1], slug: lines[i] });
  const nTools = counts.find(([l]) => l === 'Tools (')?.[1] ?? pairs.length;
  const seen = new Set(), unique = pairs.filter((p) => !seen.has(p.slug) && seen.add(p.slug));
  const tools = unique.slice(0, nTools).map((t) => ({ ...t, kind: kindOf(t.slug, slug) }));
  const triggers = unique.slice(nTools).map(({ name, slug: s }) => ({ name, slug: s }));
  // the page also carries each action's own record (what it does, its inputs, the permissions it asks for, hints like
  // readOnlyHint or destructiveHint, whether it is deprecated) as next.js stream data; read it where it is there
  const details = actionDetails(html, prefix);
  for (const t of tools) {
    const d = details.get(t.slug);
    if (!d) continue;
    t.description = d.description || '';
    t.inputs = Object.entries(d.input_parameters || {}).map(([name, v]) => ({ name, type: v.type || '', required: v.required === true, about: String(v.description || '').replace(/\$undefined/g, '').slice(0, 300) }));
    t.scopes = d.scopes || [];
    t.tags = d.tags || [];
    t.deprecated = d.is_deprecated === true || /deprecated/i.test(t.name);
  }
  return {
    toolkit: slug, name, version, description,
    managed_sign_in: authBlock.includes('Composio-managed OAuth available'),
    auth: authBlock.filter((l) => /^(OAuth\d?|API Key|Bearer Token|Basic|No Auth|.*Auth.*)$/i.test(l) && !/managed/i.test(l)),
    tools_count: nTools, triggers_count: counts.find(([l]) => l === 'Triggers (')?.[1] ?? triggers.length,
    tools, triggers,
  };
}

async function fetchOne(slug) {
  const source = `https://docs.composio.dev/toolkits/${slug}`;
  const res = await fetch(source, { headers: { 'user-agent': 'dusk.bot facts refresher (hello@dusk.bot)' } });
  if (!res.ok) throw new Error(`${slug}: ${source} answered ${res.status}`);
  const facts = parse(await res.text(), slug);
  if (!facts.tools.length) throw new Error(`${slug}: no actions found on ${source}; the page layout may have changed`);
  const out = { ...facts, source, fetched_at: localDay() };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`${slug}: ${facts.tools.length} actions (${facts.tools.filter((t) => t.kind === 'read').length} read, ${facts.tools.filter((t) => t.kind === 'send').length} send), ${facts.triggers.length} events, managed sign-in ${facts.managed_sign_in ? 'yes' : 'no'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(dir, { recursive: true });
  const names = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  let failed = 0;
  for (const slug of names) await fetchOne(slug).catch((err) => { failed++; console.error(err.message); });
  process.exit(failed ? 1 : 0);
}
