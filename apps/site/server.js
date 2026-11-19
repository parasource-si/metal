// tiny static server for the dusk.bot placeholder sites. zero deps.
// usage: node server.js <site>   (serves public/<site>/ on process.env.PORT)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { openStore } from './waitlist-store.js';
import { openMongoStore } from './waitlist-mongo.js';
import { emailFromToken } from './unsubscribe.js';
import { serveMirrored, serveVoiceModel } from './release-mirror.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = process.argv[2] || 'landing';
if (!/^[a-z0-9-]+$/.test(site)) throw new Error(`bad site name ${site}`);
const root = path.join(here, 'public', site);
// a one-page site (the waitlist on dusk.bot before launch): every page address that is not there goes home
const HOME_ONLY = process.env.DUSK_HOME_ONLY === '1';
// a staging copy (preview) is never indexed: search engines only see dusk.bot
const NO_INDEX = process.env.DUSK_NO_INDEX === '1';
if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no such site: ${root}`);
const port = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function resolveFile(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  // a name that starts with _ is the build's note to this server (the redirects), not something to serve
  if (rel.includes('\0') || rel === '/_redirects.json' || rel === '/_gone.json') return null;
  let file = path.join(root, path.normalize(rel));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (st?.isDirectory()) file = path.join(file, 'index.html');
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
}

// seo pages taken down for good (seo/release.json status pruned, with nowhere to send people), listed by the build in
// _gone.json and answered 410 so search engines drop them; read again when it changes
let gone = { at: 0, set: new Set() };
function isGone(urlPath) {
  const file = path.join(root, '_gone.json'), at = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs || 0;
  if (at !== gone.at) { try { gone = { at, set: new Set(at ? JSON.parse(fs.readFileSync(file, 'utf8')) : []) }; } catch { gone = { at, set: new Set() }; } }
  return gone.set.has(urlPath.length > 1 ? urlPath.replace(/\/+$/, '').toLowerCase() : urlPath);
}

// short and old addresses the build listed in _redirects.json, each with the page that answers it; read again when it changes
let redirects = { at: 0, map: {} };
function redirectFor(urlPath) {
  const file = path.join(root, '_redirects.json'), at = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs || 0;
  if (at !== redirects.at) { try { redirects = { at, map: at ? JSON.parse(fs.readFileSync(file, 'utf8')) : {} }; } catch { redirects = { at, map: {} }; } }
  const key = urlPath.length > 1 ? urlPath.replace(/\/+$/, '').toLowerCase() : urlPath;
  return Object.hasOwn(redirects.map, key) ? redirects.map[key] : null;
}

// the waitlist (landing only): POST /api/waitlist takes {email, source?, ref?, website?}, GET /api/waitlist/count.
// signups go to mongodb (waitlist-mongo.js) when MONGODB_URI is set (database MONGODB_DB, default dusk); otherwise to
// waitlist-store.js, a jsonl file at DUSK_WAITLIST_FILE (default data/waitlist.jsonl here)
const waitlistFile = path.resolve(here, process.env.DUSK_WAITLIST_FILE || 'data/waitlist.jsonl');
if (waitlistFile.startsWith(path.join(here, 'public') + path.sep)) throw new Error('DUSK_WAITLIST_FILE must not be inside public/');
const store = site !== 'landing' ? null
  : process.env.MONGODB_URI ? openMongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'dusk') : openStore(waitlistFile);
if (store) console.log(`waitlist: stored in ${process.env.MONGODB_URI ? 'mongodb' : 'a jsonl file'}`);
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const JUNK = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la', '10minutemail.com', 'temp-mail.org',
  'tempmail.com', 'tempmail.dev', 'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'throwawaymail.com', 'maildrop.cc',
  'fakeinbox.com', 'mailnesia.com', 'mintemail.com', 'example.com', 'example.org', 'example.net', 'test.com']);
const WAIT_MSG = {
  bad_email: "that doesn't look like an email address. check it for a typo and try again.",
  junk_email: "throwaway inboxes can't join. use one you'll still check when we write.",
  too_many: 'too many tries from here. wait a minute and try again.',
  too_many_today: 'a lot of people joined from this network today. try again tomorrow.',
  too_large: 'that request was too big. reload the page and try again.',
  bad_request: 'something was off with that request. reload the page and try again.',
  not_json: 'this address only takes json.',
  server: "we couldn't save that just now. try again in a minute.",
};
// twenty tries a minute per address (people share one behind carrier nat or an office); behind cloudflare the visitor is in CF-Connecting-IP, else nginx's X-Real-IP (this server only listens on loopback)
const tries = new Map();
function tooMany(ip) {
  const now = Date.now(), recent = (tries.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now); tries.set(ip, recent);
  if (tries.size > 5000) for (const [k, v] of tries) if (now - v[v.length - 1] > 60_000) tries.delete(k);
  return recent.length > 20;
}
// and a generous day's cap on new joins per network (DUSK_WAITLIST_PER_IP_DAY, default 200), so a script cannot fill the list
// with made-up addresses; an ipv6 caller counts by its /64. the count starts over each utc day
const PER_DAY = Math.max(1, Number(process.env.DUSK_WAITLIST_PER_IP_DAY) || 200);
let joins = { day: '', map: new Map() };
function netOf(ip) {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4 || !ip.includes(':')) return v4 ? v4[1] : ip;
  const [head, tail] = ip.split('::'), h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}
function joinsToday(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (joins.day !== day || joins.map.size > 100_000) joins = { day, map: new Map() };
  return { key: netOf(ip), get count() { return joins.map.get(this.key) || 0; }, add() { joins.map.set(this.key, this.count + 1); } };
}
// a new signup also goes on the brevo list when BREVO_API_KEY and BREVO_WAITLIST_LIST_ID are set. fire and forget:
// network errors, 429 and 5xx are retried twice, other answers are final; failures only log, never the email
function addToBrevo(email, meta, attempt = 0) {
  const key = process.env.BREVO_API_KEY, list = Number(process.env.BREVO_WAITLIST_LIST_ID);
  if (!key || !list) return;
  const attributes = { POSITION: meta.position, SIGNED_UP_AT: new Date().toISOString().slice(0, 10) };
  if (meta.source) attributes.SOURCE = meta.source;
  const retry = (why) => {
    if (attempt < 2) return void setTimeout(() => addToBrevo(email, meta, attempt + 1), 1000 * 3 ** attempt).unref();
    console.warn(`waitlist: brevo gave up on #${meta.position} (${why})`);
  };
  fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, listIds: [list], updateEnabled: true, attributes }),
  }).then((r) => {
    if (r.ok) return;
    if (r.status === 429 || r.status >= 500) return retry(r.status);
    console.warn(`waitlist: brevo answered ${r.status} for #${meta.position}`);
  }, (err) => retry(err.name));
}
const clean = (v, max = 64) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max).replace(/[^\w .:/@-]/g, '') || null : null);
const sendJson = (res, status, data, extra = {}) => { const body = JSON.stringify(data); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra }); res.end(body); };
const fail = (res, status, error) => sendJson(res, status, { ok: false, error, message: WAIT_MSG[error] });

function waitlist(req, res, urlPath) {
  if (urlPath === '/api/waitlist/count') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method' }, { Allow: 'GET, HEAD' });
    return store.count().then((count) => sendJson(res, 200, { count }, { 'Cache-Control': 'public, max-age=60' }), (err) => { console.error('waitlist: count failed:', err?.codeName || err?.message); return fail(res, 500, 'server'); });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' }, { Allow: 'POST' });
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '');
  if (tooMany(ip)) return fail(res, 429, 'too_many');
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return fail(res, 415, 'not_json'); }
  if (Number(req.headers['content-length']) > 2048) { res.setHeader('Connection', 'close'); req.resume(); return fail(res, 413, 'too_large'); }
  const chunks = []; let size = 0, done = false;
  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > 2048) { done = true; res.setHeader('Connection', 'close'); fail(res, 413, 'too_large'); req.resume(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (done) return;
    done = true;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(res, 400, 'bad_request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'bad_request');
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL.test(email) || email.split('@')[0].length > 64) return fail(res, 400, 'bad_email');
    if (JUNK.has(email.split('@')[1])) return fail(res, 400, 'junk_email');
    // a filled honeypot is a form-filling robot: it hears yes and nothing is kept
    if (typeof body.website === 'string' && body.website.trim()) return sendJson(res, 200, { ok: true, position: (await store.count()) + 1 });
    const today = joinsToday(ip);
    if (today.count >= PER_DAY) return fail(res, 429, 'too_many_today');
    const ua = req.headers['user-agent'] ? createHash('sha256').update(String(req.headers['user-agent'])).digest('hex').slice(0, 12) : null;
    const meta = { source: clean(body.source), ref: clean(body.ref), ua };
    try {
      const { position, existing } = await store.add(email, meta);
      if (!existing) today.add();
      if (!existing) { console.log(`waitlist: #${position} joined${meta.source ? ` from ${meta.source}` : ''}`); addToBrevo(email, { ...meta, position }); }
      sendJson(res, existing ? 200 : 201, { ok: true, position, already: existing });
    } catch (err) {
      console.error(`waitlist: could not save (${err.code || err.name})`);
      fail(res, 500, 'server');
    }
  });
  req.on('error', () => { done = true; });
}

// /unsubscribe?t=<token> from the news emails: GET shows a page, POST is the one-click answer to List-Unsubscribe-Post
// (rfc 8058). both mark the waitlist entry unsubscribed; nothing is deleted
const UNSUB_SECRET = process.env.DUSK_UNSUBSCRIBE_SECRET || '';
if (store && !UNSUB_SECRET) console.warn('unsubscribe: DUSK_UNSUBSCRIBE_SECRET is not set, every link reads as invalid');
const htmlEsc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function unsubscribePage(title, text) {
  const shell = resolveFile('/404.html');
  const section = `<section class="lost wrap">\n  <h1>${htmlEsc(title)}</h1>\n  <p>${htmlEsc(text)}</p>\n  <p class="actions"><a class="btn dark" href="/">go home</a></p>\n</section>`;
  if (shell) {
    const page = fs.readFileSync(shell, 'utf8');
    const out = page.replace(/<title>[^<]*<\/title>/, `<title>${htmlEsc(title)} / Metal</title>`)
      .replace(/<section class="lost wrap">[\s\S]*?<\/section>/, section);
    if (out !== page) return out;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${htmlEsc(title)} / Metal</title><link rel="stylesheet" href="/site.css"></head><body><main id="main" class="inner">${section}</main></body></html>`;
}
async function unsubscribe(req, res) {
  const post = req.method === 'POST';
  if (!post && req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD, POST', 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('method not allowed\n'); }
  if (post) req.resume();
  const answer = (status, title, text) => {
    const body = post ? `${title}\n` : unsubscribePage(title, text);
    res.writeHead(status, { 'Content-Type': post ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const email = emailFromToken(UNSUB_SECRET, new URL(req.url || '/', 'http://x').searchParams.get('t'));
  const invalid = () => answer(400, "This unsubscribe link doesn't work.", "It may have been cut short. Open it again from the email, or write to hello@dusk.bot and we'll take you off the list.");
  if (!email) return invalid();
  if (req.method === 'HEAD') return answer(200, "You're unsubscribed from Metal news.", '');
  try {
    const { found } = await store.unsubscribe(email);
    if (!found) return invalid();
    console.log('unsubscribe: one entry marked');
    answer(200, "You're unsubscribed from Metal news.", "We won't send you any more news emails.");
  } catch (err) {
    console.error(`unsubscribe: could not save (${err.code || err.name})`);
    answer(500, "We couldn't do that just now.", 'Try the link again in a minute, or write to hello@dusk.bot.');
  }
}

// text is gzipped once per file version and kept in memory
const zips = new Map();
function zipped(file, body) {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (!zips.has(key)) zips.set(key, zlib.gzipSync(body, { level: 9 }));
  return zips.get(key);
}

// the ?v= stamp build-pages.mjs puts on an asset url: the first 8 hex of the sha256 of its content
const stampOf = (url) => /[?&]v=([0-9a-f]{8})\b/.exec(url || '')?.[1] ?? null;
const stamps = new Map();
function contentStamp(file, body) {
  const key = `${file}:${body.length}:${fs.statSync(file).mtimeMs}`;
  if (!stamps.has(key)) stamps.set(key, createHash('sha256').update(body).digest('hex').slice(0, 8));
  return stamps.get(key);
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (NO_INDEX) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  // /explore/ holds design boards that set positions and colours through style attributes
  const explore = (req.url || '').startsWith('/explore/');
  // cloudflare's edge injects its web analytics beacon into every page; allow just that script and where it reports
  // 'inline-speculation-rules' lets site.js add the prerender rules and nothing else inline
  const beacon = "script-src 'self' 'inline-speculation-rules' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com";
  res.setHeader('Content-Security-Policy', explore
    ? `default-src 'self'; ${beacon}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`
    : `default-src 'self'; ${beacon}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`);
  res.setHeader('X-Frame-Options', 'DENY');
  if (store && /^\/api\/waitlist(\/count)?$/.test((req.url || '/').split('?')[0])) return waitlist(req, res, (req.url || '/').split('?')[0]);
  if (store && (req.url || '/').split('?')[0] === '/unsubscribe') return unsubscribe(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('method not allowed\n');
  }
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('ok\n');
  }
  if (NO_INDEX && urlPath === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    return res.end('User-agent: *\nDisallow: /\n');
  }
  if (serveMirrored(req, res, urlPath) || serveVoiceModel(req, res, urlPath)) return;
  // the mac installer has a short address
  let file = resolveFile(urlPath === '/install-mac' ? '/install-mac.sh' : urlPath), status = 200;
  // a page has one address, without the slash at its end
  if (file && urlPath.length > 1 && urlPath.endsWith('/') && file.endsWith('index.html')) {
    res.writeHead(308, { Location: urlPath.replace(/\/+$/, '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), 'Cache-Control': 'public, max-age=300' });
    return res.end();
  }
  if (!file && HOME_ONLY && !/\.[a-z0-9]{1,5}$/i.test(urlPath)) {
    // the query rides along, so /join?ref=x still says who sent you
    res.writeHead(302, { Location: '/' + ((req.url || '').includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (!file) {
    const to = redirectFor(urlPath);
    // the query rides along, so /join?ref=x still says who sent you
    const q = (req.url || '').includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    if (to) { res.writeHead(308, { Location: q && !to.includes('?') ? to.replace(/(#.*)?$/, `${q}$1`) : to, 'Cache-Control': 'public, max-age=300' }); return res.end(); }
    // a page that is not there gets the site's own not-found page; a missing file gets a plain answer
    file = /\.[a-z0-9]{1,5}$/i.test(urlPath) ? null : resolveFile('/404.html');
    status = isGone(urlPath) ? 410 : 404;
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found\n');
    }
  }
  let body = fs.readFileSync(file);
  // apple reads the universal link file as json, and it has no extension
  const type = urlPath === '/.well-known/apple-app-site-association' ? 'application/json' : TYPES[path.extname(file)] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    // the installer, its checksum and the update manifest must never be served stale after a refresh; a url
    // stamped with its content hash never changes, so it can be kept for good. pages are checked on every load too, so
    // a deploy shows at once instead of after a cached page (and the old asset hashes it points at) runs out
    // only when the stamp is this file's own: a page from before a deploy asking for its old stamp gets today's file, and
    // that must not be kept for a year under the old address (a browser or the edge would then mix two builds)
    'Cache-Control': status >= 400 ? 'no-store' : /\.(sh|sha256|json|html)$/.test(file) ? 'no-cache' : stampOf(req.url) ? (stampOf(req.url) === contentStamp(file, body) ? 'public, max-age=31536000, immutable' : 'no-cache') : file.endsWith('.woff2') ? 'public, max-age=86400' : 'public, max-age=300',
  };
  if (/^text\/|svg|json/.test(type) && body.length > 1024) {
    headers.Vary = 'Accept-Encoding';
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { body = zipped(file, body); headers['Content-Encoding'] = 'gzip'; }
  }
  // mail clients fetch the email fonts from another origin
  if (urlPath.startsWith('/email/')) headers['Access-Control-Allow-Origin'] = '*';
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(port, '127.0.0.1', () => console.log(`Metal ${site} on 127.0.0.1:${port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
