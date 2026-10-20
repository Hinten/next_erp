/**
 * The WRONG-SELLER GUARD and the one write of the conta's `selling_partner_id`.
 *
 * The seller id is what step 3 routes every inbound Amazon event by
 * (`tipo == 8 && selling_partner_id == X && ativo == true`), so binding a conta
 * to the wrong seller would hand one seller's orders to another conta. Amazon's
 * callback says which seller authorized; this module decides whether THIS conta
 * may take that seller.
 *
 * ## The decision — {@link decidirVinculoVendedor}, pure
 *
 * Checked in this order, comparing EXACTLY (no trim, no case fold — the id's
 * format is undocumented, so a "near" match is a different seller):
 *
 *  1. no such conta (or not an Amazon conta) → `conta-ausente`;
 *  2. the conta already holds a DIFFERENT seller id → `vendedor-diferente`. To
 *     change sellers the operator creates another conta (the panel says so);
 *  3. another ACTIVE Amazon conta holds this seller → `vendedor-em-outra-conta`
 *     (also for a reconnect of the same seller: a duplicate must be resolved by
 *     deactivating one conta, never deepened);
 *  4. the conta already holds THIS seller → `mesmo-vendedor` (a reauthorization,
 *     or a migrated conta whose legacy id matches): nothing to write;
 *  5. otherwise → `gravar`.
 *
 * An INACTIVE holder does not block: that is exactly the routing query's shape
 * (`ativo == true`). Reactivating it later creates a duplicate the router's
 * `limit(2)` detects (step 3) — the documented residual.
 *
 * ## The write — {@link gravarVendedor}, tier 1 (root rule 7)
 *
 * Each attempt re-reads the conta UNCACHED, re-runs the seller query, re-decides,
 * and on `gravar` writes `update({ selling_partner_id }, { lastUpdateTime })`
 * through the Admin SDK (which bypasses the rule that makes the field
 * server-owned). A lost precondition (9, or 5) re-decides from a fresh read; the
 * losing patch is never re-applied. After {@link MAX_TENTATIVAS_VINCULO} losses
 * the answer is `conflito`. Never `merge`/`set`: an upsert would resurrect a
 * conta deleted between the read and the write.
 *
 * ⚠️ The cross-conta check is a QUERY, and no precondition covers a query: two
 * contas connecting the same seller in the same seconds both pass. Step 3's
 * `limit(2)` routing lookup is what detects that residual.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import type { Integracao } from '@delfrance/schemas';

import { contasPorSellingPartnerId, lerContaAmazon } from '../core/contas';

/** Read-decide-write attempts before answering `conflito`. */
export const MAX_TENTATIVAS_VINCULO = 3;

export type DecisaoVinculoVendedor =
  | 'gravar'
  | 'mesmo-vendedor'
  | 'conta-ausente'
  | 'vendedor-diferente'
  | 'vendedor-em-outra-conta';

/**
 * Pure (module header). `outrasAtivas` are the ids of the OTHER active Amazon
 * contas holding `sellingPartnerId` — the caller excludes this conta's own id.
 */
export function decidirVinculoVendedor(
  conta: Pick<Integracao, 'selling_partner_id'> | null,
  sellingPartnerId: string,
  outrasAtivas: readonly string[],
): DecisaoVinculoVendedor {
  if (conta === null) return 'conta-ausente';
  const atual: unknown = conta.selling_partner_id;
  // A legacy row may hold a non-string here (a soft read); it is "different".
  if (atual != null && atual !== sellingPartnerId) return 'vendedor-diferente';
  if (outrasAtivas.length > 0) return 'vendedor-em-outra-conta';
  if (atual === sellingPartnerId) return 'mesmo-vendedor';
  return 'gravar';
}

/**
 * The guard's input, read fresh: the conta (uncached) and the OTHER active
 * contas holding the seller. Used by the callback's pre-guard and by every
 * attempt of {@link gravarVendedor}.
 */
export async function lerVinculo(
  db: Firestore,
  integracaoId: string,
  sellingPartnerId: string,
): Promise<{
  readonly lida: Awaited<ReturnType<typeof lerContaAmazon>>;
  readonly decisao: DecisaoVinculoVendedor;
}> {
  const lida = await lerContaAmazon(db, integracaoId);
  const outras = (await contasPorSellingPartnerId(db, sellingPartnerId)).filter(
    (id) => id !== integracaoId,
  );
  return { lida, decisao: decidirVinculoVendedor(lida?.conta ?? null, sellingPartnerId, outras) };
}

export type ResultadoVinculo = Exclude<DecisaoVinculoVendedor, 'gravar'> | 'gravado' | 'conflito';

/** Bind the conta to the seller, if the guard still allows it (module header). */
export async function gravarVendedor(
  db: Firestore,
  integracaoId: string,
  sellingPartnerId: string,
): Promise<ResultadoVinculo> {
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_VINCULO; tentativa += 1) {
    // Every decision below is derived from THIS attempt's reads.
    const { lida, decisao } = await lerVinculo(db, integracaoId, sellingPartnerId);
    if (decisao !== 'gravar' || lida === null) {
      return decisao === 'gravar' ? 'conta-ausente' : decisao;
    }
    const patch = integracaoCollection.parseMerge({ selling_partner_id: sellingPartnerId });
    try {
      await integracaoCollection
        .docRef(db, {}, integracaoId)
        .update(patch, { lastUpdateTime: lida.updateTime });
      return 'gravado';
    } catch (err) {
      // Lost the race, or the conta was deleted (9, or 5): re-read, re-decide.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  return 'conflito';
}
