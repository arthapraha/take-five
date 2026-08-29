// The verifier has to be able to FAIL, or "VERIFIED" means nothing.
//
// These tests tamper with a built chain in the two ways that matter — altering
// an entry's content, and breaking a link — and assert that verification
// catches each one and names the entry it caught. A suite that only checked the
// happy path would pass against a `verify()` that returned `{ok: true}`
// unconditionally, which is the failure mode these exist to rule out.
//
// `Ledger.entries` returns a shallow copy: a new array holding the same entry
// objects. Mutating an element therefore reaches the real entry, which is what
// lets these tests forge history the way a debugger would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, sha256Hex, preimage, GENESIS_PREV } from '../src/chain.js';

const actor = { seat: 'Room host', ingress: 'ui', grade: 'client-asserted' };

async function build(n = 4) {
  const l = new Ledger();
  for (let i = 0; i < n; i++) await l.append({ kind: 'act', payload: { i }, actor });
  return l;
}

test('a well-formed chain verifies and links back to genesis', async () => {
  const l = await build();
  const r = await l.verify();
  assert.equal(r.ok, true);
  assert.equal(r.entries, 4);
  assert.equal(l.entries[0].prev, GENESIS_PREV);
  for (let i = 1; i < l.entries.length; i++) {
    assert.equal(l.entries[i].prev, l.entries[i - 1].hash);
  }
});

test('altered content is caught, at the altered entry', async () => {
  const l = await build();
  l.entries[2].kind = 'forged';

  const r = await l.verify();
  assert.equal(r.ok, false, 'a forged entry must not verify');
  assert.equal(r.seq, 3, 'the failure must name the entry that was altered');
  assert.equal(r.reason, 'hash mismatch');
});

test('a broken link is caught, and is distinguishable from altered content', async () => {
  const l = await build();
  l.entries[2].prev = 'a'.repeat(64);

  const r = await l.verify();
  assert.equal(r.ok, false);
  assert.equal(r.seq, 3);
  assert.equal(r.reason, 'broken link', 'a severed link must not be reported as a hash mismatch');
});

test('tampering is not repairable by rehashing the tampered entry alone', async () => {
  const l = await build();
  const victim = l.entries[1];
  victim.payload = { i: 'tampered' };
  // An attacker who recomputes the victim's own hash still breaks every entry
  // after it, because those entries committed to the OLD hash.
  victim.hash = await sha256Hex(preimage(victim));

  const r = await l.verify();
  assert.equal(r.ok, false, 'rehashing one entry must not repair the chain');
  assert.equal(r.seq, 3, 'the break must surface at the first entry that pointed at the old hash');
  assert.equal(r.reason, 'broken link');
});

test('verifyEntry confirms a good entry and reports a missing one', async () => {
  const l = await build();
  const good = await l.verifyEntry(l.entries[2].hash);
  assert.equal(good.found, true);
  assert.equal(good.content_matches_hash, true);
  assert.equal(good.links_to_predecessor, true);
  assert.equal(good.actor.grade, 'client-asserted');

  const missing = await l.verifyEntry('f'.repeat(64));
  assert.equal(missing.found, false);
});

test('verifyEntry catches content tampering on a single entry', async () => {
  const l = await build();
  const target = l.entries[2];
  target.payload = { i: 'tampered' };

  const r = await l.verifyEntry(target.hash);
  assert.equal(r.found, true);
  assert.equal(r.content_matches_hash, false, 'the stored hash must no longer match the altered content');
});

test('an act with no evidence grade is refused outright', async () => {
  const l = new Ledger();
  await assert.rejects(
    () => l.append({ kind: 'act', payload: {}, actor: { seat: 'x', ingress: 'ui' } }),
    /seat, ingress and grade/,
    'an unattributed act must not be recordable at all',
  );
});

// Found in the judge environment, by the judge environment's own agent, reading
// our ledger: "two different entries both numbered #14, sharing the same
// predecessor — an apparent fork/inconsistency in the displayed chain."
//
// append() read `seq` and `prev`, then awaited the digest, THEN pushed. Two
// overlapping calls therefore both saw the same length and the same tip. Every
// guarantee this project makes rests on the chain being a chain.
test('concurrent appends do not fork the chain', async () => {
  const l = new Ledger();
  await Promise.all([
    l.append({ kind: 'a', payload: { i: 1 }, actor }),
    l.append({ kind: 'b', payload: { i: 2 }, actor }),
    l.append({ kind: 'c', payload: { i: 3 }, actor }),
  ]);

  const seqs = l.entries.map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, `duplicate seq numbers: ${seqs.join(',')}`);

  const prevs = l.entries.map((e) => e.prev);
  assert.equal(new Set(prevs).size, prevs.length, 'two entries must not share a predecessor');

  const r = await l.verify();
  assert.equal(r.ok, true, `chain must verify after concurrent appends: ${JSON.stringify(r)}`);
});

test('a burst of appends stays a single chain', async () => {
  const l = new Ledger();
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => l.append({ kind: 'burst', payload: { i }, actor })),
  );
  assert.equal(l.length, 25);
  assert.deepEqual(l.entries.map((e) => e.seq), Array.from({ length: 25 }, (_, i) => i + 1));
  const r = await l.verify();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('canonical form is key-order independent', async () => {
  const a = await sha256Hex(preimage({ seq: 1, kind: 'x', payload: { b: 1, a: 2 }, actor, prev: GENESIS_PREV, ts: 't' }));
  const b = await sha256Hex(preimage({ ts: 't', prev: GENESIS_PREV, actor, payload: { a: 2, b: 1 }, kind: 'x', seq: 1 }));
  assert.equal(a, b, 'two spellings of the same entry must hash identically');
});
