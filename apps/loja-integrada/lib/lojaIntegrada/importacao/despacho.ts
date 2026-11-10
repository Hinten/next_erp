/**
 * ONE DISPATCH of the product import (master plan step 9): what a reads-queue task
 * `{ tipo: 'importacao', contaId, jobId, seq }` does. The functions codebase's reads queue routes
 * the raw `tipo` here and binds the deps once (`functions/src/depsImportacao.ts`); everything below
 * is Next-free, takes `db` as a parameter and reads no process environment.
 *
 * ## The order of one dispatch
 *
 *  1. The payload, parsed (`tarefaImportacaoLiSchema`): one that does not parse is DROPPED — no
 *     retry could ever make it valid — with zero reads.
 *  2. The job, read by id. No job, or another conta's job ⇒ nothing.
 *  3. The `seq` decision (`decidirDespachoLi`, `job.ts`):
 *     - `nada` — a stale chain, a finished or cancelled job: nothing else is read or written;
 *     - `continuacao` — the stored job is already one `seq` ahead: an earlier attempt of this task
 *       wrote its end-of-dispatch checkpoint, and its hand-off may never have happened. This task
 *       REPAIRS it: it re-enqueues the NAMED successor and stops (no context, no Loja Integrada
 *       call), at the CONSERVATIVE 60 s, never 2 s — it cannot tell whether the checkpoint it
 *       repairs was a budget end or a 429 pause, and 60 s never cuts a pause short (a budget end
 *       only waits 58 s longer, on a rare recovery path). When the owner's own enqueue exists, ours
 *       is already-exists and the owner's delay stands. The repair is OUR hand-off and targets the
 *       stored `seq`: the valve closed stamps it `tarefas-desligadas`, and a transient failure on
 *       the queue's last attempt stamps it `tentativas-esgotadas` ("Whose hand-off" below);
 *     - `executar` — the run below.
 *  4. The context (`core/contexto.ts`), whose FIRST act is the read switch: while
 *     `LOJA_INTEGRADA_CHAMADAS` is not exactly `on` it refuses with zero Firestore reads and zero
 *     calls, and the job ends `falhou/chamadas-desligadas`; a conta that is gone, inactive or
 *     parked, or whose credential is missing or corrupt, ends it `falhou/conta-indisponivel`. A
 *     restart is safe: every write of the job is idempotent.
 *  5. The PHASE MACHINE, one unit at a time under the time budget (`orcamento.ts`): before each
 *     unit its worst case is checked against the budget; after EVERY unit — a call or not — a
 *     tier-1 checkpoint of the progress at the SAME `seq` (`job.ts`), so a cancel is seen at the
 *     next unit, a family at a time even through a stretch of families that call nothing.
 *  6. When the next unit no longer fits: ONE end-of-dispatch checkpoint (`seq + 1`), then the
 *     NAMED continuation `idTarefaImportacaoLi(jobId, seq + 1)`, 2 s later.
 *
 * ## The phases (the job contract's order)
 *
 * | Phase | One unit | Cost | Module |
 * | --- | --- | --- | --- |
 * | `catalogo` | a category or brand page; then the category-link read | a call; then none | `catalogoDoJob.ts` |
 * | `listagem`, `lixeira` | one product page; then the closing count | a call; then none | `listagem.ts` |
 * | `orfaos` | one detail the assembly needs (an unexplained variation, or a claimed id never listed); then the phase's end | a call; then none | `familias.ts` |
 * | `evidencias` | one family's exact-SKU claims | none | `evidencias.ts` |
 * | `aprendizado` | every claim decided at once | none | `gruposLi.ts` |
 * | `familias`, "only link" | one family: cascade, plan, links, item; then the closing unit (the `nao-listado` and loose-row items) | none; none | `familias.ts`, `familiaDoJob.ts` |
 * | `familias`, "complete" | one detail the family needs; then the family's preparation (with nothing to fetch, also its closing); then one photo; then its closing | a call; none; a photo; none | `familiaDoJob.ts`, `fotos.ts` |
 * | `revisao` (`aplicar` only) | one page of the tax-review carry-forward or re-check; at its end the tax-review aviso | none | `revisaoFiscal.ts`, `avisosImportacao.ts` |
 * | `fim` | the summary aviso and the per-category avisos (`aplicar`), then `concluido` | none | `avisosImportacao.ts`, `job.ts` |
 *
 * At the catalogue phase's end an `aplicar` job also resolves the per-category avisos whose store
 * category is now linked or gone (`resolverCategoriasSemVinculoLi`). In `familias`, only the
 * families of the job's target are visited when it names them (`selecionados`): a family outside
 * the selection costs no read at all. The evidence pass visits every store family whatever the
 * target (its own header).
 *
 * ## Complete (`acao: completar`)
 *
 * A family's complete step spans SEVERAL units, each budgeted and checkpointed on its own at the
 * same `seq` (`familiaDoJob.ts`, "Complete"), so a cancel is seen at the next one:
 *
 *  1. **Its details**, one call per unit: every id `detalhesDaFamiliaLi` says completing the family
 *     needs (a detail only where it can change something), minus every detail the job holds or
 *     tried — the `orfaos` phase's, and the family's own, which the job's `familias.filhosLidos`
 *     lists (the root's id included). The family is matched and planned only once the last one is
 *     read: an all-or-nothing create never sees half a family. A create the checks that need no
 *     detail already refuse (an option, a combination, the probe over the rows' SKUs) asks for none.
 *     The list is computed once per dispatch per family; a unit whose cost was not known yet is
 *     budgeted as a call (the worst of a detail read and a family).
 *  2. **Its preparation**, no call: the category planned, then the create (every refusal, the probe
 *     immediately before the commit, the planned categories created and the tax review written only
 *     then — in the same unit, with no Loja Integrada call in between) or the fills. A unit whose
 *     detail list found nothing to read reuses that list's cascade. With nothing to fetch — no
 *     photo, the bucket missing, or Simular (which counts the pictures with no download) — the
 *     closing runs in the same unit.
 *  3. **Its photos**, `aplicar` only: one picture per unit (`fotos.ts`, the `foto` budget row; its
 *     `800x800` fallback a unit of its own), the downloads counted with the calls. An upload past its
 *     deadline ends the dispatch's units at once (`parar`): the end-of-dispatch checkpoint and the
 *     continuation follow, and the next dispatch fetches that picture again.
 *  4. **Its closing**, no call: the links LAST, the variations the ERP family lacks, the item, the
 *     counters — and the family cursor past it.
 *
 * Between the units the family's PROGRESS rides the job (`familiaDoJob.ts`, "The family's
 * progress": `progressoDaFamilia`, which the closing clears). Work a unit was not budgeted for is never started: it checkpoints what it learned, and the next
 * unit is budgeted for that work.
 *
 * **Photos and the bucket.** A job that asks for photos (`deveImportarFotosLi`) asks the functions
 * codebase for the default bucket ONCE per dispatch, under Simular too, so its verdict is an
 * `aplicar` run's: none ⇒ the job is stamped `fotosIndisponiveis` in that unit's checkpoint and no
 * photo is planned for the rest of the run; one found missing after a family's preparation closes
 * that family with what was stored.
 *
 * **The tax review.** EVERY `aplicar` job enters `revisao` after `familias`, under either action
 * ({@link faseDepoisDasFamiliasLi}); its last unit syncs the tax-review aviso on the open count
 * (`sincronizarAvisoDeRevisaoFiscalLi`). The per-category aviso is raised at the job's end beside the
 * summary aviso, from the items' own category refusals ({@link categoriasSemVinculoDoJob}).
 *
 * ## What each dispatch reads once, and keeps
 *
 * The job's snapshot pages (`paginas`, key order) and the details its assembly needs (by id), the
 * `grupoDeVariacoes` memo (whole), and — for the `familias` phase — the job's claim documents: each
 * read at most ONCE per dispatch, lazily, and only by a phase that needs it. A detail this
 * dispatch reads is added to its in-memory assembly as it is stored, never re-read; the memo takes
 * the learning's own writes (their `writeTime`s). Families run while their ACTUAL elapsed time
 * leaves room for one more family's worst case, so these reads are spread over every unit of the
 * dispatch.
 *
 * ## Simular writes only the job
 *
 * Under `simular` every phase decides exactly as `aplicar` does and writes only the job document
 * and its own subcollections: no link, no grupo (the learnings ride the job as an overlay later
 * families resolve against), no aviso of the import's. Two stated residuals of that parity: two
 * store roots placed on ONE ERP produto (`vinculos.ts`) and, decided 2026-11-06, the photos: Simular
 * counts them with no download, so it cannot foresee a `foto-recusada` and the `fotos` counter can
 * differ (`fotos.ts`). A later family never needs what an earlier one would have created: store SKUs
 * that repeat or nearly repeat one another, or a store simple product's derived sole-member SKU, are
 * decided from the whole snapshot before anything is created (`conflitosDeSkuNaLojaLi`), so both modes
 * refuse them alike (pinned in `familiaDoJob.test.ts`). The modules below each hold that rule — under
 * "complete" a category or family create is planned, a fill decided, a picture counted, none written —
 * and the dispatch adds no write of its own outside the job: Simular never enters `revisao`, and the
 * photo units are `aplicar`'s alone.
 *
 * ⚠️ The ONE exception is not the import's decision: a 401/403 parks the conta exactly as every
 * reader parks it (`tratarFalhaDeAutenticacao`: the conta's credential document and its reconexão
 * aviso), whatever the mode. The store refused the CREDENTIAL — a fact about the conta, not a
 * simulated outcome — and until the window no other flow reads the store, so a Simular is the one
 * reader that could notice a revoked token.
 *
 * ## Failures (root rule 6) — each narrowed to its class
 *
 *  - **429** (`LiThrottleError`) ⇒ a PAUSE: the end-of-dispatch checkpoint with `pausas429 + 1`, then
 *    the named continuation 60 s later; the task SUCCEEDS, so no attempt is consumed. With
 *    {@link MAX_PAUSAS_429_LI} pauses already taken ⇒ `falhou/limite-de-chamadas`.
 *  - **401/403** (`LiAuthError`) ⇒ the conta is parked exactly as every reader parks it
 *    (`tratarFalhaDeAutenticacao`): parked, already parked or without a credential ⇒
 *    `falhou/conta-indisponivel`; a refusal of an OLDER token, or one with no usable ref, is
 *    rethrown and the queue's retry runs with the token now stored.
 *  - **The conta's refusals mid-run** (the credential getter re-reads it before every call: a park
 *    by another flow, a credential removed) ⇒ `falhou/conta-indisponivel`.
 *  - **A detail body off its schema** (`LiSchemaError` `formato` on ONE product) ⇒ that product has
 *    no usable detail, logged with its id and the field paths: one bad product never stops the job.
 *    An EMPTY or non-JSON 200 (`vazio`, `nao-json`: a gateway's answer, not the product's) is
 *    rethrown like any transient failure, and the retry reads the detail again. A LIST page off its
 *    schema is not one product, and propagates.
 *  - **Tasks switched off** on OUR continuation (`LiTarefasDesligadasError`) ⇒
 *    `falhou/tarefas-desligadas`: never a job left `executando` with nothing queued. On a courtesy
 *    hand-off it is `parado` instead ("Whose hand-off" below).
 *  - **Everything else is rethrown**, and Cloud Tasks retries the same task: before its last
 *    checkpoint it resumes from the last unit checkpoint; after it, the continuation check
 *    re-enqueues the successor. On the queue's LAST attempt ({@link TASK_MAX_ATTEMPTS}) a failure of
 *    a class a retry could have changed — Loja Integrada's answers, the network, a page or a body
 *    off its schema, Cloud Tasks, Firestore, a stored document off its schema, the park's
 *    contention, another writer of the same `seq` (`LiImportacaoConcorrenteError`) — is answered
 *    from a FRESH raw read of the job instead, since no retry follows to do it: a job still running
 *    at the dispatch's `seq` is stamped `falhou/tentativas-esgotadas` (a task that entered
 *    `continuacao` targets the stored `seq` from its first read, so its failed repair stamps that
 *    `seq`); a job ONE `seq` ahead, still `executando`, is handed off by whose checkpoint put it
 *    there ("Whose hand-off" below) and is never stamped for this dispatch's failure; anything
 *    else is left alone. The common cause of the
 *    second case is OUR end-of-dispatch checkpoint that LANDED while its call surfaced another
 *    error (a DEADLINE_EXCEEDED, an UNAVAILABLE after the SDK's retries, a 9 whose re-read failed):
 *    stamped, or left with no task, the job would sit `executando` and every new start would answer
 *    409. The other writer of the same `seq` is an earlier attempt of this very task (the task is
 *    named per `seq`, and the queue runs one at a time) that the queue already gave up on: no retry
 *    of the task follows the last attempt, so leaving the job `executando` would leave it with
 *    nothing to carry it. Our own write found stored after a lost reply is never such a writer
 *    (`job.ts`, "Is it our write?"). Our own misconfiguration and coding bugs stay loud on every
 *    attempt. ⚠️ So does a STORAGE failure of a photo upload (`fotos.ts`: it propagates) — a
 *    deviation from the plan's "the queue's last attempt stamps `falhou/tentativas-esgotadas`": no
 *    class of the Storage client is reachable from this app to narrow on (rule 6 forbids testing
 *    the `Error` base or a duck-typed shape), so a persistent failure — a missing bucket grant —
 *    AND a transient one (a GCS 5xx or 429) that happens to hit the last attempt are rethrown there
 *    too and leave the job `executando` with nothing queued: every new start answers 409 until a
 *    person presses Cancelar (the card flags it after 45 min without progress). Closing it needs
 *    the Storage client's error class (or a guard for it) exported by `@delfrance/storage/admin`.
 *  - **A checkpoint that stops** on a job its fresh read finds ONE `seq` ahead, still
 *    `executando` — that earlier attempt ended its slice, and may never hand off — hands the named
 *    successor off as a courtesy ("Whose hand-off" below), on every attempt: the dispatch ends
 *    `continuacao`, or `parado` when the courtesy fails — never rethrown, never stamped.
 *
 * ## Whose hand-off (a job found ONE `seq` ahead, still `executando`)
 *
 * The end-of-dispatch checkpoint's writer OWNS the hand-off: it alone knows the delay (2 s for a
 * spent budget, 60 s for a 429 pause) and, once its slice is written, it alone carries the job. So a
 * dispatch keeps its own end patch and delay from BEFORE the write, and tells its landed checkpoint
 * from another dispatch's with `guardaOPatchLi` on the raw stored job (every patch carries this
 * dispatch's own ms stamp; `job.ts`, "Is it our write?"):
 *
 *  - **OURS** (the last attempt's re-read finds our patch whole at `seq + 1`) ⇒ our own hand-off,
 *    with OUR delay — so a 429 pause that landed behind an error still waits 60 s. If it fails, the
 *    usual ending rules apply, on the new `seq`: the valve closed ⇒ `tarefas-desligadas`; a
 *    transient failure ⇒ `tentativas-esgotadas` (normally nobody else carries it; the exception is
 *    the second residual below).
 *  - **ANOTHER dispatch's** (and ALWAYS a checkpoint that stops: our unit checkpoints never move
 *    `seq`, and our own landed end reads `gravado`) ⇒ a COURTESY: the named successor at the
 *    CONSERVATIVE 60 s. The owner normally enqueued already (ours is then already-exists, and the
 *    owner's delay stands); if ours wins the name, 60 s can never cut a pause short and only delays
 *    a budget end by 58 s. The dispatch never re-targets the stored `seq`, so nothing it does later
 *    can stamp a `seq` it never owned. A courtesy that fails never stamps and NEVER rethrows: the
 *    valve closed (the owner reads the same valve at its own hand-off) and a transient Cloud Tasks
 *    failure are both `parado`, on EVERY attempt. The courtesy is belt and braces — the owner, an
 *    earlier attempt of this same named task, owns its own hand-off — and a rethrow would give the
 *    job to this task's retry, whose continuation check takes the stored `seq` as its own (the
 *    REPAIR, below) and stamps it on the queue's last attempt when its enqueue fails as well.
 *  - **The REPAIR** (a task whose FIRST read finds its job already one `seq` ahead: the
 *    `continuacao` decision, "The order of one dispatch" step 3) ⇒ OUR hand-off on the stored `seq`,
 *    at the conservative 60 s, for it cannot know the owner's delay. Its failures end as ours do:
 *    the valve closed ⇒ `tarefas-desligadas`; a transient failure is rethrown, and on the queue's
 *    last attempt the stored `seq` is stamped `tentativas-esgotadas`. The common writer of that
 *    `seq` is this task's own earlier attempt that DIED after its end checkpoint (its enqueue failed
 *    and it rethrew, or it crashed), and a visible failure beats a silent hang.
 *
 * Both residuals below need two attempts of ONE named task acting on one job: the queue counted an
 * earlier attempt as failed while it still ran, or after it had acted (its reply lost, its instance
 * stalled or crashed after a write; the 100 s budget keeps a dispatch far inside the handler's
 * 300 s timeout, so a slow slice alone never causes it), and dispatched the next one.
 *
 * ⚠️ Accepted residual (stranded): the owner never enqueued — it died before its enqueue, OR its own
 * enqueue failed after the queue stopped listening (a transient failure, possibly the same Cloud
 * Tasks outage that fails the courtesy) — AND the courtesy failed (the valve closed, or a transient
 * failure, on ANY attempt: the courtesy ends its task, so no retry repairs it). The job sits
 * `executando` with nothing queued, and every new start answers 409 until a person presses
 * Cancelar — one write, which needs no worker (`job.ts`, the cancel), then a new start. This is a
 * trade made knowingly: a courtesy that rethrew would let this task's retry repair that case, but
 * the same retry's last attempt would then stamp a job whose owner DID hand off, the common case.
 *
 * ⚠️ Accepted residual (a healthy job stamped): a LAST attempt whose own hand-off fails transiently —
 * the repair's, or OUR landed end's — stamps the job `falhou/tentativas-esgotadas` even when another
 * attempt of this task had already enqueued the successor: the owner of the repaired `seq` (alive
 * or not — its reply lost, or crashed after its enqueue), or an earlier attempt still running whose
 * courtesy succeeded. The queued successor then reads a finished job and does nothing. One
 * transient failure of OURS suffices. In the common case nobody else enqueued, and a visible
 * failure beats a silent hang.
 *
 * ## The summary aviso
 *
 * The phase machine's own endings sync it before the terminal stamp (`aplicar` only): `concluido`,
 * and the `falhou` it decides itself (`limite-de-chamadas`, `catalogo-excede-limite`) — so a retry
 * of a stamp that failed re-syncs it. The refusals of the infrastructure (the switch, the conta,
 * the tasks valve, the last attempt) stamp the job only: its report stays on its card, and the
 * conta's next `aplicar` run raises what is still open.
 *
 * The decision to sync is the job's, so it is taken on a FRESH read: after the items are counted,
 * the job is re-read, and only one still running at this `seq` syncs — the stamp is then chained
 * from that read (a cancel during the count stops the dispatch with the aviso untouched).
 * ⚠️ Accepted residual: a Cancelar landing between that read and the stamp — the aviso's own few
 * writes — leaves the aviso synced by a job that then reads `cancelado` (the stamp loses its
 * precondition and writes nothing). Closing it would need the stamp first and the aviso after it,
 * with a flag a retried task could still act on once the job is terminal.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). The task path's run-time closure is walked with the read routes' rules:
 * Loja Integrada is reached through the context loader only.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import type { Bucket } from '@delfrance/storage/admin';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  LiAuthError,
  LiHttpError,
  LiNetworkError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
} from '@delfrance/integrations-loja-integrada';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  type ContadoresImportacaoLi,
  type DetalheImportacaoLi,
  ESTADO_DETALHE_IMPORTACAO_LI,
  FASE_IMPORTACAO_LI,
  type FaseImportacaoLi,
  type ImportacaoLojaIntegrada,
  MAX_PAUSAS_429_LI,
  MODO_IMPORTACAO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  type MotivoFalhaImportacaoLi,
  type ProgressoDaFamiliaLi,
  STATUS_IMPORTACAO_LI,
  TIPO_PAGINA_IMPORTACAO_LI,
  TIPO_TAREFA_IMPORTACAO_LI,
  type TarefaImportacaoLi,
  type TipoPaginaImportacaoLi,
  progressoDaFamiliaLiSchema,
  tarefaImportacaoLiSchema,
} from '@delfrance/schemas';
import { ZodError } from 'zod';

import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from '../core/contexto';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from '../core/erros';
import { tratarFalhaDeAutenticacao } from '../core/estacionamento';
import type { EscritorLogLi } from '../core/log';
import { ritmoDeLeituraLi } from '../core/ritmo';
import type { AmbienteLi } from '../core/valvulas';
import {
  ATRASO_CONTINUACAO_IMPORTACAO_LI_S,
  ATRASO_PAUSA_429_IMPORTACAO_LI_S,
  type AgendadorImportacaoLi,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
} from './agendadorImportacao';
import {
  type CategoriaSemVinculoLi,
  avisarCategoriaSemVinculoLi,
  resolverCategoriasSemVinculoLi,
  sincronizarAvisoDePendenciasLi,
  sincronizarAvisoDeRevisaoFiscalLi,
} from './avisosImportacao';
import { executarUnidadeDoCatalogoDoJobLi, unidadeDoCatalogoDoJobLi } from './catalogoDoJob';
import { avisoDaPendenciaDeCategoriaLi } from './categorias';
import {
  type DetalhesDeps,
  type ResultadoDetalheLi,
  lerDetalheParaOJobLi,
  lerDetalhesGravadosLi,
} from './detalhes';
import {
  UNIDADE_DAS_EVIDENCIAS_LI,
  executarUnidadeDasEvidenciasLi,
  lerEvidenciasDoJobLi,
} from './evidencias';
import {
  type CasamentoDaFamiliaLi,
  type ContextoDasFamiliasLi,
  type DepsFamiliaLi,
  alvosDeFotosDaFamiliaLi,
  comDetalhesLi,
  detalhesDaFamiliaLi,
  executarFamiliaLi,
  fecharFamiliaLi,
  resultadoFotosDoProgressoLi,
} from './familiaDoJob';
import {
  type FamiliaLi,
  type IndiceDoSnapshotLi,
  type MontagemLi,
  idsADetalharLi,
  indexarSnapshotLi,
  lerSnapshotDoJobLi,
  montarFamiliasLi,
  naoListadosLi,
  proximoOrfaoLi,
  unidadeDosOrfaosLi,
} from './familias';
import {
  type GuardarFotoLi,
  TIPO_PASSO_FOTOS_LI,
  criarGuardarFotoLi,
  deveImportarFotosLi,
  executarUnidadeDeFotoLi,
  resultadoDasFotosLi,
  unidadeDaFotoLi,
} from './fotos';
import {
  type MemoDeGruposLi,
  UNIDADE_DO_APRENDIZADO_LI,
  executarAprendizadoLi,
  gruposParaResolverLi,
  lerMemoDeGruposLi,
  recusasDoAprendizadoLi,
} from './gruposLi';
import {
  type AlvoDoDespachoLi,
  DECISAO_DESPACHO_LI,
  type DesfechoImportacaoLi,
  FLUXO_IMPORTACAO_LI,
  LiImportacaoConcorrenteError,
  type ProgressoImportacaoLi,
  type ReleituraLi,
  type ResultadoCheckpointLi,
  decidirDespachoLi,
  encerrarImportacaoLi,
  gravarCheckpointDaUnidadeLi,
  gravarCheckpointDoFimDoDespachoLi,
  guardaOPatchLi,
  lerJobLi,
  patchDoFimDoDespachoLi,
  relerJobLi,
} from './job';
import { type LeitorDeListasRevisaoLi, criarLeitorDeListasRevisaoLi } from './listaRevisaoFiscal';
import { executarUnidadeDaListaLi, unidadeDaListaLi } from './listagem';
import {
  type OrcamentoDespachoLi,
  PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS,
  UNIDADE_IMPORTACAO_LI,
  type UnidadeImportacaoLi,
  abrirOrcamentoLi,
} from './orcamento';
import {
  type ContagemAcionavelLi,
  contadoresDoItemLi,
  contarPendenciasAcionaveisLi,
  gravarItemLi,
  itemAvulsoLi,
  itemNaoListadoLi,
  somarContadoresLi,
} from './relatorio';
import { type ConflitoDeSkuNaLojaLi, conflitosDeSkuNaLojaLi } from './resolucao';
import {
  type LeitorDeRegrasImpostoLi,
  PASSO_REVISAO_FISCAL_LI,
  criarLeitorDeRegrasImpostoLi,
  executarUnidadeDaRevisaoFiscalLi,
  unidadeDaRevisaoFiscalLi,
} from './revisaoFiscal';

export { FLUXO_IMPORTACAO_LI };

/* -------------------------------------------------------------------------- */
/*                                  The contract                               */
/* -------------------------------------------------------------------------- */

/** The run's one sink for the lines a dispatch writes besides the queue's own (ids and counts). */
export interface LoggerDespachoImportacaoLi {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** Everything one dispatch needs — bound ONCE by the functions codebase (`depsImportacao.ts`). */
export interface DepsDespachoImportacaoLi {
  /** The process environment, passed whole — read by the context loader for the switch only. */
  readonly ambiente: AmbienteLi;
  /** The one clock, in ms: the budget, every stamp the job and its subcollections carry. */
  readonly agoraMs: () => number;
  /** The pacer's sleep (2 000 ms before every Loja Integrada call). */
  readonly esperar: (ms: number) => Promise<void>;
  /** A tier-0 `FieldValue.increment`, for the avisos' counters (the park's and the summary's). */
  readonly increment: (by: number) => unknown;
  /** The producer, built only when a hand-off is due (the tasks valve is read when it is built). */
  readonly agendador: () => AgendadorImportacaoLi;
  /**
   * The default bucket a "complete" run stores its photos in (`fotos.ts`), resolved only when asked;
   * `null` when nothing names one: the run's photos are skipped and the job is stamped
   * `fotosIndisponiveis`.
   */
  readonly bucket: () => Bucket | null;
  readonly logger: LoggerDespachoImportacaoLi;
  /** The Cloud Tasks attempt, 0-based (`req.retryCount`). */
  readonly tentativa: number;
  /** The Cloud Tasks task id, for the call lines; `null` when the request carried none. */
  readonly idTarefa: string | null;
  /** When THIS dispatch began, in ms on {@link agoraMs}'s clock: stamped by the handler first. */
  readonly inicioMs: number;
  /** Test seams, forwarded to the context. */
  readonly fetch?: typeof globalThis.fetch;
  readonly escrever?: EscritorLogLi;
}

/** How one dispatch ended (the queue's log line). */
export type DesfechoDespachoImportacaoLi =
  /** The budget was spent: end-of-dispatch checkpoint, named continuation 2 s later. */
  | 'continuado'
  /** A 429: end-of-dispatch checkpoint with one more pause, named continuation 60 s later. */
  | 'pausado'
  | 'concluido'
  | 'falhou'
  /**
   * A checkpoint or a stamp found the job cancelled, ended or moved on, or a courtesy hand-off
   * failed (never rethrown): this dispatch stopped.
   */
  | 'parado'
  /**
   * The successor of a job found one `seq` ahead was re-enqueued: by the continuation check (this
   * task had already checkpointed for it), by a checkpoint that stopped on it (a courtesy), or by
   * the last attempt (its own landed checkpoint, or a courtesy).
   */
  | 'continuacao'
  /** Nothing to do: a stale `seq`, a finished or cancelled job, no job, another conta's job. */
  | 'nada'
  /** A payload the task schema refuses: dropped, nothing read. */
  | 'payload-invalido';

/** Named members of {@link DesfechoDespachoImportacaoLi}. */
export const DESFECHO_DESPACHO_IMPORTACAO_LI = {
  continuado: 'continuado',
  pausado: 'pausado',
  concluido: 'concluido',
  falhou: 'falhou',
  parado: 'parado',
  continuacao: 'continuacao',
  nada: 'nada',
  payloadInvalido: 'payload-invalido',
} as const satisfies Record<string, DesfechoDespachoImportacaoLi>;

/** What one dispatch reports, for the functions codebase's ONE log line. Ids and counts only. */
export interface ResultadoDespachoImportacaoLi {
  readonly desfecho: DesfechoDespachoImportacaoLi;
  /** Set on `falhou` only. */
  readonly motivo: MotivoFalhaImportacaoLi | null;
  /** The job's phase when the dispatch ended; `null` when no job was read. */
  readonly fase: FaseImportacaoLi | null;
  /** Units run and checkpointed in this dispatch, and the Loja Integrada requests it sent. */
  readonly unidades: number;
  readonly chamadas: number;
}

/**
 * The phase after `familias` (module header, "The phases"): `revisao` for EVERY `aplicar` job, under
 * either action — the tax-review list is durable across jobs, and the carry-forward
 * (`revisaoFiscal.ts`) reads a CONCLUDED `aplicar` job as one that re-checked it, so a job that
 * concluded without the phase would hide every older open entry behind it; a "only link" job adds
 * no entry, but re-checks the list and closes the aviso once evidence arrived. `fim` under Simular,
 * which raises and resolves nothing.
 */
export function faseDepoisDasFamiliasLi(
  job: Pick<ImportacaoLojaIntegrada, 'modo' | 'acao'>,
): FaseImportacaoLi {
  return job.modo === MODO_IMPORTACAO_LI.aplicar
    ? FASE_IMPORTACAO_LI.revisao
    : FASE_IMPORTACAO_LI.fim;
}

/* -------------------------------------------------------------------------- */
/*                                   Failures                                  */
/* -------------------------------------------------------------------------- */

/** The conta's own refusals (the context loader's, and the credential getter's mid-run). */
function ehContaIndisponivel(err: unknown): boolean {
  return (
    err instanceof LiContaNaoEncontradaError ||
    err instanceof LiContaInativaError ||
    err instanceof LiCredencialAusenteError ||
    err instanceof LiCredencialInvalidaError ||
    err instanceof LiContaParadaError
  );
}

/**
 * Whether a failure that reached the queue's ladder ends the job `tentativas-esgotadas` on its LAST
 * attempt (module header, "Failures"): a class a retry could have changed. Anything else — our own
 * configuration, a coding bug — stays loud.
 */
function esgotaAsTentativas(err: unknown): boolean {
  return (
    // Another writer of the same `seq`: on the LAST attempt no retry of this task follows, and that
    // writer is an earlier attempt the queue already gave up on — nothing is left to carry the job.
    err instanceof LiImportacaoConcorrenteError ||
    err instanceof LiHttpError ||
    err instanceof LiNetworkError ||
    err instanceof LiSchemaError ||
    err instanceof LiPaginacaoError ||
    err instanceof LiTarefasTransitoriasError ||
    err instanceof LiEstacionamentoEmConflitoError ||
    err instanceof ZodError ||
    isGrpcStatusError(err)
  );
}

/**
 * The per-category aviso's rows of a job (module header, "The summary aviso"): one per store
 * category its items' own category refusals name (`avisoDaPendenciaDeCategoriaLi` over the job's
 * map), the products counted across every refusal naming it, in first-seen order. A refusal whose
 * category needs no row (a leaf the store's list lacks, unreadable URIs) gives none.
 */
export function categoriasSemVinculoDoJob(
  job: Pick<ImportacaoLojaIntegrada, 'mapaCategorias'>,
  categorias: NonNullable<ContagemAcionavelLi['categorias']>,
): CategoriaSemVinculoLi[] {
  const porId = new Map<number, CategoriaSemVinculoLi>();
  for (const c of categorias) {
    const aviso = avisoDaPendenciaDeCategoriaLi(job.mapaCategorias, c);
    if (aviso === null) continue;
    const antes = porId.get(aviso.categoriaLiId);
    porId.set(aviso.categoriaLiId, {
      categoriaLiId: aviso.categoriaLiId,
      caminho: antes?.caminho ?? aviso.caminho,
      motivo: antes?.motivo ?? aviso.motivo,
      produtos: (antes?.produtos ?? 0) + c.itens,
    });
  }
  return [...porId.values()];
}

/* -------------------------------------------------------------------------- */
/*                                   One unit                                  */
/* -------------------------------------------------------------------------- */

/** What one unit produced: progress to checkpoint, or the job's end. */
type PassoDoDespachoLi =
  | { readonly tipo: 'progresso'; readonly progresso: ProgressoImportacaoLi }
  | { readonly tipo: 'encerrar'; readonly desfecho: DesfechoImportacaoLi };

/** The next unit: its cost (the budget's question) and how to run it. */
interface UnidadeDoDespachoLi {
  readonly unidade: UnidadeImportacaoLi;
  executar(): Promise<PassoDoDespachoLi>;
}

const FAMILIAS_DO_INICIO: ImportacaoLojaIntegrada['familias'] = {
  cursorPaiId: null,
  filhosLidos: [],
};

/** Whether a unit budgeted as `orcada` covers work whose worst case is `custo`'s. */
function cobre(orcada: UnidadeImportacaoLi, custo: UnidadeImportacaoLi): boolean {
  return PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS[custo] <= PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS[orcada];
}

/**
 * The end-of-dispatch checkpoint THIS dispatch sent, kept from BEFORE its write (module header,
 * "Whose hand-off"): the `seq` it ran at, its patch as written and the delay its own hand-off carries.
 */
interface FimProprioLi {
  readonly seq: number;
  readonly patch: Partial<ImportacaoLojaIntegrada>;
  readonly atrasoS: number;
}

const progresso = (p: ProgressoImportacaoLi): PassoDoDespachoLi => ({
  tipo: 'progresso',
  progresso: p,
});

/** The stored detail a read leaves (what `detalhes.ts` writes), for the in-memory assembly. */
function detalheGravadoDoResultado(
  liId: number,
  r: ResultadoDetalheLi,
  agoraMs: number,
): DetalheImportacaoLi | null {
  if (r.tipo === 'lido') {
    return {
      liId,
      estado: ESTADO_DETALHE_IMPORTACAO_LI.lido,
      detalhe: r.detalhe,
      lidoEmMs: agoraMs,
    };
  }
  if (r.tipo === 'inexistente') {
    return {
      liId,
      estado: ESTADO_DETALHE_IMPORTACAO_LI.inexistente,
      detalhe: null,
      lidoEmMs: agoraMs,
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                 The dispatch                                */
/* -------------------------------------------------------------------------- */

/**
 * One dispatch of the import (module header). Deterministic endings RETURN; a failure the queue
 * should retry THROWS (on the last attempt, it is stamped instead).
 */
export async function despacharImportacaoLi(
  db: Firestore,
  dados: unknown,
  deps: DepsDespachoImportacaoLi,
): Promise<ResultadoDespachoImportacaoLi> {
  const lido = tarefaImportacaoLiSchema.safeParse(dados);
  if (!lido.success) {
    return {
      desfecho: DESFECHO_DESPACHO_IMPORTACAO_LI.payloadInvalido,
      motivo: null,
      fase: null,
      unidades: 0,
      chamadas: 0,
    };
  }
  const despacho = new DespachoImportacaoLi(db, lido.data, deps);
  try {
    return await despacho.executar();
  } catch (err) {
    // Every attempt but the queue's LAST rethrows: Cloud Tasks retries the same task.
    if (deps.tentativa < TASK_MAX_ATTEMPTS - 1) throw err;
    return despacho.naUltimaTentativa(err);
  }
}

/** The state of ONE dispatch: the job as last written, its chained precondition, its memos. */
class DespachoImportacaoLi {
  private readonly orcamento: OrcamentoDespachoLi;
  private job: ImportacaoLojaIntegrada | null = null;
  /** The job document's own `createTime`, from the dispatch's first job read (never re-derived). */
  private criacaoDoJob: Timestamp | null = null;
  /** Where this dispatch writes: the job's CURRENT `seq` and the last write's stamp. */
  private alvo: AlvoDoDespachoLi | null = null;
  private contexto: ContextoLojaIntegrada | null = null;
  /** This dispatch's own end-of-dispatch checkpoint, once sent ({@link FimProprioLi}). */
  private fimProprio: FimProprioLi | null = null;
  private unidades = 0;
  private chamadas = 0;

  // Read once per dispatch, lazily (module header).
  private indice: IndiceDoSnapshotLi | null = null;
  /** Every id the assembly needs a detail of: the `orfaos` phase's list (`idsADetalharLi`). */
  private aDetalhar: readonly number[] | null = null;
  private detalhes: Map<number, DetalheImportacaoLi> | null = null;
  private montagem: MontagemLi | null = null;
  private skusEmConflito: ReadonlyMap<string, ConflitoDeSkuNaLojaLi> | null = null;
  private memo: MemoDeGruposLi | null = null;
  private recusas: ContextoDasFamiliasLi['recusasDoAprendizado'] | null = null;
  /** The details the complete step still has to read for the family it is on (ids, in order). */
  private faltantes: { readonly raizLiId: number; readonly ids: readonly number[] } | null = null;
  /** The stored details already looked up for the complete step this dispatch (by id). */
  private readonly detalhesProcurados = new Set<number>();
  /** The photo upload seam, once the bucket was asked for (`undefined` until then). */
  private guardar: GuardarFotoLi | null | undefined = undefined;
  /** The tax rules, read at most once per dispatch (`revisaoFiscal.ts`). */
  private regras: LeitorDeRegrasImpostoLi | null = null;
  /** The jobs' tax-review lists, each read whole at most once per dispatch (`revisaoFiscal.ts`). */
  private listasRevisao: LeitorDeListasRevisaoLi | null = null;
  /**
   * A photo upload outlived its deadline (`fotos.ts`, `parar`): no more unit in this dispatch — the
   * end-of-dispatch checkpoint and the continuation follow at once.
   */
  private encerrarAgora = false;

  constructor(
    private readonly db: Firestore,
    private readonly tarefa: TarefaImportacaoLi,
    private readonly deps: DepsDespachoImportacaoLi,
  ) {
    this.orcamento = abrirOrcamentoLi(deps.agoraMs, deps.inicioMs);
  }

  private resultado(
    desfecho: DesfechoDespachoImportacaoLi,
    motivo: MotivoFalhaImportacaoLi | null = null,
  ): ResultadoDespachoImportacaoLi {
    return {
      desfecho,
      motivo,
      fase: this.job?.fase ?? null,
      unidades: this.unidades,
      chamadas: this.chamadas,
    };
  }

  /* ---------------------------------- the run --------------------------------- */

  async executar(): Promise<ResultadoDespachoImportacaoLi> {
    const lido = await lerJobLi(this.db, this.tarefa.jobId);
    if (lido === null || lido.job.integracaoId !== this.tarefa.contaId) {
      return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.nada);
    }
    this.job = lido.job;
    this.criacaoDoJob = lido.criacao;
    const decisao = decidirDespachoLi(lido.job, this.tarefa.seq);
    if (decisao === DECISAO_DESPACHO_LI.nada) {
      return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.nada);
    }
    // From here on, every write is preconditioned on the job's CURRENT seq and on this read.
    this.alvo = { jobId: this.tarefa.jobId, seq: lido.job.seq, versao: lido.versao };
    if (decisao === DECISAO_DESPACHO_LI.continuacao) {
      // The REPAIR of a hand-off that may never have happened: it cannot tell a budget end from a
      // 429 pause, so the conservative 60 s, which never cuts a pause short (module header, step 3).
      return this.entregar(
        ATRASO_PAUSA_429_IMPORTACAO_LI_S,
        DESFECHO_DESPACHO_IMPORTACAO_LI.continuacao,
      );
    }

    // FIRST: the read switch, then the conta and its credential (module header, step 4).
    try {
      this.contexto = await loadLojaIntegradaContext(this.db, this.tarefa.contaId, {
        ambiente: this.deps.ambiente,
        ritmo: ritmoDeLeituraLi(this.deps.esperar),
        registro: {
          fluxo: FLUXO_IMPORTACAO_LI,
          tentativa: this.deps.tentativa,
          idTarefa: this.deps.idTarefa,
          escrever: this.deps.escrever,
        },
        // Told before EVERY request the client sends (after the pacer): the dispatch's call count.
        aoUsarCredencial: () => {
          this.chamadas += 1;
        },
        fetch: this.deps.fetch,
      });
    } catch (err) {
      if (err instanceof LiChamadasDesligadasError) {
        return this.encerrar(
          {
            status: STATUS_IMPORTACAO_LI.falhou,
            motivo: MOTIVO_FALHA_IMPORTACAO_LI.chamadasDesligadas,
          },
          false,
        );
      }
      if (ehContaIndisponivel(err)) {
        return this.encerrar(
          {
            status: STATUS_IMPORTACAO_LI.falhou,
            motivo: MOTIVO_FALHA_IMPORTACAO_LI.contaIndisponivel,
          },
          false,
        );
      }
      throw err;
    }

    for (;;) {
      const proxima = this.proximaUnidade();
      if (this.encerrarAgora || !this.orcamento.cabe(proxima.unidade)) {
        return this.fimDoDespacho(
          {},
          ATRASO_CONTINUACAO_IMPORTACAO_LI_S,
          DESFECHO_DESPACHO_IMPORTACAO_LI.continuado,
        );
      }
      let passo: PassoDoDespachoLi;
      try {
        passo = await proxima.executar();
      } catch (err) {
        const parada = await this.tratarFalhaDaUnidade(err);
        if (parada === null) throw err;
        return parada;
      }
      if (passo.tipo === 'encerrar') return this.encerrar(passo.desfecho, true);

      const agora = this.deps.agoraMs();
      const r = await gravarCheckpointDaUnidadeLi(
        this.db,
        this.alvoAtual(),
        passo.progresso,
        agora,
      );
      this.unidades += 1;
      if (r.tipo === 'parar') return this.aoParar(r);
      this.alvo = { ...this.alvoAtual(), versao: r.versao };
      this.job = {
        ...this.jobAtual(),
        ...passo.progresso,
        status: STATUS_IMPORTACAO_LI.executando,
        atualizadoEmMs: agora,
      };
    }
  }

  private jobAtual(): ImportacaoLojaIntegrada {
    if (this.job === null) throw new TypeError('despacho: o job ainda não foi lido');
    return this.job;
  }

  private criacaoDoJobAtual(): Timestamp {
    if (this.criacaoDoJob === null) throw new TypeError('despacho: o job ainda não foi lido');
    return this.criacaoDoJob;
  }

  private alvoAtual(): AlvoDoDespachoLi {
    if (this.alvo === null) throw new TypeError('despacho: o alvo ainda não foi lido');
    return this.alvo;
  }

  private contextoAtual(): ContextoLojaIntegrada {
    if (this.contexto === null) throw new TypeError('despacho: o contexto ainda não foi carregado');
    return this.contexto;
  }

  /* --------------------------- the unit's failures --------------------------- */

  /**
   * A unit's failure the dispatch answers itself (module header, "Failures"); `null` = rethrow the
   * original error.
   */
  private async tratarFalhaDaUnidade(err: unknown): Promise<ResultadoDespachoImportacaoLi | null> {
    if (err instanceof LiThrottleError) {
      const job = this.jobAtual();
      if (job.pausas429 >= MAX_PAUSAS_429_LI) {
        return this.encerrar(
          {
            status: STATUS_IMPORTACAO_LI.falhou,
            motivo: MOTIVO_FALHA_IMPORTACAO_LI.limiteDeChamadas,
          },
          true,
        );
      }
      return this.fimDoDespacho(
        { pausas429: job.pausas429 + 1 },
        ATRASO_PAUSA_429_IMPORTACAO_LI_S,
        DESFECHO_DESPACHO_IMPORTACAO_LI.pausado,
      );
    }
    if (err instanceof LiAuthError) return this.recusaDaCredencial(err);
    if (ehContaIndisponivel(err)) {
      return this.encerrar(
        {
          status: STATUS_IMPORTACAO_LI.falhou,
          motivo: MOTIVO_FALHA_IMPORTACAO_LI.contaIndisponivel,
        },
        false,
      );
    }
    return null;
  }

  /** A 401/403: park the conta like every reader does, then answer by what the park found. */
  private async recusaDaCredencial(
    err: LiAuthError,
  ): Promise<ResultadoDespachoImportacaoLi | null> {
    const contexto = this.contextoAtual();
    try {
      const { estacionamento } = await tratarFalhaDeAutenticacao(
        this.db,
        { integracaoId: contexto.integracaoId, lojaNome: this.lojaNome() },
        err,
        { agoraMs: this.deps.agoraMs, increment: this.deps.increment, logger: this.deps.logger },
      );
      // No usable ref, or a refusal of an OLDER token: the retry runs with the token now stored.
      if (estacionamento === null || estacionamento.tipo === 'credencial-substituida') return null;
    } catch (falha) {
      // A credential found corrupt while parking: the conta cannot be read from, like a refusal.
      if (!(falha instanceof LiCredencialInvalidaError)) throw falha;
    }
    return this.encerrar(
      { status: STATUS_IMPORTACAO_LI.falhou, motivo: MOTIVO_FALHA_IMPORTACAO_LI.contaIndisponivel },
      false,
    );
  }

  /**
   * The queue's LAST attempt (module header, "Failures"): for a failure a retry could have changed,
   * the job is RE-READ first (raw, so "is it our write?" can be asked), since a write of this
   * dispatch may have landed behind the error. One found ONE `seq` ahead, still `executando`, has its
   * named successor handed off from that read — what the retry's continuation check would have done
   * — by WHOSE checkpoint put it there (module header, "Whose hand-off"): OUR landed end-of-dispatch
   * checkpoint ⇒ our own hand-off, with our delay, and a failing one stamps the new `seq` (normally
   * nobody else carries it; the module header's second residual is the exception); another
   * dispatch's ⇒ a courtesy, never a stamp. One still running at this
   * dispatch's `seq` is stamped `falhou/tentativas-esgotadas`, chained from that read (a cancel that
   * won is never overwritten); anything else is left alone. Any other failure is rethrown.
   */
  async naUltimaTentativa(err: unknown): Promise<ResultadoDespachoImportacaoLi> {
    if (!esgotaAsTentativas(err) || this.alvo === null) throw err;
    const relido = await relerJobLi(this.db, this.alvo.jobId);
    if (relido === null) return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.parado);
    const { lido } = relido;
    const decisao = decidirDespachoLi(lido.job, this.alvo.seq);
    if (decisao === DECISAO_DESPACHO_LI.nada) {
      return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.parado);
    }
    if (decisao === DECISAO_DESPACHO_LI.continuacao) {
      const fim = this.nossoFimArmazenado(relido);
      if (fim === null) return this.entregarPorCortesia(lido.job);
      // OUR end-of-dispatch checkpoint landed behind the error: the hand-off is ours, on the
      // stored `seq`, chained from this read, with the delay that checkpoint was written for.
      this.job = lido.job;
      this.alvo = { jobId: this.alvo.jobId, seq: lido.job.seq, versao: lido.versao };
      try {
        // The valve closed is answered inside (`tarefas-desligadas`), as at every hand-off of ours.
        return await this.entregar(fim.atrasoS, DESFECHO_DESPACHO_IMPORTACAO_LI.continuacao);
      } catch (falha) {
        // Our hand-off failed as well, and no retry follows: the job's NEW seq is stamped, as for
        // any failure after our end-of-dispatch checkpoint — never `executando` with nothing queued.
        if (!esgotaAsTentativas(falha)) throw falha;
        return this.esgotarTentativas();
      }
    }
    this.alvo = { ...this.alvo, versao: lido.versao };
    return this.esgotarTentativas();
  }

  /**
   * This dispatch's own end-of-dispatch checkpoint when the RAW stored job holds it whole
   * (`guardaOPatchLi`: every patch carries this dispatch's own ms stamp), written at the `seq` this
   * dispatch still targets; `null` when the job one `seq` ahead is another dispatch's.
   */
  private nossoFimArmazenado(relido: ReleituraLi): FimProprioLi | null {
    const fim = this.fimProprio;
    if (fim === null || fim.seq !== this.alvoAtual().seq) return null;
    return guardaOPatchLi(relido.dados, fim.patch) ? fim : null;
  }

  /** Stamp `falhou/tentativas-esgotadas` on the dispatch's current `seq`, chained from its alvo. */
  private async esgotarTentativas(): Promise<ResultadoDespachoImportacaoLi> {
    const r = await encerrarImportacaoLi(
      this.db,
      this.alvoAtual(),
      {
        status: STATUS_IMPORTACAO_LI.falhou,
        motivo: MOTIVO_FALHA_IMPORTACAO_LI.tentativasEsgotadas,
      },
      this.deps.agoraMs(),
    );
    return r.tipo === 'encerrado'
      ? this.resultado(
          DESFECHO_DESPACHO_IMPORTACAO_LI.falhou,
          MOTIVO_FALHA_IMPORTACAO_LI.tentativasEsgotadas,
        )
      : this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.parado);
  }

  /* ------------------------------ the endings ------------------------------- */

  /** The operator-facing store name, for the avisos; the id only for a conta with no name. */
  private lojaNome(): string {
    const contexto = this.contextoAtual();
    return contexto.conta.nome === '' ? contexto.integracaoId : contexto.conta.nome;
  }

  /**
   * Stamp the job (module header): `concluido`, or `falhou` with its motivo. `aviso` syncs the
   * summary aviso FIRST (an `aplicar` job ended by the phase machine itself) — and only on a job
   * the dispatch has just RE-READ still running at its `seq`, the stamp then chained from that very
   * read: a cancel that landed while the items were counted is seen there, and the job raises and
   * resolves nothing (module header, "The summary aviso").
   */
  private async encerrar(
    desfecho: DesfechoImportacaoLi,
    aviso: boolean,
  ): Promise<ResultadoDespachoImportacaoLi> {
    const job = this.jobAtual();
    const agora = this.deps.agoraMs();
    if (aviso && job.modo === MODO_IMPORTACAO_LI.aplicar) {
      const contagem = await contarPendenciasAcionaveisLi(this.db, this.tarefa.jobId);
      const alvo = this.alvoAtual();
      const lido = await lerJobLi(this.db, alvo.jobId);
      if (lido === null || decidirDespachoLi(lido.job, alvo.seq) !== DECISAO_DESPACHO_LI.executar) {
        return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.parado);
      }
      this.alvo = { ...alvo, versao: lido.versao };
      await sincronizarAvisoDePendenciasLi(
        this.db,
        {
          jobId: this.tarefa.jobId,
          integracaoId: job.integracaoId,
          lojaNome: this.lojaNome(),
          modo: job.modo,
          alvo: job.alvo,
          status: desfecho.status,
          fimMs: agora,
        },
        contagem,
        { increment: this.deps.increment, nowMs: agora, logger: this.deps.logger },
      );
      // The per-category rows of the categories this job left products without (the complete
      // step's, `categorias.ts`), from the items' own refusals: the job keeps no tally of them.
      for (const categoria of categoriasSemVinculoDoJob(job, contagem.categorias ?? [])) {
        await avisarCategoriaSemVinculoLi(
          this.db,
          {
            jobId: this.tarefa.jobId,
            integracaoId: job.integracaoId,
            lojaNome: this.lojaNome(),
            modo: job.modo,
            fimMs: agora,
          },
          categoria,
          { increment: this.deps.increment, nowMs: agora, logger: this.deps.logger },
        );
      }
    }
    const r = await encerrarImportacaoLi(this.db, this.alvoAtual(), desfecho, agora);
    if (r.tipo !== 'encerrado') return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.parado);
    this.job = { ...job, status: desfecho.status };
    return desfecho.status === STATUS_IMPORTACAO_LI.falhou
      ? this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.falhou, desfecho.motivo)
      : this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.concluido);
  }

  /** The end-of-dispatch checkpoint (`seq + 1`), then the named hand-off (module header, step 6). */
  private async fimDoDespacho(
    progressoFinal: ProgressoImportacaoLi,
    atrasoS: number,
    desfecho: DesfechoDespachoImportacaoLi,
  ): Promise<ResultadoDespachoImportacaoLi> {
    const agora = this.deps.agoraMs();
    const alvo = this.alvoAtual();
    // Kept BEFORE the write: it may land behind an error the last attempt then answers.
    this.fimProprio = {
      seq: alvo.seq,
      patch: patchDoFimDoDespachoLi(alvo, progressoFinal, agora),
      atrasoS,
    };
    const r = await gravarCheckpointDoFimDoDespachoLi(this.db, alvo, progressoFinal, agora);
    // Lost to another writer (our own landed write reads `gravado`): never ours to hand off.
    if (r.tipo === 'parar') return this.aoParar(r);
    // The job now runs at seq + 1: the hand-off, a valve stamp and a last-attempt stamp target it.
    this.alvo = { jobId: alvo.jobId, seq: alvo.seq + 1, versao: r.versao };
    this.job = {
      ...this.jobAtual(),
      ...progressoFinal,
      status: STATUS_IMPORTACAO_LI.executando,
      seq: alvo.seq + 1,
      atualizadoEmMs: agora,
    };
    return this.entregar(atrasoS, desfecho);
  }

  /**
   * A checkpoint that lost and STOPPED (`job.ts`, "A lost checkpoint is never re-applied"). A job
   * its fresh read found ONE `seq` ahead, still `executando`, is another dispatch of this `seq` that
   * ended its slice — never this one (our own landed write reads `gravado`, and a unit checkpoint
   * never moves `seq`) — and that one may never hand off (the queue gave up on it, or its enqueue
   * failed after the queue stopped listening): its named successor is handed off as a COURTESY.
   * Anything else — cancelled, ended, gone, further on — is `parado`.
   */
  private async aoParar(
    r: Extract<ResultadoCheckpointLi, { readonly tipo: 'parar' }>,
  ): Promise<ResultadoDespachoImportacaoLi> {
    if (
      r.job === null ||
      decidirDespachoLi(r.job, this.alvoAtual().seq) !== DECISAO_DESPACHO_LI.continuacao
    ) {
      return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.parado);
    }
    return this.entregarPorCortesia(r.job);
  }

  /**
   * A COURTESY hand-off (module header, "Whose hand-off"): the named successor of a job ANOTHER
   * dispatch of this `seq` moved one `seq` ahead. That dispatch owns the hand-off and normally made
   * it, so this one never targets the stored `seq` (`this.alvo` is left alone: nothing later can
   * decide to stamp a `seq` this dispatch never owned) and enqueues with the CONSERVATIVE 60 s — an
   * existing task is success and the owner's delay stands; a name ours wins can never cut a 429
   * pause short, and delays a budget end by 58 s at most. Its failures never stamp and never
   * rethrow: the valve closed (the owner reads the same valve at its own hand-off) and a transient
   * Cloud Tasks failure are `parado` on EVERY attempt. A rethrow would hand the job to this task's
   * retry, whose continuation check carries the stored `seq` as its own and, on the queue's last
   * attempt, stamps it when its enqueue fails as well — a healthy job the other dispatch carries.
   * Anything else the producer rethrows (a broken deploy, a coding bug) stays loud.
   */
  private async entregarPorCortesia(
    job: ImportacaoLojaIntegrada,
  ): Promise<ResultadoDespachoImportacaoLi> {
    try {
      await this.deps
        .agendador()
        .enfileirar(this.sucessorEm(job.seq), { atrasoS: ATRASO_PAUSA_429_IMPORTACAO_LI_S });
    } catch (err) {
      if (err instanceof LiTarefasDesligadasError || err instanceof LiTarefasTransitoriasError) {
        return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.parado);
      }
      throw err;
    }
    this.job = job;
    return this.resultado(DESFECHO_DESPACHO_IMPORTACAO_LI.continuacao);
  }

  /** The named task of the job's dispatch at `seq`. */
  private sucessorEm(seq: number): TarefaImportacaoLi {
    return {
      tipo: TIPO_TAREFA_IMPORTACAO_LI,
      contaId: this.tarefa.contaId,
      jobId: this.alvoAtual().jobId,
      seq,
    };
  }

  /**
   * OUR hand-off: enqueue the NAMED dispatch the job's current `seq` names, a `seq` this dispatch
   * owns (it wrote it, or this task's continuation check read it). An existing one is success (the
   * producer's rule); the valve closed stamps the job `falhou/tarefas-desligadas`; a transient
   * Cloud Tasks failure is rethrown, and the retry's continuation check enqueues it again.
   */
  private async entregar(
    atrasoS: number,
    desfecho: DesfechoDespachoImportacaoLi,
  ): Promise<ResultadoDespachoImportacaoLi> {
    try {
      await this.deps.agendador().enfileirar(this.sucessorEm(this.alvoAtual().seq), { atrasoS });
    } catch (err) {
      if (!(err instanceof LiTarefasDesligadasError)) throw err;
      return this.encerrar(
        {
          status: STATUS_IMPORTACAO_LI.falhou,
          motivo: MOTIVO_FALHA_IMPORTACAO_LI.tarefasDesligadas,
        },
        false,
      );
    }
    return this.resultado(desfecho);
  }

  /* --------------------------------- the memos --------------------------------- */

  private async indiceDoSnapshot(): Promise<IndiceDoSnapshotLi> {
    if (this.indice === null) {
      this.indice = indexarSnapshotLi(await lerSnapshotDoJobLi(this.db, this.tarefa.jobId));
    }
    return this.indice;
  }

  private async aDetalharDoSnapshot(): Promise<readonly number[]> {
    this.aDetalhar ??= idsADetalharLi(await this.indiceDoSnapshot());
    return this.aDetalhar;
  }

  /** The assembly, from the snapshot and the stored details; rebuilt after a detail read here. */
  private async montagemDoJob(): Promise<MontagemLi> {
    const indice = await this.indiceDoSnapshot();
    if (this.detalhes === null) {
      this.detalhes = await lerDetalhesGravadosLi(
        this.db,
        this.tarefa.jobId,
        await this.aDetalharDoSnapshot(),
      );
      this.montagem = null;
    }
    if (this.montagem === null) {
      this.montagem = montarFamiliasLi(indice, this.detalhes);
      this.skusEmConflito = conflitosDeSkuNaLojaLi(this.montagem);
    }
    return this.montagem;
  }

  private async skusEmConflitoDoJob(): Promise<ReadonlyMap<string, ConflitoDeSkuNaLojaLi>> {
    await this.montagemDoJob();
    if (this.skusEmConflito === null) throw new TypeError('despacho: montagem sem SKUs');
    return this.skusEmConflito;
  }

  private async memoDeGrupos(): Promise<MemoDeGruposLi> {
    this.memo ??= await lerMemoDeGruposLi(this.db);
    return this.memo;
  }

  /** A detail this dispatch read joins the in-memory assembly as it was stored. */
  private registrarDetalhe(liId: number, r: ResultadoDetalheLi | null): void {
    if (this.detalhes === null || r === null) return;
    const gravado = detalheGravadoDoResultado(liId, r, this.deps.agoraMs());
    if (gravado === null) return;
    this.detalhes.set(liId, gravado);
    this.montagem = null;
  }

  private depsDosDetalhes(): DetalhesDeps {
    return {
      db: this.db,
      cliente: this.contextoAtual().cliente,
      jobId: this.tarefa.jobId,
      agoraMs: this.deps.agoraMs,
    };
  }

  /**
   * One product's detail, with a body off its schema CONTAINED (module header, "Failures"): the
   * product has no usable detail, logged; `null` stands for it. Only a body that ANSWERED and is
   * off the schema (`formato`) is one bad product: an empty or non-JSON 200 is the transport's (a
   * gateway's page), rethrown so the queue's retry reads the detail again — never "no usable
   * detail" for the rest of the job.
   */
  private async lerDetalheContido(liId: number): Promise<ResultadoDetalheLi | null> {
    try {
      return await lerDetalheParaOJobLi(this.depsDosDetalhes(), liId);
    } catch (err) {
      if (!(err instanceof LiSchemaError) || err.motivo !== 'formato') throw err;
      this.deps.logger.warn(
        '[loja-integrada] importação: detalhe fora do formato; produto sem detalhe utilizável',
        {
          jobId: this.tarefa.jobId,
          liId,
          motivo: err.motivo,
          campos: [...err.campos],
          correlationId: err.correlationId,
        },
      );
      return null;
    }
  }

  /**
   * ONE WARN line when a read unit SKIPPED something (`contagens` holds a count above zero): rows with
   * no usable id, rows whose own `removido` contradicts their list, category rows the projection
   * could not read, category links whose owner is gone or is not a categoria. Ids and counts only;
   * a read that skipped nothing logs nothing.
   */
  private avisarSeSaltou(
    leitura: string,
    contagens: Readonly<Record<string, string | number>>,
  ): void {
    if (!Object.values(contagens).some((n) => typeof n === 'number' && n > 0)) return;
    this.deps.logger.warn('[loja-integrada] importação: leitura com linhas ignoradas', {
      jobId: this.tarefa.jobId,
      leitura,
      ...contagens,
    });
  }

  /* ------------------------------ the next unit ------------------------------ */

  private proximaUnidade(): UnidadeDoDespachoLi {
    const job = this.jobAtual();
    switch (job.fase) {
      case FASE_IMPORTACAO_LI.catalogo:
        return this.unidadeDoCatalogo(job);
      case FASE_IMPORTACAO_LI.listagem:
        return this.unidadeDaLista(job, TIPO_PAGINA_IMPORTACAO_LI.listagem);
      case FASE_IMPORTACAO_LI.lixeira:
        return this.unidadeDaLista(job, TIPO_PAGINA_IMPORTACAO_LI.lixeira);
      case FASE_IMPORTACAO_LI.orfaos:
        return this.unidadeDosOrfaos(job);
      case FASE_IMPORTACAO_LI.evidencias:
        return this.unidadeDasEvidencias(job);
      case FASE_IMPORTACAO_LI.aprendizado:
        return this.unidadeDoAprendizado(job);
      case FASE_IMPORTACAO_LI.familias:
        return this.unidadeDasFamilias(job);
      case FASE_IMPORTACAO_LI.revisao:
        return this.unidadeDaRevisao(job);
      case FASE_IMPORTACAO_LI.fim:
        return {
          unidade: UNIDADE_IMPORTACAO_LI.familia,
          executar: () =>
            Promise.resolve<PassoDoDespachoLi>({
              tipo: 'encerrar',
              desfecho: { status: STATUS_IMPORTACAO_LI.concluido },
            }),
        };
    }
  }

  private unidadeDoCatalogo(job: ImportacaoLojaIntegrada): UnidadeDoDespachoLi {
    return {
      unidade: unidadeDoCatalogoDoJobLi(job.catalogo),
      executar: async () => {
        const contexto = this.contextoAtual();
        const passo = await executarUnidadeDoCatalogoDoJobLi(
          { db: this.db, cliente: contexto.cliente, contaId: job.integracaoId },
          { catalogo: job.catalogo, mapaCategorias: job.mapaCategorias, marcas: job.marcas },
        );
        if (passo.tipo === 'falhou') {
          return {
            tipo: 'encerrar',
            desfecho: { status: STATUS_IMPORTACAO_LI.falhou, motivo: passo.motivo },
          };
        }
        if (passo.tipo === 'pagina') {
          this.avisarSeSaltou('catalogo', {
            recurso: passo.recurso,
            correlationId: passo.correlationId,
            ...passo.naoLidas,
          });
          return progresso({ ...passo.estado });
        }
        this.avisarSeSaltou('vinculos-de-categoria', {
          donosAusentes: passo.vinculos.donosAusentes,
          foraDeCategorias: passo.vinculos.foraDeCategorias,
        });
        // The catalogue is whole: an `aplicar` job resolves the per-category avisos it can.
        await resolverCategoriasSemVinculoLi(
          this.db,
          { integracaoId: job.integracaoId, modo: job.modo },
          passo.estado.mapaCategorias,
          { nowMs: this.deps.agoraMs() },
        );
        return progresso({ ...passo.estado, fase: FASE_IMPORTACAO_LI.listagem });
      },
    };
  }

  private unidadeDaLista(
    job: ImportacaoLojaIntegrada,
    tipo: TipoPaginaImportacaoLi,
  ): UnidadeDoDespachoLi {
    const lixeira = tipo === TIPO_PAGINA_IMPORTACAO_LI.lixeira;
    const cursor = lixeira ? job.lixeira : job.listagem;
    return {
      unidade: unidadeDaListaLi(cursor),
      executar: async () => {
        const passo = await executarUnidadeDaListaLi(
          {
            db: this.db,
            cliente: this.contextoAtual().cliente,
            jobId: this.tarefa.jobId,
            agoraMs: this.deps.agoraMs,
          },
          tipo,
          cursor,
        );
        const campo = lixeira ? { lixeira: passo.cursor } : { listagem: passo.cursor };
        if (passo.tipo === 'pagina') {
          this.avisarSeSaltou(tipo, {
            correlationId: passo.correlationId,
            semId: passo.contagem.semId,
            foraDoFiltro: passo.contagem.foraDoFiltro,
          });
          return progresso(campo);
        }
        return progresso({
          ...campo,
          fase: lixeira ? FASE_IMPORTACAO_LI.orfaos : FASE_IMPORTACAO_LI.lixeira,
        });
      },
    };
  }

  private unidadeDosOrfaos(job: ImportacaoLojaIntegrada): UnidadeDoDespachoLi {
    // The cost needs the list; the list needs the snapshot — read lazily in `executar`, and
    // budgeted as a call until known (the worst case of either answer). The list is every id the
    // assembly needs a detail of — the orphans AND the claimed ids never listed — so every family
    // is matched over a whole assembly (`idsADetalharLi`).
    const aDetalhar = this.aDetalhar;
    const unidade =
      aDetalhar === null
        ? UNIDADE_IMPORTACAO_LI.chamada
        : unidadeDosOrfaosLi(aDetalhar, job.orfaos);
    return {
      unidade,
      executar: async () => {
        const lista = await this.aDetalharDoSnapshot();
        const liId = proximoOrfaoLi(lista, job.orfaos);
        if (liId === null) {
          return progresso({ fase: FASE_IMPORTACAO_LI.evidencias, familias: FAMILIAS_DO_INICIO });
        }
        this.registrarDetalhe(liId, await this.lerDetalheContido(liId));
        return progresso({ orfaos: { cursorLiId: liId } });
      },
    };
  }

  private unidadeDasEvidencias(job: ImportacaoLojaIntegrada): UnidadeDoDespachoLi {
    return {
      unidade: UNIDADE_DAS_EVIDENCIAS_LI,
      executar: async () => {
        const passo = await executarUnidadeDasEvidenciasLi(
          { db: this.db, contaId: job.integracaoId, jobId: this.tarefa.jobId },
          {
            montagem: await this.montagemDoJob(),
            // The memo alone: nothing is learned before the next phase.
            grupos: await this.memoDeGrupos(),
            skusEmConflito: await this.skusEmConflitoDoJob(),
          },
          job.familias,
        );
        if (passo.tipo === 'familia') return progresso({ familias: passo.familias });
        return progresso({ fase: FASE_IMPORTACAO_LI.aprendizado, familias: FAMILIAS_DO_INICIO });
      },
    };
  }

  private unidadeDoAprendizado(job: ImportacaoLojaIntegrada): UnidadeDoDespachoLi {
    return {
      unidade: UNIDADE_DO_APRENDIZADO_LI,
      executar: async () => {
        const r = await executarAprendizadoLi(
          {
            db: this.db,
            jobId: this.tarefa.jobId,
            contaId: job.integracaoId,
            modo: job.modo,
            agoraMs: this.deps.agoraMs,
          },
          await this.memoDeGrupos(),
        );
        // The memo carries this phase's writes (their writeTimes) for the rest of the dispatch.
        this.memo = r.memo;
        // A learning whose grupo write was lost twice: one line, ids and counts only. The job's
        // cursor carries the claim ids, so every family with that option reports the conflict.
        if (r.aprendizado.conflitos.length > 0) {
          this.deps.logger.warn(
            '[loja-integrada] importação: aprendizado perdeu a escrita duas vezes',
            {
              jobId: this.tarefa.jobId,
              conflitos: r.aprendizado.conflitos,
              aprendidos: r.aprendidos.length,
              gruposGravados: r.gruposGravados,
            },
          );
        }
        return progresso({
          aprendizado: r.aprendizado,
          aprendizadosSimulados: [...r.aprendizadosSimulados],
          fase: FASE_IMPORTACAO_LI.familias,
          familias: FAMILIAS_DO_INICIO,
        });
      },
    };
  }

  /** The families the `familias` phase visits: every one, or the selection's only (header). */
  private familiasDoAlvo(job: ImportacaoLojaIntegrada, montagem: MontagemLi): FamiliaLi[] {
    if (job.alvo !== ALVO_IMPORTACAO_LI.selecionados) return [...montagem.familias];
    const selecionados = new Set(job.selecionados);
    return montagem.familias.filter((f) => selecionados.has(f.raiz.id));
  }

  /** What every family of this dispatch shares (from what it read once and keeps; header). */
  private async contextoDasFamilias(job: ImportacaoLojaIntegrada): Promise<ContextoDasFamiliasLi> {
    const grupos = gruposParaResolverLi(await this.memoDeGrupos(), job);
    this.recusas ??= recusasDoAprendizadoLi(
      job.integracaoId,
      await lerEvidenciasDoJobLi(this.db, this.tarefa.jobId),
      grupos,
      job.aprendizado.conflitos,
    );
    return {
      job,
      skusEmConflito: await this.skusEmConflitoDoJob(),
      grupos,
      recusasDoAprendizado: this.recusas,
    };
  }

  /** The next family of the phase after the family cursor (the target's only), if any. */
  private proximaFamilia(job: ImportacaoLojaIntegrada, m: MontagemLi): FamiliaLi | null {
    const { cursorPaiId } = job.familias;
    return (
      this.familiasDoAlvo(job, m).find((f) => cursorPaiId === null || f.raiz.id > cursorPaiId) ??
      null
    );
  }

  private depsDaFamilia(): DepsFamiliaLi {
    return {
      db: this.db,
      jobId: this.tarefa.jobId,
      criacaoDoJob: this.criacaoDoJobAtual(),
      agoraMs: this.deps.agoraMs,
    };
  }

  private unidadeDasFamilias(job: ImportacaoLojaIntegrada): UnidadeDoDespachoLi {
    if (job.acao === ACAO_IMPORTACAO_LI.completar) return this.unidadeDoCompletar(job);
    // "Only link": every detail the assembly needs was read in the `orfaos` phase, so a family
    // calls nothing.
    return {
      unidade: UNIDADE_IMPORTACAO_LI.familia,
      executar: async () => {
        const m = await this.montagemDoJob();
        const familia = this.proximaFamilia(job, m);
        if (familia === null) return this.fecharFamilias(job, m);

        const r = await executarFamiliaLi(
          this.depsDaFamilia(),
          await this.contextoDasFamilias(job),
          familia,
        );
        const contadores: ContadoresImportacaoLi =
          r.tipo === 'relatado' ? somarContadoresLi(job.contadores, r.contadores) : job.contadores;
        return progresso({
          familias: { cursorPaiId: familia.raiz.id, filhosLidos: [] },
          contadores,
        });
      },
    };
  }

  /* --------------------------------- complete --------------------------------- */

  /**
   * Whether the run copies photos, and the job patch a missing bucket stamps (module header,
   * "Complete"): the job asks for them and has not found the bucket missing yet ⇒ the bucket is
   * asked for ONCE per dispatch; `null` ⇒ `fotosIndisponiveis`, and no photo for the rest of the
   * run. Asked under Simular too, so its verdict is an `aplicar` run's.
   */
  private fotosDoJob(job: ImportacaoLojaIntegrada): {
    readonly importar: boolean;
    readonly patch: ProgressoImportacaoLi;
  } {
    if (!deveImportarFotosLi(job) || job.fotosIndisponiveis) return { importar: false, patch: {} };
    const guardar = this.guardarDasFotos(job);
    return guardar === null
      ? { importar: false, patch: { fotosIndisponiveis: true } }
      : { importar: true, patch: {} };
  }

  private guardarDasFotos(job: ImportacaoLojaIntegrada): GuardarFotoLi | null {
    if (this.guardar === undefined) {
      const bucket = this.deps.bucket();
      this.guardar =
        bucket === null
          ? null
          : criarGuardarFotoLi({ db: this.db, bucket, contaId: job.integracaoId });
    }
    return this.guardar;
  }

  /**
   * The details the complete step READ for the job's current family (`familias.filhosLidos`) —
   * and every one the dispatch holds — in the assembly's map, each looked up by id at most once
   * per dispatch. Returns the map.
   */
  private async detalhesDaFamilia(
    job: ImportacaoLojaIntegrada,
  ): Promise<ReadonlyMap<number, DetalheImportacaoLi>> {
    await this.montagemDoJob();
    const detalhes = this.detalhes;
    if (detalhes === null) throw new TypeError('despacho: montagem sem detalhes');
    const ids = job.familias.filhosLidos.filter(
      (id) => !detalhes.has(id) && !this.detalhesProcurados.has(id),
    );
    for (const id of ids) this.detalhesProcurados.add(id);
    if (ids.length > 0) {
      for (const [id, d] of await lerDetalhesGravadosLi(this.db, this.tarefa.jobId, ids)) {
        detalhes.set(id, d);
      }
    }
    return detalhes;
  }

  /**
   * The details completing `familia` still needs — never one the job holds or tried: the `orfaos`
   * phase's, and the family's own earlier units' (`familias.filhosLidos`). Computed once per
   * dispatch per family (it runs the cascade), then each read is crossed off. `casamento` is that
   * cascade when THIS call computed it (the caller's unit may reuse it: same family, same
   * context); `null` when the list came from an earlier unit, whose cascade may predate a detail.
   */
  private async faltantesDaFamilia(
    job: ImportacaoLojaIntegrada,
    ctx: ContextoDasFamiliasLi,
    familia: FamiliaLi,
  ): Promise<{
    readonly ids: readonly number[];
    readonly casamento: CasamentoDaFamiliaLi | null;
  }> {
    if (this.faltantes?.raizLiId !== familia.raiz.id) {
      const lidos = new Set([...job.familias.filhosLidos, ...(await this.aDetalharDoSnapshot())]);
      const d = await detalhesDaFamiliaLi(this.depsDaFamilia(), ctx, familia);
      const ids = d.ids.filter((id) => !lidos.has(id));
      this.faltantes = { raizLiId: familia.raiz.id, ids: [...new Set(ids)] };
      return { ids: this.faltantes.ids, casamento: d.casamento };
    }
    return { ids: this.faltantes.ids, casamento: null };
  }

  /**
   * The cost of the complete step's next unit, before it runs: a family in progress ⇒ a photo, or
   * its closing; a family whose missing details this dispatch knows ⇒ a call, or the family; one it
   * has not looked at yet ⇒ a call (the worst of a detail read and a family).
   */
  private custoDoCompletar(
    job: ImportacaoLojaIntegrada,
    emCurso: ProgressoDaFamiliaLi | null,
  ): UnidadeImportacaoLi {
    const cursor = job.familias.cursorPaiId;
    if (emCurso !== null && (cursor === null || emCurso.raizLiId > cursor)) {
      return emCurso.resultadoFotos === null ? unidadeDaFotoLi() : UNIDADE_IMPORTACAO_LI.familia;
    }
    if (this.faltantes !== null && (cursor === null || this.faltantes.raizLiId > cursor)) {
      return this.faltantes.ids.length > 0
        ? UNIDADE_IMPORTACAO_LI.chamada
        : UNIDADE_IMPORTACAO_LI.familia;
    }
    return UNIDADE_IMPORTACAO_LI.chamada;
  }

  /**
   * The complete step's next unit for the current family (module header, "Complete"): one detail
   * read, the family's preparation (and, with nothing to fetch, its closing), one photo, or the
   * closing — each budgeted on its own and checkpointed at the same `seq`. Work the unit was not
   * budgeted for is never started: the unit then checkpoints what it learned and the next one is
   * budgeted for it.
   */
  private unidadeDoCompletar(job: ImportacaoLojaIntegrada): UnidadeDoDespachoLi {
    const guardado = job.progressoDaFamilia;
    const unidade = this.custoDoCompletar(job, guardado);
    return {
      unidade,
      executar: async () => {
        const m = await this.montagemDoJob();
        const familia = this.proximaFamilia(job, m);
        if (familia === null) return this.fecharFamilias(job, m);
        const fotos = this.fotosDoJob(job);
        const ctx: ContextoDasFamiliasLi = {
          ...(await this.contextoDasFamilias(job)),
          importarFotos: fotos.importar,
        };
        const completa = comDetalhesLi(familia, await this.detalhesDaFamilia(job));

        // A family in progress (its preparation done): a photo, or its closing.
        if (guardado?.raizLiId === familia.raiz.id) {
          return this.continuarFamilia(job, ctx, completa, guardado, unidade, fotos.patch);
        }
        // A progress of another family (read back from an older attempt) is none: cleared.
        const limpo: ProgressoImportacaoLi = guardado === null ? {} : { progressoDaFamilia: null };

        const faltantes = await this.faltantesDaFamilia(job, ctx, completa);
        const liId = faltantes.ids[0];
        if (liId !== undefined) {
          if (!cobre(unidade, UNIDADE_IMPORTACAO_LI.chamada)) {
            return progresso({ ...limpo, ...fotos.patch });
          }
          this.registrarDetalhe(liId, await this.lerDetalheContido(liId));
          this.faltantes = { raizLiId: familia.raiz.id, ids: faltantes.ids.slice(1) };
          return progresso({
            ...limpo,
            ...fotos.patch,
            familias: { ...job.familias, filhosLidos: [...job.familias.filhosLidos, liId] },
          });
        }

        // Nothing to read: this unit's own cascade (when it ran one) is reused, never re-run.
        const r = await executarFamiliaLi(
          this.depsDaFamilia(),
          ctx,
          completa,
          faltantes.casamento ?? undefined,
        );
        if (r.tipo === 'fotos') {
          return progresso({
            ...fotos.patch,
            mapaCategorias: [...r.mapaCategorias],
            progressoDaFamilia: r.progresso,
          });
        }
        this.faltantes = null;
        return progresso({
          ...limpo,
          ...fotos.patch,
          familias: { cursorPaiId: familia.raiz.id, filhosLidos: [] },
          contadores:
            r.tipo === 'relatado'
              ? somarContadoresLi(job.contadores, r.contadores)
              : job.contadores,
          mapaCategorias: [...r.mapaCategorias],
        });
      },
    };
  }

  /**
   * A family in progress (`familiaDoJob.ts`, "The family's progress"): its next photo while any is
   * left (one download at most, `fotos.ts`), else its closing — the links, the adds, the item and
   * the counters, the family cursor moved past it and the progress cleared.
   */
  private async continuarFamilia(
    job: ImportacaoLojaIntegrada,
    ctx: ContextoDasFamiliasLi,
    familia: FamiliaLi,
    emCurso: ProgressoDaFamiliaLi,
    unidade: UnidadeImportacaoLi,
    patchDasFotos: ProgressoImportacaoLi,
  ): Promise<PassoDoDespachoLi> {
    // Validated BEFORE the write: the job field reads an unparseable value as `null`, so a bad patch
    // would otherwise be written as "no progress" with nothing to say why.
    const comProgresso = (p: ProgressoDaFamiliaLi): ProgressoImportacaoLi => ({
      progressoDaFamilia: progressoDaFamiliaLiSchema.parse(p),
    });

    if (emCurso.resultadoFotos === null) {
      if (!cobre(unidade, unidadeDaFotoLi())) return progresso({ ...patchDasFotos });
      const passo = await executarUnidadeDeFotoLi(
        {
          db: this.db,
          cdn: this.contextoAtual().cdn,
          guardar: ctx.importarFotos === true ? this.guardarDasFotos(job) : null,
          esperar: this.deps.esperar,
          agoraMs: this.deps.agoraMs,
          logger: this.deps.logger,
        },
        alvosDeFotosDaFamiliaLi(familia, emCurso),
        emCurso.fotos,
      );
      switch (passo.tipo) {
        case TIPO_PASSO_FOTOS_LI.semBucket:
          // No bucket (the job found it missing since the family's preparation): what was stored
          // stays, nothing more is fetched, and the family closes with it.
          return progresso({
            ...patchDasFotos,
            fotosIndisponiveis: true,
            ...comProgresso({
              ...emCurso,
              fotos: null,
              resultadoFotos: resultadoFotosDoProgressoLi(
                resultadoDasFotosLi(emCurso.fotos ?? { feitos: [], recusadas: [] }),
              ),
            }),
          });
        case TIPO_PASSO_FOTOS_LI.progresso:
        case TIPO_PASSO_FOTOS_LI.parar:
          this.chamadas += passo.downloads;
          // An upload past its deadline: this dispatch runs no more unit (`fotos.ts`).
          if (passo.tipo === TIPO_PASSO_FOTOS_LI.parar) this.encerrarAgora = true;
          return progresso({
            ...patchDasFotos,
            ...comProgresso({ ...emCurso, fotos: passo.cursor }),
          });
        case TIPO_PASSO_FOTOS_LI.concluido:
          this.chamadas += passo.downloads;
          return progresso({
            ...patchDasFotos,
            ...comProgresso({
              ...emCurso,
              fotos: null,
              resultadoFotos: resultadoFotosDoProgressoLi(passo.resultado),
            }),
          });
      }
    }

    const r = await fecharFamiliaLi(
      this.depsDaFamilia(),
      ctx,
      familia,
      emCurso,
      emCurso.resultadoFotos,
    );
    this.faltantes = null;
    return progresso({
      ...patchDasFotos,
      progressoDaFamilia: null,
      familias: { cursorPaiId: familia.raiz.id, filhosLidos: [] },
      contadores: somarContadoresLi(job.contadores, r.contadores),
      mapaCategorias: [...r.mapaCategorias],
    });
  }

  /* ---------------------------------- revisao ---------------------------------- */

  /**
   * The `revisao` phase's next unit (module header, "The phases"; `revisaoFiscal.ts`): the
   * carry-forward, then the re-check, one page per unit; at its end the tax-review aviso is synced
   * on the open count and the job moves to `fim`. A Simular job never enters it (one found there
   * concludes it with no work). ⚠️ Accepted residual: a Cancelar landing during the phase's LAST
   * unit leaves the aviso synced by a job that then reads `cancelado` — its re-check had finished,
   * so the count it carries is the list's.
   */
  private unidadeDaRevisao(job: ImportacaoLojaIntegrada): UnidadeDoDespachoLi {
    return {
      unidade: unidadeDaRevisaoFiscalLi(),
      executar: async () => {
        if (job.modo !== MODO_IMPORTACAO_LI.aplicar) {
          return progresso({ fase: FASE_IMPORTACAO_LI.fim });
        }
        this.regras ??= criarLeitorDeRegrasImpostoLi(this.db);
        this.listasRevisao ??= criarLeitorDeListasRevisaoLi(this.db);
        const passo = await executarUnidadeDaRevisaoFiscalLi(
          {
            db: this.db,
            contaId: job.integracaoId,
            jobId: this.tarefa.jobId,
            regras: this.regras,
            listas: this.listasRevisao,
          },
          job.revisao,
        );
        if (passo.tipo === PASSO_REVISAO_FISCAL_LI.progresso) {
          return progresso({ revisao: passo.estado });
        }
        const agora = this.deps.agoraMs();
        await sincronizarAvisoDeRevisaoFiscalLi(
          this.db,
          {
            jobId: this.tarefa.jobId,
            integracaoId: job.integracaoId,
            lojaNome: this.lojaNome(),
            modo: job.modo,
            fimMs: agora,
            abertos: passo.abertos,
          },
          { increment: this.deps.increment, nowMs: agora, logger: this.deps.logger },
        );
        return progresso({ revisao: passo.estado, fase: FASE_IMPORTACAO_LI.fim });
      },
    };
  }

  /**
   * The `familias` phase's closing unit (written whole, tier 0, their counters added in the same
   * checkpoint): one `nao-listado` item per selected id the store no longer lists as a family, and
   * — under every target but `selecionados`, whose report is its selection — one `avulso` item per
   * LOOSE row (an orphan, a variation of a trashed parent, an unknown `tipo`), so the report accounts
   * for every row the store listed. The assembly's own counts go to one WARN line when any is set.
   */
  private async fecharFamilias(
    job: ImportacaoLojaIntegrada,
    montagem: MontagemLi,
  ): Promise<PassoDoDespachoLi> {
    const agora = this.deps.agoraMs();
    const avulsos = job.alvo === ALVO_IMPORTACAO_LI.selecionados ? [] : montagem.avulsos;
    const itens = [
      ...naoListadosLi(montagem, job.selecionados).map((id) => itemNaoListadoLi(id, agora)),
      ...avulsos.map((a) => itemAvulsoLi(a, agora)),
    ];
    await Promise.all(itens.map((item) => gravarItemLi(this.db, this.tarefa.jobId, item)));
    const { contagens } = montagem;
    if (Object.values(contagens).some((n) => n > 0)) {
      this.deps.logger.warn('[loja-integrada] importação: montagem com reivindicações ignoradas', {
        jobId: this.tarefa.jobId,
        ...contagens,
      });
    }
    const contadores = itens.reduce(
      (soma, item) => somarContadoresLi(soma, contadoresDoItemLi(item, null)),
      job.contadores,
    );
    return progresso({
      fase: faseDepoisDasFamiliasLi(job),
      familias: FAMILIAS_DO_INICIO,
      // No family's progress outlives the phase.
      progressoDaFamilia: null,
      contadores,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                                  The log line                               */
/* -------------------------------------------------------------------------- */

/** One raw field off a task's data: a short string, a non-negative safe integer, else `null`. */
function campoBruto(dados: unknown, chave: string): string | number | null {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, chave)) return null;
  const valor: unknown = Reflect.get(dados, chave);
  if (typeof valor === 'string') return valor.length <= 128 ? valor : null;
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
}

/**
 * The fields of the reads queue's ONE line for an import dispatch: the ids read off the RAW data
 * one by one (never a spread of it), the ending, the motivo, the phase and the counts.
 */
export function camposDoRegistroDaImportacaoLi(
  r: ResultadoDespachoImportacaoLi,
  dados: unknown,
): Readonly<Record<string, string | number | null>> {
  return {
    outcome: r.desfecho === DESFECHO_DESPACHO_IMPORTACAO_LI.payloadInvalido ? 'dropped' : 'done',
    kind: r.desfecho,
    detail: r.motivo,
    tipo: campoBruto(dados, 'tipo'),
    contaId: campoBruto(dados, 'contaId'),
    jobId: campoBruto(dados, 'jobId'),
    seq: campoBruto(dados, 'seq'),
    fase: r.fase,
    unidades: r.unidades,
    chamadas: r.chamadas,
  };
}
