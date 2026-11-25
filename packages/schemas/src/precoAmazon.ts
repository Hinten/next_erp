import { centavosDeReais, roundReais } from '@delfrance/core/money';
import { z } from 'zod';
import {
  CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX,
  CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON,
  envioEstoqueManualAmazonSchema,
  erroEnvioEstoqueManualAmazonSchema,
  reconciliacaoEstoqueAmazonSchema,
} from './estoqueAmazon';
import { ID_LOTE_FEED_AMAZON_REGEX, estadoVezFeedAmazonSchema } from './feedAmazon';
import { precoDoFilhoNaTabela, propagaPrecoAosFilhos } from './produto/pureLogic/precoCalculo';
import { docIdSchema, naoDocId } from './shared/outerRef';
import { ttlExpiry } from './shared/ttl';

/**
 * The Amazon price push (step 13): the ERP's price for one listing, the
 * numbers that bound a price run, and the documents and wire shapes of the
 * flow. Pure: no clock, no network, no Firestore.
 *
 * ## The faixa
 *
 * A listing's offer carries three prices: `our_price` (the selling price),
 * `minimum_seller_allowed_price` (the floor) and `maximum_seller_allowed_price`
 * (the ceiling). The ERP's triple is a FAIXA `{ base, minimo, maximo }`:
 *
 *  - `base` = the conta's NORMAL tabela price of the unit;
 *  - `minimo` = its PROMOTIONAL tabela price when there is one above zero,
 *    else `base`;
 *  - `maximo` = `base`.
 *
 * {@link faixaDePrecoAmazon} is the ONE function that maps the ERP's price
 * lists to that triple, so a new price-range model changes it alone. Each
 * tabela is read through `precoDoFilhoNaTabela` (`produto/pureLogic/precoCalculo.ts`),
 * which every channel's sender of a variation child's price binds: under the
 * parent's propagation the parent's map is the child's price, never the
 * child's own. Rounding is that reader's `roundReais` and nothing else.
 *
 * A promotional price ABOVE the normal one would make the floor exceed the
 * selling price, which Amazon refuses and may answer by suppressing the
 * listing: that faixa is `faixa-invertida`, refused here, never clamped.
 *
 * ## The conta's tabelas
 *
 * {@link tabelasDePrecoDaContaAmazon} is the ONE parse of the conta's two
 * tabela refs (`tabelaNormalOuterRef`, `tabelaPromocionalOuterRef`), read off
 * the conta document RAW: exactly `listaDePrecos/<id>` or
 * `documents/listaDePrecos/<id>`, with a document id; anything else names no
 * tabela. Another collection's ref never prices from an arbitrary map key.
 *
 * ## The price run: `precosAmazon/{contaId}`
 *
 * One operator-started run per conta at a time ({@link execucaoPrecoAmazonSchema}):
 * its pages walk the conta's link docs and write the SKUs that differ into
 * dense PARTS; its decision step (Decide) then sends nothing, per-SKU tasks
 * or block feed batches. The page holding the run is the one whose fresh read
 * names its `execucaoId` and `proximaPagina`.
 *
 * ## The parts: `precosAmazon/{contaId}/divergenciasPrecoAmazon/{execucaoId}-{n}`
 *
 * Numbered DENSELY: a page writes part `proximaParte` only when it found a
 * sendable SKU, so the parts of a run are `0…proximaParte−1` and
 * `itensPorParte` holds each one's size. Each member keeps the identities a
 * send re-reads (the link path, the unit) and what the page saw (the live
 * offer, the faixa, the listing's `productType`, the read instant): the faixa's
 * `base` is the lowest `our_price` anything the run sends may set for that
 * SKU. Read by id, never queried; `expiraEm` is the TTL stamp, REQUIRED.
 *
 * ## Units
 *
 * Every instant stored as a number is MILLISECONDS since epoch, a strict
 * non-negative safe integer. The two that are not numbers are the run's
 * `relogioInicio` (a Firestore `Timestamp`, the clock of the run's avisos) and
 * a part's `expiraEm` (the TTL stamp: a `Date` on write; a numeric epoch is
 * refused, because a TTL policy silently ignores one).
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS` and no Meta, so the rules generator emits
 * no match block and no client reads either document. Unknown keys are
 * STRIPPED. Bare schemas, never a `{ schema, meta }` export; the Admin handles
 * in `@delfrance/data/admin/collections` spell the paths.
 */

/** A non-negative SAFE integer: every stored count and ms stamp here. */
function inteiroSeguro() {
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
}

/** A run or batch id: the feed core's id grammar, so it can also name a feed send. */
function idExecucao() {
  return z.string().regex(ID_LOTE_FEED_AMAZON_REGEX);
}

/* -------------------------------------------------------------------------- */
/*                                 The numbers                                */
/* -------------------------------------------------------------------------- */

/**
 * THE SWITCH for price: a price push of up to this many sendable SKUs goes as
 * per-SKU tasks; more goes as block feed batches (a run), or is refused whole
 * (a manual selection). Defined AS the stock switch, so the two move together.
 * Amazon recommends a feed above about 1,500 items per 5 minutes; this switch
 * sits far below that on purpose (one rule for both flows).
 */
export const LIMIAR_FEED_PRECO_AMAZON = LIMIAR_FEED_ESTOQUE_AMAZON;

/**
 * The most DISTINCT produtos one manual price push may select: the stock
 * push's bound. A request above it is refused whole, never truncated.
 */
export const MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON = MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON;

/** The most SKUs one part holds: one walk page reads at most this many link docs. */
export const MAX_ITENS_DIVERGENCIA_PRECO_AMAZON = 300;

/**
 * The most parts one run may write (≈ 300,000 sendable SKUs). A page that
 * would write part number `MAX_PARTES_EXECUCAO_PRECO_AMAZON` writes nothing and
 * closes the run `truncada` (`partes-demais`).
 */
export const MAX_PARTES_EXECUCAO_PRECO_AMAZON = 1_000;

/**
 * The most block batches one run may name: the worst greedy pack of
 * {@link MAX_PARTES_EXECUCAO_PRECO_AMAZON} consecutive parts of at most
 * {@link MAX_ITENS_DIVERGENCIA_PRECO_AMAZON} items each, under a price batch's
 * message cap (9,000) and a block batch's part cap (50). A batch closed by the
 * message cap holds more than 9,000 − 300 items, so at least 30 parts: 33 full
 * batches and a last one cover the 1,000 parts. Both caps live in `apps/amazon`
 * (`feeds/tarefaLote.ts`), which this package cannot import, so the derivation
 * through the real caps belongs beside them, and a cap change there must
 * recompute this bound.
 */
export const MAX_LOTES_EXECUCAO_PRECO_AMAZON = 34;

/**
 * The mass-decrease stop's catalogue-scale count: a run started with consent to
 * lower prices whose sendable `our_price` decreases reach this many sends
 * NOTHING (unless the request confirms the mass decrease).
 */
export const LIMIAR_REDUCAO_EM_MASSA_PRECO_AMAZON = 1_500;

/**
 * The mass-decrease stop's share: decreases above {@link LIMIAR_FEED_PRECO_AMAZON}
 * that are also MORE than this fraction of the run's sendable SKUs stop it too.
 */
export const FRACAO_REDUCAO_EM_MASSA_PRECO_AMAZON = 0.5;

/**
 * The mass-decrease stop's per-SKU drop: one `our_price` falling by MORE than
 * this fraction of its live value stops the run (a decimal slip such as
 * 199.90 → 19.99). Falling by exactly half does not.
 */
export const QUEDA_MAXIMA_PRECO_AMAZON = 0.5;

/** The most decreases a run (or a page line) keeps as its `sku:antes>depois` sample. */
export const MAX_AMOSTRA_PRECO_AMAZON = 20;

/** Days a part lives after the page that wrote it (its `expiraEm`). */
export const RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS = 7;

/* -------------------------------------------------------------------------- */
/*                                  Grammars                                  */
/* -------------------------------------------------------------------------- */

/**
 * A listing's `productType` as a price message may carry it: an upper-case
 * token of at most 64 characters. A part stores the listing's live type, or
 * `PRODUCT` when the read carried none.
 */
export const TIPO_PRODUTO_PRECO_AMAZON_REGEX = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * One entry of a decrease sample: `<sku>:<our_price before>><our_price after>`,
 * each price a JavaScript number rendering. The SKU may itself hold `:` or `>`;
 * the two prices never do.
 */
export const AMOSTRA_REDUCAO_PRECO_AMAZON_REGEX = /^.+:[0-9][0-9.e+]*>[0-9][0-9.e+]*$/;

/** A batch's key in the run's `lotes` map: its index, in decimal, with no leading zero. */
export const CHAVE_LOTE_PRECO_AMAZON_REGEX = /^(?:0|[1-9][0-9]{0,2})$/;

/* -------------------------------------------------------------------------- */
/*                               The conta's tabelas                          */
/* -------------------------------------------------------------------------- */

const PREFIXO_TABELA_CANONICO = 'documents/listaDePrecos/';
const PREFIXO_TABELA_NU = 'listaDePrecos/';

/** A tabela id from one stored ref (module header), or `null`. */
function idTabelaDePreco(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  let id: string | null = null;
  if (ref.startsWith(PREFIXO_TABELA_CANONICO)) id = ref.slice(PREFIXO_TABELA_CANONICO.length);
  else if (ref.startsWith(PREFIXO_TABELA_NU)) id = ref.slice(PREFIXO_TABELA_NU.length);
  return id === null || naoDocId(id) ? null : id;
}

/** The conta's two tabela ids; `null` = the conta names no such tabela. */
export interface TabelasDePrecoAmazon {
  readonly normalId: string | null;
  readonly promocionalId: string | null;
}

/**
 * The conta's tabela ids, off the conta document read RAW (module header). Pure
 * and total: a value that is not an object names no tabela at all.
 */
export function tabelasDePrecoDaContaAmazon(contaRaw: unknown): TabelasDePrecoAmazon {
  if (contaRaw === null || typeof contaRaw !== 'object' || Array.isArray(contaRaw)) {
    return { normalId: null, promocionalId: null };
  }
  const conta = contaRaw as Readonly<Record<string, unknown>>;
  return {
    normalId: Object.hasOwn(conta, 'tabelaNormalOuterRef')
      ? idTabelaDePreco(conta.tabelaNormalOuterRef)
      : null,
    promocionalId: Object.hasOwn(conta, 'tabelaPromocionalOuterRef')
      ? idTabelaDePreco(conta.tabelaPromocionalOuterRef)
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  The faixa                                 */
/* -------------------------------------------------------------------------- */

/** A price the ERP sends: finite, above zero, with at most two decimals. */
function precoEnviavel() {
  return z.number().refine((v) => Number.isFinite(v) && v > 0 && roundReais(v) === v, {
    message: 'um preço enviado é finito, maior que zero e tem no máximo duas casas',
  });
}

/**
 * The ERP's three prices of one listing (module header), as a part stores the
 * faixa its page computed and a link doc's price outcome stores the faixa a
 * patch sent: each a price above zero with at most two decimals, and
 * `minimo ≤ base ≤ maximo` (to the centavo).
 */
export const faixaPrecoAmazonSchema = z
  .object({
    /** `our_price`. */
    base: precoEnviavel(),
    /** `minimum_seller_allowed_price`. */
    minimo: precoEnviavel(),
    /** `maximum_seller_allowed_price`. */
    maximo: precoEnviavel(),
  })
  .superRefine((faixa, ctx) => {
    if (centavosDeReais(faixa.minimo) > centavosDeReais(faixa.base)) {
      ctx.addIssue({ code: 'custom', path: ['minimo'], message: 'o mínimo passa do preço' });
    }
    if (centavosDeReais(faixa.base) > centavosDeReais(faixa.maximo)) {
      ctx.addIssue({ code: 'custom', path: ['maximo'], message: 'o máximo fica abaixo do preço' });
    }
  });
export type FaixaPrecoAmazon = z.infer<typeof faixaPrecoAmazonSchema>;

/**
 * What {@link faixaDePrecoAmazon} answers: a sendable `faixa`, or why there is
 * none — `sem-tabela-normal` (the conta names no normal tabela), `sem-preco`
 * (the unit has no normal price), `faixa-invertida` (the promotional price
 * exceeds the normal one).
 */
export const tipoFaixaPrecoAmazonSchema = z.enum([
  'faixa',
  'sem-tabela-normal',
  'sem-preco',
  'faixa-invertida',
]);
export type TipoFaixaPrecoAmazon = z.infer<typeof tipoFaixaPrecoAmazonSchema>;

/** Named members of {@link tipoFaixaPrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_FAIXA_PRECO_AMAZON = {
  faixa: 'faixa',
  semTabelaNormal: 'sem-tabela-normal',
  semPreco: 'sem-preco',
  faixaInvertida: 'faixa-invertida',
} as const satisfies Record<string, TipoFaixaPrecoAmazon>;

/** The unit's parent, as read (raw) when the unit has a `paiId`. */
export interface PaiPrecoAmazon {
  /** The parent's `precos` map; `undefined` when its document is gone. */
  readonly precos: unknown;
  /** The parent's `propagatePriceToChildren`; `undefined` when absent or gone. */
  readonly propagatePriceToChildren: unknown;
}

/** The price sources of the unit a listing sells. */
export interface FontesPrecoAmazon {
  /** The unit's own `precos` map, raw. */
  readonly precosDaUnidade: unknown;
  /**
   * The unit's parent when it has a `paiId` (a variation child, a member of a
   * family of one); `null` for any other unit (a plain produto, a kit root),
   * which is priced by its own map.
   */
  readonly pai: PaiPrecoAmazon | null;
}

/** A field the document holds itself; `undefined` for a non-object or an absent key. */
function campoProprio(documento: unknown, chave: string): unknown {
  if (documento === null || typeof documento !== 'object' || Array.isArray(documento)) {
    return undefined;
  }
  return Object.hasOwn(documento, chave)
    ? (documento as Readonly<Record<string, unknown>>)[chave]
    : undefined;
}

/**
 * The price sources of a unit, off what the link readers answer: the unit's
 * document read RAW, and its parent as `{ raw }` (`null` when the unit has no
 * `paiId`). A parent the readers could not read (`raw: null`: its document is
 * gone, or the `paiId` names no document) is a parent with NO prices, never
 * "no parent": under propagation it prices nothing (`sem-preco`), so the
 * unit's own map is never read in its place. A reader of a unit's price maps
 * the readers' answer through here, never by hand. Pure and total.
 */
export function fontesPrecoDaUnidadeAmazon(
  unidade: unknown,
  paiDaUnidade: { readonly raw: unknown } | null,
): FontesPrecoAmazon {
  return {
    precosDaUnidade: campoProprio(unidade, 'precos'),
    pai:
      paiDaUnidade === null
        ? null
        : {
            precos: campoProprio(paiDaUnidade.raw, 'precos'),
            propagatePriceToChildren: campoProprio(paiDaUnidade.raw, 'propagatePriceToChildren'),
          },
  };
}

/** The answer of {@link faixaDePrecoAmazon}. */
export type ResultadoFaixaPrecoAmazon =
  | {
      readonly tipo: typeof TIPO_FAIXA_PRECO_AMAZON.faixa;
      readonly faixa: FaixaPrecoAmazon;
    }
  | {
      readonly tipo:
        | typeof TIPO_FAIXA_PRECO_AMAZON.semTabelaNormal
        | typeof TIPO_FAIXA_PRECO_AMAZON.semPreco;
    }
  | {
      readonly tipo: typeof TIPO_FAIXA_PRECO_AMAZON.faixaInvertida;
      /** The normal price. */
      readonly base: number;
      /** The promotional price above it. */
      readonly minimo: number;
    };

/**
 * The ERP's faixa of one unit (module header). Each tabela goes through
 * `precoDoFilhoNaTabela` with the parent's map under the parent's propagation
 * (only a stored literal `false` turns it off), else the unit's own map;
 * `base` = normal, `minimo` = promotional ?? normal, `maximo` = normal. A
 * parent whose document is gone, under propagation, prices nothing
 * (`sem-preco`). Pure and total.
 */
export function faixaDePrecoAmazon(
  fontes: FontesPrecoAmazon,
  tabelas: TabelasDePrecoAmazon,
): ResultadoFaixaPrecoAmazon {
  if (tabelas.normalId === null) return { tipo: TIPO_FAIXA_PRECO_AMAZON.semTabelaNormal };
  const { pai } = fontes;
  const precos = {
    precosDoPai: pai === null ? undefined : pai.precos,
    propagaPreco: pai !== null && propagaPrecoAosFilhos(pai.propagatePriceToChildren),
    precosDoFilho: fontes.precosDaUnidade,
  };
  const base = precoDoFilhoNaTabela(precos, tabelas.normalId);
  if (base === null) return { tipo: TIPO_FAIXA_PRECO_AMAZON.semPreco };
  const minimo = precoDoFilhoNaTabela(precos, tabelas.promocionalId) ?? base;
  if (centavosDeReais(minimo) > centavosDeReais(base)) {
    return { tipo: TIPO_FAIXA_PRECO_AMAZON.faixaInvertida, base, minimo };
  }
  return { tipo: TIPO_FAIXA_PRECO_AMAZON.faixa, faixa: { base, minimo, maximo: base } };
}

/* -------------------------------------------------------------------------- */
/*                        Amazon's offer, as a page read it                   */
/* -------------------------------------------------------------------------- */

/**
 * How one live read saw the listing's BR/BRL/ALL offer: `lida` (read, with its
 * prices), `ausente` (the listing has no such offer), `ambigua` (more than one
 * element claims to be it), `ilegivel` (an offer may exist but could not be
 * read safely). Only `lida` carries prices.
 */
export const tipoOfertaPrecoAmazonSchema = z.enum(['lida', 'ausente', 'ambigua', 'ilegivel']);
export type TipoOfertaPrecoAmazon = z.infer<typeof tipoOfertaPrecoAmazonSchema>;

/** Named members of {@link tipoOfertaPrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_OFERTA_PRECO_AMAZON = {
  lida: 'lida',
  ausente: 'ausente',
  ambigua: 'ambigua',
  ilegivel: 'ilegivel',
} as const satisfies Record<string, TipoOfertaPrecoAmazon>;

/** A price as read from Amazon: finite and above zero (Amazon may hold more decimals). */
function precoLido() {
  return z.number().refine((v) => Number.isFinite(v) && v > 0, {
    message: 'um preço lido é finito e maior que zero',
  });
}

/**
 * Amazon's offer as a page read it: `lida` carries `base` (`our_price`) and the
 * floor and the ceiling, each `null` when absent or unreadable (an absent floor
 * never equals a sent one); every other `tipo` carries no price at all.
 */
export const ofertaPrecoAmazonSchema = z
  .object({
    tipo: tipoOfertaPrecoAmazonSchema,
    base: precoLido().nullable().default(null),
    minimo: precoLido().nullable().default(null),
    maximo: precoLido().nullable().default(null),
  })
  .superRefine((oferta, ctx) => {
    if (oferta.tipo === TIPO_OFERTA_PRECO_AMAZON.lida) {
      if (oferta.base === null) {
        ctx.addIssue({ code: 'custom', path: ['base'], message: 'uma oferta lida tem preço' });
      }
      return;
    }
    for (const campo of ['base', 'minimo', 'maximo'] as const) {
      if (oferta[campo] !== null) {
        ctx.addIssue({ code: 'custom', path: [campo], message: 'só uma oferta lida tem preços' });
      }
    }
  });
export type OfertaPrecoAmazon = z.infer<typeof ofertaPrecoAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                                  The parts                                 */
/* -------------------------------------------------------------------------- */

/** One sendable SKU of a walk page (module header, "The parts"). */
export const itemDivergenciaPrecoAmazonSchema = z.object({
  /**
   * The SKU as its link doc stores it: tolerant here, because a part write that
   * refused a SKU would stop the whole walk; the feed builder checks each SKU it
   * sends.
   */
  sku: z.string().min(1),
  /** The link doc's full path, `produtos/<id>/prodAmazon/<id>`: a send re-reads it. */
  vinculo: z.string().regex(CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX),
  /** The produto whose prices the SKU publishes. */
  unidadeId: docIdSchema,
  /** Amazon's offer as the page read it. */
  oferta: ofertaPrecoAmazonSchema,
  /** The faixa the page computed: its `base` is the run's floor for this SKU. */
  faixa: faixaPrecoAmazonSchema,
  /** The listing's live `productType` (or `PRODUCT` when the read carried none). */
  tipoProduto: z.string().regex(TIPO_PRODUTO_PRECO_AMAZON_REGEX),
  /** ms — when the page read the offer. */
  lidoEmMs: inteiroSeguro(),
});
export type ItemDivergenciaPrecoAmazon = z.infer<typeof itemDivergenciaPrecoAmazonSchema>;

/** `precosAmazon/{contaId}/divergenciasPrecoAmazon/{execucaoId}-{n}` (module header). */
export const divergenciaPrecoAmazonSchema = z.object({
  execucaoId: idExecucao(),
  /** At least one: a page with no sendable SKU writes no part. */
  itens: z.array(itemDivergenciaPrecoAmazonSchema).min(1).max(MAX_ITENS_DIVERGENCIA_PRECO_AMAZON),
  /**
   * TTL stamp, REQUIRED: a real `Date` on write — a numeric epoch is refused,
   * because a TTL policy silently ignores one.
   */
  expiraEm: ttlExpiry(),
});
export type DivergenciaPrecoAmazon = z.infer<typeof divergenciaPrecoAmazonSchema>;

/**
 * A part's doc id, `<execucaoId>-<n>`: the ONE spelling the page that writes
 * part `n` and every reader of it share. `n` is a part index, so the id splits
 * at its LAST `-`.
 *
 * @throws {RangeError} a run id outside its grammar, or a part index that is
 *   not a safe integer in `0…MAX_PARTES_EXECUCAO_PRECO_AMAZON−1` (the message
 *   names the rule, never the value).
 */
export function idDivergenciaPrecoAmazon(execucaoId: string, parte: number): string {
  if (!ID_LOTE_FEED_AMAZON_REGEX.test(execucaoId)) {
    throw new RangeError('precoAmazon.ts: execucaoId fora de ID_LOTE_FEED_AMAZON_REGEX');
  }
  if (!Number.isSafeInteger(parte) || parte < 0 || parte >= MAX_PARTES_EXECUCAO_PRECO_AMAZON) {
    throw new RangeError(
      'precoAmazon.ts: parte deve ser um inteiro entre 0 e MAX_PARTES_EXECUCAO_PRECO_AMAZON − 1',
    );
  }
  return `${execucaoId}-${String(parte)}`;
}

/* -------------------------------------------------------------------------- */
/*                                   The run                                  */
/* -------------------------------------------------------------------------- */

/**
 * The run's phase: `paginando` (walking pages) → `decidindo` → `concluida`; or
 * one other end: `cancelada` (the operator's cancel), `truncada` (the walk gave
 * up; a truncated run resolves no aviso) or `falhou`.
 */
export const faseExecucaoPrecoAmazonSchema = z.enum([
  'paginando',
  'decidindo',
  'concluida',
  'cancelada',
  'truncada',
  'falhou',
]);
export type FaseExecucaoPrecoAmazon = z.infer<typeof faseExecucaoPrecoAmazonSchema>;

/** Named members of {@link faseExecucaoPrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const FASE_EXECUCAO_PRECO_AMAZON = {
  paginando: 'paginando',
  decidindo: 'decidindo',
  concluida: 'concluida',
  cancelada: 'cancelada',
  truncada: 'truncada',
  falhou: 'falhou',
} as const satisfies Record<string, FaseExecucaoPrecoAmazon>;

/**
 * Why a run ended `truncada` — `partes-demais` (a page would have written part
 * {@link MAX_PARTES_EXECUCAO_PRECO_AMAZON}), `prazo` (a page ran past its
 * budget), `cursor-ilegivel` (the walk's cursor could not be read back) — or
 * `falhou` — `sem-tabela-normal` (the conta names no normal tabela),
 * `enfileiramento-falhou` (the first page could not be enqueued).
 */
export const motivoFimExecucaoPrecoAmazonSchema = z.enum([
  'partes-demais',
  'prazo',
  'cursor-ilegivel',
  'sem-tabela-normal',
  'enfileiramento-falhou',
]);
export type MotivoFimExecucaoPrecoAmazon = z.infer<typeof motivoFimExecucaoPrecoAmazonSchema>;

/** Named members of {@link motivoFimExecucaoPrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_FIM_EXECUCAO_PRECO_AMAZON = {
  partesDemais: 'partes-demais',
  prazo: 'prazo',
  cursorIlegivel: 'cursor-ilegivel',
  semTabelaNormal: 'sem-tabela-normal',
  enfileiramentoFalhou: 'enfileiramento-falhou',
} as const satisfies Record<string, MotivoFimExecucaoPrecoAmazon>;

/**
 * What Decide chose: `nada` (no sendable SKU), `tarefas` (per-SKU tasks),
 * `canario` (tasks for the canary list's SKUs only), `dry-run` (logged, nothing
 * sent), `lotes` (block feed batches), `reducao-em-massa` (the mass-decrease
 * stop: nothing sent).
 */
export const decisaoExecucaoPrecoAmazonSchema = z.enum([
  'nada',
  'tarefas',
  'canario',
  'dry-run',
  'lotes',
  'reducao-em-massa',
]);
export type DecisaoExecucaoPrecoAmazon = z.infer<typeof decisaoExecucaoPrecoAmazonSchema>;

/** Named members of {@link decisaoExecucaoPrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const DECISAO_EXECUCAO_PRECO_AMAZON = {
  nada: 'nada',
  tarefas: 'tarefas',
  canario: 'canario',
  dryRun: 'dry-run',
  lotes: 'lotes',
  reducaoEmMassa: 'reducao-em-massa',
} as const satisfies Record<string, DecisaoExecucaoPrecoAmazon>;

/**
 * How a batch ended, as the run records it: a submitted feed's end as its
 * recovery reads it (`concluido`, `falhou`, `cancelado`, `abandonado`,
 * `incerto`), or `sem-envio` — an end after the send's context that submitted
 * nothing, named by its `motivoSemEnvio`.
 */
export const desfechoLotePrecoAmazonSchema = z.enum([
  'concluido',
  'falhou',
  'cancelado',
  'abandonado',
  'incerto',
  'sem-envio',
]);
export type DesfechoLotePrecoAmazon = z.infer<typeof desfechoLotePrecoAmazonSchema>;

/** Named members of {@link desfechoLotePrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const DESFECHO_LOTE_PRECO_AMAZON = {
  concluido: 'concluido',
  falhou: 'falhou',
  cancelado: 'cancelado',
  abandonado: 'abandonado',
  incerto: 'incerto',
  semEnvio: 'sem-envio',
} as const satisfies Record<string, DesfechoLotePrecoAmazon>;

/**
 * Which send-side end submitted nothing: `simulado` (a dry-run), `sem-escrita`,
 * `so-patches` and `repassado` (handed to per-SKU tasks), `repasse-abortado`,
 * `abortado`, `documento-falhou` (the document could not be built),
 * `recusa-definitiva` (Amazon refused the submission for good), `lote-expirado`
 * (the batch waited past its deadline).
 */
export const motivoSemEnvioLotePrecoAmazonSchema = z.enum([
  'simulado',
  'sem-escrita',
  'so-patches',
  'repassado',
  'repasse-abortado',
  'abortado',
  'documento-falhou',
  'recusa-definitiva',
  'lote-expirado',
]);
export type MotivoSemEnvioLotePrecoAmazon = z.infer<typeof motivoSemEnvioLotePrecoAmazonSchema>;

/** Named members of {@link motivoSemEnvioLotePrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON = {
  simulado: 'simulado',
  semEscrita: 'sem-escrita',
  soPatches: 'so-patches',
  repassado: 'repassado',
  repasseAbortado: 'repasse-abortado',
  abortado: 'abortado',
  documentoFalhou: 'documento-falhou',
  recusaDefinitiva: 'recusa-definitiva',
  loteExpirado: 'lote-expirado',
} as const satisfies Record<string, MotivoSemEnvioLotePrecoAmazon>;

/**
 * One batch Decide named: its own send id, the consecutive parts it covers
 * (`parteInicial … parteInicial + partes − 1`), their item count, and its end
 * (`null` while none is recorded). A batch with `desfecho: null` whose run's
 * `esperaLotesAteMs` has passed ended before its send could record anything.
 */
export const lotePrecoAmazonSchema = z
  .object({
    /** The batch's send id (the feed core's id grammar). */
    execucaoIdLote: idExecucao(),
    parteInicial: z
      .number()
      .int()
      .min(0)
      .max(MAX_PARTES_EXECUCAO_PRECO_AMAZON - 1),
    partes: z.number().int().min(1).max(MAX_PARTES_EXECUCAO_PRECO_AMAZON),
    itens: inteiroSeguro().min(1),
    desfecho: desfechoLotePrecoAmazonSchema.nullable().default(null),
    motivoSemEnvio: motivoSemEnvioLotePrecoAmazonSchema.nullable().default(null),
  })
  .superRefine((lote, ctx) => {
    if (lote.parteInicial + lote.partes > MAX_PARTES_EXECUCAO_PRECO_AMAZON) {
      ctx.addIssue({ code: 'custom', path: ['partes'], message: 'o lote passa da última parte' });
    }
    const semEnvio = lote.desfecho === DESFECHO_LOTE_PRECO_AMAZON.semEnvio;
    if (semEnvio !== (lote.motivoSemEnvio !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['motivoSemEnvio'],
        message: 'só um lote sem envio tem motivoSemEnvio, e ele sempre tem',
      });
    }
  });
export type LotePrecoAmazon = z.infer<typeof lotePrecoAmazonSchema>;

/**
 * Every batch Decide named, keyed by its index: dense (`0…K−1`, all named at
 * once) and at most {@link MAX_LOTES_EXECUCAO_PRECO_AMAZON}.
 */
export const lotesExecucaoPrecoAmazonSchema = z
  .record(z.string().regex(CHAVE_LOTE_PRECO_AMAZON_REGEX), lotePrecoAmazonSchema)
  .superRefine((lotes, ctx) => {
    const total = Object.keys(lotes).length;
    if (total > MAX_LOTES_EXECUCAO_PRECO_AMAZON) {
      ctx.addIssue({ code: 'custom', path: [], message: 'lotes demais para uma execução' });
      return;
    }
    for (let k = 0; k < total; k += 1) {
      if (!Object.hasOwn(lotes, String(k))) {
        ctx.addIssue({ code: 'custom', path: [], message: 'os índices dos lotes são 0…K−1' });
        return;
      }
    }
  });
export type LotesExecucaoPrecoAmazon = z.infer<typeof lotesExecucaoPrecoAmazonSchema>;

/**
 * The run's counters, summed page by page: what Decide and the run's line read.
 * The named ones are per-SKU outcomes of the pages; `porChave` holds every
 * link verdict and listing gate refusal by its motivo.
 */
export const contagensExecucaoPrecoAmazonSchema = z.object({
  /** Link docs the walk read. */
  lidos: inteiroSeguro().default(0),
  /** SKUs whose live offer already equals their faixa. */
  iguais: inteiroSeguro().default(0),
  /** Sendable SKUs (written into a part). */
  enviaveis: inteiroSeguro().default(0),
  /** Sendable SKUs whose `our_price` goes up. */
  sobe: inteiroSeguro().default(0),
  /** Sendable SKUs whose `our_price` goes down. */
  desce: inteiroSeguro().default(0),
  /** Sendable decreases deeper than {@link QUEDA_MAXIMA_PRECO_AMAZON}. */
  quedaExcessiva: inteiroSeguro().default(0),
  /**
   * Sendable SKUs whose current `our_price` could not be read safely (an offer
   * `ilegivel` or `ambigua`, or absent on a BUYABLE listing), sent under the
   * run's consent: the mass-decrease stop counts each one as a possible
   * decrease.
   */
  direcaoDesconhecida: inteiroSeguro().default(0),
  /** Decreases held back: the run has no consent to lower prices. */
  reducaoSemConsentimento: inteiroSeguro().default(0),
  /** Offers that could not be read safely, held back without consent. */
  precoAtualIlegivel: inteiroSeguro().default(0),
  faixaInvertida: inteiroSeguro().default(0),
  /** Listings whose live `productType` is outside the grammar. */
  tipoProdutoIlegivel: inteiroSeguro().default(0),
  semPreco: inteiroSeguro().default(0),
  /** Sendable SKUs no per-SKU patch can carry (only a feed sends them). */
  semCaminho: inteiroSeguro().default(0),
  temPrecoComDesconto: inteiroSeguro().default(0),
  temOfertaB2B: inteiroSeguro().default(0),
  /** Offers whose own end date has passed (priced, still closed). */
  fechada: inteiroSeguro().default(0),
  /** SKUs skipped on a page: each is evaluated on the page of its smallest link-doc path. */
  jaVisto: inteiroSeguro().default(0),
  /** SKUs a search missed and no GET confirmed. */
  naoConfirmados: inteiroSeguro().default(0),
  /**
   * Listings carrying a BLOCKING price issue (an `ERROR`, or one a person must
   * confirm): the count the conta's price-refusal aviso is raised or resolved
   * from. A price `WARNING` alone is not counted.
   */
  problemasDePreco: inteiroSeguro().default(0),
  /** The lowest `x-amzn-RateLimit-Limit` the pages saw; `null` when none carried one. */
  limiteTaxa: z
    .number()
    .refine((v) => Number.isFinite(v) && v >= 0, { message: 'um limite é finito e não negativo' })
    .nullable()
    .default(null),
  /** Every refusal of the link verdict and the listing gate, keyed by its motivo. */
  porChave: z
    .record(z.string().regex(CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX), inteiroSeguro())
    .default(() => ({})),
});
export type ContagensExecucaoPrecoAmazon = z.infer<typeof contagensExecucaoPrecoAmazonSchema>;

/** The counters of a run that has walked nothing. A function: every parse gets its own object. */
function contagensZeradas(): ContagensExecucaoPrecoAmazon {
  return {
    lidos: 0,
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
    jaVisto: 0,
    naoConfirmados: 0,
    problemasDePreco: 0,
    limiteTaxa: null,
    porChave: {},
  };
}

/**
 * `precosAmazon/{contaId}` (module header). The claim writes `execucaoId`,
 * `fase`, `baixarPreco`, `solicitadaPor` and `iniciadaEmMs`; the rest default.
 * The walk is the stock reconcile's shared one, so its cursors and the run's
 * start clock are those fields' own schemas.
 */
export const execucaoPrecoAmazonSchema = z.object({
  /** The run: with `proximaPagina` and `fase`, what a page re-derives before it walks. */
  execucaoId: idExecucao(),
  fase: faseExecucaoPrecoAmazonSchema,
  /** Why a `truncada` or `falhou` run ended; `null` otherwise. */
  motivo: motivoFimExecucaoPrecoAmazonSchema.nullable().default(null),
  /** The request's consent to lower `our_price`. */
  baixarPreco: z.boolean(),
  /** The request lifts the mass-decrease stop for THIS run. */
  confirmarReducaoEmMassa: z.boolean().default(false),
  /** The uid of the operator who started the run. */
  solicitadaPor: docIdSchema,
  /** Where the walk stands, one cursor per conta ref form. */
  cursores: reconciliacaoEstoqueAmazonSchema.shape.cursores,
  /** The page the run walks next. */
  proximaPagina: inteiroSeguro().default(0),
  /** The part the next page with a sendable SKU writes: the parts are `0…proximaParte−1`. */
  proximaParte: z.number().int().min(0).max(MAX_PARTES_EXECUCAO_PRECO_AMAZON).default(0),
  /** Each part's item count, in part order. */
  itensPorParte: z
    .array(z.number().int().min(1).max(MAX_ITENS_DIVERGENCIA_PRECO_AMAZON))
    .max(MAX_PARTES_EXECUCAO_PRECO_AMAZON)
    .default(() => []),
  contagens: contagensExecucaoPrecoAmazonSchema.default(contagensZeradas),
  /** The largest sendable `our_price` decreases, `sku:antes>depois`. */
  amostraReducoes: z
    .array(z.string().max(200).regex(AMOSTRA_REDUCAO_PRECO_AMAZON_REGEX))
    .max(MAX_AMOSTRA_PRECO_AMAZON)
    .default(() => []),
  /** What Decide chose; `null` before it. */
  decisao: decisaoExecucaoPrecoAmazonSchema.nullable().default(null),
  /** The batches Decide named (only for `lotes`). */
  lotes: lotesExecucaoPrecoAmazonSchema.default(() => ({})),
  /** ms. */
  iniciadaEmMs: inteiroSeguro(),
  /** ms — advanced only by the dispatch holding the run; null before the first page. */
  progressoEmMs: inteiroSeguro().nullable().default(null),
  /** ms — the deadline every batch of the run waits to (Decide's clock + its wait); null before Decide. */
  esperaLotesAteMs: inteiroSeguro().nullable().default(null),
  /** The first page's `readTime`: the clock of every aviso the run raises or resolves. */
  relogioInicio: reconciliacaoEstoqueAmazonSchema.shape.relogioInicio,
});
export type ExecucaoPrecoAmazon = z.infer<typeof execucaoPrecoAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                               The price routes                             */
/* -------------------------------------------------------------------------- */

/**
 * The `code` of every error envelope the price routes answer with that is NOT
 * already in `CODIGO_ERRO_AMAZON` (the read-switch refusal reuses
 * `AMAZON_CHAMADAS_DESLIGADAS`). A fifth closed set, never a widening of
 * another: every value is unique across this set, `CODIGO_ERRO_AMAZON`,
 * `CODIGO_ERRO_NFE_AMAZON`, `CODIGO_ERRO_ETIQUETA_AMAZON` and
 * `CODIGO_ERRO_ESTOQUE_AMAZON`.
 */
export const CODIGO_ERRO_PRECO_AMAZON = {
  /** 400 — the body is not the route's strict shape. `issues` names field PATHS, never a value. */
  CORPO_INVALIDO: 'AMAZON_PRECO_CORPO_INVALIDO',
  /**
   * 400 — the manual selection is too big, said by `detalhes`: too many produtos
   * (`unidade: 'produtos'`), or more sendable listings than the switch
   * (`unidade: 'anuncios'`). All or nothing: nothing was enqueued.
   */
  SELECAO_EXCEDE_LIMITE: 'AMAZON_PRECO_SELECAO_EXCEDE_LIMITE',
  /** 404 — no conta with this id, it is not an Amazon conta, or it is inactive. */
  CONTA_NAO_ENCONTRADA: 'AMAZON_PRECO_CONTA_NAO_ENCONTRADA',
  /** 400 — the conta names no normal tabela the price push can read. */
  CONTA_SEM_TABELA_NORMAL: 'AMAZON_PRECO_CONTA_SEM_TABELA_NORMAL',
  /** 409 — a price run of the conta is still in progress (`execucaoId` names it). */
  EXECUCAO_EM_CURSO: 'AMAZON_PRECO_EXECUCAO_EM_CURSO',
  /** 404 — the conta has no price run. */
  EXECUCAO_NAO_ENCONTRADA: 'AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA',
  /** 503 — the work could not be enqueued (`motivo` says why when it is known). */
  ENFILEIRAMENTO_FALHOU: 'AMAZON_PRECO_ENFILEIRAMENTO_FALHOU',
} as const;
export type CodigoErroPrecoAmazon =
  (typeof CODIGO_ERRO_PRECO_AMAZON)[keyof typeof CODIGO_ERRO_PRECO_AMAZON];

/**
 * Every non-2xx JSON body of the price routes: the stock push's envelope (the
 * conta routes' plus the limit's `detalhes`), plus the run's `execucaoId` (a
 * 409) and a `motivo` slug (a 503). `code` stays a plain string, so a code a
 * newer backend adds still parses.
 */
export const erroPrecoAmazonSchema = erroEnvioEstoqueManualAmazonSchema.extend({
  execucaoId: idExecucao().nullable().optional(),
  motivo: z.string().nullable().optional(),
});
export type ErroPrecoAmazon = z.infer<typeof erroPrecoAmazonSchema>;

/**
 * What the manual price push answers on 200: the stock push's envelope, one
 * row per (family anchor, SKU of the conta). No price is ever in it: the price
 * is computed when the task sends, so a price here would be a guess.
 */
export const envioPrecoManualAmazonSchema = envioEstoqueManualAmazonSchema;
export type EnvioPrecoManualAmazon = z.infer<typeof envioPrecoManualAmazonSchema>;

/**
 * What `POST …/atualizar-precos` answers on 202: the conta's run now walking —
 * one this request claimed (`retomada: false`), or a live run that had
 * stalled, re-kicked under its SAME id (`retomada: true`).
 */
export const respostaInicioExecucaoPrecoAmazonSchema = z.object({
  execucaoId: idExecucao(),
  retomada: z.boolean(),
});
export type RespostaInicioExecucaoPrecoAmazon = z.infer<
  typeof respostaInicioExecucaoPrecoAmazonSchema
>;

/**
 * What `POST …/atualizar-precos/cancelar` answers on 200: the conta's run and
 * its phase after the request — `cancelada`, or the phase of an ended run with
 * nothing left in flight, answered unchanged.
 */
export const respostaCancelamentoExecucaoPrecoAmazonSchema = z.object({
  execucaoId: idExecucao(),
  fase: faseExecucaoPrecoAmazonSchema,
});
export type RespostaCancelamentoExecucaoPrecoAmazon = z.infer<
  typeof respostaCancelamentoExecucaoPrecoAmazonSchema
>;

/**
 * How the status route shows one batch: its recorded end (a
 * {@link desfechoLotePrecoAmazonSchema} member), `pendente` (none recorded and
 * the run's `esperaLotesAteMs` not passed) or `sem-desfecho` (none recorded
 * once it passed: the batch ended before its send could record one).
 */
export const estadoLoteResumoPrecoAmazonSchema = z.enum([
  'concluido',
  'falhou',
  'cancelado',
  'abandonado',
  'incerto',
  'sem-envio',
  'pendente',
  'sem-desfecho',
]);
export type EstadoLoteResumoPrecoAmazon = z.infer<typeof estadoLoteResumoPrecoAmazonSchema>;

/** Named members of {@link estadoLoteResumoPrecoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const ESTADO_LOTE_RESUMO_PRECO_AMAZON = {
  concluido: 'concluido',
  falhou: 'falhou',
  cancelado: 'cancelado',
  abandonado: 'abandonado',
  incerto: 'incerto',
  semEnvio: 'sem-envio',
  pendente: 'pendente',
  semDesfecho: 'sem-desfecho',
} as const satisfies Record<string, EstadoLoteResumoPrecoAmazon>;

/**
 * What `GET …/atualizar-precos/status` answers on 200: the conta's run as its
 * document holds it, plus what the route derives when it reads it — `parada`
 * (a live run without progress for 15 minutes: the next click re-kicks it),
 * each batch's state, and the conta's price feed in flight (`null` when the
 * price lease is free). No price beyond the run's own decrease sample.
 */
export const resumoExecucaoPrecoAmazonSchema = z.object({
  execucaoId: idExecucao(),
  fase: faseExecucaoPrecoAmazonSchema,
  motivo: motivoFimExecucaoPrecoAmazonSchema.nullable(),
  baixarPreco: z.boolean(),
  confirmarReducaoEmMassa: z.boolean(),
  decisao: decisaoExecucaoPrecoAmazonSchema.nullable(),
  contagens: contagensExecucaoPrecoAmazonSchema,
  amostraReducoes: execucaoPrecoAmazonSchema.shape.amostraReducoes,
  /** ms. */
  iniciadaEmMs: inteiroSeguro(),
  /** ms. */
  progressoEmMs: inteiroSeguro().nullable(),
  /** ms. */
  esperaLotesAteMs: inteiroSeguro().nullable(),
  parada: z.boolean(),
  /** Every batch Decide named, in index order. */
  lotes: z
    .array(
      z.object({
        indice: z
          .number()
          .int()
          .min(0)
          .max(MAX_LOTES_EXECUCAO_PRECO_AMAZON - 1),
        execucaoIdLote: idExecucao(),
        parteInicial: lotePrecoAmazonSchema.shape.parteInicial,
        partes: lotePrecoAmazonSchema.shape.partes,
        itens: lotePrecoAmazonSchema.shape.itens,
        estado: estadoLoteResumoPrecoAmazonSchema,
        motivoSemEnvio: motivoSemEnvioLotePrecoAmazonSchema.nullable(),
      }),
    )
    .max(MAX_LOTES_EXECUCAO_PRECO_AMAZON),
  /** The price lease while a price feed of the conta is in flight; `null` when it is free. */
  feedEmCurso: z
    .object({
      estado: estadoVezFeedAmazonSchema.exclude(['livre']),
      /** ms since the lease's holder last wrote it. */
      idadeMs: inteiroSeguro(),
    })
    .nullable(),
});
export type ResumoExecucaoPrecoAmazon = z.infer<typeof resumoExecucaoPrecoAmazonSchema>;
