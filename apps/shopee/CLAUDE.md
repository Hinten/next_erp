# apps/shopee — CLAUDE.md

API-only Next.js app for the **Shopee Open Platform** sales channel. One App
Hosting backend per channel (ADR 0015), so its logs and deploy are isolated.
Runs on `:3009` in dev. Steps 1–2 of
`.master_plans/shopee/shopee-marketplace-integration.md` — **OAuth connect,
conta status and the access-token refresh**. No business call yet.

## What lives here

- `app/api/marketplace/shopee/oauth/start/route.ts` — authenticated (Bearer ID
  token → `PERM.integracao.write`); mints the signed `state`, **persists the
  attempt BEFORE returning the consent URL** (#821), and answers
  `{ authorizeUrl }`.
- `app/api/oauth/shopee/callback/route.ts` — the OAuth redirect target, **no
  Bearer** (it is a browser redirect from Shopee) → verify the state → **redeem
  the attempt** → exchange → persist. ⚠️ **#1034**: verifying the HMAC is not
  enough — it proves integrity, not freshness-of-use, so a captured `state`
  would otherwise be replayable for its whole 10-minute window and a replay
  OVERWRITES the account's credential. `shopeeOauthState.consume` is the anchor
  that makes it single-use; it runs BEFORE the exchange and fails as `bad_state`.
- `app/api/marketplace/shopee/conta/route.ts` — `PERM.integracao.read`. Reports
  the **two clocks** separately (see below).
- `app/api/health/route.ts` — `{ service: 'shopee' }`.
- `lib/shopee/env.ts` — the one place this app reads its **Shopee**
  configuration from the environment, and every read there is blank-guarded
  (`?.trim()` + a length check, never `??`) — the one exception is
  `shopeeSandbox()`, whose `=== '1'` treats a blank value as production by
  construction. ⚠️ It is **not** the app's only
  `process.env` reader: Firebase credentials are read in
  `lib/firebase/admin.ts` (a verbatim copy of the same singleton the six sibling
  channel apps carry, `??`-defaulted `FIREBASE_DATABASE_ID` included) and the
  CORS allow-list in `proxy.ts`. The blank-guard rule is enforceable precisely
  because it is scoped to the Shopee values.
- `lib/shopee/core/{shopee,credentialStore,tokenStore,respond,validationIssues}.ts`
  — the context loader (cached `integracao` doc, uncached credential,
  `getAccessToken` / `createShopClient`), the Firestore credential store, the
  error→HTTP mapper, and the Next-free Zod-path helper (step 3's functions bundle
  will reuse it).
- `lib/shopee/core/tokenStore.ts` — the leased access-token refresh (see **Token
  refresh** below). Its three transactions are inventoried in
  `packages/config-eslint/rules/firestore-transaction-inventory.test.js`, which
  is where the full race analysis lives.
- `lib/shopee/conta/{oauthState,shops,status}.ts` — the per-attempt record
  binding, the token-free connection oracle, and the conta wire shape.
- `scripts/oauth-url.ts` — dev-only: mints a consent URL without the web UI.
  **Never run by an agent** (root CLAUDE.md rule 8).

The platform-neutral Shopee core (signer, hosts, typed clients, wire schemas,
error taxonomy) lives in `@delfrance/integrations-shopee`. It holds no Firestore
and no `process.env`.

ℹ️ **No PKCE, and no flag for it.** Shopee's consent URL (`guide 20`, "Format A")
has five parameters and no `code_challenge` anywhere in the docs, so the stored
`codeVerifier` is permanently `null`. Do not add a `SHOPEE_PKCE_ENABLED` toggle:
a switch that pretends to turn on a mechanism the provider does not implement is
worse than its absence. The signed `state` is consequently the ONLY trust anchor
on the callback — the legacy Flutter app had none at all.

ℹ️ **Two clocks, never one.** The **authorization** (`expireTime`, 7–365 days) is
the seller's consent and is read WITHOUT a token via the Public-signed
`get_shops_by_partner`; the **access token** (`credencial.expiraEm`, ~4 hours) is
a refreshable detail. The legacy app rendered "Conectado" from the 4-hour one and
never read the other, so an authorization about to lapse looked identical to a
healthy conta until the day everything stopped. `conta` therefore answers
`connected: true` on a stale stored access token — and normally with `loja`
populated too, because the shop read goes through the token store and renews the
pair on its way in. `loja` degrades to `null` only when the renewal could not
happen: another instance holds the lease, or the grant itself is dead — and that
second case is reported as `credencial.renovacaoFalhou`, never as a 4xx, because
a 4xx would throw away the very clocks this route read WITHOUT a token.

## Token refresh (`lib/shopee/core/tokenStore.ts`, step 2)

`getOrRefreshAccessToken` is the ONLY way to obtain an access token. Reach it
through the context — `ctx.getAccessToken()`, or `ctx.createShopClient()`, which
hands the package a **function** so a token that lapses mid-batch is renewed
rather than replayed dead. Never read `access_token` off the document to sign a
call.

**Fast path first.** One uncached read of `credenciais/current`; if the stored
token outlives `REFRESH_SKEW_MS` it is returned with zero writes, zero
transactions and zero provider calls. That is the overwhelmingly common case and
it must stay free.

**Otherwise: a lease that EXPIRES.** ADR 0011 rejected pessimistic leases for
general writes and it is right to — the balanço lock is this repo's own example
of a lock that cannot expire. Token refresh is the one override, for one reason:
Shopee's refresh token is single-use and rotating, so two instances that both
spend it do not merely write twice, they can burn the pair. Firestore's OCC
cannot prevent that on its own, because OCC arbitrates the WRITE while the
expensive act — `POST /api/v2/auth/access_token/get` — happens between two of
them. So OCC excludes the two callers that read the same version, and the stored
lease excludes the caller arriving after one of them committed.

The constants, and the invariant that ties them (a test pins it):

| constant | value | |
|---|---|---|
| `REFRESH_POLL_BUDGET_MS` | `3_000` | how long a waiting caller polls before answering 503 |
| `REFRESH_POLL_INTERVAL_MS` | `250` | between re-reads while it waits |
| `REFRESH_LEASE_TTL_MS` | `30_000` | before anyone may take the lease over |
| `REFRESH_SKEW_MS` | `60_000` | a token with less life than this is renewed |

⚠️ **`BUDGET < TTL < SKEW`, and both inequalities are load-bearing.** TTL below
the skew means a crashed or hung refresher's lease expires while the old token is
still nominally alive, so the takeover lands inside the window the skew reserved
instead of after the conta has already stopped working (`shopeeCall` has no
timeout, so a hung fetch is the crash case by another name). Budget below the TTL
means a caller that waited out the whole budget and tries once more is still
refusing to steal a LIVE lease — it answers 503 and lets its caller retry.

The lease is **never renewed**: a lock that renews itself cannot expire, which is
exactly what made the legacy Flutter `isRefreshing` flag fatal. A corrupt lease
(a non-string owner, a non-finite expiry) reads as NO lease, so a half-written
document can never freeze an account.

**FAQ 144 vs the API page.** Shopee's refresh API page says a refresh token "can
be used once only"; Shopee's own FAQ 144 ("refresh_token Backup Plan") says a
used one stays valid for four more hours and, re-sent, returns the **same** new
pair. The two readings disagree and nothing published settles it, so the design
serves both. The commit guard is the seam: it re-reads the document inside its
transaction and compares the **stored `refresh_token` against the one we spent**
— an identity comparison, not a clock, so rule 7's cross-unit trap cannot apply.
If they differ, a newer pair landed (a re-consent, or another instance) and OURS
is dropped, the stored token returned. Under FAQ 144 that costs one wasted call;
under "once only" it is what stops a second write burning a live pair. The
release path does the mirror image: it adopts a newer stored pair **before** any
terminal verdict is written, so a `refresh_token_expired` answered about a token
that has since been replaced cannot disconnect a healthy conta.

⚠️ **The accepted residual is a crash between Shopee's answer and the commit.**
The pair we were handed is lost, and once the lease TTL elapses the next caller
re-sends the OLD refresh token: that heals under FAQ 144 and forces a re-consent
under "once only". Narrowing the window further would mean writing before the
provider answers, which is a worse trade. When it does happen the operator sees
`credencial.renovacaoFalhou` on the conta screen and reconnects.

**Not here:** the authorization-expiry sweep (the 7–365-day clock, P8) is
**step 3**, which creates the nested Cloud Functions codebase for the push
receiver anyway — an API-only App Hosting backend is the wrong place to grow a
scheduler.

## Rules specific to this app

1. **No UI code** beyond the placeholder root page. Thin route handlers.
2. **Auth is per-endpoint**: Firebase ID token (`verifyCaller`) for
   `/api/marketplace/shopee/*`; the signed OAuth `state` for the callback; (step
   3) the `Authorization` HMAC over `callback_url` + raw body for the push
   receiver. No Firebase Auth user sessions.
3. **All Firestore access via `@delfrance/data/admin/collections` handles** —
   raw `.collection()`/`.doc()`/`.collectionGroup()` is lint-banned (except the
   `lib/firebase/admin.ts` singleton).
4. **Secrets in Cloud Secret Manager** (`SHOPEE_PARTNER_KEY`,
   `SHOPEE_STATE_SECRET`). Never committed, and **never logged** — the partner
   key signs every call, and a `code` is a live credential until it is exchanged.
   A schema failure logs field PATHS, never the body: on the token endpoint that
   body IS the credential (#1015).
5. **CORS** is handled by `proxy.ts` (Next 16 middleware) for
   `/api/marketplace/*` only. The callback — and the future receiver — stay OUT
   of the matcher (no browser preflight).
6. **Two apps, ONE code path.** Staging uses the ERP System **test** app against
   the sandbox hosts (`SHOPEE_SANDBOX=1`); production reuses the **live legacy**
   application against the production hosts. The difference is credentials and
   env, never a branch in code. ⚠️ `SHOPEE_SANDBOX` is therefore **opt-in**
   (exactly `'1'`), the OPPOSITE polarity of `MELHOR_ENVIO_SANDBOX`: an unset
   value on a deployed backend must mean production.

## Dev

```bash
cd ../.. && cat .env.example .env.secrets.example > .env.local && cd apps/shopee   # ONE root template set (#730) — fill in
pnpm --filter @delfrance/shopee-app dev   # :3009
curl http://localhost:3009/api/health
```

Set `NEXT_PUBLIC_SHOPEE_URL=http://localhost:3009` so apps/web targets this app.

The `/canais/shopee/[id]` panel (step 21a) is the normal connect path —
**Conectar conta** starts the OAuth round trip from the browser. The script
below is now the headless fallback for when there is no web UI to click
through:

```bash
pnpm --filter @delfrance/shopee-app oauth:url --project <projectId> --integracao <integracaoId>
```

Open the printed URL, log in with the sandbox shop, and the browser lands on
`/canais/shopee/<id>?shopee=connected`. Opening the same URL twice must land on
`reason=bad_state` — that is the single-use attempt doing its job. On the test
app, leave the sandbox redirect-URL domain EMPTY (Shopee then validates nothing)
or register `localhost`.

## Deploy

Firebase App Hosting, own backend, root `apps/shopee`. Env + secrets via the
Firebase console / Secret Manager.

⚠️ An **ERP System** Shopee app has no console "Authorize" button, so
`oauth/start` (or the script above) is the only way to reach the consent page,
and the redirect URL's **domain** is registered per app in the Shopee console —
`https://<this-app>/api/oauth/shopee/callback`.

⚠️ **Static egress is a prerequisite, not a step here.** Shopee's IP allow-list
(master plan P2, option D: a VPC connector, a subnet, a firewall rule, a reserved
IP and a proxy VM) is migration-window infrastructure (root CLAUDE.md rule 8) —
see #1208 when that window is scheduled. `apphosting.yaml` carries no
`vpcAccess`, deliberately.
