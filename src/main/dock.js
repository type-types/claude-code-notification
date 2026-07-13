const { BrowserWindow, screen } = require('electron');
const path = require('path');

const DOCK_W = 272;

// 화면 오른쪽 가장자리에 상주하는 단일 도크 창. 모든 세션 카드를 담는다.
// 평소에는 마우스 이벤트를 아래 앱으로 통과시키고(forward로 hover는 감지),
// 커서가 카드 위에 있을 때만 renderer의 요청으로 이벤트를 받는다.
class Dock {
  constructor() {
    this.win = null;
    this.lastList = [];
  }

  create() {
    const wa = screen.getPrimaryDisplay().workArea;
    this.win = new BrowserWindow({
      x: wa.x + wa.width - DOCK_W,
      y: wa.y,
      width: DOCK_W,
      height: wa.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'dock.js'),
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'dock', 'dock.html'));
    this.win.webContents.on('did-finish-load', () => this.send(this.lastList));
    screen.on('display-metrics-changed', () => this.layout());
    screen.on('display-added', () => this.layout());
    screen.on('display-removed', () => this.layout());
  }

  layout() {
    if (!this.win || this.win.isDestroyed()) return;
    const wa = screen.getPrimaryDisplay().workArea;
    this.win.setBounds({ x: wa.x + wa.width - DOCK_W, y: wa.y, width: DOCK_W, height: wa.height });
  }

  send(list) {
    this.lastList = list;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('state', list);
  }

  setMouseCapture(on) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }
}

module.exports = Dock;
