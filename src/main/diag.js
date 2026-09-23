const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// 진단 로그. 패키징된 앱은 콘솔이 보이지 않으므로, 재현이 드문 문제(접기
// 버튼이 듣지 않는 현상 등)의 단서를 파일로 남긴다. renderer는 IPC 'diag'로,
// main은 diag.log()로 기록한다. 파일이 상한을 넘으면 .1로 한 번 돌리고
// 새로 시작해 디스크를 무한정 쓰지 않는다.
const MAX_BYTES = 512 * 1024;

let file = '';

function init() {
  try {
    file = path.join(app.getPath('userData'), 'diag.log');
  } catch (e) {
    file = '';
  }
  log('app', 'start', { version: app.getVersion(), electron: process.versions.electron });
}

function rotate() {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(file, file + '.1');
  } catch (e) {
    // 파일이 없거나 돌리기 실패: 그냥 이어 쓴다
  }
}

// tag: 어느 부품(ctrl, card, usage ...), event: 무슨 일, data: 부가 정보(JSON)
function log(tag, event, data) {
  const line =
    new Date().toISOString() + ' [' + tag + '] ' + event +
    (data === undefined ? '' : ' ' + safeJson(data));
  console.log('[diag] ' + line);
  if (!file) return;
  try {
    rotate();
    fs.appendFileSync(file, line + '\n');
  } catch (e) {
    // 로그 실패는 앱 동작에 영향을 주지 않는다
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

function path_() {
  return file;
}

module.exports = { init, log, path: path_ };
