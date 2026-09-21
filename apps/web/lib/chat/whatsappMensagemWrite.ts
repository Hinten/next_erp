import { runTransaction, type Firestore } from 'firebase/firestore';
import {
  idFromRef,
  mesmoDestinoWhatsapp,
  ORIGEM_CONVERSA,
  type Conversa,
  type Mensagem,
} from '@delfrance/schemas';
import { conversaCollection, mensagemCollection } from '@/lib/data/conversaCollection';

export class WhatsappDestinoAlteradoError extends Error {
  constructor() {
    super(
      'O destinatário do WhatsApp foi alterado. Confira o contato e envie novamente. Seu rascunho foi preservado.',
    );
    this.name = 'WhatsappDestinoAlteradoError';
  }
}

/** Current transaction read is binding: an identity/integration change rejects the whole send. */
export async function persistWhatsappMensagens(
  db: Firestore,
  conversaId: string,
  expected: Conversa,
  messages: ReadonlyArray<{ id: string; data: Mensagem }>,
): Promise<void> {
  const expectedIntegration = expected.integracaoOuterRef
    ? idFromRef(expected.integracaoOuterRef)
    : null;
  await runTransaction(db, async (tx) => {
    const snapshot = await tx.get(conversaCollection.docRef(db, {}, conversaId));
    const current = snapshot.data();
    const currentIntegration = current?.integracaoOuterRef
      ? idFromRef(current.integracaoOuterRef)
      : null;
    if (
      !current ||
      current.origem !== ORIGEM_CONVERSA.whatsapp ||
      !expectedIntegration ||
      currentIntegration !== expectedIntegration ||
      !mesmoDestinoWhatsapp(current.whatsappDestino, expected.whatsappDestino)
    ) {
      throw new WhatsappDestinoAlteradoError();
    }
    for (const message of messages)
      tx.set(mensagemCollection.docRef(db, { conversaId }, message.id), {
        ...message.data,
        whatsappDestino: expected.whatsappDestino ?? null,
        whatsappIntegracaoId: expectedIntegration,
      });
  });
}
