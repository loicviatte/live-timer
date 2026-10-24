// Server stress tests. Run all tests with:  node --test tests/
// Each test starts a real server on a free port with temporary files and no YouTube access.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = process.env.TEST_SERVER || path.join(__dirname, '..', 'app', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer(dir, port) {
  dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'timer-test-'));
  port ||= await freePort();
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), NO_YOUTUBE: '1', UPDATE_CHECK: '0',
      SETTINGS_FILE: path.join(dir, 'settings.json'), STATE_FILE: path.join(dir, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 100 && !output.includes('Timer started'); i++) await sleep(50);
  assert.ok(output.includes('Timer started'), `server did not start:\n${output}`);
  const base = `http://localhost:${port}`;
  return { proc, dir, port, base, output: () => output, stop: () => new Promise((r) => { if (proc.exitCode !== null || proc.signalCode) return r(); proc.once('exit', r); proc.kill(); }) };
}

async function post(base, action, body = {}, headers = {}) {
  const res = await fetch(`${base}/api/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// Reads the first state pushed by the event stream.
function getState(base) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/events`, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const m = buf.match(/^data: (.+)$/m);
        if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
}
const remaining = (s) => (s.status === 'idle' ? s.settings.duration
  : s.status === 'paused' ? s.settings.duration - s.pausedElapsed
  : s.settings.duration - (s.serverNow - s.startedAt));

test('pages, 404 and malformed requests never crash the server', async () => {
  const srv = await startServer();
  try {
    for (const p of ['/', '/tv', '/admin', '/shared.js']) assert.equal((await fetch(srv.base + p)).status, 200, p);
    assert.equal((await fetch(srv.base + '/nope')).status, 404);
    assert.equal((await fetch(srv.base + '/api/go')).status, 404, 'GET on a control does nothing');
    // Raw malformed request lines (a scanner on the Wi-Fi).
    for (const line of ['GET // HTTP/1.1', 'GET /%zz HTTP/1.1', 'GET http://[::1 HTTP/1.1', 'POST /api/go HTTP/1.1']) {
      await new Promise((resolve) => {
        const sock = net.connect(srv.port, 'localhost', () => sock.end(`${line}\r\nHost: x\r\n\r\n`));
        sock.on('data', () => {}); sock.on('close', resolve); sock.on('error', resolve);
      });
    }
    assert.equal((await fetch(srv.base + '/api/time')).status, 200, 'still alive');
  } finally { await srv.stop(); }
});

test('controls reject cross-site and non-JSON requests', async () => {
  const srv = await startServer();
  try {
    assert.equal((await post(srv.base, 'reset', '', { 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await post(srv.base, 'reset', {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(srv.base, 'reset', {}, { Origin: 'null' })).status, 403);
    assert.equal((await post(srv.base, 'reset', {}, { Origin: srv.base })).status, 204);
    assert.equal((await post(srv.base, 'reset')).status, 204);
  } finally { await srv.stop(); }
});

test('GO / PAUSE / RESUME / RESET keep exact time', async () => {
  const srv = await startServer();
  try {
    await post(srv.base, 'go');
    await sleep(400);
    await post(srv.base, 'pause');
    let s = await getState(srv.base);
    assert.equal(s.status, 'paused');
    assert.ok(Math.abs(s.pausedElapsed - 400) < 60, `paused after ~400 ms, got ${s.pausedElapsed}`);
    const frozen = remaining(s);
    await sleep(500);
    s = await getState(srv.base);
    assert.equal(remaining(s), frozen, 'frozen while paused');
    await post(srv.base, 'go');
    await sleep(300);
    s = await getState(srv.base);
    assert.equal(s.status, 'running');
    assert.ok(Math.abs(s.settings.duration - remaining(s) - 700) < 80, 'resume continues from 400 ms (+300)');
    await post(srv.base, 'go'); // GO while running changes nothing
    const again = await getState(srv.base);
    assert.equal(again.startedAt, s.startedAt);
    await post(srv.base, 'reset');
    s = await getState(srv.base);
    assert.equal(s.status, 'idle');
    assert.equal(remaining(s), s.settings.duration);
  } finally { await srv.stop(); }
});

test('host message validation', async () => {
  const srv = await startServer();
  try {
    assert.equal((await post(srv.base, 'message', { text: '   ' })).status, 400);
    assert.equal((await post(srv.base, 'message', '{not json')).status, 400);
    assert.equal((await post(srv.base, 'message', [1, 2])).status, 400);
    assert.equal((await post(srv.base, 'message', { text: '<img src=x onerror=alert(1)>' + 'x'.repeat(1000), blink: false })).status, 204);
    let s = await getState(srv.base);
    assert.equal(s.message.text.length, 300, 'trimmed to 300 chars');
    assert.ok(s.message.text.startsWith('<img'), 'stored as plain text (screens render it with textContent)');
    assert.equal(s.message.blink, false);
    await post(srv.base, 'message/clear');
    s = await getState(srv.base);
    assert.equal(s.message, null);
  } finally { await srv.stop(); }
});

test('settings are sanitized whatever is sent', async () => {
  const srv = await startServer();
  try {
    const bad = [
      { duration: 'abc', steps: 'nope', baseColor: 'red', youtube: '<script>', chatScale: 99, flash: 'yes' },
      { duration: -5, steps: Array.from({ length: 100 }, (_, i) => ({ at: i * 1000, color: '#abcdef' })) },
      { duration: 1e12, steps: [{ at: null, color: '#ffffff' }, { at: '', color: '#ffffff' }, { at: 5000, color: 'blue' }, null, 3] },
      { duration: 90000, chatScale: 'big', youtube: 'abcdefghijk' },
    ];
    for (const body of bad) {
      const res = await post(srv.base, 'settings', body);
      assert.equal(res.status, 200);
      const st = JSON.parse(res.text);
      assert.ok(Number.isFinite(st.duration) && st.duration >= 1000 && st.duration <= 99 * 60000, `duration ${st.duration}`);
      assert.ok(st.steps.length <= 12);
      assert.ok(st.steps.every((x) => Number.isFinite(x.at) && /^#[0-9a-f]{6}$/.test(x.color)));
      assert.ok(/^#[0-9a-f]{6}$/.test(st.baseColor));
      assert.ok(st.chatScale >= 0.8 && st.chatScale <= 3);
      assert.ok(st.youtube === '' || /^[\w-]{11}$/.test(st.youtube));
    }
    assert.equal((await post(srv.base, 'settings', 'null')).status, 400);
    assert.equal((await post(srv.base, 'settings', '{"a":')).status, 400);
    // Oversized body: refused, server still alive.
    await post(srv.base, 'settings', JSON.stringify({ x: 'y'.repeat(50000) })).catch(() => {});
    assert.equal((await fetch(srv.base + '/api/time')).status, 200);
  } finally { await srv.stop(); }
});

test('200 screens connected: every one gets each change fast; dead ones are dropped', async () => {
  const srv = await startServer();
  const clients = [];
  try {
    for (let i = 0; i < 200; i++) {
      clients.push(await new Promise((resolve) => {
        const c = { events: [], req: null };
        c.req = http.get(`${srv.base}/events${i % 2 ? '?chat=1' : ''}`, (res) => {
          let buf = '';
          res.on('data', (d) => {
            buf += d;
            let i2;
            while ((i2 = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i2); buf = buf.slice(i2 + 2);
              const m = chunk.match(/^data: (.+)$/m);
              if (m && !chunk.includes('event: chat')) c.events.push({ at: Date.now(), s: JSON.parse(m[1]) });
            }
          });
          resolve(c);
        });
        c.req.on('error', () => {});
      }));
    }
    await sleep(200);
    const t0 = Date.now();
    await post(srv.base, 'go');
    await sleep(500);
    const late = clients.filter((c) => !c.events.some((e) => e.s.status === 'running' && e.at - t0 < 500));
    assert.equal(late.length, 0, `${late.length} screens missed GO within 500 ms`);
    // Half of the screens vanish brutally (Wi-Fi drop): the server must keep serving the others.
    clients.slice(0, 100).forEach((c) => c.req.destroy());
    await sleep(100);
    const t1 = Date.now();
    await post(srv.base, 'pause');
    await sleep(500);
    const alive = clients.slice(100);
    assert.ok(alive.every((c) => c.events.some((e) => e.s.status === 'paused' && e.at >= t1)), 'remaining screens got PAUSE');
    assert.equal((await fetch(srv.base + '/api/time')).status, 200);
  } finally {
    clients.forEach((c) => c.req.destroy());
    await srv.stop();
  }
});

test('600 simultaneous button presses: no crash, always a valid state', async () => {
  const srv = await startServer();
  try {
    const actions = ['go', 'pause', 'reset', 'message', 'message/clear', 'poll/hidden'];
    const results = await Promise.all(Array.from({ length: 600 }, (_, i) => {
      const a = actions[i % actions.length];
      return post(srv.base, a, a === 'message' ? { text: `msg ${i}` } : a === 'poll/hidden' ? { hidden: i % 2 } : {});
    }));
    assert.ok(results.every((r) => r.status === 204), 'all accepted');
    const s = await getState(srv.base);
    assert.ok(['idle', 'running', 'paused'].includes(s.status));
    if (s.status === 'running') assert.ok(Number.isFinite(s.startedAt));
    if (s.status === 'paused') assert.ok(s.pausedElapsed >= 0);
    // Concurrent settings saves never corrupt the file.
    await Promise.all(Array.from({ length: 50 }, (_, i) => post(srv.base, 'settings', { duration: (i + 1) * 1000 })));
    await sleep(300);
    const saved = JSON.parse(fs.readFileSync(path.join(srv.dir, 'settings.json'), 'utf8'));
    assert.ok(saved.duration >= 1000 && saved.duration <= 50000);
  } finally { await srv.stop(); }
});

test('a server crash/restart mid-countdown: the timer keeps going', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-test-'));
  const port = await freePort();
  let srv = await startServer(dir, port);
  await post(srv.base, 'settings', { duration: 60000 });
  await post(srv.base, 'go');
  await post(srv.base, 'message', { text: 'Wrap up' });
  await sleep(1000);
  const before = await getState(srv.base);
  srv.proc.kill('SIGKILL'); // brutal: like closing the Terminal window
  await new Promise((r) => srv.proc.once('exit', r));
  await sleep(1500);
  srv = await startServer(dir, port);
  try {
    const after = await getState(srv.base);
    assert.equal(after.status, 'running');
    assert.equal(after.settings.duration, 60000);
    assert.equal(after.message?.text, 'Wrap up', 'host message still shown');
    const lost = remaining(before) - remaining(after);
    assert.ok(Math.abs(lost - 1500) < 400, `countdown kept running during the restart (moved ${Math.round(lost)} ms for ~1500 ms)`);
    // Paused state also survives.
    await post(srv.base, 'pause');
    const paused = await getState(srv.base);
    await sleep(300);
    await srv.stop();
    srv = await startServer(dir, port);
    const back = await getState(srv.base);
    assert.equal(back.status, 'paused');
    assert.equal(Math.round(remaining(back)), Math.round(remaining(paused)));
  } finally { await srv.stop(); }
});

test('a corrupted state or settings file does not prevent starting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-test-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"duration": 9');
  fs.writeFileSync(path.join(dir, 'state.json'), 'garbage');
  const srv = await startServer(dir);
  try {
    const s = await getState(srv.base);
    assert.equal(s.status, 'idle');
    assert.equal(s.settings.duration, 120000);
  } finally { await srv.stop(); }
});
