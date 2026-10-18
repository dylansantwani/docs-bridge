/**
 * Google Slides support outside the page: deck references and URLs, the
 * .pptx reader, saved-deck verification, the extension's slides_* operations
 * (on the fake chrome.* API) and the MCP tools (on a fake transport).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDeckRef, parseDocRef, slidesExportUrl, slidesEditUrl, slidesCopyUrl, slidesSearchUrl, slidesCreateUrl, classifyLanding } from '../extension/lib/refs.js';
import { readZip, parseXml, parsePptx, deckOutline, deckText, slideSearchText, LAYOUT_NAMES } from '../extension/lib/pptx.js';
import { deckProblems, deckCount, deckSignature, compactDeck, stepMutates, needsSnapshot, squash } from '../extension/lib/slides-ops.js';
import { createOps } from '../extension/lib/ops.js';
import { TabPool } from '../extension/lib/tabs.js';
import { toSlideParagraphs, parseSlideRange, compileEditSteps, compileSpec, runPlanned, SlideSim, callSlidesTool, SLIDES_TOOLS, splitPlan } from '../server/slides.js';
import { planTyping, typingSettings } from '../extension/lib/typing.js';
import { toTypingContent } from '../server/markdown.js';
import { TOOLS, callTool } from '../server/tools.js';
import { fakeChrome, readyState } from './helpers/fake-chrome.js';

const ID = '1TestDeckAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

// ------------------------------------------------------------------ a deck

/** A minimal zip: stored entries, or deflated ones for names in `deflate`. */
function makeZip(files, deflate = new Set()) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const method = deflate.has(name) ? 8 : 0;
    const data = method ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    locals.push(local);
    central.push(cen);
    offset += local.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cenSize + 22);
  let p = 0;
  for (const part of [...locals, ...central, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${x * 12700}" y="${y * 12700}"/><a:ext cx="${w * 12700}" cy="${h * 12700}"/></a:xfrm>`;
const sp = (id, ph, paras, box = [25, 35, 671, 45]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Google Shape;${id};p13"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(...box)}<a:prstGeom prst="rect"/></p:spPr><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
const para = (runs, pPr = '') => `<a:p>${pPr}${runs}</a:p>`;
const run = (t, rPr = '<a:rPr lang="en"/>') => `<a:r>${rPr}<a:t>${t}</a:t></a:r>`;

function samplePptx({ titleText = 'Hello &amp; welcome', notes = 'Say hi', bodyBold = true } = {}) {
  const slide1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name="Shape 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${sp(54, '<p:ph type="ctrTitle"/>', para(run(titleText), '<a:pPr algn="ctr"/>'))}
${sp(
  55,
  '<p:ph idx="1" type="body"/>',
  para(run('Alpha'), '<a:pPr lvl="0"><a:buChar char="●"/></a:pPr>') +
    para(run('Alpha ') + run('child', bodyBold ? '<a:rPr b="1"/>' : '<a:rPr/>'), '<a:pPr lvl="1"><a:buChar char="○"/></a:pPr>') +
    para(run('One'), '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
    para(run('see ') + run('docs', '<a:rPr><a:hlinkClick r:id="rId9"/></a:rPr>'), '<a:pPr><a:buNone/></a:pPr>'),
  [25, 91, 671, 269]
)}
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="56" name="Google Shape;56;p13"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="12700" cy="12700"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody>${para(run('A1'))}</a:txBody></a:tc><a:tc><a:txBody>${para(run('B1'))}</a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody>${para(run('A2'))}</a:txBody></a:tc><a:tc><a:txBody>${para(run('B2'))}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
<p:pic><p:nvPicPr><p:cNvPr id="57" name="Google Shape;57;p13" descr="A chart of sales"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:spPr>${xfrm(1, 2, 3, 4)}</p:spPr></p:pic>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="58" name="Google Shape;58;p13"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrm(0, 0, 10, 10)}</p:grpSpPr>${sp(59, '', para(run('In group')))}</p:grpSp>
</p:spTree></p:cSld></p:sld>`;
  const slide2 = `<?xml version="1.0"?><p:sld ${NS} show="0"><p:cSld><p:spTree>${sp(70, '<p:ph type="title"/>', para(run('Second')))}${sp(71, '<p:ph type="sldNum" idx="12"/>', para(run('2')))}</p:spTree></p:cSld></p:sld>`;
  const rels = (items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${ext ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
  const files = {
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId3', 'slide', 'slides/slide2.xml'],
      ['rId7', 'slide', 'slides/slide1.xml'],
    ]),
    'ppt/slides/slide1.xml': slide1,
    'ppt/slides/_rels/slide1.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout2.xml'],
      ['rId2', 'notesSlide', '../notesSlides/notesSlide1.xml'],
      ['rId9', 'hyperlink', 'https://example.com/docs', true],
    ]),
    'ppt/slides/slide2.xml': slide2,
    'ppt/slides/_rels/slide2.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout9.xml']]),
    'ppt/slideLayouts/slideLayout2.xml': `<p:sldLayout ${NS}><p:cSld name="TITLE_AND_BODY"><p:spTree/></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/slideLayout9.xml': `<p:sldLayout ${NS}><p:cSld name="Team photo"><p:spTree/></p:cSld></p:sldLayout>`,
    'ppt/notesSlides/notesSlide1.xml': `<p:notes ${NS}><p:cSld><p:spTree>${sp(80, '<p:ph type="sldImg" idx="2"/>', '')}${sp(81, '<p:ph type="body" idx="1"/>', para(run(notes)))}</p:spTree></p:cSld></p:notes>`,
  };
  return makeZip(files, new Set(['ppt/slides/slide1.xml', 'ppt/notesSlides/notesSlide1.xml']));
}

// ------------------------------------------------------------------- refs

test('parseDeckRef accepts ids and Slides URLs, and keeps the #slide=id deep link', () => {
  assert.deepEqual(parseDeckRef(ID), { id: ID, slide: null });
  assert.deepEqual(parseDeckRef(`https://docs.google.com/presentation/d/${ID}/edit`), { id: ID, slide: null });
  assert.deepEqual(parseDeckRef(`https://docs.google.com/presentation/u/1/d/${ID}/edit?usp=sharing#slide=id.g2a_0_5`), { id: ID, slide: 'g2a_0_5' });
  assert.deepEqual(parseDeckRef(`https://docs.google.com/presentation/d/${ID}/edit?slide=id.p`), { id: ID, slide: 'p' });
  assert.deepEqual(parseDeckRef(`https://drive.google.com/file/d/${ID}/view`), { id: ID, slide: null });
  assert.throws(() => parseDeckRef(''), /deck is required/);
  assert.throws(() => parseDeckRef(`https://docs.google.com/document/d/${ID}/edit`), /Google Docs link; use the docs_\* tools/);
  assert.throws(() => parseDeckRef(`https://docs.google.com/spreadsheets/d/${ID}/edit`), /Slides presentations only/);
  assert.throws(() => parseDeckRef('https://example.com/x'), /not a Google Slides URL/);
});

test('docs_* tools point a Slides link at the slides_* tools', () => {
  assert.throws(() => parseDocRef(`https://docs.google.com/presentation/d/${ID}/edit`), /Google Slides link; use the slides_\* tools/);
});

test('Slides URLs: edit (with slide), export (page for images only), copy, search, create', () => {
  assert.equal(slidesEditUrl(ID, '1', 'p'), `https://docs.google.com/presentation/d/${ID}/edit?authuser=1#slide=id.p`);
  assert.equal(slidesExportUrl(ID, 'pptx', { page: 'p' }), `https://docs.google.com/presentation/d/${ID}/export/pptx`);
  assert.equal(slidesExportUrl(ID, 'png', { page: 'g1', account: 'me@x.org' }), `https://docs.google.com/presentation/d/${ID}/export/png?pageid=g1&authuser=me%40x.org`);
  assert.equal(slidesExportUrl(ID, 'text'), `https://docs.google.com/presentation/d/${ID}/export/txt`);
  assert.throws(() => slidesExportUrl(ID, 'docx'), /unknown Slides export format/);
  assert.equal(slidesCopyUrl(ID, { title: 'Q4 copy' }), `https://docs.google.com/presentation/d/${ID}/copy?title=Q4+copy`);
  assert.match(slidesSearchUrl('kickoff'), /q=type%3Apresentation\+kickoff/);
  assert.equal(slidesCreateUrl('0'), 'https://docs.google.com/presentation/create?authuser=0');
  assert.equal(classifyLanding(`https://docs.google.com/presentation/d/${ID}/edit`, 200), 'no_access');
});

// ------------------------------------------------------------------- pptx

test('readZip reads stored and deflated entries and rejects non-zips', async () => {
  const z = readZip(makeZip({ 'a.txt': 'plain', 'b.txt': 'squeezed squeezed squeezed' }, new Set(['b.txt'])));
  assert.equal(new TextDecoder().decode(await z.get('a.txt')()), 'plain');
  assert.equal(new TextDecoder().decode(await z.get('b.txt')()), 'squeezed squeezed squeezed');
  assert.throws(() => readZip(new TextEncoder().encode('<html>sign in</html>')), /not a zip file/);
});

test('parseXml builds a tree with decoded text and attributes, self-closing tags included', () => {
  const root = parseXml('<?xml version="1.0"?><a x="1 &amp; 2"><b/><c>t &lt;3</c><!-- skip --></a>');
  const a = root.children[0];
  assert.equal(a.attrs.x, '1 & 2');
  assert.deepEqual(a.children.map((c) => c.name), ['b', 'c']);
  assert.equal(a.children[1].text, 't <3');
});

test('parsePptx: slide order from the presentation, layouts, placeholders, lists, runs, tables, images, groups, notes', async () => {
  const deck = await parsePptx(samplePptx());
  assert.deepEqual(deck.slideSize, { w: 720, h: 405 });
  assert.equal(deck.slides.length, 2);
  const [s1, s2] = deck.slides;
  assert.equal(s1.layout, LAYOUT_NAMES.TITLE_AND_BODY);
  assert.equal(s2.layout, 'Team photo', 'theme layouts keep their own names');
  assert.equal(s2.hidden, true);
  assert.equal(s1.notes, 'Say hi');
  assert.equal(s2.notes, '');
  const [title, body, table, pic, group] = s1.shapes;
  assert.deepEqual([title.index, title.placeholder, title.paragraphs[0].text, title.paragraphs[0].align], [1, 'title', 'Hello & welcome', 'center']);
  assert.deepEqual(title.box, { x: 25, y: 35, w: 671, h: 45 });
  assert.deepEqual(
    body.paragraphs.map((p) => [p.text, p.level, p.list]),
    [
      ['Alpha', 0, 'bullet'],
      ['Alpha child', 1, 'bullet'],
      ['One', 0, 'numbered'],
      ['see docs', 0, 'none'],
    ]
  );
  assert.equal(body.paragraphs[1].md, 'Alpha **child**');
  assert.equal(body.paragraphs[3].md, 'see [docs](https://example.com/docs)');
  assert.deepEqual(table.rows, [['A1', 'B1'], ['A2', 'B2']]);
  assert.deepEqual([pic.kind, pic.alt], ['image', 'A chart of sales']);
  assert.deepEqual([group.kind, group.children[0].paragraphs[0].text], ['group', 'In group']);
});

test('deckOutline numbers shapes and shows roles, markdown and notes; deckText reads slide by slide', async () => {
  const deck = await parsePptx(samplePptx());
  const outline = deckOutline(deck, { title: 'Demo' });
  assert.match(outline, /^# Demo\n\n2 slide\(s\), 720×405pt/);
  assert.match(outline, /## Slide 1 — Hello & welcome\nlayout: Title and body\n\[shape 1: title @25,35 671×45pt\]\nHello & welcome/);
  assert.match(outline, /- Alpha\n  - Alpha \*\*child\*\*\n1\. One\nsee \[docs\]/);
  assert.match(outline, /\| A1 \| B1 \|/);
  assert.match(outline, /\(image: A chart of sales\)/);
  assert.match(outline, /\[shape 5: group[^\]]*\]\n  \[shape 5\.1: text/);
  assert.match(outline, /notes: Say hi/);
  assert.match(outline, /## Slide 2 — Second\nlayout: Team photo · skipped in slideshow/);
  assert.doesNotMatch(outline, /slide_number/, 'footers and slide numbers are left out');
  const text = deckText(deck);
  assert.match(text, /--- Slide 1 ---\nHello & welcome\n- Alpha\n  - Alpha child/);
  assert.match(text, /\[notes\] Say hi/);
  assert.match(slideSearchText(deck.slides[0]), /A2\nB2/);
});

test('deckOutline says how many slides are shown when filtered', async () => {
  const deck = await parsePptx(samplePptx());
  assert.match(deckOutline({ ...deck, slides: deck.slides.slice(1) }, { total: 2 }), /^2 slide\(s\) \(showing 1\)/);
});

// --------------------------------------------------------- verification

test('deckProblems matches results to the saved deck by position, not by (renumbered) ids', async () => {
  const deck = compactDeck(await parsePptx(samplePptx()));
  const finalSlides = [{ index: 1, pageId: 'p' }, { index: 2, pageId: 'g2' }];
  const ok = [
    { action: 'setText', pageId: 'p', objectId: 'i0', index: 1, text: 'Hello & welcome' },
    { action: 'notes', pageId: 'p', notes: 'Say hi' },
    { action: 'text', pageId: 'p', typed: 'Alpha child' },
    { action: 'layout', pageId: 'p', layout: 'Title and body' },
  ];
  assert.deepEqual(deckProblems(deck, ok, finalSlides), []);
  const bad = [
    { action: 'setText', pageId: 'p', index: 1, text: 'Something else' },
    { action: 'notes', pageId: 'g2', notes: 'missing notes' },
    { action: 'layout', pageId: 'g2', layout: 'Blank' },
    { action: 'setText', pageId: 'nowhere', index: 1, text: 'x' },
  ];
  const problems = deckProblems(deck, bad, finalSlides);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /slide 1: the text of shape 1/);
  assert.match(problems[2], /layout is Team photo, not Blank/);
  assert.match(deckProblems(deck, [], [...finalSlides, { index: 3, pageId: 'n' }])[0], /saved deck has 2 slide\(s\); the editor shows 3/);
});

test('deckSignature changes with formatting, not only text; deckCount counts slide text', async () => {
  const a = await parsePptx(samplePptx({ bodyBold: true }));
  const b = await parsePptx(samplePptx({ bodyBold: false }));
  assert.notEqual(deckSignature(a), deckSignature(b));
  assert.equal(deckSignature(a), deckSignature(await parsePptx(samplePptx({ bodyBold: true }))));
  assert.equal(deckCount(a, 'alpha', false), 2);
  assert.equal(deckCount(a, 'alpha', true), 0);
  assert.equal(squash('“Smart” — quotes'), 'smartquotes');
});

test('which steps change the deck, and which prove themselves without a before-snapshot', () => {
  assert.equal(stepMutates({ slide: { index: 1 } }), false);
  assert.equal(stepMutates({ key: 'ArrowLeft' }), false);
  assert.equal(stepMutates({ key: 'ArrowLeft', mods: { mod: true } }), true);
  assert.equal(stepMutates({ setText: [] }), true);
  assert.equal(needsSnapshot([{ shape: { index: 1 } }, { setText: [] }, { notes: [] }]), false);
  assert.equal(needsSnapshot([{ shape: { index: 1 } }, { format: { bold: true } }]), true);
  assert.equal(needsSnapshot([{ moveSlide: 'up' }]), true);
});

// ------------------------------------------------------- extension ops

function response({ url = 'https://doc-0g.googleusercontent.com/export/x', status = 200, type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation', body = new Uint8Array(), disposition = `attachment; filename="Deck.pptx"` } = {}) {
  const headers = new Headers({ 'content-type': type });
  if (disposition) headers.set('content-disposition', disposition);
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return { url, status, headers, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

function setup({ slides = {}, fetchImpl, tabUrl, other } = {}) {
  const api = fakeChrome({ slides: { state: () => readyState({ slideCount: 2, page: 'p' }), saved: () => ({ ok: true, saved: true, status: 'Saved to Drive.' }), ...slides }, tabUrl, other });
  const pool = new TabPool({ api });
  const fetches = [];
  const { dispatch } = createOps({
    pool,
    api,
    version: '0.4.0',
    slidesTiming: { deckVerifyIntervalMs: 5, deckVerifyMaxIntervalMs: 10, deckVerifyTimeoutMs: 300, retryDelays: [5, 5] },
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      return fetchImpl ? fetchImpl(url, fetches.length) : response({ body: samplePptx() });
    },
  });
  return { api, pool, dispatch, fetches };
}

test('slides_deck exports the .pptx with cookies and returns the parsed deck without run detail', async () => {
  const { dispatch, fetches } = setup();
  const r = await dispatch('slides_deck', { id: ID, account: '1' });
  assert.equal(fetches[0].url, `https://docs.google.com/presentation/d/${ID}/export/pptx?authuser=1`);
  assert.equal(fetches[0].init.credentials, 'include');
  assert.equal(r.title, 'Deck');
  assert.equal(r.deck.slides[0].shapes[1].paragraphs[1].runs, undefined);
  assert.equal(r.deck.slides[0].shapes[1].name, undefined, 'export-internal names are dropped');
});

test('slides exports retry when Google rate-limits, then report it', async () => {
  let n = 0;
  const { dispatch } = setup({ fetchImpl: () => (++n < 3 ? response({ status: 429, type: 'text/html' }) : response({ body: samplePptx() })) });
  assert.equal((await dispatch('slides_deck', { id: ID })).deck.slides.length, 2);
  const always = setup({ fetchImpl: () => response({ status: 429, type: 'text/html' }) });
  await assert.rejects(always.dispatch('slides_deck', { id: ID }), (e) => e.code === 'rate_limited');
});

test('slides export of a sign-in or access page is an error, not a deck', async () => {
  const { dispatch } = setup({ fetchImpl: () => response({ type: 'text/html', body: '<html>Request access</html>' }) });
  await assert.rejects(dispatch('slides_deck', { id: ID }), (e) => e.code === 'no_access');
});

test('slides_run opens a Slides tab, runs the steps, and verifies against the saved deck', async () => {
  const steps = [{ shape: { role: 'title' } }, { setText: [{ html: 'Hello &amp; welcome', text: 'Hello & welcome', list: null, level: 0 }] }];
  const { dispatch, api, fetches } = setup({
    slides: {
      run: () => ({
        ok: true,
        results: [
          { step: 1, action: 'shape', pageId: 'p', index: 1 },
          { step: 2, action: 'setText', pageId: 'p', index: 1, text: 'Hello & welcome' },
        ],
        slides: [{ index: 1, pageId: 'p' }, { index: 2, pageId: 'g2' }],
        page: 'p',
      }),
    },
  });
  const r = await dispatch('slides_run', { id: ID, steps });
  assert.equal(r.verification.verified, true);
  assert.equal(r.page, 'p');
  assert.equal(api.created[0].requestedUrl, `https://docs.google.com/presentation/d/${ID}/edit`);
  assert.equal(fetches.length, 1, 'self-checking steps need no before-snapshot');
  assert.deepEqual(api.scripts.filter((s) => s.op.startsWith('slides:')).map((s) => s.op), ['slides:state', 'slides:run', 'slides:saved']);
});

test('slides_run reports NOT verified with what the saved deck is missing', async () => {
  const { dispatch } = setup({
    slides: {
      run: () => ({ ok: true, results: [{ step: 1, action: 'notes', pageId: 'p', notes: 'Never saved' }], slides: [{ index: 1, pageId: 'p' }, { index: 2, pageId: 'g2' }], page: 'p' }),
    },
  });
  const r = await dispatch('slides_run', { id: ID, steps: [{ notes: [] }] });
  assert.equal(r.verification.verified, false);
  assert.match(r.verification.missing[0], /slide 1: the speaker notes are not saved yet/);
});

test('slides_run takes a before-snapshot for formatting and fails when nothing changed', async () => {
  const { dispatch, fetches } = setup({
    slides: { run: () => ({ ok: true, results: [{ step: 1, action: 'format', applied: ['bold:on'] }], slides: [{ index: 1, pageId: 'p' }, { index: 2, pageId: 'g2' }], page: 'p' }) },
  });
  const r = await dispatch('slides_run', { id: ID, steps: [{ format: { bold: true } }] });
  assert.equal(r.verification.verified, false);
  assert.equal(r.verification.unchanged, true);
  assert.ok(fetches.length >= 2);
});

test('slides_run refuses a view-only deck before touching it', async () => {
  const { dispatch, api } = setup({ slides: { state: () => readyState({ editable: false, reason: 'view only', slideCount: 1, page: 'p' }) } });
  await assert.rejects(dispatch('slides_run', { id: ID, steps: [{ setText: [] }] }), (e) => e.code === 'read_only');
  assert.ok(!api.scripts.some((s) => s.op === 'slides:run'));
});

test('slides_replace runs several pairs in one session and verifies once', async () => {
  let deckN = 0;
  const { dispatch, api } = setup({
    fetchImpl: () => response({ body: samplePptx({ titleText: ++deckN > 0 ? 'Bye &amp; welcome' : '' }) }),
    slides: { replace: (a) => ({ ok: true, replaced: a.find === 'absent' ? 0 : 1, matches: 1 }) },
  });
  const r = await dispatch('slides_replace', { id: ID, pairs: [{ find: 'Hello', replace: 'Bye' }, { find: 'absent', replace: 'x' }] });
  assert.equal(r.verification.verified, true);
  assert.deepEqual(r.results.map((x) => x.replaced), [1, 0]);
  assert.equal(api.scripts.filter((s) => s.op === 'slides:replace').length, 2);
});

test('slides_create opens /presentation/create, adopts the new deck, closes the popup and names it', async () => {
  const NEW = '1TestDeckCIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const { dispatch, api } = setup({
    tabUrl: (u) => (u.includes('/presentation/create') ? `https://docs.google.com/presentation/d/${NEW}/edit` : u),
    slides: { dismiss: () => ({ ok: true, closed: 1 }), title: (a) => ({ ok: true, title: a.title, verified: true }) },
  });
  const r = await dispatch('slides_create', { title: 'Q4' });
  assert.deepEqual(r, { id: NEW, url: `https://docs.google.com/presentation/d/${NEW}/edit`, titleVerified: true });
  assert.deepEqual(api.scripts.map((s) => s.op).filter((o) => o !== 'slides:state'), ['slides:dismiss', 'slides:title']);
  assert.equal(api.scripts.find((s) => s.op === 'slides:dismiss').args.wait, 4000);
});

test('slides_copy presses Make a copy and opens the new deck', async () => {
  const NEW = '1TestDeckBIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const { dispatch } = setup({
    tabUrl: (u) => (u.includes('/copy') ? `https://docs.google.com/presentation/d/${NEW}/edit` : u),
    other: async () => ({ ok: true }),
    slides: { state: () => readyState({ title: 'Copy of Deck', slideCount: 4, page: 'p' }), title: (a) => ({ ok: true, title: a.title, verified: true }) },
  });
  const r = await dispatch('slides_copy', { id: ID, title: 'Mine' });
  assert.deepEqual(r, { id: NEW, url: `https://docs.google.com/presentation/d/${NEW}/edit`, title: 'Mine' });
});

// ------------------------------------------------------------- MCP tools

test('every slides tool is registered with the server and has a schema', () => {
  const names = TOOLS.map((t) => t.name);
  for (const t of SLIDES_TOOLS) {
    assert.ok(names.includes(t.name), t.name);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('toSlideParagraphs: one paragraph per line, list markers, nesting by indent, inline markdown', () => {
  const p = toSlideParagraphs('# Heading\nPlain **bold**\n\n- a\n  - b\n    - c\n- d\n1. one\n   - nested under one\n- [ ] task');
  assert.deepEqual(
    p.map((x) => [x.text, x.list, x.level]),
    [
      ['Heading', null, 0],
      ['Plain bold', null, 0],
      ['a', 'bullet', 0],
      ['b', 'bullet', 1],
      ['c', 'bullet', 2],
      ['d', 'bullet', 0],
      ['one', 'numbered', 0],
      ['nested under one', 'bullet', 1],
      ['task', 'checklist', 0],
    ]
  );
  assert.equal(p[1].html, 'Plain <strong>bold</strong>');
  assert.deepEqual(toSlideParagraphs('\n\n'), []);
});

test('parseSlideRange', () => {
  assert.deepEqual([...parseSlideRange('3', 9)], [3]);
  assert.deepEqual([...parseSlideRange('2-4, 7', 9)], [2, 3, 4, 7]);
  assert.deepEqual([...parseSlideRange('8--1', 9)], [8, 9]);
  assert.throws(() => parseSlideRange('two', 9), /slides must look like/);
});

const savedDeck = async () => compactDeck(await parsePptx(samplePptx()));

test('SlideSim follows adds, moves, duplicates and deletes, and resolves roles on saved slides only', async () => {
  const sim = new SlideSim(await savedDeck());
  sim.go(1);
  assert.deepEqual(sim.role('title'), { index: 1 });
  assert.deepEqual(sim.role('body'), { index: 2 });
  assert.throws(() => sim.role('subtitle'), /slide 1 has no subtitle placeholder \(layout Title and body\); its shapes are 1: title "Hello & welcome"/);
  sim.add();
  assert.equal(sim.cur, 2);
  assert.deepEqual(sim.role('title'), { role: 'title' }, 'a new slide is resolved by the page (empty placeholders)');
  sim.move('start');
  assert.equal(sim.cur, 1);
  sim.go(3);
  assert.deepEqual(sim.role('title'), { index: 1 });
  sim.remove();
  assert.equal(sim.count, 2);
  assert.throws(() => sim.go(5), /slide 5 does not exist; the presentation has 2/);
});

test('compileSpec: a new slide goes at the end by default, then after the previous new slide', async () => {
  const sim = new SlideSim(await savedDeck());
  const steps = [];
  const lines = [];
  compileSpec({ title: 'A', body: '- x', notes: 'n' }, 0, sim, steps, lines);
  compileSpec({ layout: 'Title only', title: 'B' }, 1, sim, steps, lines);
  compileSpec({ slide: 1, title: 'New first title' }, 2, sim, steps, lines);
  compileSpec({ after: 0, title: 'Opener' }, 3, sim, steps, lines);
  const kinds = steps.map((s) => Object.keys(s)[0]);
  assert.deepEqual(kinds, ['slide', 'newSlide', 'shape', 'setText', 'shape', 'setText', 'notes', 'slide', 'newSlide', 'shape', 'setText', 'slide', 'shape', 'setText', 'slide', 'newSlide', 'moveSlide', 'shape', 'setText']);
  assert.deepEqual(steps[0], { slide: { index: 2 } });
  assert.deepEqual(steps[1], { newSlide: { layout: 'Title and body' } });
  assert.deepEqual(steps[2], { shape: { role: 'title' } });
  assert.deepEqual(steps[7], { slide: { index: 3 } }, 'B goes after A (slide 3), not at the end of the deck');
  assert.deepEqual(steps[12], { shape: { index: 1 } }, 'slide 1 is saved: its title is shape 1');
  assert.deepEqual(lines, ['new slide 3: title, body, notes', 'new slide 4 (Title only): title', 'slide 1: title', 'new slide 1: title']);
});

test('compileSpec validates', async () => {
  const sim = new SlideSim(await savedDeck());
  const c = (spec) => compileSpec(spec, 0, sim, [], []);
  assert.throws(() => c({ slide: 1, delete: true, title: 'x' }), /delete cannot be combined with title/);
  assert.throws(() => c({ slide: 1, after: 2 }), /after is only for new slides/);
  assert.throws(() => c({ slide: 0, title: 'x' }), /1-based/);
  assert.throws(() => c({ slide: 1 }), /changes nothing/);
  assert.throws(() => c({ slide: 1, title: '- a list' }), /plain line; put lists in body/);
  assert.throws(() => c({ slide: 1, shapes: { 9: 'x' } }), /slide 1 has 5 shape\(s\); there is no shape 9/);
  assert.throws(() => c({ slide: 2, subtitle: 'x' }), /no subtitle placeholder/);
});

test('compileEditSteps starts on slide 1, resolves roles from the saved deck and validates', async () => {
  const steps = compileEditSteps([{ shape: 'body' }, { selectText: 'Alpha' }, { format: { bold: true } }, { text: '**x**' }], new SlideSim(await savedDeck()));
  assert.deepEqual(steps, [{ slide: { index: 1 } }, { shape: { index: 2 } }, { selectText: { text: 'Alpha', occurrence: 1, matchCase: false } }, { format: { bold: true } }, { text: '<strong>x</strong>' }]);
  const sim = new SlideSim(null);
  assert.deepEqual(compileEditSteps([{ slide: 2 }, { focusNotes: true }, { newSlide: 'Blank' }, { key: 'Tab', times: 2 }], sim), [{ slide: { index: 2 } }, { notesFocus: true }, { newSlide: { layout: 'Blank' } }, { key: 'Tab', times: 2 }]);
  assert.throws(() => compileEditSteps([{ shape: 'title', slide: 1 }], sim), /exactly one action/);
  assert.throws(() => compileEditSteps([{ format: { colour: 'red' } }], sim), /not a formatting option/);
  assert.throws(() => compileEditSteps([{ text: 'a\nb' }], sim), /inline text/);
  assert.throws(() => compileEditSteps([{ bogus: 1 }], sim), /unknown field/);
});

function fakeTransport(handlers) {
  const calls = [];
  return {
    calls,
    async call(op, args, opts) {
      calls.push({ op, args, opts });
      const h = handlers[op];
      if (!h) throw new Error(`unexpected op ${op}`);
      return typeof h === 'function' ? h(args, calls) : h;
    },
    async status() {
      return {};
    },
  };
}

test('runPlanned splits long work only before self-standing steps and returns to the slide', async () => {
  const t = fakeTransport({ slides_run: (a, calls) => ({ results: [], slides: [], page: `page${calls.length}`, verification: { verified: true } }) });
  const P = [{ html: 'x', text: 'x', list: null, level: 0 }];
  const steps = [{ newSlide: {} }, { shape: { role: 'title' } }, { setText: P }, { shape: { role: 'body' } }, { setText: P }, { notes: P }, { newSlide: {} }];
  const runs = await runPlanned(t, { id: ID }, steps, { budget: 9 });
  assert.ok(runs.length > 1);
  for (const c of t.calls) {
    const first = Object.keys(c.args.steps[0])[0];
    assert.ok(['slide', 'newSlide', 'shape', 'notes'].includes(first), `a run starts with ${first}`);
    assert.ok(!(first === 'setText'));
  }
  assert.deepEqual(t.calls[1].args.steps[0], { slide: { page: 'page1' } });
});

test('slides_write: reads the deck, compiles, runs, and reports per slide', async () => {
  const deck = await savedDeck();
  const t = fakeTransport({
    slides_deck: { title: 'Deck', deck },
    slides_run: { title: 'Deck', results: [], slides: [{}, {}, {}], page: 'n1', verification: { verified: true } },
  });
  const out = await callSlidesTool('slides_write', { deck: ID, slides: [{ slide: 1, notes: 'n' }, { title: 'New one', body: '- a' }] }, t);
  assert.match(out, /^Wrote "Deck" — https:\/\/docs\.google\.com\/presentation\/d\/.+ \(3 slides now\)\n- slide 1: notes\n- new slide 3: title, body\nverified in Drive$/);
  assert.deepEqual(t.calls.map((c) => c.op), ['slides_deck', 'slides_run']);
});

test('slides_write re-reads the deck before resolving roles on a slide earlier entries restructured', async () => {
  const deck = await savedDeck();
  const t = fakeTransport({
    slides_deck: { title: 'Deck', deck },
    slides_run: { title: 'Deck', results: [{ action: 'newSlide', pageId: 'n1' }], slides: [{ pageId: 'p' }, { pageId: 'g2' }, { pageId: 'n1' }], page: 'n1', verification: { verified: true } },
  });
  await callSlidesTool('slides_write', { deck: ID, slides: [{ title: 'Added' }, { slide: 1, title: 'Retitled' }] }, t);
  assert.deepEqual(t.calls.map((c) => c.op), ['slides_deck', 'slides_run', 'slides_deck', 'slides_run']);
});

test('slides_write reports NOT verified runs', async () => {
  const t = fakeTransport({
    slides_deck: { title: 'Deck', deck: await savedDeck() },
    slides_run: { title: 'Deck', results: [], slides: [], verification: { verified: false, waitedSeconds: 40, missing: ['slide 1: the speaker notes are not saved yet'] } },
  });
  const out = await callSlidesTool('slides_write', { deck: ID, slides: [{ slide: 1, notes: 'x' }] }, t);
  assert.match(out, /NOT verified after 40s \(slide 1: the speaker notes are not saved yet\)\. Read the deck before retrying/);
});

test('slides_create fills the new deck’s own title slide with the first entry', async () => {
  const NEW = '1TestDeckCIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const blank = { slideSize: null, slides: [{ index: 1, layout: 'Title slide', hidden: false, notes: '', shapes: [{ index: 1, kind: 'text', placeholder: 'title', paragraphs: [] }, { index: 2, kind: 'text', placeholder: 'subtitle', paragraphs: [] }] }] };
  const t = fakeTransport({
    slides_create: { id: NEW, url: `https://docs.google.com/presentation/d/${NEW}/edit`, titleVerified: true },
    slides_deck: { title: 'Q4', deck: blank },
    slides_run: { title: 'Q4', results: [], slides: [{}, {}], page: 'n', verification: { verified: true } },
  });
  const out = await callSlidesTool('slides_create', { title: 'Q4', slides: [{ title: 'Q4 plan', subtitle: 'Team' }, { title: 'Goals', body: '- ship' }] }, t);
  assert.match(out, /Created "Q4" — .*\nid: 1TestDeckCId.*\n- slide 1: title, subtitle\n- new slide 2: title, body\nverified in Drive/);
  const steps = t.calls.find((c) => c.op === 'slides_run').args.steps;
  assert.deepEqual(steps.slice(0, 2), [{ slide: { index: 1 } }, { shape: { index: 1 } }]);
});

test('slides_create from a template copies it', async () => {
  const t = fakeTransport({ slides_copy: { id: 'NEWID', url: 'https://docs.google.com/presentation/d/NEWID/edit', title: 'Mine' } });
  const out = await callSlidesTool('slides_create', { title: 'Mine', template: `https://docs.google.com/presentation/d/${ID}/edit` }, t);
  assert.match(out, /^Created "Mine" from the template/);
  assert.deepEqual(t.calls[0].args, { id: ID, account: null, title: 'Mine' });
});

test('slides_replace: single, several pairs, and nothing found', async () => {
  const one = fakeTransport({ slides_replace: { title: 'Deck', replaced: 2, matches: 2, results: [{ find: 'a', replace: 'b', replaced: 2, matches: 2 }], verification: { verified: true } } });
  assert.match(await callSlidesTool('slides_replace', { deck: ID, find: 'a', replace: 'b' }, one), /✓ "a" → "b" \(2×\)\nverified in Drive/);
  const many = fakeTransport({
    slides_replace: (a) => ({ title: 'Deck', results: a.pairs.map((p) => ({ ...p, replaced: p.find === 'missing' ? 0 : 1, matches: 1 })), verification: { verified: true } }),
  });
  const out = await callSlidesTool('slides_replace', { deck: ID, replacements: { '{{name}}': 'Dylan', missing: 'x' } }, many);
  assert.match(out, /✓ "\{\{name\}\}" → "Dylan" \(1×\)\n✗ "missing" not found\nverified in Drive\n1 search text\(s\) not found\./);
  assert.equal(many.calls[0].args.matchCase, true, 'template fills match case by default');
  const none = fakeTransport({ slides_replace: { title: 'Deck', results: [{ find: 'zz', replace: 'y', replaced: 0, matches: 0 }], verification: null } });
  assert.match(await callSlidesTool('slides_replace', { deck: ID, find: 'zz', replace: 'y' }, none), /^No matches for "zz"/);
  await assert.rejects(callSlidesTool('slides_replace', { deck: ID, find: 'a', replace: 'b', replacements: { a: 'b' } }, none), /not both/);
});

test('slides_read: outline of chosen slides, text, json; paging', async () => {
  const t = fakeTransport({ slides_deck: { title: 'Demo', deck: await savedDeck() } });
  const outline = await callSlidesTool('slides_read', { deck: ID, slides: '2' }, t);
  assert.match(outline, /^"Demo" \(.+\) · outline · 2 slide\(s\), showing 2 · \d+ chars\n\n# Demo\n\n2 slide\(s\) \(showing 1\)/);
  assert.doesNotMatch(outline, /## Slide 1/);
  assert.match(await callSlidesTool('slides_read', { deck: ID, format: 'text' }, t), /--- Slide 1 ---/);
  assert.equal(JSON.parse((await callSlidesTool('slides_read', { deck: ID, format: 'json' }, t)).split('\n\n').slice(1).join('\n\n')).slides.length, 2);
  await assert.rejects(callSlidesTool('slides_read', { deck: ID, slides: '9' }, t), /no slides match "9"; the deck has 2/);
});

test('slides_export: whole-deck formats and one slide as an image (by the editor page id)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slides-export-'));
  const t = fakeTransport({
    slides_shapes: { slides: [{ index: 1, pageId: 'p' }, { index: 2, pageId: 'g2' }] },
    slides_export: (a) => ({ base64: Buffer.from(`bytes:${a.format}:${a.page}`).toString('base64'), title: 'Deck', mime: 'x' }),
  });
  const out = await callSlidesTool('slides_export', { deck: ID, format: 'png', slide: 2, path: join(dir, 'two') }, t);
  assert.match(out, /Saved "Deck" slide 2 as png to .*two\.png/);
  assert.equal(readFileSync(join(dir, 'two.png'), 'utf8'), 'bytes:png:g2');
  await callSlidesTool('slides_export', { deck: ID, format: 'pdf', path: join(dir, 'all.pdf') }, t);
  assert.equal(readFileSync(join(dir, 'all.pdf'), 'utf8'), 'bytes:pdf:null');
  writeFileSync(join(dir, 'exists.pptx'), 'x');
  await assert.rejects(callSlidesTool('slides_export', { deck: ID, format: 'pptx', path: join(dir, 'exists.pptx') }, t), /already exists/);
  await assert.rejects(callSlidesTool('slides_export', { deck: ID, format: 'pdf', slide: 1, path: join(dir, 'x.pdf') }, t), /slide only applies to png, jpeg and svg/);
  await assert.rejects(callSlidesTool('slides_export', { deck: ID, format: 'png', slide: 5, path: join(dir, 'x.png') }, t), /slide 5 does not exist; the deck has 2/);
});

test('slides_edit reports each step and the verification', async () => {
  const t = fakeTransport({
    slides_run: {
      title: 'Deck',
      results: [
        { step: 1, action: 'slide', slide: 2, pageId: 'g2' },
        { step: 2, action: 'shape', index: 2 },
        { step: 3, action: 'selectText', matches: 1, offset: 4 },
        { step: 4, action: 'format', applied: ['bold:on'] },
      ],
      verification: { verified: true },
    },
  });
  const out = await callSlidesTool('slides_edit', { deck: ID, steps: [{ slide: 2 }, { shape: 2 }, { selectText: 'two' }, { format: { bold: true } }] }, t);
  assert.equal(out.split('\n').slice(1).join('\n'), '1. slide: slide 2\n2. shape: shape 2\n3. selectText: 1 match in the box\n4. format: bold:on\nverified in Drive');
});

test('callTool routes slides_* names; docs tools reject Slides links with a pointer', async () => {
  const t = fakeTransport({ slides_list: { items: [{ id: ID, title: 'Deck', modified: 'opened Sep 7', shared: true }] } });
  assert.match(await callTool('slides_list', {}, t), /1\. Deck — 1TestDeckAId.* \(opened Sep 7, shared\)/);
  await assert.rejects(callTool('docs_read', { doc: `https://docs.google.com/presentation/d/${ID}/edit` }, t), /use the slides_\* tools/);
});

// ------------------------------------------------------------ slides_type

test('splitPlan keeps short plans whole and cuts long ones between paragraphs or at safe points', () => {
  const settings = typingSettings({ profile: 'natural', seed: 5 });
  const short = planTyping(toTypingContent({ markdown: 'Hello there\n\n- one' }).blocks, settings, { byEnd: true });
  assert.equal(splitPlan(short.blocks).length, 1);
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  const long = planTyping(toTypingContent({ markdown: `${words}\n\n- item a\n\n  - item b` }).blocks, settings, { byEnd: true });
  const parts = splitPlan(long.blocks, 15_000);
  assert.ok(parts.length > 2);
  for (const p of parts) assert.ok(p.ms <= 15_000 + 3_000, `part of ${p.ms} ms`);
  assert.ok(parts.slice(1).some((p) => p.blocks[0].cont), 'the long paragraph continues across parts');
  // Every character is typed exactly once: the parts' text, joined at paragraph breaks, is the whole text.
  const joined = parts.map((p, i) => (i && !p.blocks[0].cont ? '\n' : '') + p.text).join('');
  assert.equal(joined, `${words}\nitem a\nitem b`);
  const last = parts[parts.length - 1];
  if (last.blocks[0].t === 'li' && last.blocks[0].depth === 1 && !last.blocks[0].cont) assert.equal(last.level, 0);
});

test('slides_type resolves the role from the saved deck, then types and reports', async () => {
  const deck = await savedDeck();
  const t = fakeTransport({
    slides_deck: { title: 'Deck', deck },
    slides_run: { title: 'Deck', results: [{ action: 'typeText', typed: 'x' }], slides: [{}, {}], page: 'p', verification: { verified: true } },
  });
  const out = await callSlidesTool('slides_type', { deck: ID, slide: 1, shape: 'title', text: 'Hello world', profile: 'steady', seed: 1 }, t);
  assert.match(out, /^Typed 11 characters into the title of slide 1 in "Deck" — .* at 60 wpm \(steady, no typos\)\.\nverified in Drive$/);
  const steps = t.calls.find((c) => c.op === 'slides_run').args.steps;
  assert.deepEqual(steps.slice(0, 2), [{ slide: { index: 1 } }, { shape: { index: 1 } }]);
  assert.equal(steps[2].typeText.mode, 'replace');
  assert.equal(steps[2].typeText.text, 'Hello world');
});

test('slides_type to the notes needs no deck read; one paragraph per line', async () => {
  const t = fakeTransport({ slides_run: (a) => ({ title: 'Deck', results: [], slides: [], verification: { verified: true }, steps: a.steps }) });
  await callSlidesTool('slides_type', { deck: ID, slide: 2, shape: 'notes', mode: 'append', text: 'line one\nline two', typos: false }, t);
  const steps = t.calls[0].args.steps;
  assert.deepEqual(steps[1], { notesFocus: true });
  assert.equal(steps[2].typeText.blocks.length, 2);
  assert.equal(steps[2].typeText.mode, 'append');
  assert.deepEqual(t.calls.map((c) => c.op), ['slides_run']);
});

test('slides_type validates before touching the browser', async () => {
  const t = fakeTransport({});
  const bad = async (args, re) => assert.rejects(callSlidesTool('slides_type', { deck: ID, slide: 1, text: 'x', ...args }, t), re);
  await bad({ slide: 0 }, /slide is required/);
  await bad({ shape: 'footer' }, /shape must be/);
  await bad({ mode: 'insert' }, /mode must be replace or append/);
  await bad({ markdown: 'x' }, /not both/);
  await bad({ text: '   ' }, /markdown or text is required/);
  await bad({ wpm: 5 }, /wpm must be/);
  await bad({ text: 'word '.repeat(3999) }, /split it into calls/);
  assert.equal(t.calls.length, 0);
});
