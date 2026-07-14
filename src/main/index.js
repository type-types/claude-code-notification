const { app, ipcMain, Menu, Tray, nativeImage, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const Config = require('./config');
const Sound = require('./sound');
const startServer = require('./server');
const Sessions = require('./sessions');
const Dock = require('./dock');
const Border = require('./border');
const { Scanner, findSessionProcs } = require('./scanner');
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
  const dock = new Dock();
  dock.create();
  const sessions = new Sessions(cfg, dock);

  sessions.on('alert', (kind) => {
    sound.play();
    border.flash(sessions.pendingCount(), kind);
  });
  sessions.on('pending-changed', () => {
    border.setPending(sessions.pendingCount());
  });

  startServer(cfg.get('port'), (evt) => sessions.handleEvent(evt));
  new Scanner(sessions).start();
  setupIpc(sessions, dock);
  setupTray(cfg, border, sessions);

  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  console.log('[app] accessibility trusted: ' + trusted);
});

app.on('window-all-closed', () => {
  // 위젯이 모두 닫혀도 메뉴바에 상주한다
});

// 전역 단축키(Option+Enter, Option+Esc)는 2026-07-14에 제거했다.
// 완료 알림이 상시 상태가 되면서 키를 사실상 항상 점유하게 됐고,
// 사용자도 쓰지 않는 기능이었다. 알림 처리는 카드 클릭으로 한다.

// 창 제목 매칭 후보: 세션 폴더 이름과 그 상위 폴더 이름들 (홈 디렉토리 위는 제외).
// 워크스페이스 하위 폴더에서 실행한 세션도 워크스페이스 이름으로 창을 찾게 한다.
function titleCandidates(cwd) {
  const home = os.homedir();
  const rel = cwd.startsWith(home + '/') ? cwd.slice(home.length + 1) : cwd;
  const parts = rel.split('/').filter(Boolean);
  const candidates = parts.reverse().slice(0, 3);
  return candidates.length ? candidates : [path.basename(cwd)];
}

// claude 프로세스에 SIGTERM을 보내고, 잠시 후 부모 셸도 종료해
// VSC 터미널 탭까지 닫는다. 위젯은 즉시 제거한다 (스캔, hook 정리와 별개).
function killSession(sessions, s) {
  findSessionProcs(s.cwd, (procs) => {
    if (!sessions.map.has(s.cwd)) return;
    if (procs.length === 0) {
      sessions.setError(s, '실행 중인 프로세스가 없음');
      return;
    }
    console.log('[kill] ' + s.cwd + ' pids ' + procs.map((p) => p.pid + '/' + p.ppid).join(' '));
    for (const p of procs) {
      try {
        process.kill(p.pid, 'SIGTERM');
      } catch (err) {
        console.error('[kill] pid ' + p.pid + ': ' + err.message);
      }
    }
    setTimeout(() => {
      for (const p of procs) {
        if (p.ppid <= 1) continue;
        try {
          process.kill(p.ppid, 'SIGTERM');
        } catch (err) {
          console.error('[kill] ppid ' + p.ppid + ': ' + err.message);
        }
      }
      if (sessions.map.has(s.cwd)) sessions.remove(s.cwd);
    }, 800);
  });
}

function focusSession(sessions, s) {
  const o = s.origin || {};
  const isVscode =
    (!o.termProgram && !o.bundleId) ||
    o.termProgram === 'vscode' ||
    /vscode/i.test(o.bundleId || '');
  if (!isVscode && o.bundleId) {
    // VSC가 아닌 출처(Claude 앱, iTerm 등)는 해당 앱을 앞으로 가져온다
    permission.activateApp(o.bundleId, (result) => {
      console.log('[focus] ' + s.cwd + ' app ' + o.bundleId + ' -> ' + result);
    });
    return;
  }
  if (!systemPreferences.isTrustedAccessibilityClient(true)) {
    sessions.setError(s, '손쉬운 사용 권한 필요');
    return;
  }
  permission.focus(titleCandidates(s.cwd), (result) => {
    console.log('[focus] ' + s.cwd + ' -> ' + result);
    if (result !== 'OK' && sessions.map.has(s.cwd)) {
      if (o.termProgram === 'vscode') {
        // 제목 매칭 실패 시 VSC 앱이라도 앞으로 가져온다
        permission.activateApp(o.bundleId || 'com.microsoft.VSCode');
      } else {
        sessions.setError(s, '창을 찾을 수 없음');
      }
    }
  });
}

function setupIpc(sessions, dock) {
  ipcMain.on('focus', (e, cwd) => {
    const s = sessions.map.get(cwd);
    if (!s) return;
    // 카드를 클릭했다는 것은 알림을 확인했다는 뜻이므로 함께 해소한다.
    // x 버튼은 이 동작으로 대체되어 제거했다.
    if (s.alert) sessions.resolveAlert(s);
    focusSession(sessions, s);
  });

  ipcMain.on('set-card-y', (e, map) => {
    if (map && typeof map === 'object' && !Array.isArray(map)) sessions.setCardY(map);
  });

  ipcMain.on('set-opacity', (e, v) => {
    sessions.setOpacity(v);
  });

  ipcMain.on('mouse-capture', (e, on) => {
    dock.setMouseCapture(!!on);
  });

  ipcMain.on('widget-menu', (e, cwd) => {
    const s = sessions.map.get(cwd);
    if (!s) return;
    Menu.buildFromTemplate([
      { label: s.cwd, enabled: false },
      { type: 'separator' },
      { label: '카드 닫기', click: () => sessions.remove(s.cwd) },
      { label: '세션 종료 (터미널 닫기)', click: () => killSession(sessions, s) },
    ]).popup({ window: dock.win });
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
