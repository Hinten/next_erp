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

| Export                               | Trigger                                                                    | Purpose                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `importMercadoLivreOrders`           | `onSchedule('every 15 minutes')`                                           | Incremental order pull per connected account (#362) — **skeleton no-op** until that milestone.              |
| `processMercadoLivreNotification`    | `onDocumentCreated('notificacoesMercadoLivre/{notifId}', { retry: true })` | Step 6 — process a persisted ML notification (resolve account by `user_id`, dispatch by topic; idempotent). |
| `reprocessMercadoLivreNotifications` | `onSchedule('every 30 minutes')`                                           | Step 6 — reprocess backstop for `pending`/`failed` notifications older than 1h.                             |

## ⚠️ Callback-URL cutover — coordinate with the legacy Flutter functions

The Step-6 pipeline persists **every** notification to the **top-level**
`notificacoesMercadoLivre` collection, which the still-running Flutter app also
watches with its own `onCreate` trigger (`notificationMercadoLivreRealTime`) +
periodic sweep (`manageNotificationsMercadoLivre`). The legacy app persisted a
doc **only on a processing error**, so its trigger fired rarely; the new app
inverts that.

**When you switch a seller's ML notifications callback URL to this backend's
`/api/webhooks/mercado-livre`, you MUST disable the legacy Flutter notification
functions in the same window.** Otherwise both apps' triggers fire on every
new-app write and **double-process** each notification (the legacy handler
fetches the resource and mutates `pedidos`/`produtos`). Same cutover discipline
as the estoque functions. Until the cutover, the callback URL still points at
Flutter and this backend's trigger never fires — so there is no overlap either
side of a _correctly sequenced_ cutover.
