// when someone is clearly invested in Metal, and the one place each dusk cloud upsell is counted from.
// the app, the phone and the dashboard all read these, so a threshold changes in one place.

/** owner approved: any one of these means a person is invested */
export const INVESTED = { bots: 3, messages: 50, routines: 3 } as const;

export interface InvestedFacts { bots: number; messages: number; routines: number }

/** which threshold someone crossed first, or null while they are still trying things out */
export function investedBy(facts: InvestedFacts): keyof InvestedFacts | null {
  if (facts.bots >= INVESTED.bots) return "bots";
  if (facts.routines >= INVESTED.routines) return "routines";
  if (facts.messages >= INVESTED.messages) return "messages";
  return null;
}

/** a dismissed sidebar card comes back after this long */
export const SNOOZE_DAYS = 10;
const DAY_MS = 86_400_000;

export const snoozeUntil = (now: number, days = SNOOZE_DAYS) => now + days * DAY_MS;

/** a stored snooze: still asleep while its time is ahead; anything unreadable counts as awake */
export function snoozed(raw: string | null | undefined, now: number): boolean {
  const until = Number(raw);
  return Number.isFinite(until) && until > now;
}

/** the analytics names every upsell surface reports with; `source` is its checkout source. Every step after `shown` carries
 * `ms`, the visible time since it was shown; `ignored` means it went away (the page left, the card unmounted) without a click
 * or a dismiss */
export const UPSELL_EVENTS = { shown: "upsell_shown", click: "upsell_click", dismiss: "upsell_dismiss", ignored: "upsell_ignored" } as const;
export type UpsellStep = keyof typeof UPSELL_EVENTS;
