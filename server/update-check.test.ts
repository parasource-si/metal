import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { PINNED_RELEASE_KEYS, signRelease } from "../apps/cloud-service/src/release-signing.ts";
import { releaseManifest, sha256sums } from "../scripts/release-manifest.ts";
import { createUpdateChecker, DESKTOP_DOWNLOAD_URL, DESKTOP_RELEASE_KEYS, installKind, LATEST_RELEASE_URL, newerVersion,
  verifiedDesktopVersion, type InstallKind } from "./update-check.ts";

afterEach(() => vi.unstubAllGlobals());

const testManifestUrl = "https://releases.example.test/latest.json";
const pair = generateKeyPairSync("ed25519");
const testKey = { kid: "rel-test", x: pair.publicKey.export({ format: "jwk" }).x! };
const signingKey = `rel-test:${pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
const sign = (version: string, kind: "desktop" | "home-package" = "desktop") =>
  ({ v: 1, signature: signRelease({ kind, name: "Metal", version, sha256: "a".repeat(64), signedAt: 1 }, signingKey) });

describe("server update check", () => {
  it("tells how this server was installed", () => {
    const none = () => false;
    const root = ["", "srv", "Metal", "server"].join(sep);
    expect(installKind({ desktopManaged: true, managed: false, serverRoot: root, exists: () => true })).toBe("desktop");
    expect(installKind({ desktopManaged: false, managed: true, serverRoot: root, exists: () => true })).toBe("managed");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/.dockerenv" })).toBe("docker");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === "/run/.containerenv" })).toBe("podman");
    expect(installKind({
      desktopManaged: false, managed: false, exists: none,
      serverRoot: ["", "usr", "lib", "node_modules", "duskbot", "dist-server"].join(sep),
    })).toBe("npm");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: (path) => path === join(root, "..", ".git") })).toBe("git");
    expect(installKind({ desktopManaged: false, managed: false, serverRoot: root, exists: none })).toBe("unknown");
  });

  it("identifies only this fork as its release repository", () => {
    expect(LATEST_RELEASE_URL).toBe("https://api.github.com/repos/parasource-si/metal/releases/latest");
  });

  it("never checks public feeds or suggests upstream install commands for any installation the desktop app does not own", async () => {
    const fetchRelease = vi.fn(async () => new Response(JSON.stringify({
      tag_name: "v999.0.0", html_url: "https://github.com/parasource-si/metal/releases/tag/v999.0.0",
    })));
    vi.stubGlobal("fetch", fetchRelease);
    const installs: InstallKind[] = ["managed", "docker", "podman", "npm", "git", "unknown"];
    for (const install of installs) {
      const check = createUpdateChecker({ current: "0.1.141", install });
      expect(await check()).toEqual({ current: "0.1.141", install, available: false });
      expect(await check()).not.toHaveProperty("command");
    }
    expect(fetchRelease).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])("makes no false offer or network request when private releases would return %i", async (status) => {
    const fetchRelease = vi.fn(async () => new Response("{}", { status }));
    vi.stubGlobal("fetch", fetchRelease);
    const check = createUpdateChecker({ current: "0.1.141", install: "git" });
    expect(await check()).toEqual({ current: "0.1.141", install: "git", available: false });
    expect(fetchRelease).not.toHaveBeenCalled();
  });
});

describe("desktop update check", () => {
  it("pins the same release keys as the cloud service", () => {
    expect(DESKTOP_RELEASE_KEYS).toEqual(PINNED_RELEASE_KEYS);
  });

  it("links to the Metal releases page for a published Metal version", async () => {
    const fetchRelease = vi.fn(async () => Response.json({
      tag_name: "v0.1.150", draft: false, prerelease: false, html_url: "https://example.test/untrusted",
    }));
    const check = createUpdateChecker({ current: "0.1.141", install: "desktop", fetch: fetchRelease });
    expect(await check()).toEqual({ current: "0.1.141", install: "desktop", available: true, latest: "0.1.150", releaseUrl: DESKTOP_DOWNLOAD_URL });
    expect(fetchRelease).toHaveBeenCalledWith(LATEST_RELEASE_URL, expect.objectContaining({ redirect: "error" }));
  });

  it("offers a newer signed desktop release and points only at the download page", async () => {
    const fetchManifest = vi.fn(async () => new Response(JSON.stringify(sign("0.1.150"))));
    const check = createUpdateChecker({ current: "0.1.141", install: "desktop", fetch: fetchManifest, manifestUrl: testManifestUrl, keys: [testKey] });
    expect(await check()).toEqual({ current: "0.1.141", install: "desktop", available: true, latest: "0.1.150", releaseUrl: DESKTOP_DOWNLOAD_URL });
    expect(fetchManifest).toHaveBeenCalledWith(testManifestUrl, expect.objectContaining({ redirect: "error" }));
    expect(await check()).toMatchObject({ available: true });
    expect(fetchManifest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an older release", () => sign("0.1.100")],
    ["the same release", () => sign("0.1.141")],
    ["another kind of artifact", () => sign("0.1.150", "home-package")],
    ["an unknown key", () => ({ v: 1, signature: sign("0.1.150").signature.replace("r1.rel-test.", "r1.rel-other.") })],
    ["a tampered version", () => { const parts = sign("0.1.150").signature.split("."); parts[2] = Buffer.from(JSON.stringify({ v: 1, kind: "desktop", name: "Metal", version: "9.9.9", sha256: "a".repeat(64), signedAt: 1 })).toString("base64url"); return { v: 1, signature: parts.join(".") }; }],
    ["an unsigned answer", () => ({ v: 1, version: "9.9.9" })],
  ])("offers nothing for %s", async (_name, body) => {
    const check = createUpdateChecker({ current: "0.1.141", install: "desktop", fetch: async () => new Response(JSON.stringify(body())), manifestUrl: testManifestUrl, keys: [testKey] });
    expect(await check()).toEqual({ current: "0.1.141", install: "desktop", available: false });
  });

  it("is quiet before the first release is published and says so when the site fails", async () => {
    expect(await createUpdateChecker({ current: "0.1.141", install: "desktop", fetch: async () => new Response("", { status: 404 }) })()).toMatchObject({ available: false });
    await expect(createUpdateChecker({ current: "0.1.141", install: "desktop", fetch: async () => new Response("", { status: 502 }) })()).rejects.toThrow("502");
  });

  it("compares plain versions only", () => {
    expect(newerVersion("0.2.0", "0.1.999")).toBe(true);
    expect(newerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(newerVersion("0.1.9", "0.1.10")).toBe(false);
    expect(newerVersion("1.0.0-beta", "0.1.0")).toBe(false);
    expect(verifiedDesktopVersion(null)).toBeNull();
  });

  it("builds a manifest over the installers that the app accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-release-"));
    writeFileSync(join(dir, "Metal-0.1.150-arm64.dmg"), "mac");
    writeFileSync(join(dir, "Metal-0.1.150-setup.exe"), "win");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const sums = sha256sums(dir);
    expect(sums.trim().split("\n").map((line) => line.split("  ")[1])).toEqual(["Metal-0.1.150-arm64.dmg", "Metal-0.1.150-setup.exe"]);
    vi.stubEnv("DUSK_RELEASE_PUBLIC_KEYS", `${testKey.kid}:${testKey.x}`);
    const manifest = releaseManifest(sums, "0.1.150", signingKey);
    vi.unstubAllEnvs();
    expect(verifiedDesktopVersion(manifest, [testKey])).toBe("0.1.150");
    expect(() => releaseManifest(sums, "0.1.150", signingKey)).toThrow();
  });
});
