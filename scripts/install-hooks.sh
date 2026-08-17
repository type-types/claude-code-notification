#!/bin/bash
# 알림 오버레이용 hook을 등록한다.
# 1) Claude Code: ~/.claude/settings.json에 hook 8개
#    (SessionStart, PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit,
#     Notification, Stop, SessionEnd)와 플랜 사용량 게이지용 statusline(statusline.sh)
# 2) Codex CLI: ~/.codex/hooks.json에 hook 7개 (Notification은 Codex에 없음).
#    ~/.codex 폴더가 없으면(Codex 미설치) 건너뛴다.
# 기존 설정은 보존하며, 쓰기 전에 각각 .bak으로 백업한다.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/hooks/notify.sh"
STATUSLINE="$DIR/hooks/statusline.sh"
chmod +x "$SCRIPT" "$STATUSLINE"

# ---------- Claude Code ----------
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$SETTINGS.bak"
fi

/usr/bin/python3 - "$SCRIPT" "$SETTINGS" "$STATUSLINE" <<'EOF'
import json, os, sys

script = sys.argv[1]
path = sys.argv[2]
statusline = sys.argv[3]

data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)

hooks = data.setdefault('hooks', {})
mapping = {
    'SessionStart': 'session_start',
    'PreToolUse': 'pre_tool_use',
    'PostToolUse': 'post_tool_use',
    'PermissionRequest': 'permission_request',
    'UserPromptSubmit': 'user_prompt_submit',
    'Notification': 'notification',
    'Stop': 'stop',
    'SessionEnd': 'session_end',
}

for event, evt_type in mapping.items():
    entries = hooks.setdefault(event, [])
    cmd = '"%s" %s claude' % (script, evt_type)
    replaced = False
    for entry in entries:
        for h in entry.get('hooks', []):
            c = h.get('command', '')
            # 예전 등록(끝에 에이전트 인자 없음)도 새 형식으로 바꾼다
            if 'notify.sh' in c and (c.rstrip().endswith(evt_type) or c.rstrip().endswith(evt_type + ' claude')):
                h['command'] = cmd
                replaced = True
    if not replaced:
        entries.append({'hooks': [{'type': 'command', 'command': cmd}]})

# statusline: 사용량 게이지의 데이터 출처. 사용자가 직접 만든 statusline이
# 이미 있으면 덮어쓰지 않고 알려만 준다.
sl_cmd = '"%s"' % statusline
sl = data.get('statusLine')
if not sl:
    data['statusLine'] = {'type': 'command', 'command': sl_cmd}
elif 'statusline.sh' in sl.get('command', ''):
    sl['command'] = sl_cmd
else:
    print('warning: statusLine already set, not overwriting: ' + sl.get('command', ''))

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('Claude Code hooks installed: ' + path)
EOF

# ---------- Codex CLI ----------
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
if [ ! -d "$CODEX_HOME" ]; then
  echo "Codex: $CODEX_HOME 없음, 건너뜀 (Codex를 쓰지 않으면 정상)"
  exit 0
fi

CODEX_HOOKS="$CODEX_HOME/hooks.json"
if [ -f "$CODEX_HOOKS" ]; then
  cp "$CODEX_HOOKS" "$CODEX_HOOKS.bak"
fi

/usr/bin/python3 - "$SCRIPT" "$CODEX_HOOKS" <<'EOF'
import json, os, sys

script = sys.argv[1]
path = sys.argv[2]

data = {}
if os.path.exists(path):
    with open(path) as f:
        data = json.load(f)

hooks = data.setdefault('hooks', {})
# Codex hook 이벤트 이름과 stdin JSON 필드(session_id, cwd, tool_name,
# tool_input 등)는 Claude Code와 같아서 notify.sh를 그대로 쓴다.
# Notification 이벤트는 Codex에 없다.
mapping = {
    'SessionStart': 'session_start',
    'PreToolUse': 'pre_tool_use',
    'PostToolUse': 'post_tool_use',
    'PermissionRequest': 'permission_request',
    'UserPromptSubmit': 'user_prompt_submit',
    'Stop': 'stop',
    'SessionEnd': 'session_end',
}

for event, evt_type in mapping.items():
    entries = hooks.setdefault(event, [])
    cmd = '"%s" %s codex' % (script, evt_type)
    replaced = False
    for entry in entries:
        for h in entry.get('hooks', []):
            c = h.get('command', '')
            if 'notify.sh' in c and c.rstrip().endswith(evt_type + ' codex'):
                h['command'] = cmd
                replaced = True
    if not replaced:
        # SessionEnd hook은 Codex 기본 제한 시간이 1초라 curl -m 1과 맞물린다.
        # 그 외는 알림 전달만 하므로 짧게 잡는다.
        entries.append({'hooks': [{'type': 'command', 'command': cmd, 'timeout': 3}]})

with open(path, 'w') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('Codex hooks installed: ' + path)
EOF

cat <<'MSG'

Codex 안내: Codex는 새로 등록된 hook을 사용자가 검토, 신뢰해야 실행합니다.
  codex 대화형 세션 안에서 /hooks 를 실행해 notify.sh 항목을 신뢰(trust)로 표시하세요.
  (한 번만 하면 되고, 신뢰 전에는 Codex 세션 카드에 알림이 오지 않습니다)
MSG
