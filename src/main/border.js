const { BrowserWindow, screen } = require('electron');
const path = require('path');

const FLASH_MS = 1700;

// 마우스 커서가 있는 디스플레이 전체를 덮는 클릭 통과 투명 창.
// 가장자리 4변 글로우의 점멸과 상시 유지는 렌더러가 담당한다.
class Border {
  constructor(cfg) {
    this.cfg = cfg;
    this.win = null;
    this.pending = 0;
    this.flashUntil = 0;
  }

  ensureWin() {
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (this.win && !this.win.isDestroyed()) {
      this.win.setBounds(disp.bounds);
      return this.win;
    }
    // show: false + showInactive: 기본 show true로 창을 만들면 focusable false여도
    // macOS가 앱을 활성화해서 사용자가 쓰던 창의 키보드 포커스를 뺏는다 (실측 확인)
    const win = new BrowserWindow({
      show: false,
      x: disp.bounds.x,
      y: disp.bounds.y,
      width: disp.bounds.width,
      height: disp.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'border.js'),
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'border', 'border.html'));
    win.showInactive();
    this.win = win;
    return win;
  }

  flash(pendingCount, kind) {
    this.pending = pendingCount;
    const now = Date.now();
    if (now < this.flashUntil) return;
    this.flashUntil = now + FLASH_MS;
    const win = this.ensureWin();
    const send = () => {
      if (!win.isDestroyed()) win.webContents.send('flash', kind || '');
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
    setTimeout(() => this.applyIdle(), FLASH_MS + 50);
  }

  setPending(count) {
    this.pending = count;
    if (Date.now() >= this.flashUntil) this.applyIdle();
  }

  applyIdle() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.pending > 0 && this.cfg.get('idleGlow')) {
      this.win.webContents.send('idle', true);
    } else {
      const w = this.win;
      this.win = null;
      w.webContents.send('idle', false);
      setTimeout(() => {
        if (!w.isDestroyed()) w.destroy();
      }, 600);
    }
  }
}

module.exports = Border;
