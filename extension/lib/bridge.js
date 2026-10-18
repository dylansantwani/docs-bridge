/**
 * The extension's side of the hub connection.
 *
 * An MV3 service worker is suspended after ~30s without events, and an open
 * WebSocket only keeps it alive while messages flow, so the bridge pings every
 * 20s. If Chrome kills the worker anyway, the `docs-bridge-wake` alarm
 * (background.js) restarts it and start() reconnects.
 */

export const DEFAULT_PORT = 8876;
const PING_MS = 20_000;
const MAX_BACKOFF_MS = 15_000;

export class Bridge {
  /**
   * @param {object} opts
   * @param {() => Promise<number>} opts.getPort
   * @param {(op: string, args: object) => Promise<any>} opts.onCall
   * @param {() => object} opts.hello  fields for the greeting (version, label, ...)
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ getPort, onCall, hello, log = () => {} }) {
    this.getPort = getPort;
    this.onCall = onCall;
    this.hello = hello;
    this.log = log;
    this.ws = null;
    this.state = 'idle';
    this.lastError = null;
    this.connectedAt = null;
    this.backoff = 1000;
    this.retryTimer = null;
    this.pingTimer = null;
    this.calls = 0;
  }

  get connected() {
    return this.state === 'open';
  }

  async start() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.retryTimer);
    const port = await this.getPort();
    this.state = 'connecting';
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
    } catch (err) {
      this._scheduleRetry(err.message);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.state = 'open';
      this.lastError = null;
      this.connectedAt = Date.now();
      this.backoff = 1000;
      this._send({ type: 'hello', ...this.hello() });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this._send({ type: 'ping', t: Date.now() }), PING_MS);
      this.log(`connected to hub on port ${port}`);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'call') this._handleCall(msg);
    };

    ws.onclose = (event) => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      const reason = event.code === 1008 ? `refused by hub (${event.reason || 'policy'})` : 'no hub listening (is an MCP client running docs-bridge?)';
      this._scheduleRetry(this.state === 'open' ? 'hub went away' : reason);
    };

    ws.onerror = () => {
      // onclose follows with the useful detail.
    };
  }

  stop() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Detach first: otherwise this socket's onclose schedules a reconnect
      // and "stop" quietly starts again.
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close(1000, 'stopping');
    }
    this.state = 'idle';
  }

  async reconnectNow() {
    this.stop();
    this.backoff = 1000;
    await this.start();
  }

  _scheduleRetry(reason) {
    this.state = 'waiting';
    this.lastError = reason;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async _handleCall(msg) {
    this.calls++;
    try {
      const result = await this.onCall(msg.op, msg.args || {}, { timeout: msg.timeout });
      this._send({ type: 'result', id: msg.id, ok: true, result });
    } catch (err) {
      this._send({
        type: 'result',
        id: msg.id,
        ok: false,
        error: { code: err.code || 'extension_error', message: err.message || String(err) },
      });
    }
  }
}
