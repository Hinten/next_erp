import { z } from 'zod';
import { telefoneQueryShapes } from '@delfrance/core/phone';
import type { Firestore } from 'firebase-admin/firestore';
import {
  arquivoCollection,
  clienteCollection,
  conversaCollection,
  whatsappConversaCollection,
  integracaoCollection,
  whatsappIdentidadeCollection,
  whatsappVinculoCollection,
  whatsappVinculoMensagemCollection,
} from '@delfrance/data/admin/collections';
import {
  clienteSchema,
  INTEGRACAO_TIPO,
  ORIGEM_CONVERSA,
  toOuterRefOrNull,
  whatsappConversaSchema,
  whatsappVinculoPrevisaoSchema,
  type WhatsappVinculoPrevisao,
  refineClienteTipoDocumento,
  whatsappVinculoResumoSchema,
  idFromRef,
  type WhatsappVinculoResumo,
} from '@delfrance/schemas';
import type {
  valuePayloadSchema,
  IncomingMessage,
} from '@delfrance/integrations-whatsapp-cloud-api';
import { mensagemDocId, sha256Hex } from './ids';
import {
  identidadesDoContato,
  conversaWhatsappKey,
  prepararConversa,
  telefoneAtual,
  vinculoWhatsappId,
  WhatsappVinculoConflitoError,
  type ContatoWhatsapp,
} from './contatos';
import { getAndUploadMedia, type MediaCacheContext } from './media';

type ValuePayload = ReturnType<typeof valuePayloadSchema.parse>;

export const confirmarVinculoSchema = z.object({
  requestId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative(),
  choice: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('existing'),
      clienteId: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^/]+$/),
    }),
    z.object({
      kind: z.literal('create'),
      cliente: clienteSchema
        .pick({
          nome: true,
          tipo: true,
          cpf_cnpj: true,
          idEstrangeiro: true,
          ie: true,
          email: true,
          telefone: true,
          telefonesAdicionais: true,
        })
        .extend({ nome: z.string().trim().min(1).max(255) })
        .superRefine(refineClienteTipoDocumento),
    }),
  ]),
});
export type ConfirmarVinculo = z.infer<typeof confirmarVinculoSchema>;

/** Cache bytes before parking: provider media links expire while a human identifies the contact. */
export async function guardarContatoPendente(
  db: Firestore,
  contato: ContatoWhatsapp,
  motivo: string,
  value: ValuePayload,
  message: IncomingMessage,
  mediaContext: () => Promise<MediaCacheContext>,
  sourceNotificationId: string | null,
): Promise<string> {
  const id = vinculoWhatsappId(contato);
  const messageId = mensagemDocId(contato.integracaoId, message.id);
  const media =
    message.image ?? message.video ?? message.audio ?? message.document ?? message.sticker;
  const arquivoRef = media ? await getAndUploadMedia(await mediaContext(), media.id) : null;
  const ref = whatsappVinculoCollection.docRef(db, {}, id);
  const messageRef = whatsappVinculoMensagemCollection.docRef(db, { vinculoId: id }, messageId);
  await db.runTransaction(async (tx) => {
    const old = await tx.get(ref);
    const oldMessage = await tx.get(messageRef);
    const conta = await tx.get(integracaoCollection.docRef(db, {}, contato.integracaoId));
    if (oldMessage.exists) return;
    const data = old.exists ? whatsappVinculoCollection.parseRead(old.data()) : null;
    const newest = !data || contato.timestamp >= data.ultimaMensagemEm;
    const currentIdentity = newest ? contato : data;
    const identityChanged =
      data != null &&
      newest &&
      (data.portfolioId !== contato.portfolioId ||
        data.bsuid !== contato.bsuid ||
        data.telefone !== contato.telefone);
    const reopened = data?.estado === 'resolvido' || (identityChanged && data?.clienteId != null);
    tx.set(
      ref,
      whatsappVinculoCollection.parse({
        ...data,
        id,
        integracaoId: contato.integracaoId,
        integracaoNome: String(conta.data()?.nome ?? contato.integracaoId),
        portfolioId: currentIdentity.portfolioId,
        bsuid: currentIdentity.bsuid,
        telefone: currentIdentity.telefone,
        nome: contato.nome ?? data?.nome ?? null,
        motivo,
        ultimaMensagemEm: Math.max(data?.ultimaMensagemEm ?? 0, contato.timestamp),
        ultimaMensagemClienteEm:
          message.type === 'system'
            ? (data?.ultimaMensagemClienteEm ?? null)
            : Math.max(data?.ultimaMensagemClienteEm ?? 0, contato.timestamp),
        quantidadeMensagens: (data?.quantidadeMensagens ?? 0) + 1,
        revision: (data?.revision ?? 0) + (reopened || identityChanged ? 1 : 0),
        estado: reopened ? 'aguardando' : (data?.estado ?? 'aguardando'),
        clienteId: reopened ? null : (data?.clienteId ?? null),
        conversaId: reopened ? null : (data?.conversaId ?? null),
        requestId: reopened ? null : (data?.requestId ?? null),
        requestFingerprint: reopened ? null : (data?.requestFingerprint ?? null),
        decididoPor: reopened ? null : (data?.decididoPor ?? null),
      }),
    );
    tx.create(
      messageRef,
      whatsappVinculoMensagemCollection.parse({
        value: JSON.parse(JSON.stringify({ ...value, messages: [message], statuses: undefined })),
        sourceNotificationId,
        timestamp: contato.timestamp,
        conteudo: message.text?.body ?? media?.caption ?? message.system?.body ?? null,
        arquivoId: arquivoRef ? idFromRef(arquivoRef) : null,
        anexoTipo: media ? message.type : null,
        processada: false,
      }),
    );
  });
  return id;
}

export async function confirmarVinculoWhatsapp(
  db: Firestore,
  id: string,
  input: ConfirmarVinculo,
  uid: string,
) {
  const requestFingerprint = sha256Hex(JSON.stringify(input.choice));
  return db.runTransaction(async (tx) => {
    const ref = whatsappVinculoCollection.docRef(db, {}, id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new WhatsappVinculoConflitoError('Contato não encontrado.');
    const pending = whatsappVinculoCollection.parseRead(snap.data());
    if (pending.clienteId && pending.conversaId) {
      if (
        (pending.requestId === input.requestId &&
          pending.requestFingerprint === requestFingerprint) ||
        (input.choice.kind === 'existing' && pending.clienteId === input.choice.clienteId)
      ) {
        return {
          clienteId: pending.clienteId,
          conversaId: pending.conversaId,
          replayPending: pending.estado !== 'resolvido',
        };
      }
      throw new WhatsappVinculoConflitoError(
        'Outro operador já vinculou este contato.',
        pending.clienteId,
        pending.conversaId,
      );
    }
    if (pending.revision !== input.revision)
      throw new WhatsappVinculoConflitoError('O contato mudou. Revise os dados antes de vincular.');
    const contaSnap = await tx.get(integracaoCollection.docRef(db, {}, pending.integracaoId));
    if (!contaSnap.exists) throw new WhatsappVinculoConflitoError('Integração não encontrada.');
    const conta = integracaoCollection.parseRead(contaSnap.data());
    const contato: ContatoWhatsapp = {
      integracaoId: pending.integracaoId,
      portfolioId: conta.portfolioId,
      bsuid: pending.bsuid,
      telefone: pending.telefone,
      nome: pending.nome,
      timestamp: pending.ultimaMensagemEm,
    };
    if (contato.bsuid && !contato.portfolioId)
      throw new WhatsappVinculoConflitoError(
        'Configure o ID do portfólio empresarial na integração.',
      );
    if (contato.bsuid && pending.portfolioId != null && pending.portfolioId !== conta.portfolioId)
      throw new WhatsappVinculoConflitoError(
        'O portfólio empresarial mudou. Reprocesse o contato e revise a identificação.',
      );
    const specs = identidadesDoContato(contato);
    if (!specs.length) throw new WhatsappVinculoConflitoError('Contato sem identidade utilizável.');
    const identities = await Promise.all(
      specs.map((spec) => tx.get(whatsappIdentidadeCollection.docRef(db, {}, spec.id))),
    );
    const clienteId =
      input.choice.kind === 'existing'
        ? input.choice.clienteId
        : sha256Hex(JSON.stringify(['whatsapp-cliente', id, input.requestId]));
    const clienteRef = clienteCollection.docRef(db, {}, clienteId);
    const existing = await tx.get(clienteRef);
    if (input.choice.kind === 'existing' && !existing.exists)
      throw new WhatsappVinculoConflitoError('Cliente não encontrado.');
    if (input.choice.kind === 'create') {
      for (const key of ['cpf_cnpj', 'idEstrangeiro'] as const) {
        const value = input.choice.cliente[key];
        if (value) {
          const duplicates = await tx.get(
            clienteCollection.ref(db, {}).where(key, '==', value).limit(1),
          );
          if (!duplicates.empty)
            throw new WhatsappVinculoConflitoError(
              'Já existe um cliente com este documento. Selecione o cadastro existente.',
              duplicates.docs[0]!.id,
            );
        }
      }
    }
    const previousIdentities = identities.map((snapshot) =>
      snapshot.exists ? whatsappIdentidadeCollection.parseRead(snapshot.data()) : null,
    );
    const strong = previousIdentities.find(
      (identity, i) =>
        specs[i]?.tipo === 'bsuid' && identity?.ativa && identity.clienteId === clienteId,
    );
    const ignoredPhones = new Set(
      strong
        ? specs
            .filter(
              (spec, i) =>
                spec.tipo === 'telefone' &&
                previousIdentities[i]?.ativa &&
                previousIdentities[i]?.clienteId !== clienteId,
            )
            .map((spec) => spec.id)
        : [],
    );
    const conflicting = previousIdentities.find(
      (identity, i) =>
        identity?.ativa && identity.clienteId !== clienteId && !ignoredPhones.has(specs[i]!.id),
    );
    if (conflicting) {
      const ownerClaim = await tx.get(
        whatsappConversaCollection.docRef(
          db,
          {},
          conversaWhatsappKey(pending.integracaoId, conflicting.clienteId),
        ),
      );
      throw new WhatsappVinculoConflitoError(
        'A identidade já está vinculada a outro cliente. Selecione o cliente do BSUID; o telefone conflitante pode ser desconsiderado sem transferi-lo.',
        conflicting.clienteId,
        ownerClaim.exists ? String(ownerClaim.data()?.conversaId) : null,
      );
    }
    const retiredReplay = previousIdentities.map(
      (identity) =>
        identity?.ativa === false &&
        identity.clienteId === clienteId &&
        (identity.ultimaTransicaoEm ?? -Infinity) >= pending.ultimaMensagemEm,
    );
    const cliente =
      input.choice.kind === 'create'
        ? clienteCollection.parse({
            ...input.choice.cliente,
            telefoneGerenciado: true,
            timestamp: Date.now(),
            ultimaModificacao: Date.now(),
          })
        : clienteCollection.parseRead(existing.data());
    const prepared = await prepararConversa(
      tx,
      db,
      contato,
      clienteId,
      cliente.nome ?? pending.nome ?? 'Cliente',
      conta,
      specs[0]!,
      !retiredReplay[0],
      { ultimaMensagemEm: pending.ultimaMensagemClienteEm },
    );
    // Client creation, identity claims and canonical conversation commit together.
    if (!existing.exists) tx.create(clienteRef, cliente);
    specs.forEach((spec, i) => {
      // Reviewing a retired primary recovers its history; it is not fresh proof
      // that any secondary telephone belongs to this customer.
      if (retiredReplay[0] || ignoredPhones.has(spec.id) || retiredReplay[i]) return;
      tx.set(
        whatsappIdentidadeCollection.docRef(db, {}, spec.id),
        whatsappIdentidadeCollection.parse({
          escopo: spec.escopo,
          tipo: spec.tipo,
          valor: spec.valor,
          clienteId,
          ativa: true,
          sucessoraId: null,
          confirmadaManualmente: true,
          aliasesTelefoneIgnorados:
            spec.tipo === 'bsuid'
              ? [
                  ...new Set([
                    ...(previousIdentities[i]?.aliasesTelefoneIgnorados ?? []),
                    ...ignoredPhones,
                  ]),
                ]
              : [],
          ultimaTransicaoEm: previousIdentities[i]?.ultimaTransicaoEm ?? null,
          telefoneClienteNoVinculo: telefoneAtual(cliente),
        }),
      );
    });
    prepared.write();
    tx.update(ref, {
      clienteId,
      conversaId: prepared.conversaId,
      estado: 'recuperando',
      revision: pending.revision + 1,
      requestId: input.requestId,
      requestFingerprint,
      decididoPor: uid,
      portfolioId: conta.portfolioId,
    });
    return { clienteId, conversaId: prepared.conversaId, replayPending: true };
  });
}

export async function listarVinculosWhatsapp(
  db: Firestore,
  options: { integracaoId?: string; cursor?: string; limit?: number } = {},
) {
  let query = whatsappVinculoCollection
    .ref(db, {})
    .where('estado', 'in', ['aguardando', 'recuperando', 'erro']);
  if (options.integracaoId) query = query.where('integracaoId', '==', options.integracaoId);
  query = query.orderBy('ultimaMensagemEm', 'desc').orderBy('__name__');
  if (options.cursor) {
    const cursor = await whatsappVinculoCollection.docRef(db, {}, options.cursor).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  const snap = await query.limit(limit + 1).get();
  const items = snap.docs
    .slice(0, limit)
    .map((doc) => whatsappVinculoResumoSchema.parse({ ...doc.data(), id: doc.id }));
  return { items, nextCursor: snap.size > limit ? items.at(-1)!.id : null };
}

export async function detalheVinculoWhatsapp(db: Firestore, id: string, cursor?: string) {
  const snap = await whatsappVinculoCollection.docRef(db, {}, id).get();
  if (!snap.exists) return null;
  const pendencia: WhatsappVinculoResumo = whatsappVinculoResumoSchema.parse({
    ...snap.data(),
    id,
  });
  let query = whatsappVinculoMensagemCollection
    .ref(db, { vinculoId: id })
    .orderBy('timestamp')
    .orderBy('__name__');
  if (cursor) {
    const last = await whatsappVinculoMensagemCollection
      .docRef(db, { vinculoId: id }, cursor)
      .get();
    if (last.exists) query = query.startAfter(last);
  }
  const messages = await query.limit(51).get();
  const mapped = await Promise.all(
    messages.docs.slice(0, 50).map(async (doc) => {
      const data = whatsappVinculoMensagemCollection.parseRead(doc.data());
      const arquivo = data.arquivoId
        ? await arquivoCollection.docRef(db, {}, data.arquivoId).get()
        : null;
      return {
        id: doc.id,
        timestamp: data.timestamp,
        conteudo: data.conteudo,
        anexoTipo: data.anexoTipo,
        anexoUrl: typeof arquivo?.data()?.url === 'string' ? String(arquivo.data()!.url) : null,
      };
    }),
  );
  const candidates = pendencia.telefone
    ? await clienteCollection
        .ref(db, {})
        .where('telefone', 'in', telefoneQueryShapes('+' + pendencia.telefone))
        .limit(20)
        .get()
    : null;
  return {
    pendencia,
    messages: mapped,
    nextCursor: messages.size > 50 ? mapped.at(-1)!.id : null,
    candidates:
      candidates?.docs.map((doc) => {
        const cliente = clienteCollection.parseRead(doc.data());
        return {
          id: doc.id,
          nome: cliente.nome,
          cpf_cnpj: cliente.cpf_cnpj,
          telefone: cliente.telefone,
          email: cliente.email,
        };
      }) ?? [],
  };
}

/**
 * Read-only preview. Confirmation re-reads every binding inside its transaction;
 * this projection never reserves a chat or identifies a contact.
 */
export async function preverVinculoWhatsapp(
  db: Firestore,
  pendenciaId: string,
  clienteId: string,
): Promise<WhatsappVinculoPrevisao | null> {
  const pendingSnap = await whatsappVinculoCollection.docRef(db, {}, pendenciaId).get();
  if (!pendingSnap.exists) return null;
  const pending = whatsappVinculoCollection.parseRead(pendingSnap.data());
  const [accountSnap, clienteSnap, claimSnap] = await Promise.all([
    integracaoCollection.docRef(db, {}, pending.integracaoId).get(),
    clienteCollection.docRef(db, {}, clienteId).get(),
    whatsappConversaCollection
      .docRef(db, {}, conversaWhatsappKey(pending.integracaoId, clienteId))
      .get(),
  ]);
  if (
    !accountSnap.exists ||
    accountSnap.data()?.tipo !== INTEGRACAO_TIPO.whatsapp ||
    !clienteSnap.exists
  )
    return null;

  let conversaId: string | null = null;
  if (claimSnap.exists) {
    const claim = whatsappConversaSchema.safeParse(claimSnap.data());
    if (
      !claim.success ||
      claim.data.integracaoId !== pending.integracaoId ||
      claim.data.clienteId !== clienteId ||
      !claim.data.conversaId ||
      claim.data.conversaId.includes('/')
    )
      throw new WhatsappVinculoConflitoError(
        'A associação da conversa está inconsistente. Revise o vínculo antes de continuar.',
      );
    const chatSnap = await conversaCollection.docRef(db, {}, claim.data.conversaId).get();
    const chat = chatSnap.data();
    if (
      !chatSnap.exists ||
      chat?.origem !== ORIGEM_CONVERSA.whatsapp ||
      toOuterRefOrNull(chat.clienteOuterRef) !==
        toOuterRefOrNull(clienteCollection.docPath({}, clienteId)) ||
      toOuterRefOrNull(chat.integracaoOuterRef) !==
        toOuterRefOrNull(integracaoCollection.docPath({}, pending.integracaoId))
    )
      throw new WhatsappVinculoConflitoError(
        'A conversa reservada não corresponde ao cliente e à integração. Revise o vínculo.',
      );
    conversaId = claim.data.conversaId;
  } else {
    const expectedId = sha256Hex(JSON.stringify(['whatsapp', pending.integracaoId, clienteId]));
    const orphan = await conversaCollection.docRef(db, {}, expectedId).get();
    if (orphan.exists)
      throw new WhatsappVinculoConflitoError(
        'Existe uma conversa sem associação canônica. Revise o vínculo antes de continuar.',
      );
  }
  const account = integracaoCollection.parseRead(accountSnap.data());
  const previewIdentities = identidadesDoContato({
    integracaoId: pending.integracaoId,
    portfolioId: account.portfolioId,
    bsuid: pending.bsuid,
    telefone: pending.telefone,
    nome: pending.nome,
    timestamp: pending.ultimaMensagemEm,
  });
  const identitySnaps = await Promise.all(
    previewIdentities.map((spec) => whatsappIdentidadeCollection.docRef(db, {}, spec.id).get()),
  );
  const identityData = identitySnaps.map((snapshot) =>
    snapshot.exists ? whatsappIdentidadeCollection.parseRead(snapshot.data()) : null,
  );
  const strong = identityData.find(
    (identity, i) => previewIdentities[i]?.tipo === 'bsuid' && identity?.ativa,
  );
  if (strong && strong.clienteId !== clienteId) {
    const owner = await whatsappConversaCollection
      .docRef(db, {}, conversaWhatsappKey(pending.integracaoId, strong.clienteId))
      .get();
    throw new WhatsappVinculoConflitoError(
      'Este BSUID já está vinculado a outro cliente. Preserve essa identificação e selecione o cliente vinculado.',
      strong.clienteId,
      owner.exists ? String(owner.data()?.conversaId) : null,
    );
  }
  const conflictingPhone = identityData.some(
    (identity, i) =>
      previewIdentities[i]?.tipo === 'telefone' &&
      identity?.ativa &&
      identity.clienteId !== clienteId,
  );
  const avisoIdentidade =
    strong && conflictingPhone
      ? 'O telefone recebido está vinculado a outro cliente. Ao confirmar, a identificação por BSUID será preservada e esse telefone será ignorado apenas para este contato. O vínculo do telefone com o outro cliente permanecerá.'
      : null;
  const cliente = clienteCollection.parseRead(clienteSnap.data());
  return whatsappVinculoPrevisaoSchema.parse({
    avisoIdentidade,
    cliente: {
      id: clienteId,
      nome: cliente.nome,
      cpf_cnpj: cliente.cpf_cnpj,
      telefone: cliente.telefone,
    },
    conversaId,
  });
}
