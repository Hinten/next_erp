# apps/functions — CLAUDE.md

Guidance for Claude Code when working in the `@delfrance/functions` package
(the gen2 Cloud Functions, codebase `storage`). The root `CLAUDE.md` still
applies — this file adds what is specific to deploying and building functions.

## What this is

gen2 (2nd-gen / Eventarc) Cloud Functions. Eight exports:

- **`resizeProductImage`** (`onObjectFinalized`) — runs on every non-derivative
  finalize. (1) **Upload confirmed**: flips the owning `arquivos` doc's
  `uploadState` to `'finalized'` (`src/arquivos/markUploadFinalized.ts`) — the
  authoritative "the bytes arrived" signal, for images, videos AND generic media.
  (2) **Resize**: for a fresh product-image original (`src/product-images/guards.ts`:
  `produtos/<produtoId>/originals/<hash>.<ext>`, `image/*`, no `resized=true`
  loop-guard marker) generates the **200px / 400px / full-JPEG** derivatives + docs.
- **`reconcileProductImages`** (`onSchedule`, every 48h) — backfills derivatives for
  originals the trigger never finished (issue #189). Uploads are content-addressed
  and deduped, so a re-upload won't re-fire the trigger; instead, the client stamps
  each original's `arquivos` doc `resizeState: 'pending'`, the resize flips it to
  `'done'`, and the sweep queries ONLY `where resizeState == 'pending'` — a filtered
  query (O(missing)), never a full catalog scan. Both share the idempotent
  `processProductOriginal` (`src/product-images/processOriginal.ts`), which writes
  only missing derivatives and skips the download when complete.
- **`onArquivoDeleted`** (`onDocumentDeleted('arquivos/{id}')`) — doc-anchored
  Storage cleanup: deleting an `arquivos` doc deletes the object it owned; for a
  product-image original it cascades to the 3 derivative objects + docs. Core logic
  in `processArquivoDeletion` (exported for the emulator suite); a dedup-resurrection
  guard skips the delete if a doc with the same content-addressed id exists again.
  Pairs with the **create-first** upload contract in `@delfrance/storage`: the doc
  is written BEFORE the bytes (so a dead upload leaves a `uploadState: 'pending'`
  phantom, not an orphan object) and the object carries its `arquivoId` in custom
  metadata. ⚠️ Like every Firestore access here, the trigger targets the **named
  `default`** database (`database: FIREBASE_DATABASE_ID ?? 'default'`) — see
  gotcha #8; a trigger that omits `database` binds to `(default)` and never fires.
- **`onProdutoMediaChanged`** (`onDocumentUpdated('produtos/{id}')`) — the eager
  produto-**edit** reaper (sibling of the planned produto-**delete** #136). Diffs the
  edit's `before`/`after` `fotos` + `videos` + `anexos` arrays by `arquivoOuterRef`; a ref
  that disappeared → stamp `markedForDeletionAt: now` on that `arquivos` doc; a re-added ref
  → clear it (`null`). The mark is a **signal only** — `sweepMarkedForDeletion` does the
  delete after a short grace + owner re-verify, so a buggy/bulk save that drops `fotos`
  can only mark (reversibly), never instantly destroy photos. Core
  `reconcileProdutoMediaMarks` (exported for the emulator suite); one batched `getAll` +
  `WriteBatch`, touching only existing `arquivos` docs (already-swept ref → no-op, no
  resurrected phantom). Writes never touch `produtos` → no self-retrigger. Plain admin
  writes (no pipeline) → fully emulator-testable. All three media kinds are product-scoped
  (`produtos/<id>/originals|videos|anexos`). Targets the named `default` database (gotcha #8).
- **`reconcileArquivoOrphans`** (`onSchedule`, every 48h) — orphan cleanup, **three**
  bounded passes (ADR 0010 Phase 2), all **oldest-first** and excluding the grace
  window **in the query**. **Marked sweep** (`sweepMarkedForDeletion`, runs first —
  cheapest): `arquivos where markedForDeletionAt<cutoff orderBy markedForDeletionAt asc`
  (single-field index `arquivos(markedForDeletionAt)`, short grace
  `ARQUIVO_MARKED_GRACE_HOURS` default 1h) — deletes what `onProdutoMediaChanged`
  flagged, re-verifying via `resolveReferencedArquivoRefs` that the owner produto still
  doesn't reference it (a missed unmark clears the mark instead). Plain query, no
  pipeline → emulator-testable. **Phantom-doc sweep** (`sweepPhantomDocs`):
  `arquivos where uploadState=='pending' AND criadoEm<cutoff orderBy criadoEm asc`
  (composite index `arquivos(uploadState, criadoEm)`) whose object never arrived →
  delete the doc (or self-heal to `'finalized'` if the object IS present).
  **Unreferenced sweep** (`sweepUnreferencedArquivos`, the **backstop** for what the
  eager mark missed): product media (`produtos/<id>/originals|videos|anexos`) past
  the grace window that **no produto references** → delete (then `onArquivoDeleted` frees
  the object + cascades any derivatives) — a produto deleted entirely (until #136), a console
  edit, or a dropped trigger delivery. Candidates come from a **regex pipeline**
  (`fetchUnreferencedCandidates`: `regexContains('filepath', …) AND criadoEm<cutoff`,
  sorted, on the `arquivos(criadoEm)` index) so non-product docs are never loaded;
  the reference check is an **owner-document lookup**, NOT a collection scan: a
  product arquivo encodes its owner `produtoId` in its storage path, so
  `resolveReferencedArquivoRefs` reads ONLY the produtos owning the candidate batch
  (one batched `getAll`, field-masked to `fotos`/`videos`/`anexos`) —
  O(distinct produtos), never O(all produtos). ⚠️ The pipeline (admin v14 /
  `@google-cloud/firestore` v8 `@google-cloud/firestore/pipelines`) does **not** run
  in the emulator, so the candidate fetch and the owner lookup are **seams**
  (`fetchCandidates` / `resolveReferenced`) the emulator suite overrides; the
  pipeline is live-validated. Grace is `ARQUIVO_ORPHAN_GRACE_HOURS` (0 in tests);
  `criadoEm` is microseconds-since-epoch (schema default `nowMicros()`).
  ⚠️ **Index requirement**: this Enterprise edition creates NO index automatically
  — the three sweep indexes (`arquivos(uploadState, criadoEm)`, `arquivos(criadoEm)`
  + `arquivos(markedForDeletionAt)`) are declared in `firestore.indexes.json` and must
  be deployed (`firebase deploy --only firestore:indexes`); verify usage live with
  `scripts/check-sweep-indexes.mjs` (`explain({ analyze: true })`).
  ⚠️ **Coverage caveat**: the candidate scan still re-reads the OLDEST docs, so a
  large head of long-lived referenced photos can starve newer orphans — a persisted
  round-robin cursor is the planned fix (issue #234).

- **`onProdutoDeleted`** (`onDocumentDeleted('produtos/{produtoId}')`) — estoque
  cascade (#226). On a produto delete (parent OR variation child) it sweeps the
  produto's `estoques` docs and each one's nested `historicoEstoque` (Firestore
  never cascades subcollections; #136). The client `deleteProdutoCascade` (#199)
  only deletes the produto docs — this reclaims the subcollections server-side,
  with no dependency on the client/e2e cleanup. One `recursiveDelete` over the
  `estoques` subcollection (the Admin SDK walks the whole subtree via a
  BulkWriter); scoped to estoque now — a produto-wide `recursiveDelete(produtoRef)`
  would be the broader #136 sweep.
- **`onEstoqueDeleted`** (`onDocumentDeleted('produtos/{produtoId}/estoques/{estoqueId}')`)
  — sweeps a single estoque's `historicoEstoque` via one `recursiveDelete`.
  Covers a standalone estoque delete; the produto-wide cascade already deletes
  history directly, so its re-fires of this trigger are idempotent no-ops.
- **`aplicarEstoque`** (`onCall` — the repo's FIRST HTTPS callable) — server-owned
  estoque write path for the web client (replaces the direct client `writeBatch`
  from PR #217). ONE Firestore transaction does getOrCreate + the movement
  (entrada/saída delta or balanço absolute set) / localização + the
  `historicoEstoque` audit record — so the first-movement create race and the
  clamping policy live in one trusted place. Enforces auth + `PERM.estoque.write`
  itself (the `su` super-user claim short-circuits, like the rules) since the
  Admin SDK bypasses Firestore rules; rules stay OPEN for Flutter coexistence
  (ADR 0010). Split per op into the exported (no-auth) `aplicarLocalizacao` /
  `aplicarMovimento` cores the emulator suite drives directly: `aplicarMovimento`
  reuses `planMovimentacao` (`@delfrance/data/produto`); `aplicarLocalizacao` updates
  ONLY `localizacao` on an existing estoque (quantities are movement-owned).
  Follow-up: `quantidadeReservada ≥ 0` on every movement path + monotonic
  `ultimaModificacao` (blocked — the Node SDK has no `FieldValue.maximum`). ⚠️ On the app's
  critical path: the staging estoque tab + the estoque
  Playwright e2e only work once this is DEPLOYED (deploy is manual — root rule #1).
- ⚠️ All three target the NAMED `default` database (gotcha #8). `@delfrance/auth`
  is a new build-time dep (esbuild-bundled, like data/schemas) for `hasPerm`/`PERM`.

- The entry (`src/index.ts`) is **esbuild-bundled into a single ESM file**.
  Only `firebase-admin`, `firebase-functions`, `@google-cloud/firestore` (the
  orphan sweep imports pipeline builders from `@google-cloud/firestore/pipelines`),
  and `sharp` are `external`; everything else (incl. `@delfrance/data`,
  `@delfrance/schemas`) is inlined.
- The function **region is inlined at build time** (`build.mjs`, esbuild
  `define`), defaulting to `us-east1` — the Storage bucket region the gen2
  trigger must match. It is **never** read from `.env.local` (secrets). Override
  for another env via the `FUNCTIONS_REGION` env var only.

## Testing

- **CI**: `ci-storage.yml` runs the emulator suite (`firebase.functions.json`,
  Storage+Firestore emulators on 8080/9199) via `firebase emulators:exec … "pnpm
  --filter @delfrance/functions test:storage"`. This is the authority — it does
  **not** hit a real Firebase project.
- **Local**: `pnpm --filter @delfrance/functions test` (unit; `guards.ts` is pure
  and exhaustively tested) and `typecheck`.

## Deploying (manual & coordinated — root rule #1)

One command, from the checkout that carries `firebase.functions.deploy.json`, ASK USER FOR PERMISSION BEFORE RUNNING IT:

```bash
firebase deploy --only functions:storage \
  --config firebase.functions.deploy.json --project <project-id> --force
```

The `predeploy` hook regenerates the deploy artifact at **`<repo-root>/.deploy/functions`**
via `scripts/prepare-deploy.mjs`; `source` points there. **Do NOT deploy the
`apps/functions` directory directly** (see gotcha #3). Full lane + the 5-step
post-deploy photo verification live in `DEPLOY.md`.

## Deploy gotchas (hard-won — first successful deploy 2026-06-17)

Every one of these blocked the first real deploy. Read before touching the
deploy config or `prepare-deploy.mjs`.

1. **`dist/index.js does not exist`** — the bundle is git-ignored, so it only
   exists after a build. Fix: the `predeploy` hook builds the artifact every
   time; the build can't be skipped.

2. **Never read `.env.local` during deploy** (it holds secrets). The only
   build-time value is the region, a non-secret constant — `build.mjs` defaults
   it to `us-east1`. Do not reintroduce a `dotenv -e .env.local` predeploy.

3. **Cloud `npm install` cannot resolve pnpm `workspace:*`**
   (`EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`). The gen2
   buildpack's install also **parses `devDependencies` specs even with
   `--omit=dev`** — verified — so merely moving the workspace deps to
   `devDependencies` does NOT help, and an `.npmrc` `omit=dev` would not either.
   Fix: deploy a **generated, minimal `package.json`** carrying only the 3 real
   runtime `dependencies` (firebase-admin / firebase-functions / sharp) — no
   `devDependencies`, no `workspace:*`, no build script. esbuild already bundled
   data/schemas, so the cloud needs nothing else. This is why `source` is a
   generated folder, not `apps/functions`.

4. **`Failed to find location of Firebase Functions SDK`** — firebase-tools'
   *local* trigger analysis locates AND spawns the SDK from
   `<source>/node_modules/.bin/firebase-functions` and **does not walk up** to a
   parent `node_modules` (see `findFunctionsBinary` in firebase-tools
   `…/runtimes/node/index.js`, which checks only 4 fixed dirs). Fix:
   `prepare-deploy.mjs` junctions the workspace's `node_modules` into the
   artifact; `ignore: ["node_modules"]` keeps the junction OUT of the upload, so
   the cloud still reinstalls just the 3 deps.

5. **The junction's directory depth matters** — pnpm's symlinks inside
   `node_modules` are **relative**. The artifact MUST sit at the **same depth as
   `apps/functions`**, which is why it is `<repo-root>/.deploy/functions` and NOT
   `apps/functions/.deploy`. One level too deep makes the relative symlinks
   overshoot → `Cannot find module …/firebase-functions/lib/bin/firebase-functions.js`
   when the spawned SDK loads. (`.deploy` is not matched by the `pnpm-workspace`
   globs, so it is never treated as a workspace package.)

6. **Norton TLS interception (local machine only)** — running `firebase`/`npm`
   from a shell that does not trust Norton's MITM root fails with
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `Failed to make request to
   cloudresourcemanager.googleapis.com`. Fix: prefix the command with
   `NODE_EXTRA_CA_CERTS=<path>/norton-root.pem` (the user's own terminal already
   trusts it). This is also why the artifact uses a `node_modules` **junction**
   rather than a fresh `npm install` — a local registry install hits the same
   Norton TLS wall (and an npm peer-resolution `ERESOLVE`).

7. **`Changing from an HTTPS function to a background triggered function is not
   allowed`** — if a function with the same name already exists with a different
   trigger type (e.g. a leftover HTTPS stub from an earlier attempt), Firebase
   won't switch it in place. Delete it first, then redeploy:
   `firebase functions:delete resizeProductImage --region us-east1 --project <id> --force`.
   (Deleting deployed cloud functions is a destructive shared-infra action — the
   agent is correctly blocked from doing it; ask the user to run the delete.)

8. **gRPC `5 NOT_FOUND` at runtime on a Firestore `.get()`/write** — this project family uses the
   **named `default`** Firestore database (Firestore *Enterprise* edition: the database is
   literally named `default`, NOT `(default)`). `getDb()` (`src/lib/admin.ts`) defaults the id to
   `'default'`, overridable via `FIREBASE_DATABASE_ID` — never call `getFirestore()` without the
   id, or it targets the non-existent `(default)` database and every operation fails with
   `5 NOT_FOUND`. The emulator suite must read the same id (see the storage test's `getDb`). The
   convention is repo-wide (apps/web, apps/integrations, apps/nfe, tools/test-fixtures,
   `.env.example`).

9. **Cloud build `ERESOLVE` on `firebase-admin@14`** — this package is on
   firebase-admin 14 for the `@google-cloud/firestore` v8 **Pipelines** API, which
   the orphan sweep's `fetchUnreferencedCandidates` regex scan needs (a hard
   requirement — not optional). But `firebase-functions` (incl. 7.x) still pins its
   peer to `firebase-admin@^11 || ^12 || ^13`. pnpm tolerates the mismatch locally
   and the combo is runtime-fine (the ci-storage emulator suite passes on admin 14 +
   functions 7.x), but the gen2 buildpack's STRICT `npm install` fails with
   `ERESOLVE unable to resolve dependency tree`. Fix: `prepare-deploy.mjs` writes a
   `legacy-peer-deps=true` **`.npmrc`** into the artifact, relaxing ONLY the cloud
   peer check (repo + CI installs are untouched). Remove once firebase-functions
   adds `^14` to its peer range.

## Build notes

- `build.mjs` exports `bundle(outfile)` and resolves paths from `import.meta.url`,
  so it runs from any cwd. Running it directly (`node build.mjs` /
  `pnpm --filter @delfrance/functions build`) writes `dist/index.js` for **local
  inspection only** — the deploy uses `.deploy/functions`, not `dist/`.
- Keep `firebase.functions.json` (the emulator config) separate from
  `firebase.functions.deploy.json` (the deploy config) — the former must never be
  pointed at `firebase deploy`.
