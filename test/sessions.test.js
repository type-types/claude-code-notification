const test = require('node:test');
const assert = require('node:assert/strict');
const Sessions = require('../src/main/sessions');
const { sessionIdKey } = require('../src/main/sessions');

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

function createSessions() {
  const dock = { send() {} };
  return new Sessions(new Config(), dock);
}

test('same-directory Codex hook sessions keep independent cards and lifecycle', (t) => {
  const sessions = createSessions();
  t.after(() => clearInterval(sessions.staleTimer));
  const cwd = '/work/project';
  sessions.handleEvent({ type: 'session_start', agent: 'codex', cwd, session_id: 'one' });
  sessions.handleEvent({ type: 'session_start', agent: 'codex', cwd, session_id: 'two' });

  assert.equal(sessions.map.size, 2);
  assert.notEqual(
    sessions.byId.get(sessionIdKey('codex', 'one')).key,
    sessions.byId.get(sessionIdKey('codex', 'two')).key
  );

  sessions.handleEvent({ type: 'stop', agent: 'codex', cwd, session_id: 'two' });
  assert.equal(sessions.byId.get(sessionIdKey('codex', 'two')).alert.kind, 'done');
  assert.equal(sessions.byId.get(sessionIdKey('codex', 'one')).alert, null);

  sessions.handleEvent({ type: 'session_end', agent: 'codex', cwd, session_id: 'one' });
  assert.equal(sessions.map.size, 1);
  assert.equal(sessions.byId.has(sessionIdKey('codex', 'one')), false);
  assert.equal(sessions.byId.has(sessionIdKey('codex', 'two')), true);
});

test('first hook session adopts an existing scan-only card', (t) => {
  const sessions = createSessions();
  t.after(() => clearInterval(sessions.staleTimer));
  const cwd = '/work/project';
  sessions.syncScanned([{ agent: 'codex', cwd }]);
  const scannedKey = [...sessions.map.keys()][0];

  sessions.handleEvent({ type: 'session_start', agent: 'codex', cwd, session_id: 'hooked' });

  assert.equal(sessions.map.size, 1);
  assert.equal(sessions.byId.get(sessionIdKey('codex', 'hooked')).key, scannedKey);
});

test('cards beyond the running process count for a folder are removed after three scans', (t) => {
  const sessions = createSessions();
  t.after(() => clearInterval(sessions.staleTimer));
  const cwd = '/work/project';
  sessions.handleEvent({ type: 'session_start', agent: 'claude', cwd, session_id: 'old' });
  const old = sessions.byId.get(sessionIdKey('claude', 'old'));
  old.lastEvent -= 60 * 1000;
  sessions.handleEvent({ type: 'session_start', agent: 'claude', cwd, session_id: 'new' });
  assert.equal(sessions.map.size, 2, 'restart in the same folder makes a second card');

  // 프로세스 2개면 둘 다 유지
  sessions.syncScanned([{ agent: 'claude', cwd }, { agent: 'claude', cwd }]);
  sessions.syncScanned([{ agent: 'claude', cwd }, { agent: 'claude', cwd }]);
  sessions.syncScanned([{ agent: 'claude', cwd }, { agent: 'claude', cwd }]);
  assert.equal(sessions.map.size, 2);

  // 프로세스 1개면 이벤트가 오래된 카드가 정리된다
  for (let i = 0; i < 3; i++) sessions.syncScanned([{ agent: 'claude', cwd }]);
  assert.equal(sessions.map.size, 1);
  assert.equal([...sessions.map.values()][0].sessionId, 'new');

  // 다른 폴더의 hook 전용 카드(스캔에 안 잡힘)는 건드리지 않는다
  sessions.handleEvent({ type: 'session_start', agent: 'claude', cwd: '/elsewhere', session_id: 'x' });
  for (let i = 0; i < 3; i++) sessions.syncScanned([{ agent: 'claude', cwd }]);
  assert.equal(sessions.map.size, 2);
});

test('Claude and Codex may reuse the same raw session id', (t) => {
  const sessions = createSessions();
  t.after(() => clearInterval(sessions.staleTimer));
  sessions.handleEvent({ type: 'session_start', agent: 'claude', cwd: '/work/claude', session_id: 'shared' });
  sessions.handleEvent({ type: 'session_start', agent: 'codex', cwd: '/work/codex', session_id: 'shared' });

  sessions.handleEvent({ type: 'session_end', agent: 'claude', cwd: '/work/claude', session_id: 'shared' });

  assert.equal([...sessions.map.values()].some((s) => s.agent === 'claude'), false);
  assert.equal([...sessions.map.values()].some((s) => s.agent === 'codex'), true);
});
