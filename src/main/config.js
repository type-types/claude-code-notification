const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 48923,
  muted: false,
  idleGlow: true,
  soundPath: '/System/Library/Sounds/Glass.aiff',
  approveKey: 'return',
  positions: {},
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
