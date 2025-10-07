# 基础镜像
FROM debian:trixie-backports
ARG TMM_URL
ARG MEO_DICT_URL
ARG WIKI_DICT_URL
ARG PAN_115_URL
ARG PAN_BAIDU_URL
# 环境变量
ENV LANG=zh_CN.UTF-8
ENV LANGUAGE=zh_CN:zh
ENV LC_ALL=zh_CN.UTF-8
ENV DEBIAN_FRONTEND=noninteractive

# 工作目录
WORKDIR /root

# 替换为中科大源
RUN <<EOF
sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources
EOF

# 设置时区和安装所需软件
RUN <<EOF bash
set -e
apt-get update
apt-get install -y --no-install-recommends \
    locales\
    tzdata \
    xfce4 xfce4-goodies \
    python3 python3-pip python3-venv \
    fontconfig 7zip\
    fonts-wqy-microhei fonts-wqy-zenhei \
    x11vnc tigervnc-standalone-server tigervnc-tools\
    dbus-x11 xfonts-base xfonts-75dpi fcitx5 fonts-noto fuse novnc websockify\
    wget ca-certificates openssh-server cmake git rsync sudo \
    build-essential ffmpeg  firefox-esr nano libmediainfo0v5 fcitx5-chinese-addons \
    fcitx5-module-cloudpinyin fcitx5-config-qt tmux curl unzip p7zip-full file
apt-get install -t trixie-backports qbittorrent
EOF
RUN <<EOF bash
echo "root:root" | chpasswd
mkdir -p /usr/share/fcitx5/pinyin/dictionaries/
wget $MEO_DICT_URL -O /usr/share/fcitx5/pinyin/dictionaries/moegirl.dict
wget $WIKI_DICT_URL -O /usr/share/fcitx5/pinyin/dictionaries/zhwiki.dict
wget $TMM_URL -O /tmp/tmm.tar.xz
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
wget $PAN_115_URL -O /tmp/115.deb
apt install -y /tmp/115.deb
rm /tmp/115.deb
wget $PAN_BAIDU_URL -O /tmp/baidunetdisk.deb
apt install -y /tmp/baidunetdisk.deb
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
pip3 install requests  Levenshtein ffmpeg-python  qbittorrent-api lxml selenium
EOF
ENV GTK_IM_MODULE=fcitx
ENV QT_IM_MODULE=fcitx
ENV XMODIFIERS="@im=fcitx"
ENV SDL_IM_MODULE=fcitx
ENV GLFW_IM_MODULE=fcitx


CMD ["bash","/root/startup.sh"]
