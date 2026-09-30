const path = require('path');
const EventEmitter = require('events');

const STALE_MS = 4 * 60 * 60 * 1000;
const ERR_CLEAR_MS = 3000;
// 재알림 주기. 판정 문턱은 여기서 유도하므로 주기를 바꿔도 의미가 유지된다.
const REMIND_TICK_MS = 60 * 1000;
const REMIND_DUE_MS = REMIND_TICK_MS - 5000;
const REMIND_MAX = 5;

const AGENTS = new Set(['claude', 'codex']);
const diag = require('./diag');

// 세션 키: 에이전트 + 워킹 디렉토리. 같은 폴더에서 Claude와 Codex를 함께
// 돌리면 카드가 2장이어야 하므로 cwd만으로는 부족하다. claude는 예전 그대로
// cwd를 키로 써서 저장된 카드 위치(config의 cardY)와 호환을 유지하고,
// 다른 에이전트는 'codex:' 접두어를 붙인다. 같은 에이전트가 같은 폴더에서
// 여러 세션을 열면 두 번째 카드부터 '#<session_id>'를 덧붙인다. 이 키가
// renderer의 카드 id, IPC 인자, cardY 저장 키로 두루 쓰인다.
function sessionKey(agent, cwd) {
  return agent === 'claude' ? cwd : agent + ':' + cwd;
}

function sessionIdKey(agent, sessionId) {
  return agent + ':' + sessionId;
}

function normAgent(agent) {
  return AGENTS.has(agent) ? agent : 'claude';
}

// 경로의 유니코드 정규화를 NFC로 통일한다. 한글 폴더 이름은 hook 페이로드
// (NFC)와 프로세스 스캔의 lsof 출력(NFD, macOS 파일시스템 형태)이 달라서
// 같은 폴더가 다른 문자열로 취급돼 카드가 두 장 생겼다 (2026-09-23 실측).
function normCwd(cwd) {
  return typeof cwd === 'string' ? cwd.normalize('NFC') : cwd;
}

// 세션이 2개 이상 같은 마지막 이름을 가지면 구분될 때까지 상위 경로를 붙인다.
// 입력은 서로 다른 cwd 목록이어야 한다 (같은 폴더의 두 에이전트 세션은
// 이름이 같아도 카드 모양으로 구분되므로 여기서 갈라 쓰지 않는다).
function computeDisplayNames(cwds) {
  const parts = new Map(cwds.map((c) => [c, c.split('/').filter(Boolean)]));
  const depth = new Map(cwds.map((c) => [c, 1]));
  const label = (c) => parts.get(c).slice(-depth.get(c)).join('/') || c;
  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Map();
    for (const c of cwds) {
      const l = label(c);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(c);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const c of group) {
        if (depth.get(c) < parts.get(c).length) {
          depth.set(c, depth.get(c) + 1);
          changed = true;
        }
      }
    }
  }
  return new Map(cwds.map((c) => [c, label(c)]));
}

// 턴 소요 시간을 완료 알림의 부가 정보로 요약한다.
function elapsedLabel(startTs) {
  if (!startTs) return '';
  const sec = Math.round((Date.now() - startTs) / 1000);
  if (sec < 1) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return '소요 ' + h + '시간 ' + m + '분';
  if (m) return '소요 ' + m + '분 ' + s + '초';
  return '소요 ' + s + '초';
}

// 도구 이름과 입력으로 어떤 작업에 대한 허용인지 요약한다.
function formatTool(name, input) {
  input = input || {};
  let detail = '';
  let desc = '';
  if (name === 'apply_patch') {
    // Codex의 파일 편집 도구. tool_input.command에 패치 본문 전체가 들어오므로
    // (2026-08-15 실측) 대상 파일 이름만 뽑아 보여준다
    const files = [];
    for (const m of String(input.command || '').matchAll(
      /^\*\*\* (Add|Update|Delete) File: (.+)$/gm
    )) {
      files.push(m[2].trim());
    }
    detail = files.join(', ');
    if (files.length > 1) desc = '파일 ' + files.length + '개';
  } else if (name === 'Bash') {
    detail = input.command || '';
    desc = input.description || '';
  } else if (input.file_path) detail = input.file_path;
  else if (input.url) detail = input.url;
  else {
    const j = JSON.stringify(input);
    detail = j && j !== '{}' ? j : '';
  }
  let text = detail ? name + ': ' + detail : name;
  if (text.length > 300) text = text.slice(0, 300) + '...';
  return { text, desc, name: name || '' };
}

class Sessions extends EventEmitter {
  constructor(cfg, dock) {
    super();
    this.cfg = cfg;
    this.dock = dock;
    this.map = new Map();
    this.byId = new Map();
    this.usage = null;
    this.staleTimer = setInterval(() => {
      this.refresh();
      this.remind();
    }, REMIND_TICK_MS);
  }

  handleEvent(evt) {
    const type = evt && evt.type;
    if (!type || !evt.cwd) return;
    const agent = normAgent(evt.agent);
    evt.cwd = normCwd(evt.cwd);
    const cwd = this.homeCwd(agent, evt.cwd, evt.session_id, type === 'session_start');
    console.log(
      '[event] ' + agent + ' ' + type + ' ' + evt.cwd + (cwd !== evt.cwd ? ' => ' + cwd : '')
    );
    if (type === 'session_start') {
      this.ensure(agent, cwd, evt.session_id);
    } else if (type === 'permission_request') {
      // 권한 다이얼로그가 뜨는 순간 발화하는 hook. Notification보다 훨씬 빠르므로
      // 권한 알림의 주 경로로 사용한다. (Codex도 같은 이름의 hook을 제공한다)
      const s = this.ensure(agent, cwd, evt.session_id);
      s.stopped = false;
      // 턴 중간에 인식된 세션(앱 재시작, 스캐너 발견)도 작업 중으로 보이도록
      // 프롬프트 시각이 없으면 지금을 근사값으로 채운다
      if (!s.turnStart) s.turnStart = Date.now();
      let name = evt.tool_name || '';
      let d;
      if (name) {
        d = formatTool(name, evt.tool_input || {});
      } else {
        // 페이로드에 도구 정보가 없으면 직전 PreToolUse 내용으로 보완한다
        d = this.toolDetail(s);
        name = d.name;
      }
      const who = agent === 'codex' ? 'Codex' : 'Claude';
      this.setAlert(s, d.text || who + '가 허용을 기다리는 중', d.desc, 'permission', name);
    } else if (type === 'pre_tool_use') {
      const s = this.ensure(agent, cwd, evt.session_id);
      s.stopped = false;
      if (!s.turnStart) s.turnStart = Date.now();
      this.resolveIfMatches(s, evt.tool_name || '');
      s.lastTool = { name: evt.tool_name || '', input: evt.tool_input || {}, ts: Date.now() };
    } else if (type === 'post_tool_use') {
      const s = this.ensure(agent, cwd, evt.session_id);
      this.resolveIfMatches(s, evt.tool_name || '');
    } else if (type === 'user_prompt_submit') {
      // 사용자가 직접 입력을 보냈으면 어떤 알림이든 응답된 것이다.
      // Codex 앱 세션 기록에서 온 이벤트는 실제 턴 시작 시각을 실어 온다
      const s = this.ensure(agent, cwd, evt.session_id);
      s.stopped = false;
      s.turnStart = Number(evt.turn_started_at) || Date.now();
      this.resolveAlert(s);
    } else if (type === 'turn_aborted') {
      // 사용자가 턴을 중단함 (Codex 앱 세션 기록). 요청받은 것이 없는 상태로 돌아간다
      const s = this.ensure(agent, cwd, evt.session_id);
      s.stopped = true;
      s.turnStart = 0;
      this.resolveAlert(s);
    } else if (type === 'notification') {
      // Claude Code 전용 이벤트 (Codex에는 없다). 페이로드의 notification_type
      // (permission_prompt, idle_prompt, elicitation_dialog, agent_needs_input,
      // auth_success 등, 공식 문서 2026-09)으로 종류를 가르고, 이 필드가 없는
      // 옛 버전은 메시지 문구로 판정한다.
      const s = this.ensure(agent, cwd, evt.session_id);
      const msg = evt.message || '';
      const nt = typeof evt.notification_type === 'string' ? evt.notification_type : '';
      const idle = nt ? nt === 'idle_prompt' : /waiting for your input/i.test(msg);
      const question = /^(elicitation_dialog|elicitation_url_dialog|agent_needs_input)$/.test(nt);
      const permission = nt ? nt === 'permission_prompt' : !idle;
      if (idle || question) {
        // 유휴 알림: 턴이 끝난 뒤(요청받은 것이 없는 상태)면 무시하고,
        // 진행 중 입력 대기(질문 등)일 때만 허용 버튼 없는 알림으로 표시한다
        if (!s.stopped && !s.alert) {
          this.setAlert(s, question ? '질문에 답 대기 중' : '입력 대기 중', '', 'input', '');
        }
      } else if (permission && !s.stopped && !(s.alert && s.alert.kind === 'permission')) {
        // permission_request가 이미 알림을 띄웠으면 중복 발화하지 않는다 (fallback 경로).
        // 턴 종료 후 뒤늦게 도착한 이벤트가 완료 알림을 낡은 permission 알림으로
        // 덮지 않도록 stop 이후에는 무시한다
        const d = this.toolDetail(s);
        this.setAlert(s, d.text || msg, d.desc, 'permission', d.name);
      }
      // 그 외(auth_success, agent_completed, quota_auto_resume_* 등)는 판단이
      // 필요한 일이 아니므로 알림을 띄우지 않는다
    } else if (type === 'stop') {
      // 턴이 끝나면 초록색 완료 알림을 띄워 다음 요청을 바로 보낼 수 있게 한다.
      // 다음 user_prompt_submit이나 도구 실행 이벤트가 오면 해소된다.
      const s = this.ensure(agent, cwd, evt.session_id);
      s.stopped = true;
      this.setAlert(s, '작업 완료', elapsedLabel(s.turnStart), 'done', '');
      s.turnStart = 0;
    } else if (type === 'session_end') {
      const known = evt.session_id ? this.byId.get(sessionIdKey(agent, evt.session_id)) : null;
      this.remove(known ? known.key : sessionKey(agent, cwd));
    }
    const current = evt.session_id ? this.byId.get(sessionIdKey(agent, evt.session_id)) : null;
    if (evt.term_program || evt.bundle_id) {
      this.setOrigin(current ? current.key : sessionKey(agent, cwd), {
        termProgram: evt.term_program || '',
        bundleId: evt.bundle_id || '',
      });
    }
    // Codex 데스크톱 앱 스레드: 프로세스가 없으므로 스캔 정리 대상에서 빼고,
    // 세션 종료 메뉴도 뜻이 없다
    if (evt.desktop && current && !current.desktop) {
      current.desktop = true;
      this.refresh();
    }
  }

  // 도구 실행 이벤트로 알림을 해소한다. 권한 알림은 같은 이름의 도구가
  // 실제로 실행됐을 때만 지워서, 병렬 도구나 서브에이전트의 이벤트가
  // 아직 대기 중인 권한 알림을 지워버리는 것을 막는다.
  resolveIfMatches(s, toolName) {
    if (!s.alert) return;
    if (s.alert.kind === 'permission' && s.alert.toolName && s.alert.toolName !== toolName) return;
    // hook POST는 순서 보장이 없어서, 턴의 마지막 도구 이벤트가 stop보다
    // 늦게 도착해 방금 뜬 완료 알림을 지워버릴 수 있다. 갓 만든 완료 알림은
    // 도구 이벤트로 지우지 않는다 (진짜 새 작업이면 2초 뒤 이벤트로 해소된다)
    if (s.alert.kind === 'done' && Date.now() - s.alert.ts < 2000) return;
    this.resolveAlert(s);
  }

  // 이벤트의 cwd를 위젯 키로 바꾼다. 세션 안에서 Bash가 cd로 이동하면
  // 이후 hook 이벤트의 cwd가 하위 폴더로 바뀌어, 같은 세션인데 폴더마다
  // 위젯이 증식한다. 세션 ID로 기존 세션을 먼저 찾고, 처음 보는 ID면
  // 가장 가까운 상위 경로의 세션에 귀속시켜 세션당 위젯 하나를 유지한다.
  // 같은 에이전트의 세션만 후보로 본다 (Claude 세션 안에서 cd한 하위 폴더가
  // 그 폴더의 Codex 세션에 붙는 일이 없도록).
  homeCwd(agent, cwd, sessionId, isStart) {
    const known = sessionId ? this.byId.get(sessionIdKey(agent, sessionId)) : null;
    if (known && known.agent === agent && this.map.get(known.key) === known) return known.cwd;
    if (this.map.has(sessionKey(agent, cwd)) || isStart) return cwd;
    let p = cwd;
    for (;;) {
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
      if (this.map.has(sessionKey(agent, p))) return p;
    }
    return cwd;
  }

  ensure(agent, cwd, sessionId) {
    const known = sessionId ? this.byId.get(sessionIdKey(agent, sessionId)) : null;
    if (known && known.agent === agent && this.map.get(known.key) === known) {
      known.lastEvent = Date.now();
      this.refresh();
      return known;
    }
    const baseKey = sessionKey(agent, cwd);
    let key = baseKey;
    let s = this.map.get(key);
    // 스캔으로 먼저 생긴 카드는 첫 hook session_id가 인수한다. 이미 다른
    // session_id가 붙은 카드가 있으면 같은 cwd라도 별도 카드로 만든다.
    if (sessionId && s && s.sessionId && s.sessionId !== sessionId) {
      key = baseKey + '#' + sessionId;
      if (!this.map.has(key)) {
        diag.log('sessions', 'extra card for same folder', {
          key,
          existing: [...this.map.values()]
            .filter((o) => o.agent === agent && o.cwd === cwd)
            .map((o) => ({ key: o.key, idleMin: Math.round((Date.now() - o.lastEvent) / 60000), scanSeen: !!o.scanSeen })),
        });
      }
      s = this.map.get(key);
    }
    if (!s) {
      s = {
        key,
        agent,
        cwd,
        alert: null,
        stopped: false,
        origin: null,
        err: '',
        lastEvent: Date.now(),
        errTimer: null,
        turnStart: 0,
        sessionId: sessionId || '',
      };
      this.map.set(key, s);
    }
    if (sessionId) {
      s.sessionId = sessionId;
      this.byId.set(sessionIdKey(agent, sessionId), s);
    }
    s.lastEvent = Date.now();
    this.refresh();
    return s;
  }

  // 알림 직전의 PreToolUse 내용으로 어떤 작업에 대한 허용인지 요약한다.
  // permission 프롬프트는 해당 도구의 PreToolUse 직후에 뜨므로,
  // 최근 것만 사용하고 오래된 것(유휴 알림 등)은 일반 메시지로 둔다.
  toolDetail(s) {
    const t = s.lastTool;
    if (!t || Date.now() - t.ts > 30 * 1000) return { text: '', desc: '', name: '' };
    return formatTool(t.name, t.input);
  }

  setAlert(s, message, desc, kind, toolName) {
    // 완료 알림이 두 경로(Codex 앱 세션 기록과 hook)로 몇 초 차이로 오면 두 번째는
    // 소리 없이 소요 시간만 갱신한다
    if (s.alert && s.alert.kind === 'done' && kind === 'done' && Date.now() - s.alert.ts < 5000) {
      s.alert.desc = desc || s.alert.desc;
      this.refresh();
      return;
    }
    // 같은 알림의 중복 발화(permission_request와 notification이 둘 다 오는 경우)는
    // 소리와 번쩍임 없이 시각만 갱신한다. desc까지 같아야 중복으로 본다
    // (완료 알림은 메시지가 늘 같아서 desc의 소요 시간이 유일한 차이다)
    if (
      s.alert &&
      s.alert.kind === (kind || 'permission') &&
      s.alert.message === message &&
      s.alert.desc === (desc || '')
    ) {
      s.alert.ts = Date.now();
      return;
    }
    s.alert = {
      message,
      desc: desc || '',
      kind: kind || 'permission',
      toolName: toolName || '',
      ts: Date.now(),
    };
    s.err = '';
    this.refresh();
    this.emit('alert', s.alert.kind);
    this.emit('pending-changed');
  }

  // 해소되지 않은 알림은 1분 간격으로 소리와 테두리 번쩍임을 다시 울린다.
  // 알림당 최대 5회까지만 반복해서, 자리를 오래 비웠을 때 소음이 되지 않게 한다.
  // 여러 알림이 밀려 있어도 재알림은 한 번으로 합치고, 색은 최신 알림을 따른다.
  // 횟수는 실제로 울린 알림만 소진한다 (뒤로 밀린 알림이 소리 한 번 없이
  // 예산을 다 쓰고 침묵하는 것을 막는다).
  remind() {
    let due = null;
    for (const s of this.map.values()) {
      const a = s.alert;
      if (!a || (a.reminds || 0) >= REMIND_MAX) continue;
      if (Date.now() - a.ts < REMIND_DUE_MS) continue;
      if (!due || a.ts > due.ts) due = a;
    }
    if (!due) return;
    due.reminds = (due.reminds || 0) + 1;
    this.refresh();
    this.emit('alert', due.kind);
  }

  resolveAlert(s) {
    if (!s.alert) return;
    s.alert = null;
    s.err = '';
    this.refresh();
    this.emit('pending-changed');
  }

  // 플랜 사용량 표시 데이터 (usage.js가 statusline 이벤트로 갱신). null이면 표시 안 함.
  setUsage(limits) {
    this.usage = limits;
    this.refresh();
  }

  // 사용량 진행 알림. 값이 바뀔 때마다 renderer가 패널을 잠깐 펼치고
  // 바운스를 재생한다.
  pulseUsage() {
    this.usagePulse = (this.usagePulse || 0) + 1;
    this.refresh();
  }

  // 맨 앞 창에 해당하는 세션들(세션 키 목록). 해당 카드는 펼쳐진 상태를 유지한다.
  setFront(keys) {
    const key = keys.slice().sort().join('|');
    if (key === (this.frontKey || '')) return;
    this.frontKey = key;
    this.frontSet = new Set(keys);
    this.refresh();
  }

  setOrigin(key, origin) {
    const s = this.map.get(key);
    if (!s || s.origin || !origin) return;
    s.origin = origin;
    this.refresh();
  }

  // 카드 툴팁에 표시할 세션 출처 이름
  originLabel(s) {
    const o = s.origin;
    if (!o) return '';
    if (o.termProgram === 'vscode') return 'VS Code';
    if (o.bundleId === 'com.openai.codex') return 'Codex 앱';
    if (/anthropic|claude/i.test(o.bundleId || '')) return 'Claude 앱';
    if (o.termProgram === 'iTerm.app') return 'iTerm';
    if (o.termProgram === 'Apple_Terminal') return 'Terminal';
    return o.termProgram || o.bundleId || '';
  }

  setError(s, msg) {
    s.err = msg;
    this.refresh();
    if (s.errTimer) clearTimeout(s.errTimer);
    s.errTimer = setTimeout(() => {
      s.err = '';
      this.refresh();
    }, ERR_CLEAR_MS);
  }

  remove(key) {
    const s = this.map.get(key);
    if (!s) return;
    if (s.errTimer) clearTimeout(s.errTimer);
    this.map.delete(key);
    for (const [id, sess] of [...this.byId]) {
      if (sess === s) this.byId.delete(id);
    }
    this.refresh();
    this.emit('pending-changed');
  }

  // 드래그 드랍으로 정해진 카드 세로 위치를 저장한다. 계산은 renderer가
  // 담당하고 여기서는 저장만 한다. refresh를 부르지 않는 것이 의도인데,
  // 저장이 다시 화면 갱신을 부르면 renderer의 최신 상태를 덮는 에코 루프가
  // 생길 수 있기 때문이다. 다음 자연 갱신부터 저장값이 실려 나간다.
  setCardY(map) {
    const cur = Object.assign({}, this.cfg.get('cardY'));
    for (const k of Object.keys(map)) {
      const v = Number(map[k]);
      if (isFinite(v)) cur[k] = Math.round(v);
    }
    this.cfg.set('cardY', cur);
  }

  // 컨트롤 패널 세로 위치. 카드 위치와 같은 이유로 저장만 한다
  setCtrlY(v) {
    v = Number(v);
    if (!isFinite(v)) return;
    this.cfg.set('ctrlY', Math.max(0, Math.round(v)));
  }

  // 카드 투명도(0.2 ~ 1). 적용은 renderer가 즉시 하므로 저장만 한다.
  setOpacity(v) {
    v = Number(v);
    if (!isFinite(v)) return;
    this.cfg.set('opacity', Math.min(1, Math.max(0.2, v)));
  }

  // 스캐너가 확인한 실행 중 세션 목록([{agent, cwd}])과 동기화한다.
  // 같은 폴더(에이전트 기준)의 프로세스 수만큼만 카드를 살아 있는 것으로 보고,
  // 최근 이벤트 순으로 그 수까지만 확인 표시를 준다. 넘치는 카드는 3회 연속
  // (약 30초) 초과 상태면 제거한다. 같은 폴더에서 세션을 다시 시작하면
  // (/clear, 재실행, VS Code 확장의 새 대화) 새 session_id 카드가 생기는데,
  // 예전 세션의 카드가 SessionEnd 없이 남아 같은 폴더 카드가 쌓이던 문제의
  // 정리 경로다 (2026-09-23).
  // 스캔에 한 번도 잡힌 적 없는 폴더의 카드(프로세스 이름이 달라 스캔에 안
  // 잡히는 환경 등)는 건드리지 않는다.
  syncScanned(entries) {
    const counts = new Map(); // agent + cwd -> 프로세스 수
    for (const e of entries) {
      const k = normAgent(e.agent) + '\0' + normCwd(e.cwd);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const alive = new Set();
    const excess = new Set();
    for (const [k, n] of counts) {
      const [agent, cwd] = k.split('\0');
      const group = [...this.map.values()]
        .filter((s) => s.agent === agent && s.cwd === cwd && !s.desktop)
        .sort((a, b) => b.lastEvent - a.lastEvent);
      if (!group.length) {
        const key = sessionKey(agent, cwd);
        console.log('[scan] found running session ' + key);
        group.push(this.ensure(agent, cwd, ''));
      }
      group.forEach((s, i) => (i < n ? alive : excess).add(s.key));
    }
    for (const [key, s] of [...this.map]) {
      if (alive.has(key)) {
        s.scanSeen = true;
        s.scanMiss = 0;
        continue;
      }
      if (s.desktop) continue;
      if (!s.scanSeen && !excess.has(key)) continue;
      s.scanMiss = (s.scanMiss || 0) + 1;
      if (s.scanMiss >= 3) {
        console.log('[scan] process gone, removing ' + key);
        diag.log('scan', excess.has(key) ? 'removing extra card' : 'removing gone card', {
          key,
          idleMin: Math.round((Date.now() - s.lastEvent) / 60000),
          alert: s.alert ? s.alert.kind : '',
        });
        this.remove(key);
      }
    }
  }

  pendingCount() {
    return [...this.map.values()].filter((s) => s.alert).length;
  }

  // 가장 최근에 온 알림 세션. 글로우로 강조되고 재알림의 색 기준이 된다.
  alertTarget() {
    let target = null;
    for (const s of this.map.values()) {
      if (s.alert && (!target || s.alert.ts > target.alert.ts)) target = s;
    }
    return target;
  }

  // 도크로 보낼 전체 카드 목록. 저장된 세로 위치(y), 패널 위치, 투명도를 함께 싣는다.
  // 위치가 없는 새 카드는 y: null로 보내고 renderer가 빈자리에 배치한다.
  refresh() {
    const names = computeDisplayNames([...new Set([...this.map.values()].map((s) => s.cwd))]);
    const ys = this.cfg.get('cardY') || {};
    const now = Date.now();
    const target = this.alertTarget();
    const cards = [...this.map.values()].map((s) => ({
      target: s === target,
      alertTs: s.alert ? s.alert.ts : 0,
      key: s.key,
      agent: s.agent,
      desktop: !!s.desktop,
      cwd: s.cwd,
      name: names.get(s.cwd),
      origin: this.originLabel(s),
      alert: !!s.alert,
      working: !s.alert && !!s.turnStart,
      front: this.frontSet ? this.frontSet.has(s.key) : false,
      kind: s.alert ? s.alert.kind : '',
      // 바운스 재생 키: 새 알림이나 재알림 때 값이 바뀌어 renderer가
      // 바운스를 처음부터 다시 재생한다
      bump: s.alert ? s.alert.ts + ':' + (s.alert.reminds || 0) : '',
      message: s.alert ? s.alert.message : '',
      desc: s.alert ? s.alert.desc : '',
      err: s.err,
      stale: !s.alert && now - s.lastEvent > STALE_MS,
      y: typeof ys[s.key] === 'number' ? ys[s.key] : null,
    }));
    const ctrlY = this.cfg.get('ctrlY');
    this.dock.send({
      cards,
      ctrlY: typeof ctrlY === 'number' && isFinite(ctrlY) ? ctrlY : 14,
      opacity: this.cfg.get('opacity') || 1,
      usage: this.usage,
      usagePulse: this.usagePulse || 0,
    });
  }
}

module.exports = Sessions;
module.exports.sessionKey = sessionKey;
module.exports.sessionIdKey = sessionIdKey;
module.exports.normCwd = normCwd;
