# apps/loja-integrada

API-only App Hosting backend for the Loja Integrada marketplace channel, port 3010.
Master plan: `.master_plans/loja-integrada/loja-integrada-marketplace-integration.md`.

## What is here

- Step 1: the scaffold, `GET /api/health`.
- Step 2 (the credential store, in stacked PRs): `proxy.ts` (CORS for
  `/api/marketplace/*` only), `lib/auth/verifyCaller.ts`, `lib/firebase/admin.ts`,
  then the routes and `lib/lojaIntegrada/`. The inbound order webhook
  (`/api/webhooks/loja-integrada/…`, step 4) stays OUTSIDE the proxy matcher.
- The platform is called only through `@delfrance/integrations-loja-integrada`,
  never with a raw `fetch` here. No write to the platform before the cutover (D4).

## Routes (`/api/marketplace/loja-integrada/conta/[id]…`)

`GET` status (`PERM.integracao.read`); `PUT …/credencial` save, `PUT …/credencial/validade`
renew the expiry date, `DELETE …/credencial` remove (all `PERM.integracao.write`).
Every route exports its verb as `export async function GET|PUT|DELETE` (never a
re-export: `cors-proxy-covers-routes.test.js` cannot read one), and every verb must
be listed in the literal `Access-Control-Allow-Methods` in `proxy.ts`. The routes read
the conta uncached and require only `tipo === 3`, so a parked or inactive conta can
still be fixed. Only the context loader refuses those.

## Store and writes

- The token lives in `integracao/{id}/credenciaisLojaIntegrada/current`: strict schema,
  admin-only, outside `ALL_DOMAINS`, reclaimed by the conta delete's discovery walk.
- Read it with `credenciaisLojaIntegradaSchema.safeParse` (strict), never the handle's
  `parseRead`, which logs and returns the raw document on a mismatch.
- Panel writes carry the version the operator saw (`versaoEsperada`, the credential
  document's `updateTime` in µs). `create` when absent, otherwise `update(patch,
  { lastUpdateTime })`; a lost race is a 409, never a silent overwrite (root rule 7,
  tier 3). The save never mentions `webhookPedido`.
- The 401/403 park is a tier-1 precondition write: read, decide, `update(patch,
  { lastUpdateTime })`, re-read on `FAILED_PRECONDITION` (9) and on `NOT_FOUND` (5),
  at most 3 attempts. It compares a versioned ref derived from the stored
  `personalToken` (`fingerprint.tokenAtualizadoEmMs`), never the stored fingerprint field.
- ⚠️ **Never write the Firestore transaction API's call name in any file of this app**
  (source, test or fake). `firestore-transaction-inventory.test.js` greps every
  non-test source file for it and would demand a class for a site that does not exist.
  The test fake models `lastUpdateTime` preconditions only.

## Layout rules

- `lib/lojaIntegrada/**` is Next-free and takes `db` as a parameter, because step 3's
  functions bundle imports it. The one exception is `core/respond.ts`.
- `lib/lojaIntegrada/avisos/avisos.ts` is the ONLY module that converts to µs:
  `agoraUsDe`, `prazoUsDe` and the Timestamp-to-µs function. Everything else stays in ms.
  A document commit time is the aviso clock for the park. Any civil-date computation
  passes `FUSO_FISCAL` (`no-ambient-timezone`).
- Tests run the real `escreverAviso`/`resolverAviso` against `lib/lojaIntegrada/testing/fakeDb.ts`.
  Apps have no dependency edges, so Shopee's fake cannot be imported.

## Token hygiene

- The token appears in no response, log line, error message, URL or observer event.
  It travels only in the PUT JSON body. A malformed-JSON `SyntaxError` message quotes
  the body: return a fixed 400 and never log or return `err.message`.
- Zod failures return field paths only. The fingerprint is diagnostic and also stays
  out of responses and logs.
- The tokens belong to this integration alone, separate from the legacy app's (D16).

## Config

- `vitest.config.ts` excludes `*.firestore.test.ts` and `*.tasks.test.ts` (emulator
  suites run on their own lane, which lands in step 3); `eslint.config.mjs` still lints
  them. Both already cover the nested `functions/` codebase.
- The Firestore database id is `default`: `lib/firebase/admin.ts` passes it explicitly.
  `ALLOWED_ADMIN_ORIGINS` is REQUIRED in production (see `apphosting.yaml`).
- `next` is an exact literal in `package.json`, never `catalog:` or a range.
