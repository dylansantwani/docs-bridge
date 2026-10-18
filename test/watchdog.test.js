/**
 * Nothing that waits on a Docs tab may wait forever. Regression for a live
 * hang (2026-09-30): one edit on a document never came back, so its queue
 * held every later edit to that document while reads still worked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { TabPool, runInTab, setTiming, HEARTBEAT_MS, PROBE_TIMEOUT_MS, STALL_MS, RUN_MAX_MS } from '../extension/lib/tabs.js';
import { createOps } from '../extension/lib/ops.js';
import { docsPageOp } from '../extension/page/docs-page.js';
import { fakeChrome, readyState } from './helpers/fake-chrome.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const OTHER = '1TestDocBIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => setTiming({ heartbeatMs: 20, probeTimeoutMs: 30, stallMs: 120, maxMs: 2_000 }));
after(() => setTiming({ heartbeatMs: HEARTBEAT_MS, probeTimeoutMs: PROBE_TIMEOUT_MS, stallMs: STALL_MS, maxMs: RUN_MAX_MS }));

async function openTab(api) {
  return (await api.tabs.create({ url: `https://docs.google.com/document/d/${ID}/edit` })).id;
}

test('a page that stops answering fails the call as tab_unresponsive instead of hanging', async () => {
  const api = fakeChrome({ page: { edit: never }, progress: never });
  const tab = await openTab(api);
  const err = await runInTab(tab, docsPageOp, ['edit', {}], api).catch((e) => e);
  assert.equal(err.code, 'tab_unresponsive');
  assert.match(err.message, /Chrome has frozen or hung it/);
});

test('an op that stops making progress fails as tab_stalled and names the step it was on', async () => {
  const api = fakeChrome({ page: { edit: never }, progress: () => ({ label: 'step 1 of 5 (caret)', beat: 7 }) });
  const tab = await openTab(api);
  const err = await runInTab(tab, docsPageOp, ['edit', {}], api).catch((e) => e);
  assert.equal(err.code, 'tab_stalled');
  assert.match(err.message, /no progress .*stuck at: step 1 of 5 \(caret\)/);
});

test('a slow op that keeps making progress is left alone', async () => {
  let beat = 0;
  const api = fakeChrome({
    page: { edit: async () => (await sleep(400), { ok: true, results: [] }) },
    progress: () => ({ label: 'typing', beat: beat++ }),
  });
  const tab = await openTab(api);
  const r = await runInTab(tab, docsPageOp, ['edit', {}], api);
  assert.deepEqual(r, { ok: true, results: [] });
});

test('an op that keeps beating forever still ends at the hard cap', async () => {
  setTiming({ maxMs: 300 });
  try {
    let beat = 0;
    const api = fakeChrome({ page: { edit: never }, progress: () => ({ label: 'waiting', beat: beat++ }) });
    const tab = await openTab(api);
    const err = await runInTab(tab, docsPageOp, ['edit', {}], api).catch((e) => e);
    assert.equal(err.code, 'tab_stalled');
    assert.match(err.message, /still busy after/);
  } finally {
    setTiming({ maxMs: 2_000 });
  }
});

test('a wedged tab is closed, and the next call on that document gets a fresh one', async () => {
  let hang = true;
  const api = fakeChrome({
    page: { state: () => readyState(), edit: () => (hang ? never() : { ok: true, results: [] }) },
    progress: (tab) => (hang ? never() : { label: '', beat: 0 }),
  });
  const pool = new TabPool({ api });
  const first = await pool.withDoc(ID, null, (tabId) => runInTab(tabId, docsPageOp, ['edit', {}], api), 'edit').catch((e) => e);
  assert.equal(first.code, 'tab_unresponsive');
  assert.match(first.message, /stuck tab was closed/);
  assert.deepEqual(api.removed, [api.created[0].id]);

  hang = false;
  const second = await pool.withDoc(ID, null, (tabId) => runInTab(tabId, docsPageOp, ['edit', {}], api), 'edit');
  assert.deepEqual(second, { ok: true, results: [] });
  assert.equal(api.created.length, 2, 'the retry opened a fresh tab');
});

test('a call past its deadline is abandoned: its tab closes and the document queue is free again', async (t) => {
  setTiming({ maxMs: 60_000 });
  t.after(() => setTiming({ maxMs: 2_000 }));
  let block = true;
  let beat = 0;
  const api = fakeChrome({
    page: {
      state: () => readyState(),
      blocks: () => ({ ok: true, blocks: [] }),
      edit: () => (block ? never() : { ok: true, results: [{ action: 'caret' }] }),
    },
    // The page keeps beating, so only the call's own deadline can end it.
    progress: () => ({ label: 'waiting', beat: beat++ }),
  });
  const { dispatch, pool } = createOps({ api, pool: new TabPool({ api }), verifyTimeoutMs: 50, verifyIntervalMs: 10 });
  const steps = [{ caret: 'end' }];
  const started = Date.now();
  const err = await dispatch('edit', { id: ID, account: '1', steps }, { timeout: 15_200 }).catch((e) => e);
  assert.equal(err.code, 'timeout');
  assert.match(err.message, /edit did not finish within 10s; its bridge tab was closed/);
  assert.ok(Date.now() - started < 12_000);
  await sleep(10);
  assert.equal(api.removed.length, 1, 'the stuck tab was closed');
  assert.equal(pool.count(), 0, 'the stuck entry was dropped');

  // Before the fix this waited behind the stuck call forever.
  block = false;
  const r = await dispatch('edit', { id: ID, account: '1', steps }, { timeout: 15_200 });
  assert.deepEqual(r.results, [{ action: 'caret' }]);
});

test('status reports what each bridge tab is doing', async () => {
  const api = fakeChrome({ page: { state: () => readyState(), edit: never }, progress: () => ({ label: 'x', beat: 0 }) });
  const { dispatch, pool } = createOps({ api, pool: new TabPool({ api }) });
  const pending = pool.withDoc(OTHER, '1', (tabId) => runInTab(tabId, docsPageOp, ['edit', {}], api), 'edit').catch(() => {});
  await sleep(30);
  const s = await dispatch('status', {});
  assert.equal(s.tabs.length, 1);
  assert.equal(s.tabs[0].doc, OTHER);
  assert.equal(s.tabs[0].account, '1');
  assert.equal(s.tabs[0].busy, true);
  assert.equal(s.tabs[0].doing, 'edit');
  await pending;
});

test('bridge tabs are exempt from Memory Saver discarding, and a discarded tab is replaced', async () => {
  const api = fakeChrome({ page: { state: () => readyState() } });
  const pool = new TabPool({ api });
  await pool.withDoc(ID, null, async () => {});
  await sleep(0);
  assert.deepEqual(api.updated, [{ id: api.created[0].id, props: { autoDiscardable: false } }]);
  api._tab(api.created[0].id).discarded = true;
  await pool.withDoc(ID, null, async () => {});
  assert.equal(api.created.length, 2);
  assert.deepEqual(api.removed, [api.created[0].id]);
});

test('Drive search survives a redirect that removes the injected frame', async () => {
  let calls = 0;
  const api = fakeChrome({
    list: () => {
      calls++;
      if (calls === 1) throw new Error('Frame with ID 0 was removed.');
      return { ok: true, source: 'drive search', items: [{ id: ID, title: 'scratch' }] };
    },
  });
  const { dispatch } = createOps({ api, pool: new TabPool({ api }) });
  const r = await dispatch('list', { query: 'scratch', limit: 5, account: '0' });
  assert.equal(calls, 2);
  assert.deepEqual(r.items, [{ id: ID, title: 'scratch' }]);
});
