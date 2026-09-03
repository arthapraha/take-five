// Take Five Agent (codename Sidecar) — the panel. It is a prompt surface and nothing else: it
// never reads the page (Hermes gate, take-five seq 1735). Its only view of the
// room is what the local sidecar returns: which agent answered, which tools
// were called, what came back.
import { createBridgeClient } from './bridge-client.js';

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
    const { endpoint, token, relay, relayToken } = await chrome.storage.local.get(['endpoint', 'token', 'relay', 'relayToken']);
    if (endpoint) endpointEl.value = endpoint;
    if (token) tokenEl.value = token;
    if (relay) relayEl.value = relay;
    if (relayToken) relayTokenEl.value = relayToken;
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

async function connect() {
  who.dataset.state = 'off'; who.textContent = 'agent: connecting…';
  try {
    const h = await fetch(`${base()}/health`).then((r) => r.json());
    const t = await fetch(`${base()}/tools`, { headers: headers() });
    if (t.status === 401) throw new Error('token refused by the local agent');
    const { tools } = await t.json();
    agent = h.agent;
    who.dataset.state = 'on';
    who.textContent = `agent: ${agent.model} via ${agent.via} — outside the browser; page: ${h.relay?.pages ? 'attached' : 'NOT attached'}`;
    $('tools').textContent = tools.length ? `tools the page offers now: ${tools.join(', ')}` : 'the page offers no tools yet — open it with the ?bridge= URL the relay printed';
    await chrome.storage.local.set({ endpoint: base(), token: tokenEl.value.trim() });
    $('settings').open = false;
  } catch (err) {
    agent = null; who.dataset.state = 'off';
    const m = err?.message ?? String(err);
    // "Failed to fetch" is what a stopped agent, a wrong endpoint and a
    // refused origin all look like from here; say what to check.
    who.textContent = `agent: not connected — ${m}${/Failed to fetch/.test(m) ? ' (is the local agent running, and does the Endpoint match what it printed?)' : ''}`;
    $('settings').open = true;
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
function bridgeStatus({ state, text }) { bridgeEl.dataset.state = state; bridgeEl.textContent = text; }
function dropBridge(reason) {
  if (bridge) bridge.close(reason);
  try { bridgePort?.disconnect(); } catch {}
  bridge = null; bridgePort = null;
}
async function attachTab() {
  dropBridge('re-attaching');
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no active tab');
    // The isolated pipe first, then the MAIN-world endpoint; the port is opened
    // only once both are in place, so the first hello finds a listener.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-relay.js'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['page-endpoint.js'] });
  } catch (err) {
    bridgeStatus({ state: 'absent', text: `bridge: cannot attach — ${err?.message ?? err}. Click the Take Five Agent icon on that tab first (that grants this one tab), then Attach` });
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
  await chrome.storage.local.set({ relay: relayEl.value.trim(), relayToken: relayTokenEl.value.trim() });
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
    // The "tools the page offers now" line follows the page, not the last Connect.
    fetch(`${base()}/tools`, { headers: headers() }).then((t) => t.json()).then(({ tools }) => { $('tools').textContent = `tools the page offers now: ${tools.join(', ')}`; }).catch(() => {});
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
