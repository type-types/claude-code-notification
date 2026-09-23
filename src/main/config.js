const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 48923,
  muted: false,
  idleGlow: true,
  soundPath: '/System/Library/Sounds/Glass.aiff',
  cardY: {},
  opacity: 1,
  // 사용량 API가 429로 차단됐을 때 다음 조회를 허용하는 시각(epoch ms).
  // 껐다 켜도 유지되어 재시작이 차단 페널티를 리셋시키지 않게 한다.
  usagePollBlockedUntil: 0,
  // 마지막으로 받은 플랜 사용량 (출처별 목록과 수신 시각). 재시작 직후나
  // 조회 실패 시에도 마지막 값을 보여주기 위해 저장한다 (자동 관리).
  usageCache: null,
  // 모델별 사용량 API를 마지막으로 조회한 시각(epoch ms). 잦은 재시작이
  // 시작 직후 조회로 시간당 상한을 넘지 않게 한다 (자동 관리).
  usageLastPoll: 0,
};

class Config {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = Object.assign({}, DEFAULTS);
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {
      // 첫 실행이거나 파일이 깨진 경우 기본값 사용
    }
    // 지금은 안 쓰는 옛 키 정리 (창별 자유 배치, 순서 저장 시절)
    delete this.data.positions;
    delete this.data.order;
    // 카드 위치 키를 NFC로 통일한다. 예전에는 한글 폴더가 NFC(hook)와 NFD(스캔)
    // 두 키로 따로 저장됐다. NFC 키가 이미 있으면 그 값을 우선한다
    const ys = this.data.cardY;
    if (ys && typeof ys === 'object') {
      const merged = {};
      for (const k of Object.keys(ys)) {
        const nk = k.normalize('NFC');
        if (!(nk in merged) || nk === k) merged[nk] = ys[k];
      }
      this.data.cardY = merged;
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[config] save failed: ' + e.message);
    }
  }
}

module.exports = Config;
