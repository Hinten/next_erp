# apps/functions — CLAUDE.md

Guidance for Claude Code when working in the `@delfrance/functions` package
(the gen2 Cloud Functions, codebase `storage`). The root `CLAUDE.md` still
applies — this file adds what is specific to deploying and building functions.

## What this is

gen2 (2nd-gen / Eventarc) Cloud Functions. Two exports:

- **`resizeProductImage`** (`onObjectFinalized`) — resizes a freshly uploaded
  product photo into its **200px / 400px / full-JPEG** derivatives and writes the
  derivative `arquivos` docs. Trigger contract (see `src/product-images/guards.ts`):
  fires ONLY for `produtos/<produtoId>/originals/<hash>.<ext>`, `image/*`, without
  the `resized=true` marker — the loop guard.
- **`reconcileProductImages`** (`onSchedule`, hourly) — backfills derivatives for
  originals the trigger never finished (issue #189). Uploads are content-addressed
  and deduped, so a re-upload won't re-fire the trigger; instead, the client stamps
  each original's `arquivos` doc `resizeState: 'pending'`, the resize flips it to
  `'done'`, and the sweep queries ONLY `where resizeState == 'pending'` — a filtered
  query (O(missing)), never a full catalog scan. Both share the idempotent
  `processProductOriginal` (`src/product-images/processOriginal.ts`), which writes
  only missing derivatives and skips the download when complete.

- The entry (`src/index.ts`) is **esbuild-bundled into a single ESM file**.
  Only `firebase-admin`, `firebase-functions`, and `sharp` are `external`;
  everything else (incl. `@delfrance/data`, `@delfrance/schemas`) is inlined.
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

## Build notes

- `build.mjs` exports `bundle(outfile)` and resolves paths from `import.meta.url`,
  so it runs from any cwd. Running it directly (`node build.mjs` /
  `pnpm --filter @delfrance/functions build`) writes `dist/index.js` for **local
  inspection only** — the deploy uses `.deploy/functions`, not `dist/`.
- Keep `firebase.functions.json` (the emulator config) separate from
  `firebase.functions.deploy.json` (the deploy config) — the former must never be
  pointed at `firebase deploy`.
