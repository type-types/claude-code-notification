const { execFile } = require('child_process');
const { sessionKey } = require('./sessions');

const SCAN_INTERVAL_MS = 10 * 1000;

// codex CLI의 하위 명령 중 대화형 세션이 아닌 것들. 이 이름이 첫 위치 인자로
// 오면 세션으로 잡지 않는다 (codex --help 기준, 2026-08).
// resume과 fork는 대화형 세션을 여므로 여기 없다.
// ps에는 따옴표가 벗겨진 채 보이므로 프롬프트의 첫 단어가 이 목록과 겹치면
// (예: codex "review my code") 스캔에서 빠진다. hook 경로로는 카드가 뜨므로
// 감수한다. apply의 별칭 'a'는 프롬프트 첫 단어로 흔해서 목록에서 뺐다
// (apply는 순식간에 끝나 10초 스캔에 걸릴 일이 거의 없다).
const CODEX_NON_SESSION = new Set([
  'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server',
  'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor',
  'sandbox', 'debug', 'apply', 'archive', 'delete', 'unarchive', 'cloud',
  'exec-server', 'features', 'help',
]);
// 값을 하나 받는 codex 옵션. 그 다음 토큰은 위치 인자가 아니다.
const CODEX_VALUE_FLAGS = new Set([
  '-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox',
  '-a', '--ask-for-approval', '-C', '--cd', '--add-dir', '-i', '--image',
  '--enable', '--disable', '--remote', '--oss-provider', '--local-provider',
]);

// 실행 중인 프로세스 명령줄이 어느 에이전트의 대화형 세션인지 판정한다.
// 반환: 'claude' | 'codex' | null
//
// claude: 최근 Claude Code가 띄우는 백그라운드 데몬(claude daemon run)과
// pty 호스트(bg-pty-host)는 창이 없는 보조 프로세스라서 세션으로 잡으면
// 안 된다. 특히 VSC가 업데이트로 재시작될 때 데몬이 고아로 살아남아,
// 클릭해도 창을 찾을 수 없는 유령 카드가 계속 되살아나는 문제가 있었다
// (2026-07-15).
//
// codex: npm 래퍼(node .../bin/codex)와 실제 바이너리(.../bin/codex)가
// 부모 자식으로 둘 다 보이는데, cwd가 같아 하나의 세션으로 합쳐진다.
// Codex 데스크톱 앱과 ChatGPT.app이 띄우는 app-server, code-mode-host,
// mcp-server 등은 창이 없는 보조 프로세스라 제외한다.
function agentOf(cmd) {
  if (/(^|\/)claude( |$)/.test(cmd)) {
    if (/(^|\/)claude +(daemon|bg-pty-host)( |$)/.test(cmd)) return null;
    if (/--bg-pty-host( |$)/.test(cmd)) return null;
    return 'claude';
  }
  const m = cmd.match(/(?:^|\/)codex(?: (.*))?$/);
  if (m) {
    const toks = (m[1] || '').split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.startsWith('-')) {
        // --key=value 형태는 값이 붙어 있고, 그 외 값 옵션은 다음 토큰을 건너뛴다
        if (!t.includes('=') && CODEX_VALUE_FLAGS.has(t)) i++;
        continue;
      }
      // 첫 위치 인자: 비대화형 하위 명령이면 세션이 아니다. 그 외(프롬프트,
      // resume, fork)는 대화형 세션이다
      return CODEX_NON_SESSION.has(t) ? null : 'codex';
    }
    return 'codex';
  }
  return null;
}

// 실행 중인 에이전트 CLI 프로세스를 스캔해 워킹 디렉토리를 알아낸다.
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
      const agents = new Map(); // pid -> agent
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) continue;
        const agent = agentOf(m[2]);
        if (agent) agents.set(m[1], agent);
      }
      if (agents.size === 0) {
        this.sessions.syncScanned([]);
        return;
      }
      execFile(
        '/usr/sbin/lsof',
        ['-a', '-d', 'cwd', '-p', [...agents.keys()].join(','), '-Fn'],
        (err2, out2) => {
          if (err2 && !out2) return;
          const entries = [];
          let pid = 0;
          for (const line of String(out2).split('\n')) {
            if (line.startsWith('p')) pid = Number(line.slice(1));
            else if (line.startsWith('n/')) {
              entries.push({ pid, agent: agents.get(String(pid)), cwd: line.slice(1) });
            }
          }
          this.sessions.syncScanned(entries);
          for (const e of entries) this.fillOrigin(e);
        }
      );
    });
  }

  // hook 이벤트 없이 스캔으로만 잡힌 세션의 출처를 프로세스 환경변수로 알아낸다
  fillOrigin(e) {
    const key = sessionKey(e.agent, e.cwd);
    const s = this.sessions.map.get(key);
    if (!s || s.origin) return;
    const cached = this.originCache.get(e.pid);
    if (cached) {
      this.sessions.setOrigin(key, cached);
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
      this.sessions.setOrigin(key, origin);
    });
  }
}

// 에이전트와 워킹 디렉토리가 일치하는 세션 프로세스(pid)와 그 부모(ppid)를 찾는다.
// 위젯의 세션 종료 기능이 사용한다. codex는 래퍼와 바이너리가 둘 다 잡히는데,
// 둘 다 SIGTERM을 보내고 부모까지 올라가면 셸까지 닫히므로 문제없다.
function findSessionProcs(agent, cwd, cb) {
  execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], (err, out) => {
    if (err) return cb([]);
    const procs = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      if (agentOf(m[3]) === agent) procs.push({ pid: Number(m[1]), ppid: Number(m[2]) });
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

module.exports = { Scanner, findSessionProcs, agentOf };
