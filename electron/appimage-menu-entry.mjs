// an AppImage is one file with no installer, so nothing puts it in the app menu: on its launches the app keeps a
// per-user desktop entry and icon in step with where the AppImage is now (freedesktop Desktop Entry Specification 1.5,
// XDG_DATA_HOME). a .deb install already has /usr/share/applications/bot.dusk.app.desktop, which a per-user file of
// the same name would hide, so none is written then. Settings can take it out, and a removed entry stays removed.
import fs from "node:fs";
import path from "node:path";

export const ENTRY_NAME = "bot.dusk.app.desktop";
export const DEB_ENTRY = "/usr/share/applications/bot.dusk.app.desktop";
const MARK = "X-Dusk-AppImage=true";
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function menuEntryPaths({ home, env = {} }) {
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
  return { entry: path.join(data, "applications", ENTRY_NAME), icon: path.join(data, "icons", "hicolor", "scalable", "apps", "bot.dusk.app.svg") };
}

/**
 * one Exec argument: quoted, with ", `, $ and \ escaped (the spec's quoting rules), then the string-value escapes
 * applied to that (\ doubles again), and % doubled (field codes). null for a path an entry can't hold (a control character).
 */
export function execArg(value) {
  if (typeof value !== "string" || value === "" || CONTROL.test(value)) return null;
  return `"${value.replace(/["`$\\]/g, (match) => `\\${match}`)}"`.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

/** the entry's text, or null when `appImage` can't be written into one */
export function menuEntryText({ appImage, icon }) {
  const exec = execArg(appImage);
  if (!exec || CONTROL.test(icon)) return null;
  return ["[Desktop Entry]", "Type=Application", "Name=Metal", "Comment=Your own team of AI bots, in a chat app", `Exec=${exec} %U`,
    `Icon=${icon}`, "Terminal=false", "Categories=Utility;", "Keywords=AI;Agents;Chat;Productivity;", "StartupWMClass=bot.dusk.app",
    "MimeType=x-scheme-handler/duskbot;x-scheme-handler/openmausbot;", MARK, ""].join("\n");
}

const readOr = (file, fallback = null) => { try { return fs.readFileSync(file, "utf8"); } catch { return fallback; } };
function writeAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, data, { mode }); fs.renameSync(temp, file); } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}

/**
 * `available()`: this launch is an AppImage on Linux without the .deb's entry. `sync()` (each launch) writes or refreshes
 * the entry and icon unless the person removed them, or one of their own entries already starts this AppImage; it
 * answers "added", "updated", "current" or why it did nothing. `on()` and `set(on)` back Settings' switch.
 * `file`: where the person's removal is remembered.
 */
export function createAppImageMenuEntry({ platform = process.platform, env = process.env, home, file, iconSource, debEntry = DEB_ENTRY, log = () => {} }) {
  const appImage = env.APPIMAGE;
  const where = menuEntryPaths({ home, env });
  const saved = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch { return {}; } };
  const remember = (fields) => { try { writeAtomic(file, JSON.stringify({ ...saved(), ...fields })); } catch {} };
  const ours = () => readOr(where.entry, "").includes(MARK);
  const available = () => platform === "linux" && typeof appImage === "string" && path.isAbsolute(appImage) && !fs.existsSync(debEntry);
  /** another entry in the same folder that already starts this AppImage (one the person made by hand) */
  const theirs = () => {
    const folder = path.dirname(where.entry);
    let names = [];
    try { names = fs.readdirSync(folder); } catch { return false; }
    return names.some((name) => name.endsWith(".desktop") && name !== ENTRY_NAME && readOr(path.join(folder, name), "").includes(appImage));
  };

  function write() {
    const icon = readOr(iconSource);
    if (icon !== null && readOr(where.icon) !== icon) writeAtomic(where.icon, icon, 0o644);
    const text = menuEntryText({ appImage, icon: icon !== null ? where.icon : "duskbot" });
    if (!text) return "unwritable";
    const before = readOr(where.entry);
    if (before === text) return "current";
    writeAtomic(where.entry, text, 0o644);
    return before === null ? "added" : "updated";
  }

  return {
    available,
    on: () => available() && ours(),
    sync() {
      if (!available()) return "unavailable";
      if (saved().removed === true) return "removed";
      if (fs.existsSync(where.entry) && !ours()) return "theirs";
      if (!fs.existsSync(where.entry) && theirs()) return "theirs";
      try {
        const done = write();
        if (done === "added" || done === "updated") log(`app menu entry: ${done}`);
        return done;
      } catch (error) {
        log(`app menu entry: could not write it (${error?.code ?? error?.message ?? error})`);
        return "failed";
      }
    },
    set(on) {
      if (!available()) return false;
      if (on) {
        remember({ removed: false });
        if (fs.existsSync(where.entry) && !ours()) return true;
        write();
        return true;
      }
      if (ours()) fs.rmSync(where.entry, { force: true });
      fs.rmSync(where.icon, { force: true });
      remember({ removed: true });
      return false;
    },
  };
}

/** Settings' switch on this computer's own page (`guard`) */
export function installAppImageMenuEntry({ ipcMain, guard, entry }) {
  const state = () => ({ available: entry.available(), on: entry.on() });
  ipcMain.handle("app-menu-entry:state", guard("app-menu-entry:state", state));
  ipcMain.handle("app-menu-entry:set", guard("app-menu-entry:set", (_event, on) => { entry.set(on === true); return state(); }));
}
