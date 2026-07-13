const { execFile } = require('child_process');

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 제목에 후보 이름이 포함된 VSC 창을 찾아 앞으로 가져온다.
// 후보는 구체적인 것부터(세션 폴더 이름, 그 상위 폴더 순) 시도하므로
// 워크스페이스 하위 폴더에서 실행한 세션도 그 워크스페이스 창을 찾는다.
// 결과: OK, NOTFOUND (창 없음), ERROR
function buildScript(targets) {
  const listExpr = '{' + targets.map((t) => '"' + esc(t) + '"').join(', ') + '}';
  const lines = [
    'set targetList to ' + listExpr,
    'set procNames to {"Code", "Code - Insiders"}',
    'tell application "System Events"',
    '  repeat with tg in targetList',
    '    set target to contents of tg',
    '    repeat with pn in procNames',
    '      set p to contents of pn',
    '      if (exists process p) then',
    '        tell process p',
    '          repeat with w in windows',
    '            try',
    '              if name of w contains target then',
    '                perform action "AXRaise" of w',
    '                set frontmost to true',
    '                return "OK"',
    '              end if',
    '            end try',
    '          end repeat',
    '        end tell',
    '      end if',
    '    end repeat',
    '  end repeat',
    '  return "NOTFOUND"',
    'end tell',
  ];
  return lines.join('\n');
}

function run(script, cb) {
  execFile('/usr/bin/osascript', ['-e', script], { timeout: 8000 }, (err, stdout) => {
    if (err) {
      console.error('[permission] osascript failed: ' + err.message);
      return cb('ERROR');
    }
    cb(String(stdout).trim() || 'ERROR');
  });
}

function focus(targets, cb) {
  if (!Array.isArray(targets)) targets = [targets];
  targets = targets.filter(Boolean);
  if (targets.length === 0) return cb('NOTFOUND');
  run(buildScript(targets), cb);
}

// 창 단위 매칭이 불가능한 출처(Claude 앱, iTerm 등)는 앱 자체를 앞으로 가져온다.
// open -b는 손쉬운 사용 권한 없이 동작한다.
function activateApp(bundleId, cb) {
  execFile('/usr/bin/open', ['-b', bundleId], (err) => {
    if (cb) cb(err ? 'ERROR' : 'OK');
  });
}

module.exports = { focus, activateApp };
