import { z } from 'zod';
import type { CollectionMetadata, DomainSchema } from '../../types';
import { produtoMeta } from './produto';

/**
 * Marketplace-link + variation subcollections every `produtos/<id>` doc can
 * carry — one listing/variation doc per channel, written by the Flutter app
 * (see `Produto.deleteCascade` / `models.deletecascade.g.dart`). Variation
 * children hold their own link docs too (`variacaoMercadoLivre` lives UNDER the
 * child produto), so "is this produto on a marketplace?" is answerable from the
 * doc's OWN subcollections — which is what the Next delete guard
 * (`apps/web/lib/produtos/references.ts`) probes.
 *
 * The Mercado Livre leaf names are **camelCase** — `produtoMercadoLivre` and
 * `variacaoMercadoLivre` — matching the deployed Flutter `PRODUTO_ML_COLLECTION`
 * / `VARIACAO_ML_COLLECTION` constants (the Dart class `VariacoesML` and its
 * lowercased ORM getter do NOT reflect the real path). Earlier lowercase
 * spellings (`produtomercadolivre`/`variacoesml`) never matched production, so
 * the delete-guard probes silently saw no listings.
 *
 * The remaining leaf names below are the **verified real ids** (#289),
 * cross-checked against each channel package's compiled `models.odm.g.dart`
 * `collectionId` constant. The previous guessed names
 * (`produtoshopee`/`variacaoshopee`/`produtoamazon`/`produtomagalu`/
 * `produtointegrada`) never matched — they covered collections Flutter never
 * writes to, so the same silent-miss failure mode as the ML rename above
 * applied to every non-ML channel.
 *
 * These were defined only in `apps/web` and so were invisible to the rules
 * generator: the generated ruleset emitted no match block, Firestore
 * default-denied them, and the produto delete guard's existence-probe reads
 * threw "Missing or insufficient permissions" (#160). Registering them here
 * makes the generator cover them. They are gated by the parent `produto`
 * permissions — Flutter writes them, Next reads them, both must keep working
 * once the generated ruleset is enforced. The schema is loose pass-through:
 * the Flutter wire shape is the source of truth and these are not validated.
 */
const subcollectionSchema = z.object({}).passthrough();

function produtoSubcollection(name: string): DomainSchema<typeof subcollectionSchema> {
  const meta: CollectionMetadata = {
    collectionPath: `produtos/{produtoId}/${name}`,
    permissions: { ...produtoMeta.permissions },
  };
  return { schema: subcollectionSchema, meta };
}

export const produtoMercadoLivre = produtoSubcollection('produtoMercadoLivre');
export const variacaoMercadoLivre = produtoSubcollection('variacaoMercadoLivre');
export const produtoShopee = produtoSubcollection('prodshopee');
export const variacaoShopee = produtoSubcollection('variashopee');
export const produtoMagalu = produtoSubcollection('produtoMagalu2');
export const produtoAmazon = produtoSubcollection('prodAmazon');
export const produtoLojaIntegrada = produtoSubcollection('produtolojaintegrada');

/** Every produto subcollection domain, spread into `ALL_DOMAINS`. */
export const PRODUTO_SUBCOLLECTION_DOMAINS: ReadonlyArray<DomainSchema<z.ZodTypeAny>> = [
  produtoMercadoLivre,
  variacaoMercadoLivre,
  produtoShopee,
  variacaoShopee,
  produtoMagalu,
  produtoAmazon,
  produtoLojaIntegrada,
];

/**
 * Leaf names (the segment after `produtos/{produtoId}/`). The single source
 * `apps/web` builds its `defineCollection` handles + channel labels from, so
 * the app path list can never drift from the rules-covered set.
 */
export const PRODUTO_SUBCOLLECTION_NAMES: ReadonlyArray<string> = PRODUTO_SUBCOLLECTION_DOMAINS.map(
  (d) => d.meta.collectionPath.split('/').at(-1)!,
);
