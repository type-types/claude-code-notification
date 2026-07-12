const { execFile } = require('child_process');

const MIN_INTERVAL_MS = 1000;

class Sound {
  constructor(cfg) {
    this.cfg = cfg;
    this.lastPlayed = 0;
  }

  play() {
    if (this.cfg.get('muted')) return;
    const now = Date.now();
    if (now - this.lastPlayed < MIN_INTERVAL_MS) return;
    this.lastPlayed = now;
    execFile('/usr/bin/afplay', [this.cfg.get('soundPath')], () => {});
  }
}

module.exports = Sound;
