// Wiring: seed the room, register the read surface, render both views, and
// re-render whenever a tool call lands so a watcher can see the agent working.

// The polyfill does NOT install itself on import — only its IIFE build has side
// effects, and the ESM entry exports an explicit initializer. Importing it bare
// leaves `document.modelContext` undefined and the read surface silently
// unregistered, which looks exactly like a browser without WebMCP.
//
// It never replaces a real implementation: in a browser that ships WebMCP, the
// native `document.modelContext` wins and this is a no-op.
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { seedRoom, PHASES, INGRESS, GRADE_NOTE } from './room.js';
import { registerReadSurface } from './tools.js';

initializeWebMCPPolyfill();

const $ = (id) => document.getElementById(id);
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;

// The host seat's name is a placeholder filled at load. A visiting judge is the
// host of their own session, so nobody's name is baked into the demo.
const room = await seedRoom('Room host');

let freshHash = null;

function renderPhases() {
  const i = PHASES.indexOf(room.phase);
  $('phases').innerHTML = PHASES.map((p, n) => {
    const cls = n < i ? ' class="done"' : '';
    const cur = p === room.phase ? ' aria-current="true"' : '';
    return `<li${cls}${cur}>${p}</li>`;
  }).join('');
}

function renderSeats() {
  $('seats').innerHTML = room.seats.map((s) => {
    const grade = INGRESS[s.door].grade;
    return `<li><span>${s.name}</span><span class="door">${s.door} · <span class="grade grade-${grade}">${grade}</span></span></li>`;
  }).join('');
}

function renderGrades() {
  $('grades').innerHTML = Object.entries(GRADE_NOTE).map(
    ([g, note]) => `<dt class="grade grade-${g}">${g}</dt><dd>${note}</dd>`,
  ).join('');
}

function renderLedger() {
  $('ledger').innerHTML = room.ledger.entries.slice().reverse().map((e) => {
    const fresh = e.hash === freshHash ? ' fresh' : '';
    return `<li class="entry${fresh}">
      <div class="entry-top">
        <span class="seq">#${e.seq}</span>
        <span class="kind">${e.kind}</span>
        <span class="who">${e.actor.seat} via ${e.actor.ingress} — <span class="grade grade-${e.actor.grade}">${e.actor.grade}</span></span>
      </div>
      <div class="hashes">${short(e.hash)} &nbsp;prev ${short(e.prev)}</div>
    </li>`;
  }).join('');
}

function renderAll() {
  renderPhases();
  renderSeats();
  renderGrades();
  renderLedger();
}

$('verify').addEventListener('click', async () => {
  const r = await room.ledger.verify();
  const el = $('verdict');
  el.hidden = false;
  el.className = `verdict ${r.ok ? 'ok' : 'bad'}`;
  el.textContent = r.ok
    ? `VERIFIED — ${r.entries} entries, every hash recomputed and every link checked. Tip ${short(r.tip)}`
    : `FAILED at entry #${r.seq}: ${r.reason}. expected ${short(r.expected)}, found ${short(r.found)}`;
});

renderAll();

// Register the read surface and report honestly whether an agent surface exists.
const status = $('agent-status');
const reg = await registerReadSurface(room, {
  onCall: async (name) => {
    // A tool call is itself an act, and it is recorded like any other — through
    // the WebMCP door, so the grade is client-asserted and says so.
    const entry = await room.record({
      kind: `tool:${name}`,
      payload: { tool: name },
      seatId: 'rider',
      ingress: 'webmcp',
    });
    freshHash = entry.hash;
    renderAll();
  },
});

if (reg.ok) {
  status.dataset.state = 'ready';
  status.textContent = `agent surface ready — ${reg.names.length} read-only tools registered`;
  document.modelContext.addEventListener('toolchange', () => {
    status.textContent = `agent surface ready — tools changed at ${new Date().toLocaleTimeString()}`;
  });
} else {
  status.dataset.state = 'absent';
  status.textContent = `no agent surface — ${reg.reason}. The room is still fully readable here.`;
}
