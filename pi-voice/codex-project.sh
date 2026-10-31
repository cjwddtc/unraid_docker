#!/bin/sh
set -eu
cd /mnt/user/fast/home_control
exec /opt/codex/node_modules/.bin/codex "$@"
