// Chat endurance test: thousands of polling cycles against a fake YouTube that keeps producing
process.env.MONITOR = '0'; // never send real alerts from tests (child servers inherit this)
// messages while failing in every way we can think of. Every message must arrive, exactly once,
// and the flow must never stay stuck. Run with:  node --test tests/

process.env.YT_POLL_MS = '2';
process.env.YT_TIMEOUT_MS = '60';
process.env.YT_BACKOFF_MS = '5';
process.env.YT_STALL_MS = '120';

const test = require('node:test');
const assert = require('node:assert/strict');
const { YouTubeChat } = require(process.env.TEST_CHAT || '../app/youtube-chat');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic randomness (same run every time).
function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

// A fake YouTube live chat with a growing message log and a chaos schedule.
function chaosYouTube({ seed, chaos }) {
  const rand = rng(seed);
  const log = [];          // every message ever posted
  const stats = { calls: 0, sessions: 0, faults: {} };
  let sessionId = 0;
  const sessions = new Map(); // token -> { cursor, stalled }
  let enabled = true;

  const produce = () => {
    const n = Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) log.push(`m${log.length}`);
  };
  const fault = (name) => { stats.faults[name] = (stats.faults[name] || 0) + 1; return name; };
  const pick = () => {
    if (!enabled) return 'ok';
    const r = rand();
    let acc = 0;
    for (const [name, p] of Object.entries(chaos)) { acc += p; if (r < acc) return fault(name); }
    return 'ok';
  };

  global.fetch = async (url, opts = {}) => {
    const signal = opts.signal;
    const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    const hang = () => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    produce();
    if (url.includes('/watch?v=')) return reply('<html></html>');
    if (url.includes('/live_chat?v=')) {
      const mode = pick();
      if (mode === 'hang') return hang();
      if (mode === 'http500' || mode === 'http429') return reply('busy', mode === 'http429' ? 429 : 500);
      if (mode === 'garbage') return reply('<html>Before you continue to YouTube</html>');
      stats.sessions++;
      const token = `S${++sessionId}`;
      // A new session replays recent history (like YouTube's ~75 last messages).
      sessions.set(token, { cursor: Math.max(0, log.length - 150), stalled: false });
      const data = { contents: { liveChatRenderer: { header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [
        { continuation: { reloadContinuationData: { continuation: `${token}:top` } } },
        { continuation: { reloadContinuationData: { continuation: `${token}:0` } } },
      ] } } } } } } };
      return reply(`"INNERTUBE_API_KEY":"K","INNERTUBE_CLIENT_VERSION":"2"<script>var ytInitialData = ${JSON.stringify(data)};</script>`);
    }
    if (url.includes('get_live_chat')) {
      stats.calls++;
      const { continuation } = JSON.parse(opts.body);
      const [token, n] = continuation.split(':');
      const session = sessions.get(token);
      const mode = pick();
      if (mode === 'hang') return hang();
      if (mode === 'http500' || mode === 'http429' || mode === 'http403') return reply('nope', Number(mode.slice(4)));
      if (mode === 'badJson') return reply('{"continuationContents": ');
      if (mode === 'noContents') return reply({ responseContext: {} }); // 200 but nothing usable
      if (mode === 'ended') return reply({ continuationContents: { liveChatContinuation: { actions: [], continuations: [] } } });
      if (mode === 'stall') session.stalled = true; // from now on this session answers "OK" with nothing
      if (mode === 'slow') await sleep(30);
      const next = `${token}:${Number(n) + 1}`;
      let actions = [];
      if (!session.stalled) {
        const ids = log.slice(session.cursor);
        session.cursor = log.length;
        actions = ids.map((id) => ({ clickTrackingParams: 'x', addChatItemAction: { item: { liveChatTextMessageRenderer: {
          id, message: { runs: [{ text: `text ${id}` }] }, authorName: { simpleText: '@a' }, authorExternalChannelId: 'UC1' } } } }));
        if (mode === 'malformed') actions.splice(Math.floor(actions.length / 2), 0, { addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'bad', message: { runs: 42 } } } } });
      }
      return reply({ continuationContents: { liveChatContinuation: { actions,
        continuations: [{ invalidationContinuationData: { continuation: next, timeoutMs: 10000 } }] } } });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { log, stats, calm: () => { enabled = false; } };
}

async function soak({ seed, chaos, cycles, throwingListener = false }) {
  const yt = chaosYouTube({ seed, chaos });
  const delivered = [];
  let longestGap = 0, lastDelivery = Date.now();
  const chat = new YouTubeChat({
    onAdd: (msgs) => {
      const t = Date.now();
      longestGap = Math.max(longestGap, t - lastDelivery);
      lastDelivery = t;
      delivered.push(...msgs.map((m) => m.id));
      if (throwingListener && Math.random() < 0.2) throw new Error('screen push failed'); // e.g. a broken socket
    },
    onRemove() {}, onLive() {}, onPoll() {},
    onStatus() { if (throwingListener && Math.random() < 0.2) throw new Error('status push failed'); },
  });
  const origError = console.error; console.error = () => {};
  try {
    chat.start('SOAKVIDEO01');
    while (yt.stats.calls < cycles) await sleep(20);
    // Chaos stops: everything posted so far must arrive quickly.
    yt.calm();
    const target = yt.log.length;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !yt.log.slice(0, target).every((id) => delivered.includes(id))) await sleep(20);
  } finally {
    chat.start('');
    console.error = origError;
  }
  const missing = yt.log.filter((id) => !delivered.includes(id));
  const dupes = delivered.length - new Set(delivered).size;
  return { yt, delivered, missing, dupes, longestGap };
}

const CHAOS = { hang: 0.03, http500: 0.03, http429: 0.02, http403: 0.01, badJson: 0.02, noContents: 0.02,
  ended: 0.01, stall: 0.02, slow: 0.05, garbage: 0.02, malformed: 0.03 };

test('4000 cycles of chaos: every message arrives exactly once, flow never stuck', async () => {
  const r = await soak({ seed: 42, chaos: CHAOS, cycles: 4000 });
  assert.ok(r.yt.log.length > 3000, `enough traffic (${r.yt.log.length} messages)`);
  assert.deepEqual(r.missing, [], `${r.missing.length} messages lost`);
  assert.equal(r.dupes, 0, 'no duplicates');
  assert.equal(r.delivered.join(), r.yt.log.join(), 'in posting order');
  assert.ok(r.longestGap < 2000, `longest gap without messages: ${r.longestGap} ms`);
  const faults = Object.values(r.yt.stats.faults).reduce((a, b) => a + b, 0);
  assert.ok(faults > 500, `chaos really happened (${faults} faults: ${JSON.stringify(r.yt.stats.faults)})`);
});

test('YouTube silently stops sending (stall) very often: the reader recovers by itself', async () => {
  // 3% of the answers start a silent stall (in real life it's rare): nothing may be lost.
  const r = await soak({ seed: 7, chaos: { stall: 0.03 }, cycles: 1500 });
  assert.deepEqual(r.missing, []);
  assert.equal(r.dupes, 0);
  assert.ok(r.yt.stats.sessions > 10, `sessions reopened after stalls (${r.yt.stats.sessions})`);
});

test('screens/listeners that throw never stop the reader', async () => {
  const r = await soak({ seed: 99, chaos: CHAOS, cycles: 2000, throwingListener: true });
  assert.deepEqual(r.missing, []);
  assert.equal(r.dupes, 0);
});

test('a burst of 2000 messages in one answer is delivered and memory stays bounded', async () => {
  const chat = new YouTubeChat({ onAdd() {}, onRemove() {}, onLive() {}, onPoll() {}, onStatus() {} });
  const ids = Array.from({ length: 2000 }, (_, i) => `b${i}`);
  for (let round = 0; round < 10; round++) {
    chat.handleActions(ids.map((id) => ({ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: `${round}-${id}`, message: { runs: [{ text: 'x' }] } } } } })));
  }
  assert.ok(chat.recent.length <= 60, 'messages kept for new screens stay capped');
  assert.ok(chat.seen.size <= 2000, `dedupe memory capped (${chat.seen.size})`);
});
