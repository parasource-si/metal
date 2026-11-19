// the product's previous names, read so installs made before the rename keep working. every old literal the app still
// needs lives here (the vps installer keeps its own shell copy). nothing new is written under them except the data
// folder's lease, which a build from before the rename must still see to keep out of a folder in use.

// node's modules only when a folder is moved, so pages can import this file too
const node = (name) => globalThis.process.getBuiltinModule(name);
const join = (...parts) => node("node:path").join(...parts);

const OLD = "openmausbot";

export const LEGACY = Object.freeze({
  product: "OpenMausBot",
  devName: OLD,
  dataDirName: `.${OLD}`,
  companionDirName: `.${OLD}-companion`,
  protocol: OLD,
  appId: OLD,
  envPrefixes: ["OMB_", "OPENMAUSBOT_", "OGB_", "OPENMAUS_"],
  headerPrefix: `x-${OLD}-`,
  // the short name the product used between its two names: x-omb-* headers, omb_* cookies and tokens, omb-* and omb.* page storage
  headerPrefixes: [`x-${OLD}-`, "x-omb-", "x-openmaus-"],
  wellKnown: `/.well-known/${OLD}`,
  storagePrefixes: [`${OLD}.`, "omb-", "omb."],
  // the default bot's old short name: bot pages call window.mausbot and import "mausbot"; rooms stored by: "mausbot"
  short: "mausbot",
  documentsFolder: "MausBot",
  sentinelLabel: `com.${OLD}.sentinel`,
  linkConfigDir: `${OLD}-link`,
  vpsUnits: { server: `${OLD}.service`, link: `${OLD}-link.service` },
  serveLabel: `com.${OLD}.serve`,
  controlPlaneService: `${OLD}-control-plane`,
  // the hosted control plane issues managed companion addresses under these until it is moved to cloud.dusk.bot
  companionHostSuffixes: [`${OLD}.com`, "mausbot.si"],
  sentinelUnit: `${OLD}-sentinel`,
});

/** the data folder's lease and its delegated child folder keep their names: builds on both sides of the rename take turns by them */
export const SERVER_LEASE_NAME = `${OLD}-server.lease`;
export const SERVER_CHILD_DIR = `.${OLD}-server-child`;

/** labels and hash inputs that sealed or named something already stored: changing one would lose what it sealed */
export const SEAL_LABELS = Object.freeze({
  phoneCredential: `${OLD}-phone-credential-v1`,
  phoneCredentialInfo: "OpenMausBot phone credential v1",
  cardSecret: `${OLD}-card-secret-v1`,
  sealKey: `${OLD}-seal-key-v1`,
  sealedValue: `${OLD}-sealed-value-v1`,
  installation: `${OLD}-installation:`,
  workspaceComputer: `${OLD}:workspace-computer:`,
});

/** docker names on people's machines and in published images: bot computers, their volumes and network keep them */
export const DOCKER_NAMES = Object.freeze({
  label: (name) => `com.${OLD}.${name}`,
  computerContainer: `${OLD}-computer`,
  vpsPrefix: `${OLD}-vps`,
  desktopNetwork: `${OLD}-desktops`,
});

/** a cloud home's own layout: machines set up before the rename take the same commands, and its backups restore anywhere */
export const CLOUD_HOME = Object.freeze({
  root: `/usr/lib/${OLD}`,
  etc: `/etc/${OLD}`,
  run: `/run/${OLD}`,
  data: `/data/.${OLD}`,
  dataName: `.${OLD}`,
});

/** a phone saved this computer's lan name, so it keeps it */
export const MDNS_HOST_PREFIX = `${OLD}-`;

/** a service that still runs under the old name: the teams playbook repository (someone else's) */
export const UPSTREAM = Object.freeze({
  teamLibrary: { repository: `https://github.com/milind-soni/${OLD}-teams`, raw: `https://raw.githubusercontent.com/milind-soni/${OLD}-teams/main` },
});

const NEW_ENV = "DUSK_";
const NEW_HEADER = "x-dusk-";
const NEW_WELL_KNOWN = "/.well-known/duskbot";
const NEW_STORAGE = "duskbot.";
const STORAGE_RENAMES = { [`${OLD}.`]: NEW_STORAGE, "omb-": "dusk-", "omb.": "dusk." };
const NEW_PROTOCOL = "duskbot";

/** OMB_X and OPENMAUSBOT_X move to DUSK_X (a DUSK_X already set wins). moved, not copied: every list that keeps a
 * secret out of a child's env names only DUSK_*, so an old name left behind would reach engines and bots. */
export function aliasLegacyEnv(env) {
  if (!env || typeof env !== "object") return env;
  for (const key of Object.keys(env)) {
    const prefix = LEGACY.envPrefixes.find((p) => key.toUpperCase().startsWith(p));
    if (!prefix) continue;
    const next = NEW_ENV + key.slice(prefix.length);
    if (env[next] === undefined) env[next] = env[key];
    delete env[key];
  }
  return env;
}

/** x-openmausbot-* and x-omb-* request headers read as x-dusk-*; a value the client sent under the new name always wins. */
export function aliasLegacyHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    const prefix = LEGACY.headerPrefixes.find((p) => lower.startsWith(p));
    if (!prefix) continue;
    const next = NEW_HEADER + lower.slice(prefix.length);
    if (headers[next] === undefined) headers[next] = headers[key];
    delete headers[key];
  }
  return headers;
}

/** a response header under its new name, or under an old one when the peer predates the rename */
export function readHeader(headers, name) {
  const get = (key) => (typeof headers?.get === "function" ? headers.get(key) : headers?.[key]) ?? null;
  const own = get(name);
  if (own !== null || !name.startsWith(NEW_HEADER)) return own;
  for (const prefix of LEGACY.headerPrefixes) { const old = get(prefix + name.slice(NEW_HEADER.length)); if (old !== null) return old; }
  return null;
}

/** a header a proxy must strip from untrusted traffic, under either name */
export const isOwnHeader = (name) => {
  const lower = String(name).toLowerCase();
  return lower.startsWith(NEW_HEADER) || LEGACY.headerPrefixes.some((p) => lower.startsWith(p));
};

/** the same headers again under their old names, for a peer that may predate the rename */
export function withLegacyHeaders(headers) {
  const out = { ...headers };
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase().startsWith(NEW_HEADER)) for (const prefix of LEGACY.headerPrefixes.slice(0, 2)) out[prefix + key.slice(NEW_HEADER.length)] = value;
  }
  return out;
}

/** /.well-known/openmausbot/... answers as /.well-known/duskbot/... */
export function fromLegacyPath(pathname) {
  if (typeof pathname !== "string") return pathname;
  if (pathname === "/.well-known/omb-link" || pathname.startsWith("/.well-known/omb-link/")) return "/.well-known/dusk-link" + pathname.slice("/.well-known/omb-link".length);
  return pathname === LEGACY.wellKnown || pathname.startsWith(`${LEGACY.wellKnown}/`)
    ? NEW_WELL_KNOWN + pathname.slice(LEGACY.wellKnown.length)
    : pathname;
}

/** the same well-known path under its old name, to ask a server that predates the rename */
export function toLegacyPath(pathname) {
  if (typeof pathname === "string" && pathname.startsWith("/.well-known/dusk-link")) return "/.well-known/omb-link" + pathname.slice("/.well-known/dusk-link".length);
  return typeof pathname === "string" && pathname.startsWith(NEW_WELL_KNOWN)
    ? LEGACY.wellKnown + pathname.slice(NEW_WELL_KNOWN.length)
    : pathname;
}

/** a server's health answer names it as ours under either name */
export const isOwnAppId = (app) => app === "duskbot" || app === LEGACY.appId;

/** openmausbot://x becomes duskbot://x; anything else is returned as it came */
export function fromLegacyLink(link) {
  if (typeof link !== "string") return link;
  const old = `${LEGACY.protocol}:`;
  return link.slice(0, old.length).toLowerCase() === old ? `${NEW_PROTOCOL}:${link.slice(old.length)}` : link;
}

/** browser storage keys saved under the old prefix, copied once to the new one; the old keys are left in place */
export function migrateLegacyStorage(storage) {
  if (!storage) return 0;
  let copied = 0;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const prefix = key && LEGACY.storagePrefixes.find((p) => key.startsWith(p));
      if (!prefix) continue;
      const next = STORAGE_RENAMES[prefix] + key.slice(prefix.length);
      if (storage.getItem(next) !== null) continue;
      storage.setItem(next, storage.getItem(key));
      copied++;
    }
  } catch {
    // storage that refuses (private mode, quota) keeps the defaults
  }
  return copied;
}

const exists = (fs, p) => { try { return fs.lstatSync(p); } catch { return null; } };
const hasData = (fs, dir) => { try { return fs.readdirSync(dir).length > 0; } catch { return false; } };

/**
 * the one-time move of a folder from its old name to its new one. the old path becomes a link to the new folder, so
 * absolute paths saved inside (engine configs, hooks) and anything still holding the old path keep working. nothing is
 * ever deleted: a new folder that already holds data wins and the old one is left as it was; a new folder made empty
 * (or holding only what was written before this ran: none of the `markers` the old one has) is set aside next to it;
 * a move that fails leaves everything in place and the old folder is used.
 */
export function migrateLegacyDir(next, old, { fs = node("node:fs"), markers = [], now = Date.now, log = () => {} } = {}) {
  const o = exists(fs, old);
  if (!o || o.isSymbolicLink() || !o.isDirectory()) return next;
  if (!hasData(fs, old)) return next;
  const n = exists(fs, next);
  if (n) {
    const holds = (dir) => markers.some((name) => exists(fs, join(dir, name)));
    const fresh = n.isDirectory() && (!hasData(fs, next) || (!holds(next) && holds(old)));
    if (!fresh) return next;
    const aside = `${next}.before-move-${now()}`;
    try { fs.renameSync(next, aside); } catch (error) { log(`legacy move: could not set ${next} aside: ${error?.message ?? error}`); return old; }
  }
  try {
    fs.renameSync(old, next);
  } catch (error) {
    log(`legacy move: kept ${old}: ${error?.message ?? error}`);
    return old;
  }
  try {
    fs.symlinkSync(next, old, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    log(`legacy move: no link at ${old}: ${error?.message ?? error}`);
  }
  log(`legacy move: ${old} -> ${next}`);
  return next;
}

/** the data folder in `home`, moved from its old name on first use */
// never adopts another app's folder (OpenMausBot's ~/.openmausbot): its chats are brought in only when the person asks
export function defaultDataDir(home, _options = {}) {
  return join(home, ".duskbot");
}

/** the data folder a setting names, or the default; a setting naming the default (a container image's) moves the old one too */
export function dataDirFor(configured, home, options = {}) {
  return !configured || configured === join(home, ".duskbot") ? defaultDataDir(home, options) : configured;
}

/** the companion's folder in `home`, moved from its old name on first use */
export function defaultCompanionDir(home, _options = {}) {
  return join(home, ".duskbot-companion");
}

/** a data folder's name, old or new, for lists that keep the bots and syncs out of it */
export const DATA_DIR_NAMES = Object.freeze([".duskbot", LEGACY.dataDirName]);

/**
 * electron's own folder (userData) under its old name, copied once to the new one before electron opens it. a copy, not
 * a move: it holds keychain-sealed files, and an older build started again still finds its own.
 */
/** what only a used app's userData holds; chromium's own caches appear in any folder electron merely opened */
const USER_DATA_MARKERS = ["environments.json", "vps-link.json", "desktop-prefs.json", "window-state.json", "ambient-prefs.json", "credentials.bin", "companion-settings.json"];

export function hasDesktopUserData(dir, fs = node("node:fs")) {
  return USER_DATA_MARKERS.some((name) => exists(fs, join(dir, name)));
}

export function migrateLegacyUserData(next, appData, { fs = node("node:fs"), log = () => {}, packaged = true } = {}) {
  const old = join(appData, packaged ? LEGACY.product : LEGACY.devName);
  const o = exists(fs, old);
  if (!o || !o.isDirectory() || !hasData(fs, old)) return false;
  if (exists(fs, next)) {
    // a folder electron opened before this copy ran (a test run, a first launch) holds only caches: set it aside
    if (hasDesktopUserData(next, fs) || !hasDesktopUserData(old, fs)) return false;
    const aside = `${next}.fresh-${Date.now()}`;
    try { fs.renameSync(next, aside); log(`legacy copy: set aside ${next} -> ${aside}`); }
    catch (error) { log(`legacy copy: kept ${next}: ${error?.message ?? error}`); return false; }
  }
  const staging = `${next}.moving-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(old, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
      // chromium's locks belong to the old folder's running process, never to a copy
      filter: (src) => !/(^|[\\/])(SingletonLock|SingletonSocket|SingletonCookie|lockfile)$/.test(src) });
    fs.renameSync(staging, next);
    log(`legacy copy: ${old} -> ${next}`);
    return true;
  } catch (error) {
    log(`legacy copy: kept ${old}: ${error?.message ?? error}`);
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    return false;
  }
}

/** `security` with args and stdin; blocking on purpose, so the key is in place before chromium first reads it */
const securityCli = (args, input) => node("node:child_process").spawnSync("/usr/bin/security", args, { input, encoding: "utf8", timeout: 60_000 });

/** electron's keychain item for an app called `name` (macOS): "<name> Safe Storage", account "<name> Key" */
export const safeStorageItem = (name) => ({ service: `${name} Safe Storage`, account: `${name} Key` });

/**
 * macOS: the keychain key electron seals files with is named after the app. before electron first uses it, the old
 * key is copied under the new name so files sealed before the rename still open. `run` is `security` with args and
 * stdin. returns what happened.
 */
export function carryLegacySafeStorageKey({ name, packaged = true, run = securityCli, replace = false, from = null, trust = null }) {
  const next = safeStorageItem(name);
  // `from`: the names to copy from, first found wins; `trust`: the app allowed to read the copy without a keychain prompt
  const olds = (from ?? (packaged ? [LEGACY.product, LEGACY.devName] : [LEGACY.devName, LEGACY.product])).map(safeStorageItem);
  const find = (item, reveal) => run(["find-generic-password", "-s", item.service, "-a", item.account, ...(reveal ? ["-w"] : [])]);
  try {
    // `replace`: userData was copied just now, so a key under the new name only sealed the folder that was set aside
    if (!replace && find(next, false).status === 0) return "present";
    for (const old of olds) {
      const read = find(old, true);
      if (read.status !== 0) continue;
      const secret = String(read.stdout ?? "").replace(/\r?\n$/, "");
      if (!secret) continue;
      // through stdin, so the key never shows in a process list
      const quote = (value) => `"${String(value).replace(/["\\]/g, "\\$&")}"`;
      const trusted = trust ? ` -T ${quote(trust)}` : "";
      const add = run(["-i"], `add-generic-password -U -s ${quote(next.service)} -a ${quote(next.account)}${trusted} -w ${quote(secret)}\n`);
      return add.status === 0 ? "copied" : "failed";
    }
    return "none";
  } catch {
    return "failed";
  }
}

/** the name `pnpm dev:app` runs under on macOS, so its keychain key ("duskbot dev Safe Storage") is never the packaged
 * app's ("duskbot Safe Storage"): a key one build made makes the other ask for the login password */
export const devAppName = (name) => `${name} dev`;

/** a file format id from before the rename (openmaus.backup, openmaus.team, ...) read as the current one; the document is copied, never changed.
 * openmaus.package keeps its name: a package's release sha256 is over its canonical bytes, format id included. */
export function withCurrentFormat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.format !== "string" || !value.format.startsWith("openmaus.") || value.format === "openmaus.package") return value;
  return { ...value, format: `dusk.${value.format.slice("openmaus.".length)}` };
}

/** tokens and cookies minted while the product was called omb start omb_<kind>_; both are read, only dusk_ is minted */
export const hasTokenPrefix = (value, kind) =>
  typeof value === "string" && (value.startsWith(`dusk_${kind}_`) || value.startsWith(`omb_${kind}_`));

/** omb_* cookies a browser still holds read as dusk_*; one already sent under the new name wins. */
export function aliasLegacyCookies(headers) {
  if (!headers || typeof headers.cookie !== "string" || !headers.cookie.includes("omb_")) return headers;
  const parts = headers.cookie.split(";").map((part) => part.trim());
  const names = new Set(parts.map((part) => part.slice(0, part.indexOf("="))));
  headers.cookie = parts.map((part) => {
    const name = part.slice(0, part.indexOf("="));
    if (!name.startsWith("omb_") || names.has(`dusk_${name.slice(4)}`)) return part;
    return `dusk_${name.slice(4)}${part.slice(name.length)}`;
  }).join("; ");
  return headers;
}

if (typeof process !== "undefined" && process?.env) aliasLegacyEnv(process.env);
// a page: its saved preferences from before the rename, before anything reads them
if (typeof window !== "undefined") { try { migrateLegacyStorage(window.localStorage); } catch {} }
