---
title: Running tests
description: Run the unit, lint/typecheck/build and Playwright e2e suites on your machine.
---

The same suites that CI runs (`.github/workflows/ci.yml` and the e2e workflows
`e2e-cadastros.yml` / `e2e-vendas.yml`) can all run locally. Unit tests, lint,
typecheck and build need nothing but a clean install; only the e2e suite needs
Firebase credentials.

## Prerequisites

- Node 22 (matches CI; the repo's hard minimum is 20.10).
- pnpm 10 — provided via Corepack: `corepack enable`.
- `pnpm install` at the repo root.
- For e2e only: a Firebase project, a service-account key, and the Playwright
  browser (see [E2E tests](#e2e-tests)).

## Unit tests

Vitest across every package and app. Pure logic — **no env, no Firebase**.

```bash
pnpm turbo run test                       # whole monorepo
pnpm --filter @delfrance/web test         # one package
pnpm --filter @delfrance/web test:watch   # watch mode
```

## Lint, typecheck & build

Also env-free — this is exactly what `ci.yml` runs.

```bash
pnpm turbo run lint typecheck build
```

## E2E tests

Playwright drives `apps/web` against a **real Firebase project** — there are no
emulators (they are unstable for our use case). Point local runs at the
staging project.

### 1. Environment variables

All e2e variables live in the **single `.env.local` at the repo root**.
`apps/web`'s `dev`/`build`/`start` **and** `test:e2e` scripts load it via
`dotenv-cli`, so once the file exists the suite picks it up automatically.

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | yes | Web SDK config — consumed by the dev server |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | yes | " |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | yes | " |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | yes | " |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | yes | " |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | yes | " |
| `FIREBASE_PROJECT_ID` | yes | Admin SDK target project (staging) |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | yes | Path to the service-account JSON key |
| `E2E_SU_EMAIL` / `E2E_SU_PASSWORD` | optional | Pre-provisioned superuser — only the `configuracoes` suite uses it; without it that suite self-skips |
| `FIREBASE_DATABASE_ID` | optional | Firestore database id (default `default`) |

`FIREBASE_SERVICE_ACCOUNT_PATH` is preferred over the inline
`FIREBASE_SERVICE_ACCOUNT` (used by CI): the JSON's `private_key` is multiline
and awkward to embed in a `.env` file.

### 2. Get the service-account key

Firebase Console → **Project settings** → **Service accounts** → **Generate new
private key**. Save the downloaded JSON to `.secrets/serviceAccount.json` —
`.secrets/` is already in `.gitignore`, so the key never gets committed. Then in
`.env.local`:

```bash
FIREBASE_SERVICE_ACCOUNT_PATH=.secrets/serviceAccount.json
```

### 3. Install the Playwright browser

```bash
pnpm --filter @delfrance/web exec playwright install chromium
```

### 4. Run

```bash
pnpm --filter @delfrance/web test:e2e

# filter to one Playwright project:
pnpm --filter @delfrance/web exec playwright test --project smoke
pnpm --filter @delfrance/web exec playwright test --project crud-cadastros
pnpm --filter @delfrance/web exec playwright test --project crud-vendas
```

Playwright starts `pnpm dev` on `:3000` itself. If you already have `pnpm dev`
running it is reused (`reuseExistingServer` is on outside CI). The HTML report
lands in `apps/web/playwright-report/`.

### Suites & lifecycle

Locally, a plain `playwright test` runs all four projects; CI splits them across
two workflows (`e2e-cadastros.yml`, `e2e-vendas.yml`) that run concurrently with
`ci.yml` (not gated on it), each serving a production build:

- **`smoke`** — unauthenticated specs (`*.smoke.spec.ts`): login page,
  auth-guard redirects. _(e2e-cadastros)_
- **`configuracoes`** — User + Cargo CRUD; signs in as the SU
  (`E2E_SU_*`). _(e2e-vendas)_
- **`crud-cadastros`** — master-data CRUD specs (`*.cadastros.e2e.spec.ts`):
  clientes, enderecos, categorias, depositos, filiais. _(e2e-cadastros)_
- **`crud-vendas`** — sales/fiscal/config CRUD specs (`*.vendas.e2e.spec.ts`):
  pedidos, pedidos-nfe-snapshot, canais-balcao, bandeiras-cartao,
  motivos-incidente. _(e2e-vendas)_ The filename suffix decides the project
  (and CI workflow) — a new spec named with the right suffix is collected
  automatically.

`globalSetup` runs once per run: it seeds the namespaced tenant and mints an
**ephemeral** Firebase Auth user (`e2e-user-<runId>@example.com`) with all
permission bits, then captures its session. `globalTeardown` deletes that user
afterwards — there is no shared persistent test account.

### Troubleshooting

- **Authenticated specs all fail at `/login`.** `globalSetup` could not find
  the Admin SDK env (`FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT_PATH`).
  It logs `skipping auth setup — missing env` and degrades gracefully: only the
  `smoke` specs pass. Check `.env.local` and the key path.
- **`globalSetup` fails with `unable to verify the first certificate`** (or
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`). A corporate proxy / antivirus is doing
  TLS interception with a root CA that Node's bundled CA list doesn't trust.
  Node 22.15+ can read the OS certificate store instead — add
  `NODE_OPTIONS=--use-system-ca` to your root `.env.local` (it propagates to
  `globalSetup`, the workers and the dev server). The browser already trusts
  the OS store, so only the Node-side Admin SDK calls need this.
- **`configuracoes` specs skipped.** `E2E_SU_EMAIL` / `E2E_SU_PASSWORD` are not
  set — expected if you only configured the ephemeral-user flow.
- **Every spec times out on the first `page.goto` (~30s+ per navigation).**
  `next dev` is being throttled — almost always antivirus / endpoint-security
  software scanning the many files Turbopack touches per compile. Add the repo
  folder and the pnpm store to the AV exclusion list; route compiles drop from
  ~30s to ~200ms.
- **`ERR_CONNECTION_RESET` / 40s compiles partway through the run.** Too many
  Playwright workers cold-compiling routes against the single Next dev server
  at once. `playwright.config.ts` already pins local runs to one worker for
  this reason; don't raise `--workers` unless your machine is fast.
- **First-run timeouts.** Next 16 cold-compiles each route on first hit; the
  spec timeout is already 60s and the dev server gets 180s to boot. A second
  run is fast.
