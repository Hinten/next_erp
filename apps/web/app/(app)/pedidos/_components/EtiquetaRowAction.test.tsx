import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ESTADO_FRETE, INTEGRACAO_FRETE, type Pedido } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

import type { EtiquetaOutcome, EtiquetaProviderInput } from '@/lib/checkout/etiqueta/types';

const { clientes, emitirMock, getDocMock, showErrorMock, showCopyableMock, firestoreDb } =
  vi.hoisted(() => ({
    // `null` = logged out / not built; each test sets what it needs.
    clientes: {
      freight: null as unknown,
      ml: null as unknown,
      shopee: null as unknown,
    },
    emitirMock: vi.fn(),
    getDocMock: vi.fn(),
    showErrorMock: vi.fn(),
    showCopyableMock: vi.fn(),
    firestoreDb: { __db: true },
  }));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => firestoreDb }));
vi.mock('@/lib/freight/client', () => ({ useFreightClient: () => clientes.freight }));
vi.mock('@/lib/mercado-livre/client', () => ({ useMercadoLivreClient: () => clientes.ml }));
vi.mock('@/lib/shopee/client', () => ({ useShopeeClient: () => clientes.shopee }));
vi.mock('@/lib/checkout/etiqueta/registry', () => ({
  emitirOuImprimirEtiqueta: (input: EtiquetaProviderInput) => emitirMock(input),
}));
vi.mock('@/lib/print-agent/printJob', () => ({ printJob: vi.fn() }));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification: (n: unknown) => showErrorMock(n),
  showCopyableNotification: (n: unknown) => showCopyableMock(n),
}));
// A string outer ref → a fake doc ref; anything else → no ref (the real rule's
// shape, without a Firestore instance). Shared by the row AND `resolverIntFrete`.
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (_db: unknown, ref: unknown) =>
    typeof ref === 'string'
      ? { id: ref.split('/').pop(), path: ref.replace(/^documents\//, '') }
      : null,
}));
vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return { ...actual, getDoc: (ref: unknown) => getDocMock(ref) };
});

import { EtiquetaAcaoHost } from './EtiquetaAcaoHost';
import { EtiquetaRowAction } from './EtiquetaRowAction';

const SHOPEE_CLIENT = { __shopee: true };
const ML_CLIENT = { __ml: true };
const ZPL2 = 'Imprimir Etiqueta Transporte (ZPL2)';
const PDF = 'Imprimir Etiqueta Transporte (PDF)';

function pedidoCom(frete: Record<string, unknown>): Pedido {
  return {
    ehSaida: true,
    freteInicial: {
      integracaoFreteOuterRef: null,
      externalOptionIntegracao: null,
      printLabelId: null,
      externalOptionId: null,
      externalId: null,
      estado: ESTADO_FRETE.aguardandoPostagem,
      ehReverso: false,
      ...frete,
    },
  } as unknown as Pedido;
}

/** The step-5 Shopee shape: the block names the tipo, and there is NO int_frete ref. */
const PEDIDO_SHOPEE = pedidoCom({ externalOptionIntegracao: INTEGRACAO_FRETE.shopee });
const PEDIDO_ML = pedidoCom({ externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre });

function snap(id: string, data: Record<string, unknown> | null) {
  return { id, exists: () => data !== null, data: () => data };
}

function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
  );
  return (
    <QueryClientProvider client={qc}>
      <MantineTestProvider>{children}</MantineTestProvider>
    </QueryClientProvider>
  );
}

/** The row inside a page host, with a toggle standing in for the HoverCard closing. */
function PaginaComHost({ pedido }: { pedido: Pedido }) {
  const [aberto, setAberto] = useState(true);
  return (
    <EtiquetaAcaoHost>
      <button onClick={() => setAberto((a) => !a)}>alternar hovercard</button>
      {aberto && <EtiquetaRowAction pedido={pedido} pedidoId="p1" />}
    </EtiquetaAcaoHost>
  );
}

function renderComHost(pedido: Pedido) {
  return render(
    <Providers>
      <PaginaComHost pedido={pedido} />
    </Providers>,
  );
}

function botao(nome: string) {
  return screen.getByRole('button', { name: nome }) as HTMLButtonElement;
}

beforeEach(() => {
  clientes.freight = null;
  clientes.ml = null;
  clientes.shopee = SHOPEE_CLIENT;
  emitirMock.mockResolvedValue({ status: 'printed' } satisfies EtiquetaOutcome);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('EtiquetaRowAction — alcance da Shopee (#1523)', () => {
  it('um pedido Shopee SEM integracaoFreteOuterRef mostra os dois botões, sem ler int_frete', () => {
    renderComHost(PEDIDO_SHOPEE);
    expect(botao(ZPL2)).toBeTruthy();
    expect(botao(PDF)).toBeTruthy();
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('W15: os botões da Shopee ficam LIGADOS com o cliente do Mercado Livre null', () => {
    clientes.ml = null;
    clientes.shopee = SHOPEE_CLIENT;
    renderComHost(PEDIDO_SHOPEE);
    expect(botao(ZPL2).disabled).toBe(false);
    expect(botao(PDF).disabled).toBe(false);
  });

  it('near-miss: sem o cliente da SHOPEE, os botões da Shopee ficam desligados', () => {
    clientes.ml = ML_CLIENT;
    clientes.shopee = null;
    renderComHost(PEDIDO_SHOPEE);
    expect(botao(ZPL2).disabled).toBe(true);
    expect(botao(PDF).disabled).toBe(true);
  });

  it('o Mercado Livre continua dependendo do SEU cliente (e não do da Shopee)', () => {
    clientes.ml = null;
    clientes.shopee = SHOPEE_CLIENT;
    const semMl = renderComHost(PEDIDO_ML);
    expect(botao(ZPL2).disabled).toBe(true);
    semMl.unmount();

    clientes.ml = ML_CLIENT;
    clientes.shopee = null;
    renderComHost(PEDIDO_ML);
    expect(botao(ZPL2).disabled).toBe(false);
  });

  it('um bloco de marketplace NÃO lê o tipo do int_frete, mesmo com um ref de outro tipo', () => {
    renderComHost(
      pedidoCom({
        externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
        integracaoFreteOuterRef: 'documents/int_frete/if-retirada',
      }),
    );
    // The block wins (`tipoDeDespacho`): the fetch buttons, no tipo read.
    expect(botao(ZPL2)).toBeTruthy();
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('o clique despacha pelo registry com fonte bloco, o cliente da Shopee e a pergunta do host', async () => {
    clientes.ml = null;
    renderComHost(PEDIDO_SHOPEE);
    fireEvent.click(botao(ZPL2));
    await waitFor(() => expect(emitirMock).toHaveBeenCalledTimes(1));
    const input = emitirMock.mock.calls[0]![0] as EtiquetaProviderInput;
    expect(input.intFrete).toEqual({
      fonte: 'bloco',
      id: null,
      tipo: INTEGRACAO_FRETE.shopee,
      data: null,
    });
    expect(input.formato).toBe('zpl2');
    expect(input.pedidoId).toBe('p1');
    expect(input.deps.shopeeClient).toBe(SHOPEE_CLIENT);
    expect(input.deps.mercadoLivreClient).toBeNull();
    expect(typeof input.ui.escolherEnvio).toBe('function');
    // No int_frete document exists to read.
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('a pergunta de envio sobrevive ao HoverCard fechar e é respondida pelo mouse', async () => {
    let resposta: unknown = 'pendente';
    emitirMock.mockImplementation(async (input: EtiquetaProviderInput) => {
      resposta = await input.ui.escolherEnvio({
        pacoteRotulo: null,
        mensagem: 'Escolha como enviar o pacote.',
        enderecos: [
          {
            id: '200001',
            rotulo: 'Rua A, 10',
            principal: true,
            horarios: [{ id: 'slot-1', rotulo: 'Amanhã 08:00–12:00', recomendado: true }],
          },
        ],
        permiteDropoff: false,
        escolhaInvalida: false,
      });
      return { status: 'printed' };
    });
    renderComHost(PEDIDO_SHOPEE);
    fireEvent.click(botao(ZPL2));
    const confirmar = await screen.findByRole('button', { name: 'Confirmar' });
    // The HoverCard closes (the row unmounts) — the dialog is the HOST's.
    fireEvent.click(screen.getByText('alternar hovercard'));
    expect(screen.queryByRole('button', { name: ZPL2 })).toBeNull();
    fireEvent.click(confirmar);
    await waitFor(() =>
      expect(resposta).toEqual({ modo: 'pickup', enderecoId: '200001', horarioId: 'slot-1' }),
    );
  });

  it('em andamento sobrevive ao remontar da linha: não há segunda execução', async () => {
    let terminar!: () => void;
    emitirMock.mockImplementation(
      () =>
        new Promise<EtiquetaOutcome>((resolve) => {
          terminar = () => resolve({ status: 'printed' });
        }),
    );
    renderComHost(PEDIDO_SHOPEE);
    fireEvent.click(botao(ZPL2));
    await waitFor(() => expect(emitirMock).toHaveBeenCalledTimes(1));
    expect(botao(PDF).disabled).toBe(true);

    // HoverCard closes and re-opens: a fresh row mount.
    fireEvent.click(screen.getByText('alternar hovercard'));
    fireEvent.click(screen.getByText('alternar hovercard'));
    expect(botao(ZPL2).disabled).toBe(true);
    expect(botao(PDF).disabled).toBe(true);
    fireEvent.click(botao(PDF));
    expect(emitirMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      terminar();
    });
    await waitFor(() => expect(botao(PDF).disabled).toBe(false));
  });

  it('um int_frete que sumiu entre a leitura do tipo e o clique ⇒ "Integração de frete não encontrada."', async () => {
    getDocMock
      .mockResolvedValueOnce(snap('if-motoboy', { tipo: INTEGRACAO_FRETE.motoboy }))
      .mockResolvedValueOnce(snap('if-motoboy', null));
    renderComHost(pedidoCom({ integracaoFreteOuterRef: 'documents/int_frete/if-motoboy' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir etiqueta (PDF)' }));
    await waitFor(() =>
      expect(showErrorMock).toHaveBeenCalledWith({
        title: 'Etiqueta',
        message: 'Integração de frete não encontrada.',
      }),
    );
    expect(emitirMock).not.toHaveBeenCalled();
  });

  it('um bloco NÃO-marketplace continua lendo o tipo do documento (o rótulo genérico)', async () => {
    getDocMock.mockResolvedValue(snap('if-motoboy', { tipo: INTEGRACAO_FRETE.motoboy }));
    renderComHost(
      pedidoCom({
        externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios,
        integracaoFreteOuterRef: 'documents/int_frete/if-motoboy',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Imprimir etiqueta (ZPL2)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: ZPL2 })).toBeNull();
  });

  it('sem host, a linha usa e renderiza os próprios diálogos', async () => {
    emitirMock.mockImplementation(async (input: EtiquetaProviderInput) => {
      await input.ui.confirmRisk('Frete já postado.');
      return { status: 'printed' };
    });
    render(
      <Providers>
        <EtiquetaRowAction pedido={PEDIDO_SHOPEE} pedidoId="p1" />
      </Providers>,
    );
    fireEvent.click(botao(ZPL2));
    expect(await screen.findByText('Frete já postado.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(botao(ZPL2).disabled).toBe(false));
  });
});
