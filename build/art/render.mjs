// renders the pixel art for the windows installer, the phone splash and a bot share card from build/art/pixel-scene.mjs.
//   node build/art/render.mjs            writes the shipped assets
//   node build/art/render.mjs --preview <dir>   also writes png previews of the bmp pages and a sample share card
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bmp24, C, renderPixels, renderPng, scene } from "./pixel-scene.mjs";

const root = new URL("../../", import.meta.url).pathname;
const preview = process.argv.includes("--preview") ? process.argv[process.argv.indexOf("--preview") + 1] : null;
if (preview) mkdirSync(preview, { recursive: true });

const KIT = { body: C.cloud, eyes: "#212121" };
const DUSK = { sky0: "#2e2c86", sky1: "#4744e2", sky2: "#7a5ae8", sky3: "#b896f2", glow: "#ffc4dd", ground: "#7fb51c", groundDeep: "#73a618" };

/** NSIS welcome and finish pages: a tall sky with kit on the grass, the page's words sit to its right */
function sidebar({ bye = false } = {}) {
  const s = scene(164, 314, { cell: 4, seed: bye ? 5 : 3 });
  if (bye) s.sky([[DUSK.sky0, 0], [DUSK.sky1, 14], [DUSK.sky2, 30], [DUSK.sky3, 44], [DUSK.glow, 56]]);
  else s.sky([[C.sky0, 0], [C.sky1, 10], [C.sky2, 28], [C.sky3, 46], [C.canvas, 56]]);
  s.cloud(44, 6, 12, bye ? C.lilac : C.pink).cloud(126, 15, 8, C.lemon);
  s.ground(64, { flowers: 4, speckle: 0.06 });
  s.bot("kit", KIT.body, 82, 256, 4, { eyes: KIT.eyes });
  s.bot("mochi", C.pinkBot, 30, 256, 2);
  s.bot("pip", C.blue, 138, 256, 2);
  s.bubble(82, 178, bye ? "see you!" : "hi!", { size: 15, pad: 10, tail: "centre", u: 2 });
  return s.svg();
}

/** NSIS inner pages: a short strip in the top right corner */
function header() {
  const s = scene(150, 57, { cell: 3, seed: 9 });
  s.sky([[C.sky1, 0], [C.sky2, 7], [C.sky3, 13]]);
  s.ground(16, { flowers: 1, speckle: 0.05 });
  s.bot("kit", KIT.body, 118, 48, 2, { eyes: KIT.eyes });
  s.bot("mochi", C.pinkBot, 86, 48, 1.25);
  return s.svg();
}

/** the phone's launch screen: kit on the hill in the middle, light by day and a dusk sky in dark mode */
function splash(W, H, dark) {
  const short = Math.min(W, H);
  const cell = Math.max(4, Math.round(short / 40));
  const s = scene(W, H, { cell, seed: 21 });
  const rows = Math.ceil(H / cell);
  const g = Math.round(rows * 0.64);
  const p = dark ? DUSK : null;
  s.sky(dark
    ? [[p.sky0, 0], [p.sky1, Math.round(g * 0.25)], [p.sky2, Math.round(g * 0.55)], [p.sky3, Math.round(g * 0.78)], [p.glow, g - 4]]
    : [[C.sky0, 0], [C.sky1, Math.round(g * 0.18)], [C.sky2, Math.round(g * 0.5)], [C.sky3, Math.round(g * 0.75)], [C.canvas, g - 4]]);
  const cols = Math.ceil(W / cell);
  s.cloud(W * 0.3, Math.round(g * 0.22), Math.max(8, Math.round(cols * 0.22)), dark ? C.lilac : C.pink);
  s.cloud(W * 0.74, Math.round(g * 0.36), Math.max(6, Math.round(cols * 0.15)), C.lemon);
  s.ground(g, { flowers: 10, speckle: 0.05 });
  if (dark) s.raw(`<rect x="0" y="${g * cell}" width="${W}" height="${H - g * cell}" fill="${p.ground}" opacity="0.35"/>`);
  s.hill(W / 2, g, Math.max(18, Math.round(short / cell / 1.8)), 3);
  const px = Math.max(2, Math.round(short * 0.34 / 16));
  s.bot("kit", KIT.body, W / 2, (g - 3) * cell, px, { eyes: KIT.eyes });
  return s.svg();
}

/** a bot's share card, 1200 by 630: the bot big on its hill and its name in a speech bubble */
export function botCard({ name, body, colour, line }) {
  const s = scene(1200, 630, { cell: 10, seed: name.length * 7 + 3 });
  s.sky([[C.sky0, 0], [C.sky1, 8], [C.sky2, 24], [C.sky3, 38], [C.canvas, 44]]);
  s.cloud(160, 6, 18, C.pink).cloud(1030, 10, 14, C.lemon);
  s.ground(50, { flowers: 9, avoid: [[320, 530, 560, 100]] });
  s.hill(600, 50, 30, 3);
  s.bot(body, colour, 600, 470, 12);
  s.bot("mochi", C.pinkBot, 250, 500, 4).bot("loaf", C.tangerine, 960, 500, 4).bot("goo", C.mint, 1040, 500, 3.5);
  s.bubble(600, 266, `hi, i'm ${name}!`, { size: 34, pad: 22, u: 4 });
  s.text(600, 572, line, { size: 26, anchor: "middle" });
  s.text(600, 606, "made with Metal", { size: 18, fill: C.inkSoft, anchor: "middle" });
  return s.svg();
}

const writeBmp = (svg, file) => {
  writeFileSync(join(root, file), bmp24(renderPixels(svg, 1)));
  console.log(file);
};
writeBmp(sidebar(), "build/installerSidebar.bmp");
writeBmp(sidebar({ bye: true }), "build/uninstallerSidebar.bmp");
writeBmp(header(), "build/installerHeader.bmp");

const res = join(root, "apps/mobile");
for (const [file, dark] of [["splash-light.png", false], ["splash-dark.png", true]]) {
  const out = join(res, "ios/App/App/Assets.xcassets/Splash.imageset", file);
  writeFileSync(out, renderPng(splash(2732, 2732, dark)));
  console.log(out.replace(root, ""));
}
for (const [dir, W, H] of [
  ["drawable", 480, 320], ["drawable-land-mdpi", 480, 320], ["drawable-land-hdpi", 800, 480], ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960], ["drawable-land-xxxhdpi", 1920, 1280], ["drawable-port-mdpi", 320, 480], ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280], ["drawable-port-xxhdpi", 960, 1600], ["drawable-port-xxxhdpi", 1280, 1920],
]) {
  const out = join(res, "android/app/src/main/res", dir, "splash.png");
  writeFileSync(out, renderPng(splash(W, H, false)));
  console.log(out.replace(root, ""));
}

if (preview) {
  writeFileSync(join(preview, "installer-sidebar.png"), renderPng(sidebar(), 2));
  writeFileSync(join(preview, "uninstaller-sidebar.png"), renderPng(sidebar({ bye: true }), 2));
  writeFileSync(join(preview, "installer-header.png"), renderPng(header(), 2));
  writeFileSync(join(preview, "splash-phone-light.png"), renderPng(splash(390, 844, false), 2));
  writeFileSync(join(preview, "splash-phone-dark.png"), renderPng(splash(390, 844, true), 2));
  writeFileSync(join(preview, "share-card.png"), renderPng(botCard({ name: "quill", body: "hoot", colour: C.violet, line: "writes your weekly update every friday" })));
}
