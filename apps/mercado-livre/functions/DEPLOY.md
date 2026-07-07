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
  `src/options.ts`).
- **Region match**: the App Hosting backend must enqueue onto the queue in the
  function's region. The enqueuer resolves the region from
  `MERCADO_LIVRE_TASKS_REGION ?? FUNCTIONS_REGION ?? us-east1` — set
  `MERCADO_LIVRE_TASKS_REGION` (or `FUNCTIONS_REGION`) on the App Hosting env to
  the region these functions deploy to. A wrong/absent region makes the Admin SDK
  target `us-central1` and the task **silently drops**.
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

| Export                               | Trigger                                | Purpose                                                                                                                                                                                                                                                                    |
| ------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `importMercadoLivreOrders`           | `onSchedule('every 15 minutes')`       | Incremental order pull per connected account (#362) — **skeleton no-op** until that milestone.                                                                                                                                                                             |
| `processMercadoLivreNotification`    | `onTaskDispatched` (Cloud Tasks queue) | Step 6 — process a queued ML notification (resolve account by `user_id`, dispatch by topic). Rate-limited + retry-with-backoff; the receiver enqueues, this runs in-process. Persists to `notificacoesMercadoLivre` ONLY on retry-exhaustion / no-account / unknown topic. |
| `reprocessMercadoLivreNotifications` | `onSchedule('every 30 minutes')`       | Step 6 — reprocess backstop for persisted `failed` notifications older than 1h (deletes on success, parks at the cap).                                                                                                                                                     |

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
