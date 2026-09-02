#!/usr/bin/env node
// Take Five Sidecar — the local agent behind the side panel (t-70a1).
//
// One process, three connections:
//   - it SPAWNS the bridge relay (bridge/relay.mjs) and is its MCP client, so
//     the page's tools reach it as real tool definitions and every call it
//     makes crosses the relay into the page's own executeTool;
//   - it asks a LOCAL model (Ollama, /api/chat with tools) what to do;
//   - it serves a loopback HTTP endpoint the side panel talks to, token-gated.
//
// The agent is OUTSIDE the browser. Nothing here reads the page; the only view
// of the room is the tool list and results the relay hands over.
//
// Usage:
//   node sidecar/agent.mjs --origin http://localhost:5177 --extension-origin chrome-extension://<id> [--relay-port 7340] [--listen 7350]
//   env: OLLAMA_URL (http://localhost:11434), SIDECAR_MODEL (glm-5.3:cloud), SIDECAR_TOKEN (minted if unset),
//        SIDECAR_CHAT_TIMEOUT_MS (60000)
// Both origins are REQUIRED and exact: the page the relay serves, and the one
// extension the sidecar answers (the panel prints its own origin in its header).
// It prints the relay's ?bridge= URL (open the page with it) and the sidecar
// endpoint + token (paste into the panel's "Sidecar connection").

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSidecarServer, makeListChangedHandler, mintToken, runPrompt } from './agent-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function sdk(sub) {
  try { return require(path.join(here, '..', 'node_modules', '@modelcontextprotocol', 'sdk', sub)); } catch {
    throw new Error(`@modelcontextprotocol/sdk not installed here (${sub}); run npm install in the repo root`);
  }
}
const { Client } = sdk('dist/cjs/client/index.js');
const { StdioClientTransport } = sdk('dist/cjs/client/stdio.js');
const { ToolListChangedNotificationSchema } = sdk('dist/cjs/types.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const log = (...a) => console.error('[sidecar]', ...a);

const origin = arg('--origin', process.env.BRIDGE_ORIGIN);
if (!origin) { console.error('[sidecar] --origin <page origin> is required (the relay serves exactly one page)'); process.exit(2); }
const extensionOrigin = arg('--extension-origin', process.env.SIDECAR_EXTENSION_ORIGIN);
if (!extensionOrigin) { console.error('[sidecar] --extension-origin chrome-extension://<id> is required — the panel shows its own origin in its header; the sidecar answers exactly that one extension'); process.exit(2); }
const relayPort = Number(arg('--relay-port', process.env.BRIDGE_PORT || 7340));
const chatTimeoutMs = Number(process.env.SIDECAR_CHAT_TIMEOUT_MS || 60_000);
const listen = Number(arg('--listen', process.env.SIDECAR_PORT || 7350));
const OLLAMA = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const MODEL = process.env.SIDECAR_MODEL || 'glm-5.3:cloud';
const token = process.env.SIDECAR_TOKEN || mintToken();

// The answering agent, named. This object is returned with every response and
// shown on the panel: which model, through what, and where it runs.
const agent = { model: MODEL, via: 'ollama', runs: 'outside the browser', relay: `http://127.0.0.1:${relayPort}` };

// --- the relay, spawned and mounted -----------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, '..', 'bridge', 'relay.mjs'), '--origin', origin, '--port', String(relayPort)],
  env: { ...process.env },
  stderr: 'inherit', // the relay prints the ?bridge= URL to open the page with
});
const client = new Client({ name: 'take-five-sidecar', version: '0.1.0' }, { capabilities: {} });
await client.connect(transport);
// Never let a bad list from the page take the sidecar down (2 Sept 06:52Z).
// The handler lives in agent-core so its survive-and-recover property is tested.
client.setNotificationHandler(ToolListChangedNotificationSchema, makeListChangedHandler({ listTools: async () => (await client.listTools()).tools, log }));
// Deliberately NO process-wide unhandledRejection guard (Hermes, seq 1780): the
// re-list above is the one call page input can break, and it is caught there.
// Anything else unexpected should still fail loudly rather than serve as a zombie.
log(`relay mounted over stdio (origin ${origin}, port ${relayPort})`);

const listTools = async () => (await client.listTools()).tools;
const callTool = async (name, args) => {
  const res = await client.callTool({ name, arguments: args ?? {} });
  const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: Boolean(res.isError) };
};

// --- the model ---------------------------------------------------------------
async function chat({ messages, tools }) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  return body.message ?? { content: '' };
}

// --- the panel's endpoint ----------------------------------------------------
const run = (prompt) => runPrompt({ prompt, agent, chat, listTools, callTool, chatTimeoutMs });
const relayHealth = () => fetch(`http://127.0.0.1:${relayPort}/health`).then((r) => r.json());
let server;
try {
  server = createSidecarServer({ token, extensionOrigin, agent, run, listTools, relayHealth, log });
} catch (err) { console.error(`[sidecar] ${err.message}`); process.exit(2); }
server.listen(listen, '127.0.0.1', () => {
  log(`agent ${MODEL} via ${OLLAMA} — ${agent.runs}; answering only ${extensionOrigin}`);
  log(`panel endpoint: http://127.0.0.1:${listen}   token: ${token}`);
  log('paste both into the Sidecar panel ("Sidecar connection"), open the page with the ?bridge= URL above, then prompt.');
});
