---
title: Local setup
description: Get the monorepo running on your machine.
---

## Prerequisites

- Node 22+
- pnpm 9+
- A Firebase project (your own — the maintainers' staging project is reserved for CI)

## Install

```bash
pnpm install
```

## Configure

There is a **single** env file, at the repo root — `apps/web`'s
`dev`/`build`/`start` scripts load it via `dotenv-cli`. It is built from two
committed templates: `.env.example` holds non-secret configuration and
`.env.secrets.example` holds credential material (OAuth client secrets, HMAC keys,
the service account, the A1 certificate password). Concatenate them by hand —
nothing automated may read either one.

```bash
cat .env.example .env.secrets.example > .env.local
# Fill in NEXT_PUBLIC_FIREBASE_* and FIREBASE_PROJECT_ID values from your project.
```

## Run

```bash
pnpm dev
# apps/web         http://localhost:3000
# apps/integrations http://localhost:3001
# apps/webchat     http://localhost:3002
# apps/docs        http://localhost:3003
```

## Verify

```bash
curl http://localhost:3001/api/health
# {"status":"ok","service":"integrations","timestamp":"..."}
```

## Next steps

To run the unit and e2e suites locally, see [Running tests](/getting-started/running-tests/).
