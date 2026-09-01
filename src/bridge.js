// Local agent bridge — the page's half of t-bc1b ("bring your own agent").
//
// Opt-in and additive. Nothing here runs unless the room is opened with
// `?bridge=http://127.0.0.1:<port>`; without that parameter this module is a
// no-op and the page is exactly what it was. With it, the page attaches to a
// local relay and lets an MCP client outside the browser call the tools the
// page ALREADY publishes through `document.modelContext` — through the same
// door: every call goes to `document.modelContext.executeTool(tool, json)`,
// which is the code path `partner.js` already uses and the one that landed the
// `inherited` row on Chrome 152. The tool's own `execute` runs, `announce`
// fires, `recordToolCall` records `tool:<name>` via the `webmcp` ingress — and
// the actor label "agent-initiated, riding the human session" is true, because
// an agent is.
//
// What the chain sees: one `bridge_opened` row when the door is opened (room
// bookkeeping, server-observed — the room witnessed itself open a door and
// records which origin it opened to), then one `tool:<name>` row per call,
// exactly as any riding agent's calls are recorded. A bridged call carries no
// `payload.confirmation.input` fingerprint — that exists only for UI-door acts —
// and that absence is correct: nothing was pressed.
//
// Trust boundary: only loopback relays are accepted. A bridge parameter naming
// anything else is refused and said so on the chip, never silently ignored.

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function chip(text, state) {
  let el = document.getElementById('bridge-status');
  if (!el) {
    el = document.createElement('span');
    el.id = 'bridge-status';
    el.className = 'chip';
    const anchor = document.getElementById('crossorg');
    (anchor?.parentNode ?? document.body).insertBefore(el, anchor?.nextSibling ?? null);
  }
  el.dataset.state = state;
  el.textContent = text;
}

async function currentTools() {
  const mc = document.modelContext;
  if (!mc || typeof mc.getTools !== 'function') return [];
  const list = await mc.getTools();
  return list.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object', properties: {} } }));
}

let TOKEN = '';
const authHeaders = () => ({ 'content-type': 'application/json', 'x-bridge-token': TOKEN });

async function pushTools(relay) {
  const tools = await currentTools();
  const r = await fetch(`${relay}/tools`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ tools }) });
  if (!r.ok) throw new Error(`relay refused the tool list (${r.status})`);
  return tools;
}

async function runCall(relay, { id, name, args }) {
  const mc = document.modelContext;
  let ok = false; let text = ''; let error = null;
  try {
    const tools = await mc.getTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool "${name}" in this phase`);
    if (typeof mc.executeTool !== 'function') throw new Error('this browser exposes no executeTool to the page');
    // Same call shape partner.js uses: the tool object and a JSON string; the
    // result comes back as a string (or null).
    const result = await mc.executeTool(tool, JSON.stringify(args ?? {}));
    text = result == null ? '' : String(result);
    ok = true;
  } catch (err) {
    error = err?.message ?? String(err);
  }
  await fetch(`${relay}/result`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ id, ok, text, error }) });
}

/** Attach the page to a local relay if `?bridge=` names one. Returns the relay
 *  origin when attached, null when not asked, and records the opening on the
 *  chain so the ledger says a door was opened and to what. */
export async function attachBridge(room) {
  const params = new URL(location.href).searchParams;
  const relay = params.get('bridge');
  if (!relay) return null;
  if (!LOOPBACK.test(relay)) {
    chip(`bridge: refused — only a loopback relay may be named, not ${relay}`, 'absent');
    return null;
  }
  // The token the relay minted. Without it the door stays shut: a relay that
  // accepted unauthenticated callers would be a door anyone on the laptop can
  // find, and the bridge_opened row would be naming nobody.
  TOKEN = params.get('token') ?? '';
  if (!TOKEN) {
    chip('bridge: refused — no token; paste the full ?bridge=…&token=… URL the relay printed', 'absent');
    return null;
  }
  const mc = document.modelContext;
  if (!mc || typeof mc.getTools !== 'function' || typeof mc.executeTool !== 'function') {
    chip('bridge: unavailable here — this browser exposes no executeTool to the page', 'absent');
    return null;
  }

  // Attach FIRST, record SECOND. The first spike run recorded `bridge_opened`
  // and then failed to reach the relay — a row claiming a door was opened to a
  // relay that was not there. The row must be true, so it lands only once the
  // relay has answered; and it lands BEFORE the event stream opens, so no call
  // can ever arrive ahead of the record of the door it came through.
  let tools = [];
  try { tools = await pushTools(relay); } catch (err) {
    chip(`bridge: relay at ${relay} not reachable — ${err?.message ?? err}`, 'absent');
    return null;
  }

  await room.record({
    kind: 'bridge_opened',
    // The fingerprint, never the token: enough for the chain to say WHICH door
    // the host opened, not enough to open it again.
    payload: { relay, token_fingerprint: TOKEN.slice(0, 8), tools: tools.map((t) => t.name), note: 'a local MCP relay may now call the tools this page publishes; each call is recorded as tool:<name> through the webmcp door' },
    seatId: 'room',
    ingress: 'room',
  });

  try { mc.addEventListener('toolchange', () => { pushTools(relay).catch(() => {}); }); } catch {}

  // EventSource cannot carry a header, so the token rides the query string
  // for this one request; the relay accepts either form. The second spike run
  // opened this bare, got a 401, and sat in a reconnect loop with the chip
  // reading "lost — reconnecting" while the relay showed no page attached.
  const es = new EventSource(`${relay}/events?token=${encodeURIComponent(TOKEN)}`);
  // Re-offer the tools every time the stream (re)opens: a relay that restarted
  // — GLM's runner spawns it, so a runner restart is a relay restart — comes
  // back with an empty list, and a page that only pushed once would leave the
  // agent seeing nothing until the next phase change.
  es.onopen = () => {
    chip(`bridge: open to ${relay} — ${tools.length} tools offered`, 'ready');
    pushTools(relay).catch(() => {});
  };
  es.onerror = () => chip(`bridge: lost ${relay} — reconnecting`, 'absent');
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && msg.id && msg.name) runCall(relay, msg).catch(() => {});
  };
  return relay;
}
