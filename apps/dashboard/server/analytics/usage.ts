// What people use Dusk for: the usage section of workspace reports (shared/usage-signals.ts), kept raw for
// USAGE_RETENTION_DAYS and rolled up per day into counts that are kept. Records hold words, counts and times, plus the
// scrubbed summaries a workspace wrote; never message content.
import type { Db } from "mongodb";
import { USAGE_REASONS, type UsagePlace, type UsageDigest, type UsageFrustration, type UsageReport, type UsageRun, type UsageSession, type UsageSignal, type UsageSnapshot, type UsageTurn } from "../../../../shared/usage-signals.ts";
import { DAY_MS, dayOf } from "./events.ts";

export const USAGE_RETENTION_DAYS = 90;
/** per person per day counts feed the power-user and active-day views; kept longer than raw records, not forever */
export const PEOPLE_RETENTION_DAYS = 400;
/** turn time buckets in seconds; a percentile reads as its bucket's upper edge */
export const LATENCY_EDGES = [2, 5, 10, 20, 30, 60, 120, 300, 600, Infinity] as const;
export const latencyBucket = (ms: number) => LATENCY_EDGES.findIndex(edge => ms / 1000 <= edge);

export type UsageKind = "turn" | "run" | "frustration" | "session" | "digest" | "signal";
type Kind = UsageKind;
/** where the workspace ran and which app version, taken from the workspace as its notes arrived; only notes carry it */
export interface UsageRan { place: UsagePlace; os?: string; version?: string }
export interface UsageRecord { id: string; kind: Kind; at: number; accountId: string; workspaceId: string; ran?: UsageRan; data: UsageTurn | UsageRun | UsageFrustration | UsageSession | UsageDigest | UsageSignal }
/** `appTurns`: turns that used a connected app, so the adoption view can count people who use one; `bots` and `chats`:
 * turns per salted bot and chat hash, for per-bot share and turns per chat */
export interface PersonDay { day: string; accountId: string; turns: number; failed: number; runs: number; frustrations: number; appTurns: number; bots?: Record<string, number>; chats?: Record<string, number> }
type PersonCounts = Partial<Pick<PersonDay, "turns" | "failed" | "runs" | "frustrations" | "appTurns">>;
/** one routine by its salted hash: its first and last run, for "still running a week later" */
export interface RoutineSpan { workspaceId: string; accountId: string; routine: string; first: number; last: number; runs: number }
export interface SnapshotRow { workspaceId: string; accountId: string; at: number; snapshot: UsageSnapshot }

export interface UsageStore {
  /** the records not seen before; a record sent twice is kept once */
  insert(records: UsageRecord[]): Promise<UsageRecord[]>;
  bump(day: string, inc: Record<string, number>): Promise<void>;
  /** adds to a person's day; true when it is the person's first record that day */
  person(day: string, accountId: string, inc: PersonCounts, maps?: { bots?: Record<string, number>; chats?: Record<string, number> }): Promise<boolean>;
  routine(span: Omit<RoutineSpan, "runs">): Promise<void>;
  routines(): Promise<RoutineSpan[]>;
  snapshot(row: SnapshotRow): Promise<void>;
  daily(fromDay: string, toDay: string): Promise<Array<{ day: string; c: Record<string, number> }>>;
  people(fromDay: string, toDay: string): Promise<PersonDay[]>;
  snapshots(): Promise<SnapshotRow[]>;
  records(kind: Kind, since: number, until: number, limit: number): Promise<UsageRecord[]>;
  /** true the first time a key is seen; kept forever */
  once(key: string): Promise<boolean>;
  forget(accountId: string): Promise<void>;
  forgetWorkspace(workspaceId: string): Promise<void>;
}

export function memoryUsageStore(now: () => number = Date.now): UsageStore {
  const spans = new Map<string, RoutineSpan>();
  const records = new Map<string, UsageRecord>(), daily = new Map<string, Record<string, number>>(), people = new Map<string, PersonDay>(), snaps = new Map<string, SnapshotRow>(), marks = new Set<string>();
  const sweep = () => { const cutoff = now() - USAGE_RETENTION_DAYS * DAY_MS; for (const [id, record] of records) if (record.at < cutoff) records.delete(id); };
  return {
    async insert(list) {
      sweep();
      const fresh: UsageRecord[] = [];
      for (const record of list) { const key = `${record.workspaceId}:${record.id}`; if (!records.has(key)) { records.set(key, record); fresh.push(record); } }
      return fresh;
    },
    async bump(day, inc) { const row = daily.get(day) ?? {}; for (const [key, by] of Object.entries(inc)) row[key] = (row[key] ?? 0) + by; daily.set(day, row); },
    async person(day, accountId, inc, maps = {}) {
      const key = `${day}|${accountId}`, row = people.get(key), first = !row;
      const next: PersonDay = row ?? { day, accountId, turns: 0, failed: 0, runs: 0, frustrations: 0, appTurns: 0 };
      for (const [field, by] of Object.entries(inc)) (next as unknown as Record<string, number>)[field]! += by ?? 0;
      for (const kind of ["bots", "chats"] as const) for (const [hash, by] of Object.entries(maps[kind] ?? {})) { const map = (next[kind] ??= {}); map[hash] = (map[hash] ?? 0) + by; }
      people.set(key, next);
      return first;
    },
    async routine(span) {
      const key = `${span.workspaceId}|${span.routine}`, row = spans.get(key);
      spans.set(key, row ? { ...row, first: Math.min(row.first, span.first), last: Math.max(row.last, span.last), runs: row.runs + 1 } : { ...span, runs: 1 });
    },
    async routines() { return [...spans.values()]; },
    async snapshot(row) { snaps.set(row.workspaceId, row); },
    async daily(fromDay, toDay) { return [...daily].filter(([day]) => day >= fromDay && day <= toDay).map(([day, c]) => ({ day, c: { ...c } })); },
    async people(fromDay, toDay) { return [...people.values()].filter(row => row.day >= fromDay && row.day <= toDay); },
    async snapshots() { return [...snaps.values()]; },
    async records(kind, since, until, limit) { return [...records.values()].filter(r => r.kind === kind && r.at >= since && r.at < until).sort((a, b) => b.at - a.at).slice(0, limit); },
    async once(key) { if (marks.has(key)) return false; marks.add(key); return true; },
    async forget(accountId) {
      for (const [key, record] of records) if (record.accountId === accountId) records.delete(key);
      for (const [key, row] of people) if (row.accountId === accountId) people.delete(key);
      for (const [key, row] of snaps) if (row.accountId === accountId) snaps.delete(key);
      for (const [key, row] of spans) if (row.accountId === accountId) spans.delete(key);
    },
    async forgetWorkspace(workspaceId) {
      for (const [key, record] of records) if (record.workspaceId === workspaceId) records.delete(key);
      snaps.delete(workspaceId);
    },
  };
}

type RecordDoc = { _id: string; kind: Kind; at: Date; accountId: string; workspaceId: string; ran?: UsageRan; data: UsageRecord["data"] };
/** usage_events (TTL on `at`), usage_daily (kept), usage_people (TTL on `at`), usage_snapshots (one per workspace) */
export async function mongoUsageStore(db: Db): Promise<UsageStore> {
  const events = db.collection<RecordDoc>("usage_events"), daily = db.collection<{ _id: string; day: string; c: Record<string, number> }>("usage_daily");
  const people = db.collection<{ _id: string; day: string; accountId: string; at: Date; turns: number; failed: number; runs: number; frustrations: number; appTurns: number }>("usage_people");
  const snaps = db.collection<{ _id: string; accountId: string; at: Date; snapshot: UsageSnapshot }>("usage_snapshots"), marks = db.collection<{ _id: string }>("usage_marks");
  const spans = db.collection<{ _id: string; workspaceId: string; accountId: string; routine: string; first: Date; last: Date; runs: number }>("usage_routines");
  await Promise.all([
    events.createIndexes([{ key: { at: 1 }, expireAfterSeconds: USAGE_RETENTION_DAYS * 86_400 }, { key: { kind: 1, at: -1 } }, { key: { accountId: 1 } }, { key: { workspaceId: 1 } }]),
    people.createIndexes([{ key: { at: 1 }, expireAfterSeconds: PEOPLE_RETENTION_DAYS * 86_400 }, { key: { day: 1 } }, { key: { accountId: 1 } }]),
    snaps.createIndexes([{ key: { accountId: 1 } }]),
    spans.createIndexes([{ key: { last: 1 }, expireAfterSeconds: PEOPLE_RETENTION_DAYS * 86_400 }, { key: { accountId: 1 } }]),
  ]);
  const toRecord = (doc: RecordDoc): UsageRecord => ({ id: doc._id.slice(doc.workspaceId.length + 1), kind: doc.kind, at: doc.at.getTime(), accountId: doc.accountId, workspaceId: doc.workspaceId, ...(doc.ran ? { ran: doc.ran } : {}), data: doc.data });
  return {
    async insert(list) {
      if (!list.length) return [];
      const docs = list.map(record => ({ _id: `${record.workspaceId}:${record.id}`, kind: record.kind, at: new Date(record.at), accountId: record.accountId, workspaceId: record.workspaceId, ...(record.ran ? { ran: record.ran } : {}), data: record.data }));
      const failed = new Set<number>();
      try { await events.insertMany(docs, { ordered: false }); } catch (error) {
        const errors = (error as { writeErrors?: Array<{ index: number; code: number }> | { index: number; code: number } }).writeErrors;
        const list_ = Array.isArray(errors) ? errors : errors ? [errors] : null;
        if (!list_ || list_.some(item => item.code !== 11000)) throw error;
        for (const item of list_) failed.add(item.index);
      }
      return list.filter((_, index) => !failed.has(index));
    },
    async bump(day, inc) { await daily.updateOne({ _id: day }, { $setOnInsert: { day }, $inc: Object.fromEntries(Object.entries(inc).map(([key, by]) => [`c.${key}`, by])) }, { upsert: true }); },
    async person(day, accountId, inc, maps = {}) {
      const mapped = Object.fromEntries((["bots", "chats"] as const).flatMap(kind => Object.entries(maps[kind] ?? {}).filter(([hash]) => /^[A-Za-z0-9_-]{10}$/.test(hash)).map(([hash, by]) => [`${kind}.${hash}`, by])));
      const result = await people.updateOne({ _id: `${day}|${accountId}` }, { $setOnInsert: { day, accountId, at: new Date(`${day}T12:00:00Z`) }, $inc: { turns: 0, failed: 0, runs: 0, frustrations: 0, appTurns: 0, ...inc, ...mapped } }, { upsert: true });
      return result.upsertedCount === 1;
    },
    async routine(span) {
      await spans.updateOne({ _id: `${span.workspaceId}|${span.routine}` }, { $setOnInsert: { workspaceId: span.workspaceId, accountId: span.accountId, routine: span.routine },
        $min: { first: new Date(span.first) }, $max: { last: new Date(span.last) }, $inc: { runs: 1 } }, { upsert: true });
    },
    async routines() { return (await spans.find({}).toArray()).map(doc => ({ workspaceId: doc.workspaceId, accountId: doc.accountId, routine: doc.routine, first: doc.first.getTime(), last: doc.last.getTime(), runs: doc.runs })); },
    async snapshot(row) { await snaps.replaceOne({ _id: row.workspaceId }, { accountId: row.accountId, at: new Date(row.at), snapshot: row.snapshot }, { upsert: true }); },
    async daily(fromDay, toDay) { return (await daily.find({ _id: { $gte: fromDay, $lte: toDay } }).toArray()).map(doc => ({ day: doc.day, c: doc.c ?? {} })); },
    async people(fromDay, toDay) {
      return (await people.find({ day: { $gte: fromDay, $lte: toDay } }, { projection: { _id: 0, at: 0 } }).toArray()) as unknown as PersonDay[];
    },
    async snapshots() { return (await snaps.find({}).toArray()).map(doc => ({ workspaceId: doc._id, accountId: doc.accountId, at: doc.at.getTime(), snapshot: doc.snapshot })); },
    async records(kind, since, until, limit) { return (await events.find({ kind, at: { $gte: new Date(since), $lt: new Date(until) } }).sort({ at: -1 }).limit(limit).toArray()).map(toRecord); },
    async once(key) { try { await marks.insertOne({ _id: key }); return true; } catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; } },
    async forget(accountId) { await Promise.all([events.deleteMany({ accountId }), people.deleteMany({ accountId }), snaps.deleteMany({ accountId }), spans.deleteMany({ accountId })]); },
    async forgetWorkspace(workspaceId) { await Promise.all([events.deleteMany({ workspaceId }), snaps.deleteOne({ _id: workspaceId })]); },
  };
}

/** a frustration's problem group: engine, category and the first app or tool it touched */
export const problemKey = (f: Pick<UsageFrustration, "engine" | "category" | "apps" | "tools">) => `${f.engine}|${f.category}|${f.apps[0] ?? f.tools.find(tool => tool !== "memory" && tool !== "other") ?? "none"}`;

/** the day's counters a set of fresh records adds, keyed flat so they sum across days */
export function rollup(records: UsageRecord[]): Map<string, Record<string, number>> {
  const days = new Map<string, Record<string, number>>();
  const add = (day: string, key: string, by = 1) => { const row = days.get(day) ?? {}; row[key] = (row[key] ?? 0) + by; days.set(day, row); };
  for (const record of records) {
    const day = dayOf(record.at);
    if (record.kind === "turn") {
      const t = record.data as UsageTurn, failed = t.outcome === "failed", bucket = latencyBucket(t.ms);
      add(day, "turns"); add(day, t.outcome); add(day, `lat:${bucket}`); add(day, `ms`, t.ms);
      if (t.firstMs !== undefined) { const first = latencyBucket(t.firstMs); add(day, `first:${first}`); add(day, `first_engine:${t.engine}:${first}`); if (t.model) add(day, `first_model:${t.model}:${first}`); }
      if (t.model) { add(day, `model:${t.model}`); add(day, `lat_model:${t.model}:${bucket}`); if (failed) add(day, `model_fail:${t.model}`); }
      for (const tool of t.failedTools ?? []) add(day, `tool_err:${tool}`);
      for (const app of t.failedApps ?? []) add(day, `app_err:${app}`);
      for (const action of t.actions ?? []) add(day, `action:${action}`);
      add(day, `engine:${t.engine}`); add(day, `lat_engine:${t.engine}:${bucket}`); add(day, `category:${t.category}`); add(day, `from:${t.from}`); add(day, `place:${t.place}`);
      if (t.room) add(day, "room");
      for (const tool of t.tools) add(day, `tool:${tool}`);
      for (const app of t.apps) add(day, `app:${app}`);
      if (failed) {
        const reason = t.reason ?? "unknown";
        add(day, `engine_fail:${t.engine}`); add(day, `category_fail:${t.category}`); add(day, `reason:${reason}`); add(day, `reason_engine:${t.engine}:${reason}`);
        for (const tool of t.tools) { add(day, `tool_fail:${tool}`); add(day, `reason_tool:${tool}:${reason}`); }
        for (const app of t.apps) { add(day, `app_fail:${app}`); add(day, `reason_app:${app}:${reason}`); }
      }
      if (t.outcome === "cancelled") add(day, `engine_cancel:${t.engine}`);
    } else if (record.kind === "run") {
      const r = record.data as UsageRun;
      add(day, "runs"); add(day, `run:${r.trigger}`);
      if (r.every) { add(day, `every:${r.every}`); if (r.outcome === "failed") add(day, `every_fail:${r.every}`); }
      if (r.ms !== undefined) add(day, `run_ms:${latencyBucket(r.ms)}`);
      if (r.outcome === "failed") { add(day, "run_failed"); add(day, `run_fail:${r.trigger}`); add(day, `run_reason:${r.reason ?? "unknown"}`); }
    } else if (record.kind === "frustration") {
      const f = record.data as UsageFrustration;
      add(day, "frustrations"); add(day, `fr_group:${problemKey(f)}`);
      for (const signal of f.signals) add(day, `fr_signal:${signal}`);
    } else if (record.kind === "session") {
      add(day, "sessions");
    } else if (record.kind === "signal") {
      const g = record.data as UsageSignal;
      add(day, `sig:${g.name}`);
      for (const [key, value] of Object.entries(g.props)) if (typeof value === "string" || typeof value === "number") add(day, `sig:${g.name}:${key}:${value}`);
    } else add(day, "digests");
  }
  return days;
}

/** the place the report's turns ran most, else what the workspace's kind says; the version as the workspace reported it */
export function ranOf(report: UsageReport, from?: { kind?: string; version?: string }): UsageRan | undefined {
  const count = new Map<UsagePlace, number>();
  for (const turn of report.turns) count.set(turn.place, (count.get(turn.place) ?? 0) + 1);
  const seen = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  const place = seen ?? (from?.kind ? from.kind === "vps" ? "server" : "desktop" : undefined);
  if (!place) return undefined;
  const version = from?.version && /^[\w.+-]{1,20}$/.test(from.version) ? from.version : undefined;
  const os = from?.kind && /^[a-z]{2,10}$/.test(from.kind) ? from.kind : undefined;
  return { place, ...(os ? { os } : {}), ...(version ? { version } : {}) };
}

export function createUsage(options: {
  store: UsageStore; now?: () => number;
  /** the account turned "help improve Metal" off */
  optedOut(accountId: string): boolean;
  /** a frustration group seen for the first time ever */
  newProblem?(group: { key: string; example: string | null; count: number }): void;
}) {
  const { store } = options, now = options.now ?? Date.now;
  const stats = { written: 0, failed: 0, dropped: 0 };
  /** a workspace's report section; never throws and never delays the report */
  /** the notes alone (a bad chat, a big session, the weekly one), from a workspace or app install no account owns, or
   * an account's app sending them itself; stored under `workspaceId` with an empty account when there is none */
  async function ingestNotes(accountId: string | null, workspaceId: string, notes: Pick<UsageReport, "frustrations" | "sessions" | "digests">, ran?: UsageRan) {
    if (accountId && options.optedOut(accountId)) { stats.dropped++; return 0; }
    const owner = accountId ?? "", with_ = ran ? { ran } : {};
    const records: UsageRecord[] = [
      ...(notes.frustrations ?? []).map(data => ({ id: data.id, kind: "frustration" as const, at: data.at, accountId: owner, workspaceId, ...with_, data })),
      ...(notes.sessions ?? []).map(data => ({ id: data.id, kind: "session" as const, at: data.at, accountId: owner, workspaceId, ...with_, data })),
      ...(notes.digests ?? []).map(data => ({ id: data.id, kind: "digest" as const, at: data.at, accountId: owner, workspaceId, ...with_, data })),
    ];
    if (!records.length) return 0;
    const fresh = await store.insert(records);
    await Promise.all([...rollup(fresh)].map(([day, inc]) => store.bump(day, inc)));
    for (const record of fresh) if (record.kind === "frustration" && options.newProblem) {
      const f = record.data as UsageFrustration, key = problemKey(f);
      if (await store.once(`problem|${key}`)) options.newProblem({ key, example: f.summary ?? null, count: 1 });
    }
    stats.written += fresh.length;
    return fresh.length;
  }
  async function ingest(accountId: string | null, workspaceId: string, report: UsageReport, from?: { kind?: string; version?: string }) {
    if (!accountId) { try { await ingestNotes(null, workspaceId, report, ranOf(report, from)); } catch { stats.failed++; } return; }
    if (options.optedOut(accountId)) { stats.dropped++; return; }
    try {
      const ran = ranOf(report, from);
      const records: UsageRecord[] = [
        ...report.turns.map(data => ({ id: data.id, kind: "turn" as const, at: data.at, accountId, workspaceId, data })),
        ...report.runs.map(data => ({ id: data.id, kind: "run" as const, at: data.at, accountId, workspaceId, data })),
        ...(report.frustrations ?? []).map(data => ({ id: data.id, kind: "frustration" as const, at: data.at, accountId, workspaceId, ...(ran ? { ran } : {}), data })),
        ...(report.sessions ?? []).map(data => ({ id: data.id, kind: "session" as const, at: data.at, accountId, workspaceId, ...(ran ? { ran } : {}), data })),
        ...(report.digests ?? []).map(data => ({ id: data.id, kind: "digest" as const, at: data.at, accountId, workspaceId, ...(ran ? { ran } : {}), data })),
        ...(report.signals ?? []).map(data => ({ id: data.id, kind: "signal" as const, at: data.at, accountId, workspaceId, data })),
      ];
      const fresh = await store.insert(records);
      const writes: Array<Promise<unknown>> = [];
      for (const [day, inc] of rollup(fresh)) writes.push(store.bump(day, inc));
      const perDay = new Map<string, { turns: number; failed: number; runs: number; frustrations: number; appTurns: number; bots: Record<string, number>; chats: Record<string, number> }>();
      for (const record of fresh) {
        const day = dayOf(record.at), row = perDay.get(day) ?? { turns: 0, failed: 0, runs: 0, frustrations: 0, appTurns: 0, bots: {}, chats: {} };
        if (record.kind === "turn") {
          const t = record.data as UsageTurn;
          row.turns++; if (t.outcome === "failed") row.failed++; if (t.apps.length) row.appTurns++;
          if (t.bot) row.bots[t.bot] = (row.bots[t.bot] ?? 0) + 1;
          if (t.chat) row.chats[t.chat] = (row.chats[t.chat] ?? 0) + 1;
        }
        if (record.kind === "run") {
          row.runs++;
          const r = record.data as UsageRun;
          if (r.routine) writes.push(store.routine({ workspaceId, accountId, routine: r.routine, first: r.at, last: r.at }));
        }
        if (record.kind === "frustration") row.frustrations++;
        perDay.set(day, row);
      }
      for (const [day, { bots, chats, ...inc }] of perDay) writes.push(store.person(day, accountId, inc, { bots, chats }).then(first => first ? store.bump(day, { people: 1 }) : undefined));
      if (report.snapshot) writes.push(store.snapshot({ workspaceId, accountId, at: now(), snapshot: report.snapshot }));
      await Promise.all(writes);
      for (const record of fresh) if (record.kind === "frustration" && options.newProblem) {
        const f = record.data as UsageFrustration, key = problemKey(f);
        if (await store.once(`problem|${key}`)) options.newProblem({ key, example: f.summary ?? null, count: 1 });
      }
      stats.written += fresh.length;
    } catch { stats.failed++; }
  }
  return { store, stats, ingest, ingestNotes, forget: (accountId: string) => store.forget(accountId).catch(() => { stats.failed++; }),
    forgetWorkspace: (workspaceId: string) => store.forgetWorkspace(workspaceId).catch(() => { stats.failed++; }) };
}
export type Usage = ReturnType<typeof createUsage>;

export const REASON_WORDS: Record<(typeof USAGE_REASONS)[number], string> = {
  rate_limit: "hit rate limits", quota: "ran out of plan usage", auth: "sign-in expired or was refused", timeout: "timed out", network: "network trouble",
  context: "the chat got too long", refused: "the ai refused", crashed: "the engine crashed", tool: "a tool broke", model_not_found: "the model was not found",
  bad_request: "the provider refused the request", provider_down: "the provider had an outage", cli_missing: "the engine is not installed",
  cli_exit_early: "the engine quit before replying", no_reply: "the ai sent no reply", unknown: "no clear reason",
};
