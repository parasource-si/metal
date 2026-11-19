import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** How long a page that shows its own waiting mascot keeps the splash up before it takes over. */
export const BOOT_SHELL_HANDOFF_MS = 600;
export const CROSSFADE_MS = 280;
export const STUCK_AFTER_MS = 45_000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The app fades in over the splash while the splash fades out, eased out. */
async function crossfade(win, splash) {
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / CROSSFADE_MS), eased = 1 - (1 - t) ** 3;
    if (win.isDestroyed()) return;
    win.setOpacity(eased);
    if (!splash.isDestroyed()) splash.setOpacity(1 - eased);
    if (t === 1) return;
    await wait(16);
  }
}

const W = 480, H = 300;
const resource = name => fileURLToPath(new URL(`./resources/${name}`, import.meta.url));
const font = `data:font/woff2;base64,${readFileSync(resource("general-sans.woff2")).toString("base64")}`;
/** The five mascots' pixel bodies on their 16 grid, one eye shape per pose. */
const SPRITES = JSON.parse(readFileSync(resource("startup-crew.json"), "utf8"));

export const THEMES = Object.freeze({
  light: Object.freeze({ bg: "#fafbfc", ink: "#1b1b1f", soft: "#5d5f68", track: "#1b1b1f12", ghost: "#1b1b1f0f", shadow: "#1b1b1f14", hover: "#1b1b1f0f", kitEyes: "#ffffff" }),
  dark: Object.freeze({ bg: "#141418", ink: "#f2f3f5", soft: "#a3a6b0", track: "#ffffff14", ghost: "#ffffff12", shadow: "#00000059", hover: "#ffffff14", kitEyes: "#1b1b1f" }),
});

/** What each launch milestone (a startup trace mark) tells the person, in order. The first shows as the card opens. */
export const STEPS = Object.freeze([
  ["opening", "Opening Metal"],
  ["credentials", "Unlocking your sign-ins"],
  ["server", "Starting your bots"],
  ["window", "Opening your workspace"],
  ["loaded", "Almost there"],
]);

/** One mascot turns up per step, in this order; kit is drawn in ink so it follows the theme. */
export const CREW = Object.freeze(["goo", "kit", "pip", "mochi", "boxo"]);
const CREW_COLORS = { goo: "#f75e51", pip: "#286ef9", mochi: "#f12b93", boxo: "#fb7c01" };

/** How long the crew cheers once the app is ready, before the app fades in over them. */
export const CHEER_MS = 520;
/** The longest the app waits for late mascots to finish arriving before the cheer. */
export const CATCH_UP_MAX_MS = 1_800;

/**
 * The card paces itself by time, not by the launch marks (they land almost together, then the page load takes the rest).
 * `firstRunMs` is the guess with no history; loads are clamped so five arrivals always fit with room between them.
 */
export const PACE = Object.freeze({ firstRunMs: 7_000, minMs: 4_500, maxMs: 20_000, gapMs: 1_000, burstGapMs: 240, waitLineMs: 3_200, remember: 5 });
/** When the first four mascots turn up, as a share of the expected load; the fifth waits for the page to load. */
export const ARRIVE_AT = Object.freeze([0, 0.22, 0.45, 0.7]);
/** What the line says once the expected time has passed and the app still has not loaded, one after another. */
export const WAIT_LINES = Object.freeze(["Waking your bots", "Loading your chats", "Almost there", "Taking a little longer\u2026"]);

/** The load time to plan for: the median of the last few launches (splash shown to page loaded), else the first-run guess. */
export function expectedLoadMs(history, pace = PACE) {
  const loads = (Array.isArray(history) ? history : []).filter(ms => Number.isFinite(ms) && ms > 0).slice(-pace.remember).sort((a, b) => a - b);
  if (!loads.length) return pace.firstRunMs;
  const mid = loads.length >> 1, median = loads.length % 2 ? loads[mid] : (loads[mid - 1] + loads[mid]) / 2;
  return Math.round(Math.min(pace.maxMs, Math.max(pace.minMs, median)));
}

/** The history with this launch added, keeping the last few. */
export function rememberLoad(history, ms, pace = PACE) {
  const loads = (Array.isArray(history) ? history : []).filter(value => Number.isFinite(value) && value > 0);
  return Number.isFinite(ms) && ms > 0 && ms < 120_000 ? [...loads, Math.round(ms)].slice(-pace.remember) : loads.slice(-pace.remember);
}

// the two below also run inside the card, so they only use their arguments
/**
 * When each mascot arrives, in ms since the card opened: the first four spread over the expected load at least `gapMs` apart,
 * the last only once the page has loaded. A load that beats the plan brings the rest in a short stagger. null is still waiting.
 */
export function crewArrivals({ expectedMs, loadedAt = null, pace, arriveAt, count }) {
  const out = [];
  let last = -Infinity;
  for (let k = 0; k < count; k++) {
    let at = k < arriveAt.length ? Math.max(arriveAt[k] * expectedMs, last + pace.gapMs) : Infinity;
    if (loadedAt !== null && at > loadedAt) at = Math.max(loadedAt, last + pace.burstGapMs);
    if (at === Infinity) { out.push(null); continue; }
    out.push(at); last = at;
  }
  return out;
}

/** The percent shown at `t` ms: eased out to 90 over the expected load, then creeping toward 99 and never reaching it. */
export function progressAt(t, expectedMs) {
  if (t <= 0) return 0;
  if (t < expectedMs) return 90 * (1 - (1 - t / expectedMs) ** 1.6);
  return 90 + 9 * (1 - Math.exp(-(t - expectedMs) / (expectedMs * 1.5)));
}

export const STARTUP_TRY_AGAIN = "Something got in the way. Try again: it starts fresh.";
const PLAIN_STARTUP = /^[A-Z][^\n/\\{}[\]]{8,160}[.!]$/;

/** What the startup card says went wrong: a plain sentence of ours as it is, else one line that says what to do (the
 * error itself is in the log). */
export function startupFailureWords(error) {
  const text = String(error?.message ?? error ?? "").trim();
  return PLAIN_STARTUP.test(text) && !/\b[A-Z]{4,}\b|Error\b|\bcode\b/.test(text) ? text : STARTUP_TRY_AGAIN;
}

/**
 * Light or dark for the card. `saved` is the last skin the app wore and whether the system was dark then:
 * a skin that matched the system then follows the system now, one that went against it was picked on purpose.
 */
export function startupDark({ systemDark, saved }) {
  if (!saved || typeof saved.light !== "boolean" || typeof saved.systemDark !== "boolean") return systemDark;
  return saved.light === saved.systemDark ? !saved.light : systemDark;
}

export function startupScreenHtml({ dark = false, expectedMs = PACE.firstRunMs } = {}) {
  const t = dark ? THEMES.dark : THEMES.light;
  const crew = CREW.map(name => ({ name, color: CREW_COLORS[name] ?? t.ink, eyeColor: CREW_COLORS[name] ? "#ffffff" : t.kitEyes, ...SPRITES[name] }));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${dark ? "dark" : "light"}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Metal</title><style>
  @font-face{font-family:"General Sans";src:url("${font}") format("woff2");font-weight:200 700}
  :root{--bg:${t.bg};--ink:${t.ink};--soft:${t.soft};--track:${t.track};--hover:${t.hover};--ease-out:cubic-bezier(.23,1,.32,1)}
  *{box-sizing:border-box}
  html,body{margin:0;width:100%;height:100%;overflow:hidden}
  body{position:relative;background:var(--bg);color:var(--ink);font:500 14px/1.4 "General Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;-webkit-app-region:drag;-webkit-user-select:none;user-select:none}
  .brand{position:absolute;left:20px;top:16px;margin:0;font-size:13px;font-weight:600;letter-spacing:-.1px;color:var(--soft)}
  .scene,.txt{transition:transform 300ms var(--ease-out)}
  .scene{position:absolute;left:0;top:0;width:${W}px;height:${H}px}
  .txt{position:absolute;left:24px;right:24px;top:206px;display:flex;flex-direction:column;align-items:center;text-align:center}
  .stuck .scene,.failed .scene{transform:translateY(-28px)}
  .stuck .txt,.failed .txt{transform:translateY(-34px)}
  .line{margin:0 0 4px;font-size:18px;font-weight:600;letter-spacing:-.3px;transition:opacity 180ms ease}
  .line.out{opacity:0}
  .meta{color:var(--soft);font-size:13px}
  .meta b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
  .meta .pct{margin-left:8px;font-variant-numeric:tabular-nums}
  .detail{max-width:400px;margin:0;font:500 11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;-webkit-user-select:text;user-select:text;-webkit-app-region:no-drag}
  .detail:empty,.actions,.failed .meta{display:none}
  .stuck .actions,.failed .actions{display:flex;gap:8px;margin-top:14px}
  button{font:inherit;cursor:pointer;border:0;-webkit-app-region:no-drag}
  .actions button{height:32px;padding:0 14px;border-radius:999px;font-size:13px;font-weight:600;transition:background-color 150ms ease,opacity 150ms ease,transform 120ms var(--ease-out)}
  .actions .go{background:var(--ink);color:var(--bg)}.actions .stop{background:var(--track);color:var(--ink)}
  .actions button:active{transform:scale(.97)}
  button:disabled{cursor:default;opacity:.6}
  button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
  .close{position:absolute;right:10px;top:10px;width:28px;height:28px;display:grid;place-items:center;padding:0;border-radius:999px;background:transparent;color:var(--soft);opacity:.7;transition:background-color 150ms ease,opacity 150ms ease}
  .close svg{pointer-events:none}
  @media(hover:hover) and (pointer:fine){.close:hover{background:var(--hover);opacity:1}.actions .go:hover{opacity:.88}.actions .stop:hover{background:var(--hover)}}
  @media(prefers-reduced-motion:reduce){.scene,.txt{transition:none}}
  </style></head><body>
  <canvas class="scene" width="${W}" height="${H}" aria-hidden="true"></canvas>
  <p class="brand">Metal</p>
  <button class="close" aria-label="Close" data-act="close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
  <main class="txt">
  <p class="line" role="status">${STEPS[0][1]}</p>
  <div class="meta" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" aria-valuetext="0 of ${CREW.length} here" aria-label="Opening Metal"><b class="here">0 of ${CREW.length}</b> here<span class="pct">0%</span></div>
  <p class="detail"></p>
  <div class="actions"><button class="go" data-act="retry">Try again</button><button class="stop" data-act="quit">Quit</button></div>
  </main><script>${pageScript({ crew, ghost: t.ghost, shadow: t.shadow, track: t.track, expectedMs })}</script></body></html>`;
}

// the crew turns up on a schedule spread over how long launches usually take; the last one waits for the page to load.
// the canvas redraws on animation frames only while someone is moving, otherwise a few times a second for the idle bob.
const pageScript = ({ crew, ghost, shadow, track, expectedMs }) => `(() => {
  const CREW = ${JSON.stringify(crew)}, GHOST = ${JSON.stringify(ghost)}, SHADOW = ${JSON.stringify(shadow)}, TRACK = ${JSON.stringify(track)};
  const W = ${W}, H = ${H}, S = 4, FLOOR = 178, HOP_MS = 600, CHEER_HOP = 260, CHEER_GAP = 60, PACE_TICK = 200;
  const PACE = ${JSON.stringify(PACE)}, ARRIVE_AT = ${JSON.stringify(ARRIVE_AT)}, WAIT_LINES = ${JSON.stringify(WAIT_LINES)}, EXPECTED = ${Math.round(expectedMs)};
  const crewArrivals = ${crewArrivals.toString()};
  const progressAt = ${progressAt.toString()};
  const body = document.body, line = document.querySelector('.line'), detail = document.querySelector('.detail');
  const meta = document.querySelector('.meta'), here = document.querySelector('.here'), pct = document.querySelector('.pct');
  const lines = ${JSON.stringify(STEPS.map(([, text]) => text))}, total = lines.length;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = document.querySelector('.scene'), dpr = Math.max(1, Math.round(devicePixelRatio || 1));
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.imageSmoothingEnabled = false;
  const cells = d => { const out = []; for (const m of d.matchAll(/M(\\d+) (\\d+)h(\\d+)v1/g)) for (let i = 0; i < +m[3]; i++) out.push([+m[1] + i, +m[2]]); return out; };
  const sprites = new Map();
  // each pose is painted once into a 16px tile, then scaled up crisp
  const tile = (m, pose, fill) => {
    const key = m.name + pose + fill;
    if (sprites.has(key)) return sprites.get(key);
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const x = c.getContext('2d');
    x.fillStyle = fill; for (const [cx, cy] of cells(m.body)) x.fillRect(cx, cy, 1, 1);
    if (pose) { x.fillStyle = m.eyeColor; for (const [cx, cy] of cells(m.eyes[pose] ?? m.eyes.idle)) x.fillRect(cx, cy, 1, 1); }
    sprites.set(key, c); return c;
  };
  const ease = v => 1 - (1 - v) ** 3, snap = v => Math.round(v / S) * S;
  const slot = k => W / 2 + (k - (CREW.length - 1) / 2) * 78 - 32;
  const t0 = performance.now();
  let mood = 'idle', value = 0, cheerAt = 0, pinned = false, over = false, loadedAt = null, ready = false, waitShown = -1, frame = 0, timer = 0;
  const arrivals = CREW.map(() => null);
  const draw = now => {
    g.clearRect(0, 0, W, H);
    g.fillStyle = TRACK; g.fillRect(40, FLOOR, W - 80, 4);
    let moving = false, count = 0;
    CREW.forEach((m, k) => {
      const x0 = slot(k);
      const f = arrivals[k] === null || now < arrivals[k] ? 0 : still.matches || mood === 'failed' ? 1 : Math.min(1, (now - arrivals[k]) / HOP_MS);
      // the empty spot waits as a silhouette until its mascot lands in it
      if (f < 1) g.drawImage(tile(m, null, GHOST), x0, FLOOR - 64, 64, 64);
      if (arrivals[k] === null) return;
      if (now < arrivals[k]) { moving = true; return; }
      let x = x0, y = FLOOR - 64, flip = false, squash = false, pose = 'idle';
      if (f < 1) {
        moving = true; flip = true; pose = 'working';
        x = W + 40 + (x0 - W - 40) * ease(f);
        y -= Math.abs(Math.sin(f * Math.PI * 3)) * 26 * (1 - f * .5);
        squash = f > .9;
      } else {
        count++;
        if (mood === 'cheer') {
          pose = 'happy';
          const c = (now - cheerAt - k * CHEER_GAP) / CHEER_HOP;
          if (!still.matches && c > 0 && c < 1) { y -= Math.sin(c * Math.PI) * 14; moving = true; }
          else if (!still.matches && c <= 0) moving = true;
        } else if (mood === 'failed') pose = 'working';
        else if (mood === 'stuck') pose = 'thinking';
        else if (!still.matches && Math.sin(now / 420 + k * 1.7) > .7) y -= 4;
      }
      const sx = Math.max(40, x + 8), sw = Math.min(W - 40, x + 56) - sx;
      if (sw > 0) { g.fillStyle = SHADOW; g.fillRect(sx, FLOOR, sw, 4); }
      g.save(); g.translate(snap(x), snap(y));
      if (flip) { g.translate(64, 0); g.scale(-1, 1); }
      if (squash) { g.translate(32, 64); g.scale(1.12, .88); g.translate(-32, -64); }
      g.drawImage(tile(m, pose, m.color), 0, 0, 64, 64);
      g.restore();
    });
    const text = count + ' of ' + total;
    if (here.textContent !== text) { here.textContent = text; meta.setAttribute('aria-valuetext', text + ' here'); }
    return moving;
  };
  const tick = () => {
    frame = 0; clearTimeout(timer); timer = 0;
    const moving = draw(performance.now());
    if (mood === 'failed' && !moving) return;
    if (moving) frame = requestAnimationFrame(tick);
    else if (!still.matches && mood === 'idle') timer = setTimeout(tick, 125);
  };
  const wake = () => { if (!frame) { clearTimeout(timer); frame = requestAnimationFrame(tick); } };
  let wrote = line.textContent;
  const write = text => {
    if (wrote === text) return;
    wrote = text;
    line.classList.add('out');
    setTimeout(() => { line.textContent = text; line.classList.remove('out'); }, 180);
  };
  const show = () => {
    const shown = Math.floor(value);
    pct.textContent = shown + '%'; meta.setAttribute('aria-valuenow', String(shown));
  };
  const quiet = () => over || pinned || body.classList.contains('stuck');
  const plan = () => crewArrivals({ expectedMs: EXPECTED, loadedAt, pace: PACE, arriveAt: ARRIVE_AT, count: total });
  // places whoever is due, moves the percent along the eased curve and picks the line; nothing here follows the raw marks
  const pace = () => {
    if (over) return;
    const t = performance.now() - t0, due = plan();
    let newest = -1, landed = false;
    due.forEach((at, k) => {
      if (at === null || at > t) return;
      newest = k;
      if (arrivals[k] === null) { arrivals[k] = t0 + at; landed = true; }
    });
    if (landed) wake();
    // once loaded, the percent closes in on 99 over the catch-up; it only reads 100 when the cheer starts
    const goal = loadedAt === null ? progressAt(t, EXPECTED) : 99;
    value = mood === 'cheer' ? 100 : Math.max(value, loadedAt === null ? goal : value + (goal - value) * .35);
    show();
    if (quiet() || mood === 'cheer') return;
    const lastPlanned = due[ARRIVE_AT.length - 1] ?? 0, waiting = t - Math.max(EXPECTED, lastPlanned + PACE.gapMs);
    if (loadedAt === null && waiting >= 0) {
      const n = Math.min(WAIT_LINES.length - 1, Math.floor(waiting / PACE.waitLineMs));
      if (n !== waitShown) { waitShown = n; write(WAIT_LINES[n]); }
    } else if (newest >= 0 && (waitShown < 0 || newest === total - 1)) write(lines[newest]);
  };
  const pacer = setInterval(pace, PACE_TICK);
  const trouble = (kind, text, why = '') => {
    if (over) return;
    over = kind === 'failed';
    if (over) clearInterval(pacer);
    detail.textContent = why; detail.title = why;
    body.classList.remove('stuck'); body.classList.add(kind);
    mood = kind; write(text); wake();
  };
  const stuck = setTimeout(() => trouble('stuck', 'This is taking longer than usual'), ${STUCK_AFTER_MS});
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-act]');
    if (!button) return;
    if (button.dataset.act === 'retry') { button.disabled = true; button.textContent = 'Starting again\\u2026'; }
    window.startupScreen?.[button.dataset.act]?.();
  });
  still.addEventListener?.('change', wake);
  const loaded = () => { if (loadedAt === null) { loadedAt = performance.now() - t0; pace(); } };
  window.card = {
    say: text => { pinned = true; if (!over) write(text); },
    // only the last mark (the page loaded) changes the plan; the earlier ones land together and would rush the crew
    step: n => { if (!over && n >= total) loaded(); },
    fail: why => { clearTimeout(stuck); trouble('failed', "Couldn't start", why || ''); },
    // returns how long until everyone has landed and the cheer starts, so the app waits for it
    ready: () => {
      if (over || ready) return 0;
      ready = true; clearTimeout(stuck); loaded();
      body.classList.remove('stuck'); if (mood === 'stuck') mood = 'idle';
      const last = Math.max(0, ...plan().filter(at => at !== null)) + t0;
      const lead = Math.min(${CATCH_UP_MAX_MS}, Math.max(0, last - performance.now() + (still.matches ? 0 : HOP_MS)));
      setTimeout(() => {
        if (over) return;
        clearInterval(pacer);
        // anyone the cap cut short is simply there
        for (let k = 0; k < total; k++) if (arrivals[k] === null || arrivals[k] > performance.now() - HOP_MS) arrivals[k] = -Infinity;
        value = 100; show(); mood = 'cheer'; cheerAt = performance.now();
        if (!pinned) write("Everyone's here");
        wake();
      }, lead);
      return lead;
    },
  };
  pace();
  // a reload or a late script can land before the first paint
  draw(performance.now());
})();`;

export function createStartupScreen({
  BrowserWindow, iconPath, platform = process.platform, isQuitting, onQuit, onRetry,
  onHide, isHidden = () => false, onShow, onFinished, dark = false,
  expectedMs = PACE.firstRunMs, onLoaded, now = Date.now,
}) {
  let disposed = false, revealed = false, fallback, resolveReady;
  // window opacity is a no-op on Linux, so there the app just appears
  const canFade = win => platform !== "linux" && typeof win.setOpacity === "function";
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const splash = new BrowserWindow({
    width: W, height: H, resizable: false, maximizable: false,
    fullscreenable: false, frame: false,
    backgroundColor: dark ? THEMES.dark.bg : THEMES.light.bg, show: false, icon: iconPath,
    title: "Metal", autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      preload: fileURLToPath(new URL("./startup-screen-preload.cjs", import.meta.url)),
    },
  });
  splash.setMenu(null);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(fallback);
    resolveReady();
    if (!splash.isDestroyed()) splash.destroy();
    onFinished?.();
  };
  splash.on("close", event => {
    if (disposed || isQuitting()) return;
    event.preventDefault();
    if (platform === "win32" && onHide) onHide(splash);
    else onQuit();
  });
  // Renderer window.close() bypasses BrowserWindow's cancellable close path, so the page asks for the native one.
  splash.webContents.on("ipc-message", (_event, channel) => {
    if (disposed) return;
    if (channel === "startup-screen:close") splash.close();
    else if (channel === "startup-screen:quit") onQuit();
    else if (channel === "startup-screen:retry") (onRetry ?? onQuit)();
  });
  let shown = false, shownAt = null;
  const openedAt = now();
  const showSplash = () => {
    if (shown || disposed || isQuitting()) return;
    shown = true; shownAt = now(); splash.show(); resolveReady();
  };
  splash.once("ready-to-show", showSplash);
  // Some Wayland compositors (COSMIC) never paint a hidden window, so ready-to-show never comes.
  splash.webContents.once("did-finish-load", () => {
    const grace = setTimeout(showSplash, 500);
    grace.unref?.();
  });
  splash.on("show", () => onShow?.(splash));
  splash.once("closed", resolveReady);
  // The splash stays until the main window replaces it: as the only window, destroying it would quit the app.
  splash.webContents.once("render-process-gone", resolveReady);
  const page = (code) => disposed || splash.isDestroyed() ? Promise.resolve() : splash.webContents.executeJavaScript(code).catch(() => {});
  let said = null, failure = null, step = 1;
  const tell = () => {
    if (step > 1) void page(`window.card?.step(${step})`);
    if (said !== null) void page(`window.card?.say(${JSON.stringify(said)})`);
    if (failure !== null) void page(`window.card?.fail(${JSON.stringify(failure)})`);
  };
  splash.webContents.on("did-finish-load", tell);
  const startupFallback = setTimeout(resolveReady, 10_000);
  startupFallback.unref?.();
  void splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(startupScreenHtml({ dark, expectedMs })))
    .catch(resolveReady);
  const attach = (win, { maximized = false } = {}) => {
    const reveal = () => {
      if (revealed || win.isDestroyed() || isQuitting()) return;
      revealed = true;
      const minimized = !splash.isDestroyed() && splash.isMinimized();
      if (isHidden()) {
        win.setSkipTaskbar(true);
        win.hide();
        if (maximized) win.once("show", () => win.maximize());
      } else {
        if (maximized) win.maximize();
        if (minimized) { win.showInactive(); win.minimize(); }
        else if (canFade(win) && splash.isVisible?.()) { void fadeIn(win); return; }
        else { win.show(); win.focus(); }
      }
      dispose();
    };
    const fadeIn = async (win) => {
      // late mascots finish landing first; the card says how long that takes
      const lead = Number(await page("window.card?.ready()")) || 0;
      await wait(Math.min(CATCH_UP_MAX_MS, Math.max(0, lead)) + CHEER_MS);
      if (win.isDestroyed() || isQuitting()) { dispose(); return; }
      win.setOpacity(0); win.show(); win.focus();
      await crossfade(win, splash);
      if (!win.isDestroyed()) win.setOpacity(1);
      dispose();
    };
    win.webContents.on("did-finish-load", () => {
      if (revealed || win.isDestroyed() || isQuitting()) return;
      void win.webContents.executeJavaScript(`new Promise(resolve => {
        const root = document.getElementById('root');
        if (!root || root.childElementCount) { resolve(); return; }
        const observer = new MutationObserver(() => {
          if (root.childElementCount) { observer.disconnect(); resolve(); }
        });
        observer.observe(root, { childList: true });
        if (document.getElementById('boot-shell')) setTimeout(resolve, ${BOOT_SHELL_HANDOFF_MS});
      })`).then(reveal).catch(reveal);
    });
    win.webContents.once("render-process-gone", reveal);
    win.once("show", () => { if (!revealed) { revealed = true; dispose(); } });
    win.once("closed", dispose);
    fallback = setTimeout(reveal, 10_000);
    fallback.unref?.();
  };
  /** The line under the name, in place of the rotating ones. */
  const status = (text) => { said = String(text); tell(); };
  /** A startup trace mark was reached: the bar and line move to its step. Marks without a step are ignored. */
  const progress = (mark) => {
    const at = STEPS.findIndex(([name]) => name === mark) + 1;
    if (at <= step) return;
    step = at; tell();
    // how long this launch took from the card showing to the page loading, so the next one can pace itself
    if (mark === STEPS.at(-1)[0]) { try { onLoaded?.(now() - (shownAt ?? openedAt)); } catch {} }
  };
  /** Startup gave up: the card says so and offers try again and quit instead of waiting forever. */
  const fail = (error) => {
    failure = startupFailureWords(error);
    showSplash();
    tell();
  };
  return { ready, attach, dispose, status, progress, fail, window: splash };
}
