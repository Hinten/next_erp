import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { conversaSchema, mensagemSchema } from '@delfrance/schemas';
import {
  persistWhatsappMensagens,
  WhatsappArquivoIndisponivelError,
  WhatsappDestinoAlteradoError,
} from './whatsappMensagemWrite';

const { transaction, current, missingArquivoIds } = vi.hoisted(() => ({
  current: { value: {} as Record<string, unknown> },
  missingArquivoIds: new Set<string>(),
  transaction: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('firebase/firestore', () => ({
  runTransaction: async (_db: unknown, fn: (tx: typeof transaction) => Promise<void>) =>
    fn(transaction),
}));
vi.mock('@/lib/data/conversaCollection', () => ({
  conversaCollection: { docRef: (_db: unknown, _ctx: unknown, id: string) => `chat/${id}` },
  mensagemCollection: {
    docRef: (_db: unknown, ctx: { conversaId: string }, id: string) =>
      `chat/${ctx.conversaId}/mensagem/${id}`,
  },
}));
vi.mock('@delfrance/storage', () => ({
  arquivoCollection: { docRef: (_db: unknown, _ctx: unknown, id: string) => `arquivos/${id}` },
}));
const destino = {
  tipo: 'telefone',
  valor: '5511999998888',
  identidadeId: 'identity',
  revision: 1,
  ultimaMensagemEm: 10,
} as const;
const conversa = conversaSchema.parse({
  origem: 'whatsapp',
  integracaoOuterRef: 'documents/integracao/i1',
  whatsappDestino: destino,
});
const db = {} as Firestore;
const messages = [
  { id: 'm1', data: mensagemSchema.parse({ conteudo: 'Olá' }) },
  { id: 'm2', data: mensagemSchema.parse({ conteudo: 'Anexo' }) },
];
beforeEach(() => {
  vi.clearAllMocks();
  missingArquivoIds.clear();
  current.value = conversa;
  transaction.get.mockImplementation(async (ref: string) =>
    ref.startsWith('arquivos/')
      ? { exists: () => !missingArquivoIds.has(ref.slice('arquivos/'.length)) }
      : { data: () => current.value },
  );
});

describe('WhatsApp destination accepted by the operator', () => {
  it('writes all messages with the accepted integration and destination', async () => {
    await persistWhatsappMensagens(db, 'c1', conversa, messages);
    expect(transaction.set).toHaveBeenCalledTimes(2);
    expect(transaction.set).toHaveBeenCalledWith(
      'chat/c1/mensagem/m1',
      expect.objectContaining({ whatsappDestino: destino, whatsappIntegracaoId: 'i1' }),
    );
  });
  it.each(['revision', 'integration', 'identity'])(
    'rejects a concurrent %s change before any message is written',
    async (kind) => {
      current.value = {
        ...conversa,
        ...(kind === 'integration'
          ? { integracaoOuterRef: 'documents/integracao/i2' }
          : {
              whatsappDestino: {
                ...destino,
                ...(kind === 'revision' ? { revision: 2 } : { identidadeId: 'other' }),
              },
            }),
      };
      await expect(persistWhatsappMensagens(db, 'c1', conversa, messages)).rejects.toBeInstanceOf(
        WhatsappDestinoAlteradoError,
      );
      expect(transaction.set).not.toHaveBeenCalled();
    },
  );
  it('accepts a newer message on the same identity without changing the accepted destination', async () => {
    current.value = { ...conversa, whatsappDestino: { ...destino, ultimaMensagemEm: 20 } };
    await persistWhatsappMensagens(db, 'c1', conversa, messages);
    expect(transaction.set).toHaveBeenCalledTimes(2);
  });

  it('reads each distinct arquivo anchor and rejects a missing attachment before writing', async () => {
    const arquivoRef = 'documents/arquivos/a1';
    const mediaMessages = [
      {
        id: 'm-media',
        data: mensagemSchema.parse({
          conteudo: 'Anexo',
          anexoStorage: arquivoRef,
          image: { image: arquivoRef },
        }),
      },
    ];
    missingArquivoIds.add('a1');

    await expect(
      persistWhatsappMensagens(db, 'c1', conversa, mediaMessages),
    ).rejects.toBeInstanceOf(WhatsappArquivoIndisponivelError);
    expect(transaction.get).toHaveBeenCalledWith('arquivos/a1');
    expect(transaction.set).not.toHaveBeenCalled();
  });
});
