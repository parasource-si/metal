// Electron has no role for the macOS Settings… item, so it is built explicitly.
import { Menu, app, shell } from "electron";

/** A local environment has a folder and no address. */
const whereItLives = (environment) => (environment.kind === "local" ? environment.dataDir : new URL(environment.origin).host);

/**
 * @param {object} input
 * @param {({ id: string, name: string, origin: string } | { id: string, name: string, kind: "local", dataDir: string })[]} input.environments
 * @param {string} input.activeId  "local" or an environment id
 * @param {(id: string) => void} input.onSwitch
 * @param {() => void} input.onAddFromClipboard
 * @param {() => void} input.onConnect
 * @param {(id: string) => void} input.onForget
 * @param {() => void} input.onOpenSettings
 * @param {() => void} input.onOrganizationSignIn
 * @param {{ origin: string, onBack: () => void } | null} [input.home] My Cloud once the person's bots moved there: the
 *   menu lists only the other saved servers, with Back to My Cloud, and is absent without any.
 * @param {{ checked: boolean, onToggle: (on: boolean) => void } | null} [input.openAtLogin] Open at Login, in the app
 *   menu on macOS and the File menu elsewhere; absent when this build cannot add a login item.
 * @param {(all: boolean) => void} [input.onStop] Stop Bot (⌘.) and Stop All Bots (⌥⌘.) in the File menu.
 * @param {(fromKeys: boolean) => void} [input.onQuit] Quit, told whether its accelerator (rather than a click) chose it,
 *   so ⌘Q can be held while a bot works; without it the item is Electron's own.
 */
/** What the native About panel shows beside the app icon (Electron app.setAboutPanelOptions). */
export function aboutPanelOptions(version) {
  return {
    applicationName: "Metal",
    applicationVersion: version,
    credits: "Your own team of AI bots, in a chat app",
    copyright: `© ${new Date().getFullYear()} dusk bot`,
    website: "https://github.com/parasource-si/metal",
  };
}

export function buildApplicationMenu({ environments, activeId, onSwitch, onAddFromClipboard, onConnect, onForget, onOpenSettings, onOrganizationSignIn, onAddCloud, sublabels = {}, home = null, openAtLogin = null, onQuit = null, onStop = null, onExportUsageLog = null }) {
  const isMac = process.platform === "darwin";
  const quit = onQuit
    ? { id: "quit", label: isMac ? `Quit ${app.name}` : process.platform === "win32" ? "Exit" : "Quit", ...(process.platform === "win32" ? {} : { accelerator: "CmdOrCtrl+Q" }), click: (_item, _window, event) => onQuit(event?.triggeredByAccelerator === true) }
    : { role: "quit" };
  const stops = onStop ? [
    { id: "stop-bot", label: "Stop bot", accelerator: "CmdOrCtrl+.", click: () => onStop(false) },
    { id: "stop-all-bots", label: "Stop all bots", accelerator: "Alt+CmdOrCtrl+.", click: () => onStop(true) },
    { type: "separator" },
  ] : [];
  const active = environments.find((e) => e.id === activeId) ?? null;
  const others = home ? environments.filter((e) => e.origin !== home.origin && e.kind !== "local") : [];
  const away = Boolean(active && home && active.origin !== home.origin);
  const homeServer = {
    label: "Server",
    submenu: [
      { id: "back-to-my-cloud", label: "Back to My Cloud", enabled: away, click: () => home?.onBack() },
      { type: "separator" },
      ...others.map((e) => ({ label: `${e.name} · ${new URL(e.origin).host}`, type: "radio", checked: e.id === activeId, click: () => onSwitch(e.id) })),
      { type: "separator" },
      { label: "Add server from copied pairing link…", click: () => onAddFromClipboard() },
      { label: away ? `Forget “${active.name}”` : "Forget server", enabled: away, click: () => away && onForget(active.id) },
    ],
  };
  const server = home ? homeServer : {
    label: "Server",
    submenu: [
      { label: "This computer", type: "radio", checked: !active, click: () => onSwitch("local") },
      ...environments.map((e) => ({
        label: `${e.name} · ${Object.hasOwn(sublabels, e.id) ? sublabels[e.id] : whereItLives(e)}`,
        type: "radio",
        checked: e.id === activeId,
        click: () => onSwitch(e.id),
      })),
      ...(onAddCloud ? [{ id: "add-cloud", label: "Add a Cloud…", click: () => onAddCloud() }] : []),
      { type: "separator" },
      { id: "organization-sign-in", label: "Sign in with your organization…", click: onOrganizationSignIn },
      { label: "Connect to a server…", click: onConnect },
      { label: "Add server from copied pairing link…", click: () => onAddFromClipboard() },
      {
        label: active ? `Forget “${active.name}”` : "Forget server",
        enabled: Boolean(active),
        click: () => active && onForget(active.id),
      },
    ],
  };
  const atLogin = openAtLogin ? [{ id: "open-at-login", label: "Open at login", type: "checkbox", checked: openAtLogin.checked, click: () => openAtLogin.onToggle(!openAtLogin.checked) }] : [];
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: "about" }, { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => onOpenSettings() }, ...atLogin, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, quit] }] : []),
    isMac ? (stops.length ? { label: "File", submenu: [...stops, { role: "close" }] } : { role: "fileMenu" })
      : openAtLogin || onQuit || stops.length ? { label: "File", submenu: [...stops, ...atLogin, ...(atLogin.length ? [{ type: "separator" }] : []), quit] } : { role: "fileMenu" },
    { role: "editMenu" },
    ...(home && !others.length ? [] : [server]),
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "Metal help", click: () => void shell.openExternal("https://github.com/parasource-si/metal/tree/main/docs") },
      { label: "What's new", click: () => void shell.openExternal("https://github.com/parasource-si/metal/blob/main/CHANGELOG.md") },
      { type: "separator" },
      { label: "Contact support", click: () => void shell.openExternal("https://github.com/parasource-si/metal/issues") },
      ...(onExportUsageLog ? [{ label: "Export usage log…", click: () => onExportUsageLog() }] : []),
    ] },
  ];
  return Menu.buildFromTemplate(template);
}
