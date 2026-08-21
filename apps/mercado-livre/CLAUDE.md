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
  `integracao/{id}/tokenDuravel` subcollection (the OLD Flutter wire shape — kept
  because the migrated corpus carries it, not because a second app writes it;
  "one wins" refresh).
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
- `app/api/marketplace/mercado-livre/chat/{responder,pergunta-acao}` +
  `lib/marketplace/chatOutbound.ts` — **#533**: answering a pergunta or a post-sale
  thread from the unified inbox, plus ML's two question-moderation actions.
  ⚠️ **HTTP, not a Firestore trigger, and that is the design.** WhatsApp sends by
  writing a mensagem and letting `sendOutbound` transmit it, which buys free retries —
  worth it when failures are TRANSIENT. ML's are not: a reply is single-shot and its
  refusals are terminal and operator-actionable (already answered, thread blocked,
  mediation open, grant dead), so the operator must see the real reason with their
  text still on screen. A refusal is `ChatOutboundRefusedError` → **409 carrying its
  own code**, which the composer renders verbatim.
  ⚠️ `conversa.respostaBloqueada` is a UI hint written by the importer and STALE BY
  CONSTRUCTION — a question can be answered on ML's own site between the last import
  and the click. The spine never trusts it: it re-reads the question or the pack and
  that read is the authority (it is also where the LIVE `seller_max_message_length`
  comes from, so nothing hardcodes 350).
  ⚠️ **Send FIRST, write second.** A mensagem written before the ML call leaves a
  phantom reply whenever ML refuses — #817 inverted: instead of a message that never
  sends, a message that never existed.
  ⚠️ `pergunta-acao` is gated on **`PERM.mensagem.delete`**, not `.write`: a deleted
  question leaves the listing for everyone and a blocked buyer cannot ask on any of
  the seller's items, and neither is undoable from here. Neither action writes to the
  thread — ML changes the question's `status` and the importer is the one writer of
  that state.
- `lib/marketplace/claim{Import,Mapping,Ids,Attachments,Actionability,Cliente}.ts` —
  **Step 14 + #768**: one ML claim → an Incidente on the pedido, plus a chat Conversa
  and its Mensagens, at the BYTE-EXACT legacy doc ids so re-processing a claim the
  Flutter app already imported UPDATES those docs instead of forking them.
  ⚠️ **The Incidente and the Conversa are gated DIFFERENTLY, and that asymmetry is
  the design.** The incidente is pedido business history — refunds, returns, the
  mediation outcome — and stays valuable long after the claim closes, so it is
  written for EVERY claim. The conversa is a surface an attendant is expected to
  answer in, so it is created (and kept answerable) only while
  `players[role=respondent].available_actions` still holds a `send_message_to_*` —
  `claimActionability.ts`. A thread nobody can reply on is #817 with extra steps.
  ⚠️ It closes, it never deletes: a claim that stops being answerable keeps every
  message it ever had and gains `respostaBloqueada` + `atendido`. That close runs
  OUTSIDE the `ultima_modificacao` freshness gate, because ML does not reliably bump
  `last_updated` when the actions drain away — inside the gate a dead thread would
  keep an open composer. `estadoConversa` is operator triage state and is never
  touched by any of it.
  ⚠️ **Identity is a CLIENTE** (#768). `claimUsuario.ts` — which minted a sem-auth
  `usuarios` doc per ML buyer — is deleted; `usuarios` is now only for people who can
  log in. The pedido already names the cliente, so `claimCliente.ts` does exactly one
  thing: stamp `idMercadoLivre` when absent, so the cliente a pre-sale QUESTION
  created and the cliente the ORDER created converge instead of forking. It is
  fill-only-when-absent — a disagreeing stored id is logged and left for a human.
  ⚠️ `estadoEnvio` on a claim mensagem comes from `sender_role`, NOT a constant.
  Legacy stamped `enviado` on every message including the buyer's, and it only
  rendered right because the synthetic usuario satisfied `MensagemBubble`'s second
  test (`user_id === customerUid`). Nothing writes `user_id` now, so direction rests
  on `estadoEnvio` alone. A `rejected`/`moderated` message of OURS lands as `erro` —
  ML never delivered it.
  ⚠️ The mensagem doc id stays the legacy five-field digest even though ML now
  publishes a per-message `hash`. Re-keying would rewrite every already-imported
  message under a new id — a thread-wide duplication of history — to fix a collision
  case ML itself flags with `repeated`. The field is modelled, not used.
- **Claim RESPOND** (#768) — `chatOutbound.ts` gained an `mlclaims` branch and
  `packages/integrations/mercado-livre/src/incidentRespond.ts` implements
  `respondIncident`, the last unimplemented `MarketplaceChannel` member.
  ⚠️ Every action is gated on `players[role=respondent].available_actions`, read
  LIVE on each call — ML decides what a seller may do from the stage and status,
  and the list empties as the claim closes. An unavailable action is a 400, so
  the gate refuses first and names what IS available.
  ⚠️ **`receiver_role` is derived, never assumed.** Once a mediation opens ML
  routes the seller through the mediator and REFUSES a message aimed at the
  complainant, so `send_message_to_mediator` outranks
  `send_message_to_complainant` wherever both appear.
  ⚠️ **Partial refund is a PERCENTAGE off an allow-list, never an amount.** The
  contract carries `refundAmount` in minor units like every other channel; ML
  accepts only the percentages `GET …/partial-refund/available-offers` returns,
  rejects 100% on that endpoint, and — the dangerous part — **defaults a MISSING
  percentage to 50%**. So an amount with no exact offer is refused with the list
  of real ones rather than rounded to the nearest: a refund is not a value worth
  approximating.
- `lib/marketplace/orderMessageAttachments.ts` — **#1162**: post-sale message
  attachments downloaded into Storage as `Arquivo`s, the `mlped` sibling of
  `claimAttachments.ts`. Before it, an attachment arrived as TEXT only and the
  operator had to leave the ERP to see it; that `[n anexos]` note stays as the
  FALLBACK, because silently dropping one is worse than not having it.
  ⚠️ **Not symmetric with the claims endpoint**, in three ways that each cost a
  round trip: `site_id` is a REQUIRED query param (omitting it is a documented
  400); the limits differ (25 MB and TXT allowed, vs the claim endpoint’s 5 MB
  and no TXT — hence a separate `ML_POST_SALE_ANEXO`); and ML documents **no 404**
  for this route, only 400 and 500, so a permanently missing file arrives as a
  **500** and MUST classify as deterministic or the task retries forever.
  ⚠️ The attachment mensagem takes its PARENT message’s direction — stamping every
  one `enviado` renders the buyer’s photos as our own outgoing messages, the exact
  bug the claims path had to fix. `bucket: null` degrades to skip-all with ONE warn
  per message: losing the customer’s message because Storage was unavailable would
  be far worse than losing the photo.
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
| `claims` | `handled` | incidente ALWAYS; conversa/mensagens only while answerable (Step 14 / #768) |
| `questions` | `handled` | pre-sale question → chat conversa/mensagem import (#532) |
| `messages` | `handled` | post-sale pack thread → chat conversa/mensagem import (#532) |
| `items_prices` | `ack` | **permanent no-op** (#803) — persists nothing |
| `orders_feedback`, `stock-location`, `stock-locations` | `ack` | nothing to do; persists nothing |
| `public_offers`, `public_candidates`, `user-products-families` | `ignore` | never enqueued, never persisted (#813) |

⚠️ **The ERP owns `estado` on the link doc — for User-Products listings too.**
`itemsStatusSync` used to defer on `isUserProductModel` and on `estado === 'am'`,
because the Flutter app drove those during a dual run. **There is no dual run and
there never will be one** (root `CLAUDE.md` rule 8) — so that guard stood down for a
writer that will not exist, and since `isUserProductModel` is true for every listing
a `user_product_seller` publishes, it silently skipped the entire future catalogue
(#1087). ML's own migration **tags** are now the only reason to defer, and each
deferral reports its own `ItemsSyncOutcome` so a skip is never again mistakable for
a sync. Do not reintroduce a link-only guard here.

⚠️ **A moderation is NOT its own topic — it arrives on `items`.** ML publishes no
`moderations` notification topic (checked against its topic list); a policy pause
reaches us as an ordinary `items` delivery, and ML's *Gerenciar moderações* derives
the `moderation_reference_id` straight from it (`id` + **`-ITM`**). So the reason
lives in `itemsStatusSync`, not in a new receiver, and `TOPIC_DISPOSITION` is
unchanged. The sync reads `GET /moderations/last_moderation/{id}-ITM` only when the
fetched item's status says there is one (`precisaConsultarModeracao` in
`lib/marketplace/moderacoes.ts`) — `under_review`, or a moderation `sub_status` —
so a healthy listing still costs exactly one `GET /items/{id}`, and a
moderation-endpoint outage cannot stall the `items` stream. A **404 is data**
("not moderated"); everything else rethrows, because persisting `[]` after a
failed read records "not moderated" and is indistinguishable from healthy.

⚠️ **The IMPORT is the third writer of `moderacoes`, and it diverges on failure
deliberately.** It reads through the same gate — so a healthy listing still costs
one `GET /items/{id}` — but places the call ABOVE every write (`importCategoriaChain`
and `resolveTaxonomia` both write Firestore before `assembleImportPlan` runs, so a
read below them could orphan docs), and it does **not** rethrow: for the other two
writers the status write IS the unit of work, while here a throw discards a produto,
its extraData, its stock, its photos and its children over a diagnostic. It degrades
to `null` — the field's **third value, "never asked"**, distinct from `[]` = "asked,
none" — which omits the key so the stored reason stands. ⚠️ The **mass import**
(`lerModeracoes: false`) takes the same `null` path on purpose: a catalogue drain must
not pay a lookup per moderated listing. What neither skips is the free half — a
listing whose own `status`/`sub_status` warrant no moderation is written `[]` with no
ML call at all, so even a full re-import clears every stale reason. Both `null` cases
self-heal through an `items` delivery or "Reverificar anúncio".

⚠️ **`moderacoes` is a SEPARATE field from `errors`/`causas`, and the reason is the
#781 stock re-arm.** `errors` is cleared whenever `podeEnviarEstoque(...).enviar` —
deliberately, so a `closed`/`under_review` listing keeps its diagnosis. Moderation
needs the opposite on both sides: it must SURVIVE on a listing ML still calls
`active` (`poor_quality_thumbnail` — live, but losing exposure) and VANISH the moment
ML stops reporting one, even mid-review. Sharing `errors` would have wiped the first
case on the very write that set it. The invariant that replaces the clearing rule is
stronger: `moderacoes` is written in the **same patch** as the `status` it explains,
on every status write, value or `[]` — so a reason cannot outlive its state.

⚠️ **`clearFalha()` deliberately does NOT clear `moderacoes`, and only a writer that
just asked ML may touch it** — today `itemsStatusSync`, `reverificarAnuncio` and the
**importer**. `errors`/`causas` record OUR failed write, so a later success
invalidates them; a moderação is ML's verdict and nothing we do lifts it. The stock
writeback proves the point — it fires on a successful `PUT /items`, and a
`poor_quality_thumbnail` listing is `active` and accepts stock updates **while
moderated**. Clearing there would erase a live reason and show a clean listing that
is really still penalised, which hides a real problem rather than merely failing to
explain one. ⚠️ `reverificarAnuncio` therefore **re-fetches**: it clears
unconditionally, so clear-only would erase the reason the operator pressed the button
to see. ⚠️ On a UP FAMILY the moderation is stored per MEMBER and the parent takes the
**fold winner's** (`upFamilyStatus.ts`) — never a union, or the parent would show a
reason for a sibling it is not reporting. Siblings' values come off disk, so the fold
costs no extra ML call.

⚠️ **A User-Products FAMILY's `estado` is a FOLD of its members, never one member's
status.** A family's parent link carries the FAMILY id, so a member's `items`
delivery matches no parent by `id` — `resolveLink` has a second stage that comes in
through `variacaoMercadoLivre.itemId` and hops up the parent ref (#1142). Each
member's raw `status`/`sub_status` is recorded on its OWN link and the parent takes
the fold (`upFamilyStatus.ts`). The rule that matters: `estado 'c'` is written only
when **every observed member is closed**, and never while one was never observed —
`estado` feeds `linkHasLiveListing` → `integracoesComProduto`, the anchor pre-filter
both sweeps open with, so one member closing could otherwise drop a produto whose
siblings are still selling out of the stock and price sweeps, silently. The denorm
is keyed on the parent link's own `id`, matching what publish and import stamped;
member ids belong to the CHILD produtos.

⚠️ **The `items` webhook is NOT the only surface that learns one member's status,
and the other one is the stock sender.** `buildSendTasks` emits one
`kind: 'variationItem'` task per UP member carrying the **family's** `linkDocId`
next to the **member's** `itemId`, so `estoqueSend`'s terminal 4xx branch (#781)
verifies a MEMBER and used to write that verdict straight to the parent through
`applyItemStatusToLink` — one member speaking for the family, which for `closed`
is the silent sweep drop the paragraph above describes. Both callers now land on
the same fold: `applyMemberStatusAndFold` (exported from `itemsStatusSync.ts`) is
the one writer of a member's status, and the member path never reaches
`applyItemStatusToLink` at all — so the denorm can never be keyed on a member id.
A member whose link cannot be resolved takes the conservative `estado 'E'` stop
instead, which is loud and bounded; `estado 'c'` from one member is not an option.
The residual: a HEALTHY member whose payload ML refused still latches the whole
family at `'E'`, because `estado` lives only on the parent link. It is visible and
self-clearing (an `items` webhook or "Reverificar anúncio"), and the log names the
offending member — but it does stop the siblings until then.

⚠️ **A member's own `status`/`sub_status` gate its send — on BOTH child loops, and
that is what makes #707's prune do anything.** `membroPodeEnviar` is called from
the legacy `variations[]` builder AND the User-Products per-member loop, with the
same two arms as the parent link: a PRESENT status goes through the documented
whitelist, an ABSENT one sends **optimistically** (#780). Gating only ONE branch is
the trap — the prune writes its mark on LEGACY links, so a gate that lived only on
the UP branch made the whole self-heal a no-op: the phantom went straight back into
`variations[]` and re-earned the identical rejection. The `THE SEAM` spec in
`estoqueSend.test.ts` joins the two halves so that cannot pass again. Both fields
ride the `varLinks` subcollection projection in `stockJoinBuilders`; dropping them
there silently disables both rungs.

⚠️ **A variation link is NOT backfilled by a successful send, unlike the parent.**
`estoqueSend`'s happy-path writeback is family-scoped, and for a `variationItem`
task it deliberately writes NO status at all — `resp` describes one member while
`linkDocId` names the family, so writing it there is the same over-reach in the
success direction (a member returning `paused` on an accepted PUT would make the
next sweep skip every sibling as `status-nao-enviavel`). It writes only
`ultimaModificacao` + `clearFalha()`, both legitimately family-wide. Reaching the
MEMBER's own link would cost a subcollection read on the hot path — one per member
task, 96× a day across the catalogue — to record a status that is `active` by
construction, so it is left to the three surfaces that already write one: the
`items` webhook, #707's prune, and the terminal-4xx fold. Consequence:
`membroPodeEnviar`'s optimistic arm converges only through those three, which is
the safe direction since it sends.

⚠️ **`item.variations.invalid` self-heals; it is LEGACY-MODEL ONLY (#707).** When a
bulk `PUT /items/{id}` is refused with that cause, the terminal branch diffs the
family's `variacaoMercadoLivre` links against the live `variations[].id` from the
verification GET it already made, and marks the phantoms `status: 'closed'` +
`sub_status: ['deleted']` — it does **not** delete them (the link carries the
member's `sku` + `attributes`, and legacy only ever rewrote the child's dead-weight
`marketplace` denorm array, never a `VariacoesML` doc). Two things not to
"simplify": the diff is guarded on `item.family_name == null`, exactly as
`.old/…/utils/produtos.dart:454` is — under User Products there is no `variations[]`
array and members are keyed by `itemId`, so a legacy-shaped diff would mark live
members closed. And a prune that marked something SKIPS the `estado 'E'` latch, so
the next sweep re-sends the corrected payload; a prune that marked nothing keeps
#781's latch, so the 96×/day loop cannot reopen.

⚠️ The same sync is now the **producer** of `estado 'am'`, not a reader of it. That
value never had a writer in this repo — it only ever arrived from Flutter — yet
`publishCore.ts` blocks publish on it and `precoPlan.ts`/`bulkEstoquePlan.ts` skip on
it. Of the send paths only the price one re-reads ML's tags itself, so this sync
stamps its verdict (it is the only component holding the fetched item) and those
three gate without a fetch of their own.

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
(the legacy wire shape, kept so the migrated corpus resolves natively; the move to
the encrypted `credenciais` store is a tracked post-migration follow-up).

Deploy of the App Hosting backend + the functions codebase is **manual and
coordinated** — see root `CLAUDE.md`, Critical rules. Functions deploy: `functions/DEPLOY.md`.
