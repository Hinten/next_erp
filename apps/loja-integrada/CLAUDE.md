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
  of the same type, `chave_redigida_<n>` keys, error bodies take the log's error walk.
- A JSON error body keeps its STRUCTURE and guesses no value shape (`percorrerErro`, both
  profiles): booleans and `null`; a number only as a safe integer below 1e7; a string only
  as 1–7 digits under `CHAVES_TEXTO_ERRO_LI` (`codigo`, `code`, `erro`, `error`, `tipo`,
  `campo`; exact, any case; an array inherits its key) — `Unauthorized`, `SLUG_IN_USE` and
  every other word are `<redacted>`; a key name only as 1–32 letters/`_`, any other key
  becoming `chave_redigida_<n>` by position. Three review rounds on #1877 each broke a shape
  rule (a token as a KEY, a first name or a domain under `erro`, a fraction under any key).
  On `catalogo`/`configuracao` a JSON object or array error takes that walk; only TEXT
  (non-JSON, or a JSON scalar like the spec's 409) keeps its masked text, for a plain/HTML
  429 or a validation message. Never add a key or a shape to "see the message".
- ⚠️ The accepted residual surface: (a) a key name of letters/`_` survives an error body
  and could itself echo a word; (b) on `catalogo`/`configuracao`, non-JSON error text and a
  bare JSON-scalar error (the 409 `"Slug already in use."`) keep their regex-masked text,
  which may hold a name or a partial token. Nothing else of a JSON error body survives but
  its structure, booleans, `null`, an empty string under a denied key, safe integers below
  1e7 and 1–7 digit strings under the allowed keys. The price: error names and messages
  never reach the log — `codigoLimite`/`retryAfterS` are logged separately. Widening the
  keys, the string rule, the key grammar or the text classes reopens the leak.
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
  there); its floor `MINIMO_DE_FIXTURES` is the committed count (18), so a fixture that
  disappears fails it.
- ⚠️ The owner's raw `pedido-enviado` pair duplicates `pedido-boleto` (the same order,
  identical sanitized bytes) and is EXCLUDED from the corpus. It stays in `~/li-capturas`
  until he deletes it, so a sanitizer run without `--so` writes it back: delete that raw
  pair first, or regenerate with `--so` naming only the pairs wanted. The shipped state is
  covered without it: `pedido-pix` and `pedido-cartao` (`situacao.codigo`
  `pedido_enviado`, a tracking code under `envios`) and `historico-pedido-enviado`.
- Kept on review of the first corpus (2026-10-14), not leaks: a 14-digit window INSIDE a
  longer SKU that passes the CNPJ check (the scan tests whole values; any one window passes
  by chance about 1% of the time, and the sibling variant's window fails), LI's own
  numeric ids (the importer's join keys), `meta.total_count` (the kept numeros already
  show the store's scale) and `resposta.bytes` (step 11 sizes snapshots with it).
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
  fetches. The `DELETE` makes no call and is not gated. The context loader checks it FIRST,
  before any Firestore read (`deps.ambiente` is required). It stays unset everywhere
  (locally and in staging too) until the window sets it.
- The names live in the root `.env.example` (blank) and as comment rows in
  `apphosting.yaml`, never `env:` rows; `valvulas.test.ts` pins both.

## Notification pipeline (step 3)

- `notificacoes/notificacao.ts` binds the shared failures-only core to
  `notificacoesLojaIntegrada` (bare schema, ids only, unknown keys stripped). ONE reads
  queue, `filaLeituraLojaIntegrada` (= the function name), dispatching on `tipo`.
- A run: the context (switch, conta, credential), then the importer SEAM
  (`DESTINO_TIPO_LI`, empty until step 5 ⇒ `importador-ausente` PARKS). Only the functions
  roots read `importadorPedidoLi()`; `lib` takes `deps.importador`.
- Classifier: the app refusals (switch off, inactive, token missing/corrupt, parked)
  DEFER; conta gone DROPS; `LiAuthError` parks the conta (`tratarFalhaDeAutenticacao`) and
  defers, or rethrows when the 401 was for an older token; 404 parks; a non-transient
  HTTP/schema/paging/Zod refusal parks (class and status only); 429, 5xx, network,
  `LiConfigError`, gRPC and the unknown THROW. Never test the `LiError` base.
- A parked conta DEFERS, never drops (#808): daily re-drive for 7 days,
  `graduateDeferredTransientErrors`, and on a token save or renewal the routes' best-effort
  `redriveAposSalvarTokenLi` (`(status, contaId)` index; a gRPC failure is logged, the 200
  stays). Accepted residue (Q4): a re-drive between the deferred sweep's read and its mark
  is overwritten — one more day, or parked on the 7th pass. It moves only rows already
  `deferred`, so a task's create or a hot-sweep migration that found the park before it and
  writes after it waits up to one more day (`tentativas` 0). Reverse: the re-drive's write
  has no precondition, so a park landing between its query and its write is reset to
  `failed`/0/0 — one extra attempt, then a re-park or an import. Its writes go 20 at a
  time (`CONCORRENCIA_REDRIVE_LI`): the routes await it inside the ceiling `prazos.test.ts`
  budgets.
- The pacer (`core/ritmo.ts`): 2 000 ms before EVERY call through a context, in the getter,
  outside the request deadline.
- Doc id `<conta>:<numero>:<origem>:<stamp digits | ->`, built from schema-validated parts
  (no doc-id guard); the stamp is in it, so a parked row never swallows a later change.
- Never write `onTaskDispatched(` in `lib/`: triggers live in `functions/`.
- The producer `notificacoes/agendador.ts` is pure (the queue is a parameter): exactly
  `LOJA_INTEGRADA_TASKS_DISABLED=1` → `LiTarefasDesligadasError`; a transient Cloud Tasks
  failure (REST, STRING codes; `functions/*` only WITH an `httpResponse`) →
  `LiTarefasTransitoriasError`; anything else rethrown untouched. The payload goes ALONE (no
  task id, no `uri`). Each root reads the env and binds the queue (`functions/src/agendador.ts`;
  App Hosting from step 4). Fake failures with `testing/falhaDeEnfileiramento.ts`.
- The functions roots bind every read run's deps in ONE place, `functions/src/depsLeitura.ts`
  (env whole, the importer from the seam table per run). `index.ts` exports only triggers:
  any other runtime export there reads as a Cloud Function name.

## Order poller (step 3)

- `pedidos/pollPedidos.ts` runs one tick and one conta's run; `dataLi.ts`, `janelaPoll.ts`
  and `orcamentoPoll.ts` are its pure date, window and budget layer. The root
  `functions/src/pollPedidos.ts` (`pollLojaIntegradaPedidos`, `*/5`, 300 s) binds every
  dependency: `importadorPresente = importadorPedidoLi() !== null`, the parsed look-back.
- Two gates, each with ZERO reads: the empty importer seam (until step 5), then the read
  switch. Contas run one after another, the list ROTATED by the tick's 5-minute slot
  (`ordemDoTickLi`), so a `sem-tempo` conta runs first on a later tick instead of
  starving behind the same ones forever. Containment per conta is a gRPC error, or a
  hand-edited poll document that no longer parses (`documento-invalido`, a WARNING,
  nothing written), ONLY.
- `pollPedidosLojaIntegrada/{id}` is written only under preconditions: the lease
  (`create`, or `update` once expired), the refusal record (never while the lease is held,
  never a cursor), and the final write on the lease's `writeTime`, re-derived from ONE
  re-read when it loses. The cursor is the platform's naive text; arithmetic is zone-free.
  `pedidos/pollPedidos.firestore.test.ts` proves the fake's precondition model on the
  emulator (two lease takers → one wins; a deleted document fails the stamp with 9).
- The aviso `lojaIntegradaImportacaoParada` is clocked by the run's FIRST write to that
  document, and resolved only when the stored `falhasSeguidas` was above 0. So it is
  RAISED only after the write that stored its count landed (an open aviso always has a
  count above 0 behind it), and a retried final write resets a count only while it is
  still the one the lease read. The re-bootstrap runbook DELETES the `cursor` field and
  never the document (`functions/DEPLOY.md`): a fresh document would never resolve an
  open aviso.
- A conta parked mid-drain keeps its stored `vistos` (the run's additions are dropped, so
  they are re-enqueued once the token is back).
- The row schema was written from the public document's two examples and is now
  CONFIRMED by the owner's C1 captures (`__wire__/pedido-search-*`): every row passes it,
  `data_modificacao` arrives already canonical, the filtered search lists nothing below
  its bound (so `filtroIgnoradoLi` stays false), and the `%3A` capture is byte for byte
  the query the poller sends. Pinned by `pedidos/capturasBusca.test.ts`. ⚠️ The rows come
  ordered by `numero`, NOT by `data_modificacao`; the poller deliberately assumes no
  order (the cursor is the max stamp over the whole drain).

## Freight doc and mapa (step 20)

- `frete/intFrete.ts` is the app's ONE binding of the shared `int_frete` core
  (`syncIntFreteLi`, zero options). Never a second binding or a hand-written lookup.
- `frete/mapaFrete.ts` (`registrarFormaEnvioNoMapaLi`) appends one unmapped `mapa` row per
  new shipping method. Tier 1: a RAW read through the admin handle, never cached (it feeds a
  write); presence on the FULL `'<id>---<code>'` key from `@delfrance/schemas`, never the id
  part or a local copy; then `update({ mapa: deps.arrayUnion(row) }, { lastUpdateTime })`. A 9
  or 5 re-reads and re-decides, at most 3 attempts, then `LiMapaFreteEmConflitoError` (the
  classifier returns `null`: the task retries).
- It writes `mapa` only (never `ultimaModificacao`), never parses or rewrites stored rows (a
  `ZodError` would park the task), never merge-`set`s (that would resurrect a removed doc), and
  logs ids only. `deps.arrayUnion` is `FieldValue.arrayUnion` in production, the fake's
  sentinel in tests.

## CI (step 3)

- Two homes, disjoint by filename suffix. `vitest.config.ts` (`pnpm test`, in `CI test`
  of `ci.yml`, unfiltered) EXCLUDES `*.firestore.test.ts` and `*.tasks.test.ts`;
  `vitest.tasks.config.ts` (`pnpm test:tasks`) includes exactly those two. A file matching
  neither glob runs in NO job. Both configs cover the nested `functions/` codebase, and
  `eslint.config.mjs` lints the emulator suites (raw refs allowed in those two suffixes).
- The emulator suites run only in `.github/workflows/ci-loja-integrada.yml`: ONE job,
  `Loja Integrada Cloud Tasks round trip`, behind the pinnable `CI gate (loja-integrada)`.
  No `ci.yml` exclusion, so a skipped lane loses only the round trip. Editing the workflow
  → the `ci-lanes` skill.
- The job: `prepare-deploy.mjs`, then `firebase emulators:exec --config
  firebase.loja-integrada.tasks.json --only firestore,functions,tasks` (ports 8085/5004/9501;
  that file sits ONE DOT from `firebase.loja-integrada.deploy.json`, the only one that
  deploys), then `pnpm test:tasks`. Run it locally the same way (JDK 21) with
  `FUNCTIONS_REGION` = `LOJA_INTEGRADA_TASKS_REGION`, `FIREBASE_PROJECT_ID=demo-erp`,
  `FIREBASE_DATABASE_ID=default`, `REQUIRE_EMULATOR=1`, `LOJA_INTEGRADA_CHAMADAS=off`.
  A region mismatch is the silent drop of #1108: the poll times out instead of failing.
  On Windows the Firestore JVM can outlive `emulators:exec` and keep 8085: stop it after.
- D17 holds in the lane through TWO layers. The job env sets `LOJA_INTEGRADA_CHAMADAS: 'off'`
  (the functions emulator inherits it; the setup's fetch kill-switch reaches only the vitest
  process), and `vitest.tasks.setup.ts` refuses to start when the shell has it `on` or an
  artifact `.env*` file (selected by an anchored name, never a prefix) names it. A
  DISPATCHED function must stop at the switch: this lane never turns it on in the
  environment. Only code running in the vitest process may pass a context, and only with
  `ambiente` `on` as a PARAMETER and a scripted `deps.fetch` (`pedidos/pollPedidos.tasks.test.ts`).
- A new `*.tasks.test.ts` / `*.firestore.test.ts` joins the same job and check name. Its
  `beforeEach` wipes what it reads (one shared emulator, files run serially), and a drop
  is proved by a LATER sentinel row, never by polling for an absence.
- The lane cannot prove: Cloud Scheduler firing (`onSchedule` is ignored),
  `scheduleDelaySeconds` (firebase-tools#8254), index declarations, rules, or that the
  emulator honours `maxConcurrentDispatches`.

## Config

- The Firestore database id is `default`: `lib/firebase/admin.ts` passes it explicitly.
  `ALLOWED_ADMIN_ORIGINS` is REQUIRED in production (see `apphosting.yaml`).
- `next` is an exact literal in `package.json`, never `catalog:` or a range.
