// Packaged: an embedded cua-driver daemon, so macOS TCC grants attribute to Metal; dev attaches to CuaDriver.app.
// Agents use the stdio MCP proxy, which executes nothing; the host-owned daemon does.

import { app, ipcMain, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import localOriginModule from "./local-origin.cjs";
import { createLocalComputerGrant } from "./local-computer-grant.mjs";
import { driverFailure } from "./cua-failure.mjs";
import { driverGateFromReason, driverGateReason, parseDriverGate } from "./cua-gate.mjs";

const { localOnly } = localOriginModule;

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");
const {
  createLinuxCuaPreferenceStore,
  createLinuxCuaRuntime,
  createUnavailableLinuxRuntime,
} = require("./cua-linux-runtime.cjs");
const {
  cleanupAppImageCuaBundle,
  reapStaleAppImageCuaBundles,
  stageAppImageCuaBundle,
} = require("./cua-linux-bundle.cjs");
const { driverBlocked, linuxLocalControlSupport } = require("./capabilities.cjs");

const INSTALLED_DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const STANDALONE_SOCKET = path.join(
  app.getPath("home"),
  "Library/Caches/cua-driver/cua-driver.sock",
);
const HOST_BUNDLE_ID = "bot.dusk.app";
const CUA_ENV = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };
const execFileAsync = promisify(execFile);
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED ??= "0";

// Where cua-driver installs itself on Windows; the installer's own directory is the fallback.
const WIN_INSTALLED_DRIVERS = [
  path.join(app.getPath("home"), ".cua-driver", "packages", "current", "cua-driver.exe"),
  path.join(app.getPath("home"), "AppData", "Local", "Programs", "CuaDriver", "cua-driver.exe"),
];
let embeddedHost = null;
let startupAbort = null;
/** On Windows a start that failed for a reason that passes (a slow first start while the system scans the new helper)
 * is tried again by itself after these waits; a blocked or missing helper is not. */
const RETRY_AFTER_MS = [15_000, 60_000];
let retryTimer = null;
let lifecycleGeneration = 0;
let macRetry = null;
let gateWatch = null;
const GATE_POLL_MS = 2_000;
const GATE_WATCH_MS = 30 * 60_000;
let linuxRuntime = null;
let linuxBundleStage = null;
let stateListener = () => {};
const connectionStore = createCuaConnectionStore({
  getUserData: () => app.getPath("userData"),
});
const localComputerGrant = createLocalComputerGrant({
  connection: () => connectionStore.get(),
  log: (line) => console.error(`[cua] ${line}`),
});

function ensureLinuxRuntime() {
  if (!linuxRuntime) {
    const support = linuxLocalControlSupport(process.platform, process.env);
    if (!support.available) {
      linuxRuntime = createUnavailableLinuxRuntime({
        connectionStore,
        preferenceStore: createLinuxCuaPreferenceStore({
          getUserData: () => app.getPath("userData"),
        }),
        clearPreference: true,
        reasonCode: support.reasonCode,
        message: support.message,
        onChange: (connection) => notifyState(connection),
      });
      return linuxRuntime;
    }
    try {
      let bundledDriverPath;
      if (app.isPackaged && !process.env.CUA_DRIVER_PATH) {
        bundledDriverPath = path.join(process.resourcesPath, "cua-linux-x64", "cua-driver");
        // AppImage builders may normalize the resource tree to 0755/0775: copy the pinned binaries to a fresh 0700 dir and re-verify.
        if (process.env.APPIMAGE) {
          reapStaleAppImageCuaBundles();
          linuxBundleStage ??= stageAppImageCuaBundle({ resourcesPath: process.resourcesPath });
          bundledDriverPath = linuxBundleStage.driverPath;
        }
      }
      linuxRuntime = createLinuxCuaRuntime({
        getUserData: () => app.getPath("userData"),
        connectionStore,
        bundledDriverPath,
        onChange: (connection) => notifyState(connection),
      });
    } catch (error) {
      console.error("[cua] Bundled Linux driver failed integrity validation:", error);
      linuxRuntime = createUnavailableLinuxRuntime({
        connectionStore,
        onChange: (connection) => notifyState(connection),
      });
    }
  }
  return linuxRuntime;
}

/** The app's own server child gets the driver connection, and every change to it, over its private port. */
export function grantLocalComputer(proc, isCurrent) {
  localComputerGrant.attach(proc, isCurrent);
}

function notifyState(connection) {
  localComputerGrant.changed();
  stateListener(connection);
}

export function setCuaStateListener(listener) {
  stateListener = typeof listener === "function" ? listener : () => {};
}

function persistAndNotify(next) {
  const connection = connectionStore.persist(next);
  notifyState(connection);
  return connection;
}

export function resolveWindowsDriver() {
  for (const candidate of WIN_INSTALLED_DRIVERS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cua-driver" + (process.platform === "win32" ? ".exe" : ""));
    if (fs.existsSync(bundled)) return bundled;
  }
  if (process.platform === "darwin" && fs.existsSync(INSTALLED_DRIVER)) return INSTALLED_DRIVER;
  if (process.platform === "win32") {
    const staged = path.join(app.getAppPath(), "dist-native", "cua-win32-x64", "cua-driver.exe");
    return fs.existsSync(staged) ? staged : resolveWindowsDriver();
  }
  return null;
}

export function resolveEmbeddedDriverBinary(binary) {
  if (process.platform !== "win32" || !app.isPackaged || process.env.CUA_DRIVER_PATH ||
      binary !== path.join(process.resourcesPath, "cua-driver.exe")) return binary;
  const background = path.join(process.resourcesPath, "cua-driver-background.exe");
  if (!fs.existsSync(background)) throw new Error("Packaged background CUA driver is missing; reinstall Metal");
  return background;
}

function socketAlive(sockPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    let timer;
    const done = (ok) => {
      clearTimeout(timer);
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    timer = setTimeout(() => done(false), 1500);
    timer.unref();
  });
}

async function loadEmbeddedSdk() {
  if (!app.isPackaged) {
    if (process.platform === "win32") return import("@trycua/cua-driver/embedded");
    const [embedded, permissions] = await Promise.all([
      import("@trycua/cua-driver/embedded"),
      import("@trycua/cua-driver/electron"),
    ]);
    return { ...embedded, ...permissions };
  }
  const isWindows = process.platform === "win32";
  process.env.DUSK_CUA_SDK_LIBRARY = path.join(
    process.resourcesPath,
    "cua-sdk",
    "native",
    isWindows ? "cua_driver_sdk.dll" : "libcua_driver_sdk.dylib",
  );
  return import(pathToFileURL(path.join(process.resourcesPath, "cua-sdk", "cua-sdk.mjs")).href);
}

async function attachStandalone(signal, { mayOpen = true } = {}) {
  // Windows must stay on the owned embedded host, never an unrelated daemon.
  if (process.platform !== "darwin") return null;
  const driver = fs.existsSync(INSTALLED_DRIVER) ? INSTALLED_DRIVER : null;
  if (!driver) return null;
  if (!(await socketAlive(STANDALONE_SOCKET))) {
    // opening CuaDriver can put up its own permission panel, so the packaged app's fallback opens it only when asked
    if (!mayOpen) return null;
    signal.throwIfAborted();
    // Through LaunchServices so Accessibility/Screen Recording stay on com.trycua.driver, the identity already granted.
    const launch = execFileAsync("/usr/bin/open", ["-a", "CuaDriver"], {
      timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 8_192,
    });
    // execFile's AbortSignal can send TERM regardless of killSignal; bound a launcher that ignores TERM.
    const abort = () => launch.child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { await launch; }
    finally { signal.removeEventListener("abort", abort); }
    for (let i = 0; i < 25; i++) {
      signal.throwIfAborted();
      if (await socketAlive(STANDALONE_SOCKET)) break;
      await delay(200, undefined, { signal });
    }
  }
  if (!(await socketAlive(STANDALONE_SOCKET))) {
    const missing = await driverGate();
    return missing ? { mode: "unavailable", reason: driverGateReason(missing) } : null;
  }
  return {
    mode: "standalone",
    socketPath: STANDALONE_SOCKET,
    mcpCommand: driver,
    mcpArgs: ["mcp"],
    mcpEnv: { ...CUA_ENV },
  };
}

async function driverGate() {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "args="], {
      encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    });
    return parseDriverGate(stdout);
  } catch {
    return null;
  }
}

/** While CuaDriver waits for a grant, notices the moment it is given (its socket opens, or it asks for something else)
 * and starts again, so nobody has to restart anything. */
function watchDriverGate(missing) {
  clearInterval(gateWatch);
  const generation = lifecycleGeneration;
  const until = Date.now() + GATE_WATCH_MS;
  let busy = false;
  const stop = () => { clearInterval(gateWatch); gateWatch = null; };
  gateWatch = setInterval(async () => {
    if (busy) return;
    if (generation !== lifecycleGeneration || Date.now() > until) return stop();
    busy = true;
    try {
      const ready = await socketAlive(STANDALONE_SOCKET);
      const now = ready ? null : await driverGate();
      if (generation !== lifecycleGeneration) return;
      if (ready || now?.join() !== missing.join()) {
        stop();
        void startCua().catch((error) => console.error("[cua] Computer helper restart after a grant failed:", error));
      }
    } finally {
      busy = false;
    }
  }, GATE_POLL_MS);
  gateWatch.unref?.();
}

/** Accessibility and Screen Recording as they stand, without a prompt (AXIsProcessTrusted, CGPreflightScreenCaptureAccess). */
export function currentMacPermissions(prefs = systemPreferences) {
  return {
    accessibility: prefs.isTrustedAccessibilityClient(false),
    screenRecording: prefs.getMediaAccessStatus("screen") === "granted",
  };
}

async function startEmbedded(binary, signal, { ask }) {
  // The packaged app ships no general node_modules, so a bare package import only works in dev.
  const sdk = await loadEmbeddedSdk();
  signal.throwIfAborted();
  // CUA's embedding contract needs grants before the daemon starts, asked from Electron main so macOS attributes them here.
  // requestMacOSPermissions prompts (AXIsProcessTrustedWithOptions, CGRequestScreenCaptureAccess in cua-driver 0.28.2's
  // SDK), so only a person turning computer control on asks; every other start only checks.
  if (process.platform === "darwin") {
    const permissionStatus = ask ? sdk.requestMacOSPermissions() : currentMacPermissions();
    if (!sdk.hasRequiredMacOSPermissions(permissionStatus)) {
      const missing = [
        !permissionStatus.accessibility && "Accessibility",
        !permissionStatus.screenRecording && "Screen Recording",
      ].filter(Boolean).join(" and ");
      throw new Error(`${missing || "macOS permissions"} required; grant access in System Settings and restart Metal`);
    }
  }
  // The native SDK owns the child lifecycle but exposes no windowsHide option.
  const host = new sdk.EmbeddedCuaDriverHost(resolveEmbeddedDriverBinary(binary), HOST_BUNDLE_ID);
  try {
    const conn = await host.start({ signal });
    signal.throwIfAborted();
    embeddedHost = host;
    return {
      mode: "embedded",
      socketPath: conn.socketPath,
      mcpCommand: binary,
      mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
      mcpEnv: { ...CUA_ENV, CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
    };
  } catch (err) {
    try {
      await host.stop();
    } catch {
    }
    host.uniffiDestroy?.();
    throw err;
  }
}

export async function startCua({ attempt = 0, ask = false } = {}) {
  if (process.platform === "linux") return ensureLinuxRuntime().initialize();
  clearTimeout(retryTimer);
  retryTimer = null;
  clearInterval(gateWatch);
  gateWatch = null;
  lifecycleGeneration++;
  startupAbort?.abort();
  startupAbort = new AbortController();
  const { signal } = startupAbort;
  const binary = resolveDriverBinary();
  if (!binary) {
    return persistAndNotify({
      mode: "unavailable",
      reason: "cua-driver binary not found",
    });
  }

  const wantEmbedded =
    process.platform === "win32" || app.isPackaged || process.env.DUSK_CUA_EMBEDDED === "1";
  let nextConnection;

  if (wantEmbedded) {
    try {
      nextConnection = await startEmbedded(binary, signal, { ask });
    } catch (err) {
      signal.throwIfAborted();
      try {
        nextConnection = await attachStandalone(signal, { mayOpen: ask || !app.isPackaged });
      } catch (standaloneError) {
        signal.throwIfAborted();
        nextConnection = {
          mode: "unavailable",
          reason: `embedded host failed: ${driverFailure(err)}; standalone launch failed: ${standaloneError?.message ?? standaloneError}`,
        };
      }
      if (!nextConnection) {
        nextConnection = {
          mode: "unavailable",
          reason: `embedded host failed: ${driverFailure(err)}`,
        };
      }
    }
  } else if (process.platform === "darwin" && (await socketAlive(STANDALONE_SOCKET))) {
    // Never on Windows: the shared pipe belongs to whatever driver the user has, so it is never adopted implicitly.
    nextConnection = {
      mode: "standalone",
      socketPath: STANDALONE_SOCKET,
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: { ...CUA_ENV },
    };
  } else {
    try {
      nextConnection = await attachStandalone(signal);
      if (nextConnection?.mode === "standalone") nextConnection.mcpCommand = binary;
    } catch (error) {
      signal.throwIfAborted();
      console.error("[cua] Computer helper launch failed:", error);
    }
    nextConnection ??= {
      mode: "unavailable",
      reason: "The computer helper (CuaDriver) did not answer. Press Retry; if it still fails, quit and reopen Metal.",
    };
  }

  signal.throwIfAborted();
  const gated = process.platform === "darwin" && nextConnection.mode === "unavailable"
    ? driverGateFromReason(nextConnection.reason) : null;
  if (gated) watchDriverGate(gated);
  if (process.platform === "win32" && nextConnection.mode === "unavailable" && !driverBlocked(nextConnection.reason) && attempt < RETRY_AFTER_MS.length) {
    retryTimer = setTimeout(() => { retryTimer = null; void startCua({ attempt: attempt + 1 }).catch(() => {}); }, RETRY_AFTER_MS[attempt]);
    retryTimer.unref?.();
  }
  return persistAndNotify(nextConnection);
}

export async function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = await execFileAsync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
    maxBuffer: 65_536,
    env: { ...process.env, ...CUA_ENV },
    windowsHide: true,
  }).catch((error) => ({ stdout: error.stdout }));
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export async function stopCua() {
  clearTimeout(retryTimer);
  retryTimer = null;
  clearInterval(gateWatch);
  gateWatch = null;
  lifecycleGeneration++;
  startupAbort?.abort();
  startupAbort = null;
  if (linuxRuntime) {
    await linuxRuntime.shutdown();
    if (linuxBundleStage) {
      cleanupAppImageCuaBundle(linuxBundleStage);
      linuxBundleStage = null;
    }
    return;
  }
  const host = embeddedHost;
  embeddedHost = null;
  if (host) {
    try {
      await host.stop();
      host.uniffiDestroy?.();
    } catch {
    }
  }
  if (!startupAbort && connectionStore.get()) {
    persistAndNotify({ mode: "unavailable", reason: "desktop-host-stopped" });
  }
}

/** Starts computer control again on macOS and Windows; on macOS that asks for the permissions it lacks. One restart at a
 * time; a later explicit Stop (or quit) cancels it. */
function restartCua() {
  const platformLabel = process.platform === "darwin" ? "macOS" : "Windows";
  macRetry ??= (async () => {
    try {
      const stopping = stopCua();
      const generation = lifecycleGeneration;
      await stopping;
      if (generation !== lifecycleGeneration) throw new Error("Computer use restart cancelled");
      const connection = await startCua({ ask: true });
      const ready = connection?.mode === "embedded" || connection?.mode === "standalone";
      return {
        enabled: ready,
        status: ready ? "ready" : "error",
        reasonCode: ready ? undefined : "permissions-required",
        message: connection?.reason,
      };
    } catch (error) {
      console.error(`[cua] ${platformLabel} retry failed:`, error);
      return {
        enabled: false,
        status: "error",
        reasonCode: "permissions-required",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  })().finally(() => { macRetry = null; });
  return macRetry;
}

/** The person asked for computer control: started again on macOS and Windows (the Retry button's path), turned on on
 * Linux (its Enable button's). */
export async function requestComputerUse() {
  if (process.platform === "darwin" || process.platform === "win32") return restartCua();
  if (process.platform !== "linux") return null;
  try {
    await ensureLinuxRuntime().enable();
  } catch (error) {
    console.error("[cua] Linux enable failed:", error);
  }
  return ensureLinuxRuntime().getStatus();
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", localOnly("cua:connection", () => connectionStore.get()));
  ipcMain.handle("cua:permissions", localOnly("cua:permissions", () => cuaPermissionsStatus()));
  ipcMain.handle("cua:linux-status", localOnly("cua:linux-status", () =>
    process.platform === "linux"
      ? ensureLinuxRuntime().getStatus()
      : { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" },
  ));
  ipcMain.handle("cua:linux-enable", localOnly("cua:linux-enable", async () => {
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    try {
      await ensureLinuxRuntime().enable();
    } catch (error) {
      console.error("[cua] Linux enable failed:", error);
    }
    return ensureLinuxRuntime().getStatus();
  }));
  ipcMain.handle("cua:linux-disable", localOnly("cua:linux-disable", async () => {
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    try {
      await ensureLinuxRuntime().disable();
    } catch (error) {
      console.error("[cua] Linux disable failed:", error);
    }
    return ensureLinuxRuntime().getStatus();
  }));
  ipcMain.handle("cua:linux-retry", localOnly("cua:linux-retry", async () => {
    if (process.platform === "darwin" || process.platform === "win32") return restartCua();
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    try {
      await ensureLinuxRuntime().retry();
    } catch (error) {
      console.error("[cua] Linux retry failed:", error);
    }
    return ensureLinuxRuntime().getStatus();
  }));
}
