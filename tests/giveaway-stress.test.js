// Giveaway under extreme load: 300 chat messages/s from 100,000 different viewers, all typing the
process.env.MONITOR = '0'; // never send real alerts from tests (child servers inherit this)
// keyword, with a brutal crash in the middle of the entries. The server must stay responsive, the
// saved file must never be corrupted, no entry may be lost beyond the last instant, draws never repeat.
// Run with:  node --test tests/

const test = require('node:test');
const { freePort } = require('./helpers');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(dir, port, fakePort) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'server.js')], {
    env: { ...process.env, PORT: String(port), UPDATE_CHECK: '0',
      SETTINGS_FILE: path.join(dir, 'settings.json'), STATE_FILE: path.join(dir, 'state.json'),
      NODE_OPTIONS: `--require ${path.join(__dirname, 'fixtures', 'fake-youtube.js')}`, FAKE_YT_PORT: String(fakePort),
      FAKE_YT_RATE: '300', FAKE_YT_VIEWERS: '100000', FAKE_YT_KEYWORD: 'FIFTH', FAKE_YT_KEYWORD_EVERY: '1', FAKE_YT_CHAOS: '0.03',
      YT_POLL_MS: '300', YT_TIMEOUT_MS: '2000', YT_BACKOFF_MS: '300' },
    stdio: 'ignore',
  });
  return { proc, stop: () => new Promise((r) => { if (proc.exitCode !== null || proc.signalCode) return r(); proc.once('exit', r); proc.kill('SIGKILL'); }) };
}

const getState = (base) => new Promise((resolve, reject) => {
  const req = http.get(`${base}/events`, (res) => { let b = ''; res.on('data', (d) => { b += d; const m = b.match(/^data: (.+)$/m); if (m) { req.destroy(); resolve(JSON.parse(m[1])); } }); });
  req.on('error', reject);
  req.setTimeout(3000, () => req.destroy(new Error('timeout')));
});
const api = (base, body) => fetch(`${base}/api/giveaway`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }))
  .catch((e) => { throw new Error(`${body.action}: ${e.cause?.code || e.cause?.message || e.message}`); });
async function waitUp(base) { for (let i = 0; i < 100; i++) { try { return await getState(base); } catch { await sleep(100); } } throw new Error('server not up'); }

test('giveaway under extreme load + crash: responsive, never corrupted, no repeat', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-gastress-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ youtube: 'GASTRESS001' }));
  const port = await freePort(), fakePort = await freePort(), base = `http://localhost:${port}`;
  let srv = startServer(dir, port, fakePort);
  const latencies = [], fileErrors = [];
  let probing = true, down = false;

  // Responsiveness probe: 10 requests per second (skipped while the server is deliberately down).
  const probe = (async () => {
    while (probing) {
      if (!down) {
        const t = Date.now();
        try { await fetch(`${base}/api/time`, { signal: AbortSignal.timeout(2000) }); latencies.push(Date.now() - t); } catch {}
      }
      await sleep(100);
    }
  })();
  // Saved-file integrity: read it continuously while it's being rewritten.
  const reader = (async () => {
    while (probing) {
      try {
        const txt = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
        try { JSON.parse(txt); } catch (e) { fileErrors.push(e.message); }
      } catch {}
      await sleep(30);
    }
  })();

  try {
    await waitUp(base);
    assert.equal((await api(base, { action: 'start', keyword: 'fifth' })).ok, true);
    await sleep(12000);
    const beforeCrash = (await getState(base)).giveaway.count;
    await sleep(300);
    down = true;
    await srv.stop(); // brutal crash in the middle of the entries
    const savedAtCrash = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).giveaway.entrants.length;
    srv = startServer(dir, port, fakePort);
    let s = await waitUp(base);
    down = false;
    const afterRestart = s.giveaway.count;
    // Entries resume after the restart (allow for a loaded machine: up to 15 s).
    for (let i = 0; i < 150; i++) { await sleep(100); s = await getState(base); if (s.giveaway.count > afterRestart + 50) break; }
    await api(base, { action: 'stop' });
    const final = (await getState(base)).giveaway.count;

    // 200 simultaneous "draw" clicks over 50 connections (a browser uses at most 6 per server; more than
    // 128 brand-new connections in the same millisecond would exceed macOS's fixed accept queue).
    const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });
    const drawOnce = () => new Promise((resolve, reject) => {
      const req = http.request({ host: 'localhost', port, path: '/api/giveaway', method: 'POST', agent, headers: { 'Content-Type': 'application/json' } },
        (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(JSON.parse(b))); });
      req.on('error', reject);
      req.end(JSON.stringify({ action: 'draw' }));
    });
    const draws = await Promise.all(Array.from({ length: 200 }, drawOnce));
    agent.destroy();
    const ids = draws.filter((d) => d.ok).map((d) => d.winner.authorId);

    probing = false;
    await Promise.all([probe, reader]);
    latencies.sort((a, b) => a - b);
    const report = {
      entriesBeforeCrash: beforeCrash, savedAtCrash, afterRestart, final,
      latency_ms: { median: latencies[latencies.length >> 1], p99: latencies[Math.floor(latencies.length * 0.99)], max: latencies.at(-1) },
      corruptedReads: fileErrors.length, draws: ids.length, distinctWinners: new Set(ids).size,
      stateFileKB: Math.round(fs.statSync(path.join(dir, 'state.json')).size / 1024),
    };
    console.log('    giveaway stress:', JSON.stringify(report));
    assert.ok(beforeCrash > 2500, `thousands of entries (${beforeCrash})`);
    assert.equal(report.corruptedReads, 0, 'the saved file is never half-written');
    assert.ok(savedAtCrash >= beforeCrash, 'everything up to the crash was saved');
    assert.ok(afterRestart >= savedAtCrash, 'restart keeps every saved entry');
    assert.ok(final > afterRestart, 'entries keep coming after the restart');
    assert.ok(report.latency_ms.p99 < 150, `server stays responsive (p99 ${report.latency_ms.p99} ms)`);
    assert.equal(ids.length, 200);
    assert.equal(report.distinctWinners, 200, 'never the same winner twice');
  } finally {
    probing = false;
    await srv.stop();
  }
});
