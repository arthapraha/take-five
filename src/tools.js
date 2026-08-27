// The always-registered read surface.
//
// All five are `readOnlyHint: true` and stay registered in every phase — a
// visitor who can only read still sees the whole record, which is what makes
// the deployed demo experienceable by an unaccompanied judge.
//
// Every output is windowed to OUTPUT_BUDGET. The budget is enforced here, once,
// rather than trusted to each tool: an agent that silently receives a truncated
// ledger and reasons over it as if complete is a worse failure than a refusal,
// so truncation always says so in the text and reports what was left out.

const OUTPUT_BUDGET = 1500;

function text(s) {
  const body = s.length <= OUTPUT_BUDGET
    ? s
    : `${s.slice(0, OUTPUT_BUDGET - 90)}\n… truncated at ${OUTPUT_BUDGET} chars — ${s.length - OUTPUT_BUDGET + 90} more. Narrow the window and call again.`;
  return { content: [{ type: 'text', text: body }] };
}

const short = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`;

export function buildTools(room, { onCall } = {}) {
  const announce = (name) => { if (onCall) onCall(name); };

  return [
    {
      name: 'list_seats',
      title: 'List seats',
      description: 'Who is at the table, which door each one speaks through, and what that door lets the record claim about them.',
      annotations: { readOnlyHint: true },
      execute: () => {
        announce('list_seats');
        const lines = room.seats.map((s) => `- ${s.name} — ${s.kind}, ${s.role}, door: ${s.door}`);
        return text(`${room.seats.length} seats in "Take Five":\n${lines.join('\n')}`);
      },
    },
    {
      name: 'current_phase',
      title: 'Current phase',
      description: 'Which of the five phases the room is in: Open, Commit, Reveal, Ruling, Closed. The phase determines which tools exist.',
      annotations: { readOnlyHint: true },
      execute: () => {
        announce('current_phase');
        return text(
          `Phase: ${room.phase}\n` +
          `Ledger: ${room.ledger.length} entries, tip ${short(room.ledger.tip)}\n` +
          `Phase advances are explicit acts by the host seat. No timers.`,
        );
      },
    },
    {
      name: 'read_ledger',
      title: 'Read the ledger',
      description: 'Read entries from the append-only chain, oldest first from a cursor. Each entry carries seat, ingress path and evidence grade.',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: { type: 'number', description: 'Sequence number to start from (1-based, default 1).' },
          limit: { type: 'number', description: 'How many entries to return (default 5, max 20).' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: ({ cursor = 1, limit = 5 } = {}) => {
        announce('read_ledger');
        const n = Math.min(Math.max(1, Number(limit) || 5), 20);
        const from = Math.max(1, Number(cursor) || 1);
        const all = room.ledger.entries;
        const slice = all.slice(from - 1, from - 1 + n);
        if (!slice.length) return text(`No entries at cursor ${from}. Ledger holds ${all.length}.`);
        const lines = slice.map(
          (e) => `#${e.seq} ${e.kind} — ${e.actor.seat} via ${e.actor.ingress} [${e.actor.grade}]\n   ${short(e.hash)} prev ${short(e.prev)}`,
        );
        const next = from + slice.length;
        return text(
          `Entries ${from}–${from + slice.length - 1} of ${all.length}:\n${lines.join('\n')}\n` +
          (next <= all.length ? `Next cursor: ${next}` : 'End of ledger.'),
        );
      },
    },
    {
      name: 'get_artefact',
      title: 'Get an artefact',
      description: 'Fetch an artefact by its SHA-256 hash. The hash is the identity: what you get back is what was hashed.',
      inputSchema: {
        type: 'object',
        properties: { hash: { type: 'string', description: 'Full SHA-256 hex digest.' } },
        required: ['hash'],
      },
      annotations: { readOnlyHint: true },
      execute: ({ hash } = {}) => {
        announce('get_artefact');
        const a = room.artefacts.get(hash);
        if (!a) {
          const known = [...room.artefacts.values()].map((x) => `${x.name} ${short(x.hash)}`).join(', ');
          return text(`No artefact ${hash ? short(hash) : '(none given)'}.\nHeld: ${known || 'none'}`);
        }
        return text(`${a.name} — ${a.bytes} bytes, ${short(a.hash)}\n\n${a.text}`);
      },
    },
    {
      name: 'verify_receipt',
      title: 'Verify a receipt',
      description: 'Recompute an entry\'s hash from its own content and check it links to its predecessor. Verification runs in the browser; nothing is taken on trust.',
      inputSchema: {
        type: 'object',
        properties: { hash: { type: 'string', description: 'Full SHA-256 hex digest of the ledger entry.' } },
        required: ['hash'],
      },
      annotations: { readOnlyHint: true },
      execute: async ({ hash } = {}) => {
        announce('verify_receipt');
        const r = await room.ledger.verifyEntry(hash ?? '');
        if (!r.found) return text(`No entry with hash ${hash ? short(hash) : '(none given)'}.`);
        const ok = r.content_matches_hash && r.links_to_predecessor;
        return text(
          `Entry #${r.seq} — ${ok ? 'VERIFIED' : 'FAILED'}\n` +
          `content matches its hash: ${r.content_matches_hash}\n` +
          `links to predecessor:     ${r.links_to_predecessor}\n` +
          `attributed to: ${r.actor.seat} via ${r.actor.ingress}\n` +
          `evidence grade: ${r.actor.grade} — this is how well the record knows, not how certain it sounds.`,
        );
      },
    },
  ];
}

/** Register the read surface. Returns an AbortController: aborting it
 *  unregisters every tool at once, which is the same mechanism the
 *  phase-scoped tools will use in stage 2. */
export async function registerReadSurface(room, opts) {
  const mc = document.modelContext;
  if (!mc) return { ok: false, reason: 'no document.modelContext in this browser' };
  const controller = new AbortController();
  const tools = buildTools(room, opts);
  for (const tool of tools) {
    await mc.registerTool(tool, { signal: controller.signal });
  }
  return { ok: true, controller, names: tools.map((t) => t.name) };
}

export { OUTPUT_BUDGET };
