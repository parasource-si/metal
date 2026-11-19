// every Chromium, Chrome for Testing or Electron this repo starts must stay off the macOS keychain: without
// --use-mock-keychain and --password-store=basic, a headless Chrome on the owner's Mac puts up "Keychain Not Found".
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { credentialStoreFlags, gateChromeFlags } from "../../server/browser/egress/gate.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FLAGS = ["--use-mock-keychain", "--password-store=basic"];

/** a file that starts a browser: raw switches, a Playwright or Puppeteer launch, or agent-browser launch args */
const LAUNCH = /--headless|--remote-debugging-p(?:ort|ipe)|--dump-dom|chromium\.launch\(|launchPersistentContext\(|puppeteer\.launch\(|AGENT_BROWSER_ARGS/u;
/** helpers that already add both switches (all built on credentialStoreFlags) */
const HELPERS = /credentialStoreFlags\(|gateChromeFlags\(|gateChromeSettings\(|chromeLaunchArgs\(|chromeArgs\(|launcherFlags\(|sessionEnv\(/u;

/** files that match LAUNCH but never start a browser on a Mac, with the reason */
const EXEMPT: Record<string, string> = {
  "scripts/defender-check-win.mjs": "windows only, where neither switch exists",
  "scripts/testing/firefox-sandbox.py": "firefox, which has no keychain switch",
  "scripts/verify-podman-firefox.ts": "firefox in a linux container",
  "server/bot-box/box.test.ts": "asserts how a command is wrapped, starts nothing",
  "server/bot-box/bridge.test.ts": "asserts how a command is wrapped, starts nothing",
  "server/browser-processes.ts": "matches running processes by their switches",
  "server/browser-tool-shape.test.ts": "a switch inside sample text",
  "server/browser/cdp/transport.ts": "names the pipe protocol, starts nothing",
  "server/browser/chrome/processes.test.ts": "matches running processes by their switches",
  "server/vps-browser-close.ts": "matches running processes on the vps",
};

function trackedSources(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => /\.(?:m?[jt]s|py|sh)$/u.test(file) && !file.includes("/public/") && !file.startsWith("docs/"));
}

describe("headless Chrome never reaches the macOS keychain", () => {
  it("gives every Chrome Metal starts on a Mac both switches", () => {
    expect(credentialStoreFlags("darwin")).toEqual(expect.arrayContaining(FLAGS));
    expect(gateChromeFlags(4321, "darwin")).toEqual(expect.arrayContaining(FLAGS));
  });

  it("makes agent-browser run from the repo pass both switches", () => {
    const config = JSON.parse(readFileSync(new URL("../../agent-browser.json", import.meta.url), "utf8")) as { args?: string };
    expect(String(config.args).split(/[,\n]/u)).toEqual(expect.arrayContaining(FLAGS));
  });

  it("finds no launcher in the repo without both switches or a helper that adds them", () => {
    const missing = trackedSources().filter((file) => {
      if (file in EXEMPT || file === "scripts/testing/chrome-keychain-guard.test.ts") return false;
      const source = readFileSync(`${ROOT}/${file}`, "utf8");
      if (!LAUNCH.test(source)) return false;
      return !HELPERS.test(source) && !FLAGS.every((flag) => source.includes(flag));
    });
    expect(missing, "add --use-mock-keychain and --password-store=basic (or credentialStoreFlags()) to these launchers").toEqual([]);
  });

  it("keeps the local mac release's signing keychain last in the search list and puts the list back on any exit", () => {
    const script = readFileSync(`${ROOT}/scripts/release-mac-local.sh`, "utf8");
    expect(script).not.toMatch(/list-keychains -d user -s "\$KEYCHAIN"/u);
    expect(script).toMatch(/list-keychains -d user -s \$\{existing\[@\]\+"\$\{existing\[@\]\}"\} "\$KEYCHAIN"/u);
    expect(script).not.toMatch(/default-keychain/u);
    for (const signal of ["EXIT", "INT", "TERM", "HUP"]) expect(script).toMatch(new RegExp(`^trap .+ ${signal}$`, "mu"));
  });

  it("keeps its exemptions real", () => {
    for (const file of Object.keys(EXEMPT)) expect(LAUNCH.test(readFileSync(`${ROOT}/${file}`, "utf8")), file).toBe(true);
  });
});
