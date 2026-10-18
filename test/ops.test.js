import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOps, titleFromDisposition, blocksToMarkdown, countOccurrences, toBase64 } from '../extension/lib/ops.js';
import { TabPool } from '../extension/lib/tabs.js';
import { toDocsContent } from '../server/markdown.js';
import { fakeChrome, readyState, blocksOf } from './helpers/fake-chrome.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function response({ url = 'https://doc-0g.googleusercontent.com/export/x', status = 200, type = 'text/x-markdown; charset=utf-8', body = '', disposition } = {}) {
  const headers = new Headers({ 'content-type': type });
  if (disposition) headers.set('content-disposition', disposition);
  return {
    url,
    status,
    headers,
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

function setup({ page = {}, fetchImpl, list, tabUrl } = {}) {
  const api = fakeChrome({ page: { state: () => readyState(), ...page }, list, tabUrl });
  const pool = new TabPool({ api });
  const fetches = [];
  const { dispatch, ops } = createOps({
    pool,
    api,
    version: '0.1.0',
    verifyIntervalMs: 5,
    verifyTimeoutMs: 200,
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      return fetchImpl ? fetchImpl(url, init) : response();
    },
  });
  return { api, pool, dispatch, ops, fetches };
}

test('read uses the export endpoint with cookies and reports the title from Content-Disposition', async () => {
  const { dispatch, fetches } = setup({
    fetchImpl: () => response({ body: '# Hi\n', disposition: `attachment; filename="DocsAPIQuickstart.md"; filename*=UTF-8''Docs%20API%20Quickstart.md` }),
  });
  const r = await dispatch('read', { id: ID, account: '1', format: 'markdown' });
  assert.deepEqual(r, { content: '# Hi\n', title: 'Docs API Quickstart', via: 'export' });
  assert.equal(fetches[0].url, `https://docs.google.com/document/d/${ID}/export?format=md&authuser=1`);
  assert.equal(fetches[0].init.credentials, 'include');
});

test('read maps Google failure pages to specific errors', async () => {
  const cases = [
    [response({ status: 404, type: 'text/html' }), 'not_found'],
    [response({ status: 403, type: 'text/html' }), 'no_access'],
    [response({ url: `https://docs.google.com/document/d/${ID}/edit`, type: 'text/html' }), 'no_access'],
    [response({ type: 'text/html; charset=utf-8', body: '<html>Request access</html>' }), 'no_access'],
    [response({ status: 429, type: 'text/html' }), 'rate_limited'],
  ];
  for (const [res, code] of cases) {
    const { dispatch } = setup({ fetchImpl: () => res });
    await assert.rejects(dispatch('read', { id: ID, format: 'markdown' }), (e) => e.code === code, code);
  }
});

test('read falls back to the editor when the export path looks signed out', async () => {
  const { dispatch, api } = setup({
    fetchImpl: () => response({ url: 'https://accounts.google.com/v3/signin/identifier', type: 'text/html' }),
    page: {
      blocks: () => ({
        ok: true,
        blocks: [
          { tag: 'h1', text: 'Title', inTable: false },
          { tag: 'p', text: 'Body text', inTable: false },
          { tag: 'li', text: 'item', inTable: false },
        ],
      }),
    },
  });
  const r = await dispatch('read', { id: ID, format: 'markdown' });
  assert.equal(r.content, '# Title\n\nBody text\n\n- item\n');
  assert.match(r.via, /^editor \(export failed: /);
  assert.equal(api.created.length, 1);
});

test('html export is allowed to be text/html', async () => {
  const { dispatch } = setup({ fetchImpl: () => response({ type: 'text/html', body: '<p>x</p>' }) });
  assert.equal((await dispatch('read', { id: ID, format: 'html' })).content, '<p>x</p>');
});

test('binary export comes back as base64', async () => {
  const { dispatch } = setup({ fetchImpl: () => response({ type: 'application/pdf', body: '%PDF-1.7', disposition: 'attachment; filename="Report.pdf"' }) });
  const r = await dispatch('export', { id: ID, format: 'pdf' });
  assert.equal(Buffer.from(r.base64, 'base64').toString(), '%PDF-1.7');
  assert.equal(r.title, 'Report');
  await assert.rejects(dispatch('read', { id: ID, format: 'pdf' }), (e) => e.code === 'bad_args');
});

test('write runs the page op, then polls the saved document until every probe appears', async () => {
  let polls = 0;
  const { dispatch, api } = setup({
    page: {
      write: () => ({ ok: true, mode: 'append', anchorMatches: null }),
      blocks: () => (++polls < 3 ? blocksOf('old') : blocksOf('old', 'New section', 'Body line.')),
    },
  });
  const content = toDocsContent({ markdown: '## New section\n\nBody line.' });
  const r = await dispatch('write', { id: ID, mode: 'append', content });
  assert.equal(r.verification.verified, true);
  assert.equal(r.url, `https://docs.google.com/document/d/${ID}/edit`);
  assert.equal(r.title, 'Scratch');
  const write = api.scripts.find((s) => s.op === 'write');
  assert.equal(write.args.mode, 'append');
  assert.equal(write.args.content.html, '<h2>New section</h2><p>Body line.</p>');
});

test('when Find stalls, the write is retried once in a fresh tab', async () => {
  let attempts = 0;
  let written = false;
  const { dispatch, api } = setup({
    page: {
      write: () => {
        attempts++;
        if (attempts === 1) return { ok: false, code: 'find_stalled', message: 'stalled (nothing was changed)' };
        written = true;
        return { ok: true, anchorMatches: 1 };
      },
      blocks: () => blocksOf(written ? 'Intro [x]' : 'Intro'),
    },
  });
  const r = await dispatch('write', { id: ID, mode: 'insert_after', anchor: 'Intro', content: toDocsContent({ text: '[x]' }) });
  assert.equal(attempts, 2);
  assert.equal(r.verification.verified, true);
  assert.equal(api.created.length, 2, 'a second tab was opened');
  assert.equal(api.removed.length, 1, 'the wedged tab was closed');
  const writes = api.scripts.filter((x) => x.op === 'write');
  assert.notEqual(writes[0].tabId, writes[1].tabId);
});

test('a second stall is reported, not retried forever', async () => {
  const { dispatch } = setup({ page: { write: () => ({ ok: false, code: 'find_stalled', message: 'stalled' }), blocks: () => blocksOf('Intro') } });
  await assert.rejects(dispatch('write', { id: ID, mode: 'insert_after', anchor: 'Intro', content: toDocsContent({ text: 'x' }) }), (e) => e.code === 'find_stalled');
});

test('an unconfirmed write is reported with the missing text and keeps its tab alive', async () => {
  const { dispatch, pool } = setup({
    page: { write: () => ({ ok: true }), blocks: () => blocksOf('nothing new') },
  });
  const r = await dispatch('write', { id: ID, mode: 'append', content: toDocsContent({ text: 'Hello there' }) });
  assert.equal(r.verification.verified, false);
  assert.deepEqual(r.verification.missing, ['Hello there']);
  assert.equal(r.verification.unchanged, true);
  const [entry] = pool.entries.values();
  assert.ok(entry.dirtySince, 'tab marked dirty so sweep keeps it');
});

test('a paste Docs swallows without applying never verifies, even when the probes were already present', async () => {
  // Regression: on a view-only document the page accepted the paste, the
  // saved text never changed, and a one-character payload had no probes, so
  // verification passed vacuously. The saved text must actually change.
  const { dispatch } = setup({ page: { write: () => ({ ok: true }), blocks: () => blocksOf('x already here') } });
  const r = await dispatch('write', { id: ID, mode: 'append', content: toDocsContent({ text: 'x' }) });
  assert.equal(r.verification.verified, false);
  assert.equal(r.verification.unchanged, true);
});

test('deleting an anchor is verified by the occurrence count dropping', async () => {
  let deleted = false;
  const { dispatch } = setup({
    page: {
      write: () => {
        deleted = true;
        return { ok: true, anchorMatches: 2 };
      },
      blocks: () => (deleted ? blocksOf('typo once') : blocksOf('typo once', 'typo twice')),
    },
  });
  const r = await dispatch('write', { id: ID, mode: 'replace_text', anchor: 'typo', content: null });
  assert.equal(r.verification.verified, true);
  assert.equal(r.anchorMatches, 2);
});

test('writes to a read-only document are refused before touching it', async () => {
  const { dispatch, api } = setup({ page: { state: () => readyState({ editable: false, reason: 'view only' }) } });
  await assert.rejects(dispatch('write', { id: ID, mode: 'append', content: toDocsContent({ text: 'x' }) }), (e) => e.code === 'read_only');
  assert.ok(!api.scripts.some((s) => s.op === 'write'));
});

test('replace verifies the find text is gone, or that the replacement is present when it reintroduces it', async () => {
  let replaced = false;
  const a = setup({
    page: {
      replace_all: () => {
        replaced = true;
        return { ok: true, replaced: 3 };
      },
      blocks: () => (replaced ? blocksOf('dog dog dog') : blocksOf('cat cat cat')),
    },
  });
  const r = await a.dispatch('replace', { id: ID, find: 'cat', replace: 'dog' });
  assert.equal(r.replaced, 3);
  assert.equal(r.verification.verified, true);

  let bDone = false;
  const b = setup({
    page: {
      replace_all: () => {
        bDone = true;
        return { ok: true, replaced: 1 };
      },
      blocks: () => blocksOf(bDone ? 'cats' : 'cat'),
    },
  });
  assert.equal((await b.dispatch('replace', { id: ID, find: 'cat', replace: 'cats' })).verification.verified, true);

  const c = setup({ page: { replace_all: () => ({ ok: true, replaced: 0 }) } });
  const none = await c.dispatch('replace', { id: ID, find: 'emu', replace: 'x' });
  assert.equal(none.replaced, 0);
  assert.equal(none.verification, null);
});

test('create waits for the new document id, adopts the tab, titles it and writes the body', async () => {
  let written = false;
  const { dispatch, api } = setup({
    tabUrl: (url) => (url.includes('/create') ? `https://docs.google.com/document/d/${ID}/edit` : url),
    page: {
      title: (a) => ({ ok: true, title: a.title, verified: true }),
      write: () => {
        written = true;
        return { ok: true };
      },
      blocks: () => (written ? blocksOf('Plan', 'Step one') : blocksOf('')),
    },
  });
  const r = await dispatch('create', { title: 'Plan', account: '1', content: toDocsContent({ markdown: '# Plan\n\nStep one' }) });
  assert.equal(r.id, ID);
  assert.equal(r.url, `https://docs.google.com/document/d/${ID}/edit?authuser=1`);
  assert.equal(r.titleVerified, true);
  assert.equal(r.verification.verified, true);
  assert.equal(api.created.length, 1, 'the create tab is reused for the edits');
  assert.equal(api.created[0].requestedUrl, 'https://docs.google.com/document/create?authuser=1');
});

test('create reports a signed-out account', async () => {
  const { dispatch } = setup({ tabUrl: () => 'https://accounts.google.com/signin' });
  await assert.rejects(dispatch('create', { title: 'x' }), (e) => e.code === 'signed_out');
});

test('list runs the list page in a throwaway tab and closes it', async () => {
  const { dispatch, api } = setup({ list: (limit) => ({ ok: true, source: 'drive search', items: [{ id: ID, title: 'notes' }].slice(0, limit) }) });
  const r = await dispatch('list', { query: 'notes', limit: 5 });
  assert.deepEqual(r, { items: [{ id: ID, title: 'notes' }], source: 'drive search' });
  assert.match(api.created[0].requestedUrl, /^https:\/\/drive\.google\.com\/drive\/search\?q=type%3Adocument\+notes/);
  assert.deepEqual(api.removed, [api.created[0].id]);

  const bounced = setup({ tabUrl: () => 'https://accounts.google.com/v3/signin/identifier?continue=x', list: () => ({ ok: true, items: [] }) });
  await assert.rejects(bounced.dispatch('list', { query: 'x' }), (e) => e.code === 'signed_out');
  assert.equal(bounced.api.removed.length, 1, 'the sign-in tab is closed');

  const failing = setup({ list: () => ({ ok: false, code: 'signed_out', message: 'no' }) });
  await assert.rejects(failing.dispatch('list', {}), (e) => e.code === 'signed_out');
  assert.equal(failing.api.removed.length, 1, 'closed even on failure');
});

test('rename, open, status and unknown ops', async () => {
  const { dispatch, api } = setup({ page: { title: (a) => ({ ok: true, verified: true, title: a.title }) } });
  assert.equal((await dispatch('rename', { id: ID, title: 'New' })).verified, true);
  const opened = await dispatch('open', { id: ID, account: '0' });
  assert.equal(opened.url, `https://docs.google.com/document/d/${ID}/edit?authuser=0`);
  assert.equal(api.created.at(-1).active, true);
  const s = await dispatch('status', {});
  assert.equal(s.version, '0.1.0');
  assert.equal(typeof s.managedTabs, 'number');
  await assert.rejects(dispatch('toString', {}), (e) => e.code === 'bad_request');
  await assert.rejects(dispatch('nope', {}), (e) => e.code === 'bad_request');
});

test('helpers', () => {
  assert.equal(titleFromDisposition(`attachment; filename="a.md"; filename*=UTF-8''My%20Doc.md`), 'My Doc');
  assert.equal(titleFromDisposition('attachment; filename="Report.pdf"'), 'Report');
  assert.equal(titleFromDisposition(null), null);
  assert.equal(countOccurrences('Cat cat CAT', 'cat', false), 3);
  assert.equal(countOccurrences('Cat cat CAT', 'cat', true), 1);
  assert.equal(countOccurrences('aaaa', 'aa', true), 2);
  assert.equal(countOccurrences('x', '', true), 0);
  assert.equal(blocksToMarkdown([{ tag: 'p', text: 'a', inTable: true }]), '| a |\n');
  assert.equal(Buffer.from(toBase64(new Uint8Array([0, 255, 1]).buffer), 'base64').toString('hex'), '00ff01');
});

// ------------------------------------------------------------ edit, copy, templates

import { unmetFormats, locate } from '../extension/lib/ops.js';

const run = (text, style = {}, extra = {}) => ({ text, style, ...extra });
const block = (runs, extra = {}) => ({ tag: 'p', cls: null, text: runs.map((r) => r.text).join(''), inTable: false, list: null, align: null, runs, ...extra });

test('unmetFormats checks effective run styles and paragraph properties on the target text', () => {
  const blocks = [
    block([run('Intro ', {}), run('Goal', { 'font-weight': '700', 'font-style': 'italic', color: '#ff0000', 'font-size': '14pt', 'font-family': 'Georgia' }), run(' end')]),
    block([run('Heading')], { tag: 'h2', align: 'center' }),
    block([run('item')], { tag: 'li', list: { ordered: true, depth: 0 } }),
    block([run('site', { 'text-decoration': 'underline' }, { href: 'https://example.com/' })]),
  ];
  assert.deepEqual(unmetFormats(blocks, 'Goal', { bold: true, italic: true, color: 'red', size: 14, font: 'georgia' }), []);
  assert.deepEqual(unmetFormats(blocks, 'Goal', { underline: true, highlight: 'yellow', size: 12 }), ['underline', 'size', 'highlight']);
  assert.deepEqual(unmetFormats(blocks, 'Heading', { style: 'heading2', align: 'center' }), []);
  assert.deepEqual(unmetFormats(blocks, 'Heading', { style: 'title', align: 'left' }), ['style', 'align']);
  assert.deepEqual(unmetFormats(blocks, 'item', { list: 'numbered' }), []);
  assert.deepEqual(unmetFormats(blocks, 'item', { list: 'bullet' }), ['list']);
  assert.deepEqual(unmetFormats(blocks, 'site', { link: 'https://example.com' }), []);
  assert.deepEqual(unmetFormats(blocks, 'nowhere', { bold: true }), ['text "nowhere" not found']);
  assert.deepEqual(unmetFormats(blocks, 'Goal', { color: 'some unlisted palette name' }), [], 'unverifiable colours are not held against the edit');
  assert.equal(locate(blocks, 'goal').runs.length, 1, 'case-insensitive location');
});

test('edit runs the steps, then verifies both text and formatting in the saved document', async () => {
  let edited = false;
  const saved = () =>
    edited
      ? { ok: true, blocks: [block([run('Plan: '), run('Goal', { 'font-weight': '700' })]), block([run('Added')])] }
      : { ok: true, blocks: [block([run('Plan: Goal')])] };
  const { dispatch, api } = setup({
    page: {
      edit: () => {
        edited = true;
        return { ok: true, results: [{ step: 1, action: 'find', matches: 1 }, { step: 2, action: 'format', applied: ['bold:on'] }] };
      },
      blocks: saved,
    },
  });
  const r = await dispatch('edit', {
    id: ID,
    steps: [{ find: { text: 'Goal' } }, { format: { bold: true } }, { caret: 'end' }, { type: [{ t: 'p', html: 'Added' }] }],
    expect: { probes: ['Added'], formats: [{ text: 'Goal', format: { bold: true } }] },
  });
  assert.equal(r.verification.verified, true, JSON.stringify(r.verification));
  assert.equal(r.results.length, 2);
  assert.equal(api.scripts.find((s) => s.op === 'edit').args.steps.length, 4);
});

test('edit reports formatting that never showed up', async () => {
  let edited = false;
  const { dispatch } = setup({
    page: {
      edit: () => {
        edited = true;
        return { ok: true, results: [] };
      },
      blocks: () => ({ ok: true, blocks: [block([run(edited ? 'Goal ' : 'Goal'), run('x')])] }),
    },
  });
  const r = await dispatch('edit', { id: ID, steps: [{ find: { text: 'Goal' } }, { format: { bold: true } }], expect: { formats: [{ text: 'Goal', format: { bold: true } }] } });
  assert.equal(r.verification.verified, false);
  assert.deepEqual(r.verification.unmet, ['bold on "Goal"']);
});

test('selection-only edits skip verification', async () => {
  const { dispatch } = setup({ page: { edit: () => ({ ok: true, results: [{ step: 1, action: 'find' }] }) } });
  const r = await dispatch('edit', { id: ID, steps: [{ find: { text: 'x' } }] });
  assert.equal(r.verification, null);
});

test('a Find stall mid-edit is retried in a fresh tab only when nothing had changed yet', async () => {
  let calls = 0;
  const early = setup({
    page: {
      edit: () => (++calls === 1 ? { ok: false, code: 'find_stalled', message: 'stalled', completed: [{ step: 1, action: 'caret' }] } : { ok: true, results: [] }),
      blocks: () => ({ ok: true, blocks: [block([run(calls > 1 ? 'b' : 'a')])] }),
    },
  });
  await early.dispatch('edit', { id: ID, steps: [{ caret: 'end' }, { find: { text: 'a' } }, { delete: true }] });
  assert.equal(calls, 2);
  assert.equal(early.api.created.length, 2);

  const late = setup({
    page: {
      edit: () => ({ ok: false, code: 'find_stalled', message: 'stalled', completed: [{ step: 1, action: 'type' }] }),
      blocks: () => ({ ok: true, blocks: [] }),
    },
  });
  await assert.rejects(late.dispatch('edit', { id: ID, steps: [{ type: [] }, { find: { text: 'a' } }] }), (e) => e.code === 'find_stalled');
  assert.equal(late.api.created.length, 1, 'no retry after text was typed');
});

test('copy opens Make a copy with the title, waits for the new document and adopts its tab', async () => {
  const NEW = 'N'.repeat(44);
  const { dispatch, api, pool } = setup({
    tabUrl: (url) => url,
    page: { state: () => readyState({ title: 'Weekly sync' }) },
  });
  api.scripting.executeScript = ((orig) => async (opts) => {
    if (opts.func.name === 'makeCopyPage') {
      api._tab(opts.target.tabId).url = `https://docs.google.com/document/d/${NEW}/edit?tab=t.0`;
      return [{ result: { ok: true } }];
    }
    return orig(opts);
  })(api.scripting.executeScript);
  const r = await dispatch('copy', { id: ID, title: 'Weekly sync' });
  assert.equal(r.id, NEW);
  assert.equal(r.title, 'Weekly sync');
  assert.equal(api.created[0].requestedUrl, `https://docs.google.com/document/d/${ID}/copy?title=Weekly+sync`);
  assert.equal(pool.count(), 1, 'the copy tab is kept for follow-up edits');
});

test('copy surfaces access problems from the copy page', async () => {
  const { dispatch, api } = setup({});
  api.scripting.executeScript = async () => [{ result: { ok: false, code: 'no_access', message: 'no access to the source document' } }];
  await assert.rejects(dispatch('copy', { id: ID }), (e) => e.code === 'no_access');
  assert.equal(api.removed.length, 1);
});

test('templates reads the gallery in a throwaway tab', async () => {
  const { dispatch, api } = setup({});
  api.scripting.executeScript = async () => [{ result: { ok: true, items: [{ id: 'x'.repeat(30), name: 'Resume', style: 'Coral' }] } }];
  const r = await dispatch('templates', {});
  assert.deepEqual(r.items, [{ id: 'x'.repeat(30), name: 'Resume', style: 'Coral' }]);
  assert.equal(api.created[0].requestedUrl, 'https://docs.google.com/document/?ftv=1&tgif=d');
  assert.deepEqual(api.removed, [api.created[0].id]);
});

test('typing ops route to the job runner; reload refuses to cut off a running job', async () => {
  const calls = [];
  const typing = {
    start: async (a) => (calls.push(['start', a]), { job: 't1', status: 'running' }),
    status: async (a) => (calls.push(['status', a]), { job: 't1', status: 'running' }),
    list: async () => ({ jobs: [{ job: 't1', status: 'running' }] }),
    control: async (a) => (calls.push(['control', a]), { job: 't1', status: 'paused' }),
  };
  const api = fakeChrome({ page: { state: () => readyState() } });
  let reloaded = 0;
  api.runtime = { reload: () => reloaded++ };
  const { dispatch } = createOps({ pool: new TabPool({ api }), api, version: '0.3.0', typing });
  assert.equal((await dispatch('type_start', { id: ID, plan: {} })).job, 't1');
  await dispatch('type_status', { job: 't1' });
  await dispatch('type_control', { job: 't1', action: 'pause' });
  assert.deepEqual(calls.map((c) => c[0]), ['start', 'status', 'control']);
  await assert.rejects(dispatch('reload', {}), /typing job\(s\) are running \(t1\)/);
  const r = await dispatch('reload', { force: true });
  assert.deepEqual(r, { version: '0.3.0', interrupted: 1 });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(reloaded, 1);
});
