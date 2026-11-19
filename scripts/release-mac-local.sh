#!/usr/bin/env bash
# builds, signs (Developer ID), notarizes and staples the mac app on this mac, no github actions needed.
#
#   scripts/release-mac-local.sh --check      only report what is present and what is missing
#   scripts/release-mac-local.sh --dry-run    ad-hoc signed build plus every check that works without apple's credentials
#   scripts/release-mac-local.sh --no-notarize  Developer ID signed but not notarized (no API key needed), to test signing
#   scripts/release-mac-local.sh              the real thing: signed, notarized, stapled dmg + updater zip for arm64 and x64
#
# options: --skip-build (reuse release/ from an earlier run of the same mode), --arch arm64|x64 (default both)
#
# credentials, never printed:
#   ~/.config/duskbot/apple/developer-id.key        private key behind the CSR (mode 600)
#   ~/.config/duskbot/apple/developer_id.cer        the Developer ID Application certificate from developer.apple.com
#   ~/.config/duskbot/dusk.env                      APPLE_TEAM_ID, APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH (.p8)
# the script makes ~/.config/duskbot/apple/developer-id.p12 (password APPLE_DEVELOPER_ID_P12_PASSWORD in dusk.env) and
# signs from a throwaway keychain it deletes on exit, so the login keychain is never touched and nothing prompts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPLE_DIR="${DUSK_APPLE_DIR:-$HOME/.config/duskbot/apple}"
ENV_FILE="${DUSK_ENV_FILE:-$HOME/.config/duskbot/dusk.env}"
APP_NAME="Metal"
MODE=release
SKIP_BUILD=0
ARCHES=(arm64 x64)

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --dry-run) MODE=dry ;;
    --no-notarize) MODE=signed ;;
    --skip-build) SKIP_BUILD=1 ;;
    --arch) shift; ARCHES=("$1") ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
miss() { printf '  MISSING  %s\n' "$*"; MISSING=$((MISSING + 1)); }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# one value from dusk.env without sourcing the whole file (it holds unrelated secrets)
envget() {
  [ -f "$ENV_FILE" ] || return 0
  local v
  v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  v="${v/#\~/$HOME}"
  printf '%s' "$v"
}

envset() {
  # append KEY=value when KEY is absent or empty; never echoes the value
  local key="$1" value="$2"
  if grep -q "^$key=." "$ENV_FILE" 2>/dev/null; then return 0; fi
  if grep -q "^$key=$" "$ENV_FILE" 2>/dev/null; then
    local tmp; tmp="$(mktemp "$ENV_FILE.XXXXXX")"
    awk -v k="$key" -v v="$value" 'BEGIN{done=0} { if (!done && $0 == k"=") { print k"="v; done=1 } else print }' "$ENV_FILE" > "$tmp"
    chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

[ "$(uname -s)" = Darwin ] || die "this script only runs on macOS"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"

# ---------------------------------------------------------------- preflight
KEY_FILE="$APPLE_DIR/developer-id.key"
CER_FILE=""
for c in "$APPLE_DIR/developer_id.cer" "$APPLE_DIR/developerID_application.cer" "$APPLE_DIR/developer-id.cer"; do
  [ -f "$c" ] && { CER_FILE="$c"; break; }
done
P12_FILE="$APPLE_DIR/developer-id.p12"
TEAM_ID="$(envget APPLE_TEAM_ID)"
API_KEY_ID="$(envget APPLE_API_KEY_ID)"
API_ISSUER="$(envget APPLE_API_ISSUER)"
API_KEY_PATH="$(envget APPLE_API_KEY_PATH)"
if [ -z "$API_KEY_PATH" ] && [ -n "$API_KEY_ID" ] && [ -f "$APPLE_DIR/AuthKey_$API_KEY_ID.p8" ]; then
  API_KEY_PATH="$APPLE_DIR/AuthKey_$API_KEY_ID.p8"
fi
CERT_NAME=""
CERT_TEAM=""

preflight() {
  MISSING=0
  say "tools"
  for t in codesign security hdiutil ditto spctl xattr; do
    command -v "$t" >/dev/null && ok "$t" || miss "$t (part of macOS)"
  done
  xcrun --find notarytool >/dev/null 2>&1 && ok "notarytool" || miss "xcrun notarytool (install Xcode or the Command Line Tools)"
  xcrun --find stapler >/dev/null 2>&1 && ok "stapler" || miss "xcrun stapler (install Xcode or the Command Line Tools)"
  command -v pnpm >/dev/null && ok "pnpm" || miss "pnpm"

  say "Developer ID certificate"
  if [ -f "$KEY_FILE" ]; then
    local mode; mode="$(stat -f %Lp "$KEY_FILE")"
    [ "$mode" = 600 ] && ok "private key $KEY_FILE" || miss "private key $KEY_FILE must be mode 600 (it is $mode): chmod 600 it"
  else
    miss "private key $KEY_FILE (made together with developer-id.csr)"
  fi
  if [ -z "$CER_FILE" ]; then
    miss "certificate: upload $APPLE_DIR/developer-id.csr at https://developer.apple.com/account/resources/certificates/add (type: Developer ID Application, profile type G2 Sub-CA), download it and save it as $APPLE_DIR/developer_id.cer"
  else
    local subject
    subject="$(openssl x509 -inform DER -in "$CER_FILE" -noout -subject -nameopt RFC2253 2>/dev/null || openssl x509 -in "$CER_FILE" -noout -subject -nameopt RFC2253)"
    CERT_NAME="$(printf '%s' "$subject" | sed -n 's/.*CN=\([^,]*\).*/\1/p')"
    CERT_TEAM="$(printf '%s' "$subject" | sed -n 's/.*OU=\([A-Z0-9]\{10\}\).*/\1/p')"
    case "$CERT_NAME" in
      "Developer ID Application:"*) ok "certificate $CER_FILE: $CERT_NAME" ;;
      *) miss "certificate $CER_FILE is \"$CERT_NAME\", not a Developer ID Application certificate" ;;
    esac
    if ! openssl x509 -inform DER -in "$CER_FILE" -noout -checkend 0 >/dev/null 2>&1 \
      && ! openssl x509 -in "$CER_FILE" -noout -checkend 0 >/dev/null 2>&1; then
      miss "certificate $CER_FILE has expired"
    fi
    if [ -f "$KEY_FILE" ]; then
      local a b
      a="$( (openssl x509 -inform DER -in "$CER_FILE" -noout -pubkey 2>/dev/null || openssl x509 -in "$CER_FILE" -noout -pubkey) | openssl sha256)"
      b="$(openssl pkey -in "$KEY_FILE" -pubout 2>/dev/null | openssl sha256)"
      [ "$a" = "$b" ] && ok "certificate matches developer-id.key" \
        || miss "certificate $CER_FILE was not made from developer-id.csr (its public key does not match developer-id.key)"
    fi
  fi

  say "team"
  if [ -n "$CERT_TEAM" ] && [ -z "$TEAM_ID" ]; then
    TEAM_ID="$CERT_TEAM"; envset APPLE_TEAM_ID "$TEAM_ID"; ok "APPLE_TEAM_ID taken from the certificate: $TEAM_ID (saved to dusk.env)"
  elif [ -n "$TEAM_ID" ] && [ -n "$CERT_TEAM" ] && [ "$TEAM_ID" != "$CERT_TEAM" ]; then
    miss "APPLE_TEAM_ID in dusk.env ($TEAM_ID) is not the certificate's team ($CERT_TEAM)"
  elif [ -n "$TEAM_ID" ]; then
    ok "APPLE_TEAM_ID $TEAM_ID"
  else
    miss "APPLE_TEAM_ID in dusk.env (the 10 characters at https://developer.apple.com/account under Membership details; filled in automatically once the certificate is here)"
  fi

  say "notarization (App Store Connect API key)"
  if [ "$MODE" = signed ]; then echo "  skipped (--no-notarize)"; return 0; fi
  [ -n "$API_KEY_ID" ] && ok "APPLE_API_KEY_ID" || miss "APPLE_API_KEY_ID in dusk.env (App Store Connect > Users and Access > Integrations > App Store Connect API, the key's Key ID)"
  if [ -n "$API_KEY_PATH" ] && [ -f "$API_KEY_PATH" ]; then ok "APPLE_API_KEY_PATH $API_KEY_PATH"
  else miss "APPLE_API_KEY_PATH in dusk.env, pointing at the downloaded AuthKey_<KEYID>.p8 (keep it in $APPLE_DIR, mode 600)"; fi
  if [ -n "$API_ISSUER" ]; then ok "APPLE_API_ISSUER"
  else echo "  note  APPLE_API_ISSUER is empty: fine for an Individual API key, required for a Team key (the Issuer ID above the keys list)"; fi
}

notary_auth() {
  NOTARY_AUTH=(--key "$API_KEY_PATH" --key-id "$API_KEY_ID")
  [ -n "$API_ISSUER" ] && NOTARY_AUTH+=(--issuer "$API_ISSUER")
  return 0
}

if [ "$MODE" != dry ]; then
  preflight
  if [ "$MISSING" -gt 0 ]; then
    echo
    echo "$MISSING thing(s) missing, listed above. Nothing was built."
    exit 1
  fi
  [ "$MODE" = signed ] || {
  notary_auth
  say "checking the API key with Apple"
  xcrun notarytool history "${NOTARY_AUTH[@]}" --output-format json >/dev/null 2>"$ROOT/release-notary-auth.err" \
    || { sed 's/^/  /' "$ROOT/release-notary-auth.err" >&2; rm -f "$ROOT/release-notary-auth.err"; die "Apple refused the API key (check APPLE_API_KEY_ID, APPLE_API_ISSUER and the .p8)"; }
  rm -f "$ROOT/release-notary-auth.err"
  ok "notarytool accepts the key"
  }
  [ "$MODE" = check ] && { echo; echo "everything is in place: run scripts/release-mac-local.sh"; exit 0; }
fi

# ---------------------------------------------------------------- signing keychain
# the real path, the form the keychain search list stores (TMPDIR is /var/..., the list says /private/var/...)
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/dusk-mac-release.XXXXXX")" && pwd -P)"
KEYCHAIN=""
# the user keychain search list, one path per line
user_keychains() {
  local line
  security list-keychains -d user | while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
    [ -n "$line" ] && printf '%s\n' "$line"
  done
}
# rewrites the search list without $1, without duplicates, and without any dusk-signing keychain whose file is gone
# (a run killed with SIGKILL leaves one behind); the order of the rest and the default keychain are left alone
prune_keychains() {
  local drop="${1:-}" kept=() line k seen
  while IFS= read -r line; do
    [ -n "$drop" ] && [ "$line" = "$drop" ] && continue
    case "$line" in */dusk-signing.keychain-db) [ -e "$line" ] || continue ;; esac
    seen=0
    for k in ${kept[@]+"${kept[@]}"}; do [ "$k" = "$line" ] && seen=1; done
    [ "$seen" = 1 ] || kept+=("$line")
  done < <(user_keychains)
  security list-keychains -d user -s ${kept[@]+"${kept[@]}"}
}
CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  if [ -n "$KEYCHAIN" ]; then
    security delete-keychain "$KEYCHAIN" 2>/dev/null || true
    prune_keychains "$KEYCHAIN" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
# a signal exits, so the EXIT trap puts the search list back on every path but SIGKILL (pruned on the next run)
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

IDENTITY="-"
if [ "$MODE" = release ] || [ "$MODE" = signed ]; then
  say "building the signing keychain"
  P12_PASSWORD="$(envget APPLE_DEVELOPER_ID_P12_PASSWORD)"
  if [ ! -f "$P12_FILE" ] || [ -z "$P12_PASSWORD" ]; then
    P12_PASSWORD="$(openssl rand -hex 24)"
    # 3DES/SHA1 so `security import` reads it on every macOS (OpenSSL 3+ defaults to AES, which older macOS refuses)
    openssl x509 -inform DER -in "$CER_FILE" -out "$WORK/cert.pem" 2>/dev/null || cp "$CER_FILE" "$WORK/cert.pem"
    (umask 077; openssl pkcs12 -export -inkey "$KEY_FILE" -in "$WORK/cert.pem" -name "$CERT_NAME" \
      -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
      -passout "pass:$P12_PASSWORD" -out "$P12_FILE")
    chmod 600 "$P12_FILE"
    # replace any stale value, then store the new one
    if grep -q '^APPLE_DEVELOPER_ID_P12_PASSWORD=' "$ENV_FILE"; then
      tmp="$(mktemp "$ENV_FILE.XXXXXX")"; grep -v '^APPLE_DEVELOPER_ID_P12_PASSWORD=' "$ENV_FILE" > "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
    fi
    envset APPLE_DEVELOPER_ID_P12_PASSWORD "$P12_PASSWORD"
    ok "made $P12_FILE (its password is APPLE_DEVELOPER_ID_P12_PASSWORD in dusk.env)"
  fi
  KEYCHAIN="$WORK/dusk-signing.keychain-db"
  KC_PASSWORD="$(openssl rand -hex 24)"
  prune_keychains
  security create-keychain -p "$KC_PASSWORD" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$KC_PASSWORD" "$KEYCHAIN"
  security import "$P12_FILE" -k "$KEYCHAIN" -f pkcs12 -P "$P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild >/dev/null
  # the Developer ID intermediates, so codesign can build the chain without Xcode's copies
  for ca in DeveloperIDG2CA DeveloperIDCA; do
    [ -f "$APPLE_DIR/$ca.cer" ] || curl -fsSL --max-time 30 -o "$APPLE_DIR/$ca.cer" "https://www.apple.com/certificateauthority/$ca.cer" || true
    [ -f "$APPLE_DIR/$ca.cer" ] && security import "$APPLE_DIR/$ca.cer" -k "$KEYCHAIN" >/dev/null 2>&1 || true
  done
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASSWORD" "$KEYCHAIN" >/dev/null
  # last in the search list, never first, and never the default: codesign and security name it with --keychain, and
  # codesign only needs to find it to build the certificate chain
  existing=()
  while IFS= read -r line; do existing+=("$line"); done < <(user_keychains)
  security list-keychains -d user -s ${existing[@]+"${existing[@]}"} "$KEYCHAIN"
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "Developer ID Application" \
    || die "the keychain has no valid Developer ID Application identity (is the certificate chain trusted?)"
  IDENTITY="$CERT_NAME"
  ok "signing as $IDENTITY"
fi

# ---------------------------------------------------------------- build
app_dir() { [ "$1" = arm64 ] && echo "release/mac-arm64" || echo "release/mac"; }

if [ "$SKIP_BUILD" = 0 ]; then
  say "building $VERSION for ${ARCHES[*]} ($([ "$IDENTITY" = "-" ] && echo ad-hoc || echo Developer ID) signed)"
  rm -rf dist dist-server dist-native release
  # the one-click OAuth clients the release workflow bakes in (scripts/bundle-server.mjs), when dusk.env has them
  while IFS= read -r name; do
    v="$(envget "$name")"; [ -n "$v" ] && export "$name=$v"
  done < <(node -e 'for (const c of require("./shared/native-connectors.json").connectors) for (const n of [c.clientIdEnv, c.clientSecretEnv]) if (n) console.log(n)')
  unset CSC_LINK CSC_KEY_PASSWORD
  # both arches come from electron-builder.yml; a single --arch narrows it. the yml's targets name their arches, which
  # beat a bare --arm64, so the targets are named here too: electron-builder then builds only the arch asked for
  arch_flags=()
  [ "${#ARCHES[@]}" = 1 ] && arch_flags=(--mac dmg --mac zip "--${ARCHES[0]}")
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
  # never let electron-builder notarize or open anything; notarization happens below
  if [ "$IDENTITY" != "-" ]; then
    CSC_NAME="${IDENTITY#Developer ID Application: }" CSC_KEYCHAIN="$KEYCHAIN" CSC_IDENTITY_AUTO_DISCOVERY=false \
      DUSK_PARTS_SIGN_IDENTITY="$IDENTITY" DUSK_PARTS_KEYCHAIN="$KEYCHAIN" \
      pnpm run package:mac ${arch_flags[@]+"${arch_flags[@]}"}
  else
    pnpm run package:mac -c.mac.identity=- ${arch_flags[@]+"${arch_flags[@]}"}
  fi
fi

# a build under umask 077 leaves 0700 folders in the app; Squirrel.Mac's root ShipIt installs that as root:wheel 0700,
# which the person can no longer open. file modes are not part of the signature.
private_entries() { find "$1" \( -type d ! -perm -0055 \) -o \( -type f ! -perm -0044 \) -o \( -type f -perm -0100 ! -perm -0011 \); }
for a in "${ARCHES[@]}"; do chmod -R u+rwX,go+rX,go-w "$(app_dir "$a")/$APP_NAME.app"; done

# ---------------------------------------------------------------- checks on the signed apps
EXPECTED_ENTITLEMENTS="$(plutil -convert json -o - build/entitlements.mac.plist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).sort().join(" ")))')"

check_app() {
  local app="$1" team="$2" failures=0 count=0
  say "checking $app"
  if ! codesign --verify --deep --strict --verbose=2 "$app" 2>"$WORK/verify.log"; then
    sed 's/^/  /' "$WORK/verify.log"; failures=$((failures + 1))
  else
    ok "codesign --verify --deep --strict"
  fi
  # every Mach-O inside must be signed with the hardened runtime, by our team (or ad hoc in a dry run)
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q 'Mach-O'; then
      count=$((count + 1))
      local info; info="$(codesign -dv --verbose=4 "$f" 2>&1 || true)"
      if ! printf '%s' "$info" | grep -q 'flags=.*runtime'; then echo "  not hardened: ${f#"$app"/}"; failures=$((failures + 1)); fi
      if [ -n "$team" ] && ! printf '%s' "$info" | grep -q "^TeamIdentifier=$team$"; then echo "  wrong team: ${f#"$app"/}"; failures=$((failures + 1)); fi
      if [ -n "$team" ] && ! printf '%s' "$info" | grep -q '^Timestamp='; then echo "  no secure timestamp: ${f#"$app"/}"; failures=$((failures + 1)); fi
    fi
  done < <(find "$app" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.node' -o -name '*.so' \) -print0)
  ok "$count Mach-O files checked"
  # archives inside the app are opened by the notary service: a Mach-O in one must be signed too
  local nested
  nested="$(find "$app" -type f \( -name '*.zip' -o -name '*.jar' \) -print0 | xargs -0 -I{} python3 -I -c '
import sys, zipfile
p = sys.argv[1]
try:
    z = zipfile.ZipFile(p)
except Exception:
    sys.exit(0)
for n in z.namelist():
    with z.open(n) as fh:
        head = fh.read(4)
    if head in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
        print(p + "!" + n)
' {} || true)"
  if [ -n "$nested" ]; then echo "  Mach-O inside an archive (notarization will reject it unless signed):"; echo "$nested" | sed 's/^/    /'; failures=$((failures + 1)); fi
  local main="$app/Contents/MacOS/$APP_NAME" got
  got="$(codesign -d --entitlements :- "$main" 2>/dev/null | plutil -convert json -o - - | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).sort().join(" ")))')"
  [ "$got" = "$EXPECTED_ENTITLEMENTS" ] && ok "entitlements: $got" || { echo "  entitlements are \"$got\", expected \"$EXPECTED_ENTITLEMENTS\""; failures=$((failures + 1)); }
  if codesign -d --entitlements :- "$main" 2>/dev/null | grep -q get-task-allow; then echo "  get-task-allow is set (notarization rejects it)"; failures=$((failures + 1)); fi
  local plist="$app/Contents/Info.plist"
  for k in NSMicrophoneUsageDescription NSAppleEventsUsageDescription NSAccessibilityUsageDescription NSScreenCaptureUsageDescription; do
    /usr/libexec/PlistBuddy -c "Print :$k" "$plist" >/dev/null 2>&1 || { echo "  Info.plist lacks $k"; failures=$((failures + 1)); }
  done
  return "$failures"
}

TEAM_CHECK=""
[ "$IDENTITY" != "-" ] && TEAM_CHECK="$TEAM_ID"
for a in "${ARCHES[@]}"; do
  app="$(app_dir "$a")/$APP_NAME.app"
  [ -d "$app" ] || die "missing $app"
  check_app "$app" "$TEAM_CHECK" || die "$app failed the signing checks above"
done

# ---------------------------------------------------------------- notarize, staple, rebuild the dmg around the stapled app
notarize() {
  local file="$1" log="$2" out id status
  out="$(xcrun notarytool submit "$file" "${NOTARY_AUTH[@]}" --wait --timeout 2h --output-format json 2>&1)" || true
  id="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s.slice(s.indexOf("{"))).id||"")}catch{console.log("")}})')"
  status="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s.slice(s.indexOf("{"))).status||"")}catch{console.log("")}})')"
  if [ -n "$id" ]; then xcrun notarytool log "$id" "${NOTARY_AUTH[@]}" "$log" >/dev/null 2>&1 || true; fi
  if [ "$status" != Accepted ]; then
    echo "  notarization of $(basename "$file") ended as \"${status:-error}\" (submission ${id:-none}); details in $log"
    printf '%s\n' "$out" | tail -5 | sed 's/^/    /'
    return 1
  fi
  echo "  accepted: $(basename "$file") ($id)"
}

staple() {
  for attempt in 1 2 3 4 5 6; do
    xcrun stapler staple -q "$1" && return 0
    echo "  stapling $(basename "$1") failed (attempt $attempt of 6), retrying in 30 s"
    sleep 30
  done
  return 1
}

dmg_for() { echo "release/Metal-$VERSION-$1.dmg"; }
zip_for() { echo "release/Metal-$VERSION-$1.zip"; }
# the bots' browser, left out of the installer: the app downloads it from the release and checks the sha256 it pins
part_for() { echo "release/Metal-$VERSION-browser-darwin-$1.zip"; }
for a in "${ARCHES[@]}"; do [ -s "$(part_for "$a")" ] || die "missing $(part_for "$a") (scripts/pack-browser-part.mjs)"; done
mkdir -p release/notary

if [ "$MODE" = release ]; then
  say "notarizing the apps (round 1 of 2)"
  pids=()
  for a in "${ARCHES[@]}"; do
    ditto -c -k --sequesterRsrc --keepParent "$(app_dir "$a")/$APP_NAME.app" "$WORK/app-$a.zip"
    notarize "$WORK/app-$a.zip" "release/notary/app-$a.json" & pids+=($!)
    # a zip cannot be stapled: Gatekeeper finds the browser's ticket online
    notarize "$(part_for "$a")" "release/notary/browser-$a.json" & pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || die "app notarization failed (logs in release/notary/)"; done
  say "stapling the apps"
  for a in "${ARCHES[@]}"; do staple "$(app_dir "$a")/$APP_NAME.app" || die "could not staple the $a app"; done
fi

say "putting the stapled app into each dmg"
for a in "${ARCHES[@]}"; do
  scripts/mac-dmg-swap-app.sh "$(dmg_for "$a")" "$(app_dir "$a")/$APP_NAME.app" "$IDENTITY" "$KEYCHAIN" | sed 's/^/  /'
done

if [ "$MODE" = release ]; then
  say "notarizing the dmgs (round 2 of 2)"
  pids=()
  for a in "${ARCHES[@]}"; do notarize "$(dmg_for "$a")" "release/notary/dmg-$a.json" & pids+=($!); done
  for p in "${pids[@]}"; do wait "$p" || die "dmg notarization failed (logs in release/notary/)"; done
  say "stapling the dmgs"
  for a in "${ARCHES[@]}"; do staple "$(dmg_for "$a")" || die "could not staple $(dmg_for "$a")"; done
fi

say "re-zipping the stapled apps for the updater"
for a in "${ARCHES[@]}"; do
  [ -z "$(private_entries "$(app_dir "$a")/$APP_NAME.app" | head -1)" ] || die "the $a app has entries only its owner can read: $(private_entries "$(app_dir "$a")/$APP_NAME.app" | head -3)"
  rm -f "$(zip_for "$a")" "$(zip_for "$a").blockmap"
  ditto -c -k --sequesterRsrc --keepParent "$(app_dir "$a")/$APP_NAME.app" "$(zip_for "$a")"
done
for a in "${ARCHES[@]}"; do
  case "$a" in arm64) cp "$(dmg_for arm64)" release/Metal.dmg ;; x64) cp "$(dmg_for x64)" release/Metal-intel.dmg ;; esac
done

# ---------------------------------------------------------------- the checks a person's mac will run
say "Gatekeeper checks (as after a browser download)"
quarantine() { xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$1"; }
GATE_FAIL=0
gate() {
  # in a dry run the ad-hoc build is expected to be rejected; the point is that every check runs
  local label="$1"; shift
  local out; out="$("$@" 2>&1)" && { ok "$label"; printf '%s\n' "$out" | grep -v -e '^--prepared' -e '^--validated' | tail -4 | sed 's/^/        /'; return 0; }
  if [ "$MODE" != release ]; then echo "  expected (not notarized): $label"; printf '%s\n' "$out" | sed 's/^/        /' | head -3
  else echo "  FAILED: $label"; printf '%s\n' "$out" | sed 's/^/        /'; GATE_FAIL=$((GATE_FAIL + 1)); fi
}
for a in "${ARCHES[@]}"; do
  app="$(app_dir "$a")/$APP_NAME.app"; dmg="$(dmg_for "$a")"
  gate "$a app: codesign --verify --deep --strict" codesign --verify --deep --strict --verbose=2 "$app"
  gate "$a app: spctl -a -t exec" spctl -a -vvv -t exec "$app"
  gate "$a dmg: spctl -t open (primary signature)" spctl -a -vvv -t open --context context:primary-signature "$dmg"
  gate "$a app: stapler validate" xcrun stapler validate "$app"
  gate "$a dmg: stapler validate" xcrun stapler validate "$dmg"
  cp "$dmg" "$WORK/q-$a.dmg"; quarantine "$WORK/q-$a.dmg"
  gate "$a dmg with the quarantine flag: spctl -t open" spctl -a -vvv -t open --context context:primary-signature "$WORK/q-$a.dmg"
  mkdir -p "$WORK/q-$a"; ditto -x -k "$(zip_for "$a")" "$WORK/q-$a"
  find "$WORK/q-$a/$APP_NAME.app" -print0 | xargs -0 xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)"
  gate "$a updater zip, unpacked and quarantined: spctl -t exec" spctl -a -vvv -t exec "$WORK/q-$a/$APP_NAME.app"
  gate "$a updater zip, unpacked: stapler validate" xcrun stapler validate "$WORK/q-$a/$APP_NAME.app"
  mkdir -p "$WORK/part-$a"; ditto -x -k "$(part_for "$a")" "$WORK/part-$a"
  part_requirement=()
  [ "$IDENTITY" != "-" ] && part_requirement=(--test-requirement="=anchor apple generic and certificate leaf[subject.OU] = \"$TEAM_ID\"")
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q Mach-O || continue
    gate "$a browser part: codesign $(basename "$f")" codesign --verify --strict ${part_requirement[@]+"${part_requirement[@]}"} "$f"
  done < <(find "$WORK/part-$a" -type f -print0)
  if command -v syspolicy_check >/dev/null; then
    gate "$a app: syspolicy_check distribution" syspolicy_check distribution "$app"
  fi
done
[ "$GATE_FAIL" = 0 ] || die "$GATE_FAIL Gatekeeper check(s) failed"

if [ "$MODE" = release ]; then
  node -e '
    const fs = require("fs"), p = "apps/site/releases.json";
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j.macNotarized !== true) { j.macNotarized = true; fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); console.log("  set macNotarized: true in " + p + " (commit it with the release)"); }'
fi

case "$MODE" in dry) d="dry run, ad-hoc signed, not notarized" ;; signed) d="Developer ID signed, not notarized" ;; *) d="signed, notarized and stapled" ;; esac
say "done ($d)"
(cd release && shasum -a 256 DuskBot*.dmg Metal-*.zip | tee SHA256SUMS-mac | sed 's/^/  /')
echo "  upload with the installers: $(for a in "${ARCHES[@]}"; do printf '%s ' "$(part_for "$a")"; done)(the apps download them from the downloads release)"
