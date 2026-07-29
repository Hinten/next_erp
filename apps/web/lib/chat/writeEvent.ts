import { type WriteBatch } from 'firebase/firestore';
import { TIPO_MENSAGEM, ESTADO_ENVIO } from '@delfrance/schemas';
import { mensagemCollection } from '@/lib/data/conversaCollection';
import { newDocId } from '@/lib/data/newDocId';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Append a lifecycle EVENT mensagem (`tipo: 'e'`) for a conversa to a batch —
 * the shared write used by the bulk-actions bar (estado/etiqueta events), the
 * conversa-actions menu (leave/finish/rename/etiqueta/transfer/include), and the
 * composer's "Entrar na conversa" gate. An event is `estadoEnvio: salva` with
 * `mid: null` for pipeline-shape consistency, but the `tipo: 'e'` clause keeps
 * it out of the #529 outbound sender (which sends only `tipo` not in `{'e','!'}`).
 *
 * The optional `actor` records who authored the event, matching legacy exactly:
 * `Mensagem.evento` carries a `usarioMensagemOuterRef` only when a `Usuario` is
 * passed (the participant-authored `sairDaConversa` / `encerrarConversa(user)` /
 * `renomearConversa(user)` / `alterarCorConversa(user)` and the bulk
 * `alterarEstado/CorConversa`), and stays anonymous for the system events plus
 * `entrar` / `incluir` (which pass no user in the legacy provider). When `actor`
 * is omitted the event is system-authored: `user_id` and `usarioMensagemOuterRef`
 * are both `null`. When present, `user_id: actor.uid` and
 * `usarioMensagemOuterRef: 'documents/usuarios/<uid>'` (the same ref format the
 * mensagem/checkout writers use).
 *
 * Kept as a batch-append (not a standalone write) so the caller can commit it
 * atomically alongside its conversa patch.
 */
export function writeEvent(
  batch: WriteBatch,
  db: ReturnType<typeof getFirebaseFirestore>,
  conversaId: string,
  conteudo: string,
  now: number,
  actor?: { uid: string } | null,
): void {
  const eventId = newDocId();
  batch.set(mensagemCollection.docRef(db, { conversaId }, eventId), {
    tipo: TIPO_MENSAGEM.evento,
    estadoEnvio: ESTADO_ENVIO.salva,
    conteudo,
    mid: null,
    canal: 0,
    user_id: actor?.uid ?? null,
    resposta: null,
    usarioMensagemOuterRef: actor ? `documents/usuarios/${actor.uid}` : null,
    urlAvatar: null,
    midGroup: null,
    error: null,
    visualizado: null,
    transcription: null,
    anexo: null,
    anexo_url: null,
    timestamp: now,
    data_cadastro: now,
  });
}
