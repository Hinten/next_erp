import { defineCollection } from '@delfrance/data';
import { cartaCorrecaoSchema } from '@delfrance/schemas';

/**
 * Subcollection: `pedidos/{pedidoId}/nfev4/{nfeId}/cartacorrecao` — the
 * append-only log of every Carta de Correção Eletrônica (CC-e) issued for one
 * NF-e, registrada or rejeitada. Pass `{ pedidoId, nfeId }` in the path
 * context. Listed newest-first on the dedicated CC-e screen, mirroring the old
 * Flutter `CartaCorrecaoTableView`.
 */
export const cartaCorrecaoCollection = defineCollection({
  path: 'pedidos/{pedidoId}/nfev4/{nfeId}/cartacorrecao',
  schema: cartaCorrecaoSchema,
});
