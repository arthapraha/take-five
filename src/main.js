// Wiring: seed the room, register the read surface, register the tools that
// belong to the current phase, and re-render both views whenever anything
// lands. The phase machine is driven by the host seat — which, in a per-visitor
// sandbox, is whoever opened the page.

// The polyfill does NOT install itself on import — only its IIFE build has side
// effects, and the ESM entry exports an explicit initializer. Importing it bare
// leaves `document.modelContext` undefined and the read surface silently
// unregistered, which looks exactly like a browser without WebMCP.
//
// It never replaces a real implementation: in a browser that ships WebMCP, the
// native `document.modelContext` wins and this is a no-op.
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { seedRoom, PHASES, INGRESS, GRADE_NOTE, QUESTION } from './room.js';
import { registerReadSurface, registerPhaseTools, registerPartnerSurface, PARTNER_ORIGIN } from './tools.js';
import { Round } from './round.js';

initializeWebMCPPolyfill();

const $ = (id) => document.getElementById(id);
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;

// "Room host" is a placeholder filled at load, never a hardcoded person.
const room = await seedRoom('Room host');
const round = new Round(QUESTION.trim());

let freshHash = null;
let phaseTools = { controller: null, names: [] };

function renderPhases() {
  const i = PHASES.indexOf(room.phase);
  $('phases').innerHTML = PHASES.map((p, n) => {
    const cls = n < i ? ' class="done"' : '';
    const cur = p === room.phase ? ' aria-current="true"' : '';
    return `<li${cls}${cur}>${p}</li>`;
  }).join('');

  const next = PHASES[i + 1];
  const btn = $('advance');
  if (next) {
    btn.hidden = false;
    btn.textContent = `Advance to ${next}`;
  } else {
    btn.hidden = true;
  }
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

function renderTools() {
  const read = ['list_seats', 'current_phase', 'read_ledger', 'get_artefact', 'verify_receipt'];
  const scoped = phaseTools.names;
  $('tools').innerHTML =
    read.map((n) => `<li class="tool read">${n}</li>`).join('') +
    scoped.map((n) => `<li class="tool scoped">${n}</li>`).join('') +
    (scoped.length ? '' : '<li class="tool none">no write tools in this phase</li>');
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
  renderTools();
  renderLedger();
}

/** Swap the phase-scoped surface. Aborting the previous controller is what
 *  unregisters the old tools — there is no unregisterTool in the spec. */
async function syncPhaseTools() {
  if (phaseTools.controller) phaseTools.controller.abort();
  phaseTools = await registerPhaseTools(room, round, room.phase, {
    onCall: recordToolCall,
    // A tool that moves the room itself (ratify closes the round) needs the
    // surface re-synced and the views redrawn WITHOUT recording another act.
    onChange: async () => { await syncPhaseTools(); renderAll(); },
  });
  renderTools();
}

async function recordToolCall(name) {
  // A tool call is itself an act, recorded like any other — through the WebMCP
  // door, so the grade is client-asserted and the record says so.
  const entry = await room.record({
    kind: `tool:${name}`,
    payload: { tool: name },
    seatId: 'rider',
    ingress: 'webmcp',
  });
  freshHash = entry.hash;
  renderAll();
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

$('advance').addEventListener('click', async () => {
  const next = PHASES[PHASES.indexOf(room.phase) + 1];
  if (!next) return;
  const entry = await room.advance(next);
  freshHash = entry.hash;
  await syncPhaseTools();
  renderAll();
});

// The partner attestation, on demand rather than at load. A judge should be
// able to WATCH the `inherited` row arrive — it is the only grade in the table
// that says "we did not see this happen", and the point lands when you see the
// room record something it did not witness.
//
// The frame is hidden: the partner page's own UI is not the demo. What the
// room shows is the outcome it reports and the ledger entry it produced.
$('invite-partner').addEventListener('click', async () => {
  const out = $('partner-result');
  out.hidden = false;
  out.textContent = `inviting ${PARTNER_ORIGIN}…`;

  if (PARTNER_ORIGIN.startsWith(location.origin)) {
    out.textContent = 'the partner origin is this origin — nothing cross-origin can be shown from here.';
    return;
  }

  const settle = (text) => { out.textContent = text; renderAll(); };
  const onMessage = (ev) => {
    if (ev.origin !== PARTNER_ORIGIN) return;
    if (ev.data?.source !== 'take-five-partner') return;
    window.removeEventListener('message', onMessage);
    settle(ev.data.text);
  };
  window.addEventListener('message', onMessage);

  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `${PARTNER_ORIGIN}/partner.html?room=${encodeURIComponent(location.origin)}`;
  frame.addEventListener('error', () => settle(`could not load ${PARTNER_ORIGIN} — the partner origin is not reachable.`));
  document.body.appendChild(frame);

  // Bounded, for the same reason the cross-origin chip is bounded: a partner
  // that never answers must not leave the room saying "inviting…" forever.
  setTimeout(() => {
    window.removeEventListener('message', onMessage);
    if (out.textContent.startsWith('inviting')) {
      settle(`no answer from ${PARTNER_ORIGIN} within 8s. Either it is not deployed, or cross-origin invocation is unavailable in this browser. No cross-org claim is being made.`);
    }
  }, 8000);
});

$('question').textContent = QUESTION.trim();

renderAll();

const status = $('agent-status');
const reg = await registerReadSurface(room, { onCall: recordToolCall });

if (reg.ok) {
  status.dataset.state = 'ready';
  status.textContent = `agent surface ready — ${reg.names.length} read-only tools`;
  // `toolchange` is the visible heartbeat of the phase machine: the badge moves
  // because the tool surface actually changed, not because we told it to.
  //
  // GUARDED. `ModelContext extends EventTarget` in the spec, and in ChatGPT's
  // in-app browser this call appears not to survive — the doc says that browser
  // implements "a subset of the WebMCP APIs" and does not enumerate the subset.
  // An unguarded throw here aborted the whole remaining load path, which is why
  // the cross-origin chip was still reading its placeholder after four phase
  // transitions. A capability we cannot use must not take the page down with it.
  try {
    document.modelContext.addEventListener('toolchange', () => {
      status.textContent = `tool surface changed — ${new Date().toLocaleTimeString()}`;
    });
  } catch (err) {
    status.textContent = `agent surface ready — ${reg.names.length} read-only tools (no toolchange event: ${err?.message ?? err})`;
  }
} else {
  status.dataset.state = 'absent';
  status.textContent = `no agent surface — ${reg.reason}. The room is still fully readable here.`;
}

await syncPhaseTools();

// The cross-org line. `exposedTo` needs native WebMCP; the polyfill refuses it.
// Whichever way it goes, the page SAYS which — a demo that quietly degraded
// would be asserting a capability it does not have, which is the one thing this
// project exists not to do.
// BOUNDED. A chip that never resolves makes no claim at all — it sits on its
// placeholder and reads, to anyone looking, as a broken page rather than an
// honest one. That happened in ChatGPT's in-app browser: the placeholder was
// still showing after four phase transitions. Whatever this call does — resolve,
// reject, or hang — the chip ends up saying something true.
const xorg = $('crossorg');
const partner = await Promise.race([
  registerPartnerSurface(room, { onCall: recordToolCall }).catch((err) => ({
    available: false,
    reason: `registration threw: ${err?.message ?? err}`,
  })),
  new Promise((resolve) => setTimeout(
    () => resolve({ available: false, reason: 'the registration call did not settle within 5s in this browser' }),
    5000,
  )),
]);

if (partner.available) {
  xorg.dataset.state = 'ready';
  xorg.textContent = `cross-origin: exposed to ${partner.origin}`;
} else {
  xorg.dataset.state = 'absent';
  xorg.textContent = `cross-origin: unavailable here — ${partner.reason}. No cross-org claim is being made.`;
}

renderAll();
