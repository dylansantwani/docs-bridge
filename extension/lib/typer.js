/**
 * Typing jobs: docs_type plays a keystroke plan (typing.js) into a document
 * over minutes, which no single page call can hold.
 *
 * A job runs in chunks. Each chunk is one page op ("type") in the document's
 * bridge tab and stops at a safe point in the plan when its budget runs out.
 * The budget keeps every chunk inside the window where a hidden tab still
 * behaves (tabs.js: after five minutes hidden, Docs' timers, saving and Find
 * slow to a crawl). When the tab gets too old the pool opens a fresh one,
 * and the next chunk first puts the caret back: at the end of the document,
 * or right after the text typed so far in the current paragraph, found with
 * Find. Before a tab is given up, the job waits until Drive has saved what it
 * typed, so the new tab sees it.
 *
 * Jobs live in the service worker, so they outlive the MCP call (and the MCP
 * client) that started them. State is persisted after every chunk; a job the
 * extension was restarted in the middle of is reported as interrupted and can
 * be resumed.
 */

import { OpError, TAB_MAX_AGE_MS, pageOp, sleep } from './tabs.js';
import { fold } from './typing.js';
import { editUrl } from './refs.js';

/** How long past TAB_MAX_AGE_MS a chunk may keep typing in a tab (Chrome's heavy throttling starts at 5 min hidden). */
export const TYPING_TAB_AGE_MS = TAB_MAX_AGE_MS + 30_000;
export const CHUNK_MS = 90_000;
export const MIN_CHUNK_MS = 15_000;
const SAVE_WAIT_MS = 25_000;
const POLL_MS = 900;
const MAX_RETRIES = 3;
const KEEP_JOBS = 20;
const STORAGE_KEY = 'typingJobs';
// Failures the page reports with an exact position (or before typing
// anything), so a retry neither skips nor repeats text. A hung tab reports
// nothing, so those are never retried automatically.
const RETRYABLE = new Set(['find_stalled', 'tab_error', 'not_ready', 'read_failed', 'tab_closed', 'paste_ignored']);
const HUNG = new Set(['tab_unresponsive', 'tab_stalled', 'timeout', 'abandoned']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);

let counter = 0;
const newId = (now) => `t${now.toString(36)}${(counter++).toString(36)}`;

/** Planned milliseconds before position {block, event}. */
export function plannedMsBefore(blocks, at) {
  if (!at) return blocks.reduce((t, b) => t + (b.before || 0) + (b.keys || []).reduce((s, k) => s + k.d, 0), 0);
  let t = 0;
  for (let i = 0; i < Math.min(at.block, blocks.length); i++) t += (blocks[i].before || 0) + (blocks[i].keys || []).reduce((s, k) => s + k.d, 0);
  const b = blocks[at.block];
  if (b && at.event > 0) {
    t += b.before || 0;
    for (let j = 0; j < Math.min(at.event, b.keys?.length || 0); j++) t += b.keys[j].d;
  }
  return t;
}

export function createTypingJobs({ pool, api = chrome, now = () => Date.now(), log = () => {}, saveWaitMs = SAVE_WAIT_MS, pollMs = POLL_MS, chunkMs = CHUNK_MS, retryDelayMs = 2000 } = {}) {
  const jobs = new Map();
  const running = new Map(); // job id → the promise of its run
  const storage = api.storage?.local;
  let keepAlive = null;
  let loaded = null;

  function load() {
    if (!loaded) {
      loaded = (async () => {
        if (!storage) return;
        try {
          const saved = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY] || [];
          for (const j of saved) {
            // A job that was running when the worker stopped did not finish.
            if (j.status === 'running') {
              j.status = 'interrupted';
              j.error = j.error || 'the extension restarted while this job was typing';
            }
            jobs.set(j.id, j);
          }
        } catch (err) {
          log(`could not load typing jobs: ${err.message}`);
        }
      })();
    }
    return loaded;
  }

  async function persist() {
    if (!storage) return;
    const list = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    const keep = list.slice(-KEEP_JOBS);
    for (const j of list.slice(0, -KEEP_JOBS)) jobs.delete(j.id);
    // A finished job no longer needs its plan.
    const rows = keep.map((j) => (FINISHED.has(j.status) ? { ...j, plan: { ...j.plan, blocks: [] } } : j));
    try {
      await storage.set({ [STORAGE_KEY]: rows });
    } catch (err) {
      log(`could not save typing jobs: ${err.message}`);
    }
  }

  function updateKeepAlive() {
    const running = [...jobs.values()].some((j) => j.status === 'running');
    if (running && !keepAlive) {
      // Extension API calls keep an MV3 worker from being suspended.
      keepAlive = setInterval(() => Promise.resolve(api.runtime?.getPlatformInfo?.()).catch(() => {}), 20_000);
    } else if (!running && keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  }

  function summary(j) {
    const total = j.plan.totalMs || 1;
    let percent = j.percent ?? 0;
    let doneMs = (percent / 100) * total;
    if (j.status === 'done') {
      percent = 100;
      doneMs = total;
    } else if (j.plan.blocks.length) {
      doneMs = j.next === 'start' ? 0 : plannedMsBefore(j.plan.blocks, j.next);
      percent = Math.min(99, Math.round((doneMs / total) * 100));
    }
    j.percent = percent;
    const elapsedMs = (j.finishedAt || now()) - (j.startedAt || j.createdAt);
    return {
      job: j.id,
      status: j.status,
      doc: j.docId,
      account: j.account ?? null,
      title: j.title || null,
      url: editUrl(j.docId, j.account),
      mode: j.position?.mode,
      percent,
      charsTyped: j.charsTyped,
      totalChars: j.plan.chars,
      typosPlanned: j.plan.typos,
      plannedMs: j.plan.totalMs,
      elapsedMs,
      remainingMs: FINISHED.has(j.status) ? 0 : Math.max(0, total - doneMs),
      chunks: j.chunks,
      tabs: j.tabsUsed,
      settings: j.settings,
      ...(j.error ? { error: j.error } : {}),
      ...(j.verification ? { verification: j.verification } : {}),
      createdAt: j.createdAt,
      finishedAt: j.finishedAt || null,
    };
  }

  /** Poll the saved document until `test(foldedText)` holds. */
  async function waitSaved(tabId, test) {
    const started = now();
    while (now() - started < saveWaitMs) {
      try {
        const { blocks } = await pageOp(tabId, 'blocks', {}, api);
        if (test(fold(blocks.map((b) => b.text).join('\n')))) return { saved: true, waitedSeconds: Math.round((now() - started) / 1000) };
      } catch {
        // transient; keep polling
      }
      await sleep(pollMs);
    }
    return { saved: false, waitedSeconds: Math.round((now() - started) / 1000) };
  }

  async function verifyTyped(tabId, j) {
    const probes = (j.probes || []).map(fold).filter(Boolean);
    const r = await waitSaved(tabId, (text) => probes.every((p) => text.includes(p)));
    if (r.saved) return { verified: true, waitedSeconds: r.waitedSeconds };
    let missing = probes;
    try {
      const { blocks } = await pageOp(tabId, 'blocks', {}, api);
      const text = fold(blocks.map((b) => b.text).join('\n'));
      missing = (j.probes || []).filter((p) => !text.includes(fold(p)));
    } catch {
      // report every probe as missing
    }
    return { verified: false, waitedSeconds: r.waitedSeconds, missing };
  }

  /** Absolute plan position from a chunk's relative one. */
  const absolute = (base, at) => (at ? { ...at, block: at.block + base } : null);

  async function chunk(j) {
    return pool.withDoc(
      j.docId,
      j.account,
      async (tabId, entry, state) => {
        if (!state.editable) throw new OpError('read_only', `the document is not editable (${state.reason || state.mode || 'view only'})`);
        if (state.title) j.title = state.title;
        const age = now() - entry.openedAt;
        const budgetMs = Math.max(MIN_CHUNK_MS, Math.min(chunkMs, TYPING_TAB_AGE_MS - age));
        const sameTab = j.tabId === tabId && j.uses !== null && entry.uses === j.uses + 1;
        if (j.tabId !== tabId) j.tabsUsed++;
        const first = j.next === 'start';
        const base = first ? 0 : j.next.block;
        const args = {
          job: j.id,
          blocks: j.plan.blocks.slice(base),
          text: j.text,
          budgetMs,
          ...(first
            ? { position: j.position }
            : {
                at: { ...j.next, block: 0 },
                state: j.state,
                ...(sameTab ? {} : { resume: j.byEnd ? { byEnd: true } : { tail: j.tail } }),
              }),
        };
        if (!first && !sameTab && !j.byEnd && !j.tail) {
          throw new OpError('resume_lost', 'typing stopped at a point it cannot find again in a new tab');
        }
        j.tabId = tabId;
        let r;
        try {
          r = await pageOp(tabId, 'type', args, api);
        } catch (err) {
          const t = err.typing;
          if (t) {
            // Resume exactly where the page got to if that spot can be found
            // again; otherwise from its last safe point.
            const at = t.reached?.tail || j.byEnd ? t.reached : t.at;
            if (at) {
              j.next = absolute(base, at);
              j.tail = at.tail || null;
              if (t.state) j.state = t.state;
            } else if (t.chars) {
              // Typed something, but from no point that can be found again.
              j.lost = true;
            }
            j.charsTyped += t.chars || 0;
          } else if (HUNG.has(err.code) && first) {
            // How much of the start was typed is unknown.
            j.lost = true;
          }
          j.uses = null;
          throw err;
        }
        j.chunks++;
        j.charsTyped += r.chars || 0;
        j.state = r.state || j.state;
        j.tail = r.tail || null;
        j.uses = entry.uses;
        j.next = r.done ? null : absolute(base, r.at);
        if (r.done) {
          j.verification = await verifyTyped(tabId, j);
        } else if (now() - entry.openedAt >= TAB_MAX_AGE_MS - 5_000) {
          // This tab is about to be replaced: let Drive catch up first so the
          // next tab sees everything typed here.
          const recent = fold(String(r.at?.para || '').slice(-40));
          if (recent) await waitSaved(tabId, (text) => text.includes(recent));
        }
        return r;
      },
      'typing'
    );
  }

  async function run(j) {
    j.status = 'running';
    j.startedAt = j.startedAt || now();
    j.error = null;
    delete j.stopRequested;
    updateKeepAlive();
    await persist();
    try {
      for (;;) {
        if (j.stopRequested) {
          j.status = j.stopRequested;
          break;
        }
        try {
          await chunk(j);
        } catch (err) {
          const resumable = !j.lost && (j.next === 'start' || (j.next && (j.byEnd || j.tail)));
          if (RETRYABLE.has(err.code) && j.retries < MAX_RETRIES && resumable && !j.stopRequested) {
            j.retries++;
            log(`typing job ${j.id}: retrying after ${err.code}: ${err.message}`);
            await sleep(retryDelayMs);
            continue;
          }
          throw err;
        }
        await persist();
        if (!j.next) {
          j.status = 'done';
          break;
        }
      }
    } catch (err) {
      const hung = HUNG.has(err.code);
      j.status = !j.lost && j.next && (j.byEnd || j.tail || j.next === 'start') ? 'interrupted' : 'failed';
      j.error = `${err.code ? `${err.code}: ` : ''}${err.message}${
        j.lost
          ? ' — part of the text was typed but the job cannot tell exactly how much; read the document and type the rest with a new docs_type'
          : hung
            ? ' — the last few words typed before the tab stopped may be typed again on resume; read the document first'
            : ''
      }`;
      log(`typing job ${j.id} ${j.status}: ${j.error}`);
    } finally {
      if (FINISHED.has(j.status)) j.finishedAt = now();
      updateKeepAlive();
      await persist();
    }
    return summary(j);
  }

  /** Ask the page to stop at its next safe point. */
  async function signalStop(j) {
    if (!j.tabId) return;
    try {
      await api.scripting.executeScript({
        target: { tabId: j.tabId },
        world: 'MAIN',
        func: (id) => {
          globalThis.__docsBridgeStop = { ...(globalThis.__docsBridgeStop || {}), [id]: true };
          return true;
        },
        args: [j.id],
      });
    } catch {
      // The tab is gone; the loop sees stopRequested before its next chunk.
    }
  }

  function find(id) {
    if (id) {
      const j = jobs.get(id);
      if (!j) throw new OpError('no_job', `no typing job ${id}`);
      return j;
    }
    const latest = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!latest) throw new OpError('no_job', 'there are no typing jobs');
    return latest;
  }

  return {
    jobs,

    /** Start a job; returns at once with its summary (the job runs on). */
    async start({ id, account, position, plan, probes, byEnd, settings, text }) {
      await load();
      const busy = [...jobs.values()].find((j) => j.status === 'running' && j.docId === id && (j.account ?? null) === (account ?? null));
      if (busy) throw new OpError('busy', `typing job ${busy.id} is already typing into this document; pause or cancel it first`);
      const t = now();
      const j = {
        id: newId(t),
        docId: id,
        account: account ?? null,
        title: null,
        position,
        plan,
        probes,
        byEnd: !!byEnd,
        settings,
        text: text || '',
        status: 'queued',
        next: 'start',
        state: null,
        tail: null,
        charsTyped: 0,
        chunks: 0,
        tabsUsed: 0,
        retries: 0,
        tabId: null,
        uses: null,
        createdAt: t,
      };
      jobs.set(j.id, j);
      running.set(j.id, run(j));
      return summary(j);
    },

    async status({ job } = {}) {
      await load();
      return summary(find(job));
    },

    async list() {
      await load();
      return { jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(summary) };
    },

    /** pause | resume | cancel */
    async control({ job, action }) {
      await load();
      const j = find(job);
      if (action === 'pause' || action === 'cancel') {
        const target = action === 'pause' ? 'paused' : 'cancelled';
        if (j.status === 'running') {
          j.stopRequested = target;
          await signalStop(j);
          // Wait for the chunk to reach its safe point (a word or two).
          let timer;
          await Promise.race([running.get(j.id), new Promise((r) => (timer = setTimeout(r, 30_000)))]);
          clearTimeout(timer);
        } else if (!FINISHED.has(j.status)) {
          if (action === 'pause' && j.status !== 'queued') throw new OpError('bad_state', `job ${j.id} is ${j.status}, not typing`);
          j.status = target;
          if (target === 'cancelled') j.finishedAt = now();
          await persist();
        } else {
          throw new OpError('bad_state', `job ${j.id} already ${j.status}`);
        }
        return summary(j);
      }
      if (action === 'resume') {
        if (!['paused', 'interrupted'].includes(j.status) || !j.next || j.lost) throw new OpError('bad_state', `job ${j.id} is ${j.status}; only a paused or interrupted job can be resumed`);
        const busy = [...jobs.values()].find((o) => o !== j && o.status === 'running' && o.docId === j.docId);
        if (busy) throw new OpError('busy', `typing job ${busy.id} is typing into this document`);
        if (j.next !== 'start' && !j.byEnd && !j.tail) throw new OpError('resume_lost', 'this job stopped at a point it cannot find again');
        // A resumed job always starts in whatever tab the pool gives it, so
        // it re-finds its place.
        j.uses = null;
        j.retries = 0;
        running.set(j.id, run(j));
        return summary(j);
      }
      throw new OpError('bad_args', `unknown action ${action}`);
    },

    /** For tests: wait until a job settles. */
    settled: (id) => running.get(id),
    load,
  };
}
