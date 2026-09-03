// Take Five Agent — the page side of the bridge, carried by the extension (t-4202).
//
// Injected into the MAIN world of the one tab the owner clicked "Attach this
// tab" on, and nowhere else. It does what src/bridge.js does against
// `document.modelContext` — list the tools (schemas normalised), execute calls
// through the same `executeTool` door partner.js uses — but it never fetches
// anything: the relay connection lives in the panel, so the page's URL carries
// no token and the public page never names a loopback address.
//
// It talks to the panel over window.postMessage, through the isolated-world
// script (page-relay.js) that holds the extension port. Two sources:
//   'take-five-bridge/ext'  — from the panel: hello, call, detach
//   'take-five-bridge/page' — to the panel: attached, refused, tools, result
//
// The page's privilege scoping survives the move (counsel, take-five seq
// 2118). On a Take Five page the hello becomes a cancelable
// `take-five:bridge-attached` event; the page claims it (preventDefault),
// records `bridge_opened` on its chain, and answers `take-five:bridge-recorded`
// carrying its `offered` predicate — read surface ∪ current phase, the same
// predicate src/bridge.js takes. Until that ack no tool is listed and every
// call is refused; after it, a tool the page did not offer is refused BEFORE
// the registry is consulted, exactly as the shim refuses it (test #10 there,
// test #3 here). A page that is not Take Five claims nothing: it has no chain,
// the panel says so, and its tools are listed as registered.
//
// Whether a page IS Take Five is read off the document synchronously
// (`<html data-take-five>`), not inferred from silence: an injection that lands
// before the page's listener is installed waits and asks again, rather than
// serving a Take Five page unscoped for want of a listener.
//
// This script runs as the page's own origin, so it does exactly three things —
// list (normalised), execute (offered only), ack — and nothing else (Hermes,
// seq 2119): no storage, no DOM writes, and the one DOM read is that marker
// attribute. It never names the page; the panel names the tab it was granted.
// The token never reaches it: the hello carries an eight-character fingerprint.
(function (global) {
  'use strict';
  const PAGE_SOURCE = 'take-five-bridge/page';
  const EXT_SOURCE = 'take-five-bridge/ext';
  const CLAIM_RETRY_MS = 250;
  const CLAIM_WAIT_MS = 5000;

  // Native Chrome 152 hands `inputSchema` back as a JSON STRING; the polyfill
  // as an object. Same normalisation as src/bridge.js, same loud fallback.
  function schemaObject(s, warn) {
    const raw = s;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    if (raw !== undefined && raw !== null) warn(`inputSchema unusable (${typeof raw === 'string' ? 'unparseable string' : typeof raw}); sending the empty object schema — the model will see NO parameters`);
    return { type: 'object', properties: {} };
  }

  function createPageEndpoint({ document, window, CustomEvent, log = () => {}, schedule = (fn, ms) => setTimeout(fn, ms), now = () => Date.now() }) {
    const mc = document.modelContext;
    const post = (msg) => window.postMessage(Object.assign({ source: PAGE_SOURCE }, msg), '*');
    const marker = Boolean(document.documentElement && document.documentElement.dataset && document.documentElement.dataset.takeFive);
    // idle → claimed → recorded (Take Five) | plain (any other page) | refused | closed
    let state = 'idle';
    let offered = null;
    const isOffered = (name) => !offered || offered(name);

    async function currentTools() {
      if (!mc || typeof mc.getTools !== 'function') return [];
      const list = await mc.getTools();
      return list
        .filter((t) => isOffered(t.name))
        .map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: schemaObject(t.inputSchema, (m) => log(`tool "${t.name}": ${m}`)) }));
    }
    async function announce() {
      const tools = await currentTools();
      post({ type: 'tools', tools });
      try { document.dispatchEvent(new CustomEvent('take-five:bridge-tools', { detail: { tools: tools.map((t) => t.name) } })); } catch {}
    }
    const serving = () => state === 'recorded' || state === 'plain';
    function onToolChange() { if (serving()) announce().catch(() => {}); }

    function refuse(reason) {
      if (state === 'closed') return;
      state = 'refused';
      post({ type: 'refused', reason });
    }
    function onRecorded(ev) {
      if (state !== 'claimed') return;
      const d = (ev && ev.detail) || {};
      offered = typeof d.offered === 'function' ? d.offered : Array.isArray(d.offered) ? (n) => d.offered.includes(n) : null;
      // A Take Five page always scopes. An ack with no offered set is a page
      // this script does not understand; fail closed, never open.
      if (!offered) { refuse('the page recorded the door but named no offered set; nothing is served'); return; }
      state = 'recorded';
      announce().catch(() => {});
    }
    function onRefused(ev) {
      if (state === 'idle' || state === 'claimed') refuse((ev && ev.detail && ev.detail.reason) || 'the page refused the door');
    }

    function hello({ relay, token_fingerprint }) {
      if (state !== 'idle') { post({ type: 'refused', reason: `this tab is already ${state}` }); return; }
      post({ type: 'attached', takeFive: marker });
      if (!mc || typeof mc.getTools !== 'function' || typeof mc.executeTool !== 'function') {
        refuse('this browser exposes no executeTool to the page — no WebMCP surface here');
        return;
      }
      const detail = { relay, token_fingerprint, transport: 'extension' };
      const started = now();
      const tryClaim = () => {
        if (state !== 'idle') return;
        // `claimed` is set BEFORE the dispatch: a page that records and acks
        // synchronously inside its listener must find the ack accepted.
        state = 'claimed';
        const ev = new CustomEvent('take-five:bridge-attached', { detail, cancelable: true });
        document.dispatchEvent(ev);
        if (ev.defaultPrevented) return; // the page has the door; wait for -recorded
        if (state !== 'claimed') return; // refused during the dispatch
        state = 'idle';
        if (!marker) { state = 'plain'; announce().catch(() => {}); return; }
        if (now() - started >= CLAIM_WAIT_MS) { refuse('a Take Five page that did not claim the door — reload it and attach again'); return; }
        schedule(tryClaim, CLAIM_RETRY_MS);
      };
      tryClaim();
    }

    async function call({ id, name, args }) {
      let ok = false; let text = ''; let error = null;
      try {
        if (state === 'claimed') throw new Error("the door is not yet recorded on the page's chain — no call is served before the bridge_opened row");
        if (!serving()) throw new Error(`bridge ${state}; nothing is served`);
        // Refused BEFORE the page's registry is consulted, as the shim does.
        if (!isOffered(name)) throw new Error(`"${name}" is not offered through the bridge`);
        const tools = await mc.getTools();
        const tool = tools.find((t) => t.name === name);
        if (!tool) throw new Error(`no tool "${name}" in this phase`);
        const result = await mc.executeTool(tool, JSON.stringify(args || {}));
        text = result == null ? '' : String(result);
        ok = true;
      } catch (err) {
        error = (err && err.message) || String(err);
      }
      post({ type: 'result', id, ok, text, error });
    }

    function onMessage(ev) {
      if (ev.source !== window || !ev.data || ev.data.source !== EXT_SOURCE) return;
      const msg = ev.data;
      if (msg.type === 'hello') hello(msg);
      else if (msg.type === 'call') call(msg).catch(() => {});
      else if (msg.type === 'detach') close('the panel detached');
    }
    function close(reason) {
      if (state === 'closed') return;
      state = 'closed';
      window.removeEventListener('message', onMessage);
      document.removeEventListener('take-five:bridge-recorded', onRecorded);
      document.removeEventListener('take-five:bridge-refused', onRefused);
      try { mc && mc.removeEventListener && mc.removeEventListener('toolchange', onToolChange); } catch {}
      try { document.dispatchEvent(new CustomEvent('take-five:bridge-detached', { detail: { reason } })); } catch {}
    }

    window.addEventListener('message', onMessage);
    document.addEventListener('take-five:bridge-recorded', onRecorded);
    document.addEventListener('take-five:bridge-refused', onRefused);
    try { mc && mc.addEventListener && mc.addEventListener('toolchange', onToolChange); } catch {}

    return { close, get state() { return state; } };
  }

  global.__takeFiveCreatePageEndpoint = createPageEndpoint;

  // In a real tab: start, once. A second injection into a tab whose endpoint is
  // still open is told no; a closed one may be replaced (detach, then attach).
  if (!global.__takeFiveNoAutostart && typeof window !== 'undefined' && window.document) {
    const prev = window.__takeFiveBridgeEndpoint;
    if (prev && prev.state !== 'closed') {
      window.postMessage({ source: PAGE_SOURCE, type: 'refused', reason: 'this tab is already attached — detach first' }, '*');
    } else {
      window.__takeFiveBridgeEndpoint = createPageEndpoint({ document: window.document, window, CustomEvent: window.CustomEvent, log: (m) => console.warn('[take-five-agent]', m) });
    }
  }
})(globalThis);
