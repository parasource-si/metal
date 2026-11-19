// Main's side of the debug trail (trail.mjs): the renderer's events over IPC, sleep and wake, quitting, and the
// "export usage log" flow (Support, Settings > advanced, Help menu). An export reads the last 7 days of every trail file
// here, scrubs each event a second time (scrubForExport) and saves one .jsonl the person picks a place for; then it
// offers to send it to support by email, with the file shown in Finder to attach.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { TRAIL_DAYS, TRAIL_EXPORT_PREVIEW, readTrail, scrubForExport, trail, trailError, trailFrom } from "./trail.mjs";

export const SUPPORT_EMAIL = "hello@dusk.bot";
const RENDERER_PER_MINUTE = 3000;

/** the events of the last `days` in `dir`, scrubbed for leaving this computer, one JSON line each */
export async function exportTrailText(dir, { now = Date.now(), days = TRAIL_DAYS, home = os.homedir(), salt = randomBytes(8).toString("hex") } = {}) {
  const events = await readTrail(dir, { sinceMs: now - days * 24 * 60 * 60 * 1000 });
  const lines = [JSON.stringify({ ts: new Date(now).toISOString(), ev: "export.header", about: TRAIL_EXPORT_PREVIEW, events: events.length, days })];
  for (const event of events) {
    const clean = scrubForExport(event, { home, salt });
    if (clean) lines.push(JSON.stringify(clean));
  }
  return { text: `${lines.join("\n")}\n`, count: events.length };
}

export const usageLogFileName = (date = new Date()) => `dusk-bot-usage-log-${date.toISOString().slice(0, 10)}.jsonl`;

/**
 * @param {{ ipcMain: any, app: any, dialog: any, shell: any, powerMonitor?: any, BrowserWindow: any, logDir: string,
 *   writer: { flush(): Promise<void>, flushSync(): void }, accept(event: any): boolean, linkPath(event: any): object | null }} deps
 */
export function installTrailMain({ ipcMain, app, dialog, shell, powerMonitor, BrowserWindow, logDir, writer, accept, linkPath }) {
  let windowStart = 0, inWindow = 0;
  ipcMain.on("trail:write", (event, batch) => {
    try {
      if (!accept(event) || !Array.isArray(batch)) return;
      const now = Date.now();
      if (now - windowStart > 60_000) { windowStart = now; inWindow = 0; }
      if (inWindow > RENDERER_PER_MINUTE) return;
      inWindow += batch.length;
      // which way this page reaches its server right now, on the events that ask "was it direct or relay?"
      let path = null;
      trailFrom("renderer", batch, (ev) => {
        if (!/^(takeover|desktop|chat\.send|files)\b/.test(ev)) return {};
        path ??= linkPath(event) ?? { place: "local" };
        return { link: path };
      });
    } catch {}
  });

  ipcMain.handle("trail:export", async (event) => {
    if (!accept(event)) throw new Error("This page cannot export the usage log.");
    return exportUsageLog(BrowserWindow.fromWebContents(event.sender) ?? undefined);
  });

  async function exportUsageLog(owner) {
    trail("export.start", { what: "usage-log" });
    try {
      await writer.flush();
      const { text, count } = await exportTrailText(logDir);
      const chosen = await dialog.showSaveDialog(owner, {
        title: "Export usage log",
        message: TRAIL_EXPORT_PREVIEW,
        defaultPath: path.join(app.getPath("downloads"), usageLogFileName()),
        filters: [{ name: "Usage log", extensions: ["jsonl"] }],
      });
      if (chosen.canceled || !chosen.filePath) return { saved: false, sent: false };
      await writePrivate(chosen.filePath, text);
      trail("export.saved", { events: count });
      const ask = await dialog.showMessageBox(owner, {
        type: "info",
        message: "Send the usage log to Dusk support?",
        detail: `${TRAIL_EXPORT_PREVIEW}.\n\nYour email app opens a new message to ${SUPPORT_EMAIL}; attach the file from the folder that opens.`,
        buttons: ["Send by email", "Done"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (ask.response !== 0) return { saved: true, sent: false };
      shell.showItemInFolder(chosen.filePath);
      const subject = encodeURIComponent("Metal usage log");
      const body = encodeURIComponent(`What happened, and roughly when:\n\n\n(The usage log ${path.basename(chosen.filePath)} is attached.)`);
      await shell.openExternal(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`);
      trail("export.sent", { how: "email" });
      return { saved: true, sent: true };
    } catch (error) {
      trailError("export.failed", error);
      throw new Error("The usage log could not be saved. Try another folder.");
    }
  }

  for (const name of ["suspend", "resume", "lock-screen", "unlock-screen", "on-ac", "on-battery", "shutdown"]) {
    try { powerMonitor?.on?.(name, () => trail(`power.${name}`)); } catch {}
  }
  app.on("will-quit", () => { trail("app.quit"); writer.flushSync(); });
  // a monitor only: node's own fatal path (uncaught errors and, by default, unhandled rejections) is unchanged
  process.on("uncaughtExceptionMonitor", (error, origin) => { trailError(origin === "unhandledRejection" ? "main.unhandled-rejection" : "main.uncaught", error); writer.flushSync(); });
  app.on("render-process-gone", (_event, _contents, details) => trail("renderer.gone", { reason: details?.reason, exitCode: details?.exitCode }));
  app.on("child-process-gone", (_event, details) => trail("child.gone", { type: details?.type, reason: details?.reason, exitCode: details?.exitCode, service: details?.serviceName }));

  return { exportUsageLog };
}

async function writePrivate(file, text) {
  if (process.platform === "win32") { await fs.promises.writeFile(file, text, { mode: 0o600 }); return; }
  const handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text, "utf8"); } finally { await handle.close(); }
}
