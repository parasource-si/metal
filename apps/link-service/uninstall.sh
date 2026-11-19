#!/bin/sh
# duskbot vps uninstaller: takes off this server everything apps/link-service/install.sh put on it, so the install line
# can be pasted again on a clean box.
#   curl -fsSL https://link.dusk.bot/uninstall | sh                 shows what it removes, asks on the terminal
#   curl -fsSL https://link.dusk.bot/uninstall | sh -s -- --yes     no question (also DUSK_UNINSTALL_YES=1)
# flags: --yes, --no-backup (no tarball of the bots' data first), --all (also the packages install.sh added, from its
# manifest), --dry-run (only show what it would remove). with no terminal to ask on and no --yes it only shows.
# safe to run again, and when nothing or only part is installed: every step looks before it removes.
# knobs (env): LINK_BASE; NO_COLOR, DUSK_ASCII=1, DUSK_PLAIN=1, DUSK_NO_ANIM=1 (terminal).
set -eu

PLACEHOLDER_BASE="__LINK""_BASE__"
BAKED_BASE="__LINK_BASE__"
if [ -z "${LINK_BASE:-}" ]; then
  if [ "$BAKED_BASE" = "$PLACEHOLDER_BASE" ]; then LINK_BASE="https://link.dusk.bot"; else LINK_BASE="$BAKED_BASE"; fi
fi
LINK_BASE=${LINK_BASE%/}

SVC_USER=dusk
SVC_HOME=/home/dusk
DATA=$SVC_HOME/.duskbot
STATE=/var/lib/duskbot-link
LOGS_DIR=/var/log/duskbot-link
OPT=/opt/duskbot-link
MANIFEST=/var/lib/duskbot/install-manifest
FENCE=/usr/local/sbin/omb-host-fence
CLI=/usr/local/bin/duskbot
UNITS=/etc/systemd/system
OUR_UNITS="duskbot-server-update.timer duskbot-server-update.service duskbot-link.service duskbot-cloudflared.service duskbot.service duskbot-engines.path duskbot-restart.service duskbot-handoff.service omb-docker-gate.service omb-box-fence.service"
# the accounts install.sh splits the server into (link agent, docker gate) and their files
LINK_USER=omb-link
LINK_HOME=/var/lib/omb-link
GATE_USER=omb-docker
GATE_GROUP=omb-dockergate
LIB=/usr/local/lib/duskbot
ETC=/etc/duskbot
BWRAP_PROFILE=/etc/apparmor.d/duskbot-bwrap
NETWORK=openmausbot-desktops
BRIDGE=omb-desk0
DAEMON=/etc/docker/daemon.json
CADDY_NAME=duskbot
LINK_CONF=duskbot-link
# a server set up before the rename and not installed again since keeps the old names (install.sh moves them)
OLD=openmausbot
if ! id "$SVC_USER" >/dev/null 2>&1 && id maus >/dev/null 2>&1; then SVC_USER=maus SVC_HOME=/home/maus DATA=/home/maus/.duskbot; fi
if [ ! -d "$STATE" ] && { [ -d "/var/lib/$OLD-link" ] || [ -e "$UNITS/$OLD.service" ]; }; then
  DATA=$SVC_HOME/.$OLD STATE=/var/lib/$OLD-link LOGS_DIR=/var/log/$OLD-link OPT=/opt/$OLD-link MANIFEST=/var/lib/$OLD/install-manifest
  OUR_UNITS="$OLD-link.service $OLD.service $OLD-engines.path $OLD-restart.service $OLD-handoff.service omb-docker-gate.service omb-box-fence.service"
  LIB=/usr/local/lib/$OLD ETC=/etc/$OLD BWRAP_PROFILE=/etc/apparmor.d/$OLD-bwrap CADDY_NAME=$OLD LINK_CONF=$OLD-link
fi
# kept even with --all: the line to install again needs them
KEEP_PKGS="curl ca-certificates"
export DEBIAN_FRONTEND=noninteractive

YES=0 BACKUP=1 ALL=0 DRY=0
[ "${DUSK_UNINSTALL_YES:-}" = 1 ] && YES=1
ARGS="$*"
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --no-backup) BACKUP=0 ;;
    --all) ALL=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) printf '%s\n' "usage: curl -fsSL $LINK_BASE/uninstall | sh [-s -- options]" "  --yes        remove without asking (or DUSK_UNINSTALL_YES=1)" \
      "  --no-backup  don't save the bots' data to /root first" "  --all        also remove the packages the install added (Docker, Node, Caddy, gVisor)" \
      "  --dry-run    only show what it would remove"; exit 0 ;;
    *) printf 'unknown option: %s (try --yes, --no-backup, --all, --dry-run)\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

# ---------- terminal (same look as install.sh) ----------
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
fmt_ms() {
  if [ "$1" -lt 10000 ] && [ "$MS" = 1 ]; then printf '%d.%ds' $(($1 / 1000)) $(($1 % 1000 / 100))
  elif [ "$1" -lt 60000 ]; then printf '%ds' $(($1 / 1000))
  else printf '%dm %02ds' $(($1 / 60000)) $(($1 % 60000 / 1000)); fi
}
glyph() {
  if [ "$ASCII" = 1 ]; then
    case "$1" in ok) G="+" ;; sep) G="-" ;; fail) G="x" ;; skip) G="o" ;; wait) G="." ;; arrow) G=">" ;; bar) G="|" ;; dot) G="-" ;; esac
  else
    case "$1" in ok) G="✔" ;; sep) G="·" ;; fail) G="✖" ;; skip) G="○" ;; wait) G="·" ;; arrow) G="→" ;; bar) G="│" ;; dot) G="·" ;; esac
  fi
}
spin_frame() {
  if [ "$ASCII" = 1 ]; then
    case $(($1 % 4)) in 0) G="|" ;; 1) G="/" ;; 2) G="-" ;; *) G="\\" ;; esac
    return 0
  fi
  case $(($1 % 10)) in
    0) G="⠋" ;; 1) G="⠙" ;; 2) G="⠹" ;; 3) G="⠸" ;; 4) G="⠼" ;; 5) G="⠴" ;; 6) G="⠦" ;; 7) G="⠧" ;; 8) G="⠇" ;; *) G="⠏" ;;
  esac
}
spin_color() {
  case "$DEPTH" in
    24) case $(($1 / 2 % 6)) in 0) SC="${ESC}[38;2;40;255;150m" ;; 1|5) SC="${ESC}[38;2;0;230;210m" ;; 2|4) SC="${ESC}[38;2;0;200;255m" ;; *) SC="${ESC}[38;2;170;120;255m" ;; esac ;;
    8) case $(($1 / 2 % 6)) in 0) SC="${ESC}[38;5;48m" ;; 1|5) SC="${ESC}[38;5;44m" ;; 2|4) SC="${ESC}[38;5;45m" ;; *) SC="${ESC}[38;5;141m" ;; esac ;;
    *) SC=$ACC ;;
  esac
}

banner_art() {
  cat <<'EOF'
######b   ##    ##   b######  ##   b#p     ######b    b####b   ########
##    ##  ##    ##  ##        ##  b#p      ##    ##  ##    ##     ##
##    ##  ##    ##   p####b   #####        #######   ##    ##     ##
##    ##  ##    ##        ##  ##  p#b      ##    ##  ##    ##     ##
######p    p####p   ######p   ##   p#b     ######p    p####p      ##
EOF
}
# the install's wordmark, drawn once with its light sweep (no decode: this is the way out)
banner() {
  say ""
  if [ "$UI" != tty ] || [ "$ASCII" = 1 ] || [ "$COLS" -lt 80 ]; then
    say "  ${ACC}${BOLD}Metal${R}  ${DIM}uninstall${R}"
    say ""
    MASCOT=0
    return 0
  fi
  anim=0; [ "$DEPTH" -ge 8 ] && [ "${DUSK_NO_ANIM:-}" != 1 ] && anim=1
  banner_art | awk -v depth="$DEPTH" -v esc="$ESC" -v shade="$SHADOW" -v reset="$R" -v anim="$anim" '
    function lerp(a, b, t) { return int(a + (b - a) * t + 0.5) }
    function code(r, g, b) {
      if (depth == 24) return esc "[38;2;" r ";" g ";" b "m"
      if (depth == 8) return esc "[38;5;" (16 + 36 * int(r / 51 + 0.5) + 6 * int(g / 51 + 0.5) + int(b / 51 + 0.5)) "m"
      if (depth == 4) return esc "[1;36m"
      return ""
    }
    function paint(x, y, light,   t, s, r, g, b) {
      t = (x + y * 3) / (w + rows * 3)
      if (t < 0.5) { s = t * 2; r = lerp(40, 0, s); g = lerp(255, 200, s); b = lerp(150, 255, s) }
      else { s = (t - 0.5) * 2; r = lerp(0, 190, s); g = lerp(200, 110, s); b = lerp(255, 255, s) }
      if (light > 0) { r = lerp(r, 255, light); g = lerp(g, 255, light); b = lerp(b, 255, light) }
      return code(r, g, b)
    }
    function frame(f,   y, x, c, p, k, out, last, glyph, d, center) {
      if (f > 0) printf "%s[%dA", esc, rows
      center = f / (S - 1) * (w + 24) - 12
      for (y = 1; y <= rows; y++) {
        out = "\r  "; last = ""
        for (x = 1; x <= w + 1; x++) {
          c = (y <= NR) ? substr(art[y], x, 1) : " "
          p = (y > 1 && x > 1) ? substr(art[y - 1], x - 1, 1) : " "
          if (c == "#" || c == "p" || c == "b") {
            glyph = (c == "#" ? "█" : (c == "p" ? "▀" : "▄"))
            if (f < S) { d = x + y * 2 - center; if (d < 0) d = -d; k = paint(x, y, d < 4 ? (1 - d / 4) * 0.85 : 0) }
            else k = paint(x, y, 0)
            if (k != last) { out = out k; last = k }
            out = out glyph
          } else if (p == "#") {
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
      rows = NR + 1; S = 9
      if (!anim) { frame(S); exit }
      for (f = 0; f <= S; f++) { frame(f); if (f < S) system("sleep 0.05") }
    }'
  say ""
  printf '  %s%-58s%s%s<:3 )~%s\n' "$DIM" "taking Metal off this server" "$R" "$ACC" "$R"
  MASCOT_COL=61 MASCOT=1
  [ "$DEPTH" -gt 0 ] || MASCOT=0
  say ""
}

BELOW_TAG=3
mascot() { # tick
  [ "$MASCOT" = 1 ] && [ "$LIST" = 1 ] || return 0
  case $(($1 / 4 % 10)) in
    1|7) _m="<:3 )-" ;; 3) _m="<:3 )_" ;; 5) _m="<.3 )~" ;; 9) _m="<:3 )-" ;; *) _m="<:3 )~" ;;
  esac
  _up=$((BELOW_TAG + 1 + PH_IDX))
  printf '%s[%dA%s[%dG%s%s%s%s[%dB\r' "$ESC" "$_up" "$ESC" "$MASCOT_COL" "$ACC" "$_m" "$R" "$ESC" "$_up"
}

TW=32
draw() { # glyph-color glyph time extra
  printf '\r  %s%s%s %s %s%6s%s  %s%s' "$1" "$2" "$R" "$TPAD" "$DIM" "$3" "$R" "$4" "$EL"
}
pending_line() { glyph wait; printf '\r  %s%s %s%s%s\n' "$DIM" "$G" "$(phase_title "$1")" "$R" "$EL"; }

watch_step() {
  _i=${TICKS:-0} _tail=""
  _tw=$((COLS - TW - 16 - ${#SUBTXT} - 2))
  while [ ! -f "$TMP/rc" ]; do
    _el=$(fmt_ms $(($(now_ms) - PH_T0)))
    X=""
    if [ "$_tw" -gt 10 ]; then
      [ $((_i % 3)) -eq 0 ] && _tail=$(tail -n 1 "$LOG" 2>/dev/null | tr -cd '\40-\176' | cut -c1-"$_tw")
      X="${FAINT}${_tail}${R}"
    fi
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
    printf '\nPlease run this as root (or install sudo), then paste the line again.\n' >&2
    exit 1
  fi
  say "Asking for administrator rights..."
  # shellcheck disable=SC2086
  if [ -r "$0" ] && [ "${0##*/}" != "sh" ] && [ "${0##*/}" != "dash" ]; then
    exec sudo env LINK_BASE="$LINK_BASE" DUSK_UNINSTALL_YES="${DUSK_UNINSTALL_YES:-}" COLORTERM="${COLORTERM:-}" NO_COLOR="${NO_COLOR:-}" \
      DUSK_ASCII="${DUSK_ASCII:-}" DUSK_PLAIN="${DUSK_PLAIN:-}" DUSK_NO_ANIM="${DUSK_NO_ANIM:-}" sh "$0" $ARGS
  fi
  # piped: the script is gone from stdin, so fetch it again for root
  # shellcheck disable=SC2086
  curl -fsSL --retry 3 "$LINK_BASE/uninstall" | sudo env LINK_BASE="$LINK_BASE" DUSK_UNINSTALL_YES="${DUSK_UNINSTALL_YES:-}" \
    COLORTERM="${COLORTERM:-}" NO_COLOR="${NO_COLOR:-}" DUSK_ASCII="${DUSK_ASCII:-}" DUSK_PLAIN="${DUSK_PLAIN:-}" DUSK_NO_ANIM="${DUSK_NO_ANIM:-}" sh -s -- $ARGS
  exit $?
}

# ---------- what is here ----------
show() { printf '$ %s\n' "$*"; }
x() { show "$@"; "$@"; }
state_get() { [ -f "$STATE/$1" ] && cat "$STATE/$1" || true; }
manifest() { [ -f "$MANIFEST" ] && sed -n "s/^$1 //p" "$MANIFEST" || true; }
in_manifest() { [ -f "$MANIFEST" ] && grep -qxF "$1" "$MANIFEST"; }
docker_up() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

our_units() {
  for _u in $OUR_UNITS; do
    if [ -f "$UNITS/$_u" ] || systemctl list-units --all --no-legend "$_u" 2>/dev/null | grep -q .; then printf '%s\n' "$_u"; fi
  done
}
our_containers() {
  { for _l in com.openmausbot.bot-desktop com.openmausbot.vps com.openmausbot.cua-driver com.openmausbot.container; do
      docker ps -aq --no-trunc --filter "label=$_l"
    done
    docker ps -a --no-trunc --format '{{.ID}} {{.Names}}' | awk '$2 ~ /^duskbot-/ { print $1 }'
  } 2>/dev/null | sort -u
}
our_volumes() {
  { docker volume ls -q --filter label=com.openmausbot.vps; docker volume ls -q | grep '^openmausbot-'; } 2>/dev/null | sort -u
}
our_networks() {
  { docker network ls -q --no-trunc --filter label=com.openmausbot.vps-network
    docker network ls --no-trunc --format '{{.ID}} {{.Name}}' | awk -v n="$NETWORK" '$2 == n { print $1 }'
  } 2>/dev/null | sort -u
}
our_images() {
  { for _l in com.openmausbot.bot-desktop com.openmausbot.cua-base com.openmausbot.image-layer; do docker images -q --no-trunc --filter "label=$_l"; done
    docker images --no-trunc --format '{{.Repository}} {{.ID}}' |
      awk '$1 ~ /^(ghcr\.io\/duskbotai\/dusk-desktop|ghcr\.io\/duskbotai\/bot-desktop|ghcr\.io\/sidddevz\/omb-bot-desktop|omb-bot-desktop|(docker\.io\/)?trycua\/xfce-cua)$/ { print $2 }'
    _img=$(state_get desktop-image)
    [ -n "$_img" ] && docker image inspect -f '{{.Id}}' "$_img"
  } 2>/dev/null | sort -u
}
fence_rules() { { iptables -w 10 -S; iptables -w 10 -S DOCKER-USER; } 2>/dev/null | grep -c 'OMB-BOX' || true; }
# our keys in daemon.json: the backup install.sh made, or gVisor/userns lines it wrote (the manifest, or our signature)
daemon_ours() {
  [ -f "$DAEMON.omb-before" ] && return 0
  [ -f "$DAEMON" ] || return 1
  in_manifest "daemon-key gvisor" && grep -q '"runsc"' "$DAEMON" && return 0
  in_manifest "daemon-key userns" && grep -q '"userns-remap"' "$DAEMON" && return 0
  grep -q -- '--overlay2=none' "$DAEMON" && grep -q '"/usr/bin/runsc"' "$DAEMON"
}
caddy_ours() { [ -f /etc/caddy/$CADDY_NAME.caddy ] || grep -qs "$CADDY_NAME" /etc/caddy/Caddyfile; }
our_paths() {
  for _p in "$OPT" "$LOGS_DIR" "$STATE" "$FENCE" "$DAEMON.omb-before" /etc/caddy/$CADDY_NAME.caddy "$SVC_HOME" "$LINK_HOME" "$LIB" "$ETC" "$BWRAP_PROFILE"; do
    [ -e "$_p" ] && printf '%s\n' "$_p"
  done
  for _u in $OUR_UNITS; do [ -e "$UNITS/$_u" ] && printf '%s\n' "$UNITS/$_u"; done
  for _p in "$CLI" "${CLI%/*}/metal"; do cli_ours "$_p" && printf '%s\n' "$_p"; done
  return 0
}
cli_ours() { [ ! -L "$1" ] && grep -qs "managed by duskbot-link" "$1"; }
# packages install.sh added that are still installed (the ones --all takes away)
our_pkgs() {
  _have=$(dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 2>/dev/null | awk '$1 ~ /^ii/ { print $2 }')
  for _p in $(manifest pkg); do
    case " $KEEP_PKGS " in *" $_p "*) continue ;; esac
    printf '%s\n' "$_have" | grep -qxF "$_p" && printf '%s\n' "$_p"
  done
  return 0
}
words() { printf '%s\n' "$1" | tr '\n' ' ' | sed 's/ *$//'; }
plural() { if [ "$1" = 1 ]; then printf '1 %s' "$2"; else printf '%s %s' "$1" "$3"; fi; }
# the names a person knows: Docker, Node, Caddy, gVisor
friendly_pkgs() {
  _out=""
  for _w in "docker.io Docker" "nodejs Node" "caddy Caddy" "runsc gVisor"; do
    printf '%s\n' "$1" | grep -qxF "${_w% *}" && _out="${_out:+$_out, }${_w#* }"
  done
  printf '%s' "${_out:-$(count "$1") packages}"
}
count() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | grep -c .; fi; }
# the few packages a person knows by name, out of the dozens apt pulled in with them
headline_pkgs() { # pkgs -> "docker.io, nodejs, caddy and 61 more"
  _named="" _n=0 _rest=0
  for _p in $1; do
    case "$_p" in
      docker.io|docker-buildx|nodejs|caddy|runsc|iptables) _named="${_named:+$_named, }$_p" ;;
      *) _rest=$((_rest + 1)) ;;
    esac
    _n=$((_n + 1))
  done
  if [ -z "$_named" ]; then printf '%d packages' "$_n"
  elif [ "$_rest" -gt 0 ]; then printf '%s and %d more' "$_named" "$_rest"
  else printf '%s' "$_named"; fi
}

survey() {
  S_UNITS=$(our_units)
  S_CONTAINERS="" S_VOLUMES="" S_NETWORKS="" S_IMAGES=""
  if docker_up; then
    S_CONTAINERS=$(our_containers) S_VOLUMES=$(our_volumes) S_NETWORKS=$(our_networks) S_IMAGES=$(our_images)
  fi
  S_FENCE=$(fence_rules)
  S_DAEMON=0; daemon_ours && S_DAEMON=1
  S_CADDY=0; caddy_ours && S_CADDY=1
  S_USER=0; id "$SVC_USER" >/dev/null 2>&1 && S_USER=1
  S_PATHS=$(our_paths)
  S_PKGS=$(our_pkgs)
  S_ANY=0
  if [ -n "$S_UNITS$S_CONTAINERS$S_VOLUMES$S_NETWORKS$S_IMAGES$S_PATHS" ] || [ "$S_FENCE" -gt 0 ] || [ "$S_DAEMON" = 1 ] || [ "$S_CADDY" = 1 ] || [ "$S_USER" = 1 ]; then S_ANY=1; fi
  if [ "$ALL" = 1 ] && { [ -n "$S_PKGS" ] || [ -n "$(manifest file)" ] || [ -f "$MANIFEST" ]; }; then S_ANY=1; fi
  return 0
}

BACKUP_FILE=""
plan() {
  glyph dot; _d=$G
  printf '  %sThis takes Metal off %s%s%s:%s\n\n' "$BOLD" "$ACC" "$NAME" "$R$BOLD" "$R"
  item() { printf '    %s%s%s %s\n' "$DIM" "$_d" "$R" "$*"; }
  [ -n "$S_UNITS" ] && item "the Metal server and its link to your app ($(count "$S_UNITS") services)"
  _nc=$(count "$S_CONTAINERS") _nv=$(count "$S_VOLUMES")
  if [ "$_nc" -gt 0 ] || [ "$_nv" -gt 0 ]; then item "$(plural "$_nc" "bot computer" "bot computers") and $(plural "$_nv" "saved home" "saved homes") of bot computers"; fi
  if [ -n "$S_IMAGES" ] && [ -n "$S_NETWORKS" ]; then item "the bot computer image and network"
  elif [ -n "$S_IMAGES" ]; then item "the bot computer image"
  elif [ -n "$S_NETWORKS" ]; then item "the bot computer network"; fi
  if [ "$S_FENCE" -gt 0 ] || [ "$S_DAEMON" = 1 ]; then item "the sandbox and network fence it added to Docker"; fi
  [ "$S_CADDY" = 1 ] && item "its Caddy site and the ports it opened"
  if [ "$S_USER" = 1 ]; then
    _size=$(du -sh "$SVC_HOME" 2>/dev/null | cut -f1)
    item "the ${BOLD}$SVC_USER${R} account and its home${_size:+, $_size} (your bots, chats and sign-ins)"
  fi
  printf '%s\n' "$S_PATHS" | grep -qv -e "^$SVC_HOME\$" -e '^$' && item "its files in /opt, /var/lib, /var/log and /etc/systemd"
  if [ "$ALL" = 1 ]; then
    if [ -n "$S_PKGS" ]; then item "the packages it installed: $(headline_pkgs "$S_PKGS")"
    elif [ ! -f "$MANIFEST" ]; then item "no record of the packages it installed, so they stay"; fi
  fi
  say ""
  if [ -d "$DATA" ] && [ "$BACKUP" = 1 ]; then
    printf '  %sYour bots are saved first, to %s%s\n' "$DIM" "$BACKUP_FILE" "$R"
  elif [ -d "$DATA" ]; then
    printf '  %s%sNo backup (--no-backup): your bots on this server are gone for good.%s\n' "$WARN" "$BOLD" "$R"
  fi
  if [ "$ALL" = 1 ] && printf '%s\n' "$S_PKGS" | grep -qxF docker.io; then
    printf '  %s%sDocker goes too, with every container and volume on this server, not only ours.%s\n' "$WARN" "$BOLD" "$R"
  fi
  if [ "$ALL" = 0 ] && [ -n "$S_PKGS" ]; then printf '  %sDocker, Node and Caddy stay. Add --all to remove them too.%s\n' "$DIM" "$R"; fi
  say ""
}

# a terminal to ask on, even under curl | sh. a subshell: a failed redirection on ":" would end the script in dash
has_tty() { (: </dev/tty) 2>/dev/null; }
# yes when --yes, else asks on the terminal (also under curl | sh); no terminal: no
confirm() {
  [ "$YES" = 1 ] && return 0
  [ "$DRY" = 1 ] && return 1
  has_tty || return 1
  [ "$UI" = tty ] && printf '%s[?25h' "$ESC"
  printf '  %sRemove all of this?%s %s[y/N]%s ' "$BOLD" "$R" "$DIM" "$R"
  read -r _answer </dev/tty || _answer=""
  [ "$UI" = tty ] && printf '%s[?25l' "$ESC"
  say ""
  case "$_answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# ---------- phases and steps ----------
PHASES="unlink stop computer home packages"
phase_title() {
  case "$1" in
    unlink) say "Unlinking from your app" ;;
    stop) say "Stopping Metal" ;;
    computer) say "Clearing the bot computers" ;;
    home) say "Removing your bots' home" ;;
    packages) say "Removing what it installed" ;;
  esac
}
step_title() {
  case "$1" in
    revoke) say "Telling the link service" ;;
    units) say "Stopping its services" ;;
    boxes) say "Removing bot computers" ;;
    fence) say "Taking down the fence" ;;
    sandbox) say "Putting Docker back" ;;
    backup) say "Saving a backup" ;;
    user) say "Removing the $SVC_USER account" ;;
    files) say "Removing its files" ;;
    caddy) say "Removing its Caddy site" ;;
    purge) say "Removing packages" ;;
  esac
}
phases_after() { _seen=0; for _s in $PHASES; do [ "$_seen" = 1 ] && printf '%s ' "$_s"; [ "$_s" = "$1" ] && _seen=1; done; return 0; }

checklist() {
  [ "$UI" = tty ] || return 0
  [ "$ROWS" -ge 26 ] || return 0
  LIST=1
  for _s in $PHASES; do pending_line "$_s"; done
  printf '%s[%dA' "$ESC" 5
}

PH_ID="" PH_IDX=0 PH_NOTE="" PH_WARN="" PH_SKIP="" PH_DID=0
phase() {
  PH_ID=$1 PH_NOTE="" PH_WARN="" PH_SKIP="" PH_DID=0 PH_T0=$(now_ms)
  TPAD=$(printf "%-${TW}s" "$(phase_title "$1")")
  [ "$UI" = tty ] || printf '  %-34s' "$(phase_title "$1")..."
}
phase_end() {
  took=$(fmt_ms $(($(now_ms) - PH_T0)))
  # a phase where every step had nothing to do says why
  [ -n "$PH_NOTE" ] || [ "$PH_DID" = 1 ] || PH_NOTE=$PH_SKIP
  if [ "$UI" = tty ]; then
    if [ -n "$PH_WARN" ]; then glyph skip; draw "$WARN" "$G" "$took" "${WARN}${PH_WARN}${R}"
    else glyph ok; draw "$OK" "$G" "$took" "${DIM}${PH_NOTE}${R}"; fi
    printf '\n'
  else
    say "done ($took)${PH_WARN:+, $PH_WARN}${PH_NOTE:+, $PH_NOTE}"
  fi
  PH_IDX=$((PH_IDX + 1))
}

# a step runs in the background into its own log; 0 done, 10 nothing to do (its last line says why), 11 done with a
# warning (amber, keep going), anything else stops here. note "text" gives the phase line its dim words.
note() { [ -f "$TMP/note" ] || printf '%s' "$*" > "$TMP/note"; }
STEP_PID=""
step() { # id function
  LOG="$TMP/logs/$1.log"
  title=$(step_title "$1")
  SUBTXT=$title SUB="${DIM}${title}${R}  "
  : > "$LOG"
  set +e
  rm -f "$TMP/rc" "$TMP/note"
  ( ( set -e; "$2" ) </dev/null >>"$LOG" 2>&1; echo $? > "$TMP/rc" ) &
  STEP_PID=$!
  if [ "$UI" = tty ]; then watch_step; else while [ ! -f "$TMP/rc" ]; do sleep 0.3; done; fi
  wait "$STEP_PID"
  code=$(cat "$TMP/rc" 2>/dev/null)
  STEP_PID=""
  set -e
  why=$(tail -n 1 "$LOG" 2>/dev/null | tr -cd '\40-\176' | cut -c1-$((COLS - TW - 16)))
  [ -z "$PH_NOTE" ] && [ -f "$TMP/note" ] && PH_NOTE=$(cut -c1-$((COLS - TW - 16)) "$TMP/note")
  case "$code" in
    0) PH_DID=1 ;;
    10) PH_SKIP=$why ;;
    11) PH_DID=1; [ -n "$PH_WARN" ] || PH_WARN=$why ;;
    *)
      took=$(fmt_ms $(($(now_ms) - PH_T0)))
      if [ "$UI" = tty ]; then glyph fail; draw "$ERR" "$G" "$took" "${ERR}${title} failed${R}"; mascot 0; printf '\n'; else say "failed ($took)"; fi
      if [ "$LIST" = 1 ]; then for _s in $(phases_after "$PH_ID"); do pending_line "$_s"; done; fi
      failure_panel "$1"
      exit 1 ;;
  esac
}

failure_words() {
  case "$1" in
    backup) say "Couldn't save the backup, so nothing of your bots was removed. Free some disk space, or run it again with --no-backup." ;;
    user) say "Couldn't remove the $SVC_USER account. Paste the line again; it picks up where it stopped." ;;
    *) say "Something went wrong. Paste the line again; it picks up where it stopped." ;;
  esac
}
failure_panel() {
  glyph bar; _bar=$G
  printf '\n  %s%s%s couldn'"'"'t finish%s\n\n' "$ERR$BOLD" "$(step_title "$1")" "$R$ERR" "$R"
  tail -n 8 "$LOG" 2>/dev/null | tr -cd '\12\40-\176' | cut -c1-$((COLS - 8)) | while IFS= read -r line; do
    printf '    %s%s%s %s\n' "$SHADOW" "$_bar" "$R" "$line"
  done
  glyph arrow
  printf '\n  %s%s%s %s\n' "$ACC" "$G" "$R" "$(failure_words "$1")"
  cat "$TMP"/logs/*.log > /root/duskbot-uninstall.log 2>/dev/null || true
  printf '    %sfull log: /root/duskbot-uninstall.log%s\n\n' "$DIM" "$R"
}

# ---------- steps ----------
do_revoke() {
  file="$LINK_HOME/.config/$LINK_CONF/tunnel.json"
  [ -f "$file" ] || file="$SVC_HOME/.config/$LINK_CONF/tunnel.json"
  [ -f "$file" ] || { echo "not linked to an app"; return 10; }
  id=$(sed -n 's/.*"id":"\([a-z2-7]\{10\}\)".*/\1/p' "$file" | head -n 1)
  token=$(sed -n 's/.*"token":"\([A-Za-z0-9_-]\{20,100\}\)".*/\1/p' "$file" | head -n 1)
  base=$(sed -n 's/.*"base":"\(https\{0,1\}:\/\/[^"]*\)".*/\1/p' "$file" | head -n 1)
  base=${base:-$LINK_BASE}
  [ -n "$id" ] && [ -n "$token" ] || { echo "the link file is unreadable; the app shows this server as offline"; return 11; }
  show curl -X DELETE "$base/v1/tunnels/$id"
  status=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X DELETE -H "authorization: Bearer $token" "$base/v1/tunnels/$id" 2>/dev/null) || status=000
  case "$status" in
    200) echo "the link service forgot this server"; note "the app sees it as unlinked" ;;
    404) echo "the link was already gone" ;;
    *) echo "couldn't reach the link service ($status); the app shows this server as offline"; return 11 ;;
  esac
}

do_units() {
  found=$(our_units)
  [ -n "$found" ] || { echo "no services left"; return 10; }
  for unit in $found; do
    x systemctl disable --now "$unit" 2>&1 || true
  done
  for unit in $OUR_UNITS; do
    if [ -f "$UNITS/$unit" ]; then x rm -f "$UNITS/$unit"; fi
  done
  x systemctl daemon-reload
  # shellcheck disable=SC2086
  systemctl reset-failed $OUR_UNITS >/dev/null 2>&1 || true
  for _who in "$SVC_USER" "$LINK_USER" "$GATE_USER"; do
    if id "$_who" >/dev/null 2>&1 && pgrep -u "$_who" >/dev/null 2>&1; then
      x pkill -TERM -u "$_who" || true
      sleep 2
      pkill -KILL -u "$_who" 2>/dev/null || true
    fi
  done
  echo "stopped and removed: $(words "$found")"
  note "$(count "$found") services stopped and removed"
}

do_boxes() {
  if ! command -v docker >/dev/null 2>&1; then echo "no docker here"; return 10; fi
  if ! docker info >/dev/null 2>&1; then echo "docker isn't running; its bot computers stay where they are"; return 11; fi
  containers=$(our_containers) volumes=$(our_volumes) networks=$(our_networks) images=$(our_images)
  if [ -z "$containers$volumes$networks$images" ] && [ "$ALL" = 0 ]; then echo "no bot computers"; return 10; fi
  # shellcheck disable=SC2086
  [ -z "$containers" ] || x docker rm -f -v $containers
  # shellcheck disable=SC2086
  [ -z "$volumes" ] || x docker volume rm -f $volumes
  soft=0
  # shellcheck disable=SC2086
  [ -z "$networks" ] || x docker network rm $networks || { echo "the bot computer network is still in use"; soft=1; }
  # shellcheck disable=SC2086
  [ -z "$images" ] || x docker rmi -f $images || { echo "an image of ours is still in use"; soft=1; }
  # the bot computer's build left layers in buildkit's cache; only --all clears it, it may hold other builds too
  if [ "$ALL" = 1 ]; then x docker builder prune -af >/dev/null 2>&1 || true; fi
  done_words="$(plural "$(count "$containers")" "bot computer" "bot computers"), $(plural "$(count "$volumes")" home homes), $(plural "$(count "$images")" image images)"
  echo "removed $done_words"
  note "$done_words"
  [ "$soft" = 0 ] || return 11
}

do_fence() {
  if [ "$(fence_rules)" -eq 0 ] && [ ! -e "$FENCE" ]; then echo "no fence"; return 10; fi
  if command -v iptables >/dev/null 2>&1; then
    # what host-fence.sh --remove does, here so it works without the script
    show iptables -D INPUT -i "$BRIDGE" -j OMB-BOX-IN
    while iptables -w 10 -D INPUT -i "$BRIDGE" -j OMB-BOX-IN 2>/dev/null; do :; done
    show iptables -D DOCKER-USER -i "$BRIDGE" -j OMB-BOX-FWD
    while iptables -w 10 -D DOCKER-USER -i "$BRIDGE" -j OMB-BOX-FWD 2>/dev/null; do :; done
    while ip6tables -w 10 -D INPUT -i "$BRIDGE" -j DROP 2>/dev/null; do :; done
    while ip6tables -w 10 -D FORWARD -i "$BRIDGE" -j DROP 2>/dev/null; do :; done
    for chain in OMB-BOX-IN OMB-BOX-FWD; do
      show iptables -X "$chain"
      iptables -w 10 -F "$chain" 2>/dev/null || true
      iptables -w 10 -X "$chain" 2>/dev/null || true
    done
  fi
  if [ -e "$FENCE" ]; then x rm -f "$FENCE"; fi
  left=$(fence_rules)
  [ "$left" -eq 0 ] || { echo "$left fence rules are still there"; return 11; }
  echo "fence rules removed"
}

daemon_strip() { # file runsc userns out: our keys out of daemon.json; empty output when nothing else is left
  _js='const fs = require("fs"), [file, runsc, userns, out] = process.argv.slice(1);
    const conf = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    if (runsc === "1" && conf.runtimes && conf.runtimes.runsc) { delete conf.runtimes.runsc; if (!Object.keys(conf.runtimes).length) delete conf.runtimes; }
    if (userns === "1" && conf["userns-remap"] === "default") delete conf["userns-remap"];
    fs.writeFileSync(out, Object.keys(conf).length ? JSON.stringify(conf, null, 2) + "\n" : "");'
  _py='import json, sys
f, runsc, userns, out = sys.argv[1:5]
conf = json.loads(open(f).read() or "{}")
if runsc == "1" and "runsc" in conf.get("runtimes", {}):
    del conf["runtimes"]["runsc"]
    if not conf["runtimes"]: del conf["runtimes"]
if userns == "1" and conf.get("userns-remap") == "default": del conf["userns-remap"]
open(out, "w").write(json.dumps(conf, indent=2) + "\n" if conf else "")'
  if [ -x /usr/bin/node ]; then /usr/bin/node -e "$_js" "$@"
  elif command -v python3 >/dev/null 2>&1; then python3 -c "$_py" "$@"
  else echo "no node or python3 to edit daemon.json"; return 1; fi
}

do_sandbox() {
  [ -f "$DAEMON" ] || [ -f "$DAEMON.omb-before" ] || { echo "no docker settings of ours"; return 10; }
  daemon_ours || { echo "docker settings are not ours; left alone"; return 10; }
  [ -f "$DAEMON" ] && cp -p "$DAEMON" "$TMP/daemon.json.was"
  changed=0
  if [ -f "$DAEMON.omb-before" ]; then
    if [ -f "$DAEMON" ] && cmp -s "$DAEMON.omb-before" "$DAEMON"; then :; else
      x install -m 0644 "$DAEMON.omb-before" "$DAEMON"; changed=1
      echo "daemon.json: put back the copy from before the install"
    fi
    x rm -f "$DAEMON.omb-before"
  else
    runsc=0 userns=0
    if grep -q '"runsc"' "$DAEMON" && { in_manifest "daemon-key gvisor" || grep -q -- '--overlay2=none' "$DAEMON"; }; then runsc=1; fi
    in_manifest "daemon-key userns" && userns=1
    daemon_strip "$DAEMON" "$runsc" "$userns" "$TMP/daemon.json.new" || return 11
    if [ -s "$TMP/daemon.json.new" ]; then
      cmp -s "$TMP/daemon.json.new" "$DAEMON" || { x install -m 0644 "$TMP/daemon.json.new" "$DAEMON"; changed=1; echo "daemon.json: took out our sandbox settings"; }
    elif in_manifest "daemon-json new"; then
      x rm -f "$DAEMON"; changed=1; echo "daemon.json: removed (the install made it)"
    else
      printf '{}\n' > "$TMP/daemon.json.new"; x install -m 0644 "$TMP/daemon.json.new" "$DAEMON"; changed=1
    fi
  fi
  if [ "$changed" = 0 ]; then echo "docker settings already as before"; return 0; fi
  if systemctl is-active --quiet docker 2>/dev/null; then
    if x systemctl restart docker; then
      i=0; while [ "$i" -lt 60 ] && ! docker info >/dev/null 2>&1; do sleep 2; i=$((i + 2)); done
    fi
    if ! docker info >/dev/null 2>&1; then
      echo "docker would not start with the old settings; keeping the current ones"
      [ -f "$TMP/daemon.json.was" ] && install -m 0644 "$TMP/daemon.json.was" "$DAEMON"
      systemctl reset-failed docker >/dev/null 2>&1 || true
      systemctl restart docker >/dev/null 2>&1 || true
      return 11
    fi
  fi
  # docker made this account for userns-remap=default, which the install turned on
  if in_manifest "daemon-key userns" && id dockremap >/dev/null 2>&1; then x userdel dockremap || true; fi
  echo "docker is back to its own settings, gVisor no longer registered"
  note "Docker settings put back"
}

do_backup() {
  [ -d "$DATA" ] || { echo "no bot data to save"; return 10; }
  [ "$BACKUP" = 1 ] || { echo "no backup (--no-backup)"; return 10; }
  x tar -czf "$BACKUP_FILE.tmp" -C "$SVC_HOME" "${DATA##*/}"
  chmod 0600 "$BACKUP_FILE.tmp"
  mv "$BACKUP_FILE.tmp" "$BACKUP_FILE"
  echo "saved $(du -h "$BACKUP_FILE" | cut -f1) to $BACKUP_FILE"
  note "your bots are backed up in /root"
}

# the link agent's and docker gate's accounts: only ever install.sh's, by their names
other_accounts() {
  for _who in "$LINK_USER" "$GATE_USER"; do
    id "$_who" >/dev/null 2>&1 || continue
    pkill -KILL -u "$_who" 2>/dev/null || true
    x userdel "$_who" 2>&1 | grep -v 'mail spool' || true
    getent group "$_who" >/dev/null 2>&1 && groupdel "$_who" 2>/dev/null || true
  done
  getent group "$GATE_GROUP" >/dev/null 2>&1 && x groupdel "$GATE_GROUP" || true
  [ ! -d "$LINK_HOME" ] || x rm -rf "$LINK_HOME"
}

do_user() {
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    other_accounts
    if [ -d "$SVC_HOME" ]; then x rm -rf "$SVC_HOME"; echo "removed $SVC_HOME"; return 0; fi
    echo "no $SVC_USER account"; return 10
  fi
  if pgrep -u "$SVC_USER" >/dev/null 2>&1; then
    loginctl terminate-user "$SVC_USER" >/dev/null 2>&1 || true
    pkill -KILL -u "$SVC_USER" 2>/dev/null || true
    sleep 1
  fi
  x userdel -r "$SVC_USER" 2>&1 | grep -v 'mail spool' || true
  id "$SVC_USER" >/dev/null 2>&1 && { echo "the $SVC_USER account is still there"; return 1; }
  getent group "$SVC_USER" >/dev/null 2>&1 && groupdel "$SVC_USER" 2>/dev/null || true
  [ -d "$SVC_HOME" ] && x rm -rf "$SVC_HOME"
  other_accounts
  echo "removed the $SVC_USER account and $SVC_HOME"
  note "$SVC_USER and its home removed"
}

do_caddy() {
  caddy_ours || { echo "no Caddy site"; return 10; }
  main=/etc/caddy/Caddyfile
  if [ -f /etc/caddy/$CADDY_NAME.caddy ]; then x rm -f /etc/caddy/$CADDY_NAME.caddy; fi
  if [ -f "$main" ] && grep -q "managed by duskbot-link" "$main"; then
    if [ -f "$main.omb-before" ]; then x mv -f "$main.omb-before" "$main"; else x rm -f "$main"; fi
  elif [ -f "$main" ] && grep -q "import /etc/caddy/$CADDY_NAME.caddy" "$main"; then
    show sed -i "\\#import /etc/caddy/$CADDY_NAME.caddy#d" "$main"
    sed -i "\\#import /etc/caddy/$CADDY_NAME.caddy#d" "$main"
  fi
  for port in $(manifest ufw); do command -v ufw >/dev/null 2>&1 && x ufw delete allow "$port" || true; done
  if command -v caddy >/dev/null 2>&1; then
    if in_manifest "pkg caddy"; then
      # caddy is ours and has no site now: off until --all removes it or the install wants it again
      x systemctl disable --now caddy 2>&1 || true
    elif [ -f "$main" ]; then
      systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
    fi
  fi
  echo "Caddy no longer serves this server's address"
}

# 0 only when tailnet https port 443 still proxies to the Metal server alone; a status that cannot be read is not ours
ts_443_ours() {
  _status=$(tailscale serve status --json 2>/dev/null) || return 1
  _js='const s=JSON.parse(process.argv[1]);const w=Object.entries(s.Web??{}).find(([k])=>k.endsWith(":443"));const h=w?.[1].Handlers??{};process.exit(Object.keys(h).join()==="/"&&h["/"].Proxy==="http://127.0.0.1:8799"?0:1)'
  _py='import json,sys
s=json.loads(sys.argv[1]);w=[v for k,v in (s.get("Web") or {}).items() if k.endswith(":443")];h=(w[0].get("Handlers") or {}) if w else {}
sys.exit(0 if list(h)==["/"] and (h["/"] or {}).get("Proxy")=="http://127.0.0.1:8799" else 1)'
  if [ -x /usr/bin/node ]; then /usr/bin/node -e "$_js" "$_status" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then python3 -c "$_py" "$_status" 2>/dev/null
  else return 1; fi
}

do_files() {
  removed=""
  if [ -f "$BWRAP_PROFILE" ]; then
    command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R "$BWRAP_PROFILE" >/dev/null 2>&1 || true
    x rm -f "$BWRAP_PROFILE"; removed="$removed $BWRAP_PROFILE"
  fi
  # the tailnet address this server served Metal at
  if in_manifest "tailscale-serve 443" && command -v tailscale >/dev/null 2>&1; then
    if ts_443_ours; then x tailscale serve --https=443 off 2>&1 || true
    else echo "tailnet https port 443 serves something else now; leaving it alone"; fi
  fi
  for path in "$OPT" "$LOGS_DIR" "$STATE" "$FENCE" "$LIB" "$ETC" /etc/duskbot-address.json /etc/duskbot-cloudflared; do
    if [ -e "$path" ]; then x rm -rf "$path"; removed="$removed $path"; fi
  done
  for path in "$CLI" "${CLI%/*}/metal"; do
    if cli_ours "$path"; then x rm -f "$path"; removed="$removed $path"; fi
  done
  # the manifest keeps only what is still installed (packages, apt sources), so a later --all can take those too
  if [ -f "$MANIFEST" ] && [ "$ALL" = 0 ]; then
    grep -E '^(pkg|file) ' "$MANIFEST" > "$TMP/manifest" || true
    if [ -s "$TMP/manifest" ]; then install -m 0644 "$TMP/manifest" "$MANIFEST"; else rm -rf "${MANIFEST%/*}"; fi
  fi
  [ -n "$removed" ] || { echo "no files left"; return 10; }
  echo "removed$removed"
}

do_purge() {
  pkgs=$(our_pkgs)
  if [ -n "$pkgs" ]; then
    # purge only what nothing else needs: mark ours as automatic and let apt say which of them it would autoremove,
    # minus whatever it would have removed anyway. software the person added later keeps what it depends on.
    apt-get -s autoremove 2>/dev/null | awk '/^Remv / { print $2 }' | sort -u > "$TMP/auto.before"
    # shellcheck disable=SC2086
    apt-mark showmanual $pkgs 2>/dev/null | sort -u > "$TMP/manual.before"
    # shellcheck disable=SC2086
    x apt-mark auto $pkgs >/dev/null
    apt-get -s autoremove 2>/dev/null | awk '/^Remv / { print $2 }' | sort -u > "$TMP/auto.after"
    printf '%s\n' "$pkgs" | sort -u > "$TMP/ours"
    purge=$(comm -13 "$TMP/auto.before" "$TMP/auto.after" | comm -12 - "$TMP/ours")
    if [ -n "$purge" ]; then
      # docker's socket unit must be down before its package goes, or systemd keeps a dead socket that breaks the next
      # install's docker ("no sockets found via socket activation")
      if printf '%s\n' "$purge" | grep -qxE 'docker\.io|containerd'; then
        x systemctl stop docker.socket docker.service containerd.service 2>&1 || true
      fi
      # shellcheck disable=SC2086
      x apt-get -y -q -o DPkg::Lock::Timeout=300 purge $purge
      x systemctl daemon-reload
      systemctl reset-failed docker.service docker.socket containerd.service >/dev/null 2>&1 || true
      rm -f /run/docker.sock
    fi
    # what stays (something else needs it) goes back to how it was marked
    kept=$(our_pkgs)
    if [ -n "$kept" ]; then
      # shellcheck disable=SC2086
      back=$(printf '%s\n' $kept | sort -u | comm -12 - "$TMP/manual.before")
      # shellcheck disable=SC2086
      [ -z "$back" ] || apt-mark manual $back >/dev/null
    fi
  fi
  for path in $(manifest file); do
    case "$path" in /etc/apt/*|/usr/share/keyrings/*) [ -e "$path" ] && x rm -f "$path" ;; esac
  done
  # what something else still needs stays on record, so the check below and a later --all still see it
  if [ -n "${kept:-}" ]; then printf '%s\n' "$kept" | sed 's/^/pkg /' > "$TMP/manifest"; install -m 0644 "$TMP/manifest" "$MANIFEST"; else rm -rf "${MANIFEST%/*}"; fi
  if [ -n "${kept:-}" ]; then echo "kept $(count "$kept") that other software needs: $(words "$kept" | cut -c1-60)"; return 11; fi
  [ -n "$pkgs" ] || { echo "nothing it installed is left"; return 10; }
  echo "removed $(count "$purge") packages"
  note "$(count "$purge") packages removed"
}
no_purge() {
  pkgs=$(our_pkgs)
  if [ -n "$pkgs" ]; then echo "kept $(friendly_pkgs "$pkgs") (--all removes them)"; else echo "nothing else it installed"; fi
  return 10
}

# ---------- the end ----------
check_line() { # ok|left label detail
  if [ "$1" = ok ]; then glyph ok; _c=$OK; else glyph fail; _c=$ERR; LEFT=$((LEFT + 1)); fi
  printf '    %s%s%s %-16s %s%s%s\n' "$_c" "$G" "$R" "$2" "$DIM" "$3" "$R"
}
leftovers() {
  LEFT=0
  printf '\n  %sWhat is left of it%s\n\n' "$BOLD" "$R"
  _u=$(our_units)
  if [ -z "$_u" ]; then check_line ok services "none (systemctl)"; else check_line left services "$(words "$_u")"; fi
  if docker_up; then
    _n=$(count "$(our_containers)") _v=$(count "$(our_volumes)") _i=$(count "$(our_images)") _w=$(count "$(our_networks)")
    if [ $((_n + _v + _i + _w)) -eq 0 ]; then check_line ok "bot computers" "none (docker ps -a, volumes, images, network)"
    else check_line left "bot computers" "$_n containers, $_v volumes, $_i images, $_w networks"; fi
  else
    check_line ok "bot computers" "no docker running"
  fi
  if id "$SVC_USER" >/dev/null 2>&1; then check_line left account "$SVC_USER still exists"; else check_line ok account "no $SVC_USER user"; fi
  _p=$(our_paths)
  if [ -z "$_p" ]; then check_line ok files "none in /opt, /var/lib, /var/log, /etc, /home"; else check_line left files "$(words "$_p" | cut -c1-60)"; fi
  _f=$(fence_rules)
  if [ "$_f" -eq 0 ]; then check_line ok "network fence" "no OMB-BOX rules (iptables)"; else check_line left "network fence" "$_f rules"; fi
  if daemon_ours; then check_line left "docker settings" "$DAEMON still has ours"; else check_line ok "docker settings" "gVisor not registered by us"; fi
  if caddy_ours; then check_line left caddy "/etc/caddy still has our site"; fi
  _k=$(our_pkgs)
  if [ -n "$_k" ]; then
    glyph skip
    if [ "$ALL" = 1 ]; then printf '    %s%s%s %-16s %s%s%s\n' "$WARN" "$G" "$R" "packages" "$DIM" "kept $(count "$_k"), other software needs them" "$R"
    else printf '    %s%s%s %-16s %s%s%s\n' "$DIM" "$G" "$R" "packages" "$DIM" "kept $(friendly_pkgs "$_k") (--all removes them)" "$R"; fi
  fi
  return 0
}

finale() {
  total=$(fmt_ms $(($(now_ms) - RUN_T0)))
  mascot 0
  leftovers
  glyph sep
  if [ "$LEFT" -eq 0 ]; then
    glyph ok; _ok=$G; glyph sep
    printf '\n  %s%s %sRemoved Metal from %s%s  %s%s %s%s\n' "$OK" "$_ok" "$BOLD" "$NAME" "$R" "$DIM" "$G" "$total" "$R"
    if [ -f "$BACKUP_FILE" ]; then printf '    %syour bots are saved in %s%s\n' "$DIM" "$BACKUP_FILE" "$R"; fi
    printf '\n  %s%sAll clean. Paste the install line from the app whenever you want it back.%s\n\n' "$ACC" "$BOLD" "$R"
  else
    glyph fail
    printf '\n  %s%s %sAlmost: %d thing(s) above are still here.%s\n' "$ERR" "$G" "$BOLD" "$LEFT" "$R"
    printf '  %sPaste the line again to try once more.%s\n\n' "$DIM" "$R"
    exit 1
  fi
}

on_exit() {
  [ "$UI" = tty ] && printf '%s[?25h' "$ESC"
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
  return 0
}
on_stop() {
  trap '' INT TERM
  [ -n "$STEP_PID" ] && kill "$STEP_PID" 2>/dev/null
  printf '\n\n  Stopped. Paste the line again; it picks up where it stopped.\n\n'
  exit 130
}

# the lock install.sh holds while it runs: never remove what an install is still writing
INSTALL_LOCK=/run/duskbot-install.lock
take_lock() {
  command -v flock >/dev/null 2>&1 && ( : >>"$INSTALL_LOCK" ) 2>/dev/null || return 0
  exec 9>>"$INSTALL_LOCK"
  flock -n 9 && return 0
  printf '\nSomeone is installing Metal on this server right now (another terminal, or one whose connection dropped). Wait for it to finish, then run this again.\n\n' >&2
  exit 1
}

main() {
  become_root
  [ "$DRY" = 1 ] || take_lock
  umask 077
  TMP=$(mktemp -d)
  mkdir -p "$TMP/logs"
  ui_init
  trap on_exit EXIT
  trap on_stop INT TERM
  [ "$UI" = tty ] && printf '%s[?25l' "$ESC"
  NAME=$(hostname -s 2>/dev/null | tr -cd 'A-Za-z0-9.-' | cut -c1-40)
  [ -n "$NAME" ] || NAME="this server"
  BACKUP_FILE="/root/duskbot-backup-$(date +%Y%m%d-%H%M%S).tgz"
  RUN_T0=$(now_ms)

  banner
  survey
  if [ "$S_ANY" = 0 ]; then
    glyph ok
    printf '  %s%s %sNo Metal on %s.%s\n' "$OK" "$G" "$BOLD" "$NAME" "$R"
    leftovers
    printf '\n  %sPaste the install line from the app to set it up.%s\n\n' "$DIM" "$R"
    return 0
  fi
  # the mascot is redrawn this many lines below its own: the blank after it, the plan, the question
  _plan=$(plan; printf x)
  _plan=${_plan%x}
  printf '%s' "$_plan"
  BELOW_TAG=$((1 + $(printf '%s' "$_plan" | wc -l)))
  asked=0
  [ "$YES" = 0 ] && [ "$DRY" = 0 ] && has_tty && asked=1
  if ! confirm; then
    printf '  %sNothing was changed.%s\n' "$BOLD" "$R"
    if [ "$asked" = 0 ]; then
      _flags=""
      for _a in $ARGS; do case "$_a" in --dry-run|--yes|-y) ;; *) _flags="$_flags $_a" ;; esac; done
      printf '  %sTo remove it, with no question:%s\n    curl -fsSL %s/uninstall | sh -s -- --yes%s\n' "$DIM" "$R" "$LINK_BASE" "$_flags"
    fi
    say ""
    return 0
  fi
  [ "$asked" = 1 ] && BELOW_TAG=$((BELOW_TAG + 2))
  checklist

  phase unlink; step revoke do_revoke; phase_end
  phase stop; step units do_units; phase_end
  phase computer; step boxes do_boxes; step fence do_fence; step sandbox do_sandbox; phase_end
  phase home; step backup do_backup; step user do_user; step caddy do_caddy; step files do_files; phase_end
  phase packages
  if [ "$ALL" = 1 ]; then step purge do_purge; else step purge no_purge; fi
  phase_end
  finale
}

main "$@"
