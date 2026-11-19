// What every self-updating Metal install does with an update (a managed cloud home through apps/cloud-service, a
// self-hosted server through the installer): an update is applied only when it is signed, newer than what runs, at or
// above the signed floor and not on the signed block list; it waits for an idle moment; it is on trial until its
// self-test passes and the next runs go through; a failed self-test or the first two runs failing in a row rolls it
// back to the version before, never below the floor. Pure: the callers fetch, verify signatures, install and restart.

export const SEMVER = /^\d+\.\d+\.\d+$/;

/** a.b.c compared as numbers; anything else sorts below every version */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parts = (value: string | null | undefined) => (value && SEMVER.test(value) ? value.split(".").map(Number) : null);
  const left = parts(a), right = parts(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let at = 0; at < 3; at += 1) if (left[at] !== right[at]) return left[at]! < right[at]! ? -1 : 1;
  return 0;
}

/** the signed update policy (our account service serves it): the lowest version anything may run, and versions pulled */
export interface UpdatePolicy { serial: number; floor: string | null; blocked: string[] }
export const NO_POLICY: UpdatePolicy = Object.freeze({ serial: 0, floor: null, blocked: [] }) as UpdatePolicy;

/** a policy body as signed; throws on anything else */
export function parsePolicy(value: unknown): UpdatePolicy {
  const body = value as Partial<UpdatePolicy> | null;
  if (!body || typeof body !== "object" || !Number.isSafeInteger(body.serial) || (body.serial as number) < 1) throw new Error("Invalid update policy.");
  if (body.floor !== null && !(typeof body.floor === "string" && SEMVER.test(body.floor))) throw new Error("Invalid update policy floor.");
  if (!Array.isArray(body.blocked) || body.blocked.length > 500 || !body.blocked.every(v => typeof v === "string" && SEMVER.test(v))) throw new Error("Invalid update policy block list.");
  return { serial: body.serial as number, floor: body.floor, blocked: [...new Set(body.blocked)] };
}

export interface Release { version: string; sha256: string }
export type Refusal = "invalid" | "not_newer" | "below_floor" | "blocked" | "failed_here";

/** busy codes (server/cloud-power.ts) that hold an update: a turn, a routine run, an upload or a backup (both
 * "maintenance"), a live call, a bot computer in use */
export const UPDATE_HOLDS: readonly string[] = ["turn", "run", "maintenance", "live-call", "computer"];
export const idleForUpdate = (busy: readonly string[]) => !busy.some(code => UPDATE_HOLDS.includes(code));

/** a trial lasts until its self-test passed and either TRIAL_RUNS runs finished or TRIAL_MS went by */
export const TRIAL_RUNS = 2;
export const TRIAL_MS = 24 * 3_600_000;

export interface UpdateTrial { to: Release; from: Release | null; at: number; selfTest: "pending" | "passed"; runs: Array<{ id: string; ok: boolean }> }
export interface UpdateRecord {
  current: Release | null;
  /** what the last update replaced: the rollback target */
  previous: Release | null;
  policy: UpdatePolicy;
  /** versions that were rolled back here: never offered again */
  failed: string[];
  trial: UpdateTrial | null;
  /** the last outcome, for the one-line digest */
  last: { kind: "updated" | "rolled_back"; version: string; at: number; reason?: RollbackReason } | null;
}
export type RollbackReason = "self_test" | "runs_failed" | "blocked";
export type Verdict = { action: "wait" } | { action: "settle" } | { action: "rollback"; reason: RollbackReason; to: Release } | { action: "stuck"; reason: RollbackReason };

export function freshUpdateRecord(current: Release | null = null): UpdateRecord {
  return { current, previous: null, policy: { ...NO_POLICY, blocked: [] }, failed: [], trial: null, last: null };
}

const allowed = (version: string, policy: UpdatePolicy) => !policy.blocked.includes(version) && (policy.floor === null || compareVersions(version, policy.floor) >= 0);

/** why `offer` may not be installed over what runs now, or null when it may */
export function refusal(record: UpdateRecord, offer: Release): Refusal | null {
  if (!SEMVER.test(offer.version) || !/^[a-f0-9]{64}$/.test(offer.sha256)) return "invalid";
  if (record.policy.blocked.includes(offer.version)) return "blocked";
  if (record.policy.floor !== null && compareVersions(offer.version, record.policy.floor) < 0) return "below_floor";
  if (record.failed.includes(offer.version)) return "failed_here";
  if (record.current && compareVersions(offer.version, record.current.version) <= 0) return "not_newer";
  return null;
}

/** a newer signed policy replaces the one held; an older or equal serial is ignored (a replayed policy never loosens it) */
export function acceptPolicy(record: UpdateRecord, policy: UpdatePolicy): boolean {
  if (policy.serial <= record.policy.serial) return false;
  record.policy = { serial: policy.serial, floor: policy.floor, blocked: [...policy.blocked] };
  return true;
}

/** the version a rollback may return to: the one before, unless the policy pulled it or put it below the floor */
export function rollbackTarget(record: UpdateRecord): Release | null {
  const to = record.trial?.from ?? record.previous;
  return to && allowed(to.version, record.policy) ? to : null;
}

/** `to` is installed and running now: on trial from here */
export function startTrial(record: UpdateRecord, to: Release, now: number): void {
  record.previous = record.current;
  record.trial = { to, from: record.current, at: now, selfTest: "pending", runs: [] };
  record.current = to;
}

function rollback(record: UpdateRecord, reason: RollbackReason): Verdict {
  const to = rollbackTarget(record);
  return to ? { action: "rollback", reason, to } : { action: "stuck", reason };
}

export function selfTested(record: UpdateRecord, ok: boolean, now: number): Verdict {
  if (!record.trial) return { action: "wait" };
  if (!ok) return rollback(record, "self_test");
  record.trial.selfTest = "passed";
  return review(record, now);
}

/** a run finished on the version on trial; the same run twice counts once */
export function sawRun(record: UpdateRecord, run: { id: string; ok: boolean }, now: number): Verdict {
  const trial = record.trial;
  if (!trial) return { action: "wait" };
  if (trial.runs.length < TRIAL_RUNS && !trial.runs.some(r => r.id === run.id)) trial.runs.push({ id: run.id, ok: run.ok });
  if (trial.runs.length >= TRIAL_RUNS && trial.runs.every(r => !r.ok)) return rollback(record, "runs_failed");
  return review(record, now);
}

/** the trial's state now, and a blocked running version */
export function review(record: UpdateRecord, now: number): Verdict {
  if (record.current && record.policy.blocked.includes(record.current.version)) return rollback(record, "blocked");
  const trial = record.trial;
  if (!trial) return { action: "wait" };
  if (trial.runs.length >= TRIAL_RUNS && trial.runs.every(r => !r.ok)) return rollback(record, "runs_failed");
  if (trial.selfTest !== "passed") return { action: "wait" };
  return trial.runs.length >= TRIAL_RUNS || now - trial.at >= TRIAL_MS ? { action: "settle" } : { action: "wait" };
}

/** the trial passed: the digest says "Updated to <version>" */
export function settle(record: UpdateRecord, now: number): void {
  if (!record.trial) return;
  record.last = { kind: "updated", version: record.trial.to.version, at: now };
  record.trial = null;
}

/** the rollback to `to` is done: the bad version is never offered here again; returns the runs it failed (re-run free once) */
export function rolledBack(record: UpdateRecord, to: Release, reason: RollbackReason, now: number): { failedRuns: string[] } {
  const bad = record.current;
  const failedRuns = (record.trial?.runs ?? []).filter(r => !r.ok).map(r => r.id);
  if (bad && !record.failed.includes(bad.version)) record.failed = [...record.failed, bad.version].slice(-50);
  record.current = to;
  record.previous = null;
  record.trial = null;
  record.last = { kind: "rolled_back", version: bad?.version ?? to.version, at: now, reason };
  return { failedRuns };
}
