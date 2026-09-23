const fs = require('fs');
const os = require('os');
const path = require('path');
const diag = require('./diag');
const { sessionIdKey } = require('./sessions');

// Codex 데스크톱 앱 세션 감지 (2026-09-23).
//
// 데스크톱 앱은 스레드 전부를 app-server 프로세스 하나(cwd "/")로 돌리므로
// 프로세스 스캔으로는 세션을 알 수 없다. 대신 Codex가 스레드마다 쓰는 세션
// 기록 파일(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)을 감시한다. 실측
// (codex 0.155): 첫 줄 session_meta에 id, cwd, originator("Codex Desktop",
// "codex_work_desktop"; CLI는 "codex-tui")가 있고, 턴마다 event_msg로
// task_started(started_at), task_complete, turn_aborted가 기록된다. 허용
// 요청은 파일에 남지 않으므로 그것은 hook(앱에서 실행될 경우)에 맡긴다.
//
// 파일 이벤트를 세션 이벤트로 바꿔 Sessions.handleEvent로 흘려보내므로 카드
// 상태 규칙(작업 중, 완료, 해소)은 hook 경로와 같다. 카드 클릭은 origin의
// bundle id로 Codex 앱을 앞으로 가져온다.
const SESSIONS_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const POLL_MS = 5 * 1000;
const DAY_DIRS = 3;
// 이 시간 안에 기록이 갱신된 스레드만 살아 있는 세션으로 본다. 앱은 스레드를
// 며칠씩 열어 두므로 마지막 활동 기준으로 자른다
const LIVE_MS = 3 * 60 * 60 * 1000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const BUNDLE_ID = 'com.openai.codex';

function isDesktop(originator) {
  return /desktop/i.test(String(originator || ''));
}

class CodexRollouts {
  constructor(sessions) {
    this.sessions = sessions;
    this.files = new Map(); // file -> 상태
    this.timer = null;
    this.watcher = null;
    this.watchTimer = 0;
  }

  start() {
    this.poll(true);
    this.timer = setInterval(() => this.poll(false), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.watchTimer);
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (e) {
        // 이미 닫힘
      }
      this.watcher = null;
    }
  }

  ensureWatcher() {
    if (this.watcher || !fs.existsSync(SESSIONS_DIR)) return;
    try {
      const watcher = fs.watch(SESSIONS_DIR, { recursive: true }, () => {
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.poll(false), 500);
      });
      watcher.on('error', (e) => {
        console.error('[codexapp] watch: ' + e.message);
        if (this.watcher === watcher) this.watcher = null;
        try {
          watcher.close();
        } catch (closeErr) {
          // 이미 닫힘
        }
      });
      this.watcher = watcher;
    } catch (e) {
      console.error('[codexapp] watch: ' + e.message);
    }
  }

  // 최근 날짜 폴더의 rollout 파일 목록 (경로, 수정 시각, 크기)
  listFiles() {
    const list = (dir) => {
      try {
        return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
      } catch (e) {
        return [];
      }
    };
    const dayDirs = [];
    for (const y of list(SESSIONS_DIR)) {
      for (const m of list(path.join(SESSIONS_DIR, y))) {
        for (const d of list(path.join(SESSIONS_DIR, y, m))) {
          dayDirs.push(path.join(SESSIONS_DIR, y, m, d));
          if (dayDirs.length >= DAY_DIRS) break;
        }
        if (dayDirs.length >= DAY_DIRS) break;
      }
      if (dayDirs.length >= DAY_DIRS) break;
    }
    const out = [];
    for (const dir of dayDirs) {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
      } catch (e) {
        continue;
      }
      for (const n of names) {
        const file = path.join(dir, n);
        try {
          const st = fs.statSync(file);
          out.push({ file, mtime: st.mtimeMs, size: st.size });
        } catch (e) {
          // 사이에 지워진 파일
        }
      }
    }
    return out;
  }

  poll(initial) {
    this.ensureWatcher();
    const now = Date.now();
    const seen = new Set();
    for (const f of this.listFiles()) {
      if (now - f.mtime > LIVE_MS) continue;
      seen.add(f.file);
      let st = this.files.get(f.file);
      if (!st) {
        st = this.open(f, initial);
        this.files.set(f.file, st);
      } else if (!st.ignored && (f.size !== st.size || f.mtime !== st.mtime)) {
        this.readNew(st, f);
      }
    }
    for (const [file, st] of [...this.files]) {
      if (seen.has(file)) continue;
      this.files.delete(file);
      if (!st.ignored) this.close(st, 'idle or archived');
    }
  }

  // 파일 머리에서 session_meta를 읽어 데스크톱 스레드인지 판정하고 카드를 만든다.
  // initial(앱 시작 시 이미 있던 파일)이면 꼬리로 현재 상태만 잡고 알림은 내지
  // 않는다. 실행 중에 새로 생긴 파일은 처음부터 이벤트로 처리한다
  open(f, initial) {
    const meta = this.readMeta(f.file);
    if (!meta || !isDesktop(meta.originator) || !meta.cwd) {
      return { ignored: true };
    }
    const st = {
      file: f.file,
      id: meta.id,
      cwd: meta.cwd,
      originator: meta.originator,
      mtime: f.mtime,
      size: f.size,
      offset: 0,
      partial: '',
      working: false,
      turnStartedAt: 0,
    };
    diag.log('codexapp', 'thread ' + (initial ? 'found' : 'started'), { id: st.id, cwd: st.cwd, originator: st.originator });
    this.emit(st, { type: 'session_start' });
    if (initial) {
      // 꼬리에서 마지막 턴 상태만 복원한다 (지난 완료 알림을 다시 울리지 않는다)
      const start = Math.max(0, f.size - TAIL_BYTES);
      const text = this.readRange(f.file, start, f.size);
      const lines = text.split('\n');
      for (const line of lines) this.handle(st, line, false);
      if (st.working) this.emit(st, { type: 'user_prompt_submit', turn_started_at: st.turnStartedAt });
      st.offset = f.size;
      st.partial = '';
    } else {
      this.readNew(st, f);
    }
    return st;
  }

  readMeta(file) {
    const text = this.readRange(file, 0, HEAD_BYTES);
    const nl = text.indexOf('\n');
    if (nl < 0) return null;
    try {
      const obj = JSON.parse(text.slice(0, nl));
      if (!obj || obj.type !== 'session_meta' || !obj.payload) return null;
      const p = obj.payload;
      return { id: p.id || p.session_id || '', cwd: p.cwd || '', originator: p.originator || '' };
    } catch (e) {
      return null;
    }
  }

  readRange(file, start, end) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const len = Math.max(0, end - start);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8', 0, n);
    } catch (e) {
      return '';
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // 지난 읽기 위치 이후에 추가된 줄만 읽어 이벤트로 처리한다
  readNew(st, f) {
    if (f.size < st.offset) {
      st.offset = 0;
      st.partial = '';
    }
    const text = st.partial + this.readRange(st.file, st.offset, f.size);
    const lines = text.split('\n');
    st.partial = lines.pop() || '';
    for (const line of lines) this.handle(st, line, true);
    st.offset = f.size;
    st.size = f.size;
    st.mtime = f.mtime;
  }

  handle(st, line, live) {
    if (!line || !line.includes('"event_msg"')) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      return; // 잘린 줄
    }
    if (obj.type !== 'event_msg' || !obj.payload) return;
    const p = obj.payload;
    if (p.type === 'task_started') {
      st.working = true;
      st.turnStartedAt = p.started_at ? Number(p.started_at) * 1000 : Date.parse(obj.timestamp) || Date.now();
      if (live) this.emit(st, { type: 'user_prompt_submit', turn_started_at: st.turnStartedAt });
    } else if (p.type === 'task_complete') {
      st.working = false;
      if (live) this.emit(st, { type: 'stop' });
    } else if (p.type === 'turn_aborted') {
      st.working = false;
      if (live) this.emit(st, { type: 'turn_aborted' });
    }
  }

  emit(st, evt) {
    this.sessions.handleEvent(
      Object.assign(
        {
          agent: 'codex',
          cwd: st.cwd,
          session_id: st.id,
          desktop: true,
          bundle_id: BUNDLE_ID,
          term_program: '',
        },
        evt
      )
    );
  }

  close(st, why) {
    diag.log('codexapp', 'thread closed (' + why + ')', { id: st.id, cwd: st.cwd });
    const s = this.sessions.byId.get(sessionIdKey('codex', st.id));
    if (s) this.sessions.remove(s.key);
  }
}

module.exports = CodexRollouts;
module.exports.isDesktop = isDesktop;
module.exports.BUNDLE_ID = BUNDLE_ID;
