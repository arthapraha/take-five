// The local agent bridge — relay side (bridge/relay-core.mjs), tested pure.
//
// The relay is a trust boundary: it decides which page it serves, who may
// drive the room's tools through it, and how many tabs may be attached. Every
// line of that boundary was a review finding (Hermes, take-five seq 1654) and
// each is pinned here against a real http server on an OS-assigned port, so a
// future change to the boundary fails a test instead of shipping quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, tokenMatches, presentedToken, normaliseSchema } from '../bridge/relay-core.mjs';

test('a schema pushed as a JSON string (native Chrome 152) is listed as an object; junk becomes the empty object schema', async (t) => {
  // Live 2 Sept 06:52Z: the owner's native Chrome pushed five of seven schemas as
  // strings; the MCP client rejected tools/list and the sidecar process died.
  const schema = { type: 'object', properties: { limit: { type: 'integer' } } };
  assert.deepEqual(normaliseSchema(JSON.stringify(schema)), schema);
  assert.deepEqual(normaliseSchema(schema), schema);
  for (const junk of ['not json', '[1,2]', 42, null, undefined, [1]]) assert.deepEqual(normaliseSchema(junk), { type: 'object', properties: {} });
  // The fallback is LOUD (counsel seq 1776): junk warns, an absent schema (a
  // tool that takes nothing) does not, and a parseable string never does.
  const warned = [];
  normaliseSchema('not json', (m) => warned.push(m));
  normaliseSchema(42, (m) => warned.push(m));
  normaliseSchema(undefined, (m) => warned.push(m));
  normaliseSchema(JSON.stringify(schema), (m) => warned.push(m));
  assert.equal(warned.length, 2);
  assert.match(warned[0], /NO parameters/);
  const logs = [];
  const { base, relay } = await boot(t, { firstListWaitMs: 100, log: (m) => logs.push(m) });
  await fetch(`${base}/tools`, { method: 'POST', headers: H, body: JSON.stringify({ tools: [
    { name: 'read_ledger', inputSchema: JSON.stringify(schema) },
    { name: 'current_phase', inputSchema: { type: 'object', properties: {} } },
    { name: 'odd', inputSchema: 'nope' },
  ] }) });
  const { tools } = await relay.mcpHandlers.listTools();
  assert.deepEqual(tools.map((x) => x.inputSchema), [schema, { type: 'object', properties: {} }, { type: 'object', properties: {} }]);
  for (const x of tools) assert.equal(typeof x.inputSchema, 'object', 'an MCP client validates this strictly');
  assert.ok(logs.some((m) => /tool "odd": inputSchema unusable/.test(m)), 'the relay log names the tool whose schema it could not use');
  assert.ok(!logs.some((m) => /tool "read_ledger": inputSchema unusable/.test(m)), 'a parseable string is the normal path, not a warning');
});

const PAGE = 'http://localhost:5177';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

async function boot(t, opts = {}) {
  const relay = createRelay({ pageOrigin: PAGE, token: TOKEN, port: 0, ...opts });
  await new Promise((r) => relay.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${relay.httpServer.address().port}`;
  t.after(() => relay.httpServer.close());
  return { relay, base };
}

const H = { 'content-type': 'application/json', 'x-bridge-token': TOKEN, origin: PAGE };

test('the relay serves exactly one origin, and refuses to be built without one', () => {
  assert.throws(() => createRelay({}), /pageOrigin is required/);
  assert.throws(() => createRelay({ pageOrigin: 'not a url' }), /not a URL/);
  assert.throws(() => createRelay({ pageOrigin: 'http://localhost:5177/room' }), /bare origin/);
  const r = createRelay({ pageOrigin: PAGE, token: TOKEN, port: 7340 });
  assert.equal(r.origin, PAGE);
  assert.equal(r.bridgeUrl(), `${PAGE}/?bridge=http://127.0.0.1:7340&token=${TOKEN}`, 'the URL it prints is built from the origin it serves');
});

test('a foreign origin is refused before the token is even looked at', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/tools`, { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: '{"tools":[]}' });
  assert.equal(res.status, 403);
  const pre = await fetch(`${base}/tools`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(pre.status, 403, 'and the preflight says so too');
});

test('the preflight names the token header, so the browser will actually send the POST', async (t) => {
  const { base } = await boot(t);
  const pre = await fetch(`${base}/tools`, { method: 'OPTIONS', headers: { origin: PAGE } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /x-bridge-token/i, 'spike run 1 failed for exactly this');
  assert.equal(pre.headers.get('access-control-allow-origin'), PAGE);
});

test('every room-facing route needs the token; /health does not, and reveals only a fingerprint', async (t) => {
  const { base } = await boot(t);
  const health = await fetch(`${base}/health`).then((r) => r.json());
  assert.equal(health.token_fingerprint, TOKEN.slice(0, 8));
  assert.ok(!JSON.stringify(health).includes(TOKEN));
  for (const [method, path] of [['POST', '/tools'], ['POST', '/result'], ['GET', '/events']]) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: PAGE }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 401, `${method} ${path} without a token`);
  }
});

test('the query-string token is honoured on /events only — nowhere it could land in a log', async (t) => {
  const { base } = await boot(t);
  const viaQuery = await fetch(`${base}/tools?token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: PAGE }, body: '{"tools":[]}' });
  assert.equal(viaQuery.status, 401, 'a POST must present the token in the header');
  const viaHeader = await fetch(`${base}/tools`, { method: 'POST', headers: H, body: '{"tools":[]}' });
  assert.equal(viaHeader.status, 204);
  // presentedToken is the single place that rule lives.
  const mk = (pathname, header, query) => presentedToken({ headers: header ? { 'x-bridge-token': header } : {} }, new URL(`http://x${pathname}${query ? `?token=${query}` : ''}`));
  assert.equal(mk('/events', null, 'q'), 'q', 'EventSource cannot set a header, so the query is accepted there');
  assert.equal(mk('/tools', null, 'q'), null);
  assert.equal(mk('/result', null, 'q'), null);
  assert.equal(mk('/tools', 'h', 'q'), 'h', 'a header always wins');
});

test('the token compare is constant-time and refuses length mismatches and empties', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN.slice(0, -1), TOKEN), false);
  assert.equal(tokenMatches(TOKEN + '0', TOKEN), false);
  assert.equal(tokenMatches('', ''), false, 'two empties must not match — an unset token would otherwise open the door');
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches(TOKEN, undefined), false);
});

test('one page at a time: a second tab is refused, not silently handed the room', async (t) => {
  const { base, relay } = await boot(t);
  const ctrl = new AbortController();
  const first = fetch(`${base}/events?token=${TOKEN}`, { headers: { origin: PAGE }, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.state.page !== null, true, 'the first tab is attached');
  const second = await fetch(`${base}/events?token=${TOKEN}`, { headers: { origin: PAGE } });
  assert.equal(second.status, 409);
  assert.match(await second.text(), /one at a time/);
  ctrl.abort();
  await first.catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.state.page, null, 'and detaching frees the seat');
});

test('the MCP face mirrors the page: list follows /tools, call forwards and returns the page\'s text', async (t) => {
  // Short first-list bound: this test lists BEFORE any page speaks on purpose,
  // and the point is what it answers then, not how long it waits (that has its
  // own test). Without the override this sat through the full 45 s.
  const { base, relay } = await boot(t, { firstListWaitMs: 100 });
  assert.deepEqual((await relay.mcpHandlers.listTools()).tools, [], 'nothing invented before the page speaks');
  const unknown = await relay.mcpHandlers.callTool({ name: 'read_ledger', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /no tool "read_ledger"/);

  await fetch(`${base}/tools`, { method: 'POST', headers: H, body: JSON.stringify({ tools: [{ name: 'read_ledger', description: 'Read', inputSchema: { type: 'object', properties: {} } }] }) });
  assert.deepEqual((await relay.mcpHandlers.listTools()).tools.map((x) => x.name), ['read_ledger']);

  // Attach a page and answer the call it is sent, as the shim would.
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/events?token=${TOKEN}`, { headers: { origin: PAGE }, signal: ctrl.signal });
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  const calling = relay.mcpHandlers.callTool({ name: 'read_ledger', arguments: { limit: 2 } });
  let buf = '';
  let msg = null;
  while (!msg) {
    const { value } = await reader.read();
    buf += dec.decode(value);
    const m = buf.match(/data: (\{.*\})\n\n/);
    if (m) msg = JSON.parse(m[1]);
  }
  assert.equal(msg.name, 'read_ledger');
  assert.deepEqual(msg.args, { limit: 2 });
  await fetch(`${base}/result`, { method: 'POST', headers: H, body: JSON.stringify({ id: msg.id, ok: true, text: 'Entries 1–3 of 3' }) });
  const result = await calling;
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Entries 1–3 of 3');
  ctrl.abort();
});

test('the first tools/list waits for the page rather than answering "nothing" into a one-shot client', async (t) => {
  // Palmhouse's runner lists once at boot and never again (runner.js #bootMcp).
  // Spike run 4 booted GLM against an empty relay and it would have stayed
  // blind for the whole session.
  const { base, relay } = await boot(t, { firstListWaitMs: 2_000 });
  const listing = relay.mcpHandlers.listTools();
  let settled = false;
  listing.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false, 'no answer yet — the page has not spoken');
  await fetch(`${base}/tools`, { method: 'POST', headers: H, body: JSON.stringify({ tools: [{ name: 'read_ledger' }, { name: 'current_phase' }] }) });
  const first = await listing;
  assert.deepEqual(first.tools.map((x) => x.name), ['read_ledger', 'current_phase'], 'the first list is the page\'s first push');
  // Later lists never wait: the page has spoken once, the current list is the answer.
  const t0 = Date.now();
  await relay.mcpHandlers.listTools();
  assert.ok(Date.now() - t0 < 500);
});

test('the first tools/list gives up after its bound and answers what it has, loudly empty', async (t) => {
  const { relay } = await boot(t, { firstListWaitMs: 150 });
  const t0 = Date.now();
  const first = await relay.mcpHandlers.listTools();
  assert.ok(Date.now() - t0 >= 140, 'it waited');
  assert.deepEqual(first.tools, [], 'and did not invent anything when no page came');
});

test('a call with no page attached fails loudly and names the URL to open', async (t) => {
  const { base, relay } = await boot(t);
  await fetch(`${base}/tools`, { method: 'POST', headers: H, body: JSON.stringify({ tools: [{ name: 'read_ledger' }] }) });
  const res = await relay.mcpHandlers.callTool({ name: 'read_ledger', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no page is attached/);
  assert.match(res.content[0].text, /\?bridge=http:\/\/127\.0\.0\.1:0&token=/, 'the operator is told exactly what to open');
});

test('t-089f: one page at a time on EVERY route — a second page is refused at its first push, so it can never record a door that will not open', async (t) => {
  const { base, relay } = await boot(t, { firstListWaitMs: 100 });
  const A = { ...H, 'x-bridge-page': 'a'.repeat(32) };
  const B = { ...H, 'x-bridge-page': 'b'.repeat(32) };
  // Page A pushes, then attaches.
  assert.equal((await fetch(`${base}/tools`, { method: 'POST', headers: A, body: '{"tools":[{"name":"read_ledger"}]}' })).status, 204);
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/events?token=${TOKEN}&page=${'a'.repeat(32)}`, { headers: { origin: PAGE }, signal: ctrl.signal });
  assert.equal(stream.status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(relay.state.pageId, 'a'.repeat(32));
  // Page B: refused on /tools (the 1 Sept failure), on /events, and on /result.
  const pushB = await fetch(`${base}/tools`, { method: 'POST', headers: B, body: '{"tools":[{"name":"x"}]}' });
  assert.equal(pushB.status, 409);
  assert.match(await pushB.text(), /one at a time/);
  assert.deepEqual(relay.state.tools.map((x) => x.name), ['read_ledger'], 'B changed nothing');
  assert.equal((await fetch(`${base}/events?token=${TOKEN}&page=${'b'.repeat(32)}`, { headers: { origin: PAGE } })).status, 409);
  assert.equal((await fetch(`${base}/result`, { method: 'POST', headers: B, body: '{"id":1,"ok":true,"text":"x"}' })).status, 409);
  // Page A itself keeps working, and /health stays open to everyone.
  assert.equal((await fetch(`${base}/tools`, { method: 'POST', headers: A, body: '{"tools":[{"name":"read_ledger"},{"name":"current_phase"}]}' })).status, 204);
  assert.equal((await fetch(`${base}/health`).then((r) => r.json())).pages, 1);
  // A detaches: the slot and the nonce are freed; B may now attach.
  ctrl.abort();
  await stream.body?.cancel?.().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.state.page, null); assert.equal(relay.state.pageId, null);
  assert.equal((await fetch(`${base}/tools`, { method: 'POST', headers: B, body: '{"tools":[{"name":"x"}]}' })).status, 204);
});

test('a public https page reaching the loopback relay is a private-network request: the preflight for OUR origin carries Access-Control-Allow-Private-Network, a foreign one does not', async (t) => {
  // 2 Sept 08:5x UK: the branch preview (https) could not push to 127.0.0.1 from
  // the Browser pane; whatever the pane's own policy, real Chrome applies Private
  // Network Access and needs this header on the preflight.
  const { base } = await boot(t);
  const ours = await fetch(`${base}/tools`, { method: 'OPTIONS', headers: { origin: PAGE, 'access-control-request-private-network': 'true' } });
  assert.equal(ours.status, 204);
  assert.equal(ours.headers.get('access-control-allow-private-network'), 'true');
  assert.match(ours.headers.get('access-control-allow-headers'), /x-bridge-page/, 'and the page nonce header is allowed');
  const foreign = await fetch(`${base}/tools`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-private-network': 'true' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-private-network'), null, 'never granted to an origin we do not serve');
});
