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

Two switches keep it harmless even if it were deployed early, and both stay
exactly as they are until the window:

- **The read switch `LOJA_INTEGRADA_CHAMADAS` stays UNSET.** Only the exact `on`
  lets this code call Loja Integrada at all; the context loader refuses before
  any Firestore read and before it builds a client. There is no sandbox on the
  platform's side and the origin is fixed, so a call is always a live one (D17).
- **The importer seam is empty.** The reads queue's task has no importer yet
  (master-plan step 5), so a task parks as `importador-ausente` and the order
  poller refuses to run while the seam is empty. Nothing in this codebase turns
  a notification into a `pedido` before step 5.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/loja-integrada/node_modules`).
- The App Hosting backend for `apps/loja-integrada` created in the Firebase console.
- Env on the deployed functions: `FIREBASE_PROJECT_ID` + admin creds. **No secrets:**
  the Loja Integrada token lives per conta in Firestore
  (`integracao/{id}/credenciaisLojaIntegrada/current`), so no function declares a
  `secrets:` binding and there is nothing to create in Secret Manager. A
  `secrets:` entry whose secret does not exist fails the whole deploy, which is
  the reason none is declared.
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
> ⚠️ **Into a project that does not hold this queue yet** — which is every
> project until the window — read **the first deploy of a NEW queue crashes on
> the enqueuer binding** under the IAM section below FIRST. On firebase-tools
> 15.28.2 that deploy reports an error for the queue function, with a misleading
> organization-policy message, and the fix is one `gcloud` grant per identity
> plus a re-run.

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

| Export                                | Trigger                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filaLeituraLojaIntegrada`            | `onTaskDispatched` (Cloud Tasks queue) | The ONE reads queue of the channel (order intake now; the import-job and reconcile reads join it later). The body dispatches on the task's `tipo`: `pedido` runs one notification through the pipeline, any other `tipo` is logged and dropped. `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`, `retryConfig` 3 attempts with 60 s → 300 s backoff and one doubling, `timeoutSeconds 300`. **No `secrets:`.** Persists to `notificacoesLojaIntegrada` only on retry-exhaustion, park or defer. |
| `reprocessLojaIntegradaNotifications` | `onSchedule('*/30 * * * *')`           | The backstop, draining BOTH lanes on one tick (`limit 10` each): `failed` notifications older than the hot window, then the deferred lane (a parked conta, an inactive conta, a missing credential, the switch off). Logged separately — summing them would hide a growing deferred backlog inside a healthy `processed`. `America/Sao_Paulo`, `timeoutSeconds 540`.                                                                                                                                                   |
| `sweepLojaIntegradaTokenExpiry`       | `onSchedule('30 6 * * *')`             | The DAILY token-expiry sweep: raises the expiry and reconnection avisos at the 30-day horizon, resolves them once a new date or credential lands, and closes the orphaned rows of contas that no longer exist. Reads only the stored credential — **no Loja Integrada call**, so the read switch does not gate it. `America/Sao_Paulo`, `timeoutSeconds 120`.                                                                                                                                                          |
| `pollLojaIntegradaPedidos`            | `onSchedule('*/5 * * * *')`            | The 5-minute order poller (arrives with the poller change of step 3; it ships behind the read switch AND the importer-seam gate). It keeps a durable cursor and a single-flight lease per conta, enqueues one synthetic notification per changed order onto the reads queue, and records its refusals on its own document so a stuck conta raises an aviso. Runs inline in its own schedule, paced at the reads interval. `America/Sao_Paulo`, `timeoutSeconds 300`.                                                   |

⚠️ **The export name IS the queue name.** Firebase binds one function per queue
and names the queue after the function, so renaming `filaLeituraLojaIntegrada`
creates a NEW queue and strands whatever the old one held. The name is fixed at
the first deploy. `src/index.ts` carries a rename-safety assertion tying the
export key to the `FILA_LEITURA_LI` constant the enqueuer targets.

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

## Runtime env

None of these is a secret and none belongs in Secret Manager. They are read at
runtime by **this nested codebase only**, never by Next — the App Hosting backend
hosts the credential routes, which read none of them — so a value set in
`apphosting.yaml` or the console would be read by nothing and fail silently. The
root `.env.example` names them all anyway, so the one file operators consult
lists every variable the channel reads; their real home is here.

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
# apps/loja-integrada, whose credential routes read it too.
# LOJA_INTEGRADA_CHAMADAS=on

# The region of the reads queue. LEAVE IT UNSET: blank or unset = the
# FUNCTIONS_REGION inlined into the bundle (a blank value counts as unset, #1108).
# The queue is created WITH its function, by this deploy, in FUNCTIONS_REGION and
# nowhere else, so any other value names a queue that does not exist: every
# enqueue is dropped while it reports success (#1108). If you set it at all, set
# it to exactly the FUNCTIONS_REGION the deploying shell exported. App Hosting's
# copy (step 4) must equal the same region.
# LOJA_INTEGRADA_TASKS_REGION=

# Sweep-only mode. Exactly `1` makes the poller's enqueue throw, so each
# notification is persisted `failed` and the 30-minute reprocess sweep drains it
# (never a silent drop). Strict `=== '1'`: unset, blank, `true` and `1 ` all
# leave enqueuing ON. Use it before the queue IAM is granted.
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
# Every line below is COMMENTED OUT and nothing in this codebase reads one before
# step 7. One valve per write flow: off | dry-run | on. Only the exact `on`
# writes and only the exact `dry-run` diffs; anything else is off.
# ⚠️ STAGING HAZARD. Loja Integrada has no sandbox and the origin is fixed, so a
# conta holding a token — real or invented — makes our code read LIVE (the
# validating GET on a save, and the poller). With a valve `on` and a canary entry
# or `*`, such a conta would WRITE to a real store while the legacy app is still
# its only writer. So: NO Loja Integrada token is saved or renewed in staging, or
# locally, before the window (D17), and these lines stay commented out. Set them
# ALIKE here and in the App Hosting console, and only in the window.
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
`filaLeituraLojaIntegrada`. The App Hosting runtime service account starts
enqueuing in step 4 (the inbound order webhook), and the credential routes never
enqueue — they only re-drive rows already in Firestore.

The enqueuing identity needs **three** grants. In step 3 `<enqueuing-sa>` is the
functions runtime SA, the identity the poller runs as (by default
`PROJECT_NUMBER-compute@developer.gserviceaccount.com`); step 4 revisits this
block when the App Hosting runtime SA joins.

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
gcloud run services add-iam-policy-binding filaLeituraLojaIntegrada --region=<region> \
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

ℹ️ **The step-3 preflight prints no backend cross-check.** Other channels' preflight
ends with a note naming the `*_TASKS_REGION` row their `apphosting.yaml` must
carry, because an App Hosting enqueuer reads it. Nothing in `apps/loja-integrada`
enqueues yet, so a note would send the operator to set a row that nothing reads.
Step 4 adds the App Hosting enqueuer, sets the row's `backendVar` and
`backendManifest`, and this paragraph goes.

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
export TASKS_INVOKER_SA="<functions-runtime-sa>"
firebase deploy --only functions:loja-integrada \
  --config firebase.loja-integrada.deploy.json \
  --project <project-id>
```

⚠️ **The list is AUTHORITATIVE: name every enqueuer, comma-separated** — drop the
duplicate when two are the same identity. A deploy **replaces** the members of
both bindings, so an identity left out **loses** the role. Today that is the
functions runtime SA alone; step 4 adds the App Hosting runtime SA, and a later
deploy that forgets it removes its role. If steps 3 and 4 reach a project in the
same window, name both from the first deploy.

⚠️ **Unset ⇒ the option is omitted entirely.** The build prints a warning and
grants 1 and 3 above become manual too. It never guesses a value: a wrong one
would lock out the legitimate caller, and a permissive one would be far worse.

⚠️ A redeploy with **no** `invoker` declared does not clear an existing binding —
firebase-tools skips `setInvokerUpdate` when the option is absent — but a service
**create**, i.e. a new or renamed task function, leaves no binding at all. That
silent case is what this variable exists for.

Verify it took, with nobody having run gcloud:
`gcloud run services get-iam-policy filaLeituraLojaIntegrada --region=<region>`.

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
```

then re-run the SAME deploy: the policy now has a `bindings` array, so the
deploy re-applies `TASKS_INVOKER_SA` authoritatively and finishes clean. This
codebase has ONE queue, so a first deploy into a project pays it once per
identity — **production's included**: it is a separate project, so put the grants
in the window's runbook. Verify the enqueue leg, which the `run` check above
cannot see:
`gcloud tasks queues get-iam-policy filaLeituraLojaIntegrada --location=<region>`
must list `roles/cloudtasks.enqueuer` for every identity in `TASKS_INVOKER_SA`.

## Verifying a first deploy

Do these in the window, in this order, after the deploy and before any switch is
flipped:

1. Cloud Tasks lists the queue `filaLeituraLojaIntegrada` with concurrency 1 and
   one dispatch per second, and Cloud Scheduler lists the schedule functions.
2. `gcloud run services get-iam-policy filaLeituraLojaIntegrada` and
   `gcloud tasks queues get-iam-policy filaLeituraLojaIntegrada` both name every
   identity in `TASKS_INVOKER_SA`, and
   `gcloud iam service-accounts get-iam-policy <functions-runtime-sa>` lists
   `roles/iam.serviceAccountUser` for each of them (grant 2, which no deploy
   makes).
3. The Firestore index `notificacoesLojaIntegrada (status, processedAt)` and
   `(status, contaId)` are READY: on Enterprise a missing index does not fail, it
   full-scans and bills the scan.
4. The first poller tick (once the poller change is deployed and the read switch
   is on) asks for orders modified since a moment AT OR BEFORE the legacy app's
   last import — a later start would leave a gap — every active conta has a
   `pollPedidosLojaIntegrada` document, and no `lojaIntegradaImportacaoParada`
   aviso is open.
