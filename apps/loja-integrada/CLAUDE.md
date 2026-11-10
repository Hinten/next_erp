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
- Step 10 (the catalogue reads): four `GET`s in the conta route family (below), the core
  `lib/lojaIntegrada/catalogo/catalogo.ts` and its caches `catalogo/cache.ts`. The web's
  variation linker reads the grades; categories and brands wait for step 11's product tab.
- Step 9 (the product import, in stacked PRs). PR 9-v, the anchor: the Firestore trigger
  `functions/src/onProdutoLojaIntegradaLinkChanged.ts` on
  `produtos/{produtoId}/produtolojaintegrada/{linkId}` keeps `produtos.integracoesComProduto`
  (the stock and price sweeps' pre-filter) in step with the link docs, through the app's ONE
  binding of the shared core, `lib/lojaIntegrada/produtos/integracoesComProdutoLi.ts`: the conta
  from `contaLojaIntegrada` (`contaIdFromRef`, both stored forms), the counts predicate
  `vinculoLiConta` (a store product id, not in the trash; hidden and blocked links count), an
  UNFILTERED read of the produto's own links as the survivor reader (no index; the filter is the
  plan's own two readers, in code). The decision comes from the event payload before `getDb()`,
  so an edit that moves no membership costs zero reads (the test hands out a handle that throws).
  Add tier 0 (`arrayUnion`), remove tier 1 inside the core's inventoried site: no transaction
  call here, no inventory row. ⚠️ The add reads nothing, so one handled after its link's close
  (Eventarc gives no order; a retried create can land late) leaves a conta listed with no
  counting link, and nothing here removes it — accepted as the over-inclusive direction (one
  skipped sweep row); the trigger's docblock says what closing it would cost. One trigger
  serves parents and children (a child's link sits under the ERP child). `database`
  `default`, `retry: true`, no secrets, no Loja Integrada call.
  PR 9-c, the import: the job routes `conta/[id]/importacoes…` (below),
  `lib/lojaIntegrada/importacao/` — the start core, the job lifecycle, the dispatch's time budget,
  its named-task producer, the read phases (catalogue, listing and trash list, detail reads, family
  assembly), the match cascade, the evidence pass, the option learning, one family's plan, link
  writes and report item, the import's avisos, and ONE dispatch (`despacho.ts`, the phase machine)
  — and in the functions codebase the job-creation trigger and the reads queue's `importacao`
  route. PR 9-d, "complete": category create-and-link, the whole-family create and the
  add-child path, the fill of empty fields, the photos (the codebase's first Storage write,
  `functions/src/lib/admin.ts`'s `getBucket()`) and the durable tax-review list with its
  `revisao` phase ("The product import" below).

## Routes (`/api/marketplace/loja-integrada/conta/[id]…`)

`GET` status (`PERM.integracao.read`); `PUT …/credencial` save, `PUT …/credencial/validade`
renew the expiry date, `DELETE …/credencial` remove (all `PERM.integracao.write`); the four
catalogue `GET`s (step 10, "The catalogue reads" below); and the product import's routes (step 9,
"The product import" below). Every route exports its verb as `export async function
GET|POST|PUT|DELETE` (never a re-export: `cors-proxy-covers-routes.test.js` cannot read one), and
every verb must be listed in the literal `Access-Control-Allow-Methods` in `proxy.ts`. The status and
credential routes read the conta uncached and require only `tipo === 3`, so a parked or
inactive conta can still be fixed. Only the context loader refuses those.

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

### The catalogue reads (step 10)

`GET …/categorias`, `…/marcas`, `…/grades` and `…/grades/[gradeId]` (all
`PERM.integracao.read`): the store's category, brand and grade lists, and one grade with its
options. The wire contract (answers, projections, `idDoRecursoLi`, `gradeIdDaRotaLi`,
`mesmaGradeLi`, the paging constants) is `packages/schemas/src/catalogoLojaIntegrada.ts`, shared
with the web linker; every 200 is built through its schema, with `Cache-Control: no-store`. The
work is `lib/lojaIntegrada/catalogo/catalogo.ts`.

- **Unlike the credential routes, these go through the context loader**, so the read switch
  is their first act: off (everywhere until the window) ⇒ 503 `LI_CHAMADAS_DESLIGADAS`, zero
  calls and zero Firestore reads; a parked or inactive conta is refused. The grade route
  answers 400 `LI_ID_INVALIDO` for a non-canonical `gradeId` before anything is read.
  `?atualizar=1` is read EXACTLY (one parameter, value `1`); anything else is not a refresh.
- **The cache** (`catalogo/cache.ts`): four module-scope `createReadCache` instances keyed
  `[conta, credential version, resource, grade]`, TTL `READ_CACHE_TTL.config`, 8/8/8/128
  entries, no negative caching. The context comes FIRST (the switch, and the version only it
  knows), so a hit still costs the cached conta read and one credential read. `?atualizar=1`
  evicts the settled copy only: an in-flight load is joined. The shared load never takes the
  caller's signal (one tab closing must not fail the others); the caller alone gets 499.
- **The version is re-checked at the end of every load**: the context reports each request's
  credential version (`aoUsarCredencial`), and a load that saw any other version than its
  key's — a token saved between two pages — fails (`LiCredencialTrocadaNaLeituraError`), is
  never cached, and answers 502 `LI_LOJA_INDISPONIVEL` with one WARN line. A grade detail
  whose `id` is not the asked grade (`LiGradeDivergenteError`) answers the same way.
- **The shared read-failure mapper** under the catalogue's own choices: a 401 parks on every
  route; a 403 parks ONLY on `categorias` (the path the token check itself reads), elsewhere
  502 `LI_RECURSO_NAO_PERMITIDO` + one WARN with nothing parked; a 404 on a grade is 409
  `LI_GRADE_AUSENTE_NA_LOJA`, on a list it is rethrown (a 500); more pages than
  `MAX_PAGINAS_CATALOGO_LI` is 502 `LI_CATALOGO_EXCEDE_LIMITE` (never a truncated list), a
  `next` that does not advance 502 `LI_LOJA_INDISPONIVEL`. Both refusals the catalogue answers
  itself (the 403 and the grade 404) carry the class `nao-autorizado`.
- **Budget**: `MAX_PAGINAS_CATALOGO_LI × (pacer + PRAZO_LI_MS.leitura) + 30 s` = 250 s under
  the 300 s ceiling (`prazos.test.ts`, which also counts ONE context load and one call of each
  package catalogue GET in the core, and none in the route files). `estrutura.test.ts` walks
  each route's closure (`ROTAS_DE_LEITURA_LI`) as it walks the paid re-check's.
- Log lines: the context's carry `fluxo: catalogo`; the core's own WARN lines are prefixed
  `[loja-integrada/catalogo]` with ids and counts only (rows the projection could not read,
  once per load). No write of its own (only the park's), no ruleset, index or env change.

### The product import (step 9)

`POST …/importacoes` start (`PERM.integracao.write`), `GET …/importacoes` the conta's newest 10,
`GET …/importacoes/[jobId]` one job, `POST …/importacoes/[jobId]/cancelar`, `GET
…/importacoes/[jobId]/itens?depois=` one page of the report, `GET …/importacoes/[jobId]/revisao`
the job's WHOLE tax-review list in one answer — read whole through the phase's own reader
(`importacao/listaRevisaoFiscal.ts`), an entry that does not parse answered with its id, never
dropped (the reads `PERM.integracao.read`). The
wire contract (the strict start body, the non-strict answers, the job document, the task) is
`packages/schemas/src/importacaoLojaIntegrada.ts`; every answer is built through it and never
carries the continuation `seq`, the cursors or the selection's ids.

- **The start makes no Loja Integrada call and touches no queue.** Id, strict body, then
  `importacao/inicio.ts`: the context loader FIRST (switch off ⇒ 503 `LI_CHAMADAS_DESLIGADAS`, zero
  Firestore reads, no job), the guard (a `pendente`/`executando` job of the conta ⇒ 409
  `LI_IMPORTACAO_EM_ANDAMENTO` with its `jobId`), then ONE `create` at an auto id, `pendente`.
  The first dispatch is the functions codebase's (a trigger on the job's creation).
- **The other routes call nothing outside the ERP** (`estrutura.test.ts`'s `ROTAS_SEM_CHAMADA_LI`,
  walked with the label routing route's rules): a missing job and another conta's job are the same
  404 `LI_IMPORTACAO_NAO_ENCONTRADA`; the report pages its job's own `itens` in document-key order
  (500 + 1 read, `?depois=` an item id).
- **Every job write is tier 1** (`importacao/job.ts`, its header's table): checkpoints chained from
  each write's `writeTime`, only the end-of-dispatch one bumps `seq`; a lost checkpoint is never
  re-applied (stop when the job no longer runs at that `seq`, else `LiImportacaoConcorrenteError`
  and the task retries). ⚠️ The Admin SDK retries a commit on its own with the same precondition,
  so a write that LANDED and lost only its reply comes back as a 9: every job write re-reads and
  counts it as written when the stored job holds its whole patch (`guardaOPatchLi`, the app's
  `deepEqual`) — read as a lost race, the end-of-dispatch checkpoint would stop with nothing
  queued. The fake models it (`respostaPerdidaNaProximaEscrita`). The cancel is one guarded update
  on the route's read, at most 3 attempts: a finished job is 409 `LI_IMPORTACAO_ENCERRADA`, a
  cancel that lost every attempt 503 `LI_IMPORTACAO_EM_CONFLITO` (retry; never the start's
  "attach to it" code).
- **The dispatch's budget** (`importacao/orcamento.ts`): a unit starts only while its WORST case
  ends inside 70 s (a call = pacer + read deadline = 22 s; a family with no call = 10 s; a photo =
  pacer + CDN deadline + upload deadline = 52 s, its `800x800` refetch a unit of its own), plus a
  30 s tail — 100 s. An order-intake attempt on the shared reads queue waits at most one dispatch
  PER IMPORT RUNNING AT ONCE (one per conta): its ladder fits half the hot sweep's hour for one,
  the whole hour up to seven (`functions/src/index.test.ts` pins both). The producer
  (`importacao/agendadorImportacao.ts`) NAMES every task `idTarefaImportacaoLi(jobId, seq)`, an
  answered already-exists is success, delays 0 / 2 / 60 s only.
- The context exposes `cdn`, the package's photo reader, built only in `core/contexto.ts` after
  every refusal (`estrutura.test.ts` scans the whole app for its factory).
- **The read phases are one unit at a time, state in, state out** (`importacao/catalogoDoJob.ts`,
  `listagem.ts`, `detalhes.ts`, `familias.ts`): each exposes the cost of its next unit (one call,
  or none) and runs it from the job as last checkpointed through the context's client, returning
  the new cursor for the dispatch's checkpoint. Their only writes are the job's own snapshot pages
  (`paginas/{tipo}-{offset}`) and details (`detalhes/{liId}`), whole, at deterministic ids (tier 0:
  a retried unit overwrites its own attempt; the fake models that plain `set`). The listing reads
  at `limit` 100, then the TRASH list once; nothing relies on list order (rows de-duplicated by id,
  the distinct count against the first page's `total_count`; a skipped row — no id, or a
  `removido` its list contradicts — is one WARN line of counts). A variation no listed parent
  claims and a trashed parent claims is `na-lixeira` with no detail read; the `orfaos` phase then
  reads EVERY other detail the assembly needs — the unexplained variations (their `pai` places
  them) and the ids a parent claims that no list carried — before any family is matched, so the
  SKUs the store repeats or nearly repeats are known whole and processing order never picks a
  winner. An orphan is
  never imported as a simple product; a LOOSE row (an orphan, a variation of a trashed parent, an
  unknown `tipo`) is its own `avulso` report item under every target but `selecionados`.
- **The match is the import's own cascade** (`importacao/resolucao.ts`), never the order import's
  SKU stage (that one answers the sellable unit; a link sits on the ROOT): this conta's link
  (`vinculoDoProdutoLi`, the only shared piece), a root by exact SKU, then any produto by exact SKU
  with the sole-member hop for a store simple product only, every probe `limit(2)`. Shapes must
  agree (`formaDaRaizErp`): a store family never meets an ERP sole member, a store simple product
  never a one-variation family. Variations are matched under the matched parent by their link,
  their exact SKU, then their option COMBINATION (`sku-diferente` when the SKUs differ). It folds
  nothing and every query rides a declared index (`resolucao.test.ts` checks each one against
  `firestore.indexes.json`). Before a link is written, the produto's own links are read whole and
  judged by `vinculoLiDaContaEId`: one store product per conta per ERP produto. A SKU in conflict
  in the store (`conflitosDeSkuNaLojaLi`, computed with the assembly, from the whole snapshot,
  before anything is created: an exact repeat, `sku-repetido-na-loja`, or a near duplicate,
  `sku-parecido-na-loja`, by the shared
  `skusParecidosNaLojaLi`) is matched only by an existing link or a variation's combination, and
  never created.
- **Option links are learned in two passes**, under both actions: `importacao/evidencias.ts`
  collects, over every family, the claims of variations matched by EXACT SKU (one claim document
  per store option, never one per variation); `importacao/gruposLi.ts` then decides them all at
  once with the shared `decidirAprendizadoLi` (unanimity, fail-closed "holds") and writes each
  changed grupo ONCE, tier 1 on the memo's stamp, through the never-drop merge — a lost
  precondition re-reads that grupo and re-decides, and EVERY grupo still to write is written from
  the re-run decision (never the stale one); a second loss is `conflito-de-escrita`, its claim id
  carried on the job (`aprendizado.conflitos`) to the families with that option. A refused learning
  shows on every resolved variation carrying the option, the ones matched by link or exact SKU
  included (those made the claims). Simular writes
  no grupo: its learnings ride the job (`aprendizadosSimulados`) as an overlay later resolutions
  read through the same merge, so its verdicts equal an `aplicar` run's (one stated residual: two
  store roots placed on ONE ERP produto, `vinculos.ts`). No grupo or variante is ever created.
- **One family of the `familias` phase** (`importacao/familiaDoJob.ts`): cascade → plan
  (`plano.ts`, pure: the target, the planned link documents `safeParse`d through the link schema,
  the "complete" create classification — a hidden or blocked store product is never created, a
  hidden variation is left out — and every pendência; a refusal is a pendência, never a throw) →
  links (`vinculos.ts`) → report item (`relatorio.ts`, `itens/{liId}`, whole). A link is created at
  the store id's doc id (tier 0, `ALREADY_EXISTS` re-read and judged by `vinculoLiDaContaEId`) or
  its mirror (`ativo`, `bloqueado`, `removido`) refreshed tier 1 on its own read — compared as the
  link schema's own fields read them, so a stored value they refuse (`null`) is repaired; a field
  with a value is never touched, a row-only link leaves `destaque`/`usado`/`marca` ABSENT (a
  detail-backed one carries them, `marca` as the brand URI verbatim), and a variation is linked
  only beside its parent's confirmed link. A family in CONFLICT is reported under `jaNoErp` and
  `naoNoErp` too, with no link. "Only link" writes link documents and the job's items, nothing
  else; a second run over an unchanged store writes no link. A RETRIED unit whose links already
  landed (the item write or checkpoint failed after them, or a create's reply was lost) still
  reports and counts them as created: a link of this conta at the store id's doc id, equal to the
  plan, whose snapshot `createTime` is at or after the job document's own `createTime` (the
  dispatch's job read; server clock, never `iniciadoEmMs`) reads `criado`/`retomado`, and a root
  `vinculado` only through it reports `encontrado`. Residuals in `vinculos.ts` (two jobs of one conta
  at once, another writer's identical link during the run, and a MIRROR REFRESH this job landed,
  which reads `sem-mudanca` on the retry: `semMudanca +1`, its informational `vinculo-atualizado`
  lost, `vinculados` unaffected) and `familiaDoJob.ts` (a variation first matched by combination
  loses its `sku-diferente`, or its actionable `sku-repetido-na-loja` / `sku-parecido-na-loja`, on
  the retry).
- **The first dispatch is a TRIGGER's** (`functions/src/onImportacaoLojaIntegradaCriada.ts`,
  CREATE of `importacoesLojaIntegrada/{jobId}`): ONLY a job created `pendente` enqueues the named
  task `li-importacao-<jobId>-0` on the READS queue (zero reads; anything else returns with no
  line); the tasks valve closed stamps the job `falhou/tarefas-desligadas`; a transient Cloud Tasks
  failure rethrows (`retry: true`, the name makes it idempotent). `database` is the named
  `default`, no secrets, no Loja Integrada call.
- **One dispatch** (`importacao/despacho.ts`; the reads queue routes the RAW `tipo: importacao`
  there, `functions/src/depsImportacao.ts` binds its deps, the handler stamps the start FIRST): the
  payload (unparseable ⇒ dropped, zero reads), the job, the `seq` decision (`nada`; `continuacao`
  REPAIRS a hand-off that may never have happened — OUR hand-off on the stored `seq`: the named
  successor at the conservative 60 s, since it cannot tell a budget end from a 429 pause, and
  stops; `executar`), the context (switch FIRST ⇒
  `falhou/chamadas-desligadas`; a conta that cannot be read from ⇒ `conta-indisponivel`), then the
  phases one unit at a time, each unit's worst case checked against the budget and EVERY unit
  checkpointed at the same `seq`; when the next unit does not fit, the end-of-dispatch checkpoint
  (`seq + 1`) and the named continuation 2 s later. Families of a `selecionados` job are the
  selection only. A 429 PAUSES (end checkpoint with `pausas429 + 1`, the continuation 60 s later,
  no attempt consumed; past `MAX_PAUSAS_429_LI` ⇒ `limite-de-chamadas`); a 401 parks the conta
  like every reader — under Simular too, the ONE write a Simular makes outside its job; a detail
  ANSWERED off its schema (`formato`) is ONE product without a usable detail (logged), never the
  job, while an empty or non-JSON 200 is the transport's and retries; the valve closed at a
  hand-off ⇒ `tarefas-desligadas`; anything else rethrows, and on the queue's LAST attempt a
  failure a retry could have changed — another writer of the same `seq` included, an earlier
  attempt the queue gave up on — RE-READS the job: still running at that `seq` ⇒ stamped
  `tentativas-esgotadas`; ONE `seq` ahead and `executando` ⇒ handed off by WHOSE end checkpoint
  put it there (`guardaOPatchLi` against the end patch the dispatch kept from before its write,
  `patchDoFimDoDespachoLi`): OURS (it LANDED behind a DEADLINE_EXCEEDED, or a 9 whose re-read
  failed) ⇒ our own hand-off with OUR delay (2 s budget end, 60 s 429 pause), and if that fails the
  usual endings on the new `seq` (`tarefas-desligadas`, `tentativas-esgotadas`); another dispatch's
  ⇒ a COURTESY at the conservative 60 s that never re-targets the `seq`, never stamps and never
  rethrows (valve closed or transient ⇒ `parado`, on EVERY attempt: a rethrow would hand the job
  to this task's retry, whose repair takes the stored `seq` as its own and stamps it on the last
  attempt). A checkpoint that stops on a job one `seq` ahead is always a courtesy, on every
  attempt. The repair keeps the usual endings on the stored `seq` (`tarefas-desligadas`, and
  `tentativas-esgotadas` when its last-attempt enqueue fails: the common writer is this task's own
  dead earlier attempt). Both residuals need two attempts of one task acting on one job (a reply
  lost, a stalled or crashed instance; never a slow slice — the 100 s budget sits far inside the
  300 s timeout): the owner never enqueued (died first, or its enqueue failed after the queue
  stopped listening) AND the courtesy failed ⇒ `executando` with nothing queued until Cancelar (one
  write, then a new start; a coding bug stays loud) — a trade made knowingly, since a rethrowing
  courtesy would let the retry's last attempt stamp a job whose owner DID hand off; and a LAST
  attempt whose own hand-off fails transiently (the repair's, or our landed end's) stamps
  `tentativas-esgotadas` even when another attempt already enqueued the successor. It reads the snapshot, its details, the grupo memo and the
  claims at most once per dispatch, lazily. The summary aviso is synced before the phase machine's
  own terminal stamps (`aplicar` only), on a FRESH read of the job that still runs at its `seq`,
  the stamp chained from that read (a cancel landing in between the two is the stated residual).
  Under "complete" one family spans several units (below), and EVERY `aplicar` job, under either
  action, runs the `revisao` phase after `familias` (`faseDepoisDasFamiliasLi`).
- **"Complete" (`acao: completar`; `familiaDoJob.ts`, "Complete")**, in units budgeted and
  checkpointed at one `seq`: the family's details (one call each, the ids read in
  `familias.filhosLidos`; matched and planned only once the last is read), its PREPARATION (no
  call), its PHOTOS (one picture per unit, `aplicar` only), its CLOSING (no call). Per produto:
  fill, then photos, then the link LAST, so this job's own anchor write never lands inside one of
  its guarded windows; a create's or an add's links ride that batch. Between units the family's
  progress rides the job's own `progressoDaFamilia`, validated before every write and cleared at
  its closing (a stored value that does not parse reads as none: the family is prepared again). The
  TARGET is decided once, on the ERP as it stood when
  the job STARTED: a matched root at the family's own SKU-keyed id created at or after the job
  document (this job's landed create, another conta's create it adopted or met landed) was absent
  then, so the family is also in `naoNoErp` — on the first attempt and on every retry, whether the
  retry meets it through this job's link or through the SKU; it adds a target, never removes one
  (`jaNoErp` keeps the cascade's answer). An adoption's or a closing's re-run of the cascade keeps
  the preparation's verdict. ⚠️ Residuals: a root deleted and created again at that id reads as
  absent at the start; an attempt that wrote ONLY its item (nothing imported), retried after
  another writer's root at an auto id (anywhere, under "only link") landed, drops out of
  `naoNoErp` with that item left uncounted. A unit whose detail list found nothing to read reuses
  that list's cascade. No writer
  here names the transaction API (no inventory row). The writers, each with its tier:
  - **Categories** (`categorias.ts`): the product's leaf by the shared tree helpers; under
    `criarEVincular` the unlinked chain BELOW the nearest linked ancestor (decided 2026-11-06: one
    above it stays uncreated), root-most first, each categoria at `li-<conta>-<id>` and its link at
    `<conta>-<id>` — two tier-0 `create()`s, `ALREADY_EXISTS` re-read and judged before adopting; `nomeCompleto` from the ERP parent's
    stored breadcrumb, never the store's names joined. Always PLANNED first (the resolution run as
    Simular runs it: reads, no write) and created only for a produto about to take it — a create's
    right before its batch, after every refusal — so a create refused before its batch leaves no
    category behind and reports no category pendência (a batch that then loses leaves the category
    standing, and the item names it). The item of the family that created a category names it
    (`categoriasCriadas`; a later family that uses it names none), but for a unit retried over its
    own landed create or category fill, whose item stops naming it (`familiaDoJob.ts`, "A retried
    family").
  - **The whole-family create** (`familiaNova.ts`): ids keyed by the SKU (`li-sku-<sha256>`,
    `-un` for a sole member), so two contas selling one SKU meet on one id; the planned ids read
    first; the create probe (`sondarSkusLi`, every SKU the batch writes, the "parecido" forms
    too) right before the commit; then ONE batch of `create()`s — produtos, `extraData`, links —
    all or nothing (tier 0 by construction). `ALREADY_EXISTS` re-reads: the root holding the store
    SKU is ADOPTED (the existing-product path; a cascade that then refuses it reports its own
    verdict), unless this conta's root link shares its `createTime` (our own batch, its reply lost:
    `retomada`); anything else at an id is `sku-ja-existe`. A simple product becomes a família de
    um; a family takes the ERP builder's names, selection and `filhoUnicoId` (`derivarFilhoUnico`
    over the full set); a hidden product or variation is never created. The DETAILS decide too: a
    root or kept variation whose detail was never read (a 404: deleted since the listing) refuses
    the create (`dado-invalido`, `detalhe` — judged after the probe), one its detail shows hidden,
    blocked or trashed is not created, one whose detail changed the SKU refuses it (`dado-invalido`,
    `sku`). The checks needing no detail (options, the probe over the rows' SKUs) run BEFORE the
    details are read, so a family they refuse costs no call. A name over 100 is cut and reported
    (`nome-cortado`, informational), and two variations the cut makes one name refuse the create
    (`dado-invalido`, `nome`).
  - **Add-child** (`filhoNovo.ts`), beside the parent's CONFIRMED link: the missing variations,
    their links and the parent's `filhoUnicoId` in ONE batch, tier 1 on the PARENT (every ERP
    writer that changes a child set writes the parent too); a lost precondition re-reads the
    parent and the child set and re-plans (≤ 3); a post-commit re-derive catches a writer that
    moved the pointer alone. Each variation needs its own read detail, as the create does. A
    retried unit meets a variation THIS job added through its own link and counts it as created
    again.
  - **Fill-empty** (`completar.ts`): only a field absent, `null` or `''` — never `0`, `false` or a
    value of another shape — tier 1 `update(patch, { lastUpdateTime })` on the attempt's read,
    re-planned on a loss (≤ 3), a lost reply recognised by `guardaOPatchLi`; an absent `extraData`
    created with only the filled keys; a kit root's rollup fields never. ONE unit conversion,
    `medidasErpDoDetalheLi` (weight in kg, box in cm: the store's own units, decided 2026-11-09,
    so nothing is scaled). The
    variations take the category the ROOT's fill left (the one it wrote, else the one its last
    read found — an operator's landed meanwhile — else none), never the pre-fill guess.
  - **Photos** (`fotos.ts`), onto a produto with NONE: through `contexto.cdn` only, the ORIGINAL
    first, `800x800` in a unit of its own when the original is over the cap, the type from the
    BYTES; stored by the shared uploader (`putArquivoAdmin`: create-first, content-addressed)
    raced against `PRAZO_UPLOAD_LI_MS`; then ONE tier-1 write on a read taken AFTER the uploads,
    so an operator's photo landing meanwhile wins. No default bucket ⇒ the job is stamped
    `fotosIndisponiveis` and no photo is planned. A Storage failure propagates and, ⚠️ no Storage
    error class being reachable to narrow on, is never stamped `tentativas-esgotadas`: a missing
    bucket grant, or a transient Storage failure on the queue's last attempt, leaves the job
    `executando` until Cancelar (`functions/DEPLOY.md`).
  - **The tax review** (`revisaoFiscal.ts`): a produto created, or one whose empty category was
    filled or stays empty, joins the job's `revisao/{produtoId}` (tier 0, merged on
    `ALREADY_EXISTS`) — the entry a create's batch, an add's batch or a category fill calls for
    written BEFORE that write, so a write that lands and whose unit then fails never loses it. The
    `revisao` phase carries the open entries of every earlier `aplicar` job back to the newest one
    that ended `concluido`, skipping Simular jobs (decided 2026-11-06; the declared job index),
    removes an entry only on EVIDENCE — its own or its category's `imposto`, or a `regraImposto`
    naming either (the resolver's tier-4 match) — or when its produto is gone (decided 2026-11-06),
    and syncs `lojaIntegradaRevisaoFiscal` on the open count. A list is read WHOLE once per dispatch
    and paged in memory, never by a document-key range (on Enterprise one scans the whole list per
    page without a `__name__` index).
  - Simular decides all of it and writes none of it: the category plans ride the job's
    `mapaCategorias` (`simulada`), photos are counted with no download (decided 2026-11-06, so it
    cannot foresee a `foto-recusada`), and it never enters `revisao`. Store SKUs that would collide
    with one another are decided from the whole snapshot before anything is created, so both modes
    refuse them alike.
- **The import's avisos** (`importacao/avisosImportacao.ts`): Simular raises and resolves nothing;
  the summary aviso closes only after an `alvo: todos` job that ends `concluido` with no actionable
  pendência; the per-category one is raised at an `aplicar` job's end from its items' own category
  refusals and resolved by a later catalogue phase that finds the category linked or gone; the
  tax-review one is synced on the open count at the `revisao` phase's end. The three tipos join the expiry sweep's orphan pass (`avisos/avisos.ts`): the
  per-category one is matched by key prefix, the two per-conta keys are a listed conta's, and a row
  written after the conta list was read is left for the next tick.

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
  a `create` on an existing doc, and stamps one commit time on all of it; the emulator suites
  `pedidos/importarPedido.firestore.test.ts` and `importacao/completar.firestore.test.ts` pin
  the server's answers.

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
- Tests run the real `escreverAviso`/`resolverAviso` against `lib/lojaIntegrada/testing/fakeDb.ts`,
  and the import's photos the real shared uploader against `testing/fakeBucket.ts` (it throws on
  any call the uploader never makes). Apps have no dependency edges, so Shopee's fakes cannot be
  imported.

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
- **Catalogue ids are keyed pseudonyms** (`sanitizacao/pseudonimo.ts`): on a `catalogo`
  2xx pair the sanitizer maps every kept `id` and `*_id`, every id segment of a kept
  resource URI, of the request path and of `meta.next`/`previous`, and the `produto=`
  query value to `1e11 + HMAC-SHA256(key, "li-fixture-id:" + id)[0..6] mod 9e11`, one
  namespace for every resource, so the relations between rows survive. Twelve digits:
  no real id has that many (products and images, the longest, have 9), and a pair
  holding one is refused (`id-real-na-faixa-do-pseudonimo`), so the range check is
  sound for every resource kind; neither 11 nor 14, the CPF and CNPJ lengths. The key is
  `.chave-fixtures` in the capture folder (created once by `--gerar-chave`, which refuses
  to replace it; never printed, never committed). ⚠️ **The key OUTLIVES the captures**:
  deleting merged raw pairs never deletes it, and a later catalogue capture must use the
  same key, or its ids silently stop matching the committed fixtures. No key → the
  catalogue pair is refused (its printed request line blanks ids as `<id>`, SKUs as
  `<sku>`); two ids (or SKUs) on one pseudonym → the run is refused (new key). **A new key
  changes every catalogue id and SKU: regenerate every catalogue fixture in one
  change.** What the mapping cannot reach is refused: a catalogue error body keeping a
  number other than its status, and a
  catalogue resource on a path `ehCatalogo` does not admit. Meta counts, other query
  values (`limit`, `offset`) and the configuration/estrutural classes are untouched. The
  dry run's leaf table shows mapped leaves as `pseudonimizado`; `wireCorpus.test.ts` pins
  their relations, distinctness and range.
- **Catalogue SKUs are keyed pseudonyms too** (same key, same module): a storefront prints
  a product's SKU on its public page, so a real one is a web search away from the store's
  name. Every kept `sku` on a `catalogo` pair, and every `sku=` value of its request and
  of `meta.next`/`previous`, maps one character at a time, each from
  `HMAC-SHA256(key, "li-fixture-sku:" + upper(the SKU before it))`: same length, digit to
  digit and letter to letter in its case, every digit and letter changed, and a
  variation whose SKU is its parent's plus a suffix still starts with its parent's
  pseudonym (`wireCorpus.test.ts` pins it). A digit that would END a run the redactor's
  check-digit layer masks (`fimDeTrechoDaCamadaDeDigitosLi`, the layer's own table)
  becomes an upper-case letter, decided on the prefix alone, so no pseudonym reads as a
  CPF or CNPJ. Order SKUs (the `estrutural` class) stay as captured (Q3). The catalogue
  class also FAKES every external identifier, `gtin`, `mpn` and `id_externo`
  (`CHAVES_FALSAS_CATALOGO_LI`): a GTIN's company prefix, a supplier part number and
  another channel's listing id each name their owner.
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
  there); its floor `MINIMO_DE_FIXTURES` is the committed count (42: the 18 step-3 captures,
  the 11 step-10 catalogue captures, `c9-*`, and the 13 step-9 product captures, `c10-*`),
  so a fixture that disappears fails it, and so does one added without moving it. The
  product captures are replayed through the import's own reads by
  `importacao/capturasProdutos.test.ts`.
- ⚠️ The owner's raw `pedido-enviado` pair duplicates `pedido-boleto` (the same order,
  identical sanitized bytes) and is EXCLUDED from the corpus. It stays in `~/li-capturas`
  until he deletes it, so a sanitizer run without `--so` writes it back: delete that raw
  pair first, or regenerate with `--so` naming only the pairs wanted. The shipped state is
  covered without it: `pedido-pix` and `pedido-cartao` (`situacao.codigo`
  `pedido_enviado`, a tracking code under `envios`) and `historico-pedido-enviado`.
- Kept on review of the first corpus (2026-10-14), not leaks: a 14-digit window INSIDE a
  longer ORDER SKU that passes the CNPJ check (the scan tests whole values; any one window
  passes by chance about 1% of the time, and the sibling variant's window fails), LI's own
  numeric ids where the profile keeps them on the configuration class (platform-wide
  constants; catalogue ids are pseudonyms, above), `meta.total_count` (the kept numeros
  already show the store's scale) and `resposta.bytes` (step 11 sizes snapshots with it). ⚠️ An
  order detail's top-level `id` is FAKED (`0`) and so is every `itens.*.produto`
  (a placeholder, not even a URI): no capture test may key on either, and the produto
  reference form has no real capture yet. Catalogue SKUs are NOT on this list: the product
  captures' real variation SKUs hold 11- and 14-digit windows that pass a check, where a
  family code meets its option suffix, in a pattern no "chance" or "the sibling fails"
  argument covers, so they are pseudonymized (above) rather than kept on review. A window
  inside a pseudonym says nothing about a real value.
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
  off, so a run DEFERS before any read and reaches no import path, the paid-without-CEP
  refusal below included (D17).
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
- Paid without a CEP: a PAID order with a shipment, NO CEP at all (no delivery block, or a `cep` absent,
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
  suportado, pago sem endereço and `lojaIntegradaReversaoComEtiqueta` (a reversal on
  a pedido with a bought label). Order avisos and incidentes run after the batch, on
  `importado` and `sem-mudanca`, so a retry after a crash still writes them.
- A re-import keeps the `externalOptionData` keys Loja Integrada does not own (`agency`).
- `pedidos/importarPedido.firestore.test.ts` (emulator, CI below) pins the batch.

## CI (steps 3, 5, 7, 9 and 20)

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
- Since step 9 the JOB trigger (`onImportacaoLojaIntegradaCriada`) fires on EVERY suite's
  `importacoesLojaIntegrada/*` creates, and enqueues only a job created `pendente`. So a suite
  seeds its jobs `executando` (or ended) unless the dispatch is what it awaits:
  `functions/src/importacao.tasks.test.ts` creates `pendente` jobs and awaits each one's
  `falhou/chamadas-desligadas` (the dispatched function stops at the switch; no conta is seeded,
  which makes the motivo discriminating), and proves the trigger ignores an `executando` job with
  a LATER sentinel; `lib/lojaIntegrada/importacao/importacao.firestore.test.ts` seeds `executando`
  jobs only (the guard's query, the chained preconditions, a checkpoint losing to a cancel, a stale
  `seq`). Neither writes `produtolojaintegrada` docs. `lib/lojaIntegrada/importacao/completar.firestore.test.ts`
  does (its one job seeded `executando`): it proves on the server what the fake models for the
  complete step — a family batch failing WHOLE on one taken id, and the adoption after another
  conta's create (one produto per SKU, one link per conta); our own landed batch told by the root
  and its link sharing ONE `createTime`, and two commits not; the add-child batch losing the
  parent's precondition to a sibling delete, the pointer re-derived from the live set; a fill and
  a photo write each losing to an operator. It calls the writers through their test seams
  (`antesDoCommit`, `antesDaEscrita`, the upload seam), not the dispatch, and the photos run the
  real shared uploader against this Firestore over `testing/fakeBucket.ts` (the lane has no
  Storage emulator).
- A new `*.tasks.test.ts` / `*.firestore.test.ts` joins the same job and check name. Its
  `beforeEach` wipes what it reads (one shared emulator, files run serially), and a drop
  is proved by a LATER sentinel row, never by polling for an absence.
- The conta trigger fires on EVERY suite's `integracao` writes (the functions emulator loads
  the whole codebase). So a suite that writes `integracao` docs uses conta ids no other suite
  seeds, and a suite whose writes fire the trigger awaits the trigger's last write before it
  ends. The step-3 suites seed contas with no filial and no `dataCadastro`, which the core
  plans as `incompleto` (reads only). Why one job anyway: `vitest.tasks.config.ts`.
- The ANCHOR trigger (step 9) fires on EVERY suite's `produtos/*/produtolojaintegrada/*`
  writes (today `pedidos/importarPedido.firestore.test.ts`, `importacao/completar.firestore.test.ts`
  and its own suite, `functions/src/onProdutoLojaIntegradaLinkChanged.tasks.test.ts`): a
  counting link's create writes its conta into the produto's `integracoesComProduto`. So a suite
  that writes link docs uses produtos no other suite seeds, awaits the anchor's write on EACH
  produto it linked UNCONDITIONALLY before it asserts on that produto or races a precondition on
  it (never "only if it fails") — a link the code under test writes (a create's batch, the
  adoption path) included, not only a seeded one — and ends by deleting its links and awaiting
  the anchor's last write (the conta leaving the array) before its produtos go —
  `lib/lojaIntegrada/testing/ancoraLi.ts`. Delete a link only once its anchor add has landed: an
  add handled after the removal re-lists the conta, and the wait for its leaving never ends. Its own
  suite proves "never touches" by later positives (the other conta's add and removal are
  observed writes). It does NOT prove "keeps": a check that keeps writes nothing, and the
  functions emulator may run two invocations at once, so a later sentinel orders that check only
  as far as the emulator serializes them. The keep verdict and the survivor read's fold of both
  stored ref forms are pinned offline (`lib/lojaIntegrada/produtos/integracoesComProdutoLi.test.ts`);
  the emulator case shows only that the real guarded write runs and that losing the last
  counting link removes the conta.
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
