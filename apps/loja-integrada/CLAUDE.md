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

- The wire contract (bodies, answers, error codes, the accepted date window
  `janelaDeValidadeTokenLi`) is `packages/schemas/src/contaLojaIntegrada.ts`, shared with
  the web panel. Never redefine a shape here.
- Each `PUT` makes exactly ONE `validarPersonalToken(` call (`prazos.test.ts` counts it
  and pins `PRAZO_LI_MS` under the App Hosting ceiling). Every refusal that needs no call
  (id, read switch, body, date, conta, version, wrong-store, token-inside-ref) comes
  before it.
- Only that call sits in the abort `try`, narrowed by identity: `err === req.signal.reason`
  → 499. A save re-reads the conta after writing and undoes the write on a 404.
- The aviso step runs after the write landed: a TRANSIENT gRPC failure there is logged and
  the answer stays 200 (`semDerrubarAEscrita` in `avisos/avisos.ts`); anything else throws.

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
  The test fake models `lastUpdateTime` preconditions only — and as the server applies
  them: the stamp replaces the SDK's `exists` check, so a removed document fails it with
  `FAILED_PRECONDITION` (9), not `NOT_FOUND` (5).

## Layout rules

- `lib/lojaIntegrada/**` is Next-free and takes `db` as a parameter, because step 3's
  functions bundle imports it. The one exception is `core/respond.ts`.
- `lib/lojaIntegrada/avisos/avisos.ts` is the ONLY module that converts to µs:
  `agoraUsDe`, `prazoUsDe` and the Timestamp-to-µs function. Everything else stays in ms.
  A document commit time is the aviso clock for the park. An observation of ABSENCE (no
  credential, a conta gone) is clocked by the snapshot's `readTime`: the reconexão aviso
  is never resolved clockless, or a park committed after the read loses its open row for
  good. Any civil-date computation passes `FUSO_FISCAL` (`no-ambient-timezone`).
- Tests run the real `escreverAviso`/`resolverAviso` against `lib/lojaIntegrada/testing/fakeDb.ts`.
  Apps have no dependency edges, so Shopee's fake cannot be imported.

## Token hygiene

- The token appears in no response, log line, error message, URL or observer event.
  It travels only in the PUT JSON body. A malformed-JSON `SyntaxError` message quotes
  the body: return a fixed 400 and never log or return `err.message`.
- Zod failures return field paths only. The fingerprint is diagnostic and also stays
  out of responses and logs.
- The tokens belong to this integration alone, separate from the legacy app's (D16).

## Logging and redaction (step 2b)

- ONE JSON line per Loja Integrada call, with a Cloud Logging `severity`, written by
  `core/log.ts` through `process.stdout.write` (never `console.*`, no new dependency).
- The observer is always `criarObservadorLi(…)`: the context loader builds it itself
  (callers pass only `registro`: flow, attempt, task/notification ids, a test sink; `conta`
  is always the context's id), and both credential routes pass it to the validating GET.
  Only `core/log.ts` names `ChamadaLi`, the raw event (raw query, full body). The
  `estrutura.test.ts` guards fail on any other observer, on that type named elsewhere, and
  on a logger import closure reaching `firebase-admin`, `@delfrance/data`, `next` or `@/`.
- The credential is labelled by `credencial: 'personal-token'` and `versaoCredencial` (the
  ref's version suffix, read through `core/refCredencial.ts`, the format's one owner) —
  never the ref, never the fingerprint.
- `core/redacao.ts` is pure and total (no clock, I/O, env or `catch`; imports only `zod`
  and `@delfrance/core/*`). Allow-lists fail closed: the path picks the policy
  (`estrutural` by default, `configuracao`, `catalogo`, `webhook` never excerpted), then
  spelled-out leaves with predicates. Profile `log`: `<redacted>` plus the regex layer,
  then a 2 KB cut (mask first, cut second). Profile `fixture` (fixtures are public): fakes
  of the same type, `chave_redigida_<n>` keys, error bodies keep shape and short digits.
- A new field or path stays redacted until a table lists it. Listing one means adding the
  leaf with its predicate AND regenerating the committed leaf inventory, which reads the
  gitignored spec cache only: `MSYS_NO_PATHCONV=1 node
  .master_plans/loja-integrada/evidence/li-doc.mjs folhas --saida
  apps/loja-integrada/lib/lojaIntegrada/testing/especificacaoFolhas.json` (no pairs: the
  file's own operations; pass `<METHOD> <path>…` pairs, all of them, to change the list).
  `redacao.test.ts` demands every inventory leaf be classified exactly once.
- The excerpt fails closed where the token may echo back: a 401/403 is never excerpted on
  any path, and neither is any answer to the validating GET (a candidate credential,
  `versaoCredencial: null`). The package scrubs only the exact token sent, so a partial or
  escaped echo would otherwise reach the log. Never relax either rule to "see the error".

## Captures and fixtures (step 2b)

- **Mock only (D17, Q1).** No code here calls Loja Integrada before the cutover: no probe,
  no token. Real responses are the owner's own read-only captures, converted offline by
  `scripts/sanitizar.ts` (`pnpm --filter @delfrance/loja-integrada-app sanitizar`; how to
  capture and run it: `scripts/README.md`). All its logic is in `lib/lojaIntegrada/sanitizacao/`.
- Captures live in `~/li-capturas`, OUTSIDE every checkout: the sanitizer refuses a folder
  with a `.git` entry in it or above it, and refuses to run without the owner's local
  `nomes-proibidos.txt` (store names; never in the repo, never printed).
- ⚠️ **Agents never open a raw capture** (no `cat`, editor or file tool): run the sanitizer
  and read only its output (`--dry-run` prints paths, types and treatments, never values)
  and the sanitized fixtures.
- Each fixture is a self-describing envelope in `lib/lojaIntegrada/fixtures/__wire__/` (no
  manifest), made by the `fixture` profile, then `piiScan.ts` (residue fixpoint + patterns +
  store names). An allow-listed value the profile had to fake (a SKU that is a valid CPF)
  is a finding too. **Refusal is total**: any finding in any pair writes nothing.
- A fixture is pushed only after Lucas has seen it (the repo is public), and only after
  `sanitizar --entrada … --verificar <files>` passes over the new fixtures, the changed docs
  and the PR-body draft. `wireCorpus.test.ts` re-scans the corpus in CI (no store list
  there); its floor is 0 until the first fixture PR raises it.
- `estrutura.test.ts` proves the sanitizer's import closure reaches no network or process
  module, no package client, no `firebase-admin`/`@delfrance/data`, no credential module,
  no `fetch(`, no run-time builtin (`getBuiltinModule`) and no global by computed name;
  its external imports are an allow-list, and the allow-listed `@delfrance/core/*`
  subpaths are walked too, not trusted.

## Valves and the read switch (step 2b)

- `core/valvulas.ts`: one valve per write flow, `LOJA_INTEGRADA_MODO_<FLUXO>` =
  `off | dry-run | on`. Only the EXACT `on` writes and the exact `dry-run` diffs; anything
  else (`ON`, ` on`, `true`, blank, unset) is `off`. Never trim or case-fold a value.
- Four canary lists, `LOJA_INTEGRADA_CANARIO_<FLUXO>` (none for the webhook registration,
  whose conta a person picks). Unset or blank = NO target; exactly `*` is the ONLY widening;
  anything else is `<contaId>:<n>,…` and a malformed entry is simply not listed (logged by
  position, never by text). Never make unset mean "every target".
- `lerValvula(fluxo, ambiente)` is THE first statement of a write flow and
  `registrarValvulaLi` the second. The environment is a PARAMETER: nothing under
  `lib/lojaIntegrada` names the process environment (`estrutura.test.ts`); the entry point
  (a route, a step-3 function) passes it. No write flow exists before step 7.
- The read switch `LOJA_INTEGRADA_CHAMADAS` (D17): only the exact `on` lets this code call
  Loja Integrada. Both credential `PUT`s check it right after the id, before the body is
  read: otherwise 503 `LI_CHAMADAS_DESLIGADAS` and one `chamada-bloqueada` line, with zero
  fetches. The `DELETE` makes no call and is not gated. Step 3's context loader checks it
  too. It stays unset everywhere (locally and in staging too) until the window sets it.
- The names live in the root `.env.example` (blank) and as comment rows in
  `apphosting.yaml`, never `env:` rows; `valvulas.test.ts` pins both.

## Config

- `vitest.config.ts` excludes `*.firestore.test.ts` and `*.tasks.test.ts`: emulator
  suites need their own lane — **none exists yet** (planned for step 3), so the change
  that adds the first such suite must add its lane too, or it runs nowhere while every
  check stays green. `eslint.config.mjs` still lints them. Both already cover the nested
  `functions/` codebase.
- The Firestore database id is `default`: `lib/firebase/admin.ts` passes it explicitly.
  `ALLOWED_ADMIN_ORIGINS` is REQUIRED in production (see `apphosting.yaml`).
- `next` is an exact literal in `package.json`, never `catalog:` or a range.
