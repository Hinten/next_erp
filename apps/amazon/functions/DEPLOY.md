# Deploying the Amazon Cloud Functions (codebase `amazon`)

These functions are a **deploy-artifact sub-build** of `@delfrance/amazon-app` —
not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. `firebase.amazon.deploy.json` points `source` at the generated
`.deploy/amazon-functions`. Mirrors `apps/loja-integrada/functions`.

> Deploy is **manual and coordinated** — agents never run `firebase deploy` (root
> `CLAUDE.md`, Critical rules) — and never let a stray `firebase deploy` push
> rules. No config in this channel declares a `firestore`/`storage` block, so
> none of them can.

## ⚠️ Not deployed anywhere; it ships INERT

`firebase.amazon.deploy.json` is a config file, and a config file deploys
nothing. Nobody has run this codebase against any project. The deploy is a
**migration-window** step (window item W9; root `CLAUDE.md` rule 8, ADR 0013):
the production data has not moved, the legacy integration is still the sole
writer of the real orders, and nothing here may read or write them first.

ONE switch keeps it harmless even if it were deployed early, and it stays exactly
as it is until the window:

- **The read switch `AMAZON_CHAMADAS` stays UNSET.** Only the exact `on` lets this
  code call Amazon at all (D11); the intake task and the reprocess sweep defer
  before any Firestore read, the backstop poll stops before any Firestore
  operation (so no poll document, and no bootstrap anchor, exists before the
  window), and the context loader refuses before it builds a client.

⚠️ **The importer seam is FILLED (master-plan step 5, PR 5-e).** Until step 5 an
empty seam was a second switch: a run past the read switch deferred as
`importador-ausente` and every poll tick stopped at its importer gate. That gate
is now permanently open. **The order import is LIVE the moment this codebase is
deployed AND `AMAZON_CHAMADAS=on`**: every push and poll task then re-fetches its
order (`getOrder`) and writes `pedidos/{digest}`, its pagamento, the cliente and
its endereço, the pedido's incidentes and its avisos, and the stock sync reserves
and releases from there. So, in the window, in this order:

1. **W4: the legacy integration's order poll is PAUSED** before anything else:
   from the first imported order on, this importer is the only writer of Amazon
   pedidos, and two writers of one order are a race neither side guards.
2. **W9: the deploy**, with every prerequisite below (the `prodAmazon` index
   READY first).
3. **W5: the read switch**, on both surfaces, by a person (the env bakes at
   deploy: a functions redeploy as well as the App Hosting rollout).

⚠️ **The expiry sweep stands outside the switch.** `sweepAmazonExpirations`
makes no Amazon call, so the read switch does not gate its conta passes: deployed
into a project, it raises and resolves the per-conta reauthorization and
reconnection avisos of that project's Amazon contas (only its LWA client secret
pass waits for the switch).

⚠️ **The conta trigger stands outside the switch.** `onIntegracaoAmazonChanged`
(master-plan step 20) makes no Amazon call, so the read switch does not gate it,
and it imports no importer. Deployed into a
project, it writes that project's `int_frete` on every Amazon conta save that
moves a mirrored field: create, patch or deactivate. That is why this deploy
waits for the window's `int_frete` adoption pass (Prerequisites below).

⚠️ **The NF-e trigger stands outside the switch too** (master-plan step 14).
`onNfeAprovadaAmazon` makes no Amazon call, so the read switch does not gate it:
deployed into a project, it fires on EVERY `pedidos/{pedidoId}/nfev4/{nfeId}`
write of that project and, for an approved SALE NF-e of a pedido it can PROVE
is an Amazon order (the id recomputes from the stored conta and order number),
enqueues ONE task onto `processAmazonNfeUpload`; an approved one cancelled while
the order lives raises the aviso `nfe-cancelada`. The task itself then stops
before any Amazon call while either switch below is off, and says so with an
`nfeUploadRejeitado` aviso on the pedido (`envio-nao-ligado` at the valve,
`chamadas-desligadas` at the read switch) — rows that ARE the re-drive worklist
once the switches are on (each pedido goes back through the App Hosting route
`POST /api/marketplace/amazon/enviar-nfe` with `{ pedidoId }`, `PERM.pedido.write`;
it only enqueues). `pedidoId` is the aviso row's `entidade` (the pedido document id,
the one in the pedido page's URL), never its `params.pedido` (the Amazon order
number, which the route answers 400). ⚠️ **Re-drive each pedido ONCE, after a 500
too.** A re-drive writes nothing, so it does not clear the aviso row (the row
changes only at the task's next outcome), and Amazon's invoice status lags a
submit by up to ~3 minutes: a second re-drive of the same pedido inside that lag
will most likely submit the NF-e again. Wait at least ~5 minutes, or until the
aviso changes or resolves, before re-driving the same pedido. ⚠️ **A SECOND switch gates every NF-e submit:** the
NF-e write valve `AMAZON_MODO_NFE` (exactly `on`) and its canary list
`AMAZON_CANARIO_NFE` (a `<contaId>:<orderId>` entry, or exactly `*`). Both stay
UNSET until W8 (below); `dry-run` reads Amazon's invoice status and logs what it
WOULD send, never sending it.

⚠️ **The Easy Ship scheduling queue has its own switch too** (master-plan step 15).
`processAmazonEasyShipSchedule` books a Delivery-by-Amazon order's pickup — ONE
`createScheduledPackageBulk`, after minting a Restricted Data Token — once Amazon
has accepted the order's NF-e. Two entries feed it, neither calling Amazon: the
NF-e task when Amazon accepts the invoice, and the order import whenever it reads
an order ready to schedule. The task reads the scheduling write valve
`AMAZON_MODO_AGENDAMENTO` FIRST and, while it is not `on` or `dry-run`, ends with
ZERO Firestore reads and no Amazon call; `dry-run` (or `on` outside the canary
list `AMAZON_CANARIO_AGENDAMENTO`) reads the live order and never mints a token
or sends the bulk; and every Amazon call still needs the read switch. Both names
stay UNSET until W8. See "Easy Ship scheduling (step 15)" below.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/amazon/node_modules`).
- **`AMAZON_LWA_CLIENT_SECRET` exists in the project's Secret Manager** (window
  item W1, before this deploy). `filaLeituraAmazon`,
  `reprocessAmazonNotifications`, `pollAmazonOrders`, (step 14)
  `processAmazonNfeUpload` and (step 15) `processAmazonEasyShipSchedule` declare
  it as `secrets:`, and **a declared secret that is missing fails the WHOLE
  deploy**, every function of the codebase included.
  `sweepAmazonExpirations`, `onIntegracaoAmazonChanged` and `onNfeAprovadaAmazon`
  declare none: none of them calls Amazon.
- **Region match: `FUNCTIONS_REGION` equals `AMAZON_TASKS_REGION`.** Each queue
  (`filaLeituraAmazon`, since step 14 `processAmazonNfeUpload`, and since step 15
  `processAmazonEasyShipSchedule`) is created
  WITH its function, by this deploy, in `FUNCTIONS_REGION` and nowhere else.
  Every enqueuer resolves its queue from `AMAZON_TASKS_REGION`, falling back to
  `FUNCTIONS_REGION`, with **no default**: the App Hosting receiver
  (`apps/amazon/lib/firebase/filaLeitura.ts`) answers 503 without one, the App
  Hosting NF-e re-drive route (same root) checks it before any read and answers
  500 with one ERROR line naming `AMAZON_TASKS_REGION` (so a smoke check with any
  pedido, even a nonexistent one, shows it), and the three functions roots
  (`src/agendador.ts`, the step-4 poll's; `src/agendadorNfe.ts`, the NF-e
  trigger's and the NF-e task's own re-enqueues; `src/agendadorAgendamento.ts`,
  the scheduling queue's two entries and its own re-enqueues) throw on the
  enqueue (a scheduling entry then logs one WARNING `agendamento-nao-enfileirado`
  naming `MissingRegionError`).
  A mismatch is the #1108 failure: the task targets a queue that does not exist
  and is **silently dropped** while the caller sees success. Set the App
  Hosting backend's `AMAZON_TASKS_REGION` (console) to exactly the
  `FUNCTIONS_REGION` this deploy exports; the preflight prints that reminder.
- **The database is the NAMED `default`**, never the `(default)` sentinel, which
  fails every operation with `5 NOT_FOUND`. The conta trigger
  `onIntegracaoAmazonChanged` listens on `integracao/{integracaoId}` and the NF-e
  trigger `onNfeAprovadaAmazon` on `pedidos/{pedidoId}/nfev4/{nfeId}`, both in
  that database: a trigger bound to `(default)` deploys fine and never fires, and
  only `src/index.test.ts`'s offline pin guards it (the emulator serves any
  database).
  `build.mjs` inlines `FIREBASE_DATABASE_ID` (unset or blank → `default`) and the
  preflight prints the value it baked; leave it unset in the BUILD environment
  (the deploy shell and the repo-root `.env.functions`), or set it to exactly
  `default`. The define replaces every read of the variable in the bundle,
  `getDb()`'s included, so the trigger's binding and every function's handle use
  that build-time value and a runtime override reaches neither.
- **The index `notificacoesAmazon (status ASC, processedAt ASC)` READY** before
  the first sweep tick: on Enterprise a missing index does not fail, it
  full-scans and bills the scan (root `CLAUDE.md` rule 1).
- **The collection-group index `prodAmazon (contaAmazonOuterRef ASC, sku ASC)`
  READY before `functions:amazon`** (master-plan step 5; window item W9, deploy
  order indexes → rules → functions → App Hosting → web). Every imported line
  resolves its produto through that query (the conta's link docs by SKU, no SKU
  fallback): without the index each line full-scans every `prodAmazon` link doc
  of every produto, billed, and still answers.
- **Before `functions:amazon` (step 20), in this order:**
  1. the index
     `int_frete (tipo, contaAmazonContaFreteAmazonOuterRef, ativo, dataCadastro DESC)`
     is READY;
  2. the window's `int_frete` adoption pass (W12, the script
     `migrate:amazon-int-frete` in `@delfrance/migrations`; runbook
     [`tools/migrations/amazon-int-frete.README.md`](../../../tools/migrations/amazon-int-frete.README.md))
     ran clean: report-only, dry run, `--apply`, then a second dry run with
     **0 contas com escrita planejada** and no `duplicados`, `nao-canonico` or
     `compartilhado`. A `duplicados` STOP is resolved by a person, as that
     runbook says — deactivating a twin alone does not clear it.

  Why: the trigger reconciles through a lookup that rides that index (without
  it, every reconcile full-scans `int_frete`, billed), and it has no tolerant
  scan. An import fires no trigger, so before the pass a conta save could create
  `amz-<integracaoId>` beside a migrated doc whose back-ref is not canonical; the
  pass STOPs on exactly that.

- **Step 14's order (W9): `functions:amazon` BEFORE the `apps/amazon` App
  Hosting rollout.** This deploy auto-provisions the NF-e queue
  `processAmazonNfeUpload` and the trigger `onNfeAprovadaAmazon`; the App Hosting
  re-drive route (`POST /api/marketplace/amazon/enviar-nfe`, PR 14-d) only
  enqueues onto that queue, so it must exist first. And at the freeze (W4), the
  legacy integration's NF-e upload AND its pickup-scheduling queue are PAUSED
  before this codebase can submit anything: two writers submitting to one order
  is a race neither side guards.
- **One-time IAM** (below) — required before the first enqueue. The queue-level
  grants can only be made once the deploy has created the queue, and with
  `TASKS_INVOKER_SA` set the deploy makes two of them itself; the act-as grant is
  always manual.

## Deploy

> ⚠️ **A person runs this, in a coordinated window** — never an agent, never
> unannounced (root `CLAUDE.md` rule 8). Export `TASKS_INVOKER_SA` and
> `FUNCTIONS_REGION` first (both below); the preflight refuses the deploy
> without them.
>
> ⚠️ **Into a project that does not hold this queue yet** — which is every
> project until the window — read **the first deploy of a NEW queue crashes on
> the enqueuer binding** under the IAM section below FIRST.

```bash
# from the repo root
firebase deploy --only functions:amazon \
  --config firebase.amazon.deploy.json \
  --project <project-id>
```

⚠️ **Read the whole filename.** `firebase.amazon.deploy.json` is the only config
that deploys. The emulator config of the CI lane (`firebase.amazon.tasks.json`,
step 3, PR 3-e) sits one dot apart and declares no rules or indexes path on
purpose, so a stray deploy against it can push nothing.

The `predeploy` hook runs `node tools/deploy-env/preflight.mjs amazon` and then
`node apps/amazon/functions/scripts/prepare-deploy.mjs`. To inspect the bundle
locally without deploying: `node apps/amazon/functions/build.mjs` (writes
`dist/index.js`), or
`FUNCTIONS_REGION=<region> node apps/amazon/functions/scripts/prepare-deploy.mjs`
for the full servable folder at `.deploy/amazon-functions`. Both need
`FUNCTIONS_REGION` set — `requireBuildRegion` throws without it, on purpose. Both
are local builds; neither deploys anything.

## Functions in this codebase

- **`filaLeituraAmazon`** — `onTaskDispatched` (Cloud Tasks queue). The ONE reads queue of
  the channel (order intake now; step 9's link job later). The body dispatches on the task's
  `tipo`: `pedido` runs one notification through the pipeline (read switch, routing by seller,
  context, importer seam), any other `tipo` is logged and dropped.
  `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 0.5 }`, `retryConfig` 3
  attempts with 10 s → 300 s backoff and up to three doublings, `timeoutSeconds 120`,
  `secrets: AMAZON_LWA_CLIENT_SECRET`. Persists to `notificacoesAmazon` only on
  retry-exhaustion, park or defer. Enqueued by the App Hosting push receiver and by the
  backstop poll (`pollAmazonOrders`, below).
- **`reprocessAmazonNotifications`** — `onSchedule('10,40 * * * *')`. The backstop, draining
  BOTH lanes on one tick (`limit 10` each): `failed` notifications older than the hot window,
  then the deferred lane (the read switch off, an unknown seller, a parked or inactive conta, a
  missing credential, a null importer seam). It runs the order import INLINE (beside the
  queue, not through it), so its 540-s timeout bounds how long an import can hold a read:
  the import's 15-minute recent-cancel window must stay above it (`src/index.test.ts` pins
  the arithmetic against this endpoint and the queue's). Logged separately — summing them would hide a
  growing deferred backlog inside a healthy `processed`. `America/Sao_Paulo`,
  `timeoutSeconds 540`, `secrets: AMAZON_LWA_CLIENT_SECRET`.
- **`sweepAmazonExpirations`** — `onSchedule('15 7 * * *')`. The DAILY expiry sweep (the step-2
  body): raises the reauthorization and reconnection avisos at the 30-day horizon and resolves
  them once a new grant lands, closes the orphaned rows of contas that no longer exist, and —
  only while `AMAZON_CHAMADAS=on` — warns about the app's LWA client secret from
  `AMAZON_LWA_SEGREDO_EXPIRA_EM`. Reads only the stored credential — **no Amazon call**, so
  **no `secrets:`**. `America/Sao_Paulo`, `timeoutSeconds 120`. Its orphan pass also closes a
  deleted conta's open `amazonImportacaoParada` row (clocked by the conta list's read time, so
  a conta created after that read keeps its row).
- **`pollAmazonOrders`** — `onSchedule('7,22,37,52 * * * *')`. The 15-minute BACKSTOP POLL
  (master plan step 4): per active, connected conta, `searchOrders` from the conta's durable
  cursor in `pollPedidosAmazon/{contaId}` (at most 5 pages a run), and ONE synthetic
  `origem: 'poll'` notification per changed order onto `filaLeituraAmazon` (ids only; the
  task re-fetches the order). Runs inline in its own schedule, so sweep-only mode
  (`AMAZON_TASKS_DISABLED=1`) persists each notification `failed` for the reprocess sweep
  instead. One gate with ZERO Firestore operations: the read switch (the importer-seam gate
  in the code is permanently open since step 5). Raises `amazonImportacaoParada` on a counted failure at its threshold
  and resolves it on the next clean run. `America/Sao_Paulo`, `timeoutSeconds 300` (above
  the 240-s tick budget, below the 360-s lease, itself below the 15-minute interval),
  `retryCount 0`, `secrets: AMAZON_LWA_CLIENT_SECRET`. ⚠️ It is the queue's SECOND enqueuer:
  the functions runtime SA needs the same three IAM grants as the receiver's (below).
- **`onIntegracaoAmazonChanged`** — `onDocumentWritten` (Firestore) on
  `integracao/{integracaoId}`, master-plan step 20: the codebase's FIRST Firestore trigger,
  and the FOURTH on that path (Mercado Livre, Shopee, Loja Integrada; plus `apps/functions`'
  `onIntegracaoDeleted` on deletes). Keeps each Amazon conta's `int_frete` doc (tipo `amz`)
  in step with the conta through the shared core `@delfrance/data/admin/frete`: adopt the
  migrated doc by `contaAmazonContaFreteAmazonOuterRef`, else create `amz-<integracaoId>`;
  patch only the mirrored fields that moved (`nome`, `ativo`, the filial, `dataCadastro`);
  deactivate, never delete, once the conta is gone or no longer Amazon. State-driven: the
  core re-reads the conta itself, so a replayed or out-of-order delivery cannot roll anything
  back. EVERY channel's conta write reaches it, and it returns with ZERO reads unless the conta
  is, or was, Amazon and the write moved a mirrored field (or the tipo, or created or deleted
  the conta). One `evento: 'int-frete'` line per reconcile: the conta id and the action with
  field names, never a value. `database` **`default`**, `retry: true`, **no secrets**, no
  `invoker`, no Amazon call, no per-function `region:`. ⚠️ Outside both INERT switches
  (above).

- **`processAmazonNfeUpload`** — `onTaskDispatched` (Cloud Tasks queue), master-plan step
  14: the NF-e upload of a Delivery-by-Amazon order, one dispatch per step of an upload
  (`lib/amazon/nfe/processarNfe.ts`, P0–P12): the NF-e valve read and logged first; the
  `nfev4` document through the LEVEL predicate; the pedido's ownership proof and emission
  block; the sale gate; the sibling NF-e of the pedido; in fase `envio` the valve's target
  (`off` ⇒ aviso `envio-nao-ligado`, no Amazon read); the context (the read switch first);
  the LIVE order (`getOrder`, on every dispatch, floored by the stored watermark); then
  Amazon's invoice status FIRST and — under `on` and in the canary — at most ONE
  `submitInvoice` of the stored proc, followed by an UNNAMED verification chain
  (`scheduleDelaySeconds` 60 s … 8 h, ten rungs, at most one automatic resubmit). Amazon's
  acceptance clears step 14's own freight stamp; a refusal of THIS NF-e raises the aviso
  and stamps `freteInicial.estado = error`. `rateLimits { maxConcurrentDispatches: 1,
maxDispatchesPerSecond: 1 }` — ⚠️ concurrency 1 is the ORDERING GUARD of one order's own
  writes (the stamp, the clear, the avisos); never raise it without an event-clock
  watermark first. `retryConfig` 4 attempts (`TENTATIVAS_NFE_AMAZON`), 10 s → 300 s,
  three doublings; `timeoutSeconds 300` (the 220-s worst-case Amazon budget of one
  dispatch, pinned in `src/index.test.ts`); `secrets: AMAZON_LWA_CLIENT_SECRET`. Enqueued
  by the trigger below and by ITSELF (both the functions runtime SA), and by the App
  Hosting re-drive route `POST /api/marketplace/amazon/enviar-nfe` (PR 14-d; UNNAMED, the
  App Hosting runtime SA).
- **`processAmazonEasyShipSchedule`** — `onTaskDispatched` (Cloud Tasks queue),
  master-plan step 15: the Easy Ship pickup of a Delivery-by-Amazon order, one
  dispatch per observation (`lib/amazon/agendamento/processarAgendamento.ts`,
  A0–A9): the payload proved against its pedido id; the scheduling valve read and
  logged FIRST (`off` ⇒ ZERO Firestore reads); the stored pedido (ownership, a
  cancelled or blocked sale, goods out) and ONE listing of its `nfev4` documents
  (an ambiguous or cancelled NF-e refuses); the context (the read switch first);
  the LIVE order (`getOrder`, floored by the stored watermark) through the order
  import's own freight fold — only an order whose ORDER-level invoice status is
  exactly `ACCEPTED` and whose packages still wait to be scheduled is scheduled;
  then — under `on` and in the canary — the token mint and ONE bulk. It writes
  avisos only, never a pedido field: the order import mirrors the schedule at the
  order's next read. `rateLimits { maxConcurrentDispatches: 1,
maxDispatchesPerSecond: 1 }` — concurrency 1 orders this queue's avisos and
  serialises one order's automatic schedules. `retryConfig` 4 attempts
  (`TENTATIVAS_AGENDAMENTO_AMAZON`), ⚠️ **60 s** → 300 s, three doublings (a cut
  bulk may still be running at Amazon: never retry sooner); `timeoutSeconds 300`
  (the 220-s worst case, pinned in `src/index.test.ts`);
  `secrets: AMAZON_LWA_CLIENT_SECRET`. Enqueued, all as the functions runtime SA,
  by the NF-e task (E1), the order import (E2) and ITSELF.
- **`onNfeAprovadaAmazon`** — `onDocumentWritten` (Firestore) on
  `pedidos/{pedidoId}/nfev4/{nfeId}`, master-plan step 14: the FOURTH function on that path
  (Mercado Livre's and Shopee's NF-e triggers, `apps/functions`' `onNfeDeleted`), so EVERY
  `nfev4` write of the project fires it; outside its two EDGES it reads nothing and logs
  nothing. The upload edge (a document becoming approved, with a proc, in produção): a
  legible non-sale note is one INFO line; then ONE pedido read; another channel's pedido,
  an emission block or stored evidence that the order is NOT Delivery by Amazon end in one
  line; otherwise ONE task, NAMED after the CloudEvent (`sha256(event.id)`), so an Eventarc
  redelivery enqueues nothing new. The a→c edge (an approved sale NF-e cancelled at SEFAZ):
  the aviso `nfe-cancelada` on a live pedido — nothing can be sent to Amazon, the Delivery
  API has no cancel — and nothing on a stored cancelled sale (the incidente path's).
  `AMAZON_TASKS_DISABLED=1` makes it raise `tarefas-desligadas` instead of enqueuing.
  `database` **`default`**, `retry: true`, **no secrets**, no `invoker`, no Amazon call, no
  per-function `region:`. ⚠️ Outside the read switch (above).

⚠️ **The export name IS the queue name.** Firebase binds one function per queue
and names the queue after the function, so renaming `filaLeituraAmazon`,
`processAmazonNfeUpload` or `processAmazonEasyShipSchedule` creates a NEW queue
and strands whatever the old one held. Each name is fixed at its first deploy.
`src/index.ts` carries a rename-safety assertion per queue, tying the export key
to the constant every enqueuer targets (`FILA_LEITURA_AMAZON`, `FILA_NFE_AMAZON`,
`FILA_AGENDAMENTO_AMAZON`).

⚠️ **One logger.** Every line is one JSON line on stdout through
`LOGGER_STDOUT_AMAZON` (`severity` + `message`): one `evento: 'tarefa'` line per
dispatch, one `evento: 'varredura'` line per sweep lane (and one per expiry
run), per poll tick one `evento: 'poll'` line per conta run plus ONE summary
line (`[amazon] poll de pedidos`, the counters flattened), and one
`evento: 'int-frete'` line per conta-trigger reconcile (WARNING on
`incompleto`). The order import (step 5) adds `evento: 'pedido'` lines (one
closed code each, the order id and counts) and its `getOrder` call lines, and the
dispatch line carries the import's report: `acao`, `itens` and the counts
`linhasPreservadas`, `linhasDivergentes`, `linhasSemProduto` (null on every arm
without one). The NF-e upload (step 14) writes `evento: 'nfe'` lines: one per
trigger fire on an edge, the write engine's dry-run diff (`acao: enviaria`,
`statusAmazon`), and ONE dispatch line per NF-e task run (`fila:
processAmazonNfeUpload`, `acao`, the closed `motivo`, `statusAmazon`, `envio`,
Amazon's error codes through the closed set) — never the XML, its base64, its
digest or the access key. The Easy Ship scheduling (step 15) writes
`evento: 'agendamento'` lines: an entry's WARNING when it could not enqueue (or
its INFO when that observation was already enqueued), the write engine's dry-run
diff, and ONE dispatch line per scheduling task run (`fila:
processAmazonEasyShipSchedule`, `acao`, the closed `motivo`, `origem`, the live
`decisao`, the rejection code through its grammar, the package count) — never the
label's pre-signed link, the Restricted Data Token, a tracking, package or slot
id, or Amazon's text (the SP-API call lines are the ordinary ones, whose excerpt
keeps Amazon-made package and tracking ids by design). No line carries a seller id, a token, a buyer datum, a price or an
error message; a failed sweep row is named by its document id only (the row
holds the reason).
⚠️ Two declared exceptions, both from `packages/data`, both on stderr outside
`LOGGER_STDOUT_AMAZON`: on `incompleto` the `int_frete` core writes its own
unstructured
`console.warn('[amazon] conta Amazon sem dados suficientes para criar o int_frete', …)`
(the conta id and field names only); and a shared collection handle's soft read
writes `[data] schema mismatch on <path>` plus the Zod issue list when a stored
document fails its schema (the order import meets it on the cliente resolver's
reads of legacy `clientes/<id>`).

### What to alert on, and what to watch at W7 (the order import, step 5)

Alert on (each means an order is NOT being imported and nothing will fix it by
itself):

- **ERROR: the runtime's own "Unhandled error" line naming
  `AmazonPedidoEmConflitoError`** (every one of the import batch's three attempts
  lost a precondition: persistent contention on one pedido). The queue retries it;
  after its last attempt the dispatch line says `resultado: failed` (WARNING) and
  the reprocess sweep re-drives the row, parking it at 5. Repeats for the same
  order mean a second writer keeps moving that pedido.
- **WARNING dispatch line `resultado: parked`** whose row (`notificacoesAmazon`)
  says `erro: recusa-deterministica/PedidoAmazonIlegivelError`: Amazon answered an
  order no key can be built from (another order id than the one asked for, a
  `lastUpdatedTime` without an offset, two lines with one `orderItemId`). It parks
  on the first attempt (a retry reads the same body), so a person must look.

- **(step 14) WARNING NF-e dispatch line `motivo: pos-envio-falhou`**: a write
  AFTER a submit was lost (`escritaPerdida`: the aviso, the stamp, the
  verification enqueue …; `erro`: its class). The task never throws there (a
  retry would resubmit inside Amazon's read-after-write lag), so this line is the
  only trace; when the lost write was the verification enqueue, the aviso
  `aceite-nao-confirmado` / `envio-nao-confirmado` was raised if it could be, and
  when it was the pause after a 429 on the submit (not processed: the NF-e is
  not at Amazon), `amazon-indisponivel` (`tarefas-desligadas` for the valve). A
  chain step lost BEFORE any submit is never thrown away either: the queue valve
  answers `tarefas-desligadas` on any attempt, and any other loss is retried by
  the queue and answered with an aviso on its last attempt.

- **(step 15) ERROR scheduling dispatch line `motivo: sem-permissao`**: a second
  401/403 on the token mint or the bulk after the forced refresh — the app's
  grant for Easy Ship is missing (app-wide, so no per-pedido aviso is raised).
  Every order then waits for its label print, which fails the same way: fix the
  grant.
- **(step 15) ERROR `motivo: leitura-falhou` / `escrita-falhou`** (`falha` names
  the read-side token): a definite failure of `getOrder`, of the token mint or of
  an LWA exchange — never Amazon refusing the order, so no aviso. The order's next
  label print (at the checkout, or a reprint from the order list) re-reads and
  schedules.
- **(step 15) WARNING `motivo: agendamento-nao-reenfileirado`,
  `aceite-nao-espelhado`, `amazon-indisponivel`, `taxa-limitada` or
  `resposta-sem-pedido`**: the automatic chain ENDED without a schedule (a lost
  re-enqueue, the order-level acceptance never mirrored in ~43 minutes, an outage
  on the last attempt, Amazon still throttling after the five-step pause ladder,
  an answer naming neither our schedule nor our refusal). Log-only by design: the
  order's next label print schedules it.

Watch in the first hours after W5 (W7: the look-back re-lists migrated, in-flight
orders through the importer):

- **WARNING dispatch lines `itens: divergencia-itens-aprovado`** (`linhasDivergentes`
  counts the lines): D17 BLOCKED an approved, unshipped order whose lines or money
  differ from the stored pedido (estado at our `[amazon]` error, a crítico aviso
  raised). A flood here means the migrated pedidos disagree with Amazon on a price
  or a line shape: switch `AMAZON_CHAMADAS` off and look before it goes back on.
- **WARNING `evento: 'pedido'` lines `codigo: leitura-defasada-aceita`**: a sweep
  re-drive imported a `getOrder` read older than the search the poll enqueued it
  from (that the two endpoints render one order's clock identically is a
  capture-dependent default, still to be validated before the window).
- **WARNING `evento: 'pedido'` lines `codigo: cancelamento-recente`** (with
  `idadeS`): a first-seen order cancelled or reversed less than 15 minutes ago;
  the import waits (a retryable throw, the queue's backoff, then a sweep
  re-drive) and then skips it. A steady stream of them for the SAME order past 15
  minutes is a clock problem, not a race.

### Durability & the residual loss window

A notification is durable once it is either (a) processed, or (b) persisted as
`failed`/`deferred` for the sweep. Two narrow windows remain:

- The task handler persists a `failed` document only on its **final** attempt. If
  Firestore is unavailable for that whole retry window (a _correlated_ outage —
  the same Firestore the handler reads and writes), the final persist also
  fails and the notification is lost to the push path. The step-4 backstop poll
  meets the order again on its next tick. Alert on the queue's failed final
  attempts.
- A **deferred** notification is re-driven daily for at most 7 passes, then
  parked. The poll re-lists every order changed while a conta was parked once
  it is reconnected, so a parked push row loses nothing the poll cannot recover.

## Runtime env

None of these is a secret. They are read at runtime by **this nested codebase**;
the ones marked "both surfaces" are read by the App Hosting backend too and must
be set ALIKE in its console. The root `.env.example` names them all, so the one
file operators consult lists every variable the channel reads.

firebase-tools' documented lane for gen2 runtime env vars is a `.env` /
`.env.<project-id>` file in the functions **source** directory. Here that
directory is the generated `.deploy/amazon-functions`, and
`scripts/prepare-deploy.mjs` opens with
`rmSync(deployDir, { recursive: true, force: true })` — it **wipes and
regenerates the whole folder** as the `predeploy` hook, so a hand-placed `.env`
**there** does not survive.

Instead, put it in the **package** directory and let the hook carry it across
the wipe. Create `apps/amazon/functions/.env.deploy` (gitignored). **Every line
below stays COMMENTED OUT until the window:**

```bash
# The READ SWITCH (both surfaces). Only the exact `on` lets this code call Amazon
# at all; anything else (blank, unset, `ON`, ` on`, `true`) means NO call.
# ⚠️ Leave it COMMENTED OUT. Setting it is a migration-window decision (W5),
# made by a person after the legacy integration stops polling (W4). ⚠️ The
# functions env BAKES AT DEPLOY: flipping it takes a functions REDEPLOY as well
# as the App Hosting rollout, or the task, the sweeps and the poll stay switched
# off. ⚠️ Once it is on, the backstop poll is the FIRST intake as soon as OAuth
# stores a conta's credential, so the legacy order poll must be paused first (W4).
# AMAZON_CHAMADAS=on

# The LWA client id (both surfaces): the pair the context loader reads for a
# refresh. The client SECRET is NOT here — it is a Secret Manager binding.
# AMAZON_LWA_CLIENT_ID=

# The region of EVERY queue — the reads queue, (step 14) the NF-e queue
# `processAmazonNfeUpload` and (step 15) the scheduling queue
# `processAmazonEasyShipSchedule` (both surfaces). LEAVE IT UNSET here: blank or
# unset = the FUNCTIONS_REGION inlined into the bundle (a blank value counts as
# unset, #1108). If you set it at all, set it to exactly the FUNCTIONS_REGION the
# deploying shell exported — any other value names a queue that does not exist.
# AMAZON_TASKS_REGION=

# The queue valve (both surfaces). Exactly `1` makes every enqueue throw. For
# the READS queue that is sweep-only mode: each notification is persisted
# `failed` and the 30-minute reprocess sweep drains it (never a silent drop).
# ⚠️ Since step 14 it ALSO stops every NF-e upload, and there is NO NF-e sweep:
# the trigger raises the aviso `tarefas-desligadas` on the pedido instead (and
# so does a queued NF-e task whose next chain step it refuses before that task
# submits), and that aviso list IS the re-drive worklist (the App Hosting route
# POST /api/marketplace/amazon/enviar-nfe, body { pedidoId } = the aviso row's
# `entidade`, never its `params.pedido`). Re-drive each pedido ONCE, even after
# a 500: the route does not clear the row, and a second re-drive inside Amazon's
# ~3-minute status lag most likely submits the NF-e again — wait ~5 minutes, or
# for the aviso to change. This copy stops THIS codebase's producers (the
# trigger, the task's re-enqueues); the App Hosting copy stops only that
# backend's (the receiver, the re-drive). ⚠️ Since step 15 it ALSO stops every
# Easy Ship scheduling enqueue of this codebase (the acceptance entry, the
# import entry, the scheduling task's own re-enqueues), with NO sweep behind it:
# each logs one WARNING (`agendamento-nao-enfileirado` / `-nao-reenfileirado`)
# and that order's pickup is booked at its next label print instead (the label
# route enqueues nothing, so this variable never stops it). Strict `=== '1'`:
# unset, blank, `true` and `1 ` all leave enqueuing ON. Use it before the queue
# IAM is granted.
# AMAZON_TASKS_DISABLED=1

# The LWA client secret's expiry date, exact YYYY-MM-DD, read by the expiry sweep
# only while the read switch is on. Unset or invalid raises the aviso WITHOUT a
# date (an unknown deadline is the riskier state).
# AMAZON_LWA_SEGREDO_EXPIRA_EM=

# The backstop poll's LOOK-BACK, in HOURS (functions only: App Hosting reads it
# nowhere). It is read ONLY when a conta's poll document has no cursor — the
# conta's first tick, or a re-bootstrap (below) — and anchors that cursor at
# now − H. Unset or blank = 24. Otherwise 1–4 plain digits, no leading zero, no
# sign, no space, at most 720; anything else REFUSES that conta's bootstrap
# (`lookback-invalido`, aviso at once) rather than guessing a window. ⚠️ Sized
# and set by a person in the window (W7), BEFORE the first tick that finds the
# conta connected, and kept narrow: every re-listed migrated order runs step 5's
# exact-match check (D17). Changing it after a conta's first LEASE (its first
# tick past the context, seller and look-back refusals, whether that run then
# succeeds or fails) does nothing for that conta: re-bootstrap it (below).
# AMAZON_POLL_LOOKBACK_H=

# ---- The WRITE VALVES and CANARY LISTS (both surfaces; read from the write
# engine onward). Since step 14 the NF-e pair is READ by `processAmazonNfeUpload`
# on every dispatch (the valve line, then the target of a planned submit; a
# verification never consults it). Since step 15 the scheduling pair is READ by
# `processAmazonEasyShipSchedule` on every dispatch, FIRST (the valve line; `off`
# reads nothing else), its canary keyed `<contaId>:<orderId>`. The other four are
# read by nothing yet. A valve is
# off | dry-run | on: only the exact `on` writes, only the exact `dry-run`
# diffs, anything else is off. A list: unset/blank = NO target, exactly `*` =
# every target, else `<contaId>:<sku>` (stock, price) or `<contaId>:<orderId>`
# (NF-e, scheduling), comma-joined. Set them ALIKE on both surfaces, and only in
# the window (W8).
# AMAZON_MODO_ESTOQUE=
# AMAZON_MODO_PRECO=
# AMAZON_MODO_NFE=
# AMAZON_MODO_AGENDAMENTO=
# AMAZON_CANARIO_ESTOQUE=
# AMAZON_CANARIO_PRECO=
# AMAZON_CANARIO_NFE=
# AMAZON_CANARIO_AGENDAMENTO=
```

⚠️ The scheduled functions are deployed either way — a variable only decides
whether a firing does any work. Changing one is therefore a redeploy, not a code
change.

### Re-bootstrapping a conta's poll (W7)

A conta's cursor is anchored ONCE, by the first lease of its poll document, at
now − `AMAZON_POLL_LOOKBACK_H`, whatever that run's outcome; it then only moves
forward. To re-anchor it (a look-back that was wrong, a window to re-list), a
person edits `pollPedidosAmazon/{contaId}` in the console, in this order:

1. If H changes, set it in `.env.deploy`, redeploy the functions and WAIT for
   the deploy to finish: the env bakes at deploy, and a tick before it lands
   anchors at the OLD H.
2. Take a manual lease, `execucaoId` FIRST: set `execucaoId` to `w7-manual`,
   then `emExecucaoAteMs` to now + 30 minutes in epoch milliseconds
   (`Date.now() + 1800000` in a browser console). Every tick then skips the
   conta (`lease-ocupado`), and a run already in flight writes nothing (its
   final write re-reads a lease it no longer owns: `lease perdido`).
3. Wait at least 6 minutes (past the poll's 300-s timeout and 360-s lease, so
   every run that started before step 2 has ended), then re-read: both fields
   still hold your values. If either changed, a run wrote in between; start
   again at step 2.
4. Delete the three FIELDS `cursorMs`, `pendente` and `vistos`. Never delete
   the DOCUMENT: its failure counter stays. Deleting `cursorMs` alone would keep
   a `pendente` drain and a `vistos` set from the old window.
5. Release: set `emExecucaoAteMs` to 0 (or let it expire). The next lease
   replaces the marker.
6. Verify after the next tick: `cursorMs` is back, between that tick's time − H
   and about that tick's time − 5 minutes (the anchor, or a drain's capped
   advance from it). Still absent means that tick was refused before its lease
   (the conta's poll line and the import-stopped aviso say why); the anchor
   lands with the first tick past those refusals.

Why a lease and not a check that none is held: a run that took the lease
before your edit re-derives its final write from a re-read, so over a
cursorless document it writes its OLD window back. Only a lease it no longer
owns makes it write nothing.

`prepare-deploy.mjs` copies the file into the artifact **as `.env`** after the
wipe, and firebase-tools applies it at deploy. For values that belong to ONE
project, name the file `.env.deploy.<project-id>`: it lands as
`.env.<project-id>`, which firebase-tools applies only for that `--project`.

⚠️ The allowlist is anchored and shared by every `prepare-deploy.mjs`
(`tools/deploy-env/env-files.mjs`). Exactly two source names are copied —
`.env.deploy` and `.env.deploy.<project-id>`. A **`.env.secrets*` fails the
hook**, and so does a bare `.env` (with a rename instruction): everything that
reaches the artifact is uploaded to the project's `gcf-sources-*` bucket and
baked in plaintext into the Cloud Run revision.

## ⚠️ One-time IAM — who enqueues Cloud Tasks

Two identities enqueue onto `filaLeituraAmazon`:

- the **App Hosting runtime service account** — the push receiver
  (`POST /api/webhooks/amazon`), from step 3;
- the **functions runtime service account** — the backstop poll
  (`pollAmazonOrders`, through `src/agendador.ts`), by default the project's
  Compute Engine default service account.

And the same two onto `processAmazonNfeUpload` (step 14):

- the **functions runtime service account** — the trigger `onNfeAprovadaAmazon`
  and the task's OWN re-enqueues (the verification ladder, the one resubmit, the
  429 pause), both through `src/agendadorNfe.ts`;
- the **App Hosting runtime service account** — the re-drive route
  `POST /api/marketplace/amazon/enviar-nfe` (PR 14-d).

And onto `processAmazonEasyShipSchedule` (step 15):

- the **functions runtime service account** — every producer: the NF-e task's
  acceptance entry, the order import's entry (the reads queue and the reprocess
  sweep) and the scheduling task's OWN re-enqueues, all through
  `src/agendadorAgendamento.ts`. No App Hosting code enqueues onto it, but the
  deploy grants it to BOTH runtime SAs anyway: `TASKS_INVOKER_SA` is ONE list,
  applied to every task function of the codebase.

**Every** enqueuing identity needs **three** grants **per queue** (run grant 1
and grant 3 once with `filaLeituraAmazon`, once with `processAmazonNfeUpload`
and once with `processAmazonEasyShipSchedule`; grant 2 is per identity, not per
queue):

```bash
# 1 - permission to CREATE the task. Queue-level, so it can only run once the
# deploy has created the queue.
# ⚠ THE DEPLOY APPLIES THIS ONE when TASKS_INVOKER_SA is set - except on the
# first deploy of the queue, which crashes on exactly this binding (below).
gcloud tasks queues add-iam-policy-binding filaLeituraAmazon \
  --location=<region> --project=<project-id> \
  --member="serviceAccount:<enqueuing-sa>" \
  --role="roles/cloudtasks.enqueuer"

# 2 - permission to ACT AS the account the task's OIDC token names. The Admin SDK
# stamps that token with the enqueuer's own identity, and Cloud Tasks refuses to
# create a task carrying an OIDC token without actAs on that account, even when
# the caller IS that account.
# ⚠ THE DEPLOY NEVER APPLIES THIS ONE: TASKS_INVOKER_SA covers grants 1 and 3
# only. Without it every enqueue fails `permission-denied`, which the producer
# rethrows untouched (the receiver persists it `failed` with an ERROR line; the
# poll stops the conta's drain as `fila-indisponivel` and raises its aviso; the
# NF-e re-drive route answers 500 after one ERROR line naming the SDK class and
# code, the error sanitized of the answered body - only a pedido that passes
# every check of the route reaches that enqueue; a scheduling entry or
# re-enqueue logs one WARNING naming the SDK class and code).
gcloud iam service-accounts add-iam-policy-binding <enqueuing-sa> \
  --project=<project-id> \
  --member="serviceAccount:<enqueuing-sa>" \
  --role="roles/iam.serviceAccountUser"

# 3 - permission to DISPATCH: roles/run.invoker ON THE SERVICE.
# ⚠ THE DEPLOY APPLIES THIS ONE when TASKS_INVOKER_SA is set. Run it by hand
# only for a deploy without that variable.
gcloud run services add-iam-policy-binding filaLeituraAmazon --region=<region> \
  --project=<project-id> \
  --member="serviceAccount:<enqueuing-sa>" \
  --role="roles/run.invoker"
```

⚠️ **The third role is the one everyone forgets.** Enqueuing is only half the
trip: Cloud Tasks then DISPATCHES the task, presenting an OIDC token whose
principal is the enqueuer's own identity, and a gen2 function is a Cloud Run
service, so that principal needs `run.invoker` ON THE SERVICE. Without it the
task is created and delivered and the service answers 403, with NO failure
document written anywhere.

### `TASKS_INVOKER_SA` — AUTHORITATIVE, and it names BOTH enqueuers (#1133)

Export it in the shell you run `firebase deploy` from. `build.mjs` inlines it
(esbuild `define`, exactly like `FUNCTIONS_REGION`) and the `onTaskDispatched`
in this codebase declares it as `invoker`; firebase-tools then applies the list
to **both** legs of the trip — `roles/run.invoker` on the function's Cloud Run
service **and** `roles/cloudtasks.enqueuer` on its queue. It never applies grant
2: that one stays a manual `gcloud` grant with or without this variable.

```bash
export TASKS_INVOKER_SA="<apphosting-runtime-sa>,<functions-runtime-sa>"
firebase deploy --only functions:amazon \
  --config firebase.amazon.deploy.json \
  --project <project-id>
```

⚠️ **The list is AUTHORITATIVE: name every enqueuer, comma-separated.** A deploy
**replaces** the members of both bindings, so an identity left out **loses** the
role. Name BOTH from the FIRST deploy: the functions runtime SA is the backstop
poll's identity, and a list that names only one enqueuer leaves the other's
enqueues failing `permission-denied`.

⚠️ **Unset ⇒ the deploy is refused.** The preflight aborts on a missing
`TASKS_INVOKER_SA` (a bare `node build.mjs` only warns and omits `invoker`).

### The deploy preflight (#1133)

`predeploy` runs `node tools/deploy-env/preflight.mjs amazon` **before** the
artifact is built. It prints every build-time value about to be baked into the
bundle, and whether each came from your shell or from a `build.mjs` default,
then refuses to continue when `TASKS_INVOKER_SA` is unset or blank, when
`FUNCTIONS_REGION` is unset, or when the task/schedule region has no Cloud
Tasks. It ends with the backend cross-check: the App Hosting backend's
`AMAZON_TASKS_REGION` (`apps/amazon/apphosting.yaml` / the console) must equal
the region printed. Run it by hand any time; it changes nothing:

```bash
node tools/deploy-env/preflight.mjs amazon
```

⚠️ It does **not** run in CI. `predeploy` hooks are skipped under
`emulators:exec`, which is deliberate — the emulators have no IAM layer.

### ⚠️ firebase-tools 15.28.2: the first deploy of a NEW queue crashes on the enqueuer binding

Measured on another channel's staging deploy, and **not specific to it**: the
first deploy of ANY codebase's brand-new task queue whose function declares
`invoker` hits it. No deploy path pins firebase-tools, so this is the deploying
machine's CLI: check whether a newer release fixed it before relying on the
workaround.

- **The mechanism.** `cloudtasks.setEnqueuer` runs `existing.bindings.filter(...)`
  over the queue's IAM policy. A brand-new queue's `getIamPolicy` answers with
  **no `bindings` key**, so it throws.
- **The misleading symptom.** The deploy prints "Unable to set the invoker for
  the IAM policy … organization policy" for the queue function. It reads like a
  permissions problem and is not one.
- **What lands anyway.** The functions, the queue and the `roles/run.invoker`
  binding on the Cloud Run service. What is MISSING is only the queue-level
  `roles/cloudtasks.enqueuer` binding — the enqueue leg.
- **Re-running alone does not help.** A retry reads the same binding-less policy
  and crashes identically.

The workaround — **once per new queue, per identity** named in
`TASKS_INVOKER_SA`:

```bash
gcloud tasks queues add-iam-policy-binding filaLeituraAmazon \
  --location=<region> --project=<project-id> \
  --member="serviceAccount:<sa>" \
  --role=roles/cloudtasks.enqueuer
```

then re-run the SAME deploy: the policy now has a `bindings` array, so the
deploy re-applies `TASKS_INVOKER_SA` authoritatively and finishes clean. This
codebase has THREE queues since step 15 (`filaLeituraAmazon`,
`processAmazonNfeUpload`, `processAmazonEasyShipSchedule`), so a first deploy
into a project pays it once per identity PER QUEUE — and the scheduling queue is
new even where the other two already exist, staging's included — **production's
included**: it is a separate project, so put the grants in the window's runbook.

## Easy Ship scheduling (step 15)

`processAmazonEasyShipSchedule` books ONE pickup per Delivery-by-Amazon order,
after Amazon accepted the order's NF-e. Amazon chooses the slot (no slot is ever
sent), the label format is always ZPL, and nothing about the schedule is stored:
no label, no link, no token, no pedido field. The order import mirrors Amazon's
own package status at the order's next read.

**Who enqueues.** Every producer is in this codebase, through
`src/agendadorAgendamento.ts` (the codebase's fourth `getFunctions(` root, never
the NF-e trigger's), as the functions runtime SA:

- **the NF-e task** (E1), when Amazon accepts the invoice: ONE task NAMED after
  that NF-e dispatch's own task id, delayed 60 s (the order-level invoice status
  may lag the acceptance);
- **the order import** (E2), whenever a read shows an order ready to schedule
  (its order-level invoice status exactly `ACCEPTED`, its packages still to be
  scheduled): ONE task NAMED after the pedido and that read's order clock — this
  is what schedules an NF-e uploaded by hand in Seller Central, IF Amazon's
  acceptance moves the order's `lastUpdatedTime`, so that the backstop poll lists
  it (not yet observed; no push fires on an acceptance, and otherwise only the
  order's next label print schedules it);
- **the task itself**: UNNAMED re-enqueues, waiting for the order-level
  acceptance to mirror (120 s, 600 s, 1800 s — an acceptance entry only) and
  after a 429 (30 s … 480 s).

A name is per OBSERVATION, never per pedido: Cloud Tasks refuses a name for about
an hour after its task ran, and a per-pedido name would swallow every later
observation of the order for that hour. Several tasks may therefore exist for one
order; concurrency 1 serialises them, and the second reads the order already
scheduled and sends nothing.

**What stops it.** `AMAZON_MODO_AGENDAMENTO` unset or `off` ⇒ the task reads
nothing at all. `dry-run`, or `on` outside `AMAZON_CANARIO_AGENDAMENTO` ⇒ it reads
the live order and never mints a token or sends the bulk: a plan that WOULD
schedule writes ONE diff line and nothing else, while a plan that would not ends
exactly as under `on` — ⚠️ so a dry-run is not free of side effects: a read of the
order already scheduled resolves the two scheduling rows, an open cancellation
request raises `aceitar-cancelamento`, and an acceptance entry reading the
order-level invoice status not yet accepted still waits through its re-enqueues
(up to 3 more tasks and `getOrder` reads). `AMAZON_CHAMADAS` not `on` ⇒ one
WARNING `chamadas-desligadas`. `AMAZON_TASKS_DISABLED=1` ⇒ the entries and the
re-enqueues log a WARNING and enqueue nothing, with no sweep behind them: the
order's pickup is booked at its next label print. In the window (W8) ramp it with (or
ahead of) the NF-e valve, alike on both surfaces: `dry-run` → a canary list of
`<contaId>:<orderId>` → `on` → `*`.

**The avisos it writes** (per-pedido `amazonPedidoPrecisaAtencao`, crítico,
clocked by the task's pedido read): `dimensoes-ausentes` (Amazon refused the
order for missing dimensions or weight) and `agendamento-recusado` (any other
refusal of THIS order, or a slot code Amazon still answered on the last attempt);
both resolve when the task (or a later import) sees the order scheduled, shipped
or cancelled — the import that moves a pedido into a cancelled sale seeds a
resolved row of both, so a refusal racing the cancellation cannot stay open. An
open cancellation request raises the existing `aceitar-cancelamento`. Everything
else is log-only. An outage and a lost re-enqueue: the order's next label print
schedules it anyway. The valve and the switch: they gate that print too (it
answers 503, and Seller Central prints until they are on). A missing app grant: the print fails the
same way, so fix the grant. An ambiguous or cancelled NF-e (step 14 already
raised its own aviso): the print will refuse it too, and the exit is scheduling
that pickup in Seller Central.

**Retries.** A 5xx, a cut connection, a 2xx off its schema or a lagging order
read THROWS for the queue's retry, which comes after at least 60 s and re-reads
the order FIRST (a bulk that did land reads as scheduled and sends nothing); on
the last attempt it is a WARNING. A 429 is a pause re-enqueue, never a spent
attempt. A refusal of the order is never retried.

## Verifying a first deploy

Do these in the window, in this order, after the deploy and before any switch is
flipped:

1. Cloud Tasks lists the queue `filaLeituraAmazon` with concurrency 1 and 0.5
   dispatches per second, (step 14) `processAmazonNfeUpload` with concurrency
   1 and 1 dispatch per second, and (step 15) `processAmazonEasyShipSchedule`
   with concurrency 1, 1 dispatch per second and a 60-s minimum backoff; Cloud
   Scheduler lists the three schedule functions.
2. For EACH of the three queues, `gcloud run services get-iam-policy <queue>` and
   `gcloud tasks queues get-iam-policy <queue>` both name every identity in
   `TASKS_INVOKER_SA`, and each enqueuing identity holds
   `roles/iam.serviceAccountUser` on itself (grant 2, which no deploy makes).
3. The Firestore index `notificacoesAmazon (status, processedAt)` is READY.
4. A reprocess tick logs two `evento: 'varredura'` lines (`lane: hot` and
   `lane: deferred`), and the first expiry run logs one.
5. A poll tick logs its summary line `[amazon] poll de pedidos` with
   `portao: chamadas-desligadas` (the read switch, still off; since step 5 the
   importer gate is open, so `importador-ausente` would mean a build with an
   emptied seam), and `pollPedidosAmazon` holds no document: the gate reads and
   writes nothing in Firestore.
6. The collection-group index `prodAmazon (contaAmazonOuterRef, sku)` is READY.
7. The conta trigger is bound to the NAMED database, and the Eventarc trigger
   carries that filter:

   ```bash
   gcloud eventarc triggers list --location=<FUNCTIONS_REGION> --project <project-id>
   # expect a trigger for onintegracaoamazonchanged,
   # event type google.cloud.firestore.document.v1.written,
   # filtered to database 'default' + the integracao/* document path
   ```

8. With the operator's OK, rename the conta and rename it back: the `amz`
   freight doc's `nome` follows both times and its `ultimaModificacao` moves, and
   the two `[amazon] onIntegracaoAmazonChanged` lines are INFO
   `acao: atualizado`, never WARNING `acao: incompleto` (that would mean the
   conta lacks a filial, a `nome` or a `dataCadastro`, so it has no `amz`
   freight doc; the adoption pass's dry run already lists such a conta as
   `incompleto`). ⚠️ The trigger logs only when a conta write moves a mirrored
   field, and nothing between the deploy and this rename has to, so its silence
   before it proves nothing. A plain conta save proves nothing either: one that
   moves no mirrored field writes nothing by design, and right after the
   adoption pass's `--apply` the adopted doc is already in step.
