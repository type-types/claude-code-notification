const test = require('node:test');
const assert = require('node:assert/strict');
const { agentOf } = require('../src/main/scanner');

test('recognizes interactive Codex wrapper and native processes', () => {
  assert.equal(agentOf('node /usr/local/lib/node_modules/@openai/codex/bin/codex'), 'codex');
  assert.equal(agentOf('/vendor/aarch64-apple-darwin/bin/codex'), 'codex');
  assert.equal(agentOf('/vendor/aarch64-apple-darwin/bin/codex resume abc'), 'codex');
});

test('excludes Codex desktop helpers and non-interactive commands', () => {
  assert.equal(agentOf('/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://'), null);
  assert.equal(agentOf('/Applications/ChatGPT.app/Contents/Resources/codex sandbox -- command'), null);
  assert.equal(agentOf('/vendor/aarch64-apple-darwin/bin/codex mcp-server'), null);
  assert.equal(agentOf('/vendor/aarch64-apple-darwin/bin/codex-code-mode-host'), null);
});

test('skips option values before classifying the first positional argument', () => {
  assert.equal(agentOf('/bin/codex --model gpt-5.6 resume abc'), 'codex');
  assert.equal(agentOf('/bin/codex --model gpt-5.6 exec prompt'), null);
});
