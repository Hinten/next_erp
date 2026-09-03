import { type Firestore, getDocsFromServer } from 'firebase/firestore';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { produtoCollection } from '@/lib/data/produtoCollection';

// Flutter parity (`produtoCadastro.dart:703-727`): a random ≤9-digit number,
// retried until no produto already has that SKU.
const MAX_TENTATIVAS = 10;

/**
 * Mint a produto SKU no other produto holds.
 *
 * SKU is the app's de-facto unique produto key — `orderProdutoResolve`
 * (apps/mercado-livre) binds an ML order line by it, and `resolveScan`
 * (despacho) resolves a scanned code with `where('sku','==',x) limit(1)` — so a
 * value minted here has to be probed against the corpus, not just generated.
 * The query rides the existing `produtos(sku)` index.
 *
 * ⚠️ **Fail-closed, twice over.** The probe is a SERVER read: a cache-served
 * empty result could hand back a SKU that already exists. And a probe error
 * PROPAGATES (`FirebaseError`) rather than resolving — a caller that cannot
 * verify uniqueness must not act as if it had.
 *
 * `jaMintados` excludes values minted earlier in the same operation, which are
 * not in Firestore yet: without it a batch mint (duplicating a produto family)
 * could collide with itself and pass every probe.
 *
 * Returns `null` when {@link MAX_TENTATIVAS} candidates were all taken — the
 * caller decides whether that is a failure or an empty SKU.
 */
export async function gerarSkuUnico(
  db: Firestore,
  jaMintados?: ReadonlySet<string>,
): Promise<string | null> {
  for (let i = 0; i < MAX_TENTATIVAS; i += 1) {
    const candidato = String(Math.floor(Math.random() * 999_999_999));
    if (jaMintados?.has(candidato)) continue;
    const snap = await getDocsFromServer(
      buildQuery(produtoCollection.ref(db, {}), [whereEqual('sku', candidato), limit(1)]),
    );
    if (snap.empty) return candidato;
  }
  return null;
}
