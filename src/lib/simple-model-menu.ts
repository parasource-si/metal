import type { InstanceInfo, ModelSelection } from "@/state/store";
import { needsCli, needsSignIn } from "@/components/EngineSetup";
import { t } from "./i18n";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "./custom-models";
import { isCustomOnly, SIGN_IN_FAMILY_LABEL, signInFamily, splitEngineRail } from "./engine-rail";
import { freeFallback } from "../../shared/ai-ranking";
import { engineReady } from "@/components/EngineLibrary";
import { aiTiles, type AiTileId } from "@/components/onboarding/funnel";
import { connectsInApp, type ConnectInstance } from "@/components/onboarding/connect-flow";
import { displayModelLabel, shortModelLabel } from "./model-friendly";
import { starKey } from "./starred-models";
import { choiceIsSelected, modelChoices, takesTypedModels, type ModelChoice } from "./model-choices";

export type ModelOption = InstanceInfo["models"]["options"][number];

export const SIMPLE_SEARCH_AFTER = 12;
export const CURRENT_GROUP_SUGGESTIONS = 4;
export const GROUP_SUGGESTIONS = 3;

export interface MenuModelRow {
  option: ModelChoice;
  model?: string;
  variant?: string;
  label: string;
  route?: string;
  current: boolean;
  blocked: boolean;
  /** What a star on this model is kept under (starKey). */
  star: string;
  starred: boolean;
  /** OpenCode's Free model row, which follows the free model it lists now: no star, that pins one model. */
  auto?: true;
}

/** A starred model, listed under the current model whichever provider it belongs to. */
export interface MenuStarredRow {
  instance: InstanceInfo;
  provider: string;
  row: MenuModelRow;
}

export type MenuGroupBody =
  | { kind: "policy"; organization: string; team?: boolean }
  | { kind: "setUp" }
  | { kind: "signIn" }
  | { kind: "empty"; loading: boolean }
  | {
    kind: "models";
    rows: MenuModelRow[];
    total: number;
    toggle: "more" | "less" | null;
    localFrom: number | null;
    signInForOwn: boolean;
    probing: boolean;
    /** The rows are OpenCode's free models, so its toggle says so. */
    freeToggle?: true;
  };

export interface MenuGroup {
  instance: InstanceInfo;
  label: string;
  provider: string;
  account?: string;
  /** A short line under the heading, such as why this account is special here. */
  note?: string;
  body: MenuGroupBody;
}

export interface MenuCurrent {
  instance?: InstanceInfo;
  label: string;
  title: string;
  meta?: string;
  warning: boolean;
  pending: boolean;
  /** The organization turned the selected model off: nothing to set up, only another model to pick. */
  blocked?: boolean;
}

export interface SimpleMenu {
  current: MenuCurrent | null;
  follow: boolean;
  /** The person's starred models that can be picked now, in the order they starred them. */
  starred: MenuStarredRow[];
  /** The models picked last that can be picked now, newest first: never the current one, never a starred one. */
  recent: MenuStarredRow[];
  /** Providers with models to pick now. */
  groups: MenuGroup[];
  /** Providers listed here that still need a sign-in or a setup before they have models: a Connect row each. */
  connect: MenuGroup[];
  search: boolean;
  query: string;
  results: number | null;
  empty: "loading" | "none" | null;
  busy: boolean;
}

export interface SimpleMenuInput {
  instances: readonly InstanceInfo[];
  listed: readonly InstanceInfo[];
  selection: ModelSelection;
  bot: { name: string; selection: ModelSelection; follows?: boolean };
  query: string;
  expanded: ReadonlySet<string>;
  probing: ReadonlySet<string>;
  loading: boolean;
  refreshing?: string | null;
  /** Always offer the search, which then also looks through providers not connected yet. */
  searchAll?: boolean;
  /** The person's starred models (starKey), in starred order. */
  starred?: readonly string[];
  /** The models picked last on this device (starKey), newest first. */
  recent?: readonly string[];
}

export const RECENT_SHOWN = 3;

/** Metal's own free model: OpenCode ready through its free models alone, with no login of the person's own. */
export const isFreeModel = (instance: InstanceInfo | undefined): boolean => Boolean(instance && freeFallback(instance));

/** OpenCode's CLI names its free models with a `-free` suffix, which is the only price it reports over ACP (V2); the
 * driver reads the same suffix (opencode-go.ts), so free here is the set the free backup answers on. */
export const isFreeModelId = (id: string): boolean => /(?:^|[-_/])free$/iu.test(id);

/** "Zen · Beam Free" reads as "Beam Free" under an OpenCode heading: the provider in the label repeats the group. */
const ownModelLabel = (label: string): string => {
  const separator = label.indexOf(" · ");
  return separator < 0 ? label : label.slice(separator + 3).trim() || label;
};

/** The model the Free model row runs on: the one OpenCode picks as its free model now (the driver's default). */
const freeModelNow = (instance: InstanceInfo): string => instance.models.default.trim()
  || instance.models.options.find((option) => !option.custom)?.id || "";

/** The selection is the Free model row: Metal's default on OpenCode's free models, named by what it is, never by
 * the model behind it (3656bc25c). A free model picked by name goes by that name. */
export const isAutoFreeModel = (instance: InstanceInfo | undefined, model: string): boolean =>
  Boolean(instance && isFreeModel(instance) && model === freeModelNow(instance));

export function providerName(instance: InstanceInfo): string {
  if (isFreeModel(instance)) return instance.displayName;
  const family = signInFamily(instance);
  if (family) return SIGN_IN_FAMILY_LABEL[family];
  if (instance.access !== "api") return instance.displayName;
  return instance.displayName.replace(/\s*\((?:API key|API)\)$/i, "") || instance.displayName;
}

export function variantSuffix(instance: InstanceInfo | undefined, model: string, variant?: string): string {
  const option = instance?.models.options.find((candidate) => candidate.id === model);
  if (!instance || !option || variant === undefined) return "";
  const listed = modelChoices(instance, [option]).some((choice) => choiceIsSelected(choice, { instanceId: instance.instanceId, model, variant }));
  const label = listed ? option.variants?.find((candidate) => candidate.id === variant)?.label : undefined;
  return label ? ` · ${label}` : "";
}

export function modelName(instance: InstanceInfo | undefined, model: string, variant?: string): string {
  const option = instance?.models.options.find((candidate) => candidate.id === model);
  if (!instance || !option) return model;
  if (isAutoFreeModel(instance, model)) return t("model.free.name");
  if (isFreeModel(instance)) return ownModelLabel(option.label) + variantSuffix(instance, model, variant);
  return displayModelLabel(option.label, providerName(instance), option.custom) + variantSuffix(instance, model, variant);
}

/** Why a model can't answer now, in a few words (Sign-in required, Unavailable...); null while it can, and until the AIs
 * are read. A model on an AI that isn't connected never answers, so its name alone would mislead. */
export function unansweredReason(instances: readonly InstanceInfo[], selection: ModelSelection | undefined): string | null {
  if (!selection || (!selection.instanceId && !selection.model) || !instances.length) return null;
  const instance = instances.find((candidate) => candidate.instanceId === selection.instanceId);
  const option = instance?.models.options.find((candidate) => candidate.id === selection.model);
  if (!instance) return t("model.simple.unavailable");
  if (needsCli(instance)) return t("model.setupRequired");
  if (needsSignIn(instance) && !isCustomOnly(instance) && !option?.custom) return t("model.signInRequired");
  if (option?.orgBlocked) return t("model.orgBlocked");
  return null;
}

/** A bot's model where only a short value fits: its name while its AI can answer, else why it can't; "" until the AIs
 * are read. */
export function answeringModelName(instances: readonly InstanceInfo[], selection: ModelSelection | undefined): string {
  if (!selection || (!selection.instanceId && !selection.model) || !instances.length) return "";
  const instance = instances.find((candidate) => candidate.instanceId === selection.instanceId);
  return unansweredReason(instances, selection) ?? modelName(instance, selection.model, selection.variant);
}

export function repeatedModelLabels(options: readonly ModelOption[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const option of options) (seen.has(option.label) ? repeated : seen).add(option.label);
  return repeated;
}

function listedModels(instance: InstanceInfo) {
  const signedOut = !isCustomOnly(instance) && needsSignIn(instance);
  const own = isCustomOnly(instance) || signedOut ? [] : modelChoices(instance, instance.models.options.filter((option) => !option.custom));
  const local = partitionCustomModels(instance.models.options.filter((option) => option.custom));
  return { signedOut, own, all: [...own, ...local.pinned, ...local.rest] };
}

function localFrom(rows: readonly MenuModelRow[], mixed: boolean): number | null {
  if (!mixed) return null;
  const first = rows.findIndex((row) => row.option.custom);
  return first >= 0 && rows.slice(first).every((row) => row.option.custom) ? first : null;
}

function heading(instance: InstanceInfo, listed: readonly InstanceInfo[]): Pick<MenuGroup, "label" | "provider" | "account" | "note"> {
  const provider = providerName(instance);
  const family = signInFamily(instance);
  if (isFreeModel(instance)) return { label: provider, provider, note: t("model.free.groupNote") };
  if (instance.access === "api") return { label: `${provider} · ${t("model.simple.apiKey")}`, provider };
  const several = family !== undefined && listed.filter((other) => signInFamily(other) === family).length > 1;
  const account = several && instance.displayName !== provider ? instance.displayName : undefined;
  return { label: account ? `${provider} · ${account}` : provider, provider, ...(account ? { account } : {}), ...(instance.found ? { note: t("model.picker.found") } : {}) };
}

function currentRow(input: SimpleMenuInput): MenuCurrent {
  const { instances, selection, bot, loading } = input;
  const active = instances.find((instance) => instance.instanceId === selection.instanceId);
  const option = active?.models.options.find((candidate) => candidate.id === selection.model);
  const name = option?.label ?? selection.model;
  const title = isAutoFreeModel(active, selection.model) ? t("model.free.hint")
    : active ? `${active.displayName} · ${isFreeModel(active) ? ownModelLabel(name) : name}${variantSuffix(active, selection.model, selection.variant)}` : name;
  const row = { instance: active, label: modelName(active, selection.model, selection.variant), title, warning: false, pending: false };
  if (!active) return loading ? { ...row, pending: true } : { ...row, meta: t("model.simple.unavailable"), warning: true };
  if (!option && input.refreshing === active.instanceId) return { ...row, pending: true };
  if (option?.orgBlocked) return { ...row, meta: t("model.orgBlocked"), warning: true, blocked: true };
  if (active.policy) return { ...row, meta: t("policy.managedBy", { organization: active.policy.organizationName }), warning: true };
  if (needsCli(active)) return { ...row, meta: t("model.setupRequired"), warning: true };
  if (needsSignIn(active) && !isCustomOnly(active) && !option?.custom) return { ...row, meta: t("model.signInRequired"), warning: true };
  if (bot.follows === true) return { ...row, meta: t("model.simple.botsModel", { name: bot.name }) };
  const family = signInFamily(active);
  const accounts = family ? instances.filter((instance) => signInFamily(instance) === family).length : 0;
  if (accounts > 1 || active.snapshot.chatgptPlan) return { ...row, meta: active.displayName };
  return option?.provider ? { ...row, meta: option.provider } : row;
}

function modelRow(instance: InstanceInfo, provider: string, all: readonly ModelChoice[], option: ModelChoice,
  selection: ModelSelection, starred: readonly string[]): MenuModelRow {
  const currentSelection = instance.instanceId === selection.instanceId ? selection : undefined;
  const star = starKey(instance.instanceId, option.nativeModel ?? option.id, option.variant);
  return {
    option,
    ...(option.nativeModel ? { model: option.nativeModel } : {}),
    ...(option.variant ? { variant: option.variant } : {}),
    label: isFreeModel(instance) ? ownModelLabel(option.label) : shortModelLabel(option.label, provider),
    ...(repeatedModelLabels(all).has(option.label) && option.provider ? { route: option.provider } : {}),
    current: currentSelection ? choiceIsSelected(option, currentSelection) : false,
    blocked: option.orgBlocked === true,
    star,
    starred: starred.includes(star),
  };
}

export function simpleModelMenu(input: SimpleMenuInput): SimpleMenu {
  const { listed, selection, bot, expanded, probing } = input;
  const starred = input.starred ?? [];
  const models = new Map(listed.map((instance) => [instance.instanceId, listedModels(instance)]));
  const total = listed.filter((instance) => !instance.policy && !needsCli(instance))
    .reduce((sum, instance) => sum + models.get(instance.instanceId)!.all.length, 0);
  const search = input.searchAll === true || total > SIMPLE_SEARCH_AFTER || listed.some((instance) => takesTypedModels(instance) && !instance.policy && !needsCli(instance));
  const query = search ? input.query.trim() : "";
  const { subscription, api, custom } = splitEngineRail(listed);
  const ordered = [...subscription, ...api, ...custom];
  const current = ordered.find((instance) => instance.instanceId === selection.instanceId);

  function groupBody(instance: InstanceInfo, provider: string): MenuGroupBody | null {
    if (instance.policy) return query ? null : { kind: "policy", organization: instance.policy.organizationName, ...(instance.policy.team ? { team: true } : {}) };
    if (needsCli(instance)) return query ? null : { kind: "setUp" };
    const { signedOut, own, all } = models.get(instance.instanceId)!;
    if (all.length === 0) return query ? null : signedOut ? { kind: "signIn" } : { kind: "empty", loading: input.refreshing === instance.instanceId };
    const currentSelection = instance.instanceId === selection.instanceId ? selection : undefined;
    const botSelection = bot.follows === false && bot.selection.instanceId === instance.instanceId ? bot.selection : undefined;
    const row = (option: ModelChoice) => modelRow(instance, provider, all, option, selection, starred);
    const mixed = own.length > 0 && own.length < all.length;
    if (isFreeModel(instance)) {
      // Free model first, then the models the CLI marks free (`-free`) by name; its paid models answer 402 without a
      // login, so they are never listed. A catalog that marks none (an older CLI) is the Free model row alone.
      const nowId = freeModelNow(instance);
      const now = all.find((option) => option.id === nowId && !option.custom);
      const auto: MenuModelRow[] = now ? [{ ...row(now), option: { ...now, label: t("model.free.name") }, label: t("model.free.name"), auto: true }] : [];
      const named = all.filter((option) => option !== now && (option.custom || isFreeModelId(option.id)));
      if (query) {
        // the Free model row answers to its name, never to the id of the model behind it
        const rows = [...auto.filter((one) => filterCustomModels([{ id: "", label: one.label }], query).length > 0),
          ...filterCustomModels(named, query).map(row)];
        return rows.length === 0 ? null
          : { kind: "models", rows, total: named.length, toggle: null, localFrom: localFrom(rows, mixed), signInForOwn: false, probing: false };
      }
      const first = auto.filter((one) => !one.current);
      const pool = named.filter((option) => (!currentSelection || !choiceIsSelected(option, currentSelection))
        && (!botSelection || !choiceIsSelected(option, botSelection)));
      const suggested = suggestedModels(pool, "", undefined,
        currentSelection === undefined ? GROUP_SUGGESTIONS : CURRENT_GROUP_SUGGESTIONS);
      const more = pool.filter((option) => !suggested.includes(option));
      const open = expanded.has(instance.instanceId) || more.length === 1;
      const rows = [...first, ...(open ? [...suggested, ...more] : suggested).map(row)];
      if (rows.length === 0) return null;
      return {
        kind: "models", rows, total: named.length,
        toggle: more.length > 1 ? (open ? "less" : "more") : null,
        localFrom: localFrom(rows, mixed), signInForOwn: false, probing: false, freeToggle: true,
      };
    }
    if (query) {
      const rows = filterCustomModels(all, query).map(row);
      return rows.length === 0 ? null
        : { kind: "models", rows, total: all.length, toggle: null, localFrom: localFrom(rows, mixed), signInForOwn: false, probing: false };
    }
    const others = all.filter((option) => (!currentSelection || !choiceIsSelected(option, currentSelection))
      && (!botSelection || !choiceIsSelected(option, botSelection)));
    const suggested = suggestedModels(others, instance.models.default, undefined,
      currentSelection === undefined ? GROUP_SUGGESTIONS : CURRENT_GROUP_SUGGESTIONS);
    const rest = others.filter((option) => !suggested.includes(option));
    const open = expanded.has(instance.instanceId) || rest.length === 1;
    const rows = (open ? [...suggested, ...rest] : suggested).map(row);
    const looking = probing.has(instance.instanceId) && own.length === all.length;
    if (rows.length === 0 && !signedOut && !looking) return null;
    return {
      kind: "models", rows, total: all.length,
      toggle: rest.length > 1 ? (expanded.has(instance.instanceId) ? "less" : "more") : null,
      localFrom: localFrom(rows, mixed), signInForOwn: signedOut, probing: looking,
    };
  }

  const built = (current ? [current, ...ordered.filter((instance) => instance !== current)] : ordered).flatMap((instance): MenuGroup[] => {
    const named = heading(instance, listed);
    const body = groupBody(instance, named.provider);
    return body ? [{ instance, ...named, body }] : [];
  });
  const waits = (group: MenuGroup) => group.body.kind === "signIn" || group.body.kind === "setUp";
  const groups = built.filter((group) => !waits(group));

  // starred and recent models of providers that have models to pick now
  const pickable = (key: string): MenuStarredRow[] => {
    for (const instance of ordered) {
      if (instance.policy || needsCli(instance)) continue;
      const all = models.get(instance.instanceId)!.all as ModelChoice[];
      const option = all.find((one) => starKey(instance.instanceId, one.nativeModel ?? one.id, one.variant) === key);
      if (option && !option.orgBlocked) {
        const provider = providerName(instance);
        return [{ instance, provider, row: modelRow(instance, provider, all, option, selection, starred) }];
      }
    }
    return [];
  };
  const starredRows = query ? [] : starred.flatMap(pickable);
  const recentRows = query ? [] : (input.recent ?? []).filter((key) => !starred.includes(key)).flatMap(pickable)
    .filter((one) => !one.row.current).slice(0, RECENT_SHOWN);

  return {
    current: query ? null : currentRow(input),
    starred: starredRows,
    recent: recentRows,
    follow: !query && bot.follows === false,
    groups,
    connect: built.filter(waits),
    search,
    query,
    results: query ? groups.reduce((sum, group) => sum + (group.body.kind === "models" ? group.body.rows.length : 0), 0) : null,
    empty: listed.length > 0 ? null : input.loading ? "loading" : "none",
    busy: input.loading || input.refreshing != null,
  };
}

/** A provider that isn't connected here, as one Connect row in the picker. */
export interface NotConnectedRow {
  key: string;
  name: string;
  instance: InstanceInfo;
  /** Its card in Connect an AI, where the picker hands the connect over; none sends the row to the model directory. */
  tile?: AiTileId;
  /** Set up here before and signed out since, or never set up. */
  state: "signIn" | "setUp" | "new";
}

const inApp = (instance: InstanceInfo) => connectsInApp(instance as unknown as ConnectInstance);

/** The picker's Not connected rows: the providers listed here that wait for a sign-in or a setup, then the Connect an AI
 * cards that aren't connected yet. A local model lives in the directory, not here. */
export function notConnectedRows(instances: readonly InstanceInfo[], waiting: readonly MenuGroup[]): NotConnectedRow[] {
  const tiles = aiTiles(instances, engineReady, inApp).filter((tile) => tile.id !== "local");
  const rows: NotConnectedRow[] = [];
  for (const group of waiting) {
    const tile = tiles.find((one) => one.candidates.includes(group.instance));
    if (tile && rows.some((row) => row.tile === tile.id)) continue;
    rows.push({ key: tile?.id ?? group.instance.instanceId, name: tile?.label ?? group.label, instance: group.instance,
      ...(tile ? { tile: tile.id } : {}), state: group.body.kind === "setUp" ? "setUp" : "signIn" });
  }
  for (const tile of tiles) {
    if (engineReady(tile.instance) || rows.some((row) => row.tile === tile.id || tile.candidates.includes(row.instance))) continue;
    rows.push({ key: tile.id, name: tile.label, instance: tile.instance, tile: tile.id, state: "new" });
  }
  return rows;
}
