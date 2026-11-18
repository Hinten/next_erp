/**
 * The stock TRIGGER's work (master plan step 12, PR 12-f), for ONE write of an ERP stock record
 * `produtos/{produtoId}/estoques/{estoqueId}`: decide, as cheaply as possible, which send runs the
 * write may need, and enqueue them on the stock queue. The functions codebase binds it
 * (`functions/src/onEstoqueLojaIntegrada.ts`); here every input is injected — the environment,
 * the Firestore handle and the producer LAZILY, the clock, the logger.
 *
 * It fires on EVERY ERP stock write, every depósito and every channel included, so the gates run
 * from the cheapest up and each returns as early as it can:
 *
 *  1. **Relevance, from the payload alone** (`relevanciaEventoEstoqueLi`): ZERO reads, and no
 *     line. A `localizacao` edit, an `ultimaModificacao`-only update (the kit stamp) and the
 *     paid → shipped pair — quantity and reservation lowered by the same k — move no available
 *     quantity and stop here. The cap `LOJA_INTEGRADA_ESTOQUE_MAX` sharpens the answer; an
 *     unreadable cap is read as none here, so nothing is dropped before the gates that report it.
 *  2. **The valve** `LOJA_INTEGRADA_MODO_ESTOQUE`: `off` — unset, blank, a typo — returns with zero
 *     reads. An UNRECOGNISED value logs ONE WARNING run-start line per instance (latched: a line
 *     per relevant write ERP-wide would be noise). `dry-run` and `on` go on alike: the trigger
 *     reads no canary list and no read switch — those are the send run's.
 *  3. **The depósito** (`depositosLi.ts`): the record's stored ref, on each side of the write,
 *     looked up EXACTLY in the cached map of Loja Integrada contas — zero reads on a warm instance,
 *     one query per 15 min on a cold one. No conta concerned ⇒ return.
 *     Only now an unreadable cap is reported (ONE ERROR line) and stops the event: every run
 *     would refuse it, and an ERP-wide line for writes no Loja Integrada conta stocks from would
 *     drown the signal.
 *  4. **The links**, only when the write can move the produto's OWN published quantity: ONE
 *     where-less listing of `produtos/{p}/produtolojaintegrada`. A conta gets the DIRECT task
 *     exactly when its links make the produto one linked child (`vinculoDaContaLi`); the parity
 *     switch, the records and the store are the run's to read (a parity child costs one skipped
 *     run of three ERP reads).
 *  5. **The kits**, per concerned conta and whether or not the produto itself is linked: ONE
 *     `getAll` of the component's header in every concerned conta (`mapaKitsLi.ts`; NOT_FOUND is
 *     the common case). With the kits inline and `F` at most the eager ceiling
 *     (`LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX`, `configEstoqueLi.ts`): the zero-cost skip, or
 *     ONE `getAll` of the deduplicated siblings, then the tie-inclusive, fail-open filter
 *     (`kitsSinalizadosLi`) — one send task per flagged kit. Otherwise (more kits than the ceiling,
 *     or kits in shards): ONE fan-out task exactly when a kit can have crossed from positive to 0
 *     (`disparaKitsZeradosLi`); the shards are never read here.
 *
 * ## A sibling is read as the send run resolves it
 *
 * The header's `comps` names one record per sibling. When that record is not the CANONICAL one
 * (`makeEstoqueUid(sibling, depósito)`), the canonical path joins the SAME `getAll`: a canonical
 * record at the depósito wins (as `estoqueNoDepositoLi` resolves the two), else the named one
 * answers — so a legacy record left beside a newer canonical one never hides a move. A sibling
 * that is absent, at another depósito or unreadable is left out of the readings, and its kits flag.
 *
 * ## The enqueues, after EVERY read
 *
 * The clock is read inside each enqueue helper (`agendadorEstoque.ts`), immediately before its
 * enqueue — never the event's time, never a value captured before the reads — so a task's name
 * never meets a task that may already have dispatched. Every send task goes first (the direct
 * ones, then the flagged kits), at most {@link CONCORRENCIA_ENFILEIRAMENTO_GATILHO_LI} at a time;
 * the fan-out tasks go LAST, only once every send task was accepted, so an Eventarc retry after a
 * transient failure never enqueues a second fan-out for the same move. What a rejection means is
 * the producer's contract: an answered already-exists is success; the closed sweep-only valve is
 * ONE WARNING and the event's remaining enqueues are skipped; a transient Cloud Tasks failure is
 * rethrown for Eventarc's retry (the names make a retry inside the window idempotent; one in a
 * later window is one more run, never a loss); a payload the strict schema refuses is ONE WARNING
 * with field names, and only that task is skipped; anything else is rethrown untouched.
 *
 * ## What it never does
 *
 * It writes NOTHING to Firestore (so it cannot trigger itself, nor anything else), calls no Loja
 * Integrada endpoint and builds no client, never reads the produto document, the conta's
 * credential or the canary. Its lines carry ids and counts only, never a quantity or a value of
 * the environment. It must never name the Admin SDK's multi-document read-and-write call, and
 * never reads the process environment: `deps.ambiente` is the environment, passed in.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import {
  type KitsComponenteEstoqueLi,
  ORIGEM_TAREFA_ESTOQUE_LI,
  formasDoDepositoLi,
  makeEstoqueUid,
  vinculoDaContaLi,
} from '@delfrance/schemas';

import {
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  lerValvula,
  registrarValvulaLi,
} from '../core/valvulas';
import {
  type AgendadorEstoqueLi,
  LiTarefasDesligadasError,
  type TarefaEstoqueSemJanelaLi,
  enfileirarTarefaEstoqueKitsLi,
  enfileirarTarefaEstoqueLi,
} from './agendadorEstoque';
import {
  TETO_ESTOQUE_ENV_LI,
  TETO_KITS_IMEDIATOS_ENV_LI,
  lerTetoEstoqueLi,
  lerTetoKitsImediatosLi,
} from './configEstoqueLi';
import { type ContaDoDepositoLi, contasDoEventoLi, lerMapaDepositosLi } from './depositosLi';
import { lerVinculosDoProdutoLi } from './leituraEstoqueErp';
import { lerCabecalhosKitsLi, lerRegistrosPorCaminhoLi } from './mapaKitsLi';
import {
  type DadosEstoqueLi,
  type DisponivelDoEventoLi,
  disparaKitsZeradosLi,
  disponivelNoDepositoLi,
  irmaosParaLerLi,
  kitsSinalizadosLi,
  registroNoDepositoLi,
  relevanciaEventoEstoqueLi,
} from './planoEstoqueLi';
import { caminhoDeEstoqueLi, caminhoEstoqueLi } from './quantidadeEstoqueLi';

const TAG = '[loja-integrada/estoque] gatilho';

/**
 * The send tasks one event enqueues at a time. One event enqueues at most one direct task and
 * the eager ceiling's 30 kit tasks per concerned conta, so a handful of rounds stays far inside
 * an event function's default timeout.
 */
export const CONCORRENCIA_ENFILEIRAMENTO_GATILHO_LI = 8;

/** Everything one event needs — injected, so a test drives every gate with doubles. */
export interface DepsGatilhoEstoqueLi {
  /** The process environment: the valve, the cap and the eager ceiling are read from it. */
  readonly ambiente: AmbienteLi;
  /** Resolved LAZILY: an event that stops at the first two gates never builds the handle. */
  readonly db: () => Firestore;
  /** Built only when there is something to enqueue — the sweep-only valve is read at construction. */
  readonly agendador: () => AgendadorEstoqueLi;
  /** The clock, read only inside the enqueue helpers. */
  readonly agoraMs: () => number;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** One ERP stock-record write, as the trigger received it. */
export interface EventoEstoqueLi {
  readonly produtoId: string;
  readonly estoqueId: string;
  /** The record's data before the write; `null` on a create. */
  readonly antes: DadosEstoqueLi | null;
  /** The record's data after the write; `null` on a delete. */
  readonly depois: DadosEstoqueLi | null;
}

/** How one event ended — for tests and the caller; the lines are written here. */
export type ResultadoGatilhoEstoqueLi =
  /** Gate 1: no store quantity can move. Zero reads, no line. */
  | { readonly tipo: 'irrelevante' }
  /** Gate 2: the valve is `off`. Zero reads. */
  | { readonly tipo: 'desligado' }
  /** Gate 3: the record's depósito is no Loja Integrada conta's. Only the cached map read. */
  | { readonly tipo: 'fora-do-li' }
  /** `LOJA_INTEGRADA_ESTOQUE_MAX` unreadable: every run would refuse. ONE ERROR line. */
  | { readonly tipo: 'teto-invalido' }
  | {
      readonly tipo: 'processado';
      /** The concerned contas, sorted. */
      readonly contas: readonly string[];
      /** Send tasks accepted, by role, and fan-out tasks accepted. */
      readonly diretas: number;
      readonly kits: number;
      readonly fanouts: number;
      /** Tasks the strict schema refused (one WARNING each). */
      readonly recusadas: number;
      /** The sweep-only valve was closed: the rest of the event was not enqueued. */
      readonly tarefasDesligadas: boolean;
    };

/**
 * ONE WARNING per instance for an unrecognised valve (module header, gate 2): latched here,
 * because the trigger sees every relevant ERP stock write. A changed value means a redeploy,
 * which starts new instances.
 */
let valvulaNaoReconhecidaRegistrada = false;

/** Test-only: forget the latch of gate 2. */
export function __reiniciarGatilhoEstoqueParaTestes(): void {
  valvulaNaoReconhecidaRegistrada = false;
}

/** What gate 5 decided for one conta's header. */
type DecisaoKitsLi =
  | { readonly tipo: 'nenhum' }
  | {
      readonly tipo: 'imediato';
      readonly cabecalho: KitsComponenteEstoqueLi;
      /** The sibling paths the filter needs (`[]` on the zero-cost skip). */
      readonly irmaos: readonly string[];
    }
  | {
      readonly tipo: 'zerados';
      readonly cabecalho: KitsComponenteEstoqueLi;
      readonly dispara: boolean;
    };

/** One concerned conta's plan, decided after the reads. */
interface PlanoDaContaLi {
  readonly conta: ContaDoDepositoLi;
  readonly formas: readonly string[];
  readonly direta: boolean;
  readonly antes: DisponivelDoEventoLi;
  readonly depois: DisponivelDoEventoLi;
  readonly kits: DecisaoKitsLi;
}

/** One enqueue the event decided on. */
type EnvioLi =
  | {
      readonly tipo: 'estoque';
      readonly papel: 'direta' | 'kit';
      readonly tarefa: TarefaEstoqueSemJanelaLi;
    }
  | { readonly tipo: 'estoque-kits'; readonly contaId: string; readonly componenteId: string };

/**
 * The path of the CANONICAL record of the sibling whose record `caminho` names, at `depositoId`,
 * or `null` when it is that record already (or the ids cannot form a path).
 */
function caminhoCanonicoDoIrmao(caminho: string, depositoId: string): string | null {
  const partes = caminhoEstoqueLi(caminho);
  if (partes === null) return null;
  const canonico = caminhoDeEstoqueLi(
    partes.produtoId,
    makeEstoqueUid(partes.produtoId, depositoId),
  );
  return canonico === caminho ? null : canonico;
}

/**
 * The siblings' available quantities NOW, keyed by the path the header's `comps` names (module
 * header, "A sibling is read as the send run resolves it"): the canonical record when it is at
 * the depósito, else the named record when IT is; a value that is not a finite number is left out
 * (its kits flag).
 */
function leiturasDosIrmaos(
  irmaos: readonly string[],
  depositoId: string,
  formas: readonly string[],
  lidos: ReadonlyMap<string, DadosEstoqueLi | null>,
): Map<string, number> {
  const leituras = new Map<string, number>();
  for (const caminho of irmaos) {
    const canonico = caminhoCanonicoDoIrmao(caminho, depositoId);
    const dadosCanonico = canonico === null ? null : (lidos.get(canonico) ?? null);
    const dados =
      dadosCanonico !== null && registroNoDepositoLi(dadosCanonico, formas)
        ? dadosCanonico
        : (lidos.get(caminho) ?? null);
    const disponivel = disponivelNoDepositoLi(dados, formas);
    if (typeof disponivel === 'number' && Number.isFinite(disponivel)) {
      leituras.set(caminho, disponivel);
    }
  }
  return leituras;
}

/** The field names a strict parse refused, deduplicated and sorted — never a value. */
function camposDoZod(err: ZodError): string[] {
  return [...new Set(err.issues.map((i) => String(i.path[0] ?? '')))].sort();
}

/**
 * The stock trigger's work for ONE record write (module header). Never throws for an event that
 * is not ours; rethrows what Eventarc must retry.
 */
export async function tratarEventoEstoqueLi(
  deps: DepsGatilhoEstoqueLi,
  ev: EventoEstoqueLi,
): Promise<ResultadoGatilhoEstoqueLi> {
  // ---- Gate 1: the payload alone. Zero reads, no line. ----
  const teto = lerTetoEstoqueLi(deps.ambiente);
  const relevancia = relevanciaEventoEstoqueLi({
    antes: ev.antes,
    depois: ev.depois,
    cap: teto ?? Number.POSITIVE_INFINITY,
  });
  if (!relevancia.relevante) return { tipo: 'irrelevante' };

  // ---- Gate 2: the valve. Zero reads. ----
  const valvula = lerValvula(FLUXO_LI.estoque, deps.ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido && !valvulaNaoReconhecidaRegistrada) {
      valvulaNaoReconhecidaRegistrada = true;
      registrarValvulaLi(valvula, { conta: null });
    }
    return { tipo: 'desligado' };
  }

  // ---- Gate 3: the depósito, through the cached map. ----
  const db = deps.db();
  const contas = contasDoEventoLi(await lerMapaDepositosLi(db), ev.antes, ev.depois);
  if (contas.length === 0) return { tipo: 'fora-do-li' };
  const ids = { produtoId: ev.produtoId, estoqueId: ev.estoqueId };
  const contaIds = contas.map((c) => c.contaId);

  if (teto === null) {
    deps.logger.error(`${TAG} teto de estoque ilegível — nada enfileirado`, {
      ...ids,
      contas: contaIds,
      motivo: 'teto-invalido',
      variavel: TETO_ESTOQUE_ENV_LI,
    });
    return { tipo: 'teto-invalido' };
  }

  // ---- Gates 4 and 5: the links (only when a direct task is possible) and the headers. ----
  const [links, cabecalhos] = await Promise.all([
    relevancia.direta ? lerVinculosDoProdutoLi(db, ev.produtoId) : Promise.resolve(null),
    lerCabecalhosKitsLi(db, contaIds, ev.produtoId),
  ]);
  const tetoKits = lerTetoKitsImediatosLi(deps.ambiente);

  const planos: PlanoDaContaLi[] = contas.map((conta) => {
    const formas = formasDoDepositoLi(conta.depositoId);
    const antes = disponivelNoDepositoLi(ev.antes, formas);
    const depois = disponivelNoDepositoLi(ev.depois, formas);
    const direta = links !== null && vinculoDaContaLi(conta.contaId, links).tipo === 'vinculado';
    const lido = cabecalhos.get(conta.contaId) ?? { tipo: 'ausente' as const };
    let kits: DecisaoKitsLi = { tipo: 'nenhum' };
    if (lido.tipo === 'invalido') {
      deps.logger.warn(`${TAG} cabeçalho de kits fora do formato — kits não avaliados`, {
        ...ids,
        contaId: conta.contaId,
        campos: lido.campos,
      });
    } else if (lido.tipo === 'ok') {
      const { cabecalho } = lido;
      kits =
        cabecalho.kits !== null && cabecalho.F <= tetoKits.teto
          ? {
              tipo: 'imediato',
              cabecalho,
              irmaos: irmaosParaLerLi({
                cabecalho,
                componenteId: ev.produtoId,
                antes,
                depois,
                cap: teto,
              }),
            }
          : {
              tipo: 'zerados',
              cabecalho,
              dispara: disparaKitsZeradosLi({ antes, depois, qMax: cabecalho.qMax }),
            };
    }
    return { conta, formas, direta, antes, depois, kits };
  });

  if (!tetoKits.valido && planos.some((p) => p.kits.tipo !== 'nenhum')) {
    deps.logger.warn(`${TAG} teto de kits imediatos ilegível — só os kits zerados saem já`, {
      ...ids,
      variavel: TETO_KITS_IMEDIATOS_ENV_LI,
    });
  }

  // The siblings of every eager conta, and the canonical record beside each one the header
  // names by a legacy id: ONE getAll, only when the filter needs any.
  const caminhos = planos.flatMap((p) =>
    p.kits.tipo === 'imediato'
      ? p.kits.irmaos.flatMap((caminho) => {
          const canonico = caminhoCanonicoDoIrmao(caminho, p.conta.depositoId);
          return canonico === null ? [caminho] : [caminho, canonico];
        })
      : [],
  );
  const lidos = await lerRegistrosPorCaminhoLi(db, caminhos);

  // ---- The decisions, then the enqueues (send tasks first, fan-outs last). ----
  const envios: EnvioLi[] = [];
  const fanouts: EnvioLi[] = [];
  for (const p of planos) {
    const { contaId } = p.conta;
    if (p.direta) {
      envios.push({
        tipo: 'estoque',
        papel: 'direta',
        tarefa: {
          contaId,
          produtoId: ev.produtoId,
          origem: ORIGEM_TAREFA_ESTOQUE_LI.evento,
          estoqueId: ev.estoqueId,
          apagado: ev.depois === null,
          estoqueIds: null,
          geracao: 0,
        },
      });
    }
    if (p.kits.tipo === 'imediato') {
      const { cabecalho } = p.kits;
      const sinalizados = kitsSinalizadosLi({
        cabecalho,
        componenteId: ev.produtoId,
        antes: p.antes,
        depois: p.depois,
        cap: teto,
        leituras: leiturasDosIrmaos(p.kits.irmaos, p.conta.depositoId, p.formas, lidos),
      });
      deps.logger.info(`${TAG} kits`, {
        ...ids,
        contaId,
        F: cabecalho.F,
        caminho: 'imediato',
        irmaosLidos: p.kits.irmaos.length,
        sinalizados: sinalizados.length,
      });
      const kits = cabecalho.kits ?? {};
      for (const kitId of sinalizados) {
        const kit = kits[kitId];
        envios.push({
          tipo: 'estoque',
          papel: 'kit',
          tarefa: {
            contaId,
            produtoId: kitId,
            origem: ORIGEM_TAREFA_ESTOQUE_LI.kit,
            estoqueId: null,
            apagado: false,
            estoqueIds: Object.fromEntries(
              Object.keys(kit?.q ?? {}).map((c) => [
                c,
                Object.hasOwn(cabecalho.comps, c) ? (cabecalho.comps[c] ?? null) : null,
              ]),
            ),
            geracao: 0,
          },
        });
      }
    } else if (p.kits.tipo === 'zerados') {
      deps.logger.info(`${TAG} kits`, {
        ...ids,
        contaId,
        F: p.kits.cabecalho.F,
        caminho: 'zerados',
        dispara: p.kits.dispara,
      });
      if (p.kits.dispara) {
        fanouts.push({ tipo: 'estoque-kits', contaId, componenteId: ev.produtoId });
      }
    }
  }

  const resultado = {
    tipo: 'processado' as const,
    contas: contaIds,
    diretas: 0,
    kits: 0,
    fanouts: 0,
    recusadas: 0,
    tarefasDesligadas: false,
  };
  if (envios.length === 0 && fanouts.length === 0) return resultado;

  const agendador = deps.agendador();
  for (const lote of [envios, fanouts]) {
    for (let i = 0; i < lote.length; i += CONCORRENCIA_ENFILEIRAMENTO_GATILHO_LI) {
      const rodada = lote.slice(i, i + CONCORRENCIA_ENFILEIRAMENTO_GATILHO_LI);
      const desfechos = await Promise.allSettled(
        rodada.map((envio) => enfileirarUm(deps, agendador, envio, ids)),
      );
      // The sweep-only valve is read once, at the producer's construction: closed for one
      // enqueue, closed for all of them. One WARNING, and the event ends here.
      if (
        desfechos.some(
          (d) => d.status === 'rejected' && d.reason instanceof LiTarefasDesligadasError,
        )
      ) {
        deps.logger.warn(`${TAG} tarefas desligadas — o resto do evento não foi enfileirado`, {
          ...ids,
          diretas: resultado.diretas,
          kits: resultado.kits,
          fanouts: resultado.fanouts,
        });
        return { ...resultado, tarefasDesligadas: true };
      }
      rodada.forEach((envio, j) => {
        const d = desfechos[j];
        if (d?.status !== 'fulfilled') return;
        if (!d.value) resultado.recusadas += 1;
        else if (envio.tipo === 'estoque-kits') resultado.fanouts += 1;
        else if (envio.papel === 'direta') resultado.diretas += 1;
        else resultado.kits += 1;
      });
      // A transient Cloud Tasks failure, or anything else: rethrown as thrown, once the round's
      // other enqueues settled — and before any fan-out was attempted, if a send task failed.
      const falha = desfechos.find((d) => d.status === 'rejected');
      if (falha !== undefined) throw falha.reason;
    }
  }

  deps.logger.info(`${TAG} enfileirado`, {
    ...ids,
    contas: contaIds,
    diretas: resultado.diretas,
    kits: resultado.kits,
    fanouts: resultado.fanouts,
    recusadas: resultado.recusadas,
  });
  return resultado;
}

/**
 * ONE enqueue: `true` when accepted (an answered already-exists included), `false` when the
 * strict schema refused its payload (ONE WARNING, field names only). Any other rejection is the
 * caller's.
 */
async function enfileirarUm(
  deps: DepsGatilhoEstoqueLi,
  agendador: AgendadorEstoqueLi,
  envio: EnvioLi,
  ids: { readonly produtoId: string; readonly estoqueId: string },
): Promise<boolean> {
  try {
    if (envio.tipo === 'estoque') {
      await enfileirarTarefaEstoqueLi(agendador, deps.agoraMs, envio.tarefa);
    } else {
      await enfileirarTarefaEstoqueKitsLi(agendador, deps.agoraMs, {
        contaId: envio.contaId,
        componenteId: envio.componenteId,
      });
    }
    return true;
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    deps.logger.warn(`${TAG} tarefa fora do formato da fila de estoque — não enfileirada`, {
      ...ids,
      contaId: envio.tipo === 'estoque' ? envio.tarefa.contaId : envio.contaId,
      tipoTarefa: envio.tipo,
      campos: camposDoZod(err),
    });
    return false;
  }
}
