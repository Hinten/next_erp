# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`@delfrance/erp-next` — a multi-app Next.js monorepo, the open-source rewrite
of a former Flutter ERP. Goal: feature parity, OSS, same Firebase backend.

This is a **standalone repository**: `apps/`, `packages/`, `tools/` and the
`.github/` workflows are all at the repo root. (The project once lived as a
`next-rewrite/` subfolder of the old Flutter monorepo and was later split out
with `git filter-repo` — that split is **done**; ignore any lingering
references to a `next-rewrite/` subfolder.) The Flutter ERP is a separate repo
and out of scope here.

CI is **active** — see `.github/workflows/`: `ci.yml` (offline:
lint/typecheck/format/test/build), the domain pipelines `ci-nfe.yml` and
`ci-storage.yml`, and **two** Playwright e2e workflows split by domain —
`e2e-cadastros.yml` and `e2e-vendas.yml` (sharing the `e2e-reusable.yml`
engine) — plus the scoped `e2e-emulator.yml` (the estoque spec against the
Firebase emulators) — each running concurrently with `ci.yml`. See "When
making changes".

## Critical rules

1. **`firestore.rules` is GENERATED — never hand-edit, never deploy
   unilaterally**. `packages/rules-gen` emits it from the Zod collection
   metadata (`pnpm --filter @delfrance/rules-gen gen:rules`); `ci-rules.yml`
   fails on drift. Deploy stays manual/coordinated. There are **two** generated
   rulesets: **production** runs `firestore.rules` (root `firebase.json`); the
   **staging** project runs the `--e2e` variant `firestore.e2e.rules`
   (`gen:rules:e2e`, deployed via `firebase.staging.json`), which adds one
   `e2e_<runId>_*` namespace block so the Playwright fixtures aren't
   default-denied. Deploying the plain `firestore.rules` to staging breaks e2e
   on every branch (#160). Staging deploy:
   `firebase deploy --only firestore:rules --config firebase.staging.json --project <staging>`.
   **Never deploy `firestore.e2e.rules` to production** — it opens every
   `e2e_`-prefixed collection. The generated rules also carry a break-glass
   **super user**: a dedicated boolean `su` claim (minted server-side for
   `usuario.isSuperUser` accounts — never self-grantable) short-circuits every
   permission + tenancy check via `isSuperUser()`, though field validators still
   apply. Mint one with `pnpm --filter @delfrance/test-fixtures create-super-user
   <email>` (durable: also sets `usuarios/<uid>.isSuperUser`); `grant-all-perms`
   grants all *defined* bits but is NOT a super user. The pre-commit hook
   (`prettier --write --ignore-unknown` + scoped ESLint) **cannot** touch the
   generated rulesets or their `.snap` snapshots — Prettier has no `.rules`/`.snap`
   parser, they're listed in `.prettierignore`, and ESLint only matches
   `.ts`-family files. So **committing never introduces rules drift**; drift comes
   *only* from a schema/PERM/validator change, which `gen:rules` handles. Do
   **not** run a post-commit "did the hook cause drift?" check — it is always a
   no-op.
2. **Codegen is deliberately minimal**. The only generator is `firestore.rules`
   (`packages/rules-gen`, custom — ADR 0003 found no npm package that fits).
   Form widgets, query builders, cascade, JSON converters — all manual TS, no
   codegen.
3. **No Firebase emulators** — except the dedicated CI suites. App/e2e
   tests run against the staging Firebase project (set via
   `FIREBASE_PROJECT_ID`); fixture seed/teardown lives in `tools/test-fixtures`
   (see the `schema-driven-crud` skill). The carve-outs: `ci-storage.yml`
   (`firebase.functions.json`, ports 8080/9199) and `ci-rules.yml`
   (`firebase.rules.json`, port 8081) run emulator suites against offline demo
   projects. A third, **scoped** carve-out is `e2e-emulator.yml`: it runs the
   single estoque Playwright spec (`produto-estoque.emulator.e2e.spec.ts`)
   against the Auth+Firestore+Functions emulators (`firebase.e2e.json`) so its
   `aplicarEstoque` callable is served locally — no staging deploy needed. This
   is the ONLY e2e spec on the emulator; every other spec still hits staging.
4. **`apps/web` is client-first**. Default to `'use client'`. Server
   Components, Server Actions, route handlers, and middleware are exceptions
   that need explicit justification in PRs (cost + simplicity reasons). The
   ERP is behind auth, no SEO. Server compute concentrates in
   `apps/integrations`.
5. **No `apps/web/middleware.ts`**. Auth guard is client-side via
   `useRequireAuth()` from `apps/web/lib/auth/`. Security lives in Firestore
   rules, not in middleware.
6. **No generic `catch`**. Every `catch` must check
   `err instanceof <SpecificError>` (e.g. `FirebaseError`, `SyntaxError`,
   `ZodError`, an in-repo class) and `throw err` for anything that does not
   match. `catch {}` without binding, `catch (e) {}` with empty body, and
   `catch (e) { return null }` without a rethrow are forbidden.
   `err instanceof Error` (the base class) does **not** count as narrowing —
   `Error` is the parent of every exception. ESLint enforces the mechanical
   part via `no-empty` + two `no-restricted-syntax` selectors in
   `packages/config-eslint/index.js`; "which class on the RHS of `instanceof`"
   is a convention, not a lint rule.

## Layout

```
apps/
  web/           ERP UI + customer-facing pages
  webchat/       Embeddable chat widget
  integrations/  API-only: webhooks, OAuth callbacks (pkg @delfrance/integrations-app)
  docs/          Astro Starlight docs site
  example/       OSS demo
packages/
  ui/            Mantine theme + primitives, plus generic TableView /
                 ObjectView built on the Zod schemas (depends on firebase,
                 zod, react-hook-form, @mantine/dates, @tabler/icons-react)
  schemas/       Zod schemas + collection metadata (single source of truth)
  data/          defineCollection<T>, cascade runtime
  auth/          Permission helpers, BigInt-encoded claims + d_* rules claims
  core/          money, address, documents, tenant, plugin contracts
  integrations/  Domain sub-packages: NFe, MP, marketplaces, freight (Phase 5)
  plugin-sdk/    Public surface for third-party plugins
  rules-gen/     firestore.rules generator (gen:rules / gen:rules:check) +
                 emulator behavior suite (test:rules) + Rules API validation
  config-*/      Shared ESLint/TS configs (config-eslint, config-tsconfig).
                 Prettier config lives at the repo root (prettier.config.mjs).
tools/
  test-fixtures/  Admin SDK seed/teardown for staging
  migrations/     (empty until Phase 6)
.github/workflows/  Active CI: ci.yml, ci-nfe.yml, ci-storage.yml, ci-rules.yml, e2e-*.yml
```

Root config: `pnpm-workspace.yaml` (globs `apps/*`, `packages/*`,
`packages/integrations/*`, `tools/*`), `turbo.json`, `tsconfig.base.json`,
`vitest.workspace.ts`, `firebase.json` (+ `firebase.functions.json` /
`firebase.rules.json`, the deploy-isolated emulator configs), `.changeset/`.

## Common commands

```bash
pnpm install
pnpm dev                                  # all apps in parallel
pnpm --filter @delfrance/web dev          # one app
pnpm turbo run lint typecheck             # before commits
pnpm turbo run test                       # vitest across packages
pnpm turbo run test:e2e                   # playwright against staging
pnpm turbo run build
```

Per-app:
```bash
pnpm --filter @delfrance/web build
pnpm --filter @delfrance/integrations-app dev
```

## When making changes

- New schema → `packages/schemas/<domain>.ts` first; Zod is the source of truth. Register the new `{ schema, meta }` domain object in `packages/schemas/src/registry.ts` (`ALL_DOMAINS`) — `registry.test.ts` fails if you forget.
- **Any `*Meta` permission/path change, PERM change, or validator-whitelist change** → regenerate and commit the ruleset: `pnpm --filter @delfrance/rules-gen gen:rules`. `ci-rules.yml`'s drift check fails otherwise; the snapshot diff in `packages/rules-gen/src/__snapshots__/` shows reviewers the exact rules impact.
- **Optional Firestore fields**: prefer `z.string().nullable()` over `z.string().nullable().optional()`. Firebase JS SDK v12 rejects `undefined` in `addDoc`/`setDoc` (`Function addDoc() called with invalid data ... Unsupported field value: undefined`). `.nullable()` alone makes the parsed type `T | null` — the field must be present, never `undefined`. Forms default empty inputs to `null`; Firestore stores `null` cleanly. Only use `.optional()` for fields that are truly optional in the wire format (e.g. server-side defaults like `timestamp` that the client never sets).
- New collection → use `defineCollection({ path, schema })` from `packages/data`. Do not write Firestore SDK calls in app code unless `defineCollection` cannot express it.
- New schema-driven CRUD screen (list/detail/create with `TableView` + `ObjectView`) → follow the `schema-driven-crud` skill.
- New UI form → react-hook-form + Zod resolver + `Controller` for Mantine inputs. Mark the file `'use client'`.
- New page in `apps/web` → default to client component (`'use client'` at top). Reads/writes via Firebase JS SDK directly + TanStack Query (`useQuery` for one-shot, `onSnapshot` wrapped in a custom hook for real-time).
- New webhook receiver → goes in `apps/integrations/app/api/webhooks/<channel>/route.ts`, NOT in `apps/web`.
- New OAuth callback → same: `apps/integrations/app/api/oauth/<channel>/callback/route.ts`.
- Heavy work (sync, retry, long-running) from a webhook → dispatch to a Cloud Function; route handler responds 200 fast.
- Adding a Server Component / Server Action / route handler in `apps/web` → justify in the PR description. Default answer is no.
- **New e2e test** → e2e is **two** Playwright workflows split by domain — `e2e-cadastros.yml` (smoke + `crud-cadastros`) and `e2e-vendas.yml` (configuracoes + `crud-vendas`) — sharing the `e2e-reusable.yml` engine. Both trigger on `pull_request` (same-repo only; fork PRs are skipped) and run **concurrently** with `ci.yml` (not gated on it), serving a **production build** (`next build` + `next start`), not `pnpm dev`. The **filename suffix decides the CI**: a schema-driven CRUD page needs only a new spec named `apps/web/e2e/<x>.cadastros.e2e.spec.ts` (master data) or `<x>.vendas.e2e.spec.ts` (sales/fiscal/config) — the matching project auto-collects it; no config or workflow edit. **Do not** add an e2e job to `ci.yml`. Each workflow run mints its **own** ephemeral test user (`e2e-user-<runId>@example.com`) and Firestore namespace (`e2e_<runId>`), isolated by `GITHUB_RUN_ID` (so the two run concurrently; `globalTeardown` run-scopes its stray-doc sweep in CI to match — there are no `E2E_USER_*` secrets). Each workflow comments the failing-job log tail on the PR on failure.

## Key fixed decisions

- Firebase backend stays.
- **Firestore Enterprise edition** — queries do **NOT require an index to run**: an
  unindexed query degrades to a full collection scan, it never throws
  `FAILED_PRECONDITION` (that error is Standard-edition only). Enterprise also
  auto-creates **no** indexes. Indexes are therefore **optional but recommended for
  cost/latency on the most-used queries** — declare them in `firestore.indexes.json`
  (the `indexes` array; `queryScope: COLLECTION` or `COLLECTION_GROUP`, single- or
  multi-field) and deploy with `firebase deploy --only firestore:indexes`. The
  database is named `default` (NOT `(default)`). Do not add client-side filtering
  just to avoid a composite index — filter server-side and index only if it's hot.
- Mantine v9 for UI (bumped from v7).
- Next.js 16 (baseline for Firebase App Hosting's stable Deployment Adapter API), React 19.2.
- Firebase JS SDK v12, firebase-admin v13 — except **`apps/functions` on
  firebase-admin v14** (bundles `@google-cloud/firestore` v8, the Firestore
  **Pipelines** API used by the arquivo orphan sweep). The bump is scoped to
  `apps/functions`; all other admin consumers (nfe, integrations, web,
  test-fixtures) stay on v13. Mixed versions validated typecheck-clean.
- Zod v4 as schema source of truth.
- TypeScript 6, ESLint 9 (the next-eslint-plugin chain doesn't support ESLint 10 yet), Vitest 4, Turbo 2.9.
- pnpm 10 (declared via `packageManager`).
- Apache-2.0 license.
- `apps/portal/` does NOT exist — public customer-facing pages decision deferred to Phase 5/6 (likely `apps/integrations` endpoints).
- `apps/integrations` deploys to Firebase App Hosting; heavy work to Cloud Functions.
- `apps/web` is client-first; no middleware; Server Components/Actions opt-in only with justification.
- `next lint` no longer exists in Next 16 — lint scripts call `eslint .` directly and each app's `eslint.config.mjs` spreads `@delfrance/config-eslint` + `eslint-config-next` flat configs.
