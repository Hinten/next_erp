/**
 * The PROVISIONAL outbound bubble, and how it stops being a duplicate.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * ML mints the id of a message we send and does **not** return it on the POST.
 * So between "ML accepted our reply" and "the `messages`/`claims` notification
 * brings it back with its real id" there is a gap — seconds usually, minutes
 * when the queue is behind — during which the thread would show nothing at all.
 * The composer clears the operator's text on success, so that gap is not merely
 * cosmetic: an operator who reloads sees no trace of what they just sent and
 * sends it again. Messaging a customer twice is the failure this bubble exists
 * to prevent, which is why it is a real Firestore document and not a React-only
 * optimistic row.
 *
 * ── Why it has to be cleaned up ──────────────────────────────────────────────
 * ⚠️ The importer writes EVERY message in the thread, ours included, at its ML
 * id. Nothing linked that doc to this one, so the reply stayed in the thread
 * **twice, permanently** — once provisionally, once for real. The bubble is a
 * placeholder with an expiry, and this module is the expiry.
 *
 * ⚠️ The id is unique per send (`local-<ms>`), NOT bucketed. It used to be
 * `local-<pack>-<minute>`, which meant two replies inside the same minute
 * collided on one doc id and the first was silently overwritten — normal
 * behaviour in a chat, and it lost a message the customer had already received.
 */
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { mensagemCollection } from '@delfrance/data/admin/collections';

/**
 * Doc-id prefix for a provisional bubble. Load-bearing: it is what makes the
 * cleanup a bounded id-range scan instead of a field the schema would have to
 * carry (`mensagemSchema` has no `.passthrough()`).
 */
export const PREFIXO_PROVISORIA = 'local-';

/** The end of the `local-` prefix range — `'local-'` with its last char bumped. */
const FIM_DO_PREFIXO = 'local.';

/**
 * A unique id for one provisional outbound bubble.
 *
 * Millisecond granularity, and one HTTP request reads the clock once, so two
 * distinct sends cannot share an id in any realistic ordering.
 */
export function makeMensagemProvisoriaId(nowMs: number): string {
  return `${PREFIXO_PROVISORIA}${nowMs}`;
}

/**
 * Drop the provisional bubbles the freshly-imported messages have superseded.
 *
 * `ateMs` is the newest timestamp in the import. Only bubbles at or before it
 * are removed: a reply sent AFTER the snapshot ML just handed us has not come
 * back yet, and deleting it would reopen the very gap the bubble covers.
 *
 * Best-effort by design — a failure here must not fail the import, which has
 * already written the real messages. The duplicate simply survives to the next
 * notification, which will try again.
 */
export async function limparMensagensProvisorias(
  db: Firestore,
  conversaId: string,
  ateMs: number | null,
): Promise<number> {
  if (ateMs == null) return 0;

  const snap = await mensagemCollection
    .ref(db, { conversaId })
    .where(FieldPath.documentId(), '>=', PREFIXO_PROVISORIA)
    .where(FieldPath.documentId(), '<', FIM_DO_PREFIXO)
    .get();

  const vencidas = snap.docs.filter((d) => {
    const ts = (d.data() as { timestamp?: unknown }).timestamp;
    return typeof ts === 'number' && ts <= ateMs;
  });
  if (vencidas.length === 0) return 0;

  await Promise.all(vencidas.map((d) => d.ref.delete()));
  return vencidas.length;
}
