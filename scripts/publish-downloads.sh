#!/usr/bin/env bash
# Verifies a published Metal release and optionally copies its downloads to a second repository.
#   scripts/publish-downloads.sh v0.1.142
# env: DUSK_SOURCE_REPO (default parasource-si/metal), DUSK_DOWNLOADS_REPO (optional public mirror),
# DRY_RUN=1 to stop before uploading.
set -euo pipefail

TAG="${1:?usage: publish-downloads.sh v<version>}"
VERSION="${TAG#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release tag: $TAG" >&2; exit 2; }
SOURCE="${DUSK_SOURCE_REPO:-parasource-si/metal}"
DOWNLOADS="${DUSK_DOWNLOADS_REPO:-$SOURCE}"
work=$(mktemp -d "${TMPDIR:-/tmp}/dusk-publish.XXXXXX")
trap 'rm -rf "$work"' EXIT

[ "$(gh release view "$TAG" --repo "$SOURCE" --json isDraft --jq .isDraft)" = false ] || { echo "$TAG is still a draft in $SOURCE; publish it first" >&2; exit 1; }
gh release download "$TAG" --repo "$SOURCE" --dir "$work/assets"

# The release run that built this tag left the release manifest as its dusk-site artifact.
sha=$(gh release view "$TAG" --repo "$SOURCE" --json targetCommitish --jq .targetCommitish)
sha=$(gh api "repos/$SOURCE/commits/$sha" --jq .sha)
run=$(gh run list --repo "$SOURCE" --workflow release.yml --json databaseId,headSha,conclusion --limit 50 \
  --jq "[.[] | select(.headSha == \"$sha\" and .conclusion == \"success\")][0].databaseId")
[ -n "$run" ] && [ "$run" != null ] || { echo "no successful Release run for $sha" >&2; exit 1; }
gh run download "$run" --repo "$SOURCE" --name dusk-site --dir "$work/site"

# the manifest must vouch for exactly these installers
(cd "$work/assets" && shasum -a 256 -c "$work/site/SHA256SUMS")
cmp "$work/site/SHA256SUMS" "$work/assets/SHA256SUMS"
if [ -f "$work/site/latest.json" ]; then
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (m.version!==process.argv[2]) { console.error(`latest.json is for ${m.version}`); process.exit(1); }' "$work/site/latest.json" "$VERSION"
fi

if [ "${DRY_RUN:-}" = 1 ] || [ "$DOWNLOADS" = "$SOURCE" ]; then echo "verified $TAG (run $run) on $SOURCE"; exit 0; fi

gh repo view "$DOWNLOADS" --json visibility --jq .visibility | grep -qx PUBLIC || { echo "$DOWNLOADS must exist and be public" >&2; exit 1; }
gh release view "$TAG" --repo "$DOWNLOADS" >/dev/null 2>&1 || gh release create "$TAG" --repo "$DOWNLOADS" --title "Metal $VERSION" --notes "Built from $SOURCE at $TAG."
# only what people and the apps fetch: the stable installer names the download page links to, the mac update zips and
# browser parts the apps fetch by version, the checksums, and the signed latest.json (the apps' fallback when dusk.bot
# does not answer, at /releases/latest/download/latest.json); the versioned copies of the installers stay on the source release
shopt -s nullglob
keep=("$work"/assets/Metal{.dmg,-intel.dmg,-setup.exe,-amd64.deb,.AppImage} "$work"/assets/Metal-"$VERSION"-{arm64,x64}.zip "$work"/assets/Metal-"$VERSION"-browser-darwin-*.zip)
shopt -u nullglob
[ "${#keep[@]}" -ge 7 ] || { echo "missing installers in $TAG: ${keep[*]##*/}" >&2; exit 1; }
keep+=("$work/site/SHA256SUMS")
if [ -f "$work/site/latest.json" ]; then keep+=("$work/site/latest.json"); fi
gh release upload "$TAG" --repo "$DOWNLOADS" --clobber "${keep[@]}"
gh release edit "$TAG" --repo "$DOWNLOADS" --latest
