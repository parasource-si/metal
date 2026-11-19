// a source checkout's server signs in to configured OAuth apps (shared/native-connectors.json) with the clients in
// the operator's secrets file, as a release bakes them in; without them every one-click sign-in reads as not set up.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { NATIVE_CLIENT_ENVS } from "../shared/native-connectors.ts";

/** The native client values `text` (a dusk.env) sets that `env` lacks: only those names, never anything else. */
export function nativeClientsFrom(text: string, env: NodeJS.ProcessEnv, names: readonly string[] = NATIVE_CLIENT_ENVS): Record<string, string> {
  const wanted = new Set(names.filter((name) => !env[name]?.trim()));
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || !wanted.has(m[1]!)) continue;
    const value = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) found[m[1]!] = value;
  }
  return found;
}

/** Fills the missing native client names from DUSK_ENV or ~/.config/duskbot/dusk.env, when that file is there. */
export function loadDevNativeClients(env: NodeJS.ProcessEnv = process.env): number {
  let text: string;
  try {
    text = readFileSync(env.DUSK_ENV || join(homedir(), ".config/duskbot/dusk.env"), "utf8");
  } catch {
    return 0;
  }
  const found = nativeClientsFrom(text, env);
  Object.assign(env, found);
  return Object.keys(found).length;
}
