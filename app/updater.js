// Live updates from GitHub, without git and without stopping the show.
// check(): asks GitHub for the latest version. install(): downloads it, verifies it, swaps the files
// (settings and the running countdown are never touched). The server then restarts in ~1 s and the
// screens reload themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.UPDATE_REPO || 'loicviatte/live-timer';
const API = process.env.UPDATE_API || 'https://api.github.com';
const CODELOAD = process.env.UPDATE_CODELOAD || 'https://codeload.github.com';
const BRANCH = process.env.UPDATE_BRANCH || 'main';

const APP_DIR = __dirname;
const ROOT = path.dirname(APP_DIR);
const VERSION_FILE = path.join(APP_DIR, '.version');
// Never overwritten by an update: they belong to this Mac.
const KEEP = new Set(['settings.json', 'runtime-state.json', '.version']);
// Files next to the app folder that an update also refreshes.
const ROOT_FILES = ['Start Timer.command', 'READ ME FIRST.txt'];

const get = (url, headers = {}) => fetch(url, { headers: { 'User-Agent': 'live-timer', ...headers }, signal: AbortSignal.timeout(20000) });

// Version installed here: written by the last update, or the git commit on a developer's copy.
function installedVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim() || null; } catch {}
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  return null;
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

    // 3. Swap the files (app folder + launcher/readme), keeping this Mac's settings and state.
    let changed = 0;
    for (const rel of walk(path.join(src, 'app'))) {
      if (KEEP.has(path.basename(rel))) continue;
      const from = path.join(src, 'app', rel), to = path.join(APP_DIR, rel);
      if (sameContent(from, to)) continue;
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
    return { changed };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { installedVersion, latestVersion, install, REPO };
