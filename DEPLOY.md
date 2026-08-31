# Deploying to Cloudflare Pages

**This is already connected.** The one-time step below was completed on
2026-08-27; every push to `main` has deployed on its own since. The section is
kept because it is the record of how the project is configured, and because it
is what a rebuild would follow.

| | |
|---|---|
| Pages project | **`take-five-lw7`** |
| Room | https://take-five-lw7.pages.dev |
| Partner origin | https://partner.take-five-lw7.pages.dev |

**The `-lw7` suffix is load-bearing, not noise.** Cloudflare appended it because
the project name `take-five` was already taken — by a stranger, whose
`take-five.pages.dev` returns 200 and serves SEO filler. `PARTNER_ORIGIN` in
`src/tools.js` reads `partner.take-five-lw7.pages.dev` for that reason.
Misreading the suffix as cosmetic is how the allowlist once named a hostname we
do not own — `exposedTo` is an allowlist, so that was an authorisation handed to
an origin a stranger could have claimed by pushing a branch.

The executor cannot do the connection step. There are no Cloudflare credentials
on the build host, and asking for an API token would mean handling a credential
— so the first connection is done by the account owner in the dashboard, once.

## One-time connection

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
2. Authorise the Cloudflare GitHub app **for this repository specifically**.
   `arthapraha/take-five` is private, so it will not appear in the list until
   the app is granted access to it.
3. Pick `arthapraha/take-five`, production branch `main`.

## Build settings

| Setting | Value |
|---|---|
| Framework preset | Vite (or None — the settings below are what matter) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | *(leave empty)* |

Add one environment variable, or the build will run on a Node too old for
Vite 7:

| Variable | Value |
|---|---|
| `NODE_VERSION` | `22` |

## Functions

`functions/api/check-reveal.js` is picked up automatically — Pages maps the
`functions/` directory to routes, so it is served at `/api/check-reveal` with no
configuration. There is nothing to register and no `wrangler.toml` needed for
this shape.

You can confirm it after the first deploy:

```bash
curl -s -X POST https://take-five-lw7.pages.dev/api/check-reveal \
  -H 'content-type: application/json' \
  -d '{"commitment":"0000000000000000000000000000000000000000000000000000000000000000","value":"x","nonce":"y"}'
```

It should return JSON with `matches: false` and the digest it actually
computed. If it returns HTML instead, the function was not picked up.

**Until it deploys, the reveal check falls back to running in the page — and
says so.** It grades itself down from `server-observed` to `client-asserted`
and states the reason in its own output, so a demo running without the function
is visibly weaker rather than quietly identical.

## The partner origin

The `inherited` grade needs an origin that is **not this one**, and Cloudflare
preview deployments give us one for free: Pages serves every branch at
`<branch>.<project>.pages.dev`. The branch `partner` is deployed, so
`partner.take-five-lw7.pages.dev` is a genuinely distinct origin that we own.

It is the same codebase — `vite.config.js` has two entry points and the branch
carries no diff from `main`. Keeping it in step is one push:

```bash
git push origin main:partner
```

Two independent gates have to be open for a cross-origin call to land, and they
fail differently:

- **Permissions Policy.** WebMCP is gated behind the feature name `tools`, and a
  cross-origin frame does not inherit it. The embedder delegates it with
  `frame.allow = 'tools'`. Denied, you get `NotAllowedError`.
- **`exposedTo`.** The room allowlists the partner origin by name. Not on the
  list, the partner's `getTools({fromOrigins})` query simply returns without
  `partner_attest` — no error, nothing.

**The `frame.allow = 'tools'` delegation is sufficient on its own.** No
`Permissions-Policy` response header is needed. Settled by running it: the
`inherited` row was produced live on **2026-08-31, Chrome 151 with the WebMCP
testing flags enabled** — chip reading `cross-origin: exposed to
https://partner.take-five-lw7.pages.dev`, chain entry #4 `partner_attestation`
(`Partner origin via partner — inherited`), followed by #5 `tool:partner_attest`.
The two gates are documented above because they fail differently and the next
person to debug this will need to know which one is shut, not because either is
still open.

Scope of that result: Chrome behind *testing* flags. It evidences the mechanism,
not general availability — ChatGPT's in-app browser implements an unenumerated
subset and this path is untested there.

## Before the repo goes public

**Both gates are cleared. Nothing blocks the flip.**

1. **The patent decision — closed 31 August: no patent.** Publishing is the
   disclosure event, so this gated the flip and nothing else did. Decided
   against filing on the prior-art scan: the design is an assembly of well-known
   parts, and WebMCP's own proposal is written prior art on the core use case.

   The decision is not a retreat from protection, it is a different protection.
   **Publishing under MIT and describing the mechanism publicly is itself the
   protective act:** it puts the mechanism in the prior art, where nobody else
   can file against it. Worth knowing before anyone reads "no patent" here and
   assumes the question was dropped rather than answered.
2. **The two-minute name check on `take-five` — done 30 August, clear.** Worth
   recording what it found: `take-five.pages.dev` is a stranger's, which is why
   the Pages project is `take-five-lw7`.

The MIT licence is already in the first commit, so flipping visibility is a
single switch and GitHub's licence detector picks it up immediately — which is
what the challenge rules require in the repository's About section.

## Judging availability

The rules require the live URL to stay reachable, free and unrestricted, until
judging ends — **21 September, 5 p.m. PT**, about three and a half weeks after
submission closes. Cloudflare Pages' free tier covers this; the thing to avoid
is deleting the project after submitting.
