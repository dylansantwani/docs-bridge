#!/usr/bin/env node
/**
 * docs-bridge MCP server (Google Docs and Slides) — entry point.
 *
 *   node server/index.js            MCP stdio server (what MCP clients launch)
 *   node server/index.js --health   print hub + extension status and exit
 *   node server/index.js --hub      run only the hub (debugging)
 *   node server/index.js --port N   hub port (default 8876, or DOCS_BRIDGE_PORT)
 *   node server/index.js --call docs_type '{"doc":"…","text":"…"}'
 *                                   run one tool and print its result
 *   node server/index.js --op slides_deck '{"id":"…"}'
 *                                   run one raw extension operation, print its JSON (debugging)
 *   node server/index.js --reload-extension
 *                                   reload the unpacked extension after a code change
 */

import { createTransport, DEFAULT_PORT, EXTENSION_ID } from './hub.js';
import { McpServer } from './mcp.js';
import { TOOLS, TOOL_NAMES, SERVER_INSTRUCTIONS, callTool } from './tools.js';

const VERSION = '0.4.0';

function parseArgs(argv) {
  const opts = { port: Number(process.env.DOCS_BRIDGE_PORT) || DEFAULT_PORT, mode: 'mcp', verbose: !!process.env.DOCS_BRIDGE_VERBOSE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--health' || a === '--doctor') opts.mode = 'health';
    else if (a === '--hub') opts.mode = 'hub';
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--version' || a === '-V') opts.mode = 'version';
    else if (a === '--help' || a === '-h') opts.mode = 'help';
    else if (a === '--call') {
      opts.mode = 'call';
      opts.tool = argv[++i];
      opts.args = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '{}';
    } else if (a === '--op') {
      opts.mode = 'op';
      opts.op = argv[++i];
      opts.args = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '{}';
    } else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--reload-extension') opts.mode = 'reload';
    else if (a === '--force') opts.force = true;
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    process.stderr.write(`invalid port: ${opts.port}\n`);
    process.exit(2);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// stdout carries protocol frames only; anything for a human goes to stderr.
const log = (msg) => {
  if (opts.verbose || opts.mode !== 'mcp') process.stderr.write(`[docs-bridge] ${msg}\n`);
};

if (opts.mode === 'version') {
  process.stdout.write(`docs-bridge ${VERSION}\n`);
  process.exit(0);
}

if (opts.mode === 'help') {
  process.stdout.write(
    `docs-bridge ${VERSION} — Google Docs and Slides MCP server backed by a Chrome extension\n\n` +
      `  node server/index.js             run as an MCP stdio server\n` +
      `  node server/index.js --health    check whether Chrome is connected\n` +
      `  node server/index.js --hub       run the hub only\n` +
      `  node server/index.js --port N    hub port (default ${DEFAULT_PORT})\n` +
      `  node server/index.js --call <tool> '<json args>'   run one tool, print the result\n` +
      `  node server/index.js --op <op> '<json args>'       run one raw extension operation, print its JSON\n` +
      `  node server/index.js --reload-extension [--force]  reload the unpacked extension (refused while typing jobs run)\n` +
      `  node server/index.js --verbose   log to stderr\n\n` +
      `Extension id: ${EXTENSION_ID} (load extension/ unpacked from chrome://extensions)\n`
  );
  process.exit(0);
}

const transport = await createTransport({ port: opts.port, log });

if (opts.mode === 'health') {
  // Give a sleeping service worker a moment to reconnect before reporting.
  if (transport.role === 'hub') await new Promise((r) => setTimeout(r, 3500));
  const status = await transport.status();
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  if (status.extensions?.length) {
    try {
      const s = await transport.call('status', {}, { timeout: 8000 });
      process.stdout.write(`extension answered: ${JSON.stringify(s)}\n`);
    } catch (err) {
      process.stdout.write(`extension did not answer: ${err.message}\n`);
    }
  } else {
    process.stdout.write('extension: not connected\n');
  }
  await transport.close();
  process.exit(status.extensions?.length ? 0 : 1);
}

if (opts.mode === 'call' || opts.mode === 'reload' || opts.mode === 'op') {
  if (transport.role === 'hub') await new Promise((r) => setTimeout(r, 3500));
  let code = 0;
  try {
    if (opts.mode === 'call') {
      if (!TOOL_NAMES.has(opts.tool)) throw new Error(`unknown tool ${opts.tool}; tools: ${[...TOOL_NAMES].join(', ')}`);
      const out = await callTool(opts.tool, JSON.parse(opts.args), transport);
      await new Promise((done) => process.stdout.write(`${out}\n`, done));
    } else if (opts.mode === 'op') {
      const r = await transport.call(opts.op, JSON.parse(opts.args), { timeout: opts.timeout || 300_000 });
      // Wait for the write: process.exit() would cut piped output at 64 KB.
      await new Promise((done) => process.stdout.write(`${JSON.stringify(r, null, 2)}\n`, done));
    } else {
      const r = await transport.call('reload', { force: !!opts.force }, { timeout: 10_000 });
      process.stdout.write(`reloading extension v${r.version}${r.interrupted ? `; interrupted ${r.interrupted} typing job(s)` : ''}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err.code ? `${err.code}: ` : ''}${err.message}\n`);
    code = 1;
  }
  await transport.close();
  process.exit(code);
}

if (opts.mode === 'hub') {
  log('hub-only mode; Ctrl+C to stop');
  await new Promise(() => {});
}

new McpServer({
  serverInfo: { name: 'docs-bridge', version: VERSION },
  instructions: SERVER_INSTRUCTIONS,
  tools: TOOLS,
  log,
  onCall: async (name, args) => {
    if (!TOOL_NAMES.has(name)) throw new Error(`unknown tool: ${name}`);
    return callTool(name, args, transport);
  },
}).start();
