// This computer's page with no bots of its own while the person's live somewhere else: which screen it shows instead of a
// blank first run (electron/bots-elsewhere.mjs answers where), and the dev-only stand-in for a fresh install.
import { useSyncExternalStore } from "react";

export type ElsewhereWhy = "moved" | "cloud" | "team" | "server";
export interface ElsewherePlace { id: string; name: string; why: ElsewhereWhy }
export interface ElsewhereSetup { kind: "server" | "cloud"; name: string }
/** `chosen`: the person picked where this app opens at least once (a place or this computer), so the page no longer offers
 * the places by itself. */
export interface ElsewhereView { places: ElsewherePlace[]; known: ElsewhereSetup | null; chosen?: boolean }
export interface ElsewhereBridge {
  state(): Promise<ElsewhereView>;
  open(id: string): Promise<boolean>;
  /** "server": the page opens its Add your VPS sheet; "cloud": main connects My Cloud; null: nothing remembered. */
  connect(): Promise<"server" | "cloud" | null>;
  /** This computer, picked on the page: it stays here and the places stop being offered. Absent from an older app. */
  stay?(): Promise<boolean>;
  /** Each saved place's own bots by its id, where main could ask it; absent from an older app. */
  counts?(): Promise<Record<string, number>>;
}

export type ElsewhereScreen =
  | { kind: "bots-on"; place: ElsewherePlace; others: ElsewherePlace[] }
  | { kind: "set-up-on"; setup: ElsewhereSetup };

const WHY = new Set<ElsewhereWhy>(["moved", "cloud", "team", "server"]);

/** main's answer, checked: anything else is no place. */
export function parseElsewhereView(raw: unknown): ElsewhereView {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const places = (Array.isArray(value.places) ? value.places : []).flatMap((entry): ElsewherePlace[] => {
    const place = entry as Partial<ElsewherePlace> | null;
    return place && typeof place.id === "string" && typeof place.name === "string" && place.name.trim() && WHY.has(place.why as ElsewhereWhy)
      ? [{ id: place.id, name: place.name.trim(), why: place.why as ElsewhereWhy }] : [];
  });
  const known = value.known as Partial<ElsewhereSetup> | null | undefined;
  return {
    places,
    known: known && (known.kind === "server" || known.kind === "cloud") && typeof known.name === "string" && known.name.trim()
      ? { kind: known.kind, name: known.name.trim() } : null,
    chosen: value.chosen === true,
  };
}

/** main's bot counts, checked: whole numbers only, anything else left out. */
export function parseBotCounts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0));
}

/** No bots of the person's own here: Dusk, the helper every place gets, and bots taken off the sidebar don't count. */
export function emptyHere(bots: readonly { defaultBot?: unknown; hidden?: boolean }[]): boolean {
  return !bots.some((bot) => !bot.defaultBot && !bot.hidden);
}

/** What the page shows instead of a fresh start; null when it starts as it would. `dismissed`: the places the person chose
 * to start fresh here instead of opening. */
export function elsewhereScreen({ view, empty, dismissed }: { view: ElsewhereView | null; empty: boolean; dismissed: readonly string[] }): ElsewhereScreen | null {
  if (!view || !empty || view.chosen || placesChosenHere()) return null;
  const [place, ...others] = view.places;
  if (place) return dismissed.includes(dismissKey({ kind: "bots-on", place, others })) ? null : { kind: "bots-on", place, others };
  if (view.known && !dismissed.includes(dismissKey({ kind: "set-up-on", setup: view.known }))) return { kind: "set-up-on", setup: view.known };
  return null;
}

/** This computer's empty page once the person chose to be on it while their bots live elsewhere: the place to bring them
 * back from, or null when the page is not empty or nothing lives elsewhere. */
export function macEmptyFrom({ view, empty, screen }: { view: ElsewhereView | null; empty: boolean; screen: ElsewhereScreen | null }): ElsewherePlace | null {
  if (!view || !empty || screen) return null;
  return view.places[0] ?? null;
}

const CHOSEN = "dusk-places-chosen";
/** The same choice kept on this page, for an app whose main does not keep it yet. */
export function placesChosenHere(): boolean {
  try { return localStorage.getItem(CHOSEN) === "1"; } catch { return false; }
}
export function choosePlacesHere(): void {
  try { localStorage.setItem(CHOSEN, "1"); } catch { /* storage off: main keeps it */ }
}

let macEmpty: ElsewherePlace | null = null;
const macWatchers = new Set<() => void>();
export function setMacEmpty(place: ElsewherePlace | null): void {
  if (macEmpty?.id === place?.id && macEmpty?.name === place?.name) return;
  macEmpty = place;
  for (const watch of macWatchers) watch();
}
/** Where this computer's bots live while its page is empty by choice (macEmptyFrom), shared with the main area. */
export function useMacEmpty(): ElsewherePlace | null {
  return useSyncExternalStore((watch) => { macWatchers.add(watch); return () => { macWatchers.delete(watch); }; }, () => macEmpty, () => null);
}

/** The sheets this screen's own ways out open over the page: Settings (where the switcher's "connect a server" lands), the
 * dusk cloud offer, Add your VPS and a move to dusk cloud. The screen steps aside while one is up, or it would cover it. */
export function elsewhereCovered({ settings, cloudAdd, addVps, cloudMove, placeSetup = false }: { settings: boolean; cloudAdd: boolean; addVps: boolean; cloudMove: boolean; placeSetup?: boolean }): boolean {
  return settings || cloudAdd || addVps || cloudMove || placeSetup;
}

export function dismissKey(screen: ElsewhereScreen): string {
  return screen.kind === "bots-on" ? `place:${screen.place.id}` : `setup:${screen.setup.kind}:${screen.setup.name}`;
}

const DISMISSED = "dusk-elsewhere-dismissed";
export function dismissedPlaces(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(DISMISSED) ?? "[]");
    return Array.isArray(kept) ? kept.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}
export function dismissPlace(key: string): void {
  try { localStorage.setItem(DISMISSED, JSON.stringify([...dismissedPlaces().filter((entry) => entry !== key), key].slice(-20))); } catch { /* storage full or off */ }
}

/** The dev button's stand-in: a fresh install whose account already set up Metal on a VPS. */
export const SIMULATED_FRESH_INSTALL: ElsewhereView = { places: [], known: { kind: "server", name: "My VPS" } };

/** Dev builds, or any build with localStorage "dusk-dev-tools" set to "1"; never a test preview, which renders the app as it
 * ships (VITE_DUSK_DEV_TOOLS=0, scripts/testing/preview-fixture.ts). */
export function devToolsShown(): boolean {
  if (import.meta.env.VITE_DUSK_DEV_TOOLS === "0") return false;
  if (import.meta.env.DEV) return true;
  try { return localStorage.getItem("dusk-dev-tools") === "1"; } catch { return false; }
}

let simulating = false;
const watchers = new Set<() => void>();
export function setSimulatedFreshInstall(on: boolean): void {
  simulating = on;
  for (const watch of watchers) watch();
}
export function useSimulatedFreshInstall(): boolean {
  return useSyncExternalStore((watch) => { watchers.add(watch); return () => { watchers.delete(watch); }; }, () => simulating, () => false);
}
