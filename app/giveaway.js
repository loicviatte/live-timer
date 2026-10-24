// Giveaway from the live chat: while entries are open, everyone who writes the keyword in the chat
// is entered once; then winners are drawn at random (never the same person twice).

const crypto = require('crypto');

// Lowercase, no accents, so "Gâteau", "GATEAU" and "gateau" all match "gateau".
const normalize = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class Giveaway {
  constructor() {
    this.reset();
  }

  reset() {
    this.keyword = '';
    this.open = false;
    this.openedAt = null;    // wall clock (ms): messages posted before don't count
    this.membersOnly = false;
    this.requireMore = false; // the message must say more than the keyword (e.g. "CUP + your favourite couple")
    this.bannerText = '';     // custom "how to enter" text for the TV ('' = "type KEYWORD in the chat to enter")
    this.showBanner = true;  // "type KEYWORD in the chat" banner on the TV while entries are open
    this.entrants = new Map(); // authorId -> { author, at, text }
    this.winners = [];       // [{ authorId, author, at }]
    this.reveal = null;      // the draw shown on the TV: { author, drawnAt, pool } or null
    this.matcher = null;
  }

  setKeyword(keyword) {
    this.keyword = String(keyword || '').trim().slice(0, 40);
    const k = normalize(this.keyword);
    // Whole word (or the whole "!command"), anywhere in the message.
    this.matcher = k ? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(k)}($|[^\\p{L}\\p{N}])`, 'u') : null;
  }

  start({ keyword, membersOnly = false, showBanner = true, requireMore = false, bannerText = '' }, now = Date.now()) {
    this.setKeyword(keyword ?? this.keyword);
    if (!this.matcher) throw new Error('Choose a keyword first');
    this.membersOnly = !!membersOnly;
    this.requireMore = !!requireMore;
    this.bannerText = String(bannerText || '').trim().slice(0, 90);
    this.showBanner = showBanner !== false;
    this.open = true;
    this.openedAt = now;
  }

  stop() {
    this.open = false;
  }

  // Chat messages from the reader. Returns true when someone new was entered.
  add(messages) {
    if (!this.open || !this.matcher) return false;
    let added = false;
    for (const m of messages) {
      if (!m?.authorId || this.entrants.has(m.authorId)) continue;
      if (m.role === 'owner') continue;                      // the host doesn't enter their own giveaway
      if (this.membersOnly && !m.member) continue;
      if (m.at && m.at < this.openedAt - 2000) continue;     // replayed history from before the opening
      const raw = (m.parts || []).map((p) => p.text || '').join('');
      const text = normalize(raw);
      if (!this.matcher.test(text)) continue;
      // "CUP + your favourite couple": at least one real word besides the keyword.
      if (this.requireMore && !/\p{L}{2,}/u.test(text.replace(this.matcher, ' '))) continue;
      this.entrants.set(m.authorId, { author: m.author || 'Someone', at: m.at || Date.now(), text: raw.trim().slice(0, 200) });
      added = true;
    }
    return added;
  }

  // Fair draw among the entrants who haven't won yet.
  draw() {
    const won = new Set(this.winners.map((w) => w.authorId));
    const pool = [...this.entrants].filter(([id]) => !won.has(id));
    if (!pool.length) throw new Error(this.entrants.size ? 'Everyone has already won' : 'No entries yet');
    const [authorId, entry] = pool[crypto.randomInt(pool.length)];
    const winner = { authorId, author: entry.author, at: Date.now(), text: entry.text || '' };
    this.winners.push(winner);
    // A few other names for the "spinning" animation on the TV.
    // A few other random names for the "spinning" animation on the TV (sampled, not a full shuffle:
    // stays instant with tens of thousands of entries).
    const others = [], picked = new Set();
    const candidates = pool.length - 1;
    while (others.length < Math.min(24, candidates)) {
      const [id, e] = pool[crypto.randomInt(pool.length)];
      if (id === authorId || picked.has(id)) continue;
      picked.add(id);
      others.push(e.author);
    }
    this.reveal = { author: winner.author, drawnAt: winner.at, pool: others };
    return winner;
  }

  hideReveal() {
    this.reveal = null;
  }

  // What the screens get (the full entrant list stays on the server).
  publicState() {
    const recent = [...this.entrants.values()].slice(-8).reverse().map((e) => e.author);
    return {
      keyword: this.keyword, open: this.open, membersOnly: this.membersOnly, showBanner: this.showBanner,
      requireMore: this.requireMore, bannerText: this.bannerText, count: this.entrants.size, recent,
      // Winners' public channel page + their message: to check them and find them when they claim.
      winners: this.winners.map((w) => ({ author: w.author, at: w.at, text: w.text || '',
        channel: /^UC[\w-]{20,}$/.test(w.authorId) ? `https://www.youtube.com/channel/${w.authorId}` : null })),
      reveal: this.reveal,
    };
  }

  // Saved with the runtime state so a restart keeps every entry.
  toJSON() {
    return { keyword: this.keyword, open: this.open, openedAt: this.openedAt, membersOnly: this.membersOnly,
      requireMore: this.requireMore, bannerText: this.bannerText,
      showBanner: this.showBanner, entrants: [...this.entrants], winners: this.winners, reveal: this.reveal };
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    try {
      this.setKeyword(saved.keyword);
      this.open = !!saved.open && !!this.matcher;
      this.openedAt = Number(saved.openedAt) || null;
      this.membersOnly = !!saved.membersOnly;
      this.requireMore = !!saved.requireMore;
      this.bannerText = typeof saved.bannerText === 'string' ? saved.bannerText.slice(0, 90) : '';
      this.showBanner = saved.showBanner !== false;
      this.entrants = new Map(Array.isArray(saved.entrants) ? saved.entrants.filter((e) => Array.isArray(e) && e[0]) : []);
      this.winners = Array.isArray(saved.winners) ? saved.winners.filter((w) => w && w.authorId) : [];
      this.reveal = saved.reveal && typeof saved.reveal.author === 'string' ? saved.reveal : null;
    } catch { this.reset(); }
  }
}

// All entries as CSV (kept as a record of the draw, and to find a winner when they claim).
Giveaway.prototype.toCSV = function () {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const won = new Map(this.winners.map((w, i) => [w.authorId, i + 1]));
  const rows = [['entered_at', 'channel_name', 'channel_url', 'message', 'winner_rank']];
  for (const [id, e] of this.entrants) {
    rows.push([new Date(e.at).toISOString(), e.author, /^UC[\w-]{20,}$/.test(id) ? `https://www.youtube.com/channel/${id}` : '', e.text || '', won.get(id) || '']);
  }
  return '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'; // BOM: Excel reads the accents right
};

module.exports = { Giveaway, normalize };
