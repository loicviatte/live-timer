// Giveaway tests: keyword matching, one entry per person, history before the opening ignored,
process.env.MONITOR = '0'; // never send real alerts from tests (child servers inherit this)
// members-only, fair draws without repeats, persistence. Run with:  node --test tests/

const test = require('node:test');
const { freePort } = require('./helpers');
const assert = require('node:assert/strict');
const { Giveaway } = require('../app/giveaway');

const msg = (authorId, text, extra = {}) => ({ id: `${authorId}-${Math.random()}`, authorId, author: `@${authorId}`, parts: [{ text }], at: Date.now(), ...extra });

test('keyword matching: case, accents, punctuation, inside a sentence — but whole words only', () => {
  const g = new Giveaway();
  g.start({ keyword: 'Gâteau' });
  const yes = ['gateau', 'GÂTEAU!!', 'je veux le gateau 🎂', 'Gâteau.', '«gâteau»', 'moi: GATEAU'];
  const no = ['gateaux', 'supergateau', 'gat eau', 'chocolat', ''];
  yes.forEach((t, i) => g.add([msg(`y${i}`, t)]));
  no.forEach((t, i) => g.add([msg(`n${i}`, t)]));
  assert.deepEqual([...g.entrants.keys()].sort(), yes.map((_, i) => `y${i}`).sort());

  const c = new Giveaway();
  c.start({ keyword: '!join' });
  c.add([msg('a', '!join'), msg('b', 'hey !JOIN me'), msg('c', 'join'), msg('d', '!joined')]);
  assert.deepEqual([...c.entrants.keys()].sort(), ['a', 'b']);
});

test('one entry per person; host excluded; members-only respected; closed = no new entries', () => {
  const g = new Giveaway();
  g.start({ keyword: 'fifth' });
  g.add([msg('a', 'fifth'), msg('a', 'fifth fifth'), msg('host', 'fifth', { role: 'owner' }), msg('mod', 'fifth', { role: 'moderator' })]);
  assert.deepEqual([...g.entrants.keys()].sort(), ['a', 'mod']);
  g.stop();
  g.add([msg('late', 'fifth')]);
  assert.equal(g.entrants.has('late'), false, 'no entries once closed');

  const m = new Giveaway();
  m.start({ keyword: 'fifth', membersOnly: true });
  m.add([msg('fan', 'fifth'), msg('member', 'fifth', { member: true })]);
  assert.deepEqual([...m.entrants.keys()], ['member']);
});

test('messages written before entries opened (replayed history) do not count', () => {
  const g = new Giveaway();
  const opening = Date.now();
  g.start({ keyword: 'fifth' }, opening);
  g.add([msg('old', 'fifth', { at: opening - 60000 }), msg('new', 'fifth', { at: opening + 1000 })]);
  assert.deepEqual([...g.entrants.keys()], ['new']);
});

test('needs a keyword; drawing needs entries', () => {
  const g = new Giveaway();
  assert.throws(() => g.start({ keyword: '   ' }), /keyword/);
  g.start({ keyword: 'x' });
  assert.throws(() => g.draw(), /No entries/);
});

test('draws never repeat a winner and stop when everyone has won', () => {
  const g = new Giveaway();
  g.start({ keyword: 'go' });
  g.add(Array.from({ length: 5 }, (_, i) => msg(`p${i}`, 'go')));
  const winners = Array.from({ length: 5 }, () => g.draw().authorId);
  assert.equal(new Set(winners).size, 5);
  assert.throws(() => g.draw(), /already won/);
  assert.equal(g.reveal.author, `@${winners[4]}`, 'the TV shows the last draw');
});

test('the draw is fair (20,000 draws over 10 people: each wins ~10%)', () => {
  const wins = {};
  for (let i = 0; i < 20000; i++) {
    const g = new Giveaway();
    g.start({ keyword: 'go' });
    g.add(Array.from({ length: 10 }, (_, k) => msg(`p${k}`, 'go')));
    const w = g.draw().authorId;
    wins[w] = (wins[w] || 0) + 1;
  }
  for (const n of Object.values(wins)) assert.ok(n > 1700 && n < 2300, `share ${n / 200}%`);
  assert.equal(Object.keys(wins).length, 10);
});

test('the TV animation pool never contains the winner, and screens get no private ids', () => {
  const g = new Giveaway();
  g.start({ keyword: 'go' });
  g.add(Array.from({ length: 40 }, (_, i) => msg(`UCsecret${i}`, 'go', { author: `Viewer ${i}` })));
  const w = g.draw();
  assert.ok(!g.reveal.pool.includes(w.author));
  assert.ok(g.reveal.pool.length <= 24);
  const pub = JSON.stringify(g.publicState());
  assert.ok(!pub.includes('authorId') && !pub.includes('UCsecret'), 'channel ids stay on the server');
  assert.equal(g.publicState().count, 40);
  assert.equal(g.publicState().recent.length, 8);
});

test('save / restore keeps entries, winners and the open state; garbage is ignored', () => {
  const g = new Giveaway();
  g.start({ keyword: 'Fifth', membersOnly: false });
  g.add([msg('a', 'fifth'), msg('b', 'fifth')]);
  g.draw();
  const r = new Giveaway();
  r.restore(JSON.parse(JSON.stringify(g)));
  assert.equal(r.open, true);
  assert.equal(r.entrants.size, 2);
  assert.equal(r.winners.length, 1);
  r.add([msg('c', 'FIFTH')]);
  assert.equal(r.entrants.size, 3, 'keyword matching works after a restore');
  for (const junk of [null, 42, 'x', { entrants: 'nope', winners: {} }]) {
    const j = new Giveaway();
    j.restore(junk);
    assert.equal(j.entrants.size, 0);
  }
});

// ---- End to end: real server + fake YouTube chat (60 viewers, every 3rd message has the keyword) ----
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(dir, port, fakePort) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'server.js')], {
    env: { ...process.env, PORT: String(port), UPDATE_CHECK: '0', SETTINGS_FILE: path.join(dir, 'settings.json'), STATE_FILE: path.join(dir, 'state.json'),
      NODE_OPTIONS: `--require ${path.join(__dirname, 'fixtures', 'fake-youtube.js')}`, FAKE_YT_PORT: String(fakePort),
      FAKE_YT_RATE: '20', FAKE_YT_CHAOS: '0.05', FAKE_YT_KEYWORD: 'FiFtH', YT_POLL_MS: '300', YT_TIMEOUT_MS: '2000', YT_BACKOFF_MS: '300' },
    stdio: 'ignore',
  });
  return { proc, stop: () => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill('SIGKILL'); }) };
}
const getState = (base) => new Promise((resolve, reject) => {
  const req = http.get(`${base}/events`, (res) => { let b = ''; res.on('data', (d) => { b += d; const m = b.match(/^data: (.+)$/m); if (m) { req.destroy(); resolve(JSON.parse(m[1])); } }); });
  req.on('error', reject);
});
const api = (base, body) => fetch(`${base}/api/giveaway`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

test('end to end: chat → entries → draw → restart keeps everything', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-ga-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ youtube: 'GIVEAWAY001' }));
  const port = await freePort(), fakePort = await freePort(), base = `http://localhost:${port}`;
  let srv = startServer(dir, port, fakePort);
  try {
    for (let i = 0; i < 60; i++) { try { await getState(base); break; } catch { await sleep(100); } }
    assert.equal((await api(base, { action: 'draw' })).error, 'No entries yet');
    assert.equal((await api(base, { action: 'start', keyword: '  ' })).status, 400);
    const opened = await api(base, { action: 'start', keyword: 'fifth' }); // case differs from the chat's "FiFtH"
    assert.equal(opened.ok, true);
    await sleep(6000);
    let s = await getState(base);
    assert.equal(s.giveaway.open, true);
    assert.ok(s.giveaway.count >= 20 && s.giveaway.count <= 60, `viewers who typed the keyword entered once each (${s.giveaway.count})`);
    assert.equal(s.giveaway.recent.length, 8);
    assert.ok(s.giveaway.recent.every((n) => /^@viewer\d+$/.test(n)));
    await api(base, { action: 'stop' });
    const closedCount = (await getState(base)).giveaway.count;
    await sleep(1500);
    assert.equal((await getState(base)).giveaway.count, closedCount, 'no entries after closing');
    const w1 = await api(base, { action: 'draw' });
    const w2 = await api(base, { action: 'draw' });
    assert.notEqual(w1.winner.authorId, w2.winner.authorId);
    s = await getState(base);
    assert.equal(s.giveaway.reveal.author, w2.winner.author, 'the TV shows the latest winner');
    assert.equal(s.giveaway.winners.length, 2);
    // Brutal restart: entries, winners and the reveal survive.
    await srv.stop();
    srv = startServer(dir, port, fakePort);
    for (let i = 0; i < 60; i++) { try { s = await getState(base); break; } catch { await sleep(100); } }
    assert.equal(s.giveaway.count, closedCount);
    assert.deepEqual(s.giveaway.winners.map((w) => w.author), [w1.winner.author, w2.winner.author]);
    const w3 = await api(base, { action: 'draw' });
    assert.ok(![w1, w2].some((w) => w.winner.authorId === w3.winner.authorId), 'still no repeat after a restart');
    await api(base, { action: 'hide' });
    assert.equal((await getState(base)).giveaway.reveal, null);
    await api(base, { action: 'reset' });
    s = await getState(base);
    assert.equal(s.giveaway.count, 0);
    assert.equal(s.giveaway.winners.length, 0);
  } finally { await srv.stop(); }
});
