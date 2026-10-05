/**
 * "Does a DIFFERENT cliente already carry this ML buyer id?"
 *
 * `cliente.idMercadoLivre` is a strong match key: `findOrCreateCliente`'s third
 * leg resolves a buyer by it. Two documents carrying the same id are therefore
 * **two strong owners of one identity**, and that leg could then return either —
 * the ambiguity #1067 exists to prevent, manufactured by the very write that was
 * meant to converge them.
 *
 * So every path that STAMPS the id has to ask this first. It was written for the
 * claim path (`apps/mercado-livre/.../claims/claimCliente.ts`, #768). The shared
 * importer now performs its equivalent check inside its identity-index
 * transaction; this standalone probe remains for the claim path, which does
 * not run through `findOrCreateCliente`.
 *
 * ⚠️ Refusing is the whole contract. Merging two clientes moves pedidos,
 * conversas and endereços; that is a migration, not something an import or a
 * webhook may do on its own. A caller that gets a hit here logs the split and
 * leaves both documents alone.
 *
 * ⚠️ **On the claim path it narrows the window; it does not close it.** This is
 * a read followed by a write whose `lastUpdateTime` guards the cliente being
 * stamped, not the appearance of a rival owner. Importers do not share that
 * residual: their identity-index document is re-read and written in the same
 * transaction. Do not read this standalone check as an invariant for claims.
 *
 * The SDK is never bound here — `db` arrives from the caller, which is what
 * keeps this subtree importable from a browser bundle's dependency graph without
 * dragging firebase-admin in (`../adminBundleSafety.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { clienteCollection } from '../collections';

/**
 * The id of any cliente OTHER than `clienteId` already carrying
 * `idMercadoLivre`, or `null` when nobody else does.
 *
 * ⚠️ `limit(2)` on purpose: one hit that IS the cliente we are about to stamp is
 * fine, so the query has to be able to see a second. It is index-backed by the
 * same single-field `clientes(idMercadoLivre)` index `findOrCreateCliente`'s
 * match leg needs — no new index.
 *
 * Pass `clienteId: null` to ask the unrestricted question ("does anyone own
 * this?"), which is what a caller resolving a buyer with no cliente yet wants.
 */
export async function otherOwnerOfMlId(
  db: Firestore,
  idMercadoLivre: string,
  clienteId: string | null,
): Promise<string | null> {
  const snap = await clienteCollection
    .ref(db, {})
    .where('idMercadoLivre', '==', idMercadoLivre)
    .limit(2)
    .get();
  const outro = snap.docs.find((d) => d.id !== clienteId);
  return outro?.id ?? null;
}
