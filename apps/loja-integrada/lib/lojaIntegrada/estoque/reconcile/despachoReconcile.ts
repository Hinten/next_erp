/**
 * ONE SLICE of the daily stock reconcile (master plan step 12, PR 12-g): what a reads-queue task
 * `{ tipo: 'estoque-reconcile', execucaoId, seq }` does. The functions codebase's reads queue
 * routes the raw `tipo` here and binds the deps once (`functions/src/depsReconcileEstoque.ts`);
 * everything below is Next-free, takes `db` as a parameter and reads no process environment.
 *
 * ## The order of one slice
 *
 *  1. The payload, strict (`tarefaReconcileEstoqueLiSchema`): one that does not parse is DROPPED,
 *     zero reads.
 *  2. The valve `LOJA_INTEGRADA_MODO_ESTOQUE`: `off` — unset, blank, a typo (one WARNING) — returns
 *     with zero reads. `dry-run` and `on` run alike up to the queue phase.
 *  3. The cap `LOJA_INTEGRADA_ESTOQUE_MAX`: unreadable ⇒ ONE ERROR and zero reads (the diff
 *     applies it, and every send would refuse it).
 *  4. The run document, and the decision (`execucaoReconcile.ts`): `nada`, `ocupado` (one INFO
 *     line), `adiar` (a retryable throw), `continuacao` (the named successor re-enqueued at 60 s,
 *     nothing else), `assumir` — the active Loja Integrada contas with a depósito, in the listing's
 *     order (an active one with none: one WARNING), each one's depósito fixed in its root; with
 *     none the run is released at once (`sem-contas`, one INFO line) — then `executar`.
 *  5. The PHASE MACHINE, one unit at a time while its worst case fits the budget
 *     (`orcamentoReconcile.ts`):
 *     - `erp`: the link walk (`caminhadaVinculos.ts`), one page per unit, evaluated for every conta
 *       at once (`faseErp.ts`) into the per-conta state (`snapshotReconcile.ts`); then, per conta
 *       (`idxConta`), the kits map (`mapaKitsReconcile.ts`) — its batches commit as they go, each
 *       with the lease's precondition;
 *     - `li`: per conta (`idxConta`), the store's stock list walk (`faseLi.ts`): the context
 *       FIRST (its read switch), one page — and the page's lookups — or one confirmation of an
 *       unseen linked child per unit; the rows out of step join the run's `candidatos`
 *       (`candidatosReconcile.ts`); a conta skipped or done moves `idxConta` on;
 *     - `fila`: the queue phase (`filaReconcile.ts`): its start once per run (the safety gate,
 *       the valve — a dry-run enqueues NOTHING —, the contas read again, the canary, the sort,
 *       over-advertising first), then one batch per unit: ONE reservation of exactly its size on the
 *       global slot, its `estoque` send tasks named by the run's window; what was enqueued leaves
 *       the list;
 *     - `fim`: per conta (`idxConta`), the end phase (`fimReconcile.ts`): the avisos (only under
 *       `on`), `ultimoReconcile`; then the lease is released.
 *  6. ONE end-of-slice checkpoint: the run document (`seq + 1`, the lease extended, or released at
 *     `fim`) and every per-conta document the slice changed, in ONE batch; then the NAMED
 *     continuation `(execucaoId, seq + 1)`, 2 s later — 60 s after a 429 PAUSE of the store
 *     phase. After the release, when a conta's depósito moved while the run ran
 *     (`fimReconcile.ts`), ONE new full run is enqueued at once (`estoque-reconcile-redeposito-<µs>`,
 *     seq 0); its failure is ONE line, never a rethrow (the run is already released).
 *
 * ## Failures (root rule 6) — each narrowed to its class
 *
 *  - The lease lost mid-slice (another run took it, the slice's `seq` moved, released) ⇒ `parado`,
 *    nothing written, no throw.
 *  - The sweep-only valve closed at the hand-off (`LiTarefasDesligadasError`) ⇒ the lease is
 *    released with ONE WARNING: a run is never left holding it with nothing queued.
 *  - The store phase answers its own failures (`faseLi.ts`, "Failures"): a 429 pauses, a 401/403
 *    parks and skips the conta, the conta's refusals skip it. A failure a retry may change is
 *    rethrown AFTER a progress checkpoint at the SAME `seq` (the lease extended, everything the
 *    slice completed written), so the retry resumes at the page that failed; on the queue's last
 *    attempt the store phase ends that conta instead and the chain goes on. The queue phase does
 *    the same with a transient Cloud Tasks failure, the slot's contention or Firestore's: what was
 *    enqueued is checkpointed, the original error rethrown — on the last attempt the rest is
 *    counted `naoEnfileirados` and the run goes to its end.
 *  - Everything else is rethrown and the queue retries the SAME task: before its end checkpoint it
 *    resumes from the last one; after it, the continuation check re-enqueues the successor. On the
 *    queue's LAST attempt a failure a retry could have changed — Firestore's, Cloud Tasks', another
 *    dispatch of the same slice — is answered from a FRESH read instead, since no retry follows: a
 *    run still at this `seq` is released with ONE ERROR `tentativas-esgotadas` (the next night
 *    starts over: no store phase ever runs on a half-built snapshot); a run ONE `seq` ahead is
 *    handed off — with this slice's own delay when the stored document holds ITS end-of-slice
 *    patch, else as a courtesy at the conservative 60 s. Coding bugs stay loud on every attempt.
 *
 * Every line carries ids and counts only. ⚠️ Never name the Admin SDK's multi-document
 * read-and-write call here — not even in a comment (`estrutura.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { sincEstoqueLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  ETAPA_MAPA_ESTOQUE_LI,
  FASE_RECONCILE_ESTOQUE_LI,
  type FaseReconcileEstoqueLi,
  type ReconcileEstoqueLojaIntegrada,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  type TarefaReconcileEstoqueLi,
  type WalkReconcileEstoqueLi,
  reconcileEstoqueLojaIntegradaSchema,
  tarefaReconcileEstoqueLiSchema,
} from '@delfrance/schemas';

import { listarContasLojaIntegrada } from '../../core/contas';
import {
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  type ValvulaLi,
  lerValvula,
  registrarValvulaLi,
} from '../../core/valvulas';
import { guardaOPatchLi } from '../../importacao/job';
import {
  ATRASO_CONTINUACAO_IMPORTACAO_LI_S,
  ATRASO_PAUSA_429_IMPORTACAO_LI_S,
} from '../../importacao/agendadorImportacao';
import type { EscritorLogLi } from '../../core/log';
import type { AgendadorEstoqueLi } from '../agendadorEstoque';
import { TETO_ESTOQUE_ENV_LI, lerTetoEstoqueLi } from '../configEstoqueLi';
import {
  type AgendadorReconcileEstoqueLi,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
} from './agendadorReconcile';
import { TAMANHO_PAGINA_CAMINHADA_LI, lerPaginaCaminhadaLi } from './caminhadaVinculos';
import { ListaCandidatosReconcileLi } from './candidatosReconcile';
import {
  type EscritaSincLi,
  type EstadoEscritaReconcileLi,
  LEASE_RECONCILE_ESTOQUE_LI_MS,
  LiReconcileEstoqueAdiadoError,
  LiReconcileEstoqueConcorrenteError,
  MAX_ESCRITAS_LOTE_RECONCILE_LI,
  type RaizParaAssumirLi,
  type RunLidoLi,
  assumirLeaseReconcileLi,
  decidirSliceReconcileLi,
  gravarLoteReconcileLi,
  lerRunReconcileLi,
} from './execucaoReconcile';
import { avaliarPaginaErpLi } from './faseErp';
import { FaseLiReconcileLi } from './faseLi';
import { FilaReconcileLi } from './filaReconcile';
import { CONTADOR_DEPOSITO_MUDOU_LI, FimReconcileLi, idExecucaoRedepositoLi } from './fimReconcile';
import {
  type MapaKitsMontadoLi,
  histogramaDeKitsLi,
  montarMapaKitsLi,
  proximoLoteDeEscritaDoMapaLi,
  proximoLoteDeVarreduraDoMapaLi,
} from './mapaKitsReconcile';
import { UNIDADE_RECONCILE_LI, abrirOrcamentoReconcileLi } from './orcamentoReconcile';
import {
  type EstadoContaReconcileLi,
  carregarEstadosReconcileLi,
  nomeDoContadorDaContaLi,
} from './snapshotReconcile';

const TAG = '[loja-integrada/estoque] reconcile';

/** Takes of the lease lost to a concurrent writer before {@link LiReconcileEstoqueConcorrenteError}. */
const MAX_TENTATIVAS_ASSUMIR_LI = 3;

/** What one slice needs — injected; the functions codebase binds it once. */
export interface DepsReconcileEstoqueLi {
  /**
   * The process environment: the valve, the cap, the read switch (the context's) and the store
   * list's page size are read from it.
   */
  readonly ambiente: AmbienteLi;
  /** The one clock, in ms. */
  readonly agoraMs: () => number;
  /** When THIS slice began (the queue handler's first statement), for the budget. */
  readonly inicioMs: number;
  /** The Cloud Tasks attempt, 0-based. */
  readonly tentativa: number;
  /** The Cloud Tasks task id, for the store calls' lines; `null` when the request carried none. */
  readonly idTarefa: string | null;
  /** The pacer's sleep (2 000 ms before every Loja Integrada call). */
  readonly esperar: (ms: number) => Promise<void>;
  /** A tier-0 `FieldValue.increment`, for the park's reconexão aviso. */
  readonly increment: (by: number) => unknown;
  /** The reads-queue producer ROOT (the chain's own hand-offs), built only when an enqueue is due. */
  readonly agendador: () => AgendadorReconcileEstoqueLi;
  /** The STOCK-queue producer ROOT (the queue phase's sends), built only when a send is due. */
  readonly agendadorEstoque: () => AgendadorEstoqueLi;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Links per walk page (default {@link TAMANHO_PAGINA_CAMINHADA_LI}); a test shrinks it. */
  readonly tamanhoPaginaCaminhada?: number;
  /** The candidate list's byte budget (default: the module's); a test shrinks it. */
  readonly orcamentoBytesCandidatos?: number;
  /** Test seams, forwarded to the store phase's context as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly escrever?: EscritorLogLi;
}

/** Every outcome of one slice. */
export type ResultadoReconcileLi =
  | { readonly kind: 'payload-invalido' }
  /** The valve is `off`: nothing was read. */
  | { readonly kind: 'desligado' }
  /** The cap cannot be read: nothing was read. */
  | { readonly kind: 'teto-invalido' }
  /** A stale slice: nothing was done. */
  | { readonly kind: 'nada' }
  /** Another run holds the lease. */
  | { readonly kind: 'ocupado' }
  /** The named successor was re-enqueued (the repair). */
  | { readonly kind: 'continuacao'; readonly seq: number }
  /** The slice ran and handed off to `seq`. */
  | { readonly kind: 'continua'; readonly fase: FaseReconcileEstoqueLi; readonly seq: number }
  /** The run reached its end and released the lease. */
  | { readonly kind: 'encerrado' }
  /** No conta to reconcile: released at once. */
  | { readonly kind: 'sem-contas' }
  /** The lease was lost mid-slice: nothing more written. */
  | { readonly kind: 'parado' }
  /** The sweep-only valve refused a hand-off: the lease was released. */
  | { readonly kind: 'tarefas-desligadas' }
  /** The queue's last attempt failed: the lease was released. */
  | { readonly kind: 'tentativas-esgotadas' };

/** Whether a retry could have changed this failure (module header, "Failures"). */
function retentavel(err: unknown): boolean {
  return (
    isGrpcStatusError(err) ||
    err instanceof LiReconcileEstoqueConcorrenteError ||
    err instanceof LiTarefasTransitoriasError
  );
}

/** The next lease value: an hour ahead, and always past the stored one (so every patch moves). */
function proximoLease(estado: EstadoEscritaReconcileLi, agoraMs: number): number {
  const atual = estado.runEsperado.emExecucaoAteMs;
  const minimo = typeof atual === 'number' && Number.isSafeInteger(atual) ? atual + 1 : 0;
  return Math.max(agoraMs + LEASE_RECONCILE_ESTOQUE_LI_MS, minimo);
}

/** The active Loja Integrada contas with a depósito, in the listing's order, with their roots. */
async function contasDoRunLi(
  db: Firestore,
  deps: DepsReconcileEstoqueLi,
  execucaoId: string,
): Promise<RaizParaAssumirLi[]> {
  const { contas } = await listarContasLojaIntegrada(db);
  const ativas = contas.filter((c) => c.ativo);
  for (const conta of ativas.filter((c) => c.depositoId === null)) {
    deps.logger.warn(`${TAG} conta sem depósito — fora desta execução`, {
      execucaoId,
      contaId: conta.integracaoId,
    });
  }
  const comDeposito = ativas.flatMap((c) =>
    c.depositoId === null ? [] : [{ contaId: c.integracaoId, depositoId: c.depositoId }],
  );
  if (comDeposito.length === 0) return [];
  const refs = comDeposito.map((c) => sincEstoqueLojaIntegradaCollection.docRef(db, {}, c.contaId));
  const snaps = await db.getAll(...refs);
  return comDeposito.map((c, i) => {
    const snap = snaps[i];
    return {
      ...c,
      ref: refs[i] ?? sincEstoqueLojaIntegradaCollection.docRef(db, {}, c.contaId),
      versao: snap?.exists ? (snap.updateTime ?? null) : null,
    };
  });
}

/** The context of the slice the last-attempt rule needs (module header, "Failures"). */
interface RastroDoSliceLi {
  /** The end-of-slice patch, set right BEFORE it is written. */
  patchDoFim: Readonly<Record<string, unknown>> | null;
  /** The hand-off's delay that patch was written for (2 s, or 60 s after a 429 pause). */
  atrasoDoFim: number;
}

/**
 * One slice, start to finish (module header). Deterministic outcomes RETURN; what the queue must
 * retry rethrows the ORIGINAL error. `dados` is the task's RAW data.
 */
export async function despacharReconcileEstoqueLi(
  db: Firestore,
  dados: unknown,
  deps: DepsReconcileEstoqueLi,
): Promise<ResultadoReconcileLi> {
  // 1. The payload.
  const lida = tarefaReconcileEstoqueLiSchema.safeParse(dados);
  if (!lida.success) return { kind: 'payload-invalido' };
  const tarefa = lida.data;
  const ids = { execucaoId: tarefa.execucaoId, seq: tarefa.seq };

  // 2. The valve. Zero reads.
  const valvula = lerValvula(FLUXO_LI.estoque, deps.ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido) registrarValvulaLi(valvula, { conta: null });
    return { kind: 'desligado' };
  }

  // 3. The cap. Zero reads.
  if (lerTetoEstoqueLi(deps.ambiente) === null) {
    deps.logger.error(`${TAG} teto de estoque ilegível — nada lido`, {
      ...ids,
      motivo: 'teto-invalido',
      variavel: TETO_ESTOQUE_ENV_LI,
    });
    return { kind: 'teto-invalido' };
  }

  // 4. The run document, and the decision.
  let lido = await lerRunReconcileLi(db);
  let estado: EstadoEscritaReconcileLi | null = null;
  for (let tomadas = 0; estado === null; ) {
    const decisao = decidirSliceReconcileLi(lido, tarefa, deps.agoraMs());
    switch (decisao.tipo) {
      case 'nada':
        return { kind: 'nada' };
      case 'ocupado':
        deps.logger.info(`${TAG} outra execução em curso — esta não começa`, {
          ...ids,
          emCurso: lido.run?.execucaoId ?? null,
        });
        return { kind: 'ocupado' };
      case 'adiar':
        throw new LiReconcileEstoqueAdiadoError(tarefa.execucaoId);
      case 'continuacao':
        return repararContinuacao(db, tarefa, lido, decisao.seq, deps);
      case 'executar':
        if (lido.versao === null) return { kind: 'nada' };
        estado = {
          execucaoId: tarefa.execucaoId,
          seq: tarefa.seq,
          versaoRun: lido.versao,
          runEsperado: lido.dados,
        };
        break;
      case 'assumir': {
        if (decisao.abandonada !== null) {
          const linha = `${TAG} execução anterior abandonada — esta assume`;
          const meta = {
            ...ids,
            motivo: decisao.abandonada,
            anterior: lido.run?.execucaoId ?? null,
          };
          if (decisao.abandonada === 'fora-do-formato') deps.logger.error(linha, meta);
          else deps.logger.warn(linha, meta);
        }
        const raizes = await contasDoRunLi(db, deps, tarefa.execucaoId);
        const tomada = await assumirLeaseReconcileLi(db, {
          lido,
          tarefa,
          agoraMs: deps.agoraMs(),
          raizes,
        });
        if (tomada.tipo === 'perdido') {
          tomadas += 1;
          if (tomadas >= MAX_TENTATIVAS_ASSUMIR_LI) {
            throw new LiReconcileEstoqueConcorrenteError(tarefa.execucaoId, tarefa.seq);
          }
          lido = await lerRunReconcileLi(db);
          break;
        }
        if (raizes.length === 0) {
          deps.logger.info(`${TAG} nenhuma conta com depósito — execução encerrada`, ids);
          return { kind: 'sem-contas' };
        }
        estado = tomada.estado;
        deps.logger.info(`${TAG} execução iniciada`, { ...ids, contas: raizes.length });
        break;
      }
    }
  }

  const rastro: RastroDoSliceLi = {
    patchDoFim: null,
    atrasoDoFim: ATRASO_CONTINUACAO_IMPORTACAO_LI_S,
  };
  try {
    return await executarSliceLi(db, tarefa, estado, deps, rastro, valvula);
  } catch (err) {
    if (deps.tentativa < TASK_MAX_ATTEMPTS - 1 || !retentavel(err)) throw err;
    return encerrarNaUltimaTentativaLi(db, tarefa, rastro, deps);
  }
}

/** The run as this slice left it, parsed (a bug if it does not parse: every write was checked). */
function runDoEstado(estado: EstadoEscritaReconcileLi): ReconcileEstoqueLojaIntegrada {
  return reconcileEstoqueLojaIntegradaSchema.parse({
    ...estado.runEsperado,
    proximoSlotMs: null,
  });
}

/** Steps 5 and 6 of the module header. */
async function executarSliceLi(
  db: Firestore,
  tarefa: TarefaReconcileEstoqueLi,
  estado: EstadoEscritaReconcileLi,
  deps: DepsReconcileEstoqueLi,
  rastro: RastroDoSliceLi,
  valvula: ValvulaLi,
): Promise<ResultadoReconcileLi> {
  const ids = { execucaoId: tarefa.execucaoId, seq: tarefa.seq };
  const run = runDoEstado(estado);
  const orcamento = abrirOrcamentoReconcileLi(deps.agoraMs, deps.inicioMs);
  let fase: FaseReconcileEstoqueLi = run.fase ?? FASE_RECONCILE_ESTOQUE_LI.erp;
  let walk: WalkReconcileEstoqueLi | null = run.walk;
  let idxConta = run.idxConta;
  const contadores: Record<string, number> = { ...run.contadores };
  const contar = (nome: string, n = 1): void => {
    if (n !== 0) contadores[nome] = (contadores[nome] ?? 0) + n;
  };
  const candidatos = new ListaCandidatosReconcileLi(run.candidatos, deps.orcamentoBytesCandidatos);

  // Every per-conta state the slice loads, ONE copy per conta whichever phase loaded it: the
  // ERP phase loads them all at once, the store phase one conta at a time.
  const estados = new Map<string, EstadoContaReconcileLi>();
  if (fase === FASE_RECONCILE_ESTOQUE_LI.erp) {
    const todos = await carregarEstadosReconcileLi(db, tarefa.execucaoId, run.contas);
    if (todos === null) {
      deps.logger.warn(`${TAG} estado de conta de outra execução — o slice para`, ids);
      return { kind: 'parado' };
    }
    for (const [contaId, e] of todos) estados.set(contaId, e);
  }
  const contas = [...estados.values()].map((e) => e.conta);
  const mapas = new Map<string, MapaKitsMontadoLi>();
  const mapaDe = (e: EstadoContaReconcileLi): MapaKitsMontadoLi => {
    const memo = mapas.get(e.conta.contaId);
    if (memo !== undefined) return memo;
    const montado = montarMapaKitsLi(tarefa.execucaoId, e.entradas());
    mapas.set(e.conta.contaId, montado);
    return montado;
  };
  /** One conta's state, loaded once per slice whichever phase asks first. */
  const estadoDe = async (conta: {
    readonly idx: number;
    readonly contaId: string;
  }): Promise<EstadoContaReconcileLi | null> => {
    const carregado = estados.get(conta.contaId);
    if (carregado !== undefined) return carregado;
    const lidos = await carregarEstadosReconcileLi(
      db,
      tarefa.execucaoId,
      [conta.contaId],
      conta.idx,
    );
    const lido = lidos?.get(conta.contaId) ?? null;
    if (lido !== null) estados.set(conta.contaId, lido);
    return lido;
  };
  // The store phase, built when the slice reaches it.
  let faseLi: FaseLiReconcileLi | null = null;
  const faseLiDoSlice = (): FaseLiReconcileLi => {
    faseLi ??= new FaseLiReconcileLi({
      db,
      deps,
      execucaoId: tarefa.execucaoId,
      runIniciadoEmMs: run.iniciadoEmMs ?? 0,
      // Read and checked at step 3: never null here.
      teto: lerTetoEstoqueLi(deps.ambiente) ?? 0,
      orcamento,
      candidatos,
      contar,
      contador: (nome) => contadores[nome] ?? 0,
      estadoDe,
    });
    return faseLi;
  };
  // The queue phase, built when the slice reaches it.
  let fila: FilaReconcileLi | null = null;
  const filaDoSlice = (): FilaReconcileLi => {
    fila ??= new FilaReconcileLi({
      db,
      deps,
      execucaoId: tarefa.execucaoId,
      runIniciadoEmMs: run.iniciadoEmMs ?? 0,
      contas: run.contas,
      valvula,
      candidatos,
      orcamento,
      contar,
      contador: (nome) => contadores[nome] ?? 0,
      estadoDe,
    });
    return fila;
  };
  // The end phase, built when the slice reaches it; its conta roots ride the end-of-slice batch.
  const escritasDoFim: EscritaSincLi[] = [];
  let fim: FimReconcileLi | null = null;
  const fimDoSlice = (): FimReconcileLi => {
    fim ??= new FimReconcileLi({
      db,
      deps,
      execucaoId: tarefa.execucaoId,
      runIniciadoEmMs: run.iniciadoEmMs ?? 0,
      contas: run.contas,
      valvula,
      orcamento,
      contadores: () => contadores,
      registrarMaximo: (nome, n) => {
        contadores[nome] = Math.max(contadores[nome] ?? 0, n);
      },
      escritas: escritasDoFim,
      estadoCarregado: (contaId) => estados.get(contaId),
    });
    return fim;
  };

  /** The run document's fields as the slice leaves them, but `seq` and the lease. */
  const progresso = (): Record<string, unknown> => ({
    fase,
    walk,
    idxConta,
    contadores,
    ...(candidatos.sujo ? { candidatos: candidatos.lista() } : {}),
  });

  let final = false;
  let atraso = ATRASO_CONTINUACAO_IMPORTACAO_LI_S;
  maquina: for (;;) {
    if (fase === FASE_RECONCILE_ESTOQUE_LI.erp) {
      if (walk === null || !walk.concluida) {
        if (!orcamento.cabe(UNIDADE_RECONCILE_LI.erp)) break;
        const pagina = await lerPaginaCaminhadaLi(
          db,
          walk?.ultimoDocPath ?? null,
          deps.tamanhoPaginaCaminhada ?? TAMANHO_PAGINA_CAMINHADA_LI,
        );
        const porConta = await avaliarPaginaErpLi(db, pagina.grupos, contas, estados);
        for (const conta of contas) {
          for (const [nome, n] of porConta.get(conta.contaId) ?? []) {
            contar(nomeDoContadorDaContaLi(conta.idx, nome), n);
          }
        }
        contar('paginasErp');
        contar('vinculosLidos', pagina.lidos);
        contar('vinculosIgnorados', pagina.ignorados);
        walk = { ultimoDocPath: pagina.ultimoDocPath, concluida: pagina.concluida };
        if (pagina.concluida) {
          for (const e of estados.values()) {
            e.atualizarExecucao({
              mapa: { etapa: ETAPA_MAPA_ESTOQUE_LI.escrita, ultimoComponenteId: null },
            });
          }
          idxConta = 0;
        }
        continue;
      }
      const conta = contas[idxConta];
      if (conta !== undefined) {
        if (!orcamento.cabe(UNIDADE_RECONCILE_LI.mapa)) break;
        const e = estados.get(conta.contaId);
        if (e === undefined) throw new TypeError('reconcile: conta sem estado carregado');
        const unidade = await unidadeDoMapaLi(db, tarefa, estado, e, mapaDe, deps);
        if (unidade.parado) return { kind: 'parado' };
        for (const [nome, n] of unidade.contadores) {
          contar(nomeDoContadorDaContaLi(conta.idx, nome), n);
        }
        if (unidade.feito) idxConta += 1;
        continue;
      }
      fase = FASE_RECONCILE_ESTOQUE_LI.li;
      idxConta = 0;
      continue;
    }
    if (fase === FASE_RECONCILE_ESTOQUE_LI.li) {
      const contaId = run.contas[idxConta];
      if (contaId === undefined) {
        fase = FASE_RECONCILE_ESTOQUE_LI.fila;
        continue;
      }
      const passo = await faseLiDoSlice().unidade({ idx: idxConta, contaId });
      switch (passo.tipo) {
        case 'unidade':
          continue maquina;
        case 'conta-encerrada':
          idxConta += 1;
          continue maquina;
        case 'sem-orcamento':
          break maquina;
        case 'pausa':
          atraso = ATRASO_PAUSA_429_IMPORTACAO_LI_S;
          break maquina;
        case 'parado':
          deps.logger.warn(`${TAG} estado de conta de outra execução — o slice para`, ids);
          return { kind: 'parado' };
        case 'falha': {
          // What the slice completed is kept, at the SAME seq; then the ORIGINAL error.
          const parado = await gravarProgressoAntesDaFalhaLi(
            db,
            estado,
            progresso(),
            estados,
            deps.agoraMs,
          );
          if (parado) return { kind: 'parado' };
          throw passo.erro;
        }
      }
    }
    if (fase === FASE_RECONCILE_ESTOQUE_LI.fila) {
      const passo = await filaDoSlice().unidade();
      switch (passo.tipo) {
        case 'unidade':
          continue maquina;
        case 'concluida':
          fase = FASE_RECONCILE_ESTOQUE_LI.fim;
          idxConta = 0;
          continue maquina;
        case 'sem-orcamento':
          break maquina;
        case 'parado':
          deps.logger.warn(`${TAG} estado de conta de outra execução — o slice para`, ids);
          return { kind: 'parado' };
        case 'falha': {
          // What was enqueued leaves the stored list, at the SAME seq; then the ORIGINAL error.
          const parado = await gravarProgressoAntesDaFalhaLi(
            db,
            estado,
            progresso(),
            estados,
            deps.agoraMs,
          );
          if (parado) return { kind: 'parado' };
          throw passo.erro;
        }
      }
    }
    if (idxConta < run.contas.length) {
      const passo = await fimDoSlice().unidade(idxConta);
      if (passo.tipo === 'sem-orcamento') break;
      if (passo.tipo === 'parado') {
        deps.logger.warn(`${TAG} estado de conta de outra execução — o slice para`, ids);
        return { kind: 'parado' };
      }
      idxConta += 1;
      continue;
    }
    final = true;
    break;
  }

  // 6. The end-of-slice checkpoint: per-conta documents first when they exceed one batch.
  const escritas = [...[...estados.values()].flatMap((e) => e.escritas()), ...escritasDoFim];
  while (escritas.length > MAX_ESCRITAS_LOTE_RECONCILE_LI) {
    const parte = escritas.splice(0, MAX_ESCRITAS_LOTE_RECONCILE_LI);
    const r = await gravarLoteReconcileLi(
      db,
      estado,
      { emExecucaoAteMs: proximoLease(estado, deps.agoraMs()) },
      parte,
    );
    if (r.tipo === 'parar') return { kind: 'parado' };
    for (const e of estados.values()) e.gravado(r.versoes);
  }
  const patchDoFim: Record<string, unknown> = {
    ...progresso(),
    seq: tarefa.seq + 1,
    ...(final
      ? { emExecucaoAteMs: 0, candidatos: [] }
      : { emExecucaoAteMs: proximoLease(estado, deps.agoraMs()) }),
  };
  rastro.patchDoFim = patchDoFim;
  rastro.atrasoDoFim = atraso;
  const r = await gravarLoteReconcileLi(db, estado, patchDoFim, escritas);
  if (r.tipo === 'parar') return { kind: 'parado' };

  if (final) {
    deps.logger.info(`${TAG} execução encerrada`, { ...ids, ...contadores });
    await pedirRevisaoDeDepositoLi(contadores[CONTADOR_DEPOSITO_MUDOU_LI] ?? 0, tarefa, deps);
    return { kind: 'encerrado' };
  }
  return passarAdiante(db, tarefa, estado, tarefa.seq + 1, atraso, deps, fase);
}

/**
 * The progress checkpoint of a store-phase failure a retry may change (module header,
 * "Failures"): the run document at the SAME `seq` and every per-conta document the slice changed.
 * `true` when the lease is no longer this slice's (it stops). A failure of this write itself —
 * Firestore's, or another dispatch of the slice — is left to the retry: the caller rethrows the
 * ORIGINAL error, and the retry resumes from the last checkpoint that landed.
 */
async function gravarProgressoAntesDaFalhaLi(
  db: Firestore,
  estado: EstadoEscritaReconcileLi,
  patch: Readonly<Record<string, unknown>>,
  estados: ReadonlyMap<string, EstadoContaReconcileLi>,
  agoraMs: () => number,
): Promise<boolean> {
  const escritas = [...estados.values()].flatMap((e) => e.escritas());
  try {
    while (escritas.length > MAX_ESCRITAS_LOTE_RECONCILE_LI) {
      const parte = escritas.splice(0, MAX_ESCRITAS_LOTE_RECONCILE_LI);
      const r = await gravarLoteReconcileLi(
        db,
        estado,
        { emExecucaoAteMs: proximoLease(estado, agoraMs()) },
        parte,
      );
      if (r.tipo === 'parar') return true;
      for (const e of estados.values()) e.gravado(r.versoes);
    }
    const r = await gravarLoteReconcileLi(
      db,
      estado,
      { ...patch, emExecucaoAteMs: proximoLease(estado, agoraMs()) },
      escritas,
    );
    return r.tipo === 'parar';
  } catch (err) {
    if (isGrpcStatusError(err) || err instanceof LiReconcileEstoqueConcorrenteError) return false;
    throw err;
  }
}

/** One unit of a conta's kits map (`mapaKitsReconcile.ts`). */
async function unidadeDoMapaLi(
  db: Firestore,
  tarefa: TarefaReconcileEstoqueLi,
  estado: EstadoEscritaReconcileLi,
  e: EstadoContaReconcileLi,
  mapaDe: (e: EstadoContaReconcileLi) => MapaKitsMontadoLi,
  deps: DepsReconcileEstoqueLi,
): Promise<{
  readonly parado: boolean;
  readonly feito: boolean;
  readonly contadores: ReadonlyMap<string, number>;
}> {
  const contadores = new Map<string, number>();
  const cursor = e.raiz.execucao.mapa ?? {
    etapa: ETAPA_MAPA_ESTOQUE_LI.escrita,
    ultimoComponenteId: null,
  };
  const contaId = e.conta.contaId;
  switch (cursor.etapa) {
    case ETAPA_MAPA_ESTOQUE_LI.escrita: {
      const mapa = mapaDe(e);
      const lote = proximoLoteDeEscritaDoMapaLi(db, contaId, mapa, cursor.ultimoComponenteId);
      if (lote.componentes === 0) {
        e.atualizarExecucao({
          mapa: {
            etapa: ETAPA_MAPA_ESTOQUE_LI.varredura,
            ultimoComponenteId: cursor.ultimoComponenteId,
          },
        });
        contadores.set('componentesNoMapa', mapa.componentes.size);
        contadores.set('kitsNoMapa', mapa.kits);
        contadores.set('kitsForaDoMapa', mapa.kitsSemComposicao);
        return { parado: false, feito: false, contadores };
      }
      const r = await gravarLoteReconcileLi(
        db,
        estado,
        { emExecucaoAteMs: proximoLease(estado, deps.agoraMs()) },
        lote.escritas,
      );
      if (r.tipo === 'parar') return { parado: true, feito: false, contadores };
      e.atualizarExecucao({
        mapa: { etapa: ETAPA_MAPA_ESTOQUE_LI.escrita, ultimoComponenteId: lote.ultimoComponenteId },
      });
      return { parado: false, feito: false, contadores };
    }
    case ETAPA_MAPA_ESTOQUE_LI.varredura: {
      const apagar = await proximoLoteDeVarreduraDoMapaLi(db, contaId, tarefa.execucaoId);
      if (apagar.length === 0) {
        e.atualizarExecucao({
          mapa: {
            etapa: ETAPA_MAPA_ESTOQUE_LI.feito,
            ultimoComponenteId: cursor.ultimoComponenteId,
          },
        });
        deps.logger.info(`${TAG} mapa de kits da conta concluído`, {
          execucaoId: tarefa.execucaoId,
          contaId,
          ...histogramaDeKitsLi(mapaDe(e)),
        });
        return { parado: false, feito: true, contadores };
      }
      const r = await gravarLoteReconcileLi(
        db,
        estado,
        { emExecucaoAteMs: proximoLease(estado, deps.agoraMs()) },
        apagar,
      );
      if (r.tipo === 'parar') return { parado: true, feito: false, contadores };
      contadores.set('mapaVarridos', apagar.length);
      return { parado: false, feito: false, contadores };
    }
    case ETAPA_MAPA_ESTOQUE_LI.feito:
      return { parado: false, feito: true, contadores };
  }
}

/**
 * After the release: ONE new full run when a conta's depósito moved while this one ran (module
 * header, step 6) — named after the conta document's update time, so a retried enqueue collides.
 * Never rethrown: the run is already released, so a retry would only find it done; the next
 * nightly run covers a lost one.
 */
async function pedirRevisaoDeDepositoLi(
  versaoUs: number,
  tarefa: TarefaReconcileEstoqueLi,
  deps: DepsReconcileEstoqueLi,
): Promise<void> {
  if (versaoUs <= 0) return;
  const execucaoId = idExecucaoRedepositoLi(versaoUs);
  const meta = { execucaoId: tarefa.execucaoId, novaExecucaoId: execucaoId };
  try {
    await deps
      .agendador()
      .enfileirar({ tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId, seq: 0 }, { atrasoS: 0 });
  } catch (err) {
    if (err instanceof LiTarefasDesligadasError) {
      deps.logger.warn(
        `${TAG} depósito mudou — tarefas desligadas, nova execução não enfileirada`,
        meta,
      );
      return;
    }
    if (err instanceof LiTarefasTransitoriasError) {
      deps.logger.error(`${TAG} depósito mudou — nova execução não enfileirada`, {
        ...meta,
        motivo: 'revisao-nao-enfileirada',
      });
      return;
    }
    throw err;
  }
  deps.logger.info(`${TAG} depósito mudou durante a execução — nova execução enfileirada`, meta);
}

/**
 * The named successor `(execucaoId, seq)` after `atrasoS`. The closed valve releases the lease
 * (module header, "Failures"); a transient failure is rethrown, and the retry's continuation check
 * repairs it.
 */
async function passarAdiante(
  db: Firestore,
  tarefa: TarefaReconcileEstoqueLi,
  estado: EstadoEscritaReconcileLi,
  seq: number,
  atrasoS: number,
  deps: DepsReconcileEstoqueLi,
  fase: FaseReconcileEstoqueLi,
): Promise<ResultadoReconcileLi> {
  try {
    await deps
      .agendador()
      .enfileirar(
        { tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId: tarefa.execucaoId, seq },
        { atrasoS },
      );
  } catch (err) {
    if (!(err instanceof LiTarefasDesligadasError)) throw err;
    deps.logger.warn(`${TAG} tarefas desligadas — a execução solta a vez`, {
      execucaoId: tarefa.execucaoId,
      seq,
    });
    await liberar(db, { ...estado, seq }, seq);
    return { kind: 'tarefas-desligadas' };
  }
  return { kind: 'continua', fase, seq };
}

/** Releases the lease of a run at `seq`: lease 0, `seq + 1`, no candidate. */
async function liberar(
  db: Firestore,
  estado: EstadoEscritaReconcileLi,
  seq: number,
): Promise<void> {
  await gravarLoteReconcileLi(db, estado, { emExecucaoAteMs: 0, seq: seq + 1, candidatos: [] });
}

/** The repair (`continuacao`): the stored `seq`'s named task at the conservative 60 s, nothing else. */
async function repararContinuacao(
  db: Firestore,
  tarefa: TarefaReconcileEstoqueLi,
  lido: RunLidoLi,
  seq: number,
  deps: DepsReconcileEstoqueLi,
): Promise<ResultadoReconcileLi> {
  if (lido.versao === null) return { kind: 'nada' };
  const estado: EstadoEscritaReconcileLi = {
    execucaoId: tarefa.execucaoId,
    seq,
    versaoRun: lido.versao,
    runEsperado: lido.dados,
  };
  const r = await passarAdiante(
    db,
    tarefa,
    estado,
    seq,
    ATRASO_PAUSA_429_IMPORTACAO_LI_S,
    deps,
    lido.run?.fase ?? FASE_RECONCILE_ESTOQUE_LI.erp,
  );
  return r.kind === 'continua' ? { kind: 'continuacao', seq } : r;
}

/** The queue's last attempt (module header, "Failures"): answered from a fresh read. */
async function encerrarNaUltimaTentativaLi(
  db: Firestore,
  tarefa: TarefaReconcileEstoqueLi,
  rastro: RastroDoSliceLi,
  deps: DepsReconcileEstoqueLi,
): Promise<ResultadoReconcileLi> {
  const relido = await lerRunReconcileLi(db);
  const run = relido.run;
  if (
    run === null ||
    relido.versao === null ||
    run.execucaoId !== tarefa.execucaoId ||
    run.emExecucaoAteMs === 0
  ) {
    return { kind: 'parado' };
  }
  const estado: EstadoEscritaReconcileLi = {
    execucaoId: tarefa.execucaoId,
    seq: run.seq,
    versaoRun: relido.versao,
    runEsperado: relido.dados,
  };
  if (run.seq === tarefa.seq) {
    deps.logger.error(`${TAG} tentativas esgotadas — a execução solta a vez`, {
      execucaoId: tarefa.execucaoId,
      seq: tarefa.seq,
      fase: run.fase,
      motivo: 'tentativas-esgotadas',
    });
    await liberar(db, estado, run.seq);
    return { kind: 'tentativas-esgotadas' };
  }
  if (run.seq !== tarefa.seq + 1) return { kind: 'parado' };
  // ONE seq ahead: ours (our end patch landed behind the error) with our delay, else a courtesy.
  const nosso = rastro.patchDoFim !== null && guardaOPatchLi(relido.dados, rastro.patchDoFim);
  const atraso = nosso ? rastro.atrasoDoFim : ATRASO_PAUSA_429_IMPORTACAO_LI_S;
  try {
    return await passarAdiante(
      db,
      tarefa,
      estado,
      run.seq,
      atraso,
      deps,
      run.fase ?? FASE_RECONCILE_ESTOQUE_LI.erp,
    );
  } catch (err) {
    if (!(err instanceof LiTarefasTransitoriasError)) throw err;
    deps.logger.error(`${TAG} tentativas esgotadas na passagem — a execução solta a vez`, {
      execucaoId: tarefa.execucaoId,
      seq: run.seq,
      motivo: 'tentativas-esgotadas',
    });
    await liberar(db, estado, run.seq);
    return { kind: 'tentativas-esgotadas' };
  }
}

/** The queue line's fields of one slice: raw ids and the outcome, never a payload spread. */
export function camposDoRegistroDoReconcileLi(
  r: ResultadoReconcileLi,
  dados: unknown,
): Readonly<Record<string, string | number | null>> {
  const campo = (chave: string): string | number | null => {
    if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, chave)) return null;
    const v: unknown = Reflect.get(dados, chave);
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    return typeof v === 'string' && v.length <= 100 ? v : null;
  };
  return {
    tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
    execucaoId: campo('execucaoId'),
    seq: campo('seq'),
    kind: r.kind,
    fase: r.kind === 'continua' ? r.fase : null,
  };
}
