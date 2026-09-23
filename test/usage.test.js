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
    this.values = { usagePollBlockedUntil: 0, usageCache: null };
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

test('rollout tail skips trailing rate_limits lines whose windows are null', () => {
  // codex-cli 0.155 실측: limit_id premium 줄은 primary/secondary가 null이라
  // 마지막 줄만 읽으면 게이지가 사라진다. 창 정보가 있는 이전 줄을 써야 한다.
  const day = path.join(tempHome, 'sessions', '2026', '09', '23');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-2026-09-23T00-00-00-test.jsonl');
  const future = Math.floor(Date.now() / 1000) + 3600;
  const line = (rl) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } });
  fs.writeFileSync(
    file,
    [
      line({ limit_id: 'codex', plan_type: 'prolite', primary: { used_percent: 100, window_minutes: 10080, resets_at: future }, secondary: null }),
      line({ limit_id: 'premium', plan_type: 'prolite', primary: null, secondary: null }),
    ].join('\n') + '\n'
  );
  const usage = new Usage(new Config());
  usage.codexPoll();
  assert.ok(usage.limits, 'codex gauge present');
  assert.equal(usage.limits.length, 1);
  assert.equal(usage.limits[0].label, '주간');
  assert.equal(usage.limits[0].percent, 100);
  assert.equal(usage.limits[0].plan, 'prolite');
  assert.ok(usage.limits[0].resetsAt);
  stop(usage);
  fs.rmSync(file);
});

test('last usage is saved to config and restored on next start', () => {
  const cfg = new Config();
  const usage = new Usage(cfg);
  const future = Date.now() / 1000 + 3600;
  usage.ingest({ rate_limits: { five_hour: { used_percentage: 37, resets_at: future } } });
  usage.codexApply({ primary: { used_percent: 100, window_minutes: 10080, resets_at: future } });
  assert.ok(cfg.get('usageCache'), 'cache written');
  assert.ok(usage.limits.every((l) => l.asOf > 0), 'fresh values carry asOf');
  stop(usage);

  const again = new Usage(cfg);
  again.poll = () => {}; // 키체인과 네트워크는 건드리지 않는다
  let updates = 0;
  again.on('update', () => updates++);
  again.start();
  assert.equal(updates, 1, 'restored values are shown immediately');
  assert.deepEqual(again.limits.map((l) => l.key + ':' + l.percent), ['session:37', 'codex:primary:100']);
  // 조회 실패는 마지막 값을 지우지 않는다
  again.pollFail('test');
  assert.equal(again.limits.length, 2);
  stop(again);
});

test('usage API session and weekly entries fill in when statusline is absent', () => {
  const usage = new Usage(new Config());
  usage.schedule = () => {};
  const future = new Date(Date.now() + 3600e3).toISOString();
  usage.pollApply({
    limits: [
      { scope: { model: { display_name: 'Fable' } }, percent: 83, resets_at: future },
      { scope: { window: 'five_hour' }, percent: 37.4, resets_at: future },
      { window_seconds: 604800, utilization: 41, resets_at: future },
    ],
  });
  assert.deepEqual(usage.limits.map((l) => l.key + ':' + l.percent), ['session:37', 'weekly_all:41', 'model:Fable:83']);

  // statusline이 방금 왔으면 그쪽이 우선한다
  usage.ingest({ rate_limits: { five_hour: { used_percentage: 40, resets_at: Date.now() / 1000 + 3600 } } });
  usage.pollApply({ limits: [{ scope: { window: 'five_hour' }, percent: 50, resets_at: future }] });
  assert.equal(usage.limits.find((l) => l.key === 'session').percent, 40);

  // 옛 형식(최상위 five_hour 객체)도 읽는다
  const u2 = new Usage(new Config());
  u2.schedule = () => {};
  u2.pollApply({ five_hour: { utilization: 12, resets_at: future }, seven_day: { utilization: 3, resets_at: future } });
  assert.deepEqual(u2.limits.map((l) => l.key + ':' + l.percent), ['session:12', 'weekly_all:3']);
  stop(usage);
  stop(u2);
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
