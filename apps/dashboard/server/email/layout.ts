// every value from data is escaped in this file; templates pass raw strings

export interface EmailConfig {
  /** where the email art lives, no trailing slash (DUSK_EMAIL_ASSET_BASE) */
  assets: string;
  /** the marketing site: download, docs, privacy */
  site: string;
  /** the account page (publicUrl plus page base): billing, cloud, devices */
  app: string;
  /** the postal address legal wants in marketing mail; null leaves the line out */
  address: string | null;
}

export type Tone = "info" | "warn" | "alert";
export type Accent = "lemon" | "lime" | "pink" | "lav" | "sky";
export type Mark = "ok" | "warn" | "off" | "bad";
export type Block =
  | { t: "h1"; text: string }
  | { t: "h2"; text: string }
  | { t: "p"; text: string; small?: boolean }
  | { t: "button"; label: string; href: string }
  | { t: "link"; label: string; href: string; before?: string }
  | { t: "code"; code: string }
  | { t: "facts"; rows: Array<[label: string, value: string, mark?: Mark]> }
  | { t: "total"; label: string; value: string }
  | { t: "stats"; items: Array<[label: string, value: string, sub?: string]> }
  | { t: "label"; text: string }
  | { t: "cmd"; text: string }
  | { t: "log"; text: string }
  | { t: "steps"; items: Array<{ title: string; text: string }> }
  | { t: "list"; items: string[] }
  | { t: "tips"; items: Array<{ image: string; alt: string; title: string; text: string }> }
  | { t: "note"; text: string; tone?: Tone }
  | { t: "cloud"; eyebrow: string; title: string; text: string; points: string[]; price: string; fine: string; cta: { label: string; href: string }; image: string; alt: string }
  | { t: "feature"; image: string | null; alt: string; title: string; text: string };

export interface Email {
  subject: string;
  /** the line inbox lists show after the subject */
  preheader: string;
  /** the small mono label beside the wordmark: what kind of email this is */
  tag: string;
  /** what kit says in the bubble: the gist in a few words */
  say: string;
  /** the bubble's pastel: lemon codes and heads-ups, lime money and good news, pink trouble, lav goodbyes and digests, sky hellos */
  accent: Accent;
  /** a small status chip above the heading, for alerts */
  status?: [text: string, mark: Mark];
  blocks: Block[];
  /** why this arrived; promo mail also carries an unsubscribe link */
  reason: string;
  unsubscribe?: string;
  /** a code, a receipt or "cloud ready": sent through resend (no tracking pixel, no wrapped links, no list-unsubscribe)
   *  with a footer of no links, so gmail files it in primary (auth/mail-router.ts) */
  transactional?: boolean;
}
export interface Rendered { subject: string; html: string; text: string; transactional?: boolean }

const C = {
  page: "#fdfdfd", off: "#f6f6f4", ink: "#1b1b1f", body: "#222228", muted: "#73737c", kit: "#894ef0", log: "#232328",
  skyWash: "#e9f7fd", lemon: "#fff3a0", lime: "#c9f63f", pink: "#ffc4dd", lav: "#d0cefb", sky: "#c2ecfc", green: "#14864f", amber: "#a86a00", red: "#c8325f",
};
const SANS = "'General Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";

export const esc = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]!);
/** **bold** is the only markup prose may carry */
const prose = (value: string) => esc(value).replace(/\*\*(.+?)\*\*/g, "<b style=\"font-weight:600;color:" + C.ink + "\" class=\"ink\">$1</b>");
const plain = (value: string) => value.replace(/\*\*(.+?)\*\*/g, "$1");
const img = (cfg: EmailConfig, name: string) => /^https?:\/\//.test(name) ? name : `${cfg.assets}/${name}`;

const T = (inner: string, style = "", width = "100%") =>
  `<table role="presentation"${width ? ` width="${width}"` : ""} cellpadding="0" cellspacing="0" border="0" style="${style}">${inner}</table>`;
const cell = (size: number, colour: string | null, cls: string) =>
  `<td width="${size}" height="${size}"${colour ? ` bgcolor="${colour}"` : ""}${cls ? ` class="${cls}"` : ""} style="width:${size}px;height:${size}px;${colour ? `background:${colour};` : ""}font-size:0;line-height:0;mso-line-height-rule:exactly"></td>`;
/** a tonal block with the site's stepped pixel corner: a square cut from each corner, an optional tinted underside */
function stepped(inner: string, o: { fill: string; cls: string; pad: string; under?: string; align?: "center" | "left"; margin?: string; w?: number; auto?: boolean }) {
  const w = o.w ?? 4;
  const edge = (bottom: boolean) => {
    const colour = bottom && o.under ? o.under : o.fill, cls = bottom && o.under ? "" : o.cls;
    return `<tr>${cell(w, C.page, "pg")}<td height="${w}" bgcolor="${colour}"${cls ? ` class="${cls}"` : ""} style="height:${w}px;background:${colour};font-size:0;line-height:0;mso-line-height-rule:exactly"></td>${cell(w, C.page, "pg")}</tr>`;
  };
  return T(`${edge(false)}<tr><td colspan="3" bgcolor="${o.fill}" class="${o.cls}" align="${o.align ?? "left"}" style="background:${o.fill};padding:${o.pad}">${inner}</td></tr>${edge(true)}`,
    `margin:${o.margin ?? "0"}`, o.auto ? "" : "100%");
}

// drawn in table cells so it shows with images off
const KIT = [".#........#.", ".##......##.", ".###....###.", ".##########.", "############", "###o####o###", "###o####o###", "############", ".##########.", "..########.."];
const kit = (px: number) => `<table role="presentation" aria-hidden="true" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${KIT.map(row =>
  `<tr>${[...row].map(ch => cell(px, ch === "#" ? C.kit : ch === "o" ? C.page : null, ch === "#" ? "kit" : ch === "o" ? "kit-eye" : "")).join("")}</tr>`).join("")}</table>`;
function hero(email: Email) {
  const acc = C[email.accent], cls = `a-${email.accent}`;
  const tail = T([1, 1, 0].map((_, i) => `<tr>${cell(6, i === 1 ? acc : C.page, i === 1 ? cls : "pg")}${cell(6, acc, cls)}</tr>`).join(""), "", "");
  const bubble = stepped(`<div class="ink" style="font-family:${SANS};font-size:17px;line-height:22px;font-weight:600;letter-spacing:-0.01em;color:${C.ink}">${esc(email.say)}</div>`,
    { fill: acc, cls, pad: "9px 16px", w: 5, auto: true });
  return T(`<tr><td width="84" valign="bottom">${kit(6)}</td><td width="14" valign="middle" style="padding-bottom:18px">${tail}</td><td valign="middle" style="padding-bottom:18px">${bubble}</td></tr>`, "margin:0 0 30px");
}

const markColor: Record<Mark, string> = { ok: C.green, warn: C.amber, off: C.muted, bad: C.red };
const pillFill: Record<Mark, [string, string]> = { ok: ["#e6f7c0", "pill-ok"], warn: ["#fff6c4", "pill-warn"], off: [C.off, "box"], bad: ["#ffe0ec", "pill-bad"] };
const statusPill = ([text, mark]: [string, Mark]) => T(`<tr><td bgcolor="${pillFill[mark][0]}" class="${pillFill[mark][1]}" style="background:${pillFill[mark][0]};padding:4px 10px;font-family:${MONO};font-size:12.5px;line-height:18px;color:${C.ink}"><span class="ink" style="color:${C.ink}"><span style="color:${markColor[mark]}">&#9679;</span>&nbsp;${esc(text)}</span></td></tr>`, "margin:0 0 14px", "");

function button(label: string, href: string, fill = C.ink) {
  const dark = fill === C.ink;
  return T(`<tr><td bgcolor="${fill}"${dark ? ' class="btn"' : ""} style="background:${fill}"><a${dark ? ' class="btn-a"' : ""} href="${esc(href)}" target="_blank" style="display:inline-block;padding:11px 22px;font-family:${SANS};font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:${dark ? C.page : C.ink};text-decoration:none">${esc(label)}</a></td></tr>`, "", "");
}

const tones: Record<Tone, { bg: string; edge: string; cls: string }> = {
  info: { bg: C.off, edge: C.sky, cls: "box" }, warn: { bg: "#fffbe2", edge: C.lemon, cls: "note-warn" }, alert: { bg: "#fff3f8", edge: C.pink, cls: "note-alert" },
};
const rowsHtml = (rows: Array<[string, string, Mark?]>) => T(rows.map(([label, value, mark]) =>
  `<tr><td valign="top" class="muted" style="padding:9px 0;font-family:${SANS};font-size:14px;line-height:20px;color:${C.muted}">${esc(label)}</td>
<td valign="top" align="right" class="ink" style="padding:9px 0 9px 12px;font-family:${SANS};font-size:15px;line-height:20px;font-weight:500;color:${C.ink};font-variant-numeric:tabular-nums;word-break:break-word">${mark ? `<span style="color:${markColor[mark]};font-size:13px">&#9679;</span>&nbsp;` : ""}${esc(value)}</td></tr>`).join("\n"));

function blockHtml(cfg: EmailConfig, block: Block, accent: Accent): string {
  const p = (inner: string, style = "") => `<p class="soft" style="margin:0 0 18px;font-family:${SANS};font-size:15.5px;line-height:24px;font-weight:500;color:${C.body};${style}">${inner}</p>`;
  switch (block.t) {
    case "h1": return `<h1 class="ink h1" style="margin:0 0 10px;font-family:${SANS};font-size:26px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${C.ink}">${esc(block.text)}</h1>`;
    case "h2": return `<h2 class="ink" style="margin:14px 0 12px;font-family:${SANS};font-size:19px;line-height:26px;font-weight:600;letter-spacing:-0.015em;color:${C.ink}">${esc(block.text)}</h2>`;
    case "p": return block.small ? p(prose(block.text), `font-size:14px;line-height:22px;color:${C.muted}`) : p(prose(block.text));
    case "button": return `<div style="margin:6px 0 24px">${button(block.label, block.href)}</div>`;
    case "link": return p(`${block.before ? `${esc(block.before)} ` : ""}<a class="ink" href="${esc(block.href)}" target="_blank" style="color:${C.ink};font-weight:600;text-decoration:underline;text-underline-offset:3px">${esc(block.label)}</a>`, "font-size:15px;line-height:24px");
    // one string, so copy, paste and one-tap code fill see the whole code; the gap after the fourth digit is padding, not a character
    case "code": return stepped(`<div class="ink" style="font-family:${MONO};font-size:36px;line-height:44px;font-weight:600;letter-spacing:0.12em;color:${C.ink};-webkit-user-select:all;user-select:all">${
      block.code.length === 8 ? `<span style="padding-right:10px">${esc(block.code.slice(0, 4))}</span>${esc(block.code.slice(4))}` : esc(block.code)}</div>`,
      { fill: C.off, cls: "box", under: C[accent], pad: "18px 12px", align: "center", margin: "4px 0 20px" });
    case "facts": return stepped(rowsHtml(block.rows), { fill: C.off, cls: "box", pad: "6px 16px", margin: "0 0 22px" });
    case "total": return T(`<tr><td class="muted" style="font-family:${SANS};font-size:15px;line-height:20px;color:${C.muted}">${esc(block.label)}</td><td align="right" class="ink" style="font-family:${SANS};font-size:30px;line-height:36px;font-weight:600;letter-spacing:-0.02em;color:${C.ink};font-variant-numeric:tabular-nums">${esc(block.value)}</td></tr>`, "margin:0 0 6px");
    case "stats": {
      const one = ([label, value, sub]: [string, string, string?], i: number) => `<td width="50%" valign="top" style="width:50%;padding:${i % 2 ? "0 0 10px 5px" : "0 5px 10px 0"}">${stepped(
        `<div class="muted" style="font-family:${MONO};font-size:12.5px;line-height:18px;color:${C.muted}">${esc(label)}</div><div class="ink" style="padding-top:6px;font-family:${SANS};font-size:28px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${C.ink};font-variant-numeric:tabular-nums">${esc(value)}</div>${
          sub ? `<div class="soft" style="padding-top:4px;font-family:${SANS};font-size:13px;line-height:18px;color:${C.body}">${esc(sub)}</div>` : ""}`,
        { fill: C.off, cls: "box", pad: "12px 14px 14px" })}</td>`;
      const rows: string[] = [];
      for (let i = 0; i < block.items.length; i += 2) rows.push(`<tr>${one(block.items[i]!, 0)}${block.items[i + 1] ? one(block.items[i + 1]!, 1) : '<td width="50%"></td>'}</tr>`);
      return T(rows.join(""), "margin:4px 0 14px");
    }
    case "label": return `<div class="muted" style="margin:6px 0 8px;font-family:${MONO};font-size:12.5px;line-height:18px;letter-spacing:0.02em;color:${C.muted}">${esc(block.text)}</div>`;
    case "cmd": return stepped(`<div class="ink" style="font-family:${MONO};font-size:13.5px;line-height:20px;color:${C.ink};word-break:break-all">${esc(block.text)}</div>`, { fill: C.off, cls: "box", pad: "11px 14px", margin: "0 0 16px" });
    case "log": return stepped(`<div style="font-family:${MONO};font-size:12.5px;line-height:19px;color:#e9e9ee;white-space:pre-wrap;word-break:break-word">${esc(block.text)}</div>`, { fill: C.log, cls: "", pad: "12px 14px", margin: "0 0 22px" });
    case "steps": return T(block.items.map((item, i) => `<tr><td valign="top" width="40" style="padding:0 0 16px"><div style="width:28px;height:28px;line-height:28px;text-align:center;background:${C.lime};font-family:${MONO};font-size:13px;font-weight:600;color:${C.ink}">${i + 1}</div></td>
<td valign="top" style="padding:3px 0 16px"><div class="ink" style="font-family:${SANS};font-size:16px;line-height:22px;font-weight:600;color:${C.ink}">${esc(item.title)}</div>
<div class="soft" style="font-family:${SANS};font-size:15px;line-height:23px;font-weight:500;color:${C.body};padding-top:3px">${prose(item.text)}</div></td></tr>`).join("\n"), "margin:0 0 14px");
    case "list": return T(block.items.map(item => `<tr><td valign="top" width="22" style="padding:9px 0 0"><div style="width:6px;height:6px;background:${C.ink}" class="dot"></div></td><td class="soft" style="font-family:${SANS};font-size:15.5px;line-height:24px;color:${C.body};padding:0 0 6px;word-break:break-word">${prose(item)}</td></tr>`).join("\n"), "margin:0 0 18px");
    case "tips": return T(block.items.map(item => `<tr><td valign="top" width="88" style="padding:0 0 20px"><img src="${esc(img(cfg, item.image))}" width="72" height="72" alt="${esc(item.alt)}" style="display:block;width:72px;height:72px;border:0"></td>
<td valign="top" style="padding:4px 0 20px"><div class="ink" style="font-family:${SANS};font-size:16.5px;line-height:23px;font-weight:600;letter-spacing:-0.01em;color:${C.ink}">${esc(item.title)}</div>
<div class="soft" style="font-family:${SANS};font-size:14.5px;line-height:22px;font-weight:500;color:${C.body};padding-top:4px">${prose(item.text)}</div></td></tr>`).join("\n"), "margin:0 0 10px");
    case "note": {
      const tone = tones[block.tone ?? "info"];
      return stepped(`<span class="ink" style="font-family:${SANS};font-size:14.5px;line-height:22px;color:${C.ink}">${prose(block.text)}</span>`,
        { fill: tone.bg, cls: tone.cls, under: tone.edge, pad: "13px 16px", margin: "0 0 22px" });
    }
    case "cloud": return stepped(stepped(`<img src="${esc(img(cfg, block.image))}" width="472" alt="${esc(block.alt)}" style="display:block;width:100%;max-width:472px;height:auto;border:0">
<div class="muted" style="padding-top:18px;font-family:${MONO};font-size:12.5px;line-height:18px;letter-spacing:0.02em;color:${C.muted}">${esc(block.eyebrow)}</div>
<div class="ink" style="padding-top:6px;font-family:${SANS};font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.02em;color:${C.ink}">${esc(block.title)}</div>
<div class="soft" style="padding-top:8px;font-family:${SANS};font-size:14.5px;line-height:22px;font-weight:500;color:${C.body}">${prose(block.text)}</div>
${T(block.points.map(point => `<tr><td valign="top" width="20" style="padding:9px 0 0"><div class="dot" style="width:6px;height:6px;background:${C.ink}"></div></td><td class="ink" style="font-family:${SANS};font-size:15px;line-height:24px;color:${C.ink};padding:0 0 4px">${esc(point)}</td></tr>`).join("\n"), "margin:14px 0 0")}
${T(`<tr><td>${button(block.cta.label, block.cta.href, C.lime)}</td>
<td class="ink" style="padding-left:16px;font-family:${SANS};font-size:15px;line-height:20px;color:${C.ink}"><b style="font-weight:600">${esc(block.price)}</b><br><span class="muted" style="font-size:13px;color:${C.muted}">${esc(block.fine)}</span></td></tr>`, "margin:18px 0 4px", "")}`,
      { fill: "#ffffff", cls: "box", pad: "18px 18px 20px" }), { fill: C.skyWash, cls: "cloud-frame", under: C.sky, pad: "6px", margin: "8px 0 28px" });
    case "feature": return T(`${block.image ? `<tr><td style="padding:0 0 14px"><img src="${esc(img(cfg, block.image))}" width="504" alt="${esc(block.alt)}" style="display:block;width:100%;max-width:504px;height:auto;border:0"></td></tr>` : ""}
<tr><td><div class="ink" style="font-family:${SANS};font-size:18px;line-height:25px;font-weight:600;letter-spacing:-0.015em;color:${C.ink}">${esc(block.title)}</div>
<div class="soft" style="font-family:${SANS};font-size:15.5px;line-height:24px;font-weight:500;color:${C.body};padding-top:5px">${prose(block.text)}</div></td></tr>`, "margin:0 0 22px");
  }
}

function blockText(block: Block): string {
  switch (block.t) {
    case "h1": return block.text;
    case "h2": return block.text;
    case "p": return plain(block.text);
    case "button": return `${block.label}: ${block.href}`;
    case "link": return `${block.before ? `${block.before} ` : ""}${block.label}: ${block.href}`;
    case "code": return `    ${block.code}`;
    case "facts": return block.rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    case "total": return `${block.label}: ${block.value}`;
    case "stats": return block.items.map(([label, value, sub]) => `${label}: ${value}${sub ? ` (${sub})` : ""}`).join("\n");
    case "label": return `${block.text}:`;
    case "cmd": return `    ${block.text}`;
    case "log": return block.text.split("\n").map(line => `    ${line}`).join("\n");
    case "steps": return block.items.map((item, i) => `${i + 1}. ${item.title}\n   ${plain(item.text)}`).join("\n\n");
    case "list": return block.items.map(item => `- ${plain(item)}`).join("\n");
    case "tips": return block.items.map(item => `* ${item.title}\n  ${plain(item.text)}`).join("\n\n");
    case "note": return plain(block.text);
    case "cloud": return [`[ ${block.eyebrow} ]`, block.title, plain(block.text), block.points.map(point => `- ${point}`).join("\n"), `${block.price}, ${block.fine}`, `${block.cta.label}: ${block.cta.href}`].join("\n\n");
    case "feature": return `${block.title}\n${plain(block.text)}`;
  }
}

// outlook.com marks the colours it rewrites with data-ogsc
const darkCss = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .bg, .pg { background: #131316 !important; }
  .box { background: #232328 !important; }
  .cloud-frame { background: #1a2a31 !important; }
  .ink, a.ink { color: #f1f1f3 !important; }
  .soft { color: #dedee4 !important; }
  .muted, a.muted { color: #9a9aa4 !important; }
  .btn { background: #f1f1f3 !important; }
  .btn-a { color: #17171a !important; }
  .dot { background: #f1f1f3 !important; }
  .kit-eye { background: #f1f1f3 !important; }
  .a-lemon, .note-warn, .pill-warn { background: #4a4520 !important; }
  .a-lime, .pill-ok { background: #34431a !important; }
  .a-pink, .note-alert, .pill-bad { background: #4a2636 !important; }
  .a-lav { background: #302e52 !important; }
  .a-sky { background: #1f3a46 !important; }
}
[data-ogsc] .ink { color: #f1f1f3 !important; }
[data-ogsc] .soft { color: #dedee4 !important; }
[data-ogsc] .muted { color: #9a9aa4 !important; }
[data-ogsc] .btn { background: #f1f1f3 !important; }
[data-ogsc] .btn-a { color: #17171a !important; }
@media (max-width: 620px) {
  .px { padding-left: 22px !important; padding-right: 22px !important; }
  .h1 { font-size: 24px !important; line-height: 30px !important; }
}`;

export function render(cfg: EmailConfig, email: Email): Rendered {
  const fonts = `@font-face { font-family: 'General Sans'; src: url(${cfg.assets}/fonts/general-sans.woff2) format('woff2'); font-weight: 200 700; }
@font-face { font-family: 'Geist Mono'; src: url(${cfg.assets}/fonts/geist-mono.woff2) format('woff2'); font-weight: 100 900; }`;
  const links: Array<[string, string]> = [["Help", `${cfg.site}/docs`], ["Privacy", `${cfg.site}/privacy`]];
  if (email.unsubscribe) links.push(["Unsubscribe", email.unsubscribe]);
  if (email.transactional) links.length = 0;
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(email.subject)}</title>
<style>${fonts}
body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
table { border-collapse: collapse; }
img { -ms-interpolation-mode: nearest-neighbor; image-rendering: pixelated; }
a { text-decoration-skip-ink: auto; }
${darkCss}</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(email.preheader)}${"&#8199;&#847; ".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" bgcolor="${C.page}" style="background:${C.page}"><tr><td align="center" style="padding:0">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px"><tr><td class="px" style="padding:36px 28px 44px">
${T(`<tr><td class="ink" style="font-family:${SANS};font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.02em;color:${C.ink}">Metal</td><td align="right" class="muted" style="font-family:${MONO};font-size:12px;line-height:18px;color:${C.muted}">${esc(email.tag)}</td></tr>`, "margin:0 0 30px")}
${hero(email)}
${email.status ? statusPill(email.status) : ""}
${email.blocks.map(block => blockHtml(cfg, block, email.accent)).join("\n")}
<div style="height:20px;font-size:0;line-height:0">&nbsp;</div>
<div class="muted" style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted}">
${links.length ? `<p style="margin:0 0 6px">${links.map(([label, href]) => `<a class="muted" href="${esc(href)}" target="_blank" style="color:${C.muted};text-decoration:underline;text-underline-offset:2px">${esc(label)}</a>`).join("&nbsp;&nbsp;&middot;&nbsp;&nbsp;")}</p>` : ""}
<p style="margin:0">${esc(email.reason)}</p>
${cfg.address ? `<p style="margin:8px 0 0">${esc(cfg.address)}</p>` : ""}
</div>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
  const footer = [email.reason, ...links.map(([label, href]) => `${label}: ${href}`), ...(cfg.address ? [cfg.address] : [])].join("\n");
  const text = [...(email.status ? [`[ ${email.status[0]} ]`] : []), ...email.blocks.map(blockText), "--", `Metal\n${footer}`].join("\n\n");
  return { subject: email.subject, html, text, ...(email.transactional ? { transactional: true } : {}) };
}
