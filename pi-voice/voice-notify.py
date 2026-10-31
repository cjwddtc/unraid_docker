#!/usr/bin/python3
"""Queue a verified result for Live speech; usable by agent tools or a scheduler."""
import argparse
import json
from pathlib import Path
import time
import uuid

p=argparse.ArgumentParser()
p.add_argument('text',nargs='?')
p.add_argument('--file',type=Path)
p.add_argument('--pause',action='store_true')
args=p.parse_args()
text=args.file.read_text(encoding='utf8') if args.file else args.text
if not args.pause and not text: p.error('Provide text or --file')
root=Path('/data/runtime/voice-control'); root.mkdir(parents=True,exist_ok=True)
ident=str(uuid.uuid4())
temp=root/(ident+'.tmp')
temp.write_text(json.dumps(dict(id=ident,created=time.time(),action='pause' if args.pause else 'announce',text=text)),encoding='utf8')
temp.replace(root/(ident+'.json'))
print('Queued voice pause' if args.pause else 'Queued Live voice notification')
