/**
 * The hub: one loopback WebSocket endpoint that the Chrome extension dials
 * into, shared by every MCP server process on the machine.
 *
 * Several MCP clients (Claude Code sessions, Lattice, Codex, ...) each launch
 * their own `docs-bridge` process, but there is one browser. The first process
 * to bind the port becomes the hub; the rest join it as peers and relay their
 * calls through it. Election is the bind itself, which is atomic, and a peer
 * whose hub exits tries to take the port over before rejoining, so a dead hub
 * never strands live servers. (The same scheme openbrowser uses, including the
 * lesson that a reconnect path must actually attempt the takeover.)
 *
 * Who may connect, since anything that reaches the socket can read and edit
 * the user's documents:
 *   - /ext  — only the extension. Browsers always send Origin on WebSocket
 *     upgrades and pages cannot forge it, so the origin must be exactly
 *     chrome-extension://<our pinned id>. That shuts out every web page.
 *   - /mcp  — only local processes holding the token in ~/.docs-bridge/token
 *     (mode 0600). A browser request always carries Origin, so any Origin at
 *     all is refused here.
 *   - Host must be loopback, which defeats DNS rebinding.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer, connectWebSocket } from './ws.js';

export const DEFAULT_PORT = 8876;
/** Pinned by the `key` in extension/manifest.json. */
export const EXTENSION_ID = 'nkfcgpojlaedgadaoopckngjoheified';

export const NO_EXTENSION =
  'The Docs Bridge Chrome extension is not connected. Load it once from chrome://extensions ' +
  '(Developer mode → Load unpacked → the extension/ folder of docs-bridge), and make sure that ' +
  'Chrome window is signed in to Google. Then retry.';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function bridgeHome() {
  return process.env.DOCS_BRIDGE_HOME || join(homedir(), '.docs-bridge');
}

/** Read the shared secret, creating it (0600) on first use. Racing creators converge on one file. */
export function loadToken(home = bridgeHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // create below
  }
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return readFileSync(file, 'utf8').trim();
  }
  chmodSync(file, 0o600);
  return token;
}

function allowedOrigins() {
  const extra = (process.env.DOCS_BRIDGE_EXTENSION_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([`chrome-extension://${EXTENSION_ID}`, ...extra]);
}

function hostIsLoopback(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function send(conn, obj) {
  if (!conn.closed) conn.send(JSON.stringify(obj));
}

function parse(data) {
  try {
    return JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    return null;
  }
}

/** Outstanding request/response pairs keyed by id, each with its own deadline. */
class PendingCalls {
  constructor() {
    this.map = new Map();
    this.seq = 0;
  }

  create(timeout, owner) {
    const id = `${process.pid.toString(36)}-${(++this.seq).toString(36)}`;
    let entry;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        reject(new BridgeError('timeout', `the browser did not answer within ${Math.round(timeout / 1000)}s`));
      }, timeout);
      timer.unref?.();
      entry = { resolve, reject, timer, owner };
    });
    this.map.set(id, entry);
    return { id, promise };
  }

  settle(id, msg) {
    const entry = this.map.get(id);
    if (!entry) return;
    this.map.delete(id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new BridgeError(msg.error?.code || 'error', msg.error?.message || 'unknown error'));
  }

  failOwner(owner, code, message) {
    for (const [id, entry] of this.map) {
      if (entry.owner !== owner) continue;
      this.map.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(code, message));
    }
  }

  failAll(code, message) {
    for (const [id, entry] of this.map) {
      this.map.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(code, message));
    }
  }
}

export class Hub {
  constructor({ port = DEFAULT_PORT, host = '127.0.0.1', log = () => {}, token } = {}) {
    this.port = port;
    this.host = host;
    this.log = log;
    this.token = token ?? loadToken();
    this.origins = allowedOrigins();
    /** Connected extensions, most recently greeted last. */
    this.extensions = [];
    this.peers = new Set();
    this.pending = new PendingCalls();
    this._extensionWaiters = [];
    this.role = 'hub';
  }

  async start() {
    this.server = new WebSocketServer({
      port: this.port,
      host: this.host,
      healthPayload: () => ({ ok: true, name: 'docs-bridge', extensions: this.extensions.length }),
    });
    this.server.on('connection', (conn, req) => this._onConnection(conn, req));
    this.server.on('error', (err) => this.log(`server error: ${err.message}`));
    await this.server.listen();
    this.log(`hub listening on ${this.host}:${this.port}`);
    return this;
  }

  async close() {
    this.pending.failAll('hub_closed', 'the bridge hub is shutting down');
    await this.server?.close();
  }

  _onConnection(conn, req) {
    const origin = req.headers.origin;
    if (!hostIsLoopback(req.headers.host)) {
      conn.close(1008, 'bad host');
      return;
    }
    if (conn.path === '/ext') {
      if (!origin || !this.origins.has(origin)) {
        this.log(`refused extension connection from origin ${origin || '(none)'}`);
        conn.close(1008, 'origin not allowed');
        return;
      }
      this._acceptExtension(conn);
      return;
    }
    if (conn.path === '/mcp') {
      if (origin || conn.query.get('token') !== this.token) {
        conn.close(1008, 'unauthorized');
        return;
      }
      this._acceptPeer(conn);
      return;
    }
    conn.close(1008, 'unknown endpoint');
  }

  _acceptExtension(conn) {
    conn.meta = { role: 'extension', connectedAt: Date.now(), lastSeen: Date.now(), hello: null };
    conn.on('message', (data) => {
      const msg = parse(data);
      if (!msg) return;
      conn.meta.lastSeen = Date.now();
      switch (msg.type) {
        case 'hello':
          conn.meta.hello = {
            version: String(msg.version || '?'),
            label: String(msg.label || 'chrome').slice(0, 60),
            userAgent: String(msg.userAgent || '').slice(0, 200),
          };
          this.extensions = this.extensions.filter((c) => c !== conn).concat(conn);
          this.log(`extension connected: ${conn.meta.hello.label} v${conn.meta.hello.version}`);
          send(conn, { type: 'welcome', hub: { pid: process.pid } });
          for (const w of this._extensionWaiters.splice(0)) w();
          break;
        case 'ping':
          send(conn, { type: 'pong', t: msg.t });
          break;
        case 'result':
          this.pending.settle(msg.id, msg);
          break;
        default:
          break;
      }
    });
    conn.on('close', () => {
      this.extensions = this.extensions.filter((c) => c !== conn);
      this.pending.failOwner(conn, 'extension_disconnected', 'the Chrome extension disconnected mid-call; retry');
      this.log('extension disconnected');
    });
  }

  _acceptPeer(conn) {
    conn.meta = { role: 'peer' };
    this.peers.add(conn);
    send(conn, { type: 'hello', role: 'hub', status: this.statusSync() });
    conn.on('message', async (data) => {
      const msg = parse(data);
      if (!msg || !msg.id) return;
      try {
        let result;
        if (msg.type === 'status') result = this.statusSync();
        else if (msg.type === 'call') result = await this.call(msg.op, msg.args, { timeout: msg.timeout });
        else throw new BridgeError('bad_request', `unknown message type ${msg.type}`);
        send(conn, { type: 'result', id: msg.id, ok: true, result });
      } catch (err) {
        send(conn, { type: 'result', id: msg.id, ok: false, error: { code: err.code || 'error', message: err.message } });
      }
    });
    conn.on('close', () => this.peers.delete(conn));
  }

  /** The extension that greeted most recently — the one the user touched last. */
  _extension() {
    for (let i = this.extensions.length - 1; i >= 0; i--) {
      if (!this.extensions[i].closed && this.extensions[i].meta.hello) return this.extensions[i];
    }
    return null;
  }

  /**
   * An MV3 service worker that Chrome suspended reconnects within a couple of
   * seconds of its next wake-up alarm, so a short grace period turns most
   * "not connected" moments into a slightly slower success.
   */
  async _waitForExtension(ms) {
    if (this._extension()) return this._extension();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this._extensionWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this._extension();
  }

  async call(op, args = {}, { timeout = 120_000, waitForExtension = 4000 } = {}) {
    const ext = await this._waitForExtension(waitForExtension);
    if (!ext) throw new BridgeError('no_extension', NO_EXTENSION);
    const { id, promise } = this.pending.create(timeout, ext);
    send(ext, { type: 'call', id, op, args, timeout });
    return promise;
  }

  statusSync() {
    return {
      role: 'hub',
      port: this.port,
      pid: process.pid,
      peers: this.peers.size,
      extensions: this.extensions
        .filter((c) => c.meta.hello)
        .map((c) => ({
          label: c.meta.hello.label,
          version: c.meta.hello.version,
          connectedAt: new Date(c.meta.connectedAt).toISOString(),
          lastSeenSecondsAgo: Math.round((Date.now() - c.meta.lastSeen) / 1000),
        })),
    };
  }

  async status() {
    return this.statusSync();
  }
}

/** A process that lost the port election: relays calls through the hub, and takes over if it dies. */
export class HubClient {
  constructor({ port = DEFAULT_PORT, host = '127.0.0.1', log = () => {}, token } = {}) {
    this.opts = { port, host, log, token: token ?? loadToken() };
    this.log = log;
    this.pending = new PendingCalls();
    this.conn = null;
    this.owner = null;
    this.closed = false;
    this.role = 'peer';
    this._connecting = null;
  }

  get url() {
    return `ws://${this.opts.host}:${this.opts.port}/mcp?token=${this.opts.token}`;
  }

  async start() {
    await this._connect();
    return this;
  }

  async _tryTakeOver() {
    if (this.owner) return true;
    const hub = new Hub(this.opts);
    try {
      await hub.start();
    } catch (err) {
      if (err.code === 'EADDRINUSE') return false;
      throw err;
    }
    this.owner = hub;
    this.role = 'hub';
    this.log('previous hub exited; this process took over the port');
    return true;
  }

  async _connect() {
    if (await this._tryTakeOver()) return;
    const conn = await connectWebSocket(this.url);
    this.conn = conn;
    this.role = 'peer';
    this.log('joined the existing hub');
    conn.on('message', (data) => {
      const msg = parse(data);
      if (msg?.type === 'result') this.pending.settle(msg.id, msg);
    });
    conn.on('close', () => {
      this.conn = null;
      this.pending.failAll('hub_lost', 'lost the connection to the bridge hub mid-call; retry');
      if (!this.closed) this._reconnectLoop();
    });
  }

  _reconnectLoop() {
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      for (let delay = 100; !this.closed && !this.conn && !this.owner; delay = Math.min(delay * 2, 3000)) {
        try {
          await this._connect();
        } catch {
          await new Promise((r) => setTimeout(r, delay).unref?.());
        }
      }
      this._connecting = null;
    })();
    return this._connecting;
  }

  async _ready(ms = 5000) {
    if (this.owner || this.conn) return;
    // A caller is waiting on this deadline, so its timer must hold the event
    // loop open (the reconnect loop's own timers are unref'd on purpose).
    let timer;
    await Promise.race([this._reconnectLoop(), new Promise((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
    if (!this.owner && !this.conn) throw new BridgeError('hub_unavailable', 'could not reach or become the bridge hub');
  }

  async _request(type, payload, timeout) {
    await this._ready();
    if (this.owner) {
      return type === 'status' ? this.owner.statusSync() : this.owner.call(payload.op, payload.args, { timeout });
    }
    const { id, promise } = this.pending.create(timeout + 5000);
    send(this.conn, { type, id, ...payload, timeout });
    return promise;
  }

  call(op, args = {}, { timeout = 120_000 } = {}) {
    return this._request('call', { op, args }, timeout);
  }

  async status() {
    const s = await this._request('status', {}, 5000);
    return this.owner ? s : { ...s, via: 'peer' };
  }

  async close() {
    this.closed = true;
    this.pending.failAll('closed', 'client closed');
    this.conn?.close(1000, 'bye');
    await this.owner?.close();
  }
}

export async function createTransport(opts = {}) {
  const hub = new Hub(opts);
  try {
    return await hub.start();
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    opts.log?.('hub port busy; joining the existing hub');
    return new HubClient(opts).start();
  }
}
