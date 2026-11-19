#!/usr/bin/env bash
# a new link service node on a fresh ubuntu 24.04 box (a hetzner cx22 or any small vps), the way oracle-in runs:
# node 24 from nodesource, the service as the dusklink user under systemd, caddy in front for https, coturn beside it.
#
# from the repo root on the mac, with the box's dns name already pointing at it:
#   NODE_ID=hetzner-de DOMAIN=link-de.dusk.bot REGION=eu ALLOWANCE_TB=20 \
#   LINK_NODES="contabo=https://link.dusk.bot@eu,oracle-in=https://link-in.dusk.bot@asia,hetzner-de=https://link-de.dusk.bot@eu" \
#   apps/link-service/deploy/add-node.sh root@<box ip>
# the secrets (LINK_PEER_TOKEN, LINK_STATS_TOKEN, LINK_TURN_SECRET) are read from the environment, the same values every
# node has; they are sent over ssh into a 0600 file and never printed. TURN_SECRET empty: no coturn.
# then: add the node to LINK_NODES on every other node and to the account service's DUSK_LINK_NODES (docs/capacity.md).
set -euo pipefail

target="${1:?usage: add-node.sh root@<box>}"
: "${NODE_ID:?NODE_ID, like hetzner-de}" "${DOMAIN:?DOMAIN, like link-de.dusk.bot}" "${LINK_NODES:?LINK_NODES, every node including this one}"
: "${LINK_PEER_TOKEN:?LINK_PEER_TOKEN (the same on every node)}" "${LINK_STATS_TOKEN:?LINK_STATS_TOKEN}"
REGION="${REGION:-eu}" ALLOWANCE_TB="${ALLOWANCE_TB:-20}" LINK_TURN_SECRET="${LINK_TURN_SECRET:-}"
case ",$LINK_NODES," in *",$NODE_ID=https://$DOMAIN@"*) ;; *) echo "LINK_NODES must list $NODE_ID=https://$DOMAIN@<region>" >&2; exit 1 ;; esac
root="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "== copying the link service to $target"
git -C "$root" archive --format=tar HEAD apps/link-service | ssh "$target" 'rm -rf /tmp/dusk-link-src && mkdir -p /tmp/dusk-link-src && tar -x -C /tmp/dusk-link-src'

echo "== the node's settings"
{
  printf 'PORT=8790\nHOST=127.0.0.1\nLINK_BASE=https://%s\nLINK_DATA_DIR=/var/lib/dusk-link-node\nLINK_PACKAGES_DIR=/var/lib/dusk-link-node/packages\n' "$DOMAIN"
  printf 'LINK_TRUST_PROXY=1\nLINK_NODE_ID=%s\nLINK_NODES=%s\nLINK_ALLOWANCE_TB=%s\n' "$NODE_ID" "$LINK_NODES" "$ALLOWANCE_TB"
  printf 'LINK_PEER_TOKEN=%s\nLINK_STATS_TOKEN=%s\n' "$LINK_PEER_TOKEN" "$LINK_STATS_TOKEN"
  if [ -n "$LINK_TURN_SECRET" ]; then printf 'LINK_TURN_SECRET=%s\n' "$LINK_TURN_SECRET"; fi
} | ssh "$target" 'umask 077 && cat > /tmp/dusk-link-node.env'

echo "== installing (node 24, caddy, ${LINK_TURN_SECRET:+coturn, }the service)"
ssh "$target" DOMAIN="$DOMAIN" NODE_ID="$NODE_ID" TURN="${LINK_TURN_SECRET:+1}" bash -s <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
id dusklink >/dev/null 2>&1 || useradd --system --home /var/lib/dusk-link-node --shell /usr/sbin/nologin dusklink
install -d -o dusklink -g dusklink -m 0700 /var/lib/dusk-link-node
rm -rf /opt/dusk-link-node.new && cp -r /tmp/dusk-link-src/apps/link-service /opt/dusk-link-node.new
[ -d /opt/dusk-link-node ] && mv /opt/dusk-link-node "/opt/dusk-link-node.bak-$(date +%s)"
mv /opt/dusk-link-node.new /opt/dusk-link-node && rm -rf /tmp/dusk-link-src
install -o root -g root -m 0600 /tmp/dusk-link-node.env /etc/dusk-link-node.env && rm -f /tmp/dusk-link-node.env
cat > /etc/systemd/system/dusk-link-node.service <<UNIT
[Unit]
Description=Metal link service, node $NODE_ID
After=network-online.target
Wants=network-online.target

[Service]
User=dusklink
Group=dusklink
EnvironmentFile=/etc/dusk-link-node.env
WorkingDirectory=/opt/dusk-link-node
ExecStart=/usr/bin/node src/server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=/var/lib/dusk-link-node
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
MemoryMax=3G
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
{
	email ops@dusk.bot
}

$DOMAIN {
	reverse_proxy 127.0.0.1:8790 {
		header_up X-Real-IP {remote_host}
		flush_interval -1
		transport http {
			read_timeout 0
			write_timeout 0
			keepalive 50s
			keepalive_idle_conns 512
			keepalive_idle_conns_per_host 256
		}
	}
	request_body {
		max_size 50MB
	}
}
CADDY
if [ -n "${TURN:-}" ]; then
  apt-get install -y -qq coturn >/dev/null
  secret="$(sed -n 's/^LINK_TURN_SECRET=//p' /etc/dusk-link-node.env)"
  public="$(curl -fsS4 https://api.ipify.org)"; private="$(hostname -I | awk '{print $1}')"
  umask 077
  cat > /etc/turnserver.conf <<TURNCONF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$secret
realm=dusk.bot
no-tls
no-dtls
min-port=49160
max-port=49999
total-quota=300
user-quota=12
max-bps=4194304
no-multicast-peers
no-cli
stale-nonce=600
syslog
simple-log
external-ip=$public${private:+/$private}
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
TURNCONF
  chown turnserver:turnserver /etc/turnserver.conf 2>/dev/null || true
  systemctl enable -q coturn && systemctl restart coturn
fi
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; if [ -n "${TURN:-}" ]; then ufw allow 3478 >/dev/null; ufw allow 49160:49999/udp >/dev/null; fi; fi
systemctl daemon-reload
systemctl enable -q dusk-link-node caddy
systemctl restart dusk-link-node caddy
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8790/healthz && break; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:8790/healthz && echo "node $NODE_ID answers on 127.0.0.1:8790"
REMOTE

echo "== checking https://$DOMAIN/healthz (caddy may need a minute for its certificate)"
for _ in $(seq 1 30); do curl -fsS -o /dev/null "https://$DOMAIN/healthz" && { echo "up: https://$DOMAIN"; break; }; sleep 4; done
echo "next: put the same LINK_NODES on every other node and in the account service's DUSK_LINK_NODES, then restart them"
