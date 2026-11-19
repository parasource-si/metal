import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Chromium splits the setuid sandbox's path on spaces, so a Linux install folder with a space crashes every launch on
// Ubuntu 24.04. electron-builder names the folder /opt/<productName>, so every Linux build must pass a space-free one.
describe("the Linux install folder", () => {
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
  const linux = Object.entries(scripts).filter(([, command]) => /electron-builder\b.*--linux/.test(command));

  it("is /opt/dusk-bot for every Linux build", () => {
    expect(linux.length).toBeGreaterThan(0);
    for (const [name, command] of linux) {
      const productName = /-c\.productName=(\S+)/.exec(command)?.[1];
      expect(productName, name).toBe("dusk-bot");
    }
  });

  it("is what the package scripts and checks expect", () => {
    for (const file of ["../build/linux-after-install.sh", "../build/linux-after-remove.sh", "../build/linux-dusk-browser.apparmor"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/\/opt\/Metal/);
      expect(text, file).toContain("/opt/dusk-bot");
    }
  });
});
