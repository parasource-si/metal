// Builds our server, from this checkout, into the one .tgz the VPS installer
// downloads from the link service. It is private: never `npm publish` it and
// never put it at a public url; the link service hands it only to a claimed
// install session (apps/link-service/README.md, "The server build").
//
//   node scripts/build-vps-package.mjs                       # build, pack into release/vps/
//   node scripts/build-vps-package.mjs --skip-build          # pack what dist-server/ and dist/ already hold
//   node scripts/build-vps-package.mjs --publish <data dir>  # also hand it to a link service: <dir>/packages/
//   --allow-unpublished-desktop                              # a test build whose BOT_DESKTOP_IMAGE is not published yet
//
// It reuses the npm package layout (scripts/build-npm-package.mjs): the
// bundled server, the built UI, skills, the CLI, and the three native
// dependencies npm installs per platform, so one tarball serves amd64 and arm64.
// Beside it goes the bot computer kit: deploy/bot-desktop/ and shared/bot-desktop.ts
// (build.sh reads the image tag there), which install.sh uses to fence the host
// and to build the image when the registry has no copy of BOT_DESKTOP_IMAGE.
// The same deploy/bot-desktop/ also goes inside the package, beside dist-server/,
// so the installed server builds the image itself after an update (server/bot-desktop.ts).
// With DUSK_RELEASE_SIGNING_KEY set (CI's release environment) the build is signed (kind vps-package, its version and
// sha256) and the signature rides in manifest.json and current.json: an install that has once taken a signed build takes
// only signed ones after, and never one older than it runs, below the signed floor or blocked (apps/link-service/install.sh).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBotDesktopPublished } from "./check-bot-desktop-published.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return null;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a directory`);
    process.exit(2);
  }
  return resolve(value);
};
const publishTo = option("--publish");

// a server pointing at a bot computer image nobody can pull could never set up a new computer
if (!flag("--allow-unpublished-desktop")) {
  const problem = await checkBotDesktopPublished().catch((error) => `could not be checked: ${error.message}`);
  if (problem) {
    console.error(`bot computer image: ${problem}. Publish it first, or pass --allow-unpublished-desktop for a test build.`);
    process.exit(1);
  }
}

const run = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, stdio: "inherit" });
const quiet = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, encoding: "utf8" }).trim();

if (!flag("--skip-build")) {
  run("pnpm", ["build:server"]);
  run("pnpm", ["exec", "vite", "build"]);
}
run(process.execPath, [join(root, "scripts", "build-npm-package.mjs")]);

// mark it private so a stray `npm publish` in release/npm refuses
const npmDir = join(root, "release", "npm");
const manifestPath = join(npmDir, "package.json");
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
// Existing VPS installers upgrade this npm package in place and read its fixed install path.
pkg.name = "duskbot";
pkg.private = true;
const kitFiles = quiet("git", ["ls-files", "deploy/bot-desktop", "shared/bot-desktop.ts"]).split("\n").filter(Boolean);
for (const file of kitFiles.filter((path) => path.startsWith("deploy/bot-desktop/"))) {
  mkdirSync(dirname(join(npmDir, file)), { recursive: true });
  copyFileSync(join(root, file), join(npmDir, file));
}
// root's updater on the server (install.sh --update-server) takes its next copy from a signed build that carries it
mkdirSync(join(npmDir, "link"), { recursive: true });
copyFileSync(join(root, "apps", "link-service", "install.sh"), join(npmDir, "link", "install.sh"));
// and its docker gate: a build whose bot computer image the old gate refuses never updates a computer (2026-11-14)
copyFileSync(join(root, "apps", "link-service", "docker-gate.mjs"), join(npmDir, "link", "docker-gate.mjs"));
pkg.files = [...new Set([...(pkg.files ?? []), "deploy", "link"])];
writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");

const out = join(root, "release", "vps");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const packed = quiet("npm", ["pack", "--silent", "--pack-destination", out], npmDir).split("\n").pop();
const bytes = readFileSync(join(out, packed));
const sha256 = createHash("sha256").update(bytes).digest("hex");
let commit = "";
try { commit = quiet("git", ["rev-parse", "--short=12", "HEAD"]); } catch { /* not a checkout */ }
const name = `duskbot-${pkg.version}-${sha256.slice(0, 12)}.tgz`;
renameSync(join(out, packed), join(out, name));
let signature = null;
if (process.env.DUSK_RELEASE_SIGNING_KEY) {
  run(process.execPath, ["--experimental-strip-types", join(root, "apps", "cloud-service", "scripts", "sign-release.ts"), join(out, name), "--kind", "vps-package", "--name", "duskbot", "--version", pkg.version]);
  signature = readFileSync(join(out, `${name}.sig`), "utf8").trim();
  rmSync(join(out, `${name}.sig`));
}
const manifest = { sha256, version: pkg.version, size: bytes.length, commit, builtAt: new Date().toISOString(), file: name, ...(signature ? { signature } : {}) };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`vps package: ${join(out, name)} (${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${sha256})`);

// the kit: tracked files only, no mac metadata
const image = /^export const BOT_DESKTOP_IMAGE = "([^"]+)";/m.exec(readFileSync(join(root, "shared", "bot-desktop.ts"), "utf8"))?.[1];
if (!image) throw new Error("BOT_DESKTOP_IMAGE not found in shared/bot-desktop.ts");
const kitTmp = join(out, "bot-desktop-kit.tgz");
execFileSync("tar", ["--no-xattrs", "-czf", kitTmp, "-C", root, ...kitFiles], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const kitBytes = readFileSync(kitTmp);
const kitSha = createHash("sha256").update(kitBytes).digest("hex");
const kitName = `bot-desktop-kit-${kitSha.slice(0, 12)}.tgz`;
renameSync(kitTmp, join(out, kitName));
manifest.desktop = { sha256: kitSha, image, size: kitBytes.length, file: kitName };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`bot computer kit: ${join(out, kitName)} (${kitFiles.length} files, ${(kitBytes.length / 1024).toFixed(0)} KB, image ${image})`);

if (publishTo) {
  // content-addressed file first, then the pointer, each by rename, so a running link service never reads half of either
  const dir = join(publishTo, "packages");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [file, sha] of [[name, sha256], [kitName, kitSha]]) {
    copyFileSync(join(out, file), join(dir, `${sha}.tgz.tmp`));
    renameSync(join(dir, `${sha}.tgz.tmp`), join(dir, `${sha}.tgz`));
  }
  const pointer = { sha256, version: pkg.version, commit, builtAt: manifest.builtAt, ...(signature ? { signature } : {}), desktop: { sha256: kitSha, image } };
  writeFileSync(join(dir, "current.json.tmp"), JSON.stringify(pointer) + "\n", { mode: 0o600 });
  renameSync(join(dir, "current.json.tmp"), join(dir, "current.json"));
  console.log(`published to ${dir}: new installs get ${pkg.version} (${sha256.slice(0, 12)})`);
}
