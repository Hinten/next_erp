# Deploying `apps/functions` (codebase `storage`)

These are the **Cloud Functions** for the storage pipeline (currently
`resizeProductImage`). They have never been deployed — `firebase.functions.json`
at the repo root exists **only** for the emulator suite (`ci-storage.yml`) and is
deliberately kept away from `firebase deploy`.

Deploys are **manual and coordinated** (CLAUDE.md critical rule #1). This doc is
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

**One command.** The deploy config carries a `predeploy` hook that builds the bundle
(`dist/index.js`) automatically first — so the build can't be skipped and a
stale/missing bundle can't ship:

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

To build by hand (e.g. to inspect `dist/` before deploying), the predeploy command is:
`pnpm --filter @delfrance/functions build`.

## Why `@delfrance/data` / `@delfrance/schemas` are `devDependencies`

esbuild **bundles** those workspace packages into `dist/index.js` (only
`firebase-admin`, `firebase-functions`, and `sharp` are marked `external`). Firebase's
cloud `npm install` at deploy time does **not** understand pnpm's `workspace:*`
protocol, so if those packages sat in `dependencies` the deploy would fail with
`Unsupported URL Type "workspace:"`. Keeping them in `devDependencies` means the
cloud install only pulls the three real runtime packages. Do not move them back
without solving the workspace-resolution problem another way.

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

## Known first-run gotchas (not yet executed)

This lane has been prepared but **not run end-to-end** yet. On a first cloud deploy,
watch for: `sharp` native-binary platform resolution in the Cloud Build image; the
gen2 (Eventarc) trigger requiring the Eventarc / Pub/Sub APIs enabled and the
runtime service account having the right roles; and the region mismatch backstop
(the build throws if `FUNCTIONS_REGION` ≠ the bucket region). Surface any of these
back as a follow-up rather than forcing the deploy.
