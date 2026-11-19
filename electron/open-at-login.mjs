// The person's own login item, on once by default. Lending a computer to a Cloud once added a hidden one of its own,
// which `settle()` removes at startup. A launch from either starts hidden.
import fs from "node:fs";
import path from "node:path";

export const HIDDEN_ARG = "--dusk-hidden";
const MARK = "X-Dusk-Lending=true";
/** Windows keeps one Run entry per name, so the person's own entry has a name apart from lending's (the app's). */
const CHOSEN_NAME = "dusk bot at login";

/** Desktop Entry Exec quoting: the path in double quotes, with ", `, $ and \ escaped. */
const quoted = (value) => `"${value.replace(/["`$\\]/g, (match) => `\\${match}`)}"`;

export function autostartEntry(exec, { lending = true } = {}) {
  return ["[Desktop Entry]", "Type=Application", "Name=Metal", `Exec=${quoted(exec)} ${HIDDEN_ARG}`, "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true", ...(lending ? [MARK] : []), ""].join("\n");
}

/**
 * `file`: where this app records that it added the login item (macOS, where a login item carries no arguments), that
 * the person turned Open at login off (never turned on again for them), and that it was turned on by default once.
 * `follow(on)` keeps the login item in step with lending; `startedHidden()` says this launch came from a login item.
 * `chosen()` and `choose(on)`: the person's own login item, which lending never removes; on Windows, whether Windows
 * starts the app at sign-in at all, as its Startup apps list shows.
 * `settle()` at startup: turns it on once for a packaged app the person never turned it off in, then drops lending's
 * item; true when it turned it on.
 */
export function createOpenAtLogin({ app, file, platform = process.platform, env = process.env, home, argv = process.argv, execPath = process.execPath }) {
  const autostart = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "duskbot.desktop");
  const saved = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch { return {}; } };
  const store = (fields) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...saved(), ...fields })); } catch {} };
  const added = () => saved().added === true;
  const remember = (value) => store({ added: value });
  /** Electron 43.7 on Windows: `openAtLogin` compares the Run entry's arguments with the `args` asked about (none by
   * default), so lending's `--dusk-hidden` entry reads as off; `launchItems` lists the entries that start this executable,
   * each with its name, arguments and whether Task Manager has it enabled. */
  const windowsStartsApp = () => (app.getLoginItemSettings().launchItems ?? []).filter(item => item.enabled !== false);
  const declined = () => saved().declined === true
    || (platform === "win32" && (app.getLoginItemSettings().launchItems ?? []).some(item => item.enabled === false));
  const ours = () => { try { return fs.readFileSync(autostart, "utf8").includes(MARK); } catch { return false; } };
  const login = {
    follow(on) {
      if (!app.isPackaged) return;
      try {
        if (platform === "linux") {
          if (on && !fs.existsSync(autostart)) {
            fs.mkdirSync(path.dirname(autostart), { recursive: true });
            fs.writeFileSync(autostart, autostartEntry(env.APPIMAGE || execPath));
          } else if (!on && ours()) fs.rmSync(autostart, { force: true });
          return;
        }
        if (platform === "win32") {
          const settings = { args: [HIDDEN_ARG] };
          if (on && declined()) return;
          if (app.getLoginItemSettings(settings).openAtLogin !== on) app.setLoginItemSettings({ openAtLogin: on, ...settings });
          return;
        }
        const set = app.getLoginItemSettings().openAtLogin === true;
        if (on && !set) { app.setLoginItemSettings({ openAtLogin: true }); remember(true); }
        else if (!on && set && added()) { app.setLoginItemSettings({ openAtLogin: false }); remember(false); }
        else if (!set && added()) remember(false);
      } catch {}
    },
    available: () => app.isPackaged,
    chosen() {
      try {
        if (platform === "linux") return fs.existsSync(autostart) && !ours();
        if (platform === "win32") return windowsStartsApp().length > 0;
        return app.getLoginItemSettings().openAtLogin === true && !added();
      } catch { return false; }
    },
    choose(on) {
      if (!app.isPackaged) return;
      if (platform === "linux") {
        if (on) {
          fs.mkdirSync(path.dirname(autostart), { recursive: true });
          fs.writeFileSync(autostart, autostartEntry(env.APPIMAGE || execPath, { lending: false }));
        } else if (!ours()) fs.rmSync(autostart, { force: true });
      } else if (platform === "win32") {
        if (on) app.setLoginItemSettings({ openAtLogin: true, args: [HIDDEN_ARG], name: CHOSEN_NAME });
        else for (const item of windowsStartsApp()) app.setLoginItemSettings({ openAtLogin: false, args: item.args ?? [], name: item.name });
      } else {
        app.setLoginItemSettings({ openAtLogin: on });
        remember(false);
      }
      store({ declined: !on });
    },
    settle() {
      let turnedOn = false;
      if (app.isPackaged && saved().defaulted !== true) {
        try {
          if (!declined()) { login.choose(true); turnedOn = true; }
          store({ defaulted: true });
        } catch {}
      }
      login.follow(false);
      return turnedOn;
    },
    startedHidden() {
      if (platform === "darwin") {
        try { return app.getLoginItemSettings().wasOpenedAtLogin === true; } catch { return false; }
      }
      return argv.includes(HIDDEN_ARG);
    },
  };
  return login;
}

/** Settings' switch, on this computer's own page or My Cloud's page once it is home (`guard`); `changed` redraws the
 * app menu's item. */
export function installOpenAtLogin({ ipcMain, guard, loginItem, changed }) {
  const state = () => ({ available: loginItem.available(), on: loginItem.chosen() });
  ipcMain.handle("open-at-login:state", guard("open-at-login:state", state));
  ipcMain.handle("open-at-login:set", guard("open-at-login:set", (_event, on) => { loginItem.choose(on === true); changed(); return state(); }));
}
