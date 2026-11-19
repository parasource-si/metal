#!/usr/bin/env bash
# Archives the iPhone app headlessly with App Store distribution signing and exports it, or uploads it to TestFlight.
#
#   apps/mobile/scripts/build-ios-release.sh --check      say which signing pieces are present, build nothing
#   apps/mobile/scripts/build-ios-release.sh              archive + export an .ipa (ios/App/build/export)
#   apps/mobile/scripts/build-ios-release.sh --upload     archive + upload straight to App Store Connect (TestFlight)
#   apps/mobile/scripts/build-ios-release.sh --unsigned   archive with signing off, to prove the project compiles
#
# Signing is manual and needs no registered device: an Apple Distribution certificate and the "dusk bot App Store"
# profile (both made with `node apps/mobile/scripts/asc.mjs dist-cert|store-profile`, docs/store-launch.md). The key
# and certificate go into a throwaway keychain deleted on exit, never the login keychain. The overrides are passed to
# xcodebuild only, so the project (and Debug) stays on automatic signing. From the environment, else dusk.env:
#   APPLE_TEAM_ID                     the 10 character team id
#   APPLE_DISTRIBUTION_KEY_PATH       default ~/.config/duskbot/apple/apple-distribution.key (PEM private key)
#   APPLE_DISTRIBUTION_CERT_PATH      default ~/.config/duskbot/apple/apple-distribution.cer (DER, from Apple)
#   APPLE_APPSTORE_PROFILE_PATH       default ~/.config/duskbot/apple/dusk-bot-app-store.mobileprovision
#   APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH   the App Store Connect API key, for --upload
# The build number is DUSK_IOS_BUILD_NUMBER, default a UTC timestamp (every upload needs a higher one).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mobile=$(cd "$here/.." && pwd)
repo=$(cd "$mobile/../.." && pwd)
project="$mobile/ios/App/App.xcodeproj"
out="$mobile/ios/App/build"
apple="$HOME/.config/duskbot/apple"
mode=export
case "${1:-}" in
  --check) mode=check ;; --upload) mode=upload ;; --unsigned) mode=unsigned ;; "") ;;
  *) echo "usage: $0 [--check|--upload|--unsigned]" >&2; exit 2 ;;
esac

. "$here/release-env.sh"
dusk_env_load APPLE_TEAM_ID APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_PATH \
  APPLE_DISTRIBUTION_KEY_PATH APPLE_DISTRIBUTION_CERT_PATH APPLE_APPSTORE_PROFILE_PATH
key_file="${APPLE_DISTRIBUTION_KEY_PATH:-$apple/apple-distribution.key}"
cer_file="${APPLE_DISTRIBUTION_CERT_PATH:-$apple/apple-distribution.cer}"
profile_file="${APPLE_APPSTORE_PROFILE_PATH:-$apple/dusk-bot-app-store.mobileprovision}"
widget_profile_file="${APPLE_WIDGET_PROFILE_PATH:-$apple/dusk-bot-activity-app-store.mobileprovision}"

problems=()
[ -n "${APPLE_TEAM_ID:-}" ] || problems+=("APPLE_TEAM_ID is not set (developer.apple.com, Account, Membership details, Team ID)")
[ -f "$key_file" ] || problems+=("no distribution private key at $key_file (openssl genrsa, then asc.mjs dist-cert with its CSR)")
[ -f "$cer_file" ] || problems+=("no Apple Distribution certificate at $cer_file (node apps/mobile/scripts/asc.mjs dist-cert <csr> <out.cer>)")
[ -f "$profile_file" ] || problems+=("no App Store profile at $profile_file (node apps/mobile/scripts/asc.mjs store-profile <certId> <out>)")
[ -f "$widget_profile_file" ] || problems+=("no Live Activity profile at $widget_profile_file (node apps/mobile/scripts/asc.mjs widget-profile <certId> <out>)")
api_key=no
if [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -f "${APPLE_API_KEY_PATH:-}" ]; then api_key=yes; fi
[ "$mode" = upload ] && [ "$api_key" = no ] && problems+=("--upload needs APPLE_API_KEY_ID, APPLE_API_ISSUER and APPLE_API_KEY_PATH")

echo "team id:              $([ -n "${APPLE_TEAM_ID:-}" ] && echo present || echo missing)"
echo "distribution key:     $([ -f "$key_file" ] && echo present || echo missing)"
echo "distribution cert:    $([ -f "$cer_file" ] && echo present || echo missing)"
echo "app store profile:    $([ -f "$profile_file" ] && echo present || echo missing)"
echo "live activity profile: $([ -f "$widget_profile_file" ] && echo present || echo missing)"
echo "api key (upload):     $api_key"
if [ "$mode" = check ]; then
  if [ ${#problems[@]} -eq 0 ]; then echo "ready to archive"; exit 0; fi
  printf 'missing: %s\n' "${problems[@]}" >&2; exit 1
fi
if [ "$mode" != unsigned ] && [ ${#problems[@]} -gt 0 ]; then
  printf 'error: %s\n' "${problems[@]}" >&2
  echo "nothing was built; see docs/store-launch.md, iOS signing" >&2
  exit 1
fi

build_number="${DUSK_IOS_BUILD_NUMBER:-$(date -u +%y%m%d%H%M)}"
cd "$repo"
echo "== web bundle"
pnpm --filter @metal/mobile build
echo "== release gate"
node apps/mobile/scripts/release-gate.mjs
echo "== cap sync ios"
(cd "$mobile" && npx cap sync ios)

mkdir -p "$out"
archive="$out/Metal.xcarchive"
rm -rf "$archive"
echo "== archive (build $build_number)"
if [ "$mode" = unsigned ]; then
  xcodebuild -quiet -project "$project" -scheme App -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$archive" CURRENT_PROJECT_VERSION="$build_number" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO archive
  echo "unsigned archive (cannot be uploaded): $archive"
  exit 0
fi

# ---------------------------------------------------------------- throwaway signing keychain
work=$(mktemp -d "${TMPDIR:-/tmp}/dusk-ios-release.XXXXXX")
keychain=""
original_keychains=()
cleanup() {
  if [ -n "$keychain" ]; then
    if [ "${#original_keychains[@]}" -gt 0 ]; then security list-keychains -d user -s "${original_keychains[@]}" 2>/dev/null || true; fi
    security delete-keychain "$keychain" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

p12_password=$(openssl rand -hex 24)
openssl x509 -inform DER -in "$cer_file" -out "$work/cert.pem" 2>/dev/null || cp "$cer_file" "$work/cert.pem"
# 3DES/SHA1 so `security import` reads it (OpenSSL 3 defaults to AES, which macOS refuses)
(umask 077; openssl pkcs12 -export -inkey "$key_file" -in "$work/cert.pem" -name "Metal distribution" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -passout "pass:$p12_password" -out "$work/dist.p12")
keychain="$work/dusk-ios-signing.keychain-db"
kc_password=$(openssl rand -hex 24)
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
  [ -n "$line" ] && original_keychains+=("$line")
done < <(security list-keychains -d user)
security create-keychain -p "$kc_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$kc_password" "$keychain"
security import "$work/dist.p12" -k "$keychain" -f pkcs12 -P "$p12_password" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
# the Apple WWDR intermediate (G3 signs current distribution certificates), so codesign can build the chain
for ca in AppleWWDRCAG3; do
  [ -f "$apple/$ca.cer" ] || curl -fsSL --max-time 30 -o "$apple/$ca.cer" "https://www.apple.com/certificateauthority/$ca.cer" || true
  [ -f "$apple/$ca.cer" ] && security import "$apple/$ca.cer" -k "$keychain" >/dev/null 2>&1 || true
done
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"
security find-identity -v -p codesigning "$keychain" | grep -q '"Apple Distribution' \
  || { echo "error: the throwaway keychain has no valid Apple Distribution identity (certificate and key do not match?)" >&2; exit 1; }

# the profile goes where Xcode looks (both the current and the older location), named by its UUID
install_profile() {
  security cms -D -i "$1" > "$work/profile.plist"
  local uuid
  uuid=$(plutil -extract UUID raw "$work/profile.plist")
  for dir in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
    mkdir -p "$dir" && cp "$1" "$dir/$uuid.mobileprovision"
  done
  plutil -extract Name raw "$work/profile.plist"
}
profile_name=$(install_profile "$profile_file")
widget_profile_name=$(install_profile "$widget_profile_file")

# each target names its own profile (DUSK_APP_PROFILE, DUSK_WIDGET_PROFILE): one PROVISIONING_PROFILE_SPECIFIER here would
# put the app's profile on the Live Activity extension too
xcodebuild -quiet -project "$project" -scheme App -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$archive" DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Distribution" DUSK_APP_PROFILE="$profile_name" DUSK_WIDGET_PROFILE="$widget_profile_name" \
  OTHER_CODE_SIGN_FLAGS="--keychain $keychain" CURRENT_PROJECT_VERSION="$build_number" archive

options="$out/ExportOptions.plist"
destination=export
[ "$mode" = upload ] && destination=upload
cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>bot.dusk.mobile</key><string>$profile_name</string><key>bot.dusk.mobile.activity</key><string>$widget_profile_name</string></dict>
  <key>destination</key><string>$destination</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><false/>
</dict>
</plist>
PLIST

# the archived app must carry the store entitlements before anything leaves this machine
ents=$(codesign -d --entitlements :- "$archive/Products/Applications/App.app" 2>/dev/null || true)
echo "$ents" | grep -A1 aps-environment | grep -q production || { echo "error: the signed app's aps-environment is not production" >&2; exit 1; }
echo "$ents" | grep -q com.apple.developer.applesignin || { echo "error: the signed app lacks the Sign in with Apple entitlement" >&2; exit 1; }
echo "signed entitlements: push production, Sign in with Apple, associated domains"

auth=()
[ "$api_key" = yes ] && auth=(-authenticationKeyPath "$APPLE_API_KEY_PATH" -authenticationKeyID "$APPLE_API_KEY_ID" -authenticationKeyIssuerID "$APPLE_API_ISSUER")
echo "== export ($destination)"
rm -rf "$out/export"
xcodebuild -quiet -exportArchive -archivePath "$archive" -exportOptionsPlist "$options" -exportPath "$out/export" "${auth[@]}"
if [ "$mode" = upload ]; then
  echo "uploaded build $build_number; it shows in App Store Connect, TestFlight once processing ends (5 to 30 minutes)"
  echo "then: node apps/mobile/scripts/asc.mjs status"
else
  ipa=$(ls "$out/export"/*.ipa | head -1)
  echo "$ipa (build $build_number)"
  echo "upload it: apps/mobile/scripts/build-ios-release.sh --upload, or Transporter"
fi
