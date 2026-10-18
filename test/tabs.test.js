import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TabPool, TAB_MAX_AGE_MS, TAB_IDLE_MS, TAB_DIRTY_MAX_MS, pageOp } from '../extension/lib/tabs.js';
import { fakeChrome, readyState } from './helpers/fake-chrome.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('a document gets a background tab, never activated, filed in a collapsed group', async () => {
  const api = fakeChrome({ page: { state: () => readyState() } });
  const pool = new TabPool({ api });
  const state = await pool.withDoc(ID, '1', async (tabId, entry, s) => ({ tabId, s }));
  assert.equal(api.created.length, 1);
  assert.equal(api.created[0].active, false);
  assert.equal(api.created[0].windowId, 1);
  assert.equal(api.created[0].requestedUrl, `https://docs.google.com/document/d/${ID}/edit?authuser=1`);
  assert.equal(state.s.ready, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(api.groupUpdates[0].props, { title: 'Docs Bridge', color: 'blue', collapsed: true });
});

test('tabs are reused while fresh and replaced once they near the hidden-tab throttling age', async () => {
  const c = clock();
  const api = fakeChrome({ page: { state: () => readyState() } });
  const pool = new TabPool({ api, now: c.now });
  const first = await pool.withDoc(ID, null, async (tabId) => tabId);
  c.t += TAB_MAX_AGE_MS - 1000;
  const second = await pool.withDoc(ID, null, async (tabId) => tabId);
  assert.equal(second, first, 'reused while younger than the max age');
  c.t += 2000;
  const third = await pool.withDoc(ID, null, async (tabId) => tabId);
  assert.notEqual(third, first, 'replaced after the max age');
  assert.deepEqual(api.removed, [first]);
});

test('a tab the user navigated away is replaced', async () => {
  const api = fakeChrome({ page: { state: () => readyState() } });
  const pool = new TabPool({ api });
  const first = await pool.withDoc(ID, null, async (tabId) => tabId);
  api._tab(first).url = 'https://www.google.com/';
  const second = await pool.withDoc(ID, null, async (tabId) => tabId);
  assert.notEqual(second, first);
});

test('work on one document is serialised; different documents run in parallel', async () => {
  const api = fakeChrome({ page: { state: () => readyState() } });
  const pool = new TabPool({ api });
  let active = 0;
  let maxActive = 0;
  const job = () =>
    pool.withDoc(ID, null, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
  await Promise.all([job(), job(), job()]);
  assert.equal(maxActive, 1);

  let parallel = 0;
  let maxParallel = 0;
  const other = (id) =>
    pool.withDoc(id, null, async () => {
      parallel++;
      maxParallel = Math.max(maxParallel, parallel);
      await new Promise((r) => setTimeout(r, 20));
      parallel--;
    });
  await Promise.all([other('a'.repeat(30)), other('b'.repeat(30))]);
  assert.equal(maxParallel, 2);
});

test('a failing job does not poison the queue for the next one', async () => {
  const api = fakeChrome({ page: { state: () => readyState() } });
  const pool = new TabPool({ api });
  await assert.rejects(pool.withDoc(ID, null, async () => {
    throw new Error('boom');
  }));
  assert.equal(await pool.withDoc(ID, null, async () => 'next'), 'next');
});

test('loading failures become specific errors', async () => {
  const signedOut = fakeChrome({ tabUrl: () => 'https://accounts.google.com/v3/signin/identifier' });
  await assert.rejects(new TabPool({ api: signedOut }).withDoc(ID, null, async () => {}), (e) => e.code === 'signed_out');

  const denied = fakeChrome({ page: { state: () => ({ ok: true, ready: false, accessDenied: true }) } });
  await assert.rejects(new TabPool({ api: denied }).withDoc(ID, '1', async () => {}), (e) => e.code === 'no_access' && /account 1/.test(e.message));

  const missing = fakeChrome({ page: { state: () => ({ ok: true, ready: false, notFound: true }) } });
  await assert.rejects(new TabPool({ api: missing }).withDoc(ID, null, async () => {}), (e) => e.code === 'not_found');
});

test('waitForEditor keeps polling through a loading page and times out with the last state', async () => {
  let calls = 0;
  const api = fakeChrome({
    page: {
      state: () => {
        calls++;
        return calls < 3 ? { ok: true, ready: false, reason: 'loading' } : readyState();
      },
    },
  });
  const pool = new TabPool({ api });
  const tabId = await pool.openBackground('https://docs.google.com/document/d/x/edit');
  const s = await pool.waitForEditor(tabId, { docId: ID });
  assert.equal(s.ready, true);
  assert.equal(calls, 3);

  const never = fakeChrome({ page: { state: () => ({ ok: true, ready: false, reason: 'loading' }) } });
  const p2 = new TabPool({ api: never });
  const t2 = await p2.openBackground('https://docs.google.com/document/d/x/edit');
  await assert.rejects(p2.waitForEditor(t2, { docId: ID, timeout: 300 }), (e) => e.code === 'timeout' && /last state/.test(e.message));
});

test('sweep closes idle tabs but keeps busy ones and ones with unconfirmed writes', async () => {
  const c = clock();
  const api = fakeChrome({ page: { state: () => readyState() } });
  const pool = new TabPool({ api, now: c.now });
  const idle = await pool.withDoc('i'.repeat(30), null, async (tabId) => tabId);
  const dirty = await pool.withDoc('d'.repeat(30), null, async (tabId, entry) => {
    entry.dirtySince = c.t;
    return tabId;
  });
  let release;
  const busyJob = pool.withDoc('b'.repeat(30), null, () => new Promise((r) => (release = r)));
  await new Promise((r) => setTimeout(r, 10));

  c.t += TAB_IDLE_MS + 1000;
  await pool.sweep();
  assert.ok(api.removed.includes(idle));
  assert.ok(!api.removed.includes(dirty));
  assert.equal(pool.count(), 2);

  c.t += TAB_DIRTY_MAX_MS;
  await pool.sweep();
  assert.ok(api.removed.includes(dirty), 'dirty tabs are closed eventually');
  release();
  await busyJob;
});

test('forgetTab drops entries for tabs the user closed', async () => {
  const api = fakeChrome({ page: { state: () => readyState() } });
  const pool = new TabPool({ api });
  const tabId = await pool.withDoc(ID, null, async (t) => t);
  pool.forgetTab(tabId);
  assert.equal(pool.count(), 0);
});

test('pageOp unwraps the page envelope into errors with codes', async () => {
  const api = fakeChrome({ page: { write: () => ({ ok: false, code: 'anchor_not_found', message: 'nope' }) } });
  const tab = await api.tabs.create({ url: 'https://docs.google.com/document/d/x/edit' });
  await assert.rejects(pageOp(tab.id, 'write', {}, api), (e) => e.code === 'anchor_not_found');
  await assert.rejects(pageOp(999, 'write', {}, api), (e) => e.code === 'tab_error');
});
