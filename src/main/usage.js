const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const THRESHOLDS = [80, 95];
// 진행 알림 계단: 세션은 5%, 주간 한도(전체, 모델별)는 10% 단위로
// 상향 돌파를 알린다. 세션 창(5시간)이 짧아 세밀하게 잡았다.
const STEP_SESSION = 5;
const STEP_WEEKLY = 10;

// 모델별 한도 폴링. 예전에 5분 정주기 + 백오프 없음으로 돌리다가
// 2026-07 rate limit 강화(429, retry-after 30분대)에 걸려 영구 차단됐다.
// 정확한 정주기는 봇 패턴으로 감지되기 쉬우므로 15~25분 무작위 간격으로
// 조회하되, 어떤 1시간 창을 잘라 봐도 3회를 넘지 않게 보장한다.
// 429를 받으면 그날은 접고 다음날 0시까지 물러난다 (config에 저장해
// 재시작해도 유지).
const POLL_MIN_MS = 15 * 60 * 1000;
const POLL_JITTER_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 3;
// 폴링이 계속 실패하면 오래된 모델별 수치는 오해를 부르므로 내린다.
const MODEL_STALE_MS = 45 * 60 * 1000;

// Codex 플랜 사용량: Codex CLI가 세션 기록(rollout-*.jsonl)에 턴마다 쓰는
// token_count 이벤트의 rate_limits를 읽는다 (2026-08-15 실측: primary와
// secondary 각각 used_percent, window_minutes, resets_at). API 호출이 없는
// 수동 경로라 Claude의 statusline 경로와 성격이 같다. 파일은 세션 시작
// 날짜 폴더(YYYY/MM/DD)에 놓이고 어제 시작한 세션이 오늘도 그 파일에
// 이어 쓰므로, 최근 며칠 폴더를 훑어 가장 최근에 수정된 파일을 고른다.
const CODEX_SESSIONS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const CODEX_POLL_MS = 30 * 1000;
const CODEX_TAIL_BYTES = 256 * 1024;
const CODEX_DAY_DIRS = 3;

// 플랜 사용량. 세 경로를 합친다:
// 1) 세션(5시간)과 주간(전체) %: Claude Code의 공식 statusline 기능.
//    hooks/statusline.sh가 stdin JSON의 rate_limits를 로컬 서버로 중계해
//    ingest()로 들어온다. 세션이 활동하는 동안 실시간 갱신, 폴링 불필요.
// 2) 모델별 주간 %(Fable 등): statusline에는 없어서 비공식 사용량
//    API(/api/oauth/usage)를 키체인 토큰으로 15~25분 무작위 간격
//    (시간당 최대 3회)으로 조회한다.
//    비공식 경로라 실패할 수 있고, 실패해도 1)의 표시에는 영향이 없다.
// 3) Codex 세션과 주간 %: Codex CLI 세션 기록 파일의 rate_limits를 읽는다
//    (위 CODEX_* 상수 설명 참고). agent: 'codex'를 붙여 renderer가 구분한다.
class Usage extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    // 합쳐진 표시 목록 [{key, label, percent, resetsAt}] 또는 null
    this.limits = null;
    this.base = null; // statusline 출처 (세션, 주간)
    this.models = null; // 폴링 출처 (모델별)
    this.codex = null; // Codex 세션 기록 출처
    this.codexFile = ''; // 마지막으로 읽은 rollout 파일과 수정 시각
    this.codexMtime = 0;
    this.codexTimer = null;
    this.codexWatcher = null;
    this.codexWatchTimer = null;
    this.modelsAt = 0; // 마지막 폴링 성공 시각
    this.lastPercent = {};
    this.timer = null;
    this.pollTimer = null;
    this.pollTimes = []; // 최근 조회 시각들 (시간당 횟수 제한용)
  }

  start() {
    // 세션이 모두 꺼져 있으면 새 데이터가 안 오므로, 재설정 시각이 지난
    // 게이지는 1분마다 확인해 0으로 내린다.
    this.timer = setInterval(() => this.expire(), 60 * 1000);
    // 지난 실행에서 429 차단을 기록해 뒀으면 그 시각까지 조회하지 않는다.
    // 차단 중에는 어떤 요청이든 페널티 타이머를 리셋시키므로, 재시작
    // 직후의 첫 조회가 회복을 늦추는 것을 막는다.
    const until = this.cfg.get('usagePollBlockedUntil') || 0;
    if (Date.now() < until) {
      console.log('[usage] poll blocked until ' + new Date(until).toLocaleString());
      this.schedule(until - Date.now());
    } else {
      this.poll();
    }
    this.startCodex();
  }

  // Codex 세션 기록 감시. 폴더 변경 이벤트로 즉시 반응하고(디바운스 1초),
  // 이벤트를 놓쳐도 30초 폴링으로 따라잡는다. 앱 시작 뒤 폴더가 생기는 경우도
  // 폴링 때 watcher를 붙여서 재시작 없이 사용량 표시를 시작한다.
  startCodex() {
    if (this.codexTimer) return;
    this.codexPoll();
    this.codexTimer = setInterval(() => this.codexPoll(), CODEX_POLL_MS);
  }

  ensureCodexWatcher() {
    if (this.codexWatcher || !fs.existsSync(CODEX_SESSIONS)) return;
    try {
      const watcher = fs.watch(CODEX_SESSIONS, { recursive: true }, () => {
        clearTimeout(this.codexWatchTimer);
        this.codexWatchTimer = setTimeout(() => this.codexPoll(), 1000);
      });
      watcher.on('error', (e) => {
        console.error('[usage] codex watch: ' + e.message);
        if (this.codexWatcher === watcher) this.codexWatcher = null;
        try {
          watcher.close();
        } catch (closeErr) {
          // 이미 닫힌 watcher
        }
      });
      this.codexWatcher = watcher;
    } catch (e) {
      console.error('[usage] codex watch: ' + e.message);
    }
  }

  // 최근 날짜 폴더 몇 개에서 가장 최근에 수정된 rollout 파일을 고른다.
  codexLatestFile() {
    const dayDirs = [];
    const list = (dir) => {
      try {
        return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
      } catch (e) {
        return [];
      }
    };
    for (const y of list(CODEX_SESSIONS)) {
      for (const m of list(path.join(CODEX_SESSIONS, y))) {
        for (const d of list(path.join(CODEX_SESSIONS, y, m))) {
          dayDirs.push(path.join(CODEX_SESSIONS, y, m, d));
          if (dayDirs.length >= CODEX_DAY_DIRS) break;
        }
        if (dayDirs.length >= CODEX_DAY_DIRS) break;
      }
      if (dayDirs.length >= CODEX_DAY_DIRS) break;
    }
    let best = null;
    for (const dir of dayDirs) {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
      } catch (e) {
        continue;
      }
      for (const n of names) {
        const file = path.join(dir, n);
        let st;
        try {
          st = fs.statSync(file);
        } catch (e) {
          continue;
        }
        if (!best || st.mtimeMs > best.mtime) best = { file, mtime: st.mtimeMs, size: st.size };
      }
    }
    return best;
  }

  codexPoll() {
    this.ensureCodexWatcher();
    const latest = this.codexLatestFile();
    if (!latest) return;
    if (latest.file === this.codexFile && latest.mtime === this.codexMtime) return;
    this.codexFile = latest.file;
    this.codexMtime = latest.mtime;
    // 파일 꼬리만 읽어 마지막 rate_limits를 찾는다
    let fd;
    try {
      fd = fs.openSync(latest.file, 'r');
      const len = Math.min(CODEX_TAIL_BYTES, latest.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, latest.size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        let obj;
        try {
          obj = JSON.parse(lines[i]);
        } catch (e) {
          continue; // 잘린 첫 줄이나 쓰는 중인 마지막 줄
        }
        const rl = obj && obj.payload && obj.payload.rate_limits;
        if (rl) {
          this.codexApply(rl);
          break;
        }
      }
    } catch (e) {
      console.error('[usage] codex read: ' + e.message);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // primary/secondary를 창 길이로 이름 붙인다. 5시간(300분)은 세션, 7일(10080분)은
  // 주간으로 Claude 쪽 표기와 맞춘다. 사용자 플랜에 따라 둘 중 하나만 올 수 있다.
  codexApply(rl) {
    const list = [];
    for (const field of ['primary', 'secondary']) {
      const l = rl[field];
      if (!l || l.used_percent == null) continue;
      const min = Number(l.window_minutes) || 0;
      const resetsAt = toIso(l.resets_at);
      const expired = !!resetsAt && Date.parse(resetsAt) <= Date.now();
      let label;
      let key;
      if (min > 0 && min <= 300) {
        label = '세션';
      } else if (min === 10080) {
        label = '주간';
      } else {
        label = min >= 1440 ? Math.round(min / 1440) + '일' : Math.round(min / 60) + '시간';
      }
      // primary/secondary는 시간창이 같거나 누락될 수 있다. 표시 이름과
      // 무관한 슬롯 ID로 진행 이력을 분리해야 서로의 %가 이전 값이 되지 않는다.
      key = 'codex:' + field;
      list.push({
        key,
        agent: 'codex',
        label,
        windowMinutes: min,
        percent: expired ? 0 : Math.round(l.used_percent),
        resetsAt: expired ? '' : resetsAt,
      });
    }
    this.codex = list.length ? list : null;
    this.apply();
  }

  // statusline 이벤트(공식). rate_limits가 없는 이벤트(세션 첫 응답 전 등)는
  // 기존 표시를 유지한 채 무시한다.
  ingest(evt) {
    const rl = evt && evt.rate_limits;
    if (!rl) return;
    const defs = [
      ['five_hour', 'session', '세션'],
      ['seven_day', 'weekly_all', '주간'],
    ];
    const base = [];
    for (const [field, key, label] of defs) {
      const l = rl[field];
      if (!l || l.used_percentage == null) continue;
      base.push({
        key,
        label,
        percent: Math.round(l.used_percentage),
        resetsAt: toIso(l.resets_at),
      });
    }
    if (!base.length) return;
    this.base = base;
    this.apply();
  }

  // 토큰은 매 조회마다 키체인에서 새로 읽는다. Claude Code가 토큰을
  // 갱신해도 자연히 따라간다.
  token(cb) {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      (err, stdout) => {
        if (err) return cb('');
        try {
          cb(JSON.parse(stdout).claudeAiOauth.accessToken || '');
        } catch (e) {
          cb('');
        }
      }
    );
  }

  // 다음 조회까지의 대기 시간: 15~25분 무작위. 단, 최근 1시간 내 조회가
  // 이미 3회면 가장 오래된 것이 1시간 밖으로 나갈 때까지 더 기다린다.
  // 정확히 경계에 걸리지 않도록 30초 여유를 더한다.
  nextDelay() {
    const jittered = POLL_MIN_MS + Math.random() * POLL_JITTER_MS;
    const now = Date.now();
    this.pollTimes = this.pollTimes.filter((t) => now - t < HOUR_MS);
    if (this.pollTimes.length >= MAX_PER_HOUR) {
      const oldest = this.pollTimes[this.pollTimes.length - MAX_PER_HOUR];
      return Math.max(jittered, oldest + HOUR_MS + 30 * 1000 - now);
    }
    return jittered;
  }

  poll() {
    this.pollTimes.push(Date.now());
    this.token((token) => {
      if (!token) return this.pollFail('no token');
      const req = https.request(
        {
          hostname: 'api.anthropic.com',
          path: '/api/oauth/usage',
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + token,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          timeout: 10000,
        },
        (res) => {
          let body = '';
          res.on('data', (ch) => (body += ch));
          res.on('end', () => {
            if (res.statusCode === 429) {
              // 429 차단이면 그날은 포기하고 다음날 0시부터 다시 시도한다.
              // 차단 중 재시도는 페널티 타이머(실측 약 37분)를 리셋시켜
              // 회복을 막기 때문에, 넉넉히 물러나는 쪽을 택했다 (사용자 결정).
              // 마감 시각은 config에 저장해 껐다 켜도 유지된다.
              const until = nextDayStart();
              this.cfg.set('usagePollBlockedUntil', until);
              console.error(
                '[usage] poll: 429, backing off until ' + new Date(until).toLocaleString()
              );
              return this.schedule(until - Date.now());
            }
            try {
              if (res.statusCode !== 200) throw new Error('http ' + res.statusCode);
              this.pollApply(JSON.parse(body));
            } catch (e) {
              this.pollFail(e.message);
            }
          });
        }
      );
      req.on('error', (e) => this.pollFail(e.message));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  // 응답에서 모델별 한도만 뽑는다. 세션과 주간 전체는 statusline이
  // 담당하므로 중복 표시하지 않는다.
  pollApply(data) {
    const models = [];
    for (const l of data.limits || []) {
      const name = l.scope && l.scope.model && l.scope.model.display_name;
      if (!name) continue;
      models.push({
        key: 'model:' + name,
        label: name,
        percent: Math.round(l.percent || 0),
        resetsAt: toIso(l.resets_at),
      });
    }
    this.models = models.length ? models : null;
    this.modelsAt = Date.now();
    if (this.cfg.get('usagePollBlockedUntil')) this.cfg.set('usagePollBlockedUntil', 0);
    this.apply();
    this.schedule(this.nextDelay());
  }

  pollFail(reason) {
    console.error('[usage] poll: ' + reason);
    // 성공한 지 오래된 모델별 수치는 내린다 (statusline 표시는 유지)
    if (this.models && Date.now() - this.modelsAt > MODEL_STALE_MS) {
      this.models = null;
      this.apply();
    }
    this.schedule(this.nextDelay());
  }

  schedule(ms) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), ms);
  }

  apply() {
    const limits = [...(this.base || []), ...(this.models || []), ...(this.codex || [])];
    if (!limits.length) return;
    // 임계선(80, 95%)을 상향 돌파하면 소리와 번쩍임으로 한 번 알린다.
    // 한도가 임박한 것을 미리 알아야 작업 계획을 세울 수 있기 때문이다.
    // 계단(5%, 10%) 돌파는 소리 없는 진행 알림(step)으로 구분한다.
    // 리셋으로 %가 내려가면 기준도 자연히 내려가 다시 처음부터 센다.
    let crossed = false;
    let stepped = false;
    for (const l of limits) {
      const codexSession = l.agent === 'codex' && l.windowMinutes > 0 && l.windowMinutes <= 300;
      const step = l.key === 'session' || codexSession ? STEP_SESSION : STEP_WEEKLY;
      const prev = this.lastPercent[l.key];
      if (prev != null) {
        for (const t of THRESHOLDS) {
          if (prev < t && l.percent >= t) crossed = true;
        }
        if (Math.floor(l.percent / step) > Math.floor(prev / step)) stepped = true;
      }
      this.lastPercent[l.key] = l.percent;
    }
    // statusline 이벤트는 턴마다 오므로 값이 바뀔 때만 알린다
    const changed = JSON.stringify(limits) !== JSON.stringify(this.limits);
    this.limits = limits;
    if (changed) {
      console.log('[usage] ' + limits.map((l) => l.label + ' ' + l.percent + '%').join(', '));
      this.emit('update');
    }
    if (crossed) this.emit('threshold');
    else if (stepped) this.emit('step');
  }

  expire() {
    if (!this.limits) return;
    let changed = false;
    for (const list of [this.base, this.models, this.codex]) {
      for (const l of list || []) {
        if (l.percent > 0 && l.resetsAt && Date.parse(l.resetsAt) <= Date.now()) {
          l.percent = 0;
          l.resetsAt = '';
          this.lastPercent[l.key] = 0;
          changed = true;
        }
      }
    }
    if (changed) this.apply();
  }
}

// 429 백오프 마감: 다음날 0시 (로컬 시간)
function nextDayStart() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// statusline의 resets_at은 epoch 초, 비공식 API는 ISO 문자열.
// 어느 쪽이 와도 renderer가 쓰는 형식(new Date 인자)으로 맞춘다.
function toIso(v) {
  if (typeof v === 'number') {
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  return typeof v === 'string' ? v : '';
}

module.exports = Usage;
