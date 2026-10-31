#!/bin/sh
set -eu
export HOME=/data XDG_RUNTIME_DIR=/data/runtime
export PULSE_SERVER=unix:/data/runtime/pulse/native
cd /mnt/user/fast/home_control
stop() {
  trap - INT TERM EXIT
  pi-voice-notify --pause >/dev/null 2>&1 || true
  tmux send-keys -t pi-ws /quit Enter 2>/dev/null || true
  exit 0
}
if tmux has-session -t pi-ws 2>/dev/null; then
  echo 'Existing Pi session found; refusing duplicate launch' >&2
  exit 1
fi
trap stop INT TERM EXIT
tmux new-session -d -s pi-ws /data/run-ws-dev.sh
while tmux has-session -t pi-ws 2>/dev/null; do sleep 2; done
trap - EXIT
exit 1
