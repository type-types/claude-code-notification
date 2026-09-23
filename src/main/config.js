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
