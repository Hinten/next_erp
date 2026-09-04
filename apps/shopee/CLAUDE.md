# apps/shopee — CLAUDE.md

API-only Next.js app for the **Shopee Open Platform** sales channel. One App
Hosting backend per channel (ADR 0015), so its logs and deploy are isolated.
Runs on `:3009` in dev. Step 1 of
`.master_plans/shopee/shopee-marketplace-integration.md` — **OAuth connect and
conta status only**.

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
- `lib/shopee/env.ts` — the ONE place this app reads `process.env`. Every read is
  blank-guarded (`?.trim()` + a length check, never `??`).
- `lib/shopee/core/{shopee,credentialStore,respond,validationIssues}.ts` — the
  context loader (cached `integracao` doc, uncached credential), the Firestore
  credential store, the error→HTTP mapper, and the Next-free Zod-path helper
  (step 3's functions bundle will reuse it).
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
`connected: true` on an expired access token, and degrades `loja` to `null`
rather than failing.

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

Set `NEXT_PUBLIC_SHOPEE_URL=http://localhost:3009` so apps/web targets this app
once step 21 adds the panel.

The connect round trip, without a web UI:

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
