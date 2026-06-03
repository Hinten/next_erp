import { defineAdminCollection } from '@delfrance/data/admin';
import { cartaCorrecaoMeta, cartaCorrecaoSchema } from '@delfrance/schemas';

/**
 * Admin-SDK handle for the per-NF-e `cartacorrecao` subcollection
 * (`pedidos/{pedidoId}/nfev4/{nfeId}/cartacorrecao`). Append-only: every Carta
 * de Correção Eletrônica (CC-e) round-trip — registrada (cStat 135) or
 * rejeitada — writes a new, schema-validated doc. The path is taken from the
 * schema metadata so it stays a single source of truth.
 */
export const cartaCorrecaoCollection = defineAdminCollection({
  path: cartaCorrecaoMeta.collectionPath,
  schema: cartaCorrecaoSchema,
});
