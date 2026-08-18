import { describe, expect, it } from 'vitest';
import { ESTADO_PEDIDO, pedidoMeta } from '@delfrance/schemas';
import type { Pedido } from '@delfrance/schemas';
import type { PedidoDataPort, PedidoDocData, PedidoWriteOp } from './port';
import {
  PedidoConflictError,
  PedidoNothingChangedError,
  buildIncidenteOp,
  buildPagamentoOp,
  buildPedidoPatch,
  cancelarPedido,
  deleteIncidente,
  deletePagamento,
  isIgnoredForConcurrency,
  nextPedidoEstado,
  remotelyChangedFields,
  savePedido,
  saveChequeSplit,
  saveIncidente,
  savePagamento,
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

/** The caches `buildPedidoPatch` still persists — `valorCobrado` alone (#796). */
const ALL_CACHES = ['valorCobrado'];

/** Removed from `pedidoSchema`, still written by the live Flutter app. */
const CACHES_REMOVIDOS = [
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
  committed: () => PedidoWriteOp[];
} {
  let out: Record<string, unknown> | undefined;
  const committed: PedidoWriteOp[] = [];
  return {
    port: {
      now: () => nowVal,
      newId: () => 'newid',
      async updatePedido(_id, apply) {
        out = apply(current);
      },
      async commit(ops) {
        committed.push(...ops);
      },
    },
    written: () => out,
    committed: () => committed,
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

  it('ignores the estoque sync trigger write-back (#972)', () => {
    // The sync writes these back seconds after the save that triggered it, and
    // does NOT stamp ultimaModificacao — so this compare was the only thing that
    // saw it, and it hard-failed the operator's next save with a modal naming
    // fields they can neither see nor edit.
    const baseline = {
      numero: 'A',
      estoqueAplicado: null,
      dataIndisponivelEstoque: null,
      dataRemocaoEstoque: null,
    };
    const current = {
      numero: 'A',
      estoqueAplicado: { depositoId: 'd1', ehSaida: true, reservado: { p1: 2 }, removido: null },
      dataIndisponivelEstoque: 1_700_000_000_000_000,
      dataRemocaoEstoque: null,
    };
    expect(remotelyChangedFields(baseline, current)).toEqual([]);
  });

  it('still reports a real change alongside the trigger write-back', () => {
    // The load-bearing one: the exclusion is PER FIELD, not a bail-out. A
    // concurrent edit to something the operator owns must survive it.
    const baseline = { itens: { p1: [{ quantidade: 1 }] }, estoqueAplicado: null };
    const current = {
      itens: { p1: [{ quantidade: 5 }] },
      estoqueAplicado: { reservado: { p1: 5 } },
    };
    expect(remotelyChangedFields(baseline, current)).toEqual(['itens']);
  });

  it('ignores every field the client is forbidden from writing', () => {
    // Drift guard: a field declared serverOwned is, a fortiori, one the operator
    // cannot have authored — so it must never raise a conflict. Auto-extends the
    // day another pedido field becomes server-owned.
    for (const field of pedidoMeta.serverOwnedFields ?? []) {
      expect(isIgnoredForConcurrency(field)).toBe(true);
    }
  });

  it('ignores the removed money caches so Flutter cannot raise a phantom conflict', () => {
    // #796. These five are gone from `pedidoSchema`, but `pedidoSchema` is
    // `.passthrough()` and the still-live Flutter `Pedido.factory` recomputes
    // them on every integral save — so they keep appearing in the raw diff with
    // NOBODY on this side writing them. Without the ignore the operator gets a
    // conflict modal naming a field that is not on their screen.
    for (const field of CACHES_REMOVIDOS) {
      expect(isIgnoredForConcurrency(field)).toBe(true);
    }
    const baseline = { numero: 'A', valorFreteInicial: 7, custoFreteInicial: 5 };
    const current = { numero: 'A', valorFreteInicial: 12.5, custoFreteInicial: 9 };
    expect(remotelyChangedFields(baseline, current)).toEqual([]);
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

  it('commits when only the estoque sync write-back landed since load (#972)', async () => {
    // The regression test for the reported flake AND the production symptom: the
    // operator flipped the estado, the sync applied the stock and wrote its
    // snapshot back, and now the operator flips the estado again. Nothing THEY
    // authored changed, so the save must go through — before this, it raised a
    // conflict modal and the editor never navigated away.
    const carregado = {
      ...baseline,
      estado: 'pago',
      estoqueAplicado: null,
      dataRemocaoEstoque: null,
    };
    const comWriteBack = {
      ...carregado,
      estoqueAplicado: { reservado: null, removido: { p1: 1 } },
      dataRemocaoEstoque: 1_700_000_000_000_000,
    };
    const { port, written } = fakePort(comWriteBack, 777);
    await savePedido(port, {
      pedidoId: 'x',
      patch: { estado: 'cancelado' },
      baseline: carregado,
    });
    expect(written()).toEqual({ estado: 'cancelado', ultimaModificacao: 777 });
  });

  it('still conflicts when the estado itself moved remotely', async () => {
    // The other half: the exclusion must not blunt the guard on a field the
    // operator owns, even when the write-back rode along with it.
    const carregado = { ...baseline, estado: 'pago', estoqueAplicado: null };
    const current = {
      ...carregado,
      estado: 'finalizado',
      estoqueAplicado: { removido: { p1: 1 } },
    };
    const { port } = fakePort(current);
    await expect(
      savePedido(port, { pedidoId: 'x', patch: { estado: 'cancelado' }, baseline: carregado }),
    ).rejects.toMatchObject({ name: 'PedidoConflictError', current });
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

describe('estado history', () => {
  it('is never written from here — the onPedidoEstadoChanged trigger owns it', async () => {
    const { port, written, committed } = fakePort({ estado: 'iniciado' }, 4242);
    await savePedido(port, {
      pedidoId: 'ped1',
      patch: { estado: 'pago' },
      baseline: { estado: 'iniciado' },
    });
    // The estado lands on the pedido doc; no historicoEstadoPedido op rides along.
    expect(written()).toEqual({ estado: 'pago', ultimaModificacao: 4242 });
    expect(committed()).toEqual([]);
  });
});

describe('incidentes', () => {
  const inc = { tipo: 'returns', origem: null, motivoDoIncidente: 'x', comentarios: null };

  it('buildIncidenteOp creates with a fresh id + timestamp + ultimaModificacao', () => {
    const { port } = fakePort(null, 555);
    const op = buildIncidenteOp(port, 'ped1', null, inc);
    expect(op).toEqual({
      type: 'set',
      path: 'pedidos/ped1/incidentes/newid',
      data: { ...inc, ultimaModificacao: 555, timestamp: 555 },
    });
  });

  it('buildIncidenteOp updates at the given id WITHOUT touching timestamp', () => {
    const { port } = fakePort(null, 555);
    const op = buildIncidenteOp(port, 'ped1', 'inc1', { ...inc, timestamp: 1 });
    expect(op.path).toBe('pedidos/ped1/incidentes/inc1');
    expect((op as { data: Record<string, unknown> }).data).toMatchObject({
      timestamp: 1,
      ultimaModificacao: 555,
    });
  });

  it('saveIncidente commits one set op', async () => {
    const { port, committed } = fakePort(null);
    await saveIncidente(port, { pedidoId: 'ped1', incidente: inc });
    expect(committed()).toHaveLength(1);
    expect(committed()[0]?.type).toBe('set');
  });

  it('deleteIncidente commits one delete op at the doc path', async () => {
    const { port, committed } = fakePort(null);
    await deleteIncidente(port, { pedidoId: 'ped1', incidenteId: 'inc1' });
    expect(committed()).toEqual([{ type: 'delete', path: 'pedidos/ped1/incidentes/inc1' }]);
  });
});

describe('pagamentos', () => {
  const pgto = { forma_de_pagamento: 1, status_pagamento: 0, valor: 100, parcelas: 1 };

  it('buildPagamentoOp creates with a fresh id + dataCadastro + ultimaModificacao', () => {
    const { port } = fakePort(null, 555);
    const op = buildPagamentoOp(port, 'ped1', null, pgto);
    expect(op).toEqual({
      type: 'set',
      path: 'pedidos/ped1/pagamentos/newid',
      data: { ...pgto, ultimaModificacao: 555, dataCadastro: 555 },
    });
  });

  it('buildPagamentoOp updates at the given id WITHOUT touching dataCadastro', () => {
    const { port } = fakePort(null, 555);
    const op = buildPagamentoOp(port, 'ped1', 'pg1', { ...pgto, dataCadastro: 1 });
    expect(op.path).toBe('pedidos/ped1/pagamentos/pg1');
    expect((op as { data: Record<string, unknown> }).data).toMatchObject({
      dataCadastro: 1,
      ultimaModificacao: 555,
    });
  });

  it('savePagamento commits one set op', async () => {
    const { port, committed } = fakePort(null);
    await savePagamento(port, { pedidoId: 'ped1', pagamento: pgto });
    expect(committed()).toHaveLength(1);
    expect(committed()[0]?.type).toBe('set');
  });

  it('deletePagamento commits one delete op at the doc path', async () => {
    const { port, committed } = fakePort(null);
    await deletePagamento(port, { pedidoId: 'ped1', pagamentoId: 'pg1' });
    expect(committed()).toEqual([{ type: 'delete', path: 'pedidos/ped1/pagamentos/pg1' }]);
  });

  it('saveChequeSplit commits one set op per pagamento, each with a fresh id', async () => {
    let n = 0;
    const committed: PedidoWriteOp[] = [];
    const port: PedidoDataPort = {
      now: () => 555,
      newId: () => `id${++n}`,
      async updatePedido() {},
      async commit(ops) {
        committed.push(...ops);
      },
    };
    const rows = [
      { ...pgto, valor: 33.33 },
      { ...pgto, valor: 33.33 },
      { ...pgto, valor: 33.34 },
    ];
    await saveChequeSplit(port, { pedidoId: 'ped1', pagamentos: rows });
    expect(committed).toHaveLength(3);
    expect(committed.map((op) => op.path)).toEqual([
      'pedidos/ped1/pagamentos/id1',
      'pedidos/ped1/pagamentos/id2',
      'pedidos/ped1/pagamentos/id3',
    ]);
    for (const op of committed) {
      expect(op.type).toBe('set');
      expect((op as { data: Record<string, unknown> }).data).toMatchObject({
        ultimaModificacao: 555,
        dataCadastro: 555,
      });
    }
  });
});

describe('nextPedidoEstado (rule table)', () => {
  it('fully paid → pago + authorize despacho', () => {
    expect(nextPedidoEstado(ESTADO_PEDIDO.iniciado, 100, 100)).toEqual({
      estado: 'pago',
      autorizarDespacho: true,
    });
    expect(nextPedidoEstado(ESTADO_PEDIDO.iniciado, 100, 120)).toEqual({
      estado: 'pago',
      autorizarDespacho: true,
    });
  });

  it('is idempotent once pago', () => {
    expect(nextPedidoEstado(ESTADO_PEDIDO.pago, 100, 100)).toBeNull();
  });

  it('partially paid → aguardando (no despacho)', () => {
    expect(nextPedidoEstado(ESTADO_PEDIDO.iniciado, 100, 50)).toEqual({
      estado: 'aguardandoConfirmacaoDePagamento',
      autorizarDespacho: false,
    });
  });

  it('is idempotent once aguardando while still partial', () => {
    expect(nextPedidoEstado(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento, 100, 50)).toBeNull();
  });

  it('downgrades a pago pedido that drops below its total', () => {
    expect(nextPedidoEstado(ESTADO_PEDIDO.pago, 100, 50)).toEqual({
      estado: 'aguardandoConfirmacaoDePagamento',
      autorizarDespacho: false,
    });
    expect(nextPedidoEstado(ESTADO_PEDIDO.pago, 100, 0)).toEqual({
      estado: 'aguardandoConfirmacaoDePagamento',
      autorizarDespacho: false,
    });
  });

  it('leaves estado alone when nothing is paid and it is not pago', () => {
    expect(nextPedidoEstado(ESTADO_PEDIDO.iniciado, 100, 0)).toBeNull();
  });

  it('never forces a transition on a zero-total pedido (even with a payment)', () => {
    expect(nextPedidoEstado(ESTADO_PEDIDO.iniciado, 0, 0)).toBeNull();
    expect(nextPedidoEstado(ESTADO_PEDIDO.iniciado, 0, 50)).toBeNull();
  });

  it('never auto-reverts a terminal / fulfilled / refunded estado', () => {
    // Fully paid but cancelled/finalized → must NOT bounce back to pago.
    expect(nextPedidoEstado(ESTADO_PEDIDO.cancelado, 100, 100)).toBeNull();
    expect(nextPedidoEstado(ESTADO_PEDIDO.finalizado, 100, 100)).toBeNull();
    expect(nextPedidoEstado(ESTADO_PEDIDO.fraude, 100, 100)).toBeNull();
    expect(nextPedidoEstado(ESTADO_PEDIDO.processandoCancelamento, 100, 100)).toBeNull();
    // Partially paid (refund) on a refund state → must NOT erase it.
    expect(nextPedidoEstado(ESTADO_PEDIDO.estornadoParcialmente, 100, 50)).toBeNull();
    expect(nextPedidoEstado(ESTADO_PEDIDO.estornadoIntegralmente, 100, 0)).toBeNull();
  });
});

describe('cancelarPedido', () => {
  it('sets estado cancelado on the pedido doc', async () => {
    const { port, written } = fakePort({ estado: 'pago', valorCobrado: 100 }, 777);
    const result = await cancelarPedido(port, { pedidoId: 'x' });
    expect(result).toBe(true);
    expect(written()).toEqual({ estado: 'cancelado', ultimaModificacao: 777 });
  });

  it('writes no história row — the onPedidoEstadoChanged trigger owns it', async () => {
    const { port, committed } = fakePort({ estado: 'pago', valorCobrado: 100 }, 777);
    await cancelarPedido(port, { pedidoId: 'x' });
    // The subcollection is `meta.serverOwned`: a client append is denied by the
    // rules, and the trigger derives the actor from this write's auth context.
    expect(committed()).toEqual([]);
  });

  it('is idempotent — a no-op (empty patch) when already cancelado', async () => {
    const { port, written, committed } = fakePort({ estado: 'cancelado', valorCobrado: 100 }, 777);
    const result = await cancelarPedido(port, { pedidoId: 'x' });
    expect(result).toBe(false);
    expect(written()).toEqual({});
    expect(committed()).toEqual([]);
  });

  it('skips everything when the doc is gone', async () => {
    const { port, committed } = fakePort(null, 777);
    const result = await cancelarPedido(port, { pedidoId: 'x' });
    expect(result).toBe(false);
    expect(committed()).toEqual([]);
  });
});
