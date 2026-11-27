/**
 * The DAILY price step (step 13, PR 13-f): what the daily root
 * (`functions/src/reconciliacaoEstoque.ts`, `reconcileAmazonStock`, 03:44)
 * runs AFTER the stock step, whatever that step's outcome — ADOPTION only.
 * Per active Amazon conta, the price feed's daily backstop
 * (`adotarFeedParadoAmazon` with the price fluxo, `feeds/resultadoFeed.ts`): a
 * submitted price feed whose record has not moved for six hours gets ONE
 * adoption rung a day (a missing record is re-created from the lease first),
 * so its outcome is still read and written back. It never reads, re-kicks,
 * claims or starts a price RUN, and never builds or sends a feed: a stalled run
 * waits for the operator's next click, so no scheduled code leads to a price
 * send.
 *
 * ## In this order ({@link executarBackstopDiarioPrecoAmazon})
 *
 *  1. The read switch not exactly `on`, or the PRICE valve `off` ⇒ nothing:
 *     ZERO Firestore operations, NO line, no producer built — a gated price
 *     step is SILENT, so the root's gated run keeps the stock step's one line.
 *     The preview flag never makes a valve `off`, and an adoption sends nothing,
 *     so the raw valve is the gate.
 *  2. The contas, its OWN enumeration (`listarContasAmazon`, the existing
 *     `(tipo, nome)` query), uncached.
 *  3. Per active conta, one after another: a conta id outside the grammar ⇒
 *     `id-de-conta-invalido`, nothing read; else ONE adoption check (≤ 1 lease
 *     read, ≤ 1 record read, ≤ 1 record create, ≤ 1 named enqueue through the
 *     jobs producer, a THUNK built only for an enqueue). A Firestore status
 *     error, a lease or record that no longer parses, and a named failure of
 *     the jobs producer are CONTAINED for that conta (`falhou`, the class on its
 *     line — never a message, rule 6); anything else is a bug and fails the
 *     step. ONE `evento: 'preco'` line per conta (`fase: 'diario'`): INFO, or
 *     WARNING for a contained failure or an invalid id.
 *
 * The root writes the step's ONE summary ({@link resumirBackstopDiarioPrecoAmazon})
 * only when it walked the contas. D11: no Amazon call here; the adoption rung
 * reads Amazon only through the jobs queue's own context, behind the switch.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { idDeContaValido, listarContasAmazon } from '../core/contas';
import {
  type CampoLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import { FLUXO_AMAZON, MODO_AMAZON, lerChaveDeChamadasAmazon, lerValvula } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import {
  type AgendadorLotesAmazon,
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
} from '../feeds/agendadorLotes';
import {
  ACAO_ADOCAO_FEED,
  type AcaoAdocaoFeedAmazon,
  AmazonRegistroFeedInvalidoError,
  type ResultadoAdocaoFeedAmazon,
  adotarFeedParadoAmazon,
} from '../feeds/resultadoFeed';
import { AmazonVezFeedInvalidaError } from '../feeds/vezFeedFirestore';
import { contidoListingAmazon, falhaContidaListingAmazon } from '../listings/escritaListing';

/** The `fase` of the step's lines. */
export const FASE_BACKSTOP_DIARIO_PRECO = 'diario';

/** Why the whole step did nothing (module header, step 1). */
export const PORTAO_BACKSTOP_DIARIO_PRECO = {
  chamadasDesligadas: 'chamadas-desligadas',
  valvulaDesligada: 'valvula-desligada',
} as const;
export type PortaoBackstopDiarioPreco =
  (typeof PORTAO_BACKSTOP_DIARIO_PRECO)[keyof typeof PORTAO_BACKSTOP_DIARIO_PRECO];

/** How one conta's step ended (closed). */
export const DESFECHO_BACKSTOP_DIARIO_PRECO = {
  /** The adoption check ran (its answer in `adocao`). */
  feito: 'feito',
  /** The conta id is outside the conta id grammar: nothing read. */
  idDeContaInvalido: 'id-de-conta-invalido',
  /** A named failure, contained for this conta (its class in `erro`). */
  falhou: 'falhou',
} as const;
export type DesfechoBackstopDiarioPreco =
  (typeof DESFECHO_BACKSTOP_DIARIO_PRECO)[keyof typeof DESFECHO_BACKSTOP_DIARIO_PRECO];

/** What the step needs — bound by `functions/src/reconciliacaoEstoque.ts`. */
export interface DepsBackstopDiarioPrecoAmazon {
  readonly db: Firestore;
  /** The process environment: the read switch and the price valve, read before any Firestore read. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** The jobs queue's producer — built only when an adoption rung is enqueued. */
  readonly agendador: () => AgendadorLotesAmazon;
}

/** One conta's step (logged ONCE). */
export interface ResultadoContaBackstopDiarioPreco {
  readonly contaId: string;
  readonly desfecho: DesfechoBackstopDiarioPreco;
  /** The adoption check's answer, when it ran to its end. */
  readonly adocao: AcaoAdocaoFeedAmazon | null;
  /** The feed record the check re-created from the lease, if it did. */
  readonly registro: ResultadoAdocaoFeedAmazon['registro'];
  /** A contained failure's CLASS — never its message. */
  readonly erro: string | null;
}

export interface ResultadoBackstopDiarioPreco {
  /** Why the step did nothing at all; `null` when it walked the contas. */
  readonly portao: PortaoBackstopDiarioPreco | null;
  readonly contas: readonly ResultadoContaBackstopDiarioPreco[];
}

/**
 * The failures one conta's check CONTAINS (module header, step 3): Firestore's
 * status errors, a stored lease or record that no longer parses, and the jobs
 * producer's named refusals (its valve, its region, a transient, a raw Cloud
 * Tasks failure).
 */
const FALHA_CONTIDA = falhaContidaListingAmazon([
  AmazonLotesTarefasDesligadasError,
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonVezFeedInvalidaError,
  AmazonRegistroFeedInvalidoError,
]);

/** One conta's adoption check (module header, step 3), contained by class. */
async function contaDoBackstop(
  contaId: string,
  deps: DepsBackstopDiarioPrecoAmazon,
): Promise<ResultadoContaBackstopDiarioPreco> {
  let erro: string | null = null;
  const r = await contidoListingAmazon(
    () =>
      adotarFeedParadoAmazon(
        deps.db,
        { fluxo: FLUXO_AMAZON.preco, contaId },
        { agora: deps.agora, agendador: deps.agendador },
      ),
    FALHA_CONTIDA,
    (classe) => {
      erro = classe;
    },
  );
  if (r === null) {
    return {
      contaId,
      desfecho: DESFECHO_BACKSTOP_DIARIO_PRECO.falhou,
      adocao: null,
      registro: null,
      erro,
    };
  }
  return {
    contaId,
    desfecho: DESFECHO_BACKSTOP_DIARIO_PRECO.feito,
    adocao: r.acao,
    registro: r.registro,
    erro: null,
  };
}

/**
 * The daily price step (module header). Gated ⇒ `{ portao, contas: [] }` with
 * nothing read and nothing logged.
 *
 * @throws anything a conta's check does not contain (a bug), and the conta
 *   listing's own Firestore failure, untouched: the root rethrows it after the
 *   stock step has run.
 */
export async function executarBackstopDiarioPrecoAmazon(
  deps: DepsBackstopDiarioPrecoAmazon,
): Promise<ResultadoBackstopDiarioPreco> {
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    return { portao: PORTAO_BACKSTOP_DIARIO_PRECO.chamadasDesligadas, contas: [] };
  }
  if (lerValvula(FLUXO_AMAZON.preco, deps.ambiente).modo === MODO_AMAZON.off) {
    return { portao: PORTAO_BACKSTOP_DIARIO_PRECO.valvulaDesligada, contas: [] };
  }

  const { contas } = await listarContasAmazon(deps.db);
  const resultados: ResultadoContaBackstopDiarioPreco[] = [];
  for (const conta of contas) {
    if (!conta.ativo) continue;
    const contaId = conta.integracaoId;
    const r = idDeContaValido(contaId)
      ? await contaDoBackstop(contaId, deps)
      : {
          contaId,
          desfecho: DESFECHO_BACKSTOP_DIARIO_PRECO.idDeContaInvalido,
          adocao: null,
          registro: null,
          erro: null,
        };
    resultados.push(r);
    const severidade: SeveridadeAmazon =
      r.desfecho === DESFECHO_BACKSTOP_DIARIO_PRECO.feito ? 'INFO' : 'WARNING';
    registrarEventoAmazon(
      deps.logger,
      'preco',
      severidade,
      `[amazon/preco] passo diário de preço da conta: ${r.desfecho}`,
      {
        fase: FASE_BACKSTOP_DIARIO_PRECO,
        etapa: 'adocao',
        desfecho: r.desfecho,
        adocao: r.adocao,
        registro: r.registro,
        erro: r.erro,
      },
      { conta: contaId, fluxo: FLUXO_AMAZON.preco },
    );
  }
  return { portao: null, contas: resultados };
}

/** The step's counters, FLAT, for the root's summary line: the contas by outcome and the feeds adopted. */
export function resumirBackstopDiarioPrecoAmazon(
  r: ResultadoBackstopDiarioPreco,
): Readonly<Record<string, CampoLogAmazon>> {
  const saida: Record<string, CampoLogAmazon> = {
    fase: FASE_BACKSTOP_DIARIO_PRECO,
    etapa: 'adocao',
    portao: r.portao,
    contas: r.contas.length,
  };
  let adotadas = 0;
  for (const c of r.contas) {
    const chave = `desfecho_${c.desfecho}`;
    const atual = saida[chave];
    saida[chave] = (typeof atual === 'number' ? atual : 0) + 1;
    if (c.adocao === ACAO_ADOCAO_FEED.adotada) adotadas += 1;
  }
  saida.adotadas = adotadas;
  return saida;
}
