// One see-through overlay for the notch island or the bot dock: frameless, never in the Dock, Mission Control or the
// window list, on every Space but hidden over full-screen apps, and click-through except where its page says the
// pointer is on its shape (the page still hears the pointer moving, so it can tell).
import { fileURLToPath } from "node:url";

const overlays = new WeakSet();
/** The longest a surface's closing animation may hold the keyboard before the panel gives it back anyway. */
export const SETTLE_WAIT_MS = 1_000;
export const isAmbientWindow = win => Boolean(win) && overlays.has(win);
const PRELOAD = fileURLToPath(new URL("./ambient-preload.cjs", import.meta.url));
/** How often main reads the pointer for a page that cannot hear it (Linux). */
export const FEED_POINTER_MS = 50;

/**
 * @param {{ BrowserWindow: any, surface: "island" | "dock", url: () => string | null, level: string,
 *   platform?: string, onMessage: (channel: string, payload: unknown) => void, log?: (line: string) => void }} deps
 */
export function createAmbientWindow({ BrowserWindow, surface, url, level, platform = process.platform, onMessage, log = () => {}, trace = null, hoverKey = true,
  cursor = () => null, feedEveryMs = FEED_POINTER_MS }) {
  let win = null, loaded = false, interactive = false, bounds = null, page = null, keyed = false, typing = false;
  // from the pointer reaching the surface until its page says it has finished closing: nothing moves or resizes the
  // window meanwhile (a new place waits in `held`), so a closing animation always plays out where it started
  let settling = false, held = null;
  const queued = new Map();
  const live = () => Boolean(win && !win.isDestroyed());
  const note = (event, detail) => trace?.(surface, event, detail);
  /** Every window action goes through here, so a trace (ambient-trace.mjs) sees each one with its time. */
  const call = (name, detail, fn) => { note(`win:${name}`, detail); return fn(); };

  // macOS shows a page's cursor (the pointing hand) only in the key window or the active app, and these panels are
  // neither while another app is in front. Over the shape the panel becomes key: Electron's focus() on a panel does
  // not activate the app, so the app in front stays in front. Off the shape it gives key back, unless the person is
  // typing in one of its fields. Electron 43's blur() on macOS is orderOut + orderBack: the panel fades out and back in.
  // A surface that cannot hide that (`hoverKey: false`, the dock) never takes the key on hover; a click still makes it
  // key, as macOS does for any panel.
  const keyOnHover = platform === "darwin" && hoverKey;
  // asked of the window itself each time: macOS can take the key away without telling us (another app clicked or
  // switched to while the pointer was here), and a remembered "we have it" would then leave its fields deaf
  function takeKey() {
    if (!keyOnHover || win.isFocused?.()) return;
    keyed = true;
    call("focus", "", () => win.focus());
  }
  // giving the key back on macOS (Electron's blur) orders the panel out and back in, which would cut its closing
  // animation short: it waits until the page says the surface has finished closing, or SETTLE_WAIT_MS at most
  let settleWait = null;
  function giveKeyBack() {
    clearTimeout(settleWait); settleWait = null;
    if (interactive || !live()) return;
    if (settling) { settling = false; note("settled"); }
    if (held) { const next = held; held = null; setBounds(next); }
    if (!keyed || typing) return;
    keyed = false;
    if (win.isFocused?.() !== false) call("blur", "", () => win.blur());
  }
  function setBounds(next) {
    const now = win.getBounds();
    if (now.x === next.x && now.y === next.y && now.width === next.width && now.height === next.height) return;
    call("setBounds", JSON.stringify(next), () => win.setBounds(next));
  }
  function giveKeyBackOnceSettled() {
    if ((!keyed && !settling) || typing) return;
    clearTimeout(settleWait);
    settleWait = setTimeout(giveKeyBack, SETTLE_WAIT_MS);
    settleWait.unref?.();
  }

  function passThrough(on) {
    if (!live()) return;
    if (on === interactive) return;
    interactive = on;
    note(on ? "pointer-on" : "pointer-off");
    if (on) {
      clearTimeout(settleWait); settleWait = null;
      settling = true;
      call("setIgnoreMouseEvents", "false", () => win.setIgnoreMouseEvents(false));
      takeKey();
    } else {
      call("setIgnoreMouseEvents", "true forward", () => win.setIgnoreMouseEvents(true, { forward: true }));
      giveKeyBackOnceSettled();
    }
  }

  // Electron 43: setIgnoreMouseEvents' `forward` is macOS and Windows only, so on Linux a click-through page never
  // hears the pointer and its shape never takes a click. There main reads the pointer and hands the page its moves over
  // the window. X11 only: Wayland tells an app nothing about a pointer outside its own windows.
  let feeder = null, fedOver = false;
  function feedPointer() {
    if (!live() || !loaded || interactive) { fedOver = false; return; }
    const point = cursor();
    if (!point) return;
    const at = win.getBounds(), x = point.x - at.x, y = point.y - at.y;
    const over = x >= 0 && y >= 0 && x < at.width && y < at.height;
    if (over) win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    else if (fedOver) win.webContents.sendInputEvent({ type: "mouseLeave", x: Math.max(-1, Math.min(at.width, x)), y: Math.max(-1, Math.min(at.height, y)) });
    fedOver = over;
  }
  function startFeeding() {
    if (platform !== "linux" || feeder) return;
    feeder = setInterval(feedPointer, feedEveryMs);
    feeder.unref?.();
  }

  function create(address) {
    note("win:create", JSON.stringify(bounds));
    const target = new BrowserWindow({
      ...(platform === "darwin" ? { type: "panel" } : {}),
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      // a click on the island's reply field has to reach it without bringing the whole app forward
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      enableLargerThanScreen: true,
      title: surface === "island" ? "Metal island" : "Metal dock",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        // its closing and opening play in full even while macOS reorders the panel
        backgroundThrottling: false,
        preload: PRELOAD,
        additionalArguments: [`--dusk-ambient=${surface}`, ...(trace ? ["--dusk-ambient-trace=1"] : [])],
      },
    });
    overlays.add(target);
    target.excludedFromShownWindowsMenu = true;
    target.setAlwaysOnTop(true, level);
    // electron/macOS: skipTransformProcessType keeps the Dock icon; full-screen apps keep their screen to themselves
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
    target.setIgnoreMouseEvents(true, { forward: true });
    target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    target.webContents.on("will-navigate", event => event.preventDefault());
    target.webContents.on("did-finish-load", () => {
      if (win !== target) return;
      loaded = true;
      for (const [channel, payload] of queued) target.webContents.send(channel, payload);
      if (!target.isVisible()) call("showInactive", "", () => target.showInactive());
    });
    target.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) log(`ambient ${surface} page failed to load: ${description || code}`);
    });
    target.webContents.on("render-process-gone", (_event, details) => {
      log(`ambient ${surface} page gone: ${details?.reason ?? "unknown"}`);
      if (win === target) close();
    });
    target.webContents.on("ipc-message", (_event, channel, payload) => {
      if (win !== target || typeof channel !== "string" || !channel.startsWith("ambient:")) return;
      if (channel === "ambient:pointer") return passThrough(payload === true);
      if (channel === "ambient:typing") {
        typing = payload === true;
        if (live() && !typing) giveKeyBackOnceSettled();
        return;
      }
      if (channel === "ambient:settled") { note("page:settled"); return giveKeyBack(); }
      if (channel === "ambient:trace") {
        if (payload && typeof payload === "object") note(`page:${String(payload.event ?? "").slice(0, 60)}`, `${String(payload.detail ?? "").slice(0, 200)}${Number.isFinite(payload.t) ? ` @page ${payload.t}` : ""}`);
        return;
      }
      try { onMessage(channel, payload); } catch (error) { log(`ambient ${surface} ${channel} failed: ${error?.message ?? error}`); }
    });
    target.on("closed", () => { if (win === target) { win = null; loaded = false; } });
    target.loadURL(address).catch(() => {});
    startFeeding();
    return target;
  }

  function close() {
    const target = win;
    clearTimeout(settleWait); settleWait = null;
    clearInterval(feeder); feeder = null; fedOver = false;
    win = null; loaded = false; interactive = false; page = null; keyed = false; typing = false; settling = false; held = null;
    if (target && !target.isDestroyed()) call("destroy", "", () => target.destroy());
  }

  return {
    surface,
    /** Puts the window where `next` says, making it on the first call once there is a page to load. */
    place(next) {
      bounds = next;
      const address = url();
      if (!address) return;
      if (live() && page !== address) close();
      if (!live()) {
        page = address;
        win = create(address);
        return;
      }
      // never under a surface that is in use or still closing: it moves once that has played out
      if (settling || interactive) { held = next; note("place-held", JSON.stringify(next)); return; }
      setBounds(next);
    },
    /** Sends now if the page is up; the newest of each kind is replayed when it loads. */
    send(channel, payload) {
      queued.set(channel, payload);
      if (live() && loaded) win.webContents.send(channel, payload);
    },
    interactive: () => interactive,
    owns: contents => live() && contents === win.webContents,
    shown: () => live(),
    close,
  };
}
