/**
 * slidesPageOp is serialised into Slides tabs by chrome.scripting, so it must
 * not reference anything outside itself. These tests compile it from its
 * source text in a fresh VM context holding only browser-shaped globals, then
 * drive it against a scripted fake of the Slides editor: shapes that select
 * on click, text mode (Enter), select-all, Slides' copy handler, the
 * filmstrip, the menu bar with the layout palette, and Find and replace.
 *
 * The key/paste/menu sequences asserted here are the ones verified live
 * against docs.google.com/presentation (see AGENTS.md); they are regression
 * locks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { slidesPageOp } from '../extension/page/slides-page.js';

const ID = '1TestDeckAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeDataTransfer {
  constructor() {
    this.data = {};
  }
  setData(k, v) {
    this.data[k] = v;
  }
  getData(k) {
    return this.data[k] ?? '';
  }
  get types() {
    return Object.keys(this.data);
  }
}

function el(props = {}) {
  const e = {
    textContent: '',
    childElementCount: 0,
    attrs: {},
    style: {},
    classes: new Set(),
    className: '',
    children: [],
    parentElement: null,
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 100, height: 40 }),
    focus() {},
    dispatchEvent() {
      return true;
    },
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  e.classList = { contains: (c) => e.classes.has(c) };
  return Object.assign(e, props);
}

const PROMPTS = { title: 'Click to add title', subtitle: 'Click to add subtitle', body: 'Click to add text' };

/**
 * A fake Slides editor.
 * - `pages`: [{id, shapes: [{id, role, text}], notes}] in deck order.
 * - mode: 'none' | 'shape' (a shape selected) | 'text' (caret in a shape or the notes).
 * - Pastes with no text caret create a new text box, as the real editor does.
 */
function fakeSlides({ pages: initial, enterWorks = true, platform = 'MacIntel', staleIds = false, gettingStarted = false } = {}) {
  const log = [];
  const pages = (
    initial || [
      { id: 'p', shapes: [{ id: 'i0', role: 'title', text: '' }, { id: 'i1', role: 'subtitle', text: '' }], notes: '' },
      { id: 'g2', shapes: [{ id: 'g2_t', role: 'title', text: 'Old title' }, { id: 'g2_b', role: 'body', text: 'one\ntwo' }], notes: 'old notes' },
    ]
  ).map((p) => ({ ...p, shapes: p.shapes.map((s) => ({ ...s })), skipped: false }));
  const tb = { list: null, bold: false, italic: false, underline: false, size: 18, font: 'Arial' };
  let current = pages[0].id;
  let mode = 'none';
  let selected = null; // shape object
  let target = null; // {kind:'shape', shape} | {kind:'notes', page}
  let selAll = false;
  let seq = 0;
  let movedFirst = null; // which page was last redrawn by a move (stale ids)
  const page = () => pages.find((p) => p.id === current);
  const location = {
    get hash() {
      return `#slide=id.${current}`;
    },
    set hash(v) {
      const m = String(v).match(/slide=id\.(.+)$/);
      if (m && pages.some((p) => p.id === m[1])) current = m[1];
    },
    search: '',
    pathname: `/presentation/d/${ID}/edit`,
    host: 'docs.google.com',
    href: `https://docs.google.com/presentation/d/${ID}/edit`,
  };

  const textOf = () => (target?.kind === 'notes' ? target.page.notes : target?.shape.text ?? '');
  const setTextOf = (v) => {
    if (target?.kind === 'notes') target.page.notes = v;
    else if (target) target.shape.text = v;
  };

  // ---- the slide (SVG)
  function shapeEl(p, s) {
    const g = el({ id: `editor-${s.id}` });
    const hit = el();
    hit.dispatchEvent = (ev) => {
      if (ev.type === 'mousedown' && current === p.id) {
        mode = 'shape';
        selected = s;
        target = null;
        selAll = false;
        log.push(`select:${s.id}`);
      }
      return true;
    };
    g.querySelector = (sel) => (sel.startsWith('path[pointer-events') ? hit : null);
    g.querySelectorAll = (sel) => {
      if (sel !== 'text') return [];
      const words = s.text ? s.text.split(/\s+/).filter(Boolean) : PROMPTS[s.role] ? PROMPTS[s.role].split(' ') : [];
      return words.map((w) => ({ textContent: w }));
    };
    return g;
  }
  function pageEl(p) {
    const g = el({ id: `editor-${p.id}` });
    Object.defineProperty(g, 'children', { get: () => [el({ id: `editor-${p.id}-bg` }), ...p.shapes.map((s) => shapeEl(p, s))] });
    g.getBoundingClientRect = () => ({ x: 0, y: 0, width: current === p.id ? 500 : 0, height: 300 });
    return g;
  }

  // ---- filmstrip
  function thumbGroups() {
    return pages.map((p, i) => {
      const n = staleIds ? (p.id === movedFirst ? 0 : p.n ?? i) : i;
      const thumb = el({ attrs: { transform: `translate(0 ${2 + i * 102})` } });
      const hit = el();
      hit.dispatchEvent = (ev) => {
        if (ev.type === 'mousedown') {
          current = p.id;
          mode = 'none';
          log.push(`thumb:${p.id}`);
        }
        return true;
      };
      thumb.querySelector = (sel) => (sel.startsWith('path') ? hit : null);
      return el({ id: `filmstrip-slide-${n}-${p.id}`, closest: (sel) => (sel === '.punch-filmstrip-thumbnail' ? thumb : null) });
    });
  }

  // ---- editor input
  const editor = el();
  const LIST = { 8: 'bullet', 7: 'numbered', 9: 'checklist' };
  editor.dispatchEvent = (ev) => {
    if (ev.type === 'keypress' && ev.key !== 'Enter') {
      log.push(`char:${ev.key}`);
      if (mode === 'text') setTextOf(selAll ? String.fromCodePoint(ev.charCode) : textOf() + String.fromCodePoint(ev.charCode));
      else log.push('KEYPRESS-OUTSIDE-TEXT');
      selAll = false;
      return true;
    }
    if (ev.type === 'keydown' && !ev.metaKey && !ev.ctrlKey && ev.key.length === 1) {
      typedKeydowns.push({ key: ev.key, keyCode: ev.keyCode });
      return true;
    }
    if (ev.type === 'keydown') {
      const mods = [ev.metaKey && 'Meta', ev.ctrlKey && 'Ctrl', ev.altKey && 'Alt', ev.shiftKey && 'Shift'].filter(Boolean);
      log.push(`key:${[...mods, ev.key].join('+')}`);
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      if (ev.key === 'Escape') {
        if (mode === 'text') {
          mode = target?.kind === 'shape' ? 'shape' : 'none';
          target = null;
        } else {
          mode = 'none';
          selected = null;
        }
        selAll = false;
      } else if (ev.key === 'Enter' && !mod) {
        if (mode === 'shape' && enterWorks) {
          mode = 'text';
          target = { kind: 'shape', shape: selected };
          selAll = false;
        } else if (mode === 'text') {
          setTextOf(selAll ? '\n' : `${textOf()}\n`);
          selAll = false;
        }
      } else if (mod && !ev.shiftKey && !ev.altKey && ev.key === 'a') {
        if (mode === 'text') selAll = true;
        else mode = 'all-shapes';
      } else if (ev.key === 'Backspace') {
        if (mode === 'text' && selAll) {
          setTextOf('');
          selAll = false;
        } else if (mode === 'text') setTextOf([...textOf()].slice(0, -1).join(''));
        if (mode === 'all-shapes') log.push('DELETED-ALL-SHAPES');
      } else if (ev.ctrlKey && ev.key === 'm') {
        const id = `n${++seq}`;
        const at = pages.findIndex((p) => p.id === current);
        pages.splice(at + 1, 0, { id, shapes: [{ id: `${id}_t`, role: 'title', text: '' }, { id: `${id}_b`, role: 'body', text: '' }], notes: '' });
        current = id;
        mode = 'none';
      } else if (mod && ev.altKey && ev.shiftKey && ev.key === 's') {
        mode = 'text';
        target = { kind: 'notes', page: page() };
        selAll = false;
      } else if (mod && ev.shiftKey && LIST[ev.key]) {
        tb.list = tb.list === LIST[ev.key] ? null : LIST[ev.key];
      } else if (mod && !ev.shiftKey && ev.key === 'b') tb.bold = !tb.bold;
      else if (mod && !ev.shiftKey && ev.key === 'z') log.push('undo');
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        if (mode === 'text') {
          if (ev.shiftKey) caret.len++;
          else if (selAll) {
            caret.pos = ev.key === 'ArrowLeft' ? 0 : textOf().length;
            caret.len = 0;
            selAll = false;
          } else caret.pos += ev.key === 'ArrowRight' ? 1 : -1;
        }
      }
    }
    if (ev.type === 'paste') {
      const text = ev.clipboardData.getData('text/plain');
      log.push(`paste:${ev.clipboardData.getData('text/html')}`);
      ev.preventDefault();
      if (mode === 'text') {
        if (caret.len) {
          const t = textOf();
          setTextOf(t.slice(0, caret.pos) + text + t.slice(caret.pos + caret.len));
          caret.len = 0;
        } else setTextOf(selAll ? text : textOf() + text);
        selAll = false;
      } else if (mode === 'shape') {
        selected.text = text;
        log.push('REPLACED-WHOLE-SHAPE');
      } else {
        page().shapes.push({ id: `stray${++seq}`, role: null, text });
        log.push('NEW-TEXT-BOX');
      }
    }
    if (ev.type === 'copy') {
      ev.preventDefault();
      if (mode === 'shape') {
        ev.clipboardData.setData('text/plain', `${selected.text}\n`);
        ev.clipboardData.setData('application/x-vnd.google-docs-drawings-object+wrapped', '{}');
      } else if (mode === 'all-shapes') {
        ev.clipboardData.setData('text/plain', page().shapes.map((s) => s.text).join('\n'));
        ev.clipboardData.setData('application/x-vnd.google-docs-drawings-object+wrapped', '{}');
      } else if (mode === 'text') {
        const t = textOf();
        ev.clipboardData.setData('text/plain', selAll ? `${t}\n` : caret.len ? t.slice(caret.pos, caret.pos + caret.len) : '');
      }
    }
    return true;
  };
  const caret = { pos: 0, len: 0 };
  const typedKeydowns = [];
  const isMac = platform === 'MacIntel';

  // ---- menus
  const find = { query: '', total: 0, current: 0 };
  const allText = () => pages.flatMap((p) => p.shapes.map((s) => s.text)).join('\n');
  let findOpen = false;
  const counter = el();
  Object.defineProperty(counter, 'textContent', { get: () => (find.total ? `${find.current} of ${find.total}` : '') });
  const findInput = el({ value: '' });
  findInput.dispatchEvent = (ev) => {
    if (ev.type === 'input') {
      find.query = findInput.value;
      const q = find.query.toLowerCase();
      find.total = q ? allText().toLowerCase().split(q).length - 1 : 0;
      find.current = 0;
      log.push(`find:${find.query}`);
    }
    if (ev.type === 'keydown') log.push(`find-key:${ev.key}`);
    return true;
  };
  const replaceInput = el({ value: '', dispatchEvent: () => true });
  const replaceIn = (q, r, nth) => {
    let k = 0;
    for (const p of pages)
      for (const s of p.shapes)
        s.text = s.text.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => (nth === undefined || ++k === nth ? r : m));
  };
  const buttons = [
    el({ textContent: 'Next', click: () => (find.current = (find.current % find.total) + 1) }),
    el({
      textContent: 'Replace all',
      click() {
        log.push(`replace-all:${find.query}->${replaceInput.value}`);
        replaceIn(find.query, replaceInput.value);
        find.total = 0;
      },
    }),
    el({
      textContent: 'Replace',
      click() {
        log.push(`replace-one:${find.current}`);
        replaceIn(find.query, replaceInput.value, find.current);
        find.total--;
      },
    }),
  ];
  const dialog = el({
    textContent: 'Find and replace Find Replace with Match case',
    querySelector: (sel) => (sel === 'input[type="text"]' ? findInput : null),
    querySelectorAll: (sel) => (sel === 'input[type="text"]' ? [findInput, replaceInput] : sel === 'button' ? buttons : sel === '*' ? [counter] : []),
  });
  const gsClose = el({ attrs: { 'aria-label': 'Close' } });
  gsClose.dispatchEvent = (ev) => {
    if (ev.type === 'click') {
      gettingStarted = false;
      log.push('closed-getting-started');
    }
    return true;
  };
  const gsDialog = el({ className: 'goog-modalpopup getting-started-dialog-gemini', attrs: { 'aria-label': 'Getting started' }, querySelector: (sel) => (sel === '[aria-label="Close"]' ? gsClose : null) });

  const toggles = { Strikethrough: false };
  const layoutCell = (name) => {
    const c = el({ className: 'goog-palette-cell', textContent: name });
    c.classes.add('goog-palette-cell');
    c.querySelector = (sel) => (sel === '.punch-layouts-palette-label' ? { textContent: name } : null);
    return c;
  };
  const MENU = () => ({
    Edit: { 'Find and replace': () => (findOpen = true) },
    Slide: {
      'Apply layout': { $palette: ['Title slide', 'Title and body', 'Title only', 'Blank'] },
      'Duplicate slide': () => {
        const at = pages.findIndex((p) => p.id === current);
        const copy = { ...pages[at], id: `d${++seq}`, shapes: pages[at].shapes.map((s) => ({ ...s, id: `${s.id}_c${seq}` })) };
        pages.splice(at + 1, 0, copy);
        current = copy.id;
      },
      'Delete slide': () => {
        const at = pages.findIndex((p) => p.id === current);
        pages.splice(at, 1);
        current = pages[Math.min(at, pages.length - 1)].id;
      },
      'Move slide': {
        'Move slide to end': () => {
          if (!thumbSelected) return log.push('MOVE-WITHOUT-FILMSTRIP-SELECTION');
          const at = pages.findIndex((p) => p.id === current);
          const [p] = pages.splice(at, 1);
          pages.push(p);
          movedFirst = p.id;
        },
        'Move slide to beginning': () => {
          const at = pages.findIndex((p) => p.id === current);
          const [p] = pages.splice(at, 1);
          pages.unshift(p);
          movedFirst = p.id;
        },
      },
      'Skip slide': 'toggle',
    },
    Format: { Text: { Strikethrough: 'toggle' } },
  });
  let thumbSelected = false;
  let openLevels = [];
  function buildItems(tree) {
    if (tree.$palette) {
      return tree.$palette.map((name) => {
        const c = layoutCell(name);
        c.dispatchEvent = (ev) => {
          if (ev.type === 'click') {
            log.push(`layout:${name}`);
            page().shapes = page().shapes.map((s, i) => ({ ...s, id: `${s.id}L` }));
            page().layout = name;
            openLevels = [];
          }
          return true;
        };
        return c;
      });
    }
    return Object.entries(tree).map(([label, node]) => {
      const item = el({ textContent: label });
      item.classes.add('goog-menuitem');
      if (node === 'toggle' && (label === 'Skip slide' ? page().skipped : toggles[label])) item.classes.add('goog-option-selected');
      item.dispatchEvent = (ev) => {
        if (typeof node === 'object' && (ev.type === 'mousedown' || ev.type === 'mouseover')) {
          const depth = openLevels.findIndex((lvl) => lvl.includes(item));
          openLevels = openLevels.slice(0, depth + 1);
          openLevels.push(buildItems(node));
        }
        if (ev.type === 'click' && typeof node !== 'object') {
          log.push(`menu:${label}`);
          if (node === 'toggle') {
            if (label === 'Skip slide') page().skipped = !page().skipped;
            else toggles[label] = !toggles[label];
          } else node();
          openLevels = [];
        }
        return true;
      };
      return item;
    });
  }
  const menubar = () =>
    Object.keys(MENU()).map((label) => {
      const b = el({ textContent: label });
      b.dispatchEvent = (ev) => {
        if (ev.type === 'mousedown') openLevels = [buildItems(MENU()[label])];
        return true;
      };
      return b;
    });
  const menuEl = (items) => el({ style: {}, querySelectorAll: (sel) => (sel.includes('.goog-menuitem') || sel.includes('.goog-palette-cell') ? items : []) });

  const pressed = (fn) => {
    const b = el({ attrs: {} });
    Object.defineProperty(b.attrs, 'aria-pressed', { get: () => String(fn()), enumerable: true });
    return b;
  };
  const byIdStatic = {
    boldButton: pressed(() => tb.bold),
    italicButton: pressed(() => tb.italic),
    underlineButton: pressed(() => tb.underline),
    addBulletButton: pressed(() => tb.list === 'bullet'),
    addNumberedBulletButton: pressed(() => tb.list === 'numbered'),
    addChecklistButton: pressed(() => tb.list === 'checklist'),
    'docs-save-indicator-badge': el({ attrs: { 'aria-label': 'Document status: Saved to Drive.' } }),
  };
  const titleInput = el({ value: 'Deck', select() {}, blur() {} });
  const document = {
    title: 'Deck - Google Slides',
    body: el({ textContent: '' }),
    activeElement: null,
    getElementById(id) {
      if (byIdStatic[id]) return byIdStatic[id];
      const pm = id.match(/^editor-(.+)$/);
      if (pm) {
        const p = pages.find((x) => x.id === pm[1]);
        if (p) return pageEl(p);
        if (pages.some((x) => `${x.id}-bg` === pm[1])) return el({ id });
        return null;
      }
      const fm = id.match(/^filmstrip-slide-\d+-(.+)-bg$/);
      if (fm && pages.some((p) => p.id === fm[1])) return el({ id });
      return null;
    },
    querySelector(sel) {
      if (sel === 'iframe.docs-texteventtarget-iframe') return { contentDocument: { querySelector: () => editor } };
      if (sel === 'input.docs-title-input') return titleInput;
      if (sel === '#docs-toolbar-mode-switcher') return null;
      if (sel.startsWith('#docs-header')) return el({ textContent: 'File Edit View' });
      if (sel === '#newSlideButton, #boldButton') return el();
      if (sel === '#docs-save-indicator-badge') return byIdStatic['docs-save-indicator-badge'];
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[role="dialog"]') return [...(findOpen ? [dialog] : []), ...(gettingStarted ? [gsDialog] : [])];
      if (sel.startsWith('#docs-menubar')) return menubar();
      if (sel === '.goog-menu') return openLevels.map(menuEl);
      if (sel === 'g[id^="filmstrip-slide-"]') {
        thumbSelected = false;
        return thumbGroups().map((g) => {
          const thumb = g.closest('.punch-filmstrip-thumbnail');
          const hit = thumb.querySelector('path');
          const inner = hit.dispatchEvent;
          hit.dispatchEvent = (ev) => {
            if (ev.type === 'mousedown') thumbSelected = true;
            return inner(ev);
          };
          return g;
        });
      }
      if (sel === 'g[id^="editor-"]') return pages.map(pageEl);
      return [];
    },
  };
  titleInput.dispatchEvent = (ev) => {
    if (ev.type === 'keydown' && ev.key === 'Enter') document.title = `${titleInput.value} - Google Slides`;
    return true;
  };

  const context = vm.createContext({
    navigator: { platform, userAgent: platform === 'MacIntel' ? 'Mac' : 'Windows' },
    performance: { now: () => performance.now() },
    MessageChannel,
    document,
    window: {},
    location,
    KeyboardEvent: FakeEvent,
    ClipboardEvent: FakeEvent,
    InputEvent: FakeEvent,
    MouseEvent: FakeEvent,
    FocusEvent: FakeEvent,
    TransitionEvent: FakeEvent,
    AnimationEvent: FakeEvent,
    Event: FakeEvent,
    DataTransfer: FakeDataTransfer,
    getComputedStyle: () => ({ display: 'block' }),
  });
  context.globalThis = context;
  const inner = vm.runInContext(`(${slidesPageOp.toString()})`, context);
  const run = async (op, args) => JSON.parse(JSON.stringify(await inner(op, args)));
  return { run, log, pages, tb, find, typedKeydowns, get mode() {
    return mode;
  } };
}

const keys = (log) => log.filter((l) => /^(key|paste|menu|layout|replace|select|thumb)/.test(l));

// ------------------------------------------------------------ fundamentals

test('the page function is self-contained: it runs with nothing but browser globals', async () => {
  const { run } = fakeSlides();
  assert.deepEqual(await run('no-such-op', {}), { ok: false, code: 'bad_args', message: 'unknown page op: no-such-op' });
});

test('state reports readiness, the deck id, title, slide count and current page', async () => {
  const s = await fakeSlides().run('state', {});
  assert.equal(s.ready, true);
  assert.equal(s.docId, ID);
  assert.equal(s.title, 'Deck');
  assert.equal(s.slideCount, 2);
  assert.equal(s.page, 'p');
  assert.equal(s.editable, true);
});

test('slides come in filmstrip order by position, even when the ids keep stale numbers', async () => {
  const d = fakeSlides({ staleIds: true });
  const r = await d.run('slides', {});
  assert.deepEqual(r.slides, [{ index: 1, pageId: 'p' }, { index: 2, pageId: 'g2' }]);
  assert.deepEqual(r.shapes.map((s) => [s.index, s.objectId, s.emptyPlaceholder ?? null]), [[1, 'i0', 'title'], [2, 'i1', 'subtitle']]);
});

// ------------------------------------------------------------ writing text

test('setText on an empty placeholder: click, Enter, select-all (checked through copy), then paste', async () => {
  const d = fakeSlides();
  const r = await d.run('run', { steps: [{ shape: { role: 'title' } }, { setText: [{ html: 'Hello', text: 'Hello', list: null, level: 0 }] }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(d.pages[0].shapes[0].text, 'Hello');
  assert.deepEqual(r.results[1], { step: 2, action: 'setText', pageId: 'p', objectId: 'i0', index: 1, text: 'Hello' });
  const k = keys(d.log);
  assert.ok(k.indexOf('select:i0') < k.indexOf('key:Enter'));
  assert.ok(!k.includes('key:Backspace'), 'an empty box is not cleared');
  assert.ok(!d.log.includes('NEW-TEXT-BOX') && !d.log.includes('REPLACED-WHOLE-SHAPE'));
});

test('setText replaces existing text: select-all then Backspace, typed paragraph by paragraph', async () => {
  const d = fakeSlides();
  const r = await d.run('run', {
    steps: [{ slide: { index: 2 } }, { shape: { index: 2 } }, { setText: [{ html: 'a', text: 'a', list: null, level: 0 }, { html: 'b', text: 'b', list: null, level: 0 }] }],
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(d.pages[1].shapes[1].text, 'a\nb');
  assert.ok(keys(d.log).includes('key:Backspace'));
  assert.ok(keys(d.log).includes('thumb:g2'));
});

test('lists: bullets nest with Tab; switching to numbering turns bullets off first, then numbering on', async () => {
  const d = fakeSlides();
  const P = (text, list, level = 0) => ({ html: text, text, list, level });
  const r = await d.run('run', { steps: [{ shape: { index: 2 } }, { setText: [P('a', 'bullet'), P('b', 'bullet', 1), P('c', 'numbered'), P('d', null)] }] });
  assert.equal(r.ok, true, r.message);
  const k = keys(d.log).filter((l) => /Meta\+Shift\+[78]|Tab|Enter|paste/.test(l));
  assert.deepEqual(k, [
    'key:Enter',
    'key:Meta+Shift+8',
    'paste:<span>a</span>',
    'key:Enter',
    'key:Tab',
    'paste:<span>b</span>',
    'key:Enter',
    'key:Shift+Tab',
    'key:Meta+Shift+8',
    'key:Meta+Shift+7',
    'paste:<span>c</span>',
    'key:Enter',
    'key:Meta+Shift+7',
    'paste:<span>d</span>',
  ]);
});

test('a paragraph ending in bold turns bold off before the next one, as a person would', async () => {
  const d = fakeSlides();
  await d.run('run', {
    steps: [{ shape: { index: 2 } }, { setText: [{ html: '<strong>Reads</strong>', text: 'Reads', list: null, level: 0 }, { html: 'plain', text: 'plain', list: null, level: 0 }] }],
  });
  const k = keys(d.log).filter((l) => /Meta\+b|paste|Enter/.test(l));
  assert.deepEqual(k.slice(-4), ['paste:<span><strong>Reads</strong></span>', 'key:Enter', 'key:Meta+b', 'paste:<span>plain</span>']);
});

test('setText refuses, deleting nothing, when select-all selects shapes instead of text', async () => {
  const d = fakeSlides({ enterWorks: false });
  const r = await d.run('run', { steps: [{ slide: { index: 2 } }, { shape: { index: 2 } }, { setText: [{ html: 'x', text: 'x', list: null, level: 0 }] }] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_in_text');
  assert.ok(!d.log.includes('DELETED-ALL-SHAPES'));
  assert.ok(!d.log.some((l) => l.startsWith('paste:')));
  assert.equal(d.pages[1].shapes[1].text, 'one\ntwo');
  assert.equal(r.completed.length, 2, 'the completed steps are reported');
});

test('text refuses to paste without a caret in text (it would create a new text box)', async () => {
  const d = fakeSlides();
  const r = await d.run('run', { steps: [{ text: 'stray' }] });
  assert.equal(r.code, 'not_in_text');
  assert.ok(!d.log.includes('NEW-TEXT-BOX'));
});

test('notes: Cmd+Alt+Shift+S puts the caret in the speaker notes, which are then replaced', async () => {
  const d = fakeSlides();
  const r = await d.run('run', { steps: [{ slide: { index: 2 } }, { notes: [{ html: 'new notes', text: 'new notes', list: null, level: 0 }] }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(d.pages[1].notes, 'new notes');
  assert.ok(keys(d.log).includes('key:Meta+Alt+Shift+s'));
  assert.deepEqual(r.results[1], { step: 2, action: 'notes', pageId: 'g2', notes: 'new notes' });
});

test('selectText selects by exact offsets and the selection is checked through copy', async () => {
  const d = fakeSlides();
  const r = await d.run('run', {
    steps: [{ slide: { index: 2 } }, { shape: { index: 2 } }, { selectText: { text: 'two', occurrence: 1, matchCase: false } }, { text: 'TWO' }],
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(d.pages[1].shapes[1].text, 'one\nTWO');
  assert.deepEqual([r.results[2].matches, r.results[2].offset], [1, 4]);
});

test('selectText reports text that is not in the box', async () => {
  const r = await fakeSlides().run('run', { steps: [{ slide: { index: 2 } }, { shape: { index: 2 } }, { selectText: { text: 'nope' } }] });
  assert.equal(r.code, 'text_not_found');
});

// ------------------------------------------------------------ slide operations

test('newSlide: Ctrl+M (Ctrl on macOS too), then Slide > Apply layout from the palette', async () => {
  const d = fakeSlides();
  const r = await d.run('run', { steps: [{ slide: { index: 2 } }, { newSlide: { layout: 'Title only' } }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(d.pages.length, 3);
  assert.equal(d.pages[2].layout, 'Title only');
  assert.ok(keys(d.log).includes('key:Ctrl+m'));
  assert.ok(d.log.includes('layout:Title only'));
  assert.deepEqual([r.results[1].index, r.results[1].layout], [3, 'Title only']);
  assert.deepEqual(r.slides.map((s) => s.index), [1, 2, 3]);
});

test('Move slide selects the slide in the filmstrip first (the menu is disabled otherwise)', async () => {
  const d = fakeSlides();
  const r = await d.run('run', { steps: [{ slide: { index: 1 } }, { moveSlide: 'end' }] });
  assert.equal(r.ok, true, r.message);
  assert.ok(!d.log.includes('MOVE-WITHOUT-FILMSTRIP-SELECTION'));
  assert.deepEqual(d.pages.map((p) => p.id), ['g2', 'p']);
  assert.deepEqual([r.results[1].from, r.results[1].to], [1, 2]);
});

test('duplicate, skip and delete go through the Slide menu', async () => {
  const d = fakeSlides();
  const r = await d.run('run', { steps: [{ slide: { index: 2 } }, { duplicateSlide: true }, { skipSlide: true }, { deleteSlide: true }] });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(d.log.filter((l) => l.startsWith('menu:')), ['menu:Duplicate slide', 'menu:Skip slide', 'menu:Delete slide']);
  assert.equal(d.pages.length, 2);
});

test('the last slide cannot be deleted', async () => {
  const d = fakeSlides({ pages: [{ id: 'p', shapes: [], notes: '' }] });
  const r = await d.run('run', { steps: [{ deleteSlide: true }] });
  assert.equal(r.code, 'last_slide');
});

test('a missing slide or shape is reported with what exists', async () => {
  const d = fakeSlides();
  assert.match((await d.run('run', { steps: [{ slide: { index: 9 } }] })).message, /slide 9 does not exist; the presentation has 2/);
  const r = await d.run('run', { steps: [{ slide: { index: 2 } }, { shape: { role: 'title' } }] });
  assert.equal(r.code, 'shape_not_found');
  assert.match(r.message, /filled placeholders are found by id/);
});

// ------------------------------------------------------------ find and replace

test('replace opens Find and replace from the Edit menu (Cmd+Shift+H does nothing in a hidden tab)', async () => {
  const d = fakeSlides();
  const r = await d.run('replace', { find: 'Old', replace: 'New' });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual([r.replaced, r.matches], [1, 1]);
  assert.ok(d.log.includes('menu:Find and replace'));
  assert.ok(!d.log.some((l) => /Meta\+Shift\+h/.test(l)));
  assert.equal(d.pages[1].shapes[0].text, 'New title');
});

test('replace with occurrence steps to the match and presses Replace once', async () => {
  const d = fakeSlides({
    pages: [{ id: 'p', shapes: [{ id: 'a', role: 'title', text: 'x x x' }], notes: '' }],
  });
  const r = await d.run('replace', { find: 'x', replace: 'y', occurrence: 2 });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.replaced, 1);
  assert.equal(d.pages[0].shapes[0].text, 'x y x');
});

test('replace with no match changes nothing', async () => {
  const d = fakeSlides();
  const r = await d.run('replace', { find: 'absent', replace: 'z' });
  assert.deepEqual([r.ok, r.replaced], [true, 0]);
  assert.ok(!d.log.some((l) => l.startsWith('replace-')));
});

// ------------------------------------------------------------ new decks

test('dismiss waits for and closes the Getting started dialog', async () => {
  const d = fakeSlides({ gettingStarted: true });
  const r = await d.run('dismiss', { wait: 500 });
  assert.equal(r.closed, 1);
  assert.ok(d.log.includes('closed-getting-started'));
});

test('title renames through the title field and confirms it from the window title', async () => {
  const r = await fakeSlides().run('title', { title: 'Q4 plan' });
  assert.deepEqual([r.ok, r.verified], [true, true]);
});

test('saved reads the save indicator', async () => {
  const r = await fakeSlides().run('saved', { timeout: 500 });
  assert.deepEqual([r.saved, r.status], [true, 'Saved to Drive.']);
});

test('on Windows the modifier is Ctrl', async () => {
  const d = fakeSlides({ platform: 'Win32' });
  await d.run('run', { steps: [{ slide: { index: 2 } }, { notes: [] }] });
  assert.ok(keys(d.log).includes('key:Ctrl+Alt+Shift+s'));
});

// ------------------------------------------------------------ human typing

test('typeText plays a typing plan as keystrokes: characters, typo fixes, bold toggles and lists', async () => {
  const d = fakeSlides();
  const blocks = [
    { t: 'p', before: 0, keys: [{ c: 'H', d: 1 }, { c: 'x', d: 1 }, { k: 'Backspace', d: 1 }, { c: 'i', d: 1 }, { c: ' ', d: 1 }, { f: 'b', d: 1 }, { c: 'B', d: 1 }, { f: 'b', d: 1 }] },
    { t: 'li', list: 'bullet', depth: 1, before: 1, keys: [{ c: '!', d: 1 }] },
  ];
  const r = await d.run('run', { steps: [{ slide: { index: 2 } }, { shape: { index: 2 } }, { typeText: { mode: 'replace', blocks, level: 0, text: 'Hi B\n!' } }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(d.pages[1].shapes[1].text, 'Hi B\n!');
  assert.deepEqual(r.results[2], { step: 3, action: 'typeText', pageId: 'g2', typed: 'Hi B\n!', chars: 5, objectId: 'g2_b', index: 2 });
  const k = d.log.filter((l) => /^(char|key:(Meta\+b|Meta\+Shift\+8|Tab|Enter|Backspace))/.test(l));
  assert.deepEqual(k, ['key:Enter', 'key:Backspace', 'char:H', 'char:x', 'key:Backspace', 'char:i', 'char: ', 'key:Meta+b', 'char:B', 'key:Meta+b', 'key:Enter', 'key:Meta+Shift+8', 'key:Tab', 'char:!']);
  assert.ok(!d.log.includes('KEYPRESS-OUTSIDE-TEXT'));
  // keydown carries the key's own code, never the character code (46 would be Delete).
  assert.deepEqual(d.typedKeydowns.find((x) => x.key === '!'), { key: '!', keyCode: 49 });
});

test('typeText append puts the caret at the end and starts a new paragraph after existing text', async () => {
  const d = fakeSlides();
  const r = await d.run('run', { steps: [{ slide: { index: 2 } }, { notesFocus: true }, { typeText: { mode: 'append', blocks: [{ t: 'p', keys: [{ c: 'Z', d: 1 }] }], text: 'Z' } }] });
  assert.equal(r.ok, true, r.message);
  assert.equal(d.pages[1].notes, 'old notes\nZ');
});

test('typeText continuing a paragraph does not press Enter first', async () => {
  const d = fakeSlides();
  await d.run('run', { steps: [{ slide: { index: 2 } }, { shape: { index: 1 } }, { typeText: { mode: 'append', blocks: [{ t: 'p', cont: true, keys: [{ c: '!', d: 1 }] }], text: '!' } }] });
  assert.equal(d.pages[1].shapes[0].text, 'Old title!');
});
