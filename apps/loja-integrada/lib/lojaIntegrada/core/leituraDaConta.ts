/**
 * The ONE uncached read of a single Loja Integrada conta, in a module of its own so a route that
 * must never reach the credential modules can read the conta too: `core/contas.ts` (which
 * re-exports it, so no importer changed) also holds the wrong-store guard, and with it the
 * credential store and the fingerprint. The operator's stock routes (step 12, PR 12-h) read the
 * conta here; `estrutura.test.ts` walks them and refuses any credential module in their closure.
 *
 * ⚠️ Every read here decides something, so none of them may come from `contaCache.ts`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';

/**
 * The conta document, read uncached, when it exists AND is a Loja Integrada
 * conta; `null` otherwise (the routes answer both with one 404). `ativo` is not
 * checked: a parked or inactive conta must stay fixable.
 */
export async function lerContaLojaIntegrada(
  db: Firestore,
  integracaoId: string,
): Promise<Integracao | null> {
  const snap = await integracaoCollection.docRef(db, {}, integracaoId).get();
  if (!snap.exists) return null;
  const conta = integracaoCollection.parseRead(
    snap.data(),
    integracaoCollection.docPath({}, integracaoId),
  );
  return conta.tipo === INTEGRACAO_TIPO.lojaIntegrada ? conta : null;
}
