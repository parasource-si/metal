const RETRY_LOAD_MS = 2000;

/** The background server could not come back by itself: one plain sentence, and one button restarts dusk bot. */
export function offerRestart({ dialog, app }) {
  return dialog.showMessageBox({
    type: "error",
    message: "The bot server stopped",
    detail: "Restart Metal to bring it back.",
    buttons: ["Restart Metal", "Not now"],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response !== 0) return;
    app.relaunch();
    app.quit();
  });
}

/** Loads `url` in `win`, trying once more by itself before `failedPage(url)` says what failed and what to press.
 * Electron fires did-fail-load for a rejected loadURL too, so that event alone decides. */
export function loadWithOneRetry(win, url, failedPage, log = () => {}) {
  let retried = false;
  win.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || win.isDestroyed() || failedUrl.startsWith("data:")) return;
    log(`load failed: ${code} ${description}`);
    if (retried) return void win.loadURL(failedPage(url)).catch(() => {});
    retried = true;
    setTimeout(() => { if (!win.isDestroyed()) void win.loadURL(url).catch(() => {}); }, RETRY_LOAD_MS);
  });
  void win.loadURL(url).catch(() => {});
}
