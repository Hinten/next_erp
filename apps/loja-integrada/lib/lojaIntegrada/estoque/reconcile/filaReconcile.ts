/**
 * The daily stock reconcile's QUEUE phase (`fila`; master plan step 12, PR 12-g): the candidates
 * the store phase stored in the run document become `estoque` send tasks on the stock queue — the
 * merged producer (`agendadorEstoque.ts`), the ONE global slot (`slotEstoqueLi.ts`), ids only. One
 * unit at a time ({@link FilaReconcileLi.unidade}); the slice (`despachoReconcile.ts`) owns the
 * loop, the budget's end and every write of the run document. Next-free, `db` a parameter.
 *
 * ## Its start, once per run (`filaIniciada`)
 *
 *  1. **The safety gate**, per conta, from the ERP side's counters: a misconfigured depósito would
 *     push 0 to every listing, so when MORE than {@link LIMITE_PERCENTUAL_SEM_REGISTRO_RECONCILE_LI}%
 *     of the conta's evaluated children (`avaliados`) have a stock record at another depósito and
 *     none at the conta's (`zeroPorDeposito`, the children that would be pushed the depósito's real
 *     0) — {@link depositoSemRegistrosLi}, `zero × 100 > 5 × avaliados`, so exactly 5% passes — NONE
 *     of the conta's candidates is enqueued: ONE ERROR line, `bloqueadoDeposito`, and at the end
 *     the `deposito-sem-registros` vinculo aviso (`fimReconcile.ts`). Children held because they
 *     never had stock are not in the numerator (they are never pushed). The store phase's own
 *     block (`bloqueioForaDoSnapshot`: lookups found more linked children than the snapshot could
 *     have missed) blocks the conta the same way. Both are decided in EVERY valve mode, so a
 *     dry-run shows them.
 *  2. **The valve**: not exactly `on` ⇒ NOTHING is enqueued and the slot is not touched — ONE
 *     summary INFO line per conta (candidates, over- and under-advertising, the block), the list
 *     cleared, and the run goes to its end. The per-candidate lines were the store phase's, one per
 *     candidate in every mode.
 *  3. Under `on`: every conta is read again, uncached (`contasReconcile.ts`): a conta gone,
 *     inactive, or whose depósito is no longer the one the run fixed is the wrong conta for this
 *     snapshot ⇒ its candidates dropped (ONE WARNING, counted); then the canary, per target, by the
 *     send run's own pure decision (`decidirAlvo` on `<conta>:<store id>`): a target the send run
 *     would only dry-run is not worth a store GET (counted `foraDoCanario`); then the list SORTED
 *     once (`ordenarCandidatosEstoqueLi`: OVER-ADVERTISING first, `d` descending) and stored.
 *
 * ## One unit: one batch ({@link LOTE_FILA_RECONCILE_LI})
 *
 * Before a slice's first batch the contas are read again (a depósito moved mid-phase drops that
 * conta's rest, as above). A batch is the head of the list, of ONE kind — over-advertising (`d >
 * 0`) or not — and:
 *
 *  - **ONE reservation of exactly its size** on the global slot (`reservarSlotGlobalEstoqueLi`),
 *    so the slot advances by `m × 17 s` for `m` sends and never holds instants nothing used (only
 *    a batch cut short by a failure leaves a gap, and only of its failed sends: latency, never
 *    load). Never double-booked: the reservation queues behind the stored slot, the kit fan-out's
 *    included;
 *  - **the backlog horizon**: a batch that is NOT over-advertising reserves only the instants at
 *    or before `now +` {@link HORIZONTE_SUBANUNCIO_RECONCILE_LI_MS} (the slot's own 12 h backlog
 *    horizon, the SAME constant); the rows past it are DEFERRED (counted `adiadosHorizonte`, never
 *    enqueued — the next night re-finds them, so nothing is sent twice). So when the stored slot is
 *    already more than that ahead, only the over-advertising rows are enqueued, and the bootstrap's
 *    bulk of under-advertising sends never queues more than 12 h of slot in front of a later
 *    over-advertising send or a zero-crossing kit. Over-advertising rows are bounded only by the
 *    schedule limit;
 *  - **the slot exhausted** (`excedeLimite`, a backlog of weeks): ONE ERROR `slot-esgotado`,
 *    nothing of the batch enqueued, the rest counted and dropped; a stored slot past the horizon on
 *    an over-advertising batch: ONE ERROR per run (`filaSaturada`), and it still queues behind it;
 *  - **the enqueues**, {@link CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI} at a time: `origem:
 *    'reconcile'`, generation 0, ids only (a kit candidate carries its components' record ids from
 *    its snapshot entry, `e`, as the kit producers do), NAMED by the RUN's own window `J =
 *    ⌊iniciadoEmMs / 60 s⌋` and scheduled at EXACTLY its reserved instant (`janela` +
 *    `naoAntesDeMs`). Why a name never meets a task that matters: only this run's queue phase
 *    enqueues a `reconcile` task of window `J` (two runs never start in one minute window — the
 *    `adiar` rule, `execucaoReconcile.ts`), and it does so after its own diff, so meeting one — an
 *    answered already-exists — is this run's earlier enqueue: a retried slice re-meets its own
 *    sends, nothing is lost and nothing is doubled (`agendadorEstoque.ts`'s header);
 *  - what was enqueued — and what the strict parse refused (`ZodError`, counted: it would refuse
 *    forever) — LEAVES the list in the slice's checkpoint; the sweep-only valve closed ⇒ ONE
 *    WARNING, the rest counted `naoEnfileirados`, the list dropped; a transient failure (Cloud
 *    Tasks, the slot's contention, Firestore) lets the batch finish, then the slice checkpoints
 *    what landed and the ORIGINAL error is rethrown — on the queue's LAST attempt the rest is
 *    counted `naoEnfileirados` (one ERROR) and the run goes to its end instead. Anything else is
 *    rethrown as-is.
 *
 * Every line carries ids and counts only. ⚠️ Never name the Admin SDK's multi-document
 * read-and-write call here — not even in a comment (`estrutura.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  type CandidatoReconcileEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  ORIGEM_TAREFA_ESTOQUE_LI,
} from '@delfrance/schemas';

import { MODO_LI, type ValvulaLi, decidirAlvo } from '../../core/valvulas';
import {
  type AgendadorEstoqueLi,
  CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  type TarefaEstoqueSemJanelaLi,
  enfileirarTarefaEstoqueLi,
  janelaEstoqueLi,
} from '../agendadorEstoque';
import { ordenarCandidatosEstoqueLi } from '../planoEstoqueLi';
import {
  HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS,
  LiSlotEstoqueEmConflitoError,
  reservarSlotGlobalEstoqueLi,
} from '../slotEstoqueLi';
import type { ListaCandidatosReconcileLi } from './candidatosReconcile';
import {
  type ContaRevistaLi,
  type IndisponibilidadeContaLi,
  indisponibilidadeDaContaLi,
  reverContasDoRunLi,
} from './contasReconcile';
import { type OrcamentoReconcileLi, UNIDADE_RECONCILE_LI } from './orcamentoReconcile';
import { type EstadoContaReconcileLi, nomeDoContadorDaContaLi } from './snapshotReconcile';

const TAG = '[loja-integrada/estoque] reconcile';

/** The safety gate's share, in percent (module header): MORE than this blocks the conta. */
export const LIMITE_PERCENTUAL_SEM_REGISTRO_RECONCILE_LI = 5;

/** The most sends one batch reserves and enqueues (module header, "One unit"). */
export const LOTE_FILA_RECONCILE_LI = 100;

/**
 * How far ahead of now a send that is NOT over-advertising may be scheduled (module header): the
 * slot's own backlog horizon, the SAME constant — one copy.
 */
export const HORIZONTE_SUBANUNCIO_RECONCILE_LI_MS = HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS;

/**
 * The safety gate (module header): whether a conta's evaluated children show a misconfigured
 * depósito. Pure. `zeroPorDeposito × 100 > 5 × avaliados`: 5 of 100 passes, 6 of 100 blocks, and a
 * conta with nothing evaluated never blocks.
 */
export function depositoSemRegistrosLi(c: {
  readonly avaliados: number;
  readonly zeroPorDeposito: number;
}): boolean {
  return c.zeroPorDeposito * 100 > LIMITE_PERCENTUAL_SEM_REGISTRO_RECONCILE_LI * c.avaliados;
}

/** Why a conta's candidates are not enqueued this run (module header). */
export type BloqueioFilaLi =
  | 'deposito-sem-registros'
  | 'fora-do-snapshot'
  | IndisponibilidadeContaLi;

/** What the queue phase needs of the slice's deps. */
export interface DepsFilaReconcileLi {
  readonly agoraMs: () => number;
  /** The Cloud Tasks attempt, 0-based (the last-attempt rule). */
  readonly tentativa: number;
  /** The STOCK queue's producer root, built only when an enqueue is due. */
  readonly agendadorEstoque: () => AgendadorEstoqueLi;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** What one slice hands its queue phase. */
export interface ArgsFilaReconcileLi {
  readonly db: Firestore;
  readonly deps: DepsFilaReconcileLi;
  readonly execucaoId: string;
  /** MS. When the run began: its window names every send (module header). */
  readonly runIniciadoEmMs: number;
  /** The run's contas, in order (a candidate's `c` indexes it). */
  readonly contas: readonly string[];
  /** The stock valve, as the slice read it. */
  readonly valvula: ValvulaLi;
  readonly candidatos: ListaCandidatosReconcileLi;
  readonly orcamento: OrcamentoReconcileLi;
  /** Adds to a run counter (the stored name). */
  readonly contar: (nome: string, n?: number) => void;
  /** A run counter's current value (the stored name). */
  readonly contador: (nome: string) => number;
  /** The conta's state, loaded once per slice; `null` = another run's (the slice stops). */
  readonly estadoDe: (conta: {
    readonly idx: number;
    readonly contaId: string;
  }) => Promise<EstadoContaReconcileLi | null>;
}

/** What one {@link FilaReconcileLi.unidade} call decided. */
export type PassoFilaLi =
  /** One unit ran: ask again. */
  | { readonly tipo: 'unidade' }
  /** The next unit does not fit the slice's budget: the slice ends. */
  | { readonly tipo: 'sem-orcamento' }
  /** Nothing is left to enqueue: the run goes to its end. */
  | { readonly tipo: 'concluida' }
  /** A conta's state belongs to another run: the slice stops. */
  | { readonly tipo: 'parado' }
  /** A failure a retry may change: the slice writes what it completed, then rethrows `erro`. */
  | { readonly tipo: 'falha'; readonly erro: unknown };

/** Whether a retry can change this failure (module header, "One unit"). */
function retentavelNaFilaLi(err: unknown): boolean {
  return (
    isGrpcStatusError(err) ||
    err instanceof LiTarefasTransitoriasError ||
    err instanceof LiSlotEstoqueEmConflitoError
  );
}

/** Thrown inside a batch when a conta's state belongs to another run. */
class ParadoNaFilaLi extends Error {
  constructor() {
    super('fila do reconcile: estado de conta de outra execução');
    this.name = 'ParadoNaFilaLi';
  }
}

/** The queue phase of ONE slice (module header). */
export class FilaReconcileLi {
  private readonly args: ArgsFilaReconcileLi;
  /** The contas as read in THIS slice (the re-check), once. */
  private revistas: Map<string, ContaRevistaLi> | null = null;
  private agendador: AgendadorEstoqueLi | null = null;

  constructor(args: ArgsFilaReconcileLi) {
    this.args = args;
  }

  private daConta(idx: number, nome: string): number {
    return this.args.contador(nomeDoContadorDaContaLi(idx, nome));
  }

  private contarDaConta(idx: number, nome: string, n = 1): void {
    if (n !== 0) this.args.contar(nomeDoContadorDaContaLi(idx, nome), n);
  }

  private ids(idx: number): Record<string, unknown> {
    return { execucaoId: this.args.execucaoId, contaId: this.args.contas[idx] ?? null };
  }

  /** ONE unit of the queue phase (module header). */
  async unidade(): Promise<PassoFilaLi> {
    try {
      if (this.args.contador('filaIniciada') === 0) return await this.iniciar();
      if (this.args.candidatos.lista().length === 0) return { tipo: 'concluida' };
      if (this.revistas === null) await this.revisar();
      const lista = this.args.candidatos.lista();
      if (lista.length === 0) return { tipo: 'concluida' };
      if (!this.args.orcamento.cabe(UNIDADE_RECONCILE_LI.lote)) return { tipo: 'sem-orcamento' };
      return await this.lote(lista);
    } catch (err) {
      if (err instanceof ParadoNaFilaLi) return { tipo: 'parado' };
      if (!retentavelNaFilaLi(err)) throw err;
      if (this.args.deps.tentativa < TASK_MAX_ATTEMPTS - 1) return { tipo: 'falha', erro: err };
      // The queue's last attempt: what is left is counted, and the run goes to its end.
      const resto = this.args.candidatos.lista();
      this.contarPorConta(resto, 'naoEnfileirados');
      this.args.candidatos.substituir([]);
      this.args.deps.logger.error(
        `${TAG} tentativas esgotadas na fila — o resto não foi enfileirado`,
        {
          execucaoId: this.args.execucaoId,
          naoEnfileirados: resto.length,
          motivo: 'tentativas-esgotadas',
        },
      );
      return { tipo: 'concluida' };
    }
  }

  /** Counts each candidate of `lista` under its conta's `nome`. */
  private contarPorConta(lista: readonly CandidatoReconcileEstoqueLi[], nome: string): void {
    const porConta = new Map<number, number>();
    for (const c of lista) porConta.set(c.c, (porConta.get(c.c) ?? 0) + 1);
    for (const [idx, n] of porConta) this.contarDaConta(idx, nome, n);
  }

  /** The conta's state, or {@link ParadoNaFilaLi} when it is another run's. */
  private async estado(idx: number): Promise<EstadoContaReconcileLi> {
    const contaId = this.args.contas[idx];
    if (contaId === undefined)
      throw new TypeError('fila do reconcile: candidato de conta fora da lista');
    const estado = await this.args.estadoDe({ idx, contaId });
    if (estado === null) throw new ParadoNaFilaLi();
    return estado;
  }

  /**
   * The contas read again (module header, "One unit"): each conta that still has candidates and is
   * no longer the run's — gone, inactive, its depósito moved — loses them (ONE WARNING per conta
   * per run). Returns the indexes so blocked.
   */
  private async revisar(): Promise<Map<number, IndisponibilidadeContaLi>> {
    const lista = this.args.candidatos.lista();
    const comCandidatos = [...new Set(lista.map((c) => c.c))].sort((a, b) => a - b);
    this.revistas = await reverContasDoRunLi(this.args.db, this.args.contas);
    const bloqueadas = new Map<number, IndisponibilidadeContaLi>();
    for (const idx of comCandidatos) {
      const estado = await this.estado(idx);
      const motivo = indisponibilidadeDaContaLi(
        this.revistas.get(estado.conta.contaId),
        estado.conta.depositoId,
      );
      if (motivo === null) continue;
      bloqueadas.set(idx, motivo);
      if (this.daConta(idx, 'contaIndisponivel') === 0) {
        this.contarDaConta(idx, 'contaIndisponivel');
        this.args.deps.logger.warn(`${TAG} conta mudou durante a execução — nada dela é enviado`, {
          ...this.ids(idx),
          motivo,
        });
      }
    }
    if (bloqueadas.size > 0) {
      const ficam = lista.filter((c) => !bloqueadas.has(c.c));
      this.contarPorConta(
        lista.filter((c) => bloqueadas.has(c.c)),
        'candidatosBloqueados',
      );
      this.args.candidatos.substituir(ficam);
    }
    return bloqueadas;
  }

  /** The phase's start, once per run (module header, "Its start"). */
  private async iniciar(): Promise<PassoFilaLi> {
    const { valvula, contas, deps } = this.args;
    const ligada = valvula.modo === MODO_LI.on;
    const bloqueio = new Map<number, BloqueioFilaLi>();
    // 1. The safety gate, and the store phase's own block.
    for (const idx of contas.keys()) {
      if (this.daConta(idx, 'bloqueioForaDoSnapshot') > 0) bloqueio.set(idx, 'fora-do-snapshot');
      const avaliados = this.daConta(idx, 'avaliados');
      const zeroPorDeposito = this.daConta(idx, 'zeroPorDeposito');
      if (depositoSemRegistrosLi({ avaliados, zeroPorDeposito })) {
        bloqueio.set(idx, 'deposito-sem-registros');
        this.contarDaConta(idx, 'bloqueadoDeposito');
        deps.logger.error(`${TAG} depósito sem registros — nada desta conta é enviado`, {
          ...this.ids(idx),
          motivo: 'deposito-sem-registros',
          avaliados,
          zeroPorDeposito,
          limitePercentual: LIMITE_PERCENTUAL_SEM_REGISTRO_RECONCILE_LI,
        });
      }
    }
    // 2-3. The contas read again (only when something may be sent), then the per-target filters.
    if (ligada) {
      for (const [idx, motivo] of await this.revisar()) bloqueio.set(idx, motivo);
    }
    const lista = this.args.candidatos.lista();
    const porConta = contas.map(() => ({
      candidatos: 0,
      acima: 0,
      demais: 0,
      bloqueados: 0,
      foraDoCanario: 0,
    }));
    const ficam: CandidatoReconcileEstoqueLi[] = [];
    for (const c of lista) {
      const t = porConta[c.c];
      if (t === undefined) continue;
      t.candidatos += 1;
      if (c.d > 0) t.acima += 1;
      else t.demais += 1;
      if (!ligada) continue;
      if (bloqueio.has(c.c)) {
        t.bloqueados += 1;
        continue;
      }
      const alvo = decidirAlvo(valvula, { contaId: contas[c.c] ?? '', recurso: Number(c.i) });
      if (alvo.modo !== MODO_LI.on) {
        t.foraDoCanario += 1;
        continue;
      }
      ficam.push(c);
    }
    porConta.forEach((t, idx) => {
      this.contarDaConta(idx, 'candidatosBloqueados', t.bloqueados);
      this.contarDaConta(idx, 'foraDoCanario', t.foraDoCanario);
      deps.logger.info(`${TAG} fila da conta`, {
        ...this.ids(idx),
        modo: valvula.modo,
        candidatos: t.candidatos,
        acima: t.acima,
        demais: t.demais,
        bloqueio: bloqueio.get(idx) ?? null,
        bloqueados: t.bloqueados,
        foraDoCanario: t.foraDoCanario,
        descartados: this.daConta(idx, 'descartados'),
      });
    });
    this.args.candidatos.substituir(ordenarCandidatosEstoqueLi(ficam));
    this.args.contar('filaIniciada');
    return ficam.length === 0 ? { tipo: 'concluida' } : { tipo: 'unidade' };
  }

  /** The send task of one candidate: ids only, a kit's component records from its entry. */
  private async tarefaDe(c: CandidatoReconcileEstoqueLi): Promise<TarefaEstoqueSemJanelaLi> {
    const estado = await this.estado(c.c);
    const entrada = estado.entrada(c.i);
    const kit =
      entrada !== undefined &&
      entrada.f === FLAG_ENTRADA_ESTOQUE_LI.valido &&
      entrada.p === c.p &&
      entrada.k === true &&
      entrada.e != null
        ? entrada.e
        : null;
    return {
      contaId: estado.conta.contaId,
      produtoId: c.p,
      origem: ORIGEM_TAREFA_ESTOQUE_LI.reconcile,
      estoqueId: null,
      apagado: false,
      estoqueIds: kit,
      geracao: 0,
    };
  }

  /** ONE batch (module header, "One unit"). */
  private async lote(lista: readonly CandidatoReconcileEstoqueLi[]): Promise<PassoFilaLi> {
    const { db, deps, execucaoId } = this.args;
    const [cabeca] = lista;
    if (cabeca === undefined) return { tipo: 'concluida' };
    const acima = cabeca.d > 0;
    const lote: CandidatoReconcileEstoqueLi[] = [];
    for (const c of lista) {
      if (c.d > 0 !== acima || lote.length >= LOTE_FILA_RECONCILE_LI) break;
      lote.push(c);
    }
    // Every task of the batch built (and every state loaded) BEFORE the slot is reserved.
    const tarefas = await Promise.all(lote.map((c) => this.tarefaDe(c)));

    const reserva = await reservarSlotGlobalEstoqueLi(db, {
      quantidade: lote.length,
      agoraMs: deps.agoraMs,
      ...(acima ? {} : { ateHorizonteMs: HORIZONTE_SUBANUNCIO_RECONCILE_LI_MS }),
    });
    const horizonteArmazenadoMs =
      reserva.armazenadoMs === null ? null : reserva.armazenadoMs - reserva.agoraMs;
    if (reserva.excedeLimite) {
      this.contarPorConta(lista, 'slotEsgotado');
      this.args.candidatos.substituir([]);
      deps.logger.error(`${TAG} slot global além do limite de agendamento — nada enfileirado`, {
        execucaoId,
        motivo: 'slot-esgotado',
        restantes: lista.length,
        horizonteArmazenadoMs,
      });
      return { tipo: 'concluida' };
    }
    this.args.contar('reservasSlot');
    if (reserva.saturado && this.args.contador('filaSaturada') === 0) {
      this.args.contar('filaSaturada');
      deps.logger.error(`${TAG} slot global além do horizonte — a fila entra atrás dele`, {
        execucaoId,
        horizonteArmazenadoMs,
      });
    }
    const enviar = lote.slice(0, reserva.inicios.length);
    // The horizon cut: every row after the last instant reserved is deferred (all of them share the
    // batch's kind, and the list is sorted, so the rest of the list is too).
    const adiados = enviar.length < lote.length ? lista.slice(enviar.length) : [];

    this.agendador ??= deps.agendadorEstoque();
    const agendador = this.agendador;
    const janela = janelaEstoqueLi(this.args.runIniciadoEmMs);
    const envios = enviar.map((c, k) => ({
      c,
      tarefa: tarefas[k],
      inicio: reserva.inicios[k],
    }));
    const sairam = new Set<CandidatoReconcileEstoqueLi>();
    let transitoria: LiTarefasTransitoriasError | null = null;
    let desligadas = false;
    let outra: { readonly erro: unknown } | null = null;
    for (let i = 0; i < envios.length; i += CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI) {
      const rodada = envios.slice(i, i + CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI);
      const desfechos = await Promise.allSettled(
        rodada.map(({ tarefa, inicio }) => {
          if (tarefa === undefined || inicio === undefined) {
            throw new TypeError('fila do reconcile: envio sem tarefa ou sem instante');
          }
          return enfileirarTarefaEstoqueLi(agendador, deps.agoraMs, tarefa, {
            janela,
            naoAntesDeMs: inicio,
          });
        }),
      );
      for (const [j, d] of desfechos.entries()) {
        const c = rodada[j]?.c;
        if (c === undefined) continue;
        if (d.status === 'fulfilled') {
          sairam.add(c);
          this.contarDaConta(c.c, 'enfileirados');
          continue;
        }
        const erro: unknown = d.reason;
        if (erro instanceof LiTarefasDesligadasError) {
          desligadas = true;
        } else if (erro instanceof ZodError) {
          // The strict parse would refuse it on every attempt: counted, and it leaves the list.
          sairam.add(c);
          this.contarDaConta(c.c, 'recusadosFila');
        } else if (erro instanceof LiTarefasTransitoriasError) {
          transitoria ??= erro;
        } else {
          outra ??= { erro };
        }
      }
      if (desligadas || outra !== null) break;
    }

    if (desligadas) {
      const resto = lista.filter((c) => !sairam.has(c));
      this.contarPorConta(resto, 'naoEnfileirados');
      this.args.candidatos.substituir([]);
      deps.logger.warn(`${TAG} tarefas desligadas — o resto da fila não foi enfileirado`, {
        execucaoId,
        naoEnfileirados: resto.length,
      });
      return { tipo: 'concluida' };
    }
    const adiadosSet = new Set(adiados);
    if (adiados.length > 0) {
      this.contarPorConta(adiados, 'adiadosHorizonte');
      deps.logger.info(`${TAG} fila no horizonte — o resto fica para a próxima execução`, {
        execucaoId,
        adiados: adiados.length,
        horizonteMs: HORIZONTE_SUBANUNCIO_RECONCILE_LI_MS,
      });
    }
    this.args.candidatos.substituir(lista.filter((c) => !sairam.has(c) && !adiadosSet.has(c)));
    if (outra !== null) throw outra.erro;
    // A transient failure: the rest of the batch went out first; the retry re-meets it by name.
    if (transitoria !== null) throw transitoria;
    return this.args.candidatos.lista().length === 0 ? { tipo: 'concluida' } : { tipo: 'unidade' };
  }
}
