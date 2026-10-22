import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ESTADO_FRETE,
  INTEGRACAO_FRETE,
  type Pedido,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

import type { EtiquetaOutcome, EtiquetaProviderInput } from '@/lib/checkout/etiqueta/types';

const { clientes, emitirMock, getDocMock, showErrorMock, showCopyableMock, firestoreDb } =
  vi.hoisted(() => ({
    // `null` = logged out / not built; each test sets what it needs.
    clientes: {
      freight: null as unknown,
      ml: null as unknown,
      shopee: null as unknown,
      li: null as unknown,
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
// Partial: the soft gate narrows on the client's REAL error classes.
vi.mock('@/lib/loja-integrada/client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/loja-integrada/client')>()),
  useLojaIntegradaClient: () => clientes.li,
}));
vi.mock('@/lib/auth/usePermission', () => ({
  usePermission: () => ({ allowed: true, loading: false }),
}));
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
// A FUTURE fetch provider (Q4-3): Magalu's caps flipped to `canFetchLabel`
// WITHOUT the row learning its client — the shape of "flip the caps and forget
// the row". Every other tipo keeps its real caps.
vi.mock('@delfrance/schemas', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/schemas')>('@delfrance/schemas');
  return {
    ...actual,
    freightCapsFor: (tipo: string | null | undefined) =>
      tipo === actual.INTEGRACAO_FRETE.magalu
        ? { ...actual.freightCapsFor(tipo), canFetchLabel: true }
        : actual.freightCapsFor(tipo),
  };
});

import { EtiquetaAcaoHost, useEtiquetaAcao, type RotaRegistrada } from './EtiquetaAcaoHost';
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
function PaginaComHost({ pedido, pedidoId = 'p1' }: { pedido: Pedido; pedidoId?: string }) {
  const [aberto, setAberto] = useState(true);
  return (
    <EtiquetaAcaoHost>
      <button onClick={() => setAberto((a) => !a)}>alternar hovercard</button>
      <RegistrarRota pedidoId={pedidoId} />
      {aberto && <EtiquetaRowAction pedido={pedido} pedidoId={pedidoId} />}
    </EtiquetaAcaoHost>
  );
}

/**
 * Stands in for the routing click (15-b): registers a routed freight with the
 * host, the way the `'rotear'` branch will after the route answers.
 */
const rotaParaRegistrar = { registro: null as RotaRegistrada | null };
function RegistrarRota({ pedidoId }: { pedidoId: string }) {
  const host = useEtiquetaAcao();
  return (
    <button
      onClick={() => {
        if (rotaParaRegistrar.registro !== null) {
          host?.registrarRota(pedidoId, rotaParaRegistrar.registro);
        }
      }}
    >
      registrar rota
    </button>
  );
}

function renderComHost(pedido: Pedido, pedidoId?: string) {
  return render(
    <Providers>
      <PaginaComHost pedido={pedido} {...(pedidoId === undefined ? {} : { pedidoId })} />
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
  clientes.li = null;
  rotaParaRegistrar.registro = null;
  emitirMock.mockResolvedValue({ status: 'printed' } satisfies EtiquetaOutcome);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('EtiquetaRowAction — alcance da Shopee (#1523)', () => {
  it('tracks an ML shipment from the row without requesting a label', async () => {
    const rastrear = vi
      .fn()
      .mockResolvedValue({ name: 'Carrier', url: 'https://carrier.example/track' });
    clientes.ml = { rastrear };
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      opener: null,
      closed: false,
      location: { replace },
    } as unknown as Window);
    renderComHost(
      pedidoCom({
        externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre,
        externalId: '555',
        codRastreio: null,
      }),
    );
    fireEvent.click(botao('Rastrear'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://carrier.example/track'));
    expect(rastrear).toHaveBeenCalledExactlyOnceWith('p1');
    expect(emitirMock).not.toHaveBeenCalled();
  });

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

  it('Q4-3: um tipo de fetch SEM ramo de cliente na linha fica DESLIGADO (falha fechada), mesmo com todos os clientes', () => {
    clientes.freight = { __freight: true };
    clientes.ml = ML_CLIENT;
    clientes.shopee = SHOPEE_CLIENT;
    renderComHost(pedidoCom({ externalOptionIntegracao: INTEGRACAO_FRETE.magalu }));
    // It reaches the fetch action (the caps say so)…
    expect(botao(ZPL2).disabled).toBe(true);
    expect(botao(PDF).disabled).toBe(true);
    // …and a click starts nothing.
    fireEvent.click(botao(ZPL2));
    expect(emitirMock).not.toHaveBeenCalled();
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
        pedidoRotulo: null,
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

/**
 * The twins of "a pergunta de envio sobrevive ao HoverCard fechar" for the
 * row's two CONFIRMS (#1523 review 2 mutation pass, R7/R8). Under a host the
 * row renders no dialog of its own (`dialogosLocais` is null), so a confirm
 * routed through the row-local instance opens on NOTHING: the click awaits an
 * invisible dialog and the row stays "em andamento" for good.
 */
describe('EtiquetaRowAction — os confirms da linha são do HOST', () => {
  it('R7: o confirm de risco (frete já postado) abre pelo host, sobrevive ao HoverCard fechar e responde', async () => {
    clientes.ml = ML_CLIENT;
    let risco: unknown = 'pendente';
    emitirMock.mockImplementation(async (input: EtiquetaProviderInput) => {
      risco = await input.ui.confirmRisk('Frete já postado.');
      return { status: 'printed' };
    });
    renderComHost(
      pedidoCom({
        externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre,
        estado: ESTADO_FRETE.postado,
      }),
    );
    fireEvent.click(botao(ZPL2));
    expect(await screen.findByText('Frete já postado.')).toBeTruthy();
    // The HoverCard closes (the row unmounts) — the confirm is the HOST's.
    fireEvent.click(screen.getByText('alternar hovercard'));
    expect(screen.queryByRole('button', { name: ZPL2 })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(risco).toBe(true));
  });

  it('R8: o confirm de direção (frete reverso numa saída) abre pelo host, sobrevive ao HoverCard fechar, e só então despacha', async () => {
    renderComHost(
      pedidoCom({ externalOptionIntegracao: INTEGRACAO_FRETE.shopee, ehReverso: true }),
    );
    fireEvent.click(botao(ZPL2));
    expect(await screen.findByText(/Este pedido é uma Saída/)).toBeTruthy();
    // Asked BEFORE the registry is reached.
    expect(emitirMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('alternar hovercard'));
    expect(screen.queryByRole('button', { name: ZPL2 })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(emitirMock).toHaveBeenCalledTimes(1));
  });

  it('R8 near-miss: Cancelar no confirm de direção não despacha nada e libera a linha', async () => {
    renderComHost(
      pedidoCom({ externalOptionIntegracao: INTEGRACAO_FRETE.shopee, ehReverso: true }),
    );
    fireEvent.click(botao(ZPL2));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(botao(ZPL2).disabled).toBe(false));
    expect(emitirMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                      Loja Integrada (master plan step 15)                   */
/* -------------------------------------------------------------------------- */

const ID_LI = createHash('sha256').update('lojaIntegradaCONTA1-165').digest('hex');
const IDENTIDADE_LI = { numero: '165', integracaoPedidoOuterRef: 'documents/integracao/CONTA1' };
const LI_CLIENT_SEM_CHAMADA = lojaIntegradaClientFalso();

function respostaLi(veredito: 'pago' | 'nao-pago'): RespostaConferenciaPagamentoLi {
  return {
    aplicavel: true,
    fonte: 'loja',
    veredito,
    codigo: veredito === 'pago' ? 'pedido_pago' : 'pagamento_em_disputa',
    motivoContestacao: veredito === 'pago' ? null : 'disputa',
    conferidoEmMs: 0,
    correlationId: null,
  };
}

/** Answers each `int_frete` read by the doc id the ref names. */
function docsPorId(docs: Record<string, Record<string, unknown>>) {
  getDocMock.mockImplementation(async (ref: { id: string }) => snap(ref.id, docs[ref.id] ?? null));
}

describe('EtiquetaRowAction — a rota que o host guarda (B14)', () => {
  const PEDIDO_NO_DOC_LI = pedidoCom({
    integracaoFreteOuterRef: 'documents/int_frete/li-doc',
    estado: ESTADO_FRETE.iniciado,
  });

  beforeEach(() => {
    docsPorId({
      'li-doc': { tipo: INTEGRACAO_FRETE.lojaIntegrada },
      'if-motoboy': { tipo: INTEGRACAO_FRETE.motoboy },
      'if-me': { tipo: INTEGRACAO_FRETE.melhorEnvios },
    });
    rotaParaRegistrar.registro = {
      refAnterior: 'documents/int_frete/li-doc',
      rota: {
        integracaoFreteOuterRef: 'documents/int_frete/if-motoboy',
        externalOptionId: null,
        integracaoTargetOuterRef: null,
        estado: null,
      },
    };
  });

  it('⚠️ NEAR-MISS: once the LIST catches up, its newer copy wins — a label bought after routing shows the reprint, never the buy again', async () => {
    rotaParaRegistrar.registro = {
      refAnterior: 'documents/int_frete/li-doc',
      rota: {
        integracaoFreteOuterRef: 'documents/int_frete/if-me',
        externalOptionId: '1',
        integracaoTargetOuterRef: null,
        estado: null,
      },
    };
    const view = renderComHost(PEDIDO_NO_DOC_LI);
    expect(await screen.findByText(/ainda não suportada/)).toBeTruthy();

    fireEvent.click(screen.getByText('registrar rota'));
    expect(await screen.findByRole('button', { name: 'Comprar etiqueta' })).toBeTruthy();

    // The live list delivers the pedido as the buy left it: routed, with a label.
    const comprado = pedidoCom({
      integracaoFreteOuterRef: 'documents/int_frete/if-me',
      externalOptionId: '1',
      printLabelId: 'lbl-1',
      estado: ESTADO_FRETE.iniciado,
    });
    view.rerender(
      <Providers>
        <PaginaComHost pedido={comprado} />
      </Providers>,
    );

    expect(await screen.findByRole('button', { name: 'Imprimir etiqueta' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Comprar etiqueta' })).toBeNull();
  });

  it("⭐ after the HoverCard remounts, the row reads the host's routed freight — its target's action, and the registry gets THAT freight", async () => {
    renderComHost(PEDIDO_NO_DOC_LI);
    expect(await screen.findByText(/ainda não suportada/)).toBeTruthy();

    fireEvent.click(screen.getByText('registrar rota'));
    // The HoverCard closes and re-opens: a fresh row mount.
    fireEvent.click(screen.getByText('alternar hovercard'));
    fireEvent.click(screen.getByText('alternar hovercard'));

    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir etiqueta (PDF)' }));
    await waitFor(() => expect(emitirMock).toHaveBeenCalledTimes(1));
    const input = emitirMock.mock.calls[0]![0] as EtiquetaProviderInput;
    expect(input.frete.integracaoFreteOuterRef).toBe('documents/int_frete/if-motoboy');
    expect(input.pedido.freteInicial).toBe(input.frete);
    expect(input.intFrete).toMatchObject({ fonte: 'doc', id: 'if-motoboy' });
  });

  it('⚠️ NEAR-MISS: with nothing registered, the remounted row keeps the list freight', async () => {
    renderComHost(PEDIDO_NO_DOC_LI);
    expect(await screen.findByText(/ainda não suportada/)).toBeTruthy();

    fireEvent.click(screen.getByText('alternar hovercard'));
    fireEvent.click(screen.getByText('alternar hovercard'));

    expect(await screen.findByText(/ainda não suportada/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Imprimir etiqueta (PDF)' })).toBeNull();
  });

  it('a route registered for ANOTHER pedido does not leak into this row', async () => {
    render(
      <Providers>
        <EtiquetaAcaoHost>
          <RegistrarRota pedidoId="outro" />
          <EtiquetaRowAction pedido={PEDIDO_NO_DOC_LI} pedidoId="p1" />
        </EtiquetaAcaoHost>
      </Providers>,
    );
    fireEvent.click(screen.getByText('registrar rota'));

    expect(await screen.findByText(/ainda não suportada/)).toBeTruthy();
  });
});

describe('EtiquetaRowAction — a conferência de pagamento antes de imprimir (A2)', () => {
  const PEDIDO_ME_LI = {
    ...pedidoCom({
      integracaoFreteOuterRef: 'documents/int_frete/if-me',
      printLabelId: 'lbl-1',
      estado: ESTADO_FRETE.aguardandoPostagem,
    }),
    ...IDENTIDADE_LI,
  } as Pedido;

  function cenario(veredito: 'pago' | 'nao-pago') {
    const conferirPagamento = vi.fn(async () => respostaLi(veredito));
    clientes.li = lojaIntegradaClientFalso({ conferirPagamento });
    const imprimir = vi.fn(async () => ({ url: 'https://me/label.pdf' }));
    clientes.freight = { imprimir, rastrear: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(null);
    docsPorId({ 'if-me': { tipo: INTEGRACAO_FRETE.melhorEnvios } });
    return { conferirPagamento, imprimir };
  }

  it('⭐ the Melhor Envio REPRINT with `nao-pago`: Continuar stays off until "Estou ciente do risco", then prints', async () => {
    const s = cenario('nao-pago');
    renderComHost(PEDIDO_ME_LI, ID_LI);

    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir etiqueta' }));
    expect(
      await screen.findByText('Pedido 165 — Pagamento não confirmado na Loja Integrada'),
    ).toBeTruthy();
    const continuar = screen.getByRole<HTMLButtonElement>('button', { name: 'Continuar' });
    expect(continuar.disabled).toBe(true);
    expect(s.imprimir).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Estou ciente do risco' }));
    expect(continuar.disabled).toBe(false);
    fireEvent.click(continuar);

    await waitFor(() => expect(s.imprimir).toHaveBeenCalledWith('if-me', 'lbl-1'));
    expect(s.conferirPagamento).toHaveBeenCalledWith(ID_LI, undefined);
  });

  it('⚠️ NEAR-MISS: Cancelar on the warning prints nothing and frees the row', async () => {
    const s = cenario('nao-pago');
    renderComHost(PEDIDO_ME_LI, ID_LI);

    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir etiqueta' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(botao('Imprimir etiqueta').disabled).toBe(false));
    expect(s.imprimir).not.toHaveBeenCalled();
  });

  it('`pago` prints with no dialog', async () => {
    const s = cenario('pago');
    renderComHost(PEDIDO_ME_LI, ID_LI);

    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir etiqueta' }));

    await waitFor(() => expect(s.imprimir).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Pagamento não confirmado na Loja Integrada/)).toBeNull();
  });

  it('a pedido that is not an imported order (another id) never calls the backend', async () => {
    const s = cenario('nao-pago');
    renderComHost(PEDIDO_ME_LI, 'p1');

    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir etiqueta' }));

    await waitFor(() => expect(s.imprimir).toHaveBeenCalledTimes(1));
    expect(s.conferirPagamento).not.toHaveBeenCalled();
  });

  it('Rastrear never runs the check', async () => {
    const s = cenario('nao-pago');
    const rastrear = vi.fn(async () => ({ tracking: {} }));
    clientes.freight = { imprimir: s.imprimir, rastrear };
    renderComHost(PEDIDO_ME_LI, ID_LI);

    fireEvent.click(await screen.findByRole('button', { name: 'Rastrear' }));

    await waitFor(() => expect(rastrear).toHaveBeenCalledTimes(1));
    expect(s.conferirPagamento).not.toHaveBeenCalled();
  });

  it("the registry path gets the row's Loja Integrada client and a `confirmarCiente` with the required tick", async () => {
    clientes.li = LI_CLIENT_SEM_CHAMADA;
    docsPorId({ 'if-motoboy': { tipo: INTEGRACAO_FRETE.motoboy } });
    let resposta: unknown = 'pendente';
    emitirMock.mockImplementation(async (input: EtiquetaProviderInput) => {
      resposta = await input.ui.confirmarCiente({ titulo: 'Risco', mensagem: 'Aviso de risco.' });
      return { status: 'printed' };
    });
    renderComHost(pedidoCom({ integracaoFreteOuterRef: 'documents/int_frete/if-motoboy' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir etiqueta (PDF)' }));
    const continuar = await screen.findByRole<HTMLButtonElement>('button', { name: 'Continuar' });
    expect(continuar.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Estou ciente do risco' }));
    fireEvent.click(continuar);

    await waitFor(() => expect(resposta).toBe(true));
    const input = emitirMock.mock.calls[0]![0] as EtiquetaProviderInput;
    expect(input.deps.lojaIntegradaClient).toBe(LI_CLIENT_SEM_CHAMADA);
  });
});
