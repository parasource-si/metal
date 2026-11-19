import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAppImageMenuEntry, execArg, installAppImageMenuEntry, menuEntryPaths, menuEntryText } from "./appimage-menu-entry.mjs";

function world({ appImage = "/home/me/Apps/Dusk Bot.AppImage", deb = false, env: extra = {}, platform = "linux" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dusk-menu-entry-"));
  const home = join(root, "home"), iconSource = join(root, "resources", "icon.svg"), debEntry = join(root, "usr", "bot.dusk.app.desktop");
  mkdirSync(join(root, "resources"), { recursive: true });
  writeFileSync(iconSource, "<svg/>");
  if (deb) { mkdirSync(join(root, "usr")); writeFileSync(debEntry, "[Desktop Entry]\n"); }
  const env = { APPIMAGE: appImage, ...extra };
  const make = (overrides = {}) => createAppImageMenuEntry({ platform, env: { ...env, ...overrides }, home, file: join(root, "userData", "app-menu-entry.json"), iconSource, debEntry });
  return { root, home, env, entry: make(), make, paths: menuEntryPaths({ home, env }) };
}
const done = (w) => rmSync(w.root, { recursive: true, force: true });

test("the entry and icon live in XDG_DATA_HOME, or ~/.local/share without one", () => {
  assert.deepEqual(menuEntryPaths({ home: "/home/me", env: {} }), {
    entry: "/home/me/.local/share/applications/bot.dusk.app.desktop", icon: "/home/me/.local/share/icons/hicolor/scalable/apps/bot.dusk.app.svg",
  });
  assert.equal(menuEntryPaths({ home: "/home/me", env: { XDG_DATA_HOME: "/data" } }).entry, "/data/applications/bot.dusk.app.desktop");
  assert.equal(menuEntryPaths({ home: "/home/me", env: { XDG_DATA_HOME: "relative" } }).entry, "/home/me/.local/share/applications/bot.dusk.app.desktop");
});

test("Exec quotes the path by the Desktop Entry rules", () => {
  assert.equal(execArg("/home/me/Dusk Bot.AppImage"), `"/home/me/Dusk Bot.AppImage"`);
  // a $ inside quotes is \$, and the string-value escape doubles that backslash
  assert.equal(execArg("/home/me/$HOME/a\"b`c\\d"), `"/home/me/\\\\$HOME/a\\\\"b\\\\\`c\\\\\\\\d"`);
  assert.equal(execArg("/home/me/100%.AppImage"), `"/home/me/100%%.AppImage"`);
  assert.equal(execArg("/home/me/bad\nname"), null);
  assert.equal(execArg(""), null);
  const text = menuEntryText({ appImage: "/home/me/Dusk Bot.AppImage", icon: "/home/me/icon.svg" });
  for (const line of ["Name=Metal", `Exec="/home/me/Dusk Bot.AppImage" %U`, "Icon=/home/me/icon.svg", "StartupWMClass=bot.dusk.app", "Categories=Utility;",
    "MimeType=x-scheme-handler/duskbot;x-scheme-handler/openmausbot;", "Terminal=false"]) assert.ok(text.split("\n").includes(line), line);
});

test("the first AppImage launch adds the entry and icon, and later ones leave them alone", () => {
  const w = world();
  assert.equal(w.entry.available(), true);
  assert.equal(w.entry.sync(), "added");
  const text = readFileSync(w.paths.entry, "utf8");
  assert.ok(text.includes(`Exec="/home/me/Apps/Dusk Bot.AppImage" %U`));
  assert.ok(text.includes(`Icon=${w.paths.icon}`));
  assert.equal(readFileSync(w.paths.icon, "utf8"), "<svg/>");
  assert.equal(statSync(w.paths.entry).mode & 0o777, 0o644);
  assert.equal(w.entry.on(), true);
  assert.equal(w.entry.sync(), "current");
  done(w);
});

test("a moved AppImage gets its Exec path updated on the next launch", () => {
  const w = world();
  w.entry.sync();
  const moved = w.make({ APPIMAGE: "/home/me/bin/duskbot.AppImage" });
  assert.equal(moved.sync(), "updated");
  assert.ok(readFileSync(w.paths.entry, "utf8").includes(`Exec="/home/me/bin/duskbot.AppImage" %U`));
  done(w);
});

test("nothing is written with the .deb installed, off Linux, or outside an AppImage", () => {
  for (const w of [world({ deb: true }), world({ platform: "darwin" }), world({ appImage: null })]) {
    assert.equal(w.entry.available(), false);
    assert.equal(w.entry.sync(), "unavailable");
    assert.equal(existsSync(w.paths.entry), false);
    done(w);
  }
});

test("an entry the person made is never overwritten, nor doubled", () => {
  const same = world();
  mkdirSync(join(same.paths.entry, ".."), { recursive: true });
  writeFileSync(same.paths.entry, "[Desktop Entry]\nExec=/somewhere/else\n");
  assert.equal(same.entry.sync(), "theirs");
  assert.equal(readFileSync(same.paths.entry, "utf8"), "[Desktop Entry]\nExec=/somewhere/else\n");
  done(same);
  const other = world();
  mkdirSync(join(other.paths.entry, ".."), { recursive: true });
  writeFileSync(join(other.paths.entry, "..", "dusk.desktop"), "[Desktop Entry]\nExec=/home/me/Apps/Dusk Bot.AppImage --no-sandbox\n");
  assert.equal(other.entry.sync(), "theirs");
  assert.equal(existsSync(other.paths.entry), false);
  done(other);
});

test("Settings removes the entry and icon for good, and can put them back", async () => {
  const w = world();
  w.entry.sync();
  const handlers = new Map();
  installAppImageMenuEntry({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, guard: (_channel, fn) => fn, entry: w.entry });
  assert.deepEqual(await handlers.get("app-menu-entry:state")({}), { available: true, on: true });
  assert.deepEqual(await handlers.get("app-menu-entry:set")({}, false), { available: true, on: false });
  assert.equal(existsSync(w.paths.entry), false);
  assert.equal(existsSync(w.paths.icon), false);
  assert.equal(w.make().sync(), "removed");
  assert.equal(existsSync(w.paths.entry), false);
  assert.deepEqual(await handlers.get("app-menu-entry:set")({}, true), { available: true, on: true });
  assert.equal(w.make().sync(), "current");
  done(w);
});
