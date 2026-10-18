import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { Hub, HubClient, createTransport, loadToken, EXTENSION_ID } from '../server/hub.js';
import { connectWebSocket } from '../server/ws.js';

const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
let home;
let port;
const cleanup = [];

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'docs-bridge-test-'));
  process.env.DOCS_BRIDGE_HOME = home;
  port = await freePort();
});

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  rmSync(home, { recursive: true, force: true });
  delete process.env.DOCS_BRIDGE_HOME;
});

function track(x) {
  cleanup.push(() => x.close?.());
  return x;
}

const next = (conn) => new Promise((resolve) => conn.once('message', (d) => resolve(JSON.parse(d.toString()))));
const closed = (conn) => new Promise((resolve) => (conn.closed ? resolve() : conn.once('close', resolve)));

/** A fake extension that answers calls with `handler(op, args)`. */
async function fakeExtension(handler, { origin = ORIGIN, label = 'test' } = {}) {
  const conn = await connectWebSocket(`ws://127.0.0.1:${port}/ext`, { headers: { Origin: origin } });
  cleanup.push(() => conn.close());
  const calls = [];
  conn.on('message', async (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type !== 'call') return;
    calls.push(msg);
    try {
      const result = await handler(msg.op, msg.args);
      conn.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
    } catch (err) {
      conn.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: { code: err.code || 'x', message: err.message } }));
    }
  });
  const welcomed = next(conn);
  conn.send(JSON.stringify({ type: 'hello', version: '9.9.9', label }));
  assert.equal((await welcomed).type, 'welcome');
  return { conn, calls };
}

test('the token file is created once with 0600 permissions and reused', () => {
  const a = loadToken(home);
  const b = loadToken(home);
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(home, 'token'), 'utf8').trim(), a);
});

test('an extension call round-trips through the hub', async () => {
  const hub = track(await new Hub({ port }).start());
  const ext = await fakeExtension(async (op, args) => ({ echoed: op, args }));
  const result = await hub.call('read', { id: 'x' });
  assert.deepEqual(result, { echoed: 'read', args: { id: 'x' } });
  assert.equal(ext.calls.length, 1);
  // The extension sets its own deadline from how long the server will wait.
  assert.equal(ext.calls[0].timeout, 120_000);
  await hub.call('edit', {}, { timeout: 300_000 });
  assert.equal(ext.calls[1].timeout, 300_000);
  const status = hub.statusSync();
  assert.equal(status.extensions.length, 1);
  assert.equal(status.extensions[0].label, 'test');
  assert.equal(status.extensions[0].version, '9.9.9');
});

test('extension errors come back as BridgeErrors with their code', async () => {
  const hub = track(await new Hub({ port }).start());
  await fakeExtension(async () => {
    throw Object.assign(new Error('nope'), { code: 'no_access' });
  });
  await assert.rejects(hub.call('read', {}), (err) => err.code === 'no_access' && err.message === 'nope');
});

test('web pages cannot connect as the extension: a wrong or missing Origin is refused', async () => {
  track(await new Hub({ port }).start());
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, {}]) {
    const conn = await connectWebSocket(`ws://127.0.0.1:${port}/ext`, { headers });
    await closed(conn);
  }
});

test('DNS rebinding is refused: the Host header must be loopback', async () => {
  track(await new Hub({ port }).start());
  const conn = await connectWebSocket(`ws://127.0.0.1:${port}/ext`, { headers: { Origin: ORIGIN, Host: `attacker.example:${port}` } });
  await closed(conn);
});

test('peers need the token and must not carry an Origin', async () => {
  const hub = track(await new Hub({ port }).start());
  const bad = await connectWebSocket(`ws://127.0.0.1:${port}/mcp?token=wrong`);
  await closed(bad);
  const browserish = await connectWebSocket(`ws://127.0.0.1:${port}/mcp?token=${hub.token}`, { headers: { Origin: 'https://docs.google.com' } });
  await closed(browserish);
  const unknown = await connectWebSocket(`ws://127.0.0.1:${port}/other`);
  await closed(unknown);
});

test('a second server joins as a peer and relays calls through the hub', async () => {
  const first = track(await createTransport({ port }));
  assert.equal(first.role, 'hub');
  await fakeExtension(async (op) => ({ op, from: 'ext' }));
  const second = track(await createTransport({ port }));
  assert.equal(second.role, 'peer');
  assert.deepEqual(await second.call('status', {}), { op: 'status', from: 'ext' });
  const status = await second.status();
  assert.equal(status.via, 'peer');
  assert.equal(status.extensions.length, 1);
});

test('when the hub exits, a peer takes over the port and the extension can reconnect to it', async () => {
  const first = await createTransport({ port });
  const second = track(await createTransport({ port }));
  assert.equal(second.role, 'peer');
  await first.close();
  for (let i = 0; i < 50 && second.role !== 'hub'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(second.role, 'hub');
  await fakeExtension(async () => 'after-takeover');
  assert.equal(await second.call('anything', {}), 'after-takeover');
});

test('no extension: calls fail fast with setup instructions', async () => {
  const hub = track(await new Hub({ port }).start());
  const started = Date.now();
  await assert.rejects(hub.call('read', {}, { waitForExtension: 200 }), (err) => err.code === 'no_extension' && /Load unpacked/.test(err.message));
  assert.ok(Date.now() - started < 2000);
});

test('an extension that connects during the grace period still serves the call', async () => {
  const hub = track(await new Hub({ port }).start());
  const pending = hub.call('read', {}, { waitForExtension: 3000 });
  setTimeout(() => fakeExtension(async () => 'late but fine'), 150);
  assert.equal(await pending, 'late but fine');
});

test('an extension disconnecting mid-call rejects the call instead of hanging', async () => {
  const hub = track(await new Hub({ port }).start());
  const ext = await fakeExtension(() => new Promise(() => {}));
  const pending = hub.call('write', {});
  setTimeout(() => ext.conn.close(), 100);
  await assert.rejects(pending, (err) => err.code === 'extension_disconnected');
});

test('calls time out when the browser never answers', async () => {
  const hub = track(await new Hub({ port }).start());
  await fakeExtension(() => new Promise(() => {}));
  await assert.rejects(hub.call('write', {}, { timeout: 150 }), (err) => err.code === 'timeout');
});

test('the most recently greeted extension serves calls', async () => {
  const hub = track(await new Hub({ port }).start());
  await fakeExtension(async () => 'old', { label: 'profile-a' });
  await fakeExtension(async () => 'new', { label: 'profile-b' });
  assert.equal(await hub.call('x', {}), 'new');
  assert.deepEqual(
    hub.statusSync().extensions.map((e) => e.label),
    ['profile-a', 'profile-b']
  );
});

test('the extension ping is answered with pong', async () => {
  track(await new Hub({ port }).start());
  const { conn } = await fakeExtension(async () => null);
  const reply = next(conn);
  conn.send(JSON.stringify({ type: 'ping', t: 42 }));
  assert.deepEqual(await reply, { type: 'pong', t: 42 });
});

test('a peer with no hub and no way to become one reports hub_unavailable instead of hanging', async () => {
  const client = new HubClient({ port });
  client._tryTakeOver = async () => false; // someone else holds the port...
  client._connect = async () => {
    throw new Error('refused'); // ...but never answers
  };
  const started = Date.now();
  await assert.rejects(client._ready(300), (err) => err.code === 'hub_unavailable');
  assert.ok(Date.now() - started < 2000);
  client.closed = true;
});
