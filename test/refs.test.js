import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDocRef,
  normalizeAccount,
  editUrl,
  exportUrl,
  createUrl,
  searchUrl,
  recentUrl,
  classifyLanding,
} from '../extension/lib/refs.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

test('parseDocRef accepts bare ids and every common Docs URL shape', () => {
  assert.deepEqual(parseDocRef(ID), { id: ID, tab: null });
  assert.deepEqual(parseDocRef(`https://docs.google.com/document/d/${ID}/edit`), { id: ID, tab: null });
  assert.deepEqual(parseDocRef(`https://docs.google.com/document/u/1/d/${ID}/edit?usp=sharing`), { id: ID, tab: null });
  assert.deepEqual(parseDocRef(`https://docs.google.com/document/d/${ID}/edit?tab=t.0#heading=h.x`), { id: ID, tab: 't.0' });
  assert.deepEqual(parseDocRef(`https://docs.google.com/document/d/${ID}/mobilebasic`), { id: ID, tab: null });
  assert.deepEqual(parseDocRef(`https://drive.google.com/file/d/${ID}/view`), { id: ID, tab: null });
  assert.deepEqual(parseDocRef(`https://drive.google.com/open?id=${ID}`), { id: ID, tab: null });
  assert.deepEqual(parseDocRef(`  ${ID}  `), { id: ID, tab: null });
});

test('parseDocRef rejects other products, hosts and junk with actionable messages', () => {
  assert.throws(() => parseDocRef(''), /doc is required/);
  assert.throws(() => parseDocRef(undefined), /doc is required/);
  assert.throws(() => parseDocRef('hello'), /not a Google Docs URL or document id/);
  assert.throws(() => parseDocRef(`https://example.com/document/d/${ID}/edit`), /not a Google Docs URL/);
  assert.throws(() => parseDocRef(`https://docs.google.com/spreadsheets/d/${ID}/edit`), /Docs documents and Slides presentations only/);
  assert.throws(() => parseDocRef(`https://docs.google.com/presentation/d/${ID}/edit`), /Google Slides link; use the slides_\* tools/);
  assert.throws(() => parseDocRef('https://docs.google.com/document/u/0/'), /no document id/);
});

test('parseDocRef ignores tab params that are not Docs tab ids', () => {
  assert.equal(parseDocRef(`https://docs.google.com/document/d/${ID}/edit?tab=<script>`).tab, null);
});

test('normalizeAccount takes indexes and emails', () => {
  assert.equal(normalizeAccount(undefined), null);
  assert.equal(normalizeAccount(null), null);
  assert.equal(normalizeAccount(''), null);
  assert.equal(normalizeAccount(0), '0');
  assert.equal(normalizeAccount('1'), '1');
  assert.equal(normalizeAccount(' Someone@School.org '), 'someone@school.org');
  assert.throws(() => normalizeAccount(12), /out of range/);
  assert.throws(() => normalizeAccount(-1), /out of range/);
  assert.throws(() => normalizeAccount('not-an-email'), /index like 0 or 1, or an email/);
});

test('URLs carry authuser only when an account is given', () => {
  assert.equal(editUrl(ID), `https://docs.google.com/document/d/${ID}/edit`);
  assert.equal(editUrl(ID, 1), `https://docs.google.com/document/d/${ID}/edit?authuser=1`);
  assert.equal(editUrl(ID, 'a@b.org'), `https://docs.google.com/document/d/${ID}/edit?authuser=a%40b.org`);
  assert.equal(exportUrl(ID, 'markdown'), `https://docs.google.com/document/d/${ID}/export?format=md`);
  assert.equal(exportUrl(ID, 'pdf', { account: 0, tab: 't.abc' }), `https://docs.google.com/document/d/${ID}/export?format=pdf&tab=t.abc&authuser=0`);
  assert.throws(() => exportUrl(ID, 'xlsx'), /unknown export format/);
  assert.equal(createUrl(), 'https://docs.google.com/document/create');
  assert.equal(createUrl(1), 'https://docs.google.com/document/create?authuser=1');
  assert.equal(recentUrl(), 'https://docs.google.com/document/');
  const s = new URL(searchUrl('lab report', 1));
  assert.equal(s.hostname, 'drive.google.com');
  assert.equal(s.searchParams.get('q'), 'type:document lab report');
  assert.equal(s.searchParams.get('authuser'), '1');
});

test('classifyLanding reads sign-in and access interstitials that arrive as 200s', () => {
  assert.equal(classifyLanding('https://doc-0g.googleusercontent.com/export/x', 200), 'ok');
  assert.equal(classifyLanding('https://accounts.google.com/v3/signin/identifier?continue=x', 200), 'signed_out');
  assert.equal(classifyLanding('https://docs.google.com/ServiceLogin?x', 200), 'signed_out');
  assert.equal(classifyLanding(`https://docs.google.com/document/d/${ID}/edit`, 200), 'no_access');
  assert.equal(classifyLanding('https://docs.google.com/x', 403), 'no_access');
  assert.equal(classifyLanding('https://docs.google.com/x', 404), 'not_found');
  assert.equal(classifyLanding('https://docs.google.com/x', 429), 'rate_limited');
  assert.equal(classifyLanding('https://docs.google.com/x', 503), 'server_error');
  assert.equal(classifyLanding('not a url', 200), 'ok');
});
