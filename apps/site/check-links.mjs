// crawls the built site (public/landing) and fails on any internal link, picture, script, stylesheet or font that leads
// nowhere, and on any #anchor that is not on the page it points at. zero deps.
//   node check-links.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'public', 'landing');
const redirects = JSON.parse(fs.readFileSync(path.join(root, '_redirects.json'), 'utf8'));
// files that deploy.sh and publish-downloads.sh put on the site, so they are not in the repo
const AT_DEPLOY = [/^\/install\.sh(\.sha256)?$/, /^\/releases\//];
// the account app (DUSK_APP_URL, the same default as build-pages.mjs) and its api are served beside the site on the same origin
const APP_PATH = (process.env.DUSK_APP_URL || '/dashboard').replace(/\/+$/, '');
const ELSEWHERE = APP_PATH.startsWith('/') ? [APP_PATH, '/v1'] : ['/v1'];
const servedElsewhere = (p) => ELSEWHERE.some((pre) => p === pre || p.startsWith(`${pre}/`));
// the app's own interface is built elsewhere and checked there
const SKIP_DIRS = new Set(['demo']);

const pages = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!(dir === root && SKIP_DIRS.has(entry.name))) walk(path.join(dir, entry.name)); } else if (/\.(html|css|webmanifest)$/.test(entry.name)) pages.push(path.join(dir, entry.name));
  }
})(root);

const addressOf = (file) => '/' + path.relative(root, file).replace(/(^|\/)index\.html$/, '').replace(/\/$/, '');
const fileFor = (urlPath) => {
  let file = path.join(root, decodeURIComponent(urlPath));
  if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) file = path.join(file, 'index.html');
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
};
const ids = new Map();
const idsIn = (file) => { if (!ids.has(file)) ids.set(file, new Set([...fs.readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))); return ids.get(file); };

const problems = [];
let checked = 0;
for (const file of pages) {
  const src = fs.readFileSync(file, 'utf8'), from = addressOf(file) || '/';
  const refs = file.endsWith('.html')
    ? [...src.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '').matchAll(/\s(?:href|src|data-index|data-windows|data-linux)="([^"]+)"/g)].map((m) => m[1])
        .concat([...src.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0])))
    : file.endsWith('.css') ? [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1])
      : [...src.matchAll(/"src":\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const raw of refs) {
    const ref = raw.replace(/&amp;/g, '&');
    if (/^(https?:|mailto:|data:|tel:|duskbot:)/.test(ref)) continue;
    checked++;
    const [beforeHash, hash] = ref.split('#');
    const urlPath = beforeHash.split('?')[0];
    let target = urlPath === '' ? file : null, to = urlPath;
    if (urlPath !== '') {
      if (!urlPath.startsWith('/')) { problems.push(`${from}: "${ref}" is not an absolute path`); continue; }
      if (AT_DEPLOY.some((re) => re.test(urlPath)) || servedElsewhere(urlPath)) continue;
      target = fileFor(urlPath);
      if (!target && redirects[urlPath.replace(/\/+$/, '')]) { to = redirects[urlPath.replace(/\/+$/, '')].split('#')[0]; target = fileFor(to); }
      if (!target) { problems.push(`${from}: ${ref} leads nowhere`); continue; }
    }
    if (hash && target.endsWith('.html') && !idsIn(target).has(decodeURIComponent(hash))) problems.push(`${from}: ${ref} has no #${hash} on ${to || from}`);
  }
}
// every redirect must land on something, and every page in the sitemap must exist
for (const [short, to] of Object.entries(redirects)) {
  const [p, hash] = to.split('#'), target = fileFor(p);
  if (!target) problems.push(`redirect ${short} goes to ${to}, which is not there`);
  else if (hash && !idsIn(target).has(hash)) problems.push(`redirect ${short} goes to ${to}, but that page has no #${hash}`);
}
// the sitemap index and each sitemap in it: every page listed is there, says it is its own canonical, and is not noindex
const locs = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)].map((m) => m[1] || '/');
const listed = new Set();
for (const at of locs(path.join(root, 'sitemap.xml'))) {
  const file = fileFor(at);
  if (!file) { problems.push(`sitemap lists ${at}, which is not there`); continue; }
  if (!at.endsWith('.xml')) { listed.add(at); continue; }
  for (const page of locs(file)) {
    const html = fileFor(page);
    if (!html) { problems.push(`${at} lists ${page}, which is not there`); continue; }
    listed.add(page);
    const src = fs.readFileSync(html, 'utf8');
    if (/<meta name="robots" content="[^"]*noindex/.test(src)) problems.push(`${at} lists ${page}, which says noindex`);
    const canon = /<link rel="canonical" href="https?:\/\/[^/]+([^"]*)">/.exec(src)?.[1];
    if (canon !== undefined && (canon || '/') !== page) problems.push(`${page} is in ${at} but its canonical is ${canon}`);
  }
}
// every seo page (seo/) that is live needs at least three other pages linking to it, besides the footer
const inbound = new Map();
for (const file of pages.filter((f) => f.endsWith('.html'))) {
  const from = addressOf(file) || '/', src = fs.readFileSync(file, 'utf8').replace(/<footer[\s\S]*<\/footer>/, '');
  for (const at of new Set([...src.matchAll(/\shref="(\/[^"#?]*)/g)].map((m) => m[1].replace(/\/$/, '') || '/'))) if (at !== from) inbound.set(at, (inbound.get(at) || 0) + 1);
}
for (const file of pages.filter((f) => f.endsWith('.html'))) {
  const at = addressOf(file) || '/', src = fs.readFileSync(file, 'utf8');
  if (!/<main id="main" class="inner p-doc p-seo\b/.test(src) || !listed.has(at)) continue;
  if ((inbound.get(at) || 0) < 3) problems.push(`${at} has ${inbound.get(at) || 0} pages linking to it (needs 3)`);
}

// structured data: every block parses, says what it is, and has what google needs for its type, with absolute addresses
const abs = (u) => typeof u === 'string' && /^(?:https:\/\/[^/]+|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)\//.test(u);
const isoDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d);
let blocks = 0;
for (const file of pages.filter((f) => f.endsWith('.html'))) {
  const at = addressOf(file) || '/';
  for (const [, raw] of fs.readFileSync(file, 'utf8').matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    blocks++;
    let d; try { d = JSON.parse(raw); } catch { problems.push(`${at}: structured data that does not parse`); continue; }
    const bad = (why) => problems.push(`${at}: ${d['@type']} ${why}`);
    if (d['@context'] !== 'https://schema.org' || !d['@type']) { problems.push(`${at}: structured data without @context or @type`); continue; }
    if (d['@type'] === 'BreadcrumbList') {
      const items = d.itemListElement || [];
      if (items.length < 2) bad('has fewer than 2 items');
      items.forEach((it, i) => { if (it.position !== i + 1 || !it.name || !abs(it.item)) bad(`item ${i + 1} needs position ${i + 1}, a name and an absolute item`); });
    } else if (d['@type'] === 'Article') {
      if (!d.headline || d.headline.length > 110) bad('needs a headline of at most 110 characters');
      if (!abs(d.image)) bad('needs an absolute image');
      if (!isoDay(d.datePublished) || !isoDay(d.dateModified) || d.dateModified < d.datePublished) bad('needs datePublished and a dateModified not before it');
      if (!d.author?.name || !d.publisher?.name) bad('needs an author and a publisher');
    } else if (d['@type'] === 'Organization') {
      if (!d.name || !abs(d.url) || !abs(d.logo)) bad('needs a name, url and logo');
    } else if (d['@type'] === 'SoftwareApplication') {
      if (!d.name || !d.offers || d.offers.price === undefined) bad('needs a name and an offer with a price');
      if (d.aggregateRating || d.review) bad('carries ratings or reviews; only real ones may ever go here');
    } else if (d['@type'] === 'FAQPage') {
      if (!(d.mainEntity || []).length) bad('has no questions');
    } else problems.push(`${at}: structured data of a type this check doesn't know (${d['@type']}); add a rule for it`);
  }
}
console.log(`structured data: ${blocks} blocks checked`);

// share cards: every page names a card that is on disk, at the size it says, under 150 kb, with alt text and an x card
let cards = 0;
const jpegSize = (b) => { for (let i = 2; i < b.length;) { const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + len; } return null; };
for (const file of pages.filter((f) => f.endsWith('.html') && !servedElsewhere(addressOf(f)))) {
  const at = addressOf(file) || '/', src = fs.readFileSync(file, 'utf8');
  if (!/<meta property="og:title"/.test(src)) continue;
  const metas = [...src.matchAll(/<meta (?:property|name)="((?:og|twitter):[\w:]+)" content="([^"]*)">/g)].map((m) => [m[1], m[2]]);
  const get = (k) => metas.filter(([n]) => n === k).map(([, v]) => v);
  if (get('twitter:card')[0] !== 'summary_large_image') problems.push(`${at}: twitter:card is not summary_large_image`);
  if (!get('twitter:image')[0] || get('twitter:image')[0] !== get('og:image')[0]) problems.push(`${at}: twitter:image is missing or not the first og:image`);
  const images = get('og:image'), widths = get('og:image:width'), heights = get('og:image:height'), alts = get('og:image:alt');
  if (!images.length || widths.length !== images.length || heights.length !== images.length || alts.length !== images.length) { problems.push(`${at}: each og:image needs its width, height and alt`); continue; }
  images.forEach((url, i) => {
    cards++;
    const p = abs(url) ? new URL(url).pathname : '', f = p && fileFor(p);
    if (!f) return problems.push(`${at}: og:image ${url} is not on the site`);
    const b = fs.readFileSync(f), size = jpegSize(b);
    if (!size || `${size[0]}x${size[1]}` !== `${widths[i]}x${heights[i]}`) problems.push(`${at}: og:image ${p} is ${size?.join('x')}, the tags say ${widths[i]}x${heights[i]}`);
    if (b.length > 150 * 1024) problems.push(`${at}: og:image ${p} is ${Math.round(b.length / 1024)} kb, over 150`);
  });
}
console.log(`share cards: ${cards} checked`);

if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} broken, ${checked} links checked in ${pages.length} files`); process.exit(1); }
console.log(`all good: ${checked} links in ${pages.length} files, ${Object.keys(redirects).length} redirects`);
