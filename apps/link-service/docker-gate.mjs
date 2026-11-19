#!/usr/bin/env node
// Metal docker gate. The server user is not in the docker group: it reaches docker only through this socket,
// which forwards the Engine API requests Metal sends, on its own labelled containers with fixed safe flags,
// and answers everything else 403. Security invariant: nothing forwarded may give the caller host root.
import { chmodSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_LISTEN = "/run/duskbot-docker/docker.sock";
export const DEFAULT_UPSTREAM = "/var/run/docker.sock";
// the bot computer image (BOT_DESKTOP_IMAGE in shared/bot-desktop.ts), and the names earlier builds were tagged with
export const DEFAULT_PULL = ["ghcr.io/duskbotai/dusk-desktop", "ghcr.io/duskbotai/bot-desktop", "ghcr.io/sidddevz/omb-bot-desktop", "docker.io/trycua/xfce-cua"];

// docker names from before the rename, kept: the bot computers, volumes and network on a server and the published
// image carry them (the app's copy is DOCKER_NAMES in electron/legacy-names.mjs; this file stands alone)
export const VPS_LABEL = "com.openmausbot.vps";
export const BOT_DESKTOP_LABEL = "com.openmausbot.bot-desktop";
export const NETWORK_LABEL = "com.openmausbot.vps-network";
export const DESKTOP_NETWORK = "openmausbot-desktops";
export const DESKTOP_BRIDGE = "omb-desk0";
export const DESKTOP_HOME = "/home/cua";
export const DESKTOP_NAME = /^openmausbot-vps-[a-z0-9]{1,12}-[a-f0-9]{12}$/;
// an update sets the old desktop aside under this name and puts it back if the new one fails (server/vps-computer.ts)
const PREVIOUS_SUFFIX = "-previous";
export const FREE_CAPABILITIES = ["AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "NET_BIND_SERVICE", "SETGID", "SETUID", "SYS_CHROOT"];
export const STRICT_CAPABILITIES = ["NET_ADMIN", "SETGID", "SETUID"];

const PROBES = [
  { entrypoint: ["ip"], cmd: ["-o", "addr", "show", "scope", "global"], user: "1000:1000", caps: [] },
  { entrypoint: ["/usr/local/bin/omb-host-fence"], cmd: ["--check"], user: "", caps: ["NET_ADMIN"] },
];
const NO_NEW_PRIVILEGES = ["no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"];
const MIN_API_MINOR = 40;

const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FULL_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SHORT_ID = /^[a-f0-9]{12,64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const TOKEN = /^[\x21-\x7e]{1,255}$/;
const TEXT = { test: (value) => value.length <= 4096 && !value.includes("\0") };
const TMPFS_OPTION = /^(?:rw|ro|nosuid|nodev|noexec|exec|size=\d{1,12}[kmgKMG%]?|mode=[0-7]{3,4}|uid=\d{1,10}|gid=\d{1,10}|nr_inodes=\d{1,12}[kmgKMG]?)$/;
const LOG_OPTIONS = new Set(["max-size", "max-file", "compress", "labels", "labels-regex", "env", "env-regex", "tag", "mode", "max-buffer-size"]);

const MAX_HEAD = 64 * 1024;
const MAX_BODY = 1024 * 1024;
const MAX_LOOKUP = 16 * 1024 * 1024;
const HIGH_WATER = 2 * 1024 * 1024;
const TRACK_MS = 6 * 3600_000;
const TRACK_MAX = 4096;
const INFO_MS = 60_000;
const IDLE_MS = 5 * 60_000;
const SELF_CHECK_MS = 30_000;
const SELF_CHECK_TIMEOUT_MS = 10_000;
const SELF_CHECK_FAILURES = 3;

export class Refusal extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

function refuse(message, status = 403) {
  throw new Refusal(message, status);
}

/** JSON.parse, but integers only and no repeated keys: Go merges a repeated object key into the same struct. */
export function parseJson(text) {
  const INTEGER = /-?(?:0|[1-9]\d*)(?![.eE\d])/y;
  let at = 0;
  const fail = () => refuse("the request body is not JSON this gate accepts");
  const skip = () => { while (at < text.length && " \t\n\r".includes(text[at])) at++; };
  const string = () => {
    if (text[at] !== '"') fail();
    let end = at + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
    if (end >= text.length) fail();
    const raw = text.slice(at, end + 1);
    at = end + 1;
    try {
      return JSON.parse(raw);
    } catch {
      return fail();
    }
  };
  const token = (pattern) => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) fail();
    at = pattern.lastIndex;
    return match[0];
  };
  const value = (depth) => {
    if (depth > 32) fail();
    skip();
    const c = text[at];
    if (c === "{") {
      at++;
      const out = {};
      skip();
      if (text[at] === "}") { at++; return out; }
      for (;;) {
        skip();
        const key = string();
        skip();
        if (text[at++] !== ":") fail();
        if (Object.hasOwn(out, key)) refuse("the request body repeats a key");
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        skip();
        const next = text[at++];
        if (next === "}") return out;
        if (next !== ",") fail();
      }
    }
    if (c === "[") {
      at++;
      const out = [];
      skip();
      if (text[at] === "]") { at++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        skip();
        const next = text[at++];
        if (next === "]") return out;
        if (next !== ",") fail();
      }
    }
    if (c === '"') return string();
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(word, at)) { at += word.length; return literal; }
    }
    const number = Number(token(INTEGER));
    if (!Number.isSafeInteger(number)) fail();
    return number;
  };
  const result = value(0);
  skip();
  if (at !== text.length) fail();
  return result;
}

function parseBody(body) {
  if (!body.length) return {};
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    refuse("the request body is not UTF-8");
  }
  return parseJson(text);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Docker's own zero value: what the CLI sends for every flag nobody set. */
export function isZero(value) {
  return value === undefined || value === null || value === false || value === 0 || value === "" ||
    (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0);
}

/**
 * Validates one Go struct. Go's encoding/json matches keys case-insensitively, so every key is folded and a fold
 * collision is refused; a key outside `rules` must hold its zero value. Returns the fields by folded name.
 */
function struct(value, where, rules) {
  const fields = new Map();
  if (value === undefined || value === null) return fields;
  if (!isObject(value)) refuse(`${where} must be an object`);
  const known = new Map(Object.keys(rules).map((name) => [name.toLowerCase(), name]));
  for (const [key, field] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) refuse(`${where} has a field this gate does not know`);
    const folded = key.toLowerCase();
    if (fields.has(folded)) refuse(`${where}.${key} is given twice`);
    fields.set(folded, field);
    const name = known.get(folded);
    if (name) rules[name](field, `${where}.${name}`);
    else if (!isZero(field)) refuse(`${where}.${key} is not allowed`);
  }
  return fields;
}

const anything = () => {};
const zero = (value, where) => { if (!isZero(value)) refuse(`${where} is not allowed`); };
const unset = (value, where) => { if (value !== undefined && value !== null) refuse(`${where} must not be set`); };
const notTrue = (value, where) => { if (value !== undefined && value !== null && value !== false) refuse(`${where} is not allowed`); };
const bool = (value, where) => { if (value != null && typeof value !== "boolean") refuse(`${where} must be true or false`); };
const integer = (min, max = Number.MAX_SAFE_INTEGER) => (value, where) => {
  if (value != null && (!Number.isSafeInteger(value) || value < min || value > max)) refuse(`${where} is out of range`);
};
const text = (pattern) => (value, where) => {
  if (value != null && (typeof value !== "string" || !pattern.test(value))) refuse(`${where} is not allowed`);
};
const choice = (...allowed) => (value, where) => { if (!allowed.includes(value ?? "")) refuse(`${where} is not allowed`); };
const list = (item, max = 64) => (value, where) => {
  if (value == null) return;
  if (!Array.isArray(value) || value.length > max) refuse(`${where} is not allowed`);
  value.forEach((entry, index) => item(entry, `${where}[${index}]`));
};
const stringMap = (keys, values, max = 128) => (value, where) => {
  if (value == null) return;
  if (!isObject(value) || Object.keys(value).length > max) refuse(`${where} is not allowed`);
  for (const [key, entry] of Object.entries(value)) {
    if (!keys(key) || typeof entry !== "string" || !values.test(entry)) refuse(`${where} is not allowed`);
  }
};

const labels = stringMap((key) => TOKEN.test(key), TEXT);
const restartNo = (value, where) => { struct(value, where, { Name: choice("", "no"), MaximumRetryCount: zero }); };
const consoleSize = list(integer(0, 65535), 2);
const capList = list(text(/^[A-Za-z_]{1,40}$/), 64);
const noPorts = (value, where) => {
  if (value == null) return;
  if (!isObject(value) || Object.values(value).some((binding) => !isZero(binding))) refuse(`${where}: published ports are not allowed`);
};
const logConfig = (value, where) => {
  struct(value, where, {
    Type: choice("", "json-file", "local"),
    Config: stringMap((key) => LOG_OPTIONS.has(key), TEXT, 16),
  });
};
const tmpfs = (value, where) => {
  if (value == null) return;
  if (!isObject(value)) refuse(`${where} is not allowed`);
  for (const [target, options] of Object.entries(value)) {
    if (target !== "/tmp" && target !== "/run") refuse(`${where} may only mount /tmp and /run`);
    if (typeof options !== "string" || (options !== "" && !options.split(",").every((option) => TMPFS_OPTION.test(option)))) {
      refuse(`${where} options are not allowed`);
    }
  }
};
const ulimits = list((value, where) => { struct(value, where, { Name: text(/^[a-z]{1,16}$/), Soft: integer(-1), Hard: integer(-1) }); }, 32);
const configVolumes = (value, where) => {
  if (value == null) return;
  if (!isObject(value) || Object.entries(value).some(([target, entry]) => target !== DESKTOP_HOME || !isZero(entry))) {
    refuse(`${where} may only name ${DESKTOP_HOME}`);
  }
};
const imageName = (value, where) => {
  if (typeof value !== "string" || !(IMAGE_ID.test(value) || SHORT_ID.test(value) || parseImageRef(value))) refuse(`${where} is not an image reference`);
};

const CONFIG_RULES = {
  Hostname: text(/^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,62})?$/),
  Domainname: text(/^[A-Za-z0-9.-]{0,253}$/),
  User: text(TEXT),
  AttachStdin: bool, AttachStdout: bool, AttachStderr: bool, Tty: bool, OpenStdin: bool, StdinOnce: bool,
  ArgsEscaped: bool, NetworkDisabled: bool,
  ExposedPorts: anything, Env: list(text(TEXT), 256), Cmd: anything, Entrypoint: anything, Shell: list(text(TEXT), 16),
  WorkingDir: text(TEXT), StopSignal: text(/^[A-Za-z0-9+]{0,16}$/), StopTimeout: integer(0, 3600), Healthcheck: anything,
  Image: imageName, Volumes: configVolumes, Labels: labels,
  HostConfig: anything, NetworkingConfig: anything,
};

const HOST_RULES = {
  Binds: zero, ContainerIDFile: zero, LogConfig: logConfig, NetworkMode: text(REF), PortBindings: noPorts,
  RestartPolicy: restartNo, AutoRemove: bool, VolumeDriver: zero, VolumesFrom: zero, ConsoleSize: consoleSize,
  CapAdd: capList, CapDrop: capList, CgroupnsMode: choice("", "private"), Dns: list(text(/^[0-9A-Fa-f.:]{2,45}$/), 8),
  DnsOptions: list(text(TOKEN), 16), DnsSearch: list(text(HOSTNAME), 16), ExtraHosts: list(text(TOKEN), 64),
  IpcMode: choice("", "private"), OomScoreAdj: integer(0, 1000), PidMode: zero, Privileged: notTrue, PublishAllPorts: notTrue,
  ReadonlyRootfs: bool, SecurityOpt: list(choice(...NO_NEW_PRIVILEGES), 4), Tmpfs: tmpfs, UTSMode: zero,
  UsernsMode: choice("", "host"), ShmSize: integer(0), Runtime: choice("", "runc", "runsc"), Isolation: choice("", "default"),
  Mounts: anything, MaskedPaths: unset, ReadonlyPaths: unset, Init: bool,
  CpuShares: integer(0), Memory: integer(0), NanoCpus: integer(0), BlkioWeight: integer(0, 1000), CpuPeriod: integer(0),
  CpuQuota: integer(-1), CpusetCpus: text(/^[0-9,-]{0,128}$/), CpusetMems: text(/^[0-9,-]{0,128}$/),
  MemoryReservation: integer(0), MemorySwap: integer(-1), MemorySwappiness: integer(-1, 100), OomKillDisable: notTrue,
  PidsLimit: integer(-1), Ulimits: ulimits,
};

const PROBE_CONFIG = new Set(["image", "user", "entrypoint", "cmd", "attachstdin", "attachstdout", "attachstderr", "tty", "openstdin", "stdinonce", "hostconfig", "networkingconfig"]);
const PROBE_HOST = new Set(["networkmode", "usernsmode", "capadd", "capdrop", "readonlyrootfs", "securityopt", "autoremove", "restartpolicy", "logconfig", "ipcmode", "cgroupnsmode", "consolesize", "memoryswappiness"]);
const DESKTOP_CAPS = new Set([...FREE_CAPABILITIES, ...STRICT_CAPABILITIES]);

const capName = (cap) => String(cap).toUpperCase().replace(/^CAP_/, "");
const noNewPrivileges = (options) => Array.isArray(options) && options.some((option) => NO_NEW_PRIVILEGES.includes(option));
const same = (left, right) => Array.isArray(left) && left.length === right.length && left.every((entry, index) => entry === right[index]);

function addedCapabilities(host) {
  const drop = host.get("capdrop") ?? [];
  if (!drop.some((cap) => String(cap).toUpperCase() === "ALL")) refuse("HostConfig.CapDrop must include ALL");
  return [...new Set((host.get("capadd") ?? []).map(capName))].sort();
}

function endpoints(value, network) {
  const config = struct(value, "NetworkingConfig", { EndpointsConfig: anything });
  const all = config.get("endpointsconfig");
  if (isZero(all)) return;
  if (!isObject(all)) refuse("NetworkingConfig.EndpointsConfig is not allowed");
  for (const [name, endpoint] of Object.entries(all)) {
    if (name !== network) refuse("NetworkingConfig may only name the container's own network");
    struct(endpoint, "NetworkingConfig.EndpointsConfig", { Aliases: list(text(HOSTNAME), 16), DNSNames: list(text(HOSTNAME), 16) });
  }
}

function homeMount(value, name) {
  if (isZero(value)) return;
  if (!Array.isArray(value) || value.length !== 1) refuse("HostConfig.Mounts may only hold the computer's home volume");
  const mount = struct(value[0], "HostConfig.Mounts[0]", {
    Type: choice("volume"), Source: anything, Target: anything, ReadOnly: bool, Consistency: choice("", "default"),
    VolumeOptions: (options, where) => {
      struct(options, where, { NoCopy: bool, DriverConfig: (driver, at) => { struct(driver, at, { Name: choice("", "local") }); } });
    },
  });
  if (mount.get("type") !== "volume" || mount.get("source") !== `${name}-home` || mount.get("target") !== DESKTOP_HOME) {
    refuse(`HostConfig.Mounts may only mount the volume ${name}-home at ${DESKTOP_HOME}`);
  }
}

function checkDesktop(config, name, runsc) {
  if (config.get("labels")[VPS_LABEL] !== "1") refuse(`label ${VPS_LABEL} must be 1`);
  if (typeof name !== "string" || !DESKTOP_NAME.test(name)) refuse(`a bot computer must be named like ${DESKTOP_NAME.source}`);
  if (!config.get("image")) refuse("Image is required");
  const host = struct(config.get("hostconfig"), "HostConfig", HOST_RULES);
  const strict = host.get("readonlyrootfs") === true && noNewPrivileges(host.get("securityopt"));
  for (const cap of addedCapabilities(host)) {
    if (!DESKTOP_CAPS.has(cap) || (cap === "NET_ADMIN" && !strict)) refuse(`HostConfig.CapAdd ${cap} is not allowed`);
  }
  const network = host.get("networkmode");
  if (network !== DESKTOP_NETWORK && network !== "bridge") refuse(`HostConfig.NetworkMode must be ${DESKTOP_NETWORK} or bridge`);
  endpoints(config.get("networkingconfig"), network);
  if (host.get("ipcmode") !== "private") refuse("HostConfig.IpcMode must be private");
  if (host.get("cgroupnsmode") !== "private") refuse("HostConfig.CgroupnsMode must be private");
  if (!isZero(host.get("usernsmode"))) refuse("HostConfig.UsernsMode is not allowed");
  if (!(host.get("pidslimit") > 0)) refuse("HostConfig.PidsLimit must be set");
  if (runsc && host.get("runtime") !== "runsc") refuse("this host has gVisor, so HostConfig.Runtime must be runsc");
  homeMount(host.get("mounts"), name);
  return { kind: "desktop" };
}

function checkProbe(config, name) {
  if (name !== undefined) refuse(`a container without label ${VPS_LABEL} may not be named`);
  for (const [key, value] of config) if (!PROBE_CONFIG.has(key) && !isZero(value)) refuse(`a host probe may not set ${key}`);
  const shape = PROBES.find((probe) => same(config.get("entrypoint"), probe.entrypoint) && same(config.get("cmd"), probe.cmd));
  if (!shape) refuse(`a container without label ${VPS_LABEL} must be one of the two host probes`);
  if ((config.get("user") ?? "") !== shape.user) refuse("the host probe runs as the wrong user");
  const image = config.get("image");
  if (typeof image !== "string" || !IMAGE_ID.test(image)) refuse("a host probe must name its image by id");
  const host = struct(config.get("hostconfig"), "HostConfig", HOST_RULES);
  for (const [key, value] of host) if (!PROBE_HOST.has(key) && !isZero(value)) refuse(`a host probe may not set HostConfig.${key}`);
  if (host.get("networkmode") !== "host" || host.get("usernsmode") !== "host") refuse("a host probe must use the host network and user namespace");
  if (host.get("readonlyrootfs") !== true || host.get("autoremove") !== true || !noNewPrivileges(host.get("securityopt"))) {
    refuse("a host probe must be read-only, removed on exit and without new privileges");
  }
  if (!same(addedCapabilities(host), shape.caps)) refuse("the host probe asks for the wrong capabilities");
  endpoints(config.get("networkingconfig"), "host");
  return { kind: "probe", image };
}

/** POST /containers/create: a Metal computer (label VPS_LABEL=1) or one of the two host probes. */
export function checkCreate(body, { name, runsc = false } = {}) {
  if (!isObject(body)) refuse("the container config must be an object");
  const config = struct(body, "Config", CONFIG_RULES);
  const own = config.get("labels") ?? {};
  return Object.hasOwn(own, VPS_LABEL) ? checkDesktop(config, name, runsc) : checkProbe(config, name);
}

/** POST /containers/{id}/exec: anything inside the box, never privileged. */
export function checkExec(body) {
  if (!isObject(body)) refuse("the exec config must be an object");
  struct(body, "exec", {
    User: text(TEXT), Privileged: notTrue, Tty: bool, ConsoleSize: consoleSize, AttachStdin: bool, AttachStderr: bool,
    AttachStdout: bool, Detach: bool, DetachKeys: text(/^[a-z0-9,-]{0,64}$/), Env: list(text(TEXT), 256), WorkingDir: text(TEXT), Cmd: anything,
  });
}

export function checkExecStart(body) {
  if (!isObject(body)) refuse("the exec start config must be an object");
  return { detach: struct(body, "exec start", { Detach: bool, Tty: bool, ConsoleSize: consoleSize }).get("detach") === true };
}

/** POST /containers/{id}/update: the desktop's memory, CPU share, pids cap and "no" restart, nothing else. */
export function checkUpdate(body) {
  if (!isObject(body)) refuse("the update must be an object");
  struct(body, "update", {
    Memory: integer(0), MemorySwap: integer(-1), CpuShares: integer(0), NanoCpus: integer(0), PidsLimit: integer(1), RestartPolicy: restartNo,
  });
}

/** POST /networks/create: only the desktops' bridge, exactly as server/bot-desktop.ts makes it. */
export function checkNetworkCreate(body) {
  if (!isObject(body)) refuse("the network config must be an object");
  const network = struct(body, "network", {
    Name: choice(DESKTOP_NETWORK), Driver: choice("bridge"), Scope: choice("", "local"), CheckDuplicate: bool, EnableIPv4: bool,
    EnableIPv6: notTrue, Internal: notTrue, Attachable: notTrue, Ingress: notTrue, ConfigOnly: notTrue, ConfigFrom: zero,
    IPAM: (value, where) => { struct(value, where, { Driver: choice("", "default"), Options: zero, Config: zero }); },
    Options: anything, Labels: anything,
  });
  if (network.get("name") !== DESKTOP_NETWORK || network.get("driver") !== "bridge") refuse(`only the ${DESKTOP_NETWORK} bridge may be created`);
  const options = network.get("options");
  if (!isObject(options) || Object.keys(options).length !== 2 || options["com.docker.network.bridge.enable_icc"] !== "false" ||
    options["com.docker.network.bridge.name"] !== DESKTOP_BRIDGE) {
    refuse(`the network options must be exactly enable_icc=false and bridge.name=${DESKTOP_BRIDGE}`);
  }
  const own = network.get("labels");
  if (!isObject(own) || Object.keys(own).length !== 1 || own[NETWORK_LABEL] !== "1") refuse(`the network must carry only label ${NETWORK_LABEL}=1`);
}

/** A distribution reference, normalised the way docker does: docker.io for bare names, library/ for official images. */
export function parseImageRef(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let rest = value, tag = null, digest = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!IMAGE_ID.test(digest)) return null;
  }
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }
  const parts = rest.split("/");
  let domain = "docker.io";
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === "localhost")) {
    domain = parts.shift();
    if (!DOMAIN.test(domain)) return null;
    if (domain === "index.docker.io") domain = "docker.io";
  }
  if (!parts.length || !parts.every((part) => COMPONENT.test(part))) return null;
  if (domain === "docker.io" && parts.length === 1) parts.unshift("library");
  return { repository: `${domain}/${parts.join("/")}`, tag, digest };
}

export function repositoryOf(value) {
  const ref = parseImageRef(value);
  if (!ref || ref.tag || ref.digest) throw new Error(`not an image repository: ${value}`);
  return ref.repository;
}

/** POST /images/create: a pull from an allowed repository; never an import (fromSrc). */
export function checkPull(query, allowed) {
  const ref = parseImageRef(query.get("fromImage"));
  if (!ref) refuse("fromImage is not an image reference");
  if (!allowed.has(ref.repository)) refuse(`pulling ${ref.repository} is not allowed`);
  const tag = query.get("tag");
  if (tag && !TAG.test(tag) && !IMAGE_ID.test(tag)) refuse("tag is not a tag or digest");
}

/** Refuses a container the gate would never have created, so a box made before the gate cannot be used to escape. */
function assertRunsSafely(detail) {
  const host = isObject(detail.HostConfig) ? detail.HostConfig : {};
  const shared = (mode) => mode === "host" || String(mode ?? "").startsWith("container:");
  const unsafe = host.Privileged === true || !isZero(host.Binds) || !isZero(host.VolumesFrom) || !isZero(host.Devices) ||
    !isZero(host.DeviceRequests) || !isZero(host.DeviceCgroupRules) || !isZero(host.Sysctls) ||
    [host.NetworkMode, host.PidMode, host.IpcMode, host.UTSMode, host.UsernsMode, host.CgroupnsMode].some(shared) ||
    !(host.CapDrop ?? []).some((cap) => String(cap).toUpperCase() === "ALL") ||
    (host.CapAdd ?? []).some((cap) => !DESKTOP_CAPS.has(capName(cap))) ||
    (host.SecurityOpt ?? []).some((option) => !NO_NEW_PRIVILEGES.includes(option)) ||
    (Array.isArray(host.MaskedPaths) && host.MaskedPaths.length === 0) ||
    (Array.isArray(host.ReadonlyPaths) && host.ReadonlyPaths.length === 0) ||
    (Array.isArray(detail.Mounts) && detail.Mounts.some((mount) => mount?.Type !== "volume" && mount?.Type !== "tmpfs"));
  if (unsafe) refuse("this computer was not made with the gate's safe flags; remove it and let Metal recreate it");
}

const CONTAINER_OPS = {
  "POST start": { query: ["detachKeys"], probe: true, safe: true },
  "POST stop": { query: ["t", "signal"] },
  "POST restart": { query: ["t", "signal"], safe: true },
  "POST kill": { query: ["signal"], probe: true },
  "POST wait": { query: ["condition"], probe: true },
  "POST resize": { query: ["h", "w"] },
  "POST attach": { query: ["stream", "stdin", "stdout", "stderr", "logs", "detachKeys"], probe: true, safe: true, hijack: true },
  "POST update": { query: [], body: "update", safe: true },
  "POST rename": { query: ["name"], rename: true },
  "POST exec": { query: [], body: "exec", safe: true },
  "GET json": { query: ["size"], probe: true },
  "GET logs": { query: ["follow", "stdout", "stderr", "since", "until", "timestamps", "tail", "details"] },
  "GET top": { query: [] },
  "GET stats": { query: ["stream", "one-shot"] },
  "DELETE ": { query: ["force", "v"], probe: true },
};

/** A bot computer is renamed only between its own name and its own set-aside name, never to anyone else's. */
export function checkRename(current, next) {
  const base = (name) => {
    const plain = typeof name === "string" ? name.replace(/^\//, "") : "";
    const stem = plain.endsWith(PREVIOUS_SUFFIX) ? plain.slice(0, -PREVIOUS_SUFFIX.length) : plain;
    return DESKTOP_NAME.test(stem) ? stem : null;
  };
  const from = base(current), to = base(next);
  if (!from || !to || from !== to || current.replace(/^\//, "") === next) refuse("a bot computer can only be set aside under its own name");
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return refuse("the query string is not valid");
  }
}

/** Splits a request target into API version prefix, unversioned path and query; anything ambiguous is refused. */
export function parseTarget(target) {
  const mark = target.indexOf("?");
  const raw = mark < 0 ? "" : target.slice(mark + 1);
  const full = mark < 0 ? target : target.slice(0, mark);
  if (full.length > 1024 || !/^\/[A-Za-z0-9/_.:@-]*$/.test(full) || full.includes("//") || /\/\.{1,2}(?:\/|$)/.test(full) ||
    (full.length > 1 && full.endsWith("/"))) {
    refuse("the request path is not allowed");
  }
  let prefix = "", path = full;
  const versioned = /^\/v(\d{1,3})\.(\d{1,3})(\/.+)$/.exec(full);
  if (versioned) {
    const [, major, minor, rest] = versioned;
    if (Number(major) !== 1 || Number(minor) < MIN_API_MINOR) refuse(`Docker API versions before 1.${MIN_API_MINOR} are not allowed`);
    prefix = `/v${major}.${minor}`;
    path = rest;
  } else if (/^\/v\d/.test(full)) {
    refuse("the API version is not valid");
  }
  const query = new Map();
  if (raw) {
    // Go's url.ParseQuery drops pairs holding ';' and keeps the first repeat: refuse both rather than disagree
    if (raw.length > 8192 || raw.includes(";") || /[^\x21-\x7e]/.test(raw)) refuse("the query string is not valid");
    for (const pair of raw.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const key = decodeComponent(eq < 0 ? pair : pair.slice(0, eq));
      if (query.has(key)) refuse("a query parameter is repeated");
      query.set(key, decodeComponent(eq < 0 ? "" : pair.slice(eq + 1)));
    }
  }
  return { prefix, path, query, raw };
}

/**
 * The gate's decision for one request. `ctx` supplies the upstream lookups and the probe and exec ids this gate made.
 * Resolves to { allow: true, target, json, hijack, capture } (target is what to send upstream) or
 * { allow: false, status, message }; rejects only when docker itself could not be asked.
 */
export async function decide(method, target, body, ctx) {
  try {
    return await route(method, target, body ?? Buffer.alloc(0), ctx);
  } catch (error) {
    if (error instanceof Refusal) return { allow: false, status: error.status, message: error.message };
    throw error;
  }
}

async function route(method, target, body, ctx) {
  const { prefix, path, query, raw } = parseTarget(target);
  const pass = (rewritten = path, extra = {}) => ({ allow: true, target: `${prefix}${rewritten}${raw ? `?${raw}` : ""}`, json: false, hijack: false, ...extra });
  const only = (...keys) => { for (const key of query.keys()) if (!keys.includes(key)) refuse(`query parameter ${key} is not allowed here`); };
  const noBody = () => { if (body.length) refuse("this request takes no body"); };
  const read = (...keys) => { only(...keys); noBody(); return pass(); };
  let match;

  if ((method === "GET" || method === "HEAD") && path === "/_ping") return read();
  if (method === "GET") {
    if (path === "/version" || path === "/info") return read();
    if (path === "/events") return read("since", "until", "filters");
    if (path === "/system/df") return read("type", "verbose");
    if (path === "/containers/json") return read("all", "limit", "size", "filters", "before", "since");
    if (path === "/images/json") return read("all", "filters", "shared-size", "digests", "manifests");
    if (path === "/networks") return read("filters");
    if ((match = /^\/images\/(.+)\/json$/.exec(path))) {
      imageName(match[1], "image");
      return read("manifests", "platform");
    }
    // `docker inspect <name>` tries each kind in turn and needs "not found" from all of them
    if ((match = /^\/(?:networks|volumes)\/([^/]+)$/.exec(path)) || (match = /^\/plugins\/([^/]+)\/json$/.exec(path))) {
      if (!REF.test(match[1])) refuse("invalid name");
      return read("verbose", "scope");
    }
  }
  if (method === "POST" && path === "/networks/create") {
    only();
    checkNetworkCreate(parseBody(body));
    return pass(path, { json: true });
  }
  if (method === "POST" && path === "/images/create") {
    only("fromImage", "tag", "platform");
    noBody();
    checkPull(query, ctx.pull);
    return pass();
  }
  if (method === "POST" && path === "/containers/create") {
    only("name", "platform");
    const config = parseBody(body);
    const result = checkCreate(config, { name: query.get("name"), runsc: await ctx.runsc() });
    if (result.kind === "desktop") return pass(path, { json: true });
    const image = await ctx.inspectImage(result.image);
    if (image.status !== 200 || image.json?.Id !== result.image || !image.json?.Config?.Labels?.[BOT_DESKTOP_LABEL]) {
      refuse("a host probe must run the bot desktop image");
    }
    return pass(path, { json: true, capture: (id) => ctx.probes.add(id, true) });
  }
  if ((match = /^\/containers\/([^/]+)(?:\/([a-z]+))?$/.exec(path))) {
    const [, ref, op = ""] = match;
    if (!REF.test(ref)) refuse("invalid container name");
    const rule = CONTAINER_OPS[`${method} ${op}`];
    if (!rule) refuse(`${method} ${op || "on a container"} is not allowed`);
    only(...rule.query);
    if (rule.body === "update") checkUpdate(parseBody(body));
    else if (rule.body === "exec") checkExec(parseBody(body));
    else noBody();
    if (rule.probe && FULL_ID.test(ref) && ctx.probes.get(ref)) return pass(path, { hijack: Boolean(rule.hijack) });
    const found = await ctx.inspectContainer(ref);
    if (found.status === 404) refuse(found.json?.message ?? `No such container: ${ref}`, 404);
    if (found.status !== 200 || !FULL_ID.test(found.json?.Id ?? "")) throw new Error("docker returned no container");
    const detail = found.json;
    if (detail.Config?.Labels?.[VPS_LABEL] !== "1") refuse("this container is not a bot computer");
    if (rule.safe) assertRunsSafely(detail);
    if (rule.rename) checkRename(detail.Name, query.get("name"));
    return pass(`/containers/${detail.Id}${op ? `/${op}` : ""}`, {
      json: Boolean(rule.body),
      hijack: Boolean(rule.hijack),
      ...(rule.body === "exec" ? { capture: (id) => ctx.execs.add(id, detail.Id) } : {}),
    });
  }
  if ((match = /^\/exec\/([^/]+)\/(start|resize|json)$/.exec(path))) {
    const [, id, op] = match;
    if (!FULL_ID.test(id) || !ctx.execs.get(id)) refuse("this exec was not created through the gate");
    if (method === "POST" && op === "start") {
      only();
      const { detach } = checkExecStart(parseBody(body));
      return pass(path, { json: true, hijack: !detach });
    }
    if (method === "POST" && op === "resize") return read("h", "w");
    if (method === "GET" && op === "json") return read();
  }
  return refuse(`${method} ${path} is not allowed`);
}

/** Ids this gate saw docker create, forgotten after `ttl`; the oldest go first when full. */
export class Tracker {
  constructor(ttl = TRACK_MS, max = TRACK_MAX, now = Date.now) {
    this.ttl = ttl;
    this.max = max;
    this.now = now;
    this.entries = new Map();
  }

  add(id, value) {
    this.prune();
    this.entries.delete(id);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(id, { value, expires: this.now() + this.ttl });
  }

  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.value;
  }

  prune() {
    for (const [id, entry] of this.entries) {
      if (entry.expires > this.now()) break;
      this.entries.delete(id);
    }
  }
}

function lookup(upstream, path) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: upstream, path, method: "GET", headers: { Host: "docker" }, agent: false, timeout: 30_000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_LOOKUP) req.destroy(new Error("docker answered too much"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("docker did not answer")));
    req.on("error", reject);
    req.end();
  });
}

export function gateContext({ upstream = DEFAULT_UPSTREAM, pull = DEFAULT_PULL, now = Date.now } = {}) {
  let info = null;
  return {
    pull: new Set(pull.map(repositoryOf)),
    probes: new Tracker(TRACK_MS, TRACK_MAX, now),
    execs: new Tracker(TRACK_MS, TRACK_MAX, now),
    inspectContainer: (ref) => lookup(upstream, `/containers/${ref}/json`),
    inspectImage: (ref) => lookup(upstream, `/images/${ref}/json`),
    async runsc() {
      if (info && now() - info.at < INFO_MS) return info.runsc;
      const answer = await lookup(upstream, "/info");
      if (answer.status !== 200 || !isObject(answer.json)) throw new Error("docker info failed");
      const runtimes = answer.json.Runtimes;
      info = { runsc: isObject(runtimes) && Object.hasOwn(runtimes, "runsc"), at: now() };
      return info.runsc;
    },
  };
}

const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");
const EMPTY = Buffer.alloc(0);
const CLOSED = new Error("connection closed");
/** docker closed or failed before the gate sent the client any of its answer */
class Unanswered extends Error {}
class ProtocolError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = EMPTY;
    this.ended = false;
    this.wake = null;
    this.onData = (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      if (this.buffer.length >= HIGH_WATER) socket.pause();
      this.notify();
    };
    this.onEnd = () => {
      this.ended = true;
      this.notify();
    };
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
  }

  notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async fill() {
    if (this.ended) throw CLOSED;
    this.socket.resume();
    await new Promise((resolve) => { this.wake = resolve; });
  }

  async until(separator, limit, status = 431) {
    for (let from = 0; ;) {
      const at = this.buffer.indexOf(separator, from);
      if (at >= 0) {
        const out = this.buffer.subarray(0, at);
        this.buffer = this.buffer.subarray(at + separator.length);
        return out;
      }
      if (this.buffer.length > limit) throw new ProtocolError(status, "the message head is too large");
      from = Math.max(0, this.buffer.length - separator.length + 1);
      await this.fill();
    }
  }

  async take(count) {
    while (this.buffer.length < count) await this.fill();
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  async some(max) {
    while (!this.buffer.length) await this.fill();
    return this.take(Math.min(max, this.buffer.length));
  }

  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    const rest = this.buffer;
    this.buffer = EMPTY;
    return rest;
  }
}

function send(socket, data) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed || socket.writableEnded) return reject(CLOSED);
    if (socket.write(data)) return resolve();
    const done = () => { cleanup(); resolve(); };
    const gone = () => { cleanup(); reject(CLOSED); };
    const cleanup = () => { socket.off("drain", done); socket.off("close", gone); };
    socket.once("drain", done);
    socket.once("close", gone);
  });
}

const REASONS = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 411: "Length Required", 413: "Payload Too Large", 431: "Request Header Fields Too Large", 502: "Bad Gateway" };

async function reply(socket, status, message, { close = false, head = false } = {}) {
  const body = Buffer.from(JSON.stringify({ message }));
  const lines = `HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n${close ? "Connection: close\r\n" : ""}\r\n`;
  await send(socket, head ? Buffer.from(lines) : Buffer.concat([Buffer.from(lines), body]));
  if (close) socket.end();
}

function parseRequest(head) {
  const lines = head.toString("latin1").split("\r\n");
  const parts = lines[0].split(" ");
  const [method, target, version] = parts;
  if (parts.length !== 3 || !/^[A-Z]{3,7}$/.test(method) || version !== "HTTP/1.1" || !target.startsWith("/")) {
    throw new ProtocolError(400, "malformed request line");
  }
  const req = { method, target, headers: [], length: 0, chunked: false, close: false, upgrade: false, expect: false };
  let sized = false;
  for (const line of lines.slice(1)) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\t\x20-\x7e]*?)[ \t]*$/.exec(line);
    if (!match) throw new ProtocolError(400, "malformed header");
    const name = match[1].toLowerCase(), value = match[2];
    req.headers.push({ name, line });
    if (name === "content-length") {
      if (sized || !/^\d{1,10}$/.test(value)) throw new ProtocolError(400, "bad Content-Length");
      sized = true;
      req.length = Number(value);
    } else if (name === "transfer-encoding") {
      if (req.chunked || value.toLowerCase() !== "chunked") throw new ProtocolError(400, "unsupported Transfer-Encoding");
      req.chunked = true;
    } else if (name === "connection") {
      req.close ||= value.toLowerCase().split(",").some((option) => option.trim() === "close");
    } else if (name === "upgrade") {
      req.upgrade = value.toLowerCase() === "tcp";
    } else if (name === "expect") {
      req.expect = value.toLowerCase() === "100-continue";
    }
  }
  if (req.chunked && sized) throw new ProtocolError(400, "both Content-Length and Transfer-Encoding");
  if (req.chunked && req.upgrade) throw new ProtocolError(400, "a chunked upgrade request");
  return req;
}

async function readBody(reader, req, client) {
  if (!req.chunked && req.length > MAX_BODY) throw new ProtocolError(413, "the request body is larger than 1 MB");
  if (req.expect && (req.chunked || req.length > 0)) await send(client, Buffer.from("HTTP/1.1 100 Continue\r\n\r\n"));
  if (!req.chunked) return req.length ? Buffer.from(await reader.take(req.length)) : EMPTY;
  const parts = [];
  let total = 0;
  for (;;) {
    const line = (await reader.until(CRLF, 1024, 400)).toString("latin1");
    const match = /^([0-9a-fA-F]{1,8})(?:[ \t]*;[\x20-\x7e]*)?$/.exec(line);
    if (!match) throw new ProtocolError(400, "malformed chunk");
    const size = parseInt(match[1], 16);
    if (size === 0) break;
    total += size;
    if (total > MAX_BODY) throw new ProtocolError(413, "the request body is larger than 1 MB");
    parts.push(Buffer.from(await reader.take(size)));
    if (!(await reader.take(2)).equals(CRLF)) throw new ProtocolError(400, "malformed chunk");
  }
  for (let trailers = 0; ; trailers++) {
    if (trailers > 32) throw new ProtocolError(400, "too many trailers");
    if (!(await reader.until(CRLF, 8192, 400)).length) break;
  }
  return Buffer.concat(parts);
}

/** The request as docker sees it: the client's own header lines, but only those docker needs, and a body length the gate measured. */
function forwardedHead(req, verdict, body) {
  const lines = [`${req.method} ${verdict.target} HTTP/1.1`];
  let host = false, sized = false, typed = false;
  const hijack = verdict.hijack && req.upgrade;
  for (const { name, line } of req.headers) {
    if (name === "host" || name === "user-agent" || name === "accept" || name === "x-registry-auth" || name === "traceparent" || name === "tracestate") {
      host ||= name === "host";
      lines.push(line);
    } else if (name === "content-length" || name === "transfer-encoding") {
      if (!sized) lines.push(`Content-Length: ${body.length}`);
      sized = true;
    } else if (name === "content-type" && verdict.json && body.length) {
      if (!typed) lines.push(/^content-type: application\/json$/i.test(line) ? line : "Content-Type: application/json");
      typed = true;
    } else if (name === "connection" && hijack) {
      lines.push("Connection: Upgrade");
    } else if (name === "upgrade" && hijack) {
      lines.push("Upgrade: tcp");
    }
  }
  if (!host) lines.splice(1, 0, "Host: docker");
  if (!sized && body.length) lines.push(`Content-Length: ${body.length}`);
  if (!typed && verdict.json && body.length) lines.push("Content-Type: application/json");
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

function parseResponse(head) {
  const lines = head.toString("latin1").split("\r\n");
  const match = /^HTTP\/1\.([01]) (\d{3})(?: |$)/.exec(lines[0]);
  if (!match) throw new Error("docker sent a malformed response");
  const res = { status: Number(match[2]), length: null, chunked: false, close: match[1] === "0" };
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("docker sent a malformed header");
    const name = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    if (name === "content-length") {
      if (!/^\d{1,15}$/.test(value)) throw new Error("docker sent a bad Content-Length");
      res.length = Number(value);
    } else if (name === "transfer-encoding") {
      res.chunked = /(?:^|,)\s*chunked$/i.test(value);
    } else if (name === "connection") {
      res.close ||= /(?:^|,)\s*close\s*(?:,|$)/i.test(value);
    }
  }
  return res;
}

async function relayBody(upstream, res, framing, sink, data) {
  if (framing === "none") return;
  if (framing === "length") {
    for (let left = res.length; left > 0;) {
      const chunk = await upstream.some(left);
      left -= chunk.length;
      data(chunk);
      await sink(chunk);
    }
    return;
  }
  if (framing === "chunked") {
    for (;;) {
      const line = await upstream.until(CRLF, 4096);
      await sink(Buffer.concat([line, CRLF]));
      const match = /^([0-9a-fA-F]{1,8})(?:[ \t]*;.*)?$/.exec(line.toString("latin1"));
      if (!match) throw new Error("docker sent a malformed chunk");
      const size = parseInt(match[1], 16);
      if (size === 0) {
        for (;;) {
          const trailer = await upstream.until(CRLF, 8192);
          await sink(Buffer.concat([trailer, CRLF]));
          if (!trailer.length) return;
        }
      }
      for (let left = size; left > 0;) {
        const chunk = await upstream.some(left);
        left -= chunk.length;
        data(chunk);
        await sink(chunk);
      }
      const end = await upstream.take(2);
      if (!end.equals(CRLF)) throw new Error("docker sent a malformed chunk");
      await sink(end);
    }
  }
  for (;;) {
    let chunk;
    try {
      chunk = await upstream.some(Infinity);
    } catch (error) {
      if (error === CLOSED) return;
      throw error;
    }
    data(chunk);
    await sink(chunk);
  }
}

/** Docker owns both ends now: bytes flow raw each way, and an end (`docker exec -i` closing stdin) passes on alone. */
function splice(client, clientReader, upstream, upstreamReader) {
  const fromClient = clientReader.detach(), fromUpstream = upstreamReader.detach();
  const clientEnded = clientReader.ended, upstreamEnded = upstreamReader.ended;
  if (fromUpstream.length) client.write(fromUpstream);
  if (fromClient.length) upstream.write(fromClient);
  const finish = () => {
    client.end();
    setTimeout(() => client.destroy(), 30_000).unref();
  };
  client.on("close", () => upstream.destroy());
  if (upstream.destroyed) finish();
  else upstream.on("close", finish);
  if (clientEnded) upstream.end();
  else client.pipe(upstream);
  if (upstreamEnded) client.end();
  else upstream.pipe(client);
}

function dial(path) {
  return new Promise((resolve, reject) => {
    const socket = connect({ path, allowHalfOpen: true });
    socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
    socket.once("error", reject);
  });
}

/** Sends one allowed request upstream and relays the answer: "keep" the client connection, "close" it, or "hijacked". */
async function forward(client, clientReader, req, body, verdict, gate) {
  let upstream;
  try {
    upstream = await dial(gate.upstream);
  } catch {
    await reply(client, 502, "docker gate: docker is not reachable", { close: req.close, head: req.method === "HEAD" });
    return req.close ? "close" : "keep";
  }
  upstream.on("error", () => upstream.destroy());
  const reader = new Reader(upstream);
  const drop = () => upstream.destroy();
  client.once("close", drop);
  let hijacked = false, started = false;
  const relay = (data) => { started = true; return send(client, data); };
  try {
    upstream.write(forwardedHead(req, verdict, body));
    if (body.length) upstream.write(body);
    for (;;) {
      const head = await reader.until(HEAD_END, MAX_HEAD);
      const raw = Buffer.concat([head, HEAD_END]);
      const res = parseResponse(head);
      const framed = res.chunked || res.length !== null;
      if (res.status === 101 || (verdict.hijack && res.status === 200 && !framed)) {
        if (!verdict.hijack) throw new Error("docker switched protocols unasked");
        await relay(raw);
        client.off("close", drop);
        hijacked = true;
        splice(client, clientReader, upstream, reader);
        return "hijacked";
      }
      if (res.status < 200) {
        await relay(raw);
        continue;
      }
      const framing = req.method === "HEAD" || res.status === 204 || res.status === 304 ? "none"
        : res.chunked ? "chunked" : res.length !== null ? "length" : "close";
      if (verdict.capture && res.status === 201) {
        const out = [raw], decoded = [];
        let size = 0;
        await relayBody(reader, res, framing, async (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) throw new Error("docker answered too much");
          out.push(chunk);
        }, (chunk) => decoded.push(chunk));
        try {
          const id = JSON.parse(Buffer.concat(decoded).toString("utf8"))?.Id;
          if (typeof id === "string" && FULL_ID.test(id)) verdict.capture(id);
        } catch {}
        await relay(Buffer.concat(out));
      } else {
        await relay(raw);
        await relayBody(reader, res, framing, (chunk) => send(client, chunk), () => {});
      }
      return res.close || framing === "close" ? "close" : "keep";
    }
  } catch (error) {
    if (!started && !client.destroyed) throw new Unanswered(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (!hijacked) {
      client.off("close", drop);
      upstream.destroy();
    }
  }
}

const printable = (value) => value.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);

async function serve(client, gate) {
  client.on("error", () => client.destroy());
  client.on("timeout", () => client.destroy());
  const reader = new Reader(client);
  for (;;) {
    let req;
    try {
      client.setTimeout(gate.idleMs);
      req = parseRequest(await reader.until(HEAD_END, MAX_HEAD));
      client.setTimeout(0);
    } catch (error) {
      if (error === CLOSED) {
        if (!reader.buffer.length) client.end();
        else client.destroy();
        return;
      }
      if (error instanceof ProtocolError) return reply(client, error.status, `docker gate: ${error.message}`, { close: true });
      throw error;
    }
    let body;
    try {
      body = await readBody(reader, req, client);
    } catch (error) {
      if (error instanceof ProtocolError) return reply(client, error.status, `docker gate: ${error.message}`, { close: true });
      throw error;
    }
    const path = req.target.split("?")[0];
    let verdict;
    try {
      verdict = await decide(req.method, req.target, body, gate.ctx);
    } catch {
      gate.log(`docker gate: ${req.method} ${printable(path)}: docker could not be asked`);
      await reply(client, 502, "docker gate: docker could not be asked about this request", { close: req.close, head: req.method === "HEAD" });
      if (req.close) return;
      continue;
    }
    if (!verdict.allow) {
      if (verdict.status === 403) gate.log(`docker gate: refused ${req.method} ${printable(path)}: ${printable(verdict.message)}`);
      const message = verdict.status === 403 ? `docker gate: ${verdict.message}` : verdict.message;
      await reply(client, verdict.status, message, { close: req.close, head: req.method === "HEAD" });
      if (req.close) return;
      continue;
    }
    let outcome;
    try {
      outcome = await forward(client, reader, req, body, verdict, gate);
    } catch (error) {
      if (!(error instanceof Unanswered)) throw error;
      // a Go docker client reads a connection closed without an answer as a bare "EOF"
      gate.log(`docker gate: ${req.method} ${printable(path)}: docker closed the connection before answering (${printable(error.message)})`);
      return reply(client, 502, "docker gate: docker closed the connection before answering; try again", { close: true, head: req.method === "HEAD" });
    }
    if (outcome === "hijacked") return;
    if (outcome === "close" || req.close) {
      client.end();
      return;
    }
  }
}

function removeStaleSocket(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket()) throw new Error(`${path} exists and is not a socket`);
  unlinkSync(path);
}

/** Listens on `listen` (mode 0660) and forwards what the policy allows to the docker socket at `upstream`. */
export async function startGate({ listen = DEFAULT_LISTEN, upstream = DEFAULT_UPSTREAM, pull = DEFAULT_PULL, log = (line) => process.stderr.write(`${line}\n`), now, idleMs = IDLE_MS } = {}) {
  const gate = { upstream, log, idleMs, ctx: gateContext({ upstream, pull, now }) };
  removeStaleSocket(listen);
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    serve(socket, gate).catch(() => socket.destroy());
  });
  server.maxConnections = 1024;
  let dropped = 0;
  server.on("drop", () => { if (dropped++ % 100 === 0) log(`docker gate: ${server.maxConnections} connections are open; new ones are refused (${dropped} so far)`); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(listen, 0o660);
  return {
    ctx: gate.ctx,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    }),
  };
}

/** Whether the gate at `listen` answers an HTTP request at all (docker behind it may be down: a 502 still counts). */
export function pingGate(listen, timeoutMs = SELF_CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ path: listen });
    let seen = "";
    const done = (ok) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on("connect", () => socket.write("HEAD /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n"));
    socket.on("data", (chunk) => { seen += chunk.toString("latin1"); if (/^HTTP\/1\.[01] \d{3} /.test(seen)) done(true); });
    socket.on("error", () => done(false));
    socket.on("close", () => done(/^HTTP\/1\.[01] \d{3} /.test(seen)));
  });
}

/** Counts the gate's own pings: `true` from `record` once `limit` in a row went unanswered, so systemd starts it again. */
export class SelfCheck {
  constructor(limit = SELF_CHECK_FAILURES) {
    this.limit = limit;
    this.failures = 0;
  }

  record(answered) {
    this.failures = answered ? 0 : this.failures + 1;
    return this.failures >= this.limit;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const { values } = parseArgs({ options: { listen: { type: "string", default: DEFAULT_LISTEN }, upstream: { type: "string", default: DEFAULT_UPSTREAM } } });
    const configured = process.env.DUSK_GATE_PULL?.split(",").map((entry) => entry.trim()).filter(Boolean);
    const gate = await startGate({ listen: values.listen, upstream: values.upstream, pull: configured?.length ? configured : DEFAULT_PULL });
    process.stderr.write(`docker gate: listening on ${values.listen}, forwarding to ${values.upstream}\n`);
    const check = new SelfCheck();
    setInterval(async () => {
      if (!check.record(await pingGate(values.listen))) return;
      process.stderr.write(`docker gate: ${check.limit} checks of its own socket went unanswered; exiting so systemd starts it again\n`);
      process.exit(1);
    }, SELF_CHECK_MS).unref();
    const stop = () => gate.close().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (error) {
    process.stderr.write(`docker gate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
