// What runs on an InstaBox machine to make it a My Cloud home: the same launcher, edge and server as every Cloud home
// (server/cloud-home-start.ts, apps/cloud-service/deploy/Caddyfile), installed natively under systemd so it comes back
// after every cold boot. The setup script runs once, as the machine user with passwordless sudo; every later step is one
// command the reconciler sends. InstaBox facts this relies on (docs read and live machines checked 2026-11-11): /data is
// the machine's persistent ext4 disk and also holds the machine user's home (/data/home), TMPDIR (/data/tmp), the
// platform's own folders and swap; the root disk (Docker's images and volumes) persists across a stop and a reboot; exec
// and file uploads run as that user; a pause keeps memory and processes, so nothing has to stop before it.
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { CLOUD_HOME_MARKER_FILE, homeEnv, shellQuote, type DashboardLink } from "../../dashboard/server/clouds/bootstrap.ts";
import type { MachineImage, HomeBootInput } from "./provider.ts";
import { machineVerifyScript, type ReleaseKey } from "./release-signing.ts";

/** pinned runtime downloads, verified before use */
export const HOME_NODE = { version: "24.22.2", sha256: "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75" } as const;
export const HOME_CADDY = { version: "2.10.2", sha512: "747df7ee74de188485157a383633a1a963fd9233b71fbb4a69ddcbcc589ce4e2cc82dacf5dbbe136cb51d17e14c59daeb5d9bc92487610b0f3b93680b2646546" } as const;
/** The direct screen path's UDP ports (server/screen-direct.ts), the same range the server image sets. The provider
 * publishes no UDP (docs/provider.md, "The live screen"), so nothing opens them from outside: the server reaches an app
 * from inside out, through the address STUN shows it, or through the app's TURN relay; else the screen stays on the
 * link relay. Pinned so a provider-side UDP forward, when there is one, has one range to open. */
export const HOME_SCREEN_DIRECT_PORTS = "30000-30063";
export const INSTABOX_USER_HOME = "/data/home";
export const INSTABOX_BOOT_FILE = `${INSTABOX_USER_HOME}/.omb-boot.json`;
export const INSTABOX_PACKAGE_FILE = `${INSTABOX_USER_HOME}/omb-home.tgz`;
export const INSTABOX_RESTORE_FILE = `${INSTABOX_USER_HOME}/dusk-restore.tar`;
export const INSTABOX_SNAPSHOT_FILE = `${INSTABOX_USER_HOME}/.omb-snapshot.tar`;
export const INSTABOX_SETUP_FILE = `${INSTABOX_USER_HOME}/.omb-setup.sh`;
export const INSTABOX_SETUP_LOG = `${INSTABOX_USER_HOME}/.omb-setup.log`;
export const INSTABOX_SETUP_STATUS = `${INSTABOX_USER_HOME}/.omb-setup.status`;
/** the volume's name inside a backup tar (`data/...`) */
export const INSTABOX_HOME_VOLUME = "data";
/** entries of /data that are the platform's (the machine user's home, TMPDIR, its own state, swap) or a step's scratch:
 *  never in a backup, never replaced by a restore */
export const PLATFORM_ENTRIES = ["home", "tmp", "workspace", "config", "state", "swapfile", "lost+found", ".instabox*", ".omb-restore.*", ".omb-old.*"] as const;
// the launcher runs only root's code (codeTrustProblem); the whole Node distribution, npm with it: the server installs
// engine CLIs with npm into its own data folder (engine-install.ts)
const ROOT = CLOUD_HOME.root, APP = `${ROOT}/app`, BIN = `${ROOT}/bin`, NODE_DIR = `${ROOT}/node`;
export const HOME_NODE_BIN = `${NODE_DIR}/bin/node`;
export const HOME_CONTROL = `${BIN}/omb-home`;
/** what the bot computers' image is doing on this machine (building, ready, failed); the home's server reads it */
export const DESKTOP_IMAGE_STATUS = `${CLOUD_HOME.run}/desktop-image`;
/** The docker gate's runtime folder on a home set up from now on; one set up before keeps its own (the server finds either). */
export const HOME_GATE_RUN = "duskbot-docker";
/** merges cgroup-parent into docker's daemon.json; exits 0 only when it changed the file */
const DOCKER_SLICE = `const fs = require("node:fs"), p = "/etc/docker/daemon.json";
let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
if (c["cgroup-parent"] === "omb-bots.slice") process.exit(1);
c["cgroup-parent"] = "omb-bots.slice";
fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\\n");`;
/** an online SQLite backup (consistent while the home writes); a file that is not a database is copied as it is */
const DB_COPY = `const { DatabaseSync, backup } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
backup(db, process.argv[2]).then(() => { db.close(); }, () => { db.close(); process.exit(1); });`;
const platformCase = PLATFORM_ENTRIES.join("|");
const excludes = PLATFORM_ENTRIES.map(e => `--exclude='data/${e}'`).join(" ");

/** what a machine needs to become this cloud's home: its env (the bootstrap secret among it), its dashboard link, its id */
export function bootContent(input: HomeBootInput): { v: 1; env: Record<string, string>; link: DashboardLink; machine: string } {
  const env = { ...homeEnv({ ...input, origin: "https://pending.invalid" }), DUSK_CLOUD_EDGE_HOLD: "30s" };
  return { v: 1, env, link: input.link, machine: input.cloudId };
}

/** the per-cloud secrets as one boot file (a loopback service only: no machine can reach it to redeem a claim) */
export function bootFile(input: HomeBootInput): { path: string; content: string } {
  return { path: INSTABOX_BOOT_FILE, content: JSON.stringify(bootContent(input)) };
}

/** the one-time claim the machine redeems at first boot for its boot content: the provider's API never carries a secret */
export function claimBootFile(input: { cloudId: string; claim: string; redeem: string }): { path: string; content: string } {
  if (!/^c[0-9a-f]{24}$/.test(input.cloudId) || !/^[A-Za-z0-9_-]{43}$/.test(input.claim) || !input.redeem.startsWith("https://")) throw new Error("Invalid machine claim.");
  return { path: INSTABOX_BOOT_FILE, content: JSON.stringify({ v: 2, machine: input.cloudId, claim: input.claim, redeem: input.redeem }) };
}

/** redeems a v2 boot file's claim at the account service, writing the v1 boot content root keeps; retried, never on a 403 */
export const REDEEM_SCRIPT = `const fs = require("node:fs");
const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (b.v !== 2 || !/^c[0-9a-f]{24}$/.test(b.machine) || typeof b.claim !== "string" || !/^https:\\/\\/[^/]+\\/v1\\/managed\\/claims\\/redeem$/.test(b.redeem)) process.exit(1);
(async () => {
  // the claim lives an hour: keep trying through a slow deploy of the service or its rate limit, never past a refusal
  const until = Date.now() + 55 * 60_000;
  for (let i = 0; Date.now() < until; i++) {
    let wait = Math.min(60000, 3000 * (i + 1));
    try {
      const r = await fetch(b.redeem, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000), headers: { "content-type": "application/json" }, body: JSON.stringify({ cloud: b.machine, claim: b.claim }) });
      if (r.status === 403) process.exit(1);
      if (r.ok) { const a = await r.json(); if (a.v !== 1 || a.machine !== b.machine) process.exit(1); fs.writeFileSync(process.argv[2], JSON.stringify(a), { mode: 0o600 }); return; }
      const after = Number(r.headers.get("retry-after"));
      if (Number.isFinite(after) && after > 0) wait = Math.min(300000, after * 1000);
    } catch {}
    await new Promise((f) => setTimeout(f, wait));
  }
  process.exit(1);
})();`;

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Runs once on the first start. Installs Node and Caddy (pinned, checksummed), the `maus` user, the volume at /data, the
 * systemd units and the helper commands, and moves the boot secrets into root's files. It never starts the home: the
 * reconciler installs the app package and starts it once it knows the machine's public origin.
 */
export function homeSetupScript(options: { releaseKeys: readonly ReleaseKey[]; requireSigned: boolean } = { releaseKeys: [], requireSigned: false }): string {
  const node = `node-v${HOME_NODE.version}-linux-x64`;
  const caddy = `caddy_${HOME_CADDY.version}_linux_amd64.tar.gz`;
  const unit = `[Unit]
Description=Metal My Cloud home
After=network-online.target omb-docker-gate.service
Wants=network-online.target
ConditionPathExists=${APP}/dist-server/cloud-home-start.js

[Service]
EnvironmentFile=${CLOUD_HOME.etc}/home.env
Environment=DUSK_PREINSTALL_FREE_BACKUP=1
ExecStart=${HOME_NODE_BIN} ${APP}/dist-server/cloud-home-start.js
Restart=always
RestartSec=3
KillMode=mixed
TimeoutStopSec=35
# a runaway agent build is killed before the home: the home and its engines stay under 90% of memory, the bot
# computers' containers under omb-bots.slice, and the kernel picks anything else before this unit
MemoryHigh=80%
MemoryMax=90%
OOMScoreAdjust=-500
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
`;
  const gate = `[Unit]
Description=Metal docker gate for bot computers
After=docker.service
Requires=docker.service
StartLimitIntervalSec=0
ConditionPathExists=${APP}/link/docker-gate.mjs

[Service]
User=omb-docker
Group=maus
SupplementaryGroups=docker
RuntimeDirectory=${HOME_GATE_RUN}
RuntimeDirectoryMode=0750
ExecStart=${HOME_NODE_BIN} ${APP}/link/docker-gate.mjs --listen /run/${HOME_GATE_RUN}/docker.sock --upstream /var/run/docker.sock
Restart=always
RestartSec=2
UMask=0007
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any

[Install]
WantedBy=multi-user.target docker.service
`;
  // the bot computers' image, made ready by root beside the gate (which never builds): a failed try is tried again a
  // minute later, at low priority so the home answers while it builds
  const desktopImage = `[Unit]
Description=Metal bot computer image
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service
ConditionPathExists=${APP}/deploy/bot-desktop/Dockerfile

[Service]
Type=oneshot
ExecStart=${HOME_CONTROL} desktop-image
Restart=on-failure
RestartSec=60
TimeoutStartSec=45min
Nice=10
CPUWeight=50
IOWeight=50

[Install]
WantedBy=multi-user.target
`;
  // compressed swap at half the memory, so a burst does not kill anything; best effort (some kernels have no zram)
  const zram = `#!/bin/sh
modprobe zram num_devices=1 2>/dev/null || exit 0
[ -b /dev/zram0 ] || exit 0
grep -q /dev/zram0 /proc/swaps && exit 0
echo zstd > /sys/block/zram0/comp_algorithm 2>/dev/null || true
echo "$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 2 ))K" > /sys/block/zram0/disksize
mkswap /dev/zram0 >/dev/null && swapon -p 100 /dev/zram0
`;
  const zramUnit = `[Unit]
Description=Metal compressed swap

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${BIN}/omb-zram

[Install]
WantedBy=multi-user.target
`;
  const botsSlice = `[Unit]
Description=Metal computers

[Slice]
MemoryHigh=65%
MemoryMax=75%
`;
  const moveBoot = `const fs = require("node:fs");
const boot = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (boot.v !== 1 || !boot.env || !boot.link || !/^c[0-9a-f]{24}$/.test(boot.machine)) process.exit(1);
const env = { ...boot.env, HOME: "/data", DUSK_DATA_DIR: "${CLOUD_HOME.data}", NODE_ENV: "production", DUSK_STATIC_DIR: "${APP}/dist",
  DUSK_CLOUD_EDGE_BIN: "${BIN}/caddy", DUSK_CLOUD_EDGE_CONFIG: "${APP}/cloud/Caddyfile", PATH: "${NODE_DIR}/bin:${BIN}:/usr/local/bin:/usr/bin:/bin",
  DUSK_VPS_DOCKER: "local", DOCKER_HOST: "unix:///run/${HOME_GATE_RUN}/docker.sock", DUSK_BOT_DESKTOP_HOST_BUILD: "${DESKTOP_IMAGE_STATUS}",
  DUSK_SCREEN_DIRECT_PORTS: "${HOME_SCREEN_DIRECT_PORTS}" };
if (Object.entries(env).some(([k, v]) => !/^[A-Z][A-Z0-9_]*$/.test(k) || typeof v !== "string" || /[\\r\\n\\0]/.test(v))) process.exit(1);
fs.writeFileSync("${CLOUD_HOME.etc}/home.env", Object.entries(env).map(([k, v]) => k + "=" + v).join("\\n") + "\\n", { mode: 0o600 });
fs.writeFileSync("${CLOUD_HOME.data}/dashboard-link.json", JSON.stringify(boot.link), { mode: 0o600 });
fs.writeFileSync("${CLOUD_HOME.etc}/machine", boot.machine + "\\n", { mode: 0o600 });
if (!fs.existsSync("/data/${CLOUD_HOME_MARKER_FILE}")) fs.writeFileSync("/data/${CLOUD_HOME_MARKER_FILE}", JSON.stringify({ version: 1, machine: boot.machine }), { mode: 0o600 });`;
  return `#!/bin/bash
set +x
set -euo pipefail
umask 077
export DEBIAN_FRONTEND=noninteractive
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sudo install -d -o root -g root -m 0755 ${ROOT} ${BIN}
if [ ! -x ${HOME_NODE_BIN} ] || [ "$(${HOME_NODE_BIN} --version)" != "v${HOME_NODE.version}" ]; then
  curl -fsSL --retry 3 -o "$work/node.tar.xz" "https://nodejs.org/dist/v${HOME_NODE.version}/${node}.tar.xz"
  echo "${HOME_NODE.sha256}  $work/node.tar.xz" | sha256sum -c --quiet
  tar -xJf "$work/node.tar.xz" -C "$work"
  sudo chown -R root:root "$work/${node}" && sudo chmod -R a+rX,go-w "$work/${node}"
  sudo rm -r -f ${NODE_DIR}.old; [ ! -d ${NODE_DIR} ] || sudo mv ${NODE_DIR} ${NODE_DIR}.old
  sudo mv "$work/${node}" ${NODE_DIR}; sudo rm -r -f ${NODE_DIR}.old
fi
if [ ! -x ${BIN}/caddy ]; then
  curl -fsSL --retry 3 -o "$work/caddy.tar.gz" "https://github.com/caddyserver/caddy/releases/download/v${HOME_CADDY.version}/${caddy}"
  echo "${HOME_CADDY.sha512}  $work/caddy.tar.gz" | sha512sum -c --quiet
  tar -xzf "$work/caddy.tar.gz" -C "$work" caddy
  sudo install -o root -g root -m 0755 "$work/caddy" ${BIN}/caddy
fi
# the machine's template may have them already: skip the network then
if ! command -v bwrap >/dev/null || ! command -v socat >/dev/null || ! command -v python3 >/dev/null || ! command -v pdftotext >/dev/null || ! command -v unzip >/dev/null; then
  sudo apt-get update -qq >/dev/null 2>&1 || true
  sudo apt-get install -y -qq bubblewrap socat python3 poppler-utils unzip util-linux >/dev/null 2>&1 || true
fi
id maus >/dev/null 2>&1 || sudo useradd --system --home-dir /data --shell /bin/bash --user-group maus
id omb-docker >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --gid maus omb-docker
getent group docker >/dev/null 2>&1 && sudo usermod -aG docker omb-docker
sudo install -d -o root -g root -m 0700 ${CLOUD_HOME.etc}
# the mount point stays traversable for the machine user, whose home is inside it
sudo install -d -o maus -g maus -m 0711 /data
sudo install -d -o maus -g maus -m 0700 ${CLOUD_HOME.data}
if [ -f ${INSTABOX_BOOT_FILE} ]; then
  boot=${INSTABOX_BOOT_FILE}
  if grep -q '"v":2' ${INSTABOX_BOOT_FILE}; then
    sudo ${HOME_NODE_BIN} -e ${shellQuote(REDEEM_SCRIPT)} ${INSTABOX_BOOT_FILE} ${CLOUD_HOME.etc}/boot.json
    boot=${CLOUD_HOME.etc}/boot.json
  fi
  sudo ${HOME_NODE_BIN} -e ${shellQuote(moveBoot)} "$boot"
  sudo chown maus:maus ${CLOUD_HOME.data}/dashboard-link.json /data/${CLOUD_HOME_MARKER_FILE}
  sudo shred -u ${CLOUD_HOME.etc}/boot.json 2>/dev/null || sudo rm -f ${CLOUD_HOME.etc}/boot.json
  shred -u ${INSTABOX_BOOT_FILE} 2>/dev/null || rm -f ${INSTABOX_BOOT_FILE}
fi
sudo install -o root -g root -m 0644 /dev/stdin /etc/systemd/system/omb-home.service <<'DUSK_UNIT'
${unit}DUSK_UNIT
sudo install -o root -g root -m 0644 /dev/stdin /etc/systemd/system/omb-docker-gate.service <<'DUSK_GATE'
${gate}DUSK_GATE
sudo install -o root -g root -m 0644 /dev/stdin /etc/systemd/system/omb-desktop-image.service <<'DUSK_DESKTOP'
${desktopImage}DUSK_DESKTOP
sudo install -o root -g root -m 0755 /dev/stdin ${HOME_CONTROL} <<'DUSK_CTL'
${homeControlScript(options)}DUSK_CTL
sudo install -o root -g root -m 0755 /dev/stdin ${BIN}/omb-zram <<'DUSK_ZRAM'
${zram}DUSK_ZRAM
sudo install -o root -g root -m 0644 /dev/stdin /etc/systemd/system/omb-zram.service <<'DUSK_ZRAMUNIT'
${zramUnit}DUSK_ZRAMUNIT
sudo install -o root -g root -m 0644 /dev/stdin /etc/systemd/system/omb-bots.slice <<'DUSK_SLICE'
${botsSlice}DUSK_SLICE
sudo systemctl daemon-reload
sudo systemctl enable --now omb-zram.service >/dev/null 2>&1 || true
# bot computers' containers go under omb-bots.slice (merged into any daemon.json there; docker restarts once)
if [ -d /etc/docker ] || command -v dockerd >/dev/null; then
  sudo install -d -m 0755 /etc/docker
  if sudo ${HOME_NODE_BIN} -e ${shellQuote(DOCKER_SLICE)}; then sudo systemctl restart docker >/dev/null 2>&1 || true; fi
fi
`;
}

/**
 * <root>/bin/omb-home, root's: `install <file> <sha256> [signature] [floor]`, `rollback`, `restore <tar>`, `start <origin>`,
 * `stop`, `status`, `snapshot`, `snapshot-done`, `desktop-image`. Each prints only fixed words. Running it again is safe.
 */
export function homeControlScript(options: { releaseKeys: readonly ReleaseKey[]; requireSigned: boolean } = { releaseKeys: [], requireSigned: false }): string {
  return `#!/bin/bash
set +x
set -euo pipefail
umask 077
app=${APP}
verify=${shellQuote(machineVerifyScript(options.releaseKeys))}
signed=${options.requireSigned ? 1 : 0}
tree() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }
# the image's state, readable by the home's server (this script's umask would make it root's alone)
imaged() { printf '%s\\n' "$1" > ${DESKTOP_IMAGE_STATUS}; chmod 0644 ${DESKTOP_IMAGE_STATUS}; }
# the bot computers' image is made ready in the background whenever a package or a boot may have left it missing
desktop() { if [ -S /var/run/docker.sock ] && [ -f "$app/deploy/bot-desktop/Dockerfile" ] && [ "$(cat ${DESKTOP_IMAGE_STATUS} 2>/dev/null)" != ready ]; then systemctl enable omb-desktop-image.service >/dev/null 2>&1 || true; systemctl start --no-block omb-desktop-image.service >/dev/null 2>&1 || true; fi; }
case "\${1:-}" in
  install)
    file="$2"; sum="$3"; sig="\${4:-}"; floor="\${5:-}"; ver=""
    [[ "$sum" =~ ^[a-f0-9]{64}$ ]] || { echo "bad checksum"; exit 2; }
    echo "$sum  $file" | sha256sum -c --quiet
    if [ -n "$sig" ] || [ "$signed" = 1 ]; then
      [[ "$sig" =~ ^r1\\.[a-z0-9-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$ ]] || { echo "unsigned package"; exit 2; }
      sigfile="$(mktemp)"; printf '%s' "$sig" > "$sigfile"
      ver="$(${HOME_NODE_BIN} -e "$verify" "$sigfile" "$sum" home-package print)" || { rm -f "$sigfile"; echo "bad signature"; exit 2; }
      rm -f "$sigfile"
    fi
    # the same package again (a lost answer): nothing to swap, and the version before stays the one to roll back to
    if [ -d "$app" ] && [ "$(cat ${ROOT}/installed 2>/dev/null)" = "$sum" ]; then rm -f "$file"; desktop; echo installed; exit 0; fi
    # never older than what runs (a rollback is its own command), never below the signed floor
    if [ -n "$ver" ]; then
      cur="$(cat ${ROOT}/installed-version 2>/dev/null || true)"
      if [ -n "$cur" ] && [ "$(printf '%s\\n%s\\n' "$cur" "$ver" | sort -V | head -n 1)" != "$cur" ]; then rm -f "$file"; echo "older package"; exit 2; fi
      if [[ "$floor" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] && [ "$(printf '%s\\n%s\\n' "$floor" "$ver" | sort -V | head -n 1)" != "$floor" ]; then rm -f "$file"; echo "below floor"; exit 2; fi
    fi
    next="$app.next"; rm -rf "$next"; install -d -o root -g root -m 0755 "$next"
    tar -xzf "$file" -C "$next" --no-same-owner --no-same-permissions
    chown -R root:root "$next"; chmod -R go-w,a+rX "$next"
    test -f "$next/dist-server/cloud-home-start.js"
    systemctl stop omb-home.service >/dev/null 2>&1 || true
    rm -rf "$app.prev"; [ ! -d "$app" ] || mv "$app" "$app.prev"; mv "$next" "$app"
    for f in installed installed-version; do if [ -f ${ROOT}/$f ]; then mv ${ROOT}/$f ${ROOT}/$f.prev; else rm -f ${ROOT}/$f.prev; fi; done
    echo "$sum" > ${ROOT}/installed; [ -z "$ver" ] || echo "$ver" > ${ROOT}/installed-version; rm -f "$file"
    rm -f ${DESKTOP_IMAGE_STATUS}; desktop
    systemctl try-restart omb-docker-gate.service >/dev/null 2>&1 || true
    echo installed ;;
  rollback)
    # back to the app the last install replaced; the reconciler starts it again
    [ -d "$app.prev" ] && [ -f ${ROOT}/installed.prev ] || { echo "nothing to roll back to"; exit 2; }
    systemctl stop omb-home.service >/dev/null 2>&1 || true
    rm -rf "$app.bad"; mv "$app" "$app.bad"; mv "$app.prev" "$app"; rm -rf "$app.bad"
    mv ${ROOT}/installed.prev ${ROOT}/installed
    if [ -f ${ROOT}/installed-version.prev ]; then mv ${ROOT}/installed-version.prev ${ROOT}/installed-version; else rm -f ${ROOT}/installed-version; fi
    echo "rolled back" ;;
  restore)
    file="$2"
    systemctl stop omb-home.service >/dev/null 2>&1 || true
    machine="$(cat ${CLOUD_HOME.etc}/machine)"
    platform() { case "$1" in ${platformCase}) return 0 ;; esac; return 1; }
    stage="$(mktemp -d /data/.omb-restore.XXXXXX)"
    tar -xf "$file" -C "$stage" --numeric-owner --no-same-permissions --delay-directory-restore
    marker="$(find "$stage" -maxdepth 3 -name .omb-cloud-home.json -type f | head -n 1)"
    [ -n "$marker" ] || { rm -rf "$stage"; echo "not a home backup"; exit 2; }
    grep -q "\\"$machine\\"" "$marker" || { rm -rf "$stage"; echo "another cloud's backup"; exit 2; }
    root="$(dirname "$marker")"
    link="$(mktemp)"; cp ${CLOUD_HOME.data}/dashboard-link.json "$link"
    old="$(mktemp -d /data/.omb-old.XXXXXX)"
    shopt -s dotglob nullglob
    for entry in /data/*; do platform "\${entry##*/}" || mv "$entry" "$old/"; done
    for entry in "$root"/*; do platform "\${entry##*/}" || mv "$entry" /data/; done
    install -d -o maus -g maus -m 0700 ${CLOUD_HOME.data}
    install -o maus -g maus -m 0600 "$link" ${CLOUD_HOME.data}/dashboard-link.json
    for entry in /data/*; do platform "\${entry##*/}" || chown -R maus:maus "$entry"; done
    chown maus:maus /data; chmod 0711 /data; rm -rf "$stage" "$old" "$link" "$file"
    echo restored ;;
  tree) tree "$app" ;;
  start)
    origin="$2"; upstream="\${3:-$2}"
    [[ "$origin" =~ ^https://[a-z0-9.-]+$ ]] || { echo "bad origin"; exit 2; }
    [[ "$upstream" =~ ^https://[a-z0-9.-]+$ ]] || { echo "bad origin"; exit 2; }
    desktop
    # a resume that kept memory left the home running with this origin: nothing to restart
    if systemctl is-active --quiet omb-home.service && grep -qxF "DUSK_PUBLIC_URL=$origin" ${CLOUD_HOME.etc}/home.env && grep -qxF "DUSK_CLOUD_UPSTREAM_HOST=\${upstream#https://}" ${CLOUD_HOME.etc}/home.env \\
      && curl -fsS -m 2 http://127.0.0.1:8799/api/health >/dev/null 2>&1; then echo started; exit 0; fi
    sed -i "/^DUSK_PUBLIC_URL=/d; /^DUSK_CLOUD_UPSTREAM_HOST=/d" ${CLOUD_HOME.etc}/home.env
    echo "DUSK_PUBLIC_URL=$origin" >> ${CLOUD_HOME.etc}/home.env
    echo "DUSK_CLOUD_UPSTREAM_HOST=\${upstream#https://}" >> ${CLOUD_HOME.etc}/home.env
    systemctl enable omb-home.service >/dev/null 2>&1
    if [ -S /var/run/docker.sock ] && [ -f "$app/link/docker-gate.mjs" ]; then systemctl enable --now omb-docker-gate.service >/dev/null 2>&1 || true; fi
    systemctl restart omb-home.service
    for i in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:8799/api/health >/dev/null 2>&1 && { echo started; exit 0; }; sleep 1; done
    echo "not answering"; exit 3 ;;
  stop) systemctl stop omb-home.service; echo stopped ;;
  status) systemctl is-active omb-home.service || true; [ -f ${ROOT}/installed ] && cat ${ROOT}/installed || echo none ;;
  snapshot)
    # the volume as a backup reads it, from the running home: each SQLite database through an online backup, the rest as it is
    out=${INSTABOX_SNAPSHOT_FILE}; part="$out.part"; rm -f "$out" "$part"
    dbs="$(mktemp -d ${INSTABOX_USER_HOME}/.omb-dbs.XXXXXX)"
    sync
    while IFS= read -r -d '' db; do
      install -d "$dbs/$(dirname "$db")"
      ${HOME_NODE_BIN} -e ${shellQuote(DB_COPY)} "/$db" "$dbs/$db" 2>/dev/null || cp -p "/$db" "$dbs/$db"
      chown --reference="/$db" "$dbs/$db"
    done < <(cd / && find data ${PLATFORM_ENTRIES.map(e => `-path 'data/${e}' -prune -o`).join(" ")} -type f -name '*.db' -print0)
    code=0; tar -C / --numeric-owner -cf "$part" ${excludes} --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db-journal' data || code=$?
    # 1: a file changed while it was read (the home runs); anything more is a failure
    [ "$code" -le 1 ] || { rm -rf "$dbs" "$part"; echo "snapshot failed"; exit 3; }
    if [ -d "$dbs/data" ]; then tar -C "$dbs" --numeric-owner -rf "$part" data; fi
    rm -rf "$dbs"; chown user:user "$part"; chmod 0600 "$part"; mv "$part" "$out"
    echo "snapshot $(stat -c %s "$out")" ;;
  snapshot-done) rm -f ${INSTABOX_SNAPSHOT_FILE}; echo removed ;;
  desktop-status)
    s="$(cat ${DESKTOP_IMAGE_STATUS} 2>/dev/null || echo none)"
    if [ "$s" != ready ] && systemctl is-active --quiet omb-desktop-image.service; then echo building; else echo "$s"; fi ;;
  desktop-image)
    # the bot computers' image: the registry's copy when it gives one to anyone, else built here from the signed
    # package's own kit, so a fresh home needs nobody's step and no registry credential
    kit="$app/deploy/bot-desktop"
    install -d -o root -g root -m 0755 ${CLOUD_HOME.run}
    [ -f "$kit/Dockerfile" ] || { echo "no kit"; exit 0; }
    image="$(sed -n 's/^export const BOT_DESKTOP_IMAGE = "\\(.*\\)";.*/\\1/p' "$app/shared/bot-desktop.ts" | head -n 1)"
    [[ "$image" =~ ^[a-z0-9./-]+:v[0-9]+$ ]] || { imaged failed; echo "bad image name"; exit 2; }
    if docker image inspect "$image" >/dev/null 2>&1; then imaged ready; echo ready; exit 0; fi
    imaged building
    if docker pull -q "$image" >/dev/null 2>&1 || IMAGE="$image" sh "$kit/build.sh" > /var/log/omb-desktop-image.log 2>&1; then
      imaged ready; echo ready; exit 0
    fi
    imaged failed; echo "build failed"; exit 3 ;;
  *) echo "usage: omb-home install|rollback|restore|start|stop|status|tree|snapshot|snapshot-done|desktop-image|desktop-status"; exit 2 ;;
esac
`;
}

export function installCommand(sha256: string, url?: string, signature?: string, floor?: string | null): string {
  if (!SHA256.test(sha256)) throw new Error("Invalid home package checksum.");
  if (signature !== undefined && !/^r1\.[a-z0-9-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(signature)) throw new Error("Invalid home package signature.");
  if (floor && (!signature || !/^\d+\.\d+\.\d+$/.test(floor))) throw new Error("Invalid home package floor.");
  const install = `sudo -n ${HOME_CONTROL} install ${INSTABOX_PACKAGE_FILE} ${sha256}${signature ? ` ${signature}` : ""}${floor ? ` ${floor}` : ""}`;
  if (url === undefined) return install;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Invalid home package URL.");
  return `curl -fsSL --retry 3 -o ${INSTABOX_PACKAGE_FILE} ${shellQuote(parsed.href)} && ${install}`;
}
/** `origin`: what people use (ours, through the edge); `upstream`: the machine's own hosted URL, which the edge forwards to */
export function startCommand(origin: string, upstream: string = origin): string {
  for (const value of [origin, upstream]) {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== "https:") throw new Error("Invalid cloud origin.");
  }
  return `sudo -n ${HOME_CONTROL} start ${shellQuote(origin)} ${shellQuote(upstream)}`;
}
export const RESTORE_COMMAND = `sudo -n ${HOME_CONTROL} restore ${INSTABOX_RESTORE_FILE}`;
export const ROLLBACK_COMMAND = `sudo -n ${HOME_CONTROL} rollback`;
export const SNAPSHOT_COMMAND = `sudo -n ${HOME_CONTROL} snapshot`;
export const SNAPSHOT_DONE_COMMAND = `sudo -n ${HOME_CONTROL} snapshot-done`;
export const DESKTOP_STATUS_COMMAND = `sudo -n ${HOME_CONTROL} desktop-status`;

export const HOME_IMAGE: MachineImage = {
  homeVolume: INSTABOX_HOME_VOLUME, packagePath: INSTABOX_PACKAGE_FILE, restorePath: INSTABOX_RESTORE_FILE,
  bootFile, claimBootFile, bootContent, setupScript: homeSetupScript,
  installCommand, startCommand, restoreCommand: RESTORE_COMMAND, rollbackCommand: ROLLBACK_COMMAND, desktopStatusCommand: DESKTOP_STATUS_COMMAND,
};
