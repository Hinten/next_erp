/**
 * Resolve the pedido owning a Mercado Livre order/pack id via its `orderML`
 * collection-group mirror — `pack_id == orderId` FIRST, then plain
 * `id == orderId` (the two-step resolve legacy runs everywhere:
 * tasks.dart:1178-1191 / :1266-1270 / :1800-1834). The pack-first order is a
 * faithful legacy quirk and load-bearing: an order that belongs to a cart
 * must resolve to the cart's (pack's) pedido, and id-first would silently
 * change pack resolution.
 *
 * Extracted from the byte-identical private copies the payments handler
 * (`orderPaymentImport.ts`) and shipments handler (`orderShipmentImport.ts`)
 * each carried; the claims import (Step 14) is the third consumer. Not
 * transactional (a plain collection-group scan) — callers re-derive every
 * write decision from fresh in-tx reads, so a resolve-then-write race only
 * risks a benign retry on the next notification delivery, never a wrong
 * write. Returns `null` when neither key matches any `orderML` doc.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { orderMLCollection } from '@delfrance/data/admin/collections';

export async function resolvePedidoIdByOrderId(
  db: Firestore,
  orderId: number,
): Promise<string | null> {
  const byPack = await orderMLCollection
    .groupQuery(db)
    .where('pack_id', '==', orderId)
    .limit(1)
    .get();
  const packDoc = byPack.docs[0];
  if (packDoc) return packDoc.ref.parent?.parent?.id ?? null;

  const byId = await orderMLCollection.groupQuery(db).where('id', '==', orderId).limit(1).get();
  const idDoc = byId.docs[0];
  return idDoc ? (idDoc.ref.parent?.parent?.id ?? null) : null;
}
