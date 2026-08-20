# Deploying `apps/functions` (codebase `storage`)

These are the **Cloud Functions** for the storage pipeline (currently
`resizeProductImage`). They have never been deployed — `firebase.functions.json`
at the repo root exists **only** for the emulator suite (`ci-storage.yml`) and is
deliberately kept away from `firebase deploy`.

Deploys are **manual and coordinated** — see the Deploying section in `apps/functions/CLAUDE.md`. This doc is
the lane; it does not run in CI.

## Prerequisites

- Firebase CLI logged in (`firebase login`) with deploy rights on the **staging**
  project.
- A clean `pnpm install` (workspace deps resolved).

No secrets are needed to build/deploy. The only build-time value is the function
region, a non-secret constant that `build.mjs` defaults to `us-east1` (the Storage
bucket region); **`.env.local` is never read by the deploy** — it holds secrets that
must not reach the build/deploy process. Override the region only for another
environment via the `FUNCTIONS_REGION` env var.

## Deploy lane

**One command.** The deploy config carries a `predeploy` hook that runs
`scripts/prepare-deploy.mjs`, regenerating the deploy artifact in `.deploy/functions/`
first — so the build can't be skipped and a stale/missing bundle can't ship:

```bash
firebase deploy --only functions:storage \
  --config firebase.functions.deploy.json \
  --project <staging-project-id>     # same project id as FIREBASE_PROJECT_ID / e2e staging
```

`--config firebase.functions.deploy.json` is **functions-only** (no firestore/storage
rules keys), so it cannot push the Flutter-owned rules even by accident; `--only
functions:storage` scopes to this codebase.

> **Never** point this at the production project until the functions phase is
> coordinated. The config is functions-only by design, but the `--project` flag is
> still yours to get right.

To regenerate the artifact by hand (e.g. to inspect it before deploying), the
predeploy command is: `node apps/functions/scripts/prepare-deploy.mjs`. (A plain
`pnpm --filter @delfrance/functions build` writes `dist/index.js` for local
inspection only — the deploy does not use `dist/`.)

## Why the deploy uploads a generated `.deploy/functions` folder

The deploy `source` is **not** `apps/functions` but a generated `.deploy/functions/`
(at the repo root, gitignored) holding just two files: the esbuild bundle
(`index.js`) and a **minimal `package.json`**. esbuild bundles everything except
`firebase-admin`, `firebase-functions`, and `sharp` (the only `external`s) — so
`@delfrance/data` / `@delfrance/schemas` are inlined and the cloud needs only those
three runtime packages.

This indirection is required: Firebase's gen2 buildpack runs `npm install`, and that
cloud `npm` does **not** understand pnpm's `workspace:*` protocol — it even parses
devDependency specs with `--omit=dev`, so the workaround of merely moving deps to
devDependencies does not help. The real `apps/functions/package.json` carries
`workspace:*` specs (`@delfrance/config-tsconfig` / `data` / `schemas`), so uploading
it fails with `Unsupported URL Type "workspace:"` (`EUNSUPPORTEDPROTOCOL`). The
generated `package.json` (`scripts/prepare-deploy.mjs`) carries **only the three real
`dependencies` — no devDependencies, no `workspace:*`, no build script** — so the
cloud install resolves cleanly and runs no build.

⚠️ **No lockfile reaches the cloud**, so that install resolves each spec fresh.
`firebase-admin` and `firebase-functions` are therefore pinned **exact** in
`apps/functions/package.json` (not `^` ranges): a range installs whatever is newest
at deploy time, which is a version no CI lane ever tested — `firebase-functions@7.3.2`
moved `express` 4→5 in a _patch_ release exactly that way. Bump them together with
`pnpm-workspace.yaml`'s catalog and the other four artifact manifests;
`packages/config-eslint/rules/runtime-deps-pinned.test.js` fails on any drift.

`prepare-deploy.mjs` also junctions the workspace's `node_modules` into
`.deploy/functions/`, because firebase-tools' **local** trigger analysis locates and
spawns the Functions SDK by looking for `<source>/node_modules/.bin/firebase-functions`
and does not walk up to parent `node_modules`. The artifact is placed at
`.deploy/functions` — the **same directory depth** as `apps/functions` — on purpose:
pnpm's symlinks inside `node_modules` are _relative_, so they only resolve through the
junction when referenced from a path at that same depth (`apps/functions/.deploy`
would be one level too deep and the links would overshoot). The
`ignore: ["node_modules"]` entry keeps that junction out of the upload — it is only
there so the local analysis step can run.

## Verify (on staging, after the deploy)

1. Upload one product photo in the produto editor (`/produtos/<id>/editar`,
   Imagens/Fotos tab).
2. In Storage, confirm the **200px / 400px / jpeg** derivatives appear under the
   product's path.
3. Confirm the derivative `Arquivo` docs exist — the `arquivo200pxOuterRef`
   (and 400px/jpeg) refs built by `buildFotoRefs` resolve to real docs.
4. The thumbnail **auto-upgrades** to the 200px derivative (no code change — PR #103
   already prefers the derivative when it exists).
5. **Coexistence:** open the same product in the Flutter app and confirm a Flutter
   read of the Next-uploaded+resized photo sees the same derivative shape.

Once step 5 passes, close **#137**. The same lane will later ship the deletion-
lifecycle functions (#136 / #95) — see ADR 0010, the produto deletion lifecycle
ADR added in PR #170 (`apps/docs/src/content/docs/adr/0010-produto-deletion-lifecycle.md`;
it lands with that PR, so the path resolves once both merge to main).

## `onProdutoPrecoCustoChanged` (price/custo history + child propagation)

Ships in this same `functions:storage` codebase — no config change, no new
deploy command; it goes out with the next `firebase deploy --only
functions:storage` run above. It moves `historicoDePrecos`/`historicoDeCusto`
recording and parent→children `precos` propagation server-side (previously the
Next produto editor's `onAfterSave`).

**Deploy this trigger BEFORE OR WITH the web release that removes the
client-side history/propagation writes** — until it's live, an edit made while
only the OLD client code runs would record no history and propagate nothing.
Deploying the trigger first is safe on its own (both the old client writes and
the new trigger writes for a while, which is the accepted dual-run — see the
schema/trigger PR notes), so when in doubt deploy the function first and ship
the client change after.

## ⚠️ One-time IAM - `processarBalanco` is a Cloud Tasks target

This codebase hosts an `onTaskDispatched` function (`processarBalanco`,
`src/estoques/aplicarBalanco.ts`) enqueued from apps/web's balanco flow via
`firebase-admin`'s `taskQueue()`. That needs **three** grants, and this file
documented none of them until the first Mercado Livre live run hit the third.

```bash
PROJECT=<project-id>
CALLER_SA=<the runtime SA that enqueues>
FN_RUNTIME_SA=<functions runtime SA>   # default: <projnum>-compute@developer.gserviceaccount.com

# 1+2 - permission to CREATE the task, and to act as the function's identity.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$CALLER_SA" --role="roles/cloudtasks.enqueuer"
gcloud iam service-accounts add-iam-policy-binding "$FN_RUNTIME_SA" --project="$PROJECT" \
  --member="serviceAccount:$CALLER_SA" --role="roles/iam.serviceAccountUser"

# 3 - permission to DISPATCH. Cloud Tasks presents an OIDC token whose principal
# is the caller's own identity, and a gen2 function is a Cloud Run service, so it
# needs run.invoker ON THE SERVICE. Skip this and the task is created and
# delivered and 403s `run.routes.invoke` - with the enqueue reported as a
# success, so nothing anywhere records the failure except the function's own log.
#
# ⚠ SINCE #1133 THE DEPLOY DOES THIS FOR YOU when TASKS_INVOKER_SA is set (see
# below). Run it by hand only for a deploy without that variable.
gcloud run services add-iam-policy-binding processarBalanco --region=<region> \
  --project="$PROJECT" \
  --member="serviceAccount:$CALLER_SA" --role="roles/run.invoker"
```

### The deploy aborts if `TASKS_INVOKER_SA` is missing (#1133)

`predeploy` runs `node tools/deploy-env/preflight.mjs storage` **before** the
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
node tools/deploy-env/preflight.mjs storage
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
firebase deploy --only functions:storage \
  --config firebase.functions.deploy.json \
  --project <project-id>
```

⚠️ **Name every enqueuer, comma-separated** — drop the duplicate when the two are
the same identity. A deploy **replaces** the members of both bindings, so an
identity left out **loses** the role.

`processarBalanco` **re-enqueues itself** at the time-budget boundary, as the
functions runtime SA — so `$FN_RUNTIME_SA` belongs in the list alongside
`$CALLER_SA`.

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
`gcloud run services get-iam-policy processarBalanco --region=<region>`.

## Known first-run gotchas (not yet executed)

This lane has been prepared but **not run end-to-end** yet. On a first cloud deploy,
watch for: `sharp` native-binary platform resolution in the Cloud Build image; the
gen2 (Eventarc) trigger requiring the Eventarc / Pub/Sub APIs enabled and the
runtime service account having the right roles (a first-deploy `storage.buckets.get`
403 right after those APIs are enabled is usually IAM-propagation lag — re-run);
and the region: the bundle inlines `us-east1` by default, which **must match the
Storage bucket's region** — if the bucket is elsewhere, deploy with
`FUNCTIONS_REGION=<bucket-region>` set. Surface any of these back as a follow-up
rather than forcing the deploy.
