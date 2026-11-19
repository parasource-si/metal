// the seo pages' data: one json record per page in seo/pages/<type>/<name>.json, the release ledger (seo/release.json:
// which cohort each page belongs to and whether it is draft, queued, live, noindex or pruned) and the settings
// (seo/config.json). the build, the art kit and the release job all read the pages through here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const seoDir = path.dirname(fileURLToPath(import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// every kind of page. kind picks the template (seo/templates.mjs), hub the index page it sits under, words the least
// page-specific words its main content needs, needs the record fields it cannot go without
export const TYPES = {
  pillar: { kind: 'guide', hub: 'guides', words: 650, needs: ['sections'] },
  guide: { kind: 'guide', hub: 'guides', words: 550, needs: ['sections'] },
  alternative: { kind: 'compare', hub: 'alternatives', words: 550, needs: ['compare', 'verdict', 'method'] },
  comparison: { kind: 'compare', hub: 'alternatives', words: 550, needs: ['compare', 'verdict', 'method'] },
  integration: { kind: 'integration', hub: 'integrations', words: 500, needs: ['app', 'routines', 'cannot', 'asks'] },
  'use-case': { kind: 'usecase', hub: 'use-cases', words: 450, needs: ['routine', 'sections', 'safeguards'] },
  role: { kind: 'role', hub: 'use-cases', words: 450, needs: ['day', 'pack', 'sections'] },
  routine: { kind: 'routine', hub: 'routines', words: 280, needs: ['routine', 'knobs', 'fails'] },
  glossary: { kind: 'glossary', hub: 'glossary', words: 200, needs: ['definition', 'example'] },
  tool: { kind: 'tool', hub: 'tools', words: 280, needs: ['tool', 'method'] },
  // one composio action of a connected app: /integrations/<app>/<action>, listed on its app's page (seo/scripts/plan-actions.mjs)
  action: { kind: 'action', hub: 'integrations', words: 320, needs: ['action', 'what', 'uses', 'routine', 'steps', 'watch'] },
};

// the index pages. each lists its live pages in groups, and only exists while at least one of them is live
export const HUBS = {
  guides: { at: '/guides', nav: 'guides', title: 'Guides to AI bots that work for you / Metal', h1: 'guides',
    description: 'Plain-words guides to AI agents and bots: keeping them running with your laptop shut, scheduled AI tasks, group chats, safety and what it all costs.',
    lede: 'plain-words guides to bots that do real work: where they run, what they cost, what to trust them with, and how to set one up.',
    groups: [{ id: 'start-here', title: 'start here', types: ['pillar'] }, { id: 'how-and-why', title: 'how it works, and the fine print', types: ['guide'] }] },
  alternatives: { at: '/alternatives', nav: 'alternatives', title: 'Alternatives and comparisons, checked and dated / Metal',
    description: 'Honest comparisons of AI agent apps: OpenClaw, Hermes Agent, Manus, Claude Cowork, Poke and more, with dated sources and who should pick what.',
    h1: 'alternatives and comparisons', lede: 'side by side, with a date and a source on every claim. where another tool fits you better, the page says so.',
    groups: [{ id: 'alternatives', title: 'alternatives', types: ['alternative'] }, { id: 'comparisons', title: 'one on one', types: ['comparison'] }] },
  integrations: { at: '/integrations', nav: 'integrations', title: 'Connect AI bots to the apps you use / Metal',
    description: 'What your bots can do in Gmail, Google Calendar, Slack, Notion, GitHub and more: the real actions, what it asks first, and routines to copy.',
    h1: 'integrations', lede: 'connect an app once and a bot can work inside it. each page lists what it can really do there, what it asks you first, and routines to copy.',
    groups: [{ id: 'apps', title: 'apps', types: ['integration'] }] },
  'use-cases': { at: '/use-cases', nav: 'use cases', title: 'What people hand to AI bots, by task and by role / Metal',
    description: 'Real jobs for AI bots, by task and by role: inbox triage, morning briefings, research, invoices, and routine packs for founders and small teams.',
    h1: 'use cases', lede: 'the jobs people hand to bots, each with the exact message to send, what it needs and where it stops to ask you.',
    groups: [{ id: 'by-task', title: 'by task', types: ['use-case'] }, { id: 'by-role', title: 'by role', types: ['role'] }] },
  routines: { at: '/routines', nav: 'routines', title: 'Routines to copy: scheduled AI tasks that run for you / Metal',
    description: 'Copy-ready routines for AI bots: the message to send, when it runs, what it needs and what it hands back. Paste one into a chat and it is set up.',
    h1: 'routines to copy', lede: 'a routine is a job a bot does on a schedule, or when something happens. each one here is a message you paste into a chat.',
    groups: [{ id: 'routines', title: 'routines', types: ['routine'] }] },
  glossary: { at: '/glossary', nav: 'glossary', title: 'Glossary: AI agent words in plain English / Metal',
    description: 'Short, plain definitions of the words around AI agents and bots, each with an example of what it means in practice.',
    h1: 'glossary', lede: 'the words around ai agents, in plain english, each with an example.', groups: [{ id: 'words', title: 'words', types: ['glossary'] }] },
  tools: { at: '/tools', nav: 'free tools', title: 'Free tools for planning AI bots / Metal',
    description: 'Small free calculators and helpers for planning AI bots: what keeping one running costs, and more. They run in your browser.',
    h1: 'free tools', lede: 'small helpers that run in your browser. nothing you type leaves the page.', groups: [{ id: 'tools', title: 'tools', types: ['tool'] }] },
};
export const STATUSES = ['draft', 'queued', 'live', 'noindex', 'pruned'];

export function loadConfig() { return readJson(path.join(seoDir, 'config.json')); }
export function loadRelease() { return readJson(path.join(seoDir, 'release.json')); }
export function saveRelease(release) { fs.writeFileSync(path.join(seoDir, 'release.json'), JSON.stringify(release, null, 2) + '\n'); }

export function loadRecords() {
  const root = path.join(seoDir, 'pages'), out = [];
  for (const type of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!TYPES[type]) throw new Error(`seo/pages/${type}: no page type called ${type} (seo/records.mjs TYPES)`);
    for (const file of fs.readdirSync(path.join(root, type)).filter((f) => f.endsWith('.json'))) {
      let rec;
      try { rec = readJson(path.join(root, type, file)); } catch (err) {
        // while records are being written (SEO_CHECK runs beside each other), a half-written file is skipped
        if (process.env.SEO_CHECK === '1' && !(process.env.SEO_CHECK_ONLY || '').includes(`/${file.slice(0, -5)}`)) { console.log(`warning: skipped seo/pages/${type}/${file}: ${err.message}`); continue; }
        throw new Error(`seo/pages/${type}/${file}: ${err.message}`);
      }
      if (rec.type !== type) throw new Error(`seo/pages/${type}/${file}: type is "${rec.type}" but the file sits in ${type}/`);
      if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,2}$/.test(rec.path || '')) throw new Error(`seo/pages/${type}/${file}: path "${rec.path}" is not a lowercase /address`);
      out.push({ ...rec, kind: TYPES[type].kind, hub: TYPES[type].hub, file: `seo/pages/${type}/${file}` });
    }
  }
  const seen = new Map();
  for (const r of out) { if (seen.has(r.path)) throw new Error(`${r.file} and ${seen.get(r.path)} both claim ${r.path}`); seen.set(r.path, r.file); }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// every page with its release state. SEO_PREVIEW=1 also builds queued pages (with noindex, out of the sitemaps and
// hubs), to look at them before they go out
export function plan({ preview = process.env.SEO_PREVIEW === '1' } = {}) {
  const config = loadConfig(), release = loadRelease(), records = loadRecords();
  for (const r of records) {
    const state = release.pages[r.path] || { status: 'draft' };
    if (!STATUSES.includes(state.status)) throw new Error(`seo/release.json: ${r.path} has status "${state.status}"`);
    if (state.cohort && !release.cohorts.some((c) => c.id === state.cohort)) throw new Error(`seo/release.json: ${r.path} is in cohort ${state.cohort}, which is not listed`);
    r.state = state;
    r.indexable = state.status === 'live';
    r.built = state.status === 'live' || state.status === 'noindex' || (preview && state.status === 'queued');
  }
  for (const at of Object.keys(release.pages)) if (!records.some((r) => r.path === at)) throw new Error(`seo/release.json lists ${at}, but no record in seo/pages has that path`);
  const indexable = records.filter((r) => r.indexable);
  const built = records.filter((r) => r.built);
  // a hub is built while any of its pages is live (or, in preview, built)
  const hubs = Object.entries(HUBS).filter(([id]) => built.some((r) => r.hub === id && (r.indexable || preview))).map(([id, h]) => ({ id, ...h }));
  return { config, release, records, indexable, built, hubs, preview };
}
