/**
 * One Amazon order → the pedido write (master plan step 5, PR 5-c): the wire
 * mapper ({@link mapearPedidoAmazon}) and the decision over a stored snapshot
 * ({@link montarEscritaPedidoAmazon}), which answers
 * `nao-importado | obsoleto | criar | sem-mudanca | atualizar`.
 *
 * PURE: no Firestore, no clock (`nowUs` is a parameter), no environment, no
 * logger. PR 5-d runs it once per attempt, over THAT attempt's snapshot of the
 * pedido and its pagamento, and commits what it answers under the snapshot's
 * precondition — so every value here is re-derived from the snapshot, never
 * captured from an earlier read (root `CLAUDE.md` rule 7).
 *
 * ## The watermark (plan §3 decisions 2 and 45)
 *
 * Incoming: `lastUpdatedTime` through `lerInstanteAmazon` (offset REQUIRED, µs
 * from Amazon's text) — an unreadable one refuses the order
 * (`PedidoAmazonIlegivelError`), never a guessed instant. Stored: through
 * `coerceToMicros`, because the legacy corpus holds ms ints and ISO strings —
 * the STORED side only. On a pedido this importer wrote (`marketplace.tipo ===
 * 'amazon'`) a STRICTLY newer stored stamp ⇒ `obsoleto`, nothing else computed;
 * on one it never wrote (a legacy stamp from a different endpoint) never
 * `obsoleto`: that stamp only feeds `maisNovo`, and the ladders still refuse a
 * regression. An EQUAL stamp re-derives; the patch writes the ACCEPTED incoming
 * value, never a maximum.
 *
 * ## The groups, and their comparators
 *
 * Every group compares the re-derived value with the stored one FIELD BY FIELD
 * and STRICTLY (plan §3 decision 41): scalars with `===`, money in centavos, µs
 * as integers, `programs` element-wise in Amazon's order, and absent ≢ `null` ≢
 * `[]` — a key this importer writes and the stored doc lacks is written once,
 * then compares equal. An equal redelivery is a pure function of the same input,
 * so it yields an EMPTY patch (`sem-mudanca`, no write), and `ultimaModificacao`
 * is appended ONLY to a non-empty patch.
 *
 * ## Never written
 *
 * `historicoEstadoPedido`, `historicoFtIni`, `historicoDeModificacoes`,
 * `estoqueAplicado`, `dataIndisponivelEstoque`, `dataRemocaoEstoque`,
 * `disputaAbertaEm`, `devolucaoAbertaEm`, `bloqueiosLiberados`,
 * `hasUserInteraction`, `foiImpresso`, `dtImpressao`, `vendedorPedidoOuterRef`,
 * `enderecoFiscalOuterRef`, `listaDePrecosOuterRef`, `observacoesInternas`,
 * `infCpl`, `bloquearEmissaoNFe`, `itensDevolvidos`, the NF-e keys, the label
 * ids (step 15), the removed money caches, `capturaComprador`, and on the
 * marketplace block `cancelReason` (free text a buyer may type), `pendingTerms`
 * and `completedScenario`.
 */
import { coerceToMicros } from '@delfrance/core/datetime';
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  MARKETPLACE_PEDIDO_TIPO,
  MOTIVO_PEDIDO_AMAZON,
  derivePedidoFreteTotals,
  freteDoPedidoSchema,
  type EstadoPedido,
  type FreteDoPedido,
  type ItemDoPedido,
  type ModalidadeFrete,
  type MotivoPedidoAmazon,
} from '@delfrance/schemas';

import {
  EVENTO_PEDIDO_AMAZON,
  MOTIVO_NAO_IMPORTADO_AMAZON,
  codigosOrdenados,
  type EventoPedidoAmazon,
  type IncidentePedidoAmazon,
  type MotivoNaoImportadoAmazon,
} from './codigosPedidoAmazon';
import {
  dinheiroDoPedidoAmazon,
  mesmosCentavos,
  type DinheiroDoPedidoAmazon,
} from './dinheiroAmazon';
import { MOTIVO_PEDIDO_AMAZON_ILEGIVEL, PedidoAmazonIlegivelError } from './erros';
import {
  ESTADOS_TERMINAIS_AMAZON,
  FULFILLED_BY_AMAZON,
  FULFILLMENT_STATUS_AMAZON,
  PREFIXO_ERRO_AMAZON,
  TEXTO_ERRO_AMAZON,
  alvoCanceladoAmazon,
  alvoErroAmazon,
  alvoEstadoPedidoAmazon,
  ehErroAmazon,
  estadoAmazonAplicavel,
  lerPagamentoArmazenadoAmazon,
  lerResumoArmazenadoAmazon,
  type AlvoEstadoAmazon,
  type ContextoEstadoAmazon,
  type MotivoEstadoAmazon,
} from './estadoPedidoAmazon';
import {
  camposFreteAmazon,
  mercadoriaFora,
  seedFreteAmazon,
  type CamposFreteAmazon,
} from './freteAmazon';
import {
  CHAVE_SEM_PRODUTO,
  REGRA_D17_AMAZON,
  linhasArmazenadasAmazon,
  linhasRecebidasAmazon,
  reconciliarItens,
  type AcaoItensAmazon,
  type BloqueioItensAmazon,
  type ContagensItensAmazon,
  type LinhaArmazenadaAmazon,
  type LinhaRecebidaAmazon,
} from './itensAmazon';
import { lerInstanteAmazon } from './janelaPoll';
import { classificarVendaAmazon, type VendaAmazon } from './vendaAmazon';

/* -------------------------------------------------------------------------- */
/*                                the mapping                                 */
/* -------------------------------------------------------------------------- */

/** What PR 5-d resolves before the write (reads only), handed in as data. */
export interface EntradasPedidoAmazon {
  /** `documents/integracao/<contaId>`, the canonical ref (fill-once). */
  readonly integracaoPedidoOuterRef: string;
  /** The conta's operação, read uncached (fill-once). */
  readonly operacaoPedidoOuterRef: string | null;
  /** The cliente the pedido will carry (fill-once). */
  readonly clientePedidoOuterRef: string | null;
  /** The delivery endereço under that cliente (fill-once, on the freight block). */
  readonly enderecoFreteOuterReference: string | null;
  /** The conta's active `amz` freight doc (fill-once, on the freight block). */
  readonly integracaoFreteOuterRef: string | null;
  /** The conta's `modalidadeFreteImportacao` (`null` ⇒ FOB). */
  readonly modalidadeFreteImportacao: ModalidadeFrete | null;
  /** `orderItemId` → produto id, for the lines a link doc bound. */
  readonly vinculos: ReadonlyMap<string, string>;
}

/** The Amazon `pedido.marketplace` block, as this importer writes it (plan §3 decision 24). */
export interface MarketplaceAmazon {
  readonly tipo: typeof MARKETPLACE_PEDIDO_TIPO.amazon;
  /** `fulfillmentStatus`, verbatim (blank ⇒ `null`). */
  readonly status: string | null;
  /** The accepted order clock, µs. */
  readonly statusEm: number;
  /** The first line's `cancellationExecution.cancelledBy`, verbatim, or `null`. */
  readonly cancelBy: string | null;
  /** `tax.taxInvoicing.invoiceStatus`, verbatim, or `null`. */
  readonly invoiceStatus: string | null;
  /** `fulfillment.fulfilledBy`, verbatim, or `null`. */
  readonly fulfilledBy: string | null;
  /** `programs`, verbatim and in Amazon's order, or `null` when absent. */
  readonly programs: readonly string[] | null;
}

/** One order, mapped from the wire alone. */
export interface PedidoMapeadoAmazon {
  readonly order: PedidoWireAmazon;
  readonly numero: string;
  /** `lastUpdatedTime`, µs. */
  readonly watermarkUs: number;
  /** `createdTime`, µs, or `null` (absent or no offset). */
  readonly criadoUs: number | null;
  readonly marketplace: MarketplaceAmazon;
  readonly linhas: readonly LinhaRecebidaAmazon[];
  readonly dinheiro: DinheiroDoPedidoAmazon;
  readonly frete: CamposFreteAmazon;
  /** `fulfilledBy === 'AMAZON'`. */
  readonly afn: boolean;
  readonly entradas: EntradasPedidoAmazon;
}

function textoDoWire(valor: string | null | undefined): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/**
 * The wire → the mapped order. Throws `PedidoAmazonIlegivelError` when a key
 * cannot be built: `lastUpdatedTime` unreadable (no offset — never read through
 * the tolerant coercion), or a duplicate `orderItemId`.
 */
export function mapearPedidoAmazon(
  order: PedidoWireAmazon,
  entradas: EntradasPedidoAmazon,
): PedidoMapeadoAmazon {
  const instante = lerInstanteAmazon(order.lastUpdatedTime);
  if (instante === null) {
    throw new PedidoAmazonIlegivelError(
      order.orderId,
      MOTIVO_PEDIDO_AMAZON_ILEGIVEL.instanteIlegivel,
    );
  }
  const linhas = linhasRecebidasAmazon(order);
  const criado =
    typeof order.createdTime === 'string' ? lerInstanteAmazon(order.createdTime) : null;
  const fulfilledBy = textoDoWire(order.fulfillment?.fulfilledBy);
  return {
    order,
    numero: order.orderId,
    watermarkUs: instante.us,
    criadoUs: criado?.us ?? null,
    marketplace: {
      tipo: MARKETPLACE_PEDIDO_TIPO.amazon,
      status: textoDoWire(order.fulfillment?.fulfillmentStatus),
      statusEm: instante.us,
      cancelBy: linhas.find((l) => l.canceladoPor !== null)?.canceladoPor ?? null,
      invoiceStatus: textoDoWire(order.tax?.taxInvoicing?.invoiceStatus),
      fulfilledBy,
      programs: Array.isArray(order.programs) ? [...order.programs] : null,
    },
    linhas,
    dinheiro: dinheiroDoPedidoAmazon(order),
    frete: camposFreteAmazon(order, instante.us),
    afn: fulfilledBy === FULFILLED_BY_AMAZON.amazon,
    entradas,
  };
}

/* -------------------------------------------------------------------------- */
/*                                the output                                  */
/* -------------------------------------------------------------------------- */

/** The named field groups a patch may carry. */
export type GrupoPedidoAmazon =
  | 'watermark'
  | 'estado'
  | 'erro'
  | 'marketplace'
  | 'preencher-uma-vez'
  | 'itens'
  | 'dinheiro'
  | 'frete';

/** Everything the importer needs to report, raise and file after the write. */
export interface DecisaoPedidoAmazon {
  readonly itens: AcaoItensAmazon;
  /** The D17 table row that matched (1–13). */
  readonly linhaD17: number;
  /** The estado this write stores, or `null` when none is written. */
  readonly estadoEscrito: EstadoPedido | null;
  /** Why no estado was written, or `null` when one was. */
  readonly motivoEstado: MotivoEstadoAmazon | null;
  /** The per-pedido aviso motivos this snapshot derives (the importer resolves the rest). */
  readonly avisos: readonly MotivoPedidoAmazon[];
  /** The pedido incidentes to create (once each). */
  readonly incidentes: readonly IncidentePedidoAmazon[];
  /** The log events (closed codes; ids and counts only in the line). */
  readonly eventos: readonly EventoPedidoAmazon[];
  readonly bloqueio: BloqueioItensAmazon | null;
  readonly contagens: ContagensItensAmazon;
}

export type EscritaPedidoAmazon =
  /** A first-seen order that is NOT imported: zero writes of any kind. */
  | { readonly tipo: 'nao-importado'; readonly motivo: MotivoNaoImportadoAmazon }
  /** A newer write already landed on a pedido this importer wrote: zero writes. */
  | { readonly tipo: 'obsoleto'; readonly watermarkArmazenadoUs: number }
  | {
      readonly tipo: 'criar';
      readonly corpo: Readonly<Record<string, unknown>>;
      readonly decisao: DecisaoPedidoAmazon;
    }
  | { readonly tipo: 'sem-mudanca'; readonly decisao: DecisaoPedidoAmazon }
  | {
      readonly tipo: 'atualizar';
      readonly patch: Readonly<Record<string, unknown>>;
      readonly grupos: readonly GrupoPedidoAmazon[];
      readonly decisao: DecisaoPedidoAmazon;
    };

/* -------------------------------------------------------------------------- */
/*                         readers and comparators                            */
/* -------------------------------------------------------------------------- */

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

function numero(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/** A fill-once field holds nothing yet (`0` and `false` are values, never empty). */
function vazio(valor: unknown): boolean {
  return valor === null || valor === undefined || valor === '';
}

/** A key the stored block holds, compared strictly — absent ≢ `null`. */
function mesmoCampo(guardado: Record<string, unknown>, chave: string, novo: unknown): boolean {
  return Object.hasOwn(guardado, chave) && guardado[chave] === novo;
}

/** `programs` element-wise in Amazon's order; absent ≢ `null` ≢ `[]`. */
function mesmosProgramas(
  guardado: Record<string, unknown>,
  novo: readonly string[] | null,
): boolean {
  if (!Object.hasOwn(guardado, 'programs')) return false;
  const antigo = guardado.programs;
  if (novo === null || antigo === null) return antigo === novo;
  return (
    Array.isArray(antigo) && antigo.length === novo.length && antigo.every((v, i) => v === novo[i])
  );
}

/** The marketplace group, field by field (plan §3 decision 41). */
function mesmoMarketplace(guardado: unknown, novo: MarketplaceAmazon): boolean {
  const m = objeto(guardado);
  if (m === null) return false;
  return (
    mesmoCampo(m, 'tipo', novo.tipo) &&
    mesmoCampo(m, 'status', novo.status) &&
    mesmoCampo(m, 'statusEm', novo.statusEm) &&
    mesmoCampo(m, 'cancelBy', novo.cancelBy) &&
    mesmoCampo(m, 'invoiceStatus', novo.invoiceStatus) &&
    mesmoCampo(m, 'fulfilledBy', novo.fulfilledBy) &&
    mesmosProgramas(m, novo.programs)
  );
}

/** The marketplace block to write — named field by field, never a spread. */
function marketplaceParaEscrita(novo: MarketplaceAmazon): Record<string, unknown> {
  return {
    tipo: novo.tipo,
    status: novo.status,
    statusEm: novo.statusEm,
    cancelBy: novo.cancelBy,
    invoiceStatus: novo.invoiceStatus,
    fulfilledBy: novo.fulfilledBy,
    programs: novo.programs === null ? null : [...novo.programs],
  };
}

/** `Record<produtoUid | 'NONE', ItemDoPedido[]>` + its `itensIds`. */
function agruparItens(itens: readonly ItemDoPedido[]): {
  itens: Record<string, ItemDoPedido[]>;
  itensIds: string[];
} {
  const registro: Record<string, ItemDoPedido[]> = {};
  for (const item of itens) (registro[item.produtoUid ?? CHAVE_SEM_PRODUTO] ??= []).push(item);
  return { itens: registro, itensIds: Object.keys(registro) };
}

function valorCobradoDerivado(
  itens: readonly ItemDoPedido[],
  descontoTotal: number,
  valorFrete: number | null,
): number {
  return derivePedidoFreteTotals({
    itens,
    descontoTotal,
    freteInicial: { valorCobrado: valorFrete },
  }).valorCobrado;
}

/** Our `error` text for a block (ids only, sorted, at most five named). */
export function textoBloqueioAmazon(bloqueio: BloqueioItensAmazon): string {
  const titulo =
    bloqueio.causa === 'cancelamento-parcial'
      ? 'linha cancelada na Amazon em pedido a enviar'
      : 'itens divergentes do pedido na Amazon';
  const nomeadas = bloqueio.linhas.slice(0, 5).join(', ');
  const resto = bloqueio.linhas.length > 5 ? ` (+${String(bloqueio.linhas.length - 5)})` : '';
  return `${PREFIXO_ERRO_AMAZON}${titulo}${nomeadas === '' ? '' : `: ${nomeadas}${resto}`}`;
}

/* -------------------------------------------------------------------------- */
/*                                 the estado                                 */
/* -------------------------------------------------------------------------- */

interface DecisaoEstadoFinal {
  readonly alvo: AlvoEstadoAmazon;
  readonly incidentes: readonly IncidentePedidoAmazon[];
  readonly avisos: readonly MotivoPedidoAmazon[];
}

/**
 * The estado target, in precedence order:
 *
 * 1. a cancellation REQUEST on a PRINTED pedido while Amazon still has the
 *    order to ship (`pre` or `apr`; plan §3 decision 7) ⇒ the CANCELLED
 *    predicate's TARGET — `cancelado` vs `estornadoIntegralmente`, and its
 *    goods-out and `fora-da-escada` guards, exactly as for an Amazon
 *    CANCELLED — + `aceitar-cancelamento`. Its target ONLY: the predicate's
 *    incidentes record what an Amazon CANCELLED found, and a request is not
 *    one (when Amazon does cancel, that CANCELLED files them).
 *    Any other request — on a pedido not printed, or on an order Amazon has
 *    shipped or whose status is unknown — only raises `cancelamento-solicitado`
 *    and the estado follows the table: after shipment the request can no
 *    longer be accepted, and Amazon's SHIPPED is goods out that the stored
 *    freight may not show (no package fold before PR 7, none at all for an
 *    order outside Easy Ship);
 * 2. a D17 block ⇒ our `error` (through the same ladder: a `fora-da-escada`
 *    estado is kept) + `divergencia-itens`;
 * 3. the table.
 */
function decidirEstado(
  order: PedidoWireAmazon,
  contexto: ContextoEstadoAmazon,
  venda: VendaAmazon,
  bloqueio: BloqueioItensAmazon | null,
): DecisaoEstadoFinal {
  const tabela = alvoEstadoPedidoAmazon(order, contexto);
  const avisos = [...tabela.avisos];
  let alvo = tabela.alvo;
  if (bloqueio !== null) {
    avisos.push(MOTIVO_PEDIDO_AMAZON.divergenciaItens);
    alvo = alvoErroAmazon(textoBloqueioAmazon(bloqueio));
  }
  if (venda.solicitacao) {
    const aEnviar = venda.fase === 'pre' || venda.fase === 'apr';
    if (venda.impresso && aEnviar) {
      alvo = alvoCanceladoAmazon(contexto).alvo;
      avisos.push(MOTIVO_PEDIDO_AMAZON.aceitarCancelamento);
    } else {
      avisos.push(MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado);
    }
  }
  return { alvo, incidentes: tabela.incidentes, avisos };
}

/* -------------------------------------------------------------------------- */
/*                                 the write                                  */
/* -------------------------------------------------------------------------- */

const MOTIVO_DA_REGRA: Readonly<Record<string, MotivoNaoImportadoAmazon>> = {
  [REGRA_D17_AMAZON.canceladoNaoImportado]: MOTIVO_NAO_IMPORTADO_AMAZON.canceladoNaoImportado,
  [REGRA_D17_AMAZON.reversaoNaoImportada]: MOTIVO_NAO_IMPORTADO_AMAZON.reversaoNaoImportada,
};

/**
 * The write for one attempt (module header), from THAT attempt's raw snapshots
 * of the pedido and its pagamento (`null` = absent).
 */
export function montarEscritaPedidoAmazon(
  armazenadoRaw: Readonly<Record<string, unknown>> | null,
  pagamentoArmazenadoRaw: Readonly<Record<string, unknown>> | null,
  mapeado: PedidoMapeadoAmazon,
  opcoes: { readonly nowUs: number },
): EscritaPedidoAmazon {
  const { order, entradas, watermarkUs } = mapeado;
  const resumo = armazenadoRaw === null ? null : lerResumoArmazenadoAmazon(armazenadoRaw);
  const armazenadoUs =
    armazenadoRaw === null ? null : coerceToMicros(armazenadoRaw.lastMarketplaceUpdate);

  // The watermark gate: only on a pedido THIS importer wrote (plan §3 decision 45).
  if (
    resumo !== null &&
    resumo.marketplaceTipo === MARKETPLACE_PEDIDO_TIPO.amazon &&
    armazenadoUs !== null &&
    armazenadoUs > watermarkUs
  ) {
    return { tipo: 'obsoleto', watermarkArmazenadoUs: armazenadoUs };
  }
  const maisNovo = armazenadoUs === null || watermarkUs > armazenadoUs;

  const linhasGuardadas: LinhaArmazenadaAmazon[] =
    armazenadoRaw === null ? [] : linhasArmazenadasAmazon(armazenadoRaw.itens);
  const venda = classificarVendaAmazon(
    order,
    resumo === null ? null : { resumo, linhas: linhasGuardadas },
  );

  const freteRaw = armazenadoRaw === null ? null : objeto(armazenadoRaw.freteInicial);
  const freteNosso =
    freteRaw === null || freteRaw.externalOptionIntegracao === INTEGRACAO_FRETE.amazon;
  const dinheiroArmazenado = {
    descontoTotal: armazenadoRaw === null ? null : numero(armazenadoRaw.descontoTotal),
    valorFrete: freteRaw === null ? null : numero(freteRaw.valorCobrado),
    freteNosso,
  };
  const reconciliacao = reconciliarItens(
    resumo === null ? null : { linhas: linhasGuardadas, dinheiro: dinheiroArmazenado },
    {
      linhas: mapeado.linhas,
      dinheiro: mapeado.dinheiro,
      criadoUs: mapeado.criadoUs,
      vinculos: entradas.vinculos,
    },
    venda,
  );
  if (reconciliacao.acao === null) {
    const motivo = MOTIVO_DA_REGRA[reconciliacao.regra];
    if (motivo === undefined) throw new TypeError('montarEscritaPedidoAmazon: regra sem ação');
    return { tipo: 'nao-importado', motivo };
  }

  /* ------------------------------- the estado ------------------------------ */
  const contexto: ContextoEstadoAmazon = {
    armazenado: resumo,
    pagamentoArmazenado: lerPagamentoArmazenadoAmazon(pagamentoArmazenadoRaw),
    mercadoriaFora: mercadoriaFora(resumo?.freteEstado ?? null),
  };
  const estado = decidirEstado(order, contexto, venda, reconciliacao.bloqueio);
  const veredito = estadoAmazonAplicavel(resumo, estado.alvo, { maisNovo });
  const avisos: MotivoPedidoAmazon[] = [...estado.avisos];
  const eventos: EventoPedidoAmazon[] = [...reconciliacao.eventos];
  if (veredito.escrever && veredito.ressuscitado) eventos.push(EVENTO_PEDIDO_AMAZON.ressuscitado);

  // `cancelado-so-no-erp` (2026-10-22): the STORED estado is terminal and the
  // cancel was the ERP's (the stored `marketplace.status` is not Amazon's
  // CANCELLED — the same discriminator the resurrection reads), Amazon's order
  // is still to ship, no LINE carries an open request (`solicitacaoAberta`, not
  // R: an execution on another line does not close a request), and this import
  // keeps it terminal.
  const continuaTerminal = !(veredito.escrever && !ESTADOS_TERMINAIS_AMAZON.has(veredito.estado));
  if (
    resumo?.estado != null &&
    ESTADOS_TERMINAIS_AMAZON.has(resumo.estado) &&
    resumo.marketplaceStatus !== FULFILLMENT_STATUS_AMAZON.cancelled &&
    venda.fase === 'apr' &&
    !venda.solicitacaoAberta &&
    continuaTerminal
  ) {
    avisos.push(MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp);
  }

  const decisao: DecisaoPedidoAmazon = {
    itens: reconciliacao.acao,
    linhaD17: reconciliacao.linhaD17,
    estadoEscrito: veredito.escrever ? veredito.estado : null,
    motivoEstado: veredito.escrever ? null : veredito.motivo,
    avisos: codigosOrdenados(avisos),
    incidentes: codigosOrdenados([...estado.incidentes, ...reconciliacao.incidentes]),
    eventos: codigosOrdenados(eventos),
    bloqueio: reconciliacao.bloqueio,
    contagens: reconciliacao.contagens,
  };

  /* --------------------------------- CREATE -------------------------------- */
  if (armazenadoRaw === null) {
    const alvo = estado.alvo;
    const linhas = reconciliacao.itens ?? [];
    const dinheiro = reconciliacao.dinheiro ?? { descontoTotal: 0, valorFrete: null };
    const { itens, itensIds } = agruparItens(linhas);
    const freteInicial: FreteDoPedido = seedFreteAmazon({
      modalidade: entradas.modalidadeFreteImportacao,
      afn: mapeado.afn,
      integracaoFreteOuterRef: entradas.integracaoFreteOuterRef,
      enderecoFreteOuterReference: entradas.enderecoFreteOuterReference,
      campos: mapeado.frete,
      valorCobrado: dinheiro.valorFrete,
    });
    const corpo = {
      ehSaida: true,
      estado: alvo.tipo === 'estado' ? alvo.estado : ESTADO_PEDIDO.error,
      error: alvo.tipo === 'estado' ? alvo.erro : TEXTO_ERRO_AMAZON.statusDesconhecido,
      numero: mapeado.numero,
      integracaoPedidoOuterRef: entradas.integracaoPedidoOuterRef,
      operacaoPedidoOuterRef: entradas.operacaoPedidoOuterRef,
      clientePedidoOuterRef: entradas.clientePedidoOuterRef,
      // "When we first saw it" is the honest fallback: a pedido without a
      // timestamp sorts to the bottom of the list for ever.
      timestamp: mapeado.criadoUs ?? opcoes.nowUs,
      itens,
      itensIds,
      freteInicial,
      descontoTotal: dinheiro.descontoTotal,
      valorCobrado: valorCobradoDerivado(linhas, dinheiro.descontoTotal, dinheiro.valorFrete),
      marketplace: marketplaceParaEscrita(mapeado.marketplace),
      lastMarketplaceUpdate: watermarkUs,
      ultimaModificacao: opcoes.nowUs,
    };
    return { tipo: 'criar', corpo, decisao };
  }

  /* --------------------------------- UPDATE -------------------------------- */
  const raw = armazenadoRaw;
  const patch: Record<string, unknown> = {};
  const grupos = new Set<GrupoPedidoAmazon>();

  // The ACCEPTED incoming value, never a maximum (plan §3 decision 2).
  if (armazenadoUs !== watermarkUs) {
    patch.lastMarketplaceUpdate = watermarkUs;
    grupos.add('watermark');
  }

  if (veredito.escrever) {
    patch.estado = veredito.estado;
    grupos.add('estado');
  }
  // Our `error` text: written beside our error estado, cleared only when it is
  // OURS. A foreign text is never touched.
  const alvo = estado.alvo;
  const erroGuardado = resumo?.error ?? null;
  const erroNosso = ehErroAmazon(erroGuardado);
  if (alvo.tipo === 'estado' && (veredito.escrever || veredito.motivo === 'sem-mudanca')) {
    const ehErro = alvo.estado === ESTADO_PEDIDO.error;
    const proximo = ehErro ? alvo.erro : null;
    const pode = ehErro ? veredito.escrever || erroNosso : erroNosso;
    if (pode && proximo !== erroGuardado) {
      patch.error = proximo;
      grupos.add('erro');
    }
  }

  if (!mesmoMarketplace(raw.marketplace, mapeado.marketplace)) {
    patch.marketplace = marketplaceParaEscrita(mapeado.marketplace);
    grupos.add('marketplace');
  }

  const preencher: readonly (readonly [string, unknown])[] = [
    ['numero', mapeado.numero],
    ['integracaoPedidoOuterRef', entradas.integracaoPedidoOuterRef],
    ['operacaoPedidoOuterRef', entradas.operacaoPedidoOuterRef],
    ['clientePedidoOuterRef', entradas.clientePedidoOuterRef],
    ['timestamp', mapeado.criadoUs],
  ];
  for (const [campo, valor] of preencher) {
    if (valor !== null && vazio(raw[campo])) {
      patch[campo] = valor;
      grupos.add('preencher-uma-vez');
    }
  }

  // The lines and the order money (D17). A stored line the schema refuses has
  // no trustworthy money, so while the lines are not rewritten the order total
  // is never recomputed from it, and the order-money group derived with that
  // total (discount, freight money) is withheld as a unit: the stored values
  // stay until the lines read again.
  const itensGuardados = linhasGuardadas.flatMap((l) => (l.item === null ? [] : [l.item]));
  const totaisLegiveis =
    reconciliacao.itens !== null || itensGuardados.length === linhasGuardadas.length;
  const linhasFinais: readonly ItemDoPedido[] = reconciliacao.itens ?? itensGuardados;
  if (
    !totaisLegiveis &&
    (reconciliacao.dinheiro !== null || reconciliacao.dinheiroDasLinhasMudou)
  ) {
    eventos.push(EVENTO_PEDIDO_AMAZON.itensArmazenadosIlegiveis);
  }
  if (reconciliacao.itens !== null) {
    const agrupado = agruparItens(reconciliacao.itens);
    patch.itens = agrupado.itens;
    patch.itensIds = agrupado.itensIds;
    grupos.add('itens');
  }
  const grupo = totaisLegiveis ? reconciliacao.dinheiro : null;
  if (grupo !== null && !mesmosCentavos(dinheiroArmazenado.descontoTotal, grupo.descontoTotal)) {
    patch.descontoTotal = grupo.descontoTotal;
    grupos.add('dinheiro');
  }
  // An `amz` freight block the schema refuses is never rewritten (below), so the
  // total keeps the STORED freight money that block still holds.
  const freteGravavel =
    freteRaw === null || !freteNosso || freteDoPedidoSchema.safeParse(freteRaw).success;
  const freteFinal =
    grupo !== null && freteNosso && freteGravavel
      ? grupo.valorFrete
      : dinheiroArmazenado.valorFrete;
  if (totaisLegiveis && (reconciliacao.dinheiroDasLinhasMudou || grupo !== null)) {
    const derivado = valorCobradoDerivado(
      linhasFinais,
      grupo?.descontoTotal ?? dinheiroArmazenado.descontoTotal ?? 0,
      freteFinal,
    );
    if (!mesmosCentavos(numero(raw.valorCobrado), derivado)) {
      patch.valorCobrado = derivado;
      grupos.add('dinheiro');
    }
  }

  // The freight block: seeded when absent; on an `amz` block, the non-money
  // fields, the fill-once refs and the freight money of the group.
  if (freteRaw === null) {
    patch.freteInicial = seedFreteAmazon({
      modalidade: entradas.modalidadeFreteImportacao,
      afn: mapeado.afn,
      integracaoFreteOuterRef: entradas.integracaoFreteOuterRef,
      enderecoFreteOuterReference: entradas.enderecoFreteOuterReference,
      campos: mapeado.frete,
      valorCobrado: freteFinal,
    });
    grupos.add('frete');
  } else if (freteNosso) {
    const mudancas: Record<string, unknown> = {};
    const { prazoDespacho, dataPrevisaoEntrega, ultimaModificacao } = mapeado.frete;
    // An absent deadline never erases a stored one.
    if (prazoDespacho !== null && freteRaw.prazoDespacho !== prazoDespacho) {
      mudancas.prazoDespacho = prazoDespacho;
    }
    if (dataPrevisaoEntrega !== null && freteRaw.dataPrevisaoEntrega !== dataPrevisaoEntrega) {
      mudancas.dataPrevisaoEntrega = dataPrevisaoEntrega;
    }
    if (freteRaw.ultimaModificacao !== ultimaModificacao)
      mudancas.ultimaModificacao = ultimaModificacao;
    if (
      entradas.enderecoFreteOuterReference !== null &&
      vazio(freteRaw.enderecoFreteOuterReference)
    ) {
      mudancas.enderecoFreteOuterReference = entradas.enderecoFreteOuterReference;
    }
    if (entradas.integracaoFreteOuterRef !== null && vazio(freteRaw.integracaoFreteOuterRef)) {
      mudancas.integracaoFreteOuterRef = entradas.integracaoFreteOuterRef;
    }
    if (grupo !== null && !mesmosCentavos(dinheiroArmazenado.valorFrete, grupo.valorFrete)) {
      mudancas.valorCobrado = grupo.valorFrete;
    }
    if (Object.keys(mudancas).length > 0) {
      const guardado = freteDoPedidoSchema.safeParse(freteRaw);
      if (guardado.success) {
        patch.freteInicial = { ...guardado.data, ...mudancas };
        grupos.add('frete');
      } else {
        eventos.push(EVENTO_PEDIDO_AMAZON.freteArmazenadoIlegivel);
      }
    }
  }

  const decisaoFinal: DecisaoPedidoAmazon = { ...decisao, eventos: codigosOrdenados(eventos) };
  if (Object.keys(patch).length === 0) return { tipo: 'sem-mudanca', decisao: decisaoFinal };

  // Monotonic and never null: another writer may already have set it ahead.
  const ultimaGuardada = coerceToMicros(raw.ultimaModificacao);
  patch.ultimaModificacao =
    ultimaGuardada === null || opcoes.nowUs > ultimaGuardada ? opcoes.nowUs : ultimaGuardada;
  return { tipo: 'atualizar', patch, grupos: [...grupos], decisao: decisaoFinal };
}
