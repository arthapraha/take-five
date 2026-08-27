// Commit–reveal.
//
// A seat commits to a position without disclosing it: the room records only
// SHA-256(value + "|" + nonce). At reveal the seat supplies the value and the
// nonce, and the commitment is recomputed. If a single byte of either has
// changed, the digest does not match and the reveal is refused.
//
// The property that matters is ORDERING, not secrecy: the commitment is sealed
// onto the append-only chain BEFORE any position is visible, so no seat can
// adjust its answer after seeing another's. The chain is what makes that
// checkable afterwards by someone who was not in the room.

import { sha256Hex } from './chain.js';

const SEP = '|';

export async function commitmentFor(value, nonce) {
  return sha256Hex(`${value}${SEP}${nonce}`);
}

/** A nonce the committing seat keeps until reveal. Without it, a short answer
 *  space ("yes"/"no") would let anyone brute-force the commitment. */
export function freshNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Recompute and compare. Returns the recomputed digest either way so a caller
 *  — or a judge — can see exactly what was compared, rather than a bare
 *  boolean it has to trust. */
export async function checkReveal({ commitment, value, nonce }) {
  const recomputed = await commitmentFor(value, nonce);
  return {
    matches: recomputed === commitment,
    commitment,
    recomputed,
  };
}

/** The round's state: who has committed, who has revealed, and what the
 *  revealed positions were. Held separately from the ledger — the ledger is the
 *  record of acts, this is the working state those acts move. */
export class Round {
  constructor(question) {
    this.question = question;
    this.commitments = new Map(); // seatId -> { commitment, entryHash }
    this.reveals = new Map();     // seatId -> { value, matches, recomputed }
  }

  hasCommitted(seatId) {
    return this.commitments.has(seatId);
  }

  get committed() {
    return [...this.commitments.keys()];
  }

  get revealed() {
    return [...this.reveals.keys()];
  }
}
