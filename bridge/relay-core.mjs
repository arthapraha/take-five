// Local agent bridge — the relay's core, exported so it can be tested without a
// terminal and reused by the thin CLI in relay.mjs. See relay.mjs for the
// overall picture; this file is the trust boundary and the two faces.
//
// TRUST BOUNDARY, in one place so a reviewer can read it once:
//   - binds 127.0.0.1 only;
//   - serves exactly ONE page origin, given at construction — the same origin
//     the printed bridge URL is built from, so what the relay serves is
//     provably what it announced (no hardcoded production origin, no open-ended
//     allowlist to remember to set);
//   - a per-run token gates everything that drives or observes the room; it is
//     presented in a header on the POSTs, and in the query ONLY on /events,
//     because EventSource cannot carry a header — nowhere else, so it never
//     rides a URL that could land in a log by accident;
//   - the token compare is constant-time;
//   - ONE attached page at a time: a second tab is refused rather than silently
//     given the room's tools too.
// Everything above was a review finding (Hermes, take-five seq 1654) or the
// original design; the tests in test/relay.test.js pin each line.

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CALL_TIMEOUT_MS = 15_000;

export function mintToken() {
  return randomBytes(16).toString('hex');
}

/** Constant-time equality on two strings of the same length; false otherwise. */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Where the token may be presented for a given route. */
export function presentedToken(req, url) {
  const header = req.headers['x-bridge-token'];
  if (typeof header === 'string') return header;
  // EventSource is the one client that cannot set a header. Only there.
  if (url.pathname === '/events') return url.searchParams.get('token');
  return null;
}

/**
 * Create the relay. `pageOrigin` is the ONLY origin the HTTP face will serve.
 * Returns the http server (not yet listening), the MCP request handlers, and
 * the shared state, so a test can drive both faces in-process.
 */
// How long the FIRST tools/list may wait for a page to attach. Some MCP clients
// (Palmhouse's participant runner among them) list tools exactly once at boot
// and never again; answering "no tools" in that instant would leave the agent
// blind forever, even though the page is one reload away. So the first list
// waits, bounded, for the first page push. Kept under the MCP SDK's default
// 60 s request timeout so the client's own clock does not fire first.
export const FIRST_LIST_WAIT_MS = 45_000;

export function createRelay({ pageOrigin, token = mintToken(), port = 7340, log = () => {}, firstListWaitMs = FIRST_LIST_WAIT_MS } = {}) {
  if (!pageOrigin) throw new Error('createRelay: pageOrigin is required — the relay serves exactly one page');
  let origin;
  try { origin = new URL(pageOrigin).origin; } catch { throw new Error(`createRelay: pageOrigin is not a URL: ${pageOrigin}`); }
  if (origin !== pageOrigin) throw new Error(`createRelay: pageOrigin must be a bare origin, got ${pageOrigin} (did you mean ${origin}?)`);

  const state = {
    tools: [],          // last list the page pushed: [{name, description, inputSchema}]
    page: null,         // the single attached SSE response, or null
    pending: new Map(), // callId -> {resolve, reject, timer}
    nextId: 1,
    onToolsChanged: null,
    everPushed: false,  // has any page pushed a tool list yet?
  };
  // Resolved by the first page push; the first tools/list waits on it (bounded).
  let firstPush;
  const firstPushed = new Promise((resolve) => { firstPush = resolve; });

  const bridgeUrl = (path = '/') => `${origin}${path}?bridge=http://127.0.0.1:${port}&token=${token}`;

  function sendToPage(msg) {
    if (!state.page) return false;
    state.page.write(`data: ${JSON.stringify(msg)}\n\n`);
    return true;
  }

  function callOnPage(name, args) {
    if (!state.page) return Promise.reject(new Error(`no page is attached to the bridge — open ${bridgeUrl()}`));
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.pending.delete(id); reject(new Error(`the page did not answer call ${id} (${name}) within ${CALL_TIMEOUT_MS / 1000}s`)); }, CALL_TIMEOUT_MS);
      state.pending.set(id, { resolve, reject, timer });
      sendToPage({ id, name, args: args ?? {} });
    });
  }

  // --- HTTP face (the page) ---------------------------------------------------
  function cors(req, res) {
    const reqOrigin = req.headers.origin;
    const allowed = !reqOrigin || reqOrigin === origin;
    if (reqOrigin === origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // The token rides a custom header on POSTs; the preflight must name it or
    // the browser refuses the request before it leaves (spike run 1).
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-bridge-token');
    return allowed;
  }

  function readJSON(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    const allowed = cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }
    if (!allowed) { res.writeHead(403); return res.end('origin not allowed'); }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, origin, tools: state.tools.map((t) => t.name), pages: state.page ? 1 : 0, token_fingerprint: token.slice(0, 8) }));
    }
    // Everything below drives or observes the room: token required.
    if (!tokenMatches(presentedToken(req, url), token)) { res.writeHead(401); return res.end('bridge token missing or wrong'); }

    if (req.method === 'GET' && url.pathname === '/events') {
      if (state.page) { res.writeHead(409, { 'content-type': 'text/plain' }); return res.end('a page is already attached to this bridge; one at a time'); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': attached\n\n');
      state.page = res;
      log(`page attached from ${origin}`);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => { clearInterval(ping); if (state.page === res) state.page = null; log('page detached'); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tools') {
      const body = await readJSON(req).catch(() => null);
      if (!body || !Array.isArray(body.tools)) { res.writeHead(400); return res.end('expected {tools: [...]}'); }
      state.tools = body.tools.map((t) => ({ name: String(t.name), description: String(t.description ?? ''), inputSchema: t.inputSchema ?? { type: 'object', properties: {} } }));
      log(`tool list from page: ${state.tools.map((t) => t.name).join(', ') || '(none)'}`);
      if (!state.everPushed) { state.everPushed = true; firstPush(); }
      try { await state.onToolsChanged?.(); } catch {}
      res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/result') {
      const body = await readJSON(req).catch(() => null);
      const p = body && state.pending.get(body.id);
      if (!p) { res.writeHead(404); return res.end('no such pending call'); }
      clearTimeout(p.timer); state.pending.delete(body.id);
      body.ok ? p.resolve(body.text ?? '') : p.reject(new Error(body.error ?? 'tool failed on the page'));
      res.writeHead(204); return res.end();
    }
    res.writeHead(404); res.end();
  });

  // --- MCP face (the agent) — transport-agnostic handlers ---------------------
  // The list follows the page, phase-scoped; nothing is invented here.
  const mcpHandlers = {
    listTools: async () => {
      // A one-shot client's only chance: wait for the page, bounded, then answer
      // with what the page said — never with something the relay made up.
      if (!state.everPushed) {
        await Promise.race([firstPushed, new Promise((r) => setTimeout(r, firstListWaitMs))]);
        if (!state.everPushed) log(`first tools/list answered EMPTY: no page attached within ${firstListWaitMs / 1000}s`);
      }
      return { tools: state.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
    },
    callTool: async ({ name, arguments: args }) => {
      if (!state.tools.some((t) => t.name === name)) {
        return { isError: true, content: [{ type: 'text', text: `no tool "${name}" in the room's current phase; tools now: ${state.tools.map((t) => t.name).join(', ') || '(none)'}` }] };
      }
      try {
        const text = await callOnPage(name, args);
        return { content: [{ type: 'text', text: text ?? '' }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `bridge: ${err.message}` }] };
      }
    },
  };

  return { httpServer, mcpHandlers, state, token, origin, port, bridgeUrl };
}
