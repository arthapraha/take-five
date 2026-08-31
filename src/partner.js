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

/** `executeTool` hands back a JSON STRING here, not an object — the same Chrome
 *  calling convention that takes arguments as a string going in. Reading
 *  `result.content[0].text` off a string yields undefined, so the fallback fired
 *  and the room displayed an escaped JSON blob:
 *
 *    attestation accepted by the room.
 *    "{\"content\":[{\"type\":\"text\",\"text\":\"Recorded verbatim from…
 *
 *  That is the single most-watched line of this demo — the moment a claim
 *  crosses an organisation boundary — and it read as a bug rather than a
 *  transcript. Parse the string when we are given one, and fall back to showing
 *  the raw reply rather than a stringified one, so a shape we did not anticipate
 *  is still legible instead of double-encoded. */
function replyText(result) {
  const parsed = typeof result === 'string'
    ? (() => { try { return JSON.parse(result); } catch { return null; } })()
    : result;
  return parsed?.content?.[0]?.text
    ?? (typeof result === 'string' ? result : JSON.stringify(result));
}

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
  // CORRECTED 2026-08-31. This said "this browser has no WebMCP", and in the
  // case that matters most that sentence is FALSE — measured in ChatGPT's in-app
  // browser, where the room's own chip reads `cross-origin: exposed to …` two
  // inches above this line. The browser has WebMCP; this FRAME does not. The
  // old wording inferred browser-absence from frame-absence, which is a claim
  // wider than the evidence, in the one message whose whole job is to report a
  // limitation honestly. A page that over-claims in its failure text is doing
  // the thing this project exists to refuse.
  report('absent',
    'no document.modelContext in this frame. The browser may still provide WebMCP to '
    + 'top-level documents only — check the room\'s own chip, which reports what IT sees. '
    + 'Either way, cross-origin invocation cannot be attempted from here.');
} else if (typeof document.modelContext.getTools !== 'function') {
  report('absent', 'modelContext is present in this frame but exposes no getTools — cannot query the room.');
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
      report('ready', `attestation accepted by the room.\n\n${replyText(result)}`);
    }
  } catch (err) {
    report('absent', `cross-origin invocation failed: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  }
}
