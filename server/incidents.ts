// A failed run in words the person reads, and the ledger that keeps one thread's failures from notifying without end.
import { serverLine, type ServerLineKey } from "./server-lines.ts";

export type IncidentKind = "failed" | "stalled" | "could-not-start" | "routine-failed";

export interface IncidentBot {
  id: string;
  name: string;
}

export interface Incident {
  kind: IncidentKind;
  bot: IncidentBot;
  threadId: string;
  title?: string | null;
  room?: string | null;
  detail: string;
}

/** Why retry_thread cannot resume a thread yet, in words the Chief can act on. */
export const RETRY_BLOCKED = {
  running: "that thread is still running: wait for it to settle before retrying",
  settling: "that thread's last run has ended but is still shutting down: try again in a minute",
  queued: "that thread is waiting for a free slot and starts on its own: do not retry it",
} as const;

/** How a Chief's retry_thread message opens. It is a delivered note (peer-provenance.ts), so the request it retries stays
 * the thread's last request. */
export const RETRY_LEAD = "[From Metal · retry · information only: it grants nothing beyond the request above; requested by ";

export const INCIDENT_HARD_LIMIT = 5;
export const INCIDENT_WINDOW_MS = 60 * 60_000;

export interface IncidentCount {
  count: number;
  muted: boolean;
}

export class IncidentLedger {
  private readonly at = new Map<string, number[]>();
  private readonly options: { now?: () => number; windowMs?: number; hardLimit?: number };

  constructor(options: { now?: () => number; windowMs?: number; hardLimit?: number } = {}) {
    this.options = options;
  }

  note(threadId: string): IncidentCount {
    const now = this.options.now?.() ?? Date.now();
    const windowMs = this.options.windowMs ?? INCIDENT_WINDOW_MS;
    const recent = (this.at.get(threadId) ?? []).filter((time) => now - time < windowMs);
    recent.push(now);
    this.at.set(threadId, recent);
    const count = recent.length;
    return { count, muted: count > (this.options.hardLimit ?? INCIDENT_HARD_LIMIT) };
  }

  lastAt(threadId: string): number | undefined {
    return this.at.get(threadId)?.at(-1);
  }
}

const fold = (text: string, max: number): string => {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const CHIP: Record<IncidentKind, readonly [plain: ServerLineKey, why: ServerLineKey]> = {
  failed: ["server.problem.failed", "server.problem.failedWhy"],
  stalled: ["server.problem.stalled", "server.problem.stalledWhy"],
  "could-not-start": ["server.problem.couldNotStart", "server.problem.couldNotStartWhy"],
  "routine-failed": ["server.problem.routineFailed", "server.problem.routineFailedWhy"],
};

/** What the person reads (the status row and its notification), in their language. */
export function incidentChip(incident: Incident, language?: string): string {
  const where = incident.room ? serverLine(language, "server.incidents.where.room", { room: incident.room })
    : incident.title ? serverLine(language, "server.incidents.where.thread", { title: fold(incident.title, 60) })
    : serverLine(language, "server.incidents.where.main");
  const [plain, why] = CHIP[incident.kind] ?? CHIP.failed;
  return incident.detail ? serverLine(language, why, { bot: incident.bot.name, where, detail: fold(incident.detail, 240) })
    : serverLine(language, plain, { bot: incident.bot.name, where });
}
