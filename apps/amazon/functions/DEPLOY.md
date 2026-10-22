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

Two switches keep it harmless even if it were deployed early, and both stay
exactly as they are until the window:

- **The read switch `AMAZON_CHAMADAS` stays UNSET.** Only the exact `on` lets this
  code call Amazon at all (D11); the intake task and the reprocess sweep defer
  before any Firestore read, and the context loader refuses before it builds a
  client.
- **The importer seam is empty.** The reads queue's task has no importer yet
  (master-plan step 5), so a run that gets past the switch defers as
  `importador-ausente`. Nothing in this codebase turns a notification into a
  `pedido` before step 5.

⚠️ **The expiry sweep stands outside both switches.** `sweepAmazonExpirations`
makes no Amazon call, so the read switch does not gate its conta passes: deployed
into a project, it raises and resolves the per-conta reauthorization and
reconnection avisos of that project's Amazon contas (only its LWA client secret
pass waits for the switch).

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/amazon/node_modules`).
- **`AMAZON_LWA_CLIENT_SECRET` exists in the project's Secret Manager** (window
  item W1, before this deploy). `filaLeituraAmazon` and
  `reprocessAmazonNotifications` declare it as `secrets:`, and **a declared
  secret that is missing fails the WHOLE deploy**, every function of the
  codebase included. `sweepAmazonExpirations` declares none: it never calls
  Amazon.
- **Region match: `FUNCTIONS_REGION` equals `AMAZON_TASKS_REGION`.** The queue is
  created WITH its function, by this deploy, in `FUNCTIONS_REGION` and nowhere
  else. Every enqueuer resolves the queue from `AMAZON_TASKS_REGION`, falling
  back to `FUNCTIONS_REGION`, with **no default**: the App Hosting receiver
  (`apps/amazon/lib/firebase/filaLeitura.ts`) answers 503 without one, and the
  functions root (`src/agendador.ts`, the step-4 poll's) throws on the enqueue.
  A mismatch is the #1108 failure: the task targets a queue that does not exist
  and is **silently dropped** while the caller sees success. Set the App
  Hosting backend's `AMAZON_TASKS_REGION` (console) to exactly the
  `FUNCTIONS_REGION` this deploy exports; the preflight prints that reminder.
- **The database is the NAMED `default`**, never the `(default)` sentinel, which
  fails every operation with `5 NOT_FOUND`. `build.mjs` inlines
  `FIREBASE_DATABASE_ID` (unset or blank → `default`) and the preflight prints the
  value it baked; leave it unset in the BUILD environment (the deploy shell and
  the repo-root `.env.functions`), or set it to exactly `default`. This codebase
  has no Firestore trigger, so nothing binds a database at codebase analysis.
- **The index `notificacoesAmazon (status ASC, processedAt ASC)` READY** before
  the first sweep tick: on Enterprise a missing index does not fail, it
  full-scans and bills the scan (root `CLAUDE.md` rule 1).
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
  retry-exhaustion, park or defer. Enqueued by the App Hosting push receiver; the step-4 poll
  joins it.
- **`reprocessAmazonNotifications`** — `onSchedule('10,40 * * * *')`. The backstop, draining
  BOTH lanes on one tick (`limit 10` each): `failed` notifications older than the hot window,
  then the deferred lane (the read switch off, an unknown seller, a parked or inactive conta, a
  missing credential, the empty importer seam). Logged separately — summing them would hide a
  growing deferred backlog inside a healthy `processed`. `America/Sao_Paulo`,
  `timeoutSeconds 540`, `secrets: AMAZON_LWA_CLIENT_SECRET`.
- **`sweepAmazonExpirations`** — `onSchedule('15 7 * * *')`. The DAILY expiry sweep (the step-2
  body): raises the reauthorization and reconnection avisos at the 30-day horizon and resolves
  them once a new grant lands, closes the orphaned rows of contas that no longer exist, and —
  only while `AMAZON_CHAMADAS=on` — warns about the app's LWA client secret from
  `AMAZON_LWA_SEGREDO_EXPIRA_EM`. Reads only the stored credential — **no Amazon call**, so
  **no `secrets:`**. `America/Sao_Paulo`, `timeoutSeconds 120`.

⚠️ **The export name IS the queue name.** Firebase binds one function per queue
and names the queue after the function, so renaming `filaLeituraAmazon` creates
a NEW queue and strands whatever the old one held. The name is fixed at the
first deploy. `src/index.ts` carries a rename-safety assertion tying the export
key to the `FILA_LEITURA_AMAZON` constant every enqueuer targets.

⚠️ **One logger.** Every line is one JSON line on stdout through
`LOGGER_STDOUT_AMAZON` (`severity` + `message`): one `evento: 'tarefa'` line per
dispatch, one `evento: 'varredura'` line per sweep lane (and one per expiry
run). No line carries a seller id, a token or an error message; a failed sweep
row is named by its document id only (the row holds the reason).

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
# as the App Hosting rollout, or the task and the sweep stay switched off.
# AMAZON_CHAMADAS=on

# The LWA client id (both surfaces): the pair the context loader reads for a
# refresh. The client SECRET is NOT here — it is a Secret Manager binding.
# AMAZON_LWA_CLIENT_ID=

# The region of the reads queue (both surfaces). LEAVE IT UNSET here: blank or
# unset = the FUNCTIONS_REGION inlined into the bundle (a blank value counts as
# unset, #1108). If you set it at all, set it to exactly the FUNCTIONS_REGION the
# deploying shell exported — any other value names a queue that does not exist.
# AMAZON_TASKS_REGION=

# Sweep-only mode (both surfaces). Exactly `1` makes every enqueue throw, so each
# notification is persisted `failed` and the 30-minute reprocess sweep drains it
# (never a silent drop). Strict `=== '1'`: unset, blank, `true` and `1 ` all
# leave enqueuing ON. Use it before the queue IAM is granted.
# AMAZON_TASKS_DISABLED=1

# The LWA client secret's expiry date, exact YYYY-MM-DD, read by the expiry sweep
# only while the read switch is on. Unset or invalid raises the aviso WITHOUT a
# date (an unknown deadline is the riskier state).
# AMAZON_LWA_SEGREDO_EXPIRA_EM=

# ---- The WRITE VALVES and CANARY LISTS (both surfaces; read from the write
# engine onward). Nothing in this codebase reads one yet. A valve is
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
- the **functions runtime service account** — the backstop poll, from step 4
  (PR 4-b), by default the project's Compute Engine default service account.

**Every** enqueuing identity needs **three** grants:

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
# rethrows untouched (the receiver persists it `failed` with an ERROR line).
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
role. Name the functions runtime SA from the FIRST deploy, even before the
step-4 poll ships: a later deploy that adds it is a deploy that could forget the
receiver's.

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
codebase has ONE queue, so a first deploy into a project pays it once per
identity — **production's included**: it is a separate project, so put the
grants in the window's runbook.

## Verifying a first deploy

Do these in the window, in this order, after the deploy and before any switch is
flipped:

1. Cloud Tasks lists the queue `filaLeituraAmazon` with concurrency 1 and 0.5
   dispatches per second, and Cloud Scheduler lists the two schedule functions.
2. `gcloud run services get-iam-policy filaLeituraAmazon` and
   `gcloud tasks queues get-iam-policy filaLeituraAmazon` both name every identity
   in `TASKS_INVOKER_SA`, and each enqueuing identity holds
   `roles/iam.serviceAccountUser` on itself (grant 2, which no deploy makes).
3. The Firestore index `notificacoesAmazon (status, processedAt)` is READY.
4. A reprocess tick logs two `evento: 'varredura'` lines (`lane: hot` and
   `lane: deferred`), and the first expiry run logs one.
