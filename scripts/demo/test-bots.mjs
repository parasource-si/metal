// `pnpm test-bots`: adds the invented test bots (scripts/demo/content.mjs) to a running Metal, by default the
// one on this computer at 127.0.0.1:8799, through its HTTP API only. Run it again and it skips what is already there.
// `pnpm test-bots --remove` deletes only what it created, by the ids in its manifest, never anything else.
//
//   pnpm test-bots [--url http://127.0.0.1:PORT]
//   pnpm test-bots --remove [--url ...]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SECTION } from "./content.mjs";
import { call, readOwnerToken, seedBots, useOwnerToken } from "./seed-live.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (flag("--url") || process.env.DUSK_TEST_BOTS_URL || "http://127.0.0.1:8799").replace(/\/$/, "");
const remove = args.includes("--remove");
// --first-run: what `pnpm dev:server` runs on start; seeds a brand-new workspace once, and never again after
const firstRun = args.includes("--first-run");
const MANIFESTS = join(homedir(), ".duskbot-test-bots");
// --owner-stdin: the dev app's server child writes the desktop owner capability on stdin, which its API asks for
const ownerOnStdin = args.includes("--owner-stdin");

if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(base)) {
  console.error("pnpm test-bots: --url must be http://127.0.0.1:PORT, a server on this computer");
  process.exit(2);
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const empty = () => ({ bots: [], rooms: [], routines: [], webhooks: [], sections: [] });

async function target() {
  const health = await call(base, "GET", "/api/health").catch(() => null);
  if (health?.app !== "duskbot") throw new Error(`no Metal server answers at ${base}`);
  const environment = await call(base, "GET", "/.well-known/duskbot/environment");
  if (!environment?.environmentId) throw new Error("the server did not say which workspace it is");
  return join(MANIFESTS, `manifest-${environment.environmentId}.json`);
}

function merge(manifest, created) {
  for (const key of Object.keys(empty())) {
    const seen = new Set(manifest[key].map((entry) => (typeof entry === "string" ? entry : entry.id)));
    for (const entry of created[key]) if (!seen.has(typeof entry === "string" ? entry : entry.id)) manifest[key].push(entry);
  }
  return manifest;
}

async function seed(manifestFile) {
  console.log(`Adding test bots to ${base}`);
  const { created, skipped, credentials } = await seedBots(base, Date.now(), (line) => console.log(line));
  const made = created.bots.length + created.rooms.length + created.routines.length + created.webhooks.length;
  if (made) {
    const manifest = merge({ ...empty(), ...readJson(manifestFile), url: base }, created);
    mkdirSync(MANIFESTS, { recursive: true, mode: 0o700 });
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }
  if (Object.keys(credentials).length) {
    const hooksFile = manifestFile.replace(/manifest-/, "webhooks-");
    writeFileSync(hooksFile, `${JSON.stringify({ ...readJson(hooksFile), ...credentials }, null, 2)}\n`, { mode: 0o600 });
  }
  if (skipped.length) console.log(`  already there, left as they are: ${skipped.join(", ")}`);
  console.log(made ? `Done. Remove them with: pnpm test-bots --remove\n  manifest: ${manifestFile}` : "Nothing to add: every test bot, room, routine and webhook is already there.");
}

async function removeAll(manifestFile) {
  const manifest = readJson(manifestFile);
  if (!manifest) {
    console.log(`No manifest for ${base}; nothing this tool created is recorded, so nothing was removed.`);
    return;
  }
  const [roster, routineList, webhookList] = await Promise.all([
    call(base, "GET", "/api/bots?messages=0"), call(base, "GET", "/api/routines"), call(base, "GET", "/api/webhooks"),
  ]);
  const kept = empty();
  const removed = [];
  const drop = async (list, present, path, label) => {
    for (const entry of manifest[list]) {
      if (!present(entry.id)) continue;
      try {
        await call(base, "DELETE", path(entry.id));
        removed.push(`${label} ${entry.name}`);
      } catch (error) {
        kept[list].push(entry);
        console.error(`  could not remove ${label} ${entry.name}: ${error.message}`);
      }
    }
  };
  const has = (items) => (id) => items.some((item) => item.id === id);
  await drop("webhooks", has(webhookList.webhooks), (id) => `/api/webhooks/${id}`, "webhook");
  await drop("routines", has(routineList.routines), (id) => `/api/routines/${id}`, "routine");
  await drop("rooms", has(roster.groups ?? []), (id) => `/api/groups/${id}`, "room");
  for (const entry of manifest.bots) {
    const bot = roster.bots.find((candidate) => candidate.id === entry.id);
    if (bot && (bot.section ?? "").trim() !== SECTION) {
      kept.bots.push(entry);
      console.log(`  kept ${bot.name}: it was moved out of "${SECTION}", so it is yours now`);
    }
  }
  await drop("bots", (id) => roster.bots.some((bot) => bot.id === id && (bot.section ?? "").trim() === SECTION), (id) => `/api/bots/${id}`, "bot");
  if (manifest.sections.includes(SECTION)) {
    const after = await call(base, "GET", "/api/bots?messages=0");
    const stillUsed = after.bots.some((bot) => bot.section === SECTION) || (after.groups ?? []).some((group) => group.section === SECTION);
    if ((after.sections ?? []).includes(SECTION) && !stillUsed) {
      await call(base, "DELETE", `/api/sidebar-sections?section=${encodeURIComponent(SECTION)}`);
      removed.push(`section ${SECTION}`);
    } else if (stillUsed) kept.sections.push(SECTION);
  }
  console.log(removed.length ? `Removed: ${removed.join(", ")}` : "Nothing to remove: everything in the manifest was already gone.");
  if (!kept.webhooks.length) rmSync(manifestFile.replace(/manifest-/, "webhooks-"), { force: true });
  if (Object.values(kept).some((list) => list.length)) writeFileSync(manifestFile, `${JSON.stringify({ ...kept, url: base }, null, 2)}\n`, { mode: 0o600 });
  else rmSync(manifestFile, { force: true });
}

/** A workspace gets the test bots by itself only while it is new: nothing but its starting bot and no rooms. The marker
 * is written either way, so a person who removes them, or already had bots, is never seeded behind their back. */
async function seedIfNew(manifestFile) {
  const marker = manifestFile.replace(/manifest-/, "first-run-");
  if (existsSync(marker) || existsSync(manifestFile)) return;
  const roster = await call(base, "GET", "/api/bots?messages=0");
  const fresh = (roster.bots ?? []).length <= 1 && !(roster.groups ?? []).length;
  mkdirSync(MANIFESTS, { recursive: true, mode: 0o700 });
  writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  if (fresh) await seed(manifestFile);
}

try {
  if (ownerOnStdin) useOwnerToken(await readOwnerToken(process.stdin));
  const manifestFile = await target();
  if (remove) await removeAll(manifestFile);
  else if (firstRun) await seedIfNew(manifestFile);
  else await seed(manifestFile);
} catch (error) {
  console.error(`pnpm test-bots: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
