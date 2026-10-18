import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callTool, TOOLS, TOOL_NAMES } from '../server/tools.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const URL_ = `https://docs.google.com/document/d/${ID}/edit`;

function fakeTransport(responses = {}) {
  const calls = [];
  return {
    calls,
    async call(op, args, opts) {
      calls.push({ op, args, opts });
      const r = responses[op];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(args) : r;
    },
    async status() {
      return responses.__status ?? { role: 'hub', port: 8876, pid: 1, peers: 0, extensions: [] };
    },
  };
}

test('every tool has a schema, a description and a unique name', () => {
  assert.equal(TOOL_NAMES.size, TOOLS.length);
  for (const t of TOOLS) {
    assert.match(t.name, /^(docs|slides)_[a-z]+$/);
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
  }
});

test('docs_status explains how to connect when no extension is attached', async () => {
  const out = await callTool('docs_status', {}, fakeTransport());
  assert.match(out, /extension: not connected/);
  assert.match(out, /Load unpacked/);
});

test('docs_status reports the connected extension and its tabs', async () => {
  const t = fakeTransport({
    __status: { role: 'hub', port: 8876, pid: 2, peers: 1, extensions: [{ label: 'chrome', version: '0.1.0', connectedAt: '2026-09-29T00:00:00.000Z' }] },
    status: { managedTabs: 2, userAgent: 'Chrome/149.0' },
  });
  const out = await callTool('docs_status', {}, t);
  assert.match(out, /"chrome" v0\.1\.0/);
  assert.match(out, /2 bridge tab\(s\) open, Chrome\/149\.0/);
});

test('docs_write converts markdown and forwards mode/anchor settings', async () => {
  const t = fakeTransport({ write: { title: 'Notes', url: URL_, anchorMatches: 3, verification: { verified: true, waitedSeconds: 2 } } });
  const out = await callTool('docs_write', { doc: URL_, mode: 'insert_after', anchor: 'Intro', markdown: '## New\n\nBody', account: 1 }, t);
  const [{ op, args }] = t.calls;
  assert.equal(op, 'write');
  assert.equal(args.id, ID);
  assert.equal(args.account, '1');
  assert.equal(args.mode, 'insert_after');
  assert.equal(args.anchor, 'Intro');
  assert.equal(args.occurrence, 1);
  assert.equal(args.content.html, '<h2>New</h2><p>Body</p>');
  assert.match(out, /insert after done/);
  assert.match(out, /matched 3 times; used the first/);
  assert.match(out, /verified in Drive/);
});

test('docs_write says loudly when Drive did not confirm the change', async () => {
  const t = fakeTransport({ write: { title: 'Notes', url: URL_, verification: { verified: false, waitedSeconds: 20, missing: ['Body'] } } });
  const out = await callTool('docs_write', { doc: ID, mode: 'append', text: 'Body' }, t);
  assert.match(out, /NOT verified/);
  assert.match(out, /"Body"/);
  assert.match(out, /Read the document before retrying/);
});

test('docs_write replace_text with empty text is a delete', async () => {
  const t = fakeTransport({ write: { title: 'Notes', url: URL_, verification: { verified: true } } });
  const out = await callTool('docs_write', { doc: ID, mode: 'replace_text', anchor: 'typo', text: '' }, t);
  assert.equal(t.calls[0].args.content, null);
  assert.match(out, /Deleted "typo"/);
});

test('docs_write validates arguments before touching the browser', async () => {
  const t = fakeTransport();
  const cases = [
    [{ doc: ID, mode: 'append' }, /markdown or text is required/],
    [{ doc: ID, mode: 'explode', text: 'x' }, /mode must be one of/],
    [{ doc: ID, mode: 'insert_after', text: 'x' }, /anchor is required/],
    [{ doc: ID, mode: 'append', text: 'x', anchor: 'y' }, /anchor only applies/],
    [{ doc: ID, mode: 'insert_after', text: 'x', anchor: 'two\nlines' }, /single paragraph/],
    [{ doc: ID, mode: 'insert_after', text: 'x', anchor: 'y', occurrence: 0 }, /1-based/],
    [{ doc: ID, mode: 'append', text: 'x', markdown: 'y' }, /not both/],
    [{ doc: 'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz123/edit', mode: 'append', text: 'x' }, /Docs documents and Slides presentations only/],
    [{ doc: ID, mode: 'append', text: 'x', account: 'nope' }, /email/],
  ];
  for (const [args, re] of cases) await assert.rejects(callTool('docs_write', args, t), re, JSON.stringify(args));
  assert.equal(t.calls.length, 0);
});

test('docs_read pages long documents', async () => {
  const body = 'x'.repeat(2500);
  const t = fakeTransport({ read: { content: body, title: 'Long', via: 'export' } });
  const first = await callTool('docs_read', { doc: ID, maxChars: 1000 }, t);
  assert.match(first, /"Long"/);
  assert.match(first, /showing 0-1000; call again with offset=1000/);
  const last = await callTool('docs_read', { doc: ID, offset: 2000, maxChars: 1000 }, t);
  assert.match(last, /showing 2000-2500 \(end\)/);
  assert.equal(t.calls[0].args.format, 'markdown');
});

test('docs_read notes a fallback source', async () => {
  const t = fakeTransport({ read: { content: 'hi', title: 'T', via: 'editor (export failed: x)' } });
  assert.match(await callTool('docs_read', { doc: ID }, t), /via editor/);
});

test('docs_list formats results and handles empty searches', async () => {
  const t = fakeTransport({
    list: (a) => (a.query ? { items: [], source: 'drive search' } : { items: [{ id: ID, title: 'notes', modified: 'Sep 4', owner: 'me@x.org' }], source: 'recent documents' }),
  });
  assert.match(await callTool('docs_list', {}, t), /1\. notes — 1TestDocAId.* \(modified Sep 4, owner me@x\.org\)/);
  assert.equal(await callTool('docs_list', { query: 'zzz' }, t), 'No Google Docs match "zzz".');
  assert.equal(t.calls[0].args.limit, 20);
});

test('docs_replace reports counts and no-ops', async () => {
  const t = fakeTransport({ replace: (a) => ({ title: 'T', url: URL_, replaced: a.find === 'cat' ? 4 : 0, verification: { verified: true } }) });
  assert.match(await callTool('docs_replace', { doc: ID, find: 'cat', replace: 'dog' }, t), /Replaced 4 match/);
  assert.match(await callTool('docs_replace', { doc: ID, find: 'emu', replace: 'dog' }, t), /No matches/);
  await assert.rejects(callTool('docs_replace', { doc: ID, find: '', replace: 'x' }, t), /find must not be empty/);
});

test('docs_create passes converted content and reports the new URL', async () => {
  const t = fakeTransport({ create: { id: ID, url: URL_, titleVerified: true, verification: { verified: true } } });
  const out = await callTool('docs_create', { title: ' Plan ', markdown: '# Plan' }, t);
  assert.equal(t.calls[0].args.title, 'Plan');
  assert.equal(t.calls[0].args.content.html, '<h1>Plan</h1>');
  assert.match(out, /Created "Plan" — https:\/\/docs\.google\.com/);
  const bare = await callTool('docs_create', { title: 'Empty' }, t);
  assert.equal(t.calls[1].args.content, null);
  assert.doesNotMatch(bare, /verified/);
});

test('docs_export writes the file, adds the extension, and refuses to clobber', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-export-'));
  try {
    const t = fakeTransport({ export: { base64: Buffer.from('%PDF-1.7 fake').toString('base64'), title: 'Report' } });
    const out = await callTool('docs_export', { doc: ID, format: 'pdf', path: join(dir, 'report') }, t);
    assert.match(out, /Saved "Report" as pdf/);
    assert.equal(readFileSync(join(dir, 'report.pdf'), 'utf8'), '%PDF-1.7 fake');
    await assert.rejects(callTool('docs_export', { doc: ID, format: 'pdf', path: join(dir, 'report.pdf') }, t), /already exists/);
    writeFileSync(join(dir, 'x.docx'), 'old');
    await callTool('docs_export', { doc: ID, format: 'docx', path: join(dir, 'x.docx'), overwrite: true }, t);
    await assert.rejects(callTool('docs_export', { doc: ID, format: 'pdf', path: 'relative.pdf' }, t), /absolute/);
    await assert.rejects(callTool('docs_export', { doc: ID, format: 'xlsx', path: join(dir, 'a') }, t), /format must be one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs_rename and docs_open', async () => {
  const t = fakeTransport({ rename: { url: URL_, verified: true }, open: { url: URL_ } });
  assert.match(await callTool('docs_rename', { doc: ID, title: 'New name' }, t), /Renamed to "New name"/);
  assert.match(await callTool('docs_open', { doc: ID }, t), /Opened https/);
});

test('unknown tools are rejected', async () => {
  await assert.rejects(callTool('docs_nope', {}, fakeTransport()), /unknown tool/);
});

// ------------------------------------------------------------ human-style editing and templates

import { compileSteps } from '../server/tools.js';

test('compileSteps converts markdown/inline steps and derives what Drive must show', () => {
  const { steps, expect } = compileSteps([
    { find: 'Wendy Writer' },
    { text: '**Dylan** Santwani' },
    { format: { italic: true } },
    { caret: 'end' },
    { insert: '## Notes\n\n- one' },
    { find: { text: 'Agenda', occurrence: 2 } },
    { format: { style: 'heading2', color: 'red' } },
    { menu: 'Format > Text > Strikethrough' },
    { key: 'Tab', times: 2 },
  ]);
  assert.deepEqual(steps[0], { find: { text: 'Wendy Writer', occurrence: 1, matchCase: false, regex: false } });
  assert.deepEqual(steps[1], { inline: '<strong>Dylan</strong> Santwani' });
  assert.equal(steps[4].type[0].t, 'h');
  assert.deepEqual(steps[8], { key: 'Tab', times: 2 });
  assert.deepEqual(expect.probes, ['Dylan Santwani', 'Notes', 'one']);
  assert.deepEqual(expect.formats, [
    { text: 'Dylan Santwani', format: { italic: true } },
    { text: 'Agenda', format: { style: 'heading2', color: 'red' } },
  ]);
});

test('compileSteps rejects malformed steps with precise messages', () => {
  const cases = [
    [[], /non-empty/],
    [[{}], /exactly one action/],
    [[{ find: 'a', format: { bold: true } }], /exactly one action/],
    [[{ dance: 1 }], /unknown field/],
    [[{ find: '' }], /find needs text/],
    [[{ find: 'two\nlines' }], /within one paragraph/],
    [[{ text: 'a\nb' }], /use insert/],
    [[{ insert: '  ' }], /non-empty markdown/],
    [[{ format: { sparkle: true } }], /not a formatting option/],
    [[{ format: {} }], /empty/],
    [Array.from({ length: 61 }, () => ({ undo: 1 })), /at most 60/],
  ];
  for (const [steps, re] of cases) assert.throws(() => compileSteps(steps), re, JSON.stringify(steps).slice(0, 60));
});

test('docs_edit sends compiled steps and reports each step and the verification', async () => {
  const t = fakeTransport({
    edit: {
      title: 'Plan',
      url: URL_,
      results: [
        { step: 1, action: 'find', matches: 2 },
        { step: 2, action: 'format', applied: ['bold:on'] },
      ],
      verification: { verified: true },
    },
  });
  const out = await callTool('docs_edit', { doc: ID, steps: [{ find: 'Goal' }, { format: { bold: true } }] }, t);
  assert.equal(t.calls[0].op, 'edit');
  assert.deepEqual(t.calls[0].args.expect.formats, [{ text: 'Goal', format: { bold: true } }]);
  assert.match(out, /1\. find: 2 matches\n2\. format: bold:on\nverified in Drive/);
});

test('docs_edit explains unverified formatting and partial failures', async () => {
  const t = fakeTransport({ edit: { title: 'P', url: URL_, results: [], verification: { verified: false, waitedSeconds: 20, unmet: ['bold on "Goal"'] } } });
  assert.match(await callTool('docs_edit', { doc: ID, steps: [{ find: 'Goal' }, { format: { bold: true } }] }, t), /formatting not seen: bold on "Goal"/);
  const failing = fakeTransport({ edit: Object.assign(new Error('step 2 (find): text not found'), { code: 'anchor_not_found' }) });
  await assert.rejects(callTool('docs_edit', { doc: ID, steps: [{ caret: 'end' }, { find: 'zzz' }] }, failing), /steps before the failing one were applied/);
});

test('docs_format targets text, a section or the whole document', async () => {
  const t = fakeTransport({ edit: (a) => ({ title: 'P', url: URL_, results: [{ step: 2, action: 'format', applied: ['size:14'] }], verification: { verified: true }, _args: a }) });
  await callTool('docs_format', { doc: ID, text: 'Budget', occurrence: 2, format: { size: 14 } }, t);
  assert.deepEqual(t.calls[0].args.steps[0], { find: { text: 'Budget', occurrence: 2, matchCase: false, regex: false } });
  await callTool('docs_format', { doc: ID, section: 'Notes', format: { font: 'Georgia' } }, t);
  assert.deepEqual(t.calls[1].args.steps[0], { section: { heading: 'Notes' } });
  const out = await callTool('docs_format', { doc: ID, all: true, format: { lineSpacing: 1.5 } }, t);
  assert.deepEqual(t.calls[2].args.steps[0], { select: 'all' });
  assert.match(out, /the whole document/);
  await assert.rejects(callTool('docs_format', { doc: ID, text: 'a', section: 'b', format: { bold: true } }, t), /exactly one target/);
  await assert.rejects(callTool('docs_format', { doc: ID, all: true, format: { glitter: 1 } }, t), /not a formatting option/);
});

test('docs_fill replaces placeholders and sections, and reports what could not be done', async () => {
  const t = fakeTransport({
    replace: (a) => ({ title: 'Meeting', url: URL_, replaced: a.find === '{{name}}' ? 2 : 0, verification: { verified: true } }),
    write: (a) => (a.anchor === 'Missing' ? Promise.reject(Object.assign(new Error('no heading "Missing"'), { code: 'section_not_found' })) : { title: 'Meeting', url: URL_, verification: { verified: true } }),
  });
  const out = await callTool('docs_fill', { doc: ID, replace: { '{{name}}': 'Dylan', '[Date]': 'Oct 1' }, sections: { Attendees: '- Dylan\n- Pat', Missing: 'x' } }, t);
  assert.match(out, /✓ "\{\{name\}\}" → "Dylan" \(2×\)/);
  assert.match(out, /✗ "\[Date\]" not found/);
  assert.match(out, /✓ section "Attendees" replaced/);
  assert.match(out, /✗ section "Missing": no heading/);
  assert.match(out, /2 item\(s\) need attention/);
  const write = t.calls.find((c) => c.op === 'write' && c.args.anchor === 'Attendees');
  assert.equal(write.args.mode, 'replace_section');
  assert.equal(write.args.content.blocks[0].t, 'li');
  assert.equal(t.calls.find((c) => c.op === 'replace').args.matchCase, true);
  await assert.rejects(callTool('docs_fill', { doc: ID }, t), /replace and\/or sections/);
  await assert.rejects(callTool('docs_fill', { doc: ID, replace: { a: 'x\ny' } }, t), /line break/);
});

test('docs_templates groups gallery templates by name with their styles', async () => {
  const t = fakeTransport({
    templates: {
      items: [
        { id: 'a'.repeat(30), name: 'Resume', style: 'Coral' },
        { id: 'b'.repeat(30), name: 'Resume', style: 'Serif' },
        { id: 'c'.repeat(30), name: 'Meeting notes', style: 'Tropic' },
      ],
    },
  });
  const out = await callTool('docs_templates', {}, t);
  assert.match(out, /3 gallery templates/);
  assert.match(out, /- Resume — styles: Coral, Serif/);
  assert.match(out, /- Meeting notes — styles: Tropic/);
});

test('docs_create from a gallery template resolves "name (style)" and copies it with the title', async () => {
  const TPL = '1ogrWWMsheGBcV6KkLiI4mrnBrKG9hnMz1eOdPREiyPI';
  const t = fakeTransport({
    templates: { items: [{ id: 'x'.repeat(30), name: 'Meeting notes', style: 'Coral' }, { id: TPL, name: 'Meeting notes', style: 'Tropic' }] },
    copy: (a) => ({ id: 'n'.repeat(30), url: `https://docs.google.com/document/d/${'n'.repeat(30)}/edit`, title: a.title }),
  });
  const out = await callTool('docs_create', { title: 'Weekly sync', template: 'meeting notes (tropic)' }, t);
  assert.deepEqual(t.calls[1], { op: 'copy', args: { id: TPL, account: null, title: 'Weekly sync' }, opts: { timeout: 150_000 } });
  assert.match(out, /Created "Weekly sync" from gallery template "Meeting notes \(Tropic\)"/);
  assert.match(out, /docs_fill/);
  const byDoc = fakeTransport({ copy: { id: 'n'.repeat(30), url: 'u', title: 'Mine' } });
  await callTool('docs_create', { title: 'Mine', template: URL_ }, byDoc);
  assert.equal(byDoc.calls[0].args.id, ID, 'a document reference is copied directly, without the gallery');
  await assert.rejects(callTool('docs_create', { title: 'x', template: 'Nope' }, t), /available: Meeting notes \(Coral\), Meeting notes \(Tropic\)/);
  await assert.rejects(callTool('docs_create', { title: 'x', template: URL_, markdown: '# no' }, t), /docs_fill/);
});

test('docs_copy and docs_read structure', async () => {
  const t = fakeTransport({
    copy: { id: 'n'.repeat(30), url: 'https://docs.google.com/document/d/nnn/edit', title: 'Copy name' },
    read: { content: '<body><p class="title">T</p><h1>Sec</h1><p>{{x}}</p></body>', title: 'Doc', via: 'export' },
  });
  assert.match(await callTool('docs_copy', { doc: ID, title: 'Copy name' }, t), /Copied to "Copy name"/);
  const out = await callTool('docs_read', { doc: ID, format: 'structure' }, t);
  assert.equal(t.calls[1].args.format, 'html', 'structure is built from the html export');
  assert.match(out, /Title: T\n# Sec\n\{\{x\}\}\n\nplaceholders: \{\{x\}\}/);
});

test('docs_write replace_section passes the heading as anchor', async () => {
  const t = fakeTransport({ write: { title: 'T', url: URL_, verification: { verified: true } } });
  const out = await callTool('docs_write', { doc: ID, mode: 'replace_section', anchor: 'Notes', markdown: 'New notes' }, t);
  assert.equal(t.calls[0].args.anchor, 'Notes');
  assert.match(out, /replace section "Notes" done/);
  await assert.rejects(callTool('docs_write', { doc: ID, mode: 'replace_section', markdown: 'x' }, t), /anchor is required/);
});
