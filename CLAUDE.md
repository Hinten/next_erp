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

CI is **active** — see `.github/workflows/`: `ci.yml` (lint/typecheck/test/
build) and `e2e.yml` (a single Playwright workflow that runs every e2e
suite). See "When making changes".

## Critical rules

1. **Do NOT deploy `firestore.rules` as-is**. The committed `firestore.rules`
   at the repo root is a deny-all placeholder — it exists so `firebase.json`
   resolves. A future phase wires up the real ruleset (generated or
   hand-written); `packages/rules-gen/` is planned and does not exist yet.
   Don't hand-author a real ruleset without coordinating that phase.
2. **Codegen is deliberately minimal**. The only generator is `firestore.rules`
   (and only if no npm package suffices). Form widgets, query builders,
   cascade, JSON converters — all manual TS, no codegen.
3. **No Firebase emulators**. Tests run against the staging Firebase project
   (set via `FIREBASE_PROJECT_ID`). Fixture seed/teardown lives in
   `tools/test-fixtures`; see the `schema-driven-crud` skill for the e2e flow.
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
  auth/          Permission helpers, BigInt-encoded claims
  core/          money, address, documents, tenant, plugin contracts
  integrations/  Domain sub-packages: NFe, MP, marketplaces, freight (Phase 5)
  plugin-sdk/    Public surface for third-party plugins
  config-*/      Shared ESLint/TS/Prettier configs (config-eslint,
                 config-prettier, config-tsconfig)
tools/
  test-fixtures/  Admin SDK seed/teardown for staging
  migrations/     (empty until Phase 6)
.github/workflows/  Active CI: ci.yml, e2e.yml (single Playwright workflow)
```

Root config: `pnpm-workspace.yaml` (globs `apps/*`, `packages/*`,
`packages/integrations/*`, `tools/*`), `turbo.json`, `tsconfig.base.json`,
`vitest.workspace.ts`, `firebase.json`, `.changeset/`. `packages/rules-gen/`
is planned (Phase 1) and not present.

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

- New schema → `packages/schemas/<domain>.ts` first; Zod is the source of truth.
- **Optional Firestore fields**: prefer `z.string().nullable()` over `z.string().nullable().optional()`. Firebase JS SDK v12 rejects `undefined` in `addDoc`/`setDoc` (`Function addDoc() called with invalid data ... Unsupported field value: undefined`). `.nullable()` alone makes the parsed type `T | null` — the field must be present, never `undefined`. Forms default empty inputs to `null`; Firestore stores `null` cleanly. Only use `.optional()` for fields that are truly optional in the wire format (e.g. server-side defaults like `timestamp` that the client never sets).
- New collection → use `defineCollection({ path, schema })` from `packages/data`. Do not write Firestore SDK calls in app code unless `defineCollection` cannot express it.
- New schema-driven CRUD screen (list/detail/create with `TableView` + `ObjectView`) → follow the `schema-driven-crud` skill.
- New UI form → react-hook-form + Zod resolver + `Controller` for Mantine inputs. Mark the file `'use client'`.
- New page in `apps/web` → default to client component (`'use client'` at top). Reads/writes via Firebase JS SDK directly + TanStack Query (`useQuery` for one-shot, `onSnapshot` wrapped in a custom hook for real-time).
- New webhook receiver → goes in `apps/integrations/app/api/webhooks/<channel>/route.ts`, NOT in `apps/web`.
- New OAuth callback → same: `apps/integrations/app/api/oauth/<channel>/callback/route.ts`.
- Heavy work (sync, retry, long-running) from a webhook → dispatch to a Cloud Function; route handler responds 200 fast.
- Adding a Server Component / Server Action / route handler in `apps/web` → justify in the PR description. Default answer is no.
- **New e2e test** → there is **one** e2e workflow, `.github/workflows/e2e.yml`. Adding a schema-driven CRUD page needs only a new `apps/web/e2e/<x>.e2e.spec.ts` — the `crud` Playwright project (`testMatch: /\.e2e\.spec\.ts$/`) picks it up automatically. **Do not** create a per-module `*-e2e.yml` and **do not** add an e2e job to `ci.yml`. `e2e.yml` runs every project (smoke, configuracoes, crud) in a single job: one `globalSetup` mints one ephemeral test user (`e2e-user-<runId>@example.com`, created via the Admin SDK and deleted by `globalTeardown` — there are no `E2E_USER_*` secrets), and Playwright `workers` parallelize the suites. Failures are reported by the workflow's own `report-failure` job.

## Key fixed decisions

- Firebase backend stays.
- Mantine v9 for UI (bumped from v7).
- Next.js 16 (baseline for Firebase App Hosting's stable Deployment Adapter API), React 19.2.
- Firebase JS SDK v12, firebase-admin v13.
- Zod v4 as schema source of truth.
- TypeScript 6, ESLint 9 (the next-eslint-plugin chain doesn't support ESLint 10 yet), Vitest 4, Turbo 2.9.
- pnpm 10 (declared via `packageManager`).
- Apache-2.0 license.
- `apps/portal/` does NOT exist — public customer-facing pages decision deferred to Phase 5/6 (likely `apps/integrations` endpoints).
- `apps/integrations` deploys to Firebase App Hosting; heavy work to Cloud Functions.
- `apps/web` is client-first; no middleware; Server Components/Actions opt-in only with justification.
- `next lint` no longer exists in Next 16 — lint scripts call `eslint .` directly and each app's `eslint.config.mjs` spreads `@delfrance/config-eslint` + `eslint-config-next` flat configs.
