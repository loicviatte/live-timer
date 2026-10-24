// Live update tests, against a fake GitHub (local HTTP server). Each test works on a throwaway
// copy of the app, so the real files are never touched. Run with:  node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'timer-upd-'));

// A copy of the project as installed on a Mac: launcher + app/ (+ that Mac's own settings).
function installCopy() {
  const dir = tmpdir();
  fs.cpSync(path.join(REPO_ROOT, 'app'), path.join(dir, 'app'), { recursive: true, filter: (f) => !/runtime-state|settings\.json|\.version/.test(f) });
  fs.copyFileSync(path.join(REPO_ROOT, 'Start Timer.command'), path.join(dir, 'Start Timer.command'));
  fs.writeFileSync(path.join(dir, 'app', 'settings.json'), JSON.stringify({ youtube: 'MYLIVEID001', duration: 300000 }));
  fs.writeFileSync(path.join(dir, 'app', '.version'), 'aaaaaaa\n');
  return dir;
}

// A "new version" archive like GitHub serves it: live-timer-<sha>/app/...
function makeRelease(sha, tweak) {
  const dir = tmpdir();
  const top = path.join(dir, `live-timer-${sha}`);
  fs.cpSync(path.join(REPO_ROOT, 'app'), path.join(top, 'app'), { recursive: true, filter: (f) => !/runtime-state|settings\.json|\.version/.test(f) });
  fs.copyFileSync(path.join(REPO_ROOT, 'Start Timer.command'), path.join(top, 'Start Timer.command'));
  fs.writeFileSync(path.join(top, 'app', 'settings.json'), '{"youtube":"SHOULDNOTWIN"}'); // must never overwrite the local one
  tweak?.(top);
  const archive = path.join(dir, 'release.tar.gz');
  execFileSync('tar', ['czf', archive, '-C', dir, `live-timer-${sha}`]);
  return fs.readFileSync(archive);
}

// order: version ids from oldest to newest (for the "is it newer?" compare endpoint).
function fakeGitHub(releases, latest, order = ['aaaaaaa', ...Object.keys(releases)]) {
  const server = http.createServer((req, res) => {
    const cmp = req.url.match(/^\/repos\/me\/live-timer\/compare\/(\w+)\.\.\.(\w+)$/);
    if (cmp) {
      const [a, b] = [order.indexOf(cmp[1]), order.indexOf(cmp[2])];
      if (a < 0 || b < 0) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ status: b > a ? 'ahead' : b < a ? 'behind' : 'identical' }));
    }
    if (req.url.startsWith('/repos/me/live-timer/commits/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ sha: latest(), commit: { message: `Release ${latest()}\n\ndetails`, committer: { date: '2026-10-24T12:00:00Z' } } }));
    }
    const m = req.url.match(/^\/me\/live-timer\/tar\.gz\/(\w+)$/);
    if (m && releases[m[1]]) { res.setHeader('Content-Type', 'application/gzip'); return res.end(releases[m[1]]); }
    res.statusCode = 404; res.end();
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, url: `http://localhost:${server.address().port}` })));
}

function useFakeGitHub(url) {
  process.env.UPDATE_REPO = 'me/live-timer';
  process.env.UPDATE_API = url;
  process.env.UPDATE_CODELOAD = url;
}

test('install: swaps the code, keeps this Mac\'s settings, records the version', async () => {
  const sha = 'b'.repeat(40);
  const release = makeRelease(sha, (top) => fs.appendFileSync(path.join(top, 'app', 'public', 'tv.html'), '\n<!-- new version -->\n'));
  const gh = await fakeGitHub({ [sha]: release }, () => sha);
  useFakeGitHub(gh.url);
  const dir = installCopy();
  try {
    const updater = require(path.join(dir, 'app', 'updater.js'));
    assert.equal(updater.installedVersion(), 'aaaaaaa');
    const latest = await updater.latestVersion();
    assert.equal(latest.sha, sha);
    assert.equal(latest.message, `Release ${sha}`, 'first line of the commit message');
    const { changed } = await updater.install(sha);
    assert.ok(changed >= 1);
    assert.ok(fs.readFileSync(path.join(dir, 'app', 'public', 'tv.html'), 'utf8').includes('new version'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'app', 'settings.json'), 'utf8')).youtube, 'MYLIVEID001', 'settings untouched');
    assert.equal(updater.installedVersion(), sha);
    assert.ok(fs.statSync(path.join(dir, 'Start Timer.command')).mode & 0o100, 'launcher still executable');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'app')).filter((f) => f.includes('update-tmp')), [], 'no temp files left');
  } finally { gh.server.close(); }
});

test('never offers a downgrade (GitHub serving an older "latest" from its cache)', async () => {
  const newer = 'f'.repeat(40);
  const gh = await fakeGitHub({}, () => 'aaaaaaa', ['aaaaaaa', newer]);
  useFakeGitHub(gh.url);
  const dir = installCopy();
  fs.writeFileSync(path.join(dir, 'app', '.version'), `${newer}\n`);
  try {
    const updater = require(path.join(dir, 'app', 'updater.js'));
    const latest = await updater.latestVersion();
    assert.equal(await updater.isNewer(newer, latest.sha), false, 'older "latest" is not an update');
    assert.equal(await updater.isNewer('aaaaaaa', newer), true);
    assert.equal(await updater.isNewer('1234567', newer), false, 'unknown local version: never overwritten');
    assert.equal(await updater.isNewer(null, newer), true, 'no version info: take the published one');
  } finally { gh.server.close(); }
});

test('a broken release is refused and nothing is changed', async () => {
  const sha = 'c'.repeat(40);
  const release = makeRelease(sha, (top) => fs.writeFileSync(path.join(top, 'app', 'server.js'), 'this is not javascript {{{'));
  const gh = await fakeGitHub({ [sha]: release }, () => sha);
  useFakeGitHub(gh.url);
  const dir = installCopy();
  try {
    const before = fs.readFileSync(path.join(dir, 'app', 'server.js'));
    const updater = require(path.join(dir, 'app', 'updater.js'));
    await assert.rejects(updater.install(sha), /has an error/);
    assert.ok(fs.readFileSync(path.join(dir, 'app', 'server.js')).equals(before), 'old code kept');
    assert.equal(updater.installedVersion(), 'aaaaaaa');
    await assert.rejects(updater.install('d'.repeat(40)), /Download failed/);
    await assert.rejects(updater.install('../../etc'), /Bad version/);
  } finally { gh.server.close(); }
});

test('from the admin: install → server restarts by itself, countdown keeps going', async () => {
  const v1 = 'aaaaaaa', v2 = 'e'.repeat(40);
  const release = makeRelease(v2, (top) => fs.appendFileSync(path.join(top, 'app', 'public', 'admin.html'), '\n<!-- v2 -->\n'));
  const gh = await fakeGitHub({ [v2]: release }, () => v2);
  const dir = installCopy();
  const port = 39000 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${port}`;
  // The real launcher loop, minus caffeinate/Terminal: restart on exit code 75.
  const env = { ...process.env, PORT: String(port), NO_YOUTUBE: '1', TIMER_SUPERVISED: '1', UPDATE_CHECK_MS: '600000',
    UPDATE_REPO: 'me/live-timer', UPDATE_API: gh.url, UPDATE_CODELOAD: gh.url };
  let starts = 0, stopped = false, child;
  const run = () => {
    starts++;
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(dir, 'app'), env, stdio: 'ignore' });
    child.on('exit', (code) => { if (code === 75 && !stopped) run(); });
  };
  run();
  const state = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        return await new Promise((resolve, reject) => {
          const req = http.get(`${base}/events`, (res) => {
            let buf = '';
            res.on('data', (d) => { buf += d; const m = buf.match(/^data: (.+)$/m); if (m) { req.destroy(); resolve(JSON.parse(m[1])); } });
          });
          req.on('error', reject);
        });
      } catch { await sleep(50); }
    }
    throw new Error('server not reachable');
  };
  const post = (a) => fetch(`${base}/api/${a}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  try {
    let s = await state();
    await post('go');
    for (let i = 0; i < 100 && !s.update?.available; i++) { await sleep(50); s = await state(); }
    assert.equal(s.update.current, v1);
    assert.equal(s.update.available, true, 'update detected');
    const before = await state();
    const buildBefore = before.build;
    await post('update/install');
    // Wait for the restarted server (new build = new pages).
    let after;
    for (let i = 0; i < 100; i++) { await sleep(100); try { after = await state(); if (after.build !== buildBefore) break; } catch {} }
    assert.equal(starts, 2, 'restarted exactly once');
    assert.notEqual(after.build, buildBefore, 'screens will see a new version and reload');
    assert.equal(after.update.current, v2);
    assert.equal(after.update.available, false);
    assert.equal(after.status, 'running', 'the countdown survived the update');
    assert.equal(after.settings.youtube, 'MYLIVEID001', 'settings survived the update');
    const elapsedBefore = before.serverNow - before.startedAt, elapsedAfter = after.serverNow - after.startedAt;
    assert.ok(elapsedAfter >= elapsedBefore, 'time kept moving forward');
  } finally {
    stopped = true;
    child.kill();
    gh.server.close();
  }
});

test('a release that crashes at start is caught by the dry run: nothing changes', async () => {
  const sha = '1'.repeat(40);
  // Valid syntax, but dies when started (e.g. a missing file).
  const release = makeRelease(sha, (top) => fs.appendFileSync(path.join(top, 'app', 'server.js'), "\nrequire('./does-not-exist');\n"));
  const gh = await fakeGitHub({ [sha]: release }, () => sha);
  useFakeGitHub(gh.url);
  const dir = installCopy();
  try {
    const before = fs.readFileSync(path.join(dir, 'app', 'server.js'));
    const updater = require(path.join(dir, 'app', 'updater.js'));
    await assert.rejects(updater.install(sha), /did not start/);
    assert.ok(fs.readFileSync(path.join(dir, 'app', 'server.js')).equals(before), 'old code kept');
    assert.equal(updater.installedVersion(), 'aaaaaaa');
    assert.ok(!fs.existsSync(path.join(dir, 'app', '.update-pending')));
  } finally { gh.server.close(); }
});

// Runs the REAL "Start Timer" launcher of an install copy (zsh loop with restart + rollback).
function runLauncher(dir, env) {
  // Own process group (detached), so stopping it also stops caffeinate and the node server.
  const child = spawn('/bin/zsh', [path.join(dir, 'Start Timer.command')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, out: () => out, stop: () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
}

async function waitState(base, cond, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await new Promise((resolve, reject) => {
        const req = http.get(`${base}/events`, (res) => {
          let buf = '';
          res.on('data', (d) => { buf += d; const m = buf.match(/^data: (.+)$/m); if (m) { req.destroy(); resolve(JSON.parse(m[1])); } });
        });
        req.on('error', reject);
      });
      if (cond(last)) return last;
    } catch {}
    await sleep(100);
  }
  throw new Error(`state never matched; last: ${JSON.stringify(last?.update)}`);
}

test('a release that dies after starting: the launcher goes back to the previous version by itself', async () => {
  const good = 'aaaaaaa', bad = '2'.repeat(40);
  // Passes the dry run, but the real server dies 1 s after starting.
  const release = makeRelease(bad, (top) => fs.appendFileSync(path.join(top, 'app', 'server.js'),
    "\nif (!process.env.TIMER_PREFLIGHT) setTimeout(() => process.exit(1), 1000);\n"));
  const gh = await fakeGitHub({ [bad]: release }, () => bad);
  const dir = installCopy();
  const port = 40000 + Math.floor(Math.random() * 1000), base = `http://localhost:${port}`;
  const launcher = runLauncher(dir, { PORT: String(port), NO_YOUTUBE: '1', UPDATE_CHECK_MS: '600000',
    UPDATE_REPO: 'me/live-timer', UPDATE_API: gh.url, UPDATE_CODELOAD: gh.url });
  try {
    await waitState(base, (s) => s.update?.available);
    await fetch(`${base}/api/go`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await fetch(`${base}/api/update/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    // Bad version starts, dies, launcher rolls back, previous version serves again.
    await sleep(4000);
    const s = await waitState(base, (x) => x.update?.current === good, 20000);
    assert.equal(s.status, 'running', 'countdown still running after the failed update + rollback');
    assert.match(launcher.out(), /going back to the previous version/);
    assert.equal(fs.readFileSync(path.join(dir, 'app', '.version'), 'utf8').trim(), good);
    assert.ok(!fs.readFileSync(path.join(dir, 'app', 'server.js'), 'utf8').includes('TIMER_PREFLIGHT) setTimeout'), 'previous code restored');
    assert.ok(!fs.existsSync(path.join(dir, 'app', '.update-pending')));
    await sleep(1500);
    assert.equal((await fetch(`${base}/api/time`)).status, 200, 'and it stays up');
  } finally {
    launcher.stop();
    gh.server.close();
  }
});

test('launcher: an unexpected crash (not an update) restarts the server, countdown resumes', async () => {
  const dir = installCopy();
  const port = 41000 + Math.floor(Math.random() * 1000), base = `http://localhost:${port}`;
  const launcher = runLauncher(dir, { PORT: String(port), NO_YOUTUBE: '1', UPDATE_CHECK: '0' });
  try {
    const first = await waitState(base, () => true);
    await fetch(`${base}/api/go`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await sleep(500);
    // Kill the node server brutally (like a crash), 3 times in a row.
    for (let i = 0; i < 3; i++) {
      const pid = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).toString().trim();
      process.kill(Number(pid), 'SIGKILL');
      await sleep(300);
      const s = await waitState(base, (x) => x.status === 'running', 10000);
      assert.equal(s.status, 'running', `back and still counting after crash ${i + 1}`);
    }
    assert.equal((launcher.out().match(/stopped unexpectedly — restarting/g) || []).length, 3);
    assert.ok(first);
  } finally { launcher.stop(); }
});

test('launcher: a crash loop stops after 5 tries instead of looping forever', async () => {
  const dir = installCopy();
  fs.appendFileSync(path.join(dir, 'app', 'server.js'), '\nprocess.exit(3);\n'); // dies at every start
  const launcher = runLauncher(dir, { PORT: String(42000 + Math.floor(Math.random() * 1000)), NO_YOUTUBE: '1', UPDATE_CHECK: '0' });
  try {
    const code = await new Promise((resolve) => launcher.child.on('exit', resolve));
    assert.match(launcher.out(), /keeps stopping/);
    assert.equal((launcher.out().match(/restarting it/g) || []).length, 5);
    assert.notEqual(code, null);
  } finally { launcher.stop(); }
});
