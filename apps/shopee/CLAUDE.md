# apps/shopee — CLAUDE.md

API-only Next.js app for the **Shopee Open Platform** sales channel. One App
Hosting backend per channel (ADR 0015), so its logs and deploy are isolated.
Runs on `:3009` in dev. Steps 1–10 of
`.master_plans/shopee/shopee-marketplace-integration.md` — **OAuth connect,
conta status, the access-token refresh, the cached taxonomy reads, the inbound
push receiver with its Cloud Tasks queue, nested functions codebase, weekly
authorization-expiry sweep and the step-4 delivery backstops, the
step-5 order → pedido import, the step-6 pagamentos with their weekly
escrow settlement sweep, the step-7 shipment tracking that merges a
per-package observation into the pedido's `freteInicial`, the step-8 weekly
stuck-reservation sweep that re-drives — and, where it cannot decide, SURFACES —
a pedido still holding a stock reservation past the horizon, and the step-9
product import (an anúncio → a produto, one at a time or the whole shop through
a resumable Cloud Tasks job)**.

⚠️ **Step 5 is where this app started writing ERP business data** — `pedidos`,
`clientes`, `enderecos`, `incidentes`, since step 6 the
`pedidos/{id}/pagamentos` subcollection, and since step 9 the **catálogo**
itself (`produtos`, `grupoDeVariacoes`, `categorias`, `arquivos`, `prodshopee` /
`variashopee`) — so the old blanket "this app writes nothing" is no longer true
and must not be re-asserted. ⚠️ And since step 11 the app WRITES listings TO
Shopee (`add_item`, the tier/model APIs, `unlist_item`, `upload_image`), beside
the three other state-changing calls it
makes: the OAuth exchange, the token refresh and the lost-push CONFIRM. All
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
  `lib/shopee/shopeeTasks.ts`, step 12's stock knobs in
  `lib/shopee/estoque/constantesEstoque.ts`, and the nested `functions/`
  codebase. The blank-guard rule is enforceable precisely because it is scoped
  to the Shopee values. ⚠️ `SHOPEE_VARIATIONS_PATH`
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
- `lib/shopee/core/contas.ts` — `listarContasShopeeAtivas`, the ONE
  `integracao (tipo, ativo)` enumeration every per-conta sweep walks. Promoted
  out of `orderBackfill.ts` by step 6, verbatim and with its docblock; the
  backfill became a caller and its test file is byte-unedited.
- `lib/shopee/core/containment.ts` — `erroContidoPorConta` (+ `isGrpcCodedError`),
  the per-conta error boundary the order backfill and the settlement sweep now
  share. It names the classes and **never** the `ShopeeError` base:
  `ShopeeConfigError` extends that base directly, so catching the base would
  swallow our own misconfiguration and turn #778 into N identical log lines and
  a green tick.
- `lib/shopee/pedidos/` — the step-5 order import: `importarPedido.ts` (the
  orchestrator), `orderIds.ts` (the deterministic pedido and item ids),
  `orderMapping.ts` + `orderFreteMapping.ts` + `orderStatusMaps.ts` (the pure
  mappers, the estado ladder and the freight seed), `itens.ts` (prices and
  quantities), `produtoResolve.ts` (the link → SKU cascade), `comprador.ts` (the
  buyer-capture adapter), `incidentesProduto.ts` (one incidente per unbound
  line) and `orderPedidoTx.ts` (the import's ONE transaction — step 6 adds two
  more under this same folder, see the two bullets below). See **Order import**
  below. ⚠️ `importarPedido.ts` is split in two on purpose:
  `prepararImportacaoPedidoShopee` is the READ-ONLY half (the two Shopee calls,
  the produto cascade, the mappers, the stored-pedido read) and
  `mapearPreparoPedidoShopee` turns it into the four write groups;
  `importarPedidoShopee` is that pair plus the writes. The rehearsal script's
  dry-run calls the same two functions, so there is no second copy of the
  sequence to drift — and its "writes nothing" is structural, since no writer
  appears in the read-only body.
- `lib/shopee/pedidos/pagamentoMapping.ts` + `pagamentoTx.ts` — the step-6
  payment half of that same task: the pure mapper (identity, the N-docs rule,
  the forma/bandeira/parcelas folds, `valor`, `tarifas`, the status ladder, the
  dates and `cartao`) and the SECOND transaction that writes
  `pedidos/{id}/pagamentos`. ⚠️ `tarifasDeShopee` / `diarioMarketplaceDeEscrow`
  live here and are the ONE fee computation in this app — the settlement sweep
  IMPORTS them rather than re-deriving, so the two writers agree by
  construction instead of by a comparison. See **Payments and settlement**.
- `lib/shopee/pedidos/liquidacaoSweep.ts` + `liquidarPagamento.ts` — the weekly
  escrow settlement: the runner (contas, window, `page_no` paging, the per-row
  state machine, the cursor document, the parked rows) and the class-B
  transaction that stamps the pagamento's top-level `liquidacao`.
  ⚠️ `liquidarPagamentosCli.ts` is the pure CLI half, for the same
  `scripts/`-is-outside-vitest reason as `importarPedidoCli.ts`.
- `lib/shopee/pedidos/{fretePushShopee,freteShopeeMapping,freteTx,rastrearPedido,rastrearPedidoSimulacao,rastrearPedidoCli}.ts`
  — step 7's shipment half, one clause each: `fretePushShopee.ts` parses the
  three per-code push bodies into a target (`alvoDoPushDeFrete`) and builds the
  ONE shared `PacoteObservadoShopee` record from either wire page;
  `freteShopeeMapping.ts` is the PURE state model — the `LOGISTICS_*` token →
  `EstadoFrete` table with its two alias pairs, the monotone ladder and
  `estadoFreteShopeeAplicavel`, the per-package freshness policy, the diary merge
  and the N-package fold — and the only module in this app that decides what
  moves physical stock; `freteTx.ts` is the pure `preverFreteShopee` plus the
  class-B `salvarFreteShopee` that rewrites `pedidos/{id}.freteInicial`;
  `rastrearPedido.ts` is the handler the code-4/30/47 arm lazily imports (the
  cheap pedido read, the one `get_package_detail`, the transaction, the bounded
  synthetic code 3); and `rastrearPedidoSimulacao.ts` + `rastrearPedidoCli.ts`
  are the `rastrear:pedido` rehearsal's two testable halves — the dry run (the
  package-set rungs, the batched pull, the per-package and backstop predictions)
  and the pure CLI (args, the two allow-lists, the renderers, the error
  describer). See **Shipment tracking (step 7)** below.
- `lib/shopee/pedidos/{reservaTravadaMapping,reservaTravadaSweep,varrerReservasCli}.ts`
  + `lib/shopee/avisos/reservaTravada.ts` — step 8's weekly stuck-reservation
  sweep, in the same three-part shape step 7 uses.
  `reservaTravadaMapping.ts` is the PURE half — the eleven-member verdict union
  with `VEREDITOS_QUE_AVISAM`, `classificarReservaTravada` (which consults
  `estadoPedidoDeOrderStatus` and no status table of its own), the two ownership
  proofs `provaDeIdentidadeShopee` / `integracaoIdDoPedidoShopee`, and
  `idadeEmDias`; `reservaTravadaSweep.ts` is the tick (the paged candidate query,
  the four gates, the batched `get_order_detail` read, the two effects, the
  reconciliation pass and the counters); `avisos/reservaTravada.ts` is the
  FIRST producer of `TIPO_AVISO.pedidoPrecisaDecisao` plus the machine resolver
  that tipo has owed since it was declared; and `varrerReservasCli.ts` is the
  pure half of the fifth CLI. ⚠️ **The sweep writes no pedido field and runs no
  multi-document atomic write**, so it files no entry in the transaction
  inventory — which is also why none of those modules may NAME that API, even
  in a comment (the guard greps raw text). See **Stuck-reservation sweep
  (step 8)** below.
- `lib/shopee/produtos/` — step 9's product import, the FIRST thing this app
  writes into the catálogo (`produtos`, `grupoDeVariacoes`, `categorias`,
  `arquivos`, `prodshopee` / `variashopee`). Twenty-one modules in five
  families: the seam (`itemLido`, `eixos`, `produtoIds`, `errosImportacao`),
  the pure half (`mapeamento`, `taxonomiaShopeeCore`, `planoImportacao`), the
  IO half (`resolveProduto`, `links`, `taxonomiaShopee`, `categoriaShopee`,
  `fotosShopee`, `estoquePrecos`, `variacoesShopee`, `importarAnuncio`), the
  kit arm (`kitShopee`) and the job with its surfaces (`importacaoMassa`,
  `shopeeMassImportTasks`, `corpoImportacao`, `lerAnuncio`,
  `importarAnuncioCli`). The design is `lib/shopee/produtos/README.md`; the
  rules are under **Product import (step 9)** below.
- `app/api/marketplace/shopee/importar/route.ts` and
  `app/api/marketplace/shopee/importar-todos/{route,status/route,cancelar/route}.ts`
  — step 9's four routes, the first in this app with a POST body
  (`PERM.integracao.write` ×3, `.read` on status): `importar` 200 / 422 with the
  `motivo`; `importar-todos` 202 `{ jobId }`, 409 when one runs, 503 when the
  Tasks valve is closed — checked BEFORE a job is created.
- `functions/src/processMassImport.ts` — the SECOND `onTaskDispatched` (one at
  a time, 300 s, a 3-attempt ladder); enqueued by TWO identities because it
  re-enqueues itself.
- `app/api/marketplace/shopee/publicar/route.ts` — step 11's publish
  (`PERM.integracao.write`): 200 with the summary built BY NAME, 400 for a bad
  body, 404 `SHOPEE_ANUNCIO_NAO_ENCONTRADO`; it is the composition root for the
  clock, the wait and the partner client, because `anuncios/` builds none.
- `app/api/marketplace/shopee/enviar-estoque/route.ts` — step 12's manual stock
  push (`PERM.integracao.write`): **200 even when every listing failed** (a
  per-listing refusal is DATA), 409 `SHOPEE_CONTA_PAUSADA` before any provider
  call, 400 `SHOPEE_CONTA_SEM_DEPOSITO`; oversize is refused on the DEDUPED
  count and never truncated.
- `functions/src/processPriceSync.ts` — `processShopeePriceSync`, the FOURTH
  `onTaskDispatched` (after the push, the mass import and step 12's
  `sendStock.ts`): step 13's `atualizar-precos` job, one dispatch at a time,
  300 s, 3 attempts, re-enqueued by the job itself.
- `lib/shopee/fixtures/` — the redacted wire corpus (`__wire__/`), the
  `redact.ts` path-suffix denylist, the two-layer `piiScan.ts` (residue +
  patterns; the redaction's own FIXPOINT is the strong layer) and the typed
  loaders. **Test-only, imported by no `src` file** — the
  `lib/shopee/testing/fakeDb.ts` precedent. A body enters the corpus only after
  `redact`, and a scan finding never carries the value it found.
- `lib/shopee/avisos/autorizacao.ts` — one of the **eight** modules in this app
  that speak **microseconds**; every other signature is milliseconds. Raises
  `shopeeAutorizacaoExpirando` / `shopeeDesautorizado` and resolves both, and
  since step 4 it also EXPORTS the µs seam
  (`agoraUsDe` / `depsDeEscrita` / `AvisoDeps`) so the push-health producer can
  write avisos without knowing the unit — which is what keeps its own call sites
  countable rather than merely written down.

  ⚠️ **Three arrived with step 5, a fifth with step 6, two more with step 7, an
  eighth with step 8, and naming all of them is the point** — a "the ONE module
  that speaks µs" sentence that has quietly become eight is worse than no
  sentence. This is a
  list of SITES, not of
  helpers: there are still only the three conversions below (seconds → µs,
  ms → µs, and the tolerant coercion of a stored value), and a site earns a
  number here by being a place where the unit changes at all:

  1. `avisos/autorizacao.ts` (above);
  2. `pedidos/importarPedido.ts` — the single `millisToMicros(nowMs)` per run,
     handing `nowUs` DOWN as a parameter to the mapper, the transaction and the
     incidente writer. It is also the ONLY clock read on the pedido path: there
     is no `Date.now()` anywhere under `pedidos/`;
  3. `pedidos/orderMapping.ts`'s `microsDeSegundosShopee` — the ONE
     seconds → µs conversion, for Shopee's second-resolution stamps, whose
     docblock carries the `coerceToMicros` trap (that helper classifies by
     MAGNITUDE and reads a seconds value as MILLIseconds ⇒ 1970 ⇒ a watermark
     comparison that answers "older" forever);
  4. `pedidos/orderFreteMapping.ts`'s `prazoDespachoShopee` — the ONE ms → µs
     conversion, because the shared `getPrazoDespachoNoFuso` answers
     MILLISECONDS while `freteInicial.prazoDespacho` is µs. `millisToMicros`,
     never `coerceToMicros`.
  5. `pedidos/liquidarPagamento.ts` (step 6) — the settlement transaction, and
     the ONLY place the weekly sweep crosses into microseconds. It performs the
     single `millisToMicros(nowMs)` of that path — item 2's pattern exactly, one
     clock read handed DOWN, because the sweep passes `nowMs` in and holds no µs
     of its own — and it converts the INCOMING
     `get_escrow_list.escrow_release_time`, which is **SECONDS**, by CALLING
     site (3), `microsDeSegundosShopee`. ⚠️ Never `coerceToMicros` on that value:
     it classifies by magnitude, reads `1.65e9` as MILLIseconds and answers
     1970, which is a settlement watermark that says "older" for ever. It also
     coerces the STORED `ultimaModificacao` the way the readers below do.
  6. `pedidos/rastrearPedido.ts` (step 7) — the code-4/30/47 handler, and the
     ONLY clock read of the push path. It performs the single
     `millisToMicros(nowMs)` of that path — item 2's pattern exactly, one clock
     read handed DOWN, here as the `nowUs` argument of `salvarFreteShopee` — and
     it converts nothing else: the package's own stamps are site 7's.
     ⚠️ `nowMs` arrives from the pipeline's injectable clock, so there is still
     no `Date.now()` anywhere under `pedidos/`.
  7. `pedidos/freteTx.ts` (step 7) — the shipment merge, and the ONLY place a
     PACKAGE clock crosses into microseconds. The incoming
     `get_package_detail.update_time` and `ship_by_date` are wire **SECONDS**
     and cross by CALLING site (3), `microsDeSegundosShopee`, once each.
     ⚠️ Never `coerceToMicros` on either: it classifies by magnitude, reads
     `1.66e9` as MILLIseconds and answers 1970 — a per-package freshness guard
     that says "older" for ever. On the STORED side the opposite holds, and it
     coerces the pedido's own `ultimaModificacao` the way the readers below do;
     the diary's two stamps reach the same coercion through `pacoteFreteSchema`'s
     tolerant preprocess, so there is no second call site. The µs it WRITES is
     `freteInicial.pacotes[].atualizadoEm` — the SHIPMENT clock. It never writes
     `lastMarketplaceUpdate` (the ORDER clock, step 5's alone — comparing a
     package event against it is ADR 0011's cross-clock failure) and never
     ASSIGNS `freteInicial.ultimaModificacao`; ⚠️ that stored value IS carried by
     the whole-map rebuild's spread and must be, because `update()` masks at the
     top-level key and omitting it would ERASE step 5's order watermark.
  8. `pedidos/reservaTravadaSweep.ts` (step 8) — the weekly stuck-reservation
     sweep, and the ONLY clock read of its path. It performs the single
     `millisToMicros(nowMs)` of that path — item 2's pattern exactly, one clock
     read handed DOWN as `nowUs`, from which the candidate cutoff and every
     verdict-side age derive — and it converts nothing else: the live `pay_time`
     never crosses (`reservaTravadaMapping.ts` folds it to a BOOLEAN through
     `segundosShopeeUtilizaveis`, site 3's neighbour, and it is never stored),
     and the aviso writes funnel through site 1's `agoraUsDe`. On the STORED
     side it coerces `timestamp` and `marketplace.statusEm` with
     `coerceToMicros` — the migrated Shopee corpus really does hold millisecond
     ints — which is the OPPOSITE rule from site 3's wire values, and the reason
     both are numbered. ⚠️ No coercion reaches a SERVER-side filter, and none
     needs to: a ms stamp (~1.7e12) is below any µs cutoff (~1.75e15), so a
     legacy row satisfies `timestamp < cutoffUs` by construction and sorts LAST
     under `DESC`. The filter over-matches in the SAFE direction, the
     verdict-side age is honest because `idadeEmDias` reads through
     `coerceToMicros`, and the paging loop is what makes a row that sorts last
     still reachable.

  ⚠️ **Step 9 adds NO site; the list still says eight.** The produto stamps are
  `millisSinceEpoch()`, the importer converts nothing, and `importacaoMassa.ts`'s
  one default clock is a millisecond read handed down as `nowMs` — a
  `millisToMicros` under `produtos/` would be a ninth site written against a
  millisecond field.

  Plus **four** READERS, which declare no new conversion but have to know the
  unit:
  - `pedidos/orderPedidoTx.ts` coerces the STORED `lastMarketplaceUpdate` and
    `ultimaModificacao` through `coerceToMicros` — correct there, because the
    legacy corpus holds ms ints and ISO strings;
  - `pedidos/pagamentoTx.ts` (step 6) does the same on its own two stored values
    (the pedido's `lastMarketplaceUpdate` watermark and the pagamento's
    `ultimaModificacao`) and converts **nothing** new — every µs it writes
    arrives as a parameter;
  - `pedidos/freteShopeeMapping.ts` (step 7) declares no conversion at all — it
    is pure over values ALREADY in µs and over raw wire TOKENS — but it compares
    µs stamps and folds a µs deadline, so a reader must not be told it is
    unit-free. ⚠️ Its own test greps that source as RAW TEXT for the three
    converter names, comments included, so writing one into a comment there reds
    a test for a reason the code does not show.
  - `pedidos/reservaTravadaMapping.ts` (step 8) is PURE — no clock, no env, no
    Firestore, no wire call — and declares no conversion either, but
    `idadeEmDias` reads a STORED stamp through `coerceToMicros`, which is what
    keeps a migrated MILLISECOND pedido from reporting an age measured from
    1970. It earns no site number for the same reason `pagamentoMapping.ts` does
    not: it converts nothing it writes, and it writes nothing at all.

  **Nothing else converts anything.** A `millisToMicros` or a `coerceToMicros`
  appearing in `itens.ts`, `produtoResolve.ts`, `incidentesProduto.ts`,
  `comprador.ts`, `pagamentoMapping.ts`, `liquidacaoSweep.ts`,
  `liquidarPagamentosCli.ts`, `fretePushShopee.ts`, `freteShopeeMapping.ts`,
  `rastrearPedidoSimulacao.ts`, `rastrearPedidoCli.ts`,
  `avisos/reservaTravada.ts`, `varrerReservasCli.ts`,
  `scripts/varrer-reservas.ts` or **any of the twenty-one modules under
  `produtos/`** is the drift this list exists to prevent.
  ⚠️ `pagamentoMapping.ts` holds no converter of its own — it CALLS site (3) for
  `pay_time`, the same way item 5 does — and **`liquidacaoSweep.ts` holds no
  microsecond at all**: the sweep is pure epoch MILLISECONDS end to end, and an
  inline `* 1000` there would be an undeclared NINTH site.
  `liquidarPagamentosCli.ts` holds µs only as DISPLAY: it carries
  `escrowReleaseTimeUs` verbatim out of the prediction and renders it through
  `microsToMillis`, converting nothing that is written — so it is not a site
  either, but it is not µs-free and a reader must not be told it is.
  ⚠️ **`varrerReservasCli.ts` (step 8) holds the SAME display-only position**,
  and it is not a new numbered site: the one µs number it touches is the
  sweep's `cutoffUs`, carried verbatim out of the result and rendered through
  `microsToMillis` as `<raw> (<ISO UTC>)`. Its I/O half
  `scripts/varrer-reservas.ts` holds no conversion at all — its only clock is
  the single `Date.now()` it hands the sweep as `nowMs`, and the
  `millisToMicros` that number meets lives in the sweep, site 8.
  ⚠️ **`fretePushShopee.ts` emits wire SECONDS on purpose** — that is why the
  shared `PacoteObservadoShopee` record spells the unit into the field names
  (`updateTimeS`, `shipByDateS`) — and `freteShopeeMapping.ts` converts nothing
  at all (it is the third reader above).
  ⚠️ **The `rastrear:pedido` halves are the `pagamentoMapping.ts` /
  `liquidarPagamentosCli.ts` position, not a new numbered site.**
  `rastrearPedidoSimulacao.ts` and `rastrearPedidoCli.ts` hold no clock and no
  converter of their OWN: the first CALLS site (3) once, for the backstop's
  order clock, and the second calls it to render a wire stamp and
  `microsToMillis` to render a stored one — display only. The CLI path's single
  clock read and its single `millisToMicros` live in
  **`scripts/rastrear-pedido.ts`**, the I/O half, precisely so that neither
  tested lib module holds one; `rastrearPedidoShopee` takes the MILLISECONDS
  from there and does its own site-6 conversion, and the simulation takes the µs.
  `orderMapping.ts` additionally exports `maiorUs` and
  `vazio` (moved out of `orderPedidoTx.ts` by step 6 so both transactions can
  share them) — patch primitives that compare and test, unit-agnostic, and not
  a conversion.
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
  avisos, and the second of the **five** modules in this app that write to the
  avisos inbox (`autorizacao.ts`, this one, step 8's `reservaTravada.ts`, step
  11's `anuncios/avisoAnuncio.ts` and step 12's `estoque/avisoEstoque.ts`). It
  holds NO `millisToMicros`: it takes the µs helpers from
  `avisos/autorizacao.ts`, which stays the one module on the AVISOS path that
  knows the unit (the three pedido seams above are the others).
- `lib/shopee/testing/fakeDb.ts` — the shared in-memory Firestore double
  **72** suites in this app name (70 drive it), and since step 8 it has a
  suite of its OWN. ⚠️ Re-derive the number, never increment it:
  `git grep -l "testing/fakeDb" -- "apps/shopee/**/*.test.ts" | wc -l` (20 at
  step 8, 34 after step 9, 57 after step 12, 72 today — the two
  `*.tasks.test.ts` suites it counts name the double in a docblock only).
  Step 9 extended the double ADDITIVELY: an
  `__arrayUnion` sentinel applied on write, **dotted-path** expansion on
  `update` (the price patch writes `precos.<tabelaId>`), and a real `updateTime`
  per snapshot plus the `update(patch, { lastUpdateTime })` PRECONDITION that
  throws `FAILED_PRECONDITION` on a stale stamp — without it the ADR 0011 tier-1
  taxonomy and price writes could never LOSE in a test. Its sibling
  `lib/shopee/testing/fakeBucket.ts` (step 9) is the same idea for Cloud Storage
  (three suites). Test-only, imported by no
  `src` file (the
  `apps/web/lib/testing` precedent); ONE copy, because two copies with a
  comment claiming they agree is the smell the root CLAUDE.md names. Since
  step 6 it also serves an in-transaction COLLECTION read (the pagamento
  transaction reads the whole subcollection), so its collection chain carries a
  `path` and logs that `get` into `opLog` — a test asserting an exact `opLog`
  over a path that reads a collection sees one more entry than it used to.
  ⚠️ **Step 8 extended it ADDITIVELY and the extension is load-bearing**: the
  query builder used to DISCARD the operator and had no `orderBy` at all, so no
  Shopee test could express a `<` range, an `in`, an ordering or a cursor — a
  double that answered "matches nothing" while every suite read green. It now
  honours `==` / `in` / `<` / `<=` / `>` / `>=` / `!=` (and **throws** on any
  other operator rather than falling back to `===`), sorts on `orderBy`, takes a
  `startAfter({ id })` document cursor and records the whole query into a SECOND
  log, `consultasCompletas`. The original `consultas` log is byte-unchanged on
  purpose: three live suites assert its rows by value, and one of them
  destructures pairs, so widening it would have made an assertion pass or fail
  for the wrong reason. The header names those three sites.
- `functions/` — the nested Cloud Functions codebase (a deploy-artifact
  sub-build; see `functions/DEPLOY.md`). Covered by this app's
  typecheck/lint/test tasks. Mirrors `apps/mercado-pago/functions`.
- `scripts/` — **nine** dev-only CLIs, **never run by an agent** (root CLAUDE.md
  rule 8), with the runbook in `scripts/README.md`: `oauth-url.ts` mints a
  consent URL without the web UI, `importar-pedido.ts` imports ONE named
  order through the real step-5 path, `liquidar-pagamentos.ts` (step 6)
  rehearses the weekly settlement sweep for ONE integração,
  `rastrear-pedido.ts` (step 7) rehearses the shipment merge for ONE order,
  `varrer-reservas.ts` (step 8) rehearses the weekly stuck-reservation sweep
  across every active conta — or one, with `--integracao` — and
  `importar-anuncio.ts` (step 9) imports ONE named anúncio through the real
  step-9 path, `publicar-anuncio.ts` (step 11) publishes ONE named produto as a
  listing, `enviar-estoque.ts` (step 12) pushes the stock of up to 50 named
  produtos and `enviar-precos.ts` (step 13) their prices; the last eight
  **dry-run by default**, `--live` to write. Their pure halves (arg parsing,
  the redacted summary, the renderer, the error describer) live in
  `lib/shopee/pedidos/importarPedidoCli.ts`,
  `lib/shopee/pedidos/liquidarPagamentosCli.ts`,
  `lib/shopee/pedidos/{rastrearPedidoCli,rastrearPedidoSimulacao}.ts` and
  `lib/shopee/pedidos/varrerReservasCli.ts`,
  `lib/shopee/produtos/importarAnuncioCli.ts`,
  `lib/shopee/anuncios/publicarAnuncioCli.ts`,
  `lib/shopee/estoque/enviarEstoqueCli.ts` and
  `lib/shopee/precos/enviarPrecoCli.ts` **because `scripts/` is outside this
  app's vitest `include`**, so logic written in a script file can never be
  tested (the `pedidoMoneyAudit.ts` precedent in `apps/mercado-livre`).
  Script-only, imported by no route and no bundle.

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
conta arms, code 3 is the order import (step 5), codes 4 / 30 / 47 are the
shipment merge (step 7), codes 16 / 27 the listing lifecycle (step 11), a listed
handful `ack`, data-bearing codes with no owner **park**, and an unlisted code
parks too, which is the only signal a new code appeared. ⚠️ `DestinoPush` has
**seven** members and the ladder that reads it is closed by a compile-time
`const restante: 'conta' = destino` line: an eighth destino without an arm of
its own stops compiling, rather than falling through to the authorization arms.

✅ **Codes 4, 30 and 47 route to the shipment merge (step 7).** Three codes, ONE
destino: they differ only in which field Shopee changed, all three name a
PACKAGE, and all three are answered by one `get_package_detail` for that
package. The push is a POINTER — nothing reads `tracking_no`,
`fulfillment_status` or `new.ship_by_date` off the body — which is what makes a
replayed or out-of-order delivery idempotent and what gives **code 4 a clock at
all**, since `push 2` documents no `update_time`. See **Shipment tracking
(step 7)** below.

Three rows were added by the sandbox push test of 2026-09-09. **Code 0** is
undocumented: it is the console's own "Verify and Save" message (`verify_info`,
no `shop_id`, no `timestamp`), and it `ack`s and never parks, because otherwise
every click on that button leaves a row behind; its identity is the default
branch, `0:-:-:-`. **Codes 24 and 25** are documented — the logistics *booking*
pushes `booking_trackingno_push` (push_api_id 27) and
`booking_shipping_document_status_push` (push_api_id 28), both "New Push" of
2024-07-02 — and were simply missed by the doc survey; the sandbox is what made
them arrive, unlisted, and park. Both still **park**, keyed on `booking_sn`.
They arrived unlisted first, which is that signal doing its job.

⚠️ **Code 24 was RE-PARKED by step 7 and now has NO owning step** (25 is still
step 15's). An earlier revision of this page promised it to step 7; that promise
was false and the reason is the wire. A "booking" is an **Advance Fulfillment**
parcel — stock the seller ships to Shopee BEFORE any buyer order exists — and
the programme is ID/PH/VN (`announcement 1064`) plus TH (`announcement 1317`),
never BR. `push 27` names ONLY a `booking_sn`: no `order_sn`, no
`package_number`, so **no pedido id is derivable** from it without a
`get_booking_detail` that answers an order only once
`booking_status === 'MATCHED'`. It arrived in the 2026-09-09 sandbox test
because that shop is SG. Its `MOTIVO_PARADO` row names the programme and says
so; whoever ever needs Advance Fulfillment owns it.

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
| **codes 4 / 30 / 47**, a shop that maps to no active integração | the SAME reading as code 3, and the same `sem-conta` kind: connecting the shop makes the package **actionable** — `get_package_detail` still answers for it |
| **codes 4 / 30 / 47**, the pedido does not exist yet | no page states an ordering between push codes, so a package event can precede the code 3 that creates the pedido; `kind: 'frete-adiado'`, and it enqueues ONE synthetic code 3 (`origem: 'rastreio'`) |
| ⚠️ **code 2**, the same unmapped shop | **ACKED, not deferred** |

⚠️ **Every reason string an arm BUILDS is prefixed by it**, so a parked or
deferred row says which one wrote it: `push_code 3:` for the order import,
**`rastreio:`** for the shipment merge. ⚠️ The ONE exception is the shared
`sem-conta` defer — the two unmapped-shop rows in the table above and their
code-1 twin: all three arms emit the same UNPREFIXED `loja <id> não mapeia…`
template, so there the discriminator is the row's `kind` + `code`, never the
string. The two error→disposition readers
(`disposicaoDaFalhaDeImportacao`, `disposicaoDaFalhaDeRastreio`) are one private
class table with two prefixes — step 5's behaviour is byte-identical and its
tests are unedited, which is the proof that the refactor changed nothing.

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

## Delivery backstops (steps 4 and 8, `functions/` + `lib/shopee/{notificacoes,pedidos}/`)

Four `onSchedule`s in the nested codebase, each covering a different way a push
never arrives. They are what decision P3 spends the receiver's scale-to-zero
cold start on. The first three are step 4's and are documented here; the fourth,
step 8's **`sweepShopeeStuckReservations`**, has its own section below.

⚠️ **The codebase holds more schedules than these four, and only these four are
backstops.** The weekly authorization-expiry sweep watches a clock (above), and
step 6's `sweepShopeeEscrowSettlement` reads money that Shopee exposes only once
the escrow is RELEASED — no push was ever sent for it, so none was ever missed.
It is documented under **Payments and settlement**, not here; filing it as a
fifth backstop would make "a way a push never arrives" mean nothing. The honest
count is **ten** `onSchedule` triggers — seven in `functions/src/index.ts` plus
step 12's three stock sweeps in `functions/src/sweepStock.ts` — with
`index.test.ts` pinning ten distinct crons. `ci-shopee.yml` says TEN too; the
two must never disagree.

⚠️ **Step 8's sweep IS a backstop by that same criterion, and it is the only one
that reaches past three days.** A subscription Shopee SUSPENDS loses every push
missed while it was disabled — those are never resent at all, not even into the
lost-push queue the 2-hourly sweep drains — and the `UNPAID → PENDING`
transition fires NO push whatsoever (`announcement 682` §4 Q1 says so, and the
replacement it promised has never shipped). Both leave a pedido holding a stock
reservation with nothing event-driven left to release it, which is exactly the
"a way a push never arrives" test this list applies. See **Stuck-reservation
sweep (step 8)** below.

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
| `SHOPEE_ESCROW_DETAIL_TRANSPORT` | `packages/integrations/shopee/src/api.ts` (`'get-query'`) | ✅ **settled `'get-query'`** (2026-09-10). The console test tool sent a **GET with `order_sn` in the QUERY STRING** and an empty body, and Shopee answered — so the page's `method: 2` was right and its JSON request sample was misleading. ONE literal still flips the verb AND the placement together, because a GET cannot carry a body through `fetch`, and it survives as the named seam. |

⚠️ **The escrow's per-item money is a LINE TOTAL; the detail's is PER UNIT.**
The same SG sandbox order settled both halves at once: the escrow says
`discounted_price: 30` beside `quantity_purchased: 2` while the detail says
`model_discounted_price: 15`. So `precoUnitario` divides the escrow figure by
the escrow's OWN `quantity_purchased` and does not divide the detail's — the two
committed bodies (`__wire__/get_escrow_detail.qty2-sg.json` and
`__wire__/get_order_detail.qty2-sg.json`) are what pins the pair.

⚠️ **Shopee has no ORDER-level discount, so the pedido's `descontoTotal` is
always `0`.** The five escrow discounts are ITEM-level and each rides its line's
`descontoUnitario`, which `itemSubtotal` already nets out of `precoDeVenda`.
`derivePedidoFreteTotals` subtracts `descontoTotal` a SECOND time, after the item
sum, so copying `conferencia.descontoDasLinhas` into it short-changed
`valorCobrado` by Σ discounts on the operator's first save — the value stored at
import was right and the recomputed one was not. `pedidos/totais.test.ts` crosses
the two modules and pins it; the conferência field is named `descontoDasLinhas`
so the two can never be confused again.

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

## Payments and settlement (`lib/shopee/pedidos/pagamento*.ts` + `liquida*.ts`, step 6)

Moved to `lib/shopee/pedidos/README.md` (Codex cap, step 12).

- `escrow_release_time` is exposed by ONE endpoint; no payment push exists.
- MILLISECONDS at rest.

## Shipment tracking (`lib/shopee/pedidos/frete*.ts` + `rastrearPedido*.ts`, step 7)

Moved to `lib/shopee/pedidos/README.md` (Codex cap, step 12).

- The per-package diary lives on the SHARED freight schema.
- `push 2` documents no `update_time`; never derive one.

## Stuck-reservation sweep (`lib/shopee/pedidos/reservaTravada*.ts` + `avisos/reservaTravada.ts`, step 8)

Step 5 imports an `UNPAID`/`PENDING` order as
`aguardandoConfirmacaoDePagamento`, which is inside `ESTADOS_PEDIDO_RESERVA`:
the unit is held **on purpose**, and the release is the `CANCELLED` push coming
back through step 5's own ladder. This sweep exists for the four populations
where that push never arrives — a SUSPENDED subscription (never resent),
anything older than the 3-day lost-push queue, the silent `UNPAID → PENDING`
transition that fires no push at all, and everything while
`SHOPEE_ORDER_BACKFILL_ENABLED` ships off (and even with it on, its
`get_order_list` window is 15 days on `update_time`, which by construction
cannot reach an order whose `update_time` stopped moving).

**It never writes the pedido, and it runs no transaction.** `pedido.estado` on
this channel keeps exactly ONE writer, step 5, so rule 7 is answered at **tier
0** — the race is made impossible rather than survived. The sweep does two
things instead: it RE-DRIVES an order Shopee reports as moved, through one
synthetic code 3 (`origem: 'reserva-travada'`, the shared
`notificacaoSinteticaDePedido`) on the normal import path; and it SURFACES
everything it cannot decide as a `pedidoPrecisaDecisao` aviso. It is the FIRST
producer of that tipo, declared by #1543 with none, and it ships the machine
resolver `aviso.ts` requires of every tipo.

**Eleven verdicts, and only ONE of them releases anything.** The gates answer
`interacao-humana` and `pagamento-aprovado`; the read answers `nao-verificavel`
and `inexistente`; the classifier answers `ainda-nao-pago`, `pendente-pago`,
`redirecionado-avancou`, `redirecionado-cancelado`, `manter-devolucao` and
`status-desconhecido`; the effect answers `tasks-desabilitado`. Only
`redirecionado-cancelado` (`CANCELLED → cancelado`, `IN_CANCEL →
processandoCancelamento`) leaves `ESTADOS_PEDIDO_RESERVA` and therefore
releases, and even that release is written by step 5 through
`onPedidoEstoqueSync`, never here. `redirecionado-avancou` (`pago`) is enqueued
too and releases nothing — `pago` is a live sale still inside the reserve set —
and it is counted APART, because "the order moved" and "the reservation ended"
are different facts. Four verdicts surface as an aviso: `ainda-nao-pago`,
`pendente-pago`, `inexistente`, `manter-devolucao` — the set is declared once,
as `VEREDITOS_QUE_AVISAM`, and `surfacar` is computed from it.

⚠️ **Three verdicts a naive re-driver WOULD enqueue are deliberately never
enqueued, and each refusal is the safe direction.** `status-desconhecido`,
because a re-drive makes step 5 write
`estado: error`, which is OUTSIDE `ESTADOS_PEDIDO_RESERVA` — it would RELEASE
the reservation for a token nobody understands. `inexistente`, because the
code-3 arm PARKS an order Shopee no longer knows and the synthetic doc id
carries the tick's own clock, so a re-driver writes one new parked dead-letter
document per candidate per week and releases nothing. `manter-devolucao`
(`TO_RETURN`), because the ladder answers `manter` at its FIRST clause, so a
re-drive provably cannot move the estado — surfacing is the only thing left that
is not invisible.

⚠️ **`PENDING` is not a synonym for unpaid.** Both pre-shipment tokens share one
rung, so the estado cannot tell them apart; the discriminator is `pay_time`, the
only documented payment signal, folded through `segundosShopeeUtilizaveis` so
`0`, `null`, `undefined` and any pre-2020 value all read as ABSENT (Shopee
zero-fills absent numerics on this wire). `PENDING` **with** a usable `pay_time`
is a PAID sale Shopee is holding (`announcement 1486`: "Label print will be
available within 4 days after buyer paid"), and its aviso says so in as many
words — do not cancel it; the path is a ticket on the Open Platform.

**The read is one batched call per 50 candidates per conta.**
`get_order_detail` with `request_order_status_pending: true` and a MINIMAL
`response_optional_fields` allow-list — `pay_time`, `cancel_by`,
`cancel_reason`, and nothing else. `order_status` and `update_time` are BASE
fields that arrive unasked, `pending_terms` is gated by the FLAG rather than by
the list, and naming either risks `error_param`. There is no `buyer_cancel_reason`
and no buyer, item, address, invoice or payment block: **this sweep carries no
PII on its wire at all**, which is what makes the console-spy test a structural
claim. Rows are reconciled by `order_sn` through a `Map`, never by position; an
absent row is `inexistente`. ⚠️ A rate limit of either class, or a dead grant,
**aborts the conta** — every remaining candidate counts `nao-verificavel` and
there is never a retry, because "avoid frequent retry operations" plus a daily
quota that resets at 00:00 UTC+8 makes a retry loop the one failure a human
ticket has to undo.

⚠️ **The batch-vs-error ambiguity is measured, not assumed.** Shopee's own error
example and `faq 192` case 3 say an `order_sn` the shop does not own answers
envelope `error_not_found`; the package says the row is simply omitted. A
read-only probe on the SG sandbox shop (2026-09-15, three calls) found a MIXED
batch omits the unknown row with no `error` and `warning: null`, and the
envelope error fires only when EVERY `order_sn` of the call is unknown. Both
arms are therefore built and both stay: reconcile-by-`order_sn` handles the
absent row, and a batch-level `error_not_found` on `N > 1` falls back to
per-order calls — which under the measured behaviour costs N extra calls only
when all N are unknown. That is a dated observation on one sandbox shop, not
documented behaviour, and the docblock says so (settle-live register item 38).

**The gates, in order, and each rejects rather than decides.**
`provaDeIdentidadeShopee` recomputes `makePedidoIdShopee(contaId, numero)` and
compares it with the document id — the LEGACY-exact digest, imported and never
re-derived, so a migrated pedido passes it; a failure counts `adotado` when
`marketplace.tipo === 'shopee'` and `naoMarketplace` otherwise. Then a
`lastMarketplaceUpdate` that will not coerce, then the active-conta set, then
the CLI's `--integracao` scope. What survives is a **candidate**, and only a
candidate can receive a verdict — which is why `Σ veredictos === candidatos`
is an invariant a test asserts on every fixture, and why the four gate-1
counters are never summed with `candidatos`. Two more gates then decide rather
than reject: `hasUserInteraction === true` ⇒ `interacao-humana`, and any
`aprovado` payment in the WHOLE `pagamentos` subcollection ⇒ `pagamento-aprovado`
(the whole subcollection, because the second document is exactly the one a
first-document read would miss).

**The candidate query rides an index that already exists** —
`pedidos (ehSaida ASC, estado ASC, timestamp DESC)` — with `estado` as a
one-element `in` rather than a bare `==`, because on Enterprise the wrong index
SHAPE does not throw, it full-scans and bills the scan. It pages with
`startAfter(lastDoc)` to `MAX_PAGINAS` (10) × `PAGE_LIMIT` (200) = **2 000
documents scanned per tick**, stopping at `MAX_CANDIDATOS` (200) Shopee
candidates, a drained page, or the page ceiling (`truncado`). The paging is not
decoration: the query carries no channel clause, so stale manual and ML pedidos
colonise the head of the page permanently — that is the ML sweep's measured
starvation, and the cursor is the fix at zero index cost. ⚠️ A migrated pedido
whose `timestamp` is in MILLISECONDS satisfies any µs cutoff by construction and
sorts LAST under `DESC`, so it is only ever reached BY the paging; its age is
still honest, because `idadeEmDias` reads the stored stamp through
`coerceToMicros`.

**The dry run skips exactly two effects** — `scheduler.enqueue`, and the aviso
writes/resolves. Everything else happens in both modes: the candidate page, the
gates, the pagamento reads, the Shopee read, every verdict, the three diagnostic
tables, and pass (b)'s query and pedido reads. A parity test asserts that over
EVERY one of the eleven verdicts, which is what makes the rehearsal an
instrument rather than a rehearsal of the plumbing. `tasks-desabilitado` is
decided by READING `shopeeTasksDesabilitado()`, never by catching the throw: the
error class is inside `erroContidoPorConta`, so a caught one would read as a
per-conta outage, and a dry run never reaches the enqueue at all — the ML sweep
reports two different verdicts for the identical candidate for exactly that
reason.

**The avisos, and why the chave carries no window.** The chave is
`pedidoPrecisaDecisao:<integracaoId>:<pedidoId>` with **no `janela`** — a weekly
window would mint a fresh document every Monday and destroy the only
cross-tick memory there is, `ocorrencias`. **No `relogioEvento` is ever
supplied** either: that guard is a `<=` against an event clock, and the
residual's `update_time` does not move, so supplying it would freeze
`ocorrencias` at 1 for exactly the population the aviso exists for. The in-line
resolve set is exactly TWO — `interacao-humana` (`assumido-por-humano`) and
`pagamento-aprovado` (`venda-viva`) — because those two void the aviso's own
premise; resolving on an enqueue (which has no feedback channel) or on a rate
limit (which is the ABSENCE of an observation) would close a live aviso and
re-alert next week with a fresh `criadoEm`. Everything else is closed by **pass
(b)**: one page of 200 unresolved avisos on the collection's OWN declared
`(resolvidoEm ASC, criadoEm DESC)` composite — `tipo` and `canal` filtered in
code, because the query cannot discriminate them — then one read by id per row
whose chave parses as ours, resolving `pedido-inexistente`,
`estado-saiu-do-conjunto`, `fora-da-posse` or `dentro-do-horizonte`.
⚠️ Pass (b) is not optional: `sweepAvisosResolvidos` deletes a RESOLVED aviso
90 days later, and an aviso nobody ever resolves stands forever.

**The instrument.** The result is counters only — per verdict with the zero arms
PRESENT (an absent key is indistinguishable from an arm that never existed), the
four gate-1 rejects, `truncado`, the pass-(b) numbers, and
`redriveAparentementeNaoAplicado` (the stored `marketplace.status` already
equalled the live one on a `redirecionado-*`: a delivery was accepted and the
estado still did not move). Beside them sit three tables computed from the
candidate documents alone, **after the gates and BEFORE any Shopee call**:
`statusArmazenado` (the `marketplace.status` distribution, verbatim),
`idadeStatusDias` (bucketed `marketplace.statusEm`) and the cross-tab
`statusPorIdade`, plus `statusArmazenadoPorVeredito` once the read has answered.
That pair — a zero-call cross-tab beside the live verdicts — is the ONLY
instrument anyone has for the question the whole step rests on: **does Shopee
auto-cancel an unpaid BR order, and after how long?** No page of the cached
corpus answers it, and the sandbox cannot produce an aged unpaid order. Read it
week over week; `scripts/README.md` §10 carries the reading table.

**The rehearsal.** `varrer:reservas` runs the same tick from a terminal,
dry-run by default. `--dry-run` supplies BOTH `forcarDryRun` and
`ignorarFlagMestra`, so the rehearsal runs BEFORE the master flag exists —
and the sweep **throws `ShopeeConfigError` when `ignorarFlagMestra` arrives
without the dry run**, which makes "can rehearse before the flag, can never
write before the flag" structural rather than a promise. `--live` supplies neither: the master flag is honoured, and
flipping it is a human's act in the migration window, never a second door in a
CLI. The per-candidate detail reaches the CLI through the optional
`deps.onCandidato` seam, called from inside `registrar` — the one function every
arm reaches — so "exactly once per candidate" is the same property
`Σ veredictos === candidatos` already asserts, and the tick itself still returns
nothing but counters. See `scripts/README.md` §10.

**What it never does.** It writes no pedido field — not the estado, not an
incidente, not `ultimaModificacao`; it runs no transaction and files no entry in
the transaction inventory (and names that API nowhere, comments included, since
the guard greps raw text); it performs no estado logic and no estoque arithmetic
of its own; it never cancels anything on Shopee's side; it adds no index, no
schema field, no ruleset regeneration and no `apps/web` change — the tipo's
wording, route and canal all already existed.

## Product import (`lib/shopee/produtos/`, step 9)

A Shopee anúncio becomes an ERP produto — the first WRITER of `prodshopee` /
`variashopee`. Three callers, one code path: the `importar` route, the
`importar-anuncio.ts` CLI (dry-run by default) and the resumable
`importar-todos` job. **The reasoning is `lib/shopee/produtos/README.md`; these
are the rules a change must not break.**

- **One read, handed DOWN.** The importer never calls Shopee: it receives an
  `ItemLido` assembled once (the job in a batch reconciled by `item_id`; the
  route and the CLI through `lerAnuncio.ts`, which pays one `get_item_base_info`
  to learn `tag.kit`). A kit then asks for `get_kit_item_info` and never
  `get_model_list`. No clock under `produtos/` except the ONE documented default
  in `importacaoMassa.ts` — `nowMs` is a parameter.
- **`preparar` (write-free, proved by a throwing FakeDb) → `planejar` (pure) →
  `aplicar`, in ONE order:** taxonomia → categorias → the guarded price patch
  → produto → extraData → estoque → the parent link → each child →
  `filhoUnicoId` → photos. Taxonomia first because a lost grupo race refuses the
  ITEM before any produto exists; the price patch before the produto merge
  because the merge bumps the `updateTime` the patch's precondition asserts.
- **Links resolve, then write, NEVER delete.** `limit(2)` on every rung;
  duplicates lexically-first with one log line; `model_id: 0` creates the child
  and skips the link. Ids: parent `sha256("shopee|<integracaoId>|<item_id>")`,
  child `sha256("<paiId>|<model_id>")` — conta-scoped, no legacy preimage.
- **The grupo write is ADR 0011 tier 1**: `update(patch, { lastUpdateTime })`
  naming four fields; a lost precondition RE-PLANS the item once against a fresh
  memo, a second loss is `taxonomia-em-conflito`; the loser's patch is never
  re-applied. The per-dispatch memo absorbs the grupos the dispatch writes.
- **Prices go to the NORMAL table only** (`original_price ?? current_price`,
  ML #803). **Estoque is never written on a parent with children.** Photos are
  last, retriable, behind an SSRF host allow-list; logs carry host + `image_id`,
  never the URL.
- **Two memos a caller must pass**: `grupos` absent ⇒ the module builds its own;
  `categorias` absent ⇒ the categoria leg is SKIPPED with one warn.
- **Kits (K1)**: `kitShopee.ts`, parent `ehKit: true`, `componentesKit` keyed by
  component produto id, NO estoque row; an unresolved component refuses the kit
  before any write (a fresh catálogo needs a second run); the job drains kits
  LAST.
- **The job**: a burst rate limit re-enqueues with a delay — never a failure row
  nor an attempt; the daily quota and the first-attempt classes stamp `failed`;
  transients take the 3-attempt ladder; the cursor is the SERVER's
  (`has_next_page` true with no `next_offset` is TERMINAL — register item 66).
  `finalizarImportacaoShopee` is the ONE transaction under `produtos/` (class B,
  inventoried) and the only file there that may name the API.
- **No ruleset regeneration, no new env var.** Publishing, stock, price, size
  charts and creating a kit ON Shopee are steps 11/12/13/18/19; `/produtos`
  shows the Shopee badge since step 11's link trigger.

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

## Publish (`lib/shopee/anuncios/`, step 11)

The first WRITER of a listing. Reasoning: `anuncios/README.md`.

- No clock, no `next/server`, no `runTransaction` word: the functions bundle
  reaches here; `deps.nowMs`/`deps.esperar` are parameters.
- `preparar` (write-free) → `planejar` (pure) → `aplicar`; each write-back
  lands the instant Shopee confirms, so a half-failed publish RESUMES.
- Create with children: `add_item` UNLIST → esperar → `init_tier_variation` →
  `get_model_list` → re-list. `model_list` is built from a FRESH
  `get_model_list`; a model with no ERP child is KEPT; no link doc is deleted.
- `tax_info` is whole or absent; the three seller constants are NOT sent, and
  one all-or-nothing refusal retries the same call once without the block.
- Refusals throw `ShopeePublishBlockedError` BEFORE any Shopee write; a
  rejection is a `problema` on the field that fixes it. Both vocabularies
  PERSIST.
- `item_status` comes from the READ-BACK, never the request.

## Stock sync (`lib/shopee/estoque/`, step 12)

The first SENDER of a quantity. Reasoning: `estoque/README.md`.

- No clock, no `next/server`, no `runTransaction`, no µs: `deps.nowMs` /
  `deps.agora` / `deps.esperar` are parameters.
- ONE task per ITEM, ≤ 50 models → ONE `update_stock`; attribution is per
  MODEL and `error` COEXISTS with `failure_list`, so `error === ''` proves
  nothing.
- The quantity is publish's ONE function, clamped UP to the promotion floor
  (`Σ seller_stock ≥ total_reserved − Σ shopee_stock`) — never down to
  `min_limit`. ERP kits SEND; a native Shopee kit (`kitNativo`) is
  `kit-derivado`.
- Holiday, FBS, CBSC, outlet, multi-warehouse and a promotion lock are
  DETERMINISTIC skips with a pt-BR cause and remedy.
- Burst ⇒ a delayed re-enqueue, no attempt consumed; daily ⇒ `pausadoAte` at
  the next 00:00 UTC+8. `ShopeeRateLimitError` EXTENDS `ShopeeApiError`.
- Shopee restores stock on a cancellation (announcement 1445), so the monthly
  reconciliação is an obligation, not a backstop.

## Price sync (`lib/shopee/precos/`, step 13)

The first SENDER of a price. Reasoning: `precos/README.md`.

- No clock, no `next/server`, no µs (`deps.nowMs` / `deps.agora`); ONE
  `runTransaction`, the job's class-B finalize.
- The unit is the WHOLE item: read, decided and ratio-checked together
  (BR 4×, SG 5×, over sent ∪ unsent-current models); the body is the diff.
- `tabelaNormal` via `precoDaTabela`, `roundReais`'d, read at SEND (push) or
  DRAIN (job) time, never at plan; compared to step 9's `precoDePrateleiraDe`.
- BR only, cross-border (`is_cb`) refused; a rowed non-`BR` region only under
  `SHOPEE_SANDBOX === '1'` on the RESOLVED sandbox host (rule 6's exception).
- Promotions: send and classify, never pre-skip; a lock skips with NO link
  stamp. `error_update_price_fail` is a stamped `preco-recusado`, never a
  retry (probe B-3).
- Manual only (`enviar-precos`; the `atualizar-precos` job, TTL 180 days,
  report shards 187). Push 22 stays `ack`: Seller Centre edits fire it too.
- ONE conta ladder for both routes, `exigirContaParaPreco`. In the job a
  cancel lets only the listing in flight finish; the report counters are
  tier-0 `increment`/`maximum`, the plan checkpoint tier-1 `lastUpdateTime`;
  a stamped `erro` never carries Shopee's text.

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
   ⚠️ ONE exception: step 13's price region gate lets the SG sandbox shop
   rehearse a price push, keyed on the RESOLVED sandbox host, so a
   production host can never reach it.

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

## Env added by step 8

Three more, all in the root `.env.example`, none a secret, and — like step 4's
two — **read only by the nested functions codebase**, so their real home is
`apps/shopee/functions/.env.deploy` and a value set in `apphosting.yaml` would be
read by nothing.

- **`SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED`** — the master flag for
  `sweepShopeeStuckReservations`, strict `=== '1'`. It **SHIPS OFF**, and while
  off the function deploys, ticks, logs one info line naming the variable and
  reads NOTHING — not Firestore, not Shopee. Turning it on is a runtime env
  change for the migration window (rule 8), and the intended order is: run the
  DRY RUN for a few weeks, read `veredictos.ainda-nao-pago` against the
  `statusPorIdade` cross-tab, and only then flip it.
- **`SHOPEE_PEDIDO_TRAVADO_DRY_RUN`** — report-only. Queries, gates, READS
  Shopee and classifies exactly as a live run would, skipping only the two
  effects. ⚠️ Both flags are read BEFORE the early return, so a disabled tick
  still reports `dryRun` HONESTLY — the ML sweep reads its dry-run env after its
  early return, and therefore tells an operator who set the rehearsal flag and
  forgot the master one that the rehearsal is off.
- **`SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D`** — the horizon in whole days; unset or
  unreadable falls back to 7. ⚠️ The EFFECTIVE age is **7–14 days**, because the
  schedule is weekly and a pedido that goes stale just after a tick waits for the
  next one. Nothing may document "7" as a promise.

## CI

`ci-shopee.yml` carries exactly ONE suite job, `Shopee Cloud Tasks round trip`,
behind the unskippable `CI gate (shopee)`. It builds the functions artifact and
runs `*.tasks.test.ts` against firestore + functions + tasks emulators
(`firebase.shopee.tasks.json`, ports 8084/5003/9500). Since step 13 that job runs
**five suite FILES and ten tests**
(`app/api/webhooks/shopee/route.tasks.test.ts` ×3,
`lib/shopee/produtos/importacaoMassa.tasks.test.ts` ×2,
`lib/shopee/notificacoes/pushAnuncio.tasks.test.ts` ×1,
`lib/shopee/estoque/enviarEstoque.tasks.test.ts` ×1,
`lib/shopee/precos/atualizarPrecos.tasks.test.ts` ×3) — still one job, still
one check name, no new gate-manifest row. The lane's header carries the same
pair of numbers.

Four **push deliveries** go through the receiver hop: an unknown push code
(→ `parked`); since step 5 a **code 3**, since step 7 a **code 4** and since
step 11 a **code 16**, naming a shop that maps to no integração (→ `deferred`). Step 9's file is a different
hop: enqueue → the tasks emulator → the real `processShopeeMassImport` → a
seeded job stamped `failed`. Step 12's is a THIRD hop: enqueue → the tasks
emulator → the real `sendShopeeStock` → a seeded LINK document stamped
`erp:task-excede-limite`, from a 51-model task the chunker cuts. Step 13's is
a FOURTH: the real `processShopeePriceSync` takes a job whose anchors all skip
at PLAN time to `completed` (the drain's lazy client is never built), answers
`noop` once cancelled and fails a wrong-`tipo` conta. All nine are
chosen for the same reason — each is decided with NO Shopee call; eight write
a document, and the cancelled job's dispatch writes NOTHING (a sentinel job
behind it proves it ran): the mass-import one seeds an
`integracao/int-1` of the **WRONG `tipo`**, so `loadShopeeContext` refuses
before a client exists, and the stamp lands on `retryCount: 0` (a path that had
reached the network would show a 30 s backoff instead); the stock one refuses at
rung 1, which sits ABOVE the pause gate, above the context load and above the
client, so the guarantee there is CALL ORDER and never a mock.
⚠️ The lane's fetch kill-switch lives in the VITEST process and does **not**
cover the dispatched function, which runs in the emulator's own process, so a
code-3 case that reached `importarPedidoShopee` — or a code-4 one that reached
`rastrearPedidoShopee` — would really leave the runner. Keep the tasks suites on
paths that need no token.

⚠️ **Neither tasks suite exercises the mass import's burst pause**: the
scheduler sets `scheduleDelaySeconds` there, the emulator ignores it
(firebase-tools#8254), and the pause is pinned offline in
`importacaoMassa.test.ts`. ⚠️ The emulator dispatches in FILE order with
`fileParallelism: false`; each file's `beforeEach` wipe is the ONLY isolation.

⚠️ The lane's `push: paths:` grew with step 5 (`packages/schemas/src/pedido/**`,
the cliente/endereço/`intFrete` schemas, `packages/data/src/admin/{clientes,produtos,enderecos}/**`
and `packages/data/src/pedido/**`) because the importer reaches all of them, and
again with step 6 by exactly two FILES — `packages/schemas/src/liquidacaoShopee.ts`
(the settlement cursor) and `packages/schemas/src/bandeiraCartao.ts` (the card
brand catalogue the `cartao` block folds into). Everything else step 6 added
lives under `apps/shopee/**` or `packages/schemas/src/pedido/**`, both already
listed. Step 7 grew it by exactly ONE more file,
`packages/schemas/src/shared/frete.ts` — the shared freight schema, where the
per-package diary was promoted to. Step 8 grew it by **nothing**: everything it
touches is under `apps/shopee/**`, and the two shared paths its avisos reach —
`packages/schemas/src/aviso.ts` and `packages/data/src/admin/avisos/**` — were
already listed. **Step 9 grew it by seven entries**, because the product
importer's graph reaches further than any step before it:
`packages/storage/**`, `packages/schemas/src/produto/**`,
`packages/schemas/src/grupoDeVariacoes.ts`, `packages/schemas/src/categoria.ts`,
`packages/schemas/src/storage/**`, `packages/schemas/src/importacaoShopee.ts`
and `packages/data/src/admin/hash.ts` (the why of each is a comment beside it
in the lane). **Step 12 grew it by exactly two** —
`packages/schemas/src/estoqueShopeeSync.ts` (the sync state doc) and
`packages/data/src/admin/estoque/**` (the promoted stock core). **Step 13
grew it by exactly four** — the job schema, the two Mercado Livre schemas it
reuses and `shared/ttl.ts` — for a closure of **48** entries today.
`pull_request:` still has **no** `paths:` and
never may — the `changes` job derives that closure from the workspace graph.

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

The other eight CLIs are **dry-run by default** and, like `oauth:url`, are
**never run by an agent** (root CLAUDE.md rule 8) — the flags, the expected
output and the runbook for each live in `scripts/README.md`:

```bash
pnpm --filter @delfrance/shopee-app importar:pedido --integracao <integracaoId> --order-sn <orderSn>
pnpm --filter @delfrance/shopee-app liquidar:pagamentos --integracao <integracaoId>
pnpm --filter @delfrance/shopee-app rastrear:pedido --integracao <integracaoId> --order-sn <orderSn>
pnpm --filter @delfrance/shopee-app varrer:reservas
pnpm --filter @delfrance/shopee-app importar:anuncio --integracao <integracaoId> --item <item_id>
pnpm --filter @delfrance/shopee-app publicar:anuncio --integracao <integracaoId> --produto <produtoId>
pnpm --filter @delfrance/shopee-app enviar:estoque --integracao <integracaoId> --produto <produtoId>
pnpm --filter @delfrance/shopee-app enviar:precos --integracao <integracaoId> --produto <produtoId>
```

The first imports ONE named order through the real step-5 path; the second
(step 6) rehearses the weekly settlement sweep for one conta, printing the exact
patch a live tick would write; the third (step 7) rehearses the shipment merge
for one order — the same `get_package_detail` pull and the same pure prediction a
code-4/30/47 delivery runs, plus what the code-3 backstop would fold from the
same order; the fourth (step 8) rehearses the weekly stuck-reservation sweep
across **every** active conta by default, `--integracao <id>` to scope it to one;
the fifth (step 9) imports ONE named anúncio through the real step-9 path —
the dry run prints the PLAN, `--live` writes it; the sixth (step 11) plans the
publication of ONE produto; and the seventh (step 12) plans the stock push for
up to 50 named produtos, `--produto` repeated, one flag per anchor; the eighth
(step 13) does the same for prices (`--baixar-preco` allows a decrease).
All eight still CALL Shopee in dry-run — what they do not do is write, with ONE
documented exception: `publicar:anuncio` UPLOADS the pictures in both modes,
because `montarAnuncio` needs real `image_id`s to build a body at all.
`enviar:estoque`'s dry run calls `get_item_promotion` and nothing else.
⚠️ Against the **SGD sandbox** `importar:anuncio` plans no price
(`precoIgnorado: moeda-nao-brl`) — the rule working; `scripts/README.md` §11.5
lists the expected caveats.

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
