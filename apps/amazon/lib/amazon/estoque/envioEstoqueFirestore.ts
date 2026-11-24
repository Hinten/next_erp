/**
 * The stock OUTCOME write-back of the Amazon stock sync (step 12, PR 12-e1):
 * one outcome (`envioEstoqueAmazon`, built by `envioEstoque.ts`) written onto
 * every link doc of ONE SKU, under rule 7's tier 2 through a tier-1
 * precondition.
 *
 * Since step 13 (PR 13-b) this module is the STOCK BINDING of the listings
 * flows' shared write-back (`listings/envioListingFirestore.ts`, whose header
 * holds the attempt, the bounded re-read-and-re-decide, the ONE warning, the
 * unit guard and the clock it answers): the stock flow, so the field
 * {@link CAMPO_ENVIO_ESTOQUE_AMAZON} alone, parsed by `envioEstoqueAmazonSchema`.
 * Its names and signatures are the ones the stock callers have always used.
 *
 * Writes only the outcome field, and only on link docs.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type EnvioEstoqueAmazon,
  envioEstoqueAmazonSchema,
  type produtoAmazonLinkSchema,
} from '@delfrance/schemas';

import type { LoggerAmazon } from '../core/log';
import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import {
  type CampoEnvioListingAmazon,
  type EntradaGravacaoEnvioListingAmazon,
  type LinkDoEnvioListingAmazon,
  MAX_TENTATIVAS_ENVIO_LISTING_AMAZON,
  MOTIVO_GRAVACAO_ENVIO_LISTING_EM_CONFLITO,
  type ResultadoGravacaoEnvioListingAmazon,
  gravarEnvioListingAmazon,
} from '../listings/envioListingFirestore';
import { CAMPO_ENVIO_LISTING_AMAZON } from '../listings/vinculoListing';

/** The ONE link field this module reads and writes: the stock flow's. */
export const CAMPO_ENVIO_ESTOQUE_AMAZON = CAMPO_ENVIO_LISTING_AMAZON[
  FLUXO_LISTING_AMAZON.estoque
] satisfies keyof typeof produtoAmazonLinkSchema.shape;

/** The most read-decide-write attempts per document (module header). */
export const MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON = MAX_TENTATIVAS_ENVIO_LISTING_AMAZON;

/** The WARNING's motivo: a document still losing its precondition after every attempt. */
export const MOTIVO_GRAVACAO_ENVIO_EM_CONFLITO = MOTIVO_GRAVACAO_ENVIO_LISTING_EM_CONFLITO;

/** One link doc of the SKU: the produto it sits under (from its path) and its id. */
export type LinkDoEnvioEstoqueAmazon = LinkDoEnvioListingAmazon;

/** What {@link gravarEnvioEstoqueAmazon} is handed. */
export type EntradaGravacaoEnvioEstoqueAmazon =
  EntradaGravacaoEnvioListingAmazon<EnvioEstoqueAmazon>;

/** What {@link gravarEnvioEstoqueAmazon} did (module header). */
export type ResultadoGravacaoEnvioEstoqueAmazon = ResultadoGravacaoEnvioListingAmazon;

/** The stock binding of the shared write-back: the stock flow, its field, its schema and this module. */
const CAMPO_DO_ENVIO_ESTOQUE: CampoEnvioListingAmazon<EnvioEstoqueAmazon> = {
  fluxo: FLUXO_LISTING_AMAZON.estoque,
  schema: envioEstoqueAmazonSchema,
  rotulo: 'envioEstoqueFirestore.ts',
};

/**
 * Write `entrada.envio` onto every link doc of the SKU (module header).
 *
 * @throws {RangeError} a link id or produto id that is not a document id, or an
 *   `emMs` more than 24 h ahead of `agoraMs` (nothing read).
 * @throws {ZodError} an outcome the stock schema refuses (nothing written).
 */
export function gravarEnvioEstoqueAmazon(
  db: Firestore,
  entrada: EntradaGravacaoEnvioEstoqueAmazon,
  deps: { readonly logger: LoggerAmazon },
): Promise<ResultadoGravacaoEnvioEstoqueAmazon> {
  return gravarEnvioListingAmazon(db, CAMPO_DO_ENVIO_ESTOQUE, entrada, deps);
}
