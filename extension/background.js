/**
 * Docs Bridge service worker: connects to the local hub and runs its calls.
 */

import { Bridge, DEFAULT_PORT } from './lib/bridge.js';
import { createOps } from './lib/ops.js';
import { TabPool } from './lib/tabs.js';

const VERSION = chrome.runtime.getManifest().version;
const log = (msg) => console.log(`[docs-bridge] ${msg}`);

const pool = new TabPool({ log });
const { dispatch, typing } = createOps({ pool, version: VERSION, log });
// Report jobs a restart interrupted as such, not as still running.
typing.load();

async function settings() {
  const s = await chrome.storage.local.get({ port: DEFAULT_PORT, label: 'chrome' });
  const port = Number(s.port);
  return { port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT, label: String(s.label || 'chrome') };
}

let label = 'chrome';
const bridge = new Bridge({
  getPort: async () => {
    const s = await settings();
    label = s.label;
    return s.port;
  },
  hello: () => ({ version: VERSION, label, userAgent: navigator.userAgent }),
  onCall: (op, args, meta) => dispatch(op, args, meta),
  log,
});

// Chrome may suspend the worker between calls; this alarm wakes it so the
// bridge reconnects and idle bridge tabs still get closed.
chrome.alarms.create('docs-bridge-wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'docs-bridge-wake') return;
  bridge.start();
  pool.sweep().catch((err) => log(`sweep failed: ${err.message}`));
});

chrome.tabs.onRemoved.addListener((tabId) => pool.forgetTab(tabId));

chrome.runtime.onStartup.addListener(() => bridge.start());
chrome.runtime.onInstalled.addListener(() => bridge.start());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.port || changes.label)) bridge.reconnectNow();
});

// The popup asks for status and can force a reconnect.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'status') {
    settings().then((s) =>
      reply({
        state: bridge.state,
        lastError: bridge.lastError,
        connectedAt: bridge.connectedAt,
        calls: bridge.calls,
        managedTabs: pool.count(),
        port: s.port,
        label: s.label,
        version: VERSION,
      })
    );
    return true;
  }
  if (msg?.type === 'reconnect') {
    bridge.reconnectNow().then(() => reply({ ok: true }));
    return true;
  }
  return false;
});

bridge.start();
