const { execFile } = require('child_process');
const https = require('https');
const EventEmitter = require('events');

const POLL_MS = 5 * 60 * 1000;
const THRESHOLDS = [80, 95];
// 진행 알림 계단: 세션은 5%, 주간 한도는 10% 단위로 상향 돌파를 알린다.
// 세션 창(5시간)이 짧아 세밀하게, 주간은 느리게 움직여 성기게 잡았다.
const STEP_SESSION = 5;
const STEP_WEEKLY = 10;

// 플랜 사용량 조회. Claude Code가 로그인 시 키체인에 저장한 OAuth 토큰으로
// 비공식 사용량 API(/api/oauth/usage)를 5분마다 조회한다. Claude Code의
// /usage 화면과 같은 값(세션, 주간, 모델별 %)을 받는다.
// 비공식 경로라 언제든 깨질 수 있으므로, 실패하면 표시를 조용히 끄고
// 알림 기능에는 영향을 주지 않는다.
class Usage extends EventEmitter {
  constructor() {
    super();
    // [{key, label, percent, resetsAt}] 또는 null(조회 불가)
    this.limits = null;
    this.lastPercent = {};
    this.timer = null;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
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
      if (!token) return this.fail('no token');
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
            try {
              if (res.statusCode !== 200) throw new Error('http ' + res.statusCode);
              this.apply(JSON.parse(body));
            } catch (e) {
              this.fail(e.message);
            }
          });
        }
      );
      req.on('error', (e) => this.fail(e.message));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  apply(data) {
    const names = { session: '세션', weekly_all: '주간' };
    const limits = [];
    for (const l of data.limits || []) {
      const scoped = l.scope && l.scope.model && l.scope.model.display_name;
      limits.push({
        key: l.kind,
        label: scoped || names[l.kind] || l.kind,
        percent: Math.round(l.percent || 0),
        resetsAt: l.resets_at || '',
      });
    }
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
    this.limits = limits;
    this.emit('update');
    if (crossed) this.emit('threshold');
    else if (stepped) this.emit('step');
  }

  fail(reason) {
    console.error('[usage] ' + reason);
    if (this.limits !== null) {
      this.limits = null;
      this.emit('update');
    }
  }
}

module.exports = Usage;
