---
title: Local setup
description: Get the monorepo running on your machine.
---

## Prerequisites

- Node 20.10+
- pnpm 9+
- A Firebase project (your own — the maintainers' staging project is reserved for CI)

## Install

```bash
pnpm install
```

## Configure

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/integrations/.env.example apps/integrations/.env.local
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
