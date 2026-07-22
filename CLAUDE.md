# CLAUDE.md

Detail lives where it is cheaper: the per-app `CLAUDE.md` files, the
skills in `.claude/skills/`, the ADRs under `apps/docs/`, and package READMEs.

## What this is

`@delfrance/erp-next` (Apache-2.0) — a multi-app Next.js/Turborepo monorepo, the
OSS rewrite of the Delfrance Flutter ERP at feature parity on the same Firebase
backend. See `README.md` and `CONTRIBUTING.md`. The Flutter app is a separate
repo; a read-only copy sits at `.old/` (gitignored, present only in local
checkouts) and is the **parity reference for ports**.

CI — everything in `.github/workflows/` runs **concurrently**, gated on nothing.
`ci.yml` and `e2e-emulator.yml` are the two workflows with no path filter, so
every PR gets both; `ci.yml` excludes the nfe/freight/storage/functions tests,
which the domain pipelines `ci-{nfe,freight,storage,rules}.yml` own.

⚠️ Every other workflow is **`paths:`-filtered**, the staging e2e lanes included
(apps/web, packages/{schemas,ui,data,auth,core}, tools/test-fixtures). A PR
touching only `packages/integrations/**` or `apps/nfe/**` runs **no e2e** —
those checks show *skipped*, not failed. "CI green" ≠ "e2e passed".

Every `pull_request` base filter is
`[master, main, 'claude/**', 'feat/**', 'fix/**']`. That key matches the PR's
**base**, so a **stacked PR** must sit on one of those prefixes — on anything
else (`chore/`, `docs/`, …) it reports zero checks, not failures.

## Critical rules

1. **Firestore is ENTERPRISE edition — the usual limits do not apply, and it
   cuts both ways.** A query never needs an index to *run*: an unindexed
   `where`/`orderBy`/`collectionGroup` does **not** throw `FAILED_PRECONDITION`
   and offers no one-click index link — it silently **full-scans**, and
   Enterprise bills **data scanned**, so the mistake lands on the invoice rather
   than in your face. Enterprise auto-creates **zero** indexes: declare them in
   `firestore.indexes.json`. Index hot queries; when possible, filter
   client-side to use the firebase local cache. **Three query classes are
   index-MANDATORY** — every `meta.defaultQuery`, every `meta.pickerRecencySort`,
   every TableView update-monitor query — enforced by the
   `delfrance/default-query-needs-index` lint **error** plus the
   `packages/schemas/src/defaultQuery.indexes.test.ts` backstop; both print
   paste-ready JSON. Two more deltas: the database is literally named
   **`default`**, not `(default)` — pass it explicitly or every op fails
   `5 NOT_FOUND`; and Enterprise omits the implicit trailing `__name__` field,
   so index JSON copied from Standard-edition docs is wrong. Enterprise also
   unlocks the **Pipelines API** (used in `packages/data` and the arquivo orphan
   sweep), which does **not** run in the emulator — hence the test seams.
2. **The Firestore rulesets are GENERATED — never hand-edit, never deploy.**
   `packages/rules-gen` emits both from the Zod collection metadata. Any
   `*Meta` permission/path, PERM, or validator-whitelist change means running
   **both** `gen:rules` **and** `gen:rules:e2e` (each writes one file) and
   refreshing the two vitest snapshots in `packages/rules-gen/src/__snapshots__/`.
   `ci-rules.yml` drift-checks both rulesets *and* diffs both snapshots, so
   regenerating only one reds CI. `firestore.rules` = production;
   `firestore.e2e.rules` = staging + the emulator lane, and it opens every
   `e2e_`-prefixed collection so it must **never** reach production. Deploying
   rules is a manual, coordinated human step: **agents never run
   `firebase deploy`.** See `packages/rules-gen/README.md`.
3. **Codegen is minimal — exactly two generators.** The rulesets above (ADR
   0003) and the NF-e XSD→TypeScript types (`gen:nfe-types` in
   `packages/integrations/nfe` → **committed** files under `generated/`, ADR
   0004 — never hand-edit those). Form widgets, query builders, cascade and JSON
   converters are all manual TS.
4. **Emulators only in named carve-outs.** Default target is the staging
   Firebase project (`FIREBASE_PROJECT_ID`; the carve-outs point the same var at
   the offline `demo-erp`), with seed/teardown in `tools/test-fixtures`. The
   carve-outs are `ci-storage.yml`, `ci-rules.yml`, and `e2e-emulator.yml`
   (`firebase.e2e.json`, auth+firestore+storage+functions), which runs **every**
   `*.emulator.e2e.spec.ts` — two today. Every other e2e spec hits staging. Do
   **not** add a local-dev emulator mode: `NEXT_PUBLIC_USE_FIREBASE_EMULATOR`
   exists for that CI lane only and is off by default.
5. **`apps/web` is client-first.** Default to `'use client'` — the ERP is behind
   auth, no SEO. Server Components, Server Actions, route handlers and
   **middleware** need PR justification; the one standing exception is
   `app/layout.tsx`, which must stay a Server Component because Next requires
   `export const metadata` there. **No app has a `middleware.ts`** — the auth
   guard is `useRequireAuth()` and security lives in Firestore rules. Server
   compute belongs in the API-only sibling apps and `apps/functions`, never in
   `apps/web`. See `apps/web/CLAUDE.md`.
6. **No generic `catch`.** Narrow with `err instanceof <SpecificError>`
   (`FirebaseError`, `ZodError`, an in-repo class) and `throw err` for anything
   else. `err instanceof Error` does **not** count — it is the parent of every
   exception. ESLint blocks the mechanical part (`no-empty` + two
   `no-restricted-syntax` selectors); which class sits on the RHS is convention.
   ⚠️ Flat config **replaces** a rule by name instead of merging, so a workspace
   that redeclares `no-restricted-syntax` drops the base selectors. Five apps
   re-spread them; **`apps/nfe` and `packages/integrations/nfe` deliberately do
   not** — there the catch rule is OFF and the convention is on you, which is
   exactly where a swallowed SEFAZ error costs most.

## Layout

**apps/** — dev port in parens, all Next.js unless noted.

- `web` (:3000) — internal ERP UI, client-first. Only app with Playwright e2e.
- `integrations` (:3001) — generic webhook/OAuth scaffolding; per-channel routes
  have moved out to their own apps.
- `webchat` (:3002) static-export chat widget · `docs` (:3003) Astro Starlight
  (hosts the ADRs) · `example` OSS demo (`pnpm demo`, no dev server).
- `nfe` (:3004) · `melhor-envio` (:3005) · `mercado-livre` (:3006) ·
  `mercado-pago` (:3007) · `whatsapp` (:3008) — API-only App Hosting backends,
  **one deployable per channel**, each importing its logic from the matching
  `packages/integrations/<channel>`.
- `functions` — **not** a Next app: gen2 Cloud Functions, codebase `storage`.

`apps/{nfe,mercado-livre,mercado-pago,whatsapp}/functions/` are **nested**
Functions codebases deployed via `firebase.<name>.deploy.json`. They are **not**
pnpm workspace members — the parent app's tsconfig/eslint/vitest cover them.

**packages/** — `schemas` (Zod schemas + collection metadata, **the** source of
truth) · `data` (`defineCollection<T>`, cascade) · `ui` (Mantine theme +
`TableView`/`ObjectView` derived from the schemas) · `core` · `auth` ·
`storage` · `plugin-sdk` · `rules-gen` · `config-{eslint,tsconfig,vitest}` ·
`integrations/<channel>`, of which only nfe, mercado-livre, mercado-pago,
freight-br and whatsapp-cloud-api are implemented — the other five throw
`NotImplemented`.

**tools/** — `test-fixtures` (Admin SDK seed/teardown, `create-super-user`) ·
`migrations`. Firebase configs: `firebase.json` (prod), `firebase.staging.json`,
emulator-only `firebase.{functions,rules,e2e}.json`, and five deploy-isolated
`firebase.<codebase>.deploy.json`.

## Common commands

```bash
pnpm install                                # per worktree too; apps read ../../.env.local
pnpm --filter @delfrance/web dev            # ONE app — prefer this
pnpm dev                                    # WARNING: 9 dev servers, :3000-:3008
pnpm turbo run lint typecheck               # before commits
pnpm format:check                           # a CI gate; `pnpm format` fixes
pnpm turbo run test
pnpm --filter @delfrance/rules-gen gen:rules   # + gen:rules:e2e after any *Meta/PERM change
```

## When making changes

- **New schema** → `packages/schemas/src/<domain>.ts`, barrel-exported from
  `src/index.ts` and registered in `src/registry.ts` (`ALL_DOMAINS`) —
  `registry.test.ts` fails if you forget. Then regenerate both rulesets (rule 2).
- **Optional Firestore fields** → `.nullable().default(null)`. Never
  `.optional()` without a `.nullable()` in the chain: the Firebase SDK rejects
  `undefined` in `addDoc`/`setDoc`. `.nullable().optional()` is correct for
  server-stamped fields the client never writes. Enforced by
  `delfrance/no-optional-without-nullable`.
- **New collection** → `defineCollection({ path, schema })`. Partial updates go
  through the handle's `merge()`, never `setDoc(ref, patch, { merge: true })` on
  a converted ref — the converter full-parses the patch and the merge mask then
  overwrites stored sibling fields.
- **New CRUD screen** (`TableView` + `ObjectView`) → the `schema-driven-crud`
  skill. **New page or form in `apps/web`** → `apps/web/CLAUDE.md`.
- **New channel webhook or OAuth callback** → its **own app**,
  `apps/<channel>/app/api/{webhooks,oauth}/<channel>/…` — one App Hosting
  backend per channel. Never in `apps/web`, and no longer in
  `apps/integrations`. Heavy work dispatches to a Cloud Function; the route
  handler responds 200 fast.
- **New e2e test** → the **filename suffix picks the lane**, nothing else to
  wire: `.cadastros.e2e.spec.ts` (master data), `.vendas.e2e.spec.ts`
  (sales/fiscal/config), `.emulator.e2e.spec.ts` (offline), `.smoke.spec.ts`.
  **Do not** add an e2e job to `ci.yml`.

## Key fixed decisions

- Firebase backend stays. Node >= 22. Zod is the schema source of truth.
- **firebase-admin floor = v14, firebase-functions floor = `^7.3.0` — do not
  lower either.** `apps/functions` needs the v8 Pipelines API +
  `FieldValue.maximum/minimum` (a downgrade fails typecheck), and 7.3.0 is the
  first firebase-functions whose peer range admits `firebase-admin@^14` —
  lowering it breaks every deploy artifact's plain cloud `npm install`
  (`ERESOLVE`), which no CI lane exercises.
- `next lint` is gone in Next 16 — every lint script is `eslint .`, and the 8
  Next apps spread `@delfrance/config-eslint` + `eslint-config-next` +
  `typeAware(...)` with `prettier` LAST. `apps/{docs,example,functions}` are not
  linted.
- Four custom lint rules in `packages/config-eslint/rules/`:
  `default-query-needs-index`, `no-ad-hoc-money-rounding` and
  `no-optional-without-nullable` (error), `no-inline-admin-collection` (warn).
- Firebase App Hosting deploys every Next app; heavy work goes to Cloud
  Functions. `apps/portal/` does NOT exist — public pages are deferred.
- **Shared dependency versions live in the pnpm `catalog:`**
  (`pnpm-workspace.yaml`): a dep declared by 2+ workspace manifests is
  cataloged and referenced as `catalog:`; single-consumer deps stay literal.
  `catalogMode: strict` routes `pnpm add` through the catalog. Four things
  NEVER use `catalog:`: the 4 nested `apps/*/functions` manifests (not
  workspace members), `apps/functions`' runtime `dependencies` (every
  `prepare-deploy.mjs` copies `dependencies` verbatim into an artifact that
  plain cloud `npm install` must resolve), all `peerDependencies` (libraries
  keep broad ranges), and `workspace:*` specs. `next` stays pinned **exact**
  (`16.2.6`) in the catalog — a Next bump is still one deliberate edit, now a
  single line. `packageManager` is the authority for pnpm.
