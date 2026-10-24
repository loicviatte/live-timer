// Shared speaker/admin logic: server sync, tick aligned to the second, full-screen rendering.
window.Chrono = (function () {
  // Condensed font = taller digits at equal width (available on iPadOS and macOS).
  const FONT = "'HelveticaNeue-CondensedBlack', 'AvenirNextCondensed-Heavy', 'Avenir Next Condensed', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";
  const FLASH_MS = 1200;    // blink duration on each color change
  const FLASH_PERIOD = 150; // flash / normal alternation

  let state = {
    status: 'idle', startedAt: null, pausedElapsed: 0,
    settings: { duration: 120000, baseColor: '#111111', steps: [], flash: true },
  };
  let offset = 0; // server clock - local clock
  let synced = false;
  let connected = false;
  const listeners = new Set();
  const chatListeners = new Set();

  // Monotonic local clock: unaffected by system time changes.
  const localNow = () => performance.timeOrigin + performance.now();
  const serverNow = () => localNow() + offset;

  // ONE server connection per page (timer state + chat events when opts.chat).
  // A watchdog reopens it if it dies silently (Wi-Fi blip, iPad sleep, server restart).
  let es = null;
  let lastMessageAt = 0;
  let pageBuild = null; // version of the server code this page was loaded with
  function connect(opts = {}) {
    const url = opts.chat ? '/events?chat=1' : '/events';
    const open = () => {
      if (es) es.close();
      es = new EventSource(url);
      lastMessageAt = Date.now();
      es.onmessage = (e) => {
        lastMessageAt = Date.now();
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        // Rough estimate until syncClock runs. A jump of more than 1 s (server restarted, iPad back from
        // sleep) means our offset is wrong: re-seed it right away, then refine.
        const rough = data.serverNow - localNow();
        if (!synced || Math.abs(rough - offset) > 1000) {
          offset = rough;
          bestRtt = Infinity;
          if (synced) syncClock();
        }
        // The server was updated since this page was loaded: reload to get the new code.
        if (data.build) {
          if (pageBuild && data.build !== pageBuild) { location.reload(); return; }
          pageBuild = data.build;
        }
        state = data;
        connected = true;
        tick();
      };
      es.addEventListener('chat', (e) => {
        lastMessageAt = Date.now();
        let ev;
        try { ev = JSON.parse(e.data); } catch { return; }
        chatListeners.forEach((fn) => { try { fn(ev); } catch (err) { console.error(err); } });
      });
      es.onerror = () => { connected = false; tick(); };
      es.onopen = syncClock;
    };
    open();
    // The server pings every 5 s: 12 s of silence (or a closed stream) means the connection is dead.
    setInterval(() => {
      if (es.readyState === EventSource.CLOSED || Date.now() - lastMessageAt > 12000) {
        connected = false;
        tick();
        open();
      }
    }, 3000);
    setInterval(syncClock, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      syncClock();
      if (Date.now() - lastMessageAt > 6000) open(); // back from sleep: don't wait for the watchdog
    });
  }

  // Simplified NTP: several round trips, keep the one with the smallest RTT.
  let syncing = false;
  let bestRtt = Infinity, bestAt = 0; // quality of the offset in use
  async function syncClock() {
    if (syncing) return;
    syncing = true;
    try { await doSync(); } finally { syncing = false; }
  }
  async function doSync() {
    let best = null;
    for (let i = 0; i < 6; i++) {
      try {
        const t0 = localNow();
        const res = await fetch('/api/time', { cache: 'no-store', signal: AbortSignal.timeout?.(3000) });
        const text = await res.text();
        const t1 = localNow();
        const s = JSON.parse(text).serverNow;
        if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: s - (t0 + t1) / 2 };
      } catch { /* keep the samples we already have */ }
    }
    if (!best) { setTimeout(syncClock, 1000); return; } // network not back yet (e.g. iPad waking up)
    // Keep a better measurement unless the new one is comparable or ours is getting old.
    const fresh = Date.now() - bestAt > 120000;
    if (best.rtt <= bestRtt * 1.5 + 5 || fresh || !synced) {
      offset = best.offset;
      bestRtt = best.rtt;
      bestAt = Date.now();
    }
    synced = true;
    tick();
  }

  function remainingMs() {
    const { duration } = state.settings;
    if (state.status === 'idle') return duration;
    if (state.status === 'paused') return duration - state.pausedElapsed;
    return duration - (serverNow() - state.startedAt);
  }

  // Time until the displayed second changes (Infinity when the timer isn't running).
  function msUntilNextSecond() {
    if (state.status !== 'running') return Infinity;
    return ((remainingMs() % 1000) + 1000) % 1000;
  }

  // 2:00 → 0:01 → 0:00 → −0:01 … each label lasts exactly 1 s.
  function format(ms) {
    const neg = ms < 0;
    const s = neg ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
    const txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    return neg && s > 0 ? `−${txt}` : txt;
  }

  // Active step: the lowest one whose threshold is reached (steps sorted by `at` descending).
  function stepFor(ms) {
    const { steps, baseColor } = state.settings;
    let step = { index: -1, color: baseColor };
    steps.forEach((st, index) => { if (ms <= st.at) step = { index, color: st.color }; });
    return step;
  }

  // Black text on light backgrounds, white on dark ones.
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const textColor = (bg) => (luminance(bg) > 0.18 ? '#111111' : '#ffffff');

  // The next render is scheduled exactly when the label changes
  // (multiple of 1000 ms of remaining time), instead of polling.
  let timer = null;
  let lastStepKey = null;
  let flashStart = -Infinity;
  function tick() {
    clearTimeout(timer);
    const ms = remainingMs();
    const running = state.status === 'running';
    const active = state.status !== 'idle'; // when paused, keep the step color
    const step = active ? stepFor(ms) : { index: -1, color: state.settings.baseColor };

    // Flash only when the step changes within the same run (not on GO, nor on load).
    // (startedAt changes when resuming from pause → no flash on resume)
    const stepKey = active ? `${state.startedAt}:${step.index}` : null;
    if (stepKey && lastStepKey && stepKey !== lastStepKey
        && lastStepKey.startsWith(`${state.startedAt}:`) && state.settings.flash) {
      flashStart = localNow();
    }
    lastStepKey = stepKey;

    const sinceFlash = localNow() - flashStart;
    const flashing = active && sinceFlash < FLASH_MS;
    let colors = [step.color, textColor(step.color)];
    if (flashing && Math.floor(sinceFlash / FLASH_PERIOD) % 2 === 0) {
      // "Flash" frame: white background, digits in the new color (black if the color is already light).
      colors = luminance(step.color) > 0.8 ? ['#000000', step.color] : ['#ffffff', step.color];
    }

    const view = { ms, label: format(ms), step: step.index, colors, flashing, connected, paused: state.status === 'paused' };
    // One failing listener must never stop the timer: the next tick is always scheduled.
    listeners.forEach((fn) => { try { fn(view); } catch (err) { console.error(err); } });

    let delay = 1000;
    if (running) delay = Math.ceil(((ms % 1000) + 1000) % 1000 || 1000) + 1;
    if (flashing) delay = Math.min(delay, Math.ceil(FLASH_PERIOD - (sinceFlash % FLASH_PERIOD)) + 1);
    timer = setTimeout(tick, delay);
  }

  // ---- Rendering: largest possible text in the canvas ----
  let metricsCache = null;
  function metrics(ctx) {
    if (metricsCache) return metricsCache;
    ctx.font = `900 100px ${FONT}`;
    let digit = 0, asc = 0, desc = 0;
    for (const d of '0123456789') {
      const m = ctx.measureText(d);
      digit = Math.max(digit, m.width);
      asc = Math.max(asc, m.actualBoundingBoxAscent);
      desc = Math.max(desc, m.actualBoundingBoxDescent);
    }
    return (metricsCache = { digit, asc, desc, colon: ctx.measureText(':').width, minus: ctx.measureText('−').width });
  }

  // opts.w / opts.h = share of width / height taken by the digits' ink.
  // opts.stacked = minutes above seconds (column layout, e.g. TV screen with chat).
  function draw(canvas, label, colors, opts = {}) {
    const { w = 0.98, h = 0.96, stacked = false } = opts;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors[0];
    ctx.fillRect(0, 0, W, H);

    const m = metrics(ctx);
    // Fixed-width digits: the size doesn't shift when the digits change.
    const adv = (c) => (c >= '0' && c <= '9' ? m.digit : c === ':' ? m.colon : m.minus);
    const lines = (stacked ? label.split(':') : [label]).map((l) => [...l]);
    const width = (chars) => chars.reduce((sum, c) => sum + adv(c), 0);
    const inkH = m.asc + m.desc;
    const GAP = 0.14; // gap between lines, as a fraction of digit height
    const blockH = lines.length * inkH + (lines.length - 1) * GAP * inkH;
    const k = Math.min((W * w) / Math.max(...lines.map(width)), (H * h) / blockH);

    ctx.font = `900 ${100 * k}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = colors[1];
    let top = (H - blockH * k) / 2;
    for (const chars of lines) {
      let x = (W - width(chars) * k) / 2;
      const y = top + m.asc * k;
      for (const c of chars) {
        ctx.fillText(c, x + (adv(c) * k) / 2, y);
        x += adv(c) * k;
      }
      top += (1 + GAP) * inkH * k;
    }
  }

  // ---- Message to host: dark overlay + giant text on top of everything ----
  function mountHostMessage() {
    const style = document.createElement('style');
    style.textContent = `
      #hostMsg {
        position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, .62); opacity: 0; visibility: hidden; pointer-events: none;
        transition: opacity .25s, visibility .25s;
      }
      #hostMsg.show { opacity: 1; visibility: visible; }
      #hostMsg .box {
        background: #000; color: #fff; border: .05em solid #fff; border-radius: .22em;
        padding: .3em .55em; text-align: center; line-height: 1.1;
        font: 800 40px -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
        white-space: pre-wrap; overflow-wrap: break-word; box-shadow: 0 .2em 1em rgba(0,0,0,.6);
      }
      #hostMsg .box.blink { animation: hostBlink .3s 6; }
      @keyframes hostBlink {
        0%, 49.9% { background: #fff; color: #000; border-color: #000; }
        50%, 100% { background: #000; color: #fff; border-color: #fff; }
      }`;
    const root = document.createElement('div');
    root.id = 'hostMsg';
    root.setAttribute('role', 'alert');
    const box = document.createElement('div');
    box.className = 'box';
    root.append(box);
    document.head.append(style);
    document.body.append(root);

    // Largest font size that fits in 86% × 72% of the screen.
    function fit() {
      if (!root.classList.contains('show')) return;
      const maxW = innerWidth * 0.86, maxH = innerHeight * 0.72;
      box.style.maxWidth = `${maxW}px`;
      let lo = 12, hi = innerHeight * 0.45;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        box.style.fontSize = `${mid}px`;
        if (box.scrollHeight <= maxH && box.scrollWidth <= maxW) lo = mid; else hi = mid;
      }
      box.style.fontSize = `${lo}px`;
    }

    let shownId = null;
    listeners.add(() => {
      const m = state.message;
      if (!m) {
        if (shownId !== null) { root.classList.remove('show'); shownId = null; }
        return;
      }
      if (m.id === shownId) return;
      shownId = m.id;
      box.textContent = m.text;
      root.classList.add('show');
      fit();
      box.classList.remove('blink');
      void box.offsetWidth; // restart the animation for a new message
      if (m.blink) box.classList.add('blink');
    });
    window.addEventListener('resize', fit);
  }

  // ---- "● LIVE 1:26:05" badge in the top corner (YouTube live duration) ----
  function mountLiveBadge() {
    const style = document.createElement('style');
    style.textContent = `
      #liveTime {
        position: fixed; top: 1vw; left: 1vw; z-index: 10;
        display: flex; align-items: center; gap: .4em;
        padding: .25em .55em; border-radius: .3em; background: #e5002b; color: #fff;
        font: 800 3.3vw -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
        font-variant-numeric: tabular-nums; line-height: 1.1; box-shadow: 0 .1em .5em rgba(0,0,0,.25);
      }
      #liveTime[hidden] { display: none; }
      #liveTime .dot { width: .45em; height: .45em; border-radius: 50%; background: #fff; animation: livePulse 2s infinite; }
      @keyframes livePulse { 50% { opacity: .35; } }`;
    const box = document.createElement('div');
    box.id = 'liveTime';
    box.hidden = true;
    box.setAttribute('aria-label', 'Live stream duration');
    box.innerHTML = '<span class="dot"></span><span>LIVE</span><span class="clock">0:00</span>';
    document.head.append(style);
    document.body.append(box);
    const clock = box.querySelector('.clock');

    setInterval(() => {
      const { liveStartedAt } = state;
      const hidden = !(liveStartedAt && state.settings.youtube);
      if (hidden !== box.hidden) {
        box.hidden = hidden;
        // Pages can reserve space for the badge (live-on class), then the timer is redrawn.
        document.body.classList.toggle('live-on', !hidden);
        requestAnimationFrame(tick);
      }
      if (!hidden) clock.textContent = formatLong(serverNow() - liveStartedAt);
    }, 250);
  }

  // ---- YouTube poll card (TV + admin). Size follows the container's font-size. ----
  let pollStyled = false;
  // While voting: question + number of voters only (opts.liveResults also shows the bars, for the admin).
  // Once the poll ends: the card expands to reveal the results.
  function renderPoll(el, poll, opts = {}) {
    if (!pollStyled) {
      pollStyled = true;
      const style = document.createElement('style');
      style.textContent = `
        .poll-card { background: #111; color: #fff; border-radius: .35em; padding: .55em .7em .65em; line-height: 1.15;
          box-shadow: 0 .2em .9em rgba(0,0,0,.3); font-family: -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif; }
        .poll-card .label { font-size: .5em; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: #9ec1ff; }
        .poll-card.closed .label { color: #ffd60a; }
        .poll-card .question { font-weight: 800; margin: .2em 0 .3em; overflow-wrap: anywhere; }
        .poll-card .votes { font-size: .75em; font-weight: 700; color: #cfcfcf; font-variant-numeric: tabular-nums; }
        .poll-card .results { display: grid; grid-template-rows: 1fr; margin-top: .2em; }
        .poll-card .results.reveal { animation: pollExpand .7s cubic-bezier(.2,.8,.2,1); }
        .poll-card .results > div { overflow: hidden; }
        @keyframes pollExpand { from { grid-template-rows: 0fr; opacity: 0; } }
        .poll-card .choice { position: relative; border-radius: .25em; background: #2a2a2a; padding: .18em .45em; margin-top: .25em;
          overflow: hidden; font-size: .82em; font-weight: 700; }
        .poll-card .bar { position: absolute; inset: 0 auto 0 0; background: #2563eb; }
        .poll-card .results.reveal .bar { animation: pollBar 1s .3s cubic-bezier(.2,.8,.2,1) backwards; }
        @keyframes pollBar { from { width: 0; } }
        .poll-card .choice > span { position: relative; display: flex; justify-content: space-between; gap: .8em; }
        .poll-card .choice b { font-variant-numeric: tabular-nums; }
        .poll-card.closed .choice.win .bar { background: #16a34a; }`;
      document.head.append(style);
    }
    const make = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? '' });
    const votes = poll.meta.match(/[\d\s.,]+(?:\s?[kKmM])?\s*votes?/)?.[0].trim() || 'No votes yet';
    const hasRatios = poll.choices.some((c) => c.ratio != null);
    const best = Math.max(...poll.choices.map((c) => c.ratio ?? 0));
    const showResults = poll.closed || opts.liveResults;

    const parts = [
      make('div', 'label', poll.closed ? '📊 Poll results' : '📊 Live poll'),
      make('div', 'question', poll.question),
      make('div', 'votes', `👥 ${votes}`),
    ];
    if (showResults) {
      const rows = poll.choices.map((c) => {
        const pct = Math.round((c.ratio ?? 0) * 100);
        const row = make('div', `choice ${hasRatios && c.ratio === best && best > 0 ? 'win' : ''}`);
        const bar = make('div', 'bar');
        bar.style.width = `${pct}%`;
        const txt = document.createElement('span');
        txt.append(make('span', '', c.text));
        if (hasRatios) txt.append(make('b', '', `${pct} %`));
        row.append(bar, txt);
        return row;
      });
      const inner = document.createElement('div');
      inner.append(...rows);
      // Animate only when the results first appear (poll just ended), not on every refresh.
      const reveal = poll.closed && el.dataset.pollState !== `${poll.id}:closed`;
      const results = make('div', `results ${reveal ? 'reveal' : ''}`);
      results.append(inner);
      parts.push(results);
    }
    el.dataset.pollState = `${poll.id}:${poll.closed ? 'closed' : 'open'}`;
    el.classList.add('poll-card');
    el.classList.toggle('closed', !!poll.closed);
    el.replaceChildren(...parts);
  }

  // Live duration: 1:26:05 (or 12:34 if under an hour).
  function formatLong(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  return {
    connect, remainingMs, msUntilNextSecond, format, formatLong, stepFor, textColor, draw, serverNow, mountHostMessage, mountLiveBadge, renderPoll,
    onTick: (fn) => listeners.add(fn),
    onChat: (fn) => chatListeners.add(fn),
    refresh: tick,
    get state() { return state; },
    get connected() { return connected; },
    // Never throws: resolves to { ok: false } when the server can't be reached.
    post: (action, body = {}) => fetch(`/api/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout?.(5000),
    }).catch(() => ({ ok: false })),
  };
})();
