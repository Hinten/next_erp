import { type WriteBatch } from 'firebase/firestore';
import { ESTADO_ENVIO } from '@delfrance/schemas';
import { mensagemCollection } from '@/lib/data/conversaCollection';
import { newDocId } from '@/lib/data/newDocId';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Append a lifecycle EVENT mensagem (`tipo: 'e'`) for a conversa to a batch —
 * the shared write used by the bulk-actions bar (estado/etiqueta events) and
 * the composer's "Entrar na conversa" gate. An event is `estadoEnvio: salva`
 * with `mid: null` for pipeline-shape consistency, but the `tipo: 'e'` clause
 * keeps it out of the #529 outbound sender (which sends only `tipo` not in
 * `{'e','!'}`). `user_id` is `null`: an event is authored by the system, not a
 * chat participant (legacy `Mensagem.evento` carried no user).
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
): void {
  const eventId = newDocId();
  batch.set(mensagemCollection.docRef(db, { conversaId }, eventId), {
    tipo: 'e',
    estadoEnvio: ESTADO_ENVIO.salva,
    conteudo,
    mid: null,
    canal: 0,
    user_id: null,
    resposta: null,
    usarioMensagemOuterRef: null,
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
