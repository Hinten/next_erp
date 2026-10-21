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
  before any Firestore read, the backstop poll stops before any Firestore
  operation (so no poll document, and no bootstrap anchor, exists before the
  window), and the context loader refuses before it builds a client.
- **The importer seam is empty.** The reads queue's task has no importer yet
  (master-plan step 5), so a run that gets past the switch defers as
  `importador-ausente`, and every poll tick stops at its importer gate with ZERO
  Firestore operations. Nothing in this codebase turns a notification into a
  `pedido` before step 5.

⚠️ **The expiry sweep stands outside both switches.** `sweepAmazonExpirations`
makes no Amazon call, so the read switch does not gate its conta passes: deployed
into a project, it raises and resolves the per-conta reauthorization and
reconnection avisos of that project's Amazon contas (only its LWA client secret
pass waits for the switch).

⚠️ **The conta trigger stands outside both switches.** `onIntegracaoAmazonChanged`
(master-plan step 20) makes no Amazon call, so the read switch does not gate it,
and it imports no importer, so the empty seam does not either. Deployed into a
project, it writes that project's `int_frete` on every Amazon conta save that
moves a mirrored field: create, patch or deactivate. That is why this deploy
waits for the window's `int_frete` adoption pass (Prerequisites below).

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/amazon/node_modules`).
- **`AMAZON_LWA_CLIENT_SECRET` exists in the project's Secret Manager** (window
  item W1, before this deploy). `filaLeituraAmazon`,
  `reprocessAmazonNotifications` and `pollAmazonOrders` declare it as
  `secrets:`, and **a declared secret that is missing fails the WHOLE deploy**,
  every function of the codebase included. `sweepAmazonExpirations` and
  `onIntegracaoAmazonChanged` declare none: neither calls Amazon.
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
  fails every operation with `5 NOT_FOUND`. The conta trigger
  `onIntegracaoAmazonChanged` listens on `integracao/{integracaoId}` in that
  database: a trigger bound to `(default)` deploys fine and never fires, and only
  `src/index.test.ts`'s offline pin guards it (the emulator serves any database).
  `build.mjs` inlines `FIREBASE_DATABASE_ID` (unset or blank → `default`) and the
  preflight prints the value it baked; leave it unset in the BUILD environment
  (the deploy shell and the repo-root `.env.functions`), or set it to exactly
  `default`. The define replaces every read of the variable in the bundle,
  `getDb()`'s included, so the trigger's binding and every function's handle use
  that build-time value and a runtime override reaches neither.
- **The index `notificacoesAmazon (status ASC, processedAt ASC)` READY** before
  the first sweep tick: on Enterprise a missing index does not fail, it
  full-scans and bills the scan (root `CLAUDE.md` rule 1).
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
  missing credential, the empty importer seam). Logged separately — summing them would hide a
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
  instead. Two gates with ZERO Firestore operations: the empty importer seam (until step 5)
  and the read switch. Raises `amazonImportacaoParada` on a counted failure at its threshold
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

⚠️ **The export name IS the queue name.** Firebase binds one function per queue
and names the queue after the function, so renaming `filaLeituraAmazon` creates
a NEW queue and strands whatever the old one held. The name is fixed at the
first deploy. `src/index.ts` carries a rename-safety assertion tying the export
key to the `FILA_LEITURA_AMAZON` constant every enqueuer targets.

⚠️ **One logger.** Every line is one JSON line on stdout through
`LOGGER_STDOUT_AMAZON` (`severity` + `message`): one `evento: 'tarefa'` line per
dispatch, one `evento: 'varredura'` line per sweep lane (and one per expiry
run), per poll tick one `evento: 'poll'` line per conta run plus ONE summary
line (`[amazon] poll de pedidos`, the counters flattened), and one
`evento: 'int-frete'` line per conta-trigger reconcile (WARNING on
`incompleto`). No line carries a seller id, a token or an error message; a
failed sweep row is named by its document id only (the row holds the reason).
⚠️ The one declared exception: on `incompleto` the shared core in
`packages/data` also writes its own unstructured
`console.warn('[amazon] conta Amazon sem dados suficientes para criar o int_frete', …)`
(stderr, the conta id and field names only), outside `LOGGER_STDOUT_AMAZON`.

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
# rethrows untouched (the receiver persists it `failed` with an ERROR line; the
# poll stops the conta's drain as `fila-indisponivel` and raises its aviso).
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
codebase has ONE queue, so a first deploy into a project pays it once per
identity — **production's included**: it is a separate project, so put the
grants in the window's runbook.

## Verifying a first deploy

Do these in the window, in this order, after the deploy and before any switch is
flipped:

1. Cloud Tasks lists the queue `filaLeituraAmazon` with concurrency 1 and 0.5
   dispatches per second, and Cloud Scheduler lists the three schedule functions.
2. `gcloud run services get-iam-policy filaLeituraAmazon` and
   `gcloud tasks queues get-iam-policy filaLeituraAmazon` both name every identity
   in `TASKS_INVOKER_SA`, and each enqueuing identity holds
   `roles/iam.serviceAccountUser` on itself (grant 2, which no deploy makes).
3. The Firestore index `notificacoesAmazon (status, processedAt)` is READY.
4. A reprocess tick logs two `evento: 'varredura'` lines (`lane: hot` and
   `lane: deferred`), and the first expiry run logs one.
5. A poll tick logs its summary line `[amazon] poll de pedidos` with
   `portao: importador-ausente` (before step 5) or `chamadas-desligadas`, and
   `pollPedidosAmazon` holds no document: neither gate reads or writes Firestore.
6. The conta trigger is bound to the NAMED database, and the Eventarc trigger
   carries that filter:

   ```bash
   gcloud eventarc triggers list --location=<FUNCTIONS_REGION> --project <project-id>
   # expect a trigger for onintegracaoamazonchanged,
   # event type google.cloud.firestore.document.v1.written,
   # filtered to database 'default' + the integracao/* document path
   ```

7. With the operator's OK, rename the conta and rename it back: the `amz`
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
