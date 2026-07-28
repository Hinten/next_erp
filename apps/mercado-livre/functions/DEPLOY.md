# Deploying the Mercado Livre Cloud Functions (codebase `mercado-livre`)

These functions are a **deploy-artifact sub-build** of `@delfrance/mercado-livre-app`
— not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. `firebase.mercado-livre.deploy.json` points `source` at the generated
`.deploy/mercado-livre-functions`.

> Deploy is **manual and coordinated** (CLAUDE.md critical rule #1) — never let a
> stray `firebase deploy` push rules. This config has no `firestore`/`storage`
> block, so it can't.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/mercado-livre/node_modules`).
- The App Hosting backend for `apps/mercado-livre` created in the Firebase console
  (GCP-side; not declared in any repo config).
- Env / secrets on the deployed function: `FIREBASE_PROJECT_ID` + admin creds; and,
  once the ML API calls are wired (Phase 5), `MERCADO_LIVRE_CLIENT_SECRET` via
  `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_SECRET` (declared in
  `src/options.ts`). `processMercadoLivreMassImport` additionally needs
  `MERCADO_LIVRE_CLIENT_ID` (bound per-function — see below):
  `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_ID --project <project-id>`.
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

| Export                               | Trigger                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `importMercadoLivreOrders`           | `onSchedule('every 15 minutes')`       | Incremental order pull per connected account (#362) — **skeleton no-op** until that milestone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `processMercadoLivreNotification`    | `onTaskDispatched` (Cloud Tasks queue) | Step 6 — process a queued ML notification (resolve account by `user_id`, dispatch by topic). Rate-limited + retry-with-backoff; the receiver enqueues, this runs in-process. Persists to `notificacoesMercadoLivre` ONLY on retry-exhaustion / no-account / unknown topic.                                                                                                                                                                                                                                                                                                                                                                                      |
| `reprocessMercadoLivreNotifications` | `onSchedule('every 30 minutes')`       | Step 6 — reprocess backstop for persisted `failed` notifications older than 1h (deletes on success, parks at the cap).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `processMercadoLivreMassImport`      | `onTaskDispatched` (Cloud Tasks queue) | Step 8 (#621) — "Importar todos os anúncios": scans the seller's full listing via `scanSellerItems`, drains up to `MASS_IMPORT_ITEMS_PER_DISPATCH` items per dispatch through `importProduto`, and re-enqueues itself onto its OWN queue until the job (`importacoesMercadoLivre/{jobId}`) is exhausted. Single in-flight dispatch (`maxConcurrentDispatches: 1`) since the job doc is the checkpoint. Binds `MERCADO_LIVRE_CLIENT_ID`/`MERCADO_LIVRE_CLIENT_SECRET` from Secret Manager per-function (see `src/options.ts`) for the ML token refresh.                                                                                                          |
| `sweepMercadoLivreStock`             | `onSchedule('every 15 minutes')`       | Step 10 PR C — the **incremental** stock sweep: per conta it runs THE produtos-first joined discovery from the durable cursor (`estoqueMercadoLivreSync/{integracaoId}`), applies the 30-day activity filter and enqueues one `sendMercadoLivreStock` task per ML call. Bounded pages + tasks per tick; a truncated tick persists `continuacao` (frozen window + keyset) and the NEXT tick resumes it. Skips a conta whose 429 `pausedUntilUs` is still live, and skips ONLY the 02:00 America/Sao_Paulo tick in code (`isSlotDoDaily` — that slot belongs to the daily sweep; 02:15/30/45 run normally). **No-op until `MERCADO_LIVRE_STOCK_SYNC_ENABLED=1`.** |
| `sweepMercadoLivreStockDaily`        | `onSchedule('0 2 * * *')`              | Step 10 PR C — the **daily** full-reconciliation sweep, 02:00 America/Sao_Paulo: the same discovery over a flat 24h window (`MERCADO_LIVRE_STOCK_DAILY_WINDOW_H`), with no activity filter and no pedidos probe. It owns its slot alone — the incremental wrapper skips exactly the 02:00 tick — so the two never contend for one conta's caps and state doc. Same flag, same no-op while OFF.                                                                                                                                                                                                                                                                  |

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

## Runtime env (stock sync, Step 10)

The stock sync has no Secret Manager needs of its own — every knob is a
**non-secret** value read LAZILY from `process.env` by the getters in
`lib/marketplace/estoquePlan.ts` (unset/blank/invalid → the code default), plus
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
3. `apps/mercado-livre/.env.example` — **Next local dev only.** It documents the
   same names for the App Hosting backend (which loads the repo-root
   `.env.local`), and that env does **not** reach this separate functions
   codebase — the same caveat the mass-import secrets carry above.

### Setting (1) — the honest state of the mechanism

firebase-tools' documented lane for gen2 runtime env vars is a `.env` /
`.env.<project-id>` file in the functions **source** directory. Here that
directory is the generated `.deploy/mercado-livre-functions`, and
`scripts/prepare-deploy.mjs` opens with
`rmSync(deployDir, { recursive: true, force: true })` — it **wipes and
regenerates the whole folder** as the `predeploy` hook, i.e. after you would
have dropped a file in it and before firebase reads the source. So a hand-placed
`.env` there does not survive; there is no `--no-predeploy` escape hatch either.
Two lanes work today:

- **Post-deploy on Cloud Run** (a gen2 function IS a Cloud Run service, named
  after the function in lowercase). After the deploy, per function:

  ```bash
  gcloud run services list --project <project-id>   # confirm the service names
  gcloud run services update sweepmercadolivrestock \
    --region <functions-region> --project <project-id> \
    --update-env-vars MERCADO_LIVRE_STOCK_SYNC_ENABLED=1
  # repeat for sweepmercadolivrestockdaily and sendmercadolivrestock
  ```

  ⚠️ Treat this as **not surviving a redeploy**: `firebase deploy` rewrites the
  service's env from what it computes for the source (an empty `.env` set), so
  re-apply and re-verify (`gcloud run services describe … --format='value(spec.template.spec.containers[0].env)'`)
  after every functions deploy.

- **Bind it as a secret** — the mechanism this codebase already proves works
  per-function (`firebase functions:secrets:set` + the `secrets: [...]` option,
  see the mass-import section). It survives redeploys, but it costs a code edit
  per variable and Secret Manager is the wrong tool for a non-secret tunable, so
  it is worth it only for the master flag, if at all.

The durable fix is to have `prepare-deploy.mjs` copy a committed-out
`apps/mercado-livre/functions/.env.<project-id>` into the artifact **after** the
wipe, which turns lane 1 into plain firebase-tools behaviour. That change is not
part of PR C — track it before the cutover if you want a repeatable flip.

`MERCADO_LIVRE_ORDER_BACKFILL_ENABLED` (Step 9's order-backfill sweep) rides
**exactly the same mechanism** and has the same constraint — it was never
documented here, which is why the sweep has been shipping dark.

### ⚠️ The flag ships OFF — flip it only at the coordinated cutover

`MERCADO_LIVRE_STOCK_SYNC_ENABLED` is unset in every environment. Both sweeps
and the send handler deploy, tick and do nothing while it is off, which is the
intended steady state until the cutover. Flip it to `1` **only in the same
window the legacy Flutter stock sender is disabled** — the two writing
`available_quantity` for the same listings at once is the exact double-send
hazard the callback-URL cutover below describes for notifications. Order of
operations: the new Firestore indexes deployed and verified (`scripts/check-stock-indexes.mjs`)
→ functions deployed with the flag OFF → legacy Flutter stock sender disabled →
flag flipped to `1` → watch the first incremental tick (expect a one-time
correction burst: the anchor's own estoque is now a first-class change trigger,
which the legacy query excluded).

## ⚠️ Callback-URL cutover — coordinate with the legacy Flutter functions

The Step-6 pipeline processes notifications through a **Cloud Tasks queue** and
persists to the **top-level** `notificacoesMercadoLivre` collection **only on
failure** (retry-exhaustion / no-account / unknown topic). The still-running
Flutter app watches that same collection with its own `onCreate` trigger
(`notificationMercadoLivreRealTime`) + periodic sweep
(`manageNotificationsMercadoLivre`) — it likewise only stored a doc on a
processing error.

**When you switch a seller's ML notifications callback URL to this backend's
`/api/webhooks/mercado-livre`, you MUST disable the legacy Flutter notification
functions in the same window.** Two overlap hazards otherwise: (1) any failure
doc this backend writes fires the legacy `onCreate` trigger, which fetches the
resource and mutates `pedidos`/`produtos` — a double-process; (2) the legacy
sweep scans the same collection and reprocesses. Same cutover discipline as the
estoque functions. Until the cutover the callback URL still points at Flutter and
this backend's queue never runs — so there is no overlap either side of a
_correctly sequenced_ cutover.
