import { test } from 'node:test';
import assert from 'node:assert/strict';

import { structureFromHtml, findPlaceholders } from '../server/structure.js';

// Shape of a real Docs HTML export (Google's "Meeting notes" template), trimmed.
const EXPORT = `<html><head><style>.c1{color:red}</style></head><body class="c0 doc-content"><div><p class="c9"><img src="data:image/png;base64,AAAA"></p></div>
<p class="c19 title" id="h.x">Annual Board Meeting</p><p class="c16 subtitle">Friday, 09.04.20XX</p>
<h1 class="c13" id="h.a">Attendees</h1><p class="c16"><span class="c2">Wendy Writer, CEO</span></p>
<h1 id="h.b">Agenda</h1><h2 id="h.c">New Business</h2>
<ol class="c5 lst-kix_8pt-0 start" start="1"><li class="c4">One&nbsp;thing</li><li class="c4">Two</li></ol>
<ul class="c5 lst-kix_aj-0 start"><li>Bullet</li></ul><ul class="c5 lst-kix_aj-1 start"><li>Nested</li></ul>
<table class="c8"><tr><td><p><span>Name</span></p></td><td><p><span>{{name}}</span></p></td></tr><tr><td><p>Date</p></td><td><p>[Date]</p></td></tr></table>
<p><span>Signed: ______</span></p><hr><p>End &amp; done</p></body></html>`;

test('the outline shows title, subtitle, headings, numbered and nested items, tables, rules and placeholders', () => {
  const s = structureFromHtml(EXPORT);
  assert.equal(
    s.outline,
    [
      '[image]',
      'Title: Annual Board Meeting',
      'Subtitle: Friday, 09.04.20XX',
      '# Attendees',
      'Wendy Writer, CEO',
      '# Agenda',
      '## New Business',
      '1. One thing',
      '2. Two',
      '• Bullet',
      '  • Nested',
      '[table 1: 2 rows × 2 cols]',
      '  r1: [Name] [{{name}}]',
      '  r2: [Date] [[Date]]',
      'Signed: ______',
      '---',
      'End & done',
      '',
      'placeholders: {{name}}, [Date], ______',
      'images: 1',
    ].join('\n')
  );
  assert.deepEqual(s.tables[0], [['Name', '{{name}}'], ['Date', '[Date]']]);
  assert.equal(s.images, 1);
});

test('placeholder detection covers the common template conventions and counts repeats', () => {
  assert.deepEqual(findPlaceholders('Hi {{ name }}, {{name}} again. [Company Name] <<date>> [[x]] ____ [lowercase ignored]'), [
    { token: '{{ name }}', count: 1 },
    { token: '{{name}}', count: 1 },
    { token: '[Company Name]', count: 1 },
    { token: '<<date>>', count: 1 },
    { token: '[[x]]', count: 1 },
    { token: '____', count: 1 },
  ]);
});

test('an empty or bodiless export yields an empty outline, not a crash', () => {
  assert.equal(structureFromHtml('').outline, '');
  assert.equal(structureFromHtml('<p>just text</p>').outline, 'just text');
});

test('named entities in the export decode to their characters (curly quotes, dashes, accents)', () => {
  const html = '<body><p>The Once-ler&rsquo;s &ldquo;thneed&rdquo; &mdash; caf&eacute; &Uuml;ber 1&ndash;2 &frac12; &hellip; &copy; &#8217; &#x2019; &bogus;</p></body>';
  assert.equal(structureFromHtml(html).outline, 'The Once-ler\u2019s \u201cthneed\u201d \u2014 caf\u00e9 \u00dcber 1\u20132 \u00bd \u2026 \u00a9 \u2019 \u2019 &bogus;');
});
