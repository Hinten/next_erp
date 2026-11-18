/**
 * The `estoque-kits` FAN-OUT (master plan step 12, PR 12-f): ONE task of the stock queue, for ONE
 * component of ONE conta whose store kits outnumber the eager ceiling. The stock trigger enqueues
 * it exactly when a kit can have gone from positive to 0 through this component
 * (`disparaKitsZeradosLi`); here the map is read and an `estoque` send task (origin `kit`) is
 * enqueued for every kit this component alone NOW holds at 0 (`kitsZeradosPeloComponenteLi`: a
 * superset of the kits that crossed, and no sibling read). Every other change of such a kit waits
 * for the nightly reconcile. The queue (`functions/src/filaEstoque.ts`) routes the raw `tipo`
 * here.
 *
 * ## Order, every refusal before the slot
 *
 *  1. The payload, strict (`tarefaEstoqueKitsLiSchema`) — `payload-invalido`, zero reads.
 *  2. The valve `LOJA_INTEGRADA_MODO_ESTOQUE`: `off` — unset, blank, a typo (one WARNING) —
 *     returns with zero reads. `dry-run` and `on` go on alike: the sends it enqueues are the ones
 *     that read the store, and they honour the valve themselves.
 *  3. The cap `LOJA_INTEGRADA_ESTOQUE_MAX` (`configEstoqueLi.ts`): unreadable ⇒ ONE ERROR and
 *     zero reads — every send would refuse it.
 *  4. The conta through the cached reader the send run uses (`lerContaEmCache`): gone, not a Loja
 *     Integrada conta, inactive, or with no depósito ⇒ `pulado`.
 *  5. In parallel: the component's header in the conta (`mapaKitsLi.ts`) and its OWN stock at the
 *     depósito, read as the send run reads it — the canonical record by id, else the two-form
 *     query, resolved canonical-wins (`estoqueNoDepositoLi`). No record, two legacy ones, or an
 *     unreadable count ⇒ the available is taken as 0: every kit is enqueued (fail open).
 *     No header ⇒ `sem-mapa`; one off its refined schema ⇒ ONE WARNING and `mapa-invalido`.
 *  6. The kits: inline, or the header's shards in ONE `getAll`. A shard read that does not account
 *     for every kit (a missing, invalid or other-run shard, a repeat, or a count other than `F`) is
 *     ONE WARNING; before the queue's last attempt it throws {@link LiMapaKitsEstoqueIncompletoError}
 *     so a retry 300 s later reads the map after its writer finished; on the last attempt the kits
 *     that WERE read go on (the over-inclusive direction).
 *  7. Nothing at 0 ⇒ `nenhum`, and NO write.
 *  8. The global slot (`slotEstoqueLi.ts`): n instants reserved, its ONLY Firestore write. A
 *     saturated slot (beyond the horizon) is ONE ERROR line and the run starts at the floor.
 *  9. The enqueues, {@link CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI} at a time, each named by
 *     THIS task's window and scheduled at exactly its reserved instant (`agendadorEstoque.ts`, "A
 *     bulk enqueue"), so a retry of this task re-meets its own sends instead of doubling them.
 *
 * ## What a rejection means
 *
 * An answered already-exists is success (the send is queued). The closed sweep-only valve is ONE
 * WARNING and ends the run (`tarefas-desligadas`; the slot already moved — harmless). A payload
 * the strict schema refuses is counted and ONE WARNING names its fields. A transient Cloud Tasks
 * failure lets the rest of the batch finish, then the FIRST one is rethrown once, so the queue's
 * retry has as little left to redo as possible; anything else is rethrown at the end of its round.
 * Every retry re-derives everything from fresh reads.
 *
 * ## What it never does
 *
 * It calls no Loja Integrada endpoint and builds no client; it reads no sibling, no produto and no
 * credential; its only write is the slot's `proximoSlotMs`. It never names the Admin SDK's
 * multi-document read-and-write call, and never reads the process environment (`deps.ambiente`).
 * Its lines carry ids and counts only.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  INTEGRACAO_TIPO,
  type KitDoComponenteEstoqueLi,
  depositoDaContaLi,
  estoqueNoDepositoLi,
  formasDoDepositoLi,
  makeEstoqueUid,
  tarefaEstoqueKitsLiSchema,
} from '@delfrance/schemas';

import { lerContaEmCache } from '../core/contaCache';
import {
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  lerValvula,
  registrarValvulaLi,
} from '../core/valvulas';
import {
  type AgendadorEstoqueLi,
  CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  enfileirarTarefaEstoqueLi,
} from './agendadorEstoque';
import { TETO_ESTOQUE_ENV_LI, lerTetoEstoqueLi } from './configEstoqueLi';
import { lerEstoqueProprioLi } from './leituraEstoqueErp';
import { lerCabecalhosKitsLi, lerFatiasKitsLi, tarefaDoKitLi } from './mapaKitsLi';
import { disponivelNoDepositoLi, kitsZeradosPeloComponenteLi } from './planoEstoqueLi';
import { reservarSlotGlobalEstoqueLi } from './slotEstoqueLi';

const TAG = '[loja-integrada/estoque] kits';

/** What one fan-out needs — injected; the functions codebase binds it (`depsEscrita.ts`). */
export interface DepsKitsEstoqueLi {
  /** The process environment: the valve and the cap are read from it. */
  readonly ambiente: AmbienteLi;
  /** The live clock, read after the slot's read and inside each enqueue. */
  readonly agoraMs: () => number;
  /** The Cloud Tasks attempt, 0-based. */
  readonly tentativa: number;
  readonly agendador: AgendadorEstoqueLi;
  readonly logger: {
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** The shard read did not account for every kit, before the queue's last attempt (module header, step 6). */
export class LiMapaKitsEstoqueIncompletoError extends Error {
  readonly contaId: string;
  readonly componenteId: string;

  constructor(contaId: string, componenteId: string) {
    super(
      `O mapa de kits do componente ${componenteId} (conta ${contaId}) está incompleto — ` +
        'a tarefa tenta de novo depois',
    );
    this.name = 'LiMapaKitsEstoqueIncompletoError';
    this.contaId = contaId;
    this.componenteId = componenteId;
  }
}

/** Why a fan-out stopped before the slot. */
export type MotivoPuloKitsEstoqueLi =
  | 'conta-inexistente'
  | 'conta-inativa'
  | 'conta-sem-deposito'
  | 'sem-mapa'
  | 'mapa-invalido';

/** The counts of a fan-out that read its map — what the queue line reports. */
export interface ContagensKitsEstoqueLi {
  /** The header's `F`. */
  readonly F: number;
  /** The kits the map read gave (all `F` when it is complete). */
  readonly kitsLidos: number;
  /** The kits this component holds at 0. */
  readonly zerados: number;
  /** Their sends accepted (an answered already-exists included). */
  readonly enfileirados: number;
  /** Sends the strict schema refused. */
  readonly recusados: number;
  /** `proximoSlotMs − now` after the reservation, in ms; `null` when nothing was reserved. */
  readonly horizonteMs: number | null;
}

/** Every outcome of one fan-out. */
export type ResultadoKitsEstoqueLi =
  | { readonly kind: 'payload-invalido' }
  /** The valve is `off`: nothing was read. */
  | { readonly kind: 'desligado' }
  /** The cap cannot be read: nothing was read. */
  | { readonly kind: 'teto-invalido' }
  | { readonly kind: 'pulado'; readonly motivo: MotivoPuloKitsEstoqueLi }
  /** No kit at 0: nothing reserved, nothing written. */
  | { readonly kind: 'nenhum'; readonly contagens: ContagensKitsEstoqueLi }
  | { readonly kind: 'enfileirado'; readonly contagens: ContagensKitsEstoqueLi }
  /** The sweep-only valve closed the queue mid-batch: the rest was not enqueued. */
  | { readonly kind: 'tarefas-desligadas'; readonly contagens: ContagensKitsEstoqueLi };

/** The field names a strict parse refused, deduplicated and sorted — never a value. */
function camposDoZod(err: ZodError): string[] {
  return [...new Set(err.issues.map((i) => String(i.path[0] ?? '')))].sort();
}

/**
 * One fan-out, start to finish (module header). Deterministic outcomes RETURN; what the queue must
 * retry rethrows the ORIGINAL error. `dados` is the task's RAW data.
 */
export async function processarTarefaEstoqueKitsLi(
  db: Firestore,
  dados: unknown,
  deps: DepsKitsEstoqueLi,
): Promise<ResultadoKitsEstoqueLi> {
  // 1. The payload: ids only.
  const lida = tarefaEstoqueKitsLiSchema.safeParse(dados);
  if (!lida.success) return { kind: 'payload-invalido' };
  const tarefa = lida.data;
  const ids = { contaId: tarefa.contaId, componenteId: tarefa.componenteId };

  // 2. The valve. Zero reads.
  const valvula = lerValvula(FLUXO_LI.estoque, deps.ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido) registrarValvulaLi(valvula, { conta: tarefa.contaId });
    return { kind: 'desligado' };
  }

  // 3. The cap. Zero reads.
  if (lerTetoEstoqueLi(deps.ambiente) === null) {
    deps.logger.error(`${TAG} teto de estoque ilegível — nada enfileirado`, {
      ...ids,
      motivo: 'teto-invalido',
      variavel: TETO_ESTOQUE_ENV_LI,
    });
    return { kind: 'teto-invalido' };
  }

  // 4. The conta and its depósito, as the send run reads them.
  const conta = await lerContaEmCache(db, tarefa.contaId);
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.lojaIntegrada) {
    return { kind: 'pulado', motivo: 'conta-inexistente' };
  }
  if (conta.ativo === false) return { kind: 'pulado', motivo: 'conta-inativa' };
  const depositoId = depositoDaContaLi(conta);
  if (depositoId === null) {
    deps.logger.warn(`${TAG} conta sem depósito — nada enfileirado`, {
      ...ids,
      motivo: 'conta-sem-deposito',
    });
    return { kind: 'pulado', motivo: 'conta-sem-deposito' };
  }

  // 5. The header and the component's own stock, in parallel.
  const [cabecalhos, registros] = await Promise.all([
    lerCabecalhosKitsLi(db, [tarefa.contaId], tarefa.componenteId),
    lerEstoqueProprioLi(
      db,
      tarefa.componenteId,
      depositoId,
      makeEstoqueUid(tarefa.componenteId, depositoId),
    ),
  ]);
  const lido = cabecalhos.get(tarefa.contaId) ?? { tipo: 'ausente' as const };
  if (lido.tipo === 'ausente') return { kind: 'pulado', motivo: 'sem-mapa' };
  if (lido.tipo === 'invalido') {
    deps.logger.warn(`${TAG} cabeçalho de kits fora do formato — nada enfileirado`, {
      ...ids,
      campos: lido.campos,
    });
    return { kind: 'pulado', motivo: 'mapa-invalido' };
  }
  const { cabecalho } = lido;
  const estoque = estoqueNoDepositoLi({
    produtoId: tarefa.componenteId,
    depositoId,
    registros,
  });
  const lidoDisponivel =
    estoque.tipo === 'um'
      ? disponivelNoDepositoLi(estoque.registro.dados, formasDoDepositoLi(depositoId))
      : null;
  const disponivel =
    typeof lidoDisponivel === 'number' && Number.isFinite(lidoDisponivel) ? lidoDisponivel : 0;

  // 6. The kits: inline, or the shards.
  let kits: Readonly<Record<string, KitDoComponenteEstoqueLi>>;
  if (cabecalho.kits !== null) {
    kits = cabecalho.kits;
  } else {
    const fatias = await lerFatiasKitsLi(db, tarefa.contaId, tarefa.componenteId, cabecalho);
    if (!fatias.completa) {
      const ultima = deps.tentativa >= TASK_MAX_ATTEMPTS - 1;
      deps.logger.warn(`${TAG} mapa de kits incompleto`, {
        ...ids,
        F: cabecalho.F,
        fatias: cabecalho.fatias,
        kitsLidos: Object.keys(fatias.kits).length,
        ausentes: fatias.ausentes,
        invalidas: fatias.invalidas,
        deOutraExecucao: fatias.deOutraExecucao,
        repetidos: fatias.repetidos,
        acao: ultima ? 'segue-com-os-lidos' : 'tenta-de-novo',
      });
      if (!ultima) throw new LiMapaKitsEstoqueIncompletoError(tarefa.contaId, tarefa.componenteId);
    }
    kits = fatias.kits;
  }

  // 7. The kits this component holds at 0.
  const zerados = kitsZeradosPeloComponenteLi({
    kits,
    componenteId: tarefa.componenteId,
    disponivel,
  });
  const contagens = {
    F: cabecalho.F,
    kitsLidos: Object.keys(kits).length,
    zerados: zerados.length,
    enfileirados: 0,
    recusados: 0,
    horizonteMs: null as number | null,
  };
  if (zerados.length === 0) return { kind: 'nenhum', contagens };

  // 8. The global slot: the run's only write.
  const reserva = await reservarSlotGlobalEstoqueLi(db, {
    quantidade: zerados.length,
    agoraMs: deps.agoraMs,
    doPiso: deps.tentativa > 0,
  });
  contagens.horizonteMs = reserva.proximoMs - reserva.agoraMs;
  if (reserva.saturado && reserva.armazenadoMs !== null) {
    deps.logger.error(`${TAG} slot global além do horizonte — este fan-out parte do piso`, {
      ...ids,
      F: cabecalho.F,
      zerados: zerados.length,
      horizonteArmazenadoMs: reserva.armazenadoMs - reserva.agoraMs,
    });
  }

  // 9. The enqueues: named by THIS task's window, each at its reserved instant.
  let transitoria: LiTarefasTransitoriasError | null = null;
  const camposRecusados = new Set<string>();
  for (let i = 0; i < zerados.length; i += CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI) {
    const rodada = zerados.slice(i, i + CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI);
    const desfechos = await Promise.allSettled(
      rodada.map((kitId, j) =>
        enfileirarTarefaEstoqueLi(
          deps.agendador,
          deps.agoraMs,
          tarefaDoKitLi(tarefa.contaId, kitId, kits[kitId], cabecalho.comps),
          { janela: tarefa.janela, naoAntesDeMs: reserva.inicios[i + j] },
        ),
      ),
    );
    let outra: { readonly erro: unknown } | null = null;
    for (const d of desfechos) {
      if (d.status === 'fulfilled') {
        contagens.enfileirados += 1;
        continue;
      }
      const erro: unknown = d.reason;
      if (erro instanceof LiTarefasDesligadasError) {
        // Read once, at the producer's construction: closed for one, closed for all.
        deps.logger.warn(`${TAG} tarefas desligadas — o resto do fan-out não foi enfileirado`, {
          ...ids,
          zerados: zerados.length,
          enfileirados: contagens.enfileirados,
        });
        return { kind: 'tarefas-desligadas', contagens };
      }
      if (erro instanceof ZodError) {
        contagens.recusados += 1;
        for (const campo of camposDoZod(erro)) camposRecusados.add(campo);
      } else if (erro instanceof LiTarefasTransitoriasError) {
        transitoria ??= erro;
      } else {
        outra ??= { erro };
      }
    }
    if (outra !== null) throw outra.erro;
  }
  if (camposRecusados.size > 0) {
    deps.logger.warn(`${TAG} tarefas fora do formato da fila de estoque — não enfileiradas`, {
      ...ids,
      recusados: contagens.recusados,
      campos: [...camposRecusados].sort(),
    });
  }
  // A transient failure: the rest of the batch went out first; the retry re-meets it by name.
  if (transitoria !== null) throw transitoria;
  return { kind: 'enfileirado', contagens };
}
