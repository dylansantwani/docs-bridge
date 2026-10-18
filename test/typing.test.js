/**
 * docs_type: the keystroke planner (extension/lib/typing.js), the markdown →
 * typing-runs conversion, and the MCP tool surface (docs_type, docs_typing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planTyping, typingSettings, resumeTail, fold, rng, TYPING_PROFILES, planText } from '../extension/lib/typing.js';
import { toTypingContent, inlineRuns } from '../server/markdown.js';
import { callTool, typingLine, duration, AUTO_WAIT_MS } from '../server/tools.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const ESSAY = [
  'The Industrial Revolution changed how people lived, worked, and thought about time. Factories replaced workshops, and clocks began to govern the day.',
  "Workers didn't set their own pace anymore; the machine did. Historians still argue about whether life got better, but nobody disputes that it got faster!",
  'In 1851, the Great Exhibition in London showed off 13,000 inventions — steam hammers, reapers, even a “fountain pen.” Café owners loved it. 😀 done.',
];

/** Play a block's keys the way the page does, returning the paragraph text and a trace. */
function play(keys) {
  let text = '';
  const toggles = { b: false, i: false, u: false, s: false };
  const trace = [];
  for (const k of keys) {
    if (k.c !== undefined) text += k.c;
    else if (k.k === 'Backspace') text = [...text].slice(0, -1).join('');
    else if (k.f) toggles[k.f] = !toggles[k.f];
    else if (k.p !== undefined) text += k.x;
    trace.push({ text, toggles: { ...toggles }, k });
  }
  return { text, toggles, trace };
}

const content = (text) => toTypingContent({ text });

// ------------------------------------------------------------------ planner

test('a plan, played back, types exactly the intended text, typos and all, for many seeds', () => {
  const c = content(ESSAY.join('\n'));
  let typos = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const plan = planTyping(c.blocks, typingSettings({ seed, typos: 0.1 }));
    typos += plan.typos;
    plan.blocks.forEach((b, i) => {
      const { text, toggles } = play(b.keys);
      assert.equal(text, ESSAY[i], `seed ${seed} block ${i}`);
      assert.deepEqual(toggles, { b: false, i: false, u: false, s: false });
    });
    assert.equal(plan.chars, [...ESSAY.join('')].length);
  }
  assert.ok(typos > 100, `high typo rate should produce many corrected typos (got ${typos})`);
});

test('a typo is always corrected before its word ends (Docs autocorrects on the space)', () => {
  const c = content(ESSAY.join('\n'));
  for (let seed = 1; seed <= 40; seed++) {
    const plan = planTyping(c.blocks, typingSettings({ seed, typos: 0.1 }));
    plan.blocks.forEach((b, i) => {
      const intended = [...ESSAY[i]];
      for (const step of play(b.keys).trace) {
        const k = step.k;
        // Every word boundary typed must land on a correct prefix.
        if (k.c !== undefined && !/[\p{L}]/u.test(k.c)) {
          const typed = [...step.text];
          assert.deepEqual(typed, intended.slice(0, typed.length), `seed ${seed}: "${k.c}" typed after an uncorrected typo: ${step.text}`);
        }
      }
    });
  }
});

test('safe points sit on a correct prefix, outside inline formatting, with a findable tail', () => {
  const c = toTypingContent({ markdown: `${ESSAY[0]} Then **a bold stretch of several words here** and *more italic words* to end the paragraph.\n\n${ESSAY[1]}` });
  for (let seed = 1; seed <= 20; seed++) {
    const plan = planTyping(c.blocks, typingSettings({ seed, typos: 0.08 }));
    for (const b of plan.blocks) {
      const intended = b.runs.map((r) => r.text).join('');
      let safe = 0;
      for (const step of play(b.keys).trace) {
        if (!step.k.s) continue;
        safe++;
        assert.ok(intended.startsWith(step.text), `seed ${seed}: safe point on a wrong prefix "${step.text}"`);
        assert.deepEqual(step.toggles, { b: false, i: false, u: false, s: false });
        const tail = resumeTail(step.text);
        assert.ok(tail && step.text.endsWith(tail) && tail.length >= 20, `tail for ${JSON.stringify(step.text)}`);
      }
      assert.ok(safe > 5, 'a long paragraph has many safe points');
    }
  }
});

test('at the end of the document every word boundary is a safe point, even without a findable tail', () => {
  const c = content('“Quoted” — short “words” here, and “more” of them.');
  const tailOnly = planTyping(c.blocks, typingSettings({ seed: 3 }));
  const byEnd = planTyping(c.blocks, typingSettings({ seed: 3 }), { byEnd: true });
  const count = (p) => p.blocks[0].keys.filter((k) => k.s).length;
  assert.ok(count(byEnd) > count(tailOnly));
  assert.equal(count(tailOnly), 0);
  assert.ok(count(byEnd) >= 3);
});

test('speed follows wpm: 5 keys a word, jitter averages out', () => {
  const text = ESSAY.join(' ').repeat(3);
  for (const wpm of [30, 55, 100]) {
    const plan = planTyping(content(text).blocks, typingSettings({ seed: 11, wpm, typos: false, pauses: 0 }));
    const actual = plan.chars / 5 / (plan.totalMs / 60_000);
    assert.ok(Math.abs(actual - wpm) / wpm < 0.25, `wpm ${wpm}: got ${actual.toFixed(1)}`);
  }
});

test('pauses: sentences and paragraphs take longer than words, and pauses 0 removes the thinking', () => {
  const c = content('One two three. Four five six.\nSeven eight nine.');
  const plan = planTyping(c.blocks, typingSettings({ seed: 5, typos: false, wpm: 60 }));
  const [first, second] = plan.blocks;
  const spaceAfterStop = first.keys.find((k, i) => k.c === ' ' && first.keys[i - 1]?.c === '.');
  const plainSpaces = first.keys.filter((k, i) => k.c === ' ' && first.keys[i - 1]?.c !== '.');
  const avgSpace = plainSpaces.reduce((t, k) => t + k.d, 0) / plainSpaces.length;
  assert.ok(spaceAfterStop.d > avgSpace * 1.5, 'a sentence end pauses');
  assert.equal(first.before, 0, 'no pause before the very first paragraph');
  assert.ok(second.before > 300, 'thinking before a new paragraph');
  const none = planTyping(c.blocks, typingSettings({ seed: 5, typos: false, wpm: 60, pauses: 0 }));
  assert.equal(none.blocks[1].before, 0);
  assert.ok(none.totalMs < plan.totalMs);
});

test('plans are reproducible from a seed and differ across seeds', () => {
  const c = content(ESSAY[0]);
  const a = planTyping(c.blocks, typingSettings({ seed: 42 }));
  const b = planTyping(c.blocks, typingSettings({ seed: 42 }));
  const d = planTyping(c.blocks, typingSettings({ seed: 43 }));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.blocks[0].keys.map((k) => k.d), d.blocks[0].keys.map((k) => k.d));
});

test('typos: false and the steady profile type without a single Backspace', () => {
  const c = content(ESSAY.join('\n'));
  for (const s of [typingSettings({ seed: 9, typos: false }), typingSettings({ seed: 9, profile: 'steady' })]) {
    const plan = planTyping(c.blocks, s);
    assert.equal(plan.typos, 0);
    assert.ok(plan.blocks.every((b) => b.keys.every((k) => k.k !== 'Backspace')));
  }
});

test('formatting is toggled around runs; links, code and emoji are pasted as units', () => {
  const c = toTypingContent({ markdown: 'Plain **bold** and *it* ~~gone~~ see [the docs](https://x.y/z) or `npm i` 😀' });
  const plan = planTyping(c.blocks, typingSettings({ seed: 1, typos: false }));
  const keys = plan.blocks[0].keys;
  const toggles = keys.filter((k) => k.f).map((k) => k.f);
  assert.deepEqual(toggles, ['b', 'b', 'i', 'i', 's', 's']);
  const pastes = keys.filter((k) => k.p);
  assert.deepEqual(pastes.map((k) => k.x), ['the docs', 'npm i', '😀']);
  assert.match(pastes[0].p, /^<a href="https:\/\/x\.y\/z">the docs<\/a>$/);
  assert.match(pastes[1].p, /Courier New/);
  assert.equal(play(keys).text, 'Plain bold and it gone see the docs or npm i 😀');
});

test('blocks placed whole (rules, tables, page breaks) keep their html and get a beat', () => {
  const c = toTypingContent({ markdown: 'Before.\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\\pagebreak\n\nAfter.' });
  const plan = planTyping(c.blocks, typingSettings({ seed: 1 }));
  assert.deepEqual(plan.blocks.map((b) => b.t), ['p', 'hr', 'table', 'pagebreak', 'p']);
  assert.ok(plan.blocks[1].before > 0 && !plan.blocks[1].keys);
  assert.match(plan.blocks[2].html, /<table style="border-collapse:collapse;width:468pt">/);
});

test('tabs in markdown stay in one inline paragraph and are planned as keystrokes (table cells)', () => {
  const c = toTypingContent({ markdown: 'Parameter\tUnits\t25.1 °C' });
  assert.equal(c.inline, true);
  const plan = planTyping(c.blocks, typingSettings({ seed: 3, typos: false }));
  const tabs = plan.blocks[0].keys.filter((k) => k.c === '\t');
  assert.equal(tabs.length, 2);
  assert.equal(play(plan.blocks[0].keys).text, 'Parameter\tUnits\t25.1 °C');
});

test('typingSettings: profiles, overrides and limits', () => {
  assert.deepEqual(Object.keys(TYPING_PROFILES), ['natural', 'careful', 'fast', 'steady']);
  const s = typingSettings({ profile: 'fast', seed: 1 });
  assert.equal(s.wpm, 85);
  assert.equal(typingSettings({ wpm: 500, seed: 1 }).wpm, 200);
  assert.equal(typingSettings({ typos: 0.5, seed: 1 }).typoRate, 0.1);
  assert.equal(typingSettings({ typos: false, seed: 1 }).typoRate, 0);
  assert.equal(typingSettings({ pauses: 9, seed: 1 }).pauses, 3);
  assert.ok(Number.isInteger(typingSettings({}).seed));
  assert.throws(() => typingSettings({ profile: 'robot' }), /unknown typing profile/);
});

test('resumeTail keeps only text Docs types verbatim, and refuses short tails', () => {
  assert.equal(resumeTail('short one'), null);
  assert.equal(resumeTail('The quick brown fox jumps over'), 'The quick brown fox jumps over');
  // Smart quotes and dashes would not match a Find for the typed characters.
  assert.equal(resumeTail('He said “hi” and then walked all the way home'), 'and then walked all the way home');
  assert.equal(resumeTail('word — then a long enough tail here'), 'then a long enough tail here');
  assert.equal(resumeTail('ends with a space after enough text '), null);
  const long = 'a'.repeat(200);
  assert.equal(resumeTail(long).length, 80);
});

test('fold compares text the way Docs saves it: quotes, dashes and spacing do not matter', () => {
  assert.equal(fold(`Don't — "stop"`), fold('Don’t – “stop”'));
  assert.equal(fold('Café  1,000'), 'café1000');
});

test('rng is deterministic and roughly uniform', () => {
  const a = rng(7);
  const b = rng(7);
  const xs = Array.from({ length: 2000 }, () => a.next());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b.next()));
  const mean = xs.reduce((t, x) => t + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03);
});

// ---------------------------------------------------------------- markdown

test('toTypingContent turns markdown into runs with the structure docs_write uses', () => {
  const c = toTypingContent({ markdown: '# Title *x*\n\nHi **bo&ld** a &amp; b \\* x\n\n- one\n  - two\n- [ ] task\n\n1. first\n\n> quoted\n\n```\ncode line\n```' });
  assert.deepEqual(
    c.blocks.map((b) => [b.t, b.level ?? b.list ?? '', b.depth ?? '', b.runs?.map((r) => r.text).join('')]),
    [
      ['h', 1, '', 'Title x'],
      ['p', '', '', 'Hi bo&ld a & b * x'],
      ['li', 'bullet', 0, 'one'],
      ['li', 'bullet', 1, 'two'],
      ['li', 'checklist', 0, 'task'],
      ['li', 'numbered', 0, 'first'],
      ['quote', '', '', 'quoted'],
      ['code', '', '', 'code line'],
    ]
  );
  assert.deepEqual(c.blocks[1].runs, [{ text: 'Hi ' }, { b: true, text: 'bo&ld' }, { text: ' a & b * x' }]);
  assert.equal(c.inline, false);
  assert.ok(c.probes.length >= 1);
});

test('toTypingContent: plain text keeps every line as its own paragraph; one line is inline', () => {
  const c = toTypingContent({ text: 'Line one\n\nLine three' });
  assert.deepEqual(c.blocks, [
    { t: 'p', runs: [{ text: 'Line one' }] },
    { t: 'p', runs: [] },
    { t: 'p', runs: [{ text: 'Line three' }] },
  ]);
  assert.equal(c.inline, false);
  assert.equal(toTypingContent({ text: ' spliced ' }).inline, true);
  assert.equal(toTypingContent({ markdown: 'one *para*' }).inline, true);
  assert.throws(() => toTypingContent({ markdown: '   ' }), /empty/);
  assert.throws(() => toTypingContent({ text: 'a', markdown: 'b' }), /not both/);
});

test('inlineRuns merges adjacent plain text and keeps nested formatting', () => {
  const runs = inlineRuns([
    { type: 'text', text: 'a' },
    { type: 'escape', text: '*' },
    { type: 'strong', tokens: [{ type: 'em', tokens: [{ type: 'text', text: 'both' }] }] },
    { type: 'br' },
    { type: 'html', text: '<u>x</u>' },
  ]);
  assert.deepEqual(runs, [{ text: 'a*' }, { b: true, i: true, text: 'both' }, { text: ' x' }]);
});

test('planText gives what the plan types, per block', () => {
  const c = toTypingContent({ markdown: 'A\n\n---\n\nB' });
  assert.equal(planText(c.blocks), 'A\n\nB');
});

// -------------------------------------------------------------------- tools

function transport(handlers) {
  const calls = [];
  return {
    calls,
    async call(op, args, opts) {
      calls.push({ op, args, opts });
      const h = handlers[op];
      if (!h) throw new Error(`unexpected ${op}`);
      return typeof h === 'function' ? h(args, calls) : h;
    },
    status: async () => ({}),
  };
}

const job = (extra = {}) => ({
  job: 'tabc',
  status: 'running',
  doc: ID,
  title: 'Essay',
  url: `https://docs.google.com/document/d/${ID}/edit`,
  percent: 10,
  charsTyped: 100,
  totalChars: 1000,
  typosPlanned: 12,
  plannedMs: 240_000,
  elapsedMs: 20_000,
  remainingMs: 220_000,
  settings: { profile: 'natural', wpm: 55, typoRate: 0.02, pauses: 1, seed: 1 },
  ...extra,
});

test('docs_type plans the keystrokes, starts a job and returns at once for long text', async () => {
  const t = transport({ type_start: job() });
  const text = ESSAY.join('\n').repeat(8);
  const out = await callTool('docs_type', { doc: ID, text, seed: 4 }, t);
  const [start] = t.calls;
  assert.equal(start.op, 'type_start');
  assert.equal(start.args.id, ID);
  assert.deepEqual(start.args.position, { mode: 'append', anchor: undefined, occurrence: 1, matchCase: false, asBlock: false, inline: false });
  assert.equal(start.args.byEnd, true);
  assert.ok(start.args.plan.totalMs > AUTO_WAIT_MS, 'long enough to run in the background');
  assert.equal(start.args.plan.blocks.length, text.split('\n').length);
  assert.equal(start.args.settings.seed, 4);
  assert.equal(t.calls.length, 1, 'did not wait');
  assert.match(out, /^Typing into "Essay"/);
  assert.match(out, /job tabc: 10%/);
  assert.match(out, /55 wpm \(natural, ~2% typos\)/);
});

test('docs_type waits for short text and reports the verified result', async () => {
  let polls = 0;
  const t = transport({
    type_start: job({ status: 'queued', percent: 0 }),
    type_status: () => (++polls < 2 ? job() : job({ status: 'done', percent: 100, charsTyped: 44, totalChars: 44, verification: { verified: true }, elapsedMs: 12_000 })),
  });
  const out = await callTool('docs_type', { doc: ID, mode: 'insert_after', anchor: 'Intro', text: 'A short sentence that types fast.', wpm: 120 }, t);
  assert.equal(t.calls[0].args.position.inline, true);
  assert.equal(t.calls[0].args.byEnd, false);
  assert.ok(t.calls.filter((c) => c.op === 'type_status').length >= 2);
  assert.match(out, /^Typed 44 characters into "Essay" .* in 12s/);
  assert.match(out, /verified in Drive/);
});

test('docs_type validates before touching the browser', async () => {
  const t = transport({});
  const cases = [
    [{ doc: ID }, /markdown or text is required/],
    [{ doc: ID, text: 'x', markdown: 'y' }, /not both/],
    [{ doc: ID, text: 'x', mode: 'sideways' }, /mode must be/],
    [{ doc: ID, text: 'x', mode: 'insert_after' }, /anchor is required/],
    [{ doc: ID, text: 'x', anchor: 'a' }, /anchor only applies/],
    [{ doc: ID, text: 'x', wpm: 5 }, /wpm must be/],
    [{ doc: ID, text: 'x', typos: 0.9 }, /typos must be/],
    [{ doc: ID, text: 'x', pauses: 4 }, /pauses must be/],
    [{ doc: ID, text: 'x', profile: 'robot' }, /unknown typing profile/],
    [{ doc: ID, text: 'x'.repeat(60_001) }, /at most 60,000/],
    [{ doc: ID, markdown: '  \n ' }, /markdown or text is required|empty/],
  ];
  for (const [args, re] of cases) await assert.rejects(callTool('docs_type', args, t), re, JSON.stringify(args).slice(0, 80));
  assert.equal(t.calls.length, 0);
});

test('docs_typing: status, list and controls go to the extension', async () => {
  const t = transport({
    type_status: job(),
    type_list: { jobs: [job(), job({ job: 'told', status: 'done', percent: 100 })] },
    type_control: (a) => job({ status: a.action === 'pause' ? 'paused' : a.action === 'cancel' ? 'cancelled' : 'running' }),
  });
  assert.match(await callTool('docs_typing', {}, t), /^Still typing into "Essay"/);
  const list = await callTool('docs_typing', { action: 'list' }, t);
  assert.equal(list.split('\n').length, 2);
  assert.match(list, /told done 100%/);
  assert.match(await callTool('docs_typing', { action: 'pause', job: 'tabc' }, t), /^Paused at 10%.*resume job tabc/);
  assert.match(await callTool('docs_typing', { action: 'cancel', job: 'tabc' }, t), /^Cancelled at 10%/);
  assert.deepEqual(t.calls.filter((c) => c.op === 'type_control').map((c) => c.args), [
    { job: 'tabc', action: 'pause' },
    { job: 'tabc', action: 'cancel' },
  ]);
  await assert.rejects(callTool('docs_typing', { action: 'explode' }, t), /action must be/);
});

test('typingLine explains failures and unverified results', () => {
  assert.match(typingLine(job({ status: 'interrupted', error: 'tab_stalled: stuck' })), /Interrupted at 10%.*tab_stalled: stuck\ndocs_typing resume/);
  assert.match(typingLine(job({ status: 'failed', error: 'read_only: nope' })), /Typing failed at 10%.*read_only: nope/);
  assert.match(typingLine(job({ status: 'done', verification: { verified: false, waitedSeconds: 25, missing: ['tail'] } })), /NOT verified.*"tail"/);
  assert.equal(duration(59_400), '59s');
  assert.equal(duration(125_000), '2m05s');
  assert.equal(duration(3_900_000), '1h05m');
});
