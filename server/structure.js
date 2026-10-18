/**
 * A document outline built from Docs' HTML export, for agents that need to
 * target edits: headings and their sections, list items with nesting, tables
 * with cell coordinates, images, and fill-in placeholders.
 *
 * The export markup is machine-generated and regular (verified against real
 * exports): <p class="title">, <p class="subtitle">, <h1>-<h6>, lists as
 * <ul|ol class="lst-kix_<id>-<depth>">, tables of <tr>/<td><p>…</p></td>.
 */

// Named entities Docs' HTML export uses for typography and symbols. Numeric
// entities are decoded generically below; anything unlisted is left as-is.
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
  lsaquo: '\u2039', rsaquo: '\u203a', laquo: '\u00ab', raquo: '\u00bb', prime: '\u2032', Prime: '\u2033',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022', middot: '\u00b7', shy: '\u00ad',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7',
  micro: '\u00b5', para: '\u00b6', sect: '\u00a7', cent: '\u00a2', pound: '\u00a3', euro: '\u20ac', yen: '\u00a5',
  frac14: '\u00bc', frac12: '\u00bd', frac34: '\u00be', sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3',
  iexcl: '\u00a1', iquest: '\u00bf', dagger: '\u2020', Dagger: '\u2021', permil: '\u2030',
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194', rArr: '\u21d2', lArr: '\u21d0',
  le: '\u2264', ge: '\u2265', ne: '\u2260', asymp: '\u2248', infin: '\u221e', minus: '\u2212', radic: '\u221a',
};
// Accented Latin letters: &eacute; &Ntilde; &uuml; …
for (const [base, marks] of Object.entries({
  a: 'grave:0e0 acute:0e1 circ:0e2 tilde:0e3 uml:0e4 ring:0e5', e: 'grave:0e8 acute:0e9 circ:0ea uml:0eb',
  i: 'grave:0ec acute:0ed circ:0ee uml:0ef', o: 'grave:0f2 acute:0f3 circ:0f4 tilde:0f5 uml:0f6',
  u: 'grave:0f9 acute:0fa circ:0fb uml:0fc', n: 'tilde:0f1', y: 'acute:0fd uml:0ff', c: 'cedil:0e7',
})) {
  for (const pair of marks.split(' ')) {
    const [mark, hex] = pair.split(':');
    const lower = String.fromCodePoint(parseInt(hex, 16));
    ENT[base + mark] = lower;
    if (base !== 'y' || mark !== 'uml') ENT[base.toUpperCase() + mark] = String.fromCodePoint(parseInt(hex, 16) - 0x20);
  }
}
Object.assign(ENT, { Yuml: '\u0178', szlig: '\u00df', aelig: '\u00e6', AElig: '\u00c6', oslash: '\u00f8', Oslash: '\u00d8' });

export function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e] ?? ENT[e.toLowerCase()] ?? m;
  });
}

const text = (html) =>
  decode(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<img[^>]*>/gi, ' [image] ').replace(/<[^>]+>/g, ''))
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Placeholder conventions people use in templates. */
const PLACEHOLDER = /\{\{\s*[^{}]{1,60}?\s*\}\}|\[\[[^\][]{1,60}\]\]|\[(?:[A-Z][A-Za-z0-9 ,.'/&-]{1,58})\]|<<[^<>]{1,60}>>|_{4,}/g;

export function findPlaceholders(s) {
  const counts = new Map();
  for (const m of String(s).matchAll(PLACEHOLDER)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  return [...counts.entries()].map(([token, count]) => ({ token, count }));
}

function parseTable(html) {
  const rows = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => text(c[1]));
    rows.push(cells);
  }
  return rows;
}

/**
 * @param {string} html  Docs HTML export
 * @returns {{blocks: object[], tables: string[][][], placeholders: object[], images: number, outline: string}}
 */
export function structureFromHtml(html) {
  let body = String(html);
  const b = body.indexOf('<body');
  if (b !== -1) body = body.slice(body.indexOf('>', b) + 1);
  body = body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const images = (body.match(/<img\b/gi) || []).length;

  const tables = [];
  body = body.replace(/<table\b[\s\S]*?<\/table>/gi, (t) => {
    tables.push(parseTable(t));
    return `<x-table n="${tables.length}"></x-table>`;
  });

  const blocks = [];
  const re = /<(h[1-6]|p|li|x-table|hr)\b([^>]*)>([\s\S]*?)(?:<\/\1>|(?=<(?:h[1-6]|p|li|x-table|hr)\b)|$)/gi;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (tag === 'x-table') {
      const n = Number((attrs.match(/n="(\d+)"/) || [])[1]);
      blocks.push({ kind: 'table', n, rows: tables[n - 1] });
      continue;
    }
    if (tag === 'hr') {
      blocks.push({ kind: 'rule' });
      continue;
    }
    const t = text(m[3]);
    if (tag === 'li') {
      const before = body.slice(0, m.index);
      const open = Math.max(before.lastIndexOf('<ul'), before.lastIndexOf('<ol'));
      const listTag = body.slice(open, body.indexOf('>', open) + 1);
      blocks.push({
        kind: 'item',
        ordered: listTag.startsWith('<ol'),
        depth: Number((listTag.match(/lst-kix_[a-z0-9]+-(\d+)/) || [])[1] || 0),
        text: t,
      });
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      blocks.push({ kind: 'heading', level: Number(tag[1]), text: t });
      continue;
    }
    const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
    if (/\btitle\b/.test(cls)) blocks.push({ kind: 'title', text: t });
    else if (/\bsubtitle\b/.test(cls)) blocks.push({ kind: 'subtitle', text: t });
    else blocks.push({ kind: 'paragraph', text: t });
  }

  const allText = blocks.map((x) => x.text || (x.rows ? x.rows.flat().join(' ') : '')).join('\n');
  const placeholders = findPlaceholders(allText);

  const lines = [];
  const counters = [];
  for (const x of blocks) {
    switch (x.kind) {
      case 'title':
        lines.push(`Title: ${x.text}`);
        break;
      case 'subtitle':
        lines.push(`Subtitle: ${x.text}`);
        break;
      case 'heading':
        lines.push(`${'#'.repeat(x.level)} ${x.text}`);
        counters.length = 0;
        break;
      case 'item': {
        const pad = '  '.repeat(x.depth);
        counters.length = x.depth + 1;
        counters[x.depth] = (counters[x.depth] || 0) + 1;
        lines.push(`${pad}${x.ordered ? `${counters[x.depth]}.` : '•'} ${x.text}`);
        break;
      }
      case 'table':
        lines.push(`[table ${x.n}: ${x.rows.length} rows × ${Math.max(0, ...x.rows.map((r) => r.length))} cols]`);
        x.rows.forEach((r, i) => lines.push(`  r${i + 1}: ${r.map((c) => `[${c}]`).join(' ')}`));
        counters.length = 0;
        break;
      case 'rule':
        lines.push('---');
        break;
      default:
        if (x.text) lines.push(x.text);
        counters.length = 0;
    }
  }
  const footer = [];
  if (placeholders.length) footer.push(`placeholders: ${placeholders.map((p) => `${p.token}${p.count > 1 ? ` ×${p.count}` : ''}`).join(', ')}`);
  if (images) footer.push(`images: ${images}`);
  const outline = lines.join('\n') + (footer.length ? `\n\n${footer.join('\n')}` : '');
  return { blocks, tables, placeholders, images, outline };
}
