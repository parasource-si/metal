// the seo quality gate. the build stops if any queued, live or noindex page fails one of these; a draft only warns.
// what it checks, per page: the fields its kind needs and enough of them; enough words of its own (shared template text
// does not count); a 40 to 80 word answer first; title, description and h1 lengths, each unique; one h1; alt text, width and
// height on every picture; its own picture files; no placeholder text, no em dash, no subscription claim we cannot stand
// behind (see SUBSCRIPTION below); dated sources; internal links that lead somewhere; and no page too close to another
// (word 5-gram jaccard over each page's own text).
import fs from 'node:fs';
import path from 'node:path';
import { sceneId } from './art/scene.mjs';
import { HUBS } from './records.mjs';

// claims no page may make, whatever else it says: that an ai vendor endorses, approves or partners with Metal, or that
// its ai is free or unlimited. (the owner cleared plain wording about using the ai subscription you already have on
// 2026-11-12; statements about vendor terms must still be factual, dated and sourced)
export const SUBSCRIPTION = [
  [/\b(?:endorsed|approved|certified|partnered|sponsored|backed)\s+(?:by|with)\s+(?:anthropic|openai|google|xai|microsoft)\b/i, 'implies vendor endorsement'],
  [/\b(?:official|authori[sz]ed)\s+(?:anthropic|openai|google|xai|claude|chatgpt|gemini|grok)\s+(?:partner|app|client|integration)\b/i, 'implies vendor endorsement'],
  [/\b(?:free|unlimited)\s+(?:claude|chatgpt|gemini|grok)\b/i, 'promises free or unlimited ai'],
];
// the voice lint (owner, 12 november 2026: "be more human and genuine, hit hard"). filler phrases and hype are refused;
// sentences stay short, paragraphs stay small, and most sentences are active. strict on rewritten pages ("voice": 2)
export const FILLER = /\b(?:it'?s worth noting|it is worth noting|it'?s important to note|it is important to|please note|in today'?s|whether you'?re|in conclusion|furthermore|moreover|additionally,|in order to|unlock|supercharge|seamless(?:ly)?|game[- ]changer|revolutionary|effortless(?:ly)?|leverage|delve|robust|cutting[- ]edge|harness the power|elevate|empower|streamline|a wide range of|plethora|myriad|navigate the|the world of|look no further|at the end of the day|needless to say|this page|this guide (?:does|will)|documented|establish(?:es|ed)?|supplie[ds]|specif(?:y|ied|ies)|explicitly)\b/i;
const PASSIVE = /\b(?:is|are|was|were|be|been|being|gets?|got)\s+(?:\w+ly\s+)?\w+(?:ed|en|wn|ung|ept|ent|ade|old|ound)\b/i;
export function voice(html) {
  const article = (/<article class="doc prose seo-page">([\s\S]*?)<\/article>/.exec(html) || [null, html])[1]
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<table[\s\S]*?<\/table>/g, ' ').replace(/<(\w+)[^>]*class="[^"]*\bseo-boiler\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<section class="seo-sources"[\s\S]*?<\/section>/, ' ').replace(/<p class="[^"]*\bseo-answer\b[^"]*">[\s\S]*?<\/p>/g, ' ');
  const paras = [...article.matchAll(/<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/g)].map((m) => plain(m[1])).filter((t) => t.split(/\s+/).length > 3);
  const sentences = paras.flatMap((t) => t.split(/(?<=[.!?:])\s+(?=[a-z0-9"“(])/)).map((x) => x.trim()).filter((x) => x.split(/\s+/).length > 2);
  const n = (x) => x.split(/\s+/).length;
  return {
    avg: sentences.length ? sentences.reduce((a, x) => a + n(x), 0) / sentences.length : 0,
    longPara: paras.filter((t) => n(t) > 60),
    passive: sentences.length ? sentences.filter((x) => PASSIVE.test(x)).length / sentences.length : 0,
    filler: [...new Set((plain(article).match(new RegExp(FILLER.source, 'gi')) || []).map((x) => x.toLowerCase()))],
  };
}
const PLACEHOLDER = /\b(?:lorem|ipsum|todo|tbd|fixme|xxx+|placeholder|insert (?:here|link|name)|coming soon)\b|\[\s*(?:insert|link|source|citation needed)/i;

// today where the site is built, not in utc (an evening build in india is already tomorrow there)
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plain = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const words = (s) => s.toLowerCase().match(/[a-z0-9$€£%']+/g) || [];
// the article's own words: without the parts every page of its kind shares, the sidebar and the "on this page" list
export function ownText(html) {
  const article = (/<article class="doc prose seo-page">([\s\S]*?)<\/article>/.exec(html) || [null, html])[1];
  let out = article;
  for (let before; before !== out;) { before = out; out = out.replace(/<(\w+)[^>]*class="[^"]*\bseo-boiler\b[^"]*"[^>]*>(?:(?!<\1[\s>])[\s\S])*?<\/\1>/g, ' '); }
  return plain(out.replace(/<p class="crumb">[\s\S]*?<\/p>/, ' ').replace(/<section class="seo-sources"[\s\S]*?<\/section>/, ' '));
}
const shingles = (text, n = 5) => { const w = words(text), s = new Set(); for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' ')); return s; };
export function jaccard(a, b) { let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter || 1); }

const NEEDS = {
  integration: (r) => [r.routines?.length >= 3 || 'needs at least 3 routines', r.cannot?.length >= 3 || 'needs at least 3 things it cannot do', (r.app?.toolkit ? r.app.highlight?.length >= 6 : r.app?.intro?.length > 300) || 'needs 6 highlighted actions (or, with no toolkit, a long intro)'],
  compare: (r) => [r.compare?.rows?.length >= 6 || 'needs at least 6 comparison rows', r.compare?.rows?.every((row) => row.src?.length && row.cells?.length === r.compare.cols.length) || 'every comparison row needs a source and one cell per column', r.verdict?.them?.length >= 2 && r.verdict?.dusk?.length >= 2 || 'the verdict needs 2 reasons each way', r.sources?.length >= 3 || 'needs at least 3 sources'],
  usecase: (r) => [r.safeguards?.length >= 3 || 'needs at least 3 guard rails', r.routine?.message?.length > 60 || 'the routine message is too short'],
  role: (r) => [r.day?.length >= 4 || 'needs at least 4 moments in the day', r.pack?.length >= 3 || 'needs at least 3 routines'],
  routine: (r) => [r.knobs?.length >= 3 || 'needs at least 3 ways to make it yours', r.fails?.length >= 2 || 'needs at least 2 ways it goes wrong'],
  guide: (r) => [r.sections?.length >= 3 || 'needs at least 3 sections', (r.sources?.length >= 1) || 'needs at least 1 source'],
  glossary: () => [],
  action: (r) => [r.uses?.length >= 3 || 'needs at least 3 uses', r.steps?.length >= 3 || 'needs at least 3 steps', r.watch?.length >= 2 || 'needs at least 2 limits', r.routine?.message?.length > 80 || 'the routine message is too short', /^\/integrations\/[a-z0-9-]+\/[a-z0-9-]+$/.test(r.path) || 'an action lives at /integrations/<app>/<action>'],
  tool: (r) => [fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'tools', `${r.tool}.html`)) || `no seo/tools/${r.tool}.html`],
};

const planned = new Set(JSON.parse(fs.readFileSync(new URL('./planned.json', import.meta.url), 'utf8')).paths);
export function checkPages({ rendered, records, site, TYPES, hubPages, check = false }) {
  const problems = [], warnings = [];
  const today = localDay();
  // a draft only warns, except when it is the record being checked (seo/check.mjs)
  const checking = new Set((process.env.SEO_CHECK_ONLY || '').split(',').filter(Boolean));
  const say = (r, msg) => (r.state.status === 'draft' && !(check && checking.has(r.path)) ? warnings : problems).push(`${r.path}: ${msg}`);
  const exists = (at) => { const p = at.split(/[?#]/)[0].replace(/\/$/, '') || '/'; return records.some((o) => o.path === p) || Object.values(HUBS).some((h) => h.at === p) || ['/waitlist', '/download', '/pricing', '/about', '/docs', '/contact', '/security', '/privacy', '/terms', '/license', '/changelog', '/brand', '/'].includes(p) || fs.existsSync(path.join(site, p, 'index.html')) || fs.existsSync(path.join(site, p)); };
  const own = new Map();
  for (const { r, html } of rendered) {
    const type = TYPES[r.type];
    for (const field of ['title', 'h1', 'description', 'answer', 'keyword', ...type.needs]) if (r[field] === undefined || r[field] === '' || (Array.isArray(r[field]) && !r[field].length)) say(r, `missing ${field}`);
    for (const ok of NEEDS[r.kind](r)) if (ok !== true) say(r, ok);
    if (!r.updated) say(r, 'missing updated (the date the page was last checked)');
    else if (r.updated > today) say(r, `updated ${r.updated} is in the future`);
    // queued pages may wait for review (the release job skips them until approved); a page that is out must be approved
    if ((r.state.status === 'live' || r.state.status === 'noindex') && r.review?.status !== 'approved') say(r, `is ${r.state.status} but its review is "${r.review?.status || 'none'}"; only approved pages go out`);
    if (r.title && (r.title.length < 30 || r.title.length > 65)) say(r, `title is ${r.title.length} characters (30 to 65)`);
    if (r.description && (r.description.length < 70 || r.description.length > 160)) say(r, `description is ${r.description.length} characters (70 to 160)`);
    const answer = words(plain(r.answer || '')).length;
    if (answer < 35 || answer > 90) say(r, `the answer is ${answer} words (40 to 80, 35 to 90 allowed)`);
    const h1s = (html.match(/<h1[\s>]/g) || []).length;
    if (h1s !== 1) say(r, `${h1s} h1 headings`);
    for (const img of html.match(/<img\b[^>]*>/g) || []) {
      if (!/\salt="/.test(img)) say(r, `a picture without alt: ${img.slice(0, 80)}`);
      if (!/\swidth="\d+"/.test(img) || !/\sheight="\d+"/.test(img)) say(r, `a picture without width and height: ${img.slice(0, 80)}`);
    }
    if (!/<figure class="seo-hero"><img [^>]*alt="[^"]{20,}"/.test(html)) say(r, 'the hero picture needs real alt text');
    const id = sceneId(r.path);
    if (!check) for (const f of [`art/seo/${id}.webp`, `art/seo/${id}-660.webp`]) if (!fs.existsSync(path.join(site, f))) say(r, `no ${f} (run: node seo/art/scenes.mjs && python3 seo/art/render.py)`);
    const text = plain(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, ''));
    const json = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []).map((s) => s.replace(/<\/?script[^>]*>/g, ''));
    for (const j of json) { try { JSON.parse(j); } catch { say(r, 'structured data that does not parse'); } }
    if (/—/.test(html) || /—/.test(JSON.stringify(r))) say(r, 'has an em dash');
    const m = PLACEHOLDER.exec(text); if (m) say(r, `placeholder text: "${m[0]}"`);
    for (const [re, why] of SUBSCRIPTION) { const hit = re.exec(text) || re.exec(r.title || ''); if (hit) say(r, `${why}: "${hit[0]}" (see SUBSCRIPTION in seo/quality.mjs)`); }
    for (const s of r.sources || []) if (!s.url.startsWith('/') && !s.checked) say(r, `source "${s.label}" has no checked date`);
    for (const [, at] of ((/<article[\s\S]*<\/article>/.exec(html) || [''])[0]).matchAll(/<a href="(\/[^"]*)"/g)) if (!exists(at.replace(/&amp;/g, '&'))) {
      if (check && planned.has(at.split(/[?#]/)[0])) continue;
      say(r, planned.has(at.split(/[?#]/)[0]) ? `links to ${at}, which is planned but has no record yet` : `links to ${at}, which is not on the site and not in seo/planned.json`);
    }
    const v = voice(html), strict = r.voice === 2, vsay = (msg) => (strict ? say(r, msg) : warnings.push(`${r.path}: voice: ${msg}`));
    if (v.filler.length) vsay(`filler or hype words: ${v.filler.join(', ')}`);
    const counted = /\b(?:two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?:focused\s+|small\s+|ai\s+|pixel\s+|overlapping\s+)?(?:bots?|bot computers?|helpers?|desktops?|participants?|agents?|members?)\b|\b\d+\s+(?:focused\s+|small\s+)?(?:bots?|bot computers?)\b|\b\d+\s+awake\b|awake at once|plus \d+, pro \d+|group of (?:two|three|four|five|six|eight|\d+)/i.exec(ownText(html.replace(/<pre[\s\S]*?<\/pre>/g, ' ')));
    if (counted) vsay(`counts bots ("${counted[0]}"); say a good amount, heavy workloads or a few instead`);
    const checks = (ownText(html).match(/\bcheck(?:s)?\b(?! out)/gi) || []).length;
    if (checks > 6) vsay(`says "check" ${checks} times; say what to look for instead`);
    if (v.avg > 17) vsay(`sentences average ${v.avg.toFixed(1)} words (keep it under 17)`);
    if (v.longPara.length) vsay(`${v.longPara.length} paragraph(s) over 60 words, e.g. "${v.longPara[0].slice(0, 70)}..."`);
    if (v.passive > 0.15) vsay(`${Math.round(v.passive * 100)}% of sentences are passive (keep it under 15%)`);
    const mine = ownText(html), n = words(mine).length;
    if (n < type.words) say(r, `${n} words of its own (needs ${type.words})`);
    if (r.state.status !== 'draft') own.set(r, shingles(mine));
  }
  // titles, descriptions and h1s are each one page's own
  for (const field of ['title', 'description', 'h1']) {
    const seen = new Map();
    for (const r of records) { const v = (r[field] || '').toLowerCase(); if (!v) continue; if (seen.has(v)) problems.push(`${r.path} and ${seen.get(v)} share a ${field}`); seen.set(v, r.path); }
  }
  // no two pages too alike. pages are compared within their kind and with every page that shares an app, which is where
  // near-copies come from; that keeps the check fast at thousands of pages (all pairs would be millions)
  const FAIL = 0.4, WARN = 0.25;
  const list = [...own.entries()], buckets = new Map();
  const put = (key, i) => { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(i); };
  list.forEach(([r], i) => { put(`kind:${r.kind}`, i); for (const c of r.connectors || []) put(`app:${c}`, i); });
  const done = new Set();
  for (const ids of buckets.values()) for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) {
    const i = ids[x], j = ids[y], key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (done.has(key)) continue; done.add(key);
    const sim = jaccard(list[i][1], list[j][1]);
    if (sim > FAIL) problems.push(`${list[i][0].path} and ${list[j][0].path} are ${Math.round(sim * 100)}% alike (word 5-grams); merge them or give one more of its own`);
    else if (sim > WARN) warnings.push(`${list[i][0].path} and ${list[j][0].path} are ${Math.round(sim * 100)}% alike`);
  }
  for (const { h, html } of hubPages) {
    if ((html.match(/<h1[\s>]/g) || []).length !== 1) problems.push(`${h.at}: not exactly one h1`);
    if (/—/.test(html)) problems.push(`${h.at}: has an em dash`);
    for (const f of [`art/seo/${sceneId(h.at)}.webp`]) if (!fs.existsSync(path.join(site, f))) problems.push(`${h.at}: no ${f} (run python3 seo/art/render.py)`);
  }
  return { problems, warnings };
}
