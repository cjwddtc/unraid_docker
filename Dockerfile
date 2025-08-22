FROM archlinux:base-devel


RUN echo "Server = https://mirrors.ustc.edu.cn/archlinux/\$repo/os/\$arch" > /etc/pacman.d/mirrorlist
#RUN echo "Server = https://mirrors.kernel.org/archlinux/\$repo/os/\$arch" > /etc/pacman.d/mirrorlist
#RUN chmod 777 -R /tmp/
#RUN rm -rf /tmp/*
#RUN chmod 777 -R /var/cache/pacman/
RUN pacman -Syu --noconfirm&&pacman -Scc --noconfirm
RUN pacman -Syu --noconfirm wget htop git tigervnc xfce4 xfce4-goodies glibc adobe-source-han-sans-cn-fonts\
    adobe-source-han-sans-tw-fonts openssh  adobe-source-han-sans-hk-fonts adobe-source-han-serif-cn-fonts  \
    adobe-source-han-serif-tw-fonts adobe-source-han-serif-hk-fonts wqy-microhei wqy-zenhei wqy-bitmapfont  \
    firefox  qbittorrent-nox qbittorrent  python-pip nano rclone p7zip gawk unzip zip geckodriver\
    ttyd tmux sqlite xorg-server-xvfb x11vnc xterm xorg-server xorg-xinit python supervisor \
    rsync erofs-utils nethogs jre-openjdk less fcitx5-im fcitx5-chinese-addons fcitx5-im fcitx5-pinyin-zhwiki \
    &&pacman -Scc --noconfirm

RUN useradd lsy
RUN mkdir -p /home/lsy
RUN chown lsy -R /home/lsy
RUN echo "lsy ALL=(ALL:ALL) NOPASSWD: ALL" >> /etc/sudoers
RUN <<EOF
set -e
function build_pkg() {
cd /tmp
git clone --branch $1 --single-branch https://github.com/archlinux/aur.git $1
cd $1
chmod 777 -R .
sudo -u lsy makepkg -sLfci --noconfirm
cd ..
rm -rf $1
}
build_pkg yay-bin
build_pkg baidunetdisk-bin
build_pkg fcitx5-pinyin-moegirl
build_pkg tinymediamanager-bin
build_pkg bililive-recorder-bin
build_pkg 115-browser-bin
build_pkg videoduplicatefinder-git
build_pkg websockify
build_pkg inetutils
build_pkg novnc
EOF

#RUN sudo -u lsy yay -S --noconfirm websockify inetutils novnc
#electron11-bin baidunetdisk-electron
#tinymediamanager-bin
#RUN sed -i '$d' /etc/sudoers
#sed "s/getConfigVar('autoconnect', false)/getConfigVar('autoconnect', true)/g" -i /usr/share/webapps/novnc/app/ui.js
RUN python -m venv  /usr/local/
RUN pip install Levenshtein qbittorrent-api lxml requests selenium ffmpeg-python
RUN sed -i 's/NoExtract/#NoExtract/g' -i /etc/pacman.conf
RUN /usr/bin/ssh-keygen -A
RUN systemd-machine-id-setup
RUN echo 'root:root' | chpasswd

# 配置sshd_config文件
RUN sed -i -e 's/^#*\(PermitRootLogin\).*/\1 yes/' /etc/ssh/sshd_config
RUN sed -i -e 's/^#*\(PasswordAuthentication\).*/\1 yes/' /etc/ssh/sshd_config
RUN sed -i -e 's/^#*\(PermitEmptyPasswords\).*/\1 yes/' /etc/ssh/sshd_config
RUN sed -i -e 's/^#*\(UsePAM\).*/\1 no/' /etc/ssh/sshd_config
RUN sudo pacman -Syu  --noconfirm glibc
RUN sed -i 's/#zh_/zh_/g' -i /etc/locale.gen
RUN sed -i 's/#en_US/en_US/g' -i /etc/locale.gen
RUN locale-gen
ENV LANG=zh_CN.UTF-8
ENV LC_ALL=zh_CN.UTF-8
ENV GTK_IM_MODULE=fcitx
ENV QT_IM_MODULE=fcitx
ENV XMODIFIERS="@im=fcitx"
ENV SDL_IM_MODULE=fcitx
ENV GLFW_IM_MODULE=fcitx
#CMD ["vncserver",":5"]
CMD ["bash","/root/startup.sh"]