import { runTransaction, type Firestore } from 'firebase/firestore';
import {
  extractMensagemArquivoIds,
  idFromRef,
  mesmoDestinoWhatsapp,
  ORIGEM_CONVERSA,
  type Conversa,
  type Mensagem,
} from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';
import { conversaCollection, mensagemCollection } from '@/lib/data/conversaCollection';

export class WhatsappDestinoAlteradoError extends Error {
  constructor() {
    super(
      'O destinatário do WhatsApp foi alterado. Confira o contato e envie novamente. Seu rascunho foi preservado.',
    );
    this.name = 'WhatsappDestinoAlteradoError';
  }
}

export class WhatsappArquivoIndisponivelError extends Error {
  constructor() {
    super(
      'O anexo não está mais disponível. Anexe o arquivo novamente e reenvie; seu texto foi preservado.',
    );
    this.name = 'WhatsappArquivoIndisponivelError';
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

    // Tier 1 by Firestore OCC: every referenced arquivo anchor joins the
    // transaction read set before any mensagem is written. The orphan sweep's
    // final delete writes that same doc. Whichever wins forces the other side to
    // retry/re-evaluate, so a mensagem can never commit with a dangling ref.
    const arquivoIds = new Set<string>();
    for (const message of messages) {
      for (const id of extractMensagemArquivoIds(message.data)) arquivoIds.add(id);
    }
    const arquivoSnaps = await Promise.all(
      [...arquivoIds].map((id) => tx.get(arquivoCollection.docRef(db, {}, id))),
    );
    if (arquivoSnaps.some((snap) => !snap.exists())) {
      throw new WhatsappArquivoIndisponivelError();
    }

    for (const message of messages)
      tx.set(mensagemCollection.docRef(db, { conversaId }, message.id), {
        ...message.data,
        whatsappDestino: expected.whatsappDestino ?? null,
        whatsappIntegracaoId: expectedIntegration,
      });
  });
}
