import { getDoc, runTransaction, type Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { counterCollection } from '@/lib/data/counterCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { newDocId } from '@/lib/data/newDocId';

/**
 * Fixed width of the zero-padded numeric part of a pedido `numero`
 * (e.g. `42` → `"000042"`). `numero` is stored as a string and is the default
 * list sort key (`pedidoMeta.defaultQuery` orders by `numero` desc, a lexical
 * sort), so a fixed width keeps newly created pedidos ordered correctly.
 */
export const PEDIDO_NUMERO_WIDTH = 6;

/** Doc id of the global pedido sequence in the `counters` collection. */
export const PEDIDO_COUNTER_DOC_ID = 'pedido';

/** Prefix used when a pedido has no operação to derive one from. */
export const PEDIDO_NUMERO_NO_OPERACAO_PREFIX = 'NUL';

/**
 * Derive the `numero` prefix from an operação name: its first 3 letters,
 * uppercased. This namespaces UI-created pedido numbers away from numbers that
 * come from other channels (marketplaces), which would otherwise collide with a
 * bare sequence. Falls back to {@link PEDIDO_NUMERO_NO_OPERACAO_PREFIX} when the
 * pedido has no operação (or an empty name).
 */
export function operacaoNumeroPrefix(nome: string | null | undefined): string {
  const cleaned = (nome ?? '').trim();
  if (!cleaned) return PEDIDO_NUMERO_NO_OPERACAO_PREFIX;
  return cleaned.slice(0, 3).toUpperCase();
}

/** Compose a pedido `numero` from its operação prefix and sequence value. */
export function formatPedidoNumero(prefix: string, value: number): string {
  return `${prefix}-${String(value).padStart(PEDIDO_NUMERO_WIDTH, '0')}`;
}

/**
 * Create a pedido with an auto-assigned, human-readable, unique `numero` of the
 * form `<PREFIX>-<seq>` (e.g. `VEN-000042`), where `PREFIX` is the operação's
 * first 3 letters (or `NUL` when there's no operação) and `seq` is a zero-padded
 * global sequence.
 *
 * The pedido id is minted client-side (`newDocId`) so the counter bump and the
 * pedido write share a single `runTransaction`: read the global counter doc,
 * increment it, and write both the counter and the pedido atomically. This is
 * the browser equivalent of the NF-e numeração counter
 * (`packages/integrations/nfe/src/numeracao/`) — gap-free and unique even under
 * concurrent creates, at the minimum cost of one extra read + one extra write.
 * (The operação is read once, outside the transaction, only to derive the
 * prefix — it never affects the sequence value.)
 *
 * The transaction retries automatically on contention; if it ultimately fails
 * it throws, so a pedido is never created without a `numero`.
 *
 * @returns the new pedido's Firestore doc id.
 */
export async function createPedidoWithNumero(db: Firestore, values: Pedido): Promise<string> {
  const prefix = await resolveOperacaoPrefix(db, values.operacaoPedidoOuterRef);
  const pedidoId = newDocId();
  await runTransaction(db, async (tx) => {
    const counterRef = counterCollection.docRef(db, {}, PEDIDO_COUNTER_DOC_ID);
    // Reads must precede writes in a Firestore transaction.
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? (snap.data()?.value ?? 0) : 0;
    const next = current + 1;
    tx.set(counterRef, { value: next });
    tx.set(pedidoCollection.docRef(db, {}, pedidoId), {
      ...values,
      numero: formatPedidoNumero(prefix, next),
    });
  });
  return pedidoId;
}

/**
 * Resolve the operação prefix from the pedido's `operacaoPedidoOuterRef`. Reads
 * the operação doc (a legacy outer-ref, so via the generic dereference) to get
 * its `nome`. Returns the no-operação sentinel when there's no ref or the doc is
 * missing; a read failure (FirebaseError) propagates so the create surfaces it
 * rather than silently mislabeling the pedido.
 */
async function resolveOperacaoPrefix(db: Firestore, operacaoRef: unknown): Promise<string> {
  const ref = dereferenceOuterRef(db, operacaoRef);
  if (ref == null) return PEDIDO_NUMERO_NO_OPERACAO_PREFIX;
  const snap = await getDoc(ref);
  const nome = snap.exists() ? (snap.data() as { nome?: unknown }).nome : null;
  return operacaoNumeroPrefix(typeof nome === 'string' ? nome : null);
}
