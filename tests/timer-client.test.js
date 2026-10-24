// Screen-side timer tests: runs the real public/shared.js in a simulated browser with a fake clock
process.env.MONITOR = '0'; // never send real alerts from tests (child servers inherit this)
// (hours of countdown in milliseconds). Run with:  node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(process.env.TEST_SHARED || path.join(__dirname, '..', 'app', 'public', 'shared.js'), 'utf8');

// A tiny browser: virtual time, jittery timers, an EventSource the test controls, /api/time.
function browser({ jitter = () => 0, serverOffset = 5e6 } = {}) {
  let t = 1000; // local monotonic ms
  let timers = [], nextId = 1;
  const env = {};
  const sources = [];
  const sim = {
    get t() { return t; },
    serverNow: () => 1.7e12 + t + serverOffset,
    setServerOffset: (o) => { serverOffset = o; },
    timeEnabled: true,
    sources,
  };
  const schedule = (fn, ms, interval) => {
    const id = nextId++;
    timers.push({ id, at: t + Math.max(0, ms) + (interval ? 0 : jitter()), fn, interval: interval ? ms : 0 });
    return id;
  };
  env.setTimeout = (fn, ms) => schedule(fn, ms, false);
  env.setInterval = (fn, ms) => schedule(fn, ms, true);
  env.clearTimeout = env.clearInterval = (id) => { timers = timers.filter((x) => x.id !== id); };
  env.performance = { timeOrigin: 1.7e12, now: () => t };
  env.Date = { now: () => 1.7e12 + t };
  env.requestAnimationFrame = (fn) => env.setTimeout(fn, 16);
  env.AbortSignal = { timeout: () => undefined };
  env.document = { addEventListener() {}, visibilityState: 'visible' };
  env.console = { error() {}, log() {} };
  env.fetch = async () => {
    if (!sim.timeEnabled) throw new Error('offline');
    return { text: async () => JSON.stringify({ serverNow: sim.serverNow() }) };
  };
  class FakeEventSource {
    static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; sources.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { this.readyState = 2; }
  }
  env.EventSource = FakeEventSource;
  env.window = {};
  new Function(...Object.keys(env), SRC)(...Object.values(env));
  sim.Chrono = env.window.Chrono;

  sim.advance = async (ms) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      t = Math.max(t, next.at);
      if (next.interval) next.at = t + next.interval; else timers.shift();
      next.fn();
      await settle();
    }
    t = end;
    await settle();
  };
  // Let pending promises (fetch, JSON) finish before virtual time moves on.
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
  // The server pushes a state to the newest connection.
  sim.push = (state) => {
    const es = sources.at(-1);
    if (es.readyState === 0) { es.readyState = 1; es.onopen?.(); }
    es.onmessage?.({ data: JSON.stringify({ settings: SETTINGS, pausedElapsed: 0, ...state, serverNow: sim.serverNow() }) });
  };
  return sim;
}

const SETTINGS = { duration: 120000, baseColor: '#111111', flash: true,
  steps: [{ at: 60000, color: '#ffd60a' }, { at: 30000, color: '#ff8a00' }, { at: 0, color: '#e5002b' }] };

// Records every label change with the true elapsed time (server clock) when it was drawn.
function record(sim, startedAt) {
  const changes = [];
  let last = null;
  sim.Chrono.onTick((v) => {
    const key = `${v.label}|${v.step}`;
    if (key !== last) { changes.push({ label: v.label, step: v.step, flashing: v.flashing, elapsed: sim.serverNow() - startedAt }); last = key; }
  });
  return changes;
}

async function runCountdown({ jitter, seconds }) {
  const sim = browser({ jitter });
  sim.Chrono.connect();
  await sim.advance(10);
  const startedAt = sim.serverNow();
  const changes = record(sim, startedAt);
  sim.push({ status: 'running', startedAt });
  // The server pings every 5 s, like the real one.
  for (let s = 0; s < seconds; s += 5) { await sim.advance(5000); sim.push({ status: 'running', startedAt }); }
  return changes.filter((c) => c.elapsed >= 0);
}

function checkSeconds(changes, maxLate) {
  const labels = changes.filter((c, i) => i === 0 || c.label !== changes[i - 1].label);
  for (let i = 1; i < labels.length; i++) {
    const k = Math.round(labels[i].elapsed / 1000);
    const late = labels[i].elapsed - k * 1000;
    assert.ok(late >= 0, `${labels[i].label} shown ${-late} ms EARLY`);
    assert.ok(late <= maxLate, `${labels[i].label} shown ${late} ms late`);
    assert.equal(k, Math.round(labels[i - 1].elapsed / 1000) + 1, `no skipped/duplicated second around ${labels[i].label}`);
  }
  return labels;
}

test('2 hours of countdown with perfect timers: every second on time, none skipped', async () => {
  const changes = await runCountdown({ seconds: 7200 });
  const labels = checkSeconds(changes, 2);
  assert.equal(labels[0].label, '2:00');
  assert.ok(labels.some((c) => c.label === '0:00'));
  assert.ok(labels.some((c) => c.label === '−0:01'));
  assert.equal(labels.at(-1).label, '−118:00', '2 h after GO: 118 minutes over');
});

test('2 hours with jittery timers (−1…+40 ms): never early, never drifts', async () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const changes = await runCountdown({ seconds: 7200, jitter: () => (rand() < 0.3 ? -rand() : rand() * 40) });
  const labels = checkSeconds(changes, 45);
  assert.ok(labels.length > 7000);
});

test('colors change at 1:00 / 0:30 / 0:00 and flash only then', async () => {
  const changes = await runCountdown({ seconds: 130 });
  const stepChanges = changes.filter((c, i) => i > 0 && c.step !== changes[i - 1].step);
  assert.deepEqual(stepChanges.map((c) => [c.label, c.step]), [['1:00', 0], ['0:30', 1], ['0:00', 2]]);
  assert.ok(stepChanges.every((c) => c.flashing), 'flash starts with each color change');
});

test('a crashing screen element never freezes the timer', async () => {
  const sim = browser();
  sim.Chrono.onTick(() => { throw new Error('boom'); });
  sim.Chrono.connect();
  const startedAt = sim.serverNow();
  const changes = record(sim, startedAt);
  sim.push({ status: 'running', startedAt });
  await sim.advance(10000); // no server message in between
  assert.ok(changes.length >= 10, `kept ticking (${changes.length} changes)`);
});

test('silent connection loss: detected, reconnected, keeps counting meanwhile', async () => {
  const sim = browser();
  sim.Chrono.connect();
  const startedAt = sim.serverNow();
  const changes = record(sim, startedAt);
  sim.push({ status: 'running', startedAt });
  await sim.advance(4000);
  assert.equal(sim.sources.length, 1);
  await sim.advance(20000); // Wi-Fi gone: no pings
  assert.ok(sim.sources.length >= 2, 'a new connection was opened');
  assert.equal(sim.sources[0].readyState, 2, 'the dead one was closed');
  assert.equal(sim.Chrono.connected, false, 'screens can show "Connecting to server…"');
  const last = changes.at(-1);
  assert.ok(Math.abs(last.elapsed - 24000) < 1100, 'the countdown kept going during the blip');
  sim.push({ status: 'running', startedAt });
  assert.equal(sim.Chrono.connected, true);
});

test('server restart / iPad wake-up: a clock jump is corrected at once', async () => {
  const sim = browser();
  sim.Chrono.connect();
  sim.push({ status: 'idle' });
  await sim.advance(2000); // initial clock sync done
  const before = sim.Chrono.serverNow() - sim.serverNow();
  assert.ok(Math.abs(before) < 5, 'synced');
  sim.timeEnabled = false; // like right after a restart/wake: the clock sync can't run yet
  sim.setServerOffset(5e6 + 4000); // server clock moved by 4 s (restart)
  sim.push({ status: 'idle' });
  assert.ok(Math.abs(sim.Chrono.serverNow() - sim.serverNow()) < 50, 'offset re-seeded on the first message');
});

test('pause / resume: frozen while paused, no flash on resume', async () => {
  const sim = browser();
  sim.Chrono.connect();
  const startedAt = sim.serverNow();
  const changes = record(sim, startedAt);
  sim.push({ status: 'running', startedAt });
  await sim.advance(65200); // into the yellow step
  sim.push({ status: 'paused', startedAt, pausedElapsed: 65200 });
  const frozen = sim.Chrono.remainingMs();
  await sim.advance(10000);
  assert.equal(sim.Chrono.remainingMs(), frozen);
  sim.push({ status: 'running', startedAt: sim.serverNow() - 65200 });
  await sim.advance(100);
  const afterResume = changes.at(-1);
  assert.equal(afterResume.flashing, false, 'resuming does not flash');
});
