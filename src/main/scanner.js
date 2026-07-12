const { execFile } = require('child_process');

const SCAN_INTERVAL_MS = 10 * 1000;

// 실행 중인 claude CLI 프로세스를 스캔해 워킹 디렉토리를 알아낸다.
// hook이 등록되기 전에 시작된 세션도 위젯으로 표시하기 위한 보조 감지 경로다.
class Scanner {
  constructor(sessions) {
    this.sessions = sessions;
    this.timer = null;
  }

  start() {
    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  scan() {
    execFile('/bin/ps', ['-axo', 'pid=,command='], (err, out) => {
      if (err) return;
      const pids = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) continue;
        if (/(^|\/)claude( |$)/.test(m[2])) pids.push(m[1]);
      }
      if (pids.length === 0) {
        this.sessions.syncScanned([]);
        return;
      }
      execFile(
        '/usr/sbin/lsof',
        ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'],
        (err2, out2) => {
          if (err2 && !out2) return;
          const cwds = new Set();
          for (const line of String(out2).split('\n')) {
            if (line.startsWith('n/')) cwds.add(line.slice(1));
          }
          this.sessions.syncScanned([...cwds]);
        }
      );
    });
  }
}

module.exports = Scanner;
