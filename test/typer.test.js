/**
 * Typing jobs (extension/lib/typer.js) against a simulated Docs page: the
 * page op "type" plays the plan into a fake document and stops at safe
 * points, like docs-page.js does. A fake clock ages tabs so the pool
 * replaces them mid-job.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTypingJobs, plannedMsBefore, TYPING_TAB_AGE_MS } from '../extension/lib/typer.js';
import { TabPool, TAB_MAX_AGE_MS } from '../extension/lib/tabs.js';
import { planTyping, typingSettings, resumeTail } from '../extension/lib/typing.js';
import { toTypingContent } from '../server/markdown.js';
import { fakeChrome, readyState } from './helpers/fake-chrome.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TEXT = [
  'The Industrial Revolution changed how people lived and worked and thought about time, and factories replaced workshops across the country.',
  'Workers did not set their own pace anymore because the machine did, and historians still argue about whether life got better or just faster.',
  'By the end of the century the railway had tied distant towns together and clocks everywhere agreed on the same hour for the first time.',
].join('\n');

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) {
      return { [key]: data[key] === undefined ? undefined : JSON.parse(JSON.stringify(data[key])) };
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = JSON.parse(JSON.stringify(v));
    },
  };
}

/**
 * A simulated document and page. Typing always happens at the end of the
 * text (fine for these tests); a resume by tail checks that the tail really
 * is where the caret goes.
 */
function sim({ onChunk = null, keysPerChunk = 60, chunkClockMs = 70_000, byEnd = true, failures = [], storage = memoryStorage(), editable = true, seed = 2, typos = 0.05, text = TEXT } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const doc = { text: '' };
  const stops = {};
  const calls = [];
  let started = false;
  const page = {
    state: () => readyState({ editable, ...(editable ? {} : { reason: 'view only' }) }),
    blocks: () => ({ ok: true, blocks: [{ tag: 'p', text: doc.text, inTable: false }] }),
    type: (a, tab) => {
      if (onChunk) onChunk(calls.length);
      calls.push({ tab: tab.id, position: !!a.position, resume: a.resume || null, at: a.at || null, budgetMs: a.budgetMs, blocks: a.blocks.length });
      const fail = failures.shift();
      if (fail?.before) return fail.before;
      if (a.resume?.tail && !doc.text.endsWith(a.resume.tail)) return { ok: false, code: 'anchor_not_found', message: `tail not at the end: ${a.resume.tail}` };
      let bi = a.at ? a.at.block : 0;
      let ei = a.at ? a.at.event : 0;
      let para = a.at ? a.at.para : '';
      let consumed = 0;
      let chars = 0;
      for (; bi < a.blocks.length; bi++, ei = 0, para = '') {
        const b = a.blocks[bi];
        if (ei === 0 && (started || bi > 0)) doc.text += '\n';
        started = true;
        for (; ei < (b.keys || []).length; ) {
          const k = b.keys[ei];
          if (k.c !== undefined) {
            doc.text += k.c;
            para += k.c;
            chars++;
          } else if (k.k === 'Backspace') {
            doc.text = doc.text.slice(0, -1);
            para = para.slice(0, -1);
            chars--;
          }
          ei++;
          consumed++;
          if (fail?.after === consumed) {
            return { ok: false, code: fail.code, message: 'boom', ...(fail.withTyping === false ? {} : { typing: { at: null, reached: { block: bi, event: ei, para, tail: resumeTail(para) }, chars, state: { list: null, indent: 0, fresh: false } } }) };
          }
          if (fail?.hangAfter === consumed) return new Promise(() => {}); // never answers
          if (k.s && (consumed >= keysPerChunk || stops[a.job])) {
            clock += chunkClockMs;
            return { ok: true, done: false, at: { block: bi, event: ei, para, tail: resumeTail(para) }, tail: resumeTail(para), chars, stopped: !!stops[a.job], state: { list: null, indent: 0, fresh: false } };
          }
        }
      }
      clock += chunkClockMs;
      return { ok: true, done: true, at: null, tail: null, chars, state: { list: null, indent: 0, fresh: false } };
    },
  };
  const api = fakeChrome({
    page,
    other: (func, args) => {
      stops[args[0]] = true;
      return true;
    },
  });
  api.storage = { local: storage };
  const pool = new TabPool({ api, now });
  const typing = createTypingJobs({ pool, api, now, saveWaitMs: 50, pollMs: 1, retryDelayMs: 1 });
  const c = toTypingContent({ text });
  const plan = planTyping(c.blocks, typingSettings({ seed, typos }), { byEnd });
  const startArgs = { id: ID, account: null, position: { mode: byEnd ? 'append' : 'insert_after', anchor: byEnd ? undefined : 'x' }, plan, probes: c.probes, byEnd, settings: { profile: 'natural', wpm: 55 }, text: c.text };
  return { api, pool, typing, doc, calls, plan, startArgs, stops, storage, tick: (ms) => (clock += ms), text };
}

test('a long job types in chunks, rotates to fresh tabs before they age out, and resumes exactly', async () => {
  const s = sim({ byEnd: false });
  const started = await s.typing.start(s.startArgs);
  assert.match(started.job, /^t/);
  const done = await s.typing.settled(started.job);
  assert.equal(done.status, 'done', done.error);
  assert.equal(s.doc.text, s.text, 'the document holds exactly the text, typos corrected, nothing doubled');
  assert.equal(done.charsTyped, [...s.text.replace(/\n/g, '')].length);
  assert.equal(done.percent, 100);
  assert.equal(done.verification.verified, true);
  // First chunk positions; same-tab chunks continue without re-finding;
  // each new tab re-finds the caret by the tail typed so far.
  assert.equal(s.calls[0].position, true);
  const tabs = [...new Set(s.calls.map((c) => c.tab))];
  assert.ok(tabs.length >= 2, `rotated tabs (${tabs.length})`);
  for (let i = 1; i < s.calls.length; i++) {
    const c = s.calls[i];
    if (c.tab === s.calls[i - 1].tab) assert.equal(c.resume, null, `chunk ${i} in the same tab`);
    else assert.ok(c.resume?.tail, `chunk ${i} in a new tab re-finds the caret`);
  }
  // No chunk may run past the point Chrome throttles the tab.
  assert.ok(s.calls.every((c) => c.budgetMs <= 90_000 && c.budgetMs >= 15_000));
  assert.equal(done.tabs, tabs.length);
});

test('append jobs resume by going to the end of the document', async () => {
  const s = sim({ byEnd: true });
  const { job } = await s.typing.start(s.startArgs);
  const done = await s.typing.settled(job);
  assert.equal(done.status, 'done', done.error);
  assert.equal(s.doc.text, s.text);
  const resumes = s.calls.filter((c) => c.resume);
  assert.ok(resumes.length >= 1);
  assert.ok(resumes.every((c) => c.resume.byEnd === true));
});

test('another call on the same document between chunks makes the job re-find its place', async () => {
  let other = null;
  const s = sim({
    byEnd: false,
    keysPerChunk: 40,
    chunkClockMs: 5_000,
    // While the first chunk types, another call queues on the document; it
    // runs before the job's next chunk.
    onChunk: (n) => {
      if (n === 0) other = s.pool.withDoc(ID, null, async () => 'someone else', 'read');
    },
  });
  const { job } = await s.typing.start(s.startArgs);
  const done = await s.typing.settled(job);
  assert.equal(done.status, 'done', done.error);
  assert.equal(s.doc.text, s.text);
  assert.equal(await other, 'someone else');
  const sameTabResume = s.calls.some((c, i) => i > 0 && c.tab === s.calls[i - 1].tab && c.resume);
  assert.ok(sameTabResume, 'resumed with a Find even though the tab was the same');
});

test('a page error mid-chunk is retried from exactly where the page got to', async () => {
  const s = sim({ byEnd: false, failures: [null, { after: 30, code: 'tab_error' }] });
  const { job } = await s.typing.start(s.startArgs);
  const done = await s.typing.settled(job);
  assert.equal(done.status, 'done', done.error);
  assert.equal(s.doc.text, s.text, 'nothing typed twice or skipped');
});

test('a hung tab interrupts the job; resume continues from the last confirmed chunk', async () => {
  const s = sim({ byEnd: true, keysPerChunk: 50, failures: [null, { after: 20, code: 'tab_stalled', withTyping: false }] });
  const { job } = await s.typing.start(s.startArgs);
  const r = await s.typing.settled(job);
  assert.equal(r.status, 'interrupted');
  assert.match(r.error, /tab_stalled.*may be typed again on resume/);
  const before = s.doc.text;
  const resumed = await s.typing.control({ job, action: 'resume' });
  assert.equal(resumed.status, 'running');
  const done = await s.typing.settled(job);
  assert.equal(done.status, 'done', done.error);
  // What the hung chunk typed is typed again after the last confirmed point.
  assert.ok(before.length > 0);
  assert.ok(s.doc.text.endsWith(s.text.slice(-60)));
  assert.notEqual(s.doc.text, s.text);
});

test('a hang during the first chunk fails the job instead of retyping the start', async () => {
  const s = sim({ failures: [{ after: 10, code: 'tab_unresponsive', withTyping: false }] });
  const { job } = await s.typing.start(s.startArgs);
  const r = await s.typing.settled(job);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /cannot tell exactly how much/);
  await assert.rejects(s.typing.control({ job, action: 'resume' }), /only a paused or interrupted job/);
});

test('pause stops at a safe point, resume finishes the text, cancel keeps what was typed', async () => {
  const s = sim({ byEnd: false, keysPerChunk: 1e9 });
  // keysPerChunk is huge: only the stop flag ends a chunk.
  const { job } = await s.typing.start(s.startArgs);
  s.stops[job] = true; // the page will stop at its first safe point
  const paused = await s.typing.control({ job, action: 'pause' });
  assert.equal(paused.status, 'paused');
  assert.ok(paused.percent > 0 && paused.percent < 100);
  assert.ok(s.text.startsWith(s.doc.text));
  delete s.stops[job];
  await s.typing.control({ job, action: 'resume' });
  const done = await s.typing.settled(job);
  assert.equal(done.status, 'done', done.error);
  assert.equal(s.doc.text, s.text);

  const t = sim({ byEnd: false, keysPerChunk: 1e9 });
  const second = await t.typing.start(t.startArgs);
  t.stops[second.job] = true;
  const cancelled = await t.typing.control({ job: second.job, action: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(t.doc.text.length > 0);
  await assert.rejects(t.typing.control({ job: second.job, action: 'resume' }), /only a paused or interrupted job/);
});

test('one job per document at a time', async () => {
  const s = sim({ keysPerChunk: 1e9 });
  const first = await s.typing.start(s.startArgs);
  await assert.rejects(s.typing.start(s.startArgs), /already typing into this document/);
  await s.typing.settled(first.job);
});

test('a read-only document fails the job with the reason', async () => {
  const s = sim({ editable: false });
  const { job } = await s.typing.start(s.startArgs);
  const r = await s.typing.settled(job);
  assert.equal(r.status, 'interrupted');
  assert.match(r.error, /read_only: the document is not editable \(view only\)/);
});

test('jobs are persisted; one that was running when the worker died loads as interrupted', async () => {
  const storage = memoryStorage();
  const s = sim({ storage });
  const { job } = await s.typing.start(s.startArgs);
  await s.typing.settled(job);
  const saved = storage.data.typingJobs;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'done');
  assert.deepEqual(saved[0].plan.blocks, [], 'finished jobs drop their plan');

  // A worker that stopped mid-job leaves a "running" row behind.
  storage.data.typingJobs = [{ ...saved[0], id: 'tdead', status: 'running', finishedAt: null, plan: s.plan, next: { block: 1, event: 0, para: '' } }];
  const t = sim({ storage });
  const r = await t.typing.status({ job: 'tdead' });
  assert.equal(r.status, 'interrupted');
  assert.match(r.error, /extension restarted/);
  const list = await t.typing.list();
  assert.equal(list.jobs[0].job, 'tdead');
  await assert.rejects(t.typing.status({ job: 'nope' }), /no typing job nope/);
});

test('progress and ETA come from the plan', async () => {
  const s = sim({ keysPerChunk: 1e9 });
  const blocks = s.plan.blocks;
  assert.equal(plannedMsBefore(blocks, null), s.plan.totalMs);
  assert.equal(plannedMsBefore(blocks, { block: 0, event: 0 }), 0);
  const mid = plannedMsBefore(blocks, { block: 1, event: 5 });
  assert.ok(mid > 0 && mid < s.plan.totalMs);
  assert.ok(TYPING_TAB_AGE_MS > TAB_MAX_AGE_MS && TYPING_TAB_AGE_MS < 5 * 60_000, 'chunks end before Chrome throttles a hidden tab at 5 minutes');
  const { job } = await s.typing.start(s.startArgs);
  await s.typing.settled(job);
});
