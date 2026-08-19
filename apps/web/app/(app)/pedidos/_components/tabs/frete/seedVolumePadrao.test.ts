import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { MODALIDADE_FRETE } from '@delfrance/schemas';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import type { VolumeFormState } from '../../types';
import type { PedidoFormHandle } from './fields';
import { volumePadrao, type ProdutoPesoInfo } from './pesoPedido';
import { isAtivacaoDeFrete, seedVolumePadrao } from './seedVolumePadrao';
import { loadProdutoPesoMap } from './produtoPeso';

vi.mock('./produtoPeso', () => ({ loadProdutoPesoMap: vi.fn() }));
const loadMock = vi.mocked(loadProdutoPesoMap);

/** Minimal form double — the seeder only reads/writes `freteInicial.volumes`. */
function fakeForm(initial: VolumeFormState[] | null) {
  let volumes = initial;
  const setValue = vi.fn((_path: string, value: unknown) => {
    volumes = value as VolumeFormState[];
  });
  return {
    handle: {
      getValues: (path: string) => {
        expect(path).toBe('freteInicial.volumes');
        return volumes;
      },
      setValue,
    } as unknown as PedidoFormHandle,
    setValue,
    current: () => volumes,
  };
}

const db = {} as Firestore;
const queryClient = {} as QueryClient;
const peso = (over: Partial<ProdutoPesoInfo> = {}): ProdutoPesoInfo => ({
  pesoBrutoKg: null,
  pesoLiquidoKg: null,
  paiId: null,
  ...over,
});

beforeEach(() => {
  loadMock.mockReset();
  loadMock.mockResolvedValue({});
});

describe('seedVolumePadrao', () => {
  it('seeds one Volume weighed from the pedido items', async () => {
    loadMock.mockResolvedValue({ p1: peso({ pesoBrutoKg: 2.5 }) });
    const form = fakeForm(null);

    const seeded = await seedVolumePadrao({
      form: form.handle,
      db,
      queryClient,
      itens: [{ produtoUid: 'p1', quantidade: 3 }],
      marketplaceOwned: false,
    });

    expect(seeded).toBe(true);
    expect(form.current()).toEqual([volumePadrao(7.5)]);
    expect(form.setValue).toHaveBeenCalledWith('freteInicial.volumes', [volumePadrao(7.5)], {
      shouldDirty: true,
      shouldValidate: true,
    });
  });

  it('excludes staged-for-deletion rows from the weight', async () => {
    loadMock.mockResolvedValue({ p1: peso({ pesoBrutoKg: 2 }) });
    const form = fakeForm(null);

    await seedVolumePadrao({
      form: form.handle,
      db,
      queryClient,
      itens: [
        { produtoUid: 'p1', quantidade: 1 },
        { produtoUid: 'p1', quantidade: 5, _delete: true },
      ],
      marketplaceOwned: false,
    });

    expect(form.current()).toEqual([volumePadrao(2)]);
  });

  it('does not seed into a marketplace-owned freteInicial, and reads nothing', async () => {
    const form = fakeForm(null);

    const seeded = await seedVolumePadrao({
      form: form.handle,
      db,
      queryClient,
      itens: [{ produtoUid: 'p1', quantidade: 1 }],
      marketplaceOwned: true,
    });

    expect(seeded).toBe(false);
    expect(form.setValue).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('leaves an existing volume alone, and reads nothing', async () => {
    const form = fakeForm([volumePadrao(4)]);

    const seeded = await seedVolumePadrao({
      form: form.handle,
      db,
      queryClient,
      itens: [{ produtoUid: 'p1', quantidade: 1 }],
      marketplaceOwned: false,
    });

    expect(seeded).toBe(false);
    expect(form.setValue).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('never clobbers a volume the operator added WHILE the weight batch ran', async () => {
    const form = fakeForm(null);
    const manual = volumePadrao(9);
    // The operator clicks "+ Novo volume" mid-flight: the list is empty when
    // the seed decides to run, and non-empty by the time it would write.
    loadMock.mockImplementation(async () => {
      form.handle.setValue('freteInicial.volumes' as never, [manual] as never);
      return {};
    });

    const seeded = await seedVolumePadrao({
      form: form.handle,
      db,
      queryClient,
      itens: [{ produtoUid: 'p1', quantidade: 1 }],
      marketplaceOwned: false,
    });

    expect(seeded).toBe(false);
    expect(form.current()).toEqual([manual]);
  });

  it('propagates a produto read failure instead of seeding a wrong weight', async () => {
    const form = fakeForm(null);
    loadMock.mockRejectedValue(new FirebaseError('unavailable', 'backend unavailable'));

    await expect(
      seedVolumePadrao({
        form: form.handle,
        db,
        queryClient,
        itens: [{ produtoUid: 'p1', quantidade: 1 }],
        marketplaceOwned: false,
      }),
    ).rejects.toBeInstanceOf(FirebaseError);
    expect(form.setValue).not.toHaveBeenCalled();
  });
});

describe('isAtivacaoDeFrete', () => {
  it('a pedido without frete picking a real modalidade IS an activation', () => {
    expect(isAtivacaoDeFrete(false, MODALIDADE_FRETE.fob)).toBe(true);
    expect(isAtivacaoDeFrete(false, MODALIDADE_FRETE.cif)).toBe(true);
  });

  it('picking sem transporte is never an activation', () => {
    expect(isAtivacaoDeFrete(false, MODALIDADE_FRETE.semTransporte)).toBe(false);
    expect(isAtivacaoDeFrete(true, MODALIDADE_FRETE.semTransporte)).toBe(false);
  });

  it('swapping modalidade on an already-active pedido is not an activation', () => {
    // The guard that keeps a modalidade change from re-seeding a Volume — and
    // from spending a produto read — on a pedido that already has frete.
    expect(isAtivacaoDeFrete(true, MODALIDADE_FRETE.cif)).toBe(false);
  });
});
