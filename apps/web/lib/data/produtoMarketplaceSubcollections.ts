import { z } from 'zod';
import { defineCollection } from '@delfrance/data';

/**
 * The marketplace-link subcollections every `produtos/<id>` doc can carry,
 * written by the Flutter app (one listing/variation doc per channel — see the
 * generated `Produto.deleteCascade`, `models.deletecascade.g.dart`). Variation
 * children hold their own link docs too: e.g. a Mercado Livre variation is a
 * `variacoesml` doc saved UNDER the child produto
 * (`produtoTableProvider.dart:1570`), so "is this produto on a marketplace?"
 * is always answerable from the doc's OWN subcollections.
 *
 * The Next app only ever READS these for existence checks (deletion guard);
 * the loose schema keeps the Flutter wire shape untouched.
 */
const marketplaceLinkSchema = z.object({}).passthrough();

function subcollection(name: string) {
  return defineCollection({
    path: `produtos/{produtoId}/${name}`,
    schema: marketplaceLinkSchema,
  });
}

/** Subcollection handle + the human label shown in guard messages. */
export const PRODUTO_MARKETPLACE_SUBCOLLECTIONS = [
  {
    name: 'produtomercadolivre',
    label: 'Mercado Livre',
    handle: subcollection('produtomercadolivre'),
  },
  { name: 'variacoesml', label: 'Mercado Livre', handle: subcollection('variacoesml') },
  { name: 'produtoshopee', label: 'Shopee', handle: subcollection('produtoshopee') },
  { name: 'variacaoshopee', label: 'Shopee', handle: subcollection('variacaoshopee') },
  { name: 'produtomagalu', label: 'Magalu', handle: subcollection('produtomagalu') },
  { name: 'produtoamazon', label: 'Amazon', handle: subcollection('produtoamazon') },
  { name: 'produtointegrada', label: 'Loja Integrada', handle: subcollection('produtointegrada') },
] as const;
