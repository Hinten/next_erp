# Deploying the Mercado Livre Cloud Functions (codebase `mercado-livre`)

These functions are a **deploy-artifact sub-build** of `@delfrance/mercado-livre-app`
— not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. `firebase.mercado-livre.deploy.json` points `source` at the generated
`.deploy/mercado-livre-functions`.

> Deploy is **manual and coordinated** — agents never run `firebase deploy` (root `CLAUDE.md`, Critical rules) — never let a
> stray `firebase deploy` push rules. This config has no `firestore`/`storage`
> block, so it can't.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/mercado-livre/node_modules`).
- The App Hosting backend for `apps/mercado-livre` created in the Firebase console
  (GCP-side; not declared in any repo config).
- Env / secrets on the deployed functions: `FIREBASE_PROJECT_ID` + admin creds, plus
  **both** ML app credentials —
  `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_ID --project <project-id>` and
  `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_SECRET --project <project-id>`.
  **9 of the 11** functions bind both **per-function** — every one whose deps refresh
  an ML access token (see the list in `src/options.ts`). The binding is per-function
  rather than codebase-wide precisely so the two Firestore triggers (`onNfeAprovada`,
  `onIntegracaoMercadoLivreChanged`), which never call the ML API, carry **no**
  credentials at all.
- **Region match**: the App Hosting backend must enqueue onto the queue in the
  function's region. The enqueuer resolves the region from
  `MERCADO_LIVRE_TASKS_REGION ?? FUNCTIONS_REGION ?? us-east5` (App Hosting / Cloud
  Run does NOT expose its own region as an env var — only the metadata server
  does — so it must be configured). Both the functions (build.mjs) and the
  enqueuer default to **us-east5**; if you deploy the functions to another region,
  set `MERCADO_LIVRE_TASKS_REGION` (or `FUNCTIONS_REGION`) on the App Hosting env
  to match. A wrong/absent region makes the Admin SDK target `us-central1` and the
  task **silently drops**.
- **One-time IAM** (see the dedicated section below) — required before the callback
  cutover so the receiver can enqueue.

## Deploy

```bash
# from the repo root
firebase deploy --only functions:mercado-livre \
  --config firebase.mercado-livre.deploy.json \
  --project <project-id>
```

The `predeploy` hook builds the artifact automatically. To inspect the bundle
locally without deploying: `node apps/mercado-livre/functions/build.mjs` (writes
`dist/index.js`).

## Functions in this codebase

| Export                                | Trigger                                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `importMercadoLivreOrders`            | `onSchedule('every 15 minutes')`                                                            | Step 9 PR 4 (#360) — the **order-backfill** sweep: pages `GET /orders/search` per active conta from its durable cursor and enqueues one synthetic `orders_v2` notification per order onto the notification queue, i.e. the same idempotent, staleness-gated import path a real webhook takes. **No-op until `MERCADO_LIVRE_ORDER_BACKFILL_ENABLED=1`** (see "Runtime env" below): while off it deploys, ticks, logs one info line and reads nothing. `timeoutSeconds: 540`; binds both secrets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `processMercadoLivreNotification`     | `onTaskDispatched` (Cloud Tasks queue)                                                      | Step 6 — process a queued ML notification (resolve account by `user_id`, dispatch by topic). Rate-limited + retry-with-backoff; the receiver enqueues, this runs in-process. Persists to `notificacoesMercadoLivre` ONLY on retry-exhaustion / no-account / unknown topic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `reprocessMercadoLivreNotifications`  | `onSchedule('every 30 minutes')`                                                            | Step 6 — reprocess backstop, draining BOTH lanes: persisted `failed` notifications older than 1h (deletes on success, parks at the cap) and, on a 24h window, the `deferred` ones waiting for their seller to connect (#808). Logged as two separate lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `processMercadoLivreMassImport`       | `onTaskDispatched` (Cloud Tasks queue)                                                      | Step 8 (#621) — "Importar todos os anúncios": scans the seller's full listing via `scanSellerItems`, drains up to `MASS_IMPORT_ITEMS_PER_DISPATCH` items per dispatch through `importProduto`, and re-enqueues itself onto its OWN queue until the job (`importacoesMercadoLivre/{jobId}`) is exhausted. Single in-flight dispatch (`maxConcurrentDispatches: 1`) since the job doc is the checkpoint. Binds `MERCADO_LIVRE_CLIENT_ID`/`MERCADO_LIVRE_CLIENT_SECRET` from Secret Manager per-function (see `src/options.ts`) for the ML token refresh.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sweepMercadoLivreStock`              | `onSchedule('every 15 minutes')`                                                            | Step 10 PR C — the **incremental** stock sweep: per conta it runs THE produtos-first joined discovery from the durable cursor (`estoqueMercadoLivreSync/{integracaoId}`), keeps only the families whose PUBLISHED number actually changed (`anterior = atual − Σmovimento` over the window, via the one grouped `historicoEstoque` aggregate per tick) and enqueues one `sendMercadoLivreStock` task per ML call. A change is skipped anyway while the quantity stays above `MERCADO_LIVRE_STOCK_LIMIAR_ALTO` on BOTH sides — incremental-only. The per-tick log line reports `inalterados` (a subset of `skipped`): read it against `enqueued` to see what the change check is saving. Bounded pages + tasks per tick; a truncated tick persists `continuacao` (frozen window + keyset) and the NEXT tick resumes it. Skips a conta whose 429 `pausedUntilUs` is still live, and skips ONLY the 02:00 America/Sao_Paulo tick in code (`isSlotDoDaily` — that slot belongs to the daily sweep; 02:15/30/45 run normally). **No-op until `MERCADO_LIVRE_STOCK_SYNC_ENABLED=1`.** |
| `sweepMercadoLivreStockDaily`         | `onSchedule('0 2 * * *')`                                                                   | Step 10 PR C — the **daily** sweep, 02:00 America/Sao_Paulo: the same discovery over a flat 24h window (`MERCADO_LIVRE_STOCK_DAILY_WINDOW_H`), re-sending everything that changed without the high-stock arm. ⚠️ **Not** a reconciliation — a listing whose ERP stock did not move inside the window is not a candidate at all; `sweepMercadoLivreStockReconciliacao` below is the corrector. It owns its slot alone — the incremental wrapper skips exactly the 02:00 tick — so the two never contend for one conta's caps and state doc. Same flag, same no-op while OFF.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sweepMercadoLivreStockReconciliacao` | `onSchedule('0 3 1 * *')`                                                                   | #929 — the **monthly** force-all, 03:00 America/Sao_Paulo on the 1st, and the only tier that actually reconciles. The query is force-alled (`changedSinceMs: -1`, so even families with no estoque doc survive the window filter), while the ledger comparison still runs over `lastReconciliacaoAtUs → now` — so a listing whose published number did not change since the last completed full pass is still skipped. It corrects what the other two tiers structurally cannot see: ML-side drift on a listing whose ERP stock never moved, and a kit whose COMPONENT moved without the kit itself selling (ADR 0014's deliberate under-send). ⚠️ **Two flags**: its own `MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED=1` on top of the master `MERCADO_LIVRE_STOCK_SYNC_ENABLED=1`, so it can be turned off alone. A conta with no previous full pass has no baseline and force-sends every listing once — expect exactly one expensive run per conta, then the cheap steady state. See "The monthly reconciliation" below.                                                      |
| `sendMercadoLivreStock`               | `onTaskDispatched` (Cloud Tasks queue)                                                      | Step 10 PR B — the stock **send** queue that both sweeps above feed: **one task = one ML call** (the listing's `available_quantity`). It transmits the SWEEP-COMPUTED quantities verbatim — zero produto/estoque reads at send time (owner-locked legacy parity) — so a retried or pause-parked task can send numbers up to `now − sweepComputedAtMs` old; the handler logs `ageMs` on every send and the next sweep converges any staleness. A task landing on a 429-paused conta re-enqueues itself (delay + jitter) instead of burning queue retries; a 429 pauses the conta and rethrows so the retry rides the queue backoff into that pause gate. A 4xx is rethrown until the LAST attempt, which then asks ML for the listing's real state and records it. Its `rateLimits` are **deploy-time** reads (`MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND` / `..._CONCURRENT_DISPATCHES`, defaults 2/2 — see "Runtime env" below). Idle until `MERCADO_LIVRE_STOCK_SYNC_ENABLED=1`, since only the sweeps enqueue onto it.                                                       |
| `processMercadoLivrePriceSync`        | `onTaskDispatched` (Cloud Tasks queue)                                                      | Step 11 PR-C — "Atualizar preços": manual bulk price sync for one conta. Pages the conta's linked produtos, prices from the tabela normal, GETs the item before every PUT (skip-if-equal, fresh status gate, decrease guard unless `baixarPreco`), sends **price-only** bodies (`item.price.not_modifiable` maps to a terminal skip), and re-enqueues itself onto its OWN queue until the job (`enviosPrecoMercadoLivre/{jobId}`) is exhausted. Single in-flight dispatch (`maxConcurrentDispatches: 1`) since the job doc is the checkpoint. Binds `MERCADO_LIVRE_CLIENT_ID`/`MERCADO_LIVRE_CLIENT_SECRET` per-function for the ML token refresh.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `onNfeAprovada`                       | `onDocumentWritten` (`pedidos/{pedidoId}/nfev4/{nfeId}`, named `default` DB, `retry: true`) | Step 12 (#739) — the codebase's **first Firestore trigger**: fires on every `pedidos/{pedidoId}/nfev4/{nfeId}` write (named `default` database); when a production (`<tpAmb>1`) NF-e reaches `aprovada` with `xml_nfe_proc` present, ONE pedido read filters non-ML pedidos and it enqueues one `{ pedidoId, nfeId }` task onto the NF-e upload queue — **zero Firestore writes** (a non-ML approval costs exactly that 1 read; no task, no doc). Binds **no secrets** (never touches the ML API — see `src/options.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `onIntegracaoMercadoLivreChanged`     | `onDocumentWritten` (`integracao/{integracaoId}`, named `default` DB, `retry: true`)        | #782 — mirrors a Mercado Livre conta onto its Mercado Envios `int_frete` doc: created on connect, re-synced when `nome` / `ativo` / filial / `dataCadastro` change, **deactivated** (never deleted) when the conta is deleted or its `tipo` is edited away. Restores what the legacy Flutter conta screen did inline on every save. **Plus #808**: when a write makes a seller RESOLVABLE (a `user_id` stamp, an `ativo` flip), re-drives every notification deferred on that seller back into the hot sweep lane. Every gate runs before the first read, so any non-ML conta write — and any ML token refresh — costs zero reads and zero writes; a `user_id` stamp now pays for one indexed notification query, which is the point. Binds **no secrets** (pure Firestore — see `src/options.ts`).                                                                                                                                                                                                                                                                             |
| `processMercadoLivreNfeUpload`        | `onTaskDispatched` (Cloud Tasks queue)                                                      | Step 12 (#739) — uploads the raw signed nfeProc XML to ML `POST /shipments/{shipmentId}/invoice_data?siteId=MLB` so the shipment leaves `invoice_pending`. One task = one NF-e (no self-continuation); 6 attempts over a ≈25–30 min backoff envelope. **Zero writes on the happy path** — idempotency is the live shipment-status gate; the flow's only Firestore write is the failure stamp `freteInicial.estado = 'error'` on the pedido, with the detail in structured Cloud Logging. Single in-flight dispatch. Binds `MERCADO_LIVRE_CLIENT_ID`/`MERCADO_LIVRE_CLIENT_SECRET` per-function for the ML token refresh.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**All 11 exports above are deployed targets** — one `firebase deploy --only functions:mercado-livre`
creates or updates every one of them, and the table is the complete list. The five
queue-backed handlers additionally have their name asserted at module load
(`src/index.ts:53-115`): the deployed function name **is** the queue name the enqueuers
target, so a rename that updates only one side fails loudly during Firebase's deploy
codebase-analysis instead of silently enqueuing onto a queue that does not exist. The four
schedules and the two Firestore triggers get no such assertion — Eventarc binds a document
path, and nothing enqueues against a schedule's name.

### Durability & the residual loss window

A notification is durable once it is either (a) processed, or (b) persisted as
`failed` for the sweep. There is one narrow residual-loss window: the task
handler persists a `failed` doc only on its **final** attempt, and if Firestore
is unavailable for that whole retry window (a _correlated_ outage — the same
Firestore the handler both reads and writes), the final persist also fails. The
handler then logs the dropped notification and re-throws so the failed final
attempt is visible in Cloud Tasks' error metrics, but the notification is lost
(nothing persisted → the sweep can't see it, and ML already got its 200). This
requires a Firestore outage longer than the queue's backoff window; the deferred
`missed_feeds` backstop (ML retains 2 days of undelivered/lost notifications) is
the ultimate recovery for it. Alert on `processMercadoLivreNotification`'s failed
final attempts.

## ⚠️ One-time IAM — the App Hosting backend enqueues Cloud Tasks

The receiver route (`/api/webhooks/mercado-livre`, on the App Hosting backend)
enqueues onto the `processMercadoLivreNotification` queue via
`firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`. That requires the
**App Hosting runtime service account** to be able to enqueue tasks and act as the
functions' invoker SA — grant these **once**, before switching the callback URL:

```bash
# App Hosting runtime SA (the identity the receiver route runs as):
#   PROJECT_NUMBER-compute@developer.gserviceaccount.com  (or the backend's SA)
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<apphosting-runtime-sa>" \
  --role="roles/cloudtasks.enqueuer"

gcloud iam service-accounts add-iam-policy-binding <functions-runtime-sa> \
  --member="serviceAccount:<apphosting-runtime-sa>" \
  --role="roles/iam.serviceAccountUser"
```

Until this is granted the enqueue fails; the receiver then **falls back** to
persisting the notification as `failed` (the reprocess sweep drains it) and still
acks 200 — so notifications are not lost, but the intended rate-limited queue path
is inactive. Verify the queue exists after the first deploy:
`gcloud tasks queues describe processMercadoLivreNotification --location=<region>`.

## Mass-import job queue (Step 8, #621)

`processMercadoLivreMassImport` auto-provisions its own Cloud Tasks queue the
same way `processMercadoLivreNotification` does — no separate Terraform/gcloud
queue-creation step. It reuses the **same** enqueuer IAM grant (above): both the
`/importar-todos` route and the task handler's own self-continuation enqueue
via `createMlMassImportScheduler()` (`lib/marketplace/mlMassImportTasks.ts`),
which is the same App Hosting runtime SA → functions runtime SA path already
granted `roles/cloudtasks.enqueuer` / `roles/iam.serviceAccountUser`. It also
reuses the notification pipeline's `MERCADO_LIVRE_TASKS_DISABLED` /
`MERCADO_LIVRE_TASKS_REGION` env knobs — no new region/valve config needed.

**New secret requirement**: unlike `processMercadoLivreNotification`,
`processMercadoLivreMassImport` binds `MERCADO_LIVRE_CLIENT_ID` +
`MERCADO_LIVRE_CLIENT_SECRET` directly on its own `onTaskDispatched` options
(`secrets: [...]` in `src/processMassImport.ts`, not the codebase-wide
`setGlobalOptions` in `src/options.ts`) because its default import path
refreshes the connected account's ML access token
(`mercadoLivreOAuthConfig()` reads both). Set them once per project before the
first mass-import run:

```bash
firebase functions:secrets:set MERCADO_LIVRE_CLIENT_ID --project <project-id>
firebase functions:secrets:set MERCADO_LIVRE_CLIENT_SECRET --project <project-id>
```

(These are typically already set as Secret Manager-backed App Hosting env vars
for the `apps/mercado-livre` backend itself — see its `apphosting.yaml` — but
that binding does NOT reach this separate functions codebase; it must be bound
here too.)

## Price-sync job queue (Step 11 PR-C)

`processMercadoLivrePriceSync` auto-provisions its own Cloud Tasks queue the
same way the other queues do — no separate queue-creation step. IAM is covered
by the existing grants (above): both the `/atualizar-precos` route and the task
handler's own self-continuation enqueue via `createMlPriceSyncScheduler()`
(`lib/marketplace/mlPriceSyncTasks.ts`), the same App Hosting runtime SA →
functions runtime SA path already granted `roles/cloudtasks.enqueuer` /
`roles/iam.serviceAccountUser` — verify the grants exist, don't re-grant. It
also reuses the shared `MERCADO_LIVRE_TASKS_DISABLED` /
`MERCADO_LIVRE_TASKS_REGION` knobs, and binds the same two ML secrets
per-function (`src/processPriceSync.ts`, mirroring the mass import) — if the
mass-import secrets are already set for this project, there is nothing new to
set.

**Deploy order**: deploy this functions codebase (which provisions the queue)
BEFORE the App Hosting revision that ships the `/atualizar-precos` route. Until
the function exists, every job start fails at the first enqueue — the route
stamps the fresh job `failed` and returns 503 `ML_PRICE_SYNC_ENQUEUE_FAILED` —
so the "Atualizar preços" button would be dead on arrival.

**`item.price.not_modifiable`**: since 2026-03-18 ML blocks API price edits on
listings with price automation active — a price-only `PUT /items/{id}` body
gets 400 `item.price.not_modifiable`, and a price bundled with other fields
gets 200 with the price SILENTLY ignored. The send step therefore always sends
price-only bodies and maps that 400 to the terminal skip
`PRECO_NAO_MODIFICAVEL` (no link stamp): those listings count toward
`pulados`/`skips` and are never retried — turn automation off in the ML seller
panel to make them syncable again.

### Runtime env (price sync)

The three tunables (`MERCADO_LIVRE_PRECO_PAGE_LIMIT`,
`MERCADO_LIVRE_PRECO_ITEMS_PER_DISPATCH`, `MERCADO_LIVRE_PRECO_RATE_PAUSE_MIN`)
are non-secret values read LAZILY from `process.env` by the getters in
`lib/marketplace/precoPlan.ts` (unset/blank/invalid → the code default). They
are **function-runtime env** and ride exactly the same mechanism — and the same
constraints — as the stock knobs: see "Setting (1)" under _Runtime env (stock
sync, Step 10)_ below. The queue's `rateLimits` (1 concurrent dispatch / 1
dispatch per second) are fixed in code and baked in at **deploy** time —
changing them is a code edit + redeploy, not an env var.

## NF-e upload queue + Firestore trigger (Step 12)

`processMercadoLivreNfeUpload` auto-provisions its own Cloud Tasks queue the
same way the other queues do — no separate queue-creation step. IAM is covered
by the existing grants (above) — verify they exist, don't re-grant. Note the
enqueuer here is the **functions runtime SA itself**: `onNfeAprovada` runs in
THIS codebase and enqueues via `createMlNfeUploadScheduler()`
(`lib/marketplace/mlNfeUploadTasks.ts`) — the same identity the stock sweeps
and the price-sync self-continuation already enqueue as. Secrets: the task
handler binds the same two ML secrets per-function
(`src/processNfeUpload.ts`, mirroring the mass import) — if they are already
set for this project, there is nothing new to set. The trigger binds **none**
(see `src/options.ts`).

**Zero-write model (legacy cost parity).** The flow keeps NO per-NF-e state in
Firestore:

- **Idempotency** is the task handler's live **shipment-status gate** — the
  shipment's substatus leaves `invoice_pending` once an invoice is saved, so a
  duplicate task (Eventarc redelivery, a manual route re-send) no-ops, and ML's
  `shipment_invoice_already_saved` rejection maps to a success-equivalent.
- **Per-NF-e observability** is **structured Cloud Logging**: every dispatch
  logs `pedidoId`, `nfeId`, `outcome`, `motivo`, `retryCount`
  (`processMercadoLivreNfeUpload`'s completion line), and failures additionally
  log `shipmentId` plus the ML error `code`/`message`. For on-demand diagnosis
  of a specific shipment, `getShipmentInvoiceData`
  (`GET /shipments/{id}/invoice_data?siteId=MLB`) returns what ML actually has.
- The flow's **only Firestore write** is the failure stamp
  `freteInicial.estado = 'error'` on the pedido (the despacho screens' signal).
- **Cost note**: the trigger performs a single pedido read to filter non-ML
  NF-es BEFORE any task exists — an approval on a non-ML pedido costs exactly
  1 read, with no task and no write anywhere.

**First Firestore trigger in this codebase.** `firebase deploy` creates the
gen2 Eventarc trigger itself — no manual Eventarc step. The
Firestore→Eventarc→Cloud Run service agents were already exercised by
apps/whatsapp's `sendOutbound` in this project, so no first-time service-agent
provisioning delay is expected. The Eventarc trigger resource lands in the
**database's region** while the function runs in `us-east5` — that split is
normal for Firestore triggers. Verify after the first deploy:

```bash
gcloud eventarc triggers list --project <project-id>
# expect a trigger for onnfeaprovada, event type google.cloud.firestore.document.v1.written,
# filtered to database 'default' + the pedidos/*/nfev4/* document path
```

**`MERCADO_LIVRE_TASKS_DISABLED` valve behavior**: while the valve is on, the
trigger logs a warning and **skips** the enqueue (no throw, no Eventarc retry
loop). Unlike the notification pipeline there is NO sweep backstop for this
queue — an approval that lands while the valve is on stays un-uploaded until a
manual poke/route re-drive after the valve lifts. Treat the valve as a
deliberate, short-lived state.

### ⚠️ HARD CUTOVER — delete the legacy `nfe-ml--updated-trigger` in the same window

The legacy Flutter backend reacts to the SAME nfev4 approval through the Cloud
Run service `nfe-ml` and its Eventarc trigger **`nfe-ml--updated-trigger`
(us-east1)**. Running both is a **double-fire**: each approval makes two
`POST /shipments/{shipmentId}/invoice_data` calls; ML accepts the first and
rejects the second (the shipment already has invoice data). The NEW handler
maps that rejection (`shipment_invoice_already_saved`) to a
success-equivalent, but when the **legacy** service loses the race it **stamps
`freteInicial.estado = 'error'` on a pedido whose invoice actually uploaded
fine** — a false error on every approval it loses, indistinguishable from a
real failure in the panel.

Order of operations:

1. Deploy this functions codebase (creates the queue + the new trigger).
2. Smoke ONE real approval end-to-end: shipment leaves `invoice_pending` —
   verify via the task's structured completion log (`outcome: 'enviado'`)
   and/or `getShipmentInvoiceData`. This single approval sits in the deliberate
   overlap window — if the legacy service loses the race and stamps
   `freteInicial.estado = 'error'`, correct that one pedido by hand.
3. **Delete the legacy trigger immediately** — do not leave the overlap
   running:

```bash
gcloud eventarc triggers describe nfe-ml--updated-trigger \
  --location=us-east1 --project <project-id>
gcloud eventarc triggers delete nfe-ml--updated-trigger \
  --location=us-east1 --project <project-id>
```

Optional, later: delete the now-orphaned `nfe-ml` Cloud Run service itself
(`gcloud run services delete nfe-ml --region=us-east1 --project <project-id>`)
once the new path has soaked — the trigger deletion above is what stops the
double-fire; the idle service is only cost/noise.

## Mercado Envios `int_frete` sync trigger (#782)

`onIntegracaoMercadoLivreChanged` needs **no queue, no secrets and no IAM grant** — it
is pure Firestore. It does need one new composite index, deployed **before** the
function, or its first invocations silently full-scan `int_frete` (Enterprise
auto-creates nothing and bills data scanned):

```json
{
  "collectionGroup": "int_frete",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "tipo", "order": "ASCENDING" },
    { "fieldPath": "contaMercadoLivreMercadoEnviosOuterRef", "order": "ASCENDING" },
    { "fieldPath": "ativo", "order": "ASCENDING" },
    { "fieldPath": "dataCadastro", "order": "DESCENDING" }
  ]
}
```

It is already in `firestore.indexes.json`; deploy with
`firebase deploy --only firestore:indexes`. The same entry also converts the order
importer's `resolveMercadoEnviosIntFreteOuterRef` from a full scan into an
index-bound equality — that one was live on the import hot path.

### Second responsibility: the deferred-notification re-drive (#808)

The same trigger also pulls every notification that was waiting on a seller back
into the hot sweep lane the moment that seller's `user_id` lands on an active
integração. It still binds **no secrets** — it only MARKS the documents, and
`reprocessMercadoLivreNotifications` (which does bind them) does the reprocessing
on its next tick.

One more composite index, again deployed **before** the function:

```json
{
  "collectionGroup": "notificacoesMercadoLivre",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "user_id", "order": "ASCENDING" }
  ]
}
```

Already in `firestore.indexes.json`. Without it the trigger silently full-scans
`notificacoesMercadoLivre` on every OAuth connect and bills the scan.

Nothing else is needed: the deferred lane itself rides the EXISTING
`(status, processedAt)` composite, and its sweep runs inside
`reprocessMercadoLivreNotifications` rather than as a new scheduled function, so
there is no new Cloud Scheduler job to provision.

**Deploy order**: indexes → this functions codebase → the backfill. Then verify the
Eventarc trigger:

```bash
gcloud eventarc triggers list --project <project-id>
# expect a trigger for onintegracaomercadolivrechanged,
# event type google.cloud.firestore.document.v1.written,
# filtered to database 'default' + the integracao/* document path
```

**Backfill** — contas connected in the new UI have no `int_frete` doc at all, and the
trigger's skip-if-unchanged means a no-op touch will not create one. Dry-run first:

```bash
pnpm --filter @delfrance/mercado-livre-app backfill:int-frete -- --project <project-id>
```

then apply:

```bash
pnpm --filter @delfrance/mercado-livre-app backfill:int-frete -- --project <project-id> --apply
```

It drives the trigger's own `sincronizarIntFreteDaConta`, so the two can never
disagree. Idempotent (re-running an already-synced project writes nothing), so it is
safe to run again; it also normalizes any `contaMercadoLivreMercadoEnviosOuterRef`
still stored in the bare `integracao/<id>` form. A conta reported `incompleto` has no
filial (or no nome) yet — `int_frete` cannot represent that, so fill the field in and
re-run.

**No legacy cutover.** Unlike the NF-e trigger, this one can ship while the Flutter
conta screen is still live: both writers converge on the same doc via the same
back-ref, writing the same values, and whichever runs second finds nothing to change.

## Runtime env (stock sync, Step 10)

The stock sync has no Secret Manager needs of its own — every knob is a
**non-secret** value read LAZILY from `process.env` by the getters in
`lib/marketplace/bulkEstoquePlan.ts` (unset/blank/invalid → the code default), plus
the master flag `MERCADO_LIVRE_STOCK_SYNC_ENABLED` (`'1'` and nothing else turns
it on). Three separate places matter, and they are NOT interchangeable:

1. **The deployed functions' runtime env** — everything the sweeps and the send
   handler read while running: the master flag, `..._INCREMENTAL_WINDOW_MIN`,
   `..._WINDOW_OVERLAP_SEC`, `..._CURSOR_MAX_LOOKBACK_H`, `..._DAILY_WINDOW_H`,
   `..._ATIVIDADE_LOOKBACK_D`, `..._LIMIAR`, `..._MAX`, `..._KIT_INCLUI_PROPRIO`,
   `..._ANCHOR_PAGE_LIMIT`, `..._MAX_TASKS_PER_SWEEP`, `..._RATE_PAUSE_MIN`,
   `..._MAX_PAUSE_REENQUEUES`.
2. **The DEPLOYING shell's env** — `MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND`
   and `MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES` only. They feed
   `onTaskDispatched.rateLimits` (`src/sendStock.ts`), which Firebase evaluates
   at **deploy** time — during firebase-tools' local trigger analysis, in the
   deployer's process — and bakes into the queue config. Export them in the
   shell you run `firebase deploy` from, or you get the code defaults (2/2).
   Changing them later needs a redeploy.
3. The repo-root `.env.example` (Mercado Livre section) — **Next local dev
   only.** It documents the same names for the App Hosting backend (which loads
   the repo-root `.env.local`), and that env does **not** reach this separate
   functions codebase — the same caveat the mass-import secrets carry above.
   (One root template set — `.env.example` for config, `.env.secrets.example` for
   credentials — is the repo convention; #730.)

### The monthly reconciliation

`sweepMercadoLivreStockReconciliacao` runs **03:00 America/Sao_Paulo on the 1st**
behind its **own** flag (`MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED=1`) on top of
the master one. Two gates, because it walks the entire linked catalogue.

**Why it exists.** Neither the incremental nor the daily tier can see a listing
whose ERP stock has not moved inside its window — drift on ML's side (a manual
quantity edit, a dropped PUT, a task lost past `maxPauseReenqueues`) is invisible
to both. Nor do they see a kit whose **component** moved without the kit itself
selling, which is a deliberate cost decision (ADR 0014): ~2000 kits share one
blank shirt and one print, so propagating every component movement is
unaffordable. This pass is the corrector for both.

**What keeps it affordable.** It force-alls the _query_ (`changedSinceMs: -1`, so
even families with no estoque doc survive) but still **skips listings whose
published number did not change since the last completed full pass** — the ledger
sum over `lastReconciliacaoAtUs → now`. On a catalogue that is mostly seasonal,
that is most of it.

**Turning it on.** Only after the normal sweeps run cleanly. Watch the first run's
`enqueued` against the linked-listing count; it drains across several ticks via
`maxTasksPerSweep()` + `continuacao` rather than in one. Turn it off **alone** if
it costs more ML quota than the drift it heals is worth — the other two tiers are
unaffected.

⚠️ A conta's **first** reconciliation has no baseline (`lastReconciliacaoAtUs` is
null), so it force-sends that conta's whole catalogue once and reads no ledger at
all. Expect exactly one expensive run per conta, then the cheap steady state.

### Setting (1) — runtime env via `.env.deploy`

firebase-tools' documented lane for gen2 runtime env vars is a `.env` /
`.env.<project-id>` file in the functions **source** directory. Here that
directory is the generated `.deploy/mercado-livre-functions`, and
`scripts/prepare-deploy.mjs` opens with
`rmSync(deployDir, { recursive: true, force: true })` — it **wipes and
regenerates the whole folder** as the `predeploy` hook, i.e. after you would have
dropped a file in it and before firebase reads the source. So a hand-placed `.env`
**there** still does not survive, and there is no `--no-predeploy` escape hatch.

Instead, put it in the **package** directory and let the hook carry it across the
wipe. Create `apps/mercado-livre/functions/.env.deploy` (gitignored):

```bash
MERCADO_LIVRE_STOCK_SYNC_ENABLED=1
MERCADO_LIVRE_STOCK_INCREMENTAL_WINDOW_MIN=15
MERCADO_LIVRE_ORDER_BACKFILL_ENABLED=1
# The high-stock skip on the incremental tier (ADR 0014). Default 100.
MERCADO_LIVRE_STOCK_LIMIAR_ALTO=100
# The MONTHLY reconciliation — see "The monthly reconciliation" below. Leave it
# COMMENTED OUT until the normal sweeps have run cleanly for a while: this
# snippet is meant to be copy-pasted, so the safe state has to be the one
# written down.
# MERCADO_LIVRE_STOCK_RECONCILIACAO_ENABLED=1
```

⚠️ The scheduled function is deployed either way — the flag only decides whether
a firing does any work. Uncommenting it is therefore a redeploy, not a code
change, and turning it back off is the same one-line edit.

`prepare-deploy.mjs` copies it into the artifact **as `.env`** after the wipe, and
firebase-tools applies it at deploy. It survives redeploys — no
`gcloud run services update` to re-apply, and no Secret Manager entry for a
non-secret tunable.

**Per-project targeting.** `.env.deploy` applies to whatever project you deploy to,
so a staging file deployed to produção takes its values with it — and this flag is
the one that must flip only at the coordinated cutover. For values that belong to
ONE project, name the file `.env.deploy.<project-id>`: it lands as
`.env.<project-id>`, which firebase-tools applies only for that `--project`. Both
can coexist; firebase-tools layers the project-specific file over `.env`.

⚠️ **The four deploy-time-only tuning knobs**
(`MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND` / `MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES`
for stock sync, and `MERCADO_LIVRE_PRECO_DISPATCHES_PER_SECOND` /
`MERCADO_LIVRE_PRECO_CONCURRENT_DISPATCHES` for price sync) are read at **deploy**
time by the `onTaskDispatched.rateLimits` option (see `src/sendStock.ts` +
`src/processPriceSync.ts`) and baked into the queue config. They do **not** belong
in `.env.deploy` — that file becomes the function's RUNTIME env, which is read too
late. Export them in the shell you run `firebase deploy` from:

```bash
export MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND=2
export MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES=2
firebase deploy --only functions:mercado-livre \
  --config firebase.mercado-livre.deploy.json \
  --project <project-id>
```

⚠️ The allowlist is anchored and shared by all five `prepare-deploy.mjs` scripts
(`tools/deploy-env/env-files.mjs`). Exactly two source names are copied —
`.env.deploy` and `.env.deploy.<project-id>`. A `.env.secrets*` **fails the hook**,
and so does a bare `.env` (with a rename instruction): everything that reaches the
artifact is uploaded to the project's `gcf-sources-*` bucket and baked in plaintext
into the Cloud Run revision, so real secrets stay in Secret Manager
(`firebase functions:secrets:set` + the `secrets: [...]` option, as the mass-import
section already does).

`MERCADO_LIVRE_ORDER_BACKFILL_ENABLED` (Step 9's order-backfill sweep, `#360`) rides
**exactly the same mechanism** — put it in `.env.deploy` alongside the stock flag.
It ships OFF and only the literal `1` enables it; while off `importMercadoLivreOrders`
ticks, logs one info line and reads nothing. It is named in the repo-root `.env.example`
(Mercado Livre section) too, so an operator finds it from either file.

### ⚠️ The flag ships OFF — flip it only at the coordinated cutover

`MERCADO_LIVRE_STOCK_SYNC_ENABLED` is unset in every environment. Both sweeps
and the send handler deploy, tick and do nothing while it is off, which is the
intended steady state until the cutover. Flip it to `1` **only in the same
window the legacy Flutter stock sender — the `estoque-ml-periodic` Cloud Run
service, see the cutover table below — is disabled** — the two writing
`available_quantity` for the same listings at once is the exact double-send
hazard the callback-URL cutover below describes for notifications.

**Order of operations:**

1. The new Firestore indexes deployed and verified (`scripts/check-stock-indexes.mjs`).
2. **#933 — the `historicoEstoque` v1 → v2 reshape — has run in THIS project.**
   Its issue states the gate outright: the flag "should not be turned on until
   this has run in production", because the send policy reconstructs `anterior`
   from `sum(movimento)` and un-migrated rows read as _unknown_, so the sweep
   fails open and re-sends the **whole catalogue** instead of only what changed.
3. **The depósito source verified — `pnpm --filter @delfrance/mercado-livre-app
check:deposito-source -- --project <id> --delta` — with zero defects.** See
   the next subsection; it exits non-zero on the two states that must not reach
   the flip.
4. Functions deployed with the flag OFF.
5. Legacy Flutter stock sender disabled.
6. Flag flipped to `1`.
7. Watch the first incremental tick. Expect a one-time correction burst, for
   **two** independent reasons: the anchor's own estoque is now a first-class
   change trigger (the legacy query excluded it), and the depósito source
   changed (below).

⚠️ Steps 2 and 3 compound. Until #933 has run, the first flipped tick force-sends
the entire catalogue — which is the worst possible moment to discover a conta
pointing at the wrong depósito, because the blast radius is every listing rather
than only what moved.

#### The stock source is now PER CONTA, not one hardcoded depósito (#802)

The legacy periodic sender read stock from a **single hardcoded depósito**
(`ME7jOOTexx3OYLPgMtTR`) for every conta — and, since `changed-estoque-bigquery`
fanned one result set out to five channel queues, for every _channel_ too: Mercado
Livre, Loja Integrada, Magalu, Shopee and Amazon all published quantities from
that one warehouse regardless of their own configuration. (The legacy **manual**
push already used the conta's own depósito, so the two legacy paths disagreed
with each other.)

This port reads `integracao.depositoOuterRef` **per conta**, everywhere: the
sweep enumeration, the send handler, the manual `/enviar-estoque` push and the
pedido stock write-back each resolve it independently, and each **refuses** a
conta that has none rather than falling back to anything (the first three skip
and record; the manual push returns `ML_CONTA_SEM_DEPOSITO`, since a human is
waiting for the answer). **Decision (2026-08-11): per-conta is correct and the
hardcoded id was the bug.** There is deliberately no compatibility mode and no
default depósito anywhere in the repo.

⚠️ **The consequence is not rollback-recoverable.** Every conta whose depósito is
not `ME7jOOTexx3OYLPgMtTR` publishes different quantities the moment the flag
flips, and ML keeps them — turning the flag back off does not restore the old
numbers. Run step 3 above and settle each finding _before_ the flip:

- **`SEM DEPÓSITO`** — the sweep skips the conta entirely, so its listings are
  never updated at all. Configure the depósito in Canais de venda.
- **`DEPÓSITO INEXISTENTE`** — the ref resolves to an id but no such document
  exists (a typo, a deleted depósito, a ref naming another collection). This is
  the dangerous one: the estoque filter matches nothing, so the sweep publishes
  **quantity 0 across the whole conta**, taking its listings out of sale.
- **`DIFERE DO LEGADO`** — the expected state for any conta the decision applies
  to. Not a defect; use `--delta` to size the change and tell whoever watches
  the ML account what to expect.

The same correction is waiting for every other channel when it is ported, since
the legacy sender was cross-channel.

## ⚠️ Callback-URL cutover — coordinate with the legacy Flutter functions

The Step-6 pipeline processes notifications through a **Cloud Tasks queue** and
persists to the **top-level** `notificacoesMercadoLivre` collection **only on
failure** (retry-exhaustion / no-account / unknown topic). The still-running
Flutter app watches that same collection — it likewise only stored a doc on a
processing error.

**When you switch a seller's ML notifications callback URL to this backend's
`/api/webhooks/mercado-livre`, you MUST disable the legacy Flutter notification
functions in the same window.** Two overlap hazards otherwise: (1) any failure
doc this backend writes fires the legacy created/updated trigger, which fetches
the resource and mutates `pedidos`/`produtos` — a double-process; (2) the legacy
sweep scans the same collection and reprocesses. Same cutover discipline as the
estoque functions. Until the cutover the callback URL still points at Flutter and
this backend's queue never runs — so there is no overlap either side of a
_correctly sequenced_ cutover.

### What you actually disable

The legacy ML backend is a set of **Cloud Run services** (deployed via
`functions_framework` from `.old/packages/canais_de_venda/mercado_livre`; deploy
commands in `.old/docker-repos-local`). The Dart `@CloudFunction` entrypoints and
their handler functions are what you read in the source — they are **not** what
you find in the console. Disable the SERVICE (or delete its Eventarc trigger);
the handler names are listed only so you can match the two:

| Cloud Run service (what you disable) | Eventarc trigger                                                                                                       | Dart handler                        | Replaced here by                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| `notifications-ml-rt`                | `notifications-ml-rt--created-trigger`, `notifications-ml-rt--updated-trigger` (on `notificacoesMercadoLivre/{notif}`) | `notificationMercadoLivreRealTime`  | `processMercadoLivreNotification`                  |
| `notifications-ml-periodic`          | — (Cloud Scheduler)                                                                                                    | `manageNotificationsMercadoLivre`   | `reprocessMercadoLivreNotifications`               |
| `notifications-ml-2`                 | —                                                                                                                      | `notificationMercadoLivreRealTime2` | `processMercadoLivreNotification`                  |
| `estoque-ml-periodic`                | — (Cloud Scheduler)                                                                                                    | —                                   | `sweepMercadoLivreStock` + `sendMercadoLivreStock` |
| `nfe-ml`                             | `nfe-ml--updated-trigger` (**us-east1**)                                                                               | `enviarNFePedidoMercadoLivre`       | `onNfeAprovada` + `processMercadoLivreNfeUpload`   |

`nfe-ml` is the one hard cutover with its own sequenced steps and `gcloud` commands
— see "⚠️ HARD CUTOVER" above; do not duplicate that work here. `estoque-ml-periodic`
is the "legacy Flutter stock sender" the stock-flag section refers to. There is also a
`notifications-ml-recebedor` service in the legacy deploy script, but it is **commented
out** and not deployed — do not go hunting for it.

### ⚠️ MUST SURVIVE — do not delete `mercadoLivreToken`

The legacy Python callable **`mercadoLivreToken`** is **not** part of the cutover and
must stay deployed until the Flutter app stops refreshing ML tokens. It is the
Flutter app's token-refresh proxy: an auth-gated callable that injects the ML client
secret server-side and forwards to the ML/MP auth hosts.

- Source: `.old/functions_python/main.py` (the `@https_fn.on_call` registration) →
  `.old/functions_python/mercadoLivre/tokenClientSecret.py` (the helper).
- Region **us-east1**, secret `client_secret_mercado_livre`.

Deleting it early is a second way to kill the legacy ML integration — the Flutter app
loses its ability to refresh, and every connected account's token dies at expiry.

⚠️ **It is also load-bearing for Mercado Pago.** The sibling callable `mercadoPagoToken`
delegates to the **same** `mercadoLivre/tokenClientSecret.py` helper with
`client_secret_mercado_pago`. Deleting that module — or decommissioning the Python
functions codebase as "the ML legacy" — breaks Mercado Pago's token proxy too.
