/**
 * The Firestore half of the listings flows' link verdict (step 13, PR 13-b):
 * for ONE SKU of one conta, every document `avaliarVinculoListingAmazon`
 * (`vinculoListing.ts`) reads, each read MASKED to a flow's fields
 * ({@link CamposVinculoListingAmazon}). ONE reader for every flow; the stock
 * flow binds it in `estoque/resolverEstoque.ts`. This module only READS: what
 * the documents mean is the verdict's (and, for price, the faixa's).
 *
 * ## The binding is the order import's, read through its own pieces
 *
 * A SKU sends the value of the unit an order line of that SKU consumes, so the
 * resolution is the order import's own (`pedidos/vinculoProdutoAmazon.ts`):
 * THE link-doc query and its ambiguity detector (`lerVinculosDoSkuAmazon`), the
 * by-id dono read with its gone-dono rule (`lerDonosAmazon`), the hop
 * (`unidadeDoDonoAmazon`) and the dono count (`resolucaoPorUnidadesAmazon`).
 * Only the MASKS are this module's: the order import reads the same documents
 * whole.
 *
 * ## The reads, in order
 *
 *  1. THE link-doc query, projected (a classic `select`) to the flow's
 *     `vinculo` fields ({@link CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON}): a link
 *     doc carries a whole product payload, and Enterprise bills the data a read
 *     returns. It rides the declared collection-group index `prodAmazon
 *     (contaAmazonOuterRef ASC, sku ASC)`. The limit reached ⇒ ambiguous, and
 *     nothing more is read.
 *  2. The distinct donos, by id in ONE `getAll` masked to the hop's fields and
 *     the flow's `dono` fields; a gone dono is dropped, then the live ones are
 *     counted. No live dono, or two, ⇒ nothing more is read.
 *  3. For the ONE live `dono` and the unit it hops to, in parallel:
 *     - the unit's produto by id, masked to the flow's `unidade` fields —
 *       UNLESS the unit is the `dono` itself and every one of those fields is
 *       a top-level name the dono's read already carried: then the dono's read
 *       is projected to them, and no second read is made. A field nested in a
 *       map (price's `precos.<tabela>`) is never in the dono's read, so its unit
 *       is always read on its own;
 *       - then, ONLY for a flow whose masks name the unit's parent (price),
 *         the parent the unit's `paiId` names, by id, masked to the flow's
 *         `paiDaUnidade` fields ({@link PaiDaUnidadeListingAmazon});
 *     - the unit's children ({@link lerFilhosDaUnidadeListingAmazon}): keys
 *       only, at most `LIMITE_FILHOS_UNIDADE_LISTING_AMAZON`, on the declared
 *       `produtos (paiId ASC, nome ASC)` composite;
 *     - the parent pointers of the `dono`'s link docs that PARSE, deduplicated
 *       by their bare path (both stored forms are one), in ONE `getAll` masked
 *       to `CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON`, through the link handle
 *       ({@link lerPaisDosLinksListingAmazon}); none ⇒ no read. An unreadable
 *       pointer is not read at all: the verdict refuses it as given.
 *
 * ## The masks of each flow
 *
 * {@link camposDoResolverListingAmazon}: the link fields are the index's two
 * and the verdict's (its flow's outcome field among them, never the other
 * flow's); the dono's are the verdict's (stock's opt-out map; none for price);
 * the unit's are refusal 4's, and price adds, per tabela, the ONE entry
 * `precos.<tabela>` (a two-segment path: a tabela id is never parsed as a
 * dotted path); the unit's parent (price only) is read masked to the same
 * entries and `propagatePriceToChildren`. A tabela id must be a document id.
 *
 * ## What it answers
 *
 * The verdict's input, `EntradaVinculoListingAmazon`, and the unit's parent
 * (`null` for a flow that reads none, or a unit that names none). When the
 * resolution names no unit (the limit, no live dono, two), the `dono` is
 * `null` and the rest is empty: the verdict refuses at its first check.
 *
 * Reads only: no write, no clock, no network.
 */
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { produtoAmazonLinkCollection, produtoCollection } from '@delfrance/data/admin/collections';
import { CAMPOS_INDICE_VINCULO_AMAZON, naoDocId, type produtoSchema } from '@delfrance/schemas';

import {
  type DonoLidoAmazon,
  RESOLUCAO_LIMITE_VINCULOS_AMAZON,
  donosDosVinculosAmazon,
  lerDonosAmazon,
  lerVinculosDoSkuAmazon,
  mascaraDosDonosAmazon,
  resolucaoPorUnidadesAmazon,
} from '../pedidos/vinculoProdutoAmazon';
import { FLUXO_LISTING_AMAZON, type FluxoListingAmazon } from './fluxoListing';
import {
  type AlvoDoPaiListingAmazon,
  CAMPOS_DONO_LISTING_AMAZON,
  CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON,
  CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON,
  CAMPOS_VINCULO_LISTING_AMAZON,
  type EntradaVinculoListingAmazon,
  LIMITE_FILHOS_UNIDADE_LISTING_AMAZON,
  type LinkDoSkuListingAmazon,
  type UnidadeDoVinculoListingAmazon,
  ponteiroPaiDoVinculoListingAmazon,
} from './vinculoListing';

/* -------------------------------- the masks -------------------------------- */

/**
 * A field a masked read asks for: a top-level name, or ONE entry of a
 * top-level map (`{ mapa, chave }`, read as the two-segment path
 * `mapa.chave`, whatever characters the key holds).
 */
export type CampoListingAmazon = string | { readonly mapa: string; readonly chave: string };

/**
 * The masks one flow reads a SKU's documents with (module header). They name
 * their flow, so a reader handed one flow's masks and another flow's verdict
 * binding refuses before any read (a verdict judging fields its masks never
 * fetched would read them as absent).
 */
export interface CamposVinculoListingAmazon {
  /** The flow these masks are for. */
  readonly fluxo: FluxoListingAmazon;
  /** The link-doc projection: the index's two fields, then the verdict's. */
  readonly vinculo: readonly string[];
  /** The donos' fields besides the hop's own (which are always read). */
  readonly dono: readonly string[];
  /** The unit's mask: refusal 4's fields, then the flow's own. */
  readonly unidade: readonly CampoListingAmazon[];
  /** The mask of the parent the unit's `paiId` names; `null` = the flow reads no parent. */
  readonly paiDaUnidade: readonly CampoListingAmazon[] | null;
}

/** The link-doc projection of each flow (module header, read 1). */
export const CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON = {
  [FLUXO_LISTING_AMAZON.estoque]: [
    ...CAMPOS_INDICE_VINCULO_AMAZON,
    ...CAMPOS_VINCULO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.estoque],
  ],
  [FLUXO_LISTING_AMAZON.preco]: [
    ...CAMPOS_INDICE_VINCULO_AMAZON,
    ...CAMPOS_VINCULO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.preco],
  ],
} as const satisfies Record<FluxoListingAmazon, readonly string[]>;

/** The produto map holding the price lists' entries, one per tabela id. */
export const MAPA_PRECOS_LISTING_AMAZON =
  'precos' as const satisfies keyof typeof produtoSchema.shape;

/** The parent's flag that says whether its price lists reach its children. */
export const CAMPO_PROPAGACAO_PRECO_LISTING_AMAZON =
  'propagatePriceToChildren' as const satisfies keyof typeof produtoSchema.shape;

/** What a flow's masks depend on: nothing for stock; the conta's tabela ids for price. */
export type FluxoDoResolverListingAmazon =
  | { readonly fluxo: typeof FLUXO_LISTING_AMAZON.estoque }
  | { readonly fluxo: typeof FLUXO_LISTING_AMAZON.preco; readonly tabelaIds: readonly string[] };

/**
 * A flow's masks (module header, "The masks of each flow"). Price's tabela ids
 * are read in the order given, each once.
 *
 * @throws {RangeError} a tabela id that is not a document id (nothing read).
 */
export function camposDoResolverListingAmazon(
  entrada: FluxoDoResolverListingAmazon,
): CamposVinculoListingAmazon {
  if (entrada.fluxo === FLUXO_LISTING_AMAZON.estoque) {
    return {
      fluxo: FLUXO_LISTING_AMAZON.estoque,
      vinculo: CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON[FLUXO_LISTING_AMAZON.estoque],
      dono: CAMPOS_DONO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.estoque],
      unidade: CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON,
      paiDaUnidade: null,
    };
  }
  const entradas: CampoListingAmazon[] = [];
  for (const tabelaId of new Set(entrada.tabelaIds)) {
    if (naoDocId(tabelaId)) {
      throw new RangeError('resolverVinculo.ts: um id de tabela não é um id de documento');
    }
    entradas.push({ mapa: MAPA_PRECOS_LISTING_AMAZON, chave: tabelaId });
  }
  return {
    fluxo: FLUXO_LISTING_AMAZON.preco,
    vinculo: CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON[FLUXO_LISTING_AMAZON.preco],
    dono: CAMPOS_DONO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.preco],
    unidade: [...CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON, ...entradas],
    paiDaUnidade: [...entradas, CAMPO_PROPAGACAO_PRECO_LISTING_AMAZON],
  };
}

/** A mask as the Admin SDK reads it: a nested entry becomes its two-segment path. */
export function mascaraFirestoreListingAmazon(
  campos: readonly CampoListingAmazon[],
): (string | FieldPath)[] {
  return campos.map((c) => (typeof c === 'string' ? c : new FieldPath(c.mapa, c.chave)));
}

/** Whether every field of `campos` is a top-level name in `lidos`: then a read of `lidos` holds them all. */
export function camposContidosListingAmazon(
  campos: readonly CampoListingAmazon[],
  lidos: readonly string[],
): boolean {
  return campos.every((c) => typeof c === 'string' && lidos.includes(c));
}

function ehObjeto(valor: unknown): valor is Readonly<Record<string, unknown>> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * `raw` holding only the fields of `campos` it has: a top-level name when
 * present, a map entry when the map is an object holding that key.
 */
export function projetarCamposListingAmazon(
  raw: Readonly<Record<string, unknown>>,
  campos: readonly CampoListingAmazon[],
): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const campo of campos) {
    if (typeof campo === 'string') {
      if (Object.hasOwn(raw, campo)) saida[campo] = raw[campo];
      continue;
    }
    const mapa = raw[campo.mapa];
    if (!Object.hasOwn(raw, campo.mapa) || !ehObjeto(mapa) || !Object.hasOwn(mapa, campo.chave)) {
      continue;
    }
    const destino = saida[campo.mapa];
    saida[campo.mapa] = {
      ...(ehObjeto(destino) ? destino : {}),
      [campo.chave]: mapa[campo.chave],
    };
  }
  return saida;
}

/**
 * The children seek's fields, in the declared composite's order: the equality
 * on the parent, then the order the index is sorted by.
 */
export const CAMPOS_INDICE_FILHOS_UNIDADE_LISTING_AMAZON = [
  'paiId',
  'nome',
] as const satisfies ReadonlyArray<keyof typeof produtoSchema.shape>;

/* -------------------------------- the shapes -------------------------------- */

/** The parent a unit's `paiId` names, as read for a flow that reads one. */
export interface PaiDaUnidadeListingAmazon {
  /** The parent's id as the unit names it; `null` when `paiId` is not a document id (nothing read). */
  readonly id: string | null;
  /** Its masked document; `null` when it could not be read or does not exist. */
  readonly raw: Readonly<Record<string, unknown>> | null;
}

/** What the resolver answers (module header, "What it answers"). */
export interface LeituraVinculoListingAmazon {
  readonly entrada: EntradaVinculoListingAmazon;
  /** `null` for a flow that reads no parent, or a unit whose `paiId` is `null` or absent. */
  readonly paiDaUnidade: PaiDaUnidadeListingAmazon | null;
}

/** A unit no read named: no fields, no children. */
const SEM_UNIDADE: UnidadeDoVinculoListingAmazon = { raw: {}, filhosIds: [] };

/* -------------------------------- the reads -------------------------------- */

/**
 * The ids of the unit's children (module header, read 3): `produtos where
 * paiId == <unidadeId> orderBy nome limit LIMITE_FILHOS_UNIDADE_LISTING_AMAZON`,
 * the keys alone (`select()`), on the declared `produtos (paiId ASC, nome ASC)`
 * composite. Two tell none, one and more apart, which is all refusal 4 asks.
 *
 * ⚠️ The order the index serves also filters: a child stored WITHOUT `nome` is
 * not returned. The produto schema requires `nome` on every document, so such
 * a child exists only outside the schema; it would leave its parent apt.
 */
export async function lerFilhosDaUnidadeListingAmazon(
  db: Firestore,
  unidadeId: string,
): Promise<string[]> {
  const [campoPai, campoOrdem] = CAMPOS_INDICE_FILHOS_UNIDADE_LISTING_AMAZON;
  const snap = await produtoCollection
    .ref(db, {})
    .where(campoPai, '==', unidadeId)
    .orderBy(campoOrdem)
    .limit(LIMITE_FILHOS_UNIDADE_LISTING_AMAZON)
    .select()
    .get();
  return snap.docs.map((d) => d.id);
}

/**
 * What each READABLE parent pointer of `links` names (module header, read 3),
 * keyed by its bare path: the target's `sku` and `asin`, or `'sumido'` when the
 * document does not exist. The pointers are deduplicated (two links, or both
 * stored forms of one pointer, are ONE read) and read in ONE `getAll` masked to
 * `CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON`; an absent or unreadable pointer is
 * not read. No readable pointer ⇒ no read.
 */
export async function lerPaisDosLinksListingAmazon(
  db: Firestore,
  links: readonly LinkDoSkuListingAmazon[],
): Promise<Map<string, AlvoDoPaiListingAmazon>> {
  const porCaminho = new Map<string, { readonly produtoId: string; readonly linkId: string }>();
  for (const link of links) {
    const ponteiro = ponteiroPaiDoVinculoListingAmazon(link.dados.produtoAmazonPaiOuterRef);
    if (ponteiro.tipo === 'caminho') porCaminho.set(ponteiro.caminho, ponteiro);
  }
  if (porCaminho.size === 0) return new Map();
  const alvos = [...porCaminho.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const snaps = await db.getAll(
    ...alvos.map(([, { produtoId, linkId }]) =>
      produtoAmazonLinkCollection.docRef(db, { produtoId }, linkId),
    ),
    { fieldMask: [...CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON] },
  );
  return new Map(
    alvos.map(([caminho], i): [string, AlvoDoPaiListingAmazon] => {
      const snap = snaps[i];
      if (snap?.exists !== true) return [caminho, 'sumido'];
      const raw = (snap.data() ?? {}) as Record<string, unknown>;
      return [caminho, { sku: raw.sku, asin: raw.asin }];
    }),
  );
}

/**
 * Whether a unit's document names a parent, and which: `paiId` `null` or
 * absent names none; any other value names one, read only when it is a
 * document id (else `id: null`, a parent that cannot be read).
 */
export function paiIdDaUnidadeListingAmazon(
  unidade: Readonly<Record<string, unknown>>,
): { readonly nomeia: false } | { readonly nomeia: true; readonly id: string | null } {
  const paiId = unidade.paiId;
  if (paiId === null || paiId === undefined) return { nomeia: false };
  return { nomeia: true, id: typeof paiId === 'string' && !naoDocId(paiId) ? paiId : null };
}

/**
 * The parent a unit's document names (module header, read 3), for a flow
 * whose masks name one: `null` when it names none; a `paiId` that is not a
 * document id is NOT read (`id: null`, `raw: null`); otherwise ONE by-id read
 * masked to `mascara` (`raw: null` when the document does not exist).
 */
async function lerPaiDaUnidade(
  db: Firestore,
  unidade: Readonly<Record<string, unknown>>,
  mascara: readonly CampoListingAmazon[],
): Promise<PaiDaUnidadeListingAmazon | null> {
  const pai = paiIdDaUnidadeListingAmazon(unidade);
  if (!pai.nomeia) return null;
  if (pai.id === null) return { id: null, raw: null };
  const [snap] = await db.getAll(produtoCollection.docRef(db, {}, pai.id), {
    fieldMask: mascaraFirestoreListingAmazon(mascara),
  });
  return {
    id: pai.id,
    raw: snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
  };
}

/**
 * The unit's document for refusal 4 and the flow (module header, read 3): the
 * `dono`'s own masked read projected when the unit IS the `dono` and that read
 * holds every field asked, else one masked read of the unit (a missing unit
 * reads as no fields).
 */
async function lerUnidade(
  db: Firestore,
  dono: DonoLidoAmazon,
  campos: CamposVinculoListingAmazon,
): Promise<Readonly<Record<string, unknown>>> {
  if (
    dono.unidadeId === dono.id &&
    camposContidosListingAmazon(campos.unidade, mascaraDosDonosAmazon(campos.dono))
  ) {
    return projetarCamposListingAmazon(dono.raw, campos.unidade);
  }
  const [snap] = await db.getAll(produtoCollection.docRef(db, {}, dono.unidadeId), {
    fieldMask: mascaraFirestoreListingAmazon(campos.unidade),
  });
  return snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : {};
}

/**
 * Every document the link verdict reads for `sku` of `contaId`, masked to the
 * flow's `campos` (module header), and the unit's parent when the flow reads
 * one.
 */
export async function lerVinculoListingAmazon(
  db: Firestore,
  contaId: string,
  sku: string,
  campos: CamposVinculoListingAmazon,
): Promise<LeituraVinculoListingAmazon> {
  const semDono = (
    resolucao: EntradaVinculoListingAmazon['resolucao'],
    linksDoSku: readonly LinkDoSkuListingAmazon[],
  ): LeituraVinculoListingAmazon => ({
    entrada: {
      contaId,
      sku,
      resolucao,
      dono: null,
      linksDoSku,
      paisDosLinks: new Map(),
      unidade: SEM_UNIDADE,
    },
    paiDaUnidade: null,
  });

  // 1. THE query, projected.
  const leitura = await lerVinculosDoSkuAmazon(db, contaId, sku, { campos: campos.vinculo });
  if (leitura.tipo === 'limite') return semDono(RESOLUCAO_LIMITE_VINCULOS_AMAZON, []);

  // 2. The donos, masked; gone dropped, then counted.
  const vivos = (
    await lerDonosAmazon(db, donosDosVinculosAmazon(leitura.docs), { campos: campos.dono })
  ).filter((d): d is DonoLidoAmazon => d !== null);
  const resolucao = resolucaoPorUnidadesAmazon(vivos.map((d) => d.unidadeId));
  const [dono] = vivos;
  if (resolucao.produtoId === null || dono === undefined) {
    return semDono(resolucao, leitura.docs);
  }

  // 3. The unit (then, for a flow that reads it, its parent), its children and
  // the `dono`'s parent pointers, in parallel.
  const mascaraDoPai = campos.paiDaUnidade;
  const [unidade, filhosIds, paisDosLinks] = await Promise.all([
    lerUnidade(db, dono, campos).then(async (raw) => ({
      raw,
      pai: mascaraDoPai === null ? null : await lerPaiDaUnidade(db, raw, mascaraDoPai),
    })),
    lerFilhosDaUnidadeListingAmazon(db, dono.unidadeId),
    lerPaisDosLinksListingAmazon(
      db,
      leitura.docs.filter((d) => d.donoId === dono.id),
    ),
  ]);
  return {
    entrada: {
      contaId,
      sku,
      resolucao,
      dono: { id: dono.id, raw: dono.raw },
      linksDoSku: leitura.docs,
      paisDosLinks,
      unidade: { raw: unidade.raw, filhosIds },
    },
    paiDaUnidade: unidade.pai,
  };
}
