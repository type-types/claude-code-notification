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

test('Claude and Codex may reuse the same raw session id', (t) => {
  const sessions = createSessions();
  t.after(() => clearInterval(sessions.staleTimer));
  sessions.handleEvent({ type: 'session_start', agent: 'claude', cwd: '/work/claude', session_id: 'shared' });
  sessions.handleEvent({ type: 'session_start', agent: 'codex', cwd: '/work/codex', session_id: 'shared' });

  sessions.handleEvent({ type: 'session_end', agent: 'claude', cwd: '/work/claude', session_id: 'shared' });

  assert.equal([...sessions.map.values()].some((s) => s.agent === 'claude'), false);
  assert.equal([...sessions.map.values()].some((s) => s.agent === 'codex'), true);
});
