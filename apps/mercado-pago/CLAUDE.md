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
- `app/api/payments/mercado-pago/links/{criar,cancelar,sincronizar}` — **#367**: the
  payment-link routes, POST only, all three gated by the ONE combined mask
  `PERM_LINK_PAGAMENTO.gerenciar` (`pedido.write | pagamento.write`; `hasPerm` needs
  ALL bits, and `criar` flips the pedido's estado). Bodies, responses and error codes
  are the shared contract in `@delfrance/schemas` (`pedido/wire/linkPagamento.ts`),
  read by `apps/web` too. `criar` mints one Checkout Pro preference per payer (a
  `compartilhado` link, one preference paid N times, only when
  `MERCADO_PAGO_LINK_COMPARTILHADO_ENABLED=1`); `cancelar` expires one; `sincronizar`
  re-drives a pedido's payments through the webhook pipeline. Routes stay thin.
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
  park that resolved an account, and the `dropped` arm names WHICH drop it was. The
  estado rule now counts the troca devolução credit (minus crédito loja pagamentos)
  as paid — see `coberturaDoPedido` in `packages/schemas/src/pedido/pureLogic/cobertura.ts`.
  The credit can settle a pedido to `pago`, but only money paid beyond the returned
  value makes it partially paid (#367 OD4): a pendente payment on a credit-only
  partial troca leaves it where it is.
  **#367**: after the reconcile, a payment that carries `linkPagamentoId` runs the link
  auto-close (`links/encerrarLink.ts`); a throw there fails the task, so it retries.
- `lib/payments/links/` — **#367**, the orchestration behind the link routes:
  `criarLinks.ts` · `cancelarLink.ts` · `sincronizarPedido.ts` (one per route),
  `encerrarLink.ts` (the auto-close), `elegibilidade.ts` (pure: the refusal reason) and
  `linkStore.ts` (the ONLY file here with a Firestore transaction — class C in
  `firestore-transaction-inventory.test.js`); plus small shared pieces: `expirar.ts`
  (`expirePatch`, `expirarPreferencia` — the ONE way cancel, auto-close and cleanup close
  a preference, retrying a 400 once without `date_of_expiration` — and the orphan-preference
  cleanup, kept apart so the webhook function does not bundle the create flow),
  `leitura.ts` (defensive readers for the legacy corpus),
  `respostas.ts` (`{ status, corpo }` refusals returned, not thrown) and `api.ts` (the
  client factory tests replace). Invariants — break none without reading root
  `CLAUDE.md` rule 7 first:
  1. ⚠️ **Preferences are POSTed to Mercado Pago BEFORE the transaction, never inside
     it**: an OCC retry would mint a second one. A refusal or failure afterwards
     best-effort EXPIRES the ones already created — but never one a PERSISTED link doc
     carries: an ambiguous commit can land and still throw (or be retried into a
     "replay" of our own docs), so `criarLinks` re-reads the requested docs before
     expiring, answers 201 when they are ours, and expires nothing if that re-read
     fails. POST is never retried on a network throw; PUT/GET are.
  2. Every decision the write depends on is re-derived INSIDE the transaction from its
     own reads — pedido, all links, all pagamentos, the integração (`canalDecideOEstado`,
     fails closed for marketplace pedidos) and the newest `nfev4` (an NF-e locks the
     pagamentos). The exposure rule (open links + new ones ≤ `restante`) lives there too,
     so two concurrent DIFFERENT batches cannot together overpay the pedido (an
     overpayment blocks the NF-e, cStat 866). The route's pre-check is advisory only.
  3. Link ids are minted by the client and created with `tx.create`: a retried request
     is a replay (200 `reaproveitado`, ZERO Mercado Pago calls), a different caller or a
     partial overlap is 409 `conflitoLinkId`.
  4. The estado flip `iniciado → aguardandoConfirmacaoDePagamento` happens server-side on
     creation and writes ONLY `estado` + `ultimaModificacao = max(stored, now)`: the
     pedido editor re-baselines from the live snapshot, so any other field would raise a
     `PedidoConflictError` on the operator's next save. It reserves stock and locks the
     items — intended. An Admin write records a null actor ('Sistema', #711), so the
     operator is kept on the link doc (`criadoPorOuterRef`).
  5. ⚠️ **Deliberately NOT sent**: `notification_url` (it overrides the panel webhook of
     #564, may arrive unsigned → 401 under `MERCADO_PAGO_WEBHOOK_SECRET`, and bakes a host
     that changes at cutover), `back_urls`/`auto_return` (no public page), `binary_mode`
     (kills Pix/boleto), `X-Idempotency-Key` (with the expire-on-failure cleanup an
     honoured key could return an already-EXPIRED preference). `external_reference` is
     the pedido id VERBATIM; the link is attributed by `metadata.link_id`.
  6. **Auto-close**: Mercado Pago has no max-uses, so a per-person link closes itself
     after its first approved payment (a shared one after N).
     `reconcilePedidoFromPagamento` returns `aprovadosDoLink` (payments EVER approved on
     that link), `notificacao.ts` calls `encerrarLinkSeCompleto`, which PUTs the expiry
     and marks the doc `concluido`. It runs in the NESTED functions codebase (it bundles
     `../../lib/payments/notificacao`), so it needs a `functions:mercado-pago` redeploy
     as well as App Hosting. Network / 5xx / 429 / reauth THROW (the task retries); a
     4xx marks the link with `erroEncerramento`.
  7. Legacy link docs (no `modo`/`status`, ms dates, possibly no preference id) stay
     readable: `sincronizar` derives their conta by `parseRef`, `cancelar` answers 409
     `preferenciaInacessivel` (cancel it in the Mercado Pago panel).
- `scripts/probe-link-pagamento.ts` — **#367**: the live probe (P1–P10 of the plan).
  ⚠️ **Agents never run it**: it needs a connected seller and real R$ 1,00 payments made
  by hand (test-credential payments send no notifications, and the pipeline drops
  `live_mode=false`), and its verdicts gate `MERCADO_PAGO_LINK_COMPARTILHADO_ENABLED`.
  `--project` is required and matched against the service account; dry-run by default.
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
- `lib/payments/respond.ts` — the error → HTTP mapper. **#367**: the conta-not-configured
  404 carries `code: MP_CONTA_NAO_CONFIGURADA` (`CODIGO_ERRO_LINK.contaNaoConfigurada`), so
  `apps/web` can tell it from the bare HTML 404 of a backend that predates the link routes.
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
Flutter cutover are tracked in **#564**.

Payment-link generation (**#367**) is **built** on top of it: `links/{criar,cancelar,
sincronizar}` plus the auto-close on the webhook path (the `apps/web` tab is a separate
PR). Per-person links are the default; the **shared** link (one preference paid N times)
sits behind `MERCADO_PAGO_LINK_COMPARTILHADO_ENABLED` and stays OFF until live probe P2
shows Mercado Pago really accepts a second payment on one preference. Nothing here has
been exercised against real Mercado Pago yet — the probe (`scripts/probe-link-pagamento.ts`,
run by a human with Lucas's go) gates that, and P3 in particular (does the #564 panel
webhook receive the `payment` topic for a preference we create, since we send no
`notification_url`?) gates the whole design. Deploy `functions:mercado-pago` **FIRST**,
then App Hosting: the auto-close runs in the functions codebase, so a link created by
the new App Hosting routes before it is live would stay payable after its first payment.

## Env

See the repo-root `.env.example` (Mercado Pago section; the OAuth client SECRET, the
state HMAC key and the webhook signature key are in `.env.secrets.example` — one
root template set is the
repo convention, #730) + `apphosting.yaml`. App-wide MP app credentials
(`MERCADO_PAGO_CLIENT_ID/SECRET`, `..._STATE_SECRET`) live in env / Cloud Secret
Manager — one registered MP app serves every connected account; the per-account
OAuth token lives in the admin-only `metodo_pgto/{id}/credenciais` subcollection.
`MERCADO_PAGO_LINK_COMPARTILHADO_ENABLED` (#367, OPTIONAL, plain — not a secret) is read
on every request and set by a human in the App Hosting console; it has no `env:` entry
in `apphosting.yaml` on purpose. No new REQUIRED var: there is no `notification_url`, so
`MERCADO_PAGO_PUBLIC_URL` stays OAuth-only.

Set `NEXT_PUBLIC_MERCADO_PAGO_URL=http://localhost:3007` so apps/web targets
this backend. The OAuth `redirect_uri` registered in the Mercado Pago dashboard
must point at this backend: `https://<this-app>/api/oauth/mercado-pago/callback`.

Deploy of the App Hosting backend is **manual and coordinated** — see root `CLAUDE.md`, Critical rules.
