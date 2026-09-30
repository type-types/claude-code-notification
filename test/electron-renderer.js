const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function state(cards) {
  return { cards, opacity: 1, usage: null, usagePulse: 0 };
}

function card(key, y, alert = false, message = '') {
  return {
    key,
    agent: key.startsWith('codex:') ? 'codex' : 'claude',
    cwd: '/work/' + key.replace(/^codex:/, ''),
    name: key.replace(/^codex:/, ''),
    alert,
    working: !alert,
    front: false,
    kind: alert ? 'permission' : '',
    bump: alert ? '1:0' : '',
    message,
    desc: '',
    err: '',
    stale: false,
    y,
  };
}

async function snapshot(win) {
  return win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.card')].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        key: el.dataset.key,
        top: rect.top,
        width: rect.width,
        layoutWidth: el.offsetWidth,
        height: rect.height,
        out: el.classList.contains('out'),
        message: el.querySelector('.msg').textContent
      };
    })
  `);
}

app.whenReady().then(async () => {
  const errors = [];
  const win = new BrowserWindow({
    show: false,
    width: 272,
    height: 700,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'dock.js') },
  });
  win.webContents.on('console-message', (_event, _level, message) => errors.push(message));
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'dock', 'dock.html'));

  const first = card('codex:alpha', 100);
  const second = card('beta', 140);
  win.webContents.send('state', state([first, second]));
  await wait(80);
  let cards = await snapshot(win);
  const initialBelowTop = cards.find((c) => c.key === 'beta').top;

  const long = 'apply_patch: ' + 'very/long/path/'.repeat(40);
  win.webContents.send('state', state([card('codex:alpha', 100, true, long), second]));
  await wait(120);
  cards = await snapshot(win);
  let expanded = cards.find((c) => c.key === 'codex:alpha');
  let below = cards.find((c) => c.key === 'beta');
  assert.ok(below.top > initialBelowTop, 'card below follows the expanding height transition');

  await wait(300);
  cards = await snapshot(win);
  expanded = cards.find((c) => c.key === 'codex:alpha');
  below = cards.find((c) => c.key === 'beta');
  assert.ok(expanded.layoutWidth <= 248, 'Codex alert stays within 248px');
  assert.ok(below.top >= expanded.top + expanded.height + 6, 'card below moves past expanded Codex card');
  const expandedBelowTop = below.top;

  win.webContents.send('state', state([card('codex:alpha', 100), second]));
  await wait(120);
  cards = await snapshot(win);
  below = cards.find((c) => c.key === 'beta');
  assert.ok(below.top < expandedBelowTop, 'card below moves back up while the alert collapses');

  await wait(300);
  cards = await snapshot(win);
  const collapsed = cards.find((c) => c.key === 'codex:alpha');
  below = cards.find((c) => c.key === 'beta');
  assert.equal(collapsed.message, '', 'resolved alert text is cleared after settling');
  assert.ok(below.top >= collapsed.top + collapsed.height + 6, 'collapsed cards remain non-overlapping');

  win.webContents.send('state', state([second]));
  await wait(420);
  cards = await snapshot(win);
  assert.deepEqual(cards.map((c) => c.key), ['beta'], 'removed card leaves no stale renderer entry');

  win.webContents.send('state', state([card('codex:alpha', 100), second]));
  await wait(100);
  cards = await snapshot(win);
  assert.equal(cards.filter((c) => c.key === 'codex:alpha').length, 1, 'same key can be recreated');
  assert.equal(errors.filter((message) => message.includes('ReferenceError')).length, 0);

  const third = card('gamma', 180);
  win.webContents.send('state', state([card('codex:alpha', 100), second, third]));
  await wait(80);
  cards = await snapshot(win);
  const initialThirdTop = cards.find((c) => c.key === 'gamma').top;
  win.webContents.send('state', state([
    card('codex:alpha', 100),
    card('beta', 140, true, 'Claude permission request'),
    third,
  ]));
  await wait(120);
  cards = await snapshot(win);
  assert.ok(
    cards.find((c) => c.key === 'gamma').top > initialThirdTop,
    'existing Claude alert behavior still moves the card below'
  );

  // 접기 버그 회귀: 사용량 펄스로 패널이 튀어나온 동안 접기를 누르면 실제로
  // 접혀야 한다 (예전에는 바운스 keyframes가 transform을 잡고 있어 안 접혔다)
  const ctrlX = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const m = getComputedStyle(document.getElementById('ctrl')).transform;
        const p = m.match(/matrix\\(([^)]+)\\)/);
        return { x: p ? Number(p[1].split(',')[4]) : 0,
                 arrow: document.getElementById('tArrow').textContent,
                 out: document.getElementById('ctrl').classList.contains('out') };
      })()
    `);
  const usage = [{ key: 'session', label: '세션', percent: 40, resetsAt: new Date(Date.now() + 3600e3).toISOString(), asOf: Date.now() }];
  win.webContents.send('state', { cards: [second], opacity: 1, usage, usagePulse: 1 });
  await wait(80);
  win.webContents.send('state', { cards: [second], opacity: 1, usage, usagePulse: 2 });
  await wait(300);
  let st = await ctrlX();
  assert.ok(st.out && st.arrow === '›', 'pulse pops the panel out with a collapse arrow');
  await win.webContents.executeJavaScript(`document.getElementById('toggle').click()`);
  await wait(400);
  st = await ctrlX();
  assert.ok(!st.out && st.x > 100 && st.arrow === '‹', 'toggle during pulse collapses the panel: ' + JSON.stringify(st));
  await win.webContents.executeJavaScript(`document.getElementById('toggle').click()`);
  await wait(300);
  st = await ctrlX();
  assert.ok(st.out && st.x < 2, 'toggle expands all');
  await win.webContents.executeJavaScript(`document.getElementById('toggle').click()`);
  await wait(400);
  st = await ctrlX();
  assert.ok(!st.out && st.x > 100, 'toggle collapses all again: ' + JSON.stringify(st));
  const strip = await win.webContents.executeJavaScript(`document.getElementById('tPct').textContent`);
  assert.ok(/40%/.test(strip) && /\d+h\d+m|\d+m/.test(strip), 'collapsed strip shows percent and time left: ' + strip);
  const resetRows = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.uReset')].map((e) => e.textContent)`);
  assert.ok(resetRows.length === 1 && /^리셋 (오늘|내일) \d\d:\d\d/.test(resetRows[0]), 'row shows reset time: ' + resetRows);

  // 컨트롤 패널 드래그: 카드처럼 잡고 끌어 세로 위치를 옮길 수 있고, 놓으면
  // 위치가 main에 저장 요청되며 패널에 덮이는 카드는 아래로 밀린다.
  // 실제 입력 이벤트(sendInputEvent)로 mousedown, mousemove, mouseup을 보낸다
  const { ipcMain } = require('electron');
  const savedCtrlY = [];
  const savedCardY = [];
  ipcMain.on('set-ctrl-y', (_e, y) => savedCtrlY.push(y));
  ipcMain.on('set-card-y', (_e, map) => savedCardY.push(map));
  const ctrlRect = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('ctrl');
        return { top: el.offsetTop, height: el.offsetHeight, out: el.classList.contains('out'),
                 dragging: el.classList.contains('dragging'), styleTop: el.style.top };
      })()
    `);
  const mouse = (type, x, y, extra = {}) =>
    win.webContents.sendInputEvent(Object.assign({ type, x: Math.round(x), y: Math.round(y) }, extra));
  const dragFromTo = async (x, y0, y1) => {
    mouse('mouseDown', x, y0, { button: 'left', clickCount: 1 });
    await wait(30);
    for (let i = 1; i <= 8; i++) {
      mouse('mouseMove', x, y0 + ((y1 - y0) * i) / 8);
      await wait(15);
    }
    mouse('mouseUp', x, y1, { button: 'left', clickCount: 1 });
    await wait(60);
  };

  win.webContents.send('state', { cards: [card('codex:alpha', 100), second], ctrlY: 14, opacity: 1, usage, usagePulse: 2 });
  await wait(100);
  let cr = await ctrlRect();
  assert.equal(cr.top, 14, 'panel starts at the saved top: ' + JSON.stringify(cr));
  const wasOut = cr.out;
  // 접힌 토글 띠 안(오른쪽 가장자리 26px)을 잡고 200px 아래로 끈다
  const gripX = 272 - 20;
  const gripY = cr.top + 8;
  await dragFromTo(gripX, gripY, gripY + 200);
  cr = await ctrlRect();
  assert.equal(cr.top, 214, 'panel follows a 200px downward drag: ' + JSON.stringify(cr));
  assert.equal(cr.dragging, false, 'dragging class is cleared on drop');
  assert.equal(cr.out, wasOut, 'a drag does not toggle the panel (click suppressed)');
  assert.deepEqual(savedCtrlY, [214], 'dropped panel position is sent to main once');

  // 패널과 카드는 같은 배치 항목이라 서로 겹치지 않고, 밀린 카드는 저장된다
  // (alpha 100과 beta 140은 처음부터 겹쳐 있어 beta가 149로 밀려 저장된다)
  cards = await snapshot(win);
  for (const c of cards) {
    const overlap = c.top < cr.top + cr.height + 6 && c.top + c.height > cr.top - 6;
    assert.ok(!overlap, 'no card overlaps the moved panel: ' + JSON.stringify({ c, cr }));
  }
  assert.ok(savedCardY.length >= 1, 'pushed cards are saved');
  const ctrlTransition = await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById('ctrl')).transitionProperty`);
  assert.ok(/top/.test(ctrlTransition), 'panel animates its top like a card: ' + ctrlTransition);

  // 6px 미만 이동은 클릭으로 남는다: 토글이 실제로 눌린다
  const before = await ctrlRect();
  await dragFromTo(gripX, before.top + 8, before.top + 10);
  const after = await ctrlRect();
  assert.equal(after.top, before.top, 'tiny movement does not move the panel');
  assert.notEqual(after.out, before.out, 'tiny movement still counts as a toggle click');
  await win.webContents.executeJavaScript(`document.getElementById('toggle').click()`);
  await wait(50);

  // 패널을 끄는 동안 카드가 실시간으로 비켜 준다: 패널 중심이 카드 중심을
  // 넘으면 놓기 전에 이미 그 카드가 패널 위로 올라가 있다
  cards = await snapshot(win);
  const alphaBefore = cards.find((c) => c.key === 'codex:alpha');
  const betaBefore = cards.find((c) => c.key === 'beta');
  let cr0 = await ctrlRect();
  mouse('mouseDown', gripX, cr0.top + 8, { button: 'left', clickCount: 1 });
  await wait(30);
  // 패널 위치 214 -> 300: 패널 중심(333)이 두 카드 중심(약 122, 171)을 지난다
  const liveDelta = 300 - cr0.top;
  for (let i = 1; i <= 10; i++) {
    mouse('mouseMove', gripX, cr0.top + 8 + liveDelta * (i / 10));
    await wait(20);
  }
  await wait(350);
  cards = await snapshot(win);
  let cr1 = await ctrlRect();
  const alphaLive = cards.find((c) => c.key === 'codex:alpha');
  const betaLive = cards.find((c) => c.key === 'beta');
  assert.ok(cr1.dragging && parseFloat(cr1.styleTop) === 300, 'panel is mid-drag at 300: ' + JSON.stringify(cr1));
  assert.ok(alphaLive.top + alphaLive.height + 6 <= 300 + 0.5 && betaLive.top + betaLive.height + 6 <= 300 + 0.5,
    'both cards yield above the dragged panel before drop: ' + JSON.stringify({ alphaLive, betaLive, alphaBefore, betaBefore }));
  assert.ok(alphaLive.top < betaLive.top, 'yielding keeps card order');
  // 다시 위로 올리면(중심이 카드 중심 위로) 카드가 제자리(저장 위치)로 돌아간다
  for (let i = 9; i >= 0; i--) {
    mouse('mouseMove', gripX, cr0.top + 8 + liveDelta * (i / 10));
    await wait(20);
  }
  await wait(350);
  cards = await snapshot(win);
  assert.ok(Math.abs(cards.find((c) => c.key === 'codex:alpha').top - alphaBefore.top) < 1 &&
    Math.abs(cards.find((c) => c.key === 'beta').top - betaBefore.top) < 1,
    'cards return to their saved spots when the panel moves back up: ' + JSON.stringify(cards));
  mouse('mouseUp', gripX, cr0.top + 8, { button: 'left', clickCount: 1 });
  await wait(400);
  cr1 = await ctrlRect();
  assert.equal(cr1.top, cr0.top, 'dropping back where it started keeps the panel put');
  assert.ok(savedCtrlY.length >= 1, 'drop still saves');

  // 끄는 동안은 카드처럼 화면 밖까지 따라가고, 놓으면 창 안으로 돌아온다
  const mid = await ctrlRect();
  mouse('mouseDown', gripX, mid.top + 8, { button: 'left', clickCount: 1 });
  await wait(30);
  for (let i = 1; i <= 8; i++) {
    mouse('mouseMove', gripX, mid.top + 8 + 250 * i);
    await wait(15);
  }
  await wait(30);
  cr = await ctrlRect();
  assert.ok(cr.dragging && parseFloat(cr.styleTop) > 700, 'panel follows the cursor past the window edge while dragging: ' + JSON.stringify(cr));
  mouse('mouseUp', gripX, mid.top + 8 + 2000, { button: 'left', clickCount: 1 });
  await wait(400);
  cr = await ctrlRect();
  assert.ok(cr.top + cr.height + 14 <= 700 && cr.top > 214, 'panel dropped below the window comes back inside: ' + JSON.stringify(cr));
  const panelBottomTop = cr.top;

  // 패널이 맨 아래에 있을 때 카드를 그 아래에 놓으면, 패널이 위로 밀리고
  // 카드와 패널 모두 창 안에 머문다 (예전에는 카드가 화면 밖으로 내려갔다)
  cards = await snapshot(win);
  let betaCard = cards.find((c) => c.key === 'beta');
  await dragFromTo(272 - 12, betaCard.top + 10, betaCard.top + 2000);
  await wait(400);
  cards = await snapshot(win);
  cr = await ctrlRect();
  const boxes = cards.map((c) => ({ key: c.key, top: c.top, bottom: c.top + c.height }))
    .concat([{ key: 'ctrl', top: cr.top, bottom: cr.top + cr.height }]);
  for (const b of boxes) assert.ok(b.top >= 14 - 0.5 && b.bottom <= 700 - 14 + 0.5, 'every item stays inside the window: ' + JSON.stringify(boxes));
  for (const a of boxes) for (const b of boxes) {
    if (a === b) continue;
    assert.ok(a.bottom + 6 <= b.top + 0.5 || b.bottom + 6 <= a.top + 0.5, 'items do not overlap: ' + JSON.stringify(boxes));
  }
  assert.ok(cr.top < panelBottomTop, 'panel was pushed up to make room: ' + JSON.stringify({ cr, panelBottomTop }));
  // beta를 원래 자리(140 근처)로 되돌린다
  betaCard = cards.find((c) => c.key === 'beta');
  await dragFromTo(272 - 12, betaCard.top + 10, 150);
  await wait(400);

  await dragFromTo(gripX, cr.top + 8, cr.top - 2000);
  await wait(400);
  cr = await ctrlRect();
  assert.equal(cr.top, 14, 'panel dropped above the window comes back to the top margin: ' + JSON.stringify(cr));

  // main이 보내는 저장값이 화면에 반영된다 (막 놓은 직후 2초는 보호)
  await wait(2100);
  win.webContents.send('state', { cards: [card('codex:alpha', 100), second], ctrlY: 300, opacity: 1, usage, usagePulse: 2 });
  await wait(400); // 패널도 카드처럼 top 전환(0.25s)이 있다
  cr = await ctrlRect();
  cards = await snapshot(win);
  assert.equal(cr.top, 300, 'saved panel position from main is applied: ' + JSON.stringify({ cr, cards }));
  cards = await snapshot(win);
  for (const c of cards) {
    const overlap = c.top < cr.top + cr.height + 6 && c.top + c.height > cr.top - 6;
    assert.ok(!overlap, 'layout keeps cards clear of the panel: ' + JSON.stringify({ c, cr }));
  }

  // 접힌 띠: 세션(S), Fable 주간(F), Codex 주간(C)이 각각 [머리글자 %]와
  // 남은 시간 두 줄로 쌓이고, 띠 폭(26px)은 넓어지지 않는다
  const day = 86400e3;
  const usage3 = [
    { key: 'session', label: '세션', percent: 40, resetsAt: new Date(Date.now() + 3600e3).toISOString(), asOf: Date.now() },
    { key: 'weekly_all', label: '주간', percent: 70, resetsAt: new Date(Date.now() + 5 * day).toISOString(), asOf: Date.now() },
    { key: 'model:Fable', label: 'Fable', percent: 12, resetsAt: new Date(Date.now() + 2 * day + 5 * 3600e3).toISOString(), asOf: Date.now() },
    { key: 'codex:secondary', agent: 'codex', label: '주간', windowMinutes: 10080, percent: 55, resetsAt: new Date(Date.now() + 3 * day + 2 * 3600e3).toISOString(), asOf: Date.now() },
  ];
  win.webContents.send('state', { cards: [card('codex:alpha', 100), second], ctrlY: 300, opacity: 1, usage: usage3, usagePulse: 2 });
  await wait(120);
  const stripInfo = await win.webContents.executeJavaScript(`
    (() => {
      const t = document.getElementById('tPct');
      return { rows: [...t.children].map((e) => [...e.children].map((r) => r.textContent)),
               width: t.scrollWidth, toggle: document.getElementById('toggle').offsetWidth };
    })()
  `);
  assert.deepEqual(stripInfo.rows.map((r) => r[0]), ['S40%', 'F12%', 'C55%'], 'strip stacks session, Fable, Codex: ' + JSON.stringify(stripInfo));
  assert.ok(/^\d+m$|^\d+h\d+m$/.test(stripInfo.rows[0][1]), 'session shows time left: ' + stripInfo.rows[0][1]);
  assert.equal(stripInfo.rows[1][1], '2d5h', 'Fable shows days and hours left');
  assert.equal(stripInfo.rows[2][1], '3d2h', 'Codex weekly shows days and hours left');
  // toggle의 offsetWidth는 26px 폭 + 오른쪽 테두리 1px
  assert.ok(stripInfo.toggle === 27 && stripInfo.width <= 26, 'strip does not widen: ' + JSON.stringify(stripInfo));
  // 주간 전체 항목만 있고 모델과 Codex가 없으면 세션만 남는다
  win.webContents.send('state', { cards: [card('codex:alpha', 100), second], ctrlY: 300, opacity: 1, usage: usage3.slice(0, 2), usagePulse: 2 });
  await wait(80);
  const stripOnly = await win.webContents.executeJavaScript(`[...document.getElementById('tPct').children].map((e) => e.children[0].textContent)`);
  assert.deepEqual(stripOnly, ['S40%'], 'without model and Codex entries only the session shows');

  // 카드를 창 아래 밖에 놓으면 창 안으로 돌아온다 (위쪽과 같은 규칙)
  cards = await snapshot(win);
  let beta = cards.find((c) => c.key === 'beta');
  await dragFromTo(272 - 12, beta.top + 10, beta.top + 2000);
  await wait(320); // top 전환(0.25s)이 끝난 뒤 잰다
  cards = await snapshot(win);
  beta = cards.find((c) => c.key === 'beta');
  assert.ok(beta.top + beta.height + 14 <= 700 && beta.top > 500, 'card dropped below the window comes back inside: ' + JSON.stringify(beta));
  await dragFromTo(272 - 12, beta.top + 10, beta.top - 2000);
  await wait(320);
  cards = await snapshot(win);
  beta = cards.find((c) => c.key === 'beta');
  assert.ok(beta.top >= 14 && beta.top < 100, 'card dropped above the window comes back to the top margin: ' + JSON.stringify(beta));

  // 맨 위 카드 위로 패널 넘기기: 카드(14)가 패널(90)보다 위에 있고 패널이
  // 훨씬 클 때, 패널 위쪽을 잡고 커서를 창 위 끝까지 올리면 패널 중심은 아직
  // 카드 중심 아래여도 커서가 지났으므로 카드가 패널 아래로 비켜 준다
  win.webContents.send('state', { cards: [card('codex:alpha', 14), card('beta', 300)], ctrlY: 90, opacity: 1, usage: usage3, usagePulse: 2 });
  await wait(2500); // 직전 드랍의 저장 보호(2초)가 풀린 뒤 상태값이 적용된다
  win.webContents.send('state', { cards: [card('codex:alpha', 14), card('beta', 300)], ctrlY: 90, opacity: 1, usage: usage3, usagePulse: 2 });
  await wait(400);
  let top0 = await ctrlRect();
  assert.equal(top0.top, 90, 'panel sits below the top card: ' + JSON.stringify(top0));
  mouse('mouseDown', gripX, top0.top + 6, { button: 'left', clickCount: 1 });
  await wait(30);
  for (let i = 1; i <= 8; i++) {
    mouse('mouseMove', gripX, Math.max(0, top0.top + 6 - 100 * (i / 8)));
    await wait(20);
  }
  await wait(350);
  cards = await snapshot(win);
  let topCard = cards.find((c) => c.key === 'codex:alpha');
  const liveCtrlTop = parseFloat((await ctrlRect()).styleTop);
  assert.ok(liveCtrlTop < 14, 'panel is dragged above the top margin: ' + liveCtrlTop);
  assert.ok(topCard.top >= 14 + top0.height, 'top card yields below the panel while dragging: ' + JSON.stringify({ topCard, liveCtrlTop }));
  mouse('mouseUp', gripX, 0, { button: 'left', clickCount: 1 });
  await wait(400);
  cards = await snapshot(win);
  topCard = cards.find((c) => c.key === 'codex:alpha');
  top0 = await ctrlRect();
  assert.equal(top0.top, 14, 'panel lands at the top margin');
  assert.ok(Math.abs(topCard.top - (14 + top0.height + 6)) < 1, 'top card is saved right below the panel: ' + JSON.stringify({ topCard, top0 }));

  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
