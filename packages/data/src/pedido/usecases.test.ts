import { describe, expect, it } from 'vitest';
import type { Pedido } from '@delfrance/schemas';
import type { PedidoDataPort, PedidoDocData } from './port';
import {
  PedidoConflictError,
  PedidoNothingChangedError,
  buildPedidoPatch,
  remotelyChangedFields,
  savePedido,
} from './usecases';

const VALUES = {
  numero: 'PED-1',
  estado: 'iniciado',
  descontoTotal: 5,
  itens: { p1: [{ quantidade: 1 }] },
  itensIds: ['p1'],
  freteInicial: { valorCobrado: 7 },
  valorCobrado: 100,
  valorCusto: 40,
  valorFreteInicial: 7,
  custoFreteInicial: 5,
  valorDevolucao: 0,
  valorCustoDevolvidos: 0,
  itensDevolvidos: { o1: { p1: [{ quantidade: 1 }] } },
  error: 'boom',
} as unknown as Pedido;

const ALL_CACHES = [
  'valorCobrado',
  'valorCusto',
  'valorFreteInicial',
  'custoFreteInicial',
  'valorDevolucao',
  'valorCustoDevolvidos',
];

describe('buildPedidoPatch', () => {
  it('returns only the touched plain field', () => {
    const patch = buildPedidoPatch(VALUES, { numero: true });
    expect(patch).toEqual({ numero: 'PED-1' });
  });

  it('is empty when nothing is dirty', () => {
    expect(buildPedidoPatch(VALUES, {})).toEqual({});
  });

  it('never writes synthetic / transient keys', () => {
    const patch = buildPedidoPatch(VALUES, {
      _itensFlat: [{ precoDeVenda: true }],
      error: true,
      id: true,
      ehSaidaOriginal: true,
    });
    // _itensFlat dirty → items branch; error/id/ehSaidaOriginal dropped
    expect(patch).not.toHaveProperty('error');
    expect(patch).not.toHaveProperty('_itensFlat');
    expect(patch).not.toHaveProperty('id');
    expect(patch).not.toHaveProperty('ehSaidaOriginal');
  });

  it('pulls itens + itensIds + every cache when items change', () => {
    const patch = buildPedidoPatch(VALUES, { _itensFlat: [{ quantidade: true }] });
    expect(patch.itens).toBe(VALUES.itens);
    expect(patch.itensIds).toEqual(['p1']);
    for (const c of ALL_CACHES) expect(patch).toHaveProperty(c);
  });

  it('pulls the caches (but not itens) when only frete or desconto change', () => {
    const frete = buildPedidoPatch(VALUES, { freteInicial: true });
    expect(frete).toHaveProperty('freteInicial');
    expect(frete).not.toHaveProperty('itens');
    for (const c of ALL_CACHES) expect(frete).toHaveProperty(c);

    const desconto = buildPedidoPatch(VALUES, { descontoTotal: true });
    expect(desconto.descontoTotal).toBe(5);
    for (const c of ALL_CACHES) expect(desconto).toHaveProperty(c);
  });

  it('pulls itensDevolvidos + caches when returns change', () => {
    const patch = buildPedidoPatch(VALUES, { itensDevolvidos: true });
    expect(patch.itensDevolvidos).toBe(VALUES.itensDevolvidos);
    for (const c of ALL_CACHES) expect(patch).toHaveProperty(c);
  });
});

function fakePort(
  current: PedidoDocData,
  nowVal = 777,
): {
  port: PedidoDataPort;
  written: () => Record<string, unknown> | undefined;
} {
  let out: Record<string, unknown> | undefined;
  return {
    port: {
      now: () => nowVal,
      async updatePedido(_id, apply) {
        out = apply(current);
      },
    },
    written: () => out,
  };
}

describe('remotelyChangedFields', () => {
  it('is empty when the snapshot is unchanged', () => {
    expect(
      remotelyChangedFields({ numero: 'A', itens: { p1: 1 } }, { numero: 'A', itens: { p1: 1 } }),
    ).toEqual([]);
  });

  it('detects a backend edit that did NOT bump ultimaModificacao (the bug)', () => {
    // Raw Firebase-console edit: itens changed, ultimaModificacao identical.
    const baseline = { itens: { p1: [{ quantidade: 1 }] }, ultimaModificacao: 99 };
    const current = { itens: { p1: [{ quantidade: 5 }] }, ultimaModificacao: 99 };
    expect(remotelyChangedFields(baseline, current)).toEqual(['itens']);
  });

  it('ignores ultimaModificacao / timestamp stamp-only differences', () => {
    expect(
      remotelyChangedFields(
        { numero: 'A', ultimaModificacao: 1, timestamp: 1 },
        { numero: 'A', ultimaModificacao: 2, timestamp: 2 },
      ),
    ).toEqual([]);
  });

  it('reports a key present on only one side', () => {
    expect(remotelyChangedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
  });
});

describe('savePedido', () => {
  const baseline = { numero: 'A', itens: { p1: [{ quantidade: 1 }] }, ultimaModificacao: 10 };

  it('throws PedidoNothingChangedError on an empty patch', async () => {
    const { port } = fakePort(baseline);
    await expect(savePedido(port, { pedidoId: 'x', patch: {}, baseline })).rejects.toBeInstanceOf(
      PedidoNothingChangedError,
    );
  });

  it('writes the patch + a fresh ultimaModificacao when the snapshot is unchanged', async () => {
    const { port, written } = fakePort({ ...baseline }, 999);
    await savePedido(port, { pedidoId: 'x', patch: { numero: 'B' }, baseline });
    expect(written()).toEqual({ numero: 'B', ultimaModificacao: 999 });
  });

  it('conflicts on a backend edit even though ultimaModificacao is unchanged', async () => {
    // The reported bug: items changed directly in Firebase, no timestamp bump.
    const current = { ...baseline, itens: { p1: [{ quantidade: 5 }] } };
    const { port } = fakePort(current);
    await expect(
      savePedido(port, { pedidoId: 'x', patch: { numero: 'B' }, baseline }),
    ).rejects.toMatchObject({ name: 'PedidoConflictError', current });
  });

  it('throws PedidoConflictError with a "deleted" message when the doc vanished', async () => {
    const { port } = fakePort(null);
    const err = await savePedido(port, { pedidoId: 'x', patch: { numero: 'B' }, baseline }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PedidoConflictError);
    expect((err as PedidoConflictError).current).toBeNull();
    expect((err as Error).message).toMatch(/excluíd/i);
  });

  it('overrides a conflict by re-basing on the reviewed snapshot (F3 "salvar mesmo assim")', async () => {
    // The user reviewed the version with quantidade=5; re-save with that as the
    // baseline → succeeds (a FURTHER edit would conflict again, never a clobber).
    const reviewed = { ...baseline, itens: { p1: [{ quantidade: 5 }] } };
    const { port, written } = fakePort(reviewed, 5);
    await savePedido(port, { pedidoId: 'x', patch: { numero: 'B' }, baseline: reviewed });
    expect(written()).toEqual({ numero: 'B', ultimaModificacao: 5 });
  });
});
