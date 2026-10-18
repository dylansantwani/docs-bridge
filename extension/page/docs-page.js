/**
 * Everything that runs inside a Google Docs editor tab.
 *
 * `docsPageOp` is injected with chrome.scripting.executeScript({func, world:
 * 'MAIN'}), which serialises the function's source. So it must be fully
 * self-contained: no imports, no closures over module scope, every helper
 * declared inside it. test/page.test.js compiles the source on its own to
 * enforce that.
 *
 * The approach is to operate Docs the way a person does — select text, press
 * shortcuts, use the menus and toolbar, type — because that is the only
 * surface that gives full editing power without an API. What was established
 * live against docs.google.com (2026-09-29), and why each technique is used:
 *
 *   - Input goes to the hidden contenteditable inside
 *     `iframe.docs-texteventtarget-iframe`. Docs handles a synthetic `paste`
 *     ClipboardEvent there (text/html from our DataTransfer) and untrusted
 *     keydown events: caret movement, selection extension, delete, undo, and
 *     formatting shortcuts (bold, italic, underline, strikethrough, lists,
 *     alignment, indent, paragraph styles, font size steps, page break).
 *   - Typing like a person keeps a document's own look. Inline HTML pasted
 *     into a paragraph inherits that paragraph's style (a template's fonts and
 *     colours), and a paragraph given "Heading 2" with Cmd+Alt+2 takes the
 *     document's Heading 2. Pasting block HTML instead imports the browser's
 *     default heading/paragraph look as explicit overrides. So content is
 *     "typed" block by block (typeBlocks); only tables, rules and images are
 *     pasted as blocks.
 *   - The menu bar and toolbar are Closure widgets that respond to synthetic
 *     mouse events, even in a hidden tab: any menu command (Format > Table >
 *     Insert row below, Paragraph styles > Title), the font menu, the colour
 *     palettes. Toolbar ARIA state reports the caret's style, font, size,
 *     bold/italic/underline and list type, about a second after it moves.
 *   - All of it works in a hidden, unfocused tab, so the bridge never pulls a
 *     tab to the front. Chrome clamps timers in hidden tabs to one wake-up per
 *     second, so nothing here waits on setTimeout: pauses yield through a
 *     MessageChannel. After five minutes hidden, Docs' own timers slow to one a
 *     minute and Find stops answering, which is why the extension only drives
 *     tabs it opened in the last few minutes.
 *   - Text anchors come from Docs' Find and replace (Cmd+Shift+H): stepping to
 *     a match and pressing Escape leaves it selected in the document. See
 *     openFind / closeDialog for the hidden-tab details that make it reliable.
 *   - The saved server state is readable same-origin at /mobilebasic, with
 *     formatting as inline styles; writes are verified against it.
 *
 * Every op resolves to {ok:true, ...} or {ok:false, code, message}; it never
 * throws, because a rejection from an injected function does not survive
 * executeScript intact.
 *
 * @param {string} op
 * @param {object} args
 */
export async function docsPageOp(op, args = {}) {
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

  /**
   * What this op is doing, for the extension's watchdog (tabs.js): `label`
   * names the step and `beat` ticks while the op is making progress. An op
   * stuck on something that never answers stops beating.
   */
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

  const SAVED_READ_MS = 20_000;

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
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

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
    if (!el) fail('not_ready', 'the Docs editor is not loaded in this tab');
    return el;
  }

  /**
   * Dispatch a key chord. `mod` is Cmd on macOS and Ctrl elsewhere; `para`
   * is the paragraph-navigation modifier (Alt on macOS, Ctrl elsewhere).
   */
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
    const meta = (mods.mod && isMac) || !!mods.meta;
    const ctrl = (mods.mod && !isMac) || (mods.para && !isMac) || !!mods.ctrl;
    const alt = (mods.para && isMac) || !!mods.alt;
    const init = {
      key: name,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      shiftKey: !!mods.shift,
      altKey: alt,
      metaKey: meta,
      ctrlKey: ctrl,
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
      await pause(70);
    }
  }

  // ----------------------------------------------------------------- paste

  async function paste(html, text) {
    const ed = requireEditor();
    ed.focus();
    const dt = new DataTransfer();
    if (html) dt.setData('text/html', html);
    dt.setData('text/plain', text ?? '');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ed.dispatchEvent(ev);
    // Docs calls preventDefault once it has consumed an HTML paste. If it did
    // not, the event fell through to a bare contenteditable and nothing
    // reached the document. (Plain-text-only pastes are applied without that
    // signal, which is why every paste here carries HTML.)
    if (!ev.defaultPrevented) fail('paste_ignored', 'Docs did not accept the paste (is the document editable?)');
    await pause(150);
  }

  const stripTags = (html) =>
    decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));

  /** Inline HTML into the current paragraph; inherits the paragraph's style. */
  async function pasteInline(html) {
    if (!html) return;
    await paste(`<span>${html}</span>`, stripTags(html));
  }

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

  // ---------------------------------------------------- saved document

  function docId() {
    const m = location.pathname.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/);
    return m ? m[1] : null;
  }

  function parseCss(style) {
    const out = {};
    // Decode first: mobilebasic writes font-family:&quot;Open Sans&quot;, and
    // the entity's semicolon would otherwise split the declaration.
    for (const part of decodeEntities(String(style || '')).split(';')) {
      const i = part.indexOf(':');
      if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
    return out;
  }

  /** Google wraps links in https://www.google.com/url?q=<target>&... */
  function unwrapLink(href) {
    const h = decodeEntities(href || '');
    const m = h.match(/^https:\/\/www\.google\.com\/url\?q=([^&]+)/);
    if (!m) return h;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }

  /**
   * The saved document as blocks with formatting, from /mobilebasic.
   *
   * DOMParser is not an option: Docs enforces Trusted Types, and parsing a
   * plain string throws in both the main and the isolated world. The markup
   * is machine-generated and flat — styles are inline, spans do not nest — so
   * a regex walk is enough.
   */
  async function savedBlocks() {
    const id = docId();
    if (!id) fail('not_a_doc', 'this tab is not a Google Doc');
    const authuser = new URLSearchParams(location.search).get('authuser');
    const u = location.pathname.match(/^\/document\/u\/(\d+)\//);
    const prefix = u ? `/document/u/${u[1]}` : '/document';
    const url = `${prefix}/d/${id}/mobilebasic${authuser ? `?authuser=${encodeURIComponent(authuser)}` : ''}`;
    // A fetch has no deadline of its own; one that never answers would hang
    // the op, so give up after SAVED_READ_MS.
    const ctl = new AbortController();
    const abortAt = performance.now() + SAVED_READ_MS;
    let settled = false;
    (async () => {
      while (!settled && performance.now() < abortAt) await pause(250);
      if (!settled) ctl.abort();
    })();
    let html;
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctl.signal });
      if (!res.ok) fail('read_failed', `mobilebasic returned HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      if (err instanceof OpError) throw err;
      fail('read_failed', ctl.signal.aborted ? `reading the saved document took over ${SAVED_READ_MS / 1000}s` : `reading the saved document failed: ${err.message}`);
    } finally {
      settled = true;
    }
    const start = html.lastIndexOf('class="doc-content"');
    if (start !== -1) html = html.slice(start);
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const blocks = [];
    const re = /<(p|h[1-6]|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[1].toLowerCase();
      const attrs = m[2];
      const inner = m[3];
      const before = html.slice(0, m.index);
      const inTable = before.lastIndexOf('<table') > before.lastIndexOf('</table>');
      const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
      const pstyle = parseCss((attrs.match(/style="([^"]*)"/) || [])[1]);
      let list = null;
      if (tag === 'li') {
        const open = Math.max(before.lastIndexOf('<ul'), before.lastIndexOf('<ol'));
        const listTag = html.slice(open, html.indexOf('>', open) + 1);
        list = { ordered: listTag.startsWith('<ol'), depth: Number((listTag.match(/lst-kix_[a-z0-9]+-(\d+)/) || [])[1] || 0) };
      }
      const runs = [];
      const runRe = /<span(?: style="([^"]*)")?>([\s\S]*?)<\/span>/gi;
      let r;
      while ((r = runRe.exec(inner))) {
        const href = (r[2].match(/<a [^>]*href="([^"]*)"/) || [])[1];
        const text = stripTags(r[2]).replace(/\u00a0/g, ' ');
        if (!text) continue;
        runs.push({ text, style: { ...pstyle, ...parseCss(r[1]) }, ...(href ? { href: unwrapLink(href) } : {}) });
      }
      const text = runs.length ? runs.map((x) => x.text).join('') : stripTags(inner).replace(/\u00a0/g, ' ');
      blocks.push({ tag, cls: /\btitle\b/.test(cls) ? 'title' : /\bsubtitle\b/.test(cls) ? 'subtitle' : null, text, inTable, list, align: pstyle['text-align'] || null, runs });
    }
    return blocks;
  }

  /**
   * The saved document once it has stopped changing. Drive saves a second or
   * two behind typing, so decisions that depend on the current structure
   * (is the last paragraph empty? how many paragraphs are in this section?)
   * re-read until two reads a moment apart agree. Observed live: a stale read
   * after back-to-back edits typed new text into the previous list item.
   */
  async function settledBlocks(maxWaitMs = 6000) {
    const end = performance.now() + maxWaitMs;
    let prev = JSON.stringify(await savedBlocks());
    for (;;) {
      await pause(800);
      const blocks = await savedBlocks();
      const now = JSON.stringify(blocks);
      if (now === prev || performance.now() >= end) return blocks;
      prev = now;
    }
  }

  function countIn(blocks, needle, matchCase) {
    const text = norm(blocks.map((b) => b.text).join('\n'));
    const hay = matchCase ? text : text.toLowerCase();
    const n = norm(matchCase ? needle : needle.toLowerCase());
    if (!n) return 0;
    let count = 0;
    for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + n.length)) count++;
    return count;
  }

  /**
   * Occurrences of `needle` in the saved document, the way Find counts them
   * (case-insensitive by default). A miss is confirmed against a settled read
   * before it counts, because text typed moments ago may not be saved yet.
   */
  async function savedCount(needle, matchCase) {
    const quick = countIn(await savedBlocks(), needle, matchCase);
    if (quick) return quick;
    return countIn(await settledBlocks(3000), needle, matchCase);
  }

  // ----------------------------------------------------------- editability

  /**
   * Can this session edit? The editor element exists for viewers too, and a
   * signed-out or view-only viewer gets no "View only" badge — the header
   * offers "Request edit access" instead (seen live on a public document). So
   * trust the mode switcher when it is present, then look for the viewer
   * offers, then for the formatting toolbar that only editors get.
   */
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
    if (!document.querySelector('#boldButton, #docs-toolbar')) return { editable: false, reason: 'no editing toolbar', mode: null };
    return { editable: true, mode: mode || null };
  }

  function requireEditable() {
    requireEditor();
    const state = isEditable();
    if (!state.editable) fail('read_only', `this document is not editable here (${state.reason})`);
    return state;
  }

  // ------------------------------------------------------ find and replace

  const FIND = /Find and replace/i;

  /**
   * The Find and replace dialog element, open or not. Whether it is "open"
   * cannot be read from the DOM in a background tab: it stays laid out under a
   * visibility:hidden surface either way, because its animations never run
   * in a hidden tab. So nothing here asks.
   */
  function findDialog() {
    return [...document.querySelectorAll('[role="dialog"]')].find((d) => FIND.test(d.textContent || '')) || null;
  }

  function setInput(input, value) {
    input.focus();
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** The text of the largest ancestor that holds this checkbox and no other. */
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
   * Open or re-activate Find and replace. Always sends Cmd+Shift+H: Escape
   * (which closeDialog needs) deactivates Docs' live search, and a query typed
   * into a deactivated dialog silently never runs.
   */
  async function openFind() {
    await press('h', { mod: true, shift: true });
    const dialog = await waitFor(findDialog, 5000);
    if (!dialog) fail('no_dialog', 'could not open Find and replace');
    return dialog;
  }

  /** "3 of 7" → {current:3, total:7}; no counter shown → zero. */
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
    // The "n of m" counter keeps the previous query's result until the new
    // search finishes, so clear first and wait for it to drop to zero.
    setInput(findInput, '');
    await waitFor(() => matchCount(dialog).total === 0, 1500);
    setInput(findInput, find);
    // A hit shows within about a second: Docs runs the search on a timer, and
    // hidden tabs align timers to one-second boundaries.
    const hit = await waitFor(() => matchCount(dialog).total > 0, 3500);
    if (hit) return matchCount(dialog);
    if (!retried) {
      await press('h', { mod: true, shift: true });
      await pause(300);
      return search(findDialog() || dialog, find, { matchCase, regex }, true);
    }
    return { current: 0, total: 0 };
  }

  function button(dialog, label) {
    return [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label);
  }

  /**
   * Hand the current match to the document. Escape in the find field is what
   * moves the document selection onto the match; focusing the editor with the
   * dialog still active leaves the caret where it was. No frames render in a
   * hidden tab, so the close transition never ends on its own; the events
   * Docs waits for are dispatched by hand so its dialog state can settle.
   */
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

  /**
   * The saved document has the text but Find reports nothing: the dialog has
   * stopped answering. Nothing has been edited at this point, so the
   * extension can safely retry in a fresh tab.
   */
  function stalled(what) {
    fail('find_stalled', `Docs' Find stopped responding while looking for ${JSON.stringify(what)} (nothing was changed)`);
  }

  /** Select the n-th match (1-based; -1 = last). Returns the match count. */
  async function selectAnchor(anchor, occurrence = 1, matchCase = false, regex = false) {
    const present = regex ? null : await savedCount(anchor, matchCase).catch(() => null);
    if (present === 0) fail('anchor_not_found', `text not found in the document: ${JSON.stringify(anchor)}`);
    const dialog = await openFind();
    const count = await search(dialog, anchor, { matchCase, regex });
    if (!count.total) {
      await closeDialog(dialog);
      if (present) stalled(anchor);
      fail('anchor_not_found', `text not found in the document: ${JSON.stringify(anchor)}`);
    }
    const want = occurrence === -1 ? count.total : occurrence;
    if (!Number.isInteger(want) || want < 1 || want > count.total) {
      await closeDialog(dialog);
      fail('bad_occurrence', `occurrence ${occurrence} requested but the text appears ${count.total} time(s)`);
    }
    // The starting match depends on where the caret was, so step from wherever
    // the counter says we are; each click moves it about a second later.
    const next = button(dialog, 'Next');
    let current = matchCount(dialog).current;
    for (let guard = 0; next && current !== want && guard <= count.total; guard++) {
      next.click();
      const moved = await waitFor(() => {
        const c = matchCount(dialog).current;
        return c !== current ? c : 0;
      }, 3000);
      if (!moved) break;
      current = moved;
    }
    if (current !== want) {
      await closeDialog(dialog);
      fail('anchor_select_failed', `could not step to occurrence ${want} of ${count.total}`);
    }
    await closeDialog(dialog);
    return count.total;
  }

  // ------------------------------------------------------------- navigation

  /*
   * Alt+Up (Ctrl+Up off macOS) goes to the start of the paragraph, or to the
   * previous paragraph when already at the start; Alt+Down mirrors that at the
   * end. Going the other way first makes the second move land on the current
   * paragraph's boundary either way (observed live: "insert before" an anchor
   * that began its paragraph jumped into the table above).
   */
  async function toParagraphStart() {
    await press('ArrowDown', { para: true });
    await press('ArrowUp', { para: true });
  }

  async function toParagraphEnd() {
    await press('ArrowUp', { para: true });
    await press('ArrowDown', { para: true });
  }

  const headingLevel = (b) => (b.cls === 'title' ? 0 : b.cls === 'subtitle' ? 0.5 : /^h[1-6]$/.test(b.tag) ? Number(b.tag[1]) : null);

  /**
   * The body of a section: the paragraphs after a heading up to the next
   * heading of the same or higher rank. Returns how many paragraphs to select.
   */
  async function sectionInfo(heading, occurrence = 1) {
    const blocks = await settledBlocks();
    const matches = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => headingLevel(b) !== null && norm(b.text).toLowerCase() === norm(heading).toLowerCase());
    const loose = matches.length
      ? matches
      : blocks.map((b, i) => ({ b, i })).filter(({ b }) => headingLevel(b) !== null && norm(b.text).toLowerCase().includes(norm(heading).toLowerCase()));
    if (!loose.length) {
      const headings = blocks.filter((b) => headingLevel(b) !== null).map((b) => norm(b.text)).filter(Boolean);
      fail('section_not_found', `no heading ${JSON.stringify(heading)}; headings are: ${headings.slice(0, 30).map((h) => JSON.stringify(h)).join(', ')}`);
    }
    const pick = loose[occurrence === -1 ? loose.length - 1 : occurrence - 1];
    if (!pick) fail('bad_occurrence', `occurrence ${occurrence} requested but ${loose.length} heading(s) match`);
    const level = headingLevel(pick.b);
    let end = pick.i + 1;
    while (end < blocks.length) {
      const l = headingLevel(blocks[end]);
      if (l !== null && l <= level) break;
      end++;
    }
    const body = blocks.slice(pick.i + 1, end);
    if (body.some((b) => b.inTable)) fail('unsupported', `section ${JSON.stringify(heading)} contains a table; edit its text with anchors instead`);
    // Mid-document, the last "paragraph" before the next heading is real; at
    // the very end of the document the trailing empty paragraph is part of it.
    return { headingText: pick.b.text, paragraphs: body.length, nonEmpty: body.some((b) => norm(b.text)) };
  }

  /** Select a section's body (after its heading). Leaves the caret at the heading's end when the body is empty. */
  async function selectSection(heading, occurrence = 1) {
    const info = await sectionInfo(heading, occurrence);
    await selectAnchor(info.headingText, 1, true);
    await press('ArrowRight');
    await toParagraphEnd();
    if (!info.paragraphs) return { ...info, selected: false };
    await press('ArrowRight'); // start of the first body paragraph
    await press('ArrowDown', { para: true, shift: true }, info.paragraphs);
    return { ...info, selected: true };
  }

  // ---------------------------------------------------------------- toolbar

  function ariaLabel(prefix) {
    return document.querySelector(`[aria-label^="${prefix}"]`)?.getAttribute('aria-label') || '';
  }

  /** What the toolbar says about the caret or selection. It lags the caret by up to ~1s. */
  function toolbar() {
    const pressed = (id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'true';
    const sizeInput = document.querySelector('input[aria-label="Font size"]');
    const size = Number(sizeInput?.value) || Number((ariaLabel('Font size list').match(/([\d.]+) selected/) || [])[1]) || null;
    return {
      style: (ariaLabel('Styles list').match(/Styles list\. (.*) selected/) || [])[1] || null,
      font: (ariaLabel('Font list').match(/Font list\. (.*) selected/) || [])[1] || norm(fontButton()?.textContent || '') || null,
      size,
      bold: pressed('boldButton'),
      italic: pressed('italicButton'),
      underline: pressed('underlineButton'),
      list: pressed('addChecklistButton') ? 'checklist' : pressed('addNumberedBulletButton') ? 'numbered' : pressed('addBulletButton') ? 'bullet' : null,
    };
  }

  /** Let the toolbar catch up with the caret. It updates on a timer, which hidden tabs align to 1s. */
  async function settledToolbar() {
    await pause(1100);
    return toolbar();
  }

  // ------------------------------------------------------ menus and palettes

  function mouse(el, types) {
    const r = el.getBoundingClientRect();
    for (const t of types) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.x + 3, clientY: r.y + 3 }));
    }
  }

  function openMenus() {
    return [...document.querySelectorAll('.goog-menu')].filter((m) => m.style.display !== 'none' && getComputedStyle(m).display !== 'none');
  }

  function itemLabel(item) {
    return norm((item.querySelector('.goog-menuitem-label') || item).textContent.replace(/►/g, ''));
  }

  function findItem(label) {
    const want = norm(label).toLowerCase();
    const items = openMenus().flatMap((m) => [...m.querySelectorAll('.goog-menuitem')]);
    return items.find((i) => itemLabel(i).toLowerCase() === want) || items.find((i) => itemLabel(i).toLowerCase().startsWith(want)) || null;
  }

  async function closeMenus() {
    for (let i = 0; i < 4 && openMenus().length; i++) {
      key(document.activeElement || document.body, 'Escape');
      await pause(80);
    }
    requireEditor().focus();
  }

  /**
   * Walk the menu bar: "Format > Table > Insert row below". Opens each level
   * with the mouse events a person's click produces. With `checked` set, the
   * final item is only clicked when its check state differs (for toggles such
   * as Format > Text > Strikethrough).
   */
  async function menu(path, { checked } = {}) {
    const parts = (Array.isArray(path) ? path : String(path).split('>')).map((p) => norm(p)).filter(Boolean);
    if (parts.length < 2) fail('bad_args', 'a menu path needs at least two levels, e.g. "Format > Paragraph styles > Title > Apply \'Title\'"');
    const top = [...document.querySelectorAll('#docs-menubar .menu-button, #docs-menubar [role="menuitem"]')].find(
      (m) => norm(m.textContent).toLowerCase() === parts[0].toLowerCase()
    );
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
        const available = openMenus()
          .flatMap((m) => [...m.querySelectorAll('.goog-menuitem')])
          .map(itemLabel)
          .filter(Boolean);
        await closeMenus();
        fail('menu_not_found', `no menu item ${JSON.stringify(parts[i])} under ${parts.slice(0, i).join(' > ')}; available: ${[...new Set(available)].slice(0, 40).join(' | ')}`);
      }
      if (item.classList.contains('goog-menuitem-disabled')) {
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
          return { changed: false };
        }
      }
      mouse(item, ['mouseover', 'mousedown', 'mouseup', 'click']);
      await pause(200);
      if (openMenus().length) await closeMenus();
      return { changed: true };
    }
    return { changed: true };
  }

  function rgbToHex(rgb) {
    const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') : null;
  }

  /**
   * Pick a colour from a toolbar palette by its name ("red", "dark blue 2",
   * "light yellow 3") or by a hex value that one of the swatches has. Returns
   * false (palette closed) when nothing matches.
   */
  async function pickColor(buttonId, color) {
    const btn = document.getElementById(buttonId);
    if (!btn) fail('toolbar_missing', `toolbar button ${buttonId} not found`);
    mouse(btn, ['mousedown', 'mouseup']);
    const visibleCells = () =>
      [...document.querySelectorAll('.docs-material-colorpalette-cell, .goog-palette-cell')].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 || c.offsetParent;
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
      (want === 'none' && cells.find((c) => /none|reset/.test(labelOfCell(c))));
    if (!cell) {
      const names = [...new Set(cells.map(labelOfCell).filter(Boolean))];
      await closeMenus();
      return { ok: false, names };
    }
    mouse(cell, ['mouseover', 'mousedown', 'mouseup', 'click']);
    await pause(150);
    if (openMenus().length) await closeMenus();
    return { ok: true };
  }

  /**
   * The toolbar's font dropdown. Since 2026-10 Docs labels it just "Font"
   * (id docs-font-family, the current font as its text); before that its
   * label was "Font list. <font> selected.".
   */
  function fontButton() {
    return document.querySelector('#docs-font-family') || document.querySelector('[aria-label^="Font list"]');
  }

  async function pickFont(name) {
    const btn = fontButton();
    if (!btn) fail('toolbar_missing', 'font menu not found');
    mouse(btn, ['mousedown', 'mouseup']);
    await waitFor(() => openMenus().length, 1500);
    const want = norm(name).toLowerCase();
    const items = openMenus().flatMap((m) => [...m.querySelectorAll('.goog-menuitem')]);
    const item = items.find((i) => itemLabel(i).toLowerCase() === want);
    if (!item) {
      const names = [...new Set(items.map(itemLabel).filter((n) => n && !/^(More fonts|RECENT)$/i.test(n)))];
      await closeMenus();
      return { ok: false, names };
    }
    mouse(item, ['mouseover', 'mousedown', 'mouseup', 'click']);
    await pause(150);
    if (openMenus().length) await closeMenus();
    return { ok: true };
  }

  // ------------------------------------------------------------- formatting

  /** Set the caret paragraph's style: 0 = Normal text, 1-6 = Heading N (Cmd+Alt+N). */
  async function setStyle(level) {
    await press(String(level), { mod: true, alt: true });
  }

  const LIST_KEY = { bullet: '8', numbered: '7', checklist: '9' };
  const ALIGN_KEY = { left: 'l', center: 'e', right: 'r', justify: 'j' };
  const SPACING = { 1: 'Single', 1.15: '1.15', 1.5: '1.5', 2: 'Double' };

  async function applyStyleName(style) {
    const s = String(style).toLowerCase().replace(/[\s_-]/g, '');
    if (s === 'normal' || s === 'normaltext') return setStyle(0);
    const h = s.match(/^(?:heading|h)([1-6])$/);
    if (h) return setStyle(Number(h[1]));
    if (s === 'title' || s === 'subtitle') {
      const name = s === 'title' ? 'Title' : 'Subtitle';
      return menu(['Format', 'Paragraph styles', name, `Apply '${name}'`]);
    }
    fail('bad_args', `unknown paragraph style ${JSON.stringify(style)}; use normal, heading1-heading6, title or subtitle`);
  }

  /**
   * Apply formatting to the current selection (or caret paragraph). `known`
   * is the selected text when it came from a text match, which lets link,
   * colour and font fall back to re-pasting that text with the style.
   */
  async function applyFormat(f, known) {
    const applied = [];
    const needToolbar = ['bold', 'italic', 'underline', 'list', 'size'].some((k) => k in f);
    const tb = needToolbar ? await settledToolbar() : null;

    async function toggle(keyName, current, want, label) {
      if (want && !current) await press(keyName, { mod: true });
      if (!want) {
        // "Off" on a mixed selection shows as off, so normalise: on, then off.
        if (!current) await press(keyName, { mod: true });
        await press(keyName, { mod: true });
      }
      applied.push(`${label}:${want ? 'on' : 'off'}`);
    }

    async function repaste(styleCss, why) {
      if (!known) fail('need_text', `${why} needs a selection made with {find: ...} so the text is known`);
      await paste(`<span style="${styleCss}">${escapeHtml(known)}</span>`, known);
    }

    if (f.style) {
      await applyStyleName(f.style);
      applied.push(`style:${f.style}`);
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
      if (!k) fail('bad_args', `align must be left, center, right or justify`);
      await press(k, { mod: true, shift: true });
      applied.push(`align:${f.align}`);
    }
    if (f.list) {
      const want = f.list === 'none' ? null : f.list;
      if (want && !LIST_KEY[want]) fail('bad_args', 'list must be bullet, numbered, checklist or none');
      if (!want && tb.list) await press(LIST_KEY[tb.list], { mod: true, shift: true });
      if (want && tb.list !== want) await press(LIST_KEY[want], { mod: true, shift: true });
      applied.push(`list:${f.list}`);
    }
    if (f.indent) {
      const n = Number(f.indent);
      await press(n > 0 ? ']' : '[', { mod: true }, Math.min(Math.abs(n), 10));
      applied.push(`indent:${n}`);
    }
    if (f.lineSpacing !== undefined) {
      const label = SPACING[f.lineSpacing];
      if (!label) fail('bad_args', 'lineSpacing must be 1, 1.15, 1.5 or 2');
      await menu(['Format', 'Line & paragraph spacing', label]);
      applied.push(`lineSpacing:${f.lineSpacing}`);
    }
    if (f.size !== undefined) {
      const want = Number(f.size);
      if (!Number.isFinite(want) || want < 1 || want > 400) fail('bad_args', 'size must be a point size between 1 and 400');
      if (tb.size) {
        // Cmd+Shift+. / , step the size by one point (verified live).
        const delta = Math.round(want - tb.size);
        if (delta) await press(delta > 0 ? '.' : ',', { mod: true, shift: true }, Math.min(Math.abs(delta), 200));
      } else {
        await repaste(`font-size:${want}pt`, 'size');
      }
      applied.push(`size:${want}`);
    }
    if (f.font) {
      const r = await pickFont(f.font);
      if (!r.ok) {
        if (!known) fail('font_unavailable', `font ${JSON.stringify(f.font)} is not in the font menu; available: ${r.names.slice(0, 30).join(', ')}`);
        await repaste(`font-family:'${String(f.font).replace(/'/g, '')}'`, 'font');
      }
      applied.push(`font:${f.font}`);
    }
    for (const [prop, buttonId, css] of [
      ['color', 'textColorButton', 'color'],
      ['highlight', 'bgColorButton', 'background-color'],
    ]) {
      if (!f[prop]) continue;
      const r = await pickColor(buttonId, f[prop]);
      if (!r.ok) {
        if (!known || !/^#?[0-9a-f]{6}$/i.test(f[prop])) {
          fail('color_unavailable', `${prop} ${JSON.stringify(f[prop])} is not a palette colour; use a palette name (${r.names.slice(0, 20).join(', ')}) or a hex value on a {find} selection`);
        }
        await repaste(`${css}:${f[prop].startsWith('#') ? f[prop] : `#${f[prop]}`}`, prop);
      }
      applied.push(`${prop}:${f[prop]}`);
    }
    if (f.link !== undefined) {
      if (!known) fail('need_text', 'link needs a selection made with {find: ...}');
      if (f.link) await paste(`<a href="${escapeHtml(f.link)}">${escapeHtml(known)}</a>`, known);
      else await paste(`<span>${escapeHtml(known)}</span>`, known);
      applied.push(`link:${f.link || 'none'}`);
    }
    if (f.clear) {
      await press('\\', { mod: true });
      applied.push('clear');
    }
    return applied;
  }

  // ---------------------------------------------------------------- typing

  /**
   * Type block content at the caret like a person would, so it takes the
   * document's own styles. The caret must sit in an empty paragraph (or a
   * selection to overwrite). Blocks:
   *   {t:'h', level, html} {t:'p', html} {t:'quote', html} {t:'code', html}
   *   {t:'li', list:'bullet'|'numbered'|'checklist', depth, html}
   *   {t:'table'|'hr'|'img'|'html', html}  — pasted as blocks
   *   {t:'pagebreak'}
   */
  async function typeBlocks(blocks) {
    if (!Array.isArray(blocks) || !blocks.length) fail('bad_args', 'nothing to type');
    const st = await blockState();
    let typed = 0;
    for (const b of blocks) {
      progressState.beat++;
      if (!(await openBlock(b, st))) await pasteInline(b.html);
      typed++;
    }
    await closeBlocks(st);
    return typed;
  }

  /**
   * Where a run of typed blocks starts. Enter continues whatever list the
   * previous paragraph was in, so the engine tracks list state itself,
   * starting from what the toolbar says.
   */
  async function blockState() {
    const start = await settledToolbar();
    return { list: start.list ? { kind: start.list, depth: 0 } : null, indent: 0, fresh: true };
  }

  async function closeBlocks(st) {
    if (st.indent) await press('[', { mod: true }, st.indent);
    st.indent = 0;
  }

  /**
   * Start block `b` at the caret: a new paragraph (unless the caret is in a
   * fresh one) with the block's paragraph style, list and nesting. Returns
   * true when the block was placed whole (tables, rules, images, page
   * breaks), false when its inline content still has to be typed.
   */
  async function openBlock(b, st) {
    // A table pasted at the end of a paragraph lands right after it; pasted
    // into a fresh empty paragraph it leaves that paragraph above it (both
    // observed live). So tables skip the Enter, and the list state is read
    // back afterwards because the table interrupted whatever list was open.
    if (b.t === 'table' && !st.fresh) {
      await paste(b.html, stripTags(b.html));
      const after = await settledToolbar();
      st.list = after.list ? { kind: after.list, depth: 0 } : null;
      st.fresh = true;
      return true;
    }
    if (!st.fresh) await press('Enter');
    st.fresh = false;
    if (b.t !== 'li' && st.list) {
      await press(LIST_KEY[st.list.kind], { mod: true, shift: true });
      st.list = null;
    }
    if (b.t !== 'quote' && st.indent) {
      await press('[', { mod: true }, st.indent);
      st.indent = 0;
    }
    switch (b.t) {
      case 'h':
        await setStyle(Math.min(6, Math.max(1, Number(b.level) || 1)));
        return false;
      case 'p':
      case 'code':
        await setStyle(0);
        return false;
      case 'quote':
        await setStyle(0);
        if (!st.indent) {
          await press(']', { mod: true });
          st.indent = 1;
        }
        return false;
      case 'li': {
        const kind = LIST_KEY[b.list] ? b.list : 'bullet';
        if (!st.list || st.list.kind !== kind) {
          if (!st.list) await setStyle(0);
          await press(LIST_KEY[kind], { mod: true, shift: true });
          // Converting a nested item keeps its nesting level.
          st.list = { kind, depth: st.list ? st.list.depth : 0 };
        }
        const depth = Math.max(0, Math.min(8, Number(b.depth) || 0));
        while (st.list.depth < depth) {
          await press('Tab');
          st.list.depth++;
        }
        while (st.list.depth > depth) {
          await press('Tab', { shift: true });
          st.list.depth--;
        }
        return false;
      }
      case 'table':
      case 'hr':
      case 'img':
      case 'html':
        await setStyle(0);
        await paste(b.html, stripTags(b.html));
        st.fresh = true; // a block paste leaves the caret in the paragraph after it
        return true;
      case 'pagebreak':
        await press('Enter', { mod: true });
        st.fresh = true;
        return true;
      default:
        fail('bad_args', `unknown block type ${b.t}`);
    }
  }

  // ---------------------------------------------------------- human typing

  /*
   * docs_type plays a keystroke plan (extension/lib/typing.js) with human
   * timing. Each character is a real keydown/keypress/keyup triple on the
   * editor's input, which Docs handles as typing (verified live in a hidden
   * tab, 2026-09-30): smart quotes and its other autocorrections apply as
   * they would for a person. keydown must carry the key's real keyCode —
   * Docs acts on keydown codes, so a "!" sent with keyCode 33 (PageUp) moved
   * the caret. Characters outside the BMP (emoji) do not arrive through
   * keypress and are pasted instead.
   */
  const PUNCT_CODES = { ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, _: 189, '.': 190, '>': 190, '/': 191, '?': 191, '`': 192, '~': 192, '[': 219, '{': 219, '\\': 220, '|': 220, ']': 221, '}': 221, "'": 222, '"': 222 };
  const SHIFTED_DIGITS = ')!@#$%^&*(';

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

  /**
   * Wait like a typist. Short gaps spin through a MessageChannel (hidden-tab
   * timers fire on one-second boundaries); long pauses mostly sleep on a
   * timer so a long job does not keep a core busy, then spin the remainder.
   */
  async function typingWait(ms) {
    const end = performance.now() + Math.max(0, ms);
    if (ms >= 1600) await new Promise((r) => setTimeout(r, ms - 1100));
    while (performance.now() < end) await yieldOnce();
    progressState.beat++;
  }

  const FIND_SAFE = /[A-Za-z0-9 ,.;:!?]/;
  /** Copy of resumeTail in extension/lib/typing.js (page code cannot import). */
  function resumeTail(paragraphText) {
    const s = String(paragraphText || '');
    let i = s.length;
    while (i > 0 && s.length - i < 80 && FIND_SAFE.test(s[i - 1])) i--;
    const tail = s.slice(i).replace(/^\s+/, '');
    if (tail.length < 20 || /\s$/.test(tail)) return null;
    return tail;
  }

  const TOGGLE_KEYS = { b: ['b', {}], i: ['i', {}], u: ['u', {}], s: ['x', { shift: true }] };

  /**
   * Play plan blocks from `at` ({block, event, para}) until done, or until
   * the budget is spent or a stop is requested and a safe point is reached.
   * `st` is the block state (see blockState), carried across chunks.
   * Throws with `typing` attached, so the job knows exactly where it got to.
   */
  async function playPlan(blocks, at, st, { budgetMs, job, inline = false }) {
    const deadline = performance.now() + budgetMs;
    let bi = at.block;
    let ei = at.event;
    let para = at.para || '';
    let chars = 0;
    let lastSafe = null;
    const position = () => ({ block: bi, event: ei, para, tail: resumeTail(para) });
    const stopWanted = () => performance.now() >= deadline || (job && globalThis.__docsBridgeStop?.[job]);
    try {
      progress('typing');
      for (; bi < blocks.length; bi++, ei = 0, para = '') {
        const b = blocks[bi];
        if (ei === 0) {
          await typingWait(b.before || 0);
          const whole = inline && bi === 0 ? false : await openBlock(b, st);
          if (whole || !b.keys?.length) {
            ei = 0;
            continue;
          }
        } else {
          st.fresh = false;
        }
        const ed = requireEditor();
        for (; ei < b.keys.length; ) {
          const e = b.keys[ei];
          await typingWait(e.d);
          ed.focus();
          if (e.c !== undefined) {
            // A tab is the Tab key, as a person presses it: in a table it
            // moves to the next cell. typeChar would send keyCode 0, not a Tab.
            if (e.c === '\t') key(ed, 'Tab');
            else typeChar(ed, e.c);
            para += e.c;
            chars++;
          } else if (e.k === 'Backspace') {
            key(ed, 'Backspace');
            para = [...para].slice(0, -1).join('');
            chars--;
          } else if (e.f) {
            const [name, mods] = TOGGLE_KEYS[e.f] || [];
            if (name) key(ed, name, { mod: true, ...mods });
          } else if (e.p !== undefined) {
            await paste(e.p, e.x);
            para += e.x;
            chars += [...e.x].length;
          }
          ei++;
          if (e.s) {
            lastSafe = position();
            if (stopWanted()) {
              return { done: false, at: lastSafe, tail: lastSafe.tail, chars, stopped: !!(job && globalThis.__docsBridgeStop?.[job]) };
            }
          }
        }
        // Past the block's last key the next block has not been started.
        lastSafe = { block: bi + 1, event: 0, para: '', tail: resumeTail(para) };
      }
      await closeBlocks(st);
      return { done: true, at: null, tail: null, chars };
    } catch (err) {
      err.typing = { at: lastSafe, reached: position(), chars, state: st };
      throw err;
    }
  }

  /**
   * Put the caret back where the previous chunk stopped, in a tab that did
   * not type it: at the end of the document, or right after the tail of the
   * paragraph being typed (found with Docs' Find).
   */
  async function resumeCaret(resume) {
    if (resume.byEnd) {
      await press('ArrowDown', { mod: true });
      return { via: 'end' };
    }
    if (!resume.tail) fail('resume_lost', 'the typing position cannot be found again (no resume anchor)');
    const count = await savedCount(resume.tail, false).catch(() => null);
    if (count !== null && count > 1) {
      fail('resume_ambiguous', `the resume anchor ${JSON.stringify(resume.tail)} appears ${count} times, so the typing position is ambiguous`);
    }
    await selectAnchor(resume.tail, 1, false);
    await press('ArrowRight');
    return { via: 'anchor' };
  }

  async function typeOp(a) {
    requireEditable();
    const blocks = a.blocks || [];
    // The job sizes the budget; a stop is only ever taken at a safe point.
    const budgetMs = Math.max(0, Number(a.budgetMs ?? 60_000) || 0);
    if (a.job) globalThis.__docsBridgeStop = { ...(globalThis.__docsBridgeStop || {}), [a.job]: false };
    let result;
    if (a.position) {
      // First chunk: position the caret exactly as docs_write would, then play.
      let st = null;
      const run = async (list, inline) => {
        st = inline ? { list: null, indent: 0, fresh: false } : await blockState();
        result = await playPlan(list, { block: 0, event: 0, para: '' }, st, { budgetMs, job: a.job, inline });
      };
      await write(
        { ...a.position, content: { blocks, inlineHtml: a.position.inline ? 'typed' : null, text: a.text || '', html: '' } },
        { blocks: (list) => run(list, false), inline: () => run(blocks, true), fragment: () => run(blocks, false) }
      );
      return { ...result, state: st };
    }
    const st = a.state || { list: null, indent: 0, fresh: false };
    if (a.resume) await resumeCaret(a.resume);
    result = await playPlan(blocks, a.at || { block: 0, event: 0, para: '' }, st, { budgetMs, job: a.job });
    return { ...result, state: st };
  }

  // ---------------------------------------------------------------- writes

  /**
   * Position the caret for `mode` and put the content there. `emit` says how
   * content goes in: by default blocks are typed with typeBlocks and inline
   * content is pasted; docs_type passes emitters that play keystrokes.
   */
  async function write(a, emit = null) {
    const { mode, content, anchor, occurrence = 1, matchCase = false } = a;
    const put = emit || {
      blocks: (blocks) => typeBlocks(blocks),
      inline: (c) => paste(c.inlineHtml, c.text),
      fragment: (c) => paste(c.html, c.text),
    };
    if (!content && mode !== 'replace_text') fail('bad_args', 'nothing to write');
    requireEditable();
    let anchorMatches = null;
    const blocks = content?.blocks;

    switch (mode) {
      case 'append': {
        await press('ArrowDown', { mod: true });
        const saved = await settledBlocks().catch(() => null);
        const last = saved ? saved[saved.length - 1] : null;
        // Unknown (read failed) counts as non-empty: an extra blank line is
        // harmless, typing into the last paragraph is not.
        if (!saved || (last && norm(last.text))) await press('Enter');
        await put.blocks(blocks);
        break;
      }
      case 'prepend':
        await press('ArrowUp', { mod: true });
        await press('Enter');
        await press('ArrowUp');
        await put.blocks(blocks);
        break;
      case 'replace_document':
        await press('a', { mod: true });
        await press('Backspace');
        await put.blocks(blocks);
        break;
      case 'insert_after':
      case 'insert_before': {
        if (!anchor) fail('bad_args', `${mode} needs an anchor`);
        anchorMatches = await selectAnchor(String(anchor), occurrence, matchCase);
        const after = mode === 'insert_after';
        await press(after ? 'ArrowRight' : 'ArrowLeft');
        if (content.inlineHtml && !a.asBlock) {
          await put.inline(content);
        } else if (after) {
          await toParagraphEnd();
          await press('Enter');
          await put.blocks(blocks);
        } else {
          await toParagraphStart();
          await press('Enter');
          await press('ArrowUp');
          await put.blocks(blocks);
        }
        break;
      }
      case 'replace_text': {
        if (!anchor) fail('bad_args', 'replace_text needs an anchor');
        // Replacing a whole paragraph with block content swaps the paragraph;
        // anything shorter is spliced in place.
        const saved = content && !content.inlineHtml ? await settledBlocks().catch(() => []) : [];
        const wholeParagraph = saved.some((b) => !b.inTable && norm(b.text) === norm(anchor));
        anchorMatches = await selectAnchor(String(anchor), occurrence, matchCase);
        if (!content) {
          await press('Backspace');
        } else if (content.inlineHtml) {
          await put.inline(content);
        } else if (wholeParagraph) {
          await press('Backspace');
          await put.blocks(blocks);
        } else {
          await put.fragment(content);
        }
        break;
      }
      case 'replace_section': {
        if (!anchor) fail('bad_args', 'replace_section needs the heading text as anchor');
        const s = await selectSection(String(anchor), occurrence);
        if (s.selected) await press('Backspace');
        else await press('Enter');
        await put.blocks(blocks);
        break;
      }
      default:
        fail('bad_args', `unknown write mode: ${mode}`);
    }
    return { mode, anchorMatches };
  }

  // ------------------------------------------------------------ edit steps

  /**
   * Run a list of human-style steps. Each step is an object with one action:
   *   {find:{text,occurrence,matchCase,regex}}   select a text match
   *   {caret:'start'|'end'|'paragraph_start'|'paragraph_end'|'line_start'|'line_end'}
   *   {caret:{after|before: text, occurrence}}  place the caret next to text
   *   {select:'paragraph'|'all'|'to_paragraph_end'|'to_paragraph_start'}
   *   {extend:{paragraphs|words|chars: n}}      grow the selection (negative = back)
   *   {section:{heading, occurrence}}            select a section's body
   *   {type:[blocks]}                            type blocks (see typeBlocks)
   *   {inline:html}                              type inline text over the selection
   *   {delete:true}                              delete the selection / previous char
   *   {format:{...}}                             see applyFormat
   *   {key:name, mods:{mod,shift,alt}, times}    press a key
   *   {menu:"Insert > Break > Page break"}       run any menu command
   *   {undo:n} {redo:n}
   */
  async function runSteps(steps) {
    if (!Array.isArray(steps) || !steps.length) fail('bad_args', 'steps must be a non-empty array');
    requireEditable();
    let known = null;
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      progress(`step ${i + 1} of ${steps.length} (${Object.keys(steps[i] || {})[0] || '?'})`);
      const s = steps[i] || {};
      const kind = Object.keys(s).find((k) => !['occurrence', 'matchCase', 'regex', 'mods', 'times'].includes(k));
      try {
        let detail = null;
        switch (kind) {
          case 'find': {
            const f = typeof s.find === 'string' ? { text: s.find } : s.find || {};
            if (!f.text) fail('bad_args', 'find needs text');
            const matches = await selectAnchor(String(f.text), f.occurrence ?? 1, !!f.matchCase, !!f.regex);
            known = f.regex ? null : String(f.text);
            detail = { matches };
            break;
          }
          case 'caret': {
            const c = s.caret;
            if (c && typeof c === 'object') {
              const text = c.after ?? c.before;
              if (!text) fail('bad_args', 'caret object needs after or before');
              await selectAnchor(String(text), c.occurrence ?? 1, !!c.matchCase);
              await press(c.after !== undefined ? 'ArrowRight' : 'ArrowLeft');
            } else if (c === 'start') await press('ArrowUp', { mod: true });
            else if (c === 'end') await press('ArrowDown', { mod: true });
            else if (c === 'paragraph_start') await toParagraphStart();
            else if (c === 'paragraph_end') await toParagraphEnd();
            else if (c === 'line_start') await press(isMac ? 'ArrowLeft' : 'Home', isMac ? { mod: true } : {});
            else if (c === 'line_end') await press(isMac ? 'ArrowRight' : 'End', isMac ? { mod: true } : {});
            else fail('bad_args', `unknown caret target ${JSON.stringify(c)}`);
            known = null;
            break;
          }
          case 'select': {
            if (s.select === 'all') await press('a', { mod: true });
            else if (s.select === 'paragraph') {
              await toParagraphStart();
              await press('ArrowDown', { para: true, shift: true });
            } else if (s.select === 'to_paragraph_end') await press('ArrowDown', { para: true, shift: true });
            else if (s.select === 'to_paragraph_start') await press('ArrowUp', { para: true, shift: true });
            else fail('bad_args', `unknown select target ${JSON.stringify(s.select)}`);
            known = null;
            break;
          }
          case 'extend': {
            const e = s.extend || {};
            const [unit, n] = Object.entries(e)[0] || [];
            const count = Math.min(Math.abs(Number(n) || 0), 500);
            const back = Number(n) < 0;
            if (unit === 'paragraphs') await press(back ? 'ArrowUp' : 'ArrowDown', { para: true, shift: true }, count);
            else if (unit === 'words') await press(back ? 'ArrowLeft' : 'ArrowRight', { shift: true, ...(isMac ? { alt: true } : { ctrl: true }) }, count);
            else if (unit === 'chars') await press(back ? 'ArrowLeft' : 'ArrowRight', { shift: true }, count);
            else fail('bad_args', 'extend takes {paragraphs|words|chars: n}');
            known = null;
            break;
          }
          case 'section': {
            const sec = typeof s.section === 'string' ? { heading: s.section } : s.section || {};
            detail = await selectSection(String(sec.heading || ''), sec.occurrence ?? 1);
            known = null;
            break;
          }
          case 'type':
            detail = { blocks: await typeBlocks(s.type) };
            known = null;
            break;
          case 'inline':
            await pasteInline(String(s.inline));
            known = stripTags(s.inline);
            break;
          case 'delete':
            await press('Backspace');
            known = null;
            break;
          case 'format':
            detail = { applied: await applyFormat(s.format || {}, known) };
            break;
          case 'key': {
            const m = s.mods || {};
            await press(String(s.key), { mod: !!m.mod, shift: !!m.shift, alt: !!m.alt, ctrl: !!m.ctrl, meta: !!m.meta }, Math.min(Number(s.times) || 1, 200));
            known = null;
            break;
          }
          case 'menu':
            detail = await menu(s.menu);
            break;
          case 'undo':
            await press('z', { mod: true }, Math.min(Number(s.undo) || 1, 50));
            known = null;
            break;
          case 'redo':
            await press('z', { mod: true, shift: true }, Math.min(Number(s.redo) || 1, 50));
            known = null;
            break;
          default:
            fail('bad_args', `step ${i + 1} has no recognised action (${JSON.stringify(s).slice(0, 80)})`);
        }
        results.push({ step: i + 1, action: kind, ...(detail || {}) });
      } catch (err) {
        err.message = `step ${i + 1} (${kind || '?'}): ${err.message}`;
        err.completed = results;
        throw err;
      }
    }
    return { results, known };
  }

  // -------------------------------------------------------------------- ops

  async function run() {
    progress(op);
    switch (op) {
      case 'state': {
        const ed = editor();
        // textContent, not innerText: innerText needs layout, which a hidden
        // tab may not have done yet.
        const text = ed ? '' : (document.body?.textContent || '').slice(0, 4000);
        return {
          ready: !!ed,
          docId: docId(),
          title: document.querySelector('input.docs-title-input')?.value || document.title.replace(/ - Google Docs$/, ''),
          url: location.href,
          signedOut: /accounts\.google\.com/.test(location.host),
          accessDenied: !ed && /You need access|Request access|You need permission/i.test(text),
          notFound: !ed && /file you have requested does not exist|Sorry, unable to open the file/i.test(text),
          ...(ed ? isEditable() : { editable: false, reason: 'loading' }),
        };
      }

      case 'blocks':
        return { blocks: await savedBlocks() };

      case 'toolbar':
        return { toolbar: await settledToolbar() };

      case 'title': {
        const input = document.querySelector('input.docs-title-input');
        if (!input) fail('no_title', 'title field not found');
        const title = String(args.title || '').trim();
        if (!title) fail('bad_args', 'title is empty');
        requireEditable();
        // A bare value assignment is never committed; Docs wants the
        // click → input → Enter → blur sequence a person produces.
        input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        input.focus();
        input.select();
        setInput(input, title);
        key(input, 'Enter');
        await pause(200);
        input.dispatchEvent(new FocusEvent('blur'));
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        const done = await waitFor(() => document.title.startsWith(`${title} - `), 4000);
        return { title, verified: !!done };
      }

      case 'write':
        return write(args);

      case 'edit':
        return runSteps(args.steps);

      case 'type':
        return typeOp(args);

      case 'replace_all': {
        const { find, replace = '', matchCase = false, regex = false } = args;
        if (!find) fail('bad_args', 'find is empty');
        requireEditable();
        const present = regex ? null : await savedCount(String(find), matchCase).catch(() => null);
        if (present === 0) return { replaced: 0 };
        const dialog = await openFind();
        const count = await search(dialog, String(find), { matchCase, regex });
        if (!count.total) {
          await closeDialog(dialog);
          if (present) stalled(find);
          return { replaced: 0 };
        }
        setInput(dialog.querySelectorAll('input[type="text"]')[1], String(replace));
        await pause(60);
        const all = button(dialog, 'Replace all');
        if (!all) fail('no_button', 'the Replace all button was not found');
        all.click();
        await waitFor(() => matchCount(dialog).total === 0, 3000);
        await closeDialog(dialog);
        return { replaced: count.total };
      }

      case 'count': {
        requireEditor();
        const present = args.regex ? null : await savedCount(String(args.find || ''), !!args.matchCase).catch(() => null);
        if (present === 0) return { matches: 0 };
        const dialog = await openFind();
        const count = await search(dialog, String(args.find || ''), { matchCase: !!args.matchCase, regex: !!args.regex });
        await closeDialog(dialog);
        if (!count.total && present) stalled(args.find);
        return { matches: count.total };
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
      ...(err.typing ? { typing: err.typing } : {}),
    };
  }
}
