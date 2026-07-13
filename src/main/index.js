const {
  app,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  systemPreferences,
} = require('electron');
const path = require('path');
const Config = require('./config');
const Sound = require('./sound');
const startServer = require('./server');
const Sessions = require('./sessions');
const Border = require('./border');
const Scanner = require('./scanner');
const permission = require('./permission');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let tray = null;

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  const cfg = new Config();
  const sound = new Sound(cfg);
  const border = new Border(cfg);
  const sessions = new Sessions(cfg);

  sessions.on('alert', () => {
    sound.play();
    border.flash(sessions.pendingCount());
  });
  sessions.on('pending-changed', () => {
    border.setPending(sessions.pendingCount());
  });

  startServer(cfg.get('port'), (evt) => sessions.handleEvent(evt));
  new Scanner(sessions).start();
  setupIpc(sessions);
  setupTray(cfg, border, sessions);

  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  console.log('[app] accessibility trusted: ' + trusted);
});

app.on('window-all-closed', () => {
  // 위젯이 모두 닫혀도 메뉴바에 상주한다
});

function setupIpc(sessions) {
  ipcMain.on('focus', (e) => {
    const s = sessions.findByWebContents(e.sender.id);
    if (!s) return;
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      sessions.setError(s, '손쉬운 사용 권한 필요');
      return;
    }
    permission.focus(path.basename(s.cwd), (result) => {
      console.log('[focus] ' + s.cwd + ' -> ' + result);
      if (result !== 'OK' && sessions.map.has(s.cwd)) {
        sessions.setError(s, '창을 찾을 수 없음');
      }
    });
  });

  ipcMain.on('drag-start', (e) => {
    const s = sessions.findByWebContents(e.sender.id);
    if (s) sessions.startDrag(s);
  });

  ipcMain.on('drag-end', (e) => {
    const s = sessions.findByWebContents(e.sender.id);
    if (s) sessions.endDrag(s);
  });

  ipcMain.on('widget-menu', (e) => {
    const s = sessions.findByWebContents(e.sender.id);
    if (!s) return;
    Menu.buildFromTemplate([
      { label: s.cwd, enabled: false },
      { type: 'separator' },
      { label: '위젯 닫기', click: () => sessions.remove(s.cwd) },
    ]).popup({ window: s.win });
  });
}

function setupTray(cfg, border, sessions) {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('🔔');
  tray.setToolTip('Claude Code 알림 오버레이');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '음소거',
        type: 'checkbox',
        checked: cfg.get('muted'),
        click: (item) => cfg.set('muted', item.checked),
      },
      {
        label: '상시 글로우',
        type: 'checkbox',
        checked: cfg.get('idleGlow'),
        click: (item) => {
          cfg.set('idleGlow', item.checked);
          border.setPending(sessions.pendingCount());
        },
      },
      {
        label: '로그인 시 자동 시작',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ])
  );
}
