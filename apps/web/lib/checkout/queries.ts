import { buildQuery, groupQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import type { Firestore, Query } from 'firebase/firestore';
import type { CheckoutFretePedido } from '@delfrance/schemas';
import { checkoutCollection } from '../data/checkoutCollection';

/**
 * The current user's most-recent checkout docs across ALL pedidos — the "Outros
 * Checkouts" panel (PR 6). A collection-group query on the `checkout` leaf,
 * scoped to this user via the denormalized `usuarioCheckoutFretePedidoOuterRef`
 * string. That value MUST be exactly `documents/usuarios/<uid>` (the usuario doc
 * id is the Firebase auth uid) — a wrong prefix silently returns nothing.
 * Newest first, hard-capped at 50 (bounds the realtime listener).
 */
export function outrosCheckoutsQuery(db: Firestore, uid: string): Query<CheckoutFretePedido> {
  return buildQuery(groupQuery(db, 'checkout', checkoutCollection.converter), [
    whereEqual('usuarioCheckoutFretePedidoOuterRef', `documents/usuarios/${uid}`),
    orderByField('timestamp', 'desc'),
    limit(50),
  ]);
}
