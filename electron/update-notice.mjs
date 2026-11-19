export const METAL_RELEASES_URL = "https://github.com/parasource-si/metal/releases";
const DAY_MS = 24 * 60 * 60_000;

export function createUpdateNotice({ request, notify, open, memory, log = () => {}, firstDelayMs = 2 * 60_000, intervalMs = DAY_MS, timers = globalThis }) {
  let timer = null;
  async function check() {
    try {
      const response = await request("/api/updates/check", { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return null;
      const answer = await response.json();
      if (answer?.install !== "desktop" || answer.available !== true || typeof answer.latest !== "string" || typeof answer.releaseUrl !== "string") return null;
      if (!answer.releaseUrl.startsWith(`${METAL_RELEASES_URL}/`)) return null;
      let told = null;
      try { told = memory.read()?.told ?? null; } catch {}
      if (told === answer.latest) return null;
      memory.write({ told: answer.latest });
      notify({ title: `Metal ${answer.latest} is available`, body: "Open the Metal releases page.", click: () => open(answer.releaseUrl) });
      return answer.latest;
    } catch (error) {
      log(`update notice: check failed (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  }
  return {
    check,
    start() {
      if (timer) return;
      const run = (delay) => { timer = timers.setTimeout(() => { void check().finally(() => run(intervalMs)); }, delay); timer?.unref?.(); };
      run(firstDelayMs);
    },
    stop() { if (timer) timers.clearTimeout(timer); timer = null; },
  };
}
