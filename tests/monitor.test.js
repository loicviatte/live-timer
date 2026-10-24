// Remote health alerts, against a fake ntfy server: start/crash/clean restart, heartbeat, chat down,
// TV disconnected + back, admin switch off, and no chat content ever sent. Run with:  node --test tests/
process.env.MONITOR = '0'; // never send real alerts from tests (child servers inherit this)

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freePort } = require('./helpers');

const REPO = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeNtfy() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body); // ntfy JSON publishing
      posts.push({ topic: j.topic, title: j.title, priority: j.priority, tags: j.tags, body: j.message, at: Date.now() });
      res.end('{}');
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, posts, url: `http://localhost:${server.address().port}` })));
}

test('alerts: start, heartbeat, chat down, TV lost/back, crash vs clean restart, switch off, no chat content', { timeout: 90000 }, async () => {
  const ntfy = await fakeNtfy();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-mon-'));
  fs.cpSync(path.join(REPO, 'app'), path.join(dir, 'app'), { recursive: true, filter: (f) => !/runtime-state|settings\.json|\.version|monitor\.json|\.backup/.test(f) });
  fs.writeFileSync(path.join(dir, 'app', 'monitor.json'), JSON.stringify({ topic: 'test-topic-0123456789abcdef' }));
  fs.writeFileSync(path.join(dir, 'app', 'settings.json'), JSON.stringify({ youtube: 'MONITORTEST' }));
  const port = await freePort(), fakeYt = await freePort(), base = `http://localhost:${port}`;
  const env = { ...process.env, MONITOR: '1', MONITOR_SERVER: ntfy.url, PORT: String(port), UPDATE_CHECK: '0',
    MONITOR_HEARTBEAT_MS: '1500', MONITOR_CHECK_MS: '200', CHAT_ALERT_MS: '1500', TV_ALERT_MS: '1000', MONITOR_START_DELAY_MS: '300',
    // A YouTube that always fails (→ "chat down") and keeps producing messages we must never forward.
    NODE_OPTIONS: `--require ${path.join(REPO, 'tests', 'fixtures', 'fake-youtube.js')}`, FAKE_YT_PORT: String(fakeYt), FAKE_YT_CHAOS: '1', FAKE_YT_FAULTS: 'http500',
    YT_TIMEOUT_MS: '300', YT_BACKOFF_MS: '100' };
  let proc;
  const start = async () => {
    proc = spawn(process.execPath, ['server.js'], { cwd: path.join(dir, 'app'), env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { await fetch(`${base}/api/time`); return; } catch { await sleep(50); } }
  };
  const stop = (sig) => new Promise((r) => { proc.once('exit', r); proc.kill(sig); });
  const post = (a, b = {}) => fetch(`${base}/api/${a}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const waitFor = async (re, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const p = ntfy.posts.find((x) => re.test(x.title)); if (p) return p; await sleep(50); }
    assert.fail(`no alert matching ${re}; got: ${ntfy.posts.map((p) => p.title).join(' | ')}`);
  };
  try {
    await start();
    const started = await waitFor(/Timer started/);
    assert.equal(started.topic, 'test-topic-0123456789abcdef');
    assert.match(started.title, new RegExp(`^${os.hostname().replace(/\.local$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `), 'machine name in the title');
    const beat = await waitFor(/OK/);
    assert.equal(beat.priority, 1, 'heartbeat is silent');
    assert.match(beat.body, /Timer idle · chat (ERROR|connecting)/);
    await waitFor(/YouTube chat down/);

    // TV connected, timer running, then the TV disappears → alert; comes back → "back".
    const tv = http.get(`${base}/events?chat=1&screen=tv`, () => {});
    tv.on('error', () => {});
    await sleep(500);
    await post('go');
    await sleep(500);
    tv.destroy();
    const lost = await waitFor(/TV screen disconnected/);
    assert.equal(lost.priority, 4);
    const tv2 = http.get(`${base}/events?chat=1&screen=tv`, () => {});
    tv2.on('error', () => {});
    await waitFor(/TV screen back/);
    tv2.destroy();

    // Brutal crash → next start says so. Clean stop → next start is a normal start.
    await stop('SIGKILL');
    ntfy.posts.length = 0;
    await start();
    const crash = await waitFor(/Restarted after an unexpected stop/);
    assert.equal(crash.priority, 4);
    await stop('SIGTERM');
    ntfy.posts.length = 0;
    await start();
    await waitFor(/Timer started/);
    assert.ok(!ntfy.posts.some((p) => /unexpected/.test(p.title)), 'a clean stop is not reported as a crash');

    // Never any chat content in what's sent.
    assert.ok(ntfy.posts.every((p) => !/Message e|@viewer|quick brown fox/.test(p.body + p.title)));

    // Admin switch off → silence.
    const settings = await (await post('settings', { youtube: 'MONITORTEST', monitor: false })).json();
    assert.equal(settings.monitor, false);
    await sleep(300);
    ntfy.posts.length = 0;
    await sleep(3500);
    assert.equal(ntfy.posts.length, 0, 'nothing sent once switched off');
  } finally {
    proc?.kill('SIGKILL');
    ntfy.server.close();
  }
});

test('no monitor.json (or MONITOR=0): nothing is ever sent', async () => {
  const { Monitor } = require('../app/monitor');
  const m = new Monitor();
  assert.equal(m.active, false);
  assert.equal(await m.send({ title: 'x', message: 'y' }), false);
});
