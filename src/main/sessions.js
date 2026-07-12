const { BrowserWindow, screen } = require('electron');
const path = require('path');
const EventEmitter = require('events');

const W_MIN = 160;
const W_MAX = 240;
const H_NORMAL = 36;
const H_ALERT = 92;
const H_ALERT_DESC = 106;
const STACK_STEP = 44;
const STALE_MS = 4 * 60 * 60 * 1000;
const APPROVE_RETRY_MS = 60 * 1000;
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
    } else if (type === 'pre_tool_use') {
      const s = this.ensure(cwd, evt.session_id);
      if (s.alert) this.resolveAlert(s);
      s.lastTool = { name: evt.tool_name || '', input: evt.tool_input || {}, ts: Date.now() };
    } else if (type === 'post_tool_use') {
      const s = this.ensure(cwd, evt.session_id);
      if (s.alert) this.resolveAlert(s);
    } else if (type === 'notification') {
      const s = this.ensure(cwd, evt.session_id);
      const d = this.toolDetail(s);
      this.setAlert(s, d.text || evt.message || '', d.desc);
    } else if (type === 'stop') {
      this.resolveAlert(this.ensure(cwd, evt.session_id));
    } else if (type === 'session_end') {
      this.remove(cwd);
    }
  }

  ensure(cwd, sessionId) {
    let s = this.map.get(cwd);
    if (!s) {
      s = {
        cwd,
        sessionId: sessionId || '',
        name: path.basename(cwd),
        alert: null,
        pendingApprove: false,
        err: '',
        lastEvent: Date.now(),
        win: null,
        dragTimer: null,
        approveTimer: null,
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
    s.win.setBounds(
      {
        x: b.x,
        y: b.y,
        width: s.alert ? W_MAX : this.widthFor(s),
        height: s.alert ? (s.alert.desc ? H_ALERT_DESC : H_ALERT) : H_NORMAL,
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
    if (!t || Date.now() - t.ts > 30 * 1000) return { text: '', desc: '' };
    const input = t.input || {};
    let detail = '';
    let desc = '';
    if (t.name === 'Bash') {
      detail = input.command || '';
      desc = input.description || '';
    } else if (input.file_path) detail = input.file_path;
    else if (input.url) detail = input.url;
    else {
      const j = JSON.stringify(input);
      detail = j && j !== '{}' ? j : '';
    }
    let text = detail ? t.name + ': ' + detail : t.name;
    if (text.length > 300) text = text.slice(0, 300) + '...';
    return { text, desc };
  }

  setAlert(s, message, desc) {
    if (s.approveTimer) clearTimeout(s.approveTimer);
    s.alert = { message, desc: desc || '', ts: Date.now() };
    s.pendingApprove = false;
    s.err = '';
    this.applySize(s);
    this.sendState(s);
    this.emit('alert');
    this.emit('pending-changed');
  }

  resolveAlert(s) {
    if (!s.alert) return;
    if (s.approveTimer) clearTimeout(s.approveTimer);
    s.alert = null;
    s.pendingApprove = false;
    s.err = '';
    this.applySize(s);
    this.sendState(s);
    this.emit('pending-changed');
  }

  markApprovePending(s) {
    s.pendingApprove = true;
    this.sendState(s);
    s.approveTimer = setTimeout(() => {
      if (s.alert && s.pendingApprove) {
        s.pendingApprove = false;
        this.sendState(s);
      }
    }, APPROVE_RETRY_MS);
  }

  setError(s, msg) {
    s.err = msg;
    this.sendState(s);
    if (s.errTimer) clearTimeout(s.errTimer);
    s.errTimer = setTimeout(() => {
      s.err = '';
      this.sendState(s);
    }, ERR_CLEAR_MS);
  }

  remove(cwd) {
    const s = this.map.get(cwd);
    if (!s) return;
    if (s.dragTimer) clearInterval(s.dragTimer);
    if (s.approveTimer) clearTimeout(s.approveTimer);
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
      alert: !!s.alert,
      message: s.alert ? s.alert.message : '',
      desc: s.alert ? s.alert.desc : '',
      pending: s.pendingApprove,
      err: s.err,
    });
  }
}

module.exports = Sessions;
