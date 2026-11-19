// the inner pages: copy buttons, the download page's "which system are you on", the billing switch, and what the bots do
{
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const later = (ms, fn) => setTimeout(fn, ms);
const bots = () => window.duskBots;
// runs fn the first time enough of el is on screen
function once(el, fn, threshold = 0.4) {
  if (!el || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold });
  io.observe(el);
}

// copy: a button with data-copy copies its own value, or else the command it sits beside
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
for (const b of $$('[data-copy]')) b.addEventListener('click', async () => {
  const label = b.dataset.label ||= b.textContent, box = b.closest('.code, .blurb, .m-cmd, figure') || b.parentElement, from = $('code, p', box);
  const ok = await copy(b.dataset.copy || from.textContent.trim());
  if (!ok) getSelection().selectAllChildren(from);
  b.textContent = ok ? 'copied' : 'selected'; b.classList.add('done');
  later(1600, () => { b.textContent = label; b.classList.remove('done'); });
});
// people click the command itself, not the button beside it: a click anywhere on it copies, unless they are selecting
for (const pre of $$('.code > pre')) {
  const b = $(':scope > .copy', pre.parentElement);
  if (b) pre.addEventListener('click', () => { if (String(getSelection()).trim() === '') b.click(); });
}

// download: the big button is a plain link to the file for this computer, so a click starts it at once, and its row in
// the list is marked yours. on a phone the app cannot be installed, so it offers the iphone app and a way to send yourself the link
const dl = $('[data-dl-page]');
if (dl) {
  const go = $('[data-dl-go]', dl), label = $('[data-dl-label]', dl), note = $('[data-dl-note]', dl), mark = $('.dl-os', dl);
  const version = note?.textContent.split(' · ').pop();
  window.duskBuild?.().then((key) => {
    if (!go) return;
    if (key === 'phone') {
      // on a phone: the iphone app first, and the computer download sent to yourself for later
      const ph = $('[data-dl-phone]', dl), form = $('[data-dl-mail]', dl);
      if (!ph) return;
      $('.dl-cta', dl).hidden = true; note.hidden = true; ph.hidden = false;
      if (/android/i.test(navigator.userAgent)) for (const x of $$('[data-dl-ios], [data-dl-android]', ph)) x.hidden = !x.hidden;
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const to = form.email.value.trim(), link = `${location.origin}/download`;
        location.href = `mailto:${encodeURIComponent(to).replace('%40', '@')}?subject=${encodeURIComponent('Metal for your computer')}&body=${encodeURIComponent(`download Metal on your computer: ${link}`)}`;
      });
      return;
    }
    const row = $(`#all [data-key="${key}"]`);
    if (!row) return;
    row.classList.add('is-yours');
    go.href = $('a', row).href;
    label.textContent = `download for ${$('.dl-name b', row).textContent}`;
    mark.replaceChildren($('.os', row).cloneNode(true));
    note.textContent = `${row.dataset.note} · ${version}`;
  });
}

// monthly or yearly: the white pill is a full-size layer cut down with clip-path, and the prices count to their new value
const bill = $('[data-bill]');
if (bill) {
  const btns = $$('button', bill), ind = $('.seg-ind', bill);
  const place = () => {
    const b = btns.find((x) => x.getAttribute('aria-pressed') === 'true');
    ind.style.clipPath = `inset(${b.offsetTop}px ${bill.clientWidth - b.offsetLeft - b.offsetWidth}px ${bill.clientHeight - b.offsetTop - b.offsetHeight}px ${b.offsetLeft}px round 999px)`;
  };
  place(); bill.classList.add('is-on');
  if ('ResizeObserver' in window) new ResizeObserver(place).observe(bill);
  bill.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.getAttribute('aria-pressed') === 'true') return;
    btns.forEach((x) => x.setAttribute('aria-pressed', x === b)); place();
    const k = b.dataset.period;
    for (const n of $$('.amt [data-m]')) {
      const from = Number(n.textContent), to = Number(n.dataset[k]), t0 = performance.now();
      cancelAnimationFrame(n.run);
      if (still) { n.textContent = to; continue; }
      const tick = (t) => { const p = Math.min(1, (t - t0) / 380), e2 = 1 - (1 - p) ** 4; n.textContent = Math.round(from + (to - from) * e2); if (p < 1) n.run = requestAnimationFrame(tick); };
      n.run = requestAnimationFrame(tick);
    }
    for (const n of $$('.per[data-m]')) n.textContent = n.dataset[k];
    for (const a of $$('a[href*="/signup?plan="]')) { const u = new URL(a.href); u.searchParams.set('period', k === 'y' ? 'year' : 'month'); a.href = u.href; }
    bots()?.react($('.ph-islands'), 'hop');
  });
}

// brand colours: a tap copies the hex
for (const b of $$('.swatches button')) b.addEventListener('click', async () => {
  const code = $('code', b.parentElement), hex = code.textContent;
  if (await copy(hex)) { code.textContent = 'copied'; later(1200, () => { code.textContent = hex; }); }
});

// the bots. mascot.js gives each one its eyes, blinks and its answer to a tap; here is what they do on these pages
addEventListener('load', () => {
  const B = bots();
  if (!B || still) return;
  // the ones standing in a strip say hi one after another the first time the strip is seen
  for (const strip of $$('.strip')) once(strip, () => $$('.pb .bot', strip).forEach((b, i) => later(350 + i * 170, () => B.react(b, i % 2 ? 'hop' : 'greet'))), 0.5);
  // lost: the one on the island does not know where it is either
  const lost = $('.ph-lost .bot'); if (lost) B.state(lost, 'confused');
  const zero = $('.code-404 .bot'); if (zero) { B.state(zero, 'surprised'); later(2600, () => B.state(zero, 'curious')); }
  // nothing new yet: asleep until poked
  const sleepy = $('.sleepy .bot');
  if (sleepy) { B.state(sleepy, 'sleeping'); sleepy.addEventListener('click', () => { B.state(sleepy, 'waking'); $$('.sleepy .zz').forEach((z) => z.remove()); later(1600, () => B.state(sleepy, 'happy')); }, { once: true }); }
  // questions: the listener tilts its head when one opens, then nods
  const listener = $('.listener .bot');
  if (listener) {
    let nod = 0;
    for (const d of $$('.qs details')) d.addEventListener('toggle', () => {
      if (!d.open) return;
      clearTimeout(nod); B.state(listener, 'curious');
      nod = later(2200, () => { B.state(listener, 'idle'); B.react(listener, 'nod'); });
    });
  }
  // a row or a tile with a bot in it: pointing at it gets a small answer
  if (fine) for (const el of $$('.crew li, .m-row, .note-row, .doc-help, .doc-next a')) el.addEventListener('pointerenter', () => B.react(el.matches('.doc-next a') ? $('.doc-help') : el, 'open'));
  // a copied command: whoever is nearest is pleased about it
  for (const b of $$('[data-copy]')) b.addEventListener('click', () => { const near = $('.doc-help .bot') || $('.pb .bot'); if (near) B.react(near, 'hop'); });
  // the download page: the bots by the waterfall work until the button is pressed, then celebrate
  const go = $('.dl-main .btn');
  if (go) go.addEventListener('click', () => $$('.ph-falls .bot').forEach((b, i) => later(i * 90, () => B.react(b, 'celebrate'))));
  // the pond: now and then one of them hops on its lily pad
  const pond = $$('.ph-pond .bot');
  if (pond.length) setInterval(() => { if (!document.hidden) B.react(pond[Math.floor(Math.random() * pond.length)], 'hop'); }, 4200);
});


// the footer knows what time it is
const dusk = $('[data-dusk]'), hour = new Date().getHours();
if (dusk && hour >= 17 && hour < 20) dusk.textContent = "it's dusk where you are. the bots are just getting started.";
else if (dusk && hour < 5) dusk.textContent = "it's late. the bots are still up, you don't have to be.";
}
