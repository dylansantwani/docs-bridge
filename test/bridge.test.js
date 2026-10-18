import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Bridge } from '../extension/lib/bridge.js';

/** A controllable stand-in for the browser WebSocket. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
  // test controls
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  refuse(code = 1006, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

let realWebSocket;
beforeEach(() => {
  realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
});
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeBridge(onCall = async (op, args) => ({ op, args })) {
  return new Bridge({ getPort: async () => 8876, onCall, hello: () => ({ version: '1.0', label: 'test' }) });
}

test('connects to the hub, greets it, and answers calls', async () => {
  const bridge = makeBridge();
  await bridge.start();
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, 'ws://127.0.0.1:8876/ext');
  ws.open();
  assert.equal(bridge.connected, true);
  assert.deepEqual(ws.sent[0], { type: 'hello', version: '1.0', label: 'test' });
  ws.receive({ type: 'call', id: 'c1', op: 'read', args: { id: 'x' } });
  await tick();
  assert.deepEqual(ws.sent[1], { type: 'result', id: 'c1', ok: true, result: { op: 'read', args: { id: 'x' } } });
  bridge.stop();
});

test('errors from an op travel back with their code', async () => {
  const bridge = makeBridge(async () => {
    throw Object.assign(new Error('nope'), { code: 'no_access' });
  });
  await bridge.start();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  ws.receive({ type: 'call', id: 'c2', op: 'read' });
  await tick();
  assert.deepEqual(ws.sent[1], { type: 'result', id: 'c2', ok: false, error: { code: 'no_access', message: 'nope' } });
  bridge.stop();
});

test('with no hub listening it retries with backoff and explains why', async () => {
  const bridge = makeBridge();
  await bridge.start();
  FakeWebSocket.instances[0].refuse();
  assert.equal(bridge.state, 'waiting');
  assert.match(bridge.lastError, /no hub listening/);
  assert.equal(bridge.backoff, 2000);
  FakeWebSocket.instances.length = 0;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(FakeWebSocket.instances.length, 1, 'retried after the first backoff');
  bridge.stop();
});

test('a policy refusal from the hub is reported as such', async () => {
  const bridge = makeBridge();
  await bridge.start();
  FakeWebSocket.instances[0].refuse(1008, 'origin not allowed');
  assert.match(bridge.lastError, /refused by hub \(origin not allowed\)/);
  bridge.stop();
});

test('start() is idempotent while a socket is open or connecting', async () => {
  const bridge = makeBridge();
  await bridge.start();
  await bridge.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  FakeWebSocket.instances[0].open();
  await bridge.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  bridge.stop();
});

test('reconnectNow drops the socket and dials again immediately', async () => {
  const bridge = makeBridge();
  await bridge.start();
  FakeWebSocket.instances[0].open();
  await bridge.reconnectNow();
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(bridge.backoff, 1000);
  bridge.stop();
});

test('stop() really stops: closing the socket does not schedule a reconnect', async () => {
  const bridge = makeBridge();
  await bridge.start();
  FakeWebSocket.instances[0].open();
  bridge.stop();
  assert.equal(bridge.state, 'idle');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('garbage frames are ignored', async () => {
  const bridge = makeBridge();
  await bridge.start();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  ws.onmessage({ data: 'not json' });
  ws.receive({ type: 'something-else' });
  await tick();
  assert.equal(ws.sent.length, 1);
  bridge.stop();
});
