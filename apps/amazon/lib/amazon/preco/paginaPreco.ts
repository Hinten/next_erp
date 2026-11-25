/**
 * A price run's page and its decision step (step 13, PR 13-c), pure: how ONE
 * page classifies its SKUs, what it writes as its part, and what the run's
 * decision step (Decide) does with the parts. The page's reads and writes come
 * in a later PR; every price comparison here goes through `planoPreco.ts`.
 *
 * ## One SKU of a page ({@link classificarSkuPrecoAmazon})
 *
 * In this order, the first that refuses ends it:
 *
 *  1. the link verdict (refusals 1–4; the stock flow's fifth never reaches a
 *     price verdict, and meeting it is a wiring bug, thrown);
 *  2. the live read: a search miss no GET confirmed (or could: no listings
 *     path) ⇒ `nao-confirmado`;
 *  3. the listing gate (`nao-listado`, `pai`, `asin-divergente`); past it the
 *     listing's offer flags and its price issues are counted;
 *  4. the faixa: no normal tabela ⇒ `conta-sem-tabela-normal`, no normal
 *     price ⇒ `sem-preco`, a promotional price above the normal one ⇒
 *     `faixa-invertida`;
 *  5. the listing's live `productType` ({@link tipoProdutoDoListingPrecoAmazon}):
 *     outside the grammar ⇒ `tipo-produto-ilegivel`;
 *  6. the plan, with the run's consent, no floor and no feed-recent rule (a
 *     page decides on the ERP against the live read): `igual`, a refusal of
 *     the decrease guard, or ENVIÁVEL.
 *
 * An enviável SKU becomes a part member: its link path, unit, the offer as the
 * plan judged it (`ausente` on a BUYABLE listing stored as `ilegivel`), the
 * faixa (its `base` is the run's floor for the SKU), the type and the read
 * instant. It is counted `sobe` or `desce` on `our_price` (judged, and its drop
 * measured and sampled, from the plan's reference price), `quedaExcessiva`
 * when it falls by more than half, `direcaoDesconhecida` when the offer it
 * would replace could not be read safely (the mass-decrease stop counts it as
 * a possible decrease), and `semCaminho` when no per-SKU patch can carry it
 * (only a feed does). A listing's price issues are counted only when they
 * BLOCK (`problemasDePreco`); a price `WARNING` alone is not.
 *
 * A page's caller builds each SKU's `fontes` from the link readers' answer
 * through `fontesPrecoDaUnidadeAmazon` (`@delfrance/schemas`), never by hand.
 *
 * ## The page's part ({@link parteDaPaginaPrecoAmazon})
 *
 * A page with no enviável SKU writes no part; parts are numbered densely. A
 * page that would write part `MAX_PARTES_EXECUCAO_PRECO_AMAZON` writes nothing
 * and ends the run `truncada` (`partes-demais`).
 *
 * ## Decide ({@link decidirFimPrecoAmazon})
 *
 * D is the number of enviável SKUs (the parts' items). In this order:
 *
 *  1. the MASS-DECREASE stop ({@link reducaoEmMassaPrecoAmazon}), whatever the
 *     valve, so a dry-run shows it too: a run with consent to lower prices,
 *     whose request did not confirm a mass decrease, that may lower
 *     `our_price` (its decreases plus its sends of an unknown direction) on at
 *     least `LIMIAR_REDUCAO_EM_MASSA_PRECO_AMAZON` SKUs, or on more than the
 *     switch that are also more than half of D, or that lowers it by more than
 *     half on any one SKU ⇒ `reducao-em-massa`, nothing sent;
 *  2. D = 0 ⇒ `nada`;
 *  3. a canary LIST (`so-patches-do-canario`) ⇒ `canario`, whatever D: tasks
 *     for the canary's SKUs only, never a feed;
 *  4. an `off` valve ⇒ `dry-run` (nothing is sent; a page stops before Decide
 *     under it, so this is only the total answer);
 *  5. D ≤ the switch and every SKU with a listings path ⇒ `tarefas` under a
 *     feed-form valve; under `dry-run` no task would be enqueued (every
 *     member decides `dry-run`), so the answer is `dry-run`;
 *  6. else ⇒ `lotes`: the parts PACKED ({@link lotesDePartesPrecoAmazon}),
 *     under `dry-run` too (each batch builds, logs and sends nothing).
 *
 * ## The packing
 *
 * Consecutive parts, greedily, while a batch's items stay within
 * `MAX_MENSAGENS_LOTE_PRECO_AMAZON` and its parts within
 * `MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON`: the number of feeds follows the
 * drift, never the walk's pages.
 *
 * PURE: no Firestore, no clock, no network.
 */
import {
  type ListingAmazon,
  MARKETPLACE_ID_BR,
  TIPO_PRODUTO_OFERTA,
  ofertaDoListingAmazon,
  skuTemCaminhoAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  AMAZON_LISTING_STATUS,
  type ContagensExecucaoPrecoAmazon,
  DECISAO_EXECUCAO_PRECO_AMAZON,
  type DecisaoExecucaoPrecoAmazon,
  type EnvioPrecoAmazon,
  FRACAO_REDUCAO_EM_MASSA_PRECO_AMAZON,
  type FontesPrecoAmazon,
  type ItemDivergenciaPrecoAmazon,
  LIMIAR_FEED_PRECO_AMAZON,
  LIMIAR_REDUCAO_EM_MASSA_PRECO_AMAZON,
  MAX_ITENS_DIVERGENCIA_PRECO_AMAZON,
  MAX_PARTES_EXECUCAO_PRECO_AMAZON,
  TIPO_FAIXA_PRECO_AMAZON,
  TIPO_OFERTA_PRECO_AMAZON,
  TIPO_PRODUTO_PRECO_AMAZON_REGEX,
  type TabelasDePrecoAmazon,
  faixaDePrecoAmazon,
} from '@delfrance/schemas';

import type { DecisaoLoteAmazon } from '../core/valvulas';
import {
  MAX_MENSAGENS_LOTE_PRECO_AMAZON,
  MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON,
} from '../feeds/tarefaLote';
import { type LeituraListingAmazon, avaliarGateListingAmazon } from '../listings/gateListing';
import {
  MOTIVO_VINCULO_LISTING_AMAZON,
  type VeredictoVinculoListingAmazon,
} from '../listings/vinculoListing';
import { temIssuePrecoBloqueanteAmazon } from './issuesPreco';
import { MOTIVO_PRECO_AMAZON, type MotivoPrecoAmazon } from './motivosPreco';
import {
  DECISAO_PLANO_PRECO_AMAZON,
  DIRECAO_PRECO_AMAZON,
  type DirecaoPrecoAmazon,
  type ReducaoPrecoAmazon,
  amostraReducoesPrecoAmazon,
  planejarPrecoAmazon,
  quedaExcessivaPrecoAmazon,
} from './planoPreco';

/* ------------------------------ the listing -------------------------------- */

/** The listing's BR summaries. */
function resumosBr(listing: ListingAmazon) {
  return (listing.summaries ?? []).filter((r) => r.marketplaceId === MARKETPLACE_ID_BR);
}

/** Whether a BR summary shows the listing as BUYABLE (an exact status). */
export function compravelNoBrPrecoAmazon(listing: ListingAmazon): boolean {
  return resumosBr(listing).some((r) => (r.status ?? []).includes(AMAZON_LISTING_STATUS.buyable));
}

/**
 * The listing's live `productType` for a price message: the BR summaries'
 * type when every one that names a type names the same one, inside the
 * grammar; `PRODUCT` when none names a type; `null` (illegible) otherwise.
 */
export function tipoProdutoDoListingPrecoAmazon(listing: ListingAmazon): string | null {
  const tipos = new Set<unknown>();
  for (const r of resumosBr(listing)) {
    if (r.productType !== null && r.productType !== undefined) tipos.add(r.productType);
  }
  if (tipos.size === 0) return TIPO_PRODUTO_OFERTA;
  const [tipo] = tipos;
  return tipos.size === 1 && typeof tipo === 'string' && TIPO_PRODUTO_PRECO_AMAZON_REGEX.test(tipo)
    ? tipo
    : null;
}

/* ------------------------------- one SKU ----------------------------------- */

/** What a page holds for one SKU: the live read's answer for it. */
export type LeituraSkuPrecoAmazon =
  | { readonly tipo: 'lido'; readonly leitura: LeituraListingAmazon }
  | { readonly tipo: 'sem-caminho' }
  | { readonly tipo: 'nao-confirmado' };

/** One SKU of a page, as its readers left it. */
export interface EntradaSkuPrecoAmazon {
  readonly sku: string;
  /** The link doc's full path a send re-reads (`produtos/<id>/prodAmazon/<id>`). */
  readonly vinculo: string;
  readonly veredicto: VeredictoVinculoListingAmazon<EnvioPrecoAmazon>;
  readonly leitura: LeituraSkuPrecoAmazon;
  /** The unit's price sources (`fontesPrecoDaUnidadeAmazon` of the readers' answer); `null` when none was read. */
  readonly fontes: FontesPrecoAmazon | null;
}

/** The page's own inputs, the same for every SKU. */
export interface ContextoPaginaPrecoAmazon {
  readonly tabelas: TabelasDePrecoAmazon;
  /** The run's consent to lower `our_price`. */
  readonly baixarPreco: boolean;
  /** ms — when the page read Amazon. */
  readonly lidoEmMs: number;
}

/** What a page counts for every SKU past the listing gate. */
export interface IndicadoresSkuPrecoAmazon {
  readonly temPrecoComDesconto: boolean;
  readonly temOfertaB2B: boolean;
  readonly fechada: boolean;
  /** The listing carries a BLOCKING price issue Amazon raised (an `ERROR`, or one a person must confirm). */
  readonly problemaDePreco: boolean;
}

/** How one SKU of a page ends (module header). */
export type ClasseSkuPrecoAmazon = 'recusado' | 'igual' | 'enviavel';

export const CLASSE_SKU_PRECO_AMAZON = {
  recusado: 'recusado',
  igual: 'igual',
  enviavel: 'enviavel',
} as const satisfies Record<string, ClasseSkuPrecoAmazon>;

export type ClassificacaoSkuPrecoAmazon =
  | {
      readonly classe: typeof CLASSE_SKU_PRECO_AMAZON.recusado;
      readonly motivo: MotivoPrecoAmazon;
      /** `null` before the listing gate passed. */
      readonly indicadores: IndicadoresSkuPrecoAmazon | null;
    }
  | {
      readonly classe: typeof CLASSE_SKU_PRECO_AMAZON.igual;
      readonly indicadores: IndicadoresSkuPrecoAmazon;
    }
  | {
      readonly classe: typeof CLASSE_SKU_PRECO_AMAZON.enviavel;
      readonly item: ItemDivergenciaPrecoAmazon;
      readonly direcao: DirecaoPrecoAmazon;
      /** The `our_price` the move was judged from (the plan's); `null` when unknown or none. */
      readonly referencia: number | null;
      /** `our_price` falls by more than half. */
      readonly quedaExcessiva: boolean;
      /** The offer it replaces could not be read safely: a possible decrease of unknown depth. */
      readonly direcaoDesconhecida: boolean;
      /** No per-SKU patch can carry the SKU: only a feed sends it. */
      readonly semCaminho: boolean;
      readonly indicadores: IndicadoresSkuPrecoAmazon;
    };

/** A ms instant, or a `RangeError` naming the field. */
function exigirInteiro(valor: number, campo: string): number {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`paginaPreco.ts: ${campo} deve ser um inteiro seguro não negativo`);
  }
  return valor;
}

/** The faixa's refusals, as line motivos. */
const RECUSA_DA_FAIXA = {
  [TIPO_FAIXA_PRECO_AMAZON.semTabelaNormal]: MOTIVO_PRECO_AMAZON.contaSemTabelaNormal,
  [TIPO_FAIXA_PRECO_AMAZON.semPreco]: MOTIVO_PRECO_AMAZON.semPreco,
  [TIPO_FAIXA_PRECO_AMAZON.faixaInvertida]: MOTIVO_PRECO_AMAZON.faixaInvertida,
} as const;

/**
 * One SKU of a page (module header, "One SKU of a page").
 *
 * @throws {TypeError} a price verdict answering the stock flow's own refusal.
 * @throws {RangeError} `lidoEmMs` outside a non-negative safe integer.
 */
export function classificarSkuPrecoAmazon(
  e: EntradaSkuPrecoAmazon,
  ctx: ContextoPaginaPrecoAmazon,
): ClassificacaoSkuPrecoAmazon {
  exigirInteiro(ctx.lidoEmMs, 'lidoEmMs');
  const recusado = (
    motivo: MotivoPrecoAmazon,
    indicadores: IndicadoresSkuPrecoAmazon | null = null,
  ) => ({ classe: CLASSE_SKU_PRECO_AMAZON.recusado, motivo, indicadores });

  // 1. The link verdict.
  const v = e.veredicto;
  if (!v.apto) {
    if (v.motivo === MOTIVO_VINCULO_LISTING_AMAZON.envioDesligado) {
      throw new TypeError('paginaPreco.ts: um veredicto de preço nunca recusa envio-desligado');
    }
    return recusado(v.motivo);
  }
  // 2. The live read.
  if (e.leitura.tipo !== 'lido') return recusado(MOTIVO_PRECO_AMAZON.naoConfirmado);
  // 3. The listing gate.
  const gate = avaliarGateListingAmazon(e.leitura.leitura, { asinsDoVinculo: v.asinsDoVinculo });
  if (!gate.enviavel) return recusado(gate.motivo);
  const { listing } = gate;
  const oferta = ofertaDoListingAmazon(listing.attributes, ctx.lidoEmMs);
  const indicadores: IndicadoresSkuPrecoAmazon = {
    temPrecoComDesconto: oferta.temPrecoComDesconto,
    temOfertaB2B: oferta.temOfertaB2B,
    fechada: oferta.fechada,
    problemaDePreco: temIssuePrecoBloqueanteAmazon(listing.issues),
  };
  // 4. The faixa.
  const faixa =
    e.fontes === null
      ? { tipo: TIPO_FAIXA_PRECO_AMAZON.semPreco }
      : faixaDePrecoAmazon(e.fontes, ctx.tabelas);
  if (faixa.tipo !== TIPO_FAIXA_PRECO_AMAZON.faixa) {
    return recusado(RECUSA_DA_FAIXA[faixa.tipo], indicadores);
  }
  // 5. The listing's type.
  const tipoProduto = tipoProdutoDoListingPrecoAmazon(listing);
  if (tipoProduto === null) return recusado(MOTIVO_PRECO_AMAZON.tipoProdutoIlegivel, indicadores);
  // 6. The plan.
  const plano = planejarPrecoAmazon(faixa.faixa, oferta, {
    buyable: compravelNoBrPrecoAmazon(listing),
    baixarPreco: ctx.baixarPreco,
    consentimentoValido: true,
    pisoConsentimento: null,
    envioRecente: v.envioRecente,
    feedRecenteEmMs: null,
    agoraMs: ctx.lidoEmMs,
  });
  if (plano.decisao === DECISAO_PLANO_PRECO_AMAZON.igual) {
    return { classe: CLASSE_SKU_PRECO_AMAZON.igual, indicadores };
  }
  if (plano.decisao !== DECISAO_PLANO_PRECO_AMAZON.escrever) {
    return recusado(plano.decisao, indicadores);
  }
  const lida = oferta.tipo === TIPO_OFERTA_PRECO_AMAZON.lida ? oferta : null;
  return {
    classe: CLASSE_SKU_PRECO_AMAZON.enviavel,
    item: {
      sku: e.sku,
      vinculo: e.vinculo,
      unidadeId: v.unidadeId,
      oferta:
        lida === null
          ? { tipo: plano.oferta, base: null, minimo: null, maximo: null }
          : { tipo: lida.tipo, base: lida.base, minimo: lida.minimo, maximo: lida.maximo },
      faixa: faixa.faixa,
      tipoProduto,
      lidoEmMs: ctx.lidoEmMs,
    },
    direcao: plano.direcao,
    referencia: plano.referencia,
    quedaExcessiva:
      plano.direcao === DIRECAO_PRECO_AMAZON.desce &&
      quedaExcessivaPrecoAmazon(faixa.faixa.base, plano.referencia),
    direcaoDesconhecida:
      plano.direcao === DIRECAO_PRECO_AMAZON.desconhecida &&
      plano.oferta !== TIPO_OFERTA_PRECO_AMAZON.ausente,
    semCaminho: !skuTemCaminhoAmazon(e.sku),
    indicadores,
  };
}

/* ------------------------------- one page ---------------------------------- */

/** What one page adds to the run's counters. */
export type ContagensPaginaPrecoAmazon = Pick<
  ContagensExecucaoPrecoAmazon,
  | 'iguais'
  | 'enviaveis'
  | 'sobe'
  | 'desce'
  | 'quedaExcessiva'
  | 'direcaoDesconhecida'
  | 'reducaoSemConsentimento'
  | 'precoAtualIlegivel'
  | 'faixaInvertida'
  | 'tipoProdutoIlegivel'
  | 'semPreco'
  | 'semCaminho'
  | 'temPrecoComDesconto'
  | 'temOfertaB2B'
  | 'fechada'
  | 'naoConfirmados'
  | 'problemasDePreco'
  | 'porChave'
>;

/** A page, summed: its counters, its part's members in input order, and its decrease sample. */
export interface ResumoPaginaPrecoAmazon {
  readonly contagens: ContagensPaginaPrecoAmazon;
  readonly itens: readonly ItemDivergenciaPrecoAmazon[];
  /** The page's largest `our_price` decreases, `sku:antes>depois`. */
  readonly amostra: readonly string[];
}

/** The refusals with a named counter; every other one is counted under its motivo. */
const CONTADOR_DA_RECUSA: Partial<
  Record<MotivoPrecoAmazon, keyof Omit<ContagensPaginaPrecoAmazon, 'porChave'>>
> = {
  [MOTIVO_PRECO_AMAZON.reducaoSemConsentimento]: 'reducaoSemConsentimento',
  [MOTIVO_PRECO_AMAZON.precoAtualIlegivel]: 'precoAtualIlegivel',
  [MOTIVO_PRECO_AMAZON.faixaInvertida]: 'faixaInvertida',
  [MOTIVO_PRECO_AMAZON.tipoProdutoIlegivel]: 'tipoProdutoIlegivel',
  [MOTIVO_PRECO_AMAZON.semPreco]: 'semPreco',
  [MOTIVO_PRECO_AMAZON.naoConfirmado]: 'naoConfirmados',
};

/** One page (module header): every SKU classified, then summed. */
export function resumirPaginaPrecoAmazon(
  entradas: readonly EntradaSkuPrecoAmazon[],
  ctx: ContextoPaginaPrecoAmazon,
): ResumoPaginaPrecoAmazon {
  const c = {
    iguais: 0,
    enviaveis: 0,
    sobe: 0,
    desce: 0,
    quedaExcessiva: 0,
    direcaoDesconhecida: 0,
    reducaoSemConsentimento: 0,
    precoAtualIlegivel: 0,
    faixaInvertida: 0,
    tipoProdutoIlegivel: 0,
    semPreco: 0,
    semCaminho: 0,
    temPrecoComDesconto: 0,
    temOfertaB2B: 0,
    fechada: 0,
    naoConfirmados: 0,
    problemasDePreco: 0,
  };
  const porChave: Record<string, number> = {};
  const itens: ItemDivergenciaPrecoAmazon[] = [];
  const reducoes: ReducaoPrecoAmazon[] = [];
  for (const entrada of entradas) {
    const r = classificarSkuPrecoAmazon(entrada, ctx);
    if (r.indicadores !== null) {
      if (r.indicadores.temPrecoComDesconto) c.temPrecoComDesconto += 1;
      if (r.indicadores.temOfertaB2B) c.temOfertaB2B += 1;
      if (r.indicadores.fechada) c.fechada += 1;
      if (r.indicadores.problemaDePreco) c.problemasDePreco += 1;
    }
    if (r.classe === CLASSE_SKU_PRECO_AMAZON.recusado) {
      const contador = CONTADOR_DA_RECUSA[r.motivo];
      if (contador === undefined) porChave[r.motivo] = (porChave[r.motivo] ?? 0) + 1;
      else c[contador] += 1;
      continue;
    }
    if (r.classe === CLASSE_SKU_PRECO_AMAZON.igual) {
      c.iguais += 1;
      continue;
    }
    c.enviaveis += 1;
    itens.push(r.item);
    if (r.direcao === DIRECAO_PRECO_AMAZON.sobe) c.sobe += 1;
    if (r.direcao === DIRECAO_PRECO_AMAZON.desce) {
      c.desce += 1;
      if (r.referencia !== null) {
        reducoes.push({ sku: r.item.sku, antes: r.referencia, depois: r.item.faixa.base });
      }
    }
    if (r.quedaExcessiva) c.quedaExcessiva += 1;
    if (r.direcaoDesconhecida) c.direcaoDesconhecida += 1;
    if (r.semCaminho) c.semCaminho += 1;
  }
  return { contagens: { ...c, porChave }, itens, amostra: amostraReducoesPrecoAmazon(reducoes) };
}

/** What a page does about its part (module header, "The page's part"). */
export type DestinoPartePaginaPrecoAmazon =
  | { readonly acao: 'nenhuma' }
  | { readonly acao: 'escrever'; readonly parte: number }
  | { readonly acao: 'truncar' };

/**
 * The page's part (module header): none for a page with no enviável SKU, else
 * part `proximaParte`, unless that is past the run's last part.
 *
 * @throws {RangeError} an argument outside a non-negative safe integer.
 */
export function parteDaPaginaPrecoAmazon(
  proximaParte: number,
  enviaveis: number,
): DestinoPartePaginaPrecoAmazon {
  exigirInteiro(proximaParte, 'proximaParte');
  if (exigirInteiro(enviaveis, 'enviaveis') === 0) return { acao: 'nenhuma' };
  return proximaParte >= MAX_PARTES_EXECUCAO_PRECO_AMAZON
    ? { acao: 'truncar' }
    : { acao: 'escrever', parte: proximaParte };
}

/* --------------------------------- Decide ---------------------------------- */

/** One block batch: consecutive parts `[parteInicial, parteInicial + partes)` and their items. */
export interface IntervaloLotePrecoAmazon {
  readonly parteInicial: number;
  readonly partes: number;
  readonly itens: number;
}

/** A run's part sizes, each 1 to a part's bound, at most the run's last part. */
function exigirPartes(itensPorParte: readonly number[]): readonly number[] {
  if (itensPorParte.length > MAX_PARTES_EXECUCAO_PRECO_AMAZON) {
    throw new RangeError('paginaPreco.ts: partes demais para uma execução');
  }
  for (const itens of itensPorParte) {
    if (!Number.isSafeInteger(itens) || itens < 1 || itens > MAX_ITENS_DIVERGENCIA_PRECO_AMAZON) {
      throw new RangeError('paginaPreco.ts: uma parte tem de 1 a MAX_ITENS_DIVERGENCIA itens');
    }
  }
  return itensPorParte;
}

/**
 * The packing (module header): consecutive parts, greedily, within both caps.
 *
 * @throws {RangeError} a part size outside `1…MAX_ITENS_DIVERGENCIA_PRECO_AMAZON`,
 *   or more parts than a run may hold.
 */
export function lotesDePartesPrecoAmazon(
  itensPorParte: readonly number[],
): IntervaloLotePrecoAmazon[] {
  const lotes: { parteInicial: number; partes: number; itens: number }[] = [];
  for (const [parte, itens] of exigirPartes(itensPorParte).entries()) {
    const atual = lotes.at(-1);
    if (
      atual !== undefined &&
      atual.itens + itens <= MAX_MENSAGENS_LOTE_PRECO_AMAZON &&
      atual.partes + 1 <= MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON
    ) {
      atual.partes += 1;
      atual.itens += itens;
    } else {
      lotes.push({ parteInicial: parte, partes: 1, itens });
    }
  }
  return lotes;
}

/** What the mass-decrease stop reads (module header, Decide step 1). */
export interface EntradaReducaoEmMassaPrecoAmazon {
  readonly desce: number;
  readonly quedaExcessiva: number;
  /** Sendable SKUs whose current `our_price` is unknown: each a possible decrease. */
  readonly direcaoDesconhecida: number;
  readonly enviaveis: number;
  readonly baixarPreco: boolean;
  readonly confirmarReducaoEmMassa: boolean;
}

/** Whether the run stops before sending anything (module header, Decide step 1). */
export function reducaoEmMassaPrecoAmazon(e: EntradaReducaoEmMassaPrecoAmazon): boolean {
  if (!e.baixarPreco || e.confirmarReducaoEmMassa) return false;
  const possiveis = e.desce + e.direcaoDesconhecida;
  return (
    possiveis >= LIMIAR_REDUCAO_EM_MASSA_PRECO_AMAZON ||
    (possiveis > LIMIAR_FEED_PRECO_AMAZON &&
      possiveis > e.enviaveis * FRACAO_REDUCAO_EM_MASSA_PRECO_AMAZON) ||
    e.quedaExcessiva > 0
  );
}

/** What Decide reads (module header, Decide). */
export interface EntradaFimPrecoAmazon {
  /** Each part's item count, in part order. */
  readonly itensPorParte: readonly number[];
  /** Enviável SKUs no per-SKU patch can carry. */
  readonly semCaminho: number;
  /** `decidirLote` of the EFFECTIVE price valve. */
  readonly decisaoLote: DecisaoLoteAmazon;
  readonly contagens: Pick<
    ContagensExecucaoPrecoAmazon,
    'desce' | 'quedaExcessiva' | 'direcaoDesconhecida'
  >;
  readonly baixarPreco: boolean;
  readonly confirmarReducaoEmMassa: boolean;
}

/** Decide's answer: the run's `decisao`, and the packed batches for `lotes`. */
export type FimPrecoAmazon =
  | {
      readonly decisao: Exclude<
        DecisaoExecucaoPrecoAmazon,
        typeof DECISAO_EXECUCAO_PRECO_AMAZON.lotes
      >;
    }
  | {
      readonly decisao: typeof DECISAO_EXECUCAO_PRECO_AMAZON.lotes;
      readonly lotes: readonly IntervaloLotePrecoAmazon[];
    };

/**
 * Decide (module header).
 *
 * @throws {RangeError} a part size or a count outside its domain.
 */
export function decidirFimPrecoAmazon(e: EntradaFimPrecoAmazon): FimPrecoAmazon {
  const d = exigirPartes(e.itensPorParte).reduce((soma, itens) => soma + itens, 0);
  exigirInteiro(e.semCaminho, 'semCaminho');
  const parada = reducaoEmMassaPrecoAmazon({
    desce: exigirInteiro(e.contagens.desce, 'desce'),
    quedaExcessiva: exigirInteiro(e.contagens.quedaExcessiva, 'quedaExcessiva'),
    direcaoDesconhecida: exigirInteiro(e.contagens.direcaoDesconhecida, 'direcaoDesconhecida'),
    enviaveis: d,
    baixarPreco: e.baixarPreco,
    confirmarReducaoEmMassa: e.confirmarReducaoEmMassa,
  });
  if (parada) return { decisao: DECISAO_EXECUCAO_PRECO_AMAZON.reducaoEmMassa };
  if (d === 0) return { decisao: DECISAO_EXECUCAO_PRECO_AMAZON.nada };
  if (e.decisaoLote.modo === 'so-patches-do-canario') {
    return { decisao: DECISAO_EXECUCAO_PRECO_AMAZON.canario };
  }
  if (e.decisaoLote.modo === 'off') return { decisao: DECISAO_EXECUCAO_PRECO_AMAZON.dryRun };
  if (d <= LIMIAR_FEED_PRECO_AMAZON && e.semCaminho === 0) {
    return {
      decisao:
        e.decisaoLote.modo === 'dry-run'
          ? DECISAO_EXECUCAO_PRECO_AMAZON.dryRun
          : DECISAO_EXECUCAO_PRECO_AMAZON.tarefas,
    };
  }
  return {
    decisao: DECISAO_EXECUCAO_PRECO_AMAZON.lotes,
    lotes: lotesDePartesPrecoAmazon(e.itensPorParte),
  };
}
