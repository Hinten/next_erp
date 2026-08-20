import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ORIGEM_CONVERSA, conversaSchema, type Conversa } from '@delfrance/schemas';

const {
  batchSet,
  batchCommit,
  newDocIdMock,
  permAllowed,
  notifShow,
  whatsappClientRef,
  acaoPergunta,
  mlClientRef,
} = vi.hoisted(() => ({
  acaoPergunta: vi.fn(),
  mlClientRef: { value: null as { acaoPergunta: unknown } | null },
  batchSet: vi.fn(),
  batchCommit: vi.fn(async () => undefined),
  newDocIdMock: vi.fn(() => 'evt-id'),
  permAllowed: { value: true },
  notifShow: vi.fn(),
  whatsappClientRef: {
    value: { templateMessage: vi.fn(async () => ({ ok: true })) } as {
      templateMessage: (id: string) => Promise<{ ok: boolean }>;
    } | null,
  },
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/newDocId', () => ({ newDocId: newDocIdMock }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: notifShow } }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'op1', displayName: 'Operador X' } }),
  usePermission: () => ({ allowed: permAllowed.value, loading: false }),
}));
// Keep the real error CLASSES (the menu narrows on them) and stub only the hook.
vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => mlClientRef.value };
});
vi.mock('@/lib/whatsapp/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/whatsapp/client')>();
  return { ...actual, useWhatsappClient: () => whatsappClientRef.value };
});
vi.mock('@/lib/data/conversaCollection', () => ({
  conversaCollection: {
    docRef: () => ({ withConverter: () => ({ __convRefNoConverter: true }) }),
  },
  mensagemCollection: {
    docRef: (_db: unknown, ctx: { conversaId: string }, id: string) => ({
      __msgRef: `${ctx.conversaId}/${id}`,
    }),
  },
}));
vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return {
    ...actual,
    writeBatch: () => ({ set: batchSet, commit: batchCommit }),
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
    arrayRemove: (v: unknown) => ({ __arrayRemove: v }),
  };
});

import { MercadoLivreClientHttpError } from '@/lib/mercado-livre/client';
import { ConversaActionsMenu } from './ConversaActionsMenu';

function makeConversa(over: Partial<Conversa>): Conversa {
  return conversaSchema.parse({ nome: 'Cliente', origem: 'whatsapp', estadoConversa: 1, ...over });
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">{node}</MantineProvider>
    </QueryClientProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Ações da conversa' }));
}

beforeEach(() => {
  permAllowed.value = true;
  whatsappClientRef.value = { templateMessage: vi.fn(async () => ({ ok: true })) };
  mlClientRef.value = { acaoPergunta };
  acaoPergunta.mockResolvedValue({ conversaId: 'c1', acao: 'excluir' });
});

afterEach(() => {
  vi.clearAllMocks();
  batchCommit.mockImplementation(async () => undefined);
});

describe('ConversaActionsMenu — gating', () => {
  it('non-participant + whatsapp + emResposta + can-manage shows the full item set (no "Deixar")', () => {
    wrap(
      <ConversaActionsMenu
        conversaId="c1"
        conversa={makeConversa({
          usuarios: [],
          origem: ORIGEM_CONVERSA.whatsapp,
          estadoConversa: 1,
        })}
      />,
    );
    openMenu();
    expect(screen.getByText('Entrar na conversa')).toBeTruthy();
    expect(screen.getByText('Definir etiqueta')).toBeTruthy();
    expect(screen.getByText('Renomear')).toBeTruthy();
    expect(screen.getByText('Enviar mensagem padrão')).toBeTruthy();
    expect(screen.getByText('Transferir para outro atendente')).toBeTruthy();
    expect(screen.getByText('Incluir outro atendente')).toBeTruthy();
    expect(screen.getByText('Encerrar atendimento')).toBeTruthy();
    expect(screen.queryByText('Deixar a conversa')).toBeNull();
  });

  it('participant + non-whatsapp + not-emResposta + no-manage-perm hides gated items', () => {
    permAllowed.value = false;
    wrap(
      <ConversaActionsMenu
        conversaId="c1"
        conversa={makeConversa({
          usuarios: ['op1'],
          origem: ORIGEM_CONVERSA.site,
          estadoConversa: 2,
        })}
      />,
    );
    openMenu();
    expect(screen.getByText('Definir etiqueta')).toBeTruthy();
    expect(screen.getByText('Renomear')).toBeTruthy();
    expect(screen.getByText('Deixar a conversa')).toBeTruthy();
    // Gated out:
    expect(screen.queryByText('Entrar na conversa')).toBeNull();
    expect(screen.queryByText('Enviar mensagem padrão')).toBeNull();
    expect(screen.queryByText('Transferir para outro atendente')).toBeNull();
    expect(screen.queryByText('Incluir outro atendente')).toBeNull();
    expect(screen.queryByText('Encerrar atendimento')).toBeNull();
  });
});

describe('ConversaActionsMenu — rename flow', () => {
  it('renames the conversa: writes the nome patch + the rename event', async () => {
    wrap(
      <ConversaActionsMenu
        conversaId="c1"
        conversa={makeConversa({ usuarios: ['op1'], nome: 'Antigo' })}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByText('Renomear'));

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Novo nome');
    fireEvent.change(input, { target: { value: 'Novo nome' } });

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Renomear' }));
    });

    await waitFor(() => expect(batchCommit).toHaveBeenCalledTimes(1));
    const payloads = batchSet.mock.calls.map((c) => c[1] as Record<string, unknown>);
    const patch = payloads.find((p) => !('tipo' in p))!;
    const event = payloads.find((p) => 'tipo' in p)!;

    expect(patch.nome).toBe('Novo nome');
    expect(typeof patch.ultima_modificacao).toBe('number');
    expect(event.tipo).toBe('e');
    expect(event.conteudo).toBe('Operador X renomeou a conversa de Antigo para Novo nome');
  });
});

describe('ConversaActionsMenu — mensagem padrão', () => {
  it('shows a red notification and closes the modal when the whatsapp backend is not configured', async () => {
    whatsappClientRef.value = null;
    wrap(
      <ConversaActionsMenu
        conversaId="c1"
        conversa={makeConversa({ origem: ORIGEM_CONVERSA.whatsapp, usuarios: [] })}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByText('Enviar mensagem padrão'));

    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));
    });

    expect(notifShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        message: 'Backend WhatsApp não configurado.',
      }),
    );
    // The confirm modal is dismissed (no silent hang).
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('ConversaActionsMenu — Mercado Livre question moderation (#533)', () => {
  const pergunta = (over: Partial<Conversa> = {}) =>
    makeConversa({
      usuarios: ['op1'],
      origem: ORIGEM_CONVERSA.mercadoLivrePerguntas,
      integracaoOuterRef: 'documents/integracao/conta1',
      ...over,
    });

  async function confirmar(item: string, botao: string) {
    openMenu();
    fireEvent.click(screen.getByText(item));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: botao }));
    });
  }

  it('offers both items ONLY on a pergunta thread', () => {
    wrap(<ConversaActionsMenu conversaId="c1" conversa={pergunta()} />);
    openMenu();
    expect(screen.getByText('Excluir pergunta')).toBeTruthy();
    expect(screen.getByText('Bloquear usuário')).toBeTruthy();
  });

  it('offers neither on a post-sale ML thread, which has no such actions', () => {
    // mlped shares the channel but not the surface: ML's delete/block endpoints
    // are question-only, so showing them there would offer a 404 as a button.
    wrap(
      <ConversaActionsMenu
        conversaId="c1"
        conversa={pergunta({ origem: ORIGEM_CONVERSA.mercadoLivrePedido })}
      />,
    );
    openMenu();
    expect(screen.queryByText('Excluir pergunta')).toBeNull();
    expect(screen.queryByText('Bloquear usuário')).toBeNull();
  });

  it('confirms before deleting, then calls the route with the resolved account', async () => {
    wrap(<ConversaActionsMenu conversaId="c1" conversa={pergunta()} />);
    await confirmar('Excluir pergunta', 'Excluir');

    expect(acaoPergunta).toHaveBeenCalledWith({
      integracaoId: 'conta1',
      conversaId: 'c1',
      acao: 'excluir',
    });
  });

  it('writes NOTHING to the thread — the importer owns the question status', async () => {
    // ⚠️ Deleting is not "our message went away": ML changes the question's
    // status and the next notification brings it back through the importer.
    // Guessing the new state here would race that single writer.
    wrap(<ConversaActionsMenu conversaId="c1" conversa={pergunta()} />);
    await confirmar('Bloquear usuário', 'Bloquear');

    expect(acaoPergunta).toHaveBeenCalledWith(expect.objectContaining({ acao: 'bloquear' }));
    expect(batchCommit).not.toHaveBeenCalled();
    expect(batchSet).not.toHaveBeenCalled();
  });

  it('surfaces a route refusal as a red notification instead of throwing', async () => {
    acaoPergunta.mockRejectedValue(
      new MercadoLivreClientHttpError('Pergunta não encontrada no Mercado Livre', 409, null),
    );
    wrap(<ConversaActionsMenu conversaId="c1" conversa={pergunta()} />);
    await confirmar('Excluir pergunta', 'Excluir');

    expect(notifShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        message: 'Pergunta não encontrada no Mercado Livre',
      }),
    );
  });

  it('refuses when the conversa names no integração, rather than calling with an empty id', async () => {
    wrap(<ConversaActionsMenu conversaId="c1" conversa={pergunta({ integracaoOuterRef: null })} />);
    await confirmar('Excluir pergunta', 'Excluir');

    expect(acaoPergunta).not.toHaveBeenCalled();
    expect(notifShow).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
  });
});
