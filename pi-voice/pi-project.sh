#!/bin/sh
set -eu
cd /mnt/user/fast/home_control
exec /opt/pi/node_modules/.bin/pi "$@"
