# Take Five

A governed room for humans and agents, built on [WebMCP](https://webmachinelearning.github.io/webmcp/).

**Try it:** https://take-five-lw7.pages.dev/ — in ChatGPT's in-app browser, or in
Chrome with its WebMCP flags enabled (we tested on 152). Judges' testing instructions, including the optional
bring-your-own-agent path through the local bridge and the **Take Five Agent**
Chrome extension, are on the Devpost submission page.

Five phases — **Open · Commit · Reveal · Ruling · Closed** — where the phase you are in *is* the set of tools the page offers. Every act lands on an append-only, hash-chained ledger, and every ledger entry records not just *what* happened but *how we know who did it*.

## Why this exists

When an agent rides along in your browser session, its actions and yours land in the same audit scope. Existing tooling records one agent's actions for its operator. This records **acts between parties in a shared venue** — and labels each attribution with the evidence behind it, rather than claiming more certainty than the page actually has.

## Attribution, with honest grades

Every entry on the ledger carries three fields: **seat identity**, **ingress path**, and **evidence grade**. The interface never renders an attribution stronger than its grade.

| Ingress | Recorded as | Evidence grade |
|---|---|---|
| Web UI handler (a click on the page — by a person, or by an agent driving it) | the human's seat | `client-asserted` |
| WebMCP tool call (an agent riding the session) | the human's seat, agent-initiated | `client-asserted` |
| MCP seat (an agent with its own credential) † | the agent's own seat | `server-observed` |
| Room bookkeeping (hashing, phase records) | the room | `server-observed` |
| Partner origin via `exposedTo` | the partner's declared seat | `inherited` |

† **The MCP door is defined but not exercised in this build.** No tool in Take Five records through it, so the `Credentialed agent` seat sits in the roster without ever acting. It is here because the table is an argument about *what a door can establish*, and that argument needs the case where a credential reaches the server directly — but a row the demo cannot fill is a promise, not a demonstration. Room bookkeeping produces the `server-observed` rows you can actually see. Scoped as future work rather than quietly listed alongside the four that work.

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

`npm test` runs the suite on `node:test` — no runner, most of it on the failure side. `npm run build` emits to `dist/`.

The room is **per-visitor and in-memory**. A reload is a fresh chain, whoever opens the page holds the host role, and there is no server state and no database. That is deliberate: a visitor is the host of their own room and can walk the whole flow without any act from us.

### What the polyfill cannot give you

Two things need a browser that ships WebMCP natively — ChatGPT's in-app browser, or Chrome with its WebMCP flags enabled in `chrome://flags` (the search returns two — `#enable-webmcp-testing` and `#devtools-webmcp-support`; enable both; we tested on 151 and 152):

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

## Take Five Agent on any tab (the extension-carried bridge)

Since t-4202 the panel carries the page side of the bridge itself, so the
public page never names a loopback address and its URL carries no token. In
the panel's Connection box: Relay URL and Relay token, then **Attach this
tab**. First click the Take Five Agent icon on the tab you mean — that is the
grant, for that one tab, for as long as it stays on that page — then Attach.

What happens, in order: the panel probes the relay (token and one-page rule
checked, nothing changed); only then is the page told hello; on a Take Five
page the door is recorded on the chain — `bridge_opened`, `transport:
extension` — and only after that record does the page list its tools or
serve a call. The list is the page's own offered set (read surface plus the
current phase), so `partner_attest` is refused through this door exactly as
through `?bridge=`. On any other WebMCP page there is no chain: the panel says
so, and the page's tools are listed as registered.

Two things to know, once. Any script in the attached tab can speak both
directions of the message pipe between the injected script and the panel; the
trust boundary is your choice of tab, the token never entering the page, and
the relay minting every call id. And a relay serves one origin, so the
`?bridge=` door and the extension door cannot share a relay — not both at once;
start a second relay on another port if you need both.

A reload ends it: the injected script dies with the document, the pipe's port
drops, and the panel closes the bridge — attach again, and the fresh page
records a fresh door. The injected script itself does three things — list,
execute, ack — and reads one attribute (`data-take-five`) to know whether it
must wait for a chain; it never sees the token, only its fingerprint.

Permissions, each with its reason: `activeTab` — the one tab the owner
clicked the icon on; `scripting` — to inject into exactly that tab, exactly
when Attach is clicked. No `tabs`, no `<all_urls>`, and no `host_permissions`:
the relay is reached from the panel page over ordinary CORS, as t-70a1
measured for the local agent; widening is a claim to measure, not assume.
Because the caller is now the panel, the relay's one served origin is the
panel's: start the local agent with `--origin chrome-extension://<id>` (the
id the panel shows) alongside `--extension-origin` set to the same value.
