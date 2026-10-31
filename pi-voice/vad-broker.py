"""Local Silero VAD and RAM-only microphone buffering; never saves audio."""
import collections
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import threading
import time
import uuid
import numpy as np
import sherpa_onnx

ROOT=Path('/data')
RUN=ROOT/'runtime'
CONTROL=RUN/'voice-control'
lock=threading.Lock()
ring=collections.deque(maxlen=24)  # 768ms pre-roll
backlog=[]
pending_until=0.0
clients=[]
last_voice=0.0
last_trigger=0.0

def atomic(path, value):
    tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value),encoding='utf8')
    tmp.replace(path)

def request(action):
    ident=str(uuid.uuid4())
    atomic(CONTROL/(ident+'.json'),dict(id=ident,action=action,source='vad',created=time.time()))

def reader_state():
    try: return json.loads((RUN/'voice-state.json').read_text())
    except (OSError,ValueError): return {}

def serve():
    global backlog,pending_until
    path=RUN/'voice-audio.sock'
    path.unlink(missing_ok=True)
    server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    server.bind(str(path)); os.chmod(path,0o600); server.listen(2)
    while True:
        conn,_=server.accept()
        channel=queue.Queue(maxsize=1100)  # bounded, about 35 seconds
        with lock:
            for raw in backlog: channel.put_nowait(raw)
            backlog=[]; pending_until=0
            clients.append(channel)
        def writer(conn=conn,channel=channel):
            try:
                conn.settimeout(2)
                due=time.monotonic()
                while True:
                    raw=channel.get(timeout=3)
                    if raw is None: break
                    # Pace replay so native WebRTC's bounded input queue stays small.
                    time.sleep(max(0,due-time.monotonic()))
                    conn.sendall(raw)
                    due=max(due+0.032,time.monotonic())
            except (OSError,queue.Empty): pass
            finally:
                conn.close()
                with lock:
                    if channel in clients: clients.remove(channel)
        threading.Thread(target=writer,daemon=True).start()

def main():
    global backlog,pending_until,last_voice,last_trigger
    RUN.mkdir(exist_ok=True); CONTROL.mkdir(exist_ok=True)
    cfg=sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model=str(ROOT/'models/silero_vad.onnx')
    cfg.silero_vad.threshold=0.55
    cfg.silero_vad.min_speech_duration=0.25
    cfg.silero_vad.min_silence_duration=0.5
    cfg.sample_rate=16000; cfg.num_threads=1
    vad=sherpa_onnx.VoiceActivityDetector(cfg,buffer_size_in_seconds=30)
    threading.Thread(target=serve,daemon=True).start()
    while True:
        proc=subprocess.Popen(['parec','--device=mcp01_mic','--rate=16000','--channels=1','--format=float32le','--raw'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        last_report=0.0
        try:
            while True:
                raw=proc.stdout.read(2048)
                if len(raw)!=2048: raise RuntimeError('Microphone stream stopped')
                samples=np.frombuffer(raw,dtype='<f4')
                vad.accept_waveform(samples)
                while not vad.empty(): vad.pop()
                now=time.time(); state=reader_state()
                enabled=(ROOT/'vad-enabled').exists()
                speaking=state.get('phase')=='speaking'
                speech=bool(vad.is_speech_detected()) and not speaking
                if speech: last_voice=now
                trigger=False
                with lock:
                    if pending_until and now>pending_until:
                        backlog=[]; pending_until=0
                    if enabled and speech and not clients and not pending_until and now-last_trigger>15 and state.get('phase','idle') in ('idle','paused','error'):
                        backlog=list(ring)
                        pending_until=now+30; last_trigger=now; trigger=True
                    if pending_until:
                        if len(backlog)>=950:
                            backlog=[]; pending_until=0  # explicit bounded connection failure
                        else: backlog.append(raw)
                    ring.append(raw)
                    for channel in clients[:]:
                        try: channel.put_nowait(raw)
                        except queue.Full:
                            clients.remove(channel)
                            try: channel.get_nowait(); channel.put_nowait(None)
                            except queue.Empty: pass
                if trigger: request('start')
                if now-last_report>0.2:
                    atomic(RUN/'vad-state.json',dict(updated=now,lastVoice=last_voice,speech=speech,enabled=enabled,mode='monitoring',bufferedSeconds=len(backlog)*.032))
                    last_report=now
        except Exception as e:
            atomic(RUN/'vad-state.json',dict(updated=time.time(),mode='error',error=str(e)[:200]))
            time.sleep(2)
        finally:
            proc.terminate()
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()

if __name__=='__main__': main()
