// The one-time move from a server of the person's own (their VPS) straight to their own Cloud, run by this app with no
// stop on this computer: the same move (one-home.mjs over cloud-send.mjs) the Mac runs to My Cloud, with the VPS as the
// side things come from. This app reads the VPS over this window's own sign-in there (its one owner's) and writes to My
// Cloud over an owner session from the Admin's one-time code; nothing is kept on this computer's server, and nothing on the
// VPS is ever deleted. Phases, safety and rollback are one-home.mjs's: copy while the VPS keeps working, wait for a quiet
// moment, freeze the VPS (its owner's session may: server/routes/move-freeze.ts), the final pass, the check, then the
// switch; any failure before the switch lifts the freeze and tries again later.
//
// What can't go this way: saved logins, 1Password and the keys of connected apps leave a server only over the desktop
// app's private utility port (server/login-handoff.ts), which a VPS doesn't have. They stay on the VPS, are counted as
// refused for good (so the move goes on without them), and the done line says to connect them again on dusk cloud.
//
// When the direct path can't run (a VPS too old to be frozen by its owner, or one that keeps failing on its own side)
// and this computer's bots are the ones that moved to that VPS (`viaMac.available`), the move falls back by itself to
// bringing them back to this computer first (vps-link.mjs moveBack, which keeps a backup of both), then this computer's
// own move to My Cloud (one-home-main.mjs), as one flow.
import { createCloudSend } from "./cloud-send.mjs";
import { openOwnerSession } from "./cloud-send-main.mjs";
import { awayIn, createOneHome, parseJournal } from "./one-home.mjs";
import { freezeAnswer } from "./one-home-main.mjs";
import { handSaved, serverRequests } from "./own-home-main.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ORIGIN = /^https?:\/\/[^/\s]+$/u;
const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ").slice(0, 300) : null);
export const MOVE_LABEL = "Move from your server to My Cloud";
/** A direct move whose own side (the VPS) failed this many times in a row goes via this computer instead. */
export const FALLBACK_AFTER = 2;
/** The failure codes that are the VPS's own, so going via this computer may help: never My Cloud's, which it wouldn't. */
const VPS_SIDE = new Set(["local", "freeze"]);

/** What stays on the VPS, in the person's words. */
export const staysLine = (name) => `Saved logins, 1Password and app keys stay on ${name}. Connect them again on dusk cloud.`;

/** The person's choice, read back; null when there is none or it is damaged. */
export function parseVpsChoice(value) {
  if (!record(value) || value.v !== 1 || typeof value.id !== "string" || typeof value.origin !== "string" || !ORIGIN.test(value.origin)
    || typeof value.environmentId !== "string" || !ENVIRONMENT_ID.test(value.environmentId) || typeof value.name !== "string" || !value.name.trim()) return null;
  return { ...value, route: value.route === "via-mac" ? "via-mac" : "direct" };
}

/** The VPS's own word: this window's sign-in is its one owner's, which server it is, and whether its owner may freeze it. */
export async function vpsWho(place, fetchImpl) {
  const server = serverRequests(place, fetchImpl);
  const [who, described] = await Promise.all([server.who(), server.request("GET", "/.well-known/duskbot/environment").then(async (response) => {
    try { return await response.json(); } catch { return null; }
  })]);
  return { ...who, direct: who.own && Number(described?.capabilities?.moveOut) >= 1 };
}

/** The VPS as the move's source: this window's own sign-in there, at the server chosen, and still its owner's. */
function vpsSide(chosen, fetchImpl) {
  const server = serverRequests(chosen, fetchImpl);
  const answer = async (response) => {
    const text = await response.text();
    try { return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null }; }
    catch { return { ok: response.ok, status: response.status, body: null }; }
  };
  const call = async (method, route, body) => answer(await server.request(method, route, body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return {
    request: server.request,
    call,
    async json(route) {
      const got = await call("GET", route);
      if (!got.ok) throw Object.assign(new Error(`${chosen.name} did not answer. Try again in a moment.`), { code: "local", status: got.status });
      return got.body;
    },
  };
}

/** A secret can't leave a VPS this way: refused for good, so the move goes on without it and says so. The check has nothing
 * of the VPS's to compare, as none of them went. */
export function vpsHandoff(name) {
  return async (what) => {
    if (what?.kind === "verify-secrets") return { ok: true, secrets: {} };
    if (what?.kind === "connection-release") return { ok: false, error: "stays" };
    throw Object.assign(new Error(staysLine(name)), { code: "local", final: true });
  };
}

/**
 * @param {{
 *   fetch: typeof fetch,
 *   environments(): any[],
 *   cloud(): ReturnType<typeof import("./one-home-main.mjs").oneHomeCloud>,
 *   home(): { origin: string, grant(): Promise<{ origin: string, code: string }> } | null,
 *   cloudRead(route: string): Promise<Response>,
 *   cloudFetch?: typeof fetch,
 *   journal: { read(): unknown, write(value: unknown): void },
 *   choice: { read(): unknown, write(value: unknown): void },
 *   sendState: { read(): unknown, write(value: unknown): void },
 *   viaMac?: { available(place: { origin: string }): boolean, start(place: any): Promise<unknown>, view(): null | { phase: string, failing?: unknown, counts?: unknown } },
 *   buy?(plan?: string): Promise<unknown>,
 *   openHome?(): void,
 *   lastInput?(): number,
 *   track?(name: string, props: Record<string, string | number | boolean>): void,
 *   version?: string,
 *   onChange?(): void,
 *   now?(): number,
 *   timers?: any,
 *   log?(line: string): void,
 * }} deps `fetch`: this window's own requests, with its sign-ins at saved servers. `cloud()`: the Admin's word on My Cloud
 * (one-home-main.mjs oneHomeCloud). `home()`: My Cloud and the Admin's one-time code for it. `cloudRead`: a read at My
 * Cloud as this window's sign-in there. `viaMac`: the way back through this computer (vps-link.mjs moveBack, then this
 * computer's own move), only where this computer's bots are the ones on that VPS. `buy`: the checkout, signed in.
 */
export function installVpsCloudMove({ fetch: fetchImpl, environments, cloud, home, cloudRead, cloudFetch = globalThis.fetch, journal: journalStore, choice: choiceStore, sendState,
  viaMac = null, buy = null, openHome, lastInput, track = () => {}, version, onChange = () => {}, now = Date.now, timers, log = () => {} }) {
  const store = (kept) => ({ read: () => { try { return kept.read(); } catch { return null; } }, write: (value) => kept.write(value) });
  const journal = store(journalStore), choice = store(choiceStore), state = store(sendState);
  const chosen = () => parseVpsChoice(choice.read());
  const placeOf = (picked = chosen()) => (picked ? environments().find((entry) => handSaved(entry) && entry.origin === picked.origin) ?? null : null);
  const say = (step, extra = {}) => { try { track("vps_cloud_move", { step, route: chosen()?.route === "via-mac" ? "via_mac" : "direct", ...extra }); } catch {} };

  const send = createCloudSend({
    local: (route, init) => serverRequests(chosen(), fetchImpl).request(init?.method ?? "GET", route, { signal: AbortSignal.timeout(30_000) }),
    cloud: {
      origin: () => (chosen()?.route === "direct" ? home()?.origin ?? null : null),
      asleep: () => false,
      read: (route) => cloudRead(route),
      open: () => {
        const target = home();
        if (!target) return Promise.reject(new Error("This app has no My Cloud yet."));
        return openOwnerSession(target, cloudFetch, { label: MOVE_LABEL, background: false });
      },
    },
    handoff: (what) => vpsHandoff(chosen()?.name ?? "your server")(what),
    store: state,
    onChange: () => onChange(),
  });

  /** My Cloud as the move sees it, only while a direct move is chosen: until then nothing starts. */
  const target = () => {
    const picked = chosen();
    if (!picked || picked.route !== "direct") return null;
    return cloud();
  };
  const move = createOneHome({
    journal,
    cloud: target,
    send: { move: (options) => send.send({ reason: "move", final: options?.final === true }), check: () => send.check(), switches: () => send.switches(), snapshot: () => send.snapshot() },
    local: {
      call: (method, route, body) => vpsSide(chosen(), fetchImpl).call(method, route, body),
      json: (route) => vpsSide(chosen(), fetchImpl).json(route),
      freeze: async (origin) => {
        const got = await vpsSide(chosen(), fetchImpl).call("POST", "/api/move/freeze", { cloud: origin });
        if (got.status === 403 || got.status === 404 || got.status === 405) throw Object.assign(new Error(`Update Metal on ${chosen()?.name ?? "your server"} to move its bots straight to My Cloud.`), { code: "local", outdated: true, status: got.status });
        return freezeAnswer(got);
      },
      async unfreeze(options) {
        const got = await vpsSide(chosen(), fetchImpl).call("DELETE", "/api/move/freeze", options?.automations === "off" ? { automations: "off" } : undefined);
        if (!got.ok) throw Object.assign(new Error(`${chosen()?.name ?? "Your server"} could not go on again.`), { status: got.status });
      },
      frozen: async () => (await vpsSide(chosen(), fetchImpl).json("/api/move/freeze"))?.frozen === true,
      marker: () => vpsSide(chosen(), fetchImpl).json("/api/move/freeze"),
    },
    session: () => {
      const goal = home();
      if (!goal) return Promise.reject(new Error("This app has no My Cloud yet."));
      return openOwnerSession(goal, cloudFetch, { label: MOVE_LABEL, background: false });
    },
    openHome: () => openHome?.(),
    ...(lastInput ? { lastInput } : {}),
    ...(version ? { version } : {}),
    ...(timers ? { timers } : {}),
    now,
    onChange: () => { observe(); onChange(); },
    log: (line) => log(`vps to cloud: ${line}`),
  });

  /** Each step said once, as product events, never with what moved. */
  const reported = { started: 0, failed: new Set(), done: 0 };
  function observe() {
    const kept = parseJournal(journal.read());
    if (!kept || !Number.isSafeInteger(kept.startedAt)) return;
    if (reported.started !== kept.startedAt) { reported.started = kept.startedAt; reported.failed = new Set(); say("started"); }
    const code = typeof kept.failure?.code === "string" ? kept.failure.code : null;
    if (code && kept.phase !== "done" && !reported.failed.has(code)) { reported.failed.add(code); say("failed", { reason: code }); }
    if (kept.phase === "done" && reported.done !== kept.startedAt) {
      reported.done = kept.startedAt;
      const counts = record(kept.counts) ? kept.counts : {};
      const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
      say("succeeded", { bots: count(counts.bots), chats: count(counts.chats), routines: count(counts.routines) });
    }
  }

  /** The direct move should give way to the one via this computer: the VPS can't be frozen by its owner yet, or its own
   * side failed again and again, and this computer's bots are the ones on it. */
  function shouldFallBack() {
    const picked = chosen(), kept = parseJournal(journal.read());
    if (!picked || picked.route !== "direct" || !kept || awayIn(kept) || kept.phase === "done") return false;
    if (!viaMac?.available(picked)) return false;
    const failure = kept.failure;
    if (kept.outdated) return true;
    return Boolean(failure && VPS_SIDE.has(failure.code) && failure.count >= FALLBACK_AFTER);
  }
  async function fallBack(why) {
    const picked = chosen();
    if (!picked || !viaMac) return;
    log(`vps to cloud: going via this computer (${why})`);
    // The direct move stops before its switch: the VPS is let go of, whatever it was, so the way back can pause it again.
    const kept = parseJournal(journal.read());
    if (kept && !awayIn(kept)) {
      await vpsSide(picked, fetchImpl).call("DELETE", "/api/move/freeze").catch(() => {});
      journal.write(null);
    }
    choice.write({ ...picked, route: "via-mac", fellBackAt: now(), why });
    say("fallback", { reason: why });
    onChange();
    await viaMac.start(placeOf(picked) ?? picked);
  }

  let running = null;
  async function kick() {
    if (running) return running;
    running = (async () => {
      const picked = chosen();
      if (!picked) return;
      if (picked.route === "via-mac") return;
      if (!placeOf(picked) && !awayIn(parseJournal(journal.read()))) { choice.write(null); onChange(); return; }
      try { await move.kick(); }
      catch (error) { log(`vps to cloud: ${error?.message ?? error}`); }
      // a freeze the VPS refused as outdated is written down, so the fallback is taken once
      const kept = parseJournal(journal.read());
      if (kept && /^Update (?:dusk bot|Metal) on /.test(kept.error ?? "") && !kept.outdated) journal.write({ ...kept, outdated: true });
      if (shouldFallBack()) await fallBack(parseJournal(journal.read())?.outdated ? "outdated" : "vps_failing").catch((error) => log(`vps to cloud: the way via this computer did not start (${error?.message ?? error})`));
    })().finally(() => { running = null; });
    return running;
  }

  function view() {
    const picked = chosen();
    if (!picked) {
      const own = cloud();
      return { stage: "none", cloud: !own ? "signed-out" : !own.origin ? "none" : own.ready && own.moves ? "ready" : "starting" };
    }
    const base = { place: picked.name, route: picked.route, ...(picked.why ? { why: picked.why } : {}) };
    if (picked.route === "via-mac") {
      const there = viaMac?.view() ?? null;
      if (there?.phase === "done") return { ...base, stage: "done", ...(record(there.counts) ? { counts: there.counts } : {}) };
      if (there?.failing) return { ...base, stage: "failed", error: sentence(there.failing.error) ?? null };
      return { ...base, stage: "fallback", ...(there?.phase ? { phase: there.phase } : {}) };
    }
    const own = cloud(), seen = move.view(), kept = parseJournal(journal.read());
    if (kept?.outdated && !awayIn(kept)) return { ...base, stage: "failed", phase: kept.phase, error: sentence(kept.error) ?? null };
    if (seen?.phase === "done") return { ...base, stage: "done", ...(seen.counts ? { counts: seen.counts } : {}), stays: staysLine(picked.name) };
    if (seen?.failing) return { ...base, stage: "failed", phase: seen.phase, error: sentence(seen.failing.error) ?? null };
    if (seen) return { ...base, stage: "moving", phase: seen.phase, ...(seen.chats ? { chats: seen.chats } : {}), ...(seen.waitingFor ? { waitingFor: seen.waitingFor } : {}),
      ...(kept?.failure ? { retrying: true, error: sentence(kept.error) ?? null } : {}) };
    if (!own?.origin) return { ...base, stage: "buying" };
    if (!own.ready || !own.moves) return { ...base, stage: "waiting" };
    return { ...base, stage: "moving", phase: "copy" };
  }

  return {
    kick,
    view,
    chosen,
    journal: () => journal.read(),
    /** The journal while home is My Cloud by this move: the window opens My Cloud from then on (home-window.mjs). */
    homeJournal: () => { const kept = parseJournal(journal.read()); return awayIn(kept) ? journal.read() : null; },
    away: () => awayIn(parseJournal(journal.read())),
    busy: () => { const kept = parseJournal(journal.read()); return Boolean(kept) && !awayIn(kept) && kept.phase !== "back"; },
    /**
     * The person chose to move this VPS's bots to My Cloud (`buy`: there is no Cloud yet, so its checkout opens first, signed
     * in; the move starts by itself once the Cloud is ready). Asked once more of the VPS itself first.
     */
    async start(id, { buying = false, plan } = {}) {
      const place = environments().find((entry) => entry.id === id && handSaved(entry));
      if (!place) throw new Error("That server isn't in this app any more.");
      const before = chosen();
      if (before && before.id !== place.id) throw new Error(`Bots from ${before.name} are already moving to My Cloud.`);
      if (!before) {
        const who = await vpsWho(place, fetchImpl).catch(() => null);
        if (!who?.signedIn) throw new Error(`This app isn't signed in to ${place.name}. Open ${place.name} in this app, then try again.`);
        if (!who.own) throw new Error(`${place.name} has other people on it, so its bots can't move to My Cloud from here.`);
        if (!who.environmentId) throw new Error(`Update Metal on ${place.name} first, then try again.`);
        const route = who.direct ? "direct" : viaMac?.available(place) ? "via-mac" : null;
        if (!route) throw new Error(`Update Metal on ${place.name} to move its bots straight to My Cloud.`);
        choice.write({ v: 1, id: place.id, origin: place.origin, environmentId: who.environmentId, name: place.name, at: now(), route, ...(route === "via-mac" ? { why: "outdated" } : {}) });
        say(buying ? "buy" : "chosen");
        onChange();
        if (route === "via-mac" && !buying) await viaMac.start(place);
      }
      if (buying && buy) await buy(plan);
      void kick();
      return view();
    },
    async retry() {
      const picked = chosen();
      if (!picked) return view();
      say("retry");
      if (picked.route === "via-mac") { await viaMac?.start(placeOf(picked) ?? picked); return view(); }
      await move.retry().catch((error) => log(`vps to cloud: ${error?.message ?? error}`));
      await kick();
      return view();
    },
    /** Let go of a move that never started (no Cloud bought after all): nothing ran anywhere yet. */
    cancel() {
      const kept = parseJournal(journal.read());
      if (kept) throw new Error("The move already started. It finishes, or goes back by itself if it can't.");
      if (chosen()) { say("cancelled"); choice.write(null); onChange(); }
      return view();
    },
    close() { move.close(); },
  };
}
