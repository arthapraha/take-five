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
  // A non-list is NOT an empty list. This used to coerce anything that was
  // not an array to [] and then say "the page offers no tools yet", so a
  // failed read came out as an absence (counsel's review of f024d50, seq
  // 3579). The first commit of this card even had a test asserting that
  // coercion. The caller validates the reply (checkAgentReply below); if
  // something unvalidated still reaches here, it should fail loudly rather
  // than make a claim about the page.
  if (!Array.isArray(tools)) throw new TypeError(`toolsLine needs a list of tool names, got ${tools === null ? 'null' : typeof tools}`);
  if (tools.length) return `tools the page offers now: ${tools.join(', ')}`;
  return 'the page offers no tools yet — open the room and click "Attach this tab" below, '
    + 'or open the page with the ?bridge= URL the relay printed';
}

/** Decide whether the sidecar's two answers are something the panel may
 *  REPORT, or a failure it must SHOW as one (counsel, seq 3579).
 *
 *  The first version checked only for 401. Any other error that came back
 *  with a JSON body passed through. /tools {"error":…} left `tools`
 *  undefined, which rendered as "no tools yet". /health {"error":…} left
 *  `agent` undefined, which rendered "agent: not connected" beside a
 *  status dot set to on. Before that commit, both threw and the panel said
 *  "not connected". So the refactor had turned two failures into two
 *  claims, and this puts them back as failures.
 *
 *  Returns { h, tools } only when both answers are the shape the panel is
 *  about to describe; throws a message naming what was wrong otherwise. */
export function checkAgentReply({ healthOk, health, toolsStatus, toolsOk, toolsBody }) {
  if (toolsStatus === 401) throw new Error('token refused by the local agent');
  if (!healthOk || !health || !health.agent) {
    throw new Error('the local agent did not answer /health with an agent');
  }
  if (!toolsOk || !toolsBody || !Array.isArray(toolsBody.tools)) {
    throw new Error(`the local agent did not answer /tools with a tool list (HTTP ${toolsStatus})`);
  }
  return { h: health, tools: toolsBody.tools };
}
