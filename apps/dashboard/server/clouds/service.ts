import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD_STATUSES, CLOUD_SWATCHES } from "../../../../shared/billing-api.ts";
import type { CloudDesktopView, CloudStatus, MachineSpec } from "../../../../shared/billing-api.ts";
import { createJsonStore } from "../billing/json-store.ts";
import { dedicatedUserData, linkKeys, originFor, poolBootstrap } from "./bootstrap.ts";
import { PoolFullError } from "./pool.ts";
import { RetryableCloudError } from "./http.ts";

/** what a Team Cloud is called on its machine (DUSK_CLOUD_TEAM_NAME: 1 to 80 characters, no control characters) */
export function teamName(value: string) { return value.replace(/[\p{Cc}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "team"; }
import type { createSealer } from "./seal.ts";
import type { CloudProvider, CloudsService, DesktopPlan, HomeClient, SlotQuota, StoredCloud, TeamMemberClaim } from "./types.ts";
import type { ManagedCloud, ManagedCloudFactory } from "./managed.ts";
import { lockDataDir } from "../data-dir-lock.ts";
import { stateBackend } from "../persistence/backend.ts";
import type { AiStash } from "./ai-stash.ts";

export class CloudError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = "Cloud request failed.") { super(message); this.name = "CloudError"; this.status = status; this.code = code; }
}
export interface CloudsConfig {
  configured?: { pool: boolean; dedicated: boolean };
  adminOrigin: string;
  dashboardUrl: string;
  /** the Cloud home container image dedicated machines run */
  image: string;
  originTemplate?: string;
  poolQuota(kind: DesktopPlan["kind"], spec: MachineSpec, botComputers: number | null): SlotQuota;
  maxAttempts?: number;
  /** how many dusk cloud (managed) machines one upkeep pass looks after at once; a slow one (a backup, a wake) no longer
   *  holds up the rest. the older pool and dedicated clouds still go one by one */
  upkeepConcurrency?: number;
}
export interface CloudWorkspaces {
  register(input: { accountId: string; name: string; publicKey: string }): string;
  lastReportAt(workspaceId: string): number | null;
  remove(workspaceId: string): void;
}
export interface CloudsServiceOptions {
  dataDir: string;
  providers: { pool: CloudProvider & { suspend(id: string, reason: string): Promise<void>; resume(id: string): Promise<void> }; dedicated: CloudProvider };
  home: HomeClient;
  sealer: ReturnType<typeof createSealer>;
  workspaces: CloudWorkspaces;
  config: CloudsConfig;
  now?: () => number;
  random?: (size: number) => Buffer;
  /** a managed backend (apps/cloud-service) runs the desktop kinds it names; every other cloud keeps its placement's provider */
  managed?: ManagedCloudFactory | null;
  /** the managed backend's homes: always the real client, even where `home` fakes the other providers' */
  managedHome?: HomeClient;
  /** signs a cloud's entitlement for its home and the app (shared/entitlement.ts); absent: none are signed */
  entitlements?: { sign(cloud: StoredCloud): string } | null;
  /** told once per cloud: its first time running, and its deletion by the generic lifecycle (a managed backend sends its own) */
  onEvent?: (kind: CloudEventKind, cloud: StoredCloud) => void;
  /** every status change, after it is stored */
  onStatus?: (cloud: StoredCloud, from: CloudStatus | null) => void;
  /** AI sign-ins held for a Cloud still being made, handed to its home once it runs (ai-stash.ts) */
  aiStash?: AiStash | null;
}
export type CloudEventKind = "ready" | "deleted";
interface State { v: 1; clouds: StoredCloud[] }
/** dusk cloud machines looked after at once in one upkeep pass: enough that one slow backup does not stall the rest, few
 *  enough to stay gentle on the shared box (each backup streams through a small buffer) and on the provider's start limits */
const UPKEEP_CONCURRENCY = 4;
const sameSpec = (a: MachineSpec, b: MachineSpec) => a.vcpu === b.vcpu && a.ramGb === b.ramGb && a.diskGb === b.diskGb;
const sameQuota = (a: SlotQuota | undefined, b: SlotQuota) => a && (Object.keys(b) as Array<keyof SlotQuota>).every(k => a[k] === b[k]);

/** a cloud its owner may see: never one a checkout reserved, paid or abandoned, until a payment went through */
export const paidCloud = (c: Pick<StoredCloud, "status" | "subscriptionId">) => c.status !== "checkout" && !(c.status === "destroyed" && c.subscriptionId === null);

export function createCloudsService(options: CloudsServiceOptions): CloudsService {
  const { providers, sealer, workspaces, config, home } = options, now = options.now ?? Date.now, random = options.random ?? randomBytes;
  const unlock = lockDataDir(options.dataDir);
  const store = createJsonStore<State>(join(options.dataDir, "clouds.json"), () => ({ v: 1, clouds: [] }), (v): v is State => {
    if (!v || typeof v !== "object") return false;
    const state = v as State;
    return state.v === 1 && Array.isArray(state.clouds) && state.clouds.every(c => c && /^c[0-9a-f]{24}$/.test(c.id) && CLOUD_STATUSES.includes(c.status) && typeof c.accountId === "string");
  });
  for (const cloud of store.state.clouds) for (const field of ["bootstrapSecret", "sealedLinkPrivateKey"] as const) {
    const value = cloud[field];
    if (value?.startsWith("plain.")) {
      const sealed = sealer.seal(value.slice(6));
      if (sealed !== value) { cloud[field] = sealed; store.commit(); }
    }
  }
  for (const cloud of store.state.clouds) if (!cloud.mailed && cloud.status !== "checkout" && cloud.status !== "provisioning") {
    cloud.mailed = { ready: cloud.createdAt, ...(cloud.status === "destroyed" ? { deleted: cloud.updatedAt } : {}) }; store.commit();
  }
  const powerChanges = new Map<string, number[]>();
  const statusOf = new Map(store.state.clouds.map(c => [c.id, c.status]));
  let pending = Promise.resolve(), reconciling: Promise<void> | null = null, closed = false;
  function exclusive<T>(fn: () => Promise<T>): Promise<T> { const result = pending.then(fn); pending = result.then(() => {}, () => {}); return result; }
  function save(c: StoredCloud) {
    c.updatedAt = now();
    const events: CloudEventKind[] = [];
    if (c.status === "running" && !c.mailed?.ready) { (c.mailed ??= {}).ready = now(); events.push("ready"); }
    if (c.status === "destroyed" && c.provisionedAt !== undefined && c.backend !== "managed" && !c.mailed?.deleted) { (c.mailed ??= {}).deleted = now(); events.push("deleted"); }
    store.commit();
    for (const kind of events) try { options.onEvent?.(kind, c); } catch { console.warn(`clouds: the ${kind} notice failed`); }
    const from = statusOf.get(c.id) ?? null;
    if (from !== c.status) { statusOf.set(c.id, c.status); try { options.onStatus?.(c, from); } catch { console.warn("clouds: the status notice failed"); } }
    if (options.aiStash && (c.ended || ["destroying", "destroyed", "error", "suspended"].includes(c.status))) void options.aiStash.drop(c.id).catch(() => console.warn("clouds: held AI sign-ins could not be dropped; they expire on their own"));
  }
  /** Held AI sign-ins go to each Cloud that runs now, once, then are deleted; a Cloud that can't take them any more drops them. */
  async function deliverSignIns() {
    const stash = options.aiStash;
    if (!stash) return;
    for (const id of await stash.pending()) {
      if (closed) return;
      const c = get(id);
      if (!c || c.ended || ["destroying", "destroyed", "error", "suspended"].includes(c.status)) { await stash.drop(id); continue; }
      if (c.status !== "running" || !c.origin || c.suspended !== null) continue;
      const client = c.backend ? options.managedHome ?? home : home;
      if (!client.signIns) continue;
      const held = await stash.open(id);
      if (!held) continue;
      if (held.accountId !== c.accountId) { await stash.drop(id); continue; }
      const secret = sealer.unseal(c.bootstrapSecret);
      try {
        await client.signIns(c.origin, secret, held.items);
        await stash.drop(id);
      } catch (error) {
        // a home on an older image refuses kinds it doesn't know: it still takes the ChatGPT login, the one kind every home takes
        const older = (error as { status?: unknown }).status === 400 && held.items.some(item => item.kind !== "codex-auth");
        const known = held.items.filter(item => item.kind === "codex-auth");
        if (older && known.length) {
          try { await client.signIns(c.origin, secret, known); await stash.drop(id); continue; } catch {}
        } else if (older) { await stash.drop(id); continue; }
        console.warn(`clouds: handing held AI sign-ins to cloud ${c.id} failed; it is tried again on the next pass`);
      }
    }
  }
  function get(id: string) { return store.state.clouds.find(c => c.id === id) ?? null; }
  function requireCloud(id: string) { const cloud = get(id); if (!cloud) throw new CloudError(404, "not_found"); return cloud; }
  async function pairCloud(c: StoredCloud, member?: TeamMemberClaim) {
    if (c.status !== "running" || !c.origin || c.suspended !== null || c.ended || c.destroyAt !== null && c.destroyAt <= now()) throw new CloudError(409, "unavailable");
    const claims = c.team && member ? { label: "Metal app (Team Cloud)", team: c.team, member } : { label: "Metal app (Cloud)" };
    const result = await (c.backend ? options.managedHome ?? home : home).pair(c.origin, sealer.unseal(c.bootstrapSecret), { ...claims, ttlSeconds: 300 });
    // the cloud's link public key: the app checks its cloud's sealed Mac jobs against it (docs/cloud-uses-mac.md)
    return { origin: c.origin, code: result.code, expiresAt: result.expiresAt, ...(c.linkPublicKey ? { linkKey: c.linkPublicKey } : {}) };
  }
  function requireOwned(accountId: string, id: string) { const cloud = get(id); if (!cloud || cloud.accountId !== accountId) throw new CloudError(404, "not_found"); return cloud; }
  /** a managed cloud is one backend machine of any kind, so it can move between placements; the others cannot */
  function movable(c: StoredCloud, plan: DesktopPlan) { return c.placement === plan.placement || c.backend === "managed" && !!managed?.kinds.includes(plan.kind); }
  function applyPlan(c: StoredCloud, plan: DesktopPlan) {
    if (!movable(c, plan)) throw new CloudError(409, "placement_change_unavailable");
    c.placement = plan.placement; c.kind = plan.kind; c.botComputers = plan.botComputers;
    c.desiredSpec = { ...plan.spec, diskGb: Math.max(c.spec.diskGb, plan.spec.diskGb) };
  }
  function kick() { void service.reconcile().catch(() => {}); }
  // a wake is a few provider steps (resume, ready, start, health): followed every second, not every 15 s, until it answers
  const hurried = new Map<string, number>();
  function hurry(cloudId: string) {
    // a wall-clock deadline: the service's own clock may be a test's
    if (hurried.has(cloudId)) { hurried.set(cloudId, Date.now() + 90_000); return; }
    hurried.set(cloudId, Date.now() + 90_000);
    const step = () => {
      const c = get(cloudId), until = hurried.get(cloudId) ?? 0;
      if (closed || !c || (c.status === "running" && c.wantPower === "on" && !managed?.resizing(c)) || Date.now() > until) { hurried.delete(cloudId); return; }
      c.nextAttemptAt = Math.min(c.nextAttemptAt, now());
      void service.reconcile().catch(() => {}).finally(() => { const t = setTimeout(step, 1_000); t.unref(); });
    };
    step();
  }
  function retry(c: StoredCloud, error: unknown) {
    // the backend's own timing first (a provider limit backs off and never counts against the cloud, even in setup)
    const backendAt = c.backend ? managed?.retryAt(c, error) ?? null : null;
    if (backendAt !== null) { c.nextAttemptAt = backendAt; save(c); return; }
    if (c.backend && c.status !== "provisioning") {
      c.attempts++; c.nextAttemptAt = now() + Math.min(15_000 * 2 ** Math.min(c.attempts - 1, 6), 900_000);
      if (c.attempts === 8) console.warn(`clouds: managed cloud ${c.id} keeps failing its lifecycle step`);
      save(c); return;
    }
    if (error instanceof PoolFullError) {
      c.poolFullSince ??= now();
      if (c.status === "provisioning" && now() - c.poolFullSince >= 30 * 60_000) { c.status = "error"; c.error = "Setup failed. We are on it."; }
      else c.nextAttemptAt = now() + 30_000;
    } else {
      c.attempts++;
      const retryable = error instanceof RetryableCloudError || (error && typeof error === "object" && "retryable" in error && error.retryable === true);
      if (!retryable || c.attempts >= (config.maxAttempts ?? 8)) { c.status = "error"; c.error = "Setup failed. We are on it."; }
      else c.nextAttemptAt = now() + Math.min(30_000 * 2 ** (c.attempts - 1), 900_000);
    }
    if (c.suspended !== null && (c.destroyAt === null || c.destroyAt > now())) {
      c.status = "suspended";
      c.nextAttemptAt = now() + Math.min(30_000 * 2 ** Math.max(0, c.attempts - 1), 900_000);
    }
    save(c);
  }
  function viewOf(c: StoredCloud): CloudDesktopView { return { id: c.id, name: c.name, color: c.color, kind: c.kind, placement: c.placement, status: c.status === "running" && c.paymentProblem ? "payment_problem" : c.status, setupStep: c.setupStep, region: c.region, machine: { ...c.spec }, botComputers: c.botComputers, origin: c.origin, workspaceId: c.workspaceId, lastReportAt: c.workspaceId ? workspaces.lastReportAt(c.workspaceId) : null, destroyAt: c.destroyAt, error: c.error, subscriptionId: c.subscriptionId, createdAt: c.createdAt, revivedAt: c.revivedAt ?? null }; }
  const backend = stateBackend();
  const stored = (id: string): StoredCloud | null => {
    if (backend) return backend.written("clouds", "clouds", id) as StoredCloud | null;
    try {
      return (JSON.parse(readFileSync(join(options.dataDir, "clouds.json"), "utf8")) as State).clouds.find(c => c.id === id) ?? null;
    } catch { return null; }
  };
  const signEntitlement = (c: StoredCloud): string | null => {
    if (!options.entitlements || c.status === "destroyed" || c.status === "checkout" || c.ended || c.suspended !== null) return null;
    try { return options.entitlements.sign(c); } catch { console.warn(`clouds: no entitlement for ${c.id}`); return null; }
  };
  let managed: ManagedCloud | null = null;
  try {
    managed = options.managed ? options.managed.create({ dataDir: options.dataDir, home: options.managedHome ?? home, now, save, stored, clouds: () => store.state.clouds, commit: () => store.commit(),
      unseal: value => sealer.unseal(value), seal: value => sealer.seal(value), dashboardUrl: config.dashboardUrl, adminOrigin: config.adminOrigin,
      removeWorkspace: id => workspaces.remove(id), entitlement: signEntitlement, kick: cloudId => cloudId ? hurry(cloudId) : kick() }) : null;
  } catch (error) { store.close(); unlock(); throw error; }
  /** a hosted home refuses clients without a fresh entitlement: pushed when it comes up, refreshed hourly */
  async function entitle(c: StoredCloud, force = false): Promise<void> {
    if (!c.origin || !home.entitle || (!force && c.entitledAt !== undefined && now() - c.entitledAt < 3_600_000)) return;
    const token = signEntitlement(c);
    if (!token) return;
    try { await home.entitle(c.origin, sealer.unseal(c.bootstrapSecret), token); c.entitledAt = now(); save(c); }
    catch { console.warn(`clouds: the entitlement push to ${c.id} failed; it is tried again`); }
  }
  function succeeded(c: StoredCloud) { c.attempts = 0; c.nextAttemptAt = 0; c.poolFullSince = undefined; c.error = null; save(c); }
  async function reconcileCloud(c: StoredCloud) {
    // any backend, an older record's included: never the generic lifecycle, which could destroy its machine
    if (c.backend) {
      if (!managed) { if (c.error !== "Managed clouds are not configured.") { c.error = "Managed clouds are not configured."; save(c); } return; }
      await managed.reconcile(c);
      if (c.status === "running" || c.status === "sleeping") succeeded(c);
      return;
    }
    const provider = providers[c.placement];
    if (c.destroyAt !== null && c.destroyAt <= now() && c.status !== "destroyed") {
      c.status = "destroying"; save(c);
      if (!c.serverId) c.serverId = (await provider.find(c.id))?.id ?? null;
      if (c.serverId) await provider.destroy(c.serverId);
      await provider.cleanup?.(c.id);
      if (c.workspaceId) workspaces.remove(c.workspaceId);
      c.destroyedOrigin = c.origin ?? c.destroyedOrigin;
      c.status = "destroyed"; c.setupStep = null; c.origin = null; c.ipv4 = null; c.bootstrapSecret = ""; c.sealedLinkPrivateKey = undefined; c.serverId = null;
      succeeded(c); return;
    }
    if (c.status === "destroyed") return;
    if (!c.ended && c.endsAt !== undefined && c.endsAt <= now()) { c.endedAt = c.endsAt; delete c.endsAt; c.ended = true; c.wantPower = "off"; save(c); }
    if (c.ended && c.status === "provisioning") {
      if (!c.serverId) c.serverId = (await provider.find(c.id))?.id ?? null;
      if (c.serverId) await provider.power(c.serverId, "off");
      c.status = "stopped"; succeeded(c); return;
    }
    if (config.configured?.[c.placement] === false) {
      c.error = "dusk cloud is not configured."; save(c); return;
    }
    if (c.suspended !== null) {
      if (!c.suspensionApplied || c.serverId && (await provider.status(c.serverId)).state !== "off") {
        if (!c.serverId) c.serverId = (await provider.find(c.id))?.id ?? null;
        if (c.serverId) {
          if (provider.suspend) await provider.suspend(c.serverId, c.suspended);
          else await provider.power(c.serverId, "off");
        }
        c.suspensionApplied = true; c.status = "suspended"; succeeded(c);
      }
      return;
    }
    if (c.status === "checkout" || c.status === "error" || c.status === "suspended") return;
    if (c.status === "provisioning") {
      if (c.setupStep === "reserving") {
        let server = await provider.find(c.id);
        if (!server) {
          if (!c.sealedLinkPrivateKey || !c.linkPublicKey || !c.workspaceId) throw new Error("Missing cloud bootstrap.");
          const secret = sealer.unseal(c.bootstrapSecret);
          const link = { v: 1 as const, url: config.dashboardUrl, workspaceId: c.workspaceId, publicKey: c.linkPublicKey, privateKey: sealer.unseal(c.sealedLinkPrivateKey), enrolledAt: c.provisionedAt ?? now(), claimed: true };
          const common = { cloudId: c.id, adminOrigin: config.adminOrigin, secret, dashboardUrl: config.dashboardUrl, link, ...(c.team ? { team: c.team } : {}) };
          const userData = c.placement === "pool" ? poolBootstrap({ ...common, origin: "" }) : dedicatedUserData({ ...common, image: config.image, originTemplate: config.originTemplate });
          server = await provider.create({ cloudId: c.id, spec: c.spec, region: c.region, userData, ...(c.placement === "pool" ? { quota: config.poolQuota(c.kind, c.spec, c.botComputers) } : {}) });
        }
        c.serverId = server.id; c.ipv4 = server.ipv4; c.origin = server.origin ?? null;
        c.sealedLinkPrivateKey = undefined; c.appliedQuota = c.placement === "pool" ? config.poolQuota(c.kind, c.spec, c.botComputers) : undefined;
        c.setupStep = "storage"; succeeded(c); return;
      }
      if (!c.serverId) throw new Error("Missing cloud server.");
      if (c.setupStep === "storage") { c.setupStep = "starting"; save(c); return; }
      if (c.setupStep === "starting") {
        const server = await provider.status(c.serverId);
        if (server.state === "missing" || server.state === "error") throw new Error("Cloud server unavailable.");
        c.ipv4 = server.ipv4;
        if (server.state === "running") {
          if (c.placement === "dedicated" && server.ipv4) c.origin = originFor(config.originTemplate, { ipv4: server.ipv4, cloudId: c.id });
          else if (c.placement === "pool") c.origin = server.origin ?? c.origin ?? (await provider.find(c.id))?.origin ?? null;
          if (c.origin) c.setupStep = "checking";
        }
        if (now() - (c.provisionedAt ?? c.createdAt) >= 30 * 60_000 && c.setupStep === "starting") throw new RetryableCloudError();
        succeeded(c); return;
      }
      if (!c.origin || !(await home.healthy(c.origin, sealer.unseal(c.bootstrapSecret)))) throw new RetryableCloudError();
      await entitle(c, true);
      c.status = "running"; c.setupStep = null; c.lastCheckedAt = now(); c.powerSince = now(); succeeded(c); return;
    }
    if (!c.serverId) return;
    const desiredSpec = { ...c.desiredSpec };
    const quota = c.placement === "pool" ? config.poolQuota(c.kind, desiredSpec, c.botComputers) : undefined;
    if (!sameSpec(c.spec, c.desiredSpec) || (quota && !sameQuota(c.appliedQuota, quota)) || c.resizeStage) {
      if (c.placement === "pool") {
        await provider.resize(c.serverId, desiredSpec, quota); c.spec = desiredSpec; c.appliedQuota = quota;
      } else {
        const state = await provider.status(c.serverId);
        if (state.state === "missing" || state.state === "error") throw new Error("Cloud server unavailable.");
        if (!c.resizeStage) c.resizeStage = "off";
        if (c.resizeStage === "off") {
          if (state.state !== "off") { if (state.state !== "stopping") await provider.power(c.serverId, "off"); save(c); return; }
          c.resizeStage = "resize"; save(c);
        }
        if (c.resizeStage === "resize") { await provider.resize(c.serverId, desiredSpec); c.spec = desiredSpec; c.resizeStage = "on"; save(c); return; }
        if (c.resizeStage === "on") {
          if (c.wantPower === "on" && state.state !== "running") { if (state.state === "off") await provider.power(c.serverId, "on"); save(c); return; }
          c.resizeStage = undefined;
        }
      }
      succeeded(c);
    }
    const needsPower = (c.wantPower === "off" && c.status !== "stopped") || (c.wantPower === "on" && c.status === "stopped");
    if (needsPower) {
      const action = c.wantPower;
      await provider.power(c.serverId, action); c.status = action === "on" ? "running" : "stopped"; c.powerSince = now(); succeeded(c);
    }
    if (now() - (c.lastCheckedAt ?? 0) >= 300_000) {
      const state = await provider.status(c.serverId); c.lastCheckedAt = now();
      if (state.state === "missing" || state.state === "error") throw new Error("Cloud server unavailable.");
      succeeded(c);
    }
    if (c.status === "running") await entitle(c);
  }
  const service: CloudsService = {
    managed,
    entitlement: signEntitlement,
    order(input) {
      const id = input.id ?? `c${random(12).toString("hex")}`;
      const existing = get(id);
      if (input.id && existing?.accountId === input.accountId) return existing;
      if (!/^c[0-9a-f]{24}$/.test(id) || get(id)) throw new Error("Unable to allocate cloud id.");
      const cloud: StoredCloud = { id, accountId: input.accountId, name: input.name, color: input.color, kind: input.kind, placement: input.placement, subscriptionId: null, spec: { ...input.spec }, desiredSpec: { ...input.spec }, region: input.region, botComputers: input.botComputers, status: "checkout", setupStep: null, wantPower: "on", serverId: null, ipv4: null, origin: null, bootstrapSecret: "", workspaceId: null, primary: !store.state.clouds.some(c => c.accountId === input.accountId && c.status !== "destroyed"), hidden: false, paymentProblem: false, suspended: null, destroyAt: null, error: null, attempts: 0, nextAttemptAt: 0, createdAt: now(), updatedAt: now(), powerSince: now(), ...(input.team ? { team: { id, name: teamName(input.team) } } : {}) };
      store.state.clouds.push(cloud); save(cloud); return cloud;
    },
    activate(id, subscriptionId, plan) {
      const c = requireCloud(id);
      if (c.status === "destroyed" || c.status === "destroying" || c.ended) return;
      if (c.subscriptionId && c.subscriptionId !== subscriptionId) throw new CloudError(409, "unavailable");
      applyPlan(c, plan); c.subscriptionId = subscriptionId;
      if (c.status !== "checkout") { save(c); return; }
      if (managed?.kinds.includes(plan.kind)) { c.backend = "managed"; c.managed = managed.fresh(); }
      const keys = linkKeys();
      c.workspaceId = workspaces.register({ accountId: c.accountId, name: c.name, publicKey: keys.publicKey });
      c.linkPublicKey = keys.publicKey; c.sealedLinkPrivateKey = sealer.seal(keys.privateKey); c.bootstrapSecret = sealer.seal(random(32).toString("base64url"));
      c.spec = { ...c.desiredSpec }; c.status = "provisioning"; c.setupStep = "reserving"; c.provisionedAt = now(); save(c); kick();
    },
    changePlan(id, plan, options) {
      const c = requireCloud(id); if (c.status === "destroyed" || c.status === "destroying" || c.ended) throw new CloudError(409, "unavailable");
      applyPlan(c, plan); c.nextAttemptAt = 0; save(c);
      if (options?.now && c.backend && managed?.resizing(c)) { managed.resizeNow(c); hurry(c.id); }
    },
    setPaymentProblem(id, problem) { const c = requireCloud(id); if (problem && c.review) return; c.paymentProblem = problem; save(c); },
    setReview(id, review) { const c = requireCloud(id); if (!!c.review === review) return; if (review) c.review = true; else delete c.review; save(c); },
    scheduleDestroy(id, at) { const c = requireCloud(id); if (c.status === "destroyed" || c.status === "destroying" || c.review) return; c.destroyAt = c.ended && c.destroyAt !== null ? Math.min(c.destroyAt, at) : at; save(c); },
    cancelDestroy(id) { const c = requireCloud(id); if (c.status === "destroyed" || c.status === "destroying" || c.ended || c.paymentProblem || c.destroyAt !== null && c.destroyAt <= now()) return; c.destroyAt = null; save(c); },
    end(id, at, from) { const c = requireCloud(id); if (c.status === "destroyed" || c.review) return;
      if (from !== undefined && from > now() && !c.ended) { c.endsAt = c.endsAt === undefined ? from : Math.min(c.endsAt, from); c.destroyAt = c.destroyAt === null ? at : Math.min(c.destroyAt, at); save(c); return; }
      delete c.endsAt; if (!c.ended) c.endedAt = now(); c.ended = true; c.wantPower = "off"; c.destroyAt = c.destroyAt === null ? at : Math.min(c.destroyAt, at); c.nextAttemptAt = 0; save(c); kick(); },
    abandon(id) { const c = requireCloud(id); if (c.status === "checkout") { c.status = "destroyed"; save(c); } },
    movable(id, plan) { const c = get(id); return !!c && movable(c, plan); },
    revivable(id, plan) {
      const c = get(id);
      if (!c?.ended || c.status === "destroyed" || c.status === "destroying" || c.suspended !== null || c.placement !== plan.placement) return false;
      if (c.backend) return !!managed && managed.kinds.includes(plan.kind) && managed.revivable(c);
      return !managed?.kinds.includes(plan.kind) && (c.destroyAt === null || c.destroyAt > now());
    },
    revive(id, subscriptionId, plan) {
      const c = get(id);
      if (!c || !service.revivable(id, plan)) return false;
      applyPlan(c, plan);
      c.subscriptionId = subscriptionId; delete c.ended; delete c.endedAt; delete c.endsAt;
      c.destroyAt = null; c.wantPower = "on"; c.paymentProblem = false; c.hidden = false; c.revivedAt = now();
      c.attempts = 0; c.nextAttemptAt = 0; c.error = null;
      if (!c.backend && c.setupStep !== null && c.status === "stopped") c.status = "provisioning";
      save(c);
      if (c.backend) hurry(c.id); else kick();
      return true;
    },
    get,
    destroyForDeletedAccount(id) {
      const c = requireCloud(id);
      if (c.status === "destroyed") return false;
      if (c.status === "checkout") { c.status = "destroyed"; c.updatedAt = now(); save(c); return true; }
      if (c.review) delete c.review;
      const at = now();
      delete c.endsAt; if (!c.ended) c.endedAt = at; c.ended = true; c.wantPower = "off"; c.destroyAt = at; c.nextAttemptAt = 0; save(c);
      if (c.backend && c.status !== "destroying") managed?.accountDeleted?.(c);
      kick();
      return true;
    },
    scrubAccount(accountId, anonId) {
      for (const cloud of store.state.clouds) if (cloud.accountId === accountId) { cloud.accountId = anonId; cloud.name = "Deleted"; cloud.suspended = cloud.suspended === null ? null : "Account deleted"; }
      store.commit();
    },
    owned(accountId, id) { const c = get(id); return c?.accountId === accountId ? c : null; },
    byWorkspace(workspaceId) { return store.state.clouds.find(c => c.workspaceId === workspaceId && c.status !== "destroyed") ?? null; },
    all() { return [...store.state.clouds]; },
    list(accountId, includeHidden = false) { return store.state.clouds.filter(c => c.accountId === accountId && (includeHidden || !c.hidden)).reverse().sort((a, b) => b.createdAt - a.createdAt); },
    view(c) {
      return { ...viewOf(c), ...(c.backend && managed ? managed.view(c) : {}) };
    },
    rename(accountId, id, patch) {
      const c = requireOwned(accountId, id);
      if (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.trim().length < 1 || patch.name.length > 40 || [...patch.name].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === "<" || ch === ">"))) throw new CloudError(400, "invalid_request");
      if (patch.color !== undefined && patch.color !== null && !CLOUD_SWATCHES.includes(patch.color)) throw new CloudError(400, "invalid_request");
      if (patch.name !== undefined) c.name = patch.name.trim(); if (patch.color !== undefined) c.color = patch.color;
      save(c); return c;
    },
    async suspend(id, reason) {
      await exclusive(async () => {
        const c = requireCloud(id); if (c.status === "destroyed" || c.status === "destroying") throw new CloudError(409, "unavailable");
        c.suspended = reason; c.status = "suspended"; c.wantPower = "off"; c.suspensionApplied = false; c.nextAttemptAt = 0; save(c);
        if (!c.serverId) c.serverId = (await providers[c.placement].find(c.id))?.id ?? null;
        if (c.serverId) { const provider = providers[c.placement]; if (provider.suspend) await provider.suspend(c.serverId, reason); else await provider.power(c.serverId, "off"); }
        c.suspensionApplied = true; save(c);
      });
    },
    async resume(id) {
      await exclusive(async () => {
        const c = requireCloud(id); if (c.status !== "suspended" || c.ended || c.destroyAt !== null && c.destroyAt <= now()) return;
        if (c.serverId) { if (c.placement === "pool") await providers.pool.resume(c.serverId); else await providers.dedicated.power(c.serverId, "on"); }
        c.suspended = null; c.suspensionApplied = undefined; c.wantPower = "on"; c.status = c.setupStep ? "provisioning" : c.serverId ? "running" : "checkout"; c.nextAttemptAt = 0; save(c);
      });
    },
    hide(accountId, id) { const c = requireOwned(accountId, id); if (!["stopped", "destroyed", "error", "checkout"].includes(c.status)) throw new CloudError(409, "not_removable"); c.hidden = true; save(c); return c; },
    async power(accountId, id, action) { const c = requireOwned(accountId, id);
      if (c.backend) {
        // each wake is a provider start: an owner, a page or the slack edge gets 60 power changes an hour per cloud
        const recent = (powerChanges.get(c.id) ?? []).filter(t => t > now() - 3_600_000);
        if (recent.length >= 60) throw new CloudError(429, "rate_limited");
        powerChanges.set(c.id, [...recent, now()]);
      } if (!["running", "stopped", "sleeping"].includes(c.status) || c.suspended !== null || c.ended || c.destroyAt !== null && c.destroyAt <= now()) throw new CloudError(409, "unavailable"); if (action === "on" && (c.status === "stopped" || c.status === "sleeping")) c.wakeRequestedAt = now();
      if (action === "off") c.pauseRequestedAt = now(); else delete c.pauseRequestedAt;
      c.wantPower = action; c.nextAttemptAt = 0; save(c); await service.reconcile(); if (c.wantPower === action && c.status !== (action === "on" ? "running" : "stopped") && c.status !== "error") await service.reconcile();
      if (c.backend && action === "on" && c.status !== "running") hurry(c.id); return c; },
    async pair(accountId, id, ownerEmail) {
      const c = requireOwned(accountId, id);
      return pairCloud(c, c.team && ownerEmail ? { email: ownerEmail, role: "owner" } : undefined);
    },
    async pairMember(id, member) { const c = requireCloud(id); if (!c.team) throw new CloudError(409, "unavailable"); return pairCloud(c, member); },
    async memberLeft(id, email) {
      const c = get(id);
      if (!c?.team || !c.origin || c.status === "destroyed" || c.status === "destroying") return "gone";
      const client = c.backend ? options.managedHome ?? home : home;
      if (!client.memberLeft) return "gone";
      await client.memberLeft(c.origin, sealer.unseal(c.bootstrapSecret), email);
      return "done";
    },
    async holdSignIns(accountId, id, items) {
      const c = requireOwned(accountId, id);
      if (!options.aiStash) throw new CloudError(503, "unavailable");
      if (c.ended || !["checkout", "provisioning", "running"].includes(c.status)) throw new CloudError(409, "unavailable");
      if (!(await options.aiStash.hold(accountId, c.id, items))) throw new CloudError(503, "unavailable");
      if (c.status === "running") kick();
    },
    async dropSignIns(accountId, id) { const c = requireOwned(accountId, id); await options.aiStash?.drop(c.id); },
    reconcile() {
      if (closed) return Promise.resolve();
      if (reconciling) return reconciling;
      reconciling = exclusive(async () => {
        const step = async (c: StoredCloud) => {
          if (closed || c.nextAttemptAt > now()) return;
          try { await reconcileCloud(c); } catch (error) { retry(c, error); }
        };
        const due = store.state.clouds.filter(c => c.nextAttemptAt <= now()), hosted = due.filter(c => c.backend), queue = [...hosted];
        const lanes = Array.from({ length: Math.min(hosted.length, Math.max(1, config.upkeepConcurrency ?? UPKEEP_CONCURRENCY)) }, async () => {
          for (let c = queue.shift(); c; c = queue.shift()) await step(c);
        });
        await Promise.all([(async () => { for (const c of due) if (!c.backend) await step(c); })(), ...lanes]);
        if (managed && !closed) await managed.afterPass(store.state.clouds).catch(() => console.warn("clouds: the managed backend's pass failed; it runs again later"));
        if (!closed) await deliverSignIns().catch(() => console.warn("clouds: the held AI sign-ins pass failed; it runs again later"));
      }).finally(() => { reconciling = null; });
      return reconciling;
    },
    close() { closed = true; hurried.clear(); clearInterval(timer); store.close(); managed?.close(); unlock(); },
  };
  const timer = setInterval(kick, 15_000); timer.unref();
  return service;
}
