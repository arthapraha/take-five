// The partner origin.
//
// This page is deliberately not part of the demo's story. It exists so that the
// `inherited` row in the room's attribution table is a thing that HAPPENS rather
// than a thing we describe. A different organisation, on a different origin,
// asserts something; the room records it verbatim, names the origin it came
// from, and grades it honestly as carried rather than witnessed.
//
// It runs inside an iframe embedded by the room, and calls back OUT to the
// embedder's tools. That direction matters: the room's tools are registered on
// its own top-level document, which is where ChatGPT's browser says discovery
// works. Nothing of this page's own is ever registered as a tool, so the
// documented "tools inside iframes are not discovered" limitation is not in the
// path.
//
// Every failure below is reported on the page and posted to the embedder rather
// than swallowed. A partner that silently fails to attest would leave the room
// looking like it simply had no partner — which is exactly the difference
// between an honest demo and a flattering one.

const ROOM_ORIGIN = new URLSearchParams(location.search).get('room')
  ?? 'https://take-five-lw7.pages.dev';

const $ = (id) => document.getElementById(id);

function report(state, text) {
  const el = $('partner-status');
  el.dataset.state = state;
  el.textContent = text;
  // Tell the embedder too, so the room can show what happened without the
  // viewer having to read inside the frame.
  try {
    parent.postMessage({ source: 'take-five-partner', state, text }, ROOM_ORIGIN);
  } catch { /* the room will fall back to its own timeout */ }
}

$('partner-origin').textContent = `this page: ${location.origin}\nthe room:  ${ROOM_ORIGIN}`;

if (location.origin === ROOM_ORIGIN) {
  report('absent', 'same origin as the room — this proves nothing. Serve this page from a different origin.');
} else if (!document.modelContext) {
  report('absent', 'no document.modelContext here — this browser has no WebMCP, so cross-origin invocation cannot be attempted.');
} else if (typeof document.modelContext.getTools !== 'function') {
  report('absent', 'this browser exposes modelContext without getTools — cannot query the room.');
} else {
  try {
    // The cross-origin query. `fromOrigins` is how a document asks for tools
    // belonging to another origin; the room must have named us in `exposedTo`
    // or we will see nothing.
    const tools = await document.modelContext.getTools({ fromOrigins: [ROOM_ORIGIN] });
    const attest = tools.find((t) => t.name === 'partner_attest');

    if (!attest) {
      report('absent',
        `queried ${ROOM_ORIGIN} and got ${tools.length} tool(s); partner_attest was not among them. ` +
        'Either cross-origin exposure is not served here, or this origin is not on the room\'s allowlist.');
    } else {
      const claim = `Attested by ${location.origin} at ${new Date().toISOString()}`;
      // Arguments go as a JSON string — the Chrome-style calling convention.
      const result = await document.modelContext.executeTool(attest, JSON.stringify({ claim }));
      const text = result?.content?.[0]?.text ?? JSON.stringify(result);
      report('ready', `attestation accepted by the room.\n\n${text}`);
    }
  } catch (err) {
    report('absent', `cross-origin invocation failed: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  }
}
