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
  (foreign ⇒ 403 before any enqueue or write). A self-silencing header-name inventory
  rode along until the first live run (2026-08-19) settled the signature question from real
  traffic — **no signature header of any kind**, matching the written reference — after which
  it was removed. ⚠️ Do not re-add it: the question is answered, and the remaining follow-up
  is a secret path segment on the callback URL. It fails OPEN when unconfigured or when `application_id` is absent — a misconfigured
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
  needs the `(status, user_id)` composite index. Guard C in
  `notificationGuardrails.test.ts` only checks `(status, processedAt)`; **guard D** in the same
  file covers this one generically — it reads the re-drive query out of this file's source,
  derives the required index from it, and compares with `indexSatisfies`, which honours `order`.
  (The hand-rolled block that used to sit in `notificacao.test.ts` compared `fieldPath` only, so
  flipping `user_id` to `DESCENDING` passed it while breaking the query — #823.)
  ⚠️ `docIdOf` is `p.id ?? derivedDocId(p)` (**#807**). Three producers hand the store a
  payload ML gave no `_id`/`id` for — the order backfill (synthesised, so there IS no ML
  event), a `missed_feeds` entry whose `_id` is absent or path-shaped, and a body carrying
  neither — and an auto doc id means `store.create`'s ALREADY_EXISTS collision, the whole
  dedup mechanism, never fires. The fallback is `<topic>:<resource>` (slashes to `_`, then
  back through `asDocId`): `topic` because `orders_v2`/`orders` share `/orders/<id>`, the
  WHOLE resource because `<topic>:<last segment>` would collide `/orders/7` with
  `/shipments/7`. The doc's `id` FIELD stays null — the derived value keys the document, it
  is not a claim ML issued one.
- `lib/marketplace/missedFeedsSweep.ts` — **#812**: the daily 05:00 `missed_feeds`
  backstop. Everything else in this channel can only re-drive a notification that was
  RECEIVED; this asks ML what it failed to deliver (`GET /missed_feeds` — filed only
  after its ~8 retries over ~1h, retained 2 days) and replays each entry onto the same
  queue a webhook feeds. It is the mitigation that makes `minInstances: 0` defensible
  (a blown ack is recovered next morning, at up to ~24h latency — the decision and its
  cost are recorded in `apphosting.yaml`). ⚠️ It keeps **NO cursor**, deliberately: the
  feed has no time filter, and an entry is filed ~1h AFTER ML gives up, so a `sent`-based
  cursor advanced at 05:00 would permanently skip one sent at 04:55. Coverage rests on
  `period × 2 ≤ 48h retention` instead — stretching the cron silently deletes the
  backstop (`functions/src/index.test.ts` asserts the literal). Unknown topics are
  skipped and counted, never enqueued, so a replay cannot park a fresh doc every morning
  (#813); `request`/`response` are stripped from every entry (the callback URL is a leak
  surface, #811). Flag-gated OFF behind `MERCADO_LIVRE_MISSED_FEEDS_ENABLED`.
- `lib/marketplace/mercadoLivre.ts` — resolves an `integracao` account into a
  `ChannelContext` (newest valid token or a concurrency-safe refresh) + the plugin channel.
- `lib/marketplace/tokenStore.ts` — the durable-token store over the admin-only
  `integracao/{id}/tokenDuravel` subcollection (the OLD Flutter wire shape, shared with
  the still-running Flutter app during the dual-run migration; "one wins" refresh).
- `lib/marketplace/oauthState.ts` — **#821**, the connect flow's two trust anchors.
  The implementation is the SHARED module `@delfrance/data/admin/oauth-state`
  (extracted in #1034 and now serving all three OAuth channels); this file is a thin
  binding holding only what is per-channel — the `integracao/{id}/oauthState`
  subcollection and the `MERCADO_LIVRE_PKCE_ENABLED` flag. The shared module signs and
  verifies the HMAC state (RETURNING its `nonce`), keeps the per-attempt record at a
  FIXED `current` doc id so a new attempt overwrites the previous one (one doc per
  integração — no TTL policy, no sweep), and redeems it inside a transaction,
  re-deriving every branch from the `tx.get` snapshot (root `CLAUDE.md` rule 7): two
  callbacks racing one nonce contend on OCC and the loser is REJECTED, which is the
  intended outcome for a single-use value. ⚠️ Do NOT reintroduce logic here.
  ⚠️ PKCE is a per-application toggle in ML's DevCenter and its docs are explicit that
  once it is on the parameters become MANDATORY — so the flag and the toggle are flipped
  together for a given `client_id`. The prod application is shared with the legacy Flutter
  connect screen, which sends no `code_challenge`; staging has its own application.
- `app/api/marketplace/mercado-livre/usuarios-teste` + `lib/marketplace/testUsers.ts`
  + `testUserStore.ts` — the dev-only bootstrap for an end-to-end run: mint ML's
  seller/buyer **test users** and store them under `integracao/{id}/usuariosTeste`
  (admin-only, deliberately OUT of `ALL_DOMAINS` — it holds a password in the clear —
  so rules-gen emits nothing and Firestore default-denies). ML has no sandbox; these
  are real production accounts, capped at **10 per real account**, never listed by any
  endpoint, and the password is shown **once and never reissued**.
  ⚠️ That last fact is the whole design. A mint whose result is not persisted has
  permanently spent a slot and produced nothing, so: persist each user before minting
  the next, reuse anything already stored (doc id = the role, so a retry costs zero
  slots — rule 7 tier 0), and **revoke the bootstrap conta's credential only once both
  are durable**. `testUsers.test.ts` asserts the INTERLEAVING, not the final state;
  all three orderings are mutation-proven.
  ⚠️ `POST` deletes every `tokenDuravel` doc on the conta it used — intended (that
  account is a real seller account and must not stay connected), but it is why the
  gate is an explicit `MERCADO_LIVRE_TEST_USERS_ENABLED=1` rather than a `NODE_ENV`
  check: apps/web calls the DEPLOYED backend even in local dev, and #1059 is the
  worked example of a `NODE_ENV` escape disabling a guard in the one job that needed
  it. Unset ⇒ 404, checked before auth.
  ⚠️ `criarUsuarioTeste` in the integrations package bypasses `parseOk` on purpose:
  that helper puts the RAW BODY into `MercadoLivreValidationError`, and `respond.ts`
  logs a validation error's payload straight to the log stream — the exact route #1015
  leaked an OAuth token response by.
- `lib/{auth,firebase,signatures}` — per-app copies of the shared helpers (each backend
  keeps its own so they deploy + log independently).
- `functions/` — the nested Cloud Functions codebase (deploy-artifact sub-build; see
  `functions/DEPLOY.md`). Covered by this app's typecheck/lint/test tasks.

## Testing

Two suites, deliberately separated by filename:

- **Offline** — `pnpm --filter @delfrance/mercado-livre-app test` (`*.test.ts`). Runs in
  `ci.yml` on **every** PR; that workflow has no `paths:` filter, so this coverage can
  never develop a hole.
- **Firestore integration** — `test:firestore` (`*.firestore.test.ts`), run by
  `ci-mercado-livre.yml` under
  `firebase emulators:exec --config firebase.mercado-livre.json --only firestore`.
  Not a turbo task, so `turbo run test` cannot reach it. It exists because the offline
  suite mocks Firestore away entirely: it covers the real `createTokenDuravelStore`
  (including the dual-lineage read across Flutter's auto-id docs and this app's
  `current`, and the "one wins" refresh under real contention), the notification store's
  ALREADY_EXISTS/NOT_FOUND semantics, the receiver writing a real failure doc via the
  `MERCADO_LIVRE_TASKS_DISABLED` valve, `exchangeAndPersist`, and the test-user store
  (role doc ids, and `deleteAll` clearing BOTH tokenDuravel lineages — the offline
  suite mocks Firestore away, so a `current`-only delete cannot be caught there).

- **Cloud Tasks round trip** — `test:tasks` (`*.tasks.test.ts`), run by the same workflow
  under `--config firebase.mercado-livre.tasks.json --only firestore,functions,tasks`.
  It serves the REAL functions codebase (built first by `prepare-deploy.mjs`, since
  `predeploy` hooks do not run under `emulators:exec`) and drives
  receiver → `mlTasks.ts` enqueue → tasks emulator → the real
  `processMercadoLivreNotification` → a real Firestore write. ⚠️ The enqueuer's region and the TASK
  functions' region MUST match — a mismatch is the silent drop `mlTasks.ts` warns about,
  and it is what this test detects. Both are `MERCADO_LIVRE_TASKS_REGION` (inlined into
  the bundle, **us-east1**), which is deliberately NOT `FUNCTIONS_REGION` (**us-east5**):
  Cloud Tasks and Cloud Scheduler do not exist in us-east5, so the eleven queue/schedule
  functions live one region away from the four Firestore triggers. See `functions/DEPLOY.md`. It uses a seller with no integração so the path needs no ML API call, no
  token and no real secret, and executes only classic queries (the Pipelines API does not
  run in the emulator; `bulkEstoquePlan.ts` is bundled but never executed on this path).

⚠️ **Not covered, so do not read a green lane as more than it is:**
`scheduleDelaySeconds` — the emulator's dispatch loop is pure FIFO with no `scheduleTime`
predicate (`firebase-tools#8254`, open, triaged upstream as a feature request), so the
receiver's 10s order-family refetch delay cannot be observed; `mlTasks.test.ts` pins it
statically and the round trip uses a no-delay topic. Also uncovered: the nested
`functions/` **Firestore triggers** (the lane loads them but drives none), composite
**index declaration** (the emulator
auto-creates them; that is guard C/D in `notificationGuardrails.test.ts`), Firestore
rules (the Admin SDK bypasses them — `ci-rules.yml` owns those), the Enterprise Pipelines
API (the emulator is Standard edition and still exposes `db.pipeline()`), and the ML API
itself. ML has **no sandbox** and its `refresh_token` is single-use and rotating, so no
lane may ever hold real ML credentials — a CI refresh would invalidate the token the
deployed backend is holding.

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

| Topic | Disposition | Handler |
|---|---|---|
| `items` | `handled` | listing status-sync + the UP-migration takeover (#440/#441) |
| `orders_v2`, `orders` | `handled` | order → pedido import (Step 9) |
| `payments` | `handled` | payment sync onto the pedido's embedded pagamento (Step 9) |
| `shipments` | `handled` | shipment/`freteInicial` sync (Step 9) |
| `claims` | `handled` | claim → incidente/conversa/mensagens import (Step 14) |
| `items_prices` | `ack` | **permanent no-op** (#803) — persists nothing |
| `orders_feedback`, `stock-location` | `ack` | nothing to do; persists nothing |
| `questions`, `messages` | `park` | data-bearing, importer pending (#532/#533) |
| `public_offers`, `public_candidates`, `user-products-families` | `ignore` | never enqueued, never persisted (#813) |

⚠️ **The ERP owns `estado` on the link doc — for User-Products listings too.**
`itemsStatusSync` used to defer on `isUserProductModel` and on `estado === 'am'`,
because the Flutter app drove those during dual-run. There is no dual-run — Flutter
is switched off at the cutover — so that guard stood down for a writer that will not
exist, and since `isUserProductModel` is true for every listing a
`user_product_seller` publishes, it silently skipped the entire future catalogue
(#1087). ML's own migration **tags** are now the only reason to defer, and each
deferral reports its own `ItemsSyncOutcome` so a skip is never again mistakable for
a sync. Do not reintroduce a link-only guard here.

⚠️ The authority is `TOPIC_DISPOSITION` in `lib/marketplace/notificacao.ts`, not
this table. The four dispositions differ in what they COST: `handled` and `ack`
persist nothing on success, `park` writes one document per delivery (the price
of a replayable record while an importer is pending), and `ignore` is refused at
the **receiver** so it never becomes a Cloud Task at all. `ack` vs `ignore` is
the distinction #813 turned on — both write nothing, but `ack` reports `done`,
which is indistinguishable from work actually performed, while `ignore` reports
`dropped/ignorado`. A topic ABSENT from the table still parks, deliberately:
that is the only signal a new ML topic appeared.

### Publishing: two models coexist, and one of them cannot order variations

Once a seller carries the `user_product_seller` tag, **new** items must go out in
the User-Products shape (`family_name`, no `variations` array); items already
published under the legacy model and not yet migrated stay editable with the
legacy payload. Both paths are live for the whole migration, which is why
`isUserProductModel` is per-link and flips only via the UPtin takeover.

Four facts from the ML docs that the payload builder now encodes (#797) — check
these before "fixing" what looks wrong in `publishCore.ts`:

- **`family_name` is CREATE-ONLY on BOTH User-Products paths.** ML takes it on
  the create and answers `400 BODY_INVALID_FIELDS` /
  *"The field family name is invalid"* on a `PUT /items/{id}` that carries it, so
  both builders strip it from an update: `buildUserProductItemPayload` (the
  family fan-out) always did, and `buildItemPayload` (the SINGLE-ITEM half — a UP
  produto with no children) did not, which 400'd every republish of such a
  listing. An update therefore sends no name field at all, never a `title`
  either, and `titleEditability` in apps/web disables the título on a published
  UP listing rather than accept an edit publish would drop. Why ML refuses is
  not yet settled (sales lock vs `max_title_length` vs the field simply not
  being writable there) — that is the follow-up issue.
- **Variation display order does not exist under User Products.** No ordering
  field appears anywhere in that surface, so `produto.ordem` is legacy-only and
  is lost the moment a listing migrates. The full note is the ⚠️ in
  `packages/integrations/mercado-livre/src/mapping/itemPayload.ts`.
- **A grupo outside ML's taxonomy is a *custom characteristic*** — sent as
  `name` + `value_name` with **no `id`**, and ML allows exactly ONE per product,
  counted over ALL variations. ML also requires every variation to combine the
  **same** attributes; both are checked once across the children by
  `validateCombinationsAcrossChildren`, never per child. The old port uppercased
  the group name into an invented id (`'Sabor'` → `{id:'SABOR'}`).
- **This port never creates an ML virtual kit, so publish must still send a
  quantity.** ML's Virtual Kits are User-Products-only (`POST /items/kits`,
  `bundle.components[]` of `user_product_id`s), immutable once published, and
  derive their stock from the components; because a component is already
  variation-level, a produto **with variations cannot be an ML kit at all**.
  ⚠️ The sweep's `quantidadeParaEnvio` returns `null` for `ehKitVirtual` meaning
  *"do not push a stock update"* — on the publish path that would omit a field
  `POST /items` **requires**, making the produto unpublishable. `publish.ts`'s
  `quantidadeParaPublicar` is the deliberate divergence: a virtual kit publishes
  the component-min like any other kit.

⚠️ `items_prices` is not "pending" — it is closed by decision #803: the ERP owns
both price tables, so a price notification has nothing to do. It stays in the
disposition table only so it acks instead of parking a document per delivery.
**Do not attach a handler to it.** Being the one permanently-`ack` topic also
makes it the inert fixture the notification suite keys ~20 tests on
(`INERT_TOPIC` in `notificacao.test.ts`, pinned by its own guard) — every other
quiet-looking topic is a handler waiting to happen.

## Env

See the repo-root `.env.example` (Mercado Livre section; the OAuth client SECRET and
the state HMAC key are in `.env.secrets.example` — one root template set is the
repo convention, #730) + `apphosting.yaml`. App-wide ML app credentials
(`MERCADO_LIVRE_CLIENT_ID/SECRET`, `..._STATE_SECRET`) live in env / Secret
Manager — one registered ML app serves every connected account (so
`MERCADO_LIVRE_CLIENT_ID` is also the `application_id` every notification carries,
which is what the webhook origin check compares against). The optional
`MERCADO_LIVRE_PKCE_ENABLED` is a plain env var, not a secret — see the PKCE ⚠️ above
before flipping it. `ALLOWED_ADMIN_ORIGINS`
became REQUIRED in production with #821/T5: localhost is no longer implicitly allowed,
so an unset value leaves the CORS allow-list empty and every browser call fails.
The per-account OAuth token lives in the admin-only `integracao/{id}/tokenDuravel` subcollection
(shared with the Flutter app during the dual-run migration; the move to the
encrypted `credenciais` store is a tracked post-migration follow-up).

Deploy of the App Hosting backend + the functions codebase is **manual and
coordinated** — see root `CLAUDE.md`, Critical rules. Functions deploy: `functions/DEPLOY.md`.
