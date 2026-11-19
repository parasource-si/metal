// the docs. every pages/docs/*.md is one page at /docs/<file name>. it opens with a few lines of front matter:
//   ---
//   title: memory
//   description: one sentence, shown under the title, in search results and in the docs home
//   section: bots          (an id from pages/docs/_sections.json, which also sets the order of the sections)
//   order: 3               (where it sits inside its section)
//   art: s-notebook        (optional: a small pixel object from public/landing/art, shown beside the title)
//   ---
// the body is markdown (build-pages.mjs markdown(), so macros like {{bot circle blue}} and {{include ui-approval}} work).
// to add a page, add a file. the sidebar, the docs home, next and previous, "on this page" and the search index follow.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// width and height of a webp, read from its header (lossy, lossless and extended files)
function webpSize(file) {
  const b = fs.readFileSync(file), kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  const n = b.readUInt32LE(21); return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)];
}

export function buildDocs({ here, site, markdown, layout, macros, strip, text, write, esc, icon }) {
  const dir = path.join(here, 'pages', 'docs');
  const art = (name, cls) => { const [w, h] = webpSize(path.join(site, 'art', `${name}.webp`)); return `<img class="obj${cls ? ' ' + cls : ''}" src="/art/${name}.webp" alt="" width="${w}" height="${h}" loading="lazy">`; };
  const sections = JSON.parse(fs.readFileSync(path.join(dir, '_sections.json'), 'utf8'));
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    if (!m) throw new Error(`pages/docs/${f} has no front matter`);
    const meta = Object.fromEntries(m[1].split('\n').filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
    for (const key of ['title', 'description', 'section']) if (!meta[key]) throw new Error(`pages/docs/${f} needs ${key} in its front matter`);
    if (!sections.some((s) => s.id === meta.section)) throw new Error(`pages/docs/${f}: no section "${meta.section}" in _sections.json`);
    const name = f.slice(0, -3);
    return { ...meta, name, at: `/docs/${name}`, order: Number(meta.order) || 99, html: markdown(raw.slice(m[0].length)) };
  });
  const ordered = sections.flatMap((s) => pages.filter((p) => p.section === s.id).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)));

  const navList = (current) => sections.map((s) => `<div role="group" aria-label="${esc(s.title)}"><p class="nh" aria-hidden="true">${esc(s.title)}</p><ul>${ordered.filter((p) => p.section === s.id).map((p) => `<li><a href="${p.at}"${p === current ? ' aria-current="page"' : ''}>${esc(p.nav || p.title)}</a></li>`).join('')}</ul></div>`).join('');
  const search = (id) => `<div class="docs-search" data-search><label class="vh" for="${id}">search the docs</label>${icon('search')}<input id="${id}" type="search" placeholder="search the docs" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="${id}-hits" aria-autocomplete="list"><kbd aria-hidden="true">/</kbd><div class="hits" id="${id}-hits" role="listbox" aria-label="search results" hidden></div></div>`;

  // the search index: one entry per heading, with the words under it
  const index = [];
  for (const p of ordered) {
    const parts = p.html.split(/(?=<h[23] id=")/);
    parts.forEach((part, i) => {
      const h = /^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/.exec(part);
      const body = text((h ? part.slice(h[0].length) : part).replace(/<button[\s\S]*?<\/button>/g, ' ').replace(/<figure[\s\S]*?<\/figure>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' '));
      if (!h && !body && i > 0) return;
      index.push({ u: h ? `${p.at}#${h[1]}` : p.at, t: p.title, h: h ? text(h[2]) : '', x: (h ? body : `${p.description} ${body}`).slice(0, 420) });
    });
  }
  fs.mkdirSync(path.join(site, 'docs'), { recursive: true });
  const indexJson = JSON.stringify(index);
  fs.writeFileSync(path.join(site, 'docs', 'search.json'), indexJson);
  const indexUrl = `/docs/search.json?v=${createHash('sha256').update(indexJson).digest('hex').slice(0, 8)}`;

  ordered.forEach((p, i) => {
    const section = sections.find((s) => s.id === p.section);
    const heads = [...p.html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
    const toc = heads.length > 1 ? `<aside class="doc-toc"><nav aria-label="on this page"><h2>on this page</h2><ol>${heads.map((m) => `<li><a href="#${m[1]}">${m[2].replace(/<[^>]+>/g, '')}</a></li>`).join('')}</ol></nav></aside>` : '<aside class="doc-toc" hidden></aside>';
    const prev = ordered[i - 1], next = ordered[i + 1];
    const step = (q, way) => (q ? `<a class="${way}" href="${q.at}"><small>${way === 'prev' ? 'before this' : 'up next'}</small><b>${esc(q.title)}</b></a>` : '<span></span>');
    // the questions page also tells search engines its questions, one per ### heading
    const qs = p.name === 'faq' ? p.html.split(/(?=<h3 id=")/).slice(1).map((part) => { const h = /^<h3 id="[^"]+">([\s\S]*?)<\/h3>([\s\S]*?)(?=<h2|$)/.exec(part); return { '@type': 'Question', name: text(h[1]), acceptedAnswer: { '@type': 'Answer', text: text(macros(h[2])) } }; }) : [];
    const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [['docs', '/docs'], [p.title, p.at]].map(([name, at], n) => ({ '@type': 'ListItem', position: n + 1, name, item: `{{site ${at}}}` })) };
    const body = `<div class="docs wrap" data-index="${indexUrl}">
<aside class="docs-side">${search('q')}<nav class="docs-nav" aria-label="docs">${navList(p)}</nav></aside>
<details class="docs-jump"><summary><span>${esc(section.title)}</span><b>${esc(p.nav || p.title)}</b>${icon('chevron-down')}</summary><nav class="docs-nav" aria-label="docs, every page">${navList(p)}</nav></details>
<article class="doc prose">
<p class="crumb"><a href="/docs">docs</a><span aria-hidden="true">/</span>${esc(section.title)}</p>
<header class="doc-top"><div><h1>${esc(p.title)}</h1>
<p class="lede">${esc(p.description)}</p></div>${p.art ? art(p.art) : ''}</header>
${p.html}
<nav class="doc-next" aria-label="more docs">${step(prev, 'prev')}${step(next, 'next')}</nav>
<p class="doc-help">{{bot ${section.bot || 'circle blue'}}}<span>stuck? write to <a href="mailto:hello@dusk.bot">hello@dusk.bot</a> and a person answers.</span></p>
</article>
${toc}
</div>`;
    const jsonld = [JSON.parse(macros(JSON.stringify(crumbs))), ...(qs.length ? [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qs }] : [])];
    write(p.at, layout({ title: `${p.title} / Metal docs`, description: p.description, page: p.name, at: p.at, section: 'docs', og: `docs--${p.name}`, kind: 'p-doc', scripts: ['docs.js'], jsonld, body }));
  });

  // the docs home: every section, with its pages and what each is about
  // new here: the three pages worth reading first, in order
  const first = ['getting-started', 'tips', 'dusk-cloud'].map((n) => ordered.find((p) => p.name === n)).filter(Boolean);
  const home = `<header class="phead wrap"><h1>docs</h1><p class="lede">how to get going, and how to get the most out of your bots. short pages, plain words.</p>${search('q')}</header>
${strip('birches', 'circle blue, heart pink, hex orange, star green, drop yellow')}
<section class="wrap docs-first" aria-labelledby="new-here"><h2 id="new-here">new here? read these three.</h2><ol class="after">${first.map((p, i) => `<li><span class="n" aria-hidden="true">${i + 1}</span><h3><a href="${p.at}">${esc(p.title)}</a></h3><p>${esc(p.description)}</p></li>`).join('')}</ol></section>
<div class="docs-index wrap" data-index="${indexUrl}">
${sections.map((s) => `<section>${art(s.art)}<h2>${esc(s.title)}</h2><ul>${ordered.filter((p) => p.section === s.id).map((p) => `<li><a href="${p.at}"><b>${esc(p.title)}</b><span>${esc(p.description)}</span></a></li>`).join('')}</ul></section>`).join('\n')}
</div>
<section class="wrap docs-foot"><div class="note-row">{{bot heart pink}}<p>could not find it? write to <a href="mailto:hello@dusk.bot">hello@dusk.bot</a>. a person answers, and the docs get better.</p></div></section>`;
  write('/docs', layout({ title: 'docs / Metal', description: 'How to get going with Metal, and how to get the most out of your bots: clear jobs, good first messages, routines, group chats, memory and dusk cloud.', page: 'docs', at: '/docs', og: 'docs', kind: 'p-docs', scripts: ['docs.js'], body: home }));
  return ordered.length + 1;
}
