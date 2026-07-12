#!/bin/bash
# Claude Code hook: stdin JSON을 오버레이 앱의 로컬 서버로 그대로 전달한다.
# 이벤트 타입은 쿼리 파라미터로 붙이고, 파싱은 앱이 담당한다.
# 앱이 꺼져 있어도 조용히 실패하며 Claude Code 진행을 막지 않는다.

TYPE="${1:-unknown}"
PORT="${CC_NOTIFY_PORT:-48923}"

curl -s -m 1 -X POST "http://127.0.0.1:${PORT}/event?type=${TYPE}" \
  -H 'Content-Type: application/json' \
  --data-binary @- >/dev/null 2>&1

exit 0
