// What an engine's own file tools may touch on a host where the bot box is off, and inside it as a second line: the
// server's data folder minus this bot's own folders, the server's SSH keys and app settings, and Metal's other
// install folders. The bot box (server/bot-box) is the real boundary; these rules are what the engines enforce themselves.
import { DATA_DIR_NAMES, LEGACY } from "../../electron/legacy-names.mjs";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { boxUploadsDir, taskWorkspaceIds, under } from "../bot-box/plan.ts";
import { spillDir } from "../mcp-gate-config.ts";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Hidden even before they exist, so a warm engine process does not miss one made after it started. */
const ALWAYS_HIDDEN_DATA = ["config.json", "messages.db", "runtime.db", "bots.json", "engine-homes", "providers", "ssh", "people", "browser"];
// a server installed before the rename keeps its old folder names until its installer runs again
const INSTALL_FAMILIES = ["duskbot", LEGACY.devName].flatMap((name) => [["/var/lib", name], ["/etc", name], ["/run", name]] as const);

export interface ReadScopeInput {
  dataDir: string;
  home: string;
  cwd: string;
  botId?: string;
  threadId: string;
  /** The turn runs in the bot box, which hides the data folder: uploads reach it through the conversation's folder. */
  boxed: boolean;
  /** More folders the turn reads: lent read-only skills, the person's own skills. */
  extraReadable?: readonly string[];
}

export interface EngineReadScope {
  /** Files and folders (with everything below) no engine file tool may read or change. */
  hidden: string[];
  /** Folders besides the working folder the turn reads. */
  readable: string[];
  /** Readable but never written: the bot's standing instructions. */
  readOnly: string[];
  /** Readable folders filled during the turn, which must exist before it starts. */
  missing: string[];
}

const children = (path: string): string[] => {
  try { return readdirSync(path).map((name) => join(path, name)); } catch { return []; }
};

/** `root` whole, or, when it holds a kept path, each of its entries that holds none, down to the kept ones. A root inside
 * a kept path (a working folder that is HOME) stays hidden. */
function around(root: string, keep: readonly string[]): string[] {
  if (keep.includes(root)) return [];
  if (!keep.some((path) => under(path, root))) return [root];
  return children(root).flatMap((child) => around(child, keep));
}

export function engineReadScope(input: ReadScopeInput): EngineReadScope {
  const dataDir = resolve(input.dataDir), home = resolve(input.home), cwd = resolve(input.cwd);
  const ids = taskWorkspaceIds(cwd, dataDir);
  const botId = input.botId && ID.test(input.botId) ? input.botId : ids?.botId;
  const own = botId ? join(dataDir, "workspaces", botId) : null;
  const soul = botId ? join(dataDir, "bots", botId) : null;
  const uploads = ids ? boxUploadsDir(dataDir, ids.botId, ids.threadId) : null;
  const spill = resolve(spillDir(input.threadId));
  const shared = ["skills-library", "imported-skills"].map((name) => join(dataDir, name));
  const unboxedOnly = input.boxed ? [] : [join(dataDir, "attachments"), spill, ...shared.filter((dir) => existsSync(dir))];
  const granted = [...new Set([
    ...(own ? [own] : []),
    ...(uploads && (input.boxed || existsSync(uploads)) ? [uploads] : []),
    ...unboxedOnly,
    ...(input.extraReadable ?? []).map((path) => resolve(path)),
  ])];
  const readable = granted.filter((path) => !under(path, cwd));
  const readOnly = soul ? [soul] : [];
  const keep = [cwd, ...granted, ...readOnly, ...shared, join(dataDir, "claude-user-skills"),
    ...(botId ? [join(dataDir, "task-workspaces", botId)] : [])];

  const roots = [
    ...new Set([...children(dataDir), ...ALWAYS_HIDDEN_DATA.map((name) => join(dataDir, name))]),
    join(home, ".ssh"),
    join(home, ".config"),
    ...[...DATA_DIR_NAMES.map((name) => [home, name]), [home, ".opengrokbot"], ...INSTALL_FAMILIES].flatMap(([parent, prefix]) =>
      children(parent!).filter((path) => basename(path).startsWith(prefix!))),
  ];
  const missing = (input.boxed ? [uploads] : [spill]).filter((dir): dir is string => dir !== null && readable.includes(dir) && !existsSync(dir));
  return { hidden: [...new Set(roots.flatMap((root) => around(root, keep)))], readable, readOnly, missing };
}

/** A path in Claude Code's permission rule form: `//` is the filesystem root, Windows drives as `//c/...`, glob
 * characters escaped (Claude Code matches rules gitignore-style). */
export function claudeRulePath(path: string, platform: NodeJS.Platform = process.platform): string {
  const posix = platform === "win32"
    ? path.replace(/^([A-Za-z]):[\\/]?/, (_, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/")
    : path;
  return `/${posix.replace(/[*?[\]\\]/g, (char) => `\\${char}`)}`;
}

/** Deny rules for Claude Code: deny wins over any allow, including one from the bot's own settings. */
export function claudeDenyRules(scope: EngineReadScope, platform: NodeJS.Platform = process.platform): string[] {
  const rules: string[] = [];
  for (const path of scope.hidden) {
    const rule = claudeRulePath(path, platform);
    rules.push(`Read(${rule})`, `Read(${rule}/**)`, `Edit(${rule})`, `Edit(${rule}/**)`);
  }
  for (const path of scope.readOnly) {
    const rule = claudeRulePath(path, platform);
    rules.push(`Edit(${rule})`, `Edit(${rule}/**)`);
  }
  return rules;
}

export const CODEX_WORKSPACE_PROFILE = "dusk-workspace";

/** A Codex 0.167 `[permissions.<id>.filesystem]` table: the whole disk readable, the workspace roots and temp folders
 * writable, the hidden paths not even listable. The narrower entry wins. */
export function codexWorkspaceFilesystem(scope: EngineReadScope): Record<string, "read" | "write" | "none"> {
  return {
    ":root": "read",
    ":workspace_roots": "write",
    ":tmpdir": "write",
    ":slash_tmp": "write",
    ...Object.fromEntries(scope.hidden.map((path) => [path, "none" as const])),
  };
}
