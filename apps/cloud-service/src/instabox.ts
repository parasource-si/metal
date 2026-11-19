// InstaBox public API v1 (https://instabox.sh/docs/api.md, OpenAPI https://api.instabox.sh/v1/openapi.json), read and
// checked against a live machine 2026-11-11. Facts this file relies on: create, start, stop, suspend, resume, delete and
// snapshot saves need an Idempotency-Key, and a create whose operation failed replays that failure for the same key, so
// a machine's unique name is what keeps a retried create from making a second one; a suspend keeps memory and processes,
// a stopped machine boots fresh, a paused one cannot be stopped; a public port answers 503 while its machine is paused by
// us and does not wake it; exec runs `bash -lc` as the machine user (passwordless sudo) and is never retried here;
// DELETE needs X-Confirm-Delete; there is no purge of stopped disks and no region. Snapshots (docs/pricing.md, read
// 2026-11-13) are free and outlive their machine; a paused machine cannot be saved, a stopped one saves at once. There is
// no network limit in the API (create and PATCH take none): a machine uploaded at 400 to 600 Mbit/s
// (2026-11-12), and its kernel has no shaping qdisc, only nftables (egress.ts).
import { randomUUID } from "node:crypto";
import type { MachineSpec } from "../../../shared/billing-api.ts";
import { boundedJson, RetryableCloudError } from "../../dashboard/server/clouds/http.ts";
import type { ProviderServer } from "../../dashboard/server/clouds/types.ts";
import { INSTABOX_HOME_VOLUME, INSTABOX_SETUP_FILE, INSTABOX_SETUP_LOG, INSTABOX_SETUP_STATUS, INSTABOX_SNAPSHOT_FILE, INSTABOX_USER_HOME, SNAPSHOT_COMMAND, SNAPSHOT_DONE_COMMAND } from "./home.ts";
import type { ProviderCostProfile } from "./power/cost.ts";
import { ProviderBusyError, ProviderError, ProviderLimitError, type MachineCreateInput, type MachineProvider, type MachineRecord, type MachineState } from "./provider.ts";

export const INSTABOX_SIZES = [
  { vcpu: 2, memMiB: 4096 }, { vcpu: 4, memMiB: 8192 }, { vcpu: 8, memMiB: 16384 }, { vcpu: 16, memMiB: 32768 }, { vcpu: 32, memMiB: 65536 },
] as const;
/** cents per vCPU-hour and per GiB-hour of memory, billed per second while running (pricing.md, read 2026-11-11) */
export const INSTABOX_PRICES = { vcpuCents: 0.4, memGiBCents: 0.225 } as const;
/** /data per GiB-month, billed while the machine exists; the workspace's included pool is not counted, so this is an upper bound */
export const INSTABOX_DISK_CENTS_PER_GIB_MONTH = 8;
export const INSTABOX_HOME_PORT = 8080;
/** starts (create, start, resume, wake) a minute per workspace, by plan (limits.md) */
export const INSTABOX_STARTS_PER_MINUTE = { pro: 30, builder: 50, team: 100 } as const;
export type InstaboxPlan = keyof typeof INSTABOX_STARTS_PER_MINUTE;

/** the provider size a spec is: only an exact one, never rounded up, so a machine is always the one that was sold */
export function instaboxSize(spec: MachineSpec, allowed: ReadonlyArray<{ vcpu: number; memMiB: number }> = INSTABOX_SIZES): { vcpu: number; memMiB: number } {
  const size = allowed.find(s => s.vcpu === spec.vcpu && s.memMiB === spec.ramGb * 1024);
  if (!size) throw new Error("Cloud machine size unavailable.");
  return size;
}
/** what a spec costs an hour awake; a spec that is no provider size (older records, the simulator) is costed as the next size up */
export function instaboxHourlyCents(spec: MachineSpec): number {
  const size = INSTABOX_SIZES.find(s => s.vcpu >= spec.vcpu && s.memMiB >= spec.ramGb * 1024);
  if (!size) throw new Error("Cloud machine size unavailable.");
  return size.vcpu * INSTABOX_PRICES.vcpuCents + (size.memMiB / 1024) * INSTABOX_PRICES.memGiBCents;
}

/** InstaBox as a ProviderCostProfile. Starts cost nothing and are limited per minute; a resume continues the paused
 *  machine in memory (no time limit) unless the provider has to boot it fresh. Wake times measured 2026-11-11 on a 2/4
 *  machine: resume 2.4 s plus the home's answer; a cold boot about 20 s plus the home's start. */
export function instaboxCostProfile(options: { plan?: InstaboxPlan; heldProbability?: number; coldWakeMs?: number; heldWakeMs?: number } = {}): ProviderCostProfile {
  const minute = INSTABOX_STARTS_PER_MINUTE[options.plan ?? "pro"];
  const included = { minute, hour: minute * 60, day: minute * 60 * 24 };
  return {
    computeCentsPerHour: instaboxHourlyCents,
    diskCentsPerHour: spec => spec.diskGb * INSTABOX_DISK_CENTS_PER_GIB_MONTH / 730,
    floorCentsPerHour: Math.min(...INSTABOX_SIZES.map(z => z.vcpu * INSTABOX_PRICES.vcpuCents + (z.memMiB / 1024) * INSTABOX_PRICES.memGiBCents)),
    included, hardCap: included,
    startCents: used => (["minute", "hour", "day"] as const).some(w => used[w] + 1 > included[w]) ? Number.POSITIVE_INFINITY : 0,
    held: { windowMs: 365 * 24 * 3_600_000, probability: options.heldProbability ?? 0.95 },
    wakeMs: { cold: options.coldWakeMs ?? 45_000, held: options.heldWakeMs ?? 6_000 },
  };
}

/** the rails where a resume is free and takes seconds: the loop guard stays, at a scale for that. Chosen on the
 *  simulator (docs/power.md): 37% below the rails for a scarce daily start pool and 12% below the best fixed idle timer
 *  on the mixed fleets, no late or missed run. */
export const INSTABOX_RAILS = { flapMs: 60_000, maxMinIdleMs: 10 * 60_000, maxStartsPerHour: 20, maxStartsPerDay: 96, minUptimeMs: 3 * 60_000 } as const;

const MACHINE_ID = /^m_[a-z0-9]{26}$/;
const OPERATION_ID = /^op_[a-z0-9]{26}$/;
const CLOUD_ID = /^c[0-9a-f]{24}$/;
const LIVE_SNAPSHOT = /^live-([a-z0-9]{26})-(\d{13})$/;
const SNAPSHOT_ID = /^sn_[a-z0-9]{26}$/;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export class InstaboxError extends ProviderError {
  constructor(status: number, code: string) { super(status, code); this.message = `InstaBox refused the request: ${code}.`; this.name = "InstaboxError"; }
}

interface RawMachine {
  id: string; name: string; state: string; ready: boolean; preserved: boolean | null; metadata: Record<string, string>;
  vcpus: number; memMiB: number; diskGiB: number; createdAt: number | null; updatedAt: number | null; operationId: string | null;
}
function machineOf(value: unknown): RawMachine | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, any>;
  if (typeof m.id !== "string" || !MACHINE_ID.test(m.id) || typeof m.state !== "string") return null;
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.metadata && typeof m.metadata === "object" ? m.metadata : {})) if (typeof v === "string") metadata[k] = v;
  return { id: m.id, name: typeof m.name === "string" ? m.name : "", state: m.state, ready: m.runtime?.ready === true,
    preserved: typeof m.runtime?.processesPreserved === "boolean" ? m.runtime.processesPreserved : null, metadata,
    vcpus: Number(m.spec?.vcpus) || 0, memMiB: Number(m.spec?.memMiB) || 0, diskGiB: Number(m.spec?.persistentDiskGiB ?? m.storage?.sizeGiB) || 0,
    createdAt: time(m.createdAt), updatedAt: time(m.updatedAt), operationId: typeof m.operationId === "string" ? m.operationId : null };
}
const LIFECYCLE: Record<string, MachineState> = { creating: "creating", starting: "starting", resuming: "starting", running: "running", stopping: "stopping",
  suspending: "stopping", deleting: "stopping", stopped: "stopped", suspended: "stopped", error: "error" };
function recordOf(m: RawMachine, setup: MachineRecord["setup"]): MachineRecord {
  const asleep = m.state === "stopped" || m.state === "suspended";
  const state = m.state === "running" && !m.ready ? "starting" : LIFECYCLE[m.state] ?? "starting";
  const cloud = m.metadata["omb.cloud"];
  return { id: m.id, state, cloudId: cloud && CLOUD_ID.test(cloud) ? cloud : null, scope: m.metadata["omb.scope"] ?? null, type: `${m.vcpus}x${m.memMiB}`,
    stoppedAt: asleep ? m.updatedAt : null, setup, createdAt: m.createdAt };
}
function serverOf(m: RawMachine): ProviderServer {
  const states: Record<string, ProviderServer["state"]> = { creating: "creating", starting: "starting", resuming: "starting", running: "running", stopping: "stopping",
    suspending: "stopping", stopped: "off", suspended: "off", deleting: "deleting", error: "error" };
  const state = m.state === "running" && !m.ready ? "starting" : states[m.state] ?? "starting";
  return { id: m.id, state, ipv4: null, serverType: `${m.vcpus}x${m.memMiB}`, diskGb: m.diskGiB };
}

export interface InstaboxProviderOptions {
  apiKey: string;
  /** https://api.instabox.sh */
  baseUrl?: string;
  scope: string;
  fetch?: typeof fetch;
  /** the template a new machine starts from (a template with Docker; our bot computers bring their own desktop) */
  template?: string;
  /** the machine's own idle pause, the dead-man switch once our activity lease lapses: 5 to 30 minutes */
  idlePauseMinutes?: number;
  /** the sizes the workspace may create (`allowedSpecs`) */
  sizes?: ReadonlyArray<{ vcpu: number; memMiB: number }>;
  /** how long a create, a resize or a setup step waits for the machine to settle */
  settleMs?: number;
  pollMs?: number;
  /** the service's clock, for a refusal's not-before time (the lifecycle compares it with its own) */
  now?: () => number;
}


export function createInstaboxProvider(options: InstaboxProviderOptions): MachineProvider {
  const fetcher = options.fetch ?? fetch, key = options.apiKey;
  if (!key || /[\r\n\s]/.test(key)) throw new Error("Invalid INSTABOX_API_KEY.");
  if (!/^[a-f0-9]{16}$/.test(options.scope)) throw new Error("Invalid InstaBox scope.");
  const base = (options.baseUrl ?? "https://api.instabox.sh").replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = new URL(base);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Invalid INSTABOX_BASE_URL.");
  const template = options.template ?? "universal";
  if (!/^[a-z0-9][a-z0-9.@-]{0,80}$/.test(template)) throw new Error("Invalid InstaBox template.");
  const idlePause = options.idlePauseMinutes ?? 30;
  if (!Number.isInteger(idlePause) || idlePause < 5 || idlePause > 30) throw new Error("Invalid InstaBox idle pause.");
  const sizes = options.sizes ?? INSTABOX_SIZES, settleMs = options.settleMs ?? 120_000, pollMs = options.pollMs ?? 2_000;
  const origins = new Map<string, string>(), setupKnown = new Map<string, "done" | "failed">();
  const safeCode = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !value.includes(key) ? value : "failed";
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  type Init = { body?: unknown; raw?: Uint8Array; headers?: Record<string, string>; missingOk?: boolean; timeoutMs?: number; idempotent?: string | true; limit?: number };
  async function send(method: string, path: string, init: Init): Promise<Response> {
    const headers: Record<string, string> = { "x-api-key": key, accept: "application/json", ...init.headers };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.raw) headers["content-type"] = "application/octet-stream";
    if (init.idempotent) headers["idempotency-key"] = init.idempotent === true ? `dusk-${randomUUID()}` : init.idempotent;
    try {
      return await fetcher(`${base}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(init.timeoutMs ?? 30_000), headers,
        ...(init.raw ? { body: init.raw } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    } catch { throw new RetryableCloudError(); }
  }
  async function failure(response: Response, limit: number): Promise<never> {
    let data: Record<string, any> | null = null;
    try { data = await boundedJson(response, limit) as Record<string, any>; } catch {}
    const error = data?.error && typeof data.error === "object" ? data.error : {};
    const code = safeCode(error.code ?? data?.code);
    const after = Number(response.headers.get("retry-after")), seconds = typeof error.retryAfterSeconds === "number" ? error.retryAfterSeconds : Number.isFinite(after) && after > 0 ? after : null;
    const retryMs = seconds !== null && seconds > 0 ? Math.min(seconds, 3600) * 1000 : null;
    if (response.status === 429 || code === "machine_cooldown" || code === "no_capacity")
      throw new ProviderLimitError(retryMs, { nextStartAt: retryMs === null ? null : (options.now ?? Date.now)() + retryMs, window: code === "rate_limited" ? "minute" : null, cause: code, startLimit: code === "rate_limited" });
    if (response.status === 409 && ["operation_conflict", "idempotency_conflict"].includes(code)) throw new ProviderBusyError(code);
    if (response.status >= 500) throw new RetryableCloudError();
    throw new InstaboxError(response.status, code);
  }
  async function call(method: string, path: string, init: Init = {}): Promise<Record<string, any> | null> {
    const response = await send(method, path, init);
    if (init.missingOk && (response.status === 404 || response.status === 410)) { await response.body?.cancel(); return null; }
    if (!response.ok) return failure(response, init.limit ?? 1_048_576);
    if (response.status === 204) return {};
    try { return await boundedJson(response, init.limit ?? 2_097_152) as Record<string, any>; } catch { throw new RetryableCloudError(); }
  }
  const checkId = (id: string) => { if (!MACHINE_ID.test(id)) throw new Error("Invalid InstaBox machine id."); };
  async function get(id: string): Promise<RawMachine | null> {
    checkId(id);
    const data = await call("GET", `/v1/machines/${id}`, { missingOk: true });
    if (!data) return null;
    const m = machineOf(data);
    if (!m) throw new RetryableCloudError();
    return m;
  }
  async function byName(name: string): Promise<RawMachine | null> {
    const data = await call("GET", `/v1/machines/${encodeURIComponent(name)}`, { missingOk: true });
    return data ? machineOf(data) : null;
  }
  async function list(filters: string[]): Promise<RawMachine[]> {
    const found: RawMachine[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const query = [...filters.map(f => `metadata=${encodeURIComponent(f)}`), "limit=200", ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join("&");
      const data: Record<string, any> | null = await call("GET", `/v1/machines?${query}`);
      for (const value of data?.machines ?? []) { const m = machineOf(value); if (m) found.push(m); }
      cursor = typeof data?.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
      if (!cursor) return found;
    }
    throw new RetryableCloudError("InstaBox inventory too long.");
  }
  const scoped = `omb.scope:${options.scope}`;
  const mine = (m: RawMachine) => m.metadata["omb.scope"] === options.scope;
  async function settle(id: string, done: (m: RawMachine) => boolean): Promise<RawMachine> {
    const end = Date.now() + settleMs;
    for (;;) {
      const m = await get(id);
      if (!m) throw new InstaboxError(404, "not_found");
      if (done(m)) return m;
      if (m.state === "error" || Date.now() > end) throw new RetryableCloudError("InstaBox machine did not settle.");
      await sleep(pollMs);
    }
  }
  const awake = (m: RawMachine) => m.state === "running" && m.ready;
  async function exec(id: string, cmd: string, timeoutSeconds: number) {
    const data = await call("POST", `/v1/machines/${id}/exec`, { body: { cmd, timeoutSeconds: Math.min(600, Math.max(1, Math.round(timeoutSeconds))) }, timeoutMs: (timeoutSeconds + 30) * 1000, limit: 3_145_728 });
    return { exitCode: typeof data?.exitCode === "number" ? data.exitCode : null, stdout: typeof data?.stdout === "string" ? data.stdout : "", timedOut: data?.timedOut === true };
  }
  async function upload(id: string, path: string, body: Uint8Array) {
    if (!path.startsWith(`${INSTABOX_USER_HOME}/`) || !/^[A-Za-z0-9._/-]{1,200}$/.test(path) || path.includes("..")) throw new Error("Invalid upload path.");
    checkId(id);
    await call("PUT", `/v1/machines/${id}/files?path=${encodeURIComponent(path)}&parents=true&mode=0600`, { raw: body, timeoutMs: 30 * 60_000 });
  }
  async function publish(id: string): Promise<string> {
    const known = origins.get(id);
    if (known) return known;
    const listed = await call("GET", `/v1/machines/${id}/ports`);
    let found = (listed?.ports ?? []).find((p: Record<string, unknown>) => p?.port === INSTABOX_HOME_PORT && typeof p.url === "string")?.url as string | undefined;
    if (!found) { const made = await call("POST", `/v1/machines/${id}/ports`, { body: { port: INSTABOX_HOME_PORT, name: "Metal" } }); found = typeof made?.url === "string" ? made.url : undefined; }
    const origin = found ? new URL(found).origin : "";
    if (!origin.startsWith("https://")) throw new RetryableCloudError();
    origins.set(id, origin);
    return origin;
  }
  async function setupState(m: RawMachine): Promise<MachineRecord["setup"]> {
    const label = m.metadata["omb.setup"];
    if (label === "done" || label === "failed") return label;
    if (label !== "running") return label === "pending" ? "pending" : null;
    const known = setupKnown.get(m.id);
    if (known) return known;
    if (!awake(m)) return "running";
    const response = await send("GET", `/v1/machines/${m.id}/files/content?path=${encodeURIComponent(INSTABOX_SETUP_STATUS)}`, {});
    if (response.status === 404) { await response.body?.cancel(); return "running"; }
    if (!response.ok) return failure(response, 65_536);
    const code = (await response.text()).trim();
    const result = code === "0" ? "done" : "failed";
    setupKnown.set(m.id, result);
    await call("PATCH", `/v1/machines/${m.id}`, { body: { metadata: { ...m.metadata, "omb.setup": result } }, idempotent: true }).catch(() => {});
    return result;
  }
  /** /data grown to the disk that was sold: a create always gets the size's 20 GiB, and a running machine grows online.
   *  rarely a grow needs a stop: then stopped, grown and booted again (only on a fresh machine, before its setup runs) */
  async function growDisk(m: RawMachine, diskGb: number): Promise<RawMachine> {
    if (m.diskGiB >= diskGb) return m;
    try { await call("PATCH", `/v1/machines/${m.id}`, { body: { persistentDiskGiB: diskGb }, idempotent: true }); }
    catch (error) {
      if (!(error instanceof InstaboxError && error.code === "grow_needs_stop")) throw error;
      await call("POST", `/v1/machines/${m.id}/stop`, { body: {}, idempotent: true });
      await settle(m.id, x => x.state === "stopped");
      await call("PATCH", `/v1/machines/${m.id}`, { body: { persistentDiskGiB: diskGb }, idempotent: true });
      await call("POST", `/v1/machines/${m.id}/start`, { body: {}, idempotent: true });
    }
    return settle(m.id, x => awake(x) && x.diskGiB >= diskGb);
  }
  /** the boot file and the setup script go in once the machine runs; the setup runs on its own, detached from this request */
  async function startSetup(m: RawMachine, input: MachineCreateInput) {
    for (const file of input.files ?? []) await upload(m.id, file.path, Buffer.from(file.content));
    await upload(m.id, INSTABOX_SETUP_FILE, Buffer.from(input.userData));
    const launch = `rm -f ${INSTABOX_SETUP_STATUS}; setsid nohup bash -c 'bash ${INSTABOX_SETUP_FILE} >${INSTABOX_SETUP_LOG} 2>&1; echo $? >${INSTABOX_SETUP_STATUS}' >/dev/null 2>&1 < /dev/null & echo launched`;
    const started = await exec(m.id, launch, 60);
    if (started.exitCode !== 0 || !started.stdout.includes("launched")) throw new RetryableCloudError("InstaBox setup did not start.");
    await call("PATCH", `/v1/machines/${m.id}`, { body: { metadata: { ...m.metadata, "omb.setup": "running" } }, idempotent: true });
  }

  function snapshotOf(value: unknown): { id: string; name: string; status: string } | null {
    const v = value as Record<string, unknown> | null;
    return v && typeof v.id === "string" && SNAPSHOT_ID.test(v.id) && typeof v.status === "string" ? { id: v.id, name: typeof v.name === "string" ? v.name : "", status: v.status } : null;
  }
  async function snapshotNamed(name: string) {
    const data = await call("GET", "/v1/snapshots");
    for (const value of data?.snapshots ?? []) { const snap = snapshotOf(value); if (snap?.name === name) return snap; }
    return null;
  }

  const provider: MachineProvider = {
    name: "managed",
    scope: options.scope,
    async find(cloudId) {
      if (!CLOUD_ID.test(cloudId)) throw new Error("Invalid cloud id.");
      const listed = (await list([scoped, `omb.cloud:${cloudId}`])).filter(m => mine(m) && m.metadata["omb.cloud"] === cloudId);
      for (const m of listed.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))) { const direct = await get(m.id); if (direct) return serverOf(direct); }
      return null;
    },
    async create(input) {
      if (!CLOUD_ID.test(input.cloudId)) throw new Error("Invalid cloud id.");
      const attempt = input.attempt ?? 0;
      const name = `omb-${input.cloudId}-${attempt}-${options.scope.slice(0, 8)}`;
      let m = await byName(name);
      if (m && !mine(m)) throw new InstaboxError(409, "name_taken");
      if (m?.state === "error" && m.metadata["omb.setup"] === "pending") {
        // a create that failed before anything ran on it: removed so the name is free for the next try
        await provider.requestDelete(m.id);
        throw new RetryableCloudError("InstaBox create failed; tried again.");
      }
      if (!m) {
        const size = instaboxSize(input.spec, sizes);
        // from an archived home's snapshot: its disks are the set-up home, so no setup runs and its /data comes back whole
        const archived = input.snapshotId ?? null;
        if (archived !== null && !SNAPSHOT_ID.test(archived)) throw new Error("Invalid InstaBox snapshot id.");
        const metadata = { "omb.cloud": input.cloudId, "omb.scope": options.scope, "omb.attempt": String(attempt), "omb.setup": archived ? "done" : "pending" };
        const body = { name, ...(archived ? { snapshotId: archived } : { templateId: template }), vcpus: size.vcpu, memMiB: size.memMiB,
          autoSuspendAfterSeconds: idlePause * 60, vault: false, secrets: [], metadata };
        try { await call("POST", "/v1/machines", { body, idempotent: true, timeoutMs: 90_000 }); }
        catch (error) {
          // a lost answer retried: the name is taken by the machine the first request made
          if (!(error instanceof InstaboxError && error.status === 409)) throw error;
        }
        m = await byName(name);
        if (!m) throw new RetryableCloudError();
      }
      m = await settle(m.id, awake);
      if (m.metadata["omb.setup"] === "pending") m = await growDisk(m, input.spec.diskGb);
      const origin = await publish(m.id);
      if (input.ttlSeconds) await provider.lease(m.id, input.ttlSeconds);
      if (m.metadata["omb.setup"] === "pending") await startSetup(m, input);
      return { ...serverOf(m), origin };
    },
    async status(serverId) {
      const m = await get(serverId);
      return m ? serverOf(m) : { id: serverId, state: "missing", ipv4: null, serverType: "", diskGb: 0 };
    },
    async machine(serverId) { const m = await get(serverId); return m ? recordOf(m, await setupState(m)) : null; },
    async inventory() { return (await list([scoped])).filter(mine).map(m => recordOf(m, (m.metadata["omb.setup"] ?? null) as MachineRecord["setup"])); },
    async listed(serverId) { return (await list([])).some(m => m.id === serverId); },
    async origin(serverId) { checkId(serverId); return publish(serverId); },
    async power(serverId, action) {
      const m = await get(serverId);
      if (!m) throw new InstaboxError(404, "not_found");
      try {
        if (action === "off") {
          if (m.state !== "running") return;
          // what the page cache holds goes to disk first: a resume that cannot restore memory boots from the disk
          await exec(serverId, "sync", 30).catch(() => {});
          await call("POST", `/v1/machines/${serverId}/suspend`, { body: {}, idempotent: true });
          return;
        }
        if (m.state === "suspended") await call("POST", `/v1/machines/${serverId}/resume`, { body: {}, idempotent: true });
        else if (m.state === "stopped" || m.state === "error") await call("POST", `/v1/machines/${serverId}/start`, { body: {}, idempotent: true });
      } catch (error) {
        // another operation runs on it: on its way, not a failure
        if (error instanceof ProviderBusyError) return;
        throw error;
      }
    },
    async suspend(serverId) { await provider.power(serverId, "off"); },
    async resize(serverId, spec) {
      let m = await get(serverId);
      if (!m || (m.state !== "stopped" && m.state !== "suspended")) throw new Error("Cloud server must be off to resize.");
      const size = instaboxSize(spec, sizes);
      // a paused machine cannot be stopped or resized: resumed, stopped, resized, booted on the new size
      if (m.state === "suspended") {
        await call("POST", `/v1/machines/${serverId}/resume`, { body: {}, idempotent: true });
        m = await settle(serverId, awake);
      }
      if (m.state !== "stopped") {
        await call("POST", `/v1/machines/${serverId}/stop`, { body: {}, idempotent: true });
        await settle(serverId, x => x.state === "stopped");
      }
      await call("PATCH", `/v1/machines/${serverId}`, { body: { vcpus: size.vcpu, memMiB: size.memMiB }, idempotent: true });
      // the disk follows the plan, applied at the start below; a shrink the data does not fit in keeps the bigger disk
      if (m.diskGiB !== spec.diskGb) {
        try { await call("PATCH", `/v1/machines/${serverId}`, { body: { persistentDiskGiB: spec.diskGb }, idempotent: true }); }
        catch (error) { if (!(spec.diskGb < m.diskGiB && error instanceof InstaboxError && error.code === "disk_too_small")) throw error; }
      }
      await call("POST", `/v1/machines/${serverId}/start`, { body: {}, idempotent: true });
    },
    async run(serverId, command, timeoutSeconds = 120) {
      checkId(serverId);
      const result = await exec(serverId, command, timeoutSeconds);
      return { ok: result.exitCode === 0 && !result.timedOut, exitCode: result.exitCode, stdout: result.stdout.slice(0, 65_536) };
    },
    async lease(serverId, ttlSeconds) {
      checkId(serverId);
      if (ttlSeconds === null) { await call("DELETE", `/v1/machines/${serverId}/activity-leases/dusk-lifecycle`, { missingOk: true }); return; }
      await call("PUT", `/v1/machines/${serverId}/activity-leases/dusk-lifecycle`, { body: { ttlSeconds: Math.min(3600, Math.max(30, Math.round(ttlSeconds))) } });
    },
    async latestSnapshot(serverId) {
      const m = await get(serverId);
      if (!m || !awake(m)) return null;
      const made = await exec(serverId, SNAPSHOT_COMMAND, 600);
      if (made.exitCode !== 0 || !/^snapshot \d+/m.test(made.stdout)) throw new RetryableCloudError("InstaBox live snapshot failed.");
      const at = Date.now();
      return { id: `live-${serverId.slice(2)}-${at}`, at };
    },
    async snapshotTar(snapshotId, path) {
      const live = LIVE_SNAPSHOT.exec(snapshotId);
      if (!live || path !== INSTABOX_HOME_VOLUME) throw new Error("Invalid snapshot read.");
      const serverId = `m_${live[1]}`;
      const response = await send("GET", `/v1/machines/${serverId}/files/content?path=${encodeURIComponent(INSTABOX_SNAPSHOT_FILE)}`, { timeoutMs: 30 * 60_000 });
      if (response.status === 429 || response.status >= 500) { await response.body?.cancel(); throw new RetryableCloudError(); }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new InstaboxError(response.status, "snapshot_read_failed"); }
      // the tar holds the home's secrets in clear: removed from the machine once read
      return response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush() { void exec(serverId, SNAPSHOT_DONE_COMMAND, 60).catch(() => {}); } }));
    },
    upload,
    async deletion(operationId) {
      if (!OPERATION_ID.test(operationId)) throw new Error("Invalid InstaBox operation id.");
      const op = await call("GET", `/v1/operations/${operationId}`, { missingOk: true });
      if (!op || op.id !== operationId) return null;
      const status = op.state === "succeeded" ? "completed" : op.state === "failed" ? "blocked" : op.state === "running" ? "processing" : "pending";
      return { id: operationId, status };
    },
    async requestDelete(serverId) {
      checkId(serverId);
      const op = await call("DELETE", `/v1/machines/${serverId}`, { headers: { "x-confirm-delete": serverId }, idempotent: `dusk-delete-${serverId}`, missingOk: true });
      if (!op) return { operationId: null, gone: true };
      origins.delete(serverId); setupKnown.delete(serverId);
      return { operationId: typeof op.id === "string" && OPERATION_ID.test(op.id) ? op.id : null, gone: false };
    },
    async limits() { return { nextStartCents: 0 }; },
    async usage(serverId, from) {
      checkId(serverId);
      const data = await call("GET", `/v1/machines/${serverId}/usage${from ? `?from=${encodeURIComponent(new Date(from).toISOString())}` : ""}`, { missingOk: true });
      if (!data) return null;
      const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
      return { from: time(data.from) ?? 0, to: time(data.to) ?? 0, runningSeconds: n(data.runningSeconds), vcpuSeconds: n(data.vcpuSeconds), memGiBSeconds: n(data.memGiBSeconds),
        diskGiBSeconds: n(data.diskGiBSeconds), egressBytes: n(data.egressBytes) };
    },
    async archive(serverId, name) {
      if (!SNAPSHOT_NAME.test(name)) throw new Error("Invalid InstaBox snapshot name.");
      let m = await get(serverId);
      if (!m) return null;
      let snap = await snapshotNamed(name);
      if (!snap) {
        // a paused machine can be neither saved nor stopped: resumed first; a stopped one saves at once, with nothing copied
        if (m.state === "suspended") { await call("POST", `/v1/machines/${serverId}/resume`, { body: {}, idempotent: true }); m = await settle(serverId, awake); }
        if (m.state !== "stopped") {
          if (awake(m)) await exec(serverId, "sync", 30).catch(() => {});
          await call("POST", `/v1/machines/${serverId}/stop`, { body: {}, idempotent: true });
          await settle(serverId, x => x.state === "stopped");
        }
        try { snap = snapshotOf(await call("POST", `/v1/machines/${serverId}/snapshots`, { body: { name, description: "Metal: a home kept after its plan ended" }, idempotent: `dusk-snap-${name}` })); }
        catch (error) {
          // a lost answer retried: the name is taken by the snapshot the first request made
          if (!(error instanceof InstaboxError && error.status === 409)) throw error;
          snap = await snapshotNamed(name);
        }
        if (!snap) throw new RetryableCloudError("InstaBox snapshot not found after saving it.");
      }
      const end = Date.now() + settleMs * 5;
      while (snap.status === "pending") {
        if (Date.now() > end) throw new RetryableCloudError("InstaBox snapshot still saving.");
        await sleep(pollMs);
        snap = snapshotOf(await call("GET", `/v1/snapshots/${snap.id}`, { missingOk: true }));
        if (!snap) throw new RetryableCloudError("InstaBox snapshot vanished while saving.");
      }
      if (snap.status !== "ready") throw new InstaboxError(409, "snapshot_failed");
      return { id: snap.id };
    },
    async deleteSnapshot(snapshotId) {
      if (!SNAPSHOT_ID.test(snapshotId)) throw new Error("Invalid InstaBox snapshot id.");
      await call("DELETE", `/v1/snapshots/${snapshotId}`, { headers: { "x-confirm-delete": snapshotId }, idempotent: `dusk-snap-delete-${snapshotId}`, missingOk: true });
    },
    // the clouds service never reaches this: managed machines are deleted only by the gated reconciler, through requestDelete
    async destroy() { throw new Error("InstaBox machines are deleted only by the retention reconciler."); },
  };
  return provider;
}

/** what a machine's usage cost at InstaBox's prices, in cents (disk only beyond the plan's included storage) */
export function instaboxUsageCents(usage: { vcpuSeconds: number; memGiBSeconds: number }): number {
  return (usage.vcpuSeconds * INSTABOX_PRICES.vcpuCents + usage.memGiBSeconds * INSTABOX_PRICES.memGiBCents) / 3600;
}
