// bots.json and groups.json are the only index of a person's bots: an empty list there reads as a fresh install, and the
// first save (seeding Metal) would write over whatever was unreadable. So a good read leaves a copy beside the file,
// and a bad one sets the file aside and comes back from that copy.
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { writeFileAtomicIfChanged } from "./atomic.ts";

export const lastGoodPath = (file: string) => `${file}.last-good`;

/** These copies hold the whole list (a team member's private bots) or the raw config (keys): no backup carries them. */
export const isSafetyCopy = (name: string) =>
  /^(?:bots|groups)\.json\.(?:last-good|unreadable-\d+)$/.test(name) || /^config\.json\.unreadable-\d+$/.test(name);

/** Copies a file that could not be read beside itself before anything writes over it; where it went, or undefined. */
export function setAsideUnreadable(file: string, now = Date.now): string | undefined {
  const aside = `${file}.unreadable-${now()}`;
  try {
    copyFileSync(file, aside);
    try { chmodSync(aside, 0o600); } catch { /* windows */ }
    return aside;
  } catch {
    return undefined;
  }
}

export type RegistryRead<T> =
  | { state: "loaded"; records: T[]; text: string }
  | { state: "missing"; records: [] }
  /** `setAside` is where the unreadable file was copied, when it could be. */
  | { state: "recovered" | "unreadable"; records: T[]; setAside?: string };

function parse<T>(text: string): T[] | null {
  try {
    const records: unknown = JSON.parse(text);
    return Array.isArray(records) ? (records as T[]) : null;
  } catch {
    return null;
  }
}

export function readRegistryFile<T>(file: string, { now = Date.now, log = console.error }: { now?: () => number; log?: (line: string) => void } = {}): RegistryRead<T> {
  let text: string | null = null;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", records: [] };
  }
  const records = text === null ? null : parse<T>(text);
  if (text !== null && records) {
    try {
      writeFileAtomicIfChanged(lastGoodPath(file), text, { mode: 0o600 });
    } catch (error) {
      log(`[store] could not keep a copy of ${file}: ${(error as Error).message}`);
    }
    return { state: "loaded", records, text };
  }
  const setAside = setAsideUnreadable(file, now);
  let backup: T[] | null = null;
  try {
    backup = parse<T>(readFileSync(lastGoodPath(file), "utf8"));
  } catch {
  }
  log(`[store] ${file} could not be read${setAside ? `; kept it as ${setAside}` : ""}${backup ? "; using its last good copy" : ""}`);
  return backup ? { state: "recovered", records: backup, setAside } : { state: "unreadable", records: [], setAside };
}
