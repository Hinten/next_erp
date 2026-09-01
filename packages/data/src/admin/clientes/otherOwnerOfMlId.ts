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
 * claim path (`apps/mercado-livre/.../claims/claimCliente.ts`, #768) and lives
 * here because `findOrCreateCliente`'s own fill-when-absent stamp needs exactly
 * the same answer — and a second implementation of "who else owns this?" is the
 * kind of copy that reads correct while disagreeing.
 *
 * ⚠️ Refusing is the whole contract. Merging two clientes moves pedidos,
 * conversas and endereços; that is a migration, not something an import or a
 * webhook may do on its own. A caller that gets a hit here logs the split and
 * leaves both documents alone.
 *
 * ⚠️ **It narrows the window; it does not close it.** This is a read, and both
 * callers write afterwards without a precondition covering the OTHER document —
 * `claimCliente`'s `lastUpdateTime` guards the doc being stamped, not the
 * appearance of a rival owner, and `findOrCreateCliente` merges with no
 * precondition at all. So two imports resolving the same new buyer concurrently
 * can both read "free" and both stamp. That residual is the same one
 * `findOrCreateCliente`'s blind `add` already carries (root `CLAUDE.md` rule 7,
 * tier 0 — a deterministic doc id — is the real fix, and is blocked because
 * cliente doc ids are shared with the migrated corpus). Do not read a passing
 * check here as an invariant; it removes the COMMON case, which is a pre-sale
 * question's cliente that has existed for days.
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
