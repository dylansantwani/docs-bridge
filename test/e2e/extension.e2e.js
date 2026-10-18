/**
 * Real-browser end to end: Chromium with the unpacked extension, the real
 * hub, and live docs.google.com — signed out, so it uses a public document.
 *
 * Proves the parts unit tests cannot: the pinned extension id matches the
 * hub's allowlist, the service worker connects and stays connected, export
 * reads work from the worker (cookies, redirects to googleusercontent,
 * Content-Disposition), bridge tabs open in the background and page code runs
 * against the real Docs editor.
 *
 * Opt-in (needs network and a Chromium): npm run test:e2e
 * Chromium: $DOCS_BRIDGE_CHROMIUM, else the newest Playwright cache build.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { chromium } from 'playwright-core';

import { Hub, EXTENSION_ID } from '../../server/hub.js';
import { callTool } from '../../server/tools.js';

// Google's public "Docs API Quickstart" sample document.
const PUBLIC_DOC = '195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE';
// Google's public Slides API quickstart presentation (a 5-slide photo album).
const PUBLIC_DECK = '1EAYk18WDjIG-zp_0vLm3CsfQh_i8eXc67Jo2O9C6Vuc';
const EXTENSION_DIR = new URL('../../extension', import.meta.url).pathname;

function findChromium() {
  if (process.env.DOCS_BRIDGE_CHROMIUM) return process.env.DOCS_BRIDGE_CHROMIUM;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const b of builds) {
    const mac = join(cache, b, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    const macIntel = join(cache, b, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    const linux = join(cache, b, 'chrome-linux/chrome');
    for (const p of [mac, macIntel, linux]) if (existsSync(p)) return p;
  }
  return undefined; // let Playwright look
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let home, profile, hub, context, port;

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'docs-bridge-e2e-'));
  profile = mkdtempSync(join(tmpdir(), 'docs-bridge-e2e-profile-'));
  process.env.DOCS_BRIDGE_HOME = home;
  port = await freePort();
  hub = await new Hub({ port, log: (m) => process.env.DEBUG && console.log('[hub]', m) }).start();

  context = await chromium.launchPersistentContext(profile, {
    executablePath: findChromium(),
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`, '--no-first-run'],
  });
  // Point the extension at this test's hub port before it finishes its first dial.
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  assert.equal(new URL(worker.url()).host, EXTENSION_ID, 'the manifest key pins the extension id the hub allows');
  await worker.evaluate((p) => chrome.storage.local.set({ port: p, label: 'e2e' }), port);

  for (let i = 0; i < 100 && !hub.statusSync().extensions.length; i++) await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  await context?.close();
  await hub?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
});

test('the extension connects to the hub and identifies itself', async () => {
  const [ext] = hub.statusSync().extensions;
  assert.ok(ext, 'extension connected');
  assert.equal(ext.label, 'e2e');
  assert.equal(ext.version, JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8')).version);
  const out = await callTool('docs_status', {}, hub);
  assert.match(out, /"e2e" v\d+\.\d+\.\d+/);
  assert.match(out, /0 bridge tab\(s\) open/);
});

test('docs_read exports a public document as markdown from the service worker', async () => {
  const out = await callTool('docs_read', { doc: `https://docs.google.com/document/d/${PUBLIC_DOC}/edit` }, hub);
  assert.match(out, /^"Docs API Quickstart" \(195j9/);
  assert.match(out, /Sample doc/);
});

test('docs_read text and docs_export pdf work too', async () => {
  const text = await callTool('docs_read', { doc: PUBLIC_DOC, format: 'text' }, hub);
  assert.match(text, /Sample doc/);
  const dir = mkdtempSync(join(tmpdir(), 'docs-bridge-e2e-export-'));
  try {
    const out = await callTool('docs_export', { doc: PUBLIC_DOC, format: 'pdf', path: join(dir, 'sample') }, hub);
    assert.match(out, /Saved "Docs API Quickstart" as pdf/);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(dir, 'sample.pdf')).subarray(0, 4).toString(), '%PDF');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing to a document this browser can only view is refused by the real editor page', async () => {
  // Regression: this used to "succeed" — the editor element exists for
  // viewers, and verification passed vacuously.
  await assert.rejects(
    callTool('docs_write', { doc: PUBLIC_DOC, mode: 'append', text: 'x' }, hub),
    (err) => err.code === 'read_only' && /view only/.test(err.message)
  );
  // The bridge tab it opened was a background tab.
  const pages = context.pages().filter((p) => p.url().includes(PUBLIC_DOC));
  assert.ok(pages.length >= 1, 'a bridge tab was opened for the document');
});

test('a signed-out browser gets a clear error from docs_list', async () => {
  await assert.rejects(callTool('docs_list', { query: 'anything' }, hub), (err) => err.code === 'signed_out');
});

test('an unknown document id is reported as not found or no access', async () => {
  await assert.rejects(
    callTool('docs_read', { doc: '1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, hub),
    (err) => ['not_found', 'no_access', 'signed_out'].includes(err.code)
  );
});

test('docs_read structure builds an outline from the live HTML export', async () => {
  const out = await callTool('docs_read', { doc: PUBLIC_DOC, format: 'structure' }, hub);
  assert.match(out, /structure/);
  assert.match(out, /Sample doc/);
});

test('docs_edit and docs_format are refused on a view-only document, before any step runs', async () => {
  await assert.rejects(
    callTool('docs_edit', { doc: PUBLIC_DOC, steps: [{ caret: 'end' }, { insert: 'nope' }] }, hub),
    (err) => err.code === 'read_only'
  );
  await assert.rejects(callTool('docs_format', { doc: PUBLIC_DOC, text: 'Sample doc', format: { bold: true } }, hub), (err) => err.code === 'read_only');
});

test('templates and copies need a signed-in account and say so', async () => {
  await assert.rejects(callTool('docs_templates', {}, hub), (err) => err.code === 'signed_out');
  await assert.rejects(callTool('docs_copy', { doc: PUBLIC_DOC, title: 'x' }, hub), (err) => ['signed_out', 'copy_failed', 'no_access'].includes(err.code));
});

test('docs_type runs as a job in the real service worker and reports a view-only document', async () => {
  const out = await callTool('docs_type', { doc: PUBLIC_DOC, text: 'This should never be typed into a document the browser can only view.', wait: true }, hub);
  assert.match(out, /interrupted|failed/i);
  assert.match(out, /read_only|not editable/);
  const status = await callTool('docs_typing', { action: 'list' }, hub);
  assert.match(status, /interrupted|failed/);
});

// ------------------------------------------------------------------ Slides

test('slides_read parses a public deck exported as .pptx by the service worker', async () => {
  const out = await callTool('slides_read', { deck: `https://docs.google.com/presentation/d/${PUBLIC_DECK}/edit#slide=id.p` }, hub);
  assert.match(out, /· outline · 5 slide\(s\)/);
  assert.match(out, /## Slide 1\nlayout: Title slide/);
  assert.match(out, /\[shape 2: text @\d+,\d+ \d+×\d+pt\]\n\{Name Here\}/);
  assert.match(out, /notes: Image Sources:/);
  const text = await callTool('slides_read', { deck: PUBLIC_DECK, format: 'text', slides: '1' }, hub);
  assert.match(text, /--- Slide 1 ---\n\{Name Here\}\nBaby Album/);
});

test('slides_export saves the deck as pdf, and one slide as png through the real Slides editor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-bridge-e2e-slides-'));
  try {
    assert.match(await callTool('slides_export', { deck: PUBLIC_DECK, format: 'pdf', path: join(dir, 'album') }, hub), /as pdf to .*album\.pdf/);
    assert.equal(readFileSync(join(dir, 'album.pdf')).subarray(0, 4).toString(), '%PDF');
    // The page id of slide 2 comes from the live editor's filmstrip.
    assert.match(await callTool('slides_export', { deck: PUBLIC_DECK, format: 'png', slide: 2, path: join(dir, 'two') }, hub), /slide 2 as png/);
    assert.deepEqual([...readFileSync(join(dir, 'two.png')).subarray(1, 4)], [0x50, 0x4e, 0x47]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slides_write and slides_edit are refused on a deck this browser can only view', async () => {
  await assert.rejects(callTool('slides_write', { deck: PUBLIC_DECK, slides: [{ title: 'nope' }] }, hub), (err) => err.code === 'read_only');
  await assert.rejects(callTool('slides_edit', { deck: PUBLIC_DECK, steps: [{ slide: 1 }, { deleteSlide: true }] }, hub), (err) => err.code === 'read_only');
  await assert.rejects(callTool('slides_replace', { deck: PUBLIC_DECK, find: 'Baby', replace: 'x' }, hub), (err) => err.code === 'read_only');
});

test('Slides: an unknown deck is not found, and listing needs a signed-in account', async () => {
  await assert.rejects(callTool('slides_read', { deck: '1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, hub), (err) => ['not_found', 'no_access', 'signed_out'].includes(err.code));
  await assert.rejects(callTool('slides_list', { query: 'anything' }, hub), (err) => err.code === 'signed_out');
});
