import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  CODIGO_ERRO_LI,
  type Pedido,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { LojaIntegradaClientHttpError } from '@/lib/loja-integrada/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';
import type { CheckoutData } from '@/lib/checkout/loadPedidoCheckout';
import type { PostSaveResult } from '@/lib/checkout/postSave';

/**
 * #1523 review 2, Q3-F1 — the checkout station's half of the Shopee client
 * threading. `postSave.test.ts` pins that the post-save USES the client it is
 * handed; this pins that the SCREEN hands over its own `useShopeeClient()`,
 * so a refactor that drops the prop (or swaps the hook for `null`) reds here
 * instead of ending every Shopee checkout in "cliente indisponível".
 *
 * Everything around the save is stubbed to the minimum that reaches
 * `runCheckoutPostSave`: the fixture seam loads an empty pedido through the
 * `?pedido=` deep link, the gates answer ok and the transaction resolves.
 */
const h = vi.hoisted(() => ({
  SHOPEE_SENTINEL: { __sentinela: 'shopee' },
  LI_SENTINEL: { __sentinela: 'loja-integrada' },
  runCheckoutPostSave: vi.fn(),
  getDoc: vi.fn(),
  /** Every props object the "Outros Checkouts" reprint modal is rendered with. */
  outroCheckoutModal: vi.fn(),
  /** The client `useLojaIntegradaClient()` answers — the sentinel unless a test swaps it. */
  liClient: null as unknown,
  /** The pre-save gates, the transaction and the read-only route preview. */
  evaluatePreSave: vi.fn(),
  salvar: vi.fn(),
  prever: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('pedido=PED-1'),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({ __db: true }) }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'u1' } }),
  usePermission: () => ({ allowed: true }),
}));
vi.mock('@/lib/nfe/client', () => ({ useNFeClient: () => null }));
vi.mock('@/lib/freight/client', () => ({ useFreightClient: () => null }));
vi.mock('@/lib/mercado-livre/client', () => ({ useMercadoLivreClient: () => null }));
vi.mock('@/lib/shopee/client', () => ({ useShopeeClient: () => h.SHOPEE_SENTINEL }));
vi.mock('@/lib/loja-integrada/client', async (importOriginal) => ({
  // The error classes stay real: the paid re-check narrows on them.
  ...(await importOriginal<typeof import('@/lib/loja-integrada/client')>()),
  useLojaIntegradaClient: () => h.liClient,
}));
vi.mock('@/lib/loja-integrada/rotaEtiqueta', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loja-integrada/rotaEtiqueta')>()),
  preverRotaEtiquetaLi: (...args: unknown[]) => h.prever(...args),
}));
vi.mock('@/lib/data/pedidoCollection', () => ({
  pedidoCollection: { docRef: () => ({ __ref: true }) },
}));
vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return { ...actual, getDoc: (ref: unknown) => h.getDoc(ref) };
});
vi.mock('@/lib/checkout/saveCheckout', () => ({
  CheckoutSaveError: class CheckoutSaveError extends Error {},
  evaluatePreSave: (...args: unknown[]) => h.evaluatePreSave(...args),
  salvarCheckoutTransacao: (...args: unknown[]) => h.salvar(...args),
}));
vi.mock('@/lib/checkout/postSave', () => ({
  runCheckoutPostSave: (args: unknown) => h.runCheckoutPostSave(args),
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showCopyableNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));
// The panes do their own Firestore / scanner I/O — none of it is under test.
vi.mock('./useScanPipeline', () => ({
  useScanPipeline: () => ({ enqueueScan: vi.fn(), resetQueue: vi.fn() }),
}));
vi.mock('./useComprarEtiquetaBridge', () => ({
  useComprarEtiquetaBridge: () => ({ comprarEtiqueta: vi.fn(), element: null }),
}));
// The REAL `CheckoutSidebar` and `OutrosCheckoutsPane` render: the reprint
// modal's Shopee client travels screen → sidebar → pane → modal, and every hop
// is a prop a refactor can drop (#1523 review 2 mutation pass, C4). Their
// leaves are stubbed, and the modal only records the props it is handed.
vi.mock('./NfeStatusTile', () => ({ NfeStatusTile: () => null }));
vi.mock('./FreteSummary', () => ({ FreteSummary: () => null }));
vi.mock('./useOutrosCheckouts', () => ({
  useOutrosCheckouts: () => ({ rows: [], loading: false, error: undefined }),
}));
vi.mock('./OutroCheckoutModal', () => ({
  OutroCheckoutModal: (props: Record<string, unknown>) => {
    h.outroCheckoutModal(props);
    return null;
  },
}));
vi.mock('./ExpectedPane', () => ({ ExpectedPane: () => null }));
vi.mock('./ScanLogPane', () => ({ ScanLogPane: () => null }));
vi.mock('./PedidoHeader', () => ({ PedidoHeader: () => null }));
vi.mock('./CheckoutBanners', () => ({ CheckoutBanners: () => null }));

import { staticFixture } from './fixtures';
import { CheckoutScreen } from './CheckoutScreen';

const DADOS: CheckoutData = {
  pedido: { numero: '1234', estado: null, freteInicial: null, itens: [] } as unknown as Pedido,
  pedidoId: 'PED-1',
  itens: [],
  produtos: new Map(),
  existingCheckout: null,
  incidentes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.liClient = h.LI_SENTINEL;
  h.evaluatePreSave.mockReturnValue({ ok: true, estadoContinuar: null });
  h.salvar.mockResolvedValue(undefined);
  h.prever.mockResolvedValue({ tipo: 'ja-roteado', tipoAlvo: 'motoboy' });
  h.getDoc.mockResolvedValue({ exists: () => false, data: () => null });
  h.runCheckoutPostSave.mockResolvedValue({
    nfe: { ok: true },
    danfe: null,
    etiqueta: null,
  } as unknown as PostSaveResult);
});

describe("CheckoutScreen — the post-save gets the SCREEN's Shopee client (#1523)", () => {
  it('Q3-F1: Salvar hands runCheckoutPostSave the screen useShopeeClient(), never null', async () => {
    render(
      <MantineTestProvider>
        <CheckoutScreen fixture={staticFixture(DADOS)} />
      </MantineTestProvider>,
    );
    const salvar = await screen.findByRole('button', { name: /Salvar/ });
    await waitFor(() => expect((salvar as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(salvar);

    await waitFor(() => expect(h.runCheckoutPostSave).toHaveBeenCalledTimes(1));
    expect(h.runCheckoutPostSave).toHaveBeenCalledWith(
      expect.objectContaining({ pedidoId: 'PED-1', shopeeClient: h.SHOPEE_SENTINEL }),
    );
  });
});

function renderTela() {
  return render(
    <MantineTestProvider>
      <CheckoutScreen fixture={staticFixture(DADOS)} />
    </MantineTestProvider>,
  );
}

async function salvar() {
  const botao = (await screen.findByRole('button', { name: /Salvar/ })) as HTMLButtonElement;
  await waitFor(() => expect(botao.disabled).toBe(false));
  fireEvent.click(botao);
}

describe('CheckoutScreen — the reprint pane and the pickup question (#1523)', () => {
  it('C4: the "Outros Checkouts" reprint modal gets the SAME client — screen → sidebar → pane → modal', async () => {
    renderTela();
    await waitFor(() => expect(h.outroCheckoutModal).toHaveBeenCalled());
    // Every render, never a transient null: a null anywhere on the chain fails
    // every Shopee reprint from this pane with the missing-client error.
    for (const [props] of h.outroCheckoutModal.mock.calls) {
      expect(props).toEqual(expect.objectContaining({ shopeeClient: h.SHOPEE_SENTINEL }));
    }
  });

  it("C5: the post-save's pickup question opens ON the screen, and Cancelar settles it (the save ends)", async () => {
    let resposta: unknown = 'pendente';
    h.runCheckoutPostSave.mockImplementation(async (args: { ui: EtiquetaProviderUi }) => {
      resposta = await args.ui.escolherEnvio({
        pedidoRotulo: '1234',
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
        permiteDropoff: true,
        escolhaInvalida: false,
      });
      return { nfe: { ok: true }, danfe: null, etiqueta: null } as unknown as PostSaveResult;
    });
    renderTela();
    await salvar();

    expect(await screen.findByText('Pedido 1234 — Como enviar o pacote')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(resposta).toBeNull());
    // The post-save returned, so the screen reset for the next pedido.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Salvar/ })).toBeNull());
  });
});

describe('CheckoutScreen — the Loja Integrada paid re-check (step 15)', () => {
  it('Salvar hands runCheckoutPostSave the screen useLojaIntegradaClient()', async () => {
    renderTela();
    await salvar();

    await waitFor(() => expect(h.runCheckoutPostSave).toHaveBeenCalledTimes(1));
    expect(h.runCheckoutPostSave).toHaveBeenCalledWith(
      expect.objectContaining({ lojaIntegradaClient: h.LI_SENTINEL }),
    );
  });

  it('the reprint modal gets the SAME client — screen → sidebar → pane → modal', async () => {
    renderTela();
    await waitFor(() => expect(h.outroCheckoutModal).toHaveBeenCalled());
    for (const [props] of h.outroCheckoutModal.mock.calls) {
      expect(props).toEqual(expect.objectContaining({ lojaIntegradaClient: h.LI_SENTINEL }));
    }
  });

  it("the post-save's `confirmarCiente` keeps Continuar disabled until the tick, ON the screen", async () => {
    let resposta: unknown = 'pendente';
    h.runCheckoutPostSave.mockImplementation(async (args: { ui: EtiquetaProviderUi }) => {
      resposta = await args.ui.confirmarCiente({
        titulo: 'Pagamento não confirmado na Loja Integrada',
        mensagem: 'Imprimir a etiqueta deste pedido pode levar ao despacho.',
      });
      return { nfe: { ok: true }, danfe: null, etiqueta: null } as unknown as PostSaveResult;
    });
    renderTela();
    await salvar();

    const dialogo = await screen.findByRole('dialog');
    const continuar = within(dialogo).getByRole<HTMLButtonElement>('button', {
      name: 'Continuar',
    });
    expect(continuar.disabled).toBe(true);
    fireEvent.click(within(dialogo).getByRole('checkbox', { name: 'Estou ciente do risco' }));
    expect(continuar.disabled).toBe(false);
    fireEvent.click(continuar);

    await waitFor(() => expect(resposta).toBe(true));
  });
});

/**
 * Gate (i) of the paid re-check (master plan step 15): before the checkout
 * transaction — which removes stock — an imported Loja Integrada order's
 * CURRENT payment is asked of the backend. It runs after the confirm loop's
 * last dialog (so the window to the commit is as short as it can be) and never
 * inside the transaction: it is a network read, which a transaction callback
 * must not hold.
 */
describe('CheckoutScreen — the Loja Integrada paid re-check before the save (gate i)', () => {
  const ID_LI = createHash('sha256').update('lojaIntegradaCONTA1-165').digest('hex');
  const DADOS_LI: CheckoutData = {
    ...DADOS,
    pedidoId: ID_LI,
    pedido: { ...DADOS.pedido, numero: '165' } as Pedido,
  };
  const FRESCO_LI = {
    estado: 'pago',
    numero: '165',
    integracaoPedidoOuterRef: 'documents/integracao/CONTA1',
    freteInicial: {
      integracaoFreteOuterRef: 'documents/int_frete/mot-1',
      enderecoFreteOuterReference: 'documents/clientes/c1/enderecos/e1',
      modalidade: '0',
      estado: 'emSeparacao',
    },
    itens: {},
  };
  const PAGO: RespostaConferenciaPagamentoLi = {
    aplicavel: true,
    fonte: 'loja',
    veredito: 'pago',
    codigo: 'pedido_pago',
    motivoContestacao: null,
    conferidoEmMs: 1_790_000_000_000,
    correlationId: null,
  };
  const conferir = vi.fn();

  beforeEach(() => {
    conferir.mockReset();
    h.liClient = lojaIntegradaClientFalso({ conferirPagamento: conferir });
    h.getDoc.mockResolvedValue({ exists: () => true, data: () => FRESCO_LI });
  });

  function renderLi(dados: CheckoutData = DADOS_LI) {
    return render(
      <MantineTestProvider>
        <CheckoutScreen fixture={staticFixture(dados)} />
      </MantineTestProvider>,
    );
  }

  it('⭐ runs AFTER the last confirm of the gate loop and BEFORE the transaction; a `pago` saves', async () => {
    h.evaluatePreSave
      .mockReturnValueOnce({
        ok: false,
        decision: 'confirm',
        kind: 'frete-estado',
        title: 'Atenção',
        message: 'Este pedido não está no estado "Despacho autorizado". Deseja continuar?',
      })
      .mockReturnValue({ ok: true, estadoContinuar: 'iniciado' });
    conferir.mockResolvedValue(PAGO);
    renderLi();
    await salvar();

    const dialogo = await screen.findByRole('dialog');
    // The loop's confirm is open: nothing has been asked of Loja Integrada yet.
    expect(conferir).not.toHaveBeenCalled();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Continuar' }));

    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    expect(conferir).toHaveBeenCalledTimes(1);
    expect(conferir.mock.calls[0]![0]).toBe(ID_LI);
    expect(conferir.mock.invocationCallOrder[0]!).toBeLessThan(
      h.salvar.mock.invocationCallOrder[0]!,
    );
  });

  it("a `pago` rides the post-save as the chain's carried verdict, for THIS pedido", async () => {
    conferir.mockResolvedValue(PAGO);
    renderLi();
    await salvar();

    await waitFor(() => expect(h.runCheckoutPostSave).toHaveBeenCalledTimes(1));
    expect(h.runCheckoutPostSave).toHaveBeenCalledWith(
      expect.objectContaining({
        conferenciaLi: expect.objectContaining({
          tipo: 'resposta',
          pedidoId: ID_LI,
          resposta: PAGO,
        }),
      }),
    );
  });

  it('`nao-pago` BLOCKS: no transaction, no post-save, and the toast says the checkout was not saved', async () => {
    conferir.mockResolvedValue({ ...PAGO, veredito: 'nao-pago', codigo: 'aguardando_pagamento' });
    renderLi();
    await salvar();

    await waitFor(() => expect(showErrorNotification).toHaveBeenCalledTimes(1));
    expect(vi.mocked(showErrorNotification).mock.calls[0]![0].message).toMatch(
      /não como pago\. O checkout não foi salvo\.$/,
    );
    expect(h.salvar).not.toHaveBeenCalled();
    expect(h.runCheckoutPostSave).not.toHaveBeenCalled();
  });

  it('an open contested aviso (the ERP mirror) BLOCKS like a live verdict', async () => {
    conferir.mockResolvedValue({
      aplicavel: true,
      fonte: 'erp',
      veredito: 'contestado',
      codigo: null,
      motivoContestacao: 'disputa',
      conferidoEmMs: null,
      correlationId: null,
    });
    renderLi();
    await salvar();

    await waitFor(() => expect(showErrorNotification).toHaveBeenCalledTimes(1));
    expect(h.salvar).not.toHaveBeenCalled();
  });

  it('the read switch OFF asks the configuration confirm; Cancelar saves nothing', async () => {
    conferir.mockRejectedValue(
      new LojaIntegradaClientHttpError('desligada', 503, CODIGO_ERRO_LI.chamadasDesligadas),
    );
    renderLi();
    await salvar();

    const dialogo = await screen.findByRole('dialog');
    expect(
      within(dialogo).getByText(/não está disponível \(a chave de chamadas está desligada\)/),
    ).toBeTruthy();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.salvar).not.toHaveBeenCalled();
    expect(showErrorNotification).not.toHaveBeenCalled();
  });

  it('⭐ a backend without the payment route (404, no envelope) asks — it never blocks silently and never passes silently', async () => {
    conferir.mockRejectedValue(new LojaIntegradaClientHttpError('sem rota', 404, null));
    renderLi();
    await salvar();

    const dialogo = await screen.findByRole('dialog');
    expect(
      within(dialogo).getByText(/o backend da Loja Integrada ainda não oferece esta conferência/),
    ).toBeTruthy();
    expect(h.salvar).not.toHaveBeenCalled();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Continuar' }));

    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    // A confirm carries no verdict: the chain's next gate asks again.
    await waitFor(() => expect(h.runCheckoutPostSave).toHaveBeenCalledTimes(1));
    expect(h.runCheckoutPostSave).toHaveBeenCalledWith(
      expect.objectContaining({ conferenciaLi: null }),
    );
  });

  it('while the check runs, Salvar says so', async () => {
    let responder: (r: RespostaConferenciaPagamentoLi) => void = () => undefined;
    conferir.mockReturnValue(
      new Promise<RespostaConferenciaPagamentoLi>((resolve) => {
        responder = resolve;
      }),
    );
    renderLi();
    await salvar();

    expect(await screen.findByText('Conferindo pagamento na Loja Integrada…')).toBeTruthy();
    responder(PAGO);
    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText('Conferindo pagamento na Loja Integrada…')).toBeNull(),
    );
  });

  it('⚠️ NEAR-MISS: a pedido that is not an imported Loja Integrada order never calls — not even a preview read', async () => {
    h.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ ...FRESCO_LI, integracaoPedidoOuterRef: 'documents/integracao/balcao' }),
    });
    renderLi(DADOS);
    await salvar();

    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    expect(conferir).not.toHaveBeenCalled();
    expect(h.prever).not.toHaveBeenCalled();
    expect(h.runCheckoutPostSave).toHaveBeenCalledWith(
      expect.objectContaining({ conferenciaLi: null }),
    );
  });

  it('A3: a label route the backend would refuse warns BEFORE the payment check; Cancelar asks nothing more', async () => {
    h.prever.mockResolvedValue({
      tipo: 'recusa',
      motivo: 'sem-mapeamento',
      mensagem: 'Esta forma de envio não está mapeada para uma transportadora.',
    });
    renderLi();
    await salvar();

    const dialogo = await screen.findByRole('dialog');
    expect(
      within(dialogo).getByText(/A etiqueta deste pedido não poderá ser gerada depois do checkout/),
    ).toBeTruthy();
    expect(conferir).not.toHaveBeenCalled();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(conferir).not.toHaveBeenCalled();
    expect(h.salvar).not.toHaveBeenCalled();
  });

  it('A3: Continuar on the route warning goes on to the payment check, then the save', async () => {
    h.prever.mockResolvedValue({
      tipo: 'recusa',
      motivo: 'sem-mapeamento',
      mensagem: 'Esta forma de envio não está mapeada para uma transportadora.',
    });
    conferir.mockResolvedValue(PAGO);
    renderLi();
    await salvar();

    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Continuar' }));

    await waitFor(() => expect(h.salvar).toHaveBeenCalledTimes(1));
    expect(conferir).toHaveBeenCalledTimes(1);
    expect(h.prever.mock.invocationCallOrder[0]!).toBeLessThan(
      conferir.mock.invocationCallOrder[0]!,
    );
  });
});
