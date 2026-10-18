/**
 * Just enough of the chrome.* API for TabPool and createOps, with page code
 * replaced by per-op handlers. executeScript dispatches on the injected
 * function: docsPageOp calls go to `page[op]`, slidesPageOp calls to
 * `slides[op]`, listDocsPage to `list`.
 */

import { docsPageOp } from '../../extension/page/docs-page.js';
import { slidesPageOp } from '../../extension/page/slides-page.js';
import { listDocsPage } from '../../extension/page/list-page.js';

/**
 * `progress(tab)` answers the watchdog's probe (tabs.js readProgress): return
 * {label, beat}, or a never-settling promise to model a hung page.
 */
export function fakeChrome({ page = {}, slides = {}, list = null, tabUrl = (url) => url, progress = null, other = null } = {}) {
  const tabs = new Map();
  let nextId = 100;
  async function runScript(tab, target, func, args) {
    if (func === docsPageOp) {
      const [op, a] = args;
      api.scripts.push({ tabId: target.tabId, op, args: a });
      const handler = page[op];
      if (!handler) return [{ result: { ok: false, code: 'bad_args', message: `unhandled op ${op}` } }];
      return [{ result: await handler(a, tab) }];
    }
    if (func === slidesPageOp) {
      const [op, a] = args;
      api.scripts.push({ tabId: target.tabId, op: `slides:${op}`, args: a });
      const handler = slides[op];
      if (!handler) return [{ result: { ok: false, code: 'bad_args', message: `unhandled slides op ${op}` } }];
      return [{ result: await handler(a, tab) }];
    }
    if (func === listDocsPage) {
      api.scripts.push({ tabId: target.tabId, op: 'list', args });
      return [{ result: await list(args[0], tab) }];
    }
    if (other) return [{ result: await other(func, args, tab) }];
    throw new Error('unexpected injected function');
  }
  const api = {
    created: [],
    removed: [],
    grouped: [],
    groupUpdates: [],
    scripts: [],
    updated: [],
    _pendingByTab: new Map(),
    tabs: {
      async create({ url, active, windowId }) {
        const tab = { id: nextId++, url: tabUrl(url), active, windowId, status: 'complete' };
        tabs.set(tab.id, tab);
        api.created.push({ ...tab, requestedUrl: url });
        return tab;
      },
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return tab;
      },
      async remove(id) {
        tabs.delete(id);
        api.removed.push(id);
        // Chrome rejects a pending executeScript when its tab closes.
        for (const reject of api._pendingByTab.get(id) || []) reject(new Error('The tab was closed.'));
        api._pendingByTab.delete(id);
      },
      async update(id, props) {
        api.updated.push({ id, props });
        return tabs.get(id);
      },
      async group({ tabIds, groupId }) {
        api.grouped.push({ tabIds, groupId });
        return groupId ?? 7;
      },
    },
    tabGroups: {
      async get(id) {
        return { id };
      },
      async update(id, props) {
        api.groupUpdates.push({ id, props });
      },
    },
    windows: {
      async getLastFocused() {
        return { id: 1, incognito: false };
      },
      async getAll() {
        return [{ id: 1, incognito: false }];
      },
      async create() {
        return { id: 2 };
      },
      async update() {},
    },
    scripting: {
      async executeScript({ target, func, args }) {
        const tab = tabs.get(target.tabId);
        if (!tab) throw new Error('No tab');
        if (func.name === 'readProgress') {
          if (!progress) throw new Error('unexpected injected function');
          return [{ result: await progress(tab) }];
        }
        // Let tab removal reject work still running in that tab, as Chrome does.
        let rejectOnClose;
        const closed = new Promise((_, reject) => (rejectOnClose = reject));
        const list_ = api._pendingByTab.get(target.tabId) || [];
        list_.push(rejectOnClose);
        api._pendingByTab.set(target.tabId, list_);
        return Promise.race([closed, runScript(tab, target, func, args)]);
      },
    },
    /** Test hook: mutate a tab (e.g. simulate a redirect). */
    _tab(id) {
      return tabs.get(id);
    },
    _tabs: tabs,
  };
  return api;
}

export const readyState = (extra = {}) => ({ ok: true, ready: true, editable: true, mode: 'Editing', title: 'Scratch', ...extra });

export function blocksOf(...texts) {
  return { ok: true, blocks: texts.map((text) => ({ tag: 'p', text, inTable: false })) };
}
