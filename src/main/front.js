const path = require('path');

const WATCH_APPS = new Set(['Code', 'Code - Insiders', 'Claude', 'iTerm2', 'Terminal']);

function originMatchesApp(origin, app) {
  if (!origin || (!origin.termProgram && !origin.bundleId)) return null;
  if (app === 'Code' || app === 'Code - Insiders') {
    return origin.termProgram === 'vscode' || /vscode/i.test(origin.bundleId || '');
  }
  if (app === 'iTerm2') {
    return origin.termProgram === 'iTerm.app' || /iterm/i.test(origin.bundleId || '');
  }
  if (app === 'Terminal') {
    return origin.termProgram === 'Apple_Terminal' || origin.bundleId === 'com.apple.Terminal';
  }
  if (app === 'Claude') return /anthropic|claude/i.test(origin.bundleId || '');
  return false;
}

// 창 제목은 터미널 탭까지 구분하지 못한다. 같은 제목에 여러 세션이 걸리면
// 어느 세션을 보고 있는지 알 수 없으므로 아무 카드도 front로 표시하지 않는다.
// 잘못 펼치거나 완료 알림을 해소하는 것보다 보수적으로 접어 두는 편이 안전하다.
function frontSessionKeys(front, sessions) {
  if (!front || !WATCH_APPS.has(front.app) || !front.title) return [];
  const matches = sessions.filter((s) => front.title.includes(path.basename(s.cwd)));
  // 같은 프로젝트를 여러 앱에서 열어 둔 경우에는 출처가 현재 앱과 정확히
  // 일치하는 세션을 우선한다. 같은 앱 안에 후보가 여러 개면 창 제목만으로
  // 터미널 탭을 구분할 수 없으므로 아무 카드도 펼치지 않는다.
  const exact = matches.filter((s) => originMatchesApp(s.origin, front.app) === true);
  if (exact.length === 1) return [exact[0].key];
  if (exact.length > 1) return [];

  // hook 등록 전부터 실행 중인 세션처럼 출처가 아직 없는 경우의 호환 경로.
  // 명백히 다른 앱에서 온 세션은 제외하고, 후보가 하나일 때만 인정한다.
  const possible = matches.filter((s) => originMatchesApp(s.origin, front.app) !== false);
  return possible.length === 1 ? [possible[0].key] : [];
}

module.exports = { frontSessionKeys, originMatchesApp };
