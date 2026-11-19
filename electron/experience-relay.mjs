import { ownUtility } from "./utility-names.mjs";

export const EVERY_MS = 30_000;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** Takes this computer's experience signals from the local server (GET /api/dashboard/experience) and hands each to the
 * product events as an app_action with its own time. Only while the page sends its own events (usage analytics on); the
 * server keeps none while "help improve Metal" is off. */
export function createExperienceRelay({ localRequest, events, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, closed = false, running = null;

  async function tick() {
    if (closed || !events.install()) return 0;
    const answer = await localRequest("/api/dashboard/experience");
    if (!answer.ok) { await answer.body?.cancel?.().catch(() => {}); return 0; }
    const { signals } = await answer.json();
    let sent = 0;
    for (const signal of Array.isArray(signals) ? signals.slice(0, 200) : []) {
      if (!signal || typeof signal !== "object" || typeof signal.name !== "string" || !NAME.test(signal.name)) continue;
      if (events.action(signal.name, signal.props && typeof signal.props === "object" ? signal.props : {}, Number(signal.at) || undefined)) sent++;
    }
    return sent;
  }
  function schedule(delay) {
    if (closed || timer !== null) return;
    timer = setTimer(() => { timer = null; void run(); }, delay);
    timer?.unref?.();
  }
  async function run() {
    if (running) return running;
    running = tick().catch(() => 0);
    try { return await running; } finally { running = null; schedule(EVERY_MS); }
  }
  return {
    start() { schedule(EVERY_MS); },
    run,
    close() { closed = true; if (timer !== null) clearTimer(timer); timer = null; },
  };
}

const CRASHES = new Set(["crashed", "oom", "launch-failed", "integrity-failure", "abnormal-exit", "killed"]);
/** the crash signal's props for an Electron process-gone event, or null for an ordinary exit, one of our own utility
 * processes (its owner reports it) or any exit while the app quits or the computer's session ends */
export function crashProps(type, reason, { name, ending = false } = {}) {
  if (ending || !CRASHES.has(reason) || ownUtility({ type, name })) return null;
  const kind = type === "page" ? "page" : type === "GPU" ? "gpu" : type === "Utility" ? "utility" : type === "server" ? "server" : "other";
  return { kind, reason: reason.replace(/-/g, "_") };
}

/** the stage an app update failed at, from its error message */
export function updateFailStage(message) {
  const text = String(message ?? "");
  // installer and http failures first: their words (a signature, a SHA256SUMS url) would read as another stage
  if (/install|squirrel|prepare/i.test(text)) return "install";
  if (/ answered \d{3}$|download/i.test(text)) return "download";
  if (/manifest|signed|release .* has no zip/i.test(text)) return "manifest";
  if (/checksum|SHA256|sha-?256/i.test(text)) return "checksum";
  if (/fetch|network|HTTP|ENOTFOUND|ECONN|ETIMEDOUT|abort|socket|terminated|stalled/i.test(text)) return "download";
  return "other";
}
