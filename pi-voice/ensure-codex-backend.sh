#!/bin/sh
set -eu
test "$(id -u)" = 1000
export HOME=/data
cd /mnt/user/fast/home_control
mkdir -p /data/codex-bridge /data/runtime
chmod 700 /data/codex-bridge
codex app-server daemon start >/data/codex-bridge/daemon-start.log 2>&1
if node --input-type=module -e "import {bridgeCall} from '/data/codex-bridge-client.mjs'; await bridgeCall({action:'activity'},1000);" >/dev/null 2>&1; then
  exit 0
fi
if ! tmux has-session -t codex-bridge 2>/dev/null; then
  tmux new-session -d -s codex-bridge 'node /data/codex-bridge-service.mjs'
fi
attempt=0
while [ "$attempt" -lt 10 ]; do
  if node --input-type=module -e "import {bridgeCall} from '/data/codex-bridge-client.mjs'; await bridgeCall({action:'activity'},1000);" >/dev/null 2>&1; then exit 0; fi
  attempt=$((attempt+1))
  sleep 0.3
done
echo 'Codex bridge is not ready; inspect /data/codex-bridge/service.log without interrupting the shared daemon.' >&2
exit 1
