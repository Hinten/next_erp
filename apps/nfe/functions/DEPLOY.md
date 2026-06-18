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

## Deploy lane (manual & coordinated — root CLAUDE.md rule #1)

One command, with `FUNCTIONS_REGION` (default `us-east1`) and the app's base
config set. **Ask the user before running it.**

```bash
firebase deploy --only functions:nfe \
  --config firebase.nfe.deploy.json --project <project-id>
```

The `predeploy` hook runs `apps/nfe/functions/scripts/prepare-deploy.mjs`, which:

1. esbuild-bundles `src/index.ts` into `.deploy/nfe-functions/index.js`
   (externals: firebase-admin / firebase-functions / **xmllint-wasm**);
2. writes a minimal workspace-free `package.json` (those 3 runtime deps only);
3. **copies the SEFAZ `ca/*.pem` chains + MOC XSD schemas** next to the bundle —
   `src/options.ts` sets `NFE_CA_DIR=./ca` + `NFE_SCHEMA_DIR=./schemas`
   (`import.meta.url`-relative) so the bundled library finds them (its own dir
   layout doesn't survive bundling);
4. junctions `apps/nfe/node_modules` for firebase-tools' local trigger analysis
   (kept out of the upload via `ignore: ["node_modules"]`).

## Function env (set on the `nfe` backend)

`NFE_AMBIENTE` / `NFE_UF`, `NFE_CERT_ENC_KEY` (decrypts the per-filial A1 —
treat as a secret), admin creds (ADC on Functions), and **`NFE_ALLOW_PRODUCAO=true`
in produção** (the sweep's EPEC branch signs + emits). Optional:
`NFE_TASKS_REGION` (default `us-east1`), `NFE_TASKS_DISABLED=1` (local/sweep-only).

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
```

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
