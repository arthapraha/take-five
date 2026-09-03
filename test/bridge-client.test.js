// The panel's half of the extension-carried bridge (extension/bridge-client.js),
// driven with a fake relay, a fake stream and a recorder for what it tells the
// page. The property that matters most is the ORDER: the relay answers before
// the page is told hello, so a refused relay never yields a bridge_opened row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeClient } from '../extension/bridge-client.js';

const RELAY = 'http://127.0.0.1:7340';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function harness({ probe = 404, tools = 204, unreachable = false } = {}) {
  const fetches = []; const toPage = []; const statuses = []; const streams = [];
  const fetch = async (url, init) => {
    fetches.push({ url, method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null });
    if (unreachable) throw new TypeError('Failed to fetch');
    const path = new URL(url).pathname;
    const status = path === '/result' ? (fetches.filter((f) => new URL(f.url).pathname === '/result').length === 1 ? probe : 204) : tools;
    return { ok: status >= 200 && status < 300, status };
  };
  class EventSource {
    static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; this.closed = true; }
  }
  const client = createBridgeClient({ relay: RELAY, token: TOKEN, label: 'Take Five — the room', toPage: (m) => toPage.push(m), onStatus: (s) => statuses.push(s), fetch, EventSource, mintPageId: () => 'feedfacefeedfacefeedfacefeedface' });
  return { client, fetches, toPage, statuses, streams };
}

test('1. a refused relay means no hello: wrong token, another page, or unreachable — each named', async () => {
  for (const [opts, re] of [[{ probe: 401 }, /token refused/], [{ probe: 409 }, /another page holds/], [{ unreachable: true }, /not reachable.*--origin/]]) {
    const h = harness(opts);
    await assert.rejects(h.client.start(), re);
    assert.equal(h.toPage.length, 0, 'the page was not told hello');
    assert.equal(h.streams.length, 0);
  }
  assert.throws(() => createBridgeClient({ relay: 'http://evil.example', token: TOKEN, toPage() {} }), /only a loopback relay/);
  assert.throws(() => createBridgeClient({ relay: RELAY, token: '', toPage() {} }), /token is required/);
});

test('2. the happy order: probe (no state changed) → hello with the fingerprint → tools pushed under token and nonce → stream opened with the same nonce', async () => {
  const h = harness();
  await h.client.start();
  const [probe] = h.fetches;
  assert.equal(new URL(probe.url).pathname, '/result');
  assert.equal(probe.headers['x-bridge-token'], TOKEN);
  assert.equal(probe.headers['x-bridge-page'], 'feedfacefeedfacefeedfacefeedface');
  assert.match(probe.body.id, /^probe-/);
  assert.deepEqual(h.toPage, [{ type: 'hello', relay: RELAY, token_fingerprint: 'a1b2c3d4' }]);
  await h.client.fromPage({ type: 'attached', takeFive: true });
  assert.match(h.statuses.at(-1).text, /attached to "Take Five — the room" — waiting for the page to record the door/, 'the tab is named from the grant, not by the page');
  const tools = [{ name: 'read_ledger', description: '', inputSchema: { type: 'object', properties: {} } }, { name: 'commit_to_round', description: '', inputSchema: { type: 'object', properties: {} } }];
  await h.client.fromPage({ type: 'tools', tools });
  const push = h.fetches.find((f) => new URL(f.url).pathname === '/tools');
  assert.deepEqual(push.body, { tools });
  assert.equal(push.headers['x-bridge-page'], 'feedfacefeedfacefeedfacefeedface');
  assert.equal(h.streams.length, 1);
  assert.equal(h.streams[0].url, `${RELAY}/events?token=${TOKEN}&page=feedfacefeedfacefeedfacefeedface`);
  h.streams[0].onopen();
  assert.equal(h.statuses.at(-1).state, 'ready');
  assert.match(h.statuses.at(-1).text, /2 tools offered/);
});

test('3. a call on the stream reaches the page; its result reaches the relay; close ends the stream and tells the page', async () => {
  const h = harness();
  await h.client.start();
  await h.client.fromPage({ type: 'tools', tools: [] });
  h.streams[0].onmessage({ data: JSON.stringify({ id: 'k1', name: 'read_ledger', args: { limit: 1 } }) });
  assert.deepEqual(h.toPage.at(-1), { type: 'call', id: 'k1', name: 'read_ledger', args: { limit: 1 } });
  h.streams[0].onmessage({ data: 'not json' });
  assert.equal(h.toPage.length, 2, 'garbage on the stream is dropped');
  await h.client.fromPage({ type: 'result', id: 'k1', ok: true, text: 'rows', error: null });
  const result = h.fetches.at(-1);
  assert.equal(new URL(result.url).pathname, '/result');
  assert.deepEqual(result.body, { id: 'k1', ok: true, text: 'rows', error: null });
  h.client.close('detached by you');
  assert.equal(h.streams[0].closed, true);
  assert.deepEqual(h.toPage.at(-1), { type: 'detach' });
  assert.match(h.statuses.at(-1).text, /closed — detached by you/);
  await h.client.fromPage({ type: 'tools', tools: [] });
  assert.equal(h.fetches.filter((f) => new URL(f.url).pathname === '/tools').length, 1, 'a closed client pushes nothing');
});
