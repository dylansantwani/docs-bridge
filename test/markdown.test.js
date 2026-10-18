import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toDocsContent, htmlToText, escapeHtml, toInlineHtml, sizeTables } from '../server/markdown.js';

test('block markdown becomes Docs-friendly HTML with probes', () => {
  const c = toDocsContent({ markdown: '# Title\n\nPara with **bold** and `code`.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEnd line.' });
  assert.match(c.html, /^<h1>Title<\/h1><p>Para with <strong>bold<\/strong> and <span style="font-family:'Courier New',monospace">code<\/span>\.<\/p>/);
  assert.match(c.html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(c.html, /<table style="border-collapse:collapse;width:468pt"><thead><tr><th style="width:234pt;border:1px solid #000000;padding:5pt">a<\/th>/);
  assert.ok(!c.html.includes('\n<'), 'no newlines between tags (Docs would paste them as spaces)');
  assert.equal(c.inlineHtml, null);
  assert.equal(c.lastKind, 'p');
  assert.deepEqual(c.probes, ['Title', 'two', 'End line.']);
  assert.equal(c.text.split('\n')[0], 'Title');
});

test('a single paragraph gets an inline form for splicing mid-line', () => {
  const c = toDocsContent({ markdown: 'just *this*' });
  assert.equal(c.inlineHtml, 'just <em>this</em>');
  assert.equal(c.html, '<p>just <em>this</em></p>');
});

test('edge spaces survive as &nbsp; because Docs trims them from pasted HTML', () => {
  assert.equal(toDocsContent({ markdown: ' [AFTER]' }).inlineHtml, '&nbsp;[AFTER]');
  assert.equal(toDocsContent({ markdown: '[BEFORE]  ' }).inlineHtml, '[BEFORE]&nbsp;&nbsp;');
  assert.equal(toDocsContent({ text: '  x ' }).inlineHtml, '&nbsp;&nbsp;x&nbsp;');
});

test('lastKind reports lists, tables, rules and code so the page can clean up the trailing paragraph', () => {
  assert.equal(toDocsContent({ markdown: 'a\n\n- x\n- y' }).lastKind, 'list');
  assert.equal(toDocsContent({ markdown: '| a |\n|---|\n| 1 |' }).lastKind, 'table');
  assert.equal(toDocsContent({ markdown: 'a\n\n---' }).lastKind, 'hr');
  assert.equal(toDocsContent({ markdown: '```\nx\n```' }).lastKind, 'code');
  assert.equal(toDocsContent({ markdown: '## h' }).lastKind, 'heading');
});

test('code blocks keep indentation as monospace paragraphs', () => {
  const c = toDocsContent({ markdown: '```js\nif (x) {\n  go();\n}\n```' });
  assert.equal(
    c.html,
    `<p><span style="font-family:'Courier New',monospace">if&nbsp;(x)&nbsp;{</span></p>` +
      `<p><span style="font-family:'Courier New',monospace">&nbsp;&nbsp;go();</span></p>` +
      `<p><span style="font-family:'Courier New',monospace">}</span></p>`
  );
  assert.deepEqual(c.probes, ['if (x) {', 'go();', '}'].filter((p) => p.length >= 2));
});

test('task lists render as ballot boxes', () => {
  const c = toDocsContent({ markdown: '- [ ] todo\n- [x] done' });
  assert.match(c.html, /☐ todo/);
  assert.match(c.html, /☑ done/);
});

test('plain text is escaped and split into paragraphs, never interpreted', () => {
  const c = toDocsContent({ text: '# not a heading\n<b>raw</b> & more' });
  assert.equal(c.html, '<p># not a heading</p><p>&lt;b&gt;raw&lt;/b&gt; &amp; more</p>');
  assert.equal(c.inlineHtml, null);
  assert.equal(c.lastKind, 'p');
  assert.deepEqual(c.probes, ['# not a heading', '<b>raw</b> & more']);
});

test('short content still gets a probe, so verification can never pass vacuously', () => {
  assert.deepEqual(toDocsContent({ text: 'x' }).probes, ['x']);
  assert.deepEqual(toDocsContent({ markdown: '- a\n- b' }).probes, ['a', 'b']);
});

test('invalid input is rejected', () => {
  assert.throws(() => toDocsContent({}), /markdown or text is required/);
  assert.throws(() => toDocsContent({ markdown: '   \n\n ' }), /empty/);
  assert.throws(() => toDocsContent({ markdown: 'a', text: 'b' }), /not both/);
});

test('long lines are clipped to word boundaries for probes', () => {
  const long = 'word '.repeat(40).trim();
  const [probe] = toDocsContent({ markdown: long }).probes;
  assert.ok(probe.length <= 60);
  assert.ok(long.startsWith(probe));
});

test('htmlToText and escapeHtml', () => {
  assert.equal(htmlToText('<h1>A &amp; B</h1><p>c&nbsp;d</p><table><tr><td>1</td><td>2</td></tr></table>'), 'A & B\nc d\n1 2');
  assert.equal(htmlToText('<p>Once-ler&rsquo;s &ldquo;Thneed&rdquo; &mdash; na&iuml;ve &#39;x&#39;</p>'), 'Once-ler\u2019s \u201cThneed\u201d \u2014 na\u00efve \'x\'');
  assert.equal(htmlToText('x&#39;s &#x41;'), "x's A");
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('typed blocks: headings, paragraphs, nested/numbered/task lists, quotes, code, tables, rules, images, page breaks', () => {
  const c = toDocsContent({
    markdown: '# T\n\nPara **b**\n\n- a\n  - a1\n- b\n\n1. one\n\n- [ ] task\n- [x] done\n\n> quote\n\n```\nx  y\n```\n\n| a |\n|---|\n| 1 |\n\n---\n\n![logo](https://x.org/a.png)\n\n\\pagebreak\n\n<!-- page break -->\n\nEnd',
  });
  assert.deepEqual(
    c.blocks.map((b) => [b.t, b.level ?? b.list ?? '', b.depth ?? '', b.html ?? ''].join('|')),
    [
      'h|1||T',
      'p|||Para <strong>b</strong>',
      'li|bullet|0|a',
      'li|bullet|1|a1',
      'li|bullet|0|b',
      'li|numbered|0|one',
      'li|checklist|0|task',
      'li|checklist|0|done',
      'quote|||quote',
      `code|||<span style="font-family:'Courier New',monospace">x&nbsp;&nbsp;y</span>`,
      'table|||<table style="border-collapse:collapse;width:468pt"><thead><tr><th style="width:468pt;border:1px solid #000000;padding:5pt">a</th></tr></thead><tbody><tr><td style="width:468pt;border:1px solid #000000;padding:5pt">1</td></tr></tbody></table>',
      'hr|||<hr>',
      'img|||<img src="https://x.org/a.png" alt="logo">',
      'pagebreak|||',
      'pagebreak|||',
      'p|||End',
    ]
  );
});

test('plain text becomes one typed paragraph per line, escaped', () => {
  assert.deepEqual(toDocsContent({ text: 'a <b>\n\nc' }).blocks, [
    { t: 'p', html: 'a &lt;b&gt;' },
    { t: 'p', html: '' },
    { t: 'p', html: 'c' },
  ]);
});

test('inline markdown for typing over a selection', () => {
  assert.equal(toInlineHtml('**Dylan** `x` [l](https://a.b)'), `<strong>Dylan</strong> <span style="font-family:'Courier New',monospace">x</span> <a href="https://a.b">l</a>`);
});

test('pasted tables get full-width columns and borders (an empty table would otherwise paste with 0 pt columns)', () => {
  const html = sizeTables('<table><thead><tr><th align="left">a</th><th>b</th><th>c</th></tr></thead><tbody><tr><td></td><td></td><td>x</td></tr></tbody></table><p>after</p>');
  assert.match(html, /^<table style="border-collapse:collapse;width:468pt">/);
  assert.equal((html.match(/style="width:156pt;border:1px solid #000000;padding:5pt"/g) || []).length, 6);
  assert.match(html, /<th align="left" style="width:156pt/);
  assert.match(html, /<\/table><p>after<\/p>$/);
  assert.equal(sizeTables('<p>no table</p>'), '<p>no table</p>');
});
