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
- Step 15 (label routing and the paid re-check): the second route family,
  `pedidos/[pedidoId]/…` (below).
- Step 7 (the status write-back, in stacked PRs): the write engine and its write context
  (`core/escrita.ts`, `core/contextoEscrita.ts`; "Write engine" below). No flow runs on it
  yet, and every write valve is off until the window.

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

## Routes (`/api/marketplace/loja-integrada/pedidos/[pedidoId]…`, step 15)

`PUT …/rota-etiqueta` (`PERM.frete.write`, the Melhor Envio buy's own permission: whoever can
buy a label can route one; pedido write is not needed) re-points a pedido that still names its
conta's Loja Integrada `int_frete` doc at the label target the conta's `mapa`, a stored override
or the operator's `escolha` resolves. The work is `lib/lojaIntegrada/pedidos/rotaEtiqueta.ts`.

- **No call to Loja Integrada, and none of its machinery.** No package client, no credential,
  no context loader, no pacer, no read switch: routing works while the switch is off (D17).
  `estrutura.test.ts` walks the route file's run-time import closure (the `@/` modules too,
  type-only imports set aside) and fails on any of them or on a `fetch` call; the route suite
  stubs `fetch` to throw and trips on the package, the context loader or the switch loading.
- **The decisions are shared.** The ref reader, the guards, the plan and the conclusion are
  `packages/schemas/src/mapaFreteLojaIntegrada.ts`'s, called in the order the web's read-only
  preview calls them, over RAW reads by id (at most four, never cached). Never a local copy.
  The wire contract (strict body, non-strict answer, codes) is
  `packages/schemas/src/rotaEtiquetaLojaIntegrada.ts` and `CODIGO_ERRO_LI`; every answer is
  built through it, so the target document (which may hold credentials) never rides along.
- **One tier-1 write per attempt** (root rule 7): `update({ freteInicial: B },
  { lastUpdateTime })` against the attempt's own pedido read. `B` is the RAW stored block with
  only the routing keys replaced (`integracaoFreteOuterRef`, `externalOptionId`, the escolha's
  `integracaoTargetOuterRef`, the retirada hand-off's `estado`), never re-parsed, so unmodelled
  keys and Timestamps survive with the same values (`rotaEtiqueta.firestore.test.ts`); only an
  integral double sibling changes wire type, re-encoded by the SDK as the equal integer. A 9 or 5
  re-reads and re-decides everything, at most 3 attempts, then 503 `LI_ROTA_EM_CONFLITO`. No
  transaction (the multi-document read-and-write API), so no transaction-inventory row.
- **Refusals are decisions** (200 `recusado`, with a motivo); the envelope carries only 400
  (id, then body), 401/403, 404 `LI_PEDIDO_NAO_ENCONTRADO` and 503. An already-routed pedido
  answers `ja-roteado` and writes nothing, whatever the escolha; its `rota` reports the stored
  fields through the shared readers (the override through the `int_frete` ref reader, an option
  that is not a string through the Melhor Envio service reader, a string option verbatim).
- The conflict error (`LiRotaEtiquetaEmConflitoError`) is a plain `Error` subclass, like the mapa
  registration's `LiMapaFreteEmConflitoError`, not a `LiAppError`: it is about a pedido, not a
  conta or its credential.
- A refusal or a conflict logs ONE line with ids only (the pedido, the motivo, the attempts),
  never an endereço, a name or a document. No ruleset, index or env change: the write goes
  through Admin, and every read is by id.

`GET …/pagamento` (`PERM.pedido.read`) is the paid re-check the web's dispatch gates call: the
order's CURRENT Loja Integrada situação, or the ERP's contested mirror when that cannot be read.
The work is `lib/lojaIntegrada/pedidos/conferenciaPagamento.ts`; the wire contract (answers,
verdicts, the live/mirror split) is `packages/schemas/src/conferenciaPagamentoLojaIntegrada.ts`.

- **ERP reads first, then ONE paced read, and only through the context.** The pedido by id, its
  conta and canonical `numero`, and the identity (the id must be the import's own digest,
  `idPedidoLi`) come before anything else: a duplicate, a devolução or a manual pedido answers
  `aplicavel: false` with no call and no switch line. Only then `loadLojaIntegradaContext`
  (the read switch is its first act; off ⇒ nothing reaches Loja Integrada) and ONE
  `buscarPedidoLi`, paced like any flow read (`prazos.test.ts` counts it and budgets pacer +
  `PRAZO_LI_MS.leitura` under the ceiling). Never a raw `fetch`, never a client built outside
  `core/contexto.ts` (`estrutura.test.ts`). The context's call and switch lines carry
  `fluxo: conferencia-pagamento`; the route's own line is prefixed
  `[loja-integrada/conferencia-pagamento]`.
- **The answer names this order:** the body's `numero`, and `freteInicial.externalId` against the
  live shipments' ids when both sides are readable (`inteiroPositivoCanonicoLi` on both sides),
  matched by MEMBERSHIP — the import never refreshes the stored id, so a second shipment listed
  ahead of ours is still our order — else 502 `LI_PEDIDO_DIVERGENTE`, a token of another store.
  ⚠️ An order whose only shipment the store re-created under a new id is divergent too, and
  nothing in the ERP releases it. The verdict is the codigo's alone (`veredictoDoCodigoLi`);
  nothing else from the order body (personal data) leaves the core.
- **The shared read-failure mapper** (`core/falhaDeLeituraLi.ts`), not `respond.ts`'s, which it
  reuses only for the app errors: `LiTimeoutError` before `LiNetworkError`, the `LiHttpError`
  subclasses before `LiHttpError`, never the `LiError` base; anything unlisted (a non-5xx refusal
  such as a 3xx or a 400, `LiConfigError`, gRPC, the park failing on its own) is the caller's to
  rethrow, here after the mirror. A 401 always parks the conta (`tratarFalhaDeAutenticacao`) and
  answers as the park found it. What a 404 means, whether a 403 parks and what a paging stop
  (`LiPaginacaoError`) means are each caller's (`PoliticaDeFalhaLi`), never a copy of the mapper:
  here a 403 parks like a 401, a 404 is 409 `LI_PEDIDO_AUSENTE_NA_LOJA` (imported orders do not
  vanish from the store, so it points at the credential), and there is no paging answer (the one
  read never pages, so a paging stop would be rethrown). `falhaDaLeituraLi` is the mapper under
  this route's choices. The mapper sees the conta, never the context's client: answering a
  failure never reads the store again (`prazos.test.ts` counts its reads at 0).
- **The mirror whenever the read gives no answer of its own** (the switch, the conta, its
  credential, a throttle, a timeout, an outage, or an error the mapper does not own): the pedido's
  `lojaIntegradaPedidoContestado` aviso, by the import's own key (`chaveDoAvisoDoPedidoLi`); open
  ⇒ 200 `contestado`, `fonte: 'erp'`, so a known hold blocks whatever kept the read from
  answering. Otherwise the coded error, or the unowned error rethrown unchanged (a 500). Never
  after a live answer — a live `pago` wins over an open aviso — and never after a "not
  authorised" one (404, another order). With the switch off, as everywhere until the window, the
  route answers the mirror or 503 `LI_CHAMADAS_DESLIGADAS`, with zero calls.
- The caller's abort is matched by identity (`err === req.signal.reason`) ⇒ 499. Every check of
  an imported pedido that ends without a live verdict (an envelope from the context or the read,
  or the mirror standing in) logs ONE warn line: pedido, conta, the caller's uid, the cause and
  what the mirror said. The id, caller, 404 and abort answers, `aplicavel: false` and a live
  verdict log nothing. No write of its own (only the park's), no ruleset, index or env change.

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
  `FAILED_PRECONDITION` (9), not `NOT_FOUND` (5). Its `batch()` (the order import's ONE
  commit of a pedido and its pagamentos) is all or nothing under the same rules, plus 6 for
  a `create` on an existing doc; the emulator suite `pedidos/importarPedido.firestore.test.ts`
  pins the server's answers.

## Layout rules

- `lib/lojaIntegrada/**` is Next-free and takes `db` as a parameter, because step 3's
  functions bundle imports it. The one exception is `core/respond.ts`.
- Two modules convert time units (`avisos.test.ts` counts the calls, the zone-carrying
  naive read included): `lib/lojaIntegrada/avisos/avisos.ts` (`agoraUsDe`, `prazoUsDe` and
  the Timestamp-to-µs function) and, for the order import, `lib/lojaIntegrada/pedidos/dataLi.ts`
  (`dataLiParaMicros` for LI's naive stamps, read in `FUSO_DATAS_LI` — America/Sao_Paulo, settled from
  the spec's webhook example (`-03:00` beside matching `Z` instants) and the captures'
  order times (`dataLi.ts` header) —, `microsArmazenadoLi` for a stored stamp in another writer's unit,
  `microsDeMillisLi` and `millisDeMicrosLi`). No other module converts: the conta and
  aviso code works in ms, the order import's mappers carry µs as the pedido and pagamento
  schemas do. ⚠️ Settle the LI zone BEFORE the first live import: the stored watermarks
  keep the zone they were converted in, so changing `FUSO_DATAS_LI` afterwards is a window
  step (shift or clear the stored LI `lastMarketplaceUpdate`/`lastProviderUpdate`), never
  an edit alone — moved east, every change within the zone difference of the last import
  is dropped as `obsoleto`. Only a westward move is safe without it (`dataLi.ts` header).
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
  numeric ids where the profile keeps them, `meta.total_count` (the kept numeros already
  show the store's scale) and `resposta.bytes` (step 11 sizes snapshots with it). ⚠️ An
  order detail's top-level `id` is FAKED (`0`) and so is every `itens.*.produto`
  (a placeholder, not even a URI): no capture test may key on either, and the produto
  reference form has no real capture yet.
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
  (a route, a step-3 function) passes it. The write engine's `iniciarEscritaLi` makes both
  the first two statements of every write run (below).
- The read switch `LOJA_INTEGRADA_CHAMADAS` (D17): only the exact `on` lets this code call
  Loja Integrada. Both credential `PUT`s check it right after the id, before the body is
  read: otherwise 503 `LI_CHAMADAS_DESLIGADAS` and one `chamada-bloqueada` line, with zero
  fetches. The `DELETE` makes no call and is not gated. The context loader checks it FIRST,
  before any Firestore read (`deps.ambiente` is required). It stays unset everywhere
  (locally and in staging too) until the window sets it.
- The names live in the root `.env.example` (blank) and as comment rows in
  `apphosting.yaml`, never `env:` rows; `valvulas.test.ts` pins both.

## Write engine (step 7)

- **One module sends a write: `core/escrita.ts`.** It owns PLAN step 7's ten write-engine
  requirements (its header maps each one); a flow decides WHAT to write, never how.
  `estrutura.test.ts` keys the chokepoint on full paths in non-test source: only
  `core/contextoEscrita.ts` builds the package's write client, only `core/escrita.ts` names a
  write operation or a write-client method (an alias, a method reference or a comment counts),
  the client's type is named in those two only, nothing names the package's request core
  (`executarLi`), and no source imports a package subpath or reaches the package's files by a
  relative path. Tests and `testing/**` are exempt — safe only because nothing in the app but a
  test imports `testing/` (checked app-wide, `functions/` and `app/` included). Never "just
  call" a write operation from a flow.
- **The valve first.** `iniciarEscritaLi(fluxo, ambiente, …)` = `lerValvula`, then the
  run-start line; `off` (unset, blank, a typo) is `desligado` and no motor can be built from
  it (`criarMotorEscritaLi` accepts only a start it opened, and takes it: one start, one motor,
  one run). The engine takes NO Firestore handle; a run whose target decision is not `on`
  (dry-run, outside the canary, no canary) logs one `diff` line per field and its result
  carries no write.
- **The write context, `core/contextoEscrita.ts`,** refuses in the read loader's order (switch
  FIRST, before any read; conta; inactive; credential) and reuses `contexto.ts`'s credential
  read. Its own file so no App Hosting route's closure reaches the write factory: both step-15
  routes are walked and refused it, with no exemption. Two clients, each with its own inline
  observer: the WRITE client's getter only re-reads the credential (the engine paces) and runs
  the check the engine armed for the write it is about to send; the read client (the
  situação history) waits one interval per request.
- **The credential pin.** The engine pins the ref its first deciding read used; from then on
  both getters refuse a different stored ref with ZERO requests (`LiCredencialTrocadaError`,
  transient). The ref carries the save's stamp, so even the same token saved again is
  refused. A park still throws `LiContaParadaError` first.
- **Every write has its own deciding read** (`lerBaseLi(motor, alvo, leitura)`, with the
  reader its kind's `LEITURA_PREVIA_LI` row names: two pacer intervals, the order detail, the
  pin, the restore line). A deciding read decides at most ONE write attempt, a write refuses a
  base its kind's reader did not read, and a read-back is another type, never a base. **No
  write follows one that landed or MAY have landed** in the same run: a write closes the run
  before it is sent (two started together send one), and only a failure that PROVES nothing
  landed reopens it — refused before sending, or answered 3xx/4xx other than 429. A 2xx (a 202
  too), a 5xx, a 429, a timeout, a cut connection or an unclassified error keeps it closed, and
  `escreverLi` throws a `TypeError`.
- **The restore line** (`evento: 'restauracao'`, INFO): the read's token-scrubbed text
  through `corpoDeRestauracaoLi` (`redacao.ts`: the estrutural keep-list walk, NO 2 KB cut;
  `null` for a catalogue, configuration or webhook path, a non-2xx, a non-JSON body, over 1 MiB
  or deeper than 256). Capped at 200 KB on the EXACT line (`linhaSerializadaLi`, UTF-8,
  newline excluded): over the cap or `null` ⇒ no line and NO write (`sem-restauracao`),
  never a truncated snapshot.
- **The serialiser.** A structured value reaches a line only through `serializarValorLi`
  (`log.ts`): JSON for a JSON value, a marker (`<ciclo>`, `<bigint>`, `<ausente>`, `<fundo>`
  past depth 32, `<nao-serializavel>`) otherwise, no getter ever called, no `catch`. The
  default sink writes `linhaSerializadaLi` + `\n`.
- **The pacer** (`RITMO_ESCRITA_LI_MS`, `ritmo.ts`): two intervals before a deciding read and
  before a read-back, one before the history read and a confirming read, NONE between a
  deciding read and its write. No write starts later than `PRAZO_ULTIMA_ESCRITA_MS` (260 s)
  after the task's dispatch began (`PrazoDeEscritaEsgotadoLiError`, nothing sent), checked
  before the write AND again inside the write client's credential re-read, after it — the
  package awaits that re-read outside its own deadline. Reads are never held to it.
- **Read-backs and the history read are contained** for the listed classes only
  (`CLASSES_CONTIDAS_LI`: the HTTP family, schema, network/timeout, paging, and the
  credential refusals incl. the pin): they come back `verificado: false` / `lida: false`
  with the error. `LiConfigError`, gRPC and anything else are rethrown; the `LiError` base
  is never tested. Both read only the target of the write that LANDED (the read-back also
  only its kind), with the pinned credential; the history read takes ONE page
  (`MAX_PAGINAS_HISTORICO_CONFERENCIA_LI`), so a longer history comes back unverified,
  never as a read that outlives the task. A confirming read needs a pinned credential. The
  PERMITTED throws after a landed write are listed in `escrita.ts`'s header, each safe only
  because every attempt re-derives from a fresh read.
- **`deepEqual` has ONE home:** `core/igualdadeJsonLi.ts`, a leaf that imports nothing (the
  sanitizer's closure admits it; `estrutura.test.ts` pins that it stays a leaf). It folds key
  order only. `fixtures/piiScan.ts` and the engine call it; a wider fold is named in its
  caller and gets its own inventory row.
- **The unit kill-switch.** `vitest.setup.ts` (the unit config's `setupFiles`) makes a
  `fetch` to any non-local host throw; `vitest.setup.test.ts` proves it, against `.invalid`
  hosts only (a real host there would be reached the day the switch broke), and refuses any
  other host named in its own source. Engine tests hand the write context a stub `fetch` and a
  recording sleep, and stub the global `fetch` to throw in a file-level `beforeEach`.

## Status write-back (step 7)

- **`rastreio/`** reflects a pedido's freight event (`postado`, `entregue`,
  `aguardandoRetirada`) onto its Loja Integrada order, through the engine only. Pure plan
  `planoRastreio.ts`; identity `identidadeRastreio.ts`; one run `processarRastreio.ts` (its
  header states the rule-7 class); the pipeline binding and the varredura
  `notificacaoEscrita.ts`; the producer `agendadorEscrita.ts`; the aviso `avisosRastreio.ts`.
  No trigger, no queue function here: the functions codebase wires them —
  `functions/src/onHistoricoFreteLojaIntegrada.ts` (CREATE of `pedidos/*/historicoFtIni/*`:
  the estado, then the valve, with zero reads and no line; ONE pedido read; the identity
  proof; ONE task named `rastreio-<evento>`), `filaEscrita.ts` (`filaEscritaLojaIntegrada`:
  `rastreio` and the in-queue `varredura`, queue AND instance concurrency 1, `maxInstances: 1`,
  a flat 300 s backoff), `varrerEscritas.ts` (`15,45 * * * *`: it only enqueues the
  varredura, named after its tick), `agendadorEscrita.ts` (the root, through the reads
  root's region and valve readers) and `depsEscrita.ts` (the one binding of a write run's
  deps; the handler stamps the dispatch start FIRST). The writes queue is the only place a
  write — or its sweep — may run.
- **Paid codigos only.** The first filter is step 15's `veredictoDoCodigoLi`; the matrix
  (`MATRIZ_RASTREIO_LI`) is typed over EVERY codigo, so a new one does not compile until its
  row is decided, and an unknown string is refused (`situacao-desconhecida`). `NUNCA_ESCREVER_LI`
  (1019 included) and `CODIGOS_LI_NAO_PAGO` are separate constants; the test pins
  7 + 6 + 3 = 16, pairwise disjoint. Every codigo comparison is exact. The code column follows
  the 11 column and is never written while LI shows 13 or 14; 14 is never regressed.
- **One write per run.** A posting with a sendable code writes the code ALONE (LI moves the
  order to `pedido_enviado` and e-mails by itself); the read-back CHECKS the move — not seen ⇒
  `parcial/efeito-pendente`, and only a run at least an hour later, from a fresh read, may write
  11 (WARNING `objeto-sem-efeito`): a run that may come sooner (`escritaRecentePossivel`, derived
  and never persisted — every Cloud Tasks attempt, and a `failed` row with `processedAt: 0`, which
  is how the deferred lane hands a row back) meets our unmoved code and ends `parcial` with no
  write. A refused code ⇒ `escrita-recusada`, then a SECOND deciding read decides 11.
  `entregue` writes 14 only, never the code; `aguardandoRetirada` 13 only. Every write is
  decided by its own fresh read; no write follows one that landed.
- **Identity first.** The pedido id must be the digest of `preimagemPedidoLi` (a duplicate, a
  devolução, another conta ⇒ nothing); a stored envio id LI does not list ⇒
  `pedido-divergente`, NOTHING written; no stored envio ⇒ `envio-divergente`, the situação as
  usual. Freshness: an event the pedido no longer describes ⇒ `superado` (one INFO line).
- **Not `on` defers, never acts.** Dry-run, outside the canary or no canary: a diff line, then
  every outcome but `ja-refletido` and `superado` DEFERS with the would-be motivo in its reason
  (no aviso, no write) — a deciding read refused for good included (one WARNING line; only `on`
  parks it); `off` defers with zero reads, and the varredura at `off` touches neither lane.
- **A write refused with 401/403** is confirmed by one paced read on the same pinned credential:
  refused ⇒ the conta parks; fine ⇒ `EscritaRecusadaLiError` (WARNING `recusada-retentativa`),
  the whole job retries, and only a `failed` row's LAST hot pass concludes (`escrita-recusada`,
  then 11 from the second read for a refused code); a confirming read that neither reads nor
  refuses the credential (404, 3xx/4xx, off its schema, 429, 5xx) concludes nothing and throws.
  `passagemFinal` is derived from the row in `fromDoc`, never persisted; the run raises
  `tentativas-esgotadas` itself on the parking pass of a returned `parcial`/`adiado` under `on`.
- **The history check** after every situação change we caused (the code's move included):
  anchored on the last row reaching the codigo the deciding read saw, an empty previous
  situação is inconclusive, an intermediate the matrix would write from is INFO; an
  overwritten codigo the matrix refuses ⇒ `situacao-sobrescrita` (critico over a never-write
  one). It also runs after a landed write whose effect the run did not see (a failed read-back,
  a 202) and after a code read back as another code (`deriva`, which the sobrescrita outranks):
  neither proves LI never moved. Our code read back at a THIRD codigo (the order moved during the
  run) is checked too, and there the verdict decides: a row of our move ⇒ seen
  (`efeito-observado`, `escrito`, or the sobrescrita it reveals); `sem-linha`, `inconclusivo` or
  an unreadable history ⇒ `parcial/efeito-pendente`. Only our code read back at the deciding
  codigo (no move yet) skips it. Never after the code onto an order the
  deciding read saw already at 11: with no anchor to judge from, a move in that gap overwritten
  by the code's own move is an accepted residual.
  The import and this check order rows through ONE leaf, `limparHistoricoLi`.
- **The aviso** `lojaIntegradaRastreioDivergente`: one row per pedido, clocked by the EVENT
  (`microsDeMillisLi`), raised ONCE per run at its end, only under `on` — the most serious
  motivo of the run wins (sobrescrita, then what the situação says, then a refused write, then
  the code-only motivos); a clean `on` run resolves it. `atencao`, except `critico` for a
  sobrescrita over a never-write codigo and for a write blocked at `cancelamento_solicitado`
  (1019, the buyer asked to cancel), both decided in `avisosRastreio.ts`; every other blocked or
  unpaid situação stays `atencao`. A per-pedido tipo of
  `TIPOS_AVISO_PEDIDO_LI`, so the orphan pass closes it.
- **Classifier.** The context's and the getter's refusals defer; a conta gone drops; a body off
  its schema, a `ZodError` and the package's refusal of an operation's input (`LiConfigError`
  `corpo`, `codigo-nao-permitido`, `caminho`, `rota-nao-permitida`) PARK under `on` with one
  ERROR line (a decision that is not `on` defers them);
  429, 5xx, network, the pin, the deadline, our own `LiConfigError`, gRPC THROW.
- **The store** `notificacoesEscritaLojaIntegrada` (bare schema, `(status, processedAt)`
  index, no re-drive index); doc id = the event digest, task id `rastreio-<evento>`; the
  producer treats an answered `functions/task-already-exists` as success.
- Tests: `testing/plataformaEscritaLi.ts` is a stateful LI (one order, its history, both
  write routes); the global `fetch` is stubbed to throw in every suite.

## Notification pipeline (step 3)

- `notificacoes/notificacao.ts` binds the shared failures-only core to
  `notificacoesLojaIntegrada` (bare schema, ids only, unknown keys stripped). ONE reads
  queue, `filaLeituraLojaIntegrada` (= the function name), dispatching on `tipo`.
- A run: the context (switch, conta, credential), then the importer SEAM
  (`DESTINO_TIPO_LI`, filled in step 5 with `importarPedidoLi`; an empty one ⇒
  `importador-ausente` PARKS). Only the functions roots read `importadorPedidoLi()`; `lib`
  takes `deps.importador`.
- Classifier: the app refusals (switch off, inactive, token missing/corrupt, parked)
  DEFER; conta gone DROPS; `LiAuthError` parks the conta (`tratarFalhaDeAutenticacao`) and
  defers, or rethrows when the 401 was for an older token; 404 parks; a non-transient
  HTTP/schema/paging/Zod refusal parks (class and status only); 429, 5xx, network,
  `LiConfigError`, gRPC and the unknown THROW. Never test the `LiError` base. The importer's
  `LiPedidoPagoSemEnderecoError` (a paid order carrying NO CEP at all, step 5; an invalid
  CEP imports without an endereço instead) is `null` too:
  retried, never parked by the table. `criarPipelineLi` binds the shared `onRetriesExhausted`
  (a failure the RUN threw, parked at the cap) to `sinalizarEsgotamentoLi`: that error's ERROR
  line plus the critico aviso, any other class one generic ERROR line (ids and the class only).
  A row that fails to rehydrate (the strict `fromDoc`) parks with neither: only its doc id in
  the sweep's per-doc failures WARNING.
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
- Two gates, each with ZERO reads: the importer seam (filled in step 5, so a tick passes
  it), then the read switch (unset until the window, so every tick stops there). Contas
  run one after another, the list ROTATED by the tick's 5-minute slot (`ordemDoTickLi`),
  so a `sem-tempo` conta runs first on a later tick instead of starving behind the same
  ones forever. Containment per conta is a gRPC error, or a
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
- The conta trigger `functions/src/onIntegracaoLojaIntegradaChanged.ts` (the codebase's first
  Firestore trigger) runs that binding: `deveReconciliar(before, after)` as a zero-read cost
  filter, then `reconciliarIntFreteDaConta(getDb(), id)` — rule 7 class A inside the core, no
  event clock. One arm only; logs the id and the action with field names, never `nome` or a
  value. `database` is the named `default` (`build.mjs` defines the id; `index.test.ts` pins
  it), `retry: true`, no `region:`, no secrets, no Loja Integrada call.
  `onIntegracaoLojaIntegradaChanged.test.ts` pins every absence offline (mocking only the
  reconcile); `onIntegracaoLojaIntegradaChanged.tasks.test.ts` is its emulator positive
  (create, rename, delete ⇒ `ativo: false`, adopt a migrated auto-id doc).
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

## Order import (steps 5–6)

- `pedidos/importarPedido.ts` fills the step-3 seam: the queue and both sweeps run it, the
  poller passes its importer gate. The context refuses first while the read switch is
  off, so a run DEFERS before any read and reaches no import path, A4 included (D17).
  Every rule lives in the pure mappers beside it.
- The freight route and the pedido id are SHARED, never copied: `pedidos/freteMapeamento.ts`
  decides the `mapa` row and the target through `@delfrance/schemas`'s
  `decidirLinhaDoMapaLi` and `avaliarAlvoDoMapaLi` under `POLITICA_ALVO_IMPORTACAO_LI` (the
  pickup by `alvoDispensaEnderecoLi`), the functions the label route decides by;
  `pedidos/orderIdsLi.ts` hashes `preimagemPedidoLi`, the string the web's identity check
  hashes too.
- One run: the detail, the situação history (strict on queue attempts 0–1), the pedido
  snapshot, the hub guard, produtos, freight (its `mapa` row and the
  `lojaIntegradaFreteNaoSuportado` sync run HERE, on every attempt that routed), cliente
  and endereço, then ONE atomic `WriteBatch` (the pedido and every pagamento, each under
  its own precondition; a lost one re-derives all, 3 attempts, then a retry).
- A4: a PAID order with a shipment, NO CEP at all (no delivery block, or a `cep` absent,
  `null`, `''`, blank or `-`) and no stored endereço throws `LiPedidoPagoSemEnderecoError`
  before step 7; a pickup is exempt. It retries; the park at the cap logs an ERROR line
  (ids only) and raises the `critico` `lojaIntegradaPedidoPagoSemEndereco`, which an
  import resolves only once the winning snapshot leaves the pedido with a delivery
  endereço or a pickup route, or the order is no longer paid — nothing else. A present
  but INVALID CEP (a masked one too) is never refused: it imports with no endereço or
  route and keeps the aviso open, as do a readable CEP from a buyer with no valid
  document (no cliente, so no endereço) and an observation with no shipment.
- The buyer is the fiscal identity (a valid CNPJ, else CPF). Never a cliente beside
  another cliente's endereço: each stored endereço must be the pedido's cliente's, judged
  per attempt, else nothing is filled over it and an incidente. No endereço (pickup
  aside) ⇒ no carrier route; a stored route is never cleared.
- Every importer outcome RESOLVES; `obsoleto` (a newer stored stamp) writes NOTHING;
  schema and Zod refusals park. Estado and payment status come from the situação codigo
  through one shared table; a stored stamp is read through `coerceToMicros`.
- Six aviso tipos (`avisosPedidoLi.ts`): situação desconhecida, contestado, hub, frete não
  suportado, pago sem endereço and A7's `lojaIntegradaReversaoComEtiqueta` (a reversal on
  a pedido with a bought label). Order avisos and incidentes run after the batch, on
  `importado` and `sem-mudanca`, so a retry after a crash still writes them.
- A re-import keeps the `externalOptionData` keys Loja Integrada does not own (`agency`).
- `pedidos/importarPedido.firestore.test.ts` (emulator, CI below) pins the batch.

## CI (steps 3, 5, 7 and 20)

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
  `FIREBASE_DATABASE_ID=default`, `REQUIRE_EMULATOR=1`, `LOJA_INTEGRADA_CHAMADAS=off`,
  `LOJA_INTEGRADA_MODO_RASTREIO=dry-run`.
  A region mismatch is the silent drop of #1108: the poll times out instead of failing.
  On Windows the Firestore JVM can outlive `emulators:exec` and keep 8085: stop it after.
- D17 holds in the lane through TWO layers. The job env sets `LOJA_INTEGRADA_CHAMADAS: 'off'`
  (the functions emulator inherits it; the setup's fetch kill-switch reaches only the vitest
  process), and `vitest.tasks.setup.ts` refuses to start when the shell has it `on` or an
  artifact `.env*` file (selected by an anchored name, never a prefix) names it. A
  DISPATCHED function must stop at the switch: this lane never turns it on in the
  environment. Only code running in the vitest process may pass a context, and only with
  `ambiente` `on` as a PARAMETER and a scripted `deps.fetch` (`pedidos/pollPedidos.tasks.test.ts`).
- Since step 7 the job env also sets `LOJA_INTEGRADA_MODO_RASTREIO: 'dry-run'`, so the
  history trigger enqueues and the writes queue runs (`functions/src/filaEscrita.tasks.test.ts`:
  a history row ⇒ the trigger ⇒ a named task ⇒ a `deferred` row `adiado/chamadas-desligadas`;
  and a `varredura` task migrating a seeded `failed` row). Safe because the switch is off: a
  write run stops at its write context before any client exists. The setup also refuses any
  `LOJA_INTEGRADA_MODO_*` exactly `on` and any non-blank `LOJA_INTEGRADA_CANARIO_*`, in the shell
  and in the artifact's env files; the refusals are pure functions in
  `lib/lojaIntegrada/testing/guardaDaLaneDeTarefas.ts`, proved offline by its unit test.
- The history trigger fires on EVERY suite's `pedidos/*/historicoFtIni/*` creates (only
  `filaEscrita.tasks.test.ts` writes them): a suite that adds one awaits the row its event
  ends in, and uses pedidos and contas no other suite seeds.
- A new `*.tasks.test.ts` / `*.firestore.test.ts` joins the same job and check name. Its
  `beforeEach` wipes what it reads (one shared emulator, files run serially), and a drop
  is proved by a LATER sentinel row, never by polling for an absence.
- The conta trigger fires on EVERY suite's `integracao` writes (the functions emulator loads
  the whole codebase). So a suite that writes `integracao` docs uses conta ids no other suite
  seeds, and a suite whose writes fire the trigger awaits the trigger's last write before it
  ends. The step-3 suites seed contas with no filial and no `dataCadastro`, which the core
  plans as `incompleto` (reads only). Why one job anyway: `vitest.tasks.config.ts`.
- The lane cannot prove: Cloud Scheduler firing (`onSchedule` is ignored),
  `scheduleDelaySeconds` (firebase-tools#8254), index declarations, rules, that the
  emulator honours `maxConcurrentDispatches` or the instance limits, named-task dedup
  (the emulator accepts a named enqueue; a duplicate's answer is not asserted), Eventarc
  ordering or redelivery, or a trigger's `database` binding (pinned offline in
  `functions/src/index.test.ts`).

## Config

- The Firestore database id is `default`: `lib/firebase/admin.ts` passes it explicitly.
  `ALLOWED_ADMIN_ORIGINS` is REQUIRED in production (see `apphosting.yaml`).
- `next` is an exact literal in `package.json`, never `catalog:` or a range.
