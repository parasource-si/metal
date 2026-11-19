import { appSlug, COMMAND_KINDS } from "../../../../shared/dashboard-protocol";
import type { CommandKind, CommandView, ConnectFinishAnswer, ConnectorsAnswer, WorkspaceDetail } from "../../../../shared/dashboard-protocol";
import { PULSE_INTERVAL_MS, PULSE_SIZE, type PulseAnswer, type PulseSample } from "../../../../shared/machine-pulse";
import { ApiError, FIXTURE } from "../lib/api";
import type { BundleId, CheckoutRequest, CloudDesktop, DesktopId, MachineSpec, NotificationPrefs, Selection, Subscription } from "./contracts";
import { fixtureAccount, fixtureAppsInApp, fixtureBilling, fixtureCatalog, fixtureClouds, fixtureConnections, fixturePendingApps, fixtureWorkspace, fixtureWorkspaces } from "./fixtures";
import { desktopOf, licenseOf, priceCart } from "./pricing";
import { CANCEL_ANSWERS } from "./wire";

const DAY = 86_400_000;
/** the managed fixture's emailed delete link: /clouds/fx-cloud/delete?fixture=managed#<this> */
export const FIXTURE_DELETE_TOKEN = "fixture-delete-link".padEnd(43, "0");
const steps = ["Reserving your machine", "Installing Metal", "Linking it to your account", "Waking your bots"];
const fail = (message: string, status = 400, code = "invalid_request"): never => { throw new ApiError(message, status, code); };

function createState() {
  const scenario = FIXTURE ?? "new", now = Date.now();
  const clouds = fixtureClouds(scenario, now);
  return {
    signedIn: scenario !== "signedout", firstSignIn: scenario === "signedout", email: "sid@duskbot.test", intent: "signin", attemptAt: null as number | null,
    account: fixtureAccount(scenario, now), billing: fixtureBilling(scenario, now), clouds,
    workspaces: new Map(fixtureWorkspaces(scenario, now).map((detail) => [detail.workspace.id, detail])),
    connections: fixtureConnections(),
    pendingApps: fixturePendingApps(),
    /** a fixture sign-in finishes this long after its link is handed out */
    signIns: new Map<string, { workspaceId: string; slug: string; at: number }>(),
    slackWake: new Map<string, boolean>(),
    // managed: signed in an hour ago, so deleting data asks for a fresh sign-in first; its link was already "emailed"
    signedInAt: scenario === "managed" ? now - 3_600_000 : now,
    deleteLinks: new Map(scenario === "managed" ? [["fx-cloud", now]] : [] as Array<[string, number]>),
    power: new Map<string, { on: boolean; at: number }>(),
    runningSince: new Map(clouds.filter((cloud) => cloud.status === "running").map((cloud) => [cloud.id, now - (cloud.uptimeSec ?? 0) * 1000])),
    nextId: 1,
  };
}

let state: ReturnType<typeof createState> | null = null;
function current() { return state ??= createState(); }

function sizeFrom(input: unknown): MachineSpec {
  if (!input || typeof input !== "object") return fail("Choose a machine configuration.");
  const size = input as MachineSpec;
  for (const key of ["vcpu", "ramGb", "diskGb"] as const) {
    const range = fixtureCatalog.custom[key];
    if (!Number.isFinite(size[key]) || size[key] < range.min || size[key] > range.max || (size[key] - range.min) % range.step !== 0) fail("Choose a supported machine size.");
  }
  return { vcpu: size.vcpu, ramGb: size.ramGb, diskGb: size.diskGb };
}

function desktopSelection(tier: Exclude<DesktopId, "none">, size: MachineSpec | null) {
  const desktop = desktopOf(fixtureCatalog, tier);
  if (!desktop) return fail("Choose a dusk cloud size.");
  if (size !== null && !desktop.sizable) fail("Choose a dedicated desktop to set its size.");
  const spec = size === null ? desktop : sizeFrom(size);
  return { tier: desktop.id, placement: desktop.placement, vcpu: spec.vcpu, ramGb: spec.ramGb, diskGb: spec.diskGb, limit: desktop.botComputers };
}

function selectionFrom(input: unknown): Selection {
  if (!input || typeof input !== "object") return fail("Choose a subscription.");
  const selection = input as Selection;
  const license = licenseOf(fixtureCatalog, selection.license);
  if (!license) return fail("Choose a license.");
  if (!Number.isInteger(selection.members) || selection.members < 1 || selection.members > license.maxMembers) fail("Choose a supported member count.");
  if (!fixtureCatalog.regions.some((r) => r.id === selection.region)) fail("Choose a region.");
  if (selection.interval !== "month" && selection.interval !== "year") fail("Choose a billing interval.");
  if (selection.desktop === "none") {
    if (selection.size !== null) fail("Choose a dedicated desktop to set its size.");
  } else desktopSelection(selection.desktop, selection.size);
  return { license: license.id, members: selection.members, desktop: selection.desktop, size: selection.size === null ? null : sizeFrom(selection.size), region: selection.region, interval: selection.interval };
}

function subscription(selection: Selection, bundle: BundleId | null, now: number): Subscription {
  return { id: "fx-sub", bundle, selection, status: "active", amountUsd: priceCart(selection, fixtureCatalog).dueNow, currentPeriodEnd: now + (selection.interval === "year" ? 365 : 30) * DAY, cancelAt: null };
}

function resizeCloud(cloud: CloudDesktop, req: { tier: Exclude<DesktopId, "none">; size: MachineSpec | null }) {
  const { limit, ...chosen } = desktopSelection(req.tier, req.size);
  Object.assign(cloud, chosen, { botComputers: { used: cloud.botComputers.used, limit } });
}

function syncCloud(selection: Selection, id: string, now: number) {
  const s = current();
  if (selection.desktop === "none") {
    for (const cloud of s.clouds) {
      s.power.delete(cloud.id); s.runningSince.delete(cloud.id);
      if (cloud.workspaceId) { s.workspaces.delete(cloud.workspaceId); delete s.connections[cloud.workspaceId]; }
    }
    s.clouds = [];
    return;
  }
  if (s.clouds.length) {
    for (const cloud of s.clouds) {
      resizeCloud(cloud, { tier: selection.desktop, size: selection.size });
      cloud.region = selection.region;
    }
    return;
  }
  const { limit, ...chosen } = desktopSelection(selection.desktop, selection.size);
  s.clouds.push({ id, name: "Sid's Cloud", status: "provisioning", ...chosen, region: selection.region, workspaceId: null, createdAt: now, progress: { step: steps[0]!, value: 0 }, error: null, botComputers: { used: 0, limit }, uptimeSec: null });
}

export const FIXTURE_SIGN_IN_MS = 4000;

/** the fixture keeps no state across the sign-in's page load, so its connect state carries the workspace and app */
const fixtureConnectState = (workspaceId: string, slug: string) => btoa(JSON.stringify([workspaceId, slug])).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_").padEnd(32, "A");
function fixtureConnectTarget(state: string): { workspaceId: string; slug: string } | null {
  try {
    const [workspaceId, slug] = JSON.parse(atob(state.replace(/A+$/, "").replace(/-/g, "+").replace(/_/g, "/"))) as unknown[];
    return typeof workspaceId === "string" && typeof slug === "string" ? { workspaceId, slug } : null;
  } catch { return null; }
}

function completeCommand(detail: WorkspaceDetail, command: CommandView, now: number) {
  command.status = "done"; command.doneAt = command.issuedAt + 1200; command.message = "Done.";
  const s = current(), id = detail.workspace.id;
  if (command.kind === "app.connect") {
    command.message = "Sign-in is ready.";
    command.url = `https://connect.composio.dev/link/fixture-${command.target}`;
    // the fixture's provider says yes at once and sends the tab back, as Composio does to a callback
    if (command.callback) { command.url = `${command.callback}&status=success`; command.returnsHere = true; return; }
    s.pendingApps[id] = [...new Set([...(s.pendingApps[id] ?? []), command.target])];
    s.signIns.set(command.id, { workspaceId: id, slug: command.target, at: now + FIXTURE_SIGN_IN_MS });
  }
  if (command.kind === "app.disconnect") {
    command.message = "Disconnected.";
    s.connections[id] = (s.connections[id] ?? []).filter((slug) => slug !== command.target);
    s.pendingApps[id] = (s.pendingApps[id] ?? []).filter((slug) => slug !== command.target);
  }
  const report = detail.report;
  if (!report) return;
  if (command.kind === "computer.wake" || command.kind === "computer.sleep") {
    const computer = report.computers?.computers.find((c) => c.id === command.target || c.botId === command.target);
    if (computer) { computer.state = command.kind === "computer.wake" ? "running" : "asleep"; computer.lastUsedAt = now; }
  }
  if (command.kind === "routine.pause" || command.kind === "routine.resume") {
    for (const bot of report.bots ?? []) for (const routine of bot.routines) if (routine.id === command.target) routine.paused = command.kind === "routine.pause";
  }
  if (report.devices && command.kind === "phone.revoke") report.devices.phones = report.devices.phones.filter((p) => p.id !== command.target);
  if (report.devices && command.kind === "session.revoke") report.devices.sessions = report.devices.sessions.filter((s) => s.id !== command.target);
}

function advance(now: number) {
  const s = current();
  for (const cloud of s.clouds) {
    if (cloud.status === "provisioning") {
      const elapsed = now - cloud.createdAt;
      if (elapsed >= 14_000) {
        cloud.status = "running"; cloud.progress = null; cloud.workspaceId = `workspace-${cloud.id}`;
        s.runningSince.set(cloud.id, cloud.createdAt + 14_000);
        s.workspaces.set(cloud.workspaceId, fixtureWorkspace(cloud.workspaceId, cloud.name, "linux", now, cloud));
        s.connections[cloud.workspaceId] = ["gmail", "googlecalendar", "linear", "figma"];
      } else cloud.progress = { step: steps[Math.min(3, Math.floor(elapsed / 3500))]!, value: Math.max(0, elapsed / 14_000) };
    }
    const pending = s.power.get(cloud.id);
    if (pending && now >= pending.at) {
      cloud.status = pending.on ? "running" : "sleeping";
      if (pending.on) s.runningSince.set(cloud.id, pending.at);
      s.power.delete(cloud.id);
    }
    cloud.uptimeSec = cloud.status === "running" ? Math.max(0, Math.floor((now - (s.runningSince.get(cloud.id) ?? now)) / 1000)) : null;
  }
  for (const detail of s.workspaces.values()) for (const command of detail.commands) if (command.status === "sent" && now - command.issuedAt >= 1200) completeCommand(detail, command, now);
  for (const [id, signIn] of s.signIns) if (now >= signIn.at) {
    s.signIns.delete(id);
    s.connections[signIn.workspaceId] = [...new Set([...(s.connections[signIn.workspaceId] ?? []), signIn.slug])];
    s.pendingApps[signIn.workspaceId] = (s.pendingApps[signIn.workspaceId] ?? []).filter((slug) => slug !== signIn.slug);
  }
}

function fixturePulse(after: number, now: number): PulseSample[] {
  const newest = Math.floor((now - 2000) / PULSE_INTERVAL_MS) * PULSE_INTERVAL_MS, out: PulseSample[] = [];
  for (let t = newest - (PULSE_SIZE - 1) * PULSE_INTERVAL_MS; t <= newest; t += PULSE_INTERVAL_MS) {
    if (t <= after) continue;
    const k = t / PULSE_INTERVAL_MS, noise = Math.sin(k * 12.9898) * 43758.5453 % 1;
    out.push({ t, cpu: Math.round((22 + 14 * Math.sin(t / 17_000) + 9 * Math.sin(t / 5_300) + 6 * Math.abs(noise)) * 10) / 10, mem: Math.round((41 + 3 * Math.sin(t / 40_000) + Math.abs(noise)) * 10) / 10 });
  }
  return out;
}

function workspaceDetail(detail: WorkspaceDetail, now: number): WorkspaceDetail {
  const cloud = current().clouds.find((c) => c.workspaceId === detail.workspace.id);
  const fresh = fixtureWorkspace(detail.workspace.id, detail.workspace.name, detail.workspace.kind, now, cloud);
  fresh.workspace.connectedAt = detail.workspace.connectedAt;
  fresh.commands = detail.commands;
  if (fresh.report && detail.report) {
    fresh.report.bots = detail.report.bots;
    fresh.report.computers = detail.report.computers;
    fresh.report.devices = detail.report.devices;
    if (cloud?.status === "sleeping" || cloud?.status === "stopped") {
      fresh.workspace.freshness = "offline"; fresh.workspace.lastReportAt = detail.workspace.lastReportAt;
      fresh.report.at = detail.workspace.lastReportAt ?? fresh.report.at;
      fresh.sectionAt = detail.sectionAt; fresh.history = detail.history;
    }
    if (cloud && fresh.report.machine) fresh.report.machine.uptimeSec = cloud.uptimeSec ?? 0;
  }
  return fresh;
}

function route(method: string, path: string, body: unknown, query: URLSearchParams): unknown {
  const s = current(), now = Date.now();
  advance(now);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const account = () => ({ id: s.account.profile.id, email: s.account.profile.email, name: s.account.profile.name });
  if (method === "GET" && path === "/v1/auth/providers") return { providers: ["google", "apple", "email"].map((id) => ({ id, enabled: true })) };
  if (method === "GET" && path === "/v1/billing/catalog") return fixtureCatalog;
  if (method === "POST" && path === "/v1/auth/start") {
    if (typeof b.email !== "string" || !b.email.includes("@")) fail("Enter a valid email address.", 400, "invalid_email");
    s.email = (b.email as string).trim().toLowerCase(); s.intent = b.intent === "signup" ? "signup" : "signin"; s.attemptAt = now;
    return { attempt: "fx", resendAfter: 30, expiresIn: 600, codeLength: 8 };
  }
  if (method === "POST" && path === "/v1/auth/verify") {
    if (b.attempt !== "fx" || s.attemptAt === null || now - s.attemptAt > 600_000) fail("That code has expired. Request another.", 400, "expired");
    if (typeof b.code !== "string" || !/^\d{8}$/.test(b.code) || b.code === "00000000") fail("That code does not match.", 400, "wrong_code");
    const created = s.firstSignIn;
    if (created) {
      s.account = fixtureAccount("new", now); s.billing = fixtureBilling("new", now); s.clouds = [];
      s.workspaces = new Map(fixtureWorkspaces("new", now).map((detail) => [detail.workspace.id, detail])); s.firstSignIn = false;
    }
    s.signedIn = true; s.signedInAt = now; s.account.profile.email = s.email;
    for (const identity of s.account.identities) if (identity.provider === "email") identity.label = s.email;
    s.attemptAt = null;
    return { account: account(), created };
  }
  if (!s.signedIn) fail("Sign in to continue.", 401, "unauthorized");
  if (method === "GET" && path === "/v1/auth/device") {
    const userCode = query.get("code");
    if (!userCode || userCode === "XXXXX-00000") fail("Device code not found.", 404, "not_found");
    return { device: { name: "MacBook-Pro", platform: "macOS 26.1" }, userCode, expiresAt: now + 600_000 };
  }
  if (method === "POST" && (path === "/v1/auth/device/approve" || path === "/v1/auth/device/deny")) {
    if (typeof b.userCode !== "string" || !b.userCode || b.userCode === "XXXXX-00000") fail("Device code not found.", 404, "not_found");
    return { ok: true };
  }
  if (method === "GET" && path === "/v1/me") return { account: account() };
  if (method === "POST" && (path === "/v1/auth/signout" || path === "/v1/auth/signout-everywhere")) {
    if (path.endsWith("signout-everywhere")) s.account.devices = [];
    s.signedIn = false; return {};
  }
  if (path === "/v1/account") {
    if (method === "GET") return s.account;
    if (method === "PATCH") {
      if (typeof b.name !== "string") fail("Enter a name.");
      s.account.profile.name = (b.name as string).trim(); return s.account;
    }
    if (method === "DELETE") {
      if (b.confirm !== s.account.profile.email) fail("The email does not match your account.", 400, "confirm_mismatch");
      if (FIXTURE === "cloud" && b.cancelBilling !== true) {
        const blockers = [
          ...(s.billing.subscription ? [{ kind: "subscription" as const, id: s.billing.subscription.id, label: "Pro", status: s.billing.subscription.status }] : []),
          ...s.clouds.map(cloud => ({ kind: "cloud_desktop" as const, id: cloud.id, label: cloud.name, status: cloud.status })),
        ];
        throw new ApiError("Cancel your plan and dusk cloud before deleting your account.", 409, "billing_active", blockers);
      }
      s.signedIn = false; s.firstSignIn = true; return {};
    }
  }
  if (method === "POST" && path === "/v1/account/onboarded") { s.account.profile.onboarded = true; return s.account; }
  if (method === "PUT" && path === "/v1/account/notifications") {
    for (const key of ["cloudStatus", "product"] as const) if (typeof b[key] !== "boolean") fail("Choose your notification preferences.");
    s.account.notifications = { ...b } as unknown as NotificationPrefs; return s.account.notifications;
  }
  const identity = path.match(/^\/v1\/account\/identities\/([^/]+)$/);
  if (method === "DELETE" && identity) {
    if (!s.account.identities.some((i) => i.provider === identity[1])) fail("Identity not found.", 404, "not_found");
    if (s.account.identities.length === 1) fail("Keep at least one sign-in method.", 400, "last_identity");
    s.account.identities = s.account.identities.filter((i) => i.provider !== identity[1]); return {};
  }
  const device = path.match(/^\/v1\/account\/devices\/([^/]+)$/);
  if (method === "DELETE" && device) {
    const found = s.account.devices.find((d) => d.id === decodeURIComponent(device[1]!));
    if (!found) fail("Device not found.", 404, "not_found");
    if (found!.current) fail("Sign out to remove this browser.", 400, "current_device");
    s.account.devices = s.account.devices.filter((d) => d !== found); return {};
  }
  if (method === "GET" && path === "/v1/billing") return s.billing;
  if (method === "POST" && /^\/v1\/billing\/subscriptions\/[^/]+\/card$/.test(path)) return { url: "" };
  if (method === "POST" && path === "/v1/billing/checkout") {
    const { source: _source, ...req } = b as unknown as CheckoutRequest;
    const id = `fx-checkout-${s.nextId++}`;
    if (req.kind === "plan") {
      const selection = selectionFrom(req.selection);
      if (req.bundle !== null && !fixtureCatalog.bundles.some((bundle) => bundle.id === req.bundle)) fail("Choose a bundle.");
      s.billing.subscription = subscription(selection, req.bundle, now);
      syncCloud(selection, id, now);
    } else fail("Choose a checkout item.");
    return { url: "", id };
  }
  if (method === "POST" && path === "/v1/billing/change") {
    if (!s.billing.subscription) fail("No subscription to change.", 404, "not_found");
    const selection = selectionFrom(b.selection);
    const updated = subscription(selection, priceCart(selection, fixtureCatalog).bundle?.id ?? null, now);
    updated.currentPeriodEnd = s.billing.subscription!.currentPeriodEnd;
    s.billing.subscription = updated;
    syncCloud(selection, `fx-cloud-${s.nextId++}`, now);
    return s.billing;
  }
  if (method === "POST" && path === "/v1/billing/retention") return { ok: true };
  if (method === "POST" && path === "/v1/billing/discount") {
    const offer = s.billing.retention?.offer;
    if (!s.billing.subscription || !offer) fail("This account already used its discount.", 409, "discount_used");
    s.billing.retention = { offer: null, applied: { ...offer!, at: now } };
    return s.billing;
  }
  if (method === "POST" && path === "/v1/billing/cancel") {
    if (b.survey !== undefined) {
      const survey = b.survey as { answer?: unknown } | null;
      if (!survey || typeof survey !== "object" || !CANCEL_ANSWERS.some((answer) => answer === survey.answer)) fail("Choose a cancellation reason.");
    }
    if (!s.billing.subscription) fail("No subscription to cancel.", 404, "not_found");
    s.billing.subscription!.cancelAt = s.billing.subscription!.currentPeriodEnd; return s.billing;
  }
  if (method === "GET" && path === "/v1/clouds") return { clouds: s.clouds };
  const slackWakeRoute = path.match(/^\/v1\/clouds\/([^/]+)\/slack-wake$/);
  if ((method === "GET" || method === "PUT") && slackWakeRoute) {
    const id = decodeURIComponent(slackWakeRoute[1]!);
    if (!s.clouds.some((cloud) => cloud.id === id)) return fail("Cloud not found.", 404, "not_found");
    if (method === "PUT") {
      if (typeof b.enabled !== "boolean") return fail("Choose whether to wake for Slack.");
      s.slackWake.set(id, b.enabled);
    }
    const enabled = s.slackWake.get(id) ?? false;
    return { available: true, enabled, state: enabled ? "waiting" : "off", bots: 0, buffered: 0 };
  }
  const deleteData = path.match(/^\/v1\/clouds\/([^/]+)\/delete-data(?:\/(confirm|cancel))?$/);
  if (method === "POST" && deleteData) {
    const cloud = s.clouds.find((c) => c.id === decodeURIComponent(deleteData[1]!));
    if (!cloud || cloud.provider !== "managed") return fail("not_found", 404, "not_found");
    if (deleteData[2] === "cancel") {
      if (!cloud.deleteScheduledAt && !cloud.deleteAskedAt) fail("unavailable", 409, "unavailable");
      cloud.deleteScheduledAt = null; cloud.deleteAskedAt = null; s.deleteLinks.delete(cloud.id);
      return { ok: true };
    }
    if (now - s.signedInAt > 10 * 60_000) fail("reauth_required", 403, "reauth_required");
    const sub = s.billing.subscription;
    if (sub && (sub.status !== "canceled" || sub.currentPeriodEnd > now)) fail("billing_active", 409, "billing_active");
    if (!deleteData[2]) {
      s.deleteLinks.set(cloud.id, now); cloud.deleteAskedAt = now;
      console.info(`fixture email: /clouds/${cloud.id}/delete#${FIXTURE_DELETE_TOKEN}`);
      return { ok: true, emailed: true };
    }
    if (typeof b.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(b.token)) fail("invalid_request", 400, "invalid_request");
    const askedAt = s.deleteLinks.get(cloud.id);
    if (b.token !== FIXTURE_DELETE_TOKEN || askedAt === undefined || now - askedAt > 3_600_000) fail("confirmation_required", 409, "confirmation_required");
    s.deleteLinks.delete(cloud.id); cloud.deleteAskedAt = null; cloud.deleteScheduledAt = now + 7 * DAY;
    return { ok: true, deleteScheduledAt: cloud.deleteScheduledAt };
  }
  const cloudRoute = path.match(/^\/v1\/clouds\/([^/]+)\/(power|resize)$/);
  if (method === "POST" && cloudRoute) {
    const cloud = s.clouds.find((c) => c.id === decodeURIComponent(cloudRoute[1]!));
    if (!cloud) return fail("Cloud not found.", 404, "not_found");
    if (cloudRoute[2] === "resize") resizeCloud(cloud, b as unknown as { tier: Exclude<DesktopId, "none">; size: MachineSpec | null });
    else {
      if (typeof b.on !== "boolean") fail("Choose a power state.");
      if (cloud.status === "provisioning") fail("Wait for your Cloud to finish setup.", 409, "provisioning");
      s.power.set(cloud.id, { on: b.on as boolean, at: now + (b.on ? 2500 : 1500) });
    }
    return cloud;
  }
  if (method === "POST" && path === "/v1/connect/finish") {
    const found = typeof b.state === "string" ? fixtureConnectTarget(b.state) : null;
    if (!found || !s.workspaces.has(found.workspaceId)) fail("This sign-in link expired. Connect the app again.", 404, "connect_expired");
    const outcome = b.status === "success" ? "signed-in" : "cancelled";
    if (outcome === "signed-in") {
      s.pendingApps[found!.workspaceId] = [...new Set([...(s.pendingApps[found!.workspaceId] ?? []), found!.slug])];
      s.signIns.set(`finish-${found!.slug}`, { ...found!, at: now + FIXTURE_SIGN_IN_MS });
    }
    return { ...found!, outcome } satisfies ConnectFinishAnswer;
  }
  if (method === "GET" && path === "/v1/connectors") {
    const ids = [...s.workspaces.keys()], each = <T,>(value: (id: string) => T) => Object.fromEntries(ids.map((id) => [id, value(id)]));
    return { byWorkspace: each((id) => s.connections[id] ?? []), inApp: each((id) => fixtureAppsInApp()[id] ?? []), pending: each((id) => s.pendingApps[id] ?? []), available: each(() => true), at: each(() => now) } satisfies ConnectorsAnswer;
  }
  if (method === "GET" && path === "/v1/workspaces") return { workspaces: [...s.workspaces.values()].map((detail) => workspaceDetail(detail, now).workspace) };
  if (method === "POST" && path === "/v1/claim") {
    if (typeof b.token !== "string" || !b.token) fail("Enter a claim token.");
    const id = `fx-claimed-${s.nextId++}`, detail = fixtureWorkspace(id, "Studio Mac", "mac", now);
    s.workspaces.set(id, detail); return { workspace: detail.workspace };
  }
  const pulse = method === "GET" ? path.match(/^\/v1\/workspaces\/([^/]+)\/pulse$/) : null;
  if (pulse) {
    const detail = s.workspaces.get(decodeURIComponent(pulse[1]!));
    if (!detail) return fail("Workspace not found.", 404, "not_found");
    const cloud = s.clouds.find((c) => c.workspaceId === detail.workspace.id);
    return { v: 1, intervalMs: PULSE_INTERVAL_MS, samples: cloud && cloud.status !== "running" ? [] : fixturePulse(Number(query.get("after") ?? 0), now) } satisfies PulseAnswer;
  }
  const workspace = path.match(/^\/v1\/workspaces\/([^/]+)(\/commands)?$/);
  if (workspace) {
    const id = decodeURIComponent(workspace[1]!), detail = s.workspaces.get(id);
    if (!detail) return fail("Workspace not found.", 404, "not_found");
    if (workspace[2] && method === "POST") {
      if (!COMMAND_KINDS.includes(b.kind as CommandKind) || typeof b.target !== "string") fail("Choose a command and target.");
      if ((b.kind as string).startsWith("app.")) {
        if (!appSlug(b.target)) fail("Command is invalid.", 400, "invalid_command");
        if (workspaceDetail(detail, now).workspace.freshness === "offline") fail(detail.workspace.kind === "vps" ? "This cloud is asleep or not answering. Wake it from clouds, then try again." : "Your computer is asleep. Connect from the Metal app on it, or use dusk cloud.", 409, "workspace_offline");
      }
      const command: CommandView = { id: `fx-command-${s.nextId++}`, kind: b.kind as CommandKind, target: b.target as string, issuedAt: now, expiresAt: now + 600_000, status: "sent", message: null, doneAt: null,
        ...(b.kind === "app.connect" && b.returnHere === true ? { callback: `${location.origin}${location.pathname}?connect=${fixtureConnectState(id, b.target as string)}` } : {}) };
      detail.commands.push(command); return { command };
    }
    if (!workspace[2]) {
      if (method === "GET") return workspaceDetail(detail, now);
      if (method === "PATCH") {
        if (typeof b.name !== "string" || !b.name.trim()) fail("Enter a workspace name.");
        detail.workspace.name = (b.name as string).trim();
        if (detail.report) detail.report.workspace.name = detail.workspace.name;
        const cloud = s.clouds.find((c) => c.workspaceId === id); if (cloud) cloud.name = detail.workspace.name;
        return {};
      }
      if (method === "DELETE") { s.workspaces.delete(id); delete s.connections[id]; delete s.pendingApps[id]; return {}; }
    }
  }
  return fail("Fixture endpoint not found.", 404, "not_found");
}

export function fixtureCall(method: string, path: string, body?: unknown): unknown {
  const url = new URL(path, "https://fixture.test");
  return structuredClone(route(method.toUpperCase(), url.pathname, body, url.searchParams));
}

