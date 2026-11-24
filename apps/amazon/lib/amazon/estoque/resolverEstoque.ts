/**
 * The Firestore half of the Amazon stock sync's link verdict (step 12, PR
 * 12-e1): for ONE SKU of one conta, every document `avaliarVinculoEstoqueAmazon`
 * (`vinculoEstoque.ts`) reads, each read MASKED to the fields that are read off
 * it. This module only READS: what the documents mean is the verdict's.
 *
 * ## A binding of the shared reader (step 13, PR 13-b)
 *
 * The reads are `listings/resolverVinculo.ts`'s, ONE reader for every listings
 * flow (its header holds them, in order: the order import's own query, dono
 * read, hop and count, then the unit, its children and the parent pointers);
 * this module binds it to the stock flow's masks
 * ({@link CAMPOS_RESOLVER_ESTOQUE_AMAZON}: the link projection
 * {@link CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON}, the donos' mask
 * {@link CAMPOS_LEITURA_DONOS_ESTOQUE_AMAZON}, refusal 4's unit fields, no
 * parent read) and keeps the stock names: {@link lerFilhosDaUnidadeEstoqueAmazon}
 * and {@link lerPaisDosLinksEstoqueAmazon} are its two reads on their own.
 * Every field list is a constant the verdict's own lists derive, so a field the
 * verdict starts reading is a field these reads carry.
 *
 * ## What it answers
 *
 * Exactly the verdict's input, `EntradaVinculoEstoqueAmazon`. When the
 * resolution names no unit (the limit, no live dono, two), the `dono` is
 * `null` and the rest is empty: the verdict refuses at its first check.
 *
 * Reads only: no write, no clock, no network.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import {
  CAMPOS_INDICE_FILHOS_UNIDADE_LISTING_AMAZON,
  CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON,
  type CamposVinculoListingAmazon,
  camposDoResolverListingAmazon,
  lerFilhosDaUnidadeListingAmazon,
  lerPaisDosLinksListingAmazon,
  lerVinculoListingAmazon,
} from '../listings/resolverVinculo';
import { mascaraDosDonosAmazon } from '../pedidos/vinculoProdutoAmazon';
import {
  type AlvoDoPaiEstoqueAmazon,
  CAMPOS_DONO_ESTOQUE_AMAZON,
  type EntradaVinculoEstoqueAmazon,
  type LinkDoSkuEstoqueAmazon,
} from './vinculoEstoque';

/**
 * The fields the link-doc query projects (the shared reader's read 1): the index's
 * two (the conta ref and the SKU) and everything the verdict reads off a link.
 */
export const CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON =
  CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON[FLUXO_LISTING_AMAZON.estoque];

/**
 * The mask of the donos' read (the shared reader's read 2): the hop's own fields
 * (`ehKit`, `paiId`, `filhoUnicoId`), then everything the verdict reads off the
 * `dono`.
 */
export const CAMPOS_LEITURA_DONOS_ESTOQUE_AMAZON: readonly string[] = mascaraDosDonosAmazon(
  CAMPOS_DONO_ESTOQUE_AMAZON,
);

/**
 * The children seek's fields, in the declared composite's order: the equality
 * on the parent, then the order the index is sorted by.
 */
export const CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON =
  CAMPOS_INDICE_FILHOS_UNIDADE_LISTING_AMAZON;

/**
 * The stock flow's masks of the shared reader (module header): the link fields
 * above, the verdict's dono and unit fields, and no parent read.
 */
export const CAMPOS_RESOLVER_ESTOQUE_AMAZON: CamposVinculoListingAmazon =
  camposDoResolverListingAmazon({ fluxo: FLUXO_LISTING_AMAZON.estoque });

/**
 * The ids of the unit's children: the shared reader's children seek on its own
 * (`lerFilhosDaUnidadeListingAmazon`), under the stock name.
 */
export function lerFilhosDaUnidadeEstoqueAmazon(
  db: Firestore,
  unidadeId: string,
): Promise<string[]> {
  return lerFilhosDaUnidadeListingAmazon(db, unidadeId);
}

/**
 * What each READABLE parent pointer of `links` names, keyed by its bare path:
 * the shared reader's pointer read on its own (`lerPaisDosLinksListingAmazon`),
 * under the stock name.
 */
export function lerPaisDosLinksEstoqueAmazon(
  db: Firestore,
  links: readonly LinkDoSkuEstoqueAmazon[],
): Promise<Map<string, AlvoDoPaiEstoqueAmazon>> {
  return lerPaisDosLinksListingAmazon(db, links);
}

/**
 * Every document the link verdict reads for `sku` of `contaId`, masked (module
 * header): exactly `avaliarVinculoEstoqueAmazon`'s input.
 */
export async function lerVinculoEstoqueAmazon(
  db: Firestore,
  contaId: string,
  sku: string,
): Promise<EntradaVinculoEstoqueAmazon> {
  return (await lerVinculoListingAmazon(db, contaId, sku, CAMPOS_RESOLVER_ESTOQUE_AMAZON)).entrada;
}
