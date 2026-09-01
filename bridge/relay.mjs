#!/usr/bin/env node
// Local agent bridge — t-bc1b, "bring your own agent".
//
// The page publishes its tools through `document.modelContext` (WebMCP). Most
// shipping browser agents do not consume that surface yet — on 2026-09-01 three
// of them read the page's pixels instead and left no row. This relay lets an
// MCP client that lives OUTSIDE the browser call the page's own tools THROUGH
// the WebMCP door: every call is forwarded to the page, which runs the tool's
// own `execute` via `document.modelContext.executeTool(...)`, so the page's own
// `recordToolCall` fires and the chain row is honest by construction —
// `ingress: webmcp`, actor "agent-initiated, riding the human session", which
// is true because it is. The page records the door opening too
// (`bridge_opened`, naming this relay and a fingerprint of its token), before
// any call can arrive.
//
// Two faces:
//   MCP (stdio)     — what the agent's client mounts. `tools/list` mirrors the
//                     page's registered tools; `tools/call` forwards to the page.
//   HTTP (loopback) — what the page talks to, when opened with the URL this
//                     relay prints:  GET /events (SSE)  POST /tools  POST /result
//
// Usage:
//   node bridge/relay.mjs --origin https://take-five-lw7.pages.dev [--port 7340]
//   node bridge/relay.mjs --origin http://localhost:5177             # dev server
// The relay serves exactly the origin you name and prints the URL to open it
// with. The trust boundary lives in relay-core.mjs; read it once.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The SDK is a pinned devDependency. The fallback to a sibling checkout exists
// for the spike only and refuses to engage otherwise: a shipped relay must not
// resolve its dependencies from a directory outside this repository.
function sdk(sub) {
  const local = path.join(here, '..', 'node_modules', '@modelcontextprotocol', 'sdk', sub);
  try { return require(local); } catch (err) {
    if (process.env.BRIDGE_SPIKE === '1') {
      try { return require(path.join(here, '..', '..', 'palmhouse', 'node_modules', '@modelcontextprotocol', 'sdk', sub)); } catch {}
    }
    throw new Error(`@modelcontextprotocol/sdk not installed here (${sub}); run npm install in the repo root`);
  }
}
const { McpServer } = sdk('dist/cjs/server/mcp.js');
const { StdioServerTransport } = sdk('dist/cjs/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = sdk('dist/cjs/types.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pageOrigin = arg('--origin', process.env.BRIDGE_ORIGIN);
if (!pageOrigin) {
  console.error('[bridge] --origin <page origin> is required (e.g. --origin https://take-five-lw7.pages.dev). The relay serves exactly one page.');
  process.exit(2);
}
const port = Number(arg('--port', process.env.BRIDGE_PORT || 7340));
const log = (...a) => console.error('[bridge]', ...a);

let relay;
try {
  relay = createRelay({ pageOrigin, port, token: process.env.BRIDGE_TOKEN || undefined, log });
} catch (err) {
  console.error(`[bridge] ${err.message}`);
  process.exit(2);
}

const mcp = new McpServer({ name: 'take-five-bridge', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
mcp.server.setRequestHandler(ListToolsRequestSchema, () => relay.mcpHandlers.listTools());
mcp.server.setRequestHandler(CallToolRequestSchema, (req) => relay.mcpHandlers.callTool(req.params));
// A phase change on the page reaches the agent as a list-changed notification.
relay.state.onToolsChanged = () => mcp.server.sendToolListChanged?.();

relay.httpServer.listen(port, '127.0.0.1', async () => {
  log(`serving ${relay.origin} on http://127.0.0.1:${port} (token …${relay.token.slice(0, 8)})`);
  log(`open the room with: ${relay.bridgeUrl()}`);
  await mcp.connect(new StdioServerTransport());
  log('MCP (stdio) connected — waiting for a client');
});
