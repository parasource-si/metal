#!/usr/bin/env bash
# Builds the Play upload bundle (.aab) signed with the upload key.
#
#   apps/mobile/scripts/build-android-release.sh                 (version code 1)
#   DUSK_ANDROID_VERSION_CODE=2 DUSK_ANDROID_VERSION_NAME=1.0.1 apps/mobile/scripts/build-android-release.sh
#
# The upload key is read from ANDROID_UPLOAD_* in the environment, else from ~/.config/duskbot/dusk.env, else from
# ~/.gradle/gradle.properties (Gradle reads that itself). Values are never printed. Without a key the bundle is unsigned
# and the script says so: Play refuses an unsigned upload.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mobile=$(cd "$here/.." && pwd)
repo=$(cd "$mobile/../.." && pwd)
. "$here/release-env.sh"
dusk_env_load ANDROID_UPLOAD_KEYSTORE_PATH ANDROID_UPLOAD_KEY_ALIAS ANDROID_UPLOAD_STORE_PASSWORD ANDROID_UPLOAD_KEY_PASSWORD

if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ] && [ ! -f "$mobile/android/local.properties" ]; then
  if [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk"
  else echo "error: no Android SDK (set ANDROID_HOME or write android/local.properties with sdk.dir)" >&2; exit 1; fi
fi

missing=()
for key in ANDROID_UPLOAD_KEYSTORE_PATH ANDROID_UPLOAD_KEY_ALIAS ANDROID_UPLOAD_STORE_PASSWORD ANDROID_UPLOAD_KEY_PASSWORD; do
  [ -n "${!key:-}" ] || missing+=("$key")
done
if [ ${#missing[@]} -gt 0 ] && ! grep -qs '^ANDROID_UPLOAD_KEYSTORE_PATH=' "$HOME/.gradle/gradle.properties"; then
  echo "warning: no upload key (${missing[*]} missing); the bundle will be unsigned. See docs/store-launch.md, Android." >&2
elif [ -n "${ANDROID_UPLOAD_KEYSTORE_PATH:-}" ] && [ ! -f "$ANDROID_UPLOAD_KEYSTORE_PATH" ]; then
  echo "error: ANDROID_UPLOAD_KEYSTORE_PATH points at a file that does not exist" >&2; exit 1
fi

cd "$repo"
echo "== web bundle"
pnpm --filter @metal/mobile build
echo "== release gate"
node apps/mobile/scripts/release-gate.mjs
echo "== cap sync android"
(cd "$mobile" && npx cap sync android)
echo "== gradle bundleRelease"
(cd "$mobile/android" && ./gradlew --no-daemon -q bundleRelease)

aab="$mobile/android/app/build/outputs/bundle/release/app-release.aab"
[ -f "$aab" ] || { echo "error: gradle finished but $aab is missing" >&2; exit 1; }
if keytool -printcert -jarfile "$aab" >/dev/null 2>&1 && keytool -printcert -jarfile "$aab" 2>/dev/null | grep -q SHA256; then
  echo "signed with: $(keytool -printcert -jarfile "$aab" 2>/dev/null | grep -m1 'SHA256:' | sed 's/^[[:space:]]*//')"
else
  echo "warning: the bundle is not signed; Play will refuse it" >&2
fi
echo "$aab"
