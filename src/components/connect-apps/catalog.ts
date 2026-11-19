import type { LocaleKey } from "@/locales";
import type { IconName } from "../Icon";

/** Grok's marketplace categories, in its order, then AI for Composio's many AI tools. The first five are chips; the
 * rest wait under More. */
export const CATEGORIES = [
  "credentials", "productivity", "communication", "design", "code",
  "data", "sales", "marketing", "finance", "research", "support", "ai", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const INLINE_CHIPS = 5;
export const SECTION_SIZE = 6;
export const RECOMMENDED_SIZE = 6;
export const SEARCH_LIMIT = 8;

export const CATEGORY_LABEL: Record<Category, LocaleKey> = {
  credentials: "connectApps.category.credentials",
  productivity: "connectApps.category.productivity",
  communication: "connectApps.category.communication",
  design: "connectApps.category.design",
  code: "connectApps.category.code",
  data: "connectApps.category.data",
  sales: "connectApps.category.sales",
  marketing: "connectApps.category.marketing",
  finance: "connectApps.category.finance",
  research: "connectApps.category.research",
  support: "connectApps.category.support",
  ai: "connectApps.category.ai",
  other: "connectApps.category.other",
};

const CATEGORY_WORDS: ReadonlyArray<[Category, RegExp]> = [
  ["credentials", /password|credential|login|vault|secret|identity/],
  ["sales", /sales|crm|lead/],
  ["support", /support|help ?desk|ticket|customer service/],
  ["finance", /financ|payment|accounting|billing|invoice|bank|commerce|checkout|tax|fundrais/],
  ["ai", /artificial intelligence|\bai\b|model context protocol|\bmcp\b|\bmodels?\b|agent|chatbot|assistant|transcri/],
  ["marketing", /marketing|social|advertis|\bads\b|seo|content|url shortener|review/],
  ["data", /analytic|\bdata\b|metric|business intelligence|\bbi\b|scrap|browser|places|weather|internet of things/],
  ["design", /design|creative|canvas|whiteboard|image|photo|video|audio|media|website|app builder/],
  ["code", /develop|code|engineer|devops|infrastructure|cloud|hosting|database|monitor|\bapi\b|it operations/],
  ["communication", /communicat|e-?mail|\bmail|chat|messag|meeting|inbox|calendar|schedul|phone|sms|conferenc|webinar|notification|call|event/],
  ["research", /research|search|science|news|knowledge|education|course|legal/],
  ["productivity", /productiv|file|document|storage|project|task|note|office|automation|workflow|spreadsheet|form|survey|signature|time tracking|bookmark|collaborat|human resources|\bhr\b|recruit|contact|product management/],
];

/** The Grok category a Metal catalog category belongs to, or null when none fits. */
export function grokCategory(name: string): Category | null {
  const normalized = name.trim().toLowerCase().replace(/&/g, " and ");
  return CATEGORY_WORDS.find(([, words]) => words.test(normalized))?.[0] ?? null;
}

/** A catalog app's categories, or Other when none fits, so every app is listed under some category. */
export function grokCategories(names: readonly string[] | undefined): Category[] {
  const found = [...new Set((names ?? []).flatMap((name) => grokCategory(name) ?? []))];
  return found.length ? found : ["other"];
}

/** composio: an aggregator's catalog app. remote: the vendor's own hosted MCP server, signed in with dynamic client
 * registration. native, hosted, logins: Metal's own cards. token: connected with the person's own token or a device
 * code. custom: an MCP server the person added by its URL. */
export type AppKind = "composio" | "remote" | "native" | "hosted" | "logins" | "token" | "custom";

/** Apps from a provider's catalog, as opposed to Metal's own cards. */
export const fromCatalog = (entry: Pick<AppEntry, "kind">): boolean => entry.kind === "composio" || entry.kind === "remote";

export interface AppIcon {
  logo?: string | null;
  domain?: string | null;
  image?: string;
  /** A bare mark set inside the tile instead of filling it. */
  padded?: boolean;
  background?: string;
  scale?: number;
  glyph?: IconName;
  /** A glyph tile's paint, with the glyph in white on it. */
  glyphPaint?: string;
}

/** One app the window lists, whichever system connects it. */
export interface AppEntry {
  id: string;
  kind: AppKind;
  label: string;
  description: string;
  categories: Category[];
  icon: AppIcon;
  website?: string;
  /** Words besides the label that find it. */
  keywords?: string;
  /** The same app in Composio's catalog, when this row is our own card: its second way in. */
  composio?: string;
  /** The same app's own MCP server, from the directory: another way in. */
  remote?: string;
  /** Composio's other listings of the same app, which count toward its connected state. */
  aliases?: string[];
  /** Our own card connects in one click: a sign-in page, then it is on. Without it, an app Composio also has leads with
   * Composio's sign-in, and our card waits under the other ways. */
  oneClick?: boolean;
}

export type Connection = "connected" | "disconnected" | "unknown";

/** The categories that hold at least one app, in Grok's order. */
export function presentCategories(entries: readonly AppEntry[]): Category[] {
  return CATEGORIES.filter((category) => entries.some((entry) => entry.categories.includes(category)));
}

/** The apps most people connect first, by any of their ids. */
export const POPULAR_APPS = [
  "gmail", "googlecalendar", "googledrive", "slack", "github", "notion", "googledocs", "googlesheets",
  "outlook", "linear", "figma", "zoom", "dropbox", "jira", "hubspot", "asana", "trello", "discord",
  "bitwarden", "lastpass", "dashlane",
] as const;

/** Where an app stands among the popular ones, or Infinity. */
export function popularity(entry: Pick<AppEntry, "id" | "composio" | "remote" | "aliases">): number {
  const ids = [entry.id, entry.composio, entry.remote, ...(entry.aliases ?? [])].filter(Boolean).map((id) => id!.toLowerCase());
  const at = Math.min(...ids.map((id) => (POPULAR_APPS as readonly string[]).indexOf(id)).filter((index) => index >= 0));
  return Number.isFinite(at) ? at : Infinity;
}

const byPopularity = (list: AppEntry[]) => list
  .map((entry, index) => ({ entry, index, rank: popularity(entry) }))
  .sort((a, b) => a.rank - b.rank || a.index - b.index)
  .map(({ entry }) => entry);

/** Metal's own apps lead their category, then the catalog's popular apps, then the rest in its order. */
export function inCategory(entries: readonly AppEntry[], category: string): AppEntry[] {
  const members = entries.filter((entry) => entry.categories.includes(category as Category));
  return [...members.filter((entry) => !fromCatalog(entry)), ...byPopularity(members.filter(fromCatalog))];
}

/** Grok's "Recommended for you": apps not yet connected, in the categories of the apps you have, the categories you use
 * most first. Before anything is connected it is the popular apps (Gmail, Calendar, Drive, Slack...). */
export function recommended(entries: readonly AppEntry[], connection: (id: string) => Connection, size = RECOMMENDED_SIZE): AppEntry[] {
  const affinity = new Map<Category, number>();
  for (const entry of entries) {
    if (connection(entry.id) !== "connected") continue;
    for (const category of entry.categories) affinity.set(category, (affinity.get(category) ?? 0) + 1);
  }
  if (!affinity.size) return byPopularity(entries.filter((entry) => popularity(entry) !== Infinity)).slice(0, size);
  const strength = (entry: AppEntry) => Math.max(0, ...entry.categories.map((category) => affinity.get(category) ?? 0));
  return entries
    .map((entry, index) => ({ entry, index, strength: strength(entry) }))
    .filter(({ entry, strength }) => strength > 0 && connection(entry.id) !== "connected")
    .sort((a, b) => b.strength - a.strength || a.index - b.index)
    .slice(0, size)
    .map(({ entry }) => entry);
}

/** How well `query` names `text`: 0 starts it, 1 starts a word, 2 is inside it, 3 is its letters in order, null misses. */
export function matchRank(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  if (haystack.startsWith(needle)) return 0;
  const at = haystack.indexOf(needle);
  if (at > 0) return /[\s\-_.(/]/.test(haystack[at - 1]!) ? 1 : 2;
  let from = 0;
  for (const letter of needle) {
    if (letter === " ") continue;
    from = haystack.indexOf(letter, from);
    if (from < 0) return null;
    from += 1;
  }
  return 3;
}

/** The apps a search finds, Grok's way: by name, then by what they do, each from a prefix down to letters in order. */
export function searchApps(entries: readonly AppEntry[], query: string, limit = SEARCH_LIMIT): AppEntry[] {
  return entries
    .map((entry, index) => {
      const byName = matchRank(entry.label, query);
      const byWords = byName === null ? matchRank(`${entry.keywords ?? ""} ${entry.description}`, query) : null;
      const rank = byName ?? (byWords === null ? null : 4 + byWords);
      return { entry, index, rank };
    })
    .filter((hit): hit is { entry: AppEntry; index: number; rank: number } => hit.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
