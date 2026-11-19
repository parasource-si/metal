// contextIsolation stays on: the renderer sees only window.duskDesktop, never Node or ipcRenderer.
const { contextBridge, ipcRenderer, webFrame, webUtils } = require("electron");

// Sandboxed preloads get Electron's restricted `require`, which cannot load sibling CommonJS files.
const desktopRemoteClient = process.argv.includes("--duskbot-remote-client");

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  if (typeof url !== "string") return;
  pendingPackageInstallUrl = url;
  for (const listener of packageInstallListeners) listener(url);
});

let pendingChatLink = null;
const chatLinkListeners = new Set();
ipcRenderer.on("chat:open", (_event, link) => {
  if (typeof link !== "string") return;
  if (!chatLinkListeners.size) {
    pendingChatLink = link;
    return;
  }
  for (const listener of chatLinkListeners) listener(link);
});

let pendingSlackOAuth = null;
const slackOAuthListeners = new Set();
ipcRenderer.on("slack:oauth", (_event, link) => {
  if (typeof link !== "string") return;
  if (!slackOAuthListeners.size) {
    pendingSlackOAuth = link;
    return;
  }
  for (const listener of slackOAuthListeners) listener(link);
});

let pendingNotificationOpen = null;
const notificationOpenListeners = new Set();
ipcRenderer.on("desktop-notifications:open", (_event, target) => {
  if (!notificationOpenListeners.size) {
    pendingNotificationOpen = target;
    return;
  }
  for (const listener of notificationOpenListeners) listener(target);
});

// Only fixed actions are retained, never a destination supplied by a renderer.
const FIXED_SETTINGS_ACTIONS = new Set(["organization", "cloud", "cloud-settings", "cloud-add", "cloud-add-howto"]);
let pendingSettingsAction = null;
const appSettingsListeners = new Set();
ipcRenderer.on("app:open-settings", (_event, section) => {
  const fixedSection = FIXED_SETTINGS_ACTIONS.has(section) ? section : undefined;
  if (fixedSection && !appSettingsListeners.size) pendingSettingsAction = fixedSection;
  if (!appSettingsListeners.size) return;
  pendingSettingsAction = null;
  for (const listener of appSettingsListeners) listener(fixedSection);
});

// The full bridge goes only to the local server's UI; a remote page gets the safe subset, and main enforces the same rule.
const currentLocalOrigin = process.argv.includes("--dusk-current-local-origin=1");
const localOrigin = currentLocalOrigin ? (() => {
  try {
    const origin = ipcRenderer.sendSync("desktop:local-origin");
    return typeof origin === "string" && origin ? origin : null;
  } catch { return null; }
})() : process.argv.find((arg) => arg.startsWith("--dusk-local-origin="))?.slice("--dusk-local-origin=".length) ?? null;
const isLocalPage = (!currentLocalOrigin && !localOrigin) || (localOrigin !== null && location.origin === localOrigin);

// The window's own rail of places stands at its left edge (electron/chrome-rail.mjs): main says how wide, and every page
// beside it, whatever server it comes from, moves over by that much, at any zoom (a zoom change resizes the page). The
// page reads how far in `--rail-beside`, which changes with the move itself.
let railBeside = 0, railRoom = null;
function leaveRailRoom() {
  if (typeof document === "undefined" || !document.documentElement) return;
  const zoom = Number(webFrame?.getZoomFactor?.()) || 1;
  if (!railBeside) { railRoom?.remove(); railRoom = null; return; }
  railRoom ??= document.createElement("style");
  const room = `${Math.round((railBeside / zoom) * 100) / 100}px`;
  railRoom.textContent = `html { box-sizing: border-box !important; padding-left: ${room} !important; --rail-beside: ${room}; }`;
  if (!railRoom.isConnected) (document.head ?? document.documentElement).append(railRoom);
}
const railState = (state) => ({ available: state?.available === true, hidden: state?.hidden === true });
ipcRenderer.on("rail:beside", (_event, width) => { railBeside = Math.max(0, Math.min(200, Number(width) || 0)); leaveRailRoom(); });
// The rail's own page keeps its size whatever the zoom of this app's page: Chromium gives every page of a host the same
// zoom, the rail's included, so the rail takes it back out and stays as wide as its strip.
function railKeepsItsSize() {
  if (!isLocalPage || location.pathname !== "/rail" || typeof document === "undefined" || !document.documentElement) return;
  const zoom = Number(webFrame?.getZoomFactor?.()) || 1;
  document.documentElement.style.zoom = zoom === 1 ? "" : String(Math.round((1 / zoom) * 10000) / 10000);
}
if (typeof window !== "undefined") {
  for (const type of ["resize", "DOMContentLoaded"]) window.addEventListener(type, () => { leaveRailRoom(); railKeepsItsSize(); });
}
const REMOTE_SAFE = new Set(["platform", "cloudMac", "app", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus", "workspaces", "rail", "cloudAdd", "cloudPlan", "cloudSendPage", "accountSheet", "desktopNotices", "desktopNotifications", "desktopAnalytics", "desktopLanguage", "windowControls", "onOpenAppSettings", "windowFrame", "sealTrust", "linkDirect", "onSlackOAuth", "ambient", "desktopBots", "requireUserPresence", "vpsCloudMove", "trail"]);
/** My Cloud's own page once it is the person's home (main checks the sender again): it is this app's page then. */
const HOME_PAGE = ["home", "appUpdate", "onChatLink", "onPackageInstall", "exportDiagnostics", "openLogsFolder", "openAtLogin", "callActive", "productEvents",
  "speechStart", "speechStop", "speechFinish", "onSpeechTranscript", "onSpeechEnd", "onSpeechLevel"];
function homePage() {
  try { return ipcRenderer.sendSync("home:page") === true; } catch { return false; }
}
function reloadedForUpdate() {
  try { return ipcRenderer.sendSync("home:updating") === true; } catch { return false; }
}
function savedAnalyticsChoice() {
  try { const saved = ipcRenderer.sendSync("desktop-analytics:read"); return typeof saved === "boolean" ? saved : null; } catch { return null; }
}
let analyticsChoice;
function savedLanguageChoice() {
  try { const saved = ipcRenderer.sendSync("desktop-language:read"); return typeof saved === "string" ? saved : null; } catch { return null; }
}
let languageChoice;
const languageListeners = new Set();
ipcRenderer.on("desktop-language:changed", (_event, language) => {
  if (typeof language !== "string") return;
  languageChoice = language;
  for (const listener of languageListeners) listener(language);
});
const onHomePage = !isLocalPage && homePage();
const remoteKeys = isLocalPage ? REMOTE_SAFE : new Set([...REMOTE_SAFE, ...(onHomePage ? HOME_PAGE : [])]);

// Keep in parity with shared/workspace-backup-client.ts (a sandboxed preload cannot import it).
const COMPANY_BACKUP_CLIENT_KEYS = [
  "dusk-drafts", "dusk-draft-attachments", "dusk-draft-send-ids", "dusk-draft-channel-modes",
  "dusk-skin", "dusk-show-threads", "dusk-show-run-card", "dusk-send-key", "dusk-color-user-bubbles", "dusk-chat-width", "duskbot.sidebarDensity",
  "duskbot.sidebarToolsLayout",
  "duskbot.sidebarCollapsedSections.v1", "duskbot.sidebarSectionOrder.v1",
  "dusk-analytics-opt-out", "duskbot.remote-voice.v1",
];
if (isLocalPage && !desktopRemoteClient && process.argv.includes("--dusk-company-desktop=1")) {
  ipcRenderer.on("company-backups:collect-client-state", (_event, request) => {
    if (!request || typeof request.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(request.requestId)) return;
    try {
      // Check the origin again; a later navigation must not export remote data.
      if (!localOrigin || location.origin !== localOrigin) throw new Error("Not the local workspace");
      const clientState = {};
      for (const key of COMPANY_BACKUP_CLIENT_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) clientState[key] = value;
      }
      if (new TextEncoder().encode(JSON.stringify(clientState)).byteLength > 2 * 1024 ** 2) throw new Error("Browser state too large");
      ipcRenderer.send("company-backups:client-state", { requestId: request.requestId, clientState });
    } catch {
      ipcRenderer.send("company-backups:client-state", { requestId: request.requestId, unavailable: true });
    }
  });
}

// main passes app.getVersion(): a server's page carries that server's version, so About asks this for the app's own.
const appVersion = (process.argv.find((arg) => arg.startsWith("--dusk-app-version="))?.slice("--dusk-app-version=".length) ?? "").slice(0, 64);

/** ipcRenderer wraps a main-process throw in "Error invoking remote method"; the page shows the text verbatim. */
function invokeWithPlainError(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const message = String(error?.message ?? error);
    throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
  });
}

const bridge = {
  platform: process.platform,
  arch: process.arch,
  /** This app's version, and whether this page is this app's own (served by this computer, not a server from the Server menu). */
  app: { version: appVersion, ownPage: isLocalPage },
  // Safe on a cloud page: the person chooses in a native menu, or a circle of the rail main listed (only for this app's
  // page and a hosted Cloud's, never addresses), and only from their click; no saved-list reads, host files or secrets.
  workspaces: {
    state: () => ipcRenderer.invoke("workspaces:state"),
    menu: (options) => ipcRenderer.invoke("workspaces:menu", ...(options?.from === "howto" ? ["howto"] : [])),
    line: () => ipcRenderer.invoke("workspaces:line"),
    places: () => ipcRenderer.invoke("workspaces:places"),
    open: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:open", String(id)) : Promise.reject(new Error("Choose a place to open it.")),
    add: (choice, link) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:add", String(choice), ...(typeof link === "string" ? [link] : [])) : Promise.reject(new Error("Choose what to add.")),
    // The colour of the place this page is (never another's): read, and changed only from the person's click.
    look: () => ipcRenderer.invoke("workspaces:look"),
    color: (swatch) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:color", swatch === null ? null : String(swatch)) : Promise.reject(new Error("Choose a color.")),
    // The colour of a place the window's rail lists, from a click on the rail's own page (main refuses any other page).
    recolor: (id, swatch) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:recolor", String(id), swatch === null ? null : String(swatch)) : Promise.reject(new Error("Choose a color.")),
    // Remove from list, for a Cloud the window's rail lists as removable, from a click on the rail's own page (main refuses any other page).
    remove: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:remove", String(id)) : Promise.reject(new Error("Choose Remove from list.")),
    // Make a server of the person's own their bots' home, from a click on the rail's own page (main refuses any other page).
    makeHome: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:make-home", String(id)) : Promise.reject(new Error("Choose Make my home.")),
    // Open a server of the person's own with its move to dusk cloud sheet, from a click on the rail's own page.
    cloudMove: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:cloud-move", String(id)) : Promise.reject(new Error("Choose Move to dusk cloud.")),
    onChanged: (cb) => {
      const handler = () => cb();
      ipcRenderer.on("workspaces:changed", handler);
      return () => ipcRenderer.removeListener("workspaces:changed", handler);
    },
    onSwitching: (cb) => {
      const handler = (_event, on) => cb(on === true);
      ipcRenderer.on("workspaces:switching", handler);
      return () => ipcRenderer.removeListener("workspaces:switching", handler);
    },
    handLook: (look) => ipcRenderer.send("workspaces:switch-look", look),
    takeLook: () => { try { return ipcRenderer.sendSync("workspaces:switch-look-take") ?? null; } catch { return null; } },
    arrived: () => { try { return ipcRenderer.sendSync("workspaces:switch-arrived") === true; } catch { return false; } },
  },
  // The window's own rail (this app's page at /rail, beside every place's page): while a sheet of its own is open it
  // covers the window; the skin of the page beside it comes from main, and whether that page draws the window's frame.
  // The page beside it, from whichever server, offers the button that hides and shows it, and learns only whether there
  // is one to hide, never its places; it says when it draws the frame, so main puts the traffic lights in its top bar.
  rail: {
    state: () => ipcRenderer.invoke("rail:offer").then(railState),
    drawsFrame: (drawn) => ipcRenderer.invoke("rail:draws-frame", drawn !== false),
    setHidden: (hidden) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("rail:hide", hidden === true).then(railState) : Promise.reject(new Error("Choose to hide or show your computers.")),
    onState: (cb) => {
      const handler = (_event, state) => cb(railState(state));
      ipcRenderer.on("rail:state", handler);
      return () => ipcRenderer.removeListener("rail:state", handler);
    },
    ...(isLocalPage ? {
      expand: (on) => ipcRenderer.invoke("rail:expand", on === true),
      onSkin: (cb) => {
        const handler = (_event, skin) => cb(String(skin));
        ipcRenderer.on("rail:skin", handler);
        return () => ipcRenderer.removeListener("rail:skin", handler);
      },
      onFramed: (cb) => {
        const handler = (_event, framed) => cb(framed === true);
        ipcRenderer.on("rail:framed", handler);
        return () => ipcRenderer.removeListener("rail:framed", handler);
      },
    } : {}),
  },
  // The notch island and the bot dock (electron/ambient-main.mjs): whichever place the window shows sums up its bots for
  // them and carries out their asks; a server's page changes the choices only from the person's click.
  ambient: {
    prefs: () => ipcRenderer.invoke("ambient:prefs"),
    set: (change) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("ambient:set", change && typeof change === "object" ? { ...change } : {}) : Promise.reject(new Error("Choose a setting to change it.")),
    wanted: () => ipcRenderer.invoke("ambient:wanted"),
    onWanted: (cb) => {
      const handler = (_event, wanted) => cb(wanted === true);
      ipcRenderer.on("ambient:wanted", handler);
      return () => ipcRenderer.removeListener("ambient:wanted", handler);
    },
    publish: (snapshot) => ipcRenderer.send("ambient:publish", snapshot),
    onViewing: (cb) => {
      const handler = (_event, viewing) => cb(viewing && typeof viewing === "object" ? viewing : null);
      ipcRenderer.on("ambient:viewing", handler);
      return () => ipcRenderer.removeListener("ambient:viewing", handler);
    },
    onAct: (cb) => {
      const handler = (_event, act) => cb(act);
      ipcRenderer.on("ambient:act", handler);
      return () => ipcRenderer.removeListener("ambient:act", handler);
    },
  },
  // This computer's page only: where the person's bots live while it has none (electron/bots-elsewhere.mjs).
  elsewhere: {
    state: () => ipcRenderer.invoke("elsewhere:state"),
    open: (id) => ipcRenderer.invoke("elsewhere:open", typeof id === "string" ? id : ""),
    connect: () => ipcRenderer.invoke("elsewhere:connect"),
    stay: () => ipcRenderer.invoke("elsewhere:stay"),
    counts: () => ipcRenderer.invoke("elsewhere:counts"),
  },
  // The window's working bots for ⌘Q (main counts only this computer's page), and the menu's Stop commands.
  desktopBots: {
    busy: (names) => ipcRenderer.send("desktop-bots:busy", Array.isArray(names) ? names.slice(0, 40).map((entry) => String(entry).slice(0, 60)) : []),
    onQuitHint: (cb) => {
      const handler = (_event, names) => cb(Array.isArray(names) ? names.map(String) : []);
      ipcRenderer.on("desktop-bots:quit-hint", handler);
      return () => ipcRenderer.removeListener("desktop-bots:quit-hint", handler);
    },
    onStop: (cb) => {
      const handler = (_event, command) => cb({ all: command?.all === true });
      ipcRenderer.on("desktop-bots:stop", handler);
      return () => ipcRenderer.removeListener("desktop-bots:stop", handler);
    },
  },
  // The window's own frame, this desktop's choice for every page of its window; a server's page changes it only from the
  // person's click.
  windowFrame: {
    state: () => ipcRenderer.invoke("window-frame:state"),
    set: (on) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("window-frame:set", on === true) : Promise.reject(new Error("Choose to turn the window frame on or off.")),
  },
  // Buying another Cloud from the rail's ＋, on this app's page or a hosted Cloud's: plain words in, what the sheet says
  // out; the account, the token and the checkout page stay in main. Only from the person's click where it opens anything.
  cloudAdd: {
    state: () => ipcRenderer.invoke("cloud-add:state"),
    start: (tier, name, color, source) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:start", String(tier), String(name), color === null ? null : String(color), ...(source == null ? [] : [String(source)]))
      : Promise.reject(new Error("Choose Continue to checkout.")),
    reopen: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:reopen") : Promise.reject(new Error("Choose Reopen checkout.")),
    copyLink: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:copy-link") : Promise.reject(new Error("Choose Copy link.")),
    open: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:open") : Promise.reject(new Error("Choose Open to open it.")),
    interest: () => ipcRenderer.invoke("cloud-add:interest"),
    sheet: (open) => ipcRenderer.invoke("cloud-add:sheet", open === true),
    organization: (name, color) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-add:organization", String(name), color === null ? null : String(color)) : Promise.reject(new Error("Choose Create organization.")),
  },
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** The bearer stays in the main process and is never returned over this bridge. */
  remoteClient: {
    active: desktopRemoteClient,
    state: () => ipcRenderer.invoke("desktop-remote:state"),
    pair: (endpoint, code) => ipcRenderer.invoke("desktop-remote:pair", endpoint, code),
    disconnect: () => ipcRenderer.invoke("desktop-remote:disconnect"),
  },
  companion: {
    state: () => ipcRenderer.invoke("companion:state"),
    start: () => ipcRenderer.invoke("companion:start"),
    stop: () => ipcRenderer.invoke("companion:stop"),
    keepAwake: (enabled) => ipcRenderer.invoke("companion:keep-awake", enabled),
    refreshTailscale: () => ipcRenderer.invoke("companion:refresh-tailscale"),
    pairing: (open, expectedToken) => ipcRenderer.invoke("companion:pairing", open, expectedToken),
    cloudDesktop: (deviceId, allowed) => ipcRenderer.invoke("companion:cloud-desktop", deviceId, allowed),
    browserControl: (deviceId, allowed) => ipcRenderer.invoke("companion:browser-control", deviceId, allowed),
    revoke: (deviceId) => ipcRenderer.invoke("companion:revoke", deviceId),
  },
  routines: {
    wakeState: () => ipcRenderer.invoke("routines:wake-state"),
    keepAwake: (enabled) => ipcRenderer.invoke("routines:keep-awake", enabled),
  },
  /** Secrets stay in the main process; the renderer sees only status and narrow actions. */
  companionAccount: {
    state: () => ipcRenderer.invoke("companion-account:state"),
    requestCode: (email) => ipcRenderer.invoke("companion-account:request-code", email),
    verifyCode: (email, code) => ipcRenderer.invoke("companion-account:verify-code", email, code),
    retry: () => ipcRenderer.invoke("companion-account:retry"),
    prepare: () => ipcRenderer.invoke("companion-account:prepare"),
    signOut: () => ipcRenderer.invoke("companion-account:sign-out"),
  },
  /** This computer's relay to its phones: status only; the tunnel token and keys never leave the main process. */
  phoneRelay: {
    state: () => ipcRenderer.invoke("phone-relay:state"),
    ready: () => ipcRenderer.invoke("phone-relay:ready"),
  },
  /** Full/Custom never go through the loopback API, only the embedded server's private utilityProcess port. */
  approvals: {
    setMode: (botId, mode, options) => ipcRenderer.invoke("approvals:set-trusted-mode", botId, mode, options),
  },
  localControl: {
    status: () => ipcRenderer.invoke("cua:linux-status"),
    enable: () => ipcRenderer.invoke("cua:linux-enable"),
    disable: () => ipcRenderer.invoke("cua:linux-disable"),
    retry: () => ipcRenderer.invoke("cua:linux-retry"),
  },
  /** Arms exactly one display-media request from the current renderer frame. */
  beginScreenPreviewIntent: () => ipcRenderer.sendSync("screen:preview-intent"),
  /** The bot's live screen preview, which needs no click. `begin()` arms one display-media request; false off macOS.
   * Async on purpose: an app whose main process predates it rejects instead of failing a synchronous call. */
  screenLive: {
    begin: () => ipcRenderer.invoke("screen:live-intent"),
  },
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  // stub: the android device tab is gone, kept for pages of the last two releases (bridge-contract.json)
  androidDevice: {
    status: () => Promise.resolve({ available: false, reasonCode: "adb-unavailable", devices: [] }),
    frame: () => Promise.reject(new Error("android device view was removed")),
    input: () => Promise.reject(new Error("android device view was removed")),
  },
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  onSpeechLevel: (cb) => {
    const handler = (_event, level) => cb(level);
    ipcRenderer.on("speech:level", handler);
    return () => ipcRenderer.removeListener("speech:level", handler);
  },
  // This computer's page only (never in REMOTE_SAFE, and main refuses any other): a speech service set up in Settings >
  // Voice. Main holds the keys; only whether one is saved comes back.
  voiceInput: {
    keys: {
      status: () => ipcRenderer.invoke("voice-input:keys:status"),
      set: (provider, key) => ipcRenderer.invoke("voice-input:keys:set", String(provider), String(key)),
      clear: provider => ipcRenderer.invoke("voice-input:keys:clear", String(provider)),
    },
    start: options => ipcRenderer.invoke("voice-input:start", {
      provider: String(options?.provider ?? ""),
      ...(typeof options?.language === "string" ? { language: options.language } : {}),
      ...(typeof options?.model === "string" ? { model: options.model } : {}),
      realtime: options?.realtime === true,
      ...(typeof options?.baseUrl === "string" ? { baseUrl: options.baseUrl } : {}),
      ...(options?.whisperCpp ? { whisperCpp: { binary: String(options.whisperCpp.binary ?? ""), model: String(options.whisperCpp.model ?? "") } } : {}),
    }),
    audio: (id, pcm) => {
      if (Object.prototype.toString.call(pcm) === "[object ArrayBuffer]") ipcRenderer.send("voice-input:audio", String(id), pcm);
    },
    finish: id => ipcRenderer.invoke("voice-input:finish", String(id)),
    stop: id => ipcRenderer.invoke("voice-input:stop", String(id)),
    onTranscript: cb => {
      const handler = (_event, line) => cb(line);
      ipcRenderer.on("voice-input:transcript", handler);
      return () => ipcRenderer.removeListener("voice-input:transcript", handler);
    },
    onEnd: cb => {
      const handler = (_event, info) => cb(info);
      ipcRenderer.on("voice-input:end", handler);
      return () => ipcRenderer.removeListener("voice-input:end", handler);
    },
    findWhisperCpp: () => ipcRenderer.invoke("voice-input:find-whisper"),
  },
  talkShortcut: {
    state: () => ipcRenderer.invoke("talk-shortcut:state"),
    set: (change) => ipcRenderer.invoke("talk-shortcut:set", {
      ...(typeof change?.enabled === "boolean" ? { enabled: change.enabled } : {}),
      ...(typeof change?.key === "string" ? { key: change.key } : {}),
    }),
  },
  callActive: (active) => ipcRenderer.invoke("call:active", active === true).then(() => undefined),
  onOpenAppSettings: (cb) => {
    appSettingsListeners.add(cb);
    queueMicrotask(() => {
      const section = pendingSettingsAction;
      if (!section || !appSettingsListeners.size) return;
      pendingSettingsAction = null;
      for (const listener of appSettingsListeners) listener(section);
    });
    return () => appSettingsListeners.delete(cb);
  },
  /** Electron 32 removed File.path, and only the preload can ask. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** No screen field: macOS 15+ caches that status per process, so it would lie after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  /** Accessibility and Screen Recording on macOS: `status` never prompts, `request` asks for one. */
  macPermissions: {
    status: () => ipcRenderer.invoke("mac-permissions:status"),
    request: (kind) => ipcRenderer.invoke("mac-permissions:request", String(kind)),
  },
  relaunch: () => ipcRenderer.invoke("desktop:relaunch"),

  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  /** Unlike window.open, this still works after an asynchronous API request. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  /** A provider's browser sign-in that returns to localhost on a remote workspace: listen on that port here, hand
   * back the callback, then answer the browser. `open` is false when the port is taken on this computer. */
  authRelay: {
    open: (port, path) => ipcRenderer.invoke("auth-relay:open", port, path),
    next: (port) => ipcRenderer.invoke("auth-relay:next", port),
    done: (port, result) => ipcRenderer.invoke("auth-relay:done", port, result),
    close: (port) => ipcRenderer.invoke("auth-relay:close", port),
  },
  /** Brings this window back to the front, after a sign-in finished in the browser. */
  focusWindow: () => ipcRenderer.invoke("desktop:focus-window"),
  applySkin: (skin) => ipcRenderer.invoke("desktop:skin", skin),
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    state: () => ipcRenderer.invoke("window:state"),
    resizeWidthBy: (deltaWidth) => ipcRenderer.invoke("window:resize-width-by", deltaWidth),
    onMaximizedChanged: (cb) => {
      const handler = (_event, maximized) => cb(maximized);
      ipcRenderer.on("window:maximized-changed", handler);
      return () => ipcRenderer.removeListener("window:maximized-changed", handler);
    },
  },
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  onChatLink: (cb) => {
    chatLinkListeners.add(cb);
    if (pendingChatLink) {
      const link = pendingChatLink;
      pendingChatLink = null;
      cb(link);
    }
    return () => chatLinkListeners.delete(cb);
  },
  onSlackOAuth: (cb) => {
    slackOAuthListeners.add(cb);
    if (pendingSlackOAuth) {
      const link = pendingSlackOAuth;
      pendingSlackOAuth = null;
      cb(link);
    }
    return () => slackOAuthListeners.delete(cb);
  },
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  desktopViewer: {
    open: (url, title, contextId) => ipcRenderer.invoke("desktop-viewer:open", url, title, contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-viewer:close", contextId),
    currentState: () => ipcRenderer.invoke("desktop-viewer:state-now"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-viewer:state", handler);
      return () => ipcRenderer.removeListener("desktop-viewer:state", handler);
    },
  },
  desktopWorkspace: {
    open: (input) => ipcRenderer.invoke("desktop-workspace:open", input),
    layout: (items) => ipcRenderer.invoke("desktop-workspace:layout", items),
    setInteractive: (contextId) => ipcRenderer.invoke("desktop-workspace:set-interactive", contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-workspace:close", contextId),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-workspace:state", handler);
      return () => ipcRenderer.removeListener("desktop-workspace:state", handler);
    },
  },
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  // the debug trail (electron/trail.mjs): events go to main's trail file, which redacts them again; the export saves a
  // scrubbed copy where the person picks and answers only whether it was saved or sent
  trail: {
    write: (events) => { if (Array.isArray(events) && events.length) ipcRenderer.send("trail:write", events.slice(0, 200)); },
    exportUsageLog: () => ipcRenderer.invoke("trail:export"),
  },
  saveFile: (filePath) => invokeWithPlainError("desktop:save-file", filePath),
  revealInFolder: (filePath) => ipcRenderer.invoke("desktop:reveal-file", filePath),
  openHtmlInBrowser: (source, name) => invokeWithPlainError("desktop:open-html", source, name),
  // This app's own logs folder (server.log, desktop-crashes.log); the page names no path.
  openLogsFolder: () => ipcRenderer.invoke("desktop:open-logs"),
  openAtLogin: {
    state: () => ipcRenderer.invoke("open-at-login:state"),
    set: on => on !== true || isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("open-at-login:set", on === true) : Promise.reject(new Error("Turn on the switch to open Metal at login.")),
  },
  // An AppImage's own entry in the app menu (electron/appimage-menu-entry.mjs); this computer's page only.
  appMenuEntry: {
    state: () => ipcRenderer.invoke("app-menu-entry:state"),
    set: on => ipcRenderer.invoke("app-menu-entry:set", on === true),
  },
  setCredential: (name, value) => ipcRenderer.invoke("credential:set", name, value),

  /** A remote page may read the list but never change where this window goes. */
  environments: {
    state: () => ipcRenderer.invoke("environments:state"),
    switch: (id) => ipcRenderer.invoke("environments:switch", id),
    addFromLink: (link, name) => ipcRenderer.invoke("environments:add-from-link", link, name),
    create: (name, dataDir) => ipcRenderer.invoke("environments:create", name, dataDir),
    pickDir: () => ipcRenderer.invoke("environments:pick-dir"),
    forget: (id, purge) => ipcRenderer.invoke("environments:forget", id, purge === true),
    onOpenSettings: (cb) => {
      const handler = (_event, computerId) => cb(computerId);
      ipcRenderer.on("workspaces:open-settings", handler);
      return () => ipcRenderer.removeListener("workspaces:open-settings", handler);
    },
  },
  accountGate: process.argv.includes("--dusk-account-gate=1") ? {
    state: () => ipcRenderer.invoke("account-gate:state"),
    signInStart: (email, options) => ipcRenderer.invoke("account-gate:signInStart", String(email), { recover: options?.recover === true }),
    options: () => ipcRenderer.invoke("account-gate:options"),
    reopen: () => ipcRenderer.invoke("account-gate:reopen"),
    signInVerify: code => ipcRenderer.invoke("account-gate:signInVerify", String(code)),
    signInCancel: () => ipcRenderer.invoke("account-gate:signInCancel"),
    browser: provider => ipcRenderer.invoke("account-gate:browser", String(provider)),
    magicLink: email => ipcRenderer.invoke("account-gate:magicLink", String(email)),
    cancel: () => ipcRenderer.invoke("account-gate:cancel"),
    onChange: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("account-gate:changed", handler);
      return () => ipcRenderer.removeListener("account-gate:changed", handler);
    },
  } : undefined,
  cloudAccount: process.argv.includes("--dusk-company-desktop=1") ? {
    state: () => ipcRenderer.invoke("cloud-account:state"),
    begin: () => ipcRenderer.invoke("cloud-account:begin"),
    signInAgain: () => ipcRenderer.invoke("cloud-account:signInAgain"),
    reopen: () => ipcRenderer.invoke("cloud-account:reopen"),
    cancel: () => ipcRenderer.invoke("cloud-account:cancel"),
    refresh: () => ipcRenderer.invoke("cloud-account:refresh"),
    signOut: () => ipcRenderer.invoke("cloud-account:signOut"),
    openDashboard: () => ipcRenderer.invoke("cloud-account:openDashboard"),
    openPage: (page, workspaceId) => ipcRenderer.invoke("cloud-account:openPage", String(page), workspaceId === undefined ? undefined : String(workspaceId)),
    offer: () => ipcRenderer.invoke("cloud-account:offer"),
    // an account step in the browser: { kind: "signin" | "upgrade" | "billing", plan?, source?, move? } (shared/account-api.ts)
    continueInBrowser: intent => ipcRenderer.invoke("cloud-account:continueInBrowser", intent && typeof intent === "object"
      ? { kind: String(intent.kind), ...(intent.plan ? { plan: String(intent.plan) } : {}), ...(intent.source ? { source: String(intent.source) } : {}), ...(intent.move ? { move: String(intent.move) } : {}) } : null),
    checkout: (plan, source) => ipcRenderer.invoke("cloud-account:checkout", String(plan), String(source)),
    // The buying sheet: plain text in, outcomes out; the attempt, the token and the checkout page stay in main.
    signInStart: email => ipcRenderer.invoke("cloud-account:signInStart", String(email)),
    signInVerify: code => ipcRenderer.invoke("cloud-account:signInVerify", String(code)),
    signInCancel: () => ipcRenderer.invoke("cloud-account:signInCancel"),
    reopenCheckout: (plan, source) => ipcRenderer.invoke("cloud-account:reopenCheckout", String(plan), String(source)),
    copyCheckoutLink: () => ipcRenderer.invoke("cloud-account:copyCheckoutLink"),
    interest: () => ipcRenderer.invoke("cloud-account:interest"),
    look: () => ipcRenderer.invoke("cloud-account:look"),
    setLook: (name, color) => ipcRenderer.invoke("cloud-account:setLook", String(name), String(color)),
    sheet: open => ipcRenderer.invoke("cloud-account:sheet", open === true),
    readySeen: () => ipcRenderer.invoke("cloud-account:readySeen"),
    connectHome: () => ipcRenderer.invoke("cloud-account:connectHome"),
    connectHomeForPhone: () => ipcRenderer.invoke("cloud-account:connectHomeForPhone"),
    openTeam: teamId => ipcRenderer.invoke("cloud-account:openTeam", String(teamId)),
    // Cancel trial / Cancel plan and Keep my plan: the survey's words only; main names the Cloud from the verified session.
    cancelPlan: survey => ipcRenderer.invoke("cloud-account:cancelPlan", survey ?? null),
    keepPlan: () => ipcRenderer.invoke("cloud-account:keepPlan"),
    holdSignIns: () => ipcRenderer.invoke("cloud-account:holdSignIns"),
    carriedAis: () => ipcRenderer.invoke("cloud-account:carriedAis"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("cloud-account:state-changed", handler);
      return () => ipcRenderer.removeListener("cloud-account:state-changed", handler);
    },
    files: {
      state: () => ipcRenderer.invoke("files:state"),
      pickFolder: () => ipcRenderer.invoke("files:pick"),
      checkFolders: paths => ipcRenderer.invoke("files:check", paths),
      share: token => ipcRenderer.invoke("files:share", token),
      stopSharing: folderId => ipcRenderer.invoke("files:stop", folderId),
      answerDeletes: (folderId, remove) => ipcRenderer.invoke("files:deletes", folderId, remove),
      locate: folderId => ipcRenderer.invoke("files:locate", folderId),
      setOutputs: enabled => ipcRenderer.invoke("files:outputs", enabled),
      open: target => ipcRenderer.invoke("files:open", target),
      moreSpace: () => ipcRenderer.invoke("files:more-space"),
      onState: cb => {
        const handler = (_event, state) => cb(state);
        ipcRenderer.on("files:state-changed", handler);
        return () => ipcRenderer.removeListener("files:state-changed", handler);
      },
    },
  } : undefined,
  // Either page: the one-time move's line.
  cloudSendPage: process.argv.includes("--dusk-company-desktop=1") ? {
    notice: () => ipcRenderer.invoke("cloud-send:notice"),
    dismiss: signature => ipcRenderer.invoke("cloud-send:dismiss", String(signature)),
    moveRetry: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:move-retry") : Promise.reject(new Error("Choose Try again to move.")),
    // My Cloud's page: a bot of its moving into one of its person's teams.
    teams: () => ipcRenderer.invoke("cloud-send:teams"),
    moveToTeam: (botId, teamId, name) => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:team-move", String(botId), String(teamId), String(name ?? "")) : Promise.reject(new Error("Choose Move to move the bot.")),
    teamRetry: () => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:team-retry") : Promise.reject(new Error("Choose Try again to move.")),
    openTeam: teamId => ipcRenderer.invoke("cloud-send:team-open", String(teamId)),
    // A team's own page: its person's bots on My Cloud, and one moved in once they agree in main's own confirm.
    teamBring: () => ipcRenderer.invoke("cloud-send:team-bring"),
    teamBringMove: botId => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:team-bring-move", String(botId)) : Promise.reject(new Error("Choose Move to move the bot.")),
    teamBringStatus: () => ipcRenderer.invoke("cloud-send:team-bring-status"),
    // The offer to move this computer's bots to My Cloud: the sheet, the line at the top and Settings → Computer.
    moveOfferAccept: from => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:move-offer-accept", ["prompt", "banner", "settings"].includes(from) ? from : "settings")
      : Promise.reject(new Error("Choose Move to move your bots.")),
    moveOfferDismiss: which => ipcRenderer.invoke("cloud-send:move-offer-dismiss", which === "banner" ? "banner" : "prompt"),
    moveOpen: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-send:move-open") : Promise.reject(new Error("Choose Open dusk cloud to open it.")),
    // Settings → dusk cloud, Advanced: "Keep this computer's bots on this computer".
    keepHere: () => ipcRenderer.invoke("one-home:keep"),
    setKeepHere: on => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("one-home:keep-set", on === true) : Promise.reject(new Error("Turn the switch to keep this computer's bots here.")),
    onNotice: cb => {
      const handler = (_event, notice) => cb(notice);
      ipcRenderer.on("cloud-send:notice-changed", handler);
      return () => ipcRenderer.removeListener("cloud-send:notice-changed", handler);
    },
  } : undefined,
  // A VPS's own page: its bots straight to My Cloud. Main moves only the server whose page asks; this computer's page reads.
  vpsCloudMove: {
    view: () => ipcRenderer.invoke("vps-cloud-move:view"),
    start: () => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("vps-cloud-move:start") : Promise.reject(new Error("Choose Move to move your bots.")),
    buy: plan => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("vps-cloud-move:buy", plan === "pro" ? "pro" : "plus") : Promise.reject(new Error("Choose Get dusk cloud to continue.")),
    offer: () => ipcRenderer.invoke("vps-cloud-move:offer"),
    retry: () => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("vps-cloud-move:retry") : Promise.reject(new Error("Choose Try again to move.")),
    cancel: () => ipcRenderer.invoke("vps-cloud-move:cancel"),
    // the sign-in a purchase waits on, opened again: main opens it over this page and goes on to checkout after it
    signIn: () => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("vps-cloud-move:sign-in") : Promise.reject(new Error("Choose Sign in to continue.")),
    // whether the person asked for this server's move sheet (its menu on the rail, or the dashboard): true once, then false
    asked: () => ipcRenderer.invoke("vps-cloud-move:asked"),
    onShow: cb => {
      const handler = () => cb();
      ipcRenderer.on("vps-cloud-move:show", handler);
      return () => ipcRenderer.removeListener("vps-cloud-move:show", handler);
    },
    onChange: cb => {
      const handler = (_event, view) => cb(view);
      ipcRenderer.on("vps-cloud-move:changed", handler);
      return () => ipcRenderer.removeListener("vps-cloud-move:changed", handler);
    },
  },
  // This computer's page and My Cloud's once it is home: this app's own update (electron/app-update.mjs).
  appUpdate: {
    state: () => ipcRenderer.invoke("app-update:state"),
    restart: () => ipcRenderer.invoke("app-update:restart"),
    download: () => ipcRenderer.invoke("app-update:download"),
    seen: () => ipcRenderer.invoke("app-update:seen"),
    open: () => ipcRenderer.invoke("app-update:open"),
    move: () => ipcRenderer.invoke("app-update:move"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("app-update:changed", handler);
      return () => ipcRenderer.removeListener("app-update:changed", handler);
    },
  },
  // This computer's page only (never in REMOTE_SAFE, and main refuses any other): bots in two places, brought together on one.
  twoPlaces: {
    state: () => ipcRenderer.invoke("two-places:state"),
    accept: key => ipcRenderer.invoke("two-places:accept", String(key)),
    dismiss: key => ipcRenderer.invoke("two-places:dismiss", String(key)),
    onChanged: cb => {
      const handler = () => cb();
      ipcRenderer.on("two-places:changed", handler);
      return () => ipcRenderer.removeListener("two-places:changed", handler);
    },
  },
  // Every page: whether its server's identity is the one this app pinned for it. Main names the server from the page that
  // asks; only a public key crosses here.
  sealTrust: { check: identity => ipcRenderer.invoke("seal-trust:check", String(identity)) },
  // A linked server's page: Settings > Computer "Fast direct connection" for the link main finds from the page asking.
  linkDirect: {
    state: () => ipcRenderer.invoke("link-direct:state"),
    set: on => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("link-direct:set", on === true) : Promise.reject(new Error("Turn the switch to change the connection.")),
  },
  // This computer's page only (never in REMOTE_SAFE, and main refuses any other): Add your VPS, its AI sign-in, the move
  // there and back, and the backups made on the way. No secret ever comes through here.
  // Start fresh (the bot panel's reset): main checks the page and acts as this app's own sign-ins; the page sends only the typed words.
  startFresh: {
    available: () => ipcRenderer.invoke("start-fresh:available"),
    preview: () => ipcRenderer.invoke("start-fresh:preview"),
    run: typed => ipcRenderer.invoke("start-fresh:run", String(typed)),
    retry: () => ipcRenderer.invoke("start-fresh:retry"),
    finish: () => ipcRenderer.invoke("start-fresh:finish"),
    onChanged: cb => {
      const handler = (_event, view) => cb(view);
      ipcRenderer.on("start-fresh:changed", handler);
      return () => ipcRenderer.removeListener("start-fresh:changed", handler);
    },
  },
  cloudMac: {
    state: () => ipcRenderer.invoke("cloud-mac:state"),
    setEnabled: on => ipcRenderer.invoke("cloud-mac:setEnabled", on === true),
    setMode: mode => ipcRenderer.invoke("cloud-mac:setMode", String(mode)),
    setLimitFolders: on => ipcRenderer.invoke("cloud-mac:setLimitFolders", on === true),
    addFolder: () => ipcRenderer.invoke("cloud-mac:addFolder"),
    removeFolder: folder => ipcRenderer.invoke("cloud-mac:removeFolder", String(folder)),
    openLog: () => ipcRenderer.invoke("cloud-mac:openLog"),
    onChange: listener => {
      const handler = (_event, view) => listener(view);
      ipcRenderer.on("cloud-mac:changed", handler);
      return () => ipcRenderer.removeListener("cloud-mac:changed", handler);
    },
  },
  vpsLink: {
    state: () => ipcRenderer.invoke("vps-link:state"),
    start: () => ipcRenderer.invoke("vps-link:start"),
    cancel: () => ipcRenderer.invoke("vps-link:cancel"),
    reset: () => ipcRenderer.invoke("vps-link:reset"),
    engines: () => ipcRenderer.invoke("vps-link:engines"),
    signIn: id => ipcRenderer.invoke("vps-link:signIn", String(id)),
    signInStatus: (id, flowId) => ipcRenderer.invoke("vps-link:signInStatus", String(id), String(flowId)),
    signInCode: (id, flowId, code) => ipcRenderer.invoke("vps-link:signInCode", String(id), String(flowId), String(code)),
    signInCancel: (id, flowId) => ipcRenderer.invoke("vps-link:signInCancel", String(id), String(flowId)),
    openUrl: url => ipcRenderer.invoke("vps-link:openUrl", String(url)),
    preview: () => ipcRenderer.invoke("vps-link:preview"),
    move: () => ipcRenderer.invoke("vps-link:move"),
    retryMove: () => ipcRenderer.invoke("vps-link:retryMove"),
    open: () => ipcRenderer.invoke("vps-link:open"),
    where: () => ipcRenderer.invoke("vps-link:where"),
    backups: () => ipcRenderer.invoke("vps-link:backups"),
    backupNow: () => ipcRenderer.invoke("vps-link:backupNow"),
    restore: id => ipcRenderer.invoke("vps-link:restore", String(id)),
    moveBack: (placeId) => ipcRenderer.invoke("vps-link:moveBack", typeof placeId === "string" ? placeId : undefined),
    forget: () => ipcRenderer.invoke("vps-link:forget"),
    onChange: cb => {
      const handler = (_event, view) => cb(view);
      ipcRenderer.on("vps-link:changed", handler);
      return () => ipcRenderer.removeListener("vps-link:changed", handler);
    },
  },
  // Who is signed in on this device: this app's own pages only (main checks the sender). No token ever comes through here.
  accounts: process.argv.includes("--dusk-company-desktop=1") ? {
    list: () => ipcRenderer.invoke("accounts:list"),
    signOut: id => ipcRenderer.invoke("accounts:sign-out", String(id)),
    setAvatar: choice => ipcRenderer.invoke("accounts:set-avatar", choice === null ? null : String(choice)),
    addStart: email => ipcRenderer.invoke("accounts:add-start", String(email)),
    addVerify: code => ipcRenderer.invoke("accounts:add-verify", String(code)),
    addBrowser: () => ipcRenderer.invoke("accounts:add-browser"),
    addReopen: () => ipcRenderer.invoke("accounts:add-reopen"),
    addResult: () => ipcRenderer.invoke("accounts:add-result"),
    addCancel: () => ipcRenderer.invoke("accounts:add-cancel"),
    sheetPending: () => ipcRenderer.invoke("accounts:sheet-pending"),
    sheetClosed: () => ipcRenderer.invoke("accounts:sheet-closed"),
    onChanged: cb => {
      const handler = () => cb();
      ipcRenderer.on("accounts:changed", handler);
      return () => ipcRenderer.removeListener("accounts:changed", handler);
    },
    onOpenSheet: cb => {
      const handler = () => cb();
      ipcRenderer.on("accounts:open-sheet", handler);
      return () => ipcRenderer.removeListener("accounts:open-sheet", handler);
    },
  } : undefined,
  // Any place's page: opens the accounts sheet on the rail's page, from the person's click. The page learns nothing of them.
  accountSheet: process.argv.includes("--dusk-company-desktop=1") ? {
    offered: () => ipcRenderer.invoke("accounts:offered"),
    face: () => ipcRenderer.invoke("accounts:face"),
    open: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("accounts:open") : Promise.reject(new Error("Choose your account to open it.")),
  } : undefined,
  cloudPlan: process.argv.includes("--dusk-company-desktop=1") ? {
    state: () => ipcRenderer.invoke("cloud-plan:state"),
    manage: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:manage") : Promise.reject(new Error("Choose Manage to open your Plan page.")),
    signIn: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("home:sign-in") : Promise.reject(new Error("Choose Sign in to sign in again.")),
    noticeSeen: () => ipcRenderer.invoke("cloud-plan:notice-seen"),
    // a code that logs a phone in to the account; main checks the person is here first (renew: a silent swap of the code on screen)
    phoneSignIn: renew => ipcRenderer.invoke("cloud-plan:phone-sign-in", renew === true),
    openPage: (page, workspaceId) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:open-page", String(page), workspaceId === undefined ? undefined : String(workspaceId)) : Promise.reject(new Error("Choose the account dashboard to open it.")),
    // The usage meter's Upgrade: both only from the person's click (Upgrade, then the confirm's Upgrade), never by themselves.
    upgradePreview: (plan, source) => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:upgrade-preview", String(plan), String(source)) : Promise.reject(new Error("Choose Upgrade to see the price.")),
    upgrade: (plan, source) => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:upgrade", String(plan), String(source)) : Promise.reject(new Error("Choose Upgrade to change your plan.")),
    // Cancel trial / Cancel plan and Keep my plan: only from the person's click; the survey's words only, main names the Cloud.
    cancel: survey => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:cancel", survey ?? null) : Promise.reject(new Error("Choose Cancel to cancel your plan.")),
    keep: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:keep") : Promise.reject(new Error("Choose Keep my plan to keep it.")),
    // The room card's Not now, and Restart now after its upgrade: only from the person's click.
    roomNotNow: id => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:room-not-now", String(id)) : Promise.reject(new Error("Choose Not now.")),
    restartNow: () => navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:restart-now") : Promise.reject(new Error("Choose Restart now to restart the Cloud.")),
  } : undefined,
  organization: process.argv.includes("--dusk-company-desktop=1") ? {
    settingsOpened: () => ipcRenderer.invoke("organization:settings-opened"),
    state: () => ipcRenderer.invoke("organization:state"),
    begin: input => ipcRenderer.invoke("organization:begin", input),
    reopen: () => ipcRenderer.invoke("organization:reopen"),
    cancelEnrollment: () => ipcRenderer.invoke("organization:cancel"),
    refresh: () => ipcRenderer.invoke("organization:refresh"),
    disconnect: () => ipcRenderer.invoke("organization:disconnect"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("organization:state-changed", handler);
      return () => ipcRenderer.removeListener("organization:state-changed", handler);
    },
  } : undefined,
  companyBackups: process.argv.includes("--dusk-company-desktop=1") ? {
    state: () => ipcRenderer.invoke("company-backups:state"),
    list: () => ipcRenderer.invoke("company-backups:list"),
    create: input => ipcRenderer.invoke("company-backups:create", input),
    configureSchedule: input => ipcRenderer.invoke("company-backups:configure-schedule", input),
    prepareRestore: input => ipcRenderer.invoke("company-backups:preview", input),
    restore: input => ipcRenderer.invoke("company-backups:restore", input),
    delete: input => ipcRenderer.invoke("company-backups:delete", input),
    cancel: () => ipcRenderer.invoke("company-backups:cancel"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("company-backups:state-changed", handler);
      return () => ipcRenderer.removeListener("company-backups:state-changed", handler);
    },
  } : undefined,
  // lending this computer to a server is gone: a stub until pages of the last two releases stop calling it (bridge-contract.json).
  computerSharing: Object.fromEntries(["state", "chooseFolder", "save", "revoke", "activity"].map(name => [name, () => Promise.reject(new Error("Lending this computer is no longer available."))])),
  confirm: message => ipcRenderer.invoke("dialog:confirm", message),
  /** The OS's own check that a person is at this computer (Touch ID, Windows Hello, polkit), else an in-app confirm.
   * Resolves true only when they pass; never rejects for a failed check. */
  requireUserPresence: reason => ipcRenderer.invoke("presence:require", typeof reason === "string" ? reason : ""),
  /** The window onto My Cloud once it is the person's home: this computer's screen while My Cloud can't be opened, and
   * on My Cloud's own page a new session when its own has ended. */
  home: {
    state: () => ipcRenderer.invoke("home:state"),
    onState: cb => {
      const handler = (_event, view) => cb(view);
      ipcRenderer.on("home:state-changed", handler);
      return () => ipcRenderer.removeListener("home:state-changed", handler);
    },
    retry: () => ipcRenderer.invoke("home:retry"),
    remove: () => ipcRenderer.invoke("home:remove"),
    signIn: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("home:sign-in") : Promise.reject(new Error("Choose Sign in to sign in again.")),
    repair: () => ipcRenderer.invoke("home:repair"),
    wake: (intent, send) => ipcRenderer.invoke("home:wake", String(intent), send ?? null),
    lastSeen: () => ipcRenderer.invoke("home:last-seen"),
    ...(onHomePage ? { saveLastSeen: snapshot => ipcRenderer.invoke("home:last-seen-save", snapshot), takeHeld: () => ipcRenderer.invoke("home:held") } : {}),
    updating: onHomePage && reloadedForUpdate(),
  },
  /** This computer's page while the chosen server isn't answering (main refuses any other sender). */
  reconnect: isLocalPage ? {
    state: () => ipcRenderer.invoke("workspace-reconnect:state"),
    onState: cb => {
      const handler = (_event, view) => cb(view);
      ipcRenderer.on("workspace-reconnect:changed", handler);
      return () => ipcRenderer.removeListener("workspace-reconnect:changed", handler);
    },
    retry: () => ipcRenderer.invoke("workspace-reconnect:retry"),
    open: id => ipcRenderer.invoke("workspace-reconnect:open", String(id)),
    remove: () => ipcRenderer.invoke("workspace-reconnect:remove"),
  } : undefined,
  desktopProfile: {
    systemName: () => ipcRenderer.invoke("desktop-profile:system-name"),
    loginName: () => ipcRenderer.invoke("desktop-profile:login-name"),
  },
  desktopNotices: {
    state: () => ipcRenderer.invoke("desktop-notices:state"),
    seen: id => ipcRenderer.invoke("desktop-notices:seen", String(id)),
    // A Cloud or server page on 0.1.135 or older calls this as its Cloud Pro popup opens, and the whole page went blank
    // when it was missing. Nothing asks main any more: never the first showing today, so that page reports nothing.
    shown: () => Promise.resolve(false),
  },
  // A bot's notification, shown by main so its click outlives this page; older apps have no such key and the page shows its own.
  desktopNotifications: {
    show: (note) => ipcRenderer.invoke("desktop-notifications:show", note),
    asks: (report) => ipcRenderer.send("desktop-notifications:asks", {
      waiting: Array.isArray(report?.waiting) ? report.waiting.slice(0, 200).map(String) : [],
      settled: Array.isArray(report?.settled) ? report.settled.slice(0, 200).map(String) : [],
    }),
    onOpen: (cb) => {
      notificationOpenListeners.add(cb);
      if (pendingNotificationOpen) {
        const target = pendingNotificationOpen;
        pendingNotificationOpen = null;
        cb(target);
      }
      return () => notificationOpenListeners.delete(cb);
    },
  },
  // Usage counts only: main drops any event or prop outside its allowlist, adds the account token and posts.
  productEvents: {
    send: batch => ipcRenderer.invoke("product-events:send", batch),
    clear: () => ipcRenderer.invoke("product-events:clear"),
    last: batch => ipcRenderer.invoke("product-events:last", batch),
  },
  // An error's type, message, stack and page path only; main sends it while error reports are on.
  errorReports: {
    send: report => ipcRenderer.invoke("error-reports:send", report),
  },
  desktopAnalytics: {
    enabled: () => {
      if (analyticsChoice === undefined) analyticsChoice = savedAnalyticsChoice();
      return analyticsChoice;
    },
    ...(isLocalPage ? { set: enabled => { analyticsChoice = enabled === true; return ipcRenderer.invoke("desktop-analytics:set", analyticsChoice); } } : {}),
  },
  desktopLanguage: {
    choice: () => {
      if (languageChoice === undefined) languageChoice = savedLanguageChoice();
      return languageChoice;
    },
    set: language => {
      languageChoice = String(language);
      return ipcRenderer.invoke("desktop-language:set", languageChoice);
    },
    onChange: listener => {
      languageListeners.add(listener);
      return () => { languageListeners.delete(listener); };
    },
  },
};

contextBridge.exposeInMainWorld(
  "duskDesktop",
  isLocalPage ? bridge : Object.fromEntries(Object.entries(bridge).filter(([key]) => remoteKeys.has(key))),
);
