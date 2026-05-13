# CLAUDE.md — next-rewrite

Guidance for Claude Code when working inside `next-rewrite/`. The Flutter app at the repo root is **separate** and out of scope for this folder.

## What this is

Multi-app Next.js monorepo, in-progress rewrite of the Flutter ERP. Goal: feature parity, OSS, same Firebase backend. Develops here in a subfolder; will be split to a public repo via `git filter-repo --subdirectory-filter next-rewrite` (Phase 6.1).

## Critical rules

1. **Do NOT add `.github/workflows/*.yml` here**. CI is intentionally disabled to avoid GitHub Actions minutes on the parent repo. Workflow templates live in `next-rewrite/ci-templates/` and only become real workflows in the public repo after the split.
2. **Do NOT modify Flutter code** (anything outside `next-rewrite/`). Flutter and Next coexist against the same Firestore.
3. **Do NOT hand-edit `firestore.rules`** — it is generated (or will be, once Phase 1 lands `packages/rules-gen/`). The Flutter repo's `firestore.rules` at the parent root is owned by the Flutter app for now.
4. **Codegen is deliberately minimal** vs. the Flutter project. The only generator is `firestore.rules` (and only if no npm package suffices). Form widgets, query builders, cascade, JSON converters — all manual TS, no codegen.
5. **No Firebase emulators**. Tests run against the staging Firebase project (set via `FIREBASE_PROJECT_ID` env var). See `apps/web/README.md` for fixture seed/teardown.
6. **`apps/web` is client-first**. Default to `'use client'`. Server Components, Server Actions, route handlers, and middleware are exceptions that need explicit justification in PRs (cost + simplicity reasons). The ERP is behind auth, no SEO. Server compute concentrates in `apps/integrations`.
7. **No `apps/web/middleware.ts`**. Auth guard is client-side via `useRequireAuth()` from `apps/web/lib/auth/`. Security lives in Firestore rules, not in middleware.
8. **No generic `catch`**. Every `catch` must check `err instanceof <SpecificError>` (e.g. `FirebaseError`, `SyntaxError`, `ZodError`, an in-repo class) and `throw err` for anything that does not match. `catch {}` without binding, `catch (e) {}` with empty body, and `catch (e) { return null }` without a rethrow are forbidden. `err instanceof Error` (the base class) does **not** count as narrowing — `Error` is the parent of every exception. ESLint enforces the mechanical part via `no-empty` + two `no-restricted-syntax` selectors in `packages/config-eslint/index.js`; "which class on the RHS of `instanceof`" is a convention, not a lint rule.

## Layout

```
apps/
  web/           ERP UI + public customer-facing pages
  webchat/       Embeddable chat widget
  integrations/  API-only: webhooks, OAuth callbacks
  docs/          Astro Starlight docs site
  example/       OSS demo
packages/
  ui/            Mantine theme + primitives
  schemas/       Zod schemas + collection metadata (single source of truth)
  data/          defineCollection<T>, cascade runtime
  auth/          Permission helpers, BigInt-encoded claims
  core/          money, address, documents, tenant, plugin contracts
  integrations/  NFe, MP, marketplaces, freight (Phase 5)
  plugin-sdk/    Public surface for third-party plugins
  rules-gen/     (conditional, Phase 1)
  config-*/      Shared ESLint/TS/Prettier configs
tools/
  test-fixtures/  Admin SDK seed/teardown for staging
  migrations/     (empty until Phase 6)
ci-templates/   YAMLs for the public repo, NOT activated here
```

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
pnpm --filter @delfrance/integrations dev
```

## When making changes

- New schema → `packages/schemas/<domain>.ts` first; Zod is the source of truth.
- New collection → use `defineCollection(path, schema)` from `packages/data`. Do not write Firestore SDK calls in app code unless `defineCollection` cannot express it.
- New UI form → react-hook-form + Zod resolver + `Controller` for Mantine inputs. Mark the file `'use client'`.
- New page in `apps/web` → default to client component (`'use client'` at top). Reads/writes via Firebase JS SDK directly + TanStack Query (`useQuery` for one-shot, `onSnapshot` wrapped in a custom hook for real-time).
- New webhook receiver → goes in `apps/integrations/app/api/webhooks/<channel>/route.ts`, NOT in `apps/web`.
- New OAuth callback → same: `apps/integrations/app/api/oauth/<channel>/callback/route.ts`.
- Heavy work (sync, retry, long-running) from a webhook → dispatch to a Cloud Function; route handler responds 200 fast.
- Adding a Server Component / Server Action / route handler in `apps/web` → justify in the PR description. Default answer is no.

## Key fixed decisions

- Firebase backend stays.
- Mantine v9 for UI (bumped from v7).
- Next.js 16 (baseline for Firebase App Hosting's stable Deployment Adapter API), React 19.2.
- Firebase JS SDK v12, firebase-admin v13.
- Zod v4 as schema source of truth.
- TypeScript 6, ESLint 9 (the next-eslint-plugin chain doesn't support ESLint 10 yet), Vitest 4, Turbo 2.9.
- pnpm 10 (declared via `packageManager`).
- Apache-2.0 license.
- Develop in `next-rewrite/`; split to public repo on Phase 6.1.
- No CI in this folder.
- `apps/portal/` does NOT exist — public customer-facing pages decision deferred to Phase 5/6 (likely `apps/integrations` endpoints).
- `apps/integrations` deploys to Firebase App Hosting; heavy work to Cloud Functions.
- `apps/web` is client-first; no middleware; Server Components/Actions opt-in only with justification.
- `next lint` no longer exists in Next 16 — lint scripts call `eslint .` directly and each app's `eslint.config.mjs` spreads `@delfrance/config-eslint` + `eslint-config-next` flat configs.

## Setup problems

See `next-rewrite/devlogs/setup-problems.md` for issues encountered during scaffolding.
