# Changesets

This folder holds [changesets](https://github.com/changesets/changesets) — files that describe version-and-release intent for the publishable packages in this monorepo.

## When to add a changeset

Whenever a PR changes a publishable package (`packages/schemas`, `packages/data`, `packages/auth`, `packages/core`, `packages/ui`, `packages/plugin-sdk`, anything under `packages/integrations/*`), run:

```bash
pnpm changeset
```

Pick the affected packages, choose the bump type (`patch`/`minor`/`major`), and write a short summary. The CLI writes a `<random-name>.md` file here. Commit it as part of the PR.

## Ignored packages

Apps (`apps/web`, `apps/integrations`, `apps/webchat`, `apps/docs`, `apps/example`), tooling (`tools/test-fixtures`), and shared configs (`packages/config-*`) are listed in `config.json` under `ignore` — they are private and never published to npm.

## Releasing

The `release.yml` workflow (in `ci-templates/` until the public-repo split, then in `.github/workflows/`) opens a "Version Packages" PR collecting pending changesets. Merging that PR runs `pnpm changeset publish` and pushes git tags + npm releases.
