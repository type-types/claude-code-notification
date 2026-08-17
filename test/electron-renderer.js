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

  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
