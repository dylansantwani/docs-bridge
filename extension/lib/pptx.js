/**
 * Read a .pptx (as exported by Google Slides) into a plain outline of the
 * deck: slides in order, each with its layout, shapes (text paragraphs with
 * list levels and inline formatting, tables, images) and speaker notes.
 *
 * Shared by the MCP server (slides_read) and the extension (verifying writes
 * against the saved deck), so it uses only what both have: Uint8Array,
 * TextDecoder and DecompressionStream('deflate-raw') — no Node or browser
 * APIs beyond those.
 *
 * Why .pptx and not the editor: the export is the deck as saved in Drive,
 * and it carries what the editor's SVG does not — placeholder roles (title,
 * subtitle, body), layout names, speaker notes and exact text with spaces.
 *
 * Shapes are listed in z-order, the same order the editor draws them in
 * (#editor-<page> children), so "shape N of slide M" means the same thing in
 * both. Object ids do not carry over: the export renumbers every object
 * ("Google Shape;54;p13" for the editor's i0 on page p), so they are kept only
 * as export-internal names.
 */

// ------------------------------------------------------------------- zip

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Central-directory zip reader: name → async () => Uint8Array. Stored and deflated entries only (all a .pptx uses). */
export function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record); the export may have returned an error page');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== CEN) throw new Error('corrupt zip central directory');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, async () => {
      if (view.getUint32(local, true) !== LOC) throw new Error(`corrupt zip entry ${name}`);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`unsupported zip compression ${method} for ${name}`);
    });
  }
  return entries;
}

// ------------------------------------------------------------------- xml

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A minimal XML tree: {name, attrs, children, text}. Enough for OOXML (no DTDs, no CDATA in practice). */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeXml(a[2] ?? a[3]);
      const node = { name: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      top.text += decodeXml(m[6]);
    }
  }
  return root;
}

const kids = (node, name) => (node?.children || []).filter((c) => !name || c.name === name);
const kid = (node, name) => (node?.children || []).find((c) => c.name === name) || null;
const path = (node, ...names) => names.reduce((n, name) => kid(n, name), node);
function* walk(node) {
  for (const c of node?.children || []) {
    yield c;
    yield* walk(c);
  }
}
const find = (node, name) => {
  for (const n of walk(node)) if (n.name === name) return n;
  return null;
};

// ------------------------------------------------------------- relations

function relsOf(xml) {
  const map = new Map();
  if (!xml) return map;
  for (const r of walk(parseXml(xml))) if (r.name === 'Relationship') map.set(r.attrs.Id, { target: r.attrs.Target, type: r.attrs.Type || '', external: r.attrs.TargetMode === 'External' });
  return map;
}

/** "slides/slide1.xml" relative to "ppt/" → "ppt/slides/slide1.xml"; handles "../". */
function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const relsPath = (part) => {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
};

// ----------------------------------------------------------------- shapes

const EMU_PER_PT = 12700;

/** Google's predefined layouts are exported under their API names; show what the Slide > Apply layout menu calls them. */
export const LAYOUT_NAMES = {
  TITLE: 'Title slide',
  SECTION_HEADER: 'Section header',
  TITLE_AND_BODY: 'Title and body',
  TITLE_AND_TWO_COLUMNS: 'Title and two columns',
  TITLE_ONLY: 'Title only',
  ONE_COLUMN_TEXT: 'One column text',
  MAIN_POINT: 'Main point',
  SECTION_TITLE_AND_DESCRIPTION: 'Section title and description',
  CAPTION_ONLY: 'Caption',
  BIG_NUMBER: 'Big number',
  BLANK: 'Blank',
};
const PLACEHOLDER = { title: 'title', ctrTitle: 'title', subTitle: 'subtitle', body: 'body', obj: 'body', sldNum: 'slide_number', dt: 'date', ftr: 'footer', hdr: 'header', pic: 'picture', chart: 'chart', tbl: 'table', sldImg: 'slide_image' };

function box(xfrm) {
  const off = kid(xfrm, 'a:off');
  const ext = kid(xfrm, 'a:ext');
  if (!off || !ext) return null;
  const pt = (v) => Math.round((Number(v) || 0) / EMU_PER_PT);
  return { x: pt(off.attrs.x), y: pt(off.attrs.y), w: pt(ext.attrs.cx), h: pt(ext.attrs.cy) };
}

function runStyle(rPr, links) {
  if (!rPr) return {};
  const s = {};
  if (rPr.attrs.b === '1' || rPr.attrs.b === 'true') s.bold = true;
  if (rPr.attrs.i === '1' || rPr.attrs.i === 'true') s.italic = true;
  if (rPr.attrs.u && rPr.attrs.u !== 'none') s.underline = true;
  if (rPr.attrs.strike && rPr.attrs.strike !== 'noStrike') s.strikethrough = true;
  if (rPr.attrs.sz) s.size = Number(rPr.attrs.sz) / 100;
  const font = kid(rPr, 'a:latin')?.attrs.typeface;
  if (font) s.font = font;
  const color = path(rPr, 'a:solidFill', 'a:srgbClr')?.attrs.val;
  if (color) s.color = `#${color.toLowerCase()}`;
  const link = kid(rPr, 'a:hlinkClick')?.attrs['r:id'];
  if (link && links.get(link)?.target) s.link = links.get(link).target;
  return s;
}

function mdEscape(s) {
  return s.replace(/([\\`*_[\]])/g, '\\$1');
}

/** One run as inline markdown, keeping edge spaces outside the markers so "**x **" never happens. */
function runMarkdown(text, s) {
  if (!text) return '';
  const lead = text.match(/^\s*/)[0];
  const trail = text.slice(lead.length).match(/\s*$/)[0];
  let core = mdEscape(text.slice(lead.length, text.length - trail.length));
  if (!core) return text;
  if (s.link) core = `[${core}](${s.link})`;
  if (s.strikethrough) core = `~~${core}~~`;
  if (s.italic) core = `*${core}*`;
  if (s.bold) core = `**${core}**`;
  return lead + core + trail;
}

function paragraphOf(p, links) {
  const pPr = kid(p, 'a:pPr');
  const level = Number(pPr?.attrs.lvl || 0);
  let list = null;
  if (kid(pPr, 'a:buAutoNum')) list = 'numbered';
  else if (kid(pPr, 'a:buChar')) list = 'bullet';
  else if (kid(pPr, 'a:buNone')) list = 'none';
  const align = { ctr: 'center', r: 'right', just: 'justify', l: 'left' }[pPr?.attrs.algn] || null;
  const runs = [];
  for (const c of kids(p)) {
    if (c.name === 'a:r' || c.name === 'a:fld') runs.push({ text: kid(c, 'a:t')?.text ?? '', style: runStyle(kid(c, 'a:rPr'), links) });
    else if (c.name === 'a:br') runs.push({ text: '\n', style: {} });
  }
  const text = runs.map((r) => r.text).join('');
  const md = runs.map((r) => runMarkdown(r.text, r.style)).join('');
  return { text, md, level, list, ...(align ? { align } : {}), runs };
}

function textOf(txBody, links) {
  if (!txBody) return [];
  const paras = kids(txBody, 'a:p').map((p) => paragraphOf(p, links));
  // A text box always holds at least one (possibly empty) paragraph; an
  // all-empty body is no text at all.
  return paras.some((p) => p.text.trim()) ? paras : [];
}

function nameInfo(cNvPr) {
  const name = cNvPr?.attrs.name || '';
  const m = name.match(/^Google Shape;([^;]+);(.+)$/);
  return { name, objectId: m ? m[1] : null, alt: cNvPr?.attrs.descr || null };
}

function shapeOf(node, links) {
  switch (node.name) {
    case 'p:sp': {
      const nv = kid(node, 'p:nvSpPr');
      const ph = path(nv, 'p:nvPr', 'p:ph');
      const info = nameInfo(kid(nv, 'p:cNvPr'));
      const paragraphs = textOf(kid(node, 'p:txBody'), links);
      const geom = path(node, 'p:spPr', 'a:prstGeom')?.attrs.prst || null;
      return {
        kind: paragraphs.length || kid(node, 'p:txBody') ? 'text' : 'shape',
        ...info,
        placeholder: ph ? PLACEHOLDER[ph.attrs.type || 'body'] || ph.attrs.type : null,
        ...(geom && geom !== 'rect' ? { geometry: geom } : {}),
        box: box(path(node, 'p:spPr', 'a:xfrm')),
        paragraphs,
      };
    }
    case 'p:pic': {
      const nv = kid(node, 'p:nvPicPr');
      const ph = path(nv, 'p:nvPr', 'p:ph');
      return { kind: 'image', ...nameInfo(kid(nv, 'p:cNvPr')), placeholder: ph ? PLACEHOLDER[ph.attrs.type || 'body'] || ph.attrs.type : null, box: box(path(node, 'p:spPr', 'a:xfrm')), paragraphs: [] };
    }
    case 'p:graphicFrame': {
      const info = nameInfo(path(node, 'p:nvGraphicFramePr', 'p:cNvPr'));
      const tbl = find(node, 'a:tbl');
      const frameBox = box(kid(node, 'p:xfrm'));
      if (tbl) {
        const rows = kids(tbl, 'a:tr').map((tr) => kids(tr, 'a:tc').map((tc) => textOf(kid(tc, 'a:txBody'), links).map((p) => p.text).join('\n')));
        return { kind: 'table', ...info, placeholder: null, box: frameBox, paragraphs: [], rows };
      }
      return { kind: find(node, 'c:chart') ? 'chart' : 'object', ...info, placeholder: null, box: frameBox, paragraphs: [] };
    }
    case 'p:grpSp': {
      const info = nameInfo(path(node, 'p:nvGrpSpPr', 'p:cNvPr'));
      const children = shapesOf(node, links);
      return { kind: 'group', ...info, placeholder: null, box: box(path(node, 'p:grpSpPr', 'a:xfrm')), paragraphs: [], children };
    }
    case 'p:cxnSp':
      return { kind: 'line', ...nameInfo(path(node, 'p:nvCxnSpPr', 'p:cNvPr')), placeholder: null, box: box(path(node, 'p:spPr', 'a:xfrm')), paragraphs: [] };
    default:
      return null;
  }
}

function shapesOf(tree, links) {
  return kids(tree)
    .map((n) => shapeOf(n, links))
    .filter(Boolean)
    .map((s, i) => ({ index: i + 1, ...s }));
}

// ------------------------------------------------------------------ deck

async function textPart(entries, name) {
  const get = entries.get(name);
  return get ? new TextDecoder().decode(await get()) : null;
}

/**
 * Parse an exported .pptx into {slideSize, slides:[{index, layout, hidden,
 * shapes, notes}]}. Slide and shape indexes are 1-based, in presentation and
 * z-order.
 */
export async function parsePptx(bytes) {
  const entries = readZip(bytes);
  const presXml = await textPart(entries, 'ppt/presentation.xml');
  if (!presXml) throw new Error('not a presentation: ppt/presentation.xml is missing');
  const pres = parseXml(presXml);
  const presRels = relsOf(await textPart(entries, 'ppt/_rels/presentation.xml.rels'));
  const size = find(pres, 'p:sldSz');
  const slideSize = size ? { w: Math.round(Number(size.attrs.cx) / EMU_PER_PT), h: Math.round(Number(size.attrs.cy) / EMU_PER_PT) } : null;
  const ids = kids(find(pres, 'p:sldIdLst'), 'p:sldId');
  const layoutNames = new Map();
  const slides = [];
  for (let i = 0; i < ids.length; i++) {
    const rel = presRels.get(ids[i].attrs['r:id']);
    if (!rel) continue;
    const part = resolvePart('ppt/presentation.xml', rel.target);
    const xml = await textPart(entries, part);
    if (!xml) continue;
    const slide = parseXml(xml);
    const links = relsOf(await textPart(entries, relsPath(part)));
    const tree = find(slide, 'p:spTree');
    const shapes = shapesOf(tree, links);
    let layout = null;
    let notes = '';
    for (const r of links.values()) {
      if (/\/slideLayout$/.test(r.type)) {
        const lp = resolvePart(part, r.target);
        if (!layoutNames.has(lp)) {
          const lx = await textPart(entries, lp);
          const raw = lx ? find(parseXml(lx), 'p:cSld')?.attrs.name || null : null;
          layoutNames.set(lp, raw ? LAYOUT_NAMES[raw] || raw : null);
        }
        layout = layoutNames.get(lp);
      } else if (/\/notesSlide$/.test(r.type)) {
        const np = resolvePart(part, r.target);
        const nx = await textPart(entries, np);
        if (nx) {
          const nshapes = shapesOf(find(parseXml(nx), 'p:spTree'), relsOf(await textPart(entries, relsPath(np))));
          const body = nshapes.filter((s) => s.placeholder === 'body');
          notes = (body.length ? body : nshapes.filter((s) => s.kind === 'text' && !s.placeholder))
            .flatMap((s) => s.paragraphs.map((p) => p.text))
            .join('\n')
            .trim();
        }
      }
    }
    slides.push({ index: slides.length + 1, part, layout, hidden: slide.children.some((c) => c.name === 'p:sld' && c.attrs.show === '0') || false, shapes, notes });
  }
  return { slideSize, slides };
}

// ---------------------------------------------------------------- views

const ROLE_ORDER = ['title', 'subtitle', 'body'];

/** The title text of a slide (its title placeholder, else null). */
export function slideTitle(slide) {
  const t = slide.shapes.find((s) => s.placeholder === 'title');
  return t ? t.paragraphs.map((p) => p.text).join(' ').trim() || null : null;
}

function paragraphLines(paragraphs, { markdown = true } = {}) {
  let n = 0;
  return paragraphs.map((p) => {
    const body = markdown ? p.md : p.text;
    const indent = '  '.repeat(p.level);
    if (p.list === 'numbered') return `${indent}${++n}. ${body}`;
    n = 0;
    if (p.list === 'bullet') return `${indent}- ${body}`;
    return `${indent}${body}`;
  });
}

function shapeLabel(s, prefix = '') {
  const role = s.placeholder ? `${s.placeholder}${s.kind === 'image' ? ' image' : ''}` : s.kind;
  const empty = s.kind === 'text' && !s.paragraphs.length ? ' (empty)' : '';
  const at = s.box ? ` @${s.box.x},${s.box.y} ${s.box.w}×${s.box.h}pt` : '';
  return `[shape ${prefix}${s.index}: ${role}${empty}${at}]`;
}

function shapeLines(s, depth = 0, prefix = '') {
  const pad = '  '.repeat(depth);
  const out = [`${pad}${shapeLabel(s, prefix)}`];
  if (s.kind === 'table') for (const row of s.rows || []) out.push(`${pad}| ${row.map((c) => c.replace(/\n/g, ' / ')).join(' | ')} |`);
  else if (s.kind === 'image') out.push(`${pad}(image${s.alt ? `: ${s.alt}` : ''})`);
  else if (s.kind === 'group') for (const c of s.children || []) out.push(...shapeLines(c, depth + 1, `${prefix}${s.index}.`));
  else for (const line of paragraphLines(s.paragraphs)) out.push(`${pad}${line}`);
  return out;
}

/**
 * A readable outline: one section per slide with its layout, every shape
 * labelled with its index (what slides_write / slides_edit take), role and
 * position, then its text as markdown, then the speaker notes.
 */
export function deckOutline(deck, { title = null, total = null } = {}) {
  const out = [];
  if (title) out.push(`# ${title}`, '');
  const shown = total !== null && total !== deck.slides.length ? ` (showing ${deck.slides.length})` : '';
  out.push(`${total ?? deck.slides.length} slide(s)${shown}${deck.slideSize ? `, ${deck.slideSize.w}×${deck.slideSize.h}pt` : ''}`, '');
  for (const sl of deck.slides) {
    const head = [`## Slide ${sl.index}`, slideTitle(sl) ? `— ${slideTitle(sl)}` : null].filter(Boolean).join(' ');
    out.push(head);
    out.push(`layout: ${sl.layout || 'unknown'}${sl.hidden ? ' · skipped in slideshow' : ''}`);
    // Slide numbers are fields, not content; footers count only when they say something.
    const shapes = sl.shapes.filter((s) => s.placeholder !== 'slide_number' && (!['date', 'footer', 'header'].includes(s.placeholder) || s.paragraphs.length));
    for (const s of shapes) out.push(...shapeLines(s));
    if (!shapes.length) out.push('(no shapes)');
    out.push(sl.notes ? `notes: ${sl.notes.replace(/\n/g, '\n       ')}` : 'notes: (none)');
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** Plain text of the whole deck, slide by slide (title first, then other shapes in role order). */
export function deckText(deck, { notes = true } = {}) {
  const out = [];
  for (const sl of deck.slides) {
    out.push(`--- Slide ${sl.index} ---`);
    const ordered = [...sl.shapes].sort((a, b) => {
      const ra = ROLE_ORDER.indexOf(a.placeholder);
      const rb = ROLE_ORDER.indexOf(b.placeholder);
      return (ra === -1 ? 9 : ra) - (rb === -1 ? 9 : rb) || a.index - b.index;
    });
    const texts = (s) =>
      s.kind === 'table'
        ? (s.rows || []).map((r) => r.join('\t'))
        : s.kind === 'group'
          ? (s.children || []).flatMap(texts)
          : paragraphLines(s.paragraphs, { markdown: false });
    for (const s of ordered) {
      if (['slide_number', 'date', 'footer', 'header'].includes(s.placeholder)) continue;
      const lines = texts(s).filter((l) => l.trim());
      if (lines.length) out.push(...lines);
    }
    if (notes && sl.notes) out.push(`[notes] ${sl.notes}`);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** Everything a slide says, for probe-based verification. */
export function slideSearchText(slide) {
  const all = (s) => (s.kind === 'table' ? (s.rows || []).flat() : s.kind === 'group' ? (s.children || []).flatMap(all) : s.paragraphs.map((p) => p.text));
  return slide.shapes.flatMap(all).join('\n');
}
