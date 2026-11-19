#!/bin/sh
# installs the latest Metal on a mac: sh apps/site/install-mac.sh
# downloads this mac's build of the newest release, checks it against the release's SHA256SUMS (which latest.json
# vouches for), puts Metal.app in /Applications (or ~/Applications when that is not writable) and opens it.
# until the app is notarized this is the way in without the "open anyway" step: a file curl downloads carries no
# quarantine flag, so macos does not stop it. release assets come from the Metal GitHub repository.
set -eu

RELEASES="https://github.com/parasource-si/metal/releases"
DOWNLOADS="$RELEASES/download"
APP="Metal.app"

say() { printf '%s\n' "$*"; }
fail() { printf 'Metal: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this installer is for a mac. other systems: $RELEASES"
# an intel shell under rosetta still gets the apple silicon build on an m-series mac
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; else arch=x64; fi

work=$(mktemp -d "${TMPDIR:-/tmp}/dusk-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

say "Checking the newest release"
curl -fsSL --proto '=https' "$RELEASES/latest/download/latest.json" -o "$work/latest.json" || fail "Metal has no published installer manifest at $RELEASES"
version=$(sed -n 's/.*"version": *"\([0-9][0-9.]*\)".*/\1/p' "$work/latest.json" | head -n 1)
want=$(sed -n 's/.*"sha256sums": *"\([0-9a-f]\{64\}\)".*/\1/p' "$work/latest.json" | head -n 1)
[ -n "$version" ] && [ -n "$want" ] || fail "the Metal release manifest looks wrong; try again later"
curl -fsSL --proto '=https' "$DOWNLOADS/v$version/SHA256SUMS" -o "$work/SHA256SUMS" || fail "could not get the checksums"
[ "$(shasum -a 256 "$work/SHA256SUMS" | cut -d ' ' -f 1)" = "$want" ] || fail "the checksums do not match the release; nothing was installed"

file="Metal-$version-$arch.zip"
sum=$(awk -v f="$file" '$2 == f { print $1 }' "$work/SHA256SUMS")
[ -n "$sum" ] || fail "release $version has no $file"

say "Downloading Metal $version ($arch)"
curl -fL --proto '=https' --progress-bar "$DOWNLOADS/v$version/$file" -o "$work/$file" || fail "the download stopped; run the line again"
[ "$(shasum -a 256 "$work/$file" | cut -d ' ' -f 1)" = "$sum" ] || fail "the download does not match its checksum; nothing was installed"

ditto -x -k "$work/$file" "$work/app"
[ -d "$work/app/$APP" ] || fail "the download has no $APP"
codesign --verify --deep --strict "$work/app/$APP" 2>/dev/null || fail "the app's signature does not verify; nothing was installed"

dest=/Applications
[ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
if pgrep -xq "Metal"; then
  say "Closing Metal to update it"
  osascript -e 'quit app "Metal"' >/dev/null 2>&1 || true
  i=0; while pgrep -xq "Metal" && [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
  pgrep -xq "Metal" && fail "Metal is still open; quit it and run the line again"
fi
rm -rf "$dest/$APP.old"
[ -e "$dest/$APP" ] && mv "$dest/$APP" "$dest/$APP.old"
if ! mv "$work/app/$APP" "$dest/$APP"; then
  [ -e "$dest/$APP.old" ] && mv "$dest/$APP.old" "$dest/$APP"
  fail "could not write to $dest"
fi
rm -rf "$dest/$APP.old"
xattr -dr com.apple.quarantine "$dest/$APP" 2>/dev/null || true

say "Installed Metal $version in $dest. Opening it."
open "$dest/$APP"
