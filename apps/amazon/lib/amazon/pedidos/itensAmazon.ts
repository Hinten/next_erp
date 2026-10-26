/**
 * The order's LINES (master plan step 5, PR 5-c): the wire → line reader, the
 * tolerant reader of STORED lines, and D17's `reconciliarItens`, which decides
 * what happens to the stored lines AND to the order-money group.
 *
 * PURE: no Firestore, no clock, no logger. The rules are the plan's "The sale
 * state and D17" section; `vendaAmazon.ts` picks the row, this module executes
 * it.
 *
 * ## ⚠️ Line identity is `mktplaceId` (= Amazon's `orderItemId`) — on BOTH shapes
 *
 * Migrated lines carry no `ensureUniqueId` and `ordem` is always 1, so any other
 * key would duplicate every legacy line on its first re-import. A line THIS
 * importer creates also gets `ensureUniqueId = orderItemId`; a stored line is
 * never backfilled (that would flip its history identity and log a phantom
 * remove + add per line). Plan §3 decision 4.
 *
 * ## ⚠️ 0 and absent are different, and neither overwrites a protected value
 *
 * An absent quantity or price (Amazon dropped it, C1 item 4b) is "no evidence":
 * a stored value is kept wherever one exists, and only a first import writes it,
 * as 0. A 0 overwrites a stored positive value only where nothing protects it —
 * a line carrying an executed cancellation, or a pending cancellation request on
 * the order, protects it. And a line's money (quantity, unit price, discount) is
 * kept or replaced AS A UNIT, never field by field.
 *
 * ## Comparisons are strict, field by field
 *
 * Quantities with `===`, prices in centavos (`mesmosCentavos`, the one money
 * comparison of `dinheiroAmazon.ts`, so a legacy float `33.300000000000004`
 * equals `33.30`), the line SET by
 * `mktplaceId`. No generic structural comparison: what counts as "no change"
 * decides what is never written (plan §3 decision 41).
 */
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import { itemDoPedidoSchema, type ItemDoPedido } from '@delfrance/schemas';

import {
  EVENTO_PEDIDO_AMAZON,
  INCIDENTE_PEDIDO_AMAZON,
  codigosOrdenados,
  type EventoPedidoAmazon,
  type IncidentePedidoAmazon,
} from './codigosPedidoAmazon';
import { mesmosCentavos, reaisDeMoneyAmazon, type DinheiroDoPedidoAmazon } from './dinheiroAmazon';
import { MOTIVO_PEDIDO_AMAZON_ILEGIVEL, PedidoAmazonIlegivelError } from './erros';
import type { VendaAmazon } from './vendaAmazon';

/** The itens-map key of a line no produto owns (inert for stock). */
export const CHAVE_SEM_PRODUTO = 'NONE';

/** The one `measurement.unit` whose quantity is a count of units. */
const UNIDADE_CONTAGEM = 'COUNT';

/* -------------------------------------------------------------------------- */
/*                              incoming lines                                */
/* -------------------------------------------------------------------------- */

/** One incoming line; every value `null` when Amazon sent nothing readable. */
export interface LinhaRecebidaAmazon {
  readonly orderItemId: string;
  /** 1-based position in Amazon's list. */
  readonly posicao: number;
  /** `product.sellerSku`, exact bytes. */
  readonly sku: string | null;
  /** `product.title`. */
  readonly nome: string | null;
  /** `quantityOrdered`; `null` = absent (a negative reads as absent). */
  readonly quantidade: number | null;
  /** `product.price.unitPrice`, reais per unit; `null` = absent (a negative reads as absent). */
  readonly precoUnitario: number | null;
  /** The line carries `cancellation.cancellationExecution` (signal X). */
  readonly execucaoCancelamento: boolean;
  /** The line carries `cancellation.cancellationRequest` (the raw half of signal R). */
  readonly solicitacaoCancelamento: boolean;
  /** `cancellationExecution.cancelledBy`, verbatim, or `null`. */
  readonly canceladoPor: string | null;
  /** `measurement.unit` present and other than `COUNT`. */
  readonly medidaNaoUnitaria: boolean;
}

function textoNaoVazio(valor: string | null | undefined): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

function naoNegativo(valor: number | null | undefined): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 ? valor : null;
}

/**
 * Amazon's lines, in Amazon's order. A duplicate `orderItemId` refuses the whole
 * order ({@link PedidoAmazonIlegivelError}): a line identity cannot be built.
 * An absent `orderItems` and `[]` both answer `[]` (D17 decides what that means).
 */
export function linhasRecebidasAmazon(order: PedidoWireAmazon): LinhaRecebidaAmazon[] {
  const vistos = new Set<string>();
  const linhas: LinhaRecebidaAmazon[] = [];
  for (const [indice, item] of (order.orderItems ?? []).entries()) {
    if (vistos.has(item.orderItemId)) {
      throw new PedidoAmazonIlegivelError(
        order.orderId,
        MOTIVO_PEDIDO_AMAZON_ILEGIVEL.linhaDuplicada,
      );
    }
    vistos.add(item.orderItemId);
    const unidade = textoNaoVazio(item.measurement?.unit);
    linhas.push({
      orderItemId: item.orderItemId,
      posicao: indice + 1,
      // Exact bytes (never trimmed); only a blank SKU reads as absent.
      sku: textoNaoVazio(item.product?.sellerSku),
      nome: textoNaoVazio(item.product?.title),
      quantidade: naoNegativo(item.quantityOrdered),
      precoUnitario: naoNegativo(reaisDeMoneyAmazon(item.product?.price?.unitPrice)),
      execucaoCancelamento: item.cancellation?.cancellationExecution != null,
      solicitacaoCancelamento: item.cancellation?.cancellationRequest != null,
      canceladoPor: textoNaoVazio(item.cancellation?.cancellationExecution?.cancelledBy),
      medidaNaoUnitaria: unidade !== null && unidade !== UNIDADE_CONTAGEM,
    });
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                               stored lines                                 */
/* -------------------------------------------------------------------------- */

/** One STORED line, read tolerantly (the legacy corpus included). */
export interface LinhaArmazenadaAmazon {
  /** The itens-map key it sits under. */
  readonly chave: string;
  readonly mktplaceId: string | null;
  /** The line's own `produtoUid`, else its key (`'NONE'`/`''` ⇒ `null`). */
  readonly produtoUid: string | null;
  readonly quantidade: number | null;
  readonly precoDeVenda: number | null;
  readonly descontoUnitario: number | null;
  readonly sku: string | null;
  readonly nome: string | null;
  readonly ordem: number | null;
  /**
   * The line through the item schema, or `null` when the stored shape does not
   * parse: such a line is never re-emitted, so a rewrite that would need it is
   * not made (`itens-armazenados-ilegiveis`) — never a guessed copy.
   */
  readonly item: ItemDoPedido | null;
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

function numeroFinito(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

function textoNaoVazioBruto(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** The stored `pedido.itens` map as lines (bucket order, then position). Never throws. */
export function linhasArmazenadasAmazon(itens: unknown): LinhaArmazenadaAmazon[] {
  const mapa = objeto(itens);
  if (mapa === null) return [];
  const linhas: LinhaArmazenadaAmazon[] = [];
  for (const [chave, lista] of Object.entries(mapa)) {
    if (!Array.isArray(lista)) continue;
    const doChave = chave === '' || chave === CHAVE_SEM_PRODUTO ? null : chave;
    for (const bruto of lista) {
      const linha = objeto(bruto);
      if (linha === null) continue;
      const parseado = itemDoPedidoSchema.safeParse(linha);
      linhas.push({
        chave,
        mktplaceId: textoNaoVazioBruto(linha.mktplaceId),
        produtoUid: textoNaoVazioBruto(linha.produtoUid) ?? doChave,
        quantidade: numeroFinito(linha.quantidade),
        precoDeVenda: numeroFinito(linha.precoDeVenda),
        descontoUnitario: numeroFinito(linha.descontoUnitario),
        sku: textoNaoVazioBruto(linha.sku),
        nome: textoNaoVazioBruto(linha.nomeDeVenda),
        ordem: numeroFinito(linha.ordem),
        item: parseado.success ? parseado.data : null,
      });
    }
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                                  the output                                */
/* -------------------------------------------------------------------------- */

/** What happened to the stored lines (the master plan's `itens` detail values). */
export type AcaoItensAmazon =
  | 'escritas'
  | 'espelhadas'
  | 'mantidas'
  | 'congeladas'
  | 'itens-preservados-reversao'
  | 'divergencia-itens-aprovado';

/** Named members of {@link AcaoItensAmazon}. */
export const ACAO_ITENS_AMAZON = {
  escritas: 'escritas',
  espelhadas: 'espelhadas',
  mantidas: 'mantidas',
  congeladas: 'congeladas',
  preservadosReversao: 'itens-preservados-reversao',
  divergencia: 'divergencia-itens-aprovado',
} as const satisfies Record<string, AcaoItensAmazon>;

/**
 * Why the import BLOCKS (the pedido goes to our error, the lines stay):
 * `itens` and `cancelamento-parcial` (5-c), and `pagamento` (PR 6) — the derived
 * pagamento `valor` of an approved order still to ship differs from the stored
 * one ({@link bloquearPorValorDoPagamento}).
 */
export type CausaBloqueioAmazon = 'itens' | 'cancelamento-parcial' | 'pagamento';

export interface BloqueioItensAmazon {
  readonly causa: CausaBloqueioAmazon;
  /** The `orderItemId`s involved, sorted (ids only — never a value). */
  readonly linhas: readonly string[];
}

/** The order-money group, stored side. */
export interface DinheiroArmazenadoAmazon {
  /** `null`: the stored doc has no number there. */
  readonly descontoTotal: number | null;
  /** The stored `freteInicial.valorCobrado`, or `null`. */
  readonly valorFrete: number | null;
  /**
   * The freight money is ours to write: the stored block is absent (the import
   * seeds it) or its `externalOptionIntegracao` is `amz`. Otherwise the freight
   * member is the block owner's, and only `descontoTotal` is decided here.
   */
  readonly freteNosso: boolean;
}

export interface ItensArmazenadosAmazon {
  readonly linhas: readonly LinhaArmazenadaAmazon[];
  readonly dinheiro: DinheiroArmazenadoAmazon;
}

export interface ItensRecebidosAmazon {
  readonly linhas: readonly LinhaRecebidaAmazon[];
  readonly dinheiro: DinheiroDoPedidoAmazon;
  /** The order's `createdTime`, µs — every NEW line's `timestamp`. */
  readonly criadoUs: number | null;
  /** `orderItemId` → produto id, for the lines PR 5-d resolved through a link doc. */
  readonly vinculos: ReadonlyMap<string, string>;
}

export interface ContagensItensAmazon {
  /** Stored lines left untouched by a freeze or a reversal. */
  readonly linhasPreservadas: number;
  /** Lines involved in a block. */
  readonly linhasDivergentes: number;
  /** Final lines no produto owns (`'NONE'`). */
  readonly linhasSemProduto: number;
}

export interface ReconciliacaoItensAmazon {
  readonly regra: RegraD17Amazon;
  /** The D17 table row that matched (1–13). */
  readonly linhaD17: number;
  /** `null` only for a first-seen order that is not imported (rows 2 and 3). */
  readonly acao: AcaoItensAmazon | null;
  /** The FULL line list to write, or `null` = the stored lines stay untouched. */
  readonly itens: readonly ItemDoPedido[] | null;
  /** The line MONEY changed (so `valorCobrado` must be re-derived). */
  readonly dinheiroDasLinhasMudou: boolean;
  /**
   * The order-money group to write as a unit, or `null` = untouched. The freight
   * member is written only when {@link DinheiroArmazenadoAmazon.freteNosso}.
   */
  readonly dinheiro: { readonly descontoTotal: number; readonly valorFrete: number | null } | null;
  readonly bloqueio: BloqueioItensAmazon | null;
  readonly incidentes: readonly IncidentePedidoAmazon[];
  readonly eventos: readonly EventoPedidoAmazon[];
  readonly contagens: ContagensItensAmazon;
}

/* -------------------------------------------------------------------------- */
/*                                 helpers                                    */
/* -------------------------------------------------------------------------- */

function positivo(valor: number | null): boolean {
  return valor !== null && valor > 0;
}

function zeroOuAusente(valor: number | null): boolean {
  return valor === null || valor === 0;
}

/** A line THIS importer creates (plan "Line mapping"). */
function novaLinha(
  recebida: LinhaRecebidaAmazon,
  ordem: number,
  recebido: ItensRecebidosAmazon,
): ItemDoPedido {
  return itemDoPedidoSchema.parse({
    produtoUid: recebido.vinculos.get(recebida.orderItemId) ?? null,
    ordem,
    ensureUniqueId: recebida.orderItemId,
    mktplaceId: recebida.orderItemId,
    sku: recebida.sku,
    gtin: null,
    nomeDeVenda: recebida.nome,
    precoDeVenda: recebida.precoUnitario ?? 0,
    descontoUnitario: 0,
    quantidade: recebida.quantidade ?? 0,
    custo: null,
    timestamp: recebido.criadoUs,
  });
}

/** A stored line re-emitted as stored, its `produtoUid` set EXPLICITLY. */
function reemitida(item: ItemDoPedido, produtoUid: string | null): ItemDoPedido {
  return { ...item, produtoUid };
}

function contarSemProduto(linhas: readonly { readonly produtoUid: string | null }[]): number {
  return linhas.filter((l) => l.produtoUid === null).length;
}

const SEM_CONTAGEM: ContagensItensAmazon = {
  linhasPreservadas: 0,
  linhasDivergentes: 0,
  linhasSemProduto: 0,
};

/** The order money read off the stored side's lines, for a group decided on `mantidas`. */
function grupoArmazenado(armazenado: DinheiroArmazenadoAmazon): {
  descontoTotal: number;
  valorFrete: number | null;
} {
  return { descontoTotal: armazenado.descontoTotal ?? 0, valorFrete: armazenado.valorFrete };
}

/** Whether the group differs from the stored one (centavos; `null` ≢ a number). */
function grupoMudou(
  armazenado: DinheiroArmazenadoAmazon,
  novo: { descontoTotal: number; valorFrete: number | null },
): boolean {
  return (
    !mesmosCentavos(armazenado.descontoTotal, novo.descontoTotal) ||
    (armazenado.freteNosso && !mesmosCentavos(armazenado.valorFrete, novo.valorFrete))
  );
}

/**
 * The group on a MIRROR (rows 8–9): written as a unit, unless a member Amazon
 * did not send would overwrite a stored value, or — protected by a request or an
 * executed line cancellation — a 0 would overwrite a stored positive one. Then
 * the WHOLE stored group stays.
 */
function grupoEspelhado(
  armazenado: DinheiroArmazenadoAmazon,
  recebido: DinheiroDoPedidoAmazon,
  protegido: boolean,
): { descontoTotal: number; valorFrete: number | null } | null {
  const membros: [number | null, number | null][] = [
    [recebido.descontoTotal, armazenado.descontoTotal],
  ];
  if (armazenado.freteNosso) membros.push([recebido.valorFrete, armazenado.valorFrete]);
  for (const [entrada, guardado] of membros) {
    if (entrada === null && guardado !== null) return null;
    if (protegido && zeroOuAusente(entrada) && positivo(guardado)) return null;
  }
  const novo = {
    descontoTotal: recebido.descontoTotal ?? armazenado.descontoTotal ?? 0,
    valorFrete: armazenado.freteNosso ? recebido.valorFrete : armazenado.valorFrete,
  };
  return grupoMudou(armazenado, novo) ? novo : null;
}

/**
 * The group on `mantidas`: only a stored-NULL member is filled, and only by a
 * POSITIVE incoming value (a 0 filling a null would be the zero D17 forbids).
 */
function grupoMantido(
  armazenado: DinheiroArmazenadoAmazon,
  recebido: DinheiroDoPedidoAmazon,
): { descontoTotal: number; valorFrete: number | null } | null {
  const preencheDesconto = armazenado.descontoTotal === null && positivo(recebido.descontoTotal);
  const preencheFrete =
    armazenado.freteNosso && armazenado.valorFrete === null && positivo(recebido.valorFrete);
  if (!preencheDesconto && !preencheFrete) return null;
  const base = grupoArmazenado(armazenado);
  return {
    descontoTotal: preencheDesconto ? (recebido.descontoTotal ?? 0) : base.descontoTotal,
    valorFrete: preencheFrete ? recebido.valorFrete : base.valorFrete,
  };
}

/** Re-emit every stored line with the given `produtoUid` per line; `null` when one cannot be. */
function reemitirTodas(
  armazenadas: readonly LinhaArmazenadaAmazon[],
  ajustar: (linha: LinhaArmazenadaAmazon, item: ItemDoPedido) => ItemDoPedido,
): ItemDoPedido[] | null {
  const saida: ItemDoPedido[] = [];
  for (const linha of armazenadas) {
    if (linha.item === null) return null;
    saida.push(ajustar(linha, linha.item));
  }
  return saida;
}

/** The produto id a stored line ends with: kept when bound, else a fresh link-doc hit. */
function produtoFinal(
  linha: LinhaArmazenadaAmazon,
  vinculos: ReadonlyMap<string, string>,
): string | null {
  if (linha.produtoUid !== null) return linha.produtoUid;
  return linha.mktplaceId === null ? null : (vinculos.get(linha.mktplaceId) ?? null);
}

/* -------------------------------------------------------------------------- */
/*                              the D17 table                                 */
/* -------------------------------------------------------------------------- */

/** The D17 rule one row applies. */
export const REGRA_D17_AMAZON = {
  /** 1 — an operator owns the lines. */
  congeladas: 'congeladas',
  /** 2 — first seen, CANCELLED: not imported. */
  canceladoNaoImportado: 'cancelado-nao-importado',
  /** 3 — first seen, any other reversal: not imported. */
  reversaoNaoImportada: 'reversao-nao-importada',
  /** 4 — stored, reversed: every stored line and the money untouched. */
  preservarReversao: 'itens-preservados-reversao',
  /** 5 — first seen, an executed line cancellation, still to ship: created BLOCKED. */
  criarBloqueado: 'criar-bloqueado',
  /** 6 — stored, an executed line cancellation, still to ship: BLOCK. */
  bloquear: 'bloquear',
  /** 7 / 13 (create) — the lines as they arrive. */
  escrever: 'escritas',
  /** 8, 9 — not approved yet: the mirror. */
  espelhar: 'espelhadas',
  /** 10 — approved, still to ship: compare. */
  comparar: 'comparar',
  /** 11, 12, 13 (update) — the lines stay. */
  manter: 'mantidas',
} as const satisfies Record<string, string>;

export type RegraD17Amazon = (typeof REGRA_D17_AMAZON)[keyof typeof REGRA_D17_AMAZON];

/** The D17 table, top-down, first match wins (module header). */
export function regraD17Amazon(venda: VendaAmazon): {
  readonly linha: number;
  readonly regra: RegraD17Amazon;
} {
  const guardado = !venda.primeiraVez;
  if (guardado && venda.congelado) return { linha: 1, regra: REGRA_D17_AMAZON.congeladas };
  if (!guardado && venda.cancelado)
    return { linha: 2, regra: REGRA_D17_AMAZON.canceladoNaoImportado };
  if (!guardado && venda.revertido)
    return { linha: 3, regra: REGRA_D17_AMAZON.reversaoNaoImportada };
  if (guardado && venda.revertido) return { linha: 4, regra: REGRA_D17_AMAZON.preservarReversao };
  if (!guardado && venda.execucao && venda.fase === 'apr') {
    return { linha: 5, regra: REGRA_D17_AMAZON.criarBloqueado };
  }
  if (guardado && venda.execucao && venda.fase === 'apr')
    return { linha: 6, regra: REGRA_D17_AMAZON.bloquear };
  if (!guardado) return { linha: 7, regra: REGRA_D17_AMAZON.escrever };
  if (!venda.aprovado && venda.fase === 'pre')
    return { linha: 8, regra: REGRA_D17_AMAZON.espelhar };
  if (!venda.aprovado && (venda.fase === 'apr' || venda.fase === 'env')) {
    return { linha: 9, regra: REGRA_D17_AMAZON.espelhar };
  }
  if (venda.aprovado && venda.fase === 'apr')
    return { linha: 10, regra: REGRA_D17_AMAZON.comparar };
  if (venda.aprovado && venda.fase === 'env') return { linha: 11, regra: REGRA_D17_AMAZON.manter };
  if (venda.aprovado && venda.fase === 'pre') return { linha: 12, regra: REGRA_D17_AMAZON.manter };
  return { linha: 13, regra: REGRA_D17_AMAZON.manter };
}

/* -------------------------------------------------------------------------- */
/*                                the executor                                */
/* -------------------------------------------------------------------------- */

interface Montagem {
  acao: AcaoItensAmazon;
  itens: ItemDoPedido[] | null;
  dinheiroDasLinhasMudou: boolean;
  dinheiro: { descontoTotal: number; valorFrete: number | null } | null;
  bloqueio: BloqueioItensAmazon | null;
  incidentes: IncidentePedidoAmazon[];
  eventos: EventoPedidoAmazon[];
  linhasPreservadas: number;
}

function vazia(acao: AcaoItensAmazon): Montagem {
  return {
    acao,
    itens: null,
    dinheiroDasLinhasMudou: false,
    dinheiro: null,
    bloqueio: null,
    incidentes: [],
    eventos: [],
    linhasPreservadas: 0,
  };
}

/** Rows 5 and 7 (and 13 on a create): the lines as they arrive. */
function escrever(recebido: ItensRecebidosAmazon, venda: VendaAmazon): Montagem {
  const m = vazia(ACAO_ITENS_AMAZON.escritas);
  m.itens = recebido.linhas.map((linha) => novaLinha(linha, linha.posicao, recebido));
  m.dinheiroDasLinhasMudou = true;
  m.dinheiro = {
    descontoTotal: recebido.dinheiro.descontoTotal ?? 0,
    valorFrete: recebido.dinheiro.valorFrete,
  };
  const aprovadoAgora = venda.fase === 'apr' || venda.fase === 'env';
  if (
    aprovadoAgora &&
    !venda.revertido &&
    recebido.linhas.some((l) => zeroOuAusente(l.quantidade) || zeroOuAusente(l.precoUnitario))
  ) {
    m.incidentes.push(INCIDENTE_PEDIDO_AMAZON.valorZerado);
  }
  return m;
}

/** The ids of the incoming lines carrying an executed cancellation. */
function idsCancelados(recebido: ItensRecebidosAmazon): string[] {
  return recebido.linhas.filter((l) => l.execucaoCancelamento).map((l) => l.orderItemId);
}

/** Rows 8–9: the pre-approval mirror (added, updated, REMOVED). */
function espelhar(
  armazenado: ItensArmazenadosAmazon,
  recebido: ItensRecebidosAmazon,
  venda: VendaAmazon,
): Montagem {
  const m = vazia(ACAO_ITENS_AMAZON.espelhadas);
  const protegidoPedido = venda.solicitacao;
  const algumaExecucao = recebido.linhas.some((l) => l.execucaoCancelamento);
  m.dinheiro = grupoEspelhado(
    armazenado.dinheiro,
    recebido.dinheiro,
    protegidoPedido || algumaExecucao,
  );

  // An empty or absent orderItems is no evidence: nothing is added or removed.
  if (recebido.linhas.length === 0) return m;

  const porId = new Map<string, LinhaArmazenadaAmazon>();
  for (const linha of armazenado.linhas) {
    if (linha.mktplaceId !== null && !porId.has(linha.mktplaceId))
      porId.set(linha.mktplaceId, linha);
  }
  const usadas = new Set<LinhaArmazenadaAmazon>();
  const maiorOrdem = armazenado.linhas.reduce((max, l) => Math.max(max, l.ordem ?? 0), 0);
  let proximaOrdem = maiorOrdem;
  let mudou = false;
  const saida: ItemDoPedido[] = [];

  for (const recebida of recebido.linhas) {
    const guardada = porId.get(recebida.orderItemId);
    if (guardada === undefined) {
      proximaOrdem += 1;
      saida.push(novaLinha(recebida, proximaOrdem, recebido));
      mudou = true;
      m.dinheiroDasLinhasMudou = true;
      continue;
    }
    usadas.add(guardada);
    if (guardada.item === null) {
      m.eventos.push(EVENTO_PEDIDO_AMAZON.itensArmazenadosIlegiveis);
      return { ...m, itens: null, dinheiroDasLinhasMudou: false };
    }
    const protegida = protegidoPedido || recebida.execucaoCancelamento;
    const manterDinheiro =
      recebida.quantidade === null ||
      recebida.precoUnitario === null ||
      (protegida &&
        ((recebida.quantidade === 0 && positivo(guardada.quantidade)) ||
          (recebida.precoUnitario === 0 && positivo(guardada.precoDeVenda))));
    const quantidade = manterDinheiro ? guardada.item.quantidade : (recebida.quantidade ?? 0);
    const preco =
      manterDinheiro || mesmosCentavos(recebida.precoUnitario, guardada.precoDeVenda)
        ? guardada.item.precoDeVenda
        : (recebida.precoUnitario ?? 0);
    const desconto = manterDinheiro ? guardada.item.descontoUnitario : 0;
    const sku = recebida.sku ?? guardada.item.sku;
    const nome = recebida.nome ?? guardada.item.nomeDeVenda;
    const produtoUid = produtoFinal(guardada, recebido.vinculos);
    const dinheiroMudou =
      quantidade !== guardada.item.quantidade ||
      preco !== guardada.item.precoDeVenda ||
      (desconto ?? 0) !== (guardada.item.descontoUnitario ?? 0);
    const linhaMudou =
      dinheiroMudou ||
      sku !== guardada.item.sku ||
      nome !== guardada.item.nomeDeVenda ||
      produtoUid !== guardada.produtoUid;
    if (dinheiroMudou) m.dinheiroDasLinhasMudou = true;
    mudou ||= linhaMudou;
    saida.push(
      linhaMudou
        ? {
            ...guardada.item,
            produtoUid,
            quantidade,
            precoDeVenda: preco,
            descontoUnitario: desconto,
            sku,
            nomeDeVenda: nome,
          }
        : reemitida(guardada.item, produtoUid),
    );
  }
  const removidas = armazenado.linhas.filter((l) => !usadas.has(l));
  if (removidas.length > 0) {
    mudou = true;
    m.dinheiroDasLinhasMudou = true;
  }
  m.itens = mudou ? saida : null;
  if (!mudou) m.dinheiroDasLinhasMudou = false;
  return m;
}

/** The binding of newly linked `'NONE'` lines; the stored lines otherwise untouched. */
function manterComVinculos(
  acao: AcaoItensAmazon,
  armazenado: ItensArmazenadosAmazon,
  recebido: ItensRecebidosAmazon,
  precos: ReadonlyMap<string, number>,
): Montagem {
  const m = vazia(acao);
  m.dinheiro = grupoMantido(armazenado.dinheiro, recebido.dinheiro);
  const religa = armazenado.linhas.some((l) => produtoFinal(l, recebido.vinculos) !== l.produtoUid);
  if (!religa && precos.size === 0) return m;
  const itens = reemitirTodas(armazenado.linhas, (linha, item) => {
    const preco = linha.mktplaceId === null ? undefined : precos.get(linha.mktplaceId);
    const base = reemitida(item, produtoFinal(linha, recebido.vinculos));
    return preco === undefined ? base : { ...base, precoDeVenda: preco };
  });
  if (itens === null) {
    m.eventos.push(EVENTO_PEDIDO_AMAZON.itensArmazenadosIlegiveis);
    return m;
  }
  m.itens = itens;
  if (precos.size > 0) {
    m.dinheiroDasLinhasMudou = true;
    m.eventos.push(EVENTO_PEDIDO_AMAZON.precoPreenchido);
  }
  return m;
}

/** Row 10: the approved, not shipped comparison — equal ⇒ `mantidas`, different ⇒ BLOCK. */
function comparar(
  armazenado: ItensArmazenadosAmazon,
  recebido: ItensRecebidosAmazon,
  venda: VendaAmazon,
): Montagem {
  const protegido = venda.solicitacao;
  const divergentes = new Set<string>();
  let semIdentidade = 0;
  const precos = new Map<string, number>();

  const porId = new Map<string, LinhaArmazenadaAmazon>();
  for (const linha of armazenado.linhas) {
    if (linha.mktplaceId === null) {
      semIdentidade += 1;
    } else if (porId.has(linha.mktplaceId)) {
      divergentes.add(linha.mktplaceId);
    } else {
      porId.set(linha.mktplaceId, linha);
    }
  }
  const recebidasPorId = new Map(recebido.linhas.map((l) => [l.orderItemId, l]));

  for (const recebida of recebido.linhas) {
    const guardada = porId.get(recebida.orderItemId);
    if (guardada === undefined) {
      divergentes.add(recebida.orderItemId);
      continue;
    }
    const q = recebida.quantidade;
    const quantidadeProtegida = protegido && zeroOuAusente(q) && positivo(guardada.quantidade);
    if (!quantidadeProtegida && q !== guardada.quantidade) divergentes.add(recebida.orderItemId);

    const p = recebida.precoUnitario;
    const precoProtegido = protegido && zeroOuAusente(p) && positivo(guardada.precoDeVenda);
    if (precoProtegido) continue;
    if (guardada.precoDeVenda === 0 && positivo(p)) {
      // A 0 price is never a sale price: FILLED, never a divergence.
      precos.set(recebida.orderItemId, p ?? 0);
    } else if (p === null || !mesmosCentavos(p, guardada.precoDeVenda)) {
      divergentes.add(recebida.orderItemId);
    }
  }
  for (const id of porId.keys()) {
    if (!recebidasPorId.has(id) && !protegido) divergentes.add(id);
  }

  const dinheiro = armazenado.dinheiro;
  const membros: [number | null, number | null][] = [
    [recebido.dinheiro.descontoTotal, dinheiro.descontoTotal],
  ];
  if (dinheiro.freteNosso) membros.push([recebido.dinheiro.valorFrete, dinheiro.valorFrete]);
  let dinheiroDiverge = false;
  for (const [entrada, guardado] of membros) {
    if (entrada === null || guardado === null) continue;
    if (protegido && entrada === 0 && positivo(guardado)) continue;
    if (!mesmosCentavos(entrada, guardado)) dinheiroDiverge = true;
  }

  if (divergentes.size > 0 || semIdentidade > 0 || dinheiroDiverge) {
    return {
      ...vazia(ACAO_ITENS_AMAZON.divergencia),
      bloqueio: { causa: 'itens', linhas: codigosOrdenados(divergentes) },
      linhasPreservadas: armazenado.linhas.length,
    };
  }
  return manterComVinculos(ACAO_ITENS_AMAZON.mantidas, armazenado, recebido, precos);
}

/** Row 11: a non-zero difference after shipment is logged, never applied. */
function divergenciaPosEnvio(
  armazenado: ItensArmazenadosAmazon,
  recebido: ItensRecebidosAmazon,
): boolean {
  const porId = new Map<string, LinhaArmazenadaAmazon>();
  for (const linha of armazenado.linhas) {
    if (linha.mktplaceId !== null) porId.set(linha.mktplaceId, linha);
  }
  return recebido.linhas.some((recebida) => {
    const guardada = porId.get(recebida.orderItemId);
    if (guardada === undefined) return true;
    const q = recebida.quantidade;
    const p = recebida.precoUnitario;
    return (
      (q !== null && q !== 0 && q !== guardada.quantidade) ||
      (p !== null && p !== 0 && !mesmosCentavos(p, guardada.precoDeVenda))
    );
  });
}

/**
 * Row 10's pagamento term (PR 6; the master plan's step-6 rule): an approved
 * order still to ship whose DERIVED pagamento `valor` differs from the stored
 * one (the caller compares, in centavos, derived against derived) joins the
 * SAME blocking divergence as a line change — nothing applied, every stored
 * line kept, the order money untouched. Only a `mantidas` row 10 is turned;
 * any other reconciliation is returned as it is.
 */
export function bloquearPorValorDoPagamento(
  reconciliacao: ReconciliacaoItensAmazon,
  armazenadas: readonly LinhaArmazenadaAmazon[],
): ReconciliacaoItensAmazon {
  if (
    reconciliacao.regra !== REGRA_D17_AMAZON.comparar ||
    reconciliacao.acao !== ACAO_ITENS_AMAZON.mantidas
  ) {
    return reconciliacao;
  }
  return {
    ...reconciliacao,
    acao: ACAO_ITENS_AMAZON.divergencia,
    itens: null,
    dinheiroDasLinhasMudou: false,
    dinheiro: null,
    bloqueio: { causa: 'pagamento', linhas: [] },
    // A line price filled on the comparison is not applied either.
    eventos: reconciliacao.eventos.filter((e) => e !== EVENTO_PEDIDO_AMAZON.precoPreenchido),
    contagens: {
      linhasPreservadas: armazenadas.length,
      linhasDivergentes: 0,
      linhasSemProduto: contarSemProduto(armazenadas),
    },
  };
}

/**
 * D17 (plan "The sale state and D17"): the row from {@link regraD17Amazon},
 * executed against the stored lines and the order-money group.
 *
 * - `congeladas` / `itens-preservados-reversao`: every stored line and the group
 *   untouched (a reversal adds `possivel-reembolso` for P, X or Z);
 * - rows 2–3: nothing (the order is not imported);
 * - rows 5–6: an executed line cancellation on an order still to ship BLOCKS
 *   (`cancelamento-parcial`, plan §3 decision 6); a create still writes the lines;
 * - `escritas` (create): what arrives, the group as a unit;
 * - `espelhadas` (not approved): added, updated, removed — protected values kept;
 * - row 10: the comparison; row 11 logs a post-shipment difference; rows 12–13
 *   keep the lines. Every `mantidas` binds a newly linked `'NONE'` line and fills
 *   a stored-null group member with a positive incoming one.
 */
export function reconciliarItens(
  armazenado: ItensArmazenadosAmazon | null,
  recebido: ItensRecebidosAmazon,
  venda: VendaAmazon,
): ReconciliacaoItensAmazon {
  const { linha, regra } = regraD17Amazon(venda);
  const guardadas = armazenado?.linhas ?? [];
  let m: Montagem | null = null;

  switch (regra) {
    case REGRA_D17_AMAZON.canceladoNaoImportado:
    case REGRA_D17_AMAZON.reversaoNaoImportada:
      return {
        regra,
        linhaD17: linha,
        acao: null,
        itens: null,
        dinheiroDasLinhasMudou: false,
        dinheiro: null,
        bloqueio: null,
        incidentes: [],
        eventos: [],
        contagens: SEM_CONTAGEM,
      };
    case REGRA_D17_AMAZON.congeladas:
      m = { ...vazia(ACAO_ITENS_AMAZON.congeladas), linhasPreservadas: guardadas.length };
      break;
    case REGRA_D17_AMAZON.preservarReversao:
      m = { ...vazia(ACAO_ITENS_AMAZON.preservadosReversao), linhasPreservadas: guardadas.length };
      if (venda.reversaoPacote || venda.execucao || venda.zerado) {
        m.incidentes.push(INCIDENTE_PEDIDO_AMAZON.possivelReembolso);
      }
      break;
    case REGRA_D17_AMAZON.criarBloqueado:
      m = escrever(recebido, venda);
      m.bloqueio = {
        causa: 'cancelamento-parcial',
        linhas: codigosOrdenados(idsCancelados(recebido)),
      };
      m.eventos.push(EVENTO_PEDIDO_AMAZON.cancelamentoParcial);
      break;
    case REGRA_D17_AMAZON.bloquear:
      m = {
        ...vazia(ACAO_ITENS_AMAZON.divergencia),
        bloqueio: {
          causa: 'cancelamento-parcial',
          linhas: codigosOrdenados(idsCancelados(recebido)),
        },
        linhasPreservadas: guardadas.length,
      };
      m.eventos.push(EVENTO_PEDIDO_AMAZON.cancelamentoParcial);
      break;
    case REGRA_D17_AMAZON.escrever:
      m = armazenado === null ? escrever(recebido, venda) : vazia(ACAO_ITENS_AMAZON.mantidas);
      break;
    case REGRA_D17_AMAZON.espelhar:
      m = armazenado === null ? escrever(recebido, venda) : espelhar(armazenado, recebido, venda);
      break;
    case REGRA_D17_AMAZON.comparar:
      m = armazenado === null ? escrever(recebido, venda) : comparar(armazenado, recebido, venda);
      break;
    case REGRA_D17_AMAZON.manter:
      if (armazenado === null) {
        m = escrever(recebido, venda);
        break;
      }
      m = manterComVinculos(ACAO_ITENS_AMAZON.mantidas, armazenado, recebido, new Map());
      if (linha === 11 && divergenciaPosEnvio(armazenado, recebido)) {
        m.eventos.push(EVENTO_PEDIDO_AMAZON.divergenciaPosEnvio);
      }
      break;
  }

  if (recebido.linhas.some((l) => l.medidaNaoUnitaria)) {
    m.eventos.push(EVENTO_PEDIDO_AMAZON.medidaNaoUnitaria);
  }
  const finais = m.itens ?? guardadas;
  return {
    regra,
    linhaD17: linha,
    acao: m.acao,
    itens: m.itens,
    dinheiroDasLinhasMudou: m.dinheiroDasLinhasMudou,
    dinheiro: m.dinheiro,
    bloqueio: m.bloqueio,
    incidentes: codigosOrdenados(m.incidentes),
    eventos: codigosOrdenados(m.eventos),
    contagens: {
      linhasPreservadas: m.linhasPreservadas,
      linhasDivergentes: m.bloqueio?.linhas.length ?? 0,
      linhasSemProduto: contarSemProduto(finais),
    },
  };
}
