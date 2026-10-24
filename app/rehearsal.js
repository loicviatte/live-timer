// Rehearsal: a practice giveaway fed by fake viewers, entirely separate from the real one.
// Nothing reaches the TV, the iPad, the chat or the real giveaway: only the admin page polls it.

const { Giveaway } = require('./giveaway');

const NAMES = ['StrictlyFan_Jo', 'Kelly in Leeds', 'GlitterBall Gran', 'Tom W', 'Priya Dances', 'Big Paul', 'Sophie R',
  'Ballroom Ben', 'Nana Maureen', 'Liam', 'Ellie Watson', 'Chloé', 'Dave from Hull', 'Aisha', 'Mark & Sue', 'Rosie',
  'Fifth Judge Fan', 'Jamie T', 'Hannah', 'Gareth', 'Lucy Loves Latin', 'Owen', 'Megan', 'Raj', 'Sam'];
const COUPLES = ['Ellie & Vito', 'Tasha & Aljaž', 'Sam & Lauren', 'Chris & Dianne', 'Layton & Nikita', 'Jamie & Karen',
  'Sarah & Vito', 'Pete & Jowita'];

class Rehearsal {
  constructor() {
    this.giveaway = new Giveaway();
    this.feed = [];   // last fake chat messages, shown in the admin
    this.timer = null;
    this.n = 0;
  }

  // One fake chat message: mostly valid entries, a few that must NOT count (to see the rules at work).
  fakeMessage() {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const viewer = Math.floor(Math.random() * 120);
    const name = `${pick(NAMES)}${viewer > 60 ? ` ${viewer}` : ''}`;
    const couple = pick(COUPLES), kw = this.giveaway.keyword || 'CUP';
    const r = Math.random();
    const text = r < 0.6 ? `${kw} ${couple}` : r < 0.7 ? `${kw.toLowerCase()} - ${couple}!!` : r < 0.8 ? kw
      : r < 0.9 ? `${couple} are my favourites` : `${kw} ${couple} ${kw}`;
    return { id: `rehearsal-${++this.n}`, authorId: `rehearsal-viewer-${viewer}`, author: name, parts: [{ text }], at: Date.now() };
  }

  start({ keyword, requireMore }) {
    this.giveaway.reset();
    this.feed = [];
    this.giveaway.start({ keyword, requireMore });
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      for (let i = 1 + Math.floor(Math.random() * 2); i > 0; i--) {
        const m = this.fakeMessage();
        const before = this.giveaway.entrants.has(m.authorId);
        this.giveaway.add([m]);
        // entered = this message created a new entry (not a repeat, not an invalid message)
        this.feed = [...this.feed, { author: m.author, text: m.parts[0].text, entered: !before && this.giveaway.entrants.has(m.authorId) }].slice(-6);
      }
    }, 700);
    this.timer.unref?.();
  }

  stop() {
    this.giveaway.stop();
    clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    this.stop();
    this.giveaway.reset();
    this.feed = [];
  }

  state() {
    return { ...this.giveaway.publicState(), running: !!this.timer, feed: this.feed };
  }
}

module.exports = { Rehearsal };
