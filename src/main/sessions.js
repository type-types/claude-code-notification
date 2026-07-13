const path = require('path');
const EventEmitter = require('events');

const STALE_MS = 4 * 60 * 60 * 1000;
const ERR_CLEAR_MS = 3000;

// 세션이 2개 이상 같은 마지막 이름을 가지면 구분될 때까지 상위 경로를 붙인다.
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

// 도구 이름과 입력으로 어떤 작업에 대한 허용인지 요약한다.
function formatTool(name, input) {
  input = input || {};
  let detail = '';
  let desc = '';
  if (name === 'Bash') {
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
    this.staleTimer = setInterval(() => this.refresh(), 60 * 1000);
  }

  handleEvent(evt) {
    const type = evt && evt.type;
    if (!type || !evt.cwd) return;
    const cwd = this.homeCwd(evt.cwd, evt.session_id, type === 'session_start');
    console.log('[event] ' + type + ' ' + evt.cwd + (cwd !== evt.cwd ? ' => ' + cwd : ''));
    if (type === 'session_start') {
      this.ensure(cwd, evt.session_id);
    } else if (type === 'permission_request') {
      // 권한 다이얼로그가 뜨는 순간 발화하는 hook. Notification보다 훨씬 빠르므로
      // 권한 알림의 주 경로로 사용한다.
      const s = this.ensure(cwd, evt.session_id);
      s.stopped = false;
      let name = evt.tool_name || '';
      let d;
      if (name) {
        d = formatTool(name, evt.tool_input || {});
      } else {
        // 페이로드에 도구 정보가 없으면 직전 PreToolUse 내용으로 보완한다
        d = this.toolDetail(s);
        name = d.name;
      }
      this.setAlert(s, d.text || 'Claude가 허용을 기다리는 중', d.desc, 'permission', name);
    } else if (type === 'pre_tool_use') {
      const s = this.ensure(cwd, evt.session_id);
      s.stopped = false;
      this.resolveIfMatches(s, evt.tool_name || '');
      s.lastTool = { name: evt.tool_name || '', input: evt.tool_input || {}, ts: Date.now() };
    } else if (type === 'post_tool_use') {
      const s = this.ensure(cwd, evt.session_id);
      this.resolveIfMatches(s, evt.tool_name || '');
    } else if (type === 'user_prompt_submit') {
      // 사용자가 직접 입력을 보냈으면 어떤 알림이든 응답된 것이다
      const s = this.ensure(cwd, evt.session_id);
      s.stopped = false;
      this.resolveAlert(s);
    } else if (type === 'notification') {
      const s = this.ensure(cwd, evt.session_id);
      const msg = evt.message || '';
      if (/waiting for your input/i.test(msg)) {
        // 유휴 알림: 턴이 끝난 뒤(요청받은 것이 없는 상태)면 무시하고,
        // 진행 중 입력 대기(질문 등)일 때만 허용 버튼 없는 알림으로 표시한다
        if (!s.stopped && !s.alert) this.setAlert(s, '입력 대기 중', '', 'input', '');
      } else if (!(s.alert && s.alert.kind === 'permission')) {
        // permission_request가 이미 알림을 띄웠으면 중복 발화하지 않는다 (fallback 경로)
        const d = this.toolDetail(s);
        this.setAlert(s, d.text || msg, d.desc, 'permission', d.name);
      }
    } else if (type === 'stop') {
      const s = this.ensure(cwd, evt.session_id);
      s.stopped = true;
      this.resolveAlert(s);
    } else if (type === 'session_end') {
      this.remove(cwd);
    }
    if (evt.term_program || evt.bundle_id) {
      this.setOrigin(cwd, {
        termProgram: evt.term_program || '',
        bundleId: evt.bundle_id || '',
      });
    }
  }

  // 도구 실행 이벤트로 알림을 해소한다. 권한 알림은 같은 이름의 도구가
  // 실제로 실행됐을 때만 지워서, 병렬 도구나 서브에이전트의 이벤트가
  // 아직 대기 중인 권한 알림을 지워버리는 것을 막는다.
  resolveIfMatches(s, toolName) {
    if (!s.alert) return;
    if (s.alert.kind === 'permission' && s.alert.toolName && s.alert.toolName !== toolName) return;
    this.resolveAlert(s);
  }

  // 이벤트의 cwd를 위젯 키로 바꾼다. 세션 안에서 Bash가 cd로 이동하면
  // 이후 hook 이벤트의 cwd가 하위 폴더로 바뀌어, 같은 세션인데 폴더마다
  // 위젯이 증식한다. 세션 ID로 기존 세션을 먼저 찾고, 처음 보는 ID면
  // 가장 가까운 상위 경로의 세션에 귀속시켜 세션당 위젯 하나를 유지한다.
  homeCwd(cwd, sessionId, isStart) {
    const known = sessionId ? this.byId.get(sessionId) : null;
    if (known && this.map.get(known.cwd) === known) return known.cwd;
    if (this.map.has(cwd) || isStart) return cwd;
    let p = cwd;
    for (;;) {
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
      if (this.map.has(p)) return p;
    }
    return cwd;
  }

  ensure(cwd, sessionId) {
    let s = this.map.get(cwd);
    if (!s) {
      s = {
        cwd,
        alert: null,
        stopped: false,
        origin: null,
        err: '',
        lastEvent: Date.now(),
        errTimer: null,
      };
      this.map.set(cwd, s);
    }
    if (sessionId) this.byId.set(sessionId, s);
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
    // 같은 알림의 중복 발화(permission_request와 notification이 둘 다 오는 경우)는
    // 소리와 번쩍임 없이 시각만 갱신한다
    if (s.alert && s.alert.kind === (kind || 'permission') && s.alert.message === message) {
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
    this.emit('alert');
    this.emit('pending-changed');
  }

  resolveAlert(s) {
    if (!s.alert) return;
    s.alert = null;
    s.err = '';
    this.refresh();
    this.emit('pending-changed');
  }

  setOrigin(cwd, origin) {
    const s = this.map.get(cwd);
    if (!s || s.origin || !origin) return;
    s.origin = origin;
    this.refresh();
  }

  // 카드 툴팁에 표시할 세션 출처 이름
  originLabel(s) {
    const o = s.origin;
    if (!o) return '';
    if (o.termProgram === 'vscode') return 'VS Code';
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

  remove(cwd) {
    const s = this.map.get(cwd);
    if (!s) return;
    if (s.errTimer) clearTimeout(s.errTimer);
    this.map.delete(cwd);
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

  // 카드 투명도(0.2 ~ 1). 적용은 renderer가 즉시 하므로 저장만 한다.
  setOpacity(v) {
    v = Number(v);
    if (!isFinite(v)) return;
    this.cfg.set('opacity', Math.min(1, Math.max(0.2, v)));
  }

  // 스캐너가 확인한 실행 중 세션 목록과 동기화한다.
  // 스캐너가 한 번이라도 확인한 세션만 스캔 소실로 제거해서,
  // 프로세스 이름이 달라 스캔에 안 잡히는 환경에서 hook 세션이 지워지는 것을 막는다.
  syncScanned(cwds) {
    const set = new Set(cwds);
    for (const cwd of set) {
      if (!this.map.has(cwd)) console.log('[scan] found running session ' + cwd);
      const s = this.ensure(cwd, '');
      s.scanSeen = true;
      s.scanMiss = 0;
    }
    for (const [cwd, s] of [...this.map]) {
      if (set.has(cwd)) continue;
      if (!s.scanSeen) continue;
      s.scanMiss = (s.scanMiss || 0) + 1;
      if (s.scanMiss >= 3) {
        console.log('[scan] process gone, removing ' + cwd);
        this.remove(cwd);
      }
    }
  }

  pendingCount() {
    return [...this.map.values()].filter((s) => s.alert).length;
  }

  // 가장 최근에 온 알림 세션. 도크 최상단에 놓이고 글로우로 강조되며,
  // 전역 단축키(Enter 이동, Esc 닫기)의 대상이다.
  alertTarget() {
    let target = null;
    for (const s of this.map.values()) {
      if (s.alert && (!target || s.alert.ts > target.alert.ts)) target = s;
    }
    return target;
  }

  // 도크로 보낼 전체 카드 목록. 저장된 세로 위치(y)와 투명도를 함께 싣는다.
  // 위치가 없는 새 카드는 y: null로 보내고 renderer가 빈자리에 배치한다.
  refresh() {
    const names = computeDisplayNames([...this.map.keys()]);
    const ys = this.cfg.get('cardY') || {};
    const now = Date.now();
    const target = this.alertTarget();
    const cards = [...this.map.values()].map((s) => ({
      target: s === target,
      alertTs: s.alert ? s.alert.ts : 0,
      cwd: s.cwd,
      name: names.get(s.cwd),
      origin: this.originLabel(s),
      alert: !!s.alert,
      kind: s.alert ? s.alert.kind : '',
      message: s.alert ? s.alert.message : '',
      desc: s.alert ? s.alert.desc : '',
      err: s.err,
      stale: !s.alert && now - s.lastEvent > STALE_MS,
      y: typeof ys[s.cwd] === 'number' ? ys[s.cwd] : null,
    }));
    this.dock.send({ cards, opacity: this.cfg.get('opacity') || 1 });
  }
}

module.exports = Sessions;
