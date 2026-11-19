#!/bin/sh
# duskbot vps installer: the app shows one line to paste on a fresh server,
#   (curl -fsSL https://link.dusk.bot/i/<token> || echo 'echo "..." >&2; exit 1') | sh
# (the fallback makes a download that fails exit 1 with a plain message: a bare `curl | sh` runs nothing and exits 0)
# and this script installs everything, reports each step to the app through the link service, and links the server.
# safe to run again: every step checks what is already there, and a server that is already linked is only repaired.
# the link service bakes __LINK_BASE__ and __LINK_TOKEN__ in when it serves /i/<token>; run from a file it takes
# the token as $1 and LINK_BASE from the environment.
# knobs (env): LINK_BASE; DUSK_PACKAGE (an npm spec or tarball url: installs that instead of the build the link service
# serves, only when set); BOT_DESKTOP_IMAGE; NO_COLOR, DUSK_ASCII=1, DUSK_PLAIN=1, DUSK_NO_ANIM=1, DUSK_VERBOSE=1 (terminal);
# DUSK_INSTALL_DEMO=1 (or =fail) plays the whole screen with pretend steps and changes nothing, no root needed.
set -eu

PLACEHOLDER_BASE="__LINK""_BASE__"
PLACEHOLDER_TOKEN="__LINK""_TOKEN__"
BAKED_BASE="__LINK_BASE__"
BAKED_TOKEN="__LINK_TOKEN__"

if [ -z "${LINK_BASE:-}" ]; then
  if [ "$BAKED_BASE" = "$PLACEHOLDER_BASE" ]; then LINK_BASE="https://link.dusk.bot"; else LINK_BASE="$BAKED_BASE"; fi
fi
LINK_BASE=${LINK_BASE%/}
# the token, root-run code and the server build come from here: https only (plain http just for a loopback test service)
case "$LINK_BASE" in
  https://*) PROTO="=https" ;;
  http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) PROTO="=http,https" ;;
  *) printf 'LINK_BASE must be an https:// address.\n' >&2; exit 1 ;;
esac
if [ "$BAKED_TOKEN" = "$PLACEHOLDER_TOKEN" ]; then TOKEN="${1:-}"; else TOKEN="$BAKED_TOKEN"; fi

WANT="" ARGS_WANT="" CF_TOKEN="" CF_HOST="" TS_KEY="${DUSK_TAILSCALE_KEY:-}"
# this run's scratch folder (main makes it); never one from the environment
TMP="" IPV4_ONLY=""

DUSK_PACKAGE="${DUSK_PACKAGE:-}"
# the bot computer: the link service names the image (BOT_DESKTOP_IMAGE in shared/bot-desktop.ts) and hands out
# deploy/bot-desktop/ as a kit; the image is pulled when a registry copy exists, else built here. the env wins.
BOT_DESKTOP_IMAGE="${BOT_DESKTOP_IMAGE:-}"
KIT_DIR=/opt/duskbot-link/bot-desktop
DEMO="${DUSK_INSTALL_DEMO:-}"
[ "$DEMO" = 0 ] && DEMO=""

SVC_USER=dusk
SVC_HOME=/home/dusk
# names from before the rename (the app's own copy is electron/legacy-names.mjs). a server set up then keeps its
# server account; its folders, units and profiles move to the new names (migrate_legacy) the next time this runs.
OLD=openmausbot
OLD_SVC_USER=maus
if ! id "$SVC_USER" >/dev/null 2>&1 && id "$OLD_SVC_USER" >/dev/null 2>&1; then SVC_USER=$OLD_SVC_USER SVC_HOME=/home/$OLD_SVC_USER; fi
OLD_UNITS="$OLD-link.service $OLD.service $OLD-engines.path $OLD-handoff.service $OLD-restart.service"
DATA=$SVC_HOME/.duskbot
# accounts: the server runs as $SVC_USER and never holds docker, the link agent as omb-link (tunnel.json and the app's ssh key
# are its own), docker only through the gate as omb-docker; every bot's turn runs in the bot box (DUSK_BOT_BOX=required)
LINK_USER=omb-link
LINK_HOME=/var/lib/omb-link
HANDOFF=$LINK_HOME/handoff
GATE_USER=omb-docker
GATE_GROUP=omb-dockergate
GATE_SOCK=/run/duskbot-docker/docker.sock
LIB=/usr/local/lib/duskbot
GATE=$LIB/docker-gate.mjs
ETC=/etc/duskbot
CLAUDE_TOKEN_LINE='^CLAUDE_CODE_OAUTH_TOKEN=[A-Za-z0-9._~+/=-]{20,}$'
STATE=/var/lib/duskbot-link
LOGS=/var/log/duskbot-link
LOGS_SHOWN=$LOGS
# what this script added that was not here before (packages, apt sources, config it replaced), one line each, so
# uninstall.sh puts back exactly that. kept apart from $STATE: a plain uninstall leaves it for a later --all.
MANIFEST=/var/lib/duskbot/install-manifest
INSTALL_LOCK=/run/duskbot-install.lock
AGENT=/opt/duskbot-link/agent.mjs
# root's copy of this script, run by duskbot-server-update.timer as `--update-server`; the build it installs is the one
# the link agent staged in its own folder, which this script checks again from scratch
UPDATER=/usr/local/lib/duskbot/install.sh
# the server builds root checked (the one running and the one before, for a rollback), in root's own folder: root never
# writes, reads or changes a path inside the server account's home, which that account could point anywhere
PKGS=/var/lib/duskbot-link/packages
SERVER_RELEASE=/var/lib/omb-link/.config/duskbot-link/server-release
PORT=8799
# `duskbot` for whoever is logged in: the server's own build lives in the server account's home, off root's PATH
CLI=/usr/local/bin/duskbot
UNITS=/etc/systemd/system
CADDY_SITE=/etc/caddy/duskbot.caddy
CADDY_MAIN=/etc/caddy/Caddyfile
# what the link agent reads to tell the app where this server is (no secret in it)
ADDRESS=/etc/duskbot-address.json
CF_METRICS=20241
OLD_STATE=/var/lib/$OLD-link OLD_LOGS=/var/log/$OLD-link OLD_MANIFEST=/var/lib/$OLD/install-manifest OLD_AGENT_DIR=/opt/$OLD-link
OLD_LIB=/usr/local/lib/$OLD OLD_ETC=/etc/$OLD OLD_BWRAP_PROFILE=/etc/apparmor.d/$OLD-bwrap OLD_CADDY_SITE=/etc/caddy/$OLD.caddy
export DEBIAN_FRONTEND=noninteractive

say() { printf '%s\n' "$*"; }
fail_line() { printf '\n%s\n' "$*" >&2; }

# ---------- terminal ----------
# tty: spinner, checklist, colors (if allowed). plain: one line per step, no escapes (pipes, logs, TERM=dumb).
ESC=$(printf '\033')
UI=plain DEPTH=0 ASCII=1 COLS=80 ROWS=24 LIST=0 MS=1 TICK=0.12 MASCOT=0 MASCOT_COL=61 TICKS=0
R="" BOLD="" DIM="" OK="" ACC="" WARN="" ERR="" SHADOW="" FAINT="" EL=""
ui_init() {
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ] && [ "${DUSK_PLAIN:-}" != 1 ]; then UI="tty"; fi
  size=$( { stty size </dev/tty; } 2>/dev/null || true)
  case "$size" in
    [0-9]*' '[0-9]*) ROWS=${size% *}; COLS=${size#* } ;;
    *) case "${COLUMNS:-}" in [0-9]*) COLS=$COLUMNS ;; esac ;;
  esac
  [ "$COLS" -ge 20 ] 2>/dev/null || COLS=80
  case "$(date +%s%N 2>/dev/null)" in *N*|'') MS=0 ;; esac
  [ "$UI" = tty ] || return 0
  ASCII=0
  [ "${DUSK_ASCII:-}" = 1 ] && ASCII=1
  EL="${ESC}[K"
  if [ -z "${NO_COLOR:-}" ]; then
    case "${COLORTERM:-}" in
      truecolor|24bit) DEPTH=24 ;;
      *) case "${TERM:-}" in *256col*|xterm-kitty|*ghostty*|wezterm|alacritty|tmux*) DEPTH=8 ;; *) DEPTH=4 ;; esac ;;
    esac
  fi
  [ "$DEPTH" -gt 0 ] || return 0
  R="${ESC}[0m" BOLD="${ESC}[1m"
  case "$DEPTH" in
    24) DIM="${ESC}[38;2;118;128;140m" OK="${ESC}[38;2;46;230;140m" ACC="${ESC}[38;2;0;214;250m" WARN="${ESC}[38;2;250;190;70m"
        ERR="${ESC}[38;2;255;92;92m" SHADOW="${ESC}[38;2;58;72;98m" FAINT="${ESC}[38;2;86;98;116m" ;;
    8) DIM="${ESC}[38;5;245m" OK="${ESC}[38;5;42m" ACC="${ESC}[38;5;45m" WARN="${ESC}[38;5;214m" ERR="${ESC}[38;5;203m"
       SHADOW="${ESC}[38;5;238m" FAINT="${ESC}[38;5;241m" ;;
    *) DIM="${ESC}[90m" OK="${ESC}[32m" ACC="${ESC}[36m" WARN="${ESC}[33m" ERR="${ESC}[31m" SHADOW="${ESC}[90m" FAINT="${ESC}[90m" ;;
  esac
}

now_ms() {
  if [ "$MS" = 1 ]; then _t=$(date +%s%N); printf '%s' "${_t%??????}"; else printf '%s000' "$(date +%s)"; fi
}
fmt_ms() { # milliseconds -> 0.4s, 12s, 3m 07s
  if [ "$1" -lt 10000 ] && [ "$MS" = 1 ]; then printf '%d.%ds' $(($1 / 1000)) $(($1 % 1000 / 100))
  elif [ "$1" -lt 60000 ]; then printf '%ds' $(($1 / 1000))
  else printf '%dm %02ds' $(($1 / 60000)) $(($1 % 60000 / 1000)); fi
}
fmt_mb() { _t=$(($1 * 10 / 1048576)); printf '%d.%d' $((_t / 10)) $((_t % 10)); }

glyph() { # name -> G
  if [ "$ASCII" = 1 ]; then
    case "$1" in ok) G="+" ;; sep) G="-" ;; fail) G="x" ;; skip) G="o" ;; wait) G="." ;; fill) G="#" ;; rest) G="-" ;; arrow) G=">" ;; bar) G="|" ;; esac
  else
    case "$1" in ok) G="✔" ;; sep) G="·" ;; fail) G="✖" ;; skip) G="○" ;; wait) G="·" ;; fill) G="█" ;; rest) G="░" ;; arrow) G="→" ;; bar) G="│" ;; esac
  fi
}
spin_frame() { # tick -> G (braille dots, see third_party/cli-spinners)
  if [ "$ASCII" = 1 ]; then
    case $(($1 % 4)) in 0) G="|" ;; 1) G="/" ;; 2) G="-" ;; *) G="\\" ;; esac
    return 0
  fi
  case $(($1 % 10)) in
    0) G="⠋" ;; 1) G="⠙" ;; 2) G="⠹" ;; 3) G="⠸" ;; 4) G="⠼" ;; 5) G="⠴" ;; 6) G="⠦" ;; 7) G="⠧" ;; 8) G="⠇" ;; *) G="⠏" ;;
  esac
}

# the wordmark: an ascii template (# full block, p upper half, b lower half) drawn with a diagonal gradient and a
# one-cell drop shadow. original art, no font file.
banner_art() {
  cat <<'EOF'
######b   ##    ##   b######  ##   b#p     ######b    b####b   ########
##    ##  ##    ##  ##        ##  b#p      ##    ##  ##    ##     ##
##    ##  ##    ##   p####b   #####        #######   ##    ##     ##
##    ##  ##    ##        ##  ##  p#b      ##    ##  ##    ##     ##
######p    p####p   ######p   ##   p#b     ######p    p####p      ##
EOF
}
# the intro: the block letters decode out of noise, a light sweeps across once, then they stay. about a second,
# one awk process, frames drawn in place (cursor up, overwrite). static when there is no color to animate.
banner() {
  say ""
  if [ "$UI" != tty ] || [ "$ASCII" = 1 ] || [ "$COLS" -lt 80 ]; then
    say "  ${ACC}${BOLD}Metal${R}  ${DIM}server setup${R}"
    say ""
    MASCOT=0
    return 0
  fi
  anim=0; [ "$DEPTH" -ge 8 ] && [ "${DUSK_NO_ANIM:-}" != 1 ] && anim=1
  banner_art | awk -v depth="$DEPTH" -v esc="$ESC" -v shade="$SHADOW" -v reset="$R" -v anim="$anim" -v seed="$$" '
    function lerp(a, b, t) { return int(a + (b - a) * t + 0.5) }
    function code(r, g, b) {
      if (depth == 24) return esc "[38;2;" r ";" g ";" b "m"
      if (depth == 8) return esc "[38;5;" (16 + 36 * int(r / 51 + 0.5) + 6 * int(g / 51 + 0.5) + int(b / 51 + 0.5)) "m"
      if (depth == 4) return esc "[1;36m"
      return ""
    }
    # the gradient at a cell; light 0..1 mixes it toward white, dark scales it down
    function paint(x, y, light, dark,   t, s, r, g, b) {
      t = (x + y * 3) / (w + rows * 3)
      if (t < 0.5) { s = t * 2; r = lerp(40, 0, s); g = lerp(255, 200, s); b = lerp(150, 255, s) }
      else { s = (t - 0.5) * 2; r = lerp(0, 190, s); g = lerp(200, 110, s); b = lerp(255, 255, s) }
      if (light > 0) { r = lerp(r, 255, light); g = lerp(g, 255, light); b = lerp(b, 255, light) }
      if (dark > 0) { r = int(r * dark); g = int(g * dark); b = int(b * dark) }
      return code(r, g, b)
    }
    function frame(f,   y, x, c, p, k, out, last, glyph, d, center) {
      if (f > 0) printf "%s[%dA", esc, rows
      center = (f - D) / (S - 1) * (w + 24) - 12
      for (y = 1; y <= rows; y++) {
        out = "\r  "; last = ""
        for (x = 1; x <= w + 1; x++) {
          c = (y <= NR) ? substr(art[y], x, 1) : " "
          p = (y > 1 && x > 1) ? substr(art[y - 1], x - 1, 1) : " "
          if (c == "#" || c == "p" || c == "b") {
            glyph = (c == "#" ? "█" : (c == "p" ? "▀" : "▄"))
            if (f < D && key[y, x] > (f + 1) / D * 1.35 - x / w * 0.35) { k = paint(x, y, 0, 0.35 + rand() * 0.3); glyph = noise[int(rand() * 6)] }
            else if (f >= D && f < D + S) { d = x + y * 2 - center; if (d < 0) d = -d; k = paint(x, y, d < 4 ? (1 - d / 4) * 0.85 : 0, 0) }
            else k = paint(x, y, 0, 0)
            if (k != last) { out = out k; last = k }
            out = out glyph
          } else if (p == "#" && f >= D - 2) {
            if (last != shade) { out = out shade; last = shade }
            out = out "░"
          } else out = out " "
        }
        sub(/ +$/, "", out)
        printf "%s%s%s[K\n", out, (last != "" ? reset : ""), esc
      }
      fflush()
    }
    { art[NR] = $0; if (length($0) > w) w = length($0) }
    END {
      rows = NR + 1; D = 9; S = 9
      split("░ ▒ ▓ ▚ ▞ ▙", n, " "); for (i = 0; i < 6; i++) noise[i] = n[i + 1]
      srand(seed)
      for (y = 1; y <= rows; y++) for (x = 1; x <= w + 1; x++) key[y, x] = rand()
      if (!anim) { frame(D + S); exit }
      for (f = 0; f <= D + S; f++) { frame(f); if (f < D + S) system("sleep 0.05") }
    }'
  say ""
  # the mascot sits at column MASCOT_COL of this line; watch_step wags its tail while work runs
  printf '  %s%-58s%s%s<:3 )~%s\n' "$DIM" "your own team of AI bots, on your own server" "$R" "$ACC" "$R"
  MASCOT_COL=61 MASCOT=1
  [ "$DEPTH" -gt 0 ] || MASCOT=0
  say ""
}

# the mascot while a step runs: tail wags, now and then a blink. drawn in place a few lines up, only when the whole
# screen is known to fit (LIST mode), so the cursor never lands anywhere else.
BELOW_TAG=3
mascot() { # tick
  [ "$MASCOT" = 1 ] && [ "$LIST" = 1 ] || return 0
  case $(($1 / 4 % 10)) in
    1|7) _m="<:3 )-" ;; 3) _m="<:3 )_" ;; 5) _m="<.3 )~" ;; 9) _m="<:3 )-" ;; *) _m="<:3 )~" ;;
  esac
  _up=$((BELOW_TAG + 1 + PH_IDX))
  printf '%s[%dA%s[%dG%s%s%s%s[%dB\r' "$ESC" "$_up" "$ESC" "$MASCOT_COL" "$ACC" "$_m" "$R" "$ESC" "$_up"
}

# one step line: "  ✔ Title            1.2s  extra"; the title column is TW wide, the time column 6
TW=32
draw() { # glyph-color glyph time extra
  printf '\r  %s%s%s %s %s%6s%s  %s%s' "$1" "$2" "$R" "$TPAD" "$DIM" "$3" "$R" "$4" "$EL"
}
pending_line() { glyph wait; printf '\r  %s%s %s%s%s\n' "$DIM" "$G" "$(phase_title "$1")" "$R" "$EL"; }

progress_text() { # done total unit -> X (bar, percent, amounts), sized to what is left of the line
  _avail=$((COLS - TW - 15 - ${#SUBTXT} - 2))
  if [ "${2:-0}" -le 0 ] 2>/dev/null; then
    [ "$3" = MB ] && X="${DIM}$(fmt_mb "$1") MB${R}" || X="${DIM}$1 $3${R}"
    return 0
  fi
  _d=$1; [ "$_d" -gt "$2" ] && _d=$2
  _pct=$((_d * 100 / $2))
  if [ "$3" = MB ]; then _amt="$(fmt_mb "$_d")/$(fmt_mb "$2") MB"; else _amt="$_d/$2 $3"; fi
  _bw=$((_avail - ${#_amt} - 7)); [ "$_bw" -gt 28 ] && _bw=28
  X=""
  if [ "$_bw" -ge 6 ]; then
    _f=$((_d * _bw / $2)) _k=0 _on="" _off=""
    glyph fill; _gf=$G; glyph rest
    while [ "$_k" -lt "$_bw" ]; do
      if [ "$_k" -lt "$_f" ]; then _on="$_on$_gf"; else _off="$_off$G"; fi
      _k=$((_k + 1))
    done
    X="${ACC}${_on}${SHADOW}${_off}${R} "
  fi
  X=$(printf '%s%3d%%  %s%s%s' "$X" "$_pct" "$DIM" "$_amt" "$R")
}

# draws the spinner line until the step's process ends. the step tells it about downloads through $PROGRESS:
#   file <path> <total bytes>   bytes <done> <total>   count <done> <total> <unit>
spin_color() { # tick -> SC: mint, cyan, violet and back, a slow drift
  case "$DEPTH" in
    24) case $(($1 / 2 % 6)) in 0) SC="${ESC}[38;2;40;255;150m" ;; 1|5) SC="${ESC}[38;2;0;230;210m" ;; 2|4) SC="${ESC}[38;2;0;200;255m" ;; *) SC="${ESC}[38;2;170;120;255m" ;; esac ;;
    8) case $(($1 / 2 % 6)) in 0) SC="${ESC}[38;5;48m" ;; 1|5) SC="${ESC}[38;5;44m" ;; 2|4) SC="${ESC}[38;5;45m" ;; *) SC="${ESC}[38;5;141m" ;; esac ;;
    *) SC=$ACC ;;
  esac
}
watch_step() {
  _i=${TICKS:-0} _tail=""
  _tw=$((COLS - TW - 16 - ${#SUBTXT} - 2))
  while [ ! -f "$TMP/rc" ]; do
    [ ! -f "$TMP/cancelled" ] || on_stop
    if [ -f "$TMP/sub" ] && read -r _sl < "$TMP/sub" && [ -n "$_sl" ] && [ "$_sl" != "$SUBTXT" ]; then
      SUBTXT=$_sl SUB="${DIM}${_sl}${R}  " _tw=$((COLS - TW - 16 - ${#_sl} - 2))
    fi
    _el=$(fmt_ms $(($(now_ms) - PH_T0)))
    X=""
    if [ -f "$PROGRESS" ] && read -r _kind _a _b _c 2>/dev/null <"$PROGRESS"; then
      case "$_kind" in
        file) _cur=$(wc -c 2>/dev/null <"$_a" | tr -cd 0-9); progress_text "${_cur:-0}" "$_b" MB ;;
        bytes) progress_text "$_a" "$_b" MB ;;
        count) progress_text "$_a" "$_b" "${_c:-}" ;;
      esac
    elif [ "$_tw" -gt 10 ]; then
      [ $((_i % 3)) -eq 0 ] && _tail=$(tail -n 1 "$LOG" 2>/dev/null | tr -cd '\40-\176' | cut -c1-"$_tw")
      X="${FAINT}${_tail}${R}"
    fi
    [ $((_i % 4)) -eq 3 ] && stream_lines
    [ $((_i % 4)) -eq 1 ] && show_asks
    spin_frame "$_i"
    spin_color "$_i"
    [ $((_i % 4)) -eq 0 ] && mascot "$_i"
    draw "$SC" "$G" "$_el" "$SUB$X"
    _i=$((_i + 1))
    sleep "$TICK"
  done
  TICKS=$_i
}

# ---------- root ----------
become_root() {
  [ "$(id -u)" -eq 0 ] && return 0
  if ! command -v sudo >/dev/null 2>&1; then
    fail_line "Please run this as root (or install sudo), then paste the line again."
    exit 1
  fi
  say "Asking for administrator rights..."
  if [ -r "$0" ] && [ "${0##*/}" != "sh" ] && [ "${0##*/}" != "dash" ]; then
    # shellcheck disable=SC2046
    exec sudo env LINK_BASE="$LINK_BASE" DUSK_PACKAGE="$DUSK_PACKAGE" BOT_DESKTOP_IMAGE="$BOT_DESKTOP_IMAGE" DUSK_TAILSCALE_KEY="$TS_KEY" \
      COLORTERM="${COLORTERM:-}" NO_COLOR="${NO_COLOR:-}" DUSK_ASCII="${DUSK_ASCII:-}" DUSK_PLAIN="${DUSK_PLAIN:-}" DUSK_NO_ANIM="${DUSK_NO_ANIM:-}" DUSK_VERBOSE="${DUSK_VERBOSE:-}" sh "$0" "$TOKEN" $(way_args)
  fi
  # piped: the script is gone from stdin, so fetch it again for root, into a file first so a failed download stops here
  _self=$(mktemp) || exit 1
  if ! retry curl -fsSL --proto "$PROTO" --proto-redir "$PROTO" --connect-timeout 15 -m 120 "$LINK_BASE/i" -o "$_self" >/dev/null 2>&1; then
    rm -f "$_self"
    fail_line "Couldn't download the installer for administrator rights. Check this server's internet connection and paste the line again."
    exit 1
  fi
  chmod 0644 "$_self"
  # shellcheck disable=SC2046
  sudo env LINK_BASE="$LINK_BASE" DUSK_PACKAGE="$DUSK_PACKAGE" BOT_DESKTOP_IMAGE="$BOT_DESKTOP_IMAGE" DUSK_TAILSCALE_KEY="$TS_KEY" \
    COLORTERM="${COLORTERM:-}" NO_COLOR="${NO_COLOR:-}" DUSK_ASCII="${DUSK_ASCII:-}" DUSK_PLAIN="${DUSK_PLAIN:-}" DUSK_NO_ANIM="${DUSK_NO_ANIM:-}" DUSK_VERBOSE="${DUSK_VERBOSE:-}" sh "$_self" "$TOKEN" $(way_args) </dev/null
  _code=$?
  rm -f "$_self"
  exit "$_code"
}

# ---------- helpers ----------
# every command worth seeing goes into the step's log as "$ command", which the app's terminal mirror shows
show() { printf '$ %s\n' "$*" | redact; }
x() { show "$@"; "$@"; }
# five tries, 2, 5, 10 and 20 seconds apart. a curl that fails to connect or loses its tls handshake (a flaky ipv6 path
# gives curl 35, "unexpected eof") tries the other address family next; the family that works stays for the whole run
RETRY_WAITS="2 5 10 20"
net_error() { case "$1" in 7|28|35|52|55|56) return 0 ;; *) return 1 ;; esac; }
ipv4_only() { if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then [ -f "$TMP/ipv4" ]; else [ -n "${IPV4_ONLY:-}" ]; fi; }
flip_family() {
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
    if [ -f "$TMP/ipv4" ]; then rm -f "$TMP/ipv4"; else : > "$TMP/ipv4"; fi
  elif [ -n "${IPV4_ONLY:-}" ]; then IPV4_ONLY=""; else IPV4_ONLY=1; fi
}
ncurl() { if ipv4_only; then curl -4 "$@"; else curl "$@"; fi; }
retry() {
  _rn=1
  if [ "$1" = as_user ]; then shift; show "$@"; set -- as_user "$@"; else show "$@"; fi
  for _rw in $RETRY_WAITS ""; do
    if [ "$1" = curl ]; then shift; ncurl "$@" && return 0 || _rrc=$?; set -- curl "$@"
    else "$@" && return 0 || _rrc=$?; fi
    [ -n "$_rw" ] || return "$_rrc"
    _rhow=""
    if [ "$1" = curl ] && net_error "$_rrc"; then flip_family; if ipv4_only; then _rhow=" over ipv4"; else _rhow=" over any address"; fi; fi
    printf 'attempt %s/5 failed (exit %s); retrying%s in %s seconds\n' "$_rn" "$_rrc" "$_rhow" "$_rw"
    sleep "$_rw"
    _rn=$((_rn + 1))
  done
}

manifest_add() { # line
  [ -n "$DEMO" ] && return 0
  install -d -m 0755 "${MANIFEST%/*}"
  grep -qxF "$1" "$MANIFEST" 2>/dev/null || printf '%s\n' "$1" >> "$MANIFEST"
}
# a file this script creates, recorded only when it was not there before
new_file() { [ -e "$1" ] || manifest_add "file $1"; }
installed_pkgs() { dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 2>/dev/null | awk '$1 ~ /^ii/ { print $2 }' | sort -u; }
# apt-get install, recording every package it added (dependencies too) in the manifest
apt_get_install() { # args...
  installed_pkgs > "$TMP/pkgs.before"
  if retry apt-get -y -q -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install "$@"; then _rc=0; else _rc=1; fi
  installed_pkgs | comm -13 "$TMP/pkgs.before" - | while read -r _p; do manifest_add "pkg $_p"; done
  return "$_rc"
}

# a run stopped inside apt (Ctrl-C, a dropped ssh) leaves dpkg half done, and apt refuses everything until it is finished
dpkg_heal() {
  [ -z "$(ls -A /var/lib/dpkg/updates 2>/dev/null)" ] && [ -z "$(dpkg --audit 2>/dev/null)" ] && return 0
  echo "finishing a package install that was interrupted"
  x dpkg --force-confdef --force-confold --configure -a || true
}
apt_update() {
  [ -f "$TMP/apt-updated" ] && return 0
  dpkg_heal
  retry apt-get -q -o DPkg::Lock::Timeout=300 update && : > "$TMP/apt-updated"
}
apt_install() {
  missing=""
  for pkg in "$@"; do dpkg -s "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"; done
  [ -z "$missing" ] && return 0
  apt_update
  # shellcheck disable=SC2086
  apt_get_install --no-install-recommends $missing
}
fetch() { retry curl -fsSL --proto "$PROTO" --proto-redir "$PROTO" --connect-timeout 15 -m 300 "$1" -o "$2"; }

as_user() { runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$SVC_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

state_get() { [ -f "$STATE/$1" ] && cat "$STATE/$1" || true; }
state_set() { printf '%s\n' "$2" > "$STATE/$1.tmp" && mv "$STATE/$1.tmp" "$STATE/$1"; }
progress() { rm -f "$PROGRESS.json"; printf '%s\n' "$*" > "$PROGRESS.tmp" && mv "$PROGRESS.tmp" "$PROGRESS"; }
# a step names the part it is on now, in place of its title on the spinner line
sub_label() { printf '%s\n' "$*" > "$TMP/sub.tmp" && mv -f "$TMP/sub.tmp" "$TMP/sub"; }

# no bearer token, link secret or api key ever leaves this script: not into a log, not to the app
redact() {
  if [ -n "${VPS_TOKEN:-}" ]; then set -- -e "s/$VPS_TOKEN/[redacted]/g" -e "s/$SECRET/[redacted]/g"; else set --; fi
  sed -e 's/[Bb]earer [A-Za-z0-9._~+\/=-]*/Bearer [redacted]/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]*/sk-ant-[redacted]/g' -e 's/sk-[A-Za-z0-9_-]\{20,\}/sk-[redacted]/g' \
    -e 's/\([Tt][Oo][Kk][Ee][Nn]["=: ]\{1,3\}\)[^ "&,]*/\1[redacted]/g' \
    -e 's/\([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]["=: ]\{1,3\}\)[^ "&,]*/\1[redacted]/g' \
    -e 's/\([Ss][Ee][Cc][Rr][Ee][Tt]["=: ]\{1,3\}\)[^ "&,]*/\1[redacted]/g' \
    -e 's/\(_KEY["=: ]\{1,3\}\)[^ "&,]*/\1[redacted]/g' "$@"
}
json_lines() { # stdin lines -> the inside of a json string array
  tr -d '\000-\010\013\014\016-\037\177' | tr '\t' ' ' | cut -c1-300 | redact \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s\"%s\"", (NR > 1 ? "," : ""), $0 }'
}
json_escape_file() {
  # last lines of a log as one json string body: no control characters, quotes and backslashes escaped
  tail -n 30 "$1" 2>/dev/null | tail -c 3500 | tr -d '\000-\010\013\014\016-\037' | tr '\t' ' ' | redact \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s\\n", $0 }'
}
app_step() { case "$1" in sandbox|fence) echo desktop ;; *) echo "$1" ;; esac; }

# the step's new log lines (and the command they belong to) to the app every ~0.5 s while it runs: at most 40 lines
# a batch, older ones skipped, one batch in flight at a time. "final" waits for it, so nothing lands after "done".
SENT=0 CMD="" STEP_T0=0 LAST_ACTIVITY=0 LAST_SIGNATURE="" LAST_POST=0
progress_snapshot() {
  _progress="" _progress_sig=""
  if [ -f "$PROGRESS.json" ]; then
    _progress=$(cat "$PROGRESS.json")
    _progress_sig=$_progress
  elif [ -f "$PROGRESS" ] && read -r _kind _a _b _c < "$PROGRESS"; then
    case "$_kind" in
      file)
        _a=$( { wc -c < "$_a"; } 2>/dev/null | tr -cd 0-9)
        _a=${_a:-0}
        case "$_a:$_b" in *[!0-9:]*|:*|*:) ;; *)
          _progress="{\"kind\":\"download\",\"receivedBytes\":$_a${_b:+,\"totalBytes\":$_b}}" ;;
        esac ;;
      bytes)
        case "$_a:$_b" in *[!0-9:]*|:*|*:) ;; *) _progress="{\"kind\":\"download\",\"receivedBytes\":$_a,\"totalBytes\":$_b}" ;; esac ;;
      count)
        case "$_a:$_b" in *[!0-9:]*|:*|*:) ;; *)
          case "$_c" in layers) _kind=layers ;; steps) _kind=build ;; *) _kind="" ;; esac
          [ -z "$_kind" ] || _progress="{\"kind\":\"$_kind\",\"completed\":$_a,\"total\":$_b}" ;;
        esac ;;
    esac
    _progress_sig=$_progress
  fi
  _size=$( { wc -c < "$LOG"; } 2>/dev/null | tr -cd 0-9)
  _signature="${_size:-0}|$_progress_sig"
  _now=$(now_ms)
  _heartbeat=true
  if [ "$_signature" != "$LAST_SIGNATURE" ]; then LAST_ACTIVITY=$_now; LAST_SIGNATURE=$_signature; _heartbeat=false; fi
  _elapsed=$((_now - STEP_T0)) _quiet=$((_now - LAST_ACTIVITY))
  [ "$_elapsed" -ge 0 ] || _elapsed=0
  [ "$_quiet" -ge 0 ] || _quiet=0
  [ "$_quiet" -le "$_elapsed" ] || _quiet=$_elapsed
}

POST_RC=0 POST_CODE=000
post_event() {
  POST_RC=0
  _answer=$(ncurl -sS --proto "$PROTO" --proto-redir "$PROTO" --connect-timeout 2 -m 5 -w '\n%{http_code}' -X POST -H "authorization: Bearer $VPS_TOKEN" -H "content-type: application/json" \
    --data "$1" "$LINK_BASE/v1/sessions/$LINK_ID/events" 2>/dev/null) || POST_RC=$?
  POST_CODE=${_answer##*
}
  [ "$POST_RC" = 0 ] || { POST_CODE=000; return 1; }
  case "$_answer" in
    *'"code":"cancelled"'*) : > "$TMP/cancelled" ;;
  esac
  [ "$POST_CODE" = 200 ]
}

stream_lines() { # [final]
  [ "$OFFLINE" = 1 ] || [ -n "$DEMO" ] && return 0
  progress_snapshot
  if [ "${1:-}" = final ]; then _w=0; while [ -f "$TMP/posting" ] && [ "$_w" -lt 50 ]; do sleep 0.1; _w=$((_w + 1)); done
  elif [ -f "$TMP/posting" ]; then return 0; fi
  _n=$(wc -l 2>/dev/null <"$LOG" | tr -cd 0-9); _n=${_n:-0}
  if [ "$_n" -le "$SENT" ] && [ "$_heartbeat" = true ] && [ $((_now - LAST_POST)) -lt 2000 ]; then return 0; fi
  _from=$((SENT + 1)) _skip=""
  if [ $((_n - SENT)) -gt 40 ]; then _from=$((_n - 39)); _skip="[$((_n - SENT - 40)) more lines]"; fi
  _batch=""
  [ "$_n" -le "$SENT" ] || _batch=$(sed -n "${_from},${_n}p" "$LOG")
  _c=$(printf '%s\n' "$_batch" | sed -n 's/^\$ //p' | tail -n 1 | cut -c1-200)
  [ -n "$_c" ] && CMD=$_c
  _lines=$( { [ -n "$_skip" ] && printf '%s\n' "$_skip"; [ -z "$_batch" ] || printf '%s\n' "$_batch"; } | json_lines)
  SENT=$_n
  LAST_POST=$_now
  _cmd=$(printf '%s\n' "$CMD" | json_lines)
  _body="{\"step\":\"$(app_step "$STEP_ID")\",\"status\":\"running\",${CMD:+\"cmd\":$_cmd,}\"lines\":[$_lines],\"activity\":{\"elapsedMs\":$_elapsed,\"quietMs\":$_quiet},\"heartbeat\":$_heartbeat${_progress:+,\"progress\":$_progress}}"
  : > "$TMP/posting"
  ( post_event "$_body" || true; rm -f "$TMP/posting" ) &
  if [ "${1:-}" = final ]; then wait $!; fi
  return 0
}

OFFLINE=0 REPAIR=0
report() { # step status [logfile]
  [ "$OFFLINE" = 1 ] && return 0
  [ -n "$DEMO" ] && return 0
  # the app knows one "desktop" step; sandbox and fence are its first parts, so they only say it is running
  case "$1" in sandbox|fence) [ "$2" = running ] || return 0; set -- desktop running ;; esac
  if [ -n "${3:-}" ]; then
    body="{\"step\":\"$1\",\"status\":\"$2\",\"log\":\"$(json_escape_file "$3")\"}"
  else
    body="{\"step\":\"$1\",\"status\":\"$2\"}"
  fi
  [ "$2" != running ] || { post_event "$body" || true; return 0; }
  # how a step ended has to reach the app (a failed one most of all, or the app keeps waiting for this server): a
  # network error or a 5xx is tried again like a download, an answer such as 401 or 410 is not
  for _pw in $RETRY_WAITS ""; do
    post_event "$body" && return 0
    case "$POST_CODE" in 000|5*) ;; *) return 0 ;; esac
    [ -n "$_pw" ] || return 0
    ! net_error "$POST_RC" || flip_family
    sleep "$_pw"
  done
}

# something only the person can do (sign in, add a DNS record, open a port): the step writes what the terminal shows to
# $TMP/notice and what the app shows to $TMP/ask.json (installerAsk in src/app.mjs); each is shown once per change
ask() { # json, stdin: the lines for the terminal (also kept in the step's log)
  tee "$TMP/notice.tmp" && mv -f "$TMP/notice.tmp" "$TMP/notice"
  printf '%s\n' "$1" > "$TMP/ask.tmp" && mv -f "$TMP/ask.tmp" "$TMP/ask.json"
}
ask_clear() { rm -f "$TMP/notice"; printf '{"kind":"none"}\n' > "$TMP/ask.tmp" && mv -f "$TMP/ask.tmp" "$TMP/ask.json"; }
show_asks() {
  if [ -f "$TMP/ask.json" ] && ! cmp -s "$TMP/ask.json" "$TMP/ask.sent" 2>/dev/null; then
    cp "$TMP/ask.json" "$TMP/ask.sent"
    if [ "$OFFLINE" != 1 ] && [ -z "$DEMO" ]; then
      post_event "{\"step\":\"$(app_step "$STEP_ID")\",\"status\":\"running\",\"ask\":$(head -c 2000 "$TMP/ask.sent")}" || true
    fi
  fi
  if [ -f "$TMP/notice" ] && ! cmp -s "$TMP/notice" "$TMP/notice.shown" 2>/dev/null; then
    cp "$TMP/notice" "$TMP/notice.shown"
    # the checklist drawn in place ends here: the rest prints below the notice
    printf '\r%s\n' "$EL"
    tr -cd '\12\40-\176' < "$TMP/notice.shown" | while IFS= read -r _l; do printf '    %s%s%s\n' "$ACC$BOLD" "$_l" "$R"; done
    printf '\n'
    LIST=0
    [ "$UI" = tty ] || printf '  %-34s' "$(phase_title "$PH_ID")..."
  fi
}

# plain words for a failed step, printed once in the terminal
failure_words() {
  case "$1" in
    check) say "This server can't run Metal as it is: the lines above say why. It needs Ubuntu 20.04+ or Debian 11+ on a 64-bit processor with systemd, 1 GB of memory, 3 GB of free disk and a correct clock." ;;
    basics) say "Couldn't install the basic tools. Check this server's internet connection and paste the line again." ;;
    user) say "Couldn't create the account your bots run under." ;;
    node) say "Couldn't install Node. Check this server's internet connection and paste the line again." ;;
    app) say "Couldn't install Metal. Paste the line again; it picks up where it stopped." ;;
    engines) say "Couldn't install the Claude and ChatGPT tools. Paste the line again; it picks up where it stopped." ;;
    service) if grep -q "^port $PORT here is taken" "$LOG" 2>/dev/null; then say "Another program has the port Metal needs ($PORT). Stop it, then paste the line again."; else say "The Metal server didn't start. The app shows the last lines of its log."; fi ;;
    address) say "Couldn't set up this server's address. Paste the line again." ;;
    desktop|sandbox|fence) say "Couldn't get the bot computer ready." ;;
    link) say "Couldn't link this server to your app. Make a new line in the app and paste it here." ;;
    *) say "Something went wrong. Paste the line again; it picks up where it stopped." ;;
  esac
}

step_title() {
  case "$1" in
    check) say "Checking your server" ;;
    basics) say "Getting the basics" ;;
    docker) say "Installing Docker" ;;
    user) say "Making a home for your bots" ;;
    node) say "Installing Node" ;;
    app) say "Installing Metal" ;;
    engines) say "Installing Claude and ChatGPT" ;;
    service) say "Starting Metal" ;;
    address) say "Setting up the connection" ;;
    sandbox) say "Sandboxing bot computers" ;;
    fence) say "Fencing their network" ;;
    desktop) say "Building the bot computer" ;;
    link) say "Pairing with your app" ;;
  esac
}

# the screen shows five phases, one line each: the running step is its sub-status, and the line becomes one check
# when the phase is done. the steps themselves stay in the logs (and in what the app sees).
PHASES="prepare runtime omb computer link"
phase_title() {
  case "$1" in
    prepare) say "Preparing your server" ;;
    runtime) say "Installing the runtime" ;;
    omb) say "Installing Metal" ;;
    computer) say "Setting up the bot computer" ;;
    link) say "Linking to your app" ;;
  esac
}
phases_after() { _seen=0; for _s in $PHASES; do [ "$_seen" = 1 ] && printf '%s ' "$_s"; [ "$_s" = "$1" ] && _seen=1; done; return 0; }

checklist() {
  [ "$UI" = tty ] || return 0
  # rows permitting (banner and all), the phases are drawn up front and each turns into a check in place;
  # otherwise they appear one by one
  [ "$ROWS" -ge 26 ] || return 0
  LIST=1
  for _s in $PHASES; do pending_line "$_s"; done
  printf '%s[%dA' "$ESC" 5
}

PH_ID="" PH_IDX=0 PH_NOTE="" PH_WARN=""
phase() { # id
  PH_ID=$1 PH_NOTE="" PH_WARN="" PH_T0=$(now_ms)
  TPAD=$(printf "%-${TW}s" "$(phase_title "$1")")
  [ "$UI" = tty ] || printf '  %-34s' "$(phase_title "$1")..."
}
phase_end() {
  took=$(fmt_ms $(($(now_ms) - PH_T0)))
  if [ "$UI" = tty ]; then
    if [ -n "$PH_WARN" ]; then glyph skip; draw "$WARN" "$G" "$took" "${WARN}${PH_WARN}${R}"
    else glyph ok; draw "$OK" "$G" "$took" "${DIM}${PH_NOTE}${R}"; fi
    printf '\n'
  else
    say "done ($took)${PH_WARN:+, $PH_WARN}${PH_NOTE:+, $PH_NOTE}"
  fi
  PH_IDX=$((PH_IDX + 1))
}

STEP_PID="" SOFT_FAILED=""
step() { # id function
  [ ! -f "$TMP/cancelled" ] || on_stop
  LOG="$LOGS/$1.log"
  title=$(step_title "$1")
  SUBTXT=$title SUB="${DIM}${title}${R}  "
  : > "$LOG"
  rm -f "$PROGRESS" "$PROGRESS.json" "$TMP/sub"
  STEP_ID=$1 SENT=0 CMD="" STEP_T0=$(now_ms) LAST_SIGNATURE="" LAST_POST=0
  LAST_ACTIVITY=$STEP_T0
  report "$1" running &
  rpid=$!
  set +e
  rm -f "$TMP/rc"
  # the step runs in the background and leaves its exit code in $TMP/rc; the spinner draws until it appears
  if [ -n "$DEMO" ]; then run=demo_work; else run=$2; fi
  ( trap '' HUP; ( set -e; "$run" "$1" ) </dev/null >>"$LOG" 2>&1; echo $? > "$TMP/rc" ) &
  STEP_PID=$!
  if [ "$UI" = tty ]; then watch_step; else
    while [ ! -f "$TMP/rc" ]; do [ ! -f "$TMP/cancelled" ] || on_stop; sleep 0.5; stream_lines; show_asks; done
  fi
  wait "$STEP_PID"
  show_asks
  [ ! -f "$TMP/cancelled" ] || on_stop
  code=$(cat "$TMP/rc" 2>/dev/null)
  # the bot computer is optional: any failure in its parts is a soft one
  case "$1" in sandbox|fence|desktop) case "$code" in 0|10) ;; *) code=11 ;; esac ;; esac
  STEP_PID=""
  wait "$rpid" 2>/dev/null
  stream_lines final
  [ ! -f "$TMP/cancelled" ] || on_stop
  set -e
  took=$(fmt_ms $(($(now_ms) - PH_T0)))
  _ww=$((COLS - TW - 16)); [ "$_ww" -ge 20 ] || _ww=20
  why=$(tail -n 1 "$LOG" 2>/dev/null | tr -cd '\40-\176' | cut -c1-"$_ww")
  case "$code" in
    0)
      report "$1" "done"; state_set "step-$1" "done"
      if [ "$1" = desktop ]; then
        case "$(state_get desktop)" in built) PH_NOTE="built here" ;; pulled) PH_NOTE="pulled" ;; *) PH_NOTE="ready" ;; esac
      fi ;;
    10)
      report "$1" skipped "$LOG"; state_set "step-$1" skipped
      # the first skip in a phase is worth a dim word on its line
      [ -n "$PH_NOTE" ] || PH_NOTE=$why ;;
    11)
      # optional part failed: say so in amber on the phase line, keep going (bots work without a bot computer)
      report "$1" skipped "$LOG"; state_set "step-$1" failed
      [ -n "$PH_WARN" ] || PH_WARN=$why
      SOFT_FAILED="$SOFT_FAILED $1" ;;
    *)
      if [ "$UI" = tty ]; then glyph fail; draw "$ERR" "$G" "$took" "${ERR}${title} failed${R}"; mascot 0; printf '\n'; else say "failed ($took)"; fi
      if [ "$LIST" = 1 ]; then for _s in $(phases_after "$PH_ID"); do pending_line "$_s"; done; fi
      failure_panel "$1"
      report "$1" failed "$LOG"
      exit 1 ;;
  esac
}

failure_panel() { # id
  glyph bar; _bar=$G
  printf '\n  %s%s%s couldn'"'"'t finish%s\n\n' "$ERR$BOLD" "$(step_title "$1")" "$R$ERR" "$R"
  tail -n 8 "$LOG" 2>/dev/null | tr -cd '\12\40-\176' | cut -c1-$((COLS - 8)) | while IFS= read -r line; do
    printf '    %s%s%s %s\n' "$SHADOW" "$_bar" "$R" "$line"
  done
  glyph arrow
  _hint=$(failure_words "$1" | fold -s -w $((COLS - 6)))
  _first=1
  printf '\n'
  printf '%s\n' "$_hint" | while IFS= read -r line; do
    if [ "$_first" = 1 ]; then printf '  %s%s%s %s\n' "$ACC" "$G" "$R" "$line"; _first=0; else printf '    %s\n' "$line"; fi
  done
  _shown=$LOG; [ -n "$DEMO" ] && _shown="$LOGS_SHOWN/$1.log"
  printf '    %sfull log: %s%s\n\n' "$DIM" "$_shown" "$R"
}

# ---------- steps ----------
do_check() {
  arch=$(dpkg --print-architecture 2>/dev/null || uname -m)
  case "$arch" in arm64|aarch64|amd64|x86_64) ;; *) echo "unsupported processor: $arch"; return 1 ;; esac
  [ -r /etc/os-release ] || { echo "no /etc/os-release"; return 1; }
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in ubuntu|debian) ;; *) echo "unsupported system: ${ID:-unknown}"; return 1 ;; esac
  major=${VERSION_ID%%.*}
  case "$ID" in
    ubuntu) [ "${major:-0}" -ge 20 ] 2>/dev/null || { echo "Ubuntu ${VERSION_ID:-unknown} is too old: Metal needs Ubuntu 20.04 or newer"; return 1; } ;;
    debian) [ "${major:-0}" -ge 11 ] 2>/dev/null || { echo "Debian ${VERSION_ID:-unknown} is too old: Metal needs Debian 11 or newer"; return 1; } ;;
  esac
  [ -d /run/systemd/system ] || { echo "systemd is not running"; return 1; }
  echo "memory: $(awk '/MemTotal/ { printf "%d MB", $2 / 1024 }' /proc/meminfo)"
  # npm installing the server and the engines is what needs the most; below this the kernel ends it part way
  mem_mb=$(awk '/^(MemTotal|SwapTotal):/ { kb += $2 } END { printf "%d", kb / 1024 }' /proc/meminfo)
  if [ "${mem_mb:-0}" -lt "${DUSK_MIN_MEMORY_MB:-900}" ]; then echo "needs at least 1 GB of memory (memory and swap together: ${mem_mb} MB)"; return 1; fi
  clock_check
  free_kb=$(df -Pk / | awk 'NR == 2 { print $4 }')
  echo "free disk: $((free_kb / 1024)) MB"
  if [ "$free_kb" -lt 3000000 ]; then echo "needs at least 3 GB of free disk"; return 1; fi
  echo "system: ${PRETTY_NAME:-$ID} ($arch)"
}

# the app refuses tunnel frames more than 5 minutes off its own clock (FRAME_SKEW_MS in agent.mjs), so a server whose
# clock drifted would link and then never answer
clock_skew() { # -> seconds this clock is ahead of the link service's (negative: behind), nothing when unknown
  _date=$(curl -sS --proto "$PROTO" --proto-redir "$PROTO" -m 10 -o /dev/null -D - "$LINK_BASE/v1/ip" 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: *//p' | head -n 1)
  [ -n "$_date" ] || return 0
  _theirs=$(date -u -d "$_date" +%s 2>/dev/null) || return 0
  echo $(($(date -u +%s) - _theirs))
}
clock_check() {
  skew=$(clock_skew)
  [ -n "$skew" ] || return 0
  [ "${skew#-}" -gt 30 ] || return 0
  echo "this server's clock is ${skew#-} seconds $( [ "$skew" -gt 0 ] && echo ahead || echo behind ); turning on time sync"
  x timedatectl set-ntp true 2>&1 || true
  _i=0
  while [ "$_i" -lt 30 ]; do
    sleep 3; _i=$((_i + 3))
    skew=$(clock_skew)
    [ -n "$skew" ] && [ "${skew#-}" -le 30 ] && { echo "clock synced"; return 0; }
  done
  [ -z "$skew" ] || [ "${skew#-}" -le 240 ] && return 0
  echo "this server's clock is still ${skew#-} seconds off, and the app refuses messages that far out; set the time (timedatectl set-ntp true, or your provider's time settings) and paste the line again"
  return 1
}

do_basics() {
  apt_install curl ca-certificates gnupg iproute2 procps tar xz-utils bubblewrap socat
  # the bot browser's live view goes as H.264 through this ffmpeg (server/browser/viewers/h264-encoder.ts); best effort:
  # without it the view stays JPEG, so it never fails the install
  apt_install ffmpeg || echo "ffmpeg could not be installed; the live browser view stays JPEG"
  bwrap_userns
}

# ubuntu 24.04 gives unprivileged user namespaces no capabilities (kernel.apparmor_restrict_unprivileged_userns=1), and
# the bot box is one: bubblewrap alone gets a profile that lets it make them
bwrap_userns() {
  [ -x /usr/bin/bwrap ] && [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1 || return 0
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] || return 0
  cat > "$TMP/new" <<'EOF'
# managed by duskbot-link: bubblewrap may make the user namespaces each bot's turn runs in
abi <abi/4.0>,
include <tunables/global>

profile duskbot-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/duskbot-bwrap>
}
EOF
  new_file /etc/apparmor.d/duskbot-bwrap
  install -d -m 0755 /etc/apparmor.d
  put_file /etc/apparmor.d/duskbot-bwrap 0644 || true
  x apparmor_parser -r /etc/apparmor.d/duskbot-bwrap
}

# what the server's box check does: a user namespace with its own pid, network and mounts, as maus
box_works() {
  as_user /usr/bin/bwrap --unshare-user --unshare-pid --unshare-net --unshare-ipc --unshare-uts --die-with-parent \
    --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
    --proc /proc --dev /dev --tmpfs /tmp /bin/true
}

do_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    apt_install docker.io || { echo "docker could not be installed; bots still work, the bot desktop will not"; return 10; }
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  if ! docker info >/dev/null 2>&1; then
    echo "docker is installed but not running here; bots still work, the bot desktop will not"
    return 10
  fi
  docker --version
}

do_user() {
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    manifest_add "user $SVC_USER"
    x useradd --create-home --home-dir "$SVC_HOME" --shell /bin/bash "$SVC_USER"
  fi
  # security: the docker group is root-equivalent and the server runs bots; it reaches docker only through the gate
  if id -nG "$SVC_USER" | tr ' ' '\n' | grep -qx docker; then x gpasswd -d "$SVC_USER" docker; fi
  if ! getent group "$GATE_GROUP" >/dev/null 2>&1; then manifest_add "group $GATE_GROUP"; x groupadd --system "$GATE_GROUP"; fi
  usermod -aG "$GATE_GROUP" "$SVC_USER"
  if ! id "$GATE_USER" >/dev/null 2>&1; then
    manifest_add "user $GATE_USER"
    x useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --gid "$GATE_GROUP" "$GATE_USER"
  fi
  if getent group docker >/dev/null 2>&1; then usermod -aG docker "$GATE_USER"; fi
  if ! id "$LINK_USER" >/dev/null 2>&1; then
    manifest_add "user $LINK_USER"
    # a shell, so sshd can run the forced command on the app's restricted key
    x useradd --system --create-home --home-dir "$LINK_HOME" --shell /bin/sh "$LINK_USER"
  fi
  # useradd leaves the password "!" (locked), and sshd without PAM refuses every key for a locked account; "*" still
  # allows no password but lets the app's restricted direct key in (OpenSSH auth.c allowed_user)
  if [ "$(getent shadow "$LINK_USER" | cut -d: -f2)" = "!" ]; then usermod -p '*' "$LINK_USER"; fi
  for dir in "$LINK_HOME" "$LINK_HOME/.config" "$LINK_HOME/.config/duskbot-link" "$LINK_HOME/.ssh" "$HANDOFF"; do
    install -d -o "$LINK_USER" -g "$LINK_USER" -m 0700 "$dir"
  done
  install -d -o root -g root -m 0700 "$ETC"
  chmod 0700 "$SVC_HOME"
  for dir in "$SVC_HOME/.local" "$SVC_HOME/.cache" "$SVC_HOME/.config"; do
    install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 "$dir"
  done
  [ ! -d "$DATA" ] || chmod 0700 "$DATA"
  move_link_files
  move_engine_token
  seed_engine_home
  id "$SVC_USER"; id "$LINK_USER"; id "$GATE_USER"
}

# an older install kept the link agent's files in the server account's home; they move to omb-link, read as that
# account so no link in its home can point root at another file
move_link_files() {
  old="$SVC_HOME/.config/$OLD-link"
  new="$LINK_HOME/.config/duskbot-link/tunnel.json"
  if [ -f "$old/tunnel.json" ] && [ ! -f "$new" ]; then
    show mv "$old/tunnel.json" "$new"
    as_user cat "$old/tunnel.json" | runuser -u "$LINK_USER" -- sh -c 'umask 077; cat > "$1.tmp" && mv -f "$1.tmp" "$1"' sh "$new"
    [ -s "$new" ] || { echo "tunnel.json did not move"; return 1; }
  fi
  [ ! -d "$old" ] || as_user rm -rf "$old"
  keys="$SVC_HOME/.ssh/authorized_keys"
  if [ -f "$keys" ] && grep -q ' omb-link-[a-z2-7]\{10\}$' "$keys"; then
    # the app asks the agent for a new key over the sealed tunnel once this one is refused, and gets omb-link's
    as_user sh -c 'umask 077; grep -v " omb-link-[a-z2-7]\{10\}\$" "$1" > "$1.omb" || true; mv -f "$1.omb" "$1"' sh "$keys"
    [ -s "$keys" ] || as_user rm -f "$keys"
    echo "the app's direct key left $SVC_USER; it gets a new one for $LINK_USER"
  fi
}

# the engine token an older install kept in the server account's home goes to $ETC/engines.env, which only systemd reads
move_engine_token() {
  old="$SVC_HOME/.config/$OLD/engines.env"
  [ -f "$old" ] || return 0
  as_user cat "$old" | grep -E "$CLAUDE_TOKEN_LINE" | awk "length <= 4200" | tail -n 1 > "$TMP/engines.env" || true
  if [ -s "$TMP/engines.env" ]; then install -o root -g root -m 0600 "$TMP/engines.env" "$ETC/engines.env"; echo "the Claude sign-in moved to $ETC/engines.env"; fi
  rm -f "$TMP/engines.env"
  as_user rm -f "$old"
  as_user rmdir "$SVC_HOME/.config/$OLD" 2>/dev/null || true
}

# the bot box gives engines their own home in the data folder; conversations from before keep their engine sessions
seed_engine_home() {
  [ -d "$DATA" ] && [ ! -d "$DATA/engine-home" ] || return 0
  show "copy engine sessions into $DATA/engine-home"
  as_user sh -c 'set -e; umask 077; e="$1/engine-home.tmp"; rm -rf "$e"; mkdir -p "$e/.codex" "$e/.claude"
    for d in sessions archived_sessions; do [ ! -d "$2/.codex/$d" ] || cp -a "$2/.codex/$d" "$e/.codex/"; done
    for d in projects todos file-history; do [ ! -d "$2/.claude/$d" ] || cp -a "$2/.claude/$d" "$e/.claude/"; done
    [ ! -f "$2/.claude.json" ] || cp -p "$2/.claude.json" "$e/.claude.json"
    mv "$e" "$1/engine-home"' sh "$DATA" "$SVC_HOME"
}

# a server set up before the rename: its units stop and go, and its folders, link key, profiles and caddy site move to
# the new names. nothing is deleted but the old unit files and profile this script wrote; the old data folder and
# agent folder names stay as links to the new ones. safe to run again.
migrate_legacy() {
  found=0
  for unit in $OLD_UNITS; do [ -e "$UNITS/$unit" ] && found=1; done
  for dir in "$OLD_STATE" "$OLD_AGENT_DIR" "$OLD_ETC" "$SVC_HOME/.$OLD"; do [ -e "$dir" ] && [ ! -L "$dir" ] && found=1; done
  [ "$found" = 1 ] || return 0
  echo "moving an install from before the rename to the new names"
  for unit in $OLD_UNITS; do
    [ -e "$UNITS/$unit" ] || continue
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "$UNITS/$unit" && echo "removed $UNITS/$unit"
  done
  rm -f "$UNITS/ssh.service.d/10-$OLD-oom.conf" "$UNITS/sshd.service.d/10-$OLD-oom.conf"
  systemctl daemon-reload >/dev/null 2>&1 || true
  move_old "$OLD_STATE" "$STATE"
  move_old "$OLD_LOGS" "$LOGS"
  move_old "${OLD_MANIFEST%/*}" "${MANIFEST%/*}"
  move_old "$OLD_AGENT_DIR" "${AGENT%/*}" link
  move_old "$OLD_LIB" "$LIB"
  move_old "$OLD_ETC" "$ETC"
  move_old "$LINK_HOME/.config/$OLD-link" "$LINK_HOME/.config/duskbot-link"
  move_old "$SVC_HOME/.$OLD" "$DATA" link
  [ ! -L "$SVC_HOME/.$OLD" ] || chown -h "$SVC_USER:$SVC_USER" "$SVC_HOME/.$OLD" 2>/dev/null || true
  keys="$LINK_HOME/.ssh/authorized_keys"
  if [ -f "$keys" ] && grep -q "$OLD_AGENT_DIR/" "$keys"; then sed -i "s#$OLD_AGENT_DIR/#${AGENT%/*}/#g" "$keys" && echo "the app's direct key runs the agent at ${AGENT%/*}"; fi
  if [ -f "$OLD_BWRAP_PROFILE" ]; then
    apparmor_parser -R "$OLD_BWRAP_PROFILE" >/dev/null 2>&1 || true
    rm -f "$OLD_BWRAP_PROFILE" && echo "removed $OLD_BWRAP_PROFILE"
  fi
  if [ -f "$OLD_CADDY_SITE" ]; then
    [ -e "$CADDY_SITE" ] || mv "$OLD_CADDY_SITE" "$CADDY_SITE"
    rm -f "$OLD_CADDY_SITE"
    [ ! -f "$CADDY_MAIN" ] || sed -i "s#managed by $OLD-link#managed by duskbot-link#; s#$OLD_CADDY_SITE#$CADDY_SITE#" "$CADDY_MAIN"
  fi
  [ ! -f "$MANIFEST" ] || sed -i "s#$OLD#duskbot#g" "$MANIFEST"
  return 0
}

# old new [link]: a folder moves once, never over one already there; with `link` the old name points at the new one
move_old() {
  [ -e "$1" ] && [ ! -L "$1" ] || return 0
  if [ -e "$2" ]; then echo "kept $1: $2 is already there"; return 0; fi
  install -d -m 0755 "${2%/*}"
  mv "$1" "$2" || return 1
  echo "moved $1 -> $2"
  [ "${3:-}" != link ] || ln -s "$2" "$1"
}

node_major() { /usr/bin/node -v 2>/dev/null | sed -e 's/^v//' -e 's/\..*//'; }
do_node() {
  major=$(node_major)
  if [ -n "$major" ] && [ "$major" -ge 24 ]; then node_version_line; return 0; fi
  install -d -m 0755 /etc/apt/keyrings
  fetch https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "$TMP/nodesource.key"
  new_file /etc/apt/keyrings/nodesource.gpg; new_file /etc/apt/sources.list.d/nodesource.list
  x gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg "$TMP/nodesource.key"
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  rm -f "$TMP/apt-updated"
  apt_update
  apt_get_install nodejs
  major=$(node_major)
  [ -n "$major" ] && [ "$major" -ge 24 ] || { echo "node 24 did not install"; return 1; }
  node_version_line
}
node_version_line() { echo "node $(/usr/bin/node -v), npm $(/usr/bin/npm -v 2>/dev/null || echo none)"; }

# our own server build, which the link service hands only to this claimed session; the sha256 comes with the claim
PKG_SHA="" PKG_SIZE=0 PKG_VERSION=""
verified_download() { # url file sha256 size timeout label
  _url=$1 _file=$2 _sha=$3 _total=$4 _limit=$5 _label=$6
  _part="$_file.part"
  if [ -f "$_file" ] && [ "$(sha256sum "$_file" | cut -d' ' -f1)" = "$_sha" ]; then
    echo "using verified cached $_label"
    return 0
  fi
  rm -f "$_file"
  _attempt=1
  # shellcheck disable=SC2086
  set -- $RETRY_WAITS
  while [ "$_attempt" -le 5 ]; do
    [ ! -f "$TMP/cancelled" ] || return 130
    if [ -f "$_part" ]; then
      if [ "$(sha256sum "$_part" | cut -d' ' -f1)" = "$_sha" ]; then mv "$_part" "$_file"; return 0; fi
      _size=$(wc -c < "$_part" | tr -cd 0-9)
      if [ "$_total" -gt 0 ] && [ "$_size" -ge "$_total" ]; then echo "discarding incomplete or damaged cached $_label"; rm -f "$_part"; fi
    fi
    progress file "$_part" "$_total"
    _offset=0; [ ! -f "$_part" ] || _offset=$(wc -c < "$_part" | tr -cd 0-9)
    echo "downloading $_label: attempt $_attempt/5, resuming at $_offset bytes$(! ipv4_only || echo ', over ipv4')"
    show curl -fsSL --connect-timeout 15 --speed-limit 1 --speed-time 60 -m "$_limit" -C - "$_url" -o "$_part"
    if ncurl -fsSL --proto "$PROTO" --proto-redir "$PROTO" --connect-timeout 15 --speed-limit 1 --speed-time 60 -m "$_limit" -C - -H "authorization: Bearer $VPS_TOKEN" "$_url" -o "$_part"; then
      if [ "$(sha256sum "$_part" | cut -d' ' -f1)" = "$_sha" ]; then
        mv "$_part" "$_file"
        rm -f "$PROGRESS" "$PROGRESS.json"
        echo "sha256 verified: $_label"
        return 0
      fi
      echo "$_label checksum did not match; the next attempt starts fresh"
      rm -f "$_part"
    else
      _code=$?
      echo "$_label download attempt $_attempt/5 failed (curl $_code); received bytes remain cached"
      case "$_code" in 33|36) rm -f "$_part" ;; esac
      ! net_error "$_code" || flip_family
    fi
    [ "$_attempt" -lt 5 ] || break
    echo "retrying $_label in $1 seconds"
    sleep "$1"
    shift
    _attempt=$((_attempt + 1))
  done
  rm -f "$PROGRESS" "$PROGRESS.json"
  echo "$_label could not be downloaded and verified after 5 attempts; paste the command again to resume"
  return 1
}

# updates that can't break a server (shared/update-guard.ts): a build is taken only when it is signed by a pinned release
# key (required once this server has taken one signed build), newer than the one here, at or above the signed floor and
# not on the signed block list; the build it replaces stays cached, and if the new one does not answer or fails its own
# self-test (server/update-state.ts) the one before is put back. the keys match apps/cloud-service/src/release-signing.ts.
RELEASE_KEYS="rel-2026-11:wtwZypDwVPBXZ25XsZOVpd0PZPBbVMhugheUj5_NLIM${DUSK_RELEASE_PUBLIC_KEYS:+,$DUSK_RELEASE_PUBLIC_KEYS}"
NODE_BIN=${NODE_BIN:-/usr/bin/node}
PKG_SIG="" POLICY_BODY="" POLICY_SIG=""
update_check() { # file sha256 -> "ok <version> signed|unsigned" or "refuse <reason> [version]"
  cat > "$TMP/update-check.js" <<'DUSK_CHECK'
const c = require("node:crypto"), fs = require("node:fs"), e = process.env, SEM = /^\d+\.\d+\.\d+$/;
const keys = (e.KEYS || "").split(",").map((s) => s.trim().split(":")).filter(([kid, x]) => kid && x).map(([kid, x]) => ({ kid, x }));
const cmp = (a, b) => { const p = (v) => (SEM.test(v || "") ? v.split(".").map(Number) : null), l = p(a), r = p(b); if (!l || !r) return l ? 1 : r ? -1 : 0; for (let i = 0; i < 3; i++) if (l[i] !== r[i]) return l[i] < r[i] ? -1 : 1; return 0; };
const out = (line) => { process.stdout.write(line + "\n"); process.exit(0); };
function verify(sig, kind, sha) {
  const p = String(sig || "").trim().split(".");
  if (p.length !== 4 || p[0] !== "r1") return null;
  const k = keys.find((x) => x.kid === p[1]);
  if (!k) return null;
  try {
    const pub = c.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
    if (!c.verify(null, Buffer.from(p.slice(0, 3).join(".")), pub, Buffer.from(p[3], "base64url"))) return null;
    const m = JSON.parse(Buffer.from(p[2], "base64url").toString());
    return m.v === 1 && m.kind === kind && m.sha256 === sha ? m : null;
  } catch { return null; }
}
let held = { serial: 0, floor: null, blocked: [] };
try { held = JSON.parse(fs.readFileSync(e.HELD_POLICY, "utf8")); } catch {}
if (e.POLICY_BODY && e.POLICY_SIG) {
  try {
    const body = Buffer.from(e.POLICY_BODY, "base64url").toString("utf8"), p = JSON.parse(body);
    const m = verify(e.POLICY_SIG, "update-policy", c.createHash("sha256").update(body).digest("hex"));
    if (m && m.name === "update-policy" && Number.isSafeInteger(p.serial) && m.version === String(p.serial) && p.serial > (held.serial || 0)
      && (p.floor === null || SEM.test(p.floor)) && Array.isArray(p.blocked) && p.blocked.every((v) => SEM.test(v))) {
      held = { serial: p.serial, floor: p.floor, blocked: p.blocked };
      fs.writeFileSync(e.HELD_POLICY, JSON.stringify(held), { mode: 0o600 });
    }
  } catch {}
}
let version = null;
if (e.SIG) { const m = verify(e.SIG, "vps-package", e.SHA); if (!m || !SEM.test(m.version)) out("refuse unsigned"); version = m.version; }
else { if (e.SIGNED_BEFORE === "1") out("refuse unsigned"); version = SEM.test(e.OFFER_VERSION || "") ? e.OFFER_VERSION : null; }
if (version) {
  if ((held.blocked || []).includes(version)) out("refuse blocked " + version);
  if (held.floor && cmp(version, held.floor) < 0) out("refuse below_floor " + version);
  if ((e.FAILED || "").split(",").includes(version)) out("refuse failed_here " + version);
  // an installed build that never got going here is no floor: the one before it may come back
  if (e.INSTALLED && cmp(version, e.INSTALLED) < 0 && !(e.FAILED || "").split(",").includes(e.INSTALLED)) out("refuse older " + version);
}
out("ok " + (version || "unknown") + " " + (e.SIG ? "signed" : "unsigned"));
DUSK_CHECK
  KEYS="$RELEASE_KEYS" SHA="$2" SIG="$PKG_SIG" OFFER_VERSION="${PKG_VERSION:-}" POLICY_BODY="$POLICY_BODY" POLICY_SIG="$POLICY_SIG" \
    HELD_POLICY="$STATE/update-policy.json" INSTALLED="$(installed_version)" FAILED="$(state_get update-failed)" SIGNED_BEFORE="$([ "${REQUIRE_SIGNED:-}" = 1 ] && echo 1 || state_get signed)" \
    "$NODE_BIN" "$TMP/update-check.js" || echo "refuse check"
}
# files in the server account's home are read as that account, never by root through a path it could point anywhere
installed_version() { as_user head -c 65536 "$SVC_HOME/.local/lib/node_modules/duskbot/package.json" 2>/dev/null | sed -n 's/^ *"version": *"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' | head -n 1; }
# the server's own self-test on <version> (server/update-state.ts): passed, failed, or nothing yet
selftest_result() {
  as_user head -c 1048576 "$DATA/update-state.json" 2>/dev/null | "$NODE_BIN" -e 'try { const s = JSON.parse(require("node:fs").readFileSync(0, "utf8")).selfTest; if (s && s.version === process.argv[1]) console.log(s.ok ? "passed" : "failed"); } catch {}' "$1" 2>/dev/null || true
}
# after the server restarted on a new build: settles it, or puts the build before back. $1: 1 when the server answered
update_settle() {
  pending=$(state_get update-pending)
  [ -n "$pending" ] || return "$((1 - $1))"
  ok=$1
  if [ "$ok" = 1 ] && [ "$pending" != unknown ]; then
    _i=0 result=""
    while [ "$_i" -lt "${SELFTEST_WAIT:-180}" ]; do
      result=$(selftest_result "$pending")
      [ -z "$result" ] || break
      sleep 2; _i=$((_i + 2))
    done
    [ "$result" = passed ] || ok=0
  fi
  if [ "$ok" = 1 ]; then state_set update-pending ""; echo "Updated to $pending"; return 0; fi
  prev=$(state_get package-prev)
  file="$PKGS/duskbot-${prev#sha256:}.tgz"
  case "$prev" in sha256:*) root_copy "${prev#sha256:}" || prev="" ;; *) prev="" ;; esac
  note_failed "$pending"
  if [ -z "$prev" ]; then state_set update-pending ""; echo "the update to $pending did not pass its self-test and there is no build here to go back to"; return 1; fi
  echo "the update to $pending did not pass its self-test: going back to the build before"
  # update-pending stays until the build before is back, so a stop here rolls back again on the next run
  install_build "$prev" "$file" || return 1
  state_set package-prev ""; state_set update-pending ""
  x systemctl restart duskbot.service
  if wait_health "http://127.0.0.1:$PORT/api/health" 120; then echo "Update rolled back, nothing lost"; return 0; fi
  return 1
}

note_failed() { # version
  case "$1" in ''|unknown) return 0 ;; esac
  failed=$(state_get update-failed)
  case ",$failed," in *",$1,"*) ;; *) state_set update-failed "$(printf '%s\n' ${failed:+$(printf '%s' "$failed" | tr ',' ' ')} "$1" | tail -n 20 | paste -sd, -)" ;; esac
}

get_package() { # file
  verified_download "$LINK_BASE/pkg/$LINK_ID/$PKG_SHA.tgz" "$1" "$PKG_SHA" "$PKG_SIZE" 1800 "Metal"
}
# the wrapper switches to the server account before it runs anything from that account's home, so root never executes
# a file the server account can write
put_command() {
  _run="env HOME=$SVC_HOME PATH=$SVC_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin $SVC_HOME/.local/bin/duskbot"
  cat > "$TMP/cli" <<EOF
#!/bin/sh
# managed by duskbot-link: Metal running as $SVC_USER
if [ "\$(id -un)" = $SVC_USER ]; then exec $_run "\$@"; fi
if [ "\$(id -u)" -eq 0 ]; then exec runuser -u $SVC_USER -- $_run "\$@"; fi
exec sudo -u $SVC_USER -- $_run "\$@"
EOF
  for _cli in "$CLI" "${CLI%/*}/metal"; do
    if [ -L "$_cli" ] || { [ -e "$_cli" ] && ! grep -qs "managed by duskbot-link" "$_cli"; }; then
      echo "left $_cli as it is: it is not ours"
      continue
    fi
    if [ -f "$_cli" ] && cmp -s "$TMP/cli" "$_cli"; then continue; fi
    install -o root -g root -m 0755 "$TMP/cli" "$_cli" || return 1
    echo "${_cli##*/} now runs from any login on this server"
  done
}

do_app() {
  bin="$SVC_HOME/.local/bin/duskbot"
  if [ -n "$DUSK_PACKAGE" ]; then
    # explicit only: an npm spec or tarball url instead of our build
    if [ -x "$bin" ] && [ "$(state_get package)" = "npm:$DUSK_PACKAGE" ]; then echo "already installed: $DUSK_PACKAGE"; return 0; fi
    retry as_user npm install --global --no-fund --no-audit --prefix "$SVC_HOME/.local" "$DUSK_PACKAGE"
    [ -x "$bin" ] || { echo "duskbot is missing after install"; return 1; }
    state_set package "npm:$DUSK_PACKAGE"
    return 0
  fi
  half=$(state_get app-installing)
  if [ -n "$half" ] && [ "$half" != "sha256:$PKG_SHA" ]; then
    if finish_interrupted; then :; else [ $? -eq 2 ] && [ -n "$PKG_SHA" ] || return 1; fi
  fi
  if [ -z "$PKG_SHA" ]; then
    if [ -x "$bin" ] && [ "$OFFLINE" = 1 ]; then echo "keeping the installed build ($(state_get package))"; return 0; fi
    echo "the link service has no Metal build to hand out yet"
    return 1
  fi
  if [ -x "$bin" ] && [ "$(state_get package)" = "sha256:$PKG_SHA" ] && [ -z "$(state_get app-installing)" ]; then echo "already installed: build ${PKG_SHA%"${PKG_SHA#????????????}"}"; return 0; fi
  [ -d "$PKGS" ] && [ ! -L "$PKGS" ] || install -d -o root -g root -m 0700 "$PKGS"
  file="$PKGS/duskbot-$PKG_SHA.tgz"
  get_package "$file"
  verdict=$(update_check "$file" "$PKG_SHA")
  case "$verdict" in
    ok\ *) ;;
    *)
      [ "sha256:$PKG_SHA" = "$(state_get package-prev)" ] || rm -f "$file"
      if [ -x "$bin" ]; then echo "keeping the installed build: the offered one is not taken (${verdict#refuse })"; return 0; fi
      echo "the offered build is not taken (${verdict#refuse })"; return 1 ;;
  esac
  prev=$(state_get package)
  # the build before stays in root's folder: it is what a failed update goes back to
  case "$prev" in sha256:*) root_copy "${prev#sha256:}" || true ;; esac
  find "$PKGS" -maxdepth 1 -type f -name 'duskbot-*.tgz*' ! -name "duskbot-$PKG_SHA.tgz" ! -name "duskbot-$PKG_SHA.tgz.part" ! -name "duskbot-${prev#sha256:}.tgz" -exec rm -f {} + 2>/dev/null || true
  # noted before npm touches anything: a run stopped part way still settles or rolls back this update next time
  if [ -n "$prev" ] && [ "$prev" != "sha256:$PKG_SHA" ]; then
    state_set package-prev "$prev"; state_set update-pending "$(printf '%s' "$verdict" | cut -d' ' -f2)"
  fi
  case "$verdict" in *" signed") state_set signed 1 ;; esac
  install_build "sha256:$PKG_SHA" "$file"
}

# npm replaces the installed files in place, so a stop part way leaves a mix: app-installing says which build was going
# in, and the next run (a repair without a line too) finishes it from the verified download
install_build() { # sha256:<hex> root's verified file
  state_set app-installing "$1"
  _theirs=$(hand_over "$2") || { echo "could not hand the build to $SVC_USER"; return 1; }
  retry as_user npm install --global --no-fund --no-audit --prefix "$SVC_HOME/.local" "$_theirs" || return 1
  [ -x "$SVC_HOME/.local/bin/duskbot" ] || { echo "duskbot is missing after install"; return 1; }
  state_set package "$1"
  state_set app-installing ""
}
# root's verified copy of a build hands npm a copy the server account writes itself, into its own cache: root only reads
# its own file and the account's write lands wherever the account may write anyway. prints that copy's path
hand_over() { # root's file
  _dest="$SVC_HOME/.cache/duskbot-link/${1##*/}"
  as_user sh -c 'cd / && umask 077; mkdir -p "$1" && find "$1" -maxdepth 1 -name "duskbot-*.tgz*" ! -name "${2##*/}" -exec rm -f {} + && cat > "$2.tmp" && mv -f "$2.tmp" "$2"' sh "${_dest%/*}" "$_dest" < "$1" || return 1
  echo "$_dest"
}
# root's own verified copy of build <sha256> in $PKGS; one only in the server account's cache (an install from before
# $PKGS) is read as that account and kept only when it matches
root_copy() { # sha256
  _f="$PKGS/duskbot-$1.tgz"
  [ -f "$_f" ] && [ ! -L "$_f" ] && [ "$(sha256sum "$_f" | cut -d' ' -f1)" = "$1" ] && return 0
  [ -d "$PKGS" ] && [ ! -L "$PKGS" ] || install -d -o root -g root -m 0700 "$PKGS"
  as_user cat "$SVC_HOME/.cache/duskbot-link/duskbot-$1.tgz" > "$_f.tmp" 2>/dev/null || { rm -f "$_f.tmp"; return 1; }
  [ "$(sha256sum "$_f.tmp" | cut -d' ' -f1)" = "$1" ] || { rm -f "$_f.tmp"; return 1; }
  mv -f "$_f.tmp" "$_f"
}
finish_interrupted() {
  half=$(state_get app-installing)
  [ -n "$half" ] || return 1
  file="$PKGS/duskbot-${half#sha256:}.tgz"
  if root_copy "${half#sha256:}"; then
    echo "finishing the install of build ${half#sha256:} that stopped part way"
    install_build "$half" "$file"
    return
  fi
  echo "the install of build ${half#sha256:} stopped part way and its download is gone; make a new line in the app and paste it here"
  return 2
}

do_engines() {
  missing=""
  [ -x "$SVC_HOME/.local/bin/claude" ] || missing="$missing @anthropic-ai/claude-code"
  [ -x "$SVC_HOME/.local/bin/codex" ] || missing="$missing @openai/codex"
  if [ -n "$missing" ]; then
    # shellcheck disable=SC2086
    retry as_user npm install --global --no-fund --no-audit --prefix "$SVC_HOME/.local" $missing || return 1
  else
    echo "already installed"
  fi
  do_free_backup
}
# opencode's pinned build, the free backup ai, so the first message never waits on its download. not fatal: the server
# tries again at every start (DUSK_PREINSTALL_FREE_BACKUP in its unit). one bounded try with no terminal: published builds
# probe an interactive login shell for PATH, which finds the installer's terminal, stops its own process group
# (SIGTTIN) and the command with it, forever
FREE_BACKUP_SECS=300
do_free_backup() {
  sub_label "Installing the free backup AI"
  echo "installing the free backup ai (OpenCode), up to $((FREE_BACKUP_SECS / 60)) minutes"
  set -- "$SVC_HOME/.local/bin/duskbot" free-backup install
  if command -v timeout >/dev/null 2>&1; then set -- timeout -k 15 "$FREE_BACKUP_SECS" "$@"; fi
  if command -v setsid >/dev/null 2>&1; then set -- setsid -w "$@"; fi
  show "$@"
  if as_user "$@"; then return 0; else _fb=$?; fi
  case "$_fb" in
    124|137) echo "the free backup ai took longer than $((FREE_BACKUP_SECS / 60)) minutes; skipped for now, the server installs it when it starts" ;;
    *) echo "the free backup ai is not installed yet (exit $_fb); skipped for now, the server installs it when it starts" ;;
  esac
  return 0
}

# writes a file only when it changed; returns 0 when it wrote
put_file() { # path mode
  if [ -f "$1" ] && cmp -s "$TMP/new" "$1"; then return 1; fi
  install -m "$2" "$TMP/new" "$1"
  return 0
}

# what every unit here gets: no new privileges, no capabilities, the system read-only, a private /tmp. the server's unit
# leaves /proc and /dev as they are (ProtectKernelTunables, ProtectKernelLogs, ProcSubset, PrivateDevices): bubblewrap
# mounts a new proc and dev for each bot box, which a partly covered /proc or a private /dev refuses (systemd 255,
# linux 6.8, and lxc hosts). RestrictSUIDSGID goes only on the helper units: its seccomp filter also turns the new mount
# api bubblewrap 0.12 uses (debian 13) into ENOSYS, so every bot box failed there with userns-refused
HARDENING="NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
PrivateTmp=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectProc=invisible
LockPersonality=yes
RestrictRealtime=yes
KeyringMode=private
SystemCallArchitectures=native"

server_unit() {
  public=""
  # a quick tunnel's name changes on every restart, so the server names no public address for it
  [ "$(state_get mode)" = "direct" ] && [ -n "$(state_get host)" ] && { [ "$(state_get via)" != cloudflare ] || [ -n "$(state_get cf-named)" ]; } \
    && public=" --public-url https://$(state_get host)"
  cat > "$TMP/new" <<EOF
# managed by duskbot-link
[Unit]
Description=Server for Metal
After=network-online.target omb-docker-gate.service
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
SupplementaryGroups=$GATE_GROUP
WorkingDirectory=$SVC_HOME
Environment=HOME=$SVC_HOME
Environment=PATH=$SVC_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
# every bot's turn in the bot box, in its own engine home, never unboxed; docker only through the gate
Environment=DUSK_BOT_BOX=required
Environment=DUSK_BOX_CODE_ROOTS=$SVC_HOME/.local/bin:$SVC_HOME/.local/lib
Environment=DUSK_VPS_DOCKER=local
Environment=DOCKER_HOST=unix://$GATE_SOCK
Environment=DUSK_PREINSTALL_FREE_BACKUP=1
EnvironmentFile=-$ETC/engines.env
ExecStart=$SVC_HOME/.local/bin/duskbot serve --port $PORT --no-pair --label $NAME$public
# the link stops when the server is stopped, but stays up through a restart (an update, an engine sign-in) and a crash,
# so the app's tunnel and the phones' links never drop: systemd propagates restarts along PartOf= and PropagatesStopTo=
# alike, and only a running stop job shows as "stop" in list-jobs
ExecStopPost=+/bin/sh -c 'systemctl list-jobs --no-legend duskbot.service 2>/dev/null | grep -qw stop && systemctl stop --no-block duskbot-link.service || true'
Restart=always
RestartSec=5
# when memory runs out the kernel takes a bot computer (docker --oom-score-adj 500) long before the server
OOMScoreAdjust=-800
UMask=0077
$HARDENING
ProtectHome=tmpfs
BindPaths=$SVC_HOME
ReadWritePaths=$SVC_HOME
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
EOF
  put_file "$UNITS/duskbot.service" 0644
}

handoff_script() {
  cat > "$TMP/new" <<EOF
#!/bin/sh
# managed by duskbot-link: takes what the link agent was handed for the server's engines to the server. the files
# are read as $LINK_USER and the codex sign-in written as $SVC_USER, so neither account can point root at another file.
set -eu
umask 077
restart=0
if [ -e $HANDOFF/engines.env ]; then
  runuser -u $LINK_USER -- cat $HANDOFF/engines.env | grep -E '$CLAUDE_TOKEN_LINE' | awk 'length <= 4200' | tail -n 1 > $ETC/engines.env.new || true
  if [ -s $ETC/engines.env.new ]; then mv -f $ETC/engines.env.new $ETC/engines.env; restart=1; else rm -f $ETC/engines.env.new; fi
  runuser -u $LINK_USER -- rm -f $HANDOFF/engines.env
fi
if [ -e $HANDOFF/codex-auth.json ]; then
  runuser -u $LINK_USER -- head -c 65536 $HANDOFF/codex-auth.json | runuser -u $SVC_USER -- sh -c 'umask 077; mkdir -p $SVC_HOME/.codex; cat > $SVC_HOME/.codex/.auth.json.handoff && mv -f $SVC_HOME/.codex/.auth.json.handoff $SVC_HOME/.codex/auth.json'
  runuser -u $LINK_USER -- rm -f $HANDOFF/codex-auth.json
fi
[ "\$restart" = 0 ] || systemctl restart duskbot.service
EOF
  install -d -m 0755 "$LIB"
  put_file "$LIB/engine-handoff.sh" 0755
}

helper_units() {
  changed=1
  cat > "$TMP/new" <<EOF
# managed by duskbot-link: the app sent an engine sign-in; the hand-off takes it to the server
[Unit]
Description=Engine sign-in handed off to Metal

[Path]
PathExists=$HANDOFF/engines.env
PathExists=$HANDOFF/codex-auth.json
Unit=duskbot-handoff.service

[Install]
WantedBy=multi-user.target
EOF
  put_file "$UNITS/duskbot-engines.path" 0644 && changed=0
  cat > "$TMP/new" <<EOF
# managed by duskbot-link
[Unit]
Description=Hand an engine sign-in to Metal

[Service]
Type=oneshot
ExecStart=/bin/sh $LIB/engine-handoff.sh
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
EOF
  put_file "$UNITS/duskbot-handoff.service" 0644 && changed=0
  if [ -f "$UNITS/duskbot-restart.service" ]; then rm -f "$UNITS/duskbot-restart.service"; changed=0; fi
  cat > "$TMP/new" <<EOF
# managed by duskbot-link: the outbound tunnel and control channel to the app
[Unit]
Description=Link for Metal
After=network-online.target duskbot.service
Wants=network-online.target

[Service]
User=$LINK_USER
Group=$LINK_USER
Environment=HOME=$LINK_HOME
Environment=DUSK_LINK_ENGINES_FILE=$HANDOFF/engines.env
Environment=DUSK_LINK_CODEX_AUTH_FILE=$HANDOFF/codex-auth.json
ExecStart=/usr/bin/node $AGENT tunnel
Restart=always
RestartSec=5
OOMScoreAdjust=-700
UMask=0077
$HARDENING
RestrictSUIDSGID=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectHome=yes
ProtectHostname=yes
RestrictNamespaces=yes
ReadWritePaths=$LINK_HOME
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target duskbot.service
EOF
  put_file "$UNITS/duskbot-link.service" 0644 && changed=0
  cat > "$TMP/new" <<EOF
# managed by duskbot-link: the only way to docker on this server, for the server's own labelled bot computers
[Unit]
Description=Docker gate for Metal
After=docker.service
Requires=docker.service
StartLimitIntervalSec=0

[Service]
User=$GATE_USER
Group=$GATE_GROUP
SupplementaryGroups=docker
RuntimeDirectory=duskbot-docker
RuntimeDirectoryMode=0750
ExecStart=/usr/bin/node $GATE --listen $GATE_SOCK --upstream /var/run/docker.sock
Restart=always
RestartSec=2
UMask=0007
$HARDENING
RestrictSUIDSGID=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectHome=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any

[Install]
WantedBy=multi-user.target docker.service
EOF
  put_file "$UNITS/omb-docker-gate.service" 0644 && changed=0
  cat > "$TMP/new" <<EOF
# managed by duskbot-link: installs a server build the link agent staged, only while no bot is working, and puts the
# build before back when the new one does not answer or fails its self-test
[Unit]
Description=Server update for Metal
After=duskbot.service

[Service]
Type=oneshot
ExecStart=/bin/sh $UPDATER --update-server
StandardOutput=append:$LOGS/server-update.log
StandardError=inherit
EOF
  put_file "$UNITS/duskbot-server-update.service" 0644 && changed=0
  cat > "$TMP/new" <<EOF
# managed by duskbot-link
[Unit]
Description=Look for a staged Metal server build

[Timer]
OnBootSec=15min
OnUnitInactiveSec=15min
RandomizedDelaySec=3min

[Install]
WantedBy=timers.target
EOF
  put_file "$UNITS/duskbot-server-update.timer" 0644 && changed=0
  return "$changed"
}

get_gate() {
  install -d -o root -g root -m 0755 "$LIB"
  if fetch "$LINK_BASE/docker-gate.mjs" "$TMP/docker-gate.mjs" && /usr/bin/node --check "$TMP/docker-gate.mjs"; then
    install -o root -g root -m 0644 "$TMP/docker-gate.mjs" "$GATE"
  elif [ ! -f "$GATE" ]; then
    echo "could not download the docker gate"; return 1
  fi
}

# the gate up and answering maus, or why not; bots work without it, their computers do not
gate_up() {
  docker info >/dev/null 2>&1 || { echo "docker is not running; the docker gate waits for it"; return 0; }
  systemctl enable omb-docker-gate.service >/dev/null 2>&1
  x systemctl restart omb-docker-gate.service
  i=0
  while [ "$i" -lt 20 ]; do
    if as_user env DOCKER_HOST="unix://$GATE_SOCK" docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then echo "docker gate answers $SVC_USER on $GATE_SOCK"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  echo "the docker gate did not answer; bot computers will not start"
  journalctl -u omb-docker-gate.service -n 20 --no-pager 2>/dev/null || true
}

# a docker restart stops the gate with it (Requires=) and, before docker.service wanted the gate, nothing started it
# again: every round of the update timer starts a gate that does not answer the server account
heal_gate() {
  [ -f "$UNITS/omb-docker-gate.service" ] && docker info >/dev/null 2>&1 || return 0
  systemctl add-wants docker.service omb-docker-gate.service >/dev/null 2>&1 || true
  as_user env DOCKER_HOST="unix://$GATE_SOCK" docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && return 0
  echo "$(date -u '+%F %T') the docker gate did not answer $SVC_USER; starting it again"
  systemctl reset-failed omb-docker-gate.service >/dev/null 2>&1 || true
  x systemctl restart omb-docker-gate.service || true
}

wait_health() { # url seconds
  i=0
  while [ "$i" -lt "$2" ]; do
    if curl -fsS -m 3 "$1" >/dev/null 2>&1; then return 0; fi
    sleep 2
    i=$((i + 2))
  done
  return 1
}

# sshd is the way back in: never the kernel's choice, and its memory is not reclaimed away under pressure
SSH_GUARD="# managed by duskbot-link
[Service]
OOMScoreAdjust=-1000
MemoryMin=64M"
ssh_guard() {
  changed=1
  for unit in ssh sshd; do
    systemctl cat "$unit.service" >/dev/null 2>&1 || continue
    install -d -m 0755 "$UNITS/$unit.service.d"
    printf '%s\n' "$SSH_GUARD" > "$TMP/new"
    put_file "$UNITS/$unit.service.d/10-duskbot-oom.conf" 0644 && changed=0
    # the running daemon takes it now; a restart would only pick up the same value
    pid=$(systemctl show -p MainPID --value "$unit.service" 2>/dev/null)
    [ -n "$pid" ] && [ "$pid" != 0 ] && echo -1000 > "/proc/$pid/oom_score_adj" 2>/dev/null || true
  done
  return "$changed"
}

# something other than our server listening on its port: the server cannot start, and the log alone does not say so
port_owner() {
  owner=$(ss -Hltnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\1 \2/p' | head -n 1)
  [ -n "$owner" ] || return 0
  [ "$(ps -o user= -p "${owner#* }" 2>/dev/null | tr -d ' ')" = "$SVC_USER" ] && return 0
  echo "port $PORT here is taken by ${owner% *} (pid ${owner#* }), not Metal: stop it, then paste the line again"
  return 1
}
do_service() {
  reload=1
  get_gate || true
  handoff_script || true
  server_unit && reload=0
  helper_units && reload=0
  ssh_guard && reload=0
  [ "$reload" = 0 ] && x systemctl daemon-reload
  systemctl enable duskbot.service duskbot-engines.path >/dev/null 2>&1
  x systemctl restart duskbot-engines.path
  if get_updater; then systemctl enable --now duskbot-server-update.timer >/dev/null 2>&1 || true; fi
  gate_up
  if box_works >/dev/null 2>&1; then echo "bot box: bubblewrap works for $SVC_USER"; else echo "bot box: bubblewrap cannot make a user namespace here; bots' turns are refused until it can"; fi
  # `start` leaves a running server on the build it started with: a new build needs a restart even when no unit changed
  if [ "$reload" = 0 ] || [ "$(state_get running-package)" != "$(state_get package)" ]; then x systemctl restart duskbot.service; else x systemctl start duskbot.service; fi
  show curl "http://127.0.0.1:$PORT/api/health"
  if wait_health "http://127.0.0.1:$PORT/api/health" 120; then
    echo "server answers on 127.0.0.1:$PORT"
    update_settle 1 || return 1
    state_set running-package "$(state_get package)"
    return 0
  fi
  echo "the server did not answer on 127.0.0.1:$PORT within two minutes"
  journalctl -u duskbot.service -n 30 --no-pager 2>/dev/null || true
  taken=0; port_owner || taken=1
  update_settle 0 && return 0
  # a first build that never answered here (and not for want of its port): the next line may bring an older one
  [ "$taken" = 1 ] || [ "$(state_get running-package)" = "$(state_get package)" ] || note_failed "$(installed_version)"
  return 1
}

get_agent() {
  install -d -o root -g root -m 0755 /opt/duskbot-link
  if fetch "$LINK_BASE/agent.mjs" "$TMP/agent.mjs" && /usr/bin/node --check "$TMP/agent.mjs"; then
    install -o root -g root -m 0644 "$TMP/agent.mjs" "$AGENT"
  elif [ ! -f "$AGENT" ]; then
    echo "could not download the link agent"; return 1
  fi
  agent_rtc || echo "webrtc for the link could not be installed; the app reaches this server over ssh, https or the relay"
}

# node-datachannel beside the agent, so the app's link can go over webrtc (agent.mjs directRtc); best effort, never fatal.
# keep the version in step with package.json's node-datachannel (a test checks)
AGENT_RTC_VERSION=0.33.6
agent_rtc() {
  [ "$(cat /opt/duskbot-link/node_modules/node-datachannel/package.json 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n 1)" = "$AGENT_RTC_VERSION" ] && return 0
  command -v npm >/dev/null 2>&1 || return 1
  retry npm install --no-save --no-fund --no-audit --no-package-lock --omit=dev --prefix /opt/duskbot-link "node-datachannel@$AGENT_RTC_VERSION" >/dev/null 2>&1 || return 1
  chmod -R go-w /opt/duskbot-link/node_modules
}

# the address the app uses, kept in state (mode, host, via, pin) and in $ADDRESS for the link agent, which tells the app
# over the sealed tunnel when it changes (a quick tunnel's name after a restart, another way chosen on a repair)
use_address() { # mode via [host] [pin]
  state_set mode "$1"; state_set via "$2"; state_set host "${3:-}"; state_set pin "${4:-0}"
  if [ "$2" != cloudflare ] && [ -f "$UNITS/duskbot-cloudflared.service" ]; then systemctl disable --now duskbot-cloudflared.service >/dev/null 2>&1 || true; fi
  _quick=""; [ "$2" = cloudflare ] && [ -z "$(state_get cf-named)" ] && _quick=",\"quick\":\"http://127.0.0.1:$CF_METRICS/quicktunnel\""
  printf '{"v":1,"mode":"%s","via":"%s","host":"%s","pin":%s%s}\n' "$1" "$2" "${3:-}" "$([ "${4:-0}" = 1 ] && echo true || echo false)" "$_quick" > "$ADDRESS.tmp"
  chmod 0644 "$ADDRESS.tmp" && mv -f "$ADDRESS.tmp" "$ADDRESS"
}
relay_address() { # [why]
  [ -z "${1:-}" ] || echo "$1"
  use_address relay "$( [ "$WANT" = ssh ] && echo ssh || echo relay )"
}
# the server names its public address only where it stays put (a quick tunnel's changes on every restart)
restart_for_address() {
  server_unit && systemctl daemon-reload && systemctl restart duskbot.service
  wait_health "http://127.0.0.1:$PORT/api/health" 120 || true
}
public_ip() { curl -fsS --proto "$PROTO" --proto-redir "$PROTO" -m 10 "$LINK_BASE/v1/ip" 2>/dev/null | sed -n 's/.*"ip":"\([0-9.]*\)".*/\1/p' | head -n 1; }


ts() { tailscale "$@"; }
ts_field() { # BackendState | DNSName
  ts status --json 2>/dev/null | /usr/bin/node -e 'let t="";process.stdin.on("data",(c)=>t+=c).on("end",()=>{try{const s=JSON.parse(t);const v=process.argv[1]==="DNSName"?s.Self?.DNSName:s.BackendState;console.log(String(v??"").replace(/\.$/,""))}catch{}})' "$1" 2>/dev/null || true
}
# tailnet https port 443: free, ours (a proxy to this server alone) or taken. a status that cannot be read counts as free,
# and `serve` then fails or asks the person
ts_https_443() { # dnsname
  ts serve status --json 2>/dev/null | /usr/bin/node -e 'let t="";process.stdin.on("data",(c)=>t+=c).on("end",()=>{try{const s=JSON.parse(t);if(!s.TCP?.["443"]){console.log("free");return}const h=s.Web?.[process.argv[1]+":443"]?.Handlers??{};console.log(Object.keys(h).join()==="/"&&h["/"].Proxy===process.argv[2]?"ours":"taken")}catch{console.log("free")}})' "$1" "http://127.0.0.1:$PORT" 2>/dev/null || echo free
}
TS_INSTALL_SECS=600 TS_WAIT_SECS=900
tailscale_install() {
  command -v tailscale >/dev/null 2>&1 && return 0
  echo "installing Tailscale (its own installer, from tailscale.com)"
  fetch https://tailscale.com/install.sh "$TMP/tailscale.sh"
  new_file /etc/apt/sources.list.d/tailscale.list
  new_file /usr/share/keyrings/tailscale-archive-keyring.gpg
  installed_pkgs > "$TMP/pkgs-before"
  set -- sh "$TMP/tailscale.sh"
  if command -v timeout >/dev/null 2>&1; then set -- timeout -k 15 "$TS_INSTALL_SECS" "$@"; fi
  if command -v setsid >/dev/null 2>&1; then set -- setsid -w "$@"; fi
  x "$@" || echo "Tailscale's installer did not finish in $((TS_INSTALL_SECS / 60)) minutes or failed"
  installed_pkgs | comm -13 "$TMP/pkgs-before" - | while read -r _p; do manifest_add "pkg $_p"; done
  command -v tailscale >/dev/null 2>&1
}
# a microVM or container without /dev/net/tun still gets a tailnet: tailscaled's own network stack (serve works there)
tailscale_daemon() {
  systemctl enable --now tailscaled >/dev/null 2>&1 || true
  i=0; while [ "$i" -lt 10 ] && ! ts status --json >/dev/null 2>&1 && [ "$(ts_field BackendState)" = "" ]; do sleep 1; i=$((i + 1)); done
  if [ ! -c /dev/net/tun ] && ! grep -q 'userspace-networking' /etc/default/tailscaled 2>/dev/null; then
    echo "no /dev/net/tun here; Tailscale runs in userspace networking"
    [ -f /etc/default/tailscaled.omb-before ] || cp -p /etc/default/tailscaled /etc/default/tailscaled.omb-before 2>/dev/null || true
    printf '# managed by duskbot-link: no tun device on this server\nPORT="41641"\nFLAGS="--tun=userspace-networking"\n' > /etc/default/tailscaled
    x systemctl restart tailscaled
    sleep 2
  fi
}
# runs a tailscale command that may print a link for the person and wait for them: the link goes to them (kind), and
# this waits until the command ends. 0: it finished, 1: it failed or ran out of time
ts_with_link() { # kind seconds pattern words... -- command...
  _kind=$1 _secs=$2 _pat=$3; shift 3
  _words=""; while [ "$1" != -- ]; do _words="$_words$1
"; shift; done; shift
  : > "$TMP/ts.out"
  rm -f "$TMP/ts.rc"
  # set +e: under the step's set -e (dash), a command that fails would end this subshell before it leaves its code,
  # and the wait would last the whole $_secs instead of ending at once
  ( set +e; "$@" > "$TMP/ts.out" 2>&1; echo $? > "$TMP/ts.rc" ) &
  _pid=$! _t=0 _asked=""
  while [ ! -f "$TMP/ts.rc" ]; do
    _url=$(grep -o "$_pat" "$TMP/ts.out" 2>/dev/null | head -n 1)
    if [ -n "$_url" ] && [ "$_url" != "$_asked" ]; then
      _asked=$_url
      printf '%s\n  %s\n\nWaiting for you, up to %s minutes. After that this server uses the private relay instead.\n' "$_words" "$_url" "$(((_secs + 59) / 60))" | ask "{\"kind\":\"$_kind\",\"url\":\"$_url\",\"state\":\"waiting\"}"
    fi
    sleep 1; _t=$((_t + 1))
    if [ "$_t" -ge "$_secs" ]; then kill "$_pid" 2>/dev/null || true; wait "$_pid" 2>/dev/null || true; redact < "$TMP/ts.out"; return 1; fi
  done
  wait "$_pid" 2>/dev/null || true
  redact < "$TMP/ts.out"
  [ "$(cat "$TMP/ts.rc")" = 0 ]
}
address_tailscale() {
  tailscale_install || { relay_address "Tailscale did not install; using the private relay"; return 11; }
  tailscale_daemon
  if [ "$(ts_field BackendState)" != Running ]; then
    if [ -n "$TS_KEY" ]; then
      show tailscale up --auth-key=[redacted]
      ts up --auth-key="$TS_KEY" --timeout=2m 2>&1 | redact || true
    else
      ts_with_link tailscale-login "$TS_WAIT_SECS" 'https://login\.tailscale\.com/[A-Za-z0-9/._?=&-]*' \
        "Sign in to Tailscale to put this server on your tailnet. Open this link on any device:" -- ts up --timeout="${TS_WAIT_SECS}s" || true
    fi
  fi
  [ "$(ts_field BackendState)" = Running ] || { relay_address "Tailscale is not signed in; using the private relay. To use Tailscale later, sign in with: tailscale up, then paste the line again"; return 11; }
  dns=$(ts_field DNSName)
  [ -n "$dns" ] || { relay_address "this server has no MagicDNS name; turn MagicDNS on for your tailnet. Using the private relay"; return 11; }
  echo "on the tailnet as $dns"
  [ "$(ts_https_443 "$dns")" != taken ] || { relay_address "tailnet https port 443 already serves something else here; leaving it alone and using the private relay"; return 11; }
  # https for the tailnet: `tailscale serve` prints the one admin link that turns it on and waits for it
  if ! ts_with_link tailscale-https "$TS_WAIT_SECS" 'https://login\.tailscale\.com/[A-Za-z0-9/._?=&-]*' \
    "Turn on HTTPS for your tailnet (one click), so this server gets an https address:" -- ts serve --bg --https=443 "http://127.0.0.1:$PORT"; then
    relay_address "Tailscale HTTPS is not on; using the private relay. To use Tailscale later, turn HTTPS on in its admin console, then paste the line again"; return 11
  fi
  manifest_add "tailscale-serve 443"
  ask_clear
  ts serve status 2>&1 | redact || true
  # the first request makes the certificate, which takes a few seconds. in userspace networking this server cannot
  # reach its own tailnet address, so only the app's first request does that
  if [ -c /dev/net/tun ]; then
    ip=$(ts ip -4 2>/dev/null | head -n 1) i=0
    until curl -fsS -m 20 ${ip:+--resolve "$dns:443:$ip"} "https://$dns/api/health" >/dev/null 2>&1; do
      i=$((i + 1)); [ "$i" -lt 6 ] || { echo "https://$dns did not answer yet; the app keeps trying"; break; }
      sleep 5
    done
  fi
  use_address direct tailscale "$dns" 0
  restart_for_address
  echo "https://$dns serves Metal on your tailnet"
}

cloudflared_install() {
  command -v cloudflared >/dev/null 2>&1 && return 0
  apt_install ca-certificates curl gnupg
  new_file /usr/share/keyrings/cloudflare-main.gpg; new_file /etc/apt/sources.list.d/cloudflared.list
  fetch https://pkg.cloudflare.com/cloudflare-main.gpg "$TMP/cf.gpg"
  install -m 0644 "$TMP/cf.gpg" /usr/share/keyrings/cloudflare-main.gpg
  printf 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main\n' > /etc/apt/sources.list.d/cloudflared.list
  rm -f "$TMP/apt-updated"
  apt_install cloudflared
}
cloudflared_unit() { # exec args, [credentials file the unit's own user reads through systemd]
  cat > "$TMP/new" <<EOF
# managed by duskbot-link: the app's address through Cloudflare
[Unit]
Description=Cloudflare tunnel for Metal
After=network-online.target duskbot.service
Wants=network-online.target

[Service]
DynamicUser=yes
EnvironmentFile=-$ETC/cloudflared.env
${2:+LoadCredential=tunnel.json:$2
}ExecStart=/usr/bin/cloudflared --no-autoupdate $1
Restart=always
RestartSec=5
$HARDENING
RestrictSUIDSGID=yes
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
  put_file "$UNITS/duskbot-cloudflared.service" 0644 || true
  systemctl daemon-reload
  systemctl enable duskbot-cloudflared.service >/dev/null 2>&1
  x systemctl restart duskbot-cloudflared.service
}
address_cloudflare() {
  cloudflared_install || { relay_address "cloudflared did not install; using the private relay"; return 11; }
  if [ -n "$CF_TOKEN" ] && [ -n "$CF_HOST" ]; then
    # a tunnel the link service made for this server: its public hostname points at http://127.0.0.1:8799
    install -d -o root -g root -m 0700 "$ETC"
    ( umask 077; printf 'TUNNEL_TOKEN=%s\n' "$CF_TOKEN" > "$ETC/cloudflared.env" )
    state_set cf-named 1
    cloudflared_unit "tunnel run"
    host=$CF_HOST
  else
    state_set cf-named ""
    rm -f "$ETC/cloudflared.env"
    cloudflared_unit "tunnel --metrics 127.0.0.1:$CF_METRICS --url http://127.0.0.1:$PORT"
    host="" i=0
    while [ -z "$host" ]; do
      i=$((i + 1)); [ "$i" -lt 60 ] || { relay_address "the quick tunnel did not start; using the private relay"; return 11; }
      sleep 2
      host=$(curl -fsS -m 3 "http://127.0.0.1:$CF_METRICS/quicktunnel" 2>/dev/null | sed -n 's/.*"hostname":"\([a-z0-9.-]*\.trycloudflare\.com\)".*/\1/p')
    done
  fi
  echo "waiting for https://$host"
  i=0
  until curl -fsS -m 10 "https://$host/api/health" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 40 ] || { relay_address "https://$host did not answer; using the private relay"; return 11; }
    sleep 3
  done
  use_address direct cloudflare "$host" 0
  restart_for_address
  echo "https://$host serves Metal through Cloudflare"
}

do_address() {
  get_agent
  want=${WANT:-$(state_get want)}
  [ -z "$WANT" ] || state_set want "$WANT"
  WANT=$want
  # an already linked server keeps its address, unless this run asked for another way
  if [ "$OFFLINE" = 1 ] && [ -z "$ARGS_WANT" ]; then
    mode=$(state_get mode)
    echo "already linked; keeping the ${mode:-relay} connection"; return 0
  fi
  case "$WANT" in
    "") relay_address "linked through the private relay (nothing inbound is opened)" ;;
    relay) relay_address "the private relay, as asked" ;;
    ssh) relay_address "linked through the relay; the app reaches it over ssh on port 22"
      _user=${SUDO_USER:-root}; _ip=$(public_ip)
      [ -z "$_ip" ] || printf 'To open Metal in a browser on your computer, keep this running there:\n  ssh -N -L 8790:127.0.0.1:%s %s@%s\nthen go to http://127.0.0.1:8790\n' "$PORT" "$_user" "$_ip" \
        | ask "{\"kind\":\"ssh\",\"user\":\"$_user\",\"host\":\"$_ip\",\"state\":\"done\"}" ;;
    tailscale) address_tailscale ;;
    cloudflare) address_cloudflare ;;
    # a way an older line chose that is no longer offered
    *) relay_address "the $WANT way is no longer offered; using the private relay" ;;
  esac
  # every server keeps a cloudflare quick tunnel as a backup path, run by the link agent (no account, no login): the
  # package comes from cloudflare's signed apt repository here, best effort (the agent fetches a pinned one otherwise)
  [ "$WANT" = cloudflare ] || [ "${DUSK_LINK_BACKUP:-}" = off ] || ( cloudflared_install ) >/dev/null 2>&1 || true
}

install_output() {
  node --input-type=module -e '
import { once } from "node:events";
import { writeFileSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";
const [file, kind] = process.argv.slice(1);
const seen = new Set(), finished = new Set(), transfers = new Map();
let previous = "", legacyTotal = 0, legacyStep = 0;
const bytes = (number, unit) => {
  const units = { b: 0, kb: 1, mb: 2, gb: 3, tb: 4, pb: 5, eb: 6 };
  const power = units[unit.toLowerCase().replace("i", "")];
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number(number) * (unit.toLowerCase().includes("i") ? 1024 : 1000) ** power));
};
const emit = () => {
  const value = { kind, completed: finished.size, total: legacyTotal || seen.size, label: kind === "layers" ? "Image layers" : "Reported build operations" };
  if (!value.total) return;
  if (transfers.size) {
    value.receivedBytes = Math.min(Number.MAX_SAFE_INTEGER, [...transfers.values()].reduce((sum, entry) => sum + entry.received, 0));
    value.totalBytes = Math.min(Number.MAX_SAFE_INTEGER, [...transfers.values()].reduce((sum, entry) => sum + entry.total, 0));
  }
  const encoded = JSON.stringify(value);
  if (encoded === previous) return;
  previous = encoded;
  writeFileSync(file + ".json.tmp", encoded);
  renameSync(file + ".json.tmp", file + ".json");
  writeFileSync(file + ".tmp", `count ${value.completed} ${value.total} ${kind === "layers" ? "layers" : "steps"}\n`);
  renameSync(file + ".tmp", file);
};
for await (const raw of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!process.stdout.write(raw + "\n")) await once(process.stdout, "drain");
  const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (kind === "layers") {
    const layer = /^([a-f0-9]+):\s*(.*)$/i.exec(line);
    if (!layer || !/^(Pulling fs layer|Waiting|Already exists|Downloading|Download complete|Extracting|Pull complete)/.test(layer[2])) continue;
    const [, id, status] = layer;
    seen.add(id);
    if (/^(Pull complete|Already exists)/.test(status)) finished.add(id);
    const amount = /^Downloading.*?([0-9]+(?:\.[0-9]+)?)([kMGTPE]?i?B)\s*\/\s*([0-9]+(?:\.[0-9]+)?)([kMGTPE]?i?B)/i.exec(status);
    if (amount) transfers.set(id, { received: bytes(amount[1], amount[2]), total: bytes(amount[3], amount[4]) });
    if (/^(Download complete|Pull complete)/.test(status) && transfers.has(id)) transfers.get(id).received = transfers.get(id).total;
  } else {
    const vertex = /^#([0-9]+)(?:\s|$)/.exec(line);
    if (vertex) {
      seen.add(vertex[1]);
      if (/^#[0-9]+\s+(DONE|CACHED)(?:\s|$)/.test(line)) finished.add(vertex[1]);
    }
    const step = /^Step ([0-9]+)\/([0-9]+) :/.exec(line);
    if (step) { legacyStep = Number(step[1]); legacyTotal = Number(step[2]); seen.add(String(legacyStep)); }
    if (legacyStep && /^ ---> [a-f0-9]+$/.test(line)) finished.add(String(legacyStep));
  }
  emit();
}
' "$PROGRESS" "$1"
}

pull_with_progress() { # image
  rm -f "$TMP/pull.rc"
  { show docker pull "$1"; docker pull "$1" 2>&1; echo $? > "$TMP/pull.rc"; } | install_output layers
  rm -f "$PROGRESS" "$PROGRESS.json"
  [ "$(cat "$TMP/pull.rc" 2>/dev/null)" = 0 ]
}

# the bot desktop kit (deploy/bot-desktop + shared/bot-desktop.ts) from the link service, unpacked once per sha256
KIT_SHA="" KIT_SIZE=0 KIT=""
get_kit() {
  [ -n "$KIT_SHA" ] || { echo "the link service has no bot computer kit"; return 1; }
  KIT="$KIT_DIR/$KIT_SHA"
  [ -f "$KIT/deploy/bot-desktop/build.sh" ] && return 0
  install -d -m 0755 "$KIT_DIR"
  install -d -m 0700 "$KIT_DIR/.downloads"
  archive="$KIT_DIR/.downloads/$KIT_SHA.tgz"
  verified_download "$LINK_BASE/pkg/$LINK_ID/$KIT_SHA.tgz" "$archive" "$KIT_SHA" "$KIT_SIZE" 900 "bot computer kit" || return $?
  rm -rf "$KIT.tmp" && mkdir -p "$KIT.tmp"
  x tar -xzf "$archive" --no-same-owner -C "$KIT.tmp" || return 1
  find "$KIT_DIR" -mindepth 1 -maxdepth 1 ! -name "$KIT_SHA" ! -name "$KIT_SHA.tmp" ! -name .downloads -exec rm -rf {} + 2>/dev/null || true
  mv "$KIT.tmp" "$KIT"
  echo "kit $KIT_SHA unpacked in $KIT"
}

docker_has() { # runsc | userns
  case "$1" in
    runsc) docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"' ;;
    userns) docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q 'name=userns' ;;
  esac
}

# merges one setting into /etc/docker/daemon.json (keeping everything else), restarts docker, and puts the old file
# back if docker won't start with the new one. returns 1 when it had to roll back.
daemon_merge() { # gvisor | userns
  conf=/etc/docker/daemon.json
  install -d -m 0755 /etc/docker
  [ -f "$conf" ] && [ ! -f "$conf.omb-before" ] && cp -p "$conf" "$conf.omb-before"
  [ -f "$conf" ] || manifest_add "daemon-json new"
  [ -f "$conf" ] && cp -p "$conf" "$TMP/daemon.json.old"
  /usr/bin/node -e '
    const fs = require("fs"), [file, what, out] = process.argv.slice(1);
    let conf = {};
    try { conf = JSON.parse(fs.readFileSync(file, "utf8") || "{}"); } catch (e) { if (e.code !== "ENOENT") { console.error("daemon.json is not valid json; leaving it alone"); process.exit(3); } }
    if (what === "gvisor") conf.runtimes = { ...(conf.runtimes || {}), runsc: { path: "/usr/bin/runsc", runtimeArgs: ["--overlay2=none"] } };
    else conf["userns-remap"] = conf["userns-remap"] || "default";
    fs.writeFileSync(out, JSON.stringify(conf, null, 2) + "\n");
  ' "$conf" "$1" "$TMP/daemon.json.new" || return 1
  if [ -f "$conf" ] && cmp -s "$TMP/daemon.json.new" "$conf"; then echo "daemon.json already has it"; return 0; fi
  install -m 0644 "$TMP/daemon.json.new" "$conf"
  echo "daemon.json: added $1; restarting docker"
  x systemctl restart docker && docker_wait && { manifest_add "daemon-key $1"; return 0; }
  echo "docker would not start with the new daemon.json; putting the old one back"
  if [ -f "$TMP/daemon.json.old" ]; then install -m 0644 "$TMP/daemon.json.old" "$conf"; else rm -f "$conf"; fi
  systemctl reset-failed docker >/dev/null 2>&1 || true
  systemctl restart docker && docker_wait || true
  return 1
}
docker_wait() { i=0; while [ "$i" -lt 60 ]; do docker info >/dev/null 2>&1 && return 0; sleep 2; i=$((i + 2)); done; return 1; }

gvisor_install() {
  command -v runsc >/dev/null 2>&1 && return 0
  fetch https://gvisor.dev/archive.key "$TMP/gvisor.key"
  new_file /usr/share/keyrings/gvisor-archive-keyring.gpg; new_file /etc/apt/sources.list.d/gvisor.list
  x gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg "$TMP/gvisor.key"
  chmod 0644 /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  rm -f "$TMP/apt-updated"
  apt_install runsc
}

# root in a bot computer must not be root here: gVisor when it installs and runs, else user-namespace remapping
do_sandbox() {
  docker info >/dev/null 2>&1 || { echo "docker is not running"; return 10; }
  if docker_has runsc; then echo "gVisor (runsc) already registered with docker"; return 0; fi
  if docker_has userns; then echo "user-namespace remapping already on"; return 0; fi
  if gvisor_install && daemon_merge gvisor && docker_has runsc; then
    runsc --version 2>/dev/null | head -n 1
    echo "gVisor registered with docker (--overlay2=none)"
    return 0
  fi
  echo "gVisor did not work here; using user-namespace remapping"
  if daemon_merge userns && docker_has userns; then echo "user-namespace remapping on"; return 0; fi
  echo "no sandbox, bot computers run strict"
  return 11
}

# boxes reach the public internet and nothing else; checked the way the server checks it
do_fence() {
  docker info >/dev/null 2>&1 || { echo "docker is not running"; return 10; }
  if get_kit; then
    command -v iptables >/dev/null 2>&1 || apt_install iptables
    install -m 0755 "$KIT/deploy/bot-desktop/host-fence.sh" /usr/local/sbin/omb-host-fence
    cat "$KIT/deploy/bot-desktop/omb-box-fence.service" > "$TMP/new"
    put_file "$UNITS/omb-box-fence.service" 0644 && systemctl daemon-reload
  elif [ ! -x /usr/local/sbin/omb-host-fence ] || [ ! -f "$UNITS/omb-box-fence.service" ]; then
    echo "no kit, bot computers run strict"; return 11
  fi
  systemctl enable omb-box-fence.service >/dev/null 2>&1
  # oneshot with RemainAfterExit: restart re-applies (the script is idempotent)
  x systemctl restart omb-box-fence.service
  if x /usr/local/sbin/omb-host-fence --check; then echo "fenced: omb-desk0 reaches the public internet only"; return 0; fi
  echo "fence check failed, bot computers run strict"
  return 11
}

build_with_progress() { # image dir
  rm -f "$TMP/build.rc"
  { show IMAGE="$1" sh "$2/build.sh"; IMAGE="$1" BUILDKIT_PROGRESS=plain sh "$2/build.sh" 2>&1; echo $? > "$TMP/build.rc"; } | install_output build
  rm -f "$PROGRESS" "$PROGRESS.json"
  [ "$(cat "$TMP/build.rc" 2>/dev/null)" = 0 ]
}

do_desktop() {
  [ -n "$BOT_DESKTOP_IMAGE" ] || { echo "no bot computer image named by the link service"; return 10; }
  docker info >/dev/null 2>&1 || { echo "docker is not running"; return 10; }
  state_set desktop-image "$BOT_DESKTOP_IMAGE"
  if docker image inspect "$BOT_DESKTOP_IMAGE" >/dev/null 2>&1; then echo "$BOT_DESKTOP_IMAGE is already here"; state_set desktop present; return 0; fi
  if pull_with_progress "$BOT_DESKTOP_IMAGE"; then state_set desktop pulled; echo "pulled $BOT_DESKTOP_IMAGE"; return 0; fi
  echo "no registry copy of $BOT_DESKTOP_IMAGE; building it here"
  get_kit || { echo "no kit, the app builds it on first use"; return 11; }
  # the bot computer's Dockerfile needs BuildKit (TARGETARCH); Ubuntu ships it as docker-buildx
  docker buildx version >/dev/null 2>&1 || apt_install docker-buildx || echo "no buildx; the bot computer can't be built here"
  if build_with_progress "$BOT_DESKTOP_IMAGE" "$KIT/deploy/bot-desktop" && docker image inspect "$BOT_DESKTOP_IMAGE" >/dev/null 2>&1; then
    state_set desktop built
    return 0
  fi
  echo "build failed, the app builds it on first use"
  return 11
}

do_link() {
  [ -f "$AGENT" ] || get_agent
  set +e
  show node "$AGENT" link
  runuser -u "$LINK_USER" -- env HOME="$LINK_HOME" LINK_BASE="$LINK_BASE" LINK_ID="$LINK_ID" LINK_TOKEN="$VPS_TOKEN" \
    LINK_MODE="$(state_get mode)" LINK_HOST="$(state_get host)" LINK_VIA="$(state_get via)" LINK_PIN="$(state_get pin)" LINK_NAME="$NAME" /usr/bin/node "$AGENT" link
  code=$?
  set -e
  case "$code" in 0|4) ;; *) return 1 ;; esac
  state_set linked "$LINK_ID"
  start_link_service
  echo "linked as $NAME"
}

start_link_service() {
  helper_units && systemctl daemon-reload
  systemctl enable duskbot-link.service >/dev/null 2>&1
  x systemctl restart duskbot-link.service
}

# ---------- demo ----------
# DUSK_INSTALL_DEMO=1 sh install.sh: the real screen with pretend steps. writes only to its own temp dir.
demo_lines() { _d=$1; shift; for _l in "$@"; do sleep "$_d"; printf '%s\n' "$_l"; done; }
demo_bytes() { # total unit seconds*10
  _t=0
  while [ "$_t" -lt "$3" ]; do
    _t=$((_t + 1))
    progress bytes $(($1 * _t / $3)) "$1"
    sleep 0.1
  done
  rm -f "$PROGRESS"
}
demo_work() {
  case "$1" in
    check) demo_lines 0.2 "$ dpkg --print-architecture" "arm64" "$ . /etc/os-release" "$ df -Pk /"; demo_lines 0.3 "memory: 11953 MB" "free disk: 187214 MB" "system: Ubuntu 24.04.3 LTS (arm64)" ;;
    basics) demo_lines 0.35 "$ apt-get -q -o DPkg::Lock::Timeout=300 update" "Hit:1 http://ports.ubuntu.com/ubuntu-ports noble InRelease" \
      "Get:2 http://ports.ubuntu.com/ubuntu-ports noble-updates InRelease [126 kB]" "Reading package lists..." \
      "Unpacking gnupg (2.4.4-2ubuntu17.3) ..." "Setting up xz-utils (5.6.1+really5.4.5-1ubuntu0.2) ..." ;;
    docker) demo_lines 0.4 "Get:1 http://ports.ubuntu.com/ubuntu-ports noble-updates/universe arm64 docker.io 27.5.1 [28.6 MB]" \
      "Unpacking docker.io (27.5.1-0ubuntu3~24.04.2) ..." "Setting up containerd (1.7.27-0ubuntu1~24.04.1) ..." \
      "Created symlink /etc/systemd/system/sockets.target.wants/docker.socket" "Docker version 27.5.1, build 27.5.1" ;;
    user) demo_lines 0.3 "uid=1001(dusk) gid=1001(dusk) groups=1001(dusk),988(docker)" ;;
    node) demo_lines 0.35 "$ curl -fsSL --connect-timeout 15 -m 300 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource.key" "$ apt-get -y -q install nodejs" "Get:1 https://deb.nodesource.com/node_24.x nodistro InRelease [12.1 kB]" \
      "Get:4 https://deb.nodesource.com/node_24.x nodistro/main arm64 nodejs 24.11.0-1nodesource1 [31.2 MB]" \
      "Unpacking nodejs (24.11.0-1nodesource1) ..." "node v24.11.0, npm 11.6.1" ;;
    app) echo "$ curl -fsSL -H 'authorization: Bearer [redacted]' https://link.dusk.bot/pkg/demodemoab/7c2f0a9e41d6.tgz"; echo "downloading Metal 0.1.141 (41.6 MB)"; demo_bytes 43620000 MB 32
      demo_lines 0.4 "sha256 ok: 7c2f0a9e41d6b3c88f1e2a07d95b6e4f3a10c2d8e7f6b5a4c3d2e1f0a9b8c7d6" \
        "added 3 packages in 2s" "changed 61 packages in 4s" ;;
    engines)
      demo_lines 0.5 "$ npm install --global --no-fund --no-audit --prefix /home/dusk/.local @anthropic-ai/claude-code @openai/codex" "npm http fetch GET 200 https://registry.npmjs.org/@anthropic-ai%2fclaude-code 412ms" \
        "npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex 388ms" \
        "npm http fetch GET 200 https://registry.npmjs.org/@openai/codex/-/codex-0.58.0-linux-arm64.tgz 2104ms"
      if [ "$DEMO" = fail ]; then
        demo_lines 0.4 "npm error code ETIMEDOUT" "npm error syscall connect" \
          "npm error errno ETIMEDOUT" "npm error network request to https://registry.npmjs.org/@openai%2fcodex failed, reason: connect ETIMEDOUT 104.16.2.35:443" \
          "npm error network This is a problem related to network connectivity." \
          "npm error A complete log of this run can be found in: /home/dusk/.npm/_logs/2026-11-07T09_41_12_018Z-debug-0.log"
        return 1
      fi
      demo_lines 0.4 "added 4 packages in 6s" ;;
    service) demo_lines 0.5 "Created symlink /etc/systemd/system/multi-user.target.wants/duskbot.service" \
      "waiting for 127.0.0.1:8799/api/health" "server answers on 127.0.0.1:8799" ;;
    address) demo_lines 0.4 "linked through the private relay (nothing inbound is opened)" ;;
    sandbox) demo_lines 0.35 "Get:1 https://storage.googleapis.com/gvisor/releases release/main arm64 runsc 20251103.0 [24.1 MB]" \
      "Setting up runsc (20251103.0) ..." "daemon.json: added gvisor; restarting docker" "runsc version release-20251103.0" \
      "gVisor registered with docker (--overlay2=none)" ;;
    fence) echo "downloading the bot computer kit"; demo_bytes 236000 MB 4
      demo_lines 0.3 "Created symlink /etc/systemd/system/docker.service.wants/omb-box-fence.service" \
        "host-fence: boxes on omb-desk0 are fenced" "fenced: omb-desk0 reaches the public internet only" ;;
    desktop) demo_lines 0.3 "Error response from daemon: denied" "no registry copy of ghcr.io/sidddevz/omb-bot-desktop:v1; building it here"
      _k=0
      while [ "$_k" -lt 15 ]; do
        _k=$((_k + 1)); progress count "$_k" 15 steps
        echo "#$((_k + 6)) [stage-1 $_k/15] RUN apt-get install -y --no-install-recommends chromium tigervnc-standalone-server openbox"
        sleep 0.45
      done
      rm -f "$PROGRESS"; state_set desktop built; echo "built ghcr.io/sidddevz/omb-bot-desktop:v1 in 94s" ;;
    link) demo_lines 0.45 "pairing code issued" "sealed for the app (x25519 + aes-256-gcm)" "tunnel up" "linked as oracle-arm" ;;
  esac
}

# ---------- the end ----------
version_of() { # command... -> its first version-looking word
  "$@" 2>/dev/null | head -n 1 | grep -o '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*' | head -n 1 || true
}
finale() {
  total=$(fmt_ms $(($(now_ms) - RUN_T0)))
  if [ -n "$DEMO" ]; then
    app="0.1.141, build 7c2f0a9e41d6" engines="Claude Code 2.0.37, Codex 0.58.0" node="v24.11.0"
    docker="29.1.3, gVisor sandbox, network fenced" link="private relay"
    computer="ghcr.io/sidddevz/omb-bot-desktop:v1, built here"
  else
    app=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$SVC_HOME/.local/lib/node_modules/duskbot/package.json" 2>/dev/null | head -n 1)
    pkg=$(state_get package)
    case "$pkg" in sha256:*) app="${app:-?}, build $(printf '%s' "${pkg#sha256:}" | cut -c1-12)" ;; npm:*) app="${app:-?}, from npm (${pkg#npm:})" ;; esac
    u="runuser -u $SVC_USER -- env HOME=$SVC_HOME PATH=$SVC_HOME/.local/bin:/usr/bin:/bin"
    # shellcheck disable=SC2086
    engines="Claude Code $(version_of timeout 10 $u claude --version), Codex $(version_of timeout 10 $u codex --version)"
    node=$(/usr/bin/node -v 2>/dev/null || echo "?")
    computer="not set up"
    if docker info >/dev/null 2>&1; then
      docker="$(version_of timeout 10 docker --version)"
      if docker_has runsc; then docker="$docker, gVisor sandbox"; elif docker_has userns; then docker="$docker, user-namespace sandbox"; else docker="$docker, no sandbox"; fi
      if /usr/local/sbin/omb-host-fence --check >/dev/null 2>&1; then docker="$docker, network fenced"; else docker="$docker, not fenced (strict boxes)"; fi
      if [ -n "$BOT_DESKTOP_IMAGE" ] && docker image inspect "$BOT_DESKTOP_IMAGE" >/dev/null 2>&1; then
        case "$(state_get desktop)" in built) how="built here" ;; pulled) how="pulled" ;; *) how="ready" ;; esac
        computer="$BOT_DESKTOP_IMAGE, $how"
      fi
    else
      docker="not running"
    fi
    if [ "$(state_get mode)" = direct ]; then link="https://$(state_get host) ($(state_get via))"; else link="private relay"; fi
  fi
  logs=$LOGS; [ -n "$DEMO" ] && logs="$LOGS_SHOWN (demo: nothing was written)"
  table=$(for _row in "app|$app" "engines|$engines" "node|$node" "docker|$docker" "computer|$computer" "link|$link" "logs|$logs"; do
    printf '%-10s %s\n' "${_row%%|*}" "${_row#*|}"
  done)
  [ -n "$DEMO" ] || printf '%s\n' "$table" > "$LOGS/summary.log"
  # the mascot settles
  mascot 0
  glyph ok; _ok=$G; glyph sep
  where="$NAME $G $SYS $ARCH $G $link"
  printf '\n  %s%s %sYour Metal is ready%s  %s%s %s%s\n' "$OK" "$_ok" "$BOLD" "$R" "$DIM" "$G" "$total" "$R"
  printf '    %s%s%s\n\n' "$DIM" "$where" "$R"
  if [ "${DUSK_VERBOSE:-}" = 1 ]; then printf '%s\n' "$table" | sed 's/^/    /'; printf '\n'; fi
  if [ -z "$DEMO" ] && ! box_works >/dev/null 2>&1; then
    printf '  %sBots can'"'"'t answer here yet: this server does not let bubblewrap make the bot box'"'"'s user namespace.%s\n' "$WARN" "$R"
  fi
  printf '  %s%sNow go back to the app to move your bots here.%s\n' "$ACC" "$BOLD" "$R"
  printf '  %sTo take it off later: dusk.bot/docs/your-own-server#removing-it%s\n\n' "$DIM" "$R"
}



# root's own copy of this script for the update timer: the one the link service serves (the same trust as the line),
# replaced later only from a signed build that carries it (refresh_updater)
get_updater() {
  install -d -o root -g root -m 0755 "$LIB"
  if fetch "$LINK_BASE/install.sh" "$TMP/updater.sh" && sh -n "$TMP/updater.sh"; then
    install -o root -g root -m 0755 "$TMP/updater.sh" "$UPDATER"
  fi
  [ -f "$UPDATER" ]
}
# the docker gate a verified build carries, when it differs from the one installed: a server whose build moved its bot
# computers to a newly named image, with the gate from its install day, had every computer update refused (2026-11-14).
# a gate restart cuts what goes through it at that moment, so callers run this only while no bot is working
refresh_gate() { # verified tgz
  [ "$(state_get signed)" = 1 ] && [ -f "$1" ] || return 0
  tar -xzOf "$1" package/link/docker-gate.mjs > "$TMP/docker-gate.mjs" 2>/dev/null && [ -s "$TMP/docker-gate.mjs" ] && "$NODE_BIN" --check "$TMP/docker-gate.mjs" 2>/dev/null || return 0
  if [ -f "$GATE" ] && cmp -s "$TMP/docker-gate.mjs" "$GATE"; then return 0; fi
  install -d -o root -g root -m 0755 "$LIB"
  install -o root -g root -m 0644 "$TMP/docker-gate.mjs" "$GATE" || return 0
  echo "the docker gate now matches the build"
  if systemctl is-active --quiet omb-docker-gate.service; then x systemctl restart omb-docker-gate.service; fi
}

refresh_updater() { # verified tgz
  [ "$(state_get signed)" = 1 ] || return 0
  tar -xzOf "$1" package/link/install.sh > "$TMP/updater.sh" 2>/dev/null && [ -s "$TMP/updater.sh" ] && sh -n "$TMP/updater.sh" || return 0
  install -o root -g root -m 0755 "$TMP/updater.sh" "$UPDATER" && echo "the updater now matches the build"
}

# the build the link agent staged, read as data: "<sha256> <size> <version|-> <signature|-> <policy body|-> <policy signature|->",
# every field checked against its own pattern, so nothing from that folder reaches the shell unchecked
as_link() { runuser -u "$LINK_USER" -- "$@"; }
staged_offer() {
  as_link head -c 70000 "$SERVER_RELEASE/ready.json" 2>/dev/null | "$NODE_BIN" -e '
const fs = require("node:fs");
const SIG = /^r1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]{1,4000}\.[A-Za-z0-9_-]{40,200}$/;
let r; try { r = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
if (!/^[0-9a-f]{64}$/.test(r?.sha256 ?? "") || !Number.isSafeInteger(r.size) || r.size <= 0 || r.size > 2 * 1024 ** 3) process.exit(1);
const or = (ok, v) => (ok ? v : "-");
const body = r.policy?.body, psig = r.policy?.signature;
const policy = typeof body === "string" && /^[A-Za-z0-9_-]{1,32000}$/.test(body) && SIG.test(psig ?? "");
console.log([r.sha256, r.size, or(/^\d+\.\d+\.\d+$/.test(r.version ?? ""), r.version), or(SIG.test(r.signature ?? ""), r.signature), or(policy, body), or(policy, psig)].join(" "));
' 2>/dev/null
}

# what holds an update back now (server/routes/updates.ts): nothing when idle, else the hold codes, or "unknown" when the
# running server does not say
server_holds() {
  _code=$(curl -sS -m 10 -o "$TMP/busy" -w '%{http_code}' "http://127.0.0.1:$PORT/api/updates/busy" 2>/dev/null) && _rc=0 || _rc=$?
  [ "$_rc" = 0 ] && [ "$_code" = 200 ] || { echo unknown; return 0; }
  "$NODE_BIN" -e 'try { const b = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).busy; if (!Array.isArray(b)) throw 0; console.log(b.filter((c) => /^[a-z-]{1,30}$/.test(c)).join(" ")); } catch { console.log("unknown"); }' "$TMP/busy"
}
# whether the server may be restarted now: "go" when it is running and idle, or failed or stuck starting (nothing runs
# there, and the update may well fix it); else why not. a server someone stopped stays stopped
restart_allowed() {
  _state=$(systemctl is-active duskbot.service 2>/dev/null) || true
  case "$_state" in
    active) _holds=$(server_holds); [ -n "$_holds" ] && echo "$_holds" || echo go ;;
    failed|activating) echo go ;;
    *) echo "stopped (${_state:-unknown})" ;;
  esac
}
# right before a restart: waits up to UPDATE_RESTART_WAIT seconds in short steps for the server to fall idle
restart_wait() {
  _waited=0
  while :; do
    _why=$(restart_allowed)
    [ "$_why" != go ] || return 0
    [ "$_waited" -lt "${UPDATE_RESTART_WAIT:-300}" ] || { echo "$(date -u '+%F %T') the restart waits for the next round: $_why"; return 1; }
    sleep 15; _waited=$((_waited + 15))
  done
}

# `sh install.sh --update-server` (root, from duskbot-server-update.timer): the staged build, read as the link account
# and checked again in root's own folder (hash, a pinned signature: this path takes signed builds only, policy, never
# older, never one that failed here), installed only while no bot is working, then the server restarts (only while it
# is still idle) and must answer and pass its self-test, or the build before goes back (update_settle)
update_server() {
  [ "$(id -u)" -eq 0 ] || { echo "--update-server runs as root"; return 1; }
  if command -v flock >/dev/null 2>&1; then exec 9>>"$INSTALL_LOCK"; flock -n 9 || { echo "an install is running; the update waits for the next round"; return 0; }; LOCKED=1; fi
  [ -f "$STATE/linked" ] || return 0
  heal_gate
  TMP=$(mktemp -d) LINK_ID=$(state_get id) VPS_TOKEN="" OFFLINE=0 REQUIRE_SIGNED=1
  PROGRESS="$TMP/progress"
  trap 'rm -rf "$TMP"' EXIT
  # a round that installed but did not restart yet, or was cut off part way (power, a stop): its restart and settle first
  if [ -n "$(state_get app-installing)" ] || { [ -n "$(state_get update-pending)$(state_get running-package)" ] && [ "$(state_get running-package)" != "$(state_get package)" ]; }; then
    restart_wait || return 0
    restart_settle; return
  fi
  # the gate the running build carries, once per build and while idle: an updater from before refresh_gate installed it
  _running=$(state_get running-package | sed 's/^sha256://')
  if [ -n "$_running" ] && [ "$(state_get gate-from)" != "$_running" ] && [ -f "$PKGS/duskbot-$_running.tgz" ] && [ "$(restart_allowed)" = go ]; then
    refresh_gate "$PKGS/duskbot-$_running.tgz"; state_set gate-from "$_running"
  fi
  offer=$(staged_offer) || return 0
  set -f; set -- $offer; set +f
  [ "$#" = 6 ] || return 0
  dash() { [ "$1" = - ] && echo "" || echo "$1"; }
  PKG_SHA=$1 PKG_SIZE=$2 PKG_VERSION=$(dash "$3") PKG_SIG=$(dash "$4") POLICY_BODY=$(dash "$5") POLICY_SIG=$(dash "$6")
  [ "$(state_get package)" != "sha256:$PKG_SHA" ] || return 0
  [ "$(state_get server-update-refused)" != "$PKG_SHA" ] || return 0
  why=$(restart_allowed)
  if [ "$why" != go ]; then echo "$(date -u '+%F %T') build ${PKG_VERSION:-$PKG_SHA} waits: $why"; return 0; fi
  echo "$(date -u '+%F %T') installing build ${PKG_VERSION:-$PKG_SHA}"
  # root's own copy, read as the link account (its folder is that account's), capped at the size it said
  [ -d "$PKGS" ] && [ ! -L "$PKGS" ] || install -d -o root -g root -m 0700 "$PKGS"
  _f="$PKGS/duskbot-$PKG_SHA.tgz"
  as_link head -c "$PKG_SIZE" "$SERVER_RELEASE/$PKG_SHA.tgz" > "$_f.tmp" 2>/dev/null || { rm -f "$_f.tmp"; echo "the staged build is gone"; return 0; }
  if [ "$(sha256sum "$_f.tmp" | cut -d' ' -f1)" != "$PKG_SHA" ]; then echo "the staged build does not match its hash"; rm -f "$_f.tmp"; return 0; fi
  mv -f "$_f.tmp" "$_f"
  before=$(state_get package)
  set +e; ( set -e; do_app ); _rc=$?; set -e
  if [ "$(state_get package)" = "$before" ] && [ -z "$(state_get app-installing)" ]; then
    # not taken (older, blocked, unsigned, failed here before): not offered to npm again; anything else retries next round
    [ "$_rc" != 0 ] || state_set server-update-refused "$PKG_SHA"
    return 0
  fi
  if [ "$_rc" = 0 ]; then refresh_updater "$_f"; refresh_gate "$_f"; put_command >/dev/null 2>&1 || true; fi
  restart_wait || return 0
  restart_settle
}
# the server restarted on what is installed now, then settled: kept when it answers and passes its self-test, else the
# build before goes back. an npm install cut off part way is finished first
restart_settle() {
  if [ -n "$(state_get app-installing)" ]; then
    set +e; ( set -e; finish_interrupted ); _rc=$?; set -e
    [ "$_rc" = 0 ] || [ -z "$(state_get update-pending)" ] || { update_settle 0 || true; return 1; }
  fi
  x systemctl restart duskbot.service
  if wait_health "http://127.0.0.1:$PORT/api/health" 120; then
    if update_settle 1; then state_set running-package "$(state_get package)"; return 0; fi
    return 1
  fi
  echo "the server did not answer on 127.0.0.1:$PORT within two minutes"
  if update_settle 0; then state_set running-package "$(state_get package)"; return 0; fi
  return 1
}

# ---------- session ----------
claim() {
  arch=$(dpkg --print-architecture 2>/dev/null || uname -m)
  # shellcheck disable=SC1091
  os=$([ -r /etc/os-release ] && . /etc/os-release && echo "${ID:-unknown}-${VERSION_ID:-}") || os=unknown
  n=0
  while :; do
    status=$(ncurl -sS --proto "$PROTO" --proto-redir "$PROTO" -m 20 -o "$TMP/claim" -w '%{http_code}' -X POST -H "authorization: Bearer $VPS_TOKEN" \
      -H "content-type: application/json" --data "{\"host\":{\"arch\":\"$arch\",\"os\":\"$os\"}}" \
      "$LINK_BASE/v1/sessions/$LINK_ID/claim" 2>/dev/null) && rc=0 || { rc=$?; status=000; }
    case "$status" in 000|5*) ;; *) break ;; esac
    n=$((n + 1))
    if [ "$n" -ge 5 ]; then
      # curl 60: the certificate check failed, which a clock far off the real time does to every https site (35 is any
      # broken handshake, a flaky network path among them, so it gets the plain words)
      case "$rc" in
        60) fail_line "Can't check the link service's certificate. This server's clock says $(date -u '+%Y-%m-%d %H:%M UTC'); if that is wrong, run: timedatectl set-ntp true, then paste the line again." ;;
        *) fail_line "Can't reach the link service. Check this server's internet connection and paste the line again." ;;
      esac
      exit 1
    fi
    ! net_error "$rc" || flip_family
    case "$n" in 1) sleep 2 ;; 2) sleep 5 ;; 3) sleep 10 ;; *) sleep 20 ;; esac
  done
  case "$status" in
    200)
      state_set id "$LINK_ID"
      PKG_SHA=$(sed -n 's/.*"package":{[^}]*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$TMP/claim" | head -n 1)
      PKG_SIZE=$(sed -n 's/.*"package":{[^}]*"size":\([0-9]\{1,12\}\).*/\1/p' "$TMP/claim" | head -n 1)
      PKG_VERSION=$(sed -n 's/.*"package":{[^}]*"version":"\([0-9A-Za-z.+-]\{1,40\}\)".*/\1/p' "$TMP/claim" | head -n 1)
      PKG_SIG=$(sed -n 's/.*"package":{[^}]*"signature":"\(r1\.[a-z0-9-]\{1,32\}\.[A-Za-z0-9_-]\{1,\}\.[A-Za-z0-9_-]\{40,\}\)".*/\1/p' "$TMP/claim" | head -n 1)
      POLICY_BODY=$(sed -n 's/.*"policy":{"body":"\([A-Za-z0-9_-]\{1,\}\)","signature":"\(r1\.[A-Za-z0-9._-]\{1,\}\)"}.*/\1/p' "$TMP/claim" | head -n 1)
      POLICY_SIG=$(sed -n 's/.*"policy":{"body":"\([A-Za-z0-9_-]\{1,\}\)","signature":"\(r1\.[A-Za-z0-9._-]\{1,\}\)"}.*/\2/p' "$TMP/claim" | head -n 1)
      PKG_SIZE=${PKG_SIZE:-0}
      KIT_SHA=$(sed -n 's/.*"desktop":{[^}]*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p' "$TMP/claim" | head -n 1)
      KIT_SIZE=$(sed -n 's/.*"desktop":{[^}]*"size":\([0-9]\{1,12\}\).*/\1/p' "$TMP/claim" | head -n 1)
      KIT_SIZE=${KIT_SIZE:-0}
      image=$(sed -n 's/.*"desktop":{[^}]*"image":"\([A-Za-z0-9._/:-]\{1,200\}\)".*/\1/p' "$TMP/claim" | head -n 1)
      [ -n "$BOT_DESKTOP_IMAGE" ] || BOT_DESKTOP_IMAGE=$image
      # a tunnel the service made for this server on its own Cloudflare account: what --cloudflare uses, when there is one
      _cft=$(sed -n 's/.*"cloudflare":{[^}]*"token":"\([A-Za-z0-9_=.-]\{20,2000\}\)".*/\1/p' "$TMP/claim" | head -n 1)
      _cfh=$(sed -n 's/.*"cloudflare":{[^}]*"hostname":"\([a-z0-9.-]\{4,253\}\)".*/\1/p' "$TMP/claim" | head -n 1)
      if [ "$WANT" = cloudflare ] && [ -z "$CF_TOKEN" ] && [ -n "$_cft" ] && [ -n "$_cfh" ]; then CF_TOKEN=$_cft CF_HOST=$_cfh; fi ;;
    410|404)
      # linked at the service, but this run stopped before it noted that (or the result's answer was lost)
      if [ -z "$(state_get linked)" ] && [ "$status" = 410 ] && grep -q '"code":"used"' "$TMP/claim" && [ "$(state_get id)" = "$LINK_ID" ] && [ "$(tunnel_id)" = "$LINK_ID" ]; then
        state_set linked "$LINK_ID"
      fi
      if [ -n "$(state_get linked)" ]; then
        OFFLINE=1
        [ -n "$BOT_DESKTOP_IMAGE" ] || BOT_DESKTOP_IMAGE=$(state_get desktop-image)
        return 0
      fi
      if [ "$status" = 410 ]; then fail_line "This line was already used. Make a new one in the app."; else fail_line "This command expired. Make a new one in the app."; fi
      exit 1 ;;

    401) fail_line "This line doesn't match. Copy it again from the app."; exit 1 ;;
    *) fail_line "The link service said no ($status). Make a new line in the app and try again."; exit 1 ;;
  esac
}

tunnel_id() { sed -n 's/^{"v":1,"base":"[^"]*","id":"\([a-z2-7]\{10\}\)".*/\1/p' "$LINK_HOME/.config/duskbot-link/tunnel.json" 2>/dev/null | head -n 1; }

on_exit() {
  [ "$UI" = tty ] && printf '%s[?25h' "$ESC"
  rm -rf "$TMP"
}
# the ssh connection dropped: the install goes on to the end, reporting to the app as before, and what it would have
# printed goes to its log
on_hangup() {
  trap '' HUP
  exec >>"$LOGS/install.log" 2>&1 </dev/null
  UI=plain LIST=0 R="" BOLD="" DIM="" OK="" ACC="" WARN="" ERR="" SHADOW="" FAINT="" EL=""
}
# one install, repair or uninstall at a time (uninstall.sh takes the same lock); the steps' processes inherit it, so a
# step still running after its terminal went away keeps it too
take_lock() {
  [ -z "${LOCKED:-}" ] || return 0
  command -v flock >/dev/null 2>&1 && ( : >>"$INSTALL_LOCK" ) 2>/dev/null || return 0
  exec 9>>"$INSTALL_LOCK"
  flock -n 9 && LOCKED=1 && return 0
  fail_line "Someone is already installing or removing Metal on this server (another terminal, or one whose connection dropped). Wait for it to finish, then paste the line again. Its logs: $LOGS/"
  exit 1
}
on_stop() {
  trap '' INT TERM
  _children=$(ps -eo pid=,ppid= | awk -v root="$$" '{ parent[$1]=$2 } END { for (pid in parent) { nextpid=pid; for (n=0;n<100 && nextpid in parent;n++) { if (parent[nextpid]==root) { print pid; break; } nextpid=parent[nextpid]; } } }')
  [ -z "$_children" ] || kill -TERM $_children 2>/dev/null || true
  _pending=$_children _round=0
  while [ -n "$_pending" ] && [ "$_round" -lt 10 ]; do
    _alive=""
    for _pid in $_pending; do kill -0 "$_pid" 2>/dev/null && _alive="$_alive $_pid"; done
    _pending=$_alive
    [ -z "$_pending" ] || sleep 0.1
    _round=$((_round + 1))
  done
  [ -z "$_pending" ] || kill -KILL $_pending 2>/dev/null || true
  if [ -f "$TMP/cancelled" ]; then
    printf '\n\n  Setup was cancelled in the app. Installed files were kept. Make a new command in the app to resume.\n\n'
  else
    printf '\n\n  Stopped. Paste the line again; it picks up where it stopped.\n\n'
  fi
  exit 130
}

intro() {
  if [ -n "$DEMO" ]; then SYS="Ubuntu 24.04.3 LTS" ARCH=arm64; else
    # shellcheck disable=SC1091
    SYS=$([ -r /etc/os-release ] && . /etc/os-release && printf '%s' "${PRETTY_NAME:-${ID:-linux}}") || SYS=linux
    ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
  fi
  who="session ${LINK_ID}"
  glyph sep
  _line="$who $G $NAME $G $SYS $ARCH"
  # the link address only when it fits (byte length, so a little conservative)
  [ $((${#_line} + ${#LINK_BASE} + 4)) -le "$COLS" ] && _line="$_line $G ${LINK_BASE#*://}"
  printf '  %s%s%s\n' "$DIM" "$_line" "$R"
  say ""
}

bad_option() { printf '%s\n' "$1" >&2; exit 1; }
# how the app reaches this server, from `| sh -s -- --cloudflare` and the like (none: the relay). a run without one keeps
# the way chosen before.
# the way again, for root's run of this script (its keys and tokens go in the environment, never on a command line)
way_args() {
  case "$ARGS_WANT" in
    "") ;;
    *) printf -- '--%s' "$ARGS_WANT" ;;
  esac
}
# an old line's way that is no longer offered: said once, then a Cloudflare tunnel instead (unless the line names a way)
gone_way() { printf '%s is no longer offered; using a Cloudflare tunnel instead.\n' "$1" >&2; GONE=1; }
parse_ways() { # the line's arguments (the token first, when it is not baked in)
  [ "$BAKED_TOKEN" != "$PLACEHOLDER_TOKEN" ] || { [ $# -eq 0 ] || shift; }
  GONE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --relay) WANT=relay ;;
      --ssh) WANT=ssh ;;
      --tailscale) WANT=tailscale ;;
      --cloudflare) WANT=cloudflare ;;
      --direct) gone_way "--direct" ;;
      --domain|--cloudflare-token) gone_way "$1"; case "${2:-}" in ""|-*) ;; *) shift ;; esac ;;
      --domain=*) gone_way "--domain" ;;
      --tailscale-key) [ $# -ge 2 ] || bad_option "--tailscale-key needs an auth key"; TS_KEY=$2; WANT=tailscale; shift ;;
      *) bad_option "Unknown option $1. Copy the whole line from the app again." ;;
    esac
    shift
  done
  [ -z "$GONE" ] || [ -n "$WANT" ] || WANT=cloudflare
  ARGS_WANT=$WANT
}


main() {
  if [ "$TOKEN" = "--update-server" ]; then update_server; return; fi
  parse_ways "$@"
  if [ -n "$DEMO" ]; then
    TOKEN="demodemoab-$(printf '%026d' 0 | tr 0 a)"
  fi
  # a server set up before the rename moves to the new names before anything here reads them
  if [ -z "$DEMO" ] && [ "$(id -u)" -eq 0 ]; then take_lock; MIGRATED=$(migrate_legacy 2>&1) || true; fi
  # `sh install.sh --repair` as root: an install that is already linked, checked and brought up to date without a line
  if [ "$TOKEN" = "--repair" ]; then
    [ "$(id -u)" -eq 0 ] || become_root
    [ -f "$STATE/linked" ] && [ -f "$STATE/id" ] || { fail_line "--repair needs an install that is already linked. Paste a line from the app instead."; exit 1; }
    TOKEN="$(cat "$STATE/id")-$(printf '%026d' 0 | tr 0 a)"
    REPAIR=1
  fi
  case "$TOKEN" in
    [a-z2-7][a-z2-7][a-z2-7][a-z2-7][a-z2-7][a-z2-7][a-z2-7][a-z2-7][a-z2-7][a-z2-7]-*) ;;
    *) fail_line "This line is missing its code. Copy the whole line from the app."; exit 1 ;;
  esac
  LINK_ID=${TOKEN%%-*}
  SECRET=${TOKEN#*-}
  if [ "${#SECRET}" -ne 26 ] || printf '%s' "$SECRET" | grep -q '[^a-z2-7]'; then
    fail_line "This line is missing its code. Copy the whole line from the app."; exit 1
  fi
  [ -n "$DEMO" ] || become_root
  [ -n "$DEMO" ] || take_lock
  umask 022
  TMP=$(mktemp -d)
  PROGRESS="$TMP/progress"
  if [ -n "$DEMO" ]; then STATE="$TMP/state" LOGS="$TMP/logs" LINK_BASE="https://link.dusk.bot"; fi
  install -d -m 0700 "$STATE"
  install -d -m 0700 "$LOGS"
  [ -z "${MIGRATED:-}" ] || printf '%s\n' "$MIGRATED" >> "$LOGS/migrate.log"
  ui_init
  trap on_exit EXIT
  trap on_stop INT TERM
  trap on_hangup HUP
  [ "$UI" = tty ] && printf '%s[?25l' "$ESC"
  if [ -z "$DEMO" ]; then
    command -v curl >/dev/null 2>&1 || apt_install curl ca-certificates </dev/null >/dev/null
    VPS_TOKEN=$(printf '%s' "omb-link-v1|vps|$SECRET" | sha256sum | cut -d' ' -f1)
    NAME=$(hostname -s 2>/dev/null | tr -cd 'A-Za-z0-9.-' | cut -c1-40)
  else
    VPS_TOKEN="" NAME=oracle-arm
  fi
  [ -n "$NAME" ] || NAME=vps
  RUN_T0=$(now_ms)

  banner
  if [ "$REPAIR" = 1 ]; then
    OFFLINE=1
    [ -n "$BOT_DESKTOP_IMAGE" ] || BOT_DESKTOP_IMAGE=$(state_get desktop-image)
  elif [ -z "$DEMO" ]; then claim; fi
  intro
  if [ "$OFFLINE" = 1 ]; then printf '  %sThis server is already linked. Checking everything is up to date.%s\n\n' "$DIM" "$R"; BELOW_TAG=5; fi
  checklist

  phase prepare; step check do_check; step basics do_basics; step docker do_docker; step user do_user; phase_end
  phase runtime; step node do_node; phase_end
  phase omb; step app do_app; step engines do_engines; step service do_service; phase_end
  [ -n "$DEMO" ] || put_command >>"$LOGS/command.log" 2>&1 || true
  phase computer; step sandbox do_sandbox; step fence do_fence; step desktop do_desktop; phase_end
  phase link; step address do_address
  if [ "$OFFLINE" = 1 ]; then
    [ ! -f "$AGENT" ] || start_link_service >>"$LOGS/link.log" 2>&1
    PH_NOTE="already linked"
  else
    step link do_link
  fi
  phase_end
  finale
}

main "$@"
