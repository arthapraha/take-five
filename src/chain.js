// The ledger: append-only, SHA-256 hash-chained, verifiable in the browser.
//
// Nothing here is mocked. Hashes are computed with Web Crypto over a canonical
// serialisation, every entry links to its predecessor, and `verify()` re-derives
// the whole chain from the entries themselves rather than trusting stored
// hashes. If an entry is altered after the fact, verification fails at that
// entry and at every entry after it — which is the only property that makes the
// rest of this project worth anything.

const GENESIS_PREV = '0'.repeat(64);

/** Deterministic JSON: object keys sorted at every depth, so the same logical
 *  entry always hashes to the same digest regardless of construction order. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bytes an entry's hash is taken over. Deliberately excludes `hash`
 *  itself — a hash cannot cover itself — and includes `prev`, which is what
 *  chains the entry to its predecessor. */
export function preimage(entry) {
  const { hash, ...rest } = entry;
  return canonical(rest);
}

export class Ledger {
  #entries = [];

  get entries() {
    return this.#entries.slice();
  }

  get length() {
    return this.#entries.length;
  }

  get tip() {
    return this.#entries.length ? this.#entries[this.#entries.length - 1].hash : GENESIS_PREV;
  }

  /** Append an act. `actor` carries the three attribution fields the whole
   *  design turns on: which seat, which door it came through, and how strongly
   *  we actually know that. */
  // Appends are SERIALISED, and this is load-bearing rather than tidy.
  //
  // `seq` and `prev` are read from live state, then the digest is awaited, then
  // the entry is pushed. That await is a gap: two overlapping calls both read
  // the same length and the same tip, and both push — producing entries that
  // share a sequence number and a predecessor. A forked chain is not a chain,
  // and every claim this project makes rests on it being one.
  //
  // Found in the judge environment by the agent reading our own ledger, which
  // is the product working and the code failing in the same breath. Two
  // overlapping `ratify_ruling` calls were enough to do it.
  #tail = Promise.resolve();

  async append(args) {
    const run = this.#tail.then(() => this.#appendOne(args));
    // Keep the queue alive when an append rejects: the caller still sees the
    // rejection, but one bad entry must not wedge every later append.
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #appendOne({ kind, payload, actor }) {
    if (!actor || !actor.seat || !actor.ingress || !actor.grade) {
      throw new Error('every entry needs seat, ingress and grade — an unattributed act is not recordable');
    }
    const entry = {
      seq: this.#entries.length + 1,
      ts: new Date().toISOString(),
      kind,
      payload: payload ?? null,
      actor,
      prev: this.tip,
    };
    entry.hash = await sha256Hex(preimage(entry));
    this.#entries.push(entry);
    return entry;
  }

  find(hash) {
    return this.#entries.find((e) => e.hash === hash) ?? null;
  }

  /** Re-derive every hash and every link. Returns the first failure rather than
   *  a bare boolean, so the UI can say which entry broke and why. */
  async verify() {
    let prev = GENESIS_PREV;
    for (const entry of this.#entries) {
      if (entry.prev !== prev) {
        return { ok: false, seq: entry.seq, reason: 'broken link', expected: prev, found: entry.prev };
      }
      const recomputed = await sha256Hex(preimage(entry));
      if (recomputed !== entry.hash) {
        return { ok: false, seq: entry.seq, reason: 'hash mismatch', expected: recomputed, found: entry.hash };
      }
      prev = entry.hash;
    }
    return { ok: true, entries: this.#entries.length, tip: this.tip };
  }

  /** Verify one entry on its own terms: does its hash match its content, and
   *  does it sit where it claims to sit in the chain. */
  async verifyEntry(hash) {
    const entry = this.find(hash);
    if (!entry) return { found: false, hash };
    const recomputed = await sha256Hex(preimage(entry));
    const predecessor = entry.seq > 1 ? this.#entries[entry.seq - 2] : null;
    const expectedPrev = predecessor ? predecessor.hash : GENESIS_PREV;
    return {
      found: true,
      hash,
      seq: entry.seq,
      content_matches_hash: recomputed === entry.hash,
      links_to_predecessor: entry.prev === expectedPrev,
      recomputed,
      actor: entry.actor,
    };
  }
}

export { GENESIS_PREV };
