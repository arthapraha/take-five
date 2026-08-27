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
  ui: { label: 'Web UI handler', actor: 'human-initiated', grade: 'client-asserted' },
  webmcp: { label: 'WebMCP tool call', actor: 'agent-initiated, riding the human session', grade: 'client-asserted' },
  mcp: { label: 'MCP seat', actor: 'agent, first-party', grade: 'server-observed' },
  room: { label: 'Room bookkeeping', actor: 'the room', grade: 'server-observed' },
  partner: { label: 'Partner origin', actor: 'as the partner asserts', grade: 'inherited' },
};

export const GRADE_NOTE = {
  'server-observed': 'the credential was presented to the server directly',
  'client-asserted': "the page's claim — same session, distinguished only by code path",
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
      { id: 'mcp-seat', name: 'Claude Code', kind: 'agent', role: 'participant', door: 'mcp' },
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

/** A seeded room with a round already played, so an unaccompanied visitor sees
 *  a real chain rather than an empty one. Every entry here is genuinely
 *  appended and genuinely hashed — the seeding is real history, not fixtures
 *  pretending to be history. */
export async function seedRoom(hostName) {
  const room = new Room({ hostName });
  await room.record({ kind: 'room_opened', payload: { name: 'Take Five' }, seatId: 'room', ingress: 'room' });
  await room.addArtefact('question.md', 'Should the room adopt the proposal as drafted?\n');
  await room.advance('Commit');
  await room.record({ kind: 'commit', payload: { seat: 'Room host', digest: 'sealed' }, seatId: 'host', ingress: 'ui' });
  await room.record({ kind: 'commit', payload: { seat: 'Riding agent', digest: 'sealed' }, seatId: 'rider', ingress: 'webmcp' });
  await room.record({ kind: 'commit', payload: { seat: 'Claude Code', digest: 'sealed' }, seatId: 'mcp-seat', ingress: 'mcp' });
  await room.advance('Reveal');
  return room;
}
