// the seo pages, built by build-pages.mjs after the rest of the site. renders every record (live ones are written, queued
// ones only checked, unless SEO_PREVIEW=1), the hubs that have live pages, each page's art scene (seo/art/scenes.json,
// photographed by seo/art/render.py), and runs the quality gate (seo/quality.mjs), which stops the build on any failure.
// returns what the sitemaps, the footer and the server need.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { plan, seoDir, HUBS, TYPES } from './records.mjs';
import { templates, connector, day } from './templates.mjs';
import { scene, sceneHtml, signature, altText, sceneId, PROPS } from './art/scene.mjs';
const webpDims = (file) => { const b = fs.readFileSync(file), k = b.toString('ascii', 12, 16); if (k === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)]; if (k === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff]; const n = b.readUInt32LE(21); return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)]; };
import { checkPages } from './quality.mjs';

// the footer's links to the hubs, read before any page is written. live hubs only, so it never points at nothing
export function seoFooter() {
  const { hubs } = plan({ preview: false });
  return hubs.map((h) => [h.at, h.nav]);
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// every scene, kept unique: a page whose picture would repeat another's gets a salted one
export function buildScenes(records, kitDir) {
  const seen = new Map(), out = [];
  const hubRecords = Object.values(HUBS).map((h) => ({ path: h.at, kind: 'guide', h1: h.h1, og_line: h.lede.split('. ')[0].replace(/\.$/, '') + '.', art: h.art }));
  for (const r of [...hubRecords, ...records]) {
    let s, salt = '';
    for (let n = 0; n < 50; n++) { s = scene(r, kitDir, salt); if (!seen.has(signature(s))) break; salt = `#${n + 1}`; }
    seen.set(signature(s), r.path);
    s.alt = altText(s);
    out.push(s);
  }
  return out;
}

// the scene for every page and hub, laid out for render.py in seo/art/scenes.json; sets each page's alt text
export function writeScenes(site, records) {
  const kitDir = path.join(site, 'art');
  const scenes = buildScenes(records, kitDir);
  const byScene = new Map(scenes.map((s) => [s.path, s]));
  for (const r of records) r.alt = r.alt || byScene.get(r.path).alt;
  for (const h of Object.values(HUBS)) h.alt = byScene.get(h.at).alt;
  const fileUrl = (f) => 'file://' + f;
  const art = { base: fileUrl(kitDir) + '/', font: fileUrl(path.join(site, 'fonts', 'general-sans.woff2')), mark: fileUrl(path.join(kitDir, 'mark-320.webp')) };
  const out = scenes.map((s) => { const hero = sceneHtml(s, 'hero', art); return { id: s.id, path: s.path, alt: s.alt, hash: hash(hero), hero }; });
  fs.writeFileSync(path.join(seoDir, 'art', 'scenes.json'), JSON.stringify(out));
  return scenes;
}

// the og6 cards (art-src/og6) that take over a seo page or hub, by address
// every seo page's and hub's share card (art-src/og6), by address; a page without a drawn one stops the build
function og6Cards(site) {
  const list = JSON.parse(fs.readFileSync(path.join(seoDir, 'art', 'og6.json'), 'utf8'));
  const cards = new Map(list.filter((c) => c.seo).map((c) => [c.seo, { image: `/art/og6/${c.id}.jpg`, alt: c.alt, file: path.join(site, 'art', 'og6', `${c.id}.jpg`) }]));
  return (at) => { const c = cards.get(at); if (!c) throw new Error(`${at}: no share card (art-src/og6/cards.mjs)`); if (!fs.existsSync(c.file)) throw new Error(`${at}: share card not drawn (python3 art-src/og6/render.py)`); return c; };
}

export function buildSeo(ctx) {
  const { site, layout, write, SITE_URL, release: downloads } = ctx;
  const p = plan();
  const { config, records, hubs, preview } = p;
  // integration pages carry the catalog they were built from as a source
  for (const r of records) if (r.kind === 'action') {
    const app = records.find((o) => o.kind === 'integration' && o.app?.toolkit === r.action.toolkit);
    if (app) r.parent = { path: app.path, nav: app.nav || app.h1 };
  }
  for (const r of records) if ((r.kind === 'integration' && r.app?.toolkit) || r.kind === 'action') {
    const f = connector(r.kind === 'action' ? r.action.toolkit : r.app.toolkit);
    r.sources = [...(r.sources || []).filter((s) => s.url !== f.source), { label: `composio, ${f.name} toolkit (catalog version ${f.version})`, url: f.source, checked: f.fetched_at }];
  }
  const scenes = writeScenes(site, records);
  const og6 = og6Cards(site);
  const mode = config.cta.mode === 'auto' ? (downloads.released ? 'download' : 'waitlist') : config.cta.mode;
  // the waitlist link carries the page that sent people, and goes straight home when the waitlist is the home page
  const cta = { ...config.cta[mode], ...(mode === 'waitlist' ? { source: true, ...(ctx.waitlistHome ? { href: '/' } : {}) } : {}) };
  const byPath = new Map(records.map((r) => [r.path, r]));
  // each kit object's size, for the spot pictures
  const kitSizes = Object.fromEntries(Object.keys(PROPS).map((k) => { const f = path.join(site, 'art', k.startsWith('p-') ? `kit/${k}.webp` : `${k}.webp`); return [k, fs.existsSync(f) ? webpDims(f) : [420, 420]]; }));
  const plannedPaths = new Set(JSON.parse(fs.readFileSync(path.join(seoDir, 'planned.json'), 'utf8')).paths);
  const t = templates({ ...ctx, records, byPath, config, cta, preview, hubs, kitSizes, plannedPaths });
  const crumb = (list) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: list.map(([name, at], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE_URL}${at}` })) });
  const org = { '@type': 'Organization', name: 'Metal', url: `${SITE_URL}/`, logo: `${SITE_URL}/art/icon-512.png` };

  // every record is rendered, so queued pages pass the same gate before their day comes
  const rendered = [];
  for (const r of records) {
    const { body, related } = t.page(r);
    const hub = HUBS[r.hub];
    const updated = r.updated || r.verified;
    const jsonld = [crumb([['Metal', '/'], [hub.nav[0].toUpperCase() + hub.nav.slice(1), hub.at], ...(r.parent ? [[r.parent.nav, r.parent.path]] : []), [r.nav || r.h1, r.path]]),
      { '@context': 'https://schema.org', '@type': 'Article', headline: r.h1, description: r.description, image: `${SITE_URL}/art/seo/${sceneId(r.path)}.webp`,
        datePublished: r.state.live_at || r.created || updated, dateModified: updated, author: org, publisher: org, mainEntityOfPage: `${SITE_URL}${r.path}` }];
    const html = layout({ title: r.title, description: r.description, body, page: r.path.slice(1), at: r.path, section: r.hub, kind: `p-doc p-seo p-seo-${r.kind}`,
      og: 'seo', ogImage: og6(r.path).image, ogType: 'article', ogAlt: og6(r.path).alt, scripts: r.kind === 'tool' ? [`tools/${r.tool}.js`] : [], styles: ['seo.css'], jsonld, noindex: !r.indexable });
    rendered.push({ r, html, related });
  }
  // a hub with only a page or two is a thin list, so it stays out of search until it has three
  const hubIndexable = (pages) => pages.filter((o) => o.indexable).length >= 3;
  const hubPages = hubs.map((h) => {
    const { body, pages } = t.hubPage(h);
    const html = layout({ title: h.title, description: h.description, body, page: h.id, at: h.at, section: h.id, kind: 'p-seo-hub', og: 'seo', ogImage: og6(h.at).image, ogAlt: og6(h.at).alt,
      styles: ['seo.css'], jsonld: [crumb([['Metal', '/'], [h.nav[0].toUpperCase() + h.nav.slice(1), h.at]])], noindex: !hubIndexable(pages) });
    return { h, html, pages };
  });

  // the gate: every non-draft page must pass, drafts only warn
  const check = process.env.SEO_CHECK === '1';
  const { problems, warnings } = checkPages({ rendered, records, site, seoDir, TYPES, hubPages, scenes, check });
  // SEO_CHECK=1: report and stop, without writing any seo page (seo/check.mjs runs this for one or more records)
  if (check) {
    const only = (process.env.SEO_CHECK_ONLY || '').split(',').filter(Boolean);
    const mine = (line) => !only.length || only.some((at) => line.startsWith(`${at}:`) || line.includes(` ${at} `) || line.startsWith(`${at} `));
    const shown = problems.filter(mine), notes = warnings.filter(mine);
    for (const w of notes) console.log(`warning: ${w}`);
    for (const p of shown) console.log(`problem: ${p}`);
    console.log(shown.length ? `${shown.length} problems` : 'all checks pass');
    process.exit(shown.length ? 1 : 0);
  }
  for (const w of warnings) console.warn(`seo warning: ${w}`);
  if (problems.length) throw new Error(`the seo quality gate failed:\n  ${problems.join('\n  ')}`);

  // a page or hub that is not out must not be on disk either (a preview build, or a page set back to queued, leaves one)
  const unwrite = (at) => { const file = path.join(site, at, 'index.html'); if (fs.existsSync(file)) { fs.rmSync(file); try { fs.rmdirSync(path.dirname(file)); } catch {} } };
  for (const r of records) if (!r.built) unwrite(r.path);
  // and addresses whose record is gone (a page rejected or removed after a preview build wrote it)
  const rejectedFile = path.join(seoDir, 'action-rejected.json');
  const gonePaths = [...JSON.parse(fs.readFileSync(path.join(seoDir, 'planned.json'), 'utf8')).paths, ...Object.keys(fs.existsSync(rejectedFile) ? JSON.parse(fs.readFileSync(rejectedFile, 'utf8')).paths : {})];
  for (const at of gonePaths) if (!byPath.has(at)) unwrite(at);
  for (const h of Object.values(HUBS)) if (!hubs.some((x) => x.at === h.at)) unwrite(h.at);
  for (const { r, html } of rendered) if (r.built) write(r.path, html, { index: r.indexable, group: r.state.cohort, lastmodKey: hash(JSON.stringify({ ...r, state: undefined, alt: undefined })) });
  for (const { h, html, pages } of hubPages) write(h.at, html, { index: hubIndexable(pages), group: 'hubs' });

  // pruned pages: merged ones send people on, removed ones answer 410
  const redirects = {}, gone = [];
  for (const r of records) if (r.state.status === 'pruned') { if (r.state.to) redirects[r.path] = r.state.to; else gone.push(r.path); }
  // the folders without an index page of their own
  if (hubs.some((h) => h.id === 'alternatives')) redirects['/vs'] = '/alternatives#comparisons';
  if (hubs.some((h) => h.id === 'use-cases')) redirects['/for'] = '/use-cases#by-role';
  const live = records.filter((r) => r.indexable).length;
  console.log(`seo: ${live} live, ${records.filter((r) => r.state.status === 'queued').length} queued, ${records.filter((r) => r.state.status === 'draft').length} draft; ${hubPages.length} hubs; call to action: ${mode}${preview ? '; preview build, queued pages written with noindex' : ''}`);
  return { redirects, gone, cohorts: p.release.cohorts };
}
export { day };
