# Take Five

A governed room for humans and agents, built on [WebMCP](https://webmachinelearning.github.io/webmcp/).

Five phases — **Open · Commit · Reveal · Ruling · Closed** — where the phase you are in *is* the set of tools the page offers. Every act lands on an append-only, hash-chained ledger, and every ledger entry records not just *what* happened but *how we know who did it*.

## Why this exists

When an agent rides along in your browser session, its actions and yours land in the same audit scope. Existing tooling records one agent's actions for its operator. This records **acts between parties in a shared venue** — and labels each attribution with the evidence behind it, rather than claiming more certainty than the page actually has.

## Attribution, with honest grades

Every entry on the ledger carries three fields: **seat identity**, **ingress path**, and **evidence grade**. The interface never renders an attribution stronger than its grade.

| Ingress | Recorded as | Evidence grade |
|---|---|---|
| Web UI handler (a click on the page — by a person, or by an agent driving it) | the human's seat | `client-asserted` |
| WebMCP tool call (an agent riding the session) | the human's seat, agent-initiated | `client-asserted` |
| MCP seat (an agent with its own credential) | the agent's own seat | `server-observed` |
| Room bookkeeping (hashing, phase records) | the room | `server-observed` |
| Partner origin via `exposedTo` | the partner's declared seat | `inherited` |

At the WebMCP door, UI handlers and registered `execute` callbacks are disjoint code paths — so the record can say **how an act arrived**. It cannot say **who caused it**: an agent driving the page can take the UI path as readily as a person can. We tested this rather than assumed it, and an agent resolved a confirmation dialog in this demo with nobody's hand on the keyboard.

So `client-asserted` means what it says: the page's claim, same session, distinguished only by code path. **The ingress field is evidence about the route, not about the actor.** We record attribution durably and grade it honestly; we do not claim to have separated a rider from its session, and this build demonstrates that an in-page dialog cannot do it either.

**There is currently no way to build a human-only gate here.** The primitive intended for it, `requestUserInteraction()`, is absent from every environment we tested — the polyfill, Chrome behind the WebMCP flag, and ChatGPT's in-app browser. Until it exists, a page cannot require a human, and any product claiming otherwise is describing a convention rather than a control.

Signature schemes prove who authored a record; a neutral venue records what happened between parties. This scopes deliberately to the venue.

## Status

Early. Nothing here is stable.

## Licence

MIT — see [LICENSE](LICENSE).
