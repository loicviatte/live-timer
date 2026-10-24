// "Everything at once" end-to-end chaos test, closest to a messy live:
// the REAL launcher + server, a fake YouTube chat that keeps failing, a fake GitHub,
// 100 screens that reconnect by themselves, 20 admin clicks per second for 45 s,
// a live update installed in the middle, then a brutal server crash.
// Run with:  node --test tests/

const test = require('node:test');
const { freePort } = require('./helpers');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyApp(to) {
  fs.cpSync(path.join(REPO_ROOT, 'app'), path.join(to, 'app'), { recursive: true, filter: (f) => !/runtime-state|settings\.json|\.version|\.backup|update-pending/.test(f) });
  fs.copyFileSync(path.join(REPO_ROOT, 'Start Timer.command'), path.join(to, 'Start Timer.command'));
}

test('chaos: 100 screens, 20 clicks/s, flaky YouTube, live update + crash — nothing freezes, chat keeps flowing', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-chaos-'));
  copyApp(dir);
  fs.writeFileSync(path.join(dir, 'app', 'settings.json'), JSON.stringify({ youtube: 'CHAOSVIDEO1', duration: 60000 }));
  fs.writeFileSync(path.join(dir, 'app', '.version'), 'aaaaaaa\n');

  // Fake GitHub: v2 appears after 8 s.
  const v2 = '9'.repeat(40);
  const rel = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-rel-'));
  copyApp(path.join(rel, `live-timer-${v2}`));
  fs.appendFileSync(path.join(rel, `live-timer-${v2}`, 'app', 'public', 'tv.html'), '\n<!-- v2 -->\n');
  execFileSync('tar', ['czf', path.join(rel, 'r.tgz'), '-C', rel, `live-timer-${v2}`]);
  const archive = fs.readFileSync(path.join(rel, 'r.tgz'));
  let published = 'aaaaaaa';
  const gh = http.createServer((req, res) => {
    if (req.url.includes('/compare/')) { res.end(JSON.stringify({ status: req.url.endsWith(`...${v2}`) && !req.url.includes(`${v2}...`) ? 'ahead' : 'identical' })); return; }
    if (req.url.includes('/commits/')) { res.end(JSON.stringify({ sha: published, commit: { message: 'Chaos release' } })); return; }
    if (req.url.endsWith(`/tar.gz/${v2}`)) { res.end(archive); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => gh.listen(0, r));
  const ghUrl = `http://localhost:${gh.address().port}`;

  const port = await freePort(), fakePort = await freePort(), base = `http://localhost:${port}`;
  const launcher = spawn('/bin/zsh', [path.join(dir, 'Start Timer.command')], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), UPDATE_REPO: 'me/live-timer', UPDATE_API: ghUrl, UPDATE_CODELOAD: ghUrl,
      UPDATE_CHECK_MS: '2000', UPDATE_CONFIRM_MS: '3000',
      NODE_OPTIONS: `--require ${path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-youtube.js')}`,
      FAKE_YT_PORT: String(fakePort), FAKE_YT_RATE: '20', FAKE_YT_CHAOS: '0.1',
      YT_POLL_MS: '300', YT_TIMEOUT_MS: '2000', YT_BACKOFF_MS: '300', YT_STALL_MS: '5000' },
  });
  let out = '';
  launcher.stdout.on('data', (d) => (out += d));
  launcher.stderr.on('data', (d) => (out += d));

  // 100 screens with auto-reconnect; half of them get the chat (like TVs/admins).
  const screens = [];
  let running = true;
  for (let i = 0; i < 100; i++) {
    const sc = { chat: i % 2 === 0, states: [], chatAt: [], connections: 0, dupes: 0, bad: 0, req: null };
    const connect = () => {
      if (!running) return;
      const seen = new Set();
      sc.req = http.get(`${base}/events${sc.chat ? '?chat=1' : ''}`, (res) => {
        sc.connections++;
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          let k;
          while ((k = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, k); buf = buf.slice(k + 2);
            const data = chunk.match(/^data: (.+)$/m)?.[1];
            if (!data) continue;
            const ev = JSON.parse(data);
            if (chunk.includes('event: chat')) {
              if (ev.type === 'add') {
                sc.chatAt.push(Date.now());
                for (const m of ev.messages) { if (seen.has(m.id)) sc.dupes++; seen.add(m.id); }
              }
            } else {
              sc.states.push(Date.now());
              const okState = ['idle', 'running', 'paused'].includes(ev.status) && Number.isFinite(ev.settings?.duration)
                && (ev.status !== 'running' || Number.isFinite(ev.startedAt)) && !(ev.pausedElapsed < 0);
              if (!okState) sc.bad++;
            }
          }
        });
        res.on('close', () => setTimeout(connect, 500));
      });
      sc.req.on('error', () => setTimeout(connect, 500));
    };
    screens.push(sc);
    connect();
  }

  const post = (a, body = {}) => fetch(`${base}/api/${a}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  const actions = ['go', 'pause', 'go', 'reset', 'message', 'message/clear', 'poll/hidden'];
  let clicks = 0, installedAt = null, crashedAt = null;
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < 45000) {
      const t = Date.now() - t0;
      const a = actions[clicks % actions.length];
      post(a, a === 'message' ? { text: `msg ${clicks}` } : a === 'poll/hidden' ? { hidden: clicks % 2 === 0 } : {});
      if (clicks % 40 === 0) post('settings', { youtube: 'CHAOSVIDEO1', duration: 60000 + (clicks % 5) * 1000, chatScale: 1 + (clicks % 10) / 10 });
      clicks++;
      if (t > 8000 && published !== v2) published = v2;
      if (t > 13000 && !installedAt) { installedAt = Date.now(); post('update/install'); }
      if (t > 28000 && !crashedAt) {
        crashedAt = Date.now();
        try { process.kill(Number(execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).toString().trim().split('\n')[0]), 'SIGKILL'); } catch {}
      }
      await sleep(50);
    }
    await sleep(6000); // let everything settle

    const now = Date.now();
    const state = await new Promise((resolve) => http.get(`${base}/events`, (res) => {
      let b = ''; res.on('data', (d) => { b += d; const m = b.match(/^data: (.+)$/m); if (m) { res.destroy(); resolve(JSON.parse(m[1])); } });
    }));
    const report = {
      clicks,
      updateInstalled: state.update?.current === v2,
      restartedForUpdate: /Restarting with the new version/.test(out),
      restartedAfterCrash: /stopped unexpectedly — restarting/.test(out),
      screensAliveNow: screens.filter((s) => s.states.some((t) => now - t < 7000)).length,
      chatScreensGettingChatNow: screens.filter((s) => s.chat && s.chatAt.some((t) => now - t < 8000)).length,
      worstOutage_ms: Math.max(...screens.map((s) => Math.max(...s.states.slice(1).map((t, i) => t - s.states[i])))),
      duplicatesWithinAConnection: screens.reduce((n, s) => n + s.dupes, 0),
      invalidStates: screens.reduce((n, s) => n + s.bad, 0),
    };
    console.log('    chaos report:', JSON.stringify(report));
    assert.ok(clicks > 700, 'enough admin chaos');
    assert.ok(report.updateInstalled, 'the live update was installed');
    assert.ok(report.restartedForUpdate && report.restartedAfterCrash, 'restarted for the update and after the crash');
    assert.equal(report.screensAliveNow, 100, 'every screen is connected and receiving the timer at the end');
    assert.equal(report.chatScreensGettingChatNow, 50, 'every chat screen is still receiving chat messages at the end');
    assert.ok(report.worstOutage_ms < 6000, `no screen went more than 6 s without the timer (worst ${report.worstOutage_ms} ms)`);
    assert.equal(report.duplicatesWithinAConnection, 0);
    assert.equal(report.invalidStates, 0, 'never an inconsistent timer state');
  } finally {
    running = false;
    screens.forEach((s) => s.req?.destroy());
    try { process.kill(-launcher.pid, 'SIGKILL'); } catch {}
    gh.close();
  }
});
