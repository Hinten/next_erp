import { describe, expect, it } from 'vitest';
import type { EngineProduto, ItemDoPedido, Pedido } from '@delfrance/schemas';
import type { CheckoutData } from '@/lib/checkout/loadPedidoCheckout';
import {
  checkoutReducer,
  initialCheckoutState,
  type CheckoutState,
  type ScanMeta,
} from './checkoutReducer';

function item(produtoUid: string, quantidade: number, ordem: number): ItemDoPedido {
  return {
    produtoUid,
    quantidade,
    ordem,
    nomeDeVenda: `Item ${produtoUid}`,
    sku: `SKU-${produtoUid}`,
  } as unknown as ItemDoPedido;
}

function produto(id: string): EngineProduto {
  return {
    id,
    nome: `Produto ${id}`,
    sku: `SKU-${id}`,
    ehKit: false,
    componentesKit: null,
    fotos: null,
  };
}

function makeData(): CheckoutData {
  const itens = [item('p1', 1, 0), item('p2', 2, 1)];
  const produtos = new Map<string, EngineProduto>([
    ['p1', produto('p1')],
    ['p2', produto('p2')],
  ]);
  return {
    pedido: {
      numero: '123',
      estado: 'pago',
      freteInicial: null,
      observacoesInternas: null,
    } as unknown as Pedido,
    pedidoId: 'ped1',
    itens,
    produtos,
    existingCheckout: null,
    incidentes: [],
  };
}

/** Reduce an ordered list of actions from the initial state. */
function reduceAll(actions: Parameters<typeof checkoutReducer>[1][]): CheckoutState {
  return actions.reduce((s, a) => checkoutReducer(s, a), initialCheckoutState);
}

const meta = (uid: string): ScanMeta => ({ uid, timestampMs: 1000 });

describe('checkoutReducer', () => {
  it('load/start sets loading + epoch and preserves format choices', () => {
    const withFormat = checkoutReducer(initialCheckoutState, {
      type: 'format/danfe',
      value: 'retrato',
    });
    const next = checkoutReducer(withFormat, { type: 'load/start', epoch: 1, pedidoId: 'ped1' });
    expect(next.status).toBe('loading');
    expect(next.epoch).toBe(1);
    expect(next.pedidoId).toBe('ped1');
    expect(next.formatoDanfe).toBe('retrato');
  });

  it('load/success builds the engine when the epoch matches', () => {
    const state = reduceAll([
      { type: 'load/start', epoch: 1, pedidoId: 'ped1' },
      { type: 'load/success', epoch: 1, data: makeData() },
    ]);
    expect(state.status).toBe('loaded');
    expect(state.engine?.expected).toHaveLength(2);
    expect(state.engine?.remainingCount).toBe(2);
    expect(state.scanIndex.byId.size).toBe(2);
  });

  it('drops a stale load/success from a superseded epoch', () => {
    const started = checkoutReducer(initialCheckoutState, {
      type: 'load/start',
      epoch: 2,
      pedidoId: 'ped1',
    });
    // A late success tagged with the OLD epoch 1 must be ignored.
    const next = checkoutReducer(started, { type: 'load/success', epoch: 1, data: makeData() });
    expect(next.status).toBe('loading');
    expect(next.engine).toBeNull();
  });

  it('applies a scan through the engine and structurally shares untouched rows', () => {
    const loaded = reduceAll([
      { type: 'load/start', epoch: 1, pedidoId: 'ped1' },
      { type: 'load/success', epoch: 1, data: makeData() },
    ]);
    const before = loaded.engine!;
    // Scan p1 (pos 0) → completes it.
    const after = checkoutReducer(loaded, {
      type: 'scan/apply',
      epoch: 1,
      produto: produto('p1'),
      meta: meta('s1'),
    });
    expect(after.engine!.log).toHaveLength(1);
    expect(after.engine!.expected[0]!.concluido).toBe(true);
    // Untouched row keeps its reference identity (React.memo relies on this).
    expect(after.engine!.expected[1]).toBe(before.expected[1]);
  });

  it('drops a stale scan/apply from an old epoch', () => {
    const loaded = reduceAll([
      { type: 'load/start', epoch: 1, pedidoId: 'ped1' },
      { type: 'load/success', epoch: 1, data: makeData() },
    ]);
    const after = checkoutReducer(loaded, {
      type: 'scan/apply',
      epoch: 0,
      produto: produto('p1'),
      meta: meta('s1'),
    });
    expect(after.engine!.log).toHaveLength(0);
  });

  it('scan/not-found appends a soft error row that can be soft-deleted', () => {
    const loaded = reduceAll([
      { type: 'load/start', epoch: 1, pedidoId: 'ped1' },
      { type: 'load/success', epoch: 1, data: makeData() },
    ]);
    const withErr = checkoutReducer(loaded, {
      type: 'scan/not-found',
      epoch: 1,
      code: 'ZZZ',
      meta: meta('e1'),
    });
    expect(withErr.engine!.log).toHaveLength(1);
    expect(withErr.engine!.log[0]!.error).toBe('Produto não encontrado');
    expect(withErr.engine!.log[0]!.kind).toBe('error');

    const deleted = checkoutReducer(withErr, { type: 'scan/delete', entryUid: 'e1', nowMs: 2000 });
    expect(deleted.engine!.log[0]!.excluidoMs).toBe(2000);
  });

  it('clear wipes scans, keeps the pedido, and bumps the epoch', () => {
    const scanned = reduceAll([
      { type: 'load/start', epoch: 1, pedidoId: 'ped1' },
      { type: 'load/success', epoch: 1, data: makeData() },
      { type: 'scan/apply', epoch: 1, produto: produto('p1'), meta: meta('s1') },
    ]);
    const cleared = checkoutReducer(scanned, { type: 'clear', epoch: 2 });
    expect(cleared.epoch).toBe(2);
    expect(cleared.status).toBe('loaded');
    expect(cleared.engine!.log).toHaveLength(0);
    expect(cleared.engine!.remainingCount).toBe(2);
  });

  it('reset returns to empty but preserves format choices', () => {
    const scanned = reduceAll([
      { type: 'format/etiqueta', value: 'zpl2' },
      { type: 'load/start', epoch: 1, pedidoId: 'ped1' },
      { type: 'load/success', epoch: 1, data: makeData() },
    ]);
    const reset = checkoutReducer(scanned, { type: 'reset', epoch: 2 });
    expect(reset.status).toBe('empty');
    expect(reset.pedido).toBeNull();
    expect(reset.epoch).toBe(2);
    expect(reset.formatoEtiqueta).toBe('zpl2');
  });
});
