import { z } from 'zod';
import { defineCollection } from '@delfrance/data';
import { PRODUTO_SUBCOLLECTION_NAMES } from '@delfrance/schemas';

/**
 * The marketplace-link subcollections every `produtos/<id>` doc can carry,
 * written by the Flutter app (one listing/variation doc per channel — see the
 * generated `Produto.deleteCascade`, `models.deletecascade.g.dart`). Variation
 * children hold their own link docs too: e.g. a Mercado Livre variation is a
 * `variacaoMercadoLivre` doc saved UNDER the child produto
 * (`produtoTableProvider.dart:1570`), so "is this produto on a marketplace?"
 * is always answerable from the doc's OWN subcollections.
 *
 * The Next app only ever READS these for existence checks (deletion guard);
 * the loose schema keeps the Flutter wire shape untouched.
 *
 * The path/name list is the shared schemas registry
 * (`PRODUTO_SUBCOLLECTION_NAMES`) — the same list the rules generator covers —
 * so the app's collections can never drift from the rules (#160). This file
 * only layers on the human channel labels shown in guard messages.
 */
const marketplaceLinkSchema = z.object({}).passthrough();

function subcollection(name: string) {
  return defineCollection({
    path: `produtos/{produtoId}/${name}`,
    schema: marketplaceLinkSchema,
  });
}

/** Channel label per subcollection name, shown in deletion-guard messages. */
const CHANNEL_LABELS: Record<string, string> = {
  produtoMercadoLivre: 'Mercado Livre',
  variacaoMercadoLivre: 'Mercado Livre',
  produtoshopee: 'Shopee',
  variacaoshopee: 'Shopee',
  produtomagalu: 'Magalu',
  produtoamazon: 'Amazon',
  produtointegrada: 'Loja Integrada',
};

/**
 * Subcollection handle + the human label shown in guard messages, built from
 * the shared registry. A new subcollection added to `@delfrance/schemas`
 * without a label here throws at load time — keeping the app and the rules in
 * lock-step.
 */
export const PRODUTO_MARKETPLACE_SUBCOLLECTIONS = PRODUTO_SUBCOLLECTION_NAMES.map((name) => {
  const label = CHANNEL_LABELS[name];
  if (!label) {
    throw new Error(`produtoMarketplaceSubcollections: missing channel label for "${name}"`);
  }
  return { name, label, handle: subcollection(name) };
});
