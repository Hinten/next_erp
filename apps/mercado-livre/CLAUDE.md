# apps/mercado-livre

API-only Firebase **App Hosting** backend for the Mercado Livre sales-channel
integration — one deployable backend per channel (deploy/scale/failure
isolation, mirroring the legacy per-channel Cloud Run services). It **imports**
the channel logic from `packages/integrations/mercado-livre` (the library) and
hosts the channel's HTTP routes + a nested Cloud Functions codebase. Modeled on
`apps/melhor-envio` (App Hosting backend) + `apps/nfe` (nested `functions/`).

## Layout

- `app/api/health` — uptime check (no auth).
- `app/api/marketplace/mercado-livre/oauth/start` — **#291**: `PERM.integracao.write`-gated;
  mints a signed `state` and returns the ML consent URL (`channel.oauthFlow.start`).
- `app/api/oauth/mercado-livre/callback` — **#291**: public browser redirect target;
  the signed `state` is the only trust anchor → verify → exchange code → persist.
- `app/api/webhooks/mercado-livre` — **#290**: ML notification receiver (unauthenticated
  `topic`+`resource` callbacks — ML does NOT HMAC-sign; contrast Shopee); acks 200 fast.
- `lib/marketplace/mercadoLivre.ts` — resolves an `integracao` account into a
  `ChannelContext` (reads the admin-only `credenciais` store, #287) + the plugin channel.
- `lib/{auth,firebase,signatures}` — per-app copies of the shared helpers (each backend
  keeps its own so they deploy + log independently).
- `functions/` — the nested Cloud Functions codebase (deploy-artifact sub-build; see
  `functions/DEPLOY.md`). Covered by this app's typecheck/lint/test tasks.

## Status

This is the **template scaffold** (Phase 5 skeleton). The OAuth token exchange +
refresh and the webhook/functions processing are stubs (`MercadoLivreNotImplementedError`
/ TODOs) wired to the extended `MarketplaceChannel` contract (#288). The real ML
REST calls land with the per-channel port.

## Env

See `.env.example` + `apphosting.yaml`. App-wide ML app credentials
(`MERCADO_LIVRE_CLIENT_ID/SECRET`, `..._STATE_SECRET`) live in env / Secret
Manager — one registered ML app serves every connected account; the per-account
OAuth token lives in the admin-only `integracao/{id}/credenciais` subcollection.

Deploy of the App Hosting backend + the functions codebase is **manual and
coordinated** (CLAUDE.md critical rule #1). Functions deploy: `functions/DEPLOY.md`.
