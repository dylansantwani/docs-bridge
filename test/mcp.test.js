/**
 * End to end over the real stdio protocol: spawn server/index.js the way an
 * MCP client does, connect a fake extension to its hub over a real socket, and
 * drive tools/call.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import net from 'node:net';

import { connectWebSocket } from '../server/ws.js';
import { EXTENSION_ID } from '../server/hub.js';

const ID = '1TestDocAIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
let home;
let port;
let server;
let rpc;

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function startServer() {
  const child = spawn(process.execPath, [new URL('../server/index.js', import.meta.url).pathname], {
    env: { ...process.env, DOCS_BRIDGE_HOME: home, DOCS_BRIDGE_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  let seq = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { child, request };
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'docs-bridge-mcp-'));
  port = await freePort();
  server = startServer();
  rpc = server.request;
});

after(async () => {
  server.child.kill();
  rmSync(home, { recursive: true, force: true });
});

const text = (res) => res.result.content.map((c) => c.text).join('\n');

test('initialize advertises tools and instructions', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'docs-bridge');
  assert.match(init.result.instructions, /signed-in Chrome/);
  assert.match(init.result.instructions, /Templates/);
  assert.match(init.result.instructions, /Google Slides \(slides_\* tools/);
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'docs_copy', 'docs_create', 'docs_edit', 'docs_export', 'docs_fill', 'docs_format', 'docs_list', 'docs_open', 'docs_read', 'docs_rename', 'docs_replace', 'docs_status', 'docs_templates', 'docs_type', 'docs_typing', 'docs_write',
    'slides_copy', 'slides_create', 'slides_edit', 'slides_export', 'slides_list', 'slides_open', 'slides_read', 'slides_rename', 'slides_replace', 'slides_type', 'slides_write',
  ]);
});

test('without the extension, status explains setup and calls fail in-band', async () => {
  assert.match(text(await rpc('tools/call', { name: 'docs_status', arguments: {} })), /extension: not connected/);
  const read = await rpc('tools/call', { name: 'docs_read', arguments: { doc: ID } });
  assert.equal(read.result.isError, true);
  assert.match(text(read), /Load unpacked/);
});

test('argument errors are reported in-band without reaching the browser', async () => {
  const res = await rpc('tools/call', { name: 'docs_write', arguments: { doc: ID, mode: 'insert_after', text: 'x' } });
  assert.equal(res.result.isError, true);
  assert.match(text(res), /anchor is required/);
});

test('with a connected extension, a write travels through the hub and back', async () => {
  const ext = await connectWebSocket(`ws://127.0.0.1:${port}/ext`, { headers: { Origin: `chrome-extension://${EXTENSION_ID}` } });
  const seen = [];
  ext.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type !== 'call') return;
    seen.push(msg);
    const result =
      msg.op === 'write'
        ? { title: 'Scratch', url: `https://docs.google.com/document/d/${ID}/edit`, anchorMatches: 1, verification: { verified: true, waitedSeconds: 1 } }
        : { managedTabs: 1, userAgent: 'Chrome/149' };
    ext.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
  });
  ext.send(JSON.stringify({ type: 'hello', version: '0.1.0', label: 'e2e' }));
  await new Promise((r) => setTimeout(r, 100));

  const res = await rpc('tools/call', { name: 'docs_write', arguments: { doc: `https://docs.google.com/document/d/${ID}/edit`, mode: 'append', markdown: '## Hi\n\nthere' } });
  assert.equal(res.result.isError, false, text(res));
  assert.match(text(res), /append done in "Scratch"/);
  assert.match(text(res), /verified in Drive/);
  const write = seen.find((m) => m.op === 'write');
  assert.equal(write.args.content.html, '<h2>Hi</h2><p>there</p>');
  assert.deepEqual(write.args.content.probes, ['Hi', 'there']);

  const status = text(await rpc('tools/call', { name: 'docs_status', arguments: {} }));
  assert.match(status, /"e2e" v0\.1\.0/);
  assert.match(status, /1 bridge tab\(s\) open/);
  ext.close();
});

test('--health exits non-zero with no extension and prints JSON status', async () => {
  const other = await freePort();
  const child = spawn(process.execPath, [new URL('../server/index.js', import.meta.url).pathname, '--health', '--port', String(other)], {
    env: { ...process.env, DOCS_BRIDGE_HOME: home },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(out, /"role": "hub"/);
  assert.match(out, /extension: not connected/);
});
