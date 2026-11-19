// Bringing the person's bots from a server of their own back to this computer: the one this computer moved them to
// (linked through the link service or saved by hand), or, while this computer has no bots of its own, any saved server
// that says it is theirs alone. The server is paused first, then copied whole into a backup this app keeps, which then
// replaces this computer's workspace; a backup of this computer is saved before that.
//
// Security and safety: the server is never written to beyond its pause, and its copy is never deleted, so it keeps
// everything until the person removes it there. A server is only read over this window's own sign-in there, and only
// one that says that sign-in is its one owner's. This computer's own bots are never replaced: with bots of its own
// (or while they moved somewhere else) bringing bots here is refused.
import { ownBotCount } from "./bots-elsewhere.mjs";

/** The steps a move back goes through, in order. */
export const BACK_STEPS = Object.freeze(["check", "backup-here", "pause", "copy", "restore"]);

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SERVER_REFUSALS = {
  signed_out: (name) => `This app isn't signed in to ${name}. Open ${name} in this app, then try again.`,
  not_own: (name) => `${name} has other people on it, so its bots can't come to this computer.`,
  other_server: (name) => `The server at ${name}'s address is another one now, so nothing comes from it.`,
};
const refused = (code, name) => Object.assign(new Error(SERVER_REFUSALS[code](name)), { code });

/**
 * @param {{
 *   link(): { id: string, envId?: string, origin?: string, name: string } | null,
 *   viaLink(link: any): Promise<{ freeze(place: string): Promise<unknown>, thaw(): Promise<unknown> }>,
 *   away(): boolean,
 *   home(): { id: string, origin: string, name: string, environmentId?: string } | null,
 *   moving(): boolean,
 *   places(): any[],
 *   who(place: { origin: string }): Promise<{ signedIn: boolean, own: boolean, environmentId: string | null }>,
 *   serverCall(from: { origin: string, name: string }, method: string, route: string, body?: unknown): Promise<any>,
 *   local(method: string, route: string, body?: unknown): Promise<any>,
 *   backupHere(): Promise<unknown>,
 *   backupFrom(from: { origin: string, name: string }, onBytes: (done: number, total: number | null) => void): Promise<any>,
 *   restoreFile(entry: any): Promise<void>,
 *   label(): string,
 *   finish(): void,
 *   onChange(): void,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `link()`: the server linked through the link service, if any; `viaLink` pauses it through its agent. `places()`:
 * the saved places; only ones saved by hand are read. `who`: a server's word on this window's sign-in there
 * (own-home-main.mjs serverRequests). `finish()`: forgets the move to the server and restarts this app on what came back.
 */
export function createMoveBack(deps) {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  let current = null;
  const set = (patch) => { current = { ...current, ...patch, updatedAt: now() }; deps.onChange(); };

  const linkFor = (place) => { const link = deps.link(); return link?.origin && (link.envId === place.id || link.origin === place.origin) ? link : null; };
  const handSavedPlaces = () => deps.places().filter((entry) => record(entry) && entry.kind === "remote" && typeof entry.origin === "string" && !entry.home && !entry.team && !entry.cloud);

  /** Why this computer can't take bots from a server it never moved its own to; null when it can. */
  async function blockedHere() {
    if (deps.moving()) return "moving";
    const frozen = await deps.local("GET", "/api/move/freeze").then((got) => got?.frozen === true).catch(() => false);
    if (frozen) return "moved";
    const count = ownBotCount(await deps.local("GET", "/api/bots?messages=0").catch(() => null));
    if (count === null) return "unknown";
    return count > 0 ? "own-bots" : null;
  }

  /** The servers bots may come back from now, and why none may when the answer is no. */
  async function sources() {
    if (deps.away()) { const home = deps.home(); return { places: home ? [{ id: home.id, name: home.name }] : [], blocked: null }; }
    const places = handSavedPlaces().map((place) => ({ id: place.id, name: place.name }));
    if (!places.length) return { places, blocked: null };
    return { places, blocked: await blockedHere() };
  }

  async function source(placeId) {
    if (deps.away()) {
      const home = deps.home();
      if (!home) throw new Error("The server your bots moved to isn't in this app any more. Add it again, then try again.");
      if (placeId && placeId !== home.id) throw new Error(`Your bots are on ${home.name}. Bring them back from there.`);
      return home;
    }
    const place = handSavedPlaces().find((entry) => entry.id === placeId);
    if (!place) throw new Error("That server isn't in this app any more.");
    const blocked = await blockedHere();
    if (blocked === "own-bots") throw new Error(`This computer has bots of its own, so bots from ${place.name} can't replace them. Move or remove the bots here first.`);
    if (blocked === "moved") throw new Error("This computer's bots moved somewhere else. Bring them back from there first.");
    if (blocked === "moving") throw new Error("Your bots are moving right now. Try again once that's done.");
    if (blocked === "unknown") throw new Error("Metal on this computer did not answer. Try again in a moment.");
    return { id: place.id, origin: place.origin, name: place.name };
  }

  /** The server's pause and its lifting: through the link agent when the server is linked, else over the owner's sign-in. */
  async function pauser(from) {
    const link = linkFor(from);
    if (link) return deps.viaLink(link);
    const who = await deps.who(from);
    if (!who.signedIn) throw refused("signed_out", from.name);
    if (from.environmentId && who.environmentId !== from.environmentId) throw refused("other_server", from.name);
    if (!who.own) throw refused("not_own", from.name);
    return {
      async freeze(place) {
        try { await deps.serverCall(from, "POST", "/api/move/freeze", { place }); }
        catch (error) {
          if (error?.status === 409) throw new Error(`A bot on ${from.name} is still working. Try again once it's done.`);
          if (error?.status === 403) throw new Error(`Update Metal on ${from.name} first, then try again.`);
          throw error;
        }
      },
      thaw: () => deps.serverCall(from, "DELETE", "/api/move/freeze", {}),
    };
  }

  async function run(placeId) {
    if (current?.status === "running") throw new Error("Your bots are already coming back.");
    current = null;
    set({ step: "check", status: "running", name: null, startedAt: now() });
    let paused = null;
    try {
      const from = await source(placeId);
      set({ name: from.name });
      const pause = await pauser(from);
      set({ step: "backup-here" });
      await deps.backupHere().catch((error) => {
        log(`move back: no backup of this computer before moving back (${error?.message ?? error})`);
        throw new Error("A backup of this computer could not be saved first, so nothing was moved.");
      });
      set({ step: "pause" });
      await pause.freeze(deps.label());
      paused = pause;
      set({ step: "copy" });
      const entry = await deps.backupFrom(from, (done, total) => set({ bytes: { done, ...(total === null ? {} : { total }) } }));
      set({ step: "restore", bytes: undefined });
      await deps.restoreFile(entry);
    } catch (error) {
      if (paused) await paused.thaw().catch((thawError) => log(`move back: the server stays paused (${thawError?.message ?? thawError})`));
      const message = typeof error?.message === "string" && error.message.trim() && error.message.length < 300 ? error.message.trim() : "Your bots could not come back. They are still on your server.";
      set({ status: "failed", error: message });
      throw Object.assign(new Error(message), { cause: error });
    }
    set({ status: "done" });
    deps.finish();
    return { ok: true };
  }

  return {
    run,
    sources,
    /** The move back under way or just ended, for the page. */
    view: () => (current ? { step: current.step, status: current.status, ...(current.name ? { name: current.name } : {}), ...(current.bytes ? { bytes: current.bytes } : {}), ...(current.error ? { error: current.error } : {}) } : null),
    clear() { if (current?.status !== "running") { current = null; deps.onChange(); } },
  };
}
