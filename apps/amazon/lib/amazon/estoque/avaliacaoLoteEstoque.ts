/**
 * The per-SKU evaluator of the Amazon stock sync's BATCHES (step 12, PR 12-f):
 * for MANY SKUs of one conta at one depósito, everything a send decides on —
 * the link verdict, the ERP quantity, Amazon's live listing and the listing
 * gate — read in bulk, masked and deduplicated across the SKUs. ONE module,
 * {@link avaliarSkusEstoqueAmazon}, serves both batch readers: a reconcile
 * walk page and a window batch's feed build. Neither carries its own copy, so
 * the two can never judge a SKU differently.
 *
 * The decisions are the patch task's own pure modules, unchanged: the link
 * verdict (`avaliarVinculoEstoqueAmazon`), the quantity (`quantidadeEstoqueAmazon`,
 * the shared core) and the listing gate (`avaliarListingEstoqueAmazon`). What a
 * caller then SENDS — the drift, the plan — stays the caller's.
 *
 * ## The reads, in order
 *
 *  1–4. The link verdict of every SKU: the listings flows' shared batch reader
 *     (`listings/avaliacaoLoteVinculos.ts`, step 13, PR 13-b; its header holds
 *     the reads, their bounds and their deadline checks), bound here to the
 *     stock masks (`CAMPOS_RESOLVER_ESTOQUE_AMAZON`), the stock verdict
 *     (`REGRA_VINCULO_ESTOQUE_AMAZON`) and, as its extras, the family read's
 *     fields, so the donos' mask is
 *     {@link CAMPOS_LEITURA_DONOS_AVALIACAO_ESTOQUE_AMAZON} and the other units'
 *     {@link CAMPOS_LEITURA_UNIDADES_AVALIACAO_ESTOQUE_AMAZON}: a dono that is
 *     its own unit is read once. Read 1 alone, at the stock projection, is
 *     {@link lerVinculosDosSkusEstoqueAmazon}. A unit the shared reader never
 *     reads (an id that is not a document id) ends its SKU `unidade-ausente`.
 *  5. The ERP quantity of every apt SKU's unit, through the family reader for
 *     units ALREADY READ (`lerMembrosEstoqueAmazon`: estoque rows only, every
 *     component row once however many kits share it), so each produto is read
 *     once in a batch. A unit whose produto is gone ⇒ `unidade-ausente`, never
 *     a 0 derived from a missing document.
 *  6. Amazon's live listing of every SKU still standing — see below.
 *  7. The listing gate per SKU.
 *
 * ## Amazon's live read
 *
 * Read 6 is the listings flows' shared batched read
 * (`listings/leituraLoteListings.ts`, step 13, PR 13-b; its header holds the
 * searches, the re-search of a truncated answer, the confirming GET, the
 * pacing, the GET cap and the search lines), bound here to the stock datasets
 * (`DADOS_LEITURA_ESTOQUE_AMAZON`) and the stock flow, so every search writes
 * ONE `evento: 'estoque'` line. What the stock evaluator adds:
 *
 *  - `maxGets` is `null` for a reconcile page (every miss confirmed) and
 *    {@link MAX_GETS_LOTE_JANELA} (60, ≈ 20 s) for a window build. Past the cap
 *    — or for a missed SKU no path can carry — the SKU ends `nao-confirmado`
 *    and is NOT sent (fail closed: the daily reconcile, which confirms every
 *    miss, handles it). Nothing remembers `nao-listado` between batches, so
 *    without the cap a stale link Amazon no longer lists would cost a GET in
 *    every busy window. A SKU no read can carry ends `sem-caminho`.
 *  - A SKU the search read but no path can carry stays enviável: a feed
 *    carries what the patch path cannot (the patch task refuses it on its own).
 *  - A listing a confirming GET found is counted `confirmadoPorGet`.
 *  - A failed Amazon call is thrown UNTOUCHED: what a failure means for a walk
 *    page or a feed build is its caller's to decide.
 *
 * ## The deadline
 *
 * The caller's `prazoMs`, an absolute instant in ms, is read before every
 * batch of link queries, every `getAll` slice, every batch of children seeks,
 * the family read, and every Amazon call (after its pacing wait). Once it has
 * passed, nothing more is started and the answer is `prazo`, naming the stage
 * it stopped before; nothing partial is handed back (a walk page gives up and
 * its run closes `truncada`; a feed build aborts `snapshot-lento`). A read
 * already started is awaited.
 *
 * ## What it answers
 *
 * `completa`: per distinct SKU asked, sorted, either ENVIÁVEL — the apt link
 * (its unit, its links, the stored outcome the recent-send rule reads), the ERP
 * quantity, the gate's verdict with Amazon's quantity, whether the ERP's 0
 * comes from no estoque row at the depósito, and the shapes counted — or
 * REFUSED with one closed motivo (and the ERP quantity when it was computed).
 * Plus the counters, keyed by the tokens a reconcile run's counter map holds.
 * Or `prazo`, with the counters of what was read.
 *
 * ## Units and rule 7
 *
 * `prazoMs` and every clock read are MILLISECONDS. No Firestore write, no task,
 * no clock conversion: the only effects are reads and the listings calls.
 *
 * ⚠️ D11: nothing here reaches Amazon unless the caller's context does — the
 * context loader refuses while the read switch is off.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { MembroDaFamilia } from '@delfrance/data/admin/estoque';
import { CONTA_ID_AMAZON_REGEX } from '@delfrance/schemas';

import type { ContextoAmazon } from '../core/contexto';
import type { LoggerAmazon } from '../core/log';
import {
  LARGURA_CONSULTAS_VINCULOS_AMAZON,
  avaliarVinculosEmLoteAmazon,
  lerVinculosDosSkusListingAmazon,
} from '../listings/avaliacaoLoteVinculos';
import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import {
  DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON,
  DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON,
  ETAPA_LEITURA_LOTE_LISTINGS_AMAZON,
  FASE_BUSCA_LISTINGS_AMAZON,
  INTERVALO_BUSCAS_LISTINGS_AMAZON_MS,
  INTERVALO_GETS_LISTINGS_AMAZON_MS,
  lerListingsEmLoteAmazon,
} from '../listings/leituraLoteListings';
import type { ContextoDosListingsAmazon } from '../listings/listingsAmazon';
import {
  type LeituraVinculosDoSkuAmazon,
  mascaraDosDonosAmazon,
} from '../pedidos/vinculoProdutoAmazon';
import {
  CAMPOS_UNIDADE_ESTOQUE_AMAZON,
  formasRefDepositoEstoqueAmazon,
  quantidadeEstoqueAmazon,
} from './familiaEstoque';
import { lerMembrosEstoqueAmazon } from './familiaEstoqueFirestore';
import {
  DADOS_LEITURA_ESTOQUE_AMAZON,
  type VeredictoListingEstoqueAmazon,
  avaliarListingEstoqueAmazon,
} from './gateListing';
import {
  CONTADOR_ESTOQUE_AMAZON,
  type ContadorEstoqueAmazon,
  MOTIVO_ESTOQUE_AMAZON,
  RECUSAS_HUMANAS_ESTOQUE_AMAZON,
  type RecusaListingEstoqueAmazon,
  type RecusaVinculoEstoqueAmazon,
} from './motivosEstoque';
import {
  CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON,
  CAMPOS_RESOLVER_ESTOQUE_AMAZON,
} from './resolverEstoque';
import {
  CAMPOS_DONO_ESTOQUE_AMAZON,
  CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON,
  REGRA_VINCULO_ESTOQUE_AMAZON,
  type VinculoAptoEstoqueAmazon,
} from './vinculoEstoque';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/** The floor between two searches, in ms: the shared read's (module header). */
export const INTERVALO_BUSCAS_ESTOQUE_AMAZON_MS = INTERVALO_BUSCAS_LISTINGS_AMAZON_MS;

/** The floor between two listing GETs, in ms: the shared read's (module header). */
export const INTERVALO_GETS_ESTOQUE_AMAZON_MS = INTERVALO_GETS_LISTINGS_AMAZON_MS;

/**
 * The GET cap of a WINDOW batch's build (module header): the confirmations and
 * the single reads together, ≈ 20 s at their pacing. A reconcile page passes
 * `null` (no cap).
 */
export const MAX_GETS_LOTE_JANELA = 60;

/** Link queries and children seeks in flight at once (the shared batch reader's). */
export const LARGURA_CONSULTAS_AVALIACAO_ESTOQUE_AMAZON = LARGURA_CONSULTAS_VINCULOS_AMAZON;

/** What the donos' read carries besides the hop's own fields: the verdict's, then the family read's. */
const CAMPOS_EXTRAS_DOS_DONOS = [...CAMPOS_DONO_ESTOQUE_AMAZON, ...CAMPOS_UNIDADE_ESTOQUE_AMAZON];

/**
 * The donos' mask (module header, reads 1–4): the hop's and the verdict's fields
 * (`resolverEstoque.ts`'s own), then the family read's, so a dono that is its
 * own unit is read once.
 */
export const CAMPOS_LEITURA_DONOS_AVALIACAO_ESTOQUE_AMAZON: readonly string[] =
  mascaraDosDonosAmazon(CAMPOS_EXTRAS_DOS_DONOS);

/** The other units' mask (module header, reads 1–4): refusal 4's fields, then the family read's. */
export const CAMPOS_LEITURA_UNIDADES_AVALIACAO_ESTOQUE_AMAZON: readonly string[] = [
  ...new Set<string>([...CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON, ...CAMPOS_UNIDADE_ESTOQUE_AMAZON]),
];

/** The `fase` of a search's line: the shared read's. */
export const FASE_BUSCA_ESTOQUE_AMAZON = FASE_BUSCA_LISTINGS_AMAZON;

/** The stage a deadline stopped before (module header, "The deadline"). */
export const ETAPA_AVALIACAO_ESTOQUE_AMAZON = {
  vinculos: 'vinculos',
  donos: 'donos',
  unidades: 'unidades',
  estoque: 'estoque',
  busca: 'busca',
  leitura: 'leitura',
} as const;

export type EtapaAvaliacaoEstoqueAmazon =
  (typeof ETAPA_AVALIACAO_ESTOQUE_AMAZON)[keyof typeof ETAPA_AVALIACAO_ESTOQUE_AMAZON];

/** How an evaluation ended. */
export const DESFECHO_AVALIACAO_ESTOQUE_AMAZON = {
  completa: 'completa',
  prazo: 'prazo',
} as const;

/** Who evaluates: the conta's context, the db, the logger, and the caller's clock and sleep. */
export interface ContextoAvaliacaoEstoqueAmazon {
  /** The conta's context (the read switch already passed): its id, read client and access getter. */
  readonly contexto: Pick<ContextoAmazon, 'integracaoId'> & ContextoDosListingsAmazon;
  readonly db: Firestore;
  readonly logger: LoggerAmazon;
  /** Now, in MILLISECONDS: the deadline and the pacing read it. */
  readonly agora: () => number;
  /** The seller the listings calls name. */
  readonly sellerId: string;
  /** A sleep of `ms` milliseconds: the pacing between two calls. */
  readonly esperar: (ms: number) => Promise<void>;
}

export interface OpcoesAvaliacaoEstoqueAmazon {
  /** The conta's depósito, as a document id: the ERP quantity is read there. */
  readonly depositoId: string;
  /** ms — the instant past which nothing more is started (module header, "The deadline"). */
  readonly prazoMs: number;
  /**
   * The most `getListingsItem` calls (the confirmations and the single reads
   * together): `null` = no cap (a reconcile page), {@link MAX_GETS_LOTE_JANELA}
   * for a window build.
   */
  readonly maxGets: number | null;
  /**
   * The link docs the caller ALREADY read for some of the SKUs, through read 1
   * at the stock projection ({@link lerVinculosDosSkusEstoqueAmazon}, or the
   * shared page core bound to the stock masks): a reconcile page reads them
   * first to apply its dedupe rule, so a SKU's query runs once per page. A SKU
   * absent here is read as usual; an entry for a SKU not asked is ignored.
   */
  readonly vinculosLidos?: ReadonlyMap<string, LeituraVinculosDoSkuAmazon>;
}

/** Why a SKU is not enviável: one closed motivo. */
export type RecusaAvaliacaoEstoqueAmazon =
  | RecusaVinculoEstoqueAmazon
  | RecusaListingEstoqueAmazon
  | typeof MOTIVO_ESTOQUE_AMAZON.unidadeAusente
  | typeof MOTIVO_ESTOQUE_AMAZON.semCaminho
  | typeof MOTIVO_ESTOQUE_AMAZON.naoConfirmado;

/** The gate's verdict on a listing that may receive a quantity. */
export type GateEnviavelEstoqueAmazon = Extract<
  VeredictoListingEstoqueAmazon,
  { readonly enviavel: true }
>;

/** One SKU, evaluated (module header, "What it answers"). */
export type AvaliacaoSkuEstoqueAmazon =
  | {
      readonly sku: string;
      readonly enviavel: true;
      /** The apt link: its unit, its links, the stored outcome the recent-send rule reads. */
      readonly vinculo: VinculoAptoEstoqueAmazon;
      /** The quantity the ERP publishes for the SKU now. */
      readonly quantidadeErp: number;
      /** Amazon's current merchant quantity, or `null` when its listing shows none. */
      readonly quantidadeAmazon: number | null;
      readonly gate: GateEnviavelEstoqueAmazon;
      /** No estoque row at the depósito, the unit's or a component's, stands behind the quantity. */
      readonly semLinha: boolean;
      /** The shapes counted for this SKU (sorted, distinct). */
      readonly contagens: readonly ContadorEstoqueAmazon[];
    }
  | {
      readonly sku: string;
      readonly enviavel: false;
      readonly motivo: RecusaAvaliacaoEstoqueAmazon;
      /** The apt link, when the link verdict passed. */
      readonly vinculo: VinculoAptoEstoqueAmazon | null;
      /** The ERP quantity, when it was computed. */
      readonly quantidadeErp: number | null;
    };

/** What an evaluation read, by kind. */
export interface LeiturasAvaliacaoEstoqueAmazon {
  /** Link-doc queries (one per SKU). */
  readonly consultas: number;
  /** Produtos read by id: the donos and the other units. */
  readonly produtos: number;
  /** Children seeks (one per distinct unit). */
  readonly filhos: number;
  /** Parent pointers read (distinct). */
  readonly ponteiros: number;
  /** Searches, a re-search included. */
  readonly buscas: number;
  /** Of {@link buscas}, the re-searches of a truncated answer's missing SKUs. */
  readonly rebuscas: number;
  /** `getListingsItem` calls: the confirmations and the single reads. */
  readonly gets: number;
}

/** The counters of one evaluation. */
export interface ContagemAvaliacaoEstoqueAmazon {
  /** The distinct SKUs asked. */
  readonly skus: number;
  readonly enviaveis: number;
  /** Enviável SKUs whose ERP 0 comes from no estoque row at the depósito. */
  readonly zeroSemLinha: number;
  /** Refusals a person must fix (`RECUSAS_HUMANAS_ESTOQUE_AMAZON`). */
  readonly recusasHumanas: number;
  /** Per refusal motivo, and per shape counted on the enviável SKUs. */
  readonly porChave: Readonly<Record<string, number>>;
  readonly leituras: LeiturasAvaliacaoEstoqueAmazon;
}

export type AvaliacaoLoteEstoqueAmazon =
  | {
      readonly tipo: typeof DESFECHO_AVALIACAO_ESTOQUE_AMAZON.completa;
      /** One per distinct SKU asked, sorted by SKU. */
      readonly skus: readonly AvaliacaoSkuEstoqueAmazon[];
      readonly contagem: ContagemAvaliacaoEstoqueAmazon;
    }
  | {
      readonly tipo: typeof DESFECHO_AVALIACAO_ESTOQUE_AMAZON.prazo;
      readonly etapa: EtapaAvaliacaoEstoqueAmazon;
      readonly contagem: ContagemAvaliacaoEstoqueAmazon;
    };

/* -------------------------------------------------------------------------- */
/*                                   helpers                                  */
/* -------------------------------------------------------------------------- */

/** Code-unit order (a SKU is compared as exact bytes). */
function porTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The context and options checked before anything is read.
 *
 * @throws {RangeError} naming the field, never its value.
 */
function exigirEntrada(ctx: ContextoAvaliacaoEstoqueAmazon, opcoes: OpcoesAvaliacaoEstoqueAmazon) {
  if (!CONTA_ID_AMAZON_REGEX.test(ctx.contexto.integracaoId)) {
    throw new RangeError('avaliacaoLoteEstoque.ts: integracaoId fora de CONTA_ID_AMAZON_REGEX');
  }
  formasRefDepositoEstoqueAmazon(opcoes.depositoId);
  if (!Number.isSafeInteger(opcoes.prazoMs) || opcoes.prazoMs < 0) {
    throw new RangeError('avaliacaoLoteEstoque.ts: prazoMs deve ser um instante em ms');
  }
  if (opcoes.maxGets !== null && (!Number.isSafeInteger(opcoes.maxGets) || opcoes.maxGets < 0)) {
    throw new RangeError('avaliacaoLoteEstoque.ts: maxGets deve ser null ou um inteiro >= 0');
  }
}

/** Counters being summed. */
interface Contadores {
  consultas: number;
  produtos: number;
  filhos: number;
  ponteiros: number;
  buscas: number;
  rebuscas: number;
  gets: number;
}

/* -------------------------------------------------------------------------- */
/*                                the link reads                              */
/* -------------------------------------------------------------------------- */

/**
 * Read 1 of the module header ON ITS OWN: the shared batch reader's read 1
 * (`lerVinculosDosSkusListingAmazon`), bound to the stock link projection
 * (`CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON`). A stock caller that needs a
 * batch's link docs BEFORE evaluating (a feed build) reads them through it and
 * hands the answer back as `vinculosLidos`. `null` when the deadline passed
 * before a batch started.
 */
export function lerVinculosDosSkusEstoqueAmazon(
  db: Firestore,
  contaId: string,
  skus: readonly string[],
  prazo: { readonly agora: () => number; readonly prazoMs: number },
): Promise<Map<string, LeituraVinculosDoSkuAmazon> | null> {
  return lerVinculosDosSkusListingAmazon(
    db,
    contaId,
    skus,
    CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON,
    prazo,
  );
}

/* -------------------------------------------------------------------------- */
/*                                the evaluator                               */
/* -------------------------------------------------------------------------- */

/**
 * Every SKU of `skus` (deduplicated) of the context's conta, evaluated at
 * `opcoes.depositoId` (module header): reads 1–7, under the deadline.
 *
 * @throws {RangeError} a conta id outside its grammar, a depósito id that is
 *   not a document id, a deadline that is not a ms instant, or a GET cap that
 *   is not `null` or a non-negative integer (nothing read).
 * @throws the listings calls' and Firestore's own failures, untouched.
 */
export async function avaliarSkusEstoqueAmazon(
  ctx: ContextoAvaliacaoEstoqueAmazon,
  skusPedidos: readonly string[],
  opcoes: OpcoesAvaliacaoEstoqueAmazon,
): Promise<AvaliacaoLoteEstoqueAmazon> {
  exigirEntrada(ctx, opcoes);
  const { db } = ctx;
  const contaId = ctx.contexto.integracaoId;
  const skus = [...new Set(skusPedidos)].sort(porTexto);
  const lidos: Contadores = {
    consultas: 0,
    produtos: 0,
    filhos: 0,
    ponteiros: 0,
    buscas: 0,
    rebuscas: 0,
    gets: 0,
  };
  const resultados = new Map<string, AvaliacaoSkuEstoqueAmazon>();
  const venceu = () => ctx.agora() >= opcoes.prazoMs;
  const prazo = (etapa: EtapaAvaliacaoEstoqueAmazon): AvaliacaoLoteEstoqueAmazon => ({
    tipo: DESFECHO_AVALIACAO_ESTOQUE_AMAZON.prazo,
    etapa,
    contagem: contagemDe(skus.length, resultados, lidos),
  });
  const recusar = (
    sku: string,
    motivo: RecusaAvaliacaoEstoqueAmazon,
    vinculo: VinculoAptoEstoqueAmazon | null,
    quantidadeErp: number | null,
  ) => resultados.set(sku, { sku, enviavel: false, motivo, vinculo, quantidadeErp });

  // ---- 1–4. The link verdict per SKU: the shared batch reader, bound to stock. ----
  const vinculos = await avaliarVinculosEmLoteAmazon(db, contaId, skus, {
    campos: CAMPOS_RESOLVER_ESTOQUE_AMAZON,
    regra: REGRA_VINCULO_ESTOQUE_AMAZON,
    extras: { dono: CAMPOS_UNIDADE_ESTOQUE_AMAZON, unidade: CAMPOS_UNIDADE_ESTOQUE_AMAZON },
    prazo: { agora: ctx.agora, prazoMs: opcoes.prazoMs },
    ...(opcoes.vinculosLidos === undefined ? {} : { vinculosLidos: opcoes.vinculosLidos }),
  });
  lidos.consultas += vinculos.leituras.consultas;
  lidos.produtos += vinculos.leituras.produtos;
  lidos.filhos += vinculos.leituras.filhos;
  lidos.ponteiros += vinculos.leituras.ponteiros;
  if (vinculos.tipo === 'prazo') return prazo(vinculos.etapa);
  const aptos = new Map<string, VinculoAptoEstoqueAmazon>();
  /** Each apt SKU's unit document, as the batch read it (the family read's fields among them). */
  const unidadeDoSku = new Map<string, Readonly<Record<string, unknown>> | null>();
  for (const v of vinculos.skus) {
    if (!v.veredicto.apto) {
      recusar(v.sku, v.veredicto.motivo, null, null);
      continue;
    }
    aptos.set(v.sku, v.veredicto);
    unidadeDoSku.set(v.sku, v.unidade);
  }

  // ---- 5. The ERP quantity of every apt SKU's unit, each produto read once. ----
  const unidadesVivas = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [sku, vinculo] of aptos) {
    const raw = unidadeDoSku.get(sku) ?? null;
    if (raw !== null) unidadesVivas.set(vinculo.unidadeId, raw);
  }
  let membros = new Map<string, MembroDaFamilia>();
  if (unidadesVivas.size > 0) {
    if (venceu()) return prazo(ETAPA_AVALIACAO_ESTOQUE_AMAZON.estoque);
    membros = await lerMembrosEstoqueAmazon(db, {
      unidades: [...unidadesVivas.entries()]
        .sort(([a], [b]) => porTexto(a, b))
        .map(([id, raw]) => ({ id, raw })),
      depositoId: opcoes.depositoId,
    });
  }
  const quantidades = new Map<
    string,
    { readonly quantidade: number; readonly semLinha: boolean }
  >();
  for (const [sku, vinculo] of aptos) {
    const membro = membros.get(vinculo.unidadeId);
    if (membro === undefined) {
      recusar(sku, MOTIVO_ESTOQUE_AMAZON.unidadeAusente, vinculo, null);
      continue;
    }
    quantidades.set(sku, {
      quantidade: quantidadeEstoqueAmazon(membro),
      semLinha: membro.estoque === null && membro.componentEstoques.length === 0,
    });
  }

  // ---- 6. Amazon's live listing of every SKU still standing: the shared read, bound to stock. ----
  const leitura = await lerListingsEmLoteAmazon(ctx, [...quantidades.keys()], {
    fluxo: FLUXO_LISTING_AMAZON.estoque,
    incluir: DADOS_LEITURA_ESTOQUE_AMAZON,
    prazoMs: opcoes.prazoMs,
    maxGets: opcoes.maxGets,
  });
  lidos.buscas += leitura.chamadas.buscas;
  lidos.rebuscas += leitura.chamadas.rebuscas;
  lidos.gets += leitura.chamadas.gets;
  for (const [sku, lido] of leitura.porSku) {
    if (lido.tipo === DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.lido) continue;
    recusar(
      sku,
      lido.tipo === DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.semCaminho
        ? MOTIVO_ESTOQUE_AMAZON.semCaminho
        : MOTIVO_ESTOQUE_AMAZON.naoConfirmado,
      aptos.get(sku) ?? null,
      quantidades.get(sku)?.quantidade ?? null,
    );
  }
  if (leitura.tipo === DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON.prazo) {
    return prazo(
      leitura.etapa === ETAPA_LEITURA_LOTE_LISTINGS_AMAZON.busca
        ? ETAPA_AVALIACAO_ESTOQUE_AMAZON.busca
        : ETAPA_AVALIACAO_ESTOQUE_AMAZON.leitura,
    );
  }

  // ---- 7. The listing gate per SKU read. ----
  for (const [sku, lido] of leitura.porSku) {
    if (lido.tipo !== DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.lido) continue;
    const vinculo = aptos.get(sku);
    const q = quantidades.get(sku);
    if (vinculo === undefined || q === undefined) continue;
    const gate = avaliarListingEstoqueAmazon(lido.leitura, vinculo);
    if (!gate.enviavel) {
      recusar(sku, gate.motivo, vinculo, q.quantidade);
      continue;
    }
    const contagens = new Set<ContadorEstoqueAmazon>([...vinculo.contagens, ...gate.contagens]);
    // Counted only on an enviável SKU: a 404 is refused by the gate, so
    // `confirmadoPorGet` is always a miss the GET FOUND.
    if (lido.confirmadoPorGet) contagens.add(CONTADOR_ESTOQUE_AMAZON.confirmadoPorGet);
    if (q.semLinha && q.quantidade === 0) contagens.add(CONTADOR_ESTOQUE_AMAZON.zeroSemLinha);
    resultados.set(sku, {
      sku,
      enviavel: true,
      vinculo,
      quantidadeErp: q.quantidade,
      quantidadeAmazon: gate.quantidadeAmazon,
      gate,
      semLinha: q.semLinha,
      contagens: [...contagens].sort(porTexto),
    });
  }

  const saida = skus.flatMap((sku) => {
    const r = resultados.get(sku);
    return r === undefined ? [] : [r];
  });
  if (saida.length !== skus.length) {
    throw new TypeError('avaliacaoLoteEstoque.ts: um SKU pedido ficou sem avaliação');
  }
  return {
    tipo: DESFECHO_AVALIACAO_ESTOQUE_AMAZON.completa,
    skus: saida,
    contagem: contagemDe(skus.length, resultados, lidos),
  };
}

/** The counters of what was evaluated and read so far. */
function contagemDe(
  skus: number,
  resultados: ReadonlyMap<string, AvaliacaoSkuEstoqueAmazon>,
  lidos: Contadores,
): ContagemAvaliacaoEstoqueAmazon {
  const porChave: Record<string, number> = {};
  const somar = (chave: string) => {
    porChave[chave] = (porChave[chave] ?? 0) + 1;
  };
  let enviaveis = 0;
  let zeroSemLinha = 0;
  let recusasHumanas = 0;
  for (const r of resultados.values()) {
    if (r.enviavel) {
      enviaveis += 1;
      for (const c of r.contagens) somar(c);
      if (r.contagens.includes(CONTADOR_ESTOQUE_AMAZON.zeroSemLinha)) zeroSemLinha += 1;
    } else {
      somar(r.motivo);
      if (RECUSAS_HUMANAS_ESTOQUE_AMAZON.has(r.motivo)) recusasHumanas += 1;
    }
  }
  return { skus, enviaveis, zeroSemLinha, recusasHumanas, porChave, leituras: { ...lidos } };
}
