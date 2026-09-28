// The two status lines under the panel's Connection section, built from what
// the local agent reports and nothing else (t-96c4). Kept pure and apart from
// sidepanel.js so the test suite can import them: sidepanel.js touches the DOM
// and chrome.* on load, and a test that imported it would be testing a
// different program.

/** The agent line. `health` is the sidecar's /health answer.
 *
 *  The "page:" clause is the SIDECAR's view: whether the relay has a page
 *  attached by either route, the panel's Attach or a page opened with the
 *  relay's ?bridge= URL. That is not the same fact as this panel's own
 *  `bridge:` line, which only knows about the tab this panel attached, so both
 *  lines stay.
 *
 *  What was wrong was WHEN it was read. It was built once at Connect and never
 *  again, so it went on reporting "NOT attached" after an Attach, or "attached"
 *  after the page closed, as if that were current. The panel now rebuilds it
 *  on every event that can change it: Connect, Attach, Detach, the page going
 *  away, and each answer from the agent. */
export function agentLine(health) {
  const a = health?.agent;
  if (!a) return 'agent: not connected';
  const page = health.relay?.pages ? 'attached' : 'NOT attached';
  return `agent: ${a.model} via ${a.via} — outside the browser; page: ${page}`;
}

/** The tools line. `tools` is the list of names the sidecar reports.
 *
 *  An empty list used to say only "open it with the ?bridge= URL the relay
 *  printed". That route still works, but this line is shown INSIDE the
 *  extension's panel, a few pixels above "Attach this tab", so naming only
 *  the URL sent the reader away from the control in front of them. It now
 *  names the button first and keeps the URL as the alternative. */
export function toolsLine(tools) {
  const names = Array.isArray(tools) ? tools : [];
  if (names.length) return `tools the page offers now: ${names.join(', ')}`;
  return 'the page offers no tools yet — open the room and click "Attach this tab" below, '
    + 'or open the page with the ?bridge= URL the relay printed';
}
