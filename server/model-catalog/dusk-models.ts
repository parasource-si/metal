import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import type { ModelCatalog } from "../contracts.ts";
import { CATALOG_DISABLE_ENV } from "./catalog.ts";
import bundledCatalog from "./dusk-models.json" with { type: "json" };

/** Served from the site (apps/site/public/landing/releases/models.json), so a model can be added without a release. */
export const DUSK_MODELS_URL = "https://dusk.bot/releases/models.json";
export const DUSK_MODELS_URL_ENV = "DUSK_MODEL_CATALOG_URL";
export const DUSK_MODELS_REFRESH_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const MAX_MODELS = 200;
const ENGINE_KEY = /^[a-z][a-z0-9-]{0,40}$/;
const MODEL_ID = /^[\w][\w./:+-]{0,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

export interface CuratedModel {
  id: string;
  label: string;
  /** Offered even when the engine's own list leaves it out, e.g. an engine CLI older than the model. */
  add?: true;
  contextWindow?: number;
}

export interface CuratedEngine {
  default?: string;
  models: CuratedModel[];
}

export interface DuskModelsDocument {
  schema: 1;
  updatedAt: string;
  engines: Record<string, CuratedEngine>;
}

export type DuskModelsRefresh = "disabled" | "fresh" | "updated" | "unchanged" | "failed";

/** A document from any source (bundled, cache, dusk.bot), or null when it is not one. Bad rows are left out. */
export function parseDuskModels(raw: unknown): DuskModelsDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as { schema?: unknown; updatedAt?: unknown; engines?: unknown };
  if (doc.schema !== 1 || typeof doc.updatedAt !== "string" || Number.isNaN(Date.parse(doc.updatedAt))) return null;
  if (!doc.engines || typeof doc.engines !== "object" || Array.isArray(doc.engines)) return null;
  const engines: Record<string, CuratedEngine> = {};
  for (const [key, value] of Object.entries(doc.engines as Record<string, unknown>)) {
    if (!ENGINE_KEY.test(key) || !value || typeof value !== "object") continue;
    const entry = value as { default?: unknown; models?: unknown };
    if (!Array.isArray(entry.models)) continue;
    const models: CuratedModel[] = [];
    const seen = new Set<string>();
    for (const row of entry.models.slice(0, MAX_MODELS)) {
      if (!row || typeof row !== "object") continue;
      const model = row as { id?: unknown; label?: unknown; add?: unknown; contextWindow?: unknown };
      if (typeof model.id !== "string" || !MODEL_ID.test(model.id) || seen.has(model.id)) continue;
      if (typeof model.label !== "string" || !model.label.trim() || model.label.length > 80 || CONTROL.test(model.label)) continue;
      seen.add(model.id);
      models.push({
        id: model.id,
        label: model.label.trim(),
        ...(model.add === true ? { add: true as const } : {}),
        ...(Number.isSafeInteger(model.contextWindow) && (model.contextWindow as number) > 0 ? { contextWindow: model.contextWindow as number } : {}),
      });
    }
    engines[key] = {
      ...(typeof entry.default === "string" && seen.has(entry.default) ? { default: entry.default } : {}),
      models,
    };
  }
  return { schema: 1, updatedAt: new Date(Date.parse(doc.updatedAt)).toISOString(), engines };
}

const isVersion = (token: string) => /^\d+(\.\d+)*$/.test(token);
const WORDS: Record<string, string> = { gpt: "GPT", ai: "AI", oss: "OSS" };

/** "gpt-6.2-astra" or "GPT-6.2-Astra" → "GPT-6.2 Astra"; "claude-opus-5-5" → "Claude Opus 5.5". A name with spaces is kept. */
export function prettyModelLabel(label: string, id: string): string {
  const source = label.trim() || id;
  if (/\s/.test(source)) return source;
  const tokens: string[] = [];
  for (const token of source.split(/[-_]/).filter(Boolean)) {
    const previous = tokens[tokens.length - 1];
    if (previous !== undefined && /^\d{1,2}$/.test(token) && /^\d{1,2}(\.\d{1,2})*$/.test(previous)) {
      tokens[tokens.length - 1] = `${previous}.${token}`;
      continue;
    }
    tokens.push(token);
  }
  const words = tokens.map((token) => WORDS[token.toLowerCase()] ?? (/[A-Z]/.test(token) ? token : token.charAt(0).toUpperCase() + token.slice(1)));
  let out = "";
  words.forEach((word, index) => {
    if (index === 0) out = word;
    else out += words[index - 1] === "GPT" && index === 1 && isVersion(word) ? `-${word}` : ` ${word}`;
  });
  return out || id;
}

/**
 * The engine's list with our names, plus the curated models marked `add` that it leaves out, each placed before the
 * next curated model the engine lists. The engine's order, default and per-row details stay; custom rows are untouched.
 */
export function curateModelCatalog(catalog: ModelCatalog, curated: CuratedEngine | undefined): ModelCatalog {
  if (!curated || !catalog.options.length && !curated.models.some((model) => model.add)) return catalog;
  const byId = new Map(curated.models.map((model) => [model.id, model]));
  const options: ModelCatalog["options"] = catalog.options.map((option) => {
    if (option.custom) return option;
    const known = byId.get(option.id);
    if (!known) return { ...option, label: prettyModelLabel(option.label, option.id) };
    return {
      ...option,
      label: known.label,
      ...(option.contextWindow === undefined && known.contextWindow ? { contextWindow: known.contextWindow } : {}),
    };
  });
  const listed = new Set(options.map((option) => option.id));
  curated.models.forEach((model, index) => {
    if (!model.add || listed.has(model.id)) return;
    const next = curated.models.slice(index + 1).find((later) => listed.has(later.id));
    const firstCustom = options.findIndex((option) => option.custom);
    const at = next ? options.findIndex((option) => option.id === next.id) : firstCustom === -1 ? options.length : firstCustom;
    options.splice(at, 0, { id: model.id, label: model.label, ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}) });
    listed.add(model.id);
  });
  const fallback = curated.default && listed.has(curated.default) ? curated.default : options[0]?.id ?? "";
  return { default: listed.has(catalog.default) ? catalog.default : fallback, options };
}

export interface DuskModelCatalogOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  bundled?: unknown;
  log?: (message: string) => void;
}

interface CacheFile {
  fetchedAt: number;
  doc: DuskModelsDocument;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Our curated model names and additions: the newest of the bundled copy and the last one fetched from dusk.bot. */
export class DuskModelCatalog {
  private readonly options: DuskModelCatalogOptions;
  private readonly cachePath: string;
  private memo: DuskModelsDocument | undefined;
  private readonly curatedMemo = new WeakMap<ModelCatalog, { doc: DuskModelsDocument; key: string; out: ModelCatalog }>();
  private inflight: Promise<DuskModelsRefresh> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: DuskModelCatalogOptions) {
    this.options = options;
    this.cachePath = join(options.dataDir, "providers", "model-providers", "dusk-models.json");
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(text: string): void {
    (this.options.log ?? ((line: string) => console.warn(line)))(`[dusk-models] ${text}`);
  }

  /** https on dusk.bot by default; an override must be https too, or http on this machine (tests and fixtures). */
  get url(): string | null {
    const raw = this.env[DUSK_MODELS_URL_ENV] || DUSK_MODELS_URL;
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url.href;
    } catch {}
    return null;
  }

  private readCache(): CacheFile | null {
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, "utf8")) as { fetchedAt?: unknown; doc?: unknown };
      const doc = parseDuskModels(raw.doc);
      return doc && typeof raw.fetchedAt === "number" ? { fetchedAt: raw.fetchedAt, doc } : null;
    } catch {
      return null;
    }
  }

  get(): DuskModelsDocument {
    if (this.memo) return this.memo;
    const bundled = parseDuskModels(this.options.bundled ?? bundledCatalog) ?? { schema: 1 as const, updatedAt: new Date(0).toISOString(), engines: {} };
    const cached = this.readCache()?.doc;
    this.memo = cached && Date.parse(cached.updatedAt) > Date.parse(bundled.updatedAt) ? cached : bundled;
    return this.memo;
  }

  /** The engine's list merged with ours; the same object back for the same list, so a getter can call it on every read. */
  curate(key: string, catalog: ModelCatalog): ModelCatalog {
    const doc = this.get();
    const held = this.curatedMemo.get(catalog);
    if (held && held.doc === doc && held.key === key) return held.out;
    const out = curateModelCatalog(catalog, doc.engines[key]);
    this.curatedMemo.set(catalog, { doc, key, out });
    return out;
  }

  /** Skipped while the last fetch is under DUSK_MODELS_REFRESH_MS old, unless `force`. Never throws. */
  refresh(options: { force?: boolean } = {}): Promise<DuskModelsRefresh> {
    if (this.env[CATALOG_DISABLE_ENV] === "1") return Promise.resolve("disabled");
    this.inflight ??= this.fetchAndStore(Boolean(options.force)).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  /** Fetches now and every few hours; `later` runs after each later attempt (start-up reads the engines' lists itself). */
  start(later?: () => Promise<void>): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh().then(() => later?.()).catch(() => {}); }, DUSK_MODELS_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async fetchAndStore(force: boolean): Promise<DuskModelsRefresh> {
    const cached = this.readCache();
    const age = cached ? this.now - cached.fetchedAt : Infinity;
    if (!force && age >= 0 && age < DUSK_MODELS_REFRESH_MS) return "fresh";
    const url = this.url;
    if (!url) {
      this.log(`${DUSK_MODELS_URL_ENV} must be an https address`);
      return "failed";
    }
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        headers: { accept: "application/json", "user-agent": "Metal" },
        // Only the address above, never one it redirects to.
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await readCapped(response, MAX_BYTES);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new Error("invalid JSON"); }
      const doc = parseDuskModels(raw);
      if (!doc) throw new Error("not a model catalog");
      const before = this.get();
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileAtomic(this.cachePath, JSON.stringify({ fetchedAt: this.now, doc } satisfies CacheFile), { durable: false });
      this.memo = undefined;
      return JSON.stringify(this.get()) === JSON.stringify(before) ? "unchanged" : "updated";
    } catch (error) {
      this.log(`could not refresh the model list from dusk.bot (${error instanceof Error ? error.message : String(error)}); keeping the current one`);
      return "failed";
    }
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`more than ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new Error(`more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
