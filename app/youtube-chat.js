// Reads a YouTube live chat without an API key: mimics YouTube's "chat popout" page
// (fetches the page config, then polls the live_chat endpoint in a loop).
// Unofficial API: if YouTube changes its format, the TV screen falls back to the embedded YouTube chat.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// (the YT_* environment variables only exist to run the automated tests faster)
const POLL_MS = Number(process.env.YT_POLL_MS) || 2000;        // YouTube suggests ~10 s; we poll more often for a smooth chat
const KEEP = 60;                                                // messages kept for screens that connect midway
const TIMEOUT_MS = Number(process.env.YT_TIMEOUT_MS) || 15000; // a YouTube request that hangs must never freeze the chat
const BACKOFF_MS = Number(process.env.YT_BACKOFF_MS) || 3000;  // first retry delay after an error
// YouTube sometimes keeps answering "OK" on an old continuation while no longer sending messages.
// When the chat has been silent for much longer than usual, reopen a session (cheap: history is
// deduplicated). Adaptive: 4× the usual gap between messages, between STALL_MS/10 (busy chat, ~6 s)
// and STALL_MS (quiet chat), so a stall on a busy chat is caught before more messages pile up than
// YouTube replays on reconnect (~75).
const STALL_MS = Number(process.env.YT_STALL_MS) || 60000;
const STALL_MIN_MS = STALL_MS / 10;
const SEEN_MAX = 2000;  // ids already shown (a reconnect replays the backlog)

// fetch with a hard timeout.
function get(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

class YouTubeChat {
  constructor({ onAdd, onRemove, onStatus, onLive, onPoll }) {
    this.onAdd = onAdd;
    this.onPoll = onPoll;
    this.poll = null; // current poll (or recently ended)
    this.onRemove = onRemove;
    this.onStatus = onStatus;
    this.onLive = onLive;
    this.live = null; // { startWall }: live start time (wall clock, ms), if live now
    this.videoId = '';
    this.recent = [];
    this.seen = new Set();
    this.status = { state: 'off' };
    this.run = 0; // bumped on each start/stop to stop previous loops
    this.beat = Date.now(); // last sign of life of the reading loop (watched by the server)
  }

  // True when the reading loop has shown no sign of life for a while (it should beat every few seconds).
  isStuck(maxMs) {
    return !!this.videoId && Date.now() - this.beat > maxMs;
  }

  // Calls a listener without ever letting its error escape into the reading loop.
  emit(name, ...args) {
    try { this[name](...args); } catch (err) { console.error(`  [chat] ${name} failed:`, err?.message); }
  }

  setStatus(state, detail = '') {
    this.status = { state, detail };
    this.emit('onStatus', this.status);
  }

  // opts.force restarts the reader even for the same video (e.g. retry right away after an error).
  start(videoId, opts = {}) {
    if (videoId === this.videoId && !opts.force) return;
    const sameVideo = videoId === this.videoId;
    this.videoId = videoId;
    if (!sameVideo) {
      this.recent = [];
      this.seen = new Set();
    }
    if (!sameVideo) {
      this.setLive(null);
      this.setPoll(null);
    }
    const run = ++this.run;
    this.beat = Date.now();
    if (!videoId) return this.setStatus('off');
    this.loop(run);
    this.liveLoop(run);
  }

  setPoll(poll) {
    const prev = this.poll;
    if (poll?.closed) {
      // closedAt: when we saw it end. Polls only seen already ended (history replay) get none.
      const sameEnded = prev?.closed && prev.id === poll.id;
      poll = { ...poll, closedAt: sameEnded ? prev.closedAt : poll.stale ? null : Date.now() };
    }
    if (JSON.stringify(poll) === JSON.stringify(prev)) return;
    this.poll = poll;
    this.emit('onPoll', poll);
  }

  setLive(live) {
    if (JSON.stringify(live) === JSON.stringify(this.live)) return;
    this.live = live;
    this.emit('onLive', live);
  }

  // Live start time, read from the video page (refreshed every minute: live start, end…).
  async liveLoop(run) {
    while (run === this.run) {
      try {
        const res = await get(`https://www.youtube.com/watch?v=${this.videoId}`, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+' },
        });
        const json = (await res.text()).match(/"liveBroadcastDetails":(\{[^}]*\})/)?.[1];
        const d = json && JSON.parse(json);
        const startWall = d?.isLiveNow && Date.parse(d.startTimestamp);
        if (run === this.run) this.setLive(startWall ? { startWall } : null);
      } catch {}
      await sleep(60000);
    }
  }

  async loop(run) {
    let backoff = BACKOFF_MS;
    let quietReopen = false; // reopening after a silence: the chat is fine, don't show "connecting"
    while (run === this.run) {
      this.beat = Date.now();
      try {
        if (!quietReopen) this.setStatus('connecting');
        quietReopen = false;
        const session = await this.openSession(run);
        if (run !== this.run) return; // the link changed while we were connecting
        if (this.status.state !== 'ok') this.setStatus('ok');
        backoff = BACKOFF_MS;
        let cont = session.continuation;
        let backlog = true; // the first answer replays recent history
        let lastItemAt = Date.now();
        let gapAvg = STALL_MS / 10; // running average of the time between batches with messages
        while (run === this.run && cont) {
          this.beat = Date.now();
          const stallAfter = Math.min(STALL_MS, Math.max(STALL_MIN_MS, gapAvg * 4));
          if (Date.now() - lastItemAt > stallAfter) break; // silent far longer than usual: fresh session
          const res = await get(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${session.key}&prettyPrint=false`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
            body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: session.version } }, continuation: cont }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const lcc = (await res.json()).continuationContents?.liveChatContinuation;
          if (run !== this.run) return;
          if (lcc?.actions?.length) {
            const now = Date.now();
            if (!backlog) gapAvg = gapAvg * 0.8 + (now - lastItemAt) * 0.2;
            lastItemAt = now;
          }
          this.handleActions(lcc?.actions || [], { backlog });
          backlog = false;
          const c = lcc?.continuations?.[0];
          cont = (c?.invalidationContinuationData || c?.timedContinuationData || c?.reloadContinuationData)?.continuation;
          await sleep(POLL_MS);
        }
        if (run !== this.run) return;
        if (cont) { quietReopen = true; continue; } // silence: reopen right away, no status change
        throw new Error('The live stream seems to have ended');
      } catch (err) {
        if (run !== this.run) return;
        this.setStatus('error', err?.name === 'TimeoutError' ? 'YouTube did not answer (timeout)' : err?.message || String(err));
        this.beat = Date.now();
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MS * 10);
      }
    }
  }

  async openSession(run) {
    const res = await get(`https://www.youtube.com/live_chat?v=${this.videoId}&is_popout=1`, {
      // Consent cookies: avoids the "Before you continue" page in Europe.
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+' },
    });
    const html = await res.text();
    const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
    const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
    const json = html.match(/(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.+?\});\s*<\/script>/s)?.[1];
    const chat = json && JSON.parse(json).contents?.liveChatRenderer;
    if (/chat is disabled/i.test(html) && !chat) throw new Error('Chat is disabled for this live stream (YouTube setting)');
    if (!key || !version || !chat) throw new Error('Chat not found (stream not started, chat disabled or wrong link)');
    // "Top chat" / "Live chat" menu: take the 2nd one to get all messages.
    const menu = chat.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems || [];
    const continuation = (menu[1] || menu[0])?.continuation?.reloadContinuationData?.continuation
      || chat.continuations?.[0]?.invalidationContinuationData?.continuation
      || chat.continuations?.[0]?.timedContinuationData?.continuation;
    if (!continuation) throw new Error('Chat not found');
    // A poll already open when we connect lives in the page's action panel.
    const pr = findKey(chat.actionPanel, 'pollRenderer');
    if (pr && run === this.run) this.setPoll(parsePoll(pr, findKey(chat.actionPanel, 'id')));
    return { key, version, continuation };
  }

  handleActions(actions, { backlog = false } = {}) {
    const added = [];
    for (const a of actions) {
      if (!a || typeof a !== 'object') continue;
      // One odd item (YouTube format change) must not block the whole chat.
      try {
        const item = a.addChatItemAction?.item;
        const msg = item && parseItem(item);
        // Skip messages already shown (a reconnect replays the last ~75 messages).
        if (msg?.id && !this.seen.has(msg.id)) {
          this.seen.add(msg.id);
          added.push(msg);
        }
        this.handlePollAction(a);
        this.handlePollSummary(item, backlog);
        // Moderation: a deleted/removed message, or every message of a banned user.
        const del = a.markChatItemAsDeletedAction?.targetItemId || a.removeChatItemAction?.targetItemId;
        const bannedAuthor = a.markChatItemsByAuthorAsDeletedAction?.externalChannelId;
        const removed = [...added, ...this.recent]
          .filter((m) => m.id === del || (bannedAuthor && m.authorId === bannedAuthor)).map((m) => m.id);
        if (del && !removed.includes(del)) removed.push(del);
        for (const id of removed) {
          this.recent = this.recent.filter((m) => m.id !== id);
          const i = added.findIndex((m) => m.id === id);
          if (i >= 0) added.splice(i, 1);
          this.emit('onRemove', id);
        }
      } catch (err) {
        console.error('  [chat] skipped an unreadable item:', err.message);
      }
    }
    if (this.seen.size > SEEN_MAX) this.seen = new Set([...this.seen].slice(-SEEN_MAX / 2));
    if (!added.length) return;
    this.recent = [...this.recent, ...added].slice(-KEEP);
    this.emit('onAdd', added);
  }
}

// ---- Polls ----
// Open: showLiveChatActionPanelAction, votes: updateLiveChatPollAction,
// close: closeLiveChatActionPanelAction. We search "pollRenderer" deeply
// to absorb small variations in YouTube's format.
YouTubeChat.prototype.handlePollAction = function (action) {
  // Real actions also carry "clickTrackingParams", so look up the action type by name.
  const type = Object.keys(action).find((k) => k.endsWith('Action') || k.endsWith('Command'));
  if (type && /close.*ActionPanel/i.test(type)) {
    const target = action[type]?.targetPanelId;
    // panelId may be unknown (poll picked up from an update action): any close then ends it.
    if (this.poll && !this.poll.closed && (!target || !this.poll.panelId || target === this.poll.panelId)) {
      this.setPoll({ ...this.poll, closed: true });
    }
    return;
  }
  const pr = findKey(action, 'pollRenderer');
  if (!pr) return;
  const panelId = findKey(action, 'liveChatActionPanelRenderer')?.id || this.poll?.panelId;
  const poll = parsePoll(pr, panelId);
  // A late update of a poll that already ended must not reopen it.
  if (this.poll?.closed && this.poll.id === poll.id) poll.closed = true;
  this.setPoll(poll);
};

// Banner polls (addBannerToLiveChatCommand) have no "close" action: when they end, YouTube posts a
// system message in the chat with the results ("The Pro (80%)" … "Poll complete: 20 votes").
// When it comes from the replayed history (backlog), the poll ended a while ago: mark it "stale" so the
// TV doesn't pop old results up when the server (re)connects.
YouTubeChat.prototype.handlePollSummary = function (item, backlog = false) {
  const r = item?.liveChatViewerEngagementMessageRenderer;
  if (r?.icon?.iconType !== 'POLL') return;
  const runs = r.message?.runs || [];
  const question = runs.find((x) => x.bold)?.text?.trim() || '';
  const lines = runs.map((x) => x.text ?? '').join('').split('\n').map((l) => l.trim()).filter(Boolean);
  const choices = lines.map((l) => l.match(/^(.*)\((\d+(?:[.,]\d+)?)\s?%\)$/))
    .filter(Boolean).map((m) => ({ text: m[1].trim(), ratio: parseFloat(m[2].replace(',', '.')) / 100 }));
  const votes = lines.find((l) => /votes?\b/i.test(l) && !/%\)$/.test(l)) || '';
  if (!choices.length) return;
  // The results belong to the poll currently open (if any), even if the text differs slightly.
  const sameQuestion = this.poll && (!this.poll.closed || this.poll.question.trim() === question);
  // Already showing these results (history replayed after a reconnect): nothing to do.
  if (sameQuestion && this.poll.closed && backlog) return;
  this.setPoll({
    id: sameQuestion ? this.poll.id : r.id,
    panelId: this.poll?.panelId || null,
    question: question || this.poll?.question || '',
    meta: votes.replace(/^.*?:\s*/, ''), // "Poll complete: 20 votes" → "20 votes"
    choices,
    closed: true,
    stale: backlog,
  });
};

function parsePoll(pr, panelId) {
  const text = (t) => t?.simpleText ?? (t?.runs || []).map((r) => r.text ?? r.emoji?.emojiId ?? '').join('');
  const header = pr.header?.pollHeaderRenderer || {};
  const meta = text(header.metadataText);
  const choices = (pr.choices || []).map((c) => {
    const pct = text(c.votePercentage);
    const ratio = typeof c.voteRatio === 'number' ? c.voteRatio
      : pct ? parseFloat(pct.replace(',', '.')) / 100 : null;
    return { text: text(c.text), ratio: Number.isFinite(ratio) ? ratio : null };
  });
  return {
    id: pr.liveChatPollId || panelId || text(header.pollQuestion),
    panelId: panelId || null,
    question: text(header.pollQuestion),
    meta, // e.g. "My channel • 1 min ago • 42 votes"
    choices,
    closed: /ended|final|termin/i.test(meta),
  };
}

function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseItem(item) {
  const r = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
  if (!r) return null;
  const parts = (r.message?.runs || []).map((run) => {
    if (run.text != null) return { text: run.text };
    const e = run.emoji;
    if (!e) return null;
    if (!e.isCustomEmoji) return { text: e.emojiId };
    const thumbs = e.image?.thumbnails || [];
    return { img: thumbs[thumbs.length - 1]?.url, alt: e.shortcuts?.[0] || '' };
  }).filter(Boolean);
  const badges = (r.authorBadges || []).map((b) => b.liveChatAuthorBadgeRenderer?.icon?.iconType);
  return {
    id: r.id,
    authorId: r.authorExternalChannelId || null,
    author: r.authorName?.simpleText || '',
    role: badges.includes('OWNER') ? 'owner' : badges.includes('MODERATOR') ? 'moderator' : null,
    parts,
    amount: r.purchaseAmountText?.simpleText || null, // Super Chat
  };
}

// unref: these waits never keep the process alive on their own (the HTTP server does).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

module.exports = { YouTubeChat };
