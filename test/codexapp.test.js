const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notify-codexapp-'));
process.env.CODEX_HOME = tempHome;
const CodexRollouts = require('../src/main/codexapp');
const Sessions = require('../src/main/sessions');

class Config {
  constructor() {
    this.values = { cardY: {}, opacity: 1 };
  }
  get(key) {
    return this.values[key];
  }
  set(key, value) {
    this.values[key] = value;
  }
}

const day = path.join(tempHome, 'sessions', '2026', '09', '23');
fs.mkdirSync(day, { recursive: true });

function rollout(name, originator, cwd, id) {
  const file = path.join(day, 'rollout-2026-09-23T00-00-00-' + name + '.jsonl');
  const meta = { timestamp: '2026-09-23T00:00:00.000Z', type: 'session_meta', payload: { id, session_id: id, cwd, originator } };
  fs.writeFileSync(file, JSON.stringify(meta) + '\n');
  return file;
}

function append(file, payload) {
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n');
}

test.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));

test('desktop threads become cards from the rollout file, CLI threads are ignored', (t) => {
  const sessions = new Sessions(new Config(), { send() {} });
  const alerts = [];
  sessions.on('alert', (kind) => alerts.push(kind));
  const watcher = new CodexRollouts(sessions);
  t.after(() => {
    clearInterval(sessions.staleTimer);
    watcher.stop();
  });

  const desktop = rollout('desk', 'Codex Desktop', '/work/app-project', 'thread-1');
  rollout('cli', 'codex-tui', '/work/cli-project', 'thread-2');
  append(desktop, { type: 'task_started', turn_id: 't1', started_at: Math.floor(Date.now() / 1000) - 30 });

  watcher.poll(true);
  assert.equal(sessions.map.size, 1, 'only the desktop thread has a card');
  const s = [...sessions.map.values()][0];
  assert.equal(s.agent, 'codex');
  assert.equal(s.cwd, '/work/app-project');
  assert.equal(s.desktop, true);
  assert.ok(s.turnStart > 0, 'in-progress turn restored as working');
  assert.equal(s.origin.bundleId, 'com.openai.codex');
  assert.deepEqual(alerts, [], 'initial scan is silent');

  append(desktop, { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' });
  watcher.poll(false);
  assert.equal(s.alert && s.alert.kind, 'done');
  assert.deepEqual(alerts, ['done']);
  assert.match(s.alert.desc, /소요/);

  append(desktop, { type: 'task_started', turn_id: 't2', started_at: Math.floor(Date.now() / 1000) });
  watcher.poll(false);
  assert.equal(s.alert, null, 'new turn resolves the done alert');
  assert.ok(s.turnStart > 0);

  append(desktop, { type: 'turn_aborted', turn_id: 't2' });
  watcher.poll(false);
  assert.equal(s.turnStart, 0, 'aborted turn is no longer working');

  // 프로세스 스캔은 데스크톱 카드를 건드리지 않는다
  for (let i = 0; i < 4; i++) sessions.syncScanned([]);
  assert.equal(sessions.map.size, 1);

  // 기록이 사라지면(보관) 카드도 사라진다
  fs.rmSync(desktop);
  watcher.poll(false);
  assert.equal(sessions.map.size, 0);
});
