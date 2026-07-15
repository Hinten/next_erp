# Deploying the WhatsApp Cloud Functions (codebase `whatsapp`)

These functions are a **deploy-artifact sub-build** of `@delfrance/whatsapp-app`
— not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. `firebase.whatsapp.deploy.json` points `source` at the generated
`.deploy/whatsapp-functions`. Mirrors `apps/mercado-pago/functions`, adapted
payments → whatsapp.

> Deploy is **manual and coordinated** (CLAUDE.md critical rule #1) — never let a
> stray `firebase deploy` push rules. This config has no `firestore`/`storage`
> block, so it can't.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/whatsapp/node_modules`).
- The App Hosting backend for `apps/whatsapp` created in the Firebase console
  (GCP-side; not declared in any repo config).
- Env / secrets on the deployed function: `FIREBASE_PROJECT_ID` + admin creds.
- **Region match**: the App Hosting backend must enqueue onto the queue in the
  function's region. The enqueuer resolves the region from
  `WHATSAPP_TASKS_REGION ?? FUNCTIONS_REGION ?? us-east5` (App Hosting / Cloud
  Run does NOT expose its own region as an env var — only the metadata server
  does — so it must be configured). Both the functions (build.mjs) and the
  enqueuer default to **us-east5**; if you deploy the functions to another region,
  set `WHATSAPP_TASKS_REGION` (or `FUNCTIONS_REGION`) on the App Hosting env
  to match. A wrong/absent region makes the Admin SDK target `us-central1` and the
  task **silently drops**.
- **One-time IAM** (see the dedicated section below) — required before the webhook
  cutover so the receiver can enqueue.

## Deploy

```bash
# from the repo root
firebase deploy --only functions:whatsapp \
  --config firebase.whatsapp.deploy.json \
  --project <project-id>
```

The `predeploy` hook builds the artifact automatically. To inspect the bundle
locally without deploying: `node apps/whatsapp/functions/build.mjs` (writes
`dist/index.js`).

## Functions in this codebase

| Export                           | Trigger                                | Purpose                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processWhatsappNotification`    | `onTaskDispatched` (Cloud Tasks queue) | #527 — process one queued WhatsApp webhook change (resolve `Conta_Whatsapp` by `phone_number_id`, discover/create the contact, create-or-reopen the chat, attach the mensagem, auto-reply, advance status). Rate-limited + retry-with-backoff; the receiver enqueues, this runs in-process. Persists to `notificacoesWhatsapp` ONLY on retry-exhaustion / unresolved account. |
| `reprocessWhatsappNotifications` | `onSchedule('every 30 minutes')`       | #527 — reprocess backstop for persisted `failed` notifications older than 1h (deletes on success, parks at the cap).                                                                                                                                                                                                                                                          |

### Durability & the residual loss window

A notification is durable once it is either (a) processed, or (b) persisted as
`failed` for the sweep. There is one narrow residual-loss window: the task
handler persists a `failed` doc only on its **final** attempt, and if Firestore
is unavailable for that whole retry window (a _correlated_ outage — the same
Firestore the handler both reads and writes), the final persist also fails. The
handler then logs the dropped notification and re-throws so the failed final
attempt is visible in Cloud Tasks' error metrics, but the notification is lost
(nothing persisted → the sweep can't see it, and Meta already got its 200).
Unlike Mercado Pago's pipeline, WhatsApp has **no re-fetch anchor** — the
message content lives only in the webhook body, never re-derivable from a
remote API — so this window is the only way to lose an inbound message. This
requires a Firestore outage longer than the queue's backoff window. Alert on
`processWhatsappNotification`'s failed final attempts.

## ⚠️ One-time IAM — the App Hosting backend enqueues Cloud Tasks

The receiver route (`/api/webhooks/whatsapp`, on the App Hosting backend)
enqueues onto the `processWhatsappNotification` queue via `firebase-admin`'s
`getFunctions().taskQueue(...).enqueue(...)`. That requires the **App Hosting
runtime service account** to be able to enqueue tasks and act as the functions'
invoker SA — grant these **once**, before switching the webhook URL:

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
`gcloud tasks queues describe processWhatsappNotification --location=<region>`.

## ⚠️ Cutover — coordinate with the legacy Flutter WhatsApp functions

The legacy Flutter pipeline runs as two Cloud Run services (deployed via
`functions_framework` from `.old/packages/canais_de_venda/whatsapp_cloud_api`):

- `distribuidorWhastappCloudApi` — the webhook receiver (Meta's GET verify
  handshake + the POST fan-out, which hand-enqueues onto a raw Cloud Tasks
  queue `projects/.../locations/us-east1/queues/whatsapp-cloud-api`).
- `processarNotificacoesWhatsapp` — the queue consumer (`processarNotificacoes`)
  that this codebase's `processWhatsappNotification` replaces.

**Only one of the two pipelines may be registered as Meta's webhook callback
URL at a time.** Both sides create/append the same `Conversa`/`Mensagem` docs
from the same inbound Meta payload — running both concurrently against the
same WhatsApp Business Account double-processes (and double-shows) every
inbound message.

**When you point the Meta App Dashboard's webhook callback URL at
`https://<this-app>/api/webhooks/whatsapp`, you MUST disable
`distribuidorWhastappCloudApi` (or unsubscribe its Meta App subscription) in
the same window**, so a redelivery never lands on both pipelines. Until the
cutover the webhook URL still points at the legacy Cloud Run service and this
backend's queue never runs, so there is no overlap either side of a _correctly
sequenced_ cutover. Verify by tailing this backend's receiver logs for the
first live inbound message before decommissioning `processarNotificacoesWhatsapp`.
