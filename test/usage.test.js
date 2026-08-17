const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notify-codex-'));
process.env.CODEX_HOME = tempHome;
const Usage = require('../src/main/usage');

class Config {
  constructor() {
    this.values = { usagePollBlockedUntil: 0 };
  }
  get(key) {
    return this.values[key];
  }
  set(key, value) {
    this.values[key] = value;
  }
}

function stop(usage) {
  clearInterval(usage.timer);
  clearInterval(usage.codexTimer);
  clearTimeout(usage.pollTimer);
  clearTimeout(usage.codexWatchTimer);
  if (usage.codexWatcher) usage.codexWatcher.close();
}

test.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));

test('expired Codex snapshots stay reset and do not cross thresholds', () => {
  const usage = new Usage(new Config());
  let thresholds = 0;
  usage.on('threshold', () => thresholds++);
  usage.lastPercent['codex:session'] = 0;

  usage.codexApply({
    primary: {
      used_percent: 85,
      window_minutes: 300,
      resets_at: Math.floor(Date.now() / 1000) - 60,
    },
  });

  assert.equal(usage.limits[0].percent, 0);
  assert.equal(thresholds, 0);
  stop(usage);
});

test('Codex polling starts before sessions directory exists and attaches later', () => {
  const usage = new Usage(new Config());
  usage.startCodex();
  assert.ok(usage.codexTimer, 'polling interval starts even without sessions directory');
  assert.equal(usage.codexWatcher, null);

  fs.mkdirSync(path.join(tempHome, 'sessions'), { recursive: true });
  usage.codexPoll();
  assert.ok(usage.codexWatcher, 'watcher attaches after sessions directory appears');
  const watcher = usage.codexWatcher;
  watcher.emit('error', new Error('test watcher failure'));
  assert.equal(usage.codexWatcher, null, 'watcher failure falls back without crashing');
  stop(usage);
});

test('primary and secondary limits keep independent threshold history', () => {
  const usage = new Usage(new Config());
  let thresholds = 0;
  usage.on('threshold', () => thresholds++);
  const limits = {
    primary: { used_percent: 90, window_minutes: 0, resets_at: Date.now() / 1000 + 3600 },
    secondary: { used_percent: 10, window_minutes: 0, resets_at: Date.now() / 1000 + 3600 },
  };

  usage.codexApply(limits);
  usage.codexApply(limits);

  assert.equal(new Set(usage.limits.map((limit) => limit.key)).size, 2);
  assert.equal(thresholds, 0, 'unchanged values do not repeat threshold alerts');
  stop(usage);
});
