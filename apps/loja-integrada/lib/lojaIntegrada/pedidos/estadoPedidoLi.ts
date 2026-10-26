/**
 * The Loja Integrada order's estado and payment status (master plan steps 5 and
 * 6, PR 5-b): its situação HISTORY read and cut at the observed situação, the
 * "captured" verdict and the two dates it yields, the target the shared table
 * gives, and the rules that decide whether a STORED pedido or pagamento may be
 * moved to it.
 *
 * PURE: no Firestore, no wire call, no clock. Every function is total over its
 * inputs, which is what lets the importer re-derive each decision from the
 * snapshot it is about to write against (root `CLAUDE.md` rule 7) instead of
 * re-applying one taken earlier.
 *
 * ## Codigo only
 *
 * Estado and payment status come from the situação codigo through one shared
 * table (`SITUACOES_LI`, `@delfrance/schemas`), never from the situação flags.
 * Codigos are compared EXACTLY: `'Pedido_Pago'` and `'pedido_pago '` are
 * unknown codigos, never paid ones.
 *
 * ## The history, cut at the observed situação
 *
 * The detail is read before the history, so the history may already hold a
 * change the detail does not show. Every verdict is therefore taken on the
 * history CUT at the last row reaching the detail's codigo (or before the first
 * row, for an order still at `pedido_efetuado`), never on the whole history,
 * and history `data` is never compared with the detail's modification stamp.
 *
 * "Captured" means the cut history holds a capture-evidence codigo
 * (`CODIGOS_LI_CAPTURADO`: the paid ones plus the dispute, the chargeback and
 * the refund without return) — as a row's situação or as the situação a row
 * left — or the detail's codigo is one. The approval date is the `data` of the
 * first row reaching a capture-evidence codigo; the cancellation date is the
 * `data` of the row reaching the detail's codigo when that codigo is a reversal
 * (7, 8, 16 or 1020). A detail codigo the table does not know derives NEITHER
 * date: the import keeps the stored payment status for it, so it keeps the
 * stored dates too.
 *
 * ## Strict and degraded
 *
 * A history can have holes: no row reaching the detail's codigo (other than
 * `pedido_efetuado`, which has no creation row), a row whose previous situação
 * is not the one before it, a first row that did not start from
 * `pedido_efetuado`, a row whose `data` cannot be read or that names another
 * order. On the queue's first two attempts ({@link modoHistoricoLi}) a hole
 * refuses (`ok: false`), and the importer retries. From the third attempt, and
 * in every sweep run, the decision is taken from what was read plus the
 * detail's codigo, and a date the holes could have moved is marked NOT
 * DERIVABLE (`derivavel: false`): an update keeps the stored date, a create
 * stores `null`. So a permanent hole costs two backoffs, never a parked order.
 */
import {
  CODIGOS_LI_CAPTURADO,
  CODIGOS_LI_ESTORNO,
  CODIGO_SITUACAO_LI,
  ESTADO_PEDIDO,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  MOTIVO_REVERSAO_COM_ETIQUETA_LI,
  STATUS_PAGAMENTO,
  alvoDeCriacaoLi,
  estadoPedidoSchema,
  estoqueAplicadoSchema,
  situacaoLi,
  statusPagamentoSchema,
  type EstadoPedido,
  type MotivoPedidoContestadoLi,
  type MotivoReversaoComEtiquetaLi,
  type SituacaoLi,
  type StatusPagamento,
} from '@delfrance/schemas';
import { temMovimentoAplicado } from '@delfrance/data/pedido';
import type { SituacaoHistoricoLinhaLi } from '@delfrance/integrations-loja-integrada';

import { dataLiParaMicros, lerDataLi } from './dataLi';

/* -------------------------------------------------------------------------- */
/*                                the history                                  */
/* -------------------------------------------------------------------------- */

/**
 * The four reversal rungs, each with the `lojaIntegradaReversaoComEtiqueta`
 * motivo that names it. Their rows DATE a cancellation (below), and a reversal
 * landing on a pedido whose label was bought raises that aviso
 * (`importarPedido.ts`, step 11).
 */
const MOTIVO_POR_REVERSAO: ReadonlyMap<string, MotivoReversaoComEtiquetaLi> = new Map<
  string,
  MotivoReversaoComEtiquetaLi
>([
  [CODIGO_SITUACAO_LI.pedidoCancelado, MOTIVO_REVERSAO_COM_ETIQUETA_LI.cancelado],
  [CODIGO_SITUACAO_LI.pagamentoDevolvido, MOTIVO_REVERSAO_COM_ETIQUETA_LI.devolvido],
  [CODIGO_SITUACAO_LI.pedidoChargeback, MOTIVO_REVERSAO_COM_ETIQUETA_LI.chargeback],
  [
    CODIGO_SITUACAO_LI.pagamentoDevolvidoSemRetorno,
    MOTIVO_REVERSAO_COM_ETIQUETA_LI.devolvidoSemRetorno,
  ],
]);

/** The codigos whose row DATES a cancellation: the four reversal rungs. */
const CODIGOS_REVERSAO: ReadonlySet<string> = new Set<string>(MOTIVO_POR_REVERSAO.keys());

/**
 * The reversal a codigo is — `cancelado`, `devolvido`, `chargeback` or
 * `devolvido-sem-retorno` — or `null` for every other codigo: a cancellation
 * REQUEST (1019) and a dispute (6) are no reversal. EXACT, like every codigo
 * comparison here.
 */
export function motivoReversaoLi(codigo: string): MotivoReversaoComEtiquetaLi | null {
  return MOTIVO_POR_REVERSAO.get(codigo) ?? null;
}

/** How the history is read: refusing holes, or deciding around them. */
export type ModoHistoricoLi = 'estrito' | 'degradado';

/** Named members of {@link ModoHistoricoLi}. */
export const MODO_HISTORICO_LI = {
  estrito: 'estrito',
  degradado: 'degradado',
} as const satisfies Record<string, ModoHistoricoLi>;

/**
 * Strict on the queue's attempts 0 and 1; degraded from attempt 2 and in every
 * sweep run (`tentativa` `null`).
 */
export function modoHistoricoLi(tentativa: number | null): ModoHistoricoLi {
  return tentativa === 0 || tentativa === 1
    ? MODO_HISTORICO_LI.estrito
    : MODO_HISTORICO_LI.degradado;
}

/** A hole in an order's situação history (module header). */
export type LacunaHistoricoLi =
  /** A row about another order: dropped. */
  | 'numero-divergente'
  /** A row whose `data` is not a stamp `lerDataLi` reads: dropped. */
  | 'data-ilegivel'
  /** The first row did not start from `pedido_efetuado`: older rows are missing. */
  | 'inicio-truncado'
  /** A row's previous situação is not the situação of the row before it. */
  | 'cadeia-quebrada'
  /** No row reaches the detail's codigo (and it is not `pedido_efetuado`). */
  | 'codigo-ausente';

/** Named members of {@link LacunaHistoricoLi}. */
export const LACUNA_HISTORICO_LI = {
  numeroDivergente: 'numero-divergente',
  dataIlegivel: 'data-ilegivel',
  inicioTruncado: 'inicio-truncado',
  cadeiaQuebrada: 'cadeia-quebrada',
  codigoAusente: 'codigo-ausente',
} as const satisfies Record<string, LacunaHistoricoLi>;

/** One history row, normalised: its stamp read, its codigos as text. */
export interface LinhaHistoricoLi {
  readonly id: number;
  /** The canonical stamp (`lerDataLi`). */
  readonly data: string;
  /** The same stamp as an instant, µs (`dataLiParaMicros`). */
  readonly dataUs: number;
  readonly codigo: string;
  readonly codigoAnterior: string | null;
}

/**
 * A date the history yields: derivable (a value, or `null` when there is none
 * to derive), or NOT derivable because a hole could have moved it.
 */
export type DataDoHistoricoLi =
  | { readonly derivavel: true; readonly us: number | null }
  | { readonly derivavel: false };

export interface EntradaHistoricoLi {
  /** The detail's `numero`. */
  readonly numero: number;
  /** The detail's `situacao.codigo`, verbatim. */
  readonly codigoDetalhe: string;
  /** Every row of every page, as read. */
  readonly linhas: readonly SituacaoHistoricoLinhaLi[];
  readonly modo: ModoHistoricoLi;
}

export type LeituraHistoricoLi =
  /** Strict mode found a hole: the importer retries. */
  | { readonly ok: false; readonly lacunas: readonly LacunaHistoricoLi[] }
  | {
      readonly ok: true;
      /** Holes were found and decided around (degraded mode): log a WARNING. */
      readonly lacunas: readonly LacunaHistoricoLi[];
      /** The rows up to the cut, oldest first. */
      readonly corte: readonly LinhaHistoricoLi[];
      readonly capturado: boolean;
      readonly dataAprovacao: DataDoHistoricoLi;
      readonly dataCancelamento: DataDoHistoricoLi;
    };

const NAO_DERIVAVEL: DataDoHistoricoLi = { derivavel: false };
const derivada = (us: number | null): DataDoHistoricoLi => ({ derivavel: true, us });

/** The rows of one order's history, cleaned up: what {@link limparHistoricoLi} leaves. */
export interface HistoricoLimpoLi {
  /** The rows of THIS order with a readable date, one per row id, oldest first. */
  readonly linhas: readonly LinhaHistoricoLi[];
  /** The holes the clean-up found (`numero-divergente`, `data-ilegivel`), in the order met. */
  readonly lacunas: readonly LacunaHistoricoLi[];
}

/**
 * The row clean-up of an order's situação history — ONE rule for every reader
 * of it, so the order import ({@link lerHistoricoLi}) and the status
 * write-back's check after a write (`rastreio/planoRastreio.ts`) order the rows
 * the same way: a row of another order is dropped (`numero-divergente`), a row
 * whose date `lerDataLi` cannot read is dropped (`data-ilegivel`), a repeated row
 * id keeps its first copy, and the rows are ordered by their instant, then by row
 * id. Pure and total.
 */
export function limparHistoricoLi(
  brutas: readonly SituacaoHistoricoLinhaLi[],
  numero: number,
): HistoricoLimpoLi {
  const lacunas = new Set<LacunaHistoricoLi>();
  const vistos = new Set<number>();
  const linhas: LinhaHistoricoLi[] = [];
  for (const bruta of brutas) {
    if (bruta.numero !== numero) {
      lacunas.add(LACUNA_HISTORICO_LI.numeroDivergente);
      continue;
    }
    const data = lerDataLi(bruta.data);
    const dataUs = dataLiParaMicros(bruta.data);
    if (data === null || dataUs === null) {
      lacunas.add(LACUNA_HISTORICO_LI.dataIlegivel);
      continue;
    }
    if (vistos.has(bruta.id)) continue;
    vistos.add(bruta.id);
    linhas.push({
      id: bruta.id,
      data,
      dataUs,
      codigo: bruta.situacao.codigo,
      codigoAnterior: bruta.situacao_anterior?.codigo ?? null,
    });
  }
  linhas.sort((a, b) => a.dataUs - b.dataUs || a.id - b.id);
  return { linhas, lacunas: [...lacunas] };
}

/**
 * Normalise an order's situação history and take the verdict the import needs
 * from it (module header).
 *
 * Rows are ordered by their instant, then by row id; a repeated row id keeps
 * its first copy ({@link limparHistoricoLi}).
 */
export function lerHistoricoLi(entrada: EntradaHistoricoLi): LeituraHistoricoLi {
  const { numero, codigoDetalhe, modo } = entrada;
  const limpo = limparHistoricoLi(entrada.linhas, numero);
  const lacunas = new Set<LacunaHistoricoLi>(limpo.lacunas);
  const linhas = limpo.linhas;

  // The chain. `quebras` holds the index of each row whose predecessor is missing.
  const quebras: number[] = [];
  const primeira = linhas[0];
  if (
    primeira !== undefined &&
    primeira.codigoAnterior !== null &&
    primeira.codigoAnterior !== CODIGO_SITUACAO_LI.pedidoEfetuado
  ) {
    lacunas.add(LACUNA_HISTORICO_LI.inicioTruncado);
  }
  for (let i = 1; i < linhas.length; i += 1) {
    if (linhas[i]!.codigoAnterior !== linhas[i - 1]!.codigo) {
      lacunas.add(LACUNA_HISTORICO_LI.cadeiaQuebrada);
      quebras.push(i);
    }
  }

  // The cut: up to the LAST row reaching the detail's codigo.
  let ultimo = -1;
  linhas.forEach((l, i) => {
    if (l.codigo === codigoDetalhe) ultimo = i;
  });
  const ehEfetuado = codigoDetalhe === CODIGO_SITUACAO_LI.pedidoEfetuado;
  const ausente = ultimo < 0 && !ehEfetuado;
  if (ausente) lacunas.add(LACUNA_HISTORICO_LI.codigoAusente);
  // An order still at `pedido_efetuado` with no row reaching it has moved nowhere yet.
  const fimDoCorte = ultimo >= 0 ? ultimo + 1 : ausente ? linhas.length : 0;
  const corte = linhas.slice(0, fimDoCorte);

  const lista = [...lacunas];
  if (modo === MODO_HISTORICO_LI.estrito && lista.length > 0) return { ok: false, lacunas: lista };
  // An unknown codigo keeps the stored payment status, and so its dates (module header).
  const codigoConhecido = situacaoLi(codigoDetalhe) !== null;

  const linhasDescartadas =
    lacunas.has(LACUNA_HISTORICO_LI.numeroDivergente) ||
    lacunas.has(LACUNA_HISTORICO_LI.dataIlegivel);

  const capturado =
    CODIGOS_LI_CAPTURADO.has(codigoDetalhe) ||
    corte.some(
      (l) =>
        CODIGOS_LI_CAPTURADO.has(l.codigo) ||
        (l.codigoAnterior !== null && CODIGOS_LI_CAPTURADO.has(l.codigoAnterior)),
    );

  // Approval: the first row reaching a capture-evidence codigo, unless a hole
  // before it (or anywhere, for a dropped row) could hide an earlier one.
  const iAprovacao = corte.findIndex((l) => CODIGOS_LI_CAPTURADO.has(l.codigo));
  let dataAprovacao: DataDoHistoricoLi;
  if (!codigoConhecido) {
    dataAprovacao = NAO_DERIVAVEL;
  } else if (iAprovacao < 0) {
    dataAprovacao = capturado ? NAO_DERIVAVEL : derivada(null);
  } else {
    const escondida =
      linhasDescartadas ||
      lacunas.has(LACUNA_HISTORICO_LI.inicioTruncado) ||
      quebras.some((q) => q <= iAprovacao);
    dataAprovacao = escondida ? NAO_DERIVAVEL : derivada(corte[iAprovacao]!.dataUs);
  }

  // Cancellation: the row reaching the detail's reversal codigo, unless it is
  // missing or a later reach of it could be hidden.
  let dataCancelamento: DataDoHistoricoLi;
  if (!codigoConhecido) {
    dataCancelamento = NAO_DERIVAVEL;
  } else if (!CODIGOS_REVERSAO.has(codigoDetalhe)) {
    dataCancelamento = derivada(null);
  } else if (ausente || linhasDescartadas || quebras.some((q) => q > ultimo)) {
    dataCancelamento = NAO_DERIVAVEL;
  } else {
    dataCancelamento = derivada(linhas[ultimo]!.dataUs);
  }

  return { ok: true, lacunas: lista, corte, capturado, dataAprovacao, dataCancelamento };
}

/* -------------------------------------------------------------------------- */
/*                               the target                                    */
/* -------------------------------------------------------------------------- */

/**
 * The prefix every `pedido.error` this importer writes carries — what makes
 * the CLEAR provably ours: an error another writer left (an NF-e failure, a
 * manual note) is never erased.
 */
export const PREFIXO_ERRO_LI = '[loja-integrada] ';

/** The longest codigo quoted in an error text; a longer one is cut. */
const MAX_CODIGO_NO_ERRO = 64;

/** What the shared table says the order IS. */
export type AlvoEstadoLi =
  | {
      readonly tipo: 'conhecido';
      readonly linha: SituacaoLi;
      /** The table's estado for this capture outcome. */
      readonly estado: EstadoPedido;
      /** The table's payment status for this capture outcome. */
      readonly statusPagamento: StatusPagamento;
    }
  | { readonly tipo: 'desconhecido'; readonly codigo: string };

/** The situação codigo, through the shared table, for one capture outcome. */
export function alvoEstadoLi(codigo: string, capturado: boolean): AlvoEstadoLi {
  const linha = situacaoLi(codigo);
  const alvo = alvoDeCriacaoLi(codigo, capturado);
  if (linha === null || alvo === null) return { tipo: 'desconhecido', codigo };
  return {
    tipo: 'conhecido',
    linha,
    estado: alvo.estado,
    statusPagamento: alvo.statusPagamento,
  };
}

/** The importer's own error text for an unknown codigo. */
export function erroSituacaoDesconhecidaLi(codigo: string): string {
  return `${PREFIXO_ERRO_LI}situação desconhecida: "${codigo.slice(0, MAX_CODIGO_NO_ERRO)}"`;
}

/**
 * Whether the pedido's stock removal was APPLIED. Not a copy of the stock
 * sync's rule but the rule itself: the raw snapshot is parsed exactly as the
 * sync parses it (`estoqueAplicadoSchema`) and handed to the sync's own
 * `temMovimentoAplicado` — a physical movement applied, which for a saída
 * pedido is its removal, and which is what makes the sync RESTOCK on a reversing
 * estado. A snapshot that does not parse is "not applied": the sync refuses
 * such a snapshot outright and never restocks it either.
 */
export function remocaoAplicadaLi(estoqueAplicado: unknown): boolean {
  const lido = estoqueAplicadoSchema.safeParse(estoqueAplicado);
  return lido.success && temMovimentoAplicado(lido.data);
}

/* -------------------------------------------------------------------------- */
/*                          the estado ladder                                  */
/* -------------------------------------------------------------------------- */

/** The ORDERED rungs — forward only. */
export const ORDEM_ESTADO_LI = [
  ESTADO_PEDIDO.carrinho,
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.emAnalise,
  ESTADO_PEDIDO.pago,
] as const satisfies readonly EstadoPedido[];

/**
 * The estados this importer may move a pedido AWAY from. Anything else stored
 * (`finalizado`, `emProcessamento`, `fraude`, `estornadoParcialmente`, …)
 * belongs to the business, and a re-fetch never walks it back.
 */
export const ESTADOS_LI_GOVERNAVEIS: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ...ORDEM_ESTADO_LI,
  ESTADO_PEDIDO.processandoCancelamento,
  ESTADO_PEDIDO.cancelado,
  ESTADO_PEDIDO.estornadoIntegralmente,
  ESTADO_PEDIDO.error,
]);

/** The dead-sale estados: leaving one is allowed, and logged (`ressuscitado`). */
export const ESTADOS_LI_TERMINAIS: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.cancelado,
  ESTADO_PEDIDO.estornadoIntegralmente,
]);

/** Why an estado was NOT written. */
export type MotivoEstadoLi =
  /** The stored estado already IS the target. */
  | 'sem-mudanca'
  /** Backwards on the ordered ladder (a painel reversal from paid): a WARNING. */
  | 'regressivo'
  /** The stored estado belongs to the business. */
  | 'fora-da-escada'
  /** A refund-type codigo after an applied removal: stored estado kept, aviso raised. */
  | 'contestado-apos-remocao'
  /** A codigo the table does not know: stored estado kept, error text set. */
  | 'situacao-desconhecida';

/** Named members of {@link MotivoEstadoLi}. */
export const MOTIVO_ESTADO_LI = {
  semMudanca: 'sem-mudanca',
  regressivo: 'regressivo',
  foraDaEscada: 'fora-da-escada',
  contestadoAposRemocao: 'contestado-apos-remocao',
  situacaoDesconhecida: 'situacao-desconhecida',
} as const satisfies Record<string, MotivoEstadoLi>;

export type VereditoEstadoLi =
  | { readonly escrever: true; readonly estado: EstadoPedido; readonly ressuscitado: boolean }
  | { readonly escrever: false; readonly motivo: MotivoEstadoLi };

/**
 * May the STORED estado be moved to `destino`? The Shopee shape, on this
 * channel's ladder:
 *
 * 1. already there ⇒ nothing (`sem-mudanca`);
 * 2. a stored estado off {@link ESTADOS_LI_GOVERNAVEIS} — or not an estado at
 *    all — is never moved (`fora-da-escada`);
 * 3. on {@link ORDEM_ESTADO_LI}, forward only: a painel reversal from `pago` to
 *    awaiting payment keeps `pago` (`regressivo`, logged as a WARNING). A
 *    CAPTURED pedido at `processandoCancelamento` holds the same paid rung — a
 *    request is not a refund — so 4 → 1019 → 2 is refused the same way, and the
 *    estado agrees with the payment ladder, which keeps `aprovado`;
 * 4. everything else writes: `pago` ↔ `processandoCancelamento` both ways, a
 *    reversal from any rung, `error` ↔ anything, and a dead sale may be left
 *    (`ressuscitado`, logged): the detail is a re-fetch of the live order.
 *
 * @param capturado the history verdict ({@link lerHistoricoLi}).
 */
export function estadoLiAplicavel(
  armazenado: unknown,
  destino: EstadoPedido,
  capturado: boolean,
): VereditoEstadoLi {
  if (armazenado === destino) return { escrever: false, motivo: MOTIVO_ESTADO_LI.semMudanca };
  const lido = estadoPedidoSchema.safeParse(armazenado);
  if (!lido.success || !ESTADOS_LI_GOVERNAVEIS.has(lido.data)) {
    return { escrever: false, motivo: MOTIVO_ESTADO_LI.foraDaEscada };
  }
  const ordem = ORDEM_ESTADO_LI as readonly EstadoPedido[];
  // A captured cancellation request still stands on the paid rung.
  const degrauArmazenado =
    capturado && lido.data === ESTADO_PEDIDO.processandoCancelamento
      ? ESTADO_PEDIDO.pago
      : lido.data;
  const de = ordem.indexOf(degrauArmazenado);
  const para = ordem.indexOf(destino);
  if (de >= 0 && para >= 0 && para < de) {
    return { escrever: false, motivo: MOTIVO_ESTADO_LI.regressivo };
  }
  return {
    escrever: true,
    estado: destino,
    ressuscitado: ESTADOS_LI_TERMINAIS.has(lido.data) && !ESTADOS_LI_TERMINAIS.has(destino),
  };
}

/* -------------------------------------------------------------------------- */
/*                         the payment-status ladder                           */
/* -------------------------------------------------------------------------- */

/** What a pagamento's status should do. */
export type AlvoStatusPagamentoLi =
  | { readonly tipo: 'status'; readonly status: StatusPagamento }
  /** Keep whatever is stored. */
  | { readonly tipo: 'manter' };

/** The pre-payment and paid RANKS. A dead status has none: it may be left. */
const RANK_STATUS_LI: ReadonlyMap<StatusPagamento, number> = new Map<StatusPagamento, number>([
  [STATUS_PAGAMENTO.pendente, 0],
  [STATUS_PAGAMENTO.em_revisao, 1],
  [STATUS_PAGAMENTO.aprovado, 2],
  [STATUS_PAGAMENTO.em_disputa, 2],
]);

/** The dead statuses this importer writes. Terminal, never absorbing. */
const STATUS_LI_MORTOS: ReadonlySet<StatusPagamento> = new Set<StatusPagamento>([
  STATUS_PAGAMENTO.cancelado,
  STATUS_PAGAMENTO.estornado,
  STATUS_PAGAMENTO.devolvido,
]);

/** Why a payment status was NOT written. */
export type MotivoStatusLi = 'manter' | 'sem-mudanca' | 'regressivo' | 'fora-da-escada';

/** Named members of {@link MotivoStatusLi}. */
export const MOTIVO_STATUS_LI = {
  manter: 'manter',
  semMudanca: 'sem-mudanca',
  regressivo: 'regressivo',
  foraDaEscada: 'fora-da-escada',
} as const satisfies Record<string, MotivoStatusLi>;

export type VereditoStatusLi =
  | { readonly escrever: true; readonly status: StatusPagamento; readonly ressuscitado: boolean }
  | { readonly escrever: false; readonly motivo: MotivoStatusLi };

/**
 * May the STORED payment status be moved to the target?
 *
 * 1. `manter` ⇒ nothing; already there ⇒ nothing;
 * 2. a stored `null` (no status yet, which `isPagamentoPagante` reads as PAID)
 *    ⇒ the target writes;
 * 3. a stored status this importer does not write (an operator's `recusado`,
 *    `pago_parcialmente`, …) is never moved;
 * 4. a dead stored status (`cancelado`, `estornado`, `devolvido`) may be left
 *    (`ressuscitado`); a dead target always writes;
 * 5. otherwise forward only by rank: a paid status never regresses to
 *    `pendente` or `em_revisao`, and `em_revisao` never back to `pendente` —
 *    the same moves the estado ladder refuses, so the pair keeps agreeing.
 */
export function statusPagamentoLiAplicavel(
  armazenado: unknown,
  alvo: AlvoStatusPagamentoLi,
): VereditoStatusLi {
  if (alvo.tipo === 'manter') return { escrever: false, motivo: MOTIVO_STATUS_LI.manter };
  const destino = alvo.status;
  if (armazenado === destino) return { escrever: false, motivo: MOTIVO_STATUS_LI.semMudanca };
  if (armazenado === null || armazenado === undefined) {
    return { escrever: true, status: destino, ressuscitado: false };
  }
  const lido = statusPagamentoSchema.safeParse(armazenado);
  if (!lido.success) return { escrever: false, motivo: MOTIVO_STATUS_LI.foraDaEscada };
  const de = lido.data;
  if (STATUS_LI_MORTOS.has(de)) {
    return { escrever: true, status: destino, ressuscitado: !STATUS_LI_MORTOS.has(destino) };
  }
  const rankDe = RANK_STATUS_LI.get(de);
  if (rankDe === undefined) return { escrever: false, motivo: MOTIVO_STATUS_LI.foraDaEscada };
  if (STATUS_LI_MORTOS.has(destino))
    return { escrever: true, status: destino, ressuscitado: false };
  const rankPara = RANK_STATUS_LI.get(destino);
  if (rankPara !== undefined && rankPara < rankDe) {
    return { escrever: false, motivo: MOTIVO_STATUS_LI.regressivo };
  }
  return { escrever: true, status: destino, ressuscitado: false };
}

/* -------------------------------------------------------------------------- */
/*                               the decision                                  */
/* -------------------------------------------------------------------------- */

/** What the pedido's `error` does. */
export type ErroLi =
  | { readonly tipo: 'definir'; readonly mensagem: string }
  /** Clear a stored error, but ONLY one carrying {@link PREFIXO_ERRO_LI}. */
  | { readonly tipo: 'limpar' };

/** The stored pedido fields the decision reads — raw, as the snapshot holds them. */
export interface PedidoArmazenadoEstadoLi {
  readonly estado: unknown;
  readonly estoqueAplicado: unknown;
}

export interface DecisaoEstadoLi {
  /**
   * The estado to WRITE: on a create, always set; on an update, `null` when
   * the stored one is kept ({@link motivo} says why).
   */
  readonly estado: EstadoPedido | null;
  readonly motivo: MotivoEstadoLi | null;
  /** A dead sale was left. Written anyway, and logged. */
  readonly ressuscitado: boolean;
  /**
   * The estado the pedido holds AFTER the write: the written one, else the
   * stored one, or `null` when the stored value is not an estado.
   */
  readonly estadoResultante: EstadoPedido | null;
  /** A NEW pagamento's status, and what an existing one's status does. */
  readonly statusPagamento: {
    readonly criacao: StatusPagamento;
    readonly atualizacao: AlvoStatusPagamentoLi;
  };
  readonly erro: ErroLi;
  /** The `lojaIntegradaPedidoContestado` motivo to raise, or `null` (resolve). */
  readonly contestacao: MotivoPedidoContestadoLi | null;
  /** The unknown codigo for `lojaIntegradaSituacaoDesconhecida`, or `null` (resolve). */
  readonly situacaoDesconhecida: string | null;
}

export interface EntradaDecisaoEstadoLi {
  /** `null` on a create. */
  readonly armazenado: PedidoArmazenadoEstadoLi | null;
  readonly codigo: string;
  readonly capturado: boolean;
}

/**
 * The estado, the payment status and the aviso verdicts of one import,
 * re-derived from the stored pedido (`null` on a create).
 *
 * The "keep both" arm is evaluated BEFORE the ladder: a refund-type codigo
 * (`CODIGOS_LI_ESTORNO`; `pagamento_devolvido` only when captured) on a pedido
 * whose stock removal was applied keeps the stored estado and the stored
 * payment statuses and raises the contestado aviso, because the goods may not
 * have come back — a reversing estado would restock them, and a refund status
 * written over a kept `pago`'s payments would be relabelled by the next estado
 * reconcile. For `pagamento_devolvido`, a stored `pago` counts as capture
 * evidence beside the history: the pedido was seen paid, and a degraded
 * history (rows missing, or none read) must not turn a refund of shipped goods
 * into a restocking cancellation. A NEW pagamento seen on that arm is created
 * at the table's refund status: it pays nothing, so the payments already
 * stored (kept as they are) still carry the sale, and the paid sum never
 * counts the refunded money as paid.
 *
 * A refund-type codigo on a stored estado the ladder does not govern (the
 * business owns it: `finalizado`, …) keeps that estado — and still raises the
 * contestado aviso, so the operator learns that the platform reversed a sale
 * the business closed. ⚠️ A cancellation (`pedido_cancelado`) there raises
 * nothing: the aviso has no motivo for it, and its payment status is the only
 * trace.
 *
 * A codigo the table does not know creates the pedido at `error` and keeps the
 * stored estado on an update; either way the importer's error text is set and
 * a payment status is kept (a new payment is created `pendente`).
 *
 * ⚠️ The payment statuses are derived from the SAME stored pedido as the estado
 * (its estado and its applied removal), so the importer commits the pagamentos
 * in ONE atomic batch with the pedido, under the pedido's precondition: a
 * snapshot changed since its read (the stock sync applied the removal, say)
 * aborts every write of the batch, and the retry re-derives this decision from
 * the fresh one (`pagamentoMapeamento.ts`, "Rule 7").
 */
export function decidirEstadoLi(entrada: EntradaDecisaoEstadoLi): DecisaoEstadoLi {
  const { armazenado, codigo, capturado } = entrada;
  const lidoArmazenado =
    armazenado === null ? null : estadoPedidoSchema.safeParse(armazenado.estado);
  const estadoArmazenado = lidoArmazenado?.success === true ? lidoArmazenado.data : null;
  const alvo = alvoEstadoLi(codigo, capturado);

  if (alvo.tipo === 'desconhecido') {
    const erro: ErroLi = { tipo: 'definir', mensagem: erroSituacaoDesconhecidaLi(codigo) };
    const statusPagamento = {
      criacao: STATUS_PAGAMENTO.pendente,
      atualizacao: { tipo: 'manter' },
    } as const;
    if (armazenado === null) {
      return {
        estado: ESTADO_PEDIDO.error,
        motivo: null,
        ressuscitado: false,
        estadoResultante: ESTADO_PEDIDO.error,
        statusPagamento,
        erro,
        contestacao: null,
        situacaoDesconhecida: codigo,
      };
    }
    return {
      estado: null,
      motivo: MOTIVO_ESTADO_LI.situacaoDesconhecida,
      ressuscitado: false,
      estadoResultante: estadoArmazenado,
      statusPagamento,
      erro,
      contestacao: null,
      situacaoDesconhecida: codigo,
    };
  }

  const { linha } = alvo;
  const erro: ErroLi = { tipo: 'limpar' };
  const disputa = codigo === CODIGO_SITUACAO_LI.pagamentoEmDisputa;

  // A stored `pago` is capture evidence too, for the refund that needs it.
  const capturadoOuPago = capturado || estadoArmazenado === ESTADO_PEDIDO.pago;
  const estorno = CODIGOS_LI_ESTORNO.has(codigo);
  const manterAposRemocao =
    armazenado !== null &&
    estorno &&
    (codigo !== CODIGO_SITUACAO_LI.pagamentoDevolvido || capturadoOuPago) &&
    remocaoAplicadaLi(armazenado.estoqueAplicado);

  if (manterAposRemocao) {
    return {
      estado: null,
      motivo: MOTIVO_ESTADO_LI.contestadoAposRemocao,
      ressuscitado: false,
      estadoResultante: estadoArmazenado,
      // Stored payments kept; a NEW one at the (captured) refund status pays nothing.
      statusPagamento: {
        criacao: linha.statusPagamento.capturado,
        atualizacao: { tipo: 'manter' },
      },
      erro,
      contestacao: linha.motivoContestacao,
      situacaoDesconhecida: null,
    };
  }

  const statusPagamento = {
    criacao: alvo.statusPagamento,
    atualizacao: linha.mantemStatusArmazenado
      ? ({ tipo: 'manter' } as const)
      : ({ tipo: 'status', status: alvo.statusPagamento } as const),
  };
  const contestacao = disputa ? MOTIVO_PEDIDO_CONTESTADO_LI.disputa : null;

  if (armazenado === null) {
    return {
      estado: alvo.estado,
      motivo: null,
      ressuscitado: false,
      estadoResultante: alvo.estado,
      statusPagamento,
      erro,
      contestacao,
      situacaoDesconhecida: null,
    };
  }

  const veredito = estadoLiAplicavel(armazenado.estado, alvo.estado, capturado);
  // A refund on an estado the business owns: kept, but the operator is told.
  const estornoForaDaEscada =
    estorno && !veredito.escrever && veredito.motivo === MOTIVO_ESTADO_LI.foraDaEscada;
  return {
    estado: veredito.escrever ? veredito.estado : null,
    motivo: veredito.escrever ? null : veredito.motivo,
    ressuscitado: veredito.escrever && veredito.ressuscitado,
    estadoResultante: veredito.escrever ? veredito.estado : estadoArmazenado,
    statusPagamento,
    erro,
    contestacao: estornoForaDaEscada ? linha.motivoContestacao : contestacao,
    situacaoDesconhecida: null,
  };
}
