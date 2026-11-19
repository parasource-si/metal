import type { ActivityReport, BotReport, WorkspaceDetail, WorkspaceKind, WorkspaceSummary } from "../../../../shared/dashboard-protocol";
import type { AccountData, Scenario } from "../lib/api";
import { dayKey } from "../lib/format";
import type { BillingOverview, CloudDesktop, MachineSpec, PlanCatalog } from "./contracts";

export const fixtureCatalog: PlanCatalog = {
  licenses: [
    { id: "personal", name: "personal", monthly: 0, includedMembers: 1, perExtraMember: 0, maxMembers: 1, work: false, blurb: "Personal and non-commercial use" },
    { id: "starter", name: "work", monthly: 12, includedMembers: 1, perExtraMember: 0, maxMembers: 1, work: true, blurb: "For one person at work" },
    { id: "team", name: "team", monthly: 30, includedMembers: 2, perExtraMember: 20, maxMembers: 50, work: true, blurb: "For a team, 2 seats included" },
  ],
  desktops: [
    { id: "shared-s", name: "plus", monthly: 20, vcpu: 2, ramGb: 4, diskGb: 20, placement: "shared", botComputers: 2, priority: false, sizable: false, blurb: "Always available, wakes in seconds" },
    { id: "shared-m", name: "pro", monthly: 38, vcpu: 4, ramGb: 8, diskGb: 60, placement: "shared", botComputers: 5, priority: true, sizable: false, blurb: "Always available, priority wake" },
    { id: "dedicated", name: "dedicated", monthly: 89, vcpu: 8, ramGb: 16, diskGb: 160, placement: "dedicated", botComputers: null, priority: true, sizable: true, blurb: "A whole machine of your own" },
  ],
  bundles: [
    { id: "free", name: "free", monthly: 0, license: "personal", members: 1, desktop: "none", blurb: "Your bots, on your computer", features: ["Your bots, on your computer", "Personal use", "No subscription"] },
    { id: "starter", name: "plus", monthly: 20, license: "personal", members: 1, desktop: "shared-s", blurb: "dusk cloud, always available", features: ["Your bots work in dusk cloud", "2 vCPU, 4 GB RAM, 20 GB disk", "Always available, wakes in seconds"] },
    { id: "pro", name: "pro", monthly: 50, license: "starter", members: 1, desktop: "shared-m", recommended: true, blurb: "A bigger machine, priority wake and a work license", features: ["4 vCPU, 8 GB RAM, 60 GB disk", "Always available, priority wake", "Work license for one person"] },
    { id: "team", name: "team", monthly: 119, license: "team", members: 2, desktop: "dedicated", blurb: "A dedicated machine and a team license", features: ["Dedicated 8 vCPU, 16 GB RAM, 160 GB disk", "Always available, priority wake", "Team license, 2 seats"] },
  ],
  poolRegions: ["eu-central"],
  regions: [
    { id: "eu-central", name: "Germany", city: "Falkenstein" },
    { id: "eu-north", name: "Finland", city: "Helsinki" },
    { id: "us-east", name: "United States East", city: "Ashburn" },
    { id: "us-west", name: "United States West", city: "Hillsboro" },
    { id: "ap-southeast", name: "Singapore", city: "Singapore" },
  ],
  custom: { base: 7, perVcpu: 4, perGbRam: 2, per20GbDisk: 3, includedDiskGb: 40, vcpu: { min: 2, max: 8, step: 2 }, ramGb: { min: 4, max: 16, step: 4 }, diskGb: { min: 40, max: 200, step: 20 } },
  // two months free
  yearlyDiscount: 1 / 6,
  workFreeUntil: new Date(2026, 11, 1).getTime(),
};

const DAY = 86_400_000;
const GB = 1024 ** 3;
export const fixtureWorkspaceIds = { mac: "fx-mac", vps: "fx-vps", cloud: "fx-cloud-workspace" };

function seeded(seed: number) {
  let value = seed;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}

export function fixtureAccount(scenario: Scenario, now = Date.now()): AccountData {
  return {
    profile: { id: "fx-sid", email: "sid@duskbot.test", name: "Sid", avatarUrl: null, createdAt: now - 215 * DAY, onboarded: scenario !== "new" && scenario !== "signedout" },
    identities: (scenario === "cloud" ? ["google", "email"] as const : ["email"] as const).map((provider) => ({ provider, label: "sid@duskbot.test", linkedAt: now - 200 * DAY })),
    devices: [
      { id: "fx-browser", kind: "browser", label: "Chrome on macOS", platform: "macOS 26.1", location: "Mumbai, IN", createdAt: now - 8 * DAY, lastSeenAt: now, current: true },
      { id: "fx-desktop", kind: "desktop", label: "MacBook-Pro", platform: "macOS 26.1", location: "Mumbai, IN", createdAt: now - 200 * DAY, lastSeenAt: now - 40_000, current: false },
      { id: "fx-phone", kind: "phone", label: "iPhone 17 Pro", platform: "iOS 26.1", location: "Pune, IN", createdAt: now - 34 * DAY, lastSeenAt: now - 20 * 60_000, current: false },
    ],
    notifications: { cloudStatus: true, product: true },
  };
}

export function fixtureBilling(scenario: Scenario, now = Date.now()): BillingOverview {
  // managed: a managed cloud whose plan was cancelled and has ended
  const paid = scenario === "cloud" || scenario === "managed", ended = scenario === "managed";
  return {
    subscription: paid ? { id: "fx-sub", bundle: "pro", selection: { license: "starter", members: 1, desktop: "shared-m", size: null, region: "eu-central", interval: "month" }, status: ended ? "canceled" : "active", amountUsd: 50, currentPeriodEnd: now + (ended ? -3 : 18) * DAY, cancelAt: ended ? now - 3 * DAY : null } : null,
    paymentMethod: paid ? { brand: "Visa", last4: "4242", expMonth: 9, expYear: new Date(now).getFullYear() + 3 } : null,
    retention: paid && !ended ? { offer: { percent: 30, cycles: 3 }, applied: null } : null,
    invoices: paid ? Array.from({ length: 5 }, (_, i) => ({ id: `fx-invoice-${i}`, number: `DUSK-${new Date(now).getFullYear()}-${String(105 - i).padStart(4, "0")}`, date: now - (12 + 30 * i) * DAY, description: "Pro, monthly", amountUsd: 50, status: "paid" as const, url: null })) : [],
  };
}

export function fixtureClouds(scenario: Scenario, now = Date.now()): CloudDesktop[] {
  if (scenario === "managed") return [{ id: "fx-cloud", name: "Sid's Cloud", status: "stopped", tier: "shared-m", placement: "shared", region: "eu-central", vcpu: 4, ramGb: 8, diskGb: 60, workspaceId: fixtureWorkspaceIds.cloud, createdAt: now - 60 * DAY, progress: null, error: null, botComputers: { used: 2, limit: 5 }, uptimeSec: null, provider: "managed", lastBackupAt: now - 3 * DAY, deleteScheduledAt: null, deleteAskedAt: null }];
  if (scenario !== "cloud" && scenario !== "provisioning") return [];
  const provisioning = scenario === "provisioning";
  return [{ id: "fx-cloud", name: "Sid's Cloud", status: provisioning ? "provisioning" : "running", tier: "shared-m", placement: "shared", region: "eu-central", vcpu: 4, ramGb: 8, diskGb: 60, workspaceId: provisioning ? null : fixtureWorkspaceIds.cloud, createdAt: provisioning ? now : now - 12 * DAY, progress: provisioning ? { step: "Reserving your machine", value: 0 } : null, error: null, botComputers: { used: 2, limit: 5 }, uptimeSec: provisioning ? null : 12 * DAY / 1000 }];
}

function fixtureBots(kind: WorkspaceKind, now: number): BotReport[] {
  const names = kind === "mac" ? [["nova", "Nova", "blue", "blob"], ["quill", "Quill", "purple", "clover"], ["juno", "Juno", "pink", "heart"], ["basil", "Basil", "yellow", "teardrop"]] : kind === "vps" ? [["rivet", "Rivet", "orange", "hex"]] : [["tally", "Tally", "green", "star"], ["echo", "Echo", "teal", "capsule"], ["moss", "Moss", "green", "blob"], ["pip", "Pip", "yellow", "heart"], ["wren", "Wren", "purple", "clover"], ["ivy", "Ivy", "pink", "teardrop"], ["otto", "Otto", "orange", "hex"]];
  return names.map(([id, name, color, body], i) => ({ id, name, color, body: body ?? null, model: i === 1 ? "claude-opus-4.6" : "gpt-5.5", engine: i === 1 ? "Claude" : "Codex", computer: kind === "mac" ? "local-vm" : "vps", busy: (kind === "mac" || kind === "linux") && i === 0 || (kind === "linux" && i === 3), lastActiveAt: now - i * 18 * 60_000, routines: [{ id: `${id}-brief`, name: i === 0 ? "Morning brief" : "Weekly review", schedule: i === 0 ? "Every day at 8:00" : "Every Friday at 17:00", paused: false, nextRunAt: now + (i + 1) * 3600_000, lastRunAt: kind === "linux" && i === 0 ? now - 4 * 60_000 : now - DAY, ...(kind === "linux" && i === 0 ? { running: true } : {}) }] }));
}

function fixtureActivity(bots: BotReport[], seed: number, now: number): ActivityReport {
  const random = seeded(seed);
  const days: ActivityReport["days"] = [];
  const byBot = bots.map((bot) => ({ botId: bot.id, botName: bot.name, turns: 0, tokens: 0, costUsd: 0 }));
  for (let i = 199; i >= 0; i--) {
    if (random() < 0.22) continue;
    const turns = Math.floor(4 + random() * 35), tokens = turns * Math.floor(1800 + random() * 2600), cents = Math.round(tokens / 1800);
    const output = Math.round(tokens * (0.08 + random() * 0.08)), cacheRead = Math.round(tokens * (0.5 + random() * 0.2)), cacheWrite = Math.round(tokens * random() * 0.04);
    days.push({ date: dayKey(now - i * DAY), turns, tokens, costUsd: cents / 100, input: tokens - output - cacheRead - cacheWrite, output, cacheRead, cacheWrite });
    const bot = byBot[i % byBot.length]!;
    bot.turns += turns; bot.tokens += tokens; bot.costUsd += cents;
  }
  for (const bot of byBot) bot.costUsd /= 100;
  const totals = { ...byBot.reduce((sum, b) => ({ turns: sum.turns + b.turns, tokens: sum.tokens + b.tokens, costUsd: Math.round((sum.costUsd + b.costUsd) * 100) / 100 }), { turns: 0, tokens: 0, costUsd: 0 }),
    ...(["input", "output", "cacheRead", "cacheWrite"] as const).reduce((sum, key) => ({ ...sum, [key]: days.reduce((n, d) => n + (d[key] ?? 0), 0) }), {}) };
  const byModel: ActivityReport["byModel"] = [];
  bots.forEach((bot, i) => {
    const usage = byBot[i]!, model = bot.model!;
    const existing = byModel.find((m) => m.model === model);
    if (existing) { existing.turns += usage.turns; existing.tokens += usage.tokens; existing.costUsd = (existing.costUsd ?? 0) + usage.costUsd; }
    else byModel.push({ model, turns: usage.turns, tokens: usage.tokens, costUsd: usage.costUsd });
  });
  return { from: dayKey(now - 199 * DAY), to: dayKey(now), timeZone: "Asia/Kolkata", days, byBot, byModel, totals };
}

export function fixtureWorkspace(id: string, name: string, kind: WorkspaceKind, now = Date.now(), spec?: MachineSpec): WorkspaceDetail {
  const mac = kind === "mac", vps = kind === "vps", random = seeded(mac ? 71 : vps ? 19 : 43);
  const machine = spec ?? (mac ? { vcpu: 10, ramGb: 32, diskGb: 1000 } : vps ? { vcpu: 4, ramGb: 24, diskGb: 200 } : { vcpu: 4, ramGb: 8, diskGb: 80 });
  const lastReportAt = now - (vps ? 75_000 : 2000), bots = fixtureBots(kind, now);
  const workspace: WorkspaceSummary = { id, name, kind, version: "0.1.141", connectedAt: now - (mac ? 200 : vps ? 90 : 12) * DAY, lastReportAt, freshness: vps ? "recent" : "live" };
  const history = Array.from({ length: 40 }, (_, i) => ({ t: lastReportAt - (39 - i) * 5000, cpu: 12 + random() * 35, mem: 36 + random() * 6, rx: Math.round(40_000 + random() * 200_000), tx: Math.round(12_000 + random() * 50_000) }));
  return {
    workspace,
    report: {
      at: lastReportAt, workspace: { name, kind, version: workspace.version, platform: mac ? "darwin" : "linux" },
      machine: { host: { hostname: mac ? name : name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), platform: mac ? "darwin" : "linux", arch: mac || vps ? "arm64" : "x64", cpus: machine.vcpu, cpuModel: mac ? "Apple M2 Pro" : vps ? "Ampere Altra" : "AMD EPYC" }, cpu: { percent: history[39]!.cpu, load: [1.4, 1.2, 0.9] }, memory: { usedBytes: history[39]!.mem / 100 * machine.ramGb * GB, totalBytes: machine.ramGb * GB }, disk: { usedBytes: machine.diskGb * GB * 0.42, totalBytes: machine.diskGb * GB, path: "/" }, network: { rxBytesPerSec: history[39]!.rx, txBytesPerSec: history[39]!.tx }, uptimeSec: (mac ? 3 : 12) * DAY / 1000, processUptimeSec: 32 * 3600, app: { version: workspace.version, node: "24.11.0" }, update: { available: false, latest: null, how: null }, services: [{ id: "server", name: "Metal", state: "running", detail: "All systems ready" }, { id: "computers", name: "Bot computers", state: "running", detail: null }] },
      computers: { provider: mac ? "local" : "vps", computers: bots.map((bot, i) => ({ id: `computer-${bot.id}`, botId: bot.id, botName: bot.name, kind: mac ? "local-vm" : "vps", name: `${bot.name}'s computer`, state: i === 1 || i === 5 ? "asleep" : "running", memoryBytes: i !== 1 && i !== 5 ? 840 * 1024 ** 2 : null, memoryLimitBytes: 2 * GB, cpuPercent: i === 0 ? 12 : 0, lastUsedAt: now - i * 2 * 3600_000, alias: null })) },
      bots, activity: fixtureActivity(bots, mac ? 17 : vps ? 29 : 41, now),
      devices: { thisDevice: { label: name, kind: mac ? "mac" : vps ? "server" : "linux" }, link: { mode: mac ? "direct" : "relay", connected: true, url: null, since: now - 3 * DAY, detail: null }, phones: [{ id: "fx-phone", label: "iPhone 17 Pro", platform: "iOS 26.1", pairedAt: now - 34 * DAY, lastSeenAt: now - 600_000 }], sessions: [{ id: `session-${id}`, label: "Chrome on macOS", createdAt: now - 8 * DAY, lastSeenAt: now - 1000, scopes: ["chat", "computers"] }] },
      plans: { providers: [{ id: "codex", name: "Codex", plan: "Pro", ok: true, windows: [{ label: "5 hours", usedPercent: 26, resetsAt: now + 3 * 3600_000 }, { label: "Weekly", usedPercent: 42, resetsAt: now + 3 * DAY }] }, { id: "claude", name: "Claude", plan: "Max", ok: true, windows: [{ label: "5 hours", usedPercent: 17, resetsAt: now + 2 * 3600_000 }] }] },
    },
    sectionAt: { machine: lastReportAt, computers: lastReportAt, bots: lastReportAt, activity: lastReportAt, devices: lastReportAt, plans: lastReportAt },
    history, commands: [],
  };
}

export function fixtureWorkspaces(scenario: Scenario, now = Date.now()): WorkspaceDetail[] {
  const list = [fixtureWorkspace(fixtureWorkspaceIds.mac, "MacBook-Pro", "mac", now)];
  if (scenario === "mac" || scenario === "cloud" || scenario === "managed") list.push(fixtureWorkspace(fixtureWorkspaceIds.vps, "oracle-mumbai", "vps", now));
  if (scenario === "cloud" || scenario === "managed") list.push(fixtureWorkspace(fixtureWorkspaceIds.cloud, "Sid's Cloud", "linux", now));
  return list;
}

export function fixtureConnections(): Record<string, string[]> {
  return {
    [fixtureWorkspaceIds.mac]: ["gmail", "github", "slack", "notion", "googlecalendar"],
    [fixtureWorkspaceIds.vps]: ["github"],
    [fixtureWorkspaceIds.cloud]: ["gmail", "googlecalendar"],
  };
}

/** of those, the ones connected in the app itself (an MCP server), which only the app changes */
export function fixtureAppsInApp(): Record<string, string[]> {
  return { [fixtureWorkspaceIds.mac]: ["notion"] };
}

/** apps whose sign-in was started and not finished */
export function fixturePendingApps(): Record<string, string[]> {
  return { [fixtureWorkspaceIds.mac]: ["linear"], [fixtureWorkspaceIds.vps]: ["linear"], [fixtureWorkspaceIds.cloud]: ["linear", "figma"] };
}
