import type { Firestore } from 'firebase-admin/firestore';
import {
  whatsappVinculoCollection,
  whatsappVinculoMensagemCollection,
} from '@delfrance/data/admin/collections';
import { RETENCAO_VINCULO_WHATSAPP_DIAS, expiraEmApos } from '@delfrance/schemas';
import { WhatsappVinculoConflitoError } from './contatos';
import {
  processMessagesField,
  type ProcessOutcome,
  type WhatsappProcessDeps,
} from './processMessages';

/** Resumable replay: each retained message is acknowledged only after all inbound effects complete. */
export async function replayVinculoWhatsapp(
  db: Firestore,
  id: string,
  deps: WhatsappProcessDeps,
  redriveSource: (id: string) => Promise<unknown>,
): Promise<ProcessOutcome> {
  const root = whatsappVinculoCollection.docRef(db, {}, id);
  const initial = await root.get();
  if (!initial.exists) return { kind: 'failed', reason: 'Pendência de vínculo não encontrada.' };
  const binding = whatsappVinculoCollection.parseRead(initial.data());
  if (!binding.clienteId || !binding.conversaId)
    return { kind: 'parked', reason: 'Aguardando decisão de vínculo.' };
  for (;;) {
    const batch = await whatsappVinculoMensagemCollection
      .ref(db, { vinculoId: id })
      .where('processada', '==', false)
      .orderBy('timestamp')
      .orderBy('__name__')
      .limit(50)
      .get();
    if (batch.empty) break;
    for (const doc of batch.docs) {
      const stored = whatsappVinculoMensagemCollection.parseRead(doc.data());
      let recovered = false;
      let reason = 'Falha ao recuperar mensagens. O conteúdo foi preservado; tente novamente.';
      try {
        const result = await processMessagesField(
          db,
          stored.value,
          deps,
          stored.sourceNotificationId,
          { vinculoId: id, revision: binding.revision },
        );
        if (result.kind !== 'processed' || (result.mensagens?.malformados ?? 0) > 0) {
          reason =
            result.kind === 'processed' ? 'Mensagem ilegível; conteúdo preservado.' : result.reason;
          return { kind: 'failed', reason };
        }
        // The original full change may still contain siblings from another contact.
        if (stored.sourceNotificationId) await redriveSource(stored.sourceNotificationId);
        // The provider redrive can race a new human decision. Acknowledge only
        // the same binding whose authority was used to recover this message.
        await db.runTransaction(async (tx) => {
          const current = await tx.get(root);
          const child = whatsappVinculoMensagemCollection.docRef(db, { vinculoId: id }, doc.id);
          const retained = await tx.get(child);
          if (
            !current.exists ||
            current.data()?.revision !== binding.revision ||
            current.data()?.clienteId !== binding.clienteId ||
            current.data()?.conversaId !== binding.conversaId ||
            current.data()?.integracaoId !== binding.integracaoId ||
            !binding.decididoPor ||
            current.data()?.decididoPor !== binding.decididoPor ||
            !retained.exists
          )
            throw new WhatsappVinculoConflitoError(
              'A decisão de vínculo mudou durante a recuperação. Revise o contato.',
            );
          // The copy is redundant from here on (the message is in the chat), so
          // the same write starts its TTL clock — see `expiraEm` in the schema.
          if (retained.data()?.processada !== true)
            tx.update(child, {
              processada: true,
              expiraEm: expiraEmApos(Date.now(), RETENCAO_VINCULO_WHATSAPP_DIAS),
            });
        });
        recovered = true;
      } finally {
        if (!recovered) {
          await db.runTransaction(async (tx) => {
            const current = await tx.get(root);
            const remaining = await tx.get(
              whatsappVinculoMensagemCollection
                .ref(db, { vinculoId: id })
                .where('processada', '==', false)
                .limit(1),
            );
            if (
              current.exists &&
              current.data()?.clienteId === binding.clienteId &&
              current.data()?.revision === binding.revision &&
              !remaining.empty
            ) {
              tx.update(root, { estado: 'erro', motivo: reason });
            }
          });
        }
      }
    }
  }
  await db.runTransaction(async (tx) => {
    const current = await tx.get(root);
    const remaining = await tx.get(
      whatsappVinculoMensagemCollection
        .ref(db, { vinculoId: id })
        .where('processada', '==', false)
        .limit(1),
    );
    if (
      current.exists &&
      current.data()?.clienteId === binding.clienteId &&
      current.data()?.revision === binding.revision &&
      remaining.empty
    ) {
      tx.update(root, { estado: 'resolvido', motivo: 'Mensagens recuperadas.' });
    }
  });
  return {
    kind: 'processed',
    contaId: binding.integracaoId,
    detail: 'mensagens',
    mensagens: { malformados: 0 },
    statuses: null,
  };
}
