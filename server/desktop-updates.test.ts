import { mkdirSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { SHARED_LOCAL_VM_TARGET, localVmWorkspaceExists, type ContainerComputerStatus, type LocalVmTarget } from "./container-computer.ts";
import { createLocalVmUpdater, createVpsDesktopUpdater, localVmUpdateNeed, recoverLocalVms, VPS_UPDATE_RETRY_MS, vpsDesktopOutdated, vpsDesktopSelfUpdates, vpsUpdateDecision } from "./desktop-updates.ts";

const status = (over: Partial<ContainerComputerStatus>) => ({
  runtime: "docker", daemonUp: true, image: true, imageMatches: true, managed: true, container: "running",
  create_supported: true, ready: false, problem: null, ...over,
}) as ContainerComputerStatus;

describe("shared Local VM recovery", () => {
  it("does not inspect a runtime or desktop in a fresh home that never provisioned a VM", async () => {
    expect(localVmWorkspaceExists(SHARED_LOCAL_VM_TARGET)).toBe(false);
    const inspect = vi.fn(async () => status({ ready: true })), note = vi.fn(), armIdle = vi.fn();
    await recoverLocalVms({ mode: "shared", seats: 2, bots: [], seen: new Set(), status: inspect, note, armIdle });
    expect(inspect).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(armIdle).not.toHaveBeenCalled();
  });
  it("recovers and arms idle shutdown for an existing managed shared workspace", async () => {
    mkdirSync(SHARED_LOCAL_VM_TARGET.workspaceDir, { recursive: true });
    const current = status({ ready: true });
    const inspect = vi.fn(async () => current), note = vi.fn(), armIdle = vi.fn();
    try {
      await recoverLocalVms({ mode: "shared", seats: 2, bots: [], seen: new Set(), status: inspect, note, armIdle });
      expect(inspect).toHaveBeenCalledExactlyOnceWith(SHARED_LOCAL_VM_TARGET);
      expect(note).toHaveBeenCalledExactlyOnceWith(SHARED_LOCAL_VM_TARGET, current);
      expect(armIdle).toHaveBeenCalledExactlyOnceWith(SHARED_LOCAL_VM_TARGET);
    } finally { rmSync(SHARED_LOCAL_VM_TARGET.workspaceDir, { recursive: true, force: true }); }
  });
});

describe("localVmUpdateNeed", () => {
  it("names the old desktops this release must update, and only those", () => {
    expect(localVmUpdateNeed(status({ imageMatches: false }), true)).toBe("recreate");
    expect(localVmUpdateNeed(status({ imageMatches: false, image: false }), false)).toBe("image");
    expect(localVmUpdateNeed(status({ container: "missing", image: false, imageMatches: false }), true)).toBe("image");
    // Nothing to update: a current desktop, a person who never used the VM, a container Metal did not make, no runtime.
    expect(localVmUpdateNeed(status({}), true)).toBeNull();
    expect(localVmUpdateNeed(status({ container: "missing", image: false, imageMatches: false }), false)).toBeNull();
    expect(localVmUpdateNeed(status({ managed: false, imageMatches: false }), true)).toBeNull();
    expect(localVmUpdateNeed(status({ daemonUp: false, imageMatches: false }), true)).toBeNull();
  });
});

describe("vpsDesktopOutdated", () => {
  it("is true only for this bot's own VPS container on an image this release no longer runs", () => {
    const old = { configured: true, daemonUp: true, container: "running", managed: true, imageMatches: false };
    expect(vpsDesktopOutdated(old)).toBe(true);
    expect(vpsDesktopOutdated({ ...old, imageMatches: true })).toBe(false);
    expect(vpsDesktopOutdated({ ...old, container: "missing" })).toBe(false);
    expect(vpsDesktopOutdated({ ...old, managed: false })).toBe(false);
    expect(vpsDesktopOutdated({ ...old, daemonUp: false })).toBe(false);
    expect(vpsDesktopOutdated(null)).toBe(false);
  });
});

describe("createLocalVmUpdater", () => {
  const target: LocalVmTarget = { key: "bot:abc", containerName: "duskbot-computer-abc", workspaceDir: "/nonexistent", viewerPort: null, label: "abc" };
  const setup = (opts: { held?: () => boolean } = {}) => {
    let current = status({ imageMatches: false, image: false });
    const calls: string[] = [];
    let imageBusy = false;
    let provisionBusy = false;
    const lifecycleBusy = new Set<string>();
    const updater = createLocalVmUpdater({
      status: async () => current,
      act: async (action) => {
        calls.push(action);
        if (action === "pull") current = { ...current, image: true };
        if (action === "stop") current = { ...current, container: "stopped" };
        if (action === "remove") current = { ...current, container: "missing" };
        if (action === "run") current = { ...current, container: "running", imageMatches: true };
        return current;
      },
      keepSignIns: async () => { calls.push(`keep (lifecycle busy: ${lifecycleBusy.has(target.key)}, provision busy: ${provisionBusy})`); return "rescued"; },
      keepApps: async () => "none",
      imageBusy: { get: () => imageBusy, set: (busy) => { imageBusy = busy; } },
      provisionBusy: { get: () => provisionBusy, set: (busy) => { provisionBusy = busy; } },
      lifecycleBusy,
      inUse: () => opts.held?.() ?? false,
      updated: () => { calls.push("updated"); },
      workspaceExists: () => true,
      pollMs: 5,
    });
    return { updater, calls, lifecycle: lifecycleBusy, now: () => current };
  };

  it("builds the image, keeps the sign-ins inside the update's own fence, then remakes the desktop", async () => {
    const { updater, calls, lifecycle } = setup();
    expect(updater.observe(target, status({ imageMatches: false, image: false }))).toBe(true);
    await updater.sweep();
    expect(calls).toEqual(["pull", "keep (lifecycle busy: true, provision busy: true)", "remove", "run", "updated"]);
    expect(lifecycle.size).toBe(0);
    expect(updater.pending(target)).toBe(false);
  });

  it("waits while a turn holds the desktop, and starts the moment it is free", async () => {
    let held = true;
    const { updater, calls } = setup({ held: () => held });
    updater.observe(target, status({ imageMatches: false, image: false }));
    const running = updater.sweep();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toEqual(["pull"]);
    held = false;
    await running;
    expect(calls.at(-1)).toBe("updated");
  });

  it("tells a waiting turn plainly, and lets it stop", async () => {
    let held = true;
    const { updater } = setup({ held: () => held });
    updater.observe(target, status({ imageMatches: false, image: false }));
    const announced: string[] = [];
    let current = true;
    const waiting = updater.waitFor(target, { isCurrent: () => current, cancelled: () => new Error("stopped"), announce: (text) => announced.push(text) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    current = false;
    await expect(waiting).rejects.toThrow("stopped");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatch(/^Updating this bot's desktop to the new version/);
    held = false;
  });
});

describe("VPS bot desktops update themselves", () => {
  const outdated = { daemonUp: true, outdated: true };

  it("updates an outdated desktop only while nothing uses it, and never one already updating or current", () => {
    expect(vpsUpdateDecision({ status: outdated, inUse: false, now: 0 })).toBe("update");
    expect(vpsUpdateDecision({ status: outdated, inUse: true, now: 0 })).toBe("busy");
    expect(vpsUpdateDecision({ status: { ...outdated, updating: true }, inUse: false, now: 0 })).toBe("none");
    expect(vpsUpdateDecision({ status: { daemonUp: true }, inUse: false, now: 0 })).toBe("none");
    expect(vpsUpdateDecision({ status: { daemonUp: false, outdated: true }, inUse: false, now: 0 })).toBe("none");
    expect(vpsUpdateDecision({ status: null, inUse: false, now: 0 })).toBe("none");
  });

  it("waits before trying a failed update again", () => {
    expect(vpsUpdateDecision({ status: outdated, inUse: false, failedAt: 1_000, now: 1_000 + VPS_UPDATE_RETRY_MS - 1 })).toBe("retry-later");
    expect(vpsUpdateDecision({ status: outdated, inUse: false, failedAt: 1_000, now: 1_000 + VPS_UPDATE_RETRY_MS })).toBe("update");
  });

  it("treats a self-updating desktop as asleep rather than broken, but still as one awaiting its update", () => {
    const status = { configured: true, daemonUp: true, container: "stopped", managed: true, imageMatches: false, outdated: true };
    expect(vpsDesktopSelfUpdates(status)).toBe(true);
    expect(vpsDesktopOutdated(status)).toBe(true);
    expect(vpsDesktopSelfUpdates({ ...status, outdated: false })).toBe(false);
  });

  it("sweeps one desktop at a time, skips busy ones, keeps a failure for later and logs no secrets of its own", async () => {
    let clock = 0;
    const statuses: Record<string, { daemonUp: boolean; outdated?: boolean }> = {
      idle: { daemonUp: true, outdated: true }, busy: { daemonUp: true, outdated: true }, broken: { daemonUp: true, outdated: true }, current: { daemonUp: true },
    };
    const updated: string[] = [], log: string[] = [];
    let running = 0, most = 0;
    const updater = createVpsDesktopUpdater({
      targets: () => ["idle", "busy", "broken", "current"].map((ownerId) => ({ ownerId, label: ownerId })),
      status: async (target) => statuses[target.ownerId]!,
      inUse: (target) => target.ownerId === "busy",
      update: async (target) => {
        running++; most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        if (target.ownerId === "broken") throw new Error("pull failed");
        updated.push(target.ownerId);
        statuses[target.ownerId] = { daemonUp: true };
      },
      now: () => clock,
      log: (line) => log.push(line),
    });
    await Promise.all([updater.sweep(), updater.sweep()]);
    expect(updated).toEqual(["idle"]);
    expect(most).toBe(1);
    expect(updater.failedAt("broken")).toBe(0);
    expect(log.some((line) => line.includes("broken") && line.includes("the old one is kept"))).toBe(true);
    // the busy one is updated once it is free; the failed one waits out its retry
    statuses.busy = { daemonUp: true, outdated: true };
    const free = createVpsDesktopUpdater({
      targets: () => [{ ownerId: "busy", label: "busy" }],
      status: async () => statuses.busy!, inUse: () => false, update: async () => { updated.push("busy"); }, now: () => clock,
    });
    await free.sweep();
    expect(updated).toEqual(["idle", "busy"]);
    await updater.sweep();
    expect(updated).toEqual(["idle", "busy"]);
    clock = VPS_UPDATE_RETRY_MS;
    statuses.broken = { daemonUp: true, outdated: true };
    await updater.sweep().catch(() => {});
    expect(log.filter((line) => line.includes("broken")).length).toBe(2);
  });
});
