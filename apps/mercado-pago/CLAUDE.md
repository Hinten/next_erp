# apps/mercado-pago

API-only Firebase **App Hosting** backend for the Mercado Pago payments
integration — one deployable backend per channel (deploy/scale/failure
isolation, mirroring the legacy per-channel Cloud Run services). It **imports**
the payment logic from `packages/integrations/mercado-pago` (the library) and
hosts the channel's HTTP routes. Modeled on `apps/mercado-livre` +
`apps/melhor-envio` (App Hosting backends), adapted marketplace → payments.

## Layout

- `app/api/health` — uptime check (no auth).
- `app/api/payments/mercado-pago/oauth/start` — `PERM.metodoPagamento.write`-gated;
  mints a signed `state` and returns the MP consent URL (`ctx.authorizeUrl(state)`).
- `app/api/payments/mercado-pago/conta` — `PERM.metodoPagamento.read`-gated connection
  status (`/users/me` identity, or `connected: false` when the credential is dead).
- `app/api/oauth/mercado-pago/callback` — public browser redirect target; the signed
  `state` is the only trust anchor → verify → exchange code → persist.
- `lib/payments/mercadoPago.ts` — resolves a `metodo_pgto` account into a context
  (the consent URL, a refresh-on-expiry `resolveAccessToken`, and `exchangeAndPersist`).
- `lib/payments/credentialStore.ts` — the single-token store over the admin-only
  `metodo_pgto/{id}/credenciais` subcollection (fixed `current` doc; strays deleted
  on save). Mirrors apps/melhor-envio's `tokenStore`.
- `lib/payments/state.ts` — the signed-state HMAC (`MERCADO_PAGO_STATE_SECRET`, 10-min TTL).
- `lib/payments/respond.ts` — the error → HTTP mapper.
- `lib/{auth,firebase}` — per-app copies of the shared helpers (each backend keeps
  its own so they deploy + log independently).

## Rules specific to this app

1. **No UI code** beyond the placeholder root page. Thin route handlers.
2. **Auth is per-endpoint**: Firebase ID token (`verifyCaller`) for the callable
   `/api/payments/*` routes; signed OAuth `state` for the callback. No Firebase
   Auth user sessions.
3. **All Firestore access via `@delfrance/data/admin/collections` handles** —
   raw `.collection()`/`.doc()`/`.collectionGroup()` is lint-banned (except the
   `lib/firebase/admin.ts` singleton).
4. **The `client_secret` + access/refresh tokens never reach the browser** — the
   authorization-code exchange and token refresh run server-side only. The
   per-account OAuth token lives in the admin-only `metodo_pgto/{id}/credenciais`
   subcollection (default-deny; only the Admin SDK reaches it).
5. **CORS** is handled by `proxy.ts` (Next 16 middleware) for `/api/payments/*`
   only. The callback stays OUT of the matcher (no browser preflight).

## Status

OAuth connect is **live**: code exchange + persistence (single-token
`credenciais`) + the refresh-on-expiry + the conta status route all work. The
MP payment-link tab (#367) and the webhook reconciler (#531) build on top of
this account/token foundation in later PRs; a nested Cloud Functions codebase
lands with them (not here yet).

## Env

See `.env.example` + `apphosting.yaml`. App-wide MP app credentials
(`MERCADO_PAGO_CLIENT_ID/SECRET`, `..._STATE_SECRET`) live in env / Cloud Secret
Manager — one registered MP app serves every connected account; the per-account
OAuth token lives in the admin-only `metodo_pgto/{id}/credenciais` subcollection.

Set `NEXT_PUBLIC_MERCADO_PAGO_URL=http://localhost:3007` so apps/web targets
this backend. The OAuth `redirect_uri` registered in the Mercado Pago dashboard
must point at this backend: `https://<this-app>/api/oauth/mercado-pago/callback`.

Deploy of the App Hosting backend is **manual and coordinated** (CLAUDE.md
critical rule #1).
