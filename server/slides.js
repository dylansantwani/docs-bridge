/**
 * Google Slides tools (slides_*): schemas, argument validation, and turning
 * model-facing requests into the page steps that extension/page/slides-page.js
 * runs. The extension verifies every run against the deck as saved in Drive.
 *
 * Shapes are addressed the way slides_read shows them: by slide number and
 * shape number (z-order), or by role — title, subtitle, body — which is
 * resolved here from the saved deck's placeholder types. A slide added in the
 * same call has only empty placeholders, which the page finds by their
 * "Click to add title/subtitle/text" prompts instead.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { parseDeckRef, normalizeAccount, slidesEditUrl, SLIDES_EXPORT_FORMATS } from '../extension/lib/refs.js';
import { deckOutline, deckText, slideTitle } from '../extension/lib/pptx.js';
import { toInlineHtml, htmlToText, toTypingContent } from './markdown.js';
import { typingSettings, planTyping, TYPING_PROFILES, MIN_WPM, MAX_WPM, MAX_TYPO_RATE } from '../extension/lib/typing.js';

const ACCOUNT = {
  description:
    'Which signed-in Google account to use: an index as in /u/N/ URLs (0 = first account) or an email address. ' +
    'Omit for the browser default. Use this for presentations owned by a second (e.g. school) account.',
  oneOf: [{ type: 'integer', minimum: 0, maximum: 9 }, { type: 'string' }],
};
const DECK = { type: 'string', description: 'Google Slides URL or presentation id.' };

const FORMAT = {
  type: 'object',
  description: 'Formatting for the selected text (or the caret paragraph, for align/list/indent). Toggles take true/false.',
  properties: {
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    strikethrough: { type: 'boolean' },
    superscript: { type: 'boolean' },
    subscript: { type: 'boolean' },
    align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
    list: { type: 'string', enum: ['bullet', 'numbered', 'checklist', 'none'] },
    indent: { type: 'integer', minimum: -10, maximum: 10 },
    size: { type: 'number', minimum: 1, maximum: 400, description: 'Font size in points.' },
    font: { type: 'string', description: "Font family as named in the font menu, e.g. Roboto, Georgia." },
    color: { type: 'string', description: 'Text colour: a palette name (red, dark blue 2, …) or a hex shown in the palette.' },
    highlight: { type: 'string', description: 'Highlight colour: palette name, hex, or "none".' },
    clear: { type: 'boolean', description: 'Clear formatting (Cmd+\\).' },
  },
  additionalProperties: false,
};
const FORMAT_KEYS = new Set(Object.keys(FORMAT.properties));

const TEXT_MD =
  'Markdown, one paragraph per line: "- " or "* " bullets, "1. " numbering, "- [ ] " checklist, two spaces of indent per nesting level; **bold**, *italic*, ~~strike~~, `code`, [links](url) inline. Plain lines are paragraphs without bullets.';

const SLIDE_SPEC = {
  type: 'object',
  description:
    'One slide. With `slide`, it changes that existing slide; without it, it adds a new slide. Slide numbers count the deck as it is when this entry runs (entries run in order).',
  properties: {
    slide: { type: 'integer', description: 'Existing slide number (1-based; -1 = last). Omit to add a new slide.' },
    after: { type: 'integer', minimum: 0, description: 'New slides only: insert after this slide number (0 = at the start). Default: after the previous new slide of this call, else at the end.' },
    layout: { type: 'string', description: 'Layout as named in Slide > Apply layout: "Title slide", "Section header", "Title and body" (default for new slides), "Title and two columns", "Title only", "One column text", "Main point", "Section title and description", "Caption", "Big number", "Blank", or a theme\'s own layout name. On an existing slide it re-applies the layout.' },
    title: { type: 'string', description: 'Title text (inline markdown). Replaces the title placeholder\'s text.' },
    subtitle: { type: 'string', description: 'Subtitle text (Title slide / Section title layouts).' },
    body: { type: 'string', description: `Body text. ${TEXT_MD}` },
    shapes: {
      type: 'object',
      description: 'Set other shapes\' text by shape number as slides_read lists it, e.g. {"3": "Right column\\n- point"} for a two-column layout. Same markdown as body.',
      additionalProperties: { type: 'string' },
    },
    notes: { type: 'string', description: 'Speaker notes (same markdown). "" clears them.' },
    skip: { type: 'boolean', description: 'Skip (true) or unskip (false) this slide in the slideshow.' },
    move: { type: 'string', enum: ['up', 'down', 'start', 'end'], description: 'Move this slide.' },
    duplicate: { type: 'boolean', description: 'Duplicate this slide (the copy goes right after it; later entries see the new numbering).' },
    delete: { type: 'boolean', description: 'Delete this slide (nothing else in the entry may be set).' },
  },
  additionalProperties: false,
};

const STEP = {
  type: 'object',
  description:
    'One action. Moves: slide, shape, editText, focusNotes, selectText, caret, escape. Changes: setText, text, insert, notes, format, key, menu, newSlide, layout, deleteSlide, duplicateSlide, moveSlide, skipSlide, undo, redo.',
  properties: {
    slide: { type: 'integer', description: 'Go to slide N (1-based; -1 = last).' },
    newSlide: { description: 'Add a slide after the current one: true, or a layout name.', oneOf: [{ type: 'boolean' }, { type: 'string' }] },
    layout: { type: 'string', description: 'Apply a layout to the current slide.' },
    shape: {
      description: 'Select a shape on the current slide: its number (as slides_read lists it), "title" | "subtitle" | "body", or {contains: text, occurrence}.',
      oneOf: [
        { type: 'integer' },
        { type: 'string', enum: ['title', 'subtitle', 'body'] },
        { type: 'object', properties: { contains: { type: 'string' }, occurrence: { type: 'integer', minimum: 1 } }, required: ['contains'], additionalProperties: false },
      ],
    },
    editText: { type: 'boolean', description: 'Put the caret in the selected shape\'s text (Enter).' },
    focusNotes: { type: 'boolean', description: "Put the caret at the end of the current slide's speaker notes." },
    selectText: {
      description: 'Select text inside the shape (or notes) being edited: a string, or {text, occurrence, matchCase}.',
      oneOf: [
        { type: 'string' },
        { type: 'object', properties: { text: { type: 'string' }, occurrence: { type: 'integer' }, matchCase: { type: 'boolean' } }, required: ['text'], additionalProperties: false },
      ],
    },
    caret: { type: 'string', enum: ['start', 'end'], description: 'Move the caret to the start or end of the text being edited.' },
    setText: { type: 'string', description: `Replace all text of the selected shape. ${TEXT_MD}` },
    text: { type: 'string', description: 'Inline markdown typed at the caret or over the selected text.' },
    insert: { type: 'string', description: 'Markdown paragraphs typed as new paragraphs after the caret (Enter first). Put the caret at the end of a paragraph before.' },
    notes: { type: 'string', description: "Replace the current slide's speaker notes (markdown; \"\" clears)." },
    format: FORMAT,
    key: { type: 'string', description: 'Press a key: Enter, Tab, Backspace, Delete, Escape, ArrowUp/Down/Left/Right, Home, End, a letter or digit.' },
    mods: { type: 'object', properties: { mod: { type: 'boolean' }, shift: { type: 'boolean' }, alt: { type: 'boolean' }, ctrl: { type: 'boolean' } }, additionalProperties: false, description: 'Modifiers for key; mod = Cmd on macOS, Ctrl elsewhere.' },
    times: { type: 'integer', minimum: 1, maximum: 200 },
    menu: { type: 'string', description: 'Run a menu command by path, e.g. "Slide > Change background", "Arrange > Align > Center", "Insert > Table > 3 x 3" (palette items by label).' },
    deleteSlide: { type: 'boolean' },
    duplicateSlide: { type: 'boolean' },
    moveSlide: { type: 'string', enum: ['up', 'down', 'start', 'end'] },
    skipSlide: { type: 'boolean' },
    undo: { type: 'integer', minimum: 1, maximum: 50 },
    redo: { type: 'integer', minimum: 1, maximum: 50 },
    escape: { type: 'boolean', description: 'Leave text editing and deselect.' },
  },
  additionalProperties: false,
};

export const SLIDES_INSTRUCTIONS = `
Google Slides (slides_* tools; same extension, same accounts)
- slides_read: the deck as saved in Drive — every slide with its layout, numbered shapes (role, position, text as markdown, tables, images) and speaker notes. Read it before editing.
- slides_write: add slides (layout, title, subtitle, body bullets, notes) or change existing ones (any of those, other shapes by number, skip/move/duplicate/delete). Text goes in through the editor in the deck's own theme styles.
- slides_create: a new deck (optionally from a template deck) filled with slides in one call; slides_copy copies a deck.
- slides_replace: Find and replace across the deck (placeholders like {{name}} in templates); several pairs at once.
- slides_edit: anything else as human steps — go to a slide, select a shape, select text, type, format (bold, size, font, colour, lists, alignment), keys, any menu command, undo.
- slides_type: type into a slide's title, subtitle, body, any shape or the speaker notes like a person — keystroke by keystroke at a human pace with pauses and corrected typos (same profiles as docs_type). Use slides_write when speed matters.
- slides_export: pptx, pdf, odp, txt, or one slide as png/jpeg/svg. slides_list, slides_rename, slides_open as for docs.
Every Slides change is checked against the deck as saved in Drive (the exported .pptx).`;

export const SLIDES_TOOLS = [
  {
    name: 'slides_list',
    description: 'List Google Slides presentations: recently opened, or a Drive search when query is given.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Drive search text. Omit for recent presentations.' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, account: ACCOUNT },
      additionalProperties: false,
    },
  },
  {
    name: 'slides_read',
    description:
      'Read a Google Slides presentation as saved in Drive. "outline" (default): each slide with its layout, numbered shapes (role: title/subtitle/body/…, position in points, text as markdown with bullet nesting), tables, images and speaker notes — the shape numbers are what slides_write and slides_edit take. "text": plain text slide by slide. "json": the parsed structure.',
    inputSchema: {
      type: 'object',
      properties: {
        deck: DECK,
        format: { type: 'string', enum: ['outline', 'text', 'json'] },
        slides: { type: 'string', description: 'Only these slides: "3", "2-5", "1,4,7".' },
        offset: { type: 'integer', minimum: 0 },
        maxChars: { type: 'integer', minimum: 1000, maximum: 200000 },
        account: ACCOUNT,
      },
      required: ['deck'],
      additionalProperties: false,
    },
  },
  {
    name: 'slides_write',
    description:
      "Add slides or change existing ones, in the deck's own layouts and theme. Each entry is one slide: without `slide` it adds a new slide (layout, title, subtitle, body, notes); with `slide: N` it changes slide N (any of those, other shapes by number, skip, move, duplicate, delete). Body text is markdown lines: bullets, numbering and nesting become real Slides lists. Verified against the saved deck.",
    inputSchema: {
      type: 'object',
      properties: { deck: DECK, slides: { type: 'array', items: SLIDE_SPEC, minItems: 1, maxItems: 60 }, account: ACCOUNT },
      required: ['deck', 'slides'],
      additionalProperties: false,
    },
  },
  {
    name: 'slides_create',
    description:
      'Create a Google Slides presentation, optionally from a template deck (any deck URL or id: it is copied), and optionally fill it with slides in the same call. For a new blank deck the first entry fills its existing title slide (give it a `layout` to change that), the rest are added after it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        template: { type: 'string', description: 'A deck to copy as the starting point (URL or id).' },
        slides: { type: 'array', items: SLIDE_SPEC, maxItems: 60, description: 'Slides to write, as in slides_write.' },
        account: ACCOUNT,
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'slides_replace',
    description:
      "Slides' own Find and replace across every slide (shapes and tables). Pass find + replace, or replacements: {find: replace, …} to fill a template's placeholders in one call. occurrence replaces only the Nth match. Verified against the saved deck.",
    inputSchema: {
      type: 'object',
      properties: {
        deck: DECK,
        find: { type: 'string' },
        replace: { type: 'string' },
        replacements: { type: 'object', additionalProperties: { type: 'string' }, description: 'Several find → replace pairs, applied in order.' },
        matchCase: { type: 'boolean', description: 'Default false (true for replacements).' },
        regex: { type: 'boolean' },
        occurrence: { type: 'integer', description: 'Replace only this match (1 = first, -1 = last).' },
        account: ACCOUNT,
      },
      required: ['deck'],
      additionalProperties: false,
    },
  },
  {
    name: 'slides_edit',
    description:
      'Edit a presentation with human steps, for what slides_write does not cover: go to a slide, select a shape (by number or role), select text inside it, type over it, format it (bold, italic, size, font, colour, lists, alignment), press keys, run any menu command ("Slide > Change background", "Arrange > Order > Bring to front"), undo. Steps run in order in one editor tab; changes are verified against the saved deck.',
    inputSchema: {
      type: 'object',
      properties: { deck: DECK, steps: { type: 'array', items: STEP, minItems: 1, maxItems: 80 }, account: ACCOUNT },
      required: ['deck', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'slides_copy',
    description: 'Make a copy of a presentation with a new title.',
    inputSchema: { type: 'object', properties: { deck: DECK, title: { type: 'string' }, account: ACCOUNT }, required: ['deck'], additionalProperties: false },
  },
  {
    name: 'slides_rename',
    description: 'Rename a presentation.',
    inputSchema: { type: 'object', properties: { deck: DECK, title: { type: 'string' }, account: ACCOUNT }, required: ['deck', 'title'], additionalProperties: false },
  },
  {
    name: 'slides_export',
    description: 'Save a presentation to a local file: pptx, pdf, odp or txt — or one slide as png, jpeg or svg (pass slide).',
    inputSchema: {
      type: 'object',
      properties: {
        deck: DECK,
        format: { type: 'string', enum: Object.keys(SLIDES_EXPORT_FORMATS) },
        path: { type: 'string', description: 'Absolute output path; the extension is added if missing.' },
        slide: { type: 'integer', minimum: 1, description: 'For png/jpeg/svg: which slide (default 1).' },
        overwrite: { type: 'boolean' },
        account: ACCOUNT,
      },
      required: ['deck', 'format', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'slides_open',
    description: "Open a presentation (optionally at a slide) in a new foreground Chrome tab for the user to see.",
    inputSchema: { type: 'object', properties: { deck: DECK, slide: { type: 'integer', minimum: 1 }, account: ACCOUNT }, required: ['deck'], additionalProperties: false },
  },
];

SLIDES_TOOLS.push({
  name: 'slides_type',
  description:
    "Type text into a slide like a person: one keystroke at a time at a human pace (default ~55 wpm), with rhythm, thinking pauses and typos fixed with Backspace — into the title, subtitle, body, any shape by number, or the speaker notes. mode replace (default) clears the shape first; append adds paragraphs after its text. Bullets (\"- \"), numbering and nesting become real lists; **bold** / *italic* are toggled with Cmd+B/I while typing. Long text is typed in parts of up to ~90 s, each verified against the saved deck; the call returns when everything is typed.",
  inputSchema: {
    type: 'object',
    properties: {
      deck: DECK,
      slide: { type: 'integer', description: 'Slide number (1-based; -1 = last).' },
      shape: {
        description: 'Where to type: "title" | "subtitle" | "body" | "notes" (speaker notes), or a shape number as slides_read lists it. Default "body".',
        oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['title', 'subtitle', 'body', 'notes'] }],
      },
      mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default): clear the shape, then type. append: type new paragraphs after its text.' },
      markdown: { type: 'string', description: TEXT_MD },
      text: { type: 'string', description: 'Plain text instead of markdown; one paragraph per line.' },
      profile: { type: 'string', enum: Object.keys(TYPING_PROFILES), description: 'natural (55 wpm, 2% typos), careful (38 wpm), fast (85 wpm), steady (60 wpm, no typos).' },
      wpm: { type: 'number', minimum: MIN_WPM, maximum: MAX_WPM },
      typos: { description: 'false for none, or a rate per letter (e.g. 0.01).', oneOf: [{ type: 'boolean' }, { type: 'number', minimum: 0, maximum: MAX_TYPO_RATE }] },
      pauses: { type: 'number', minimum: 0, maximum: 3, description: 'Scale for thinking pauses (0 = none).' },
      seed: { type: 'integer', description: 'Seed for a reproducible rhythm.' },
      account: ACCOUNT,
    },
    required: ['deck', 'slide'],
    additionalProperties: false,
  },
});

export const SLIDES_TOOL_NAMES = new Set(SLIDES_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------- helpers

function bad(message) {
  const err = new Error(message);
  err.code = 'bad_args';
  return err;
}

function str(v, name, { required = false, allowEmpty = true } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  if (!allowEmpty && !v.trim()) throw bad(`${name} must not be empty`);
  return v;
}

function int(v, name, { min, max, dflt } = {}) {
  if (v === undefined || v === null) return dflt;
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n)) throw bad(`${name} must be an integer`);
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}

function deckArgs(args) {
  let ref;
  try {
    ref = parseDeckRef(args.deck);
  } catch (err) {
    throw bad(err.message);
  }
  return { id: ref.id, page: ref.slide, account: normalizeAccount(args.account) };
}

/**
 * Markdown lines → slide paragraphs: [{html, text, list, level}]. One
 * paragraph per non-empty line. List items nest by indentation, measured
 * against the indents of the open list levels (so 2, 3 or 4 spaces all work).
 */
export function toSlideParagraphs(markdown) {
  const out = [];
  let stack = [];
  for (const raw of String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    const line = raw.replace(/\t/g, '    ');
    const m = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
    let content;
    let list = null;
    let level = 0;
    if (m) {
      const indent = m[1].length;
      while (stack.length && indent < stack[stack.length - 1]) stack.pop();
      if (!stack.length || indent > stack[stack.length - 1]) stack.push(indent);
      level = Math.min(8, stack.length - 1);
      list = m[4] !== undefined ? 'checklist' : m[3] ? 'numbered' : 'bullet';
      content = m[5];
    } else {
      stack = [];
      content = line.trim().replace(/^#{1,6}\s+/, '');
    }
    const html = toInlineHtml(content).trim();
    const text = htmlToText(html).trim();
    if (!text) continue;
    out.push({ html, text, list, level });
  }
  return out;
}

function inlineHtml(markdown, where) {
  if (typeof markdown !== 'string' || !markdown) throw bad(`${where} must be a non-empty string`);
  if (markdown.includes('\n')) throw bad(`${where} is inline text (no line breaks); use insert or setText for paragraphs`);
  return toInlineHtml(markdown).trim();
}

function validateFormat(f, where) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad(`${where} must be an object`);
  const keys = Object.keys(f);
  if (!keys.length) throw bad(`${where} is empty`);
  for (const k of keys) if (!FORMAT_KEYS.has(k)) throw bad(`${where}.${k} is not a formatting option; use ${[...FORMAT_KEYS].join(', ')}`);
  return f;
}

/** "3" | "2-5" | "1,4,7-9" → Set of slide numbers. */
export function parseSlideRange(spec, count) {
  const want = new Set();
  for (const part of String(spec).split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(-?\d+)(?:\s*-\s*(-?\d+))?$/);
    if (!m) throw bad(`slides must look like "3", "2-5" or "1,4,7"; got ${JSON.stringify(spec)}`);
    const a = Number(m[1]) === -1 ? count : Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]) === -1 ? count : Number(m[2]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) want.add(i);
  }
  return want;
}

const ROLES = { title: 'title', subtitle: 'subtitle', body: 'body' };

/**
 * Mirrors the deck's slide list through a run's structural changes, so a
 * role on slide N resolves against the right saved slide. Entries are the
 * saved slides (shapes known) or {saved: null} for slides added or
 * re-laid-out in this call (their placeholders are empty, so the page finds
 * them by their prompts). `cur` is the slide the editor is on.
 */
export class SlideSim {
  constructor(deck) {
    this.seq = 0;
    this.list = deck ? deck.slides.map((s) => ({ saved: s, id: ++this.seq })) : null;
    this.cur = 1;
    this.newest = null;
  }
  get count() {
    return this.list ? this.list.length : null;
  }
  index(n) {
    if (!this.list) return n;
    const i = n === -1 ? this.list.length : n;
    if (i < 1 || i > this.list.length) throw bad(`slide ${n} does not exist; the presentation has ${this.list.length} slide(s) at that point`);
    return i;
  }
  go(n) {
    this.cur = this.index(n);
  }
  add() {
    const e = { saved: null, id: ++this.seq };
    if (this.list) this.list.splice(this.cur, 0, e);
    this.cur += 1;
    this.newest = e.id;
  }
  /** Where the slide this call added last is now (0 if none, or unknown). */
  newestIndex() {
    if (!this.list || this.newest === null) return 0;
    return this.list.findIndex((e) => e.id === this.newest) + 1;
  }
  markNewest(index) {
    if (this.list?.[index - 1]) this.newest = this.list[index - 1].id;
  }
  relayout() {
    if (this.list?.[this.cur - 1]) this.list[this.cur - 1] = { saved: null, id: this.list[this.cur - 1].id };
  }
  duplicate() {
    if (this.list) this.list.splice(this.cur, 0, { ...this.list[this.cur - 1], id: ++this.seq });
    this.cur += 1;
  }
  remove() {
    if (this.list) {
      this.list.splice(this.cur - 1, 1);
      this.cur = Math.max(1, Math.min(this.cur, this.list.length));
    }
  }
  move(dir) {
    if (!this.list) return;
    const [e] = this.list.splice(this.cur - 1, 1);
    const to = dir === 'start' ? 0 : dir === 'end' ? this.list.length : dir === 'up' ? Math.max(0, this.cur - 2) : Math.min(this.list.length, this.cur);
    this.list.splice(to, 0, e);
    this.cur = to + 1;
  }
  /** Page shape spec for a role on the current slide. */
  role(role) {
    const saved = this.list?.[this.cur - 1]?.saved;
    if (!saved) return { role };
    const hit = saved.shapes.find((s) => s.placeholder === ROLES[role]);
    if (!hit) {
      const listing = saved.shapes.map((s) => `${s.index}: ${s.placeholder || s.kind}${s.paragraphs?.length ? ` "${s.paragraphs.map((p) => p.text).join(' / ').slice(0, 40)}"` : ''}`).join('; ');
      throw bad(`slide ${this.cur} has no ${role} placeholder (layout ${saved.layout || 'unknown'}); its shapes are ${listing || 'none'}. Use shapes: {"N": …} or a layout with a ${role}.`);
    }
    return { index: hit.index };
  }
  shapeCount() {
    return this.list?.[this.cur - 1]?.saved?.shapes.length ?? null;
  }
}

const STRUCTURAL = new Set(['newSlide', 'layout', 'deleteSlide', 'duplicateSlide', 'moveSlide']);

/** Rough seconds a page step takes in a background tab (timers there tick once a second). */
function stepCost(step) {
  const k = Object.keys(step)[0];
  if (k === 'setText' || k === 'notes') return 4 + (step[k].length || 0) * 0.6;
  if (k === 'newSlide' || k === 'layout' || k === 'duplicateSlide' || k === 'deleteSlide' || k === 'moveSlide' || k === 'menu') return 3;
  if (k === 'format' || k === 'insert') return 3;
  return 1.5;
}

/** Keep one page run well inside the extension's limits (one executeScript ≤ 280s; fresh tabs ≤ 4 min). */
const RUN_BUDGET_S = 140;

/**
 * Compile one slide spec into page steps (appended to `steps`), keeping the
 * simulated slide list in step, and describe it in `lines`.
 */
export function compileSpec(spec, i, sim, steps, lines) {
  const where = `slides[${i}]`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw bad(`${where} must be an object`);
  const has = (k) => spec[k] !== undefined;
  if (has('delete') && spec.delete) {
    const others = Object.keys(spec).filter((k) => !['slide', 'delete'].includes(k));
    if (others.length) throw bad(`${where}: delete cannot be combined with ${others.join(', ')}`);
    if (!has('slide')) throw bad(`${where}: delete needs slide`);
  }
  if (has('after') && has('slide')) throw bad(`${where}: after is only for new slides (omit slide)`);
  const text = (v, name) => {
    if (typeof v !== 'string') throw bad(`${where}.${name} must be a string`);
    return toSlideParagraphs(v);
  };
  let label;
  if (has('slide')) {
    const n = int(spec.slide, `${where}.slide`);
    if (n === 0) throw bad(`${where}.slide is 1-based (-1 = last)`);
    sim.go(n);
    steps.push({ slide: { index: n } });
    label = `slide ${sim.cur}`;
    if (spec.delete) {
      steps.push({ deleteSlide: true });
      sim.remove();
      lines.push(`${label}: deleted`);
      return;
    }
    if (has('layout')) {
      steps.push({ layout: str(spec.layout, `${where}.layout`, { allowEmpty: false }) });
      sim.relayout();
    }
  } else {
    // Default position: after the slide this call added last, else at the end.
    const after = spec.after !== undefined ? int(spec.after, `${where}.after`, { min: 0 }) : sim.newestIndex() || sim.count;
    if (after === 0) {
      // A new first slide: add it after slide 1, then move it to the start.
      steps.push({ slide: { index: 1 } });
      sim.go(1);
      steps.push({ newSlide: { layout: spec.layout ?? 'Title and body' } });
      sim.add();
      steps.push({ moveSlide: 'start' });
      sim.move('start');
    } else {
      sim.go(after);
      steps.push({ slide: { index: after } });
      steps.push({ newSlide: { layout: spec.layout ?? 'Title and body' } });
      sim.add();
    }
    label = `new slide ${sim.cur}${spec.layout ? ` (${spec.layout})` : ''}`;
  }
  const did = [];
  for (const role of ['title', 'subtitle', 'body']) {
    if (!has(role)) continue;
    const paras = text(spec[role], role);
    if (role !== 'body' && paras.some((p) => p.list)) throw bad(`${where}.${role} is a plain line; put lists in body`);
    steps.push({ shape: sim.role(role) }, { setText: paras });
    did.push(role);
  }
  if (has('shapes')) {
    if (!spec.shapes || typeof spec.shapes !== 'object') throw bad(`${where}.shapes must be an object of shape number → text`);
    for (const [k, v] of Object.entries(spec.shapes)) {
      const n = Number(k);
      if (!Number.isInteger(n) || n < 1) throw bad(`${where}.shapes keys are shape numbers as slides_read lists them; got ${JSON.stringify(k)}`);
      const max = sim.shapeCount();
      if (max !== null && n > max) throw bad(`${where}.shapes: slide ${sim.cur} has ${max} shape(s); there is no shape ${n}`);
      steps.push({ shape: { index: n } }, { setText: text(v, `shapes.${k}`) });
      did.push(`shape ${n}`);
    }
  }
  if (has('notes')) {
    steps.push({ notes: text(spec.notes, 'notes') });
    did.push(spec.notes ? 'notes' : 'notes cleared');
  }
  if (has('skip')) {
    steps.push({ skipSlide: !!spec.skip });
    did.push(spec.skip ? 'skipped' : 'unskipped');
  }
  if (has('duplicate') && spec.duplicate) {
    steps.push({ duplicateSlide: true });
    sim.duplicate();
    did.push(`duplicated (copy is slide ${sim.cur})`);
  }
  if (has('move')) {
    const dir = spec.move;
    if (!['up', 'down', 'start', 'end'].includes(dir)) throw bad(`${where}.move must be up, down, start or end`);
    steps.push({ moveSlide: dir });
    sim.move(dir);
    did.push(`moved ${dir} (now slide ${sim.cur})`);
  }
  if (has('layout') && has('slide')) did.unshift(`layout ${spec.layout}`);
  if (!did.length && has('slide') && !has('layout')) throw bad(`${where} changes nothing on slide ${spec.slide}`);
  lines.push(`${label}: ${did.join(', ') || 'added'}`);
}

function runSummary(r) {
  return r.verification?.verified
    ? 'verified in Drive'
    : r.verification
      ? `NOT verified after ${r.verification.waitedSeconds ?? '?'}s (${[r.verification.unchanged && 'the saved deck did not change', r.verification.missing?.length && r.verification.missing.join('; '), r.verification.error].filter(Boolean).join('; ') || 'unknown'}). Read the deck before retrying so nothing is applied twice.`
      : 'nothing to verify';
}

/** Steps a run may start with: they do not depend on a selection made by the step before. */
const SAFE_SPLIT = new Set(['slide', 'newSlide', 'shape', 'notes', 'layout', 'deleteSlide', 'duplicateSlide', 'moveSlide', 'skipSlide']);

/**
 * Run compiled steps as one or more page runs, each within the time budget.
 * A run is only cut before a step that stands on its own, and the next run
 * first returns to the slide the previous one ended on.
 */
export async function runPlanned(transport, base, steps, { budget = RUN_BUDGET_S } = {}) {
  const runs = [];
  let chunk = [];
  let cost = 0;
  const flush = async () => {
    if (!chunk.length) return;
    try {
      runs.push(await transport.call('slides_run', { ...base, steps: chunk }, { timeout: 330_000 }));
    } catch (err) {
      err.message = `${err.message}${runs.length ? ` (after ${runs.length} earlier part(s) were applied and verified)` : ''} — read the deck (slides_read) to see what was applied`;
      throw err;
    }
    chunk = [];
    cost = 0;
  };
  for (const st of steps) {
    const kind = Object.keys(st)[0];
    const c = stepCost(st);
    if (chunk.length && cost + c > budget && SAFE_SPLIT.has(kind)) {
      await flush();
      const at = runs[runs.length - 1]?.page;
      if (kind !== 'slide' && at) {
        chunk.push({ slide: { page: at } });
        cost += 1;
      }
    }
    chunk.push(st);
    cost += c;
  }
  await flush();
  return runs;
}

/**
 * slides_write: compile the specs and run them. Roles on existing slides
 * resolve against the saved deck; when earlier entries of the same call
 * restructured the deck (added, moved, deleted or re-laid-out slides), the
 * steps so far are run first and the deck is read again.
 */
async function writeSlides(transport, base, specs) {
  if (!Array.isArray(specs) || !specs.length) throw bad('slides must be a non-empty array');
  if (specs.length > 60) throw bad('at most 60 slides per call');
  const needsSaved = (s) => s && s.slide !== undefined && (['title', 'subtitle', 'body'].some((k) => s[k] !== undefined) || s.shapes !== undefined);
  const runs = [];
  const lines = [];
  let sim = null;
  let steps = [];
  let structural = false;
  const load = async () => {
    const r = await transport.call('slides_deck', base, { timeout: 120_000 });
    sim = new SlideSim(r.deck);
    // Keep "after the previous new slide" working across the re-read.
    const last = runs[runs.length - 1];
    const newest = runs.flatMap((x) => x.results || []).filter((x) => x.action === 'newSlide').pop();
    const at = newest && last?.slides ? last.slides.findIndex((x) => x.pageId === newest.pageId) + 1 : 0;
    if (at) sim.markNewest(at);
    if (last?.page && last.slides) sim.cur = Math.max(1, last.slides.findIndex((x) => x.pageId === last.page) + 1);
  };
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (!sim || (needsSaved(spec) && structural)) {
      if (steps.length) {
        runs.push(...(await runPlanned(transport, base, steps)));
        steps = [];
      }
      await load();
      structural = false;
    }
    const before = steps.length;
    compileSpec(spec, i, sim, steps, lines);
    if (steps.slice(before).some((st) => STRUCTURAL.has(Object.keys(st)[0]))) structural = true;
  }
  if (steps.length) runs.push(...(await runPlanned(transport, base, steps)));
  return { runs, lines };
}

/**
 * slides_edit steps → page steps, resolving roles against the saved deck.
 * Steps start on slide 1 unless the first one is a slide step.
 */
export function compileEditSteps(input, sim) {
  if (!Array.isArray(input) || !input.length) throw bad('steps must be a non-empty array');
  if (input.length > 80) throw bad('at most 80 steps per call');
  const out = [];
  const KINDS = ['slide', 'newSlide', 'layout', 'shape', 'editText', 'focusNotes', 'selectText', 'caret', 'setText', 'text', 'insert', 'notes', 'format', 'key', 'menu', 'deleteSlide', 'duplicateSlide', 'moveSlide', 'skipSlide', 'undo', 'redo', 'escape'];
  input.forEach((step, i) => {
    const where = `steps[${i}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw bad(`${where} must be an object`);
    const actions = Object.keys(step).filter((k) => KINDS.includes(k));
    const extras = Object.keys(step).filter((k) => !KINDS.includes(k) && !['mods', 'times'].includes(k));
    if (extras.length) throw bad(`${where} has unknown field(s) ${extras.join(', ')}`);
    if (actions.length !== 1) throw bad(`${where} must have exactly one action (${KINDS.join(', ')}); got ${actions.join(', ') || 'none'}`);
    const k = actions[0];
    const v = step[k];
    switch (k) {
      case 'slide': {
        const n = int(v, `${where}.slide`);
        if (n === 0) throw bad(`${where}.slide is 1-based (-1 = last)`);
        sim.go(n);
        out.push({ slide: { index: n } });
        break;
      }
      case 'newSlide':
        if (v === false) throw bad(`${where}.newSlide must be true or a layout name`);
        out.push({ newSlide: typeof v === 'string' ? { layout: v } : {} });
        sim.add();
        break;
      case 'layout':
        out.push({ layout: str(v, `${where}.layout`, { allowEmpty: false }) });
        sim.relayout();
        break;
      case 'shape':
        if (Number.isInteger(v)) {
          if (v < 1) throw bad(`${where}.shape numbers start at 1`);
          out.push({ shape: { index: v } });
        } else if (typeof v === 'string') {
          if (!ROLES[v]) throw bad(`${where}.shape must be a number, "title", "subtitle", "body" or {contains}`);
          out.push({ shape: sim.role(v) });
        } else if (v && typeof v === 'object' && typeof v.contains === 'string' && v.contains) {
          out.push({ shape: { contains: v.contains, occurrence: v.occurrence || 1 } });
        } else throw bad(`${where}.shape must be a number, "title", "subtitle", "body" or {contains}`);
        break;
      case 'editText':
      case 'escape':
        out.push({ [k]: true });
        break;
      case 'focusNotes':
        out.push({ notesFocus: true });
        break;
      case 'selectText': {
        const t = typeof v === 'string' ? { text: v } : v;
        if (!t || typeof t.text !== 'string' || !t.text) throw bad(`${where}.selectText needs text`);
        out.push({ selectText: { text: t.text, occurrence: t.occurrence ?? 1, matchCase: !!t.matchCase } });
        break;
      }
      case 'caret':
        if (!['start', 'end'].includes(v)) throw bad(`${where}.caret must be start or end`);
        out.push({ caret: v });
        break;
      case 'setText':
      case 'notes':
        if (typeof v !== 'string') throw bad(`${where}.${k} must be markdown text`);
        out.push({ [k]: toSlideParagraphs(v) });
        break;
      case 'insert': {
        const paras = toSlideParagraphs(str(v, `${where}.insert`, { allowEmpty: false }));
        if (!paras.length) throw bad(`${where}.insert has no text`);
        out.push({ insert: paras });
        break;
      }
      case 'text':
        out.push({ text: inlineHtml(v, `${where}.text`) });
        break;
      case 'format':
        out.push({ format: validateFormat(v, `${where}.format`) });
        break;
      case 'key':
        if (typeof v !== 'string' || !v) throw bad(`${where}.key must be a key name`);
        out.push({ key: v, ...(step.mods ? { mods: step.mods } : {}), ...(step.times ? { times: step.times } : {}) });
        break;
      case 'menu':
        out.push({ menu: str(v, `${where}.menu`, { allowEmpty: false }) });
        break;
      case 'deleteSlide':
        out.push({ deleteSlide: true });
        sim.remove();
        break;
      case 'duplicateSlide':
        out.push({ duplicateSlide: true });
        sim.duplicate();
        break;
      case 'moveSlide':
        if (!['up', 'down', 'start', 'end'].includes(v)) throw bad(`${where}.moveSlide must be up, down, start or end`);
        out.push({ moveSlide: v });
        sim.move(v);
        break;
      case 'skipSlide':
        out.push({ skipSlide: !!v });
        break;
      case 'undo':
      case 'redo':
        out.push({ [k]: int(v, `${where}.${k}`, { min: 1, max: 50 }) });
        break;
      default:
        throw bad(`${where}: unsupported action ${k}`);
    }
  });
  // Edits start from a known place: slide 1 unless the first step picks one.
  if (!('slide' in out[0])) {
    out.unshift({ slide: { index: 1 } });
  }
  return out;
}

function stepLine(r) {
  const bits = [r.action];
  if (r.slide) bits.push(`slide ${r.slide}`);
  if (r.action === 'newSlide') bits.push(`slide ${r.index}${r.layout ? ` (${r.layout})` : ''}`);
  if (r.action === 'shape') bits.push(`shape ${r.index}`);
  if (r.text !== undefined && r.action === 'setText') bits.push(JSON.stringify(r.text.slice(0, 80)));
  if (r.matches) bits.push(`${r.matches} match${r.matches > 1 ? 'es' : ''} in the box`);
  if (r.applied) bits.push(r.applied.join(', '));
  if (r.typed) bits.push(JSON.stringify(r.typed));
  if (r.paragraphs) bits.push(`${r.paragraphs} paragraph(s)`);
  if (r.from !== undefined) bits.push(`${r.from} → ${r.to}`);
  if (r.layout && r.action === 'layout') bits.push(r.layout);
  return `${r.step}. ${bits.join(': ')}`;
}

function deckLine(title, id, account) {
  return `"${title || 'Untitled'}" — ${slidesEditUrl(id, account)}`;
}

// ----------------------------------------------------------- human typing

/** A part of a typing plan is at most this long, so one page run stays well inside the extension's limits. */
export const TYPE_PART_MS = 90_000;
/** Longer than this is several slides_type calls (MCP clients time out). */
const MAX_TYPE_MS = 9 * 60_000;

const blockMs = (b) => (b.before || 0) + (b.keys || []).reduce((n, e) => n + (e.d || 0), 0);

/** The text a list of plan keys leaves behind (characters, Backspaces, pastes). */
function keysText(keys) {
  let t = [];
  for (const e of keys || []) {
    if (e.c !== undefined) t.push(e.c);
    else if (e.k === 'Backspace') t.pop();
    else if (e.p !== undefined) t.push(...(e.x || ''));
  }
  return t.join('');
}

/**
 * Split a typing plan into parts of at most `budgetMs`. Parts break between
 * paragraphs, or inside a long paragraph at the plan's safe points (a word
 * just ended and no bold/italic is open); such a part continues its
 * paragraph (`cont`). Each part records the list depth it starts at and the
 * text it types.
 */
export function splitPlan(blocks, budgetMs = TYPE_PART_MS) {
  const parts = [];
  let depth = 0;
  let cur = null;
  const open = () => (cur = { blocks: [], ms: 0, level: depth });
  const flush = () => {
    if (cur?.blocks.length) parts.push(cur);
    cur = null;
  };
  const add = (b, ms) => {
    if (!cur) open();
    cur.blocks.push(b);
    cur.ms += ms;
  };
  for (const b of blocks) {
    const ms = blockMs(b);
    if (cur && cur.blocks.length && cur.ms + ms > budgetMs) flush();
    if (ms <= budgetMs) {
      add(b, ms);
    } else {
      let piece = { ...b, keys: [] };
      let pm = b.before || 0;
      for (const e of b.keys || []) {
        piece.keys.push(e);
        pm += e.d || 0;
        if (e.s && pm >= budgetMs) {
          add(piece, pm);
          flush();
          piece = { ...b, before: 0, keys: [], cont: true };
          pm = 0;
        }
      }
      if (piece.keys.length) add(piece, pm);
    }
    depth = b.t === 'li' ? b.depth || 0 : 0;
  }
  flush();
  for (const p of parts) p.text = p.blocks.map((b) => keysText(b.keys)).join('\n');
  return parts;
}

function duration(ms) {
  const sec = Math.max(0, Math.round((ms || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

// --------------------------------------------------------------- handlers

export async function callSlidesTool(name, args = {}, transport) {
  switch (name) {
    case 'slides_list': {
      const query = str(args.query, 'query')?.trim() || '';
      const limit = int(args.limit, 'limit', { min: 1, max: 50, dflt: 20 });
      const account = normalizeAccount(args.account);
      const r = await transport.call('slides_list', { query, limit, account }, { timeout: 60_000 });
      if (!r.items.length) return query ? `No presentations match "${query}".` : 'No recent presentations found.';
      const rows = r.items.map((it, i) => {
        const meta = [it.modified && `${/^(opened|modified|shared)\b/i.test(it.modified) ? '' : 'modified '}${it.modified}`, it.owner && `owner ${it.owner}`, it.shared && 'shared'].filter(Boolean).join(', ');
        return `${i + 1}. ${it.title} — ${it.id}${meta ? ` (${meta})` : ''}`;
      });
      return `${r.items.length} presentation(s)${query ? ` matching "${query}"` : ' (recent)'}:\n${rows.join('\n')}`;
    }

    case 'slides_read': {
      const { id, account } = deckArgs(args);
      const format = args.format ?? 'outline';
      if (!['outline', 'text', 'json'].includes(format)) throw bad('format must be outline, text or json');
      const offset = int(args.offset, 'offset', { min: 0, dflt: 0 });
      const maxChars = int(args.maxChars, 'maxChars', { min: 1000, max: 200_000, dflt: 40_000 });
      const r = await transport.call('slides_deck', { id, account }, { timeout: 120_000 });
      let deck = r.deck;
      const total = deck.slides.length;
      if (args.slides !== undefined) {
        const want = parseSlideRange(args.slides, total);
        deck = { ...deck, slides: deck.slides.filter((s) => want.has(s.index)) };
        if (!deck.slides.length) throw bad(`no slides match ${JSON.stringify(args.slides)}; the deck has ${total}`);
      }
      const body = format === 'json' ? JSON.stringify(deck, null, 1) : format === 'text' ? deckText(deck) : deckOutline(deck, { title: r.title, total });
      const slice = body.slice(offset, offset + maxChars);
      const end = offset + slice.length;
      const head = [
        `${r.title ? `"${r.title}" ` : ''}(${id}) · ${format} · ${total} slide(s)${args.slides !== undefined ? `, showing ${deck.slides.map((s) => s.index).join(',')}` : ''} · ${body.length} chars`,
        end < body.length ? `showing ${offset}-${end}; call again with offset=${end} for more` : offset ? `showing ${offset}-${end} (end)` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return `${head}\n\n${slice}`;
    }

    case 'slides_write': {
      const base = deckArgs(args);
      const { runs, lines } = await writeSlides(transport, { id: base.id, account: base.account }, args.slides);
      const title = runs.map((r) => r.title).find(Boolean);
      const verified = runs.every((r) => !r.verification || r.verification.verified);
      const notVerified = runs.filter((r) => r.verification && !r.verification.verified).map(runSummary);
      const count = runs[runs.length - 1]?.slides?.length;
      return [`Wrote ${deckLine(title, base.id, base.account)}${count ? ` (${count} slides now)` : ''}`, ...lines.map((l) => `- ${l}`), verified ? 'verified in Drive' : notVerified.join('\n')].join('\n');
    }

    case 'slides_create': {
      const title = str(args.title, 'title', { required: true, allowEmpty: false }).trim();
      const account = normalizeAccount(args.account);
      const template = str(args.template, 'template')?.trim();
      let created;
      if (template) {
        let ref;
        try {
          ref = parseDeckRef(template);
        } catch (err) {
          throw bad(`template: ${err.message}`);
        }
        created = await transport.call('slides_copy', { id: ref.id, account, title }, { timeout: 150_000 });
      } else {
        created = await transport.call('slides_create', { title, account }, { timeout: 120_000 });
      }
      const head = [`Created "${template ? created.title || title : title}"${template ? ' from the template' : ''} — ${created.url}`, `id: ${created.id}`];
      if (!template && created.titleVerified === false) head.push('the title may not have saved; check it (slides_rename)');
      if (!args.slides?.length) return head.join('\n');
      let specs = args.slides;
      if (!template && specs[0] && specs[0].slide === undefined && specs[0].after === undefined) {
        // A new deck already has a title slide: the first entry fills it.
        const { layout, ...rest } = specs[0];
        specs = [{ slide: 1, ...(layout && !/^title slide$/i.test(layout) ? { layout } : {}), ...rest }, ...specs.slice(1)];
      }
      try {
        const { runs, lines } = await writeSlides(transport, { id: created.id, account }, specs);
        const verified = runs.every((r) => !r.verification || r.verification.verified);
        return [...head, ...lines.map((l) => `- ${l}`), verified ? 'verified in Drive' : runs.filter((r) => r.verification && !r.verification.verified).map(runSummary).join('\n')].join('\n');
      } catch (err) {
        err.message = `the deck was created (${created.url}) but filling it failed: ${err.message}`;
        throw err;
      }
    }

    case 'slides_replace': {
      const { id, account } = deckArgs(args);
      const pairs = [];
      if (args.replacements !== undefined) {
        if (args.find !== undefined || args.replace !== undefined) throw bad('pass find + replace, or replacements, not both');
        if (!args.replacements || typeof args.replacements !== 'object') throw bad('replacements must be an object of find → replace');
        for (const [k, v] of Object.entries(args.replacements)) {
          if (!k) throw bad('replacements keys must be non-empty');
          if (typeof v !== 'string') throw bad(`replacements[${JSON.stringify(k)}] must be a string`);
          pairs.push([k, v]);
        }
        if (!pairs.length) throw bad('replacements is empty');
        if (args.occurrence !== undefined) throw bad('occurrence applies to a single find');
      } else {
        pairs.push([str(args.find, 'find', { required: true, allowEmpty: false }), str(args.replace, 'replace', { required: true })]);
      }
      const matchCase = args.matchCase ?? args.replacements !== undefined;
      const occurrence = args.occurrence === undefined ? null : int(args.occurrence, 'occurrence', { min: -1 });
      if (occurrence === 0) throw bad('occurrence is 1-based (1 = first, -1 = last)');
      const r = await transport.call(
        'slides_replace',
        { id, account, pairs: pairs.map(([find, replace]) => ({ find, replace })), matchCase: !!matchCase, regex: !!args.regex, occurrence },
        { timeout: 60_000 + pairs.length * 25_000 }
      );
      const v = r.verification;
      const lines = (r.results || []).map((d) =>
        d.replaced ? `✓ ${JSON.stringify(d.find)} → ${JSON.stringify(d.replace)} (${d.replaced}${occurrence ? ` of ${d.matches}` : '×'})` : `✗ ${JSON.stringify(d.find)} not found`
      );
      const missing = (r.results || []).filter((d) => !d.replaced).length;
      if (pairs.length === 1 && missing) return `No matches for ${JSON.stringify(pairs[0][0])} in ${deckLine(r.title, id, account)}`;
      return [`Replaced in ${deckLine(r.title, id, account)}`, ...lines, v ? runSummary(r) : 'nothing replaced', missing && pairs.length > 1 ? `${missing} search text(s) not found.` : null].filter(Boolean).join('\n');
    }

    case 'slides_edit': {
      const base = deckArgs(args);
      const usesRoles = Array.isArray(args.steps) && args.steps.some((s) => typeof s?.shape === 'string');
      const deck = usesRoles ? (await transport.call('slides_deck', { id: base.id, account: base.account }, { timeout: 120_000 })).deck : null;
      const steps = compileEditSteps(args.steps, new SlideSim(deck));
      let r;
      try {
        r = await transport.call('slides_run', { id: base.id, account: base.account, steps }, { timeout: 330_000 });
      } catch (err) {
        err.message = `${err.message} — steps before the failing one were applied; read the deck (slides_read) to see its state`;
        throw err;
      }
      return `Edited ${deckLine(r.title, base.id, base.account)}\n${r.results.map(stepLine).join('\n')}\n${runSummary(r)}`;
    }

    case 'slides_copy': {
      const { id, account } = deckArgs(args);
      const title = str(args.title, 'title')?.trim() || undefined;
      const r = await transport.call('slides_copy', { id, account, title }, { timeout: 150_000 });
      return `Copied to "${r.title || title || 'Copy'}" — ${r.url}\nid: ${r.id}`;
    }

    case 'slides_rename': {
      const { id, account } = deckArgs(args);
      const title = str(args.title, 'title', { required: true, allowEmpty: false }).trim();
      const r = await transport.call('slides_rename', { id, account, title }, { timeout: 60_000 });
      return r.verified ? `Renamed to "${title}" — ${r.url}` : `Rename sent but the new title was not confirmed — ${r.url}`;
    }

    case 'slides_export': {
      const { id, account } = deckArgs(args);
      const format = str(args.format, 'format', { required: true });
      const spec = SLIDES_EXPORT_FORMATS[format];
      if (!spec) throw bad(`format must be one of ${Object.keys(SLIDES_EXPORT_FORMATS).join(', ')}`);
      let path = str(args.path, 'path', { required: true, allowEmpty: false });
      if (!isAbsolute(path)) throw bad('path must be absolute');
      path = resolve(path);
      if (!path.toLowerCase().endsWith(`.${spec.ext}`)) path += `.${spec.ext}`;
      if (existsSync(path) && !args.overwrite) throw bad(`${path} already exists; pass overwrite: true to replace it`);
      const slide = int(args.slide, 'slide', { min: 1 });
      if (slide !== undefined && !spec.page) throw bad(`slide only applies to png, jpeg and svg; ${format} exports the whole deck`);
      let page = null;
      if (spec.page) {
        // Image exports take the editor's page id; the editor knows them.
        const live = await transport.call('slides_shapes', { id, account }, { timeout: 90_000 });
        const n = slide ?? 1;
        page = live.slides[n - 1]?.pageId;
        if (!page) throw bad(`slide ${n} does not exist; the deck has ${live.slides.length}`);
      }
      const r = await transport.call('slides_export', { id, account, format, page }, { timeout: 180_000 });
      const bytes = Buffer.from(r.base64, 'base64');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return `Saved ${r.title ? `"${r.title}" ` : ''}${spec.page ? `slide ${slide ?? 1} ` : ''}as ${format} to ${path} (${bytes.length.toLocaleString()} bytes)`;
    }

    case 'slides_open': {
      const { id, account, page: linked } = deckArgs(args);
      const slide = int(args.slide, 'slide', { min: 1 });
      let page = linked;
      if (slide !== undefined) {
        const live = await transport.call('slides_shapes', { id, account }, { timeout: 90_000 });
        page = live.slides[slide - 1]?.pageId;
        if (!page) throw bad(`slide ${slide} does not exist; the deck has ${live.slides.length}`);
      }
      const r = await transport.call('slides_open', { id, account, page }, { timeout: 30_000 });
      return `Opened ${r.url} in Chrome`;
    }

    case 'slides_type': {
      const base = deckArgs(args);
      const slide = int(args.slide, 'slide');
      if (slide === undefined || slide === 0) throw bad('slide is required (1-based; -1 = last)');
      const target = args.shape ?? 'body';
      if (!(Number.isInteger(target) && target >= 1) && !['title', 'subtitle', 'body', 'notes'].includes(target)) throw bad('shape must be "title", "subtitle", "body", "notes" or a shape number');
      const mode = args.mode ?? 'replace';
      if (!['replace', 'append'].includes(mode)) throw bad('mode must be replace or append');
      const markdown = str(args.markdown, 'markdown');
      const text = str(args.text, 'text');
      if (markdown !== undefined && text !== undefined) throw bad('pass markdown or text, not both');
      if (!(markdown ?? text)?.trim()) throw bad('markdown or text is required');
      if ((markdown ?? text).length > 20_000) throw bad('at most 20,000 characters per slides_type');
      let c;
      try {
        // One paragraph per line, as in slides_write: markdown would join
        // adjacent lines, so they get a blank line between; plain text already
        // splits on each line break.
        const lines = (src, sep) => src.split(/\r?\n/).filter((l) => l.trim()).join(sep);
        c = toTypingContent(markdown !== undefined ? { markdown: lines(markdown, '\n\n') } : { text: lines(text, '\n') });
      } catch (err) {
        throw bad(err.message);
      }
      if (c.blocks.some((b) => !b.runs)) throw bad('slides_type types text and lists; tables, images and rules cannot be typed into a slide');
      if (args.wpm !== undefined && (typeof args.wpm !== 'number' || args.wpm < MIN_WPM || args.wpm > MAX_WPM)) throw bad(`wpm must be a number from ${MIN_WPM} to ${MAX_WPM}`);
      if (args.typos !== undefined && typeof args.typos !== 'boolean' && (typeof args.typos !== 'number' || args.typos < 0 || args.typos > MAX_TYPO_RATE)) throw bad(`typos must be true/false or a rate from 0 to ${MAX_TYPO_RATE}`);
      if (args.pauses !== undefined && (typeof args.pauses !== 'number' || args.pauses < 0 || args.pauses > 3)) throw bad('pauses must be a number from 0 to 3');
      let settings;
      try {
        settings = typingSettings({ profile: args.profile ?? 'natural', wpm: args.wpm, typos: args.typos === true ? undefined : args.typos, pauses: args.pauses, seed: args.seed });
      } catch (err) {
        throw bad(err.message);
      }
      // Parts resume at the end of the shape's text, so every word end is a safe place to stop.
      const plan = planTyping(c.blocks, settings, { byEnd: true });
      if (plan.totalMs > MAX_TYPE_MS) throw bad(`that is about ${duration(plan.totalMs)} of typing at ${settings.wpm} wpm; split it into calls of under ${duration(MAX_TYPE_MS)}`);
      let where;
      if (target === 'notes') where = { notesFocus: true };
      else if (Number.isInteger(target)) where = { shape: { index: target } };
      else {
        const r = await transport.call('slides_deck', { id: base.id, account: base.account }, { timeout: 120_000 });
        const sim = new SlideSim(r.deck);
        sim.go(slide);
        where = { shape: sim.role(target) };
      }
      const parts = splitPlan(plan.blocks);
      const runs = [];
      const started = Date.now();
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const steps = [{ slide: { index: slide } }, where, { typeText: { mode: i === 0 ? mode : 'append', blocks: part.blocks, level: part.level, text: part.text } }];
        let r;
        try {
          r = await transport.call('slides_run', { id: base.id, account: base.account, steps }, { timeout: part.ms + 150_000 });
        } catch (err) {
          err.message = `${err.message}${i ? ` (parts 1-${i} of ${parts.length} were typed and verified)` : ''} — read the slide (slides_read) before typing the rest`;
          throw err;
        }
        runs.push(r);
        if (r.verification && !r.verification.verified) break;
      }
      const last = runs[runs.length - 1];
      const typedParts = runs.length;
      const pace = `${settings.wpm} wpm (${settings.profile}${settings.typoRate ? `, ~${Math.round(settings.typoRate * 1000) / 10}% typos` : ', no typos'})`;
      const shapeName = target === 'notes' ? 'the speaker notes' : Number.isInteger(target) ? `shape ${target}` : `the ${target}`;
      const lines = [
        `Typed ${c.text.length.toLocaleString()} characters into ${shapeName} of slide ${slide} in ${deckLine(last?.title, base.id, base.account)} in ${duration(Date.now() - started)} at ${pace}${plan.typos ? `; ${plan.typos} typo(s) made and corrected` : ''}${parts.length > 1 ? ` (${typedParts} of ${parts.length} parts)` : ''}.`,
        runs.every((r) => !r.verification || r.verification.verified) && typedParts === parts.length ? 'verified in Drive' : runSummary(last),
      ];
      return lines.join('\n');
    }

    default:
      throw bad(`unknown tool: ${name}`);
  }
}

export { slideTitle };
