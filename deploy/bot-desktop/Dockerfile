# Metal desktop: a small dark Linux desktop for a workspace or bot, driven by Cua Driver and viewed through noVNC.
# Multi-arch (linux/amd64, linux/arm64). Build: deploy/bot-desktop/build.sh
ARG DEBIAN=debian:trixie-slim

# art: the wallpaper and dock icons are rendered once here, so no image tooling ships in the desktop.
# wallpaper/wallpaper.* (one file, swap it to change the desktop) is cover-scaled onto black at exactly the screen size
# with a sharp filter, so the session can place it pixel for pixel. dock icons are rendered at 2x with real alpha (tint2
# scales them to 34px), from flat svgs with no shadow layers (icons/README.md).
FROM ${DEBIAN} AS art
ARG RESOLUTION=1280x800
RUN apt-get update \
 && apt-get install -y --no-install-recommends imagemagick librsvg2-bin \
 && rm -rf /var/lib/apt/lists/*
COPY wallpaper/ /src/wallpaper/
COPY icons/ /src/icons/
RUN set -eux; mkdir -p /out/icons; \
    src="$(ls /src/wallpaper/wallpaper.* | head -n 1)"; \
    magick "$src" -background black -alpha remove -alpha off -filter Lanczos -resize "${RESOLUTION}^" \
      -gravity center -extent "${RESOLUTION}" -colorspace Gray /out/wallpaper.png; \
    for icon in browser tools terminal; do rsvg-convert -w 68 -h 68 "/src/icons/$icon.svg" -o "/out/icons/$icon.png"; done

FROM ${DEBIAN} AS driver
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends binutils ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) url='https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.47.24/cua_driver-0.47.24-py3-none-manylinux_2_31_x86_64.whl'; sha='6e7c068faff0e97f0db1fdafaa7bab39c3cd1f6314cb3c25369d2e34953ffd21' ;; \
      arm64) url='https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.47.24/cua_driver-0.47.24-py3-none-manylinux_2_31_aarch64.whl'; sha='e94c1857cc59e179930b4bbdf8bc0deb9ab6d38b1d48411bbbfab20085ec7f5c' ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "$url" -o /tmp/cua.whl; \
    echo "$sha  /tmp/cua.whl" | sha256sum -c -; \
    python3 -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); open(sys.argv[2], "wb").write(z.read("cua_driver/bin/cua-driver"))' /tmp/cua.whl /tmp/cua-driver; \
    strip --strip-unneeded /tmp/cua-driver; \
    install -D -m 0755 /tmp/cua-driver /out/cua-driver; \
    rm -f /tmp/cua.whl /tmp/cua-driver

FROM ${DEBIAN}
ARG TARGETARCH
ARG CUA_DRIVER_VERSION=0.47.24
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
COPY trim-icons.py /tmp/omb-trim-icons.py

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      tigervnc-standalone-server tigervnc-tools python3-websockify \
      openbox tint2 hsetroot \
      chromium xfce4-terminal thunar \
      dbus dbus-x11 at-spi2-core libxtst6 libxkbcommon0 \
      adwaita-icon-theme papirus-icon-theme librsvg2-common gtk-update-icon-cache fonts-inter fonts-jetbrains-mono fonts-dejavu-core fonts-liberation2 \
      fonts-noto-core fonts-noto-color-emoji fonts-wqy-microhei \
      python3-pil iptables iproute2 tini \
      ca-certificates curl git jq less nano unzip procps sudo; \
    apt-get purge -y --auto-remove; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc/* /usr/share/man/* /usr/share/info/* \
      /usr/share/applications/*openbox* /usr/share/xsessions; \
    find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name 'en*' -exec rm -rf {} +; \
    # papirus-dark (svg icons: librsvg2-common is the pixbuf loader) with its default blue folders only
    rm -rf /usr/share/icons/Papirus-Light /usr/share/icons/ePapirus /usr/share/icons/ePapirus-Dark; \
    find /usr/share/icons/Papirus /usr/share/icons/Papirus-Dark -path '*/places/*' -regextype posix-extended \
      -regex '.*/(folder|user)-(adwaita|black|bluegrey|breeze|brown|carmine|cyan|darkcyan|deeporange|green|grey|indigo|magenta|nordic|orange|palebrown|paleorange|pink|red|teal|violet|white|yaru|yellow)(-[^/]*)?\.svg' \
      -delete; \
    find /usr/share/icons/Papirus /usr/share/icons/Papirus-Dark -xtype l -delete; \
    python3 -I /tmp/omb-trim-icons.py /usr/share/icons /usr/share/applications; \
    rm -f /tmp/omb-trim-icons.py; \
    for t in Papirus Papirus-Dark hicolor Adwaita; do gtk-update-icon-cache -q -f "/usr/share/icons/$t"; done

# noVNC's web client only (Debian's package pulls in Node.js for its tooling), pinned by SHA-256.
RUN set -eux; \
    curl -fsSL https://github.com/novnc/noVNC/archive/refs/tags/v1.6.0.tar.gz -o /tmp/novnc.tgz; \
    echo '5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa  /tmp/novnc.tgz' | sha256sum -c -; \
    install -d /usr/share/novnc; \
    tar -xzf /tmp/novnc.tgz -C /usr/share/novnc --strip-components=1 noVNC-1.6.0/app noVNC-1.6.0/core \
      noVNC-1.6.0/vendor noVNC-1.6.0/vnc.html noVNC-1.6.0/vnc_lite.html noVNC-1.6.0/LICENSE.txt; \
    rm -f /tmp/novnc.tgz

COPY --from=driver /out/cua-driver /usr/local/libexec/duskbot/cua-driver

# The harness's screenshot transfer runs /opt/venv/bin/python with Pillow; the system python has it.
# Two modes (omb-init): "free" (the host fences the network, the bot has sudo and a writable root) and "strict" (the box
# fences itself, read-only root, no sudo). Runtime state points into /run, /tmp or the home volume in both.
RUN set -eux; \
    test "$(/usr/local/libexec/duskbot/cua-driver --version)" = "cua-driver ${CUA_DRIVER_VERSION}"; \
    install -d /opt/venv/bin; ln -s /usr/bin/python3 /opt/venv/bin/python; \
    useradd --uid 1000 --user-group --create-home --shell /bin/bash cua; \
    install -d -o cua -g cua -m 0700 /home/cua/Downloads /home/cua/workspace /home/cua/scratch; \
    printf '%s\n' "PS1='\\[\\e[38;5;208m\\]\\h-cloud\\[\\e[0m\\]:\\w\\$ '" >> /home/cua/.bashrc; \
    rm -rf /var/log/supervisor; ln -s /tmp/omb-log /var/log/supervisor; \
    rm -f /etc/machine-id /var/lib/dbus/machine-id; ln -s /run/omb/machine-id /etc/machine-id; \
    ln -s /run/omb/machine-id /var/lib/dbus/machine-id; \
    printf '%s\n' 'cua ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/cua; chmod 0440 /etc/sudoers.d/cua; \
    find / -xdev -type f -perm /6000 ! -path /usr/bin/sudo -exec chmod a-s {} +; \
    fc-cache -f

COPY --from=art /out/wallpaper.png /usr/share/omb-desktop/wallpaper.png
COPY --from=art /out/icons/ /usr/share/omb-desktop/icons/
COPY rootfs/ /
COPY host-fence.sh /usr/local/bin/omb-host-fence
COPY blank-cursors.py /tmp/omb-blank-cursors.py
RUN chmod 0755 /usr/local/bin/omb-* && chmod 0644 /etc/chromium.d/omb \
 && python3 -I /tmp/omb-blank-cursors.py /usr/share/icons/Adwaita/cursors /usr/share/icons/omb-hidden \
 && rm -f /tmp/omb-blank-cursors.py /usr/share/icons/default/index.theme \
 && printf '%s\n' '[Icon Theme]' 'Inherits=omb-hidden' > /usr/share/icons/default/index.theme

ARG BOT_DESKTOP_VERSION=6
# label names from before the rename: servers and apps find this image by them (DOCKER_NAMES, electron/legacy-names.mjs)
LABEL com.openmausbot.bot-desktop="${BOT_DESKTOP_VERSION}" \
      com.openmausbot.cua-driver="${CUA_DRIVER_VERSION}" \
      org.opencontainers.image.title="dusk-desktop" \
      org.opencontainers.image.description="Metal computer: a sandboxed dark Linux desktop" \
      org.opencontainers.image.source="https://github.com/parasource-si/metal"

ENV HOME=/home/cua USER=cua DISPLAY=:1 XDG_RUNTIME_DIR=/run/user/1000 XDG_CONFIG_HOME=/home/cua/.config \
    XCURSOR_THEME=omb-hidden XCURSOR_SIZE=24 NO_AT_BRIDGE=0 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
WORKDIR /home/cua
EXPOSE 6901
STOPSIGNAL SIGTERM
# root only to prepare the box, then the session runs as uid 1000
ENTRYPOINT ["/usr/local/bin/omb-init"]
