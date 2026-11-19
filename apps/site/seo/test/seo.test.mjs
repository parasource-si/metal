// the seo system's own tests:  node --test seo/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBSCRIPTION, jaccard, ownText } from '../quality.mjs';
import { evaluateGate, sliceSize, frozen } from '../jobs/release.mjs';
import { changes } from '../jobs/indexnow.mjs';
import { decide } from '../jobs/prune-report.mjs';
import { writeSitemaps, robotsTxt, SEARCH_BOTS } from '../sitemaps.mjs';
import { scene, signature, altText } from '../art/scene.mjs';
import { isRead, kindOf, parse } from '../scripts/fetch-composio.mjs';

// a fixed calibration, so the tests check the gate's logic rather than today's numbers in seo/growth.json
const live = JSON.parse(fs.readFileSync(new URL('../growth.json', import.meta.url), 'utf8'));
const growth = { ...live, measure_day: 21, gate: { ...live.gate, seed_index_rate: { green: 0.6, at_day: 14 } }, caps: { max_share_of_indexed: 0.25, max_growth_vs_last: 2, per_day: 8 } };
const kit = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'public', 'landing', 'art');
const hits = (text) => SUBSCRIPTION.filter(([re]) => re.test(text)).map(([, why]) => why);

test('the claims rule catches false endorsement and free ai', () => {
  for (const bad of ['endorsed by Anthropic', 'an official OpenAI partner', 'free claude for everyone', 'unlimited chatgpt']) assert.ok(hits(bad).length, bad);
});
test('the claims rule lets plain subscription wording through', () => {
  for (const ok of ['use your claude subscription for automation', 'no api key needed', 'sign in to the ai you already use', 'what anthropic\'s page says about subscriptions']) assert.deepEqual(hits(ok), [], ok);
});

test('own text drops the parts every page shares', () => {
  const html = '<article class="doc prose seo-page"><p class="crumb">x / y</p><p>this page only</p><aside class="seo-cta seo-boiler"><div><p>join the waitlist</p></div></aside><section class="seo-sources"><h2>sources</h2></section></article>';
  assert.equal(ownText(html), 'this page only');
});
test('jaccard of word shingles', () => {
  const a = new Set(['a b c d e', 'b c d e f']), b = new Set(['a b c d e', 'x y z w v']);
  assert.equal(jaccard(a, a), 1);
  assert.equal(jaccard(a, b), 1 / 3);
});

const cohort = { id: '02', released: '2026-12-01' };
const pages = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'];
const snap = (indexed, seen) => ({ pages: Object.fromEntries(pages.map((p, i) => [p, { indexed: i < indexed, coverage: i < indexed ? 'Submitted and indexed' : 'Crawled - currently not indexed', impressions: i < seen ? 3 : 0 }])) });
test('the gate waits for its measuring day', () => {
  assert.equal(evaluateGate({ cohort, pages, snapshot: snap(10, 10), growth, today: '2026-12-10' }).state, 'wait');
});
test('the gate is green when indexed and seen, amber in between, red below the line', () => {
  assert.equal(evaluateGate({ cohort, pages, snapshot: snap(8, 4), growth, today: '2026-12-22' }).state, 'green');
  assert.equal(evaluateGate({ cohort, pages, snapshot: snap(10, 2), growth, today: '2026-12-22' }).state, 'amber');
  assert.equal(evaluateGate({ cohort, pages, snapshot: snap(4, 4), growth, today: '2026-12-22' }).state, 'red');
});
test('the gate holds when a page has no data', () => {
  const s = snap(10, 10); delete s.pages.u3;
  assert.equal(evaluateGate({ cohort, pages, snapshot: s, growth, today: '2026-12-22' }).state, 'hold');
});
test('the seed is judged on indexing at day 14 only', () => {
  assert.equal(evaluateGate({ cohort, pages, snapshot: snap(8, 0), growth, today: '2026-12-15', seed: true }).state, 'green');
  const half = snap(5, 0); for (const p of pages.slice(5)) half.pages[p].coverage = 'URL is unknown to Google';
  assert.equal(evaluateGate({ cohort, pages, snapshot: half, growth, today: '2026-12-15', seed: true }).state, 'amber');
});
test('a slice never outgrows what is indexed or the last cohort', () => {
  assert.equal(sliceSize({ waiting: 30, growth, indexedTotal: 100, lastCohortSize: 30 }), growth.caps.per_day);
  assert.equal(sliceSize({ waiting: 30, growth, indexedTotal: 12, lastCohortSize: 30 }), 3);
  assert.equal(sliceSize({ waiting: 30, growth, indexedTotal: 1000, lastCohortSize: 2 }), 4);
});
test('a freeze window holds releases', () => {
  const g = { ...growth, freeze: [{ from: '2026-11-10', until: '2026-12-08', why: 'test' }] };
  assert.ok(frozen(g, '2026-11-20'));
  assert.equal(frozen(g, '2026-12-20'), null);
});

test('indexnow sends only new, changed and removed pages', () => {
  const { urls, next } = changes({ 'https://d/a': '2026-11-12', 'https://d/b': '2026-11-13' }, { 'https://d/a': '2026-11-12', 'https://d/b': '2026-11-12', 'https://d/c': '2026-11-01' }, ['https://d/c']);
  assert.deepEqual(urls, ['https://d/b', 'https://d/c']);
  assert.equal(next['https://d/c'], 'gone');
  assert.deepEqual(changes({ 'https://d/a': '1' }, { 'https://d/a': '1' }, []).urls, []);
});

test('the prune report asks for a refresh at day 60 and a decision at day 120', () => {
  const recs = [{ path: '/a', state: { live_at: '2026-01-01' } }, { path: '/b', state: { live_at: '2026-01-01' } }, { path: '/c', state: { live_at: '2026-03-05' } }];
  const s = { pages: { 'https://d/a': { indexed: false, coverage: 'Crawled - currently not indexed', impressions: 0 }, 'https://d/b': { indexed: true, impressions: 9 }, 'https://d/c': { indexed: false, impressions: 0 } } };
  const out = decide(recs, s, growth.prune, '2026-05-10', 'https://d');
  assert.equal(out.find((r) => r.path === '/a').action, 'refresh, last chance');
  assert.equal(out.find((r) => r.path === '/c').action, 'refresh');
  assert.equal(out.some((r) => r.path === '/b'), false);
});

test('sitemaps: an index, a file per group, and a lastmod that moves only when the content does', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-site-'));
  const ledger = new URL('../lastmod.json', import.meta.url), saved = fs.existsSync(ledger) ? fs.readFileSync(ledger) : null;
  try {
    const built = [{ address: '/', index: true, group: 'core', lastmodKey: '<main>home ?v=12345678</main>' }, { address: '/x', index: true, group: '01', lastmodKey: 'record-x' }, { address: '/404.html', index: false }];
    fs.writeFileSync(ledger, '{}');
    writeSitemaps({ site, SITE_URL: 'https://d', built, cohorts: [{ id: '01' }], today: '2026-11-12' });
    const index = fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8');
    assert.match(index, /sitemaps\/core\.xml/); assert.match(index, /sitemaps\/cohort-01\.xml/);
    assert.match(fs.readFileSync(path.join(site, 'sitemaps', 'cohort-01.xml'), 'utf8'), /<loc>https:\/\/d\/x<\/loc><lastmod>2026-11-12<\/lastmod>/);
    built[0].lastmodKey = '<main>home ?v=87654321</main>';
    writeSitemaps({ site, SITE_URL: 'https://d', built, cohorts: [{ id: '01' }], today: '2026-11-20' });
    assert.match(fs.readFileSync(path.join(site, 'sitemaps', 'core.xml'), 'utf8'), /2026-11-12/, 'a new asset stamp is not a content change');
    built[1].lastmodKey = 'record-x, edited';
    writeSitemaps({ site, SITE_URL: 'https://d', built, cohorts: [{ id: '01' }], today: '2026-11-20' });
    assert.match(fs.readFileSync(path.join(site, 'sitemaps', 'cohort-01.xml'), 'utf8'), /2026-11-20/);
  } finally { if (saved) fs.writeFileSync(ledger, saved); else fs.rmSync(ledger, { force: true }); fs.rmSync(site, { recursive: true, force: true }); }
});
test('robots lets every search and answer engine in and names the sitemap', () => {
  const r = robotsTxt('https://dusk.bot');
  for (const bot of ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot', 'Googlebot', 'Bingbot']) assert.ok(SEARCH_BOTS.includes(bot) && r.includes(`User-agent: ${bot}\nAllow: /`), bot);
  assert.match(r, /Sitemap: https:\/\/dusk\.bot\/sitemap\.xml/);
  assert.doesNotMatch(r, /Disallow: \/\n/);
});

test('scenes are the same every time and differ between pages', () => {
  const a = scene({ path: '/integrations/gmail', kind: 'integration', h1: 'x', art: { logo: 'gmail' } }, kit);
  assert.deepEqual(scene({ path: '/integrations/gmail', kind: 'integration', h1: 'x', art: { logo: 'gmail' } }, kit), a);
  const sigs = new Set(Array.from({ length: 40 }, (_, i) => signature(scene({ path: `/use-cases/t${i}`, kind: 'usecase', h1: 'x' }, kit))));
  assert.ok(sigs.size > 30);
  assert.match(altText(a), /^pixel art: .+ gmail/i);
});
test('a scene refuses kit pieces that do not exist', () => {
  assert.throws(() => scene({ path: '/x', kind: 'guide', h1: 'x', art: { props: ['p-unicorn'] } }, kit), /does not have/);
  assert.throws(() => scene({ path: '/x', kind: 'guide', h1: 'x', art: { logo: 'nope' } }, kit), /no mark/);
});

test('composio pages: reads and changes by Metal\'s own rule', () => {
  assert.equal(isRead('GMAIL_FETCH_EMAILS', 'gmail'), true);
  assert.equal(isRead('GMAIL_SEND_EMAIL', 'gmail'), false);
  assert.equal(isRead('GMAIL_SETTINGS_GET_IMAP', 'gmail'), false);
  assert.equal(isRead('GOOGLECALENDAR_EVENTS_LIST', 'googlecalendar'), true, 'known reads whose names put the noun first');
  assert.equal(kindOf('GITHUB_CREATE_AN_ISSUE_COMMENT', 'github'), 'send', 'a created comment is read by someone');
  assert.equal(kindOf('GMAIL_CREATE_EMAIL_DRAFT', 'gmail'), 'write', 'a draft is not a send');
  assert.equal(kindOf('STRIPE_CREATE_REFUND', 'stripe'), 'send', 'moving money is a send');
  assert.equal(kindOf('GITHUB_ADD_LABELS_TO_AN_ISSUE', 'github'), 'write');
  const html = '<div>All Toolkits</div><div>Gmail</div><div>Latest version</div><div>20261105_00</div><div>Gmail is mail.</div><div>Authentication Details</div><div>Composio-managed OAuth available</div><div>OAuth2</div><div>Tools (</div><div>2</div><div>)</div><div>Triggers (</div><div>0</div><div>)</div><span>Fetch emails</span><span>GMAIL_FETCH_EMAILS</span><span>Send Email</span><span>GMAIL_SEND_EMAIL</span>';
  const f = parse(html, 'gmail');
  assert.equal(f.name, 'Gmail'); assert.equal(f.managed_sign_in, true); assert.deepEqual(f.auth, ['OAuth2']);
  assert.deepEqual(f.tools.map((t) => t.kind), ['read', 'send']);
});
