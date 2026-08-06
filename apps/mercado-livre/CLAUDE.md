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
- `app/api/marketplace/mercado-livre/conta` — `PERM.integracao.read`-gated connection
  status (`/users/me` identity, or `connected: false` when the credential is dead).
- `app/api/oauth/mercado-livre/callback` — **#291**: public browser redirect target;
  the signed `state` is the only trust anchor → verify → exchange code → persist.
- `app/api/webhooks/mercado-livre` — **#290**: ML notification receiver (`topic`+`resource`
  callbacks — ML does NOT HMAC-sign; contrast Shopee); validates + enqueues onto the
  `processMercadoLivreNotification` Cloud Tasks queue and acks 200 fast (no Firestore
  write on the happy path — see `lib/marketplace/mlTasks.ts` + `functions/DEPLOY.md`).
- `lib/marketplace/webhookOrigin.ts` — **#811**: the receiver's only inbound origin check.
  There is no signature to verify (confirmed against the 03/08/2026 Notificações reference:
  no `x-signature`, no manifest, no shared secret — the `ts=…,v1=…` scheme people find is
  **Mercado Pago**), so this is a `application_id` comparison against `MERCADO_LIVRE_CLIENT_ID`
  (foreign ⇒ 403 before any enqueue or write) plus `logWebhookHeaders`, a self-silencing
  header-name inventory that settles the signature question empirically during the migration
  window. It fails OPEN when unconfigured or when `application_id` is absent — a misconfigured
  backend must not be able to stall the stream, since ML disables a topic after ~1h of non-200.
  ML's published notification source IPs were considered and **declined** (an undocumented
  rotation would reject every genuine notification). Follow-up if the logs show no signature
  header: a secret path segment on the registered callback URL.
- `lib/marketplace/notificacao.ts` — this channel's webhook adapter: `parseNotificationBody`,
  the dispatch-by-topic `processNotificationPayload`, and a `defineNotificationPipeline({...})`
  binding. The resilience behaviour (retry disposition, failures-only persistence, the
  durable-cursor sweep) is the SHARED core in `@delfrance/data/admin/notifications` — see the
  `webhook-notifications` skill. This channel is the one that needs a PHASE-aware
  `toDisposition` (an unparseable `resource` drops in the task but parks in the sweep).
- `lib/marketplace/mercadoLivre.ts` — resolves an `integracao` account into a
  `ChannelContext` (newest valid token or a concurrency-safe refresh) + the plugin channel.
- `lib/marketplace/tokenStore.ts` — the durable-token store over the admin-only
  `integracao/{id}/tokenDuravel` subcollection (the OLD Flutter wire shape, shared with
  the still-running Flutter app during the dual-run migration; "one wins" refresh).
- `lib/{auth,firebase,signatures}` — per-app copies of the shared helpers (each backend
  keeps its own so they deploy + log independently).
- `functions/` — the nested Cloud Functions codebase (deploy-artifact sub-build; see
  `functions/DEPLOY.md`). Covered by this app's typecheck/lint/test tasks.

## Status

OAuth connect is **live**: code exchange + persistence (tokenDuravel) + the
concurrency-safe refresh + the conta status route all work; apps/web's
`/canais/mercado-livre` UI drives them. The webhook receiver enqueues onto the
`processMercadoLivreNotification` Cloud Tasks queue (Step 6 resilience
foundation) + an `onSchedule` reprocess sweep; the per-topic handlers (order /
payment / shipment / stock / price / claim) are no-ops until their import/order
milestones of the ML port plan.

## Env

See the repo-root `.env.example` (Mercado Livre section; the OAuth client SECRET and
the state HMAC key are in `.env.secrets.example` — one root template set is the
repo convention, #730) + `apphosting.yaml`. App-wide ML app credentials
(`MERCADO_LIVRE_CLIENT_ID/SECRET`, `..._STATE_SECRET`) live in env / Secret
Manager — one registered ML app serves every connected account (so
`MERCADO_LIVRE_CLIENT_ID` is also the `application_id` every notification carries,
which is what the webhook origin check compares against). The optional
`MERCADO_LIVRE_WEBHOOK_LOG_HEADERS` is a plain env var, not a secret. The per-account
OAuth token lives in the admin-only `integracao/{id}/tokenDuravel` subcollection
(shared with the Flutter app during the dual-run migration; the move to the
encrypted `credenciais` store is a tracked post-migration follow-up).

Deploy of the App Hosting backend + the functions codebase is **manual and
coordinated** — see root `CLAUDE.md`, Critical rules. Functions deploy: `functions/DEPLOY.md`.
