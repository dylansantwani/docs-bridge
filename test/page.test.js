/**
 * docsPageOp and the list/copy/template page functions are serialised into
 * Docs tabs by chrome.scripting, so they must not reference anything outside
 * themselves. These tests compile each function from its source text inside a
 * fresh VM context that contains only browser-shaped globals, then drive it
 * against a scripted fake of the Docs editor: its hidden input, toolbar state,
 * menu bar, colour palette and Find dialog.
 *
 * The key/paste/menu sequences asserted here are the ones verified live
 * against docs.google.com (see AGENTS.md); they are regression locks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { docsPageOp } from '../extension/page/docs-page.js';
import { listDocsPage, makeCopyPage, listTemplatesPage } from '../extension/page/list-page.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

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
}

function el(props = {}) {
  const e = {
    textContent: '',
    childElementCount: 0,
    attrs: {},
    style: {},
    classes: new Set(),
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    focus() {},
    blur() {},
    select() {},
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

/**
 * A fake Docs editor.
 * - `blocks` is the saved document (what /mobilebasic returns).
 * - `tb` is the toolbar state the page reads; shortcuts update it the way
 *   Docs does (lists toggle, styles set, bold toggles, sizes step).
 * - The menu bar exposes a small tree; the palette has named swatches.
 */
function fakeDocs({ blocks = [{ tag: 'p', text: 'hello world' }], editable = true, acceptPaste = true, platform = 'MacIntel', modeSwitcher = true, header = null, toolbar = {}, fontButtonKind = 'list' } = {}) {
  const log = [];
  const tb = { style: 'Normal text', font: 'Arial', size: 11, bold: false, italic: false, underline: false, list: null, ...toolbar };
  const docText = () => blocks.map((b) => b.text).join('\n');
  const find = { query: '', total: 0, current: 0, frozen: false };

  // ---- Find dialog
  const counter = el();
  Object.defineProperty(counter, 'textContent', { get: () => (find.total ? `${find.current} of ${find.total}` : '') });
  const findInput = el({ value: '' });
  findInput.dispatchEvent = (ev) => {
    if (ev.type === 'input') {
      if (find.frozen) return true;
      find.query = findInput.value;
      const q = find.query.toLowerCase();
      find.total = q ? docText().toLowerCase().split(q).length - 1 : 0;
      find.current = find.total ? 1 : 0;
      log.push(`find:${find.query}`);
    }
    if (ev.type === 'keydown') log.push(`find-key:${ev.key}`);
    return true;
  };
  const replaceInput = el({ value: '', dispatchEvent: () => true });
  const next = el({
    textContent: 'Next',
    click() {
      if (find.total) find.current = (find.current % find.total) + 1;
      log.push(`next->${find.current}`);
    },
  });
  const replaceAll = el({
    textContent: 'Replace all',
    click() {
      log.push(`replace-all:${find.query}->${replaceInput.value}`);
      find.total = 0;
      find.current = 0;
    },
  });
  const dialog = el({
    textContent: 'Find and replace Find Replace with Match case',
    querySelector: (sel) => (sel === 'input[type="text"]' ? findInput : null),
    querySelectorAll: (sel) => {
      if (sel === 'input[type="text"]') return [findInput, replaceInput];
      if (sel === 'button') return [replaceAll, next];
      if (sel === '*') return [counter];
      return [];
    },
  });
  let findOpen = false;

  // ---- menus: {label: subtree | action}
  const toggles = { Strikethrough: false, Superscript: false };
  const MENU = {
    Format: {
      Text: { Strikethrough: 'toggle', Superscript: 'toggle' },
      'Paragraph styles': { Title: { "Apply 'Title'": () => (tb.style = 'Title') }, Subtitle: { "Apply 'Subtitle'": () => (tb.style = 'Subtitle') } },
      Table: { 'Insert row below': () => log.push('action:insert-row-below'), 'Delete table': 'disabled' },
      'Line & paragraph spacing': { Single: () => log.push('action:spacing-1'), Double: () => log.push('action:spacing-2') },
    },
    Insert: { Break: { 'Page break': () => log.push('action:page-break') } },
  };
  let openLevels = [];
  const menuEl = (items) => el({ querySelectorAll: (sel) => (sel === '.goog-menuitem' ? items : []) });
  function buildItems(tree) {
    return Object.entries(tree).map(([label, node]) => {
      const item = el({ textContent: label });
      if (node === 'disabled') item.classes.add('goog-menuitem-disabled');
      if (node === 'toggle' && toggles[label]) item.classes.add('goog-option-selected');
      item.dispatchEvent = (ev) => {
        if (typeof node === 'object' && (ev.type === 'mousedown' || ev.type === 'mouseover')) {
          const depth = openLevels.findIndex((lvl) => lvl.includes(item));
          openLevels = openLevels.slice(0, depth + 1);
          openLevels.push(buildItems(node));
        }
        if (ev.type === 'click' && typeof node !== 'object') {
          if (node === 'toggle') {
            toggles[label] = !toggles[label];
            log.push(`menu:${label}=${toggles[label]}`);
          } else if (typeof node === 'function') node();
          openLevels = [];
        }
        return true;
      };
      return item;
    });
  }
  const menubar = Object.keys(MENU).map((label) => {
    const b = el({ textContent: label });
    b.dispatchEvent = (ev) => {
      if (ev.type === 'mousedown') openLevels = [buildItems(MENU[label])];
      return true;
    };
    return b;
  });

  // ---- palette + font menu
  let paletteOpen = false;
  let paletteFor = null;
  const swatches = ['black', 'red', 'yellow', 'dark blue 2'].map((name) => {
    const c = el({ attrs: { 'aria-label': name } });
    c.dispatchEvent = (ev) => {
      if (ev.type === 'click') {
        log.push(`color:${paletteFor}=${name}`);
        paletteOpen = false;
      }
      return true;
    };
    c.offsetParent = {};
    return c;
  });
  const colorButton = (id) => {
    const b = el({ id });
    b.dispatchEvent = (ev) => {
      if (ev.type === 'mousedown') {
        paletteOpen = true;
        paletteFor = id;
      }
      return true;
    };
    return b;
  };
  const fontItems = ['Arial', 'Georgia', 'Roboto'].map((name) => {
    const it = el({ textContent: name });
    it.dispatchEvent = (ev) => {
      if (ev.type === 'click') {
        tb.font = name;
        log.push(`font:${name}`);
        openLevels = [];
      }
      return true;
    };
    return it;
  });
  const fontButton = el({ attrs: {} });
  // 'list': the old "Font list. X selected." label; 'id': #docs-font-family labelled "Font" (Docs since 2026-10).
  Object.defineProperty(fontButton.attrs, 'aria-label', { get: () => (fontButtonKind === 'id' ? 'Font' : `Font list. ${tb.font} selected.`), enumerable: true });
  Object.defineProperty(fontButton, 'textContent', { get: () => (fontButtonKind === 'id' ? tb.font : ''), enumerable: true });
  fontButton.dispatchEvent = (ev) => {
    if (ev.type === 'mousedown') openLevels = [fontItems];
    return true;
  };

  // ---- editor input
  const LIST = { 8: 'bullet', 7: 'numbered', 9: 'checklist' };
  const editor = el();
  const typed = { text: '', keydowns: [] };
  editor.dispatchEvent = (ev) => {
    if (ev.type === 'keypress' && ev.key !== 'Enter') {
      log.push(`char:${ev.key}`);
      typed.text += String.fromCodePoint(ev.charCode);
      ev.preventDefault();
      return true;
    }
    if (ev.type === 'keydown' && !ev.metaKey && !ev.ctrlKey && ev.key.length === 1) {
      // Printable keys: record the key code Docs sees; the character itself
      // arrives on keypress.
      typed.keydowns.push({ key: ev.key, keyCode: ev.keyCode, shift: !!ev.shiftKey });
      return true;
    }
    if (ev.type === 'keydown' && ev.key === 'Backspace') typed.text = [...typed.text].slice(0, -1).join('');
    if (ev.type === 'keydown') {
      const mods = [ev.metaKey && 'Meta', ev.ctrlKey && 'Ctrl', ev.altKey && 'Alt', ev.shiftKey && 'Shift'].filter(Boolean);
      const chord = [...mods, ev.key].join('+');
      log.push(`key:${chord}`);
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.shiftKey && ev.key === 'h') findOpen = true;
      if (mod && ev.shiftKey && LIST[ev.key]) tb.list = tb.list === LIST[ev.key] ? null : LIST[ev.key];
      if (mod && ev.altKey && /^[0-6]$/.test(ev.key)) tb.style = ev.key === '0' ? 'Normal text' : `Heading ${ev.key}`;
      if (mod && !ev.shiftKey && !ev.altKey && ev.key === 'b') tb.bold = !tb.bold;
      if (mod && ev.shiftKey && ev.key === '.') tb.size++;
      if (mod && ev.shiftKey && ev.key === ',') tb.size--;
    }
    if (ev.type === 'paste') {
      log.push(`paste:${ev.clipboardData.getData('text/html')}`);
      if (acceptPaste) {
        ev.preventDefault();
        typed.text += ev.clipboardData.getData('text/plain');
      }
    }
    return true;
  };

  const pressedButton = (id, prop) => {
    const b = el({ id, attrs: {} });
    Object.defineProperty(b.attrs, 'aria-pressed', { get: () => String(typeof prop === 'function' ? prop() : tb[prop]), enumerable: true });
    return b;
  };
  const byId = {
    boldButton: pressedButton('boldButton', 'bold'),
    italicButton: pressedButton('italicButton', 'italic'),
    underlineButton: pressedButton('underlineButton', 'underline'),
    addBulletButton: pressedButton('addBulletButton', () => tb.list === 'bullet'),
    addNumberedBulletButton: pressedButton('addNumberedBulletButton', () => tb.list === 'numbered'),
    addChecklistButton: pressedButton('addChecklistButton', () => tb.list === 'checklist'),
    textColorButton: colorButton('textColorButton'),
    bgColorButton: colorButton('bgColorButton'),
  };
  const stylesBox = el({ attrs: {} });
  Object.defineProperty(stylesBox.attrs, 'aria-label', { get: () => `Styles list. ${tb.style} selected.`, enumerable: true });
  const sizeInput = el();
  Object.defineProperty(sizeInput, 'value', { get: () => String(tb.size) });

  const titleInput = el({ value: 'Old', dispatchEvent: () => true });
  const document = {
    title: 'Old - Google Docs',
    body: el({ textContent: '' }),
    activeElement: null,
    getElementById: (id) => byId[id] || null,
    querySelector(sel) {
      if (sel === 'iframe.docs-texteventtarget-iframe') return { contentDocument: { querySelector: () => editor } };
      if (sel === 'input.docs-title-input') return titleInput;
      if (sel === '#docs-toolbar-mode-switcher') return modeSwitcher ? el({ textContent: editable ? 'Editing' : 'Viewing' }) : null;
      if (sel.startsWith('#docs-header')) return el({ textContent: header ?? (editable ? 'File Edit View' : 'View only') });
      if (sel === '#boldButton, #docs-toolbar') return editable ? el() : null;
      if (sel === '[aria-label^="Styles list"]') return stylesBox;
      if (sel === '[aria-label^="Font list"]') return fontButtonKind === 'list' ? fontButton : null;
      if (sel === '#docs-font-family') return fontButtonKind === 'id' ? fontButton : null;
      if (sel === 'input[aria-label="Font size"]') return sizeInput;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[role="dialog"]') return findOpen ? [dialog] : [];
      if (sel.startsWith('#docs-menubar')) return menubar;
      if (sel === '.goog-menu') return openLevels.map(menuEl);
      if (sel.startsWith('.docs-material-colorpalette-cell')) return paletteOpen ? swatches : [];
      return [];
    },
  };
  titleInput.dispatchEvent = (ev) => {
    if (ev.type === 'keydown' && ev.key === 'Enter') document.title = `${titleInput.value} - Google Docs`;
    return true;
  };

  const esc = (t) => t.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;');
  const mobilebasic = () =>
    `<html><style>.doc-content{}</style><body><div class="doc-content" style="x">` +
    blocks
      .map((b) =>
        b.tag === 'li'
          ? `<ul class="lst-kix_abc-${b.depth || 0} start"><li style="margin-left:36pt"><span>${esc(b.text)}</span></li></ul>`
          : b.inTable
            ? `<table><tr><td><p><span>${esc(b.text)}</span></p></td></tr></table>`
            : `<${b.tag}${b.cls ? ` class="${b.cls}"` : ''} style="text-align:${b.align || 'left'};font-family:&quot;Arial&quot;"><span${b.style ? ` style="${b.style}"` : ''}>${esc(b.text)}</span></${b.tag}>`
      )
      .join('') +
    `</div><script>window.x=1</script></body></html>`;

  const context = vm.createContext({
    navigator: { platform, userAgent: platform === 'MacIntel' ? 'Mac' : 'Windows' },
    performance: { now: () => performance.now() },
    MessageChannel,
    AbortController,
    setTimeout,
    document,
    window: {},
    location: { pathname: `/document/d/${ID}/edit`, search: '', host: 'docs.google.com', href: `https://docs.google.com/document/d/${ID}/edit` },
    fetch: async (url) => {
      log.push(`fetch:${url}`);
      return { ok: true, status: 200, text: async () => mobilebasic() };
    },
    KeyboardEvent: FakeEvent,
    ClipboardEvent: FakeEvent,
    InputEvent: FakeEvent,
    MouseEvent: FakeEvent,
    FocusEvent: FakeEvent,
    TransitionEvent: FakeEvent,
    AnimationEvent: FakeEvent,
    Event: FakeEvent,
    DataTransfer: FakeDataTransfer,
    URLSearchParams,
    getComputedStyle: () => ({}),
  });
  const inner = vm.runInContext(`(${docsPageOp.toString()})`, context);
  // Results come from another realm; round-trip them so deepEqual compares
  // values rather than prototypes.
  const run = async (op, args) => JSON.parse(JSON.stringify(await inner(op, args)));
  return { run, log, find, tb, toggles, document, blocks, typed, context };
}

const content = (blocks, extra = {}) => ({ html: '<p>x</p>', inlineHtml: null, text: 'x', lastKind: 'p', probes: [], blocks, ...extra });
const P = (html) => ({ t: 'p', html });
const keys = (log) => log.filter((l) => /^(key|paste|menu|color|font|action):/.test(l));
const span = (h) => `paste:<span>${h}</span>`;

// ------------------------------------------------------------ fundamentals

test('the page function is self-contained: it runs with nothing but browser globals', async () => {
  const { run } = fakeDocs();
  assert.deepEqual(await run('no-such-op', {}), { ok: false, code: 'bad_args', message: 'unknown page op: no-such-op' });
});

test('state reports readiness, id, title and edit mode', async () => {
  const s = await fakeDocs().run('state', {});
  assert.equal(s.ready, true);
  assert.equal(s.docId, ID);
  assert.equal(s.title, 'Old');
  assert.equal(s.editable, true);
  assert.equal(s.mode, 'editing');
});

test('blocks parse mobilebasic into text, lists, titles, alignment and formatting runs', async () => {
  const { run } = fakeDocs({
    blocks: [
      { tag: 'p', cls: 'title', text: 'A & B' },
      { tag: 'li', text: 'item one', depth: 1 },
      { tag: 'h2', text: 'Centered', align: 'center', style: 'font-weight:700;color:#ff0000' },
      { tag: 'p', text: 'in a cell', inTable: true },
    ],
  });
  const { blocks } = await run('blocks', {});
  assert.equal(blocks[0].cls, 'title');
  assert.equal(blocks[0].text, 'A & B');
  assert.deepEqual(blocks[1].list, { ordered: false, depth: 1 });
  assert.equal(blocks[2].align, 'center');
  assert.equal(blocks[2].runs[0].style['font-weight'], '700');
  assert.equal(blocks[2].runs[0].style['font-family'], 'Arial', 'entity-quoted font names are decoded before splitting');
  assert.equal(blocks[3].inTable, true);
});

test('toolbar reports style, font, size, toggles and list type', async () => {
  const { run } = fakeDocs({ toolbar: { style: 'Heading 2', bold: true, list: 'numbered', size: 14, font: 'Georgia' } });
  const { toolbar } = await run('toolbar', {});
  assert.deepEqual(toolbar, { style: 'Heading 2', font: 'Georgia', size: 14, bold: true, italic: false, underline: false, list: 'numbered' });
});

test('the font dropdown is found by its id now that Docs labels it just "Font"', async () => {
  const d = fakeDocs({ toolbar: { font: 'Georgia' }, fontButtonKind: 'id' });
  const { toolbar } = await d.run('toolbar', {});
  assert.equal(toolbar.font, 'Georgia');
  const r = await d.run('edit', { steps: [{ find: 'hello' }, { format: { font: 'Roboto' } }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(keys(d.log).includes('font:Roboto'));
  assert.equal(d.tb.font, 'Roboto');
});

// ------------------------------------------------------------ typing engine

test('append types blocks in the document styles: fresh paragraph, heading level, then Normal text', async () => {
  const d = fakeDocs({ blocks: [{ tag: 'p', text: 'last line' }] });
  const r = await d.run('write', { mode: 'append', content: content([{ t: 'h', level: 2, html: 'Title' }, P('Body <b>x</b>')]) });
  assert.equal(r.ok, true);
  assert.deepEqual(keys(d.log), ['key:Meta+ArrowDown', 'key:Enter', 'key:Meta+Alt+2', span('Title'), 'key:Enter', 'key:Meta+Alt+0', span('Body <b>x</b>')]);
});

test('append reuses a trailing empty paragraph instead of stacking blank lines', async () => {
  const d = fakeDocs({ blocks: [{ tag: 'p', text: 'last' }, { tag: 'p', text: '' }] });
  await d.run('write', { mode: 'append', content: content([P('new')]) });
  assert.deepEqual(keys(d.log), ['key:Meta+ArrowDown', 'key:Meta+Alt+0', span('new')]);
});

test('lists: bullet with nesting via Tab, a type switch keeps depth, leaving the list toggles it off', async () => {
  const d = fakeDocs();
  await d.run('write', {
    mode: 'append',
    content: content([
      { t: 'li', list: 'bullet', depth: 0, html: 'a' },
      { t: 'li', list: 'bullet', depth: 1, html: 'b' },
      { t: 'li', list: 'numbered', depth: 0, html: 'c' },
      P('after'),
    ]),
  });
  assert.deepEqual(keys(d.log), [
    'key:Meta+ArrowDown',
    'key:Enter',
    'key:Meta+Alt+0',
    'key:Meta+Shift+8',
    span('a'),
    'key:Enter',
    'key:Tab',
    span('b'),
    'key:Enter',
    'key:Meta+Shift+7',
    'key:Shift+Tab',
    span('c'),
    'key:Enter',
    'key:Meta+Shift+7',
    'key:Meta+Alt+0',
    span('after'),
  ]);
});

test('typing starts from the list state the toolbar reports (Enter after a list item continues the list)', async () => {
  const d = fakeDocs({ toolbar: { list: 'bullet' } });
  await d.run('write', { mode: 'append', content: content([P('plain')]) });
  assert.deepEqual(keys(d.log).slice(2), ['key:Meta+Shift+8', 'key:Meta+Alt+0', span('plain')]);
});

test('quotes indent and un-indent; tables paste after the previous paragraph; page breaks; typing continues after', async () => {
  const d = fakeDocs({ blocks: [{ tag: 'p', text: '' }] });
  await d.run('write', {
    mode: 'append',
    content: content([{ t: 'quote', html: 'q' }, { t: 'table', html: '<table><tr><td>1</td></tr></table>' }, P('after'), { t: 'pagebreak' }, P('next page')]),
  });
  assert.deepEqual(keys(d.log), [
    'key:Meta+ArrowDown',
    'key:Meta+Alt+0',
    'key:Meta+]',
    span('q'),
    // a table goes at the end of the previous paragraph, no Enter (live: that avoids a stray empty paragraph)
    'paste:<table><tr><td>1</td></tr></table>',
    'key:Meta+[',
    'key:Meta+Alt+0',
    span('after'),
    'key:Enter',
    'key:Meta+Enter',
    'key:Meta+Alt+0',
    span('next page'),
  ]);
});

test('prepend and replace_document type into a fresh or cleared paragraph', async () => {
  const pre = fakeDocs();
  await pre.run('write', { mode: 'prepend', content: content([P('top')]) });
  assert.deepEqual(keys(pre.log), ['key:Meta+ArrowUp', 'key:Enter', 'key:ArrowUp', 'key:Meta+Alt+0', span('top')]);
  const rep = fakeDocs();
  await rep.run('write', { mode: 'replace_document', content: content([{ t: 'h', level: 1, html: 'T' }]) });
  assert.deepEqual(keys(rep.log), ['key:Meta+a', 'key:Backspace', 'key:Meta+Alt+1', span('T')]);
});

test('insert_after / insert_before blocks use robust paragraph navigation', async () => {
  const after = fakeDocs();
  await after.run('write', { mode: 'insert_after', anchor: 'world', content: content([P('p')]) });
  assert.deepEqual(keys(after.log), ['key:Meta+Shift+h', 'key:ArrowRight', 'key:Alt+ArrowUp', 'key:Alt+ArrowDown', 'key:Enter', 'key:Meta+Alt+0', span('p')]);
  const before = fakeDocs();
  await before.run('write', { mode: 'insert_before', anchor: 'hello', content: content([P('p')]) });
  assert.deepEqual(keys(before.log), ['key:Meta+Shift+h', 'key:ArrowLeft', 'key:Alt+ArrowDown', 'key:Alt+ArrowUp', 'key:Enter', 'key:ArrowUp', 'key:Meta+Alt+0', span('p')]);
});

test('paragraph navigation uses Ctrl off macOS', async () => {
  const d = fakeDocs({ platform: 'Win32' });
  await d.run('write', { mode: 'insert_after', anchor: 'world', content: content([P('p')]) });
  assert.deepEqual(keys(d.log).slice(0, 5), ['key:Ctrl+Shift+h', 'key:ArrowRight', 'key:Ctrl+ArrowUp', 'key:Ctrl+ArrowDown', 'key:Enter']);
  assert.ok(keys(d.log).includes('key:Ctrl+Alt+0'));
});

test('inline inserts and replacements splice text without new paragraphs; delete uses Backspace', async () => {
  const ins = fakeDocs();
  await ins.run('write', { mode: 'insert_after', anchor: 'hello', content: content([P('x')], { inlineHtml: '&nbsp;x' }) });
  assert.deepEqual(keys(ins.log), ['key:Meta+Shift+h', 'key:ArrowRight', 'paste:&nbsp;x']);
  const rep = fakeDocs();
  await rep.run('write', { mode: 'replace_text', anchor: 'world', content: content([P('there')], { inlineHtml: 'there' }) });
  assert.deepEqual(keys(rep.log), ['key:Meta+Shift+h', 'paste:there']);
  const whole = fakeDocs({ blocks: [{ tag: 'p', text: 'Placeholder paragraph' }] });
  await whole.run('write', { mode: 'replace_text', anchor: 'Placeholder paragraph', content: content([{ t: 'h', level: 2, html: 'Real' }]) });
  assert.deepEqual(keys(whole.log), ['key:Meta+Shift+h', 'key:Backspace', 'key:Meta+Alt+2', span('Real')]);
  const del = fakeDocs();
  await del.run('write', { mode: 'replace_text', anchor: 'world', content: null });
  assert.deepEqual(keys(del.log), ['key:Meta+Shift+h', 'key:Backspace']);
});

test('replace_section selects the body under a heading up to the next same-level heading and types over it', async () => {
  const d = fakeDocs({
    blocks: [
      { tag: 'h1', text: 'Attendees' },
      { tag: 'p', text: 'Wendy Writer, CEO' },
      { tag: 'p', text: 'Ronny Reader, CFO' },
      { tag: 'h2', text: 'Sub' },
      { tag: 'p', text: 'sub body' },
      { tag: 'h1', text: 'Agenda' },
      { tag: 'p', text: 'lorem' },
    ],
  });
  const r = await d.run('write', { mode: 'replace_section', anchor: 'attendees', content: content([P('Dylan'), P('Pat')]) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(keys(d.log), [
    'key:Meta+Shift+h',
    'key:ArrowRight',
    'key:Alt+ArrowUp',
    'key:Alt+ArrowDown',
    'key:ArrowRight',
    'key:Alt+Shift+ArrowDown',
    'key:Alt+Shift+ArrowDown',
    'key:Alt+Shift+ArrowDown',
    'key:Alt+Shift+ArrowDown',
    'key:Backspace',
    'key:Meta+Alt+0',
    span('Dylan'),
    'key:Enter',
    'key:Meta+Alt+0',
    span('Pat'),
  ]);
});

test('replace_section on an empty section starts a paragraph after the heading; unknown headings list the real ones', async () => {
  const d = fakeDocs({ blocks: [{ tag: 'h1', text: 'Notes' }, { tag: 'h1', text: 'Next' }] });
  await d.run('write', { mode: 'replace_section', anchor: 'Notes', content: content([P('n')]) });
  assert.deepEqual(keys(d.log).slice(-4), ['key:Alt+ArrowDown', 'key:Enter', 'key:Meta+Alt+0', span('n')]);
  const miss = await d.run('write', { mode: 'replace_section', anchor: 'Nope', content: content([P('n')]) });
  assert.equal(miss.code, 'section_not_found');
  assert.match(miss.message, /"Notes", "Next"/);
});

test('sections containing tables are refused rather than guessed at', async () => {
  const d = fakeDocs({ blocks: [{ tag: 'h1', text: 'Data' }, { tag: 'p', text: 'cell', inTable: true }, { tag: 'h1', text: 'After' }] });
  const r = await d.run('write', { mode: 'replace_section', anchor: 'Data', content: content([P('x')]) });
  assert.equal(r.code, 'unsupported');
  assert.ok(!keys(d.log).some((k) => k.startsWith('paste:')));
});

// ------------------------------------------------------------ edit steps

test('edit: find then format uses toolbar state, shortcuts, menus, the font menu and the palette', async () => {
  const d = fakeDocs({ blocks: [{ tag: 'p', text: 'alpha bravo' }] });
  const r = await d.run('edit', {
    steps: [{ find: { text: 'bravo' } }, { format: { bold: true, strikethrough: true, color: 'red', style: 'title', align: 'center', size: 14, font: 'Georgia', list: 'bullet' } }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.known, 'bravo');
  const k = keys(d.log);
  assert.ok(k.includes('key:Meta+b'), 'bold shortcut');
  assert.ok(k.includes('menu:Strikethrough=true'), 'strikethrough through Format > Text');
  assert.equal(d.tb.style, 'Title', 'title through Format > Paragraph styles');
  assert.ok(k.includes('key:Meta+Shift+e'), 'center');
  assert.equal(k.filter((x) => x === 'key:Meta+Shift+.').length, 3, 'size stepped 11 → 14');
  assert.ok(k.includes('font:Georgia'));
  assert.ok(k.includes('color:textColorButton=red'));
  assert.ok(k.includes('key:Meta+Shift+8'));
  assert.deepEqual(r.results[1].applied, ['style:title', 'bold:on', 'strikethrough:on', 'align:center', 'list:bullet', 'size:14', 'font:Georgia', 'color:red']);
});

test('edit: toggles only press when needed; "off" on an unpressed toggle normalises a mixed selection', async () => {
  const on = fakeDocs({ toolbar: { bold: true } });
  await on.run('edit', { steps: [{ find: 'hello' }, { format: { bold: true } }] });
  assert.ok(!keys(on.log).includes('key:Meta+b'), 'already bold: no press');
  const off = fakeDocs({ toolbar: { bold: false } });
  await off.run('edit', { steps: [{ find: 'hello' }, { format: { bold: false } }] });
  assert.equal(keys(off.log).filter((x) => x === 'key:Meta+b').length, 2);
});

test('edit: a checked menu toggle is left alone when it already matches', async () => {
  const d = fakeDocs();
  d.toggles.Strikethrough = true;
  const r = await d.run('edit', { steps: [{ find: 'hello' }, { format: { strikethrough: true } }] });
  assert.equal(r.ok, true);
  assert.ok(!keys(d.log).some((x) => x.startsWith('menu:Strikethrough')));
});

test('edit: colours and fonts outside the palette/menu fall back to a styled re-paste of known text', async () => {
  const d = fakeDocs();
  await d.run('edit', { steps: [{ find: 'hello' }, { format: { color: '#123456', font: 'Comic Neue' } }] });
  const pastes = keys(d.log).filter((x) => x.startsWith('paste:'));
  assert.ok(pastes.includes(`paste:<span style="font-family:'Comic Neue'">hello</span>`));
  assert.ok(pastes.includes('paste:<span style="color:#123456">hello</span>'));
  const noText = await fakeDocs().run('edit', { steps: [{ select: 'paragraph' }, { format: { color: 'chartreuse-ish' } }] });
  assert.equal(noText.code, 'color_unavailable');
  assert.match(noText.message, /black, red, yellow/);
});

test('edit: link re-pastes the found text as a link; it needs a find selection', async () => {
  const d = fakeDocs();
  await d.run('edit', { steps: [{ find: 'hello' }, { format: { link: 'https://example.com/?a=1&b=2' } }] });
  assert.ok(keys(d.log).includes('paste:<a href="https://example.com/?a=1&amp;b=2">hello</a>'));
  const r = await fakeDocs().run('edit', { steps: [{ caret: 'end' }, { format: { link: 'https://x.y' } }] });
  assert.equal(r.code, 'need_text');
});

test('edit: menu paths walk submenus; bad and disabled items explain themselves', async () => {
  const d = fakeDocs();
  const ok = await d.run('edit', { steps: [{ menu: 'Format > Table > Insert row below' }, { menu: 'Insert > Break > Page break' }] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(d.log.includes('action:insert-row-below'));
  assert.ok(d.log.includes('action:page-break'));
  const bad = await d.run('edit', { steps: [{ menu: 'Format > Nonsense' }] });
  assert.equal(bad.code, 'menu_not_found');
  assert.match(bad.message, /available: Text \| Paragraph styles \| Table/);
  const top = await d.run('edit', { steps: [{ menu: 'Bogus > X' }] });
  assert.match(top.message, /menus are Format, Insert/);
  const disabled = await d.run('edit', { steps: [{ menu: 'Format > Table > Delete table' }] });
  assert.equal(disabled.code, 'menu_disabled');
});

test('edit: caret, select, extend, keys, typing, undo — and a failing step reports what already ran', async () => {
  const d = fakeDocs();
  const r = await d.run('edit', {
    steps: [{ caret: 'end' }, { type: [P('typed')] }, { select: 'paragraph' }, { extend: { words: -2 } }, { key: 'Tab', times: 2 }, { inline: 'overwrite' }, { undo: 2 }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const k = keys(d.log);
  assert.ok(k.includes('key:Meta+ArrowDown'));
  assert.ok(k.includes(span('typed')));
  assert.equal(k.filter((x) => x === 'key:Alt+Shift+ArrowLeft').length, 2);
  assert.equal(k.filter((x) => x === 'key:Tab').length, 2);
  assert.equal(k.filter((x) => x === 'key:Meta+z').length, 2);
  const failing = await fakeDocs().run('edit', { steps: [{ caret: 'end' }, { find: 'zzz' }] });
  assert.equal(failing.code, 'anchor_not_found');
  assert.match(failing.message, /^step 2 \(find\)/);
  assert.deepEqual(failing.completed, [{ step: 1, action: 'caret' }]);
});

test('edit: steps with no recognised action are rejected', async () => {
  const r = await fakeDocs().run('edit', { steps: [{ dance: true }] });
  assert.equal(r.code, 'bad_args');
});

// ------------------------------------------------------------ find machinery

test('occurrence steps through matches with Next, waiting for each counter change', async () => {
  const d = fakeDocs({ blocks: [{ tag: 'p', text: 'x a x b x c' }] });
  const r = await d.run('write', { mode: 'insert_after', anchor: 'x', occurrence: 3, content: content([P('!')], { inlineHtml: '!' }) });
  assert.equal(r.anchorMatches, 3);
  assert.deepEqual(d.log.filter((l) => l.startsWith('next')), ['next->2', 'next->3']);
});

test('text the saved document has but Find cannot see is reported as a stall, before anything is typed', async () => {
  const d = fakeDocs();
  d.find.frozen = true;
  const r = await d.run('write', { mode: 'insert_after', anchor: 'hello', content: content([P('x')], { inlineHtml: 'x' }) });
  assert.equal(r.code, 'find_stalled');
  assert.match(r.message, /nothing was changed/);
  assert.ok(!keys(d.log).some((k) => k.startsWith('paste:') || k === 'key:ArrowRight'));
});

test('a missing anchor fails fast from the saved text, without opening Find', async () => {
  const d = fakeDocs();
  const r = await d.run('write', { mode: 'insert_after', anchor: 'zzz', content: content([P('x')], { inlineHtml: 'x' }) });
  assert.equal(r.code, 'anchor_not_found');
  assert.ok(!d.log.some((l) => l.startsWith('key:')));
});

test('replace_all and count use the dialog', async () => {
  const a = fakeDocs({ blocks: [{ tag: 'p', text: 'cat cat' }] });
  assert.deepEqual(await a.run('replace_all', { find: 'cat', replace: 'dog' }), { ok: true, replaced: 2 });
  assert.ok(a.log.includes('replace-all:cat->dog'));
  assert.deepEqual(await fakeDocs({ blocks: [{ tag: 'p', text: 'cat cat' }] }).run('count', { find: 'cat' }), { ok: true, matches: 2 });
});

test('read-only documents and swallowed pastes are errors, not silent successes', async () => {
  const viewer = fakeDocs({ modeSwitcher: false, header: 'Request edit access Share Sign in' });
  const s = await viewer.run('state', {});
  assert.equal(s.editable, false);
  assert.equal((await viewer.run('write', { mode: 'append', content: content([P('x')]) })).code, 'read_only');
  assert.equal((await viewer.run('edit', { steps: [{ caret: 'end' }] })).code, 'read_only');
  assert.equal((await fakeDocs({ acceptPaste: false }).run('write', { mode: 'append', content: content([P('x')]) })).code, 'paste_ignored');
});

test('title commits through click → input → Enter → blur and confirms via document.title', async () => {
  assert.deepEqual(await fakeDocs().run('title', { title: 'Fresh name' }), { ok: true, title: 'Fresh name', verified: true });
});

// ------------------------------------------------------------ other page functions

function vmRun(fn, globals) {
  const context = vm.createContext({ MessageChannel, performance: { now: () => performance.now() }, ...globals });
  const f = vm.runInContext(`(${fn.toString()})`, context);
  return async (...a) => JSON.parse(JSON.stringify(await f(...a)));
}

test('listDocsPage reads Drive rows by their semantic attributes', async () => {
  const row = {
    getAttribute: (k) => (k === 'data-id' ? ID : null),
    querySelector: (sel) => (sel === 'strong' ? { textContent: ' notes ' } : null),
    querySelectorAll: () => [{ getAttribute: () => 'Modified Sep 4' }, { getAttribute: () => 'Owned by yan@example.com' }, { getAttribute: () => 'Shared' }],
    scrollIntoView() {},
  };
  const list = vmRun(listDocsPage, { location: { host: 'drive.google.com' }, document: { body: { textContent: '' }, querySelectorAll: (s) => (s.includes('[role="row"]') ? [row] : []) } });
  assert.deepEqual((await list(5)).items, [{ id: ID, title: 'notes', modified: 'Sep 4', owner: 'yan@example.com', shared: true }]);
});

test('listDocsPage reads Drive grid-view tiles (an account can default to grid view)', async () => {
  // Shape of a real grid tile (drive.google.com, 2026-09-30): role=gridcell with
  // data-id, the title only in data-tooltip / aria-label, no modified or owner cells.
  const tile = (id, title, withTooltip = true) => ({
    getAttribute: (k) => ({ 'data-id': id, 'aria-label': `${title} Google Docs More info (Option + →)` })[k] ?? null,
    querySelector: (sel) => (sel === '[data-tooltip]' && withTooltip ? { getAttribute: () => `${title} Google Docs` } : null),
    querySelectorAll: () => [{ getAttribute: () => 'More actions' }],
    scrollIntoView() {},
  });
  const other = '1TestDocBIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const tiles = [tile(ID, 'Week 5 lab notes - draft.doc'), tile(other, 'Reading reflection', false)];
  const list = vmRun(listDocsPage, { location: { host: 'drive.google.com' }, document: { body: { textContent: '' }, querySelectorAll: (s) => (s.includes('[role="gridcell"]') ? tiles : []) } });
  assert.deepEqual((await list(5)).items, [
    { id: ID, title: 'Week 5 lab notes - draft.doc', modified: null, owner: null, shared: false },
    { id: other, title: 'Reading reflection', modified: null, owner: null, shared: false },
  ]);
});

test('makeCopyPage presses "Make a copy" and reports access problems', async () => {
  const events = [];
  const btn = { textContent: 'Make a copy', getBoundingClientRect: () => ({ x: 0, y: 0 }), dispatchEvent: (e) => events.push(e.type) };
  const copy = vmRun(makeCopyPage, { location: { host: 'docs.google.com' }, window: {}, MouseEvent: FakeEvent, document: { body: { textContent: '' }, querySelectorAll: () => [btn] } });
  assert.deepEqual(await copy(), { ok: true });
  assert.deepEqual(events, ['mousedown', 'mouseup', 'click']);
  const denied = vmRun(makeCopyPage, { location: { host: 'docs.google.com' }, window: {}, MouseEvent: FakeEvent, document: { body: { textContent: 'You need access' }, querySelectorAll: () => [] } });
  assert.equal((await denied()).code, 'no_access');
});

test('listTemplatesPage reads template ids from gallery thumbnails', async () => {
  const item = (id, name, style, suffix = '_400.png') => ({
    querySelector: () => ({ getAttribute: () => `https://ssl.gstatic.com/docs/templates/thumbnails/${id}${suffix}` }),
    querySelectorAll: () => [{ childElementCount: 0, textContent: name }, { childElementCount: 0, textContent: style }],
  });
  const t1 = '1ogrWWMsheGBcV6KkLiI4mrnBrKG9hnMz1eOdPREiyPI';
  const t2 = '10bJALGfGJG8BrzBSmG6EznIq6-84l1TZkQ-HC8jO368';
  const blank = { querySelector: () => ({ getAttribute: () => 'https://ssl.gstatic.com/docs/templates/thumbnails/docs-blank-googlecolors.png' }), querySelectorAll: () => [] };
  const list = vmRun(listTemplatesPage, { location: { host: 'docs.google.com' }, document: { querySelectorAll: () => [blank, item(t1, 'Meeting notes', 'Tropic', '_400_3.png'), item(t2, 'Resume', 'Coral')] } });
  assert.deepEqual((await list()).items, [
    { id: t1, name: 'Meeting notes', style: 'Tropic' },
    { id: t2, name: 'Resume', style: 'Coral' },
  ]);
});

// ------------------------------------------------------------ human typing

const K = (c, extra = {}) => ({ c, d: 0, ...extra });
const typingBlock = (keys, extra = {}) => ({ t: 'p', runs: [{ text: 'x' }], before: 0, keys, ...extra });
const chars = (text, safeAt = []) => [...text].map((c, i) => K(c, safeAt.includes(i) ? { s: 1 } : {}));

test('type: characters go in as keydown/keypress/keyup with the real key codes Docs expects', async () => {
  const { run, typed } = fakeDocs();
  const r = await run('type', {
    job: 'j1',
    blocks: [typingBlock([...chars('Hi! a1?'), { k: 'Backspace', d: 0 }, K('?'), { f: 'b', d: 0 }, K('B'), { f: 'b', d: 0 }, { p: '<span>😀</span>', x: '😀', d: 0 }])],
    at: { block: 0, event: 0, para: '' },
    state: { list: null, indent: 0, fresh: false },
    budgetMs: 60_000,
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.done, true);
  assert.equal(typed.text, 'Hi! a1?B😀');
  const kd = Object.fromEntries(typed.keydowns.map((k) => [k.key, [k.keyCode, k.shift]]));
  // "!" is Shift+1 (keyCode 49), never 33 (PageUp); "?" is Shift+/ (191).
  assert.deepEqual(kd['!'], [49, true]);
  assert.deepEqual(kd['?'], [191, true]);
  assert.deepEqual(kd.H, [72, true]);
  assert.deepEqual(kd.a, [65, false]);
  assert.deepEqual(kd['1'], [49, false]);
  assert.deepEqual(kd[' '], [32, false]);
  assert.equal(r.chars, 9);
});

test('type: bold/italic/underline/strikethrough toggles are the Docs shortcuts', async () => {
  const { run, log } = fakeDocs();
  await run('type', {
    blocks: [typingBlock([{ f: 'b', d: 0 }, { f: 'i', d: 0 }, { f: 'u', d: 0 }, { f: 's', d: 0 }])],
    at: { block: 0, event: 0, para: '' },
    state: { list: null, indent: 0, fresh: false },
  });
  assert.deepEqual(keys(log).filter((l) => l.startsWith('key:Meta') && !l.includes('Alt')), ['key:Meta+b', 'key:Meta+i', 'key:Meta+u', 'key:Meta+Shift+x']);
});

test('type: a tab is pressed as the Tab key (next table cell), not typed as a character', async () => {
  const { run, log, typed } = fakeDocs();
  const r = await run('type', {
    blocks: [typingBlock(chars('a\tb'))],
    at: { block: 0, event: 0, para: '' },
    state: { list: null, indent: 0, fresh: false },
    budgetMs: 60_000,
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(typed.text, 'ab');
  assert.ok(keys(log).includes('key:Tab'));
  assert.ok(!typed.keydowns.some((k) => k.key === '\t'));
  assert.equal(r.chars, 3);
});

test('type: the first chunk positions like docs_write, then opens each block with its style', async () => {
  const { run, log, typed } = fakeDocs({ blocks: [{ tag: 'p', text: 'existing' }] });
  const r = await run('type', {
    job: 'j',
    position: { mode: 'append' },
    blocks: [
      { t: 'h', level: 2, runs: [{ text: 'Hd' }], before: 0, keys: chars('Hd') },
      { t: 'li', list: 'bullet', depth: 0, runs: [{ text: 'a' }], before: 0, keys: chars('a') },
      { t: 'p', runs: [], before: 0, keys: [] },
    ],
    budgetMs: 60_000,
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(typed.text, 'Hda');
  const k = keys(log).filter((l) => !l.startsWith('char:') && !/^key:(Shift\+)?.$/.test(l));
  assert.deepEqual(k, [
    'key:Meta+ArrowDown',
    'key:Enter', // the last paragraph was not empty
    'key:Meta+Alt+2',
    'key:Enter',
    'key:Meta+Alt+0',
    'key:Meta+Shift+8',
    'key:Enter',
    'key:Meta+Shift+8', // leaving the list
    'key:Meta+Alt+0',
  ]);
  assert.deepEqual(r.state, { list: null, indent: 0, fresh: false });
});

test('type: inline mode splices into the anchor paragraph without starting a new one', async () => {
  const { run, log, typed } = fakeDocs({ blocks: [{ tag: 'p', text: 'alpha anchor-here omega' }] });
  const r = await run('type', {
    position: { mode: 'insert_after', anchor: 'anchor-here', inline: true },
    blocks: [typingBlock(chars(' [X]'))],
    budgetMs: 60_000,
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(typed.text, ' [X]');
  assert.ok(!keys(log).includes('key:Enter'));
  assert.ok(!keys(log).some((l) => l.startsWith('key:Meta+Alt')));
});

test('type: a spent budget stops at the next safe point and reports where, with a resume tail', async () => {
  const { run, typed } = fakeDocs();
  const text = 'The first words of a long paragraph go here and more';
  const safe = [...text].map((c, i) => (c !== ' ' && text[i + 1] === ' ' ? i : -1)).filter((i) => i > 25);
  const r = await run('type', {
    job: 'j',
    blocks: [typingBlock(chars(text, safe)), typingBlock(chars('next'))],
    at: { block: 0, event: 0, para: '' },
    state: { list: null, indent: 0, fresh: false },
    budgetMs: 0,
  });
  assert.equal(r.done, false);
  assert.equal(typed.text, text.slice(0, safe[0] + 1));
  assert.deepEqual({ block: r.at.block, event: r.at.event }, { block: 0, event: safe[0] + 1 });
  assert.equal(r.at.para, typed.text);
  assert.equal(r.tail, typed.text);
});

test('type: resuming in a fresh tab re-finds the tail with Find, or goes to the end', async () => {
  const para = 'The first words of a long paragraph go';
  const d = fakeDocs({ blocks: [{ tag: 'p', text: `${para} ` }] });
  const r = await d.run('type', {
    blocks: [typingBlock(chars(`${para} here`))],
    at: { block: 0, event: para.length, para },
    state: { list: null, indent: 0, fresh: false },
    resume: { tail: para },
    budgetMs: 60_000,
  });
  assert.equal(r.ok, true, r.message);
  assert.ok(d.log.includes(`find:${para}`));
  assert.equal(d.typed.text, ' here');
  const afterFind = keys(d.log).filter((l) => !l.startsWith('char:'));
  assert.ok(afterFind.includes('key:ArrowRight'), 'collapses the selection after the tail');

  const e = fakeDocs();
  await e.run('type', { blocks: [typingBlock(chars('ab'))], at: { block: 0, event: 1, para: 'a' }, state: { list: null, indent: 0, fresh: false }, resume: { byEnd: true } });
  assert.equal(keys(e.log)[0], 'key:Meta+ArrowDown');
  assert.equal(e.typed.text, 'b');
});

test('type: an ambiguous resume anchor is refused instead of typing in the wrong place', async () => {
  const tail = 'the same sentence appears twice';
  const { run, typed } = fakeDocs({ blocks: [{ tag: 'p', text: tail }, { tag: 'p', text: tail }] });
  const r = await run('type', { blocks: [typingBlock(chars('x'))], at: { block: 0, event: 0, para: '' }, resume: { tail } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'resume_ambiguous');
  assert.equal(typed.text, '');
});

test('type: a failure mid-block reports exactly how far it got, and the block state', async () => {
  const { run } = fakeDocs({ acceptPaste: false });
  const text = 'Twenty-plus characters typed before';
  const r = await run('type', {
    blocks: [typingBlock([...chars(text), { p: '<span>😀</span>', x: '😀', d: 0 }])],
    at: { block: 0, event: 0, para: '' },
    state: { list: null, indent: 0, fresh: false },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'paste_ignored');
  assert.deepEqual({ block: r.typing.reached.block, event: r.typing.reached.event }, { block: 0, event: text.length });
  assert.equal(r.typing.reached.para, text);
  assert.equal(r.typing.reached.tail, 'plus characters typed before'); // cut at the hyphen, which Docs may autocorrect
  assert.equal(r.typing.chars, text.length);
  assert.deepEqual(r.typing.state, { list: null, indent: 0, fresh: false });
});

test('type: a stop request from the job ends the chunk at the next safe point', async () => {
  const d = fakeDocs();
  const text = 'Stop me somewhere in the middle of this sentence please';
  const safe = [...text].map((c, i) => (c !== ' ' && text[i + 1] === ' ' ? i : -1)).filter((i) => i > 0);
  const running = d.run('type', {
    job: 'jstop',
    blocks: [typingBlock(chars(text, safe).map((k) => ({ ...k, d: 5 })))],
    at: { block: 0, event: 0, para: '' },
    state: { list: null, indent: 0, fresh: false },
    budgetMs: 60_000,
  });
  await new Promise((r) => setTimeout(r, 40));
  vm.runInContext("globalThis.__docsBridgeStop = { jstop: true }", d.context);
  const r = await running;
  assert.equal(r.done, false);
  assert.equal(r.stopped, true);
  assert.ok(d.typed.text.length < text.length);
  assert.ok(text.startsWith(d.typed.text));
});

test('the page resumeTail matches extension/lib/typing.js', async () => {
  const { resumeTail } = await import('../extension/lib/typing.js');
  const samples = ['short', 'The quick brown fox jumps over', 'He said “hi” and then walked all the way home', 'x'.repeat(120), 'ends in space after enough words '];
  for (const para of samples) {
    const { run } = fakeDocs();
    const r = await run('type', {
      blocks: [typingBlock([...[...para].map((c, i) => K(c, i === para.length - 1 ? {} : {})), K('z', { s: 1 }), K('q')])],
      at: { block: 0, event: 0, para: '' },
      state: { list: null, indent: 0, fresh: false },
      budgetMs: 0,
    });
    assert.equal(r.tail, resumeTail(`${para}z`), JSON.stringify(para));
  }
});
