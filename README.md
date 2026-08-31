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

## Running it

```bash
npm install
npm run dev
```

Open the URL Vite prints. The five phases, the chain, the ledger and the grade table all work in any modern browser: `@mcp-b/webmcp-polyfill` installs `document.modelContext` at load, so the agent surface exists even where the browser does not ship WebMCP natively.

`npm test` runs the suite — 26 tests on `node:test`, no runner, most of them on the failure side. `npm run build` emits to `dist/`.

The room is **per-visitor and in-memory**. A reload is a fresh chain, whoever opens the page holds the host role, and there is no server state and no database. That is deliberate: a visitor is the host of their own room and can walk the whole flow without any act from us.

### What the polyfill cannot give you

Two things need a browser that ships WebMCP natively — ChatGPT's in-app browser, or Chrome 149+ with `chrome://flags` set for WebMCP (the search returns more than one flag; enable them):

- **An agent to call the tools.** The polyfill registers the surface; it does not provide a client. Without one you can still drive `document.modelContext` from the console.
- **Cross-origin exposure.** `exposedTo` throws `NotSupportedError` in the polyfill. The page says so in its own status chip rather than degrading quietly, and makes no cross-org claim it cannot back.

### The cross-origin partner, locally

The `inherited` grade needs a second origin — but not a deployment. Origin is scheme + host + port, so two local ports are as cross-origin as two domains. In two shells:

```bash
npm run dev -- --port 5177
```

```bash
npm run dev -- --port 5178
```

Then open `http://localhost:5177/?partner=http://localhost:5178` and press **Invite a partner attestation**. The `?partner=` override exists for exactly this; without it the room looks for its deployed partner origin.

## How this was built

Take Five was built with AI pair-execution under the owner's direction — **every commit in this repository, not some of them.** The scope rulings, the design decisions and the choice of what to claim are the owner's; the implementation and much of the prose were written in that collaboration.

The findings this project reports about WebMCP were produced by building it rather than by reading about it — including the one that falsified a sentence in this README, and a chain fork found by an agent reading the room's own ledger.

## Status

Early. Nothing here is stable.

## Licence

MIT — see [LICENSE](LICENSE).
