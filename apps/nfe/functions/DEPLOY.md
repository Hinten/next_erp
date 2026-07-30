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
2. writes a minimal workspace-free `package.json` (those 3 runtime deps only);
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
  A1 — keep all three, and set `NFE_CERT_ENV_FALLBACK=1` in `.env` (below).

> `NFE_TEST_CNPJ` / `NFE_TEST_IE` are **not** function secrets — the reconcile path
> never reads them. They're for the **local seed/emit script** (`.env.local`), which
> stamps the test filial's CNPJ/IE. Don't declare them here.

**Non-secret config (`.env`).** Put non-secret runtime config in
**`apps/nfe/functions/.env`** (gitignored; see `.env.example`). `prepare-deploy.mjs`
copies `.env*` (except `.env.local`/`.env.example`) into the artifact, and firebase
loads it as the function's runtime env at deploy.

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
