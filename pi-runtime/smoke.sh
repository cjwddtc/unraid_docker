#!/bin/bash
# Build-only verification: no data mounts, credentials, microphone or cloud calls.
set -euo pipefail
node --version
pi --version
codex --version
for command in pactl parec pacat paplay aplay arecord ssh sshd ip ping espeak-ng rg firefox-esr; do
    command -v "$command" >/dev/null
done
/opt/pi-voice-wake/bin/python -c 'import numpy, sherpa_onnx; print("wake dependencies:", numpy.__version__, sherpa_onnx.__version__)'
node --input-type=module <<'JS'
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/opt/pi/package.json');
const native = require('@oh-my-pi/pi-natives-linux-x64');
if (typeof native.AudioCapture !== 'function') throw Error('Native audio binding is missing');
for (const name of ['@earendil-works/pi-coding-agent', 'pi-live-codex', 'pi-subagents', '@google/genai', 'ws']) {
    const p = JSON.parse(fs.readFileSync(`/opt/pi/node_modules/${name}/package.json`));
    console.log(name, p.version);
}
await import('/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js');
await import('/usr/local/share/pi-voice/ws-live-transport.mjs');
await import('/usr/local/share/pi-voice/codex-rpc.mjs');
console.log('Agent imports OK');
JS
for file in /usr/local/share/pi-voice/*.sh; do bash -n "$file"; done
for file in /usr/local/share/pi-voice/*.mjs; do node --check "$file"; done
codex app-server daemon --help >/dev/null
