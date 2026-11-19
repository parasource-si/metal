/** The tray icon in `resourcesDir`: on macOS a template image (Electron loads its @2x beside it), elsewhere the logo. */
export function trayIcon(nativeImage, resourcesDir, platform = process.platform) {
  if (platform !== "darwin") return nativeImage.createFromPath(`${resourcesDir}/tray-icon.png`).resize({ width: 20, height: 20 });
  const image = nativeImage.createFromPath(`${resourcesDir}/trayTemplate.png`);
  image.setTemplateImage(true);
  return image;
}

// Retain the Windows notification-area identity across app restarts.
export function createSystemTray({ Tray, Menu, nativeImage, resourcesDir, platform, getWindow, onQuit }) {
  const tray = new Tray(trayIcon(nativeImage, resourcesDir, platform), "889af657-21b5-4ec9-b5d0-cb798cbdfd30");
  let hidden = false;
  const show = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    hidden = false;
    win.setSkipTaskbar(false);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  };
  tray.setToolTip("Metal");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Metal", click: show },
    { type: "separator" },
    { label: "Quit Metal", click: onQuit },
  ]));
  tray.on("click", show);
  tray.on("double-click", show);
  return {
    show,
    hide(win) { hidden = true; win.setSkipTaskbar(true); win.hide(); },
    isHidden() { return hidden; },
    windowShown(win) { hidden = false; win.setSkipTaskbar(false); },
    destroy() { if (!tray.isDestroyed()) tray.destroy(); },
  };
}
