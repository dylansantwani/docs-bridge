/**
 * MCP tool definitions and handlers.
 *
 * The server owns argument validation, markdown conversion, pagination of
 * long reads and writing exported files to disk. The extension owns every
 * browser-side step. Handlers return plain strings shaped for a model to read.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { parseDocRef, normalizeAccount, editUrl, EXPORT_FORMATS } from '../extension/lib/refs.js';
import { toDocsContent, toInlineHtml, htmlToText, toTypingContent } from './markdown.js';
import { typingSettings, planTyping, TYPING_PROFILES, MIN_WPM, MAX_WPM, MAX_TYPO_RATE } from '../extension/lib/typing.js';
import { structureFromHtml } from './structure.js';
import { SLIDES_TOOLS, SLIDES_INSTRUCTIONS, SLIDES_TOOL_NAMES, callSlidesTool } from './slides.js';

const ACCOUNT = {
  description:
    'Which signed-in Google account to use: an index as in /u/N/ URLs (0 = first account) or an email address. ' +
    'Omit for the browser default. Use this for documents owned by a second (e.g. school) account.',
  oneOf: [{ type: 'integer', minimum: 0, maximum: 9 }, { type: 'string' }],
};
const DOC = { type: 'string', description: 'Google Docs URL or document id.' };

const WRITE_MODES = ['append', 'prepend', 'replace_document', 'insert_after', 'insert_before', 'replace_text', 'replace_section'];
const ANCHORED = new Set(['insert_after', 'insert_before', 'replace_text', 'replace_section']);

const FORMAT = {
  type: 'object',
  description: 'Formatting to apply to the selection. Toggles take true/false.',
  properties: {
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    strikethrough: { type: 'boolean' },
    superscript: { type: 'boolean' },
    subscript: { type: 'boolean' },
    style: { type: 'string', enum: ['normal', 'title', 'subtitle', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'], description: "Paragraph style, using the document's own style definitions." },
    align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
    list: { type: 'string', enum: ['bullet', 'numbered', 'checklist', 'none'] },
    indent: { type: 'integer', minimum: -10, maximum: 10, description: 'Indent steps: positive = more, negative = less.' },
    lineSpacing: { type: 'number', enum: [1, 1.15, 1.5, 2] },
    size: { type: 'number', minimum: 1, maximum: 400, description: 'Font size in points.' },
    font: { type: 'string', description: "Font family as named in Docs' font menu, e.g. Georgia, Roboto, Times New Roman." },
    color: { type: 'string', description: 'Text colour: a Docs palette name (red, dark blue 2, light green 3, …) or a hex like #1a73e8.' },
    highlight: { type: 'string', description: 'Highlight colour: palette name, hex, or "none".' },
    link: { type: 'string', description: 'URL to link the selected text to; empty string removes the link.' },
    clear: { type: 'boolean', description: 'Clear formatting (Cmd+\\).' },
  },
  additionalProperties: false,
};
const FORMAT_KEYS = new Set(Object.keys(FORMAT.properties));

const STEP = {
  type: 'object',
  description:
    'One action. Selection: find, caret, select, extend, section. Changes: insert, text, delete, format, key, menu, undo, redo.',
  properties: {
    find: {
      description: 'Select text: a string, or {text, occurrence, matchCase, regex}.',
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { text: { type: 'string' }, occurrence: { type: 'integer' }, matchCase: { type: 'boolean' }, regex: { type: 'boolean' } },
          required: ['text'],
          additionalProperties: false,
        },
      ],
    },
    caret: {
      description: "Move the caret: 'start' | 'end' | 'paragraph_start' | 'paragraph_end' | 'line_start' | 'line_end', or {after: text} / {before: text} (with optional occurrence).",
      oneOf: [
        { type: 'string', enum: ['start', 'end', 'paragraph_start', 'paragraph_end', 'line_start', 'line_end'] },
        { type: 'object', properties: { after: { type: 'string' }, before: { type: 'string' }, occurrence: { type: 'integer' } }, additionalProperties: false },
      ],
    },
    select: { type: 'string', enum: ['paragraph', 'all', 'to_paragraph_end', 'to_paragraph_start'], description: 'Select around the caret.' },
    extend: {
      type: 'object',
      description: 'Grow the selection: {paragraphs|words|chars: n}; negative goes backwards.',
      properties: { paragraphs: { type: 'integer' }, words: { type: 'integer' }, chars: { type: 'integer' } },
      additionalProperties: false,
    },
    section: {
      description: 'Select the body of a section (everything under a heading until the next heading of the same or higher level): heading text, or {heading, occurrence}.',
      oneOf: [{ type: 'string' }, { type: 'object', properties: { heading: { type: 'string' }, occurrence: { type: 'integer' } }, required: ['heading'], additionalProperties: false }],
    },
    insert: { type: 'string', description: "Markdown blocks to type at the caret (replacing any selection), in the document's own styles." },
    text: { type: 'string', description: 'Inline markdown to type at the caret or over the selection, keeping the surrounding style (e.g. overwrite a template field).' },
    delete: { type: 'boolean', description: 'Delete the selection (or the character before the caret).' },
    format: FORMAT,
    key: { type: 'string', description: 'Press a key: Enter, Tab, Backspace, Delete, Escape, ArrowUp/Down/Left/Right, Home, End, a letter or digit.' },
    mods: {
      type: 'object',
      description: 'Modifiers for key. mod = Cmd on macOS, Ctrl elsewhere.',
      properties: { mod: { type: 'boolean' }, shift: { type: 'boolean' }, alt: { type: 'boolean' } },
      additionalProperties: false,
    },
    times: { type: 'integer', minimum: 1, maximum: 200, description: 'Repeat count for key.' },
    menu: { type: 'string', description: 'Run a menu command by its path, e.g. "Insert > Table of contents > With blue links", "Format > Table > Insert row below", "Insert > Break > Page break".' },
    undo: { type: 'integer', minimum: 1, maximum: 50 },
    redo: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
};

export const SERVER_INSTRUCTIONS = `Google Docs and Google Slides through the user's own signed-in Chrome (the Docs Bridge extension). No API keys or OAuth: it operates the real Docs editor in a background tab the way a person does — selecting text, typing, using shortcuts, the toolbar and the menus — so it can do what the user can, with their access.

Reading
- docs_read: markdown by default; format "structure" gives an outline (title, headings/sections, numbered and bulleted items with nesting, tables with cells, images, and placeholders like {{name}} or [Date]) — read that before editing a document or template.
- docs_list: recent documents or a Drive search.

Editing
- docs_write: add markdown by position — append, prepend, replace_document, next to an exact text anchor (insert_after, insert_before, replace_text), or replace a whole section's body under a heading (replace_section, anchor = heading text). New content is typed in the document's own styles, so it matches templates.
- docs_format: format existing text — bold/italic/underline/strikethrough, font, size, colour, highlight, link, paragraph style (heading1-6, title, subtitle, normal), alignment, lists, indent, line spacing.
- docs_edit: anything else, as a sequence of human steps — select text (find), move the caret, select paragraphs or a section, type, delete, press keys (Tab moves between table cells), format, and run any menu command by path (e.g. "Format > Table > Insert row below", "Insert > Table of contents > With blue links").
- docs_replace: Docs' own find and replace across the document.
- docs_type: type text like a person — keystroke by keystroke at a human pace (default ~55 wpm), with natural pauses and the occasional typo fixed with Backspace — at the same positions as docs_write. Long text runs as a background job in Chrome; check it, pause, resume or cancel it with docs_typing. Use docs_write when speed matters and docs_type when the typing itself should look human.

Templates
- docs_templates lists Google's template gallery; docs_create with template (a gallery name or any document) makes a named copy; docs_copy copies any document.
- docs_fill fills a template: exact text replacements (placeholders or sample text, keeping their formatting) and whole sections by heading.

Every change is checked against the document as saved in Drive; "verified" means Drive shows it (text and, for formatting, the formatting). If a result says NOT verified, read the document before retrying so nothing is applied twice. With two signed-in Google accounts (e.g. personal and school) pass account: 0/1 or an email.
${SLIDES_INSTRUCTIONS}`;

export const TOOLS = [
  {
    name: 'docs_status',
    description: 'Check that the Chrome extension is connected and report the bridge state. Call this first when another docs_* tool fails with a connection error.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'docs_list',
    description: 'List Google Docs: recent documents, or a Drive search when query is given. Returns titles, ids, owners and modified dates.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Drive search text (matches titles and content). Omit for recently opened documents.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
        account: ACCOUNT,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'docs_read',
    description: 'Read a Google Doc: markdown (default), text, html, or "structure" — an outline of titles, headings/sections, list items, tables with cells and placeholders, for planning edits. Long documents are paged with offset/maxChars.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        format: { type: 'string', enum: ['markdown', 'text', 'html', 'structure'], description: 'Default markdown. "structure" = outline for targeting edits (headings/sections, lists, tables, placeholders).' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to start from, for paging. Default 0.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Default 40000.' },
        account: ACCOUNT,
      },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_write',
    description:
      "Write markdown (or plain text) into a Google Doc, typed in the document's own styles. Modes: append, prepend, replace_document (overwrites the body), insert_after / insert_before / replace_text (relative to an exact anchor snippet; replace_text with empty text deletes it), replace_section (anchor = heading text; replaces everything under that heading up to the next heading of the same or higher level). Markdown: headings, bold/italic/code/links, bullet/numbered/task lists with nesting, quotes, code blocks, tables, rules, images (![alt](url)), and \\pagebreak on its own line. The result says whether Drive has the change.",
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        mode: { type: 'string', enum: WRITE_MODES },
        markdown: { type: 'string', description: 'Content as markdown. Use this or text.' },
        text: { type: 'string', description: 'Content as literal plain text (no markdown interpretation). Use this or markdown.' },
        anchor: { type: 'string', description: 'insert_after / insert_before / replace_text: exact text already in the document (case-insensitive unless matchCase). replace_section: the heading text.' },
        occurrence: { type: 'integer', minimum: -1, description: 'Which match of the anchor: 1 = first (default), 2 = second, -1 = last.' },
        matchCase: { type: 'boolean', description: 'Anchor matching is case-sensitive. Default false.' },
        asBlock: { type: 'boolean', description: 'insert_after / insert_before: put even a one-paragraph payload in its own new paragraph instead of splicing it inline.' },
        account: ACCOUNT,
      },
      required: ['doc', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_replace',
    description: "Find and replace across a whole Google Doc using Docs' own Find and replace (keeps surrounding formatting). Returns how many were replaced.",
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        find: { type: 'string' },
        replace: { type: 'string', description: 'Replacement text (plain). Empty string deletes every match.' },
        matchCase: { type: 'boolean', description: 'Default false.' },
        regex: { type: 'boolean', description: 'Treat find as a regular expression (Docs/RE2 syntax). Default false.' },
        account: ACCOUNT,
      },
      required: ['doc', 'find', 'replace'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_format',
    description:
      'Format existing text in a Google Doc like a person would: select a target (exact text, a section under a heading, or the whole document) and apply bold/italic/underline/strikethrough, font, size, colour, highlight, link, paragraph style, alignment, list, indent or line spacing. Verified against the saved document.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        text: { type: 'string', description: 'Exact text to format (use this, section, or all).' },
        occurrence: { type: 'integer', minimum: -1, description: 'Which match of text: 1 = first (default), -1 = last.' },
        matchCase: { type: 'boolean' },
        section: { type: 'string', description: 'Heading text: formats the paragraphs under that heading.' },
        all: { type: 'boolean', description: 'Format the whole document.' },
        format: FORMAT,
        account: ACCOUNT,
      },
      required: ['doc', 'format'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_edit',
    description:
      'Edit a Google Doc as a sequence of human steps in the real editor: select text (find) or move the caret, select paragraphs/sections, type markdown or inline text, delete, press keys (Tab moves between table cells), format, run any menu command by path, undo. Use it for anything docs_write/docs_format do not cover — table rows and columns, page breaks, table of contents, headers, etc. Steps run in order in one tab; the result reports each step and whether Drive shows the changes.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        steps: { type: 'array', minItems: 1, maxItems: 60, items: STEP },
        account: ACCOUNT,
      },
      required: ['doc', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_type',
    description:
      "Type into a Google Doc like a person: one keystroke at a time in the real editor, at a human pace with natural rhythm, pauses between sentences and paragraphs, and occasional typos corrected with Backspace. Same positions as docs_write (append, prepend, replace_document, insert_after/insert_before/replace_text an anchor, replace_section). Markdown headings, lists and quotes are set with Docs' own shortcuts, bold/italic/strikethrough are toggled with Cmd+B/I/Shift+X as you type; links, code and emoji are pasted. Short text finishes before this returns; longer text keeps typing in the background (in Chrome, even if this call ends) — the result gives a job id for docs_typing and an ETA. Speed: 55 wpm types ~275 characters a minute.",
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        mode: { type: 'string', enum: WRITE_MODES, description: 'Where to type. Default append.' },
        markdown: { type: 'string', description: 'Content as markdown. Use this or text.' },
        text: { type: 'string', description: 'Content as literal plain text; each line break starts a new paragraph. Use this or markdown.' },
        anchor: { type: 'string', description: 'insert_after / insert_before / replace_text: exact text already in the document. replace_section: the heading text.' },
        occurrence: { type: 'integer', minimum: -1, description: 'Which match of the anchor: 1 = first (default), -1 = last.' },
        matchCase: { type: 'boolean' },
        asBlock: { type: 'boolean', description: 'insert_after / insert_before: type even one paragraph as its own new paragraph instead of inline.' },
        profile: { type: 'string', enum: Object.keys(TYPING_PROFILES), description: `Typing style: ${Object.entries(TYPING_PROFILES).map(([k, v]) => `${k} (${v.wpm} wpm, ${v.typoRate ? `${Math.round(v.typoRate * 1000) / 10}% typos` : 'no typos'})`).join(', ')}. Default natural.` },
        wpm: { type: 'number', minimum: MIN_WPM, maximum: MAX_WPM, description: 'Typing speed in words per minute (overrides the profile).' },
        typos: { description: `Mistakes that get corrected: false for none, or a rate per letter (0-${MAX_TYPO_RATE}, e.g. 0.02 = 2%). Overrides the profile.`, oneOf: [{ type: 'boolean' }, { type: 'number', minimum: 0, maximum: MAX_TYPO_RATE }] },
        pauses: { type: 'number', minimum: 0, maximum: 3, description: 'Scale for thinking pauses between sentences and paragraphs: 0 = none, 1 = natural (default), 2 = a slow, thoughtful writer.' },
        seed: { type: 'integer', minimum: 0, description: 'Make the rhythm and typos reproducible.' },
        wait: { type: 'boolean', description: 'Wait for the typing to finish before returning. Default: wait only when it takes under 2 minutes.' },
        account: ACCOUNT,
      },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_typing',
    description: 'Check or control docs_type jobs: status (progress, ETA, verification), list, pause, resume, cancel. A paused or interrupted job resumes where it stopped. Without job, acts on the most recent one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list', 'pause', 'resume', 'cancel', 'wait'], description: 'Default status. wait = block until the job finishes (up to 10 minutes).' },
        job: { type: 'string', description: 'Job id from docs_type.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'docs_fill',
    description:
      'Fill in a template document. replace: exact text → new text for placeholders or sample text (every occurrence, keeping its formatting). sections: heading text → markdown that replaces everything under that heading, typed in the template\'s styles. Reports each item.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        replace: { type: 'object', additionalProperties: { type: 'string' }, description: 'e.g. {"{{name}}": "Dylan", "Wendy Writer, CEO": "Dylan Santwani, Founder"}' },
        sections: { type: 'object', additionalProperties: { type: 'string' }, description: 'e.g. {"Attendees": "- Dylan\\n- Pat", "Notes": "Shipped the bridge."}' },
        matchCase: { type: 'boolean', description: 'Case-sensitive matching for replace. Default true.' },
        account: ACCOUNT,
      },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_templates',
    description: "List Google Docs' template gallery (resumes, letters, reports, proposals, meeting notes, newsletters, …) with names and styles, for docs_create's template.",
    inputSchema: { type: 'object', properties: { account: ACCOUNT }, additionalProperties: false },
  },
  {
    name: 'docs_copy',
    description: 'Make a copy of a Google Doc (Docs\' own "Make a copy") with a new title. Returns the copy\'s URL.',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, title: { type: 'string' }, account: ACCOUNT },
      required: ['doc'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_create',
    description:
      'Create a new Google Doc with a title — blank with an optional markdown/text body, or from a template: a gallery template name (see docs_templates, e.g. "Meeting notes" or "Resume (Coral)") or any document to copy. Fill a template afterwards with docs_fill.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        template: { type: 'string', description: 'Gallery template name, or a Google Docs URL/id to copy.' },
        markdown: { type: 'string', description: 'Initial body as markdown (blank documents only).' },
        text: { type: 'string', description: 'Initial body as plain text (blank documents only).' },
        account: ACCOUNT,
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_rename',
    description: 'Rename a Google Doc (change its title as shown in Drive).',
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, title: { type: 'string' }, account: ACCOUNT },
      required: ['doc', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_export',
    description: 'Download a Google Doc to a local file as docx, pdf, odt, rtf, epub, markdown, text or html.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: DOC,
        format: { type: 'string', enum: Object.keys(EXPORT_FORMATS) },
        path: { type: 'string', description: 'Absolute file path to write. The extension is added if missing.' },
        overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' },
        account: ACCOUNT,
      },
      required: ['doc', 'format', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_open',
    description: "Open a Google Doc in a foreground Chrome tab for the user to look at. Doesn't change the document.",
    inputSchema: {
      type: 'object',
      properties: { doc: DOC, account: ACCOUNT },
      required: ['doc'],
      additionalProperties: false,
    },
  },
];

TOOLS.push(...SLIDES_TOOLS);

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

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

function int(v, name, { min, max, dflt }) {
  if (v === undefined || v === null) return dflt;
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n)) throw bad(`${name} must be an integer`);
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}

function content(args, { allowEmptyForDelete = false } = {}) {
  const markdown = str(args.markdown, 'markdown');
  const text = str(args.text, 'text');
  if (markdown !== undefined && text !== undefined) throw bad('pass markdown or text, not both');
  const value = markdown ?? text;
  if (value === undefined || value === '') {
    if (allowEmptyForDelete) return null;
    throw bad('markdown or text is required');
  }
  return markdown !== undefined ? toDocsContent({ markdown }) : toDocsContent({ text });
}

function docArgs(args) {
  const { id, tab } = parseDocRef(args.doc);
  return { id, tab, account: normalizeAccount(args.account) };
}

function verifiedLine(v) {
  if (!v) return '';
  if (v.verified === true) return 'verified in Drive';
  if (v.verified === false) {
    const missing = v.unchanged
      ? ' (the saved document did not change at all)'
      : v.missing?.length
        ? ` (not yet seen: ${v.missing.map((m) => JSON.stringify(m)).join(', ')})`
        : '';
    return `NOT verified: Drive did not show the change within ${v.waitedSeconds ?? '?'}s${missing}. Read the document before retrying so the edit is not applied twice.`;
  }
  return '';
}

function validateFormat(f, where = 'format') {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad(`${where} must be an object`);
  const keys = Object.keys(f);
  if (!keys.length) throw bad(`${where} is empty`);
  for (const k of keys) if (!FORMAT_KEYS.has(k)) throw bad(`${where}.${k} is not a formatting option; use ${[...FORMAT_KEYS].join(', ')}`);
  return f;
}

const SELECTING = new Set(['find', 'caret', 'select', 'extend', 'section']);
const STEP_ACTIONS = new Set(['find', 'caret', 'select', 'extend', 'section', 'insert', 'text', 'delete', 'format', 'key', 'menu', 'undo', 'redo']);

/**
 * Translate model-facing steps into page steps, and work out what the saved
 * document must show afterwards: typed text (probes) and formatting on known
 * text (a format that follows a literal find or typed text).
 */
export function compileSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw bad('steps must be a non-empty array');
  if (steps.length > 60) throw bad('at most 60 steps per call');
  const out = [];
  const expect = { probes: [], formats: [] };
  let known = null;
  steps.forEach((step, i) => {
    const where = `steps[${i}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw bad(`${where} must be an object`);
    const actions = Object.keys(step).filter((k) => STEP_ACTIONS.has(k));
    const extras = Object.keys(step).filter((k) => !STEP_ACTIONS.has(k) && !['mods', 'times'].includes(k));
    if (extras.length) throw bad(`${where} has unknown field(s) ${extras.join(', ')}`);
    if (actions.length !== 1) throw bad(`${where} must have exactly one action (${[...STEP_ACTIONS].join(', ')}); got ${actions.join(', ') || 'none'}`);
    const action = actions[0];
    const v = step[action];
    switch (action) {
      case 'find': {
        const f = typeof v === 'string' ? { text: v } : v;
        if (!f || typeof f.text !== 'string' || !f.text) throw bad(`${where}.find needs text`);
        if (f.text.includes('\n')) throw bad(`${where}.find text must be within one paragraph`);
        out.push({ find: { text: f.text, occurrence: f.occurrence ?? 1, matchCase: !!f.matchCase, regex: !!f.regex } });
        known = f.regex ? null : f.text;
        break;
      }
      case 'insert': {
        if (typeof v !== 'string' || !v.trim()) throw bad(`${where}.insert must be non-empty markdown`);
        const c = toDocsContent({ markdown: v });
        out.push({ type: c.blocks });
        expect.probes.push(...c.probes);
        known = null;
        break;
      }
      case 'text': {
        if (typeof v !== 'string' || !v) throw bad(`${where}.text must be a non-empty string`);
        if (v.includes('\n')) throw bad(`${where}.text is inline; use insert for multiple paragraphs`);
        const html = toInlineHtml(v);
        out.push({ inline: html });
        const plain = htmlToText(html);
        if (plain.trim()) expect.probes.push(plain.trim().slice(0, 60));
        known = plain.trim() || null;
        break;
      }
      case 'format':
        validateFormat(v, `${where}.format`);
        out.push({ format: v });
        if (known) expect.formats.push({ text: known, format: v });
        break;
      case 'key':
        if (typeof v !== 'string' || !v) throw bad(`${where}.key must be a key name`);
        out.push({ key: v, ...(step.mods ? { mods: step.mods } : {}), ...(step.times ? { times: step.times } : {}) });
        known = null;
        break;
      case 'section':
        out.push({ section: typeof v === 'string' ? { heading: v } : v });
        known = null;
        break;
      case 'delete':
        out.push({ delete: true });
        known = null;
        break;
      default:
        out.push({ [action]: v });
        // A menu command (e.g. Format > Text > Strikethrough) acts on the
        // same selection; anything else moves or changes it.
        if (action !== 'menu') known = null;
    }
  });
  return { steps: out, expect };
}

function stepSummary(results = []) {
  return results
    .map((r) => {
      const bits = [r.action];
      if (r.matches) bits.push(`${r.matches} match${r.matches > 1 ? 'es' : ''}`);
      if (r.applied) bits.push(r.applied.join(', '));
      if (r.blocks) bits.push(`${r.blocks} block(s) typed`);
      if (r.paragraphs !== undefined) bits.push(`${r.paragraphs} paragraph(s)`);
      return `${r.step}. ${bits.join(': ')}`;
    })
    .join('\n');
}

function editVerifiedLine(v) {
  if (!v) return 'no document changes to verify';
  if (v.verified) return 'verified in Drive';
  const why = [v.unchanged && 'the saved document did not change', v.missing?.length && `not yet seen: ${v.missing.map((m) => JSON.stringify(m)).join(', ')}`, v.unmet?.length && `formatting not seen: ${v.unmet.join('; ')}`]
    .filter(Boolean)
    .join('; ');
  return `NOT verified after ${v.waitedSeconds ?? '?'}s (${why || 'unknown'}). Read the document before retrying so nothing is applied twice.`;
}

async function resolveTemplate(template, account, transport) {
  try {
    return { id: parseDocRef(template).id, source: 'document' };
  } catch {
    // not a document reference: look it up in the gallery
  }
  const { items } = await transport.call('templates', { account }, { timeout: 60_000 });
  const want = template.trim().toLowerCase();
  const label = (t) => `${t.name}${t.style ? ` (${t.style})` : ''}`;
  const exact = items.find((t) => label(t).toLowerCase() === want) || items.find((t) => t.name.toLowerCase() === want);
  const loose = exact || items.find((t) => label(t).toLowerCase().includes(want));
  if (!loose) throw bad(`no gallery template matches ${JSON.stringify(template)}; available: ${[...new Set(items.map(label))].join(', ')}`);
  return { id: loose.id, source: `gallery template "${label(loose)}"` };
}

function titled(r, id, account) {
  return `"${r.title || 'Untitled'}" — ${r.url || editUrl(id, account)}`;
}


const MAX_TYPED_CHARS = 60_000;
/** docs_type waits for jobs shorter than this; longer ones run in the background. */
export const AUTO_WAIT_MS = 120_000;
const MAX_WAIT_MS = 10 * 60_000;
const WAIT_POLL_MS = 2000;
const ACTIVE = new Set(['queued', 'running']);

/** Poll a typing job until it stops running or maxMs passes. */
export async function waitForJob(transport, job, maxMs, { pollMs = WAIT_POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = Date.now() + maxMs;
  let s = await transport.call('type_status', { job }, { timeout: 15_000 });
  while (ACTIVE.has(s.status) && Date.now() < end) {
    await sleep(pollMs);
    try {
      s = await transport.call('type_status', { job }, { timeout: 15_000 });
    } catch (err) {
      if (err.code !== 'timeout') throw err;
    }
  }
  return s;
}

export function duration(ms) {
  const sec = Math.max(0, Math.round((ms || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** One typing job, described for a model. */
export function typingLine(j, { started = false, brief = false } = {}) {
  const where = `"${j.title || 'Untitled'}" — ${j.url}`;
  const pace = j.settings ? `${j.settings.wpm} wpm (${j.settings.profile}${j.settings.typoRate ? `, ~${Math.round(j.settings.typoRate * 1000) / 10}% typos` : ', no typos'})` : '';
  const chars = `${(j.charsTyped || 0).toLocaleString()}/${(j.totalChars || 0).toLocaleString()} chars`;
  if (brief) return `${j.job} ${j.status} ${j.percent}% ${chars} · ${where}${j.error ? ` · ${j.error}` : ''}`;
  const lines = [];
  switch (j.status) {
    case 'queued':
    case 'running':
      lines.push(
        `${started ? 'Typing' : 'Still typing'} into ${where}`,
        `job ${j.job}: ${j.percent}% · ${chars} · ${pace} · about ${duration(j.remainingMs)} left (planned ${duration(j.plannedMs)} in total)`,
        'It keeps typing in Chrome in the background. docs_typing status / pause / cancel with this job id; do not edit the same spot meanwhile.'
      );
      break;
    case 'done': {
      const v = j.verification;
      lines.push(
        `Typed ${(j.totalChars || 0).toLocaleString()} characters into ${where} in ${duration(j.elapsedMs)} at ${pace}${j.typosPlanned ? `; ${j.typosPlanned} typo(s) made and corrected` : ''}.`,
        v?.verified ? 'verified in Drive' : `NOT verified: Drive did not show all of it within ${v?.waitedSeconds ?? '?'}s${v?.missing?.length ? ` (not seen: ${v.missing.map((m) => JSON.stringify(m)).join(', ')})` : ''}. Read the document before retrying.`
      );
      break;
    }
    case 'paused':
      lines.push(`Paused at ${j.percent}% (${chars}) in ${where}. docs_typing resume job ${j.job} continues from there.`);
      break;
    case 'cancelled':
      lines.push(`Cancelled at ${j.percent}% (${chars}) in ${where}. What was typed stays in the document.`);
      break;
    case 'interrupted':
      lines.push(`Interrupted at ${j.percent}% (${chars}) in ${where}: ${j.error || 'unknown reason'}`, `docs_typing resume job ${j.job} continues from the last confirmed point.`);
      break;
    default:
      lines.push(`Typing ${j.status} at ${j.percent}% (${chars}) in ${where}: ${j.error || 'unknown reason'}`);
  }
  return lines.join('\n');
}

/**
 * @param {string} name
 * @param {object} args
 * @param {{call: Function, status: Function}} transport
 */
export async function callTool(name, args = {}, transport) {
  switch (name) {
    case 'docs_status': {
      const hub = await transport.status();
      const lines = [`hub: ${hub.role === 'hub' && !hub.via ? 'this process' : 'shared'} on 127.0.0.1:${hub.port} (pid ${hub.pid}, ${hub.peers} peer server(s))`];
      if (!hub.extensions?.length) {
        const { NO_EXTENSION } = await import('./hub.js');
        lines.push(`extension: not connected. ${NO_EXTENSION}`);
        return lines.join('\n');
      }
      for (const e of hub.extensions) lines.push(`extension: "${e.label}" v${e.version}, connected since ${e.connectedAt}`);
      try {
        const s = await transport.call('status', {}, { timeout: 10_000 });
        lines.push(`chrome: ${s.managedTabs} bridge tab(s) open${s.userAgent ? `, ${s.userAgent}` : ''}`);
        for (const t of s.tabs || []) {
          const acct = t.account === null || t.account === undefined ? '' : ` (account ${t.account})`;
          const doing = t.doing ? `busy: ${t.doing} for ${t.forSeconds}s` : 'idle';
          lines.push(`  ${t.kind === 'presentation' ? 'slides ' : ''}${t.doc}${acct}: ${doing}${t.tabAgeSeconds !== null && t.tabAgeSeconds !== undefined ? `, tab ${t.tabAgeSeconds}s old` : ''}`);
        }
      } catch (err) {
        lines.push(`extension did not answer a status call: ${err.message}`);
      }
      return lines.join('\n');
    }

    case 'docs_list': {
      const query = str(args.query, 'query')?.trim() || '';
      const limit = int(args.limit, 'limit', { min: 1, max: 50, dflt: 20 });
      const account = normalizeAccount(args.account);
      const r = await transport.call('list', { query, limit, account }, { timeout: 60_000 });
      if (!r.items.length) return query ? `No Google Docs match "${query}".` : 'No recent Google Docs found.';
      const rows = r.items.map((it, i) => {
        const meta = [it.modified && `modified ${it.modified}`, it.owner && `owner ${it.owner}`].filter(Boolean).join(', ');
        return `${i + 1}. ${it.title} — ${it.id}${meta ? ` (${meta})` : ''}`;
      });
      return `${r.items.length} document(s)${query ? ` matching "${query}"` : ' (recent)'}${r.source ? ` via ${r.source}` : ''}:\n${rows.join('\n')}`;
    }

    case 'docs_read': {
      const { id, tab, account } = docArgs(args);
      const format = args.format ?? 'markdown';
      if (!['markdown', 'text', 'html', 'structure'].includes(format)) throw bad('format must be markdown, text, html or structure');
      const offset = int(args.offset, 'offset', { min: 0, dflt: 0 });
      const maxChars = int(args.maxChars, 'maxChars', { min: 1000, max: 200_000, dflt: 40_000 });
      const r = await transport.call('read', { id, tab, account, format: format === 'structure' ? 'html' : format }, { timeout: 90_000 });
      const body = format === 'structure' ? structureFromHtml(String(r.content ?? '')).outline : String(r.content ?? '');
      const slice = body.slice(offset, offset + maxChars);
      const end = offset + slice.length;
      const head = [
        `${r.title ? `"${r.title}" ` : ''}(${id}) · ${format}${r.via && r.via !== 'export' ? ` via ${r.via}` : ''} · ${body.length} chars`,
        end < body.length ? `showing ${offset}-${end}; call again with offset=${end} for more` : offset ? `showing ${offset}-${end} (end)` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return `${head}\n\n${slice}`;
    }

    case 'docs_write': {
      const { id, account } = docArgs(args);
      const mode = str(args.mode, 'mode', { required: true });
      if (!WRITE_MODES.includes(mode)) throw bad(`mode must be one of ${WRITE_MODES.join(', ')}`);
      const anchored = ANCHORED.has(mode);
      const anchor = str(args.anchor, 'anchor', { required: anchored, allowEmpty: false });
      if (!anchored && anchor !== undefined) throw bad(`anchor only applies to insert_after, insert_before, replace_text and replace_section`);
      if (anchor && anchor.includes('\n')) throw bad('anchor must be text within a single paragraph (no newlines)');
      const occurrence = int(args.occurrence, 'occurrence', { min: -1, dflt: 1 });
      if (occurrence === 0) throw bad('occurrence is 1-based (1 = first, -1 = last)');
      const payload = content(args, { allowEmptyForDelete: mode === 'replace_text' });
      const r = await transport.call(
        'write',
        { id, account, mode, content: payload, anchor, occurrence, matchCase: !!args.matchCase, asBlock: !!args.asBlock },
        { timeout: 120_000 }
      );
      const what = payload === null ? `Deleted ${JSON.stringify(anchor)}` : `${mode.replace(/_/g, ' ')}${mode === 'replace_section' ? ` "${anchor}"` : ''} done`;
      const anchorNote = r.anchorMatches > 1 && occurrence === 1 ? ` (anchor matched ${r.anchorMatches} times; used the first — pass occurrence to pick another)` : '';
      return `${what}${anchorNote} in ${titled(r, id, account)}\n${verifiedLine(r.verification)}`.trim();
    }

    case 'docs_replace': {
      const { id, account } = docArgs(args);
      const find = str(args.find, 'find', { required: true, allowEmpty: false });
      const replace = str(args.replace, 'replace', { required: true });
      const r = await transport.call('replace', { id, account, find, replace, matchCase: !!args.matchCase, regex: !!args.regex }, { timeout: 90_000 });
      if (!r.replaced) return `No matches for ${JSON.stringify(find)} in ${titled(r, id, account)}`;
      return `Replaced ${r.replaced} match(es) of ${JSON.stringify(find)} in ${titled(r, id, account)}\n${verifiedLine(r.verification)}`.trim();
    }

    case 'docs_type': {
      const { id, account } = docArgs(args);
      const mode = str(args.mode, 'mode') ?? 'append';
      if (!WRITE_MODES.includes(mode)) throw bad(`mode must be one of ${WRITE_MODES.join(', ')}`);
      const anchored = ANCHORED.has(mode);
      const anchor = str(args.anchor, 'anchor', { required: anchored, allowEmpty: false });
      if (!anchored && anchor !== undefined) throw bad('anchor only applies to insert_after, insert_before, replace_text and replace_section');
      if (anchor && anchor.includes('\n')) throw bad('anchor must be text within a single paragraph (no newlines)');
      const occurrence = int(args.occurrence, 'occurrence', { min: -1, dflt: 1 });
      if (occurrence === 0) throw bad('occurrence is 1-based (1 = first, -1 = last)');
      const markdown = str(args.markdown, 'markdown');
      const text = str(args.text, 'text');
      if (markdown !== undefined && text !== undefined) throw bad('pass markdown or text, not both');
      if (!(markdown ?? text)) throw bad('markdown or text is required (to delete text, use docs_write replace_text)');
      if ((markdown ?? text).length > MAX_TYPED_CHARS) throw bad(`at most ${MAX_TYPED_CHARS.toLocaleString()} characters per docs_type (that is hours of typing); split it up`);
      let c;
      try {
        c = toTypingContent(markdown !== undefined ? { markdown } : { text });
      } catch (err) {
        throw bad(err.message);
      }
      if (args.wpm !== undefined && (typeof args.wpm !== 'number' || args.wpm < MIN_WPM || args.wpm > MAX_WPM)) throw bad(`wpm must be a number from ${MIN_WPM} to ${MAX_WPM}`);
      if (args.typos !== undefined && typeof args.typos !== 'boolean' && (typeof args.typos !== 'number' || args.typos < 0 || args.typos > MAX_TYPO_RATE)) throw bad(`typos must be true/false or a rate from 0 to ${MAX_TYPO_RATE}`);
      if (args.pauses !== undefined && (typeof args.pauses !== 'number' || args.pauses < 0 || args.pauses > 3)) throw bad('pauses must be a number from 0 to 3');
      let settings;
      try {
        settings = typingSettings({ profile: args.profile ?? 'natural', wpm: args.wpm, typos: args.typos === true ? undefined : args.typos, pauses: args.pauses, seed: args.seed });
      } catch (err) {
        throw bad(err.message);
      }
      const byEnd = mode === 'append' || mode === 'replace_document';
      const plan = planTyping(c.blocks, settings, { byEnd });
      const position = { mode, anchor, occurrence, matchCase: !!args.matchCase, asBlock: !!args.asBlock, inline: c.inline && !args.asBlock };
      const started = await transport.call(
        'type_start',
        { id, account, position, plan, probes: c.probes, byEnd, text: c.text, settings: { profile: settings.profile, wpm: settings.wpm, typoRate: settings.typoRate, pauses: settings.pauses, seed: settings.seed } },
        { timeout: 30_000 }
      );
      const wait = args.wait ?? plan.totalMs <= AUTO_WAIT_MS;
      if (!wait) return typingLine(started, { started: true });
      const done = await waitForJob(transport, started.job, Math.min(MAX_WAIT_MS, plan.totalMs * 2 + 90_000));
      return typingLine(done, { started: true });
    }

    case 'docs_typing': {
      const action = str(args.action, 'action') ?? 'status';
      const job = str(args.job, 'job', { allowEmpty: false });
      switch (action) {
        case 'status':
          return typingLine(await transport.call('type_status', { job }, { timeout: 15_000 }));
        case 'wait': {
          const s = await transport.call('type_status', { job }, { timeout: 15_000 });
          return typingLine(await waitForJob(transport, s.job, Math.min(MAX_WAIT_MS, (s.remainingMs || 0) * 2 + 90_000)));
        }
        case 'list': {
          const { jobs } = await transport.call('type_list', {}, { timeout: 15_000 });
          if (!jobs.length) return 'No typing jobs.';
          return jobs.map((j) => typingLine(j, { brief: true })).join('\n');
        }
        case 'pause':
        case 'resume':
        case 'cancel':
          return typingLine(await transport.call('type_control', { job, action }, { timeout: 45_000 }));
        default:
          throw bad('action must be status, wait, list, pause, resume or cancel');
      }
    }

    case 'docs_create': {
      const title = str(args.title, 'title', { required: true, allowEmpty: false }).trim();
      const account = normalizeAccount(args.account);
      const template = str(args.template, 'template')?.trim();
      if (template) {
        if (args.markdown !== undefined || args.text !== undefined) throw bad('a template copy keeps the template body; fill it afterwards with docs_fill or docs_write');
        const t = await resolveTemplate(template, account, transport);
        const r = await transport.call('copy', { id: t.id, account, title }, { timeout: 150_000 });
        return `Created "${r.title || title}" from ${t.source} — ${r.url}\nid: ${r.id}\nNext: docs_read format "structure" to see its sections and sample text, then docs_fill.`;
      }
      const payload = args.markdown !== undefined || args.text !== undefined ? content(args) : null;
      const r = await transport.call('create', { title, account, content: payload }, { timeout: 120_000 });
      const notes = [];
      if (!r.titleVerified) notes.push('the title may not have saved; check it');
      if (payload) notes.push(verifiedLine(r.verification));
      return `Created "${title}" — ${r.url}\nid: ${r.id}${notes.length ? `\n${notes.filter(Boolean).join('\n')}` : ''}`;
    }

    case 'docs_edit': {
      const { id, account } = docArgs(args);
      const { steps, expect } = compileSteps(args.steps);
      let r;
      try {
        r = await transport.call('edit', { id, account, steps, expect }, { timeout: 300_000 });
      } catch (err) {
        err.message = `${err.message}${err.code === 'find_stalled' ? '' : ' — steps before the failing one were applied; read the document to see its state'}`;
        throw err;
      }
      return `Edited ${titled(r, id, account)}\n${stepSummary(r.results)}\n${editVerifiedLine(r.verification)}`;
    }

    case 'docs_format': {
      const { id, account } = docArgs(args);
      const format = validateFormat(args.format);
      const targets = ['text', 'section', 'all'].filter((k) => args[k] !== undefined && args[k] !== false);
      if (targets.length !== 1) throw bad('pass exactly one target: text, section or all');
      let steps;
      if (args.text !== undefined) {
        const t = str(args.text, 'text', { allowEmpty: false });
        steps = [{ find: { text: t, occurrence: int(args.occurrence, 'occurrence', { min: -1, dflt: 1 }), matchCase: !!args.matchCase } }, { format }];
      } else if (args.section !== undefined) {
        steps = [{ section: str(args.section, 'section', { allowEmpty: false }) }, { format }];
      } else {
        steps = [{ select: 'all' }, { format }];
      }
      const compiled = compileSteps(steps);
      const r = await transport.call('edit', { id, account, ...compiled }, { timeout: 180_000 });
      const applied = r.results?.find((x) => x.applied)?.applied || [];
      return `Formatted ${targets[0] === 'text' ? JSON.stringify(args.text) : targets[0] === 'section' ? `section "${args.section}"` : 'the whole document'} in ${titled(r, id, account)}: ${applied.join(', ')}\n${editVerifiedLine(r.verification)}`;
    }

    case 'docs_fill': {
      const { id, account } = docArgs(args);
      const replace = args.replace ?? {};
      const sections = args.sections ?? {};
      if (typeof replace !== 'object' || typeof sections !== 'object') throw bad('replace and sections must be objects');
      const pairs = Object.entries(replace);
      const secs = Object.entries(sections);
      if (!pairs.length && !secs.length) throw bad('pass replace and/or sections');
      for (const [k, v] of pairs) {
        if (!k) throw bad('replace keys must be non-empty');
        if (typeof v !== 'string') throw bad(`replace[${JSON.stringify(k)}] must be a string`);
        if (v.includes('\n')) throw bad(`replace[${JSON.stringify(k)}] contains a line break; put multi-paragraph content in sections, or use docs_write replace_text`);
      }
      for (const [k, v] of secs) if (typeof v !== 'string' || !v.trim()) throw bad(`sections[${JSON.stringify(k)}] must be non-empty markdown`);
      const matchCase = args.matchCase !== false;
      const lines = [];
      let title = null;
      let failures = 0;
      for (const [find, value] of pairs) {
        try {
          const r = await transport.call('replace', { id, account, find, replace: value, matchCase, regex: false }, { timeout: 90_000 });
          title = r.title || title;
          lines.push(r.replaced ? `✓ ${JSON.stringify(find)} → ${JSON.stringify(value)} (${r.replaced}×${r.verification && !r.verification.verified ? ', NOT verified' : ''})` : `✗ ${JSON.stringify(find)} not found`);
          if (!r.replaced || (r.verification && !r.verification.verified)) failures++;
        } catch (err) {
          failures++;
          lines.push(`✗ ${JSON.stringify(find)}: ${err.message}`);
        }
      }
      for (const [heading, markdown] of secs) {
        try {
          const r = await transport.call(
            'write',
            { id, account, mode: 'replace_section', content: toDocsContent({ markdown }), anchor: heading, occurrence: 1, matchCase: false },
            { timeout: 150_000 }
          );
          title = r.title || title;
          const ok = !r.verification || r.verification.verified;
          if (!ok) failures++;
          lines.push(`${ok ? '✓' : '✗'} section "${heading}" replaced${ok ? '' : ` (NOT verified: ${verifiedLine(r.verification)})`}`);
        } catch (err) {
          failures++;
          lines.push(`✗ section "${heading}": ${err.message}`);
        }
      }
      return `Filled "${title || id}" — ${editUrl(id, account)}\n${lines.join('\n')}${failures ? `\n${failures} item(s) need attention.` : ''}`;
    }

    case 'docs_templates': {
      const account = normalizeAccount(args.account);
      const { items } = await transport.call('templates', { account }, { timeout: 60_000 });
      const byName = new Map();
      for (const t of items) {
        if (!byName.has(t.name)) byName.set(t.name, []);
        if (t.style && !byName.get(t.name).includes(t.style)) byName.get(t.name).push(t.style);
      }
      const rows = [...byName.entries()].map(([name, styles]) => `- ${name}${styles.length ? ` — styles: ${styles.join(', ')}` : ''}`);
      return `${items.length} gallery templates. Use docs_create with template "<name>" or "<name> (<style>)":\n${rows.join('\n')}`;
    }

    case 'docs_copy': {
      const { id, account } = docArgs(args);
      const title = str(args.title, 'title')?.trim() || undefined;
      const r = await transport.call('copy', { id, account, title }, { timeout: 150_000 });
      return `Copied to "${r.title || title || 'Copy'}" — ${r.url}\nid: ${r.id}`;
    }

    case 'docs_rename': {
      const { id, account } = docArgs(args);
      const title = str(args.title, 'title', { required: true, allowEmpty: false }).trim();
      const r = await transport.call('rename', { id, account, title }, { timeout: 60_000 });
      return r.verified ? `Renamed to "${title}" — ${r.url}` : `Rename sent but the new title was not confirmed — ${r.url}`;
    }

    case 'docs_export': {
      const { id, tab, account } = docArgs(args);
      const format = str(args.format, 'format', { required: true });
      const spec = EXPORT_FORMATS[format];
      if (!spec) throw bad(`format must be one of ${Object.keys(EXPORT_FORMATS).join(', ')}`);
      let path = str(args.path, 'path', { required: true, allowEmpty: false });
      if (!isAbsolute(path)) throw bad('path must be absolute');
      path = resolve(path);
      if (!path.toLowerCase().endsWith(`.${spec.ext}`)) path += `.${spec.ext}`;
      if (existsSync(path) && !args.overwrite) throw bad(`${path} already exists; pass overwrite: true to replace it`);
      const r = await transport.call('export', { id, tab, account, format }, { timeout: 180_000 });
      const bytes = Buffer.from(r.base64, 'base64');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return `Saved ${r.title ? `"${r.title}" ` : ''}as ${format} to ${path} (${bytes.length.toLocaleString()} bytes)`;
    }

    case 'docs_open': {
      const { id, account } = docArgs(args);
      const r = await transport.call('open', { id, account }, { timeout: 30_000 });
      return `Opened ${r.url} in Chrome`;
    }

    default:
      if (SLIDES_TOOL_NAMES.has(name)) return callSlidesTool(name, args, transport);
      throw bad(`unknown tool: ${name}`);
  }
}
