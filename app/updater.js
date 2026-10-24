// Live updates from GitHub, without git and without stopping the show.
// check(): asks GitHub for the latest version. install(): downloads it, verifies it, swaps the files
// (settings and the running countdown are never touched). The server then restarts in ~1 s and the
// screens reload themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const net = require('net');
const http = require('http');

const REPO = process.env.UPDATE_REPO || 'loicviatte/live-timer';
const API = process.env.UPDATE_API || 'https://api.github.com';
const CODELOAD = process.env.UPDATE_CODELOAD || 'https://codeload.github.com';
const BRANCH = process.env.UPDATE_BRANCH || 'main';

const APP_DIR = __dirname;
const ROOT = path.dirname(APP_DIR);
const VERSION_FILE = path.join(APP_DIR, '.version');
// Previous version of every replaced file, and a marker the launcher checks: if the server dies
// right after an update, the launcher puts the previous version back (see "Start Timer").
const BACKUP_DIR = path.join(APP_DIR, '.backup');
const PENDING_FILE = path.join(APP_DIR, '.update-pending');
// Never overwritten by an update: they belong to this Mac.
const KEEP = new Set(['settings.json', 'runtime-state.json', '.version', '.update-pending']);
// Files next to the app folder that an update also refreshes.
const ROOT_FILES = ['Start Timer.command', 'READ ME FIRST.txt'];

const get = (url, headers = {}) => fetch(url, { headers: { 'User-Agent': 'live-timer', ...headers }, signal: AbortSignal.timeout(20000) });

// Version installed here: written by the last update, or the git commit on a developer's copy.
function installedVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim() || null; } catch {}
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  return null;
}

// Is `latest` really newer than `current`? GitHub can serve a cached "latest" for about a minute,
// which must never offer a downgrade. Unknown to GitHub (a local, unpublished commit): not newer.
async function isNewer(current, latest) {
  if (!latest || latest === current) return false;
  if (!current) return true; // copy installed without version info: take the published one
  const res = await get(`${API}/repos/${REPO}/compare/${current}...${latest}`, { Accept: 'application/vnd.github+json' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const { status } = await res.json();
  return status === 'ahead' || status === 'diverged';
}

async function latestVersion() {
  const res = await get(`${API}/repos/${REPO}/commits/${BRANCH}`, { Accept: 'application/vnd.github+json' });
  if (!res.ok) throw new Error(res.status === 403 ? 'GitHub limit reached, try again later' : `GitHub answered ${res.status}`);
  const c = await res.json();
  return { sha: c.sha, message: String(c.commit?.message || '').split('\n')[0].slice(0, 120), date: c.commit?.committer?.date || null };
}

// Copy a file atomically (temp + rename): a running process never reads a half-written file.
function placeFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.update-tmp`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, fs.statSync(src).mode & 0o777);
  fs.renameSync(tmp, dest);
}

function sameContent(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
        if (res.headers['content-type']?.includes('event-stream') && body.includes('\ndata: ')) req.destroy();
      });
      res.on('close', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

// Dry run: start the downloaded version on its own (other port, copies of the settings, no YouTube)
// and require it to serve the pages and the timer state. Nothing is swapped unless it really starts.
async function preflight(src, tmp) {
  const port = await freePort();
  const settings = path.join(tmp, 'preflight-settings.json'), state = path.join(tmp, 'preflight-state.json');
  for (const [from, to] of [['settings.json', settings], ['runtime-state.json', state]]) {
    try { fs.copyFileSync(path.join(APP_DIR, from), to); } catch {}
  }
  const child = spawn(process.execPath, [path.join(src, 'app', 'server.js')], {
    cwd: path.join(src, 'app'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), NO_YOUTUBE: '1', UPDATE_CHECK: '0', TIMER_PREFLIGHT: '1',
      TIMER_SUPERVISED: '', SETTINGS_FILE: settings, STATE_FILE: state },
  });
  let exited = false;
  child.on('exit', () => (exited = true));
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !exited) {
      try {
        const base = `http://127.0.0.1:${port}`;
        const pages = await Promise.all(['/', '/tv', '/admin', '/shared.js', '/api/time'].map((p) => httpGet(base + p)));
        const events = await httpGet(`${base}/events`);
        const ok = pages.every((r) => r.status === 200) && /data: \{.*"status"/.test(events.body);
        if (ok) { await new Promise((r) => setTimeout(r, 1500)); if (!exited) return; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Update rejected: the new version did not start correctly');
  } finally {
    child.kill();
  }
}

async function install(sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('Bad version id');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-timer-update-'));
  try {
    // 1. Download and unpack the exact version.
    const res = await get(`${CODELOAD}/${REPO}/tar.gz/${sha}`);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const archive = path.join(tmp, 'update.tar.gz');
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    execFileSync('tar', ['xzf', archive, '-C', tmp]);
    const top = fs.readdirSync(tmp, { withFileTypes: true }).find((e) => e.isDirectory());
    if (!top) throw new Error('Empty download');
    const src = path.join(tmp, top.name);

    // 2. Refuse anything that wouldn't start: the files must exist and the code must parse.
    for (const f of ['app/server.js', 'app/youtube-chat.js', 'app/updater.js', 'app/public/shared.js', 'app/public/tv.html', 'app/public/admin.html', 'app/public/speaker.html']) {
      if (!fs.existsSync(path.join(src, f))) throw new Error(`Update is incomplete (${f} missing)`);
    }
    for (const f of ['app/server.js', 'app/youtube-chat.js', 'app/updater.js', 'app/public/shared.js']) {
      try { execFileSync(process.execPath, ['--check', path.join(src, f)], { stdio: 'pipe' }); }
      catch { throw new Error(`Update rejected: ${f} has an error`); }
    }

    // 3. Dry run: the new version must actually start and serve the screens.
    await preflight(src, tmp);

    // 4. Back up what will be replaced, then swap the files (keeping this Mac's settings and state).
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    const backup = (to, rel) => {
      if (!fs.existsSync(to)) return;
      fs.mkdirSync(path.dirname(path.join(BACKUP_DIR, rel)), { recursive: true });
      fs.copyFileSync(to, path.join(BACKUP_DIR, rel));
    };
    backup(VERSION_FILE, '.version');
    let changed = 0;
    for (const rel of walk(path.join(src, 'app'))) {
      if (KEEP.has(path.basename(rel))) continue;
      const from = path.join(src, 'app', rel), to = path.join(APP_DIR, rel);
      if (sameContent(from, to)) continue;
      backup(to, rel);
      placeFile(from, to);
      changed++;
    }
    for (const name of ROOT_FILES) {
      const from = path.join(src, name), to = path.join(ROOT, name);
      if (!fs.existsSync(from) || sameContent(from, to)) continue;
      // The launcher keeps its custom icon (stored as extended attributes).
      let icon = null;
      if (name.endsWith('.command')) { try { icon = execFileSync('xattr', ['-px', 'com.apple.ResourceFork', to]).toString(); } catch {} }
      placeFile(from, to);
      if (icon) {
        try {
          execFileSync('xattr', ['-wx', 'com.apple.ResourceFork', icon.replace(/\s+/g, ''), to]);
          execFileSync('xattr', ['-wx', 'com.apple.FinderInfo', '0000000000000000040000000000000000000000000000000000000000000000', to]);
        } catch {}
      }
      changed++;
    }
    fs.writeFileSync(VERSION_FILE, `${sha}\n`);
    fs.writeFileSync(PENDING_FILE, `${Date.now()}\n`); // cleared once the new version has run fine for a minute
    return { changed };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Called by the server at start: after an update, once it has run fine for a while, the update is
// confirmed (the launcher will no longer roll it back).
function confirmAfter(ms) {
  if (!fs.existsSync(PENDING_FILE)) return;
  setTimeout(() => fs.rmSync(PENDING_FILE, { force: true }), ms).unref();
}

module.exports = { installedVersion, latestVersion, isNewer, install, confirmAfter, REPO };
