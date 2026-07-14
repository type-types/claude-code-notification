const { execFile } = require('child_process');

const SCAN_INTERVAL_MS = 10 * 1000;

// 대화형 claude 세션 프로세스만 매칭한다. 최근 Claude Code가 띄우는
// 백그라운드 데몬(claude daemon run)과 pty 호스트(bg-pty-host)는 창이 없는
// 보조 프로세스라서 세션으로 잡으면 안 된다. 특히 VSC가 업데이트로
// 재시작될 때 데몬이 고아로 살아남아, 클릭해도 창을 찾을 수 없는
// 유령 카드가 계속 되살아나는 문제가 있었다 (2026-07-15).
function isSessionCommand(cmd) {
  if (!/(^|\/)claude( |$)/.test(cmd)) return false;
  if (/(^|\/)claude +(daemon|bg-pty-host)( |$)/.test(cmd)) return false;
  if (/--bg-pty-host( |$)/.test(cmd)) return false;
  return true;
}

// 실행 중인 claude CLI 프로세스를 스캔해 워킹 디렉토리를 알아낸다.
// hook이 등록되기 전에 시작된 세션도 위젯으로 표시하기 위한 보조 감지 경로다.
class Scanner {
  constructor(sessions) {
    this.sessions = sessions;
    this.timer = null;
    this.originCache = new Map();
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
        if (isSessionCommand(m[2])) pids.push(m[1]);
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
          const entries = [];
          let pid = 0;
          for (const line of String(out2).split('\n')) {
            if (line.startsWith('p')) pid = Number(line.slice(1));
            else if (line.startsWith('n/')) entries.push({ pid, cwd: line.slice(1) });
          }
          this.sessions.syncScanned(entries.map((e) => e.cwd));
          for (const e of entries) this.fillOrigin(e);
        }
      );
    });
  }

  // hook 이벤트 없이 스캔으로만 잡힌 세션의 출처를 프로세스 환경변수로 알아낸다
  fillOrigin(e) {
    const s = this.sessions.map.get(e.cwd);
    if (!s || s.origin) return;
    const cached = this.originCache.get(e.pid);
    if (cached) {
      this.sessions.setOrigin(e.cwd, cached);
      return;
    }
    execFile('/bin/ps', ['eww', '-o', 'command=', '-p', String(e.pid)], (err, out) => {
      if (err) return;
      const origin = { termProgram: '', bundleId: '' };
      const tm = String(out).match(/(?:^|\s)TERM_PROGRAM=(\S+)/);
      const bm = String(out).match(/(?:^|\s)__CFBundleIdentifier=(\S+)/);
      if (tm) origin.termProgram = tm[1];
      if (bm) origin.bundleId = bm[1];
      if (!origin.termProgram && !origin.bundleId) return;
      this.originCache.set(e.pid, origin);
      this.sessions.setOrigin(e.cwd, origin);
    });
  }
}

// 워킹 디렉토리가 일치하는 claude 프로세스(pid)와 그 부모 셸(ppid)을 찾는다.
// 위젯의 세션 종료 기능이 사용한다.
function findSessionProcs(cwd, cb) {
  execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], (err, out) => {
    if (err) return cb([]);
    const procs = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      if (isSessionCommand(m[3])) procs.push({ pid: Number(m[1]), ppid: Number(m[2]) });
    }
    if (procs.length === 0) return cb([]);
    execFile(
      '/usr/sbin/lsof',
      ['-a', '-d', 'cwd', '-p', procs.map((p) => p.pid).join(','), '-Fn'],
      (err2, out2) => {
        if (err2 && !out2) return cb([]);
        const matches = [];
        let cur = 0;
        for (const line of String(out2).split('\n')) {
          if (line.startsWith('p')) cur = Number(line.slice(1));
          else if (line.startsWith('n/') && line.slice(1) === cwd) {
            const p = procs.find((x) => x.pid === cur);
            if (p) matches.push(p);
          }
        }
        cb(matches);
      }
    );
  });
}

module.exports = { Scanner, findSessionProcs };
