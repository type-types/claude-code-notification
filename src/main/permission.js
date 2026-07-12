const { execFile } = require('child_process');

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function keyLine(approveKey) {
  if (approveKey === 'return' || approveKey === 'enter') return 'key code 36';
  return 'keystroke "' + esc(approveKey) + '"';
}

// 폴더 이름이 제목에 포함된 VSC 창을 찾아 앞으로 가져온다.
// actionLine이 있으면 앞 창 제목 재검증 후 키 입력까지 보낸다.
// 결과: OK, NOTFOUND (창 없음), MISMATCH (입력 직전 재검증 실패), ERROR
function buildScript(folderName, actionLine) {
  const lines = [
    'set target to "' + esc(folderName) + '"',
    'set procNames to {"Code", "Code - Insiders"}',
    'tell application "System Events"',
    '  set matched to false',
    '  repeat with pn in procNames',
    '    set p to contents of pn',
    '    if matched is false and (exists process p) then',
    '      tell process p',
    '        repeat with w in windows',
    '          try',
    '            if name of w contains target then',
    '              perform action "AXRaise" of w',
    '              set matched to true',
    '              exit repeat',
    '            end if',
    '          end try',
    '        end repeat',
    '        if matched then set frontmost to true',
    '      end tell',
    '    end if',
    '  end repeat',
    '  if not matched then return "NOTFOUND"',
  ];
  if (actionLine) {
    lines.push(
      '  delay 0.2',
      '  set fname to ""',
      '  repeat with pn in procNames',
      '    set p to contents of pn',
      '    if (exists process p) then',
      '      tell process p',
      '        if frontmost then',
      '          try',
      '            set fname to name of front window',
      '          end try',
      '        end if',
      '      end tell',
      '    end if',
      '  end repeat',
      '  if fname does not contain target then return "MISMATCH"',
      '  ' + actionLine
    );
  }
  lines.push('  return "OK"', 'end tell');
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

function approve(folderName, approveKey, cb) {
  run(buildScript(folderName, keyLine(approveKey)), cb);
}

function focus(folderName, cb) {
  run(buildScript(folderName, ''), cb);
}

module.exports = { approve, focus };
