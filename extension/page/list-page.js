/**
 * Document listing, run inside a Drive search tab or the Docs (or Slides)
 * home page. The Slides home page uses the same grid as Docs.
 *
 * Injected with chrome.scripting.executeScript({func}), so — like
 * docs-page.js — it must be fully self-contained.
 *
 * Drive's markup is obfuscated, so this keys only on semantic attributes that
 * Drive keeps stable for accessibility and drag-and-drop. In list view rows
 * are tr[role=row][data-id], the name cell carries data-tooltip "<title>
 * Google Docs", and the other cells carry aria-labels "Modified …" and
 * "Owned by …". In grid view (a per-account setting) each result is a
 * div[role=gridcell][data-id] tile with the same data-tooltip but no
 * modified/owner cells, so those come back null.
 * The Docs home grid has no ids in attributes, but each thumbnail URL embeds
 * the document id.
 *
 * @param {number} limit
 * @returns {Promise<{ok: boolean, items?: object[], source?: string, code?: string, message?: string}>}
 */
export async function listDocsPage(limit = 20) {
  const yieldOnce = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  async function pause(ms) {
    const end = performance.now() + ms;
    do await yieldOnce();
    while (performance.now() < end);
  }
  async function waitFor(predicate, timeout, step = 100) {
    const end = performance.now() + timeout;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (performance.now() >= end) return null;
      await pause(step);
    }
  }
  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();

  function driveRows() {
    return [...document.querySelectorAll('tr[role="row"][data-id], div[role="row"][data-id], [role="gridcell"][data-id]')];
  }

  function driveItem(row) {
    const id = row.getAttribute('data-id');
    const named = row.querySelector('[data-tooltip]');
    let title =
      clean(row.querySelector('strong')?.textContent) ||
      clean(named?.getAttribute('data-tooltip')).replace(/\s+Google (Docs|Slides)$/i, '') ||
      clean(row.getAttribute('aria-label')).replace(/\s+Google (Docs|Slides)\b.*$/i, '');
    const labels = [...row.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label') || '');
    const modified = labels.find((l) => /^Modified\b/i.test(l))?.replace(/^Modified\s*/i, '').trim() || null;
    const ownerLabel = labels.find((l) => /^Owned by\b/i.test(l));
    const owner = ownerLabel ? ownerLabel.replace(/^Owned by\s*/i, '').trim() : row.querySelector('[data-hovercard-id][data-name]')?.getAttribute('data-name') || null;
    const shared = labels.some((l) => /\bShared\b/i.test(l));
    if (!title) title = '(untitled)';
    return { id, title, modified, owner, shared };
  }

  function homeItems() {
    const out = [];
    for (const el of document.querySelectorAll('.docs-homescreen-grid-item, .docs-homescreen-list-item')) {
      const thumb = el.querySelector('[style*="/d/"]')?.getAttribute('style') || '';
      const m = thumb.match(/\/d\/([a-zA-Z0-9_-]{25,})/);
      if (!m) continue;
      const titleEl = el.querySelector('[class*="item-title"]');
      const title = clean(titleEl?.getAttribute('title') || titleEl?.textContent) || '(untitled)';
      const meta = clean(el.querySelector('[class*="metadata-row"], [class*="date"]')?.textContent);
      const when = meta.match(/(Modified|Opened|Shared)\s*(.+)$/i);
      out.push({ id: m[1], title, modified: when ? `${when[1].toLowerCase()} ${when[2]}` : null, owner: null, shared: /shared/i.test(el.className) });
    }
    return out;
  }

  try {
    if (/accounts\.google\.com/.test(location.host)) {
      return { ok: false, code: 'signed_out', message: 'Chrome is not signed in to that Google account' };
    }

    if (location.host === 'drive.google.com') {
      // Results render asynchronously; an empty result set shows a message instead of rows.
      const ready = await waitFor(
        () => driveRows().length || /No results|No files match|Nothing matched/i.test(document.body?.textContent || ''),
        20000
      );
      if (!ready) return { ok: false, code: 'timeout', message: 'Drive search did not load' };
      const seen = new Map();
      for (let round = 0; round < 6 && seen.size < limit; round++) {
        for (const row of driveRows()) {
          const id = row.getAttribute('data-id');
          if (id && !seen.has(id)) seen.set(id, driveItem(row));
        }
        if (seen.size >= limit) break;
        // Drive virtualises long lists; scrolling the last row into view loads more.
        const rows = driveRows();
        const before = rows.length;
        rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
        const grew = await waitFor(() => driveRows().length > before || null, 2500);
        if (!grew) break;
      }
      return { ok: true, source: 'drive search', items: [...seen.values()].slice(0, limit) };
    }

    const ready = await waitFor(() => homeItems().length || document.querySelector('.docs-homescreen-empty-state, [class*="empty-state"]'), 20000);
    if (!ready) return { ok: false, code: 'timeout', message: 'the Docs home page did not load' };
    return { ok: true, source: 'recent documents', items: homeItems().slice(0, limit) };
  } catch (err) {
    return { ok: false, code: 'page_error', message: err.message || String(err) };
  }
}

/**
 * On a /document/d/<id>/copy (or /presentation/d/<id>/copy) page: press
 * "Make a copy". Chrome then navigates
 * the tab to the new document, which the caller waits for.
 *
 * Self-contained (injected with executeScript).
 */
export async function makeCopyPage() {
  const yieldOnce = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  const end = performance.now() + 15000;
  let btn = null;
  while (!btn && performance.now() < end) {
    btn = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].find((b) =>
      /^make a copy$/i.test((b.textContent || b.value || '').trim())
    );
    if (!btn) {
      const text = document.body?.textContent || '';
      if (/You need access|Request access|You need permission/i.test(text)) return { ok: false, code: 'no_access', message: 'no access to the source document' };
      if (/accounts\.google\.com/.test(location.host)) return { ok: false, code: 'signed_out', message: 'not signed in' };
      await yieldOnce();
    }
  }
  if (!btn) return { ok: false, code: 'copy_failed', message: 'the "Make a copy" button did not appear' };
  const r = btn.getBoundingClientRect();
  for (const t of ['mousedown', 'mouseup', 'click']) {
    btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.x + 5, clientY: r.y + 5 }));
  }
  return { ok: true };
}

/**
 * The Docs template gallery (docs.google.com/document/?ftv=1&tgif=d). Each
 * template is an ordinary public document; its id is embedded in the
 * thumbnail URL, so a template is used by copying that document.
 *
 * Self-contained (injected with executeScript).
 */
export async function listTemplatesPage() {
  const yieldOnce = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  const read = () => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('.docs-homescreen-templates-templateview')) {
      const src = el.querySelector('img')?.getAttribute('src') || '';
      const m = src.match(/thumbnails\/([a-zA-Z0-9_-]{25,}?)_\d+(?:_\d+)?\.png/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const parts = [...el.querySelectorAll('[class*="caption"] *')]
        .filter((x) => !x.childElementCount)
        .map((x) => (x.textContent || '').trim())
        .filter(Boolean);
      out.push({ id: m[1], name: parts[0] || '(untitled)', style: parts[1] || null });
    }
    return out;
  };
  const end = performance.now() + 20000;
  let items = read();
  while (!items.length && performance.now() < end) {
    if (/accounts\.google\.com/.test(location.host)) return { ok: false, code: 'signed_out', message: 'not signed in' };
    await yieldOnce();
    items = read();
  }
  if (!items.length) return { ok: false, code: 'timeout', message: 'the template gallery did not load' };
  return { ok: true, items };
}
