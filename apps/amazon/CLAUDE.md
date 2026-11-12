# apps/amazon

API-only App Hosting backend for the Amazon (SP-API) marketplace channel, port 3011.

- The platform is called only through `@delfrance/integrations-amazon-sp-api`,
  never with a raw `fetch` here.
- **Mock only before the cutover (D11).** No code here calls Amazon until the
  window sets the read switch (`AMAZON_CHAMADAS=on`); tests run against the
  app-local fake db (`lib/amazon/testing/fakeDb.ts`), the in-memory attempt store
  (`fakeOauthState.ts`) and an injected fetch spy.
- The LWA authorization belongs to this integration alone, never the legacy
  app's (D10). Never put a token, the code, the client secret, the state, a
  seller id or a credential ref in a URL, a log line or a response.
- `vitest.config.ts` (`pnpm test`, in `ci.yml`'s `CI test`) excludes `*.firestore.test.ts`
  and `*.tasks.test.ts`; `vitest.tasks.config.ts` (`pnpm test:tasks`) includes exactly those
  two and runs only in `ci-amazon.yml` (see "CI (step 3)"). A file matching neither glob
  runs in NO job (`estrutura.test.ts` pins both globs). `eslint.config.mjs` lints both
  suffixes and only lets them build raw Firestore refs.
- `next` is an exact literal in `package.json`, never `catalog:` or a range.

## Routes (steps 2, 3, 14 and 15)

| Method | Path | Permission | Read switch | Answers |
| --- | --- | --- | --- | --- |
| GET | `/api/marketplace/amazon/conta/[id]` | `PERM.integracao.read` | not gated (no Amazon call) | 200 `StatusContaAmazon` · 400 `AMAZON_ID_INVALIDO` · 404 `AMAZON_CONTA_NAO_ENCONTRADA` |
| POST | `/api/marketplace/amazon/conta/[id]/oauth/start` | `PERM.integracao.write` | 503 `AMAZON_CHAMADAS_DESLIGADAS`, no Firestore read | 200 `{ authorizeUrl }` · 400 · 404 · 500 `AMAZON_CONFIG_AUSENTE` (names only) |
| GET | `/api/oauth/amazon/callback` | public (outside the CORS matcher) | redirect `integracao_desligada`, nothing consumed | redirect to `${WEB_APP_URL}/canais/amazon[/<id>]?amazon=connected` or `?amazon=error&reason=<motivo>` |
| POST | `/api/webhooks/amazon` | public; the relay key (outside the CORS matcher) | not gated (no Amazon call) | EMPTY body: 503 config · 401 key · 500 failure not persisted · 200 everything else, every drop included |
| POST | `/api/marketplace/amazon/enviar-nfe` (step 14, PR 14-d) | `PERM.pedido.write` | 503 `AMAZON_CHAMADAS_DESLIGADAS`, no Firestore read (no Amazon call either way) | body `{ pedidoId, nfeId? }`, strict (`pedidoId` = the ERP pedido document id) · 202 `{ enfileirado: true, pedidoId, nfeId }` · 400 `AMAZON_CORPO_INVALIDO` (field paths) · 503 `AMAZON_TAREFAS_DESLIGADAS` (queue valve, no read) · 404 `AMAZON_PEDIDO_NAO_ENCONTRADO` / `AMAZON_NFE_NAO_ENCONTRADA` · 409 `AMAZON_NFE_NAO_ELEGIVEL` + `motivo` · a missing or malformed queue region (checked before any read) or an enqueue failure other than the valve PROPAGATES (500, one ERROR line; a raw SDK failure leaves sanitized) |
| POST | `/api/marketplace/amazon/etiqueta` (step 15, PR 15-d) | `PERM.frete.read`; a FIRST schedule also needs `PERM.frete.write` | 503 `AMAZON_CHAMADAS_DESLIGADAS`, no Firestore read | body `{ pedidoId }`, strict (`pedidoId` = the ERP pedido document id) · 200 the label's bytes: `Content-Type` exactly `text/plain`, an attachment named `amazon-<orderId>.zpl` · 400 `AMAZON_ETIQUETA_CORPO_INVALIDO` (field paths) · 403 `AMAZON_ETIQUETA_SEM_PERMISSAO` · 404 `AMAZON_ETIQUETA_PEDIDO_NAO_ENCONTRADO` · 409 `AMAZON_ETIQUETA_NAO_ELEGIVEL` / `AMAZON_ETIQUETA_AGUARDANDO_NFE` / `AMAZON_ETIQUETA_RECUSADA` + `motivo` · 502 `AMAZON_ETIQUETA_INDISPONIVEL` · 503 `AMAZON_ETIQUETA_AMAZON_INDISPONIVEL` / `AMAZON_ETIQUETA_CONTA_INDISPONIVEL` / `AMAZON_ETIQUETA_DESLIGADA` · the LWA pair missing or a Firestore failure PROPAGATES (500, one ERROR line) |

Every answer carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
(`lib/amazon/core/respond.ts`, `proxy.ts`, and site-wide in `next.config.ts`).
The callback's fifteen ordered steps live in `lib/amazon/conta/conectar.ts`; the
route is thin. `proxy.ts` allows `GET, POST, OPTIONS`, and on an answer to an allowed origin
exposes `Content-Disposition` (the label's file name). The re-drive's codes are their own
closed set, `CODIGO_ERRO_NFE_AMAZON` (`@delfrance/schemas`), never a widening of
`CODIGO_ERRO_AMAZON`: `apps/web` keeps an exhaustive copy `Record` and a literal pin over that
one (step-14 plan §3 decision 21; the button and its copy are step 21's). The label route's are
a third closed set, `CODIGO_ERRO_ETIQUETA_AMAZON`, plus the read switch's reused code; its
envelope's `motivo` is a plain string (`erroEtiquetaAmazonSchema`), because this backend deploys
before `apps/web` and may send a slug the web does not know yet. Its one caller in `apps/web` is
the Amazon label provider (step 15, PR 15-e: `apps/web/lib/checkout/etiqueta/providers/amazon.ts`,
the checkout print and the `/pedidos` row action), which needs this backend deployed first.

## Receiver (step 3)

- `POST /api/webhooks/amazon` (= `CAMINHO_RECEPTOR_AMAZON`, the relay contract in
  `packages/schemas/src/relayAmazon.ts`) is THIN; `lib/amazon/notificacoes/receptor.ts` holds
  every decision, in order: config (503, nothing read) → relay key through the shared
  `verifyStaticSecret` (current AND previous, both always compared; 401, body unread) → body
  ≤ 2 MiB (`corpo.ts`: twice SQS's 1 MiB maximum — a bound on the read, never a filter on
  Amazon's input) → JSON → the `{ body }` wrapper → type + casing (`envelope.ts`: one parser per
  casing) → `ApplicationId` EXACTLY ours → routing fields by grammar → enqueue. Never a
  400/404/413 (D5). One `evento: 'notificacao'` line per delivery, with `chave: atual | anterior`
  after auth; never the seller id, the raw application id, a header or body text.
- The task payload is ids only, unknown keys STRIPPED, built field by field: a DECLARED departure
  from the `webhook-notifications` skill's `.passthrough()` rule (step-3 plan §3 decision 29;
  the body carries buyer data and the task re-fetches the order). Do not "fix" it.
- The enqueue races a 2-s deadline and the failure persist a 1.5-s one (`notificacoes/prazo.ts`),
  so the warm path answers inside the API destination's 5-s timeout (`prazos.test.ts`). A failed
  or late enqueue (the valve, a named transient, the deadline, a raw SDK error) is persisted as
  `failed` under `push:<NotificationId>` and answered 200; anything else is rethrown (500).
- ⚠️ `prazo.ts` holds the app's ONE consume-all: a rejection arriving AFTER its deadline answered
  is logged by class and dropped, because a rethrow there is an unhandled rejection that kills the
  instance. Rule 6 still applies everywhere else; do not "fix" that handler.
- The queue's composition root is `lib/firebase/filaLeitura.ts` (region with no default, the
  `AMAZON_TASKS_DISABLED=1` valve, `getFunctions(`); the receptor narrows SDK errors through
  `ehFalhaDoSdkDeTarefasAmazon` and DIRECTLY imports no SDK, context, conta read, park or Amazon
  client (`estrutura.test.ts`). Since step 14 (PR 14-c) the task-SDK helpers
  (`ehFalhaDoSdkDeTarefasAmazon`, `AmazonTarefasTransitoriasError`,
  `enfileirarNomeandoFalhaTransitoriaAmazon`, `regiaoDaFilaValidaAmazon`, and the named
  enqueue's `ehTarefaJaExistenteAmazon`) live in `lib/amazon/core/filaTarefas.ts` — the ONE
  production importer of `firebase-admin/functions` under `lib/amazon`
  (`IMPORTADOR_DO_SDK_DE_TAREFAS`) — and `notificacoes/agendador.ts` RE-EXPORTS the same
  objects, so its callers are unchanged. Its import closure still reaches the context, the
  conta reads, the park and the package through `./notificacao` and `../env`; no receiver path
  calls them, and the happy path makes no Amazon call and no Firestore operation
  (`receptor.test.ts`, `prazos.test.ts`).
- ⚠️ The App Hosting union walk (every route but the label route, the receptor, its producer
  `notificacoes/agendador.ts`, `lib/firebase/filaLeitura.ts`, the proxy) NEVER reaches the step-5
  importer or its seam, and no app file in it names `@delfrance/core/cep` or builds a ViaCEP
  client — walked by `estrutura.test.ts` with the `@/` alias and type edges followed. Since step
  14 (PR 14-d: the re-drive route joined it) the same walk also refuses the write ENGINE
  (`core/escrita.ts`, the one builder of a write client) and any `node:crypto` import (the NF-e
  body's MD5 is the task's, `nfe/conteudoNfe.ts`), and since step 15 (PR 15-d) the four scheduling
  modules (`agendamento/{agendadorAgendamento,entradasAgendamento,processarAgendamento,tarefaAgendamento}.ts`);
  in fact it reaches nothing under `agendamento/`.
- ⚠️ **The label route is the ONE App Hosting entry allowed to reach the engine** (step 15, PR
  15-d; `ARQUIVO_ROTA_ETIQUETA` in `estrutura.test.ts`), because the label must be in the request's
  answer. It has its OWN walk and its OWN list (`PROIBIDOS_NA_ROTA_ETIQUETA`): not the seam, not
  the importer, not `nfe/{processarNfe,entregaAmazon,conteudoNfe,carimboFreteNfe}.ts`, not
  `agendamento/{processarAgendamento,agendadorAgendamento,entradasAgendamento}.ts`, and, since it
  enqueues nothing, not this backend's producers (`lib/firebase/filaLeitura.ts`,
  `notificacoes/agendador.ts`, `nfe/agendadorNfe.ts`, `core/filaTarefas.ts`), with ViaCEP and
  `node:crypto` refused as on the union walk; and on that walk the only file naming the write
  client is the engine. So no other App Hosting entry reaches the engine or the scheduling
  producer, and the NF-e re-drive route keeps its step-14 rule.
- Both walks prove APP files
  only: they leave packages external, and the ViaCEP module itself is still loaded, inert,
  through the `@delfrance/schemas` barrel (`enderecoBuilder.ts` imports `ViaCepError` from it).
  That is why the seam table lives in `notificacoes/destinos.ts` (imported only by the functions
  roots), the importer's dependency and result types live in `notificacao.ts` (the importer
  imports them, never the reverse), and the CEP lookup is the STRUCTURAL port
  `BuscadorCepAmazon` (plan §3 decisions 32 and 48). Never import the importer, `destinos.ts` or
  `@delfrance/core/cep` into `notificacao.ts`, not even by type.

## Functions codebase (step 3)

- `functions/` is the nested Cloud Functions codebase `amazon` (NOT a workspace member: this
  app's tsconfig, `eslint .` and vitest cover it). `build.mjs` esbuild-bundles `src/index.ts`
  (externals: `firebase-admin*`, `firebase-functions*`; defines `FUNCTIONS_REGION` with no
  default, `FIREBASE_DATABASE_ID`, `TASKS_INVOKER_SA`); `scripts/prepare-deploy.mjs` writes
  `.deploy/amazon-functions`. `firebase.amazon.deploy.json` ships INERT: the deploy is W9, by a
  person, never an agent. `functions/DEPLOY.md` has the prerequisites, the commented-out runtime
  env and the IAM. ⚠️ The conta trigger `onIntegracaoAmazonChanged` stands outside the read
  switch: it makes no Amazon call and imports no importer, so deployed into a project it writes
  that project's `int_frete` on any Amazon conta save that moves a mirrored field. It deploys
  only after W12 (`functions/DEPLOY.md`).
- **The importer seam is FILLED (step 5, PR 5-e):** `lib/amazon/notificacoes/destinos.ts`
  (`DESTINO_TIPO_AMAZON.pedido` = `importarPedidoAmazon`), read per run by exactly two roots —
  `src/depsLeitura.ts` (the queue and the reprocess sweep; it also binds `viaCep`, the ONE
  process-wide `createViaCepClient()`, and is the only app file naming `@delfrance/core/cep`) and
  `src/pollPedidos.ts` (the poll's importer gate). So the read switch `AMAZON_CHAMADAS` is now the
  ONLY thing between a deploy and real imports: the pipeline checks it first, the context loader
  again. A null importer (tests, a future `tipo`) still defers as `importador-ausente`; the motivo
  stays because rows deferred under it may exist. Tests that need the empty seam MOCK
  `destinos.ts`'s `importadorPedidoAmazon` to `null` (`mockReturnValueOnce`), never edit the
  table. `src/index.test.ts` pins the import's recent-cancel window (15 min) above the
  reprocess sweep's and the queue's `timeoutSeconds` plus a minute, read off `__endpoint`: raise
  a timeout past it and that test reds (plan §3 decision 12).
- `src/index.ts` imports `./options` FIRST and ALONE and exports ONLY triggers:
  `filaLeituraAmazon` (the reads queue, = `FILA_LEITURA_AMAZON`, asserted at load),
  `processAmazonNfeUpload` (the step-14 NF-e queue, `src/filaNfe.ts`, = `FILA_NFE_AMAZON`,
  asserted at load), `processAmazonEasyShipSchedule` (the step-15 Easy Ship scheduling
  queue, `src/filaAgendamento.ts`, = `FILA_AGENDAMENTO_AMAZON`, asserted at load),
  `reprocessAmazonNotifications` (both lanes, logged separately),
  `sweepAmazonExpirations` (the step-2 expiry body, daily, NO secret), `pollAmazonOrders`
  (the step-4 backstop poll, `src/pollPedidos.ts`), `onIntegracaoAmazonChanged` (the step-20
  conta trigger, NO secret) and `onNfeAprovadaAmazon` (the step-14 NF-e trigger, NO secret).
  `index.test.ts` pins every option off `__endpoint`, in three families (schedules, queues,
  Firestore triggers), each exhaustive: THREE queues (`FILAS`) and TWO triggers (`GATILHOS`,
  each pinned to database `default`, `retry: true`, no secret, and a path row derived from
  its collection HANDLE — `nfev4Collection.resolvePath` anchored at
  `pedidos/{pedidoId}/nfev4` for the NF-e one).
- ONE logger there too: every line is `registrarEventoAmazon(LOGGER_STDOUT_AMAZON, …)` — never
  `firebase-functions`' `logger` (Loja Integrada's root uses it; do not copy that), never
  `console.`, never an error message (a failed sweep row by document id only). The package
  errors reach the task wrapper's own "Unhandled error" log only through the pipeline's
  sanitizing boundary (`FalhaTarefaAmazonError`). `estrutura.test.ts` widens the `.message`,
  seller-id, `trechoCorpo`, `testing/` and conta-cache scans to `functions/src`. (The two
  declared exceptions, both from `packages/data`: the `int_frete` core's warning on
  `incompleto` — see "int_frete binding (step 20)" — and the shared handles' soft-read warning,
  which the order import meets in the cliente resolver — see "Logging (step 2b)".)
- FOUR composition roots are the app's only `getFunctions(` callers, each pinned to the
  queue(s) it binds (`FILAS_DE_CADA_RAIZ` in `estrutura.test.ts`): `lib/firebase/filaLeitura.ts`
  (App Hosting: the reads queue for the receiver and, since step 14's PR 14-d, the NF-e
  queue for the re-drive route — BOTH behind its ONE `getFunctions(` call, pinned by
  `filaLeitura.test.ts`), `functions/src/agendador.ts` (the step-4 poll; the reads queue),
  `functions/src/agendadorNfe.ts` (step 14, PR 14-c: the NF-e queue, for the trigger and the
  task's own re-enqueues) and `functions/src/agendadorAgendamento.ts` (step 15, PR 15-c: the
  Easy Ship scheduling queue, for its two entries — bound by `src/filaNfe.ts` and
  `src/depsLeitura.ts` — and the scheduling task's own re-enqueues). Each reads the region as
  an object literal of STATIC `process.env` reads (esbuild's `define`). ⚠️
  `functions/src/agendador.ts` was deliberately NOT given the NF-e producer: its closure
  reaches `notificacoes/notificacao.ts` by value (the context, the conta reads, the SP-API
  error classes), which the NF-e trigger's D11 closure forbids. For the same reason the
  scheduling producer has its OWN root and was never added to `functions/src/agendadorNfe.ts`
  (an entry of that closure): `estrutura.test.ts` asserts the NF-e trigger's closure reaches
  nothing under `agendamento/` (step-15 plan §3 decision 23).
  `src/tasksInvoker.ts` stays byte-identical to every other codebase's copy.

## CI (step 3)

- The emulator suites run only in `.github/workflows/ci-amazon.yml`: ONE job, `Amazon Cloud
  Tasks round trip`, behind the pinnable `CI gate (amazon)`. No `ci.yml` exclusion, so a
  skipped lane loses only the emulator suites. The lane landed in the SAME PR as its first
  suites (a suite without a lane runs nowhere); a new `*.tasks.test.ts` or
  `*.firestore.test.ts` now joins the same job with no workflow edit. Editing the workflow →
  the `ci-lanes` skill; `ci-lane-gates.test.js` pins its emulator command, switch and regions.
- The job: `prepare-deploy.mjs`, then `firebase emulators:exec --config
  firebase.amazon.tasks.json --only firestore,functions,tasks` (ports 8087/5005/9502; that
  file sits ONE DOT from `firebase.amazon.deploy.json`, the only one that deploys), then
  `pnpm test:tasks`. Run it locally the same way (JDK 21) with the job's env:
  `FUNCTIONS_REGION` = `AMAZON_TASKS_REGION`, `FIREBASE_PROJECT_ID=demo-erp`,
  `FIREBASE_DATABASE_ID=default`, `REQUIRE_EMULATOR=1`, `AMAZON_CHAMADAS=off`, a dummy
  `AMAZON_RELAY_SECRET` of 32+ characters and the placeholder `AMAZON_APPLICATION_ID`. On
  Windows the Firestore JVM can outlive `emulators:exec` and keep 8087: stop it after.
- D11 holds in the lane through TWO layers. The job env sets `AMAZON_CHAMADAS: 'off'` (the
  functions emulator inherits it, so a DISPATCHED function stops at the switch), and
  `vitest.tasks.setup.ts` refuses to start when the shell has it `on` or an artifact `.env*`
  file (anchored name) merely names it (`testing/guardaDaLaneDeTarefas.ts`, proved offline).
  Only code in the vitest process runs past the switch, with `ambiente` `on` as an object
  literal and an injected `fetch`: the resolve case of `notificacao.firestore.test.ts` (a
  fake importer, a refusing `fetch`; step-3 plan §3 decision 37), the poll's two suites
  (`searchOrders` served by a scripted `deps.fetch`; `pollPedidos.firestore.test.ts`,
  `functions/src/pollPedidos.tasks.test.ts`) and the order import's
  (`pedidos/importarPedido.firestore.test.ts`: the REAL importer in-process, `getOrder` served
  by an injected `fetch`, a fake ViaCEP; the real batch semantics, interleaved importers, the
  recent-cancel race, the real cliente resolver) and the NF-e task's
  (`nfe/processarNfe.firestore.test.ts`: the task in-process, `getOrder` and the invoice
  status from a scripted `fetch` that refuses any POST). With the seam filled (PR 5-e), the
  DISPATCHED function still stops at the switch (`off` in the job env) before the importer,
  so no queue round trip in the lane ever reaches it; the dispatched NF-e task stops even
  earlier, at the NF-e valve (P6, `AMAZON_MODO_NFE` unset).
- Every suite's `beforeEach` wipes what it reads (one shared emulator, files run serially), a
  drop is proved by a LATER sentinel row, never by polling for an absence, and an absence only
  after a positive read. The receiver races its enqueue against 2 s, so
  `route.tasks.test.ts` warms the Admin SDK and the functions emulator with one unraced enqueue
  first; a `failed` row with an `enfileiramento/…` reason there means the receiver's own
  fallback ran (a region mismatch, or that deadline).
- (step 14, PR 14-c) The functions emulator also loads the NF-e trigger, which fires on EVERY
  `nfev4` write: the FOURTH sharing rule (`vitest.tasks.config.ts`) — a suite that writes a
  READY sale `nfev4` seeds its pedido FIRST with stored evidence that says NOT Delivery by
  Amazon (`marketplace.tipo: 'amazon'` with `fulfilledBy: 'AMAZON'`, or a `programs` list
  without `DELIVERY_BY_AMAZON`), so the trigger stops read-only at T3 (`nao-dba`). Only
  `functions/src/onNfeAprovadaAmazon.tasks.test.ts` seeds a pedido the trigger passes (the two
  drop cases first — an unproved pedido claiming the conta, and a proved one seeded under this
  very rule — then the sentinel; it awaits the dispatched task's `envio-nao-ligado` aviso).
  `lib/amazon/nfe/processarNfe.firestore.test.ts` runs the NF-e task in-process (`ambiente`
  `on` as a literal, `getOrder` and the invoice status from a scripted fetch that refuses any
  POST) under that rule — `programs`, because the stamp's freight verdict reads `fulfilledBy`.
- (step 15, PR 15-c) The functions emulator also loads the Easy Ship scheduling queue, and
  nothing in the lane dispatches to it: the read switch is `off`, so the order import (E2)
  never runs, and `AMAZON_MODO_NFE` is unset, so the NF-e task stops at P6 and never reaches
  the acceptance (E1). No new suite and no new sharing rule; a future suite that does reach
  the task still reads nothing while `AMAZON_MODO_AGENDAMENTO` is unset (A2's zero-read `off`
  arm, pinned offline).
- The lane cannot prove: Cloud Scheduler firing (`onSchedule` is ignored),
  `scheduleDelaySeconds` (firebase-tools#8254), `rateLimits`/`retryConfig` (pinned offline in
  `functions/src/index.test.ts`), index declarations, rules, the relay, or a trigger's
  `database` binding.

## Backstop poll (step 4)

- `pollAmazonOrders` (`functions/src/pollPedidos.ts`, `7,22,37,52 * * * *`, 300 s, no retry)
  binds the deps ONCE per tick; the body is `lib/amazon/pedidos/pollPedidos.ts`. A throw
  leaves the tick through `sanitizarFalhaDaTarefaAmazon` (the scheduler wrapper logs the
  message). `index.test.ts` pins tick budget 240 s < timeout 300 s < lease 360 s < the 900-s
  interval READ off the cron.
- Two gates in the code, in order, each with ZERO Firestore operations: no importer in the seam,
  then the read switch not exactly `on`. Since step 5 (PR 5-e) the first is permanently OPEN
  (the seam is filled), so the read switch is the only gate that remains: no poll document, and
  no bootstrap anchor, can exist before W5. The gate code stays (an emptied seam closes the poll
  again).
- `pollPedidosAmazon/{contaId}`: `cursorMs` (ms, Amazon's `lastUpdatedTime`, capped at the
  drain's start − 5 min, advance-only, moved only after a COMPLETE drain with every row valid),
  `pendente` (a stopped drain, resumed byte-identical unless its token is 23 h old), `vistos`
  (orderId → µs, read straight from Amazon's ISO text; pruned to cursor − 25 min and 2,000),
  the lease, `falhasSeguidas`. A fresh window starts at cursor − 10 min. Units: never compare
  `cursorMs` with a `vistos` stamp without converting.
- A per-conta DEADLINE (min(200 s, what the tick has left) − 20 s), checked before every page
  and every enqueue: a slow Cloud Tasks ends the run `orcamento-esgotado` with what it handed
  off written, never killed by the timeout with nothing written. Never remove it.
- `searchOrders` has exactly ONE caller module (`pedidos/pollPedidos.ts`), across `lib/`,
  `app/`, `functions/src` and `scripts/` (`estrutura.test.ts`): a second caller spends the
  poll's ~5 tokens per tick. A W7 verification script must never call it while the poll runs.
- `amazonImportacaoParada` is raised only after the final write that stored its count LANDED,
  resolved by the next clean run, and closed by the expiry sweep's orphan pass once the conta
  is gone (clocked by the conta list's read time; a deactivated conta's row is a residue).
- **Re-bootstrap (W7, by a person; `functions/DEPLOY.md` has the steps):** a changed H is
  redeployed FIRST; then a manual lease (`execucaoId` `w7-manual` first, then `emExecucaoAteMs`
  ahead), re-read after 6 min, delete the three FIELDS `cursorMs`, `pendente` and `vistos`
  (never the document), release. The next lease anchors now − `AMAZON_POLL_LOOKBACK_H`
  (functions only, default 24, cap 720, invalid ⇒ `lookback-invalido`). Never "check no
  lease is held, then delete": a run already holding it re-derives its OLD cursor back over a
  cursorless doc. Changing H after a conta's first LEASE (whatever that run's outcome) does
  nothing for it.

## int_frete binding (step 20)

- The ONE binding is `lib/amazon/frete/intFrete.ts`: `syncIntFreteAmazon`, the shared core
  (`@delfrance/data/admin/frete`) bound to `VINCULO_INT_FRETE_CONTA.amazon` with ZERO options
  (no tolerant scan). The trigger and step 5's importer go through it; never build a second one
  in this app. The window pass (W12) cannot import `apps/amazon`, so
  `tools/migrations/src/2026-10-amazon-int-frete/transform.ts` binds the SAME row with the SAME
  zero options, pinned by its `transform.test.ts` (row identity, no tolerant scan): all three
  must name the same doc. Freight tipo `amz` (never `amazon`); a new doc is
  `amz-<integracaoId>`; a migrated one (64-hex id) is adopted by `contaAmazonContaFreteAmazonOuterRef`.
- `functions/src/onIntegracaoAmazonChanged.ts`: `deveReconciliar(before, after)` is a COST
  filter (zero reads for any write that is not, and was not, an Amazon conta, or moves no
  mirrored field); the reconcile takes the conta id ONLY — never a snapshot or an event clock.
  One `evento: 'int-frete'` line per reconcile (field NAMES joined, never a value or the
  `nome`; WARNING on `incompleto`). No `try`/`catch`: Firestore/Zod errors reach the Eventarc
  retry.
- The order import (step 5: `lib/amazon/pedidos/importarPedido.ts`, its step 5; wired into the
  reads queue and the reprocess sweep by PR 5-e) is the consumer: it reads the conta's freight doc with
  `syncIntFreteAmazon.buscarIntFreteDaConta(db, contaId, { apenasAtivo: true })` over RAW bodies,
  uncached and outside any transaction (its answer feeds a write, fill-once on the pedido's
  freight block). Reconciliation never filters `ativo`.
- ⚠️ The declared departure from the one-logger rule: on `incompleto` the core also writes its
  own unstructured stderr warning (`[amazon] conta Amazon sem dados suficientes para criar o
  int_frete`, the conta id and field names only), from `packages/data`, where
  `estrutura.test.ts` cannot see it. One `incompleto` event therefore produces two WARNING
  lines. Routing it through an injectable logger is a core change for four channels.
- D11 by construction: `estrutura.test.ts` walks the trigger's whole import closure (type edges
  included) and pins it file by file; it may import the SP-API package as TYPES only. The conta
  trigger keeps its OWN forbidden list (`PROIBIDOS_NO_GATILHO`); since step 14 `violacoesD11`
  takes the list as a parameter, and the NF-e trigger has its own (`PROIBIDOS_NO_GATILHO_NFE`) —
  the two are not interchangeable (a test shows each closure fails the other's list).
- Emulator suites: the trigger fires on EVERY suite's `integracao` writes. A suite that seeds a
  COMPLETE Amazon conta (filial + `dataCadastro` + `nome`) becomes a trigger suite and must
  await the trigger's last write (`vitest.tasks.config.ts` has the four rules; the fourth is
  the NF-e trigger's).

## NF-e upload (step 14)

- **The trigger** `functions/src/onNfeAprovadaAmazon.ts` (body `lib/amazon/nfe/gatilhoNfe.ts`):
  the FOURTH function on every `pedidos/{pedidoId}/nfev4/{nfeId}` write of the project.
  **T1** the two EDGES — the upload edge (`decideNfeUploadTransition`) or the a→c edge
  (`cancelamentoDeNfeAprovadaAmazon`, an eligible approved sale note cancelled); neither ⇒
  ZERO reads and NO line. **T1b** the sale gate on the upload edge (`finalidadeDaNfeProc`: a
  legible non-sale note ⇒ one INFO line; ILLEGIBLE goes on, the task judges it). **T2** ONE raw
  pedido read; its `readTime` clocks the trigger's avisos. **T3** proof / emission block /
  stored pre-filter, each ONE line at `motivosNfe.ts`'s level (`nao-dba` at WARNING). **T3c**
  (a→c) a stored cancelled SALE ⇒ one line; otherwise the aviso `nfe-cancelada` (no stamp, no
  enqueue). **T4** the ONE named enqueue, `id = sha256Hex(event.id)`: `ALREADY_EXISTS` ⇒
  `ja-enfileirada` (tier 0), and a 409 whose body says ABORTED stays a transient. **T5** catches
  ONLY `AmazonNfeTarefasDesligadasError` ⇒ the aviso `tarefas-desligadas`; anything else reaches
  the Eventarc retry. Lines are `evento: 'nfe'`, `fluxo: 'nfe'`. D11 by construction: its EXACT
  closure (with its root `functions/src/agendadorNfe.ts`) is pinned against
  `PROIBIDOS_NO_GATILHO_NFE`.
- **The queue** `functions/src/filaNfe.ts` → `lib/amazon/nfe/processarNfe.ts`, P0–P12: P0 the
  payload (`.strict()`); P1 the NF-e valve read and logged BEFORE any read; P2 the `nfev4` doc
  through the LEVEL predicate (a `'c'` doc in a verification ⇒ `nfe-cancelada`); P3 the pedido's
  proof and emission block (`avaliarPedidoParaTarefaNfeAmazon` — never the trigger's stored DBA
  pre-filter), a stored cancelled SALE (`cancelado` OR `estornadoIntegralmente`,
  `vendaCanceladaAmazon`) ⇒ the incidente `amz-nfe-pedido-cancelado` + resolve, ZERO Amazon
  calls; P4 the sale gate (illegible ⇒ `xml-invalido`, aviso + stamp); P5 ONE unfiltered
  `nfev4` listing ⇒ siblings (`nfe-ambigua` before any Amazon call); P6 fase `envio` ONLY: the
  valve's target, `off` ⇒ `envio-nao-ligado` with no context; P7 the context (the switch first);
  P8 the LIVE order on EVERY dispatch through `lerPedidoAmazon` with `pisoUs` = the stored
  watermark (in a verification every gate but the cancelled sale is logged and the read goes
  on; the open request raises its per-pedido row there, and its NF-e row only when the
  outcome wrote nothing to that row — every raise of a dispatch carries ONE clock and the seam
  drops an equal one, so the row is written at most once per dispatch); P9 status FIRST
  (`nfe/entregaAmazon.ts`, the ONE caller of both Delivery helpers), then the envio table
  through the write engine (at most ONE `submitInvoice`) or the verification table; P10 the
  submit and everything after it is a NO-THROW boundary (a lost write ⇒ ONE WARNING
  `pos-envio-falhou`); P11 a 429 pauses (`pausaNfeAmazon`, no attempt
  spent), a transient throws, and the LAST attempt answers (`amazon-indisponivel` in envio,
  the next rung in a verification); a LOST chain enqueue is never a silent drop — the queue
  valve, on any attempt, ⇒ `tarefas-desligadas`; any other loss inside the boundary, or before
  it on the last attempt, ⇒ where the chain ends without that step (after OUR submit the
  verification enqueue keeps `aceite-nao-confirmado` / `envio-nao-confirmado`, the valve
  included); P12 aviso → re-enqueue → stamp → resolve; `aceita`: the
  clear → `nfe-validada` → the step-15 seam (`nfe/destinoAceite.ts`, FILLED by PR 15-c with
  `enfileirarAgendamentoDoAceiteAmazon`: E1, ENQUEUE-only, never an Amazon call — ONE task
  onto the scheduling queue NAMED after this NF-e dispatch's own task id, so a queue retry of
  the same dispatch dedupes; a deterministic refusal is ONE WARNING, a transient is rethrown
  and retries the whole NF-e dispatch, which never resubmits, except on the NF-e queue's last
  attempt). Only the trigger and E1 NAME a task on this flow's side; the chain (and the
  re-drive route) enqueue UNNAMED. ONE `evento: 'nfe'`
  dispatch line per run (`registrarDespachoNfeAmazon`), never the XML, its base64, the digest
  or a 44-digit run.
- `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`: concurrency 1 is the
  ORDERING GUARD between one order's own writes (no event clock orders a stamp against a later
  clear) — raising it needs an event-clock watermark first. `timeoutSeconds 300` > the 220-s
  worst case read off `PRAZO_AMAZON_MS` (`index.test.ts`).
- **The importer's two TRANSITION resolves** (`pedidos/importarPedido.ts`, step 8b,
  `transicoesNfeDoPedidoAmazon`): a winning UPDATE INTO a cancelled sale ⇒
  `resolverNfeDoPedidoAmazon(… 'pedido-cancelado')` + ONE `nfev4` listing, an authorized sale
  note ⇒ the incidente `amz-nfe-pedido-cancelado`; freight INTO `ESTADOS_FRETE_REMOVE_ESTOQUE`
  ⇒ `frete-despachado`. Both clocked by the batch `writeTime`. On a REDELIVERY
  (`registro.tentativa` not 0: a queue retry, a sweep's re-drive) the same two writes run on the
  CONDITIONS the pedido holds (`condicoesNfeDoPedidoAmazon`, clocked `writeTime` else the winning
  snapshot's `readTime`): the attempt that wrote the transition may have died after its commit,
  and every one of those writes is idempotent. Every other FIRST attempt reads no `nfev4` and
  no `nfeUploadRejeitado` row.
- **The re-drive route** `POST /api/marketplace/amazon/enviar-nfe` (PR 14-d; body
  `lib/amazon/nfe/reenvioNfe.ts`, the route is thin): `PERM.pedido.write`; the body STRICTLY
  `{ pedidoId, nfeId? }` (a `fase` or a counter is a 400, never ignored) → the read switch
  (503, nothing read) → the queue valve (503 `AMAZON_TAREFAS_DESLIGADAS`, nothing read) → the
  queue's region (missing or malformed ⇒ one ERROR line, 500, nothing read — the receiver's
  check, so a broken deploy shows whatever the pedido) → the RAW pedido (404) → the TASK's
  verdict (`avaliarPedidoParaTarefaNfeAmazon`: the proof, the emission block — never the
  trigger's stored pre-filter) → the slot: an explicit `nfeId` judged by
  `motivoForaDoEnvioNfeAmazon` (the LEVEL predicate + the sale gate — never the transition
  one), else ONE unfiltered listing and `escolherNfeParaEnvioAmazon` (the closest miss in the
  409's `motivo`) → ONE UNNAMED enqueue of `tarefaInicialNfeAmazon` → 202. Its ONLY side
  effect is that enqueue: no Amazon call, no Firestore write, and it never reads
  `AMAZON_MODO_NFE` / `AMAZON_CANARIO_NFE` (step-14 plan §3 decision 20: the task is the one
  source of truth for a write). Enqueued ON PURPOSE, for the task to answer: an illegible proc
  (the task avisa and stamps it), a stored cancelled sale (the task's P3 incidente
  `amz-nfe-pedido-cancelado`, zero Amazon calls) and a pedido with TWO eligible sale notes
  (the slot rule names one, or the body did — the explicit arm reads no listing; the task
  raises `nfe-ambigua` at P5, before any Amazon call). Some
  task outcomes are log-only (`SO_LOG`): a 202 followed by no aviso change is read in that
  pedido's `evento: 'nfe'` lines. Only `AmazonNfeTarefasDesligadasError` is answered at the
  enqueue; a Cloud Tasks transient, a region error or a raw SDK failure PROPAGATES (500)
  after ONE ERROR line (`resultado: 'falhou'`, the class only), the raw SDK one rethrown as
  `AmazonNfeEnfileiramentoFalhouError` (no `cause`, no `httpResponse`: the SDK error carries
  the answered body as its own properties): a transient enqueue may have landed, so no coded
  answer claims "nothing enqueued". ⚠️ A second re-drive of the same pedido inside Amazon's
  read-after-write lag (≈ 3 min, `ULTIMO_DEGRAU_DO_ATRASO_NFE_AMAZON`) will most likely SUBMIT
  THE NF-e AGAIN — the status-first read does not stop it inside the lag — and a re-drive does
  not clear the pedido's aviso row: re-drive each pedido ONCE (after a 500 too) and wait ~5 min
  or for the aviso to change. One line per answer (`evento: 'nfe'`, `rota: 'enviar-nfe'`; the
  switch's is the shared `chamada-bloqueada`). "Reenvio" in `reenvioNfe.ts` is this HUMAN
  re-drive (a fresh chain); `tarefaNfe.ts`'s `reenvioNfeAmazon` / `reenvios` is the chain's
  one automatic resubmit.
- **Avisos** (`nfe/avisoNfe.ts`): key `chaveDeAviso(nfeUploadRejeitado, integracaoId,
  pedidoId)` — ONE row per pedido; `params` exactly `pedido` and `erro`; a motivo outside set A
  is a `RangeError`, nothing written. `MOTIVO_AVISO_AMAZON` gained `pedidoCancelado`,
  `freteDespachado` and `nfeValidada` (the shared contract's resolve motivos); `depsDeEscrita`
  is exported. `avisoNfe.ts` converts no clock: `avisos.ts`'s three conversion sites are
  unchanged (`relogioDoDocumentoUs`, `agoraUsDe`).

## Layout

- `lib/amazon/` is Next-free except `core/respond.ts`, never imports the `@/`
  alias, and never reads `process.env`: the environment is a PARAMETER
  (`env.ts`), so step 3's functions bundle can import it. `estrutura.test.ts`
  pins all of it.
- `lib/amazon/avisos/avisos.ts` is the ONLY module that converts a clock to microseconds
  (three conversion sites, counted by its test). The poll's order stamps are µs read
  straight from Amazon's ISO text (`pedidos/janelaPoll.ts`), never a converted clock; so is
  the order import's watermark (`lerInstanteAmazon`, offset REQUIRED), and its "now" is
  `agoraUsDe` from `avisos.ts`, read ONCE per import. `coerceToMicros`
  (`pedidoMapeamento.ts`, `freteAmazon.ts`, `pagamentoAmazon.ts`) only READS STORED stamps
  (legacy ms integers, ISO text) — it is not a clock conversion, and it never reads the wire.
- The order import (step 5) lives in `lib/amazon/pedidos/` and `lib/amazon/frete/`:
  `lerPedidoAmazon.ts` (the ONE `getOrder` caller across `lib/`, `app/`, `functions/src` and
  `scripts/`; since step 14 its second parameter is just `{ amazonOrderId, pisoUs }` — the
  importer maps a poll payload to its `lastUpdatedUs` and a push to `null`, the NF-e task
  passes the stored watermark — so it reads no payload), `vinculoProdutoAmazon.ts` (link
  docs only, no SKU fallback), `escritaPedido.ts` (the ONE `.batch(` site) +
  `escritaPagamento.ts`, `importarPedido.ts` (the orchestration), `incidentesPedidoAmazon.ts`,
  the PURE mappers (`pedidoMapeamento.ts`, `estadoPedidoAmazon.ts`, `vendaAmazon.ts`,
  `itensAmazon.ts`, `dinheiroAmazon.ts`, `clienteAmazon.ts`, `freteAmazon.ts`,
  `pacotesAmazon.ts`, `pagamentoAmazon.ts`, `orderIds.ts`, `codigosPedidoAmazon.ts`, `erros.ts`)
  and `frete/estadoFreteAmazon.ts` (the ONE freight-estado verdict steps 7, 14 and 15 route
  through). `estrutura.test.ts` pins the single getOrder caller and the single batch site.
  `pedidos/falhaLeituraAmazon.ts` (step 15, PR 15-b) is the ONE class ladder of a READ-side
  failure (the context's conta and credential classes, `getOrder`, `lerPedidoAmazon.ts`'s own
  refusals) into neutral tokens (`classificarFalhaDeLeituraAmazon`): the NF-e task maps them
  onto its motivos, the Easy Ship scheduling onto its answers — never a second copy.
- The write engine `core/escrita.ts` (step 14, PR 14-b) is the ONE module that builds an
  SP-API write client (`estrutura.test.ts` refuses the constructor named in any other
  production file of the app — all of `lib/`, `app/`, `functions/`, `scripts/` and
  `proxy.ts`): the target under the valve (`off` reads nothing), the current-state read,
  the pure plan, ONE `evento` diff line under dry-run (or `on` outside the canary), else ONE
  write through the forced-refresh-once rule. It never repeats a write that may have
  landed. The NF-e upload lives in `lib/amazon/nfe/` — its pure decisions (14-b: the task
  payload and its builders, the status reader, the MD5/base64 content, the ownership proof,
  the live-order gates, the decision tables, the closed motivos) and, since 14-c, its WIRING
  (see "NF-e upload (step 14)"). `nfe/tarefaNfe.ts`, `nfe/motivosNfe.ts` and `nfe/pedidoNfe.ts`
  stay LIGHT: they sit in the NF-e trigger's EXACT D11 closure (`ENTRADAS_DO_GATILHO_NFE`,
  checked against `PROIBIDOS_NO_GATILHO_NFE` by `violacoesD11`, type edges walked), which
  superseded 14-b's dedicated LIGHT guard — no SP-API value import, nothing of `pedidos/`
  but `orderIds.ts`, no unresolved or `@/` import.
- Since step 15 (PR 15-b) the engine's single-target entry has exactly two callers, one per
  write flow that runs (`estrutura.test.ts`): `nfe/processarNfe.ts` and
  `agendamento/executarAgendamento.ts`. (Step 12a gave it a third event row, `estoque`, for
  the per-SKU stock write; that flow has no caller yet.)
  `escrever` gets a third argument, a restricted-client FACTORY (a Restricted Data Token in,
  a write client that sends it out); the engine builds BOTH clients through its ONE local
  builder (`construirClienteEscrita`), which holds the file's one observer site, so each
  client gets its own observer. The forced-refresh-once rule wraps the WHOLE `escrever`, so
  a 401/403 on the mint or the bulk refreshes once and mints a NEW token. The label route (PR
  15-d) adds no third caller: it runs through `executarAgendamento.ts`.
- Since step 12a (PR 12-b) the engine has a SECOND entry, `executarLoteEscritaAmazon`: one
  `JSON_LISTINGS_FEED` for a batch of stock or price, with NO caller yet. `decidirLote` first
  (`off` builds nothing), then `decidirAlvo` for every member (under `on` + `*` an invalid SKU
  never reaches `montar`; every member that is not `on` is counted by its motivo). A canary LIST answers
  `so-patches` with exactly the `on` members (nothing built: the caller sends them per SKU);
  `dry-run` builds the WHOLE document and writes ONE line (`evento` =
  `EVENTO_DO_LOTE_AMAZON[fluxo]`, `fase: 'feed'`, the message and byte counts); `on` + exactly
  `*` builds the `on` members only and submits ONCE, a document with no message writing
  nothing; a `montar` refusal (`abortado`) comes back whole, nothing posted. Its valve is typed
  by the batch fluxos through its OWN event map, so a price batch compiles before price has a
  per-SKU writer. Both entries reach the write client through ONE private helper
  (`escreverUmaVez`), so the builder keeps its three places and the observer seam its four
  sites. Its roster, `CHAMADORES_DO_LOTE_DE_ESCRITA` (`estrutura.test.ts`), is separate from
  the first entry's and pinned EMPTY.
- The Easy Ship scheduling (step 15) lives in `lib/amazon/agendamento/`, Next-free, reading no
  process environment and never importing `@/` (`estrutura.test.ts`). PR 15-b shipped its
  pure half — the task contract
  (`tarefaAgendamento.ts`: the strict payload, its three builders, the entry task NAME per
  OBSERVATION — the NF-e dispatch's task id, or the pedido plus the import read's
  `watermarkUs` — never per pedido); the pure decisions (`decisaoAgendamento.ts`: the live
  order through step 7's fold, `ACCEPTED` only, the stored gates on the RAW pedido, the NF-e
  gate over one `nfev4` listing, Amazon's answer read `rejectedOrders` first, the plans —
  a stale print read never writes — and the print's outcome over an existing schedule, where
  the URL decides); the ONE module naming the token mint and the bulk
  (`easyShipAmazon.ts`: it never returns, logs or stores the token, and its
  `ehFalhaHttpDoBulkEasyShip` tells the bulk's own HTTP answer from the mint's or an LWA
  exchange's — only the bulk's can be Amazon refusing the order); and the ONE run
  (`executarAgendamento.ts`), which tags every failure with its PHASE (`leitura` before the
  plan reached `escrever`, `escrita` after), because the engine lets a `getOrder` 404 and a
  bulk 404 out through the same throw. PR 15-c WIRED it: the
  pure producer (`agendadorAgendamento.ts`: the ONE named enqueue, `enfileirarEntrada`, and
  the unnamed `enfileirar` for the task's own rungs); the two ENTRIES (`entradasAgendamento.ts`:
  E1 from the NF-e acceptance seam, E2 from the order import's post-commit step 8c, each
  named after its observation; a deterministic refusal is ONE WARNING, a transient is
  rethrown into the observing dispatch's retry); and the TASK (`processarAgendamento.ts`,
  A0–A9: the payload proved against its pedido id, the valve FIRST — `off` reads nothing —,
  the stored gates and ONE `nfev4` listing, the context, the run, then the outcome split by
  the run's PHASE — only the bulk's OWN HTTP answer can raise a scheduling refusal; a mint's
  or an LWA exchange's never does). ⚠️ The order import's deps name the producer only
  through a LOCAL structural port in `notificacoes/notificacao.ts`
  (`ProdutorAgendamentoAmazon`): that module sits on the App Hosting union walk, which
  `estrutura.test.ts` asserts reaches nothing under `agendamento/` — never import the
  producer's type there. Nothing under `agendamento/` makes a Firestore WRITE call
  (`estrutura.test.ts`): the task's avisos go through `avisos/avisos.ts`. PR 15-d added the
  label route's body, `etiquetaAmazon.ts` (`imprimirEtiquetaAmazon`; the route file verifies
  `PERM.frete.read`, computes `podeAgendar` from `PERM.frete.write`, binds the deps and answers):
  the strict body → the read switch (503, nothing read) → the valve, read once → ONE raw pedido
  read and ONE unfiltered `nfev4` listing → the stored gates → the target (`off` ⇒ 503
  `DESLIGADA`, no Amazon call; unlike the task's `off` it has read those two by then, because the
  target comes from the pedido) → the context → the run in `impressao` mode (a stale read answers
  "wait and reprint" whatever the order says and never writes; a failure with `fase: 'leitura'`
  reads through `classificarFalhaDeLeituraAmazon`, and no bulk having been sent it is never
  `RECUSADA`) → `desfechoImpressaoAgendamentoAmazon`, which holds the table of the bulk's outcome
  (the route only maps each token to its answer) → the zip's download, at once, with the SAME
  `fetch` the context received → exactly one verified ZPL entry → its bytes. The zip is never
  forwarded and nothing is stored. Its worst case, 240 s, is pinned under the 300-s ceiling
  (`prazos.test.ts`). ⚠️ `etiquetaAmazon.ts` is the ONE production file naming
  `baixarDocumentosEasyShip` and `extrairEtiquetaZplEasyShip`, comments included
  (`estrutura.test.ts`, the whole app): a second reader of the pre-signed link would sit behind no
  valve, canary or live decision. The route file and every `agendamento/` file on its walk name
  no aviso writer and enqueue nothing (`estrutura.test.ts`).
- The `JSON_LISTINGS_FEED` core (step 12a) lives in `lib/amazon/feeds/`. PR 12-b shipped its
  pure, UNWIRED half (nothing calls it yet): `registroFeed.ts` (the record's forward-only
  status, `processingStatus` read exactly, the 12-h deadline and 48-h abandonment counted from
  `antesDoEnvioMs`, and the rung write — `rodadas` and `atualizadoEmMs` on EVERY rung, never a
  terminal status, which is the tail's last write); `escadaFeed.ts` (the poll ladder);
  `relatorioFeed.ts` (the report reduced: attribution by `sku` only, the link issue shape, at
  most 200 SKUs written back); `tarefaLote.ts` (the strict jobs-queue payload union — a block
  or a window batch — and every task name, each carrying the conta (the notification wake-up's
  carries the seller)); `provedorLote.ts`
  (the provider seam's TYPES, the closed abort motivos, the timing constants); and
  `vezFeed.ts` (the lease's state machine: `decidirTomadaDaVez` classifies a read, a known
  `feedId` is never submitted over and an uncertain `enviando` is never taken over before its
  12 h; `destinoDoLoteRecusado` routes a batch the lease turns away — a tick-born window
  batch records its start, MIN-merged, a recovery-born one waits then goes per SKU, a block
  batch waits; the breaker and its hourly half-open probe; the 120-s submission floor on a
  take only; and every write's exact field patch, each refused, writing nothing, unless its
  HOLDER — the `execucaoId`, or the `feedId` once known — still holds the lease. A take keeps
  `pendenteDesdeMs`, `falhasSeguidas`, `ultimaFalhaEmMs`, `ultimoEnvioMs` and
  `ultimoFeedConcluidoEmMs`; every release reads the start it consumes from its READ and
  answers it as `vezPara`, to be enqueued before the write; `REGRA_DA_LIBERACAO` is the closed
  release table — 0 after a completed feed, +1 for exactly the releases that raise the feed
  failure aviso). The record and
  the lease are `feedsAmazon` / `feedsAmazonEmCurso` (`@delfrance/schemas` `feedAmazon.ts`,
  Admin-only, no Meta; handles `feedAmazonCollection` / `vezFeedAmazonCollection`); only the
  record carries the TTL stamp `expiraEm` (180 days).
- The conta cache (`core/contaCache.ts`) is token-free and used by the context
  loader ONLY; the credential is re-read uncached on every request.
- Routes never import the park (`core/estacionamento.ts`); step 3 is its first caller.
- The logger stays LIGHT: the import closure of `core/log.ts`, `core/redacao.ts`,
  `core/formatoDaRef.ts` (the ref FORMAT, no import at all), `core/idConta.ts` (the
  conta-id grammar, no import at all; `core/contas.ts` re-exports it) and
  `core/valvulas.ts` never reaches `firebase-admin`, `@delfrance/data`, `next` or `@/`;
  `redacao.ts` imports only `zod` and `@delfrance/core/{wire,documents}`. `refCredencial.ts`
  keeps the hash and re-exports the format. `estrutura.test.ts` pins all of it.

## Logging (step 2b)

- ONE logger: `LoggerAmazon` in `core/log.ts`, campos PRIMITIVE only (a list is joined into
  one string at the call site). Routes hand in `LOGGER_STDOUT_AMAZON` (one JSON line on
  stdout, `severity` + `message` written AFTER the campos; every campo re-checked at run
  time by `camposSeguros`: masked, cut to 256 bytes, non-primitives `<nao-primitivo>`).
  Never `console.*`, never a second logger. A shared module that logs untyped campos
  (`escreverAviso`) gets the app's `warn` through `warnNaoTipado`.
- ONE line per Amazon call, built by `criarObservadorAmazon` and handed to the package's
  hook at EXACTLY four sites: the LWA refresh and the SP-API client (`core/contexto.ts`;
  callers pass `registro` — flow, attempt, task/notification ids — and the loader writes
  `logger` and `conta` LAST), the code exchange (`conta/conectar.ts`), and the write
  engine's one client builder (`core/escrita.ts`, step 14; labelled the loader's way; since
  step 15 it builds the LWA write client AND every restricted client, each with its OWN
  observer, so the count stays four). Only `core/log.ts` names the raw event type;
  `estrutura.test.ts` refuses any other observer (inline, forwarded, shorthand, combined,
  shadowed, renamed).
- The line is a projection (`CHAVES_DA_LINHA`, 26 keys): envelope by grammar, the redacted
  path + query, `credencial` (`lwa-acesso` / `rdt` / `lwa-refresh` / `lwa-codigo`), the ref's
  VERSION only, codes through the closed `CODIGOS_ERRO_AMAZON` (`<outro>` otherwise). `rdt`
  (step 15) is an SP-API call sent with a Restricted Data Token — the Easy Ship bulk, listed
  in `OPERACOES_COM_TOKEN_RESTRITO_AMAZON`, a LOCAL literal (the logger may import the
  package as types only); the token MINT is sent with the LWA token, so it says
  `lwa-acesso`. A restricted call is labelled with the LWA credential's ref version.
  NEVER in a line: a token, the client secret, the state, the code, a seller id (a path
  slot is `<sellerId>`), the ref or its fingerprint, an LWA body, a header, a raw query.
- The excerpt fails closed: no excerpt for LWA, for ANY 401/403, for a call without a ref
  version, or for a `segredo` path (RDT, client secret, `/documents`). Otherwise the
  allow-list walk of `redacao.ts` (path → template → table; denied subtrees/keys/prefixes
  win at any depth, any case; the regex layer runs PER LEAF on decoded strings, Amazon-made
  id leaves skip only the check-digit pass — a seller-typed one (SKU, alias, promotion,
  package ref) never does; mask first, cut to 2 KiB second). A non-2xx body keeps
  structure, booleans, `null`, integers below 1e7 and known codes only. Never widen a
  table, a code set or a key rule "to see the error".
- ⚠️ **The observer must never throw.** The package rethrows an observer's error in place
  of the outcome, and at the code exchange the state is already consumed: a throwing
  logger loses the seller's grant. `log.ts` and `redacao.ts` have no `catch` — they are
  total by construction; the totality matrix covers every outcome the four call sites can
  emit. A write client's observer matters most: a throw there would hide whether a write landed.
- Never log `err.message` of an `AmazonError` (it embeds the path, which can carry a seller
  id): log `err.name`, the status and the codes. `estrutura.test.ts` refuses a `.message`
  inside any `.info|warn|error(` call and any non-call writer (`registrarEventoAmazon`,
  `registrarChamadaBloqueadaAmazon`, `registrarValvulaAmazon`), and a `trechoCorpo` campo
  outside `log.ts`. The sweep's returned `erros[].erro` is the class name too.
- A new operation stays keys-only in the log (and refused as a fixture) until its step adds
  its table rows AND regenerates the committed leaf inventory, from the repo root:
  `node .master_plans/amazon/evidence/amazon-doc.mjs folhas --saida
  apps/amazon/lib/amazon/testing/especificacaoFolhas.json` (the cache or
  raw.githubusercontent.com, never the SP-API; `OPERACOES_FOLHAS` lists the operations).
  `redacao.test.ts` demands every inventory leaf be classified exactly once.
- The order import (step 5) writes `evento: 'pedido'` lines (`importarPedido.ts`): one CLOSED
  code per line (its own `CODIGO_LOG_PEDIDO_AMAZON`, the mappers' events, the skipped first-seen
  motivos), the order id and counts — never a buyer datum, a price, a `cancelReason`, a token
  or a tracking number. Its `getOrder` and LWA calls write the ordinary call lines through the
  context's client. The reads queue's ONE `evento: 'tarefa'` line per dispatch also carries the
  import's report — `acao`, `itens` (the D17 lines verdict) and `linhasPreservadas`,
  `linhasDivergentes`, `linhasSemProduto` — null on every arm without one; a `done` import whose
  `itens` is `divergencia-itens-aprovado` (an order BLOCKED for a person) logs WARNING.
- The Easy Ship scheduling (step 15) writes `evento: 'agendamento'` lines: the write engine's
  dry-run diff, EXACTLY `acao`, `motivo`, `fase`, `invoiceStatus`, `modoExecucao`,
  `escreveria` (closed tokens) plus the engine's own campos; an entry's WARNING
  `agendamento-nao-enfileirado` (the error class only) or INFO `ja-enfileirada` (PR 15-c);
  and ONE dispatch line per scheduling task run (`registrarDespachoAgendamentoAmazon`:
  `fila`, `acao`, the closed `motivo`, `origem`, `espera`, `pausas`, the ids, the live
  `decisao`, the read-side token `falha`, the error class, the rejection code through its
  grammar, the HTTP codes through the closed set, the package count and status, the aviso
  counts, the rung — ERROR for `leitura-falhou` / `escrita-falhou` / `sem-permissao`); and ONE
  line per answer of the label route (PR 15-d: `rota: 'etiqueta'`, `resultado` — the code,
  `impresso` or `falhou` —, the closed `motivo`, `acao`, the ids, `bytesZip`, `bytesZpl`, the
  rejection code through its grammar, the HTTP codes through the closed set; the switch's refusal
  is the shared `chamada-bloqueada` line). Step 15's own
  lines never carry the label's pre-signed URL, the Restricted Data Token, a label byte, a
  zip entry name, a tracking, package or slot id, Amazon's text or the caller's uid. Its SP-API CALL lines
  (`evento: 'chamada'`) are the ordinary ones: by step 2b's design their excerpt KEEPS
  Amazon-made package, slot and tracking ids, and denies the URL and the token.
- ⚠️ A SECOND declared departure from the one-logger rule, beside the `int_frete` core's (see
  "int_frete binding"): the shared collection handles' SOFT read (`parseRead`, `packages/data`)
  writes `[data] schema mismatch on <path>` plus the Zod issue list (codes, paths, messages) to
  stderr when a stored document fails its schema — outside `LOGGER_STDOUT_AMAZON` and outside
  `estrutura.test.ts`'s reach. The order import meets it on the shared cliente resolver's
  candidate reads (`findOrCreateCliente`: `clientes/<id>`, a legacy cliente), as well as on the
  reads this app already had (`lerContaAmazon`'s `integracao/<id>`, `escreverAviso`'s
  `avisos/<key>`). Its own pedido, pagamento, link and freight reads are RAW (no handle parse).
  Routing the soft read through an injectable logger is a shared-core change for every channel.

## Fixtures and captures (step 2b)

- **Agents never open a raw capture** (no `cat`, editor or file-reading tool): owner captures
  live outside every checkout and are read only by the sanitizer
  (`pnpm --filter @delfrance/amazon-app sanitizar --entrada <abs> [--dry-run]`); an agent
  reads its output and the fixtures. Capture protocol: `scripts/README.md`.
- Fixtures (`lib/amazon/fixtures/__wire__/`) come ONLY from the sanitizer, never by hand: the
  `fixture` profile of `core/redacao.ts` (the one redactor — never a second one), the keyed id
  faker (`sanitizacao/falsificacao.ts`, fakes are fixpoints) and both layers of
  `fixtures/piiScan.ts`. Any finding refuses the whole run. A label zip/ZPL/PDF is refused by
  its first bytes and never opened. New model examples: `amazon-doc.mjs exemplo` /
  `notif-exemplo` into a folder outside the checkout, then the sanitizer.
- Run `sanitizar --entrada <abs> --verificar <files>…` over every changed doc, fixture and the
  PR body draft before every push that touches docs or fixtures (public repo).
- The sanitizer's closure (`sanitizacao/`, `fixtures/`, `scripts/sanitizar.ts`) stays inside
  zod, `@delfrance/core/{wire,documents}` and `node:{fs,path,url,crypto}`; `estrutura.test.ts`
  pins it. `MINIMO_DE_FIXTURES` in `wireCorpus.test.ts` equals the committed count.

## Environment

Read by this backend: `AMAZON_LWA_CLIENT_ID`, `AMAZON_APPLICATION_ID`,
`AMAZON_OAUTH_REDIRECT_URI`, `WEB_APP_URL`, `ALLOWED_ADMIN_ORIGINS`,
`AMAZON_CHAMADAS`, `FIREBASE_PROJECT_ID` / `FIREBASE_DATABASE_ID` (optional), and
the Secret Manager pair `AMAZON_LWA_CLIENT_SECRET` / `AMAZON_OAUTH_STATE_SECRET`.
`AMAZON_LWA_SEGREDO_EXPIRA_EM` is read only by the expiry sweep, which runs in the
functions codebase (`sweepAmazonExpirations`). The receiver (step 3) adds the Secret Manager pair
`AMAZON_RELAY_SECRET` / `AMAZON_RELAY_PREVIOUS_SECRET` (the second only during a
rotation; each 32–512 visible ASCII, else 503) and, in `lib/firebase/filaLeitura.ts`,
`AMAZON_TASKS_REGION` (falls back to `FUNCTIONS_REGION`, no default, else 503; trimmed
by `requireRegion`) and `AMAZON_TASKS_DISABLED` (exactly `1`). Both also serve the Easy Ship
scheduling queue `processAmazonEasyShipSchedule` (step 15) from the functions root
`src/agendadorAgendamento.ts` — where the valve stops its two entries and the task's own
re-enqueues with NO sweep behind them (one WARNING each; the order's next label print, through the
label route, schedules instead) — and the NF-e queue
`processAmazonNfeUpload` (step 14) from the functions root `src/agendadorNfe.ts`; there
`AMAZON_TASKS_DISABLED=1` STOPS every NF-e upload with NO sweep behind it — the trigger, and a
task whose next chain step the valve refuses (before its own submit), raise the aviso
`tarefas-desligadas` on the pedido, and that aviso list is the re-drive worklist: each pedido
goes back through `POST /api/marketplace/amazon/enviar-nfe` with `{ pedidoId }` once the valve
is open — `pedidoId` is the aviso row's `entidade` (the pedido document id, the one in the
pedido page's URL), never its `params.pedido` (the Amazon order number); ONCE per pedido, see
the re-drive bullet under "NF-e upload (step 14)". In App Hosting the same variable makes that
route answer 503 `AMAZON_TAREFAS_DESLIGADAS` (and writes no aviso: it closes only that
backend's producers, never the NF-e trigger or the task's re-enqueues), and the same region
serves its enqueue. The label route (step 15, PR 15-d) enqueues nothing, so it reads neither of
those two; it reads the LWA pair through the context and the scheduling valve pair below. Every other
read above is blank-guarded (blank = unset) and never trimmed; the valves and lists below are NOT
(only unset and `''` are empty). `apphosting.yaml` lists them as COMMENT rows only —
no `env:` block.

### Write valves and canary lists (step 2b, `core/valvulas.ts`)

- Eight names, all BLANK in the root `.env.example` and COMMENT rows in `apphosting.yaml`
  (never an `env:` row: a baked `off` could override a console flip):
  `AMAZON_MODO_{ESTOQUE,PRECO,NFE,AGENDAMENTO}` and `AMAZON_CANARIO_{ESTOQUE,PRECO,NFE,AGENDAMENTO}`.
  The functions codebase's `DEPLOY.md` declares the same eight, commented out.
- A valve is `off | dry-run | on`: only the exact `on` writes, only the exact `dry-run` diffs,
  anything else is off (nothing trimmed or folded; an unrecognised value logs a WARNING). A
  write also needs `AMAZON_CHAMADAS=on`.
- A canary list: unset or empty (`''`) = NO target; exactly `*` = every valid target, the
  only widening; otherwise `,`-joined `<contaId>:<sku>` (stock, price) or `<contaId>:<orderId>`
  (NF-e, scheduling), split at the FIRST `:`, matched by exact `Set.has`. A malformed entry
  lists nothing and is logged by POSITION only (a WARNING): spaces alone are one malformed
  entry, and so is `<contaId>:*` — there is no per-conta wildcard. A SKU with a space, a comma
  or a non-ASCII letter, or exactly `*`, is valid but not listable: it is written only at `*`
  (`alvo-nao-listavel` otherwise).
- A batch of stock or price is a feed ONLY under `on` + exactly `*` (`decidirLote`); under a
  list it sends patches for the canary targets alone. Either way every MEMBER still goes
  through `decidirAlvo`, and only members deciding `on` are sent: under `*`, an
  `alvo-invalido` member is left out of the feed and dry-runs.
- Order inside a write flow: `lerValvula` FIRST (reads its two names once, a snapshot for the
  run), `registrarValvulaAmazon` second (`evento: 'valvula'`), then `decidirLote` per batch and
  `decidirAlvo` for every member. Step 14 is the FIRST caller (PR 14-c): the NF-e task
  `processAmazonNfeUpload` reads the NF-e pair on every dispatch, before any read, and runs a
  planned submit through the write engine (`core/escrita.ts`). A verification dispatch never
  consults the valve (it writes nothing to Amazon): a flip never ends a chain that submitted.
  The re-drive route (PR 14-d) never reads the pair either: it only enqueues, and the task
  decides on the functions surface's values at run time. Step 15 (PR 15-c) is the SECOND
  caller: the scheduling task `processAmazonEasyShipSchedule` reads the scheduling pair FIRST
  on every dispatch (before any Firestore read: `off` reads nothing at all) and decides its
  target `<contaId>:<orderId>` from the payload alone; its two entries never read the pair. The
  label route (PR 15-d) is the THIRD caller, and the first flow of THIS backend to read a pair: it
  reads the scheduling pair once per print, after the read switch and before any Firestore read,
  and takes its target from the stored pedido. The label fetch IS the bulk, so `off`, `dry-run` and
  `on` outside the canary never print: where a bulk would be needed they answer 503
  `AMAZON_ETIQUETA_DESLIGADA`.
- W8 (the window, never before it), per flow: `dry-run` → a canary list → `on` → `*`, set ALIKE
  on both surfaces. Check the run-start line, then the dry-run diffs, then clean read-backs. For
  the scheduling pair a mismatch schedules without printable labels, or prints without the
  automatic schedule.

## Rule 7, per write

| Write | Tier | Mechanism |
| --- | --- | --- |
| OAuth state `put` | 0 | full overwrite of `oauthState/current`; a newer attempt supersedes |
| OAuth state redeem | seam | the shared store's own atomic redeem, already inventoried in `packages/data` |
| `selling_partner_id` on the conta | 1 | `update(…, { lastUpdateTime })`, ≤ 3 re-decides (`conflito`); never `merge`/`set` |
| Consent credential | 0 | full `set`; a concurrent park/refresh is defused by identity (ref, `acessoRef`) |
| Access-token persist | 0 | field `update` of exactly `{access_token, expirationDate, acessoRef}` |
| Park | 1 | `update({reconexaoPendente}, { lastUpdateTime })`, ≤ 3 re-decides |
| Avisos | seam | `escreverAviso` / `resolverAviso`; the reconexão row always clocked (µs) |
| Receiver, happy path | — | no write (the enqueue is the whole effect) |
| Receiver failure persist | 0 | the shared core's `create` on the deterministic `push:<NotificationId>`; ALREADY_EXISTS = already durable |
| Poll failure persist (step 4) | 0 | the same core `create` on `poll:<conta>:<orderId>:<µs>`; ALREADY_EXISTS = already durable |
| Poll refusal record (step 4) | 1 | `create`, or `update(…, { lastUpdateTime })` never while a lease is held; never the cursor or the lease |
| Poll lease (step 4) | 1 | `create`, or once EXPIRED `update(…, { lastUpdateTime })`; that update also anchors a cursorless doc (W7) |
| Poll final write (step 4) | 1 | `update(…, { lastUpdateTime: <lease writeTime> })`; on 9/5 re-read ONCE and RE-DERIVE (max cursor, merged `vistos`, our `pendente` only if `===` on its two scalars; no fold) |
| Conta cache | — | per-instance invalidate after the callback, by the intake task before a poll's `vendedor-mudou` drop (then a reload), and by the poll before each conta's run; others bounded by TTL + `isFresh` |
| `int_frete/amz-<id>` create (step 20) | 0 (inside the core's class-A reconcile) | `tx.create` at `amz-<id>`. On a miss, the lookup `tx.get`s that id inside the transaction, so a concurrent first reconcile conflicts (ABORTED, retried by the SDK) and re-derives `inalterado`. A stray ALREADY_EXISTS is NOT retried by the SDK: the trigger then rides the Eventarc retry (`retry: true`), and `--apply` stops and is simply re-run (idempotent) |
| `int_frete` mirror patch and deactivate (step 20) | A (the core's) | the shared core's ONE reconcile transaction (inventoried in `packages/data`): every input from its own `tx.get`s, no event clock, never a delete; this app adds no site |
| Pedido create / update (step 5, PR 5-d) | 2 (via 1) | ONE `WriteBatch` (`pedidos/escritaPedido.ts`), decided from one `getAll` of the pedido AND its pagamento: `create`, or `update(…, { lastUpdateTime })` on that pedido snapshot; the watermark (`lastMarketplaceUpdate`, µs) compared on it, a strictly older one dropped on a pedido this importer wrote, the accepted value written by the winner; a lost precondition (9/5/6) writes nothing and re-derives from a fresh read, ≤ 3 attempts, then `AmazonPedidoEmConflitoError` (retry). When the pedido's own patch is empty but a pagamento write rides the batch, the pedido's precondition rides a CARRIER (its stored `lastMarketplaceUpdate`, re-written as read). The commit's clock (the per-pedido aviso clock) is the LATEST `writeTime` of the results: the server answers a content-identical carrier with the document's PREVIOUS update time |
| Pagamento create / update (step 6, PR 6) | 2 (via 1) | in the SAME batch (`pedidos/escritaPagamento.ts`, decided by the pure `pedidos/pagamentoAmazon.ts` from the same snapshot): `create` at the pedido's digest, or `update(…, { lastUpdateTime })` on its own snapshot; the status paired with the pedido estado (`aprovado` ⇔ `pago`, `estornado` ⇔ `estornadoIntegralmente`) and decided TOGETHER with it (`pago` is never written beside a pagamento that stays `estornado`), an operator's status never walked, `estornado` → `aprovado` only on a strictly newer order clock. Whenever the batch writes the pedido and the pagamento EXISTS, the pagamento is proven current too: its own update, or a content-identical CARRIER (one stored field re-written as read, `status_pagamento` first) — every pedido decision reads the pagamento (the CANCELLED predicate, the ladder, `Z`, row 10). ⚠️ Residue: an ABSENT pagamento cannot be guarded without a write, so one created between the read and the commit is not seen by that attempt (the next import re-derives from it) |
| `freteInicial` estado, the `pacotes[]` diary, `codRastreio` (step 7, PR 7) | rides the batch | re-derived per attempt inside the SAME batch as the pedido (`frete/estadoFreteAmazon.ts`'s forward-only verdict, the package fold computed BEFORE the CANCELLED decision); applied on an EQUAL order clock so a package-only change survives a clock that did not move; a live rung after a failure or a terminal only on a STRICTLY newer clock, and NEVER from an estado where the goods are out to one where they are in (any clock; a stored goods-out diary row keeps its `estado` too, and the CANCELLED predicate reads those rows). EXCEPT status-only evidence (PR 5-f: a row whose token is unknown, read through its closed `packageStatus.status`): it lives in the row's verbatim wire fields, which any later-applied read rewrites, an equal-clock stale re-derive included, so a goods-in reading of the same package erases it (the second residual in `frete/estadoFreteAmazon.ts`, pinned in `pedidos/pedidoMapeamento.test.ts`); an empty diff writes nothing; never on a block whose `externalOptionIntegracao` is not `amz` |
| First-seen CANCELLED skip (a no-write decision, step 5) | bounded wait | no precondition guards a write that is not made: while the cancellation is younger than 15 min the import throws the retryable `AmazonCancelamentoRecenteError` (every retry re-fetches and re-reads), so no importer holding an older read can still create a reserving pedido afterwards. A first-seen order with any other reversal signal (plan §3 decision 44) waits out the same window for the same reason, then is skipped as `reversao-nao-importada`; one reversed long ago (the cutover look-back) is past the window and skipped at once |
| Cliente (step 5) | shared | `findOrCreateCliente` — its own transaction in `packages/data`, already inventoried; only the ref rides the batch, fill-once on each attempt's snapshot, and only when the pedido's stored freight endereço (if any) is that cliente's |
| Endereço (step 5) | 0 | `ensureEndereco`: `create` at the legacy sha1 id under the cliente the pedido will carry, ALREADY_EXISTS swallowed; the ref filled only when it pairs with that attempt's cliente |
| Pedido incidentes (step 5) | 0 | `create` at a deterministic id (`amz-prod-<orderItemId>`, `amz-cliente-sem-identidade`, `amz-<code>`), only ALREADY_EXISTS swallowed; after the commit, from the winning attempt |
| Order-import avisos (step 5) | seam, tier 2 on the Firestore timeline | `escreverAviso` / `resolverAviso` (both drop an EQUAL clock), after the commit and never on `obsoleto`: per-pedido rows clocked by the batch's commit `writeTime` (`importado`) or the winning snapshot's `readTime` (`sem-mudanca`), per-conta rows by the uncached conta read's `readTime`; one `getAll` over the keys first, and a resolve only on a row that EXISTS |
| Link docs, `int_frete`, conta (step 5) | — | read only |
| NF-e trigger, happy path (step 14) | 0 | no document; the ONE enqueue is NAMED after `event.id` (`ALREADY_EXISTS` = already durable) |
| NF-e task, happy path (step 14) | — | no write (a submit, a `processando`, an `aceita` with no stored stamp); the chain enqueues UNNAMED |
| Freight `error` stamp / its clear (step 14) | 1 | `nfe/carimboFreteNfe.ts`: a FRESH raw read, the pure decision, `update({ freteInicial: { ...stored, estado }, ultimaModificacao: max(stored µs, now) }, { lastUpdateTime })` — the nested order clock CARRIED, never `lastMarketplaceUpdate`; 9/5 ⇒ re-read and re-decide, ≤ 3, then `AmazonNfeCarimboEmConflitoError`. The clear only from `error`, applied directly (never through the freight verdict). Between the task's own writes: the queue's concurrency 1 |
| `nfeUploadRejeitado` raise / resolve (step 14) | seam, tier 2 on the Firestore timeline | `escreverAviso` / `resolverAviso`: the task's rows clocked by its P3 pedido `readTime`, the trigger's by T2's; the task's resolve READS first and writes nothing when there is no row; the importer's transition resolve ALWAYS seeds (a resolved tombstone drops a later stale raise) |
| `amazonPedidoPrecisaAtencao` `aceitar-cancelamento` from the NF-e task (step 14) | seam, tier 2 | the existing per-pedido key, clocked by the task's P3 `readTime`; the live read is floored by the stored watermark |
| Incidente `amz-nfe-pedido-cancelado` (step 14) | 0 | `create` at the deterministic id, only ALREADY_EXISTS swallowed (the task and the importer's cancel transition) |
| NF-e re-drive route (step 14, PR 14-d) | — | no write: ONE UNNAMED enqueue is the whole effect. A double re-drive is two tasks, and the status-first read does NOT dedupe them inside Amazon's read-after-write lag (≈ 3 min): the second most likely submits again (step-14 plan §5 risk 2, accepted) — hence the operator rule, one re-drive per pedido, then wait |
| Scheduling entries E1 / E2 (step 15, PR 15-c) | 0 | NAMED per OBSERVATION, never per pedido: E1 after the NF-e dispatch's own task id, E2 after `(pedidoId, the import read's watermarkUs)`; `task-already-exists` = that observation is already durable (one INFO line). A new observation always lands, whatever an earlier task for the order concluded (a name is refused for ≈ 1 h after its task RAN) |
| Scheduling `espera` / `pausa` re-enqueue (step 15) | — | UNNAMED (a tombstone would refuse the next rung), at most one per dispatch, nothing after it; a transient throws for the queue's retry before the last attempt, the last attempt and the deterministic classes end the chain with ONE WARNING |
| Easy Ship bulk (step 15) | provider-idempotent for a SEQUENTIAL resubmit | status-first in the task: the live `getOrder` reads the order already scheduled and sends nothing; `ScheduledPackageAlreadyExists` reads as scheduled; concurrency 1 serialises the automatic schedules; a retry waits the queue's ≥ 60-s backoff and re-reads first. The label route (PR 15-d) sends the bulk for every print, because that call IS the label fetch, at most once per request (a second time only through the engine's forced-refresh-once rule, after a 401/403 Amazon did not process), and its 503 asks for a wait of about a minute, never an immediate retry: a cut bulk may still be running at Amazon. Two concurrent FIRST-time calls (a print racing the task, two prints, a re-click over a cut bulk) are undocumented and unguarded in code (step-15 plan §2.1) |
| `amazonPedidoPrecisaAtencao` `dimensoes-ausentes` / `agendamento-recusado` (step 15) | seam, tier 2 on the Firestore timeline | raised ONLY by the scheduling task, resolved by it on a schedule (only rows that exist), both clocked by its pedido read's `readTime`; the importer resolves them once scheduling has ENDED (its batch `writeTime`, else its snapshot's `readTime`); between the task's own writes: concurrency 1 |
| The importer's cancel SEED of both scheduling motivos (step 15) | seam, tier 2 | the import that moves a pedido into a cancelled sale (or meets that condition on a redelivery) resolves BOTH with a SEEDING clocked resolve (`semearResolucaoDoPedidoAmazon`): an absent row becomes a resolved tombstone, so a task raise racing the cancellation — clocked by its OLDER pedido read — is dropped |
| `amazonPedidoPrecisaAtencao` `aceitar-cancelamento` from the scheduling task (step 15) | seam, tier 2 | the existing per-pedido key, clocked by the task's pedido `readTime`; the live read is floored by the stored watermark |
| Scheduling task, pedido / freight | — | NO write: the schedule's mirror is the order import's (`estrutura.test.ts`: no Firestore write call under `agendamento/`) |
| Label route (step 15, PR 15-d) | — | NO pedido, freight, scheduling or aviso write and no enqueue: the operator reads the reason in the answer, the task raises the avisos, the order import mirrors the schedule. A print that schedules therefore leaves a task-raised row open until the next import shows the schedule. The ONE write it can cause is the context's, on a stale LWA token or the forced refresh after a 401/403: the access-token persist above and, best effort, the `amazonSegredoLwaRecusado` resolve, both unchanged; it is the first App Hosting surface to come through the context, and so the first to run the access-token persist (the OAuth callback already resolves that aviso after its own exchange) |

This app adds **ONE** multi-document atomic-write site: the order import's batch
(`pedidos/escritaPedido.ts`), each write under its own precondition. It opens **no** transaction
(`estrutura.test.ts` pins both: one `.batch(` module, and the transaction call named nowhere).

## Departures from the step-2 plan (PR b)

- The start flow builds the consent URL BEFORE persisting the attempt (plan
  order: persist, then build), so a value the package refuses
  (`AMAZON_APPLICATION_ID`, `AMAZON_OAUTH_REDIRECT_URI`) answers 500 having
  written nothing. The attempt is still persisted before the answer.
- No `corpoMalformado()` in `respond.ts`: no step-2 route reads a body, and a
  fixed 400 would need a code outside PR a's closed `CODIGO_ERRO_AMAZON`.
- `prazos.test.ts` counts the code exchange in `lib/amazon/conta/conectar.ts`
  (1) and in the five route files (0 each; the label route's body reaches Amazon
  only through the context, whose refresh is not an exchange): the callback route
  is thin and its body lives in `conectar.ts`.
- The context loader checks only the LWA pair (`lerAplicacaoLwaAmazon`), not the
  six connect-flow keys: a flow never builds a consent URL.
- An accepted refresh also resolves `amazonSegredoLwaRecusado` (the aviso table's
  "any successful LWA exchange"), best effort.
- "Present" is checked with the package's own `credencialLwaValida`, not just
  blank-guarded: the start refuses an LWA pair the exchange would refuse (500
  naming the key, nothing written), the callback's step 1 does too (LIST
  `config`, nothing consumed), and its step 5 treats a code outside visible ASCII
  as absent (`missing_params`, nothing consumed) — so no value refusable before
  `consume` can burn the attempt.
- `tratarCallbackAmazon` returns `RetornoCallback` =
  `{ tipo: 'sem-web' } | { tipo: 'redirecionar', webBase, caminho, retorno }`
  (`caminho` is the list or the conta route from `ROTAS_AVISO`), not the plan's
  `{ destino: 'lista' } | { destino: 'conta', id }`: the route then needs no
  routing of its own.
- The switch's log classification counts only unset and the empty string as
  `ausente` (INFO); a whitespace-only value is `outro` and logs at WARNING — LI
  parity (`ehAusenteOuOff`), where the plan said "INFO when unset/blank/off". A
  stray space in the variable is a misconfiguration worth a warning.

See `.master_plans/amazon/amazon-marketplace-integration.md` (master plan, tracker #1923).
