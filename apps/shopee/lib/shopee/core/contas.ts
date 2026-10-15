/**
 * The ONE enumeration of this channel's active contas — `integracao` filtered by
 * `(tipo, ativo)`, plus the raw `shop_id` off each enumerated document.
 *
 * It was `orderBackfill.ts`'s private code until the WEEKLY settlement sweep
 * (#1514, step 6) needed exactly the same walk. Promoted verbatim rather than
 * copied: two sweeps enumerating "every active Shopee conta" through two
 * spellings is the drift shape the root `CLAUDE.md` names — one of them gains a
 * clause, both keep their comments, and the pair reads as agreeing while one of
 * them silently stops seeing a conta.
 *
 * ⚠️ **The clauses and their ORDER are load-bearing.** The `(tipo, ativo)`
 * composite already exists in `firestore.indexes.json`, and on Firestore
 * Enterprise an unindexed query does not throw and offers no one-click link
 * (root rule 1): it silently full-scans and bills the data scanned. A third
 * clause added here needs its own index entry, in the same commit.
 *
 * ⚠️ It answers **every** active conta, `shop_id` or not, and never drops one.
 * A conta connected by MAIN ACCOUNT has no `shop_id`, cannot sign a shop call
 * and is a documented, renderable state in this channel rather than a failure —
 * so the enumeration reports `shopId: null` and each caller decides what that
 * means for it (the backfill counts it in `semShopId` and writes nothing).
 * Filtering it away here would make that count unreachable.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

/** One active Shopee `integracao` document, reduced to what a sweep needs. */
export interface ContaShopeeAtiva {
  readonly integracaoId: string;
  /** `null` ⇒ consent given by MAIN ACCOUNT; nothing shop-signed can run. */
  readonly shopId: number | null;
}

function numericField(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Every ACTIVE Shopee integração, in Firestore's own order.
 *
 * The `shop_id` is read **RAW** off the enumerated document: only this one field
 * is needed, and a soft `parseRead` of every conta would warn-spam each tick on
 * legacy partial documents.
 */
export async function listarContasShopeeAtivas(
  db: Firestore,
): Promise<readonly ContaShopeeAtiva[]> {
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.shopee)
    .where('ativo', '==', true)
    .get();

  return snap.docs.map((doc) => ({
    integracaoId: doc.id,
    shopId: numericField(doc.data() as Record<string, unknown>, 'shop_id'),
  }));
}
