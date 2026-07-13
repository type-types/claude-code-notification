# CC Notify: Claude Code 알림 오버레이 (macOS)

VSC 창을 여러 개 켜두고 Claude Code를 돌릴 때 bash 알림 등을 놓쳐서 판단이 늦어지는 문제를 해결하는 오버레이 앱이다. 세션마다 화면 최상단에 작은 위젯이 뜨고, 알림이 오면 소리와 함께 보고 있는 화면의 테두리 4변이 살짝 번쩍이며, 위젯에서 어떤 작업에 대한 요청인지 바로 확인할 수 있다. 위젯을 클릭하면 해당 VSC 창이 앞으로 나오고, 허용 여부는 창에서 직접 결정한다.

문서: 문제정의와-솔루션.md, 기능-명세.md, 제작-파이프라인.md

## 설치

```bash
npm install
bash scripts/install-hooks.sh
```

install-hooks.sh는 `~/.claude/settings.json`에 hook 8개(SessionStart, PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Notification, Stop, SessionEnd)를 등록한다. 기존 설정은 보존되고, 쓰기 전에 `settings.json.bak`으로 백업된다. hook은 새로 시작하는 Claude Code 세션부터 적용된다.

권한 알림의 주 경로는 PermissionRequest hook이다. 권한 다이얼로그가 뜨는 순간 발화하므로 Notification 기반보다 훨씬 빠르다. Notification은 fallback으로만 쓴다.

## 실행

```bash
npm start
```

메뉴바에 🔔 아이콘으로 상주한다. Dock에는 표시되지 않는다.

## 사용법

- Claude Code 세션이 시작되면 화면 우상단에 워킹 디렉토리 이름 위젯이 생긴다.
- 앱보다 먼저 시작된 세션도 10초 간격 프로세스 스캔으로 자동 감지해 위젯을 띄운다. 다만 hook 등록 전에 시작된 세션은 알림(소리, 번쩍임, 작업 내용)이 보장되지 않으므로, 완전한 동작을 원하면 해당 세션을 재시작한다.
- 위젯을 클릭하면 알림 여부와 관계없이 해당 VSC 창이 앞으로 나온다.
- 위젯은 아무 곳이나 잡고 드래그해서 원하는 위치로 옮길 수 있다. 위치는 디렉토리별로 저장된다.
- permission 요청이 오면 (다이얼로그가 뜨는 즉시):
  - 알림 소리가 난다.
  - 지금 보고 있는 화면(마우스 커서가 있는 디스플레이)의 테두리 4변이 살짝 번쩍인다.
  - 해당 위젯의 이름 밑에 어떤 작업에 대한 요청인지(bash 명령어 전문과 설명, 파일 경로 등)가 나타난다.
- 턴 진행 중 입력 대기(질문 등)는 파란색의 "입력 대기 중" 알림으로 뜬다.
- 턴이 끝난 뒤의 유휴 알림(waiting for your input)은 요청받은 것이 없는 상태이므로 표시하지 않는다.
- 허용, 거부 입력은 이 앱에서 하지 않는다. 위젯을 클릭해 해당 VSC 창을 앞으로 가져온 뒤 창에서 직접 응답한다.
- VSC에서 허용해 도구가 실행되면 위젯이 평상시 크기로 다시 줄어든다.
- 위젯 우클릭으로 수동으로 닫을 수 있다.
- 메뉴바 메뉴: 음소거, 상시 글로우, 로그인 시 자동 시작, 종료.

## 권한

위젯 클릭으로 VSC 창을 앞으로 가져오는 기능은 macOS 손쉬운 사용(접근성) 권한이 필요하다. 첫 클릭 시 시스템이 권한을 요청하며, 시스템 설정의 개인정보 보호 및 보안, 손쉬운 사용에서 이 앱(개발 실행 시 Electron)을 허용하면 된다.

## 주의사항과 한계

- VSC 창 매칭은 창 제목에 워킹 디렉토리의 마지막 폴더 이름이 포함되는지로 판단한다. 같은 폴더 이름의 프로젝트가 여러 개 열려 있으면 잘못된 창이 선택될 수 있다.
- 이 앱은 알림 전용이다. permission 프롬프트에 대한 허용, 거부 입력은 VSC 창에서 직접 한다.

## 설정 파일

- npm start로 실행 시: `~/Library/Application Support/claude-code-notification/config.json`
- 패키징된 CC Notify.app 실행 시: `~/Library/Application Support/CC Notify/config.json`

| 키 | 기본값 | 설명 |
|---|---|---|
| port | 48923 | 로컬 이벤트 수신 포트 (hook 쪽은 환경변수 CC_NOTIFY_PORT) |
| muted | false | 알림 소리 끄기 |
| idleGlow | true | 알림 미해소 시 옅은 상시 글로우 유지 |
| soundPath | /System/Library/Sounds/Glass.aiff | 알림 소리 파일 |
| positions | {} | 디렉토리별 위젯 위치 (자동 관리) |

## 제거

1. 메뉴바에서 종료.
2. `~/.claude/settings.json`의 hooks에서 notify.sh가 포함된 항목을 모두 삭제 (또는 백업 settings.json.bak으로 복원).
