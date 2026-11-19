import { mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

type IsBot = (id: string) => boolean;

/** Security invariant: a bot's own folder (`workspaces/<bot>`) and a chat's (`task-workspaces/<bot>/<thread>`) always
 * resolve inside the running data dir. A stored path to one, written by another data dir (a copied, imported, moved or
 * restored workspace), maps here and is never followed into that other data dir. Undefined for any other path. */
export function rebaseOwnFolder(path: string | null | undefined, dataDir: string, isBot: IsBot): string | undefined {
  const parts = (path ?? "").split(/[\\/]+/).filter(Boolean);
  for (let at = 0; at < parts.length - 1; at++) {
    const [top, bot, thread] = [parts[at], parts[at + 1]!, parts[at + 2]];
    if (!ID.test(bot) || !isBot(bot)) continue;
    const own = top === "task-workspaces" ? (thread && ID.test(thread) ? 3 : 0) : top === "workspaces" ? 2 : 0;
    if (!own) continue;
    const rest = parts.slice(at + own);
    return rest.some((part) => part === "." || part === "..") ? undefined : join(dataDir, ...parts.slice(at, at + own), ...rest);
  }
  return undefined;
}

function samePath(a: string, b: string): boolean {
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return real(a) === real(b);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function looksLikeDataDir(dir: string): boolean {
  return Boolean(statSync(join(dir, "bots.json"), { throwIfNoEntry: false })?.isFile()
    && ["workspaces", "task-workspaces"].some((name) => statSync(join(dir, name), { throwIfNoEntry: false })?.isDirectory()));
}

/** Security invariant: the Metal data dir that holds `path`, when it is not the running one. */
export function foreignDataDir(path: string, dataDir: string): string | undefined {
  const full = resolve(path);
  if (inside(full, resolve(dataDir))) return undefined;
  for (let dir = full; ; dir = dirname(dir)) {
    if (looksLikeDataDir(dir)) return samePath(dir, dataDir) ? undefined : dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** A folder the person picked that a turn cannot use: gone, not a folder, or inside another data dir. */
export function pickedFolderLost(path: string, dataDir: string): boolean {
  return !statSync(path, { throwIfNoEntry: false })?.isDirectory() || foreignDataDir(path, dataDir) !== undefined;
}

/** A turn's folder settled against the running data dir: an own folder rebased and created, or, for a picked folder
 * the turn cannot use, `fallback` with the lost folder's name for the bot to hear once. */
export type SettledFolder = { cwd: string; changed: boolean; lost?: string };

export function settleFolder(path: string, dataDir: string, isBot: IsBot, fallback: string | undefined): SettledFolder {
  const own = rebaseOwnFolder(path, dataDir, isBot);
  if (own) {
    mkdirSync(own, { recursive: true, mode: 0o700 });
    return { cwd: own, changed: own !== path };
  }
  if (fallback === undefined || !pickedFolderLost(path, dataDir)) return { cwd: path, changed: false };
  return { cwd: fallback, changed: true, lost: basename(path) || path };
}

/** The folder a chat turn runs in, when it must change before the turn: its stored folder (or, for a chat not pinned
 * yet, its bot's) rebased onto this data dir, or the chat's own folder in place of a picked folder that is lost. */
export function settleChatFolder(input: { stored: string | null | undefined; botCwd?: string; botId: string; threadId: string;
  dataDir: string; isBot: IsBot; worksInFolders: boolean }): SettledFolder | undefined {
  const path = input.stored === undefined ? input.botCwd : input.stored;
  if (!path) return undefined;
  const own = join(input.dataDir, "task-workspaces", input.botId, input.threadId);
  const settled = settleFolder(path, input.dataDir, input.isBot, input.worksInFolders ? own : undefined);
  if (input.stored === undefined && !settled.lost) return undefined;
  return settled.changed ? settled : undefined;
}

type FolderHolder = { cwd?: string | null; pinnedCwd?: string | null };

/** Rebases every stored own-folder path onto this data dir; true when a record changed. */
export function rebaseStoredFolders(records: ReadonlyArray<FolderHolder & { tasks?: FolderHolder[] }>, dataDir: string, isBot: IsBot): boolean {
  let changed = false;
  const fix = (holder: FolderHolder & { resumeCursors?: Record<string, unknown> }) => {
    for (const key of ["cwd", "pinnedCwd"] as const) {
      const own = rebaseOwnFolder(holder[key], dataDir, isBot);
      if (!own || own === holder[key]) continue;
      holder[key] = own;
      if (holder.resumeCursors) holder.resumeCursors = {};
      changed = true;
    }
  };
  for (const record of records) { fix(record); for (const task of record.tasks ?? []) fix(task); }
  return changed;
}
