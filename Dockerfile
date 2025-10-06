# 基础镜像
FROM debian:13
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
    locales \
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

echo "root:1234" | chpasswd
mkdir -p /usr/share/fcitx5/pinyin/dictionaries/
wget https://github.com/outloudvi/mw2fcitx/releases/download/20250909/moegirl.dict -O /usr/share/fcitx5/pinyin/dictionaries/moegirl.dict
wget https://github.com/felixonmars/fcitx5-pinyin-zhwiki/releases/download/0.2.5/zhwiki-20250823.dict -O /usr/share/fcitx5/pinyin/dictionaries/zhwiki.dict
wget https://release.tinymediamanager.org/v5/dist/tinyMediaManager-5.2.2-linux-amd64.tar.xz -O /tmp/tmm.tar.xz
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
wget  https://down.115.com/client/115pc/lin/115br_v36.0.0.deb -O /tmp/115.deb
apt install -y /tmp/115.deb
rm /tmp/115.deb
wget  http://wppkg.baidupcs.com/issue/netdisk/Linuxguanjia/4.17.7/baidunetdisk_4.17.7_amd64.deb -O /tmp/baidunetdisk.deb
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
