// The panel's two status lines, and the sidecar's instructions for reaching
// them (t-96c4).
//
// These test the TEXT. They cannot test the TIMING, which was half of the
// defect: the panel built its agent line once at Connect and never again.
// Whether the panel re-reads on Attach, Detach and each answer lives in
// sidepanel.js, which touches the DOM and chrome.* on load and cannot be
// imported here. That half is checked by attaching and detaching in a real
// Chrome and watching "page:" flip. A green run of this file does not show it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { agentLine, toolsLine, checkAgentReply } from '../extension/panel-lines.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(repo, f), 'utf8');
const agent = { model: 'glm-5.3:cloud', via: 'ollama' };

test('the agent line reports the page as the relay reports it', () => {
  assert.match(agentLine({ agent, relay: { pages: 1 } }), /page: attached$/);
  assert.match(agentLine({ agent, relay: { pages: 0 } }), /page: NOT attached$/);
  assert.match(agentLine({ agent }), /page: NOT attached$/,
    'no relay figure is not evidence of a page');
  assert.equal(agentLine(null), 'agent: not connected');
});

test('a tool list is named in full', () => {
  assert.equal(toolsLine(['read_ledger', 'list_seats']), 'tools the page offers now: read_ledger, list_seats');
});

test('an empty tool list points at the control on the panel, and keeps the URL as the alternative', () => {
  const line = toolsLine([]);
  assert.match(line, /click "Attach this tab"/,
    'the line sits above the Attach button, so it must name that button first');
  assert.match(line, /\?bridge= URL/, 'the no-extension route still works and stays named');
  assert.ok(line.indexOf('Attach this tab') < line.indexOf('?bridge='),
    'the button comes first: a reader inside the extension should not be sent away from it');
  assert.doesNotMatch(line, /tools the page offers now: $/,
    'the per-prompt refresh used to write this with nothing after it');
});

// This REPLACES an assertion from the first commit of this card, which said
// the opposite: `toolsLine(undefined)` returned the empty-tools line. That test
// pinned the defect counsel found at 3579 into the suite. A failed read became
// "the page offers no tools yet", which is a claim about the page made from
// no evidence at all.
test('a non-list is refused, never described as an empty page', () => {
  for (const bad of [undefined, null, 'x', { tools: [] }]) {
    assert.throws(() => toolsLine(bad), TypeError, `toolsLine(${JSON.stringify(bad)}) must not describe the page`);
  }
});

const ok = { healthOk: true, health: { agent, relay: { pages: 1 } }, toolsStatus: 200, toolsOk: true, toolsBody: { tools: ['read_ledger'] } };

test('a well-formed reply passes through unchanged', () => {
  assert.deepEqual(checkAgentReply(ok), { h: ok.health, tools: ['read_ledger'] });
  assert.deepEqual(checkAgentReply({ ...ok, toolsBody: { tools: [] } }).tools, [],
    'a genuinely empty list is still an answer, and still reads as no tools');
});

test('an error body from /tools is a failure, not an empty page (counsel, 3579)', () => {
  assert.throws(() => checkAgentReply({ ...ok, toolsStatus: 500, toolsOk: false, toolsBody: { error: 'relay down' } }),
    /did not answer \/tools with a tool list \(HTTP 500\)/);
  assert.throws(() => checkAgentReply({ ...ok, toolsBody: { error: 'no list' } }), /did not answer \/tools/,
    'a 200 carrying no list is just as much a failure');
  assert.throws(() => checkAgentReply({ ...ok, toolsBody: null }), /did not answer \/tools/,
    'a body that was not JSON arrives as null and is refused');
  assert.throws(() => checkAgentReply({ ...ok, toolsStatus: 401, toolsOk: false }), /token refused/);
});

test('an error body from /health is a failure, not "not connected" beside a green dot (counsel, 3579)', () => {
  assert.throws(() => checkAgentReply({ ...ok, healthOk: false, health: { error: 'boom' } }), /did not answer \/health/);
  assert.throws(() => checkAgentReply({ ...ok, health: { relay: { pages: 1 } } }), /did not answer \/health/,
    'a 200 with no agent in it is refused, not rendered');
  assert.throws(() => checkAgentReply({ ...ok, health: null }), /did not answer \/health/);
});

// What actually drifted: the sidecar told the owner to paste into a panel
// section called "Sidecar connection", a heading the panel no longer had. So
// assert against the panel ITSELF. Every label the startup line quotes has to
// be on the panel's page. Renaming either side without the other fails here.
test('every panel label the sidecar tells the owner to use is on the panel', () => {
  const agentSrc = read('sidecar/agent.mjs');
  const panel = read('extension/sidepanel.html');
  const logLine = agentSrc.split('\n').filter((l) => /\blog\(/.test(l) || /^\s*\+\s*'/.test(l))
    .join(' ').match(/paste both into the panel[^;]*/)?.[0];
  assert.ok(logLine, 'the startup instruction must still exist');
  const quoted = [...logLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(quoted.length >= 3, `expected the section, the field and the button to be named, got ${JSON.stringify(quoted)}`);
  for (const label of quoted) {
    assert.ok(panel.includes(`>${label}`) || panel.includes(`${label} <`) || panel.includes(`>${label}<`),
      `the sidecar tells the owner to use "${label}", which is not on the panel`);
  }
});
