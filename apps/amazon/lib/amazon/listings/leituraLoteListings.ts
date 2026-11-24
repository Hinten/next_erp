/**
 * The batched LIVE READ of the Amazon listings flows (step 13, PR 13-b):
 * Amazon's current listing of MANY SKUs of one conta, paced, for a batch
 * reader that then judges each SKU itself. ONE read for every flow; a flow
 * binds it with the datasets it decides on (`incluir`) and its own flow name
 * (its search lines). The stock flow's binding is
 * `estoque/avaliacaoLoteEstoque.ts` (a reconcile page and a window build). It
 * reaches Amazon only through `listingsAmazon.ts`.
 *
 * ## The reads
 *
 *  - A SKU the search can carry (`skuBuscavelAmazon`) is read by
 *    `searchListingsItems`, {@link MAX_SKUS_POR_BUSCA} (20) SKUs a call, sorted,
 *    the calls at least {@link INTERVALO_BUSCAS_LISTINGS_AMAZON_MS} (220 ms)
 *    apart: ≤ 4.5 a second against the operation's 5/5.
 *  - A requested SKU missing from an answer is not "not listed": a page may be
 *    truncated. When the answer is flagged truncated (a `nextToken`, or a
 *    `numberOfResults` other than its item count), each of its missing SKUs is
 *    searched AGAIN, alone, before any GET. A SKU still missing — from an
 *    untruncated answer, or from its own re-search — is confirmed by ONE
 *    `getListingsItem`: only that read's own 404 is `nao-listado`; a listing
 *    the GET found is marked `confirmadoPorGet`.
 *  - A SKU the search cannot carry is read alone by `getListingsItem` when a
 *    path can carry it (`skuTemCaminhoAmazon`), else it ends `sem-caminho`
 *    (nothing can read it, so nothing may send it).
 *  - The GETs — the confirmations and the single reads, sorted by SKU — are at
 *    least {@link INTERVALO_GETS_LISTINGS_AMAZON_MS} (334 ms) apart: ≤ 3 a
 *    second, because `getListingsItem`'s per-seller 5 a second is SHARED with
 *    the stock queue's own reads (≤ 2 a second), and they share ONE cap,
 *    `maxGets` (`null` = every miss confirmed, as a reconcile page asks). Past
 *    the cap — or for a missed SKU no path can carry — the SKU ends
 *    `nao-confirmado` (fail closed: it is NOT read, so it is not sent).
 *  - Every search writes ONE line under the flow's own event (`fase:
 *    'busca'`): the SKU count, the items, `truncada`, whether it was a
 *    re-search, and the rate Amazon applied (`limiteTaxa`). Never a SKU list.
 *  - A failed Amazon call (a 429, a 5xx, a refusal) is thrown UNTOUCHED, with
 *    its own class: what a failure means for the batch is its caller's to
 *    decide.
 *  - Every call asks EXACTLY the caller's `incluir`, a search and a GET alike.
 *
 * The pacing waits on the caller's sleep (`esperar`), measured on the caller's
 * clock (`agora`), so a test drives both.
 *
 * ## The deadline
 *
 * The caller's `prazoMs`, an absolute instant in ms, is read before every
 * Amazon call, after its pacing wait. Once it has passed, nothing more is
 * started and the answer is `prazo`, naming the stage it stopped before
 * (`busca` or `leitura`), with what was decided so far; a call already started
 * is awaited.
 *
 * ## What it answers
 *
 * Per SKU decided (each distinct SKU asked, once the read is `completa`):
 * `lido` with Amazon's reading (a listing, or `nao-listado`) and whether a GET
 * confirmed a miss, `sem-caminho`, or `nao-confirmado`; plus the calls made.
 *
 * No Firestore, no task, no clock conversion: the only effects are the
 * listings calls and their lines.
 *
 * ⚠️ D11: nothing here reaches Amazon unless the caller's context does — the
 * context loader refuses while the read switch is off.
 */
import {
  type EntradaBuscaListings,
  type ListingAmazon,
  MAX_SKUS_POR_BUSCA,
  skuBuscavelAmazon,
  skuTemCaminhoAmazon,
} from '@delfrance/integrations-amazon-sp-api';

import type { ContextoAmazon } from '../core/contexto';
import { type CamposLogAmazon, type LoggerAmazon, registrarEventoAmazon } from '../core/log';
import type { FluxoListingAmazon } from './fluxoListing';
import {
  type ContextoDosListingsAmazon,
  type LeituraListingNaAmazon,
  buscarListingsNaAmazon,
  lerListingNaAmazon,
} from './listingsAmazon';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/** The floor between two searches, in ms (module header): ≤ 4.5 a second against 5/5. */
export const INTERVALO_BUSCAS_LISTINGS_AMAZON_MS = 220;

/** The floor between two listing GETs, in ms (module header): ≤ 3 a second, the rest the stock queue's. */
export const INTERVALO_GETS_LISTINGS_AMAZON_MS = 334;

/** The `fase` of a search's line. */
export const FASE_BUSCA_LISTINGS_AMAZON = 'busca';

/** The stage a deadline stopped before (module header, "The deadline"). */
export const ETAPA_LEITURA_LOTE_LISTINGS_AMAZON = {
  busca: 'busca',
  leitura: 'leitura',
} as const;

export type EtapaLeituraLoteListingsAmazon =
  (typeof ETAPA_LEITURA_LOTE_LISTINGS_AMAZON)[keyof typeof ETAPA_LEITURA_LOTE_LISTINGS_AMAZON];

/** How one SKU's read ended (module header, "What it answers"). */
export const DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON = {
  lido: 'lido',
  semCaminho: 'sem-caminho',
  naoConfirmado: 'nao-confirmado',
} as const;

/** How the read ended. */
export const DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON = {
  completa: 'completa',
  prazo: 'prazo',
} as const;

/** Who reads: the conta's context, the logger, and the caller's clock and sleep. */
export interface ContextoLeituraLoteListingsAmazon {
  /** The conta's context (the read switch already passed): its id, read client and access getter. */
  readonly contexto: Pick<ContextoAmazon, 'integracaoId'> & ContextoDosListingsAmazon;
  readonly logger: LoggerAmazon;
  /** Now, in MILLISECONDS: the deadline and the pacing read it. */
  readonly agora: () => number;
  /** The seller the listings calls name. */
  readonly sellerId: string;
  /** A sleep of `ms` milliseconds: the pacing between two calls. */
  readonly esperar: (ms: number) => Promise<void>;
}

export interface OpcoesLeituraLoteListingsAmazon {
  /** The flow reading: its event names the search lines. */
  readonly fluxo: FluxoListingAmazon;
  /** The datasets every call asks for (`includedData`), exactly as given. */
  readonly incluir: EntradaBuscaListings['incluir'];
  /** ms — the instant past which nothing more is started (module header, "The deadline"). */
  readonly prazoMs: number;
  /** The most `getListingsItem` calls (the confirmations and the single reads together); `null` = no cap. */
  readonly maxGets: number | null;
}

/** One SKU, read (module header, "What it answers"). */
export type LeituraSkuListingsAmazon =
  | {
      readonly tipo: typeof DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.lido;
      /** Amazon's listing, or `nao-listado` (a GET's own 404). */
      readonly leitura: LeituraListingNaAmazon;
      /** A miss of the search, read by its confirming GET. */
      readonly confirmadoPorGet: boolean;
    }
  | { readonly tipo: typeof DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.semCaminho }
  | { readonly tipo: typeof DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.naoConfirmado };

/** The calls one read made, by kind. */
export interface ChamadasLeituraLoteListingsAmazon {
  /** Searches, a re-search included. */
  readonly buscas: number;
  /** Of {@link buscas}, the re-searches of a truncated answer's missing SKUs. */
  readonly rebuscas: number;
  /** `getListingsItem` calls: the confirmations and the single reads. */
  readonly gets: number;
}

export type LeituraLoteListingsAmazon =
  | {
      readonly tipo: typeof DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON.completa;
      /** One entry per distinct SKU asked. */
      readonly porSku: ReadonlyMap<string, LeituraSkuListingsAmazon>;
      readonly chamadas: ChamadasLeituraLoteListingsAmazon;
    }
  | {
      readonly tipo: typeof DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON.prazo;
      readonly etapa: EtapaLeituraLoteListingsAmazon;
      /** What was decided before the deadline (a subset of the SKUs asked). */
      readonly porSku: ReadonlyMap<string, LeituraSkuListingsAmazon>;
      readonly chamadas: ChamadasLeituraLoteListingsAmazon;
    };

/* -------------------------------------------------------------------------- */
/*                                   helpers                                  */
/* -------------------------------------------------------------------------- */

/** `itens` in consecutive slices of at most `tamanho`. */
function fatias<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/** Code-unit order (a SKU is compared as exact bytes). */
function porTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The options checked before anything is read.
 *
 * @throws {RangeError} naming the field, never its value.
 */
function exigirOpcoes(opcoes: OpcoesLeituraLoteListingsAmazon): void {
  if (!Number.isSafeInteger(opcoes.prazoMs) || opcoes.prazoMs < 0) {
    throw new RangeError('leituraLoteListings.ts: prazoMs deve ser um instante em ms');
  }
  if (opcoes.maxGets !== null && (!Number.isSafeInteger(opcoes.maxGets) || opcoes.maxGets < 0)) {
    throw new RangeError('leituraLoteListings.ts: maxGets deve ser null ou um inteiro >= 0');
  }
}

/** The floor between two calls of one kind, on the caller's clock and sleep. */
interface RitmoAmazon {
  /** Waits until the floor since the previous call's start has passed. */
  aguardar(): Promise<void>;
  /** A call starts now. */
  marcar(): void;
}

function ritmo(ctx: ContextoLeituraLoteListingsAmazon, intervaloMs: number): RitmoAmazon {
  let inicioAnteriorMs: number | null = null;
  return {
    async aguardar() {
      if (inicioAnteriorMs === null) return;
      const falta = inicioAnteriorMs + intervaloMs - ctx.agora();
      if (falta > 0) await ctx.esperar(falta);
    },
    marcar() {
      inicioAnteriorMs = ctx.agora();
    },
  };
}

/** A search's line (module header): counts, the flags and the rate; never a SKU. */
function registrarBusca(
  logger: LoggerAmazon,
  fluxo: FluxoListingAmazon,
  contaId: string,
  campos: CamposLogAmazon,
): void {
  registrarEventoAmazon(
    logger,
    fluxo,
    'INFO',
    `[amazon/${fluxo}] busca de listings de um lote`,
    campos,
    { conta: contaId, fluxo },
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the read                                  */
/* -------------------------------------------------------------------------- */

/**
 * Amazon's live listing of every SKU of `skusPedidos` (deduplicated), paced,
 * under the deadline (module header).
 *
 * @throws {RangeError} a deadline that is not a ms instant, or a GET cap that
 *   is not `null` or a non-negative integer (nothing read).
 * @throws the listings calls' own failures, untouched.
 */
export async function lerListingsEmLoteAmazon(
  ctx: ContextoLeituraLoteListingsAmazon,
  skusPedidos: readonly string[],
  opcoes: OpcoesLeituraLoteListingsAmazon,
): Promise<LeituraLoteListingsAmazon> {
  exigirOpcoes(opcoes);
  const { fluxo, incluir } = opcoes;
  const contaId = ctx.contexto.integracaoId;
  const skus = [...new Set(skusPedidos)].sort(porTexto);
  const chamadas = { buscas: 0, rebuscas: 0, gets: 0 };
  const porSku = new Map<string, LeituraSkuListingsAmazon>();
  const venceu = () => ctx.agora() >= opcoes.prazoMs;
  const prazo = (etapa: EtapaLeituraLoteListingsAmazon): LeituraLoteListingsAmazon => ({
    tipo: DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON.prazo,
    etapa,
    porSku,
    chamadas: { ...chamadas },
  });
  const ritmoBuscas = ritmo(ctx, INTERVALO_BUSCAS_LISTINGS_AMAZON_MS);
  const ritmoGets = ritmo(ctx, INTERVALO_GETS_LISTINGS_AMAZON_MS);

  /** ONE search, paced, logged: the requested SKUs found, and whether the page may lack some. */
  const buscar = async (
    grupo: readonly string[],
    rebusca: boolean,
  ): Promise<{ achados: Map<string, ListingAmazon>; truncada: boolean } | null> => {
    await ritmoBuscas.aguardar();
    if (venceu()) return null;
    ritmoBuscas.marcar();
    const resposta = await buscarListingsNaAmazon(ctx.contexto, {
      sellerId: ctx.sellerId,
      skus: grupo,
      incluir,
    });
    chamadas.buscas += 1;
    if (rebusca) chamadas.rebuscas += 1;
    const pedidos = new Set(grupo);
    const achados = new Map<string, ListingAmazon>();
    for (const item of resposta.itens) {
      if (pedidos.has(item.sku) && !achados.has(item.sku)) achados.set(item.sku, item);
    }
    registrarBusca(ctx.logger, fluxo, contaId, {
      fase: FASE_BUSCA_LISTINGS_AMAZON,
      rebusca,
      skus: grupo.length,
      itens: resposta.itens.length,
      encontrados: achados.size,
      truncada: resposta.truncada,
      limiteTaxa: resposta.limiteTaxa,
    });
    return { achados, truncada: resposta.truncada };
  };
  const lido = (leitura: LeituraListingNaAmazon, confirmadoPorGet: boolean) => ({
    tipo: DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.lido,
    leitura,
    confirmadoPorGet,
  });

  // ---- The searches: 20 a call, then a truncated answer's misses alone. ----
  const buscaveis = skus.filter((sku) => skuBuscavelAmazon(sku));
  const aRebuscar: string[] = [];
  const aConfirmar: string[] = [];
  for (const grupo of fatias(buscaveis, MAX_SKUS_POR_BUSCA)) {
    const r = await buscar(grupo, false);
    if (r === null) return prazo(ETAPA_LEITURA_LOTE_LISTINGS_AMAZON.busca);
    for (const sku of grupo) {
      const item = r.achados.get(sku);
      if (item !== undefined) porSku.set(sku, lido(item, false));
      else if (r.truncada) aRebuscar.push(sku);
      else aConfirmar.push(sku);
    }
  }
  for (const sku of aRebuscar) {
    const r = await buscar([sku], true);
    if (r === null) return prazo(ETAPA_LEITURA_LOTE_LISTINGS_AMAZON.busca);
    const item = r.achados.get(sku);
    if (item !== undefined) porSku.set(sku, lido(item, false));
    else aConfirmar.push(sku);
  }

  // ---- The GETs: the confirmations and the single reads, sorted, under ONE cap. ----
  const confirmacoes = new Set(aConfirmar);
  const sozinhos = skus.filter((sku) => !skuBuscavelAmazon(sku));
  const aLerPorGet = [...aConfirmar, ...sozinhos].sort(porTexto);
  for (const sku of aLerPorGet) {
    if (!skuTemCaminhoAmazon(sku)) {
      porSku.set(sku, {
        tipo: confirmacoes.has(sku)
          ? DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.naoConfirmado
          : DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.semCaminho,
      });
      continue;
    }
    if (opcoes.maxGets !== null && chamadas.gets >= opcoes.maxGets) {
      porSku.set(sku, { tipo: DESFECHO_SKU_LEITURA_LOTE_LISTINGS_AMAZON.naoConfirmado });
      continue;
    }
    await ritmoGets.aguardar();
    if (venceu()) return prazo(ETAPA_LEITURA_LOTE_LISTINGS_AMAZON.leitura);
    ritmoGets.marcar();
    const leitura = await lerListingNaAmazon(ctx.contexto, {
      sellerId: ctx.sellerId,
      sku,
      incluir,
    });
    chamadas.gets += 1;
    porSku.set(sku, lido(leitura, confirmacoes.has(sku)));
  }

  return {
    tipo: DESFECHO_LEITURA_LOTE_LISTINGS_AMAZON.completa,
    porSku,
    chamadas: { ...chamadas },
  };
}
