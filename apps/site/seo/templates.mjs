// how each kind of seo page is laid out. every page shares one frame (the docs' three columns: its hub's pages on the
// left, the article, "on this page" on the right) and gets, in this order: the answer, its picture, what its kind is
// built around (an action table, a comparison, a routine to copy ...), the record's own sections, questions, sources, one
// gentle call to action, related pages and a note on how the page was made. parts that every page of a kind shares are
// marked seo-boiler, so the quality gate counts only what is this page's own.
import fs from 'node:fs';
import path from 'node:path';
import { seoDir, HUBS } from './records.mjs';
import { sceneId } from './art/scene.mjs';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const day = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const connectorFacts = new Map();
export function connector(toolkit) {
  if (!connectorFacts.has(toolkit)) {
    const file = path.join(seoDir, 'facts', 'connectors', `${toolkit}.json`);
    if (!fs.existsSync(file)) throw new Error(`no facts for the ${toolkit} toolkit: run node seo/scripts/fetch-composio.mjs ${toolkit}`);
    connectorFacts.set(toolkit, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return connectorFacts.get(toolkit);
}

export function templates(ctx) {
  const { markdown, esc, icon, bot, records, byPath, config, cta, preview } = ctx;
  // a planned seo address with no built page (queued, rejected, not written yet) stays as plain words
  const plannedPaths = ctx.plannedPaths || new Set();
  const linkable = (at) => { const r = byPath.get(at); return r ? r.built : !plannedPaths.has(at); };
  // a link to a seo page that is not out yet stays as words, so no page ever links to something that is not there
  const guard = (html) => html.replace(/<a href="(\/[^"#?]*)([^"]*)">([\s\S]*?)<\/a>/g, (all, at, rest, words) => (linkable(at.replace(/\/$/, '') || '/') ? all : words));
  const sup = (html) => html.replace(/\[\^(\d+)\]/g, (_, n) => `<sup><a href="#src-${n}" aria-label="source ${n}">${n}</a></sup>`);
  const md = (s) => guard(sup(markdown(String(s || ''))));
  const inline = (s) => md(s).replace(/^<p>([\s\S]*)<\/p>$/, '$1');
  const slug = (s) => s.toLowerCase().replace(/<[^>]+>|&\w+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const copyBox = (message, label) => `<div class="code seo-copy">${label ? `<p class="code-label">${esc(label)}</p>` : ''}<pre><code>${esc(message)}</code></pre><button class="copy" type="button" data-copy>copy</button></div>`;
  const hero = (r, eager = true) => `<figure class="seo-hero"><img src="/art/seo/${sceneId(r.path)}.webp" srcset="/art/seo/${sceneId(r.path)}-660.webp 660w, /art/seo/${sceneId(r.path)}.webp 1320w" sizes="(max-width: 760px) 100vw, 660px" alt="${esc(r.alt)}" width="1320" height="528"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"><i class="seo-drift d1" aria-hidden="true"></i><i class="seo-drift d2" aria-hidden="true"></i><i class="seo-twinkle t1" aria-hidden="true"></i><i class="seo-twinkle t2" aria-hidden="true"></i></figure>`;
  const section = (h, body, cls = '') => `<section class="seo-sec${cls ? ' ' + cls : ''}" aria-labelledby="${slug(h)}"><h2 id="${slug(h)}">${esc(h)}</h2>\n${body}\n</section>`;
  const list = (items) => `<ul>${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
  const sections = (r) => (r.sections || []).map((s) => section(s.h, md(s.md))).join('\n');
  // the table scrolls sideways inside its box on a narrow screen, so the box is a named, focusable region
  const table = (head, rows, label = 'table') => `<div class="table" role="region" aria-label="${esc(label)}" tabindex="0"><table><thead><tr>${head.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c, i) => (i ? `<td>${c}</td>` : `<th scope="row">${c}</th>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
  const srcRefs = (src) => (src || []).map((n) => `<sup><a href="#src-${n}" aria-label="source ${n}">${n}</a></sup>`).join('');

  // the related pages: those named in the record first, then the closest by shared apps, tags and kind, other kinds first
  function related(r) {
    const score = (o) => (r.related || []).includes(o.path) * 100 + (o.connectors || []).filter((c) => (r.connectors || []).includes(c)).length * 4
      + (o.tags || []).filter((t) => (r.tags || []).includes(t)).length * 3 + (o.type !== r.type) * 2 + (o.hub === r.hub);
    return records.filter((o) => o !== r && o.built && (preview || o.indexable || !r.indexable)).map((o) => [score(o), o]).filter(([s]) => s > 2)
      .sort((a, b) => b[0] - a[0] || a[1].path.localeCompare(b[1].path)).slice(0, config.related_count).map(([, o]) => o);
  }
  const card = (o, lazy = true) => `<li><a href="${o.path}"><img src="/art/seo/${sceneId(o.path)}-660.webp" alt="" width="660" height="264"${lazy ? ' loading="lazy"' : ''} decoding="async"><b>${esc(o.h1)}</b><span>${esc(o.og_line || o.description)}</span></a></li>`;
  const ctaBlock = (r) => `<aside class="seo-cta seo-boiler" aria-label="get Metal">${bot('kit', 'violet')}<div><p>${esc(r.cta_line || cta.line)}</p><a class="btn dark" href="${cta.href}${cta.source ? `?source=${encodeURIComponent(`seo:${r.path}`)}` : ''}">${esc(cta.button)}</a></div></aside>`;
  const faq = (r) => (r.faq?.length ? section('questions', r.faq.map((q) => `<h3 id="${slug(q.q)}">${esc(q.q)}</h3>\n${md(q.a)}`).join('\n'), 'seo-faq') : '');
  const sources = (r) => (r.sources?.length ? `<section class="seo-sources" aria-labelledby="sources"><h2 id="sources">sources</h2><ol>${r.sources.map((s, i) => `<li id="src-${i + 1}">${s.url.startsWith('/') ? `<a href="${s.url}">${esc(s.label)}</a>` : `<a href="${esc(s.url)}" rel="nofollow noopener">${esc(s.label)}</a>`}${s.checked ? `, checked ${day(s.checked)}` : ''}</li>`).join('')}</ol></section>` : '');

  // the blocks any page may carry when they are true for it: try it in 2 minutes, a worked example, a checklist or decision
  // table, a rough time estimate with its assumptions, common mistakes and fixes, and a mascot tip
  const pick = (r, list) => list[[...r.path].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % list.length];
  const BOTS = ['pip blue', 'hearty pink', 'boxo tangerine', 'starry sun', 'puff cyan', 'mochi pink', 'cheep sun', 'ribbit lime', 'goo mint', 'drip blue', 'hoot violet', 'loaf tangerine'];
  const mini = (r, salt, cls = 'seo-mini') => { const [shape, colour] = pick({ path: r.path + salt }, BOTS).split(' '); return bot(shape, colour, cls); };
  const extras = {
    quick: (r) => r.quick ? section(r.quick.h || 'try it in 2 minutes', `<ol class="seo-quick">${r.quick.steps.map((x, i) => `<li>${mini(r, 'q' + i)}<span>${inline(x)}</span></li>`).join('')}</ol>`, 'seo-quick-sec') : '',
    worked: (r) => r.worked ? section(r.worked.h || 'what it looks like', `${r.worked.intro ? md(r.worked.intro) : ''}<div class="seo-ba"><div><p class="code-label">${esc(r.worked.before_label || 'before')}</p><div class="code plain"><pre><code>${esc(r.worked.before)}</code></pre></div></div><div><p class="code-label">${esc(r.worked.after_label || 'after the bot')}</p><div class="code plain"><pre><code>${esc(r.worked.after)}</code></pre></div></div></div><p class="seo-fact">an illustration with made-up names and numbers.</p>`) : '',
    checklist: (r) => r.checklist ? section(r.checklist.h || 'quick checklist', `<ul class="seo-check">${r.checklist.items.map((x) => `<li>${icon('check')}<span>${inline(x)}</span></li>`).join('')}</ul>`) : '',
    decide: (r) => r.decide ? section(r.decide.h || 'which one fits', `${r.decide.intro ? md(r.decide.intro) : ''}${table(r.decide.cols.map(esc), r.decide.rows.map((row) => row.map((c) => inline(c))), r.decide.h || 'which one fits')}`) : '',
    saves: (r) => r.saves ? section(r.saves.h || 'what it could save you', `<div class="seo-saves">${mini(r, 'saves', 'seo-mini big')}<div><p class="seo-saves-n">${inline(r.saves.estimate)}</p>${r.saves.formula ? `<div class="code plain seo-formula"><pre><code>${esc(r.saves.formula)}</code></pre></div>` : ''}<p class="code-label">a rough estimate. it assumes:</p>${list(r.saves.assumptions)}</div></div>`) : '',
    mistakes: (r) => r.mistakes?.length ? section(r.mistakes_h || 'mistakes people make', `<div class="seo-mistakes">${r.mistakes.map((m, i) => `<div>${mini(r, 'm' + i)}<p><b>${inline(m.mistake)}</b></p><p>${inline(m.fix)}</p></div>`).join('')}</div>`) : '',
    tip: (r) => r.tip ? `<aside class="seo-tip${r.tip.careful ? ' careful' : ''}">${mini(r, 'tip', 'seo-mini big')}<p>${inline(r.tip.text)}</p></aside>` : '',
  };
  const extraBlocks = (r) => { const order = [['tip', 'quick', 'worked', 'checklist', 'decide', 'saves', 'mistakes'], ['quick', 'tip', 'saves', 'worked', 'mistakes', 'decide', 'checklist'], ['worked', 'quick', 'decide', 'tip', 'checklist', 'mistakes', 'saves']][[...r.path].length % 3]; return order.map((k) => extras[k](r)).join('\n'); };

  // the body each kind of page is built around
  const BODY = {
    guide: (r) => `${r.table ? section(r.table.h, `${r.table.intro ? md(r.table.intro) : ''}${table(r.table.cols.map(esc), r.table.rows.map((row) => [inline(row.label), ...row.cells.map((c) => inline(c) || '')].map((c, i, all) => (i === all.length - 1 ? c + srcRefs(row.src) : c))), r.table.h)}`) : ''}${sections(r)}${r.steps ? section(r.steps.h, `<ol class="seo-steps">${r.steps.items.map((s) => `<li>${inline(s)}</li>`).join('')}</ol>`) : ''}`,

    compare: (r) => {
      const name = r.competitor?.name || r.compare.cols[0];
      const verdict = `<div class="seo-verdict"><div><h3>pick ${esc(r.verdict.them_title || name)} if</h3>${list(r.verdict.them)}</div><div><h3>pick ${esc(r.verdict.dusk_title || 'Metal')} if</h3>${list(r.verdict.dusk)}</div></div>`;
      const rows = r.compare.rows.map((row) => [inline(row.label), ...row.cells.map((c, i) => inline(c) + (i === row.cells.length - 1 ? srcRefs(row.src) : ''))]);
      const heads = r.compare.cols.map((c) => (c === 'Metal' ? `<span class="seo-th">${bot('kit', 'violet', 'seo-mini')}${esc(c)}</span>` : esc(c)));
      return `${section('the short version', verdict)}\n${section(r.compare.h || 'side by side', `${r.compare.intro ? md(r.compare.intro) : ''}<div class="seo-compare">${table(['', ...heads], rows, `${name} and the others, side by side`)}</div>`)}\n${sections(r)}\n${section('how we checked', md(r.method))}`;
    },

    integration: (r) => {
      const app = r.app, f = app.toolkit ? connector(app.toolkit) : null;
      let can = '';
      if (f) {
        const reads = f.tools.filter((t) => t.kind === 'read').length, sends = f.tools.filter((t) => t.kind === 'send').length;
        const rows = app.highlight.map((h) => { const t = f.tools.find((x) => x.slug === h.slug); if (!t) throw new Error(`${r.file}: ${h.slug} is not a ${app.toolkit} action in seo/facts/connectors/${app.toolkit}.json`); return [esc(t.name), { read: 'read', write: 'change', send: 'send: asks first' }[t.kind], inline(h.use)]; });
        can = section(`what a bot can do in ${app.name}`, `${md(app.intro)}${table(['action', 'Metal treats it as', 'what you would use it for'], rows, `${app.name} actions`)}<p class="seo-fact">composio, the connection service behind Metal's apps, lists <b>${f.tools_count} ${esc(f.name)} actions</b> (version ${esc(f.version)}, read ${day(f.fetched_at)}${srcRefs([r.sources.findIndex((s) => s.url === f.source) + 1])}). Metal treats ${reads} as reads, ${sends} as sends and ${f.tools_count - reads - sends} as changes.</p><p class="seo-fact">only actions starting with a read word (get, list, search) count as reads, so a read-only bot can't call the rest. a send reaches people or moves money${sends ? ', like ' + esc(f.tools.find((t) => t.kind === 'send').name.toLowerCase()) : ''}, and waits for your <b>Allow</b> unless you set a daily amount.</p>${f.managed_sign_in ? '' : `<p class="callout careful">composio has no ready-made sign-in for ${esc(app.name)}. connecting it needs your own composio project key and an auth config of your own, added under <b>Settings</b>, <b>API keys</b>. on dusk cloud, ask us first.</p>`}`);
      } else can = section(`what a bot can do with ${app.name}`, md(app.intro));
      const steps = app.toolkit ? `<ol class="seo-steps seo-boiler"><li>open <b>Connected apps</b> in the sidebar.</li><li>pick ${esc(app.name)} and sign in on ${esc(app.name)}'s own page, so your password goes to them and never to a bot.</li><li>choose which bots may use it, and whether each may only read or may also change things. your bookkeeper doesn't need your ${esc(app.name)}.</li><li>ask in plain words. reading and drafting happen freely; sending asks you first.</li></ol>` : '';
      const routines = r.routines.map((x) => `<div class="seo-routine"><h3>${esc(x.name)}</h3>${copyBox(x.message)}<p class="seo-runs"><span>${esc(x.when)}</span>${x.output ? ` · ${inline(x.output)}` : ''}</p></div>`).join('');
      const acts = records.filter((o) => o.kind === 'action' && o.action?.toolkit === app.toolkit && o.built && (preview || o.indexable || !r.indexable));
      const more = acts.length ? section(`more things a bot can do in ${app.name}`, `<ul class="seo-actions">${acts.map((o) => `<li><a href="${o.path}">${esc(o.nav || o.h1)}</a></li>`).join('')}</ul>`) : '';
      return `${can}\n${more}\n${section(`connect ${app.name}`, `${steps}${app.setup ? md(app.setup) : ''}`)}\n${section('routines to copy', `${r.routines_intro ? md(r.routines_intro) : ''}${routines}`)}\n${section('what it asks you first', md(r.asks))}\n${section('what it cannot do', list(r.cannot))}\n${sections(r)}`;
    },

    usecase: (r) => `${section('the routine', `${r.routine.intro ? md(r.routine.intro) : ''}${copyBox(r.routine.message, 'paste this into a chat with your bot')}<dl class="seo-specs"><div><dt>when</dt><dd>${inline(r.routine.when)}</dd></div><div><dt>needs</dt><dd>${inline(r.routine.needs)}</dd></div></dl>${r.routine.output ? `<p class="code-label">what comes back looks like this (an example, not a real inbox)</p><div class="code plain seo-sample"><pre><code>${esc(r.routine.output)}</code></pre></div>` : ''}`)}\n${sections(r)}\n${section('the guard rails', list(r.safeguards))}`,

    role: (r) => `${section(r.day_h || 'a day with bots', table(['when', 'what a bot does'], r.day.map((d) => [esc(d.when), inline(d.what)]), r.day_h || 'a day with bots'))}\n${section('the routines', r.pack.map((p) => `<div class="seo-routine"><h3>${esc(p.name)}</h3>${copyBox(p.message)}${p.note ? `<p class="seo-runs">${inline(p.note)}</p>` : ''}</div>`).join(''))}\n${sections(r)}`,

    routine: (r) => `${section('the message', `${copyBox(r.routine.message, 'paste this into a chat with your bot')}<dl class="seo-specs"><div><dt>when</dt><dd>${inline(r.routine.when)}</dd></div><div><dt>needs</dt><dd>${inline(r.routine.needs)}</dd></div></dl>`)}\n${r.routine.output ? section('what comes back', `<p class="code-label">an example, not a real run</p><div class="code plain seo-sample"><pre><code>${esc(r.routine.output)}</code></pre></div>`) : ''}\n${section('make it yours', list(r.knobs))}\n${section('when it goes wrong', list(r.fails))}\n${sections(r)}`,

    glossary: (r) => `${section('in one line', `<p class="seo-def">${inline(r.definition)}</p>`)}\n${section('an example', md(r.example))}\n${sections(r)}`,

    // one app action. the facts (what composio says it does, its inputs, the permissions it asks for, how Metal treats
    // it) come from seo/facts/connectors; the words (what it's for, a routine, steps, limits) are the record's own. three
    // layouts, picked from the address, so pages of one app don't read as one page with the name swapped
    action: (r) => {
      const f = connector(r.action.toolkit), t = f.tools.find((x) => x.slug === r.action.slug);
      if (!t) throw new Error(`${r.file}: ${r.action.slug} is not a ${r.action.toolkit} action`);
      if (t.deprecated) throw new Error(`${r.file}: ${r.action.slug} is deprecated`);
      const app = records.find((o) => o.kind === 'integration' && o.app?.toolkit === r.action.toolkit);
      const appName = app?.app.name || f.name;
      const kindWords = { read: 'a read: it looks and changes nothing', write: 'a change: it alters something in ' + esc(appName) + ', and the sending setting does not cover it', send: 'a send: it reaches people or moves money, so it waits for your <b>Allow</b> (unless you set a daily amount, or the bot is on <b>Full access</b> with no sending rule, which lets it send up to 25 a day)' }[t.kind];
      const inputs = (t.inputs || []).filter((i) => i.name !== 'user_id' && !/deprecated/i.test(i.about)).sort((a, b) => b.required - a.required).slice(0, 6);
      const variant = [...r.path].reduce((n, c) => n + c.charCodeAt(0), 0) % 3;
      const H = [
        { what: 'what it does', uses: 'when you would use it', try: 'try it', steps: 'set it up', needs: 'what it needs from you', rules: 'how Metal handles it', watch: 'where it stops' },
        { what: `${t.name.toLowerCase()}, in plain words`, uses: 'good jobs for it', try: 'a routine to copy', steps: 'how to start', needs: 'the details it works from', rules: 'before it runs', watch: 'limits worth knowing' },
        { what: 'the short version', uses: 'where it helps', try: 'send this to your bot', steps: 'step by step', needs: 'inputs', rules: 'permissions and asking first', watch: 'what can go wrong' },
      ][variant];
      const part = {
        what: section(H.what, md(r.what)),
        uses: section(H.uses, list(r.uses)),
        try: section(H.try, `${copyBox(r.routine.message, 'paste this into a chat with your bot')}<dl class="seo-specs"><div><dt>when</dt><dd>${inline(r.routine.when)}</dd></div><div><dt>needs</dt><dd>${inline(r.routine.needs)}</dd></div></dl>${r.routine.output ? `<p class="code-label">what comes back looks like this (an example)</p><div class="code plain seo-sample"><pre><code>${esc(r.routine.output)}</code></pre></div>` : ''}`),
        steps: section(H.steps, `<ol class="seo-steps">${r.steps.map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`),
        needs: inputs.length ? section(H.needs, `${table(['input', 'required', 'what it is'], inputs.map((i) => [`<code>${esc(i.name)}</code>`, i.required ? 'yes' : 'no', esc(i.about.split(/(?<=\.)\s/)[0] || i.type)]), 'inputs')}<p class="seo-fact">from composio's catalog for ${esc(appName)} (action <code>${esc(t.slug)}</code>, read ${day(f.fetched_at)}${srcRefs([r.sources.findIndex((x) => x.url === f.source) + 1])}). your bot fills these in from what you tell it.</p>`) : '',
        rules: section(H.rules, `<p>Metal counts <b>${esc(t.name)}</b> as ${kindWords}.${t.kind === 'read' ? ' a bot you allow only to read can use it.' : ' a bot you allow only to read can never call it.'}</p>${Array.isArray(t.scopes) && t.scopes.length ? `<p class="seo-fact">the permissions ${esc(appName)} asks for to run it: ${t.scopes.slice(0, 4).map((x) => `<code>${esc(x.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''))}</code>`).join(', ')}.</p>` : ''}${r.rules ? md(r.rules) : ''}`),
        watch: section(H.watch, list(r.watch)),
      };
      const order = [['what', 'uses', 'try', 'steps', 'needs', 'rules', 'watch'], ['what', 'try', 'uses', 'rules', 'steps', 'watch', 'needs'], ['uses', 'what', 'steps', 'try', 'watch', 'rules', 'needs']][variant];
      return order.map((k) => part[k]).join('\n') + sections(r);
    },

    tool: (r) => {
      const file = path.join(seoDir, 'tools', `${r.tool}.html`);
      return `<div class="seo-tool">${fs.readFileSync(file, 'utf8')}</div>\n${section('how it works out the numbers', md(r.method))}\n${sections(r)}`;
    },
  };

  function sidebar(r, hub) {
    const same = (o) => (r.kind === 'action' ? (o.kind === 'action' && o.action?.toolkit === r.action.toolkit) || (o.kind === 'integration' && o.app?.toolkit === r.action.toolkit) : o.kind !== 'action');
    const sibs = records.filter((o) => o.hub === r.hub && same(o) && o.built && (preview || o.indexable || !r.indexable));
    const near = related(r).map((o) => o.path);
    const shown = sibs.length > config.sidebar_max ? sibs.filter((o) => o === r || near.includes(o.path)).concat(sibs.filter((o) => o !== r && !near.includes(o.path))).slice(0, config.sidebar_max) : sibs;
    const groups = r.kind === 'action' ? [[{ title: 'this app' }, shown.filter((o) => o.kind === 'integration')], [{ title: 'its actions' }, shown.filter((o) => o.kind === 'action')]].filter(([, l]) => l.length)
      : hub.groups.map((g) => [g, shown.filter((o) => g.types.includes(o.type))]).filter(([, l]) => l.length);
    return groups.map(([g, l]) => `<div role="group" aria-label="${esc(g.title)}"><p class="nh" aria-hidden="true">${esc(g.title)}</p><ul>${l.map((o) => `<li><a href="${o.path}"${o === r ? ' aria-current="page"' : ''}>${esc(o.nav || o.h1)}</a></li>`).join('')}</ul></div>`).join('')
      + `<p class="seo-all"><a href="${hub.at}">every page in ${esc(hub.nav)}</a></p>`;
  }

  // the art layer: a small kit object beside two of the page's section headings, and a mascot beside the sections about
  // limits and mistakes; which object and which bot vary with the page's address
  const SPOTS = ['p-magnifier', 'p-folder', 's-notebook', 'p-chart', 's-mailbox', 'p-bubbles', 'p-megaphone', 's-parcel', 's-key', 's-plug', 'p-mug', 'p-newspaper', 's-clock', 's-books', 'p-shield', 'p-receipt', 's-map', 'p-binoculars'];
  const SIZE = ctx.kitSizes || {};
  function decorate(r, html) {
    let n = 0;
    const want = new Set([1, 3]);
    return html.replace(/<section class="seo-sec([^"]*)" aria-labelledby="([^"]+)"><h2 id="\2">([\s\S]*?)<\/h2>/g, (all, cls, id, h) => {
      const i = n++;
      if (/cannot|watch|limit|stops|wrong|mistake|careful|guard|asks/.test(id)) return `<section class="seo-sec seo-warned${cls}" aria-labelledby="${id}"><h2 id="${id}">${h}</h2><span class="seo-mascot" aria-hidden="true">${mini(r, 'warn' + i)}</span>`;
      if (!want.has(i)) return all;
      const prop = pick({ path: r.path + i }, SPOTS), file = prop.startsWith('p-') ? `kit/${prop}.webp` : `${prop}.webp`, [w, hh] = SIZE[prop] || [420, 420];
      return `<section class="seo-sec seo-spotted${cls}" aria-labelledby="${id}"><h2 id="${id}">${h}</h2><img class="seo-spot" src="/art/${file}" alt="" width="${w}" height="${hh}" loading="lazy" decoding="async">`;
    });
  }

  // the answer opens the article, but only its first sentence or two sit under the h1 as the lede; the rest follows as
  // the first paragraph, so the top of the page stays two or three lines
  function answerParts(text) {
    const said = String(text || '').trim().split(/(?<=[.?!])\s+(?=[a-z0-9"(])/);
    let lede = said.shift() || '';
    while (said.length && lede.length + said[0].length + 1 <= 170) lede += ' ' + said.shift();
    return [lede, said.join(' ')];
  }

  function page(r) {
    const hub = HUBS[r.hub];
    const main = decorate(r, `${BODY[r.kind](r)}\n${extraBlocks(r)}`);
    const heads = [...main.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
    const rel = related(r);
    const toc = `<aside class="doc-toc"><nav aria-label="on this page"><h2>on this page</h2><ol>${heads.map((m) => `<li><a href="#${m[1]}">${m[2]}</a></li>`).join('')}${r.faq?.length ? '<li><a href="#questions">questions</a></li>' : ''}${r.sources?.length ? '<li><a href="#sources">sources</a></li>' : ''}</ol></nav></aside>`;
    const updated = r.updated || r.verified;
    const [lede, rest] = answerParts(r.answer);
    const body = `<div class="docs wrap seo">
<aside class="docs-side"><nav class="docs-nav" aria-label="${esc(hub.nav)}">${sidebar(r, hub)}</nav></aside>
<details class="docs-jump"><summary><span>${esc(hub.nav)}</span><b>${esc(r.nav || r.h1)}</b>${icon('chevron-down')}</summary><nav class="docs-nav" aria-label="${esc(hub.nav)}, every page">${sidebar(r, hub)}</nav></details>
<article class="doc prose seo-page">
<p class="crumb"><a href="/">Metal</a><span aria-hidden="true">/</span><a href="${hub.at}">${esc(hub.nav)}</a>${r.parent ? `<span aria-hidden="true">/</span><a href="${r.parent.path}">${esc(r.parent.nav)}</a>` : ''}</p>
<header class="seo-top"><h1>${esc(r.h1)}</h1>
<p class="lede seo-answer">${inline(lede)}</p>
<p class="seo-meta seo-boiler">by <a href="${config.author_url}">${esc(config.byline)}</a> · checked <time datetime="${updated}">${day(updated)}</time> · <a href="#how-made">how we made this</a></p></header>
${rest ? `<p class="seo-answer seo-answer-more">${inline(rest)}</p>\n` : ''}${hero(r)}
${main}
${faq(r)}
${ctaBlock(r)}
${sources(r)}
${rel.length ? `<section class="seo-related seo-boiler" aria-labelledby="related"><h2 id="related">read next</h2><ul class="seo-cards">${rel.map((o) => card(o)).join('')}</ul></section>` : ''}
<p class="seo-made seo-boiler" id="how-made">${esc(config.made)}</p>
</article>
${toc}
</div>`;
    return { body, related: rel };
  }

  function hubPage(hub) {
    const pages = records.filter((o) => o.hub === hub.id && o.built && (preview || o.indexable));
    const groups = hub.groups.map((g) => [g, pages.filter((o) => g.types.includes(o.type))]).filter(([, l]) => l.length);
    const others = Object.entries(HUBS).filter(([id]) => id !== hub.id && ctx.hubs.some((h) => h.id === id));
    // every live action, grouped by app, so each one has a way in from the hub
    const acts = hub.id === 'integrations' ? pages.filter((o) => o.type === 'integration').map((app) => [app, records.filter((o) => o.kind === 'action' && o.action?.toolkit === app.app?.toolkit && o.built && (preview || o.indexable))]).filter(([, l]) => l.length) : [];
    const actBlock = acts.length ? `<section class="wrap seo-hub seo-hubs" aria-labelledby="actions"><h2 id="actions">what a bot can do, app by app</h2>${acts.map(([app, l]) => `<h3>${esc(app.nav || app.h1)}</h3><ul>${l.map((o) => `<li><a href="${o.path}">${esc(o.nav || o.h1)}</a></li>`).join('')}</ul>`).join('')}</section>` : '';
    const body = `<header class="phead wrap"><p class="crumb"><a href="/">Metal</a><span aria-hidden="true">/</span>${esc(hub.nav)}</p><h1>${esc(hub.h1)}</h1><p class="lede">${esc(hub.lede)}</p></header>
<figure class="wrap seo-hub-hero"><img src="/art/seo/${sceneId(hub.at)}.webp" srcset="/art/seo/${sceneId(hub.at)}-660.webp 660w, /art/seo/${sceneId(hub.at)}.webp 1320w" sizes="(max-width: 760px) 100vw, 1160px" alt="${esc(HUBS[hub.id].alt)}" width="1320" height="528" fetchpriority="high" decoding="async"></figure>
${groups.map(([g, l], i) => `<section class="wrap seo-hub" aria-labelledby="${g.id}"><h2 id="${g.id}">${esc(g.title)}</h2><ul class="seo-cards">${l.map((o) => card(o, i > 0 || l.indexOf(o) > 2)).join('')}</ul></section>`).join('\n')}
${actBlock}
${others.length ? `<nav class="wrap seo-hubs" aria-label="more"><h2>more to read</h2><ul>${others.map(([, h]) => `<li><a href="${h.at}">${esc(h.nav)}</a></li>`).join('')}<li><a href="/docs">the docs</a></li></ul></nav>` : ''}`;
    return { body, pages };
  }

  return { page, hubPage, related };
}
