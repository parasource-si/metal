// the waitlist page: the x banner's sky and meadow with pip on its hill, drawn once on a canvas sized to the section
// (and again when it changes size), then the form, sent to /api/waitlist. pip blinks, and hops when you join
{
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hero = $('[data-wl]');

const P = { sky0: '#06bafd', sky1: '#3cd0fd', sky4: '#90e4fc', sky5: '#c2ecfc', lilac: '#d0cefb', lime: '#c9f63f', lime2: '#c6f43a', white: '#fdfdfd', pink: '#ffc4dd', lemon: '#fff3a0', lemonDeep: '#ffe25c' };
let seed = 7;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

if (hero) {
  const cv = $('.wl-sky', hero), ctx = cv.getContext('2d'), col = $('[data-wl-col]', hero), ground = $('[data-wl-ground]', hero), hill = $('[data-wl-hill]', hero);
  const b = 10;
  let W = 0, H = 0;

  // the still picture, as the x banner draws it (omb-ref/brand/x-banners/lib/world.js): the logo sky with its middle
  // scatter strip left out, so the words sit on one clean blue; a lilac line; the meadow rising into pip's hill;
  // grass flecks and flowers; and each chat bubble's stepped tail
  function layout() {
    const box = hero.getBoundingClientRect();
    W = Math.ceil(box.width); H = Math.ceil(box.height);
    if (!W || !H) return false;
    const snap = (v) => Math.round(v / b) * b, s = b / 2;
    cv.width = W; cv.height = H;
    const G = snap(ground.getBoundingClientRect().top - box.top);
    const shown = [...col.children].filter((el) => el.offsetParent), first = shown[0].getBoundingClientRect(), lastEl = shown[shown.length - 1].getBoundingClientRect();
    const top = first.top - box.top, bottom = lastEl.bottom - box.top;
    const f = (t) => snap(t * G);
    const bands = [[P.sky0, 0], [P.sky1, Math.min(f(0.2), snap(top - 4 * b))], [P.sky4, Math.max(f(0.8), snap(bottom + 4 * b))], [P.sky5, Math.max(f(0.9), snap(bottom + 7 * b))], [P.lilac, G - b]].filter((band, i, all) => i === 0 || band[1] > all[i - 1][1]);
    ctx.imageSmoothingEnabled = false;
    bands.forEach(([c, y], i) => { ctx.fillStyle = c; ctx.fillRect(0, y, W, (bands[i + 1]?.[1] ?? G) - y); });
    seed = 11;
    for (let i = 1; i < bands.length - 1; i++) {
      const [c, y] = bands[i], [cp] = bands[i - 1];
      [0.42, 0.16, 0.05].forEach((p, k) => {
        for (let x = 0; x < W; x += b) {
          if (rnd() < p) { ctx.fillStyle = c; ctx.fillRect(x, y - (k + 1) * b, b, b); }
          if (k === 0 && rnd() < 0.1) { ctx.fillStyle = cp; ctx.fillRect(x, y, b, b); }
        }
      });
    }
    const hb = hill.getBoundingClientRect(), hx = hb.left - box.left + hb.width / 2, half = hb.width / 2, rise = hb.height;
    ctx.fillStyle = P.lime;
    for (let x = 0; x < W; x += b) {
      const d = Math.abs(x + b / 2 - hx) / half, y = d < 1 ? snap(G - rise * (1 - d * d) ** 0.7) : G;
      ctx.fillRect(x, y, b, H - y);
    }
    seed = 4; ctx.fillStyle = P.lime2;
    for (let i = 0, n = Math.round((W * (H - G)) / 1100); i < n; i++) ctx.fillRect(Math.round((rnd() * W) / s) * s, Math.round((G + b + rnd() * (H - G - b)) / s) * s, s * (rnd() < 0.5 ? 2 : 1), s);
    seed = 2;
    const cols = [P.white, P.pink, P.lemon];
    for (let i = 0, n = Math.max(6, Math.round(W / 110)); i < n; i++) {
      const x = Math.round((rnd() * W) / s) * s, y = Math.round((G + 3 * b + rnd() * (H - G - 5 * b)) / s) * s;
      ctx.fillStyle = cols[i % 3];
      ctx.fillRect(x, y - s, s, s); ctx.fillRect(x - s, y, s, s); ctx.fillRect(x + s, y, s, s); ctx.fillRect(x, y + s, s, s);
      ctx.fillStyle = i % 3 === 2 ? '#ffb020' : P.lemonDeep; ctx.fillRect(x, y, s, s);
    }
    for (const bub of $$('.wl-bub', hero)) {
      if (!bub.offsetParent) continue;
      const r = bub.getBoundingClientRect(), x = Math.round((r.left - box.left) / s) * s, w = Math.round(r.width / s) * s, y = Math.round((r.bottom - box.top) / s) * s;
      const right = bub.classList.contains('b-pip'), under = getComputedStyle(bub).getPropertyValue('--u').trim() || P.pink;
      const tx = right ? x + w - 9 * s : x + 5 * s;
      for (let i = 0; i < 4; i++) {
        const xx = right ? tx + i * s : tx - i * s + 3 * s;
        ctx.fillStyle = under; ctx.fillRect(xx, y + i * s, (4 - i) * s, s);
        ctx.fillStyle = P.white; ctx.fillRect(xx, y - 2 * s + i * s, (4 - i) * s, s);
      }
    }
    return true;
  }

  let queued = 0;
  const redo = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; layout(); }); };
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(redo); ro.observe(hero); ro.observe(col); } else addEventListener('resize', redo);
  document.fonts?.ready.then(redo);
  // the column's box stays put when its words change, so joining asks for a new picture itself
  hero.addEventListener('wl:layout', redo);
  layout();
}

// the form
const form = $('[data-wl-form]');
if (form) {
  const input = $('#wl-email', form), go = $('[data-wl-go]', form), msg = $('#wl-msg', form), label = go.textContent;
  const title = $('[data-wl-title]'), lede = $('[data-wl-lede]'), done = $('[data-wl-done]');
  const params = new URLSearchParams(location.search);
  const source = params.get('source') || params.get('utm_source') || 'site', ref = params.get('ref') || '';
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const COPY = {
    bad_email: "that doesn't look like an email address. check it for a typo and try again.",
    empty: 'type your email first, then join.',
    offline: "that didn't reach us. check your connection and try again.",
  };

  const showError = (text) => {
    msg.hidden = true;
    $('[data-wl-err]', msg).textContent = text;
    // unhidden on the next frame, so a second error in a row is read out again
    requestAnimationFrame(() => { msg.hidden = false; hero.dispatchEvent(new Event('wl:layout')); });
    form.dataset.bad = '';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };
  const clearError = () => { msg.hidden = true; delete form.dataset.bad; input.removeAttribute('aria-invalid'); hero.dispatchEvent(new Event('wl:layout')); };
  input.addEventListener('input', () => { if (!msg.hidden) clearError(); });

  // "n people waiting" only once there are enough of them to say so
  fetch('/api/waitlist/count').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d || !(d.count >= 50)) return;
    const c = $('[data-wl-count]', form);
    c.textContent = `${d.count.toLocaleString('en')} people waiting · free forever`; c.hidden = false;
  }).catch(() => {});

  function cheer() {
    const pip = $('.wl-pip svg.bot');
    if (window.duskBots && pip) window.duskBots.react(pip, 'boing');
    const ticket = $('.wl-ticket');
    if (still || !ticket) return;
    // a burst of little squares off the top of the ticket, the same sparks a poke makes elsewhere on the site
    const r = ticket.getBoundingClientRect(), colours = ['#fdfdfd', '#fff3a0', '#ffc4dd', '#c9f63f', '#d0cefb'];
    for (let i = 0; i < 18; i++) {
      const sp = document.createElement('i'), a = -Math.PI * (0.04 + 0.92 * (i / 17)) + (Math.random() - 0.5) * 0.3, d = 70 + Math.random() * 70;
      sp.className = 'spark'; sp.style.background = colours[i % colours.length];
      sp.style.left = `${r.left + r.width / 2 + scrollX - 4}px`; sp.style.top = `${r.top + 8 + scrollY - 4}px`;
      sp.style.setProperty('--dx', `${(Math.cos(a) * d).toFixed(0)}px`); sp.style.setProperty('--dy', `${(Math.sin(a) * d).toFixed(0)}px`);
      document.body.append(sp); setTimeout(() => sp.remove(), 760);
    }
  }

  function joined(position, email, already) {
    $$('[data-wl-num]').forEach((el) => { el.textContent = `#${position.toLocaleString('en')}`; });
    title.textContent = "you're on the list.";
    lede.textContent = '';
    lede.append(already ? 'you were already on it. ' : '', "we'll write to ", Object.assign(document.createElement('b'), { textContent: email }), " when it's your turn.");
    form.hidden = true; done.hidden = false; hero.classList.add('is-done');
    hero.dispatchEvent(new Event('wl:layout'));
    document.title = "You're on the list · Metal";
    title.focus();
    cheer();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (go.disabled) return;
    const email = input.value.trim();
    if (!email) return showError(COPY.empty);
    if (email.length > 254 || !EMAIL.test(email)) return showError(COPY.bad_email);
    clearError();
    go.disabled = true; go.textContent = 'joining…'; form.setAttribute('aria-busy', 'true');
    try {
      const r = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, source, ref: ref || undefined, website: $('#wl-website', form).value }) });
      const d = await r.json().catch(() => ({}));
      if (d.ok) { window.dusk?.('waitlist_saved'); return joined(d.position, email.toLowerCase(), d.already); }
      window.dusk?.('waitlist_failed', { label: String(d.error || r.status).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30) });
      showError(d.message || COPY.offline);
    } catch {
      window.dusk?.('waitlist_failed', { label: 'offline' });
      showError(COPY.offline);
    } finally {
      go.disabled = false; go.textContent = label; form.removeAttribute('aria-busy');
    }
  });
}
}
