// The bot computer (deploy/bot-desktop): a Debian desktop that speaks the same Cua Driver as the Cua image, so
// screenshots, input, AT-SPI and Chromium's CDP reach bots unchanged. Only the box around it differs.
//   free    the host fences the box's network (deploy/bot-desktop/host-fence.sh) and gVisor or user-namespace remapping
//           guards the kernel, so the bot gets sudo and a writable, persistent root: apt, servers, anything, inside.
//   strict  the host has neither: the box fences itself, the root is read-only and sudo is inert (no_new_privs).
import {
  BOT_DESKTOP_BRIDGE,
  BOT_DESKTOP_HOME,
  BOT_DESKTOP_IMAGE,
  BOT_DESKTOP_LABEL,
  BOT_DESKTOP_MODE_LABEL,
  BOT_DESKTOP_NETWORK,
  BOT_DESKTOP_NETWORK_LABEL,
  BOT_DESKTOP_VERSION,
} from "../shared/bot-desktop.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CUA_DRIVER_VERSION, DRIVER_LABEL, dockerSecurityIsHardened, type DockerHardeningConfig } from "./container-computer.ts";
import { PIDS_LIMIT } from "./container-limits.ts";
import { desktopLimitArgs, desktopLimits, type VpsDesktopLimits } from "./vps-capacity.ts";
import { isGateSocket } from "./vps-docker-transport.ts";

export { BOT_DESKTOP_IMAGE, BOT_DESKTOP_LABEL, BOT_DESKTOP_NETWORK, BOT_DESKTOP_VERSION };

export type VpsDesktopKind = "bot-desktop" | "cua";
export type BotDesktopMode = "free" | "strict";

/** New VPS computers get the bot desktop; DUSK_VPS_DESKTOP=cua keeps making Cua XFCE containers. */
export function preferredVpsDesktop(env: NodeJS.ProcessEnv = process.env): VpsDesktopKind {
  return env.DUSK_VPS_DESKTOP === "cua" ? "cua" : "bot-desktop";
}

/** A container's own labels say what it was made from, whichever kind new ones get today. */
export function containerDesktopKind(labels: Record<string, string> | undefined): VpsDesktopKind {
  return labels?.[BOT_DESKTOP_LABEL] ? "bot-desktop" : "cua";
}

export function botDesktopLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return labels?.[BOT_DESKTOP_LABEL] === BOT_DESKTOP_VERSION && labels?.[DRIVER_LABEL] === CUA_DRIVER_VERSION;
}

export function botDesktopVolume(containerName: string): string {
  return `${containerName}-home`;
}

/** strict: NET_ADMIN once for the box's own firewall, SETUID/SETGID to become uid 1000. */
export const STRICT_CAPABILITIES = ["NET_ADMIN", "SETGID", "SETUID"] as const;
/** free: what apt, dpkg and sudo need as root inside the box. Never NET_ADMIN or NET_RAW (no touching the network or
 * spoofing on the bridge), MKNOD, SYS_ADMIN, SYS_PTRACE, SYS_MODULE or anything else that reaches the host. */
export const FREE_CAPABILITIES = [
  "AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "NET_BIND_SERVICE", "SETGID", "SETUID", "SYS_CHROOT",
] as const;

export const BOT_DESKTOP_DNS = ["1.1.1.1", "9.9.9.9"] as const;

/** The flags the harness starts a bot desktop with. */
export function botDesktopRunArgs(input: {
  containerName: string;
  imageRef: string;
  viewerSecret: string;
  labels: string[];
  mode: BotDesktopMode;
  runtime?: "runsc" | null;
  blockedHostAddresses?: string[];
  limits?: VpsDesktopLimits;
}): string[] {
  const free = input.mode === "free";
  const blocked = (input.blockedHostAddresses ?? []).filter(isHostAddress);
  return [
    "run", "-d", "--name", input.containerName, "--hostname", "bot",
    ...input.labels.flatMap((label) => ["--label", label]),
    "--label", `${BOT_DESKTOP_LABEL}=${BOT_DESKTOP_VERSION}`,
    "--label", `${BOT_DESKTOP_MODE_LABEL}=${input.mode}`,
    "--label", `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    ...(input.runtime === "runsc" ? ["--runtime", "runsc"] : []),
    "--network", BOT_DESKTOP_NETWORK,
    // public resolvers: docker's own would forward to the host's, which on many clouds is the fenced metadata address
    ...BOT_DESKTOP_DNS.flatMap((server) => ["--dns", server]),
    // free keeps what the bot installs in the container's own layer until the box is recreated
    ...(free ? [] : ["--read-only"]),
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g",
    "--tmpfs", "/run:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755",
    "--mount", `type=volume,source=${botDesktopVolume(input.containerName)},target=${BOT_DESKTOP_HOME}`,
    "--cap-drop", "ALL",
    ...(free ? FREE_CAPABILITIES : STRICT_CAPABILITIES).flatMap((cap) => ["--cap-add", cap]),
    // sudo is setuid, so no-new-privileges would make it inert; free leans on the host fence and gVisor/userns instead
    ...(free ? [] : ["--security-opt", "no-new-privileges"]),
    "--ipc", "private",
    "--cgroupns", "private",
    ...desktopLimitArgs(input.limits ?? desktopLimits(0, false)), "--cpus", "2",
    "--pids-limit", String(PIDS_LIMIT),
    "--shm-size", "512m",
    // a reboot leaves desktops asleep: they wake one by one when a bot needs one, never all at once
    "--restart", "no",
    "-e", `DUSK_MODE=${input.mode}`,
    "-e", "DUSK_BROWSER_AT_START=off",
    "-e", `VNC_PW=${input.viewerSecret}`,
    ...(!free && blocked.length ? ["-e", `DUSK_BLOCK_EXTRA=${blocked.join(",")}`] : []),
    input.imageRef,
  ];
}

/** One bridge with a fixed interface name, so host-fence.sh can key its rules on it; inter-container traffic off. */
export function botDesktopNetworkCreateArgs(): string[] {
  return [
    "network", "create", "--driver", "bridge",
    "--opt", "com.docker.network.bridge.enable_icc=false",
    "--opt", `com.docker.network.bridge.name=${BOT_DESKTOP_BRIDGE}`,
    "--label", `${BOT_DESKTOP_NETWORK_LABEL}=1`,
    BOT_DESKTOP_NETWORK,
  ];
}

// host probes run the desktop image itself for one command; --userns host because host networking needs it under remapping
const probe = (imageRef: string, extra: string[], entrypoint: string, args: string[]) => [
  "run", "--rm", "--network", "host", "--userns", "host", "--cap-drop", "ALL", ...extra, "--read-only",
  "--entrypoint", entrypoint, imageRef, ...args,
];

/** The host's own addresses, so a strict box refuses them too: a service on the host's public address stays unreachable. */
export function hostAddressProbeArgs(imageRef: string): string[] {
  return probe(imageRef, ["--user", "1000:1000", "--security-opt", "no-new-privileges"], "ip", ["-o", "addr", "show", "scope", "global"]);
}

/** Whether host-fence.sh's rules are in the host's netfilter: reading them needs NET_ADMIN, nothing is changed. */
export function hostFenceProbeArgs(imageRef: string): string[] {
  return probe(imageRef, ["--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges"], "/usr/local/bin/omb-host-fence", ["--check"]);
}

export function parseHostAddresses(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /\binet6?\s+([0-9a-f.:]+)\//i.exec(line);
    if (match && isHostAddress(match[1]!)) found.add(match[1]!.toLowerCase());
  }
  return [...found].slice(0, 32);
}

function isHostAddress(value: string): boolean {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(value)) return value.split(".").every((part) => Number(part) <= 255);
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":") && value.length <= 39;
}

export interface HostIsolation {
  runtime: "runsc" | null;
  userns: boolean;
}

/** From `docker info --format '{{json .}}'`: gVisor under Runtimes, remapping under SecurityOptions.
 * DUSK_VPS_GVISOR=off skips gVisor even when installed. */
export function hostIsolation(infoJson: string, env: NodeJS.ProcessEnv = process.env): HostIsolation {
  try {
    const info = JSON.parse(infoJson) as { Runtimes?: Record<string, unknown> | null; SecurityOptions?: unknown } | null;
    const runsc = Boolean(info?.Runtimes && typeof info.Runtimes === "object" && "runsc" in info.Runtimes);
    const options = Array.isArray(info?.SecurityOptions) ? info.SecurityOptions : [];
    return {
      runtime: runsc && env.DUSK_VPS_GVISOR !== "off" ? "runsc" : null,
      userns: options.some((option) => typeof option === "string" && /(^|,)name=userns(,|$)/.test(option)),
    };
  } catch {
    return { runtime: null, userns: false };
  }
}

/** free only when the host fences the network and something stronger than plain runc guards the kernel. */
export function botDesktopMode(fenced: boolean, isolation: HostIsolation, env: NodeJS.ProcessEnv = process.env): BotDesktopMode {
  if (env.DUSK_VPS_BOX === "strict") return "strict";
  return fenced && (isolation.runtime === "runsc" || isolation.userns) ? "free" : "strict";
}

type HostConfig = DockerHardeningConfig & { ReadonlyRootfs?: boolean; Runtime?: string };
const RUNTIMES = ["", "runc", "io.containerd.runc.v2", "runsc", undefined];
const caps = (config: HostConfig) => (config.CapAdd ?? []).map((cap) => cap.toLowerCase().replace(/^cap_/, "")).sort();
const unsafeOption = (config: HostConfig) => (config.SecurityOpt ?? []).some((option) => /(?:^|=)(?:unconfined|disable)$/i.test(option));

export function botDesktopIsHardened(config: HostConfig | undefined, mode: BotDesktopMode | undefined): boolean {
  if (!config || !RUNTIMES.includes(config.Runtime)) return false;
  if (mode === "free") {
    return (config.CapDrop ?? []).some((cap) => cap.toLowerCase() === "all") &&
      caps(config).join(",") === FREE_CAPABILITIES.map((cap) => cap.toLowerCase()).join(",") &&
      config.Privileged === false && !config.PidMode && config.IpcMode === "private" && !config.UTSMode &&
      !config.Devices?.length && !config.DeviceRequests?.length && !unsafeOption(config) && !config.UsernsMode &&
      config.CgroupnsMode === "private" && config.AutoRemove !== true;
  }
  if (mode !== "strict" || config.ReadonlyRootfs !== true) return false;
  if (!(config.SecurityOpt ?? []).some((option) => /^no-new-privileges(?::true|=true)?$/i.test(option))) return false;
  if (!caps(config).includes("net_admin")) return false;
  return dockerSecurityIsHardened({ ...config, CapAdd: caps(config).filter((cap) => cap !== "net_admin") }, { restartPolicy: "any" });
}

export function botDesktopNetworkIsPrivate(
  config: { NetworkMode?: string; PortBindings?: Record<string, unknown> | null; PublishAllPorts?: boolean } | undefined,
  networks: Record<string, unknown> | null | undefined,
): boolean {
  if (!config || config.NetworkMode !== BOT_DESKTOP_NETWORK) return false;
  const attached = Object.keys(networks ?? {});
  return attached.length === 1 && attached[0] === BOT_DESKTOP_NETWORK && config.PublishAllPorts !== true &&
    !Object.values(config.PortBindings ?? {}).some((value) => Array.isArray(value) && value.length > 0);
}

/** Exactly one mount, the bot's own home volume; never a bind, never another container's volumes. */
export function botDesktopMountsAreSafe(containerName: string, detail: {
  Mounts?: unknown;
  HostConfig?: { Binds?: string[] | null; VolumesFrom?: string[] | null };
}): boolean {
  if (detail.HostConfig?.Binds?.length || detail.HostConfig?.VolumesFrom?.length || !Array.isArray(detail.Mounts)) return false;
  if (detail.Mounts.length !== 1) return false;
  const mount = detail.Mounts[0] as { Type?: string; Name?: string; Destination?: string; Driver?: string };
  return mount.Type === "volume" && mount.Name === botDesktopVolume(containerName) && mount.Destination === BOT_DESKTOP_HOME &&
    (mount.Driver === undefined || mount.Driver === "local");
}

/** A container's mode label and environment must agree; anything else is not a box this app made. */
// images up to v3 read the mode from OMB_MODE, and the computers made for them still carry it
const LEGACY_MODE_ENV = "OMB_MODE";

function envValue(env: string[] | undefined, name: string): string | undefined {
  return env?.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function containerBotDesktopMode(labels: Record<string, string> | undefined, env: string[] | undefined): BotDesktopMode | undefined {
  const mode = labels?.[BOT_DESKTOP_MODE_LABEL];
  if (mode !== "free" && mode !== "strict") return undefined;
  const envMode = envValue(env, "DUSK_MODE") ?? envValue(env, LEGACY_MODE_ENV) ?? "strict";
  return envMode === mode ? mode : undefined;
}

type DockerRun = (args: string[], timeoutMs?: number) => Promise<{ stdout: string }>;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;

function missing(error: unknown): boolean {
  return /no such (object|image|network)|not found/i.test(error instanceof Error ? error.message : String(error));
}

interface BotDesktopPreparation {
  imageId: string;
  mode: BotDesktopMode;
  runtime: HostIsolation["runtime"];
  hostAddresses: string[];
}

const pendingPreparations = new Map<string, Promise<BotDesktopPreparation>>();

export type BotDesktopProgress = "pulling" | "building";

/**
 * The build folder for BOT_DESKTOP_IMAGE that ships with this server (deploy/bot-desktop beside dist-server or server),
 * or DUSK_BOT_DESKTOP_KIT. Null unless its Dockerfile builds exactly BOT_DESKTOP_VERSION and docker can read it (not in an asar).
 */
export function botDesktopKit(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.DUSK_BOT_DESKTOP_KIT?.trim() ? resolve(env.DUSK_BOT_DESKTOP_KIT.trim()) : fileURLToPath(new URL("../deploy/bot-desktop", import.meta.url));
  if (dir.split(sep).some((part) => part.endsWith(".asar"))) return null;
  const dockerfile = `${dir}${sep}Dockerfile`;
  if (!existsSync(dockerfile)) return null;
  try {
    return new RegExp(`^ARG BOT_DESKTOP_VERSION=${BOT_DESKTOP_VERSION}$`, "m").test(readFileSync(dockerfile, "utf8")) ? dir : null;
  } catch {
    return null;
  }
}

function unavailable(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { status: 409, code: "bot_desktop_unavailable", ...(cause === undefined ? {} : { cause }) });
}

function lastLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim().split("\n").filter(Boolean).at(-1) ?? "";
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** What a person sees when the image can't be had: never docker's or a build's own output, which goes to the server log. */
export const BOT_DESKTOP_SETUP_LATER = "This computer couldn't be set up yet. It tries again by itself; try again in a few minutes.";

/** how a home whose own machine builds the image (a managed cloud) waits for it; tests shorten it */
export const hostBuildTiming = { pollMs: 5_000, limitMs: 45 * 60_000 };

/**
 * A managed cloud home's machine builds the image itself, as root beside the docker gate (which never builds), and
 * says how it goes in the file DUSK_BOT_DESKTOP_HOST_BUILD names: building, ready or failed. Waits for it.
 */
async function waitForHostBuild(run: DockerRun, statusFile: string): Promise<void> {
  const until = Date.now() + hostBuildTiming.limitMs;
  for (;;) {
    if (await run(["image", "inspect", BOT_DESKTOP_IMAGE], 20_000).then(() => true, () => false)) return;
    let status = "";
    try { status = readFileSync(statusFile, "utf8").trim(); } catch { status = ""; }
    if (status === "failed") throw unavailable("This cloud computer could not build its new version yet. It tries again by itself within a minute.");
    if (Date.now() > until) throw unavailable("This cloud computer is still building its new version. Try again in a few minutes.");
    await new Promise((done) => setTimeout(done, hostBuildTiming.pollMs));
  }
}

/**
 * Whether builds can run on this docker host. Behind the docker gate (a server set up by the link service) they never
 * can: the gate forwards no build, and must not, since a built image could stand in for the trusted one in the host
 * probes, which run with NET_ADMIN on the host's network.
 */
export function dockerHostBuilds(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isGateSocket(env.DOCKER_HOST);
}

/** Pulls BOT_DESKTOP_IMAGE, else builds it on the docker host from the kit this server ships; refuses plainly when neither works. */
async function obtainBotDesktopImage(run: DockerRun, onProgress?: (step: BotDesktopProgress) => void): Promise<void> {
  onProgress?.("pulling");
  const pullError = await run(["pull", BOT_DESKTOP_IMAGE], 15 * 60_000).then(() => null, (error: unknown) => error);
  if (!pullError) return;
  console.warn(`bot computer image: could not pull ${BOT_DESKTOP_IMAGE}: ${lastLine(pullError)}`);
  const hostBuild = process.env.DUSK_BOT_DESKTOP_HOST_BUILD?.trim();
  if (hostBuild) {
    onProgress?.("building");
    return waitForHostBuild(run, hostBuild);
  }
  const kit = dockerHostBuilds() ? botDesktopKit() : null;
  if (!kit) throw unavailable(BOT_DESKTOP_SETUP_LATER, pullError);
  onProgress?.("building");
  try {
    await run(["build", "--build-arg", `BOT_DESKTOP_VERSION=${BOT_DESKTOP_VERSION}`, "-t", BOT_DESKTOP_IMAGE, kit], 45 * 60_000);
  } catch (error) {
    console.warn(`bot computer image: could not build ${BOT_DESKTOP_IMAGE} on the docker host: ${lastLine(error)}`);
    throw unavailable(BOT_DESKTOP_SETUP_LATER, error);
  }
}

const pendingFetches = new Map<string, Promise<void>>();

/**
 * Gets BOT_DESKTOP_IMAGE onto the host ahead of an update, while the old desktop keeps working: nothing switches to a
 * new version until its image is here. One fetch per host at a time.
 */
export function fetchBotDesktopImage(run: DockerRun, hostKey: string): Promise<void> {
  let fetching = pendingFetches.get(hostKey);
  if (!fetching) {
    fetching = obtainBotDesktopImage(run).finally(() => pendingFetches.delete(hostKey));
    pendingFetches.set(hostKey, fetching);
  }
  return fetching;
}

async function prepareBotDesktop(run: DockerRun, imageId: string | null, onProgress?: (step: BotDesktopProgress) => void): Promise<BotDesktopPreparation> {
  if (!imageId) {
    await obtainBotDesktopImage(run, onProgress);
    const [image] = JSON.parse((await run(["image", "inspect", BOT_DESKTOP_IMAGE], 20_000)).stdout) as Array<{
      Id?: string;
      Config?: { Labels?: Record<string, string> };
    }>;
    if (!image?.Id || !IMAGE_ID.test(image.Id) || !botDesktopLabelsMatch(image.Config?.Labels)) {
      throw Object.assign(new Error(`${BOT_DESKTOP_IMAGE} is not the bot desktop this app expects (version ${BOT_DESKTOP_VERSION})`), { status: 409 });
    }
    imageId = image.Id;
  }
  const ensureNetwork = async () => {
    try {
      const network = JSON.parse((await run(["network", "inspect", BOT_DESKTOP_NETWORK, "--format", "{{json .}}"], 20_000)).stdout) as {
        Labels?: Record<string, string> | null;
        Options?: Record<string, string> | null;
      };
      if (network.Labels?.[BOT_DESKTOP_NETWORK_LABEL] !== "1" || network.Options?.["com.docker.network.bridge.name"] !== BOT_DESKTOP_BRIDGE) {
        throw Object.assign(new Error(`The VPS has a Docker network named ${BOT_DESKTOP_NETWORK} that Metal did not create`), { status: 409 });
      }
    } catch (error) {
      if (!missing(error)) throw error;
      // two bots provisioning at once both see it missing; the second create finding it there is fine
      await run(botDesktopNetworkCreateArgs(), 30_000).catch((created: unknown) => {
        if (!/already exists/i.test(created instanceof Error ? created.message : String(created))) throw created;
      });
    }
  };
  const [, info, fenced] = await Promise.all([
    ensureNetwork(),
    run(["info", "--format", "{{json .}}"], 20_000).catch(() => ({ stdout: "" })),
    run(hostFenceProbeArgs(imageId), 30_000).then(() => true, () => false),
  ]);
  const isolation = hostIsolation(info.stdout);
  const mode = botDesktopMode(fenced, isolation);
  const hostAddresses = mode === "strict"
    ? parseHostAddresses((await run(hostAddressProbeArgs(imageId), 30_000).catch(() => ({ stdout: "" }))).stdout)
    : [];
  return { imageId, mode, runtime: isolation.runtime, hostAddresses };
}

// Security: later starts recheck the host fence and isolation; sharing lasts only while preparation is in flight.
export async function provisionBotDesktop(run: DockerRun, input: {
  containerName: string;
  imageId: string | null;
  labels: string[];
  viewerSecret: string;
  hostKey?: string;
  onProgress?: (step: BotDesktopProgress) => void;
  /** holds the host's room for this desktop around its start (server/vps-capacity.ts) */
  admit?: (start: (limits: VpsDesktopLimits) => Promise<unknown>) => Promise<unknown>;
  /** runs once the image is ready, just before the new desktop is created (an update sets the old one aside here) */
  beforeCreate?: () => Promise<void>;
}): Promise<BotDesktopMode> {
  const key = input.hostKey ? JSON.stringify([input.hostKey, input.imageId, process.env.DUSK_VPS_GVISOR, process.env.DUSK_VPS_BOX]) : null;
  let preparation = key ? pendingPreparations.get(key) : undefined;
  if (!preparation) {
    preparation = prepareBotDesktop(run, input.imageId, input.onProgress);
    if (key) pendingPreparations.set(key, preparation);
  }
  let prepared: BotDesktopPreparation;
  try {
    prepared = await preparation;
  } finally {
    if (key && pendingPreparations.get(key) === preparation) pendingPreparations.delete(key);
  }
  const create = async (limits: VpsDesktopLimits) => {
    await input.beforeCreate?.();
    return run(botDesktopRunArgs({ ...input, limits, imageRef: prepared.imageId, mode: prepared.mode, runtime: prepared.runtime, blockedHostAddresses: prepared.hostAddresses }), 2 * 60_000);
  };
  await (input.admit ? input.admit(create) : create(desktopLimits(0, false)));
  return prepared.mode;
}
