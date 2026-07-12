#!/bin/bash
# ~/.claude/settings.json에 4개 hook(SessionStart, Notification, Stop, SessionEnd)을 등록한다.
# 기존 설정은 보존하며, 쓰기 전에 settings.json.bak으로 백업한다.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/hooks/notify.sh"
chmod +x "$SCRIPT"

SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$SETTINGS.bak"
fi

/usr/bin/python3 - "$SCRIPT" "$SETTINGS" <<'EOF'
import json, os, sys

script = sys.argv[1]
path = sys.argv[2]

data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)

hooks = data.setdefault('hooks', {})
mapping = {
    'SessionStart': 'session_start',
    'PreToolUse': 'pre_tool_use',
    'PostToolUse': 'post_tool_use',
    'Notification': 'notification',
    'Stop': 'stop',
    'SessionEnd': 'session_end',
}

for event, evt_type in mapping.items():
    entries = hooks.setdefault(event, [])
    cmd = '"%s" %s' % (script, evt_type)
    replaced = False
    for entry in entries:
        for h in entry.get('hooks', []):
            c = h.get('command', '')
            if 'notify.sh' in c and c.rstrip().endswith(evt_type):
                h['command'] = cmd
                replaced = True
    if not replaced:
        entries.append({'hooks': [{'type': 'command', 'command': cmd}]})

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('hooks installed: ' + path)
EOF
