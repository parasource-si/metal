// Ported from T3 Code's apps/server/src/preview/PreviewBrowserHost.ts,
// Copyright 2026 T3 Tools Inc., used under the MIT License
// (third_party/t3-code/LICENSE). Modified: plain TypeScript instead of Effect,
// Metal's command and environment names, and an AppArmor profile pinned to one
// exact executable instead of a wildcard path.
//
// Metal never turns Chrome's sandbox off by itself on a host. A host that cannot
// give it one gets the setup command instead, and only an operator's explicit
// DUSK_BROWSER_SANDBOX=0 launches without it. The computer container image (also
// run on a VPS) is the exception: it drops capabilities, so its Chrome runs
// without its own sandbox and the container is the isolation boundary.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const SETUP_COMMAND = "sudo metal browser setup";

/** What Chrome prints before aborting when it cannot sandbox itself. */
export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

export function sandboxDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.DUSK_BROWSER_SANDBOX === "0";
}

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
export const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const APPARMOR_PROFILE_NAME = "duskbot-chrome";
export const APPARMOR_PROFILE_PATH = `/etc/apparmor.d/${APPARMOR_PROFILE_NAME}`;

/**
 * Lets exactly one root-owned Chrome create the user namespace its sandbox runs
 * in, modelled on the profile Ubuntu ships for Google Chrome. A path a user can
 * write, or a pattern, would let any program claim the exemption.
 */
export function appArmorProfile(executable: string): string {
  if (!isAbsolute(executable) || /[\s\p{Cc}*?[\]{}"'\\^]/u.test(executable.replaceAll(" ", "")) || !executable.startsWith("/opt/")) {
    throw new Error(`The browser's AppArmor exemption is only for a root-owned path under /opt, not ${executable}.`);
  }
  return `# Written by \`metal browser setup\`: lets Metal's Chrome use its sandbox.
abi <abi/4.0>,
include <tunables/global>

profile ${APPARMOR_PROFILE_NAME} "${executable}" flags=(unconfined) {
  userns,

  include if exists <local/${APPARMOR_PROFILE_NAME}>
}
`;
}

export class BrowserHostError extends Error {
  readonly kind: "sandbox" | "libraries";
  readonly libraries: readonly string[];

  constructor(kind: "sandbox" | "libraries", libraries: readonly string[] = []) {
    super(kind === "sandbox"
      ? `This host blocks the sandbox the browser runs in (AppArmor on Ubuntu 23.10+). Run \`${SETUP_COMMAND}\` on the host once to allow it, then try again.`
      : `This host is missing libraries the browser needs (${libraries.join(", ")}). Run \`${SETUP_COMMAND}\` on the host to install them, then try again.`);
    this.name = "BrowserHostError";
    this.kind = kind;
    this.libraries = libraries;
  }
}

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
/** glibc's loader abort, naming the first library it could not load. */
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 5_000, encoding: "utf8", windowsHide: true, env }, (_error, stdout, stderr) => resolve(`${stdout ?? ""}${stderr ?? ""}`));
  });
}

/**
 * Shared libraries the loader cannot find, with the environment the browser
 * was launched in. The browser's own `--version` decides whether any are
 * missing; `ldd` only lists them after the loader fails, because it can report
 * libraries a host provides another way (NixOS's nix-ld).
 */
export async function missingLibraries(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const loaderError = LOADER_ERROR.exec(await run(executable, ["--version"], env))?.[1];
  if (loaderError === undefined) return [];
  const listed = [...(await run("ldd", [executable], env)).matchAll(MISSING_LIBRARY)].map((match) => match[1]!);
  return listed.length > 0 ? listed : [loaderError];
}

/** After a launch fails, the host setup it is missing, or null when neither explains it. */
export async function diagnoseLaunchFailure(input: { executable: string; output: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): Promise<BrowserHostError | null> {
  if (input.output.includes(NO_SANDBOX_SIGNATURE)) return new BrowserHostError("sandbox");
  if ((input.platform ?? process.platform) !== "linux") return null;
  const libraries = await missingLibraries(input.executable, input.env);
  return libraries.length ? new BrowserHostError("libraries", libraries) : null;
}

/** Whether the sandbox will be blocked here: user namespaces are restricted and the profile is not installed. Readable without root. */
export function sandboxBlocked({ platform = process.platform, read = (path: string) => readFileSync(path, "utf8"), exists = existsSync }: {
  platform?: NodeJS.Platform;
  read?: (path: string) => string;
  exists?: (path: string) => boolean;
} = {}): boolean {
  if (platform !== "linux") return false;
  let restricted = false;
  try { restricted = read(USERNS_RESTRICTION).trim() === "1"; } catch {}
  return restricted && !exists(APPARMOR_PROFILE_PATH);
}

/** Where `browser setup` looks for a Chrome the AppArmor exemption can name: Google's own package, root-owned under /opt. */
export const SYSTEM_CHROME = "/opt/google/chrome/chrome";

export interface HostSetupDeps {
  platform: NodeJS.Platform;
  isRoot(): boolean;
  /** What `browser install --with-deps` does: Chrome's system libraries; the exit code. */
  installLibraries(): Promise<number>;
  sandboxBlocked(): boolean;
  exists(path: string): boolean;
  writeProfile(path: string, text: string): void;
  /** Loads the profile into the kernel (`apparmor_parser -r`). */
  loadProfile(path: string): Promise<void>;
  log(line: string): void;
  error(line: string): void;
}

/** `sudo metal browser setup`: what the host needs for the browser, the command the browser's own errors name. */
export async function setUpBrowserHost(deps: HostSetupDeps): Promise<number> {
  if (deps.platform !== "linux") {
    deps.log("nothing to set up on this host; run `metal browser install` to get the browser");
    return 0;
  }
  if (!deps.isRoot()) {
    deps.error(`this installs system libraries and an AppArmor profile, so it needs root: run \`${SETUP_COMMAND}\``);
    return 1;
  }
  const installed = await deps.installLibraries();
  if (installed !== 0) return installed;
  if (!deps.sandboxBlocked()) {
    deps.log("the browser's sandbox is allowed on this host");
    return 0;
  }
  if (!deps.exists(SYSTEM_CHROME)) {
    deps.error(`this host (Ubuntu 23.10+) only lets a browser sandbox itself with an AppArmor profile, and that profile can only name Google Chrome at ${SYSTEM_CHROME}. Install Google Chrome's .deb, then run \`${SETUP_COMMAND}\` again.`);
    return 1;
  }
  try {
    deps.writeProfile(APPARMOR_PROFILE_PATH, appArmorProfile(SYSTEM_CHROME));
    await deps.loadProfile(APPARMOR_PROFILE_PATH);
  } catch (error) {
    deps.error(`could not allow the browser's sandbox: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  deps.log(`wrote ${APPARMOR_PROFILE_PATH}; the browser's sandbox is allowed for ${SYSTEM_CHROME}`);
  return 0;
}

/** `metal browser setup` on this machine: its real root check, files and apparmor_parser. */
export function setUpThisHost(installLibraries: () => Promise<number>, io: Pick<HostSetupDeps, "log" | "error">): Promise<number> {
  return setUpBrowserHost({
    platform: process.platform,
    isRoot: () => process.getuid?.() === 0,
    installLibraries,
    sandboxBlocked: () => sandboxBlocked(),
    exists: existsSync,
    writeProfile: (path, text) => writeFileSync(path, text, { mode: 0o644 }),
    loadProfile: (path) => new Promise((done, fail) => {
      execFile("apparmor_parser", ["-r", path], { timeout: 30_000 }, (error, _stdout, stderr) => error ? fail(new Error(`apparmor_parser: ${String(stderr).trim() || error.message}`)) : done());
    }),
    log: io.log,
    error: io.error,
  });
}
