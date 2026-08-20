import { useEffect, useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { Tabs } from '@mantine/core';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import type { Pedido } from '@delfrance/schemas';
import { MODALIDADE_FRETE } from '@delfrance/schemas';
import type { FreteInicialFormState, PedidoFormState, VolumeFormState } from '../types';
import { seedFreteInicial } from './frete/seedFreteInicial';
import { FreteTab } from './FreteTab';
import { notifications } from '@mantine/notifications';
import { loadProdutoPesoMap } from './frete/produtoPeso';
import { DIMENSOES_PADRAO, type ProdutoMedidas } from './frete/pesoPedido';

// #371/#1093: the default Volume is seeded from the modalidade GESTURE, not a
// mount effect. PedidoForm's Tabs use `keepMounted={false}`, so the earlier
// effect-plus-`useRef` version lost the activation whenever the operator
// switched tabs before the weight batch landed (and re-fired on remounts).
// These tests unmount the panel for real, mid-fetch, to pin that.

vi.mock('./frete/produtoPeso', () => ({ loadProdutoPesoMap: vi.fn() }));
const loadMock = vi.mocked(loadProdutoPesoMap);

vi.mock('@/components/pickers/ClientePicker', () => ({ ClientePicker: () => null }));
vi.mock('@/components/pickers/EnderecoPicker', () => ({
  EnderecoPicker: () => null,
  useEnderecoFromRef: () => ({ endereco: null }),
}));
vi.mock('./frete/IntegracaoFreteSelect', () => ({ IntegracaoFreteSelect: () => null }));
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({ dereferenceOuterRef: () => null }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
const notifyMock = vi.mocked(notifications.show);

const db = {} as Firestore;
const MODALIDADE_FOB = 'Contratação por conta do Destinatário (FOB)';
const SEM_TRANSPORTE = 'Sem ocorrência de transporte';

let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function Host({
  frete,
  children,
}: {
  frete: FreteInicialFormState | null;
  children: (tab: string | null) => ReactNode;
}) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      freteInicial: frete,
      ehSaida: true,
      _itensFlat: [{ produtoUid: 'p1', quantidade: 3 }],
    } as unknown as PedidoFormState,
  });
  useEffect(() => {
    formRef = form;
  }, [form]);
  const [tab, setTab] = useState<string | null>('frete');
  return (
    <MantineTestProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="frete">Frete</Tabs.Tab>
            <Tabs.Tab value="outra">Outra</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="frete" pt="md">
            {tab === 'frete' && <FreteTab form={form} db={db} />}
          </Tabs.Panel>
          <Tabs.Panel value="outra" pt="md">
            Outra aba
          </Tabs.Panel>
        </Tabs>
        {children(tab)}
      </QueryClientProvider>
    </MantineTestProvider>
  );
}

/** A pedido that already has frete active (FOB, no volumes yet). */
function freteAtivo(): FreteInicialFormState {
  return seedFreteInicial(MODALIDADE_FRETE.fob, true) as unknown as FreteInicialFormState;
}

function renderTab(frete: FreteInicialFormState | null = null) {
  return render(<Host frete={frete}>{() => null}</Host>);
}

/**
 * Drive the Mantine modalidade Select to `label`.
 *
 * Queries are scoped to THIS render's container, not the global `screen`:
 * Mantine portals the dropdown into `document.body`, so a body-wide query can
 * match a node left behind by an earlier test and click a detached input that
 * opens nothing.
 */
async function pickModalidade(view: RenderResult, label: string) {
  // The label is attached to both the visible input and the hidden native
  // select — the input is the first. The dropdown opens asynchronously.
  fireEvent.click(view.getAllByLabelText('Modalidade de frete')[0]!);
  fireEvent.click(await view.findByRole('option', { name: label }));
}

const volumes = () =>
  formRef.getValues('freteInicial.volumes' as never) as unknown as VolumeFormState[] | null;

/** A produto with no dimensions — these suites only exercise the weight. */
const medidas = (over: Partial<ProdutoMedidas> = {}): ProdutoMedidas => ({
  pesoBrutoKg: null,
  pesoLiquidoKg: null,
  alturaCm: null,
  larguraCm: null,
  profundidadeCm: null,
  paiId: null,
  ...over,
});

beforeEach(() => {
  // Mantine's Combobox portals its dropdown into `document.body`, which RTL's
  // `cleanup()` does not clear. A leftover dropdown keeps its combobox store
  // alive and every later dropdown then refuses to open, so each test would
  // silently assert against a Select it never actually changed.
  document.body.innerHTML = '';
  loadMock.mockReset();
  notifyMock.mockReset();
  loadMock.mockResolvedValue({ p1: medidas({ pesoBrutoKg: 2.5 }) });
});

describe('FreteTab default Volume seed', () => {
  it('seeds one Volume weighed from the items when frete is activated', async () => {
    const view = renderTab();
    await pickModalidade(view, MODALIDADE_FOB);

    await waitFor(() => expect(volumes()).toHaveLength(1));
    // 2.5kg × 3 units, and pesoLiquido = 90% of that.
    const vol = volumes()![0]!;
    expect(vol.pesoBruto).toBe(7.5);
    expect(vol.pesoLiquido).toBe(6.75);
    // No produto dimensions in this fixture, so the estimator falls back.
    expect(vol.dimensoes).toEqual(DIMENSOES_PADRAO);
  });

  it('still seeds when the tab unmounts before the weight batch resolves', async () => {
    let release!: (v: Record<string, never>) => void;
    loadMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as (v: Record<string, never>) => void;
      }),
    );
    const view = renderTab();
    await pickModalidade(view, MODALIDADE_FOB);

    // Leave the Frete tab while the fetch is still in flight — this really
    // unmounts the panel (`keepMounted={false}`).
    fireEvent.click(screen.getByRole('tab', { name: 'Outra' }));
    expect(screen.queryByLabelText('Modalidade de frete')).toBeNull();

    await act(async () => {
      release({});
      await Promise.resolve();
    });

    await waitFor(() => expect(volumes()).toHaveLength(1));
  });

  it('does not seed when frete is switched OFF to sem transporte', async () => {
    // Starts ACTIVE — picking '9' on a pedido whose modalidade is already '9'
    // fires no change at all, so the deactivation direction is the only way
    // this path is reachable.
    const view = renderTab(freteAtivo());
    await pickModalidade(view, SEM_TRANSPORTE);

    await act(async () => {
      await Promise.resolve();
    });
    expect(volumes() ?? []).toHaveLength(0);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('does not seed a fabricated weight when the produto read fails', async () => {
    loadMock.mockRejectedValue(new FirebaseError('permission-denied', 'denied'));
    const view = renderTab();
    await pickModalidade(view, MODALIDADE_FOB);

    // Wait for the failure to be HANDLED, so "no volume" is an outcome rather
    // than a race with a seed that simply hadn't finished yet.
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    expect(volumes() ?? []).toHaveLength(0);
  });
});
