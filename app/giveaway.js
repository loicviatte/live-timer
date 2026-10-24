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
    this.showBanner = true;  // "type KEYWORD in the chat" banner on the TV while entries are open
    this.entrants = new Map(); // authorId -> { author, at }
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

  start({ keyword, membersOnly = false, showBanner = true }, now = Date.now()) {
    this.setKeyword(keyword ?? this.keyword);
    if (!this.matcher) throw new Error('Choose a keyword first');
    this.membersOnly = !!membersOnly;
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
      const text = normalize((m.parts || []).map((p) => p.text || '').join(''));
      if (!this.matcher.test(text)) continue;
      this.entrants.set(m.authorId, { author: m.author || 'Someone', at: m.at || Date.now() });
      added = true;
    }
    return added;
  }

  // Fair draw among the entrants who haven't won yet.
  draw() {
    const pool = [...this.entrants].filter(([id]) => !this.winners.some((w) => w.authorId === id));
    if (!pool.length) throw new Error(this.entrants.size ? 'Everyone has already won' : 'No entries yet');
    const [authorId, entry] = pool[crypto.randomInt(pool.length)];
    const winner = { authorId, author: entry.author, at: Date.now() };
    this.winners.push(winner);
    // A few other names for the "spinning" animation on the TV.
    const others = pool.filter(([id]) => id !== authorId).map(([, e]) => e.author);
    for (let i = others.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [others[i], others[j]] = [others[j], others[i]]; }
    this.reveal = { author: winner.author, drawnAt: winner.at, pool: others.slice(0, 24) };
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
      count: this.entrants.size, recent, winners: this.winners.map((w) => ({ author: w.author, at: w.at })),
      reveal: this.reveal,
    };
  }

  // Saved with the runtime state so a restart keeps every entry.
  toJSON() {
    return { keyword: this.keyword, open: this.open, openedAt: this.openedAt, membersOnly: this.membersOnly,
      showBanner: this.showBanner, entrants: [...this.entrants], winners: this.winners, reveal: this.reveal };
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    try {
      this.setKeyword(saved.keyword);
      this.open = !!saved.open && !!this.matcher;
      this.openedAt = Number(saved.openedAt) || null;
      this.membersOnly = !!saved.membersOnly;
      this.showBanner = saved.showBanner !== false;
      this.entrants = new Map(Array.isArray(saved.entrants) ? saved.entrants.filter((e) => Array.isArray(e) && e[0]) : []);
      this.winners = Array.isArray(saved.winners) ? saved.winners.filter((w) => w && w.authorId) : [];
      this.reveal = saved.reveal && typeof saved.reveal.author === 'string' ? saved.reveal : null;
    } catch { this.reset(); }
  }
}

module.exports = { Giveaway, normalize };
