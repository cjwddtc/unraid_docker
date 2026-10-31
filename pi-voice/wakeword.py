"""Local wake-only listener. No audio is saved or sent to the network."""
import json
import subprocess
import time
import uuid
from pathlib import Path
import numpy as np
import sherpa_onnx

ROOT = Path('/data')
MODEL = ROOT / 'models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
LOCK = ROOT / '.pi/pi-live-codex.lock/owner.json'

def status(mode, **extra):
    data = dict(mode=mode, updated=time.time(), **extra)
    temp = ROOT / 'wake-status.tmp'
    temp.write_text(json.dumps(data), encoding='utf8')
    temp.replace(ROOT / 'wake-status.json')

def request_live():
    root=ROOT/'runtime/voice-control'
    root.mkdir(parents=True,exist_ok=True)
    ident=str(uuid.uuid4())
    temp=root/(ident+'.tmp')
    temp.write_text(json.dumps(dict(id=ident,action='start',source='wakeword',created=time.time())),encoding='utf8')
    temp.replace(root/(ident+'.json'))

def main():
    words = ROOT / 'wake-keywords.txt'
    words.write_text('n ǐ h ǎo zh ù sh ǒu @resume\n', encoding='utf8')
    suffix = '-epoch-99-avg-1-chunk-16-left-64.int8.onnx'
    spotter = sherpa_onnx.KeywordSpotter(tokens=str(MODEL / 'tokens.txt'),
        encoder=str(MODEL / ('encoder' + suffix)), decoder=str(MODEL / ('decoder' + suffix)),
        joiner=str(MODEL / ('joiner' + suffix)), keywords_file=str(words),
        num_threads=1, provider='cpu', keywords_score=1.0, keywords_threshold=.3, num_trailing_blanks=2)
    while True:
        if not (ROOT / 'wake-enabled').exists() or not (ROOT / '.pi/agent/auth.json').exists():
            status('disabled'); time.sleep(1); continue
        if LOCK.exists():
            status('live'); time.sleep(.5); continue
        stream = spotter.create_stream()
        proc = subprocess.Popen(['parec', '--device=mcp01_mic', '--rate=16000', '--channels=1', '--format=float32le', '--raw'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            status('listening')
            while not LOCK.exists() and (ROOT / 'wake-enabled').exists():
                raw = proc.stdout.read(3200)
                if len(raw) < 3200:
                    raise RuntimeError('Audio source stopped')
                stream.accept_waveform(16000, np.frombuffer(raw, dtype='<f4'))
                while spotter.is_ready(stream):
                    spotter.decode_stream(stream)
                word = spotter.get_result(stream)
                if word != 'resume':
                    continue
                status('triggered', action=word)
                proc.terminate(); proc.wait(timeout=3)
                request_live()
                time.sleep(5)
                break
        finally:
            if proc.poll() is None:
                proc.terminate()
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
        time.sleep(1)

if __name__ == '__main__':
    while True:
        try: main()
        except Exception as e:
            status('error', error=str(e)[:200])
            time.sleep(5)
