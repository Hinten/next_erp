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
  **#821**: it also RECORDS the attempt (`putOauthState`) before handing out the URL —
  the state's `nonce` plus, when `MERCADO_LIVRE_PKCE_ENABLED=1`, a fresh PKCE
  `code_verifier` whose S256 challenge rides the consent URL.
- `app/api/marketplace/mercado-livre/conta` — `PERM.integracao.read`-gated connection
  status (`/users/me` identity, or `connected: false` when the credential is dead).
- `app/api/oauth/mercado-livre/callback` — **#291**: public browser redirect target;
  the signed `state` is the only trust anchor → verify → **redeem the attempt** →
  exchange code → persist. ⚠️ **#821/T3**: verifying the HMAC is not enough — it proves
  integrity, not freshness-of-use, so a captured `state` used to be replayable for the
  whole 10-minute window and a replay OVERWROTE the account's credential with whoever
  drove the second callback. `consumeOauthState` is the anchor that makes it single-use;
  it runs BEFORE the exchange and its failure is `reason=bad_state`, never `exchange`.
- `app/api/webhooks/mercado-livre` — **#290**: ML notification receiver (`topic`+`resource`
  callbacks — ML does NOT HMAC-sign; contrast Shopee); validates + enqueues onto the
  `processMercadoLivreNotification` Cloud Tasks queue and acks 200 fast (no Firestore
  write on the happy path — see `lib/marketplace/mlTasks.ts` + `functions/DEPLOY.md`).
- `lib/marketplace/webhookOrigin.ts` — **#811**: the receiver's only inbound origin check.
  There is no signature to verify (confirmed against the 03/08/2026 Notificações reference:
  no `x-signature`, no manifest, no shared secret — the `ts=…,v1=…` scheme people find is
  **Mercado Pago**), so this is an `application_id` comparison against `MERCADO_LIVRE_CLIENT_ID`
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
  It is also the channel that motivated the **DEFERRED lane** (#808): a notification whose
  seller has not connected their account is `defer`, not `fail`, so it leaves the hourly pool
  entirely, is re-driven once a DAY for `MAX_TENTATIVAS_DEFERRED` days, and is pulled back into
  the hot lane by `redriveDeferredForUserId` the moment `onIntegracaoMercadoLivreChanged` sees
  that seller's `user_id` land on an active integração. As `fail` it parked terminally ~6h in,
  so a seller connecting the next business day lost the whole backlog. ⚠️ The re-drive query
  needs the `(status, user_id)` composite index — `notificationGuardrails.test.ts` guard C does
  NOT cover it (it only checks `(status, processedAt)`); the assertion in
  `notificacao.test.ts` is its only cover.
- `lib/marketplace/mercadoLivre.ts` — resolves an `integracao` account into a
  `ChannelContext` (newest valid token or a concurrency-safe refresh) + the plugin channel.
- `lib/marketplace/tokenStore.ts` — the durable-token store over the admin-only
  `integracao/{id}/tokenDuravel` subcollection (the OLD Flutter wire shape, shared with
  the still-running Flutter app during the dual-run migration; "one wins" refresh).
- `lib/marketplace/{state,oauthStateStore,pkce}.ts` — **#821**, the connect flow's two
  trust anchors. `state.ts` signs/verifies the HMAC state (and now RETURNS its `nonce`);
  `oauthStateStore.ts` is the per-attempt record over the admin-only
  `integracao/{id}/oauthState` subcollection — a FIXED `current` doc id, so a new attempt
  overwrites the previous one and the collection stays at one doc per integração (no TTL
  policy, no sweep). `consumeOauthState` redeems it inside a transaction, re-deriving
  every branch from the `tx.get` snapshot (root `CLAUDE.md` rule 7): two callbacks racing
  one nonce contend on OCC and the loser is REJECTED, which is the intended outcome for a
  single-use value. `pkce.ts` mints the verifier/challenge behind `MERCADO_LIVRE_PKCE_ENABLED`.
  ⚠️ PKCE is a per-application toggle in ML's DevCenter and its docs are explicit that
  once it is on the parameters become MANDATORY — so the flag and the toggle are flipped
  together for a given `client_id`. The prod application is shared with the legacy Flutter
  connect screen, which sends no `code_challenge`; staging has its own application.
- `lib/{auth,firebase,signatures}` — per-app copies of the shared helpers (each backend
  keeps its own so they deploy + log independently).
- `functions/` — the nested Cloud Functions codebase (deploy-artifact sub-build; see
  `functions/DEPLOY.md`). Covered by this app's typecheck/lint/test tasks.

## Stock sweep tiers — read ADR 0014 first

The stock sweep (`lib/marketplace/bulkEstoquePlan.ts` + `estoqueSweep.ts`) runs three
tiers — a 15-minute incremental, a 02:00 daily and a monthly force-all — and it
**deliberately under-sends**. A kit whose component moved but which did not itself
sell is not a candidate on the first two tiers; the monthly pass corrects it.

That is not an oversight. The catalogue is mostly printed t-shirts modelled as a
kit of `{blank shirt, print}`, and **thousands of kits share the same two
components**, so propagating a component movement to the kits containing it costs
~2000 writes per sale — built, measured, rejected. Only per-order-line work is
affordable, which is why `sincronizarEstoquePedido` stamps `ultimaModificacao`
solely on kits named directly on a pedido line.

`apps/docs` → **ADR 0014, "Kit stock propagation and the tiered stock sweep"**,
carries the full arithmetic, the tier table, the `min(anterior, atual)` guard and
the rejected alternatives. Check any change in this area against it.

## Status

The channel is **code-complete** against the ML port master plan (Steps 1-14).
OAuth connect is live — code exchange + persistence (tokenDuravel) + the
concurrency-safe refresh + the conta status route, driven by apps/web's
`/canais/mercado-livre` UI. The webhook receiver enqueues onto the
`processMercadoLivreNotification` Cloud Tasks queue and acks fast, with an
`onSchedule` reprocess sweep behind it.

Per-topic handlers, as of the `processNotificationPayload` dispatch in
`lib/marketplace/notificacao.ts` — check that function, not this list, when it
matters:

| Topic | Handler |
|---|---|
| `items` | listing status-sync + the UP-migration takeover (#440/#441) |
| `orders_v2`, `orders` | order → pedido import (Step 9) |
| `payments` | payment sync onto the pedido's embedded pagamento (Step 9) |
| `shipments` | shipment/`freteInicial` sync (Step 9) |
| `claims` | claim → incidente/conversa/mensagens import (Step 14) |
| `items_prices` | **permanent no-op**, ack-only |
| `orders_feedback`, `questions`, `messages`, `stock-location` | not handled yet |

⚠️ `items_prices` is not "pending" — it is closed by decision #803: the ERP owns
both price tables, so a price notification has nothing to do. It stays in
`KNOWN_TOPICS` only so it acks instead of parking a document per delivery. **Do
not attach a handler to it.** The four genuinely-unhandled topics also ack
without persisting; #813 tracks that cost.

## Env

See the repo-root `.env.example` (Mercado Livre section; the OAuth client SECRET and
the state HMAC key are in `.env.secrets.example` — one root template set is the
repo convention, #730) + `apphosting.yaml`. App-wide ML app credentials
(`MERCADO_LIVRE_CLIENT_ID/SECRET`, `..._STATE_SECRET`) live in env / Secret
Manager — one registered ML app serves every connected account (so
`MERCADO_LIVRE_CLIENT_ID` is also the `application_id` every notification carries,
which is what the webhook origin check compares against). The optional
`MERCADO_LIVRE_WEBHOOK_LOG_HEADERS` and `MERCADO_LIVRE_PKCE_ENABLED` are plain env
vars, not secrets — see the PKCE ⚠️ above before flipping the latter. `ALLOWED_ADMIN_ORIGINS`
became REQUIRED in production with #821/T5: localhost is no longer implicitly allowed,
so an unset value leaves the CORS allow-list empty and every browser call fails.
The per-account OAuth token lives in the admin-only `integracao/{id}/tokenDuravel` subcollection
(shared with the Flutter app during the dual-run migration; the move to the
encrypted `credenciais` store is a tracked post-migration follow-up).

Deploy of the App Hosting backend + the functions codebase is **manual and
coordinated** — see root `CLAUDE.md`, Critical rules. Functions deploy: `functions/DEPLOY.md`.
