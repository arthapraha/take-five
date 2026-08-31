// The `inherited` grade is the only one that says "we did not see this happen",
// and it is worth nothing unless the entry carries what was said, who said it,
// and a digest a reader can recompute.
//
// It carried none of the three. `partner_attest` took a `claim`, destructured
// it, and recorded an entry with no payload at all — while its own tool
// description and its on-screen reply both said "Recorded verbatim". The room
// told a caller it had kept something it discarded, and `read_ledger` on that
// entry would have shown a judge an empty payload under that promise.
//
// The last test here is the one that matters: the claim is now INSIDE the
// preimage, so altering it after the fact breaks verification. Before the fix
// there was nothing to alter — which is why "the chain still verified" was not
// evidence that the claim was safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, seedRoom, QUESTION, attestationPayload } from '../src/room.js';
import { sha256Hex } from '../src/chain.js';
import { partnerTool, buildTools, PARTNER_ORIGIN } from '../src/tools.js';

const ORIGIN = 'https://partner.example.test';

async function attest(room, claim) {
  return room.record({
    kind: 'partner_attestation',
    payload: await attestationPayload(claim, ORIGIN),
    seatId: 'Partner origin',
    ingress: 'partner',
  });
}

test('an attestation carries the claim verbatim, its origin, and a recomputable hash', async () => {
  const claim = 'Attested by the partner at 2026-08-31T14:27:30.000Z';
  const p = await attestationPayload(claim, ORIGIN);

  assert.equal(p.claim, claim, 'verbatim means byte-for-byte, not summarised');
  assert.equal(p.origin, ORIGIN);
  assert.equal(p.content_hash, await sha256Hex(claim),
    'a reader must be able to recompute the digest from the claim alone');
});

test('the claim survives onto the ledger entry, not just into the reply', async () => {
  const room = new Room();
  const entry = await attest(room, 'the partner asserts something');

  assert.equal(entry.payload.claim, 'the partner asserts something',
    'this is the assertion the fix exists to make: the entry holds the claim');
  assert.equal(entry.payload.origin, ORIGIN);
  assert.equal(entry.actor.grade, 'inherited');
  assert.equal(entry.actor.ingress, 'partner');
});

test('a missing or non-string claim still records, as the empty claim', async () => {
  // The schema requires `claim`, but the schema is not the enforcement — a
  // partner origin is another party's code and may send anything. Recording an
  // empty claim honestly beats throwing inside an append.
  for (const bad of [undefined, null, 42]) {
    const p = await attestationPayload(bad, ORIGIN);
    assert.equal(typeof p.claim, 'string');
    assert.equal(p.content_hash, await sha256Hex(String(bad ?? '')));
  }
});

test('a chain carrying a nested attestation payload still verifies', async () => {
  const room = new Room();
  await room.record({ kind: 'room_opened', seatId: 'room', ingress: 'room' });
  await attest(room, 'first');
  await attest(room, 'second');

  const r = await room.ledger.verify();
  assert.equal(r.ok, true, 'canonical serialisation must handle the nested payload');
  assert.equal(r.entries, 3);
});

// The tests above exercise the payload builder. THIS one exercises the line
// that was actually wrong: `partner_attest.execute` calling `room.record`
// without a payload. A suite that only covered the builder would have gone
// green against the broken tool.
test('the partner_attest tool itself puts the claim on the chain', async () => {
  const room = new Room();
  const called = [];
  const tool = partnerTool(room, { onCall: (n) => called.push(n) });

  const reply = await tool.execute({ claim: 'the partner agrees, verbatim' });

  const entry = room.ledger.entries.at(-1);
  assert.equal(entry.kind, 'partner_attestation');
  assert.equal(entry.payload.claim, 'the partner agrees, verbatim',
    'the tool must record the claim it was given, not merely say that it did');
  assert.equal(entry.payload.origin, PARTNER_ORIGIN);
  assert.equal(entry.payload.content_hash, await sha256Hex('the partner agrees, verbatim'));

  assert.equal(entry.actor.seat, 'Partner origin');
  assert.equal(entry.actor.grade, 'inherited');
  assert.deepEqual(called, ['partner_attest'], 'the call is announced after the append');

  // The reply says "Recorded verbatim". That sentence is only true if the
  // assertions above hold — which is the entire point of this test.
  assert.match(reply.content[0].text, /Recorded verbatim from/);
});

test('altering a recorded claim after the fact breaks verification', async () => {
  const room = new Room();
  await room.record({ kind: 'room_opened', seatId: 'room', ingress: 'room' });
  const entry = await attest(room, 'the partner agrees');
  await room.record({ kind: 'room_note', seatId: 'room', ingress: 'room' });

  // `Ledger.entries` hands back the real entry objects, so this forges history
  // exactly as a debugger with the page open could.
  room.ledger.entries[1].payload.claim = 'the partner disagrees';

  const r = await room.ledger.verify();
  assert.equal(r.ok, false, 'a claim outside the hash is a claim anyone can rewrite');
  assert.equal(r.seq, entry.seq, 'verification must name the entry that was altered');
  assert.equal(r.reason, 'hash mismatch');
});

// `get_artefact` advertised itself and then refused every caller. Its lookup is
// an exact Map match, but the ONLY surface that ever named a hash — its own
// "Held:" listing on the not-found path — abbreviated it through `short()`.
// `read_ledger` prints no payload and the UI rows are abbreviated too, so there
// was no path by which an agent could learn a full digest. One of five
// advertised read tools could not be used.
//
// This is the round trip, not a string check: discover a hash the way an agent
// must, then call with exactly what was handed over. It fails against the old
// code at the second step.
test('an agent can discover an artefact hash and call back with it', async () => {
  const room = await seedRoom('Room host');
  const [get] = buildTools(room, {}).filter((t) => t.name === 'get_artefact');

  const listing = get.execute({}).content[0].text;

  const digests = listing.match(/\b[0-9a-f]{64}\b/g) ?? [];
  assert.ok(digests.length >= 1,
    'the not-found listing must name a FULL digest — an abbreviated one can never be passed back');

  const fetched = get.execute({ hash: digests[0] }).content[0].text;
  assert.match(fetched, /question\.md/, 'the discovered digest must actually resolve');
  assert.match(fetched, new RegExp(QUESTION.trim().slice(0, 20)),
    'and must return the artefact text itself');
});

// `verify_receipt` could never be called either, and for the same reason one
// layer along: it does an exact `find()` on a full entry digest, and NO surface
// in the system emitted one. `read_ledger` abbreviated, `current_phase` shortened
// the tip, the write tools replied with sequence numbers, and every UI render
// went through `short()`.
//
// It compounds, which is why this mattered more than get_artefact. `verify_receipt`
// is the only TOOL-side surface that renders the confirmation fingerprint and the
// carried partner claim — so the two fixes that landed earlier today were
// invisible to any agent until this one.
//
// Round trip again: read the ledger the way an agent must, take a hash out of
// what it was handed, and verify with it. Fails at the second step against the
// abbreviating version.
test('an agent can verify a receipt using a hash read_ledger gave it', async () => {
  const room = await seedRoom('Room host');
  const t = Object.fromEntries(buildTools(room, {}).map((x) => [x.name, x]));

  const listing = t.read_ledger.execute({}).content[0].text;
  const digests = listing.match(/\b[0-9a-f]{64}\b/g) ?? [];
  assert.ok(digests.length >= 1,
    'read_ledger must emit at least one FULL entry digest — it is the only surface that can');

  const verdict = (await t.verify_receipt.execute({ hash: digests[0] })).content[0].text;
  assert.match(verdict, /VERIFIED/, 'a hash the room handed out must be one the room accepts');
  assert.doesNotMatch(verdict, /No entry with hash/);
});

test('the fingerprint and the carried claim are reachable through verify_receipt', async () => {
  // The point of the fix: both earlier repairs are only visible to an agent
  // through this path, so assert the path end to end rather than the storage.
  const room = await seedRoom('Room host');
  const entry = await attest(room, 'the partner asserts something checkable');
  const t = Object.fromEntries(buildTools(room, {}).map((x) => [x.name, x]));

  const listing = t.read_ledger.execute({ cursor: entry.seq }).content[0].text;
  const digests = listing.match(/\b[0-9a-f]{64}\b/g) ?? [];
  const verdict = (await t.verify_receipt.execute({ hash: digests[0] })).content[0].text;

  assert.match(verdict, /the partner asserts something checkable/,
    'the claim must be readable by an agent, not merely stored');
  assert.match(verdict, /content hash:/);
});
