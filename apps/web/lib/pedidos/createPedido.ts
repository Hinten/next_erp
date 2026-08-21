import { getDoc, runTransaction, type Firestore } from 'firebase/firestore';
import { nowMicros } from '@delfrance/core';
import type { Pedido } from '@delfrance/schemas';
import { PEDIDO_COUNTER_DOC_ID, mintNumeros, operacaoNumeroPrefix } from '@delfrance/data/pedido';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { counterCollection } from '@/lib/data/counterCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { newDocId } from '@/lib/data/newDocId';
import { marcarInteracaoDoUsuario } from './interacaoDoUsuario';

// The numero constants/format helpers moved to `@delfrance/data/pedido`
// (SDK-agnostic, shared with the devolução transactional flows); re-exported
// here so existing imports keep working.
export {
  PEDIDO_COUNTER_DOC_ID,
  PEDIDO_NUMERO_NO_OPERACAO_PREFIX,
  PEDIDO_NUMERO_WIDTH,
  formatPedidoNumero,
  operacaoNumeroPrefix,
} from '@delfrance/data/pedido';

/**
 * Create a pedido with an auto-assigned, human-readable, unique `numero` of the
 * form `<PREFIX>-<seq>` (e.g. `VEN-000042`), where `PREFIX` is the operação's
 * first 3 letters (or `NUL` when there's no operação) and `seq` is a zero-padded
 * global sequence.
 *
 * The pedido id is minted client-side (`newDocId`) so the counter bump and the
 * pedido write share a single `runTransaction`: the counter read/bump/set
 * protocol lives in `mintNumeros` (`@delfrance/data/pedido`, shared with the
 * devolução transactional flows), applied here through the counter handle.
 * This is the browser equivalent of the NF-e numeração counter
 * (`packages/integrations/nfe/src/numeracao/`) — gap-free and unique even under
 * concurrent creates, at the minimum cost of one extra read + one extra write.
 * (The operação is read once, outside the transaction, only to derive the
 * prefix — it never affects the sequence value.)
 *
 * The transaction retries automatically on contention; if it ultimately fails
 * it throws, so a pedido is never created without a `numero`.
 *
 * @returns the new pedido's Firestore doc id + its minted `numero`.
 */
export async function createPedidoWithNumero(
  db: Firestore,
  values: Pedido,
): Promise<{ id: string; numero: string }> {
  const nome = await resolveOperacaoNome(db, values.operacaoPedidoOuterRef);
  const prefix = operacaoNumeroPrefix(nome);
  const pedidoId = newDocId();
  // Set by the FINAL (committed) attempt; reset per attempt since the
  // transaction re-runs on contention.
  let numero = '';
  await runTransaction(db, async (tx) => {
    const counterRef = counterCollection.docRef(db, {}, PEDIDO_COUNTER_DOC_ID);
    // Reads must precede writes in a Firestore transaction.
    const snap = await tx.get(counterRef);
    const counterDoc = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    const { numeros, counterOp } = mintNumeros(counterDoc, [prefix]);
    numero = numeros[0]!;
    // `mintNumeros` always emits the counter write as a `set` op — the check
    // only narrows the `PedidoWriteOp` union (a `delete` carries no data).
    if (counterOp.type !== 'set') throw new Error('mintNumeros: counterOp must be a set op');
    tx.set(counterRef, counterOp.data as never);
    // This function is only ever reached from `NovoPedidoView` — an operator
    // pressing "Salvar" — so the pedido is human-authored by construction. See
    // `marcarInteracaoDoUsuario` for why the flag has to be written.
    // Stamp the creation time. `PedidoForm` seeds `timestamp: null` and nothing
    // downstream filled it, so until #159 EVERY pedido created here landed with
    // a null `timestamp` — which left the "Criação" column permanently blank and,
    // now that `pedidoMeta.defaultQuery` orders by `timestamp desc`, would sort
    // brand-new pedidos to the BOTTOM of /pedidos (null sorts last in DESC).
    //
    // Create-only nullish coalesce, the same shape `saveRecord` uses for its
    // `createdAtField`: an explicit value (e.g. a caller replaying an import)
    // wins, and re-running the transaction on contention re-derives nothing —
    // `nowMicros()` is read per attempt, which is fine for a creation stamp.
    tx.set(
      pedidoCollection.docRef(db, {}, pedidoId),
      marcarInteracaoDoUsuario({ ...values, numero, timestamp: values.timestamp ?? nowMicros() }),
    );
  });
  return { id: pedidoId, numero };
}

/**
 * Resolve an operação's `nome` from a pedido's `operacaoPedidoOuterRef`. Reads
 * the operação doc (a legacy outer-ref, so via the generic dereference —
 * tolerant of non-string legacy ref shapes) to get its `nome`. Returns null
 * when there's no ref, the doc is missing or `nome` isn't a string (→ the
 * `NUL` prefix via `operacaoNumeroPrefix`); a read failure (FirebaseError)
 * propagates so callers surface it rather than silently mislabeling the pedido.
 */
export async function resolveOperacaoNome(
  db: Firestore,
  operacaoRef: unknown,
): Promise<string | null> {
  const ref = dereferenceOuterRef(db, operacaoRef);
  if (ref == null) return null;
  const snap = await getDoc(ref);
  const nome = snap.exists() ? (snap.data() as { nome?: unknown }).nome : null;
  return typeof nome === 'string' ? nome : null;
}
