// Take Five Agent (codename Sidecar) — the panel. It is a prompt surface and nothing else: it
// never reads the page (Hermes gate, take-five seq 1735). Its only view of the
// room is what the local sidecar returns: which agent answered, which tools
// were called, what came back.
import { createBridgeClient } from './bridge-client.js';
import { agentLine, toolsLine, checkAgentReply } from './panel-lines.js';

const $ = (id) => document.getElementById(id);
const endpointEl = $('endpoint'); const tokenEl = $('token'); const who = $('who');
const relayEl = $('relay'); const relayTokenEl = $('relay-token'); const bridgeEl = $('bridge');
const transcript = $('transcript'); const promptEl = $('prompt'); const sendBtn = $('send');
let agent = null;
// The sidecar answers exactly one extension origin; show ours so the owner can
// pass it on the sidecar's command line. No pattern, no guessing.
$('origin').textContent = `chrome-extension://${chrome.runtime.id}`;

async function restore() {
  try {
    const { endpoint, token, relay, relayToken, pageOrigin } = await chrome.storage.local.get(['endpoint', 'token', 'relay', 'relayToken', 'pageOrigin']);
    if (endpoint) endpointEl.value = endpoint;
    if (token) tokenEl.value = token;
    if (relay) relayEl.value = relay;
    if (relayToken) relayTokenEl.value = relayToken;
    if (pageOrigin) $('page-origin').value = pageOrigin;
    if (endpoint && token) await connect();
  } catch {}
}
function headers() { return { 'content-type': 'application/json', 'x-sidecar-token': tokenEl.value.trim() }; }
function base() { return endpointEl.value.trim().replace(/\/$/, ''); }

function row(kind, label, text) {
  const el = document.createElement('div');
  el.className = `row ${kind}`;
  const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
  const pre = document.createElement('pre'); pre.textContent = text ?? '';
  el.append(k, pre); transcript.append(el); el.scrollIntoView({ block: 'end' });
}

// Every answer goes through checkAgentReply, which throws unless BOTH replies
// are the shape the panel is about to describe. An error body must not become
// a description (counsel, seq 3579). The .catch(() => null) turns a non-JSON
// body into a missing one, which the check then refuses.
async function readAgent() {
  const hr = await fetch(`${base()}/health`);
  const health = await hr.json().catch(() => null);
  const t = await fetch(`${base()}/tools`, { headers: headers() });
  const toolsBody = await t.json().catch(() => null);
  return checkAgentReply({ healthOk: hr.ok, health, toolsStatus: t.status, toolsOk: t.ok, toolsBody });
}

// Reads can overlap: a bridge 'absent', its 1.5s re-read, and a prompt's
// refresh. A slow earlier read that landed after a newer one would put the
// OLDER state back on screen as current. Each read takes a ticket, and only
// the latest one may write (counsel's optional item, seq 3579).
let readTicket = 0;
function showAgent({ h, tools }) {
  agent = h.agent;
  who.dataset.state = 'on';
  who.textContent = agentLine(h);
  $('tools').textContent = toolsLine(tools);
}
function showUnreachable(err) {
  agent = null; who.dataset.state = 'off';
  const m = err?.message ?? String(err);
  // "Failed to fetch" is what a stopped agent, a wrong endpoint and a
  // refused origin all look like from here; say what to check.
  who.textContent = `agent: not connected — ${m}${/Failed to fetch/.test(m) ? ' (is the local agent running, and does the Endpoint match what it printed?)' : ''}`;
  // Cleared rather than kept: a tool list from before the agent stopped
  // answering would be reported as what the page offers NOW.
  $('tools').textContent = '';
}

async function connect() {
  const mine = ++readTicket;
  who.dataset.state = 'off'; who.textContent = 'agent: connecting…';
  try {
    const reply = await readAgent();
    if (mine === readTicket) showAgent(reply);
    await chrome.storage.local.set({ endpoint: base(), token: tokenEl.value.trim() });
    $('settings').open = false;
  } catch (err) {
    if (mine === readTicket) showUnreachable(err);
    $('settings').open = true;
  }
}

// Both lines FOLLOW THE AGENT'S CURRENT VIEW (t-96c4). They used to be built
// once at Connect, so "page: NOT attached" survived an Attach, and "attached"
// survived the page closing, each reported as current. This re-reads on every
// event that can change either line. It does not open or close the settings,
// and does nothing before a first successful Connect. A failed re-read is shown
// as a failure: a line that kept its last value when the agent stopped
// answering would be the same stale claim this card exists to remove.
async function refreshLines() {
  if (!agent) return;
  const mine = ++readTicket;
  try {
    const reply = await readAgent();
    if (mine === readTicket) showAgent(reply);
  } catch (err) {
    if (mine === readTicket) showUnreachable(err);
  }
}

$('connect').addEventListener('click', connect);

// ── The bridge into the page (t-4202) ────────────────────────────────────
// Two permissions, each with its reason: `activeTab` — the tab the owner
// clicked the extension icon on, and no other, for as long as it stays on that
// page; `scripting` — to inject the page side into exactly that tab, exactly
// when Attach is clicked. No `tabs`, no `<all_urls>`, no host_permissions: the
// relay is reached from this panel page over ordinary CORS, as t-70a1 measured
// for the local agent (counsel, seq 2118: measure before widening).
let bridge = null; let bridgePort = null;
function bridgeStatus({ state, text }) {
  bridgeEl.dataset.state = state; bridgeEl.textContent = text;
  // The agent line's "page:" clause follows the RELAY, so re-read it whenever
  // this panel's own attachment settles either way (t-96c4). 'ready' is sent
  // when the stream to the relay opens, which is when the relay registers the
  // page, so one read is enough. 'absent' is sent as the stream closes, and the
  // relay may not have seen that yet. The first read then reports what the
  // agent genuinely believes at that instant, which is what the line claims to
  // show. A second read, once it has settled, catches the relay catching up.
  if (state === 'ready' || state === 'absent') {
    refreshLines();
    if (state === 'absent') setTimeout(refreshLines, 1500);
  }
}
function dropBridge(reason) {
  if (bridge) bridge.close(reason);
  try { bridgePort?.disconnect(); } catch {}
  bridge = null; bridgePort = null;
}
// The isolated pipe first, then the MAIN-world endpoint; the port is opened
// only once both are in place, so the first hello finds a listener.
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page-relay.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['page-endpoint.js'] });
}
// Which site the panel may touch, named by the owner. Without a grant Chrome
// hides the tab's URL from us, so the panel cannot read it off the tab.
function pageOrigin() {
  const raw = $('page-origin').value.trim();
  let u; try { u = new URL(raw); } catch { throw new Error(`Page origin is not a URL: ${raw || '(empty)'}`); }
  if (u.origin === 'null' || u.origin !== raw.replace(/\/$/, '')) throw new Error(`Page origin must be a bare origin, like ${u.origin}`);
  return u.origin;
}
async function attachTab() {
  dropBridge('re-attaching');
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no active tab');
    try {
      // First the grant Chrome gives for free: activeTab, from the icon click.
      await inject(tab.id);
    } catch (first) {
      // MEASURED 3 Sept 2026 on Chrome 152 (Attila's machine): the icon click
      // that opens this panel does NOT grant activeTab — executeScript answers
      // "Cannot access contents of the page. Extension manifest must request
      // permission to access the respective host." So ask for exactly one
      // site, the one the owner named, through Chrome's own dialog; the
      // manifest itself still carries no host access (optional only).
      const origin = pageOrigin();
      bridgeStatus({ state: 'checking', text: `bridge: Chrome did not grant this tab on the icon click — asking you for ${origin} …` });
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) throw new Error(`no grant for ${origin} — you declined Chrome's dialog, so nothing was injected`);
      try { await inject(tab.id); } catch (second) {
        throw new Error(`${second?.message ?? second} — is the active tab on ${origin}?`);
      }
    }
  } catch (err) {
    bridgeStatus({ state: 'absent', text: `bridge: cannot attach — ${err?.message ?? err}` });
    return;
  }
  bridgePort = chrome.tabs.connect(tab.id, { name: 'take-five-bridge' });
  try {
    bridge = createBridgeClient({ relay: relayEl.value, token: relayTokenEl.value, label: tab.title || tab.url || 'this tab', toPage: (m) => bridgePort?.postMessage(m), onStatus: bridgeStatus });
  } catch (err) {
    bridgeStatus({ state: 'absent', text: `bridge: ${err.message}` });
    dropBridge('not started');
    return;
  }
  const mine = bridge;
  bridgePort.onMessage.addListener((m) => { if (bridge === mine) mine.fromPage(m); });
  bridgePort.onDisconnect.addListener(() => { if (bridge === mine) dropBridge('the page navigated or closed'); });
  await chrome.storage.local.set({ relay: relayEl.value.trim(), relayToken: relayTokenEl.value.trim(), pageOrigin: $('page-origin').value.trim() });
  try { await mine.start(); } catch (err) {
    bridgeStatus({ state: 'absent', text: `bridge: ${err.message}` });
    if (bridge === mine) dropBridge('not started');
  }
}
$('attach').addEventListener('click', attachTab);
$('detach').addEventListener('click', () => dropBridge('detached by you'));
$('ask').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  if (!agent) { await connect(); if (!agent) return; }
  row('user', 'you', prompt);
  promptEl.value = ''; sendBtn.disabled = true;
  try {
    const r = await fetch(`${base()}/prompt`, { method: 'POST', headers: headers(), body: JSON.stringify({ prompt }) });
    const res = await r.json();
    if (r.status === 409) { row('error', 'local agent', 'a prompt is already running — one at a time'); return; }
    if (!r.ok) { row('error', 'local agent', res.error ?? `HTTP ${r.status}`); return; }
    // Both lines follow the page, not the last Connect (t-96c4). This used to
    // refresh only the tools line, and wrote "tools the page offers now: "
    // with nothing after it when the list came back empty.
    refreshLines();
    for (const e of res.transcript) {
      if (e.type === 'tool_call') row('tool_call', `${res.agent.model} → ${e.name}`, JSON.stringify(e.args));
      else if (e.type === 'tool_result') row(`tool_result${e.isError ? ' err' : ''}`, `page → ${e.name}${e.isError ? ' (error)' : ''}`, e.text);
      else if (e.type === 'final') row('final', `${res.agent.model} via ${res.agent.via}`, e.text);
      else if (e.type === 'stopped') row('error', 'local agent', e.note);
    }
  } catch (err) {
    row('error', 'local agent', err?.message ?? String(err));
  } finally {
    sendBtn.disabled = false;
  }
});

restore();
