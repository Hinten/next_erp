# Deploying the Mercado Livre Cloud Functions (codebase `mercado-livre`)

These functions are a **deploy-artifact sub-build** of `@delfrance/mercado-livre-app`
— not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. `firebase.mercado-livre.deploy.json` points `source` at the generated
`.deploy/mercado-livre-functions`.

> Deploy is **manual and coordinated** (CLAUDE.md critical rule #1) — never let a
> stray `firebase deploy` push rules. This config has no `firestore`/`storage`
> block, so it can't.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/mercado-livre/node_modules`).
- The App Hosting backend for `apps/mercado-livre` created in the Firebase console
  (GCP-side; not declared in any repo config).
- Env / secrets on the deployed function: `FIREBASE_PROJECT_ID` + admin creds; and,
  once the ML API calls are wired (Phase 5), `MERCADO_LIVRE_CLIENT_SECRET` via
  `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_SECRET` (declared in
  `src/options.ts`).

## Deploy

```bash
# from the repo root
firebase deploy --only functions:mercado-livre \
  --config firebase.mercado-livre.deploy.json \
  --project <project-id>
```

The `predeploy` hook builds the artifact automatically. To inspect the bundle
locally without deploying: `node apps/mercado-livre/functions/build.mjs` (writes
`dist/index.js`).

## Functions in this codebase

| Export                            | Trigger                                                                   | Purpose (Phase 5)                                    |
| --------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| `importMercadoLivreOrders`        | `onSchedule('every 15 minutes')`                                          | Incremental order pull per connected account (#362). |
| `processMercadoLivreNotification` | `onDocumentCreated('integracao/{id}/notificacoesMercadoLivre/{notifId}')` | Process a persisted ML notification (#290/#360).     |

Both are **skeleton no-ops** today — they log and return. The real behavior lands
with the per-channel port.
