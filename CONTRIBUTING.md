# Contributing

Thanks for considering a contribution. This monorepo is in active development; expect rough edges.

## Development setup

Prerequisites:

- Node 22+
- pnpm — run `corepack enable` once and the right version is fetched for you.
  It is pinned by `packageManager` in `package.json` (the single source of
  truth), so there is no need to install pnpm globally.
- A Firebase project for testing (your own; the maintainers' staging project is reserved for CI)

```bash
pnpm install
cp .env.example .env.local       # single env file at the repo root — fill in your Firebase config
pnpm dev
```

`apps/web`'s `dev`/`build`/`start` scripts load this root `.env.local` via
`dotenv-cli`; there is no per-app `.env` file.

## Workflow

1. Open an issue describing the change before large work.
2. Branch off `main`. Use `feat/`, `fix/`, `refactor/`, `docs/` prefixes.
3. Run `pnpm turbo run lint typecheck test` before pushing.
4. Follow Conventional Commits (`feat:`, `fix:`, `refactor:`, `feat(integrations):`, …).
5. PRs require all CI checks green and one maintainer review.

## Code style

- TypeScript strict — no `any`, no `as` casts without comment, no `// @ts-ignore`.
- React 19. **`apps/web` is client-first** (per ADR-0002): default to `'use client'`. Server Components, Server Actions, route handlers, and middleware are exceptions that need PR justification.
- Forms: react-hook-form + Zod via `@hookform/resolvers/zod`.
- Validation at boundaries: route handlers in `apps/integrations` `safeParse` Zod schemas.
- Mantine via `Controller` for form inputs.
- No barrel re-exports across package boundaries (slows tree-shaking).

## Testing

- Unit/component: Vitest + React Testing Library.
- Integration / e2e: Playwright against your Firebase project (or the maintainers' staging project for CI).
- No Firebase emulators — they are unstable for our use case. Use a real project.

Commands:

```bash
pnpm turbo run test                     # unit/component (Vitest) — no env needed
pnpm turbo run lint typecheck build     # no env needed
pnpm --filter @delfrance/web test:e2e   # Playwright e2e
```

Unit tests, lint, typecheck and build run with nothing but `pnpm install`.
The e2e suite additionally needs the Firebase env vars in the root
`.env.local`, a service-account key, and the Playwright browser installed
(`pnpm --filter @delfrance/web exec playwright install chromium`). See the
[Running tests](apps/docs/src/content/docs/getting-started/running-tests.md)
guide for the full walkthrough.

## Adding a plugin

See `apps/docs/src/content/docs/guides/plugin-authoring.md` (once published). High level:

1. `pnpm create delfrance-plugin <name>` (after Phase 6).
2. Implement the relevant contract from `@delfrance/plugin-sdk`.
3. Register in your app's `delfrance.config.ts`.

## Reporting security issues

Do **not** open a public issue. See `SECURITY.md`.
