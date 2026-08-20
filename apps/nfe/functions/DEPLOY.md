# Deploying `apps/nfe/functions` (codebase `nfe`)

The async NF-e reconciler Cloud Functions — `reconciliarNfe` (`onTaskDispatched`)
and `nfeReconcileSweep` (`onSchedule`). They **execute the reconcile/sweep
in-process** (the shared handlers in `apps/nfe/lib/nfe/handlers/`) — no HTTP hop
back to the App Hosting app, no OIDC. This is a **separate codebase from
`storage`** so the heavy NF-e deps (soap / node-forge / xml-crypto / xmllint-wasm

- the bundled `@delfrance/integrations-nfe`) don't bloat the storage functions.

> `apps/nfe/functions` is a **deploy-artifact-only sub-build** of
> `@delfrance/nfe-app` (not a pnpm workspace package). Its typecheck/lint/test run
> via `apps/nfe`'s tasks (`tsconfig **/*.ts`, `eslint .`, vitest `functions/**`).
> `firebase-functions` / `xmllint-wasm` / `esbuild` are `apps/nfe` devDeps so the
> bundle's externals resolve locally. `next build` never bundles this folder.

## Deploy lane (manual & coordinated — see root `CLAUDE.md`, Critical rules)

One command, with `FUNCTIONS_REGION` (default `us-east1`) and the app's base
config set. **Ask the user before running it.**

```bash
firebase deploy --only functions:nfe \
  --config firebase.nfe.deploy.json --project <project-id>
```

The `predeploy` hook runs `apps/nfe/functions/scripts/prepare-deploy.mjs`, which:

1. esbuild-bundles `src/index.ts` into `.deploy/nfe-functions/index.js`
   (externals: firebase-admin / firebase-functions / **xmllint-wasm**);
2. writes a minimal workspace-free `package.json` (those 3 runtime deps only).
   ⚠️ **No lockfile reaches the cloud**, so the buildpack's `npm install` resolves
   each spec fresh — `firebase-admin` + `firebase-functions` are pinned **exact**
   here for that reason (a range ships a version CI never tested; 7.3.2 moved
   `express` 4→5 in a _patch_). Bump them alongside `pnpm-workspace.yaml`'s catalog
   and the other four artifact manifests —
   `packages/config-eslint/rules/runtime-deps-pinned.test.js` fails on drift;
3. **copies the SEFAZ `ca/*.pem` chains + MOC XSD schemas** next to the bundle —
   `src/options.ts` sets `NFE_CA_DIR=./ca` + `NFE_SCHEMA_DIR=./schemas`
   (`import.meta.url`-relative) so the bundled library finds them (its own dir
   layout doesn't survive bundling);
4. junctions `apps/nfe/node_modules` for firebase-tools' local trigger analysis
   (kept out of the upload via `ignore: ["node_modules"]`).

## Function env

**Secrets (auto-bound).** The codebase **declares** `secrets: [...]` once in
`src/options.ts` (`setGlobalOptions`) — applied to every function — so Firebase
mounts each from Secret Manager into `process.env` at runtime. Firebase requires
**every declared secret to exist before deploy** — set them all:

```bash
firebase functions:secrets:set NFE_CERT_ENC_KEY  --project <project-id>  # decrypts an uploaded filial A1
firebase functions:secrets:set NFE_CERT_BASE64    --project <project-id>  # env-fallback A1 (test)
firebase functions:secrets:set NFE_CERT_PASSWORD  --project <project-id>  # env-fallback A1 password (test)
```

- **Prod path:** upload a real A1 to each filial (encrypted with `NFE_CERT_ENC_KEY`)
  → only `NFE_CERT_ENC_KEY` is actually used; **trim the other two** from the
  `secrets` array in `src/options.ts`.
- **Test path (env-fallback):** a filial with no uploaded cert signs with the env
  A1 — keep all three, and set `NFE_CERT_ENV_FALLBACK=1` in `.env.deploy` (below).

> `NFE_TEST_CNPJ` / `NFE_TEST_IE` are **not** function secrets — the reconcile path
> never reads them. They're for the **local seed/emit script** (`.env.local`), which
> stamps the test filial's CNPJ/IE. Don't declare them here.

**Non-secret config (`.env.deploy`).** Put non-secret runtime config in
**`apps/nfe/functions/.env.deploy`** (gitignored; see `.env.example`).
`prepare-deploy.mjs` copies it into the artifact **as `.env`**, and firebase loads it
as the function's runtime env at deploy. For config that should apply to ONE project
only, use `.env.deploy.<project-id>` — it lands as `.env.<project-id>`, which
firebase-tools applies only when you deploy with that `--project`.

> ⚠️ **Renamed from the bare `.env` (was: everything matching `.env*` except
> `.env.local`/`.env.example` got copied).** That was a denylist, so every new `.env*`
> name the repo invented was opt-OUT of being uploaded to the project's
> `gcf-sources-*` bucket — `.env.secrets` included. The allowlist now lives in
> `tools/deploy-env/env-files.mjs` and is shared by all five `prepare-deploy.mjs`
> scripts. **If you already have an `apps/nfe/functions/.env` on your machine, rename
> it to `.env.deploy`** — the predeploy hook fails loudly with that instruction
> rather than silently shipping without it. A `.env.secrets*` fails the hook outright.

> The `.env.example` next to this file is the **one deliberate exception** to the
> repo's one-root-`.env.example` convention (#730): the repo-root `.env.local`
> feeds the Next apps and never reaches this separate codebase, so these names
> belong here, not in the root file. The carve-out is pinned in
> `packages/config-eslint/rules/env-example-location.test.js`.

- For the **env-fallback test**, the only needed var is `NFE_CERT_ENV_FALLBACK=1`.
- `NFE_AMBIENTE` / `NFE_UF` **default to `homologacao` / `SP`** (`runtime.ts`), so a
  SP homologação test needs nothing else. Admin creds come from ADC; the queue
  region defaults to the function's own region.
- **Produção:** `NFE_AMBIENTE=producao` + `NFE_ALLOW_PRODUCAO=true` (the sweep's EPEC
  branch signs + emits). `FIREBASE_*` names are reserved and can't be set via `.env`.

## One-time IAM (the apps/nfe App Hosting app enqueues to this function's queue)

`apps/nfe` (App Hosting) enqueues onto the auto-provisioned `reconciliarNfe` queue
via `firebase-admin`'s `taskQueue()`. Grant its runtime SA, once per project:

```bash
PROJECT=<project-id>
NFE_RUNTIME_SA=<apps/nfe App Hosting runtime SA>
FN_RUNTIME_SA=<nfe functions runtime SA>   # default: <projnum>-compute@developer.gserviceaccount.com
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$NFE_RUNTIME_SA" --role="roles/cloudtasks.enqueuer"
gcloud iam service-accounts add-iam-policy-binding "$FN_RUNTIME_SA" --project="$PROJECT" \
  --member="serviceAccount:$NFE_RUNTIME_SA" --role="roles/iam.serviceAccountUser"
# ⚠ THE THIRD ROLE, and the one everyone forgets. Enqueuing is only half the
# trip: Cloud Tasks then DISPATCHES the task, presenting an OIDC token whose
# principal is the enqueuer's own identity - and a gen2 function is a Cloud Run
# service, so that principal needs run.invoker ON THE SERVICE. Without it the
# task is created and delivered and the service answers 403 run.routes.invoke,
# with NO failure document written anywhere.
#
# ⚠ SINCE #1133 THE DEPLOY DOES THIS FOR YOU when TASKS_INVOKER_SA is set (see
# below). Run it by hand only for a deploy without that variable.
gcloud run services add-iam-policy-binding reconciliarNfe --region="$REGION" \
  --project="$PROJECT" \
  --member="serviceAccount:$NFE_RUNTIME_SA" --role="roles/run.invoker"
```

### `TASKS_INVOKER_SA` — the third role, applied by the deploy (#1133)

Export it in the shell you run `firebase deploy` from. `build.mjs` inlines it
(esbuild `define`, exactly like `FUNCTIONS_REGION`) and every `onTaskDispatched`
in this codebase declares it as `invoker`; firebase-tools then applies the list
to **both** legs of the trip — `roles/run.invoker` on each function's Cloud Run
service **and** `roles/cloudtasks.enqueuer` on its queue.

```bash
export TASKS_INVOKER_SA="<apphosting-runtime-sa>,<functions-runtime-sa>"
firebase deploy --only functions:nfe \
  --config firebase.nfe.deploy.json --project <project-id>
```

⚠️ **Name every enqueuer, comma-separated** — drop the duplicate when the two are
the same identity. A deploy **replaces** the members of both bindings, so an
identity left out **loses** the role.

`reconciliarNfe` **re-enqueues itself** while `cStat=105` / CC-e `136`, as the
functions runtime SA — so `$FN_RUNTIME_SA` belongs in the list too, not just
`$NFE_RUNTIME_SA`.

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
`gcloud run services get-iam-policy reconciliarNfe --region=$REGION`.

## Verify (staging)

Emit a **≥2-pedido** lote → the request returns `aguardandoResposta` instantly →
the `reconciliarNfe` function fires at ~`tMed` and drains the lote to `aprovada`
(check `gcloud tasks queues describe reconciliarNfe --location=us-east1` depth
rise+drain). Confirm the function reads `./ca` + `./schemas` (XSD validation
succeeds — a missing-schema error means the copy/`NFE_SCHEMA_DIR` wiring is off).

## Known first-run gotchas (not yet executed)

- **Cross-codebase enqueue**: the Cloud Tasks queue is named after the function
  (`reconciliarNfe`), codebase-agnostic — but verify apps/nfe's
  `taskQueue('locations/<region>/functions/reconciliarNfe')` reaches it (silent
  drop = wrong path).
- **`soap` bundling**: if esbuild can't bundle `soap` cleanly, move it to
  `build.mjs` externals + the minimal `package.json` deps.
- Local emulator hosting of these functions is a deferred follow-up (no emulator
  test today — disposition is unit-tested, the e2e is the staging path above).
