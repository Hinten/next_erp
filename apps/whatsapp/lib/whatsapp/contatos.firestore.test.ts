import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Firestore,
  Query,
  Timestamp,
  Transaction,
  type DocumentReference,
} from 'firebase-admin/firestore';
import {
  clienteCollection,
  conversaCollection,
  integracaoCollection,
  mensagemCollection,
  usuarioCollection,
  whatsappConversaCollection,
  whatsappIdentidadeCollection,
  whatsappMensagemCollection,
  whatsappVinculoCollection,
  whatsappVinculoMensagemCollection,
} from '@delfrance/data/admin/collections';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { findOrCreateCliente } from '@delfrance/data/admin/clientes';
import {
  buildClienteTelefonePatch,
  ESTADO_CONVERSA,
  ESTADO_ENVIO,
  INTEGRACAO_TIPO,
  RETENCAO_VINCULO_WHATSAPP_DIAS,
  TIPO_MENSAGEM,
} from '@delfrance/schemas';
import {
  aplicarTransicaoWhatsapp,
  conversaWhatsappKey,
  identidadeWhatsappId,
  resolverContatoWhatsapp,
  vinculoWhatsappId,
  WhatsappVinculoConflitoError,
  type ContatoWhatsapp,
} from './contatos';
import { confirmarVinculoSchema, confirmarVinculoWhatsapp } from './vinculos';
import { replayVinculoWhatsapp } from './vinculoReplay';
import { processMessagesField, type WhatsappProcessDeps } from './processMessages';
import { mensagemDocId } from './ids';

// Collection-wide cleanup is safe only on this named local emulator database.
// Missing configuration is a failing suite, never a silent skip or a staging fallback.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const project = process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || project !== 'demo-erp') {
  throw new Error(
    'WhatsApp Firestore tests require FIRESTORE_EMULATOR_HOST on localhost and project demo-erp.',
  );
}
if (process.env.FIREBASE_DATABASE_ID && process.env.FIREBASE_DATABASE_ID !== 'default') {
  throw new Error('WhatsApp Firestore tests require the named database default.');
}
const db = new Firestore({ projectId: project, databaseId: 'default', host, ssl: false });
const A = '5511999998888';
const B = '14155552671';
const T = 1_800_000_000_000;
const accountId = 'whatsapp-integration';
const portfolio = 'business-portfolio';
const graphPhoneId = 'graph-phone-id';
const deps: WhatsappProcessDeps = {
  mediaContext: async () => {
    throw new Error('Text-only fixture unexpectedly requested media/network.');
  },
};
const contato = (patch: Partial<ContatoWhatsapp> = {}): ContatoWhatsapp => ({
  integracaoId: accountId,
  portfolioId: portfolio,
  bsuid: null,
  telefone: A,
  nome: 'Contato',
  timestamp: T,
  ...patch,
});
const payload = (id: string, contact = contato()) => ({
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '+5511888888888', phone_number_id: graphPhoneId },
  contacts: [
    {
      profile: { name: contact.nome },
      ...(contact.telefone ? { wa_id: contact.telefone } : {}),
      ...(contact.bsuid ? { user_id: contact.bsuid } : {}),
    },
  ],
  messages: [
    {
      id,
      type: 'text',
      timestamp: String(contact.timestamp / 1000),
      text: { body: 'Mensagem ' + id },
      ...(contact.telefone ? { from: contact.telefone } : {}),
      ...(contact.bsuid ? { from_user_id: contact.bsuid } : {}),
    },
  ],
});
async function seedCliente(id = 'cliente-a', telefone: string | null = A) {
  await clienteCollection
    .docRef(db, {}, id)
    .create(clienteCollection.parse({ nome: id, telefone }));
}
async function seedIdentity(clienteId: string, c: ContatoWhatsapp, type: 'telefone' | 'bsuid') {
  const scope = type === 'bsuid' ? portfolio : c.integracaoId;
  const value = type === 'bsuid' ? c.bsuid! : c.telefone!;
  const id = identidadeWhatsappId(scope, type, value);
  await whatsappIdentidadeCollection.docRef(db, {}, id).create(
    whatsappIdentidadeCollection.parse({
      escopo: scope,
      tipo: type,
      valor: value,
      clienteId,
      ativa: true,
      telefoneClienteNoVinculo: type === 'telefone' ? A : null,
    }),
  );
  return id;
}
async function park(c = contato(), sourceNotificationId: string | null = null) {
  const result = await processMessagesField(
    db,
    payload('wamid.parked', c),
    deps,
    sourceNotificationId,
  );
  expect(result.kind).toBe('parked');
  const id = vinculoWhatsappId(c);
  expect((await whatsappVinculoCollection.docRef(db, {}, id).get()).exists).toBe(true);
  return id;
}
const existingChoice = (clienteId: string, requestId: string) =>
  confirmarVinculoSchema.parse({
    requestId,
    revision: 0,
    choice: { kind: 'existing', clienteId },
  });

async function clearFixtureDocument(ref: DocumentReference): Promise<void> {
  for (const collection of await ref.listCollections()) {
    for (const child of await collection.listDocuments()) await clearFixtureDocument(child);
  }
  await ref.delete();
}

beforeEach(async () => {
  __resetAllReadCaches();
  for (const collection of [
    clienteCollection.ref(db, {}),
    conversaCollection.ref(db, {}),
    integracaoCollection.ref(db, {}),
    usuarioCollection.ref(db, {}),
    whatsappConversaCollection.ref(db, {}),
    whatsappIdentidadeCollection.ref(db, {}),
    whatsappMensagemCollection.ref(db, {}),
    whatsappVinculoCollection.ref(db, {}),
  ]) {
    // Verify isolation explicitly, including subcollections under missing parents.
    for (const ref of await collection.listDocuments()) await clearFixtureDocument(ref);
    expect((await collection.get()).empty).toBe(true);
  }
  await integracaoCollection.docRef(db, {}, accountId).create(
    integracaoCollection.parse({
      tipo: INTEGRACAO_TIPO.whatsapp,
      nome: 'Conta local',
      wa_id: graphPhoneId,
      phoneNumberId: graphPhoneId,
      portfolioId: portfolio,
    }),
  );
  expect((await integracaoCollection.docRef(db, {}, accountId).get()).exists).toBe(true);
});
afterAll(async () => {
  await db.terminate();
});

describe('WhatsApp identity and linkage against Firestore transactions', () => {
  it.each(
    ['customer_identity_changed', 'future_provider_event'].flatMap((systemType) =>
      ['none', 'expired', 'same-timestamp'].map((history) => ({ systemType, history })),
    ),
  )(
    '$systemType preserves the $history customer window, including redelivery',
    async ({ systemType, history }) => {
      await seedCliente();
      await integracaoCollection.docRef(db, {}, accountId).update({
        horario_funcionamento: [],
        mensagem_inatividade: 'Recebemos sua mensagem.',
      });
      const timestamp = Math.floor(Date.now() / 1000) * 1000;
      const previousClock =
        history === 'none' ? null : timestamp - (history === 'expired' ? 2 * 86400000 : 0);
      if (previousClock != null) {
        const resolved = await resolverContatoWhatsapp(db, contato({ timestamp: previousClock }));
        expect(resolved.kind).toBe('resolved');
        if (resolved.kind !== 'resolved') throw new Error('Fixture contact did not resolve.');
        await conversaCollection.docRef(db, {}, resolved.conversaId).update({
          estadoConversa: ESTADO_CONVERSA.atendimentoFinalizado,
        });
      }
      const value = {
        ...payload('wamid.system', contato({ timestamp })),
        messages: [
          {
            id: 'wamid.system',
            from: A,
            timestamp: String(timestamp / 1000),
            type: 'system',
            system: { type: systemType, body: 'Provider identity notice' },
          },
        ],
      };
      expect((await processMessagesField(db, value, deps)).kind).toBe('processed');
      expect((await processMessagesField(db, value, deps)).kind).toBe('processed');
      const chats = await conversaCollection.ref(db, {}).get();
      expect(chats.size).toBe(1);
      const chat = chats.docs[0]!;
      expect(chat.data()).toMatchObject({
        prazo_resposta: previousClock == null ? null : previousClock + 86400000,
        whatsappDestino: { ultimaMensagemEm: previousClock },
        ...(previousClock == null
          ? {}
          : {
              estadoConversa: ESTADO_CONVERSA.atendimentoFinalizado,
              ultima_modificacao: previousClock,
              ultimaModificacaoIntegracao: previousClock,
            }),
      });
      const messages = await mensagemCollection.ref(db, { conversaId: chat.id }).get();
      expect(messages.docs.filter((d) => d.id.startsWith('autoreply_'))).toHaveLength(0);
      expect(messages.docs.filter((d) => d.id.startsWith('evento_reaberto_'))).toHaveLength(0);
      expect(messages.docs.filter((d) => d.data().mid === 'wamid.system')).toHaveLength(1);
      expect(messages.docs.find((d) => d.data().mid === 'wamid.system')?.data().tipo).toBe(
        TIPO_MENSAGEM.evento,
      );

      // A real customer message still opens the window, reopens service and replies.
      expect(
        (
          await processMessagesField(
            db,
            payload('wamid.customer', contato({ timestamp: timestamp + 1000 })),
            deps,
          )
        ).kind,
      ).toBe('processed');
      expect((await chat.ref.get()).data()).toMatchObject({
        estadoConversa: ESTADO_CONVERSA.naoRespondido,
        prazo_resposta: timestamp + 1000 + 86400000,
        whatsappDestino: { ultimaMensagemEm: timestamp + 1000 },
      });
      expect(
        (await mensagemCollection.ref(db, { conversaId: chat.id }).get()).docs.filter((d) =>
          d.id.startsWith('autoreply_'),
        ),
      ).toHaveLength(1);
    },
  );

  it('two simultaneous messages and redelivery create one conversation and two messages', async () => {
    await seedCliente();
    const results = await Promise.all([
      processMessagesField(db, payload('wamid.first'), deps),
      processMessagesField(db, payload('wamid.second'), deps),
    ]);
    expect(results.map((r) => r.kind)).toEqual(['processed', 'processed']);
    expect((await processMessagesField(db, payload('wamid.first'), deps)).kind).toBe('processed');
    const chats = await conversaCollection.ref(db, {}).get();
    expect(chats.size).toBe(1);
    const messages = await mensagemCollection.ref(db, { conversaId: chats.docs[0]!.id }).get();
    expect(
      messages.docs.filter((d) => d.data().estadoEnvio === ESTADO_ENVIO.recebido),
    ).toHaveLength(2);
    expect((await whatsappConversaCollection.ref(db, {}).get()).size).toBe(1);
    expect((await whatsappMensagemCollection.ref(db, {}).get()).size).toBe(2);
    expect((await usuarioCollection.ref(db, {}).get()).empty).toBe(true);
  });

  it('a verified BSUID without phone resolves the existing client and preserves a null phone', async () => {
    await seedCliente('cliente-a', null);
    const c = contato({ telefone: null, bsuid: 'business-user-A' });
    const identityId = await seedIdentity('cliente-a', c, 'bsuid');
    expect((await processMessagesField(db, payload('wamid.bsuid', c), deps)).kind).toBe(
      'processed',
    );
    const chats = await conversaCollection.ref(db, {}).get();
    expect(chats.size).toBe(1);
    expect(chats.docs[0]!.data()).toMatchObject({
      clienteOuterRef: 'documents/clientes/cliente-a',
      whatsappDestino: { tipo: 'bsuid', valor: c.bsuid },
    });
    const message = await mensagemCollection
      .docRef(db, { conversaId: chats.docs[0]!.id }, mensagemDocId(accountId, 'wamid.bsuid'))
      .get();
    expect(message.data()?.whatsappIdentidadeId).toBe(identityId);
    expect((await clienteCollection.docRef(db, {}, 'cliente-a').get()).data()?.telefone).toBeNull();
    expect((await usuarioCollection.ref(db, {}).get()).empty).toBe(true);
  });

  it('unknown contacts park and deduplicate the payload without creating a client, user or chat', async () => {
    const id = await park();
    expect((await processMessagesField(db, payload('wamid.parked'), deps)).kind).toBe('parked');
    expect((await whatsappVinculoMensagemCollection.ref(db, { vinculoId: id }).get()).size).toBe(1);
    expect(
      (await whatsappVinculoCollection.docRef(db, {}, id).get()).data()?.quantidadeMensagens,
    ).toBe(1);
    expect((await clienteCollection.ref(db, {}).get()).empty).toBe(true);
    expect((await usuarioCollection.ref(db, {}).get()).empty).toBe(true);
    expect((await conversaCollection.ref(db, {}).get()).empty).toBe(true);
  });

  // Regression coverage for #1629. Keep the real contention and assertions below: under
  // Firestore Emulator 1.22.0, lock contention is normally surfaced as retryable ABORTED.
  // Do not mask a non-retryable "Transaction is invalid or closed" with a test retry.
  it('two simultaneous create confirmations with the same request reserve one client and conversation', async () => {
    const id = await park();
    const choice = confirmarVinculoSchema.parse({
      requestId: 'request-create',
      revision: 0,
      choice: { kind: 'create', cliente: { nome: 'Cadastro confirmado', telefone: A } },
    });
    const [first, second] = await Promise.all([
      confirmarVinculoWhatsapp(db, id, choice, 'operator-a'),
      confirmarVinculoWhatsapp(db, id, choice, 'operator-b'),
    ]);
    expect(first).toEqual(second);
    expect((await clienteCollection.ref(db, {}).get()).size).toBe(1);
    expect((await conversaCollection.ref(db, {}).get()).size).toBe(1);
    expect((await whatsappVinculoCollection.docRef(db, {}, id).get()).data()?.revision).toBe(1);
  });

  it('two operators choosing the same existing client converge even with different requests', async () => {
    const id = await park();
    await seedCliente();
    const [first, second] = await Promise.all([
      confirmarVinculoWhatsapp(db, id, existingChoice('cliente-a', 'request-a'), 'operator-a'),
      confirmarVinculoWhatsapp(db, id, existingChoice('cliente-a', 'request-b'), 'operator-b'),
    ]);
    expect(first).toEqual(second);
    expect((await clienteCollection.ref(db, {}).get()).size).toBe(1);
    expect((await conversaCollection.ref(db, {}).get()).size).toBe(1);
  });

  it('simultaneous different choices expose the winning binding as a conflict', async () => {
    const id = await park();
    await seedCliente('cliente-a');
    await seedCliente('cliente-b', B);
    const results = await Promise.allSettled([
      confirmarVinculoWhatsapp(db, id, existingChoice('cliente-a', 'request-a'), 'operator-a'),
      confirmarVinculoWhatsapp(db, id, existingChoice('cliente-b', 'request-b'), 'operator-b'),
    ]);
    const winner = results.find((r) => r.status === 'fulfilled');
    const loser = results.find((r) => r.status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(loser?.status).toBe('rejected');
    if (winner?.status !== 'fulfilled' || loser?.status !== 'rejected')
      throw new Error('Expected one winner and one loser.');
    expect(loser.reason).toBeInstanceOf(WhatsappVinculoConflitoError);
    expect(loser.reason).toMatchObject({
      clienteId: winner.value.clienteId,
      conversaId: winner.value.conversaId,
    });
    expect((await conversaCollection.ref(db, {}).get()).size).toBe(1);
  });

  // This is the second #1629 contention shape. Both attempts must derive their result from
  // current transaction snapshots while converging on the canonical conversation.
  it('two verified phones share one client conversation without changing its principal phone', async () => {
    await seedCliente();
    await seedIdentity('cliente-a', contato(), 'telefone');
    await seedIdentity('cliente-a', contato({ telefone: B }), 'telefone');
    const [first, second] = await Promise.all([
      resolverContatoWhatsapp(db, contato()),
      resolverContatoWhatsapp(db, contato({ telefone: B, timestamp: T + 1000 })),
    ]);
    expect(first.kind).toBe('resolved');
    expect(second.kind).toBe('resolved');
    const chats = await conversaCollection.ref(db, {}).get();
    expect(chats.size).toBe(1);
    expect(chats.docs[0]!.data().whatsappDestino).toMatchObject({
      valor: B,
      ultimaMensagemEm: T + 1000,
    });
    expect((await clienteCollection.docRef(db, {}, 'cliente-a').get()).data()?.telefone).toBe(A);
  });

  it('editing the principal phone invalidates an old telephone alias', async () => {
    await seedCliente();
    expect((await resolverContatoWhatsapp(db, contato())).kind).toBe('resolved');
    await clienteCollection
      .docRef(db, {}, 'cliente-a')
      .update({ telefone: B, telefonesAdicionais: [A] });
    const before = await conversaCollection.ref(db, {}).get();
    expect((await resolverContatoWhatsapp(db, contato({ timestamp: T + 1000 }))).kind).toBe(
      'pending',
    );
    expect((await conversaCollection.ref(db, {}).get()).docs[0]!.data()).toEqual(
      before.docs[0]!.data(),
    );
    expect((await clienteCollection.ref(db, {}).get()).size).toBe(1);
  });

  it('replay recovers each retained message once and can resume after completion', async () => {
    const id = await park();
    await seedCliente();
    const link = await confirmarVinculoWhatsapp(
      db,
      id,
      existingChoice('cliente-a', 'link'),
      'operator',
    );
    const redrive = vi.fn(async (_id: string) => undefined);
    expect((await replayVinculoWhatsapp(db, id, deps, redrive)).kind).toBe('processed');
    expect((await replayVinculoWhatsapp(db, id, deps, redrive)).kind).toBe('processed');
    const stored = await whatsappVinculoMensagemCollection.ref(db, { vinculoId: id }).get();
    expect(stored.docs.map((d) => d.data().processada)).toEqual([true]);
    // Processed ⇒ the retained copy is redundant, so the same write starts its
    // TTL clock — as a real Timestamp, since the policy ignores a numeric epoch.
    const expiraEm = stored.docs[0]!.get('expiraEm');
    expect(expiraEm).toBeInstanceOf(Timestamp);
    const diasAteExpirar = ((expiraEm as Timestamp).toMillis() - Date.now()) / 86_400_000;
    expect(diasAteExpirar).toBeGreaterThan(RETENCAO_VINCULO_WHATSAPP_DIAS - 1);
    expect(diasAteExpirar).toBeLessThanOrEqual(RETENCAO_VINCULO_WHATSAPP_DIAS);
    expect((await whatsappVinculoCollection.docRef(db, {}, id).get()).data()?.estado).toBe(
      'resolvido',
    );
    const messages = await mensagemCollection.ref(db, { conversaId: link.conversaId }).get();
    expect(messages.docs.filter((d) => d.data().mid === 'wamid.parked')).toHaveLength(1);
    expect(redrive).not.toHaveBeenCalled();
  });

  it('manual linkage of an ambiguous telephone allows retained-message replay for the chosen client', async () => {
    await seedCliente('cliente-a');
    await seedCliente('cliente-b');
    const id = await park();
    const linked = await confirmarVinculoWhatsapp(
      db,
      id,
      existingChoice('cliente-b', 'manual-choice'),
      'operator',
    );
    expect((await replayVinculoWhatsapp(db, id, deps, async () => undefined)).kind).toBe(
      'processed',
    );
    expect((await whatsappVinculoCollection.docRef(db, {}, id).get()).data()?.estado).toBe(
      'resolvido',
    );
    const stored = await mensagemCollection
      .docRef(db, { conversaId: linked.conversaId }, mensagemDocId(accountId, 'wamid.parked'))
      .get();
    expect(stored.data()?.clienteMensagemOuterRef).toBe('documents/clientes/cliente-b');
    expect((await conversaCollection.ref(db, {}).get()).size).toBe(1);
  });

  it('a replay interruption after writing history resumes without duplicate messages', async () => {
    const id = await park(contato(), 'original-notification');
    await seedCliente();
    const linked = await confirmarVinculoWhatsapp(
      db,
      id,
      existingChoice('cliente-a', 'link'),
      'operator',
    );
    const redrive = vi
      .fn(async (_id: string) => undefined)
      .mockRejectedValueOnce(new Error('simulated source-redrive interruption'));
    await expect(replayVinculoWhatsapp(db, id, deps, redrive)).rejects.toThrow(
      'simulated source-redrive interruption',
    );
    const pending = await whatsappVinculoMensagemCollection.ref(db, { vinculoId: id }).get();
    expect(pending.docs[0]!.data().processada).toBe(false);
    // Not processed ⇒ still the ONLY copy of the message: it must never expire.
    expect(pending.docs[0]!.get('expiraEm')).toBeUndefined();
    expect((await replayVinculoWhatsapp(db, id, deps, redrive)).kind).toBe('processed');
    const messages = await mensagemCollection.ref(db, { conversaId: linked.conversaId }).get();
    expect(messages.docs.filter((d) => d.data().mid === 'wamid.parked')).toHaveLength(1);
    expect(redrive).toHaveBeenCalledTimes(2);
    expect(redrive).toHaveBeenLastCalledWith('original-notification');
  });

  it('a BSUID rotation without wa_id preserves the current telephone and its history', async () => {
    await seedCliente();
    await clienteCollection.docRef(db, {}, 'cliente-a').update({ telefonesAdicionais: [B] });
    const original = contato({ bsuid: 'business-user-A', telefone: null });
    await seedIdentity('cliente-a', original, 'bsuid');
    await resolverContatoWhatsapp(db, original);
    const system = {
      type: 'user_changed_user_id',
      previous_user_id: original.bsuid!,
      user_id: 'business-user-B',
    };
    expect(
      (await aplicarTransicaoWhatsapp(db, { ...original, timestamp: T + 1000 }, system)).kind,
    ).toBe('resolved');
    expect((await clienteCollection.docRef(db, {}, 'cliente-a').get()).data()).toMatchObject({
      telefone: A,
      telefonesAdicionais: [B],
    });
    const chats = await conversaCollection.ref(db, {}).get();
    expect(chats.docs[0]!.data()).toMatchObject({
      prazo_resposta: null,
      whatsappDestino: {
        valor: 'business-user-B',
        ultimaMensagemEm: null,
        ultimaIdentificacaoEm: T + 1000,
      },
    });
  });

  it('a parked system-only transition replays after manual linkage without opening a reply window', async () => {
    await seedCliente();
    const original = contato({ bsuid: 'business-user-A', telefone: null });
    const value = payload('wamid.system-only', original);
    const systemOnly = {
      ...value,
      messages: [
        {
          id: 'wamid.system-only',
          from_user_id: original.bsuid,
          type: 'system',
          timestamp: String(T / 1000),
          system: {
            type: 'user_changed_user_id',
            previous_user_id: original.bsuid,
            user_id: 'business-user-B',
            body: 'Identity changed',
          },
        },
      ],
    };
    expect((await processMessagesField(db, systemOnly, deps)).kind).toBe('parked');
    const id = vinculoWhatsappId(original);
    expect(
      (await whatsappVinculoCollection.docRef(db, {}, id).get()).data()?.ultimaMensagemClienteEm,
    ).toBeNull();
    const linked = await confirmarVinculoWhatsapp(
      db,
      id,
      existingChoice('cliente-a', 'system-link'),
      'operator',
    );
    expect((await replayVinculoWhatsapp(db, id, deps, async () => undefined)).kind).toBe(
      'processed',
    );
    expect((await conversaCollection.docRef(db, {}, linked.conversaId).get()).data()).toMatchObject(
      {
        prazo_resposta: null,
        whatsappDestino: {
          valor: 'business-user-B',
          ultimaMensagemEm: null,
          ultimaIdentificacaoEm: T,
        },
      },
    );
    expect((await clienteCollection.docRef(db, {}, 'cliente-a').get()).data()?.telefone).toBe(A);
  });

  it('stale transitions and old-BSUID replay preserve the current destination and phone', async () => {
    await seedCliente();
    const original = contato({ bsuid: 'business-user-A' });
    const oldIdentity = await seedIdentity('cliente-a', original, 'bsuid');
    expect((await resolverContatoWhatsapp(db, original)).kind).toBe('resolved');
    const system = {
      type: 'user_changed_user_id',
      previous_user_id: original.bsuid!,
      user_id: 'business-user-B',
      wa_id: B,
    };
    const fresh = await aplicarTransicaoWhatsapp(db, { ...original, timestamp: T + 2000 }, system);
    expect(fresh.kind).toBe('resolved');
    const claim = await whatsappConversaCollection
      .docRef(db, {}, conversaWhatsappKey(accountId, 'cliente-a'))
      .get();
    const chatRef = conversaCollection.docRef(db, {}, String(claim.data()?.conversaId));
    const before = (await chatRef.get()).data()?.whatsappDestino;
    expect(
      (await aplicarTransicaoWhatsapp(db, { ...original, timestamp: T + 1000 }, system)).kind,
    ).toBe('resolved');
    const oldMessage = contato({ telefone: null, bsuid: original.bsuid, timestamp: T - 1000 });
    expect((await processMessagesField(db, payload('wamid.old', oldMessage), deps)).kind).toBe(
      'processed',
    );
    expect((await chatRef.get()).data()?.whatsappDestino).toEqual(before);
    expect((await clienteCollection.docRef(db, {}, 'cliente-a').get()).data()).toMatchObject({
      telefone: B,
      telefonesAdicionais: [A],
    });
    const message = await mensagemCollection
      .docRef(db, { conversaId: chatRef.id }, mensagemDocId(accountId, 'wamid.old'))
      .get();
    expect(message.data()?.whatsappIdentidadeId).toBe(oldIdentity);
    expect((await conversaCollection.ref(db, {}).get()).size).toBe(1);
  });

  it('a delayed transition from a retired predecessor cannot reactivate an intermediate BSUID', async () => {
    await seedCliente('cliente-a', null);
    const original = contato({ bsuid: 'business-user-A', telefone: null });
    await seedIdentity('cliente-a', original, 'bsuid');
    await resolverContatoWhatsapp(db, original);
    const first = {
      type: 'user_changed_user_id',
      previous_user_id: 'business-user-A',
      user_id: 'business-user-B',
    };
    expect(
      (await aplicarTransicaoWhatsapp(db, { ...original, timestamp: T + 1000 }, first)).kind,
    ).toBe('resolved');
    const second = {
      type: 'user_changed_user_id',
      previous_user_id: 'business-user-B',
      user_id: 'business-user-C',
    };
    expect(
      (
        await aplicarTransicaoWhatsapp(
          db,
          { ...original, bsuid: 'business-user-B', timestamp: T + 3000 },
          second,
        )
      ).kind,
    ).toBe('resolved');
    const intermediateRef = whatsappIdentidadeCollection.docRef(
      db,
      {},
      identidadeWhatsappId(portfolio, 'bsuid', 'business-user-B'),
    );
    const before = (await intermediateRef.get()).data();
    expect(before?.ativa).toBe(false);
    await aplicarTransicaoWhatsapp(db, { ...original, timestamp: T + 2000 }, first);
    expect((await intermediateRef.get()).data()).toEqual(before);
    const active = await whatsappIdentidadeCollection.ref(db, {}).where('ativa', '==', true).get();
    expect(active.docs.map((d) => d.data().valor)).toEqual(['business-user-C']);
  });
  it('a retired BSUID can append history without claiming an unseen telephone', async () => {
    await seedCliente('cliente-a', null);
    const original = contato({ bsuid: 'business-user-A', telefone: null });
    await seedIdentity('cliente-a', original, 'bsuid');
    const initial = await resolverContatoWhatsapp(db, original);
    expect(initial.kind).toBe('resolved');
    await aplicarTransicaoWhatsapp(
      db,
      { ...original, timestamp: T + 3000 },
      {
        type: 'user_changed_user_id',
        previous_user_id: 'business-user-A',
        user_id: 'business-user-B',
      },
    );
    const retiredMessage = contato({
      bsuid: 'business-user-A',
      telefone: A,
      timestamp: T + 1000,
    });
    expect(
      (await processMessagesField(db, payload('wamid.retired-unseen-phone', retiredMessage), deps))
        .kind,
    ).toBe('processed');
    expect(
      (
        await whatsappIdentidadeCollection
          .docRef(db, {}, identidadeWhatsappId(accountId, 'telefone', A))
          .get()
      ).exists,
    ).toBe(false);
    const chat = (await conversaCollection.ref(db, {}).get()).docs[0]!;
    expect(chat.data().whatsappDestino?.valor).toBe('business-user-B');
    expect(
      (
        await mensagemCollection
          .docRef(
            db,
            { conversaId: chat.id },
            mensagemDocId(accountId, 'wamid.retired-unseen-phone'),
          )
          .get()
      ).data()?.clienteMensagemOuterRef,
    ).toBe('documents/clientes/cliente-a');
    expect(
      (await resolverContatoWhatsapp(db, contato({ telefone: A, timestamp: T + 4000 }))).kind,
    ).toBe('pending');
  });

  it('an active alternative predecessor cannot rewind a target retired by a later transition', async () => {
    await seedCliente('cliente-a', null);
    const original = contato({ bsuid: 'business-user-A', telefone: null });
    await seedIdentity('cliente-a', original, 'bsuid');
    await resolverContatoWhatsapp(db, original);
    const alternative = contato({ bsuid: 'business-user-B', telefone: null });
    await seedIdentity('cliente-a', alternative, 'bsuid');
    expect(
      (
        await aplicarTransicaoWhatsapp(
          db,
          { ...alternative, timestamp: T + 3000 },
          {
            type: 'user_changed_user_id',
            previous_user_id: 'business-user-B',
            user_id: 'business-user-C',
          },
        )
      ).kind,
    ).toBe('resolved');
    const targetRef = whatsappIdentidadeCollection.docRef(
      db,
      {},
      identidadeWhatsappId(portfolio, 'bsuid', 'business-user-B'),
    );
    const before = (await targetRef.get()).data();
    const beforeChat = (await conversaCollection.ref(db, {}).get()).docs[0]!.data();
    expect(
      (
        await aplicarTransicaoWhatsapp(
          db,
          { ...original, timestamp: T + 2000 },
          {
            type: 'user_changed_user_id',
            previous_user_id: 'business-user-A',
            user_id: 'business-user-B',
          },
        )
      ).kind,
    ).toBe('pending');
    expect((await targetRef.get()).data()).toEqual(before);
    expect((await conversaCollection.ref(db, {}).get()).docs[0]!.data()).toEqual(beforeChat);
    expect(
      (
        await whatsappIdentidadeCollection
          .docRef(db, {}, identidadeWhatsappId(portfolio, 'bsuid', 'business-user-A'))
          .get()
      ).data()?.ativa,
    ).toBe(true);
  });
  it('a reviewed BSUID conflict preserves both owners and ignores only the reviewed telephone', async () => {
    await seedCliente('cliente-a', null);
    await seedCliente('cliente-b', A);
    const original = contato({ bsuid: 'business-user-A', telefone: A });
    const bsuidId = await seedIdentity('cliente-a', original, 'bsuid');
    const phoneId = await seedIdentity('cliente-b', original, 'telefone');
    const phoneRef = whatsappIdentidadeCollection.docRef(db, {}, phoneId);
    const phoneBefore = (await phoneRef.get()).data();
    const id = await park(original);
    const linked = await confirmarVinculoWhatsapp(
      db,
      id,
      existingChoice('cliente-a', 'confirm-bsuid-owner'),
      'operator',
    );
    expect((await replayVinculoWhatsapp(db, id, deps, async () => undefined)).kind).toBe(
      'processed',
    );
    const message = await mensagemCollection
      .docRef(db, { conversaId: linked.conversaId }, mensagemDocId(accountId, 'wamid.parked'))
      .get();
    expect(message.data()?.clienteMensagemOuterRef).toBe('documents/clientes/cliente-a');
    expect((await phoneRef.get()).data()).toEqual(phoneBefore);
    expect((await whatsappIdentidadeCollection.docRef(db, {}, bsuidId).get()).data()).toMatchObject(
      {
        clienteId: 'cliente-a',
        ativa: true,
        confirmadaManualmente: true,
        aliasesTelefoneIgnorados: [phoneId],
      },
    );
    const phoneOnly = await resolverContatoWhatsapp(db, contato({ timestamp: T + 1000 }));
    expect(phoneOnly).toMatchObject({ kind: 'resolved', clienteId: 'cliente-b' });
    expect((await phoneRef.get()).data()).toEqual(phoneBefore);

    // A verified identity-only rotation preserves the explicit telephone exception.
    expect(
      (
        await aplicarTransicaoWhatsapp(
          db,
          { ...original, telefone: null, timestamp: T + 2000 },
          {
            type: 'user_changed_user_id',
            previous_user_id: 'business-user-A',
            user_id: 'business-user-D',
          },
        )
      ).kind,
    ).toBe('resolved');
    const rotated = contato({ bsuid: 'business-user-D', telefone: A, timestamp: T + 3000 });
    expect(await resolverContatoWhatsapp(db, rotated)).toMatchObject({
      kind: 'resolved',
      clienteId: 'cliente-a',
      conversaId: linked.conversaId,
    });
    expect(
      (
        await whatsappIdentidadeCollection
          .docRef(db, {}, identidadeWhatsappId(portfolio, 'bsuid', 'business-user-D'))
          .get()
      ).data()?.aliasesTelefoneIgnorados,
    ).toEqual([phoneId]);
    expect((await phoneRef.get()).data()).toEqual(phoneBefore);

    // Confirmation of one contradictory phone cannot suppress a new contradiction.
    await seedCliente('cliente-c', B);
    await seedIdentity('cliente-c', contato({ telefone: B }), 'telefone');
    expect(
      (await resolverContatoWhatsapp(db, { ...rotated, telefone: B, timestamp: T + 4000 })).kind,
    ).toBe('pending');
    expect((await whatsappConversaCollection.ref(db, {}).get()).size).toBe(2);
  });
  it.each([false, true])(
    'a reviewed BSUID does not claim a new contradictory phone without an identity (ambiguous=%s)',
    async (ambiguous) => {
      await seedCliente('cliente-a', null);
      await seedCliente('cliente-b', A);
      const reviewed = contato({ bsuid: 'business-user-A' });
      const bsuidId = await seedIdentity('cliente-a', reviewed, 'bsuid');
      const reviewedPhoneId = await seedIdentity('cliente-b', reviewed, 'telefone');
      const id = await park(reviewed);
      const linked = await confirmarVinculoWhatsapp(
        db,
        id,
        existingChoice('cliente-a', 'review-one-phone'),
        'operator',
      );

      // The exact phone approved by the operator still continues the canonical chat.
      expect(await resolverContatoWhatsapp(db, { ...reviewed, timestamp: T + 1000 })).toMatchObject(
        {
          kind: 'resolved',
          clienteId: 'cliente-a',
          conversaId: linked.conversaId,
        },
      );
      const bsuidRef = whatsappIdentidadeCollection.docRef(db, {}, bsuidId);
      const reviewedPhoneRef = whatsappIdentidadeCollection.docRef(db, {}, reviewedPhoneId);
      const chatRef = conversaCollection.docRef(db, {}, linked.conversaId);
      const beforeBsuid = await bsuidRef.get();
      const beforeReviewedPhone = await reviewedPhoneRef.get();
      const beforeChat = await chatRef.get();

      await seedCliente('cliente-c', B);
      if (ambiguous) await seedCliente('cliente-d', B);
      const newPhoneRef = whatsappIdentidadeCollection.docRef(
        db,
        {},
        identidadeWhatsappId(accountId, 'telefone', B),
      );
      expect((await newPhoneRef.get()).exists).toBe(false);
      expect(
        await resolverContatoWhatsapp(db, { ...reviewed, telefone: B, timestamp: T + 2000 }),
      ).toEqual({
        kind: 'pending',
        motivo: ambiguous
          ? 'Telefone corresponde a vários clientes.'
          : 'Telefone e identidade WhatsApp indicam clientes diferentes.',
      });
      expect((await newPhoneRef.get()).exists).toBe(false);
      expect((await bsuidRef.get()).updateTime).toEqual(beforeBsuid.updateTime);
      expect((await reviewedPhoneRef.get()).updateTime).toEqual(beforeReviewedPhone.updateTime);
      expect((await chatRef.get()).updateTime).toEqual(beforeChat.updateTime);
      expect((await whatsappConversaCollection.ref(db, {}).get()).size).toBe(1);
    },
  );

  it('a stale manual phone edit conflicts after the webhook wins and its reviewed retry preserves both histories', async () => {
    await seedCliente();
    await resolverContatoWhatsapp(db, contato());
    const clienteRef = clienteCollection.docRef(db, {}, 'cliente-a');
    const editingSnapshot = await clienteRef.get();
    const manualPhone = '442071838750';
    const staleEdit = buildClienteTelefonePatch(editingSnapshot.data()!, {
      tipo: 'manual',
      patch: { telefone: manualPhone },
    });

    expect(
      (
        await aplicarTransicaoWhatsapp(db, contato({ timestamp: T + 1000 }), {
          type: 'user_changed_number',
          wa_id: B,
        })
      ).kind,
    ).toBe('resolved');
    await expect(
      clienteRef.update(staleEdit, {
        lastUpdateTime: editingSnapshot.updateTime!,
      }),
    ).rejects.toMatchObject({ code: 9 });
    expect((await clienteRef.get()).data()).toMatchObject({
      telefone: B,
      telefonesAdicionais: [A],
      telefoneGerenciado: true,
    });

    const reviewed = await clienteRef.get();
    await clienteRef.update(
      buildClienteTelefonePatch(reviewed.data()!, {
        tipo: 'manual',
        patch: { telefone: manualPhone },
      }),
      { lastUpdateTime: reviewed.updateTime! },
    );
    const afterReview = (await clienteRef.get()).data();
    expect(afterReview).toMatchObject({
      telefone: manualPhone,
      telefonesAdicionais: [A, B],
      telefoneGerenciado: true,
    });

    // A later-delivered provider event still has to prove its predecessor
    // against the current human choice, even when its own timestamp is newer.
    expect(
      (
        await aplicarTransicaoWhatsapp(db, contato({ telefone: B, timestamp: T + 3000 }), {
          type: 'user_changed_number',
          wa_id: '5511988887777',
        })
      ).kind,
    ).toBe('pending');
    expect((await clienteRef.get()).data()).toEqual(afterReview);
  });

  it('serializes an importer with an operator clear and never restores the reviewed phone on replay', async () => {
    await seedCliente('cliente-a', null);
    const cpf = '52998224725';
    const clienteRef = clienteCollection.docRef(db, {}, 'cliente-a');
    await clienteRef.update({ cpf_cnpj: cpf });
    const expectedQuery = clienteCollection.ref(db, {}).where('cpf_cnpj', '==', cpf).limit(10);
    let snapshotRead!: () => void;
    let releaseSnapshot!: () => void;
    const readReached = new Promise<void>((resolve) => {
      snapshotRead = resolve;
    });
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const originalGet = Transaction.prototype.get;
    let observedReads = 0;
    const getSpy = vi.spyOn(Transaction.prototype, 'get').mockImplementation(async function (
      this: Transaction,
      target: Parameters<Transaction['get']>[0],
    ) {
      const snapshot = await originalGet.call(this, target as never);
      if (target instanceof Query && target.isEqual(expectedQuery)) {
        observedReads++;
        if (observedReads === 1) {
          snapshotRead();
          await snapshotReleased;
        }
      }
      return snapshot;
    });
    const input = {
      fields: {
        tipo: null,
        nome: 'cliente-a',
        cpf_cnpj: cpf,
        idEstrangeiro: null,
        ie: null,
        telefone: A,
        email: null,
      },
      nowMs: T,
    };
    const importing = findOrCreateCliente(db, input);
    try {
      await readReached;
      const editingSnapshot = await clienteRef.get();
      const firstClear = clienteRef
        .update(
          buildClienteTelefonePatch(editingSnapshot.data()!, {
            tipo: 'manual',
            patch: { telefone: null, telefonesAdicionais: [] },
          }),
          { lastUpdateTime: editingSnapshot.updateTime! },
        )
        .then(
          () => null,
          (err: unknown) => err,
        );
      releaseSnapshot();

      expect(await importing).toMatchObject({ clienteId: 'cliente-a', created: false });
      // The server transaction held the cliente read lock; the operator's stale
      // precondition therefore loses visibly instead of silently overwriting.
      expect(await firstClear).toMatchObject({ code: 9 });

      const reviewed = await clienteRef.get();
      await clienteRef.update(
        buildClienteTelefonePatch(reviewed.data()!, {
          tipo: 'manual',
          patch: { telefone: null, telefonesAdicionais: [] },
        }),
        { lastUpdateTime: reviewed.updateTime! },
      );
      expect(observedReads).toBe(1);
      const afterRace = await clienteRef.get();
      expect(afterRace.data()).toMatchObject({
        telefone: null,
        // The serialized import observed A first; the later human clear keeps
        // that former primary as history while marking the primary managed.
        telefonesAdicionais: [A],
        telefoneGerenciado: true,
      });
      expect(await findOrCreateCliente(db, input)).toMatchObject({
        clienteId: 'cliente-a',
        created: false,
      });
      const afterReplay = await clienteRef.get();
      expect(afterReplay.data()).toEqual(afterRace.data());
      expect(afterReplay.updateTime!.isEqual(afterRace.updateTime!)).toBe(true);
    } finally {
      releaseSnapshot();
      getSpy.mockRestore();
    }
  });
});
