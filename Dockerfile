FROM archlinux:base-devel AS builder
RUN echo "Server = https://mirrors.ustc.edu.cn/archlinux/\$repo/os/\$arch" > /etc/pacman.d/mirrorlist

# 更新 + 基础工具 + AUR 构建所需
RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm --needed git sudo fakeroot base-devel binutils which && \
    pacman -Scc --noconfirm

# 非 root 用户构建 AUR（避免污染 root 环境）
RUN useradd -m -s /bin/bash lsy && \
    echo "lsy ALL=(ALL:ALL) NOPASSWD: ALL" >> /etc/sudoers

# 构建 AUR 包并收集 *.pkg.tar.* 到 /pkgs
# 注：保留与原逻辑一致的构建方式（构建后安装，再从缓存和输出收集包）
RUN <<'EOF'
set -euo pipefail
mkdir -p /tmp/build /pkgs
chown -R lsy:lsy /tmp/build /pkgs

build_pkg() {
  local pkg="$1"
  cd /tmp/build
  # 与原始写法保持一致（如后续你愿意，可替换为 aur.archlinux.org 的每包仓库地址）
  git clone --branch "$pkg" --single-branch https://github.com/archlinux/aur.git "$pkg"
  cd "$pkg" || exit 1
  chmod 777 -R .
  # 使用非 root 用户构建并安装（以便后续在缓存/输出中获得包文件）
  sudo -u lsy makepkg -sLfci --noconfirm
  # 收集产物（makepkg 输出目录和 pacman 缓存）
  find . -maxdepth 1 -type f -name "*.pkg.tar.*" -exec cp -f {} /pkgs/ \; || true
  cd /tmp/build
  rm -rf "$pkg"
}

build_pkg yay-bin
build_pkg baidunetdisk-bin
build_pkg fcitx5-pinyin-moegirl
build_pkg tinymediamanager-bin
build_pkg bililive-recorder-bin
build_pkg 115-browser-bin
build_pkg videoduplicatefinder-git
build_pkg websockify
build_pkg novnc


EOF

# 运行时镜像（仅包含必要运行依赖）
FROM archlinux:base
RUN echo "Server = https://mirrors.ustc.edu.cn/archlinux/\$repo/os/\$arch" > /etc/pacman.d/mirrorlist

# 合并系统更新与运行时依赖安装，安装完成后清缓存
# 如无图形界面需求，可按需移除 xfce4/novnc/xorg 等以进一步瘦身
RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm --needed wget htop git tigervnc xfce4 xfce4-goodies glibc \
      adobe-source-han-sans-cn-fonts adobe-source-han-sans-tw-fonts adobe-source-han-sans-hk-fonts \
      adobe-source-han-serif-cn-fonts adobe-source-han-serif-tw-fonts adobe-source-han-serif-hk-fonts \
      wqy-microhei wqy-zenhei wqy-bitmapfont firefox qbittorrent-nox qbittorrent python-pip nano rclone \
      p7zip gawk unzip zip geckodriver ttyd tmux sqlite xorg-server-xvfb x11vnc xterm xorg-server xorg-xinit \
      python supervisor rsync erofs-utils nethogs jre-openjdk inetutils less fcitx5-im fcitx5-chinese-addons \
      fcitx5-im fcitx5-pinyin-zhwiki openssh && \
    pacman -Scc --noconfirm
RUN --mount=type=bind,from=builder,source=/pkgs,target=/tmp/pkgs,ro \
    set -euo pipefail; \
    if ls /tmp/pkgs/*.pkg.tar.* >/dev/null 2>&1; then \
      pacman -U --noconfirm /tmp/pkgs/*.pkg.tar.zst; \
    fi  && \
    rm -rf /var/cache/pacman/pkg/*

# Python 环境与依赖（无缓存安装，减少层大小）
# 若你已有 requirements.txt，可替换为：pip install --no-cache-dir -r requirements.txt
RUN python -m venv /usr/local && \
    /usr/local/bin/pip install --no-cache-dir --upgrade pip && \
    /usr/local/bin/pip install --no-cache-dir Levenshtein qbittorrent-api lxml requests selenium ffmpeg-python && \
    rm -rf /root/.cache

# 系统配置与本地化
RUN sed -i 's/NoExtract/#NoExtract/g' /etc/pacman.conf && \
    /usr/bin/ssh-keygen -A && \
    systemd-machine-id-setup && \
    echo 'root:root' | chpasswd && \
    sed -i -e 's/^#*\(PermitRootLogin\).*/\1 yes/' \
           -e 's/^#*\(PasswordAuthentication\).*/\1 yes/' \
           -e 's/^#*\(PermitEmptyPasswords\).*/\1 yes/' \
           -e 's/^#*\(UsePAM\).*/\1 no/' /etc/ssh/sshd_config && \
    pacman -Syu --noconfirm glibc && \
    sed -i 's/#zh_/zh_/g' /etc/locale.gen && \
    sed -i 's/#en_US/en_US/g' /etc/locale.gen && \
    locale-gen

ENV LANG=zh_CN.UTF-8
ENV LC_ALL=zh_CN.UTF-8
ENV GTK_IM_MODULE=fcitx
ENV QT_IM_MODULE=fcitx
ENV XMODIFIERS="@im=fcitx"
ENV SDL_IM_MODULE=fcitx
ENV GLFW_IM_MODULE=fcitx


#CMD ["vncserver",":5"]
CMD ["bash","/root/startup.sh"]