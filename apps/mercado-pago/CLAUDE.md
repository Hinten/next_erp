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
  **#1034**: it also RECORDS the attempt before handing out the URL — the state's
  `nonce` plus, when `MERCADO_PAGO_PKCE_ENABLED=1`, a fresh PKCE `code_verifier`
  whose S256 challenge rides the consent URL.
- `app/api/payments/mercado-pago/conta` — `PERM.metodoPagamento.read`-gated connection
  status (`/users/me` identity, or `connected: false` when the credential is dead).
- `app/api/oauth/mercado-pago/callback` — public browser redirect target; the signed
  `state` is the only trust anchor → verify → **redeem the attempt** → exchange code
  → persist. ⚠️ **#1034**: verifying the HMAC is not enough — it proves integrity, not
  freshness-of-use, so a captured `state` used to be replayable for the whole
  10-minute window and a replay REPOINTED the account at whoever drove the second
  callback, sending customer payments to a stranger's collector.
  `mercadoPagoOauthState.consume` is the anchor that makes it single-use; it runs
  BEFORE the exchange and its failure is `reason=bad_state`, never `exchange`.
- `app/api/webhooks/mercado-pago` — **#531**: MP payment-notification receiver
  (`x-signature` verified only when `MERCADO_PAGO_WEBHOOK_SECRET` is set; the real
  anchor is the handler's payment refetch). Validates + enqueues onto the
  `processMercadoPagoNotification` Cloud Tasks queue and acks 200 fast (no Firestore
  write on the happy path).
- `lib/payments/mercadoPago.ts` — resolves a `metodo_pgto` account into a context
  (the consent URL, a refresh-on-expiry `resolveAccessToken`, and `exchangeAndPersist`).
- `lib/payments/credentialStore.ts` — the single-token store over the admin-only
  `metodo_pgto/{id}/credenciais` subcollection (fixed `current` doc; strays deleted
  on save). Mirrors apps/melhor-envio's `tokenStore`.
- `lib/payments/notificacao.ts` — **#531**: this channel's webhook adapter — parse →
  resolve collector → RE-FETCH the payment (never trust the body) → map
  (`mpPaymentToPagamento`) → `reconcilePedidoFromPagamento`, then a
  `defineNotificationPipeline({...})` binding. The resilience behaviour itself (retry
  disposition, failures-only persistence to `notificacoesMercadoPago`, the
  durable-cursor sweep) is the SHARED core in `@delfrance/data/admin/notifications` —
  see the `webhook-notifications` skill. Do not re-implement it here.
  **#1137**: the reconcile's `{ transition, skippedStale }` is collapsed into a single
  filterable `detail` on the `reconciled` outcome, and `TaskResult` carries `kind` +
  `detail` out to the task log — `done` is a DISPOSITION, not a claim that work
  happened, and a stale redelivery that wrote nothing used to log exactly like a real
  estado transition (#1087, fixed for ML in #1136). `metodoId` now also rides every
  park that resolved an account, and the `dropped` arm names WHICH drop it was.
- `lib/payments/mpTasks.ts` — the `processMercadoPagoNotification` task-queue scheduler
  (`MERCADO_PAGO_TASKS_DISABLED` valve → persist-for-the-sweep). Mirrors `mlTasks.ts`.
- `lib/payments/{state,oauthState}.ts` — **#1034**, thin bindings to the SHARED OAuth
  primitives in `@delfrance/data/admin/oauth-state`. `state.ts` re-exports the signed
  state (`PaymentStateError` is an alias of the shared `OauthStateError`);
  `oauthState.ts` binds the per-attempt record to
  `metodo_pgto/{metodoId}/oauthState` (admin-only, FIXED `current` doc id, so a new
  attempt overwrites the previous one — no TTL policy, no sweep) and owns the
  `MERCADO_PAGO_PKCE_ENABLED` flag. ⚠️ Do NOT reintroduce logic in these files: three
  hand-copied per-channel copies is exactly what #1034 removed, and the drift was
  silent — this channel was the only copy carrying the clock-skew guard for months
  (Mercado Livre gained one in #998, Melhor Envio only in #1034), while its `nonce`
  was minted and then discarded exactly like both siblings'.
- `lib/payments/respond.ts` — the error → HTTP mapper.
- `lib/signatures/hmac.ts` — constant-time `verifyHmac` + `verifyMpSignature` (MP's
  `ts=…,v1=…` manifest HMAC over `id;request-id;ts`).
- `lib/{auth,firebase}` — per-app copies of the shared helpers (each backend keeps
  its own so they deploy + log independently).
- `functions/` — the nested Cloud Functions codebase (deploy-artifact sub-build; see
  `functions/DEPLOY.md`). Covered by this app's typecheck/lint/test tasks. Mirrors
  `apps/mercado-livre/functions`.

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
webhook reconciler (#531) is now present: the receiver validates + enqueues onto
the `processMercadoPagoNotification` Cloud Tasks queue, the task handler
verifies-by-refetch → maps → reconciles the pedido estado, and an `onSchedule`
sweep re-drives persisted `failed` docs — the resilience foundation mirrors the
ML pipeline. The nested Cloud Functions codebase (`functions/`) that hosts the
`onTaskDispatched` handler + the sweep is now in place; deploy + the legacy
Flutter cutover are tracked in **#564**. The MP payment-link tab (#367) builds
on top of this foundation in a later PR.

## Env

See the repo-root `.env.example` (Mercado Pago section; the OAuth client SECRET, the
state HMAC key and the webhook signature key are in `.env.secrets.example` — one
root template set is the
repo convention, #730) + `apphosting.yaml`. App-wide MP app credentials
(`MERCADO_PAGO_CLIENT_ID/SECRET`, `..._STATE_SECRET`) live in env / Cloud Secret
Manager — one registered MP app serves every connected account; the per-account
OAuth token lives in the admin-only `metodo_pgto/{id}/credenciais` subcollection.

Set `NEXT_PUBLIC_MERCADO_PAGO_URL=http://localhost:3007` so apps/web targets
this backend. The OAuth `redirect_uri` registered in the Mercado Pago dashboard
must point at this backend: `https://<this-app>/api/oauth/mercado-pago/callback`.

Deploy of the App Hosting backend is **manual and coordinated** — see root `CLAUDE.md`, Critical rules.
