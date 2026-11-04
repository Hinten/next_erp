import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm } from 'react-hook-form';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import {
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  MODALIDADE_FRETE_LABELS,
  seedFreteInicial,
  travarInclusaoProduto,
  type EstadoPedido,
  type IntegracaoFrete,
  type Pedido,
} from '@delfrance/schemas';
import type { FreteInicialFormState, PedidoFormState } from '../types';

/**
 * The Frete tab of a pedido whose freight still names its conta's Loja
 * Integrada doc (master plan step 15). That doc is a ROUTER, not a carrier: the
 * body is a read-only panel pointing at the routing action, while the header —
 * the integração picker included — follows the estado lock like any pedido's.
 * So a duplicated Loja Integrada pedido (back at `iniciado`, still on the doc)
 * can be re-pointed by hand, and a paid one cannot.
 */

const mockIntFrete: {
  doc: { id: string; data: { tipo: IntegracaoFrete; nome: string } } | null;
} = { doc: null };

const seedVolume = vi.hoisted(() => vi.fn());

vi.mock('@/lib/mercado-livre/client', () => ({ useMercadoLivreClient: () => null }));
vi.mock('@/lib/auth/usePermission', () => ({
  usePermission: () => ({ allowed: true, loading: false }),
}));
vi.mock('@/components/pickers/ClientePicker', () => ({ ClientePicker: () => null }));
vi.mock('@/components/pickers/EnderecoPicker', () => ({
  EnderecoPicker: () => null,
  useEnderecoFromRef: () => ({ endereco: null }),
}));
// The picker's own filtering is `IntegracaoFreteSelect.test.tsx`'s; here only
// whether the tab hands it an ENABLED control, and which value.
vi.mock('./frete/IntegracaoFreteSelect', () => ({
  IntegracaoFreteSelect: ({ value, disabled }: { value: string | null; disabled?: boolean }) => (
    <div
      data-testid="integracao-frete-select"
      data-value={value ?? ''}
      data-disabled={String(!!disabled)}
    />
  ),
}));
vi.mock('./frete/seedVolumePadrao', async (importActual) => ({
  ...(await importActual<typeof import('./frete/seedVolumePadrao')>()),
  seedVolumePadrao: seedVolume,
}));
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: (ref: unknown) => ({
    data: ref == null ? undefined : mockIntFrete.doc,
    loading: false,
    error: undefined,
  }),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (_db: unknown, outerRef: unknown) =>
    typeof outerRef === 'string' ? { id: outerRef.split('/').filter(Boolean).pop() } : null,
}));
vi.mock('@/lib/data/intFreteCollection', () => ({
  intFreteCollection: { docRef: (_db: unknown, _parents: unknown, id: string) => ({ id }) },
}));

import { FreteTab } from './FreteTab';

const db = {} as Firestore;
const DOC_LI = {
  id: 'lojaIntegrada-c1',
  data: { tipo: INTEGRACAO_FRETE.lojaIntegrada, nome: 'Conta da loja' },
};
const REF_DOC_LI = `documents/int_frete/${DOC_LI.id}`;

function freteNoDocLi(over: Partial<FreteInicialFormState> = {}): FreteInicialFormState {
  return {
    ...(seedFreteInicial(MODALIDADE_FRETE.cif, true) as unknown as FreteInicialFormState),
    integracaoFreteOuterRef: REF_DOC_LI,
    externalOptionIntegracao: null,
    codRastreio: null,
    ...over,
  };
}

/** The tab as `PedidoForm` mounts it: `disabled` is the estado lock. */
function Host({ frete, estado }: { frete: FreteInicialFormState; estado: EstadoPedido }) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      freteInicial: frete,
      ehSaida: true,
      _itensFlat: [],
    } as unknown as PedidoFormState,
  });
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <MantineTestProvider>
      <QueryClientProvider client={queryClient}>
        <FreteTab form={form} db={db} disabled={travarInclusaoProduto(estado)} pedidoId="ped-1" />
      </QueryClientProvider>
    </MantineTestProvider>
  );
}

const painelRoteado = () =>
  screen.queryByText(/segue o Mapeamento do Frete da conta Loja Integrada/);
const alertaMarketplace = () => screen.queryByText(/Frete gerenciado pelo marketplace/);
const picker = () => screen.getByTestId('integracao-frete-select');
const selectModalidade = () =>
  screen.getAllByLabelText('Modalidade de frete')[0] as HTMLInputElement;
const selectStatus = () => screen.getAllByLabelText('Status do frete')[0] as HTMLInputElement;
const campoPrazoDespacho = () => screen.queryByLabelText('Data máxima para despacho');

beforeEach(() => {
  document.body.innerHTML = '';
  mockIntFrete.doc = DOC_LI;
  seedVolume.mockReset().mockResolvedValue(null);
});

describe('FreteTab — a pedido still on its Loja Integrada doc (the router panel)', () => {
  it('a PAID pedido: the read-only router panel, and the header locked by the estado lock', () => {
    render(<Host frete={freteNoDocLi()} estado={ESTADO_PEDIDO.pago} />);

    expect(painelRoteado()?.textContent).toMatch(/Definir transportadora/);
    // Not the marketplace panel: the store does not own this freight.
    expect(alertaMarketplace()).toBeNull();
    // The body is the panel, never an editable carrier body.
    expect(campoPrazoDespacho()).toBeNull();
    expect((screen.getByLabelText('Código de rastreio') as HTMLInputElement).readOnly).toBe(true);
    expect(picker().dataset.disabled).toBe('true');
    expect(selectModalidade().disabled).toBe(true);
    expect(selectStatus().disabled).toBe(true);
  });

  it('⭐ a DUPLICATE back at `iniciado`: the same panel, with the picker and the header ENABLED', () => {
    render(<Host frete={freteNoDocLi()} estado={ESTADO_PEDIDO.iniciado} />);

    expect(painelRoteado()).not.toBeNull();
    // The picker is the way off the router: it shows the doc and can re-point it.
    expect(picker().dataset.disabled).toBe('false');
    expect(picker().dataset.value).toBe(DOC_LI.id);
    expect(selectModalidade().disabled).toBe(false);
    expect(selectStatus().disabled).toBe(false);
  });

  it('⚠️ NEAR-MISS: a marketplace-owned doc at `iniciado` keeps its header LOCKED — the estado lock alone is the router’s', () => {
    mockIntFrete.doc = {
      id: 'ml-1',
      data: { tipo: INTEGRACAO_FRETE.mercadoLivre, nome: 'Mercado Livre' },
    };
    render(
      <Host
        frete={freteNoDocLi({ integracaoFreteOuterRef: 'documents/int_frete/ml-1' })}
        estado={ESTADO_PEDIDO.iniciado}
      />,
    );

    expect(alertaMarketplace()).not.toBeNull();
    expect(painelRoteado()).toBeNull();
    expect(picker().dataset.disabled).toBe('true');
    expect(selectModalidade().disabled).toBe(true);
  });

  it('activating the freight of a pedido on the router seeds NO volume (the import owns it)', async () => {
    render(
      <Host
        frete={freteNoDocLi({ modalidade: MODALIDADE_FRETE.semTransporte })}
        estado={ESTADO_PEDIDO.iniciado}
      />,
    );
    fireEvent.click(selectModalidade());
    fireEvent.click(await screen.findByRole('option', { name: MODALIDADE_FRETE_LABELS['0'] }));

    await waitFor(() => expect(selectModalidade().value).toBe(MODALIDADE_FRETE_LABELS['0']));
    expect(seedVolume).not.toHaveBeenCalled();
  });

  it('⚠️ NEAR-MISS: the same gesture on a Motoboy doc DOES seed the volume', async () => {
    mockIntFrete.doc = {
      id: 'mot-1',
      data: { tipo: INTEGRACAO_FRETE.motoboy, nome: 'Motoboy' },
    };
    render(
      <Host
        frete={freteNoDocLi({
          integracaoFreteOuterRef: 'documents/int_frete/mot-1',
          modalidade: MODALIDADE_FRETE.semTransporte,
        })}
        estado={ESTADO_PEDIDO.iniciado}
      />,
    );
    fireEvent.click(selectModalidade());
    fireEvent.click(await screen.findByRole('option', { name: MODALIDADE_FRETE_LABELS['0'] }));

    await waitFor(() => expect(seedVolume).toHaveBeenCalledTimes(1));
  });
});
