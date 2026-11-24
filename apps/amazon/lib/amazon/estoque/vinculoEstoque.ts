/**
 * The link verdict of the Amazon stock sync (step 12, PR 12-d), pure: whether
 * a SKU's link docs may be trusted to publish stock at all, and if so, for
 * which unit. Its reader is `resolverEstoque.ts` (PR 12-e1).
 *
 * ## A binding of the shared verdict (step 13, PR 13-b)
 *
 * The rule is `listings/vinculoListing.ts`, ONE for every listings flow; this
 * module binds it to the stock flow and keeps the stock names. The binding is
 * the order import's resolution of the SKU, taken as given (that module's
 * header). The closed refusal list, in the order it is checked, keeps its
 * numbering:
 *
 * 1. `vinculo-ambiguo`, `produto-ausente` — the resolution, or a `dono` the
 *    resolution names and the input does not carry;
 * 2. `pai-do-vinculo-ilegivel` — a link's parent pointer that cannot be
 *    checked;
 * 3. `filho-com-sku-do-pai` — a child link carrying its parent's SKU or ASIN;
 * 4. `unidade-com-variacoes` — a unit with variations (a kit root's own sole
 *    member is not one);
 * 5. `envio-desligado` — the `dono`'s
 *    `statusProdutosMarketplace['<contaId>_<asin>'].enviarEstoque` is exactly
 *    `false`, under THIS conta's key and a link ASIN: the one refusal only
 *    the stock flow has.
 *
 * A link with no ASIN is apt and counted (`semAsinNoVinculo`). The stored
 * outcome it hands back is `envioEstoqueAmazon`'s, parsed by its schema (an
 * entry the schema refuses is skipped).
 *
 * ## The fields
 *
 * {@link CAMPOS_VINCULO_ESTOQUE_AMAZON}, {@link CAMPOS_DONO_ESTOQUE_AMAZON},
 * {@link CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON} and
 * {@link CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON} are everything the verdict reads
 * off a link doc, its `dono`, a pointed-at link doc and the unit: a reader may
 * project them to those fields (a test proves the projection changes no verdict).
 * `publicado` is not among them: it is never a gate.
 *
 * PURE: no Firestore, no clock.
 */
import { type EnvioEstoqueAmazon, envioEstoqueAmazonSchema } from '@delfrance/schemas';

import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import {
  type AlvoDoPaiListingAmazon,
  CAMPOS_DONO_LISTING_AMAZON,
  CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON,
  CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON,
  CAMPOS_VINCULO_LISTING_AMAZON,
  type DonoDoVinculoListingAmazon,
  type EntradaVinculoListingAmazon,
  LIMITE_FILHOS_UNIDADE_LISTING_AMAZON,
  type LinkDoSkuListingAmazon,
  type PonteiroPaiListingAmazon,
  type RegraVinculoListingAmazon,
  type UnidadeDoVinculoListingAmazon,
  type VeredictoVinculoListingAmazon,
  type VinculoAptoListingAmazon,
  avaliarVinculoListingAmazon,
  ponteiroPaiDoVinculoListingAmazon,
  unidadeComVariacoesListingAmazon,
} from '../listings/vinculoListing';

/** Everything the verdict reads off one of the SKU's link docs. */
export const CAMPOS_VINCULO_ESTOQUE_AMAZON =
  CAMPOS_VINCULO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.estoque];

/** Everything the verdict reads off the links' `dono`. */
export const CAMPOS_DONO_ESTOQUE_AMAZON = CAMPOS_DONO_LISTING_AMAZON[FLUXO_LISTING_AMAZON.estoque];

/** Everything the verdict reads off the document a parent pointer names. */
export const CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON = CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON;

/** Everything the verdict reads off the UNIT's produto document (refusal 4). */
export const CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON = CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON;

/**
 * The most children of the unit a reader seeks (`paiId == <unit>`): two tell
 * none, one and more apart, which is all refusal 4 asks.
 */
export const LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON = LIMITE_FILHOS_UNIDADE_LISTING_AMAZON;

/** The unit as refusal 4 reads it: its own document and the children a seek found. */
export type UnidadeDoVinculoEstoqueAmazon = UnidadeDoVinculoListingAmazon;

/** One link doc of the SKU, as the resolver read it. */
export type LinkDoSkuEstoqueAmazon = LinkDoSkuListingAmazon;

/** The `dono` the resolution names (its links' produto): its id and its raw document. */
export type DonoDoVinculoEstoqueAmazon = DonoDoVinculoListingAmazon;

/** A link's parent pointer, read. */
export type PonteiroPaiEstoqueAmazon = PonteiroPaiListingAmazon;

/** What a reader found at a pointer's path: the document's two fields, or nothing. */
export type AlvoDoPaiEstoqueAmazon = AlvoDoPaiListingAmazon;

/** What the verdict is handed. */
export type EntradaVinculoEstoqueAmazon = EntradaVinculoListingAmazon;

/** An apt link: the unit it publishes for, and what the plan and the gate read. */
export type VinculoAptoEstoqueAmazon = VinculoAptoListingAmazon<EnvioEstoqueAmazon>;

export type VeredictoVinculoEstoqueAmazon = VeredictoVinculoListingAmazon<EnvioEstoqueAmazon>;

/**
 * A link's `produtoAmazonPaiOuterRef`, read: `null` or no value is NO pointer;
 * a string in either stored form is its bare path; anything else is unreadable.
 */
export const ponteiroPaiDoVinculoEstoqueAmazon = ponteiroPaiDoVinculoListingAmazon;

/** Refusal 4: whether the unit has a child other than its own sole member as a kit root. */
export const unidadeComVariacoesEstoqueAmazon = unidadeComVariacoesListingAmazon;

/** The stock outcome stored on a link doc, parsed; `null` when absent or refused by its schema. */
function lerEnvioEstoque(valor: unknown): EnvioEstoqueAmazon | null {
  const lido = envioEstoqueAmazonSchema.safeParse(valor);
  return lido.success ? lido.data : null;
}

/** The stock flow's binding of the shared verdict: refusal 5 on, `envioEstoqueAmazon` read. */
export const REGRA_VINCULO_ESTOQUE_AMAZON: RegraVinculoListingAmazon<EnvioEstoqueAmazon> = {
  fluxo: FLUXO_LISTING_AMAZON.estoque,
  lerEnvio: lerEnvioEstoque,
};

/** The link verdict (module header). */
export function avaliarVinculoEstoqueAmazon(
  entrada: EntradaVinculoEstoqueAmazon,
): VeredictoVinculoEstoqueAmazon {
  return avaliarVinculoListingAmazon(entrada, REGRA_VINCULO_ESTOQUE_AMAZON);
}
