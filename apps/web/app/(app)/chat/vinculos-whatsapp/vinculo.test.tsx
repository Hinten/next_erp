import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';
import { clienteSchema, type Cliente } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { WhatsappClientHttpError } from '@/lib/whatsapp/client';
import Page from './[id]/page';

const { api, navigation, access } = vi.hoisted(() => ({
  api: { vinculo: vi.fn(), previsaoVinculo: vi.fn(), resolverVinculo: vi.fn() },
  navigation: { replace: vi.fn() },
  access: { write: true, create: true },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'pending1' }),
  useRouter: () => navigation,
}));
vi.mock('@/lib/auth', () => ({
  usePermission: (perm: bigint) => ({
    allowed:
      perm === PERM.cliente.write ? access.create : (perm & PERM.chat.write) === 0n || access.write,
    loading: false,
  }),
}));
vi.mock('@/lib/whatsapp/client', async (load) => ({
  ...(await load<typeof import('@/lib/whatsapp/client')>()),
  useWhatsappClient: () => api,
}));
vi.mock('@/components/pickers/ClientePicker', () => ({
  ClientePicker: ({
    onChange,
    disabled,
  }: {
    onChange: (value: string) => void;
    disabled: boolean;
  }) => (
    <>
      <button disabled={disabled} onClick={() => onChange('documents/clientes/c1')}>
        Selecionar cadastro
      </button>
      <button disabled={disabled} onClick={() => onChange('documents/clientes/c2')}>
        Selecionar outro cadastro
      </button>
    </>
  ),
}));
vi.mock('@/components/pickers/ClienteQuickCreateModal', () => ({
  ClienteQuickCreateForm: ({
    onCreate,
  }: {
    onCreate: (cliente: Cliente) => Promise<{ id: string }>;
  }) => (
    <button onClick={() => void onCreate(clienteSchema.parse({ nome: 'Maria' }))}>
      Confirmar criação
    </button>
  ),
}));
const detail = {
  pendencia: {
    id: 'pending1',
    revision: 3,
    integracaoId: 'i1',
    integracaoNome: 'Loja',
    nome: 'Maria',
    telefone: null,
    bsuid: 'bsuid1',
    motivo: 'sem_cliente',
    ultimaMensagemEm: 10,
    quantidadeMensagens: 1,
    estado: 'aguardando',
    clienteId: null,
    conversaId: null,
  },
  candidates: [],
  messages: [
    { id: 'm1', timestamp: 10, conteudo: 'Olá, preciso de ajuda', anexoUrl: null, anexoTipo: null },
  ],
  nextCursor: null,
};
let queryClient: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  access.write = true;
  access.create = true;
  api.vinculo.mockResolvedValue(detail);
  api.previsaoVinculo.mockResolvedValue({
    cliente: { id: 'c1', nome: 'Maria ERP', cpf_cnpj: '12345678901', telefone: '5511999998888' },
    conversaId: 'canonical',
  });
  api.resolverVinculo.mockResolvedValue({
    clienteId: 'c1',
    conversaId: 'canonical',
    replayPending: true,
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <MantineTestProvider>
        <Page />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
}

describe('WhatsApp contacts awaiting a cliente', () => {
  it('preserves preview until an explicit existing-client choice and opens the canonical thread', async () => {
    show();
    await screen.findByText('Olá, preciso de ajuda');
    expect(screen.getByText('Telefone não informado · Loja')).toBeTruthy();
    expect(api.resolverVinculo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar cadastro' }));
    await screen.findByText('Confira antes de vincular');
    fireEvent.click(screen.getByRole('button', { name: 'Vincular e abrir conversa' }));
    await waitFor(() =>
      expect(api.resolverVinculo).toHaveBeenCalledWith(
        'pending1',
        expect.objectContaining({
          revision: 3,
          requestId: expect.any(String),
          choice: { kind: 'existing', clienteId: 'c1' },
        }),
      ),
    );
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('/chat/canonical?vinculoWhatsapp=pending1'),
    );
  });
  it('uses the atomic backend create choice and does not do a second linking write', async () => {
    show();
    await screen.findByText('Olá, preciso de ajuda');
    fireEvent.click(screen.getByRole('button', { name: 'Criar cliente e vincular' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar criação' }));
    await waitFor(() => expect(api.resolverVinculo).toHaveBeenCalledTimes(1));
    expect(api.resolverVinculo.mock.calls[0]?.[1]).toMatchObject({
      choice: { kind: 'create', cliente: { nome: 'Maria' } },
    });
  });
  it('keeps the selected client and preview on conflict without navigating', async () => {
    api.resolverVinculo.mockRejectedValue(
      new WhatsappClientHttpError('Outro operador vinculou este contato.', 409, 'WA_CONFLICT'),
    );
    show();
    await screen.findByText('Olá, preciso de ajuda');
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar cadastro' }));
    await screen.findByText('Confira antes de vincular');
    fireEvent.click(screen.getByRole('button', { name: 'Vincular e abrir conversa' }));
    await screen.findByText('Outro operador vinculou este contato.');
    expect(screen.getByText('Olá, preciso de ajuda')).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
  it('offers read-only preview without linking or creation permissions', async () => {
    access.write = false;
    access.create = false;
    show();
    await screen.findByText('Olá, preciso de ajuda');
    expect(screen.getByRole('button', { name: 'Vincular e abrir conversa' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('button', { name: 'Criar cliente e vincular' })).toBeNull();
  });
  it('shows the chosen client, received identity and canonical thread before confirmation', async () => {
    show();
    await screen.findByText('Olá, preciso de ajuda');
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar cadastro' }));
    await screen.findByText('Maria ERP');
    expect(screen.getByText(/12345678901/)).toBeTruthy();
    expect(screen.getByText(/Contato WhatsApp: Maria/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Ver conversa que será continuada' }).getAttribute('href'),
    ).toBe('/chat/canonical');
    expect(api.previsaoVinculo).toHaveBeenCalledWith('pending1', 'c1');
    expect(api.resolverVinculo).not.toHaveBeenCalled();
  });
  it('explains when confirmation will create the first conversation', async () => {
    api.previsaoVinculo.mockResolvedValue({
      cliente: { id: 'c1', nome: 'Maria ERP', cpf_cnpj: null, telefone: null },
      conversaId: null,
    });
    show();
    await screen.findByText('Olá, preciso de ajuda');
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar cadastro' }));
    await screen.findByText('Será criada uma conversa para este cliente nesta integração.');
    expect(screen.getByText('Sem telefone principal')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Ver conversa que será continuada' })).toBeNull();
  });
  it('blocks confirmation until a failed preview is retried successfully', async () => {
    api.previsaoVinculo.mockRejectedValueOnce(
      new WhatsappClientHttpError('Falha na consulta', 503, null),
    );
    show();
    await screen.findByText('Olá, preciso de ajuda');
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar cadastro' }));
    await screen.findByText('Falha na consulta');
    expect(screen.getByRole('button', { name: 'Vincular e abrir conversa' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('Maria ERP');
    expect(screen.getByRole('button', { name: 'Vincular e abrir conversa' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  it('never enables a new selection with a late response for the earlier client', async () => {
    let completeFirst!: (value: unknown) => void;
    let completeSecond!: (value: unknown) => void;
    api.previsaoVinculo
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeSecond = resolve;
          }),
      );
    show();
    await screen.findByText('Olá, preciso de ajuda');
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar cadastro' }));
    await waitFor(() => expect(api.previsaoVinculo).toHaveBeenCalledWith('pending1', 'c1'));
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar outro cadastro' }));
    await waitFor(() => expect(api.previsaoVinculo).toHaveBeenCalledWith('pending1', 'c2'));
    await act(async () =>
      completeFirst({
        cliente: { id: 'c1', nome: 'Maria antiga', cpf_cnpj: null, telefone: null },
        conversaId: 'wrong-thread',
      }),
    );
    expect(screen.queryByText('Maria antiga')).toBeNull();
    expect(screen.getByRole('button', { name: 'Vincular e abrir conversa' })).toHaveProperty(
      'disabled',
      true,
    );
    await act(async () =>
      completeSecond({
        cliente: { id: 'c2', nome: 'Cliente escolhido', cpf_cnpj: null, telefone: null },
        conversaId: 'right-thread',
      }),
    );
    await screen.findByText('Cliente escolhido');
    fireEvent.click(screen.getByRole('button', { name: 'Vincular e abrir conversa' }));
    await waitFor(() =>
      expect(api.resolverVinculo).toHaveBeenCalledWith(
        'pending1',
        expect.objectContaining({
          choice: { kind: 'existing', clienteId: 'c2' },
        }),
      ),
    );
  });

  it('shows the identity-conflict warning before explicit confirmation without moving the phone', async () => {
    const warning =
      'Este telefone pertence a outro cliente. O vínculo seguirá a identidade WhatsApp; o telefone permanecerá no cadastro atual.';
    api.previsaoVinculo.mockResolvedValue({
      cliente: { id: 'c1', nome: 'Maria ERP', cpf_cnpj: null, telefone: null },
      conversaId: 'canonical',
      avisoIdentidade: warning,
    });
    show();
    await screen.findByText('Olá, preciso de ajuda');
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar cadastro' }));
    await screen.findByText(warning);
    expect(api.resolverVinculo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Vincular e abrir conversa' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vincular e abrir conversa' }));
    await waitFor(() =>
      expect(api.resolverVinculo).toHaveBeenCalledWith(
        'pending1',
        expect.objectContaining({
          choice: { kind: 'existing', clienteId: 'c1' },
        }),
      ),
    );
  });
  it.each(['preview', 'confirmation'] as const)(
    'offers the winning cliente and conversation after a %s conflict without selecting or submitting automatically',
    async (source) => {
      const conflict = new WhatsappClientHttpError(
        'Esta identidade já está vinculada a outro cliente.',
        409,
        'WA_VINCULO_CONFLITO',
        {
          clienteId: 'c2',
          conversaId: 'linked conversation',
        },
      );
      if (source === 'preview') api.previsaoVinculo.mockRejectedValueOnce(conflict);
      else api.resolverVinculo.mockRejectedValueOnce(conflict);
      show();
      await screen.findByText('Olá, preciso de ajuda');
      fireEvent.click(screen.getByRole('button', { name: 'Selecionar cadastro' }));
      if (source === 'confirmation') {
        await screen.findByText('Confira antes de vincular');
        fireEvent.click(screen.getByRole('button', { name: 'Vincular e abrir conversa' }));
      }
      await screen.findByText(conflict.message);
      expect(
        screen.getByRole('link', { name: 'Abrir conversa já vinculada' }).getAttribute('href'),
      ).toBe('/chat/linked%20conversation');
      expect(api.previsaoVinculo).not.toHaveBeenCalledWith('pending1', 'c2');
      expect(api.resolverVinculo).toHaveBeenCalledTimes(source === 'preview' ? 0 : 1);
      expect(navigation.replace).not.toHaveBeenCalled();

      api.previsaoVinculo.mockResolvedValue({
        cliente: { id: 'c2', nome: 'Cliente já vinculado', cpf_cnpj: null, telefone: null },
        conversaId: 'linked conversation',
      });
      fireEvent.click(screen.getByRole('button', { name: 'Selecionar cliente já vinculado' }));
      await screen.findByText('Cliente já vinculado');
      expect(api.previsaoVinculo).toHaveBeenCalledWith('pending1', 'c2');
      expect(api.resolverVinculo).toHaveBeenCalledTimes(source === 'preview' ? 0 : 1);
      expect(navigation.replace).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Vincular e abrir conversa' }));
      await waitFor(() =>
        expect(api.resolverVinculo).toHaveBeenLastCalledWith(
          'pending1',
          expect.objectContaining({
            choice: { kind: 'existing', clienteId: 'c2' },
          }),
        ),
      );
    },
  );
});
