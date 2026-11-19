// A website's own icon for the Vault, the Apps catalog and links in chat. The app asks the site itself, so no icon
// service learns which sites someone keeps logins for or reads about.
//
// Adapted from Threebot's server/site-icons.mjs, MIT License, Copyright (c) 2026 Threebot contributors (full text in
// third_party/threebot/LICENSE); modified: addresses are classed by electron/egress-addresses.mjs, each request is
// pinned to the address that was checked so a DNS rebind cannot reach the local network, every icon (ICO and SVG
// included) is re-encoded to a 96px PNG with resvg instead of sharp, and one lookup has an overall deadline.
import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdirSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Resvg as ResvgClass } from "@resvg/resvg-js";

import { addressClass } from "../electron/egress-addresses.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { nativeRequire } from "./data/engine.ts";

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const SITE_ICON_SIZE = 96;
const MAX_PAGE = 512 * 1024, MAX_ICON = 1024 * 1024, MAX_HOPS = 3, TIMEOUT_MS = 8_000, DEADLINE_MS = 20_000;
const MAX_PIXELS = 16e6, MAX_SIDE = 8192;
const FOUND_FOR = 30 * 864e5, MISSING_FOR = 864e5;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function normalizeSiteDomain(value: unknown): string | null {
  const domain = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN.test(domain) ? domain : null;
}

/** Only public addresses: a saved login or a link must never make the app probe the network it sits on. */
export const isPublicAddress = (address: string): boolean => addressClass(address) === "public";

/** https on its own port with no credentials: anything else is not where a site keeps its icon. */
export function iconUrlAllowed(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443");
}

export interface IconAnswer { status: number; location: string | null; type: string; body: Buffer }
export type IconResolver = (host: string) => Promise<LookupAddress[]>;
/** One GET to `url` over a socket to `address` only. `partial` keeps the first `limit` bytes of a longer body. */
export type IconFetcher = (url: URL, address: LookupAddress, limit: number, partial: boolean, signal: AbortSignal) => Promise<IconAnswer>;

const resolveAll: IconResolver = (host) => dnsLookup(host, { all: true, verbatim: true });

const pinnedGet: IconFetcher = (url, address, limit, partial, signal) => new Promise((resolve, reject) => {
  // TLS and Host keep the name; only the socket is pinned to the checked address.
  const lookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const request = httpsRequest(url, {
    method: "GET", agent: false, lookup, signal,
    headers: { accept: "text/html,image/*;q=0.9,*/*;q=0.5", "accept-encoding": "identity", "user-agent": "Metal (site icon)" },
  }, (response) => {
    const status = response.statusCode ?? 0;
    const location = typeof response.headers.location === "string" ? response.headers.location : null;
    const type = String(response.headers["content-type"] ?? "").toLowerCase();
    const empty = { status, location, type, body: Buffer.alloc(0) };
    if (status < 200 || status >= 300) { response.destroy(); resolve(empty); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) { chunks.push(chunk); return; }
      response.destroy();
      if (partial) chunks.push(chunk.subarray(0, chunk.length - (size - limit)));
      resolve(partial ? { ...empty, body: Buffer.concat(chunks) } : { ...empty, status: 413 });
    });
    response.on("end", () => resolve({ ...empty, body: Buffer.concat(chunks) }));
    response.on("error", reject);
  });
  request.on("error", reject);
  request.end();
});

/** Candidates from a page's <link> tags, best first. */
export function iconLinks(html: string, base: URL): URL[] {
  const found: Array<{ url: URL; score: number }> = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || !/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const sizes = /\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
    const score = /\.svg(\?|$)/i.test(href) ? 512 : sizes ? Number(sizes) : rel.includes("apple-touch-icon") ? 180 : 32;
    try { found.push({ url: new URL(href.replaceAll("&amp;", "&"), base), score }); } catch { /* a broken link is not a logo */ }
  }
  return found.sort((a, b) => b.score - a.score).map((item) => item.url);
}

interface Raster { mime: "image/png" | "image/jpeg" | "image/gif"; width: number; height: number; bytes: Buffer }

/** A PNG, JPEG or GIF's own size, read from its header so a small file that decodes huge is refused before decoding. */
export function rasterInfo(bytes: Buffer): Raster | null {
  let mime: Raster["mime"] | null = null, width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    mime = "image/png"; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 10 && bytes.toString("latin1", 0, 4) === "GIF8") {
    mime = "image/gif"; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) { at += 1; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        mime = "image/jpeg"; height = bytes.readUInt16BE(at + 5); width = bytes.readUInt16BE(at + 7);
        break;
      }
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  if (!mime || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return null;
  return { mime, width, height, bytes };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, sum]);
}

/** Straight RGBA rows as an 8-bit PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const row = width * 4;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** An ICO's bitmap entry (bottom-up rows, then a 1-bit AND mask) as a PNG: 32, 24 and palette depths. */
function bitmapPng(dib: Buffer): Buffer | null {
  if (dib.length < 40) return null;
  const headerSize = dib.readUInt32LE(0), width = dib.readInt32LE(4), height = Math.abs(dib.readInt32LE(8)) / 2;
  const depth = dib.readUInt16LE(14), compression = dib.readUInt32LE(16);
  if (!Number.isInteger(height) || width < 1 || width > 256 || height < 1 || height > 256) return null;
  if (compression !== 0 && !(compression === 3 && depth === 32)) return null;
  if (![1, 4, 8, 24, 32].includes(depth)) return null;
  const colors = depth <= 8 ? (dib.readUInt32LE(32) || 1 << depth) : 0;
  const pixels = headerSize + colors * 4 + (compression === 3 && headerSize === 40 ? 12 : 0);
  const stride = Math.ceil((width * depth) / 32) * 4, maskStride = Math.ceil(width / 32) * 4;
  const mask = pixels + stride * height;
  if (mask > dib.length) return null;
  const hasMask = mask + maskStride * height <= dib.length;
  const rgba = Buffer.alloc(width * height * 4);
  let alpha = false;
  for (let y = 0; y < height; y++) {
    const from = pixels + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      let at = from + x * (depth >> 3);
      if (depth <= 8) {
        const bit = x * depth;
        const index = (dib[from + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        at = headerSize + index * 4;
      }
      rgba[out] = dib[at + 2]!;
      rgba[out + 1] = dib[at + 1]!;
      rgba[out + 2] = dib[at]!;
      rgba[out + 3] = depth === 32 ? dib[at + 3]! : 255;
      if (depth === 32 && rgba[out + 3]) alpha = true;
    }
  }
  // a 32-bit entry with no alpha at all leans on its mask, as every lower depth does
  if (hasMask && !(depth === 32 && alpha)) {
    for (let y = 0; y < height; y++) {
      const from = mask + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) {
        rgba[(y * width + x) * 4 + 3] = (dib[from + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255;
      }
    }
  }
  return encodePng(width, height, rgba);
}

/** The largest image in an ICO, as a raster resvg can draw. */
export function icoRaster(bytes: Buffer): Raster | null {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  let best: { size: number; depth: number; data: Buffer } | null = null;
  for (let index = 0, count = bytes.readUInt16LE(4); index < count; index++) {
    const at = 6 + index * 16;
    if (at + 16 > bytes.length) break;
    const size = bytes[at] || 256, depth = bytes.readUInt16LE(at + 6);
    const length = bytes.readUInt32LE(at + 8), offset = bytes.readUInt32LE(at + 12);
    if (offset + length > bytes.length || length === 0) continue;
    if (!best || size > best.size || (size === best.size && depth > best.depth)) best = { size, depth, data: bytes.subarray(offset, offset + length) };
  }
  if (!best) return null;
  if (best.data.subarray(0, 8).equals(PNG_SIGNATURE)) return rasterInfo(best.data);
  const png = bitmapPng(best.data);
  return png ? rasterInfo(png) : null;
}

const LOCAL_REF = /^#[\w.:-]*$/;
// a picture carried inside the SVG itself: resvg decodes it in memory and opens nothing
const EMBEDDED_RASTER = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]*$/;

/** A site's SVG only if everything it points at is inside itself: resvg reads local files an href or url() names. */
export function selfContainedSvg(source: string): string | null {
  // a DOCTYPE that only names the SVG DTD declares nothing, so it goes; one with declarations in it is refused below
  const text = source.replace(/<!DOCTYPE[^[>]*>/i, "");
  if (!/<svg[\s>]/i.test(text) || /<!(?:DOCTYPE|ENTITY)|@import/i.test(text)) return null;
  for (const match of text.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi)) {
    const ref = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!LOCAL_REF.test(ref) && !EMBEDDED_RASTER.test(ref)) return null;
  }
  for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    if (!LOCAL_REF.test((match[1] ?? match[2] ?? match[3] ?? "").trim())) return null;
  }
  return text;
}

let resvgModule: { Resvg: typeof ResvgClass } | null = null;
/** Required at first use from the staged tree, as server/data/render.ts does: esbuild cannot bundle its .node file. */
function loadResvg(): typeof ResvgClass {
  resvgModule ??= nativeRequire()("@resvg/resvg-js") as { Resvg: typeof ResvgClass };
  return resvgModule.Resvg;
}

const SQUARE = (href: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${SITE_ICON_SIZE}" height="${SITE_ICON_SIZE}" viewBox="0 0 ${SITE_ICON_SIZE} ${SITE_ICON_SIZE}"><image width="${SITE_ICON_SIZE}" height="${SITE_ICON_SIZE}" preserveAspectRatio="xMidYMid meet" href="${href}"/></svg>`;

function draw(svg: string, fit?: { mode: "width" | "height"; value: number }): Buffer {
  const Resvg = loadResvg();
  return new Resvg(svg, { font: { loadSystemFonts: false }, ...(fit ? { fitTo: fit } : {}) }).render().asPng();
}

/** Re-encoding means nothing from the site reaches the browser as it was sent, SVG scripts included. */
export function iconPng(type: string, bytes: Buffer): Buffer | null {
  if (!bytes.length) return null;
  try {
    let raster = rasterInfo(bytes) ?? icoRaster(bytes);
    const text = raster ? null : bytes.toString("utf8");
    if (!raster && text && (/svg/.test(type) || /^\s*(?:<\?xml|<svg)/i.test(text))) {
      const svg = selfContainedSvg(text);
      if (!svg) return null;
      const natural = new (loadResvg())(svg, { font: { loadSystemFonts: false } });
      const wide = natural.width >= natural.height;
      raster = rasterInfo(draw(svg, { mode: wide ? "width" : "height", value: SITE_ICON_SIZE }));
    }
    if (!raster) return null;
    return draw(SQUARE(`data:${raster.mime};base64,${raster.bytes.toString("base64")}`));
  } catch {
    return null;
  }
}

const APP_SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;
/** A Composio toolkit slug, the only thing an app logo is asked for by. */
export function normalizeAppSlug(value: unknown): string | null {
  const slug = String(value ?? "").trim().toLowerCase();
  return APP_SLUG.test(slug) ? slug : null;
}

export interface SiteIcons {
  get(domain: unknown): Promise<Buffer | null>;
  /** An app's Composio logo as the same 96px PNG: its SVG drawn here once, not in the window on every scroll. */
  app(slug: unknown): Promise<Buffer | null>;
}

export function createSiteIcons({ dir, resolve = resolveAll, fetcher = pinnedGet, encode = iconPng, now = Date.now }: {
  dir: string;
  resolve?: IconResolver;
  fetcher?: IconFetcher;
  encode?: (type: string, bytes: Buffer) => Buffer | null;
  now?: () => number;
}): SiteIcons {
  const running = new Map<string, Promise<Buffer | null>>();

  async function fetchPublic(start: URL, limit: number, partial: boolean, signal: AbortSignal) {
    let url = start;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!iconUrlAllowed(url)) return null;
      const addresses = await resolve(url.hostname.replace(/^\[|\]$/g, "")).catch(() => []);
      // every address the name has, checked after resolution: one private answer among public ones is a rebind setup
      if (!addresses.length || !addresses.every(({ address }) => isPublicAddress(address))) return null;
      const answer = await fetcher(url, addresses[0]!, limit, partial, AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]));
      if (answer.status >= 300 && answer.status < 400) {
        if (!answer.location) return null;
        url = new URL(answer.location, url);
        continue;
      }
      if (answer.status < 200 || answer.status >= 300) return null;
      return { url, type: answer.type, body: answer.body };
    }
    return null;
  }

  async function find(domain: string): Promise<{ icon: Buffer | null; unsure: boolean }> {
    // a slow or unreachable site is not a site without a logo, so only an answer gets remembered
    let unsure = false;
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const attempt = <T>(run: () => Promise<T>) => run().catch(() => { unsure = true; return null; });
    const home = new URL(`https://${domain}/`);
    const page = await attempt(() => fetchPublic(home, MAX_PAGE, true, signal));
    const links = page && /html/.test(page.type) ? iconLinks(page.body.toString("utf8"), page.url) : [];
    for (const url of [...links.slice(0, 4), new URL("/favicon.ico", page?.url ?? home)]) {
      if (signal.aborted) return { icon: null, unsure: true };
      const icon = await attempt(async () => {
        const got = await fetchPublic(url, MAX_ICON, false, signal);
        return got ? encode(got.type, got.body) : null;
      });
      if (icon) return { icon, unsure };
    }
    return { icon: null, unsure };
  }

  async function findAppLogo(slug: string): Promise<{ icon: Buffer | null; unsure: boolean }> {
    try {
      const got = await fetchPublic(new URL(`https://logos.composio.dev/api/${slug}`), MAX_ICON, false, AbortSignal.timeout(DEADLINE_MS));
      return { icon: got ? encode(got.type, got.body) : null, unsure: false };
    } catch {
      return { icon: null, unsure: true };
    }
  }

  async function load(name: string, find: () => Promise<{ icon: Buffer | null; unsure: boolean }>): Promise<Buffer | null> {
    const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
    const found = join(dir, `${key}.png`), missing = join(dir, `${key}.miss`);
    const kept = await stat(found).catch(() => null);
    const stale = kept ? await readFile(found).catch(() => null) : null;
    if (kept && stale && now() - kept.mtimeMs < FOUND_FOR) return stale;
    const missed = await stat(missing).catch(() => null);
    if (!stale && missed && now() - missed.mtimeMs < MISSING_FOR) return null;
    const { icon, unsure } = await find();
    try {
      mkdirSync(dir, { recursive: true });
      if (icon) {
        writeFileAtomic(found, icon, { durable: false });
        rmSync(missing, { force: true });
      } else if (!unsure) {
        writeFileAtomic(missing, "", { durable: false });
        rmSync(found, { force: true });
      }
    } catch {
      // an unwritable cache only costs a refetch
    }
    return icon ?? (unsure ? stale : null);
  }

  const once = (name: string, find: () => Promise<{ icon: Buffer | null; unsure: boolean }>) => {
    let pending = running.get(name);
    if (!pending) {
      pending = load(name, find).finally(() => running.delete(name));
      running.set(name, pending);
    }
    return pending;
  };

  return {
    get(value) {
      const domain = normalizeSiteDomain(value);
      return domain ? once(domain, () => find(domain)) : Promise.resolve(null);
    },
    app(value) {
      const slug = normalizeAppSlug(value);
      return slug ? once(`app:${slug}`, () => findAppLogo(slug)) : Promise.resolve(null);
    },
  };
}
