# apps/melhor-envio — CLAUDE.md

API-only Next.js app for the **Melhor Envio** freight integration. Split out of
`apps/integrations` so its logs and deploy are isolated. Runs on `:3005` in dev;
deploys to its own Firebase App Hosting backend.

## What lives here

- `app/api/freight/melhor-envio/{oauth/start,calculate,conta,comprar,imprimir,rastrear}/route.ts`
  — authenticated (Bearer ID token → `PERM.frete`) routes the apps/web browser calls.
- `app/api/oauth/melhor-envio/callback/route.ts` — the OAuth redirect target (no
  Bearer; the signed `state` is the trust anchor).
- `app/api/webhooks/melhor-envio/route.ts` — ME status webhook (HMAC-signed; no Bearer).
- `lib/freight/*` — `loadMelhorEnvioContext`, the Firestore token store, the
  signed-state HMAC, and the error→HTTP mapper.

The platform-neutral ME core (OAuth/api/token-lifecycle/cart/buy pipeline) lives
in the shared package `@delfrance/integrations-freight-br`.

## Rules specific to this app

1. **No UI code** beyond the placeholder root page. Thin route handlers.
2. **Auth is per-endpoint**: Firebase ID token (`verifyCaller`) for the callable
   freight routes; signed OAuth `state` for the callback; HMAC `X-ME-Signature`
   for the webhook. No Firebase Auth user sessions.
3. **All Firestore access via `@delfrance/data/admin/collections` handles** —
   raw `.collection()`/`.doc()`/`.collectionGroup()` is lint-banned (except the
   `lib/firebase/admin.ts` singleton).
4. **Secrets in Cloud Secret Manager** (`MELHOR_ENVIO_CLIENT_SECRET`,
   `MELHOR_ENVIO_STATE_SECRET`). Never commit them.
5. **CORS** is handled by `proxy.ts` (Next 16 middleware) for `/api/freight/*`
   only. The callback + webhook stay OUT of the matcher (no browser preflight).

## Dev

```bash
cp .env.example ../../.env.local   # fill in (shared root .env.local)
pnpm --filter @delfrance/melhor-envio-app dev   # :3005
curl http://localhost:3005/api/health
```

Set `NEXT_PUBLIC_MELHOR_ENVIO_URL=http://localhost:3005` so apps/web's
`useFreightClient()` targets this app.

## Deploy

Firebase App Hosting, own backend (e.g. `melhor-envio-<org>`), root
`apps/melhor-envio`. Env + secrets via the Firebase console. The OAuth
`redirect_uri` registered in the Melhor Envio dashboard must point at this
backend: `https://<this-app>/api/oauth/melhor-envio/callback`.
