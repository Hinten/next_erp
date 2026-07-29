import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ORIGEM_CONVERSA, conversaSchema, type Conversa } from '@delfrance/schemas';

const { batchSet, batchCommit, newDocIdMock, permAllowed, notifShow, whatsappClientRef } =
  vi.hoisted(() => ({
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
