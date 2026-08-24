import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { notifications } from '@mantine/notifications';
import type { Pedido } from '@delfrance/schemas';
import { MODALIDADE_FRETE, seedFreteInicial } from '@delfrance/schemas';
import type { FreteInicialFormState, PedidoFormState, VolumeFormState } from '../../types';
import type { PedidoFormHandle } from './fields';

import { VolumesEditor } from './VolumesEditor';
import { loadProdutoPesoMap } from './produtoPeso';
import { volumePadrao, type ProdutoMedidas } from './pesoPedido';

vi.mock('./produtoPeso', () => ({ loadProdutoPesoMap: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
const loadMock = vi.mocked(loadProdutoPesoMap);
const notifyMock = vi.mocked(notifications.show);

const db = {} as Firestore;
let formRef: UseFormReturn<PedidoFormState, unknown, Pedido>;

function Host({ volumes, maxVolumes }: { volumes: VolumeFormState[] | null; maxVolumes?: number }) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      freteInicial: {
        ...(seedFreteInicial(MODALIDADE_FRETE.fob, true) as unknown as FreteInicialFormState),
        volumes,
      },
      _itensFlat: [{ produtoUid: 'p1', quantidade: 2 }],
    } as unknown as PedidoFormState,
  });
  useEffect(() => {
    formRef = form;
  }, [form]);
  return (
    <MantineTestProvider>
      <QueryClientProvider client={new QueryClient()}>
        <VolumesEditor form={form as PedidoFormHandle} db={db} maxVolumes={maxVolumes} />
      </QueryClientProvider>
    </MantineTestProvider>
  );
}

const stored = () =>
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
  loadMock.mockReset();
  notifyMock.mockReset();
  loadMock.mockResolvedValue({ p1: medidas({ pesoBrutoKg: 3 }) });
});

describe('VolumesEditor "+ Novo volume"', () => {
  it('adds a volume weighed from the pedido items, not a blind 1kg', async () => {
    render(<Host volumes={null} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Novo volume' }));

    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()![0]!.pesoBruto).toBe(6); // 3kg × 2 units
  });

  it('spends no read on mount — only on click', async () => {
    render(<Host volumes={null} />);
    expect(loadMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '+ Novo volume' }));
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));
  });

  it('still adds the volume at the 1kg default when the read fails, and warns', async () => {
    loadMock.mockRejectedValue(new FirebaseError('unavailable', 'backend unavailable'));
    render(<Host volumes={null} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Novo volume' }));

    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()![0]!.pesoBruto).toBe(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('respects maxVolumes when the list grew while the weight was loading', async () => {
    let release!: (v: Record<string, never>) => void;
    loadMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as (v: Record<string, never>) => void;
      }),
    );
    render(<Host volumes={null} maxVolumes={1} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Novo volume' }));

    // The activation seed lands while the click's own fetch is still in flight.
    formRef.setValue('freteInicial.volumes' as never, [volumePadrao(9)] as never);
    release({});

    await waitFor(() => expect(loadMock).toHaveBeenCalled());
    // FOB allows exactly one volume — the click must not push a second.
    await waitFor(() => expect(stored()).toEqual([volumePadrao(9)]));
  });

  it('warns about a clamped box just like the activation seed does', () => {
    // Both paths build the same box, so both must explain it — adding a volume
    // by hand was the one path that stayed quiet. Review finding on #1153.
    const oversized = medidas({ pesoBrutoKg: 1, alturaCm: 80, larguraCm: 80, profundidadeCm: 2 });
    loadMock.mockResolvedValue({ p1: oversized });
    render(<Host volumes={null} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Novo volume' }));

    return waitFor(() => {
      expect(stored()).toHaveLength(1);
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });
  });
});
