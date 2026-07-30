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
