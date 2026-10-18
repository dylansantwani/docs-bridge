/**
 * The operations the MCP server can ask the extension for.
 *
 * Reads go straight to Docs' export endpoint from the service worker: the
 * extension's host permissions make Chrome attach the user's Google cookies
 * and let the request follow the redirect to googleusercontent.com, which a
 * page on docs.google.com cannot (that redirect fails CORS — observed live).
 * Writes run page code in a bridge tab (tabs.js / docs-page.js) and are then
 * verified against the saved document.
 */

import { exportUrl, editUrl, createUrl, searchUrl, recentUrl, copyUrl, galleryUrl, classifyLanding, EXPORT_FORMATS } from './refs.js';
import { OpError, TabPool, pageOp, runInTab, sleep, withTimeout } from './tabs.js';
import { listDocsPage, makeCopyPage, listTemplatesPage } from '../page/list-page.js';
import { createTypingJobs } from './typer.js';
import { createSlidesOps } from './slides-ops.js';

const VERIFY_TIMEOUT_MS = 20_000;
const VERIFY_INTERVAL_MS = 900;

export const norm = (s) =>
  String(s ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function accountLabel(account) {
  return account === null || account === undefined ? 'the default Google account' : `account ${account}`;
}

function landingError(kind, id, account) {
  switch (kind) {
    case 'signed_out':
      return new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
    case 'no_access':
      return new OpError('no_access', `${accountLabel(account)} cannot open document ${id}. If another signed-in account owns it, pass account (e.g. 1 or an email).`);
    case 'not_found':
      return new OpError('not_found', `document ${id} was not found for ${accountLabel(account)} (wrong id, deleted, or owned by another account).`);
    case 'rate_limited':
      return new OpError('rate_limited', 'Google is rate-limiting exports; wait a minute and retry.');
    default:
      return new OpError('http_error', `Google returned an error exporting ${id} (${kind}).`);
  }
}

/** Title from Content-Disposition: attachment; filename="x.md"; filename*=UTF-8''x.md */
export function titleFromDisposition(header) {
  if (!header) return null;
  let name = null;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = star[1].trim();
    }
  } else {
    const plain = header.match(/filename\s*=\s*"([^"]*)"/) || header.match(/filename\s*=\s*([^;]+)/);
    if (plain) name = plain[1].trim();
  }
  return name ? name.replace(/\.[a-z0-9]{2,5}$/i, '') : null;
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** Minimal markdown from saved blocks, for when the export endpoint is unavailable. */
export function blocksToMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    const text = b.text.replace(/\s+$/g, '');
    if (b.inTable) out.push(`| ${norm(text)} |`);
    else if (/^h[1-6]$/.test(b.tag)) out.push(`${'#'.repeat(Number(b.tag[1]))} ${norm(text)}`);
    else if (b.tag === 'li') out.push(`- ${norm(text)}`);
    else out.push(text);
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function countOccurrences(haystack, needle, matchCase) {
  if (!needle) return 0;
  const h = matchCase ? haystack : haystack.toLowerCase();
  const n = matchCase ? needle : needle.toLowerCase();
  let count = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) count++;
  return count;
}

/** Docs palette names → hex, for verifying colours picked by name. Unlisted names are applied but not verified. */
export const PALETTE = {
  black: '#000000', 'dark gray 4': '#434343', 'dark gray 3': '#666666', 'dark gray 2': '#999999', 'dark gray 1': '#b7b7b7',
  gray: '#cccccc', 'light gray 1': '#d9d9d9', 'light gray 2': '#efefef', 'light gray 3': '#f3f3f3', white: '#ffffff',
  'red berry': '#980000', red: '#ff0000', orange: '#ff9900', yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff',
  'cornflower blue': '#4a86e8', blue: '#0000ff', purple: '#9900ff', magenta: '#ff00ff',
};

const hexOf = (c) => {
  if (!c) return null;
  const v = String(c).trim().toLowerCase();
  if (/^#?[0-9a-f]{6}$/.test(v)) return v.startsWith('#') ? v : `#${v}`;
  return PALETTE[v] || null;
};

/** The runs of the first block containing `text` that overlap it, plus the block. */
export function locate(blocks, text) {
  const want = norm(text);
  for (const b of blocks) {
    const full = b.runs?.length ? b.runs.map((r) => r.text).join('') : b.text;
    let i = full.indexOf(text);
    if (i === -1) i = full.toLowerCase().indexOf(String(text).toLowerCase());
    if (i === -1 && norm(full).includes(want)) i = 0;
    if (i === -1) continue;
    const end = i + String(text).length;
    const runs = [];
    let pos = 0;
    for (const r of b.runs || []) {
      const next = pos + r.text.length;
      if (next > i && pos < end && r.text.trim()) runs.push(r);
      pos = next;
    }
    return { block: b, runs };
  }
  return null;
}

/**
 * Which of the requested formats the saved document does not show yet for
 * `text`. Styles in `blocks` are effective (paragraph style merged into run).
 */
export function unmetFormats(blocks, text, f) {
  const hit = locate(blocks, text);
  if (!hit) return [`text ${JSON.stringify(text)} not found`];
  const { block, runs } = hit;
  const unmet = [];
  const all = (pred) => runs.length > 0 && runs.every((r) => pred(r.style || {}, r));
  const check = (name, ok) => {
    if (!ok) unmet.push(name);
  };
  if ('bold' in f) check('bold', all((s) => (Number(s['font-weight']) >= 700) === !!f.bold));
  if ('italic' in f) check('italic', all((s) => (s['font-style'] === 'italic') === !!f.italic));
  if ('underline' in f) check('underline', all((s) => /underline/.test(s['text-decoration'] || '') === !!f.underline));
  if ('strikethrough' in f) check('strikethrough', all((s) => /line-through/.test(s['text-decoration'] || '') === !!f.strikethrough));
  if (f.size !== undefined) check('size', all((s) => parseFloat(s['font-size']) === Number(f.size)));
  if (f.font) check('font', all((s) => String(s['font-family'] || '').toLowerCase().includes(String(f.font).toLowerCase())));
  if (f.color && hexOf(f.color)) check('color', all((s) => String(s.color || '').toLowerCase() === hexOf(f.color)));
  if (f.highlight && hexOf(f.highlight)) check('highlight', all((s) => String(s['background-color'] || '').toLowerCase() === hexOf(f.highlight)));
  if (f.link !== undefined) check('link', all((s, r) => (f.link ? String(r.href || '').replace(/\/$/, '') === String(f.link).replace(/\/$/, '') : !r.href)));
  if (f.style) {
    const st = String(f.style).toLowerCase().replace(/[\s_-]/g, '');
    const h = st.match(/^(?:heading|h)([1-6])$/);
    const ok = h ? block.tag === `h${h[1]}` : st === 'title' || st === 'subtitle' ? block.cls === st : /^normal(text)?$/.test(st) ? !/^h\d$/.test(block.tag) && !block.cls : true;
    check('style', ok);
  }
  if (f.align) check('align', f.align === 'left' ? !block.align || block.align === 'left' : block.align === f.align);
  if (f.list) {
    const ok = f.list === 'none' ? block.tag !== 'li' : block.tag === 'li' && (f.list === 'numbered' ? block.list?.ordered : !block.list?.ordered);
    check('list', ok);
  }
  return unmet;
}

// Server timeouts (server/tools.js) are passed through with each call; these
// cover an older hub that does not send one.
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEADLINE_MARGIN_MS = 5_000;
const MIN_BUDGET_MS = 10_000;

const MUTATING = new Set(['type', 'inline', 'delete', 'format', 'key', 'menu', 'undo', 'redo']);

export function createOps({
  pool = new TabPool(),
  fetchImpl = (...a) => fetch(...a),
  api = chrome,
  version = '0.0.0',
  now = () => Date.now(),
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  verifyIntervalMs = VERIFY_INTERVAL_MS,
  log = () => {},
  typing = createTypingJobs({ pool, api, now, log }),
  slidesTiming = {},
} = {}) {
  async function savedText(tabId) {
    const { blocks } = await pageOp(tabId, 'blocks', {}, api);
    return { blocks, text: norm(blocks.map((b) => b.text).join(' ')) };
  }

  /** The saved text before an edit; null (probe-only verification) if it cannot be read. */
  const snapshot = (tabId) => savedText(tabId).then((r) => r.text, () => null);

  /**
   * Poll the saved document from the service worker (whose timers are not
   * throttled) until the change shows up. A write only counts as verified
   * when the saved text differs from `before` (so a paste Docs swallowed
   * without applying — as on a view-only document — can never pass), every
   * probe is present, and `check(text)` holds.
   */
  async function verify(tabId, check, { probes = [], before = null } = {}) {
    const started = now();
    let missing = probes;
    let changed = before === null;
    while (now() - started < verifyTimeoutMs) {
      await sleep(verifyIntervalMs);
      try {
        const { text } = await savedText(tabId);
        changed = before === null || text !== before;
        missing = probes.filter((p) => !text.includes(norm(p)));
        if (changed && !missing.length && check(text)) return { verified: true, waitedSeconds: Math.round((now() - started) / 1000) };
      } catch {
        // transient fetch failure; keep polling
      }
    }
    return { verified: false, missing, unchanged: !changed || undefined, waitedSeconds: Math.round((now() - started) / 1000) };
  }

  async function fetchExport(id, format, { account, tab }) {
    let res;
    try {
      res = await fetchImpl(exportUrl(id, format, { account, tab }), { credentials: 'include', redirect: 'follow', cache: 'no-store' });
    } catch (err) {
      throw new OpError('network', `could not reach Google Docs: ${err.message}`);
    }
    const type = res.headers.get('content-type') || '';
    const kind = classifyLanding(res.url, res.status, type);
    if (kind !== 'ok') throw landingError(kind, id, account);
    // An HTML page in answer to a non-HTML export is an interstitial (sign-in,
    // request access, virus-scan warning), not the document.
    if (format !== 'html' && /text\/html/i.test(type)) throw landingError('no_access', id, account);
    return { res, title: titleFromDisposition(res.headers.get('content-disposition')) };
  }

  /**
   * Run a page op that searches first; if Docs' Find wedged (reported before
   * any edit is made), retry once in a fresh tab.
   */
  async function searchingOp(tabId, entry, op, args) {
    try {
      return { tabId, result: await pageOp(tabId, op, args, api) };
    } catch (err) {
      if (err.code !== 'find_stalled') throw err;
      await pool.refresh(entry);
      return { tabId: entry.tabId, result: await pageOp(entry.tabId, op, args, api) };
    }
  }

  /** Full saved state (text and formatting) for change detection. */
  const fullSnapshot = (tabId) => pageOp(tabId, 'blocks', {}, api).then((r) => JSON.stringify(r.blocks), () => null);

  /**
   * Verify an edit: the saved document changed, typed text is present, and
   * every formatting request on a known text shows in the saved runs.
   */
  async function verifyEdit(tabId, before, expect) {
    const started = now();
    let last = { missing: expect.probes || [], unmet: [] };
    while (now() - started < verifyTimeoutMs) {
      await sleep(verifyIntervalMs);
      try {
        const { blocks } = await pageOp(tabId, 'blocks', {}, api);
        const text = norm(blocks.map((b) => b.text).join(' '));
        const changed = before === null || JSON.stringify(blocks) !== before;
        const missing = (expect.probes || []).filter((p) => !text.includes(norm(p)));
        const unmet = (expect.formats || []).flatMap(({ text: t, format }) => unmetFormats(blocks, t, format).map((u) => `${u} on ${JSON.stringify(t)}`));
        last = { missing, unmet, unchanged: !changed };
        if (changed && !missing.length && !unmet.length) return { verified: true, waitedSeconds: Math.round((now() - started) / 1000) };
      } catch {
        // keep polling
      }
    }
    return {
      verified: false,
      waitedSeconds: Math.round((now() - started) / 1000),
      ...(last.unchanged ? { unchanged: true } : {}),
      ...(last.missing.length ? { missing: last.missing } : {}),
      ...(last.unmet.length ? { unmet: last.unmet } : {}),
    };
  }

  /** Wait for a tab to land on a document editor URL; returns the new id. */
  async function waitForNewDoc(tabId, excludeId, account) {
    for (let i = 0; i < 160; i++) {
      const tab = await api.tabs.get(tabId);
      const url = tab.url || tab.pendingUrl || '';
      if (/^https:\/\/accounts\.google\.com\//.test(url)) throw new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
      const id = url.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{25,})\/(?:edit|$)/)?.[1];
      if (id && id !== excludeId) return id;
      await sleep(250);
    }
    return null;
  }

  function docInfo(state, id, account) {
    return { title: state?.title || null, url: editUrl(id, account) };
  }

  /** List files on a Drive search page or a Docs/Slides home page, in a throwaway tab. */
  async function listAt(url, limit, account) {
    const r = await pool.transient(url, async (tabId) => {
      // Drive and the home pages render their lists asynchronously; the
      // page function waits for them itself. A signed-out account lands on
      // accounts.google.com, where the extension cannot (and should not) run.
      for (let attempt = 0; attempt < 40; attempt++) {
        const tab = await api.tabs.get(tabId);
        if (/^https:\/\/accounts\.google\.com\//.test(tab.url || tab.pendingUrl || '')) {
          throw new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
        }
        if (tab.status === 'complete') break;
        await sleep(250);
      }
      // Drive may redirect (e.g. /drive/search → /drive/u/0/search) after
      // the load completes, taking the injected frame with it; run again
      // on the page it lands on.
      for (let attempt = 1; ; attempt++) {
        try {
          return await runInTab(tabId, listDocsPage, [limit], api);
        } catch (err) {
          if (attempt >= 3 || err.code !== 'tab_error') throw err;
          await sleep(750);
          for (let i = 0; i < 40; i++) {
            const tab = await api.tabs.get(tabId);
            if (tab.status === 'complete') break;
            await sleep(250);
          }
        }
      }
    });
    if (!r.ok) throw new OpError(r.code || 'list_failed', r.message || 'listing failed');
    return { items: r.items, source: r.source };
  }

  const slides = createSlidesOps({ pool, api, fetchImpl, now, log, helpers: { accountLabel, titleFromDisposition, toBase64, listAt }, ...slidesTiming });

  const ops = {
    ...slides,

    async status() {
      return { version, managedTabs: pool.count(), tabs: pool.describe(), userAgent: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || null };
    },

    async read({ id, tab, account, format = 'markdown' }) {
      if (!EXPORT_FORMATS[format]?.text) throw new OpError('bad_args', `read supports markdown, text or html; use export for ${format}`);
      try {
        const { res, title } = await fetchExport(id, format, { account, tab });
        return { content: await res.text(), title, via: 'export' };
      } catch (err) {
        // Only fall back when the export path itself looks broken; a real
        // "no access" would fail the same way in the editor.
        if (!['signed_out', 'network', 'http_error'].includes(err.code)) throw err;
        const r = await pool.withDoc(id, account, async (tabId, entry, state) => {
          const { blocks } = await pageOp(tabId, 'blocks', {}, api);
          return { blocks, title: state.title };
        }, 'read (editor fallback)');
        const content = format === 'markdown' ? blocksToMarkdown(r.blocks) : r.blocks.map((b) => b.text).join('\n');
        return { content, title: r.title, via: `editor (export failed: ${err.message})` };
      }
    },

    async export({ id, tab, account, format }) {
      if (!EXPORT_FORMATS[format]) throw new OpError('bad_args', `unknown format ${format}`);
      const { res, title } = await fetchExport(id, format, { account, tab });
      return { base64: toBase64(await res.arrayBuffer()), title, mime: EXPORT_FORMATS[format].mime };
    },

    async list({ query = '', limit = 20, account }) {
      return listAt(query ? searchUrl(query, account) : recentUrl(account), limit, account);
    },

    async write({ id, account, mode, content, anchor, occurrence = 1, matchCase = false, asBlock = false }) {
      return pool.withDoc(id, account, async (firstTab, entry, state) => {
        let tabId = firstTab;
        if (!state.editable) throw new OpError('read_only', `document is not editable by ${accountLabel(account)} (${state.reason || state.mode || 'view only'})`);
        const deleting = mode === 'replace_text' && !content;
        const before = await snapshot(tabId);
        const { tabId: used, result: r } = await searchingOp(tabId, entry, 'write', { mode, content, anchor, occurrence, matchCase, asBlock });
        tabId = used;
        const occurrencesBefore = deleting ? countOccurrences(before ?? '', norm(anchor), matchCase) : 0;
        const verification = deleting
          ? await verify(tabId, (text) => countOccurrences(text, norm(anchor), matchCase) < occurrencesBefore, { before })
          : await verify(tabId, () => true, { probes: content.probes || [], before });
        entry.dirtySince = verification.verified ? null : now();
        return { ...docInfo(state, id, account), anchorMatches: r.anchorMatches ?? null, verification };
      }, 'write');
    },

    async replace({ id, account, find, replace, matchCase = false, regex = false }) {
      return pool.withDoc(id, account, async (firstTab, entry, state) => {
        let tabId = firstTab;
        if (!state.editable) throw new OpError('read_only', `document is not editable by ${accountLabel(account)}`);
        const before = await snapshot(tabId);
        const { tabId: used, result: r } = await searchingOp(tabId, entry, 'replace_all', { find, replace, matchCase, regex });
        tabId = used;
        let verification = null;
        if (r.replaced) {
          const reintroduces = !regex && countOccurrences(replace, find, matchCase) > 0;
          verification =
            regex || reintroduces
              ? await verify(tabId, () => true, { probes: norm(replace) ? [replace] : [], before })
              : await verify(tabId, (text) => countOccurrences(text, norm(find), matchCase) === 0, { before });
          entry.dirtySince = verification.verified ? null : now();
        }
        return { ...docInfo(state, id, account), replaced: r.replaced, verification };
      }, 'find and replace');
    },

    async rename({ id, account, title }) {
      return pool.withDoc(id, account, async (tabId, entry, state) => {
        if (!state.editable) throw new OpError('read_only', `document is not editable by ${accountLabel(account)}`);
        const r = await pageOp(tabId, 'title', { title }, api);
        return { ...docInfo({ title }, id, account), verified: !!r.verified };
      }, 'rename');
    },

    async create({ title, account, content }) {
      const openedAt = now();
      const tabId = await pool.openBackground(createUrl(account));
      let id = null;
      try {
        for (let i = 0; i < 120 && !id; i++) {
          const tab = await api.tabs.get(tabId);
          const url = tab.url || tab.pendingUrl || '';
          if (/^https:\/\/accounts\.google\.com\//.test(url)) throw new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
          id = url.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{25,})/)?.[1] || null;
          if (!id) await sleep(250);
        }
        if (!id) throw new OpError('create_failed', 'Docs did not create a document within 30s (if Google Drive storage is full, new documents cannot be created)');
        await pool.waitForEditor(tabId, { docId: id, account });
      } catch (err) {
        if (!id) await api.tabs.remove(tabId).catch(() => {});
        throw err;
      }
      pool.adopt(id, account, tabId, openedAt);
      return pool.withDoc(id, account, async (tab) => {
        const t = await pageOp(tab, 'title', { title }, api);
        let verification = null;
        if (content) {
          const before = await snapshot(tab);
          await pageOp(tab, 'write', { mode: 'replace_document', content }, api);
          verification = await verify(tab, () => true, { probes: content.probes || [], before });
        }
        return { id, url: editUrl(id, account), titleVerified: !!t.verified, verification };
      }, 'create');
    },

    async edit({ id, account, steps, expect = {} }) {
      return pool.withDoc(id, account, async (firstTab, entry, state) => {
        if (!state.editable) throw new OpError('read_only', `document is not editable by ${accountLabel(account)} (${state.reason || state.mode || 'view only'})`);
        let tabId = firstTab;
        const mutates = steps.some((st) => Object.keys(st || {}).some((k) => MUTATING.has(k)));
        const before = mutates ? await fullSnapshot(tabId) : null;
        let r;
        try {
          r = await pageOp(tabId, 'edit', { steps }, api);
        } catch (err) {
          // Retry a wedged Find in a fresh tab — but only if nothing had been
          // changed yet, or the retry would repeat edits.
          const changedSomething = (err.completed || []).some((c) => MUTATING.has(c.action));
          if (err.code !== 'find_stalled' || changedSomething) throw err;
          await pool.refresh(entry);
          tabId = entry.tabId;
          r = await pageOp(tabId, 'edit', { steps }, api);
        }
        const verification = mutates ? await verifyEdit(tabId, before, expect) : null;
        if (verification) entry.dirtySince = verification.verified ? null : now();
        return { ...docInfo(state, id, account), results: r.results, verification };
      }, 'edit');
    },

    async copy({ id, account, title }) {
      const openedAt = now();
      const tabId = await pool.openBackground(copyUrl(id, { title, account }));
      let newId = null;
      try {
        for (let i = 0; i < 40; i++) {
          const tab = await api.tabs.get(tabId);
          if (tab.status === 'complete') break;
          await sleep(250);
        }
        const clicked = await runInTab(tabId, makeCopyPage, [], api);
        if (!clicked.ok) throw new OpError(clicked.code || 'copy_failed', clicked.message || 'could not make a copy');
        newId = await waitForNewDoc(tabId, id, account);
        if (!newId) throw new OpError('copy_failed', 'Docs did not open the copy within 40s (if Google Drive storage is full, copies cannot be made)');
        const state = await pool.waitForEditor(tabId, { docId: newId, account });
        pool.adopt(newId, account, tabId, openedAt);
        let finalTitle = state.title;
        if (title && state.title !== title) {
          const t = await pool.withDoc(newId, account, (tab) => pageOp(tab, 'title', { title }, api), 'set title');
          finalTitle = t.verified ? title : state.title;
        }
        return { id: newId, url: editUrl(newId, account), title: finalTitle };
      } catch (err) {
        if (!newId) await api.tabs.remove(tabId).catch(() => {});
        throw err;
      }
    },

    async templates({ account }) {
      const r = await pool.transient(galleryUrl(account), async (tabId) => {
        for (let attempt = 0; attempt < 40; attempt++) {
          const tab = await api.tabs.get(tabId);
          if (/^https:\/\/accounts\.google\.com\//.test(tab.url || '')) throw new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
          if (tab.status === 'complete') break;
          await sleep(250);
        }
        return runInTab(tabId, listTemplatesPage, [], api);
      });
      if (!r.ok) throw new OpError(r.code || 'templates_failed', r.message || 'could not read the template gallery');
      return { items: r.items };
    },

    // Human typing (typer.js): a job types over minutes, so these return at
    // once and the server polls type_status.
    async type_start(args) {
      return typing.start(args);
    },

    async type_status({ job }) {
      return typing.status({ job });
    },

    async type_list() {
      return typing.list();
    },

    async type_control({ job, action }) {
      return typing.control({ job, action });
    },

    /** Reload the extension (after a code change), unless a typing job would be cut off. */
    async reload({ force = false } = {}) {
      const { jobs } = await typing.list();
      const running = jobs.filter((j) => j.status === 'running');
      if (running.length && !force) {
        throw new OpError('busy', `${running.length} typing job(s) are running (${running.map((j) => j.job).join(', ')}); pause them first or pass force`);
      }
      setTimeout(() => api.runtime.reload(), 250);
      return { version, interrupted: running.length };
    },

    async open({ id, account }) {
      const url = editUrl(id, account);
      const tab = await api.tabs.create({ url, active: true });
      if (tab.windowId !== undefined) await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return { url };
    },
  };

  return {
    ops,
    pool,
    typing,
    /**
     * Run one call. `timeout` is how long the MCP server will wait for it;
     * the call gets a little less, so the answer it sends is a real error
     * rather than silence. A document call that runs past it is abandoned:
     * its tab is closed and its queue dropped, so the next call on that
     * document starts clean instead of waiting behind the stuck one.
     */
    async dispatch(op, args, { timeout } = {}) {
      const fn = Object.hasOwn(ops, op) ? ops[op] : null;
      if (!fn) throw new OpError('bad_request', `unknown operation: ${op}`);
      const a = args || {};
      const budget = Math.max(MIN_BUDGET_MS, (Number(timeout) || DEFAULT_CALL_TIMEOUT_MS) - DEADLINE_MARGIN_MS);
      return withTimeout(fn(a), budget, () => {
        if (a.id) pool.abandon(a.id, a.account).catch(() => {});
        return new OpError(
          'timeout',
          `${op} did not finish within ${Math.round(budget / 1000)}s${a.id ? '; its bridge tab was closed so the next call starts fresh. Read the document before retrying: some steps may have applied' : ''}`
        );
      });
    },
  };
}
