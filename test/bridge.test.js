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
import { seedRoom } from '../src/room.js';

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
  assert.equal(w.streams[0].url, `${RELAY}/events?token=${encodeURIComponent(TOKEN)}`, 'EventSource cannot carry a header, so the token rides the query');
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
