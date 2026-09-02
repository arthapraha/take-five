// Take Five Sidecar — the panel. It is a prompt surface and nothing else: it
// never reads the page (Hermes gate, take-five seq 1735). Its only view of the
// room is what the local sidecar returns: which agent answered, which tools
// were called, what came back.
const $ = (id) => document.getElementById(id);
const endpointEl = $('endpoint'); const tokenEl = $('token'); const who = $('who');
const transcript = $('transcript'); const promptEl = $('prompt'); const sendBtn = $('send');
let agent = null;
// The sidecar answers exactly one extension origin; show ours so the owner can
// pass it on the sidecar's command line. No pattern, no guessing.
$('origin').textContent = `chrome-extension://${chrome.runtime.id}`;

async function restore() {
  try {
    const { endpoint, token } = await chrome.storage.local.get(['endpoint', 'token']);
    if (endpoint) endpointEl.value = endpoint;
    if (token) tokenEl.value = token;
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
    if (t.status === 401) throw new Error('token refused by the sidecar');
    const { tools } = await t.json();
    agent = h.agent;
    who.dataset.state = 'on';
    who.textContent = `agent: ${agent.model} via ${agent.via} — outside the browser; page: ${h.relay?.pages ? 'attached' : 'NOT attached'}`;
    $('tools').textContent = tools.length ? `tools the page offers now: ${tools.join(', ')}` : 'the page offers no tools yet — open it with the ?bridge= URL the relay printed';
    await chrome.storage.local.set({ endpoint: base(), token: tokenEl.value.trim() });
    $('settings').open = false;
  } catch (err) {
    agent = null; who.dataset.state = 'off';
    who.textContent = `agent: not connected — ${err?.message ?? err}`;
    $('settings').open = true;
  }
}

$('connect').addEventListener('click', connect);
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
    if (r.status === 409) { row('error', 'sidecar', 'a prompt is already running — one at a time'); return; }
    if (!r.ok) { row('error', 'sidecar', res.error ?? `HTTP ${r.status}`); return; }
    // The "tools the page offers now" line follows the page, not the last Connect.
    fetch(`${base()}/tools`, { headers: headers() }).then((t) => t.json()).then(({ tools }) => { $('tools').textContent = `tools the page offers now: ${tools.join(', ')}`; }).catch(() => {});
    for (const e of res.transcript) {
      if (e.type === 'tool_call') row('tool_call', `${res.agent.model} → ${e.name}`, JSON.stringify(e.args));
      else if (e.type === 'tool_result') row(`tool_result${e.isError ? ' err' : ''}`, `page → ${e.name}${e.isError ? ' (error)' : ''}`, e.text);
      else if (e.type === 'final') row('final', `${res.agent.model} via ${res.agent.via}`, e.text);
      else if (e.type === 'stopped') row('error', 'sidecar', e.note);
    }
  } catch (err) {
    row('error', 'sidecar', err?.message ?? String(err));
  } finally {
    sendBtn.disabled = false;
  }
});

restore();
