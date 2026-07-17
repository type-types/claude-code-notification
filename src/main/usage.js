const { execFile } = require('child_process');
const https = require('https');
const EventEmitter = require('events');

const THRESHOLDS = [80, 95];
// 진행 알림 계단: 세션은 5%, 주간 한도(전체, 모델별)는 10% 단위로
// 상향 돌파를 알린다. 세션 창(5시간)이 짧아 세밀하게 잡았다.
const STEP_SESSION = 5;
const STEP_WEEKLY = 10;

// 모델별 한도 폴링 간격. 예전에 5분 간격 + 백오프 없음으로 돌리다가
// 2026-07 rate limit 강화(429, retry-after 30분대)에 걸려 영구 차단됐다.
// 15분으로 늘리고, 429를 받으면 그날은 접고 다음날 0시까지 물러난다
// (config에 저장해 재시작해도 유지).
const POLL_MS = 15 * 60 * 1000;
// 폴링이 계속 실패하면 오래된 모델별 수치는 오해를 부르므로 내린다.
const MODEL_STALE_MS = 3 * POLL_MS;

// 플랜 사용량. 두 경로를 합친다:
// 1) 세션(5시간)과 주간(전체) %: Claude Code의 공식 statusline 기능.
//    hooks/statusline.sh가 stdin JSON의 rate_limits를 로컬 서버로 중계해
//    ingest()로 들어온다. 세션이 활동하는 동안 실시간 갱신, 폴링 불필요.
// 2) 모델별 주간 %(Fable 등): statusline에는 없어서 비공식 사용량
//    API(/api/oauth/usage)를 키체인 토큰으로 15분마다 조회한다.
//    비공식 경로라 실패할 수 있고, 실패해도 1)의 표시에는 영향이 없다.
class Usage extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    // 합쳐진 표시 목록 [{key, label, percent, resetsAt}] 또는 null
    this.limits = null;
    this.base = null; // statusline 출처 (세션, 주간)
    this.models = null; // 폴링 출처 (모델별)
    this.modelsAt = 0; // 마지막 폴링 성공 시각
    this.lastPercent = {};
    this.timer = null;
    this.pollTimer = null;
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

  poll() {
    this.token((token) => {
      if (!token) return this.pollFail('no token', 0);
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
              this.pollFail(e.message, 0);
            }
          });
        }
      );
      req.on('error', (e) => this.pollFail(e.message, 0));
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
    this.schedule(POLL_MS);
  }

  pollFail(reason, waitMs) {
    console.error('[usage] poll: ' + reason);
    // 성공한 지 오래된 모델별 수치는 내린다 (statusline 표시는 유지)
    if (this.models && Date.now() - this.modelsAt > MODEL_STALE_MS) {
      this.models = null;
      this.apply();
    }
    this.schedule(Math.max(waitMs, POLL_MS));
  }

  schedule(ms) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), ms);
  }

  apply() {
    const limits = [...(this.base || []), ...(this.models || [])];
    if (!limits.length) return;
    // 임계선(80, 95%)을 상향 돌파하면 소리와 번쩍임으로 한 번 알린다.
    // 한도가 임박한 것을 미리 알아야 작업 계획을 세울 수 있기 때문이다.
    // 계단(5%, 10%) 돌파는 소리 없는 진행 알림(step)으로 구분한다.
    // 리셋으로 %가 내려가면 기준도 자연히 내려가 다시 처음부터 센다.
    let crossed = false;
    let stepped = false;
    for (const l of limits) {
      const step = l.key === 'session' ? STEP_SESSION : STEP_WEEKLY;
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
    for (const list of [this.base, this.models]) {
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
