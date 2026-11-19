import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DEFAULT_BOT_COLOR, DEFAULT_BOT_NAME, defaultBotPerson } from "../shared/default-bot.ts";
import { takeImportName } from "../shared/import-name.ts";
import type { BotRecord, Message, Store } from "./store.ts";

export type DefaultBotStore = Pick<Store, "bots" | "bot" | "createBot" | "patchBot" | "appendMessage" | "messagesFor" | "createTask" | "setChiefOfStaff">;
export type LegacyNameStore = Pick<Store, "bots" | "patchBot" | "patchTask" | "messagesFor" | "patchMessage">;

/** Where each place (key "") and Team Cloud member (their email) is recorded as having had its Metal, so one that is
 * gone is never made twice. */
const LEDGER = "default-bot.json";

/** The colour a new install gave its Metal before Chrome, which an adopted Metal trades for Chrome. */
const STARTER_COLOR = "silver";

export const HELPER_ASKS = ["What are my bots up to?", "Set up a bot for my inbox", "Make me a morning routine", "How do I connect my email?"];

export function defaultBotRefusal(name: string): string {
  return `${name} can't be deleted or archived. To take it off the sidebar, choose Hide in its menu, or turn off "Show ${name} in the sidebar" in Settings → Models, under New bots.`;
}

/** Why a PATCH may not change this bot so, or null. */
export function defaultBotPatchRefusal(bot: BotRecord | null, body: Record<string, unknown>): string | null {
  for (const key of ["sidebarHidden", "welcomed"]) if (body[key] !== undefined && typeof body[key] !== "boolean") return `${key} must be true or false`;
  if ((body.sidebarHidden !== undefined || body.welcomed !== undefined) && !bot?.defaultBot) return "Only your helper is hidden this way; archive or delete other bots.";
  return body.hidden === true && bot?.defaultBot ? defaultBotRefusal(bot.name) : null;
}

export function ownsDefaultBot(bot: BotRecord | null | undefined, email: string | undefined): boolean {
  return Boolean(email && bot?.defaultBot && defaultBotPerson(bot) === email.trim().toLowerCase());
}

/** The English intro: who Metal is, what it does here, and that it is looking around (its follow-up comes after, from
 * helper-followup.ts). Clients that know `helperIntro` say it in the viewer's own language. */
export function helperIntroMessage(bot: Pick<BotRecord, "name" | "chiefOfStaff">, team?: string | null): Omit<Message, "id" | "at"> {
  const title = bot.chiefOfStaff ? `Hey! I'm ${bot.name}. I'm new here.` : `Hi! I'm ${bot.name}, your helper for everything here.`;
  const subtitle = [
    bot.chiefOfStaff
      ? "I'm here to be your Chief of Staff. I can manage your other bots. Task me with anything. I'll make sure it gets to the right bot."
      : team
        ? "Ask me how to do anything here. I can set up bots, apps and routines with you."
        : "Ask me how to do anything here. I can set up bots, apps and routines with you, and keep an eye on your day.",
    team ? `On ${team}, I'm here for you and look after your own bots.` : "",
    "I'm taking a look around to see if there's anything I can pick up for you. I'll follow up in a moment.",
  ].filter(Boolean).join(" ");
  return { role: "bot", kind: "options", text: `${title} ${subtitle}`, helperIntro: true, card: { title, subtitle, options: [...HELPER_ASKS], fixedOptions: true } };
}

function ledger(dataDir: string): Record<string, string> {
  const file = join(dataDir, LEDGER);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { places?: unknown };
    return parsed.places && typeof parsed.places === "object" ? parsed.places as Record<string, string> : {};
  } catch {
    return {};
  }
}

function remember(dataDir: string, person: string, botId: string): void {
  const places = ledger(dataDir);
  if (places[person] === botId) return;
  writeFileAtomic(join(dataDir, LEDGER), JSON.stringify({ v: 1, places: { ...places, [person]: botId } }), { mode: 0o600 });
}

/** A member who left: should they join again, they are given a Metal of their own again. */
export function forgetDefaultBot(dataDir: string, person: string): void {
  const places = ledger(dataDir);
  if (!person || !Object.hasOwn(places, person)) return;
  delete places[person];
  writeFileAtomic(join(dataDir, LEDGER), JSON.stringify({ v: 1, places }), { mode: 0o600 });
}

/** A new install's own Metal from before it was marked: the place's oldest bot, still live, outside any department,
 * not installed from a package, and still named Metal (or an earlier name) or still in the colour a new install gave it. */
export function seededDusk(bots: readonly BotRecord[], legacy = false): BotRecord | undefined {
  const oldest = bots.reduce<BotRecord | undefined>((first, bot) => !first || bot.createdAt < first.createdAt ? bot : first, undefined);
  if (!oldest || oldest.hidden || oldest.movedTo || oldest.section?.trim() || oldest.installedPackage) return undefined;
  if (legacy) return legacyNamed(oldest) ? oldest : undefined;
  return oldest.name === DEFAULT_BOT_NAME || legacyNamed(oldest) || oldest.color === STARTER_COLOR ? oldest : undefined;
}

/** Puts the intro where its person sees it next: in its open conversation while nobody has written there, else at the
 * top of a new one, so no earlier message moves. */
function introduce(store: DefaultBotStore, bot: BotRecord, team?: string | null): void {
  const untouched = !store.messagesFor(bot.threadId).some((message) => message.role === "user");
  const threadId = untouched ? bot.threadId : store.createTask(bot.id, `What ${bot.name} can do`)?.threadId;
  if (threadId) store.appendMessage(threadId, helperIntroMessage(bot, team));
}

/** A new Metal, with its intro as its first message. On a Team Cloud it is its member's alone. */
export function createDefaultBot(store: DefaultBotStore, options: { person?: string; team?: string | null; chief?: (id: string) => void } = {}): BotRecord {
  const person = options.person?.trim().toLowerCase() ?? "";
  const taken = new Set(person ? [] : store.bots.map((bot) => bot.name.trim().toLowerCase()));
  const created = store.createBot({
    name: takeImportName(DEFAULT_BOT_NAME, taken),
    color: DEFAULT_BOT_COLOR,
    ...(person ? { visibility: { people: [person] } } : {}),
  }, { seedMessages: false });
  options.chief?.(created.id);
  const bot = store.patchBot(created.id, { defaultBot: person ? { person } : {} }) ?? created;
  store.appendMessage(bot.threadId, helperIntroMessage(bot, options.team));
  return bot;
}

/** The helper's earlier names, oldest first. */
export const LEGACY_DEFAULT_BOT_NAMES = ["MausBot", "Dusk", "dusk bot", "DuskBot", "Dusk Bot"] as const;
export const LEGACY_DEFAULT_BOT_NAME = LEGACY_DEFAULT_BOT_NAMES[0];

const legacyName = (bot: Pick<BotRecord, "name">): string | undefined => LEGACY_DEFAULT_BOT_NAMES.find((name) => bot.name.trim() === name);
const legacyNamed = (bot: Pick<BotRecord, "name">): boolean => legacyName(bot) !== undefined;

/** Every helper still called by an earlier name becomes Metal, and its seeded intro (and the task that holds it) says so. Runs
 * at every start, on any place, frozen or not, so a copy the island or the dock still reads never shows the old
 * name. A bot someone renamed keeps its name; only an intro still naming the old name is rewritten. */
export function renameLegacyDefaultBots(store: LegacyNameStore): number {
  let renamed = 0;
  for (const bot of store.bots.slice()) {
    if (!legacyNamed(bot) || (!bot.defaultBot && seededDusk(store.bots, true)?.id !== bot.id)) continue;
    const name = DEFAULT_BOT_NAME, old = legacyName(bot)!;
    store.patchBot(bot.id, { name });
    for (const task of bot.tasks ?? []) if (task.title === `What ${old} can do`) store.patchTask(bot.id, task.threadId, { title: `What ${name} can do` });
    const threads = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
    for (const threadId of threads) {
      for (const message of store.messagesFor(threadId)) {
        if (!message.helperIntro || !message.text?.includes(`I'm ${old}`)) continue;
        const swap = (value: string | undefined) => value?.replaceAll(`I'm ${old}`, `I'm ${name}`);
        store.patchMessage(threadId, message.id, {
          text: swap(message.text),
          ...(message.card ? { card: { ...message.card, ...(message.card.title ? { title: swap(message.card.title) } : {}), ...(message.card.subtitle ? { subtitle: swap(message.card.subtitle) } : {}) } } : {}),
        });
      }
    }
    renamed++;
  }
  return renamed;
}

/** Makes sure this place (no `person`) or this Team Cloud member has had its Metal once: the one it has, the new
 * install's own adopted, or a new one. A Metal that is gone is never made again. Two marked ones keep the oldest. A
 * place with no Chief of Staff at all gets Metal as its Chief, so someone keeps an eye on the day; one that has a
 * Chief keeps it. */

export function ensureDefaultBot(store: DefaultBotStore, options: { dataDir: string; person?: string; team?: string | null }): BotRecord | null {
  const person = options.person?.trim().toLowerCase() ?? "";
  const marked = store.bots.filter((bot) => bot.defaultBot && defaultBotPerson(bot) === person)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const extra of marked.slice(1)) store.patchBot(extra.id, { defaultBot: undefined, sidebarHidden: undefined });
  if (marked[0]) {
    remember(options.dataDir, person, marked[0].id);
    return marked[0];
  }
  if (Object.hasOwn(ledger(options.dataDir), person)) return null;
  const adoptable = person ? undefined : seededDusk(store.bots);
  const chief = !person && !store.bots.some((bot) => bot.chiefOfStaff && !bot.hidden) ? (id: string) => store.setChiefOfStaff(id) : undefined;
  let bot: BotRecord;
  if (adoptable) {
    bot = store.patchBot(adoptable.id, { defaultBot: {}, ...(adoptable.color === STARTER_COLOR ? { color: DEFAULT_BOT_COLOR } : {}) }) ?? adoptable;
    chief?.(bot.id);
    introduce(store, bot, options.team);
  } else {
    bot = createDefaultBot(store, { person, team: options.team, chief });
  }
  remember(options.dataDir, person, bot.id);
  return bot;
}

/** A move brought this place's Metal from another computer: it becomes the one Metal here, and the one this place
 * had becomes an ordinary bot (retireUnusedStarter archives it when nobody used it). */
export function takeArrivingDefaultBot(store: Pick<Store, "bots" | "patchBot">, id: string): void {
  const arriving = store.bots.find((bot) => bot.id === id);
  if (!arriving) return;
  for (const bot of store.bots) {
    if (bot.id !== id && bot.defaultBot && !defaultBotPerson(bot)) store.patchBot(bot.id, { defaultBot: undefined, sidebarHidden: undefined });
  }
  if (!arriving.defaultBot || defaultBotPerson(arriving)) store.patchBot(id, { defaultBot: {} });
}

/** After a bot arrives by a move: the Metal this place made for itself (by id, from the ledger), once it is neither
 * the Metal nor the Chief and nobody has used it, is archived, so the move leaves one Metal and nothing of the
 * person's is lost. */
export function retireUnusedStarter(store: Pick<Store, "bot" | "patchBot" | "messagesFor">, dataDir: string): void {
  const own = ledger(dataDir)[""];
  const seed = own ? store.bot(own) : null;
  if (!seed || seed.defaultBot || seed.chiefOfStaff || seed.hidden) return;
  if (seed.soul?.trim() || seed.title || seed.description || seed.avatarUrl || (seed.tasks?.length ?? 1) > 1) return;
  if (store.messagesFor(seed.threadId).some((message) => message.role === "user")) return;
  store.patchBot(seed.id, { hidden: true, pinned: undefined });
}
