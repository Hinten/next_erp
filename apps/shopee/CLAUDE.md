# apps/shopee — CLAUDE.md

API-only Next.js app for the **Shopee Open Platform** sales channel. One App
Hosting backend per channel (ADR 0015), so its logs and deploy are isolated.
Runs on `:3009` in dev. Steps 1–5 and 10 of
`.master_plans/shopee/shopee-marketplace-integration.md` — **OAuth connect,
conta status, the access-token refresh, the cached taxonomy reads, the inbound
push receiver with its Cloud Tasks queue, nested functions codebase, weekly
authorization-expiry sweep and the three step-4 delivery backstops, and the
step-5 order → pedido import**.

⚠️ **Step 5 is where this app started writing ERP business data** — `pedidos`,
`clientes`, `enderecos`, `incidentes` — so the old blanket "this app writes
nothing" is no longer true and must not be re-asserted. What is still true is
the direction: **nothing is published or written TO Shopee**, nothing reaches
the seller's catálogo or anúncios, and the only state-changing calls the app
makes are the OAuth exchange, the token refresh and the lost-push CONFIRM. All
three matter: the `refresh_token` is single-use and rotating, and a confirm acks
a page of the 3-day queue irreversibly.

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
- `app/api/marketplace/shopee/taxonomia/{categorias,atributos,marcas,limites,limites/kit,variacoes,recomendacao-categoria}/route.ts`
  — the seven read-only taxonomy routes, all `PERM.integracao.read`, all
  `integracaoId`-scoped. See **Taxonomy reads** below.
- `lib/shopee/taxonomia/` — the layer behind those routes: `cache.ts` (seven
  `createReadCache`s + `taxonomiaCtx`), `categorias.ts` (the tree index and the
  three-valued leaf gate), `params.ts` (hand-rolled query readers → pt-BR 400s),
  `dto.ts` (the answer shapes and their projections), and one reader per
  operation (`atributos`, `marcas`, `limites`, `variacoes`, `recomendacao`).
- `app/api/health/route.ts` — `{ service: 'shopee' }`.
- `lib/shopee/env.ts` — the one place this app reads its **Shopee**
  configuration from the environment, and every read there is blank-guarded
  (`?.trim()` + a length check, never `??`) — the one exception is
  `shopeeSandbox()`, whose `=== '1'` treats a blank value as production by
  construction. ⚠️ It is **not** the app's only
  `process.env` reader: Firebase credentials are read in
  `lib/firebase/admin.ts` (a verbatim copy of the same singleton the six sibling
  channel apps carry, `??`-defaulted `FIREBASE_DATABASE_ID` included), the CORS
  allow-list in `proxy.ts`, the Cloud Tasks region/valve in
  `lib/shopee/shopeeTasks.ts`, and the nested `functions/` codebase. The
  blank-guard rule is enforceable precisely because it is scoped to the Shopee
  values. ⚠️ `SHOPEE_VARIATIONS_PATH`
  (optional, **not** a secret) lives here too and is deliberately NOT
  shape-validated: this module answers "what did the operator type", and the
  package's `normalizeApiPath` decides whether that is a usable API path —
  raising `ShopeeConfigError` that NAMES the variable. See **Taxonomy reads**.
- `lib/shopee/core/{shopee,credentialStore,tokenStore,respond,validationIssues}.ts`
  — the context loader (cached `integracao` doc, uncached credential,
  `getAccessToken` / `createShopClient`), the Firestore credential store, the
  error→HTTP mapper, and the Next-free Zod-path helper. ⚠️ **Step 4 is the
  functions-bundle consumer `core/shopee.ts` was kept Next-free for**: the
  order backfill loads a conta context per integração, so the artifact's graph
  now reaches `core/shopee.ts`, `tokenStore.ts` and `credentialStore.ts` on top
  of step 3's `core/contaCache.ts`, and both enqueuing sweeps pull
  `shopeeTasks.ts` → `lib/firebase/admin.ts`. `respond.ts` is still NOT
  Next-free and stays out of any bundle;
  `tools/deploy-env/bundle-inlining.test.js` builds the bundle in `CI test`, so
  the growth is proven offline.
- `lib/shopee/core/tokenStore.ts` — the leased access-token refresh (see **Token
  refresh** below). Its three transactions are inventoried in
  `packages/config-eslint/rules/firestore-transaction-inventory.test.js`, which
  is where the full race analysis lives.
- `lib/shopee/conta/{oauthState,shops,status}.ts` — the per-attempt record
  binding, the token-free connection oracle (`findAuthorizedShop`, plus
  `listarLojasAutorizadas`, which pages to `MAX_SHOPS_PAGES` and dedups by
  `shop_id` with FIRST sighting winning), and the conta wire shape.
- `app/api/webhooks/shopee/route.ts` — the push receiver. No Bearer, out of the
  `proxy.ts` matcher, **204 with an empty body** on every ack. See **Inbound
  push** below.
- `lib/shopee/notificacoes/{pushSignature,notificacao}.ts` — the push HMAC and
  this channel's `defineNotificationPipeline` binding: `parseNotificationBody`,
  the derived doc id, the dispatch table on **push code**, and the conta arms.
- `lib/shopee/shopeeTasks.ts` — the `processShopeeNotification` queue scheduler
  (`SHOPEE_TASKS_REGION ?? FUNCTIONS_REGION`, no default; the
  `SHOPEE_TASKS_DISABLED` valve → persist-for-the-sweep).
- `lib/shopee/core/contaCache.ts` — the two cached integração readers:
  `readConta` (by integração id, extracted out of `core/shopee.ts`) and
  `findIntegracaoByShopId`, which is what turns a push's `shop_id` into a conta.
  Token-free by construction — it touches `integracaoCollection` only.
- `lib/shopee/pedidos/` — the step-5 order import: `importarPedido.ts` (the
  orchestrator), `orderIds.ts` (the deterministic pedido and item ids),
  `orderMapping.ts` + `orderFreteMapping.ts` + `orderStatusMaps.ts` (the pure
  mappers, the estado ladder and the freight seed), `itens.ts` (prices and
  quantities), `produtoResolve.ts` (the link → SKU cascade), `comprador.ts` (the
  buyer-capture adapter), `incidentesProduto.ts` (one incidente per unbound
  line) and `orderPedidoTx.ts` (the ONE transaction). See **Order import**
  below.
- `lib/shopee/fixtures/` — the redacted wire corpus (`__wire__/`), the
  `redact.ts` path-suffix denylist, the two-layer `piiScan.ts` (residue +
  patterns; the redaction's own FIXPOINT is the strong layer) and the typed
  loaders. **Test-only, imported by no `src` file** — the
  `lib/shopee/testing/fakeDb.ts` precedent. A body enters the corpus only after
  `redact`, and a scan finding never carries the value it found.
- `lib/shopee/avisos/autorizacao.ts` — one of the **three** modules in this app
  that speak **microseconds**; every other signature is milliseconds. Raises
  `shopeeAutorizacaoExpirando` / `shopeeDesautorizado` and resolves both, and
  since step 4 it also EXPORTS the µs seam
  (`agoraUsDe` / `depsDeEscrita` / `AvisoDeps`) so the push-health producer can
  write avisos without knowing the unit — which is what keeps its own call sites
  countable rather than merely written down.

  ⚠️ **The other two arrived with step 5, and naming all three is the point** —
  a "the ONE module that speaks µs" sentence that has quietly become three is
  worse than no sentence:

  1. `avisos/autorizacao.ts` (above);
  2. `pedidos/importarPedido.ts` — the single `millisToMicros(nowMs)` per run,
     handing `nowUs` DOWN as a parameter to the mapper, the transaction and the
     incidente writer;
  3. `pedidos/orderMapping.ts`'s `microsDeSegundosShopee` — the ONE
     seconds → µs conversion, for Shopee's second-resolution stamps, whose
     docblock carries the `coerceToMicros` trap (that helper classifies by
     MAGNITUDE and reads a seconds value as MILLIseconds ⇒ 1970 ⇒ a watermark
     comparison that answers "older" forever).

  **Nothing below those three converts anything.** A `millisToMicros` appearing
  in `itens.ts`, `orderFreteMapping.ts` or `incidentesProduto.ts` is the drift
  this list exists to prevent.
- `lib/shopee/conta/expiracaoSweep.ts` — `runShopeeAuthorizationExpirySweep`,
  driven weekly by the functions codebase and, scoped to named shops, by
  `push 12`. See **The authorization-expiry sweep** below.
- `lib/shopee/notificacoes/lostPushSweep.ts` — `runShopeeLostPushSweep`: the
  2-hourly replay of Shopee's 3-day lost-push queue. Enqueue-then-confirm, one
  ack per page, never on an empty page. See **Delivery backstops** below.
- `lib/shopee/notificacoes/orderBackfill.ts` — `runShopeeOrderBackfill`: the
  15-minute per-conta `get_order_list` walk on a durable cursor, DOUBLY gated
  (an env flag AND a structural guard that reads the dispatch table).
- `lib/shopee/notificacoes/notificacaoSintetica.ts` —
  `notificacaoSinteticaDePedido`, the ONE builder for a synthesized code-3
  payload. Shared with step 8's stuck-reservation sweep, so the two produce the
  same shape and the same dedup key — the doc id still carries each tick's own
  clock, so step 8 owes its own idempotence.
- `lib/shopee/notificacoes/pushConfigMonitor.ts` —
  `runShopeePushConfigMonitor`: the daily `get_app_push_config` reading and the
  three log-only divergence checks.
- `lib/shopee/avisos/pushSaude.ts` — the producer for the two push-health
  avisos, and the second module in this app that writes to the avisos inbox. It
  holds NO `millisToMicros`: it takes the µs helpers from
  `avisos/autorizacao.ts`, which stays the one module that knows the unit.
- `lib/shopee/testing/fakeDb.ts` — the shared in-memory Firestore double the
  six sweep and producer suites drive. Test-only, imported by no `src` file (the
  `apps/web/lib/testing` precedent); ONE copy, because two copies with a
  comment claiming they agree is the smell the root CLAUDE.md names.
- `functions/` — the nested Cloud Functions codebase (a deploy-artifact
  sub-build; see `functions/DEPLOY.md`). Covered by this app's
  typecheck/lint/test tasks. Mirrors `apps/mercado-pago/functions`.
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
`connected: true` on a stale stored access token — and normally with `loja`
populated too, because the shop read goes through the token store and renews the
pair on its way in. `loja` degrades to `null` whenever `get_shop_info`
could not be read AT ALL: another instance holds the renewal lease, the grant
itself is dead, or the shop call simply failed (a Shopee error envelope, edge
HTML under the IP whitelist, a network drop, an unparseable body). ⚠️ So a null
`loja` does NOT imply a renewal problem — only `credencial.renovacaoFalhou` says
that, and a dead grant is reported through it rather than as a 4xx, because a 4xx
would throw away the very clocks this route read WITHOUT a token.

## Token refresh (`lib/shopee/core/tokenStore.ts`, step 2)

`getOrRefreshAccessToken` is the ONLY way to obtain an access token. Reach it
through the context — `ctx.getAccessToken()`, or `ctx.createShopClient()`, which
hands the package a **function** so a token that lapses mid-batch is renewed
rather than replayed dead. Never read `access_token` off the document to sign a
call.

**Fast path first.** One uncached read of `credenciais/current`; if the stored
token outlives `REFRESH_SKEW_MS` it is returned with zero writes, zero
transactions and zero provider calls. That is the overwhelmingly common case and
it must stay free.

**Otherwise: a lease that EXPIRES.** ADR 0011 rejected pessimistic leases for
general writes and it is right to — the balanço lock is this repo's own example
of a lock that cannot expire. Token refresh is the one override, for one reason:
Shopee's refresh token is single-use and rotating, so two instances that both
spend it do not merely write twice, they can burn the pair. Firestore's OCC
cannot prevent that on its own, because OCC arbitrates the WRITE while the
expensive act — `POST /api/v2/auth/access_token/get` — happens between two of
them. So OCC excludes the two callers that read the same version, and the stored
lease excludes the caller arriving after one of them committed.

The constants, and the invariant that ties them (a test pins it):

| constant | value | |
|---|---|---|
| `REFRESH_POLL_BUDGET_MS` | `3_000` | how long a waiting caller polls before answering 503 |
| `REFRESH_POLL_INTERVAL_MS` | `250` | between re-reads while it waits |
| `REFRESH_LEASE_TTL_MS` | `30_000` | before anyone may take the lease over |
| `REFRESH_SKEW_MS` | `60_000` | a token with less life than this is renewed |

⚠️ **`BUDGET < TTL < SKEW`, and both inequalities are load-bearing.** TTL below
the skew means a crashed or hung refresher's lease expires while the old token is
still nominally alive, so the takeover lands inside the window the skew reserved
instead of after the conta has already stopped working (`shopeeCall` has no
timeout, so a hung fetch is the crash case by another name). Budget below the TTL
means a caller that waited out the whole budget and tries once more is still
refusing to steal a LIVE lease — it answers 503 and lets its caller retry.

The lease is **never renewed**: a lock that renews itself cannot expire, which is
exactly what made the legacy Flutter `isRefreshing` flag fatal. A corrupt lease
(a non-string owner, a non-finite expiry) reads as NO lease, so a half-written
document can never freeze an account.

**FAQ 144 vs the API page.** Shopee's refresh API page says a refresh token "can
be used once only"; Shopee's own FAQ 144 ("refresh_token Backup Plan") says a
used one stays valid for four more hours and, re-sent, returns the **same** new
pair. The two readings disagree and nothing published settles it, so the design
serves both. The commit guard is the seam: it re-reads the document inside its
transaction and compares the **stored `refresh_token` against the one we spent**
— an identity comparison, not a clock, so rule 7's cross-unit trap cannot apply.
If they differ, a newer pair landed (a re-consent, or another instance) and OURS
is dropped, the stored token returned. Under FAQ 144 that costs one wasted call;
under "once only" it is what stops a second write burning a live pair. The
release path does the mirror image: it adopts a newer stored pair **before** any
terminal verdict is written, so a `refresh_token_expired` answered about a token
that has since been replaced cannot disconnect a healthy conta.

⚠️ **The accepted residual is a crash between Shopee's answer and the commit.**
The pair we were handed is lost, and once the lease TTL elapses the next caller
re-sends the OLD refresh token: that heals under FAQ 144 and forces a re-consent
under "once only". Narrowing the window further would mean writing before the
provider answers, which is a worse trade. When it does happen the operator sees
`credencial.renovacaoFalhou` on the conta screen and reconnects.

The authorization-expiry sweep watches the OTHER clock (the 7–365-day one) and
lives in the nested functions codebase — see below.

## Inbound push (`app/api/webhooks/shopee/`, `lib/shopee/notificacoes/`, step 3)

The receiver reads the raw body **once**, verifies the `Authorization` header —
a bare lowercase hex HMAC-SHA256 over `SHOPEE_PUSH_CALLBACK_URL + "|" + rawBody`
— and enqueues onto the `processShopeeNotification` Cloud Tasks queue. It writes
**no Firestore document on the happy path**. The resilience behaviour itself
(retry disposition, failures-only persistence to `notificacoesShopee`, the
durable-cursor sweep) is the SHARED core in `@delfrance/data/admin/notifications`
— see the `webhook-notifications` skill. Do not re-implement it here.

⚠️⚠️ **The ack shape is not a style choice.** `guide 18` defines a FAILED push
as "not receiving an HTTP response with a status code of 2xx **and an empty
body**". The JSON ack every other provider in this repo accepts — `200 {"ok":
true}` — counts as a FAILURE here, and a sustained failure rate first warns
(>600 pushes / 6 h, <70 % success) and then **auto-disables the subscription**
(<30 %), which loses everything not already in the lost-push queue. So every
answer is `new NextResponse(null, { status })` and a test asserts the body is
genuinely empty on all three 2xx exits.

The ladder, in order: config missing ⇒ **503** · bad signature ⇒ **401**, before
any enqueue · unparseable body ⇒ 204 (a retry will not parse either) · no
integer `code` ⇒ 204 · enqueue failed ⇒ persist `failed` ⇒ 204 · the persist
failed on a `ZodError` ⇒ 204 (drop) · any other persist failure ⇒ rethrow, 5xx,
Shopee redelivers.

⚠️ **The HMAC signs the CONFIGURED url byte for byte.** `shopeePushCallbackUrl()`
does not strip a trailing slash and must not start: a slash, a http/https
difference or a stray port changes the digest. Shopee's docs never say WHICH url
string they sign, so the receiver logs configured-vs-received (plus 8-character
digest prefixes, never a body, a `data`, a full header or a key) for the first
five deliveries per instance and for every mismatch thereafter. ✅ **The sandbox
answered it on 2026-09-09**: Shopee signs the url EXACTLY as configured in the
console, and every push verified while the request-side url — the app behind a
tunnel — read as a different string entirely, the real host arriving only in
`x-forwarded-host`. So a received url is never a substitute for the configured
one, on any proxy. The log stays until the first App Hosting delivery says the
same on the real host, and then it goes.

⚠️ **Keyed on the push CODE, never `push_api_id`.** They differ, and not by a
constant: `shop_penalty_update_push` is code **28** and push_api_id **31**. The
dispatch table is the only place this is written down — codes 1 / 2 / 12 are the
conta arms, a listed handful `ack`, everything data-bearing whose owning step is
unbuilt **parks**, and an unlisted code parks too, which is the only signal a new
code appeared.

Three rows were added by the sandbox push test of 2026-09-09. **Code 0** is
undocumented: it is the console's own "Verify and Save" message (`verify_info`,
no `shop_id`, no `timestamp`), and it `ack`s and never parks, because otherwise
every click on that button leaves a row behind; its identity is the default
branch, `0:-:-:-`. **Codes 24 and 25** are documented — the logistics *booking*
pushes `booking_trackingno_push` (push_api_id 27) and
`booking_shipping_document_status_push` (push_api_id 28), both "New Push" of
2024-07-02 — and were simply missed by the doc survey; the sandbox is what made
them arrive, unlisted, and park. Both still **park**, keyed on `booking_sn`,
until steps 7 and 15 own them. They arrived unlisted first, which is that
signal doing its job.

⚠️ **The app type does not gate what the console can send.** An ERP System app
cannot receive `webchat_push` (code 10) per `guide 18`, which is why that code
parks instead of routing to step 16 — and the sandbox console still offered its
test data to exactly such an app on 2026-09-09. Treat the app-type table as a
statement about live traffic, never as an input filter.

⚠️ **An unbuilt handler PARKS, it never DEFERS.** `defer` means a precondition
outside this system will clear on its own, and it costs a daily re-drive for
`MAX_TENTATIVAS_DEFERRED` days; a handler that does not exist is cleared by
shipping a step. What defers here is a short, closed list — and the code-2 row
is the counter-example that keeps it from becoming "an unmapped shop always
defers":

| what | why it defers |
| --- | --- |
| **code 1**, ONE named shop that maps to no active integração | a seller who has not connected yet; the re-drive only RESOLVES rows |
| **code 3**, a shop that maps to no active integração | ⚠️ the OPPOSITE reading of the same fact — see below |
| **code 3**, `ShopeeReauthRequiredError` / the three credential classes / a conta that vanished | a human re-consents or fixes the conta; `kind: 'pedido-adiado'` |
| **code 3**, Shopee's DAILY quota (`error_limit`) | resets 00:00 UTC+8; the daily lane's cadence is what brackets it — a burst limit THROWS instead |
| ⚠️ **code 2**, the same unmapped shop | **ACKED, not deferred** |

⚠️ **The code-2 inversion, and why code 3 goes the other way.** For a code 2 the
event that clears the precondition (the operator connecting the shop) is exactly
the event that makes the news FALSE: a re-drive up to seven days later would
raise `shopeeDesautorizado` for a shop that is authorized and syncing, with no
stored `relogioEvento` to reject it, since nothing was ever written. For a code 3
that same connection makes the order **actionable** — it still exists at Shopee
and `get_order_detail` will still return it. Acking it would leave every order
placed before a late connection reachable only through the backfill's initial
24-hour lookback, so a conta linked more than a day after the first sale would
lose them in silence.

✅ **Code 3 routes to the order importer (step 5), and that flip ARMED the order
backfill.** While it parked, a synthesized code 3 would have left one TERMINAL
document per order per tick — up to 1 000 per conta — so `runShopeeOrderBackfill`
refuses to run while `destinoDoCodigo(3) === 'parado'`, on top of its env flag.
That guard READS the dispatch table, so `DISPATCH[3] = 'pedido'` flipped it
without a line of change in `orderBackfill.ts`. ⚠️ **`SHOPEE_ORDER_BACKFILL_ENABLED=1`
is now the ONLY remaining gate on the backfill**, and turning it on is a runtime
env change in the migration window (root CLAUDE.md rule 8) — surface it, do not
do it.

Shopee ships **no event id**, so the doc id is derived per code from the
resource key inside `data` (`ordersn`, `item_id`, `return_sn`,
`package_number`, …), through the same `asDocId` guard ML uses — a missing
segment becomes `-`, never nothing, and `.`/`..`/`/`/`__x__`/>1500 chars refuse
into an auto id.

## The authorization-expiry sweep and the avisos inbox (step 3, P8)

`sweepShopeeAuthorizationExpiry` runs Mondays at 04:00 America/Sao_Paulo. It
enumerates the partner's authorized shops through the **Public-signed**
`get_shops_by_partner` — so it reads no token and never touches a
`/credenciais/` path — and for each shop that maps to an active integração:
`dias <= 30` raises the expiry aviso, anything above resolves it.
⚠️ `shopeeDesautorizado` is resolved on **both** branches, before that test:
being enumerated at all is proof the shop is authorized again (a de-authorized
shop leaves `authed_shop_list` entirely), and tying that row to the healthy
branch left a re-consent shorter than 30 days standing forever on a
`serverOwned` collection nobody can dismiss by hand.

**Weekly, not monthly, and that is load-bearing:** a 30-day warning window on a
monthly cadence can miss an expiry entirely (run on the 1st and see 58 days; the
next run sees it already expired).

The sink is Lucas's avisos inbox (#1543), reached through
`escreverAviso`/`resolverAviso` in `@delfrance/data/admin/avisos`. Three things
about that seam:

- **The chave carries NO `janela`** — one row per (conta, shop), forever. A
  window keyed on the expiry date would make the resolver compute a key that was
  never created, because a re-consent MOVES the date, so the row would stand
  past the 90-day retention sweep. A repeat bumps `ocorrencias` and refreshes
  `params.dias` without moving `criadoEm` (no nagging); a lapse after a resolve
  reopens with a fresh `criadoEm`.
- **The stamps are microseconds** and `lib/shopee/avisos/autorizacao.ts` is the
  only place that knows it. Everything upstream — the sweep, the push arms, the
  shops reader — is milliseconds.
- **The WEEKLY CRON omits `relogioEvento`; the `push 12` arm supplies it.** Both
  go through the same sweep body, which carries the clock as the optional
  `ExpiracaoSweepDeps.relogioEventoMs` and spreads it onto the aviso only when it
  is defined. `camposInformados` reads an absent optional as "I do not know" and
  a `null` as "set it to null", so passing `null` from the cron would RESET a
  watermark a real push had already advanced — and a reset watermark is a guard
  that never rejects anything again.

`push 12` (Shopee's own 7-day warning) runs the **same producer**: it dedups
`data.shop_expire_soon[]`, intersects with mapped integrações and re-runs the
sweep scoped to those shop ids. ⚠️ It cannot build the aviso from
`data.expire_before` — that is a BATCH cutoff, not a per-shop expiry — so the
scoped run re-reads each shop's real `expire_time`. One producer, two triggers,
one row.

`push 1` (re-authorization) RESOLVES both Shopee avisos for the shop; `push 2`
(cancellation) raises `shopeeDesautorizado` with `motivo` = the `authorize_type`
Shopee sent. Neither writes the conta document — the conta screen derives its
clocks live.

`shopeePushDegradado` / `shopeePushSuspenso` got their producer in **step 4**:
`lib/shopee/avisos/pushSaude.ts`, driven by the daily `monitorShopeePushConfig`.
Both chaves are `chaveDeAviso({ tipo })` with **no conta** — the config is
app-wide, so there is exactly ONE global row per tipo, and `ROTAS_AVISO.inicio`
is the only conta-free route there is.

| `live_push_status` | degradado         | suspenso                          |
| ------------------ | ----------------- | --------------------------------- |
| `Normal`           | resolve           | resolve                           |
| `Warning`          | RAISE (`atencao`) | resolve                           |
| `Suspended`        | untouched         | RAISE (**`critico`**)             |
| unknown / absent   | untouched         | untouched (one `warn`, raw value) |

Four things that table encodes:

- **`Suspended` does not touch degradado at all.** Resolving it would read as
  "the degradation cleared" on the day it got worse, and raising it would
  duplicate the news. Only `Normal` closes rows, and `resolverAviso` reports a
  TRANSITION — so `resolvidos` counts rows actually closed, never "we asked
  about two rows".
- **Suspenso is `critico`** — the one Shopee state whose loss is irrecoverable:
  a disabled subscription is never queued, so the lost-push sweep cannot help
  and `backfillShopeeOrders` is the only recovery.
- **The fold is trim + lowercase then an EXACT match**, never `startsWith`:
  Shopee's page documents `Normal`/`Warning`/`Suspended` while its own sample
  answers lowercase `suspended`, and `'normalizado'` starts with `'normal'`. An
  unrecognised value raises nothing, resolves nothing and logs the string
  verbatim — the only record of a value we do not know.
- **`suspended_time` is the aviso's `relogioEvento`, spread-or-nothing, and
  never its `prazo`.** It is a START, not a deadline; and an absent one must
  leave a stored watermark alone rather than reset it (`camposInformados` reads
  an absent optional as "I do not know" and a `null` as "set it to null").

## Delivery backstops (step 4, `functions/` + `lib/shopee/notificacoes/`)

Three `onSchedule`s in the nested codebase, each covering a different way a push
never arrives. They are what decision P3 spends the receiver's scale-to-zero
cold start on.

**`sweepShopeeLostPushes` — every 2 h at :20.** Shopee queues a push that
exhausted its ladder (+5 min / +30 min / +3 h) for **3 days**, "the earliest 100
lost and not confirmed". Paging is cursor-by-ACKNOWLEDGEMENT: the only way to
advance is to confirm, so ONE entry we never make durable blocks every later one
until it expires. Hence the ordering rule — **every entry enqueued, persisted
`failed` or parked FIRST, then one confirm per page** — and hence "never confirm
an empty page" (`last_message_id` is documented as the END ENTRY of the current
call; with no entries there is no end entry, and the watermark's semantics are
nowhere written down).

- An entry's `data` is a **STRING** holding the whole original envelope, so it
  is `JSON.parse`d as `unknown` and re-read through the receiver's own
  `parseNotificationBody`. The list-level `timestamp` is the LOSS clock, never
  the event clock — an envelope is never synthesized from the list fields.
- An **unreadable** entry (not JSON, not an object, no integer `code`) becomes a
  terminal `parked` row and the page IS confirmed: refusing would jam a
  100-entry page for three days to satisfy one entry nothing can ever handle.
  Its identity is keyed on `_lostPush.ref` (`<last_message_id>_<index>`),
  because two bad partner-level entries in the same second would otherwise share
  one derived id and the second would vanish into a swallowed `create`.
- In-tick dedup is on **`docIdOf`, not `dedupKeyOf`**: the doc id keeps the
  carimbo, so two events about one order with different `update_time` stay two
  jobs. Dropping the carimbo would confirm the second away.
- ⚠️ **No `*_ENABLED` flag** — a backstop that ships OFF is #778's failure, and
  this sweep publishes nothing to Shopee. The one valve is
  `SHOPEE_LOST_PUSH_CONFIRM_DISABLED`, below.

**`backfillShopeeOrders` — every 15 min, per conta, DOUBLY gated.** Pages
`get_order_list` on `update_time` from a durable per-conta cursor and enqueues
one **synthetic code-3** per `order_sn`, so the step-5 arms stay the single
writer. It is the only way to reach `PENDING` / `RETRY_SHIP` /
`TO_CONFIRM_RECEIVE` / `TO_RETURN` orders (the `order_status` filter cannot list
them, so the sweep sends no filter at all) and the only documented recovery from
a suspended subscription.

- The window is `from = cursor − 5 min` (or `now − 24 h` on a cold cursor) and
  **`to = min(from + 15 d, now)`** — measured from `from`, never from the
  cursor: `cursor + 15 d` plus the overlap exceeds Shopee's own bound and comes
  back as `order.order_list_invalid_time`.
- Paging terminates on **`more === false` only**, never on a row count: the
  page's own sample returns 10 rows for `page_size=20` with `more: true`.
- A drained window advances the cursor to `to` (never to `now` — `[to, now]` was
  not queried); a **truncated** one advances NOTHING and persists a pending
  triple the next tick replays, because the rows carry no timestamp and a
  partial advance is inexpressible.
- The cursor doc (`packages/schemas/src/backfillPedidosShopee.ts`, a bare const
  outside `ALL_DOMAINS`) is in **milliseconds** and this sweep is its only
  writer — one `merge` per conta per tick, no transaction.

**`monitorShopeePushConfig` — daily at 05:45.** One Public GET; the table above
is its whole decision. Three further findings are **log-only**, because no aviso
tipo covers them: a `callback_url` that differs from `shopeePushCallbackUrl()`
BYTE FOR BYTE (it is inside the HMAC base string, so a "cosmetic" slash IS the
defect), our codes 1/2/3/12 appearing in `push_config_off_list`, and a non-empty
`blocked_shop_id`. ⚠️ `set_app_push_config` is **never** implemented in the
package — the absence is the enforcement: the config is app-wide with one
`callback_url`, setting it fires a live test push, and its partial-body
semantics are undocumented, so a read-modify-write would silently drop every
code above 13.

## Order import (`lib/shopee/pedidos/`, step 5)

One code-3 delivery — a real push or a synthesized one from the backfill —
becomes one `pedidos` document. **The push body is never trusted**: the handler
re-fetches `get_order_detail` (and `get_escrow_detail`) and maps THAT, which is
also what makes it idempotent under the backfill's 5-minute window overlap. The
envelope's clock is the SYNTHESIS clock and is used only for the doc id; the
watermark is `get_order_detail.update_time`.

**Two settle-live literals, and they live one search apart on purpose:**

| literal | where | state |
| --- | --- | --- |
| `DETALHE_PRECO_E_TOTAL_DA_LINHA` | `lib/shopee/pedidos/itens.ts` | ✅ **settled `false` — the detail price is PER UNIT.** Lucas's SG sandbox order of quantity 2 (2026-09-09) reads `15 × 2 + 1.99 = 31.99`. It survives as the named seam, not as an open question. |
| `SHOPEE_ESCROW_DETAIL_TRANSPORT` | `packages/integrations/shopee/src/api.ts` (`'get-query'`) | ⏳ **open** — the escrow page renders as GET and samples a JSON body. ONE literal flips the verb AND the placement together, because a GET cannot carry a body through `fetch`. Waiting on Lucas's `get_escrow_detail` paste. |

⚠️ **A wrong transport guess surfaces as `error_param`, never as `error_sign`.**
The shop base string is `partner_id + path + timestamp + access_token + shop_id`
— the HTTP verb is NOT in it (measured; do not re-assert the opposite, as an
earlier draft did). So the signature stays valid and Shopee simply cannot find
the parameters.

**Identity: a digest, never a query.** `makePedidoIdShopee(contaId, orderSn) =
sha256("<contaId>-<order_sn>")` — **byte-exact with the legacy Shopee importer's
preimage**, because the legacy corpus survives the cutover with its ids and a
different spelling forks every migrated Shopee pedido on its first re-import.
The transaction `tx.get`s that id and `tx.create`s when absent. There is
deliberately **no** `pedidos (integracaoPedidoOuterRef, numero)` query and no
such index: `integracaoPedidoOuterRef` is not a marketplace discriminator (the
pedido form requires a human-created pedido to set it), so that query can match a
manual pedido whose `numero` an operator typed. Steps 6/7/8/14/17 derive the same
id from `(contaId, order_sn)` — there is **no `orderML`-shaped mirror collection
for Shopee and none is to be invented**.

**ONE transaction, class C** (`orderPedidoTx.ts`, inventoried in
`firestore-transaction-inventory.test.js`). Two Shopee calls happen before it
opens, so the mapped body is captured OUTSIDE and re-applied on an OCC retry —
which is why the guard is a re-read inside the callback: it compares the stored
`lastMarketplaceUpdate` (through `coerceToMicros`, because the legacy corpus
holds milliseconds and ISO strings) against the incoming watermark and re-derives
every written value from that snapshot. ⚠️ **Accept is `>=`, not `>`**: Shopee's
stamps have 1-second resolution (`UNPAID → PENDING → READY_TO_SHIP` inside one
second share one), and a strict comparison could never converge after a crash
between two writes. An equal stamp RE-MAPS; the mapper is pure, so a replay
produces an empty patch and the named outcome `ignorado-sem-mudanca`.

**The ladder is enumerated in BOTH directions** (`orderStatusMaps.ts`):
`UNPAID`/`PENDING` → `aguardandoConfirmacaoDePagamento` (⚠️ which RESERVES stock
— deliberate: overselling across channels is unrecoverable, and a held unit is
released by the `CANCELLED` push), `READY_TO_SHIP`/`PROCESSED`/`RETRY_SHIP`/
`SHIPPED`/`TO_CONFIRM_RECEIVE`/`COMPLETED` → `pago` (the ceiling for any
marketplace path; `finalizado` stays an ERP-side transition), `IN_CANCEL` →
`processandoCancelamento`, `CANCELLED` → `cancelado`, `TO_RETURN` → keep the
estado (the marketplace status rides in `pedido.marketplace.status` verbatim),
anything else → `error` with our own prefix. Monotonicity: an estado outside the
governable set is never walked back (an operator's `finalizado` stands), and
`pago → aguardandoConfirmacaoDePagamento` is REFUSED — a late `UNPAID` must not
un-pay a shipped order. ⚠️ **`cancelado → pago` is ALLOWED** and logged as a
resurrection: the ladder is driven by a re-fetch of the live order, so an
absorbing terminal state would strand a live sale as cancelled with its stock
already released. The importer moves NO stock — `onPedidoEstoqueSync` reacts to
`estado` and owns that.

**Zero-fill is Shopee's house style, so `??` on a numeric wire field is a bug.**
The SG sandbox order carried `actual_shipping_fee: 0` while the buyer had paid
1.99, plus `edt_to: 0`, `pickup_done_time: 0` and a zero chargeable weight. ONE
reader — `positivoOuNull` — guards every one of those fields; the legacy's
`actual ?? estimated` is exactly how a `valorCobrado: 0` reaches every unshipped
order.

**`prazoDespacho`: Shopee's own deadline first, the 14:00 rule as a FALLBACK.**
`ship_by_date` wins whenever it clears the 2020-01-01 floor (a `0` is the
zero-fill case, and it reads as 1969 in BRT). Only when it is absent does the
importer derive the dispatch day from `pay_time` through the ERP's shared cutoff
helper — `getPrazoDespachoNoFuso(HORARIO_DE_CORTE_PADRAO_SHOPEE, payTimeMs,
'America/Sao_Paulo')`, an EXPLICIT zone, never the browser-bound
`getPrazoDespacho` and never the legacy's fixed −3 h (`no-ambient-timezone` says
why: `apps/nfe` runs on `America/Sao_Paulo` while every other backend is UTC).
⚠️ It is a fallback, never an override and never a `min()` — a valid
`ship_by_date` reaches `freteInicial` verbatim.

**Produto resolution, in rungs**: `variashopee.model_id` (skipped when `model_id`
is null or `0`) → `prodshopee.item_id` — the rung that also answers a KIT line,
since the ERP kit produto owns its components and `kit_items` is NEVER exploded —
→ the shared SKU cascade in `@delfrance/data/admin/produtos` → the `'NONE'`
bucket. An unbound line is kept, never dropped, and raises one non-blocking
`incidentes` doc at a deterministic id. ⚠️ Both group queries need the composite
indexes `variashopee (model_id, contaVariacaoShopeeOuterRef)` and
`prodshopee (item_id, contaProdutoShopeeOuterRef)`; until they deploy (**#1532**,
migration window) they full-scan, and on Enterprise a missing index does not
throw — it bills the scan. On staging every line takes the unresolved arm anyway,
because step 9 has not written a link document yet.

**Buyer capture.** Name and CPF are written only when BOTH pass one shared
usable-value predicate (`packages/schemas/src/valorMascarado.ts`: non-empty, no
`*` anywhere, a CPF/CNPJ with valid check digits), and only inside Shopee's
unmask window. Capture is **fill-once per FIELD** and tx-fresh: a masked or
absent value is written nowhere, and an already-linked cliente is never unlinked
by a later masked import. A refused import stamps `pedido.capturaComprador` with
field NAMES and verdicts — never a value — and that block is a **diary, not a
gate**: the decision is re-derived from the fresh wire payload on every delivery,
so nothing reads it to decide anything. The region test is the ORDER-level
`region`, never `recipient_address.region`, which is masked exactly when it
matters. No phone is ever stored, and `buyer_username` is never a legal name.

**Errors → dispositions** are one exported pure table,
`disposicaoDaFalhaDeImportacao` in `notificacoes/notificacao.ts`: burst
rate-limit, Shopee-side transients, network/HTTP, a held refresh lease, gRPC and
`ShopeeConfigError` **throw** (the queue's ladder, then the sweep, then a parked
row ~5 h later); the daily quota and the human preconditions **defer** (the table
under **Inbound push**); an unreadable schema, a Shopee `error_*` we cannot act
on, a conta with no `shop_id` and a `ZodError` from the write **park**, with the
class and Shopee's `code` in the reason and never a value. `order_not_found` is
the one wire outcome the importer RETURNS instead of throwing, and the arm parks
it carrying which of the two shapes it was — Shopee's 404, or a backfill list
that denied a row it had just returned.

## Taxonomy reads (`lib/shopee/taxonomia/`, step 10)

Seven Shop-signed GETs on Shopee's `product` module — the category tree,
attributes, brands, item and kit bands, standardised variations, and category
suggestions — behind seven `createReadCache`s at `READ_CACHE_TTL.config`
(15 min). **Step 10 writes nothing**: no Firestore document, no index, no
ruleset, no migration-window item.

**Every cache key starts with `integracaoId`.** This is the one deliberate
difference from `apps/mercado-livre`'s `mlMetadataCache`, which keys a category
by its id alone — correct there, because ML catalog metadata is global. Shopee's
is not: the tree is served per shop and in the shop's region, and the item bands
are per shop AND per category (guide 209 §1.1/§6; every number on the page is a
SAMPLE). A key without the integração would serve one conta's price ceiling, DTS
band or brand page to another, silently, in the direction that publishes.

**The leaf gate has THREE values** (`ehFolha`): `folha` (`has_children === false`,
exact), `nao-folha`, and `desconhecida` — the id is not in this shop's tree,
which is a **404** (`SHOPEE_CATEGORIA_DESCONHECIDA`), never "has children".
Attributes, brands, variations and the KIT bands gate on it (a non-leaf answers
200-with-nothing and makes ZERO calls to the gated operation — `get_category`
itself is still read, once per cache window, because that is what the gate
consults); the ITEM bands do **not**, because `category_id` is documented
optional there and its absence is a real read (`scope: 'shop'`).

⚠️ **The whole ~10⁴-node tree never crosses our wire.** `get_category` is unpaged
and returns everything; it is indexed once per cache window and the categorias
route answers lookups over that index — roots, or one node with `pathFromRoot`
and `children`.

**Four contradictions in Shopee's own docs, each instrumented rather than
guessed** (the `hosts.ts` technique — settled by one live sandbox call, flipped
by one literal or one env var):

1. **The `get_variations` path.** The page's `path`/`url`/`test_url` say
   `/api/v2/product/get_variation_tree`; all four of its samples call
   `/api/v2/product/get_variations`. The package defaults to the samples and
   `SHOPEE_VARIATIONS_PATH` overrides it. The path is INSIDE the HMAC base
   string, so the wrong one fails as `error_sign`, which reads like a bad partner
   key — hence the `variacoes` route echoes `pathUsed`.
2. **`category_id_list` vs `category_ids`.** The parameter table says the first,
   the page's own cURL says the second. The app sends ONE category per call,
   which serialises identically under both, and logs `error_param` raw with the
   parameter name it sent.
3. **`gtin_limit`'s position.** The item page renders it as a SIBLING of
   `response` and ships no response sample. Both positions are declared;
   `lerLimitesDeItem` merges them (inner wins, both absent stays `null` and never
   `{}`).
4. **The language casing.** `get_category` spells it `pt-br`,
   `get_attribute_tree` spells it `pt-BR`. ONE constant
   (`SHOPEE_TAXONOMY_LANGUAGE = 'pt-br'`) goes to all three ops, so a wrong guess
   is one literal to flip and `error_invalid_language` is the signal.

**Values that are data, not absences:** `brand_id: 0` is Shopee's "No Brand"
(a choice the operator makes), `variation_option_id: 0` is the observed CUSTOM
option, `parent_category_id: 0` marks a root, and **`-1` on `days_to_ship_limit`
means "no pre-sale"** (guide 209 §4) — never clamped, and read by
`suportaPreVenda`, whose wrong-way default is `false`.

**The kit bands are their own.** `get_kit_item_limit` has its own path, its own
schema and its own numbers; the two pages disagree field by field, and only the
kit declares `support_pre_order` and `component_count_limit_of_single_model`.
⚠️ Do not confuse that boolean with the item route's derived `supportsPreOrder`.

**No auto-paging.** `get_brand_list` answers ONE page; `nextOffset` is Shopee's
cursor, echoed verbatim (it is not `offset + pageSize`), and the caller asks for
the next one.

**`brandshopee` is untouched, and stays the curated shortlist.** Shopee's brand
API is extremely slow, so the supported brands are registered once and read from
our own database — the produto's brand dropdown reads `integracao/{id}/brandshopee`,
the `marcas` route serves only the REGISTRATION picker, and the shortlist is
maintained from the conta screen (step 21) and re-validated at publish (step 11).

**Recommendations are OFFERED, never applied** (`applied: false`, #799), and a
suggested id absent from the tree degrades that ROW (`unresolved`, one log line)
while a failure of the TREE read surfaces. Limits failures surface too — a
FAILURE never degrades to `limites: null`, because step 11 must not publish
against hardcoded numbers. The only `limites: null` in the layer is the kit
route's non-leaf short-circuit, which pairs it with `leaf: false`.

`limparTaxonomiaShopee()` clears all seven caches at once, coarse on purpose:
the primitive has no prefix scan. ⚠️ **Correction (step 3):** an earlier revision
said `push 13` was where granularity would earn its keep. It is not — `push 13`
is the brand-register RESULT and the dispatch table `ack`s it, invalidating
nothing. Nothing in step 3 clears a taxonomy cache; whichever step first reacts
to a brand or category change is where the question comes back.

## Rules specific to this app

1. **No UI code** beyond the placeholder root page. Thin route handlers.
2. **Auth is per-endpoint**: Firebase ID token (`verifyCaller`) for
   `/api/marketplace/shopee/*`; the signed OAuth `state` for the callback; the
   `Authorization` HMAC over `callback_url` + raw body for the push receiver. No
   Firebase Auth user sessions, and no `verifyCaller` on the receiver — it is a
   server→server call from Shopee.
3. **All Firestore access via `@delfrance/data/admin/collections` handles** —
   raw `.collection()`/`.doc()`/`.collectionGroup()` is lint-banned (except the
   `lib/firebase/admin.ts` singleton).
4. **Secrets in Cloud Secret Manager** (`SHOPEE_PARTNER_KEY`,
   `SHOPEE_STATE_SECRET`). Never committed, and **never logged** — the partner
   key signs every call, and a `code` is a live credential until it is exchanged.
   A schema failure logs field PATHS, never the body: on the token endpoint that
   body IS the credential (#1015).
5. **CORS** is handled by `proxy.ts` (Next 16 middleware) for
   `/api/marketplace/*` only. The callback and the push receiver both sit OUT of
   the matcher already (no browser preflight) — step 3 needed no `proxy.ts` edit.
6. **Two apps, ONE code path.** Staging uses the ERP System **test** app against
   the sandbox hosts (`SHOPEE_SANDBOX=1`); production reuses the **live legacy**
   application against the production hosts. The difference is credentials and
   env, never a branch in code. ⚠️ `SHOPEE_SANDBOX` is therefore **opt-in**
   (exactly `'1'`), the OPPOSITE polarity of `MELHOR_ENVIO_SANDBOX`: an unset
   value on a deployed backend must mean production.

## Env added by step 3

Three, all in the repo-root `.env.example` (one root template set, #730) — none
of them a secret:

- **`SHOPEE_PUSH_CALLBACK_URL`** — the EXACT url registered in the Shopee
  console, used byte for byte inside the HMAC base string. Unset or blank ⇒ the
  receiver answers 503. One url per app; registering it is #1534.
- **`SHOPEE_TASKS_REGION`** — must equal the `FUNCTIONS_REGION` inlined into the
  functions bundle. No default: an unset value THROWS on the first enqueue
  rather than resolving to `us-central1` and dropping the task behind a 204
  (#1108). `apphosting.yaml` ships it blank on purpose until step 22 deploys the
  codebase — blank reads as unset, so today the enqueue throws and the sweep
  drains, which is loud and lossless.
- **`SHOPEE_TASKS_DISABLED`** — `'1'` puts the channel in sweep-only mode: the
  enqueue throws, the receiver persists each push as `failed`, and the 30-minute
  reprocess sweep drains it. Never a silent drop, and never a 5xx. The lost-push
  sweep degrades the same way: its enqueue failure is persisted `failed`, which
  COUNTS as durable, so the page is still confirmed.

## Env added by step 4

Two more, both in the root `.env.example`, neither a secret, and **both read
only by the nested functions codebase** — their real home is
`apps/shopee/functions/.env.deploy` (gitignored; see `functions/DEPLOY.md`). A
value set in `apphosting.yaml` would be read by nothing.

- **`SHOPEE_ORDER_BACKFILL_ENABLED`** — `'1'` and nothing else enables
  `backfillShopeeOrders`; it SHIPS OFF, and while off the function deploys,
  ticks, logs one info line naming the variable and reads nothing at all.
  ⚠️ **Since step 5 it is the ONLY gate.** It used to be the weaker of two — the
  structural guard refused the sweep while push code 3 parked — and
  `DISPATCH[3] = 'pedido'` retired that half. Turning this one on is a runtime
  env change for the migration window (rule 8): the first enabled tick enqueues
  one task per order in the cursor window, and each of those writes a pedido.
- **`SHOPEE_LOST_PUSH_CONFIRM_DISABLED`** — `'1'` makes `sweepShopeeLostPushes`
  read, parse and enqueue as usual but SKIP the confirm. It exists for ONE
  rehearsal: the sandbox cannot exercise the lost-push APIs at all, so the first
  call is production, and this proves the whole path without sending an
  irreversible ack. ⚠️ Opt-in-to-DISABLE, so an unset or blank value can never
  leave the sweep inert — the opposite polarity to every `*_ENABLED` here. While
  it is on, the tick stops after page 1: the queue did not advance, so the next
  read would return the same entries.

## CI

`ci-shopee.yml` carries exactly ONE suite job, `Shopee Cloud Tasks round trip`,
behind the unskippable `CI gate (shopee)`. It builds the functions artifact and
runs `*.tasks.test.ts` against firestore + functions + tasks emulators
(`firebase.shopee.tasks.json`, ports 8084/5003/9500).

Two deliveries go through that hop: an unknown push code (→ `parked`) and, since
step 5, a **code 3 naming a shop that maps to no integração** (→ `deferred`).
Both are chosen for the same reason — they are the only outcomes that write a
document without any Shopee call. ⚠️ The lane's fetch kill-switch lives in the
VITEST process and does **not** cover the dispatched function, which runs in the
emulator's own process, so a code-3 case that reached `importarPedidoShopee`
would really leave the runner. Keep the tasks suites on paths that need no token.

⚠️ The lane's `push: paths:` grew with step 5 (`packages/schemas/src/pedido/**`,
the cliente/endereço/`intFrete` schemas, `packages/data/src/admin/{clientes,produtos,enderecos}/**`
and `packages/data/src/pedido/**`) because the importer reaches all of them.
`pull_request:` still has **no** `paths:` and never may — the `changes` job
derives that closure from the workspace graph.

⚠️ **This lane owns no exclusion, and that is the point.** Unlike
`ci-mercado-livre`, `ci.yml` still runs every `@delfrance/shopee-app` unit test
in `CI test` — unfiltered, no `if:`. So a skip here loses the emulator round trip
and nothing else. Do not add a `ci.yml` filter for this workspace without moving
the offline job into this lane in the same commit; an exclusion is a promise.

⚠️ **The suites are disjoint BY GLOB.** `vitest.config.ts` excludes
`**/*.tasks.test.ts` and `**/*.firestore.test.ts`; `vitest.tasks.config.ts`
includes only the first. A file matching NEITHER runs in NO job. The
`*.firestore.test.ts` half is listed before that lane exists — it is step 22's
(#1530) — precisely so nobody has to remember it then.

The lane is offline by construction: `vitest.tasks.setup.ts` throws when
`FIRESTORE_EMULATOR_HOST` or `CLOUD_TASKS_EMULATOR_HOST` is missing under
`CI`/`REQUIRE_EMULATOR` (a skipped suite exits 0 — vitest counts COLLECTED
files), and installs a fetch kill-switch on every non-localhost host. That last
one matters more here than for a channel with no sandbox: Shopee's refresh token
is single-use and rotating, so one unstubbed refresh burns a real account's
credential.

## Dev

```bash
cd ../.. && cat .env.example .env.secrets.example > .env.local && cd apps/shopee   # ONE root template set (#730) — fill in
pnpm --filter @delfrance/shopee-app dev   # :3009
curl http://localhost:3009/api/health
```

Set `NEXT_PUBLIC_SHOPEE_URL=http://localhost:3009` so apps/web targets this app.

The `/canais/shopee/[id]` panel (step 21a) is the normal connect path —
**Conectar conta** starts the OAuth round trip from the browser. The script
below is now the headless fallback for when there is no web UI to click
through:

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
Firebase console / Secret Manager. The nested Cloud Functions codebase
(`functions/`) deploys separately — see **`functions/DEPLOY.md`**, including the
three IAM roles the receiver needs before it can enqueue.
`firebase.shopee.deploy.json` shipped with step 3 and is **inert**: a config file
deploys nothing, running it is a manual coordinated human step (root CLAUDE.md
rule 8), and the ROLLOUT — plus `firebase.shopee.json`, `vpcAccess`, the real
`SHOPEE_TASKS_REGION` and flipping `implementado` — is still step 22 / #1530.

⚠️ An **ERP System** Shopee app has no console "Authorize" button, so
`oauth/start` (or the script above) is the only way to reach the consent page,
and the redirect URL's **domain** is registered per app in the Shopee console —
`https://<this-app>/api/oauth/shopee/callback`.

⚠️ **Static egress is a prerequisite, not a step here.** Shopee's IP allow-list
(master plan P2, option D: a VPC connector, a subnet, a firewall rule, a reserved
IP and a proxy VM) is migration-window infrastructure (root CLAUDE.md rule 8) —
see #1208 when that window is scheduled. `apphosting.yaml` carries no
`vpcAccess`, deliberately.
