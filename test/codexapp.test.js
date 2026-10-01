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

function rollout(name, originator, cwd, id, extra) {
  const file = path.join(day, 'rollout-2026-09-23T00-00-00-' + name + '.jsonl');
  const payload = Object.assign({ id, session_id: id, cwd, originator }, extra || {});
  const meta = { timestamp: '2026-09-23T00:00:00.000Z', type: 'session_meta', payload };
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

// codex 0.159 multi_agent v2 실측 (2026-10-01): 서브에이전트 스레드도 rollout 파일을
// 따로 쓰고 originator와 cwd가 부모와 같다. 카드와 완료 알림은 부모 스레드만 낸다
test('subagent threads of a desktop thread do not become cards or alerts', (t) => {
  const sessions = new Sessions(new Config(), { send() {} });
  const alerts = [];
  sessions.on('alert', (kind) => alerts.push(kind));
  const watcher = new CodexRollouts(sessions);
  t.after(() => {
    clearInterval(sessions.staleTimer);
    watcher.stop();
  });

  const cwd = '/work/multi-agent';
  const parent = rollout('parent', 'codex_work_desktop', cwd, 'root-1', {
    source: 'vscode',
    thread_source: 'user',
  });
  watcher.poll(true);
  assert.equal(sessions.map.size, 1);

  // 실측 형태: 세 표식이 모두 있고 session_id는 루트 스레드 id
  rollout('sub-a', 'codex_work_desktop', cwd, 'sub-a', {
    session_id: 'root-1',
    source: { subagent: { thread_spawn: { parent_thread_id: 'root-1', depth: 1, agent_path: '/root/review' } } },
    thread_source: 'subagent',
    parent_thread_id: 'root-1',
  });
  // 표식이 하나만 있는 변형도 서브에이전트로 본다
  const subB = rollout('sub-b', 'codex_work_desktop', cwd, 'sub-b', { thread_source: 'subagent' });
  rollout('sub-c', 'codex_work_desktop', cwd, 'sub-c', { parent_thread_id: 'root-1' });
  append(subB, { type: 'task_started', turn_id: 's1', started_at: Math.floor(Date.now() / 1000) });
  append(subB, { type: 'task_complete', turn_id: 's1', last_agent_message: 'done' });
  watcher.poll(false);
  assert.equal(sessions.map.size, 1, 'subagent files add no cards');
  assert.deepEqual(alerts, [], 'subagent completion makes no alert');

  // 부모 스레드의 턴은 그대로 카드에 반영된다
  append(parent, { type: 'task_started', turn_id: 'p1', started_at: Math.floor(Date.now() / 1000) });
  append(parent, { type: 'task_complete', turn_id: 'p1', last_agent_message: 'done' });
  watcher.poll(false);
  const s = [...sessions.map.values()][0];
  assert.equal(s.sessionId, 'root-1');
  assert.equal(s.alert && s.alert.kind, 'done');
  assert.deepEqual(alerts, ['done']);
});

test('isSubagent recognises each marker on its own', () => {
  const { isSubagent } = CodexRollouts;
  assert.equal(isSubagent({ source: 'vscode', thread_source: 'user' }), false);
  assert.equal(isSubagent({ thread_source: 'subagent' }), true);
  assert.equal(isSubagent({ parent_thread_id: 'x' }), true);
  assert.equal(isSubagent({ source: { subagent: {} } }), true);
  assert.equal(isSubagent({ source: 'exec' }), false);
  assert.equal(isSubagent(null), false);
});
