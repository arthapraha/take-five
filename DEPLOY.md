# Deploying to Cloudflare Pages

The executor cannot do this step. There are no Cloudflare credentials on the
build host, and asking for an API token would mean handling a credential — so
the first connection is done by the account owner in the dashboard, once. After
that every push to `main` deploys on its own and nothing further is needed.

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
curl -s -X POST https://<your-pages-url>/api/check-reveal \
  -H 'content-type: application/json' \
  -d '{"commitment":"0000000000000000000000000000000000000000000000000000000000000000","value":"x","nonce":"y"}'
```

It should return JSON with `matches: false` and the digest it actually
computed. If it returns HTML instead, the function was not picked up.

**Until it deploys, the reveal check falls back to running in the page — and
says so.** It grades itself down from `server-observed` to `client-asserted`
and states the reason in its own output, so a demo running without the function
is visibly weaker rather than quietly identical.

## Before the repo goes public

Two things, in this order:

1. The patent conversation concludes (30 Aug checkpoint). Publishing is the
   disclosure event; there is no undoing it.
2. The two-minute name check on `take-five`, per the room rule that no name
   goes public without one.

The MIT licence is already in the first commit, so flipping visibility is a
single switch and GitHub's licence detector picks it up immediately — which is
what the challenge rules require in the repository's About section.

## Judging availability

The rules require the live URL to stay reachable, free and unrestricted, until
judging ends — **21 September, 5 p.m. PT**, about three and a half weeks after
submission closes. Cloudflare Pages' free tier covers this; the thing to avoid
is deleting the project after submitting.
