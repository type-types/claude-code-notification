const { execFile } = require('child_process');

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// 폴더 이름이 제목에 포함된 VSC 창을 찾아 앞으로 가져온다.
// 결과: OK, NOTFOUND (창 없음), ERROR
function buildScript(folderName) {
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
    '  return "OK"',
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

function focus(folderName, cb) {
  run(buildScript(folderName), cb);
}

module.exports = { focus };
