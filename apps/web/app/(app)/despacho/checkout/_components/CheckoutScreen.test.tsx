import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Pedido } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

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
  runCheckoutPostSave: vi.fn(),
  getDoc: vi.fn(),
  /** Every props object the "Outros Checkouts" reprint modal is rendered with. */
  outroCheckoutModal: vi.fn(),
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
vi.mock('@/lib/data/pedidoCollection', () => ({
  pedidoCollection: { docRef: () => ({ __ref: true }) },
}));
vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return { ...actual, getDoc: (ref: unknown) => h.getDoc(ref) };
});
vi.mock('@/lib/checkout/saveCheckout', () => ({
  CheckoutSaveError: class CheckoutSaveError extends Error {},
  evaluatePreSave: () => ({ ok: true, estadoContinuar: null }),
  salvarCheckoutTransacao: async () => undefined,
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
