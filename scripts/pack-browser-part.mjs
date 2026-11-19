// Packs the bots' browser (agent-browser + Chromium headless shell) as a part the Mac installer leaves out: signs
// every Mach-O with the release's Developer ID (hardened runtime, the app's entitlements), zips it for the release, and
// writes the parts.json the app ships, which pins the zip's size and SHA-256. The app verifies both before using it.
//   node scripts/pack-browser-part.mjs [--target darwin-arm64] [--version 0.2.13]
// env: DUSK_PARTS_SIGN_IDENTITY (else MAC_SIGN_IDENTITY, else CSC_NAME, else ad hoc), DUSK_PARTS_KEYCHAIN
// (else MAC_KEYCHAIN, else CSC_KEYCHAIN), DUSK_PARTS_BASE_URL (default: the public downloads release).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { browserBundleSpec } from "../server/browser-bundle-release.ts";
import { verifyBrowserBundle } from "./prepare-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const DOWNLOADS_BASE = "https://github.com/parasource-si/metal/releases/download";

export const partFileName = (version, target) => `Metal-${version}-browser-${target}.zip`;

/** Same vendor builds, same id: a later app version reuses the browser it already has. */
export function browserPartId(target) {
  const spec = browserBundleSpec(target);
  return `agent-browser-${spec.engine.version}_chrome-${spec.chrome.version}_${target}`;
}

export function partUrl(version, target, base = process.env.DUSK_PARTS_BASE_URL || DOWNLOADS_BASE) {
  return base === DOWNLOADS_BASE ? `${base}/v${version}/${partFileName(version, target)}` : `${base.replace(/\/$/, "")}/${version}/${partFileName(version, target)}`;
}

export function signingIdentity(env = process.env) {
  const named = env.DUSK_PARTS_SIGN_IDENTITY || env.MAC_SIGN_IDENTITY || env.CSC_NAME || "-";
  const keychain = env.DUSK_PARTS_KEYCHAIN || env.MAC_KEYCHAIN || env.CSC_KEYCHAIN || "";
  return { identity: named === "-" || named.startsWith("Developer ID Application: ") ? named : `Developer ID Application: ${named}`, keychain };
}

const MACHO = new Set(["feedfacf", "cffaedfe", "cafebabe", "bebafeca", "feedface", "cefaedfe"]);
const isMachO = (head) => head.length === 4 && MACHO.has(head.toString("hex"));

function machOFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...machOFiles(file));
    else if (entry.isFile() && isMachO(readFileSync(file).subarray(0, 4))) found.push(file);
  }
  return found;
}

function sign(files, { identity, keychain }) {
  const entitlements = join(root, "build", "entitlements.mac.plist");
  for (const file of files) {
    const args = ["--force", "--sign", identity, "--options", "runtime", "--entitlements", entitlements];
    if (identity !== "-") args.push("--timestamp", ...(keychain ? ["--keychain", keychain] : []));
    execFileSync("codesign", [...args, file], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("codesign", ["--verify", "--strict", file], { stdio: ["ignore", "ignore", "inherit"] });
  }
}

function teamOf(file) {
  // codesign -d prints to stderr
  const info = spawnSync("codesign", ["-dv", "--verbose=4", file], { encoding: "utf8" });
  return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(`${info.stdout}${info.stderr}`)?.[1] ?? null;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function packBrowserPart({ target, version, out = join(root, "release"), stagedRoot = join(root, "dist-native", "browser"), env = process.env }) {
  if (!target.startsWith("darwin-")) throw new Error(`the browser is a downloaded part only on the Mac, not ${target}`);
  const staged = join(stagedRoot, target);
  verifyBrowserBundle(staged, target);
  const scratch = mkdtempSync(join(stagedRoot, `.part-${target}-`));
  try {
    const bundle = join(scratch, "bundle");
    execFileSync("ditto", [staged, bundle]);
    const files = machOFiles(bundle);
    if (files.length === 0) throw new Error("the browser bundle has no executables to sign");
    const signer = signingIdentity(env);
    sign(files, signer);
    const teamId = signer.identity === "-" ? null : teamOf(join(bundle, browserBundleSpec(target).engine.executable));
    if (signer.identity !== "-" && !teamId) throw new Error("the signed browser names no Developer ID team");
    mkdirSync(out, { recursive: true });
    const zip = join(out, partFileName(version, target));
    rmSync(zip, { force: true });
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", bundle, zip]);
    const part = { name: "browser", id: browserPartId(target), target, url: partUrl(version, target), bytes: statSync(zip).size, sha256: sha256(zip), teamId };
    const manifestDir = join(root, "dist-native", "parts", target);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "parts.json"), `${JSON.stringify({ v: 1, parts: [part] }, null, 2)}\n`);
    console.log(`browser part: ${zip} (${Math.round(part.bytes / 1024 / 1024)} MB, ${files.length} Mach-O signed ${teamId ? `by ${teamId}` : "ad hoc"})`);
    return { zip, part };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { target: { type: "string", multiple: true }, version: { type: "string" } } });
  const version = values.version ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const stagedRoot = join(root, "dist-native", "browser");
  const targets = values.target ?? (existsSync(stagedRoot) ? readdirSync(stagedRoot).filter((name) => name.startsWith("darwin-")) : []);
  if (targets.length === 0) throw new Error("no staged Mac browser in dist-native/browser; run pnpm build:browser first");
  for (const target of targets) packBrowserPart({ target, version });
}
