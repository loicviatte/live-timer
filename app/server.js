// Speaker timer — dependency-free server.
// Run with: node server.js   (default port 3000, or PORT=xxxx node server.js)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const { YouTubeChat } = require('./youtube-chat');
const updater = require('./updater');
const { Giveaway } = require('./giveaway');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(__dirname, 'settings.json');
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'runtime-state.json');
const YOUTUBE_ENABLED = process.env.NO_YOUTUBE !== '1'; // tests run without network access

// Version of the screen pages. After an update, pages that were already open (with the old code)
// see a different version and reload themselves: no stale page silently missing features.
const BUILD = (() => {
  const hash = crypto.createHash('sha1');
  for (const f of fs.readdirSync(PUBLIC_DIR).sort()) hash.update(f).update(fs.readFileSync(path.join(PUBLIC_DIR, f)));
  return hash.digest('hex').slice(0, 12);
})();

// A live tool must not die on an unexpected error once it's running: log it and keep serving.
// During startup, though, an error is fatal: a half-started server must be noticed (and an update
// that can't start properly must be refused by the dry run).
let started = false;
const onFatal = (err) => {
  console.error('  [error]', err?.stack || err);
  if (!started) process.exit(1);
};
process.on('uncaughtException', onFatal);
process.on('unhandledRejection', onFatal);

// Monotonic clock: an NTP adjustment on the Mac during the live won't make the timer jump.
const now = () => performance.timeOrigin + performance.now();
// Convert between this clock and wall-clock time (used to survive a server restart).
const toWall = (t) => Date.now() - (now() - t);
const fromWall = (w) => now() - (Date.now() - w);

// Steps: from `at` ms remaining (≤), the background turns `color`. `at` can be negative.
const DEFAULT_SETTINGS = {
  duration: 2 * 60 * 1000,
  baseColor: '#111111',
  steps: [
    { at: 60000, color: '#ffd60a' },
    { at: 30000, color: '#ff8a00' },
    { at: 0, color: '#e5002b' },
  ],
  flash: true,
  youtube: '',   // Live video ID (11 characters) for the chat on the TV screen
  chatScale: 1.4,
};

const MAX_MS = 99 * 60 * 1000;
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const clampMs = (n, min, max) => Math.min(max, Math.max(min, Math.round(Number(n) / 1000) * 1000));

function sanitize(input) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const duration = clampMs(Number.isFinite(Number(s.duration)) ? s.duration : DEFAULT_SETTINGS.duration, 1000, MAX_MS);
  const steps = (Array.isArray(s.steps) ? s.steps : [])
    .filter((st) => st && isColor(st.color) && st.at !== null && st.at !== '' && Number.isFinite(Number(st.at)))
    .slice(0, 12)
    .map((st) => ({ at: clampMs(st.at, -MAX_MS, MAX_MS), color: st.color.toLowerCase() }))
    .sort((a, b) => b.at - a.at);
  return {
    duration,
    baseColor: isColor(s.baseColor) ? s.baseColor.toLowerCase() : DEFAULT_SETTINGS.baseColor,
    steps,
    flash: s.flash !== false,
    youtube: typeof s.youtube === 'string' && /^[\w-]{11}$/.test(s.youtube) ? s.youtube : '',
    chatScale: Math.min(3, Math.max(0.8, Number(s.chatScale) || DEFAULT_SETTINGS.chatScale)),
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Atomic write (temp file + rename): a crash mid-write never leaves a corrupted file.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFile(tmp, JSON.stringify(data, null, 2), (err) => {
    if (err) return console.error('  [error] could not save', path.basename(file), err.message);
    fs.rename(tmp, file, (e) => e && console.error('  [error] could not save', path.basename(file), e.message));
  });
}

// status: 'idle' (shows the duration) | 'running' (counting down since startedAt)
//       | 'paused' (frozen at pausedElapsed ms elapsed)
// message: text shown over the speaker screens ({ id, text, blink }) or null
// pollHidden: the admin hid the poll on the TV (reset to false on each new poll)
let state = { status: 'idle', startedAt: null, pausedElapsed: 0, message: null, pollHidden: false, settings: sanitize(readJson(SETTINGS_FILE) || DEFAULT_SETTINGS) };

const giveaway = new Giveaway();

// Restore the timer after a restart (crash, update, closed window): a running countdown keeps going.
(function restoreState() {
  const saved = readJson(STATE_FILE);
  if (!saved || typeof saved !== 'object') return;
  giveaway.restore(saved.giveaway);
  const status = ['idle', 'running', 'paused'].includes(saved.status) ? saved.status : 'idle';
  const startedAt = status === 'running' && Number.isFinite(saved.startedAtWall) ? fromWall(saved.startedAtWall) : null;
  state = {
    ...state,
    status: status === 'running' && startedAt === null ? 'idle' : status,
    startedAt,
    pausedElapsed: status === 'paused' && Number.isFinite(saved.pausedElapsed) ? saved.pausedElapsed : 0,
    message: saved.message && typeof saved.message.text === 'string'
      ? { id: now(), text: saved.message.text.slice(0, 300), blink: false } : null,
    pollHidden: !!saved.pollHidden,
  };
})();

function stateSnapshot() {
  return {
    status: state.status,
    startedAtWall: state.startedAt === null ? null : toWall(state.startedAt),
    pausedElapsed: state.pausedElapsed,
    message: state.message && { text: state.message.text },
    pollHidden: state.pollHidden,
    giveaway: giveaway.toJSON(),
  };
}
function saveState() { writeJson(STATE_FILE, stateSnapshot()); }

function setState(patch) {
  state = { ...state, ...patch };
  saveState();
  broadcast();
}

// ---- Server-Sent Events: ONE stream per page (browsers allow only ~6 connections per server,
// so admin + TV + iPad in the same browser must not each open several). ----
// Clients opened with ?chat=1 (TV, admin) also get the YouTube chat events.
const clients = new Map(); // res -> { chat: boolean }
// Live update status, shown in the admin (see updater.js).
let update = { current: updater.installedVersion(), latest: null, message: '', available: false,
  checking: false, installing: false, error: '', needsManualRestart: false, checkedAt: null };

function send(res, chunk) {
  if (res.destroyed || res.writableEnded) { clients.delete(res); return; }
  try { res.write(chunk); } catch { clients.delete(res); }
}

function payload() {
  return JSON.stringify({ ...state, liveStartedAt: liveStartedAt(), build: BUILD, update, giveaway: giveaway.publicState(), serverNow: now() });
}

function broadcast() {
  const msg = `data: ${payload()}\n\n`;
  for (const res of clients.keys()) send(res, msg);
}

// Regular ping: keeps the connection alive and lets screens detect a dead connection.
setInterval(broadcast, 5000);

function chatSend(event) {
  const msg = `event: chat\ndata: ${JSON.stringify(event)}\n\n`;
  for (const [res, opts] of clients) if (opts.chat) send(res, msg);
}

// ---- YouTube chat: the server reads the chat and pushes it to the screens ----
let lastPollId = null;
const chat = new YouTubeChat({
  onAdd: (messages) => {
    chatSend({ type: 'add', messages });
    if (giveaway.add(messages)) giveawayChanged();
  },
  onRemove: (id) => chatSend({ type: 'remove', id }),
  onLive: () => broadcast(), // the live start time travels with the timer state (LIVE badge)
  onPoll: (poll) => {
    // A new poll shows up on the TV again even if the previous one was hidden.
    if (poll && poll.id !== lastPollId) {
      lastPollId = poll.id;
      if (state.pollHidden && !poll.stale) setState({ pollHidden: false });
    }
    chatSend({ type: 'poll', poll: clientPoll(poll) });
  },
  onStatus: (status) => {
    chatSend({ type: 'status', status });
    if (status.state === 'error') console.log(`  [chat] ${status.detail}`);
  },
});

// closedAt is converted to the server clock, which the screens are synced to.
function clientPoll(poll) {
  return poll && { ...poll, closedAt: poll.closedAt ? fromWall(poll.closedAt) : null };
}

// New entries can pour in (busy chat): save and push at most 4 times per second.
let giveawayTimer = null;
function giveawayChanged() {
  if (giveawayTimer) return;
  giveawayTimer = setTimeout(() => { giveawayTimer = null; saveState(); broadcast(); }, 250);
}

function chatSnapshot() {
  return { type: 'reset', status: chat.status, messages: chat.recent, poll: clientPoll(chat.poll) };
}

function startChat(videoId) {
  const changed = videoId !== chat.videoId;
  // Saving the same link again while the chat is failing forces an immediate retry.
  chat.start(YOUTUBE_ENABLED ? videoId : '', { force: chat.status.state === 'error' });
  if (changed) chatSend(chatSnapshot());
}

// Live start time converted to the server clock (the one screens sync to).
function liveStartedAt() {
  return chat.live ? fromWall(chat.live.startWall) : null;
}
startChat(state.settings.youtube);

// Supervisor: if the chat reader ever stops showing signs of life (a bug, a promise that never
// settles…), restart it. Messages must never silently stop arriving.
const CHAT_STUCK_MS = Number(process.env.CHAT_STUCK_MS) || 90000;
setInterval(() => {
  if (!chat.isStuck(CHAT_STUCK_MS)) return;
  console.log('  [chat] reader stuck — restarting it');
  chat.start(chat.videoId, { force: true });
}, Math.min(15000, CHAT_STUCK_MS / 3)).unref();

// ---- Live updates (see updater.js) ----
// Started by the "Start Timer" launcher, which restarts the server when it exits with code 75.
const SUPERVISED = process.env.TIMER_SUPERVISED === '1';
const RESTART_CODE = 75;
function setUpdate(patch) { update = { ...update, ...patch }; broadcast(); }

async function checkForUpdate() {
  if (update.checking || update.installing) return;
  setUpdate({ checking: true, error: '' });
  try {
    const latest = await updater.latestVersion();
    const available = await updater.isNewer(update.current, latest.sha);
    setUpdate({ latest: available ? latest.sha : update.current, message: available ? latest.message : '', available, checkedAt: Date.now() });
  } catch (err) {
    setUpdate({ error: err?.name === 'TimeoutError' ? 'GitHub did not answer' : err.message });
  } finally {
    setUpdate({ checking: false });
  }
}
updater.confirmAfter(Number(process.env.UPDATE_CONFIRM_MS) || 60000);
if (process.env.UPDATE_CHECK !== '0') {
  setTimeout(checkForUpdate, 3000).unref();
  setInterval(checkForUpdate, Number(process.env.UPDATE_CHECK_MS) || 5 * 60 * 1000).unref();
}

async function installUpdate() {
  if (update.installing || !update.latest) return;
  setUpdate({ installing: true, error: '' });
  try {
    await updater.install(update.latest);
    if (!SUPERVISED) {
      // Old launcher (no restart loop): files are in place, a manual restart finishes the job.
      return setUpdate({ installing: false, current: update.latest, available: false, needsManualRestart: true });
    }
    console.log('\n  ↻ Update installed — restarting…');
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateSnapshot(), null, 2)); // the countdown survives the restart
    server.close();
    for (const res of clients.keys()) res.end();
    setTimeout(() => process.exit(RESTART_CODE), 300);
  } catch (err) {
    setUpdate({ installing: false, error: err.message });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20000) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = JSON.parse(await readBody(req));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
  return body;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const ROUTES = { '/': 'speaker.html', '/speaker': 'speaker.html', '/tv': 'tv.html', '/admin': 'admin.html', '/shared.js': 'shared.js' };

function sendFile(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const ok = (res) => { res.writeHead(204); res.end(); };
const fail = (res, code, text) => { if (!res.headersSent) res.writeHead(code); res.end(text); };

const server = http.createServer(async (req, res) => {
  res.on('error', () => clients.delete(res));
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return fail(res, 400, 'Bad URL'); }
  const post = req.method === 'POST';

  // Controls only accept JSON from our own pages: another website open on a device of the
  // network can't send a "simple" cross-site request to reset the timer or change settings.
  if (post) {
    let sameOrigin = !req.headers.origin;
    try { sameOrigin ||= new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (!sameOrigin || !String(req.headers['content-type']).startsWith('application/json')) {
      return fail(res, 403, 'Forbidden');
    }
  }

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    req.socket.setNoDelay(true);
    const wantsChat = url.searchParams.get('chat') === '1';
    clients.set(res, { chat: wantsChat });
    send(res, 'retry: 1000\n\n');
    send(res, `data: ${payload()}\n\n`);
    if (wantsChat) send(res, `event: chat\ndata: ${JSON.stringify(chatSnapshot())}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Pages opened before the single-connection update still listen here and can't reload themselves:
  // show them a clear "reload this page" message (admin) / the embedded YouTube chat (TV).
  if (url.pathname === '/chat-events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const outdated = { state: 'error', detail: 'This page is out of date — reload it (⌘R)' };
    return res.end(`retry: 5000\n\ndata: ${JSON.stringify({ type: 'reset', status: outdated, messages: [], poll: null })}\n\n`);
  }

  if (url.pathname === '/api/time') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ serverNow: now() }));
  }

  if (post && url.pathname === '/api/go') {
    // From a pause, resume from the time already elapsed.
    if (state.status !== 'running') {
      const elapsed = state.status === 'paused' ? state.pausedElapsed : 0;
      setState({ status: 'running', startedAt: now() - elapsed, pausedElapsed: 0 });
    }
    return ok(res);
  }

  if (post && url.pathname === '/api/pause') {
    if (state.status === 'running') setState({ status: 'paused', pausedElapsed: now() - state.startedAt });
    return ok(res);
  }

  if (post && url.pathname === '/api/reset') {
    setState({ status: 'idle', startedAt: null, pausedElapsed: 0 });
    return ok(res);
  }

  if (post && url.pathname === '/api/message') {
    try {
      const body = await readJsonBody(req);
      const text = String(body.text ?? '').trim().slice(0, 300);
      if (!text) throw new Error('empty');
      setState({ message: { id: now(), text, blink: body.blink !== false } });
      return ok(res);
    } catch {
      return fail(res, 400, 'Bad message');
    }
  }

  if (post && url.pathname === '/api/message/clear') {
    setState({ message: null });
    return ok(res);
  }

  if (post && url.pathname === '/api/poll/hidden') {
    try {
      setState({ pollHidden: !!(await readJsonBody(req)).hidden });
      return ok(res);
    } catch {
      return fail(res, 400, 'Bad request');
    }
  }

  if (post && url.pathname === '/api/giveaway') {
    try {
      const body = await readJsonBody(req);
      const result = {};
      switch (body.action) {
        case 'start': giveaway.start({ keyword: body.keyword, membersOnly: body.membersOnly, showBanner: body.showBanner }); break;
        case 'stop': giveaway.stop(); break;
        case 'banner': giveaway.showBanner = !!body.showBanner; break;
        case 'draw': result.winner = giveaway.draw(); break;
        case 'hide': giveaway.hideReveal(); break;
        case 'reset': giveaway.reset(); break;
        default: throw new Error('Unknown action');
      }
      saveState();
      broadcast();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (post && url.pathname === '/api/update/check') {
    checkForUpdate();
    return ok(res);
  }

  if (post && url.pathname === '/api/update/install') {
    installUpdate();
    return ok(res);
  }

  if (post && url.pathname === '/api/settings') {
    try {
      const settings = sanitize(await readJsonBody(req));
      setState({ settings });
      writeJson(SETTINGS_FILE, settings);
      startChat(settings.youtube);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(settings));
    } catch {
      return fail(res, 400, 'Bad settings');
    }
  }

  if (!post && ROUTES[url.pathname]) return sendFile(res, ROUTES[url.pathname]);
  fail(res, 404, 'Not found');
});

server.keepAliveTimeout = 65000;

function printUrls(alreadyRunning) {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log(alreadyRunning ? '  ⏱  The timer is already running — nothing to restart.' : '  ⏱  Timer started!');
  console.log(line);
  if (ips.length) {
    for (const ip of ips) {
      console.log('\n  SPEAKER (iPad):');
      console.log(`  http://${ip}:${PORT}/`);
      console.log('\n  TV (timer + YouTube chat):');
      console.log(`  http://${ip}:${PORT}/tv`);
      console.log('\n  ADMIN:');
      console.log(`  http://${ip}:${PORT}/admin`);
    }
    console.log(`\n${line}`);
    console.log('  All devices must be on the same Wi-Fi.');
  } else {
    console.log('\n  ⚠️  No network found: connect the Mac to Wi-Fi');
    console.log('     (or to your iPhone hotspot), then restart.');
    console.log(`\n  On this Mac only: http://localhost:${PORT}/admin`);
  }
  if (!alreadyRunning) console.log('  To stop: close this window (or Ctrl+C).');
  console.log(`${line}\n`);
}

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') { console.error('  [error]', err.message); process.exit(1); }
  // Port taken: if it's already our timer, just print the addresses.
  http.get(`http://localhost:${PORT}/api/time`, (res) => {
    if (res.statusCode === 200) printUrls(true);
    else console.error(`\n  ⚠️  Port ${PORT} is used by another app.\n`);
    process.exit(0);
  }).on('error', () => {
    console.error(`\n  ⚠️  Port ${PORT} is used by another app.\n`);
    process.exit(1);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  printUrls(false);
  // Fully started once the whole file has run and the port is open.
  setImmediate(() => { started = true; });
});
