/**
 * Google Slides operations. Same shape as the Docs ones in ops.js: reads go
 * to the export endpoint from the service worker (host permissions let it
 * follow the redirect to googleusercontent.com), edits run page code
 * (page/slides-page.js) in a background bridge tab, and every edit is then
 * checked against the deck as saved in Drive — the exported .pptx, parsed by
 * pptx.js — not against what the editor shows.
 */

import { slidesExportUrl, slidesEditUrl, slidesCreateUrl, slidesSearchUrl, slidesRecentUrl, slidesCopyUrl, classifyLanding, SLIDES_EXPORT_FORMATS } from './refs.js';
import { OpError, slidesOp, runInTab, sleep } from './tabs.js';
import { makeCopyPage } from '../page/list-page.js';
import { parsePptx, slideSearchText } from './pptx.js';

export const KIND = 'presentation';
const DECK_VERIFY_TIMEOUT_MS = 40_000;
/** Polls back off: an export is a full .pptx render, and Google rate-limits exports (429) under rapid use. */
const DECK_VERIFY_INTERVAL_MS = 1_500;
const DECK_VERIFY_MAX_INTERVAL_MS = 8_000;
const RATE_LIMIT_RETRIES = [3_000, 6_000, 12_000];

/** Letters and digits only: what "the same text" means when comparing what was typed with what Drive saved. */
export const squash = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const shapeText = (s) => (s.kind === 'table' ? (s.rows || []).flat().join('\n') : s.kind === 'group' ? (s.children || []).map(shapeText).join('\n') : s.paragraphs.map((p) => p.text).join('\n'));

function allShapes(shapes) {
  return shapes.flatMap((s) => (s.kind === 'group' ? [s, ...allShapes(s.children || [])] : [s]));
}

/**
 * Everything about a saved deck that an edit can change: slide order (by
 * content), layouts, text, formatting, notes. Export-internal object names
 * are left out: the export renumbers them.
 */
export function deckSignature(deck) {
  const shape = (s) => [s.kind, s.placeholder, s.box, s.paragraphs.map((p) => [p.text, p.level, p.list, p.align || null, (p.runs || []).map((r) => [r.text, r.style])]), s.rows || null, (s.children || []).map(shape)];
  return JSON.stringify(deck.slides.map((sl) => [sl.layout, sl.hidden, sl.notes, sl.shapes.map(shape)]));
}

/** The deck without per-run detail (the outline only needs each paragraph's markdown). */
export function compactDeck(deck) {
  const shape = ({ name, objectId, ...s }) => ({ ...s, paragraphs: s.paragraphs.map(({ runs, ...p }) => p), ...(s.children ? { children: s.children.map(shape) } : {}) });
  return { ...deck, slides: deck.slides.map(({ part, ...sl }) => ({ ...sl, shapes: sl.shapes.map(shape) })) };
}

/**
 * What the saved deck does not show yet, given what the editor reported
 * doing (the page's step results) and the slides it ended with. The export
 * renumbers object ids, so slides and shapes are matched by position: a
 * result's page id is looked up in the editor's final slide order, and shape
 * N there is shape N in the export (both list shapes in z-order).
 */
export function deckProblems(deck, results = [], finalSlides = null) {
  const problems = [];
  const indexOf = (pageId) => (finalSlides ? finalSlides.findIndex((s) => s.pageId === pageId) + 1 : 0);
  for (const r of results) {
    const at = r.pageId ? indexOf(r.pageId) : 0;
    const sl = at ? deck.slides[at - 1] : null;
    switch (r.action) {
      case 'setText': {
        if (!sl) {
          problems.push(`slide ${at || r.pageId} is not in the saved deck yet`);
          break;
        }
        const want = squash(r.text);
        const target = r.index ? sl.shapes[r.index - 1] : null;
        const ok = target ? squash(shapeText(target)) === want : allShapes(sl.shapes).some((s) => squash(shapeText(s)) === want);
        if (!ok) problems.push(`slide ${at}: the text of shape ${r.index ?? '?'} is not saved yet`);
        break;
      }
      case 'notes': {
        if (!sl) problems.push(`slide ${at || r.pageId} is not in the saved deck yet`);
        else if (squash(sl.notes) !== squash(r.notes)) problems.push(`slide ${at}: the speaker notes are not saved yet`);
        break;
      }
      case 'text':
      case 'insert':
      case 'typeText': {
        if (sl && r.typed && !squash(slideSearchText(sl) + sl.notes).includes(squash(r.typed))) problems.push(`slide ${at}: ${JSON.stringify(r.typed)} is not saved yet`);
        break;
      }
      case 'layout':
      case 'newSlide': {
        const want = r.layout ? String(r.layout).toLowerCase() : null;
        if (sl && want && sl.layout && String(sl.layout).toLowerCase() !== want) problems.push(`slide ${at}: layout is ${sl.layout}, not ${r.layout}, in the saved deck`);
        break;
      }
      default:
    }
  }
  if (finalSlides?.length && deck.slides.length !== finalSlides.length) problems.push(`the saved deck has ${deck.slides.length} slide(s); the editor shows ${finalSlides.length}`);
  return problems;
}

/** Occurrences of `needle` in the deck's slide text (what Find and replace searches). */
export function deckCount(deck, needle, matchCase) {
  if (!needle) return 0;
  let n = 0;
  for (const sl of deck.slides) {
    const hay = matchCase ? slideSearchText(sl) : slideSearchText(sl).toLowerCase();
    const want = matchCase ? needle : needle.toLowerCase();
    for (let i = hay.indexOf(want); i !== -1; i = hay.indexOf(want, i + want.length)) n++;
  }
  return n;
}

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape']);
const MOVES = new Set(['slide', 'shape', 'editText', 'selectText', 'caret', 'notesFocus', 'escape']);

/**
 * Steps whose results the saved deck can confirm on its own (exact text, the
 * slide count, the layout), so no "before" snapshot is needed to tell that
 * something changed. Any other change (formatting, menus, moves, keys) is
 * confirmed by comparing the saved deck with a snapshot from before the run.
 */
const SELF_CHECKING = new Set(['setText', 'notes', 'text', 'insert', 'typeText', 'newSlide', 'duplicateSlide', 'deleteSlide', 'layout']);

export function needsSnapshot(steps) {
  return steps.some((st) => stepMutates(st) && !SELF_CHECKING.has(Object.keys(st).find((k) => !['mods', 'times'].includes(k))));
}

/** Does this page step change the deck (and so need verifying)? */
export function stepMutates(step) {
  const kind = Object.keys(step || {}).find((k) => !['mods', 'times'].includes(k));
  if (!kind || MOVES.has(kind)) return false;
  if (kind === 'key') return !(NAV_KEYS.has(step.key) && !step.mods?.mod && !step.mods?.alt);
  return true;
}

export function createSlidesOps({
  pool,
  api,
  fetchImpl,
  now,
  log = () => {},
  deckVerifyTimeoutMs = DECK_VERIFY_TIMEOUT_MS,
  deckVerifyIntervalMs = DECK_VERIFY_INTERVAL_MS,
  deckVerifyMaxIntervalMs = DECK_VERIFY_MAX_INTERVAL_MS,
  retryDelays = RATE_LIMIT_RETRIES,
  helpers,
}) {
  const { accountLabel, titleFromDisposition, toBase64, listAt } = helpers;

  function landingError(kind, id, account) {
    switch (kind) {
      case 'signed_out':
        return new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
      case 'no_access':
        return new OpError('no_access', `${accountLabel(account)} cannot open presentation ${id}. If another signed-in account owns it, pass account (e.g. 1 or an email).`);
      case 'not_found':
        return new OpError('not_found', `presentation ${id} was not found for ${accountLabel(account)} (wrong id, deleted, or owned by another account).`);
      case 'rate_limited':
        return new OpError('rate_limited', 'Google is rate-limiting exports; wait a minute and retry.');
      default:
        return new OpError('http_error', `Google returned an error exporting ${id} (${kind}).`);
    }
  }

  async function fetchExport(id, format, { account, page } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(slidesExportUrl(id, format, { account, page }), { credentials: 'include', redirect: 'follow', cache: 'no-store' });
      } catch (err) {
        throw new OpError('network', `could not reach Google Slides: ${err.message}`);
      }
      const type = res.headers.get('content-type') || '';
      const kind = classifyLanding(res.url, res.status, type);
      if (kind === 'rate_limited' && attempt < retryDelays.length) {
        log(`slides export of ${id} rate-limited; retrying in ${retryDelays[attempt] / 1000}s`);
        await sleep(retryDelays[attempt]);
        continue;
      }
      if (kind !== 'ok') throw landingError(kind, id, account);
      if (/text\/html/i.test(type)) throw landingError('no_access', id, account);
      return { res, title: titleFromDisposition(res.headers.get('content-disposition')) };
    }
  }

  async function savedDeck(id, account) {
    const { res, title } = await fetchExport(id, 'pptx', { account });
    const deck = await parsePptx(new Uint8Array(await res.arrayBuffer()));
    return { deck, title };
  }

  const signatureOf = (id, account) => savedDeck(id, account).then(({ deck }) => deckSignature(deck), () => null);

  /**
   * Poll the saved deck until `problems(deck)` is empty and (when `before` is
   * given) the deck differs from it. Runs in the service worker, whose
   * timers are not throttled. The first look is immediate (callers wait for
   * the editor's "Saved to Drive" first); later ones back off.
   */
  async function verifyDeck(id, account, problems, { before = null } = {}) {
    const started = now();
    let last = { problems: [], unchanged: false };
    let wait = 0;
    let polls = 0;
    while (now() - started < deckVerifyTimeoutMs) {
      if (wait) await sleep(wait);
      wait = Math.min(deckVerifyMaxIntervalMs, wait ? wait * 1.6 : deckVerifyIntervalMs);
      polls++;
      try {
        const { deck } = await savedDeck(id, account);
        const changed = before === null || deckSignature(deck) !== before;
        const p = problems(deck);
        last = { problems: p, unchanged: !changed };
        if (changed && !p.length) return { verified: true, waitedSeconds: Math.round((now() - started) / 1000), polls };
      } catch (err) {
        last = { ...last, error: err.message };
        if (err.code === 'rate_limited') wait = deckVerifyMaxIntervalMs;
      }
    }
    return {
      verified: false,
      waitedSeconds: Math.round((now() - started) / 1000),
      polls,
      ...(last.unchanged ? { unchanged: true } : {}),
      ...(last.problems.length ? { missing: last.problems } : {}),
      ...(last.error && !last.problems.length ? { error: last.error } : {}),
    };
  }

  async function waitForNewDeck(tabId, excludeId, account) {
    for (let i = 0; i < 160; i++) {
      const tab = await api.tabs.get(tabId);
      const url = tab.url || tab.pendingUrl || '';
      if (/^https:\/\/accounts\.google\.com\//.test(url)) throw new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
      const id = url.match(/\/presentation\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{25,})\/(?:edit|$)/)?.[1];
      if (id && id !== excludeId) return id;
      await sleep(250);
    }
    return null;
  }

  const requireEditable = (state, account) => {
    if (!state.editable) throw new OpError('read_only', `presentation is not editable by ${accountLabel(account)} (${state.reason || state.mode || 'view only'})`);
  };

  const info = (state, id, account) => ({ title: state?.title || null, url: slidesEditUrl(id, account) });

  return {
    async slides_deck({ id, account }) {
      const { deck, title } = await savedDeck(id, account);
      return { title, deck: compactDeck(deck) };
    },

    async slides_text({ id, account }) {
      const { res, title } = await fetchExport(id, 'text', { account });
      return { title, content: await res.text() };
    },

    async slides_export({ id, account, format, page }) {
      if (!SLIDES_EXPORT_FORMATS[format]) throw new OpError('bad_args', `unknown format ${format}`);
      const { res, title } = await fetchExport(id, format, { account, page });
      return { base64: toBase64(await res.arrayBuffer()), title, mime: SLIDES_EXPORT_FORMATS[format].mime };
    },

    async slides_list({ query = '', limit = 20, account }) {
      return listAt(query ? slidesSearchUrl(query, account) : slidesRecentUrl(account), limit, account);
    },

    /** The live editor's view: slides in order and the current slide's shapes. */
    async slides_shapes({ id, account, page }) {
      return pool.withDoc(
        id,
        account,
        async (tabId, entry, state) => {
          if (page) await slidesOp(tabId, 'run', { steps: [{ slide: page }] }, api);
          const r = await slidesOp(tabId, 'slides', {}, api);
          return { ...info(state, id, account), slides: r.slides, page: r.page, shapes: r.shapes };
        },
        'shapes',
        KIND
      );
    },

    async slides_run({ id, account, steps }) {
      return pool.withDoc(
        id,
        account,
        async (tabId, entry, state) => {
          requireEditable(state, account);
          const mutates = steps.some(stepMutates);
          const before = mutates && needsSnapshot(steps) ? await signatureOf(id, account) : null;
          const r = await slidesOp(tabId, 'run', { steps }, api);
          let verification = null;
          if (mutates) {
            const saved = await slidesOp(tabId, 'saved', { timeout: 15_000 }, api).catch(() => null);
            if (saved && !saved.saved) log(`slides ${id}: editor still says ${saved.status}`);
            verification = await verifyDeck(id, account, (deck) => deckProblems(deck, r.results, r.slides), { before });
            entry.dirtySince = verification.verified ? null : now();
          }
          return { ...info(state, id, account), results: r.results, slides: r.slides, page: r.page, verification };
        },
        'edit',
        KIND
      );
    },

    /**
     * Find and replace, for one pair or several (`pairs`), in one editor
     * session with one verification at the end. A snapshot is only taken
     * when the check needs one (single occurrence, regex, or a replacement
     * that contains its own search text).
     */
    async slides_replace({ id, account, find, replace, pairs, matchCase = false, regex = false, occurrence = null }) {
      const list = pairs?.length ? pairs : [{ find, replace }];
      return pool.withDoc(
        id,
        account,
        async (tabId, entry, state) => {
          requireEditable(state, account);
          const contains = (a, b) => (matchCase ? a.includes(b) : a.toLowerCase().includes(b.toLowerCase()));
          const selfChecking = (p) => !regex && !occurrence && !contains(p.replace, p.find);
          const before = list.every(selfChecking) ? null : await savedDeck(id, account).then(({ deck }) => deck, () => null);
          const done = [];
          for (const p of list) {
            const r = await slidesOp(tabId, 'replace', { find: p.find, replace: p.replace, matchCase, regex, occurrence }, api);
            done.push({ ...p, replaced: r.replaced, matches: r.matches });
          }
          let verification = null;
          if (done.some((d) => d.replaced)) {
            await slidesOp(tabId, 'saved', { timeout: 15_000 }, api).catch(() => null);
            verification = await verifyDeck(
              id,
              account,
              (deck) =>
                done
                  .filter((d) => d.replaced)
                  .flatMap((d) => {
                    if (selfChecking(d)) {
                      const left = deckCount(deck, d.find, matchCase);
                      return left ? [`${left} occurrence(s) of ${JSON.stringify(d.find)} still in the saved deck`] : [];
                    }
                    if (occurrence && before && !regex && !contains(d.replace, d.find)) {
                      return deckCount(deck, d.find, matchCase) === deckCount(before, d.find, matchCase) - 1 ? [] : [`the replacement of ${JSON.stringify(d.find)} is not saved yet`];
                    }
                    return d.replace && !squash(deck.slides.map(slideSearchText).join('\n')).includes(squash(d.replace)) ? [`${JSON.stringify(d.replace)} not in the saved deck yet`] : [];
                  }),
              { before: before ? deckSignature(before) : null }
            );
            entry.dirtySince = verification.verified ? null : now();
          }
          const first = done[0];
          return { ...info(state, id, account), replaced: first.replaced, matches: first.matches, results: done, verification };
        },
        'find and replace',
        KIND
      );
    },

    async slides_rename({ id, account, title }) {
      return pool.withDoc(
        id,
        account,
        async (tabId, entry, state) => {
          requireEditable(state, account);
          const r = await slidesOp(tabId, 'title', { title }, api);
          return { ...info({ title }, id, account), verified: !!r.verified };
        },
        'rename',
        KIND
      );
    },

    async slides_create({ title, account }) {
      const openedAt = now();
      const tabId = await pool.openBackground(slidesCreateUrl(account));
      let id = null;
      try {
        for (let i = 0; i < 120 && !id; i++) {
          const tab = await api.tabs.get(tabId);
          const url = tab.url || tab.pendingUrl || '';
          if (/^https:\/\/accounts\.google\.com\//.test(url)) throw new OpError('signed_out', `Chrome is not signed in to Google for ${accountLabel(account)}.`);
          id = url.match(/\/presentation\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{25,})/)?.[1] || null;
          if (!id) await sleep(250);
        }
        if (!id) throw new OpError('create_failed', 'Slides did not create a presentation within 30s (if Google Drive storage is full, new files cannot be created)');
        await pool.waitForEditor(tabId, { docId: id, account, kind: KIND });
      } catch (err) {
        if (!id) await api.tabs.remove(tabId).catch(() => {});
        throw err;
      }
      pool.adopt(id, account, tabId, openedAt, KIND);
      return pool.withDoc(
        id,
        account,
        async (tab) => {
          await slidesOp(tab, 'dismiss', { wait: 4000 }, api).catch(() => null);
          const t = title ? await slidesOp(tab, 'title', { title }, api) : { verified: true };
          return { id, url: slidesEditUrl(id, account), titleVerified: !!t.verified };
        },
        'create',
        KIND
      );
    },

    async slides_copy({ id, account, title }) {
      const openedAt = now();
      const tabId = await pool.openBackground(slidesCopyUrl(id, { title, account }));
      let newId = null;
      try {
        for (let i = 0; i < 40; i++) {
          const tab = await api.tabs.get(tabId);
          if (tab.status === 'complete') break;
          await sleep(250);
        }
        const clicked = await runInTab(tabId, makeCopyPage, [], api);
        if (!clicked.ok) throw new OpError(clicked.code || 'copy_failed', clicked.message || 'could not make a copy');
        newId = await waitForNewDeck(tabId, id, account);
        if (!newId) throw new OpError('copy_failed', 'Slides did not open the copy within 40s (if Google Drive storage is full, copies cannot be made)');
        const state = await pool.waitForEditor(tabId, { docId: newId, account, kind: KIND });
        pool.adopt(newId, account, tabId, openedAt, KIND);
        let finalTitle = state.title;
        if (title && state.title !== title) {
          const t = await pool.withDoc(newId, account, (tab) => slidesOp(tab, 'title', { title }, api), 'set title', KIND);
          finalTitle = t.verified ? title : state.title;
        }
        return { id: newId, url: slidesEditUrl(newId, account), title: finalTitle };
      } catch (err) {
        if (!newId) await api.tabs.remove(tabId).catch(() => {});
        throw err;
      }
    },

    async slides_open({ id, account, page }) {
      const url = slidesEditUrl(id, account, page);
      const tab = await api.tabs.create({ url, active: true });
      if (tab.windowId !== undefined) await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return { url };
    },
  };
}
