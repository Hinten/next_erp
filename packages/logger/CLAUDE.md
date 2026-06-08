# packages/logger — CLAUDE.md

`@delfrance/logger` — the shared **server-side** structured logger (pino).

## Why it exists

Before this package, server code reached for `console.*`, which (a) is
unstructured and (b) can dump unredacted payloads. This package gives one
`createLogger(name)` that emits newline-delimited JSON with sensitive keys
censored and thrown values reduced to a leak-safe shape.

## Rules

1. **Server-only.** pino is Node-only — never import `@delfrance/logger` from
   client components (`apps/web`, `apps/webchat`) or from shared packages that
   get bundled into the browser (`@delfrance/data`, `@delfrance/ui`,
   `@delfrance/schemas`, `@delfrance/core`). It belongs in `apps/integrations`,
   `apps/nfe` (server), and future Cloud Functions.
2. **JSON to stdout, no transport.** The logger never configures a worker-thread
   transport (e.g. `pino-pretty`) — that keeps it bundler- and serverless-safe
   and lets Cloud Logging ingest the JSON directly. For pretty local output,
   pipe through `pino-pretty` yourself; don't wire it as a transport.
3. **Log objects, not interpolation.** Prefer `log.info({ pedidoId }, 'emitted')`
   over string concatenation — structured fields are queryable and get redacted.
4. **Errors go under `err`.** `log.error({ err }, 'message')` runs the value
   through the `err` serializer (`{ name, message, code }` only).

## Usage

```ts
import { createLogger } from '@delfrance/logger';

const log = createLogger('integrations/admin/users');

log.info({ uid }, 'user created');
log.error({ err }, 'verifyIdToken failed');
```

## Config

- `LOG_LEVEL` env overrides the level everywhere. Default: `silent` under
  `NODE_ENV=test`, `info` in production, `debug` otherwise.
- Redacted keys live in `src/redact.ts` (`SECRET_KEYS` / `REDACT_PATHS`).

## Relationship to the NF-e redactor (follow-up)

`apps/nfe/lib/nfe/log.ts` has a stricter, ESLint-enforced, test-pinned
recursive redactor for cert/XML material. This package deliberately does **not**
touch it. Unifying the two (promote the canonical key set here, have NF-e
delegate) is tracked as a separate issue.
