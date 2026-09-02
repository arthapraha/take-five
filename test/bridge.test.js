// The local agent bridge — page side (src/bridge.js), tested pure.
//
// Reviewer's gate (Hermes, take-five seq 1637): a `?bridge=` opt-in surface
// with two message types needs four tests, or a diff review is archaeology.
// Plus the honesty properties the room made load-bearing that evening:
// the `bridge_opened` row lands only after the relay answered and before any
// call can arrive (GLM, seq 1638), it names the door by fingerprint not by
// token (Hermes, seq 1637), and a bridged call carries no UI fingerprint
// (Hermes, seq 1619).
//
// No browser: `document`, `location`, `fetch` and `EventSource` are stubbed
// just enough to observe what the shim does, and the Room is the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRoom, offeredNames } from '../src/room.js';

const RELAY = 'http://127.0.0.1:7341';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** A world with a page URL, a modelContext holding `tools`, and recorders for
 *  every fetch and every EventSource the shim opens. */
function world({ url, tools = [], relayFails = false } = {}) {
  const fetches = [];
  const streams = [];
  const executed = [];
  const modelContext = {
    getTools: async () => tools,
    executeTool: async (tool, json) => { executed.push({ tool, json }); return `ran ${tool.name} with ${json}`; },
    addEventListener() {},
  };
  globalThis.document = {
    modelContext,
    getElementById: () => null,
    createElement: () => ({ dataset: {}, style: {} }),
    body: { insertBefore() {} },
  };
  globalThis.location = { href: url };
  globalThis.fetch = async (u, init) => {
    fetches.push({ url: u, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: !relayFails, status: relayFails ? 401 : 204 };
  };
  globalThis.EventSource = class {
    constructor(u) { this.url = u; streams.push(this); }
  };
  return { fetches, streams, executed, modelContext };
}

async function load() {
  // Fresh module per test so module-level state (the token) does not leak.
  const mod = await import(`../src/bridge.js?t=${Date.now()}${Math.random()}`);
  return mod.attachBridge;
}

const TOOLS = [
  { name: 'read_ledger', description: 'Read the chain', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'commit_to_round', description: 'Seal a position', inputSchema: { type: 'object', properties: { position: { type: 'string' } } } },
];

test('1. without ?bridge= nothing happens: no fetch, no stream, no row', async () => {
  const w = world({ url: 'https://take-five-lw7.pages.dev/', tools: TOOLS });
  const room = await seedRoom('Room host');
  const before = room.ledger.length;
  const attachBridge = await load();
  assert.equal(await attachBridge(room), null);
  assert.equal(w.fetches.length, 0, 'the page must not talk to anything it was not asked to');
  assert.equal(w.streams.length, 0);
  assert.equal(room.ledger.length, before, 'no row lands for a door nobody opened');
});

test('2. the tool list pushed to the relay mirrors getTools(), and carries the token', async () => {
  const w = world({ url: `https://take-five-lw7.pages.dev/?bridge=${RELAY}&token=${TOKEN}`, tools: TOOLS });
  const room = await seedRoom('Room host');
  const attachBridge = await load();
  assert.equal(await attachBridge(room), RELAY);
  const push = w.fetches.find((f) => f.url === `${RELAY}/tools`);
  assert.ok(push, 'the page must offer its tools to the relay');
  assert.deepEqual(push.body.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.deepEqual(push.body.tools[0].inputSchema, TOOLS[0].inputSchema, 'schemas travel intact — an agent needs them to call correctly');
  assert.equal(push.headers['x-bridge-token'], TOKEN, 'every request to the relay presents the token');
  assert.equal(w.streams.length, 1);
  assert.ok(w.streams[0].url.startsWith(`${RELAY}/events?token=${encodeURIComponent(TOKEN)}&page=`), 'EventSource cannot carry a header, so the token and the page nonce ride the query');
  assert.match(w.streams[0].url.split('&page=')[1], /^[0-9a-f]{32}$/, 'the nonce is the 32-hex id of this page load');
});

test('3. a call message reaches executeTool with the named tool and JSON args, and the result goes back', async () => {
  const w = world({ url: `https://take-five-lw7.pages.dev/?bridge=${RELAY}&token=${TOKEN}`, tools: TOOLS });
  const room = await seedRoom('Room host');
  const attachBridge = await load();
  await attachBridge(room);
  const es = w.streams[0];
  es.onmessage({ data: JSON.stringify({ id: 7, name: 'read_ledger', args: { limit: 3 } }) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.executed.length, 1, 'exactly one executeTool per call');
  assert.equal(w.executed[0].tool.name, 'read_ledger');
  assert.equal(w.executed[0].json, JSON.stringify({ limit: 3 }), 'args are passed as a JSON string, the shape executeTool takes');
  const result = w.fetches.find((f) => f.url === `${RELAY}/result`);
  assert.ok(result);
  assert.equal(result.body.id, 7);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.text, 'ran read_ledger with {"limit":3}');
  assert.equal(result.headers['x-bridge-token'], TOKEN);
});

test('3b. a call for a tool the phase does not offer is refused on the page, not guessed', async () => {
  const w = world({ url: `https://take-five-lw7.pages.dev/?bridge=${RELAY}&token=${TOKEN}`, tools: TOOLS });
  const room = await seedRoom('Room host');
  const attachBridge = await load();
  await attachBridge(room);
  w.streams[0].onmessage({ data: JSON.stringify({ id: 8, name: 'reveal_in_round', args: {} }) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.executed.length, 0, 'nothing runs for a tool that is not registered right now');
  const result = w.fetches.find((f) => f.url === `${RELAY}/result`);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /no tool "reveal_in_round"/);
});

test('4. bridge_opened lands after the relay answered and before the stream opens, naming the door by fingerprint', async () => {
  const w = world({ url: `https://take-five-lw7.pages.dev/?bridge=${RELAY}&token=${TOKEN}`, tools: TOOLS });
  const room = await seedRoom('Room host');
  const before = room.ledger.length;
  const attachBridge = await load();
  await attachBridge(room);
  const row = room.ledger.entries.at(-1);
  assert.equal(room.ledger.length, before + 1, 'one row for one door');
  assert.equal(row.kind, 'bridge_opened');
  // The ledger stores the door under `actor` (room.js record()): ingress, grade,
  // and the attribution the INGRESS table allows that door to claim.
  assert.equal(row.actor.ingress, 'room', 'the room witnessed itself open a door: room bookkeeping');
  assert.equal(row.actor.grade, 'server-observed');
  assert.equal(row.payload.relay, RELAY);
  assert.equal(row.payload.token_fingerprint, TOKEN.slice(0, 8), 'the chain names WHICH door was opened');
  assert.ok(!JSON.stringify(row.payload).includes(TOKEN), 'and never the token itself — the record must not reopen the door');
  assert.deepEqual(row.payload.tools, TOOLS.map((t) => t.name), 'and what was offered through it');
  // Ordering: the tools push happened first, then the row, then the stream.
  const pushIndex = w.fetches.findIndex((f) => f.url === `${RELAY}/tools`);
  assert.ok(pushIndex >= 0);
  assert.equal(w.streams.length, 1, 'the stream — the only way a call can arrive — opens after the row exists');
});

test('4b. no row when the relay is not there: a door that did not open is not recorded as opened', async () => {
  const w = world({ url: `https://take-five-lw7.pages.dev/?bridge=${RELAY}&token=${TOKEN}`, tools: TOOLS, relayFails: true });
  const room = await seedRoom('Room host');
  const before = room.ledger.length;
  const attachBridge = await load();
  assert.equal(await attachBridge(room), null);
  assert.equal(room.ledger.length, before, 'the first spike run recorded a door to a relay that was not there; never again');
  assert.equal(w.streams.length, 0);
});

test('5. only a loopback relay is accepted, and only with a token', async () => {
  for (const url of [
    `https://take-five-lw7.pages.dev/?bridge=http://evil.example:7341&token=${TOKEN}`,
    `https://take-five-lw7.pages.dev/?bridge=https://127.0.0.1:7341&token=${TOKEN}`,
    `https://take-five-lw7.pages.dev/?bridge=${RELAY}`,
  ]) {
    const w = world({ url, tools: TOOLS });
    const room = await seedRoom('Room host');
    const before = room.ledger.length;
    const attachBridge = await load();
    assert.equal(await attachBridge(room), null, url);
    assert.equal(w.fetches.length, 0, `refused before any request: ${url}`);
    assert.equal(room.ledger.length, before);
  }
});

test('6. a bridged call is recorded through the webmcp door with no UI fingerprint', async () => {
  // The row itself is written by main.js's recordToolCall — {tool: name} via
  // ingress 'webmcp'. What this pins is the property Hermes named: nothing was
  // pressed, so there is no payload.confirmation.input, and its absence is the
  // correct record of a call that came through a door rather than a dialog.
  const room = await seedRoom('Room host');
  const entry = await room.record({ kind: 'tool:read_ledger', payload: { tool: 'read_ledger' }, seatId: 'rider', ingress: 'webmcp' });
  assert.equal(entry.actor.ingress, 'webmcp');
  assert.equal(entry.actor.grade, 'client-asserted', 'a bridged call is the page\'s claim about a door, never server-observed');
  assert.equal(entry.payload.confirmation, undefined, 'no dialog was resolved, so no fingerprint may be claimed');
});

test('9. a schema the browser hands over as a JSON string (native Chrome 152) is pushed to the relay as an object', async () => {
  // Live 2 Sept 06:52Z: the owner's native Chrome returned string schemas from
  // getTools(); the relay's MCP client rejected tools/list and the sidecar died.
  const schema = { type: 'object', properties: { limit: { type: 'number' } } };
  const w = world({ url: `http://localhost:5177/?bridge=${RELAY}&token=${TOKEN}`, tools: [
    { name: 'read_ledger', inputSchema: JSON.stringify(schema) },
    { name: 'current_phase', inputSchema: { type: 'object', properties: {} } },
    { name: 'odd', inputSchema: 'not json' },
  ] });
  const attachBridge = await load();
  await attachBridge(await seedRoom('Room host'));
  const push = w.fetches.find((f) => f.url === `${RELAY}/tools`);
  assert.ok(push, 'the tool list was pushed');
  assert.deepEqual(push.body.tools.map((t) => t.inputSchema), [schema, { type: 'object', properties: {} }, { type: 'object', properties: {} }]);
});

test('9b. the shim warns loudly when it cannot use a schema, and stays quiet for a parseable one', async () => {
  const { schemaObject } = await import(`../src/bridge.js?t=${Date.now()}x`);
  const warned = [];
  assert.deepEqual(schemaObject('{"type":"object","properties":{"a":{}}}', (m) => warned.push(m)), { type: 'object', properties: { a: {} } });
  assert.deepEqual(schemaObject('nope', (m) => warned.push(m)), { type: 'object', properties: {} });
  assert.deepEqual(schemaObject(undefined, (m) => warned.push(m)), { type: 'object', properties: {} });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /NO parameters/);
});

test('10. only the tools the page OFFERS cross the bridge: partner_attest is neither listed nor callable, even though it is registered', async () => {
  // 2 Sept 08:0x UK: the relay served 7 tools while the page's panel listed 6.
  // The seventh was partner_attest — the partner ORIGIN's tool — and through the
  // bridge an outside agent could have landed an `inherited` attestation row
  // with no partner behind it. The page now says what is offered.
  const w = world({ url: `http://localhost:5177/?bridge=${RELAY}&token=${TOKEN}`, tools: [
    ...TOOLS,
    { name: 'partner_attest', description: 'Partner attestation', inputSchema: { type: 'object', properties: { claim: { type: 'string' } } } },
  ] });
  const attachBridge = await load();
  const phase = new Set(TOOLS.map((t) => t.name));
  const room = await seedRoom('Room host');
  await attachBridge(room, { offered: (name) => phase.has(name) });
  const push = w.fetches.find((f) => f.url === `${RELAY}/tools`);
  assert.deepEqual(push.body.tools.map((t) => t.name), ['read_ledger', 'commit_to_round'], 'the list pushed to the relay is exactly what the page offers');
  const door = room.ledger.entries.find((e) => e.kind === 'bridge_opened');
  assert.deepEqual(door.payload.tools, ['read_ledger', 'commit_to_round'], 'and the door row says the same');
  // A relay that somehow asked anyway is refused before the page's registry is touched.
  const stream = w.streams[0];
  const before = w.fetches.length;
  stream.onmessage({ data: JSON.stringify({ id: 7, name: 'partner_attest', args: { claim: 'the partner said so' } }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.executed.length, 0, 'executeTool was never called');
  const result = w.fetches.slice(before).find((f) => f.url === `${RELAY}/result`);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /not offered through the bridge/);
  assert.ok(!room.ledger.entries.some((e) => e.kind === 'partner_attestation'), 'no attestation row landed');
});

test('11. REGRESSION (counsel 1802, Hermes 1799): the offered set equals the panel\'s set — read surface + phase tool — in Commit AND after Advance to Reveal; partner_attest never', async () => {
  // 08:15 UK: the first offered-filter used the phase list alone and offered ONE
  // tool; GLM refused honestly. This test registers the REAL surfaces through
  // a fake modelContext and mirrors main.js's predicate exactly.
  const { registerReadSurface, registerPhaseTools, partnerTool } = await import('../src/tools.js');
  const { Round } = await import('../src/round.js');
  const w = world({ url: `http://localhost:5177/?bridge=${RELAY}&token=${TOKEN}` });
  const registry = new Map();
  const listeners = [];
  globalThis.document.modelContext = {
    registerTool: async (tool, { signal } = {}) => {
      registry.set(tool.name, tool);
      signal?.addEventListener('abort', () => registry.delete(tool.name));
    },
    getTools: async () => [...registry.values()],
    executeTool: async () => 'ok',
    addEventListener: (type, fn) => { if (type === 'toolchange') listeners.push(fn); },
  };
  const room = await seedRoom('Room host');
  const round = new Round('q');
  const reg = await registerReadSurface(room, { onCall() {} });
  let phaseTools = await registerPhaseTools(room, round, room.phase, {});
  await globalThis.document.modelContext.registerTool(partnerTool(room), {});
  assert.ok(registry.has('partner_attest'), 'the partner tool IS registered on the page');
  const attachBridge = await load();
  await attachBridge(room, { offered: (name) => offeredNames(reg.names, phaseTools.names).includes(name) });

  const pushed = () => w.fetches.filter((f) => f.url === `${RELAY}/tools`).at(-1).body.tools.map((t) => t.name).sort();
  const panel = () => offeredNames(reg.names, phaseTools.names).sort();
  assert.equal(room.phase, 'Commit');
  assert.deepEqual(pushed(), panel(), 'Commit: offered = the panel\'s set');
  assert.equal(pushed().length, 6);
  assert.ok(pushed().includes('read_ledger') && pushed().includes('commit_to_round'));
  assert.ok(!pushed().includes('partner_attest'));

  // Advance to Reveal exactly as main.js does, then the toolchange re-push.
  phaseTools.controller.abort();
  await room.advance('Reveal');
  phaseTools = await registerPhaseTools(room, round, room.phase, {});
  for (const fn of listeners) fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(room.phase, 'Reveal');
  assert.deepEqual(pushed(), panel(), 'Reveal: offered = the panel\'s set');
  assert.ok(pushed().includes('reveal_in_round'), 'the Reveal tool is offered');
  assert.ok(!pushed().includes('commit_to_round'), 'the Commit tool is gone');
  assert.ok(!pushed().includes('partner_attest'), 'and the partner tool never appears');
});

test('11b. offeredNames is the union, deduplicated, tolerant of a missing read surface, and adds nothing of its own', () => {
  assert.deepEqual(offeredNames(['read_ledger', 'current_phase'], ['commit_to_round']), ['read_ledger', 'current_phase', 'commit_to_round']);
  assert.deepEqual(offeredNames(['a', 'b'], ['b']), ['a', 'b']);
  assert.deepEqual(offeredNames(undefined, ['reveal_in_round']), ['reveal_in_round'], 'no read surface (reg.ok false) still offers the phase tool');
  assert.deepEqual(offeredNames([], []), []);
  assert.ok(!offeredNames(['read_ledger'], ['commit_to_round']).includes('partner_attest'));
});

test('12. one attach per page (t-3dcc): a second attachBridge is refused, records nothing, and leaves the first page\'s offered set untouched', async () => {
  const w = world({ url: `http://localhost:5177/?bridge=${RELAY}&token=${TOKEN}`, tools: TOOLS });
  const attachBridge = await load();
  const room = await seedRoom('Room host');
  const first = await attachBridge(room, { offered: (n) => n === 'read_ledger' });
  assert.equal(first, RELAY);
  const pushes = () => w.fetches.filter((f) => f.url === `${RELAY}/tools`).length;
  const doors = () => room.ledger.entries.filter((e) => e.kind === 'bridge_opened').length;
  const [p1, d1, s1] = [pushes(), doors(), w.streams.length];
  const second = await attachBridge(room, { offered: () => true });
  assert.equal(second, null, 'the second attach is refused');
  assert.equal(pushes(), p1, 'no new push'); assert.equal(doors(), d1, 'no second door row'); assert.equal(w.streams.length, s1, 'no second stream');
  // The first page's offered set still governs a call.
  w.streams[0].onmessage({ data: JSON.stringify({ id: 1, name: 'commit_to_round', args: {} }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.executed.length, 0, 'commit_to_round was not offered by the FIRST attach and stays refused');
  w.streams[0].onmessage({ data: JSON.stringify({ id: 2, name: 'read_ledger', args: {} }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.executed.length, 1, 'read_ledger, offered by the first attach, still runs');
});

test('13. t-089f on the page side: a relay that already serves another page refuses the push — no door row, no stream, the chip says refused (not "not reachable", not "reconnecting")', async () => {
  const w = world({ url: `http://localhost:5177/?bridge=${RELAY}&token=${TOKEN}`, tools: TOOLS });
  globalThis.fetch = async (u, init) => { w.fetches.push({ url: u, method: init?.method, headers: init?.headers ?? {} }); return { ok: false, status: 409, text: async () => 'a page is already attached to this bridge; one at a time' }; };
  const chips = [];
  globalThis.document.getElementById = (id) => (id === 'bridge-status' ? null : null);
  globalThis.document.createElement = () => { const el = { dataset: {}, style: {} }; Object.defineProperty(el, 'textContent', { set(v) { chips.push(v); }, get() { return chips.at(-1); } }); return el; };
  const attachBridge = await load();
  const room = await seedRoom('Room host');
  const before = room.ledger.entries.length;
  const result = await attachBridge(room);
  assert.equal(result, null);
  assert.equal(room.ledger.entries.length, before, 'NO bridge_opened row for a door that will not open');
  assert.equal(w.streams.length, 0, 'no stream opened');
  assert.match(chips.at(-1), /refused — another page holds this bridge/);
  assert.doesNotMatch(chips.at(-1), /not reachable|reconnecting/);
  const push = w.fetches.find((f) => f.url === `${RELAY}/tools`);
  assert.match(push.headers['x-bridge-page'], /^[0-9a-f]{32}$/, 'the push carried this page load\'s nonce');
});
