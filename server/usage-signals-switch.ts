import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export interface UsageSignalsChoice { enabled: boolean }

/** the one "help improve Metal" switch: usage counts, the scrubbed notes about how sessions went, and (on the
 * desktop) crash reports. on unless the person turns it off (or DUSK_USAGE_SIGNALS=off).
 *
 * It is the account's switch too. A change made here is kept as `push` until a report to the account service gets
 * through, and the account's own state comes back on every report answer: the account turned off turns this off, the
 * account turned back on (after being seen off) turns it back on. */
export function createUsageSignalsSwitch(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const file = join(dataDir, "usage-signals.json");
  let on = true;
  // the salt for hashing bot, chat and routine ids in usage records; it never leaves this file
  let salt = "";
  // a local change the account has not heard yet (true is off), and the account's last answer
  let push: boolean | null = null, seen: boolean | null = null;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown; salt?: unknown; push?: unknown; seen?: unknown };
    on = saved.enabled !== false;
    if (typeof saved.salt === "string" && /^[A-Za-z0-9_-]{22,}$/.test(saved.salt)) salt = saved.salt;
    if (typeof saved.push === "boolean") push = saved.push;
    if (typeof saved.seen === "boolean") seen = saved.seen;
  } catch {}
  const write = () => writeFileAtomic(file, JSON.stringify({ enabled: on, salt, ...(push !== null ? { push } : {}), ...(seen !== null ? { seen } : {}) }), { mode: 0o600 });
  const enabled = () => on && env.DUSK_USAGE_SIGNALS !== "off";
  return {
    enabled,
    choice: (): UsageSignalsChoice => ({ enabled: enabled() }),
    /** the person's choice in this app; the account is told with the next report */
    set(next: Partial<UsageSignalsChoice>) {
      if (typeof next.enabled === "boolean") { on = next.enabled; push = !on; }
      write();
    },
    /** what the next report tells the account: true is off, null when nothing changed here */
    pending: (): boolean | null => push,
    /** a report carrying `value` got through */
    pushed(value: boolean) {
      if (push !== value) return;
      push = null; seen = value;
      try { write(); } catch {}
    },
    /** the account's switch as its report answer gave it (true is off); returns the choice when it changed it */
    fromAccount(optOut: boolean): UsageSignalsChoice | null {
      if (push !== null) return null;
      const before = seen;
      // a choice made before the account was told about it is told now
      if (!on && before === null) { push = true; try { write(); } catch {} return null; }
      seen = optOut;
      let changed = false;
      if (optOut && on) { on = false; changed = true; }
      else if (!optOut && before === true && !on) { on = true; changed = true; }
      if (changed || before !== seen) try { write(); } catch {}
      return changed ? { enabled: on } : null;
    },
    salt(): string {
      if (!salt) { salt = randomBytes(18).toString("base64url"); try { write(); } catch {} }
      return salt;
    },
  };
}
export type UsageSignalsSwitch = ReturnType<typeof createUsageSignalsSwitch>;
