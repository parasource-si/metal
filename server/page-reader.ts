// Reads a web page as clean text for a bot whose engine has no fetch of its own. The fetch is wait-probes' public-only
// one: every address a name resolves to must be public, the socket is pinned to the checked address so a DNS rebind
// cannot reach this machine or its network, each redirect is checked again, and size and time are capped.
import { fetchPublicPage, type PageFetchOptions } from "./wait-probes.ts";

export const READ_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const READ_PAGE_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (compatible; Metal page reader)";

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  middot: "\u00b7", bull: "\u2022", times: "\u00d7", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", deg: "\u00b0",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] !== "#") return NAMED[body.toLowerCase()] ?? whole;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

const DROPPED = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "head", "nav", "footer", "aside", "form", "button", "select", "dialog"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const BLOCKS = new Set(["p", "div", "section", "article", "main", "header", "table", "tr", "ul", "ol", "dl", "dt", "dd", "blockquote", "figure", "figcaption", "address", "details", "summary", "hr"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "area", "base", "col", "embed", "track", "param"]);

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
};

/** The part of a page a person reads: its <main>, else its <article>, else everything; a region with almost no text
 * (a main that only wraps a form) falls back to everything. */
function readableRegion(html: string): string {
  for (const name of ["main", "article"]) {
    const open = new RegExp(`<${name}[\\s>]`, "i").exec(html);
    const close = html.toLowerCase().lastIndexOf(`</${name}`);
    if (open && close > open.index && html.slice(open.index, close).replace(/<[^>]*>/g, "").trim().length >= 200) {
      return html.slice(open.index, close);
    }
  }
  return html;
}

export interface ReadablePage { title: string; text: string }

/**
 * A page as plain text that keeps its shape: headings as `#` lines, list items as `- ` lines, links as [text](url),
 * paragraphs apart. One pass over the markup with no backtracking patterns, so a hostile page costs milliseconds.
 */
export function readableText(html: string, base: URL): ReadablePage {
  const titleMatch = /<title[^>]*>([^<]*)<\/title/i.exec(html);
  const title = decodeEntities(titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim();
  const source = readableRegion(html);
  const out: string[] = [];
  const links: Array<{ at: number; href: string | null }> = [];
  let dropped: string | null = null;
  let droppedDepth = 0;
  const breakLine = (blank: boolean) => out.push(blank ? "\n\n" : "\n");
  for (let at = 0; at < source.length;) {
    const open = source.indexOf("<", at);
    if (open === -1) { if (!dropped) out.push(source.slice(at)); break; }
    if (open > at && !dropped) out.push(source.slice(at, open));
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      at = end === -1 ? source.length : end + 3;
      continue;
    }
    const end = source.indexOf(">", open + 1);
    if (end === -1) { if (!dropped) out.push(source.slice(open)); break; }
    const tag = source.slice(open, end + 1);
    at = end + 1;
    const named = /^<\/?([a-zA-Z][\w-]*)/.exec(tag);
    if (!named) { if (!dropped && !tag.startsWith("<!") && !tag.startsWith("<?")) out.push(tag); continue; }
    const name = named[1]!.toLowerCase();
    const closing = tag[1] === "/";
    const selfClosing = tag.endsWith("/>") || VOID.has(name);
    if (!closing && RAW.has(name)) {
      const close = source.toLowerCase().indexOf(`</${name}`, at);
      const stop = close === -1 ? source.length : close;
      if (name === "textarea" && !dropped) out.push(source.slice(at, stop));
      const after = close === -1 ? -1 : source.indexOf(">", close);
      at = after === -1 ? source.length : after + 1;
      continue;
    }
    if (dropped) {
      if (name === dropped && !selfClosing) droppedDepth += closing ? -1 : 1;
      if (droppedDepth === 0) dropped = null;
      continue;
    }
    if (!closing && DROPPED.has(name) && !selfClosing) { dropped = name; droppedDepth = 1; continue; }
    if (/^h[1-6]$/.test(name)) { breakLine(true); if (!closing) out.push(`${"#".repeat(Number(name[1]))} `); continue; }
    if (name === "li") { if (!closing) out.push("\n- "); continue; }
    if (name === "br") { out.push("\n"); continue; }
    if (name === "pre") { breakLine(true); continue; }
    if (name === "td" || name === "th") { if (!closing) out.push(" | "); continue; }
    if (name === "img" && !closing) {
      const alt = attribute(tag, "alt")?.trim();
      if (alt) out.push(` [image: ${alt}] `);
      continue;
    }
    if (name === "a") {
      if (!closing) {
        const raw = attribute(tag, "href");
        let href: string | null = null;
        try { if (raw) { const url = new URL(raw, base); if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") href = url.href; } } catch { /* a broken link is just text */ }
        links.push({ at: out.length, href });
        out.push("");
      } else {
        const link = links.pop();
        if (link?.href) {
          const text = out.slice(link.at + 1).join("").replace(/\s+/g, " ").trim();
          if (text && text !== link.href) { out.length = link.at; out.push(`[${text}](${link.href})`); }
        }
      }
      continue;
    }
    if (BLOCKS.has(name)) breakLine(name === "p" || name === "blockquote" || name === "table" || name === "hr");
  }
  const text = decodeEntities(out.join(""))
    .replace(/[ \t\f\v\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(#{1,6}) *\n+/gm, "$1 ")
    .trim();
  return { title, text };
}

export type PageRead = { ok: true; url: string; title: string; text: string; cut: boolean } | { ok: false; url: string; error: string };

export type ReadPageOptions = Pick<PageFetchOptions, "lookup" | "allow" | "timeoutMs" | "maxBytes" | "maxRedirects">;

const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|[\w.+-]+\+(?:json|xml))\b)/;

function charsetOf(type: string): string {
  const named = /charset\s*=\s*"?([\w.:-]+)/i.exec(type)?.[1]?.toLowerCase() ?? "utf-8";
  try { return new TextDecoder(named).encoding; } catch { return "utf-8"; }
}

/** One page, fetched from the public web only, as readable text. */
export async function readPage(raw: string, options: ReadPageOptions = {}): Promise<PageRead> {
  const maxBytes = options.maxBytes ?? READ_PAGE_MAX_BYTES;
  const page = await fetchPublicPage(raw, { timeoutMs: READ_PAGE_TIMEOUT_MS, ...options, maxBytes, userAgent: USER_AGENT });
  if (!page.ok) return { ok: false, url: raw, error: page.error };
  const type = String(page.headers["content-type"] ?? "").toLowerCase();
  const html = !type || /html/.test(type);
  if (!html && !TEXT_TYPES.test(type)) {
    return { ok: false, url: page.url.href, error: `This is a ${type.split(";")[0]} file, not a page that reads as text.` };
  }
  const body = new TextDecoder(charsetOf(type)).decode(page.body);
  const cut = page.body.length >= maxBytes;
  if (!html) return { ok: true, url: page.url.href, title: "", text: body.trim(), cut };
  const { title, text } = readableText(body, page.url);
  return { ok: true, url: page.url.href, title, text, cut };
}
