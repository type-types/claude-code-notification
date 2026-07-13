const { BrowserWindow, screen } = require('electron');
const path = require('path');
const EventEmitter = require('events');

const W_MIN = 160;
const W_MAX = 240;
const H_NORMAL = 36;
const H_ALERT = 70;
const H_ALERT_DESC = 84;
const STACK_STEP = 44;
const H_INPUT = 52;
const H_ERR = 15;
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
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.map = new Map();
    this.staleTimer = setInterval(() => this.checkStale(), 60 * 1000);
  }

  handleEvent(evt) {
    const type = evt && evt.type;
    const cwd = evt && evt.cwd;
    if (!type || !cwd) return;
    console.log('[event] ' + type + ' ' + cwd);
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

  ensure(cwd, sessionId) {
    let s = this.map.get(cwd);
    if (!s) {
      s = {
        cwd,
        sessionId: sessionId || '',
        name: path.basename(cwd),
        alert: null,
        stopped: false,
        origin: null,
        err: '',
        lastEvent: Date.now(),
        win: null,
        dragTimer: null,
        errTimer: null,
      };
      this.map.set(cwd, s);
      this.createWindow(s);
      this.refreshNames();
    }
    if (sessionId) s.sessionId = sessionId;
    s.lastEvent = Date.now();
    if (s.win && !s.win.isDestroyed()) s.win.setOpacity(1);
    return s;
  }

  createWindow(s) {
    const saved = this.cfg.get('positions')[s.cwd];
    const pos = saved && this.isOnScreen(saved) ? saved : this.defaultPos();
    const win = new BrowserWindow({
      x: pos.x,
      y: pos.y,
      width: this.widthFor(s),
      height: H_NORMAL,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'widget.js'),
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'widget', 'widget.html'));
    win.webContents.on('did-finish-load', () => this.sendState(s));
    s.win = win;
  }

  isOnScreen(p) {
    return screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return p.x >= b.x && p.x < b.x + b.width - 40 && p.y >= b.y && p.y < b.y + b.height - 20;
    });
  }

  defaultPos() {
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + wa.width - W_MAX - 16;
    let y = wa.y + 16;
    const taken = [...this.map.values()]
      .filter((o) => o.win && !o.win.isDestroyed())
      .map((o) => o.win.getBounds());
    while (taken.some((b) => Math.abs(b.y - y) < STACK_STEP - 4 && Math.abs(b.x - x) < W_MAX)) {
      y += STACK_STEP;
    }
    return { x, y };
  }

  widthFor(s) {
    return Math.min(W_MAX, Math.max(W_MIN, 28 + s.name.length * 8));
  }

  applySize(s) {
    if (!s.win || s.win.isDestroyed()) return;
    const b = s.win.getBounds();
    const base = !s.alert
      ? H_NORMAL
      : s.alert.kind === 'input'
        ? H_INPUT
        : s.alert.desc
          ? H_ALERT_DESC
          : H_ALERT;
    s.win.setBounds(
      {
        x: b.x,
        y: b.y,
        width: s.alert ? W_MAX : this.widthFor(s),
        height: base + (s.err ? H_ERR : 0),
      },
      true
    );
  }

  refreshNames() {
    const names = computeDisplayNames([...this.map.keys()]);
    for (const s of this.map.values()) {
      const next = names.get(s.cwd);
      if (next !== s.name) {
        s.name = next;
        this.applySize(s);
      }
      this.sendState(s);
    }
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
    this.applySize(s);
    this.sendState(s);
    this.emit('alert');
    this.emit('pending-changed');
  }

  resolveAlert(s) {
    if (!s.alert) return;
    s.alert = null;
    s.err = '';
    this.applySize(s);
    this.sendState(s);
    this.emit('pending-changed');
  }

  setOrigin(cwd, origin) {
    const s = this.map.get(cwd);
    if (!s || s.origin || !origin) return;
    s.origin = origin;
    this.sendState(s);
  }

  // 위젯 툴팁에 표시할 세션 출처 이름
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
    this.applySize(s);
    this.sendState(s);
    if (s.errTimer) clearTimeout(s.errTimer);
    s.errTimer = setTimeout(() => {
      s.err = '';
      this.applySize(s);
      this.sendState(s);
    }, ERR_CLEAR_MS);
  }

  remove(cwd) {
    const s = this.map.get(cwd);
    if (!s) return;
    if (s.dragTimer) clearInterval(s.dragTimer);
    if (s.errTimer) clearTimeout(s.errTimer);
    if (s.win && !s.win.isDestroyed()) s.win.destroy();
    this.map.delete(cwd);
    this.refreshNames();
    this.emit('pending-changed');
  }

  startDrag(s) {
    if (s.dragTimer || !s.win || s.win.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const b = s.win.getBounds();
    const off = { x: cur.x - b.x, y: cur.y - b.y };
    s.dragTimer = setInterval(() => {
      if (!s.win || s.win.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      s.win.setPosition(p.x - off.x, p.y - off.y);
    }, 16);
  }

  endDrag(s) {
    if (!s.dragTimer) return;
    clearInterval(s.dragTimer);
    s.dragTimer = null;
    if (!s.win || s.win.isDestroyed()) return;
    const b = s.win.getBounds();
    const positions = this.cfg.get('positions');
    positions[s.cwd] = { x: b.x, y: b.y };
    this.cfg.set('positions', positions);
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

  checkStale() {
    const now = Date.now();
    for (const s of this.map.values()) {
      if (!s.win || s.win.isDestroyed()) continue;
      s.win.setOpacity(!s.alert && now - s.lastEvent > STALE_MS ? 0.45 : 1);
    }
  }

  pendingCount() {
    return [...this.map.values()].filter((s) => s.alert).length;
  }

  findByWebContents(wcId) {
    for (const s of this.map.values()) {
      if (s.win && !s.win.isDestroyed() && s.win.webContents.id === wcId) return s;
    }
    return null;
  }

  sendState(s) {
    if (!s.win || s.win.isDestroyed()) return;
    s.win.webContents.send('state', {
      name: s.name,
      cwd: s.cwd,
      origin: this.originLabel(s),
      alert: !!s.alert,
      kind: s.alert ? s.alert.kind : '',
      message: s.alert ? s.alert.message : '',
      desc: s.alert ? s.alert.desc : '',
      err: s.err,
    });
  }
}

module.exports = Sessions;
