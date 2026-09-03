// The room you can actually talk to (t-3c74): the host types the question.
//
// Five properties, each one a way the feature could lie if it were built
// carelessly: the new question must be a real artefact with a real hash; the
// round must operate on what was typed; a sealed position must freeze the
// question; the row must say which door it came through and what pressed the
// button; and a real press must come out different from a scripted click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRoom, QUESTION, inputFingerprint } from '../src/room.js';
import { sha256Hex } from '../src/chain.js';
import { Round } from '../src/round.js';

const press = { type: 'click', isTrusted: true, detail: 1, screenX: 410, screenY: 512, clientX: 400, clientY: 300 };

test('1. a typed question lands as a hash-verifying artefact_updated row, appended after the seed rows', async () => {
  const room = await seedRoom('Room host');
  const before = room.ledger.length;
  const entry = await room.setQuestion('Should we ship on Thursday?', { input: inputFingerprint(press, ['pointerdown:mouse', 'mousedown']) });
  assert.equal(entry.kind, 'artefact_updated');
  assert.equal(entry.seq, before + 1, 'appended, never inserted');
  assert.equal(entry.payload.name, 'question.md');
  assert.equal(entry.payload.hash, await sha256Hex('Should we ship on Thursday?\n'), 'the hash is the digest of the new text');
  assert.equal(entry.payload.previous, await sha256Hex(QUESTION), 'and names the version it replaced');
  assert.ok(room.artefacts.has(entry.payload.hash), 'the new version is stored under its hash');
  assert.equal(room.question, 'Should we ship on Thursday?\n');
  assert.equal((await room.ledger.verify()).ok, true, 'the chain still verifies');
});

test('2. the round operates on what the host typed, not the fixture', () => {
  const round = new Round(QUESTION.trim());
  round.retitle('Should we ship on Thursday?');
  assert.equal(round.question, 'Should we ship on Thursday?');
  assert.equal(round.questionOpen, true);
});

test('3. once a position is sealed, the question is frozen — refused, not ignored', async () => {
  const round = new Round(QUESTION.trim());
  round.commitments.set('rider', { commitment: 'deadbeef', entryHash: 'x' });
  assert.equal(round.questionOpen, false);
  assert.throws(() => round.retitle('Something else?'), /frozen/);
  assert.equal(round.question, QUESTION.trim(), 'unchanged after the refusal');
  // And the room refuses a non-host seat and an empty question on its own.
  const room = await seedRoom('Room host');
  await assert.rejects(room.setQuestion('x', { seatId: 'rider' }), /only the host/);
  await assert.rejects(room.setQuestion('   '), /required/);
});

test('4. the row walks the ui door, graded client-asserted, and carries the press', async () => {
  const room = await seedRoom('Room host');
  const entry = await room.setQuestion('Should we ship?', { input: inputFingerprint(press, ['pointerdown:mouse', 'mousedown']) });
  assert.equal(entry.actor.ingress, 'ui');
  assert.equal(entry.actor.grade, 'client-asserted');
  assert.equal(entry.actor.seat, 'Room host');
  assert.equal(entry.payload.confirmation.method, 'in-page input');
  assert.equal(entry.payload.confirmation.input.isTrusted, true);
  assert.equal(entry.payload.confirmation.input.prelude, 'pointerdown:mouse+mousedown');
});

test('5. the fingerprint tells a real press from page script — by isTrusted, the one field a page cannot forge', () => {
  const real = inputFingerprint(press, ['pointerdown:mouse', 'mousedown']);
  const scripted = inputFingerprint({ type: 'click', isTrusted: false, detail: 0, screenX: 0, screenY: 0, clientX: 0, clientY: 0 }, []);
  assert.equal(real.isTrusted, true);
  assert.equal(scripted.isTrusted, false);
  assert.equal(scripted.prelude, 'none');
  assert.notDeepEqual(real, scripted);
  assert.deepEqual(inputFingerprint(null), { via: 'none — no event', prelude: 'none' });
  // An Enter in the input submits the form with no click: the submit event is
  // the press, and it says so — never a stale click from an earlier row.
  const enter = inputFingerprint({ type: 'submit', isTrusted: true }, []);
  assert.equal(enter.via, 'submit');
  assert.equal(enter.isTrusted, true);
  assert.deepEqual(enter.client, [0, 0], 'no coordinates: nothing was pointed at');
});

test("6. the commitment gate is the PAGE's, not the room's: setQuestion after a sealed position still appends — the room refuses only what it can judge alone", async () => {
  // Hermes (take-five seq 2119): Round.retitle() refuses once a position is
  // sealed and the page checks it FIRST; the room method does not know the
  // round. Pinned so a future caller that skips retitle is caught by this line,
  // not discovered on the chain.
  const room = await seedRoom('Room host');
  const round = new Round(QUESTION.trim());
  round.commitments.set('rider', { commitment: 'deadbeef', entryHash: 'x' });
  assert.equal(round.questionOpen, false);
  const entry = await room.setQuestion('A question after the seal?');
  assert.equal(entry.kind, 'artefact_updated', 'the room appended: it cannot see the commitment');
  assert.throws(() => round.retitle('A question after the seal?'), /frozen/, 'the round is the gate, and the page asks it first');
});
