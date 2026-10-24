// Remote health alerts through ntfy.sh (free push notifications, no account): a heartbeat every
// 5 minutes and an immediate alert when something goes wrong. Only technical status is sent —
// never chat messages, names or the live link. The channel ("topic") lives in app/monitor.json,
// which is never published nor overwritten by updates; without it, nothing is sent.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'monitor.json');
const SERVER = process.env.MONITOR_SERVER || 'https://ntfy.sh';

function loadConfig() {
  if (process.env.MONITOR === '0') return null; // tests, dry runs
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return typeof c.topic === 'string' && /^[\w-]{16,64}$/.test(c.topic) ? c : null;
  } catch { return null; }
}

class Monitor {
  constructor() {
    this.config = loadConfig();
    this.enabled = true;        // admin switch (settings.monitor)
    this.machine = (os.hostname() || 'Mac').replace(/\.local$/, '');
    this.last = new Map();      // alert key -> time sent (rate limiting)
    this.sent = 0;
    this.failed = 0;
  }

  get active() { return !!this.config && this.enabled; }
  get topic() { return this.config?.topic || null; }

  // priority: 1 = silent (heartbeat) … 3 = normal … 5 = urgent. key: rate-limits repeats of one alert.
  async send({ title, message, priority = 3, tags = [], key = null, every = 5 * 60 * 1000 }) {
    if (!this.active) return false;
    if (key) {
      const prev = this.last.get(key);
      if (prev && Date.now() - prev < every) return false;
      this.last.set(key, Date.now());
    }
    try {
      // JSON publishing: titles with emoji/accents can't go in HTTP headers.
      const res = await fetch(SERVER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: this.config.topic, title: `${this.machine} · ${title}`.slice(0, 200),
          message: String(message).slice(0, 2000), priority, tags }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
      this.sent++;
      return true;
    } catch {
      this.failed++; // offline: never disturb the show
      return false;
    }
  }
}

module.exports = { Monitor };
