// Cloudflare Pages Function: the byte-identical reveal check, recomputed off
// the page.
//
// WHAT THIS PROVES, EXACTLY — stated here because the whole project is about
// not claiming more than you can show:
//
//   It proves the ARITHMETIC independently of the browser. The page cannot
//   report "matches" for a value that does not hash to the commitment, because
//   this recomputes the digest itself and returns what it computed.
//
//   It does NOT prove CUSTODY. This function does not hold the commitments; it
//   is handed one. A page that lied about which commitment it was checking
//   against would get an honest answer to a dishonest question.
//
//   Custody comes from the ledger, not from here: the commitment was sealed
//   onto the append-only chain before any position was visible, and that entry
//   is verifiable by anyone afterwards. The two together are what make a reveal
//   checkable — this function alone is not, and the receipt says so.
//
// That is why a reveal checked here is graded `server-observed` for the digest
// and still leans on the chain entry for the ordering claim.

const SEP = '|';

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }

  const { commitment, value, nonce } = body ?? {};
  for (const [k, v] of Object.entries({ commitment, value, nonce })) {
    if (typeof v !== 'string' || !v.length) {
      return json({ error: `"${k}" must be a non-empty string` }, 400);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(commitment)) {
    return json({ error: '"commitment" must be a 64-character hex SHA-256 digest' }, 400);
  }

  const recomputed = await sha256Hex(`${value}${SEP}${nonce}`);

  return json({
    matches: recomputed === commitment,
    commitment,
    recomputed,
    checked_by: 'pages-function',
    grade: 'server-observed',
    scope: 'digest recomputed off-page; ordering rests on the chain entry, not on this check',
  });
}

export async function onRequestGet() {
  return json({ error: 'POST a commitment, value and nonce' }, 405);
}
