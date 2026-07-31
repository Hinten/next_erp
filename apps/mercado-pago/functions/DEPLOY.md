# Deploying the Mercado Pago Cloud Functions (codebase `mercado-pago`)

These functions are a **deploy-artifact sub-build** of `@delfrance/mercado-pago-app`
— not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. `firebase.mercado-pago.deploy.json` points `source` at the generated
`.deploy/mercado-pago-functions`. Mirrors `apps/mercado-livre/functions`,
adapted marketplace → payments.

> Deploy is **manual and coordinated** — agents never run `firebase deploy` (root `CLAUDE.md`, Critical rules) — never let a
> stray `firebase deploy` push rules. This config has no `firestore`/`storage`
> block, so it can't.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/mercado-pago/node_modules`).
- The App Hosting backend for `apps/mercado-pago` created in the Firebase console
  (GCP-side; not declared in any repo config — tracked in #564).
- Env / secrets on the deployed function: `FIREBASE_PROJECT_ID` + admin creds.
- **Region match**: the App Hosting backend must enqueue onto the queue in the
  function's region. The enqueuer resolves the region from
  `MERCADO_PAGO_TASKS_REGION ?? FUNCTIONS_REGION ?? us-east5` (App Hosting / Cloud
  Run does NOT expose its own region as an env var — only the metadata server
  does — so it must be configured). Both the functions (build.mjs) and the
  enqueuer default to **us-east5**; if you deploy the functions to another region,
  set `MERCADO_PAGO_TASKS_REGION` (or `FUNCTIONS_REGION`) on the App Hosting env
  to match. A wrong/absent region makes the Admin SDK target `us-central1` and the
  task **silently drops**.
- **One-time IAM** (see the dedicated section below) — required before the callback
  cutover so the receiver can enqueue.

## Deploy

```bash
# from the repo root
firebase deploy --only functions:mercado-pago \
  --config firebase.mercado-pago.deploy.json \
  --project <project-id>
```

The `predeploy` hook builds the artifact automatically. To inspect the bundle
locally without deploying: `node apps/mercado-pago/functions/build.mjs` (writes
`dist/index.js`).

## Functions in this codebase

| Export                              | Trigger                                | Purpose                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processMercadoPagoNotification`    | `onTaskDispatched` (Cloud Tasks queue) | #531 — process a queued MP notification (resolve `metodo_pgto` by collector `user_id`, verify-by-refetch, map, reconcile). Rate-limited + retry-with-backoff; the receiver enqueues, this runs in-process. Persists to `notificacoesMercadoPago` ONLY on retry-exhaustion / no-account / unresolvable pedido. |
| `reprocessMercadoPagoNotifications` | `onSchedule('every 30 minutes')`       | #531 — reprocess backstop for persisted `failed` notifications older than 1h (deletes on success, parks at the cap).                                                                                                                                                                                          |

### Durability & the residual loss window

A notification is durable once it is either (a) processed, or (b) persisted as
`failed` for the sweep. There is one narrow residual-loss window: the task
handler persists a `failed` doc only on its **final** attempt, and if Firestore
is unavailable for that whole retry window (a _correlated_ outage — the same
Firestore the handler both reads and writes), the final persist also fails. The
handler then logs the dropped notification and re-throws so the failed final
attempt is visible in Cloud Tasks' error metrics, but the notification is lost
(nothing persisted → the sweep can't see it, and MP already got its 200). This
requires a Firestore outage longer than the queue's backoff window. Alert on
`processMercadoPagoNotification`'s failed final attempts.

## ⚠️ One-time IAM — the App Hosting backend enqueues Cloud Tasks

The receiver route (`/api/webhooks/mercado-pago`, on the App Hosting backend)
enqueues onto the `processMercadoPagoNotification` queue via
`firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`. That requires the
**App Hosting runtime service account** to be able to enqueue tasks and act as the
functions' invoker SA — grant these **once**, before switching the webhook URL:

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
`gcloud tasks queues describe processMercadoPagoNotification --location=<region>`.

## ⚠️ Cutover — coordinate with the legacy Flutter MP functions

This deploy is one step of the tracked chore in **#564** (backend creation,
secrets, webhook registration, cutover). Do not register the new webhook URL
with Mercado Pago until this functions codebase is deployed AND the IAM grants
above are in place.

**When you register `https://<mp-backend>/api/webhooks/mercado-pago` as the
notification URL for a connected account, you MUST disable the legacy Flutter
Cloud Run services (`distribuidorDeNotificacoesMercadoPago`,
`updateGrupoEconomicoMercadoPago`) for that same account in the same window.**
Both sides reconcile the same `pedido`/payment state from the same MP payment —
running both concurrently double-processes a notification. Until the cutover
the webhook URL still points at the legacy services and this backend's queue
never runs, so there is no overlap either side of a _correctly sequenced_
cutover. See #564 for the full step-by-step (application creation, secrets,
webhook registration, re-consent, legacy service teardown).
