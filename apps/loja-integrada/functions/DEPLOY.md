# Deploying the Loja Integrada Cloud Functions (codebase `loja-integrada`)

These functions are a **deploy-artifact sub-build** of `@delfrance/loja-integrada-app`
— not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. `firebase.loja-integrada.deploy.json` points `source` at the generated
`.deploy/loja-integrada-functions`. Mirrors `apps/mercado-pago/functions`, with
the deferred-lane sweep from `apps/shopee/functions`.

> Deploy is **manual and coordinated** — agents never run `firebase deploy` (root
> `CLAUDE.md`, Critical rules) — and never let a stray `firebase deploy` push
> rules. No config in this channel declares a `firestore`/`storage` block, so
> none of them can.

## ⚠️ Not deployed anywhere; it ships INERT

`firebase.loja-integrada.deploy.json` is a config file, and a config file
deploys nothing. Nobody has run this codebase against any project. The deploy
is a **migration-window** step (root `CLAUDE.md` rule 8, ADR 0013): the
production data has not moved, the legacy app is still the sole writer of the
real orders, and nothing here may read or write them first.

ONE switch keeps the order flow harmless even if it were deployed early, and it
stays exactly as it is until the window:

- **The read switch `LOJA_INTEGRADA_CHAMADAS` stays UNSET.** Only the exact `on`
  lets this code call Loja Integrada at all; the context loader refuses before
  any Firestore read and before it builds a client. There is no sandbox on the
  platform's side and the origin is fixed, so a call is always a live one (D17).

⚠️ **The importer seam is FILLED (master-plan step 5), so the switch is the only
gate left.** The reads queue's task and both sweeps run the order import, which
writes `pedidos`, their `pagamentos`, `clientes`, `enderecos`, incidentes,
avisos and the `int_frete` `mapa`; the order poller passes its importer gate.
With the switch unset every one of those runs stops at the context first: a
task DEFERS (`adiado/chamadas-desligadas`) before any Firestore read, and a
poller tick stops at the switch with zero reads. So nothing in this codebase
turns a notification into a `pedido` until the window sets the switch — and
once it does, the poller's next tick enqueues the changed orders into the
import, and any `deferred` row still within its 7 daily passes drains with
them. A `parked` row is terminal: no lane re-drives it. None should be an
`importador-ausente` park: that needed the switch on while the seam was empty,
the switch stays unset until the window, and the poller never enqueued with
the seam empty.

⚠️ **The conta trigger stands outside the switch.**
`onIntegracaoLojaIntegradaChanged` (master-plan step 20) makes no Loja Integrada
call, so the read switch does not gate it, and it is not a reads-queue run, so
the importer does not either. Deployed into a project, it writes that project's
`int_frete` on every Loja Integrada conta save that moves a mirrored field —
create, patch or deactivate. That is why this deploy waits for the window's
`int_frete` adoption pass (Prerequisites below).

⚠️ **The anchor trigger stands outside the switch too.**
`onProdutoLojaIntegradaLinkChanged` (master-plan step 9) makes no Loja Integrada
call either. Deployed into a project, it writes that project's
`produtos.integracoesComProduto` on every write of a Loja Integrada link doc
that moves membership — a counting link created or pulled back out of the
trash adds its conta, the loss of a produto's last counting link removes it.
It never fires for a link that arrives by IMPORT: a Firestore import fires no
trigger, so the migrated links reach the anchor only through the window's
anchor census, `migrate:li-integracoes-com-produto` (Prerequisites below).

⚠️ **The product import (master-plan step 9) stops at the same switch.** Its
job-creation trigger `onImportacaoLojaIntegradaCriada` makes no Loja Integrada
call: for a job document created `pendente` (only the import's start route
creates one, and that route is itself refused while the switch is unset) it
enqueues the job's first slice onto `filaLeituraLojaIntegrada`, and the slice
stops at the context's switch FIRST, ending the job `falhou/chamadas-desligadas`
with zero calls. A job document written by hand `pendente` would take that path
too; nothing else creates one.

⚠️ **The stock trigger (master-plan step 12) stops at the stock valve.**
`onEstoqueLojaIntegrada` makes no Loja Integrada call and writes nothing. With
`LOJA_INTEGRADA_MODO_ESTOQUE` unset it returns before any read; at `dry-run` or
`on` it enqueues send tasks (and kit fan-outs) onto `filaEstoqueLojaIntegrada`,
and each send run then stops at its write context while the read switch is
unset. A Firestore import fires no trigger either: the migrated stock reaches the
store only through the daily stock reconcile's first run with the read switch
on (PR 12-g), and the trigger covers the movements after the switch-over.

⚠️ **The status write-back (master-plan step 7) has a valve of its own, and it
stays UNSET too.** `LOJA_INTEGRADA_MODO_RASTREIO` unset (or blank, or `off`)
means the freight-history trigger returns before any read and enqueues nothing,
a write task already queued defers before any read, and the varredura touches
neither lane. At `dry-run` or `on` every write run still stops at its write
context while the read switch is unset — before any Loja Integrada client
exists — so nothing is ever written to Loja Integrada before the window.

⚠️ **The price queue (master-plan step 13) stops at the price valve.**
`filaPrecoLojaIntegrada` has no producer yet but its own `deriva` follow-up, so
nothing enqueues onto it. With `LOJA_INTEGRADA_MODO_PRECO` unset every task
returns `desligado` before any read; at `dry-run` or `on` each send run stops at
its write context while the read switch is unset, before any Loja Integrada
client exists.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/loja-integrada/node_modules`).
- The App Hosting backend for `apps/loja-integrada` created in the Firebase console.
- Env on the deployed functions: `FIREBASE_PROJECT_ID` + admin creds. **No secrets:**
  the Loja Integrada token lives per conta in Firestore
  (`integracao/{id}/credenciaisLojaIntegrada/current`), so no function declares a
  `secrets:` binding and there is nothing to create in Secret Manager. A
  `secrets:` entry whose secret does not exist fails the whole deploy, which is
  the reason none is declared. The conta trigger binds none either: it never
  calls Loja Integrada.
- **The triggers' database.** `onIntegracaoLojaIntegradaChanged` listens on
  `integracao/{integracaoId}`, `onHistoricoFreteLojaIntegrada` (master-plan
  step 7) on `pedidos/{pedidoId}/historicoFtIni/{historicoId}` and
  `onProdutoLojaIntegradaLinkChanged` (master-plan step 9) on
  `produtos/{produtoId}/produtolojaintegrada/{linkId}`,
  `onImportacaoLojaIntegradaCriada` (master-plan step 9) on
  `importacoesLojaIntegrada/{jobId}` and `onEstoqueLojaIntegrada` (master-plan
  step 12) on `produtos/{produtoId}/estoques/{estoqueId}`, all five in the
  NAMED `default` database — never the `(default)` sentinel, which deploys fine
  and never fires. `build.mjs` inlines
  `FIREBASE_DATABASE_ID` (unset or blank → `default`) and the preflight prints
  the value it baked; leave it unset in the BUILD environment (the deploy shell
  and the repo-root `.env.functions`), or set it to exactly `default`. The
  define replaces every read of the variable in the bundle, `getDb()`'s
  included, so the triggers and every other function use that build-time value
  and a runtime override reaches none. `src/index.test.ts` pins the analysed
  bindings.
- **The `int_frete` index READY, and the adoption pass run, before this
  deploy.** The trigger's lookup rides
  `int_frete (tipo, contaLojaIntegradaEnviosOuterRef, ativo, dataCadastro DESC)`,
  and so does the order import's freight read (its equality prefix, active docs
  only); on Enterprise a missing index does not fail, it full-scans and bills the
  scan.
  And an import fires no trigger, so the window's adoption pass
  (`tools/migrations/li-int-frete.README.md`, master plan §5 item 11) must have
  run and its dry run report zero `duplicados`, `nao-canonico` and
  `compartilhado` rows first: the trigger has no tolerant scan, so a conta's
  first save would otherwise create `lojaIntegrada-<integracaoId>` beside a
  migrated doc whose back-ref is not canonical. The order import reads the same
  doc to route freight, so before that pass an imported order finds none and is
  left unrouted (#1960 tracks the pass).
- **The order import's link index READY before this deploy.** Resolving an
  order line to its ERP produto queries the collection group
  `produtolojaintegrada (contaLojaIntegrada ASC, id ASC)` with every stored form
  of the conta reference; without it Enterprise full-scans every produto's link
  docs on each line, and bills the scan.
- **The migrated links' anchor census run before the stock and price valves
  reach `on`**: `migrate:li-integracoes-com-produto`, runbook
  `tools/migrations/li-integracoes-com-produto.README.md` ("Verifying a first
  deploy", item 7). The anchor trigger derives `integracoesComProduto` from
  link WRITES, and the data import writes none it sees, so a migrated link
  whose produto's array lacks the conta is invisible to every flow that
  pre-filters on that array — this app's manual stock push skips it silently,
  never with an error: a selected produto answers `sem-vinculo` when another
  selected produto names the conta and gets no Loja Integrada row when none
  does (the web picks the contas to call from the selection's arrays), and a
  child of a selected root is never found by the root's expansion, which
  filters on the array too (it is left out, or, when no child of that root
  names the conta, the root itself becomes the target and is usually answered
  `pai`). The stock trigger and the nightly stock reconcile read the links
  themselves and still send it. The trigger needs
  no index of its own: its survivor read takes the produto's whole
  `produtolojaintegrada` subcollection, a handful of documents, and filters in
  code.
- **`apps/web` deployed before the read switch is set** (master plan §5 item 1;
  §5 item 5 rolls it out after this codebase). The order import owns six aviso
  tipos (`lojaIntegradaSituacaoDesconhecida`, `lojaIntegradaPedidoContestado`,
  `lojaIntegradaPedidoHub`, `lojaIntegradaFreteNaoSuportado`,
  `lojaIntegradaReversaoComEtiqueta`, and the `critico`
  `lojaIntegradaPedidoPagoSemEndereco`, which the reprocess sweep raises when
  it parks — see "A parked notification logs ERROR" below), and only a run past
  the switch imports; a web build older than them has no wording for those
  rows. The status write-back adds a seventh, `lojaIntegradaRastreioDivergente`
  (`atencao`; `critico` for a situação overwritten over a codigo the write-back
  never writes onto — a dispute, a cancellation request, a cancellation, a
  refund, a chargeback — and for a write blocked at 1019,
  `cancelamento_solicitado`, where the buyer asked to cancel), raised by the
  writes queue only under
  `LOJA_INTEGRADA_MODO_RASTREIO=on`: **the web build carrying its copy must be
  live before that valve is set to `on`**, or the avisos panel cannot render it.
- **The product import's job and report indexes READY before this deploy**
  (master-plan step 9). The import's start guard (App Hosting) and the web's
  list read `importacoesLojaIntegrada (integracaoId ASC, iniciadoEmMs DESC)`; a
  dispatch reads its job by id. The report's pages — the items route's, and the
  job's own actionable count at its end — are expected to range-seek on
  `itens (__name__ ASC)`: Enterprise keeps no implicit key index, so without it
  every page is expected to walk the job's whole report (#1874 measured both
  plans on a root collection; a per-parent subcollection's plan is not measured
  yet). On Enterprise a missing index does not fail, it full-scans and bills the
  scan.
- **The default bucket's object grant, before the first "complete" import
  with photos** (master-plan step 9). The import's photos are this codebase's
  FIRST Storage write: the functions runtime SA uploads each picture to the
  project's default bucket (see "Photos: the runtime SA writes the default
  bucket" under the IAM section). The bucket NAME is read from the runtime's own
  `FIREBASE_CONFIG.storageBucket` (no env var to set); when nothing names one,
  a run skips its photos and its card shows "fotos indisponíveis" instead of
  failing. The `storage` functions codebase (`apps/functions`, its
  `resizeProductImage` trigger) makes the 200/400/jpeg derivatives of every
  picture uploaded `resizeState: 'pending'`, so it is deployed first, as it is
  for every other product photo.
- **`apps/web` carrying the import's three aviso tipos before the read switch is
  set** (master-plan step 9): `lojaIntegradaImportacaoComPendencias` (raised at
  an `aplicar` import's end), `lojaIntegradaCategoriaSemVinculo` and
  `lojaIntegradaRevisaoFiscal`. Only a slice past the switch raises one, and a
  web build older than them has no wording for those rows. Deploy
  `apps/loja-integrada` (the import routes) no later than `apps/web` (its import
  screen probes the routes).
- **The writes store's index READY before this deploy.**
  `notificacoesEscritaLojaIntegrada (status ASC, processedAt ASC)` serves both
  lanes of the varredura; on Enterprise a missing index does not fail, it
  full-scans and bills the scan. Every other read of the write-back is by id.
- **Region match.** The functions enqueue onto the queue in their own region. The
  enqueuer resolves it from `LOJA_INTEGRADA_TASKS_REGION ?? FUNCTIONS_REGION`,
  and there is **no default** — an unset value THROWS on the first enqueue rather
  than producing a well-formed path to a queue that does not exist. `options.ts`
  defaults `LOJA_INTEGRADA_TASKS_REGION` to the `FUNCTIONS_REGION` inlined into
  the bundle, and a blank value counts as unset. A mismatch is the #1108 failure:
  the Admin SDK targets `us-central1`, the task is **silently dropped**, and the
  caller still sees success.
- **One-time IAM** (see below) — required before the first enqueue, i.e. the
  poller's first tick. The queue-level grants can only be made once the deploy
  has created the queue, and with `TASKS_INVOKER_SA` set the deploy makes two of
  them itself; the act-as grant is always manual.

## Deploy

> ⚠️ **A human runs this, in a coordinated window** — never an agent, never
> unannounced (root `CLAUDE.md` rule 8). Export `TASKS_INVOKER_SA` and
> `FUNCTIONS_REGION` first (both below); the preflight refuses the deploy
> without them.
>
> ⚠️ **Into a project that does not hold these queues yet** — which is every
> project until the window, and a project that already holds the reads queue
> still lacks the writes queue (master-plan step 7), the stock queue
> (master-plan step 12) and the price queue (master-plan step 13) — read **the
> first deploy of a NEW queue crashes on the
> enqueuer binding** under the IAM section below FIRST. On firebase-tools
> 15.28.2 that deploy reports an error for each new queue's function, with a
> misleading organization-policy message, and the fix is one `gcloud` grant per
> identity FOR EACH NEW QUEUE (`filaLeituraLojaIntegrada`,
> `filaEscritaLojaIntegrada`, `filaEstoqueLojaIntegrada` and
> `filaPrecoLojaIntegrada`; the workaround block lists all four) plus a re-run.

```bash
# from the repo root
firebase deploy --only functions:loja-integrada \
  --config firebase.loja-integrada.deploy.json \
  --project <project-id>
```

⚠️ **Read the whole filename.** `firebase.loja-integrada.deploy.json` is the only
config that deploys. `firebase.loja-integrada.tasks.json` (added with the CI
lane) is the emulator config, and it declares no rules or indexes path on
purpose, so a stray deploy against it can push nothing.

The `predeploy` hook runs `node tools/deploy-env/preflight.mjs loja-integrada` and
then `node apps/loja-integrada/functions/scripts/prepare-deploy.mjs`. To inspect
the bundle locally without deploying: `node apps/loja-integrada/functions/build.mjs`
(writes `dist/index.js`), or
`FUNCTIONS_REGION=<region> node apps/loja-integrada/functions/scripts/prepare-deploy.mjs`
for the full servable folder at `.deploy/loja-integrada-functions`. Both need
`FUNCTIONS_REGION` set — `requireBuildRegion` throws without it, on purpose. Both
are local builds; neither deploys anything.

## Functions in this codebase

| Export                                | Trigger                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filaLeituraLojaIntegrada`            | `onTaskDispatched` (Cloud Tasks queue)          | The ONE reads queue of the channel (order intake, since master-plan step 9 the product import, and since step 12 (PR 12-g) the daily stock reconcile). The body dispatches on the task's `tipo`: `pedido` runs one notification through the pipeline; `importacao` runs ONE slice of a product import — at most 70 s of units plus a 30 s tail, every unit checkpointed on the job, then the next slice enqueued by name (`li-importacao-<jobId>-<seq>`, 2 s later; 60 s after a 429) — so an order waits at most one slice; `estoque-reconcile` runs ONE slice of the daily stock reconcile under the SAME 70 + 30 s budget — one chain for every conta, its run document `reconcileEstoqueLojaIntegrada/atual`, the next slice named `li-<execucaoId>-<seq>` (2 s later; 60 s after a 429) — so an order waits at most ONE reconcile slice whatever the number of contas; any other `tipo` is logged and dropped. `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`, `retryConfig` 3 attempts with 60 s → 300 s backoff and one doubling, `timeoutSeconds 300`. **No `secrets:`.** Persists to `notificacoesLojaIntegrada` only on retry-exhaustion, park or defer.                                                                                                                                                                                                                                                                                                                                                       |
| `reprocessLojaIntegradaNotifications` | `onSchedule('*/30 * * * *')`                    | The backstop, draining BOTH lanes on one tick (`limit 10` each): `failed` notifications older than the hot window, then the deferred lane (a parked conta, an inactive conta, a missing credential, the switch off). Logged separately — summing them would hide a growing deferred backlog inside a healthy `processed`. `America/Sao_Paulo`, `timeoutSeconds 540`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sweepLojaIntegradaTokenExpiry`       | `onSchedule('30 6 * * *')`                      | The DAILY token-expiry sweep: raises the expiry and reconnection avisos at the 30-day horizon, resolves them once a new date or credential lands, and closes the orphaned rows of contas that no longer exist. Reads only the stored credential — **no Loja Integrada call**, so the read switch does not gate it. `America/Sao_Paulo`, `timeoutSeconds 120`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pollLojaIntegradaPedidos`            | `onSchedule('*/5 * * * *')`                     | The 5-minute order poller, behind TWO gates that each stop a tick with zero reads: the importer seam (filled in master-plan step 5, so it passes) and the read switch. Per active conta, one after another, starting from a different conta each tick (220 s per tick, at most 100 s per conta): a single-flight lease and a durable cursor on `pollPedidosLojaIntegrada/{id}`, `GET /v1/pedido/search/` paced at the reads interval (at most 20 pages), one synthetic notification per changed order onto the reads queue (persisted `failed` instead in sweep-only mode). A refusal or a stuck window is counted on the same document and raises the `critico` aviso `lojaIntegradaImportacaoParada`. Reads `LOJA_INTEGRADA_POLL_LOOKBACK_H`. `America/Sao_Paulo`, `timeoutSeconds 300`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `filaEscritaLojaIntegrada`            | `onTaskDispatched` (Cloud Tasks queue)          | Master-plan step 7 — the writes queue of the channel: every write to Loja Integrada but stock and price (today the status write-back; later the catalogue writes) and its own sweep. The body dispatches on the task's `tipo`: `rastreio` runs one write event through the writes pipeline (a fresh pedido read, the deciding read of the order, at most one write, the read-back), `varredura` runs both lanes of `notificacoesEscritaLojaIntegrada` INSIDE the queue (one row at a time, a 140 s budget), any other `tipo` is logged and dropped. `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`, **`concurrency: 1` and `maxInstances: 1`** (one instance serving one request), `retryConfig` 3 attempts with a FLAT 300 s backoff (no doubling) — no write starts later than 260 s after a dispatch began, so a retry starts only after an abandoned attempt can no longer write — `timeoutSeconds 300`. **No `secrets:`.** Persists to `notificacoesEscritaLojaIntegrada` only on retry-exhaustion, a landed write whose effect is not confirmed, park or defer.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `onHistoricoFreteLojaIntegrada`       | `onDocumentCreated` (Firestore)                 | Master-plan step 7 — the status write-back's producer, on `pedidos/{pedidoId}/historicoFtIni/{historicoId}`. For a created freight history row whose estado is `postado`, `entregue` or `aguardandoRetirada`, with the write valve at `dry-run` or `on`, it reads the pedido ONCE and, for an imported Loja Integrada order, enqueues ONE task named `rastreio-<event digest>` onto `filaEscritaLojaIntegrada` (`task-already-exists` is success). A non-target estado or the valve `off` returns with ZERO reads and no line; an unrecognised valve value logs ONE WARNING. Tasks disabled or a transient Cloud Tasks failure ⇒ the event is persisted `failed` for the varredura. `database` **`default`**, `retry: true`, **no secrets**, no Loja Integrada call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `varrerEscritasLojaIntegrada`         | `onSchedule('15,45 * * * *')`                   | Master-plan step 7 — the writes queue's backstop timer. It only enqueues ONE `varredura` task per tick onto `filaEscritaLojaIntegrada`, named after the tick's schedule time; the sweep runs inside the queue, never here, so a retry can never race a fresh write. It does not read the write valve (the task does). Tasks disabled or a transient failure ⇒ one WARNING and the next tick tries again. `America/Sao_Paulo`, `timeoutSeconds 60`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `reconciliarEstoqueLojaIntegrada`     | `onSchedule('23 4 * * *')`, `America/Sao_Paulo` | Master-plan step 12 (PR 12-g) — the NIGHTLY start of the daily stock reconcile. It reads NO Firestore document and calls no Loja Integrada endpoint: with `LOJA_INTEGRADA_MODO_ESTOQUE` `off` (unset) it does nothing; otherwise — whatever the read switch says: the run's ERP side rebuilds the kits map, its store phase stops at the switch — it enqueues ONE named task, the run's first slice (`estoque-reconcile-<AAAAMMDD of the schedule time in São Paulo>`, seq 0), onto `filaLeituraLojaIntegrada`. `timeoutSeconds 60`, `retryCount 3` (a transient enqueue failure is rethrown; the retry carries the same schedule time, so the same name). The minute 23 is one no other schedule of this codebase fires at (`src/index.test.ts`). **No `secrets:`.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `filaEstoqueLojaIntegrada`            | `onTaskDispatched` (Cloud Tasks queue)          | Master-plan step 12 (PR 12-e) — the STOCK queue: one send run of one child produto of one conta per task (`lib/lojaIntegrada/estoque/processarEstoque.ts`), a queue of its own so the status write-back never waits behind a stock pass. The payload is ids only (parsed strict; the quantity is derived when the task runs). `estoque` runs one send run; `estoque-kits` (PR 12-f) runs one component's kit fan-out (`processarKitsEstoque.ts`): one send per kit it holds at 0, paced on the global slot `reconcileEstoqueLojaIntegrada/atual.proximoSlotMs`, its only write; any other `tipo` is dropped. Options IDENTICAL to `filaEscritaLojaIntegrada`'s (`src/index.test.ts` pins the equality): one dispatch at a time, **`concurrency: 1` and `maxInstances: 1`**, 3 attempts with a FLAT 300 s backoff, `timeoutSeconds 300` (the worst run is 68 s). **No `secrets:`.** No failure store and **no Firestore write on success**; the only aviso it raises is `lojaIntegradaEstoqueRecusado` (a write refused on the last attempt). Producers (functions runtime SA): the stock trigger, the fan-out, the `deriva` follow-up, and the daily reconcile's queue phase (PR 12-g); (App Hosting runtime SA) the manual push `POST …/enviar-estoque` (PR 12-h). The whole stock sync is `lib/lojaIntegrada/estoque/README.md`. No Loja Integrada call until the window: the stock valve is unset (zero reads), then the read switch.                                                                                                         |
| `filaPrecoLojaIntegrada`              | `onTaskDispatched` (Cloud Tasks queue)          | Master-plan step 13 (PR 13-d) — the PRICE queue: one send run of one linked produto of one conta per task (`lib/lojaIntegrada/preco/processarPreco.ts`), a queue of its own so a whole-catalogue reprice never holds the status write-back or a stock send behind it. The payload is ids only (parsed strict; the price is derived when the task runs, from the ERP and a fresh deciding read of the store). `preco` runs one send run — at most ONE `PUT /v1/produto_preco/{id}`, an event-origin one read back by its own GET (a drift ⇒ ONE `deriva` follow-up, generation 1, never another), a bulk-origin one with no read-back call; any other `tipo` is dropped. Options IDENTICAL to `filaEstoqueLojaIntegrada`'s (`src/index.test.ts` pins the equality): one dispatch at a time, **`concurrency: 1` and `maxInstances: 1`**, 3 attempts with a FLAT 300 s backoff, `timeoutSeconds 300` (the worst run is 68 s). **No `secrets:`.** No failure store and **no Firestore write on success**; the only aviso it raises is `lojaIntegradaPrecoRecusado` (a write refused on the last attempt, or a follow-up that still read a drift). Producers today (functions runtime SA): only the `deriva` follow-up; the price trigger, the nightly read and the operator's routes come in later PRs of step 13. The send run is `lib/lojaIntegrada/preco/README.md`. No Loja Integrada call until the window: the price valve is unset (zero reads), then the read switch.                                                                        |
| `onIntegracaoLojaIntegradaChanged`    | `onDocumentWritten` (Firestore)                 | Master-plan step 20 — the codebase's FIRST Firestore trigger, on `integracao/{integracaoId}`. Keeps each Loja Integrada conta's `int_frete` doc (tipo `lojaIntegrada`) in step with the conta through the shared core `@delfrance/data/admin/frete`: adopt the migrated doc by `contaLojaIntegradaEnviosOuterRef`, else create `lojaIntegrada-<integracaoId>`; patch only the mirrored fields that moved (`nome`, `ativo`, the filial, `dataCadastro`), never `mapa` or `horarioDeCorte`; deactivate, never delete, once the conta is gone or no longer Loja Integrada. State-driven: the core re-reads the conta itself, so a replayed or out-of-order delivery cannot roll anything back. EVERY channel's conta write reaches it, and it returns with ZERO reads unless the conta is, or was, Loja Integrada and the write moved a mirrored field (or the tipo, or created or deleted the conta). Logs the conta id and the action with field names, never a value. `database` **`default`**, `retry: true`, **no secrets**, no `invoker` (Eventarc invokes it), no Loja Integrada call. No per-function `region:`. Since master-plan step 12 (PR 12-g) a SECOND arm: a Loja Integrada conta re-pointed at ANOTHER depósito (an update; folded, so one depósito in its two spellings is no change; never on a create, never when the depósito is removed) enqueues ONE named first slice of a full stock reconcile on `filaLeituraLojaIntegrada` (`estoque-reconcile-deposito-<µs of the write>`), zero reads, with the stock valve not `off`. |
| `onProdutoLojaIntegradaLinkChanged`   | `onDocumentWritten` (Firestore)                 | Master-plan step 9 — the `integracoesComProduto` anchor, on `produtos/{produtoId}/produtolojaintegrada/{linkId}` (a parent's link under the ERP root and a child's under the ERP child alike). Keeps each produto's `integracoesComProduto` — the pre-filter the other channels' sweeps and this app's manual stock push open with (the stock trigger and the nightly stock reconcile read the links themselves) — in step with its Loja Integrada links, through the shared core `@delfrance/data/admin/produtos`: a link COUNTS when its `id` names a store product and it is not in the trash (hidden and blocked links count); a counting link created or pulled back out of the trash adds its conta (`arrayUnion`, tier 0), and a link that stops counting or is deleted makes the core re-read the produto's whole link subcollection inside its guarded write and remove the conta only when no counting link of it survives (tier 1). The decision is taken from the event payload before any read, so an edit that moves no membership (a name, the mirror fields, a publication code) costs ZERO reads. Logs the produto, the link doc and the conta ids with the write's outcome, never a value. `database` **`default`**, `retry: true`, **no secrets**, no `invoker` (Eventarc invokes it; it enqueues nothing), no index of its own, no Loja Integrada call. No per-function `region:`.                                                                                                                                           |
| `onEstoqueLojaIntegrada`              | `onDocumentWritten` (Firestore)                 | Master-plan step 12 (PR 12-f) — the stock TRIGGER, on `produtos/{produtoId}/estoques/{estoqueId}`: EVERY ERP stock write of every depósito and channel. Gates in order: the payload alone (no available quantity moved — a `localizacao` edit, a stamp-only update, the paid → shipped pair ⇒ ZERO reads, no line), the stock valve (`off` ⇒ zero reads), the cached map of the contas' depósitos (one `integracao` query per 15 min per instance), then the produto's own links and the kits header per concerned conta. It enqueues onto `filaEstoqueLojaIntegrada` one send per linked child, one per kit the eager filter flags (at most `LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX` kits per component), or ONE `estoque-kits` fan-out when a component with more kits can have sent one to 0; the clock read after every read, `task-already-exists` is success, a transient failure is rethrown, tasks disabled ⇒ one WARNING. It **writes nothing**. `database` **`default`**, `retry: true`, **no secrets**, no `invoker`, no Loja Integrada call. No per-function `region:`.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `onImportacaoLojaIntegradaCriada`     | `onDocumentCreated` (Firestore)                 | Master-plan step 9 — the product import's first producer, on `importacoesLojaIntegrada/{jobId}`. For a job document CREATED `pendente` (the import's start route creates it) it enqueues ONE task named `li-importacao-<jobId>-0` onto `filaLeituraLojaIntegrada` (`task-already-exists` is success); a document created in any other status returns with ZERO reads and no line. Tasks disabled ⇒ the job is stamped `falhou/tarefas-desligadas` (never left `pendente` with nothing queued); a transient Cloud Tasks failure is rethrown for the retry. `database` **`default`**, `retry: true`, **no secrets**, no Loja Integrada call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

⚠️ **The export name IS the queue name.** Firebase binds one function per queue
and names the queue after the function, so renaming `filaLeituraLojaIntegrada`,
`filaEscritaLojaIntegrada`, `filaEstoqueLojaIntegrada` or `filaPrecoLojaIntegrada`
creates a NEW queue and strands whatever the old one held. Each name is fixed at
its first deploy. `src/index.ts` carries a rename-safety assertion tying each
export key to the constant its enqueuer targets (`FILA_LEITURA_LI`,
`FILA_ESCRITA_LI`, `FILA_ESTOQUE_LI`, `FILA_PRECO_LI`).

⚠️ **The history trigger shares its path with nothing else.**
`onHistoricoFreteLojaIntegrada` is the only function in the project on
`pedidos/{pedidoId}/historicoFtIni/{historicoId}` — but that subcollection is
the freight audit trail `onPedidoChanged` (`apps/functions`) appends for EVERY
channel's pedidos, on every freight transition, so the trigger fires for all of
them. It returns with zero reads for an estado outside the three, and with one
pedido read for a pedido that is not an imported Loja Integrada order. It fires
on a row's CREATE only: a redelivery of the history trigger rewrites the same
document, which is not a create.

⚠️ **The writes queue is single-file by design.** One dispatch at a time, on one
instance serving one request, with no write starting later than 260 s after its
dispatch began and a 300 s retry backoff: that is what NARROWS two attempts of
the same order writing at once — it does not eliminate it. Two residuals remain:
an abandoned dispatch (a reset connection) whose handler is still running when
the next dispatch starts, and a rare duplicate delivery by Cloud Tasks. Both are
logged by the situação history check that follows a write, as a WARNING
`conferencia-historico` line with `resultado: escrita-duplicada`: an occasional
one is that documented residual, not a misconfiguration (a steady stream of them
is a reason to re-run item 6 of "Verifying a first deploy"). Never loosen any of
the settings (`src/index.test.ts` pins every one, and no emulator honours them),
and never run the write sweep anywhere but inside the queue —
`varrerEscritasLojaIntegrada` only enqueues it.

⚠️ **The stock queue is single-file too, with the same settings** (master-plan
step 12; `src/index.test.ts` pins them EQUAL to the writes queue's). One send run
at a time on one instance narrows two runs of the same produto overlapping; it
does not eliminate them. The same two residuals remain — an abandoned dispatch
still running when the next starts, and a rare duplicate delivery — and both are
bounded: every run writes an ABSOLUTE quantity decided by its own fresh read of
the store's row, never a delta, so whichever PUT lands LAST stands — which can
be the one built on the OLDER read (a PUT may be in flight for up to its 20 s
deadline while the other run reads and writes) — and the next event of the
produto or the daily reconcile re-covers it. With the writes and price queues
it makes at most three writes in flight per store, each paced by the engine
(`lib/lojaIntegrada/core/ritmo.ts`: the theoretical worst per store is 180
calls a minute against Loja Integrada's 100; a 429 throws and the retry
re-derives). The stock queue keeps NO failure store: a task whose every attempt
meets a 429 or a 5xx is dropped (the platform's error log is its only trace),
and the next event of the produto or the daily reconcile re-covers it.

**Undoing a stock send.** Every deciding read writes a `restauracao` line with
the store's whole stock row as it stood before the PUT. To undo one, re-send that
row's `quantidade` to the same product — through the same strict route, which
sends only a NON-NEGATIVE quantity under the four fixed leaves (managed, the two
fixed situações): a prior negative quantity, a prior unmanaged row or a prior
lead-time setting cannot be restored through it.

⚠️ **The price queue is single-file too, with the same settings** (master-plan
step 13; `src/index.test.ts` pins them EQUAL to the stock queue's). The same two
residuals remain — an abandoned dispatch still running when the next starts, and
a rare duplicate delivery — and both are bounded the same way: every run sends
an ABSOLUTE price, computed from the ERP and decided by its own fresh read of the
store's produto detail, never a delta, so whichever PUT lands LAST stands, and
the next event of the produto re-covers it. The price queue keeps NO failure
store either: a task whose every attempt meets a 429 or a 5xx is dropped (the
platform's error log is its only trace), and today only the next event of the
produto re-covers it — the price sync's nightly read lands in a later PR of
step 13. The whole send run is `lib/lojaIntegrada/preco/README.md`.

**Undoing a price send.** Every deciding read writes a `restauracao` line with
the produto detail's nine price-deciding leaves as they stood before the PUT,
the four prices verbatim. To undo one, a person re-sends that line's
`preco_cheio` and `preco_promocional` to the same product, in the window,
through the same strict route (the package's price builder): a prior promotion
of `null` or 0 goes back as the configured clear
(`LOJA_INTEGRADA_PRECO_PROMO_LIMPO`), and a prior price with more than two
decimal places, or a prior `null` or 0 full price, cannot be restored through
it. A send echoes the store's own custo and `sob_consulta` from that same read,
so it never changes them — save a store-panel edit landing between the read and
the PUT, which the echo overwrites (the accepted residual).

⚠️ **The stock trigger shares its path, and sees every stock write.**
`onEstoqueLojaIntegrada` listens on `produtos/{produtoId}/estoques/{estoqueId}`,
where `apps/functions`' `onEstoqueDeleted` (the `storage` codebase) also listens,
for deletes; the two are independent. Every ERP stock write of every depósito
and channel costs one invocation here, and a write that moves no available
quantity, or any write with the valve off, returns with ZERO reads. A write at a
depósito no Loja Integrada conta stocks from costs only the cached conta map (one
query per 15 minutes per instance), so a conta created or re-pointed to another
depósito is seen within that time; until then its moves wait for the nightly
reconcile. The trigger NEEDS `integracao (tipo ASC, nome ASC)` and the fan-out
`estoques (depositoOuterRef ASC, ultimaModificacao ASC)` READY (both already
declared in `firestore.indexes.json`): on Enterprise a missing index full-scans
and bills the scan.

⚠️ **The global stagger slot paces every bulk stock send.**
`reconcileEstoqueLojaIntegrada/atual.proximoSlotMs` spaces the kit fan-out's
sends one per 17 s, each fan-out behind every reservation already made, so the
stock queue never carries two bulk sends in one interval. Its two ERROR lines
are the backlog's signal: `slot global além do horizonte` (more than 12 h of
bulk sends already reserved; the fan-out still queues behind them) and `slot
global além do limite de agendamento` (the reservation would end past 29 days:
that fan-out enqueued NOTHING, and its kits wait for the nightly reconcile). No
setting relieves a backlog today — `LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX=0`
moves more kits onto the slot. Only a backlog of weeks or a hand-edited value
reaches the limit; a person who finds a value no backlog explains deletes the
`proximoSlotMs` FIELD (never the document), and the next fan-out starts at the
floor.

⚠️ **The daily stock reconcile (master-plan step 12, PR 12-g) stops at the
valve.** `reconciliarEstoqueLojaIntegrada` starts nothing while
`LOJA_INTEGRADA_MODO_ESTOQUE` is unset; set (`dry-run` or `on`) it starts ONE run
every night whatever the read switch says. With the switch off the run's ERP side
runs whole — it rebuilds the snapshot and the kits map the stock trigger's kit
sends read, and that is how its ERP cost is measured on staging before the
window — every conta's store phase stops at the switch, and at `dry-run` its
queue phase enqueues nothing. The conta trigger's depósito arm and a task
enqueued by hand start the same run. What an operator needs:

- **To stop a running chain**: set the stock valve `off` (unset) — every next
  slice returns with zero reads, and the lease frees within an hour.
- **A crashed chain** holds the lease (`reconcileEstoqueLojaIntegrada/atual`,
  `emExecucaoAteMs`) for at most an hour past its last write; the next run takes it
  then (a run started more than 48 h ago is abandoned at once, with ONE WARNING).
  Never delete the document: it also holds the global slot (`proximoSlotMs`) the
  kit fan-out writes — delete the reconcile fields only if a person must.
- **The safety gate**: a conta where more than 5% of the evaluated children have
  a stock record elsewhere but none at the conta's depósito gets NOTHING sent that
  night — ONE ERROR `deposito-sem-registros` and, under `on`, the
  `lojaIntegradaEstoqueVinculo` aviso of that motivo. Fix the conta's depósito (or
  the records); the next run sends.
- **A depósito changed while a run holds the lease**: the depósito arm's own run
  meets the lease and is refused (one INFO line). The running chain catches the
  change itself: before each queue slice it drops what is left for a conta whose
  depósito is not the one it fixed, and at its release it lists the contas once
  more — an active conta whose depósito is not the one it fixed, or an active
  conta it did not take that now has one (never a conta CREATED during the run) —
  and enqueues ONE full run named `estoque-reconcile-redeposito-<µs>` after the
  release. Worst case: the rest of the running chain plus one full run. An
  abandoned chain that is RELEASED on its last attempt (`tentativas-esgotadas`,
  `falha-nao-retentavel`) asks only for the re-run its queue phase recorded; a
  crash that leaves the lease to expire asks for nothing; a change the queue phase
  never saw waits for the next nightly run. So before enqueuing a run by hand
  after one of those ERROR lines, look for the `estoque-reconcile-redeposito-<µs>`
  run it may already have asked for. Every reconcile send carries its run's
  depósito: one whose conta now names another is dropped by the send run (one
  WARNING `deposito-mudou`), after one read of the conta past its 15-minute
  cache.
- **`recusa-da-loja`** (ONE ERROR for a conta): the store refuses that conta's
  stock read — a 3xx or 4xx other than 401, 403 and 429 on its stock list (a 404
  included), the same but a 404 on the detail read of a linked child the list
  never showed (there a 404 means "no row"), or a request the package refused to
  send (`LiConfigError`, say a stored token it cannot send). That conta's list or
  confirmations stay incomplete that night (its `sem-linha-na-loja` aviso stays
  unresolved) and the chain goes on to the next conta. The line names the class,
  the status and the operation: check that conta's credential and configuration.
  It repeats every night until fixed.
- **`falha-nao-retentavel`** (ONE ERROR): a coding bug on the queue's last
  attempt. The lease is released first, so the next run is not refused for an
  hour, and the error is rethrown (the runtime logs it too). It needs a code fix.
- **The backlog horizon**: a send that only RAISES a store's number is enqueued
  only while its slot instant is within 12 h; the rest wait for the next night
  (counted `adiadosHorizonte` on the run document). Over-advertising sends always
  go, bounded only by the slot's 29-day limit (`slot-esgotado`, ONE ERROR).
- `LOJA_INTEGRADA_ESTOQUE_LIMITE_PAGINA` (below) sizes the store's stock-list
  pages; nothing else of the reconcile is configured.

⚠️ **The conta trigger shares its path.** `onIntegracaoLojaIntegradaChanged` is
the THIRD `onDocumentWritten` on `integracao/{integracaoId}`, after Mercado
Livre's `onIntegracaoMercadoLivreChanged` and Shopee's `onIntegracaoShopeeChanged`
(and `apps/functions`' `onIntegracaoDeleted` cascade also fires on a delete). So
every conta write of any channel costs three Eventarc invocations, and each of
the three returns with zero reads for a write that is not its own channel's.

⚠️ **The anchor trigger writes a field other channels write too.**
`onProdutoLojaIntegradaLinkChanged` is the only function on
`produtos/{produtoId}/produtolojaintegrada/{linkId}`, but the array it maintains,
`produtos.integracoesComProduto`, is shared with the Mercado Livre and Shopee
anchors — each adds and removes only its OWN conta ids, by `arrayUnion` /
`arrayRemove`, so none can drop another's. It writes no other key (no
`ultimaModificacao`, so the produtos list never flashes for it), and the field
is in `onProdutoChanged`'s history ignore list. When a produto is deleted,
`apps/functions`' `onProdutoDeleted` cascade deletes its link docs AFTER it, and
each delete fires this trigger: its remove finds the produto gone (`NOT_FOUND`,
narrowed by the core) and writes nothing — a deleted produto is never
re-created. One residual it does leave: its add reads nothing, and Eventarc
guarantees no order, so an add handled AFTER its link's close (a late or retried
create) lists a conta with no counting link, and nothing automatic removes it.
That is the cheap direction — one wasted link listing in the manual stock push
(no sweep reads this channel's entries of the array), never a silent outage —
and only a hand fix clears it (the window's anchor census looks for
the opposite gap, a counting link whose conta is missing).

⚠️ **The pacer.** Every Loja Integrada call made through a context waits 2,000 ms
first, so one queue makes at most 30 calls a minute across task boundaries
(concurrency 1). A 429 is lossless: the task throws and backs off, and the poller
does not advance its cursor.

### Durability & the residual loss window

A notification is durable once it is either (a) processed, or (b) persisted as
`failed`/`deferred` for the sweep. Two narrow windows remain:

- The task handler persists a `failed` document only on its **final** attempt. If
  Firestore is unavailable for that whole retry window (a _correlated_ outage —
  the same Firestore the handler reads and writes), the final persist also
  fails. It logs and re-throws so the failed final attempt shows in Cloud Tasks'
  error metrics, but that notification is lost until the poller meets the order
  again (the cursor is already past it, so only a further change to the order
  does). Alert on the queue's failed final attempts.
- A **deferred** notification (a parked conta, for example) is re-driven daily
  for at most 7 passes, and on a token save or renewal the credential routes pull
  the conta's deferred rows back into the hot lane. A token restored after the
  7th pass finds those rows parked. The 30-day expiry aviso and the critical
  reconnection aviso both come before that loss.

### A parked notification logs ERROR

A failure the RUN threw (the import, or the context it loads first) that the
reprocess sweep parks at its cap (`MAX_TENTATIVAS`, 5 hot passes, so no sooner
than about five hours after the queue's last attempt) is terminal: no lane
re-drives it, and it holds an order nobody imported. So
`reprocessLojaIntegradaNotifications` logs ONE line at ERROR severity for each
such park — ids only, never a store name, a buyer's datum or the error's
message — and the row's document id joins the sweep's per-doc failures WARNING.
Alert on both ERROR lines:

- `[loja-integrada/importacao] pedido PAGO sem endereço de entrega: tentativas esgotadas, notificação estacionada`
  (`integracaoId`, `numero`, `pedidoId`): a PAID order with a shipment still
  carried NO CEP at all on its last run — no delivery block, or a CEP absent,
  empty, blank or the `-` placeholder (master-plan step 5). It also raises the
  `critico` aviso `lojaIntegradaPedidoPagoSemEndereco` on the conta page. A
  later import of that order resolves it only when the pedido ends up with a
  delivery endereço (one it already stores, never overwritten, or one the
  import stores from a readable CEP under the pedido's cliente), or a pickup
  route, or the order is no longer paid. Nothing else closes it: a readable
  CEP from a buyer with no valid document (no cliente, so no endereço) and an
  observation with no shipment leave it open too. A pickup order is exempt and
  imports without one. A present but INVALID CEP (a masked one included) never
  reaches this line: the order imports without an endereço or a carrier route,
  as an unpaid order without one does — and it keeps an open aviso of that
  order OPEN, so the address is still the operator's to fix.
- `[loja-integrada] notificação estacionada: tentativas esgotadas, pedido não importado`
  (`integracaoId`, `numero`, `origem`, `classe`): any other thrown failure — a
  429, a 5xx, a timeout, gRPC. No aviso: the row's `erro` is the record.

The line is written before the aviso, because the row is terminal and nothing
retries a signal: if the aviso write fails, the shared core adds
`[loja-integrada] retries-exhausted signal FAILED for a parked notification`
(ERROR, with the document id), and the first line is what is left. A RETURNED
park — a deterministic refusal, or the deferred lane's 7th pass — logs neither
line. That includes every row before the window: with the read switch unset a
run defers at the context, so neither line can appear until the switch is set.

⚠️ Not every THROWN park gets an ERROR line either: the shared core signals
only a failure the run threw. A row that no longer parses as a task (the
strict rehydration) throws BEFORE any run, so it parks at its lane's cap with
neither line nor aviso — and it too holds an order nobody imported. A store
write that fails after the run returned parks the same silent way. Both show
only as the row's document id in
`[loja-integrada] reprocess sweep (quente) had per-doc failures` (or `(adiada)`
for the deferred lane; WARNING, `docIds`), which the sweep logs on every pass
that met a failure. Alert on that WARNING too: a document id that repeats
across passes is a row on its way to a silent park; read its `erro`.

## Runtime env

None of these is a secret and none belongs in Secret Manager. They are read at
runtime by this nested codebase from the file below. A FEW are also read by the
`apps/loja-integrada` App Hosting backend, from its own console copy: the read
switch `LOJA_INTEGRADA_CHAMADAS` (the credential, catalogue, paid re-check and
import-start routes, and since PR 12-h the manual stock push),
`LOJA_INTEGRADA_MODO_ESTOQUE` (both stock routes, since PR 12-h) and
`LOJA_INTEGRADA_TASKS_REGION` / `LOJA_INTEGRADA_TASKS_DISABLED` (that backend's
own Cloud Tasks producers, PR 12-h). Set the switch and the valve ALIKE on both
surfaces (the comments below say when); the tasks pair is per surface. Every
other variable here is read by this codebase ONLY, so a value set in
`apphosting.yaml` or the console would be read by nothing and fail silently
(`apps/loja-integrada/apphosting.yaml`'s comment rows list what that backend
reads). The root `.env.example` lists the valves, the canary lists and the
switch as blank rows (`core/valvulas.test.ts` requires them); the rest of this
block's variables are optional there, and their real home is here.

firebase-tools' documented lane for gen2 runtime env vars is a `.env` /
`.env.<project-id>` file in the functions **source** directory. Here that
directory is the generated `.deploy/loja-integrada-functions`, and
`scripts/prepare-deploy.mjs` opens with
`rmSync(deployDir, { recursive: true, force: true })` — it **wipes and
regenerates the whole folder** as the `predeploy` hook, i.e. after you would
have dropped a file in it and before firebase reads the source. So a hand-placed
`.env` **there** does not survive, and there is no `--no-predeploy` escape
hatch.

Instead, put it in the **package** directory and let the hook carry it across
the wipe. Create `apps/loja-integrada/functions/.env.deploy` (gitignored):

```bash
# The READ SWITCH. Only the exact `on` lets this code call Loja Integrada at all;
# anything else (blank, unset, `ON`, ` on`, `true`) means NO call: the context
# loader refuses before any Firestore read and before it builds a client.
# ⚠️ Leave it COMMENTED OUT. Setting it is a migration-window decision (master
# plan §5 item 1, root CLAUDE.md rule 8) made by a person after the legacy app is
# OFF, and it must be set ALIKE here and in the App Hosting console of
# apps/loja-integrada, whose credential routes read it too (and, since PR
# 12-h, the manual stock push, which refuses with it off).
# LOJA_INTEGRADA_CHAMADAS=on

# The region of the four queues (reads, writes, stock and price: one region,
# read through one reader for all four). LEAVE IT UNSET: blank or unset = the
# FUNCTIONS_REGION inlined into the bundle (a blank value counts as unset, #1108).
# The queue is created WITH its function, by this deploy, in FUNCTIONS_REGION and
# nowhere else, so any other value names a queue that does not exist: every
# enqueue is dropped while it reports success (#1108). If you set it at all, set
# it to exactly the FUNCTIONS_REGION the deploying shell exported. App Hosting's
# own copy (a CONSOLE value of that backend since PR 12-h, whose two stock
# routes enqueue: "App Hosting enqueues since PR 12-h" below) must equal the
# same region.
# LOJA_INTEGRADA_TASKS_REGION=

# Sweep-only mode. Exactly `1` makes the poller's enqueue throw, so each
# notification is persisted `failed` and the 30-minute reprocess sweep drains it
# (never a silent drop). Strict `=== '1'`: unset, blank, `true` and `1 ` all
# leave enqueuing ON. Use it before the queue IAM is granted.
# It closes the WRITES queue's producers too (step 7): the history trigger
# persists each write event `failed`, and the varredura timer cannot enqueue its
# sweep — so NOTHING writes while it is set; the rows wait and do not age, and
# drain once it is cleared. It does NOT close the App Hosting backend's own
# producers: that backend has its own console copy (PR 12-h).
# It closes this codebase's STOCK producers too (step 12), none of which keeps
# a failure row: the stock trigger logs one WARNING and skips the event's
# enqueues, a send run's drift follow-up is one WARNING (its write stands), the
# kit fan-out ends `tarefas-desligadas`, the nightly reconcile start and the
# conta trigger's depósito arm log one WARNING, a reconcile slice's hand-off
# releases the run's lease with one WARNING, and its queue phase drops its
# candidates with one WARNING. The next event or night re-covers.
# It closes the PRICE producer too (step 13): a price send run's drift
# follow-up is one WARNING (its write stands), and the next event re-covers.
# LOJA_INTEGRADA_TASKS_DISABLED=1

# How far back, in HOURS, the poller's first window reaches for a conta with no
# cursor yet. Unset or blank = 72. Otherwise a whole number from 1 to 2160
# without a leading zero; anything else refuses that conta's bootstrap and
# raises an aviso rather than guessing a window.
# ⚠️ It must stay under the poller's drain cap — at most `meta.limit` x 20
# distinct modified orders, about 20 days at a limit of 20 and about 50 days at
# 50 — and it is derived from the gap to the legacy app's last import (master
# plan §5 item 7), not picked.
# LOJA_INTEGRADA_POLL_LOOKBACK_H=72

# ---- The WRITE VALVES and CANARY LISTS (read from master-plan step 7 onward). ----
# Every line below is COMMENTED OUT. One valve per write flow: off | dry-run | on.
# Only the exact `on` writes and only the exact `dry-run` diffs; anything else is
# off (an unrecognised value also logs one WARNING per run).
# The RASTREIO pair is READ since step 7, by this codebase ONLY (the
# freight-history trigger, the writes queue and its varredura; App Hosting has no
# reader of it): the status write-back.
#   - `dry-run` is the EMERGENCY BRAKE: every event is still recorded, deferred
#     and replayed daily (at most 7 passes) once the valve is `on` again. It is
#     also the HOLD while a window check fails (never `off`).
#   - `off` (or unset) RECORDS NOTHING: a posting made while it is off is never
#     written back. It keeps what was already recorded, but the deploy that opens
#     operations must already carry `dry-run`.
# Since step 12 this codebase reads LOJA_INTEGRADA_MODO_ESTOQUE in the stock
# queue's send run (PR 12-e), the stock trigger and the kit fan-out (PR 12-f),
# every daily-reconcile slice, the nightly reconcile start and the conta
# trigger's depósito arm (PR 12-g); it reads LOJA_INTEGRADA_CANARIO_ESTOQUE in
# the send run and the daily reconcile only (below). Since PR 12-h the App
# Hosting backend reads LOJA_INTEGRADA_MODO_ESTOQUE too (its two stock routes
# answer 503 with it `off`; the canary list is parsed there with the valve but
# never applied): `off` (or
# unset) makes every stock run, every trigger event, every fan-out and every
# reconcile slice return before any read, and the nightly start and the
# depósito arm enqueue nothing;
# `dry-run` makes the trigger and the fan-out enqueue (and pace) exactly as `on`
# does, and each send run then reads, plans and logs one diff line with nothing
# sent; a reconcile run at `dry-run` reads and diffs every conta, but its queue
# phase enqueues nothing and its end writes no aviso.
# LOJA_INTEGRADA_CANARIO_ESTOQUE is applied by the send run and, per
# conta, by the daily reconcile: its queue phase drops the candidates outside
# the list (counted `foraDoCanario`), and its end writes avisos only for a conta
# the list admits (`*`, or an entry of that conta). The whole stock sync is
# `lib/lojaIntegrada/estoque/README.md`.
# Since step 13 (PR 13-d) this codebase reads LOJA_INTEGRADA_MODO_PRECO and
# LOJA_INTEGRADA_CANARIO_PRECO in the price queue's send run (the App Hosting
# backend has no reader of either yet): `off` (or unset) makes every price run
# return before any read; `dry-run` makes it read, plan and log one diff line
# with nothing sent (no aviso, no park); `on` sends only to a target the canary
# list admits. Nothing enqueues a price task yet but the run's own follow-up. The
# whole price send run is `lib/lojaIntegrada/preco/README.md`.
# The anúncio and webhook-registration pairs have no reader yet.
# ⚠️ STAGING HAZARD. Loja Integrada has no sandbox and the origin is fixed, so a
# conta holding a token — real or invented — makes our code read LIVE (the
# validating GET on a save, and the poller). With a valve `on` and a canary entry
# or `*`, such a conta would WRITE to a real store while the legacy app is still
# its only writer. So: NO Loja Integrada token is saved or renewed in staging, or
# locally, before the window (D17), and these lines stay commented out. Set them
# ALIKE here and in the App Hosting console where that backend reads one (since
# PR 12-h: LOJA_INTEGRADA_MODO_ESTOQUE; the rest, LOJA_INTEGRADA_CANARIO_ESTOQUE
# included, are applied here only), and only in the window — with ONE exception
# before it: LOJA_INTEGRADA_MODO_ESTOQUE=dry-run, alike on both surfaces, is the
# daily reconcile's staging measurement path (above). With the read switch off
# and no token saved it calls nothing and writes nothing to a store; `on`, any
# canary entry and the read switch stay window decisions.
# LOJA_INTEGRADA_MODO_ESTOQUE=
# LOJA_INTEGRADA_MODO_PRECO=
# LOJA_INTEGRADA_MODO_ANUNCIO=
# LOJA_INTEGRADA_MODO_RASTREIO=
# LOJA_INTEGRADA_MODO_WEBHOOK_REGISTRO=
# Which targets an `on` valve really writes to; every other target dry-runs.
# Unset/blank = NO target, exactly `*` = every target, else `<contaId>:<n>,…`
# (the Loja Integrada produto id for estoque, preco and anuncio; the pedido
# numero for rastreio). The webhook registration has no list.
# LOJA_INTEGRADA_CANARIO_ESTOQUE=
# LOJA_INTEGRADA_CANARIO_PRECO=
# LOJA_INTEGRADA_CANARIO_ANUNCIO=
# LOJA_INTEGRADA_CANARIO_RASTREIO=

# The upper CAP on the quantity one stock row advertises (step 12, read by the
# stock queue's send run at each run, never baked into the bundle). Unset or
# blank = no cap. Otherwise a positive whole number in plain decimal — no sign,
# no leading zero, no space, never 0 (0 would zero every row). ANY other value
# REFUSES every stock run (one ERROR line per run, nothing read or sent) rather
# than guessing a cap; the daily reconcile re-covers once the value is fixed.
# The value itself is a window decision, made by a person. Since PR 12-f the
# stock trigger and the kit fan-out read it too: an invalid value is ONE ERROR
# line per event at a Loja Integrada depósito (nothing enqueued) and per fan-out.
# Since PR 12-g every daily-reconcile slice reads it too, right after the valve:
# an invalid value is ONE ERROR line per slice and zero reads (`teto-invalido`),
# and no continuation is enqueued, so the reconcile chain stops until the value
# is fixed; the next nightly start after the fix runs the whole reconcile again.
# LOJA_INTEGRADA_ESTOQUE_MAX=

# The EAGER ceiling of the stock trigger's kit path (step 12, PR 12-f): a
# component in at most this many store kits of a conta has every kit change
# checked at once (the tie-inclusive filter, its siblings read); one in more sends
# ONLY its kits' zero-crossings at once (one fan-out task), and every other kit
# change waits for the nightly reconcile. Unset or blank = 30. Otherwise a whole
# number 0..30 in plain decimal (no sign, no leading zero, no space); 0 sends
# every kit through the zero-crossing path — the lever when eager kit sends
# crowd the stock queue. Above 30 is REFUSED (the eager path reads only the
# header's inline kits), and so is anything unreadable: ONE WARNING per event that
# reaches a kits header, and the trigger acts as 0. The value is a window decision,
# made from the ERP's kit counts.
# LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX=

# The PAGE SIZE of the daily stock reconcile's walk of a store's stock list
# (step 12, PR 12-g): rows per `GET /v1/produto_estoque` call. Read when a
# conta's walk STARTS and kept in its cursor, so a run never changes it
# mid-list. Unset or blank = 100 (the owner's read-only stock captures saw
# 20, 50 and 100 honoured exactly and 200 refused with a 400). Otherwise a
# whole number 1..100 in plain decimal (no sign, no leading zero, no space).
# Above 100 is CLAMPED to 100 and anything unreadable falls back to 100 — ONE
# WARNING per run either way, never a refused run. A smaller page only costs
# more calls; there is no reason to set it before the window.
# LOJA_INTEGRADA_ESTOQUE_LIMITE_PAGINA=

# The wire shape of a CLEARED promotion in the price sync (step 13, PR 13-d),
# read by the price queue's send run at each run. LEAVE IT UNSET: unset or blank
# = `nulo` (JSON null). `zero` sends 0; `igual-cheio` sends the full price — a
# window-only fallback a person picks only after the canary shows the store
# refusing both others, never the default. Spelled exactly (nothing trimmed or
# case-folded): ANY other value refuses EVERY price run with one ERROR line,
# nothing read or sent.
# LOJA_INTEGRADA_PRECO_PROMO_LIMPO=
```

⚠️ The scheduled functions are deployed either way — a variable only decides
whether a firing does any work. Changing one is therefore a redeploy, not a code
change.

`prepare-deploy.mjs` copies the file into the artifact **as `.env`** after the
wipe, and firebase-tools applies it at deploy. It survives redeploys — no
`gcloud run services update` to re-apply, and no Secret Manager entry for a
non-secret tunable.

**Per-project targeting.** `.env.deploy` applies to whatever project you deploy
to, so a staging file deployed to production takes its values with it. For values
that belong to ONE project, name the file `.env.deploy.<project-id>`: it lands as
`.env.<project-id>`, which firebase-tools applies only for that `--project`. Both
can coexist; firebase-tools layers the project-specific file over `.env`.

⚠️ The allowlist is anchored and shared by every `prepare-deploy.mjs`
(`tools/deploy-env/env-files.mjs`). Exactly two source names are copied —
`.env.deploy` and `.env.deploy.<project-id>`. A **`.env.secrets*` fails the
hook**, and so does a bare `.env` (with a rename instruction): everything that
reaches the artifact is uploaded to the project's `gcf-sources-*` bucket and
baked in plaintext into the Cloud Run revision.

## ⚠️ One-time IAM — who enqueues Cloud Tasks

In master-plan step 3 the **functions runtime service account** is the only
identity that enqueues: the order poller puts its synthetic notifications onto
`filaLeituraLojaIntegrada`. **Since master-plan step 12 (PR 12-h) the App Hosting
runtime service account of `apps/loja-integrada` enqueues too** — see "App
Hosting enqueues since PR 12-h" below. The credential routes never enqueue —
they only re-drive rows already in Firestore.

The enqueuing identity needs **three** grants. `<enqueuing-sa>` is each
enqueuing identity in turn: the functions runtime SA, the identity the poller
runs as (by default `PROJECT_NUMBER-compute@developer.gserviceaccount.com`), and
since PR 12-h the App Hosting runtime SA.

**The product import (master-plan step 9) needs NO new Cloud Tasks grant** (its
photos need a STORAGE grant: "Photos: the runtime SA writes the default bucket"
below). Its two producers — the `onImportacaoLojaIntegradaCriada` trigger (a
job's first slice) and each import slice handing off to the next — both run as
the functions runtime SA and enqueue onto the SAME reads queue
`filaLeituraLojaIntegrada`, so the reads queue's three grants already cover them.
The import's start route (App Hosting) only creates the job document and never
enqueues.

**The writes queue (master-plan step 7) needs the same three, for its own
queue.** `filaEscritaLojaIntegrada` is enqueued by the history trigger and the
varredura timer, both running as the functions runtime SA and nothing else, so
`<enqueuing-sa>` is that SA. Grants 1 and 3 are per QUEUE and per SERVICE: run
grant 1 a second time with the queue `filaEscritaLojaIntegrada` in place of
`filaLeituraLojaIntegrada`, and grant 3 with the service
`filaescritalojaintegrada` in place of `filaleituralojaintegrada` (or let
`TASKS_INVOKER_SA` apply them, below). Grant 2 is on the account, not the
queue: one grant covers both queues.

**The stock queue (master-plan step 12) needs the same three, for its own
queue.** `filaEstoqueLojaIntegrada` is enqueued by the stock trigger
`onEstoqueLojaIntegrada`, the kit fan-out (an `estoque-kits` task enqueuing one
send per kit) and the send run's own `deriva` follow-up, all running as the
functions runtime SA, as does the daily reconcile's queue phase (PR 12-g); the
manual push (PR 12-h) enqueues onto it as the App Hosting runtime SA. Run grant 1
with the queue `filaEstoqueLojaIntegrada` and grant 3 with the service
`filaestoquelojaintegrada` (or let `TASKS_INVOKER_SA` apply them); grant 2 is
already in place for the functions runtime SA.

**The price queue (master-plan step 13) needs the same three, for its own
queue.** `filaPrecoLojaIntegrada` is enqueued today only by the price send run's
own `deriva` follow-up, running as the functions runtime SA; the price trigger
and the nightly read (later PRs of step 13) will enqueue as that SA too, and the
operator's price routes as the App Hosting runtime SA. Run grant 1 with the
queue `filaPrecoLojaIntegrada` and grant 3 with the service
`filaprecolojaintegrada` (or let `TASKS_INVOKER_SA` apply them); grant 2 is
already in place for both SAs.

⚠️ **The writes queue's bindings are the reads queue's, by construction.** Both
queue functions spread the same `tasksInvokerOptions()`, and `TASKS_INVOKER_SA`
is ONE authoritative list for the whole codebase: every identity named in it
gets `roles/cloudtasks.enqueuer` on EVERY queue and `roles/run.invoker` on EVERY
queue's service (four of each since master-plan step 13: the stock and price
queues spread the same options). Since PR 12-h that list names the App Hosting
runtime SA too, so that identity holds the same rights on the writes queue — one
of the three queues that write to Loja Integrada — although nothing in App Hosting
enqueues onto it (the code pin in "App Hosting enqueues since PR 12-h" below is
what keeps it so). PR 12-h accepts that
rather than giving each queue its own invoker list; splitting the list is the
fix if the exposure ever matters.

⚠️ **A queue name and its Cloud Run service name differ in CASE.** Cloud Tasks
keeps the function's name (`filaEscritaLojaIntegrada`); the gen2 function's Cloud
Run service is that name LOWERCASED (`filaescritalojaintegrada`,
`filaleituralojaintegrada`). Every `gcloud tasks queues …` line below takes the
queue name, every `gcloud run services …` line the service name. The lowercase
form follows Cloud Run's naming rule (a service name is lowercase, and
firebase-tools derives it the same way), but it was not checked against a real
deploy of this codebase: confirm it on the first deploy (`gcloud run services
list --region=<region> --project=<project-id>`) before any switch is flipped.

```bash
# 1 - permission to CREATE the task. Queue-level, so it can only run once the
# deploy has created the queue.
# ⚠ SINCE #1133 THE DEPLOY APPLIES THIS ONE when TASKS_INVOKER_SA is set - except
# on the first deploy of the queue, which crashes on exactly this binding (see the
# firebase-tools section below for the workaround).
gcloud tasks queues add-iam-policy-binding filaLeituraLojaIntegrada \
  --location=<region> --project=<project-id> \
  --member="serviceAccount:<enqueuing-sa>" \
  --role="roles/cloudtasks.enqueuer"

# 2 - permission to ACT AS the account the task's OIDC token names. The Admin SDK
# stamps that token with the enqueuer's own identity, and Cloud Tasks refuses to
# create a task carrying an OIDC token without actAs on that account, even when
# the caller IS that account. In step 3 both are the functions runtime SA.
# ⚠ THE DEPLOY NEVER APPLIES THIS ONE: TASKS_INVOKER_SA covers grants 1 and 3
# only. Without it every enqueue fails `permission-denied`, which the producer
# rethrows untouched (it is not a transient failure).
gcloud iam service-accounts add-iam-policy-binding <functions-runtime-sa> \
  --project=<project-id> \
  --member="serviceAccount:<enqueuing-sa>" \
  --role="roles/iam.serviceAccountUser"

# 3 - permission to DISPATCH: roles/run.invoker ON THE SERVICE (see below).
# ⚠ SINCE #1133 THE DEPLOY APPLIES THIS ONE when TASKS_INVOKER_SA is set. Run it
# by hand only for a deploy without that variable.
gcloud run services add-iam-policy-binding filaleituralojaintegrada --region=<region> \
  --project=<project-id> \
  --member="serviceAccount:<enqueuing-sa>" \
  --role="roles/run.invoker"
```

⚠️ **The third role is the one everyone forgets.** Enqueuing is only half the
trip: Cloud Tasks then DISPATCHES the task, presenting an OIDC token whose
principal is the enqueuer's own identity, and a gen2 function is a Cloud Run
service, so that principal needs `run.invoker` ON THE SERVICE. Without it the
task is created and delivered and the service answers 403 `run.routes.invoke`,
with NO failure document written anywhere.

### App Hosting enqueues since PR 12-h

The two operator stock routes of the `apps/loja-integrada` App Hosting backend
enqueue through `lib/firebase/filasLi.ts`: the manual stock push
(`POST …/enviar-estoque`) onto the STOCK queue `filaEstoqueLojaIntegrada`, the
operator's reconcile (`POST …/conta/[id]/estoque/reconciliar`) its first slice
onto the READS queue `filaLeituraLojaIntegrada`. Neither ever enqueues onto the
writes queue (`estrutura.test.ts` pins each root's queue set). Before either
route is used on a project, the App Hosting runtime SA needs:

1. **Grants 1 and 3 on the reads and stock queues** — name it in
   `TASKS_INVOKER_SA` beside the functions runtime SA (below), and the deploy
   applies both. Without it the enqueue is refused (the push answers 500 or a
   `falha` row) or the task is created and its dispatch 403s with no failure
   document anywhere.
2. **Grant 2 on ITSELF** — the Admin SDK stamps the task's OIDC token with the
   enqueuer's own identity, so the App Hosting runtime SA needs
   `roles/iam.serviceAccountUser` on the App Hosting runtime SA. No deploy makes
   it:

   ```bash
   gcloud iam service-accounts add-iam-policy-binding <apphosting-runtime-sa> \
     --project=<project-id> \
     --member="serviceAccount:<apphosting-runtime-sa>" \
     --role="roles/iam.serviceAccountUser"
   ```

3. **Two console values on that backend** (never an `apphosting.yaml` `env:`
   row): `LOJA_INTEGRADA_TASKS_REGION` set to exactly this codebase's
   `FUNCTIONS_REGION` (the preflight prints the cross-check; unset is the safe
   state — both routes answer 500 before any read — and a well-formed WRONG
   region drops every task while the route answers success, #1108), and
   optionally `LOJA_INTEGRADA_TASKS_DISABLED=1` (both routes answer 503,
   nothing read). The set-alike pairs follow the `.env.deploy` rules above:
   `LOJA_INTEGRADA_MODO_ESTOQUE=dry-run` on BOTH surfaces is the one value
   allowed before the window (the reconcile's staging measurement path);
   `LOJA_INTEGRADA_MODO_ESTOQUE=on` and `LOJA_INTEGRADA_CHAMADAS=on` are set
   alike, and only in the window. Nothing cross-checks the two copies, and the
   operator copy of both routes is written so that it promises nothing the
   functions copy decides.

**Deploy order:** this functions codebase first (the queues' consumers and the
invoker list naming both SAs), then the `apps/loja-integrada` App Hosting
backend, then `apps/web` (whose stock provider stays unreachable until the
step-22 caps flip anyway).

**Verify, on staging** (the stock valve at `dry-run` on BOTH surfaces, the read
switch unset on both, as the rules above require). ⚠️ **Only the reconcile route
can be exercised end to end before the window**: the push refuses with the read
switch off, by design.

- **The reconcile route** (the reads queue): POST it for one conta and expect a
  202 with `chamadas: false`; within minutes `reconcileEstoqueLojaIntegrada/atual`
  takes its lease under an `estoque-reconcile-manual-…` id, and the functions
  log shows no 403 on dispatch. That exercises what both routes share: the
  region value, the act-as grant (2) and the `TASKS_INVOKER_SA` list the deploy
  applied — on the reads queue only.
- **The push** (the stock queue): POST it for one linked produto and expect 503
  `LI_CHAMADAS_DESLIGADAS` with NO task created (nothing appears on
  `filaEstoqueLojaIntegrada`). Its queue rights are verified READ-ONLY:

  ```bash
  gcloud tasks queues get-iam-policy filaEstoqueLojaIntegrada \
    --location=<region> --project=<project-id>
  gcloud run services get-iam-policy filaestoquelojaintegrada \
    --region=<region> --project=<project-id>
  ```

  The first must list the App Hosting runtime SA under
  `roles/cloudtasks.enqueuer`, the second under `roles/run.invoker`. A missing
  `run.invoker` there is the SILENT case: the task is created, its dispatch
  403s, and the push had answered `enfileirado`.

- **In the window, once the read switch is `on` on both surfaces** (a runbook
  step, never earlier): push ONE linked child and find the stock queue's
  dispatch line for it in the functions log, with no 403 on dispatch — the
  first time the App Hosting backend's stock-queue path runs end to end.

### Photos: the runtime SA writes the default bucket (master-plan step 9)

A product import run with "completar" and photos ("só em produtos sem fotos")
uploads each picture to the project's DEFAULT bucket through the shared uploader
(`putArquivoAdmin`): an `arquivos` document first (Firestore, which the runtime
SA already writes), then the object
`produtos/<produtoId>/originals/<sha-512>.<ext>`. **That is the first Storage
write this codebase makes, and it needs a grant the Cloud Tasks section above
does not cover**: the functions runtime SA must create objects in that bucket,
and OVERWRITE one — an upload retried after its object landed but before its
document recorded it writes the same object name again, and Cloud Storage
requires delete permission to replace an object. So grant
`roles/storage.objectUser` ON THE BUCKET (not the project); `roles/storage.objectCreator`
alone lets a first upload through and refuses that retry with a 403. Nothing
here reads, lists or deletes objects of its own accord. No new Cloud Tasks grant:
photos run as the import dispatch's `foto` units (one picture each), on the reads
queue.

```bash
# The bucket is the one FIREBASE_CONFIG names on the deployed functions — on a
# project created after late 2024 that is <project-id>.firebasestorage.app,
# NOT <project-id>.appspot.com. Confirm it first:
gcloud storage buckets list --project=<project-id>
gcloud storage buckets add-iam-policy-binding gs://<default-bucket> \
  --member="serviceAccount:<functions-runtime-sa>" \
  --role="roles/storage.objectUser"
```

⚠️ On the NEW project the default compute SA may not hold Editor (an org policy
can disable that automatic grant), so do not assume the old project's implicit
access carries over. Without the grant every photo upload fails with a 403,
which propagates: the task retries the slice and fails the same way each time,
so the job stops at the first picture it tries to store and stays `executando`
with nothing queued (its card flags it after 45 minutes without progress). The
writes before it stay — that family's fills, or its create with the links that
ride the create's batch; an existing family's links come after its photos, so
they are not written yet — and a restart redoes none of them
(every import write is fill-empty, create-only or idempotent). Cancelar ends
the job; grant, then start it again. The same stranding follows a TRANSIENT
Storage failure (a 5xx or 429 from Cloud Storage) that happens to hit the
queue's last attempt: no Storage error class is narrowed there, so it is never
stamped `tentativas-esgotadas` — Cancelar is the recovery in both cases.

### The deploy aborts if `TASKS_INVOKER_SA` is missing (#1133)

`predeploy` runs `node tools/deploy-env/preflight.mjs loja-integrada` **before** the
artifact is built. It prints every build-time value that is about to be baked
into the bundle — and whether each came from your shell or from a `build.mjs`
default — then refuses to continue if either of these is true:

- **`TASKS_INVOKER_SA` is unset or blank.** Without it `invoker` is omitted, no
  `roles/run.invoker` is granted, and the dispatch leg 403s _after_ the enqueue
  reported success — so nothing writes a failure document anywhere.
- **the task/schedule region has no Cloud Tasks.** That deploy fails every queue
  and schedule function at once — the asymmetric failure list from #1108,
  refused up front instead.

Run it by hand any time; it changes nothing:

```bash
node tools/deploy-env/preflight.mjs loja-integrada
```

ℹ️ **Since PR 12-h it ends with the backend cross-check**: a note naming
`LOJA_INTEGRADA_TASKS_REGION` and the region it must equal, to be set in the
App Hosting CONSOLE of `apps/loja-integrada` — never as a row of its
`apphosting.yaml`, which deliberately has none (the Shopee shape: a manifest
value would reach every project's backend, and unset is the safe state).

⚠️ It does **not** run in CI. `predeploy` hooks are skipped under
`emulators:exec`, which is deliberate — the emulators have no IAM layer.

### `TASKS_INVOKER_SA` — the third role, applied by the deploy (#1133)

Export it in the shell you run `firebase deploy` from. `build.mjs` inlines it
(esbuild `define`, exactly like `FUNCTIONS_REGION`) and the `onTaskDispatched`
in this codebase declares it as `invoker`; firebase-tools then applies the list
to **both** legs of the trip — `roles/run.invoker` on the function's Cloud Run
service **and** `roles/cloudtasks.enqueuer` on its queue. It never applies grant 2,
the act-as on the functions runtime SA: that one stays a manual `gcloud` grant
with or without this variable.

```bash
export TASKS_INVOKER_SA="<functions-runtime-sa>,<apphosting-runtime-sa>"
firebase deploy --only functions:loja-integrada \
  --config firebase.loja-integrada.deploy.json \
  --project <project-id>
```

⚠️ **The list is AUTHORITATIVE: name every enqueuer, comma-separated** — drop the
duplicate when two are the same identity. A deploy **replaces** the members of
both bindings, so an identity left out **loses** the role. Since PR 12-h that is
the functions runtime SA AND the App Hosting runtime SA of `apps/loja-integrada`
(its two stock routes enqueue), and a later deploy that forgets the second
removes its role: the manual push and the reconcile route then fail to enqueue,
or their tasks 403 on dispatch. Name both from the first deploy into a project.

⚠️ **Unset ⇒ the option is omitted entirely.** The build prints a warning and
grants 1 and 3 above become manual too. It never guesses a value: a wrong one
would lock out the legitimate caller, and a permissive one would be far worse.

⚠️ A redeploy with **no** `invoker` declared does not clear an existing binding —
firebase-tools skips `setInvokerUpdate` when the option is absent — but a service
**create**, i.e. a new or renamed task function, leaves no binding at all. That
silent case is what this variable exists for.

Verify it took, with nobody having run gcloud:
`gcloud run services get-iam-policy filaleituralojaintegrada --region=<region>`,
and the same for the services `filaescritalojaintegrada` and
`filaestoquelojaintegrada` (Cloud Run service names are the LOWERCASED function
names; see the case note above).

### ⚠️ firebase-tools 15.28.2: the first deploy of a NEW queue crashes on the enqueuer binding

Measured on another channel's staging deploy of 2026-09-24, and **not specific
to it**: the first deploy of ANY codebase's brand-new task queue whose function
declares `invoker` hits it — and in this repo every functions codebase's
`build.mjs` inlines `invoker` from `TASKS_INVOKER_SA`. No deploy path pins
firebase-tools — the CI emulator lanes pin their own version and never deploy — so
this is the deploying machine's CLI: check whether a newer release fixed it
before relying on the workaround.

- **The mechanism.** `cloudtasks.setEnqueuer` (firebase-tools
  `lib/gcp/cloudtasks.js`) runs `existing.bindings.filter(...)` over the queue's
  IAM policy. A brand-new queue's `getIamPolicy` answers `{"etag":"ACAB"}` with
  **no `bindings` key**, so it throws
  `Cannot read properties of undefined (reading 'filter')`.
- **The misleading symptom.** The deploy prints "Unable to set the invoker for
  the IAM policy … `roles/functions.admin` … organization policy" for the queue
  function. It reads like a permissions problem and is not one.
- **What lands anyway.** The functions, the queue and the `roles/run.invoker`
  binding on the Cloud Run service. What is MISSING is only the queue-level
  `roles/cloudtasks.enqueuer` binding — the enqueue leg.
- **Re-running alone does not help.** The deploy never passes `assumeEmpty`, so a
  retry reads the same binding-less policy and crashes identically.

The workaround — **once per new queue, per identity** named in `TASKS_INVOKER_SA`:

```bash
gcloud tasks queues add-iam-policy-binding filaLeituraLojaIntegrada \
  --location=<region> --project=<project-id> \
  --member="serviceAccount:<sa>" \
  --role=roles/cloudtasks.enqueuer

# and, for the writes queue (master-plan step 7) — a NEW queue of its own:
gcloud tasks queues add-iam-policy-binding filaEscritaLojaIntegrada \
  --location=<region> --project=<project-id> \
  --member="serviceAccount:<sa>" \
  --role=roles/cloudtasks.enqueuer

# and, for the stock queue (master-plan step 12) — a NEW queue of its own:
gcloud tasks queues add-iam-policy-binding filaEstoqueLojaIntegrada \
  --location=<region> --project=<project-id> \
  --member="serviceAccount:<sa>" \
  --role=roles/cloudtasks.enqueuer

# and, for the price queue (master-plan step 13) — a NEW queue of its own:
gcloud tasks queues add-iam-policy-binding filaPrecoLojaIntegrada \
  --location=<region> --project=<project-id> \
  --member="serviceAccount:<sa>" \
  --role=roles/cloudtasks.enqueuer
```

then re-run the SAME deploy: the policy now has a `bindings` array, so the
deploy re-applies `TASKS_INVOKER_SA` authoritatively and finishes clean. This
codebase has FOUR queues, so a first deploy into a project pays it once per
queue per identity — and a project that already holds the reads queue (or the
reads, writes and stock queues) still pays it for each queue the deploy first
creates.
**Production's included**: it is a separate project, so put the grants in the
window's runbook.
Verify the enqueue leg, which the `run` check above cannot see:
`gcloud tasks queues get-iam-policy <queue> --location=<region>` must list
`roles/cloudtasks.enqueuer` for every identity in `TASKS_INVOKER_SA`, for ALL
FOUR of `filaLeituraLojaIntegrada`, `filaEscritaLojaIntegrada`,
`filaEstoqueLojaIntegrada` and `filaPrecoLojaIntegrada`.

## Verifying a first deploy

Do these in the window, in this order, after the deploy and before any switch is
flipped. ⚠️ **A failed check of ANY item below still leaves the write-back at
`dry-run`** (owner decision, 2026-10-27): the deploy that opens operations
carries `LOJA_INTEGRADA_MODO_RASTREIO=dry-run` — never `off`, never unset, since
either records no posting — and the valve never reaches `on` until every check
of this section passes.

1. Cloud Tasks lists the queues `filaLeituraLojaIntegrada`,
   `filaEscritaLojaIntegrada`, `filaEstoqueLojaIntegrada` and
   `filaPrecoLojaIntegrada`, each with concurrency 1 and one dispatch per second
   (item 6 checks the writes queue in full; the stock and price queues take the
   SAME `describe` checks — rate, retry ladder, the service's concurrency 1 and
   max instances 1 — before their valves leave `off`), and Cloud Scheduler lists
   the schedule functions.
2. For EACH queue, `gcloud run services get-iam-policy <service>` and
   `gcloud tasks queues get-iam-policy <queue>` both name every identity in
   `TASKS_INVOKER_SA` — `<queue>` the function name (`filaLeituraLojaIntegrada`,
   `filaEscritaLojaIntegrada`, `filaEstoqueLojaIntegrada`,
   `filaPrecoLojaIntegrada`), `<service>` the same name LOWERCASED
   (`filaleituralojaintegrada`, `filaescritalojaintegrada`,
   `filaestoquelojaintegrada`, `filaprecolojaintegrada`; confirm it with
   `gcloud run services list` first, as the IAM section says) — and
   `gcloud iam service-accounts get-iam-policy <functions-runtime-sa>` lists
   `roles/iam.serviceAccountUser` for each of them (grant 2, which no deploy
   makes). Since PR 12-h the App Hosting runtime SA enqueues as ITSELF, so
   `gcloud iam service-accounts get-iam-policy <apphosting-runtime-sa>` must list
   that role for the App Hosting runtime SA too.
3. The Firestore index `notificacoesLojaIntegrada (status, processedAt)` and
   `(status, contaId)` are READY, and so are
   `int_frete (tipo, contaLojaIntegradaEnviosOuterRef, ativo, dataCadastro DESC)`
   and the collection group `produtolojaintegrada (contaLojaIntegrada, id)`
   (checked before the deploy, see Prerequisites): on Enterprise a missing index
   does not fail, it full-scans and bills the scan.
4. The console lists `onIntegracaoLojaIntegradaChanged` as a Firestore trigger on
   database `default`, and the Eventarc trigger carries that filter:

   ```bash
   gcloud eventarc triggers list --project <project-id>
   # expect a trigger for onintegracaolojaintegradachanged,
   # event type google.cloud.firestore.document.v1.written,
   # filtered to database 'default' + the integracao/* document path
   ```

   Then prove one mirrored change reaches the doc: rename one conta and rename
   it back, and confirm that its `int_frete` doc's `nome` followed and its
   `ultimaModificacao` moved — or find the
   `[loja-integrada] onIntegracaoLojaIntegradaChanged` log line with action
   `atualizado`. ⚠️ A plain conta save proves nothing: one that moves no
   mirrored field writes nothing by design, and right after the adoption pass's
   `--apply` every adopted doc is already in step.

5. The first poller tick (once the read switch is on; the importer seam is
   filled since step 5) asks for orders modified since a moment AT OR BEFORE the
   legacy app's last import — a later start would leave a gap — every active
   conta has a `pollPedidosLojaIntegrada` document, and no
   `lojaIntegradaImportacaoParada` aviso is open.
6. **The writes queue (master-plan step 7). `LOJA_INTEGRADA_MODO_RASTREIO`
   never reaches `on` until every check of this item passes, and while one
   fails it is HELD at `dry-run` — never `off`** (owner decision, 2026-10-27).
   `off` stops recording the postings, so none made meanwhile could ever be
   written back; `dry-run` sends nothing to Loja Integrada and keeps every event
   for the daily replay (the 7-pass deadline of the window section below still
   runs). What narrows two attempts of one order writing at once (it does not
   eliminate it: see "The writes queue is single-file by design" above) rests on
   these numbers, and a queue created or altered outside the deploy (the 15.28.2
   workaround path above) is checked by nothing else:

   ```bash
   gcloud tasks queues describe filaEscritaLojaIntegrada --location=<region> --project <project-id>
   # expect rateLimits.maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1,
   # retryConfig.maxAttempts: 3, minBackoff: 300s, maxBackoff: 300s, maxDoublings: 0
   # The Cloud Run SERVICE is the function name LOWERCASED (the IAM section's
   # case note) — the queue above keeps its case:
   gcloud run services describe filaescritalojaintegrada --region=<region> --project <project-id>
   # expect containerConcurrency: 1 and the max-instances annotation 1
   gcloud scheduler jobs list --location=<region> --project <project-id>
   # expect the varrerEscritasLojaIntegrada job: 15,45 * * * *, America/Sao_Paulo
   gcloud eventarc triggers list --project <project-id>
   # expect a trigger for onhistoricofretelojaintegrada,
   # event type google.cloud.firestore.document.v1.created,
   # filtered to database 'default' + the pedidos/*/historicoFtIni/* document path
   ```

   The index `notificacoesEscritaLojaIntegrada (status, processedAt)` is READY
   (Prerequisites). Then, in the deploy that opens operations (the valve at
   `dry-run`, the read switch on), one Loja Integrada posting produces the
   `[loja-integrada] onHistoricoFreteLojaIntegrada enfileirado` line, a
   `[loja-integrada]` `diff` line from the writes queue, and a `deferred` row in
   `notificacoesEscritaLojaIntegrada` whose `erro` starts with `adiado/dry-run`.

7. **The anchor trigger (master-plan step 9).** The console lists
   `onProdutoLojaIntegradaLinkChanged` as a Firestore trigger on database
   `default`, and the Eventarc trigger carries that filter:

   ```bash
   gcloud eventarc triggers list --project <project-id>
   # expect a trigger for onprodutolojaintegradalinkchanged,
   # event type google.cloud.firestore.document.v1.written,
   # filtered to database 'default' + the produtos/*/produtolojaintegrada/* document path
   ```

   Then prove both arms on ONE test produto created for this check (never a real
   one: a real produto's links and anchor are what the stock sync, the manual
   stock push and the order import read), with no Loja Integrada call involved —
   the trigger makes none.
   ⚠️ **Use a conta id that names NO conta** — an obviously fake one such as
   `conta-teste-ancora`, with no `integracao` doc behind it. The trigger reads no
   conta document, so a real id proves nothing more, and it costs something: by
   now the order import may be running (items 5 and 6), and its link lookup
   matches ANY link with that conta and `id` — this hand-written one included,
   even once it is stored `removido: true`, since the lookup does not read
   `removido`. Under a real conta, an order for a store product with that `id`
   would bind its line to the test produto (deleted at the end of this check), or
   come out `vinculo-ambiguo` beside a migrated link.
   - write one link by hand at
     `produtos/<test-produto>/produtolojaintegrada/<n>` carrying
     `contaLojaIntegrada: 'documents/integracao/<fake-conta-id>'`, a positive
     integer `id`, a `sku` and `removido: false`; the produto's
     `integracoesComProduto` gains `<fake-conta-id>`, and the log shows
     `[loja-integrada] onProdutoLojaIntegradaLinkChanged add` with `escrito: true`;
   - edit only that link's `nome`: NO line follows (the zero-read path);
   - set `removido: true` on it (or delete it): `<fake-conta-id>` leaves the
     array, and the log shows the `check` line with `removido: true`;
   - delete the test link and the test produto.

   The anchor census for the MIGRATED links, `migrate:li-integracoes-com-produto`
   (runbook: `tools/migrations/li-integracoes-com-produto.README.md`), runs after
   this check and before the stock and price valves reach `on`. Its re-run must
   read `GATE li: ausente=0 campo-invalido=0` with `contas-li` and
   `vinculos-que-contam` above 0. A `GATE li: NAO-AVALIADO` line is a stop, never
   a pass. Why the window: the production project exists only then, and the
   imported corpus fired no trigger.

8. **The product import's trigger (master-plan step 9).** The console lists
   `onImportacaoLojaIntegradaCriada` as a Firestore trigger on database
   `default`:

   ```bash
   gcloud eventarc triggers list --project <project-id>
   # expect a trigger for onimportacaolojaintegradacriada,
   # event type google.cloud.firestore.document.v1.created,
   # filtered to database 'default' + the importacoesLojaIntegrada/* document path
   ```

   The indexes `importacoesLojaIntegrada (integracaoId ASC, iniciadoEmMs DESC)`
   and `itens (__name__ ASC)` (collection scope) are READY (Prerequisites). With
   the read switch still UNSET, one import started
   from the web is refused by its route (503, no job). Once the switch is on, the
   first import of a conta is a person's step of the window, never this check:
   a Simular, then its report read, before any `aplicar`.

9. **The import's photos (master-plan step 9, "complete").** Before the first
   `aplicar` run with "completar" and photos, the functions runtime SA holds
   object create AND overwrite on the default bucket (the IAM section's
   "Photos" block):

   ```bash
   gcloud storage buckets get-iam-policy gs://<default-bucket> --project=<project-id>
   # expect serviceAccount:<functions-runtime-sa> under roles/storage.objectUser
   ```

   The bucket named there is the one the deployed functions' `FIREBASE_CONFIG`
   carries (`gcloud storage buckets list` shows the project's default; a
   project created after late 2024 names it `<project-id>.firebasestorage.app`).
   Then the first such run's card does NOT show "fotos indisponíveis", and a
   produto it gave pictures to shows them in the web editor with their
   thumbnails (the `storage` codebase's resize trigger made the derivatives).
   Why the window: the production project and its bucket exist only then, and
   before the switch no import runs.

10. **The stock trigger (master-plan step 12, PR 12-f).** The console lists
    `onEstoqueLojaIntegrada` as a Firestore trigger on database `default`, and
    the Eventarc trigger carries that filter:

    ```bash
    gcloud eventarc triggers list --project <project-id>
    # expect a trigger for onestoquelojaintegrada,
    # event type google.cloud.firestore.document.v1.written,
    # filtered to database 'default' + the produtos/*/estoques/* document path
    ```

    It is this codebase's fifth Firestore trigger: confirm that the Eventarc and
    Firestore service-agent grants serving the other four serve it too. A
    trigger bound to `(default)` deploys fine and never fires, and then no ERP
    stock change reaches the stock queue: only the nightly reconcile sends. With
    the stock valve at `dry-run`, watch the next real stock movement of a linked
    child at its conta's depósito (never hand-edit a real record): it enqueues at
    least one `estoque` task on `filaEstoqueLojaIntegrada` (more for a kit
    component, or a depósito two contas share), whose send run goes no further
    than the read switch while it is off. The whole stock sync is
    `lib/lojaIntegrada/estoque/README.md`.

## The status write-back in the window (master-plan step 7)

Each step below is a window operation a person runs — never an agent — and none
of it can run earlier: before the cutover the legacy app is still the only
writer of these orders, and a write from here would be a second one.

1. **Order.** The index `notificacoesEscritaLojaIntegrada (status, processedAt)`
   READY → this codebase deployed (the writes queue, the history trigger, the
   varredura timer) with the IAM grants above for the NEW queue → the `apps/web`
   build carrying the `lojaIntegradaRastreioDivergente` copy live → only then
   may the valve reach `on`.
2. **`dry-run` in the deploy that opens operations.** Set
   `LOJA_INTEGRADA_MODO_RASTREIO=dry-run` in this codebase's `.env.deploy` in the
   SAME deploy that sets the read switch, so no posting after the legacy app is
   switched off goes unrecorded. `off` records NOTHING: a posting made under
   `off` is never written back and needs a hand fix in the Loja Integrada panel.
   `dry-run` is the brake: it keeps every event and replays it once the valve is
   `on`. It is also where the valve is HELD while any check under "Verifying a
   first deploy" fails — never `off`.
3. **The deadline.** An event not written (dry-run, outside the canary list, `on`
   with no list) is deferred and replayed once a day for at most 7 passes, so the
   list must reach exactly `*` by the day of the first dry-run event plus 6.
4. **The canary.** Set `LOJA_INTEGRADA_CANARIO_RASTREIO=<contaId>:<numero>,…` with
   real orders only (one about to be posted, and two or three already in
   transit), set the valve `on`, and redeploy. Check the first tracking-code
   write and the first delivery write in the logs (`restauracao`, `escrita`,
   `conferencia-historico`, no 3xx, no 401/403) and in the order's status
   history in the panel (exactly one row per change); then set the list to
   exactly `*` and redeploy. A failed check means: do not widen; keep the list or
   go back to `dry-run`, and fix first.
5. **After `*`.** Count the `parked` rows of `notificacoesEscritaLojaIntegrada`
   whose `erro` starts with `adiado/` (events older than the 7-pass horizon) and
   the window's `superado` lines (events resolved without a write because the
   pedido had moved on), and correct those orders in the panel by hand. Keep
   that parked-row count as a weekly operator check afterwards.
6. **Operators, during the dry-run and canary days:** Loja Integrada shows no
   "Pedido enviado" for new postings and buyers get no e-mail; it catches up by
   itself within about a day of `*`. An urgent order may be typed into the panel
   with EXACTLY the code the ERP holds — the replay then sees it as equal and
   skips it; a differently typed code is never overwritten and raises the aviso.

## Runbook: a conta whose window is too large to drain

The poller reads at most `meta.limit` × 20 changed orders per window, and it
refuses a larger one on its first page (`janela-grande-demais`, a `critico`
aviso at once) rather than advance past orders it never read. It happens after a
conta was inactive or parked for weeks (about 20 days at a limit of 20, 50 at a
limit of 50, at the planned volume). There is no saved continuation (step-3 plan
Q6). To re-bootstrap the conta from `LOJA_INTEGRADA_POLL_LOOKBACK_H`:

1. Choose the LARGEST look-back whose window stays under the cap: the window
   runs from now − look-back − 4 h 02 min (the overlap) to now, and it may hold
   at most `meta.limit` × 20 changed orders. It necessarily does NOT cover the
   whole gap: a look-back reaching back to the old cursor contains the very
   window that was refused, and is refused again. Set it in `.env.deploy` and
   redeploy if it changes.
2. Write down the stored `cursor`. Orders changed between it and the new bound
   (now − look-back) are never read by the poller: list them in the Loja
   Integrada panel and check each against the ERP by hand.
3. In the console, on `pollPedidosLojaIntegrada/<integracaoId>`, DELETE the
   `cursor` field (the field's delete action; never type a value: the text
   `null` is not the null type, and a document that no longer parses stops this
   conta's poll with a `documento-invalido` WARNING, and no aviso, until it is
   fixed). Do it while no run holds the lease, i.e. `emExecucaoAteMs` is `0` or
   in the past: a run in progress would re-derive its own cursor over the edit.
   Leave every other field as it is.
4. The next tick anchors a fresh cursor at now − look-back and drains it. The
   stored `falhasSeguidas` is what makes that first clean run resolve the aviso,
   which is why the FIELD is deleted and not the document: a deleted document
   comes back with a count of 0, and a clean run with a count of 0 makes no
   aviso call, so the open aviso would stay open.

If even a short look-back is refused again, the platform is not applying the
date filter (its `total_count` is then the store's whole history): this runbook
cannot clear that, so stop and escalate. The same holds for a
`filtro-ignorado` aviso.
