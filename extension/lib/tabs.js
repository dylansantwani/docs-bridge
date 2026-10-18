/**
 * Background tabs the bridge edits in, and running page code inside them.
 *
 * Edits never happen in the user's own tabs: each document gets a bridge tab
 * opened in the background (never activated) and gathered into a collapsed
 * "Docs Bridge" tab group. Two lifetimes matter:
 *
 *   - MAX_AGE: after five minutes hidden, Chrome throttles a page's timers to
 *     one wake-up a minute, and Docs' own search and save machinery runs on
 *     timers. Observed live: a tab hidden for longer stopped answering Find.
 *     So a bridge tab is only reused while younger than four minutes and is
 *     replaced with a fresh one after that.
 *   - IDLE: a tab nobody has used for 90s is closed — unless its last write
 *     was not yet confirmed saved, in which case it is kept (up to DIRTY_MAX)
 *     so Docs can finish syncing instead of losing the edit.
 */

import { docsPageOp } from '../page/docs-page.js';
import { slidesPageOp } from '../page/slides-page.js';
import { editUrl, slidesEditUrl } from './refs.js';

export const TAB_MAX_AGE_MS = 4 * 60_000;
export const TAB_IDLE_MS = 90_000;
export const TAB_DIRTY_MAX_MS = 10 * 60_000;

/*
 * Nothing that waits on a tab may wait forever. A page op awaits Docs, and a
 * tab Chrome froze, hung, or left mid-navigation never answers — observed
 * live: one such call held a document's queue, so every later edit to that
 * document hung while reads (which never touch a tab) still worked. So a
 * running page op is watched: every HEARTBEAT_MS a tiny probe asks the page
 * what it is doing. No answer within PROBE_TIMEOUT_MS means the page is hung;
 * no progress for STALL_MS means the op is stuck. Either fails the call with
 * what it was doing, and the caller replaces the tab.
 */
export const HEARTBEAT_MS = 15_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const STALL_MS = 60_000;
export const RUN_MAX_MS = 280_000;
const GROUP_TITLE = 'Docs Bridge';

export class OpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reject with onTimeout() if the promise has not settled within ms. */
export function withTimeout(promise, ms, onTimeout) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** Self-contained: what the page op running in this tab last reported. */
function readProgress() {
  const p = globalThis.__docsBridgeProgress;
  return p ? { label: String(p.label || ''), at: Number(p.at) || 0, beat: Number(p.beat) || 0 } : { label: '', at: 0, beat: 0 };
}

const TIMING = { heartbeatMs: HEARTBEAT_MS, probeTimeoutMs: PROBE_TIMEOUT_MS, stallMs: STALL_MS, maxMs: RUN_MAX_MS };

/** Tune the watchdog (tests use short intervals). */
export function setTiming(t) {
  Object.assign(TIMING, t);
}

function injectError(err) {
  // Chrome refuses to inject into hosts outside our permissions; a Google
  // tab that ends up on accounts.google.com has been bounced to sign-in.
  if (/accounts\.google\.com/.test(err.message)) {
    return new OpError('signed_out', 'Chrome is not signed in to Google for that account (the page redirected to sign-in).');
  }
  return new OpError('tab_error', `could not run code in the Docs tab: ${err.message}`);
}

/**
 * Watch a running page op until it settles; reject if the page stops
 * answering or stops making progress.
 */
function watchdog(tabId, api, done) {
  let timer;
  let stopped = false;
  const started = Date.now();
  let last = null; // {label, beat}
  let lastChange = started;
  const watching = new Promise((_, reject) => {
    const tick = async () => {
      if (stopped) return;
      const elapsed = Date.now() - started;
      if (elapsed >= TIMING.maxMs) {
        reject(new OpError('tab_stalled', `the Docs tab was still busy after ${Math.round(elapsed / 1000)}s${last?.label ? ` (at: ${last.label})` : ''}`));
        return;
      }
      let p;
      try {
        const r = await withTimeout(api.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readProgress }), TIMING.probeTimeoutMs, () => new OpError('tab_unresponsive', ''));
        p = r?.[0]?.result || { label: '', at: 0, beat: 0 };
      } catch (err) {
        if (stopped) return;
        if (err instanceof OpError && err.code === 'tab_unresponsive') {
          reject(
            new OpError(
              'tab_unresponsive',
              `the Docs tab stopped responding${last?.label ? ` (at: ${last.label})` : ''}: its page did not answer a ${Math.round(TIMING.probeTimeoutMs / 1000)}s check, so Chrome has frozen or hung it`
            )
          );
          return;
        }
        // The probe itself could not run (tab navigating or closed); the op's
        // own promise reports that.
        timer = setTimeout(tick, TIMING.heartbeatMs);
        return;
      }
      if (stopped) return;
      if (!last || p.label !== last.label || p.beat !== last.beat) {
        last = p;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= TIMING.stallMs) {
        reject(new OpError('tab_stalled', `the Docs tab made no progress for ${Math.round((Date.now() - lastChange) / 1000)}s${p.label ? ` (stuck at: ${p.label})` : ''}`));
        return;
      }
      timer = setTimeout(tick, TIMING.heartbeatMs);
    };
    timer = setTimeout(tick, TIMING.heartbeatMs);
  });
  done.finally(() => {
    stopped = true;
    clearTimeout(timer);
  }).catch(() => {});
  return watching;
}

/**
 * Run a self-contained function in a tab's main world and return its value,
 * under a watchdog (see HEARTBEAT_MS): a hung or stalled page rejects with
 * tab_unresponsive / tab_stalled instead of waiting forever.
 */
export async function runInTab(tabId, func, args = [], api = chrome) {
  const running = api.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  let results;
  try {
    results = await Promise.race([running, watchdog(tabId, api, running)]);
  } catch (err) {
    if (err instanceof OpError) throw err;
    throw injectError(err);
  }
  const value = results?.[0]?.result;
  if (value === undefined || value === null) {
    throw new OpError('tab_error', 'the Docs tab returned nothing (it may have navigated away or crashed)');
  }
  return value;
}

/** A tab that cannot be trusted to finish work any more. */
export const isWedged = (err) => err instanceof OpError && (err.code === 'tab_unresponsive' || err.code === 'tab_stalled');

function unwrap(r, what) {
  if (!r.ok) {
    const err = new OpError(r.code || 'page_error', r.message || `the ${what} tab reported an error`);
    if (r.completed) err.completed = r.completed;
    if (r.typing) err.typing = r.typing;
    throw err;
  }
  return r;
}

/** Run a docsPageOp and unwrap its {ok, code, message} envelope. */
export async function pageOp(tabId, op, args = {}, api = chrome) {
  return unwrap(await runInTab(tabId, docsPageOp, [op, args], api), 'Docs');
}

/** Run a slidesPageOp (a Google Slides editor tab) and unwrap its envelope. */
export async function slidesOp(tabId, op, args = {}, api = chrome) {
  return unwrap(await runInTab(tabId, slidesPageOp, [op, args], api), 'Slides');
}

/** The editor a document id opens in: 'document' (Docs) or 'presentation' (Slides). */
const KINDS = {
  document: { url: editUrl, op: pageOp, noun: 'document', app: 'Docs' },
  presentation: { url: slidesEditUrl, op: slidesOp, noun: 'presentation', app: 'Slides' },
};

function accountLabel(account) {
  return account === null || account === undefined ? 'the default Google account' : `account ${account}`;
}

export class TabPool {
  constructor({ api = chrome, now = () => Date.now(), log = () => {} } = {}) {
    this.api = api;
    this.now = now;
    this.log = log;
    /** key → {tabId, docId, account, openedAt, lastUsed, busy, dirtySince, queue} */
    this.entries = new Map();
    this.groups = new Map(); // windowId → groupId
  }

  key(docId, account) {
    return `${docId}|${account ?? ''}`;
  }

  count() {
    return this.entries.size;
  }

  /**
   * Run fn(tabId, entry) against a fresh, ready editor tab for this document,
   * serialised with any other work on the same document. `kind` picks the
   * editor: 'document' (Docs) or 'presentation' (Slides).
   */
  withDoc(docId, account, fn, op = 'op', kind = 'document') {
    const key = this.key(docId, account);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { tabId: null, docId, account, kind, openedAt: 0, lastUsed: this.now(), busy: 0, dirtySince: null, uses: 0, queue: Promise.resolve() };
      this.entries.set(key, entry);
    }
    const run = async () => {
      if (entry.abandoned) throw new OpError('abandoned', 'an earlier call on this document was abandoned; retry');
      entry.busy++;
      // Counts calls, so a typing job can tell whether anything else moved
      // the caret in this tab since its last chunk.
      entry.uses = (entry.uses || 0) + 1;
      entry.activity = { what: op, since: this.now() };
      try {
        const state = await this._ensure(entry);
        return await fn(entry.tabId, entry, state);
      } catch (err) {
        // A hung or stuck tab would fail every later call too: replace it.
        if (isWedged(err) && entry.tabId) {
          this.log(`replacing wedged bridge tab for ${docId}: ${err.message}`);
          await this._close(entry.tabId);
          entry.tabId = null;
          entry.openedAt = 0;
          err.message += '. The stuck tab was closed; the next call opens a fresh one. Read the document before retrying: earlier steps may have applied.';
        }
        throw err;
      } finally {
        entry.busy--;
        entry.activity = null;
        entry.lastUsed = this.now();
      }
    };
    const result = entry.queue.then(run, run);
    entry.queue = result.catch(() => {});
    return result;
  }

  /**
   * Give up on a document whose call ran past its deadline: close its tab (so
   * nothing more is typed into it) and drop its queue, so the next call starts
   * clean instead of waiting behind the stuck one.
   */
  async abandon(docId, account) {
    const key = this.key(docId, account);
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.abandoned = true;
    this.entries.delete(key);
    if (entry.tabId) await this._close(entry.tabId);
    this.log(`abandoned the stuck call on ${docId}${entry.activity ? ` (${entry.activity.what})` : ''}`);
    return true;
  }

  /** What each bridge tab is doing, for docs_status. */
  describe() {
    const now = this.now();
    return [...this.entries.values()].map((e) => ({
      doc: e.docId,
      ...(e.kind === 'presentation' ? { kind: 'presentation' } : {}),
      account: e.account ?? null,
      busy: e.busy > 0,
      ...(e.activity ? { doing: e.activity.what, forSeconds: Math.round((now - e.activity.since) / 1000) } : {}),
      tabAgeSeconds: e.openedAt ? Math.round((now - e.openedAt) / 1000) : null,
    }));
  }

  /**
   * Replace this entry's tab with a fresh one and wait for the editor. Used
   * when Docs' UI in the old tab has wedged; only call from inside withDoc.
   */
  async refresh(entry) {
    if (entry.tabId) await this._close(entry.tabId);
    entry.tabId = null;
    entry.openedAt = 0;
    return this._ensure(entry);
  }

  /** Register a tab opened elsewhere (docs_create) under its new document id. */
  adopt(docId, account, tabId, openedAt, kind = 'document') {
    this.entries.set(this.key(docId, account), {
      tabId,
      docId,
      account,
      kind,
      openedAt,
      lastUsed: this.now(),
      busy: 0,
      dirtySince: null,
      uses: 0,
      queue: Promise.resolve(),
    });
  }

  async _alive(tabId) {
    if (!tabId) return null;
    try {
      return await this.api.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async _ensure(entry) {
    const tab = await this._alive(entry.tabId);
    // A discarded tab reloads from scratch and a frozen one runs nothing.
    const fresh = tab && !tab.discarded && !tab.frozen && this.now() - entry.openedAt < TAB_MAX_AGE_MS;
    const onDoc = tab && (tab.url || tab.pendingUrl || '').includes(`/d/${entry.docId}`);
    const kind = entry.kind || 'document';
    if (fresh && onDoc) {
      return this.waitForEditor(entry.tabId, { docId: entry.docId, account: entry.account, kind });
    }
    if (tab) await this._close(entry.tabId);
    entry.tabId = await this.openBackground(KINDS[kind].url(entry.docId, entry.account));
    entry.openedAt = this.now();
    if (entry.abandoned) {
      await this._close(entry.tabId);
      throw new OpError('abandoned', 'this call was abandoned after its deadline');
    }
    entry.dirtySince = null;
    return this.waitForEditor(entry.tabId, { docId: entry.docId, account: entry.account, kind });
  }

  async _targetWindow() {
    try {
      const w = await this.api.windows.getLastFocused({ windowTypes: ['normal'] });
      if (w?.id !== undefined && !w.incognito) return w.id;
    } catch {
      // fall through
    }
    const all = await this.api.windows.getAll({ windowTypes: ['normal'] });
    const w = all.find((x) => !x.incognito);
    if (w) return w.id;
    const created = await this.api.windows.create({ focused: false, state: 'minimized' });
    return created.id;
  }

  /** Open a tab without activating it and file it under the collapsed group. */
  async openBackground(url) {
    const windowId = await this._targetWindow();
    const tab = await this.api.tabs.create({ url, active: false, windowId });
    // Memory Saver must not discard a tab mid-edit.
    Promise.resolve(this.api.tabs.update?.(tab.id, { autoDiscardable: false })).catch(() => {});
    this._group(tab.id, windowId).catch(() => {});
    return tab.id;
  }

  async _group(tabId, windowId) {
    if (!this.api.tabGroups) return;
    let groupId = this.groups.get(windowId);
    if (groupId !== undefined) {
      try {
        await this.api.tabGroups.get(groupId);
      } catch {
        groupId = undefined;
      }
    }
    if (groupId === undefined) {
      groupId = await this.api.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      this.groups.set(windowId, groupId);
      await this.api.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue', collapsed: true });
    } else {
      await this.api.tabs.group({ tabIds: [tabId], groupId });
    }
  }

  /**
   * Poll the tab until the Docs editor is up, turning the ways that can fail
   * (signed out, no access, missing document) into specific errors.
   */
  async waitForEditor(tabId, { docId, account, kind = 'document', timeout = 45_000 } = {}) {
    const { op: stateOp, noun, app } = KINDS[kind] || KINDS.document;
    const deadline = this.now() + timeout;
    let last = null;
    while (this.now() < deadline) {
      const tab = await this._alive(tabId);
      if (!tab) throw new OpError('tab_closed', 'the bridge tab was closed while loading');
      const url = tab.url || tab.pendingUrl || '';
      if (/^https:\/\/accounts\.google\.com\//.test(url)) {
        throw new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}. Sign in in this Chrome profile, or pass another account.`);
      }
      if (tab.status === 'complete' || url.startsWith('https://docs.google.com/')) {
        try {
          last = await stateOp(tabId, 'state', {}, this.api);
          if (last.ready) return last;
          if (last.signedOut) throw new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
          if (last.accessDenied) {
            throw new OpError('no_access', `${accountLabel(account)} has no access to ${noun} ${docId}. If another signed-in account owns it, pass account.`);
          }
          if (last.notFound) throw new OpError('not_found', `${noun} ${docId} does not exist (or ${accountLabel(account)} cannot see it)`);
        } catch (err) {
          if (err instanceof OpError && err.code !== 'tab_error') throw err;
          // Page still loading or mid-navigation; keep polling.
        }
      }
      await sleep(400);
    }
    throw new OpError('timeout', `the ${app} editor did not finish loading within ${Math.round(timeout / 1000)}s${last ? ` (last state: ${JSON.stringify(last).slice(0, 200)})` : ''}`);
  }

  /** Open a throwaway background tab, run fn(tabId), always close it. */
  async transient(url, fn) {
    const tabId = await this.openBackground(url);
    try {
      return await fn(tabId);
    } finally {
      await this._close(tabId);
    }
  }

  async _close(tabId) {
    try {
      await this.api.tabs.remove(tabId);
    } catch {
      // already gone
    }
  }

  /** Close idle tabs. Called from an alarm. */
  async sweep() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.busy) continue;
      const idle = now - entry.lastUsed;
      if (entry.dirtySince && now - entry.dirtySince < TAB_DIRTY_MAX_MS) continue;
      if (idle < TAB_IDLE_MS) continue;
      if (entry.tabId) await this._close(entry.tabId);
      this.entries.delete(key);
      this.log(`closed idle bridge tab for ${entry.docId}`);
    }
  }

  /** Forget entries whose tab the user closed. */
  forgetTab(tabId) {
    for (const [key, entry] of this.entries) {
      if (entry.tabId === tabId && !entry.busy) this.entries.delete(key);
    }
  }
}
