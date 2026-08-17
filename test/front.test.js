const test = require('node:test');
const assert = require('node:assert/strict');
const { frontSessionKeys } = require('../src/main/front');

function session(key, agent, cwd, termProgram, bundleId = '') {
  return { key, agent, cwd, origin: { termProgram, bundleId } };
}

test('selects only the same-app card for a project open in multiple apps', () => {
  const sessions = [
    session('/work/project', 'claude', '/work/project', 'vscode'),
    session('codex:/work/project', 'codex', '/work/project', 'iTerm.app'),
  ];
  assert.deepEqual(
    frontSessionKeys({ app: 'Code', title: 'project - Visual Studio Code' }, sessions),
    ['/work/project']
  );
  assert.deepEqual(frontSessionKeys({ app: 'iTerm2', title: 'project' }, sessions), [
    'codex:/work/project',
  ]);
});

test('keeps same-app same-project sessions folded when the active tab is ambiguous', () => {
  const sessions = [
    session('codex:/work/project#one', 'codex', '/work/project', 'vscode'),
    session('codex:/work/project#two', 'codex', '/work/project', 'vscode'),
  ];
  assert.deepEqual(frontSessionKeys({ app: 'Code', title: 'project - Visual Studio Code' }, sessions), []);
});

test('matches a unique session only when its origin app agrees', () => {
  const codex = session('codex:/work/project', 'codex', '/work/project', 'iTerm.app');
  assert.deepEqual(frontSessionKeys({ app: 'iTerm2', title: 'project' }, [codex]), [codex.key]);
  assert.deepEqual(frontSessionKeys({ app: 'Code', title: 'project' }, [codex]), []);
});

test('keeps title-only fallback for one legacy session without origin', () => {
  const legacy = { key: '/work/project', agent: 'claude', cwd: '/work/project', origin: null };
  assert.deepEqual(frontSessionKeys({ app: 'Code', title: 'project - Visual Studio Code' }, [legacy]), [legacy.key]);
});
