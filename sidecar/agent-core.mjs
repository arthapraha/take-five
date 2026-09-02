// Take Five Sidecar — the agent's core, pure so it can be tested without a
// model, a browser, or a relay process. See sidecar/agent.mjs for the CLI
// that wires this to Ollama and to the bridge relay.
//
// WHAT THIS IS. A small agent loop: a prompt goes in, the model is offered the
// page's tools (as the relay lists them), every tool call the model makes is
// forwarded through the relay into the page's own `executeTool`, and the
// model's final text comes back — together with a transcript of exactly what
// was called and what came back, and the NAME of the agent that answered.
//
// HONESTY (Hermes, take-five seq 1735):
//   - the local endpoint requires a per-session token, like the relay's; no
//     other local process or open tab may submit prompts without it;
//   - the answering agent is named in every response (`agent.model`,
//     `agent.via`), never implied — the chain row cannot say which agent
//     called, so the panel must;
//   - this code never reads the page. Its only view of the room is the tool
//     list and tool results the relay hands it.

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_MAX_ROUNDS = 6;

export function mintToken() {
  return randomBytes(16).toString('hex');
}

export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** MCP tool descriptors → the OpenAI-style function tools Ollama's /api/chat accepts. */
export function toChatTools(mcpTools) {
  return (mcpTools ?? []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

const SYSTEM = [
  'You are a local agent driving a governed web page ("Take Five") through the tools it publishes.',
  'When the user asks for something a tool does, call the tool; do not describe the page from memory.',
  'Report tool results faithfully and briefly. Never claim a change you did not make through a tool.',
].join(' ');

/**
 * Run one prompt to completion.
 *   chat({messages, tools}) → { content, tool_calls? }   (the model; Ollama in production)
 *   listTools()            → [{name, description, inputSchema}] (from the relay; re-read each round)
 *   callTool(name, args)   → { text, isError }             (forwarded through the relay)
 * Returns { agent, final, transcript, rounds, truncated }.
 */
export const DEFAULT_CHAT_TIMEOUT_MS = 60_000;

export async function runPrompt({ prompt, agent, chat, listTools, callTool, maxRounds = DEFAULT_MAX_ROUNDS, chatTimeoutMs = DEFAULT_CHAT_TIMEOUT_MS }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
  const transcript = [];
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
  let rounds = 0;
  for (;;) {
    if (rounds >= maxRounds) {
      transcript.push({ type: 'stopped', note: `stopped after ${maxRounds} rounds without a final answer` });
      return { agent, final: null, transcript, rounds, truncated: true };
    }
    rounds += 1;
    // The tool list is re-read every round: a phase change on the page reaches
    // the relay as a new list, and the model must see the current surface.
    const tools = await listTools();
    // maxRounds bounds the loop; this bounds the model's latency inside a
    // round, so a stalled model cannot hold the panel open forever (Hermes,
    // take-five seq 1750).
    let reply;
    try {
      reply = await withTimeout(chat({ messages, tools: toChatTools(tools) }), chatTimeoutMs, `the model did not answer within ${chatTimeoutMs / 1000}s`);
    } catch (err) {
      transcript.push({ type: 'stopped', note: `stopped: ${err?.message ?? err}` });
      return { agent, final: null, transcript, rounds, truncated: true };
    }
    const calls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : [];
    if (calls.length === 0) {
      const final = typeof reply?.content === 'string' ? reply.content : '';
      transcript.push({ type: 'final', text: final });
      return { agent, final, transcript, rounds, truncated: false };
    }
    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls });
    for (const call of calls) {
      const name = call?.function?.name;
      const args = normaliseArgs(call?.function?.arguments);
      transcript.push({ type: 'tool_call', name, args });
      let text; let isError = false;
      if (!tools.some((t) => t.name === name)) {
        text = `no tool "${name}" is offered by the page right now`; isError = true;
      } else {
        try { ({ text, isError = false } = await callTool(name, args)); text = unwrapToolText(text); } catch (err) { text = `bridge: ${err?.message ?? err}`; isError = true; }
      }
      transcript.push({ type: 'tool_result', name, text: text ?? '', isError });
      messages.push({ role: 'tool', tool_name: name, content: text ?? '' });
    }
  }
}

/** The page's executeTool hands back the MCP result envelope as a string
 *  (`{"content":[{"type":"text","text":…}]}`); the relay forwards it verbatim.
 *  The model and the panel want the text. Anything else passes through. */
export function unwrapToolText(text) {
  if (typeof text !== 'string' || !text.startsWith('{')) return text ?? '';
  try {
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.content)) {
      const parts = obj.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
      if (parts.length) return parts.join('\n');
    }
  } catch {}
  return text;
}

function withTimeout(promise, ms, message) {
  let timer;
  const clock = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

function normaliseArgs(a) {
  if (a == null) return {};
  if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } }
  return a;
}

/** The relay's `tools/list_changed` handler, lifted here so it is testable
 *  (Hermes, take-five seq 1780/1799). It must SURVIVE a re-list that fails —
 *  on 2 Sept 06:52Z a rejected list threw here unhandled and the process died
 *  with the panel mid-connect — and it must RECOVER: the next valid change
 *  must land. Scoped to this one call; nothing process-wide. */
export function makeListChangedHandler({ listTools, log = () => {} }) {
  return async () => {
    try {
      const tools = await listTools();
      log(`page's tool list changed: ${tools.map((t) => t.name).join(', ') || '(none)'}`);
      return { ok: true, names: tools.map((t) => t.name) };
    } catch (err) {
      log(`page's tool list changed but could not be read: ${err?.message ?? err}`);
      return { ok: false, error: String(err?.message ?? err) };
    }
  };
}

/** The local HTTP face the side panel talks to. Loopback only; token on every
 *  room-facing route; exactly ONE extension origin is served — the one given
 *  at construction, never a pattern (Hermes, take-five seq 1750: any other
 *  extension on the same Chrome would match a pattern). Same rule as the
 *  relay's `--origin`. */
export function createSidecarServer({ token, extensionOrigin, agent, run, listTools, relayHealth = async () => null, log = () => {} }) {
  if (!token) throw new Error('createSidecarServer: token is required');
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin ?? '')) {
    throw new Error(`createSidecarServer: extensionOrigin must be the panel's own origin, chrome-extension://<32-char id> (the panel shows it); got ${extensionOrigin ?? 'nothing'}`);
  }
  // Origin gating guards BROWSERS: only THE extension page may call from a
  // browser. A request with no Origin header (curl, any local process) is
  // deliberately let through here — CORS cannot stop those anyway — and the
  // per-session token below is the load-bearing control for everyone
  // (counsel, take-five seq 1749). Same layering as the relay.
  const allowedOrigin = (o) => !o || o === extensionOrigin;
  // One prompt at a time: overlapping prompts would interleave two transcripts
  // on one chain (a double-click on Send, filmed). 409 while one runs, like
  // the relay's one-page-at-a-time.
  let busy = false;

  function cors(req, res) {
    const o = req.headers.origin;
    const ok = allowedOrigin(o);
    if (o && ok) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-sidecar-token');
    return ok;
  }
  function readJSON(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
      req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  return http.createServer(async (req, res) => {
    const ok = cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(ok ? 204 : 403); return res.end(); }
    if (!ok) { res.writeHead(403); return res.end('origin not allowed'); }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      // Open, like the relay's: names the agent and the relay, reveals no token.
      return json(res, 200, { ok: true, agent, relay: await relayHealth().catch(() => null), token_fingerprint: token.slice(0, 8) });
    }
    if (!tokenMatches(req.headers['x-sidecar-token'], token)) { res.writeHead(401); return res.end('sidecar token missing or wrong'); }
    if (req.method === 'GET' && url.pathname === '/tools') {
      return json(res, 200, { tools: (await listTools()).map((t) => t.name) });
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      const body = await readJSON(req).catch(() => null);
      if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) return json(res, 400, { error: 'expected {prompt: "..."}' });
      if (busy) return json(res, 409, { error: 'a prompt is already running; one at a time', agent });
      busy = true;
      log(`prompt: ${body.prompt.slice(0, 120)}`);
      try {
        const result = await run(body.prompt);
        return json(res, 200, result);
      } catch (err) {
        log(`prompt failed: ${err?.message ?? err}`);
        return json(res, 500, { error: String(err?.message ?? err), agent });
      } finally {
        busy = false;
      }
    }
    res.writeHead(404); res.end();
  });
}
