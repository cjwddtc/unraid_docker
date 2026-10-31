#!/bin/bash
set -euo pipefail
node_version=${1:?Node version required}
test "$(dpkg --print-architecture)" = amd64
runtime=/opt/pi-image
assets=/usr/local/share/pi-runtime
mkdir -p "$runtime/usr-local" "$runtime/pi" "$runtime/codex"
download_dir=$(mktemp -d)
trap 'rm -rf "$download_dir"' EXIT
archive="node-v${node_version}-linux-x64.tar.xz"
curl --fail --location --retry 5 "https://nodejs.org/dist/v${node_version}/${archive}" -o "$download_dir/$archive"
curl --fail --location --retry 5 "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
awk -v name="$archive" '$2 == name { print }' "$download_dir/SHASUMS256.txt" > "$download_dir/selected.sha256"
test -s "$download_dir/selected.sha256"
(cd "$download_dir" && sha256sum -c selected.sha256)
tar -xJf "$download_dir/$archive" --strip-components=1 -C "$runtime/usr-local"
for command in node npm npx; do
    ln -sfn "$runtime/usr-local/bin/$command" "/usr/local/bin/$command"
done
for package in pi codex; do
    cp "$assets/$package/package.json" "$assets/$package/package-lock.json" "$runtime/$package/"
    npm ci --prefix "$runtime/$package" --no-audit --no-fund
    ln -sfn "$runtime/$package" "/opt/$package"
    ln -sfn "/opt/$package/node_modules/.bin/$package" "/usr/local/bin/$package"
done
/usr/bin/python3 -m venv "$runtime/pi-voice-wake"
"$runtime/pi-voice-wake/bin/pip" install --no-cache-dir -r "$assets/requirements.txt"
ln -sfn "$runtime/pi-voice-wake" /opt/pi-voice-wake
install -m 644 /usr/local/share/pi-voice/broker-capture.ts /opt/pi/node_modules/pi-live-codex/broker-capture.ts
install -m 755 /usr/local/share/pi-voice/voice-notify.py "$runtime/usr-local/bin/pi-voice-notify"
ln -sfn "$runtime/usr-local/bin/pi-voice-notify" /usr/local/bin/pi-voice-notify
