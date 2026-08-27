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
# ⚠ THE THIRD ROLE, and the one everyone forgets. Enqueuing is only half the
# trip: Cloud Tasks then DISPATCHES the task, presenting an OIDC token whose
# principal is the enqueuer's own identity - and a gen2 function is a Cloud Run
# service, so that principal needs run.invoker ON THE SERVICE. Without it the
# task is created and delivered and the service answers 403 run.routes.invoke,
# with NO failure document written anywhere.
#
# ⚠ SINCE #1133 THE DEPLOY DOES THIS FOR YOU when TASKS_INVOKER_SA is set (see
# below). Run it by hand only for a deploy without that variable.
gcloud run services add-iam-policy-binding processMercadoPagoNotification --region=<region> \
  --member="serviceAccount:<apphosting-runtime-sa>" \
  --role="roles/run.invoker"
```

### The deploy aborts if `TASKS_INVOKER_SA` is missing (#1133)

`predeploy` runs `node tools/deploy-env/preflight.mjs mercado-pago` **before** the
artifact is built. It prints every build-time value that is about to be baked into
the bundle — and whether each came from your shell or from a `build.mjs` default —
then refuses to continue if either of these is true:

- **`TASKS_INVOKER_SA` is unset or blank.** Without it `invoker` is omitted, no
  `roles/run.invoker` is granted, and the dispatch leg 403s _after_ the enqueue
  reported success — so nothing writes a failure document anywhere. This used to be
  a `console.warn` that scrolled past.
- **the task/schedule region has no Cloud Tasks** (`us-east5`). That deploy fails
  every queue and schedule function at once while the Firestore triggers succeed —
  the asymmetric failure list from #1108, now refused up front instead.

Run it by hand any time; it changes nothing:

```bash
node tools/deploy-env/preflight.mjs mercado-pago
```

⚠️ It does **not** run in CI. `predeploy` hooks are skipped under
`emulators:exec`, which is deliberate — the emulators have no IAM layer, so the
lanes are unaffected either way.

### `TASKS_INVOKER_SA` — the third role, applied by the deploy (#1133)

Export it in the shell you run `firebase deploy` from. `build.mjs` inlines it
(esbuild `define`, exactly like `FUNCTIONS_REGION`) and every `onTaskDispatched`
in this codebase declares it as `invoker`; firebase-tools then applies the list
to **both** legs of the trip — `roles/run.invoker` on each function's Cloud Run
service **and** `roles/cloudtasks.enqueuer` on its queue.

```bash
export TASKS_INVOKER_SA="<apphosting-runtime-sa>,<functions-runtime-sa>"
firebase deploy --only functions:mercado-pago \
  --config firebase.mercado-pago.deploy.json \
  --project <project-id>
```

⚠️ **Name every enqueuer, comma-separated** — drop the duplicate when the two are
the same identity. A deploy **replaces** the members of both bindings, so an
identity left out **loses** the role.

Today the receiver route is the only enqueuer, but the functions runtime SA
becomes one the moment a handler re-enqueues — list it now rather than
rediscovering the 403 later.

⚠️ **Unset ⇒ the option is omitted entirely.** The build prints a warning and the
manual `gcloud run services add-iam-policy-binding` above stays required. It
never guesses a value: a wrong one would lock out the legitimate caller, and a
permissive one would be far worse. Failing toward the documented status quo is
the intended behaviour.

⚠️ A redeploy with **no** `invoker` declared does not clear an existing binding —
firebase-tools skips `setInvokerUpdate` when the option is absent — but a service
**create**, i.e. a new or renamed task function, leaves no binding at all. That
silent case is what this variable exists for.

Verify it took, with nobody having run gcloud:
`gcloud run services get-iam-policy processMercadoPagoNotification --region=<region>`.

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
⚠️ **Correction (2026-08-21).** This used to justify the step with "both sides
reconcile the same `pedido`/payment state … running both concurrently
double-processes a notification". **That reason is void — there is no dual run**
(root `CLAUDE.md` rule 8). The legacy stack writes only the legacy project, so
the two never touch one document. What is genuinely shared is the **Mercado Pago
account**: both stacks hold live credentials for it, so a legacy service left
running keeps acting on the seller's real MP account and burning its rate limit.

⚠️ **MP's legacy receiver is a forwarding ROUTER, not an ack-fast enqueuer — do
not copy the ordering rule from the Mercado Livre runbook.**
`distribuidorDeNotificacoesMercadoPago`
(`.old/packages/pagamento/mercado_pago/lib/functions.dart:18-58`) resolves
`targetInstanceUid` against
`GrupoEconomcioPrivateData.mercadoPagoInstanceIdMercadoPagoUrlMap`, POSTs the body
to that per-instance URL, and **propagates the downstream status** (non-200 →
`Response.internalServerError()`).

⚠️ **Nothing in that router ever acks a message it did not deliver.** Every miss
path answers non-2xx, so MP retries rather than dropping — verified line by line:
no `targetInstanceUid` → `404` (bar the `test.created` ping, which is a real 200
for a real no-op); no matching `grupoEconomico` → `404`; a map entry missing for
the instance → the `!` on line 43 throws, i.e. a 500. **MP therefore has no
ack-and-drop hazard at all, on any path** — which is the whole reason its ordering
differs from ML's and WhatsApp's.

### ⚠️ Two possible flips — establish WHICH before the window

The URL MP is registered against may be the router's or this backend's, and the
two give **opposite** instructions. Executing the wrong one is an outage.

**(a) The registration is in MP's dashboard, pointing at the router.** Then the
flip is a **map edit**: repoint `mercadoPagoInstanceIdMercadoPagoUrlMap[instance]`
at `https://<mp-backend>/api/webhooks/mercado-pago`, verify a live delivery
arrives _through_ the router, and **leave
`distribuidorDeNotificacoesMercadoPago` running** — it is still the delivery path.
Only `updateGrupoEconomicoMercadoPago` (the map's writer) is disabled here.

**(b) The registration points at this backend directly.** Then the map is
irrelevant, and the MUST above applies as written: register the URL, then disable
both legacy services.

⚠️ **Under (a), obeying that MUST is an outage** — it takes down the router that
is still delivering. The bolded instruction assumes (b); do not run it until the
registration layer is confirmed. Tracked as an open question alongside the same
one for Mercado Livre.

Until the cutover the webhook URL still points at the legacy services and this
backend's queue never runs, so there is no overlap either side of a _correctly
sequenced_ cutover. See #564 for the full step-by-step (application creation,
secrets, webhook registration, re-consent, legacy service teardown).
