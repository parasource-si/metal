import { carryLegacySafeStorageKey, DATA_DIR_NAMES, dataDirFor, devAppName, fromLegacyLink, hasDesktopUserData, LEGACY } from "./legacy-names.mjs";
import { app, BrowserWindow, Tray, WebContentsView, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification as ElectronNotification, powerMonitor, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, utilityProcess, nativeTheme } from "electron";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildErrorPage, desktopViewerErrorPage, RENDERER_CRASHES, serverPageAction, serverProblemReportUrl, windowCrashedPage } from "./error-pages.mjs";
import { loadWithOneRetry, offerRestart } from "./recovery-prompts.mjs";
import { pickServerPort, strandedServerOn } from "./server-port.mjs";
import { startCua, stopCua, registerCuaIpc, setCuaStateListener, grantLocalComputer } from "./cua.mjs";
import { finishSpeech, speechBusy, startSpeech, stopSpeech } from "./speech.mjs";
import { installTalk, isTalkPanel } from "./talk-main.mjs";
import { installVoiceInput } from "./voice-input-main.mjs";
import { installAmbient, isAmbientWindow } from "./ambient-main.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { linuxDisablesGpu } from "./linux-gpu.mjs";
import { pasteMenuItem } from "./paste-menu-item.mjs";
import {
  appendDesktopCrashRecord,
  buildDiagnosticsReport,
  diagnosticsFileName,
  formatDesktopCrashRecord,
  installDesktopCrashListeners,
  readSafeLogTail,
} from "./diagnostics.mjs";
import { workspaceCredentialEnv } from "./workspace-credentials.mjs";
import { evictStartupCacheOnce } from "./startup-cache-eviction.mjs";
import { activateExistingWindow, bringToFront, windowToReveal } from "./single-instance.mjs";
import { createWindowPlacement } from "./window-placement.mjs";
import { bootFailureMessage, listeningSignal, pollServerIdentity, SERVER_BOOT_TIMEOUT_MS, SERVER_LISTENING_GRACE_MS, SERVER_STARTING_GRACE_MS } from "./server-boot-probe.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";
import { createBrowsersFlush, installSessionEndFlush } from "./browser-flush.mjs";
import { serverChildLaunch } from "./server-child-launch.mjs";
import { savedVpsStartupTarget, startPackagedAlongsideVps, waitForLocalStartup } from "./saved-vps-startup.mjs";
import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import { chatLinkFrom, chatLinkFromCommandLine } from "./chat-link.mjs"; import { createSlackOAuthLinks } from "./slack-link.mjs"; import { installDesktopNotifications } from "./desktop-notifications.mjs"; import { systemNotification, systemNotificationsAllowed } from "./system-notifications.mjs";
const Notification = systemNotification(ElectronNotification);
import { createOrganizationEntry, isOrganizationDeepLink, takeOrganizationDeepLink, organizationRestartIntent, withOrganizationRestartIntent, withoutOrganizationRestartIntent } from "./organization-entry.mjs";
import { FRAME_BY_DEFAULT, widenedBounds, windowBackground, windowChromeOptions } from "./window-chrome.mjs";
import { createAllWindowsClosedQuit } from "./window-all-closed.mjs";
import { createStartupScreen, expectedLoadMs, rememberLoad, startupDark } from "./startup-screen.mjs";
import { createStartupTrace } from "./startup-trace.mjs";
import { createDevServerChild, devOwnServerWanted, devServerConflictMessage, watchServerSource } from "./dev-server-child.mjs";
import { createSystemTray } from "./system-tray.mjs";
let startupScreen = null;
const startupTrace = createStartupTrace({ log: line => slog(line), onMark: name => startupScreen?.progress(name) });
let desktopTray = null;
import { collisionFreeDownloadPath, defaultSaveName, openHtmlCopy, openLogsFolder, revealDownloadWhenDone, revealInFolder, withSavableFile } from "./save-file.mjs";
import { desktopViewerPermissionAllowed } from "./desktop-viewer-permissions.mjs";
import { appPermissionHandlers, externalLinkUrl } from "./app-permissions.mjs";
import { appFrameNavigationAllowed } from "./app-frame-guard.mjs";
import { writeClipboardText } from "./clipboard-write.mjs";
import {
  devDesktopUsesManagedApps,
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioBrokerUrl,
  managedComposioChildEnvironment,
} from "./managed-composio.mjs";
import {
  createManagedCompanionTunnel,
  managedCompanionTunnelAccess,
  resolveCloudflaredBinary,
  resolveManagedCompanionGuardian,
} from "./managed-companion-tunnel.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import {
  createPhoneSecretSaveCoordinator,
  createPhoneSecretIdentity,
  decodePhoneSecretSaveRequest,
  phoneSecretPrivateKeyMessage,
  readPhoneSecretIdentity,
  withPhoneSecretIdentity,
} from "./phone-secret-identity.mjs";
import { ensureSavedSecretsKey, savedSecretsKeyMessage } from "./saved-secrets-key.mjs";
import {
  desktopCompanionAccess,
  desktopCompanionRendererArguments,
  pairDesktopCompanion,
  startDesktopCompanionRelay,
  withDesktopCompanionAccess,
  withoutDesktopCompanionAccess,
} from "./desktop-companion-client.mjs";
import { isKnownSkin, skinChrome, skinIsLight } from "./skin-overlay.cjs";
import { createCredentialFile, secureComposioConfig, secureWorkspaceConfig } from "./secure-credentials.mjs";
import { createControlPlaneClient } from "./control-plane-client.mjs";
import {
  companionAccountCleanupPending,
  createCompanionAccountService,
  managedEndpointNeed,
  resolveCompanionControlPlaneURL,
} from "./companion-account-service.mjs";
import capabilitiesModule from "./capabilities.cjs";
import environmentsModule from "./environments.cjs";
import localOriginModule from "./local-origin.cjs";
import { aboutPanelOptions, buildApplicationMenu } from "./menu.mjs"; import { installDesktopBots } from "./desktop-bots.mjs"; import { installReloadKeys } from "./reload-keys.mjs"; import { startDesktopErrorReporting } from "./desktop-errors.mjs"; import { createUpdateNotice, METAL_RELEASES_URL } from "./update-notice.mjs"; import { justUpdated } from "./app-update.mjs"; import { createAppImageMenuEntry, installAppImageMenuEntry } from "./appimage-menu-entry.mjs"; import { createDemoUpdater, demoUpdateFlag } from "./app-update-demo.mjs";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { offerMoveToApplications } from "./move-to-applications.mjs";
import { switchLocalEnvironment } from "./environment-switch.mjs";
import { createManagedDesktopClient, createManagedDesktopRelay, createManagedDesktopStore } from "./managed-desktop.mjs";
import { analyticsAllowed, createProductEvents } from "./product-events.mjs"; import { crashProps, createExperienceRelay } from "./experience-relay.mjs"; import { UTILITY_NAMES } from "./utility-names.mjs"; import { createUsageNotes } from "./usage-notes.mjs";
import { createAccountErrors } from "./account-errors.mjs";
import { CHECKOUT_SOURCES, cloudMenuSublabel, cloudTarget, createCloudAccountClient, createCloudAccountStore } from "./cloud-account.mjs"; import { isAppLink } from "./cloud-signin.mjs";
import { ACCOUNT_PAGES, installCloudPlanIpc } from "./cloud-plan-ipc.mjs";
import { cloudLinkOpensSheet, colorDotIcons, createCloudLook, placeKindIcons, createCloudReadyNotice, installCloudBuy, lookFile } from "./cloud-buy.mjs";
import { createAccountEnroll } from "./account-enroll.mjs"; import { cloudMoveLinkWorkspace, createServerEnroll } from "./server-enroll.mjs"; import { accountGateRequired, installAccountGate } from "./account-gate.mjs"; import { carryWelcomeToCloud } from "./cloud-welcome-carry.mjs"; import { carriedEngines, localAiSignIns } from "./ai-signins-carry.mjs"; import { holdUntilPainted, PAINTED_SCRIPT } from "./paint-hold.mjs";
import { createTrialNotices } from "./cloud-trial-notice.mjs";
import { createDesktopPrefs, DESKTOP_PORTS, jsonFile, registerDesktopPrefs } from "./desktop-prefs.mjs";
import { installMacPermissions } from "./mac-permissions.mjs";
import { createDesktopIncludedX } from "./included-x.mjs"; import { createDesktopIncludedPages } from "./included-pages.mjs";
import { createLastSeenStore } from "./cloud-last-seen.mjs";
import { createCloudFocus } from "./cloud-focus.mjs";
import { cloudPageSenderAllowed, cloudPlanDisk, createCloudPowerGate, isCloudHomeEntry, myCloudOrigin, rememberedCloudHome, signInCloudSession, withCloudHome } from "./cloud-home.mjs"; import { installCloudMac } from "./cloud-mac-main.mjs";
import { installCloudFiles } from "./cloud-sync-main.mjs";
import { createCloudEntry } from "./cloud-entry.mjs";
import { createOpenAtLogin, installOpenAtLogin } from "./open-at-login.mjs";
import { createCleanWorkspace } from "./clean-workspace.mjs"; import { installOneHome } from "./one-home-main.mjs"; import { handSaved, installOwnHome } from "./own-home-main.mjs"; import { installVpsCloudMoveMain } from "./vps-cloud-move-main.mjs"; import { oneHomeCloud } from "./one-home-main.mjs"; import { newServerReach, serverOpens } from "./saved-server.mjs"; import { installTwoPlacesMain } from "./two-places-main.mjs"; import { installConnectorSyncMain } from "./connector-sync-main.mjs"; import { installSettingsSyncMain } from "./settings-sync-main.mjs"; import { installVpsLink, unlimitTunnelConnections } from "./vps-link-main.mjs"; import { installSealTrust } from "./seal-trust.mjs";
import { askForMicrophone, openPrivacySettings } from "./privacy-settings.mjs"; import { installUserPresence } from "./user-presence.mjs";
import { createHomeWindow, HOME_SCREEN_PATH, installHomeWindowIpc, WELCOMED_ROUTE } from "./home-window.mjs";
import { localPageStep, settledActive } from "./workspace-choice.mjs"; import { createWorkspaceReconnect, installWorkspaceReconnectIpc, proxyAnswersForDownServer, RECONNECT_PATH } from "./workspace-reconnect.mjs";
import { createTeamProfileSeeds } from "./team-profile-seed.mjs";
import { createWorkspaceSwitch, installWorkspaceSwitchIpc } from "./workspace-switch.mjs";
import { createHomePlaces } from "./home-places.mjs"; import { createDesktopRing, installAccounts } from "./accounts-main.mjs"; import { createAddedCloudNotice, installCloudRail, railPlaces } from "./cloud-rail.mjs"; import { createPlaceInboxWatch } from "./place-inbox-watch.mjs"; import { homeLook, otherOwnClouds, withoutOldCloudHome } from "./cloud-list.mjs"; import { installPlaceLook } from "./place-look.mjs"; import { CHROME_RAIL_PATH, createChromeRail } from "./chrome-rail.mjs";
import { createWindowStateFile } from "./window-state-file.mjs";
import { bundleSource, createLocalUi, devSource, originOf, servedOrigins } from "./local-ui.mjs";
import { accountSetupStore, localAccountSetupStore, remoteAccountSetupStore } from "./account-setup-store.mjs"; import { CLOUD_HOME_ID, installBotsElsewhere, placesChosenStore, placesElsewhere, readBotCounts } from "./bots-elsewhere.mjs";
import { createEnvironmentsFile } from "./environments-file.mjs";
import { createOrgLibrary } from "./org-library.mjs";
import { createCompanyBackups } from "./company-backups.mjs";
import { createCompanyBackupSchedule } from "./company-backup-schedule.mjs";
import { installServerSessions, reportOwnListeners } from "./server-session.mjs";

const { desktopCapabilities, nativeDesktopActions } = capabilitiesModule;
const nativeActions = nativeDesktopActions(process.platform);
const require = createRequire(import.meta.url);
const { createDisplayMediaGuard, invokeDisplayMediaCallback, selectCaptureSource } = require(
  "./screen-preview.cjs",
);
const { STAGE_PREFIX: APPIMAGE_CUA_STAGE_PREFIX } = require("./cua-linux-bundle.cjs");
const { desktopViewerUrl, sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");
const { createDesktopWorkspaceManager } = require("./desktop-workspace.cjs");
const { createTrustedApprovalModeCoordinator } = require("./approval-trusted-mode.cjs");
const { DESKTOP_MUTATION_HEADER, desktopServerHeaders } = require("./desktop-server-auth.cjs");
const { MIN_BOUNDS, normalizeUnreadCount, resolveWindowState } = require("./window-state.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// vite binds IPv4; a bare "localhost" can resolve to ::1.
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
/** Origins the window was sent to besides the saved places (a team's Cloud, a Cloud being connected). */
const visitedPlaces = new Set();
// DUSK_REMOTE_UI=server: every place shows its server's own page again
const localUi = process.env.DUSK_REMOTE_UI === "server" ? null : createLocalUi({
  source: app.isPackaged ? bundleSource(path.join(process.resourcesPath, "ui")) : devSource(DEV_URL),
  origins: () => {
    let place = [], saved = [];
    // module-level state below this line is not initialised until main has run once
    try {
      if (desktopRemoteAccess) return [];
      saved = environmentsState.environments.filter((entry) => entry.kind !== "local").map((entry) => entry.origin);
      place = [homeWindow.cloudOrigin(), homeWindow.placeOrigin(), myCloud()];
    } catch {}
    return servedOrigins([...saved, ...place, ...visitedPlaces], [DEV_URL, rendererOrigin(), `http://127.0.0.1:${SERVER_PORT}`, `http://localhost:${SERVER_PORT}`]);
  },
  log: (line) => slog(line),
});
let devServer = null;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");
let desktopViewerWindow = null;
let desktopViewerOwner = null;
let desktopViewerContextId = null;
let desktopWorkspaceManager = null;
let desktopWorkspaceOwner = null;
// a link with the old scheme opens like a new one
process.argv.splice(0, process.argv.length, ...process.argv.map(fromLegacyLink));
let pendingOrganizationEntry = takeOrganizationDeepLink(process.argv);
function appWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !isTalkPanel(win) && !isAmbientWindow(win));
}
const cloudEntry = createCloudEntry({
  reveal: () => { if (!desktopTray?.show()) activateExistingWindow(appWindows()); },
  open: async () => {
    let delivered = false;
    await workspaceMenuAction(async () => { delivered = await openCloudEntry(); });
    return delivered;
  },
});
cloudEntry.fromLaunch(process.argv);
let pendingPackageInstallUrl = pendingOrganizationEntry ? null : packageUrlFromCommandLine(process.argv);
let pendingChatLink = pendingOrganizationEntry ? null : chatLinkFromCommandLine(process.argv); const slackOAuthLinks = createSlackOAuthLinks({ reveal: () => revealForLink(), send: (link) => { const win = mainWindow; if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return false; win.webContents.send("slack:oauth", link); return true; } }); if (!pendingOrganizationEntry) slackOAuthLinks.fromCommandLine(process.argv);
let organizationEntryReady = false;
let mainWindow = null;
const serverUnavailableWindows = new WeakSet();
let unreadCount = 0;
let unreadOverlayIcon = null;

const windowStateFile = createWindowStateFile({ file: () => path.join(app.getPath("userData"), "window-state.json"), log: message => slog(message) });

function applyUnreadBadge(win = mainWindow) {
  const count = normalizeUnreadCount(unreadCount);
  if (process.platform === "win32") {
    if (!win || win.isDestroyed()) return;
    unreadOverlayIcon ??= nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
    win.setOverlayIcon(
      count > 0 && !unreadOverlayIcon.isEmpty() ? unreadOverlayIcon : null,
      count > 0 ? `${count} unread conversation${count === 1 ? "" : "s"}` : "No unread conversations",
    );
    return;
  }
  if (process.platform === "darwin" || process.platform === "linux") app.setBadgeCount(count);
}

// GNOME groups the window with its desktop entry only when both identities match; set before ready.
if (process.platform === "linux") {
  if (linuxDisablesGpu()) app.disableHardwareAcceleration();
  app.setDesktopName("bot.dusk.app.desktop");
}

unlimitTunnelConnections(app);

const isolatedUserData = app.commandLine.hasSwitch("user-data-dir");
const defaultUserData = app.getPath("userData");
const legacyNames = app.isPackaged
  ? [process.platform === "linux" ? "dusk-bot" : "Dusk Bot", "duskbot"]
  : ["duskbot"];
const legacyUserData = !isolatedUserData && !hasDesktopUserData(defaultUserData)
  && legacyNames.map(name => path.join(app.getPath("appData"), name)).find(dir => hasDesktopUserData(dir));
const devOnMac = !app.isPackaged && process.platform === "darwin";
app.setName(devOnMac ? devAppName("Metal") : "Metal");
const userData = legacyUserData || defaultUserData;
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);

// Electron names the macOS Safe Storage key after app.name.
if (process.platform === "darwin" && legacyUserData && !app.commandLine.hasSwitch("use-mock-keychain")) {
  const from = devOnMac ? ["duskbot dev", "duskbot", LEGACY.devName, LEGACY.product] : ["duskbot", "Dusk Bot", LEGACY.product];
  const carried = carryLegacySafeStorageKey({ name: app.getName(), packaged: app.isPackaged, from, trust: process.execPath });
  if (carried !== "present") console.log(`[desktop] keychain key: ${carried}`);
}

if (!app.requestSingleInstanceLock()) {
  console.log("[desktop] Metal is already running: focusing that window");
  process.exit(0);
}

// Start fresh (the bot panel's reset): before anything reads this computer's data or the app's own files, they go, and the
// window's storage is cleared once electron is ready (startedFresh), so the app opens as a brand-new install
const startedFresh = applyPendingDesktopStartFresh({ userData: app.getPath("userData"), dataDir: dataDirFor(process.env.DUSK_DATA_DIR, app.getPath("home")), log: line => console.log(`[desktop] ${line}`) });

/** To this computer's page, or to My Cloud's once it is home. While the window shows another place, the person is
 * asked first and the window moves only on their yes; Not now drops what was waiting (`drop`). */
function sendToPage(win, channel, value, drop = () => {}) {
  if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return false;
  let shown = null, page = null;
  try { const at = new URL(win.webContents.getURL()); shown = at.origin; page = at.pathname; } catch {}
  const home = homeWindow.cloudOrigin();
  if (home ? shown !== home : shown !== rendererOrigin() || page === RECONNECT_PATH || page === HOME_SCREEN_PATH) {
    askToOpenLinkHome(win, home, drop);
    return false;
  }
  win.webContents.send(channel, value);
  return true;
}

let linkHomeAsk = null;
function askToOpenLinkHome(win, home, drop) {
  const active = activeEnvironment(environmentsState);
  // the link's workspace is the chosen one already, only not on screen yet
  if (home ? active?.origin === home : !activeRemote(environmentsState)) { if (home) void showHome({ place: "cloud" }); return; }
  if (linkHomeAsk) return;
  const name = home ? "my cloud" : "this computer";
  linkHomeAsk = dialog.showMessageBox(win, { type: "question", buttons: [`Open ${name}`, "Not now"], defaultId: 0, cancelId: 1, noLink: true,
    message: `Open this link on ${name}?`, detail: `The window shows ${active?.name ?? "another server"} now; it stays there unless you choose Open ${name}.` })
    .then(({ response }) => {
      if (response === 0) return workspaceMenuAction(() => (home ? showHome({ place: "cloud" }) : switchEnvironment(LOCAL_ID)));
      drop();
    })
    .catch(() => {})
    .finally(() => { linkHomeAsk = null; });
}

function deliverPackageInstall(win = mainWindow) {
  if (pendingPackageInstallUrl && sendToPage(win, "package:install", pendingPackageInstallUrl, () => { pendingPackageInstallUrl = null; })) pendingPackageInstallUrl = null;
}

function deliverChatLink(win = mainWindow) {
  if (pendingChatLink && sendToPage(win, "chat:open", pendingChatLink, () => { pendingChatLink = null; })) pendingChatLink = null;
}

let openWindowForLink = null;

// app windows stay whole on a display the person can see (window-placement.mjs)
const windowPlacement = createWindowPlacement({ screen, windows: () => appWindows(), log: message => slog(message) });

/** A Dock click, a second launch or a link: the window in front, restored, unhidden, on screen and on this Space, even
 * while only the island or the dock is up. macOS open-url does not fire activate, so a link that finds none opens one. */
function revealForLink() {
  if (desktopTray?.show()) return;
  const target = windowToReveal({ splash: startupScreen?.window ?? null, main: mainWindow, others: appWindows() });
  if (bringToFront(target, { app, fit: win => windowPlacement.fit(win) })) return;
  openWindowForLink?.();
}

function queuePackageInstall(rawLink) {
  const packageUrl = packageUrlFromDeepLink(rawLink);
  if (!packageUrl) return false;
  pendingPackageInstallUrl = packageUrl;
  revealForLink();
  deliverPackageInstall();
  return true;
}

/** duskbot://auth: the browser back from a Google or Apple sign-in this app started; the client ignores any other. */
function takeSignInLink(rawLink) {
  if (!isAppLink(rawLink)) return false;
  revealForLink();
  try { void ensureCloudAccount().finishLink(rawLink).catch(() => {}); } catch {}
  return true;
}

function queueChatLink(rawLink) {
  const link = chatLinkFrom(rawLink);
  if (!link) return false;
  pendingChatLink = link;
  revealForLink();
  deliverChatLink();
  return true;
}

/** A server's move to dusk cloud, asked for on its rail menu or the dashboard: its page opens with the move sheet. */
async function askServerCloudMove(id) {
  if (!vpsCloudMove) throw new Error("Moving a server to dusk cloud isn't available here.");
  vpsCloudMove.ask(id);
  if (environmentsState.activeId === id && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) { mainWindow.webContents.send("vps-cloud-move:show"); return true; }
  await workspaceMenuAction(() => switchEnvironment(id));
  return true;
}

/** duskbot://cloud-move/<workspace>: the dashboard's move for a server this app linked there; any other only brings the app forward. */
function takeCloudMoveLink(rawLink) {
  const workspace = cloudMoveLinkWorkspace(rawLink);
  if (!workspace) return false;
  revealForLink();
  const id = serverEnroll?.placeFor(workspace);
  if (id) void askServerCloudMove(id).catch(error => slog(`cloud move link: ${error?.message ?? error}`));
  return true;
}

/** The website sent the person back (its onboarding's last step, or after paying): counted, and the account read again so
 * what they set there (their name, a plan) shows here now rather than at the next refresh. */
function cameBack(link) {
  try { productEvents.action("account_sign_in", { step: "back", link }); } catch {}
  try { if (accountApp() && cloudAccount?.state().status === "connected") void cloudAccount.refresh().catch(() => {}); } catch {}
  return true;
}

/** duskbot://open (the website after the person approved this app, or signed in): only the app in front, where it was */
function takeOpenLink(rawLink) {
  if (typeof rawLink !== "string" || !/^duskbot:\/\/open\/?$/i.test(rawLink)) return false;
  revealForLink();
  return cameBack("open");
}

app.on("open-url", (event, rawUrl) => {
  const url = fromLegacyLink(rawUrl);
  if (!takeSignInLink(url) && !takeOpenLink(url) && !takeCloudMoveLink(url) && !queueOrganizationEntry(url) && !(cloudEntry.fromUrl(url) && cameBack("cloud")) && !queuePackageInstall(url) && !queueChatLink(url) && !slackOAuthLinks.queue(url)) return;
  event.preventDefault();
});

app.on("second-instance", (_event, rawCommandLine) => {
  const commandLine = rawCommandLine.map(fromLegacyLink);
  if (takeSignInLink(commandLine.find(isAppLink))) return;
  if (takeOpenLink(commandLine.find(arg => /^duskbot:\/\/open\/?$/i.test(arg)))) return;
  if (takeCloudMoveLink(commandLine.find(arg => cloudMoveLinkWorkspace(arg)))) return;
  if (takeOrganizationDeepLink(commandLine)) {
    queueOrganizationEntry("duskbot://organization");
    return;
  }
  if (cloudEntry.fromArgs(commandLine)) { cameBack("cloud"); return; }
  if (slackOAuthLinks.fromCommandLine(commandLine)) return; const packageUrl = packageUrlFromCommandLine(commandLine);
  if (packageUrl) pendingPackageInstallUrl = packageUrl;
  const chatLink = chatLinkFromCommandLine(commandLine);
  if (chatLink) pendingChatLink = chatLink;
  revealForLink();
  deliverPackageInstall();
  deliverChatLink();
});

let serverProc = null;
// install-line servers joining the account dashboard (server-enroll.mjs), made once the server links are
let serverEnroll = null;
let serverReady = !app.isPackaged;
let localRuntimeStarting = null;
let earlyVpsOpened = null;
let secureCredentials = {};
let secureCredentialState = null;
let desktopDataDirLease = null;
// The folder this process leases; environmentsState.activeId can name a remote server instead.
let runningDataDir = null;
/** The folder `pnpm dev:app`'s own harness child runs on (it holds its own lease). */
let devDataDir = null;
let localSwitchInFlight = false;
let managedDesktop = null;
let cloudAccount = null, desktopPrefs = null, ownHome = null, twoPlaces = null, windowFrameMade = null;
let cloudAccountStarted = Promise.resolve();
let cloudAccountRestoring = false;
function cloudAccountRestored() {
  return Promise.race([cloudAccountStarted, new Promise(resolve => setTimeout(resolve, 5_000).unref?.())]);
}
let orgLibrary = null;
let companyBackupController = null;
let companyBackupState = { busy: false };
let preparedCompanyRestore = null;
let companyBackupSchedule = null;
let companyBackupClientStateRequest = null;
let companyRestoreCommitting = false;
let companyBackupConfigurationRevision = 0;
const managedDesktopRelay = createManagedDesktopRelay();
const includedX = createDesktopIncludedX({ account: () => cloudAccount, server: () => serverProc, log: slog }), includedPages = createDesktopIncludedPages({ account: () => cloudAccount, server: () => serverProc, log: slog });
const cloudPower = createCloudPowerGate({ power: () => cloudAccount?.power() ?? null, wanted: () => Boolean(cloudSync?.running()) });
const utilityServerExits = new WeakMap();
const UTILITY_SERVER_STOP_TIMEOUT_MS = 6_500;
const UTILITY_SERVER_BOOT_STOP_TIMEOUT_MS = 30_000;
const trustedApprovalMode = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
const desktopMutationToken = randomBytes(32).toString("base64url");
const desktopLaunchId = randomUUID();
const companionMutationToken = randomBytes(32).toString("base64url");
const browsersFlush = createBrowsersFlush({ server: () => serverProc, randomId: randomUUID });
const serverSupervisor = createServerSupervisor({
  restart: () => startServerOn(SERVER_PORT),
  stop: stopUtilityServer,
  onReady(proc) {
    serverProc = proc;
    serverReady = true;
    setLocalOrigin(confirmedRendererOrigin());
    slog(`server ready pid=${proc.pid} port=${SERVER_PORT}`);
    syncUsageSignals();
    syncManagedComposioCredentials(); includedX.serverStarted(); includedPages.serverStarted(); railChanged(); ambientSurfaces.refresh();
    reportOwnListeners(proc);
    orgLibrary?.runtimeReady();
    if (managedDesktop) void managedDesktop.refresh().catch(() => {});
    routineWake.start();
    for (const win of appWindows()) {
      if (!serverUnavailableWindows.has(win) || activeRemote(environmentsState)) continue;
      void win.loadURL(`http://127.0.0.1:${SERVER_PORT}`).then(() => {
        serverUnavailableWindows.delete(win);
      }).catch((error) => {
        slog(`recovered server window failed to load: ${error?.message ?? error}`);
      });
    }
  },
  onCrash() { const props = crashProps("server", "crashed", { ending: appEnding() }); if (props) productEvents.action("crash", props); },
  onUnavailable() {
    serverReady = false;
    serverProc = null;
    setLocalOrigin(confirmedRendererOrigin());
    companyBackupSchedule?.reconcile();
    routineWake.stop();
  },
  onExhausted() {
    slog("server recovery paused after repeated failures; quit and reopen to retry");
    if (earlyVpsOpened && activeRemote(environmentsState)?.id === earlyVpsOpened && mainWindow && !mainWindow.isDestroyed()) return;
    serverFailure = "crashed";
    if (app.isPackaged && !desktopRemoteAccess && showsLocalPage(mainWindow)) return void serverFailurePage(mainWindow);
    void offerRestart({ dialog, app });
  },
  log: slog,
});

function desktopDataDir() {
  // An empty DUSK_DATA_DIR falls back here too; server/config.ts would not, so the child gets this path.
  return dataDirFor(process.env.DUSK_DATA_DIR, app.getPath("home"), { log: line => slog(line) });
}

async function stopUtilityServer(proc, timeoutMs = UTILITY_SERVER_STOP_TIMEOUT_MS) {
  if (!proc) return true;
  const exited = utilityServerExits.get(proc);
  if (!exited) return false;
  try {
    proc.kill();
  } catch {
  }
  let timer;
  return Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
let phoneSecretIdentity = null;
let savedSecretsKey = null;
let desktopRemoteAccess = null;
let desktopCompanionRelay = null;

const CREDENTIALS_FILE = path.join(app.getPath("userData"), "credentials.bin");

const credentialFile = createCredentialFile({ file: CREDENTIALS_FILE, safeStorage, log: (line) => slog(line) });
const saveSecureCredentials = (credentials) => credentialFile.save(credentials);

function composioBrokerUrl() {
  return managedComposioBrokerUrl(process.env.DUSK_COMPOSIO_BROKER_URL, devDesktopUsesManagedApps());
}

// Finder/Explorer launches have no usable stdio, so the server child's output goes to server.log here.
const LOG_DIR = !app.isPackaged && process.env.DUSK_LOG_DIR ? process.env.DUSK_LOG_DIR : app.getPath("logs");
// the debug trail (trail.mjs): main and the renderer write trail.jsonl, the server child its own file beside it
const TRAIL_CAP = app.isPackaged ? TRAIL_CAP_BYTES.packaged : TRAIL_CAP_BYTES.dev;
process.env.DUSK_TRAIL_DIR = LOG_DIR;
process.env.DUSK_TRAIL_CAP = String(Math.floor(TRAIL_CAP / 2));
const trailWriter = configureTrail({ src: "main", writer: createTrailWriter({ dir: LOG_DIR, prefix: "trail", capBytes: Math.floor(TRAIL_CAP / 2) }) });
trail("app.start", { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform });
const DESKTOP_CRASH_LOG = path.join(LOG_DIR, "desktop-crashes.log");
const DESKTOP_CRASH_LOG_MAX_BYTES = 512 * 1024;
let logStream = null;
let desktopShutdownStarted = false;
const appEnding = () => desktopShutdownStarted || windowsSessionEnding;
import {
  companionAdvertisedHostedUrl,
  companionEnabledAtRest,
  companionOriginTarget,
  companionPairing,
  companionRefreshTailscale,
  companionCloudDesktopAccess,
  companionBrowserControlAccess,
  companionRevoke,
  companionRunning,
  companionState,
  rememberCompanionEnabled,
  rememberCompanionKeepAwake,
  setCompanionHostedUrl,
  setCompanionLifecycleListener,
  startCompanion,
  stopCompanion,
} from "./companion.mjs";
import { autoStartCompanion } from "./companion-autostart.mjs";
import { createRoutineWakeHold, rememberRoutineWake, routineWakeSettings } from "./routine-wake.mjs";
import { CREDENTIAL_PATCH, credentialSaveError } from "./credential-patch.mjs";
import { createCappedLog } from "./capped-log.mjs";
import { TRAIL_CAP_BYTES, configureTrail, createTrailWriter, trail } from "./trail.mjs";
import { installTrailMain } from "./trail-main.mjs";
import { applyPendingDesktopStartFresh, createStartFresh, markDesktopStartFresh } from "./start-fresh.mjs";
import { createLoopbackRelay } from "./auth-loopback-relay.mjs";

/** Second wall after preload's reduced bridge: computer-controlling IPC answers only the local server's UI.
 * Declared before any handler registration (temporal dead zone). */
const { isLocalSender: senderIsLocal, localOnly, localOnlySync, setLocalOrigin } = localOriginModule;
/** This computer's page, or My Cloud's own page once it is home (home-window.mjs). */
const localOrHome = (channel, handler) => (event, ...args) => (homeWindow.homePage(event) ? handler : localOnly(channel, handler))(event, ...args);
// only the installed app reports usage; dev, worktree, CI and smoke runs (DUSK_ANALYTICS=0) send nothing
// an unpackaged run that opted in (the dev app against preview) says so in its version, so the admin can tell it apart
const productEvents = createProductEvents({ origin: cloudTarget(process.env).origin, token: () => cloudAccount?.eventToken?.() ?? null, platform: process.platform, version: app.isPackaged ? app.getVersion() : `${app.getVersion()}+dev`,
  enabled: analyticsAllowed({ packaged: app.isPackaged, env: process.env, custom: cloudTarget(process.env).custom }) });
for (const [kind, emitter] of [["page", "render-process-gone"], ["child", "child-process-gone"]]) {
  app.on(emitter, (...args) => { const details = args.at(-1); const props = crashProps(kind === "page" ? "page" : details?.type, details?.reason, { name: details?.name, ending: appEnding() }); if (props) productEvents.action("crash", props); });
}
ipcMain.handle("product-events:send", localOrHome("product-events:send", (_event, batch) => productEvents.send(batch)));
ipcMain.handle("product-events:clear", localOrHome("product-events:clear", () => productEvents.clear()));
ipcMain.handle("product-events:last", localOrHome("product-events:last", (_event, batch) => productEvents.last(batch)));
const accountErrors = createAccountErrors({ origin: cloudTarget(process.env).origin, platform: process.platform, release: process.getSystemVersion?.(), version: app.getVersion(),
  enabled: () => app.isPackaged && process.env.DUSK_ERROR_REPORTS !== "0" && (desktopPrefs?.errorReports() ?? false) });
accountErrors.watch(app);
ipcMain.handle("error-reports:send", localOrHome("error-reports:send", (_event, report) => accountErrors.send(report)));

let companionPowerBlocker = null;

function syncCompanionKeepAwake(companionEnabled, keepAwake) {
  const shouldBlock = companionEnabled && keepAwake;
  if (shouldBlock && companionPowerBlocker === null) {
    companionPowerBlocker = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && companionPowerBlocker !== null) {
    if (powerSaveBlocker.isStarted(companionPowerBlocker)) powerSaveBlocker.stop(companionPowerBlocker);
    companionPowerBlocker = null;
  }
}

const routineWake = createRoutineWakeHold({
  fetchStatus: () => (serverReady
    ? fetch(`http://127.0.0.1:${SERVER_PORT}/api/routines/wake`, { signal: AbortSignal.timeout(5_000), redirect: "error", credentials: "omit" })
      .then((response) => (response.ok ? response.json() : null))
    : Promise.resolve(null)),
  isOnBattery: () => {
    try {
      return powerMonitor.isOnBatteryPower();
    } catch {
      return false;
    }
  },
  blocker: powerSaveBlocker,
  settings: () => routineWakeSettings(app.getPath("userData")),
  log: (line) => slog(line),
  powerMonitor, isOnline: () => net.isOnline(),
  notify: (event) => localServerRequest("/api/routines/wake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event }) }).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); }),
});

function slog(line) {
  try {
    logStream ??= createCappedLog({ file: path.join(LOG_DIR, "server.log") });
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
  }
}

// a closed terminal or a parent that quit leaves stdout as a dead pipe; logging must never crash the app
for (const stream of [process.stdout, process.stderr]) stream?.on?.("error", (error) => { if (error?.code !== "EPIPE") slog(`stdio error: ${error?.message ?? error}`); });

// Synchronous: a fatal exception can end Electron before an async write flushes.
// uncaughtExceptionMonitor observes Node's fatal path without handling it, so the process still exits.
installDesktopCrashListeners({
  appTarget: app,
  processTarget: process,
  record: (event) => appendDesktopCrashRecord(DESKTOP_CRASH_LOG, DESKTOP_CRASH_LOG_MAX_BYTES, formatDesktopCrashRecord(event)),
  isShuttingDown: () => desktopShutdownStarted,
  mainWebContents: () => mainWindow?.webContents ?? null,
});

let managedCompanionConnector = null;
let companionAccountService = null;
let companionDesiredThisLaunch = false;
let companionLaunchGeneration = 0;
let advertisementTransition = Promise.resolve();

/** Every credential writer goes through this one serialized hook, so concurrent saves never overwrite each other. */
export async function updateSecureCredentialDocument(derive, afterPersist) {
  if (!secureCredentialState) throw new Error("Secure credentials are not ready");
  try {
    return await secureCredentialState.update(derive, afterPersist);
  } finally {
    secureCredentials = secureCredentialState.read();
  }
}

async function ensurePhoneSecretIdentity() {
  const existing = readPhoneSecretIdentity(secureCredentialState?.read() ?? secureCredentials);
  if (existing) {
    phoneSecretIdentity = existing;
    return existing;
  }
  try {
    const created = await createPhoneSecretIdentity();
    await updateSecureCredentialDocument((credentials) =>
      withPhoneSecretIdentity(credentials, created),
    );
    phoneSecretIdentity = created;
    return created;
  } catch (error) {
    phoneSecretIdentity = null;
    slog(`phone credential key unavailable: ${error?.message ?? error}`);
    return null;
  }
}

function publicManagedCompanionState() {
  const access = managedCompanionTunnelAccess(secureCredentials);
  const status = managedCompanionConnector?.getStatus();
  if (status) {
    const publicState = {
      status: status.status,
      configured: status.configured,
      ready: status.ready,
    };
    if (status.endpoint) publicState.url = status.endpoint;
    if (status.retryInMs) publicState.retryInMs = status.retryInMs;
    if (status.error) publicState.error = status.error;
    return publicState;
  }
  return access
    ? { status: "stopped", configured: true, ready: false, url: access.endpoint }
    : { status: "unconfigured", configured: false, ready: false };
}

function decorateDesktopCompanionState(state) {
  syncCompanionKeepAwake(state.enabled && !state.error, state.keepAwake === true);
  return { ...state, managedConnection: publicManagedCompanionState() };
}

async function desktopCompanionState() {
  return decorateDesktopCompanionState(await companionState());
}

function companionLaunchOptions(hostedUrl = null) {
  return {
    resourcesPath: process.resourcesPath,
    harnessPort: SERVER_PORT,
    mutationToken: companionMutationToken,
    hostedUrl,
    // Only an embedded server receives the private half; a dev server must not advertise the public key.
    secretPublicKey: app.isPackaged && serverProc ? phoneSecretIdentity?.publicKey ?? null : null,
    log: slog,
  };
}

function ensureManagedCompanionConnector() {
  if (managedCompanionConnector) return managedCompanionConnector;
  managedCompanionConnector = createManagedCompanionTunnel({
    binaryPath: resolveCloudflaredBinary({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    guardianEntry: resolveManagedCompanionGuardian({ appPath: app.getAppPath() }),
    runtimeExecutable: process.execPath,
    runtimeRoot: path.join(app.getPath("userData"), "managed-companion-tunnel"),
    onChange: (status) => {
      slog(`managed companion connection ${status.status}`);
      if (!companionDesiredThisLaunch) return;
      void reconcileCompanionAdvertisement(status.ready ? status.endpoint : null);
    },
    log: slog,
  });
  return managedCompanionConnector;
}

function reconcileCompanionAdvertisement(
  endpoint,
  ownedGeneration = companionLaunchGeneration,
) {
  const normalizedEndpoint = endpoint || null;
  const work = advertisementTransition.then(async () => {
    if (
      ownedGeneration !== companionLaunchGeneration ||
      !companionDesiredThisLaunch ||
      !companionRunning() ||
      companionAdvertisedHostedUrl() === normalizedEndpoint
    ) {
      return desktopCompanionState();
    }
    const updated = await setCompanionHostedUrl(normalizedEndpoint);
    return { ...updated, managedConnection: publicManagedCompanionState() };
  });
  advertisementTransition = work.then(
    () => {},
    () => {},
  );
  return work;
}

async function startManagedCompanionConnection({ waitForVerification = true } = {}) {
  if (companionAccountCleanupPending(secureCredentials)) {
    return publicManagedCompanionState();
  }
  const access = managedCompanionTunnelAccess(secureCredentials);
  if (!access) return publicManagedCompanionState();
  const target = companionOriginTarget();
  if (!target) return publicManagedCompanionState();
  const operation = ensureManagedCompanionConnector().start({ ...access, originTarget: target });
  if (!waitForVerification) {
    void operation.catch(() => {});
    return publicManagedCompanionState();
  }
  const status = await operation;
  await reconcileCompanionAdvertisement(status.ready ? status.endpoint : null);
  return publicManagedCompanionState();
}

async function startDesktopCompanion({ waitForHosted = true, remember = true } = {}) {
  const refusal = managedRemoteAccessRefusal();
  if (refusal) throw new Error(refusal);
  companionDesiredThisLaunch = true;
  companionLaunchGeneration += 1;
  const localState = await startCompanion(companionLaunchOptions());
  if (!localState.enabled || localState.error) {
    companionDesiredThisLaunch = false;
    return desktopCompanionState();
  }
  if (remember) rememberCompanionEnabled(true);
  await startManagedCompanionConnection({ waitForVerification: waitForHosted });
  return desktopCompanionState();
}

async function stopDesktopCompanion({ remember = true } = {}) {
  companionDesiredThisLaunch = false;
  companionLaunchGeneration += 1;
  if (remember) rememberCompanionEnabled(false);
  syncCompanionKeepAwake(false, false);
  await managedCompanionConnector?.stop();
  await stopCompanion();
  return desktopCompanionState();
}

async function refreshDesktopCompanionTailscale() {
  if (!companionRunning()) {
    const started = await startDesktopCompanion({ waitForHosted: false });
    if (!started.enabled || started.error) return started;
  }
  return decorateDesktopCompanionState(await companionRefreshTailscale());
}

setCompanionLifecycleListener(({ expected, pid }) => {
  if (expected || appEnding()) return;
  slog(`owned companion exited unexpectedly pid=${pid ?? "unknown"}`);
  productEvents.action("crash", { kind: "utility", reason: "companion_exit" });
  companionDesiredThisLaunch = false;
  companionLaunchGeneration += 1;
  syncCompanionKeepAwake(false, false);
  void managedCompanionConnector?.stop().catch(() => {});
});

/** Stops advertising the hosted route but keeps the retry credentials until remote cleanup is scheduled. */
async function stopManagedCompanionEndpointLocally() {
  await managedCompanionConnector?.stop();
  if (companionDesiredThisLaunch) await reconcileCompanionAdvertisement(null);
  return publicManagedCompanionState();
}

async function activatePersistedManagedCompanionEndpoint() {
  if (companionDesiredThisLaunch) {
    return startManagedCompanionConnection({ waitForVerification: true });
  }
  return publicManagedCompanionState();
}

function installationDisplayName() {
  const hostname = [...os.hostname()]
    .filter((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127)
    .join("")
    .trim();
  return hostname.slice(0, 80) || "this computer";
}

function ensureCompanionAccountService() {
  if (companionAccountService) return companionAccountService;
  const baseURL = resolveCompanionControlPlaneURL({
    isPackaged: app.isPackaged,
    environment: process.env,
  });
  let client = null;
  if (baseURL) {
    try {
      client = createControlPlaneClient({ baseURL });
    } catch {
    }
  }
  companionAccountService = createCompanionAccountService({
    client,
    readCredentials: () => secureCredentialState?.read() ?? secureCredentials,
    updateCredentials: updateSecureCredentialDocument,
    identity: {
      name: installationDisplayName(),
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      appVersion: app.getVersion().slice(0, 64),
    },
    newClientInstanceId: randomUUID,
    activatePersistedEndpoint: activatePersistedManagedCompanionEndpoint,
    stopManagedEndpoint: stopManagedCompanionEndpointLocally,
    managedConnectionState: publicManagedCompanionState,
    companionIsOn: () => companionDesiredThisLaunch,
    autoRecover: true,
    onDemand: true,
    managedEndpointNeeded: async () =>
      companionRunning() ? managedEndpointNeed(await companionState().catch(() => null)) : null,
    log: (line) => slog(line),
  });
  return companionAccountService;
}

// Everything the bug-report bundle needs: config is booleans only and the log is redacted, since it is pasted into public issues.
async function gatherDiagnostics() {
  const serverStatus = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, {
    signal: AbortSignal.timeout(3_000),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  const logPath = path.join(LOG_DIR, "server.log");
  const log = readSafeLogTail(logPath);
  const desktopLog = readSafeLogTail(DESKTOP_CRASH_LOG);
  return buildDiagnosticsReport({
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
      uptimeSeconds: Math.round(process.uptime()),
    },
    configSummary: serverStatus ?? {},
    desktopLogTail: desktopLog?.tail ?? "",
    logTail: log?.tail ?? "",
  });
}

/** Why the background server isn't up (a key of SERVER_FAILURES), once it failed. */
let serverFailure = "timeout";
let serverRestarting = null;

function showsLocalPage(win) {
  if (!win || win.isDestroyed()) return false;
  try { return new URL(win.webContents.getURL()).origin === rendererOrigin(); } catch { return false; }
}

function serverFailurePage(win, { starting = false } = {}) {
  if (!win || win.isDestroyed()) return;
  serverUnavailableWindows.add(win);
  void win.loadURL(buildErrorPage({ reason: serverFailure, logDir: LOG_DIR, starting })).catch(() => {});
}

/** Try again on the failure page: the server starts once more in this same app; the page comes back if it fails again. */
function restartLocalServer(win) {
  if (serverRestarting || serverReady || desktopRemoteAccess || !app.isPackaged) return serverRestarting;
  serverFailurePage(win, { starting: true });
  serverRestarting = startServerPackaged().catch((error) => {
    slog(`server restart failed: ${error?.message ?? error}`);
    return false;
  }).then((ok) => {
    serverRestarting = null;
    if (!ok) serverFailurePage(win);
    return ok;
  });
  return serverRestarting;
}

function runServerPageAction(action, win) {
  if (action === "retry") return void restartLocalServer(win);
  void shell.openExternal(serverProblemReportUrl({ reason: serverFailure, version: app.getVersion(), platform: process.platform, arch: process.arch })).catch(() => {});
}

function syncSavedSecretsKey(proc) {
  try {
    proc.postMessage(savedSecretsKeyMessage(savedSecretsKey));
  } catch (error) {
    slog(`saved secrets key sync failed: ${error?.message ?? error}`);
  }
}

function syncPhoneSecretKey(proc) {
  const message = phoneSecretPrivateKeyMessage(phoneSecretIdentity);
  if (!message) return;
  try {
    proc.postMessage(message);
  } catch (error) {
    slog(`phone credential key sync failed: ${error?.message ?? error}`);
  }
}

const accountApp = () => (app.isPackaged || cloudTarget(process.env).custom) && !desktopRemoteAccess;
const accountGateNeeded = () => accountGateRequired({ env: process.env, packaged: app.isPackaged, remote: Boolean(desktopRemoteAccess), custom: cloudTarget(process.env).custom }); const cloudEncryption = { available: async () => (await safeStorage.isAsyncEncryptionAvailable()) && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"), encrypt: value => safeStorage.encryptStringAsync(value), decrypt: value => safeStorage.decryptStringAsync(value) }; const plainSignInStorage = () => { try { return process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"; } catch { return false; } };
// without a keyring Linux has only "basic_text": the sign-in is still kept (in a 0600 file) rather than lost after its code is spent
const signInEncryption = { ...cloudEncryption, available: () => safeStorage.isAsyncEncryptionAvailable() }; let activeSignIn = null; const cloudAccountStore = () => (activeSignIn ??= createCloudAccountStore({ file: path.join(app.getPath("userData"), cloudTarget(process.env).file), encryption: signInEncryption }));
function ensureCloudAccount() {
  if (cloudAccount) return cloudAccount;
  if ((!app.isPackaged && !cloudTarget(process.env).custom) || desktopRemoteAccess) throw new Error("dusk cloud sign-in requires the local desktop app.");
  cloudAccount = createCloudAccountClient({
    store: cloudAccountStore(),
    platform: process.platform, deviceName: os.hostname().slice(0, 100) || "my computer", appVersion: app.getVersion(), origin: cloudTarget(process.env).origin, custom: cloudTarget(process.env).custom,
    // every browser sign-in (Google, Apple, a magic link) goes through the website with this app's sign-in code, so a new
    // account gets the website's first steps there, and this app signs itself in when the website approves it
    openBrowser: url => shell.openExternal(url), awaitingWake: () => cloudPower.awaiting(), appLinks: false,
    onState: state => {
      cloudSync.accountChanged(state.account?.id ?? null); rememberCloudHome(state);
      rememberedHome = rememberedCloudHome(rememberedHome, state);
      cloudPower.changed(); try { void oneHome.kick(); void homeWindow.changed(); announceAddedCloud(state); railChanged(); accountEnroll.onState(state); accountGate.changed(state); void botsElsewhere.remember(); void vpsCloudMove?.kick(); void vpsCloudMove?.signedInNow?.(); serverEnroll?.onState(state); } catch {}
      // a server's install line that waited on the account: made at once now (vpsLink may not exist yet at launch)
      try { if (state?.account && state.status === "connected") void vpsLink?.accountReady?.(); } catch {}
      void includedX.onState(state); void includedPages.onState(state); accounts.tell();
      refreshCloudMenus();
      announceCloudReady(state);
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`) &&
        !activeRemote(environmentsState) && !desktopRemoteAccess) mainWindow.webContents.send("cloud-account:state-changed", state);
    },
  });
  return cloudAccount;
}

/** The free trial's popup, at most once a day per notice across this computer's page and the Cloud's. */
let trialNotices = null;
function cloudTrialNotices() {
  return trialNotices ??= createTrialNotices(jsonFile(path.join(app.getPath("userData"), "cloud-trial-notices.json")));
}

function cloudOffersAllowed() {
  return accountApp();
}
async function cloudOffersReady() {
  return cloudOffersAllowed();
}
const menuDate = value => new Intl.DateTimeFormat(app.getLocale() || "en-US", { day: "numeric", month: "short" }).format(new Date(value));
function cloudHomeEntry() {
  const homeOrigin = cloudAccount?.homeTarget()?.origin ?? null;
  return environmentsState.environments.find(candidate => isCloudHomeEntry(candidate, { homeOrigin, remembered: rememberedHome })) ?? null;
}
function cloudMenuSublabels() {
  const entry = cloudHomeEntry();
  const line = entry ? cloudMenuSublabel(cloudAccount?.state(), menuDate) : null;
  return entry && line ? { [entry.id]: line } : {};
}
const cloudColorDot = colorDotIcons(nativeImage);
const placeKindIcon = placeKindIcons(nativeImage, path.join(__dirname, "resources"), process.platform);
function cloudMenuOptions(source = "app_menu") {
  return { sublabels: cloudMenuSublabels(), iconFor: cloudColorDot, ...(cloudOffersAllowed() ? { onAddCloud: () => void workspaceMenuAction(() => openCloudAdd(source)) } : {}) };
}
let cloudMenuKey = "";
function refreshCloudMenus() {
  const key = JSON.stringify([cloudOffersAllowed(), cloudMenuSublabels()]);
  if (key === cloudMenuKey) return;
  cloudMenuKey = key;
  refreshApplicationMenu();
}
/** Add a Cloud… is always the sheet on this computer's page, which says what is true now (setting up, one Cloud for now). */
async function openCloudAdd(source) {
  if (!cloudOffersAllowed() || !serverReady) return;
  await cloudAccountRestored();
  if (activeRemote(environmentsState)) persistEnvironments(withActive(environmentsState, LOCAL_ID), "chosen");
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: true });
  if (!desktopTray?.show()) activateExistingWindow(appWindows());
  const action = source === "app_howto" ? "cloud-add-howto" : "cloud-add";
  if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) win.webContents.send("app:open-settings", action);
  else await win.loadURL(`${rendererOrigin()}/?desktop-settings=${action}`);
}
const announceCloudReady = createCloudReadyNotice({ Notification, focused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
  sheetOpen: () => cloudBuy.sheetOpen(), name: () => cloudLook.current().name, shown: () => cloudAccount?.checkoutDone(),
  open: () => { if (!desktopTray?.show()) activateExistingWindow(appWindows()); void workspaceMenuAction(() => (homeWindow.cloudOrigin() ? showHome({ place: "cloud" }) : connectCloudHome())); } });

function ensureManagedDesktop() {
  if (managedDesktop) return managedDesktop;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("Organization sign-in requires the installed desktop app running on this computer.");
  const encryption = {
    available: async () => (await safeStorage.isAsyncEncryptionAvailable()) &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: value => safeStorage.decryptStringAsync(value),
  };
  const store = createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-connection.bin"), encryption });
  orgLibrary = createOrgLibrary({
    dataDir: path.join(desktopDataDir(), "org-library"),
    store: createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-library.bin"), encryption }),
    fetchBytes: (route, maxBytes, options) => managedDesktop.fetchLibraryBytes(route, maxBytes, options),
    relay: library => managedDesktopRelay.sendLibrary(serverProc, library),
    appVersion: app.getVersion(),
    log: message => slog(message),
  });
  managedDesktop = createManagedDesktopClient({
    store, platform: process.platform, deviceName: os.hostname().slice(0, 100) || "my computer",
    applyConnection: connection => managedDesktopRelay.send(serverProc, connection),
    applyPolicy: policy => managedDesktopRelay.sendPolicy(serverProc, policy),
    migrateIdentity: identity => managedDesktopRelay.sendIdentity(serverProc, identity),
    library: orgLibrary,
    appVersion: app.getVersion(),
    openBrowser: url => shell.openExternal(url),
    onState: state => {
      if (state.status === "license-expired") companyBackupController?.abort();
      const lost = ["signed-out", "reauth-required"].includes(state.status), withoutStorage = state.status === "connected" && !state.cloudBackups;
      if (lost || withoutStorage) {
        companyBackupConfigurationRevision++;
        companyBackupController?.abort();
        preparedCompanyRestore = null;
        if (withoutStorage) void companyBackupSchedule?.forget().catch(() => {});
        publishCompanyBackupState({ busy: Boolean(companyBackupController) });
      }
      companyBackupSchedule?.reconcile();
      // Remote pages never receive local identity events, even in a window that once subscribed locally.
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`) &&
          !activeRemote(environmentsState) && !desktopRemoteAccess) {
        mainWindow.webContents.send("organization:state-changed", state);
      }
    },
  });
  companyBackupSchedule = createCompanyBackupSchedule({
    store: createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-backup-schedule.bin"), encryption }),
    scope: companyBackupScope,
    run: async (signal, scope) => {
      if (companyBackupController || preparedCompanyRestore || companyRestoreCommitting || desktopShutdownStarted) throw companyBackupDeferred();
      const proc = serverProc;
      const status = await localBackupStatus(proc);
      if (status.busy || status.pendingRestore) throw companyBackupDeferred();
      const clientState = await collectCompanyBackupClientState(signal, scope, proc);
      signal.throwIfAborted();
      const current = companyBackupScope();
      if (!current || current.key !== scope.key || current.generation !== scope.generation || proc !== serverProc || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
      return runCompanyBackup("backup", { clientState }, { signal, scope });
    },
    onState: schedule => publishCompanyBackupState({ ...companyBackupState, schedule }),
  });
  return managedDesktop;
}

function companyBackupScope() {
  if (desktopShutdownStarted || desktopRemoteAccess || !serverReady || !serverProc || activeEnvironment(environmentsState)) return null;
  const client = managedDesktop, connection = client?.connection(), state = client?.state();
  if (!connection || state?.status !== "connected" || !state.cloudBackups || connection.expiresAt <= Date.now()) return null;
  const dataDir = path.resolve(desktopDataDir());
  return { key: JSON.stringify([connection.portalOrigin, connection.organizationId, connection.email, dataDir]),
    adopts: saved => {
      try {
        const value = JSON.parse(saved);
        return Array.isArray(value) && value.length === 5 && typeof value[3] === "string" && value[0] === connection.portalOrigin &&
          value[1] === connection.organizationId && value[2] === connection.email && value[4] === dataDir;
      } catch { return false; }
    },
    generation: client.backupGeneration() };
}

function companyBackupDeferred() {
  return Object.assign(new Error("Wait for this installation to be available for its daily backup."), { code: "workspace_busy" });
}

function collectCompanyBackupClientState(signal, scope, proc) {
  const win = mainWindow, contents = win?.webContents, frame = contents?.mainFrame;
  if (companyBackupClientStateRequest || !win || win.isDestroyed() || desktopRemoteAccess || activeEnvironment(environmentsState) ||
      !frame?.url.startsWith(`${rendererOrigin()}/`)) return Promise.reject(companyBackupDeferred());
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (error, value) => {
      if (companyBackupClientStateRequest?.requestId !== requestId) return;
      companyBackupClientStateRequest = null;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(companyBackupDeferred());
    const timer = setTimeout(abort, 10_000); timer.unref?.();
    companyBackupClientStateRequest = { requestId, win, contents, frame, url: frame.url, scope, proc, finish };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { contents.send("company-backups:collect-client-state", { requestId }); }
    catch { abort(); }
  });
}

function receiveCompanyBackupClientState(event, input) {
  const pending = companyBackupClientStateRequest;
  if (!pending || input?.requestId !== pending.requestId || event.sender !== pending.contents || event.senderFrame !== pending.frame) return;
  const scope = companyBackupScope();
  if (pending.win !== mainWindow || mainWindow.isDestroyed() || pending.url !== pending.frame.url ||
      !workspaceSenderAllowed(event, mainWindow.webContents, environmentsState, rendererOrigin()) ||
      procUnavailable() || !scope || scope.key !== pending.scope.key || scope.generation !== pending.scope.generation) {
    pending.finish(companyBackupDeferred()); return;
  }
  function procUnavailable() { return pending.proc !== serverProc || !serverReady || desktopRemoteAccess || desktopShutdownStarted; }
  const value = input.clientState;
  if (input.unavailable || !value || typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some(entry => typeof entry !== "string") || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 ** 2) {
    pending.finish(companyBackupDeferred()); return;
  }
  pending.finish(null, Object.fromEntries(Object.entries(value)));
}

function publishCompanyBackupState(value) {
  companyBackupState = { ...value, ...(companyBackupSchedule ? { schedule: companyBackupSchedule.state() } : {}) };
  if (mainWindow && !mainWindow.isDestroyed() && !activeRemote(environmentsState) && !desktopRemoteAccess &&
      mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`)) mainWindow.webContents.send("company-backups:state-changed", companyBackupState);
}

function localBackupRequest(proc, route, init = {}) {
  if (!proc || proc !== serverProc || !serverReady || !/^\/api\/workspace-backup\/(?:status|export|upload|preview|restore|download\/[A-Za-z0-9_-]+)$/.test(route)) {
    throw new Error("This installation changed. Start this backup operation again.");
  }
  return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit",
    headers: { ...Object.fromEntries(new Headers(init.headers)), [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
}

async function localBackupStatus(proc) {
  const response = await localBackupRequest(proc, "/api/workspace-backup/status", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Local backup status is unavailable. Try again when this installation is ready.");
  const status = await response.json();
  if (proc !== serverProc || typeof status.busy !== "boolean" || typeof status.pendingRestore !== "boolean") throw new Error("This installation changed. Check backup status again.");
  return status;
}

async function runCompanyBackup(kind, input, scheduled = null) {
  if (companyBackupController || companyRestoreCommitting || desktopShutdownStarted || (scheduled && preparedCompanyRestore)) throw companyBackupDeferred();
  const client = ensureManagedDesktop(), connection = client.connection();
  if (!connection || !client.state().cloudBackups) throw new Error("Connect your organization and ask its administrator to enable cloud backups first.");
  const generation = client.backupGeneration();
  if (scheduled) {
    scheduled.signal.throwIfAborted();
    const scope = companyBackupScope();
    if (!scope || scope.key !== scheduled.scope.key || scope.generation !== scheduled.scope.generation) throw companyBackupDeferred();
  }
  const proc = serverProc, controller = new AbortController();
  const cancelScheduled = () => controller.abort();
  scheduled?.signal.addEventListener("abort", cancelScheduled, { once: true });
  const deadline = setTimeout(() => controller.abort(), 2 * 60 * 60_000); deadline.unref?.();
  companyBackupController = controller;
  preparedCompanyRestore = null;
  publishCompanyBackupState({ busy: true, kind });
  const progress = progress => publishCompanyBackupState({ busy: true, kind, progress });
  try {
    const status = await localBackupStatus(proc);
    if (status.pendingRestore) {
      publishCompanyBackupState({ busy: false, pendingRestore: true });
      throw new Error("Restart Metal to finish the pending restore before starting another backup operation.");
    }
    if (status.busy) throw companyBackupDeferred();
    const transfers = createCompanyBackups({
      tempRoot: path.join(app.getPath("temp"), "dusk-company-backups"),
      localRequest: (route, init) => localBackupRequest(proc, route, init),
      portalRequest: (route, options) => client.requestBackup(route, { ...options, generation }),
      availableBytes: async temporary => {
        const volumes = await Promise.all([fs.promises.statfs(temporary), fs.promises.statfs(desktopDataDir())]);
        return Math.min(...volumes.map(volume => volume.bavail * volume.bsize));
      },
    });
    const result = kind === "backup" ? await transfers.backup({ ...input, appVersion: app.getVersion() }, controller.signal, progress)
      : await transfers.prepareRestore(input, controller.signal, progress);
    controller.signal.throwIfAborted();
    if (proc !== serverProc || client.backupGeneration() !== generation || client.connection()?.deviceId !== connection.deviceId) throw new Error("This installation or its organization connection changed.");
    if (kind === "restore") preparedCompanyRestore = { id: result.id, proc, deviceId: connection.deviceId };
    publishCompanyBackupState({ busy: false, ...(kind === "backup" ? { lastBackupAt: Date.now() } : {}) });
    return result;
  } catch (error) {
    const message = controller.signal.aborted ? "Cloud backup cancelled. This installation has not been replaced."
      : error?.name === "CompanyBackupError" ? error.message : "Cloud backup could not complete. Check your organization connection and available disk space, then try again.";
    publishCompanyBackupState({ busy: false, pendingRestore: companyBackupState.pendingRestore, message });
    throw Object.assign(new Error(message), error?.code === "workspace_busy" ? { code: "workspace_busy" } : {});
  } finally {
    clearTimeout(deadline);
    scheduled?.signal.removeEventListener("abort", cancelScheduled);
    if (companyBackupController === controller) companyBackupController = null;
  }
}

function syncDesktopMutationToken(proc) {
  try {
    proc.postMessage({
      type: "duskbot:desktop-mutation-token",
      token: desktopMutationToken,
      companionToken: companionMutationToken,
    });
  } catch (error) {
    slog(`desktop mutation capability sync failed: ${error?.message ?? error}`);
  }
}

const savePhoneSecretOnce = createPhoneSecretSaveCoordinator((target, value) =>
  saveWorkspaceCredential(target, value),
);

/** The harness asks for the Mac companion's addresses when a phone signed in to this account links: only while the
 * companion already runs and policy allows remote access. Security: a remote request never starts it. */
function receiveCompanionEndpoints(proc, rawMessage) {
  if (!rawMessage || typeof rawMessage !== "object" || rawMessage.type !== "duskbot:companion-endpoints") return false;
  const requestId = typeof rawMessage.requestId === "string" ? rawMessage.requestId.slice(0, 64) : null;
  if (!requestId) return true;
  const answer = async () => {
    if (managedRemoteAccessRefusal() || !companionRunning()) return null;
    const state = await desktopCompanionState();
    return state.enabled && !state.error && Array.isArray(state.endpoints) && state.endpoints.length ? state.endpoints : null;
  };
  void answer().catch(() => null).then((endpoints) => {
    try { proc.postMessage({ type: "duskbot:companion-endpoints-result", requestId, endpoints }); } catch {}
  });
  return true;
}

function receivePhoneSecretSave(proc, rawMessage) {
  const request = decodePhoneSecretSaveRequest(rawMessage);
  if (!request) return false;
  void savePhoneSecretOnce(request).then((result) => {
    try {
      proc.postMessage(result);
    } catch (error) {
      slog(`phone credential save result failed: ${error?.message ?? error}`);
    }
  });
  return true;
}

async function startServerOn(port, dataDir = runningDataDir ?? startupEnvironmentDir(environmentsState, desktopDataDir())) {
  if (desktopShutdownStarted) return { proc: null, abort: true };
  const { entry, compileCacheDir } = serverChildLaunch({
    resourcesPath: process.resourcesPath,
    userData: app.getPath("userData"),
  });
  const childEnv = managedComposioChildEnvironment(composioBrokerUrl(), secureCredentials, {
    ...process.env,
    // The parent owns the data-dir lease; a child only validates it, so fallback-port children never replace it.
    ...desktopDataDirLease.utilityServerLeaseEnvironment(),
    DUSK_DATA_DIR: dataDir,
    // Fail-closed until this process sends the private connection; never a descriptor inherited from the shell.
    DUSK_DESKTOP_PARENT: "1",
    DUSK_DESKTOP_LAUNCH_ID: desktopLaunchId,
    DUSK_STATIC_DIR: path.join(process.resourcesPath, "ui"),
    DUSK_RESOURCES_PATH: process.resourcesPath,
    DUSK_SKILLS_DIR: path.join(process.resourcesPath, "skills"),
    DUSK_PORT: String(port),
    DUSK_APP_VERSION: app.getVersion(),
    DUSK_USER_DATA: app.getPath("userData"),
    DUSK_PREINSTALL_FREE_BACKUP: "1",
    ...(secureCredentials.composioApiKey
      ? { COMPOSIO_API_KEY: secureCredentials.composioApiKey }
      : {}),
    DUSK_CREDENTIAL_STORE: credentialFile.unavailable() ? "unavailable" : "ok",
    ...workspaceCredentialEnv(secureCredentials),
  });
  delete childEnv.DUSK_BROWSER_CONNECTION;
  delete childEnv.DUSK_SERVER_COMPILE_CACHE;
  if (compileCacheDir) childEnv.DUSK_SERVER_COMPILE_CACHE = compileCacheDir;
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: UTILITY_NAMES.server,
  });
  let resolveServerExit;
  utilityServerExits.set(proc, new Promise((resolve) => {
    resolveServerExit = resolve;
  }));
  const listening = listeningSignal();
  proc.stdout?.on("data", (d) => {
    listening.hear(String(d));
    slog(`[out] ${String(d).trimEnd()}`);
  });
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.on("message", (message) => {
    if (!serverSupervisor.isCurrent(proc)) return;
    try {
      if (trustedApprovalMode.receive(proc, message)) return;
      if (browsersFlush.receive(message)) return;
      if (managedDesktopRelay.receive(proc, message)) return;
      if (orgLibrary?.receive(message)) return;
      if (settingsSyncMain?.receive(message) || receivePhoneSecretSave(proc, message) || receiveCompanionEndpoints(proc, message) || oneHome.receive(proc, message)) return;
    } catch (error) {
      slog(`desktop private sync rejected: ${error?.message ?? error}`);
    }
  });
  proc.once("spawn", () => {
    slog(`spawned pid=${proc.pid}`);
    if (!serverSupervisor.isCurrent(proc)) return;
    syncDesktopMutationToken(proc);
    syncPhoneSecretKey(proc); syncSavedSecretsKey(proc); grantLocalComputer(proc, (child) => serverSupervisor.isCurrent(child));
  });
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    trustedApprovalMode.rejectProcess(proc);
    managedDesktopRelay.rejectProcess(proc);
    resolveServerExit();
    slog(`exited code=${code}`);
  });
  serverSupervisor.watch(proc);
  const identity = await pollServerIdentity({
    port,
    pid: () => proc.pid,
    bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS,
    isExited: () => exited || desktopShutdownStarted,
    isListening: listening.heard,
    listeningGraceMs: SERVER_LISTENING_GRACE_MS,
    isStarting: listening.spoke,
    startingGraceMs: SERVER_STARTING_GRACE_MS,
  });
  if (identity.outcome === "ready" && serverSupervisor.isCurrent(proc)) return { proc };
  slog(bootFailureMessage(port, identity));
  // a loaded Windows PC may take longer than a quit's wait to end the child; giving up here would end every attempt
  const stopped = await stopUtilityServer(proc, UTILITY_SERVER_BOOT_STOP_TIMEOUT_MS);
  if (!stopped) {
    slog(`child on port ${port} did not exit after termination; refusing to start a sibling server`);
  }
  return { proc: null, reason: stopped ? identity.outcome : "stuck-child", abort: !stopped };
}

const SERVER_START_TRIES = 4;

/** Starts this computer's server on the first free desktop port (another program's port is skipped at once, a server an
 * earlier launch left behind is stopped first), else on a port the system picks. A server that never answers on a free
 * port is not a port problem, so it is not tried again elsewhere. */
async function startServerPackaged() {
  const skipped = new Set();
  let told = false;
  for (let attempt = 0; attempt < SERVER_START_TRIES; attempt++) {
    if (desktopShutdownStarted) return false;
    const { port, busy } = await pickServerPort(DESKTOP_PORTS.filter((candidate) => !skipped.has(candidate)), {
      stranded: (candidate) => strandedServerOn(candidate, { execPath: process.execPath }),
      log: slog,
    });
    if (busy.length && !told) { told = true; startupScreen?.status("Another app is using Metal's port, so it's opening on a free one"); }
    for (const taken of busy) skipped.add(taken);
    const started = await startServerOn(port);
    if (started.proc) {
      SERVER_PORT = port;
      if (serverSupervisor.ready(started.proc)) return true;
    }
    if (started.abort) return false;
    skipped.add(port);
    serverFailure = started.reason === "timeout" ? "timeout" : started.reason === "foreign-owner" ? "ports" : "stopped";
    if (started.reason === "timeout") return false;
  }
  return false;
}

async function startDevServer() {
  SERVER_PORT = Number(process.env.DUSK_PORT || 8799);
  const root = app.getAppPath();
  devDataDir = startFolder();
  devServer = createDevServerChild({
    fork: (entry, args, options) => utilityProcess.fork(entry, args, options),
    entry: path.join(root, "server", "dev-server.ts"),
    env: { ...process.env, DUSK_PORT: String(SERVER_PORT), DUSK_DATA_DIR: devDataDir, ...(devDataDir === desktopDataDir() ? {} : { DUSK_NO_TEST_BOTS: "1" }) },
    port: SERVER_PORT,
    grant: (proc, isCurrent) => { serverProc = proc; if (!proc.__duskDevWired) { proc.__duskDevWired = true; proc.on("message", (message) => { if (serverProc !== proc) return; try { if (trustedApprovalMode.receive(proc, message) || managedDesktopRelay.receive(proc, message) || orgLibrary?.receive(message) || settingsSyncMain?.receive(message) || receivePhoneSecretSave(proc, message) || receiveCompanionEndpoints(proc, message)) return; oneHome.receive(proc, message); } catch (error) { slog(`desktop private sync rejected: ${error?.message ?? error}`); } }); } syncDesktopMutationToken(proc); grantLocalComputer(proc, isCurrent); }, // the dev child is this app's own server too: same private channel for moves, logins and approvals
    conflict: (port) => {
      const message = devServerConflictMessage(port);
      console.error(`[dev-server] ${message}`);
      dialog.showErrorBox("The dev server port is taken", message);
    },
    gaveUp: (times) => {
      console.error(`[dev-server] stopped after ${times} quick exits; save a server file to try again`);
      dialog.showErrorBox("The dev server keeps stopping", `It exited ${times} times right after starting. See the terminal running \`pnpm dev:app\`, then save a server file or restart.`);
    },
    log: (line) => console.log(`[dev-server] ${line}`),
  });
  if (!(await devServer.start())) return false;
  if (process.env.DUSK_DEV_SERVER_WATCH !== "0") {
    const unwatch = watchServerSource({ watch: fs.watch, dirs: [path.join(root, "server"), path.join(root, "shared")], restart: () => {
      console.log("[dev-server] source changed, restarting");
      devServer.restart();
    } });
    app.once("will-quit", unwatch);
  }
  return true;
}

function syncManagedComposioCredentials() {
  if (!serverProc) return;
  try {
    serverProc.postMessage({
      type: "duskbot:managed-composio",
      access: managedComposioAccess(composioBrokerUrl(), secureCredentials),
    });
  } catch (error) {
    slog(`connected-apps credential sync failed: ${error?.message ?? error}`);
  }
}

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
const displayMediaGuard = createDisplayMediaGuard();
let displayMediaRequestCount = 0;

function rendererOrigin() {
  return new URL(app.isPackaged || desktopRemoteAccess ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
}

function confirmedRendererOrigin() {
  return app.isPackaged && !serverReady ? null : rendererOrigin();
}

ipcMain.on("desktop:local-origin", event => { event.returnValue = confirmedRendererOrigin(); });

function respondToDisplayMediaRequest(callback, response) {
  const error = invokeDisplayMediaCallback(callback, response);
  if (error && response.video) {
    console.error("[screen-preview] failed to deliver selected source:", error);
  }
}

function notifyDesktopViewer(open) {
  if (!desktopViewerOwner?.isDestroyed()) {
    desktopViewerOwner.send("desktop-viewer:state", {
      open,
      contextId: desktopViewerContextId,
    });
  }
}

function openDesktopViewer(owner, rawUrl, rawTitle, contextId) {
  if (!owner || owner.isDestroyed()) throw new Error("The Metal window is unavailable");
  const url = desktopViewerUrl(rawUrl);
  const titleCandidate = Object.prototype.toString.call(rawTitle) === "[object String]" ? rawTitle.trim() : "";
  const title = titleCandidate ? titleCandidate.slice(0, 80) : "Live desktop";

  const nextContextId =
    Object.prototype.toString.call(contextId) === "[object String]" ? contextId.slice(0, 120) : null;

  // Clear the ref first so the stale window's close handler no-ops; a token-bearing URL is never retained.
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) {
    const previous = desktopViewerWindow;
    const previousOwner = desktopViewerOwner;
    const previousContextId = desktopViewerContextId;
    desktopViewerWindow = null;
    previous.close();
    if (previousContextId !== nextContextId && previousOwner && !previousOwner.isDestroyed()) {
      previousOwner.send("desktop-viewer:state", { open: false, contextId: previousContextId });
    }
  }
  desktopViewerOwner = owner.webContents;
  desktopViewerContextId = nextContextId;

  const viewer = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    parent: owner,
    modal: false,
    show: false,
    title,
    icon: APP_ICON,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Non-persistent partition: provider cookies stay out of the app renderer and die on exit.
      partition: "duskbot-desktop-viewer",
    },
  });
  desktopViewerWindow = viewer;
  const viewerOrigin = url.origin;

  viewer.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    desktopViewerPermissionAllowed(permission, requestingOrigin, viewerOrigin),
  );
  viewer.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(desktopViewerPermissionAllowed(permission, details?.requestingUrl || webContents.getURL(), viewerOrigin)),
  );

  // A child window gets keystrokes only once focused; unfocused, typing lands in the app's composer.
  viewer.once("ready-to-show", () => {
    if (viewer.isDestroyed()) return;
    viewer.show();
    viewer.focus();
    viewer.webContents.focus();
  });
  viewer.on("closed", () => {
    if (desktopViewerWindow !== viewer) return;
    desktopViewerWindow = null;
    notifyDesktopViewer(false);
    desktopViewerOwner = null;
    desktopViewerContextId = null;
  });
  viewer.on("page-title-updated", (event) => {
    event.preventDefault();
    viewer.setTitle(title);
  });
  viewer.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const external = desktopViewerUrl(target);
      void shell.openExternal(external.toString());
    } catch {
    }
    return { action: "deny" };
  });
  viewer.webContents.on("will-navigate", (event, target) => {
    if (sameDesktopViewerOrigin(target, viewerOrigin)) return;
    event.preventDefault();
    try {
      void shell.openExternal(desktopViewerUrl(target).toString());
    } catch {
    }
  });
  notifyDesktopViewer(true);
  loadWithOneRetry(viewer, url.toString(), desktopViewerErrorPage, (line) => slog(`desktop viewer: ${line}`));
  return true;
}

function ensureDesktopWorkspace(owner) {
  if (!owner || owner.isDestroyed()) throw new Error("The Metal window is unavailable");
  if (desktopWorkspaceManager) {
    if (desktopWorkspaceOwner !== owner) {
      throw new Error("The two-desktop view belongs to another app window");
    }
    return desktopWorkspaceManager;
  }

  desktopWorkspaceOwner = owner;
  const manager = createDesktopWorkspaceManager({
    owner,
    createView: (options) => new WebContentsView(options),
    partitionPrefix: `duskbot-desktop-workspace-${randomUUID()}`,
    notify: (state) => {
      if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) {
        owner.webContents.send("desktop-workspace:state", state);
      }
    },
  });
  desktopWorkspaceManager = manager;

  // Native child views outlive the renderer DOM; close both panes so no secret-bearing noVNC URL survives.
  owner.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) manager.closeAll();
  });
  owner.webContents.on("render-process-gone", () => manager.closeAll());
  owner.once("closed", () => {
    manager.closeAll();
    if (desktopWorkspaceManager === manager) {
      desktopWorkspaceManager = null;
      desktopWorkspaceOwner = null;
    }
  });
  return manager;
}

function desktopWorkspaceForEvent(event, create = false) {
  const owner = mainWindow;
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) {
    throw new Error("The two-desktop view is available only to the main app window");
  }
  if (desktopWorkspaceManager && desktopWorkspaceOwner !== owner) {
    throw new Error("The two-desktop view belongs to another app window");
  }
  return create ? ensureDesktopWorkspace(owner) : desktopWorkspaceManager;
}

ipcMain.on("screen:preview-intent", localOnlySync("screen:preview-intent", (event) => {
  event.returnValue = displayMediaGuard.begin(event.senderFrame);
}));

// macOS only: there the display-media handler picks the screen itself; a Linux portal would pop its picker unasked.
ipcMain.handle("screen:live-intent", localOnly("screen:live-intent", async (event) =>
  process.platform === "darwin" && displayMediaGuard.begin(event.senderFrame, { live: true })));

ipcMain.on("desktop:unread-count", (event, value) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed()) return;
  unreadCount = normalizeUnreadCount(value);
  applyUnreadBadge(sender);
});

const { LOCAL_ID, activeEnvironment, activeRemote, allowedOrigins, bootEnvironmentDir, isThisAppsServer, otherPlaces, parseHostedWorkspaceLink, savedPlace, startupEnvironmentDir, withActive, withEnvironment, withEnvironmentLook, withLocalEnvironment, withMicrophone, withPlaceColor, withoutEnvironment, withOwnCloud, withTeam, placesMenuOptions, workspaceMenuTemplate, workspaceNavigationAllowed, workspaceSenderAllowed, workspaceSummary, workspaceWindowTitle } = environmentsModule;
let environmentsState = { environments: [], activeId: LOCAL_ID };
const cleanWorkspace = createCleanWorkspace({ dataDir: desktopDataDir, running: () => runningDataDir ?? devDataDir, swap: swapLocalData, allowed: () => !desktopRemoteAccess && (app.isPackaged || Boolean(devServer)), changed: () => { void oneHome.kick(); }, log: slog });
/** This computer's default folder, or the clean workspace once a finished move to a server of the person's own froze it. */
function startFolder() {
  return !desktopRemoteAccess && ownHome?.away() ? cleanWorkspace.startFolder() : desktopDataDir();
}
/** The clean workspace's folder swap. The window stays on a server of the person's own while it shows one. */
function swapLocalData(dir) {
  const own = ownHome?.home();
  const stay = Boolean(own) && activeEnvironment(environmentsState)?.origin === own.origin;
  return app.isPackaged ? switchLocalEnvironmentTo(dir, LOCAL_ID, true, { stay }) : switchDevDataDir(dir, stay);
}
/** `pnpm dev:app`'s harness on another folder: the same child restarted there. A clean workspace gets no test bots. */
async function switchDevDataDir(dir, stay) {
  if (!devServer) return { ok: false, error: "dev" };
  const { DUSK_NO_TEST_BOTS: _seeded, ...env } = devServer.env();
  const seeding = dir === desktopDataDir() ? (process.env.DUSK_NO_TEST_BOTS ? { DUSK_NO_TEST_BOTS: process.env.DUSK_NO_TEST_BOTS } : {}) : { DUSK_NO_TEST_BOTS: "1" };
  const spawned = await Promise.race([devServer.retarget({ ...env, ...seeding, DUSK_DATA_DIR: dir }), new Promise(done => setTimeout(() => done(false), 30_000))]);
  devDataDir = dir;
  if (!spawned || !(await devServerAnswers(60_000))) { slog(`dev server: could not start on ${dir}`); return { ok: false, error: "switch-failed" }; }
  if (!stay) navigateMainWindow(rendererOrigin());
  return { ok: true };
}
async function devServerAnswers(withinMs) {
  const until = Date.now() + withinMs;
  while (Date.now() < until && !desktopShutdownStarted) {
    try { const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`, { signal: AbortSignal.timeout(2_000) }); await response.body?.cancel?.(); if (response.ok) return true; } catch {}
    await new Promise(done => setTimeout(done, 500));
  }
  return false;
}
const appImageMenuEntry = createAppImageMenuEntry({ home: os.homedir(), file: path.join(app.getPath("userData"), "app-menu-entry.json"), iconSource: path.join(process.resourcesPath, "icon.svg"), log: slog }); const loginItem = createOpenAtLogin({ app, file: path.join(app.getPath("userData"), "open-at-login.json"), home: os.homedir() });
installOpenAtLogin({ ipcMain, guard: localOrHome, loginItem, changed: refreshApplicationMenu }); installAppImageMenuEntry({ ipcMain, guard: localOnly, entry: appImageMenuEntry });
let hiddenStart = false;

async function openCloudSettings() {
  if (!app.isPackaged || desktopRemoteAccess || !serverReady) return;
  if (homeWindow.cloudOrigin()) {
    await showHome({ place: "cloud" });
    if (!desktopTray?.show()) activateExistingWindow(appWindows());
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:open-settings", "cloud-settings");
    return;
  }
  if (activeRemote(environmentsState)) persistEnvironments(withActive(environmentsState, LOCAL_ID), "chosen");
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: true });
  if (!desktopTray?.show()) activateExistingWindow(appWindows());
  if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) win.webContents.send("app:open-settings", "cloud-settings");
  else await win.loadURL(`${rendererOrigin()}/?desktop-settings=cloud-settings`);
}

function environmentsFile() {
  return path.join(app.getPath("userData"), cloudTarget(process.env).environments);
}

const environmentsStore = createEnvironmentsFile({ file: environmentsFile, fs, path, log: slog });

function activeOrigin() {
  return activeEnvironment(environmentsState)?.origin ?? rendererOrigin();
}

let trailMain = null;
function exportUsageLogFromMenu() {
  void trailMain?.exportUsageLog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined).catch((error) => { dialog.showErrorBox("Export usage log", error?.message ?? String(error)); });
}

function refreshApplicationMenu() {
  Menu.setApplicationMenu(
    buildApplicationMenu({
      environments: environmentsState.environments,
      activeId: environmentsState.activeId,
      onSwitch: (id) => void workspaceMenuAction(() => switchEnvironment(id)),
      onAddFromClipboard: () => void addServerFromClipboard(),
      onConnect: () => void workspaceMenuAction(openWorkspaceSettings),
      onOrganizationSignIn: () => queueOrganizationEntry("duskbot://organization"),
      onForget: (id) => void workspaceMenuAction(() => forgetEnvironment(id)),
      onOpenSettings: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:open-settings"); },
      openAtLogin: loginItem.available() ? { checked: loginItem.chosen(), onToggle: on => { loginItem.choose(on); refreshApplicationMenu(); } } : null,
      ...cloudMenuOptions(),
      home: homeWindow.cloudOrigin() ? { origin: homeWindow.cloudOrigin(), onBack: () => void showHome({ place: "cloud" }) } : null,
      onQuit: fromKeys => desktopBots.quit(fromKeys), onStop: all => desktopBots.stop(all),
      onExportUsageLog: exportUsageLogFromMenu,
    }),
  );
}

/** `why`: "chosen", "joined", "gone" or "unusable" (workspace-choice.mjs) when this write may change the chosen workspace; any
 * other write keeps it, unless the chosen entry is gone from `next`. */
function persistEnvironments(next, why = null) {
  const before = environmentsState;
  const settled = settledActive(before, next, why);
  if (settled.activeId !== next.activeId) slog("workspace: a switch nobody chose was refused; the chosen workspace stays");
  next = settled;
  if (next.activeId !== before.activeId) workspaceReconnect.stop();
  for (const entry of before.environments) if (!next.environments.some(kept => kept.id === entry.id)) workspaceReconnect.forget(entry.id);
  environmentsStore.write(next);
  environmentsState = next;
  refreshApplicationMenu();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(workspaceWindowTitle(environmentsState, desktopRemoteAccess, homeWindow.cloudOrigin()));
  try { railChanged(); } catch {}
}

const workspaceReconnect = createWorkspaceReconnect({ fetch: (...args) => session.defaultSession.fetch(...args), store: jsonFile(path.join(app.getPath("userData"), "workspace-frames.json")),
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null), localOrigin: rendererOrigin, localReady: () => serverReady,
  active: () => activeRemote(environmentsState), keeps: entry => handSaved(entry),
  places: () => [{ id: LOCAL_ID, name: "This computer", local: true }, ...environmentsState.environments.map(entry => ({ id: entry.id, name: entry.name }))],
  choose: id => workspaceMenuAction(() => switchEnvironment(id)), remove: id => workspaceMenuAction(() => forgetEnvironment(id)), log: slog,
  publish: view => { if (mainWindow && !mainWindow.isDestroyed() && senderIsLocal({ sender: mainWindow.webContents })) mainWindow.webContents.send("workspace-reconnect:changed", view); } });
installWorkspaceReconnectIpc({ ipcMain, reconnect: workspaceReconnect });

// the action's own answer, or false once it threw and the error was shown
async function workspaceMenuAction(action) {
  try { return await action(); } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Could not update servers", detail: error.message });
    return false;
  }
}

/** From now on the page at `url`'s origin, when it is a place, is this app's own. */
function servePlaceFrom(url) {
  const origin = originOf(url);
  if (origin && origin !== rendererOrigin()) visitedPlaces.add(origin);
  return localUi ? localUi.refresh() : Promise.resolve();
}

const mainWindowAlive = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
const workspaceSwitch = createWorkspaceSwitch({ window: mainWindowAlive, log: slog });
installWorkspaceSwitchIpc({ ipcMain, workspaceSwitch, window: mainWindowAlive });

function navigateMainWindow(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  return servePlaceFrom(url).then(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.loadURL(url).then(() => true, () => false) : false));
}

/** A page at this computer's address while its server isn't up: whatever else answers there (another install on the
 * same port) or nothing at all would stand in for it. */
function localPageNeedsServer(url) {
  if (!app.isPackaged || desktopRemoteAccess || serverReady) return false;
  try { return new URL(url).origin === rendererOrigin(); } catch { return false; }
}

/** Opens a page of this computer once its server answers (the port it lands on may differ), else the failure page. */
async function openLocalPageWhenServed(url) {
  const { pathname, search, hash } = new URL(url);
  const starting = localRuntimeStarting ?? serverRestarting;
  if (starting) await Promise.resolve(starting).catch(() => {});
  if (serverReady) return navigateMainWindow(`${rendererOrigin()}${pathname}${search}${hash}`);
  const win = mainWindowAlive();
  if (win && !win.webContents.getURL().startsWith("data:")) serverFailurePage(win);
  return false;
}

let rememberedHome = null;

function acquireDataDirLeaseFor(dir) {
  return dir === desktopDataDir()
    ? acquireDataDirLease(dir, { legacyDataDir: path.join(app.getPath("home"), ".opengrokbot") })
    : acquireDataDirLease(dir);
}

/** Pause the supervisor first, or its recovery forks on the wrong data dir; resume() stays in the finally. */
async function switchLocalEnvironmentTo(targetDir, targetId, quiet = false, { stay = false } = {}) {
  if (!app.isPackaged) return { ok: false, error: "dev" };
  // A second switch would be un-paused by the first's finally mid-handoff.
  if (localSwitchInFlight) return { ok: false, error: "busy" };
  const previousDir = runningDataDir ?? startupEnvironmentDir(environmentsState, desktopDataDir());
  let startedProc = null;
  let switchSucceeded = false;
  const failedSwitch = () => {
    if (!quiet) dialog.showErrorBox(
      "Could not switch environments",
      "Metal could not switch to that environment. The app log has the details.",
    );
    return { ok: false, error: "switch-failed" };
  };
  localSwitchInFlight = true;
  serverSupervisor.pause();
  try {
    const result = await switchLocalEnvironment({
      targetDir,
      targetId,
      port: SERVER_PORT,
      deps: {
        stopChild: async () => {
          // A child that will not die still writes to its folder: abort with the lease still held.
          const proc = serverProc;
          if (proc && !(await stopUtilityServer(proc))) throw new Error("the server child did not stop");
        },
        releaseLease: async () => {
          desktopDataDirLease?.release();
          desktopDataDirLease = null;
        },
        acquireLease: async (dir) => {
          desktopDataDirLease = acquireDataDirLeaseFor(dir);
          runningDataDir = dir;
        },
        createDir: async (dir) => {
          await fs.promises.mkdir(dir, { recursive: true });
        },
        startChild: async (port) => {
          const started = await startServerOn(port, targetDir);
          if (!started.proc) return null;
          startedProc = started.proc;
          serverSupervisor.ready(started.proc);
          return started.proc;
        },
        probeReady: async () => "ready",
        rollback: async () => {
          if (startedProc) await stopUtilityServer(startedProc);
          try {
            desktopDataDirLease?.release();
          } catch (error) {
            slog(`switch rollback lease release failed: ${error?.message ?? error}`);
          }
          desktopDataDirLease = null;
          desktopDataDirLease = acquireDataDirLeaseFor(previousDir);
          runningDataDir = previousDir;
          const restored = await startServerOn(SERVER_PORT, previousDir);
          // startServerOn only watches; without ready() the rolled-back child has no owner.
          if (restored.proc) serverSupervisor.ready(restored.proc);
          else {
            const error = new Error(`could not restart the server on ${previousDir}`);
            slog(`switch rollback ${error.message}`);
            throw error;
          }
        },
        persistActive: (id) => { if (!stay) persistEnvironments(withActive(environmentsState, id), "chosen"); },
        log: slog,
      },
    });
    if (!result.ok) {
      slog(`environment switch to ${targetDir} failed (${result.error})`);
      return failedSwitch();
    }
    switchSucceeded = true;
    if (!stay) await navigateMainWindow(rendererOrigin());
    return { ok: true };
  } catch (error) {
    slog(`environment switch to ${targetDir} failed (${error?.message ?? error})`);
    return failedSwitch();
  } finally {
    localSwitchInFlight = false;
    serverSupervisor.resume();
    if (!switchSucceeded && (!serverProc || !serverSupervisor.isCurrent(serverProc))) {
      slog(`environment switch to ${targetDir} left no server child; restarting the active environment`);
      try {
        const revived = await startServerOn(SERVER_PORT);
        if (revived.proc) serverSupervisor.ready(revived.proc);
        else slog(`could not restart the server after the failed environment switch`);
      } catch (error) {
        slog(`restart after failed environment switch threw (${error?.message ?? error})`);
      }
    }
  }
}

const placesChosen = placesChosenStore(jsonFile(path.join(app.getPath("userData"), "places-chosen.json")));

async function switchEnvironment(id) {
  if ((id === environmentsState.activeId && !homeWindow.asking()) || (id !== LOCAL_ID && !environmentsState.environments.some((entry) => entry.id === id))) return;
  return workspaceSwitch.around(() => switchEnvironmentNow(id));
}

async function switchEnvironmentNow(id) {
  placesChosen.choose();
  const entry = environmentsState.environments.find((candidate) => candidate.id === id);
  if (localRuntimeStarting && (id === LOCAL_ID || entry?.kind === "local")) await waitForLocalStartup(localRuntimeStarting);
  if (entry?.team || entry?.cloud) return void await showHome({ place: entry.team ? { team: entry.team.id, name: entry.name } : { cloud: entry.cloud.id, name: entry.name } });
  homePlaces.remember(null);
  if (entry?.kind === "local") return await switchLocalEnvironmentTo(entry.dataDir, entry.id);
  if (id === LOCAL_ID && (runningDataDir ?? desktopDataDir()) !== desktopDataDir() && !cleanWorkspace.active()) {
    return await switchLocalEnvironmentTo(desktopDataDir(), LOCAL_ID);
  }
  if (entry && entry.origin === homeWindow.cloudOrigin()) return void await showHome({ place: "cloud" });
  if (entry && cloudAccount && isCloudHomeEntry(entry, { homeOrigin: cloudAccount.homeTarget()?.origin ?? cloudAccount.state().machine?.origin, remembered: rememberedHome })) {
    try { await connectCloudHome(); return; } catch (error) {
      slog(`cloud home: could not connect from the Server menu (${error?.message ?? error})`);
      if (!(await cloudHomeSignedIn(entry.origin))) { await openCloudSettings(); return; }
    }
  }
  if (entry && handSaved(entry) && !(await serverOpens(entry, { fetch: (...args) => session.defaultSession.fetch(...args), dialog, forget: (gone) => forgetEnvironment(gone, false, true) }))) return false;
  persistEnvironments(withActive(environmentsState, id), "chosen"); return navigateMainWindow(activeOrigin());
}

function createLocalEnvironment(name, dataDir) {
  if (!app.isPackaged) return { ok: false, error: "dev", state: environmentsState };
  const state = environmentsState;
  let candidateDir;
  if (dataDir === undefined || dataDir === null || dataDir === "") {
    const slug = typeof name === "string"
      ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      : "";
    if (typeof name !== "string" || !name.trim()) return { ok: false, error: "name", state };
    candidateDir = path.join(os.homedir(), `.duskbot-${slug && slug !== "clean" ? slug : randomUUID().slice(0, 8)}`);
  } else {
    candidateDir = typeof dataDir === "string" ? dataDir.trim() : "";
    if (
      !candidateDir
      || candidateDir.split("/").some((segment) => segment === "." || segment === "..")
      || candidateDir !== path.normalize(candidateDir)
    ) {
      return { ok: false, error: "path", state };
    }
  }
  const result = withLocalEnvironment(state, { name, dataDir: candidateDir }, randomUUID, desktopDataDir());
  if (!result.ok) return { ok: false, error: result.error, state };
  persistEnvironments(result.state);
  return { ok: true, state: environmentsState };
}

const organizationEntry = createOrganizationEntry({
  readState: () => ({ environments: environmentsState, remoteAccess: desktopRemoteAccess,
    restartIntent: organizationRestartIntent(secureCredentialState?.read() ?? secureCredentials) }),
  confirm: async ({ kind, name, origin }) => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: [kind === "companion" ? "Disconnect and restart locally" : "Use this computer", "Cancel"],
      defaultId: 1, cancelId: 1,
      message: kind === "companion" ? `Disconnect from ${name} to sign in locally?` : `Leave ${name} and sign in on this computer?`,
      detail: `${origin}\n\nOrganization sign-in connects company models to this computer. ${kind === "companion" ? "This disconnects desktop companion access and restarts the app. You can pair again later." : "The hosted connection stays saved and can be selected again from the Server menu."} No remote bots, conversations or provider accounts are moved or deleted.`,
    });
    return response === 0;
  },
  saveEnvironments: next => persistEnvironments(next, "chosen"),
  disconnectAndRemember: async expected => {
    await updateSecureCredentialDocument(credentials => {
      const current = desktopCompanionAccess(credentials);
      if (!current || current.endpoint !== expected.endpoint || current.deviceId !== expected.deviceId || current.token !== expected.token) {
        throw new Error("The companion connection changed. Choose organization sign-in again.");
      }
      return withOrganizationRestartIntent(credentials);
    });
    desktopRemoteAccess = null;
  },
  clearRestartIntent: () => updateSecureCredentialDocument(credentials =>
    organizationRestartIntent(credentials) && !desktopCompanionAccess(credentials)
      ? withoutOrganizationRestartIntent(credentials) : credentials),
  openLocalSettings: async () => {
    if (!app.isPackaged) throw new Error("Organization sign-in requires the installed desktop app.");
    if (!serverReady) throw new Error("This installation is unavailable. Restart the app and try organization sign-in again.");
    if (desktopRemoteAccess || activeRemote(environmentsState)) throw new Error("Choose this computer before signing in with your organization.");
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: true });
    if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) {
      win.webContents.send("app:open-settings", "organization");
    } else {
      await win.loadURL(`${rendererOrigin()}/?desktop-settings=organization`);
    }
  },
  relaunch: relaunchAfterDesktopRemoteChange,
});

function queueOrganizationEntry(link) {
  if (!isOrganizationDeepLink(link)) return false;
  pendingOrganizationEntry = true;
  if (!desktopTray?.show()) activateExistingWindow(appWindows());
  void deliverOrganizationEntry();
  return true;
}

async function deliverOrganizationEntry() {
  if (!organizationEntryReady || !pendingOrganizationEntry) return false;
  pendingOrganizationEntry = false;
  let delivered = false;
  await workspaceMenuAction(async () => { delivered = await organizationEntry.request(); });
  return delivered;
}

async function openCloudEntry() {
  if (!app.isPackaged && !cloudTarget(process.env).custom) throw new Error("dusk cloud requires the installed desktop app.");
  if (desktopRemoteAccess) throw new Error("This app is connected to another computer. Disconnect it to use dusk cloud on this computer.");
  if (!serverReady) throw new Error("This installation is unavailable. Restart the app and open My Cloud again.");
  await cloudAccountRestored();
  if ((await homeWindow.refresh()).kind !== "computer") { await showHome({ place: "cloud" }); void welcomedOnCloud(); return true; }
  const active = activeRemote(environmentsState);
  const showingCloud = Boolean(active) && active.origin === cloudAccount?.homeTarget()?.origin;
  if (active && !showingCloud) persistEnvironments(withActive(environmentsState, LOCAL_ID), "chosen");
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: !showingCloud });
  if (showingCloud) return true;
  // a plan bought on the website a moment ago: the account is read first, so its sheet opens (over the first run too)
  if (cloudAccount && !cloudLinkOpensSheet(cloudAccount.state())) await Promise.race([cloudAccount.refresh().catch(() => {}), new Promise(done => setTimeout(done, 5_000))]);
  else void cloudAccount?.refresh().catch(() => {});
  const action = cloudLinkOpensSheet(cloudAccount?.state()) ? "cloud-add" : "cloud";
  if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) {
    win.webContents.send("app:open-settings", action);
  } else {
    await win.loadURL(`${rendererOrigin()}/?desktop-settings=${action}`);
  }
  return true;
}

function openWorkspaceSettings(computerId) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const id = typeof computerId === "string" ? computerId : null;
  if (senderIsLocal({ sender: mainWindow.webContents })) {
    mainWindow.webContents.send("workspaces:open-settings", id);
  } else {
    persistEnvironments(withActive(environmentsState, LOCAL_ID), "chosen");
    navigateMainWindow(`${rendererOrigin()}/?desktop-settings=workspaces${id ? `&share-computer=${encodeURIComponent(id)}` : ""}`);
  }
}

async function addServerFromClipboard() {
  try {
    return await connectHostedWorkspace(clipboard.readText());
  } catch (error) {
    await dialog.showMessageBox({ type: "info", message: "Could not connect to the server", detail: `${error.message}\nYou can also choose Connect to a server… to enter an address in Settings.` });
    return false;
  }
}

async function connectHostedWorkspace(input, name) {
  const link = parseHostedWorkspaceLink(input);
  if (!link) {
    throw new Error("Enter an HTTPS server address or a full pairing link. Keep the pairing code after #, not in the URL query.");
  }
  if (isThisAppsServer(link.origin, SERVER_PORT)) {
    throw new Error("That link is this computer's own Metal; on your computer run ssh -N -L 8790:127.0.0.1:8799 you@your-server, then paste http://127.0.0.1:8790 with the code.");
  }
  const host = new URL(link.origin).host;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Connect", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Connect to ${host}?`,
    detail: link.code
      ? "The pairing code in the link is used once, then this app stays signed in to that server."
      : "The link has no pairing code; the server will ask for one.",
  });
  if (response !== 0) return false;
  // a server that has never answered is not switched to: it stays where the person is, or isn't saved at all
  const reach = await newServerReach(link, { fetch: (...args) => session.defaultSession.fetch(...args), dialog });
  if (reach === "cancel") return false;
  let next = withEnvironment(environmentsState, { origin: link.origin, name }, () => randomUUID());
  const added = next.environments.find((e) => e.origin === link.origin);
  if (reach === "keep") { persistEnvironments(next); return true; }
  next = withActive(next, added.id);
  persistEnvironments(next, "joined");
  navigateMainWindow(link.url);
  return true;
}

/** My Cloud, and each team's Cloud the session lists (home-places.mjs), under Servers. */
function rememberCloudHome(state) {
  try {
    const next = withCloudHome(withoutOldCloudHome(environmentsState, state), state?.status === "connected" ? state.machine : null, () => randomUUID(), cloudLook.pending() ?? homeLook(state));
    if (next !== environmentsState) persistEnvironments(next);
    homePlaces.sync(state);
  } catch (error) {
    slog(`cloud home: could not list the Cloud machine under Servers (${error?.message ?? error})`);
  }
}

/** My Cloud through the home window, which never looks it up before the Admin says it is ready. */
async function connectCloudHome(open = null) {
  const client = ensureCloudAccount();
  await homeWindow.openCloud(open);
  void welcomedOnCloud();
  return client.state();
}
/** A new cloud's first run starts from what this computer knows. Once the window shows the cloud (a new one can take
 * minutes to load the first time), its own session carries it once. */
/** A still picture of the window's page over the window, until the page it loads next has drawn (paint-hold.mjs). */
function holdMainWindowPaint(load) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) return Promise.resolve(load()).then(() => true, () => false);
  return holdUntilPainted({
    load,
    painted: () => (win.isDestroyed() ? Promise.resolve(false) : win.webContents.executeJavaScript(PAINTED_SCRIPT, true).then(Boolean, () => false)),
    cover: async () => {
      const image = await win.webContents.capturePage();
      if (image.isEmpty() || win.isDestroyed()) return null;
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
      const { width, height } = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
      const fit = () => { if (!win.isDestroyed()) { const size = win.getContentBounds(); view.setBounds({ x: 0, y: 0, width: size.width, height: size.height }); } };
      win.on("resize", fit);
      await view.webContents.loadURL(`data:text/html,${encodeURIComponent(`<html style="margin:0;height:100%;background:url(data:image/jpeg;base64,${image.toJPEG(90).toString("base64")}) 0 0/100% 100% no-repeat"></html>`)}`);
      if (win.isDestroyed()) { view.webContents.close(); return null; }
      win.contentView.addChildView(view);
      return () => {
        win.removeListener("resize", fit);
        if (!win.isDestroyed()) win.contentView.removeChildView(view);
        view.webContents.close();
      };
    },
  });
}

const welcomedClouds = new Set();
const CARRY_BEFORE_OPEN_MS = 8_000;
/** Before the window first loads My Cloud (its session already in the window's cookie): what this computer knows goes
 * there first, so the page's first config read already holds CLOUD_FROM_COMPUTER and opens straight onto the first run. */
async function welcomeBeforeOpen(origin) {
  if (!origin || desktopRemoteAccess || welcomedClouds.has(origin)) return;
  welcomedClouds.add(origin);
  const carried = carryWelcomeToCloud({ origin, fetch: (...args) => session.defaultSession.fetch(...args), localRequest: localServerRequest, handoff: what => oneHome.handoff(what), log: slog })
    .then((changed) => { slog(`cloud welcome: ${changed ? "carried from this computer before it opened" : "nothing to carry"}`); return true; }, () => false);
  const done = await Promise.race([carried, new Promise(resolve => setTimeout(() => resolve(false), CARRY_BEFORE_OPEN_MS))]);
  if (!done) welcomedClouds.delete(origin);
}
async function welcomedOnCloud() {
  const origin = homeWindow.cloudOrigin() ?? cloudAccount?.homeTarget()?.origin ?? null;
  if (!origin || desktopRemoteAccess || welcomedClouds.has(origin)) return;
  welcomedClouds.add(origin);
  const showsCloud = () => { try { return Boolean(mainWindow && !mainWindow.isDestroyed()) && new URL(mainWindow.webContents.getURL()).origin === origin; } catch { return false; } };
  for (let waited = 0; !showsCloud(); waited += 3_000) {
    if (waited >= 6 * 60_000) { welcomedClouds.delete(origin); return; }
    await new Promise(done => setTimeout(done, 3_000));
  }
  const changed = await carryWelcomeToCloud({ origin, fetch: (...args) => session.defaultSession.fetch(...args), localRequest: localServerRequest, handoff: what => oneHome.handoff(what), log: slog });
  slog(`cloud welcome: ${changed ? "carried from this computer" : "nothing to carry"}`);
  if (!changed || !showsCloud()) return;
  // a page from an older cloud still showing its own welcome
  const still = await mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector("[data-welcome-action]"))`).catch(() => false);
  if (still && showsCloud()) mainWindow.webContents.reload();
}

/** My Cloud listed under Servers once, and the server this window shows: the purchase that made it is over. */
function activateCloud(origin) {
  const next = withCloudHome(environmentsState, { status: "ready", origin }, () => randomUUID(), cloudLook.pending());
  const entry = next.environments.find((candidate) => candidate.origin === origin);
  if (!entry) throw new Error("My Cloud could not be added to Servers.");
  persistEnvironments(withActive(next, entry.id), "joined"); cloudAccount?.checkoutDone();
}
/** A team's or another own Cloud listed under Servers as the Admin names it (never a page), and the server this window shows. */
function activatePlace(place) {
  const next = place.kind === "own" ? withOwnCloud(environmentsState, { ...place, role: place.role ?? "owner", color: undefined }, () => randomUUID()) : withTeam(environmentsState, place, () => randomUUID());
  const entry = next.environments.find((candidate) => candidate.origin === place.origin);
  if (!entry) throw new Error(`${place.name} could not be added to Servers.`);
  persistEnvironments(withActive(next, entry.id), "joined");
}

async function cloudHomeSignedIn(origin, timeoutMs = 5_000) {
  try {
    const response = await session.defaultSession.fetch(`${origin}/api/auth/session`, { credentials: "include", signal: AbortSignal.timeout(timeoutMs) });
    return response.ok && (await response.json())?.kind === "session";
  } catch { return false; }
}

// Per-server microphone consent; "Don't Allow" holds until quit or forget, so a page cannot keep re-asking.
const remoteMicrophoneAsks = new Map();
const remoteMicrophoneRefused = new Set();
function askRemoteMicrophone(origin) {
  const env = activeEnvironment(environmentsState);
  if (!env || env.origin !== origin || env.microphone === true || remoteMicrophoneRefused.has(origin)) return null;
  if (!remoteMicrophoneAsks.has(origin)) {
    const ask = (async () => {
      const options = {
        type: "question",
        buttons: ["Allow", "Don’t allow"],
        defaultId: 1,
        cancelId: 1,
        message: `Allow “${env.name}” to use the microphone?`,
        detail: `${new URL(origin).host} wants to hear you for a Live call. Allow only a server you trust; this app remembers your answer for this server until you forget it.`,
      };
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (response !== 0) return void remoteMicrophoneRefused.add(origin);
      if (environmentsState.environments.some((e) => e.id === env.id && e.origin === origin)) persistEnvironments(withMicrophone(environmentsState, env.id));
    })().finally(() => remoteMicrophoneAsks.delete(origin));
    remoteMicrophoneAsks.set(origin, ask);
  }
  return remoteMicrophoneAsks.get(origin);
}

async function forgetEnvironment(id, purge = false, confirmed = false, { unlink = true, quiet = false } = {}) {
  const env = environmentsState.environments.find((e) => e.id === id);
  if (!env) return;
  if (env.kind === "local" && environmentsState.activeId === id) return { ok: false, error: "active" };
  if (env.kind !== "local" && !confirmed) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Forget", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Forget “${env.name}”?`,
      detail: "This app signs out of that server. The server keeps its own session list; revoke it there too if the device is gone.",
    });
    if (response !== 0) return;
  }
  remoteMicrophoneRefused.delete(env.origin);
  // a server that joined the account dashboard leaves it, while this app's session there still works (not a server
  // linked again under a new saved place: that is the same server, staying)
  const leaving = unlink && env.kind !== "local" && serverEnroll ? serverEnroll.forget(id).catch(error => slog(`forget server: dashboard unlink failed (${error?.message ?? error})`)) : null;
  const wasActive = environmentsState.activeId === id;
  if (purge === true && env.kind === "local") {
    // Never rm -rf "This computer"'s dir; the entry stays until the delete has actually happened.
    if (localSwitchInFlight) return { ok: false, error: "busy" };
    const resolved = path.resolve(env.dataDir);
    const root = path.resolve(desktopDataDir());
    // realpath, so a symlink named like a data dir cannot fool the guard.
    const canonical = (dir) => { try { return fs.realpathSync(dir); } catch { return dir; } };
    const resolvedCanon = canonical(resolved);
    const rootCanon = canonical(root);
    if (runningDataDir && canonical(runningDataDir) === resolvedCanon) return { ok: false, error: "active" };
    if (DATA_DIR_NAMES.some(name => path.basename(resolved).startsWith(name)) && resolvedCanon !== rootCanon && !resolvedCanon.startsWith(rootCanon + path.sep)) {
      try {
        await fs.promises.rm(resolved, { recursive: true, force: true });
      } catch (error) {
        slog(`forget environment: purge failed (${error?.message ?? error})`);
        return { ok: false, error: "purge" };
      }
    } else {
      slog(`forget environment: purge skipped for ${env.dataDir}`);
    }
  }
  persistEnvironments(withoutEnvironment(environmentsState, id));
  if (wasActive) navigateMainWindow(activeOrigin());
  if (leaving) await Promise.race([leaving, new Promise(resolve => setTimeout(resolve, 6_000))]);
  if (!env.origin) return { ok: true };
  // quiet: start fresh deleted that server's data, its sessions with it, so there is nothing to sign out of or warn about
  if (!quiet) try {
    // Revoke the session on the server while the cookie is still here.
    const response = await session.defaultSession.fetch(`${env.origin}/api/auth/logout`, { method: "POST", credentials: "include", headers: { origin: env.origin }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    slog(`forget server: logout skipped (${error?.message ?? error})`);
    await dialog.showMessageBox({ type: "warning", message: "Connection forgotten; server sign-out could not be confirmed", detail: "Revoke this desktop’s session on that server when it is reachable again." });
  }
  try {
    // Not cookies: Chromium's cookie storage is host-wide, not port-scoped, so other saved servers would sign out.
    await session.defaultSession.clearStorageData({ origin: env.origin, storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage"] });
  } catch (error) {
    slog(`forget server: storage clear failed: ${error?.message ?? error}`);
  }
  return { ok: true };
}

function showContextMenu(win, params) {
  if (!params.isEditable && !params.linkURL && !params.misspelledWord && !params.selectionText) return;
  const menuItems = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      menuItems.push({
        label: suggestion,
        click: () => win.webContents.replaceMisspelling(suggestion),
      });
    }
    if (menuItems.length) menuItems.push({ type: "separator" });
  }
  if (params.linkURL) {
    menuItems.push(
      { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
  }
  menuItems.push(
    { label: "Undo", role: "undo", enabled: params.editFlags.canUndo },
    { label: "Redo", role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
    { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
    pasteMenuItem(params, clipboard, win.webContents),
    { label: "Paste and match style", role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
    { type: "separator" },
    { label: "Select all", role: "selectAll", enabled: params.editFlags.canSelectAll },
  );
  Menu.buildFromTemplate(menuItems).popup({ window: win, frame: params.frame });
}

const windowsWithoutPage = new WeakSet();
function createWindow({ deferNavigation = false } = {}) {
  const waitsForSkinSync = process.platform === "win32";
  const primary = screen.getPrimaryDisplay();
  const displays = [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
  const restored = resolveWindowState(windowStateFile.read(), displays.map((display) => display.workArea));
  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    show: !waitsForSkinSync && !startupScreen,
    icon: APP_ICON,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: process.platform !== "darwin",
    ...windowChromeOptions(process.platform, windowFrameMade = desktopPrefs?.windowFrame() ?? FRAME_BY_DEFAULT),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [...desktopCompanionRendererArguments(rendererOrigin(), desktopRemoteAccess),
        "--dusk-current-local-origin=1",
        ...(accountApp() ? ["--dusk-company-desktop=1"] : []), ...(accountApp() || accountGateNeeded() ? ["--dusk-account-gate=1"] : []), `--dusk-app-version=${app.getVersion()}`],
    },
  });
  mainWindow = win; hiddenStart = false; chromeRail.attach(win);
  // a place's page never waits long on this: without it the server's own page shows, as before
  const localUiReady = Promise.race([localUi?.attach(win.webContents), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())]);
  startupTrace.mark("window");
  win.webContents.once("did-finish-load", () => startupTrace.mark("loaded"));
  win.once("show", () => startupTrace.finish("shown"));
  win.on("show", () => desktopTray?.windowShown(win));
  win.on("focus", () => { if (cloudAccount?.checkoutPending()) void cloudAccount.refresh().catch(() => {}); });
  win.on("close", (event) => {
    if (process.platform === "win32" && !desktopShutdownStarted && desktopTray) {
      event.preventDefault();
      desktopTray.hide(win);
    }
  });
  const title = () => workspaceWindowTitle(environmentsState, desktopRemoteAccess, homeWindow.cloudOrigin());
  win.setTitle(title());
  win.webContents.on("page-title-updated", event => {
    if (!desktopRemoteAccess && !activeEnvironment(environmentsState)) return;
    event.preventDefault();
    win.setTitle(title());
  });
  if (startupScreen) startupScreen.attach(win, { maximized: restored.maximized });
  else if (waitsForSkinSync) {
    const skinSyncFallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 5_000);
    skinSyncFallback.unref?.();
    const clearSkinSyncFallback = () => clearTimeout(skinSyncFallback);
    win.once("show", clearSkinSyncFallback);
    win.once("closed", clearSkinSyncFallback);
  }
  windowStateFile.install(win);
  applyUnreadBadge(win);
  if (restored.maximized && !startupScreen) win.maximize();
  win.once("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(externalLinkUrl(url)).catch(() => {
        console.warn("The external web link could not be opened");
      });
    } catch {
    }
    return { action: "deny" };
  });
  const guardNavigation = (event, url) => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {}
    // only this app's own data: page carries these buttons; a page at any server's origin can't reach them
    const action = serverPageAction(url);
    if (action) {
      event.preventDefault();
      if (win.webContents.getURL().startsWith("data:")) runServerPageAction(action, win);
      return;
    }
    if (workspaceNavigationAllowed(url, environmentsState, rendererOrigin())) return;
    event.preventDefault();
    slog(`blocked navigation to ${origin ?? "an invalid address"}`);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("render-process-gone", (_event, details) => {
    if (!RENDERER_CRASHES.has(details?.reason) || win.isDestroyed()) return;
    const shown = win.webContents.getURL();
    if (shown.startsWith("data:")) return;
    slog(`main window page ${details.reason}; showing the reopen page`);
    void win.loadURL(windowCrashedPage(shown || rendererOrigin())).catch(() => {});
  });
  win.webContents.on("will-redirect", guardNavigation);
  // No page may embed the local server, or any saved server, in this preload-bearing window.
  win.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    if (!appFrameNavigationAllowed(details)) return void details.preventDefault();
    let target = null;
    let page = null;
    try {
      target = new URL(details.url).origin;
      page = new URL(win.webContents.getURL()).origin;
    } catch {}
    if (!target || !page || target === page) return;
    if (target === rendererOrigin() || allowedOrigins(environmentsState, rendererOrigin()).has(target)) {
      details.preventDefault();
      slog(`blocked subframe navigation to ${details.url}`);
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3: aborted by a newer navigation
    const remote = activeRemote(environmentsState);
    if (!remote) return;
    let origin = null;
    try {
      origin = new URL(validatedURL).origin;
    } catch {}
    if (origin !== remote.origin) return;
    if (homeWindow.failed(validatedURL, errorCode)) return;
    slog(`remote server unreachable (${errorDescription}); it stays chosen while it is looked at again`);
    workspaceReconnect.lost(remote);
  });
  win.webContents.on("did-navigate", (_event, url, code) => {
    homeWindow.navigated(url);
    const remote = activeRemote(environmentsState);
    let origin = null;
    try { origin = new URL(url).origin; } catch {}
    if (remote && proxyAnswersForDownServer(code) && origin === remote.origin) return void workspaceReconnect.lost(remote);
    workspaceReconnect.loaded(url);
  });
  // Not did-finish-load: Electron still reports the main frame as loading then.
  win.webContents.on("did-stop-loading", () => {
    deliverPackageInstall(win);
    deliverChatLink(win); slackOAuthLinks.deliver(); desktopNotifications.arrived();
  });

  // Electron has no default context menu.
  win.webContents.on("context-menu", (_event, params) => {
    showContextMenu(win, params);
  });

  if (process.env.DUSK_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.duskDesktop?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            let crashPromise = null;
            if (${JSON.stringify(process.env.DUSK_SMOKE_CUA === "1")}) {
              crashPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  unsubscribe?.();
                  reject(new Error("timed out waiting for CUA crash invalidation"));
                }, 10000);
                const unsubscribe = window.duskDesktop.onCapabilitiesChanged((next) => {
                  if (next.localComputer.reasonCode !== "daemon-exited") return;
                  clearTimeout(timeout);
                  unsubscribe();
                  resolve(next.localComputer.reasonCode);
                });
              });
            }
            const [initialCapabilities, healthResponse, ownerMutationResponse] = await Promise.all([
              window.duskDesktop.getCapabilities(),
              fetch("/api/health"),
              fetch("/api/auth/stream-ticket", { method: "POST" }),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            if (!ownerMutationResponse.ok) {
              throw new Error(
                \`desktop mutation capability failed: \${ownerMutationResponse.status} \${ownerMutationResponse.statusText}\`,
              );
            }
            let capabilities = initialCapabilities;
            let cuaCrashReason = null;
            let cuaRetryStatus = null;
            if (crashPromise) {
              if (!initialCapabilities.localComputer.available) {
                throw new Error("CUA was not ready before the simulated crash");
              }
              cuaCrashReason = await crashPromise;
              cuaRetryStatus = await window.duskDesktop.localControl.retry();
              capabilities = await window.duskDesktop.getCapabilities();
            }
            return {
              initialCapabilities,
              capabilities,
              cuaCrashReason,
              cuaRetryStatus,
              health,
              location: window.location.href,
              title: document.title,
            };
          })()
        `);
        const expectedLocation = `http://127.0.0.1:${SERVER_PORT}/`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        if (process.env.DUSK_SMOKE_BUNDLED_CUA === "1") {
          const connection = await cuaReady;
          const expectedDriver = path.join(
            process.resourcesPath,
            "cua-linux-x64",
            "cua-driver",
          );
          let exactBundledPath = false;
          try {
            exactBundledPath =
              Boolean(connection?.driver?.path) &&
              fs.realpathSync(connection.driver.path) === fs.realpathSync(expectedDriver);
          } catch {}
          result.cuaRuntime = {
            driverSource: connection?.driver?.source,
            exactBundledPath,
            appImagePrivateStage:
              Boolean(process.env.APPIMAGE) &&
              connection?.driver?.path !== expectedDriver &&
              path.basename(path.dirname(connection?.driver?.path ?? "")).startsWith(
                APPIMAGE_CUA_STAGE_PREFIX,
              ),
            driverPath: connection?.driver?.path,
            driverVersion: connection?.driver?.version,
            daemonPid: connection?.daemon?.pid,
            socketPath: connection?.daemon?.socketPath,
            pidFile: connection?.daemon?.socketPath
              ? path.join(path.dirname(connection.daemon.socketPath), "driver.pid")
              : undefined,
            mcpEnv: connection?.mcp?.env,
          };
        }
        result.hardwareAccelerationEnabled = app.isHardwareAccelerationEnabled();
        result.displayMediaRequests = displayMediaRequestCount;
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        if (process.env.DUSK_SMOKE_KEEP_OPEN !== "1") win.close();
      }
    });
  }

  const remote = activeRemote(environmentsState);
  if (!serverReady && (desktopRemoteAccess || (app.isPackaged && !remote))) serverUnavailableWindows.add(win);
  if (deferNavigation) { windowsWithoutPage.add(win); return win; }
  if (desktopRemoteAccess) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ reason: serverFailure, logDir: LOG_DIR }));
  } else if (remote) {
    void localUiReady.then(() => win.loadURL(remote.origin)).catch(() => {});
  } else if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ reason: serverFailure, logDir: LOG_DIR }));
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

// From main so macOS attributes the Screen Recording prompt to the app, not the server.
ipcMain.handle("screen:frame", localOnly("screen:frame", async () => {
  if (process.platform !== "darwin" && process.platform !== "win32") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
}));

// Renderer-controlled text must never become a process argument: the user reviews and pastes it.
ipcMain.handle("engine:open-terminal", localOnly("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
}));

ipcMain.handle("clipboard:write-text", localOnly("clipboard:write-text", (_event, text) => writeClipboardText(clipboard, text)));

ipcMain.handle("desktop:pick-folder", localOnly("desktop:pick-folder", async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}));

// Secrets are never read, and the report is redacted again on the way out.
ipcMain.handle("desktop:export-diagnostics", localOrHome("desktop:export-diagnostics", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const report = await gatherDiagnostics();
  const result = await dialog.showSaveDialog(owner, {
    title: "Export diagnostics",
    defaultPath: diagnosticsFileName(),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  if (process.platform === "win32") {
    fs.writeFileSync(result.filePath, report, { mode: 0o600 });
  } else {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    const handle = fs.openSync(result.filePath, flags, 0o600);
    try {
      fs.fchmodSync(handle, 0o600);
      fs.writeFileSync(handle, report, "utf8");
    } finally {
      fs.closeSync(handle);
    }
  }
  return result.filePath;
}));

// The path is renderer-controlled: it must resolve inside ~/.duskbot to a regular file, never a symlink escape.
ipcMain.handle("desktop:save-file", localOnly("desktop:save-file", async (event, rawPath) => {
  return withSavableFile(rawPath, { home: os.homedir() }, async ({ defaultName, copyTo }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = await defaultSaveName(app.getPath("downloads"), defaultName);
    const choice = await dialog.showSaveDialog(parent ?? undefined, {
      title: "Where do you want to save it?",
      message: "Where do you want to save it?",
      defaultPath,
      buttonLabel: "Save",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (choice.canceled || !choice.filePath) return null;
    await copyTo(choice.filePath);
    shell.showItemInFolder(choice.filePath);
    return choice.filePath;
  });
}));
ipcMain.handle("desktop:reveal-file", localOnly("desktop:reveal-file", async (_event, rawPath) => {
  if (desktopRemoteAccess) throw new Error("That file is on the computer this app is connected to");
  return revealInFolder(rawPath, { reveal: (target) => shell.showItemInFolder(target) });
}));
ipcMain.handle("desktop:open-html", localOnly("desktop:open-html", (_event, source, name) => openHtmlCopy(source, name, { dir: path.join(app.getPath("userData"), "open-html"), open: (file) => shell.openPath(file) })));
ipcMain.handle("desktop:open-logs", localOrHome("desktop:open-logs", () => openLogsFolder(LOG_DIR, { open: (folder) => shell.openPath(folder) })));
const startupThemeFile = () => path.join(app.getPath("userData"), "startup-theme.json");
function readStartupTheme() {
  try { return JSON.parse(fs.readFileSync(startupThemeFile(), "utf8")); } catch { return null; }
}
let startupThemeSaved = null;
function rememberStartupTheme(light) {
  const next = JSON.stringify({ light, systemDark: nativeTheme.shouldUseDarkColors });
  if (next === startupThemeSaved) return;
  startupThemeSaved = next;
  fs.promises.writeFile(startupThemeFile(), next).catch(() => {});
}
// how long the last few launches took to load, so the opening card can pace its crew over that
const startupLoadsFile = () => path.join(app.getPath("userData"), "startup-loads.json");
function readStartupLoads() {
  try { return JSON.parse(fs.readFileSync(startupLoadsFile(), "utf8"))?.loads ?? []; } catch { return []; }
}
function rememberStartupLoad(ms) {
  fs.promises.writeFile(startupLoadsFile(), JSON.stringify({ loads: rememberLoad(readStartupLoads(), ms) })).catch(() => {});
}
ipcMain.handle("desktop:skin", (event, skin) => {
  if (!isKnownSkin(skin)) return false;
  if (chromeRail.owns(event)) return true;
  try {
    talk.skin(skin); const { color } = skinChrome(skin);
    if (mainWindow && event.sender === mainWindow.webContents) rememberStartupTheme(skinIsLight(skin));
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (win && !win.isDestroyed()) {
      try { win.setBackgroundColor(color); } catch {}
    }
    if (mainWindow && event.sender === mainWindow.webContents) chromeRail.send("rail:skin", skin);
  } catch {}
  return true;
});

for (const [channel, act] of [
  ["window:minimize", (win) => win.minimize()],
  ["window:toggle-maximize", (win) => (win.isMaximized() ? win.unmaximize() : win.maximize())],
  ["window:close", (win) => win.close()],
]) {
  ipcMain.handle(channel, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!win || win.isDestroyed()) return false;
    act(win);
    return true;
  });
}
// Grok Bot's way to make room for the bot's panel: the window grows to the right, or left where the screen ends.
ipcMain.handle("window:resize-width-by", (event, deltaWidth) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen() || !Number.isFinite(deltaWidth)) return 0;
  const zoom = win.webContents.getZoomFactor() || 1;
  const next = widenedBounds({ contentBounds: win.getContentBounds(), workArea: screen.getDisplayMatching(win.getBounds()).workArea,
    deltaWidth: Math.round(deltaWidth * zoom), minWidth: MIN_BOUNDS.width });
  if (next.applied !== 0) win.setContentBounds(next.contentBounds);
  return next.applied / zoom;
});
ipcMain.handle("window:state", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  return { maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()) };
});

ipcMain.handle("desktop:focus-window", localOnly("desktop:focus-window", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  win.focus();
  return true;
}));
// Links resolved after Chromium's click gesture ended would be blocked as popups via window.open.
ipcMain.handle("desktop:open-external", localOnly("desktop:open-external", async (_event, rawUrl) => {
  await shell.openExternal(externalLinkUrl(rawUrl));
  return true;
}));

// A provider's browser sign-in for a remote workspace returns here; the page relays it over the workspace link.
const authLoopbackRelay = createLoopbackRelay();
ipcMain.handle("auth-relay:open", localOnly("auth-relay:open", (_event, port, path) => authLoopbackRelay.open(Number(port), String(path ?? ""))));
ipcMain.handle("auth-relay:next", localOnly("auth-relay:next", (_event, port) => authLoopbackRelay.next(Number(port))));
ipcMain.handle("auth-relay:done", localOnly("auth-relay:done", (_event, port, result) => {
  authLoopbackRelay.done(Number(port), { ok: result?.ok === true, location: typeof result?.location === "string" ? result.location : null });
  return true;
}));
ipcMain.handle("auth-relay:close", localOnly("auth-relay:close", (_event, port) => { authLoopbackRelay.close(Number(port)); return true; }));
app.on("will-quit", () => authLoopbackRelay.closeAll());

ipcMain.handle("desktop-viewer:open", localOnly("desktop-viewer:open", (event, rawUrl, title, contextId) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return openDesktopViewer(owner, rawUrl, title, contextId);
}));

// URL validation, sandboxing, session isolation and the one-interactive-pane rule stay here, not in the renderer.
ipcMain.handle("desktop-workspace:open", localOnly("desktop-workspace:open", (event, input) =>
  desktopWorkspaceForEvent(event, true).open(input),
));
ipcMain.handle("desktop-workspace:layout", localOnly("desktop-workspace:layout", (event, items) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return false;
  return manager.layout(items);
}));
ipcMain.handle("desktop-workspace:set-interactive", localOnly("desktop-workspace:set-interactive", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return contextId == null;
  return manager.setInteractive(contextId);
}));
ipcMain.handle("desktop-workspace:close", localOnly("desktop-workspace:close", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return true;
  return manager.close(contextId);
}));

// Only the owner of the current viewer may close it.
ipcMain.handle("desktop-viewer:close", localOnly("desktop-viewer:close", (_event, contextId) => {
  const scoped = Object.prototype.toString.call(contextId) === "[object String]" ? contextId : null;
  if (scoped !== desktopViewerContextId) return false;
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) desktopViewerWindow.close();
  return true;
}));

ipcMain.handle("desktop-viewer:state-now", localOnly("desktop-viewer:state-now", () => ({
  open: Boolean(desktopViewerWindow && !desktopViewerWindow.isDestroyed()),
  contextId: desktopViewerContextId,
})));

// No Screen Recording request path: on macOS 15+ preflight caches per process, a helper is TCC-attributed
// to itself on macOS 26, and Sequoia re-prompts anyway. The first real in-process capture prompts correctly.
let appPermissions = null;
ipcMain.handle("perm:status", (event) => ({
  mic:
    nativeActions.appleMediaPermissions
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
  pageMic: appPermissions?.pageMicrophone(event) ?? "refused",
}));
ipcMain.handle("perm:request-mic", localOnly("perm:request-mic", () => askForMicrophone({ available: nativeActions.appleMediaPermissions, systemPreferences })));
const privacySettings = pane => openPrivacySettings(pane, { available: nativeActions.applePrivacySettings, openExternal: url => shell.openExternal(url) });
ipcMain.handle("perm:open-settings", localOnly("perm:open-settings", (_event, pane) => privacySettings(pane)));
installMacPermissions({ ipcMain, guard: localOnly, platform: process.platform, systemPreferences, desktopCapturer, openSettings: privacySettings, computerUse: () => import("./cua.mjs").then((cua) => cua.requestComputerUse()), log: (line) => console.error(`[mac-permissions] ${line}`) });

ipcMain.handle("desktop:relaunch", localOnly("desktop:relaunch", (event) => {
  requireMainWindowSender(event);
  relaunchAfterDesktopRemoteChange();
  return true;
}));

const talk = installTalk({ ipcMain, localOnly, localOrHome, BrowserWindow, appleSpeech: nativeActions.appleSpeech,
  speech: { start: startSpeech, stop: stopSpeech, finish: finishSpeech, busy: speechBusy }, packaged: app.isPackaged, devUrl: DEV_URL, nativeImage, iconPath: APP_ICON, openLink: queueChatLink, reveal: revealForLink, log: slog });
// voice input through a speech service set up in Settings > Voice; the keys stay in credentials.bin
installVoiceInput({ ipcMain, localOnly, readCredentials: () => secureCredentialState?.read() ?? secureCredentials,
  updateCredentials: derive => updateSecureCredentialDocument(derive), log: slog });
// the notch island and the bot dock (ambient-main.mjs), fed by the app page's own summary of its bots
const ambientSurfaces = installAmbient({ ipcMain, BrowserWindow, page: () => mainWindow?.webContents ?? null, origin: confirmedRendererOrigin, file: jsonFile(path.join(app.getPath("userData"), "ambient-prefs.json")),
  openChat: (botId, threadId, origin) => origin && desktopNotifications.openAt(origin, { botId, threadId }), reveal: revealForLink, log: slog,
  activity: { app, powerMonitor, focused: () => Boolean(BrowserWindow.getFocusedWindow()) } });
// ⌘Q waits for a hold while this computer's bots work, and the menu's Stop commands (desktop-bots.mjs)
installReloadKeys({ app, fromContents: contents => BrowserWindow.fromWebContents(contents) });
const desktopBots = installDesktopBots({ ipcMain, app, window: () => mainWindow, isLocal: contents => senderIsLocal({ sender: contents }) });

ipcMain.handle("companion:state", localOnly("companion:state", () => desktopCompanionState()));
function managedRemoteAccessRefusal() {
  const policy = managedDesktop?.policy?.();
  return policy?.remoteAccess === false ? `${policy.organizationName} does not allow remote access to this computer.` : null;
}
ipcMain.handle("companion:start", localOnly("companion:start", () => startDesktopCompanion()));
ipcMain.handle("companion:stop", localOnly("companion:stop", () => stopDesktopCompanion()));
ipcMain.handle("companion:keep-awake", localOnly("companion:keep-awake", async (_event, enabled) => {
  rememberCompanionKeepAwake(Boolean(enabled));
  return desktopCompanionState();
}));
ipcMain.handle("routines:wake-state", localOnly("routines:wake-state", () => routineWake.poll()));
ipcMain.handle("routines:keep-awake", localOnly("routines:keep-awake", async (_event, enabled) => {
  rememberRoutineWake(app.getPath("userData"), Boolean(enabled));
  return routineWake.poll();
}));
ipcMain.handle("companion:refresh-tailscale", localOnly("companion:refresh-tailscale", () => refreshDesktopCompanionTailscale()));
ipcMain.handle("companion:pairing", localOnly("companion:pairing", (_event, open, expectedToken) => {
  const refusal = open ? managedRemoteAccessRefusal() : null;
  if (refusal) throw new Error(refusal);
  return companionPairing(Boolean(open), expectedToken).then(decorateDesktopCompanionState);
}));
ipcMain.handle("companion:cloud-desktop", localOnly("companion:cloud-desktop", (_event, deviceId, allowed) =>
  companionCloudDesktopAccess(deviceId, Boolean(allowed)).then(() => desktopCompanionState()),
));
ipcMain.handle("companion:browser-control", localOnly("companion:browser-control", (_event, deviceId, allowed) =>
  companionBrowserControlAccess(deviceId, Boolean(allowed)).then(() => desktopCompanionState()),
));
ipcMain.handle("companion:revoke", localOnly("companion:revoke", (_event, deviceId) =>
  companionRevoke(deviceId).then(() => desktopCompanionState()),
));

function publicDesktopRemoteState() {
  return desktopRemoteAccess
    ? {
        active: true,
        endpoint: desktopRemoteAccess.endpoint,
        serverName: desktopRemoteAccess.serverName,
        deviceId: desktopRemoteAccess.deviceId,
      }
    : { active: false };
}

function requireMainWindowSender(event) {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed() ||
      !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("The desktop client window is unavailable");
  }
}

function relaunchAfterDesktopRemoteChange() {
  if (desktopShutdownStarted) return;
  desktopShutdownStarted = true;
  const timer = setTimeout(() => {
    // Electron's default relaunch reuses the native argv, which still holds the consumed one-shot action.
    const args = process.argv.slice(1);
    // pnpm dev:app owns Vite and this process; app.relaunch would orphan the new window, so ask the runner to restart it
    const devRunnerFile = app.isPackaged ? "" : process.env.DUSK_DEV_RELAUNCH_FILE;
    if (devRunnerFile) fs.writeFileSync(devRunnerFile, JSON.stringify(args));
    else app.relaunch({ args });
    app.quit();
  }, 250);
  timer.unref?.();
}

ipcMain.handle("desktop-remote:state", () => publicDesktopRemoteState());
ipcMain.handle("desktop-remote:pair", localOnly("desktop-remote:pair", async (event, endpoint, code) => {
  requireMainWindowSender(event);
  const access = await pairDesktopCompanion({
    endpoint,
    code,
    deviceName: `${installationDisplayName()} desktop`,
  });
  await updateSecureCredentialDocument((credentials) => withoutOrganizationRestartIntent(withDesktopCompanionAccess(credentials, access)));
  desktopRemoteAccess = access;
  relaunchAfterDesktopRemoteChange();
  return publicDesktopRemoteState();
}));
ipcMain.handle("desktop-remote:disconnect", localOnly("desktop-remote:disconnect", async (event) => {
  requireMainWindowSender(event);
  await updateSecureCredentialDocument(withoutDesktopCompanionAccess);
  desktopRemoteAccess = null;
  relaunchAfterDesktopRemoteChange();
  return { active: false };
}));

// Auth and connector credentials never cross this boundary.
ipcMain.handle("companion-account:state", localOnly("companion-account:state", () => ensureCompanionAccountService().state()));
ipcMain.handle("companion-account:request-code", localOnly("companion-account:request-code", (_event, email) =>
  ensureCompanionAccountService().requestCode(email),
));
ipcMain.handle("companion-account:verify-code", localOnly("companion-account:verify-code", (_event, email, code) =>
  ensureCompanionAccountService().verifyCode(email, code),
));
ipcMain.handle("companion-account:retry", localOnly("companion-account:retry", () => ensureCompanionAccountService().retry()));
ipcMain.handle("companion-account:prepare", localOnly("companion-account:prepare", () => {
  const refusal = managedRemoteAccessRefusal();
  if (refusal) throw new Error(refusal);
  return ensureCompanionAccountService().prepare();
}));
ipcMain.handle("companion-account:sign-out", localOnly("companion-account:sign-out", () => ensureCompanionAccountService().signOut()));

// "/home" and "/reconnect": this app's own screens (HOME_SCREEN_PATH, RECONNECT_PATH) while a place it can't show stays chosen.
const workspaceOnly = (handler) => (event, ...args) => {
  if (!workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, rendererOrigin(), ["/home", "/reconnect"])) throw new Error("These controls are only available in the main desktop window");
  return handler(event, ...args);
};
const localWorkspaceOnly = (channel, handler) => localOnly(channel, workspaceOnly(handler));
// No renderer-supplied address, token, paid flag or callback can choose an account or activate Pro.
for (const method of ["state", "begin", "signInAgain", "reopen", "cancel", "refresh", "signOut", "openDashboard", "offer"]) {
  ipcMain.handle(`cloud-account:${method}`, localWorkspaceOnly(`cloud-account:${method}`, () => (method === "signOut" ? accounts.signOutActive() : ensureCloudAccount()[method]())));
}
// an account step in the browser for its context (sign in, upgrade to a plan, billing): the intent is checked in the client
ipcMain.handle("cloud-account:continueInBrowser", localWorkspaceOnly("cloud-account:continueInBrowser", (_event, intent) => ensureCloudAccount().continueInBrowser(intent)));
// a page of the account website, opened signed in; the page is one of a fixed few and the address is built in main
ipcMain.handle("cloud-account:openPage", localWorkspaceOnly("cloud-account:openPage", async (_event, page, workspaceId) => {
  if (!ACCOUNT_PAGES.includes(page)) throw new Error("Unknown account page.");
  return ensureCloudAccount().webHandoff({ page, ...(page === "workspace" ? { workspaceId: String(workspaceId) } : {}) });
}));
ipcMain.handle("cloud-account:checkout", localWorkspaceOnly("cloud-account:checkout", async (_event, plan, source) => {
  if (!(await cloudOffersReady())) throw new Error("dusk cloud isn't offered in this app.");
  const client = ensureCloudAccount();
  if (typeof plan !== "string" || !CHECKOUT_SOURCES.includes(source)) throw new Error("Choose a plan to continue.");
  const offer = await client.offer();
  if (!offer?.plans.some(entry => entry.tier === plan)) throw new Error("Choose a plan to continue.");
  return client.checkout(plan, source);
}));
// The machine and its code come from the verified session in main, never from the renderer.
ipcMain.handle("cloud-account:connectHome", localWorkspaceOnly("cloud-account:connectHome", () => connectCloudHome()));
ipcMain.handle("cloud-account:connectHomeForPhone", localWorkspaceOnly("cloud-account:connectHomeForPhone", () => connectCloudHome("phone")));
// The page names a team only; the team and its Cloud come from the verified session, opened as the switcher opens it.
ipcMain.handle("cloud-account:openTeam", localWorkspaceOnly("cloud-account:openTeam", async (_event, teamId) => {
  const current = ensureCloudAccount().state();
  const team = current.status === "connected" ? current.teams?.find(entry => entry.id === teamId) ?? null : null;
  if (!team) throw new Error("You're not in that team.");
  await showHome({ place: { team: team.id, name: team.name } });
}));
// Cancel trial / Cancel plan and Keep my plan: the page sends the survey's words only; the Cloud is the verified session's own.
ipcMain.handle("cloud-account:cancelPlan", localWorkspaceOnly("cloud-account:cancelPlan", (_event, survey) => ensureCloudAccount().cancelPlan(survey)));
ipcMain.handle("cloud-account:keepPlan", localWorkspaceOnly("cloud-account:keepPlan", () => ensureCloudAccount().keepPlan()));
// this computer's CLI logins kept in a file, for the account's own Cloud being made; keychain logins (Claude Code among them) stay here
ipcMain.handle("cloud-account:holdSignIns", localWorkspaceOnly("cloud-account:holdSignIns", async () => ensureCloudAccount().holdSignIns(await localAiSignIns())));
ipcMain.handle("cloud-account:carriedAis", localWorkspaceOnly("cloud-account:carriedAis", async () => {
  const read = async (route) => { try { const response = await localServerRequest(route, { signal: AbortSignal.timeout(10_000) }); return response.ok ? await response.json() : null; } catch { return null; } };
  const [items, listed, connections] = await Promise.all([localAiSignIns(), read("/api/instances"), read("/api/cloud-connections")]);
  const keyEngines = (Array.isArray(connections?.connections) ? connections.connections : []).filter(item => item?.kind === "key" && Array.isArray(item.for)).flatMap(item => item.for);
  return { instanceIds: carriedEngines(listed?.instances, items.map(item => item.kind), keyEngines) };
}));
ipcMain.handle("organization:settings-opened", localWorkspaceOnly("organization:settings-opened", () => organizationEntry.settingsOpened()));
ipcMain.handle("organization:state", localWorkspaceOnly("organization:state", () => ensureManagedDesktop().state()));
ipcMain.handle("organization:begin", localWorkspaceOnly("organization:begin", (_event, input) => ensureManagedDesktop().begin(input)));
ipcMain.handle("organization:reopen", localWorkspaceOnly("organization:reopen", () => ensureManagedDesktop().reopen()));
ipcMain.handle("organization:cancel", localWorkspaceOnly("organization:cancel", () => ensureManagedDesktop().cancelEnrollment()));
ipcMain.handle("organization:refresh", localWorkspaceOnly("organization:refresh", () => ensureManagedDesktop().refresh()));
ipcMain.handle("organization:disconnect", localWorkspaceOnly("organization:disconnect", () => {
  companyBackupConfigurationRevision++;
  companyBackupController?.abort(); preparedCompanyRestore = null;
  const client = ensureManagedDesktop();
  return client.disconnect();
}));
ipcMain.on("company-backups:client-state", receiveCompanyBackupClientState);
ipcMain.handle("company-backups:configure-schedule", localWorkspaceOnly("company-backups:configure-schedule", async (_event, input) => {
  ensureManagedDesktop();
  const revision = ++companyBackupConfigurationRevision;
  if (input?.enabled === true) {
    const scope = companyBackupScope(), proc = serverProc;
    if (!scope || companyBackupController || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
    const status = await localBackupStatus(proc), current = companyBackupScope();
    if (revision !== companyBackupConfigurationRevision || status.busy || status.pendingRestore || !current || scope.key !== current.key || scope.generation !== current.generation ||
        companyBackupController || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
  }
  await companyBackupSchedule.configure(input);
  return { ...companyBackupState, schedule: companyBackupSchedule.state() };
}));
ipcMain.handle("company-backups:state", localWorkspaceOnly("company-backups:state", async () => {
  const status = await localBackupStatus(serverProc);
  return { ...companyBackupState, pendingRestore: status.pendingRestore };
}));
ipcMain.handle("company-backups:list", localWorkspaceOnly("company-backups:list", () => ensureManagedDesktop().requestBackup("/api/desktop/backups")));
ipcMain.handle("company-backups:create", localWorkspaceOnly("company-backups:create", (_event, input) => runCompanyBackup("backup", input)));
ipcMain.handle("company-backups:preview", localWorkspaceOnly("company-backups:preview", (_event, input) => runCompanyBackup("restore", input)));
ipcMain.handle("company-backups:cancel", localWorkspaceOnly("company-backups:cancel", () => { companyBackupController?.abort(); }));
ipcMain.handle("company-backups:delete", localWorkspaceOnly("company-backups:delete", (_event, input) => {
  if (companyBackupController || input?.confirmation !== "DELETE" || !/^[a-f0-9-]{36}$/.test(input?.id)) throw new Error("Confirm the exact backup to delete when no transfer is running.");
  return ensureManagedDesktop().requestBackup(`/api/desktop/backups/${input.id}`, { method: "DELETE" });
}));
ipcMain.handle("company-backups:restore", localWorkspaceOnly("company-backups:restore", async (_event, input) => {
  const client = ensureManagedDesktop(), connection = client.connection();
  if (companyBackupController || companyRestoreCommitting || !preparedCompanyRestore || preparedCompanyRestore.id !== input?.id || input?.confirmation !== "REPLACE" ||
      !connection || client.state().status !== "connected" || !client.state().cloudBackups || connection.expiresAt <= Date.now() ||
      preparedCompanyRestore.proc !== serverProc || preparedCompanyRestore.deviceId !== connection.deviceId) throw new Error("Preview this backup again and type REPLACE to confirm.");
  // Consume the preview before yielding, so duplicate IPC cannot commit it twice.
  preparedCompanyRestore = null;
  companyRestoreCommitting = true;
  try {
    const response = await localBackupRequest(serverProc, "/api/workspace-backup/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: input.id, confirmation: "REPLACE" }) });
    if (!response.ok) throw new Error("This installation could not be replaced. Check local backup status before trying again.");
    publishCompanyBackupState({ busy: false, pendingRestore: true });
    return await response.json();
  } finally { companyRestoreCommitting = false; }
}));

function myCloud() {
  return myCloudOrigin({ account: cloudAccount, remembered: rememberedHome, remoteAccess: desktopRemoteAccess });
}
const cloudPageAsking = (event) => {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (senderIsLocal(event) && workspaceSenderAllowed(event, contents, environmentsState, rendererOrigin(), ["/home", "/reconnect"])) return "local";
  if (cloudPageSenderAllowed(event, { contents, homeOrigin: myCloud(), activeOrigin: activeEnvironment(environmentsState)?.origin })) return "cloud";
  return null;
};
const cloudPageSender = (channel, handler) => (event) => {
  const asking = cloudPageAsking(event);
  if (!asking) throw new Error(`${channel} is only available in this app's window`);
  return handler(asking === "cloud");
};
/** The page of another Cloud of the person's own, open as this window's active server: that Cloud, as the session lists it. */
const ownCloudPage = event => {
  const origin = activeEnvironment(environmentsState)?.origin, contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!origin || origin === myCloud() || !cloudAccount?.isOwnCloud(origin) || !cloudPageSenderAllowed(event, { contents, homeOrigin: origin, activeOrigin: origin })) return null;
  return otherOwnClouds(cloudAccount.state().clouds).find(cloud => cloud.origin === origin) ?? null;
};
const activePageOrigin = event => { const origin = activeEnvironment(environmentsState)?.origin, contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null; return origin && cloudPageSenderAllowed(event, { contents, homeOrigin: origin, activeOrigin: origin }) ? origin : null; }; const confirmTeamMove = async words => mainWindow && !mainWindow.isDestroyed() && (await dialog.showMessageBox(mainWindow, { type: "warning", ...words, defaultId: 1, cancelId: 1, noLink: true })).response === 0;
let userPresence = null;
installCloudPlanIpc({ ipcMain, pageSender: cloudPageSender, account: () => cloudAccount, client: () => ensureCloudAccount(), notices: () => cloudTrialNotices(), homePage: event => homeWindow.homePage(event), otherCloud: ownCloudPage,
  presence: async () => (await userPresence?.("show a code that logs a phone in to your account")) === true });

// The buying sheet (cloud-buy.mjs): its channels, and the Cloud's name and colour (Servers entry once listed).
const cloudLook = createCloudLook({ store: lookFile(() => path.join(app.getPath("userData"), cloudTarget(process.env).look), fs), accountId: () => cloudAccount?.state().account?.id ?? null,
  homeEntry: cloudHomeEntry, saveEntry: (origin, look) => persistEnvironments(withEnvironmentLook(environmentsState, origin, look)) });
const cloudBuy = installCloudBuy({ ipcMain, guard: localWorkspaceOnly, client: ensureCloudAccount, offersReady: cloudOffersReady, clipboard, look: cloudLook });
/** the harness's usage signals follow this desktop's usage-analytics switch; unset counts as on */
function syncUsageSignals(enabled = desktopPrefs?.analytics() !== false) {
  void localServerRequest("/api/dashboard/usage-signals", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(10_000) })
    .then(response => response.body?.cancel(), () => {});
}
const localServerRequest = async (route, init = {}) => {
  if (localRuntimeStarting && !serverReady) await waitForLocalStartup(localRuntimeStarting);
  if (!(serverProc || !app.isPackaged) || !serverReady) throw new Error("This computer's background server is unavailable. Restart the app and try again.");
  return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit", headers: { ...init.headers, [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
};
const usageNotes = createUsageNotes({ origin: cloudTarget(process.env).origin, install: () => productEvents.install(), token: () => cloudAccount?.eventToken?.() ?? null, localRequest: localServerRequest, platform: process.platform, version: app.getVersion() }); usageNotes.start(); const experienceRelay = createExperienceRelay({ localRequest: localServerRequest, events: productEvents }); experienceRelay.start(); const teamProfileSeeds = createTeamProfileSeeds({ teamFetch: (...args) => session.defaultSession.fetch(...args), localRequest: localServerRequest, log: slog });
const enrollMemory = jsonFile(path.join(app.getPath("userData"), "account-enroll.json")); const accountEnroll = createAccountEnroll({ client: ensureCloudAccount, localRequest: localServerRequest, readMemory: () => { try { return enrollMemory.read(); } catch { return null; } }, writeMemory: enrollMemory.write, log: slog }); const accountGate = installAccountGate({ ipcMain, guard: localWorkspaceOnly, client: ensureCloudAccount, required: accountGateNeeded, window: () => mainWindow, plainStorage: plainSignInStorage, restored: cloudAccountRestored });
let settingsSyncMain = null;
const oneHome = installOneHome({ ipcMain, settingsHome: (call) => settingsSyncMain?.bringHome(call), clean: cleanWorkspace, cloudPage: cloudPageAsking, pageOrigin: activePageOrigin, confirmMove: confirmTeamMove, server: () => serverProc, cookieFetch: (...args) => session.defaultSession.fetch(...args), home: () => (myCloud() && cloudAccount ? { origin: myCloud(), grant: () => cloudAccount.pairHome() } : null), power: cloudPower, file: () => path.join(app.getPath("userData"), "cloud-send.json"), localRequest: localServerRequest, space: { disk: () => cloudPlanDisk(ensureCloudAccount().state()), grow: sizeGb => ensureCloudAccount().growDisk(sizeGb) }, reconnect: origin => signInCloudSession({ origin, mine: myCloud(), pair: () => ensureCloudAccount().pairHome(), fetch: (...args) => session.defaultSession.fetch(...args) }), window: () => (desktopRemoteAccess ? null : mainWindow), localOrigin: rendererOrigin, account: () => cloudAccount, journalFile: () => path.join(app.getPath("userData"), "one-home.json"), tempRoot: () => path.join(app.getPath("temp"), "dusk-one-home"), phone: { paired: () => companionEnabledAtRest(), stop: () => stopDesktopCompanion({ remember: false }).then(() => {}), start: () => startDesktopCompanion({ waitForHosted: false, remember: false }).then(() => {}) }, openHome: () => void showHome({ place: "cloud" }), openTeam: team => void showHome({ place: { team: team.id, name: team.name } }), openLocal: () => void showHome(), restart: () => relaunchAfterDesktopRemoteChange(), version: app.getVersion(), log: slog, other: () => ownHome, accountsHere: () => accountRing()?.count() ?? 1, offer: { store: jsonFile(path.join(app.getPath("userData"), "cloud-move-offer.json")), track: (name, props) => productEvents.action(name, props) } }); ownHome = installOwnHome({ localRequest: localServerRequest, clean: cleanWorkspace, fetch: (...args) => session.defaultSession.fetch(...args), environments: () => environmentsState.environments, handoff: what => oneHome.handoff(what), cloudJournal: () => oneHome.journal(), journal: jsonFile(path.join(app.getPath("userData"), "own-home.json")), choice: jsonFile(path.join(app.getPath("userData"), "own-home-choice.json")), sendState: jsonFile(path.join(app.getPath("userData"), "own-home-send.json")), phone: { paired: () => companionEnabledAtRest(), stop: () => stopDesktopCompanion({ remember: false }).then(() => {}), start: () => startDesktopCompanion({ waitForHosted: false, remember: false }).then(() => {}) }, openHome: place => void workspaceMenuAction(() => switchEnvironment(place.id)), lastInput: oneHome.lastInput, version: app.getVersion(), log: slog, onChange: () => { oneHome.publish(); railChanged(); ownMoveSettled(); } }); twoPlaces = installTwoPlacesMain({ ipcMain, guard: localWorkspaceOnly, localRequest: localServerRequest, fetch: (...args) => session.defaultSession.fetch(...args), environments: () => environmentsState.environments, cloud: () => ({ origin: myCloud(), asleep: cloudPower.asleep() }), oneHome, ownHome, dismissed: jsonFile(path.join(app.getPath("userData"), "two-places.json")), account: () => cloudAccount, teamsRemembered: jsonFile(path.join(app.getPath("userData"), "team-places.json")), log: slog, tell: () => { if (mainWindow && !mainWindow.isDestroyed() && senderIsLocal({ sender: mainWindow.webContents })) mainWindow.webContents.send("two-places:changed"); } }); installConnectorSyncMain({ localRequest: localServerRequest, handoff: what => oneHome.handoff(what), fetch: (...args) => session.defaultSession.fetch(...args), environments: () => environmentsState.environments, cloud: () => ({ origin: desktopRemoteAccess ? null : myCloud(), asleep: cloudPower.asleep(), sleeps: cloudAccount?.power()?.sleeps === true }), ownHome, log: slog }); settingsSyncMain = installSettingsSyncMain({ localRequest: localServerRequest, handoff: what => oneHome.handoff(what), fetch: (...args) => session.defaultSession.fetch(...args), environments: () => environmentsState.environments, cloud: () => ({ origin: desktopRemoteAccess ? null : myCloud(), asleep: cloudPower.asleep(), sleeps: cloudAccount?.power()?.sleeps === true }), ownHome, saveSecret: saveSyncedSecret, log: slog }); const vpsLink = installVpsLink({ ipcMain, powerMonitor, powerSaveBlocker, appVersion: app.getVersion(), myCloud: () => (desktopRemoteAccess ? null : myCloud()), cloudAwake: () => !cloudPower.asleep(), linkGrant: async () => { try { return await ensureCloudAccount().linkGrant(); } catch { return null; } }, ...(accountApp() ? { signIn: () => ensureCloudAccount().continueInBrowser({ kind: "signin", source: "server_link" }) } : {}), screenIce: async () => { try { return await ensureCloudAccount().screenIce(); } catch { return null; } }, pageOrigin: activePageOrigin, whenReady: () => app.whenReady(), guard: localWorkspaceOnly, userData: app.getPath("userData"), session, shell, encryption: cloudEncryption, jsonFile, environments: () => environmentsState, persist: persistEnvironments, withEnvironment, makeId: randomUUID, forgetEnvironment: (id, how) => forgetEnvironment(id, false, true, { ...(how?.replaced ? { unlink: false } : {}), ...(how?.quiet ? { quiet: true } : {}) }), ownHome, localRequest: localServerRequest, switchTo: id => workspaceMenuAction(() => switchEnvironment(id)), relaunch: () => relaunchAfterDesktopRemoteChange(), dataDir: () => runningDataDir, label: () => os.hostname().replace(/\.local$/, "").slice(0, 60) || "my computer", log: slog, tell: view => { if (mainWindow && !mainWindow.isDestroyed() && senderIsLocal({ sender: mainWindow.webContents })) mainWindow.webContents.send("vps-link:changed", view); void serverEnroll?.kick(); } }); void import("./phone-relay.mjs").then(({ installPhoneRelay, systemProxy }) => installPhoneRelay({ ipcMain, powerMonitor, fetch: (...args) => session.defaultSession.fetch(...args), proxy: systemProxy(session.defaultSession), guard: localWorkspaceOnly, jsonFile, userData: app.getPath("userData"), dataDir: () => runningDataDir, encryption: cloudEncryption, wanted: () => !desktopRemoteAccess && serverReady && companionEnabledAtRest() && !oneHome.away() && !ownHome?.away(), signedIn: () => cloudAccount?.state().status === "connected", linkGrant: async () => { try { return await ensureCloudAccount().linkGrant(); } catch { return null; } }, label: () => `${os.hostname().replace(/\.local$/, "").slice(0, 50) || "computer"} phones`, port: () => SERVER_PORT, ownerToken: () => desktopMutationToken, log: slog }));
if (!desktopRemoteAccess) serverEnroll = createServerEnroll({ client: ensureCloudAccount, servers: () => vpsLink.servers().filter(server => environmentsState.environments.some(entry => entry.id === server.id)),
  call: (id, method, route, body) => vpsLink.ownerCall(id, method, route, body), store: jsonFile(path.join(app.getPath("userData"), "server-enroll.json")), log: slog });
// A VPS's bots straight to My Cloud (vps-cloud-move-main.mjs); via this computer when the VPS can't do it itself.
const viaMacStore = jsonFile(path.join(app.getPath("userData"), "vps-cloud-via-mac.json")); const viaMacFile = { read: () => { try { return viaMacStore.read(); } catch { return null; } }, write: value => viaMacStore.write(value) };
const viaMacView = () => { const kept = viaMacFile.read(); if (!kept) return null; const seen = oneHome.view(); return seen ?? (oneHome.away() ? { phase: "done" } : { phase: kept.step ?? "back" }); };
/** After the way back through this computer relaunched the app: this computer's own move to My Cloud starts, as the person already said yes. */
async function viaMacFollow() {
  const kept = viaMacFile.read();
  if (!kept || desktopRemoteAccess) return;
  if (oneHome.away()) { viaMacFile.write({ ...kept, step: "done" }); return; }
  const offer = oneHome.offer();
  if (offer && offer.state().stage !== "none" && !offer.accepted()) await offer.accept("vps_move").catch(error => slog(`vps to cloud: this computer's move did not start (${error?.message ?? error})`));
  else void oneHome.kick();
}
if (!desktopRemoteAccess) installCloudMac({ ipcMain, dialog, shell, allowed: event => cloudPageAsking(event) !== null, window: () => mainWindow, fetch: (...args) => session.defaultSession.fetch(...args), label: () => os.hostname().replace(/\.local$/, "").slice(0, 60) || "my computer", userData: app.getPath("userData"), jsonFile, myCloud, cloudAwake: () => !cloudPower.asleep(), linkKey: async () => (await ensureCloudAccount().pairHome())?.linkKey ?? null, reauth: origin => signInCloudSession({ origin, mine: myCloud(), pair: () => ensureCloudAccount().pairHome(), fetch: (...args) => session.defaultSession.fetch(...args) }), log: slog }); const vpsCloudMove = desktopRemoteAccess ? null : installVpsCloudMoveMain({ ipcMain, pageOrigin: activePageOrigin, localPage: event => senderIsLocal(event), environments: () => environmentsState.environments, fetch: (...args) => session.defaultSession.fetch(...args), cloud: () => oneHomeCloud(cloudAccount?.state()), home: () => (myCloud() && cloudAccount ? { origin: myCloud(), grant: () => cloudAccount.pairHome() } : null),
  cloudRead: async route => { const origin = myCloud(); if (!origin) throw new Error("This app has no My Cloud yet."); const ask = () => session.defaultSession.fetch(`${origin}${route}`, { credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", origin } }); const response = await ask(); if (response.status !== 401 || !(await signInCloudSession({ origin, mine: myCloud(), pair: () => ensureCloudAccount().pairHome(), fetch: (...args) => session.defaultSession.fetch(...args) }))) return response; return ask(); },
  file: name => jsonFile(path.join(app.getPath("userData"), name)), account: () => { try { return accountApp() ? ensureCloudAccount() : cloudAccount; } catch { return cloudAccount; } },
  viaMac: { available: place => { const where = vpsLink.where(); return where.place === "vps" && where.server?.origin === place.origin; }, start: async () => { viaMacFile.write({ v: 1, at: Date.now(), step: "back" }); await vpsLink.moveBack(); }, view: viaMacView },
  openHome: () => void showHome({ place: "cloud" }), lastInput: oneHome.lastInput, track: (name, props) => productEvents.action(name, props), version: app.getVersion(), log: slog,
  tell: view => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("vps-cloud-move:changed", view); railChanged(); } });
// Every page may ask, and main answers for the server of the page that asks: a linked VPS is checked against its pinned identity.
installSealTrust({ ipcMain, isLocal: event => senderIsLocal(event), pageOrigin: activePageOrigin, links: () => vpsLink });
trailMain = installTrailMain({ ipcMain, app, dialog, shell, powerMonitor, BrowserWindow, logDir: LOG_DIR, writer: trailWriter,
  accept: event => senderIsLocal(event) || Boolean(homeWindow.homePage(event)) || Boolean(activePageOrigin(event)),
  linkPath: event => { const origin = activePageOrigin(event); return origin ? vpsLink.pathAt(origin) : null; } });
// Teams from the verified session as places this window shows (home-places.mjs): the one to open next time, and its lines.
const homePlaces = createHomePlaces({ store: jsonFile(path.join(app.getPath("userData"), "home-place.json")), environments: () => environmentsState, persist: persistEnvironments, makeId: randomUUID, homeOrigin: myCloud, log: slog });
const homeWindow = createHomeWindow({ cloudRoute: WELCOMED_ROUTE, beforeOpen: welcomeBeforeOpen, holdPaint: holdMainWindowPaint, clean: cleanWorkspace, journal: () => oneHome.journal() ?? vpsCloudMove?.homeJournal() ?? null, frozen: oneHome.marker, account: () => (accountApp() ? cloudAccount : null), restored: cloudAccountRestored,
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null), ensureWindow: () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow({ deferNavigation: true }); },
  localOrigin: rendererOrigin, cookieFetch: (...args) => session.defaultSession.fetch(...args), power: cloudPower, splash: () => startupScreen, lastInput: oneHome.lastInput, rehomed: () => talk.homeChanged(), log: slog,
  hosts: () => session.defaultSession, readyStore: jsonFile(path.join(app.getPath("userData"), "cloud-ready.json")), ownMove: () => ownHome?.underWay() ?? null, ownAway: () => ownHome?.away() === true, lastSeen: createLastSeenStore({ file: path.join(app.getPath("userData"), "cloud-last-seen.bin"), encryption: cloudEncryption }),
  remembered: homePlaces.remembered, remember: homePlaces.remember, left: homePlaces.left, drop: homePlaces.drop,
  publish: view => { if (mainWindow && !mainWindow.isDestroyed() && senderIsLocal({ sender: mainWindow.webContents })) mainWindow.webContents.send("home:state-changed", view); },
  go: (url, origin, place) => { if (!origin && !place && localPageNeedsServer(url)) return openLocalPageWhenServed(url); if (place?.kind === "team" || place?.kind === "own") { activatePlace(place); if (place.kind === "team") teamProfileSeeds.opened(place.origin); } else if (origin) activateCloud(origin); return navigateMainWindow(url); },
  showLocal: leaving => {
    if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
    const step = localPageStep({ leaving, url: mainWindow.webContents.getURL(), serverChosen: Boolean(activeRemote(environmentsState)) });
    if (step === "stay") return;
    if (step === "open") return windowsWithoutPage.has(mainWindow) ? navigateMainWindow(activeOrigin()) : undefined;
    persistEnvironments(withActive(environmentsState, LOCAL_ID), "gone");
    return navigateMainWindow(rendererOrigin());
  } });
installHomeWindowIpc({ ipcMain, homeWindow, cloudPage: cloudPageAsking });
/** A move to a server of the person's own that just finished: this computer's own view becomes the clean workspace now. */
function ownMoveSettled() {
  try { if (ownHome?.away() && !cleanWorkspace.active() && homeWindow.current().clean !== true) void homeWindow.changed().catch(error => slog(`home: ${error?.message ?? error}`)); }
  catch (error) { slog(`home: ${error?.message ?? error}`); }
}
// My Cloud's page focused in the window: the home hears it every few minutes, so its power policy keeps it up meanwhile
const cloudFocus = createCloudFocus({ fetch: (...args) => session.defaultSession.fetch(...args), lastInput: oneHome.lastInput, log: slog, focused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
  origin: () => { const origin = myCloud(); if (!origin || homeWindow.placeOrigin() !== origin || cloudPower.asleep() || homeWindow.asleepAt(origin)) return null; try { return new URL(mainWindow.webContents.getURL()).origin === origin ? origin : null; } catch { return null; } } });
app.on("browser-window-focus", () => { cloudFocus.check(); });
/** Every path that shows the window: My Cloud once it is the person's home, else as before. */
function showHome(options) {
  const shown = () => homeWindow.show(options).catch(error => slog(`home: ${error?.message ?? error}`));
  return options?.place ? workspaceSwitch.around(shown) : shown();
}
const openOwnCloud = id => showHome({ place: { cloud: id, name: environmentsState.environments.find(entry => entry.cloud?.id === id)?.name } });
const placeInbox = createPlaceInboxWatch({ places: () => [{ id: LOCAL_ID, local: true }, ...environmentsState.environments.filter(entry => entry.kind !== "local" && entry.origin)], activeId: () => environmentsState.activeId, local: localServerRequest, cloudFetch: (...args) => session.defaultSession.fetch(...args), asleep: origin => homeWindow.asleepAt(origin), shown: () => !desktopRemoteAccess && serverReady && Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()), changed: () => railChanged() });
/** A server of the person's own this app linked, which can move to dusk cloud from here now. */
const serverCanMove = id => Boolean(!desktopRemoteAccess && vpsCloudMove && !vpsCloudMove.away() && vpsLink.servers().some(server => server.id === id));
const railList = () => { ownHome?.refresh(); return railPlaces({ saved: environmentsState, waiting: placeInbox.waiting, home: homeWindow.cloudOrigin() ?? ownHome?.origin() ?? null, mine: myCloud(), state: desktopRemoteAccess ? null : cloudAccount?.state(), offers: entry => !desktopRemoteAccess && ownHome?.offers(entry) === true, cloudMoves: entry => serverCanMove(entry.id), accounts: accountRing.waiting() }); };
// The rail as the window's own chrome (chrome-rail.mjs): this app's page beside every place's page, the one that lists.
const chromeRail = createChromeRail({ createView: options => new WebContentsView(options), preload: path.join(__dirname, "preload.cjs"), log: slog, prefs: () => desktopPrefs, changed: () => rail.changed(),
  args: () => [...desktopCompanionRendererArguments(rendererOrigin(), desktopRemoteAccess), "--dusk-current-local-origin=1", ...(accountApp() ? ["--dusk-company-desktop=1"] : []), ...(accountApp() || accountGateNeeded() ? ["--dusk-account-gate=1"] : []), `--dusk-app-version=${app.getVersion()}`],
  url: () => `${rendererOrigin()}${CHROME_RAIL_PATH}`, wanted: () => false });
chromeRail.install(ipcMain);
function railChanged() { chromeRail.refresh(); rail.changed(); void localUi?.refresh(); }
const accountPages = [() => (mainWindow && !mainWindow.isDestroyed() && senderIsLocal({ sender: mainWindow.webContents }) ? mainWindow.webContents : null), () => ({ send: channel => chromeRail.send(channel) })];
const accountRing = createDesktopRing({ allowed: accountApp, active: cloudAccountStore, savedStore: () => createCloudAccountStore({ file: path.join(app.getPath("userData"), cloudTarget(process.env).saved), encryption: signInEncryption }), stash: () => jsonFile(path.join(app.getPath("userData"), cloudTarget(process.env).places)), client: ensureCloudAccount, origin: cloudTarget(process.env).origin, makeClient: ({ store, onState }) => createCloudAccountClient({ store, onState, platform: process.platform, deviceName: os.hostname().slice(0, 100) || "my computer", appVersion: app.getVersion(), origin: cloudTarget(process.env).origin, custom: cloudTarget(process.env).custom, openBrowser: url => shell.openExternal(url) }), saved: () => environmentsState, persist: persistEnvironments, session: () => session.defaultSession, mine: () => myCloud(), leaveWindow: () => (mainWindow && !mainWindow.isDestroyed() && !senderIsLocal({ sender: mainWindow.webContents }) ? navigateMainWindow(rendererOrigin()) : null), rows: () => railList(), holding: () => oneHome.holding(), letGo: () => { homeWindow.accountLeaving(); homePlaces.remember(null); }, settled: () => showHome(), tell: () => { accounts.tell(); railChanged(); }, log: slog }); const accounts = installAccounts({ ipcMain, ownPage: event => chromeRail.owns(event) || cloudPageAsking(event) === "local", ownPlace: event => cloudPageAsking(event) === "cloud" || ownCloudPage(event) !== null || (homeWindow.homePage(event) && homeWindow.shown()?.kind !== "team"), placePage: event => cloudPageAsking(event) !== null || ownCloudPage(event) !== null || homeWindow.homePage(event) || (Boolean(ownHome?.home()) && activeEnvironment(environmentsState)?.origin === ownHome.home().origin && workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, rendererOrigin())), account: () => (accountApp() ? cloudAccount : null), client: ensureCloudAccount, ring: accountRing, holdSheet: open => chromeRail.holdOpen(open), tellSheet: () => chromeRail.send("accounts:open-sheet"), tell: () => { for (const page of accountPages) page()?.send("accounts:changed"); } });

// Start fresh: this computer's reset (electron/start-fresh.mjs). Only from this computer's own page or My Cloud's, never a
// team's or a page a server sent, and never in remote access. It signs this computer out and clears what is kept here;
// the account, its plan, its clouds and linked servers are never deleted from here (the website's account page does that).
const startFresh = createStartFresh({
  account: () => {
    if (!accountApp() || !cloudAccount || cloudAccount.state().status !== "connected") return null;
    const email = cloudAccount.state().account?.email;
    return email ? { email } : null;
  },
  signOut: () => ensureCloudAccount().signOut().then(() => {}),
  async removeAiKeys() {
    for (const name of fs.readdirSync(path.dirname(CREDENTIALS_FILE)).filter(name => name === "credentials.bin" || name.startsWith("credentials.bin.unreadable-"))) {
      await fs.promises.rm(path.join(path.dirname(CREDENTIALS_FILE), name), { force: true });
    }
  },
  markLocal: () => markDesktopStartFresh(app.getPath("userData")),
  relaunch: () => relaunchAfterDesktopRemoteChange(),
  changed: view => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("start-fresh:changed", view); },
  log: slog,
});
const startFreshPage = (channel, handler) => (event, ...args) => {
  if (desktopRemoteAccess || (cloudPageAsking(event) === null && !homeWindow.homePage(event))) throw new Error(`${channel} is only available in this app's window`);
  return handler(...args);
};
// this app's own page, or the person's own home (My Cloud or their own server) shown in this window
ipcMain.handle("start-fresh:available", event => !desktopRemoteAccess && (cloudPageAsking(event) !== null || homeWindow.homePage(event)));
ipcMain.handle("start-fresh:preview", startFreshPage("start-fresh:preview", () => startFresh.preview()));
ipcMain.handle("start-fresh:run", startFreshPage("start-fresh:run", typed => startFresh.run(typeof typed === "string" ? typed : "")));
ipcMain.handle("start-fresh:retry", startFreshPage("start-fresh:retry", () => startFresh.retry()));
ipcMain.handle("start-fresh:finish", startFreshPage("start-fresh:finish", () => startFresh.finish()));
const rail = installCloudRail({ ipcMain, clipboard, openCloud: openOwnCloud, switchAccount: id => accountRing().switchTo(id), account: () => (accountApp() ? cloudAccount : null),
  guard: handler => (event, ...args) => (chromeRail.owns(event) ? handler(event, ...args) : workspaceOnly(handler)(event, ...args)),
  lists: event => chromeRail.owns(event), trusted: event => chromeRail.owns(event) || senderIsLocal(event), beside: () => chromeRail.shown(),
  targets: () => [mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null, { send: channel => chromeRail.send(channel), isDestroyed: () => false }],
  places: railList, open: id => workspaceMenuAction(() => switchEnvironment(id)), makeHome: id => ownHome.start(id), cloudMove: id => askServerCloudMove(id), forget: id => forgetEnvironment(id, false, true),
  add: { choices: () => ({ cloud: cloudOffersAllowed(), link: !desktopRemoteAccess, address: !desktopRemoteAccess && !homeWindow.cloudOrigin(), account: !desktopRemoteAccess && Boolean(accounts.view().active) }),
    run: (choice, link) => (choice === "link" ? (link ? connectHostedWorkspace(link) : addServerFromClipboard()) : choice === "address" ? openWorkspaceSettings() : homeWindow.cloudOrigin() ? undefined : openCloudAdd("app_menu")) } });
const announceAddedCloud = createAddedCloudNotice({ Notification, focused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()), sheetOpen: rail.sheetOpen,
  open: id => { if (!desktopTray?.show()) activateExistingWindow(appWindows()); void openOwnCloud(id); }, shown: () => cloudAccount?.addDone() }); const desktopNotifications = installDesktopNotifications({ ipcMain, Notification, nativeImage, fetch: (...args) => session.defaultSession.fetch(...args), window: () => mainWindow, mayNotify: (contents, url) => appPermissions?.check(contents, "notifications", url, { isMainFrame: true }) === true, reveal: revealForLink, openPlace: origin => (origin === homeWindow.cloudOrigin() ? showHome({ place: "cloud" }) : workspaceMenuAction(() => switchEnvironment(origin === rendererOrigin() ? LOCAL_ID : environmentsState.environments.find(entry => entry.origin === origin)?.id))) });
const botsElsewhere = installBotsElsewhere({ ipcMain, guard: localWorkspaceOnly, places: () => placesElsewhere({ environments: environmentsState.environments, moved: ownHome?.home() ?? null, cloudOrigin: homeWindow.cloudOrigin() }), account: () => (desktopRemoteAccess ? null : cloudAccount?.state().account ?? null), store: accountSetupStore({ local: localAccountSetupStore(jsonFile(path.join(app.getPath("userData"), "account-setups.json"))), remote: remoteAccountSetupStore(), log: slog }),
  open: id => (id === CLOUD_HOME_ID ? showHome({ place: "cloud" }) : workspaceMenuAction(() => switchEnvironment(id))), connectCloud: () => workspaceMenuAction(() => connectCloudHome()), chosen: placesChosen, log: slog,
  counts: () => readBotCounts({ places: environmentsState.environments.filter(entry => entry.kind !== "local" && entry.origin), fetch: (...args) => session.defaultSession.fetch(...args), asleep: origin => homeWindow.asleepAt(origin) }) });
// A place's colour (place-look.mjs): the Admin's for a Cloud, this app's for This computer and a server connected by
// hand; changed on the place's own page or from the window's rail, whatever that server runs.
installPlaceLook({ ipcMain, guard: workspaceOnly, place: () => savedPlace(environmentsState), session: () => ({ clouds: desktopRemoteAccess ? null : cloudAccount?.state().clouds ?? null, homeOrigin: myCloud() }),
  setColor: (id, swatch) => ensureCloudAccount().setCloudColor(id, swatch), save: (id, color) => persistEnvironments(withPlaceColor(environmentsState, id, color)),
  rail: { owns: event => chromeRail.owns(event), places: railList, saved: id => savedPlace(environmentsState, id) } });
const cloudSync = installCloudFiles({
  app, ipcMain, dialog, shell, powerMonitor, localWorkspaceOnly, localDataDir: desktopDataDir(),
  fetch: (...args) => session.defaultSession.fetch(...args),
  send: (channel, value) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value); },
  cloudOrigin: () => myCloud(), cloudAccount: () => ensureCloudAccount(), stateDir: cloudTarget(process.env).sync, power: cloudPower,
});

userPresence = installUserPresence({ ipcMain, guard: workspaceOnly, dialog, systemPreferences, log: slog, window: () => mainWindow, trusted: senderIsLocal });
// window.confirm() has no parent window, so (tiling) window managers cannot center it over the app.
ipcMain.handle("dialog:confirm", localWorkspaceOnly("dialog:confirm", async (_event, message) => {
  if (typeof message !== "string" || !message.trim() || message.length > 4096 || !mainWindow || mainWindow.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    message,
    buttons: ["OK", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}));

ipcMain.handle("environments:state", localWorkspaceOnly("environments:state", (event) => ({
  localOrigin: rendererOrigin(),
  remote: !senderIsLocal(event),
  packaged: app.isPackaged,
  activeId: environmentsState.activeId,
  environments: environmentsState.environments,
})));
ipcMain.handle("environments:switch", localWorkspaceOnly("environments:switch", (_event, id) => switchEnvironment(typeof id === "string" ? id : LOCAL_ID)));
ipcMain.handle("environments:create", localWorkspaceOnly("environments:create", (_event, name, dataDir) => createLocalEnvironment(
  typeof name === "string" ? name : "",
  typeof dataDir === "string" ? dataDir : undefined,
)));
ipcMain.handle("environments:pick-dir", localWorkspaceOnly("environments:pick-dir", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  const chosen = canceled ? null : filePaths[0];
  return chosen ? { ok: true, path: chosen } : { ok: false };
}));
ipcMain.handle("environments:add-from-link", localWorkspaceOnly("environments:add-from-link", (_event, link, name) => {
  return connectHostedWorkspace(link, typeof name === "string" ? name : undefined);
}));
ipcMain.handle("environments:forget", localWorkspaceOnly("environments:forget", (_event, id, purge) => forgetEnvironment(typeof id === "string" ? id : "", purge === true)));

// A cloud page may open the native chooser, never choose a destination or edit the saved list.
// Once My Cloud is home the switcher lists only whole places, and shows only when there is more than My Cloud.
const homeAlone = () => Boolean(homeWindow.cloudOrigin()) && !otherPlaces(environmentsState, homeWindow.cloudOrigin());
ipcMain.handle("workspaces:state", workspaceOnly(event => ({ ...workspaceSummary(environmentsState), ...(homeAlone() && homeWindow.homePage(event) ? { home: true } : {}) })));
ipcMain.handle("workspaces:line", workspaceOnly(event => (cleanWorkspace.active() && senderIsLocal(event) && !homeWindow.here() ? cleanLine() : homePlaces.line())));
function cleanLine() {
  const place = cleanWorkspace.marker().place;
  if (typeof place === "string" && place) return { kind: "clean", place };
  return { kind: "clean", ...(accountRing.waiting().some(row => row.id === oneHome.journal()?.cloud?.account) ? { saved: true } : {}) };
}
let workspaceMenuOpen = false;
ipcMain.handle("workspaces:menu", workspaceOnly(async (_event, from) => {
  if (workspaceMenuOpen) return;
  workspaceMenuOpen = true;
  try {
    await cloudOffersReady();
    const template = workspaceMenuTemplate(environmentsState, {
      onSwitch: (id) => void workspaceMenuAction(() => switchEnvironment(id)),
      onConnect: () => void workspaceMenuAction(openWorkspaceSettings),
      onForget: (id) => void workspaceMenuAction(() => forgetEnvironment(id)),
      ...(serverCanMove(environmentsState.activeId) ? { onCloudMove: (id) => void askServerCloudMove(id).catch(error => slog(`cloud move menu: ${error?.message ?? error}`)) } : {}),
      ...cloudMenuOptions(from === "howto" ? "app_howto" : "app_menu"),
      ...(homeWindow.cloudOrigin() && cloudOffersAllowed() ? { onAddCloud: () => void ensureCloudAccount().webHandoff({ page: "cloud" }).catch(error => slog(`add cloud: ${error?.message ?? error}`)) } : {}),
      kindIcon: placeKindIcon,
      // with My Cloud home, this computer stays one tap away: once its bots moved it opens fresh (its own first bot), never the frozen copy that refuses every send
      onLocal: () => void workspaceMenuAction(() => (cleanWorkspace.marker().frozen ? workspaceSwitch.around(() => homeWindow.openHere()) : activeEnvironment(environmentsState) ? switchEnvironment(LOCAL_ID) : workspaceSwitch.around(() => (homePlaces.remember(null), persistEnvironments(withActive(environmentsState, LOCAL_ID), "chosen"), navigateMainWindow(rendererOrigin()))))),
      localShown: Boolean(mainWindow && !mainWindow.isDestroyed() && senderIsLocal({ sender: mainWindow.webContents })),
      ...(await placesMenuOptions({ homeOrigin: homeWindow.cloudOrigin(), cloud: cloudHomeEntry(), home: oneHome.away() || ownHome?.away() === true, platform: process.platform, port: SERVER_PORT })),
    });
    if (!template.length) return;
    // dev runs only (the smoke walkthrough): a native popup can't be clicked headless, so the named row is chosen instead
    const pick = !app.isPackaged ? process.env.DUSK_SMOKE_MENU_PICK : "";
    if (pick) { const row = template.find((item) => item.id === pick); if (row?.click) { row.click(); return; } }
    const menu = Menu.buildFromTemplate(template);
    await new Promise((resolve) => menu.popup({ window: mainWindow, callback: resolve }));
  } finally {
    workspaceMenuOpen = false;
  }
}));

ipcMain.handle("desktop:capabilities", async (event) =>
  desktopCapabilities({
    remote: !senderIsLocal(event),
    homeSpeech: homeWindow.homePage(event),
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady, frame: windowFrameNow(),
  }),
);

async function saveWorkspaceCredential(name, value) {
  const patchFor = CREDENTIAL_PATCH[name];
  if (!patchFor || typeof value !== "string") {
    throw new Error("Unsupported credential");
  }
  if (app.isPackaged && !(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  const applyToHarness = async () => {
    if (app.isPackaged && !serverReady) throw new Error("The embedded bot server is unavailable");
    const secretStorage = app.isPackaged ? "?secretStorage=external" : "";
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config${secretStorage}`, {
      method: "PUT",
      headers: desktopServerHeaders(
        { "content-type": "application/json" },
        { packaged: app.isPackaged, token: desktopMutationToken },
      ),
      body: JSON.stringify(patchFor(secret)),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw credentialSaveError(response.status, body);
    return body;
  };
  if (!app.isPackaged) return applyToHarness();

  // Commit the encrypted value before the server makes it live; a failed reload rolls credentials.bin back.
  return updateSecureCredentialDocument(
    (credentials) => {
      if (secret) credentials[name] = secret;
      else delete credentials[name];
      return credentials;
    },
    applyToHarness,
  );
}

// a key another of the person's places has: kept the way this app keeps the ones typed here (encrypted, when packaged)
async function saveSyncedSecret(path, value) {
  if (!app.isPackaged || typeof value !== "string") return false;
  const name = Object.keys(CREDENTIAL_PATCH).find((candidate) => {
    const patch = CREDENTIAL_PATCH[candidate]("x");
    const [section, field] = path.split(".");
    return patch?.[section]?.[field] === "x" && Object.keys(patch).length === 1 && Object.keys(patch[section]).length === 1;
  });
  if (!name) return false;
  await saveWorkspaceCredential(name, value);
  return true;
}

ipcMain.handle("credential:set", localOnly("credential:set", (_event, name, value) =>
  saveWorkspaceCredential(name, value),
));

ipcMain.handle("approvals:set-trusted-mode", localOnly("approvals:set-trusted-mode", (_event, botId, mode, options) => {
  // A separately launched dev server is outside this trust path: never degrade this grant to loopback HTTP.
  if (!app.isPackaged || !serverProc) {
    throw new Error("Full and Custom approval modes require the embedded desktop server");
  }
  return trustedApprovalMode.request(serverProc, botId, mode, options);
}));

// Electron fixes a Windows window's title bar when the window is made; on macOS the choice applies at once.
const windowFrameNow = () => (process.platform === "win32" ? windowFrameMade : null) ?? desktopPrefs?.windowFrame() ?? FRAME_BY_DEFAULT;
async function broadcastDesktopCapabilities() {
  const localConnection = await cuaReady;
  const build = (remote, homeSpeech = false) =>
    desktopCapabilities({ remote, homeSpeech, platform: process.platform, env: process.env, packaged: app.isPackaged, localConnection, frame: windowFrameNow() });
  const local = build(false);
  chromeRail.send("desktop:capabilities-changed", local);
  let redacted = null, home = null;
  for (const window of appWindows()) {
    if (window.isDestroyed()) continue;
    let isLocal = false;
    try {
      isLocal = new URL(window.webContents.getURL()).origin === confirmedRendererOrigin();
    } catch {}
    const isHome = !isLocal && homeWindow.homePage({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    if (isHome) home ??= build(true, true);
    else if (!isLocal) redacted ??= build(true);
    window.webContents.send("desktop:capabilities-changed", isLocal ? local : isHome ? home : redacted);
  }
}

setCuaStateListener((connection) => {
  cuaReady = Promise.resolve(connection);
  void broadcastDesktopCapabilities().catch((error) => {
    console.error("[desktop] capability broadcast failed:", error);
  });
});

app.whenReady().then(async () => {
  if (await offerMoveToApplications({ app, ask: options => dialog.showMessageBox(options), memory: jsonFile(path.join(app.getPath("userData"), "move-to-applications.json")), home: os.homedir(), execPath: process.execPath,
    automated: process.env.DUSK_SMOKE_TEST === "1" || app.commandLine.hasSwitch("remote-debugging-port"), atLogin: loginItem.startedHidden(), log: slog })) return;
  if (startedFresh) await session.defaultSession.clearStorageData().catch(error => slog(`start fresh: window storage not cleared (${error?.message ?? error})`));
  app.setAboutPanelOptions(aboutPanelOptions(app.getVersion()));
  startupTrace.mark("ready");
  windowPlacement.install();
  if (process.platform === "win32") {
    try {
      desktopTray = createSystemTray({
        Tray, Menu, nativeImage, resourcesDir: path.join(__dirname, "resources"),
        getWindow: () => startupScreen?.window ?? mainWindow ?? (openWindowForLink?.(), mainWindow),
        onQuit: () => app.quit(),
      });
    } catch (error) {
      slog(`system tray unavailable: ${error?.message ?? error}`);
    }
  }
  hiddenStart = loginItem.startedHidden();
  startupScreen = hiddenStart ? null : createStartupScreen({
    BrowserWindow, iconPath: APP_ICON, isQuitting: () => desktopShutdownStarted,
    onQuit: () => app.quit(),
    onRetry: () => { app.relaunch(); app.quit(); },
    onHide: desktopTray ? (win) => desktopTray.hide(win) : undefined,
    isHidden: () => desktopTray?.isHidden() ?? false,
    onShow: (win) => desktopTray?.windowShown(win),
    onFinished: () => { startupScreen = null; },
    dark: startupDark({ systemDark: nativeTheme.shouldUseDarkColors, saved: readStartupTheme() }),
    expectedMs: expectedLoadMs(readStartupLoads()),
    onLoaded: rememberStartupLoad,
  });
  // the splash is a data: page and paints on its own, so nothing waits for it
  const credentialsLoading = evictStartupCacheOnce({
    userData: app.getPath("userData"),
    currentVersion: app.getVersion(),
    clearCache: () => session.defaultSession.clearCache(),
    log: slog,
  }).then(() => credentialFile.load());
  credentialsLoading.catch(() => {});
  void startupScreen?.ready.then(() => startupTrace.mark("splash"));
  secureCredentials = await credentialsLoading;
  if (desktopShutdownStarted) return;
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSavePath(collisionFreeDownloadPath(app.getPath("downloads"), item.getFilename()));
    revealDownloadWhenDone(item, (filePath) => shell.showItemInFolder(filePath));
  });
  // Registry before lease: the lease and the child's DUSK_DATA_DIR both follow a named environment.
  environmentsState = environmentsStore.read();
  let bootDataDir = desktopDataDir();
  if (app.isPackaged) {
    const boot = bootEnvironmentDir(environmentsState, desktopDataDir());
    if (boot.fellBack) {
      slog(`boot environment ${boot.missingDir} is missing; falling back to the default data dir`);
      persistEnvironments({ ...environmentsState, activeId: LOCAL_ID }, "unusable");
      dialog.showErrorBox(
        "The environment's folder is missing",
        `${boot.missingDir} is not there anymore, so Metal came up on this computer's default data folder instead. Restore or remount that folder, then choose the environment again from the Server menu.`,
      );
    }
    bootDataDir = boot.dataDir === desktopDataDir() ? startFolder() : boot.dataDir;
  }
  if (app.isPackaged) {
    try {
      // Acquire before either plaintext credential migration touches config.json.
      desktopDataDirLease = acquireDataDirLease(bootDataDir, {
        legacyDataDir: path.join(app.getPath("home"), ".opengrokbot"),
      });
      runningDataDir = bootDataDir;
    } catch (error) {
      dialog.showErrorBox(
        "Metal could not start safely",
        error?.message ?? "Another process is using this Metal data folder.",
      );
      app.quit();
      return;
    }
  }
  installServerSessions({ app, defaultSession: session.defaultSession, serverPort: () => SERVER_PORT,
    ownerToken: () => (!app.isPackaged || serverReady ? desktopMutationToken : null),
    // in development the page is Vite's, which proxies /api to the server child that holds this same token
    uiPort: () => (app.isPackaged || desktopRemoteAccess ? null : Number(new URL(DEV_URL).port) || null) });
  if (app.isPackaged) for (const scheme of ["duskbot", LEGACY.protocol]) app.setAsDefaultProtocolClient(scheme);
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  // An orphaned third-party key with no clear handler left: drop it rather than keep it at rest.
  if (secureCredentials && Object.hasOwn(secureCredentials, "assemblyAiApiKey") && !credentialFile.unavailable()) {
    try {
      const { assemblyAiApiKey: _removed, ...rest } = secureCredentials;
      await saveSecureCredentials(rest);
      secureCredentials = rest;
    } catch (error) {
      slog(`orphaned AssemblyAI key not removed: ${error?.message ?? error}`);
    }
  }
  if (app.isPackaged) {
    const migration = { configPath: path.join(desktopDataDir(), "config.json"), save: saveSecureCredentials, log: slog };
    await secureComposioConfig({ ...migration, credentials: secureCredentials });
    secureCredentials = await secureWorkspaceConfig({ ...migration, credentials: secureCredentials });
  }
  // From here on every credential writer must go through this serialized state.
  secureCredentialState = createSecureCredentialState(secureCredentials, saveSecureCredentials, {
    writable: !credentialFile.unavailable(),
  });
  secureCredentials = secureCredentialState.read();
  if (app.isPackaged) await ensurePhoneSecretIdentity();
  savedSecretsKey = await ensureSavedSecretsKey(() => secureCredentialState?.read() ?? secureCredentials, (derive) => updateSecureCredentialDocument(derive));
  desktopRemoteAccess = desktopCompanionAccess(secureCredentials);
  startupTrace.mark("credentials");
  const hostedAccount = desktopRemoteAccess ? null : ensureCompanionAccountService();
  // Display capture needs a one-shot renderer intent from the same frame/origin, no audio, and a user gesture.
  if (process.platform === "darwin" || process.platform === "linux") {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        displayMediaRequestCount += 1;
        if (!displayMediaGuard.consume(request, confirmedRendererOrigin())) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        const capabilities = desktopCapabilities({
          platform: process.platform,
          env: process.env,
          packaged: app.isPackaged,
        });
        const captureHost =
          process.platform === "darwin" ? "darwin" : capabilities.host.session;
        if (!capabilities.screenPreview.available) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const source = selectCaptureSource({
              sources,
              host: captureHost,
              primaryDisplayId:
                process.platform === "linux" && captureHost === "x11"
                  ? screen.getPrimaryDisplay().id
                  : null,
            });
            if (!source) {
              console.warn(
                `[screen-preview] rejected ${captureHost} source set (${sources.length} candidates)`,
              );
            }
            respondToDisplayMediaRequest(callback, source ? { video: source } : {});
          })
          .catch((error) => {
            console.warn("[screen-preview] source discovery failed:", error);
            respondToDisplayMediaRequest(callback, {});
          });
      },
      { useSystemPicker: false },
    );
  }
  registerCuaIpc();
  desktopPrefs = createDesktopPrefs({ ...jsonFile(path.join(app.getPath("userData"), "desktop-prefs.json")), frameByDefault: FRAME_BY_DEFAULT });
  registerDesktopPrefs({ ipcMain, prefs: desktopPrefs, analyticsChanged: syncUsageSignals, localConfig: jsonFile(path.join(desktopDataDir(), "config.json")).read, cloudOffered: () => cloudAccountRestored().then(cloudOffersReady),
    frame: { made: () => windowFrameMade, restarts: process.platform === "win32", changed: () => void broadcastDesktopCapabilities() },
    languageChanged: (language, sender) => {
      for (const win of appWindows()) if (!win.isDestroyed() && win.webContents !== sender) win.webContents.send("desktop-language:changed", language);
      chromeRail.send("desktop-language:changed", language);
    },
    page: event => senderIsLocal(event) ? "local" : cloudPageAsking(event) ?? (workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, rendererOrigin()) ? "server" : null) });
  talk.start({ globalShortcut, screen, prefs: desktopPrefs, remote: () => Boolean(desktopRemoteAccess), away: () => homeWindow.current().kind !== "computer", starting: () => !serverReady, localRequest: localServerRequest, dataDir: () => runningDataDir });
  ambientSurfaces.start(screen);
  setLocalOrigin(confirmedRendererOrigin());
  session.defaultSession.webRequest.onCompleted({ urls: ["https://*/api/*"] }, details => homeWindow.responded(details));
  appPermissions = appPermissionHandlers({
    rendererOrigin: confirmedRendererOrigin,
    mainContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
    cloudHomeOrigin: myCloud,
    cloudHomeRestoring: () => cloudAccountRestoring ? cloudAccountRestored() : null,
    activeRemoteOrigin: () => activeEnvironment(environmentsState)?.origin ?? null,
    activeRemoteMicrophone: () => activeEnvironment(environmentsState)?.microphone === true,
    askRemoteMicrophone,
    homeOrigin: () => homeWindow.placeOrigin(),
    systemNotifications: systemNotificationsAllowed(),
  }); startDesktopErrorReporting({ app, prefs: desktopPrefs }); if (app.isPackaged) appImageMenuEntry.sync(); if (!app.isPackaged) startDemoUpdates(); else startAppUpdates(createUpdateNotice({ request: localServerRequest, open: url => void shell.openExternal(url), memory: jsonFile(path.join(app.getPath("userData"), "update-notice.json")), log: slog, notify: ({ title, body, click }) => { if (!Notification.isSupported()) return; const note = new Notification({ title, body }); note.on("click", click); note.show(); } }));
  session.defaultSession.setPermissionRequestHandler(appPermissions.request);
  session.defaultSession.setPermissionCheckHandler(appPermissions.check);
  // Before the window, so the harness has the CUA descriptor on first render.
  cuaReady =
    !desktopRemoteAccess && (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32")
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", reason: String(e) };
        })
      : Promise.resolve({ mode: "unavailable", reason: "unsupported-platform" });
  if (desktopRemoteAccess) {
    try {
      desktopCompanionRelay = await startDesktopCompanionRelay({
        access: desktopRemoteAccess,
        staticDir: app.isPackaged
          ? path.join(process.resourcesPath, "ui")
          : path.join(app.getAppPath(), "dist"),
      });
      SERVER_PORT = desktopCompanionRelay.port;
      serverReady = true;
    } catch (error) {
      serverReady = false;
      slog(`desktop companion relay failed: ${error?.message ?? error}`);
    }
  } else if (devOwnServerWanted(process.env, app.isPackaged)) {
    if (!(await startDevServer())) {
      app.quit();
      return;
    }
  } else if (app.isPackaged) {
    const target = () => {
      const marker = cleanWorkspace.marker();
      return savedVpsStartupTarget({
        packaged: app.isPackaged, hidden: hiddenStart, remoteAccess: desktopRemoteAccess,
        active: activeRemote(environmentsState), link: vpsLink.view(),
        priority: desktopShutdownStarted || pendingOrganizationEntry || cloudEntry.pending() || pendingPackageInstallUrl || pendingChatLink ||
          organizationRestartIntent(secureCredentialState?.read() ?? secureCredentials) || ownHome?.underWay(),
        cloudHome: oneHome.away() || (marker.frozen && !marker.place), rememberedPlace: homePlaces.remembered(),
      });
    };
    const startup = startPackagedAlongsideVps({
      startLocal: async () => {
        const booted = await startServerPackaged();
        if (!booted && !desktopShutdownStarted && bootDataDir !== desktopDataDir()) {
          slog(`boot environment ${bootDataDir} did not start; falling back to the default data dir`);
          persistEnvironments({ ...environmentsState, activeId: LOCAL_ID }, "unusable");
          try {
            desktopDataDirLease?.release();
          } catch (error) {
            slog(`boot fallback lease release failed: ${error?.message ?? error}`);
          }
          desktopDataDirLease = null;
          try {
            desktopDataDirLease = acquireDataDirLease(desktopDataDir(), {
              legacyDataDir: path.join(app.getPath("home"), ".opengrokbot"),
            });
            runningDataDir = desktopDataDir();
          } catch (error) {
            dialog.showErrorBox(
              "Metal could not start safely",
              error?.message ?? "Another process is using this Metal data folder.",
            );
            app.quit();
            return;
          }
          const retried = await startServerPackaged();
          if (retried) {
            dialog.showErrorBox(
              "The environment was unhealthy",
              `Metal could not start on ${bootDataDir} and came up on this computer's default data folder instead. Choose that environment again from the Server menu once it is available.`,
            );
          } else {
            dialog.showErrorBox(
              "Metal could not start",
              `Metal could not start on ${bootDataDir} or on this computer's default data folder. Check that both folders are readable, then start the app again.`,
            );
            app.quit();
          }
        }
      },
      target,
      ready: id => vpsLink.readyServer(id),
      open: async ({ id, origin }) => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow({ deferNavigation: true });
        const loaded = await navigateMainWindow(origin);
        if (loaded) earlyVpsOpened = id;
        return loaded;
      },
      failed: error => slog(`saved VPS startup: ${error?.message ?? error}`),
    });
    localRuntimeStarting = startup.local;
    try { await startup.local; }
    catch (error) {
      if (!(await startup.remote) || activeRemote(environmentsState)?.id !== earlyVpsOpened) throw error;
      slog(`local background server did not start: ${error?.message ?? error}`);
    } finally { localRuntimeStarting = null; }
  }
  startupTrace.mark(serverReady ? "server" : "server-failed");
  if (desktopShutdownStarted) return;
  if (app.isPackaged && !desktopRemoteAccess) void ensureManagedDesktop().start().then(() => companyBackupSchedule.start()).catch(() => {});
  // Fresh local use never makes a Cloud request; start only restores an existing grant.
  if (accountApp() || accountGateNeeded()) {
    cloudAccountRestoring = true;
    cloudAccountStarted = ensureCloudAccount().start().catch(() => {}).then(() => accountRing()?.start()).finally(() => { cloudAccountRestoring = false; });
  }
  void cloudAccountStarted.then(() => { void oneHome.kick(); void homeWindow.refresh(); void vpsCloudMove?.kick(); if (cloudAccount) serverEnroll?.onState(cloudAccount.state()); void viaMacFollow(); }); void ownHome?.kick();
  if (!desktopRemoteAccess && serverReady && companionEnabledAtRest() && !oneHome.away() && !ownHome?.away() && !cleanWorkspace.marker().frozen) {
    // Retries stop once the person turns the phone off, starts it by hand or quits.
    const wanted = () => !desktopShutdownStarted && companionEnabledAtRest() && !companionRunning() && !oneHome.away() && !ownHome?.away();
    void autoStartCompanion({ restored: managedDesktop?.whenRestored(), start: () => startDesktopCompanion({ waitForHosted: false, remember: false }), wanted, log: slog });
  }
  setLocalOrigin(confirmedRendererOrigin());
  cloudSync.start();
  if (loginItem.settle()) refreshApplicationMenu();
  let restoredOrganizationEntry = false;
  await workspaceMenuAction(async () => { restoredOrganizationEntry = await organizationEntry.restore(); });
  organizationEntryReady = true;
  // A cold-start action owns its first navigation; a default load started first would be aborted by it.
  const deliveredOrganizationEntry = await deliverOrganizationEntry();
  const deliveredCloudEntry = await cloudEntry.ready();
  if (!hiddenStart && !restoredOrganizationEntry && !deliveredOrganizationEntry && !deliveredCloudEntry) await showHome();
  // Reconcile incomplete setup and resume interrupted sign-out only once the local app is usable.
  if (hostedAccount) void hostedAccount.restore().catch(() => {});
  // Registering from an unreadable store would mint a second installation identity.
  if (credentialFile.unavailable()) {
    slog("skipping connected-apps registration: the credential store was unreadable this launch");
  }
  if (!desktopRemoteAccess && composioBrokerUrl() && !credentialFile.unavailable()) {
    void updateSecureCredentialDocument(async (credentials) => {
      await ensureManagedComposioCredentials({
        brokerUrl: composioBrokerUrl(),
        credentials,
        saveCredentials: async () => {},
        log: slog,
      });
      return credentials;
    }).finally(syncManagedComposioCredentials);
  }
  refreshApplicationMenu();
  openWindowForLink = () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow({ deferNavigation: homeWindow.current().kind !== "computer" });
    void showHome();
  };
  app.on("activate", () => revealForLink());
}).catch((error) => {
  slog(`startup failed: ${error?.stack ?? error}`);
  if (!startupScreen) throw error;
  startupScreen.fail(error);
}).finally(() => allWindowsClosedQuit.settleStartup());

const allWindowsClosedQuit = createAllWindowsClosedQuit({
  app,
  allWindows: () => appWindows(), stayOpen: () => hiddenStart,
});

// The embedded CUA daemon's async cleanup cannot run after the host exits, so the first quit waits for it (capped).
const CUA_STOP_TIMEOUT_MS = 2500;
let cuaCleanedUp = false;
let signalQuitRequested = false;

// Linux package managers and watchdogs stop apps with SIGTERM/SIGINT: the first becomes a normal quit,
// a second keeps Node's default force-quit (`once` listeners).
const requestSignalQuit = () => {
  if (signalQuitRequested) return;
  signalQuitRequested = true;
  app.quit();
};
process.once("SIGINT", requestSignalQuit);
process.once("SIGTERM", requestSignalQuit);

let appUpdater = null, appUpdatedTo = null, appUpdateMode = app.isPackaged ? "notice" : "dev", windowsSessionEnding = false;
const appUpdateState = () => ({ ...(appUpdater?.state() ?? { ready: null, available: null, progress: null }), mode: appUpdateMode, updated: appUpdatedTo });
const tellAppUpdate = () => { const page = mainWindow && !mainWindow.isDestroyed() ? { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame } : null; if (page && (senderIsLocal(page) || homeWindow.homePage(page))) page.sender.send("app-update:changed", appUpdateState()); };
function startDemoUpdates() {
  const flag = demoUpdateFlag(app.getPath("userData"));
  if (!fs.existsSync(flag)) return;
  appUpdater = createDemoUpdater({ flag, relaunch: relaunchAfterDesktopRemoteChange, onState: tellAppUpdate }); appUpdateMode = "self";
  appUpdater.start();
}
function startAppUpdates(notice) {
  if (justUpdated(jsonFile(path.join(app.getPath("userData"), "app-version.json")), app.getVersion())) {
    appUpdatedTo = app.getVersion();
    try { productEvents.action("app_updated", { how: "manual" }); } catch {}
  }
  notice.start();
}
ipcMain.handle("app-update:state", localOrHome("app-update:state", appUpdateState));
ipcMain.handle("app-update:restart", localOrHome("app-update:restart", () => appUpdater?.restart() ?? false));
ipcMain.handle("app-update:download", localOrHome("app-update:download", () => appUpdater?.check({ again: true }) ?? null));
ipcMain.handle("app-update:open", localOrHome("app-update:open", () => { void shell.openExternal(METAL_RELEASES_URL); return true; }));
ipcMain.handle("app-update:move", localOrHome("app-update:move", () => { try { return app.moveToApplicationsFolder(); } catch (error) { slog(`app update: could not move to Applications (${error instanceof Error ? error.message : String(error)})`); void shell.openExternal(METAL_RELEASES_URL); return false; } }));
ipcMain.handle("app-update:seen", localOrHome("app-update:seen", () => { if (appUpdatedTo) { appUpdatedTo = null; tellAppUpdate(); } }));

// powerMonitor is usable only once the app is ready.
void app.whenReady().then(() => installSessionEndFlush({ app, windows: () => BrowserWindow.getAllWindows(), powerMonitor, flusher: browsersFlush, quit: () => app.quit(), log: slog, onSessionEnd: () => { windowsSessionEnding = true; } }));
app.on("before-quit", (e) => {
  talk.close(); ambientSurfaces.close();
  desktopShutdownStarted = true;
  startupScreen?.dispose();
  companyBackupSchedule?.close();
  orgLibrary?.close();
  managedDesktop?.close();
  usageNotes.close(); experienceRelay.close(); void productEvents.close();
  accountEnroll.close(); serverEnroll?.close(); accountRing.close(); cloudAccount?.close(); oneHome.close(); ownHome?.close(); void vpsLink.close(); twoPlaces?.close(); homeWindow.close();
  companyBackupController?.abort();
  cloudSync.close();
  if (cuaCleanedUp) return;
  e.preventDefault();
  // Cancel a scheduled recovery before yielding.
  const browsersQuit = process.platform === "win32" ? browsersFlush.flush() : Promise.resolve(true);
  const stoppingServer = browsersQuit.then(() => Promise.all([serverSupervisor.shutdown(), devServer?.stop() ?? true])).then((all) => all.every(Boolean));
  syncCompanionKeepAwake(false, false);
  routineWake.stop();
  try {
    desktopCompanionRelay?.close?.();
  } catch {}
  stopSpeech();
  const ownedHelperCleanup = Promise.race([
    Promise.all([
      stopCua().catch(() => {}),
      stopDesktopCompanion({ remember: false }).catch(() => {}),
    ]),
    new Promise((resolve) => setTimeout(resolve, CUA_STOP_TIMEOUT_MS).unref()),
  ]);
  const cleanup = Promise.all([
    ownedHelperCleanup,
    stoppingServer.then((stopped) => {
      if (!stopped) slog("server child did not stop before desktop exit; retaining the data-directory lease");
    }),
  ]);
  cleanup.then(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});

function releaseDesktopDataDirLease() {
  if (!desktopDataDirLease) return;
  try {
    desktopDataDirLease.release();
    desktopDataDirLease = null;
  } catch (error) {
    // Never print the private child capability.
    slog(`data-directory lease release failed: ${error?.message ?? error}`);
  }
}

// before-quit is too early (this app defers it); will-quit is Electron's last boundary, and the process hook covers app.exit().
app.on("will-quit", releaseDesktopDataDirLease);
app.on("will-quit", () => desktopTray?.destroy());
// after the app's own shutdown (before-quit waits for its server and helpers), so the installer finds nothing to close
process.once("exit", releaseDesktopDataDirLease);
