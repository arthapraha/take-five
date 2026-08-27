# Take Five

A governed room for humans and agents, built on [WebMCP](https://webmachinelearning.github.io/webmcp/).

Five phases — **Open · Commit · Reveal · Ruling · Closed** — where the phase you are in *is* the set of tools the page offers. Every act lands on an append-only, hash-chained ledger, and every ledger entry records not just *what* happened but *how we know who did it*.

## Why this exists

When an agent rides along in your browser session, its actions and yours land in the same audit scope. Existing tooling records one agent's actions for its operator. This records **acts between parties in a shared venue** — and labels each attribution with the evidence behind it, rather than claiming more certainty than the page actually has.

## Attribution, with honest grades

Every entry on the ledger carries three fields: **seat identity**, **ingress path**, and **evidence grade**. The interface never renders an attribution stronger than its grade.

| Ingress | Recorded as | Evidence grade |
|---|---|---|
| Web UI handler (a person clicking) | the human's seat | `client-asserted` |
| WebMCP tool call (an agent riding the session) | the human's seat, agent-initiated | `client-asserted` |
| MCP seat (an agent with its own credential) | the agent's own seat | `server-observed` |
| Room bookkeeping (hashing, phase records) | the room | `server-observed` |
| Partner origin via `exposedTo` | the partner's declared seat | `inherited` |

At the WebMCP door the human/agent distinction is real — UI handlers and registered `execute` callbacks are disjoint code paths — but it is the *page's* knowledge, not the server's. So it is recorded and labelled `client-asserted`. We record attribution durably; we do not claim to have cryptographically separated a rider from its session.

Signature schemes prove who authored a record; a neutral venue records what happened between parties. This scopes deliberately to the venue.

## Status

Early. Nothing here is stable.

## Licence

MIT — see [LICENSE](LICENSE).
