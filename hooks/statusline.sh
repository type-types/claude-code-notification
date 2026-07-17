#!/bin/bash
# Claude Code statusline: stdin으로 받는 JSON에 플랜 사용량(rate_limits)이
# 들어 있다 (공식 기능, Pro/Max 구독자). 이를 오버레이 앱의 로컬 서버로
# 중계하는 데이터 통로로만 쓴다. 아무것도 출력하지 않으므로 터미널에는
# statusline이 표시되지 않는다 (사용자가 원래 모습 유지를 원했음).
# 앱이 꺼져 있어도 조용히 실패하며 Claude Code 진행을 막지 않는다.

PORT="${CC_NOTIFY_PORT:-48923}"

curl -s -m 1 -X POST \
  "http://127.0.0.1:${PORT}/event?type=statusline" \
  -H 'Content-Type: application/json' \
  --data-binary @- >/dev/null 2>&1

exit 0
