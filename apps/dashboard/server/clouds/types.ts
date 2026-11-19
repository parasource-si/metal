import type { CloudDesktopView, CloudStatus, CloudSwatch, DesktopKind, MachineSpec, Placement, PowerAction, SetupStep } from "../../../../shared/billing-api.ts";

/** a machine as the provider reports it */
export interface ProviderServer {
  id: string;
  /** the provider's own state, mapped */
  state: "creating" | "starting" | "running" | "stopping" | "off" | "deleting" | "missing" | "error";
  ipv4: string | null;
  serverType: string;
  diskGb: number;
  origin?: string;
}

export interface CreateServerInput {
  /** our cloud id, also the server's name and label, so a retried create finds the first one */
  cloudId: string;
  spec: MachineSpec;
  region: string;
  userData: string;
  quota?: SlotQuota;
}

/** provisioning backend. dedicated: fake or hetzner. pool: PoolProvider over pool hosts (fake driver in tests). */
export interface CloudProvider {
  readonly name: "fake" | "hetzner" | "pool" | "managed";
  /** the server a create made for this cloud id, if any (idempotent create) */
  find(cloudId: string): Promise<ProviderServer | null>;
  create(input: CreateServerInput): Promise<ProviderServer>;
  status(serverId: string): Promise<ProviderServer>;
  power(serverId: string, action: PowerAction): Promise<void>;
  /** stops a suspended machine without relying on guest cooperation */
  suspend?(serverId: string, reason: string): Promise<void>;
  /** dedicated servers must be off; pool quotas can change live */
  resize(serverId: string, spec: MachineSpec, quota?: SlotQuota): Promise<void>;
  destroy(serverId: string): Promise<void>;
  /** removes unattached storage left by an interrupted create */
  cleanup?(cloudId: string): Promise<void>;
}

/** a big shared host in the pool, as its driver reports it */
export interface PoolHost {
  id: string;
  region: string;
  /** physical resources available for slots, before the provider's overcommit */
  capacity: { vcpu: number; ramGb: number; diskGb: number; slots: number };
  /** https origins of slots on it are https://<cloudId>.<domain> */
  domain: string;
  draining: boolean;
}
/** the hard limits a slot (one user's server container plus its bot computer containers) runs under */
export interface SlotQuota { vcpu: number; ramGb: number; diskGb: number; netMbps: number; pids: number; botComputers: number | null }
export interface SlotState { id: string; hostId: string; cloudId?: string; state: ProviderServer["state"] | "suspended"; quota: SlotQuota }

/** one host agent per pool host (gVisor containers, separate networks, no shared disks or secrets); fake in tests */
export interface PoolHostDriver {
  hosts(): Promise<PoolHost[]>;
  slots(hostId: string): Promise<SlotState[]>;
  createSlot(hostId: string, input: { cloudId: string; quota: SlotQuota; bootstrap: string }): Promise<SlotState>;
  slot(hostId: string, slotId: string): Promise<SlotState | null>;
  findSlot(cloudId: string): Promise<SlotState | null>;
  power(hostId: string, slotId: string, action: PowerAction): Promise<void>;
  setQuota(hostId: string, slotId: string, quota: SlotQuota): Promise<void>;
  suspend(hostId: string, slotId: string, reason: string): Promise<void>;
  resume(hostId: string, slotId: string): Promise<void>;
  destroySlot(hostId: string, slotId: string): Promise<void>;
}

/** the admin's signed requests to a cloud desktop's own Metal (server/cloud-home.ts) */
/** a Team Cloud's team: DUSK_CLOUD_TEAM_ID and DUSK_CLOUD_TEAM_NAME on its machine */
export interface CloudTeam { id: string; name: string }
export interface TeamMemberClaim { email: string; role: "owner" | "admin" | "member" }
export interface HomeClient {
  /** `team` and `member`: the pairing claim a Team Cloud requires */
  pair(origin: string, secret: string, input: { label: string; ttlSeconds?: number; team?: CloudTeam; member?: TeamMemberClaim }): Promise<{ code: string; expiresAt: number }>;
  /** a Team Cloud deletes what was that person's alone and ends their sessions */
  memberLeft?(origin: string, secret: string, email: string): Promise<void>;
  /** true once the install answers its signed health read */
  healthy(origin: string, secret: string): Promise<boolean>;
  /** the home's idle read (server/cloud-power.ts); only managed homes are asked */
  power?(origin: string, secret: string, idleMinutes: number): Promise<HomePower>;
  /** the sleep handshake: ok once the home agreed and closed for the stop. `force`: the owner's pause, so the home tells its
   * open apps it is going to sleep even while busy, and always agrees. */
  sleep?(origin: string, secret: string, idleMinutes: number, options?: { force?: boolean }): Promise<{ ok: boolean; nextDueAt: number | null }>;
  /** a hosted home's signed entitlement (shared/entitlement.ts): it refuses clients without a valid one */
  entitle?(origin: string, secret: string, token: string): Promise<{ expiresAt: number }>;
  /** tells the home its plan was cancelled or renewed, so it holds its routines (docs/cloud-pro.md) */
  plan?(origin: string, secret: string, input: { cancelled: boolean }): Promise<void>;
  /** hands the home AI sign-ins held for it (ai-stash.ts); resolves once it applied them */
  signIns?(origin: string, secret: string, items: import("./ai-stash.ts").AiSignIn[]): Promise<void>;
  /** the home's own report after an update (server/update-state.ts): the version it runs, its self-test, its finished runs */
  update?(origin: string, secret: string): Promise<HomeUpdateReport>;
}
export interface HomeUpdateReport { version: string | null; selfTest: "running" | "passed" | "failed" | null; runs: Array<{ id: string; ok: boolean; at: number }> }
export interface HomePower {
  idle: boolean; busy: string[]; lastActivityAt: number | null; nextDueAt: number | null; wokeAt: number | null;
  /** the last time work ran on the home (absent from an older home) */
  lastWorkAt?: number | null;
  /** the runs due in the next day, when the home reports them; `flexMs` is how far a run may move (0: its exact time) */
  upcoming?: Array<{ at: number; flexMs: number }>;
  /** holds the home stopped counting after they ran past their cap with nothing moving (server/cloud-power.ts) */
  stuck?: string[];
}

export interface StoredCloud {
  id: string;
  accountId: string;
  name: string;
  /** set at order for a team plan's cloud: its machine boots as a Team Cloud (DUSK_CLOUD_ROLE=team), so members pair to it */
  team?: CloudTeam;
  color: CloudSwatch | null;
  kind: Exclude<DesktopKind, "none">;
  placement: Placement;
  subscriptionId: string | null;
  spec: MachineSpec;
  /** the spec the plan pays for; differs from spec while a resize waits */
  desiredSpec: MachineSpec;
  region: string;
  botComputers: number | null;
  status: CloudStatus;
  setupStep: SetupStep | null;
  /** the power state the owner asked for */
  wantPower: PowerAction;
  serverId: string | null;
  ipv4: string | null;
  origin: string | null;
  destroyedOrigin?: string;
  /** aes-256-gcm sealed when a key is configured; the signing key for its Metal */
  bootstrapSecret: string;
  workspaceId: string | null;
  primary: boolean;
  hidden: boolean;
  paymentProblem: boolean;
  ended?: boolean;
  /** when `ended` was set: the retention clock of a managed cloud starts here */
  endedAt?: number;
  /** when a new plan last brought this cloud back after its plan had ended */
  revivedAt?: number;
  /** dropped from a plan that is paid to this time: runs until then, then ends */
  endsAt?: number;
  /** suspended for abuse: stays stopped until an operator resumes it */
  suspended: string | null;
  /** set while the plan is cancelled or ended; the server is destroyed after it */
  destroyAt: number | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  powerSince: number;
  linkPublicKey?: string;
  sealedLinkPrivateKey?: string;
  provisionedAt?: number;
  poolFullSince?: number;
  lastCheckedAt?: number;
  resizeStage?: "off" | "resize" | "on";
  appliedQuota?: SlotQuota;
  suspensionApplied?: boolean;
  /** the owner or the slack edge asked a stopped or sleeping desktop to wake; the edge times it to the desktop's next sync */
  wakeRequestedAt?: number;
  /** the owner asked it to stop (cleared by their wake): an idle sleep it is already in becomes the owner's pause */
  pauseRequestedAt?: number;
  /** set at activation when a managed backend runs this cloud: its lifecycle is the backend's, never the generic one */
  backend?: "managed";
  /** when the owner was emailed that the cloud is ready, and that it was deleted */
  mailed?: { ready?: number; deleted?: number };
  managed?: ManagedCloudState;
  /** when this service last pushed a signed entitlement to the cloud's home */
  entitledAt?: number;
  /** App Review's demo cloud (POST /v1/billing/ops/review): billing never ends, destroys or flags it, and the managed
   *  backend treats it as paid for, so no retention, archive or delete job takes it. Only its owner's account deletion
   *  (which clears the flag) or an operator's delete ends it. */
  review?: true;
}

/** a managed backend's own per-cloud record (apps/cloud-service adds its fields to this interface) */
export interface ManagedCloudState {}

export interface DesktopPlan { kind: Exclude<DesktopKind, "none">; placement: Placement; spec: MachineSpec; botComputers: number | null }
export interface OrderInput extends DesktopPlan {
  id?: string;
  /** the team's name: the cloud boots as a Team Cloud */
  team?: string;
  accountId: string;
  name: string;
  color: CloudSwatch | null;
  region: string;
}

/** what billing asks of cloud desktops, and what routes read */
export interface CloudsService {
  /** a desktop waiting for its checkout (status checkout) */
  order(input: OrderInput): StoredCloud;
  /** paid: provisioning starts (idempotent) */
  activate(cloudId: string, subscriptionId: string, plan: DesktopPlan): void;
  /** a plan change: resized on the next reconcile (`now`: a managed home restarts into it at once rather than at its
   *  next idle sleep); placement changes are refused unless `movable` */
  changePlan(cloudId: string, plan: DesktopPlan, options?: { now?: boolean }): void;
  /** whether a plan change can take this cloud to `plan`: same placement, or a managed cloud whose backend runs that kind */
  movable?(cloudId: string, plan: DesktopPlan): boolean;
  setPaymentProblem(cloudId: string, problem: boolean): void;
  /** marks or clears App Review's demo cloud */
  setReview(cloudId: string, review: boolean): void;
  /** destroyed at `at` unless cancelled (keep plan, renewed) */
  scheduleDestroy(cloudId: string, at: number): void;
  cancelDestroy(cloudId: string): void;
  /** the plan ended: stopped at `from` (now when it is not later), destroyed at `destroyAt` */
  end(cloudId: string, destroyAt: number, from?: number): void;
  /** a checkout that never completed */
  abandon(cloudId: string): void;
  /** an ended cloud whose data is still kept, so a new plan of this placement (and backend) brings it back */
  revivable(cloudId: string, plan: DesktopPlan): boolean;
  /** a new subscription brings an ended cloud back with its data; false when it no longer can (deleted meanwhile) */
  revive(cloudId: string, subscriptionId: string, plan: DesktopPlan): boolean;
  scrubAccount(accountId: string, anonId: string): void;
  /** its account was deleted: ended now and destroyed (a managed home through its own gated delete, machine and archive
   *  included, tried again until the provider confirms); true when it was not already destroyed */
  destroyForDeletedAccount(cloudId: string): boolean;
  get(cloudId: string): StoredCloud | null;
  owned(accountId: string, cloudId: string): StoredCloud | null;
  /** the desktop a signed workspace belongs to */
  byWorkspace(workspaceId: string): StoredCloud | null;
  list(accountId: string, includeHidden?: boolean): StoredCloud[];
  /** every cloud of every account, for the operator */
  all?(): StoredCloud[];
  view(cloud: StoredCloud): CloudDesktopView;
  rename(accountId: string, cloudId: string, patch: { name?: string; color?: CloudSwatch | null }): StoredCloud;
  /** operator action against abuse (pool and dedicated alike) */
  suspend(cloudId: string, reason: string): Promise<void>;
  resume(cloudId: string): Promise<void>;
  hide(accountId: string, cloudId: string): StoredCloud;
  power(accountId: string, cloudId: string, action: PowerAction): Promise<StoredCloud>;
  /** `ownerEmail`: on a Team Cloud the owner pairs with the team owner's claim */
  pair(accountId: string, cloudId: string, ownerEmail?: string): Promise<{ origin: string; code: string; expiresAt: number }>;
  /** a member's signed pairing to a Team Cloud; the caller checked their membership */
  pairMember(cloudId: string, member: TeamMemberClaim): Promise<{ origin: string; code: string; expiresAt: number }>;
  /** tells a Team Cloud a member left; "gone" when there is no team machine to tell (ended, or never a team cloud) */
  memberLeft(cloudId: string, email: string): Promise<"done" | "gone">;
  /** holds AI sign-ins for the account's Cloud until it runs (ai-stash.ts); refused for a Cloud that ended */
  holdSignIns?(accountId: string, cloudId: string, items: import("./ai-stash.ts").AiSignIn[]): Promise<void>;
  /** deletes what is held for the account's Cloud */
  dropSignIns?(accountId: string, cloudId: string): Promise<void>;
  /** one pass over every desktop that needs work; safe to run concurrently with itself (serialized inside) */
  reconcile(): Promise<void>;
  /** the managed backend when one is configured: owner delete requests, operator holds, resizes */
  readonly managed?: import("./managed.ts").ManagedCloud | null;
  /** a fresh signed entitlement for the cloud's home and the app, or null when this service signs none */
  entitlement?(cloud: StoredCloud): string | null;
  close(): void;
}
