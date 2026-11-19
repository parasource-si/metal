// The walkthrough's recorder (walkthrough.mjs): with DUSK_WALKTHROUGH_DIR set, a flow smoke shoots every visible state
// change of the smoke app's window and of every headless browser page it opens, as a new person would see them, and
// records each surface as a short video (devtools screencast frames, joined by ffmpeg). Unset, every call here is a no-op,
// so the flows run exactly as before.
//
// A state is the page's visible text (digits folded, so a ticking timer is one state), its address and its few state
// attributes; a new one that holds still for a moment is shot. The app's window is its page plus, when it is up, the rail
// of places (a view of its own over the page's left edge), put together as the window shows them. Each shot carries the
// flow step it happened in, what the person last did on that surface and the time since the one before.
// <dir>/manifest.json is written as it goes, so a run that dies still leaves what it saw.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectCdp } from "../app.mjs";

const DIR = process.env.DUSK_WALKTHROUGH_DIR || null;
/** the app's normal window (electron/window-state.cjs DEFAULT_BOUNDS) and the browser's */
export const APP_SIZE = { width: 1040, height: 760 };
export const BROWSER_SIZE = { width: 1280, height: 860 };
const POLL_MS = 350, SETTLE_MS = 650, CHURN_MS = 2_600, MAX_SHOTS = 260;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ffmpeg = (() => { const found = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim(); return found || null; })();

/** what the page shows, read in the page */
const LOOK = `(() => {
  const shown = (e) => { if (!e || !e.getClientRects().length) return false; const s = getComputedStyle(e); return s.visibility !== "hidden" && Number(s.opacity) > 0.05; };
  const body = document.body;
  const text = (body?.innerText ?? "").replace(/[ \\t]+/g, " ").replace(/\\n{2,}/g, "\\n").trim();
  const dialogs = [...document.querySelectorAll("[role=dialog],[role=alertdialog],[data-panel-modal],[data-continue-in-browser]")].filter(shown);
  // the sheet on top: the one under the window's middle, else the last one shown
  const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("[role=dialog],[role=alertdialog],[data-panel-modal],[data-continue-in-browser]");
  const scope = (middle && dialogs.includes(middle) ? middle : dialogs.at(-1)) ?? document;
  const heads = [...scope.querySelectorAll("h1,h2,h3,[role=heading]")].filter(shown).map((h) => h.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 4);
  const states = [...document.querySelectorAll("[data-welcome],[data-vps-screen],[data-cloud-move-stage],[data-install-phase],[data-add-cloud-flow],[data-cloud-move],[data-all-set],[data-settings-page][aria-current]")]
    .filter(shown).map((e) => e.tagName + ":" + [...e.attributes].filter((a) => a.name.startsWith("data-") || a.name === "aria-current").map((a) => a.name + "=" + a.value).join(",")).join(";");
  const first = text.split("\\n").map((l) => l.trim()).filter((l) => l.length > 2)[0] ?? "";
  const rail = getComputedStyle(document.documentElement).getPropertyValue("--rail-beside").trim();
  return { url: location.href, title: document.title, text: text.slice(0, 6000), heads, dialog: dialogs.length > 0, states, first: first.slice(0, 120),
    rail: rail && rail !== "0px" ? rail : "", overflow: document.documentElement.scrollWidth > innerWidth + 1, width: innerWidth, height: innerHeight, ready: document.readyState };
})()`;

/** a state's key: what changed on screen, not a clock or a counter ticking */
const keyOf = (look) => {
  const u = (() => { try { const url = new URL(look.url); return url.origin + url.pathname; } catch { return look.url; } })();
  return [u, look.states, look.dialog ? "dialog" : "", look.rail ? "rail" : "", look.text.replace(/\d+/g, "#").replace(/\s+/g, " ")].join("|");
};

/** checks a shot's words for what a new person should never see, and what is off the brand's words */
function autoWarnings(look) {
  const found = [], text = look.text ?? "";
  const hit = (pattern) => pattern.exec(text)?.[0];
  let m;
  if ((m = hit(/\b(something went wrong|went wrong|failed to [a-z]+|an error occurred|internal server error|unexpected error|not found|can't reach|couldn['’]t [a-z]+ [a-z]+|try again later)\b[^\n]{0,60}/i))) found.push(`error words on screen: "${m.trim()}"`);
  if ((m = hit(/\b(undefined|NaN|\[object Object\]|null)\b/))) found.push(`a raw value on screen: "${m}"`);
  if ((m = hit(/\b[a-z]+(?:\.[a-z][a-zA-Z]+){2,}\b/)) && !/\b(dusk\.bot|qa\.dusk\.test|apps\.siddz|dodopayments|[a-z]+\.(com|dev|io|sh|net|org|app|bot))\b/.test(m)) found.push(`what looks like an untranslated key: "${m}"`);
  if ((m = hit(/\b(?:dusk ?bot)\b/i))) found.push(`off-brand name "${m}" (the app is named Metal)`);
  if (text.includes("\u2014")) found.push("an em dash on screen");
  if (look.overflow) found.push(`the page scrolls sideways at ${look.width}x${look.height}`);
  return found;
}

function makeRecorder(dir) {
  mkdirSync(join(dir, "shots"), { recursive: true });
  mkdirSync(join(dir, "frames"), { recursive: true });
  const t0 = Date.now();
  const meta = { section: process.env.DUSK_WALKTHROUGH_SECTION ?? null, startedAt: new Date(t0).toISOString(), email: null };
  const captures = [], warnings = [], steps = [], surfaces = new Map(), videos = [];
  let step = { id: "start", title: "starting", status: "running" }, shotCount = 0, finished = false;

  const save = () => {
    try { writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ ...meta, seconds: Math.round((Date.now() - t0) / 1000), steps, captures, warnings, videos }, null, 2)}\n`); } catch {}
  };

  /** a surface: the app's window or one browser page; `resolve()` finds its devtools page target's socket */
  function surface(name, kind, resolve, extra = {}) {
    const s = { name, kind, resolve, cdp: null, socket: null, key: null, pending: null, pendingAt: 0, churnAt: 0, lastShotAt: 0, action: null, frames: [], lastFrameAt: 0, activeUntil: Date.now() + 4_000, polling: false, timer: null, closed: false, ...extra };
    surfaces.set(name, s);
    s.timer = setInterval(() => { void poll(s); }, POLL_MS);
    s.timer.unref?.();
    return s;
  }

  async function connect(s) {
    const socket = await s.resolve();
    if (!socket) return null;
    if (s.cdp && s.socket === socket) return s.cdp;
    try { s.cdp?.close(); } catch {}
    const cdp = connectCdp(socket);
    await cdp.ready;
    s.cdp = cdp; s.socket = socket;
    cdp.on((message) => {
      if (message.method !== "Page.screencastFrame") return;
      const { data, sessionId } = message.params;
      void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      // a still page sends nothing; a moving one (a spinner) is kept at a few frames a second, and while nothing it
      // shows changes, at one now and then: the video is the flow, not the waiting
      const now = Date.now(), gap = now - s.lastFrameAt;
      if (gap < 220 || (now > s.activeUntil && gap < 3_000) || finished) return;
      s.lastFrameAt = now;
      const file = join(dir, "frames", `${s.name}-${String(s.frames.length).padStart(5, "0")}.jpg`);
      try { writeFileSync(file, Buffer.from(data, "base64")); s.frames.push({ file, at: now }); } catch {}
    });
    await cdp.send("Page.enable").catch(() => {});
    if (s.kind === "app") await cdp.send("Emulation.setDeviceMetricsOverride", { ...APP_SIZE, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }).catch(() => {});
    const size = s.kind === "app" ? APP_SIZE : BROWSER_SIZE;
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 }).catch(() => {});
    return cdp;
  }

  async function poll(s) {
    if (s.polling || s.closed || finished) return;
    s.polling = true;
    try {
      let cdp = s.cdp, look = null;
      try { look = cdp ? await cdp.evaluate(LOOK) : null; } catch { look = null; }
      if (!look) { cdp = await connect(s).catch(() => null); if (cdp) look = await cdp.evaluate(LOOK).catch(() => null); }
      if (!look || look.ready === "loading" || String(look.url).startsWith("about:blank")) return;
      const key = keyOf(look), now = Date.now();
      if (key === s.key) { s.pending = null; return; }
      if (key !== s.pending) { if (!s.pending) s.churnAt = now; s.pending = key; s.pendingAt = now; s.activeUntil = now + 4_000; return; }
      // the same new state held still for a moment, or the screen keeps changing (a reply being written): shoot it
      if (now - s.pendingAt < SETTLE_MS && now - s.churnAt < CHURN_MS) return;
      await shoot(s, look, key);
    } finally { s.polling = false; }
  }

  async function rail(s) {
    if (s.kind !== "app" || !s.cdpPort) return null;
    try {
      const targets = await (await fetch(`http://127.0.0.1:${s.cdpPort}/json/list`)).json();
      const target = targets.find((t) => t.type === "page" && /^https?:/.test(t.url) && new URL(t.url).pathname === "/rail");
      if (!target) return null;
      if (!s.railCdp || s.railSocket !== target.webSocketDebuggerUrl) {
        try { s.railCdp?.close(); } catch {}
        s.railCdp = connectCdp(target.webSocketDebuggerUrl); s.railSocket = target.webSocketDebuggerUrl;
        await s.railCdp.ready;
        await s.railCdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }).catch(() => {});
        await s.railCdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }).catch(() => {});
      }
      const look = await s.railCdp.evaluate(`({ w: innerWidth, h: innerHeight, text: (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 400) })`);
      return { cdp: s.railCdp, ...look };
    } catch { return null; }
  }

  async function shoot(s, look, key) {
    if (shotCount >= MAX_SHOTS) { s.key = key; s.pending = null; return; }
    const at = Date.now();
    s.key = key; s.pending = null; s.activeUntil = at + 4_000;
    const n = ++shotCount, base = `${String(n).padStart(3, "0")}-${s.name}`;
    const file = join(dir, "shots", `${base}.png`);
    try {
      const shot = await s.cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(shot.data, "base64"));
    } catch { shotCount--; s.key = null; return; }
    // the rail of places over the page's left edge, as the window shows it (a strip, or a sheet over the whole window)
    let railShown = false, railText = "";
    const strip = s.kind === "app" ? await rail(s) : null;
    if (strip && (look.rail || strip.w > 80) && ffmpeg) {
      try {
        const railShot = await strip.cdp.send("Page.captureScreenshot", { format: "png" });
        const railFile = join(dir, "shots", `${base}-rail.png`);
        writeFileSync(railFile, Buffer.from(railShot.data, "base64"));
        const out = join(dir, "shots", `${base}-window.png`);
        const made = spawnSync(ffmpeg, ["-loglevel", "error", "-y", "-i", file, "-i", railFile, "-filter_complex", "[0][1]overlay=0:0:format=auto", out]);
        if (made.status === 0 && existsSync(out)) { rmSync(file); rmSync(railFile); writeFileSync(file, readFileSync(out)); rmSync(out); railShown = true; railText = strip.text; }
      } catch {}
    }
    const prev = [...captures].reverse().find((c) => c.surface === s.name) ?? null;
    const action = s.action && s.action.at > (prev?.atMs ?? -1) + t0 - 1 ? s.action.text : null;
    s.action = null;
    const auto = autoWarnings(look);
    const url = (() => { try { const u = new URL(look.url); return u.origin + u.pathname + (u.search ? u.search.replace(/(code|token|key|session)=[^&]+/gi, "$1=…") : ""); } catch { return look.url; } })();
    const entry = {
      n, surface: s.name, kind: s.kind, file: `shots/${base}.png`, atMs: at - t0, sincePrevMs: captures.length ? at - t0 - captures.at(-1).atMs : 0,
      step: step.id, stepTitle: step.title, action, headline: look.heads.join(" / ") || look.first, url, rail: railShown, railText,
      text: look.text.slice(0, 2500), warnings: auto, notes: [],
    };
    captures.push(entry);
    save();
  }

  const rec = {
    enabled: true, dir,
    setEmail(email) { meta.email = email; save(); },
    set(key, value) { meta[key] = value; save(); },
    /** the flow's step: shots after this belong to it */
    step(id, title) { step = { id, title, status: "running", startedMs: Date.now() - t0 }; steps.push(step); save(); },
    stepDone(id, status, note) { const found = [...steps].reverse().find((entry) => entry.id === id); if (found) { found.status = status; found.note = note; found.endedMs = Date.now() - t0; } if (status === "fail") rec.warn("broken", found?.title ?? id, note); save(); },
    /** what the person did on a surface ("app" or "browser"): the caption of the next shot there */
    did(text, surfaceName = "app") {
      const s = surfaces.get(surfaceName) ?? [...surfaces.values()].find((entry) => entry.kind === surfaceName && !entry.closed);
      if (s) { s.action = { text, at: Date.now() }; s.activeUntil = Date.now() + 4_000; }
    },
    /** a ⚠ for the whole section (a flow's friction, a failed step) */
    warn(kind, where, note) { warnings.push({ kind, where, note, step: step.id, atMs: Date.now() - t0, near: captures.at(-1)?.n ?? null }); save(); },
    /** shoots the surface now, whether or not the screen changed (a moment worth its own picture) */
    async capture(surfaceName = "app", why = null) {
      const s = surfaces.get(surfaceName) ?? [...surfaces.values()].find((entry) => entry.kind === surfaceName && !entry.closed);
      if (!s) return;
      while (s.polling) await sleep(50);
      s.polling = true;
      try {
        const cdp = s.cdp ?? await connect(s).catch(() => null);
        const look = cdp ? await cdp.evaluate(LOOK).catch(() => null) : null;
        if (look) { if (why) s.action = { text: why, at: Date.now() }; await shoot(s, look, keyOf(look)); }
      } finally { s.polling = false; }
    },
    /** the smoke app's main window (its page target changes when it opens another place: found again each time) */
    attachApp(app) {
      const pageTarget = async () => {
        const targets = await (await fetch(`http://127.0.0.1:${app.cdpPort}/json/list`)).json();
        const page = targets.find((t) => t.type === "page" && /^https?:/.test(t.url) && !/^\/(?:rail|ambient|float|overlay|talk)/.test(new URL(t.url).pathname));
        return page?.webSocketDebuggerUrl ?? null;
      };
      if (surfaces.get("app")) { const s = surfaces.get("app"); s.closed = false; s.resolve = pageTarget; s.cdpPort = app.cdpPort; return; }
      surface("app", "app", pageTarget, { cdpPort: app.cdpPort });
    },
    detachApp() { const s = surfaces.get("app"); if (s) { s.closed = true; try { s.cdp?.send("Page.stopScreencast").catch(() => {}); s.cdp?.close(); s.railCdp?.close(); } catch {} s.cdp = null; s.railCdp = null; } },
    /** a headless browser page (flows/browser.mjs); every browser of the flow is one surface, "browser" */
    attachBrowser(browser) {
      const resolve = async () => browser.wsUrl;
      const s = surfaces.get("browser");
      if (s) { s.closed = false; s.resolve = resolve; s.cdp = null; s.socket = null; s.key = null; return; }
      surface("browser", "browser", resolve);
    },
    async detachBrowser() {
      const s = surfaces.get("browser");
      if (!s || s.closed) return;
      // the page's last state before the browser goes
      await rec.flushSurface(s);
      s.closed = true;
      try { await s.cdp?.send("Page.stopScreencast").catch(() => {}); s.cdp?.close(); } catch {}
      s.cdp = null; s.socket = null;
    },
    async flushSurface(s) {
      if (!s?.cdp) return;
      for (let i = 0; i < 4 && s.pending; i++) { await sleep(SETTLE_MS); await poll(s); }
      while (s.polling) await sleep(50);
      const look = await s.cdp.evaluate(LOOK).catch(() => null);
      if (look && keyOf(look) !== s.key) { s.polling = true; try { await shoot(s, look, keyOf(look)); } finally { s.polling = false; } }
    },
    /** the app's last state, then the videos and the manifest */
    async finish() {
      if (finished) return;
      for (const s of surfaces.values()) if (!s.closed) await rec.flushSurface(s).catch(() => {});
      finished = true;
      for (const s of surfaces.values()) { clearInterval(s.timer); try { s.cdp?.send("Page.stopScreencast").catch(() => {}); s.cdp?.close(); s.railCdp?.close(); } catch {} }
      for (const s of surfaces.values()) {
        const video = makeVideo(s);
        if (video) videos.push(video);
      }
      save();
    },
  };

  /** the surface's frames as an mp4: each frame held for as long as it showed, but never longer than a moment */
  function makeVideo(s) {
    if (!ffmpeg || s.frames.length < 2) return null;
    const size = s.kind === "app" ? APP_SIZE : BROWSER_SIZE;
    const list = join(dir, "frames", `${s.name}.txt`);
    const lines = [];
    s.frames.forEach((frame, i) => {
      const next = s.frames[i + 1];
      const seconds = next ? Math.min(Math.max((next.at - frame.at) / 1000, 0.04), 0.6) : 1.5;
      lines.push(`file '${frame.file.replace(/'/g, "'\\''")}'`, `duration ${seconds.toFixed(3)}`);
    });
    lines.push(`file '${s.frames.at(-1).file.replace(/'/g, "'\\''")}'`);
    writeFileSync(list, `${lines.join("\n")}\n`);
    const out = join(dir, `${s.name}.mp4`);
    const made = spawnSync(ffmpeg, ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`,
      "-r", "25", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", out], { encoding: "utf8" });
    if (made.status !== 0) { warnings.push({ kind: "harness", where: `${s.name} video`, note: `ffmpeg failed: ${(made.stderr ?? "").slice(-200)}` }); return null; }
    // the frames are in the video now
    for (const frame of s.frames) rmSync(frame.file, { force: true });
    rmSync(list, { force: true });
    return { surface: s.name, file: `${s.name}.mp4`, frames: s.frames.length };
  }

  save();
  return rec;
}

/** a caption for typed text: never a code or a whole pasted file */
export const typedWords = (text) => (/^\s*\d{4,10}\s*$/.test(text) ? "types the emailed code" : /@/.test(text) && text.length < 80 ? `types ${text.trim()}` : text.length > 80 ? `pastes ${text.length} characters` : `types "${text.trim()}"`);

const NOOP = new Proxy({ enabled: false }, { get: (target, key) => (key in target ? target[key] : () => Promise.resolve()) });
/** the run's recorder: real with DUSK_WALKTHROUGH_DIR, else a no-op */
export const walkthrough = DIR ? makeRecorder(DIR) : NOOP;
