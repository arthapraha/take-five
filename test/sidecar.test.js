// Take Five Sidecar — the agent loop and the panel's endpoint, tested pure:
// a fake model, and the REAL relay core with a fake page on the other end, so
// the whole path prompt → model → relay → page → model → panel is exercised
// without a browser, a model, or a subscription.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPrompt, toChatTools, createSidecarServer, mintToken, tokenMatches, unwrapToolText, makeListChangedHandler } from '../sidecar/agent-core.mjs';

test('the list_changed handler survives a re-list that fails and recovers on the next valid one (Hermes 1780)', async () => {
  // 2 Sept 06:52Z: a rejected tools/list threw here unhandled; the process died.
  let calls = 0;
  const logs = [];
  const listTools = async () => { calls++; if (calls === 1) throw new Error('tools[0].inputSchema: expected object, received string'); return [{ name: 'read_ledger' }, { name: 'current_phase' }]; };
  const handler = makeListChangedHandler({ listTools, log: (m) => logs.push(m) });
  const first = await handler();
  assert.equal(first.ok, false, 'the bad list is reported, not thrown');
  assert.match(first.error, /expected object, received string/);
  assert.match(logs[0], /could not be read/);
  const second = await handler();
  assert.deepEqual(second, { ok: true, names: ['read_ledger', 'current_phase'] }, 'the next valid change lands');
  assert.match(logs[1], /read_ledger, current_phase/);
});
import { createRelay } from '../bridge/relay-core.mjs';

const AGENT = { model: 'fake-model', via: 'test', runs: 'outside the browser' };
const READ = { name: 'read_ledger', description: 'Read the chain', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } };
const PHASE = { name: 'current_phase', description: 'Phase', inputSchema: { type: 'object', properties: {} } };

/** A scripted model: each call returns the next reply; records what it saw. */
function fakeChat(replies) {
  const seen = [];
  const chat = async ({ messages, tools }) => { seen.push({ messages: messages.map((m) => ({ ...m })), tools }); return replies.shift() ?? { content: 'no more script' }; };
  return { chat, seen };
}

test('MCP tool descriptors become the function tools the model is offered, schema intact', () => {
  const t = toChatTools([READ]);
  assert.deepEqual(t, [{ type: 'function', function: { name: 'read_ledger', description: 'Read the chain', parameters: READ.inputSchema } }]);
  assert.deepEqual(toChatTools([{ name: 'x' }])[0].function.parameters, { type: 'object', properties: {} });
});

test('the page\'s MCP result envelope is unwrapped to its text for the model and the panel; anything else passes through', async () => {
  // Seen live 23:33Z: executeTool returns the envelope as a string and the relay forwards it verbatim.
  const envelope = JSON.stringify({ content: [{ type: 'text', text: 'Entries 1–4 of 4:\n#1 room_opened' }] });
  assert.equal(unwrapToolText(envelope), 'Entries 1–4 of 4:\n#1 room_opened');
  assert.equal(unwrapToolText('plain text'), 'plain text');
  assert.equal(unwrapToolText('{"not":"an envelope"}'), '{"not":"an envelope"}');
  assert.equal(unwrapToolText(''), '');
  assert.equal(unwrapToolText(undefined), '');
  const { chat } = fakeChat([
    { content: '', tool_calls: [{ function: { name: 'read_ledger', arguments: {} } }] },
    { content: 'ok' },
  ]);
  const res = await runPrompt({ prompt: 'x', agent: AGENT, chat, listTools: async () => [READ], callTool: async () => ({ text: envelope, isError: false }) });
  assert.equal(res.transcript[1].text, 'Entries 1–4 of 4:\n#1 room_opened', 'the transcript carries the text, not the envelope');
});

test('a prompt that needs a tool: the model calls it, the page answers, the model finishes — transcript in order, agent named', async () => {
  const { chat, seen } = fakeChat([
    { content: '', tool_calls: [{ function: { name: 'read_ledger', arguments: { limit: 2 } } }] },
    { content: 'Two entries, ending in bridge_opened.' },
  ]);
  const calls = [];
  const res = await runPrompt({
    prompt: 'read the ledger', agent: AGENT, chat,
    listTools: async () => [READ, PHASE],
    callTool: async (name, args) => { calls.push({ name, args }); return { text: 'Entries 1–2 of 2', isError: false }; },
  });
  assert.deepEqual(calls, [{ name: 'read_ledger', args: { limit: 2 } }]);
  assert.deepEqual(res.transcript.map((e) => e.type), ['tool_call', 'tool_result', 'final']);
  assert.equal(res.transcript[1].text, 'Entries 1–2 of 2');
  assert.equal(res.final, 'Two entries, ending in bridge_opened.');
  assert.equal(res.rounds, 2);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.agent, AGENT, 'the answering agent is named on every result');
  // The model saw the page's tools, and on round two saw the tool result.
  assert.deepEqual(seen[0].tools.map((t) => t.function.name), ['read_ledger', 'current_phase']);
  const toolMsg = seen[1].messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.content, 'Entries 1–2 of 2');
  assert.equal(toolMsg.tool_name, 'read_ledger');
});

test('string-encoded arguments are parsed; a tool the page does not offer is refused without touching the relay', async () => {
  const { chat } = fakeChat([
    { content: '', tool_calls: [{ function: { name: 'ratify_ruling', arguments: '{"text":"x"}' } }] },
    { content: 'done' },
  ]);
  let relayCalls = 0;
  const res = await runPrompt({ prompt: 'ratify', agent: AGENT, chat, listTools: async () => [READ], callTool: async () => { relayCalls++; return { text: '' }; } });
  assert.equal(relayCalls, 0);
  assert.equal(res.transcript[0].args.text, 'x');
  assert.equal(res.transcript[1].isError, true);
  assert.match(res.transcript[1].text, /no tool "ratify_ruling"/);
  assert.equal(res.final, 'done', 'the model is told and gets to finish');
});

test('the loop is bounded: a model that never stops calling is stopped, and says so', async () => {
  const chat = async () => ({ content: '', tool_calls: [{ function: { name: 'read_ledger', arguments: {} } }] });
  const res = await runPrompt({ prompt: 'loop', agent: AGENT, chat, listTools: async () => [READ], callTool: async () => ({ text: 'ok' }), maxRounds: 3 });
  assert.equal(res.rounds, 3);
  assert.equal(res.truncated, true);
  assert.equal(res.final, null);
  assert.equal(res.transcript.at(-1).type, 'stopped');
  assert.equal(res.transcript.filter((e) => e.type === 'tool_call').length, 3);
});

test('the tool list is re-read every round, so a phase change mid-prompt reaches the model', async () => {
  let lists = 0;
  const listTools = async () => { lists++; return lists === 1 ? [READ] : [READ, { name: 'reveal_in_round', inputSchema: {} }]; };
  const { chat, seen } = fakeChat([
    { content: '', tool_calls: [{ function: { name: 'read_ledger', arguments: {} } }] },
    { content: 'fin' },
  ]);
  await runPrompt({ prompt: 'x', agent: AGENT, chat, listTools, callTool: async () => ({ text: 'ok' }) });
  assert.equal(lists, 2);
  assert.deepEqual(seen[1].tools.map((t) => t.function.name), ['read_ledger', 'reveal_in_round']);
});

test('a relay failure on a call is reported to the model as an error, not thrown at the panel', async () => {
  const { chat } = fakeChat([
    { content: '', tool_calls: [{ function: { name: 'read_ledger', arguments: {} } }] },
    { content: 'could not read' },
  ]);
  const res = await runPrompt({ prompt: 'x', agent: AGENT, chat, listTools: async () => [READ], callTool: async () => { throw new Error('no page is attached to the bridge'); } });
  assert.equal(res.transcript[1].isError, true);
  assert.match(res.transcript[1].text, /no page is attached/);
  assert.equal(res.final, 'could not read');
});

test('an empty prompt is refused before any model is asked', async () => {
  await assert.rejects(runPrompt({ prompt: '  ', agent: AGENT, chat: async () => { throw new Error('should not be called'); }, listTools: async () => [], callTool: async () => ({}) }), /prompt is required/);
});

// --- the panel's endpoint ------------------------------------------------------
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
async function bootServer(t, run = async (p) => ({ agent: AGENT, final: `echo ${p}`, transcript: [], rounds: 1, truncated: false })) {
  const token = mintToken();
  const server = createSidecarServer({ token, extensionOrigin: EXT, agent: AGENT, run, listTools: async () => [READ], relayHealth: async () => ({ pages: 1, tools: ['read_ledger'] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { token, base: `http://127.0.0.1:${server.address().port}` };
}

test('the sidecar answers exactly one extension, named at construction — no pattern, and it refuses to be built without one', async (t) => {
  // Hermes seq 1750: a pattern would serve any extension on the same Chrome.
  assert.throws(() => createSidecarServer({ token: mintToken(), agent: AGENT, run: async () => ({}), listTools: async () => [] }), /extensionOrigin must be/);
  assert.throws(() => createSidecarServer({ token: mintToken(), extensionOrigin: 'chrome-extension://*', agent: AGENT, run: async () => ({}), listTools: async () => [] }), /extensionOrigin must be/);
  const { token, base } = await bootServer(t);
  const other = 'chrome-extension://' + 'p'.repeat(32);
  const r = await fetch(`${base}/tools`, { headers: { origin: other, 'x-sidecar-token': token } });
  assert.equal(r.status, 403, 'another extension with a well-formed id is refused, token or not');
  const pre = await fetch(`${base}/prompt`, { method: 'OPTIONS', headers: { origin: other } });
  assert.equal(pre.status, 403);
  const ours = await fetch(`${base}/tools`, { headers: { origin: EXT, 'x-sidecar-token': token } });
  assert.equal(ours.status, 200);
});

test('one prompt at a time: a second prompt while one runs is a 409, and the seat frees when the first finishes', async (t) => {
  let release;
  const first = new Promise((r) => { release = r; });
  const { token, base } = await bootServer(t, async (p) => { if (p === 'slow') await first; return { agent: AGENT, final: p, transcript: [], rounds: 1, truncated: false }; });
  const H = { 'content-type': 'application/json', origin: EXT, 'x-sidecar-token': token };
  const slow = fetch(`${base}/prompt`, { method: 'POST', headers: H, body: '{"prompt":"slow"}' });
  await new Promise((r) => setTimeout(r, 30));
  const second = await fetch(`${base}/prompt`, { method: 'POST', headers: H, body: '{"prompt":"second"}' });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /one at a time/);
  release();
  assert.equal((await slow).status, 200);
  const third = await fetch(`${base}/prompt`, { method: 'POST', headers: H, body: '{"prompt":"third"}' });
  assert.equal(third.status, 200, 'the seat is free again');
});

test('a stalled model is cut off by the per-call timeout, and the panel is told, not hung', async () => {
  const chat = () => new Promise(() => {}); // never answers
  const res = await runPrompt({ prompt: 'x', agent: AGENT, chat, listTools: async () => [READ], callTool: async () => ({ text: '' }), chatTimeoutMs: 50 });
  assert.equal(res.truncated, true);
  assert.equal(res.final, null);
  assert.equal(res.transcript.at(-1).type, 'stopped');
  assert.match(res.transcript.at(-1).note, /did not answer within 0\.05s/);
});

test('token: minted per session, constant-time compared, empties never match', () => {
  const a = mintToken(); const b = mintToken();
  assert.equal(a.length, 32); assert.notEqual(a, b);
  assert.equal(tokenMatches(a, a), true);
  assert.equal(tokenMatches(a, b), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches(undefined, a), false);
});

test('/health is open and names the agent and the relay, revealing only a token fingerprint', async (t) => {
  const { token, base } = await bootServer(t);
  const h = await fetch(`${base}/health`).then((r) => r.json());
  assert.deepEqual(h.agent, AGENT);
  assert.equal(h.relay.pages, 1);
  assert.equal(h.token_fingerprint, token.slice(0, 8));
  assert.ok(!JSON.stringify(h).includes(token));
});

test('every prompt-facing route needs the token; a foreign origin is refused before the token is read', async (t) => {
  const { token, base } = await bootServer(t);
  for (const [method, path] of [['GET', '/tools'], ['POST', '/prompt']]) {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: EXT }, body: method === 'POST' ? '{"prompt":"x"}' : undefined });
    assert.equal(r.status, 401, `${method} ${path} without a token`);
  }
  const foreign = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'x-sidecar-token': token }, body: '{"prompt":"x"}' });
  assert.equal(foreign.status, 403, 'an open tab on another origin cannot submit prompts, token or not');
  const pre = await fetch(`${base}/prompt`, { method: 'OPTIONS', headers: { origin: EXT } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /x-sidecar-token/);
  assert.equal(pre.headers.get('access-control-allow-origin'), EXT);
});

test('a prompt with the token runs the agent and returns its named result; a bad body is a 400', async (t) => {
  const { token, base } = await bootServer(t);
  const H = { 'content-type': 'application/json', origin: EXT, 'x-sidecar-token': token };
  const tools = await fetch(`${base}/tools`, { headers: H }).then((r) => r.json());
  assert.deepEqual(tools, { tools: ['read_ledger'] });
  const ok = await fetch(`${base}/prompt`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'hello' }) });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.final, 'echo hello');
  assert.deepEqual(body.agent, AGENT);
  const bad = await fetch(`${base}/prompt`, { method: 'POST', headers: H, body: '{"nope":1}' });
  assert.equal(bad.status, 400);
});

test('an agent failure is a 500 that still names the agent, never a hung panel', async (t) => {
  const { token, base } = await bootServer(t, async () => { throw new Error('ollama 503: loading'); });
  const r = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json', origin: EXT, 'x-sidecar-token': token }, body: '{"prompt":"x"}' });
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.match(body.error, /ollama 503/);
  assert.deepEqual(body.agent, AGENT);
});

// --- end to end through the REAL relay core, with a fake page on the far side --
test('prompt → model → relay → page → model: the page\'s answer comes back through the loop, and the relay saw exactly one call', async (t) => {
  const PAGE = 'http://localhost:5177';
  const relayToken = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const relay = createRelay({ pageOrigin: PAGE, token: relayToken, port: 0, firstListWaitMs: 100 });
  await new Promise((r) => relay.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${relay.httpServer.address().port}`;
  t.after(() => relay.httpServer.close());
  const H = { 'content-type': 'application/json', 'x-bridge-token': relayToken, origin: PAGE };
  await fetch(`${base}/tools`, { method: 'POST', headers: H, body: JSON.stringify({ tools: [READ] }) });

  // The fake page: attached over SSE, answers each call as the shim would.
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/events?token=${relayToken}`, { headers: { origin: PAGE }, signal: ctrl.signal });
  t.after(() => ctrl.abort());
  const reader = stream.body.getReader(); const dec = new TextDecoder();
  const pageAnswers = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
      const m = buf.match(/data: (\{.*\})\n\n/);
      if (m) {
        buf = '';
        const msg = JSON.parse(m[1]);
        await fetch(`${base}/result`, { method: 'POST', headers: H, body: JSON.stringify({ id: msg.id, ok: true, text: `Entries 1–4 of 4 (limit ${msg.args.limit})` }) });
      }
    }
  })();
  pageAnswers.catch(() => {});

  const listTools = async () => (await relay.mcpHandlers.listTools()).tools;
  const callTool = async (name, args) => {
    const r = await relay.mcpHandlers.callTool({ name, arguments: args });
    return { text: r.content[0].text, isError: Boolean(r.isError) };
  };
  const { chat } = fakeChat([
    { content: '', tool_calls: [{ function: { name: 'read_ledger', arguments: { limit: 4 } } }] },
    { content: 'The chain has four entries.' },
  ]);
  const res = await runPrompt({ prompt: 'read the ledger', agent: AGENT, chat, listTools, callTool });
  assert.equal(res.transcript[1].text, 'Entries 1–4 of 4 (limit 4)', 'the page\'s own answer, through the relay');
  assert.equal(res.transcript[1].isError, false);
  assert.equal(res.final, 'The chain has four entries.');
  assert.equal(relay.state.pending.size, 0, 'nothing left pending on the relay');
});
