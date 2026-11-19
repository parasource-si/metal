// Where a signed-in account set Metal up (a server of its own, My Cloud), so another install of the same account
// can say "You already set up Metal on …" instead of starting over. One interface, two sides: this computer's own
// record now, and the account's record on our side once that database exists (remoteAccountSetupStore is its stub).
//
// Only a hash of the account's id is kept here, never its email or token.
import { createHash } from "node:crypto";

/** @typedef {{ kind: "server" | "cloud", name: string, at: number }} AccountSetup */
/** @typedef {{ read(accountId: string): Promise<AccountSetup | null>, remember(accountId: string, setup: AccountSetup): Promise<boolean> }} AccountSetupStore */

const KINDS = new Set(["server", "cloud"]);
const MAX_ACCOUNTS = 20;

export const accountSetupKey = (accountId) => createHash("sha256").update(`omb-account-setup:${accountId}`).digest("hex").slice(0, 32);

/** A setup read back or about to be written; null when it is not one. */
export function parseSetup(value) {
  if (!value || typeof value !== "object" || !KINDS.has(value.kind)) return null;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 80) : "";
  const at = Number.isFinite(value.at) ? value.at : 0;
  return name ? { kind: value.kind, name, at } : null;
}

const validId = (accountId) => typeof accountId === "string" && accountId.length > 0 && accountId.length <= 200;

/**
 * This computer's record, in the app's own folder: it outlives a reinstall of the app, not a new computer.
 * @param {{ read(): unknown, write(value: unknown): void }} file
 * @returns {AccountSetupStore}
 */
export function localAccountSetupStore(file) {
  const load = () => {
    try { const kept = file.read(); return kept?.v === 1 && kept.accounts && typeof kept.accounts === "object" ? kept.accounts : {}; } catch { return {}; }
  };
  return {
    async read(accountId) {
      return validId(accountId) ? parseSetup(load()[accountSetupKey(accountId)]) : null;
    },
    async remember(accountId, setup) {
      const next = parseSetup(setup);
      if (!validId(accountId) || !next) return false;
      const accounts = load(), key = accountSetupKey(accountId), kept = parseSetup(accounts[key]);
      if (kept && kept.kind === next.kind && kept.name === next.name) return false;
      const others = Object.entries(accounts).filter(([other]) => other !== key).slice(-(MAX_ACCOUNTS - 1));
      file.write({ v: 1, accounts: Object.fromEntries([...others, [key, next]]) });
      return true;
    },
  };
}

/**
 * The account's record on our side, for a new computer. Not built yet: it reads nothing and keeps nothing, and the
 * combined store works the same once it does.
 * @returns {AccountSetupStore}
 */
export function remoteAccountSetupStore() {
  return {
    async read() { return null; },
    async remember() { return false; },
  };
}

/**
 * This computer's record first, then the account's; a setup found only on our side is kept here too.
 * @param {{ local: AccountSetupStore, remote: AccountSetupStore, log?: (line: string) => void }} sides
 * @returns {AccountSetupStore}
 */
export function accountSetupStore({ local, remote, log = () => {} }) {
  const quiet = (work, fallback) => work.catch((error) => { log(`account setup: ${error?.message ?? error}`); return fallback; });
  return {
    async read(accountId) {
      const here = await quiet(local.read(accountId), null);
      if (here) return here;
      const there = parseSetup(await quiet(remote.read(accountId), null));
      if (there) await quiet(local.remember(accountId, there), false);
      return there;
    },
    async remember(accountId, setup) {
      const [here] = await Promise.all([quiet(local.remember(accountId, setup), false), quiet(remote.remember(accountId, setup), false)]);
      return here;
    },
  };
}
