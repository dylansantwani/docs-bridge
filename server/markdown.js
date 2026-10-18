/**
 * Markdown (or plain text) → the payload the extension pastes into Docs.
 *
 * The HTML is shaped by what Docs' paste handler actually honours, checked
 * live: it keeps h1-h6, p, strong/em, links, lists, tables and <hr>, but drops
 * <code> styling (so code becomes an explicit Courier New span) and trims a
 * leading space in HTML (so edge spaces become &nbsp;).
 *
 * Besides the HTML, the payload says:
 *   - inlineHtml: set when the content is a single paragraph, so text anchored
 *     mid-line is spliced in rather than breaking the line;
 *   - lastKind: what the last block is, so the page knows how to remove the
 *     trailing empty paragraph a block paste leaves;
 *   - probes: short runs of plain text that must appear in the saved document
 *     for the write to count as verified.
 */

import { Marked, Lexer } from './vendor/marked.esm.js';

import { decode } from './structure.js';

const MONO = `font-family:'Courier New',monospace`;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export function htmlToText(html) {
  return decode(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|h[1-6]|li|tr|blockquote|pre|table|ul|ol)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' ')
      .replace(/<hr\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export const norm = (s) =>
  String(s ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Leading/trailing spaces survive a Docs paste only as &nbsp;. */
function keepEdgeSpaces(html, source) {
  const lead = source.match(/^[ \t]*/)[0].length;
  const trail = source.match(/[ \t]*$/)[0].length;
  if (lead === source.length) return html;
  return '&nbsp;'.repeat(lead) + html + '&nbsp;'.repeat(trail);
}

function makeMarked() {
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  marked.use({
    renderer: {
      codespan({ text }) {
        return `<span style="${MONO}">${text}</span>`;
      },
      code({ text }) {
        const lines = String(text).replace(/\n$/, '').split('\n');
        return lines
          .map((line) => {
            const body = escapeHtml(line).replace(/ /g, '&nbsp;').replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
            return `<p><span style="${MONO}">${body || '&nbsp;'}</span></p>`;
          })
          .join('');
      },
      checkbox({ checked }) {
        return checked ? '☑ ' : '☐ ';
      },
    },
  });
  return marked;
}

const marked = makeMarked();

function kindOf(token) {
  switch (token?.type) {
    case 'heading':
      return 'heading';
    case 'list':
      return 'list';
    case 'table':
      return 'table';
    case 'hr':
      return 'hr';
    case 'code':
      return 'code';
    default:
      return 'p';
  }
}

export function pickProbes(text) {
  const all = text.split('\n').map(norm).filter(Boolean);
  // Prefer lines long enough to be distinctive, but never return nothing for
  // non-empty content: an empty probe list would verify vacuously.
  const long = all.filter((l) => l.length >= 2);
  const lines = long.length ? long : all;
  if (!lines.length) return [];
  const clip = (l) => (l.length > 60 ? l.slice(0, 60).replace(/\s+\S*$/, '') || l.slice(0, 60) : l);
  const picks = [lines[0], lines[Math.floor(lines.length / 2)], lines[lines.length - 1]].map(clip);
  return [...new Set(picks)];
}

const PAGEBREAK = /^(?:\\pagebreak|<!--\s*page ?break\s*-->)$/i;
const monoLine = (line) => {
  const body = escapeHtml(line).replace(/ /g, '&nbsp;').replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
  return `<span style="${MONO}">${body || '&nbsp;'}</span>`;
};

/** Inline markdown (bold, italic, code, links) → inline HTML for typing. */
export function toInlineHtml(markdown) {
  return marked.parseInline(String(markdown ?? ''));
}

function listItems(token, depth, out) {
  const kind = token.ordered ? 'numbered' : 'bullet';
  for (const item of token.items) {
    const own = item.task ? 'checklist' : kind;
    const parts = [];
    for (const t of item.tokens || []) {
      if (t.type === 'list') continue;
      if (t.type === 'text' || t.type === 'paragraph') parts.push(toInlineHtml(t.text.replace(/^\[[ xX]\]\s+/, '')));
    }
    out.push({ t: 'li', list: own, depth, html: parts.join(' ') });
    for (const t of item.tokens || []) if (t.type === 'list') listItems(t, depth + 1, out);
  }
}

/** Text width of a Letter page with 1 in margins, in points. */
const PAGE_TEXT_PT = 468;

/**
 * Give every pasted table explicit column widths and cell borders. Docs sizes
 * a pasted table without widths from its content, so a table of empty cells
 * (to be typed into afterwards) arrives with 0 pt columns, one character per
 * line, and without borders (observed live 2026-10-13).
 */
export function sizeTables(html) {
  return String(html).replace(/<table>([\s\S]*?)<\/table>/g, (_, inner) => {
    const firstRow = (inner.match(/<tr>([\s\S]*?)<\/tr>/) || [])[1] || '';
    const cols = (firstRow.match(/<t[hd][\s>]/g) || []).length || 1;
    const width = Math.floor((PAGE_TEXT_PT / cols) * 10) / 10;
    const cells = inner.replace(/<(t[hd])((?:\s[^>]*)?)>/g, (m, tag, attrs) => `<${tag}${attrs} style="width:${width}pt;border:1px solid #000000;padding:5pt">`);
    return `<table style="border-collapse:collapse;width:${PAGE_TEXT_PT}pt">${cells}</table>`;
  });
}

/**
 * Markdown tokens → the blocks the page types one at a time (typeBlocks in
 * docs-page.js). Typing, rather than pasting block HTML, is what lets new
 * content take the document's own heading, body and list styles.
 */
export function toTypedBlocks(tokens) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading':
        out.push({ t: 'h', level: t.depth, html: toInlineHtml(t.text) });
        break;
      case 'paragraph': {
        const raw = t.text.trim();
        if (PAGEBREAK.test(raw)) out.push({ t: 'pagebreak' });
        else if (t.tokens?.length === 1 && t.tokens[0].type === 'image') {
          const img = t.tokens[0];
          out.push({ t: 'img', html: `<img src="${escapeHtml(img.href)}" alt="${escapeHtml(img.text || '')}">` });
        } else out.push({ t: 'p', html: toInlineHtml(t.text) });
        break;
      }
      case 'list':
        listItems(t, 0, out);
        break;
      case 'code':
        for (const line of String(t.text).replace(/\n$/, '').split('\n')) out.push({ t: 'code', html: monoLine(line) });
        break;
      case 'blockquote':
        for (const inner of t.tokens || []) {
          if (inner.type === 'paragraph') out.push({ t: 'quote', html: toInlineHtml(inner.text) });
          else if (inner.type !== 'space') out.push(...toTypedBlocks([inner]));
        }
        break;
      case 'table':
        out.push({ t: 'table', html: sizeTables(marked.parser([t]).replace(/\n(?=<)/g, '').trim()) });
        break;
      case 'hr':
        out.push({ t: 'hr', html: '<hr>' });
        break;
      case 'html':
        if (PAGEBREAK.test(t.text.trim())) out.push({ t: 'pagebreak' });
        else out.push({ t: 'html', html: t.text.trim() });
        break;
      default:
        if (t.text) out.push({ t: 'p', html: toInlineHtml(t.text) });
    }
  }
  return out;
}

/**
 * @param {{markdown?: string, text?: string}} input exactly one of the two
 */
export function toDocsContent({ markdown, text }) {
  if (typeof markdown === 'string' && typeof text === 'string') {
    throw new Error('pass either markdown or text, not both');
  }

  if (typeof text === 'string') {
    const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
    const single = paragraphs.length === 1;
    const html = paragraphs.map((p) => `<p>${escapeHtml(p) || '<br>'}</p>`).join('');
    return {
      html,
      inlineHtml: single ? keepEdgeSpaces(escapeHtml(text.trim()), text) : null,
      blocks: paragraphs.map((p) => ({ t: 'p', html: escapeHtml(p) })),
      text,
      lastKind: 'p',
      probes: pickProbes(text),
    };
  }

  if (typeof markdown !== 'string') throw new Error('markdown or text is required');
  const source = markdown.replace(/\r\n?/g, '\n');
  const tokens = marked.lexer(source);
  const blocks = tokens.filter((t) => t.type !== 'space');
  if (!blocks.length) throw new Error('the content is empty');

  const html = sizeTables(marked.parser(tokens).replace(/\n(?=<)/g, '').trim());
  const plain = htmlToText(html);

  let inlineHtml = null;
  if (blocks.length === 1 && blocks[0].type === 'paragraph' && !source.trim().includes('\n\n')) {
    inlineHtml = keepEdgeSpaces(marked.parseInline(source.trim()), source);
  }

  return {
    html,
    inlineHtml,
    blocks: toTypedBlocks(tokens),
    text: plain,
    lastKind: kindOf(blocks[blocks.length - 1]),
    probes: pickProbes(plain),
  };
}

// ----------------------------------------------------------- human typing

/**
 * Inline markdown → runs of text with the formatting a typist toggles
 * (bold, italic, strikethrough) or cannot type (links, code: pasted).
 */
export function inlineRuns(tokens) {
  const out = [];
  const push = (run) => {
    const prev = out[out.length - 1];
    const same = (a, b) => ['b', 'i', 's', 'u', 'code', 'href', 'html'].every((k) => (a[k] ?? null) === (b[k] ?? null));
    if (prev && !run.html && same(prev, run)) prev.text += run.text;
    else out.push(run);
  };
  const walk = (list, fmt) => {
    for (const t of list || []) {
      switch (t.type) {
        case 'strong':
          walk(t.tokens, { ...fmt, b: true });
          break;
        case 'em':
          walk(t.tokens, { ...fmt, i: true });
          break;
        case 'del':
          walk(t.tokens, { ...fmt, s: true });
          break;
        case 'codespan':
          push({ ...fmt, text: decode(t.text), code: true });
          break;
        case 'link': {
          const text = htmlToText(marked.parseInline(t.text)) || t.href;
          push({ text, href: t.href });
          break;
        }
        case 'image':
          push({ text: '', html: `<img src="${escapeHtml(t.href)}" alt="${escapeHtml(t.text || '')}">` });
          break;
        case 'br':
          push({ ...fmt, text: ' ' });
          break;
        case 'html':
          push({ ...fmt, text: decode(String(t.text).replace(/<[^>]+>/g, '')) });
          break;
        case 'text':
        case 'escape':
        default:
          if (t.tokens?.length) walk(t.tokens, fmt);
          else if (t.text) push({ ...fmt, text: t.type === 'escape' ? t.text : decode(t.text) });
      }
    }
  };
  walk(tokens, {});
  const clean = out.filter((r) => r.text || r.html);
  for (const r of clean) for (const k of Object.keys(r)) if (r[k] === false || r[k] === undefined) delete r[k];
  return clean;
}

const lexInline = (text) => inlineRuns(Lexer.lexInline(String(text ?? ''), { gfm: true }));

function typingListItems(token, depth, out) {
  const kind = token.ordered ? 'numbered' : 'bullet';
  for (const item of token.items) {
    const own = item.task ? 'checklist' : kind;
    const runs = [];
    for (const t of item.tokens || []) {
      if (t.type === 'list' || !['text', 'paragraph'].includes(t.type)) continue;
      if (runs.length) runs.push({ text: ' ' });
      runs.push(...lexInline(t.text.replace(/^\[[ xX]\]\s+/, '')));
    }
    out.push({ t: 'li', list: own, depth, runs });
    for (const t of item.tokens || []) if (t.type === 'list') typingListItems(t, depth + 1, out);
  }
}

function typingBlocks(tokens) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading':
        out.push({ t: 'h', level: t.depth, runs: lexInline(t.text) });
        break;
      case 'paragraph': {
        const raw = t.text.trim();
        if (PAGEBREAK.test(raw)) out.push({ t: 'pagebreak' });
        else if (t.tokens?.length === 1 && t.tokens[0].type === 'image') out.push(...toTypedBlocks([t]));
        else out.push({ t: 'p', runs: lexInline(t.text) });
        break;
      }
      case 'list':
        typingListItems(t, 0, out);
        break;
      case 'code':
        for (const line of String(t.text).replace(/\n$/, '').split('\n')) out.push({ t: 'code', runs: line ? [{ text: line, code: true }] : [] });
        break;
      case 'blockquote':
        for (const inner of t.tokens || []) {
          if (inner.type === 'paragraph') out.push({ t: 'quote', runs: lexInline(inner.text) });
          else if (inner.type !== 'space') out.push(...typingBlocks([inner]));
        }
        break;
      case 'table':
      case 'hr':
      case 'html':
        out.push(...toTypedBlocks([t]));
        break;
      default:
        if (t.text) out.push({ t: 'p', runs: lexInline(t.text) });
    }
  }
  return out;
}

/**
 * Content for docs_type: blocks whose inline content is runs of text (typed
 * key by key) rather than HTML, plus whether it is a single paragraph (typed
 * inline at an anchor rather than as a new paragraph), its plain text, and
 * the probes that must show in the saved document afterwards.
 *
 * @param {{markdown?: string, text?: string}} input
 */
export function toTypingContent({ markdown, text }) {
  if (typeof markdown === 'string' && typeof text === 'string') throw new Error('pass either markdown or text, not both');
  let blocks;
  let inline;
  if (typeof text === 'string') {
    const paragraphs = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    blocks = paragraphs.map((p) => ({ t: 'p', runs: p ? [{ text: p }] : [] }));
    inline = paragraphs.length === 1;
  } else {
    if (typeof markdown !== 'string') throw new Error('markdown or text is required');
    const source = markdown.replace(/\r\n?/g, '\n');
    const tokens = marked.lexer(source);
    const real = tokens.filter((t) => t.type !== 'space');
    if (!real.length) throw new Error('the content is empty');
    blocks = typingBlocks(tokens);
    inline = real.length === 1 && real[0].type === 'paragraph' && !source.trim().includes('\n\n') && blocks.length === 1 && blocks[0].t === 'p';
  }
  const plain = blocks
    .map((b) => (b.runs ? b.runs.map((r) => r.text).join('') : b.html ? htmlToText(b.html) : ''))
    .join('\n');
  if (!norm(plain) && !blocks.some((b) => !b.runs)) throw new Error('the content is empty');
  return { blocks, inline, text: plain, probes: pickProbes(plain) };
}
