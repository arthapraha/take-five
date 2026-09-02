// The room: five phases, the seats at the table, and the attribution table
// that decides how strongly any given act can be claimed.
//
// Phase transitions are explicit acts by the host seat. There are no timers —
// a timer is invisible on video and non-deterministic in a live session.

import { Ledger, sha256Hex } from './chain.js';

export const PHASES = ['Open', 'Commit', 'Reveal', 'Ruling', 'Closed'];

/** Ingress path → what the record may claim, and how well it knows it.
 *
 *  The honest part is the middle two rows. At the WebMCP door a person clicking
 *  and an agent calling a registered tool are genuinely different code paths,
 *  so the distinction is real — but it is the *page's* knowledge, not the
 *  server's, because both arrive inside the same authenticated session. So the
 *  record says `client-asserted` and the interface never renders it harder than
 *  that. We record attribution durably; we do not claim to have separated a
 *  rider from its session. */
export const INGRESS = {
  // NOT "human-initiated", which is what this said and what this build
  // disproved. An agent driving the page takes this door as readily as a person
  // does — we watched one do it. The README and the grade legend were corrected
  // for that in 62da160; the DURABLE RECORD was not, so every UI entry went on
  // asserting a human while sitting beside a fingerprint reading
  // `isTrusted: false` — page script. The prose was scrupulous and the evidence
  // store contradicted it, which is this project's own thesis failing in the one
  // place it cannot afford to.
  //
  // This field describes THE DOOR. What actually pressed the button, where it
  // can be observed at all, lives in `payload.confirmation.input` — recorded
  // once, rendered on the row and in `verify_receipt`. Deriving a prose
  // duplicate here would just create a second thing to fall out of step.
  ui: { label: 'Web UI handler', actor: 'through the page\'s own UI; this door does not establish the actor', grade: 'client-asserted' },
  webmcp: { label: 'WebMCP tool call', actor: 'agent-initiated, riding the human session', grade: 'client-asserted' },
  mcp: { label: 'MCP seat', actor: 'agent, first-party', grade: 'server-observed' },
  room: { label: 'Room bookkeeping', actor: 'the room', grade: 'server-observed' },
  partner: { label: 'Partner origin', actor: 'as the partner asserts', grade: 'inherited' },
};

export const GRADE_NOTE = {
  'server-observed': 'the credential was presented to the server directly',
  // Sharpened after an agent resolved this demo's confirmation dialog with
  // nobody's hand on the keyboard. The old wording — "distinguished only by
  // code path" — was true and still read as though the code path told you WHO
  // acted. It does not. It tells you which door the act came through, and an
  // agent driving the page can use the human's door.
  'client-asserted': "the page's claim — which door the act came through, not who caused it; an agent driving the page can use this door",
  inherited: 'carried verbatim from another origin; trust derives from that origin',
};

export class Room {
  constructor({ hostName = 'Room host' } = {}) {
    this.ledger = new Ledger();
    this.phase = 'Open';
    // "Room host" is a ROLE, not a person and not a hardcoded name. Whichever
    // seat holds it advances the phase machine; the placeholder is filled at
    // load, so a visiting judge is the host of their own session.
    this.seats = [
      { id: 'host', name: hostName, kind: 'human', role: 'host', door: 'ui' },
      { id: 'rider', name: 'Riding agent', kind: 'agent', role: 'participant', door: 'webmcp' },
      // Named for what the door means, not for a product. The distinguishing
      // property of this seat is that it holds its OWN credential and presents
      // it to the server directly — which is precisely why its acts grade
      // `server-observed` while the rider's grade `client-asserted`. A vendor
      // name here would have said nothing about that, and put a third party's
      // trademark on screen for the length of a demo video.
      { id: 'mcp-seat', name: 'Credentialed agent', kind: 'agent', role: 'participant', door: 'mcp' },
    ];
    this.artefacts = new Map();
  }

  seat(id) {
    return this.seats.find((s) => s.id === id) ?? null;
  }

  /** Record an act. Every caller must say which door it came through; the
   *  grade is derived from that table, never passed in by the caller. */
  async record({ kind, payload, seatId, ingress }) {
    const path = INGRESS[ingress];
    if (!path) throw new Error(`unknown ingress path: ${ingress}`);
    const seat = this.seat(seatId);
    return this.ledger.append({
      kind,
      payload,
      actor: {
        seat: seat ? seat.name : seatId,
        ingress,
        grade: path.grade,
        attribution: path.actor,
      },
    });
  }

  async addArtefact(name, text, { seatId = 'room', ingress = 'room' } = {}) {
    const hash = await sha256Hex(text);
    this.artefacts.set(hash, { name, text, hash, bytes: new TextEncoder().encode(text).length });
    await this.record({ kind: 'artefact_added', payload: { name, hash }, seatId, ingress });
    return hash;
  }

  async advance(to, { seatId = 'host', ingress = 'ui' } = {}) {
    const from = this.phase;
    const i = PHASES.indexOf(from);
    if (to !== PHASES[i + 1]) throw new Error(`cannot go ${from} → ${to}`);
    const seat = this.seat(seatId);
    if (!seat || seat.role !== 'host') throw new Error('only the host seat advances the phase');
    this.phase = to;
    return this.record({ kind: 'phase', payload: { from, to }, seatId, ingress });
  }
}

/** The payload an `inherited` entry has to carry to be worth anything: what was
 *  said, who said it, and a digest a reader can recompute for themselves.
 *
 *  This was specified from the start as "partner payload verbatim + source
 *  origin + content hash" and then not implemented — `partner_attest` took a
 *  `claim`, dropped it, and recorded an entry whose own tool description said
 *  "Recorded verbatim". The room told a caller it had kept something it threw
 *  away, which is a worse failure than never having offered to keep it.
 *
 *  The hash covers the claim bytes AS RECORDED. It evidences what we carried,
 *  never that the claim is true — that is the whole meaning of `inherited`, and
 *  the surfaces that render this say so rather than leaving it to be inferred.
 *
 *  Exported and pure so it can be tested without a browser: the tool that calls
 *  it needs `document.modelContext`, and a payload builder that could only be
 *  exercised through the DOM would go the way of the first version. */
export async function attestationPayload(claim, origin) {
  const text = String(claim ?? '');
  return { claim: text, origin, content_hash: await sha256Hex(text) };
}

export const QUESTION = 'Should the room adopt the proposal as drafted?\n';

/** A per-visitor sandbox room, seeded with real history and left in Commit so
 *  an unaccompanied visitor can walk the rest of the flow themselves.
 *
 *  This is mapping v2 §1a's first shape: the visitor's own seat holds the host
 *  role, which is consistent because host-is-a-role. A judge who opens the live
 *  URL is not a spectator in someone else's room — they are the host of theirs,
 *  and every phase verb is available to them without any act from us.
 *
 *  The seeding is genuine: each entry below is appended and hashed exactly like
 *  any other. Nothing here is a fixture wearing the costume of history. */
export async function seedRoom(hostName) {
  const room = new Room({ hostName });
  await room.record({ kind: 'room_opened', payload: { name: 'Take Five' }, seatId: 'room', ingress: 'room' });
  await room.addArtefact('question.md', QUESTION);
  await room.advance('Commit');
  return room;
}

/** The tools the page offers an agent RIGHT NOW: the always-on read surface plus
 *  the current phase's tools — exactly what the "tools the agent can see now"
 *  panel lists, and exactly what the local bridge may expose. Pure, so a node
 *  test can pin it: on 2 Sept 2026 the bridge's first offered-filter used the
 *  phase list alone and offered an agent ONE tool (take-five seq 1797–1804).
 *  Never includes anything registered for another origin (`partner_attest`),
 *  because neither input does. */
export function offeredNames(readNames, phaseNames) {
  return [...new Set([...(readNames ?? []), ...(phaseNames ?? [])])];
}
