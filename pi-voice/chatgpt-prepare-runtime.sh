#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
if [[ -x /opt/pi-image/usr-local/bin/node ]]; then
  runtime=/opt/pi-image
else
  # Compatibility with the current container and images built before bundling Pi.
  runtime=/opt/pi-voice-runtime
fi
test -x "$runtime/usr-local/bin/node"
if ! id chatgpt >/dev/null 2>&1; then
  if getent passwd 1000 >/dev/null; then
    echo 'UID1000 is already assigned to another account; refusing to replace it' >&2
    exit 1
  fi
  getent group 1000 >/dev/null || groupadd -g 1000 chatgpt
  useradd -u 1000 -g 1000 -d /data -s /bin/bash chatgpt
fi
usermod -d /data chatgpt
for package in pulseaudio pulseaudio-utils alsa-utils libasound2-plugins tmux python3 openssh-client openssh-server iproute2 espeak-ng ffmpeg procps ripgrep firefox-esr; do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      pulseaudio pulseaudio-utils alsa-utils libasound2-plugins tmux python3 \
      openssh-client openssh-server iproute2 espeak-ng ffmpeg procps ripgrep firefox-esr
    break
  fi
done
mkdir -p /usr/local/bin /opt
for name in pi codex pi-voice-wake; do
  if [[ -e /opt/$name && ! -L /opt/$name ]]; then
    echo "Refusing to replace existing /opt/$name directory" >&2
    exit 1
  fi
  ln -sfn "$runtime/$name" "/opt/$name"
done
ln -sfn "$runtime/usr-local/bin/node" /usr/local/bin/node
ln -sfn "$runtime/usr-local/lib/node_modules/npm/bin/npm-cli.js" /usr/local/bin/npm
ln -sfn "$runtime/usr-local/lib/node_modules/npm/bin/npx-cli.js" /usr/local/bin/npx
ln -sfn /data/pi-project.sh /usr/local/bin/pi
ln -sfn /data/codex-project.sh /usr/local/bin/codex
ln -sfn "$runtime/usr-local/bin/pi-voice-notify" /usr/local/bin/pi-voice-notify
if ! getent group 17 >/dev/null; then groupadd -g 17 nas-audio; fi
sound_group=$(getent group 17 | cut -d: -f1)
usermod -aG "$sound_group" chatgpt
node --version
pi --version
codex --version
/opt/pi-voice-wake/bin/python -c 'import numpy, sherpa_onnx'
if [[ -f /root/pi-voice/sshd_config ]]; then
  mkdir -p /run/sshd /root/pi-voice/ssh /data/.ssh
  chmod 700 /root/pi-voice/ssh /data/.ssh
  chown 1000:1000 /data/.ssh
  if [[ ! -f /root/pi-voice/ssh/ssh_host_ed25519_key ]]; then
    ssh-keygen -q -t ed25519 -N '' -f /root/pi-voice/ssh/ssh_host_ed25519_key
  fi
  touch /data/.ssh/authorized_keys
  chown 1000:1000 /data/.ssh/authorized_keys
  chmod 600 /data/.ssh/authorized_keys
  # No usable account password; SSH permits public-key authentication only.
  usermod -p '*' chatgpt
  /usr/sbin/sshd -t -f /root/pi-voice/sshd_config
fi
