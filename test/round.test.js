// Commit–reveal has one job: make it impossible to change your answer after
// seeing someone else's. These tests attack that property directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitmentFor, freshNonce, checkReveal } from '../src/round.js';

test('a commitment discloses nothing about the position', async () => {
  const nonce = freshNonce();
  const c = await commitmentFor('Adopt as drafted', nonce);
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.ok(!c.includes('Adopt'), 'the digest must not carry the plaintext');
});

test('the correct position and nonce open the commitment', async () => {
  const nonce = freshNonce();
  const value = 'Adopt as drafted';
  const commitment = await commitmentFor(value, nonce);
  const r = await checkReveal({ commitment, value, nonce });
  assert.equal(r.matches, true);
  assert.equal(r.recomputed, commitment);
});

test('a single changed byte in the position is refused', async () => {
  const nonce = freshNonce();
  const commitment = await commitmentFor('Adopt as drafted', nonce);
  const r = await checkReveal({ commitment, value: 'Adopt as drafted!', nonce });
  assert.equal(r.matches, false, 'one extra character must break the reveal');
  assert.notEqual(r.recomputed, commitment);
});

test('the right position with the wrong nonce is refused', async () => {
  const value = 'Adopt as drafted';
  const commitment = await commitmentFor(value, freshNonce());
  const r = await checkReveal({ commitment, value, nonce: freshNonce() });
  assert.equal(r.matches, false);
});

test('the separator prevents a boundary collision', async () => {
  // Without a separator, ("ab","c") and ("a","bc") would hash identically and a
  // seat could open one commitment with a different position/nonce split.
  const a = await commitmentFor('ab', 'c');
  const b = await commitmentFor('a', 'bc');
  assert.notEqual(a, b, 'concatenation must not be ambiguous across the boundary');
});

test('nonces do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(freshNonce());
  assert.equal(seen.size, 200, 'a repeated nonce would weaken every commitment using it');
});

test('the check reports what it compared, not just a verdict', async () => {
  const nonce = freshNonce();
  const commitment = await commitmentFor('yes', nonce);
  const r = await checkReveal({ commitment, value: 'no', nonce });
  assert.equal(r.matches, false);
  assert.equal(r.commitment, commitment);
  assert.match(r.recomputed, /^[0-9a-f]{64}$/, 'a caller must be able to see both digests and check for itself');
});
