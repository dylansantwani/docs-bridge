/**
 * Human typing plans.
 *
 * docs_type types text into a document one keystroke at a time with a
 * person's rhythm instead of pasting it. This module turns content into that
 * keystroke plan. It is pure and seeded, so a plan is reproducible and
 * testable: the server builds it (and knows how long it will take) and the
 * extension's typing job plays it back in the Docs tab (docs-page.js, op
 * "type").
 *
 * The model, per keystroke:
 *   - A base interval from the words-per-minute speed (one word = 5 keys),
 *     with log-normal jitter, and a slow drift so the pace wanders like a
 *     person's does instead of holding a metronome beat.
 *   - Common letter pairs come faster; capitals, digits and punctuation
 *     slower; the first letter of a word a little slower.
 *   - Pauses: after a sentence, after a comma, before a new paragraph (the
 *     longest, "thinking"), and the occasional hesitation mid-sentence or
 *     before a long word.
 *   - Typos: a neighbouring key, two swapped letters, a doubled letter or a
 *     skipped one. The typist notices after 0-3 more letters, stops, erases
 *     back with Backspace and retypes. A typo is always fixed before the word
 *     ends, because Docs autocorrects a misspelled word when its space is
 *     typed, and then the Backspaces would erase the wrong characters.
 *
 * Plan format (per block, `keys`):
 *   {c, d}            type one character after waiting d ms
 *   {k:'Backspace', d}
 *   {f:'b'|'i'|'u'|'s', d}   toggle bold/italic/underline/strikethrough (Cmd+B…)
 *   {p:html, x:text, d}      paste inline HTML (links, code, emoji: text a
 *                            keystroke cannot produce)
 *   s: 1 on an entry  the plan may stop after it and resume later, possibly
 *                     in a fresh tab (see resumeTail)
 */

/** Presets. wpm = speed, typoRate = mistakes per letter, pauses = thinking-pause scale. */
export const TYPING_PROFILES = {
  natural: { wpm: 55, typoRate: 0.02, pauses: 1 },
  careful: { wpm: 38, typoRate: 0.008, pauses: 1.4 },
  fast: { wpm: 85, typoRate: 0.03, pauses: 0.6 },
  steady: { wpm: 60, typoRate: 0, pauses: 0.25 },
};

export const MIN_WPM = 10;
export const MAX_WPM = 200;
export const MAX_TYPO_RATE = 0.1;

/** Characters a Docs Find can match exactly as typed (no smart quotes or autocorrect). */
const FIND_SAFE = /[A-Za-z0-9 ,.;:!?]/;
export const MIN_TAIL = 20;
export const MAX_TAIL = 80;

/**
 * The text that re-finds the caret when typing resumes in a fresh tab: the
 * end of what has been typed in the current paragraph, cut back to
 * characters Docs types exactly as sent (smart quotes, dashes and other
 * autocorrections would not match a Find). null when too short to be
 * distinctive. docs-page.js has a copy of this; test/typing.test.js keeps the
 * two in step.
 */
export function resumeTail(paragraphText) {
  const s = String(paragraphText || '');
  let i = s.length;
  while (i > 0 && s.length - i < MAX_TAIL && FIND_SAFE.test(s[i - 1])) i--;
  const tail = s.slice(i).replace(/^\s+/, '');
  if (tail.length < MIN_TAIL || /\s$/.test(tail)) return null;
  return tail;
}

/** mulberry32: small, fast, seedable. */
export function rng(seed) {
  let a = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    let u = 0;
    while (!u) u = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return {
    next,
    normal,
    /** Log-normal around `median`. */
    around: (median, sigma = 0.5) => median * Math.exp(sigma * normal()),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const NEIGHBOURS = (() => {
  const pos = {};
  ROWS.forEach((row, r) => [...row].forEach((ch, c) => (pos[ch] = [r, c + r * 0.5])));
  const out = {};
  for (const [ch, [r, c]] of Object.entries(pos)) {
    out[ch] = Object.entries(pos)
      .filter(([o, [r2, c2]]) => o !== ch && Math.abs(r2 - r) <= 1 && Math.abs(c2 - c) <= 1)
      .map(([o]) => o);
  }
  return out;
})();

const FAST_PAIRS = new Set(
  'th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur'.split(' ')
);

const isLetter = (ch) => /\p{L}/u.test(ch);
const isWordChar = (ch) => /[\p{L}\p{N}'’]/u.test(ch);

/** Keystrokes a key event can produce; anything else (emoji, astral symbols) is pasted. */
export const typeable = (ch) => ch.length === 1 && ch !== '\n' && ch !== '\r';

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Resolve profile + overrides into concrete settings. */
export function typingSettings({ profile = 'natural', wpm, typos, pauses, seed } = {}) {
  const base = TYPING_PROFILES[profile];
  if (!base) throw new Error(`unknown typing profile ${profile}; use ${Object.keys(TYPING_PROFILES).join(', ')}`);
  const s = { ...base, profile };
  if (wpm !== undefined) s.wpm = Math.min(MAX_WPM, Math.max(MIN_WPM, Number(wpm)));
  if (typos === false) s.typoRate = 0;
  else if (typeof typos === 'number') s.typoRate = Math.min(MAX_TYPO_RATE, Math.max(0, typos));
  if (pauses !== undefined) s.pauses = Math.min(3, Math.max(0, Number(pauses)));
  s.seed = Number.isInteger(seed) ? seed >>> 0 : Math.floor(Math.random() * 2 ** 32);
  return s;
}

/**
 * Build the keystroke plan for typed blocks.
 *
 * @param {Array} blocks  blocks as from toTypingBlocks (server/markdown.js):
 *   inline blocks carry `runs` [{text, b, i, u, s, code, href}]; others
 *   (table, hr, img, html, pagebreak) are placed whole.
 * @param {object} settings  from typingSettings
 * @param {{byEnd?: boolean}} opts  byEnd: every keystroke happens at the end
 *   of the document, so any word boundary is a safe resume point.
 * @returns {{blocks, totalMs, chars, typos}}
 */
export function planTyping(blocks, settings, { byEnd = false } = {}) {
  const r = rng(settings.seed);
  const base = 12_000 / settings.wpm; // ms per keystroke
  const jitterNorm = Math.exp(0.35 ** 2 / 2);
  let drift = 1;
  let totalMs = 0;
  let chars = 0;
  let typos = 0;
  const out = [];

  const keyDelay = (prev, ch) => {
    let m = Math.exp(0.35 * r.normal()) / jitterNorm;
    const pair = (prev + ch).toLowerCase();
    if (FAST_PAIRS.has(pair)) m *= 0.78;
    else if (prev && prev.toLowerCase() === ch.toLowerCase()) m *= 0.88;
    if (ch === ' ') m *= 0.9;
    else if (ch !== ch.toLowerCase()) m *= 1.4;
    else if (/[0-9]/.test(ch)) m *= 1.3;
    else if (!isLetter(ch)) m *= 1.5;
    if (prev === ' ' && isLetter(ch)) m *= 1.12;
    return base * drift * m;
  };

  blocks.forEach((block, bi) => {
    if (!block.runs) {
      // Placed whole (table, rule, image, page break): a beat to "do" it.
      const d = Math.round(r.around(900, 0.4) * Math.max(0.3, settings.pauses));
      totalMs += d;
      out.push({ ...block, before: d });
      return;
    }
    const keys = [];
    const push = (e) => {
      totalMs += e.d;
      keys.push(e);
    };
    // Thinking before a paragraph (not before the very first one: the job
    // has just started).
    const before = bi === 0 ? 0 : Math.round(r.around(block.t === 'li' ? 900 : 2200, 0.55) * settings.pauses);
    totalMs += before;

    const text = block.runs.map((x) => x.text).join('');
    let typed = ''; // intended text of this paragraph so far
    let prev = '';
    const active = { b: false, i: false, u: false, s: false };
    let runIndex = 0;

    for (const run of block.runs) {
      runIndex++;
      if (run.href || run.code || run.html) {
        // No keystroke makes a link, a code font or an image; paste it as one unit.
        const html = run.html
          ? run.html
          : run.href
          ? `<a href="${escapeHtml(run.href)}">${escapeHtml(run.text)}</a>`
          : `<span style="font-family:'Courier New',monospace">${escapeHtml(run.text).replace(/ /g, '&nbsp;')}</span>`;
        push({ p: html, x: run.text, d: Math.round(r.around(600, 0.4)) });
        typed += run.text;
        prev = run.text.slice(-1);
        chars += run.text.length;
        continue;
      }
      for (const f of ['b', 'i', 'u', 's']) {
        if (!!run[f] !== active[f]) {
          push({ f, d: Math.round(r.around(220, 0.3)) });
          active[f] = !!run[f];
        }
      }
      const cs = [...run.text];
      for (let i = 0; i < cs.length; i++) {
        const ch = cs[i];
        const atWordStart = isWordChar(ch) && !isWordChar(prev);
        if (atWordStart) {
          drift = Math.min(1.3, Math.max(0.8, 1 + 0.9 * (drift - 1) + 0.035 * r.normal()));
        }
        let pauseMs = 0;
        // Hesitations: mid-sentence, and before a long word.
        if (atWordStart && typed.length) {
          if (r.chance(0.035)) pauseMs += r.around(900, 0.6) * settings.pauses;
          let len = 0;
          while (i + len < cs.length && isWordChar(cs[i + len])) len++;
          if (len >= 9 && r.chance(0.25)) pauseMs += r.around(320, 0.4) * settings.pauses;
        }
        // After punctuation, when the next character starts something new.
        if (prev && ch === ' ') {
          if (/[.!?]/.test(prev)) pauseMs += r.around(650, 0.55) * settings.pauses;
          else if (/[,;:]/.test(prev)) pauseMs += r.around(220, 0.5) * settings.pauses;
        }

        if (!typeable(ch)) {
          push({ p: `<span>${escapeHtml(ch)}</span>`, x: ch, d: Math.round(pauseMs + r.around(700, 0.4)) });
          typed += ch;
          prev = ch;
          chars++;
          continue;
        }

        // A typo: only inside a word of letters, never on its first letter,
        // and only where the word has room for it to be noticed and fixed
        // before the word ends.
        let wordLeft = 0;
        while (i + wordLeft < cs.length && isLetter(cs[i + wordLeft])) wordLeft++;
        if (settings.typoRate > 0 && isLetter(ch) && isLetter(prev) && wordLeft >= 1 && r.chance(settings.typoRate)) {
          const lower = ch.toLowerCase();
          const upper = ch !== lower;
          const next = cs[i + 1];
          const roll = r.next();
          let wrong;
          let consumed; // intended characters the wrong sequence stands in for
          if (roll < 0.55 && NEIGHBOURS[lower]?.length) {
            const n = r.pick(NEIGHBOURS[lower]);
            wrong = [upper ? n.toUpperCase() : n];
            consumed = 1;
          } else if (roll < 0.75 && next && isLetter(next) && next.toLowerCase() !== lower) {
            wrong = [next, ch];
            consumed = 2;
          } else if (roll < 0.9) {
            wrong = [ch, ch];
            consumed = 1;
          } else if (wordLeft >= 2) {
            wrong = []; // skipped this letter
            consumed = 0;
          } else {
            wrong = [ch, ch];
            consumed = 1;
          }
          // Keep typing a little before noticing, but never past the word.
          const room = Math.max(0, wordLeft - Math.max(consumed, 1));
          const lag = Math.min(room, r.pick([0, 0, 1, 1, 1, 2, 2, 3]));
          const start = consumed === 0 ? 1 : consumed;
          const extra = cs.slice(i + start, i + start + lag);
          const seq = [...wrong, ...extra];
          if (seq.length) {
            let p = prev;
            seq.forEach((w, j) => {
              push({ c: w, d: Math.round((j === 0 ? pauseMs : 0) + keyDelay(p, w)) });
              p = w;
            });
            pauseMs = 0;
            // Notice, stop, erase back.
            const erase = seq.length;
            for (let j = 0; j < erase; j++) push({ k: 'Backspace', d: Math.round(j === 0 ? r.around(380, 0.4) : r.around(base * 0.55, 0.25)) });
            pauseMs = r.around(160, 0.4);
            typos++;
          }
        }

        const d = Math.round(pauseMs + keyDelay(prev, ch));
        const entry = { c: ch, d };
        typed += ch;
        prev = ch;
        chars++;
        // A safe point: a word just ended, no inline format is open, and the
        // caret can be found again (at the end of the document, or by the
        // text typed so far in this paragraph).
        const nextCh = cs[i + 1] ?? block.runs[runIndex]?.text?.[0];
        const wordEnds = isWordChar(ch) && (nextCh === undefined || nextCh === ' ');
        const plain = !active.b && !active.i && !active.u && !active.s;
        if (wordEnds && plain && nextCh !== undefined && (byEnd || resumeTail(typed))) entry.s = 1;
        push(entry);
      }
    }
    // Close any open toggles so the next paragraph starts plain.
    for (const f of ['b', 'i', 'u', 's']) if (active[f]) push({ f, d: Math.round(r.around(200, 0.3)) });
    if (keys.length && (byEnd || resumeTail(text))) keys[keys.length - 1].s = 1;
    out.push({ ...block, before, keys });
  });

  return { blocks: out, totalMs: Math.round(totalMs), chars, typos };
}

/** Everything the plan types, as plain text per block (for verification probes). */
export function planText(blocks) {
  return blocks.map((b) => (b.runs ? b.runs.map((r) => r.text).join('') : '')).join('\n');
}

/**
 * Text folded for comparison with the saved document: Docs turns straight
 * quotes curly, "--" into a dash, may auto-link or auto-list what was typed,
 * so only letters and digits are compared.
 */
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
