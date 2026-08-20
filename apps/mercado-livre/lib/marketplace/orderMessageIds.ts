/**
 * Deterministic document ids for the Mercado Livre post-sale message import
 * (#532) — byte-exact replicas of the legacy Flutter formulas, for the reason
 * `claimIds.ts` and `questionIds.ts` state: the Flutter app wrote these threads
 * into `chat/*` for years, and a re-processed pack must UPDATE those documents
 * rather than fork a conversation the operator already knows.
 *
 * ⚠️ The preimage uses `contaPathLegacyMl`, which keeps the LEADING slash
 * (`/documents/integracao/<id>`). Never normalize it through `toOuterRef`.
 */
import { contaPathLegacyMl, generateUid } from './claimIds';

/**
 * The conversa for one pack thread —
 * `generateUid(conta.docId.path, packOrOrderId)` (legacy
 * `OrderMessage.toConversa`, `models.dart:3364`).
 *
 * ⚠️ The id is the **pack** id when the sale has one and the ORDER id otherwise,
 * which is the same key legacy used (`tasks.dart:1513-1525`, `packs` first with
 * `orders` as the fallback). Keying on the order id when a pack exists would
 * split one buyer conversation into one thread per order in the cart.
 */
export function makeConversaIdOrderMessage(contaId: string, packOrOrderId: string): string {
  return generateUid(contaPathLegacyMl(contaId), packOrOrderId);
}

/**
 * The mensagem for one ML message — the RAW ML message id, not a digest (legacy
 * `models.dart:3391`/`3403`, which sets both `docIdString` and `mid` to it).
 *
 * ML message ids are 32-char hex, so they are safe Firestore document ids as-is.
 */
export function makeOrderMensagemId(messageId: string): string {
  return messageId;
}
