// How people's Metal went: bad experiences, confusing moments and things that got done, from the apps' events and the
// experience signals workspaces report (shared/product-signals.ts). Words, codes and counts only, as they were stored.
import type { StoredEvent } from "../analytics/sink.ts";
import type { UsageRecord } from "../analytics/usage.ts";

export type Family = "bad" | "confusing" | "done";
export const EXPERIENCE_EVENTS = ["app_action", "app_error", "app_pair_failed", "app_feature", "app_feedback", "app_open", "app_screen"] as const;
const DAY = 86_400_000;
/** a first run with no completion this long after its last step counts as abandoned there */
export const ABANDON_AFTER_MS = DAY;
const DONE_FEATURES = new Set(["routine_created", "app_connected", "webhook_created", "skill_added", "phone_paired", "team_imported", "memory_edited"]);
const CONFUSION: Record<string, string> = {
  repeat: "asked the same thing again", rephrase: "rephrased the request", retried: "retried after a failure", what_mean: "asked what the bot meant",
  why: "asked why", how_do_i: "asked how to do something", corrective: "told the bot it was wrong",
};

type Props = Record<string, string | number | boolean>;
const word = (value: unknown) => typeof value === "string" ? value.replace(/_/g, " ") : "unknown";

/** the family and a short plain label of one event, or null when it is neither */
export function classify(name: string, p: Props): { family: Family; label: string } | null {
  switch (name) {
    case "turn_failed": return { family: "bad", label: `turn failed: ${word(p.reason)}` };
    case "turn_stopped": return { family: "bad", label: "turn stopped by the person" };
    case "tool_failed": return { family: "bad", label: `tool failed: ${word(p.app ?? p.tool)}${p.reason ? ` (${word(p.reason)})` : ""}` };
    case "refused": return { family: "bad", label: p.by === "policy" ? `refused by policy: ${word(p.code)}` : `request refused: ${word(p.code)} (${p.status ?? "?"})${p.route ? ` at ${word(p.route)}` : ""}` };
    case "engine_sign_in_failed": return { family: "bad", label: `engine sign-in failed: ${word(p.engine)} (${word(p.reason)})` };
    case "browser_download_failed": return { family: "bad", label: `browser download failed: ${word(p.reason)}` };
    case "crash": return { family: "bad", label: `crash: ${word(p.kind)} (${word(p.reason)})` };
    case "update_failed": return { family: "bad", label: `update failed: ${word(p.stage)}${p.reason ? ` (${word(p.reason)})` : ""}` };
    case "app_updated": return { family: "done", label: p.how === "self" ? "app updated itself" : "app updated by hand" };
    case "routine_done": return p.outcome === "ok" ? { family: "done", label: "routine finished" } : { family: "bad", label: `routine ${word(p.outcome)}${p.reason ? `: ${word(p.reason)}` : ""}` };
    case "devs_report": return { family: "confusing", label: p.outcome === "failed" ? "@devs report could not send" : "@devs report sent" };
    case "confused": return { family: "confusing", label: `${CONFUSION[String(p.kind)] ?? word(p.kind)}${p.after === "failed" && p.kind !== "retried" ? " (after a failure)" : ""}` };
    case "settings_closed": return p.changed === true ? { family: "done", label: "settings changed" } : { family: "confusing", label: "settings closed without a change" };
    case "approval": return p.decision === "granted" ? { family: "done", label: "approval granted" } : { family: "confusing", label: "approval denied" };
    case "talk_change": return { family: "done", label: `changed by talking: ${word(p.about)}` };
    case "created": return { family: "done", label: `${word(p.what)} created` };
    case "file_made": return { family: "done", label: `file made: ${word(p.kind)}` };
    case "turn_done": return { family: "done", label: `turn with tools done: ${word(p.category)}` };
    case "account_sign_in": return p.step === "error" ? { family: "bad", label: `account sign-in failed: ${word(p.code)}` } : p.step === "cancelled" ? { family: "confusing", label: "account sign-in cancelled" } : null;
    case "app_error": return { family: "bad", label: `app error: ${word(p.kind)} ${word(p.code)}` };
    case "app_pair_failed": return { family: "bad", label: `phone pairing failed: ${word(p.reason)}` };
    case "app_feedback": return typeof p.score === "number" && p.score <= 2 ? { family: "bad", label: `rated ${p.score}/5` } : null;
    case "app_feature": return DONE_FEATURES.has(String(p.feature)) ? { family: "done", label: word(p.feature) } : null;
    default: return null;
  }
}

export interface Item { at: number; who: string; name: string; props: Props; family: Family | null; label: string; version: string | null; platform: string | null; account: string | null }

/** one row per event: an app's under its install id, a workspace report's under `ws:<id>` */
export function itemsOf(events: readonly StoredEvent[], signals: readonly UsageRecord[]): Item[] {
  const items: Item[] = [];
  for (const event of events) {
    const who = event.ctx?.install;
    if (!who) continue;
    const name = event.name === "app_action" ? String(event.props.name ?? "app_action") : event.name;
    const { name: _name, ...props } = event.props;
    const seen = classify(name, event.name === "app_action" ? props : event.props);
    items.push({ at: event.at, who, name, props, family: seen?.family ?? null, label: seen?.label ?? labelOf(name, props), version: event.ctx?.app?.version ?? null,
      platform: event.ctx?.app?.platform ?? null, account: event.accountId });
  }
  for (const record of signals) {
    const data = record.data as { name?: unknown; props?: Props };
    if (typeof data.name !== "string") continue;
    const seen = classify(data.name, data.props ?? {});
    if (!seen) continue;
    items.push({ at: record.at, who: `ws:${record.workspaceId}`, name: data.name, props: data.props ?? {}, family: seen.family, label: seen.label,
      version: record.ran?.version ?? null, platform: record.ran?.place ?? null, account: record.accountId || null });
  }
  return items.sort((a, b) => a.at - b.at);
}

function labelOf(name: string, props: Props): string {
  const rest = Object.entries(props).map(([key, value]) => `${key} ${value}`).join(", ");
  return `${name.replace(/_/g, " ")}${rest ? ` (${rest})` : ""}`;
}

/** first runs that stopped: the step each install last reached, when no completion followed within ABANDON_AFTER_MS */
export function abandonedOnboarding(items: readonly Item[], now: number): Item[] {
  const last = new Map<string, Item>(), done = new Set<string>();
  for (const item of items) {
    if (item.name === "onboarding_completed") done.add(item.who);
    else if (item.name === "onboarding_step" && item.props.replay !== true) last.set(item.who, item);
  }
  return [...last.values()].filter(item => !done.has(item.who) && now - item.at >= ABANDON_AFTER_MS)
    .map(item => ({ ...item, at: item.at + 1, name: "onboarding_abandoned", family: "confusing" as const, label: `onboarding abandoned at ${word(item.props.step)}` }));
}

const tally = (items: readonly Item[], max: number) => [...items.reduce((map, item) => map.set(item.label, (map.get(item.label) ?? 0) + 1), new Map<string, number>())]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([key, count]) => ({ key, count }));

export interface ExperienceAnswer {
  from: number; to: number; days: string[];
  series: Record<Family, number[]>;
  totals: Record<Family, number>;
  installs: number;
  top: Record<Family, Array<{ key: string; count: number }>>;
  recent: Array<{ who: string; last: number; bad: number; confusing: number; done: number; version: string | null; platform: string | null; signedIn: boolean }>;
}

/** counts per UTC day for each family, the top reasons in each, and the installs heard from most recently */
export function experienceAnswer(all: readonly Item[], { from, to, now }: { from: number; to: number; now: number }): ExperienceAnswer {
  const start = Math.floor(from / DAY) * DAY, span = Math.max(1, Math.min(90, Math.ceil((to - start) / DAY)));
  const days = Array.from({ length: span }, (_, index) => new Date(start + index * DAY).toISOString().slice(0, 10));
  const inRange = [...all, ...abandonedOnboarding(all, now)].filter(item => item.at >= start && item.at < to);
  const series: Record<Family, number[]> = { bad: days.map(() => 0), confusing: days.map(() => 0), done: days.map(() => 0) };
  const byFamily: Record<Family, Item[]> = { bad: [], confusing: [], done: [] };
  const people = new Map<string, ExperienceAnswer["recent"][number]>();
  for (const item of inRange) {
    const row = people.get(item.who) ?? { who: item.who, last: 0, bad: 0, confusing: 0, done: 0, version: null, platform: null, signedIn: false };
    row.last = Math.max(row.last, item.at);
    row.version = item.version ?? row.version; row.platform = item.platform ?? row.platform; row.signedIn ||= !!item.account;
    people.set(item.who, row);
    if (!item.family) continue;
    row[item.family]++;
    byFamily[item.family].push(item);
    const day = Math.floor((item.at - start) / DAY);
    if (day >= 0 && day < span) series[item.family][day]!++;
  }
  return {
    from: start, to, days, series,
    totals: { bad: byFamily.bad.length, confusing: byFamily.confusing.length, done: byFamily.done.length },
    installs: people.size,
    top: { bad: tally(byFamily.bad, 12), confusing: tally(byFamily.confusing, 12), done: tally(byFamily.done, 12) },
    recent: [...people.values()].sort((a, b) => b.last - a.last).slice(0, 50),
  };
}

/** one install's (or workspace's) recent events, newest first, for debugging what happened to them */
export function timelineAnswer(all: readonly Item[], who: string, now: number, limit = 300) {
  const mine = all.filter(item => item.who === who);
  const items = [...mine, ...abandonedOnboarding(mine, now)].sort((a, b) => b.at - a.at).slice(0, limit)
    .map(({ at, name, family, label, props }) => ({ at, name, family, label, props }));
  return { who, items };
}
