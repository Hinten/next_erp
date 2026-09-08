# Deploying the Shopee Cloud Functions (codebase `shopee`)

These functions are a **deploy-artifact sub-build** of `@delfrance/shopee-app`
— not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. Mirrors `apps/mercado-pago/functions`, with the deferred-lane sweep
from `apps/mercado-livre/functions`.

> Deploy is **manual and coordinated** — agents never run `firebase deploy`
> (root `CLAUDE.md`, Critical rules) — and never let a stray `firebase deploy`
> push rules. No config in this channel declares a `firestore`/`storage` block,
> so none of them can.

## ⚠️ The config exists; the deploy has never been run

`firebase.shopee.deploy.json` shipped in step 3 (#1511) — **inert**. A config
file deploys nothing on its own, and the deploy itself stays a manual,
coordinated human step (root `CLAUDE.md` rule 8). What master-plan **step 22
(#1530)** still owns is the ROLLOUT: `firebase.shopee.json` (the Firestore-only
emulator config) and the second lane job, `apphosting.yaml`'s `vpcAccess` and the
real `SHOPEE_TASKS_REGION` value, and flipping `implementado`.

Nothing here is blocked on that rollout: until the queue exists the receiver
falls back to persisting each push as `failed` and the 30-minute sweep drains it,
so pushes are not lost (see `SHOPEE_TASKS_DISABLED` in the root `.env.example`).

`tools/deploy-env/preflight.mjs` carries a `shopee` row — now wired as this
config's first `predeploy` step — and `tools/deploy-env/bundle-inlining.test.js`
builds this codebase's `build.mjs` in `CI test`, so the region really does reach
the bundle, proven before the first deploy.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/shopee/node_modules`).
- The App Hosting backend for `apps/shopee` created in the Firebase console.
- Env / secrets on the deployed function: `FIREBASE_PROJECT_ID` + admin creds,
  plus `SHOPEE_PARTNER_ID` and `SHOPEE_PARTNER_KEY` in Secret Manager (see
  **Secrets** below — both are `secrets:` on two of the three triggers).
- **Region match**: the App Hosting backend must enqueue onto the queue in the
  function's region. The enqueuer resolves it from
  `SHOPEE_TASKS_REGION ?? FUNCTIONS_REGION`, and there is **no default** — an
  unset value THROWS on the first enqueue rather than producing a well-formed
  path to a queue that does not exist. App Hosting / Cloud Run does NOT expose
  its own region as an env var (only the metadata server does), so it has to be
  configured: set `SHOPEE_TASKS_REGION` on the App Hosting env to whatever
  `FUNCTIONS_REGION` the deploying shell inlined into this bundle. A mismatch is
  the #1108 failure — the Admin SDK targets `us-central1`, the task is
  **silently dropped**, and the receiver still answers 204.
  ⚠️ `apps/shopee/apphosting.yaml` ships that entry with a **blank** value
  today, deliberately: blank reads as unset, so the enqueue throws and the sweep
  drains — loud and lossless — rather than aiming at a queue that is not there.
  Filling it in is part of step 22 / #1530.
- **One-time IAM** (see below) — required before the callback URL cutover
  (#1534) so the receiver can enqueue.

## Deploy

> ⚠️ **A human runs this, in a coordinated window** — never an agent, never
> unannounced (root `CLAUDE.md` rule 8). Export `TASKS_INVOKER_SA` and
> `FUNCTIONS_REGION` first (both below); the preflight refuses the deploy
> without them.

```bash
# from the repo root
firebase deploy --only functions:shopee \
  --config firebase.shopee.deploy.json \
  --project <project-id>
```

The `predeploy` hook runs `node tools/deploy-env/preflight.mjs shopee` and then
`node apps/shopee/functions/scripts/prepare-deploy.mjs`. To inspect the bundle
locally without deploying: `node apps/shopee/functions/build.mjs` (writes
`dist/index.js`), or `node apps/shopee/functions/scripts/prepare-deploy.mjs` for
the full servable folder at `.deploy/shopee-functions`. Both need
`FUNCTIONS_REGION` set — `requireBuildRegion` throws without it, on purpose.

## Functions in this codebase

| Export                           | Trigger                                | Purpose                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processShopeeNotification`      | `onTaskDispatched` (Cloud Tasks queue) | #1511 — process one queued Shopee push: dispatch on the **push code**, run the conta arms (1 / 2 / 12), park a code whose handler is not built yet. Rate-limited + retry-with-backoff; the receiver enqueues and answers 204. Persists to `notificacoesShopee` only on retry-exhaustion / park / defer. |
| `reprocessShopeeNotifications`   | `onSchedule('every 30 minutes')`       | #1511 — the backstop, draining BOTH lanes on one tick: `failed` pushes older than 1 h (hot) and pushes whose `shop_id` matches no active integração (deferred, 24 h window). Logged separately — summing them would hide a growing deferred backlog inside a healthy `processed`.                       |
| `sweepShopeeAuthorizationExpiry` | `onSchedule('0 4 * * 1')`              | #1511 / master-plan P8 — the WEEKLY authorization-expiry sweep. Walks `get_shops_by_partner` (PUBLIC-signed, reads no token anywhere) and raises the `shopeeAutorizacaoExpirando` aviso at ≤ 30 days, resolving it once a re-consent pushes the clock back out.                                         |

### Secrets: `SHOPEE_PARTNER_ID` + `SHOPEE_PARTNER_KEY`

Both are declared as `secrets:` on the **queue handler** and on the **weekly
sweep**, because both can reach a PUBLIC-signed Shopee call (`shopeeConfig()` →
`createShopeePartnerClient`). Without the bindings neither fails at startup:
`ShopeeConfigError` is raised on the first call, the pipeline treats it as
transient, and the symptom is retries and parked documents rather than anything
that names the missing secret. Grant them before the first real push.

`reprocessShopeeNotifications` carries them too — a re-drive runs the same conta
arms as the original delivery.

### Durability & the residual loss window

A push is durable once it is either (a) processed, or (b) persisted as `failed`
for the sweep. Two narrow windows remain:

- The task handler persists a `failed` doc only on its **final** attempt. If
  Firestore is unavailable for that whole retry window (a _correlated_ outage —
  the same Firestore the handler reads and writes), the final persist also
  fails. It logs and re-throws so the failed final attempt shows in Cloud Tasks'
  error metrics, but the push is lost and Shopee already got its 204.
- Shopee's own retry ladder (+5 min / +30 min / +3 h) ends in the **lost-push
  queue**, which `get_lost_push_message` can replay for 3 days — that sweep is
  step 4, not built yet. Until it is, a push that fails every one of Shopee's
  retries AND our persist is gone.

⚠️ A sustained non-2xx rate is worse than a lost push: >600 pushes / 6 h with
<30 % success **auto-disables the subscription**, and a disabled subscription
loses everything not already in the lost-push queue. That is why the receiver
answers 204 on every path it can and never converts an enqueue failure into a
5xx.

## ⚠️ One-time IAM — the App Hosting backend enqueues Cloud Tasks

The receiver route (`/api/webhooks/shopee`, on the App Hosting backend) enqueues
onto the `processShopeeNotification` queue via `firebase-admin`'s
`getFunctions().taskQueue(...).enqueue(...)`. That requires the **App Hosting
runtime service account** to be able to enqueue tasks and act as the functions'
invoker SA — grant these **once**, before switching the push callback URL
(#1534):

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
gcloud run services add-iam-policy-binding processShopeeNotification --region=<region> \
  --member="serviceAccount:<apphosting-runtime-sa>" \
  --role="roles/run.invoker"
```

### The deploy aborts if `TASKS_INVOKER_SA` is missing (#1133)

`firebase.shopee.deploy.json`'s `predeploy` hook runs
`node tools/deploy-env/preflight.mjs shopee` **before** the artifact is built.
It prints every build-time value about to be baked into the bundle — and whether
each came from your shell or from a `build.mjs` default — then refuses to
continue if either of these is true:

- **`TASKS_INVOKER_SA` is unset or blank.** Without it `invoker` is omitted, no
  `roles/run.invoker` is granted, and the dispatch leg 403s _after_ the enqueue
  reported success — so nothing writes a failure document anywhere.
- **the task/schedule region has no Cloud Tasks.** That deploy fails every queue
  and schedule function at once while any Firestore trigger succeeds — the
  asymmetric failure list from #1108, refused up front instead.

Run it by hand any time; it changes nothing:

```bash
node tools/deploy-env/preflight.mjs shopee
```

⚠️ It does **not** run in CI. `predeploy` hooks are skipped under
`emulators:exec`, which is deliberate — the emulators have no IAM layer, so
`ci-shopee.yml` is unaffected either way and builds the artifact itself.

### `TASKS_INVOKER_SA` — the third role, applied by the deploy (#1133)

Export it in the shell you run `firebase deploy` from. `build.mjs` inlines it
(esbuild `define`, exactly like `FUNCTIONS_REGION`) and the `onTaskDispatched`
in this codebase declares it as `invoker`; firebase-tools then applies the list
to **both** legs of the trip — `roles/run.invoker` on the function's Cloud Run
service **and** `roles/cloudtasks.enqueuer` on its queue.

```bash
export TASKS_INVOKER_SA="<apphosting-runtime-sa>,<functions-runtime-sa>"
firebase deploy --only functions:shopee \
  --config firebase.shopee.deploy.json \
  --project <project-id>
```

⚠️ **Name every enqueuer, comma-separated** — drop the duplicate when the two
are the same identity. A deploy **replaces** the members of both bindings, so an
identity left out **loses** the role. Today the receiver route is the only
enqueuer; list the functions runtime SA anyway, because a handler that
re-enqueues makes it one and rediscovering the 403 later is the expensive path.

⚠️ **Unset ⇒ the option is omitted entirely.** The build prints a warning and
the manual `gcloud run services add-iam-policy-binding` above stays required. It
never guesses a value: a wrong one would lock out the legitimate caller, and a
permissive one would be far worse.

⚠️ A redeploy with **no** `invoker` declared does not clear an existing binding
— firebase-tools skips `setInvokerUpdate` when the option is absent — but a
service **create**, i.e. a new or renamed task function, leaves no binding at
all. That silent case is what this variable exists for.

Verify it took, with nobody having run gcloud:
`gcloud run services get-iam-policy processShopeeNotification --region=<region>`.

Until this is granted the enqueue fails; the receiver then **falls back** to
persisting the push as `failed` (the reprocess sweep drains it) and still answers
204 — so pushes are not lost, but the intended rate-limited queue path is
inactive. Verify the queue exists after the first deploy:
`gcloud tasks queues describe processShopeeNotification --location=<region>`.

## What CI proves, and what it does not

`ci-shopee.yml` runs `Shopee Cloud Tasks round trip`: the real receiver → the
real region-qualified enqueue → the tasks emulator → the real
`processShopeeNotification` → a real Firestore document. `ci.yml`'s `CI test`
runs every unit suite in this app, this codebase included.

Two gaps to know about:

- **The two `onSchedule` triggers never execute in CI.** The functions emulator
  logs them as "ignored because the pubsub emulator does not exist or is not
  running", so the lane loads them and nothing drives them. Their bodies are
  covered by unit tests and their _options_ — the `'0 4 * * 1'` cron, the
  `America/Sao_Paulo` zone, `timeoutSeconds: 540` and the exact `secrets:` set —
  by `src/index.test.ts`, which asserts over `__endpoint` exactly as
  `processNotification.test.ts` does for the queue handler (#778 is the worked
  example of that gap costing a silently inert sweep). What no test can show is
  that Cloud Scheduler actually fires them; the first real proof is the deploy.
- **Nothing here proves the composite indexes are declared.** The emulator
  auto-creates every composite and on Enterprise a missing one does not throw —
  it full-scans and bills the scan. The two Shopee composites deploy in the
  migration window (#1532).

## Cutover

There are **no legacy Flutter Shopee Cloud Functions to coordinate with.** The
legacy stack had no server-side Shopee receiver at all — its push handling and
token store are the anti-patterns the shared seams replaced (master plan §3), and
it never wrote a `pedshopee`. So this codebase does not race a predecessor for a
document, and the only coordination it owes is the ORDER of the window steps:
grant the IAM above, deploy this codebase, deploy the App Hosting backend, and
only THEN register the push callback URL with Shopee (#1534). Registering first
means every delivery arrives at a backend whose queue does not exist — each one
persisted as `failed` and drained late, at best.
