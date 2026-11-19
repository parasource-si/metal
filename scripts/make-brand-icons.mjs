// node scripts/make-brand-icons.mjs: the desktop, tray and web icons from build/logo.mjs. macOS only (sips, iconutil)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

import { KIT_GLYPH, logoTile, svg } from "../build/logo.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const png = (source, size) => new Resvg(source, { fitTo: { mode: "width", value: size } }).render().asPng();

function write(path, bytes) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
  console.log(path);
}

// apple's macOS icon grid: the artwork is an 824 px rounded square centred in 1024
const MAC = svg(1024, 1024, `<title>Metal</title>${logoTile({ size: 824, x: 100, y: 100, radius: 185 })}`);
const FULL = svg(1024, 1024, logoTile());
const FAVICON = svg(33, 33, `<title>Metal</title>${logoTile({ size: 33, radius: 4 })}`);

write("build/icon.svg", `${MAC}\n`);
write("build/icon-1024.png", png(MAC, 1024));
write("electron/resources/app-icon.png", png(MAC, 1024));

const iconset = join(root, "build/icon.iconset");
for (const base of [16, 32, 64, 128, 256, 512]) {
  write(`build/icon.iconset/icon_${base}x${base}.png`, png(MAC, base));
  write(`build/icon.iconset/icon_${base}x${base}@2x.png`, png(MAC, base * 2));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(root, "build/icon.icns")]);
console.log("build/icon.icns");

// png-in-ico: a 6 byte header, a 16 byte entry per image, then the pngs; 256 is written as 0
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head[at] = size >= 256 ? 0 : size;
    head[at + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((image) => image.data)]);
}
write("build/icon.ico", ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(MAC, size) }))));

// a macOS template image: only its alpha is read, the system paints it to match the menu bar
const glyph = (scale) => {
  const h = KIT_GLYPH.length, w = KIT_GLYPH[0].length;
  let rects = "";
  KIT_GLYPH.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }));
  return png(svg(w, h, `<g fill="#000" shape-rendering="crispEdges">${rects}</g>`), w * scale);
};
write("electron/resources/trayTemplate.png", glyph(1));
write("electron/resources/trayTemplate@2x.png", glyph(2));
write("electron/resources/tray-icon.png", png(svg(33, 33, logoTile({ size: 33, radius: 4 })), 32));

write("public/app-icon.svg", `${FAVICON}\n`);
write("apps/dashboard/favicon.svg", `${FAVICON}\n`);
write("public/app-icon-192.png", png(FULL, 192));
write("public/app-icon-512.png", png(FULL, 512));
write("public/apple-touch-icon.png", png(FULL, 180));
