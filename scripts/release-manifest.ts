// the files dusk.bot serves for a desktop release: SHA256SUMS over the installers, and latest.json, whose signature
// (DUSK_RELEASE_SIGNING_KEY, release environment only) vouches for the version and the sums.
//
//   DUSK_RELEASE_SIGNING_KEY=... node scripts/release-manifest.ts release [--version 0.1.142]
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseReleaseKeys, PINNED_RELEASE_KEYS, signRelease, verifyRelease } from "../apps/cloud-service/src/release-signing.ts";

export const INSTALLER = /^Metal-\d+\.\d+\.\d+(-[a-z0-9]+)?(-setup)?\.(dmg|zip|exe|AppImage|deb)$|^Metal-\d+\.\d+\.\d+-(win-)?(arm64|x64|amd64|x86_64)\.(dmg|zip|AppImage|deb)$/;

export function sha256sums(dir: string): string {
  const files = readdirSync(dir).filter(name => INSTALLER.test(name) && statSync(join(dir, name)).isFile()).sort();
  if (!files.length) throw new Error(`no installers in ${dir}`);
  return files.map(name => `${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}  ${name}`).join("\n") + "\n";
}

export function releaseManifest(sums: string, version: string, signingKey: string, now = Date.now()) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  const sha256 = createHash("sha256").update(sums).digest("hex");
  const signature = signRelease({ kind: "desktop", name: "Metal", version, sha256, signedAt: now }, signingKey);
  // a key the apps do not pin would announce a release nobody hears about: refuse it here
  verifyRelease(signature, { kind: "desktop", sha256 }, [...PINNED_RELEASE_KEYS, ...parseReleaseKeys(process.env.DUSK_RELEASE_PUBLIC_KEYS)]);
  return { v: 1, version, sha256sums: sha256, signature };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { version: { type: "string" } } });
  const dir = positionals[0], key = process.env.DUSK_RELEASE_SIGNING_KEY;
  if (!dir || !key) {
    console.error("usage: DUSK_RELEASE_SIGNING_KEY=... release-manifest.ts <release dir> [--version x.y.z]");
    process.exit(2);
  }
  const version = values.version ?? (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const sums = sha256sums(dir);
  writeFileSync(join(dir, "SHA256SUMS"), sums);
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(releaseManifest(sums, version, key), null, 2)}\n`);
  console.log(`${join(dir, "SHA256SUMS")}\n${join(dir, "latest.json")} (${version})`);
}
