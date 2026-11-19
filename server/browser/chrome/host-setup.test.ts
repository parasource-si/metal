import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { parseArgs } from "../../cli.ts";
import {
  APPARMOR_PROFILE_PATH, appArmorProfile, BrowserHostError, diagnoseLaunchFailure, missingLibraries, sandboxBlocked, sandboxDisabled, SETUP_COMMAND,
  setUpBrowserHost, SYSTEM_CHROME, USERNS_RESTRICTION, type HostSetupDeps,
} from "./host-setup.ts";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

describe("host setup", () => {
  it("pins the AppArmor exemption to one root-owned executable", () => {
    const profile = appArmorProfile("/opt/dusk-bot/resources/chrome/chrome");
    expect(profile).toContain('profile duskbot-chrome "/opt/dusk-bot/resources/chrome/chrome" flags=(unconfined)');
    expect(profile).toContain("userns,");
    for (const path of ["/opt/**/chrome", "/home/a/chrome", "relative/chrome", "/opt/a\nb/chrome", "/opt/a\tb/chrome", "/opt/a\u2028b/chrome", "/opt/a\0b/chrome", '/opt/a"b/chrome', "/opt/a\\b/chrome"]) expect(() => appArmorProfile(path)).toThrow();
  });

  it("names the sandbox when Chrome says it has none, and never turns it off by itself", async () => {
    const diagnosis = await diagnoseLaunchFailure({ executable: "/opt/chrome", output: "[0101/000000.000:FATAL:zygote_host_impl_linux.cc] No usable sandbox! ...", platform: "darwin" });
    expect(diagnosis).toBeInstanceOf(BrowserHostError);
    expect(diagnosis?.kind).toBe("sandbox");
    expect(diagnosis?.message).toMatch(/metal browser setup/);
    expect(await diagnoseLaunchFailure({ executable: "/opt/chrome", output: "something else", platform: "darwin" })).toBeNull();
    expect(sandboxDisabled({})).toBe(false);
    expect(sandboxDisabled({ DUSK_BROWSER_SANDBOX: "0" })).toBe(true);
  });

  it.skipIf(process.platform === "win32")("asks the browser's own loader which libraries are missing, in the environment the browser launched with", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-host-setup-test-"));
    folders.push(dir);
    const chrome = join(dir, "chrome");
    writeFileSync(chrome, `#!/bin/sh\nprintf '%s' "$HOME" > '${dir}/home'\necho "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file" >&2\nexit 127\n`, { mode: 0o755 });
    const env = { PATH: "/usr/bin:/bin", HOME: "/home/someone" };
    expect(await missingLibraries(chrome, env)).toEqual(["libnss3.so"]);
    expect(readFileSync(join(dir, "home"), "utf8")).toBe("/home/someone");
    expect(await diagnoseLaunchFailure({ executable: chrome, output: "", platform: "linux", env })).toMatchObject({ kind: "libraries", libraries: ["libnss3.so"] });
  });

  it("sees a blocked sandbox only where user namespaces are restricted and no profile is installed", () => {
    const read = (path: string) => (path === USERNS_RESTRICTION ? "1\n" : "");
    expect(sandboxBlocked({ platform: "linux", read, exists: () => false })).toBe(true);
    expect(sandboxBlocked({ platform: "linux", read, exists: () => true })).toBe(false);
    expect(sandboxBlocked({ platform: "linux", read: () => "0", exists: () => false })).toBe(false);
    expect(sandboxBlocked({ platform: "darwin", read, exists: () => false })).toBe(false);
  });
});

describe("browser setup", () => {
  it("is a command the CLI takes, as every browser error quotes it", () => {
    for (const error of [new BrowserHostError("sandbox"), new BrowserHostError("libraries", ["libnss3.so"])]) {
      const quoted = /`([^`]+)`/.exec(error.message)![1]!;
      expect(quoted).toBe(SETUP_COMMAND);
      const argv = quoted.split(" ");
      expect(argv.slice(0, 2)).toEqual(["sudo", "duskbot"]);
      expect(parseArgs(argv.slice(2), {})).toMatchObject({ command: "browser", browserAction: "setup" });
    }
  });

  function deps(overrides: Partial<HostSetupDeps> = {}) {
    const written: Array<[string, string]> = [];
    const loaded: string[] = [];
    const lines: string[] = [];
    const errors: string[] = [];
    const all: HostSetupDeps = {
      platform: "linux",
      isRoot: () => true,
      installLibraries: async () => 0,
      sandboxBlocked: () => true,
      exists: (path) => path === SYSTEM_CHROME,
      writeProfile: (path, text) => { written.push([path, text]); },
      loadProfile: async (path) => { loaded.push(path); },
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
      ...overrides,
    };
    return { all, written, loaded, lines, errors };
  }

  it("installs the libraries, then writes and loads the AppArmor profile for Google Chrome", async () => {
    const d = deps();
    expect(await setUpBrowserHost(d.all)).toBe(0);
    expect(d.written).toEqual([[APPARMOR_PROFILE_PATH, appArmorProfile(SYSTEM_CHROME)]]);
    expect(d.loaded).toEqual([APPARMOR_PROFILE_PATH]);
  });

  it("needs root, stops when the libraries fail, and leaves an unrestricted host alone", async () => {
    const notRoot = deps({ isRoot: () => false });
    expect(await setUpBrowserHost(notRoot.all)).toBe(1);
    expect(notRoot.errors[0]).toContain(SETUP_COMMAND);
    const noLibraries = deps({ installLibraries: async () => 1 });
    expect(await setUpBrowserHost(noLibraries.all)).toBe(1);
    expect(noLibraries.written).toEqual([]);
    const open = deps({ sandboxBlocked: () => false });
    expect(await setUpBrowserHost(open.all)).toBe(0);
    expect(open.written).toEqual([]);
  });

  it("says what to install when no Chrome under /opt can be named in the profile", async () => {
    const d = deps({ exists: () => false });
    expect(await setUpBrowserHost(d.all)).toBe(1);
    expect(d.written).toEqual([]);
    expect(d.errors[0]).toContain(SYSTEM_CHROME);
  });
});
