import { DOCKER_NAMES, LEGACY, isOwnAppId } from "../electron/legacy-names.mjs";
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { freemem, loadavg, totalmem, uptime } from "node:os";
import { stripVTControlCharacters } from "node:util";

import { redactSecretsInText } from "../shared/redact.ts";

const SERVICES = {
  server: "duskbot.service",
  link: "duskbot-link.service",
  fence: "omb-box-fence.service",
} as const;

type ServiceName = keyof typeof SERVICES;
export interface VpsOpsOptions {
  action: "status" | "doctor" | "logs";
  port: number;
  dataDir: string;
  service: ServiceName;
  lines: number;
  json: boolean;
  help?: boolean;
}

export const VPS_OPS_USAGE = `metal vps status|doctor [--port N] [--data-dir DIR] [--json]
metal vps logs [--service server|link|fence] [--lines 100] [--json]

Read-only operations on this Linux VPS, including when the server is stopped.
status  check local HTTP health, systemd services, managed computers and host resources
doctor  the same checks with suggested next steps
logs    print a bounded, redacted journal tail (1 to 500 lines; no follow)

No service is started or restarted. No configuration, database or credentials
are read. Docker checks use only a local socket (DOCKER_HOST's, else /var/run/docker.sock). Journal access
depends on this account's existing permissions. HTTP and subprocess checks
have a 4-second limit.`;

export function parseVpsOpsArgs(
  argv: string[],
  defaults: Pick<VpsOpsOptions, "port" | "dataDir">,
): VpsOpsOptions | { error: string } {
  const options: VpsOpsOptions = { action: "status", ...defaults, service: "server", lines: 100, json: false };
  let action = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const result = argv[++i];
      if (!result || result.startsWith("--")) throw new Error(`${arg} needs a value`);
      return result;
    };
    try {
      if (!action && ["status", "doctor", "logs"].includes(arg)) {
        options.action = arg as VpsOpsOptions["action"];
        action = true;
      } else if (arg === "--help" || arg === "-h") options.help = true;
      else if (arg === "--json") options.json = true;
      else if (arg === "--port") {
        const port = value();
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("--port must be 1-65535");
        options.port = Number(port);
      } else if (arg === "--data-dir") options.dataDir = value();
      else if (arg === "--service") {
        const service = value();
        if (!Object.hasOwn(SERVICES, service)) throw new Error("--service must be server, link or fence");
        options.service = service as ServiceName;
      } else if (arg === "--lines") {
        const lines = value();
        if (!/^\d+$/.test(lines) || Number(lines) < 1 || Number(lines) > 500) throw new Error("--lines must be 1-500");
        options.lines = Number(lines);
      } else return { error: `unknown argument "${arg}"; see metal vps --help` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "invalid arguments" };
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) return { error: "--port must be 1-65535" };
  if (options.action !== "logs" && (options.service !== "server" || options.lines !== 100)) return { error: "--service and --lines apply only to vps logs" };
  return options;
}

export interface OpsCommandResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
  error?: string;
}

export function runOpsCommand(command: string, args: string[], timeoutMs = 4000): Promise<OpsCommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        resolve({ ok: false, stdout: "", error: code === "ENOENT" ? "command not installed" : error.killed ? "check timed out" : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output limit reached; request fewer lines" : "command failed or access denied" });
      } else resolve({ ok: true, stdout, stderr });
    });
  });
}

interface ServiceStatus {
  unit: string;
  state: "active" | "inactive" | "failed" | "activating" | "deactivating" | "not-installed" | "unknown";
  pid?: number;
  restarts?: number;
  error?: string;
}

interface ComputerSummary {
  available: boolean;
  count?: number;
  running?: number;
  states?: Record<string, number>;
  error?: string;
}

export interface VpsOpsReport {
  healthy: boolean;
  http: { url: string; ready: boolean; error?: string };
  services: Record<ServiceName, ServiceStatus>;
  computers: ComputerSummary;
  host: { uptimeSeconds: number; loadAverage: number[]; memoryBytes: { free: number; total: number }; diskBytes?: { free: number; total: number } };
  hints: string[];
}

export interface VpsOpsDependencies {
  platform?: NodeJS.Platform;
  command?: typeof runOpsCommand;
  fetch?: typeof fetch;
  host?: (dataDir: string) => Promise<VpsOpsReport["host"]>;
}

async function hostResources(dataDir: string): Promise<VpsOpsReport["host"]> {
  const host: VpsOpsReport["host"] = {
    uptimeSeconds: Math.floor(uptime()), loadAverage: loadavg(), memoryBytes: { free: freemem(), total: totalmem() },
  };
  try {
    const disk = await statfs(dataDir);
    host.diskBytes = { free: disk.bavail * disk.bsize, total: disk.blocks * disk.bsize };
  } catch {}
  return host;
}

async function serviceStatus(service: ServiceName, command: typeof runOpsCommand): Promise<ServiceStatus> {
  const status = await unitStatus(SERVICES[service], command);
  // an install from before the rename runs these under their old names until its installer runs again
  const old = (LEGACY.vpsUnits as Record<string, string>)[service];
  return status.state === "not-installed" && old ? unitStatus(old, command) : status;
}

async function unitStatus(unit: string, command: typeof runOpsCommand): Promise<ServiceStatus> {
  const result = await command("systemctl", ["show", unit, "--no-pager", "--property=LoadState,ActiveState,MainPID,NRestarts"]);
  if (!result.ok) return { unit, state: "unknown", error: result.error };
  const properties = Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=", 2)));
  if (properties.LoadState === "not-found") return { unit, state: "not-installed" };
  const active = properties.ActiveState;
  const state = ["active", "inactive", "failed", "activating", "deactivating"].includes(active ?? "") ? active as ServiceStatus["state"] : "unknown";
  return {
    unit, state,
    ...(/^\d+$/.test(properties.MainPID ?? "") ? { pid: Number(properties.MainPID) } : {}),
    ...(/^\d+$/.test(properties.NRestarts ?? "") ? { restarts: Number(properties.NRestarts) } : {}),
  };
}

/** A local unix socket only: on a VPS install the server reaches Docker through its gate (DOCKER_HOST). */
export function localDockerHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.DOCKER_HOST ?? "";
  return /^unix:\/\/\/[\w./-]+$/.test(host) ? host : "unix:///var/run/docker.sock";
}

async function computerSummary(command: typeof runOpsCommand): Promise<ComputerSummary> {
  const result = await command("docker", ["--host", localDockerHost(), "ps", "--all", "--filter", `label=${DOCKER_NAMES.label("vps")}=1`, "--format", "{{.State}}"]);
  if (!result.ok) return { available: false, error: result.error };
  const states: Record<string, number> = {};
  const known = new Set(["created", "restarting", "running", "removing", "paused", "exited", "dead"]);
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const state = known.has(line.trim()) ? line.trim() : "unknown";
    states[state] = (states[state] ?? 0) + 1;
  }
  return { available: true, count: Object.values(states).reduce((a, b) => a + b, 0), running: states.running ?? 0, states };
}

async function httpHealth(port: number, request: typeof fetch): Promise<VpsOpsReport["http"]> {
  const url = `http://127.0.0.1:${port}/api/health`;
  try {
    const response = await request(url, { signal: AbortSignal.timeout(4000), redirect: "error" });
    if (!response.ok) return { url, ready: false, error: `HTTP ${response.status}` };
    const reader = response.body?.getReader();
    if (!reader) return { url, ready: false, error: "empty health response" };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return { url, ready: false, error: "health response exceeded 4 KiB" };
      }
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body !== null && typeof body === "object" && isOwnAppId(Reflect.get(body, "app"))
      ? { url, ready: true }
      : { url, ready: false, error: "a different service answered" };
  } catch { return { url, ready: false, error: "server unavailable or health check timed out" }; }
}

export async function collectVpsOpsStatus(options: VpsOpsOptions, dependencies: VpsOpsDependencies = {}): Promise<VpsOpsReport> {
  const command = dependencies.command ?? runOpsCommand;
  const [http, server, link, fence, computers, host] = await Promise.all([
    httpHealth(options.port, dependencies.fetch ?? fetch),
    serviceStatus("server", command), serviceStatus("link", command), serviceStatus("fence", command),
    computerSummary(command), (dependencies.host ?? hostResources)(options.dataDir),
  ]);
  const healthy = http.ready && server.state === "active" && computers.available && ["active", "not-installed"].includes(link.state) && ["active", "not-installed"].includes(fence.state);
  const hints: string[] = [];
  if (!http.ready) hints.push("The local server is not answering. Inspect: metal vps logs --service server");
  if (server.state !== "active") hints.push("The server service is not active or cannot be inspected. Check your installed service and this account's permissions.");
  if (!["active", "not-installed"].includes(link.state)) hints.push("The outbound link is not active or cannot be inspected. Inspect: metal vps logs --service link");
  if (!["active", "not-installed"].includes(fence.state)) hints.push("The computer network fence is not active or cannot be inspected. Inspect: metal vps logs --service fence");
  if (!computers.available) hints.push("Local Docker could not be inspected. Check that Docker is installed and this account may reach its socket (on a VPS install, the duskbot docker gate).");
  if (host.diskBytes && host.diskBytes.free < 1024 ** 3) hints.push("Less than 1 GiB is available on the data filesystem.");
  return { healthy, http, services: { server, link, fence }, computers, host, hints };
}

export function redactOpsLogs(text: string, lines: number): string {
  const plain = [...stripVTControlCharacters(text)].filter((character) => character === "\n" || character === "\t" || character.charCodeAt(0) >= 32 && character !== "\x7f").join("");
  const safe = redactSecretsInText(plain
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key redacted]")
    .replace(/^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key fragment redacted]")
    .replace(/^[A-Za-z0-9+/]{40,}={0,2}$/gm, "[encoded data redacted]")
    .replace(/^.*\b(?:authorization|proxy-authorization|(?:set-)?cookies?)["']?\s*[:=].*$/gim, "[sensitive header redacted]")
    .replace(/(\bBearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/(["']?\b(?:[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|authorization|cookie|private[_-]?key)|key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}]+)/gi, "$1[redacted]")
    .replace(/\b[A-Z][A-Z0-9_]{2,}=(?:"[^"\n]*"|'[^'\n]*'|[^\s]*)/g, (assignment) => `${assignment.slice(0, assignment.indexOf("="))}=[redacted]`)
    .replace(/([?&#](?:code|token|secret|key|password)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^\s/]+\/i\/)[^\s/?#]+/gi, "$1[redacted]"));
  return safe.trimEnd().split("\n").slice(-lines).join("\n");
}

export async function runVpsOps(
  options: VpsOpsOptions,
  io: { log(line: string): void; error(line: string): void },
  dependencies: VpsOpsDependencies = {},
): Promise<number> {
  if (options.help) { io.log(VPS_OPS_USAGE); return 0; }
  if ((dependencies.platform ?? process.platform) !== "linux") {
    io.error("vps operations run on the Linux VPS; use metal doctor for a remote workspace");
    return 1;
  }
  if (options.action === "logs") {
    const unit = SERVICES[options.service];
    const result = await (dependencies.command ?? runOpsCommand)("journalctl", ["--unit", unit, "--lines", String(options.lines), "--no-pager", "--output=cat", "--quiet"]);
    const limited = /permission|not seeing messages|access denied/i.test(result.stderr ?? "");
    if (!result.ok || limited) {
      const error = limited ? "journal access is limited for this account" : result.error ?? "journal unavailable";
      if (options.json) io.log(JSON.stringify({ unit, error }));
      else io.error(`${unit}: ${error}`);
      return 1;
    }
    const text = redactOpsLogs(result.stdout, options.lines);
    io.log(options.json ? JSON.stringify({ unit, text }) : text || `${unit}: no journal entries visible to this account`);
    return 0;
  }
  const report = await collectVpsOpsStatus(options, dependencies);
  if (options.json) io.log(JSON.stringify(report, null, 2));
  else {
    io.log(`VPS ${report.healthy ? "ready" : "needs attention"}`);
    io.log(`server HTTP: ${report.http.ready ? "ready" : report.http.error}`);
    for (const [name, service] of Object.entries(report.services)) io.log(`${name}: ${service.state}${service.error ? ` (${service.error})` : ""}${service.restarts !== undefined ? `; ${service.restarts} restarts` : ""}`);
    io.log(`computers: ${report.computers.available ? `${report.computers.running} running / ${report.computers.count} total` : report.computers.error}`);
    const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    io.log(`memory: ${gib(report.host.memoryBytes.free)} / ${gib(report.host.memoryBytes.total)} GiB free; load ${report.host.loadAverage.map((value) => value.toFixed(2)).join(" ")}; uptime ${Math.floor(report.host.uptimeSeconds / 60)} min`);
    if (report.host.diskBytes) io.log(`data disk: ${gib(report.host.diskBytes.free)} / ${gib(report.host.diskBytes.total)} GiB available`);
    if (options.action === "doctor") for (const hint of report.hints) io.log(hint);
  }
  return report.healthy ? 0 : 1;
}
