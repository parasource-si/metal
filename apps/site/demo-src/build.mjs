// builds the hero demo from captured.json (capture/capture.mjs: the real app's own markup) and the app's own css:
//   public/landing/app-demo.js       the loader: sizes the window, then fetches the demo once it is near the screen
//   public/landing/home-window-app.js   the demo: the app's rows, panel and working line, played by demo.js
//   public/landing/home-window-app.css  the app's tailwind and skin css, only what the demo uses, for the demo's shadow root
//   public/landing/app-demo.css      the page side: the window's size and what a shadow root cannot hold (@property, fonts)
//   pages/partials/app-demo.html     the first frame, drawn from the capture before any script runs
//   node apps/site/demo-src/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(here, '..');
const repo = path.join(site, '..', '..');
const out = path.join(site, 'public', 'landing');
const gen = path.join(here, '.gen');
fs.mkdirSync(gen, { recursive: true });

const req = createRequire(path.join(repo, 'package.json'));
const esbuild = req('esbuild');
const viteReq = createRequire(req.resolve('vite'));
const postcss = viteReq('postcss');
const twReq = createRequire(req.resolve('@tailwindcss/vite'));
const tw = await import(pathToFileURL(twReq.resolve('@tailwindcss/node')).href);

const cap = JSON.parse(fs.readFileSync(path.join(here, 'captured.json'), 'utf8'));
const { BOTS } = await import(pathToFileURL(path.join(here, 'content.mjs')).href);

// the real pixel engine, for the first frame's still bots
await esbuild.build({ entryPoints: [path.join(repo, 'src/pixel/core.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: path.join(gen, 'core.mjs'), logLevel: 'warning' });
const { stillSvgPaths } = await import(pathToFileURL(path.join(gen, 'core.mjs')).href + `?t=${Date.now()}`);

// ---------- markup ----------
// inline styles are not allowed by the site's policy: each distinct one becomes a class, outside every layer so it still
// outranks the app's utilities as the inline style did, and the markup draws the same with no style attribute at all
const styleClass = new Map();
const hash = (s) => createHash('sha256').update(s).digest('base64url').replace(/[-_]/g, 'x').slice(0, 7);
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function classFor(style) {
  const css = decode(style).trim().replace(/;\s*$/, '');
  if (!css) return null;
  if (!styleClass.has(css)) styleClass.set(css, `ds-${hash(css)}`);
  return styleClass.get(css);
}
function clean(html) {
  if (!html) return html;
  return html
    // the engine draws a new canvas into each bot
    .replace(/<canvas[^>]*><\/canvas>/g, '')
    .replace(/ aria-(description|keyshortcuts)="[^"]*"/g, '')
    .replace(/ data-index="\d+"/g, '')
    // the usage meter beside a model name reads the capturing machine's own usage
    .replace(/<span title="" data-usage-bars="[^"]*"[^>]*>[\s\S]*?<\/svg><span class="sr-only">[^<]*<\/span><\/span>/g, '')
    // a file input and the app's drag targets do nothing here
    .replace(/<input class="hidden" multiple="" type="file"[^>]*>/g, '')
    .replace(/<([a-z][\w-]*)([^>]*?) style="([^"]*)"([^>]*)>/g, (all, tag, a, style, b) => {
      const cls = classFor(style);
      let attrs = `${a}${b}`;
      if (!cls) return `<${tag}${attrs}>`;
      if (/ class="/.test(attrs)) attrs = attrs.replace(/ class="([^"]*)"/, (_, c) => ` class="${c} ${cls}"`);
      else attrs += ` class="${cls}"`;
      return `<${tag}${attrs}>`;
    });
}

const bots = {};
for (const bot of BOTS) {
  const c = cap.bots[bot.key];
  bots[bot.key] = {
    log: c.log.map((r) => clean(r.html)),
    head: clean(c.head), composer: clean(c.composer), composerBusy: clean(c.composerBusy),
    row: clean(c.row), rowSelected: clean(c.rowSelected),
    exchanges: c.exchanges.map((e) => ({ id: e.id, answer: e.answer, rows: e.rows.map(clean) })),
    panel: Object.fromEntries(Object.entries(c.panel).map(([k, v]) => [k, clean(v)])),
  };
}
const menu = { html: clean(cap.modelMenu.html), rect: cap.modelMenu.rect, button: cap.modelMenu.button };

// the first frame: the captured window with its bots drawn still, as the engine draws them at rest
function stillBots(html) {
  return html.replace(/(<span data-dusk-mark=""[^>]*data-body="([\w-]+)"[^>]*data-colour="([^"]+)"[^>]*data-eyes="([^"]+)"[^>]*>)(<span class="[^"]*">)(<\/span>)/g,
    (all, open, body, colour, eyes, inner, close) => {
      const p = stillSvgPaths(body, {});
      return `${open}${inner}<svg class="dw-still" viewBox="0 0 ${p.G} ${p.G}" shape-rendering="crispEdges" aria-hidden="true"><path fill="${colour}" d="${p.body}"/><path fill="${eyes}" d="${p.eyes}"/></svg>${close}`;
    });
}
const shell = stillBots(clean(cap.shell));

// ---------- css ----------
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');
const sources = ['src/styles.css', 'src/styles/overlays.css', 'src/styles/motion.css', 'src/styles/icon.css', 'src/styles/composer.css', 'src/components/chat.css',
  'src/components/bot-panel/computer-tab.css', 'src/components/bot-panel/panel-phone.css', 'src/components/bot-pointer.css'];
const appCss = sources.map((f) => `/* ${f} */\n${read(f).replace(/^@import "tailwindcss";/m, '')}`).join('\n');
const entry = `@import "tailwindcss" source(none);\n${appCss}`;

// every class the demo can show: the captured markup and the strings in demo.js
const allHtml = [shell, JSON.stringify(bots), menu.html].join('\n');
const classes = new Set();
for (const m of allHtml.matchAll(/class=\\?"([^"\\]*)\\?"/g)) for (const c of decode(m[1]).split(/\s+/)) if (c) classes.add(c);
const demoJs = fs.readFileSync(path.join(here, 'demo.js'), 'utf8');
for (const m of demoJs.matchAll(/['"`]([^'"`\n]*)['"`]/g)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
// markup built in template literals nests quotes, so every bare token is a candidate too, as tailwind's own scanner reads
for (const c of demoJs.split(/[\s'"`<>{}]+/)) if (c) classes.add(c);
const attrs = new Set();
for (const m of allHtml.matchAll(/\s(data-[\w-]+|aria-[\w-]+|role|dir|hidden|disabled|inert|open|type|title|id)=/g)) attrs.add(m[1]);
for (const m of demoJs.matchAll(/(data-[\w-]+)/g)) attrs.add(m[1]);

const compiler = await tw.compile(entry, { base: repo, onDependency: () => {} });
let css = compiler.build([...classes]);

// the page side gets what a shadow root ignores
const pageRules = [];
const MD = /\((?:min-|max-)?width|\(width/;
const keepSkin = (sel) => {
  const skins = [...sel.matchAll(/\[data-skin="?([\w-]+)"?\]/g)].map((m) => m[1]);
  return !skins.length || skins.includes('grok');
};
const unescape = (s) => s.replace(/\\(.)/g, '$1');
function selectorUsed(sel) {
  if (!keepSkin(sel)) return false;
  if (/:root\[data-(font|chat-width|density|reduce|motion)/.test(sel)) return false;
  const bare = sel.replace(/\[data-skin="?[\w-]+"?\]/g, '').replace(/:(not|where|is|has)\(/g, '(');
  for (const m of bare.matchAll(/\.((?:\\.|[\w-])+)/g)) if (!classes.has(unescape(m[1]))) return false;
  for (const m of bare.matchAll(/\[([\w-]+)/g)) if (/^(data|aria)-/.test(m[1]) && !attrs.has(m[1])) return false;
  for (const m of bare.replace(/\.((?:\\.|[\w-])+)/g, '').matchAll(/#((?:\\.|[\w-])+)/g)) if (!/root/.test(m[1]) && !allHtml.includes(`id="${unescape(m[1])}"`)) return false;
  return true;
}
// one selector of the app's document, as it reads inside the demo's shadow root
function shadowSelector(sel) {
  let s = sel.trim();
  s = s.replace(/:root:is\(([^()]*)\)/g, (_, list) => (/"?grok"?[\],]/.test(list) && /\[data-skin="?grok"?\]/.test(list) ? ':host' : '__drop__'));
  s = s.replace(/:root\[data-skin="?grok"?\]/g, ':host').replace(/(^|[\s>+~,(])\[data-skin="?grok"?\]/g, '$1:host');
  s = s.replace(/:root/g, ':host');
  s = s.replace(/(^|[\s>+~,(])html(?![\w-])/g, '$1:host').replace(/(^|[\s>+~,(])body(?![\w-])/g, '$1.dw-body').replace(/#root(?![\w-])/g, '.dw-root');
  if (s.includes('__drop__')) return null;
  // :host followed by more of the same compound (":host.x") is ":host(.x)"
  s = s.replace(/:host((?:\.[\w-]+|\[[^\]]+\])+)/g, ':host($1)');
  return s;
}
function widthToContainer(params) {
  // tailwind's breakpoints and the app's max-width queries ask the window; the demo asks its own width instead
  const parts = params.split(/\s+and\s+/);
  const width = parts.filter((p) => MD.test(p)), rest = parts.filter((p) => !MD.test(p));
  return { width: width.join(' and '), rest: rest.join(' and ') };
}
const used = new Set();
const plugin = {
  postcssPlugin: 'demo-shadow',
  Once(root) {
    root.walkAtRules('font-face', (r) => r.remove());
    root.walkAtRules('property', (r) => { pageRules.push(r.toString()); r.remove(); });
    root.walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
      const kept = rule.selectors.filter(selectorUsed).map(shadowSelector).filter(Boolean);
      if (!kept.length) { rule.remove(); return; }
      rule.selectors = [...new Set(kept)];
    });
    root.walkAtRules('media', (at) => {
      if (!MD.test(at.params)) return;
      const { width, rest } = widthToContainer(at.params);
      if (/,/.test(at.params)) {
        // "(width < 40rem), (hover: none)": the width half asks the demo, the rest still asks the device
        const lists = at.params.split(',').map((p) => p.trim());
        const w = lists.filter((p) => MD.test(p)), o = lists.filter((p) => !MD.test(p));
        const copy = at.clone();
        at.name = 'container'; at.params = `dusk-demo ${w.join(' or ')}`.replace(/\bmax-width:\s*([\d.]+px)/g, 'width <= $1').replace(/\bmin-width:\s*([\d.]+px)/g, 'width >= $1');
        if (o.length) { copy.params = o.join(', '); at.after(copy); }
        return;
      }
      const cond = width.replace(/\bmax-width:\s*([\d.]+(?:px|rem))/g, 'width <= $1').replace(/\bmin-width:\s*([\d.]+(?:px|rem))/g, 'width >= $1');
      if (rest) {
        const inner = postcss.atRule({ name: 'media', params: rest });
        at.each((n) => { inner.append(n.clone()); });
        at.removeAll(); at.append(inner);
      }
      at.name = 'container'; at.params = `dusk-demo ${cond}`;
    });
    // empty blocks and keyframes nothing names
    let text = '';
    root.walkDecls((d) => { text += ` ${d.value}`; });
    root.walkAtRules(/keyframes$/, (k) => { if (!new RegExp(`\\b${k.params}\\b`).test(text) && !demoJs.includes(k.params)) k.remove(); });
    let removed = true;
    while (removed) { removed = false; root.walk((n) => { if ((n.type === 'rule' || n.type === 'atrule') && n.nodes && n.nodes.length === 0 && n.name !== 'layer') { n.remove(); removed = true; } }); }
    for (const [style, cls] of styleClass) root.append(postcss.parse(`.${cls}{${style.split(/;(?![^(]*\))/).map((d) => d.trim()).filter(Boolean).join(';')}}`));
    used.add('done');
  },
};
const shadowCss = (await postcss([plugin]).process(css, { from: undefined })).css;
const demoOwn = fs.readFileSync(path.join(here, 'demo.css'), 'utf8');
const finalCss = tw.optimize(`${shadowCss}\n${demoOwn}`, { minify: true }).code;
fs.writeFileSync(path.join(out, 'home-window-app.css'), finalCss);

const pageCss = `/* generated by demo-src/build.mjs: the hero demo's window, and what its shadow root cannot hold */
${fs.readFileSync(path.join(here, 'page.css'), 'utf8')}
${pageRules.join('\n')}
`;
fs.writeFileSync(path.join(out, 'home-window.css'), tw.optimize(pageCss, { minify: true }).code);

// ---------- scripts ----------
// repeated icons and pictures go in one table, so each is sent once
const table = [];
const seen = new Map();
const pack = (html) => html && html.replace(/<svg\b[\s\S]*?<\/svg>|src="data:[^"]{120,}"/g, (piece) => {
  if (!seen.has(piece)) { seen.set(piece, table.length); table.push(piece); }
  return `\uE000${seen.get(piece)}\uE001`;
});
// long class lists come back again and again (every bubble, every row): each is sent once too
const classCount = new Map();
JSON.stringify({ bots, menu }).replace(/ class=\\"([^"\\]{40,})\\"/g, (_, c) => { classCount.set(c, (classCount.get(c) ?? 0) + 1); return ''; });
const classes2 = [...classCount].filter(([, n]) => n > 1).map(([c]) => c);
const classIndex = new Map(classes2.map((c, i) => [c, i]));
const packClasses = (html) => html.replace(/ class="([^"]{40,})"/g, (all, c) => (classIndex.has(c) ? ` class="\uE002${classIndex.get(c)}\uE003"` : all));
const packed = JSON.parse(JSON.stringify({ bots, menu }), (k, v) => (typeof v === 'string' && v.includes('<') ? packClasses(pack(v)) : v));
// the bots' panels differ from Metal's in a few places: each is kept as the edits to it
const tok = (s) => s.match(/<[^>]+>|[^<]+/g) ?? [];
function diff(base, next) {
  const a = tok(base), b = tok(next), n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  const add = (op) => { const last = ops.at(-1); if (typeof op === 'number' && typeof last === 'number' && Math.sign(op) === Math.sign(last)) ops[ops.length - 1] += op; else if (typeof op === 'string' && typeof last === 'string') ops[ops.length - 1] += op; else ops.push(op); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { add(1); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { add(-1); i++; } else { add(b[j]); j++; }
  }
  if (i < n) add(-(n - i));
  while (j < m) add(b[j++]);
  return ops;
}
const base = packed.bots[BOTS[0].key];
for (const bot of BOTS.slice(1)) {
  const b = packed.bots[bot.key];
  for (const tab of Object.keys(b.panel)) b.panel[tab] = { d: diff(base.panel[tab], b.panel[tab]) };
  for (const k of ['head', 'composer', 'composerBusy', 'rowSelected', 'row']) if (b[k]) b[k] = { d: diff(base[k], b[k]) };
}
fs.writeFileSync(path.join(gen, 'data.json'), JSON.stringify({ ...packed, table, classes: classes2 }));
await esbuild.build({
  entryPoints: [path.join(here, 'demo.js')], bundle: true, minify: true, format: 'iife', target: 'es2020', legalComments: 'none',
  outfile: path.join(out, 'home-window-app.js'), logLevel: 'warning', alias: { '@demo-data': path.join(gen, 'data.json') },
});
await esbuild.build({ entryPoints: [path.join(here, 'loader.js')], bundle: true, minify: true, format: 'iife', target: 'es2017', legalComments: 'none', outfile: path.join(out, 'home-window.js'), logLevel: 'warning' });

// ---------- the first frame ----------
const partial = `<!-- generated by apps/site/demo-src/build.mjs from the real app's markup (demo-src/captured.json); edit there -->
<div class="dw-win" data-dw role="region" aria-label="a live demo of the Metal app">
<div class="dw-host" data-dw-host data-app="{{stamp home-window-app.js}}" data-skin="grok" lang="en">
<template shadowrootmode="open"><link rel="stylesheet" href="{{stamp home-window-app.css}}"><div class="dw-body"><div class="dw-root">${shell}</div></div></template>
</div>
</div>
`;
fs.writeFileSync(path.join(site, 'pages', 'partials', 'home-window.html'), partial);

const size = (f) => { const b = fs.readFileSync(path.join(out, f)); return `${f} ${Math.round(b.length / 1024)} KB (${Math.round(req('node:zlib').gzipSync(b, { level: 9 }).length / 1024)} KB gzip)`; };
console.log(['home-window.js', 'home-window-app.js', 'home-window-app.css', 'home-window.css'].map(size).join('\n'));
console.log(`partial ${Math.round(partial.length / 1024)} KB, ${styleClass.size} style classes, ${table.length} shared pieces`);
