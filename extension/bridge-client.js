// Take Five Agent — the panel's half of the bridge (t-4202).
//
// The relay connection lives HERE, in the panel page, not in the page being
// attached and not in the background worker: an extension page has EventSource
// and lives while the panel is open (a Manifest V3 service worker has neither
// — no EventSource, and Chrome ends it after thirty idle seconds). The page's
// URL therefore carries no token; the panel presents it. What the relay sees
// is exactly what it saw from src/bridge.js — the same headers, the same page
// nonce on every route, the same order: the relay must answer BEFORE the page
// is told hello, so the page never records a door that will not open.
//
// Pure: `fetch`, `EventSource`, `toPage` and `mintPageId` are injected, so a
// node test can drive the whole conversation without a browser.
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function defaultMint() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function createBridgeClient({ relay, token, toPage, label = 'this tab', onStatus = () => {}, fetch = globalThis.fetch, EventSource = globalThis.EventSource, mintPageId = defaultMint }) {
  relay = String(relay || '').trim().replace(/\/$/, '');
  if (!LOOPBACK.test(relay)) throw new Error(`only a loopback relay may be named, not ${relay || '(nothing)'}`);
  token = String(token || '').trim();
  if (!token) throw new Error('the relay token is required — paste the token from the ?bridge=…&token= line the relay printed');
  // This attach's nonce (t-089f): the relay serves one page at a time and
  // refuses another nonce on every route.
  const page = mintPageId();
  const headers = () => ({ 'content-type': 'application/json', 'x-bridge-token': token, 'x-bridge-page': page });
  const status = (state, text) => { try { onStatus({ state, text }); } catch {} };
  // The tab is named by the panel from its activeTab grant, never by the page
  // side: the injected script reads nothing from the page it runs in.
  const where = String(label || 'this tab');
  let es = null; let closed = false; let tools = [];

  // Proves the relay is there, the token is right and no other page holds it,
  // WITHOUT changing relay state: a /result for an id the relay never issued
  // passes the token check, then the one-page check, and only then answers
  // 404 "no such pending call". Anything else is a refusal — and the page is
  // not told hello, so there is no bridge_opened row for a door that will not
  // open (the shim's "attach FIRST, record SECOND", kept across transports).
  async function probe() {
    let r;
    try {
      r = await fetch(`${relay}/result`, { method: 'POST', headers: headers(), body: JSON.stringify({ id: `probe-${page}` }) });
    } catch (err) {
      throw new Error(`relay at ${relay} not reachable — ${(err && err.message) || err}. Check it is running and that its --origin is this panel's origin`);
    }
    if (r.status === 401) throw new Error('relay token refused');
    if (r.status === 409) throw new Error('another page holds this bridge — close it, or open a fresh relay');
    if (r.status !== 404) throw new Error(`relay answered ${r.status} to the probe; expected 404`);
  }

  async function push(list) {
    const r = await fetch(`${relay}/tools`, { method: 'POST', headers: headers(), body: JSON.stringify({ tools: list }) });
    if (r.status === 409) throw new Error('another page holds this bridge — close it, or open a fresh relay');
    if (!r.ok) throw new Error(`relay refused the tool list (${r.status})`);
  }

  function openStream() {
    if (es || closed) return;
    // EventSource cannot carry a header: token and nonce ride the query, as the shim's do.
    es = new EventSource(`${relay}/events?token=${encodeURIComponent(token)}&page=${page}`);
    es.onopen = () => {
      status('ready', `bridge: open to ${relay} from ${where} — ${tools.length} tools offered`);
      // Re-offer on every (re)open: a restarted relay comes back empty.
      push(tools).catch(() => {});
    };
    es.onerror = () => {
      const closedForGood = es.readyState === (EventSource.CLOSED === undefined ? 2 : EventSource.CLOSED);
      status('absent', closedForGood ? `bridge: refused by ${relay} — the relay closed the stream; detach and attach again` : `bridge: lost ${relay} — reconnecting`);
    };
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.id && m.name) toPage({ type: 'call', id: m.id, name: m.name, args: m.args || {} });
    };
  }

  /** Probe the relay, then say hello to the page. Rejects — with no hello sent —
   *  when the relay refuses. */
  async function start() {
    status('checking', `bridge: probing ${relay}…`);
    await probe();
    toPage({ type: 'hello', relay, token_fingerprint: token.slice(0, 8) });
  }

  async function fromPage(msg) {
    if (closed || !msg || typeof msg !== 'object') return;
    if (msg.type === 'attached') {
      status('checking', msg.takeFive
        ? `attached to "${where}" — waiting for the page to record the door`
        : `attached to "${where}" — not a Take Five page: it has no chain, so calls here are recorded nowhere`);
    } else if (msg.type === 'refused') {
      status('absent', `bridge: refused by the page — ${msg.reason}`);
    } else if (msg.type === 'tools') {
      tools = Array.isArray(msg.tools) ? msg.tools : [];
      try { await push(tools); } catch (err) { status('absent', `bridge: ${err.message}`); return; }
      if (!es) openStream();
      else status('ready', `bridge: open to ${relay} from ${where} — ${tools.length} tools offered`);
    } else if (msg.type === 'result') {
      await fetch(`${relay}/result`, { method: 'POST', headers: headers(), body: JSON.stringify({ id: msg.id, ok: Boolean(msg.ok), text: msg.text || '', error: msg.error || null }) }).catch(() => {});
    }
  }

  function close(reason) {
    if (closed) return;
    closed = true;
    try { if (es) es.close(); } catch {}
    try { toPage({ type: 'detach' }); } catch {}
    status('absent', `bridge: closed — ${reason}`);
  }

  return { start, fromPage, close, get page() { return page; }, get tools() { return tools; } };
}
