// Claims about this project, checked mechanically.
//
// The README is the first thing a reader sees and the last thing anyone
// remembers to update. A hand-maintained count of the test suite drifted three
// times in a single day — 17, then 24, then 26, against a suite that was by then
// 29 — and one of those drifts happened two commits after the same line had been
// corrected. Convention did not hold it, because convention is a thing people
// remember and this is a thing people forget.
//
// So it is enforced here instead. This project's argument is that a claim should
// be checkable rather than trusted; a number in a public README that nothing
// verifies is a small uncheckable claim sitting inside a document arguing
// against them.
//
// The fix is not "get the number right". It is "do not assert a number that
// nothing recomputes". `npm test` prints the true count every run, which is the
// surface that cannot go stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(repo, f), 'utf8');

test('the README states no hand-written test count', () => {
  const offenders = [...read('README.md').matchAll(/^.*\b\d+\s+tests?\b.*$/gim)]
    .map((m) => m[0].trim());

  assert.deepEqual(offenders, [],
    'A literal test count in the README goes stale the next time a test is added — '
    + 'it has three times already. Say what the suite is, not how many it holds; '
    + '`npm test` prints the real number on every run.');
});

test('the README does not claim a human-only gate', () => {
  // The other claim in this repo that was falsified by its own build. An agent
  // resolved the confirmation dialog with nobody's hand on the keyboard, and
  // `requestUserInteraction()` is absent from every environment tested. If a
  // future edit softens that back into a capability claim, this fails.
  const readme = read('README.md');
  assert.match(readme, /no way to build a human-only gate/i,
    'the README must keep stating that a human-only gate cannot currently be built');
  assert.doesNotMatch(readme, /\bguarantees?\s+(?:a\s+)?human\b|\bhuman-verified\b/i,
    'nothing here may claim to guarantee a human — this build demonstrated it cannot');
});
