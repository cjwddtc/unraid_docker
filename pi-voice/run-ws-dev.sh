#!/bin/sh
set -eu
test "$(id -u)" = 1000
export HOME=/data XDG_RUNTIME_DIR=/data/runtime
export PULSE_SERVER=unix:/data/runtime/pulse/native
export PI_VOICE_PROVIDER="${1:-$(cat /data/ws-provider 2>/dev/null || echo openai)}"
case "$PI_VOICE_PROVIDER" in openai|qwen) ;; *) echo 'Provider must be openai or qwen' >&2; exit 1;; esac
printf '%s\n' "$PI_VOICE_PROVIDER" > /data/ws-provider
cd /mnt/user/fast/home_control
/data/ensure-codex-backend.sh
mkdir -p /data/runtime /data/.config/pulse /data/gemini-sessions
chmod 700 /data/runtime
if ! pactl info >/dev/null 2>&1; then
  pulseaudio -nF /data/pulse.pa --daemonize=yes --exit-idle-time=-1 --log-target=file:/data/pulse.log --use-pid-file=yes
fi
/opt/pi-voice-wake/bin/python /data/vad-broker.py >/data/vad-broker.log 2>&1 &
broker_pid=$!
/opt/pi-voice-wake/bin/python /data/wakeword.py >/data/wakeword.log 2>&1 &
wake_pid=$!
trap 'kill "$broker_pid" "$wake_pid" 2>/dev/null || true' EXIT
pi --continue --session-dir /data/gemini-sessions --name 'Pi语音' \
  --no-extensions \
  -e builtin:mcp \
  -e /opt/pi/node_modules/pi-subagents/bundle/index.js \
  --skill /data/.pi/agent/skills/codex-control/SKILL.md \
  -e /data/codex-control.ts \
  -e /data/ws-live.ts -e /data/voice-policy.ts
