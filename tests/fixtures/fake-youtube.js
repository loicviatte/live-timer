// Fake YouTube for end-to-end soak tests, loaded INTO the real server with:
//   NODE_OPTIONS="--require ./tests/fixtures/fake-youtube.js" node server.js
// It replaces fetch() for youtube.com: a live chat that keeps producing messages (with bursts)
// and randomly fails (hangs, HTTP errors, broken answers, silent stalls).
// Stats on http://localhost:$FAKE_YT_PORT/stats  (ids of every message ever posted).

const http = require('http');

const RATE = Number(process.env.FAKE_YT_RATE) || 8;          // messages per second on average
const CHAOS = Number(process.env.FAKE_YT_CHAOS ?? 0.12);      // share of requests that fail somehow
const realFetch = global.fetch;
const log = [];
const startedAt = Date.now();
let sessionId = 0, enabled = true;
const sessions = new Map();
const faults = {};

// Producer: steady flow + a burst of 40 messages every ~20 s.
setInterval(() => {
  const n = Math.floor(RATE / 10) + (Math.random() < (RATE / 10) % 1 ? 1 : 0);
  for (let i = 0; i < n; i++) log.push({ id: `e${startedAt % 1e6}_${log.length}`, at: Date.now() });
  if (Math.random() < 0.005) for (let i = 0; i < 40; i++) log.push({ id: `e${startedAt % 1e6}_${log.length}`, at: Date.now() });
}, 100).unref();

const fault = () => {
  if (!enabled || Math.random() > CHAOS) return null;
  const kinds = ['hang', 'http500', 'http429', 'badJson', 'noContents', 'stall', 'slow'];
  const k = kinds[Math.floor(Math.random() * kinds.length)];
  faults[k] = (faults[k] || 0) + 1;
  return k;
};

global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (!url.includes('youtube.com')) return realFetch(url, opts);
  const signal = opts.signal;
  const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const hang = () => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
  if (url.includes('/watch?v=')) {
    return reply(`{"liveBroadcastDetails":{"isLiveNow":true,"startTimestamp":"${new Date(startedAt - 3600e3).toISOString()}"}}`);
  }
  if (url.includes('/live_chat?v=')) {
    const f = fault();
    if (f === 'hang') return hang();
    if (f === 'http500' || f === 'http429') return reply('busy', 500);
    const token = `S${++sessionId}`;
    sessions.set(token, { cursor: Math.max(0, log.length - 75), stalled: false });
    const data = { contents: { liveChatRenderer: { header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [
      { continuation: { reloadContinuationData: { continuation: `${token}:top` } } },
      { continuation: { reloadContinuationData: { continuation: `${token}:0` } } },
    ] } } } } } } };
    return reply(`"INNERTUBE_API_KEY":"K","INNERTUBE_CLIENT_VERSION":"2"<script>var ytInitialData = ${JSON.stringify(data)};</script>`);
  }
  if (url.includes('get_live_chat')) {
    const [token, n] = JSON.parse(opts.body).continuation.split(':');
    const session = sessions.get(token) || { cursor: log.length, stalled: true };
    const f = fault();
    if (f === 'hang') return hang();
    if (f === 'http500' || f === 'http429') return reply('busy', f === 'http429' ? 429 : 500);
    if (f === 'badJson') return reply('{"continuationContents":');
    if (f === 'noContents') return reply({ responseContext: {} });
    if (f === 'stall') session.stalled = true;
    if (f === 'slow') await new Promise((r) => setTimeout(r, 1500));
    let actions = [];
    if (!session.stalled) {
      const items = log.slice(session.cursor);
      session.cursor = log.length;
      actions = items.map(({ id }) => ({ clickTrackingParams: 'x', addChatItemAction: { item: { liveChatTextMessageRenderer: {
        id, message: { runs: [{ text: `Message ${id} — the quick brown fox jumps over the lazy dog` }] },
        authorName: { simpleText: `@viewer${id.length}` }, authorExternalChannelId: 'UCx' } } } }));
    }
    return reply({ continuationContents: { liveChatContinuation: { actions,
      continuations: [{ invalidationContinuationData: { continuation: `${token}:${Number(n) + 1}`, timeoutMs: 10000 } }] } } });
  }
  return reply('not found', 404);
};

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url.startsWith('/calm')) enabled = false;
  if (req.url.startsWith('/chaos')) enabled = true;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ids: log.map((m) => m.id), times: log.map((m) => m.at), faults, sessions: sessionId }));
}).listen(Number(process.env.FAKE_YT_PORT) || 3013).unref();
