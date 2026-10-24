// YouTube chat reader tests, against a fake YouTube (no network): messages, reconnects, timeouts,
process.env.MONITOR = '0'; // never send real alerts from tests (child servers inherit this)
// moderation, both poll formats, history replay. Run with:  node --test tests/

process.env.YT_POLL_MS = '20';
process.env.YT_TIMEOUT_MS = '300';
process.env.YT_BACKOFF_MS = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const { YouTubeChat } = require('../app/youtube-chat');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 3000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(10); }
  assert.fail(`timed out waiting for ${what}`);
};

// ---- Fake YouTube ----
// script(): returns the actions of each get_live_chat call in turn. Special values:
//   'hang' (never answers), 500 (HTTP error), 'end' (no more continuation).
function fakeYouTube({ batches, pageActionPanel = null, live = true, pageFails = 0 }) {
  let call = 0, pageCalls = 0;
  const calls = { page: 0, chat: 0 };
  global.fetch = async (url, opts = {}) => {
    const signal = opts.signal;
    const answer = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    const hang = () => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason || new Error('aborted'))));
    if (url.includes('/watch?v=')) {
      return answer(live ? '<script>{"liveBroadcastDetails":{"isLiveNow":true,"startTimestamp":"2026-10-17T18:00:00+00:00"}}</script>' : '<html></html>');
    }
    if (url.includes('/live_chat?v=')) {
      calls.page++;
      if (pageCalls++ < pageFails) return answer('<html>no chat</html>');
      const data = { contents: { liveChatRenderer: {
        actionPanel: pageActionPanel,
        header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [
          { title: 'Top chat', continuation: { reloadContinuationData: { continuation: 'TOP' } } },
          { title: 'Live chat', continuation: { reloadContinuationData: { continuation: 'C0' } } },
        ] } } } },
      } } };
      return answer(`<script>ytcfg.set({"INNERTUBE_API_KEY":"KEY","INNERTUBE_CLIENT_VERSION":"2.0"});</script>
        <script>var ytInitialData = ${JSON.stringify(data)};</script>`);
    }
    if (url.includes('get_live_chat')) {
      calls.chat++;
      const step = batches[Math.min(call++, batches.length - 1)];
      if (step === 'hang') return hang();
      if (step === 500) return answer('oops', 500);
      const actions = typeof step === 'function' ? step() : step;
      const more = step !== 'end';
      return answer({ continuationContents: { liveChatContinuation: {
        actions: more ? actions : [],
        continuations: more ? [{ invalidationContinuationData: { continuation: `C${call}`, timeoutMs: 10000 } }] : [],
      } } });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return calls;
}

const msg = (id, text, extra = {}) => ({ clickTrackingParams: 'x', addChatItemAction: { item: { liveChatTextMessageRenderer: {
  id, message: { runs: [{ text }] }, authorName: { simpleText: `@user${id}` }, authorExternalChannelId: extra.author || `UC${id}`, ...extra.r,
} } } });
const pollRenderer = (id, ratios, votes) => ({ pollRenderer: { liveChatPollId: id,
  header: { pollHeaderRenderer: { pollQuestion: { runs: [{ text: 'Pro or celeb?' }] }, metadataText: { runs: [{ text: `@oti • 1 min ago • ${votes} votes` }] } } },
  choices: ['The Pro', 'The Celeb'].map((t, i) => ({ text: { runs: [{ text: t }] }, ...(ratios ? { voteRatio: ratios[i] } : {}) })) } });
const summary = (id, question, pcts, votes) => ({ clickTrackingParams: 'x', addChatItemAction: { item: { liveChatViewerEngagementMessageRenderer: {
  id, icon: { iconType: 'POLL' }, message: { runs: [{ text: question, bold: true }, { text: '\n' },
    ...pcts.flatMap(([t, p]) => [{ text: `${t} (${p}%)` }, { text: '\n' }]), { text: '\n' }, { text: `Poll complete: ${votes} votes` }] } } } } });

function reader() {
  const ev = { added: [], removed: [], polls: [], statuses: [], live: [] };
  const chat = new YouTubeChat({
    onAdd: (m) => ev.added.push(...m), onRemove: (id) => ev.removed.push(id),
    onStatus: (s) => ev.statuses.push(s), onLive: (l) => ev.live.push(l), onPoll: (p) => ev.polls.push(p),
  });
  return { chat, ev, stop: () => chat.start('') };
}

test('messages flow; a reconnect replaying history adds no duplicates', async () => {
  const history = [msg('a', 'hello'), msg('b', 'hi')];
  fakeYouTube({ batches: [history, [msg('c', 'new')], 500, history, [msg('d', 'after reconnect')], []] });
  const { chat, ev, stop } = reader();
  chat.start('VIDEOID0001');
  await waitFor(() => ev.added.some((m) => m.id === 'd'), 3000, 'message after reconnect');
  stop();
  assert.deepEqual(ev.added.map((m) => m.id), ['a', 'b', 'c', 'd'], 'each message exactly once, in order');
  assert.ok(ev.statuses.some((s) => s.state === 'error'), 'the HTTP 500 was reported');
  assert.equal(ev.statuses.at(-2)?.state ?? 'ok', 'ok');
  assert.ok(ev.live.some((l) => l?.startWall === Date.parse('2026-10-17T18:00:00+00:00')), 'live start time read');
});

test('a hanging YouTube request times out and the chat recovers', async () => {
  fakeYouTube({ batches: [[msg('a', 'x')], 'hang', [msg('b', 'y')], []] });
  const { chat, ev, stop } = reader();
  chat.start('VIDEOID0002');
  await waitFor(() => ev.added.some((m) => m.id === 'b'), 3000, 'chat to recover after a hang');
  stop();
  assert.ok(ev.statuses.some((s) => s.state === 'error'), 'timeout surfaced as an error');
});

test('chat not available yet (stream not started): keeps retrying, then works', async () => {
  fakeYouTube({ batches: [[msg('a', 'finally')], []], pageFails: 3 });
  const { chat, ev, stop } = reader();
  chat.start('VIDEOID0003');
  await waitFor(() => ev.added.length === 1, 3000, 'chat after retries');
  stop();
  assert.ok(ev.statuses.filter((s) => s.state === 'error').length >= 3);
});

test('moderation: deleted, removed and banned-author messages disappear', async () => {
  fakeYouTube({ batches: [
    [msg('a', 'ok'), msg('b', 'spam', { author: 'SPAMMER' }), msg('c', 'spam2', { author: 'SPAMMER' }), msg('d', 'bad'), msg('e', 'meh')],
    [{ clickTrackingParams: 'x', markChatItemAsDeletedAction: { targetItemId: 'd' } },
      { clickTrackingParams: 'x', removeChatItemAction: { targetItemId: 'e' } },
      { clickTrackingParams: 'x', markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'SPAMMER' } }],
    [],
  ] });
  const { chat, ev, stop } = reader();
  chat.start('VIDEOID0004');
  await waitFor(() => ev.removed.length >= 4, 3000, 'removals');
  const recent = chat.recent.map((m) => m.id);
  stop();
  assert.deepEqual(new Set(ev.removed), new Set(['b', 'c', 'd', 'e']));
  assert.deepEqual(recent, ['a'], 'only the clean message is kept for screens that connect later');
});

test('one unreadable action does not block the others', async () => {
  const evil = { clickTrackingParams: 'x', addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'z', message: { runs: 'not-an-array' } } } } };
  fakeYouTube({ batches: [[msg('a', '1'), evil, msg('b', '2')], []] });
  const { chat, ev, stop } = reader();
  const origError = console.error; console.error = () => {};
  chat.start('VIDEOID0005');
  await waitFor(() => ev.added.some((m) => m.id === 'b'), 2000, 'message after a broken one');
  console.error = origError;
  stop();
  assert.deepEqual(ev.added.map((m) => m.id), ['a', 'b']);
});

test('poll format 1 (action panel): open → votes → closed', async () => {
  fakeYouTube({ batches: [[], [
    { clickTrackingParams: 'x', showLiveChatActionPanelAction: { panelToShow: { liveChatActionPanelRenderer: { id: 'PANEL', contents: pollRenderer('P1', null, 0) } } } },
  ], [{ clickTrackingParams: 'x', updateLiveChatPollAction: { pollToUpdate: pollRenderer('P1', [0.75, 0.25], 4) } }],
  [{ clickTrackingParams: 'x', closeLiveChatActionPanelAction: { targetPanelId: 'PANEL', skipOnDismissCommand: true } }],
  [{ clickTrackingParams: 'x', updateLiveChatPollAction: { pollToUpdate: pollRenderer('P1', [0.75, 0.25], 4) } }], // late update
  []] });
  const { chat, ev, stop } = reader();
  chat.start('VIDEOID0006');
  await waitFor(() => ev.polls.some((p) => p?.closed), 3000, 'poll closed');
  await sleep(100);
  stop();
  const polls = ev.polls.filter(Boolean);
  assert.equal(polls[0].closed, false);
  assert.ok(polls.some((p) => !p.closed && p.choices[0].ratio === 0.75));
  const closed = polls.filter((p) => p.closed);
  assert.equal(closed.length, 1, 'closed once; the late update does not reopen it');
  assert.ok(closed[0].closedAt > Date.now() - 5000, 'end time stamped (TV shows results for 20 s)');
});

test('poll format 2 (banner + "Poll complete" message): open → votes → results', async () => {
  fakeYouTube({ batches: [[], [
    { clickTrackingParams: 'x', addBannerToLiveChatCommand: { bannerRenderer: { liveChatBannerRenderer: { contents: pollRenderer('P2', null, 18) } } } },
  ], [{ clickTrackingParams: 'x', updateLiveChatPollAction: { pollToUpdate: pollRenderer('P2', [0.8, 0.2], 20) } }],
  // The results message: question text slightly different (trailing space) must still match the open poll.
  [summary('M1', 'Pro or celeb? ', [['The Pro', 80], ['The Celeb', 20]], 20)],
  []] });
  const { chat, ev, stop } = reader();
  chat.start('VIDEOID0007');
  await waitFor(() => ev.polls.some((p) => p?.closed), 3000, 'banner poll results');
  stop();
  const closed = ev.polls.find((p) => p?.closed);
  assert.equal(closed.id, 'P2', 'same poll id: an admin "hide" stays in place');
  assert.deepEqual(closed.choices.map((c) => c.ratio), [0.8, 0.2]);
  assert.equal(closed.meta, '20 votes');
  assert.ok(closed.closedAt, 'end time stamped');
  assert.equal(closed.stale, false);
});

test('old poll results replayed from history are marked stale (not popped on the TV)', async () => {
  fakeYouTube({ batches: [[msg('a', 'x'), summary('OLD', 'Old question?', [['Yes', 60], ['No', 40]], 10)], [], []] });
  const { chat, ev, stop } = reader();
  chat.start('VIDEOID0008');
  await waitFor(() => ev.polls.some((p) => p?.closed), 2000, 'history poll');
  stop();
  const p = ev.polls.find((x) => x?.closed);
  assert.equal(p.stale, true);
  assert.equal(p.closedAt, null);
});

test('an open poll already on the page when connecting is picked up', async () => {
  fakeYouTube({ batches: [[], []], pageActionPanel: { liveChatActionPanelRenderer: { id: 'PANEL9', contents: pollRenderer('P9', [0.5, 0.5], 2) } } });
  const { chat, ev, stop } = reader();
  chat.start('VIDEOID0009');
  await waitFor(() => ev.polls.some((p) => p?.id === 'P9'), 2000, 'poll from page');
  stop();
});

test('switching the live link mid-connection: the old stream leaks nothing', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  fakeYouTube({ batches: [[msg('new', 'from new video')], []], pageActionPanel: { liveChatActionPanelRenderer: { id: 'X', contents: pollRenderer('OLDPOLL', null, 1) } } });
  const realFetch = global.fetch;
  let first = true;
  global.fetch = async (url, opts) => {
    if (first && url.includes('/live_chat?v=OLDVIDEO001')) { first = false; await gate; }
    return realFetch(url, opts);
  };
  const { chat, ev, stop } = reader();
  chat.start('OLDVIDEO001');
  await sleep(50);
  chat.start('NEWVIDEO001');
  release(); // the old page answers late
  await waitFor(() => ev.added.some((m) => m.id === 'new'), 2000, 'new video chat');
  await sleep(100);
  stop();
  assert.equal(chat.videoId, '');
  const statusesAfterSwitch = ev.statuses.slice(ev.statuses.findIndex((s) => s.state === 'connecting') + 1);
  assert.ok(statusesAfterSwitch.every((s) => s.state !== 'error'), 'no stray status from the old video');
});

test('live viewers: the "watching now" count is used, a total views count is ignored', () => {
  const { parseViewers } = require('../app/youtube-chat');
  const answer = (r) => ({ actions: [{ clickTrackingParams: 'x' }, { updateViewershipAction: { viewCount: { videoViewCountRenderer: r } } }] });
  assert.equal(parseViewers(answer({ isLive: true, originalViewCount: '16779', viewCount: { simpleText: '16,779 watching now' } })), 16779);
  assert.equal(parseViewers(answer({ originalViewCount: '33920', viewCount: { simpleText: '33,920 views' } })), null, 'not live: total views');
  assert.equal(parseViewers(answer({ isLive: true, originalViewCount: 'lots' })), null);
  assert.equal(parseViewers({}), null);
  assert.equal(parseViewers(null), null);
});
