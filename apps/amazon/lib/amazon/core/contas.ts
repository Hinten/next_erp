/**
 * The UNCACHED conta reads: the single conta a route or the callback gates a
 * write on, the seller-id lookup the wrong-seller guard (and step 3's routing)
 * runs, and the one enumeration of Amazon contas the expiry sweep walks.
 *
 * ⚠️ Every read here decides a write, so none of them may come from
 * `contaCache.ts`.
 *
 * ## Both queries are their index, clause for clause (root rule 1)
 *
 * On Firestore Enterprise an unindexed query does not throw: it silently
 * full-scans and bills the data scanned. So:
 *
 *  - {@link contasPorSellingPartnerId} is EXACTLY the declared
 *    `integracao (tipo ASC, selling_partner_id ASC, ativo ASC)` composite
 *    (step 2 PR r) — the full shape, `ativo == true` included, never a prefix
 *    guess — capped at `limit(2)`: two answers are enough to see "another
 *    conta holds this seller" and, for step 3, "more than one does";
 *  - {@link listarContasAmazon} is EXACTLY the existing
 *    `integracao (tipo ASC, nome ASC)` composite — the list screen's own query.
 *
 * ⚠️ **A tipo-8 conta with NO `nome` field is outside the enumeration.** A
 * classic `orderBy` also filters for the field's existence, so such a document
 * never comes back to the sweep (no reauthorization warning; pass (b) would
 * close its open rows as `conta-removida`). Accepted: `integracaoSchema.nome` is
 * required (`min(1)`), the legacy writes it as required, and the same `(tipo,
 * nome)` query is the list screen's `defaultQuery` — a nome-less conta is
 * already invisible there. `contas.test.ts` pins the exclusion.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../avisos/avisos';

/**
 * The conta-id grammar lives in the light `idConta.ts` (the logger and the
 * valves check ids too, and must not reach this file's Firestore imports);
 * re-exported here so the routes' import sites stay as they are.
 */
export { idDeContaValido } from './idConta';

/** An Amazon conta, read uncached, with the commit stamp a guarded write needs. */
export interface ContaAmazonLida {
  readonly conta: Integracao;
  /** The document's `updateTime` — the `lastUpdateTime` of a write decided on this read. */
  readonly updateTime: Timestamp;
  /**
   * The read's own `readTime` — WHEN this observation of the conta was true, on
   * the server timeline. The order import clocks the per-conta avisos with it
   * (step 5), the timeline the expiry sweep's conta enumeration shares.
   */
  readonly readTime: Timestamp;
}

/**
 * The conta document, read UNCACHED, when it exists AND is an Amazon conta;
 * `null` otherwise. Only `tipo` is required: a parked, inactive or unconnected
 * conta must stay connectable and visible.
 */
export async function lerContaAmazon(
  db: Firestore,
  integracaoId: string,
): Promise<ContaAmazonLida | null> {
  const snap = await integracaoCollection.docRef(db, {}, integracaoId).get();
  if (!snap.exists) return null;
  const conta = integracaoCollection.parseRead(
    snap.data(),
    integracaoCollection.docPath({}, integracaoId),
  );
  if (conta.tipo !== INTEGRACAO_TIPO.amazon) return null;
  const updateTime = snap.updateTime;
  if (updateTime === undefined) {
    // An existing document always has one; refusing beats deciding a guarded
    // write on no stamp at all.
    throw new Error(`lerContaAmazon(${integracaoId}): documento existente sem updateTime`);
  }
  return { conta, updateTime, readTime: snap.readTime };
}

/**
 * The ids of the ACTIVE Amazon contas bound to `sellingPartnerId`, at most two.
 * The comparison is Firestore's exact equality: no trim, no case fold.
 */
export async function contasPorSellingPartnerId(
  db: Firestore,
  sellingPartnerId: string,
): Promise<string[]> {
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.amazon)
    .where('selling_partner_id', '==', sellingPartnerId)
    .where('ativo', '==', true)
    .limit(2)
    .get();
  return snap.docs.map((d) => d.id);
}

/** One Amazon conta, reduced to what the sweep needs. */
export interface ContaAmazonResumo {
  readonly integracaoId: string;
  /** The operator-facing name; `''` only for a malformed legacy row (a non-string `nome`). */
  readonly nome: string;
  /** `false` only when the document says so explicitly (the schema default is `true`). */
  readonly ativo: boolean;
}

/** The enumeration, and WHEN it was read. */
export interface ContasAmazon {
  readonly contas: readonly ContaAmazonResumo[];
  /**
   * µs of the query's `readTime`: a conta created — or a credential parked —
   * after it is stamped later. Pass (b) of the sweep resolves an orphan
   * reconexão row with it, so a park on a conta this list could not see cannot
   * be closed by it.
   */
  readonly leituraUs: number;
}

/**
 * EVERY Amazon conta, active or not, ordered by `nome` — except one lacking the
 * field (module header). Fields are read RAW off each row: three are needed, and
 * a soft parse of every conta would warn-spam each tick on a legacy partial row.
 */
export async function listarContasAmazon(db: Firestore): Promise<ContasAmazon> {
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.amazon)
    .orderBy('nome')
    .get();
  const contas = snap.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      integracaoId: doc.id,
      nome: typeof data.nome === 'string' ? data.nome : '',
      ativo: data.ativo !== false,
    };
  });
  return { contas, leituraUs: relogioDoDocumentoUs(snap.readTime) };
}
