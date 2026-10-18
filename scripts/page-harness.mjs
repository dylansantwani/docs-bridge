#!/usr/bin/env node
/**
 * Print a self-test you can paste into the DevTools console of a Google Doc
 * (or run through any "evaluate in page" tool). It installs the exact
 * docsPageOp the extension injects, runs a suite of edits against the open
 * document, and reports each step plus the saved document afterwards.
 *
 * IT REWRITES THE DOCUMENT. Only run it in a scratch doc.
 *
 *   node scripts/page-harness.mjs write     > /tmp/h.js   # any scratch doc
 *   node scripts/page-harness.mjs template  > /tmp/h.js   # a copy of Google's "Meeting notes (Tropic)" template
 *   node scripts/page-harness.mjs edit      > /tmp/h.js   # a scratch doc after the write suite
 *   node scripts/page-harness.mjs type      > /tmp/h.js   # any scratch doc: human typing, chunk stop + resume by Find
 *
 * Useful when Google changes the editor and something starts failing: the
 * report shows which step broke without involving the extension or the hub.
 */

import { readFileSync } from 'node:fs';
import { toDocsContent, toInlineHtml, toTypedBlocks } from '../server/markdown.js';
import { Marked } from '../server/vendor/marked.esm.js';
import { toTypingContent } from '../server/markdown.js';
import { planTyping, typingSettings } from '../extension/lib/typing.js';

const suite = process.argv[2] || 'write';

const source = readFileSync(new URL('../extension/page/docs-page.js', import.meta.url), 'utf8')
  .replace(/\/\*\*[\s\S]*?\*\//g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace('export async function docsPageOp', 'async function docsPageOp')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .join('\n');

const md = (markdown) => toDocsContent({ markdown });
const type = (markdown) => toTypedBlocks(new Marked({ gfm: true }).lexer(markdown));

const SUITES = {
  write: [
    ['replace_document', { mode: 'replace_document', content: md('# Bridge Test\n\nFirst paragraph with **bold**.\n\nSecond paragraph anchor-here end.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nClosing line.') }],
    ['append', { mode: 'append', content: md('## Appended Section\n\nAppended body.') }],
    ['append list', { mode: 'append', content: md('- tail one\n- tail two') }],
    ['append after list', { mode: 'append', content: md('After the list.') }],
    ['prepend', { mode: 'prepend', content: md('Prepended normal line.') }],
    ['insert_after inline', { mode: 'insert_after', anchor: 'anchor-here', content: md(' [AFTER]') }],
    ['insert_before inline', { mode: 'insert_before', anchor: 'anchor-here', content: md('[BEFORE] ') }],
    ['insert_after block', { mode: 'insert_after', anchor: 'First paragraph', content: md('### Inserted H3\n\nInserted para.') }],
    ['insert_before list after a table', { mode: 'insert_before', anchor: 'Closing line', content: md('- pre-close A\n- pre-close B') }],
    ['replace_text inline', { mode: 'replace_text', anchor: 'Appended body', content: md('Rewritten *body*') }],
    ['replace_text whole paragraph', { mode: 'replace_text', anchor: 'After the list.', content: md('## Swapped Heading\n\nSwapped para.') }],
    ['delete', { mode: 'replace_text', anchor: ' end.', content: null }],
    ['occurrence 2', { mode: 'insert_after', anchor: 'para', occurrence: 2, content: md('[2nd]') }],
    ['count', { op: 'count', find: 'tail' }],
    ['replace_all', { op: 'replace_all', find: 'tail', replace: 'end' }],
    ['missing anchor', { mode: 'insert_after', anchor: 'zzz-not-here', content: md('x') }],
  ],
  template: [
    ['retitle (keeps template style)', { op: 'edit', steps: [{ find: 'Annual Board Meeting' }, { inline: 'Weekly Team Sync' }] }],
    ['replace_section Attendees', { mode: 'replace_section', anchor: 'Attendees', content: md('Dylan Santwani, Founder\n\nPat Doe, Engineer') }],
    ['replace_section Action Items', { mode: 'replace_section', anchor: 'Action Items', content: md('- [ ] Ship the docs bridge\n- [ ] Test templates\n  - nested detail') }],
    ['format text', { op: 'edit', steps: [{ find: 'Last Meeting Follow-up' }, { format: { bold: true, italic: true, color: 'red', size: 20 } }] }],
    ['paragraph style + align', { op: 'edit', steps: [{ find: 'New Business' }, { format: { style: 'heading3', align: 'center' } }] }],
    ['highlight + underline + link', { op: 'edit', steps: [{ find: 'Suspendisse scelerisque mi a mi.' }, { format: { highlight: 'yellow', underline: true } }, { find: 'Ship the docs bridge' }, { format: { link: 'https://example.com/bridge' } }] }],
    ['font', { op: 'edit', steps: [{ find: 'Pat Doe, Engineer' }, { format: { font: 'Georgia' } }] }],
    ['menu: insert page break before Notes', { op: 'edit', steps: [{ caret: { before: 'Notes' } }, { menu: 'Insert > Break > Page break' }] }],
    ['type rich blocks at end', { mode: 'append', content: md('## Decisions\n\n1. Use the bridge\n2. Keep templates\n\n> Quoted note\n\n| Owner | Task |\n|---|---|\n| Dylan | Ship |\n\nClosing *remark*.') }],
    ['strikethrough via menu', { op: 'edit', steps: [{ find: 'Keep templates' }, { format: { strikethrough: true } }] }],
    ['undo last', { op: 'edit', steps: [{ undo: 1 }] }],
    ['bad menu path is explained', { op: 'edit', steps: [{ menu: 'Format > Nonsense item' }] }],
  ],
};

// The typing suite is scripted rather than a list of steps: a chunk that
// stops early hands its position to the next one, which re-finds the caret
// with Find as a fresh tab would.
const fastPlan = (markdown, byEnd, seed) => {
  const c = toTypingContent({ markdown });
  return { c, plan: planTyping(c.blocks, typingSettings({ seed, wpm: 200, typos: 0.06, pauses: 0.15 }), { byEnd }) };
};
if (suite === 'type') {
  const one = fastPlan('# Typing Test\n\nThe **quick brown** fox *jumps* over the lazy dog, and then a few more words follow here to finish the line.\n\n- item one\n- item two\n\nDon\'t stop -- keep "going" now. 😀', true, 7);
  const two = fastPlan('Second paragraph is typed in two chunks so that the resume by Find gets exercised on a real document here.', false, 8);
  process.stdout.write(`${source.replace(/^/, '')}
const __wait = (ms) => new Promise((res) => { const c = new MessageChannel(); const end = performance.now() + ms; c.port1.onmessage = () => (performance.now() < end ? c.port2.postMessage(0) : res()); c.port2.postMessage(0); });
const __out = [];
const __t = async (name, a) => { const t0 = performance.now(); const r = await docsPageOp('type', a); __out.push(name.padEnd(28) + (r.ok ? 'ok ' : 'FAIL ') + Math.round(performance.now() - t0) + 'ms ' + JSON.stringify(r).slice(0, 240)); return r; };
const one = ${JSON.stringify(one.plan)};
const two = ${JSON.stringify(two.plan)};
await __t('replace_document', { job: 'h1', position: { mode: 'replace_document' }, blocks: one.blocks, budgetMs: 600000 });
const a = await __t('append, stop early', { job: 'h2', position: { mode: 'append' }, blocks: two.blocks, budgetMs: 0 });
await __wait(3500);
if (a.ok && !a.done) await __t('resume by Find', { job: 'h3', blocks: two.blocks, at: a.at, state: a.state, resume: { tail: a.tail }, budgetMs: 600000 });
await __wait(3500);
const saved = await docsPageOp('blocks');
__out.join('\\n') + '\\n\\n--- saved ---\\n' + saved.blocks.map((b) => '[' + b.tag + (b.list ? ' li' : '') + '] ' + b.runs.map((x) => x.text + ((+x.style['font-weight'] >= 700) ? '{b}' : '') + (x.style['font-style'] === 'italic' ? '{i}' : '')).join('')).join('\\n') + '\\n\\nexpected: ' + ${JSON.stringify(one.c.text + '\n' + two.c.text)};
`);
  process.exit(0);
}

const steps = SUITES[suite];
if (!steps) {
  process.stderr.write(`unknown suite ${suite}; use ${Object.keys(SUITES).join(', ')}\n`);
  process.exit(2);
}

process.stdout.write(`${source}
const __steps = ${JSON.stringify(steps)};
const __wait = (ms) => new Promise((res) => { const c = new MessageChannel(); const end = performance.now() + ms; c.port1.onmessage = () => (performance.now() < end ? c.port2.postMessage(0) : res()); c.port2.postMessage(0); });
const __fmt = (r) => { const s = r.style || {}; const bits = []; if (+s['font-weight'] >= 700) bits.push('bold'); if (s['font-style'] === 'italic') bits.push('italic'); if (/underline/.test(s['text-decoration'] || '')) bits.push('underline'); if (/line-through/.test(s['text-decoration'] || '')) bits.push('strike'); if (s.color && !/^#(000000|695d46)$/.test(s.color)) bits.push('color=' + s.color); if (s['background-color']) bits.push('bg=' + s['background-color']); if (s['font-size'] && s['font-size'] !== '11pt') bits.push(s['font-size']); if (s['font-family'] && !/Arial|Open Sans/.test(s['font-family'])) bits.push(s['font-family']); if (r.href) bits.push('link=' + r.href); return bits.length ? '{' + bits.join(',') + '}' : ''; };
const __dump = async () => { const r = await docsPageOp('blocks'); if (!r.ok) return JSON.stringify(r); return r.blocks.map((b) => (b.inTable ? '    | ' : '') + '[' + (b.cls || b.tag) + (b.list ? (b.list.ordered ? ' ol' : ' ul') + b.list.depth : '') + (b.align && b.align !== 'left' ? ' ' + b.align : '') + '] ' + b.runs.map((x) => x.text + __fmt(x)).join('')).join('\\n'); };
const __report = [];
for (const [name, a] of __steps) {
  const t0 = performance.now();
  const r = await docsPageOp(a.op || 'write', a);
  __report.push(name.padEnd(40) + (r.ok ? 'ok   ' : 'FAIL ') + Math.round(performance.now() - t0) + 'ms ' + (r.ok ? JSON.stringify({ ...r, ok: undefined }).slice(0, 160) : r.code + ': ' + r.message.slice(0, 200)));
}
await __wait(3000);
__report.join('\\n') + '\\n\\n--- saved document ---\\n' + (await __dump());
`);
