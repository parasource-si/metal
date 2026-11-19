// Security invariant: once the OS check was offered and the person failed, cancelled or let it time out, the answer is
// false; only a check that is not there to offer falls back to the in-app confirm. Only pass/fail is ever logged.
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { helloOutcome as windowsHelloOutcome, runWindowsHello, windowHandleText } from "./windows-hello.mjs";

export const PRESENCE_TIMEOUT_MS = 120_000;
export const DEFAULT_PRESENCE_REASON = "show a code that links a phone";
const MAX_REASON = 120;

/** A renderer's reason, cleaned; a page from elsewhere than this app's own server always gets the fixed one. */
export function presenceReason(raw, trustedSender) {
  if (!trustedSender || typeof raw !== "string") return DEFAULT_PRESENCE_REASON;
  const clean = raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON).trim();
  return clean || DEFAULT_PRESENCE_REASON;
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); }),
  ]);
}

/** polkit's own password prompt through pkexec: 0 is a pass, 126 a dismissed dialog; no agent means it cannot ask. */
export function linuxPkexecCheck({ spawn = nodeSpawn, exists = fs.existsSync, env = process.env, timeoutMs = PRESENCE_TIMEOUT_MS } = {}) {
  const pkexec = ["/usr/bin/pkexec", "/bin/pkexec"].find((file) => exists(file));
  const program = ["/usr/bin/true", "/bin/true"].find((file) => exists(file));
  if (!pkexec || !program || !(env.DISPLAY || env.WAYLAND_DISPLAY)) return Promise.resolve("unavailable");
  return new Promise((resolve) => {
    let stderr = "", settled = false, child;
    const finish = (outcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome); } };
    try {
      // --disable-internal-agent: with no graphical agent pkexec would otherwise wait on a terminal nobody sees.
      child = spawn(pkexec, ["--disable-internal-agent", program], { stdio: ["ignore", "ignore", "pipe"], env });
    } catch {
      resolve("unavailable");
      return;
    }
    const timer = setTimeout(() => { child.kill(); finish("fail"); }, timeoutMs);
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => { if (stderr.length < 2048) stderr += chunk; });
    child.on("error", () => finish("unavailable"));
    child.on("close", (code) => {
      if (code === 0) finish("pass");
      else if (code === 127 && /no authentication agent/i.test(stderr)) finish("unavailable");
      else finish("fail");
    });
  });
}

/**
 * `confirm(reason)`: the in-app dialog, parented to the app's window. `windowsHello({ reason, hwnd })` resolves the
 * helper's output (electron/windows-hello.mjs); `helloOutcome` maps it. `linuxCheck()` resolves pass|fail|unavailable.
 */
export function createUserPresence({ platform = process.platform, systemPreferences, confirm, windowsHello = runWindowsHello, helloOutcome = windowsHelloOutcome, linuxCheck = linuxPkexecCheck, log = () => {}, timeoutMs = PRESENCE_TIMEOUT_MS }) {
  let inflight = null;

  async function inApp(reason) {
    try { return (await withTimeout(confirm(reason), timeoutMs, false)) === true; } catch { return false; }
  }

  async function check(reason, hwnd) {
    if (platform === "darwin") {
      let canTouch = false;
      try { canTouch = systemPreferences?.canPromptTouchID?.() === true; } catch {}
      if (!canTouch) return ["confirm", await inApp(reason)];
      try {
        const answered = await withTimeout(systemPreferences.promptTouchID(reason).then(() => true), timeoutMs, false);
        return ["touch-id", answered === true];
      } catch {
        return ["touch-id", false];
      }
    }
    if (platform === "win32") {
      const outcome = helloOutcome(await windowsHello({ reason: `Metal wants to ${reason}.`, hwnd, timeoutMs }));
      if (outcome === "unavailable") return ["confirm", await inApp(reason)];
      return ["windows-hello", outcome === "pass"];
    }
    const outcome = await linuxCheck({ timeoutMs });
    if (outcome === "unavailable") return ["confirm", await inApp(reason)];
    return ["polkit", outcome === "pass"];
  }

  /** One check at a time: a second call while one is open shares its answer. */
  return function requireUserPresence(reason = DEFAULT_PRESENCE_REASON, { hwnd = "0" } = {}) {
    inflight ??= check(reason, hwnd)
      .then(([method, ok]) => { log(`user presence: ${method} ${ok ? "pass" : "fail"}`); return ok; })
      .catch(() => { log("user presence: fail"); return false; })
      .finally(() => { inflight = null; });
    return inflight;
  };
}

/** `presence:require` for window.duskDesktop.requireUserPresence. `guard` decides which senders may ask; `trusted(event)`
 * whether the page may word the reason itself. */
export function installUserPresence({ ipcMain, guard, dialog, systemPreferences, log, window, trusted, platform = process.platform }) {
  const parent = () => { const win = window(); return win && !win.isDestroyed() ? win : null; };
  const userPresence = createUserPresence({
    platform,
    systemPreferences,
    log,
    confirm: async (reason) => {
      const win = parent();
      if (!win) return false;
      const { response } = await dialog.showMessageBox(win, {
        type: "question", message: "Confirm it's you", detail: `Metal wants to ${reason}.`,
        buttons: ["Continue", "Cancel"], defaultId: 1, cancelId: 1,
      });
      return response === 0;
    },
  });
  ipcMain.handle("presence:require", guard((event, reason) => {
    const win = parent();
    return userPresence(presenceReason(reason, trusted(event)), { hwnd: win ? windowHandleText(win.getNativeWindowHandle()) : "0" });
  }));
  return userPresence;
}
