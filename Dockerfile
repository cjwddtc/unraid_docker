# 基础镜像
FROM debian:trixie-backports
ARG TMM_URL
ARG MEO_DICT_URL
ARG WIKI_DICT_URL
ARG PAN_115_URL
ARG PAN_BAIDU_URL
ARG DEBIAN_MIRROR=deb.debian.org
ARG RUNTIME_DEBIAN_MIRROR=mirrors.ustc.edu.cn
# 环境变量
ENV LANG=zh_CN.UTF-8
ENV LANGUAGE=zh_CN:zh
ENV LC_ALL=zh_CN.UTF-8
ENV DEBIAN_FRONTEND=noninteractive

# 工作目录
WORKDIR /root

# 配置 Debian 源并启用 non-free, contrib
RUN <<EOF
set -e
sed -i "s/deb.debian.org/${DEBIAN_MIRROR}/g" /etc/apt/sources.list.d/debian.sources
sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/g' /etc/apt/sources.list.d/debian.sources
printf '%s\n' \
  'Acquire::Retries "5";' \
  'Acquire::http::Timeout "60";' \
  'Acquire::https::Timeout "60";' \
  'Acquire::http::Pipeline-Depth "0";' \
  >/etc/apt/apt.conf.d/80-retries
EOF

# 设置时区和安装所需软件
RUN <<EOF bash
set -e
apt-get update
apt-get install -y --no-install-recommends wget ca-certificates gnupg
wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
apt-get update
apt-get install -y --no-install-recommends \
    locales\
    tzdata \
    xfce4 xfce4-goodies \
    python3 python3-pip python3-venv \
    fontconfig 7zip libatomic1 runsc\
    fonts-wqy-microhei fonts-wqy-zenhei docker-cli \
    x11vnc tigervnc-standalone-server tigervnc-tools\
    dbus-x11 xfonts-base xfonts-75dpi fcitx5 fonts-noto fuse net-tools websockify\
    wget ca-certificates openssh-server cmake git rsync sudo \
    build-essential ffmpeg google-chrome-stable nano libmediainfo0v5 fcitx5-chinese-addons \
    fcitx5-module-cloudpinyin fcitx5-config-qt libgdiplus tmux curl unzip p7zip-full 7zip-rar file \
    supervisor \
    bluez blueman dbus util-linux \
    pulseaudio pulseaudio-utils alsa-utils libasound2-plugins \
    openssh-client iproute2 iputils-ping procps ripgrep firefox-esr xz-utils
# Keep Bluetooth dependencies in the image instead of installing them at startup.
test -x /usr/libexec/bluetooth/bluetoothd
command -v bluetoothctl
command -v blueman-manager
command -v dbus-daemon
command -v nsenter
apt-get install -y --no-install-recommends -t trixie-backports qbittorrent
EOF
RUN --mount=type=secret,id=root_password <<'EOF' bash
set -euo pipefail
echo "root:$(cat /run/secrets/root_password)" | chpasswd
mkdir -p /usr/share/fcitx5/pinyin/dictionaries/

download() {
  local name="$1"
  local url="$2"
  local output="$3"
  echo "==> Downloading $name"
  echo "    URL: $url"
  wget --tries=10 --timeout=60 --waitretry=5 "$url" -O "$output"
  echo "<== Downloaded $name ($(stat -c%s "$output") bytes)"
}

download "Moegirl dictionary" "$MEO_DICT_URL" /usr/share/fcitx5/pinyin/dictionaries/moegirl.dict
download "ZHWiki dictionary" "$WIKI_DICT_URL" /usr/share/fcitx5/pinyin/dictionaries/zhwiki.dict
download "tinyMediaManager" "$TMM_URL" /tmp/tmm.tar.xz
mkdir -p /opt
cd /opt
tar xf /tmp/tmm.tar.xz
cd tinyMediaManager
cat <<EOM >/usr/share/applications/tinyMediaManager.desktop
[Desktop Entry]
Type=Application
Terminal=false
Name=tinyMediaManager
Icon=/opt/tinyMediaManager/tmm.png
Exec=/opt/tinyMediaManager/tinyMediaManager
EOM
download "115 client" "$PAN_115_URL" /tmp/115.deb
dpkg-deb --info /tmp/115.deb >/dev/null
apt-get install -y /tmp/115.deb
rm /tmp/115.deb
download "Baidu Netdisk" "$PAN_BAIDU_URL" /tmp/baidunetdisk.deb
dpkg-deb --info /tmp/baidunetdisk.deb >/dev/null
apt-get install -y /tmp/baidunetdisk.deb
rm /tmp/baidunetdisk.deb
download "ttyd" "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64" /usr/local/bin/ttyd
chmod +x /usr/local/bin/ttyd
echo "PermitRootLogin yes" >> /etc/ssh/sshd_config
echo "zh_CN.UTF-8 UTF-8" > /etc/locale.gen
locale-gen
curl https://rclone.org/install.sh |  bash
update-locale LANG=zh_CN.UTF-8
ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
echo "Asia/Shanghai" > /etc/timezone
apt-get clean
rm -rf /var/lib/apt/lists/*
EOF
RUN <<EOF bash
set -e
python3 -m venv /usr/local
pip3 install \
    fastapi \
    "uvicorn[standard]" \
    "sqlalchemy[asyncio]" \
    python-Levenshtein \
    requests \
    qbittorrent-api \
    python-multipart \
    python-dotenv \
    aiosqlite \
    ffmpeg-python \
    lxml \
    selenium \
    uv \
    defusedxml \
    httpx \
    "PyYAML>=6.0" \
    "openai>=3.49.0" \
    "pydantic-ai-slim[openai]==2.68.0" \
    "beautifulsoup4>=4.12.3"
# Verify tv_auto_web's async database and subtitle parsing dependencies at build time.
python3 -c "import greenlet, aiosqlite; from sqlalchemy.ext.asyncio import create_async_engine"
python3 -c "from bs4 import BeautifulSoup; assert BeautifulSoup('<p>subtitle</p>', 'html.parser').p.get_text() == 'subtitle'"
python3 -c "from pydantic_ai import Agent, ModelRetry, ToolOutput; from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel; from pydantic_ai.providers.openai import OpenAIProvider; from pydantic_ai.providers.openai_chatgpt import OpenAIChatGPTProvider"
python3 -c "import yaml; from openai import APIConnectionError, APIStatusError, AsyncOpenAI; client = AsyncOpenAI(api_key='build-check'); assert callable(client.responses.create); assert yaml.safe_load('enabled: true')['enabled'] is True"
EOF
RUN <<EOF
set -e
sed -i "s#${DEBIAN_MIRROR}#${RUNTIME_DEBIAN_MIRROR}#g" /etc/apt/sources.list.d/debian.sources
EOF

# noVNC runs in the browser; Debian websockify serves the files and proxies VNC.
RUN <<'EOF' bash
set -euo pipefail
version=1.6.0
release="noVNC-$version"
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
curl -fsSL --retry 3 "https://codeload.github.com/novnc/noVNC/tar.gz/refs/tags/v$version" -o "$archive"
printf '%s  %s\n' 5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa "$archive" | sha256sum -c -
install -d /usr/share/novnc
tar -xzf "$archive" -C /usr/share/novnc --strip-components=1 --no-same-owner \
  "$release/app" "$release/core" "$release/vendor" "$release/utils/novnc_proxy" \
  "$release/vnc.html" "$release/vnc_lite.html" "$release/defaults.json" \
  "$release/mandatory.json" "$release/LICENSE.txt" "$release/AUTHORS"
ln -s vnc.html /usr/share/novnc/vnc_auto.html
printf '%s\n' '#!/bin/sh' 'exec /usr/share/novnc/utils/novnc_proxy "$@"' > /usr/bin/novnc
chmod 0755 /usr/bin/novnc
EOF

RUN <<'EOF' bash
set -euo pipefail
node_version=24.22.3
case "$(dpkg --print-architecture)" in
  amd64) node_arch=x64; checksum=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;;
  arm64) node_arch=arm64; checksum=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c ;;
  ppc64el) node_arch=ppc64le; checksum=c4b446699171f64763304a0bc6fb972b0fb4acb1de5358e52b4c52a95883593a ;;
  s390x) node_arch=s390x; checksum=b5dbeb563ffb81946478fd765ae92efc21117e410e4e9b7d966bf59b00cee55d ;;
  *) echo "No pinned Node.js release for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
release="node-v$node_version-linux-$node_arch"
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
curl -fsSL --retry 3 "https://nodejs.org/dist/v$node_version/$release.tar.xz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
tar -xJf "$archive" -C /usr/local --strip-components=1 --no-same-owner \
  "$release/bin/node" "$release/bin/npm" "$release/bin/npx" \
  "$release/lib/node_modules/npm" "$release/include/node"
ln -s node /usr/local/bin/nodejs
if [ -e /usr/bin/node ] || [ -L /usr/bin/node ]; then
  echo "Debian packages installed a second Node.js runtime" >&2
  exit 1
fi
test "$(command -v node)" = /usr/local/bin/node
test "$(node --version)" = "v$node_version"
npm --version
EOF

COPY codex.version /usr/local/share/codex.version
RUN --mount=type=cache,target=/root/.npm <<'EOF' bash
set -e
version="$(cat /usr/local/share/codex.version)"
npm install --global --prefix /usr/local --no-audit --no-fund "@openai/codex@$version"
test "$(codex --version)" = "codex-cli $version"
EOF

ENV GTK_IM_MODULE=fcitx
ENV QT_IM_MODULE=fcitx
ENV XMODIFIERS="@im=fcitx"
ENV SDL_IM_MODULE=fcitx
ENV GLFW_IM_MODULE=fcitx


CMD ["bash","/root/startup.sh"]
