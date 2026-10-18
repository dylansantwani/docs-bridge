const $ = (id) => document.getElementById(id);

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  $('version').textContent = `v${s.version}`;
  const ok = s.state === 'open';
  $('state').textContent = ok ? `Connected to hub on port ${s.port}` : 'Not connected';
  $('state').className = `state ${ok ? 'ok' : 'warn'}`;
  $('detail').textContent = ok
    ? `Since ${ago(s.connectedAt)}. Agents can read and edit Google Docs as you in this browser.`
    : `${s.lastError || 'Connecting…'} The hub starts when an MCP client launches docs-bridge.`;
  $('tabs').textContent = s.managedTabs;
  $('calls').textContent = s.calls;
  if (document.activeElement !== $('port')) $('port').value = s.port;
  if (document.activeElement !== $('label')) $('label').value = s.label;
}

$('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 600);
});

$('save').addEventListener('click', async () => {
  const port = Number($('port').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  await chrome.storage.local.set({ port, label: $('label').value.trim() || 'chrome' });
  setTimeout(refresh, 600);
});

refresh();
setInterval(refresh, 1500);
