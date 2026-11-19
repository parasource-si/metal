// the share cards, every page's: the home card's style (the waitlist page's pixel sky, white words centred, the crew on
// the meadow). fifteen key pages have a scene of their own, set by hand; every other page gets its family's scene (an app
// page its app's tile beside a bot, a comparison the rival's name, a docs page its topic's picture...) with a short title and
// line of its own, so the art repeats within a family and the words never do. node cards.mjs <dir> writes one page per
// card into <dir> and seo/art/og6.json (which page each card is for, its alt text, a hash of its page); render.py
// photographs them into public/landing/art/og6. core pages name their card by page name (core), seo pages by address (seo)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { worldSvg, botSvg, rng } from './world.mjs';
import { loadRecords, HUBS } from '../../seo/records.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), D = path.resolve(here, '..', '..'), A = 'file://' + D + '/public/landing/art';
const OUT = process.argv[2], W = 1200, H = 630, M = 64;

// pieces
const bot = (shape, colour, pose, size, cx, foot, { flip = false, rot = 0 } = {}) => {
  const b = botSvg(shape, colour, pose, { grid: size > 200 ? 26 : 22, flip });
  const t = [flip ? 'scaleX(-1)' : '', rot ? `rotate(${rot}deg)` : ''].join(' ');
  return `<div class="bot" style="left:${Math.round(cx - size / 2 - size * b.px / b.G)}px;top:${Math.round(foot - size * (b.pt + b.G) / b.G)}px;${t.trim() ? `transform:${t};transform-origin:50% 100%` : ''}">${b.svg(size)}</div>`;
};
const img = (file, h, cx, foot, w0 = 420, h0 = 420) => { const w = Math.round(w0 * h / h0); return `<img class="px" src="${A}/${file}" style="left:${Math.round(cx - w / 2)}px;top:${foot - h}px;width:${w}px;height:${h}px" alt="">`; };
// each logo file's own white margin, cut away so the mark itself fills the tile (top right bottom left, in the file's pixels)
const CROP = { 'gmail.png': '13px 7px 13px 7px', 'calendar.png': '7px 11px 11px 11px', 'slack.png': '12px 11px 11px 12px', 'linear.png': '3px', 'notion.png': '0 0 0 1px',
  'drive.png': '10px 8px 11px 8px', 'figma.png': '19px 17px 19px 17px', 'outlook.png': '9px 8px 9px 7px' };
const logo = (file) => `<img src="${A}/logos/${file}"${CROP[file] ? ` style="object-view-box: inset(${CROP[file]})"` : ''} alt="">`;
const tile = (inner, size, x, y, rot = 0) => `<div class="tile" style="left:${x}px;top:${y}px;width:${size}px;height:${size}px;transform:rotate(${rot}deg)">${inner}</div>`;
const bub = (who, text, side, tint, bottomY, x = M) => `<div class="bub ${side}" style="${side}:${x}px;bottom:${H - bottomY}px;--u:${tint}"><div class="in"><span>${who}</span>${text}</div><i></i></div>`;
const hill = (cx, half, rise) => [cx, half, rise];
const footOn = (G, hills) => (x) => { let y = G; for (const [cx, half, rise] of hills) { const d = Math.abs(x - cx) / half; if (d < 1) y = Math.min(y, G - rise * (1 - d * d) ** 0.7); } return y + 6; };

function page({ mood = 'sky', G = 530, hills = [], title, line, size = 112, top = 72, lineSize = 34, body = '', seed }) {
  return `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: "General Sans"; src: url("file://${D}/public/landing/fonts/general-sans.woff2"); font-weight: 200 700; }
@font-face { font-family: "Geist Mono"; src: url("file://${D}/public/landing/fonts/geist-mono.woff2"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
body { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; font-family: "General Sans"; color: #fff; -webkit-font-smoothing: antialiased; }
.world { position: absolute; left: 0; top: 0; }
.bot, .px, .tile, .bub, .fx { position: absolute; }
.bot svg { display: block; overflow: visible; filter: drop-shadow(0 6px 0 rgba(12,24,60,0.12)); }
.px { image-rendering: pixelated; }
.tile { display: grid; place-items: center; background: #fdfdfd; border-radius: 22%; box-shadow: 0 8px 0 rgba(12,24,60,0.14); }
.tile img { width: 86%; height: 86%; object-fit: contain; }
.tile span { display: block; max-width: 92%; color: #1b1b1f; font-weight: 600; letter-spacing: -0.03em; line-height: 1.02; text-align: center; }
.vs { position: absolute; display: grid; place-items: center; width: 76px; height: 50px; background: #1b1b1f; color: #fff3a0; font-size: 28px; font-weight: 650; border-radius: 12px; }
.bub { width: max-content; filter: drop-shadow(0 6px 0 rgba(12,24,60,0.12)); }
.bub .in { padding: 10px 18px 16px; background: #fdfdfd; color: #212121; font-size: 22px; font-weight: 500; line-height: 1.18; letter-spacing: -0.015em; box-shadow: inset 0 -5px 0 var(--u);
  clip-path: polygon(6px 0, calc(100% - 6px) 0, calc(100% - 6px) 6px, 100% 6px, 100% calc(100% - 6px), calc(100% - 6px) calc(100% - 6px), calc(100% - 6px) 100%, 6px 100%, 6px calc(100% - 6px), 0 calc(100% - 6px), 0 6px, 6px 6px); }
.bub span { display: block; margin-bottom: 3px; font-family: "Geist Mono"; font-size: 14px; color: #8a8a96; }
.bub i { position: absolute; bottom: -18px; left: 24px; width: 18px; height: 18px; background: linear-gradient(var(--u) 0 6px, #fdfdfd 6px); clip-path: polygon(0 0, 100% 0, 100% 33.3%, 66.6% 33.3%, 66.6% 66.6%, 33.3% 66.6%, 33.3% 100%, 0 100%); }
.text { position: absolute; left: ${M}px; top: ${top}px; width: ${W - 2 * M}px; text-align: center; }
h1 { font-weight: 600; line-height: 1.02; letter-spacing: -0.045em; text-wrap: balance; }
.text p { margin-top: 20px; font-size: 34px; font-weight: 550; line-height: 1.2; letter-spacing: -0.015em; }
.sign { position: absolute; display: grid; place-items: center; background: #fdfdfd; color: #212121; font-weight: 650; letter-spacing: -0.03em; box-shadow: inset 0 -7px 0 #fff3a0, 0 8px 0 rgba(12,24,60,0.14);
  clip-path: polygon(8px 0, calc(100% - 8px) 0, calc(100% - 8px) 8px, 100% 8px, 100% calc(100% - 8px), calc(100% - 8px) calc(100% - 8px), calc(100% - 8px) 100%, 8px 100%, 8px calc(100% - 8px), 0 calc(100% - 8px), 0 8px, 8px 8px); }
.doc { position: absolute; background: #fdfdfd; box-shadow: inset 0 -8px 0 #d0cefb, 0 8px 0 rgba(12,24,60,0.14);
  clip-path: polygon(8px 0, calc(100% - 8px) 0, calc(100% - 8px) 8px, 100% 8px, 100% calc(100% - 8px), calc(100% - 8px) calc(100% - 8px), calc(100% - 8px) 100%, 8px 100%, 8px calc(100% - 8px), 0 calc(100% - 8px), 0 8px, 8px 8px); }
.doc b { position: absolute; height: 12px; background: #dcdbe6; } .doc b.hi { background: #c9f63f; } .doc b.h { height: 18px; background: #212121; }
.pole { position: absolute; width: 12px; background: #b07a3c; }
</style>${worldSvg(mood, W, H, G, hills, seed, { clearTop: top - 40, clearBottom: top + 190, words: [M, top - 20, W - M, top + 200] })}${body}
<div class="text"><h1 style="font-size:${size}px">${title}</h1>${line ? `<p style="font-size:${lineSize}px">${line}</p>` : ''}</div>
<script>(async()=>{await document.fonts.ready;const h=document.querySelector('h1');let f=parseFloat(h.style.fontSize);while(h.scrollWidth>h.clientWidth+1||h.getBoundingClientRect().height>f*1.1){f-=2;h.style.fontSize=f+'px'}document.body.dataset.ready=1})()</script>`;
}


const S = {};
const crew = (list, f) => list.map(([s, c, p, z, x, o = {}]) => bot(s, c, p, z, x, f(x), o)).join('');
// 1 home: the landing hero's title, kit standing in it like a letter (the bot's body box at 0.8em, on the baseline), the
// rest of the team evenly spaced on the hill, no chat
{ const G = 540, hl = [hill(600, 560, 40)], f = footOn(G, hl);
  const kit = botSvg('kit', 'violet', 'open', { grid: 26 }).svg(100).replace(/viewBox="[^"]*"/, 'viewBox="0 0 26 26"').replace(/width="[^"]*" height="[^"]*"/, 'width="0.8em" height="0.8em"').replace('style="', 'style="display:inline-block;vertical-align:-0.11em;margin:0 0.06em;overflow:visible;');
  S.home = page({ G, hills: hl, seed: 'home-b', title: `meet ${kit} Metal`, line: 'your own team of ai bots, in a chat app.', size: 128, top: 92,
    body: crew([['pip', 'blue', 'wink', 116, 270], ['mochi', 'pink', 'heart', 116, 435], ['loaf', 'tangerine', 'happy', 132, 600], ['starry', 'sun', 'happy', 116, 765], ['goo', 'mint', 'wink', 116, 930]], f) }); }
// 2 pricing: the whole crew gathered round the sign
{ const G = 540, hl = [hill(600, 560, 44)], f = footOn(G, hl);
  S.pricing = page({ G, hills: hl, seed: 'pricing', title: 'a whole ai team, free on your laptop', line: 'they run on your computer. no meter ticking.', size: 96,
    body: `<div class="pole" style="left:594px;top:318px;height:${f(600) - 318}px"></div><div class="sign" style="left:480px;top:290px;width:240px;height:92px;font-size:42px">free. really.</div>` +
      crew([['egg', 'mint', 'happy', 96, 190], ['cheep', 'sun', 'wink', 100, 320], ['loaf', 'tangerine', 'happy', 130, 450], ['hearty', 'pink', 'heart', 130, 750], ['pip', 'blue', 'big', 110, 880], ['tofu', 'violet', 'happy', 96, 1010]], f) }); }
// 3 download: the crew popping up from the bottom edge
{ S.download = page({ G: H + 24, seed: 'download', title: 'your new coworkers are ready', line: 'for mac, windows, linux and your phone.', size: 108,
    body: [['boxo', 'tangerine', 'big', 200, 215, -4], ['hop', 'emerald', 'look', 220, 405, 6], ['pip', 'blue', 'happy', 280, 600, 0], ['mochi', 'pink', 'heart', 210, 800, -6], ['kit', 'violet', 'wink', 210, 990, 4]]
      .map(([s, c, p, z, x, r]) => bot(s, c, p, z, x, H + Math.round(z * 0.12), { rot: r })).join('') }); }
// 4 docs: a small open notebook low on the hill with a bot reading over it, a friend sitting on a stack of books. the art is
// a third (notebook, books) or a fifth (magnifier) of its file, the bots a whole number of pixels per cell
{ const G = 540, hl = [hill(600, 520, 40)], f = footOn(G, hl);
  const nbFoot = f(620) + 4, booksFoot = f(430) + 4;
  S.docs = page({ G, hills: hl, seed: 'docs', title: 'everything your bots can do', line: 'in plain words, no jargon.', size: 100,
    body: bot('pip', 'blue', 'focus', 132, 620, nbFoot - 98) + img('s-notebook.webp', 126, 620, nbFoot, 520, 378) +
      img('s-books.webp', 68, 430, booksFoot, 420, 203) + bot('cheep', 'sun', 'happy', 88, 430, booksFoot - 60) +
      img('kit/p-magnifier.webp', 84, 780, f(780), 298, 419) }); }
// 5 about: the team photo on a cloud, with the one chat that explains it
{ S.about = page({ G: 610, seed: 'about', title: "who's behind the bots", line: 'a small team, and a lot of bots.', size: 108,
    body: `<img class="px" src="${A}/cloud-pink.png" style="left:270px;top:452px;width:660px;height:220px" alt="">` +
      [['hearty', 'pink', 'heart', 120, 420], ['pip', 'blue', 'happy', 120, 540], ['kit', 'violet', 'wink', 140, 670], ['sprout', 'emerald', 'happy', 120, 800]].map(([s, c, p, z, x]) => bot(s, c, p, z, x, 486)).join('') +
      bub('you', 'who made this?', 'left', '#fff3a0', 380) + bub('hearty', 'we did most of it.', 'right', '#ffc4dd', 380) }); }
// 6 changelog: the new trick: three bots balanced on each other's heads, the others cheering
{ const G = 540, hl = [hill(600, 520, 40)], f = footOn(G, hl);
  const base = f(600); let y = base, stack = '';
  for (const [s, c, p, z, k] of [['loaf', 'tangerine', 'big', 130, 0.72], ['pip', 'blue', 'happy', 104, 0.66], ['cheep', 'sun', 'wink', 84, 0]]) { stack += bot(s, c, p, z, 600, y); y -= Math.round(z * k); }
  S.changelog = page({ G, hills: hl, seed: 'changelog', title: 'the bots learned new tricks', line: "see what's new in every release.", size: 104,
    body: stack + crew([['mochi', 'pink', 'heart', 104, 330], ['goo', 'mint', 'happy', 96, 450], ['hoot', 'violet', 'big', 100, 760], ['starry', 'sun', 'happy', 100, 880, { rot: -8 }]], f) }); }
// 7 contact: a bot on the old pink desk phone, taking your call
{ const G = 540, hl = [hill(620, 360, 44)], f = footOn(G, hl);
  S.contact = page({ G, hills: hl, seed: 'contact', title: 'a human reads every message', line: 'write to hello@dusk.bot.', size: 100,
    body: img('s-phone.webp', 170, 700, f(700), 520, 387) + bot('drip', 'blue', 'happy', 150, 520, f(520)) + bub('you', 'hello? anyone there?', 'left', '#fff3a0', 410) + bub('Metal', 'yes. a real person.', 'right', '#d0cefb', 410) }); }
// 8 404: night, the moon, the crew asleep and one awake
{ const G = 540, hl = [hill(600, 520, 40)], f = footOn(G, hl);
  const moon = `<svg class="fx" style="left:1060px;top:262px" width="72" height="84" shape-rendering="crispEdges" fill="#fff3a0">${['..###.', '.##...', '##....', '##....', '##....', '.##...', '..###.'].map((row, y) => [...row].map((c, x) => c === '#' ? `<rect x="${x * 12}" y="${y * 12}" width="12" height="12"/>` : '').join('')).join('')}</svg>`;
  S['404'] = page({ mood: 'night', G, hills: hl, seed: '404x', title: "you found the bots' secret room", line: "the page isn't here. the bots are.", size: 100,
    body: moon + crew([['loaf', 'tangerine', 'sleepy', 110, 330], ['goo', 'mint', 'sleepy', 110, 470], ['boo', 'violet', 'big', 170, 620], ['tofu', 'sun', 'sleepy', 110, 780], ['mochi', 'pink', 'sleepy', 100, 910]], f) +
      `<div class="fx" style="left:700px;top:330px;font:600 30px/1 'Geist Mono';color:#fff3a0">z z</div>` }); }
// 9 integrations: app marks floating round one happy bot, on teal
{ const G = 540, hl = [hill(600, 360, 40)], f = footOn(G, hl);
  const logos = [['gmail.png', 300, 300, -8], ['slack.png', 420, 380, 6], ['notion.png', 330, 452, 4], ['github.svg', 800, 300, 8], ['calendar.png', 700, 380, -5], ['linear.png', 790, 452, -6]];
  S.integrations = page({ mood: 'teal', G, hills: hl, seed: 'integrations', title: 'your bots already know your apps', line: 'gmail, slack, notion, github and more.', size: 100,
    body: logos.map(([l, x, y, r]) => tile(logo(l), 84, x, y, r)).join('') + bot('mochi', 'pink', 'heart', 180, 600, f(600)) }); }
// 10 alternatives hub: smaller words, more air; two bots back to back at the signpost
{ const G = 540, hl = [hill(600, 420, 42)], f = footOn(G, hl);
  S.alternatives = page({ G, hills: hl, seed: 'alternatives', title: 'before you pick an ai agent', line: 'honest side-by-sides, dated and sourced.', size: 80, top: 96, lineSize: 30,
    body: bot('tofu', 'tangerine', 'look', 140, 440, f(440), { flip: true }) + img('s-signpost.webp', 230, 600, f(600), 420, 545) + bot('pip', 'blue', 'look', 140, 760, f(760)) }); }
// 11 openclaw: a bot scouting with binoculars, the crew behind it
{ const G = 540, hl = [hill(640, 420, 44)], f = footOn(G, hl);
  S.openclaw = page({ G, hills: hl, seed: 'openclaw', title: 'tried openclaw? read this first', line: "for people who'd rather not run a server.", size: 96,
    body: crew([['mochi', 'pink', 'look', 90, 380], ['bruin', 'emerald', 'look', 90, 470]], f) + bot('starry', 'sun', 'wink', 170, 620, f(620)) + img('kit/p-binoculars.webp', 120, 780, f(780), 420, 406) }); }
// 12 guides hub: follow the leader: one bot with the map, the rest in a line behind
{ const G = 540, hl = [hill(600, 560, 36)], f = footOn(G, hl);
  S.guides = page({ G, hills: hl, seed: 'guides', title: 'ai agents, explained like a friend would', line: 'no hype. just how they really work.', size: 92,
    body: img('s-map.webp', 110, 860, f(860), 420, 277) + crew([['pip', 'blue', 'happy', 150, 700, { flip: true }], ['boxo', 'tangerine', 'look', 110, 540, { flip: true }], ['hearty', 'pink', 'look', 96, 420, { flip: true }], ['egg', 'mint', 'look', 84, 320, { flip: true }]], f) }); }
// 13 use-cases hub: a line of bots, each carrying its job
{ const G = 540, hl = [hill(600, 560, 36)], f = footOn(G, hl);
  const jobs = [['loaf', 'tangerine', 'happy', 's-mailbox.webp', 420, 506], ['pip', 'blue', 'focus', 'kit/p-chart.webp', 297, 419], ['mochi', 'pink', 'wink', 'kit/p-briefcase.webp', 420, 370], ['cheep', 'sun', 'happy', 's-clock.webp', 420, 405]];
  S['use-cases'] = page({ G, hills: hl, seed: 'use-cases', title: 'what would you hand off first?', line: 'the real jobs people give their bots.', size: 100,
    body: jobs.map(([s, c, p, file, w0, h0], i) => { const x = 230 + i * 245; return img(file, 112, x + 82, f(x + 82), w0, h0) + bot(s, c, p, 140, x, f(x)); }).join('') }); }
// 14 /run-claude-code-24-7: sunset; a closed laptop, one bot still at work beside it
{ const G = 540, hl = [hill(600, 460, 40)], f = footOn(G, hl);
  S['claude-code'] = page({ mood: 'dusk', G, hills: hl, seed: 'claude-code', title: 'claude code, even while you sleep', line: 'keep it working with your laptop shut.', size: 96,
    body: img('kit/p-laptop.webp', 150, 470, f(470), 420, 404) + bot('boxo', 'cyan', 'focus', 150, 690, f(690)) + bot('goo', 'mint', 'sleepy', 90, 850, f(850)) }); }
// 15 /integrations/gmail: the gmail tile and kit side by side on the hill, kit reporting in
{ const G = 540, hl = [hill(600, 460, 40)], f = footOn(G, hl), ts = 150, tx = 440, ty = f(tx + ts / 2) - ts - 6;
  S.gmail = page({ G, hills: hl, seed: 'gmail', title: 'your inbox, sorted before you wake up', line: 'a bot that files, flags and drafts in gmail.', size: 92,
    body: tile(logo('gmail.png'), ts, tx, ty, 0) + bot('kit', 'violet', 'happy', 132, 700, f(700)) +
      bub('you', 'anything urgent?', 'left', '#fff3a0', 400) + bub('kit', 'two. drafts are ready.', 'right', '#ffc4dd', 400) }); }

// which pages each card is for, and what it shows
const META = {
  home: { core: ['home', 'waitlist'], alt: 'meet Metal, with the purple cat bot standing beside the name, and five pixel bots on a hill under a blue pixel sky' },
  pricing: { core: ['pricing'], alt: 'a whole ai team, free on your laptop: six pixel bots on a hill around a sign saying "free. really."' },
  download: { core: ['download'], alt: 'your new coworkers are ready: five pixel bots popping up from the bottom of a blue pixel sky' },
  docs: { core: ['docs'], alt: 'everything your bots can do: a blue pixel bot reading over a big open notebook, a yellow bot sitting on a stack of books, a magnifying glass' },
  about: { core: ['about'], alt: "who's behind the bots: four pixel bots sitting on a cloud, chatting \"who made this?\" \"we did most of it.\"" },
  changelog: { core: ['changelog'], alt: 'the bots learned new tricks: three pixel bots balanced on each other\'s heads while the others cheer' },
  contact: { core: ['contact', 'support'], alt: 'a human reads every message: a blue pixel bot beside a pink desk phone, chatting "hello? anyone there?" "yes. a real person."' },
  404: { core: ['404'], alt: "you found the bots' secret room: pixel bots asleep on a hill at night under the moon, one ghost bot wide awake" },
  integrations: { seo: '/integrations', alt: 'your bots already know your apps: the gmail, slack, notion, github, calendar and linear marks floating around a pink pixel bot with heart eyes' },
  alternatives: { seo: '/alternatives', alt: 'before you pick an ai agent: two pixel bots back to back at a signpost, looking different ways' },
  openclaw: { seo: '/alternatives/openclaw', alt: 'tried openclaw? read this first: a yellow star bot scouting with binoculars, two small bots behind it' },
  guides: { seo: '/guides', alt: 'ai agents, explained like a friend would: a blue pixel bot leading a line of bots towards a map' },
  'use-cases': { seo: '/use-cases', alt: 'what would you hand off first? four pixel bots, each beside its job: a mailbox, a chart, a briefcase and a clock' },
  'claude-code': { seo: '/run-claude-code-24-7', alt: 'claude code, even while you sleep: a closed laptop under the moon at sunset, one pixel bot still working beside it, one asleep' },
  gmail: { seo: '/integrations/gmail', alt: 'your inbox, sorted before you wake up: a purple cat bot standing on a big gmail tile, chatting "anything urgent?" "two. drafts are ready."' },
};

// ---- every other page: one scene per family, filled in per page ----
const lower = (t) => String(t || '').toLowerCase();
const LOGO = (name) => ['svg', 'png'].map((e) => `${name}.${e}`).find((f) => fs.existsSync(path.join(D, 'public', 'landing', 'art', 'logos', f)));
// a tile with the app's mark, or its name when the site has no mark for it
const appTile = (name, label, size, x, y, rot = 0) => { const f = name && LOGO(name); return tile(f ? logo(f) : `<span style="font-size:${label.length <= 6 ? Math.round(size * 0.24) : Math.round(size * 0.17)}px">${lower(label)}</span>`, size, x, y, rot); };
// props from the kit, with their sizes
const PROPS = { 's-books': [420, 203], 's-button': [420, 630], 's-clock': [420, 405], 's-cloud': [420, 96], 's-coins': [420, 349], 's-computer': [520, 599], 's-key': [420, 288], 's-mailbox': [420, 506], 's-map': [420, 277], 's-mobile': [300, 567], 's-notebook': [520, 378], 's-palette': [420, 359], 's-parcel': [420, 431], 's-phone': [520, 387], 's-plug': [420, 377], 's-server': [420, 188], 's-signpost': [420, 545],
  'p-bag': [375, 419], 'p-binoculars': [420, 406], 'p-briefcase': [420, 370], 'p-bubbles': [420, 316], 'p-cap': [360, 419], 'p-chart': [297, 419], 'p-folder': [420, 360], 'p-house': [420, 401], 'p-laptop': [420, 404], 'p-magnifier': [298, 419], 'p-megaphone': [420, 333], 'p-mug': [313, 419], 'p-newspaper': [420, 316], 'p-receipt': [240, 418], 'p-shield': [368, 418] };
const PROP_WORDS = { 's-books': 'a stack of books', 's-clock': 'an alarm clock', 's-coins': 'a coin purse', 's-computer': 'a computer', 's-key': 'a key', 's-mailbox': 'a mailbox', 's-map': 'a map', 's-mobile': 'a phone', 's-notebook': 'an open notebook', 's-palette': 'a paint palette', 's-parcel': 'a parcel', 's-phone': 'a desk phone', 's-plug': 'a plug', 's-server': 'a server box', 's-signpost': 'a signpost', 's-button': 'a big button', 's-cloud': 'a cloud',
  'p-bag': 'a shopping bag', 'p-binoculars': 'binoculars', 'p-briefcase': 'a briefcase', 'p-bubbles': 'chat bubbles', 'p-cap': 'a graduation cap', 'p-chart': 'a chart', 'p-folder': 'a folder', 'p-house': 'a little house', 'p-laptop': 'a closed laptop', 'p-magnifier': 'a magnifying glass', 'p-megaphone': 'a megaphone', 'p-mug': 'a mug', 'p-newspaper': 'a newspaper', 'p-receipt': 'a receipt', 'p-shield': 'a shield' };
const prop = (name, h, cx, foot) => { const [w0, h0] = PROPS[name] || [420, 420]; return img(name.startsWith('p-') ? `kit/${name}.webp` : `${name}.webp`, h, cx, foot, w0, h0); };
// a crew picked from the page's address: shapes and colours that read on the blue sky and the lime meadow
const SHAPES_OK = ['pip', 'kit', 'hop', 'bruin', 'boo', 'mochi', 'loaf', 'cheep', 'goo', 'sprout', 'drip', 'hearty', 'starry', 'hoot', 'boxo', 'egg', 'wisp', 'tofu'];
const COLS = ['blue', 'violet', 'pink', 'coral', 'tangerine', 'sun', 'mint', 'emerald', 'indigo'];
const NAMES = { blue: 'blue', violet: 'purple', pink: 'pink', coral: 'coral', tangerine: 'orange', sun: 'yellow', mint: 'mint', emerald: 'green', indigo: 'indigo' };
function crewOf(seed, n) {
  const r = rng(`og6:${seed}`), out = [], used = new Set();
  while (out.length < n) { const sh = SHAPES_OK[Math.floor(r() * SHAPES_OK.length)], c = COLS[Math.floor(r() * COLS.length)]; if (used.has(sh) || used.has(c)) continue; used.add(sh); used.add(c); out.push([sh, c]); }
  return out;
}
const said = (c) => `${/^[aeiou]/.test(NAMES[c[1]]) ? 'an' : 'a'} ${NAMES[c[1]]} pixel bot`;

// each family's scene: (page) => { body, alt }. G 540, one hill in the middle
const G0 = 556, hl0 = [hill(600, 560, 36)], f0 = footOn(G0, hl0), K = 1.32;
const FAM = {
  // an app page (and each of its actions): the app's tile left of centre, a bot to its right. one bot per app
  app: (p) => { const [b] = crewOf(p.app, 1), ts = 150, tx = 440; return { body: appTile(p.logo, p.appName, ts, tx, f0(tx + ts / 2) - ts - 6) + bot(b[0], b[1], 'happy', 132, 700, f0(700)),
    alt: `${said(b)} standing beside the ${p.appName} mark on a hill under a blue pixel sky` }; },
  // an alternatives page: the rival's name on a tile, a signpost, a bot weighing it up
  rival: (p) => { const [b, c] = crewOf(p.seed, 2), ts = 136;
    const left = p.label ? appTile(null, p.label, ts, 330, f0(398) - ts - 6, -4) : bot(c[0], c[1], 'look', 120, 400, f0(400), { flip: true });
    return { body: left + prop('s-signpost', 170, 600, f0(600)) + bot(b[0], b[1], 'look', 132, 790, f0(790), { flip: true }),
      alt: `${said(b)} at a signpost${p.label ? `, looking at a tile saying ${p.label}` : ', back to back with another bot'}, on a hill under a blue pixel sky` }; },
  // a one-on-one: a bot, a vs badge, the other side's name on a tile
  vs: (p) => { const [b] = crewOf(p.seed, 1), ts = 140; return { body: bot(b[0], b[1], 'big', 140, 450, f0(450)) + `<div class="vs" style="left:562px;top:${f0(600) - 110}px">vs</div>` + appTile(null, p.label || 'them', ts, 680, f0(750) - ts - 6, 3),
    alt: `${said(b)} facing a tile saying ${p.label}, with a vs badge between them, on a hill under a blue pixel sky` }; },
  // a use case: a bot with the job's object, a helper looking on
  usecase: (p) => { const [b, c] = crewOf(p.seed, 2); return { body: bot(c[0], c[1], 'look', 96, 400, f0(400)) + bot(b[0], b[1], 'happy', 140, 560, f0(560)) + prop(p.props[0], 128, 740, f0(740)),
    alt: `${said(b)} with ${PROP_WORDS[p.props[0]]}, another bot looking on, on a hill under a blue pixel sky` }; },
  // a role: the job's object in the middle, a bot either side
  role: (p) => { const [b, c] = crewOf(p.seed, 2); return { body: bot(b[0], b[1], 'wink', 128, 420, f0(420)) + prop(p.props[0], 140, 600, f0(600)) + bot(c[0], c[1], 'happy', 112, 780, f0(780), { flip: true }),
    alt: `two pixel bots either side of ${PROP_WORDS[p.props[0]]}, on a hill under a blue pixel sky` }; },
  // a routine: the object that sets it off, a bot at work, one asleep
  routine: (p) => { const [b, c] = crewOf(p.seed, 2); return { body: prop(p.props[0], 124, 440, f0(440)) + bot(b[0], b[1], 'focus', 132, 620, f0(620)) + bot(c[0], c[1], 'sleepy', 86, 790, f0(790)),
    alt: `${said(b)} at work beside ${PROP_WORDS[p.props[0]]}, another bot asleep, on a hill under a blue pixel sky` }; },
  // a guide: follow the leader to the page's object
  guide: (p) => { const cr = crewOf(p.seed, 3); return { body: prop(p.props[0], 116, 820, f0(820)) + bot(cr[0][0], cr[0][1], 'happy', 136, 660, f0(660), { flip: true }) + bot(cr[1][0], cr[1][1], 'look', 104, 500, f0(500), { flip: true }) + bot(cr[2][0], cr[2][1], 'look', 88, 380, f0(380), { flip: true }),
    alt: `three pixel bots in a line, heading for ${PROP_WORDS[p.props[0]]}, on a hill under a blue pixel sky` }; },
  // a glossary word: an open notebook, a bot reading over it
  word: (p) => { const [b] = crewOf(p.seed, 1), nb = f0(600) + 4; return { body: bot(b[0], b[1], 'focus', 132, 600, nb - 98) + prop('s-notebook', 126, 600, nb) + prop('s-books', 64, 420, f0(420) + 4),
    alt: `${said(b)} reading over an open notebook beside a stack of books, on a hill under a blue pixel sky` }; },
  // a tool: a chart and a bot working it out
  tool: (p) => { const [b] = crewOf(p.seed, 1); return { body: prop('p-chart', 140, 480, f0(480)) + bot(b[0], b[1], 'focus', 136, 660, f0(660)) + prop('s-coins', 80, 820, f0(820)),
    alt: `${said(b)} working something out beside a chart, on a hill under a blue pixel sky` }; },
  // a docs topic: its object, a bot beside it, a friend
  topic: (p) => { const [b, c] = crewOf(p.seed, 2);
    if (p.props[0] === 'cloud') return { body: `<img class="px" src="${A}/cloud-pink.png" style="left:420px;top:${f0(600) - 120}px;width:360px;height:120px" alt="">` + bot(b[0], b[1], 'happy', 120, 560, f0(600) - 92) + bot(c[0], c[1], 'wink', 92, 680, f0(600) - 92),
      alt: `two pixel bots sitting on a cloud, on a hill under a blue pixel sky` };
    return { body: prop(p.props[0], p.h || 140, 470, f0(470)) + bot(b[0], b[1], p.pose || 'happy', 136, 660, f0(660)) + bot(c[0], c[1], 'wink', 92, 820, f0(820)),
    alt: `${said(b)} beside ${PROP_WORDS[p.props[0]]}, a friend next to it, on a hill under a blue pixel sky` }; },
};
// the scene is drawn at a comfortable size, then grown by K around the top of the hill so it fills the meadow
const familyCard = (kind, p) => { const { body, alt } = FAM[kind](p); return { html: page({ G: G0, hills: hl0, seed: p.seed, title: p.title, line: p.line, size: 100,
  body: `<div style="position:absolute;inset:0;transform:scale(${K});transform-origin:600px ${f0(600)}px">${body}</div>` }), alt: `${p.title}: ${alt}` }; };

// short titles: from each record, six words or so, never the long seo title. a few pages are written by hand
const TITLES = {
  '/agents-when-laptop-closed': "your laptop's shut. your bots aren't.", '/ai-agent-that-controls-your-computer': 'give your bot its own computer',
  '/ai-chief-of-staff': 'an ai chief of staff', '/ai-employees': 'ai employees, minus the hype', '/ai-executive-assistant': 'an assistant that preps your day',
  '/ai-group-chat': 'a group chat with your bots', '/ai-teammates': 'ai teammates with clear jobs', '/claude-code-from-your-phone': 'claude code, from your phone',
  '/personal-ai-agent': 'a personal ai agent, done right', '/scheduled-ai-tasks': 'ai tasks that run themselves', '/use-your-ai-subscription': 'put your ai plan to work',
  '/guides/apps-that-use-your-ai-subscription': 'who can use your ai plan?', '/guides/is-it-safe-to-let-ai-use-your-computer': 'should ai use your computer?',
  '/guides/claude-plan-vs-api': 'your claude plan, or the api?', '/guides/claude-cowork-pricing': 'what claude cowork really costs',
  '/tools/always-on-cost': 'what does always-on really cost?', '/for/real-estate-agents': 'an ai team for realtors', '/for/small-business-owners': 'an ai team for small businesses',
  '/alternatives/openclaw-hosting': 'hosting openclaw? read this first',
};
const words = (t) => t.trim().split(/\s+/).length, pre = (h) => h.split(/[:?]/)[0].trim() + (h.includes('?') && !h.split('?')[0].includes(':') ? '?' : '');
function shortTitle(r) {
  if (TITLES[r.path]) return TITLES[r.path];
  const app = lower(r.app?.name || r.art?.label || r.action?.toolkit), p = pre(r.h1), nav = lower(r.nav);
  switch (r.type) {
    case 'integration': return `${app}, handled by your bots`;
    case 'action': return words(`${nav} in ${app}`) <= 6 ? `${nav} in ${app}` : nav;
    case 'alternative': return /alternative/.test(r.h1) && r.art?.label ? `tried ${lower(r.art.label)}? read this first` : words(p) <= 6 ? p : nav;
    case 'comparison': return / vs /.test(p) && words(p) <= 6 ? p : `${lower(r.art?.label || nav)} vs Metal`;
    case 'role': return `an ai team for ${nav}`;
    case 'routine': return words(p) <= 6 ? p : `${nav}, on repeat`;
    case 'use-case': return words(p) <= 6 ? p : `${nav}, handed to a bot`;
    default: return words(p) <= 6 ? p : nav;
  }
}
const KIND = { integration: 'app', action: 'app', alternative: 'rival', comparison: 'vs', 'use-case': 'usecase', role: 'role', routine: 'routine', guide: 'guide', pillar: 'guide', glossary: 'word', tool: 'tool' };
const handSeo = new Set(Object.values(META).map((m) => m.seo).filter(Boolean));
const sceneId = (at) => at.replace(/^\//, '').replace(/\//g, '--');
const records = loadRecords();
for (const r of records) {
  if (handSeo.has(r.path)) continue;
  const app = r.type === 'integration' ? r.app?.toolkit : r.type === 'action' ? r.action?.toolkit : null;
  const appRec = app && records.find((o) => o.type === 'integration' && o.app?.toolkit === app);
  const appName = appRec?.app?.name || r.art?.label || app;
  const c = familyCard(KIND[r.type], { seed: r.path, app: app || r.path, logo: (appRec || r).art?.logo, appName, label: r.art?.label, props: r.art?.props?.length ? r.art.props : ['s-notebook'], title: shortTitle(r), line: r.og_line });
  const id = sceneId(r.path); S[id] = c.html; META[id] = { seo: r.path, alt: c.alt };
}
// the hubs without a hand-set card
const HUB = {
  '/routines': ['routine', 'jobs your bots do on repeat', 'copy a routine. paste it in a chat.', ['s-clock']],
  '/glossary': ['word', 'ai agent words, minus the jargon', 'short definitions, each with an example.', []],
  '/tools': ['tool', 'free tools for planning bots', 'small helpers that run in your browser.', []],
};
for (const [at, [kind, title, line, props]] of Object.entries(HUB)) { if (handSeo.has(at) || !Object.values(HUBS).some((h) => h.at === at)) continue; const c = familyCard(kind, { seed: at, title, line, props }); const id = sceneId(at); S[id] = c.html; META[id] = { seo: at, alt: c.alt }; }
// docs: each page's own title and line, its topic's picture
const DOC_ART = { 'getting-started': ['s-signpost', 'happy', 180], bots: ['p-bubbles', 'wink'], 'group-chats': ['p-bubbles', 'happy'], tips: ['p-mug', 'wink'], computer: ['s-computer', 'focus', 160], 'files-and-apps': ['p-folder', 'focus'],
  'dusk-cloud': ['cloud', 'happy'], phone: ['s-mobile', 'happy', 160], 'your-own-server': ['s-server', 'focus', 90], routines: ['s-clock', 'sleepy'], memory: ['s-notebook', 'focus', 120], 'privacy-and-data': ['p-shield', 'focus'],
  'account-and-billing': ['s-key', 'happy', 100], troubleshooting: ['p-magnifier', 'big'], faq: ['p-magnifier', 'look'] };
// each docs card's line, ten words at most (the page's own description is longer)
const DOC_LINES = {
  'account-and-billing': 'what is free, and how to change or cancel.', bots: 'make a bot, pick its ai, talk to it.',
  computer: 'its own browser and desktop. take the mouse anytime.', 'dusk-cloud': 'a computer we host, so bots work with the lid shut.',
  faq: 'the short answers, with a link to the long one.', 'files-and-apps': 'give it files, and plug it into your apps.',
  'getting-started': 'from nothing to a bot doing real work.', 'group-chats': 'several bots in one thread, handing work along.',
  memory: 'plain notes you can read, edit and delete.', phone: 'text your bots and hear back, from anywhere.',
  'privacy-and-data': 'what stays on your machine, and what leaves it.', routines: 'ask once. it runs on a schedule, or on cue.',
  tips: 'the habits that turn a bot into a teammate.', troubleshooting: 'the usual hiccups, and what to do about each.',
  'your-own-server': 'paste one line. your bots live on your server.',
};
for (const f of fs.readdirSync(path.join(D, 'pages', 'docs')).filter((x) => x.endsWith('.md')).sort()) {
  const name = f.slice(0, -3), m = fs.readFileSync(path.join(D, 'pages', 'docs', f), 'utf8').match(/^---\n([\s\S]*?)\n---/);
  const meta = Object.fromEntries(m[1].split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.trim()]));
  const [art, pose, h] = DOC_ART[name] || ['s-notebook', 'focus', 120];
  const line = DOC_LINES[name] || meta.description;
  const c = familyCard('topic', { seed: `/docs/${name}`, title: `docs: ${meta.title}`, line, props: [art], pose, h });
  const id = `docs--${name}`; S[id] = c.html; META[id] = { core: [id], alt: c.alt };
}
// brand and the legal pages
{ const sw = ['#c9f63f', '#fff3a0', '#ffc4dd', '#d0cefb', '#1b1b1f'].map((c, i) => `<div class="tile" style="left:${612 + i * 58}px;top:${f0(700) - 52}px;width:46px;height:46px;border-radius:10px;background:${c}"></div>`).join('');
  S.brand = page({ G: G0, hills: hl0, seed: 'brand', title: 'the bots, the mark, the colours', line: 'everything you need to write about Metal.', size: 100,
    body: `<div style="position:absolute;inset:0;transform:scale(${K});transform-origin:600px ${f0(600)}px">${tile(`<img src="${A}/mark-320.webp" alt="">`, 96, 352, f0(400) - 102) + bot('kit', 'violet', 'wink', 130, 530, f0(530)) + sw}</div>` });
  META.brand = { core: ['brand'], alt: 'the bots, the mark, the colours: the Metal mark, a purple cat bot winking and five colour swatches, on a hill under a blue pixel sky' }; }
{ const c = familyCard('topic', { seed: '/legal', title: 'the fine print, in plain words', line: 'terms, privacy, license and security.', props: ['p-shield'], pose: 'focus' });
  S.legal = c.html; META.legal = { core: ['legal', 'terms', 'privacy', 'license', 'security', 'delete-account'], alt: c.alt }; }

fs.mkdirSync(OUT, { recursive: true });
for (const [k, v] of Object.entries(S)) fs.writeFileSync(`${OUT}/${k}.html`, v);
const hash = (t) => createHash('sha256').update(t.replaceAll(`file://${D}/`, '/')).digest('hex').slice(0, 16);
fs.writeFileSync(path.join(D, 'seo', 'art', 'og6.json'), JSON.stringify(Object.keys(S).map((id) => ({ id, ...META[id], hash: hash(S[id]) })), null, 1) + '\n');
console.log(`${Object.keys(S).length} cards`);
