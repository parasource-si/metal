// This computer's page with no bots of its own, while the person's live somewhere else (the server they moved to, My
// Cloud, a team's Cloud, a server they linked): the page says where they are and opens that place, never a blank first
// run. Signed in, the place is also noted for the account (account-setup-store.mjs), so a fresh install of the same
// account says "You already set up Metal on …" and offers to connect.

import { BACKGROUND_HEADERS } from "./cloud-power.mjs";

const RANK = { moved: 0, cloud: 1, team: 2, server: 3 };
/** The id of My Cloud while it is home and saved as no place of its own. */
export const CLOUD_HOME_ID = "cloud";

/**
 * The places that hold the person's bots, the likeliest first: the server they moved to, My Cloud, a team's Cloud, then a
 * server saved by hand; one that went missing comes last.
 * @param {{ environments?: any[], moved?: { id: string, origin: string } | null, cloudOrigin?: string | null }} where
 * @returns {{ id: string, name: string, why: "moved" | "cloud" | "team" | "server" }[]}
 */
export function placesElsewhere({ environments = [], moved = null, cloudOrigin = null }) {
  const why = (entry) => (moved && (entry.id === moved.id || entry.origin === moved.origin) ? "moved"
    : entry.origin === cloudOrigin || entry.home || entry.cloud ? "cloud" : entry.team ? "team" : "server");
  const places = environments
    .filter((entry) => entry?.kind === "remote" && typeof entry.id === "string" && typeof entry.origin === "string" && typeof entry.name === "string" && entry.name.trim())
    .map((entry, index) => ({ id: entry.id, name: entry.name.trim().slice(0, 80), why: why(entry), index, missing: entry.missing === true }))
    .sort((a, b) => Number(a.missing) - Number(b.missing) || RANK[a.why] - RANK[b.why] || a.index - b.index)
    .map(({ id, name, why: reason }) => ({ id, name, why: reason }));
  if (cloudOrigin && !environments.some((entry) => entry?.origin === cloudOrigin)) places.unshift({ id: CLOUD_HOME_ID, name: "My Cloud", why: "cloud" });
  return places;
}

/** The person's own bots in a JSON answer of GET /api/bots: dusk, the helper every place gets, and bots off the sidebar
 * don't count. Null for anything else. */
export function ownBotCount(body) {
  return Array.isArray(body?.bots) ? body.bots.filter((bot) => bot && typeof bot === "object" && !bot.defaultBot && !bot.hidden).length : null;
}

/**
 * How many bots each saved place has, asked as the signed-in person with main's own session. A Cloud said to be asleep is
 * never asked (that would wake it), and a place that can't say is left out rather than guessed.
 * @param {{ places: Array<{ id: string, origin: string }>, fetch: (url: string, init?: RequestInit) => Promise<Response>,
 *   asleep?: (origin: string) => boolean, headers?: Record<string, string>, timeoutMs?: number }} input
 * @returns {Promise<Record<string, number>>}
 */
export async function readBotCounts({ places, fetch, asleep = () => false, headers = BACKGROUND_HEADERS, timeoutMs = 8_000 }) {
  const counts = {};
  await Promise.all(places.filter((place) => typeof place?.origin === "string" && !asleep(place.origin)).map(async (place) => {
    try {
      const response = await fetch(`${place.origin}/api/bots?messages=0`, { headers, credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      const count = response?.ok ? ownBotCount(await response.json().catch(() => null)) : null;
      if (count !== null) counts[place.id] = count;
    } catch { /* unreachable or signed out: no count */ }
  }));
  return counts;
}

/**
 * Whether the person has picked where this app opens at least once: a place, or this computer itself. Until then this
 * computer's empty page offers the places; after, it never stands in the way again.
 * @param {{ read: () => any, write: (value: any) => void }} file
 */
export function placesChosenStore(file) {
  let known = null;
  return {
    chosen() {
      if (known === null) { try { known = file.read()?.chosen === true; } catch { known = false; } }
      return known;
    },
    choose() {
      if (known === true) return;
      known = true;
      try { file.write({ chosen: true }); } catch { /* kept for this run */ }
    },
  };
}

/** What the account remembers of a place: a team's Cloud comes with the sign-in itself, so it is not noted. */
const setupOf = (place, at) => (place.why === "team" ? null : { kind: place.why === "cloud" ? "cloud" : "server", name: place.name, at });

/**
 * @param {{ ipcMain: any, guard: (channel: string, handler: Function) => Function, places: () => ReturnType<typeof placesElsewhere>,
 *   account: () => { id?: string } | null, store: import("./account-setup-store.mjs").AccountSetupStore,
 *   open: (id: string) => unknown, connectCloud: () => unknown, counts?: () => Promise<Record<string, number>>,
 *   chosen?: ReturnType<typeof placesChosenStore>, now?: () => number, log?: (line: string) => void }} deps `counts()`: each saved place's bots, by its id (readBotCounts).
 * `account()`: the signed-in account, null when there is none. `open(id)`: main's own switch to a saved place (or My Cloud
 * as home), settled once the window has gone there or stayed, false (or a throw) when it didn't open; `connectCloud()`: main's connect to My Cloud from the verified session, never a renderer's address.
 */
export function installBotsElsewhere({ ipcMain, guard, places, account, store, open, connectCloud, counts = async () => ({}), chosen = { chosen: () => false, choose: () => {} }, now = Date.now, log = () => {} }) {
  const signedIn = () => { const id = account()?.id; return typeof id === "string" && id ? id : null; };

  /** Notes the likeliest place for the signed-in account, once it is known here. */
  async function remember() {
    const id = signedIn(), setup = id ? places().map((place) => setupOf(place, now())).find(Boolean) : null;
    if (!setup) return;
    try { await store.remember(id, setup); } catch (error) { log(`bots elsewhere: ${error?.message ?? error}`); }
  }

  async function view() {
    const list = places();
    await remember();
    const id = signedIn();
    const known = id && !list.length ? await store.read(id).catch(() => null) : null;
    return { places: list, known: known ? { kind: known.kind, name: known.name } : null, chosen: chosen.chosen() };
  }

  ipcMain.handle("elsewhere:state", guard("elsewhere:state", () => view()));
  // answered once the switch is over: a page still there to hear it was not taken anywhere, so it shows itself again,
  // and one that was never hears it, so this computer's own page never shows in between. false: the place didn't open
  // (unknown, unreachable, or the switch said no), so the page can say so under its row.
  ipcMain.handle("elsewhere:open", guard("elsewhere:open", async (_event, id) => {
    if (typeof id !== "string" || !places().some((place) => place.id === id)) return false;
    try {
      const opened = (await open(id)) !== false;
      if (opened) chosen.choose();
      return opened;
    } catch (error) { log(`bots elsewhere: ${error?.message ?? error}`); return false; }
  }));
  // this computer, picked on the page itself: it opens here from now on and the page stops offering the places
  ipcMain.handle("elsewhere:stay", guard("elsewhere:stay", () => { chosen.choose(); return true; }));
  ipcMain.handle("elsewhere:counts", guard("elsewhere:counts", () => counts().catch(() => ({}))));
  // "server": the page opens its own Add your VPS sheet; a Cloud connects from the session main holds, answered once over
  ipcMain.handle("elsewhere:connect", guard("elsewhere:connect", async () => {
    const id = signedIn(), known = id ? await store.read(id).catch(() => null) : null;
    if (!known) return null;
    chosen.choose();
    if (known.kind === "cloud") { try { await connectCloud(); } catch (error) { log(`bots elsewhere: ${error?.message ?? error}`); } }
    return known.kind;
  }));

  return { view, remember };
}
