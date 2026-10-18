/**
 * Everything that runs inside a Google Slides editor tab.
 *
 * Like docs-page.js, `slidesPageOp` is injected with
 * chrome.scripting.executeScript({func, world: 'MAIN'}), so it must be fully
 * self-contained: no imports, no closures over module scope. test/slides.test.js
 * compiles its source on its own to enforce that.
 *
 * Slides is the same editor family as Docs, and most of the Docs techniques
 * carry over (verified live against docs.google.com/presentation, 2026-10-12):
 *
 *   - Keys and pastes go to the hidden contenteditable inside
 *     `iframe.docs-texteventtarget-iframe`. A synthetic `paste` carrying
 *     text/html is consumed (preventDefault) and applied at the selection.
 *   - The slide is SVG: the current page is `g#editor-<pageId>` and each
 *     shape on it a child `g#editor-<objectId>` (the page's background is
 *     `#editor-<pageId>-bg`). Each shape has a `path[pointer-events=
 *     "visiblePainted"]` hit area; mousedown/mouseup/click on it selects the
 *     shape. Enter then puts the caret in its text.
 *   - A paste with no text caret — nothing selected, or a whole shape
 *     selected — does not type: it creates a new text box, or replaces the
 *     selected shape's whole text. So text is only ever pasted after the
 *     caret is confirmed to be in the intended text.
 *   - A synthetic `copy` ClipboardEvent with our own DataTransfer is filled
 *     by Slides with the selection: exact text/plain (spaces and line breaks
 *     intact), text/html, and, when whole shapes are selected rather than
 *     text, an `application/x-vnd.google-docs-drawings-object+wrapped` type.
 *     The user's real clipboard is never touched. That is how this code
 *     reads exact text, tells "editing text" from "shapes selected", and
 *     checks every write.
 *   - Cmd+A inside text selects that text box's text; with shapes selected
 *     it selects every shape on the slide. Before anything is deleted, a copy
 *     confirms the selection is text, not shapes.
 *   - The filmstrip draws each slide as `g#filmstrip-slide-<i>-<pageId>`
 *     inside a `.punch-filmstrip-thumbnail`; clicking it goes to that slide,
 *     and the URL hash becomes `#slide=id.<pageId>`. `i` goes stale when
 *     slides move; the thumbnail's translate(0 Y) is the real order.
 *   - Ctrl+M (Ctrl on macOS too) adds a slide after the current one. Slide >
 *     Apply layout is a palette of `td.goog-palette-cell` items labelled by
 *     `.punch-layouts-palette-label`.
 *   - Cmd+Alt+Shift+S (Ctrl+Alt+Shift+S elsewhere) puts the caret in the
 *     speaker notes, even when the notes panel is collapsed to 0px.
 *   - Lists: Cmd+Shift+8/7 toggle bullets/numbering, Tab and Shift+Tab nest
 *     at the start of an item, Enter continues the list. Pressing the other
 *     list's shortcut on an item retypes every item of that list, so a
 *     bulleted list followed by a numbered one is typed as: bullets off, then
 *     numbering on (a new list). The toolbar's
 *     #addBulletButton / #addNumberedBulletButton aria-pressed report the
 *     caret's list about a second after it moves (hidden tabs align timers
 *     to one second).
 *   - Find and replace is the Docs dialog, "n of m" counter and all, and
 *     "Replace all" works. In a hidden tab Cmd+Shift+H does not open it but
 *     Edit > Find and replace does, and the counter does not refresh after a
 *     replace (the saved deck is the check). Unlike Docs, stepping to a match
 *     and closing the dialog does not leave the match selected as text, so
 *     text is selected by caret moves at exact offsets instead (selectText).
 *   - A new presentation opens a "Getting started" dialog over the editor; its
 *     Close button accepts a synthetic click.
 *
 * Every op resolves to {ok:true, ...} or {ok:false, code, message}; it never
 * throws, because a rejection from an injected function does not survive
 * executeScript intact.
 *
 * @param {string} op
 * @param {object} args
 */
export async function slidesPageOp(op, args = {}) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  // ---------------------------------------------------------------- timing

  const yieldOnce = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });

  /** What this op is doing, for the extension's watchdog (tabs.js). */
  const progressState = (globalThis.__docsBridgeProgress = { label: op, at: Date.now(), beat: 0 });
  function progress(label) {
    progressState.label = label;
    progressState.at = Date.now();
    progressState.beat++;
  }

  /** Wait without timers: hidden tabs clamp setTimeout, MessageChannel is not. */
  async function pause(ms) {
    const end = performance.now() + ms;
    do await yieldOnce();
    while (performance.now() < end);
    progressState.beat++;
  }

  async function waitFor(predicate, timeout = 4000, step = 40) {
    const end = performance.now() + timeout;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (performance.now() >= end) return null;
      await pause(step);
    }
  }

  class OpError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const fail = (code, message) => {
    throw new OpError(code, message);
  };

  const norm = (s) =>
    String(s ?? '')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /** Text compared for verification: letters and digits only, so smart quotes, dashes and spacing never matter. */
  const squash = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // ------------------------------------------------------------------ keys

  const KEYS = {
    ArrowUp: [38, 'ArrowUp'],
    ArrowDown: [40, 'ArrowDown'],
    ArrowLeft: [37, 'ArrowLeft'],
    ArrowRight: [39, 'ArrowRight'],
    Backspace: [8, 'Backspace'],
    Delete: [46, 'Delete'],
    Enter: [13, 'Enter'],
    Escape: [27, 'Escape'],
    Tab: [9, 'Tab'],
    Home: [36, 'Home'],
    End: [35, 'End'],
    PageUp: [33, 'PageUp'],
    PageDown: [34, 'PageDown'],
    ' ': [32, 'Space'],
    '.': [190, 'Period'],
    ',': [188, 'Comma'],
    '[': [219, 'BracketLeft'],
    ']': [221, 'BracketRight'],
    '\\': [220, 'Backslash'],
    '/': [191, 'Slash'],
  };

  function editor() {
    const frame = document.querySelector('iframe.docs-texteventtarget-iframe');
    return frame?.contentDocument?.querySelector('[contenteditable="true"]') || null;
  }

  function requireEditor() {
    const el = editor();
    if (!el) fail('not_ready', 'the Slides editor is not loaded in this tab');
    return el;
  }

  /** Dispatch a key chord. `mod` is Cmd on macOS and Ctrl elsewhere; `ctrl` is always Ctrl. */
  function key(target, name, mods = {}) {
    let keyCode;
    let code;
    if (KEYS[name]) [keyCode, code] = KEYS[name];
    else if (/^[a-z]$/i.test(name)) {
      keyCode = name.toUpperCase().charCodeAt(0);
      code = `Key${name.toUpperCase()}`;
    } else if (/^[0-9]$/.test(name)) {
      keyCode = 48 + Number(name);
      code = `Digit${name}`;
    } else fail('bad_args', `unknown key: ${name}`);
    const init = {
      key: name,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
      metaKey: (mods.mod && isMac) || !!mods.meta,
      ctrlKey: (mods.mod && !isMac) || !!mods.ctrl,
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (name === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: 13 }));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  async function press(name, mods, times = 1) {
    const ed = requireEditor();
    for (let i = 0; i < times; i++) {
      ed.focus();
      key(ed, name, mods);
      await pause(times > 20 ? 25 : 60);
    }
  }

  // ------------------------------------------------------- paste and copy

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function decodeEntities(s) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return named[e.toLowerCase()] ?? m;
    });
  }

  const stripTags = (html) => decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));

  async function paste(html, text) {
    const ed = requireEditor();
    ed.focus();
    const dt = new DataTransfer();
    if (html) dt.setData('text/html', html);
    dt.setData('text/plain', text ?? '');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ed.dispatchEvent(ev);
    if (!ev.defaultPrevented) fail('paste_ignored', 'Slides did not accept the paste (is the presentation editable?)');
    await pause(120);
  }

  /** Inline HTML at the caret; it takes the paragraph's own style (the theme's fonts and colours). */
  async function pasteInline(html) {
    if (!html) return;
    await paste(`<span>${html}</span>`, stripTags(html));
  }

  const SHAPES_TYPE = /drawings-object/;

  /** What is selected, read through Slides' own copy handler. Never touches the real clipboard. */
  function copySelection() {
    const ed = requireEditor();
    ed.focus();
    const dt = new DataTransfer();
    const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    ed.dispatchEvent(ev);
    const types = [...(dt.types || [])];
    return {
      handled: ev.defaultPrevented,
      types,
      shapes: types.some((t) => SHAPES_TYPE.test(t)),
      text: dt.getData('text/plain') || '',
      html: dt.getData('text/html') || '',
    };
  }

  // --------------------------------------------------------- human typing

  /*
   * Typing a character is the Docs sequence (AGENTS.md #22): keydown with the
   * key's real keyCode, keypress carrying the character, keyup. keydown must
   * not carry the character code: the editor acts on keydown codes (46 is
   * Delete, 33 PageUp).
   */
  const PUNCT_CODES = { ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, _: 189, '.': 190, '>': 190, '/': 191, '?': 191, '`': 192, '~': 192, '[': 219, '{': 219, '\\': 220, '|': 220, ']': 221, '}': 221, "'": 222, '"': 222 };
  const SHIFTED_DIGITS = ')!@#$%^&*(';
  const TOGGLE_KEYS = { b: ['b', {}], i: ['i', {}], u: ['u', {}], s: ['x', { shift: true }] };

  function charKey(ch) {
    if (/^[a-z]$/i.test(ch)) return { keyCode: ch.toUpperCase().charCodeAt(0), code: `Key${ch.toUpperCase()}`, shift: ch !== ch.toLowerCase() };
    if (/^[0-9]$/.test(ch)) return { keyCode: 48 + Number(ch), code: `Digit${ch}`, shift: false };
    const d = SHIFTED_DIGITS.indexOf(ch);
    if (d !== -1) return { keyCode: 48 + d, code: `Digit${d}`, shift: true };
    if (ch === ' ') return { keyCode: 32, code: 'Space', shift: false };
    if (PUNCT_CODES[ch]) return { keyCode: PUNCT_CODES[ch], code: '', shift: /[:+<_>?~{|}"]/.test(ch) };
    return { keyCode: 0, code: '', shift: false };
  }

  function typeChar(ed, ch) {
    const k = charKey(ch);
    const cp = ch.codePointAt(0);
    const init = { key: ch, code: k.code, keyCode: k.keyCode, which: k.keyCode, shiftKey: k.shift, bubbles: true, cancelable: true };
    ed.dispatchEvent(new KeyboardEvent('keydown', init));
    ed.dispatchEvent(new KeyboardEvent('keypress', { ...init, keyCode: cp, which: cp, charCode: cp }));
    ed.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /** Wait a planned interval; long ones sleep on a timer, the last second spins (hidden tabs align timers to 1s). */
  async function typingWait(ms) {
    const end = performance.now() + Math.max(0, ms || 0);
    if (ms >= 1600) await new Promise((r) => setTimeout(r, ms - 1100));
    while (performance.now() < end) await yieldOnce();
    progressState.beat++;
  }

  // -------------------------------------------------------------- editable

  function isEditable() {
    const modeBtn = document.querySelector('#docs-toolbar-mode-switcher');
    const mode = modeBtn ? norm(modeBtn.textContent || modeBtn.getAttribute('aria-label') || '') : '';
    if (/Editing/i.test(mode)) return { editable: true, mode: 'editing' };
    if (/Suggesting/i.test(mode)) return { editable: true, mode: 'suggesting' };
    if (/Viewing/i.test(mode)) return { editable: false, reason: 'viewing mode', mode: 'viewing' };
    const header = document.querySelector('#docs-header, #docs-titlebar-container, .docs-titlebar-container');
    const headerText = header?.textContent || '';
    if (/Request edit access|View only|Sign in/i.test(headerText)) {
      return { editable: false, reason: /Sign in/i.test(headerText) ? 'not signed in; view only' : 'view only', mode: 'viewing' };
    }
    if (!document.querySelector('#newSlideButton, #boldButton')) return { editable: false, reason: 'no editing toolbar', mode: null };
    return { editable: true, mode: mode || null };
  }

  function requireEditable() {
    requireEditor();
    const state = isEditable();
    if (!state.editable) fail('read_only', `this presentation is not editable here (${state.reason})`);
    return state;
  }

  // -------------------------------------------------------------- mouse

  function mouse(el, types, at = 'corner') {
    const r = el.getBoundingClientRect();
    const x = at === 'center' ? r.x + r.width / 2 : r.x + 3;
    const y = at === 'center' ? r.y + r.height / 2 : r.y + 3;
    for (const t of types) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y }));
  }

  const CLICK = ['mousedown', 'mouseup', 'click'];

  function gettingStarted() {
    return [...document.querySelectorAll('[role="dialog"]')].filter(
      (d) => (/getting-started|insertabletemplates/i.test(d.className || '') || /^Getting started$/i.test(d.getAttribute('aria-label') || '')) && getComputedStyle(d).display !== 'none'
    );
  }

  /**
   * Close the "Getting started" dialog a new presentation opens with. It
   * shows a moment after the editor, and while it is up it takes the keys
   * meant for the title field, so a new deck waits for it (`wait` ms).
   */
  async function dismissPopups(wait = 0) {
    if (wait) await waitFor(() => gettingStarted().length, wait, 100);
    let closed = 0;
    for (const d of gettingStarted()) {
      const close = d.querySelector('[aria-label="Close"]');
      if (close) {
        mouse(close, CLICK);
        closed++;
        await pause(250);
      }
    }
    return closed;
  }

  // ------------------------------------------------------------ the deck

  function currentPage() {
    const m = (location.hash + '&' + location.search).match(/slide=id\.([A-Za-z0-9_-]+)/);
    if (m && document.getElementById(`editor-${m[1]}`)) return m[1];
    // The first slide of a new deck has no hash yet; the page in the editor is the one drawn.
    const page = [...document.querySelectorAll('g[id^="editor-"]')].find((g) => document.getElementById(`${g.id}-bg`) && g.getBoundingClientRect().width > 0);
    return page ? page.id.slice('editor-'.length) : m?.[1] || null;
  }

  /**
   * The filmstrip's slide thumbnails in order: [{pageId, el}]. The ids'
   * index part goes stale when slides move (a moved slide is redrawn as
   * filmstrip-slide-0-<page> while the others keep their old numbers), but
   * each thumbnail's translate(0 Y) is its real position.
   */
  function thumbs() {
    const byPage = new Map();
    for (const g of document.querySelectorAll('g[id^="filmstrip-slide-"]')) {
      const m = g.id.match(/^filmstrip-slide-(\d+)-(.+)$/);
      if (!m || !document.getElementById(`${g.id}-bg`)) continue;
      const el = g.closest('.punch-filmstrip-thumbnail') || g;
      const t = `${el.getAttribute('transform') || ''} ${el.parentElement?.getAttribute?.('transform') || ''}`.match(/translate\(\s*[-\d.e]+[\s,]+([-\d.e]+)\s*\)/);
      const y = t ? Number(t[1]) : el.getBoundingClientRect().y || Number(m[1]);
      byPage.set(m[2], { pageId: m[2], el, y, n: Number(m[1]) });
    }
    return [...byPage.values()].sort((a, b) => a.y - b.y || a.n - b.n);
  }

  /** Slides in order, from the filmstrip: [{index (1-based), pageId}]. */
  function slides() {
    return thumbs().map((t, i) => ({ index: i + 1, pageId: t.pageId }));
  }

  /**
   * How many slides the filmstrip holds: its SVG is sized for all of them
   * (height = first offset + count × pitch) even while it only draws the
   * thumbnails near its viewport. null when it cannot tell (one slide).
   */
  function filmstripTotal() {
    const svg = document.querySelector('svg.punch-filmstrip-thumbnails');
    const height = parseFloat(svg?.getAttribute('height') || '') || 0;
    const t = thumbs();
    if (!height || t.length < 2) return null;
    const pitch = t[1].y - t[0].y;
    return pitch > 0 ? Math.round((height - t[0].y) / pitch) : null;
  }

  /**
   * Wait for the filmstrip to know every slide. It fills in a few
   * thumbnails at a time after the editor is ready (seen live: 1 of 5, then
   * 5), and in a long deck it only draws the ones near its viewport (12 of
   * 29) until it is scrolled; a scroll in a hidden tab draws more, and drawn
   * thumbnails stay. So: wait for the count to hold still, then scroll down
   * through the filmstrip until it matches the total.
   */
  let filmstripSettled = false;
  async function settledSlides(quietMs = 1200, maxMs = 8000) {
    if (filmstripSettled) return slides();
    const end = performance.now() + maxMs;
    let last = slides().length;
    let since = performance.now();
    while (performance.now() < end) {
      await pause(150);
      const n = slides().length;
      if (n !== last) {
        last = n;
        since = performance.now();
      } else if (n && performance.now() - since >= quietMs) break;
    }
    const total = filmstripTotal();
    const scroller = document.querySelector('.punch-filmstrip-scroll');
    if (total && scroller && slides().length < total) {
      const start = scroller.scrollTop;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const step = Math.max(200, scroller.clientHeight || 400);
      // Each position draws its batch over a few timer ticks; moving on early
      // leaves gaps, so wait until the count stops growing.
      const scrollTo = async (top) => {
        scroller.scrollTop = Math.max(0, Math.min(top, max));
        scroller.dispatchEvent(new Event('scroll'));
        let n = slides().length;
        let since = performance.now();
        const stop = performance.now() + 3000;
        while (performance.now() < stop) {
          await pause(100);
          const m = slides().length;
          if (m !== n) {
            n = m;
            since = performance.now();
          } else if (performance.now() - since >= 600) break;
        }
      };
      for (let top = 0; slides().length < total; top += step) {
        progress(`loading filmstrip ${slides().length}/${total}`);
        await scrollTo(top);
        if (top >= max) break;
      }
      // Then go back to any slot still empty.
      const t = thumbs();
      const pitch = t.length > 1 ? t[1].y - t[0].y : 0;
      for (let pass = 0; pitch > 0 && pass < 2 && slides().length < total; pass++) {
        const have = new Set(thumbs().map((x) => Math.round((x.y - t[0].y) / pitch)));
        for (let i = 0; i < total && slides().length < total; i++) {
          if (have.has(i)) continue;
          progress(`loading filmstrip ${slides().length}/${total}`);
          await scrollTo(t[0].y + i * pitch - (scroller.clientHeight || 400) / 2);
          for (const x of thumbs()) have.add(Math.round((x.y - t[0].y) / pitch));
        }
      }
      scroller.scrollTop = start;
      scroller.dispatchEvent(new Event('scroll'));
    }
    filmstripSettled = true;
    return slides();
  }

  const BULLET_GLYPH = /^[●○■□◆◇►▶➢➤✓✔•◦▪▫‣⁃–-]$|^(\d+|[a-z]|[ivxlc]+)[.)]$/i;
  const PROMPT = /^Click to add (title|subtitle|text|speaker notes)$/i;

  /** Words a shape draws, without bullet glyphs; the SVG drops the spaces between words. */
  function drawnWords(el) {
    return [...el.querySelectorAll('text')].map((t) => t.textContent || '').filter((w) => w && !BULLET_GLYPH.test(w.trim()));
  }

  /** The shapes on a page, in z-order: [{index (1-based), objectId, el, text, prompt}]. */
  function shapesOn(pageId) {
    const page = document.getElementById(`editor-${pageId}`);
    if (!page) return [];
    const out = [];
    for (const g of page.children) {
      if (!g.id || !g.id.startsWith('editor-') || g.id === `editor-${pageId}-bg`) continue;
      const words = drawnWords(g);
      const joined = norm(words.join(' '));
      const prompt = PROMPT.test(joined) ? joined.match(PROMPT)[1].toLowerCase() : null;
      out.push({ index: out.length + 1, objectId: g.id.slice('editor-'.length), el: g, text: prompt ? '' : joined, prompt });
    }
    return out;
  }

  const describeShape = (s) => ({ index: s.index, objectId: s.objectId, text: s.text.slice(0, 200), ...(s.prompt ? { emptyPlaceholder: s.prompt } : {}) });

  function hitArea(el) {
    return el.querySelector('path[pointer-events="visiblePainted"]') || el.querySelector('path, rect, image') || el;
  }

  /** Leave text editing and drop any selection (Escape twice), so the next action starts from the slide. */
  async function leaveText() {
    await press('Escape');
    await press('Escape');
  }

  async function gotoSlide(spec) {
    const list = await settledSlides();
    if (!list.length) fail('not_ready', 'the filmstrip has no slides yet');
    let target;
    if (spec.page) target = list.find((s) => s.pageId === spec.page);
    else {
      const n = Number(spec.index);
      target = list[n === -1 ? list.length - 1 : n - 1];
    }
    if (!target) {
      fail('slide_not_found', spec.page ? `no slide with page id ${spec.page}` : `slide ${spec.index} does not exist; the presentation has ${list.length} slide(s)`);
    }
    if (currentPage() === target.pageId) return target;
    await leaveText();
    const thumb = thumbs().find((t) => t.pageId === target.pageId)?.el;
    if (thumb) {
      mouse(hitArea(thumb), CLICK, 'center');
      if (await waitFor(() => currentPage() === target.pageId, 3000)) return target;
    }
    location.hash = `slide=id.${target.pageId}`;
    if (await waitFor(() => currentPage() === target.pageId, 4000)) return target;
    fail('goto_failed', `could not open slide ${target.index}`);
  }

  function resolveShape(spec) {
    const pageId = currentPage();
    const shapes = shapesOn(pageId);
    if (!shapes.length) fail('shape_not_found', 'this slide has no shapes');
    let s = null;
    if (spec.id) s = shapes.find((x) => x.objectId === spec.id);
    else if (spec.index !== undefined) s = shapes[Number(spec.index) === -1 ? shapes.length - 1 : Number(spec.index) - 1];
    else if (spec.role) {
      const role = spec.role === 'body' ? 'text' : spec.role;
      s = shapes.find((x) => x.prompt === role) || null;
      if (!s) {
        fail(
          'shape_not_found',
          `no empty ${spec.role} placeholder on this slide (filled placeholders are found by id: read the deck with slides_read, then pass the shape's index or id); shapes: ${JSON.stringify(shapes.map(describeShape))}`
        );
      }
    } else if (spec.contains) {
      const want = squash(spec.contains);
      const hits = shapes.filter((x) => squash(x.text).includes(want));
      s = hits[(spec.occurrence || 1) - 1] || null;
    }
    if (!s) fail('shape_not_found', `no shape matches ${JSON.stringify(spec)} on this slide; shapes: ${JSON.stringify(shapes.map(describeShape))}`);
    return { ...s, pageId };
  }

  /** Select a whole shape (not its text). */
  async function selectShape(spec) {
    const s = resolveShape(spec);
    await leaveText();
    mouse(hitArea(s.el), CLICK, 'center');
    await pause(200);
    if (!copySelection().shapes) {
      await pause(300);
      if (!copySelection().shapes) fail('select_failed', `could not select shape ${s.index} (${s.objectId})`);
    }
    return s;
  }

  /**
   * Put the caret in the selected shape's text and select all of it. Returns
   * the exact text. Refuses (and changes nothing) when the selection turns
   * out to be shapes rather than text.
   */
  async function selectAllText() {
    await press('a', { mod: true });
    await pause(80);
    const c = copySelection();
    if (c.shapes) {
      await leaveText();
      fail('not_in_text', 'select-all selected shapes instead of text, so the caret was not in a text box; nothing was changed');
    }
    return c.text.replace(/\n$/, '');
  }

  async function enterText(s) {
    await press('Enter');
    await pause(150);
    const text = await selectAllText();
    return { ...s, text };
  }

  // ---------------------------------------------------------------- toolbar

  function ariaLabel(prefix) {
    return document.querySelector(`[aria-label^="${prefix}"]`)?.getAttribute('aria-label') || '';
  }

  function toolbar() {
    const pressed = (id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'true';
    const size = Number(document.querySelector('input[aria-label="Font size"], #fontSizeSelect input')?.value) || Number((ariaLabel('Font size list').match(/([\d.]+) selected/) || [])[1]) || null;
    return {
      font: (ariaLabel('Font list').match(/Font list\. (.*) selected/) || [])[1] || null,
      size,
      bold: pressed('boldButton'),
      italic: pressed('italicButton'),
      underline: pressed('underlineButton'),
      list: pressed('addChecklistButton') ? 'checklist' : pressed('addNumberedBulletButton') ? 'numbered' : pressed('addBulletButton') ? 'bullet' : null,
    };
  }

  /** The toolbar follows the caret on a timer, which hidden tabs align to 1s. */
  async function settledToolbar() {
    await pause(1100);
    return toolbar();
  }

  // ------------------------------------------------------ menus and palettes

  function openMenus() {
    return [...document.querySelectorAll('.goog-menu')].filter((m) => m.style.display !== 'none' && getComputedStyle(m).display !== 'none');
  }

  function itemLabel(item) {
    const palette = item.querySelector('.punch-layouts-palette-label');
    if (palette) return norm(palette.textContent);
    return norm((item.querySelector('.goog-menuitem-label') || item).textContent.replace(/►/g, ''));
  }

  function menuItems() {
    return openMenus().flatMap((m) => [...m.querySelectorAll('.goog-menuitem, .goog-palette-cell')]);
  }

  function findItem(label) {
    const want = norm(label).toLowerCase();
    const items = menuItems();
    return items.find((i) => itemLabel(i).toLowerCase() === want) || items.find((i) => itemLabel(i).toLowerCase().startsWith(want)) || null;
  }

  async function closeMenus() {
    for (let i = 0; i < 4 && openMenus().length; i++) {
      key(document.activeElement || document.body, 'Escape');
      await pause(80);
    }
    requireEditor().focus();
  }

  /** Walk the menu bar: "Slide > Apply layout > Title and body". See docs-page.js menu(). */
  async function menu(path, { checked } = {}) {
    const parts = (Array.isArray(path) ? path : String(path).split('>')).map((p) => norm(p)).filter(Boolean);
    if (parts.length < 2) fail('bad_args', 'a menu path needs at least two levels, e.g. "Slide > Duplicate slide"');
    const top = [...document.querySelectorAll('#docs-menubar .menu-button, #docs-menubar [role="menuitem"]')].find((m) => norm(m.textContent).toLowerCase() === parts[0].toLowerCase());
    if (!top) {
      const names = [...document.querySelectorAll('#docs-menubar .menu-button')].map((m) => norm(m.textContent));
      fail('menu_not_found', `no top-level menu ${JSON.stringify(parts[0])}; menus are ${names.join(', ')}`);
    }
    mouse(top, ['mousedown']);
    if (!(await waitFor(() => openMenus().length, 2000))) fail('menu_failed', `the ${parts[0]} menu did not open`);
    for (let i = 1; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const item = await waitFor(() => findItem(parts[i]), 1500);
      if (!item) {
        const available = menuItems().map(itemLabel).filter(Boolean);
        await closeMenus();
        fail('menu_not_found', `no menu item ${JSON.stringify(parts[i])} under ${parts.slice(0, i).join(' > ')}; available: ${[...new Set(available)].slice(0, 40).join(' | ')}`);
      }
      if (item.classList.contains('goog-menuitem-disabled') || item.getAttribute('aria-disabled') === 'true') {
        await closeMenus();
        fail('menu_disabled', `${parts.slice(0, i + 1).join(' > ')} is disabled here`);
      }
      if (!last) {
        const before = openMenus().length;
        mouse(item, ['mouseover', 'mousedown', 'mouseup']);
        await waitFor(() => openMenus().length > before, 1500);
        continue;
      }
      if (checked !== undefined) {
        const isOn = item.classList.contains('goog-option-selected') || item.getAttribute('aria-checked') === 'true';
        if (isOn === !!checked) {
          await closeMenus();
          return { changed: false, label: itemLabel(item) };
        }
      }
      mouse(item, ['mouseover', 'mousedown', 'mouseup', 'click']);
      await pause(250);
      if (openMenus().length) await closeMenus();
      return { changed: true, label: itemLabel(item) };
    }
    return { changed: true };
  }

  function rgbToHex(rgb) {
    const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') : null;
  }

  async function pickColor(buttonId, color) {
    const btn = document.getElementById(buttonId);
    if (!btn) fail('toolbar_missing', `toolbar button ${buttonId} not found (select text first)`);
    mouse(btn, ['mousedown', 'mouseup']);
    const visibleCells = () =>
      [...document.querySelectorAll('.docs-material-colorpalette-cell, .goog-palette-cell')].filter((c) => {
        const r = c.getBoundingClientRect();
        return (r.width > 0 || c.offsetParent) && !c.querySelector('.punch-layouts-palette-label');
      });
    const cells = await waitFor(() => (visibleCells().length ? visibleCells() : null), 1500);
    if (!cells) fail('palette_failed', 'the colour palette did not open');
    const want = String(color).trim().toLowerCase();
    const hex = /^#?[0-9a-f]{6}$/.test(want) ? (want.startsWith('#') ? want : `#${want}`) : null;
    const labelOfCell = (c) => (c.getAttribute('aria-label') || c.getAttribute('title') || '').trim().toLowerCase();
    const cell =
      cells.find((c) => labelOfCell(c) === want) ||
      (hex && cells.find((c) => rgbToHex(getComputedStyle(c.querySelector('[style*="background"]') || c).backgroundColor) === hex)) ||
      (hex && cells.find((c) => ((c.innerHTML || '').match(/background-color:\s*(rgb[^;"]+|#[0-9a-f]{6})/i) || [])[1]?.toLowerCase() === hex)) ||
      (want === 'none' && cells.find((c) => /none|reset|transparent/.test(labelOfCell(c))));
    if (!cell) {
      const names = [...new Set(cells.map(labelOfCell).filter(Boolean))];
      await closeMenus();
      fail('color_unavailable', `${JSON.stringify(color)} is not a palette colour; use one of: ${names.slice(0, 40).join(', ')}`);
    }
    mouse(cell, ['mouseover', 'mousedown', 'mouseup', 'click']);
    await pause(150);
    if (openMenus().length) await closeMenus();
  }

  async function pickFont(name) {
    const btn = document.querySelector('[aria-label^="Font list"]');
    if (!btn) fail('toolbar_missing', 'font menu not found (select text first)');
    mouse(btn, ['mousedown', 'mouseup']);
    await waitFor(() => openMenus().length, 1500);
    const want = norm(name).toLowerCase();
    const items = openMenus().flatMap((m) => [...m.querySelectorAll('.goog-menuitem')]);
    const item = items.find((i) => itemLabel(i).toLowerCase() === want);
    if (!item) {
      const names = [...new Set(items.map(itemLabel).filter((n) => n && !/^(More fonts|RECENT)$/i.test(n)))];
      await closeMenus();
      fail('font_unavailable', `font ${JSON.stringify(name)} is not in the font menu; available: ${names.slice(0, 30).join(', ')}`);
    }
    mouse(item, ['mouseover', 'mousedown', 'mouseup', 'click']);
    await pause(150);
    if (openMenus().length) await closeMenus();
  }

  // ------------------------------------------------------------- formatting

  const LIST_KEY = { bullet: '8', numbered: '7', checklist: '9' };
  const ALIGN_KEY = { left: 'l', center: 'e', right: 'r', justify: 'j' };

  /** Format the selected text (or the caret's paragraph, for paragraph formats). */
  async function applyFormat(f) {
    const applied = [];
    const needToolbar = ['bold', 'italic', 'underline', 'list', 'size'].some((k) => k in f);
    const tb = needToolbar ? await settledToolbar() : null;
    async function toggle(keyName, current, want, label) {
      if (want && !current) await press(keyName, { mod: true });
      if (!want) {
        if (!current) await press(keyName, { mod: true });
        await press(keyName, { mod: true });
      }
      applied.push(`${label}:${want ? 'on' : 'off'}`);
    }
    if ('bold' in f) await toggle('b', tb.bold, f.bold, 'bold');
    if ('italic' in f) await toggle('i', tb.italic, f.italic, 'italic');
    if ('underline' in f) await toggle('u', tb.underline, f.underline, 'underline');
    if ('strikethrough' in f) {
      await menu(['Format', 'Text', 'Strikethrough'], { checked: !!f.strikethrough });
      applied.push(`strikethrough:${f.strikethrough ? 'on' : 'off'}`);
    }
    if ('superscript' in f) {
      await menu(['Format', 'Text', 'Superscript'], { checked: !!f.superscript });
      applied.push('superscript');
    }
    if ('subscript' in f) {
      await menu(['Format', 'Text', 'Subscript'], { checked: !!f.subscript });
      applied.push('subscript');
    }
    if (f.align) {
      const k = ALIGN_KEY[f.align];
      if (!k) fail('bad_args', 'align must be left, center, right or justify');
      await press(k, { mod: true, shift: true });
      applied.push(`align:${f.align}`);
    }
    if (f.list) {
      const want = f.list === 'none' ? null : f.list;
      if (want && !LIST_KEY[want]) fail('bad_args', 'list must be bullet, numbered, checklist or none');
      // Off first, then on: switching type in place would retype the whole list.
      if (tb.list && tb.list !== want) await press(LIST_KEY[tb.list], { mod: true, shift: true });
      if (want && tb.list !== want) await press(LIST_KEY[want], { mod: true, shift: true });
      applied.push(`list:${f.list}`);
    }
    if (f.indent) {
      const n = Number(f.indent);
      await press(n > 0 ? ']' : '[', { mod: true }, Math.min(Math.abs(n), 10));
      applied.push(`indent:${n}`);
    }
    if (f.size !== undefined) {
      const want = Number(f.size);
      if (!Number.isFinite(want) || want < 1 || want > 400) fail('bad_args', 'size must be a point size between 1 and 400');
      if (!tb.size) fail('size_unknown', 'the toolbar shows no single font size for this selection; select text with one size first');
      const delta = Math.round(want - tb.size);
      if (delta) await press(delta > 0 ? '.' : ',', { mod: true, shift: true }, Math.min(Math.abs(delta), 200));
      applied.push(`size:${want}`);
    }
    if (f.font) {
      await pickFont(f.font);
      applied.push(`font:${f.font}`);
    }
    if (f.color) {
      await pickColor('textColorButton', f.color);
      applied.push(`color:${f.color}`);
    }
    if (f.highlight) {
      await pickColor('bgColorButton', f.highlight);
      applied.push(`highlight:${f.highlight}`);
    }
    if (f.clear) {
      await press('\\', { mod: true });
      applied.push('clear');
    }
    return applied;
  }

  // ---------------------------------------------------------------- typing

  /**
   * Type paragraphs at the caret like a person: each one pasted inline (so it
   * takes the box's own style), lists switched with their shortcuts and
   * nested with Tab. `list` is the list the caret is in now.
   * Paragraph: {html, text, list: 'bullet'|'numbered'|null, level}.
   */
  /**
   * Inline formats still on at the end of pasted HTML. The caret keeps them
   * across Enter (as when a person types), so the next paragraph would come
   * out bold too unless they are toggled off.
   */
  const TOGGLES = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', u: 'underline', s: 'strike', del: 'strike', strike: 'strike' };
  function trailingFormats(html) {
    const tail = String(html || '').match(/(?:<\/[a-z0-9]+>\s*)+$/i)?.[0] || '';
    return new Set([...tail.matchAll(/<\/([a-z0-9]+)>/gi)].map((m) => TOGGLES[m[1].toLowerCase()]).filter(Boolean));
  }

  async function clearSticky(sticky) {
    if (sticky.has('bold')) await press('b', { mod: true });
    if (sticky.has('italic')) await press('i', { mod: true });
    if (sticky.has('underline')) await press('u', { mod: true });
    if (sticky.has('strike')) await press('x', { mod: true, shift: true });
  }

  async function typeParagraphs(paras, { list: startList = null, first = true } = {}) {
    let list = startList;
    let level = 0;
    let sticky = new Set();
    for (let i = 0; i < paras.length; i++) {
      progress(`typing paragraph ${i + 1}/${paras.length}`);
      const p = paras[i];
      if (i > 0 || !first) await press('Enter');
      const want = p.list || null;
      const target = want ? Math.max(0, Math.min(8, p.level || 0)) : 0;
      if (list) {
        // Nest or un-nest while still in the list, then switch list type.
        while (level < target && want) {
          await press('Tab');
          level++;
        }
        while (level > target) {
          await press('Tab', { shift: true });
          level--;
        }
      }
      if (want !== list) {
        // Switching type in place would retype the whole list (every item of
        // it, as in Docs), so leave the current list first; turning the new
        // type on then starts a list of its own.
        if (list) await press(LIST_KEY[list], { mod: true, shift: true });
        if (want) await press(LIST_KEY[want], { mod: true, shift: true });
        list = want;
      }
      if (list) {
        while (level < target) {
          await press('Tab');
          level++;
        }
      } else level = 0;
      await clearSticky(sticky);
      if (p.html) await pasteInline(p.html);
      sticky = trailingFormats(p.html);
    }
    return { list };
  }

  const expectedText = (paras) => paras.map((p) => p.text || stripTags(p.html)).join('\n');

  /**
   * Replace all of the selected text (selectAllText first) with paragraphs,
   * then read the box back through copy and compare.
   */
  async function replaceSelectedText(paras, current) {
    if (current) await press('Backspace');
    if (!paras.length) {
      const left = await selectAllText();
      if (squash(left)) fail('write_mismatch', `the text box still holds ${JSON.stringify(left.slice(0, 120))} after clearing it`);
      return '';
    }
    const tb = await settledToolbar();
    await typeParagraphs(paras, { list: tb.list === 'checklist' ? 'checklist' : tb.list });
    await pause(150);
    const now = await selectAllText();
    if (squash(now) !== squash(expectedText(paras))) {
      fail('write_mismatch', `the text box reads ${JSON.stringify(now.slice(0, 200))} instead of ${JSON.stringify(expectedText(paras).slice(0, 200))}; undo with slides_edit {undo: N} if needed`);
    }
    return now;
  }

  /**
   * Play a human typing plan (extension/lib/typing.js) at the caret.
   * Blocks are paragraphs: {t:'p'|'h'|'li', list, depth, before, keys,
   * cont}. A new paragraph starts with Enter (unless it is the first and the
   * text is empty), its list is switched with the shortcuts and nested with
   * Tab, then its keys play: characters, Backspace, format toggles, and
   * pastes for what a keystroke cannot produce (links, code, emoji). `cont`
   * continues the paragraph the previous run stopped in.
   */
  async function playTyping(blocks, { enterFirst, list: startList, level: startLevel = 0 }) {
    let list = startList;
    let level = startLevel;
    let chars = 0;
    const ed = requireEditor();
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      progress(`typing paragraph ${bi + 1}/${blocks.length}`);
      if (!b.cont) {
        await typingWait(b.before || 0);
        if (bi > 0 || enterFirst) await press('Enter');
        const want = b.t === 'li' ? b.list || 'bullet' : null;
        const target = want ? Math.max(0, Math.min(8, b.depth || 0)) : 0;
        if (list) {
          while (level < target && want) {
            await press('Tab');
            level++;
          }
          while (level > target) {
            await press('Tab', { shift: true });
            level--;
          }
        }
        if (want !== list) {
          if (list) await press(LIST_KEY[list], { mod: true, shift: true });
          if (want) await press(LIST_KEY[want], { mod: true, shift: true });
          list = want;
        }
        if (list) {
          while (level < target) {
            await press('Tab');
            level++;
          }
        } else level = 0;
      }
      for (const e of b.keys || []) {
        await typingWait(e.d);
        ed.focus();
        if (e.c !== undefined) {
          typeChar(ed, e.c);
          chars++;
        } else if (e.k === 'Backspace') {
          key(ed, 'Backspace');
          chars--;
        } else if (e.f) {
          const [name, mods] = TOGGLE_KEYS[e.f] || [];
          if (name) key(ed, name, { mod: true, ...mods });
        } else if (e.p !== undefined) {
          await paste(e.p, e.x);
          chars += [...(e.x || '')].length;
        }
      }
    }
    return { chars, list, level };
  }

  /** Put the caret in the current slide's speaker notes. */
  async function focusNotes() {
    await leaveText();
    await press('s', { mod: true, alt: true, shift: true });
    await pause(300);
  }

  // ------------------------------------------------------------ slide ops

  async function newSlide({ layout } = {}) {
    await leaveText();
    const before = new Set(slides().map((s) => s.pageId));
    await press('m', { ctrl: true });
    const added = await waitFor(() => slides().find((s) => !before.has(s.pageId)), 5000);
    if (!added) fail('new_slide_failed', 'Ctrl+M did not add a slide');
    await waitFor(() => currentPage() === added.pageId, 3000);
    if (currentPage() !== added.pageId) await gotoSlide({ page: added.pageId });
    let applied = null;
    if (layout) applied = await applyLayout(layout);
    const now = slides().find((s) => s.pageId === added.pageId);
    return { pageId: added.pageId, index: now?.index ?? added.index, layout: applied };
  }

  async function applyLayout(name) {
    await leaveText();
    const before = shapesOn(currentPage()).map((s) => s.objectId).join(',');
    const r = await menu(['Slide', 'Apply layout', name]);
    await waitFor(() => shapesOn(currentPage()).map((s) => s.objectId).join(',') !== before, 3000);
    return r.label || name;
  }

  /**
   * Run a Slide menu command on the current slide. Some (Move slide) are
   * disabled unless the slide is selected in the filmstrip, so select its
   * thumbnail first, as a person would.
   */
  async function slideMenu(item, extra, opts) {
    await leaveText();
    const page = currentPage();
    const thumb = thumbs().find((t) => t.pageId === page)?.el;
    if (thumb) {
      mouse(hitArea(thumb), CLICK, 'center');
      await pause(150);
    }
    return menu(['Slide', item, ...(extra ? [extra] : [])], opts);
  }

  // ---------------------------------------------------------- find/replace

  const FIND = /Find and replace/i;

  function findDialog() {
    return [...document.querySelectorAll('[role="dialog"]')].find((d) => FIND.test(d.textContent || '')) || null;
  }

  function setInput(input, value) {
    input.focus();
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function checkboxLabel(box) {
    let el = box;
    let label = '';
    while (el.parentElement && el.parentElement.querySelectorAll('input[type="checkbox"]').length === 1) {
      el = el.parentElement;
      label = el.textContent || '';
    }
    return label.trim();
  }

  function setCheckbox(dialog, labelPattern, on) {
    for (const box of dialog.querySelectorAll('input[type="checkbox"]')) {
      if (labelPattern.test(checkboxLabel(box)) && box.checked !== !!on) box.click();
    }
  }

  /**
   * Open Find and replace from the Edit menu. In a hidden tab Cmd+Shift+H
   * never creates the dialog (seen live), while the menu command does.
   */
  async function openFind() {
    await leaveText();
    await menu(['Edit', 'Find and replace']);
    const dialog = await waitFor(findDialog, 5000);
    if (!dialog) fail('no_dialog', 'could not open Find and replace');
    return dialog;
  }

  function matchCount(dialog) {
    for (const el of dialog.querySelectorAll('*')) {
      if (el.childElementCount) continue;
      const m = (el.textContent || '').trim().match(/^(\d+)\s+of\s+(\d+)$/);
      if (m) return { current: Number(m[1]), total: Number(m[2]) };
    }
    return { current: 0, total: 0 };
  }

  async function search(dialog, find, { matchCase = false, regex = false } = {}, retried = false) {
    setCheckbox(dialog, /^Match case/i, matchCase);
    setCheckbox(dialog, /regular expressions/i, regex);
    const [findInput] = dialog.querySelectorAll('input[type="text"]');
    setInput(findInput, '');
    await waitFor(() => matchCount(dialog).total === 0, 1500);
    setInput(findInput, find);
    const hit = await waitFor(() => matchCount(dialog).total > 0, 3500);
    if (hit) return matchCount(dialog);
    if (!retried) {
      await closeDialog(dialog);
      return search(await openFind(), find, { matchCase, regex }, true);
    }
    return { current: 0, total: 0 };
  }

  function button(dialog, label) {
    return [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label);
  }

  /** Close the dialog in a hidden tab, where its close transition never ends on its own (see docs-page.js). */
  async function closeDialog(dialog) {
    const input = dialog.querySelector('input[type="text"]');
    if (input) key(input, 'Escape');
    await pause(50);
    const surface = dialog.closest('.appsElementsPositionedSurfaceContainer') || dialog;
    for (const el of [surface, ...surface.querySelectorAll('*')].slice(0, 80)) {
      el.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true, propertyName: 'opacity' }));
      el.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
    }
    await pause(150);
    requireEditor().focus();
  }

  /** Step the dialog to match `want` (1-based). */
  async function stepTo(dialog, want, total) {
    const next = button(dialog, 'Next');
    let current = matchCount(dialog).current;
    for (let guard = 0; next && current !== want && guard <= total + 1; guard++) {
      next.click();
      const moved = await waitFor(() => {
        const c = matchCount(dialog).current;
        return c !== current ? c : 0;
      }, 3000);
      if (!moved) break;
      current = moved;
    }
    return current === want;
  }

  // --------------------------------------------------------- text selection

  /**
   * Select `text` inside the text the caret is in: select-all reads the exact
   * text, then the caret goes to the start and Shift+ArrowRight extends over
   * the match. Offsets count line breaks as one character, as the editor does.
   */
  async function selectText({ text, occurrence = 1, matchCase = false }) {
    const all = await selectAllText();
    const hay = matchCase ? all : all.toLowerCase();
    const needle = matchCase ? String(text) : String(text).toLowerCase();
    const hits = [];
    for (let i = hay.indexOf(needle); i !== -1 && needle; i = hay.indexOf(needle, i + needle.length)) hits.push(i);
    if (!hits.length) fail('text_not_found', `${JSON.stringify(text)} is not in this text box (it reads ${JSON.stringify(all.slice(0, 200))})`);
    const at = hits[occurrence === -1 ? hits.length - 1 : occurrence - 1];
    if (at === undefined) fail('bad_occurrence', `occurrence ${occurrence} requested but the text appears ${hits.length} time(s) in this box`);
    await press('ArrowLeft');
    if (at) await press('ArrowRight', {}, at);
    await press('ArrowRight', { shift: true }, String(text).length);
    const got = copySelection();
    if (got.shapes || got.text.replace(/\n$/, '') !== all.slice(at, at + String(text).length)) {
      fail('select_failed', `selected ${JSON.stringify(got.text.slice(0, 80))} instead of ${JSON.stringify(text)}`);
    }
    return { matches: hits.length, offset: at };
  }

  // ------------------------------------------------------------ step runner

  /**
   * Run steps in order. Selection steps (slide, shape, editText, selectText,
   * caret, notesFocus, escape) move; the rest change the deck. Each result
   * records where it acted (pageId, objectId) so the extension can check the
   * saved deck afterwards.
   */
  async function runSteps(steps) {
    requireEditable();
    await dismissPopups();
    await settledSlides();
    const results = [];
    let shape = null; // the shape whose text the caret is in, or that is selected
    let inText = false;
    let inNotes = false;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const kind = Object.keys(s).find((k) => !['mods', 'times'].includes(k));
      progress(`step ${i + 1}: ${kind}`);
      const r = { step: i + 1, action: kind };
      try {
        switch (kind) {
          case 'slide': {
            const t = await gotoSlide(s.slide);
            shape = null;
            inText = inNotes = false;
            Object.assign(r, { slide: t.index, pageId: t.pageId });
            break;
          }
          case 'newSlide': {
            const t = await newSlide(s.newSlide || {});
            shape = null;
            inText = inNotes = false;
            Object.assign(r, t, { shapes: shapesOn(t.pageId).map(describeShape) });
            break;
          }
          case 'layout': {
            r.layout = await applyLayout(s.layout);
            r.pageId = currentPage();
            r.shapes = shapesOn(r.pageId).map(describeShape);
            shape = null;
            inText = inNotes = false;
            break;
          }
          case 'shape': {
            shape = await selectShape(s.shape);
            inText = inNotes = false;
            Object.assign(r, { pageId: shape.pageId, objectId: shape.objectId, index: shape.index });
            break;
          }
          case 'editText': {
            if (!shape) fail('no_shape', 'select a shape first ({shape: …})');
            shape = await enterText(shape);
            inText = true;
            Object.assign(r, { objectId: shape.objectId, text: shape.text.slice(0, 200) });
            break;
          }
          case 'setText': {
            if (inNotes) fail('bad_args', 'setText writes into a shape; use notes for speaker notes');
            if (!shape) fail('no_shape', 'select a shape first ({shape: …})');
            if (!inText) shape = await enterText(shape);
            else shape = { ...shape, text: await selectAllText() };
            const text = await replaceSelectedText(s.setText, shape.text);
            inText = true;
            Object.assign(r, { pageId: shape.pageId, objectId: shape.objectId, index: shape.index, text });
            break;
          }
          case 'notes': {
            await focusNotes();
            const current = await selectAllText();
            const text = await replaceSelectedText(s.notes, current);
            shape = null;
            inText = true;
            inNotes = true;
            Object.assign(r, { pageId: currentPage(), notes: text });
            break;
          }
          case 'notesFocus': {
            await focusNotes();
            const current = await selectAllText();
            await press('ArrowRight');
            shape = null;
            inText = inNotes = true;
            Object.assign(r, { pageId: currentPage(), text: current.slice(0, 200) });
            break;
          }
          case 'selectText': {
            if (!inText) {
              if (!shape) fail('no_shape', 'select a shape (or notesFocus) before selectText');
              shape = await enterText(shape);
              inText = true;
            }
            Object.assign(r, await selectText(s.selectText));
            break;
          }
          case 'caret': {
            if (!inText) {
              if (!shape) fail('no_shape', 'select a shape (or notesFocus) before moving the caret');
              shape = await enterText(shape);
              inText = true;
            }
            await selectAllText();
            await press(s.caret === 'start' ? 'ArrowLeft' : 'ArrowRight');
            break;
          }
          case 'text': {
            if (!inText) fail('not_in_text', 'put the caret in text first (editText, selectText, caret or notesFocus); a paste on the slide itself would create a new text box');
            const c = copySelection();
            if (c.shapes) fail('not_in_text', 'shapes are selected, not text; nothing was typed');
            await pasteInline(s.text);
            r.typed = stripTags(s.text).slice(0, 120);
            if (shape) r.objectId = shape.objectId;
            r.pageId = currentPage();
            break;
          }
          case 'typeText': {
            // Human typing into the selected shape (or the notes, after notesFocus).
            const t = s.typeText;
            if (!inText) {
              if (!shape) fail('no_shape', 'select a shape (or notesFocus) before typeText');
              shape = await enterText(shape);
              inText = true;
            }
            const existing = await selectAllText();
            if (t.mode === 'replace') {
              if (existing) await press('Backspace');
            } else {
              await press('ArrowRight');
            }
            const tb = await settledToolbar();
            const startsParagraph = !t.blocks[0]?.cont;
            const played = await playTyping(t.blocks, {
              enterFirst: t.mode !== 'replace' && startsParagraph && !!squash(existing),
              list: tb.list,
              level: t.level || 0,
            });
            Object.assign(r, { pageId: currentPage(), typed: String(t.text || '').slice(0, 300), chars: played.chars });
            if (shape) Object.assign(r, { objectId: shape.objectId, index: shape.index });
            break;
          }
          case 'insert': {
            if (!inText) fail('not_in_text', 'put the caret in text first (editText, selectText, caret or notesFocus)');
            const tb = await settledToolbar();
            await typeParagraphs(s.insert, { list: tb.list, first: false });
            r.paragraphs = s.insert.length;
            r.typed = expectedText(s.insert).slice(0, 200);
            if (shape) r.objectId = shape.objectId;
            r.pageId = currentPage();
            break;
          }
          case 'format':
            if (!inText && !shape) fail('no_selection', 'select a shape or text before formatting');
            r.applied = await applyFormat(s.format);
            break;
          case 'key': {
            await press(s.key, s.mods || {}, Math.max(1, Math.min(200, s.times || 1)));
            if (s.key === 'Escape') {
              if (inText) inText = inNotes = false;
              else shape = null;
            }
            break;
          }
          case 'escape':
            await leaveText();
            shape = null;
            inText = inNotes = false;
            break;
          case 'menu': {
            const m = await menu(s.menu);
            r.changed = m.changed;
            break;
          }
          case 'deleteSlide': {
            const page = currentPage();
            const n = slides().length;
            if (n <= 1) fail('last_slide', 'a presentation keeps at least one slide');
            await slideMenu('Delete slide');
            if (!(await waitFor(() => !slides().some((x) => x.pageId === page), 4000))) fail('delete_failed', 'the slide is still there');
            Object.assign(r, { deleted: page, slides: slides().length });
            shape = null;
            inText = inNotes = false;
            break;
          }
          case 'duplicateSlide': {
            const before = new Set(slides().map((x) => x.pageId));
            await slideMenu('Duplicate slide');
            const added = await waitFor(() => slides().find((x) => !before.has(x.pageId)), 4000);
            if (!added) fail('duplicate_failed', 'no new slide appeared');
            Object.assign(r, { pageId: added.pageId, index: added.index });
            shape = null;
            inText = inNotes = false;
            break;
          }
          case 'moveSlide': {
            const page = currentPage();
            const label = { up: 'Move slide up', down: 'Move slide down', start: 'Move slide to beginning', end: 'Move slide to end' }[s.moveSlide];
            if (!label) fail('bad_args', 'moveSlide must be up, down, start or end');
            const from = slides().find((x) => x.pageId === page)?.index;
            await slideMenu('Move slide', label);
            await waitFor(() => slides().find((x) => x.pageId === page)?.index !== from, 3000);
            Object.assign(r, { pageId: page, from, to: slides().find((x) => x.pageId === page)?.index });
            break;
          }
          case 'skipSlide': {
            r.changed = (await slideMenu('Skip slide', null, { checked: !!s.skipSlide })).changed;
            r.pageId = currentPage();
            break;
          }
          case 'undo':
            await press('z', { mod: true }, Math.max(1, Math.min(50, s.undo)));
            break;
          case 'redo':
            await press('y', { mod: true }, Math.max(1, Math.min(50, s.redo)));
            break;
          default:
            fail('bad_args', `unknown step ${JSON.stringify(kind)}`);
        }
      } catch (err) {
        err.message = `step ${i + 1} (${kind || '?'}): ${err.message}`;
        err.completed = results;
        throw err;
      }
      results.push(r);
    }
    if (inText || shape) await leaveText();
    return { results, slides: slides(), page: currentPage() };
  }

  // -------------------------------------------------------------------- ops

  async function run() {
    progress(op);
    switch (op) {
      case 'state': {
        const ed = editor();
        const text = ed ? '' : (document.body?.textContent || '').slice(0, 4000);
        const list = ed ? slides() : [];
        const page = ed ? currentPage() : null;
        return {
          ready: !!ed && list.length > 0 && !!page,
          docId: (location.pathname.match(/\/presentation\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/) || [])[1] || null,
          title: document.querySelector('input.docs-title-input')?.value || document.title.replace(/ - Google Slides$/, ''),
          url: location.href,
          signedOut: /accounts\.google\.com/.test(location.host),
          accessDenied: !ed && /You need access|Request access|You need permission/i.test(text),
          notFound: !ed && /file you have requested does not exist|Sorry, unable to open the file/i.test(text),
          slideCount: list.length,
          page,
          ...(ed ? isEditable() : { editable: false, reason: 'loading' }),
        };
      }

      case 'slides': {
        requireEditor();
        const list = await settledSlides();
        const page = currentPage();
        return { slides: list, page, shapes: shapesOn(page).map(describeShape) };
      }

      case 'run':
        return runSteps(args.steps || []);

      case 'dismiss':
        return { closed: await dismissPopups(Number(args.wait) || 0) };

      case 'saved': {
        const label = () => document.querySelector('#docs-save-indicator-badge')?.getAttribute('aria-label') || '';
        const ok = await waitFor(() => /Saved to Drive|All changes saved/i.test(label()), Number(args.timeout) || 15000, 200);
        return { saved: !!ok, status: label().replace(/^Document status:\s*/i, '') || null };
      }

      case 'title': {
        const input = document.querySelector('input.docs-title-input');
        if (!input) fail('no_title', 'title field not found');
        const title = String(args.title || '').trim();
        if (!title) fail('bad_args', 'title is empty');
        requireEditable();
        let done = null;
        // A Docs-style commit: click → input → Enter → blur. Retried once
        // because a popup opening mid-way can swallow the Enter.
        for (let attempt = 0; attempt < 2 && !done; attempt++) {
          await dismissPopups();
          input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          input.focus();
          input.select();
          setInput(input, title);
          key(input, 'Enter');
          await pause(200);
          input.dispatchEvent(new FocusEvent('blur'));
          input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
          done = await waitFor(() => document.title.startsWith(`${title} - `), 4000);
        }
        return { title, verified: !!done };
      }

      case 'replace': {
        const { find, replace = '', matchCase = false, regex = false, occurrence = null } = args;
        if (!find) fail('bad_args', 'find is empty');
        requireEditable();
        await dismissPopups();
        await leaveText();
        const dialog = await openFind();
        const count = await search(dialog, String(find), { matchCase, regex });
        if (!count.total) {
          await closeDialog(dialog);
          return { replaced: 0, matches: 0 };
        }
        setInput(dialog.querySelectorAll('input[type="text"]')[1], String(replace));
        await pause(60);
        if (occurrence) {
          const want = occurrence === -1 ? count.total : occurrence;
          if (want < 1 || want > count.total) {
            await closeDialog(dialog);
            fail('bad_occurrence', `occurrence ${occurrence} requested but the text appears ${count.total} time(s)`);
          }
          if (!(await stepTo(dialog, want, count.total))) {
            await closeDialog(dialog);
            fail('find_failed', `could not step to occurrence ${want} of ${count.total}`);
          }
          const one = button(dialog, 'Replace');
          if (!one) fail('no_button', 'the Replace button was not found');
          one.click();
          await waitFor(() => matchCount(dialog).total !== count.total, 3000);
          await closeDialog(dialog);
          return { replaced: 1, matches: count.total };
        }
        const all = button(dialog, 'Replace all');
        if (!all) fail('no_button', 'the Replace all button was not found');
        all.click();
        await waitFor(() => matchCount(dialog).total === 0, 3000);
        await closeDialog(dialog);
        return { replaced: count.total, matches: count.total };
      }

      default:
        fail('bad_args', `unknown page op: ${op}`);
    }
  }

  try {
    return { ok: true, ...(await run()) };
  } catch (err) {
    return {
      ok: false,
      code: err.code || 'page_error',
      message: err.message || String(err),
      ...(err.completed ? { completed: err.completed } : {}),
    };
  }
}
