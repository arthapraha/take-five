// The extension-carried page endpoint (extension/page-endpoint.js), run the
// way Chrome runs it — a classic script evaluated in a fresh context whose
// `window`, `document` and `CustomEvent` are fakes — and driven by the same
// messages the panel sends. The two conditions counsel set on t-4202
// (take-five seq 2118) are #2 and #3: no call before the page's recorded ack,
// and the page's offered set enforced at the door — `partner_attest` refused
// through this transport exactly as bridge.test.js #10 pins it for the shim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../extension/page-endpoint.js', import.meta.url), 'utf8');

const TOOLS = [
  { name: 'read_ledger', description: 'Read the chain', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'commit_to_round', description: 'Seal a position', inputSchema: '{"type":"object","properties":{"position":{"type":"string"}}}' },
  { name: 'partner_attest', description: 'Partner origin only', inputSchema: { type: 'object', properties: {} } },
];
const OFFERED = (name) => name !== 'partner_attest';

class FakeEvent {
  constructor(type, { detail, cancelable = false } = {}) { this.type = type; this.detail = detail; this.cancelable = cancelable; this.defaultPrevented = false; }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}

function world({ tools = TOOLS, takeFive = true, now = () => 0 } = {}) {
  const posted = []; const executed = []; const logged = []; const scheduled = [];
  const listeners = new Map();
  const counts = { getTools: 0 };
  let toolchange = null;
  const document = {
    title: 'Take Five', location: { href: 'https://take-five-lw7.pages.dev/' },
    documentElement: { dataset: takeFive ? { takeFive: 'room' } : {} },
    modelContext: {
      getTools: async () => { counts.getTools += 1; return tools; },
      executeTool: async (tool, json) => { executed.push({ name: tool.name, json }); return `ran ${tool.name}`; },
      addEventListener: (type, fn) => { if (type === 'toolchange') toolchange = fn; },
      removeEventListener: () => {},
    },
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
    dispatchEvent: (ev) => { for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev); return !ev.defaultPrevented; },
  };
  let onMessage = null;
  const window = { postMessage: (msg) => posted.push(msg), addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; }, removeEventListener: (t, fn) => { if (t === 'message' && onMessage === fn) onMessage = null; } };
  const sandbox = { window, document, CustomEvent: FakeEvent, __takeFiveNoAutostart: true };
  vm.runInNewContext(SRC, sandbox);
  const endpoint = sandbox.__takeFiveCreatePageEndpoint({ document, window, CustomEvent: FakeEvent, log: (m) => logged.push(m), schedule: (fn, ms) => scheduled.push({ fn, ms }), now });
  const fromExt = (msg) => { if (onMessage) onMessage({ source: window, data: { source: 'take-five-bridge/ext', ...msg } }); };
  const listening = () => onMessage !== null;
  const dispatched = (type) => (listeners.get(type) ?? []).length;
  return { posted, executed, logged, scheduled, counts, document, window, endpoint, fromExt, listening, fireToolChange: () => toolchange?.(), dispatched };
}
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// Messages are built inside the script's own realm: compared by shape, not prototype.
const shape = (o) => JSON.parse(JSON.stringify(o));
const ofType = (posted, type) => posted.filter((m) => m.type === type);

/** A Take Five page that claims the door, records, and acks with `offered`. */
function takeFivePage(w, { offered = OFFERED, sync = false } = {}) {
  const claims = [];
  w.document.addEventListener('take-five:bridge-attached', (ev) => {
    claims.push(ev.detail);
    ev.preventDefault();
    const ack = () => w.document.dispatchEvent(new FakeEvent('take-five:bridge-recorded', { detail: { offered, tools: [] } }));
    if (sync) ack(); else setImmediate(ack);
  });
  return claims;
}

test('1. a page that is not Take Five claims nothing: no chain, tools listed as registered, calls served', async () => {
  const w = world({ takeFive: false });
  w.fromExt({ type: 'hello', relay: 'http://127.0.0.1:7340', token_fingerprint: 'a1b2c3d4' });
  await settle();
  const [attached] = ofType(w.posted, 'attached');
  assert.equal(attached.takeFive, false);
  assert.deepEqual(Object.keys(shape(attached)), ['source', 'type', 'takeFive'], 'the page is not named by its own script — the panel names the tab');
  assert.equal(w.endpoint.state, 'plain');
  const [list] = ofType(w.posted, 'tools');
  assert.deepEqual(list.tools.map((t) => t.name), ['read_ledger', 'commit_to_round', 'partner_attest'], 'no scoping exists to honour on a page that has none');
  w.fromExt({ type: 'call', id: 'c1', name: 'read_ledger', args: { limit: 2 } });
  await settle();
  const [result] = ofType(w.posted, 'result');
  assert.deepEqual(shape(result), { source: 'take-five-bridge/page', type: 'result', id: 'c1', ok: true, text: 'ran read_ledger', error: null });
  assert.deepEqual(w.executed, [{ name: 'read_ledger', json: '{"limit":2}' }]);
});

test('2. on a Take Five page nothing is listed and no call is served until the page acks the recorded door; the ack is per-attach and the token never arrives', async () => {
  const w = world();
  let acked = false;
  // A stray ack from nobody's attach moves nothing (Hermes, seq 2119: the ack is
  // per-attach — an endpoint that has not said hello has no door to open).
  w.document.dispatchEvent(new FakeEvent('take-five:bridge-recorded', { detail: { offered: OFFERED } }));
  assert.equal(w.endpoint.state, 'idle');
  const seen = [];
  w.document.addEventListener('take-five:bridge-attached', (ev) => { seen.push(ev.detail); ev.preventDefault(); });
  w.fromExt({ type: 'hello', relay: 'http://127.0.0.1:7340', token_fingerprint: 'a1b2c3d4', token: 'never-sent-but-if-it-were' });
  await settle();
  assert.equal(w.endpoint.state, 'claimed');
  assert.deepEqual(Object.keys(seen[0]).sort(), ['relay', 'token_fingerprint', 'transport'], 'what the page is told: a door, a fingerprint, a transport — no token');
  assert.equal(ofType(w.posted, 'tools').length, 0, 'no tool list before the ack');
  w.fromExt({ type: 'call', id: 'early', name: 'read_ledger', args: {} });
  await settle();
  const [early] = ofType(w.posted, 'result');
  assert.equal(early.ok, false);
  assert.match(early.error, /not yet recorded/);
  assert.equal(w.executed.length, 0, 'nothing ran');
  // Now the page records and acks.
  w.document.dispatchEvent(new FakeEvent('take-five:bridge-recorded', { detail: { offered: OFFERED } }));
  acked = true;
  await settle();
  assert.equal(w.endpoint.state, 'recorded');
  assert.deepEqual(ofType(w.posted, 'tools')[0].tools.map((t) => t.name), ['read_ledger', 'commit_to_round']);
  w.fromExt({ type: 'call', id: 'late', name: 'read_ledger', args: {} });
  await settle();
  assert.equal(ofType(w.posted, 'result')[1].ok, true);
  assert.ok(acked);
});

test('3. the page\'s offered set is enforced at the door: partner_attest is neither listed nor callable, and the registry is not consulted for it', async () => {
  const w = world();
  takeFivePage(w);
  w.fromExt({ type: 'hello', relay: 'http://127.0.0.1:7340', token_fingerprint: 'a1b2c3d4' });
  await settle();
  const [list] = ofType(w.posted, 'tools');
  assert.ok(!list.tools.some((t) => t.name === 'partner_attest'), 'not listed');
  const before = w.counts.getTools;
  w.fromExt({ type: 'call', id: 'x', name: 'partner_attest', args: {} });
  await settle();
  const [result] = ofType(w.posted, 'result');
  assert.equal(result.ok, false);
  assert.match(result.error, /not offered through the bridge/);
  assert.equal(w.counts.getTools, before, 'refused BEFORE getTools — the registry was not consulted');
  assert.equal(w.executed.length, 0);
});

test('4. a Take Five page whose listener is not yet installed is asked again, never served unscoped; and refused after the wait', async () => {
  let t = 0;
  const w = world({ now: () => t });
  w.fromExt({ type: 'hello', relay: 'http://127.0.0.1:7340', token_fingerprint: 'a1b2c3d4' });
  await settle();
  assert.equal(w.endpoint.state, 'idle');
  assert.equal(ofType(w.posted, 'tools').length, 0, 'the marker says Take Five: nothing served on silence');
  assert.equal(w.scheduled.length, 1, 'a retry is scheduled');
  takeFivePage(w);
  w.scheduled.shift().fn();
  await settle();
  assert.equal(w.endpoint.state, 'recorded');
  assert.equal(ofType(w.posted, 'tools').length, 1);
  // And a page that never claims: refused once the wait is over.
  const w2 = world({ now: () => t });
  w2.fromExt({ type: 'hello', relay: 'http://127.0.0.1:7340', token_fingerprint: 'a1b2c3d4' });
  t = 6000;
  w2.scheduled.shift().fn();
  await settle();
  assert.equal(w2.endpoint.state, 'refused');
  assert.match(ofType(w2.posted, 'refused')[0].reason, /did not claim/);
});

test('5. schemas: a string schema becomes an object; an unusable one becomes the empty schema, loudly', async () => {
  const w = world({ tools: [...TOOLS, { name: 'odd', description: '', inputSchema: 'not json' }] });
  takeFivePage(w, { offered: () => true });
  w.fromExt({ type: 'hello', relay: 'http://127.0.0.1:7340', token_fingerprint: 'a1b2c3d4' });
  await settle();
  const [list] = ofType(w.posted, 'tools');
  const byName = Object.fromEntries(list.tools.map((t) => [t.name, t.inputSchema]));
  assert.deepEqual(shape(byName.commit_to_round), { type: 'object', properties: { position: { type: 'string' } } });
  assert.deepEqual(shape(byName.odd), { type: 'object', properties: {} });
  assert.match(w.logged.join('\n'), /tool "odd": inputSchema unusable/);
});

test('6. toolchange re-lists through the live offered predicate; detach closes the door and refuses what follows', async () => {
  const w = world();
  let phase = new Set(['read_ledger']);
  takeFivePage(w, { offered: (n) => phase.has(n) });
  w.fromExt({ type: 'hello', relay: 'http://127.0.0.1:7340', token_fingerprint: 'a1b2c3d4' });
  await settle();
  assert.deepEqual(ofType(w.posted, 'tools')[0].tools.map((t) => t.name), ['read_ledger']);
  phase = new Set(['read_ledger', 'commit_to_round']);
  w.fireToolChange();
  await settle();
  assert.deepEqual(ofType(w.posted, 'tools')[1].tools.map((t) => t.name), ['read_ledger', 'commit_to_round'], 'the list follows the page');
  let detached = null;
  w.document.addEventListener('take-five:bridge-detached', (ev) => { detached = ev.detail; });
  w.fromExt({ type: 'detach' });
  assert.equal(w.endpoint.state, 'closed');
  assert.equal(detached.reason, 'the panel detached');
  // The closed endpoint has left the window: nothing it could answer reaches it.
  assert.equal(w.listening(), false, 'message listener removed');
  const n = w.posted.length;
  w.fromExt({ type: 'call', id: 'after', name: 'read_ledger', args: {} });
  await settle();
  assert.equal(w.posted.length, n, 'no answer from a closed endpoint');
});
