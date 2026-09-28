import { getDoc, type Firestore } from 'firebase/firestore';
import type { Pedido } from '@delfrance/schemas';
import { criarPedidoComNumero, type PedidoEnderecoCopyPlan } from '@delfrance/data/pedido';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { createClientPedidoPort } from './clientPort';
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
 * The shared `criarPedidoComNumero` domain use-case mints the id and commits the
 * counter bump, pedido and optional confirmed address copies in one transaction.
 * This wrapper keeps only the web concerns: resolving the operação name and
 * marking the pedido as human-authored.
 *
 * The transaction retries automatically on contention; if it ultimately fails
 * it throws, so a pedido is never created without a `numero`.
 *
 * @returns the new pedido's Firestore doc id + its minted `numero`.
 */
export async function createPedidoWithNumero(
  db: Firestore,
  values: Pedido,
  enderecoCopyPlan?: PedidoEnderecoCopyPlan | null,
): Promise<{ id: string; numero: string }> {
  const nome = await resolveOperacaoNome(db, values.operacaoPedidoOuterRef);
  // Operation lookup and the human-interaction marker remain web concerns; the
  // counter + pedido + optional address copies are committed by the shared
  // domain transaction.
  return criarPedidoComNumero(createClientPedidoPort(db), {
    values: marcarInteracaoDoUsuario(values),
    operacaoNome: nome,
    enderecoCopyPlan,
  });
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
